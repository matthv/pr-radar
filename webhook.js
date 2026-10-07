'use strict';

const { LOSING_SOURCES } = require('./github');

const STATUSES = [
  'mine.action', 'mine.ready', 'mine.waiting', 'mine.idle', 'mine.merged',
  'reviews.action', 'reviews.waiting', 'reviews.idle', 'reviews.merged',
];
const TIMEOUT_MS = 5000;

function parseStatuses(value) {
  const statuses = String(value ?? '')
    .split(',')
    .map(status => status.trim())
    .filter(Boolean);
  const bad = statuses.filter(status => !STATUSES.includes(status));
  if (bad.length) {
    throw new Error(`PR_RADAR_WEBHOOK_STATUSES: unknown status ${bad.join(', ')} (expected: ${STATUSES.join(', ')})`);
  }
  return statuses;
}

const statusOf = pr => `${pr.side}.${pr.bucket}`;

// A PR of mine whose mergeability GitHub has not computed, or failed to give, may carry a
// conflict its bucket does not show yet: it would go out as ready, then as action.
const unsure = pr => pr.side === 'mine' && !pr.merged && pr.mergeable === 'UNKNOWN';

function snapshot(board, { hideDrafts = false } = {}) {
  return new Map(
    [...board.mine, ...board.reviews]
      .filter(pr => !(hideDrafts && pr.isDraft))
      .map(pr => [pr.id, { status: statusOf(pr), url: pr.url, project: pr.repo, pr_number: pr.number, unsure: unsure(pr) }]),
  );
}

const incomplete = board => board.warnings.some(warning => LOSING_SOURCES.includes(warning.source));

const prOf = ({ url, project, pr_number }) => ({ url, project, pr_number });

// What changed since `previous`, and the snapshot to compare the next board with.
// - No previous picture: nothing is sent, and only a complete board becomes one, or the PRs
//   it missed would go out as new on the next.
// - An incomplete board sends the PRs new to it only. A PR it lost keeps its last status,
//   and a status change waits for a complete board.
// - An unsure PR keeps its last status; a new one stays new until it is sure. One unsure in
//   the first picture is corrected silently once known.
function step(previous, current, { incomplete: partial = false, statuses = [] } = {}) {
  if (!previous) return { events: [], next: partial ? null : current };
  const next = partial ? new Map(previous) : new Map();
  const byStatus = new Map();
  for (const [id, entry] of current) {
    const before = previous.get(id);
    const changed = before?.status !== entry.status;
    if (entry.unsure || (partial && before && changed)) {
      if (before) next.set(id, before);
      continue;
    }
    next.set(id, entry);
    if (!changed || before?.unsure) continue;
    if (statuses.length && !statuses.includes(entry.status)) continue;
    if (!byStatus.has(entry.status)) byStatus.set(entry.status, { status: entry.status, ...prOf(entry), prs: [] });
    byStatus.get(entry.status).prs.push(prOf(entry));
  }
  return { events: [...byStatus.values()], next };
}

async function send(url, events, { fetchImpl = fetch, log = console.error } = {}) {
  await Promise.all(
    events.map(async event => {
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(event),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch (error) {
        log(`[${new Date().toISOString()}] webhook ${event.status} ${event.url}: ${error.message}`);
      }
    }),
  );
}

function createNotifier({ url, statuses = [], hideDrafts = false, post = send }) {
  let previous = null;
  return {
    notify(board) {
      const { events, next } = step(previous, snapshot(board, { hideDrafts }), { incomplete: incomplete(board), statuses });
      previous = next;
      if (events.length) post(url, events);
      return events;
    },
  };
}

module.exports = { STATUSES, parseStatuses, statusOf, snapshot, incomplete, step, send, createNotifier };
