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

test('twins: a ticketless card sharing their title does not bridge two tickets', () => {
  const title = 'feat: add the export button';
  const cards = [card(1, title, { ticket: 'PRD-1' }), card(2, title), card(3, title, { ticket: 'PRD-2' })];
  const twins = twinsOf(cards);
  assert.equal(twins[1].includes(3) || twins[3].includes(1), false);
});

test('twins: one announcement links two tickets, only the title needs them to agree', () => {
  const slackUrl = 'https://slack/archives/C/p5';
  assert.deepEqual(twinsOf([card(1, 'a', { ticket: 'PRD-1', slackUrl }), card(2, 'b', { ticket: 'PRD-2', slackUrl })]), { 1: [2], 2: [1] });
});

test('twins: a breaking-change prefix is stripped like any other', () => {
  assert.deepEqual(twinsOf([card(1, 'feat(api)!: drop the legacy route'), card(2, 'feat: drop the legacy route')]), { 1: [2], 2: [1] });
});

test('twins: an announcement listing more than three PRs is a list, not one change', () => {
  const slackUrl = 'https://slack/archives/C/p3';
  const cards = [1, 2, 3, 4].map(n => card(n, `feat: thing ${n}`, { slackUrl }));
  assert.deepEqual(twinsOf(cards), { 1: [], 2: [], 3: [], 4: [] });
  assert.deepEqual(twinsOf(cards.slice(0, 3)), { 1: [2, 3], 2: [1, 3], 3: [1, 2] }, 'three are still one change');
});

test('ticketKey: a CVE, a hash or a bot branch is not a ticket', () => {
  assert.equal(ticketKey({ title: 'fix(deps): patch CVE-2024-1111' }), null);
  assert.equal(ticketKey({ title: 'fix: CVE-2024-1111 for PRD-12' }), 'PRD-12', 'the first real ticket wins');
  assert.equal(ticketKey({ title: 'feat: sign with SHA-256 and UTF-16' }), null);
  assert.equal(ticketKey({ title: 'fix: escape CWE-79 output, bump GO-2024-1234, AES-256 keys' }), null);
  assert.equal(ticketKey({ title: 'fix: SNYK-JS-LODASH-1040724' }), null, 'the tail of a longer id');
  assert.equal(ticketKey({ title: 'chore(deps): update react', headRefName: 'renovate/react-18' }), null, 'a bot branch');
  assert.equal(ticketKey({ title: 'feat: x', headRefName: 'fix/cve-2024-1111' }), null);
  assert.equal(ticketKey({ title: 'feat: x', headRefName: 'es-2024/prd-123-fix' }), 'PRD-123', 'past a segment that is no ticket');
  assert.equal(ticketKey({ title: 'feat: x', headRefName: 'feature/prd-1184-inbox' }), 'PRD-1184');
  assert.equal(ticketKey({ title: 'chore(deps): bump x', body: 'Fixes ABC-123 upstream', authorIsBot: true }), null, "a bot's release notes");
  assert.equal(ticketKey({ title: 'feat: x', body: 'Part of PRD-77' }), 'PRD-77');
});

test('boardTwins: across both sides, each card back on its own side', () => {
  const out = boardTwins({ mine: [card(1, 'feat: a', { ticket: 'PRD-1', side: 'mine' })], reviews: [card(2, 'feat: b', { ticket: 'PRD-1' })], warnings: [] });
  assert.deepEqual([out.mine.map(c => c.number), out.reviews.map(c => c.number)], [[1], [2]]);
  assert.deepEqual([out.mine[0].twins[0].number, out.reviews[0].twins[0].number], [2, 1]);
  assert.deepEqual(out.warnings, []);
});

test('boardTwins: the Slack links set first, then counted as a signal', () => {
  const links = new Map([['id1', 'https://slack/p9'], ['id2', 'https://slack/p9']]);
  const out = boardTwins({ mine: [card(1, 'feat: server side', { side: 'mine' })], reviews: [card(2, 'feat: the front')] }, links);
  assert.deepEqual([out.mine[0].slackUrl, out.mine[0].twins.map(t => t.number)], ['https://slack/p9', [2]]);
  const off = boardTwins({ mine: [card(1, 'feat: server side', { side: 'mine', ticket: 'PRD-4' })], reviews: [card(2, 'feat: the front', { ticket: 'PRD-4' })] });
  assert.deepEqual(off.reviews[0].twins.map(t => t.number), [1], 'no Slack links: the ticket still finds them');
});

test('twins: a twin carries what the page needs to name it and go there', () => {
  const [first] = withTwins([card(1, 'x', { ticket: 'PRD-3' }), card(2, 'y', { ticket: 'PRD-3', side: 'mine' })]);
  assert.deepEqual(first.twins, [{ id: 'id2', repo: 'o/r', number: 2, title: 'y', side: 'mine', url: 'u2' }]);
});
