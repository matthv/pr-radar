'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');

// Variables already exported in the shell keep precedence over the file.
try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch {
  /* no .env: fall back to the defaults */
}

const { fetchBoard, loadNodes, shapeBoard, ownerScope, parseExtraRepos, fetchStatusFingerprints, statusFingerprint } = require('./github');
const watch = require('./watch');
const digest = require('./digest');
const slack = require('./slack');
const update = require('./update');
const demo = require('./demo');
const claudeSessions = require('./claude-sessions');
const webhook = require('./webhook');

// A fake board on its own port: no call to GitHub, Slack, Claude or git, so the real
// board on the default port and its browser state stay untouched.
const DEMO = process.env.PR_RADAR_DEMO === 'true';

const PORT = Number(process.env.PORT || 4321);
const ORG = DEMO ? demo.ORG : process.env.PR_RADAR_ORG;
const EXTRA_REPOS = DEMO ? [] : parseExtraRepos(process.env.PR_RADAR_EXTRA_REPOS);
const MAX_AGE_DAYS = Number(process.env.PR_RADAR_MAX_AGE_DAYS || 60);
const REFRESH_SECONDS = Number(process.env.PR_RADAR_REFRESH_SECONDS || 300);
// Between two full searches, the board is kept fresh by conditional requests, free when
// nothing changed; 0 goes back to a full refresh every REFRESH_SECONDS and nothing else.
const CHECK_SECONDS = DEMO ? 0 : Number(process.env.PR_RADAR_CHECK_SECONDS ?? 60);
const LIVE = CHECK_SECONDS > 0;
const IN_FLIGHT_MS = 30_000;
// A scheduled search reuses the PRs the checks already keep current, but none older than this:
// what no check sees (a conflict appearing as the base moves, a release tag) gets a full
// reload at least this often.
const REUSE_MS = 30 * 60_000;
const HIDDEN_CHECK_MS = 300_000;
// Past this long with no page asking, nobody is looking: the checks stop.
const LEASE_MS = 600_000;
const PAGE_REFRESH_SECONDS = 20;
const FIRST_SEARCH_RETRY_MS = 60_000;
const GITDECK_URL = process.env.PR_RADAR_GITDECK_URL ?? 'http://localhost:4567';
const LINEAR_URL = (process.env.PR_RADAR_LINEAR_URL ?? '').trim().replace(/\/+$/, '');
// A standing policy, not a per-session toggle: whether drafts belong on the board is
// decided once, so it lives with the other settings rather than in the toolbar.
const HIDE_DRAFTS = process.env.PR_RADAR_HIDE_DRAFTS === 'true';
const TERMINAL = (process.env.PR_RADAR_TERMINAL ?? '').trim() || 'Terminal';
const CLAUDE_SESSIONS_OFF = process.env.PR_RADAR_CLAUDE_SESSIONS !== 'true'
  ? 'off (PR_RADAR_CLAUDE_SESSIONS=false)'
  : process.platform !== 'darwin'
    ? 'off (macOS only)'
    : !(TERMINAL in claudeSessions.TERMINALS)
      ? `off (PR_RADAR_TERMINAL "${TERMINAL}" unknown: ${Object.keys(claudeSessions.TERMINALS).join(', ')})`
      : null;
