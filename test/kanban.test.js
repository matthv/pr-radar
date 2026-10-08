'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { DEFAULTS } = require('../public/order');
const { readFolds, layout, unfold } = require('../public/kanban');

const pr = (id, bucket) => ({ id, bucket });
const lanes = () => [
  { side: 'mine', buckets: DEFAULTS.mine, prs: [pr('m1', 'action'), pr('m2', 'ready'), pr('m3', 'idle')] },
  { side: 'reviews', buckets: DEFAULTS.reviews, prs: [pr('r1', 'action'), pr('r2', 'waiting')] },
];

test('kanban: nothing stored folds the quiet column', () => {
  assert.deepEqual(readFolds(null), ['idle']);
  for (const raw of ['{broken', '{}', '"idle"', 'null']) assert.deepEqual(readFolds(raw), ['idle'], raw);
});

test('kanban: stored folds are kept, even none', () => {
  assert.deepEqual(readFolds('[]'), []);
  assert.deepEqual(readFolds('["merged", 3, "lane:reviews"]'), ['merged', 'lane:reviews']);
});

test('kanban: both lanes share the axis, in its order', () => {
  const axis = ['waiting', 'action', 'ready', 'merged', 'idle'];
  const { columns, lanes: shown } = layout({ axis, lanes: lanes() });
  assert.deepEqual(columns.map(column => column.bucket), axis);
  for (const lane of shown) assert.deepEqual(lane.cells.map(cell => cell.bucket), axis);
  assert.deepEqual(shown[0].cells[1].prs.map(entry => entry.id), ['m1']);
  assert.deepEqual(shown[1].cells[0].prs.map(entry => entry.id), ['r2']);
});

test('kanban: a bucket a side never produces keeps an inapplicable cell', () => {
  const { lanes: shown } = layout({ axis: DEFAULTS.mine, lanes: lanes() });
  const ready = shown[1].cells.find(cell => cell.bucket === 'ready');
  assert.equal(ready.applicable, false);
  assert.deepEqual(ready.prs, []);
  assert.ok(shown[0].cells.every(cell => cell.applicable));
});

test('kanban: a column counts across the lanes shown', () => {
  const { columns } = layout({ axis: DEFAULTS.mine, lanes: lanes() });
  assert.equal(columns.find(column => column.bucket === 'action').count, 2);
  assert.equal(columns.find(column => column.bucket === 'merged').count, 0);
});

test('kanban: a focused counter keeps its lane and dims the other columns', () => {
  const { columns, lanes: shown } = layout({ axis: DEFAULTS.mine, lanes: lanes(), focus: { column: 'reviews', bucket: 'waiting' } });
  assert.deepEqual(shown.map(lane => lane.side), ['reviews']);
  assert.deepEqual(columns.filter(column => !column.dimmed).map(column => column.bucket), ['waiting']);
  assert.equal(columns.find(column => column.bucket === 'action').count, 1);
});

test('kanban: folded columns and lanes are flagged, not dropped', () => {
  const { columns, lanes: shown } = layout({ axis: DEFAULTS.mine, lanes: lanes(), folds: ['idle', 'ready', 'lane:mine'] });
  assert.equal(columns.length, 5);
  assert.deepEqual(columns.filter(column => column.folded).map(column => column.bucket), ['ready', 'idle']);
  assert.deepEqual(shown.map(lane => lane.folded), [true, false]);
  assert.deepEqual(shown[0].cells.at(-1).prs.map(entry => entry.id), ['m3']);
  assert.equal(shown[1].cells.find(cell => cell.bucket === 'ready').applicable, false);
});

test('kanban: a card landing unfolds its column and its lane', () => {
  const folds = new Set(['idle', 'action', 'lane:reviews', 'lane:mine']);
  assert.equal(unfold(folds, ['reviews:action']), true);
  assert.deepEqual([...folds], ['idle', 'lane:mine']);
  assert.equal(unfold(folds, ['reviews:waiting']), false);
});
