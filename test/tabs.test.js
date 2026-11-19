'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const TIMEOUT = { timeout: 10_000 };

async function startServer() {
  const port = 20_000 + Math.floor(Math.random() * 30_000);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), PR_RADAR_DEMO: 'true', PR_RADAR_SELF_RESTART: '0' },
    stdio: 'ignore',
  });
  const base = `http://localhost:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await fetch(`${base}/api/boot`).then(r => r.ok, () => false)) return { base, port, stop: () => child.kill() };
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error('the server did not start');
}

const browsers = async base => (await fetch(`${base}/api/boot`).then(r => r.json())).browsers;

async function until(check) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('condition never met');
}

async function openStream(base, headers = {}) {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/tabs`, { headers, signal: controller.signal });
  return { response, close: () => controller.abort() };
}

test('open browsers: counted while their stream is open, forgotten once it closes', TIMEOUT, async t => {
  const { base, stop } = await startServer();
  t.after(stop);
  assert.equal(await browsers(base), 0);

  const first = await openStream(base, { 'Sec-Fetch-Site': 'same-origin' });
  assert.equal(first.response.headers.get('content-type'), 'text/event-stream');
  const { value } = await first.response.body.getReader().read();
  assert.match(Buffer.from(value).toString(), /^retry: 1000\n\n/);
  const second = await openStream(base);
  await until(async () => (await browsers(base)) === 2);

  first.close();
  await until(async () => (await browsers(base)) === 1);
  second.close();
  await until(async () => (await browsers(base)) === 0);
});

test('open browsers: the launcher reads the raw count', TIMEOUT, async t => {
  const { base, stop } = await startServer();
  t.after(stop);
  const stream = await openStream(base);
  t.after(stream.close);
  await until(async () => /"browsers":[1-9]/.test(await fetch(`${base}/api/boot`).then(r => r.text())));
});

test('open browsers: another site, another app on localhost or a typed URL cannot pass for one', TIMEOUT, async t => {
  const { base, stop } = await startServer();
  t.after(stop);
  for (const site of ['cross-site', 'same-site', 'none']) {
    const refused = await fetch(`${base}/api/tabs`, { headers: { 'Sec-Fetch-Site': site } });
    assert.equal(refused.status, 403, site);
  }
  assert.equal(await browsers(base), 0);
});

test('open browsers: refused under another host name', TIMEOUT, async t => {
  const { port, base, stop } = await startServer();
  t.after(stop);
  const status = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/tabs', headers: { Host: `evil.example:${port}` } }, res => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject);
  });
  assert.equal(status, 403);
  assert.equal(await browsers(base), 0);
});

test('open browsers: no more than twenty streams', TIMEOUT, async t => {
  const { base, stop } = await startServer();
  t.after(stop);
  const streams = [];
  t.after(() => streams.forEach(stream => stream.close()));
  for (let i = 0; i < 20; i += 1) streams.push(await openStream(base));
  assert.equal((await fetch(`${base}/api/tabs`)).status, 429);
  assert.equal(await browsers(base), 20);
});

test('open browsers: the page holds the stream', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(page, /new EventSource\('\/api\/tabs'\)/);
  assert.match(page, /navigator\.locks\.request\('pr-radar:tabs'/);
  assert.match(page, /\.onerror = /);
});
