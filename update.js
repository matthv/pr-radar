'use strict';

const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);

// The commit is the version: the tool has no other. Every few hours the server compares
// its own HEAD with origin/main and the page says so when it is behind. It pulls only when
// asked from the page, and only when that is safe (see `apply`).
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

// A clone someone works in is theirs: local edits, another branch or a history of its own
// are never pulled over, the page says why and leaves the command to them.
function refusal({ branch, dirty, fastForward }) {
  if (branch !== 'main') return { reason: 'branch', branch };
  if (dirty) return { reason: 'dirty' };
  if (!fastForward) return { reason: 'diverged' };
  return null;
}

const LOCKFILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']);

// The tool has no dependency today. The day it gets one, restarting on the new code before
// `npm install` would crash it, so the pull happens and the restart is left to the person.
function blockers(oldPackage, newPackage, changedFiles = []) {
  const parse = text => {
    try {
      return JSON.parse(text || '{}');
    } catch {
      return {};
    }
  };
  const before = parse(oldPackage);
  const after = parse(newPackage);
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const found = [];
  if (!same(before.dependencies, after.dependencies) || changedFiles.some(file => LOCKFILES.has(file))) {
    found.push('dependencies');
  }
  if (!same(before.engines?.node, after.engines?.node)) found.push('engines');
  return found;
}

// Variables are set by hand in .env; the page names the new ones, commented or not.
function newEnvVars(oldExample, newExample) {
  const names = text => new Set(
    [...String(text ?? '').matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]*)=/gm)].map(match => match[1]),
  );
  const before = names(oldExample);
  return [...names(newExample)].filter(name => !before.has(name));
}

async function apply(exec = git, { pulled = refresh } = {}) {
  const read = (...args) => exec(...args).then(String, () => '');
  await exec('fetch', '--quiet', 'origin', 'main');
  const [branch, dirty, from, to] = await Promise.all([
    exec('rev-parse', '--abbrev-ref', 'HEAD'),
    exec('status', '--porcelain', '--untracked-files=no'),
    exec('rev-parse', 'HEAD'),
    exec('rev-parse', 'origin/main'),
  ]).then(values => values.map(value => String(value).trim()));
  const fastForward = await exec('merge-base', '--is-ancestor', 'HEAD', 'origin/main').then(() => true, () => false);
  const refused = refusal({ branch, dirty: dirty !== '', fastForward });
  if (refused) return { ok: false, ...refused };

  const [oldPackage, newPackage, changed, oldExample, newExample] = await Promise.all([
    read('show', 'HEAD:package.json'),
    read('show', 'origin/main:package.json'),
    read('diff', '--name-only', 'HEAD', 'origin/main'),
    read('show', 'HEAD:.env.example'),
    read('show', 'origin/main:.env.example'),
  ]);
  await exec('merge', '--ff-only', '--quiet', 'origin/main');
  await pulled();
  const blocked = blockers(oldPackage, newPackage, changed.split('\n').map(line => line.trim()).filter(Boolean));
  return {
    ok: true,
    from: from.slice(0, 7),
    to: to.slice(0, 7),
    blockers: blocked,
    newEnvVars: newEnvVars(oldExample, newExample),
    restart: blocked.length === 0,
  };
}

module.exports = { HOURS, start, status, check, summarize, refusal, blockers, newEnvVars, apply };
