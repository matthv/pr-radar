'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

// Variables already exported in the shell keep precedence over the file.
try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch {
  /* no .env: fall back to the defaults */
}

const { fetchDashboard } = require('./github');
const digest = require('./digest');
const slack = require('./slack');

const PORT = Number(process.env.PORT || 4321);
const ORG = process.env.PR_RADAR_ORG;
const MAX_AGE_DAYS = Number(process.env.PR_RADAR_MAX_AGE_DAYS || 60);
const REFRESH_SECONDS = Number(process.env.PR_RADAR_REFRESH_SECONDS || 300);
const GITDECK_URL = process.env.PR_RADAR_GITDECK_URL ?? 'http://localhost:4567';
// A standing policy, not a per-session toggle: whether drafts belong on the board is
// decided once, so it lives with the other settings rather than in the toolbar.
const HIDE_DRAFTS = process.env.PR_RADAR_HIDE_DRAFTS === 'true';
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
let digestAvailable = false;
let slackMode = 'off';
let slackWarning = null;
let slackReading = null;

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
    slackWarning = { source: 'slack', message: error.message };
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

async function dashboard(force) {
  if (!force && cache.payload && Date.now() - cache.at < CACHE_TTL_MS) return cache.payload;
  if (inFlight) return inFlight;

  inFlight = fetchDashboard({ org: ORG, maxAgeDays: MAX_AGE_DAYS })
    .then(async fetched => {
      const prs = [...fetched.mine, ...fetched.reviews];
      if (slackMode === 'api') await readSlack(prs);
      if (slackMode === 'claude') readSlackInBackground(prs);
      const payload = slackMode === 'off' ? fetched : await withSlackLinks(fetched);

      cache = {
        at: Date.now(),
        payload: {
          ...payload,
          warnings: slackWarning ? [...payload.warnings, slackWarning] : payload.warnings,
          refreshSeconds: REFRESH_SECONDS,
          gitdeckUrl: GITDECK_URL,
          hideDrafts: HIDE_DRAFTS,
          digestAvailable,
        },
      };
      return cache.payload;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/prs') {
    const version = await assetVersion();
    try {
      json(res, 200, await dashboard(url.searchParams.get('force') === '1'), version);
    } catch (error) {
      json(res, 502, { error: error.message }, version);
    }
    return;
  }

  if (url.pathname === '/api/digest' && req.method === 'POST') {
    try {
      json(res, 200, await digestFor(await readJsonBody(req)));
    } catch (error) {
      json(res, 502, { error: error.message });
    }
    return;
  }

  await serveStatic(res, url.pathname);
});

server.listen(PORT, async () => {
  digestAvailable = await digest.available();
  slackMode = slack.mode(digestAvailable);
  const SLACK_MODES = {
    api: 'via the Slack API',
    claude: 'via Claude, when a PR on the board has no link yet',
    off: 'off (no PR_RADAR_SLACK_CHANNEL, or no token and no claude CLI)',
  };
  console.log(
    `PR Radar → http://localhost:${PORT}\n` +
      `  org ${ORG} · PRs active within ${MAX_AGE_DAYS} days · merges since the previous working day · refresh ${REFRESH_SECONDS}s\n` +
      `  drafts ${HIDE_DRAFTS ? 'hidden' : 'shown'}\n` +
      `  standup notes ${digestAvailable ? 'ready' : 'off (claude CLI not found)'}\n` +
      `  slack link ${SLACK_MODES[slackMode]}`,
  );
  dashboard(true).catch(error => console.error('First fetch failed:', error.message));
});
