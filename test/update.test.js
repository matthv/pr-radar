'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { summarize, refusal, blockers, newEnvVars, apply, reasonOf } = require('../update');

const raw = (count, log) => ({ current: 'abc1234\n', latest: 'f00dbabe0123\n', count, log });

test('summarize reads a clone that is up to date', () => {
  assert.deepEqual(summarize(raw('0\n', '')), {
    behind: 0,
    current: 'abc1234',
    latest: 'f00dbabe0123',
    titles: [],
  });
});

test('summarize lists the commits a clone is behind by, one title per line', () => {
  const log = 'fix: read Slack from the repo folder\n\nfeat: link each card to its Slack message\n  docs: tidy\n';
  assert.deepEqual(summarize(raw('3\n', log)), {
    behind: 3,
    current: 'abc1234',
    latest: 'f00dbabe0123',
    titles: [
      'fix: read Slack from the repo folder',
      'feat: link each card to its Slack message',
      'docs: tidy',
    ],
  });
});

test('summarize survives a count with no log, and an unreadable count', () => {
  assert.equal(summarize(raw('2', undefined)).behind, 2);
  assert.deepEqual(summarize(raw('2', undefined)).titles, []);
  assert.equal(summarize(raw('not a number', '')).behind, 0);
});

test('refusal: a clone on another branch, with local edits or its own commits is left alone', () => {
  assert.deepEqual(refusal({ branch: 'feat/x', dirty: false, fastForward: true }), { reason: 'branch', branch: 'feat/x' });
  assert.deepEqual(refusal({ branch: 'main', dirty: true, fastForward: true }), { reason: 'dirty' });
  assert.deepEqual(refusal({ branch: 'main', dirty: false, fastForward: false }), { reason: 'diverged' });
  assert.equal(refusal({ branch: 'main', dirty: false, fastForward: true }), null);
});

test('blockers: dependencies, a lockfile or the Node version stop the restart, nothing else does', () => {
  const base = JSON.stringify({ version: '1.0.0', scripts: { test: 'node --test' }, engines: { node: '>=20' } });
  assert.deepEqual(blockers(base, JSON.stringify({ ...JSON.parse(base), version: '1.1.0', scripts: {} })), []);
  assert.deepEqual(blockers(base, JSON.stringify({ ...JSON.parse(base), dependencies: { x: '1' } })), ['dependencies']);
  assert.deepEqual(blockers(base, base, ['README.md', 'package-lock.json']), ['dependencies']);
  assert.deepEqual(blockers(base, JSON.stringify({ ...JSON.parse(base), engines: { node: '>=22' } })), ['engines']);
  assert.deepEqual(blockers(base, 'not json'), ['dependencies'], 'an unreadable package.json is a risk, not "nothing changed"');
});

test('newEnvVars: names a variable added to .env.example, commented or not', () => {
  const before = 'PR_RADAR_ORG=x\n# PR_RADAR_SOUND=\n';
  assert.deepEqual(newEnvVars(before, `${before}PR_RADAR_NEW=1\n# PR_RADAR_OPT=\n# a comment = not a variable\n`), ['PR_RADAR_NEW', 'PR_RADAR_OPT']);
  assert.deepEqual(newEnvVars(before, before), []);
});

const gitError = (code, stderr) => Object.assign(new Error(`Command failed: git\n${stderr}`), { code, stderr });

function fakeGit({
  branch = 'main', dirty = '', fastForward = true, newPackage = '{}', changed = '', fetchFails = false,
  head = 'aaaaaaa1111', mergeBaseError = null, oldExample = 'A=1\n', newExample = 'A=1\n', noOldExample = false,
} = {}) {
  const calls = [];
  const exec = async (...args) => {
    const line = args.join(' ');
    calls.push(line);
    const [command] = args;
    if (command === 'fetch' && fetchFails) throw gitError(128, 'fatal: unable to access: Could not resolve host: github.com');
    if (command === 'merge-base') {
      if (mergeBaseError) throw mergeBaseError;
      if (!fastForward) throw gitError(1, '');
      return '';
    }
    if (line === 'rev-parse --abbrev-ref HEAD') return `${branch}\n`;
    if (line === 'rev-parse HEAD') return `${head}\n`;
    if (line === 'rev-parse origin/main') return 'bbbbbbb2222\n';
    if (command === 'status') return dirty;
    if (line === 'show origin/main:package.json') return newPackage;
    if (line === 'show HEAD:.env.example') {
      if (noOldExample) throw gitError(128, "fatal: path '.env.example' does not exist in 'HEAD'");
      return oldExample;
    }
    if (line === 'show origin/main:.env.example') return newExample;
    if (command === 'show') return '{}';
    if (command === 'diff') return changed;
    return '';
  };
  return { exec, calls };
}
const merged = calls => calls.includes('merge --ff-only --quiet origin/main');
const noRefresh = { pulled: async () => {} };

