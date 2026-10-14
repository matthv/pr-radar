'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { businessDaysSince, pickOrphans, createOrphanWatch, EVERY_MS, RETRY_MS } = require('../orphans');

const at = (y, m, d, h = 10) => new Date(y, m - 1, d, h).getTime();
// Thursday 8 October 2026, 15:00.
const THURSDAY = at(2026, 10, 8, 15);
const MONDAY = at(2026, 10, 12);

const user = login => ({ __typename: 'User', login });
const bot = login => ({ __typename: 'Bot', login });
const node = (number, extra = {}) => ({
  id: `PR_${number}`, number, title: `feat: thing ${number}`, url: `u${number}`, state: 'OPEN', isDraft: false,
  author: user('alban'), repository: { nameWithOwner: 'o/r' },
  reviews: { nodes: [] }, comments: { nodes: [] }, reviewThreads: { nodes: [] }, reviewRequests: { nodes: [] }, ...extra,
});
const entry = (n, extra, announcedAt = THURSDAY) => ({ node: node(n, extra), announcedAt, slackUrl: `s${n}` });
const pick = (entries, extra = {}) => pickOrphans(entries, { me: 'me', now: MONDAY, days: 2, ...extra }).map(pr => pr.number);

test('businessDaysSince: a weekend never counts', () => {
  assert.equal(businessDaysSince(THURSDAY, MONDAY), 2, 'Thursday afternoon to Monday morning');
  assert.equal(businessDaysSince(at(2026, 10, 10), MONDAY), 1, 'Saturday to Monday');
  assert.equal(businessDaysSince(at(2026, 10, 12, 8), MONDAY), 0, 'the same day');
});

test('orphans: only an open, ready PR of someone else, not already on the board', () => {
  const entries = [
    entry(1), entry(2, { isDraft: true }), entry(3, { state: 'MERGED' }), entry(4, { state: 'CLOSED' }),
    entry(5, { author: user('me') }), entry(6, { author: bot('dependabot') }), entry(7), { node: null, announcedAt: THURSDAY },
  ];
  assert.deepEqual(pick(entries, { onBoard: new Set(['PR_7']) }), [1]);
});

test('orphans: a human other than the author looking is enough, a bot or the author is not', () => {
  const entries = [
    entry(1, { comments: { nodes: [{ author: bot('macroscopeapp') }, { author: user('alban') }] } }),
    entry(2, { reviews: { nodes: [{ author: user('brian') }] } }),
    entry(3, { comments: { nodes: [{ author: user('brian') }] } }),
    entry(4, { reviewThreads: { nodes: [{ comments: { nodes: [{ author: user('brian') }] } }] } }),
  ];
  assert.deepEqual(pick(entries), [1]);
});

test('orphans: asked of someone who has not answered, it still waits, and says who', () => {
  const [pr] = pickOrphans([entry(1, { reviewRequests: { nodes: [{ requestedReviewer: user('hercemer42') }, { requestedReviewer: { name: 'backend' } }] } })], { me: 'me', now: MONDAY, days: 2 });
  assert.deepEqual([pr.requested, pr.waitingDays, pr.slackUrl], [['hercemer42', 'backend'], 2, 's1']);
});

test('orphans: not before the days set, the oldest announcement first', () => {
  const entries = [entry(1, {}, at(2026, 10, 9)), entry(2, {}, at(2026, 10, 7)), entry(3, {}, THURSDAY)];
  assert.deepEqual(pick(entries), [2, 3], 'Friday morning is one working day before Monday');
  assert.deepEqual(pick(entries, { days: 3 }), [2]);
});

const refs = [
  { repo: 'o/r', number: 1, announcedAt: THURSDAY, slackUrl: 's1' },
  { repo: 'o/r', number: 2, announcedAt: THURSDAY, slackUrl: 's2' },
  { repo: 'x/y', number: 3, announcedAt: THURSDAY, slackUrl: 's3' },
];

function watch(answers) {
  const asked = [];
  const orphans = createOrphanWatch({
    announced: async () => refs,
    inScope: ref => ref.repo.startsWith('o/'),
    days: 2,
    maxAgeDays: 60,
    fetchAnnounced: async list => {
      asked.push(list.map(ref => ref.number));
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return new Map(list.map(ref => [`${ref.repo}#${ref.number}`, next[ref.number] ?? null]));
    },
  });
  return { orphans, asked };
}

test('orphan watch: in scope only, every half hour, a settled PR never asked again', async () => {
  const { orphans, asked } = watch([{ 1: node(1), 2: node(2, { state: 'MERGED' }) }, { 1: node(1) }]);
  await orphans.read({ now: MONDAY });
  assert.deepEqual(orphans.current({ me: 'me', now: MONDAY }).prs.map(pr => pr.number), [1]);
  assert.deepEqual((await orphans.read({ now: MONDAY + EVERY_MS - 1 })).read, false, 'not due yet');
  await orphans.read({ now: MONDAY + EVERY_MS });
  assert.deepEqual(asked, [[1, 2], [1]], 'x/y is out of scope, the merged one is not asked again');
});

test('orphan watch: Refresh reads at once, though not twice within seconds', async () => {
  const { orphans, asked } = watch([{ 1: node(1) }, { 1: node(1) }]);
  await orphans.read({ now: MONDAY });
  assert.equal((await orphans.read({ now: MONDAY + 5_000, force: true })).read, false);
  assert.equal((await orphans.read({ now: MONDAY + 20_000, force: true })).read, true);
  assert.equal(asked.length, 2);
});

test('orphan watch: a failed read keeps the last list, says so, and tries again sooner', async () => {
  const { orphans } = watch([{ 1: node(1) }, new Error('gh: timeout'), { 1: node(1) }]);
  await orphans.read({ now: MONDAY });
  await orphans.read({ now: MONDAY + EVERY_MS });
  assert.deepEqual([orphans.current({ me: 'me', now: MONDAY }).prs.length, orphans.warning()?.source], [1, 'orphans']);
  assert.equal((await orphans.read({ now: MONDAY + EVERY_MS + RETRY_MS })).read, true, 'ten minutes, not thirty');
  assert.equal(orphans.warning(), null);
});
