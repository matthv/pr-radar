'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createWatcher, watched, searchEveryMs, UNWATCHED_SEARCH_MS, inFlight, toFollow, nextDiscoveryAt, parseResponse, prFromApiUrl, MIN_DISCOVERY_GAP_MS, MAX_FOLLOW_MS } = require('../watch');

const scope = { org: 'ForestAdmin', extraRepos: ['matthv/pr-radar'] };
const pr = (number, extra = {}) => ({ id: `PR_${number}`, repo: 'ForestAdmin/agent-ruby', number, url: `https://github.com/ForestAdmin/agent-ruby/pull/${number}`, ...extra });
const board = (...prs) => ({ mine: prs, reviews: [] });

// The way `gh api -i` prints: status line, headers, blank line, body.
const http = (status, headers = {}, body = '') =>
  [`HTTP/2.0 ${status} ${status === 304 ? 'Not Modified' : 'OK'}`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), '', body].join('\r\n');

// Answers by path, and records the validators each request carried.
function fakeGh(routes) {
  const calls = [];
  const exec = async args => {
    const path = args[2];
    const header = args.includes('-H') ? args[args.indexOf('-H') + 1] : null;
    calls.push({ path, header });
    const route = routes[path];
    if (!route) throw new Error(`no route for ${path}`);
    return typeof route === 'function' ? route(header) : route;
  };
  return { exec, calls };
}

const quietNotifications = header =>
  header ? http(304, { 'X-Poll-Interval': '60' }) : http(200, { 'Last-Modified': 'Mon, 05 Oct 2026 08:00:00 GMT', 'X-Poll-Interval': '60' }, '[]');

test('a card is known after its first answer, then a 304 is no change and a 200 is one', async () => {
  let version = 'W/"a"';
  const { exec, calls } = fakeGh({
    'repos/ForestAdmin/agent-ruby/pulls/398': header => (header === `If-None-Match: ${version}` ? http(304) : http(200, { ETag: version }, '{}')),
    notifications: quietNotifications,
  });
  const watcher = createWatcher({ exec, scope });
  const current = board(pr(398));

  assert.deepEqual([...(await watcher.check(current, 0)).changed], [], 'the first answer is a baseline');
  assert.deepEqual([...(await watcher.check(current, 61_000)).changed], []);
  version = 'W/"b"';
  assert.deepEqual([...(await watcher.check(current, 122_000)).changed], ['PR_398']);
  assert.equal(calls.filter(call => call.path.endsWith('/398')).at(-1).header, 'If-None-Match: W/"a"');
  assert.deepEqual([...(await watcher.check(current, 183_000)).changed], [], 'the new ETag is kept');
});

test('a card whose reload failed reads as changed on the next round', async () => {
  const { exec } = fakeGh({
    'repos/ForestAdmin/agent-ruby/pulls/398': header => (header ? http(304) : http(200, { ETag: 'W/"a"' }, '{}')),
    notifications: quietNotifications,
  });
  const watcher = createWatcher({ exec, scope });
  const current = board(pr(398));
  await watcher.check(current, 0);
  watcher.forget([pr(398)]);
  assert.deepEqual([...(await watcher.check(current, 61_000)).changed], ['PR_398']);
});

test('a notification on a PR off the board asks for a discovery; one on the board marks it changed', async () => {
  let threads = [];
  const { exec } = fakeGh({
    'repos/ForestAdmin/agent-ruby/pulls/398': header => (header ? http(304) : http(200, { ETag: 'W/"a"' }, '{}')),
    notifications: header =>
      header && !threads.length
        ? http(304)
        : http(200, { 'Last-Modified': 'Mon, 05 Oct 2026 09:00:00 GMT' }, JSON.stringify(threads)),
  });
  const watcher = createWatcher({ exec, scope });
  const current = board(pr(398));
  await watcher.check(current, 0);

  const at = '2026-10-05T09:30:00Z';
  threads = [
    { updated_at: at, subject: { type: 'PullRequest', url: 'https://api.github.com/repos/ForestAdmin/agent-ruby/pulls/398' } },
    { updated_at: at, subject: { type: 'PullRequest', url: 'https://api.github.com/repos/matthv/pr-radar/pulls/9' } },
    { updated_at: at, subject: { type: 'PullRequest', url: 'https://api.github.com/repos/someone/elsewhere/pulls/1' } },
    { updated_at: at, subject: { type: 'Issue', url: 'https://api.github.com/repos/ForestAdmin/agent-ruby/issues/5' } },
  ];
  const { changed, unknownTouched } = await watcher.check(current, 61_000);
  assert.deepEqual([...changed], ['PR_398']);
  assert.equal(unknownTouched, true);
});

test('notifications older than the last answer, or out of scope, ask for nothing', async () => {
  let threads = [];
  const { exec } = fakeGh({
    'repos/ForestAdmin/agent-ruby/pulls/398': header => (header ? http(304) : http(200, { ETag: 'W/"a"' }, '{}')),
    notifications: () => http(200, { 'Last-Modified': 'Mon, 05 Oct 2026 09:00:00 GMT' }, JSON.stringify(threads)),
  });
  const watcher = createWatcher({ exec, scope });
  await watcher.check(board(pr(398)), 0);
  threads = [
    { updated_at: '2026-10-05T08:00:00Z', subject: { type: 'PullRequest', url: 'https://api.github.com/repos/ForestAdmin/forestadmin/pulls/1' } },
    { updated_at: '2026-10-05T10:00:00Z', subject: { type: 'PullRequest', url: 'https://api.github.com/repos/someone/elsewhere/pulls/1' } },
  ];
  assert.equal((await watcher.check(board(pr(398)), 61_000)).unknownTouched, false);
});

