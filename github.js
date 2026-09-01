'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);

const GH_MAX_BUFFER = 64 * 1024 * 1024;
const PR_BATCH_SIZE = 6;
const ID_BATCH_SIZE = 25;
const MERGEABLE_RETRY_MS = 1500;
const PR_CONCURRENCY = 4;

const BOT_LOGINS = new Set([
  'macroscope-dev',
  'macroscope',
  'macroscopeapp',
  'qltysh',
  'qlty-cloud-legacy',
  'coderabbitai',
  'github-actions',
  'sonarcloud',
  'codecov',
  'greptile-apps',
  'dependabot',
  'renovate',
  'claude',
  'claudine',
]);

const PR_QUERY = `
query($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on PullRequest {
      id
      number
      title
      url
      state
      isDraft
      createdAt
      updatedAt
      mergeable
      reviewDecision
      additions
      deletions
      changedFiles
      author { login avatarUrl }
      repository { nameWithOwner }
      labels(first: 10) { nodes { name color } }
      head: commits(last: 1) {
        nodes {
          commit {
            committedDate
            author { user { login } }
            statusCheckRollup { state }
          }
        }
      }
      recent: commits(last: 50) {
        nodes { commit { author { user { login avatarUrl } } } }
      }
      reviews(last: 100) { totalCount nodes { author { __typename login } state submittedAt url } }
      comments(last: 30) { nodes { author { __typename login } createdAt url body } }
      reviewRequests(first: 20) {
        nodes { requestedReviewer { __typename ... on User { login } ... on Team { name } } }
      }
      reviewThreads(last: 100) {
        totalCount
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          comments(first: 20) {
            totalCount
            nodes { author { __typename login } body createdAt url }
          }
        }
      }
    }
  }
}`;

async function gh(args) {
  try {
    const { stdout } = await execFile('gh', args, { maxBuffer: GH_MAX_BUFFER, encoding: 'utf8' });
    return stdout;
  } catch (error) {
    if (error.stdout) return error.stdout;
    throw new Error(`\`gh ${args[1]}\` a échoué : ${(error.stderr || error.message).trim()}`);
  }
}

// `gh api --input -` does not correctly receive a body piped from Node (gh <= 2.7):
// the request goes out malformed and GitHub cuts it off. Hence the temporary file.
async function ghGraphql(body) {
  const file = path.join(os.tmpdir(), `pr-radar-${process.pid}-${randomUUID()}.json`);
  await fs.writeFile(file, body);
  try {
    return await gh(['api', 'graphql', '--input', file]);
  } finally {
    await fs.unlink(file).catch(() => {});
  }
}

async function graphql(query, variables) {
  const payload = JSON.parse(await ghGraphql(JSON.stringify({ query, variables })));

  if (payload.errors?.length) {
    throw new Error(payload.errors.map(e => e.message).join(' | '));
  }
  if (!payload.data) throw new Error('Réponse GitHub sans données.');
  return payload.data;
}

// The GraphQL search times out (HTTP 499) on an org of any size; the REST search
// answers, and its node_id is directly the PullRequest's GraphQL id.
async function searchPullRequests(query) {
  const endpoint = `/search/issues?q=${encodeURIComponent(query)}&per_page=100&sort=updated&order=desc`;
  const payload = JSON.parse(await gh(['api', endpoint]));
  if (payload.message) throw new Error(`Search GitHub : ${payload.message}`);
  return (payload.items || [])
    .filter(item => item.node_id)
    .map(item => ({ id: item.node_id, createdAt: item.created_at, updatedAt: item.updated_at }));
}

const EVENT_TYPES = new Set([
  'IssueCommentEvent',
  'PullRequestReviewEvent',
  'PullRequestReviewCommentEvent',
  'PullRequestEvent',
]);

const SAFE_REPO = /^[A-Za-z0-9._-]+$/;

