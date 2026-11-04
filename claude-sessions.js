'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { focusSession } = require('./plugins');
const { firstTicket, pathTicket } = require('./ticket');

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const RUNNING_DIR = path.join(CLAUDE_DIR, 'sessions');
const DAY_MS = 86_400_000;
const CHUNK_BYTES = 1 << 20;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Transcripts run to a hundred megabytes and are appended to, so each one is read once and
// then only from where the last scan stopped.
const transcripts = new Map();
let scanning = null;
// PR links already met, per projects dir, so a scan can tell which ones are new: a PR just
// made or opened in a session, worth a refresh now. A transcript read again from its start
// (rewritten shorter) only meets links already known.
const knownLinks = new Map();

// What a person typed, not a tool's result coming back as a user turn, nor the caveat Claude
// Code writes before a local command.
function promptText(record) {
  if (record.type !== 'user' || record.isMeta) return null;
  const content = record.message?.content;
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.find(block => block?.type === 'text')?.text ?? null : null;
}

// Claude Code itself appends a `pr-link` record to a session's transcript whenever a PR is
// created or opened in it. The link is read from there rather than from a branch: a session
// started in a folder above the repositories records none.
// Only the lines that can hold what is kept get parsed: a tool's schema names `Skill` too,
// but never followed by an input.
function readLines(text, entry) {
  for (const line of text.split('\n')) {
    const wantsCwd = !entry.cwd && line.includes('"cwd":');
    const wantsPrompt = !entry.prompted && line.includes('"type":"user"');
    if (!wantsCwd && !wantsPrompt && !line.includes('"type":"pr-link"') && !line.includes('"name":"Skill","input":')
      && !line.includes('"type":"ai-title"')) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (wantsCwd && typeof record.cwd === 'string') {
      entry.cwd = record.cwd;
      entry.entrypoint = record.entrypoint ?? null;
    }
    const prompt = wantsPrompt ? promptText(record) : null;
    if (prompt !== null) {
      entry.prompted = true;
      entry.promptTicket = firstTicket(prompt);
    }
    if (record.type === 'pr-link' && record.prUrl) entry.prUrls.add(record.prUrl);
    if (record.type === 'ai-title' && typeof record.aiTitle === 'string') entry.title = record.aiTitle;
    if (record.type === 'assistant' && Array.isArray(record.message?.content)) {
      for (const block of record.message.content) {
        if (block?.type === 'tool_use' && block.name === 'Skill' && typeof block.input?.skill === 'string') entry.lastSkill = block.input.skill;
      }
    }
  }
}

async function readNewLines(file, stat) {
  let entry = transcripts.get(file);
  if (!entry || stat.size < entry.offset) {
    entry = {
      offset: 0, mtimeMs: 0, cwd: null, sessionId: path.basename(file, '.jsonl'), prUrls: new Set(),
      entrypoint: null, prompted: false, promptTicket: null, title: null, lastSkill: null,
    };
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

// One transcript that cannot be read, deleted with its worktree mid-scan or unreadable, is
// dropped and counted; the others still get read.
async function scanNow(dir, maxAgeDays) {
  const since = Date.now() - maxAgeDays * DAY_MS;
  const seen = new Set();
  let unreadable = 0;
  const projects = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const project of projects.filter(entry => entry.isDirectory())) {
    const folder = path.join(dir, project.name);
    const names = await fs.readdir(folder).catch(() => []);
    for (const name of names.filter(entry => entry.endsWith('.jsonl'))) {
      const file = path.join(folder, name);
      const stat = await fs.stat(file).catch(() => null);
      if (!stat || stat.mtimeMs < since) continue;
      try {
        await readNewLines(file, stat);
        seen.add(file);
      } catch (error) {
        if (error.code !== 'ENOENT') unreadable += 1;
      }
    }
  }
  for (const file of transcripts.keys()) if (!seen.has(file)) transcripts.delete(file);

  const links = [...transcripts.values()].flatMap(entry => [...entry.prUrls]);
  const known = knownLinks.get(dir);
  // The first scan meets every link of the last weeks at once: none of them is news.
  const touched = known ? [...new Set(links.filter(url => !known.has(url)))] : [];
  knownLinks.set(dir, new Set([...(known ?? []), ...links]));
  return { unreadable, touched };
}

function scan({ dir = PROJECTS_DIR, maxAgeDays }) {
  scanning ??= scanNow(dir, maxAgeDays).finally(() => {
    scanning = null;
  });
  return scanning;
}

function sessionFor(prUrl) {
  let latest = null;
  for (const entry of transcripts.values()) {
    if (!entry.cwd || !SESSION_ID.test(entry.sessionId) || !entry.prUrls.has(prUrl)) continue;
    if (!latest || entry.mtimeMs > latest.mtimeMs) latest = entry;
  }
  return latest && { sessionId: latest.sessionId, cwd: latest.cwd };
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

// The content type stops a page from another site: sending JSON takes a preflight, which
// this server answers without granting. The address stops the rest of the network, the
// server listening on every interface, and the host a DNS rebinding.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function refusal({ contentType, remoteAddress, host }) {
  if (!LOOPBACK.has(remoteAddress)) return 'only from this machine';
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host ?? '')) return 'only on localhost';
  if (!contentType?.startsWith('application/json')) return 'JSON body expected';
  return null;
}