test('notifications are asked no more often than X-Poll-Interval allows', async () => {
  const { exec, calls } = fakeGh({
    'repos/ForestAdmin/agent-ruby/pulls/398': header => (header ? http(304) : http(200, { ETag: 'W/"a"' }, '{}')),
    notifications: header => (header ? http(304, { 'X-Poll-Interval': '120' }) : http(200, { 'Last-Modified': 'Mon, 05 Oct 2026 08:00:00 GMT', 'X-Poll-Interval': '120' }, '[]')),
  });
  const watcher = createWatcher({ exec, scope });
  const current = board(pr(398));
  await watcher.check(current, 0);
  await watcher.check(current, 61_000);
  await watcher.check(current, 121_000);
  assert.equal(calls.filter(call => call.path === 'notifications').length, 2);
  assert.equal(watcher.pollSeconds, 120);
});

test('a failure is reported, not read as "nothing changed"', async () => {
  const { exec } = fakeGh({
    'repos/ForestAdmin/agent-ruby/pulls/398': () => http(404),
    'repos/ForestAdmin/agent-ruby/pulls/399': header => (header ? http(304) : http(200, { ETag: 'W/"a"' }, '{}')),
    notifications: quietNotifications,
  });
  const watcher = createWatcher({ exec, scope });
  const { failures } = await watcher.check(board(pr(398), pr(399)), 0);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /HTTP 404/);

  const broken = createWatcher({ exec: async () => { throw new Error('gh: not logged in'); }, scope });
  await assert.rejects(broken.check(board(pr(398)), 0), /change check failed: gh: not logged in/);
});

test('in flight: a pending head CI or a running release, nothing else', () => {
  const flying = inFlight({
    mine: [
      pr(1, { ciState: 'PENDING' }),
      pr(2, { ciState: 'SUCCESS' }),
      pr(3, { merged: true, pipelineOutcome: 'running', ciState: 'PENDING' }),
      pr(4, { merged: true, pipelineOutcome: 'done' }),
    ],
    reviews: [pr(5, { ciState: 'EXPECTED' }), pr(6, { ciState: 'FAILURE' })],
  });
  assert.deepEqual(flying.map(entry => entry.number), [1, 3, 5]);
});

test('a discovery asked early still waits the minimum gap after the last one', () => {
  assert.equal(nextDiscoveryAt(1000, false, 300_000), 301_000);
  assert.equal(nextDiscoveryAt(1000, true, 300_000), 1000 + MIN_DISCOVERY_GAP_MS);
  assert.equal(nextDiscoveryAt(1000, true, 30_000), 31_000, 'never later than the regular one');
});

test('gh output: status, headers and body are read, and an unknown shape is an error', () => {
  const parsed = parseResponse(http(200, { ETag: 'W/"x"', 'X-Poll-Interval': '60' }, '{"a":1}'));
  assert.equal(parsed.status, 200);
  assert.equal(parsed.headers.etag, 'W/"x"');
  assert.equal(parsed.headers['x-poll-interval'], '60');
  assert.equal(parsed.body, '{"a":1}');
  assert.equal(parseResponse('HTTP/2.0 304 Not Modified\nETag: W/"x"\n').status, 304);
  assert.throws(() => parseResponse('gh: something went wrong'), /unexpected gh output/);
  assert.deepEqual(prFromApiUrl('https://api.github.com/repos/matthv/pr-radar/pulls/2'), { repo: 'matthv/pr-radar', number: 2 });
});

test('an in-flight card is followed for a while, then left to the regular cadence', () => {
  const since = new Map();
  const running = { mine: [pr(1, { ciState: 'PENDING' })], reviews: [] };
  assert.equal(toFollow(running, since, 0).length, 1);
  assert.equal(toFollow(running, since, MAX_FOLLOW_MS - 1).length, 1);
  assert.equal(toFollow(running, since, MAX_FOLLOW_MS).length, 0);

  assert.equal(toFollow({ mine: [pr(1, { ciState: 'SUCCESS' })], reviews: [] }, since, MAX_FOLLOW_MS + 1).length, 0);
  assert.equal(since.size, 0, 'a card no longer in flight is forgotten');
  assert.equal(toFollow(running, since, MAX_FOLLOW_MS + 2).length, 1, 'and followed afresh if its CI runs again');
});

test('the checks stop once no page asked for a lease, unless a webhook is set', () => {
  assert.equal(watched(1000, 1000 + 600_000, 600_000, false), true);
  assert.equal(watched(1000, 1001 + 600_000, 600_000, false), false);
  assert.equal(watched(1000, 1000 + 24 * 3600_000, 600_000, true), true);
});

test('with no page looking, the full searches are spaced out, never brought closer', () => {
  assert.equal(searchEveryMs(300_000, true), 300_000);
  assert.equal(searchEveryMs(300_000, false), UNWATCHED_SEARCH_MS);
  assert.equal(searchEveryMs(3600_000, false), 3600_000);
});
