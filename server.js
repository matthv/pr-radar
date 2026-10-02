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

const { fetchDashboard } = require('./github');
const digest = require('./digest');
const slack = require('./slack');
const update = require('./update');
const demo = require('./demo');
const claudeSessions = require('./claude-sessions');

// A fake board on its own port: no call to GitHub, Slack, Claude or git, so the real
// board on the default port and its browser state stay untouched.
const DEMO = process.env.PR_RADAR_DEMO === 'true';

const PORT = Number(process.env.PORT || 4321);
const ORG = DEMO ? demo.ORG : process.env.PR_RADAR_ORG;
const MAX_AGE_DAYS = Number(process.env.PR_RADAR_MAX_AGE_DAYS || 60);
const REFRESH_SECONDS = Number(process.env.PR_RADAR_REFRESH_SECONDS || 300);
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
let digestAvailable = false;
let slackMode = 'off';
let slackWarning = null;
let slackReading = null;
let claudeWarning = null;

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
    ({ unreadable }) => {
      claudeWarning = unreadable ? { source: 'claude', kind: 'unreadable', message: `${unreadable} transcript(s) could not be read` } : null;
    },
    error => {
      claudeWarning = { source: 'claude', kind: 'failed', message: error.message };
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

async function dashboard(force) {
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
  if (!force && cache.payload && Date.now() - cache.at < CACHE_TTL_MS) return cache.payload;
  if (inFlight) return inFlight;

  const scanned = CLAUDE_SESSIONS ? scanClaudeSessions() : null;
  let scanDone = !scanned;
  scanned?.then(() => {
    scanDone = true;
  });
  inFlight = Promise.all([
    fetchDashboard({ org: ORG, maxAgeDays: MAX_AGE_DAYS }),
    scanned && Promise.race([scanned, new Promise(resolve => setTimeout(resolve, CLAUDE_SCAN_WAIT_MS))]),
  ])
    .then(async ([fetchedBoard]) => {
      const fetched = CLAUDE_SESSIONS ? withClaudeSessions(fetchedBoard) : fetchedBoard;
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
          linearUrl: LINEAR_URL,
          hideDrafts: HIDE_DRAFTS,
          customSound: Boolean(SOUND_FILE),
          digestAvailable,
        },
      };
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
      // Added to the response, not the cache: the banner follows the latest check without
      // waiting for a GitHub refresh to rebuild the payload.
      const payload = await dashboard(url.searchParams.get('force') === '1');
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
      `  org ${ORG} · PRs active within ${MAX_AGE_DAYS} days · merges since the previous working day · refresh ${REFRESH_SECONDS}s\n` +
      `  drafts ${HIDE_DRAFTS ? 'hidden' : 'shown'}\n` +
      `  standup notes ${digestAvailable ? 'ready' : 'off (claude CLI not found)'}\n` +
      `  slack link ${SLACK_MODES[slackMode]}\n` +
      `  sound ${SOUND_FILE ? SOUND_FILE : 'built-in chime'}\n` +
      `  claude sessions ${CLAUDE_SESSIONS_OFF ?? `on, new ones opened in ${TERMINAL}`}\n` +
      `  linear tickets ${LINEAR_URL ? `linked to ${LINEAR_URL}` : 'off (no PR_RADAR_LINEAR_URL)'}\n` +
      `  updates ${update.HOURS ? `checked every ${update.HOURS} h against origin/main` : 'off (PR_RADAR_UPDATE_HOURS=0)'}`,
  );
  update.start();
  dashboard(true).catch(error => console.error('First fetch failed:', error.message));
});
