'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');

// Claude Code itself appends a `pr-link` record to a session's transcript whenever a PR is
// created or opened in it: the link is read from there, never guessed from a branch, since
// a session started outside a repository records no branch at all.
const PROJECTS_DIR = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'projects');
const DAY_MS = 86_400_000;
const CHUNK_BYTES = 1 << 20;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Transcripts run to a hundred megabytes and only ever grow, so each one is read once and
// then only from where the last scan stopped.
const transcripts = new Map();
let scanning = null;

function readLines(text, entry) {
  for (const line of text.split('\n')) {
    const wantsCwd = !entry.cwd && line.includes('"cwd":');
    if (!wantsCwd && !line.includes('"type":"pr-link"')) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (wantsCwd && typeof record.cwd === 'string') entry.cwd = record.cwd;
    if (record.type === 'pr-link' && record.prUrl) entry.prUrls.add(record.prUrl);
  }
}

async function readNewLines(file, stat) {
  let entry = transcripts.get(file);
  if (!entry || stat.size < entry.offset) {
    entry = { offset: 0, mtimeMs: 0, cwd: null, sessionId: path.basename(file, '.jsonl'), prUrls: new Set() };
    transcripts.set(file, entry);
  }
  entry.mtimeMs = stat.mtimeMs;
  if (stat.size === entry.offset) return;

  const handle = await fs.open(file);
  try {
    // Chunks of an unfinished line are joined once, at its end: a line of tens of megabytes
    // would otherwise be copied again on every read.
    let carry = [];
    let carryBytes = 0;
    let position = entry.offset;
    while (position < stat.size) {
      const chunk = Buffer.alloc(CHUNK_BYTES);
      const { bytesRead } = await handle.read(chunk, 0, CHUNK_BYTES, position);
      if (!bytesRead) break;
      position += bytesRead;
      const read = chunk.subarray(0, bytesRead);
      const lastNewline = read.lastIndexOf(10);
      if (lastNewline === -1) {
        carry.push(read);
        carryBytes += bytesRead;
        continue;
      }
      readLines(Buffer.concat([...carry, read.subarray(0, lastNewline)]).toString('utf8'), entry);
      carry = [read.subarray(lastNewline + 1)];
      carryBytes = bytesRead - lastNewline - 1;
      // A line still being written is left for the next scan to read whole.
      entry.offset = position - carryBytes;
    }
  } finally {
    await handle.close();
  }
}

async function scanNow(dir, maxAgeDays) {
  const since = Date.now() - maxAgeDays * DAY_MS;
  const seen = new Set();
  const projects = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const project of projects.filter(entry => entry.isDirectory())) {
    const folder = path.join(dir, project.name);
    const names = await fs.readdir(folder).catch(() => []);
    for (const name of names.filter(entry => entry.endsWith('.jsonl'))) {
      const file = path.join(folder, name);
      const stat = await fs.stat(file).catch(() => null);
      if (!stat || stat.mtimeMs < since) continue;
      seen.add(file);
      await readNewLines(file, stat);
    }
  }
  for (const file of transcripts.keys()) if (!seen.has(file)) transcripts.delete(file);
}

function scan({ dir = PROJECTS_DIR, maxAgeDays }) {
  scanning ??= scanNow(dir, maxAgeDays).finally(() => {
    scanning = null;
  });
  return scanning;
}

// The most recently active one: a PR revisited in a later session is picked up where it
// was last worked on.
function sessionFor(prUrl) {
  let best = null;
  for (const entry of transcripts.values()) {
    if (!entry.cwd || !SESSION_ID.test(entry.sessionId) || !entry.prUrls.has(prUrl)) continue;
    if (!best || entry.mtimeMs > best.mtimeMs) best = entry;
  }
  return best && { sessionId: best.sessionId, cwd: best.cwd };
}

const shellQuote = value => `'${value.replaceAll("'", `'\\''`)}'`;

// `--resume` only finds a session from the directory it was started in.
function resumeCommand({ sessionId, cwd }) {
  return `cd ${shellQuote(cwd)} && claude --resume ${sessionId}`;
}

// Typed into the user's own shell rather than run as the terminal's command, so the PATH
// that finds `claude` is the one their shell sets up. The command is passed as an argument,
// never spliced into the script.
const TERMINALS = {
  Terminal: ['tell application "Terminal"', 'activate', 'do script (item 1 of argv)', 'end tell'],
  iTerm: [
    'tell application "iTerm"',
    'activate',
    'create window with default profile',
    'tell current session of current window to write text (item 1 of argv)',
    'end tell',
  ],
  Ghostty: [
    'tell application "Ghostty"',
    'activate',
    'new window with configuration {initial input:(item 1 of argv) & linefeed}',
    'end tell',
  ],
};

// The content type stops a page from another site, which cannot send JSON without a
// preflight this server never answers. The address stops the rest of the network, the
// server listening on every interface, and the host a DNS rebinding.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function refusal({ contentType, remoteAddress, host }) {
  if (!LOOPBACK.has(remoteAddress)) return 'only from this machine';
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host ?? '')) return 'only on localhost';
  if (!contentType?.startsWith('application/json')) return 'JSON body expected';
  return null;
}

async function openInTerminal(session, terminal) {
  const lines = TERMINALS[terminal];
  if (!lines) throw new Error(`PR_RADAR_TERMINAL "${terminal}" unknown: ${Object.keys(TERMINALS).join(', ')}`);
  // Sessions often start in a worktree removed since: the `cd` would fail in a terminal
  // nobody reads, and the click look like it worked.
  await fs.access(session.cwd).catch(() => {
    throw new Error(`${session.cwd} no longer exists`);
  });
  const script = ['on run argv', ...lines, 'end run'].flatMap(line => ['-e', line]);
  return new Promise((resolve, reject) => {
    execFile('osascript', [...script, resumeCommand(session)], error => (error ? reject(error) : resolve()));
  });
}

module.exports = { scan, sessionFor, resumeCommand, openInTerminal, refusal, TERMINALS };
