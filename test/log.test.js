'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const logger = require('../log');

const capture = (stream, run) => {
  const lines = [];
  const original = console[stream];
  console[stream] = line => lines.push(line);
  try {
    run();
  } finally {
    console[stream] = original;
  }
  return lines;
};

test('the stamp is local time, zero-padded', () => {
  assert.equal(logger.stamp(new Date(2026, 0, 5, 7, 3, 9)), '05/01 07:03:09');
});

test('a line carries its source emoji and keeps the text prefix', () => {
  const at = new Date(2026, 9, 13, 11, 22, 41);
  const lines = capture('log', () => logger.info('live', '5 PR(s) reloaded', at));
  assert.deepEqual(lines, ['[13/10 11:22:41] 🔄 live: 5 PR(s) reloaded']);
});

test('a failure goes to stderr with the warning sign instead of the source emoji', () => {
  const at = new Date(2026, 9, 13, 11, 30, 15);
  const lines = capture('error', () => logger.fail('slack', 'claims read failed', at));
  assert.deepEqual(lines, ['[13/10 11:30:15] ⚠️ slack: claims read failed']);
});

test('an unknown source has no emoji but keeps its prefix', () => {
  assert.equal(logger.line(logger.EMOJI.other, 'other', 'hi', new Date(2026, 9, 13, 9, 0, 0)), '[13/10 09:00:00] other: hi');
});
