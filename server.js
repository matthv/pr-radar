'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

// Variables already exported in the shell keep precedence over the file.
try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch {
  /* no .env: fall back to the defaults */
}

const { fetchDashboard } = require('./github');

const PORT = Number(process.env.PORT || 4321);
const ORG = process.env.PR_RADAR_ORG;
const MAX_AGE_DAYS = Number(process.env.PR_RADAR_MAX_AGE_DAYS || 60);
const REFRESH_SECONDS = Number(process.env.PR_RADAR_REFRESH_SECONDS || 300);
const GITDECK_URL = process.env.PR_RADAR_GITDECK_URL ?? 'http://localhost:4567';
// Half the interval: otherwise a poll lands on a barely-valid cache and serves data
// almost twice as old as the advertised interval.
const CACHE_TTL_MS = Math.max(15, REFRESH_SECONDS / 2) * 1000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

let cache = { at: 0, payload: null };
let inFlight = null;

async function dashboard(force) {
  if (!force && cache.payload && Date.now() - cache.at < CACHE_TTL_MS) return cache.payload;
  if (inFlight) return inFlight;

  inFlight = fetchDashboard({ org: ORG, maxAgeDays: MAX_AGE_DAYS })
    .then(payload => {
      cache = {
        at: Date.now(),
        payload: { ...payload, refreshSeconds: REFRESH_SECONDS, gitdeckUrl: GITDECK_URL },
      };
      return cache.payload;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

function json(res, status, body) {
  const raw = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(raw);
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
    try {
      json(res, 200, await dashboard(url.searchParams.get('force') === '1'));
    } catch (error) {
      json(res, 502, { error: error.message });
    }
    return;
  }

  await serveStatic(res, url.pathname);
});

server.listen(PORT, () => {
  console.log(
    `PR Radar → http://localhost:${PORT}\n` +
      `  org ${ORG} · PRs active within ${MAX_AGE_DAYS} days · refresh ${REFRESH_SECONDS}s`,
  );
  dashboard(true).catch(error => console.error('First fetch failed:', error.message));
});
