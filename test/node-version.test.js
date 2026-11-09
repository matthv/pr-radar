'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { MINIMUM, tooOld } = require('../node-version');

test('the minimum comes from engines.node in package.json', () => {
  assert.equal(MINIMUM, '22.4');
});

test('a Node older than the minimum is refused, the minimum itself and anything newer pass', () => {
  assert.equal(tooOld('20.19.0'), true);
  assert.equal(tooOld('22.3.9'), true);
  assert.equal(tooOld('v22.3.0'), true);
  assert.equal(tooOld('22.4.0'), false);
  assert.equal(tooOld('22.23.4'), false);
  assert.equal(tooOld('24.0.0'), false);
});

test('patch numbers count when the minimum names one', () => {
  assert.equal(tooOld('22.4.0', '22.4.1'), true);
  assert.equal(tooOld('22.4.1', '22.4.1'), false);
});
