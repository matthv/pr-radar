'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { MEET_URL, parseRoomUrl, roomLink, roomOpen, roomWatchOff, watchRoom, chromeError } = require('../room');

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
  // First line of the script, before anything that talks to Chrome and would launch it.
  assert.deepEqual(args.slice(0, 4), ['-e', 'on run argv', '-e', 'if application "Google Chrome" is not running then return "no"']);
  assert.ok(args.includes('if URL of t contains ("meet.google.com/" & item 1 of argv) then return "yes"'));
  assert.equal(await roomOpen('abc-defg-hij', async () => 'no\n'), false);
});

test('room: a failed check says why without ever naming the room', () => {
  assert.match(chromeError({ stderr: 'execution error: Not authorised to send Apple events to Google Chrome. (-1743)' }, 'abc-defg-hij'), /System Settings › Privacy & Security › Automation/);
  assert.equal(chromeError({ killed: true, signal: 'SIGTERM' }, 'abc-defg-hij'), 'Google Chrome did not answer within 10 s');
  assert.equal(chromeError({ stderr: '', code: 1 }, 'abc-defg-hij'), 'cannot ask Google Chrome: osascript exited with 1');
  assert.equal(chromeError({ stderr: 'oops near abc-defg-hij (-2741)' }, 'abc-defg-hij'), 'cannot ask Google Chrome: oops near … (-2741)');
});

test('room: watched on macOS with a hub only', () => {
  assert.equal(roomWatchOff({ platform: 'darwin', hubUrl: 'wss://hub.test/ws' }), null);
  assert.equal(roomWatchOff({ platform: 'linux', hubUrl: 'wss://hub.test/ws' }), 'not macOS');
  assert.equal(roomWatchOff({ platform: 'darwin', hubUrl: '' }), 'no hub');
});

const ROOM = { url: 'https://meet.google.com/abc-defg-hij', code: 'abc-defg-hij' };

function fakeHub(declined = false) {
  const rooms = [];
  return { rooms, setDeclined: value => { declined = value; }, state: () => ({ declined }), setRoom: url => rooms.push(url) };
}

function scripted(answers) {
  return async () => {
    const answer = answers.shift();
    if (answer instanceof Error) throw answer;
    return answer;
  };
}

const noTimers = { set: () => null, clear: () => {} };

test('room: the hub gets the link on entering and null on leaving, once each; a failure counts as out, logged once until it recovers', async () => {
  const hub = fakeHub();
  const logged = [];
  const refused = new Error('macOS refused');
  const watch = watchRoom({
    room: ROOM, hub, timers: noTimers,
    log: (level, message) => logged.push(`${level} ${message}`),
    exec: scripted(['yes', 'yes', refused, refused, 'yes', 'no', refused]),
  });
  await watch.first;
  for (let i = 0; i < 6; i += 1) await watch.check();
  assert.deepEqual(hub.rooms, [ROOM.url, null, ROOM.url, null]);
  assert.deepEqual(logged, ['fail macOS refused', 'info Google Chrome answers again', 'fail macOS refused']);
});

test('room: a slow Chrome is asked once at a time', async () => {
  let calls = 0;
  let answer;
  const hub = fakeHub();
  const watch = watchRoom({ room: ROOM, hub, timers: noTimers, exec: () => { calls += 1; return new Promise(resolve => { answer = resolve; }); } });
  await watch.check();
  assert.equal(calls, 1);
  answer('yes');
  await watch.first;
  assert.deepEqual(hub.rooms, [ROOM.url]);
});

test('room: with the hub declined Chrome is not asked, and an open room is taken back', async () => {
  let calls = 0;
  const hub = fakeHub();
  const watch = watchRoom({ room: ROOM, hub, timers: noTimers, exec: async () => { calls += 1; return 'yes'; } });
  await watch.first;
  hub.setDeclined(true);
  await watch.check();
  await watch.check();
  assert.equal(calls, 1);
  assert.deepEqual(hub.rooms, [ROOM.url, null]);
});
