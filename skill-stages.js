'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

// claudine's skills append one line per stage to <dir>/<session id>.jsonl (its
// scripts/record-stage.mjs): the skill, its run, the stage it entered, a question it waits on,
// how it ended. The files hold a few lines per run, so each read takes them whole.
const STAGES_DIR = process.env.SKILL_STAGES_DIR
  || path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'skill-stages');
const ENDED = new Set(['done', 'stopped']);

function parseLines(text) {
  const lines = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    try {
      const line = JSON.parse(raw);
      if (line?.v === 1 && typeof line.skill === 'string' && typeof line.run === 'string') lines.push(line);
    } catch {
      // A line still being written, or not one of record-stage's.
    }
  }
  return lines;
}

// Per session: each run as its last line says, the run in front first. A skill another one
// runs, /validator inside /review-loop, has its own run: the one still going and most recently
// heard from is what the session is doing, else the last one to have ended.
function summarise(sessionId, lines) {
  const runs = new Map();
  for (const line of lines) {
    const run = runs.get(line.run) ?? { skill: line.skill, run: line.run, tickets: new Set(), prs: new Set() };
    if (line.ticket) run.tickets.add(line.ticket);
    for (const pr of line.prs ?? []) run.prs.add(pr);
    Object.assign(run, {
      repo: line.repo ?? run.repo ?? null,
      stage: line.stage ?? null,
      state: line.state,
      question: line.state === 'waiting' ? line.question ?? null : null,
      outcome: line.outcome ?? null,
      why: line.why ?? null,
      at: line.at,
    });
    runs.set(line.run, run);
  }
  const ordered = [...runs.values()].sort((a, b) => ENDED.has(a.state) - ENDED.has(b.state) || String(b.at).localeCompare(String(a.at)));
  return {
    sessionId,
    current: ordered[0] ?? null,
    tickets: new Set(ordered.flatMap(run => [...run.tickets])),
    prs: new Set(ordered.flatMap(run => [...run.prs])),
    at: ordered.reduce((latest, run) => (String(run.at) > latest ? String(run.at) : latest), ''),
  };
}

// `owner/repo#n` as record-stage writes it, the URL the board knows a PR by.
const prUrl = ref => {
  const match = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(ref);
  return match ? `https://github.com/${match[1]}/pull/${match[2]}` : null;
};

// The sessions that wrote a stage within `maxAgeMs`. A folder that does not exist yet is no
// session at all; one that cannot be read throws, so the view can say so.
async function readStages({ dir = STAGES_DIR, maxAgeMs, now = Date.now() } = {}) {
  let names;
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const sessions = [];
  for (const name of names.filter(entry => entry.endsWith('.jsonl'))) {
    const file = path.join(dir, name);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat || now - stat.mtimeMs > maxAgeMs) continue;
    const text = await fs.readFile(file, 'utf8').catch(() => null);
    if (text === null) continue;
    const session = summarise(path.basename(name, '.jsonl'), parseLines(text));
    if (session.current) sessions.push({ ...session, prUrls: new Set([...session.prs].map(prUrl).filter(Boolean)) });
  }
  return sessions;
}

module.exports = { readStages, summarise, parseLines, prUrl, STAGES_DIR };
