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

const PORT = Number(process.env.PORT || 4321);
const ORG = process.env.PR_RADAR_ORG;
const MAX_AGE_DAYS = Number(process.env.PR_RADAR_MAX_AGE_DAYS || 60);
const REFRESH_SECONDS = Number(process.env.PR_RADAR_REFRESH_SECONDS || 300);
const MERGED_HOURS = Number(process.env.PR_RADAR_MERGED_HOURS || 12);
const GITDECK_URL = process.env.PR_RADAR_GITDECK_URL ?? 'http://localhost:4567';
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

async function dashboard(force) {
  if (!force && cache.payload && Date.now() - cache.at < CACHE_TTL_MS) return cache.payload;
  if (inFlight) return inFlight;

  inFlight = fetchDashboard({ org: ORG, maxAgeDays: MAX_AGE_DAYS, mergedHours: MERGED_HOURS })
    .then(payload => {
      cache = {
        at: Date.now(),
        payload: {
          ...payload,
          refreshSeconds: REFRESH_SECONDS,
          gitdeckUrl: GITDECK_URL,
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
const SITUATION = {
  action: 'the reader has not reviewed it yet, or has replies waiting for them',
  waiting: 'the reader has given feedback and waits for the author to push a fix',
  merged: 'merged',
  idle: 'nothing pending on either side',
};

// The client sends what it has on screen, but the ids are honoured only if the board
// already knows them: the endpoint summarises the board, it is not a way to read
// arbitrary nodes through the session.
async function digestFor(body) {
  // The last board served, expired or not, rather than a fresh one: the client is looking
  // at that payload, so the notes describe what is on screen instead of something newer.
  // Refetching also charged a full GitHub round trip before every digest.
  const board = cache.payload ?? (await dashboard(false));
  const known = new Map([...board.mine, ...board.reviews].map(pr => [pr.id, pr]));

  const pick = (ids, describe) =>
    (Array.isArray(ids) ? ids : [])
      .map(id => known.get(id))
      .filter(Boolean)
      .map(pr => ({
        id: pr.id,
        repo: pr.repo,
        number: pr.number,
        lastActivityAt: pr.lastActivityAt,
        ...(describe ? { situation: SITUATION[pr.bucket] } : {}),
      }));

  return digest.standupNotes(
    { mine: pick(body.mine, false), reviews: pick(body.reviews, true) },
    body.lang === 'fr' ? 'fr' : 'en',
  );
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
  console.log(
    `PR Radar → http://localhost:${PORT}\n` +
      `  org ${ORG} · PRs active within ${MAX_AGE_DAYS} days · merges watched ${MERGED_HOURS}h · refresh ${REFRESH_SECONDS}s\n` +
      `  standup notes ${digestAvailable ? 'ready' : 'off (claude CLI not found)'}`,
  );
  dashboard(true).catch(error => console.error('First fetch failed:', error.message));
});
