'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildPrds, extraTickets } = require('../prds');
const { group, sortPrds, runningSkills, withMain } = require('../public/prd');

const PR7 = 'https://github.com/ForestAdmin/claudine/pull/7';
const PR8 = 'https://github.com/ForestAdmin/claudine/pull/8';
const PR9 = 'https://github.com/ForestAdmin/claudine/pull/9';

const prd = (ticket, extra = {}) => ({
  ticket, title: `Title ${ticket}`, url: `https://linear.app/x/issue/${ticket}`,
  createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-02T00:00:00Z',
  status: { name: 'In Progress', position: 2 }, project: null, labels: [], prs: [], assigned: true, sessions: [], ...extra,
});

const stage = (sessionId, { tickets = [], prUrls = [], current }) => ({
  sessionId, tickets: new Set(tickets), prUrls: new Set(prUrls), current,
});

test('a PRD gathers the PRs Linear attached and the board PRs naming its ticket, once each', () => {
  const [built] = buildPrds({
    prds: [prd('PRD-1', { prs: [{ url: PR7, title: 'from linear' }, { url: PR9, title: 'merged long ago' }] })],
    boardPrs: [
      { id: 'A', url: PR7, title: 'feat: seven', repo: 'ForestAdmin/claudine', number: 7, ticket: 'PRD-1', needsAction: true },
      { id: 'B', url: PR8, title: 'fix: eight', repo: 'ForestAdmin/claudine', number: 8, ticket: 'PRD-1', merged: true },
      { id: 'C', url: 'https://github.com/o/r/pull/1', title: 'other', ticket: 'PRD-2' },
    ],
  });
  assert.deepEqual(built.prs.map(pr => [pr.number, pr.title, pr.boardId, pr.state, pr.needsAction]), [
    [7, 'feat: seven', 'A', 'open', true],
    [9, 'merged long ago', null, null, false],
    [8, 'fix: eight', 'B', 'merged', false],
  ]);
});

test('a session joins a PRD by the ticket its stages name, or by one of the PRD\'s PRs', () => {
  const running = { skill: 'validator', stage: 'skeptic', state: 'running', at: '2026-11-12T10:00:00Z' };
  const built = buildPrds({
    prds: [prd('PRD-1', { prs: [{ url: PR7 }] }), prd('PRD-2')],
    stageSessions: [
      stage('by-ticket', { tickets: ['PRD-2'], current: { skill: 'implement', stage: 'code', state: 'running', at: 'b' } }),
      stage('by-pr', { prUrls: [PR7], current: running }),
    ],
    live: [{ sessionId: 'by-pr', name: 'claudine-1', status: 'busy', updatedAt: 1 }],
    cwdOf: id => (id === 'by-ticket' ? '/tmp/wt' : null),
  });
  assert.deepEqual(built[0].sessions.map(s => [s.sessionId, s.name, s.running, s.skill, s.stage, s.resumable]), [
    ['by-pr', 'claudine-1', true, 'validator', 'skeptic', true],
  ]);
  assert.deepEqual(built[1].sessions.map(s => [s.sessionId, s.running, s.skill, s.resumable]), [['by-ticket', false, 'implement', true]]);
});

test('the session that opened a PRD\'s PR shows only while it runs', () => {
  const build = live => buildPrds({
    prds: [prd('PRD-1', { prs: [{ url: PR7 }] })],
    live,
    sessionFor: url => (url === PR7 ? { sessionId: 'opener', cwd: '/x' } : null),
  })[0].sessions.map(s => s.sessionId);
  assert.deepEqual(build([]), []);
  assert.deepEqual(build([{ sessionId: 'opener' }]), ['opener']);
});

test('every running session naming the ticket joins its PRD, and only the two newest ended ones', () => {
  const at = day => `2026-11-0${day}T00:00:00.000Z`;
  const mentions = [
    { sessionId: 's5', cwd: '/w', at: at(5) }, { sessionId: 's4', cwd: '/w', at: at(4) },
    { sessionId: 's3', cwd: '/w', at: at(3) }, { sessionId: 's1', cwd: '/w', at: at(1) },
  ];
  const [built] = buildPrds({
    prds: [prd('PRD-1')],
    live: [{ sessionId: 's1', name: 'dev-93', status: 'idle', updatedAt: Date.parse(at(6)) }],
    sessionsOf: ticket => (ticket === 'PRD-1' ? mentions : []),
    cwdOf: () => '/w',
  });
  assert.deepEqual(built.sessions.map(session => [session.sessionId, session.running, session.at]),
    [['s1', true, at(6)], ['s5', false, at(5)], ['s4', false, at(4)]]);
  assert.ok(built.sessions.every(session => session.resumable));
});

