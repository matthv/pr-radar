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

function watch(answers, announcedRefs = refs) {
  const asked = [];
  const orphans = createOrphanWatch({
    announced: async () => announcedRefs,
    inScope: ref => ref.repo.startsWith('o/'),
    days: 2,
    maxAgeDays: 60,
    fetchAnnounced: async list => {
      asked.push(list.map(ref => ref.number));
      const next = answers.shift();
      if (next instanceof Error) throw next;
      if (typeof next === 'function') return next(list);
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

test('orphan watch: a PR GitHub cannot find is reported and asked again, never settled', async () => {
  const { orphans, asked } = watch([{ 1: node(1) }, { 1: node(1), 2: node(2) }]);
  const first = await orphans.read({ now: MONDAY });
  assert.deepEqual(first.missing, ['o/r#2']);
  const second = await orphans.read({ now: MONDAY + EVERY_MS });
  assert.deepEqual([asked, second.missing], [[[1, 2], [1, 2]], []], 'access back: it shows again');
  assert.deepEqual(orphans.current({ me: 'me', now: MONDAY }).prs.map(pr => pr.number), [1, 2]);
});

test('orphan watch: an announcement older than the max age is not asked', async () => {
  const old = { repo: 'o/r', number: 9, announcedAt: MONDAY - 61 * 86400_000, slackUrl: 's9' };
  const { orphans, asked } = watch([{}], [old, refs[0]]);
  await orphans.read({ now: MONDAY });
  assert.deepEqual(asked, [[1]]);
});

test('orphan watch: a read joining one in flight shares its GitHub call and reports nothing', async () => {
  let answer;
  const pending = new Promise(resolve => { answer = resolve; });
  const { orphans, asked } = watch([() => pending]);
  const first = orphans.read({ now: MONDAY });
  const joined = orphans.read({ now: MONDAY, force: true });
  answer(new Map([['o/r#1', node(1)]]));
  assert.deepEqual([(await first).read, (await joined).read, asked.length], [true, false, 1]);
});

const { fetchAnnounced } = require('../github');

test('fetchAnnounced: one batch, a PR GitHub cannot resolve is null next to the others', async () => {
  const queries = [];
  const nodes = await fetchAnnounced(
    [{ repo: 'O/R', number: 1 }, { repo: 'o/gone', number: 2 }, { repo: 'o/r', number: 3 }],
    async query => {
      queries.push(query);
      return {
        data: { p0: { pullRequest: { id: 'A' } }, p1: null, p2: { pullRequest: null } },
        errors: [{ message: "Could not resolve to a Repository with the name 'o/gone'." }, { message: 'Could not resolve to a PullRequest with the number of 3.' }],
      };
    },
  );
  assert.equal(queries.length, 1);
  assert.deepEqual([...nodes], [['o/r#1', { id: 'A' }], ['o/gone#2', null], ['o/r#3', null]], 'keys lowercased, as the watch asks them');
});

test('fetchAnnounced: any other error fails the read', async () => {
  await assert.rejects(
    fetchAnnounced([{ repo: 'o/r', number: 1 }], async () => ({ data: null, errors: [{ message: 'API rate limit exceeded' }] })),
    /rate limit/,
  );
});

test('fetchAnnounced: a ref read from Slack is only put in a query when well formed', async () => {
  const queries = [];
  await fetchAnnounced(
    [{ repo: 'o"){x}/r', number: 1 }, { repo: 'o/r', number: 0 }, { repo: 'o/r', number: 1.5 }, { repo: 'or', number: 1 }, { repo: 'o/r/x', number: 1 }, { repo: 'o/r', number: NaN }],
    async query => {
      queries.push(query);
      return { data: {} };
    },
  );
  assert.deepEqual(queries, []);
});
