'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { scan, sessionFor, resumeCommand, openInTerminal, refusal } = require('../claude-sessions');

const PR = 'https://github.com/ForestAdmin/agent-nodejs/pull/1927';
const OLDER = '3c55fd04-f8b5-4508-8990-e3bac3f67cc7';
const NEWER = 'ed84f9ba-f28b-449c-89fd-70f2ed882a1b';

const line = record => `${JSON.stringify(record)}\n`;
const prLink = (sessionId, prUrl) => line({ type: 'pr-link', sessionId, prNumber: 1927, prUrl, prRepository: 'ForestAdmin/agent-nodejs' });
const start = cwd => line({ type: 'user', cwd, message: { role: 'user', content: 'hi' } });

async function projectsDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-radar-sessions-'));
  await fs.mkdir(path.join(dir, '-Users-me-Projects'));
  return dir;
}

async function writeSession(dir, sessionId, content, ageDays = 0) {
  const file = path.join(dir, '-Users-me-Projects', `${sessionId}.jsonl`);
  await fs.writeFile(file, content);
  const at = new Date(Date.now() - ageDays * 86_400_000);
  await fs.utimes(file, at, at);
  return file;
}

test('a PR worked on in two sessions resumes the most recently active one, from where it started', async () => {
  const dir = await projectsDir();
  await writeSession(dir, OLDER, start('/Users/me/Projects') + prLink(OLDER, PR), 3);
  await writeSession(dir, NEWER, line({ type: 'file-history-snapshot' }) + start('/Users/me/Projects/agent-nodejs') + prLink(NEWER, PR), 1);

  await scan({ dir, maxAgeDays: 60 });

  assert.deepEqual(sessionFor(PR), { sessionId: NEWER, cwd: '/Users/me/Projects/agent-nodejs' });
  assert.equal(sessionFor('https://github.com/ForestAdmin/agent-nodejs/pull/1'), null);
});

test('a session past the age limit, without a cwd, or not named by a session id is never offered', async () => {
  const dir = await projectsDir();
  await writeSession(dir, OLDER, start('/Users/me/Projects') + prLink(OLDER, PR), 90);
  await writeSession(dir, NEWER, prLink(NEWER, PR));
  await writeSession(dir, 'notes', start('/Users/me/Projects') + prLink('notes', PR));

  await scan({ dir, maxAgeDays: 60 });

  assert.equal(sessionFor(PR), null);
});

test('a line still being written is read once complete, and appended links are picked up', async () => {
  const dir = await projectsDir();
  const file = await writeSession(dir, OLDER, start('/Users/me/Projects') + prLink(OLDER, PR).slice(0, 40));

  await scan({ dir, maxAgeDays: 60 });
  assert.equal(sessionFor(PR), null);

  await fs.appendFile(file, prLink(OLDER, PR).slice(40));
  await scan({ dir, maxAgeDays: 60 });
  assert.equal(sessionFor(PR)?.sessionId, OLDER);
});

test('a line longer than one read chunk is still parsed', async () => {
  const dir = await projectsDir();
  const huge = line({ type: 'user', message: { content: 'x'.repeat(1_500_000) } });
  await writeSession(dir, OLDER, start('/Users/me/Projects') + huge + prLink(OLDER, PR));

  await scan({ dir, maxAgeDays: 60 });

  assert.equal(sessionFor(PR)?.sessionId, OLDER);
});

test('a character split across two read chunks is decoded whole', async () => {
  const dir = await projectsDir();
  const cwdLine = line({ type: 'user', cwd: '/Users/me/Projets/été' });
  const beforeE = Buffer.byteLength(cwdLine.slice(0, cwdLine.indexOf('é')));
  const paddingFor = n => line({ type: 'user', message: { content: 'x'.repeat(n) } });
  const padding = paddingFor((1 << 20) - 1 - beforeE - Buffer.byteLength(paddingFor(0)));
  assert.equal(Buffer.byteLength(padding) + beforeE, (1 << 20) - 1);
  await writeSession(dir, OLDER, padding + cwdLine + prLink(OLDER, PR));

  await scan({ dir, maxAgeDays: 60 });

  assert.equal(sessionFor(PR)?.cwd, '/Users/me/Projets/été');
});

test('a transcript rewritten shorter is read again from the start', async () => {
  const dir = await projectsDir();
  const file = await writeSession(dir, OLDER, start('/Users/me/Projects') + prLink(OLDER, PR));
  await scan({ dir, maxAgeDays: 60 });

  await fs.writeFile(file, start('/Users/me/Projects'));
  await scan({ dir, maxAgeDays: 60 });

  assert.equal(sessionFor(PR), null);
});

test('only a JSON request from this machine, to localhost, is let through', () => {
  const ok = { contentType: 'application/json', remoteAddress: '127.0.0.1', host: 'localhost:4321' };
  assert.equal(refusal(ok), null);
  assert.equal(refusal({ ...ok, remoteAddress: '::1', host: '[::1]:4321' }), null);
  assert.equal(refusal({ ...ok, remoteAddress: '192.168.1.20' }), 'only from this machine');
  assert.equal(refusal({ ...ok, host: 'evil.example:4321' }), 'only on localhost');
  assert.equal(refusal({ ...ok, host: undefined }), 'only on localhost');
  assert.equal(refusal({ ...ok, contentType: 'text/plain' }), 'JSON body expected');
});

test('a session whose folder is gone says so instead of opening a terminal', async () => {
  await assert.rejects(openInTerminal({ sessionId: OLDER, cwd: '/nowhere/agent-nodejs-prd1183' }, 'Terminal'), /no longer exists/);
});

test('the resume command quotes the directory for the shell', () => {
  assert.equal(
    resumeCommand({ sessionId: OLDER, cwd: "/Users/me/it's here" }),
    `cd '/Users/me/it'\\''s here' && claude --resume ${OLDER}`,
  );
});

test('an unknown terminal is refused before anything runs', async () => {
  await assert.rejects(openInTerminal({ sessionId: OLDER, cwd: '/tmp' }, 'Hyper'), /unknown/);
});
