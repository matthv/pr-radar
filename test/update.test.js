'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { summarize } = require('../update');

const raw = (count, log) => ({ current: 'abc1234\n', latest: 'f00dbabe0123\n', count, log });

test('summarize reads a clone that is up to date', () => {
  assert.deepEqual(summarize(raw('0\n', '')), {
    behind: 0,
    current: 'abc1234',
    latest: 'f00dbabe0123',
    titles: [],
  });
});

test('summarize lists the commits a clone is behind by, one title per line', () => {
  const log = 'fix: read Slack from the repo folder\n\nfeat: link each card to its Slack message\n  docs: tidy\n';
  assert.deepEqual(summarize(raw('3\n', log)), {
    behind: 3,
    current: 'abc1234',
    latest: 'f00dbabe0123',
    titles: [
      'fix: read Slack from the repo folder',
      'feat: link each card to its Slack message',
      'docs: tidy',
    ],
  });
});

test('summarize survives a count with no log, and an unreadable count', () => {
  assert.equal(summarize(raw('2', undefined)).behind, 2);
  assert.deepEqual(summarize(raw('2', undefined)).titles, []);
  assert.equal(summarize(raw('not a number', '')).behind, 0);
});
