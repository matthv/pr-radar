'use strict';

const test = require('node:test');
const { describe } = test;
const assert = require('node:assert/strict');

const { load, normalise, decoratePr, pluginWarnings, focusSession, openSession, labelRoute } = require('../plugins');
const { refusal } = require('../claude-sessions');

const pr = number => ({ id: `p${number}`, repo: 'o/r', number });

test('load reads each comma-separated path and refuses a module with none of decorate(), focus() or open()', () => {
  const modules = { '/a.cjs': { name: 'a', decorate: () => ({}) }, '/b.cjs': { decorate: () => ({}) }, '/f.cjs': { focus: () => true }, '/o.cjs': { open: () => true }, '/bad.cjs': {} };
  const req = file => modules[file];
  assert.deepEqual(load(' /a.cjs, ,/b.cjs ', req).map(plugin => plugin.name), ['a', 'b.cjs']);
  assert.deepEqual(load('', req), []);
  assert.deepEqual(load('/f.cjs', req).map(plugin => [plugin.name, plugin.decorate]), [['f.cjs', null]]);
  assert.deepEqual(load('/o.cjs', req).map(plugin => [plugin.name, plugin.decorate, plugin.focus]), [['o.cjs', null, null]]);
  assert.throws(() => load('/bad.cjs', req), /exports none of decorate\(\), focus\(\) or open\(\)/);
  assert.throws(() => load('/missing.cjs', () => { throw new Error('nope'); }), /cannot load \/missing.cjs: nope/);
});

test('normalise keeps a plugin from putting a stray class or a non-https link on a card', () => {
  const out = normalise({
    pills: [
      { text: 'ok', kind: 'good', url: 'https://github.com/x', running: 1 },
      { text: 'odd', kind: 'pill" onclick="x', url: 'javascript:alert(1)' },
      { text: '' },
    ],
    labels: [{ name: 'validate' }, { text: 'no name' }],
  });
  assert.deepEqual(out.pills, [
    { text: 'ok', kind: 'good', title: null, url: 'https://github.com/x', running: true },
    { text: 'odd', kind: '', title: null, url: null, running: false },
  ]);
  assert.deepEqual(out.labels, [{ name: 'validate', text: 'validate', title: null }]);
});

test('normalise keeps a claim only with who, when and a turn the board knows', () => {
  const since = '2026-11-02T10:00:00Z';
  assert.deepEqual(normalise({ review: { claimedBy: 'me', since, turn: 'bot' } }).review, { claimedBy: 'me', since, turn: 'bot', why: null });
  assert.deepEqual(normalise({ review: { claimedBy: 'me', since, turn: 'me', why: 'retry it' } }).review.why, 'retry it');
  assert.equal(normalise({ review: { claimedBy: 'me', since, turn: 'reviewer' } }).review, null, 'a turn the board has no group for');
  assert.equal(normalise({ review: { claimedBy: 'me', since: 'yesterday', turn: 'me' } }).review, null);
  assert.equal(normalise({ review: { since, turn: 'me' } }).review, null);
  assert.equal(normalise({}).review, null);
  assert.equal(normalise({ review: { claimedBy: 'me', since: '12345', turn: 'me' } }).review, null, 'the year 12345: no review could ever come after it');
  assert.ok(normalise({ review: { claimedBy: 'me', since: new Date(Date.now() + 5000).toISOString(), turn: 'me' } }).review, 'a clock a few seconds behind GitHub’s');
});

test('decoratePr hands each plugin the raw node and the shaped PR, adds what they return, first claim wins', () => {
  const since = '2026-11-02T10:00:00Z';
  const seen = [];
  const first = { name: 'a', decorate: (node, shaped) => (seen.push([node, shaped.id]), { pills: [{ text: 'x' }], labels: [{ name: 'l' }], review: { claimedBy: 'me', since, turn: 'bot' } }) };
  const second = { name: 'b', decorate: () => ({ pills: [{ text: 'y' }], review: { claimedBy: 'other', since, turn: 'me' } }) };
  const out = decoratePr([first, second], { raw: 1 }, pr(1), new Map());
  assert.deepEqual(seen, [[{ raw: 1 }, 'p1']]);
  assert.deepEqual(out.pills.map(p => p.text), ['x', 'y']);
  assert.deepEqual(out.labels.map(l => l.name), ['l']);
  assert.equal(out.review.claimedBy, 'me');
});