// GitHub's search index misses PRs: a three-day-old comment can stay invisible to both
// `commenter:` and `involves:`. The account's event feed does not go through that index
// and plugs those holes — at the cost of a short window (300 events, 90 days max).
async function recentlyTouchedPullRequests(org, me) {
  const pages = await Promise.all(
    [1, 2, 3].map(page => gh(['api', `/users/${me}/events?per_page=100&page=${page}`])),
  );

  const refs = new Map();

  for (const page of pages) {
    const events = JSON.parse(page);
    if (!Array.isArray(events)) continue;

    for (const event of events) {
      if (!EVENT_TYPES.has(event.type)) continue;
      // IssueCommentEvent also covers actual issues.
      if (event.type === 'IssueCommentEvent' && !event.payload?.issue?.pull_request) continue;

      const number = event.payload?.issue?.number ?? event.payload?.pull_request?.number;
      const [owner, name] = (event.repo?.name || '').split('/');
      if (!number || owner !== org || !SAFE_REPO.test(name || '')) continue;

      refs.set(`${owner}/${name}#${number}`, { owner, name, number });
    }
  }

  return [...refs.values()];
}

async function resolvePullRequestIds(refs) {
  const batches = [];
  for (let i = 0; i < refs.length; i += ID_BATCH_SIZE) {
    batches.push(refs.slice(i, i + ID_BATCH_SIZE));
  }

  const responses = await mapWithConcurrency(batches, PR_CONCURRENCY, batch => {
    const query = `query { ${batch
      .map(
        (ref, index) =>
          `p${index}: repository(owner: "${ref.owner}", name: "${ref.name}") ` +
          `{ pullRequest(number: ${ref.number}) { id } }`,
      )
      .join(' ')} }`;
    return graphql(query, {});
  });

  return responses.flatMap(response =>
    Object.values(response)
      .map(entry => entry?.pullRequest?.id)
      .filter(Boolean),
  );
}