// execFile's own message spells out the whole command line, the AppleScript included.
const run = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 16 << 20 }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      const reason = String(stderr).trim() || error.message;
      reject(new Error(/-1743\b/.test(reason)
        ? `macOS refused PR Radar control of the terminal: allow it under System Settings › Privacy & Security › Automation (${reason})`
        : `${command} failed: ${reason}`));
    });
  });

const osascriptArgs = (lines, ...args) => [...['on run argv', ...lines, 'end run'].flatMap(line => ['-e', line]), ...args];
const activate = (app, exec) => exec('osascript', ['-e', `tell application "${app}" to activate`]);

async function openInTerminal(session, terminal, exec = run) {
  const lines = TERMINALS[terminal];
  if (!lines) throw new Error(`PR_RADAR_TERMINAL "${terminal}" unknown: ${Object.keys(TERMINALS).join(', ')}`);
  // Sessions often start in a worktree removed since: the `cd` would fail in a terminal
  // nobody reads, and the click look like it worked.
  await fs.access(session.cwd).catch(() => {
    throw new Error(`${session.cwd} no longer exists`);
  });
  await exec('osascript', osascriptArgs(lines, resumeCommand(session)));
}

const isAlive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

const cannotCheck = reason => new Error(`could not check whether the session is already running: ${reason}`);

