'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { assembleNodes, statusFingerprint, recentlyTouchedPullRequests } = require('../github');

test('fetch: a search keeps the PRs it was handed, adds the loaded ones, drops the rest', () => {
  const reusable = new Map([['A', { id: 'A', v: 'held' }], ['B', { id: 'B', v: 'held' }], ['GONE', { id: 'GONE' }]]);
  const loaded = new Map([['B', { id: 'B', v: 'fresh' }], ['C', { id: 'C', v: 'fresh' }]]);
  const nodes = assembleNodes(['A', 'B', 'C', 'LOST'], reusable, loaded);
  assert.deepEqual([...nodes.keys()], ['A', 'B', 'C'], 'only what the search found, and a lost batch is no node');
  assert.equal(nodes.get('A').v, 'held');
  assert.equal(nodes.get('B').v, 'fresh', 'a reload wins over what was held');
});

const pr = ({ merged = false, head = 'PENDING', rollup = null, suites = [] } = {}) => ({
  id: 'PR_1',
  title: 'not part of the status',
  merged,
  mergeCommit: merged ? { oid: 'x', statusCheckRollup: rollup && { state: rollup }, checkSuites: { nodes: suites.map(([status, conclusion]) => ({ status, conclusion, workflowRun: null, checkRuns: { totalCount: 1 } })) } } : null,
  head: { nodes: [{ commit: { committedDate: 'd', author: null, statusCheckRollup: { state: head } } }] },
});

test('fetch: the light status read and the full PR give the same fingerprint until the CI moves', () => {
  const full = pr({ head: 'PENDING' });
  const light = { id: 'PR_1', merged: false, mergeCommit: null, head: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] } };
  assert.equal(statusFingerprint(light), statusFingerprint(full), 'fields only the full query has do not count');
  assert.notEqual(statusFingerprint(pr({ head: 'SUCCESS' })), statusFingerprint(full));

  const running = pr({ merged: true, rollup: 'PENDING', suites: [['IN_PROGRESS', null]] });
  const done = pr({ merged: true, rollup: 'SUCCESS', suites: [['COMPLETED', 'SUCCESS']] });
  assert.notEqual(statusFingerprint(running), statusFingerprint(done), 'a release that finishes');
});

const http = (status, headers, body = '') =>
  [`HTTP/2.0 ${status} ${status === 304 ? 'Not Modified' : 'OK'}`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), '', body].join('\r\n');

test('fetch: the event feed is read again only when its first page changed', async () => {
  const events = [{ type: 'PullRequestEvent', repo: { name: 'ForestAdmin/agent-ruby' }, payload: { pull_request: { number: 398 } } }];
  const calls = [];
  const exec = async args => {
    calls.push(args.filter(arg => !arg.startsWith('If-')).join(' '));
    const conditional = args.includes('-H');
    if (args[2].endsWith('page=1')) return conditional ? http(304, {}) : http(200, { ETag: 'W/"e1"' }, JSON.stringify(events));
    return '[]';
  };

  const first = await recentlyTouchedPullRequests('ForestAdmin', 'me', exec);
  assert.deepEqual(first, [{ owner: 'ForestAdmin', name: 'agent-ruby', number: 398 }]);
  assert.equal(calls.length, 3, 'three pages the first time');

  const again = await recentlyTouchedPullRequests('ForestAdmin', 'me', exec);
  assert.deepEqual(again, first);
  assert.equal(calls.length, 4, 'then a single free 304');
});
