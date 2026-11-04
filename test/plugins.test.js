'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { load, normalise, decoratePr, pluginWarnings, focusSession } = require('../plugins');

const pr = number => ({ id: `p${number}`, repo: 'o/r', number });

test('load reads each comma-separated path and refuses a module with neither decorate() nor focus()', () => {
  const modules = { '/a.cjs': { name: 'a', decorate: () => ({}) }, '/b.cjs': { decorate: () => ({}) }, '/f.cjs': { focus: () => true }, '/bad.cjs': {} };
  const req = file => modules[file];
  assert.deepEqual(load(' /a.cjs, ,/b.cjs ', req).map(plugin => plugin.name), ['a', 'b.cjs']);
  assert.deepEqual(load('', req), []);
  assert.deepEqual(load('/f.cjs', req).map(plugin => [plugin.name, plugin.decorate]), [['f.cjs', null]]);
  assert.throws(() => load('/bad.cjs', req), /exports neither decorate\(\) nor focus\(\)/);
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

  assert.deepEqual(await focusSession([broken, declines, focuses, never], session), { focused: true, failures: ['broken: no port'] });
  assert.deepEqual(seen, [session]);
  assert.deepEqual(await focusSession([broken, declines], session), { focused: false, failures: ['broken: no port'] });
  assert.deepEqual(await focusSession([{ name: 'd', decorate: () => ({}), focus: null }], session), { focused: false, failures: [] });
});
