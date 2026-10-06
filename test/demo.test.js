'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const demo = require('../demo');

const kinds = prs => new Set(prs.flatMap(pr => pr.reasons.map(reason => reason.kind)));
const buckets = prs => new Set(prs.map(pr => pr.bucket));

test('demo: my side shows every group and every reason to act', () => {
  const { mine } = demo.payload(false);
  assert.deepEqual([...buckets(mine)].sort(), ['action', 'idle', 'merged', 'ready', 'waiting']);
  for (const kind of ['threads', 'changes-requested', 'ci', 'conflict', 'merge-pipeline']) {
    assert.ok(kinds(mine).has(kind), kind);
  }
  const merged = mine.filter(pr => pr.merged);
  assert.ok(merged.some(pr => pr.pipelineOutcome === 'running'));
  assert.ok(merged.some(pr => pr.release));
  assert.ok(merged.some(pr => pr.pipelineFailure?.workflow));
  assert.ok(mine.some(pr => pr.isDraft));
  assert.ok(mine.some(pr => pr.author !== 'matthv'), 'a taken-over PR');
});

test('demo: the review side shows every group and every reason to act', () => {
  const { reviews } = demo.payload(false);
  assert.deepEqual([...buckets(reviews)].sort(), ['action', 'idle', 'merged', 'waiting']);
  for (const kind of ['to-review', 'answers', 'recheck']) assert.ok(kinds(reviews).has(kind), kind);
});

test('demo: a manual refresh brings a new review in, the next one takes it back', () => {
  const before = demo.payload(false).reviews.length;
  assert.equal(demo.payload(true).reviews.length, before + 1);
  assert.equal(demo.payload(true).reviews.length, before);
});

test('demo: the standup notes cover every PR the page asks about', async () => {
  const board = demo.payload(false);
  const { text } = await demo.notes({ lang: 'fr', mine: board.mine.map(pr => pr.id), reviews: board.reviews.map(pr => pr.id) });
  for (const pr of [...board.mine, ...board.reviews]) assert.match(text, new RegExp(`#${pr.number}\\b`));
});

test('demo: its starting notes sit on cards the board shows', () => {
  const board = demo.payload(false);
  const ids = new Set([...board.mine, ...board.reviews].map(pr => pr.id));
  const noted = Object.keys(board.demoNotes);
  assert.equal(noted.length, 2);
  for (const id of noted) assert.ok(ids.has(id), id);
});

test('demo: ticket pills have a workspace to link to', () => {
  const board = demo.payload(false);
  const tickets = new Set([...board.mine, ...board.reviews].map(pr => pr.ticket).filter(Boolean));
  assert.deepEqual([...tickets].sort(), ['PRD-812', 'PRD-845']);
  assert.match(demo.LINEAR_URL, /^https:\/\/linear\.app\//);
});

test('demo: my PRs offer their Claude session, the reviews do not', () => {
  const { mine, reviews } = demo.payload(false);
  assert.ok(mine.every(pr => pr.claudeSession === true));
  assert.ok(reviews.every(pr => pr.claudeSession === false));
});

test('demo: the repos it colours are on the board', () => {
  const board = demo.payload(false);
  const repos = new Set([...board.mine, ...board.reviews].map(pr => pr.repo));
  for (const repo of Object.keys(board.demoRepoColors)) assert.ok(repos.has(repo), repo);
});
