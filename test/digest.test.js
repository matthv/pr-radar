'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { pickForDigest } = require('../digest');

function board() {
  return {
    mine: [
      { id: 'M1', repo: 'o/r', number: 1, lastActivityAt: '2026-01-01T00:00:00Z', bucket: 'action' },
      { id: 'M2', repo: 'o/r', number: 2, lastActivityAt: '2026-01-02T00:00:00Z', bucket: 'idle' },
    ],
    reviews: [
      { id: 'R1', repo: 'o/r', number: 3, lastActivityAt: '2026-01-03T00:00:00Z', bucket: 'waiting' },
    ],
  };
}

test('pickForDigest keeps only the requested ids, in the order given', () => {
  const shaped = pickForDigest(board(), { mine: ['M2', 'M1'], reviews: [] });

  assert.deepEqual(
    shaped.mine.map(pr => pr.number),
    [2, 1],
  );
});

test('pickForDigest ignores an id the board does not know', () => {
  const shaped = pickForDigest(board(), { mine: ['M1', 'ghost'], reviews: [] });

  assert.equal(shaped.mine.length, 1);
  assert.equal(shaped.mine[0].id, 'M1');
});

test('pickForDigest describes a review\'s situation from its bucket, never a mine entry\'s', () => {
  const shaped = pickForDigest(board(), { mine: ['M1'], reviews: ['R1'] });

  assert.equal(shaped.reviews[0].situation, 'the reader has given feedback and waits for the author to push a fix');
  assert.equal('situation' in shaped.mine[0], false, 'a bucket is not a situation on my own PRs');
});

test('pickForDigest defaults both sides to empty, and drops everything else off the shape', () => {
  const shaped = pickForDigest(board());

  assert.deepEqual(shaped, { mine: [], reviews: [] });
});
