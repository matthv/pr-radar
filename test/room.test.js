'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { MEET_URL, parseRoomUrl, roomLink, roomOpen, watchRoom } = require('../room');

test('room: no value, no room', () => {
  assert.equal(parseRoomUrl(undefined), null);
  assert.equal(parseRoomUrl('   '), null);
});

test('room: a Meet link is kept without what Meet appends to it', () => {
  const room = { url: 'https://meet.google.com/abc-defg-hij', code: 'abc-defg-hij' };
  assert.deepEqual(parseRoomUrl(' https://meet.google.com/abc-defg-hij '), room);
  assert.deepEqual(parseRoomUrl('https://meet.google.com/abc-defg-hij/?authuser=0#x'), room);
});

test('room: anything but a Meet link stops the start, naming the host only', () => {
  assert.throws(() => parseRoomUrl('meet.google.com/abc-defg-hij'), /not a valid URL/);
  for (const value of [
    'http://meet.google.com/abc-defg-hij',
    'https://meet.google.com.evil.test/abc-defg-hij',
    'https://zoom.us/j/abc-defg-hij',
    'https://meet.google.com/lookup/abc-defg-hij',
    'https://me:secret@meet.google.com/abc-defg-hij',
  ]) {
    assert.throws(() => parseRoomUrl(value), error => {
      assert.match(error.message, /not a Google Meet link .*\(/);
      assert.doesNotMatch(error.message, /abc-defg-hij|secret/);
      return true;
    }, value);
  }
  assert.throws(() => parseRoomUrl('javascript:alert(1)'), /not a Google Meet link/);
});

test('room: a link from the hub lands in an href only when it is a Meet room', () => {
  assert.equal(roomLink('https://meet.google.com/abc-defg-hij'), 'https://meet.google.com/abc-defg-hij');
  for (const value of ['javascript:alert(1)', 'https://meet.google.com/abc-defg-hij?x=1', 'https://evil.test/abc-defg-hij', 42, null, undefined]) {
    assert.equal(roomLink(value), null, String(value));
  }
  assert.ok(MEET_URL.test('https://meet.google.com/abc-defg-hij'));
});

test('room: Chrome is asked about the room code only, and answers yes or no', async () => {
  let args;
  assert.equal(await roomOpen('abc-defg-hij', async given => {
    args = given;
    return 'yes\n';
  }), true);
  assert.equal(args.at(-1), 'abc-defg-hij');
  assert.ok(args.join('\n').includes('is not running'));
  assert.equal(await roomOpen('abc-defg-hij', async () => 'no\n'), false);
});

function manualTimers() {
  const pending = [];
  return { set: fn => pending.push(fn), clear: () => pending.splice(0), tick: () => Promise.all(pending.map(fn => fn())) };
}

test('room: a change is reported once, and a failure counts as out of the room, logged once', async () => {
  const answers = ['yes', 'yes', new Error('macOS refused'), new Error('macOS refused'), 'yes', 'no'];
  const changes = [];
  const logged = [];
  const timers = manualTimers();
  watchRoom({
    code: 'abc-defg-hij',
    onChange: open => changes.push(open),
    log: (level, message) => logged.push(`${level} ${message}`),
    exec: async () => {
      const answer = answers.shift();
      if (answer instanceof Error) throw answer;
      return answer;
    },
    timers,
  });
  await new Promise(setImmediate);
  for (let i = 0; i < 5; i += 1) await timers.tick();
  assert.deepEqual(changes, [true, false, true, false]);
  assert.deepEqual(logged, ['fail macOS refused']);
});
