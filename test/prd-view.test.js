'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const linear = require('../linear');
const claudeSessions = require('../claude-sessions');
const skillStages = require('../skill-stages');
const { createPrdView } = require('../prd-view');

const SESSION = '11111111-1111-1111-1111-111111111111';
const issue = ticket => ({ ticket, title: ticket, prs: [], assigned: true, status: null, labels: [] });

test('a failing Linear is a warning: the sessions still show, and the last tickets read stay', async t => {
  t.mock.method(skillStages, 'readStages', async () => []);
  t.mock.method(claudeSessions, 'liveSessions', async () => [{ sessionId: SESSION, pid: 1, status: 'idle' }]);
  const fetchPrds = t.mock.method(linear, 'fetchPrds', async () => { throw new Error('Authentication required'); });
  const prdView = createPrdView({ boardPrs: () => [], linearApiKey: 'k', claudeSessionsOn: false, sessionChime: false, maxAgeDays: 60, stageWindowMs: 86_400_000, cacheTtlMs: 0 });

  const first = await prdView.view(false);
  assert.deepEqual(first.sessions.map(session => session.sessionId), [SESSION]);
  assert.deepEqual(first.prds, []);
  assert.deepEqual(first.warnings.map(warning => [warning.source, warning.failed]), [['linear', true]]);

  fetchPrds.mock.mockImplementation(async () => [issue('PRD-1')]);
  assert.deepEqual((await prdView.view(false)).prds.map(prd => prd.ticket), ['PRD-1']);

  fetchPrds.mock.mockImplementation(async () => { throw new Error('503 Service Unavailable'); });
  const stale = await prdView.view(false);
  assert.deepEqual(stale.prds.map(prd => prd.ticket), ['PRD-1']);
  assert.match(stale.warnings[0].message, /503 .*showing the last tickets read/);
});

test('Linear is read once per TTL and set of extra tickets; a forced read goes again, concurrent ones share', async t => {
  let stageTickets = [];
  t.mock.method(skillStages, 'readStages', async () => stageTickets.map(ticket => ({ sessionId: SESSION, tickets: new Set([ticket]), prUrls: new Set(), current: { skill: 'implement', state: 'running', at: 'a' } })));
  t.mock.method(claudeSessions, 'liveSessions', async () => []);
  let release;
  const fetchPrds = t.mock.method(linear, 'fetchPrds', async () => [issue('PRD-1')]);
  const prdView = createPrdView({ boardPrs: () => [], linearApiKey: 'k', claudeSessionsOn: false, sessionChime: false, maxAgeDays: 60, stageWindowMs: 86_400_000, cacheTtlMs: 60_000 });

  await prdView.view(false);
  await prdView.view(false);
  assert.equal(fetchPrds.mock.callCount(), 1);
  await prdView.view(true);
  assert.equal(fetchPrds.mock.callCount(), 2);
  stageTickets = ['PRD-9'];
  await prdView.view(false);
  assert.equal(fetchPrds.mock.callCount(), 3);

  stageTickets = ['PRD-10'];
  fetchPrds.mock.mockImplementation(() => new Promise(resolve => { release = () => resolve([issue('PRD-1')]); }));
  const both = Promise.all([prdView.view(false), prdView.view(false)]);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  release();
  await both;
  assert.equal(fetchPrds.mock.callCount(), 4);
});

test('transcripts that cannot be read are a warning, not an empty view that looks like nothing linked', async t => {
  t.mock.method(skillStages, 'readStages', async () => []);
  t.mock.method(claudeSessions, 'liveSessions', async () => []);
  const scan = t.mock.method(claudeSessions, 'scan', async () => ({ unreadable: 2, touched: [] }));
  const prdView = createPrdView({ boardPrs: () => [], linearApiKey: '', claudeSessionsOn: true, sessionChime: false, maxAgeDays: 60, stageWindowMs: 86_400_000, cacheTtlMs: 0 });
  assert.deepEqual((await prdView.view(false)).warnings.map(warning => warning.message), ['2 transcript(s) could not be read']);
  scan.mock.mockImplementation(async () => { throw new Error('EACCES: permission denied'); });
  assert.match((await prdView.view(false)).warnings[0].message, /Claude transcripts: EACCES/);
});

test('one unreadable stage file is a warning, in the poll as in the full read, never a 502', async t => {
  t.mock.method(skillStages, 'readStages', async () => { throw new Error('EISDIR: illegal operation on a directory'); });
  t.mock.method(claudeSessions, 'liveSessions', async () => [{ sessionId: SESSION, pid: 1, status: 'busy' }]);
  t.mock.method(claudeSessions, 'agentsProblem', () => '`claude agents --json` failed: boom');
  const prdView = createPrdView({ boardPrs: () => [], linearApiKey: '', claudeSessionsOn: false, maxAgeDays: 60, cacheTtlMs: 0 });

  const poll = await prdView.statuses();
  assert.deepEqual(poll.sessions.map(session => [session.sessionId, session.status]), [[SESSION, 'busy']]);
  assert.deepEqual(poll.warnings.map(warning => warning.source), ['stages', 'claude']);
  const full = await prdView.view(false);
  assert.deepEqual(full.warnings.map(warning => warning.source), ['stages', 'claude']);
  assert.match(full.warnings[0].message, /EISDIR/);
  assert.match(full.warnings[1].message, /claude agents/);
});

test('the PRs a view scan met reach the board\'s change check once, with the board\'s own', async t => {
  t.mock.method(skillStages, 'readStages', async () => []);
  t.mock.method(claudeSessions, 'liveSessions', async () => []);
  t.mock.method(claudeSessions, 'scan', async () => ({ unreadable: 0, touched: ['https://github.com/o/r/pull/1'] }));
  const prdView = createPrdView({ boardPrs: () => [], linearApiKey: '', claudeSessionsOn: true, maxAgeDays: 60, cacheTtlMs: 0 });

  await prdView.view(false);
  assert.deepEqual(prdView.takeTouched(['https://github.com/o/r/pull/2', 'https://github.com/o/r/pull/1']),
    ['https://github.com/o/r/pull/1', 'https://github.com/o/r/pull/2']);
  assert.deepEqual(prdView.takeTouched(['https://github.com/o/r/pull/2']), ['https://github.com/o/r/pull/2']);
});

test('the routes answer this machine only, and the demo never reads the real sessions or Linear', async t => {
  const readStages = t.mock.method(skillStages, 'readStages', async () => []);
  const prdView = createPrdView({ boardPrs: () => [], isDemo: true, linearApiKey: 'k', claudeSessionsOn: true, maxAgeDays: 60, cacheTtlMs: 0 });
  const local = { remoteAddress: '127.0.0.1', host: 'localhost:4321' };

  assert.deepEqual(await prdView.answer({ pathname: '/api/prds', ...local, remoteAddress: '192.168.1.20' }), [403, { error: 'only from this machine' }]);
  assert.deepEqual(await prdView.answer({ pathname: '/api/sessions/status', ...local, host: 'evil.example:4321' }), [403, { error: 'only on localhost' }]);
  const [code, body] = await prdView.answer({ pathname: '/api/prds', ...local });
  assert.equal(code, 200);
  assert.ok(body.prds.length > 0);
  assert.equal(readStages.mock.callCount(), 0);
  assert.ok(prdView.serves('/api/sessions/status'));
  assert.ok(!prdView.serves('/api/prs'));
});
