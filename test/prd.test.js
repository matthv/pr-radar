'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { group } = require('../public/prd');

const pr = (id, ticket, title, at) => ({ id, ticket, title, lastActivityAt: new Date(at).toISOString() });
const session = (sessionId, ticket, updatedAt, title = null, status = null) => ({ sessionId, ticket, updatedAt, title, status });

test('one group per ticket, both sides and the sessions together, the most recent first and no ticket last', () => {
  const groups = group(
    [pr('a', 'PRD-1', 'feat(server): pause an inbox', 10), pr('b', null, 'fix: typo', 50), pr('c', 'PRD-1', 'feat(front): pause button', 20)],
    [session('s1', 'PRD-2', 30, 'Export button', 'busy'), session('s2', 'PRD-1', 5, null, 'idle'), session('s3', null, 60, null, 'idle')],
  );

  assert.deepEqual(groups.map(g => [g.ticket, g.prs.map(p => p.id), g.sessions.map(s => s.sessionId)]), [
    ['PRD-2', [], ['s1']],
    ['PRD-1', ['a', 'c'], ['s2']],
    [null, ['b'], ['s3']],
  ]);
  assert.deepEqual(groups.map(g => g.subject), ['Export button', 'pause an inbox', '']);
});

test('the subject drops the key a title leads with', () => {
  assert.equal(group([pr('a', 'PRD-7', '[PRD-7] Export the board', 1)], [])[0].subject, 'Export the board');
  assert.equal(group([pr('a', 'PRD-7', 'feat: PRD-7: export the board', 1)], [])[0].subject, 'export the board');
});

test('only a running session shows', () => {
  const groups = group(
    [pr('a', 'PRD-1', 'feat: pause an inbox', 10)],
    [session('done-on-board', 'PRD-1', 5), session('done-elsewhere', 'PRD-9', 40), session('done-no-ticket', null, 50), session('live', 'PRD-9', 30, null, 'busy')],
  );

  assert.deepEqual(groups.map(g => [g.ticket, g.sessions.map(s => s.sessionId)]), [['PRD-9', ['live']], ['PRD-1', []]]);
});
