'use strict';

const { isBot } = require('./github');

const DAY_MS = 86400_000;
const EVERY_MS = 30 * 60_000;
const RETRY_MS = 10 * 60_000;
const FORCE_GAP_MS = 10_000;

const keyOf = (repo, number) => `${repo.toLowerCase()}#${number}`;

// Each midnight crossed counts when the day it opens is a weekday: announced on a Thursday
// afternoon, Monday morning is two working days later, and a weekend never makes a PR late.
function businessDaysSince(from, now) {
  const day = new Date(from);
  day.setHours(0, 0, 0, 0);
  let count = 0;
  for (day.setDate(day.getDate() + 1); day.getTime() <= now; day.setDate(day.getDate() + 1)) {
    if (day.getDay() !== 0 && day.getDay() !== 6) count += 1;
  }
  return count;
}

function someoneLooked(node) {
  const author = node.author?.login;
  const people = [
    ...(node.reviews?.nodes ?? []),
    ...(node.comments?.nodes ?? []),
    ...(node.reviewThreads?.nodes ?? []).flatMap(thread => thread?.comments?.nodes ?? []),
  ].map(entry => entry?.author);
  return people.some(person => person && !isBot(person) && person.login !== author);
}

function pickOrphans(entries, { me, now, days, onBoard = new Set() }) {
  return entries
    .filter(({ node }) => node && node.state === 'OPEN' && !node.isDraft)
    .filter(({ node }) => node.author?.login !== me && !isBot(node.author) && !onBoard.has(node.id))
    .filter(({ node }) => !someoneLooked(node))
    .map(({ node, announcedAt, slackUrl }) => ({
      id: node.id,
      repo: node.repository.nameWithOwner,
      number: node.number,
      title: node.title,
      url: node.url,
      author: node.author?.login ?? '?',
      avatarUrl: node.author?.avatarUrl ?? null,
      announcedAt: new Date(announcedAt).toISOString(),
      slackUrl,
      waitingDays: businessDaysSince(announcedAt, now),
      requested: (node.reviewRequests?.nodes ?? [])
        .map(request => request?.requestedReviewer?.login ?? request?.requestedReviewer?.name)
        .filter(Boolean),
    }))
    .filter(pr => pr.waitingDays >= days)
    .sort((a, b) => a.announcedAt.localeCompare(b.announcedAt));
}

// A PR GitHub answered closed or merged is never asked about again, so after the first read
// only the few still open are. One it cannot find is asked again: a token that lost access to
// its repo answers the same as a deleted PR, and must not hide it for good.
function createOrphanWatch({ fetchAnnounced, announced, inScope, days, maxAgeDays }) {
  let entries = [];
  let checkedAt = null;
  let lastReadAt = -Infinity;
  let nextAt = 0;
  let failure = null;
  let reading = null;
  const settled = new Set();

  async function readNow(now) {
    const refs = (await announced())
      .filter(ref => inScope(ref) && now - ref.announcedAt <= maxAgeDays * DAY_MS)
      .filter(ref => !settled.has(keyOf(ref.repo, ref.number)));
    const nodes = await fetchAnnounced(refs);
    const answered = refs.map(ref => ({ ...ref, node: nodes.get(keyOf(ref.repo, ref.number)) ?? null }));
    for (const { repo, number, node } of answered) {
      if (node && node.state !== 'OPEN') settled.add(keyOf(repo, number));
    }
    entries = answered.filter(entry => entry.node?.state === 'OPEN');
    checkedAt = now;
    failure = null;
    return { asked: refs.length, missing: answered.filter(entry => !entry.node).map(({ repo, number }) => `${repo}#${number}`) };
  }

  function read({ now = Date.now(), force = false } = {}) {
    if (reading) return reading.then(() => ({ read: false }));
    const due = force ? now - lastReadAt >= FORCE_GAP_MS : now >= nextAt;
    if (!due) return Promise.resolve({ read: false });
    lastReadAt = now;
    nextAt = now + EVERY_MS;
    reading = readNow(now)
      .then(result => ({ read: true, ...result }))
      .catch(error => {
        failure = { message: error.message };
        nextAt = now + RETRY_MS;
        return { read: true, failed: true };
      })
      .finally(() => {
        reading = null;
      });
    return reading;
  }

  return {
    read,
    current: ({ me, now = Date.now(), onBoard }) => ({
      prs: pickOrphans(entries, { me, now, days, onBoard }),
      days,
      checkedAt: checkedAt && new Date(checkedAt).toISOString(),
    }),
    warning: () => (failure ? { source: 'orphans', message: failure.message } : null),
  };
}

module.exports = { businessDaysSince, pickOrphans, createOrphanWatch, EVERY_MS, RETRY_MS };
