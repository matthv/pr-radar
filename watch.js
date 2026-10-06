'use strict';

const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);

const CONCURRENCY = 4;
const IN_FLIGHT_CI = new Set(['PENDING', 'EXPECTED']);
// GitHub's own floor for /notifications, until X-Poll-Interval says otherwise.
const DEFAULT_POLL_SECONDS = 60;
const MIN_DISCOVERY_GAP_MS = 90_000;
// A job stuck in a queue can read as running for hours: past this, a card goes back to the
// regular cadence, where the full search still reads its CI.
const MAX_FOLLOW_MS = 30 * 60_000;

// gh exits 1 on any status other than 2xx, a 304 included; with -i, the status line and the
// headers come first on stdout either way.
const runGh = args =>
  execFile('gh', args, { maxBuffer: 16 << 20, encoding: 'utf8' }).then(
    ({ stdout }) => stdout,
    error => {
      if (error.stdout) return error.stdout;
      throw new Error(`gh ${args.join(' ')}: ${String(error.stderr || error.message).trim()}`);
    },
  );

function parseResponse(raw) {
  const split = raw.search(/\r?\n\r?\n/);
  const head = split === -1 ? raw : raw.slice(0, split);
  const body = split === -1 ? '' : raw.slice(split).trim();
  const [statusLine, ...lines] = head.split(/\r?\n/);
  const status = Number(statusLine.match(/^HTTP\/\S+\s+(\d{3})/)?.[1]);
  if (!status) throw new Error(`unexpected gh output: ${statusLine.slice(0, 80)}`);
  const headers = {};
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { status, headers, body };
}

async function conditionalGet(path, validators, exec) {
  const args = ['api', '-i', path];
  if (validators.etag) args.push('-H', `If-None-Match: ${validators.etag}`);
  if (validators.lastModified) args.push('-H', `If-Modified-Since: ${validators.lastModified}`);
  const response = parseResponse(await exec(args));
  if (response.status !== 200 && response.status !== 304) {
    throw new Error(`${path}: HTTP ${response.status}`);
  }
  return response;
}

async function pool(items, worker) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length) await worker(queue.shift());
  }));
}

const keyOf = (repo, number) => `${repo.toLowerCase()}#${number}`;

function prFromApiUrl(url) {
  const match = String(url ?? '').match(/\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/);
  return match && { repo: match[1], number: Number(match[2]) };
}

function inScope(repo, { org, extraRepos = [] }) {
  const lower = repo.toLowerCase();
  return lower.startsWith(`${String(org).toLowerCase()}/`) || extraRepos.some(extra => extra.toLowerCase() === lower);
}

// What changed since the previous round, from answers GitHub gives for free when nothing
// did: a 304 does not count against the quota.
function createWatcher({ exec = runGh, scope }) {
  // A key mapped to null is known but must read as changed next time: its last reload failed.
  const etags = new Map();
  let notificationsModified = null;
  let notificationsAt = -Infinity;
  let pollSeconds = DEFAULT_POLL_SECONDS;

  async function checkCards(prs, changed, failures) {
    await pool(prs, async pr => {
      const key = keyOf(pr.repo, pr.number);
      const known = etags.has(key);
      try {
        const { status, headers } = await conditionalGet(`repos/${pr.repo}/pulls/${pr.number}`, { etag: etags.get(key) }, exec);
        if (status === 200) {
          if (known) changed.add(pr.id);
          etags.set(key, headers.etag ?? null);
        }
      } catch (error) {
        failures.push(error.message);
      }
    });
  }

  async function checkNotifications(board, changed, now) {
    if (now - notificationsAt < pollSeconds * 1000) return false;
    notificationsAt = now;
    const { status, headers, body } = await conditionalGet('notifications', { lastModified: notificationsModified }, exec);
    const interval = Number(headers['x-poll-interval']);
    if (interval > 0) pollSeconds = interval;
    if (status === 304) return false;
    const previous = notificationsModified && Date.parse(notificationsModified);
    notificationsModified = headers['last-modified'] ?? notificationsModified;
    // The first answer is a baseline: everything unread then is already on the board or not ours.
    if (!previous) return false;

    const onBoard = new Map([...board.mine, ...board.reviews].map(pr => [keyOf(pr.repo, pr.number), pr.id]));
    let unknownTouched = false;
    for (const thread of JSON.parse(body || '[]')) {
      if (thread.subject?.type !== 'PullRequest' || Date.parse(thread.updated_at) <= previous) continue;
      const pr = prFromApiUrl(thread.subject.url);
      if (!pr || !inScope(pr.repo, scope)) continue;
      const id = onBoard.get(keyOf(pr.repo, pr.number));
      if (id) changed.add(id);
      else unknownTouched = true;
    }
    return unknownTouched;
  }

  return {
    async check(board, now = Date.now()) {
      const changed = new Set();
      const failures = [];
      const prs = [...board.mine, ...board.reviews];
      let unknownTouched = false;
      await Promise.all([
        checkCards(prs, changed, failures),
        checkNotifications(board, changed, now).then(
          touched => {
            unknownTouched = touched;
          },
          error => {
            failures.push(error.message);
          },
        ),
      ]);
      const live = new Set(prs.map(pr => keyOf(pr.repo, pr.number)));
      for (const key of etags.keys()) if (!live.has(key)) etags.delete(key);
      if (prs.length && failures.length >= prs.length) throw new Error(`change check failed: ${failures[0]}`);
      return { changed, unknownTouched, failures };
    },
    forget(prs) {
      for (const pr of prs) etags.set(keyOf(pr.repo, pr.number), null);
    },
    get pollSeconds() {
      return pollSeconds;
    },
  };
}

// The cards whose state moves on its own, with no human event to tell: a running CI.
function inFlight(board) {
  return [...board.mine, ...board.reviews].filter(pr =>
    pr.merged ? pr.pipelineOutcome === 'running' : IN_FLIGHT_CI.has(pr.ciState),
  );
}

// The in-flight cards still worth following, each for MAX_FOLLOW_MS at most since it was
// first seen in flight. `since` is kept by the caller between rounds.
function toFollow(board, since, now) {
  const flying = inFlight(board);
  const live = new Set(flying.map(pr => pr.id));
  for (const id of since.keys()) if (!live.has(id)) since.delete(id);
  return flying.filter(pr => {
    if (!since.has(pr.id)) since.set(pr.id, now);
    return now - since.get(pr.id) < MAX_FOLLOW_MS;
  });
}

// A PR off the board was touched: discover sooner, but never twice within the gap, or a
// burst of notifications would run the searches — the scarce quota — in a loop.
function nextDiscoveryAt(lastDiscoveryAt, early, regularMs) {
  return lastDiscoveryAt + (early ? Math.min(MIN_DISCOVERY_GAP_MS, regularMs) : regularMs);
}

// A webhook is someone always looking: the checks never stop for want of a page.
function watched(lastSeenAt, now, leaseMs, webhook) {
  return webhook || now - lastSeenAt <= leaseMs;
}

module.exports = {
  createWatcher,
  watched,
  conditionalGet,
  runGh,
  inFlight,
  toFollow,
  nextDiscoveryAt,
  MAX_FOLLOW_MS,
  parseResponse,
  prFromApiUrl,
  MIN_DISCOVERY_GAP_MS,
};
