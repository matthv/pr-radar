'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { load, normalise, decorateBoard } = require('../plugins');

const board = prs => ({ mine: prs, reviews: [], warnings: [{ source: 'author', message: 'kept' }] });
const pr = id => ({ id, repo: 'o/r', number: Number(id.slice(1)) });

test('load reads each comma-separated path and refuses a module with no decorate()', () => {
  const modules = { '/a.cjs': { name: 'a', decorate: () => ({}) }, '/b.cjs': { decorate: () => ({}) }, '/bad.cjs': {} };
  const req = file => modules[file];
  assert.deepEqual(load(' /a.cjs, ,/b.cjs ', req).map(plugin => plugin.name), ['a', 'b.cjs']);
  assert.deepEqual(load('', req), []);
  assert.throws(() => load('/bad.cjs', req), /exports no decorate/);
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

test('decorateBoard hands each plugin the raw node and the shaped PR, and adds what they return', () => {
  const nodes = new Map([['p1', { raw: 1 }]]);
  const seen = [];
  const plugin = { name: 'p', decorate: (node, shaped) => (seen.push([node, shaped.id]), { pills: [{ text: 'x' }], labels: [{ name: 'l' }] }) };
  const out = decorateBoard([plugin], board([pr('p1')]), nodes);
  assert.deepEqual(seen, [[{ raw: 1 }, 'p1']]);
  assert.equal(out.mine[0].plugins.pills[0].text, 'x');
  assert.equal(out.mine[0].plugins.labels[0].name, 'l');
});

test('a plugin that throws costs its own pills, not the board, and says so once', () => {
  const broken = { name: 'broken', decorate: () => { throw new Error('boom'); } };
  const fine = { name: 'fine', decorate: () => ({ pills: [{ text: 'y' }] }) };
  const out = decorateBoard([broken, fine], board([pr('p1'), pr('p2')]), new Map());
  assert.deepEqual(out.mine.map(card => card.plugins.pills.map(p => p.text)), [['y'], ['y']]);
  assert.deepEqual(out.warnings, [
    { source: 'author', message: 'kept' },
    { source: 'plugin', message: 'broken failed on 2 PR(s), first o/r#1: boom' },
  ]);
  // Decorated again (a reload), the warning is replaced, not stacked.
  assert.equal(decorateBoard([broken], out, new Map()).warnings.filter(w => w.source === 'plugin').length, 1);
});

test('no plugin leaves the board as it was', () => {
  const original = board([pr('p1')]);
  assert.equal(decorateBoard([], original, new Map()), original);
});
