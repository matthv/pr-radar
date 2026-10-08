'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { snapshotOf, changesSince } = require('../public/since');

const ME = 'matthv';
const thread = (id, lastAuthor, lastAt, extra = {}) => ({
  id, lastAuthor, lastAt, commentCount: 1, fromBot: false, lastByMe: lastAuthor === ME, ...extra,
});
const review = (author, state, submittedAt) => ({ author, state, submittedAt });

function pr(extra = {}) {
  return {
    threads: [], reviews: [], lastCommitAt: '2026-10-05T08:00:00Z', headCommitAuthor: ME,
    ciState: 'SUCCESS', mergeable: 'MERGEABLE', merged: false, pipelineOutcome: 'none', release: null,
    ...extra,
  };
}

const kinds = changes => changes.map(change => change.kind);
// The moment of each change is checked on its own below; the other tests compare the rest.
const plain = changes => changes.map(({ at, ...rest }) => rest);

test('since: no photo yet is a first sight, and an unchanged card says nothing', () => {
  const card = pr({ threads: [thread('T1', 'Scra3', '2026-10-05T08:00:00Z')] });
  assert.deepEqual(changesSince(null, card, ME), []);
  assert.deepEqual(changesSince(snapshotOf(card), card, ME), []);
});

test('since: a comment from someone else is news; mine and a bot\'s are not', () => {
  const before = pr({ threads: [thread('T1', 'Scra3', '2026-10-05T08:00:00Z')] });
  const photo = snapshotOf(before);

  const answered = pr({ threads: [thread('T1', 'Scra3', '2026-10-05T09:00:00Z', { commentCount: 2 })] });
  assert.deepEqual(plain(changesSince(photo, answered, ME)), [{ kind: 'commented', who: ['Scra3'] }]);

  const mine = pr({ threads: [thread('T1', ME, '2026-10-05T09:00:00Z', { commentCount: 2 })] });
  assert.deepEqual(changesSince(photo, mine, ME), []);

  const bot = pr({ threads: [...before.threads, thread('T2', 'macroscopeapp', '2026-10-05T09:00:00Z', { fromBot: true })] });
  assert.deepEqual(changesSince(photo, bot, ME), []);
});

test('since: several people commenting are said once, together', () => {
  const photo = snapshotOf(pr());
  const card = pr({ threads: [thread('T1', 'Scra3', '2026-10-05T09:00:00Z'), thread('T2', 'christophebrun-forest', '2026-10-05T09:05:00Z')] });
  assert.deepEqual(plain(changesSince(photo, card, ME)), [{ kind: 'commented', who: ['Scra3', 'christophebrun-forest'] }]);
});

test('since: an approval and a change request are named; mine and a bot\'s are not', () => {
  const photo = snapshotOf(pr());
  const card = pr({
    reviews: [
      review('Scra3', 'APPROVED', '2026-10-05T09:00:00Z'),
      review('christophebrun-forest', 'CHANGES_REQUESTED', '2026-10-05T09:01:00Z'),
      review(ME, 'APPROVED', '2026-10-05T09:02:00Z'),
      review('dependabot[bot]', 'APPROVED', '2026-10-05T09:03:00Z'),
    ],
    // The change request's body also lands in the conversation thread.
    threads: [thread('discussion:PR', 'christophebrun-forest', '2026-10-05T09:01:00Z')],
  });
  assert.deepEqual(plain(changesSince(photo, card, ME)), [
    { kind: 'changesRequested', who: ['christophebrun-forest'] },
    { kind: 'approved', who: ['Scra3'] },
  ]);
});

test('since: a change request is not news once its reviewer is asked again', () => {
  const photo = snapshotOf(pr());
  const card = pr({
    reviews: [
      review('Scra3', 'CHANGES_REQUESTED', '2026-10-05T09:00:00Z'),
      review('christophebrun-forest', 'CHANGES_REQUESTED', '2026-10-05T09:01:00Z'),
    ],
    threads: [thread('discussion:PR', 'Scra3', '2026-10-05T09:00:00Z')],
    requestedReviewers: ['Scra3'],
    side: 'mine',
  });
  assert.deepEqual(plain(changesSince(photo, card, ME)), [{ kind: 'changesRequested', who: ['christophebrun-forest'] }]);
});

