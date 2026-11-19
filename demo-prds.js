'use strict';

// The PRDs and Sessions views' demo: made-up Linear tickets, skill stages, running sessions and
// transcripts, shaped like what linear.js, skill-stages.js and claude-sessions.js return, fed
// through the real builders so the demo cannot drift from what the views do.

const { buildPrds, buildSessions, sessionStatuses } = require('./prds');

const MIN = 60_000;
const STARTED_AT = Date.now();
const at = minutes => new Date(STARTED_AT - minutes * MIN).toISOString();
const ms = minutes => STARTED_AT - minutes * MIN;
// The board demo's own PRs, at the URLs it gives them, so a session's links point at cards it draws.
const pr = (repo, number) => `https://github.com/ForestAdmin/${repo}/pulls?q=${number}`;
const PR = {
  inboxFront: pr('forestadmin', 10012),
  inboxServer: pr('forestadmin-server', 8561),
  trigger: pr('forestadmin-server', 8549),
  schema: pr('agent-nodejs', 1951),
};

const ID = {
  backend: '0f6c2a51-3d8e-4b7a-9c12-5e8f7a6b4c31',
  review: '1a7d3b62-4e9f-4c8b-8d23-6f9a8b7c5d42',
  exports: '2b8e4c73-5fa0-4d9c-9e34-7a0b9c8d6e53',
  front: '3c9f5d84-6ab1-4ead-8f45-8b1cad9e7f64',
  schema: '4da06e95-7bc2-4fbe-9a56-9c2dbeaf8075',
  spec: '5eb17fa6-8cd3-40cf-ab67-ad3ecfb09186',
  firstPass: '6fc280b7-9de4-41d0-bc78-be4fd0c1a297',
};

const status = (name, type, color, position) => ({ name, type, color, position });
const IN_PROGRESS = status('In Progress', 'started', '#f2c94c', 2);
const IN_REVIEW = status('In Review', 'started', '#0f783c', 3);
const FEATURE = { name: 'Feature', color: '#5e6ad2' };
const PERF = { name: 'Performance', color: '#f2994a' };
const BUG = { name: 'Bug', color: '#eb5757' };

// No attached PRs: the board's PRs naming each ticket are its PRs, as they are for a real one.
const ticket = (key, title, { state = IN_PROGRESS, project, projectColor, labels, assigned = true, createdMin, updatedMin }) => ({
  ticket: key,
  title,
  url: `https://linear.app/forestadmin/issue/${key}`,
  createdAt: at(createdMin),
  updatedAt: at(updatedMin),
  status: state,
  project,
  projectColor,
  labels,
  prs: [],
  assigned,
});

const TICKETS = [
  ticket('PRD-812', 'Show the automation status of each inbox', {
    project: 'Inbox', projectColor: '#26b5ce', labels: [FEATURE], createdMin: 6 * 24 * 60, updatedMin: 40,
  }),
  ticket('PRD-845', 'Require the On data change trigger on automated workflows', {
    state: IN_REVIEW, project: 'Workflows', projectColor: '#bb87fc', labels: [FEATURE], assigned: false, createdMin: 9 * 24 * 60, updatedMin: 30,
  }),
  ticket('PRD-871', 'Stream large CSV exports instead of building them in memory', {
    project: 'Exports', projectColor: '#4cb782', labels: [PERF], createdMin: 3 * 24 * 60, updatedMin: 12,
  }),
  ticket('PRD-880', 'Cancel a pending approval request', {
    project: 'Workflows', projectColor: '#bb87fc', labels: [BUG], createdMin: 2 * 24 * 60, updatedMin: 5 * 60,
  }),
];

// Every two minutes the back-end session works for one, then asks a question: the view moves and
// the chime has something to ring for.
const CYCLE_MS = 2 * MIN;
function phase(now) {
  const into = (now - STARTED_AT) % CYCLE_MS;
  const asking = into >= CYCLE_MS / 2;
  return { asking, since: now - into + (asking ? CYCLE_MS / 2 : 0) };
}

function stages(now) {
  const { asking, since } = phase(now);
  const cycleStart = new Date(since).toISOString();
  const session = (sessionId, current, tickets, prUrls) => ({
    sessionId, current, tickets: new Set(tickets), prs: new Set(), prUrls: new Set(prUrls), at: current.at,
  });
  return [
    session(ID.backend, asking
      ? { skill: 'forest:implement', run: 'r1', stage: 'code', state: 'waiting', question: 'Keep the old inbox payload for v1 agents, or bump the version?', at: cycleStart }
      : { skill: 'forest:implement', run: 'r1', stage: 'tests', state: 'running', at: cycleStart }, ['PRD-812'], [PR.inboxServer]),
    session(ID.review, { skill: 'forest:validator', run: 'r2', stage: 'verify', state: 'running', at: at(4) }, ['PRD-845'], [PR.trigger]),
    session(ID.front, { skill: 'forest:review-loop', run: 'r3', stage: 'settle', state: 'done', outcome: 'ready', at: at(6) }, ['PRD-812'], [PR.inboxFront]),
  ];
}

