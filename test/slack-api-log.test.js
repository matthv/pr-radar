'use strict';

// The API path has no back-off: it reads again on every refresh. A lasting failure, a revoked
// token say, is logged once. Its own file, since the token is read when slack.js loads.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.PR_RADAR_SLACK_STATE_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pr-radar-api-')), 'slack-links.json');
process.env.PR_RADAR_SLACK_CHANNEL = 'C123';
process.env.PR_RADAR_SLACK_TOKEN = 'xoxb-test';

const slack = require('../slack');

test('api: a lasting failure is logged once, with the retry it really gets', async () => {
  let answer = { ok: false, error: 'invalid_auth' };
  global.fetch = async () => ({ json: async () => answer });
  const logged = [];
  const original = console.error;
  console.error = line => logged.push(line);
  const prs = [{ repo: 'o/r', number: 1 }];
  try {
    await assert.rejects(slack.lookup(prs, { maxAgeDays: 60, via: 'api' }), /invalid_auth/);
    await assert.rejects(slack.lookup(prs, { maxAgeDays: 60, via: 'api' }), /invalid_auth/);
    answer = { ok: false, error: 'not_in_channel' };
    await assert.rejects(slack.lookup(prs, { maxAgeDays: 60, via: 'api' }), /not_in_channel/);
  } finally {
    console.error = original;
  }
  assert.equal(logged.length, 2, 'the same failure twice is one line, a new one is another');
  assert.match(logged[0], /slack: channel read failed \(invalid_auth\), trying again at the next refresh/);
  assert.match(logged[1], /not_in_channel/);
});
