'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);

const { ticketKey } = require('./ticket');

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
      merged
      mergedAt
      mergeCommit {
        oid
        statusCheckRollup { state }
        checkSuites(first: 20) {
          nodes {
            status
            conclusion
            workflowRun { event url workflow { name } }
            checkRuns(first: 1) { totalCount }
          }
        }
      }
      baseRefName
      headRefName
      createdAt
      updatedAt
      mergeable
      reviewDecision
      additions
      deletions
      changedFiles
      author { login avatarUrl }
      repository {
        nameWithOwner
        defaultBranchRef { name }
        latestRelease { tagName url publishedAt }
      }
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
      reviews(last: 100) { totalCount nodes { id author { __typename login } state submittedAt url body } }
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
            nodes { author { __typename login } body createdAt url pullRequestReview { id } }
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

const DIGEST_QUERY = `
query($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on PullRequest {
      number
      title
      body
      headRefName
      repository { nameWithOwner }
      files(first: 20) { nodes { path } }
    }
  }
}`;

// The board's own query deliberately leaves out the description and the file list: they
// are only ever read by the digest, and would weigh on every refresh for nothing.
async function fetchDigestInputs(ids) {
  const data = await graphql(DIGEST_QUERY, { ids });
  return data.nodes.filter(Boolean).map(pr => ({
    number: pr.number,
    title: pr.title,
    body: pr.body || '',
    headRefName: pr.headRefName ?? null,
    repo: pr.repository.nameWithOwner,
    files: pr.files.nodes.map(file => file.path),
  }));
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
  const pages = await sequentially(
    [1, 2, 3].map(page => () => gh(['api', `/users/${me}/events?per_page=100&page=${page}`])),
  );

  const refs = new Map();

  for (const page of pages) {
    if (page.status !== 'fulfilled') continue;
    const events = JSON.parse(page.value);
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

// GitHub's secondary rate limit triggers on bursts of concurrent requests, regardless
// of the quota — which is why it fires while /rate_limit still reads 30/30. Its own
// guidance is to send requests one after another, so REST calls are serialised and a
// refusal is retried once after a pause. At a five-minute refresh, latency is free.
const RATE_LIMIT_PAUSE_MS = 20_000;

const isSecondaryRateLimit = error => /secondary rate limit/i.test(error.message);

async function sequentially(tasks) {
  const results = [];
  for (const task of tasks) {
    try {
      results.push({ status: 'fulfilled', value: await task() });
    } catch (error) {
      if (!isSecondaryRateLimit(error)) {
        results.push({ status: 'rejected', reason: error });
        continue;
      }
      await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_PAUSE_MS));
      try {
        results.push({ status: 'fulfilled', value: await task() });
      } catch (retryError) {
        results.push({ status: 'rejected', reason: retryError });
      }
    }
  }
  return results;
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
  // A merged or closed PR always reads UNKNOWN, and nothing reads its mergeability any more.
  const pending = [...nodes.values()].filter(node => node.mergeable === 'UNKNOWN' && node.state === 'OPEN');
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
const EXCERPT_LIMIT = 320;

function cleanExcerpt(body) {
  const text = (body || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\\([\\`*_{}[\]()#+\-.!])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length <= EXCERPT_LIMIT) return { text, truncated: false };

  const cut = text.slice(0, EXCERPT_LIMIT);
  const lastSpace = cut.lastIndexOf(' ');
  const kept = lastSpace > EXCERPT_LIMIT * 0.6 ? cut.slice(0, lastSpace) : cut;
  return { text: `${kept.replace(/[\s,;:.–—-]+$/, '')}…`, truncated: true };
}

const isBot = author =>
  !author?.login || author.__typename === 'Bot' || author.login.endsWith('[bot]') || BOT_LOGINS.has(author.login);

function analyzeThread(thread, me) {
  const comments = thread.comments.nodes.filter(Boolean);
  const first = comments[0];
  const last = comments[comments.length - 1];
  if (!first || !last) return null;

  const excerpt = cleanExcerpt(first.body);

  return {
    id: thread.id,
    channel: 'inline',
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
    excerpt: excerpt.text,
    excerptTruncated: excerpt.truncated,
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
// GitHub shows review bodies and PR comments in one timeline, and that is what they are:
// two forms of the same discussion, unlike an inline thread, which has its own turn and
// its own resolution. Split into two threads, a remark answered in the other form stayed
// pending for ever — a reviewer asking for a fix in their review body and my answer in the
// conversation showed up as both "to fix" and "awaiting a reply", one exchange counted
// twice.
// A commented review whose body is a verdict and nothing else — "conforms", "LGTM" — asks
// for nothing, yet it used to sit in "to fix" until answered, because the rule only knew
// that a body was there. Observed on agent-ruby#398. Read conservatively: the body has to
// carry a verdict *and* none of the words a request is made of; anything else stays
// pending, which is the failure mode that costs a glance rather than a missed remark.
// Code spans are dropped first — a `can?` method name is not a question.
const VERDICT_RE = /\b(conforms|lgtm|looks good|nothing to (add|fix|report)|no (remarks?|comments?|concerns?)|all good)\b/i;
const REQUEST_RE = /\?|\b(should|must|needs?|missing|gaps?|contradicts?|not|nit|please|blockers?|blocking|fix)\b|n't/i;

function asksNothing(body) {
  const prose = String(body ?? '').replace(/`[^`]*`/g, '');
  return VERDICT_RE.test(prose) && !REQUEST_RE.test(prose);
}

// A review body is answered where the conversation actually went: my reply inside one of
// that review's own inline threads, after it was posted, settles the body too. Without
// this, agent-ruby#398 stayed "to fix" with its one thread resolved — the body could only
// be answered at PR level, which nobody does when the remark is on a line.
function answeredInline(review, pr, me) {
  if (!review.id) return false;
  return pr.reviewThreads.nodes.some(thread => {
    const comments = thread?.comments?.nodes?.filter(Boolean) ?? [];
    if (comments[0]?.pullRequestReview?.id !== review.id) return false;
    return comments.some(
      c => c.author?.login === me && new Date(c.createdAt) > new Date(review.submittedAt),
    );
  });
}

// A remark in the conversation cannot be resolved, so a reviewer who closes the exchange
// there and then approves left it "to fix" for ever. Observed on forestadmin#10019. Their
// approval, posted after it, is their answer to their own remark.
function approvedSince(pr, login, at) {
  return pr.reviews.nodes.some(
    review => review?.author?.login === login && review.state === 'APPROVED'
      && new Date(review.submittedAt) >= new Date(at),
  );
}

function discussionThread(pr, me) {
  const messages = [
    ...pr.reviews.nodes
      .filter(
        review =>
          review?.author
          && !isBot(review.author)
          // An approval's body is a courtesy, not a request. Letting it in would make
          // approving look like feedback still pending, the opposite of what it is.
          && review.state !== 'APPROVED'
          && (review.body ?? '').trim()
          && !(review.state === 'COMMENTED' && asksNothing(review.body))
          && !(review.author.login !== me && answeredInline(review, pr, me)),
      )
      .map(review => ({
        channel: 'review',
        login: review.author.login,
        body: review.body,
        at: review.submittedAt,
        url: review.url,
      })),
    ...pr.comments.nodes
      .filter(comment => comment?.author && comment.author.__typename !== 'Bot')
      .map(comment => ({
        channel: 'conversation',
        login: comment.author.login,
        body: comment.body,
        at: comment.createdAt,
        url: comment.url,
      })),
  ]
    .filter(message => !(message.login !== me && approvedSince(pr, message.login, message.at)))
    .sort((a, b) => new Date(a.at) - new Date(b.at));

  if (!messages.length) return null;

  const first = messages[0];
  const last = messages[messages.length - 1];
  const excerpt = cleanExcerpt(last.body);
  const mine = messages.filter(message => message.login === me);

  return {
    id: `discussion:${pr.id}`,
    // Named after the form the last word took, which is the one the excerpt shows.
    channel: last.channel,
    isResolved: false,
    isOutdated: false,
    path: null,
    line: null,
    url: last.url,
    author: first.login,
    fromBot: false,
    startedByMe: first.login === me,
    iParticipated: mine.length > 0,
    lastAuthor: last.login,
    lastByMe: last.login === me,
    lastAt: last.at,
    myLastAt: mine.map(message => message.at).sort().pop() ?? null,
    excerpt: excerpt.text,
    excerptTruncated: excerpt.truncated,
    commentCount: messages.length,
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

// GitHub's StatusState enum for a commit rollup: ERROR, EXPECTED, FAILURE, PENDING,
// SUCCESS — or no rollup at all, when nothing was ever posted to that commit. Folding
// "no rollup" into "still running" told a card whose outcome will never arrive to keep
// breathing forever: merging into a branch with no CI configured on push (a stacked
// feature branch used only to collect other PRs, say) leaves the merge commit with zero
// checks, permanently, not a transient gap before the real answer shows up.
// A check suite's own conclusion already accounts for continue-on-error jobs inside it —
// it reads SUCCESS as soon as every *required* job passed, even when an optional one
// failed. The coarse rollup does not: it flags FAILURE for the whole commit purely because
// one CheckRun inside a passing suite has conclusion FAILURE, which is exactly what a
// continue-on-error flaky test looks like — observed on agent-nodejs#1918, whose release
// job ran and published, worn red anyway because "LLM Integration Tests" is allowed to
// fail without blocking it. Suites with zero check runs (Nx Cloud, Macroscope, ...) never
// fired for this commit — a push event, not the pull_request one they listen for — and are
// not a signal either way. Fixtures with no checkSuites data fall back to the rollup.
// Not this commit's pipeline: a workflow reacting to another one's completion, or a cron
// that happens to land on the branch tip. forestadmin-server#8542 wore red for a deploy
// that had passed, because "Notify CI Failure on Main" — a workflow_run reaction, broken
// for a year — had failed beside it. A suite with no workflowRun (an app outside Actions,
// a fixture) still counts, as before.
const REACTIVE_EVENTS = new Set(['workflow_run', 'schedule']);
const FAILED_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE']);

function pipelineSummary(mergeCommit) {
  // A suite with no check run is usually an app that never fires on a push (Nx Cloud,
  // Macroscope — no workflow run, QUEUED for ever). But an Actions workflow just queued has
  // no job yet either: forestadmin-server#8534, two minutes after its merge, read as
  // settled green while its deploy was about to start. A workflow run tells them apart.
  const suites = (mergeCommit?.checkSuites?.nodes ?? [])
    .filter(s => (s.checkRuns?.totalCount ?? 0) > 0 || (s.workflowRun && s.status !== 'COMPLETED'))
    .filter(s => !REACTIVE_EVENTS.has(s.workflowRun?.event));
  if (suites.length) {
    if (suites.some(s => s.status !== 'COMPLETED')) return { outcome: 'running', failure: null };
    const failed = suites.find(s => FAILED_CONCLUSIONS.has(s.conclusion));
    if (failed) {
      const run = failed.workflowRun;
      return {
        outcome: 'failed',
        // Named, so the pill can say which workflow broke rather than "release failed".
        failure: run ? { workflow: run.workflow?.name ?? null, url: run.url ?? null } : null,
      };
    }
    return { outcome: 'done', failure: null };
  }
  const pipeline = mergeCommit?.statusCheckRollup?.state ?? null;
  if (pipeline === 'FAILURE' || pipeline === 'ERROR') return { outcome: 'failed', failure: null };
  if (pipeline === 'SUCCESS') return { outcome: 'done', failure: null };
  if (pipeline === 'PENDING' || pipeline === 'EXPECTED') return { outcome: 'running', failure: null };
  return { outcome: 'none', failure: null };
}

// The newest release of the repo, when it landed after this merge. It is a correlation,
// not a fact GitHub states: two merges minutes apart could both point at the same tag,
// which is why the label says "latest release since the merge" rather than "this one's".
// A release is cut from the default branch, so a merge into a stacked feature branch
// cannot be in it yet, whatever the repo published afterwards — observed on
// forest-rails#803, whose checks passed and which would otherwise have worn v9.21.0
// while sitting on a side branch main had not received.
function releaseAfterMerge(pr) {
  const latest = pr.repository.latestRelease;
  if (!pr.merged || !latest?.publishedAt) return null;
  if (pr.baseRefName && pr.baseRefName !== pr.repository.defaultBranchRef?.name) return null;
  if (new Date(latest.publishedAt) < new Date(pr.mergedAt)) return null;
  return { tag: latest.tagName, url: latest.url, publishedAt: latest.publishedAt };
}

function baseShape(pr, me) {
  const lastCommit = pr.head.nodes[0]?.commit;
  const discussion = discussionThread(pr, me);

  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    repo: pr.repository.nameWithOwner,
    state: pr.state,
    isDraft: pr.isDraft,
    merged: pr.merged,
    mergedAt: pr.mergedAt,
    // The rollup on the merge commit, not on the PR head: it is the release pipeline
    // that runs after the squash, and the only part still worth watching.
    mergePipeline: pr.mergeCommit?.statusCheckRollup?.state ?? null,
    // The raw value kept above for anyone reading it directly; this is what "running" vs
    // "no signal at all" actually means, computed once so the render layer and the sort
    // order cannot drift apart on it.
    pipelineOutcome: pipelineSummary(pr.mergeCommit).outcome,
    pipelineFailure: pipelineSummary(pr.mergeCommit).failure,
    release: releaseAfterMerge(pr),
    // Title, then branch: the board's query leaves the description out for its weight.
    ticket: ticketKey(pr),
    // The branch it landed on, but only once merged, and only when that isn't the
    // repo's default: a merge into a stacked feature branch has not shipped the way a
    // merge into main has, and the pipeline outcome alone cannot say that — a branch with
    // no CI on push looks exactly like one that is genuinely settled.
    mergeTarget:
      pr.merged && pr.baseRefName && pr.baseRefName !== pr.repository.defaultBranchRef?.name
        ? pr.baseRefName
        : null,
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
      ...(discussion ? [discussion] : []),
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

  // Once merged, unaddressed remarks, head CI and conflicts are all history — they were
  // about getting it merged. The release is the only thing that can still ask anything.
  if (pr.merged) {
    if (pr.pipelineOutcome === 'failed') {
      reasons.push({ kind: 'merge-pipeline' });
    }
  } else {
    if (toFix.length) reasons.push({ kind: 'threads', count: toFix.length });
    if (changesRequested.length) {
      reasons.push({ kind: 'changes-requested', authors: changesRequested.map(r => r.author) });
    }
    if (pr.ciState === 'FAILURE' || pr.ciState === 'ERROR') reasons.push({ kind: 'ci' });
    if (pr.mergeable === 'CONFLICTING') reasons.push({ kind: 'conflict' });
  }

  const needsAction = reasons.length > 0;

  // A freshly opened PR asks nothing of me, but I am blocked on a review — "nothing to
  // report" undersells that. A draft is waiting on no one.
  const awaitingReview = !pr.merged && !pr.isDraft && pr.reviewDecision !== 'APPROVED';
  // Approved with nothing left open: the one move left is mine, merging. It used to be
  // "nothing to report", green, below the merged group — read as already done. A CI still
  // running keeps it here (its pill says so); a failing one is an action above.
  const readyToMerge = !pr.merged && !pr.isDraft && pr.reviewDecision === 'APPROVED';

  const bucket = needsAction
    ? 'action'
    : pr.merged
      ? 'merged'
      : waitingOnThem.length || awaitingReview
        ? 'waiting'
        : readyToMerge
          ? 'ready'
          : 'idle';

  return {
    ...pr,
    side: 'mine',
    toFix,
    waitingOnThem,
    changesRequested,
    reasons,
    needsAction,
    awaitingReview,
    bucket,
  };
}

// `reviewOwedByMe`: GitHub's formal review request, or this org's other way of handing the
// same responsibility off — an assignee with no request at all, observed on
// agent-nodejs#1912, opened by an automated author with its human owner only assigned.
function decorateReview(pr, me, reviewOwedByMe) {
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
  if (reviewOwedByMe && !iHaveReviewed) reasons.push({ kind: 'to-review' });
  if (answeredToMe.length) reasons.push({ kind: 'answers', count: answeredToMe.length });
  // Remarks I raised, answered and resolved, then new commits: the PR waits on my second look
  // and my verdict, though nothing is left open — forestadmin-server#8561 sat in "nothing to
  // report" for its only reviewer. Raising the remark, not just commenting, is what counts:
  // a passing comment should not ring on every push.
  const raisedRemarks = myThreads.some(thread => thread.startedByMe);
  if (
    pushedSinceMyFeedback &&
    (awaitingAuthor.length || myLatestVerdict === 'CHANGES_REQUESTED' || (raisedRemarks && myLatestVerdict !== 'APPROVED'))
  ) {
    reasons.push({ kind: 'recheck' });
  }

  const awaitingFix = awaitingAuthor.length > 0 || myLatestVerdict === 'CHANGES_REQUESTED';

  // Once merged, every pending state is history — the same rule my own PRs follow. Left
  // in, a merged PR would keep claiming a reply was waiting for me on something closed,
  // which is exactly what kept other people's merges off the board in the first place.
  return {
    ...pr,
    side: 'review',
    reviewOwedByMe,
    iHaveReviewed,
    myLatestVerdict,
    myLastActivity: myLastActivity ?? null,
    awaitingAuthor: pr.merged ? [] : awaitingAuthor,
    answeredToMe: pr.merged ? [] : answeredToMe,
    pushedSinceMyFeedback: pr.merged ? false : pushedSinceMyFeedback,
    reasons: pr.merged ? [] : reasons,
    needsAction: pr.merged ? false : reasons.length > 0,
    awaitingFix: pr.merged ? false : awaitingFix,
    bucket: pr.merged
      ? 'merged'
      : reasons.length
        ? 'action'
        : awaitingFix
          ? 'waiting'
          : 'idle',
  };
}

// A landed release is the one thing on the board that is finished, so it goes last
// among equals. Freshness alone only correlates with "still running" — a merge whose
// pipeline finished fast would otherwise outrank one still in flight. "Finished" here
// means anything but genuinely running: a merge with no CI signal at all is not going
// to resolve later, so it settles immediately rather than contending for top billing
// forever.
const settledRank = pr => (pr.merged && pr.pipelineOutcome !== 'running' ? 1 : 0);

const byActionThenFreshness = (a, b) =>
  Number(b.needsAction) - Number(a.needsAction) ||
  settledRank(a) - settledRank(b) ||
  new Date(b.lastActivityAt) - new Date(a.lastActivityAt);

// A merge is talked about at the next standup, so the window has to survive the night: a
// rolling twelve hours dropped a five-o'clock merge before anyone could mention it. Back
// to the start of the previous working day instead, which is the same window the standup
// notes use — and on a Monday that reaches Friday, where no count of hours would.
function mergedSince() {
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  do {
    since.setDate(since.getDate() - 1);
  } while (since.getDay() === 0 || since.getDay() === 6);
  return since.getTime();
}

// Extra qualifiers of different kinds are ORed by GitHub search: `org:A repo:b/c` returns
// both, at no extra call. GitHub refuses a query longer than 256 characters.
const SEARCH_LIMIT = 256;
const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const LONGEST_SUFFIX = ' is:pr is:open review-requested:@me -author:@me';

function parseExtraRepos(value) {
  return String(value ?? '')
    .split(',')
    .map(repo => repo.trim())
    .filter(Boolean);
}

function ownerScope(org, extraRepos = []) {
  const bad = extraRepos.filter(repo => !REPO_RE.test(repo));
  if (bad.length) throw new Error(`PR_RADAR_EXTRA_REPOS: not an owner/name: ${bad.join(', ')}`);
  const owners = [`org:${org}`, ...extraRepos.map(repo => `repo:${repo}`)].join(' ');
  if (owners.length + LONGEST_SUFFIX.length > SEARCH_LIMIT) {
    throw new Error(`PR_RADAR_EXTRA_REPOS: too many repos for one GitHub search (${SEARCH_LIMIT} characters at most)`);
  }
  return owners;
}

// Everything the searches tell, kept so the board can be reshaped from reloaded PRs alone:
// who I am, which source each PR came from, and the windows it is judged against.
async function discover({ org, extraRepos = [], maxAgeDays }) {
  const owners = ownerScope(org, extraRepos);
  const scope = `${owners} is:pr is:open`;
  // `reviewed-by:` only matches a formally submitted review: a PR where you merely
  // commented never shows up there. `commenter:` covers that case.
  const me = (await gh(['api', '/user', '--jq', '.login'])).trim();

  // Five independent sources, run one at a time. With `Promise.all`, a timeout on one
  // would wipe out the four valid answers and leave an empty screen; keep what answered
  // and report the gaps — a silent `author` would otherwise read as "you have no open
  // PRs". Running them in a burst is also what triggered the secondary rate limit.
  const warnings = [];
  const settled = await sequentially([
    () => searchPullRequests(`${scope} author:@me`),
    () => searchPullRequests(`${scope} reviewed-by:@me -author:@me`),
    () => searchPullRequests(`${scope} review-requested:@me -author:@me`),
    // See `reviewOwedByMe` below: an assignee with no formal request also owes a review.
    () => searchPullRequests(`${scope} assignee:@me -author:@me`),
    () => searchPullRequests(`${scope} commenter:@me -author:@me`),
    // Merged PRs are searched separately: `scope` pins `is:open`.
    () => searchPullRequests(`${owners} is:pr is:merged author:@me`),
    // A PR I reviewed vanished the moment it merged, though "the one I reviewed shipped"
    // is worth a line at a standup. Only a submitted review counts here: for a PR I
    // merely commented on, its landing is not really my news.
    () => searchPullRequests(`${owners} is:pr is:merged reviewed-by:@me -author:@me`),
    () => recentlyTouchedPullRequests(org, me),
  ]);

  const SOURCES = [
    'author',
    'reviewed-by',
    'review-requested',
    'assigned',
    'commenter',
    'merged',
    'merged-reviewed',
    'events',
  ];
  const sourceOf = (index, fallback) => {
    const result = settled[index];
    if (result.status === 'fulfilled') return result.value;
    warnings.push({ source: SOURCES[index], message: String(result.reason?.message ?? result.reason) });
    return fallback;
  };

  const [
    mineFound,
    reviewedFound,
    requestedFound,
    assignedFound,
    commentedFound,
    mergedFound,
    mergedReviewedFound,
    touchedRefs,
  ] = [
    sourceOf(0, []),
    sourceOf(1, []),
    sourceOf(2, []),
    sourceOf(3, []),
    sourceOf(4, []),
    sourceOf(5, []),
    sourceOf(6, []),
    sourceOf(7, []),
  ];

  if (warnings.length === settled.length) {
    throw new Error(`Aucune source GitHub n'a répondu : ${warnings[0].message}`);
  }

  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  // Deliberately loose pre-filter: `updatedAt` overstates freshness, so it only avoids
  // loading PRs that are dead for certain. The real cut happens on `lastActivityAt`,
  // which needs the details.
  const maybeFresh = item => new Date(item.updatedAt).getTime() >= cutoff;
  const found = [...mineFound, ...reviewedFound, ...requestedFound, ...assignedFound, ...commentedFound];

  const mergedCutoff = mergedSince();
  const withinMergedWindow = item => new Date(item.updatedAt).getTime() >= mergedCutoff;
  const mergedIds = new Set(mergedFound.filter(withinMergedWindow).map(item => item.id));
  const mergedReviewedIds = new Set(
    mergedReviewedFound.filter(withinMergedWindow).map(item => item.id),
  );
  const stale = new Set(found.filter(item => !maybeFresh(item)).map(item => item.id));

  const ids = items => new Set(items.filter(maybeFresh).map(item => item.id));
  const mineSet = ids(mineFound);
  mergedIds.forEach(id => mineSet.add(id));
  const requestedSet = ids(requestedFound);
  const assignedSet = ids(assignedFound);
  const reviewSet = new Set([
    ...ids(reviewedFound),
    ...ids(commentedFound),
    ...requestedSet,
    ...assignedSet,
  ]);
  mergedReviewedIds.forEach(id => reviewSet.add(id));

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

  return {
    me,
    org,
    maxAgeDays,
    warnings,
    cutoff,
    mergedCutoff,
    stale,
    mineSet,
    reviewSet,
    requestedSet,
    assignedSet,
    mergedReviewedIds,
    extraIds: new Set(extraIds),
    ids: [...known, ...extraIds],
  };
}

async function loadNodes(ids, warnings) {
  const byId = await fetchPullRequests(ids, warnings);
  await settleMergeable(byId, warnings);
  return byId;
}

// Pure: the board from the raw nodes and the discovery context. The context's sets are
// copied: a reshape after reloading a few PRs starts again from what the searches found,
// or a PR moved by the taken-over rule would stay on my side after its author pushed.
function shapeBoard(nodes, context, detailWarnings = []) {
  const { me, org, maxAgeDays, cutoff, mergedCutoff, requestedSet, assignedSet, mergedReviewedIds } = context;
  const stale = new Set(context.stale);
  const mineSet = new Set(context.mineSet);
  const reviewSet = new Set(context.reviewSet);
  const warnings = [...context.warnings, ...detailWarnings];
  const extraIds = [...context.extraIds];
  const byId = nodes;

  const shapes = new Map();
  for (const [id, node] of byId) {
    const shaped = baseShape(node, me);

    // Only my own merges are worth watching — the release I set off is mine to see
    // through; someone else's is their business. Without this the relaxed state filter
    // let any merged PR through, and the review side reported "a reply for you" on a
    // closed one.
    if (shaped.merged) {
      // "Mine" in the same sense the board already uses: opened by me, or taken over by
      // me. A second definition of ownership would classify a taken-over merge one way
      // and colour it another.
      const mine = shaped.author === me || shaped.headCommitAuthor === me;
      const fresh = new Date(shaped.mergedAt).getTime() >= mergedCutoff;
      // Read on the PR itself, not only from the last search: a PR I reviewed that merges
      // between two searches is reloaded on its own, and the search that would have listed
      // it as merged-and-reviewed has not run yet — the card vanished until it did.
      const reviewedByMe = shaped.reviews.some(review => review.author === me);
      // Kept whatever the outcome: dropping it on success would make "it passed"
      // indistinguishable from "I never saw it".
      if (fresh && (mine || mergedReviewedIds.has(id) || reviewedByMe)) shapes.set(id, shaped);
      continue;
    }

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
    .map(pr => decorateReview(pr, me, requestedSet.has(pr.id) || assignedSet.has(pr.id)))
    .sort(byActionThenFreshness);

  return {
    me,
    org,
    maxAgeDays,
    mergedSince: new Date(mergedCutoff).toISOString(),
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

async function fetchBoard(options) {
  const context = await discover(options);
  const detailWarnings = [];
  const nodes = await loadNodes(context.ids, detailWarnings);
  return { context, nodes, board: shapeBoard(nodes, context, detailWarnings) };
}

async function fetchDashboard(options) {
  return (await fetchBoard(options)).board;
}

// The pure functions are exported for the tests: every classification bug hit so far
// lived here, not in the network calls.
module.exports = {
  fetchDashboard,
  fetchBoard,
  loadNodes,
  shapeBoard,
  ownerScope,
  parseExtraRepos,
  SEARCH_LIMIT,
  byActionThenFreshness,
  baseShape,
  decorateMine,
  decorateReview,
  lastActivity,
  contributorsOf,
  discussionThread,
  asksNothing,
  cleanExcerpt,
  isBot,
  fetchDigestInputs,
  mergedSince,
};