test('a plugin that throws costs its own pills, not the board, and says so once', () => {
  const broken = { name: 'broken', decorate: () => { throw new Error('boom'); } };
  const fine = { name: 'fine', decorate: () => ({ pills: [{ text: 'y' }] }) };
  const failures = new Map();
  const cards = [pr(1), pr(2)].map(card => decoratePr([broken, fine], {}, card, failures));
  assert.deepEqual(cards.map(card => card.pills.map(p => p.text)), [['y'], ['y']]);
  assert.deepEqual(pluginWarnings(failures), [{ source: 'plugin', message: 'broken failed on 2 PR(s), first o/r#1: boom' }]);
  assert.deepEqual(decoratePr([], {}, pr(1), new Map()), { pills: [], labels: [], review: null });
});

test('decoratePr passes over a plugin that only focuses sessions', () => {
  const focusOnly = { name: 'f', decorate: null, focus: () => true };
  assert.deepEqual(decoratePr([focusOnly], {}, pr(1), new Map()), { pills: [], labels: [], review: null });
});

test('focusSession takes the first plugin that brought the session forward, and names the ones that threw', async () => {
  const session = { sessionId: 's', pid: 5, tty: 'ttys001', ancestors: ['-zsh', '/Applications/Some.app/Contents/MacOS/Some'] };
  const seen = [];
  const broken = { name: 'broken', focus: () => { throw new Error('no port'); } };
  const declines = { name: 'declines', focus: async got => (seen.push(got), false) };
  const focuses = { name: 'focuses', focus: async () => true };
  const never = { name: 'never', focus: () => assert.fail('the first answer wins') };

  assert.deepEqual(await focusSession([broken, declines, focuses, never], session), { done: true, failures: ['broken: no port'], stalled: false });
  assert.deepEqual(seen, [session]);
  assert.deepEqual(await focusSession([broken, declines], session), { done: false, failures: ['broken: no port'], stalled: false });
  assert.deepEqual(await focusSession([{ name: 'd', decorate: () => ({}), focus: null }], session), { done: false, failures: [], stalled: false });
});

test('openSession asks only the plugins that open, the first true winning', async () => {
  const session = { sessionId: 's', cwd: '/repo' };
  const seen = [];
  const focusOnly = { name: 'f', focus: () => assert.fail('focus is not open') };
  const opens = { name: 'o', open: async got => (seen.push(got), true) };

  assert.deepEqual(await openSession([focusOnly, opens], session), { done: true, failures: [], stalled: false });
  assert.deepEqual(seen, [session]);
  assert.deepEqual(await openSession([focusOnly], session), { done: false, failures: [], stalled: false });
});

test('a plugin that throws something other than an Error, or answers a promise, is one failure and the board stays up', async () => {
  const failures = new Map();
  const plugins = [
    { name: 'null', decorate: () => { throw null; } },
    { name: 'string', decorate: () => { throw 'nope'; } },
    { name: 'async', decorate: async () => { throw new Error('boom'); } },
    { name: 'fine', decorate: () => ({ pills: [{ text: 'y' }] }) },
  ];
  assert.deepEqual(decoratePr(plugins, {}, pr(1), failures).pills.map(p => p.text), ['y']);
  assert.deepEqual(pluginWarnings(failures).map(w => w.message), [
    'null failed on 1 PR(s), first o/r#1: null',
    'string failed on 1 PR(s), first o/r#1: nope',
    'async failed on 1 PR(s), first o/r#1: decorate() must be synchronous, it returned a promise',
  ]);
  // The rejection has had its turn: left unhandled, it would have ended this process.
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await focusSession([{ name: 'null', focus: () => { throw null; } }], {}), { done: false, failures: ['null: null'], stalled: false });
});

