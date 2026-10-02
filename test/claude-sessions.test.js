'use strict';

const test = require('node:test');
const { describe } = test;
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { scan, sessionFor, resumeCommand, openInTerminal, refusal, runningPids, parseProcesses, hostsOf, focusRunning, resume } = require('../claude-sessions');

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

test('a running copy is found by its current session id only, most recently active first', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-radar-running-'));
  const register = (file, record) => fs.writeFile(path.join(dir, `${file}.json`), JSON.stringify(record));
  await register('a', { pid: process.pid, sessionId: OLDER, updatedAt: 1 });
  await register('b', { pid: process.ppid, sessionId: OLDER, updatedAt: 2 });
  await register('dead', { pid: 2 ** 22 + 1, sessionId: OLDER, updatedAt: 3 });
  await register('cleared', { pid: process.pid, sessionId: NEWER, formerNames: [{ sessionId: OLDER }], updatedAt: 4 });

  assert.deepEqual(await runningPids(OLDER, dir), [process.ppid, process.pid]);
  assert.deepEqual(await runningPids(OLDER, path.join(dir, 'no-registry-here')), []);
});

test('a registry that cannot be read is an error, never "not running": that would fork the session', async () => {
  const halfWritten = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-radar-running-'));
  await fs.writeFile(path.join(halfWritten, '12.json'), '{ "pid": 12, "sessi');
  await assert.rejects(runningPids(OLDER, halfWritten), /could not check/);

  const reshaped = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-radar-running-'));
  await fs.writeFile(path.join(reshaped, '12.json'), JSON.stringify({ process: 12, session: OLDER }));
  await assert.rejects(runningPids(OLDER, reshaped), /could not check/);

  const locked = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-radar-running-'));
  await fs.chmod(locked, 0o000);
  await assert.rejects(runningPids(OLDER, locked), /could not check/);
  await fs.chmod(locked, 0o700);
});

// The shape of `ps -axo pid=,ppid=,tty=,comm=`: the herdr and plain Ghostty rows as read on a
// real machine, the Terminal and VS Code ones written after them.
const PS = `
    1     0 ??       /sbin/launchd
  882     1 ??       /Applications/Ghostty.app/Contents/MacOS/ghostty
 1049   882 ttys000  /usr/bin/login
 1050  1049 ttys000  -/bin/zsh
 6055  1050 ttys000  herdr
 6056  6055 ??       /opt/homebrew/bin/herdr
 6073  6056 ttys011  -zsh
24347  6073 ttys011  claude
61638   882 ttys023  /usr/bin/login
61674 61638 ttys023  -/bin/zsh
62319 61674 ttys023  claude
  700     1 ??       /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal
  701   700 ttys030  /usr/bin/login
  702   701 ttys030  -zsh
  703   702 ttys030  claude
  900     1 ??       /Applications/Visual Studio Code.app/Contents/Framework/Code Helper
  901   900 ttys040  claude
`;

test('the terminals a session runs in are read from its process ancestry, innermost first', () => {
  const processes = parseProcesses(PS);
  assert.deepEqual(hostsOf(24347, processes), ['herdr', 'Ghostty']);
  assert.deepEqual(hostsOf(62319, processes), ['Ghostty']);
  assert.deepEqual(hostsOf(703, processes), ['Terminal']);
  assert.equal(processes.get(703).tty, 'ttys030');
  assert.deepEqual(hostsOf(901, processes), []);
  assert.deepEqual(hostsOf(424242, processes), []);
});

async function fakeMachine(parentRows, replies = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-radar-running-'));
  await fs.writeFile(path.join(dir, 'me.json'), JSON.stringify({ pid: process.pid, sessionId: OLDER, kind: 'interactive' }));
  const calls = [];
  const exec = async (command, args) => {
    calls.push([command, ...args]);
    if (command === 'ps') return `${parentRows}\n${process.pid} 5 ttys030  claude\n`;
    const reply = replies[`${command} ${args.join(' ')}`] ?? (command === 'osascript' ? '' : undefined);
    if (reply instanceof Error) throw reply;
    if (reply === undefined) throw new Error(`unexpected ${command} ${args.join(' ')}`);
    return typeof reply === 'string' ? reply : JSON.stringify(reply);
  };
  return { dir, exec, calls };
}

