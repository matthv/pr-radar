'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { withTwins } = require('../ticket');

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
});

test('twins: a twin carries what the page needs to name it and go there', () => {
  const [first] = withTwins([card(1, 'x', { ticket: 'PRD-3' }), card(2, 'y', { ticket: 'PRD-3', side: 'mine' })]);
  assert.deepEqual(first.twins, [{ id: 'id2', repo: 'o/r', number: 2, title: 'y', side: 'mine', url: 'u2' }]);
});
