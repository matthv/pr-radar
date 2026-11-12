'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { readStages, summarise, parseLines, prUrl } = require('../skill-stages');

const line = fields => JSON.stringify({ v: 1, session: 's', ...fields });

test('a skill running inside another is what the session shows, until it ends', () => {
  const lines = parseLines([
    line({ at: '2026-11-12T10:00:00Z', skill: 'review-loop', run: 'loop', ticket: 'PRD-1', stage: 'review', state: 'running' }),
    line({ at: '2026-11-12T10:01:00Z', skill: 'validator', run: 'val', pr: undefined, prs: ['ForestAdmin/claudine#7'], stage: 'skeptic', state: 'running' }),
  ].join('\n'));
  assert.equal(summarise('s', lines).current.skill, 'validator');

  const ended = parseLines([
    ...lines.map(entry => JSON.stringify(entry)),
    line({ at: '2026-11-12T10:02:00Z', skill: 'validator', run: 'val', state: 'done', outcome: 'comment' }),
  ].join('\n'));
  const session = summarise('s', ended);
  assert.deepEqual([session.current.skill, session.current.stage], ['review-loop', 'review']);
  assert.deepEqual([...session.tickets], ['PRD-1']);
  assert.deepEqual([...session.prs], ['ForestAdmin/claudine#7']);
});

test('a waiting run carries its question, and loses it once it runs again', () => {
  const waiting = summarise('s', parseLines(line({ at: 'a', skill: 'implement', run: 'r', stage: 'plan', state: 'waiting', question: 'Ship it?' })));
  assert.equal(waiting.current.question, 'Ship it?');
  const resumed = summarise('s', parseLines([
    line({ at: 'a', skill: 'implement', run: 'r', stage: 'plan', state: 'waiting', question: 'Ship it?' }),
    line({ at: 'b', skill: 'implement', run: 'r', stage: 'tests', state: 'running' }),
  ].join('\n')));
  assert.deepEqual([resumed.current.stage, resumed.current.question], ['tests', null]);
});

test('a line half written or not record-stage\'s is skipped', () => {
  assert.equal(parseLines('{"v":1,"skill":"adr","run":"r"\n{"other":true}\n').length, 0);
});

test('a PR reference becomes the URL the board knows the PR by', () => {
  assert.equal(prUrl('ForestAdmin/claudine#1357'), 'https://github.com/ForestAdmin/claudine/pull/1357');
  assert.equal(prUrl('claudine#1357'), null);
});

test('only sessions heard from within the window are read, and no folder is no session', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stages-'));
  await fs.writeFile(path.join(dir, 'fresh.jsonl'), `${line({ at: 'a', skill: 'adr', run: 'r', stage: 'gate', state: 'running' })}\n`);
  await fs.writeFile(path.join(dir, 'stale.jsonl'), `${line({ at: 'a', skill: 'adr', run: 'r2', stage: 'gate', state: 'running' })}\n`);
  const old = new Date(Date.now() - 3 * 86_400_000);
  await fs.utimes(path.join(dir, 'stale.jsonl'), old, old);

  const sessions = await readStages({ dir, maxAgeMs: 86_400_000 });
  assert.deepEqual(sessions.map(session => session.sessionId), ['fresh']);
  assert.deepEqual(await readStages({ dir: path.join(dir, 'missing'), maxAgeMs: 1 }), []);
});