// Not knowing is not "not running": guessing wrong would open a second copy, which forks the
// session. Only a missing registry, or a record gone with its process, means none.
// A record caught mid-write gets one more read before it counts as unreadable.
async function readRecord(file) {
  for (let attempt = 0; ; attempt += 1) {
    let text;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw cannotCheck(error.message);
    }
    try {
      const record = JSON.parse(text);
      if (typeof record.sessionId !== 'string' || !Number.isInteger(record.pid)) throw new Error(`unexpected record in ${file}`);
      return record;
    } catch (error) {
      if (attempt) throw cannotCheck(error.message);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}

// The interactive copies running now, most recently active first: a session can be resumed
// in several places.
async function liveRecords(dir) {
  let names;
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw cannotCheck(error.message);
  }
  const running = [];
  for (const name of names.filter(entry => entry.endsWith('.json'))) {
    const record = await readRecord(path.join(dir, name));
    if (!record || (record.kind ?? 'interactive') !== 'interactive') continue;
    if (record.pid > 0 && isAlive(record.pid)) running.push(record);
  }
  return running.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

// A `/clear` gives the running process a new session id and moves the old one to
// `formerNames`: that window no longer shows the PR's conversation, so only the current id
// counts.
async function runningPids(sessionId, dir = RUNNING_DIR) {
  return (await liveRecords(dir)).filter(record => record.sessionId === sessionId).map(record => record.pid);
}

// The sessions the board last listed, by id: the only ones the route resumes by id.
let listed = new Map();

// First match wins: the worktree's folder, then the latest PR it linked that names a ticket,
// then the first prompt.
function describe(entry, record, prTickets) {
  const cwd = entry?.cwd ?? record.cwd;
  const prUrls = [...(entry?.prUrls ?? [])];
  return {
    sessionId: entry?.sessionId ?? record.sessionId,
    cwd,
    name: record?.name ?? entry?.title ?? null,
    title: entry?.title ?? null,
    status: record?.status ?? null,
    updatedAt: Math.max(entry?.mtimeMs ?? 0, record?.updatedAt ?? 0),
    lastSkill: entry?.lastSkill ?? null,
    prUrls,
    ticket: pathTicket(cwd) ?? prUrls.map(url => prTickets.get(url)).findLast(Boolean) ?? entry?.promptTicket ?? null,
  };
}

// Every session of the last scan, plus the ones running that have not written yet, for the
// By PRD view. A headless `claude -p` run never waits on anyone, so it is left out. The
// registry only adds a status: one that cannot be read leaves every session without one,
// never off the list.
async function sessions({ prTickets = new Map(), dir = RUNNING_DIR } = {}) {
  const running = new Map();
  for (const record of await liveRecords(dir).catch(() => [])) if (!running.has(record.sessionId)) running.set(record.sessionId, record);
  const list = [];
  for (const entry of transcripts.values()) {
    const record = running.get(entry.sessionId);
    running.delete(entry.sessionId);
    if (!entry.cwd || !SESSION_ID.test(entry.sessionId) || entry.entrypoint === 'sdk-cli') continue;
    list.push(describe(entry, record, prTickets));
  }
  for (const record of running.values()) if (typeof record.cwd === 'string') list.push(describe(null, record, prTickets));
  list.sort((a, b) => b.updatedAt - a.updatedAt);
  listed = new Map(list.map(session => [session.sessionId, session]));
  return list;
}

function parseProcesses(psOutput) {
  const processes = new Map();
  for (const row of psOutput.split('\n')) {
    const match = row.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (match) processes.set(Number(match[1]), { ppid: Number(match[2]), tty: match[3], command: match[4] });
  }
  return processes;
}

const CLAUDE = /(^|\/)claude(\.exe)?$/;
const HERDR = /(^|\/)herdr$/;
// iTerm2 3.4+ parents its shells to an iTermServer living outside the app bundle.
const HOSTS = [
  ['herdr', HERDR],
  ['Terminal', /\/Terminal\.app\//],
  ['iTerm', /\/iTerm\.app\/|iTermServer/],
  ['Ghostty', /\/Ghostty\.app\//],
];

function hostsOf(pid, processes) {
  const hosts = [];
  const seen = new Set();
  for (let current = processes.get(pid); current && !seen.has(current.ppid); current = processes.get(current.ppid)) {
    seen.add(current.ppid);
    const parent = processes.get(current.ppid);
    const host = parent && HOSTS.find(([, pattern]) => pattern.test(parent.command))?.[0];
    if (host && hosts.at(-1) !== host) hosts.push(host);
  }
  return hosts;
}

// Every command above the session, nearest first: what a plugin reads to know whether the
// session is in an app of its own.
function ancestorsOf(pid, processes) {
  const ancestors = [];
  const seen = new Set([pid]);
  for (let ppid = processes.get(pid)?.ppid; processes.has(ppid) && !seen.has(ppid); ppid = processes.get(ppid).ppid) {
    seen.add(ppid);
    ancestors.push(processes.get(ppid).command);
  }
  return ancestors;
}

// herdr's own panes first, but any pane may hold the process: herdr only tags a pane once
// it has recognised the agent in it. A pane closing mid-search is skipped, not fatal.
async function focusHerdrPane(pid, herdr, exec) {
  let panes;
  try {
    panes = JSON.parse(await exec(herdr, ['pane', 'list'])).result.panes;
  } catch {
    return false;
  }
  panes.sort((a, b) => Number(b.agent === 'claude') - Number(a.agent === 'claude'));
  for (const pane of panes) {
    let info;
    try {
      info = JSON.parse(await exec(herdr, ['pane', 'process-info', '--pane', pane.pane_id])).result.process_info;
    } catch {
      continue;
    }
    if (!info.foreground_processes.some(processInfo => processInfo.pid === pid)) continue;
    try {
      await exec(herdr, ['agent', 'focus', pane.terminal_id]);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

// Terminal and iTerm name each tab's tty; Ghostty's dictionary does not, so a session in a
// plain Ghostty tab only gets its app brought forward.
const FOCUS_TTY = {
  Terminal: [
    'tell application "Terminal"',
    'repeat with w in windows',
    'repeat with t in tabs of w',
    'if tty of t is (item 1 of argv) then',
    'set selected of t to true',
    'set index of w to 1',
    'activate',
    'return "found"',
    'end if',
    'end repeat',
    'end repeat',
    'end tell',
  ],
  iTerm: [
    'tell application "iTerm"',
    'repeat with w in windows',
    'repeat with t in tabs of w',
    'repeat with s in sessions of t',
    'if tty of s is (item 1 of argv) then',
    'select s',
    'select t',
    'select w',
    'activate',
    'return "found"',
    'end if',
    'end repeat',
    'end repeat',
    'end repeat',
    'end tell',
  ],
};

// A copy that runs where it cannot be reached is an error, not a reason to open another:
// two processes on one session fork its history.
async function focusRunning(sessionId, { exec = run, dir = RUNNING_DIR, plugins = [] } = {}) {
  const pids = await runningPids(sessionId, dir);
  if (!pids.length) return false;
  const processes = parseProcesses(await exec('ps', ['-axo', 'pid=,ppid=,tty=,comm=']));
  const claudePids = pids.filter(pid => CLAUDE.test(processes.get(pid)?.command ?? ''));
  if (!claudePids.length) return false;
  const herdr = [...processes.values()].find(entry => entry.command.startsWith('/') && HERDR.test(entry.command))?.command ?? 'herdr';

  for (const pid of claudePids) {
    const [host, outer] = hostsOf(pid, processes);
    if (host === 'herdr') {
      const focused = await focusHerdrPane(pid, herdr, exec);
      if (outer) await activate(outer, exec);
      if (focused) return true;
      throw new Error(`this session is already open in herdr, but its pane could not be found${outer ? `: ${outer} is in front, look for it there` : ''}`);
    }
    if (FOCUS_TTY[host]) {
      const answer = await exec('osascript', osascriptArgs(FOCUS_TTY[host], `/dev/${processes.get(pid).tty}`));
      if (answer.trim() === 'found') return true;
    }
    if (host === 'Ghostty') {
      await activate('Ghostty', exec);
      return true;
    }
  }
  const failures = [];
  for (const pid of claudePids) {
    const session = { sessionId, pid, tty: processes.get(pid).tty, ancestors: ancestorsOf(pid, processes) };
    const answer = await focusSession(plugins, session);
    if (answer.focused) return true;
    failures.push(...answer.failures);
  }
  throw new Error(`this session is already open, in a terminal PR Radar cannot bring forward${failures.length ? ` (${failures.join('; ')})` : ''}`);
}

// The route, kept here with its guards so a test can drive it end to end.
async function resume({ headers, remoteAddress, readBody }, { enabled, terminal, board, plugins = [], exec = run, runningDir = RUNNING_DIR }) {
  if (!enabled) return [403, 'Claude sessions are off (PR_RADAR_CLAUDE_SESSIONS, macOS only)'];
  const refused = refusal({ contentType: headers['content-type'], remoteAddress, host: headers.host });
  if (refused) return [403, refused];
  let id;
  let sessionId;
  try {
    ({ id, sessionId } = await readBody());
  } catch {
    return [400, 'invalid JSON body'];
  }
  let session;
  // A session row of the By PRD view names its session; a card names its PR.
  if (sessionId !== undefined) {
    session = listed.get(sessionId);
    if (!session) return [404, 'this Claude session is not on the board'];
  } else {
    if (!board) return [503, 'the board has not loaded yet'];
    const pr = [...board.mine, ...board.reviews].find(entry => entry.id === id);
    if (!pr) return [404, 'this PR is not on the board'];
    session = sessionFor(pr.url);
    if (!session) return [404, 'no Claude session linked to this PR'];
  }
  try {
    if (!(await focusRunning(session.sessionId, { exec, dir: runningDir, plugins }))) await openInTerminal(session, terminal, exec);
    return [200, null];
  } catch (error) {
    return [502, error.message];
  }
}

module.exports = {
  scan,
  sessionFor,
  sessions,
  resumeCommand,
  openInTerminal,
  focusRunning,
  runningPids,
  parseProcesses,
  hostsOf,
  ancestorsOf,
  refusal,
  resume,
  TERMINALS,
};
