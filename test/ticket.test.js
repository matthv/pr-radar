'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ticketKey, withTwins, boardTwins } = require('../ticket');

const card = (number, title, extra = {}) => ({
  id: `id${number}`, repo: 'o/r', number, title, side: 'review', url: `u${number}`, ticket: null, slackUrl: null, ...extra,
});
const twinsOf = cards => Object.fromEntries(withTwins(cards).map(c => [c.number, c.twins.map(t => t.number)]));

test('twins: the same ticket links PRs across both sides', () => {
  const cards = [card(1, 'feat: front', { ticket: 'PRD-1', side: 'mine' }), card(2, 'feat: back', { ticket: 'PRD-1' }), card(3, 'fix: other')];
  assert.deepEqual(twinsOf(cards), { 1: [2], 2: [1], 3: [] });
});

test('twins: the same title once its prefix is gone', () => {
  assert.deepEqual(twinsOf([card(1, 'feat(front): Pause an inbox'), card(2, 'feat(server): pause an inbox')]), { 1: [2], 2: [1] });
});

test('twins: one Slack announcement for two unrelated titles', () => {
  const slackUrl = 'https://slack/archives/C/p1';
  assert.deepEqual(twinsOf([card(1, 'feat: server side', { slackUrl }), card(2, 'feat: the front', { slackUrl })]), { 1: [2], 2: [1] });
});

test('twins: signals chain, a ticket to one, an announcement to the next', () => {
  const slackUrl = 'https://slack/archives/C/p2';
  const cards = [card(1, 'a', { ticket: 'PRD-9' }), card(2, 'b', { ticket: 'PRD-9', slackUrl }), card(3, 'c', { slackUrl })];
  assert.deepEqual(twinsOf(cards), { 1: [2, 3], 2: [1, 3], 3: [1, 2] }, 'board order kept, never itself');
});

test('twins: no title and no other signal links nothing', () => {
  assert.deepEqual(twinsOf([card(1, ''), card(2, '')]), { 1: [], 2: [] });
  assert.deepEqual(twinsOf([card(1, 'feat: '), card(2, 'feat:   ')]), { 1: [], 2: [] });
});

test('twins: a short or a bot title links nothing, the same everywhere for another reason', () => {
  assert.deepEqual(twinsOf([card(1, 'fix: typo'), card(2, 'docs: typo')]), { 1: [], 2: [] });
  const bump = 'chore(deps): bump express from 4.18.2 to 4.19.2';
  assert.deepEqual(twinsOf([card(1, bump, { authorIsBot: true }), card(2, bump, { authorIsBot: true })]), { 1: [], 2: [] });
});

test('twins: a ticketless half finds its ticketed twin by title, two tickets keep apart', () => {
  assert.deepEqual(twinsOf([card(1, 'feat(front): pause an inbox', { ticket: 'PRD-1' }), card(2, 'feat(server): pause an inbox')]), { 1: [2], 2: [1] });
  assert.deepEqual(twinsOf([card(1, 'test: cover the edge cases', { ticket: 'PRD-1' }), card(2, 'test: cover the edge cases', { ticket: 'PRD-2' })]), { 1: [], 2: [] });
});

test('twins: an announcement listing more than three PRs is a list, not one change', () => {
  const slackUrl = 'https://slack/archives/C/p3';
  const cards = [1, 2, 3, 4].map(n => card(n, `feat: thing ${n}`, { slackUrl }));
  assert.deepEqual(twinsOf(cards), { 1: [], 2: [], 3: [], 4: [] });
});

test('ticketKey: a CVE, a hash or a bot branch is not a ticket', () => {
  assert.equal(ticketKey({ title: 'fix(deps): patch CVE-2024-1111' }), null);
  assert.equal(ticketKey({ title: 'fix: CVE-2024-1111 for PRD-12' }), 'PRD-12', 'the first real ticket wins');
  assert.equal(ticketKey({ title: 'feat: sign with SHA-256 and UTF-16' }), null);
  assert.equal(ticketKey({ title: 'chore: update node', headRefName: 'renovate/node-20' }), null);
  assert.equal(ticketKey({ title: 'feat: x', headRefName: 'feature/prd-1184-inbox' }), 'PRD-1184');
});

test('boardTwins: across both sides, each card back on its own side', () => {
  const out = boardTwins({ mine: [card(1, 'feat: a', { ticket: 'PRD-1', side: 'mine' })], reviews: [card(2, 'feat: b', { ticket: 'PRD-1' })], warnings: [] });
  assert.deepEqual([out.mine.map(c => c.number), out.reviews.map(c => c.number)], [[1], [2]]);
  assert.deepEqual([out.mine[0].twins[0].number, out.reviews[0].twins[0].number], [2, 1]);
  assert.deepEqual(out.warnings, []);
});

test('twins: a twin carries what the page needs to name it and go there', () => {
  const [first] = withTwins([card(1, 'x', { ticket: 'PRD-3' }), card(2, 'y', { ticket: 'PRD-3', side: 'mine' })]);
  assert.deepEqual(first.twins, [{ id: 'id2', repo: 'o/r', number: 2, title: 'y', side: 'mine', url: 'u2' }]);
});
