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
