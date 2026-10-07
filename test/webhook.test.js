'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseStatuses, snapshot, nextSnapshot, eventsBetween, send, createNotifier } = require('../webhook');

const pr = (id, side, bucket, extra = {}) => ({ id, side, bucket, url: `https://github.com/o/r/pull/${id}`, repo: 'o/r', number: id, ...extra });
const ref = number => ({ url: `https://github.com/o/r/pull/${number}`, project: 'o/r', pr_number: number });
const event = (status, ...numbers) => ({ status, ...ref(numbers[0]), prs: numbers.map(ref) });
const board = (mine, reviews = [], warnings = []) => ({ mine, reviews, warnings });

test('statuses: a comma list, blanks ignored, empty means every status', () => {
  assert.deepEqual(parseStatuses(' mine.action, ,reviews.action '), ['mine.action', 'reviews.action']);
  assert.deepEqual(parseStatuses(undefined), []);
  assert.deepEqual(parseStatuses(''), []);
});

test('statuses: an unknown one is refused up front', () => {
  assert.throws(() => parseStatuses('mine.action,reviews.ready'), /unknown status reviews\.ready/);
  assert.throws(() => parseStatuses('action'), /unknown status action/);
});

test('the first board after startup sends nothing', () => {
  assert.deepEqual(eventsBetween(null, snapshot(board([pr(1, 'mine', 'action')]))), []);
});

test('a PR changing status sends its new status and url', () => {
  const before = snapshot(board([pr(1, 'mine', 'waiting')]));
  const after = snapshot(board([pr(1, 'mine', 'action')]));
  assert.deepEqual(eventsBetween(before, after), [event('mine.action', 1)]);
});

test('a PR keeping its status sends nothing', () => {
  const before = snapshot(board([pr(1, 'mine', 'action')]));
  assert.deepEqual(eventsBetween(before, snapshot(board([pr(1, 'mine', 'action')]))), []);
});

test('a PR new on the board sends its status', () => {
  const before = snapshot(board([]));
  const after = snapshot(board([], [pr(2, 'reviews', 'action')]));
  assert.deepEqual(eventsBetween(before, after), [event('reviews.action', 2)]);
});

test('several PRs moving to one status send one call: the first on top, all of them in prs', () => {
  const before = snapshot(board([pr(1, 'mine', 'waiting'), pr(2, 'mine', 'waiting')]));
  const after = snapshot(board([pr(1, 'mine', 'action'), pr(2, 'mine', 'action')]));
  assert.deepEqual(eventsBetween(before, after), [event('mine.action', 1, 2)]);
});

test('different statuses send one call each', () => {
  const before = snapshot(board([pr(1, 'mine', 'waiting'), pr(2, 'mine', 'waiting')], [pr(3, 'reviews', 'idle')]));
  const after = snapshot(board([pr(1, 'mine', 'action'), pr(2, 'mine', 'ready')], [pr(3, 'reviews', 'action')]));
  assert.deepEqual(eventsBetween(before, after).map(e => e.status), ['mine.action', 'mine.ready', 'reviews.action']);
});

test('the filter keeps only the listed statuses, and the first PR is picked among those kept', () => {
  const before = snapshot(board([pr(1, 'mine', 'action'), pr(2, 'mine', 'waiting')], [pr(3, 'reviews', 'idle')]));
  const after = snapshot(board([pr(1, 'mine', 'waiting'), pr(2, 'mine', 'action')], [pr(3, 'reviews', 'action')]));
  assert.deepEqual(eventsBetween(before, after, ['mine.action']), [
    event('mine.action', 2),
  ]);
});

test('drafts are left out when the board hides them', () => {
  const before = snapshot(board([]), { hideDrafts: true });
  const after = snapshot(board([pr(1, 'mine', 'action', { isDraft: true })]), { hideDrafts: true });
  assert.deepEqual(eventsBetween(before, after), []);
});

test('an incomplete board keeps the PRs it lost, so they do not come back as new', () => {
  const full = snapshot(board([pr(1, 'mine', 'action'), pr(2, 'mine', 'waiting')]));
  const partial = snapshot(board([pr(1, 'mine', 'action')]));
  const kept = nextSnapshot(full, partial, true);
  assert.deepEqual(eventsBetween(kept, full), []);
  assert.equal(nextSnapshot(full, partial, false), partial);
});

test('send posts one JSON body per event', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body), method: options.method });
    return { ok: true };
  };
  await send('https://hook.test/x', [{ status: 'mine.action', url: 'u1' }, { status: 'reviews.action', url: 'u2' }], { fetchImpl });
  assert.deepEqual(calls, [
    { url: 'https://hook.test/x', method: 'POST', body: { status: 'mine.action', url: 'u1' } },
    { url: 'https://hook.test/x', method: 'POST', body: { status: 'reviews.action', url: 'u2' } },
  ]);
});

test('send logs a failure instead of throwing', async () => {
  const logs = [];
  const fetchImpl = async () => {
    throw new Error('ECONNREFUSED');
  };
  await send('https://hook.test/x', [{ status: 'mine.action', url: 'u1' }], { fetchImpl, log: line => logs.push(line) });
  await send('https://hook.test/x', [{ status: 'mine.ready', url: 'u2' }], { fetchImpl: async () => ({ ok: false, status: 500 }), log: line => logs.push(line) });
  assert.equal(logs.length, 2);
  assert.match(logs[0], /mine\.action u1: ECONNREFUSED/);
  assert.match(logs[1], /mine\.ready u2: HTTP 500/);
});

test('the notifier posts what changed between two boards, and nothing on the first', () => {
  const posted = [];
  const notifier = createNotifier({ url: 'https://hook.test/x', post: (url, events) => posted.push({ url, events }) });
  assert.deepEqual(notifier.notify(board([pr(1, 'mine', 'waiting')])), []);
  notifier.notify(board([pr(1, 'mine', 'action'), pr(2, 'mine', 'action')], [pr(3, 'reviews', 'action')]));
  notifier.notify(board([pr(1, 'mine', 'action'), pr(2, 'mine', 'action')], [pr(3, 'reviews', 'action')]));
  assert.deepEqual(posted, [
    { url: 'https://hook.test/x', events: [event('mine.action', 1, 2), event('reviews.action', 3)] },
  ]);
});

test('the notifier applies the status filter and hidden drafts', () => {
  const posted = [];
  const notifier = createNotifier({ url: 'u', statuses: ['mine.action'], hideDrafts: true, post: (_, events) => posted.push(...events) });
  notifier.notify(board([]));
  notifier.notify(board([pr(1, 'mine', 'action', { isDraft: true }), pr(2, 'mine', 'ready'), pr(3, 'mine', 'action')]));
  assert.deepEqual(posted, [event('mine.action', 3)]);
});