const CLAUDE_SESSIONS = !CLAUDE_SESSIONS_OFF;
// The board waits this long for the transcripts on a refresh; a longer scan, the first one
// on a big ~/.claude, marks its cards once done.
const CLAUDE_SCAN_WAIT_MS = 2000;
let WEBHOOK_URL = '';
// Your own notification sound, a local file. Only this one path is ever served, at a fixed
// route: the page cannot ask for any other file through it.
const SOUND_FILE = (process.env.PR_RADAR_SOUND ?? '').trim().replace(/^~(?=\/|$)/, os.homedir());
const SOUND_TYPES = {
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
  '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.webm': 'audio/webm',
};
// Half the interval: otherwise a poll lands on a barely-valid cache and serves data
// almost twice as old as the advertised interval.
const CACHE_TTL_MS = Math.max(15, REFRESH_SECONDS / 2) * 1000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// Refresh fetches data, it does not reload the page: without this token a tab left
// open keeps running the old assets after the files change.
async function assetVersion() {
  const names = (await fs.readdir(PUBLIC_DIR)).filter(name => /\.(js|css|html)$/.test(name)).sort();
  const stamps = await Promise.all(
    names.map(async name => `${name}:${(await fs.stat(path.join(PUBLIC_DIR, name))).mtimeMs}`),
  );
  return createHash('sha1').update(stamps.join('|')).digest('hex').slice(0, 12);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

let cache = { at: 0, payload: null };
let inFlight = null;
// What the last full search found, so a few reloaded PRs can be reshaped into the board.
let store = null;
let lock = Promise.resolve();
const exclusive = task => {
  const run = lock.then(task, task);
  lock = run.catch(() => {});
  return run;
};
let digestAvailable = false;
let slackMode = 'off';
let slackWarning = null;
let slackReading = null;
let claudeWarning = null;
let webhookNotifier = null;

function withClaudeSessions(payload) {
  const withSession = pr => ({ ...pr, claudeSession: Boolean(claudeSessions.sessionFor(pr.url)) });
  const warnings = (payload.warnings ?? []).filter(w => w.source !== 'claude');
  return {
    ...payload,
    mine: payload.mine.map(withSession),
    reviews: payload.reviews.map(withSession),
    warnings: claudeWarning ? [...warnings, claudeWarning] : warnings,
  };
}

function scanClaudeSessions() {
  return claudeSessions.scan({ maxAgeDays: MAX_AGE_DAYS }).then(
    ({ unreadable, touched }) => {
      claudeWarning = unreadable ? { source: 'claude', kind: 'unreadable', message: `${unreadable} transcript(s) could not be read` } : null;
      return touched;
    },
    error => {
      claudeWarning = { source: 'claude', kind: 'failed', message: error.message };
      return [];
    },
  );
}

async function withSlackLinks(payload) {
  const links = await slack.linksFor([...payload.mine, ...payload.reviews]);
  const withSlack = pr => ({ ...pr, slackUrl: links.get(pr.id) ?? null });
  return { ...payload, mine: payload.mine.map(withSlack), reviews: payload.reviews.map(withSlack) };
}

// Slack is asked after GitHub, only about the PRs on the board, and its failure is a
// warning in the same banner as a half-answering GitHub source: the board never waits on
// it or breaks because of it. Through the API it is read inline — a couple of hundred
// milliseconds. Through Claude it takes seconds, so it runs behind the response and
// patches the cached board when done: the button shows up on the next refresh.
async function readSlack(prs) {
  try {
    const read = await slack.lookup(prs, { maxAgeDays: MAX_AGE_DAYS, via: slackMode });
    if (read && slackMode === 'claude') console.log(`[${new Date().toISOString()}] slack: channel read via claude`);
    slackWarning = null;
  } catch (error) {
    // The kind picks the banner's sentence: only the board knows how to say what to do.
    slackWarning = { source: 'slack', kind: error.code ?? 'failed', message: error.message };
  }
}

function readSlackInBackground(prs) {
  if (slackReading) return;
  slackReading = readSlack(prs)
    .then(async () => {
      if (!cache.payload) return;
      const warnings = cache.payload.warnings.filter(w => w.source !== 'slack');
      cache.payload = { ...(await withSlackLinks(cache.payload)), warnings: slackWarning ? [...warnings, slackWarning] : warnings };
    })
    .finally(() => {
      slackReading = null;
    });
}

// What every board served carries besides the GitHub data, whether it comes from a full
// search or from a few reloaded PRs.
async function layered(board, discoveredAt) {
  const withSessions = CLAUDE_SESSIONS ? withClaudeSessions(board) : board;
  const payload = slackMode === 'off' ? withSessions : await withSlackLinks(withSessions);
  return {
    ...payload,
    warnings: slackWarning ? [...payload.warnings, slackWarning] : payload.warnings,
    discoveredAt,
    refreshSeconds: REFRESH_SECONDS,
    pageRefreshSeconds: LIVE ? PAGE_REFRESH_SECONDS : REFRESH_SECONDS,
    gitdeckUrl: GITDECK_URL,
    linearUrl: LINEAR_URL,
    hideDrafts: HIDE_DRAFTS,
    customSound: Boolean(SOUND_FILE),
    digestAvailable,
  };
}

function reusableNodes() {
  if (!LIVE || !store) return new Map();
  const now = Date.now();
  return new Map([...store.nodes].filter(([id]) => now - (store.loadedAt.get(id) ?? 0) < REUSE_MS));
}

// `reuse`: the live loop's own searches only. The Refresh button, a lapsed lease and the first
// search reload everything.
async function dashboard(force, { reuse = false } = {}) {
  if (DEMO) {
    return {
      ...demo.payload(force),
      refreshSeconds: REFRESH_SECONDS,
      gitdeckUrl: GITDECK_URL,
      linearUrl: demo.LINEAR_URL,
      hideDrafts: false,
      customSound: Boolean(SOUND_FILE),
      digestAvailable: true,
    };
  }
  if (!force && cache.payload && (LIVE || Date.now() - cache.at < CACHE_TTL_MS)) return cache.payload;
  if (inFlight) return inFlight;

  const scanned = CLAUDE_SESSIONS ? scanClaudeSessions() : null;
  let scanDone = !scanned;
  scanned?.then(() => {
    scanDone = true;
  });
  inFlight = exclusive(() => Promise.all([
    fetchBoard({ org: ORG, extraRepos: EXTRA_REPOS, maxAgeDays: MAX_AGE_DAYS }, reuse ? reusableNodes() : new Map()),
    scanned && Promise.race([scanned, new Promise(resolve => setTimeout(resolve, CLAUDE_SCAN_WAIT_MS))]),
  ]))
    .then(async ([fetched]) => {
      const loadedNow = Date.now();
      const loadedAt = new Map([...fetched.nodes.keys()].map(id => [id, store?.loadedAt.get(id) ?? loadedNow]));
      for (const id of fetched.loaded) loadedAt.set(id, loadedNow);
      webhookNotifier?.notify(fetched.board);
      store = { context: fetched.context, nodes: fetched.nodes, loadedAt, detailWarnings: fetched.board.warnings.slice(fetched.context.warnings.length) };
      const prs = [...fetched.board.mine, ...fetched.board.reviews];
      if (slackMode === 'api') await readSlack(prs);
      if (slackMode === 'claude') readSlackInBackground(prs);
      const at = Date.now();
      cache = { at, payload: await layered(fetched.board, new Date(at).toISOString()) };
      if (!scanDone) {
        scanned.then(() => {
          if (cache.payload) cache.payload = withClaudeSessions(cache.payload);
        });
      }
      return cache.payload;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

// A few PRs reloaded and reshaped with the rest, instead of searching again: the searches
// are the scarce quota, a PR's details are not. A PR the reload does not return is kept as
// it was — a lost batch is not a closed PR; the next full search settles it.
function patchPrs(ids) {
  return exclusive(async () => {
    if (!store || !cache.payload) return;
    const detailWarnings = [];
    const reloaded = await loadNodes([...ids], detailWarnings);
    for (const [id, node] of reloaded) {
      store.nodes.set(id, node);
      store.loadedAt.set(id, Date.now());
    }
    const board = shapeBoard(store.nodes, store.context, [...store.detailWarnings, ...detailWarnings]);
    webhookNotifier?.notify(board);
    cache = { ...cache, payload: await layered(board, cache.payload.discoveredAt) };
  });
}

const scope = { org: ORG, extraRepos: EXTRA_REPOS };
const watcher = watch.createWatcher({ scope });
const live = { firstSearchAt: Date.now(), pageAt: 0, hidden: false, checkNow: false, checkedAt: 0, inFlightAt: 0, earlyDiscovery: false, flyingSince: new Map(), working: null };

const onBoard = url => [...cache.payload.mine, ...cache.payload.reviews].find(pr => pr.url === url);
const inScopeUrl = url => {
  const repo = String(url).match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/)?.[1];
  if (!repo) return false;
  return repo.toLowerCase().startsWith(`${ORG.toLowerCase()}/`) || EXTRA_REPOS.some(extra => extra.toLowerCase() === repo.toLowerCase());
};

async function liveStep() {
  const now = Date.now();
  const searchMs = watch.searchEveryMs(REFRESH_SECONDS * 1000, now - live.pageAt <= LEASE_MS);
  if (now >= watch.nextDiscoveryAt(cache.at, live.earlyDiscovery, searchMs)) {
    live.earlyDiscovery = false;
    await dashboard(true, { reuse: true });
    return;
  }

  const interval = live.hidden && !WEBHOOK_URL ? HIDDEN_CHECK_MS : Math.max(CHECK_SECONDS, watcher.pollSeconds) * 1000;
  if (live.checkNow || now - live.checkedAt >= interval) {
    live.checkNow = false;
    live.checkedAt = now;
    const ids = new Set();
    // My own move — a PR made or opened in a Claude session — is shown at once.
    for (const url of CLAUDE_SESSIONS ? await scanClaudeSessions() : []) {
      const pr = onBoard(url);
      if (pr) ids.add(pr.id);
      else if (inScopeUrl(url)) live.earlyDiscovery = true;
    }
    const { changed, unknownTouched, failures } = await watcher.check(cache.payload, now);
    if (failures.length) console.error(`[${new Date().toISOString()}] change check: ${failures.length} failed, first: ${failures[0]}`);
    if (unknownTouched) live.earlyDiscovery = true;
    for (const id of changed) ids.add(id);
    if (ids.size) {
      await patchOrForget(ids);
      console.log(`[${new Date().toISOString()}] live: ${ids.size} PR(s) reloaded`);
    }
    else cache = { ...cache, payload: { ...cache.payload, fetchedAt: new Date(now).toISOString() } };
    return;
  }

  const flying = watch.toFollow(cache.payload, live.flyingSince, now);
  if (flying.length && now - live.inFlightAt >= IN_FLIGHT_MS) {
    live.inFlightAt = now;
    const prints = await fetchStatusFingerprints(flying.map(pr => pr.id));
    const moved = flying.filter(pr => prints.has(pr.id) && prints.get(pr.id) !== statusFingerprint(store.nodes.get(pr.id)));
    if (moved.length) await patchOrForget(new Set(moved.map(pr => pr.id)));
  }
}

// A reload that failed must not swallow the change it was for: the cards read as changed
// again next round.
async function patchOrForget(ids) {
  try {
    await patchPrs(ids);
  } catch (error) {
    watcher.forget([...cache.payload.mine, ...cache.payload.reviews].filter(pr => ids.has(pr.id)));
    throw error;
  }
}

function liveTick() {
  if (live.working) return;
  // The first search failed and no page may come to retry it: a webhook would never start.
  if (!cache.payload) {
    if (!WEBHOOK_URL || Date.now() - live.firstSearchAt < FIRST_SEARCH_RETRY_MS) return;
    live.firstSearchAt = Date.now();
    live.working = dashboard(true)
      .catch(error => console.error(`[${new Date().toISOString()}] first search, retried: ${error.message}`))
      .finally(() => {
        live.working = null;
      });
    return;
  }
  if (!watch.watched(live.pageAt, Date.now(), LEASE_MS, Boolean(WEBHOOK_URL))) return;
  live.working = liveStep()
    .catch(error => console.error(`[${new Date().toISOString()}] live refresh: ${error.message}`))
    .finally(() => {
      live.working = null;
    });
}

function json(res, status, body, version) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...(version ? { 'X-PR-Radar-Version': version } : {}),
  });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64_000) throw new Error('body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

// What a PR I review is waiting for. The board says it with colour and pills; the model
// only ever sees text, so the bucket is spelled out for it.
// The client sends what it has on screen, but the ids are honoured only if the board
// already knows them: the endpoint summarises the board, it is not a way to read
// arbitrary nodes through the session. Shaping the picked ids into what standupNotes
// needs lives in digest.js now, shared with the unattended daily pre-warm script.
async function digestFor(body) {
  // The last board served, expired or not, rather than a fresh one: the client is looking
  // at that payload, so the notes describe what is on screen instead of something newer.
  // Refetching also charged a full GitHub round trip before every digest.
  const board = cache.payload ?? (await dashboard(false));
  const shaped = digest.pickForDigest(board, {
    mine: Array.isArray(body.mine) ? body.mine : [],
    reviews: Array.isArray(body.reviews) ? body.reviews : [],
  });

  return digest.standupNotes(shaped, body.lang === 'fr' ? 'fr' : 'en');
}

async function serveStatic(res, urlPath) {
  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const target = path.join(PUBLIC_DIR, relative);
  if (!target.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'forbidden' });

  try {
    const file = await fs.readFile(target);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(target)] || 'application/octet-stream' });
    res.end(file);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}

