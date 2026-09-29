'use strict';

const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);

// The commit is the version: the tool has no other. Every few hours the server compares
// its own HEAD with origin/main and the page says so when it is behind. It never pulls on
// its own — a colleague's clone may carry local changes, and a restart is needed anyway.
const HOURS = Number(process.env.PR_RADAR_UPDATE_HOURS ?? 2);

async function git(...args) {
  const { stdout } = await execFile('git', args, { cwd: __dirname, encoding: 'utf8' });
  return stdout;
}

// Only "behind" counts. Being ahead — commits not pushed yet — is the author's normal
// state while working, and a banner there would be noise.
function summarize({ current, latest, count, log }) {
  const titles = String(log ?? '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  return {
    behind: Number(String(count).trim()) || 0,
    current: String(current).trim(),
    latest: String(latest).trim(),
    titles,
  };
}

async function check() {
  await git('fetch', '--quiet', 'origin', 'main');
  const [current, latest, count, log] = await Promise.all([
    git('rev-parse', '--short', 'HEAD'),
    git('rev-parse', 'origin/main'),
    git('rev-list', '--count', 'HEAD..origin/main'),
    git('log', '--format=%s', 'HEAD..origin/main'),
  ]);
  return summarize({ current, latest, count, log });
}

let latest = null;

// A failed check is not board data: no git, a folder downloaded as a zip, no network —
// the page simply shows nothing about versions, and the next tick tries again.
async function refresh() {
  try {
    latest = await check();
  } catch (error) {
    latest = null;
    console.error(`update check failed: ${error.message.split('\n')[0]}`);
  }
  return latest;
}

function start() {
  if (!HOURS) return;
  refresh();
  setInterval(refresh, HOURS * 60 * 60 * 1000).unref();
}

const status = () => latest;

module.exports = { HOURS, start, status, check, summarize };