const IN_HERDR = `  2 1 ??  /Applications/Ghostty.app/Contents/MacOS/ghostty
  3 2 ttys000  herdr
  4 3 ??  /opt/homebrew/bin/herdr
  5 4 ttys030  -zsh`;
const herdrPanes = { result: { panes: [
  { pane_id: 'w1:p1', terminal_id: 'term_shell' },
  { pane_id: 'w1:p2', terminal_id: 'term_other', agent: 'claude' },
  { pane_id: 'w1:p3', terminal_id: 'term_mine', agent: 'claude' },
] } };
const holding = pid => ({ result: { process_info: { foreground_processes: [{ pid }] } } });

test('a session running in herdr gets its pane focused, then the app herdr runs in', async () => {
  const { dir, exec, calls } = await fakeMachine(IN_HERDR, {
    '/opt/homebrew/bin/herdr pane list': herdrPanes,
    '/opt/homebrew/bin/herdr pane process-info --pane w1:p2': new Error('pane closed'),
    '/opt/homebrew/bin/herdr pane process-info --pane w1:p3': holding(process.pid),
    '/opt/homebrew/bin/herdr agent focus term_mine': '{}',
  });

  assert.equal(await focusRunning(OLDER, { exec, dir }), true);
  const asked = calls.map(call => call.slice(1).join(' '));
  assert.deepEqual(asked.slice(1), [
    'pane list',
    'pane process-info --pane w1:p2',
    'pane process-info --pane w1:p3',
    'agent focus term_mine',
    '-e tell application "Ghostty" to activate',
  ]);
});

test('a herdr pane that cannot be focused brings the app forward, and says it missed the pane', async () => {
  const { dir, exec, calls } = await fakeMachine(IN_HERDR, {
    '/opt/homebrew/bin/herdr pane list': herdrPanes,
    '/opt/homebrew/bin/herdr pane process-info --pane w1:p1': holding(1),
    '/opt/homebrew/bin/herdr pane process-info --pane w1:p2': holding(1),
    '/opt/homebrew/bin/herdr pane process-info --pane w1:p3': holding(process.pid),
    '/opt/homebrew/bin/herdr agent focus term_mine': new Error('no such terminal'),
  });

  await assert.rejects(focusRunning(OLDER, { exec, dir }), /pane could not be found: Ghostty is in front/);
  assert.equal(calls.at(-1).join(' '), 'osascript -e tell application "Ghostty" to activate');

  const noHerdr = await fakeMachine(IN_HERDR, { '/opt/homebrew/bin/herdr pane list': new Error('spawn ENOENT') });
  await assert.rejects(focusRunning(OLDER, noHerdr), /pane could not be found/);
});

const IN_TERMINAL = `  2 1 ??  /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal
  5 2 ttys030  -zsh`;

test('in Terminal, the tab holding the session\'s tty is selected', async () => {
  const { dir, exec, calls } = await fakeMachine(IN_TERMINAL);
  const found = async (command, args) => (command === 'osascript' ? (await exec(command, args), 'found\n') : exec(command, args));

  assert.equal(await focusRunning(OLDER, { exec: found, dir }), true);
  assert.equal(calls.at(-1).at(-1), '/dev/ttys030');
});

test('a running session no terminal can bring forward is an error, not a second copy', async () => {
  const inTerminal = await fakeMachine(IN_TERMINAL);
  await assert.rejects(focusRunning(OLDER, inTerminal), /already open/);

  const inVsCode = await fakeMachine(`  5 1 ??  /Applications/Visual Studio Code.app/Contents/Framework/Code Helper`);
  await assert.rejects(focusRunning(OLDER, inVsCode), /already open/);
});

test('a registry pid now held by something other than claude counts as not running', async () => {
  const { dir } = await fakeMachine(IN_HERDR);
  const exec = async () => `${process.pid} 1 ??  /usr/sbin/cupsd\n`;

  assert.equal(await focusRunning(OLDER, { exec, dir }), false);
  assert.equal(await focusRunning(NEWER, { exec: () => assert.fail('nothing runs it'), dir }), false);
});