if (!ORG) {
  console.error('PR_RADAR_ORG is missing: set it in .env (see .env.example).');
  process.exit(1);
}

let webhookStatuses;
try {
  WEBHOOK_URL = DEMO ? '' : webhook.parseUrl(process.env.PR_RADAR_WEBHOOK_URL);
  webhookStatuses = webhook.parseStatuses(process.env.PR_RADAR_WEBHOOK_STATUSES);
  if (WEBHOOK_URL) webhookNotifier = webhook.createNotifier({ url: WEBHOOK_URL, statuses: webhookStatuses, hideDrafts: HIDE_DRAFTS });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

// Checked here rather than on the first refresh: a bad value would otherwise surface as a
// GitHub search error banner, far from the setting that caused it.
try {
  ownerScope(ORG, EXTRA_REPOS);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/prs') {
    const version = await assetVersion();
    try {
      // Added to the response, not the cache: the banner follows the latest check without
      // waiting for a GitHub refresh to rebuild the payload.
      const now = Date.now();
      // Nobody looked for a while: the checks had stopped, so the cache is as old as that.
      const lapsed = LIVE && !watch.watched(Math.max(live.pageAt, cache.at), now, LEASE_MS, Boolean(WEBHOOK_URL));
      live.pageAt = now;
      live.hidden = url.searchParams.get('hidden') === '1';
      if (url.searchParams.get('check') === '1') {
        live.checkNow = true;
        liveTick();
      }
      const payload = await dashboard(url.searchParams.get('force') === '1' || lapsed);
      json(res, 200, { ...payload, update: DEMO ? demo.update : update.status() }, version);
    } catch (error) {
      json(res, 502, { error: error.message }, version);
    }
    return;
  }

  if (url.pathname === '/sound') {
    try {
      if (!SOUND_FILE) throw new Error('no PR_RADAR_SOUND');
      const file = await fs.readFile(SOUND_FILE);
      res.writeHead(200, {
        'Content-Type': SOUND_TYPES[path.extname(SOUND_FILE).toLowerCase()] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(file);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('no sound');
    }
    return;
  }

  if (DEMO && url.pathname === '/intro') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(await fs.readFile(path.join(__dirname, 'demo-intro.html')));
    return;
  }

  if (url.pathname === '/api/claude-session' && req.method === 'POST') {
    if (DEMO) return json(res, 200, { ok: true });
    const [status, error] = await claudeSessions.resume(
      { headers: req.headers, remoteAddress: req.socket.remoteAddress, readBody: () => readJsonBody(req) },
      { enabled: CLAUDE_SESSIONS, terminal: TERMINAL, board: cache.payload },
    );
    return json(res, status, error ? { error } : { ok: true });
  }

  if (url.pathname === '/api/digest' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      json(res, 200, DEMO ? await demo.notes(body) : await digestFor(body));
    } catch (error) {
      json(res, 502, { error: error.message });
    }
    return;
  }

  await serveStatic(res, url.pathname);
});

