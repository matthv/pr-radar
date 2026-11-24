'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const demo = require('../demo');
const demoPrds = require('../demo-prds');
const { sessionStatus } = require('../public/prd');

const board = () => {
  const { mine, reviews } = demo.payload(false);
  return [...mine, ...reviews];
};

test('demo PRDs: the tickets link the board demo\'s cards and their sessions', () => {
  const { prds } = demoPrds.view(board());
  const byTicket = new Map(prds.map(prd => [prd.ticket, prd]));
  assert.deepEqual([...byTicket.keys()], ['PRD-812', 'PRD-845', 'PRD-871', 'PRD-880']);
  for (const pr of byTicket.get('PRD-812').prs) assert.ok(pr.boardId, `${pr.url} is a card of the board demo`);
  assert.ok(byTicket.get('PRD-812').sessions.length >= 3);
  assert.equal(byTicket.get('PRD-845').assigned, false);
  assert.deepEqual(byTicket.get('PRD-880').sessions, []);
});

test('demo Sessions: every group the view draws has a session in it', () => {
  const { sessions } = demoPrds.view(board(), demoPrds.STARTED_AT);
  const now = demoPrds.STARTED_AT;
  const groups = new Set(sessions.map(session => sessionStatus(session, now)));
  for (const group of ['busy', 'waiting', 'open', 'closed']) assert.ok(groups.has(group), group);
  assert.ok(sessions.some(session => session.waitingFor === 'permission prompt'));
  assert.ok(sessions.every(session => session.title), 'every session has a title');
});

test('demo Sessions: the back-end session works, then asks, as the cycle turns', () => {
  const backend = at => demoPrds.statuses(at).sessions.find(session => session.skill === 'forest:implement');
  const start = demoPrds.STARTED_AT;
  assert.equal(backend(start).state, 'running');
  const asking = backend(start + demoPrds.CYCLE_MS / 2);
  assert.equal(asking.state, 'waiting');
  assert.match(asking.question, /v1 agents/);
  assert.equal(backend(start + demoPrds.CYCLE_MS).state, 'running');
});
