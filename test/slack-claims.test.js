'use strict';

// readClaims end to end: the model stubbed, the state in a temp file. Its own file, since the
// state path and the emoji are read when slack.js loads.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STATE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pr-radar-claims-')), 'slack-links.json');
process.env.PR_RADAR_SLACK_STATE_FILE = STATE;
process.env.PR_RADAR_SLACK_CHANNEL = 'C123';
process.env.PR_RADAR_SLACK_CLAIM_EMOJI = ':pr-radar:';

const digest = require('../digest');
const answers = [];
digest.claude = async () => {
  const next = answers.shift();
  if (next instanceof Error) throw next;
  return JSON.stringify(next);
};
const slack = require('../slack');

const announce = (ts, ...prs) => ({ ts, text: prs.map(n => `<https://github.com/o/r/pull/${n}|pr>`).join(' ') });
const DAY = 86400_000;
const now = Date.parse('2026-10-07T12:00:00Z');

test('claims: on, with the colons stripped, only through Claude', () => {
  assert.equal(slack.CLAIM_EMOJI, 'pr-radar');
  assert.equal(slack.claimMode('claude'), 'on');
  assert.equal(slack.claimMode('api'), 'needs-claude');
});

test('claims: a read records the claimed PRs and their links, not the channel read\'s cursor', async () => {
  fs.writeFileSync(STATE, JSON.stringify({ latestTs: '1791000000.000001', byPr: {}, attempts: {} }));
  answers.push({ messages: [announce('1791371567.461059', 7)], more: false });
  const first = await slack.readClaims({ maxAgeDays: 60, now, force: true });
  assert.deepEqual([first.refs, first.changed], [[{ repo: 'o/r', number: 7 }], true]);

  const saved = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  assert.equal(saved.latestTs, '1791000000.000001', 'the channel read still sees what came after its cursor');
  assert.equal(saved.byPr['o/r#7'], '1791371567.461059', 'the Slack button shows without a channel read');
  assert.equal(saved.claimSince, '2026-10-07');
  assert.deepEqual(slack.claimedRefs(), [{ repo: 'o/r', number: 7 }]);

  answers.push({ messages: [announce('1791371567.461059', 7)], more: false });
  const next = await slack.readClaims({ maxAgeDays: 60, now: now + DAY, force: true });
  assert.equal(next.changed, false);
  assert.equal(JSON.parse(fs.readFileSync(STATE, 'utf8')).claimSince, '2026-10-07', 'the start day does not move');
});

test('claims: a single empty answer does not wipe the list, a second one does', async () => {
  answers.push({ messages: [], more: false }, { messages: [announce('1791371567.461059', 7)], more: false });
  const flaky = await slack.readClaims({ maxAgeDays: 60, now: now + 2 * DAY, force: true });
  assert.deepEqual([flaky.refs.length, flaky.changed], [1, false], 'the second read did not confirm it');

  answers.push({ messages: [], more: false }, { messages: [], more: false });
  const removed = await slack.readClaims({ maxAgeDays: 60, now: now + 3 * DAY, force: true });
  assert.deepEqual([removed.refs, removed.changed], [[], true]);
});

test('claims: a failed read keeps the last list and waits its back-off, Refresh included', async () => {
  answers.push({ messages: [announce('1791371567.461059', 8)], more: true });
  const truncated = await slack.readClaims({ maxAgeDays: 60, now: now + 4 * DAY, force: true });
  assert.equal(truncated.truncated, true, 'more announcements than the pages read');

  answers.push(new Error('claude exited with 1'));
  await assert.rejects(slack.readClaims({ maxAgeDays: 60, now: now + 5 * DAY, force: true }), /exited/);
  assert.deepEqual(slack.claimedRefs(), [{ repo: 'o/r', number: 8 }]);
  await assert.rejects(slack.readClaims({ maxAgeDays: 60, now: now + 5 * DAY + 60_000, force: true }), /exited/);
  assert.equal(answers.length, 0, 'no model call during the back-off');
});