test('since: on a PR I review, a change request stays news when its reviewer is asked again', () => {
  const photo = snapshotOf(pr());
  const card = pr({
    reviews: [review('Scra3', 'CHANGES_REQUESTED', '2026-10-05T09:00:00Z')],
    requestedReviewers: ['Scra3'],
    side: 'review',
  });
  assert.deepEqual(plain(changesSince(photo, card, ME)), [{ kind: 'changesRequested', who: ['Scra3'] }]);
});

test('since: a reviewer asked again who comments afterwards is news', () => {
  const photo = snapshotOf(pr());
  const card = pr({
    reviews: [review('Scra3', 'CHANGES_REQUESTED', '2026-10-05T09:00:00Z')],
    threads: [thread('discussion:PR', 'Scra3', '2026-10-05T10:00:00Z')],
    requestedReviewers: ['Scra3'],
    side: 'mine',
  });
  assert.deepEqual(changesSince(photo, card, ME), [{ kind: 'commented', who: ['Scra3'], at: '2026-10-05T10:00:00Z' }]);
});

test('since: commits pushed by someone else are news, mine are not', () => {
  const photo = snapshotOf(pr());
  assert.deepEqual(plain(changesSince(photo, pr({ lastCommitAt: '2026-10-05T09:00:00Z', headCommitAuthor: 'Scra3' }), ME)), [{ kind: 'pushed', who: ['Scra3'] }]);
  assert.deepEqual(changesSince(photo, pr({ lastCommitAt: '2026-10-05T09:00:00Z' }), ME), []);
});

test('since: the CI is news when it reaches an outcome, not when it starts again', () => {
  const green = snapshotOf(pr());
  assert.deepEqual(kinds(changesSince(green, pr({ ciState: 'FAILURE' }), ME)), ['ciFailed']);
  assert.deepEqual(kinds(changesSince(green, pr({ ciState: 'PENDING' }), ME)), []);
  assert.deepEqual(kinds(changesSince(snapshotOf(pr({ ciState: 'PENDING' })), pr(), ME)), ['ciPassed']);
  assert.deepEqual(kinds(changesSince(snapshotOf(pr({ ciState: null })), pr({ ciState: 'FAILURE' }), ME)), [], 'no readable state before');
});

test('since: a conflict, a merge, a release published or failed', () => {
  const photo = snapshotOf(pr());
  assert.deepEqual(kinds(changesSince(photo, pr({ mergeable: 'CONFLICTING' }), ME)), ['conflict']);
  assert.deepEqual(kinds(changesSince(photo, pr({ merged: true, pipelineOutcome: 'running' }), ME)), ['merged']);

  const merged = snapshotOf(pr({ merged: true, pipelineOutcome: 'running' }));
  assert.deepEqual(plain(changesSince(merged, pr({ merged: true, pipelineOutcome: 'done', release: { tag: 'v1.5.0' } }), ME)), [{ kind: 'released', tag: 'v1.5.0' }]);
  assert.deepEqual(kinds(changesSince(merged, pr({ merged: true, pipelineOutcome: 'failed' }), ME)), ['releaseFailed']);
  assert.deepEqual(kinds(changesSince(merged, pr({ merged: true, pipelineOutcome: 'running', ciState: 'FAILURE' }), ME)), [], 'a merged PR\'s head CI is history');
});

test('since: what asks for something comes first', () => {
  const photo = snapshotOf(pr());
  const card = pr({
    ciState: 'FAILURE', lastCommitAt: '2026-10-05T09:00:00Z', headCommitAuthor: 'Scra3',
    threads: [thread('T1', 'Scra3', '2026-10-05T09:00:00Z')],
  });
  assert.deepEqual(kinds(changesSince(photo, card, ME)), ['ciFailed', 'commented', 'pushed']);
});

test('since: each change carries its latest moment, when the data has one', () => {
  const photo = snapshotOf(pr({ ciState: 'SUCCESS' }));
  const card = pr({
    ciState: 'FAILURE', lastCommitAt: '2026-10-05T09:10:00Z', headCommitAuthor: 'Scra3',
    threads: [thread('T1', 'Scra3', '2026-10-05T09:00:00Z'), thread('T2', 'christophebrun-forest', '2026-10-05T09:20:00Z')],
    reviews: [review('christophebrun-forest', 'APPROVED', '2026-10-05T09:30:00Z')],
  });
  const byKind = Object.fromEntries(changesSince(photo, card, ME).map(change => [change.kind, change.at]));
  assert.deepEqual(byKind, {
    ciFailed: null,
    commented: '2026-10-05T09:20:00Z',
    approved: '2026-10-05T09:30:00Z',
    pushed: '2026-10-05T09:10:00Z',
  });
});
