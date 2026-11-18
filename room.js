'use strict';

const { execFile } = require('node:child_process');
const { osascriptArgs } = require('./claude-sessions');

const MEET_URL = /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
const CHECK_EVERY_MS = 20_000;

// The errors name the host only: a room's code is enough to walk into it.
function parseRoomUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('PR_RADAR_ROOM_URL: not a valid URL');
  }
  const canonical = `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
  if (url.username || url.password || !MEET_URL.test(canonical)) {
    throw new Error(`PR_RADAR_ROOM_URL: not a Google Meet link like https://meet.google.com/xxx-xxxx-xxx (${url.host})`);
  }
  return { url: canonical, code: url.pathname.slice(1).replace(/\/+$/, '') };
}

const roomLink = value => (typeof value === 'string' && MEET_URL.test(value) ? value : null);

// The match runs inside AppleScript, so the URLs of the other tabs never reach the radar.
// Without the `is running` guard, asking Chrome anything would launch it.
const CHROME_SCRIPT = [
  'if application "Google Chrome" is not running then return "no"',
  'tell application "Google Chrome"',
  'repeat with w in windows',
  'repeat with t in tabs of w',
  'if URL of t contains ("meet.google.com/" & item 1 of argv) then return "yes"',
  'end repeat',
  'end repeat',
  'end tell',
  'return "no"',
];

const osascript = args =>
  new Promise((resolve, reject) => {
    execFile('osascript', args, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      const reason = String(stderr).trim() || error.message;
      reject(new Error(/-1743\b/.test(reason)
        ? 'macOS refused PR Radar access to Google Chrome: allow it under System Settings › Privacy & Security › Automation'
        : `cannot ask Google Chrome: ${reason}`));
    });
  });

async function roomOpen(code, exec = osascript) {
  return String(await exec(osascriptArgs(CHROME_SCRIPT, code))).trim() === 'yes';
}

function watchRoom({ code, onChange, log = () => {}, exec = osascript, every = CHECK_EVERY_MS, timers = { set: setInterval, clear: clearInterval } }) {
  let open = false;
  let lastError = null;
  let checking = false;
  async function check() {
    if (checking) return;
    checking = true;
    let next;
    try {
      next = await roomOpen(code, exec);
      lastError = null;
    } catch (error) {
      if (error.message !== lastError) log('fail', error.message);
      lastError = error.message;
      next = false;
    } finally {
      checking = false;
    }
    if (next === open) return;
    open = next;
    onChange(open);
  }
  check();
  const timer = timers.set(check, every);
  timer?.unref?.();
  return { check, stop: () => timers.clear(timer) };
}

module.exports = { MEET_URL, parseRoomUrl, roomLink, roomOpen, watchRoom };