async function mapWithConcurrency(items, limit, worker) {
  const results = [];
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

// A failing batch must cost only its 6 PRs, not the whole board.
async function fetchPullRequests(ids, warnings) {
  const batches = [];
  for (let i = 0; i < ids.length; i += PR_BATCH_SIZE) {
    batches.push(ids.slice(i, i + PR_BATCH_SIZE));
  }

  const responses = await mapWithConcurrency(batches, PR_CONCURRENCY, async batch => {
    try {
      return await graphql(PR_QUERY, { ids: batch });
    } catch (error) {
      warnings.push({ source: 'details', message: error.message, lost: batch.length });
      return { nodes: [] };
    }
  });

  const byId = new Map();
  for (const response of responses) {
    for (const node of response.nodes) {
      if (node?.id) byId.set(node.id, node);
    }
  }
  return byId;
}

// GitHub computes `mergeable` lazily and answers UNKNOWN meanwhile. Without this
// second pass, that non-answer reads as "no conflict" and the pill vanishes while
// nothing changed on the PR.
const MERGEABLE_QUERY = `
query($ids: [ID!]!) {
  nodes(ids: $ids) { ... on PullRequest { id mergeable } }
}`;

async function settleMergeable(nodes, warnings) {
  const pending = [...nodes.values()].filter(node => node.mergeable === 'UNKNOWN');
  if (!pending.length) return;

  await new Promise(resolve => setTimeout(resolve, MERGEABLE_RETRY_MS));

  const batches = [];
  for (let i = 0; i < pending.length; i += ID_BATCH_SIZE) {
    batches.push(pending.slice(i, i + ID_BATCH_SIZE).map(node => node.id));
  }

  const responses = await mapWithConcurrency(batches, PR_CONCURRENCY, async batch => {
    try {
      return await graphql(MERGEABLE_QUERY, { ids: batch });
    } catch (error) {
      warnings.push({ source: 'mergeable', message: error.message });
      return { nodes: [] };
    }
  });

  for (const response of responses) {
    for (const node of response.nodes) {
      if (node?.id && nodes.has(node.id)) nodes.get(node.id).mergeable = node.mergeable;
    }
  }
}

// Bots post HTML and escaped markdown: without cleaning, the excerpt shows raw tags.
function cleanExcerpt(body) {
  return (body || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\\([\\`*_{}[\]()#+\-.!])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 320);
}

const isBot = author =>
  !author?.login || author.__typename === 'Bot' || author.login.endsWith('[bot]') || BOT_LOGINS.has(author.login);

function analyzeThread(thread, me) {
  const comments = thread.comments.nodes.filter(Boolean);
  const first = comments[0];
  const last = comments[comments.length - 1];
  if (!first || !last) return null;

  return {
    id: thread.id,
    isResolved: thread.isResolved,
    isOutdated: thread.isOutdated,
    path: thread.path,
    line: thread.line,
    url: first.url,
    author: first.author?.login ?? '?',
    fromBot: isBot(first.author),
    startedByMe: first.author?.login === me,
    iParticipated: comments.some(c => c.author?.login === me),
    lastAuthor: last.author?.login ?? '?',
    lastByMe: last.author?.login === me,
    lastAt: last.createdAt,
    myLastAt: comments.filter(c => c.author?.login === me).map(c => c.createdAt).sort().pop() ?? null,
    excerpt: cleanExcerpt(first.body),
    commentCount: thread.comments.totalCount,
  };
}

// GitHub's `updatedAt` moves for a label, a recomputed mergeable or a CI re-run: a PR
// with no commit for 200 days still claims to be fresh. Activity is therefore dated by
// what a human actually did.
function lastActivity(pr) {
  const dates = [
    pr.createdAt,
    pr.head.nodes[0]?.commit?.committedDate,
    ...pr.reviews.nodes.filter(r => r?.author?.__typename !== 'Bot').map(r => r?.submittedAt),
    ...pr.comments.nodes.filter(c => c?.author?.__typename !== 'Bot').map(c => c?.createdAt),
    ...pr.reviewThreads.nodes.flatMap(t =>
      t.comments.nodes.filter(c => c?.author?.__typename !== 'Bot').map(c => c.createdAt),
    ),
  ].filter(Boolean);

  return dates.sort().pop();
}

// Review feedback does not necessarily live in an inline thread: plenty of reviewers
// write in the PR's main conversation. It is folded into a synthetic thread so the rest
// of the classification treats it identically.
function conversationThread(pr, me) {
  const comments = pr.comments.nodes.filter(c => c?.author && c.author.__typename !== 'Bot');
  if (!comments.length) return null;

  const first = comments[0];
  const last = comments[comments.length - 1];

  return {
    id: `conversation:${pr.id}`,
    isResolved: false,
    isOutdated: false,
    path: null,
    line: null,
    url: last.url,
    author: first.author.login,
    fromBot: false,
    startedByMe: first.author.login === me,
    iParticipated: comments.some(c => c.author.login === me),
    lastAuthor: last.author.login,
    lastByMe: last.author.login === me,
    lastAt: last.createdAt,
    myLastAt: comments.filter(c => c.author.login === me).map(c => c.createdAt).sort().pop() ?? null,
    excerpt: cleanExcerpt(last.body),
    commentCount: comments.length,
  };
}

// PR author first, then commit authors chronologically: the order people entered the PR.
function contributorsOf(pr) {
  const people = new Map();

  const add = user => {
    if (!user?.login || people.has(user.login)) return;
    people.set(user.login, { login: user.login, avatarUrl: user.avatarUrl ?? null });
  };

  add(pr.author);
  for (const node of pr.recent.nodes) add(node?.commit?.author?.user);

  return [...people.values()];
}

// GraphQL pages are capped, and `first` would hand back the oldest entries: on a PR
// with 72 reviews my own verdict fell outside the window entirely. `last` keeps the
// recent ones, and a page that came back full is reported rather than silently trusted.
function truncationOf(pr) {
  const over = [];
  if (pr.reviewThreads.totalCount > pr.reviewThreads.nodes.length) {
    over.push(`${pr.reviewThreads.totalCount - pr.reviewThreads.nodes.length} threads`);
  }
  if (pr.reviews.totalCount > pr.reviews.nodes.length) {
    over.push(`${pr.reviews.totalCount - pr.reviews.nodes.length} reviews`);
  }
  return over.length ? over.join(', ') : null;
}

function baseShape(pr, me) {
  const lastCommit = pr.head.nodes[0]?.commit;
  const conversation = conversationThread(pr, me);

  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    repo: pr.repository.nameWithOwner,
    state: pr.state,
    isDraft: pr.isDraft,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    lastActivityAt: lastActivity(pr),
    mergeable: pr.mergeable,
    reviewDecision: pr.reviewDecision,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    author: pr.author?.login ?? '?',
    contributors: contributorsOf(pr),
    labels: pr.labels.nodes.map(l => ({ name: l.name, color: l.color })),
    ciState: lastCommit?.statusCheckRollup?.state ?? null,
    lastCommitAt: lastCommit?.committedDate ?? null,
    headCommitAuthor: lastCommit?.author?.user?.login ?? null,
    truncated: truncationOf(pr),
    threads: [
      ...pr.reviewThreads.nodes.filter(Boolean).map(t => analyzeThread(t, me)).filter(Boolean),
      ...(conversation ? [conversation] : []),
    ],
    reviews: pr.reviews.nodes.filter(Boolean).map(r => ({
      author: r.author?.login ?? '?',
      state: r.state,
      submittedAt: r.submittedAt,
      url: r.url,
    })),
    requestedReviewers: pr.reviewRequests.nodes
      .map(n => n.requestedReviewer)
      .filter(Boolean)
      .map(r => (r.__typename === 'Team' ? `@team/${r.name}` : r.login)),
  };
}

function latestReviewPerAuthor(reviews) {
  const byAuthor = new Map();
  for (const review of reviews) {
    if (review.state === 'COMMENTED' || review.state === 'PENDING') continue;
    const current = byAuthor.get(review.author);
    if (!current || new Date(review.submittedAt) > new Date(current.submittedAt)) {
      byAuthor.set(review.author, review);
    }
  }
  return [...byAuthor.values()];
}

function decorateMine(pr) {
  const unresolved = pr.threads.filter(t => !t.isResolved);
  const toFix = unresolved.filter(t => !t.lastByMe);
  const waitingOnThem = unresolved.filter(t => t.lastByMe);
  const changesRequested = latestReviewPerAuthor(pr.reviews).filter(r => r.state === 'CHANGES_REQUESTED');

  // Reasons carry only a `kind`: the sentence is rendered client-side, the only place
  // that knows the chosen language.
  const reasons = [];
  if (toFix.length) reasons.push({ kind: 'threads', count: toFix.length });
  if (changesRequested.length) {
    reasons.push({ kind: 'changes-requested', authors: changesRequested.map(r => r.author) });
  }
  if (pr.ciState === 'FAILURE' || pr.ciState === 'ERROR') reasons.push({ kind: 'ci' });
  if (pr.mergeable === 'CONFLICTING') reasons.push({ kind: 'conflict' });

  const needsAction = reasons.length > 0;

  // A freshly opened PR asks nothing of me, but I am blocked on a review — "nothing to
  // report" undersells that. A draft is waiting on no one, and an approved PR is done.
  const awaitingReview = !pr.isDraft && pr.reviewDecision !== 'APPROVED';

  return {
    ...pr,
    side: 'mine',
    toFix,
    waitingOnThem,
    changesRequested,
    reasons,
    needsAction,
    awaitingReview,
    bucket: needsAction ? 'action' : waitingOnThem.length || awaitingReview ? 'waiting' : 'idle',
  };
}

function decorateReview(pr, me, requestedFromMe) {
  const myThreads = pr.threads.filter(t => t.iParticipated);
  const myUnresolved = myThreads.filter(t => !t.isResolved);

  const myReviews = pr.reviews.filter(r => r.author === me);
  const myLastActivity = [
    ...myReviews.map(r => r.submittedAt),
    ...myThreads.map(t => t.myLastAt),
  ]
    .filter(Boolean)
    .sort()
    .pop();

  const approvedAt = myReviews
    .filter(r => r.state === 'APPROVED')
    .map(r => r.submittedAt)
    .sort()
    .pop();

  // One principle, applied to both sides of a thread: a later move of mine supersedes an
  // earlier pending state of mine. Approving is a reviewer's terminal act.
  //
  // A reply is measured against my last move of any kind — a review submission included.
  const answeredToMe = myUnresolved.filter(
    thread =>
      !thread.lastByMe && (!myLastActivity || new Date(thread.lastAt) > new Date(myLastActivity)),
  );

  // A question of mine is measured against my approval specifically, not against any
  // move: my own comment in that thread *is* the pending state, so it cannot settle
  // itself. Approving after asking means I decided it was fine.
  const awaitingAuthor = myUnresolved.filter(
    thread => thread.lastByMe && !(approvedAt && new Date(approvedAt) > new Date(thread.lastAt)),
  );

  // My own commit is not something to re-check: without this guard, a PR I have taken
  // over asks me to review my own work.
  const pushedSinceMyFeedback = Boolean(
    myLastActivity &&
      pr.lastCommitAt &&
      pr.headCommitAuthor !== me &&
      new Date(pr.lastCommitAt) > new Date(myLastActivity),
  );

  const myLatestVerdict = latestReviewPerAuthor(pr.reviews).find(r => r.author === me)?.state ?? null;
  const iHaveReviewed = myReviews.length > 0 || myThreads.length > 0;

  const reasons = [];
  if (requestedFromMe && !iHaveReviewed) reasons.push({ kind: 'to-review' });
  if (answeredToMe.length) reasons.push({ kind: 'answers', count: answeredToMe.length });
  if (pushedSinceMyFeedback && (awaitingAuthor.length || myLatestVerdict === 'CHANGES_REQUESTED')) {
    reasons.push({ kind: 'recheck' });
  }

  const awaitingFix = awaitingAuthor.length > 0 || myLatestVerdict === 'CHANGES_REQUESTED';

  return {
    ...pr,
    side: 'review',
    requestedFromMe,
    iHaveReviewed,
    myLatestVerdict,
    myLastActivity: myLastActivity ?? null,
    awaitingAuthor,
    answeredToMe,
    pushedSinceMyFeedback,
    reasons,
    needsAction: reasons.length > 0,
    awaitingFix,
    bucket: reasons.length ? 'action' : awaitingFix ? 'waiting' : 'idle',
  };
}

const byActionThenFreshness = (a, b) =>
  Number(b.needsAction) - Number(a.needsAction) ||
  new Date(b.lastActivityAt) - new Date(a.lastActivityAt);

async function fetchDashboard({ org, maxAgeDays }) {
  const scope = `org:${org} is:pr is:open`;
  // `reviewed-by:` only matches a formally submitted review: a PR where you merely
  // commented never shows up there. `commenter:` covers that case.
  const me = (await gh(['api', '/user', '--jq', '.login'])).trim();

  // Five independent sources: with `Promise.all`, a timeout on one would wipe out the
  // four valid answers and leave an empty screen. Keep what answered and report the
  // gaps — a silent `author` would otherwise read as "you have no open PRs".
  const warnings = [];
  const settled = await Promise.allSettled([
    searchPullRequests(`${scope} author:@me`),
    searchPullRequests(`${scope} reviewed-by:@me -author:@me`),
    searchPullRequests(`${scope} review-requested:@me -author:@me`),
    searchPullRequests(`${scope} commenter:@me -author:@me`),
    recentlyTouchedPullRequests(org, me),
  ]);

  const SOURCES = ['author', 'reviewed-by', 'review-requested', 'commenter', 'events'];
  const sourceOf = (index, fallback) => {
    const result = settled[index];
    if (result.status === 'fulfilled') return result.value;
    warnings.push({ source: SOURCES[index], message: String(result.reason?.message ?? result.reason) });
    return fallback;
  };

  const [mineFound, reviewedFound, requestedFound, commentedFound, touchedRefs] = [
    sourceOf(0, []),
    sourceOf(1, []),
    sourceOf(2, []),
    sourceOf(3, []),
    sourceOf(4, []),
  ];

  if (warnings.length === settled.length) {
    throw new Error(`Aucune source GitHub n'a répondu : ${warnings[0].message}`);
  }

  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  // Deliberately loose pre-filter: `updatedAt` overstates freshness, so it only avoids
  // loading PRs that are dead for certain. The real cut happens on `lastActivityAt`,
  // which needs the details.
  const maybeFresh = item => new Date(item.updatedAt).getTime() >= cutoff;
  const found = [...mineFound, ...reviewedFound, ...requestedFound, ...commentedFound];
  const stale = new Set(found.filter(item => !maybeFresh(item)).map(item => item.id));

  const ids = items => new Set(items.filter(maybeFresh).map(item => item.id));
  const mineSet = ids(mineFound);
  const requestedSet = ids(requestedFound);
  const reviewSet = new Set([...ids(reviewedFound), ...ids(commentedFound), ...requestedSet]);

  // PRs from the event feed never went through the search: neither their state nor
  // their author is guaranteed. Load them, then split on the real author.
  let touchedIds = [];
  try {
    touchedIds = await resolvePullRequestIds(touchedRefs);
  } catch (error) {
    warnings.push({ source: 'events-resolve', message: error.message });
  }
  const known = new Set([...mineSet, ...reviewSet]);
  const extraIds = touchedIds.filter(id => !known.has(id));

  const byId = await fetchPullRequests([...known, ...extraIds], warnings);
  await settleMergeable(byId, warnings);

  const shapes = new Map();
  for (const [id, node] of byId) {
    const shaped = baseShape(node, me);
    if (shaped.state !== 'OPEN') continue;
    if (new Date(shaped.lastActivityAt).getTime() >= cutoff) shapes.set(id, shaped);
    else stale.add(id);
  }

  // Truncation is a wrong answer, not a slow one: it must not pass unnoticed.
  for (const shaped of shapes.values()) {
    if (shaped.truncated) {
      warnings.push({
        source: `${shaped.repo}#${shaped.number}`,
        message: `page GraphQL pleine, ${shaped.truncated} non chargés`,
      });
    }
  }

  for (const id of extraIds) {
    const shaped = shapes.get(id);
    if (!shaped) continue;
    (shaped.author === me ? mineSet : reviewSet).add(id);
  }

  // Taking over someone else's PR means owning it: the next move is mine, so it goes to
  // "my PRs". As soon as the author pushes again the head commit changes and it returns
  // to the review side — the rule reverses on its own.
  for (const [id, shaped] of shapes) {
    if (!reviewSet.has(id) || shaped.headCommitAuthor !== me) continue;
    reviewSet.delete(id);
    mineSet.add(id);
  }

  const mine = [...mineSet]
    .map(id => shapes.get(id))
    .filter(Boolean)
    .map(decorateMine)
    .sort(byActionThenFreshness);

  const reviews = [...reviewSet]
    .map(id => shapes.get(id))
    .filter(Boolean)
    .map(pr => decorateReview(pr, me, requestedSet.has(pr.id)))
    .sort(byActionThenFreshness);

  return {
    me,
    org,
    maxAgeDays,
    warnings,
    fetchedAt: new Date().toISOString(),
    mine,
    reviews,
    counts: {
      hiddenStale: stale.size,
      // PRs actually considered: displayed + dropped by the age window. Merged PRs from
      // the event feed are not part of it.
      seenTotal: shapes.size + stale.size,
      mineTotal: mine.length,
      mineAction: mine.filter(p => p.needsAction).length,
      reviewsTotal: reviews.length,
      reviewsAction: reviews.filter(p => p.needsAction).length,
      reviewsWaitingFix: reviews.filter(p => p.bucket === 'waiting').length,
    },
  };
}

// The pure functions are exported for the tests: every classification bug hit so far
// lived here, not in the network calls.
module.exports = {
  fetchDashboard,
  baseShape,
  decorateMine,
  decorateReview,
  lastActivity,
  contributorsOf,
  conversationThread,
  cleanExcerpt,
  isBot,
};
