'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseStatuses, snapshot, step, send, createNotifier } = require('../webhook');

const pr = (id, side, bucket, extra = {}) => ({ id, side, bucket, url: `https://github.com/o/r/pull/${id}`, repo: 'o/r', number: id, ...extra });
const ref = number => ({ url: `https://github.com/o/r/pull/${number}`, project: 'o/r', pr_number: number });
const event = (status, ...numbers) => ({ status, ...ref(numbers[0]), prs: numbers.map(ref) });
const board = (mine, reviews = [], warnings = []) => ({ mine, reviews, warnings });
const eventsBetween = (previous, current, statuses) => step(previous, current, { statuses }).events;

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
  const { next } = step(full, partial, { incomplete: true });
  assert.deepEqual(eventsBetween(next, full), []);
  assert.equal(step(full, partial).next.has(2), false, 'a complete board drops the PRs that left');
});

test('an incomplete board sends new PRs, and holds status changes until a complete one', () => {
  const before = snapshot(board([pr(1, 'mine', 'waiting')]));
  const partial = snapshot(board([pr(1, 'mine', 'action'), pr(2, 'reviews', 'action')]));
  const held = step(before, partial, { incomplete: true });
  assert.deepEqual(held.events, [event('reviews.action', 2)]);
  assert.deepEqual(eventsBetween(held.next, partial), [event('mine.action', 1)]);
});

const notifierOn = posted => createNotifier({ url: 'u', post: (_, events) => posted.push(...events) });
const searchFailed = { source: 'review-requested', message: 'boom' };

test('only a complete board becomes the first picture', () => {
  const posted = [];
  const notifier = notifierOn(posted);
  notifier.notify(board([pr(1, 'mine', 'action')], [], [searchFailed]));
  notifier.notify(board([pr(1, 'mine', 'action'), pr(2, 'mine', 'action')]));
  notifier.notify(board([pr(1, 'mine', 'action'), pr(2, 'mine', 'action'), pr(3, 'mine', 'action')]));
  assert.deepEqual(posted, [event('mine.action', 3)]);
});

test('only the sources that lose PRs make a board incomplete', () => {
  const posted = [];
  const notifier = notifierOn(posted);
  notifier.notify(board([pr(1, 'mine', 'waiting'), pr(2, 'mine', 'waiting')]));
  const truncated = { source: 'o/r#1', message: 'page GraphQL pleine' };
  notifier.notify(board([pr(1, 'mine', 'action')], [], [truncated]));
  notifier.notify(board([pr(1, 'mine', 'action'), pr(2, 'mine', 'waiting')], [], [truncated]));
  assert.deepEqual(posted, [event('mine.action', 1), event('mine.waiting', 2)], 'PR 2 left, then came back as new');
});

test('a PR with an unknown mergeability keeps its last status until GitHub knows', () => {
  const posted = [];
  const notifier = notifierOn(posted);
  notifier.notify(board([pr(1, 'mine', 'waiting')]));
  notifier.notify(board([pr(1, 'mine', 'ready', { mergeable: 'UNKNOWN' }), pr(2, 'mine', 'ready', { mergeable: 'UNKNOWN' })]));
  assert.deepEqual(posted, []);
  notifier.notify(board([pr(1, 'mine', 'action', { mergeable: 'CONFLICTING' }), pr(2, 'mine', 'ready', { mergeable: 'MERGEABLE' })]));
  assert.deepEqual(posted, [event('mine.action', 1), event('mine.ready', 2)]);
});

test('an unknown mergeability in the first picture is corrected without a call', () => {
  const posted = [];
  const notifier = notifierOn(posted);
  notifier.notify(board([pr(1, 'mine', 'ready', { mergeable: 'UNKNOWN' })]));
  notifier.notify(board([pr(1, 'mine', 'action', { mergeable: 'CONFLICTING' })]));
  notifier.notify(board([pr(1, 'mine', 'action', { mergeable: 'CONFLICTING' })]));
  assert.deepEqual(posted, []);
});

test('send posts one JSON body per event', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body), method: options.method, type: options.headers['Content-Type'] });
    return { ok: true };
  };
  await send('https://hook.test/x', [{ status: 'mine.action', url: 'u1' }, { status: 'reviews.action', url: 'u2' }], { fetchImpl });
  assert.deepEqual(calls, [
    { url: 'https://hook.test/x', method: 'POST', type: 'application/json', body: { status: 'mine.action', url: 'u1' } },
    { url: 'https://hook.test/x', method: 'POST', type: 'application/json', body: { status: 'reviews.action', url: 'u2' } },
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

test('send logs the network cause, not only "fetch failed", and how many PRs the call held', async () => {
  const logs = [];
  const fetchImpl = async () => {
    throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND hook.test') });
  };
  await send('https://hook.test/x', [event('mine.action', 1, 2, 3)], { fetchImpl, log: line => logs.push(line) });
  assert.match(logs[0], /mine\.action https:\/\/github\.com\/o\/r\/pull\/1 \(\+2 PR\): fetch failed \(getaddrinfo ENOTFOUND hook\.test\)/);
});

test('send releases the response body', async () => {
  let cancelled = false;
  const body = { cancel: async () => { cancelled = true; } };
  await send('https://hook.test/x', [event('mine.action', 1)], { fetchImpl: async () => ({ ok: true, body }) });
  assert.equal(cancelled, true);
});
