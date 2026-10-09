'use strict';

// readClaims end to end: the model stubbed, the state in a temp file. Its own file, since the
// state path and the emoji are read when slack.js loads, and the state is kept in memory:
// the tests run in order on one state.
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
const prompts = [];
digest.claude = async prompt => {
  prompts.push(prompt);
  const next = answers.shift();
  if (next instanceof Error) throw next;
  return typeof next === 'string' ? next : JSON.stringify(next);
};
const slack = require('../slack');

const announce = (ts, ...prs) => ({ ts, text: prs.map(n => `<https://github.com/o/r/pull/${n}|pr>`).join(' ') });
const DAY = 86400_000;
const MIN = 60_000;
const now = Date.parse('2026-10-07T12:00:00Z');
const saved = () => JSON.parse(fs.readFileSync(STATE, 'utf8'));
const read = (at, force = true) => slack.readClaims({ maxAgeDays: 60, now: at, force });

test('claims: on, with the colons stripped, only through Claude', () => {
  assert.equal(slack.CLAIM_EMOJI, 'pr-radar');
  assert.equal(slack.claimMode('claude'), 'on');
  assert.equal(slack.claimMode('api'), 'needs-claude');
});

test('claims: a restart keeps the day they were turned on, and the claimed list', async () => {
  fs.writeFileSync(STATE, JSON.stringify({
    latestTs: '1791000000.000001', byPr: {}, attempts: {}, claimSince: '2026-09-01',
    claimed: { at: now - 2 * MIN, refs: [{ repo: 'o/r', number: 3 }] },
  }));
  await slack.loadClaims();
  assert.deepEqual(slack.claimedRefs(), [{ repo: 'o/r', number: 3 }], 'shown at once after a restart');

  const cached = await read(now, false);
  assert.deepEqual([cached.refs, cached.changed, prompts.length], [[{ repo: 'o/r', number: 3 }], false, 0], 'not due: no model call');
});

test('claims: a read searches my reactions in the channel since the start day', async () => {
  answers.push({ messages: [announce('1791371567.461059', 3, 7)], more: false });
  const first = await read(now);
  assert.match(prompts.at(-1), /in:<#C123> hasmy::pr-radar: after:2026-08-31/);
  assert.deepEqual([first.refs.map(r => r.number), first.changed], [[3, 7], true]);

  const state = saved();
  assert.equal(state.latestTs, '1791000000.000001', 'the channel read still sees what came after its cursor');
  assert.equal(state.byPr['o/r#7'], '1791371567.461059', 'the Slack button shows without a channel read');
  assert.equal(state.claimSince, '2026-09-01', 'the start day does not move');
  assert.deepEqual(state.claimed.refs.map(r => r.number), [3, 7]);
});

test('claims: within five minutes a read is not due, and the truncation is kept', async () => {
  answers.push({ messages: [announce('1791371567.461059', 3, 7)], more: true });
  assert.equal((await read(now + DAY)).truncated, true);
  const cached = await read(now + DAY + MIN, false);
  assert.deepEqual([cached.truncated, cached.read, answers.length], [true, false, 0], 'nothing asked: not a read');
});

test('claims: a claim that would go is asked twice', async () => {
  answers.push({ messages: [announce('1791371567.461059', 3)], more: false }, { messages: [announce('1791371567.461059', 3, 7)], more: false });
  const flaky = await read(now + 2 * DAY);
  assert.deepEqual([flaky.refs.map(r => r.number), flaky.changed], [[3, 7], false], 'the second read did not confirm it');

  answers.push({ messages: [announce('1791371567.461059', 3)], more: false }, { messages: [announce('1791371567.461059', 3)], more: false });
  const removed = await read(now + 3 * DAY);
  assert.deepEqual([removed.refs.map(r => r.number), removed.changed], [[3], true]);

  answers.push({ messages: [announce('1791371567.461059', 3, 9)], more: false });
  await read(now + 4 * DAY);
  assert.equal(answers.length, 0, 'an addition is not asked twice');
});

test('claims: a claim goes only when both reads miss it, and a failed confirmation keeps it', async () => {
  answers.push({ messages: [announce('1791371567.461059', 3, 9, 11)], more: false });
  await read(now + 4 * DAY + 10 * MIN);
  answers.push({ messages: [announce('1791371567.461059', 3, 11)], more: false }, { messages: [announce('1791371567.461059', 3)], more: false });
  const both = await read(now + 4 * DAY + 20 * MIN);
  assert.deepEqual(both.refs.map(r => r.number).sort((a, b) => a - b), [3, 11], '9 missed twice goes, 11 missed once stays');

  const errors = [];
  const original = console.error;
  console.error = message => errors.push(message);
  answers.push({ messages: [announce('1791371567.461059', 3)], more: false }, new Error('claude exited with 1'));
  const failed = await read(now + 4 * DAY + 30 * MIN);
  console.error = original;
  assert.deepEqual(failed.refs.map(r => r.number).sort((a, b) => a - b), [3, 11], 'nothing removed on one answer');
  assert.equal(failed.read, true);
  assert.match(errors.join('\n'), /confirming a removed claim failed/);

  answers.push({ messages: [announce('1791371567.461059', 3, 9)], more: false }, { messages: [announce('1791371567.461059', 3, 9)], more: false });
  await read(now + 4 * DAY + 40 * MIN);
  assert.equal(answers.length, 0);
});

test('claims: a failed read keeps the last list and waits its back-off, then a success clears it', async () => {
  answers.push(new Error('claude exited with 1'));
  await assert.rejects(read(now + 5 * DAY), /exited/);
  assert.deepEqual(slack.claimedRefs().map(r => r.number), [3, 9]);
  await assert.rejects(read(now + 5 * DAY + MIN), /exited/, 'Refresh does not retry during the back-off');
  await assert.rejects(read(now + 5 * DAY + 4 * MIN), /exited/, 'five minutes of it');
  assert.equal(answers.length, 0);

  answers.push({ messages: [announce('1791371567.461059', 3, 9)], more: false });
  await read(now + 5 * DAY + 6 * MIN);
  const after = await read(now + 5 * DAY + 7 * MIN, false);
  assert.deepEqual(after.refs.map(r => r.number), [3, 9], 'the old error is not thrown again');
});

test('channel read: "no connector" is retried after its back-off, not kept until a restart', async () => {
  const prs = [{ repo: 'o/r', number: 4242 }];
  const at = now + 30 * DAY;
  // One answer: the claims reads above already settled which model to ask.
  answers.push('NO_SLACK_TOOL');
  await assert.rejects(slack.lookup(prs, { maxAgeDays: 60, via: 'claude', now: at }), error => error.code === 'no-connector');
  await assert.rejects(slack.lookup(prs, { maxAgeDays: 60, via: 'claude', now: at + MIN }), error => error.code === 'no-connector');
  assert.equal(answers.length, 0, 'no model call during the back-off');

  answers.push(JSON.stringify([{ ts: '1791400000.000001', text: 'https://github.com/o/r/pull/4242' }]));
  assert.equal(await slack.lookup(prs, { maxAgeDays: 60, via: 'claude', now: at + 31 * MIN }), true, 'read again once it is over');
});
