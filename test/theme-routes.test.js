'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const ANSWER = '```css\n.zest-sky { color: teal; }\n```\n```js\nPRRadarTheme.register({});\n```\n';

// The user's .env must not switch on Slack, a webhook or anything else reaching out: a value
// set here wins over it, since loadEnvFile never overrides the environment.
const QUIET = {
  ...Object.fromEntries([
    'PR_RADAR_SLACK_TOKEN', 'PR_RADAR_SLACK_CHANNEL', 'PR_RADAR_WEBHOOK_URL', 'PR_RADAR_ORPHAN_DAYS',
    'PR_RADAR_SOUND', 'PR_RADAR_CLAUDE_SESSIONS', 'PR_RADAR_THEME', 'PR_RADAR_EXTRA_REPOS',
  ].map(key => [key, ''])),
  PR_RADAR_CHECK_SECONDS: '0',
  PR_RADAR_UPDATE_HOURS: '0',
};

async function fakeClaude() {
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-radar-fake-claude-'));
  const calls = path.join(bin, 'calls');
  await fs.writeFile(path.join(bin, 'answer'), ANSWER);
  await fs.writeFile(path.join(bin, 'claude'), `#!/bin/sh
[ "$1" = "--version" ] && exit 0
echo called >> "${calls}"
cat > /dev/null
cat "${path.join(bin, 'answer')}"
`, { mode: 0o755 });
  await fs.writeFile(path.join(bin, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  return { bin, called: () => fs.access(calls).then(() => true, () => false) };
}

async function startServer(env) {
  const port = 20_000 + Math.floor(Math.random() * 30_000);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, ...QUIET, PORT: String(port), PR_RADAR_SELF_RESTART: '0', ...env },
    stdio: 'ignore',
  });
  const base = `http://localhost:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const ready = await fetch(`${base}/api/themes`).then(r => r.json(), () => null);
    if (ready && (env.PR_RADAR_DEMO || ready.canGenerate)) return { base, stop: () => child.kill() };
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error('the server did not start');
}

const send = (base, method, route, { json = true, body } = {}) => fetch(`${base}${route}`, {
  method,
  headers: json ? { 'Content-Type': 'application/json' } : {},
  body: body && JSON.stringify(body),
});

test('theme routes: generate, serve, refuse and remove a custom theme', async t => {
  const custom = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-radar-routes-'));
  const claude = await fakeClaude();
  const { base, stop } = await startServer({
    PR_RADAR_ORG: 'acme', PR_RADAR_CUSTOM_THEMES_DIR: custom, PATH: `${claude.bin}:${process.env.PATH}`,
  });
  t.after(stop);
  const theme = { label: 'Zest Sky', icon: '🍋', description: 'citrus at dawn' };

  const refused = await send(base, 'POST', '/api/themes', { json: false, body: theme });
  assert.equal(refused.status, 403);
  assert.equal(await claude.called(), false, 'a refused request never reaches claude');

  const made = await send(base, 'POST', '/api/themes', { body: theme });
  assert.equal(made.status, 200);
  const { name, catalog } = await made.json();
  assert.equal(name, 'zest-sky');
  assert.ok(catalog.themes.some(entry => entry.name === 'zest-sky' && entry.custom));
  assert.deepEqual((await fs.readdir(custom)).sort(), ['.generating', 'zest-sky']);
  assert.deepEqual(await fs.readdir(path.join(custom, '.generating')), [], 'nothing left half drawn');

  const again = await send(base, 'POST', '/api/themes', { body: theme });
  assert.equal(again.status, 422);
  assert.deepEqual(await again.json().then(body => [body.reason, body.params]), ['exists', { name: 'zest-sky' }]);

  const css = await fetch(`${base}/themes/zest-sky/theme.css`);
  assert.equal(css.status, 200);
  assert.match(await css.text(), /zest-sky/);
  assert.equal((await fetch(`${base}/themes/zest-sky/missing.css`)).status, 404);

  const malformed = await send(base, 'DELETE', '/api/themes/%E0');
  assert.equal(malformed.status, 404);
  assert.equal((await fetch(`${base}/api/boot`)).status, 200, 'still up');

  const removed = await send(base, 'DELETE', '/api/themes/zest-sky');
  assert.equal(removed.status, 200);
  assert.ok(!(await removed.json()).catalog.themes.some(entry => entry.name === 'zest-sky'));
  await assert.rejects(fs.access(path.join(custom, 'zest-sky')));
});

test('theme routes: the demo neither generates nor removes', async t => {
  const { base, stop } = await startServer({ PR_RADAR_DEMO: 'true' });
  t.after(stop);
  for (const [method, route] of [['POST', '/api/themes'], ['DELETE', '/api/themes/halloween']]) {
    const response = await send(base, method, route, { body: {} });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).reason, 'demo');
  }
});

test('theme page: a Content-Security-Policy keeps the page on this machine', async t => {
  const { base, stop } = await startServer({ PR_RADAR_DEMO: 'true' });
  t.after(stop);
  const csp = (await fetch(base)).headers.get('content-security-policy');
  assert.match(csp, /connect-src 'self'/);
  assert.match(csp, /img-src 'self' data: https:\/\/github\.com/);
});

test('hub route: a body that is no object is refused, and the server stays up', async t => {
  const { base, stop } = await startServer({ PR_RADAR_DEMO: 'true' });
  t.after(stop);
  for (const body of [null, [], 'x', 42]) {
    const response = await fetch(`${base}/api/hub`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  const response = await send(base, 'POST', '/api/hub', { body: { action: 'kudos', to: ['bexchauveto'] } });
  assert.equal(response.status, 200);
  assert.equal((await fetch(`${base}/api/themes`)).status, 200);
});
