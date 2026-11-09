'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { MINIMUM, tooOld } = require('../node-version');

test('engines.node in package.json is a plain ">=X.Y[.Z]" the check can compare', () => {
  assert.match(MINIMUM, /^\d+(\.\d+){0,2}$/);
});

test('a Node older than the minimum is refused, the minimum itself and anything newer pass', () => {
  assert.equal(tooOld('20.19.0', '22.4'), true);
  assert.equal(tooOld('22.3.9', '22.4'), true);
  assert.equal(tooOld('v22.3.0', '22.4'), true);
  assert.equal(tooOld('22.4.0', '22.4'), false);
  assert.equal(tooOld('22.23.4', '22.4'), false);
  assert.equal(tooOld('v24', '22.4'), false);
});

test('patch numbers count when the minimum names one', () => {
  assert.equal(tooOld('22.4.0', '22.4.1'), true);
  assert.equal(tooOld('22.4.1', '22.4.1'), false);
});

test('a prerelease is compared on its numbers', () => {
  assert.equal(tooOld('22.4.0-nightly20240601', '22.4'), false);
  assert.equal(tooOld('22.3.0-pre', '22.4'), true);
  assert.equal(tooOld('22.4.1-rc.1', '22.4.1'), false);
});

test('the running Node passes, or the suite could not have started', () => {
  assert.equal(tooOld(process.versions.node), false);
});