test('apply: a clean clone on main is fast-forwarded and asks for a restart', async () => {
  const { exec, calls } = fakeGit();
  const result = await apply(exec, noRefresh);
  assert.ok(merged(calls));
  assert.deepEqual(result, { ok: true, from: 'aaaaaaa', to: 'bbbbbbb', blockers: [], newEnvVars: [], restart: true });
});

test('apply: a refused clone is never merged', async () => {
  for (const setup of [{ branch: 'feat/x' }, { dirty: ' M github.js\n' }, { fastForward: false }]) {
    const { exec, calls } = fakeGit(setup);
    const result = await apply(exec, noRefresh);
    assert.equal(result.ok, false, JSON.stringify(setup));
    assert.equal(merged(calls), false, JSON.stringify(setup));
  }
});

test('apply: a new dependency is pulled but not restarted on', async () => {
  const { exec, calls } = fakeGit({ newPackage: JSON.stringify({ dependencies: { x: '1' } }) });
  const result = await apply(exec, noRefresh);
  assert.ok(merged(calls));
  assert.deepEqual([result.restart, result.blockers], [false, ['dependencies']]);
});

test('apply: a failed fetch throws before anything is touched', async () => {
  const { exec, calls } = fakeGit({ fetchFails: true });
  await assert.rejects(apply(exec, noRefresh), /resolve host/);
  assert.deepEqual(calls, ['fetch --quiet origin main']);
});

test('apply: a clone already on origin/main is not "updated" again', async () => {
  const { exec, calls } = fakeGit({ head: 'bbbbbbb2222' });
  assert.deepEqual(await apply(exec, noRefresh), { ok: false, reason: 'current' });
  assert.equal(merged(calls), false);
});

test('apply: a git error is not read as a divergence', async () => {
  const { exec, calls } = fakeGit({ mergeBaseError: gitError(128, 'fatal: bad object HEAD') });
  await assert.rejects(apply(exec, noRefresh), /bad object/);
  assert.equal(merged(calls), false);
});

test('apply: the clone is settled after the merge, and new variables and lockfiles reach the result', async () => {
  const order = [];
  const { exec, calls } = fakeGit({ changed: 'yarn.lock\n', newExample: 'A=1\n# PR_RADAR_NEW=\n' });
  const result = await apply(async (...args) => {
    order.push(args[0]);
    return exec(...args);
  }, { pulled: async to => order.push(`pulled ${to}`) });
  assert.ok(merged(calls));
  assert.ok(order.indexOf('pulled bbbbbbb2222') > order.indexOf('merge'), 'settled after the merge, at the new commit');
  assert.deepEqual([result.blockers, result.newEnvVars, result.restart], [['dependencies'], ['PR_RADAR_NEW'], false]);
});

test('apply: a commit older than .env.example names every variable as new', async () => {
  const { exec } = fakeGit({ noOldExample: true, newExample: 'A=1\n' });
  assert.deepEqual((await apply(exec, noRefresh)).newEnvVars, ['A']);
});

test('reasonOf: what git said, not the command line', () => {
  assert.equal(reasonOf(gitError(128, '\nfatal: unable to access: Could not resolve host: github.com\n')), 'fatal: unable to access: Could not resolve host: github.com');
  assert.equal(reasonOf(new Error('spawn git ENOENT')), 'spawn git ENOENT');
  assert.equal(reasonOf(gitError(1, '')), 'git failed');
});
