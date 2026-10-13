'use strict';

// The text prefix stays after the emoji, so `grep slack:` still finds every Slack line.
const EMOJI = {
  live: '🔄',
  search: '🔎',
  slack: '💬',
  update: '⬆️',
  webhook: '🪝',
  notes: '📝',
};
const FAILED = '⚠️';

const pad = n => String(n).padStart(2, '0');

// Local time, built by hand: Intl's output depends on the machine's locale.
function stamp(now = new Date()) {
  return `${pad(now.getDate())}/${pad(now.getMonth() + 1)} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function line(emoji, source, message, now) {
  return `[${stamp(now)}] ${emoji ? `${emoji} ` : ''}${source}: ${message}`;
}

function info(source, message, now) {
  console.log(line(EMOJI[source], source, message, now));
}

function fail(source, message, now) {
  console.error(line(FAILED, source, message, now));
}

module.exports = { stamp, line, info, fail, EMOJI };
