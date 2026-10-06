'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { DEFAULTS, normalize, move, isDefault } = require('../public/order');

test('order: nothing saved gives the default', () => {
  assert.deepEqual(normalize(null, DEFAULTS.mine), DEFAULTS.mine);
  assert.deepEqual(normalize('garbage', DEFAULTS.reviews), DEFAULTS.reviews);
});

test('order: a saved order is kept', () => {
  const saved = ['ready', 'action', 'merged', 'waiting', 'idle'];
  assert.deepEqual(normalize(saved, DEFAULTS.mine), saved);
});

test('order: unknown and duplicate buckets drop', () => {
  assert.deepEqual(normalize(['ready', 'ready', 'gone', 'action', 'waiting', 'merged', 'idle'], DEFAULTS.mine), ['ready', 'action', 'waiting', 'merged', 'idle']);
});

test('order: a missing bucket slots in after its default predecessor', () => {
  assert.deepEqual(normalize(['merged', 'action', 'waiting', 'idle'], DEFAULTS.mine), ['merged', 'action', 'ready', 'waiting', 'idle']);
  assert.deepEqual(normalize(['idle', 'merged'], DEFAULTS.reviews), ['action', 'waiting', 'idle', 'merged']);
});

test('order: a bucket of the other column is ignored', () => {
  assert.deepEqual(normalize(['ready', 'merged', 'action', 'waiting', 'idle'], DEFAULTS.reviews), ['merged', 'action', 'waiting', 'idle']);
});

test('order: move before or after a target', () => {
  assert.deepEqual(move(DEFAULTS.mine, 'ready', 'action', false), ['ready', 'action', 'waiting', 'merged', 'idle']);
  assert.deepEqual(move(DEFAULTS.mine, 'action', 'merged', true), ['ready', 'waiting', 'merged', 'action', 'idle']);
  assert.deepEqual(move(DEFAULTS.mine, 'idle', 'idle', true), DEFAULTS.mine);
  assert.deepEqual(move(DEFAULTS.mine, 'idle', 'nope', true), DEFAULTS.mine);
});

test('order: isDefault', () => {
  assert.equal(isDefault(DEFAULTS.mine, DEFAULTS.mine), true);
  assert.equal(isDefault(move(DEFAULTS.mine, 'ready', 'action', false), DEFAULTS.mine), false);
});