server.listen(PORT, async () => {
  if (DEMO) {
    console.log(`PR Radar DEMO → http://localhost:${PORT}  (waiting page: /intro)\n  fake board, nothing fetched · a manual refresh brings in (or takes back) a new review`);
    return;
  }
  digestAvailable = await digest.available();
  slackMode = slack.mode(digestAvailable);
  const SLACK_MODES = {
    api: 'via the Slack API',
    claude: 'via Claude, when a PR on the board has no link yet',
    off: 'off (no PR_RADAR_SLACK_CHANNEL, or no token and no claude CLI)',
  };
  console.log(
    `PR Radar → http://localhost:${PORT}\n` +
      `  org ${ORG}${EXTRA_REPOS.length ? ` + ${EXTRA_REPOS.join(', ')}` : ''} · PRs active within ${MAX_AGE_DAYS} days · merges since the previous working day · ${LIVE ? `full search every ${REFRESH_SECONDS}s, changes checked every ${CHECK_SECONDS}s` : `refresh ${REFRESH_SECONDS}s`}\n` +
      `  drafts ${HIDE_DRAFTS ? 'hidden' : 'shown'}\n` +
      `  standup notes ${digestAvailable ? 'ready' : 'off (claude CLI not found)'}\n` +
      `  slack link ${SLACK_MODES[slackMode]}\n` +
      `  sound ${SOUND_FILE ? SOUND_FILE : 'built-in chime'}\n` +
      `  claude sessions ${CLAUDE_SESSIONS_OFF ?? `on, new ones opened in ${TERMINAL}`}\n` +
      `  linear tickets ${LINEAR_URL ? `linked to ${LINEAR_URL}` : 'off (no PR_RADAR_LINEAR_URL)'}\n` +
      `  webhook ${WEBHOOK_URL ? `to ${new URL(WEBHOOK_URL).host} (${webhookStatuses.length ? webhookStatuses.join(', ') : 'every status'})` : 'off (no PR_RADAR_WEBHOOK_URL)'}\n` +
      `  updates ${update.HOURS ? `checked every ${update.HOURS} h against origin/main` : 'off (PR_RADAR_UPDATE_HOURS=0)'}`,
  );
  update.start();
  if (LIVE) setInterval(liveTick, 5000).unref();
  dashboard(true).catch(error => console.error('First fetch failed:', error.message));
  // Webhooks go out with no tab open. Live, the checks never stop; otherwise the server polls.
  if (WEBHOOK_URL && !LIVE) {
    setInterval(() => {
      dashboard(false).catch(error => console.error('Webhook refresh failed:', error.message));
    }, REFRESH_SECONDS * 1000).unref();
  }
});