test('the session that did most of a ticket\'s work comes first, marked main; a lone session is not', () => {
  const [built, lone] = buildPrds({
    prds: [prd('PRD-1'), prd('PRD-2')],
    stageSessions: [stage('staged', { tickets: ['PRD-1'], current: { skill: 'forest:implement', run: 'r', stage: 'build', state: 'running', at: '2026-11-01T00:00:00Z' } })],
    live: [{ sessionId: 'glance', name: 'dev-1', updatedAt: Date.parse('2026-11-09T00:00:00Z') }],
    sessionsOf: ticket => (ticket === 'PRD-1'
      ? [{ sessionId: 'glance', cwd: '/w', at: '2026-11-09T00:00:00Z', weight: 1 }, { sessionId: 'built', cwd: '/w', at: '2026-11-02T00:00:00Z', weight: 8 }]
      : [{ sessionId: 'only', cwd: '/w', at: '2026-11-02T00:00:00Z', weight: 3 }]),
    cwdOf: () => '/w',
  });
  assert.deepEqual(built.sessions.map(session => [session.sessionId, session.weight, session.main]),
    [['staged', 10, true], ['built', 8, false], ['glance', 1, false]]);
  assert.deepEqual(lone.sessions.map(session => [session.sessionId, session.main]), [['only', false]]);

  const [tie] = buildPrds({
    prds: [prd('PRD-1')],
    sessionsOf: () => [{ sessionId: 'a', cwd: '/w', at: '2026-11-02T00:00:00Z', weight: 3 }, { sessionId: 'b', cwd: '/w', at: '2026-11-01T00:00:00Z', weight: 3 }],
    cwdOf: () => '/w',
  });
  assert.ok(tie.sessions.every(session => !session.main), 'a tie names no main session');
});

test('a starred session becomes the main one and comes first; a star on a session gone is ignored', () => {
  const sessions = [{ sessionId: 'a', main: true }, { sessionId: 'b', main: false }, { sessionId: 'c', main: false }];
  assert.deepEqual(withMain(sessions, 'c', 'c').map(session => [session.sessionId, session.main]), [['c', true], ['a', false], ['b', false]]);
  assert.equal(withMain(sessions, 'gone', 'gone'), sessions);
  assert.equal(withMain(sessions, undefined, undefined), sessions);
  // Starred since the last refresh: marked main where it stands, moved first only on the next one.
  assert.deepEqual(withMain(sessions, 'c', undefined).map(session => [session.sessionId, session.main]), [['a', false], ['b', false], ['c', true]]);
  assert.deepEqual(withMain(sessions, 'c', 'b').map(session => [session.sessionId, session.main]), [['b', false], ['a', false], ['c', true]]);
});

test('the tickets to ask Linear for come from the stages, directly or through a board PR', () => {
  const tickets = extraTickets(
    [stage('a', { tickets: ['PRD-5'], prUrls: [PR7] }), stage('b', { prUrls: [PR8] })],
    [{ url: PR7, ticket: 'PRD-6' }, { url: PR8, ticket: null }],
  );
  assert.deepEqual(tickets, ['PRD-5', 'PRD-6']);
});

const session = (skill, state) => ({ skill, state });

test('grouped by running skill, a PRD sits in each skill its sessions run, and one with none last', () => {
  const prds = [
    prd('PRD-1', { sessions: [session('validator', 'running'), session('review-loop', 'running')] }),
    prd('PRD-2', { sessions: [session('implement', 'waiting'), session('adr', 'done')] }),
    prd('PRD-3', { sessions: [session('adr', 'done')] }),
  ];
  assert.deepEqual(runningSkills(prds[1]), ['implement']);
  assert.deepEqual(group(prds, { by: 'skill' }).map(entry => [entry.key, entry.prds.map(p => p.ticket)]), [
    ['implement', ['PRD-2']],
    ['review-loop', ['PRD-1']],
    ['validator', ['PRD-1']],
    [null, ['PRD-3']],
  ]);
});

test('statuses follow Linear\'s own order, labels and projects their names', () => {
  const prds = [
    prd('PRD-1', { status: { name: 'In Review', position: 3 }, labels: [{ name: 'Front' }, { name: 'Back' }], project: 'Zeta' }),
    prd('PRD-2', { status: { name: 'In Progress', position: 2 }, project: 'Alpha' }),
  ];
  assert.deepEqual(group(prds, { by: 'status' }).map(entry => entry.key), ['In Progress', 'In Review']);
  assert.deepEqual(group(prds, { by: 'label' }).map(entry => [entry.key, entry.prds.length]), [['Back', 1], ['Front', 1], [null, 1]]);
  assert.deepEqual(group(prds, { by: 'project' }).map(entry => entry.key), ['Alpha', 'Zeta']);
  assert.deepEqual(group(prds, { by: 'none' }).map(entry => entry.prds.length), [2]);
});

test('ordered by last update or opening, newest first, or by title A to Z', () => {
  const prds = [
    prd('PRD-1', { title: 'beta', createdAt: '2026-11-03T00:00:00Z', updatedAt: '2026-11-04T00:00:00Z' }),
    prd('PRD-2', { title: 'Alpha', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-09T00:00:00Z' }),
  ];
  assert.deepEqual(sortPrds(prds, 'updated').map(p => p.ticket), ['PRD-2', 'PRD-1']);
  assert.deepEqual(sortPrds(prds, 'opened').map(p => p.ticket), ['PRD-1', 'PRD-2']);
  assert.deepEqual(sortPrds(prds, 'title').map(p => p.ticket), ['PRD-2', 'PRD-1']);
});
