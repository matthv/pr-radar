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

const { ticketKey, workKey, clusterForDigest, promptFor } = require('../digest');

const pr = (number, title, extra = {}) => ({
  number, title, repo: 'ForestAdmin/forestadmin', body: '', files: [], headRefName: null, ...extra,
});

test('ticketKey reads the ticket from the title, then the branch, then the body', () => {
  assert.equal(ticketKey(pr(1, 'fix(permissions): reload users [PRD-1404]')), 'PRD-1404');
  assert.equal(ticketKey(pr(1, 'feat: PRD-1271 associate a workflow')), 'PRD-1271');
  assert.equal(ticketKey(pr(1, 'feat: x', { headRefName: 'feature/prd-1184-frontend-inbox' })), 'PRD-1184');
  assert.equal(ticketKey(pr(1, 'feat: x', { body: 'Closes PRD-1309.' })), 'PRD-1309');
  assert.equal(ticketKey(pr(1, 'feat: x')), null);
});

test('workKey: the same title across repos is the same piece of work, prefix aside', () => {
  const front = pr(9977, 'feat(inbox): associate a workflow to an inbox without automation');
  const back = pr(8522, 'feat(server): associate a workflow to an inbox without automation', { repo: 'ForestAdmin/forestadmin-server' });
  assert.equal(workKey(front), workKey(back));
  assert.equal(workKey(pr(1, 'feat: x [PRD-12]')), 'ticket:PRD-12', 'a ticket wins over the title');
  assert.equal(workKey(pr(1, 'fix: encode as UTF-8')), 'title:encode as utf-8', 'UTF-8 is not a ticket');
});

test('clusterForDigest groups the two halves of a change, in first-appearance order', () => {
  const clusters = clusterForDigest([
    pr(9977, 'feat(inbox): associate a workflow to an inbox without automation'),
    pr(8534, 'fix(inbox): empty the runs-as of automated inboxes'),
    pr(8522, 'feat(inbox): associate a workflow to an inbox without automation', { repo: 'ForestAdmin/forestadmin-server' }),
  ]);
  assert.deepEqual(clusters.map(c => c.prs.map(p => p.number)), [[9977, 8522], [8534]]);
});

test('promptFor wraps a piece of work, leaves a lone PR bare, and never merges across groups', () => {
  const shared = 'feat: same change [PRD-1271]';
  const prompt = promptFor({ mine: [pr(9977, shared), pr(8522, shared)], reviews: [pr(9990, shared)] }, 'en');
  assert.match(prompt, /<group name="MINE">\n<work key="PRD-1271">/);
  const reviews = prompt.split('<group name="REVIEWS">')[1];
  assert.doesNotMatch(reviews, /<work/, 'one PR with the same ticket on the review side stays bare');
  assert.match(reviews, /<pull-request number="9990"/);
});