test('the resume command quotes the directory for the shell', () => {
  assert.equal(
    resumeCommand({ sessionId: OLDER, cwd: "/Users/me/it's here" }),
    `cd '/Users/me/it'\\''s here' && claude --resume ${OLDER}`,
  );
  assert.equal(resumeCommand({ sessionId: OLDER, cwd: '/a\n; rm -rf ~' }), `cd '/a\n; rm -rf ~' && claude --resume ${OLDER}`);
});

test('a transcript that cannot be read is counted and skipped, the others still read', async () => {
  const dir = await projectsDir();
  const locked = await writeSession(dir, NEWER, start('/Users/me/Projects') + prLink(NEWER, 'https://github.com/o/r/pull/2'));
  await fs.chmod(locked, 0o000);
  await writeSession(dir, OLDER, start('/Users/me/Projects') + prLink(OLDER, PR));

  assert.deepEqual(await scan({ dir, maxAgeDays: 60 }), { unreadable: 1 });
  assert.equal(sessionFor(PR)?.sessionId, OLDER);
  await fs.chmod(locked, 0o600);
});

describe('the resume route', () => {
  const request = (overrides = {}) => ({
    headers: { 'content-type': 'application/json', host: 'localhost:4321' },
    remoteAddress: '127.0.0.1',
    readBody: async () => ({ id: 'PR_1' }),
    ...overrides,
  });
  let board;
  let runningDir;
  test.before(async () => {
    const dir = await projectsDir();
    await writeSession(dir, OLDER, start(os.tmpdir()) + prLink(OLDER, PR));
    await scan({ dir, maxAgeDays: 60 });
    board = { mine: [{ id: 'PR_1', url: PR }, { id: 'PR_2', url: 'https://github.com/o/r/pull/2' }], reviews: [] };
    runningDir = path.join(dir, 'no-registry');
  });
  const context = overrides => ({ enabled: true, terminal: 'Ghostty', board, runningDir, exec: () => assert.fail('nothing should run'), ...overrides });

  test('turned off, or asked the wrong way, it does nothing', async () => {
    assert.equal((await resume(request(), context({ enabled: false })))[0], 403);
    assert.deepEqual(await resume(request({ headers: { host: 'localhost:4321' } }), context()), [403, 'JSON body expected']);
    assert.deepEqual(await resume(request({ remoteAddress: '10.0.0.4' }), context()), [403, 'only from this machine']);
    assert.deepEqual(await resume(request({ readBody: async () => JSON.parse('{') }), context()), [400, 'invalid JSON body']);
  });

  test('it says what is missing: the board, the PR, or a session', async () => {
    assert.deepEqual(await resume(request(), context({ board: null })), [503, 'the board has not loaded yet']);
    assert.deepEqual(await resume(request({ readBody: async () => ({ id: 'PR_X' }) }), context()), [404, 'this PR is not on the board']);
    assert.deepEqual(await resume(request({ readBody: async () => ({ id: 'PR_2' }) }), context()), [404, 'no Claude session linked to this PR']);
  });

  test('a session not running opens in the terminal, the command as an argument', async () => {
    const calls = [];
    const exec = async (command, args) => {
      calls.push([command, ...args]);
      return '';
    };

    assert.deepEqual(await resume(request(), context({ exec })), [200, null]);
    assert.equal(calls.length, 1);
    const [command, ...args] = calls[0];
    assert.equal(command, 'osascript');
    assert.ok(args.includes('tell application "Ghostty"'));
    assert.equal(args.at(-1), resumeCommand({ sessionId: OLDER, cwd: os.tmpdir() }));
  });

  test('a terminal that fails is reported, not swallowed', async () => {
    const exec = async () => {
      throw new Error('osascript failed: Not authorized to send Apple events to Ghostty. (-1743)');
    };
    const [status, message] = await resume(request(), context({ exec }));
    assert.equal(status, 502);
    assert.match(message, /-1743/);
  });
});

test('an unknown terminal is refused before anything runs', async () => {
  await assert.rejects(openInTerminal({ sessionId: OLDER, cwd: '/tmp' }, 'Hyper'), /unknown/);
});
