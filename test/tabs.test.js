'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');

async function startServer() {
  const port = 20_000 + Math.floor(Math.random() * 30_000);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), PR_RADAR_DEMO: 'true', PR_RADAR_SELF_RESTART: '0' },
    stdio: 'ignore',
  });
  const base = `http://localhost:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await fetch(`${base}/api/boot`).then(r => r.ok, () => false)) return { base, stop: () => child.kill() };
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error('the server did not start');
}

const tabs = async base => (await fetch(`${base}/api/boot`).then(r => r.json())).tabs;

async function until(check) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('condition never met');
}

test('open tabs: counted while their stream is open, forgotten once it closes', async t => {
  const { base, stop } = await startServer();
  t.after(stop);
  assert.equal(await tabs(base), 0);

  const first = new AbortController();
  const second = new AbortController();
  const stream = await fetch(`${base}/api/tabs`, { signal: first.signal });
  assert.equal(stream.headers.get('content-type'), 'text/event-stream');
  await fetch(`${base}/api/tabs`, { signal: second.signal });
  await until(async () => (await tabs(base)) === 2);

  first.abort();
  await until(async () => (await tabs(base)) === 1);
  second.abort();
  await until(async () => (await tabs(base)) === 0);
});
