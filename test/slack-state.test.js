'use strict';

// An unreadable state file is set aside, not written over: it holds the day claims were turned
// on. Its own file, for a fresh slack.js on a fresh temp state.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-radar-state-'));
const STATE = path.join(DIR, 'slack-links.json');
process.env.PR_RADAR_SLACK_STATE_FILE = STATE;

test('state: a corrupt file is set aside and the board starts afresh', async () => {
  fs.writeFileSync(STATE, '{"latestTs": "17913');
  const errors = [];
  const original = console.error;
  console.error = message => errors.push(message);
  try {
    const slack = require('../slack');
    await slack.loadClaims();
    assert.deepEqual(slack.claimedRefs(), []);
  } finally {
    console.error = original;
  }
  assert.equal(fs.existsSync(STATE), false);
  assert.equal(fs.readdirSync(DIR).filter(name => name.startsWith('slack-links.json.corrupt-')).length, 1);
  assert.match(errors.join('\n'), /unreadable/);
});
