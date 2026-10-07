'use strict';

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

function snapshot(board, { hideDrafts = false } = {}) {
  return new Map(
    [...board.mine, ...board.reviews]
      .filter(pr => !(hideDrafts && pr.isDraft))
      .map(pr => [pr.id, { status: statusOf(pr), url: pr.url, project: pr.repo, pr_number: pr.number }]),
  );
}

// A board missing part of its sources would make PRs vanish and come back as "new":
// while it is incomplete, the ones it lost keep their last known status.
function nextSnapshot(previous, current, incomplete) {
  if (!previous || !incomplete) return current;
  const merged = new Map(previous);
  for (const [id, entry] of current) merged.set(id, entry);
  return merged;
}

const prOf = ({ url, project, pr_number }) => ({ url, project, pr_number });

function eventsBetween(previous, current, statuses = []) {
  if (!previous) return [];
  const byStatus = new Map();
  for (const [id, entry] of current) {
    const { status } = entry;
    if (previous.get(id)?.status === status) continue;
    if (statuses.length && !statuses.includes(status)) continue;
    if (!byStatus.has(status)) byStatus.set(status, { status, ...prOf(entry), prs: [] });
    byStatus.get(status).prs.push(prOf(entry));
  }
  return [...byStatus.values()];
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
      const current = snapshot(board, { hideDrafts });
      const events = eventsBetween(previous, current, statuses);
      previous = nextSnapshot(previous, current, board.warnings.length > 0);
      if (events.length) post(url, events);
      return events;
    },
  };
}

module.exports = { STATUSES, parseStatuses, statusOf, snapshot, nextSnapshot, eventsBetween, send, createNotifier };