const live = now => {
  const { asking, since } = phase(now);
  const record = (sessionId, pid, state, sinceMs, waitingFor = null) => ({
    sessionId, pid, kind: 'interactive', status: state, waitingFor, updatedAt: sinceMs, statusUpdatedAt: sinceMs,
  });
  return [
    record(ID.backend, 41001, asking ? 'idle' : 'busy', since),
    record(ID.review, 41002, 'busy', ms(4)),
    record(ID.exports, 41003, 'waiting', ms(2), 'permission prompt'),
    record(ID.front, 41004, 'idle', ms(6)),
    record(ID.schema, 41005, 'idle', ms(2 * 60)),
  ];
};

const HOME = '/Users/demo/Sites';
const details = (title, { summary = null, prompt = null, branch, folder, prUrls = [], minutes }) => ({
  title, summary, summaryAt: summary && at(minutes), prompt, promptAt: prompt && at(minutes + 1),
  branch, cwd: `${HOME}/${folder}`, folder: `${HOME}/${folder}`, prUrls, at: at(minutes),
});

const DETAILS = {
  [ID.backend]: details('Inbox automation status, back end', {
    summary: 'Added the automationStatus field to the inbox serializer; writing the request specs before touching the v1 payload.',
    branch: 'feature/prd-812-inbox-automation-status', folder: 'forestadmin-server', prUrls: [PR.inboxServer], minutes: 1,
  }),
  [ID.review]: details('Validator on the On data change trigger', {
    prompt: '/validator ForestAdmin/forestadmin-server#8549', branch: 'main', folder: 'forestadmin-server', minutes: 4,
  }),
  [ID.exports]: details('Stream CSV exports', {
    summary: 'Replaced the in-memory buffer with a cursor stream; about to run the export suite against a 2M-row fixture.',
    branch: 'feature/prd-871-stream-csv-exports', folder: 'forestadmin-server', minutes: 2,
  }),
  [ID.front]: details('Inbox settings panel', {
    summary: 'The review loop is done: both threads answered and CI green. Ready for you to merge.',
    branch: 'feature/prd-812-inbox-settings-panel', folder: 'forestadmin', prUrls: [PR.inboxFront], minutes: 6,
  }),
  [ID.schema]: details('Schema prefix on native queries', {
    prompt: 'the native query loses the schema prefix on Postgres, can you find why?', branch: 'fix/native-query-schema', folder: 'agent-nodejs', prUrls: [PR.schema], minutes: 2 * 60,
  }),
  [ID.spec]: details('PRD-812 spec and plan', {
    summary: 'Plan written: one endpoint field, one settings badge, no migration.', branch: 'main', folder: 'forestadmin-server', minutes: 26 * 60,
  }),
  [ID.firstPass]: details('First pass on PRD-845', {
    summary: 'Found the trigger check in the executor; the front still lets you save without it.', branch: 'main', folder: 'agent-nodejs', minutes: 30 * 60,
  }),
};

// The transcripts that declared work on each ticket, as claude-sessions.js weighs them.
const MENTIONS = {
  'PRD-812': [{ sessionId: ID.spec, weight: 3, minutes: 26 * 60 }],
  'PRD-845': [{ sessionId: ID.firstPass, weight: 3, minutes: 30 * 60 }],
  'PRD-871': [{ sessionId: ID.exports, weight: 4, minutes: 2 }],
};
const sessionsOf = key => (MENTIONS[key] ?? []).map(({ minutes, ...mention }) => ({ ...mention, cwd: DETAILS[mention.sessionId].cwd, at: at(minutes) }));
const OPENED_IN = new Map([[PR.inboxServer, ID.backend], [PR.inboxFront, ID.front], [PR.schema, ID.schema]]);
const sessionFor = url => (OPENED_IN.has(url) ? { sessionId: OPENED_IN.get(url), cwd: DETAILS[OPENED_IN.get(url)].cwd } : null);
const cwdOf = id => DETAILS[id]?.cwd ?? null;

function view(boardPrs, now = Date.now()) {
  const stageSessions = stages(now);
  const running = live(now);
  const prds = buildPrds({ prds: TICKETS, boardPrs, stageSessions, live: running, sessionFor, sessionsOf, cwdOf });
  return {
    enabled: true,
    linear: true,
    claudeSessions: true,
    sessionChime: true,
    warnings: [],
    prds,
    sessions: buildSessions({ prds, boardPrs, stageSessions, live: running, detailsOf: id => DETAILS[id] ?? null, cwdOf }),
  };
}

const statuses = (now = Date.now()) => ({ enabled: true, sessions: sessionStatuses({ stageSessions: stages(now), live: live(now) }) });

module.exports = { view, statuses, CYCLE_MS, STARTED_AT };
