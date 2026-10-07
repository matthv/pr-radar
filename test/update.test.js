'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { summarize, refusal, blockers, newEnvVars, apply } = require('../update');

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
  assert.deepEqual(blockers('', 'not json'), [], 'an unreadable package reads as empty on both sides');
});

test('newEnvVars: names a variable added to .env.example, commented or not', () => {
  const before = 'PR_RADAR_ORG=x\n# PR_RADAR_SOUND=\n';
  assert.deepEqual(newEnvVars(before, `${before}PR_RADAR_NEW=1\n# PR_RADAR_OPT=\n# a comment = not a variable\n`), ['PR_RADAR_NEW', 'PR_RADAR_OPT']);
  assert.deepEqual(newEnvVars(before, before), []);
});

function fakeGit({ branch = 'main', dirty = '', fastForward = true, newPackage = '{}', changed = '', fetchFails = false } = {}) {
  const calls = [];
  const exec = async (...args) => {
    calls.push(args.join(' '));
    const [command] = args;
    if (command === 'fetch' && fetchFails) throw new Error('Could not resolve host: github.com');
    if (command === 'merge-base') {
      if (!fastForward) throw new Error('not an ancestor');
      return '';
    }
    if (args.join(' ') === 'rev-parse --abbrev-ref HEAD') return `${branch}\n`;
    if (args.join(' ') === 'rev-parse HEAD') return 'aaaaaaa1111\n';
    if (args.join(' ') === 'rev-parse origin/main') return 'bbbbbbb2222\n';
    if (command === 'status') return dirty;
    if (args.join(' ') === 'show origin/main:package.json') return newPackage;
    if (command === 'show') return '{}';
    if (command === 'diff') return changed;
    return '';
  };
  return { exec, calls };
}
const merged = calls => calls.some(call => call.startsWith('merge --ff-only'));
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