test('a hook that never answers is passed over: focus asks the next plugin, open stops there', async () => {
  const hangs = hook => ({ name: 'hangs', [hook]: () => new Promise(() => {}) });
  const takes = hook => ({ name: 'takes', [hook]: async () => true });

  assert.deepEqual(await focusSession([hangs('focus'), takes('focus')], {}, 10), { done: true, failures: ['hangs: no answer after 0.01 s'], stalled: false });
  const opened = await openSession([hangs('open'), { name: 'never', open: () => assert.fail('it may still be opening') }], {}, 10);
  assert.deepEqual(opened, { done: false, failures: ['hangs: no answer after 0.01 s'], stalled: true });
  assert.equal((await openSession([takes('open')], {}, 10)).done, true);
});

describe('the label route', () => {
  const request = (overrides = {}) => ({
    headers: { 'content-type': 'application/json', host: 'localhost:4321' },
    remoteAddress: '127.0.0.1',
    readBody: async () => ({ id: 'p1', label: 'validate' }),
    ...overrides,
  });
  const board = { mine: [], reviews: [{ ...pr(1), plugins: { labels: [{ name: 'validate' }] } }, pr(2)] };
  const context = (overrides = {}) => ({
    refusal, demo: false, board, logger: { info() {}, fail() {} },
    runGh: () => assert.fail('nothing should reach GitHub'),
    reload: () => assert.fail('nothing to reload'),
    ...overrides,
  });

  test('asked the wrong way, or for a label no plugin offers on that PR, it writes nothing', async () => {
    assert.equal((await labelRoute(request({ headers: { 'content-type': 'text/plain', host: 'localhost:4321' } }), context()))[0], 403);
    assert.equal((await labelRoute(request({ remoteAddress: '10.0.0.4' }), context()))[0], 403);
    assert.equal((await labelRoute(request({ readBody: async () => JSON.parse('{') }), context()))[0], 400);
    const refused = [409, 'no plugin offers this label on this PR any more'];
    assert.deepEqual(await labelRoute(request({ readBody: async () => ({ id: 'p1', label: 'deploy' }) }), context()), refused);
    assert.deepEqual(await labelRoute(request({ readBody: async () => ({ id: 'p2', label: 'validate' }) }), context()), refused, 'offered on another PR');
    assert.deepEqual(await labelRoute(request({ readBody: async () => ({ id: 'p9', label: 'validate' }) }), context()), refused);
    assert.deepEqual(await labelRoute(request({ readBody: async () => null }), context()), refused);
    assert.deepEqual(await labelRoute(request(), context({ board: null })), refused);
    assert.deepEqual(await labelRoute(request(), context({ demo: true })), [200, null], 'the demo answers and adds nothing');
  });

  test('an offered label is added, whatever case the repo spells it in, and the card reloaded', async () => {
    const calls = [];
    const reloaded = [];
    const runGh = async args => (calls.push(args), JSON.stringify([{ name: 'bug' }, { name: 'Validate' }]));
    assert.deepEqual(await labelRoute(request(), context({ runGh, reload: async id => reloaded.push(id) })), [200, null]);
    assert.deepEqual(calls, [['api', '-X', 'POST', 'repos/o/r/issues/1/labels', '-f', 'labels[]=validate']]);
    assert.deepEqual(reloaded, ['p1']);
    const failing = async () => { throw new Error('rate limited'); };
    assert.deepEqual(await labelRoute(request(), context({ runGh, reload: failing })), [200, null], 'the label is on: a reload that fails is logged');
  });

  test('GitHub’s error body, or anything but its label list, is a failure', async () => {
    const answers = out => labelRoute(request(), context({ runGh: async () => out }));
    assert.deepEqual(await answers('{"message":"Not Found","status":"404"}'), [502, 'Not Found']);
    assert.deepEqual(await answers('<html>502 Bad Gateway</html>'), [502, 'GitHub answered something other than JSON: <html>502 Bad Gateway</html>']);
    assert.deepEqual(await answers('[{"name":"bug"}]'), [502, 'GitHub did not add the label']);
  });
});
