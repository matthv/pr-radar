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
      commits(last: 1) {
        nodes {
          commit {
            committedDate
            author { user { login } }
            statusCheckRollup { state }
          }
        }
      }
      reviews(first: 30) { nodes { author { __typename login } state submittedAt url } }
      comments(last: 30) { nodes { author { __typename login } createdAt url body } }
      reviewRequests(first: 20) {
        nodes { requestedReviewer { __typename ... on User { login } ... on Team { name } } }
      }
      reviewThreads(first: 50) {
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

// `gh api --input -` ne reçoit pas correctement un body piped depuis Node (gh <= 2.7) :
// la requête part malformée et GitHub la coupe. On passe donc par un fichier.
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

// La search GraphQL time out (HTTP 499) sur une org d'une certaine taille ;
// la search REST, elle, répond, et son node_id est directement l'id GraphQL du PullRequest.
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

// L'index de recherche GitHub oublie des PRs : un commentaire posté depuis trois jours
// peut rester invisible à `commenter:` et à `involves:`. Le flux d'événements du compte
// ne passe pas par cet index et rattrape ces trous — au prix d'une fenêtre courte
// (300 événements, 90 jours max).
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
      // Les IssueCommentEvent couvrent aussi les vraies issues.
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

async function fetchPullRequests(ids) {
  const batches = [];
  for (let i = 0; i < ids.length; i += PR_BATCH_SIZE) {
    batches.push(ids.slice(i, i + PR_BATCH_SIZE));
  }

  const responses = await mapWithConcurrency(batches, PR_CONCURRENCY, batch =>
    graphql(PR_QUERY, { ids: batch }),
  );

  const byId = new Map();
  for (const response of responses) {
    for (const node of response.nodes) {
      if (node?.id) byId.set(node.id, node);
    }
  }
  return byId;
}

// Les bots (qlty, macroscope…) postent du HTML et du markdown échappé :
// sans nettoyage l'extrait affiche des balises brutes.
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

// `updatedAt` de GitHub bouge pour un label posé, un mergeable recalculé ou une CI
// relancée : une PR sans le moindre commit depuis 200 jours s'y déclare fraîche. On
// datte donc l'activité par ce qu'un humain a réellement fait.
function lastActivity(pr) {
  const dates = [
    pr.createdAt,
    pr.commits.nodes[0]?.commit?.committedDate,
    ...pr.reviews.nodes.filter(r => r?.author?.__typename !== 'Bot').map(r => r?.submittedAt),
    ...pr.comments.nodes.filter(c => c?.author?.__typename !== 'Bot').map(c => c?.createdAt),
    ...pr.reviewThreads.nodes.flatMap(t =>
      t.comments.nodes.filter(c => c?.author?.__typename !== 'Bot').map(c => c.createdAt),
    ),
  ].filter(Boolean);

  return dates.sort().pop();
}

// Un retour de review ne vit pas forcément dans un thread inline : beaucoup de
// relecteurs écrivent dans la conversation principale de la PR. On la replie en un
// thread synthétique pour que tout le reste du classement la traite à l'identique.
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

function baseShape(pr, me) {
  const lastCommit = pr.commits.nodes[0]?.commit;
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
    authorAvatar: pr.author?.avatarUrl ?? null,
    labels: pr.labels.nodes.map(l => ({ name: l.name, color: l.color })),
    ciState: lastCommit?.statusCheckRollup?.state ?? null,
    lastCommitAt: lastCommit?.committedDate ?? null,
    headCommitAuthor: lastCommit?.author?.user?.login ?? null,
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

  // Les raisons ne portent qu'un `kind` : la phrase est rendue côté client, qui seul
  // connaît la langue choisie.
  const reasons = [];
  if (toFix.length) reasons.push({ kind: 'threads', count: toFix.length });
  if (changesRequested.length) {
    reasons.push({ kind: 'changes-requested', authors: changesRequested.map(r => r.author) });
  }
  if (pr.ciState === 'FAILURE' || pr.ciState === 'ERROR') reasons.push({ kind: 'ci' });
  if (pr.mergeable === 'CONFLICTING') reasons.push({ kind: 'conflict' });

  const needsAction = reasons.length > 0;

  return {
    ...pr,
    side: 'mine',
    toFix,
    waitingOnThem,
    changesRequested,
    reasons,
    needsAction,
    bucket: needsAction ? 'action' : waitingOnThem.length ? 'waiting' : 'idle',
  };
}

function decorateReview(pr, me, requestedFromMe) {
  const myThreads = pr.threads.filter(t => t.iParticipated);
  const myUnresolved = myThreads.filter(t => !t.isResolved);
  const awaitingAuthor = myUnresolved.filter(t => t.lastByMe);
  const answeredToMe = myUnresolved.filter(t => !t.lastByMe);

  const myReviews = pr.reviews.filter(r => r.author === me);
  const myLastActivity = [
    ...myReviews.map(r => r.submittedAt),
    ...myThreads.map(t => t.myLastAt),
  ]
    .filter(Boolean)
    .sort()
    .pop();

  // Un commit de moi n'est pas quelque chose à re-vérifier : sans ce garde-fou, une PR
  // dont j'ai repris la main me demande de contrôler mon propre travail.
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
  // `reviewed-by:` ne matche qu'une review formellement soumise : une PR où l'on a
  // seulement commenté n'y apparaît pas. `commenter:` couvre ce cas.
  const me = (await gh(['api', '/user', '--jq', '.login'])).trim();

  const [mineFound, reviewedFound, requestedFound, commentedFound, touchedRefs] = await Promise.all([
    searchPullRequests(`${scope} author:@me`),
    searchPullRequests(`${scope} reviewed-by:@me -author:@me`),
    searchPullRequests(`${scope} review-requested:@me -author:@me`),
    searchPullRequests(`${scope} commenter:@me -author:@me`),
    recentlyTouchedPullRequests(org, me),
  ]);

  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  // Pré-filtre volontairement large : `updatedAt` sur-estime la fraîcheur, donc il ne
  // sert qu'à ne pas charger les PRs mortes de façon certaine. Le vrai tri se fait
  // ensuite sur `lastActivityAt`, qui demande les détails.
  const maybeFresh = item => new Date(item.updatedAt).getTime() >= cutoff;
  const found = [...mineFound, ...reviewedFound, ...requestedFound, ...commentedFound];
  const stale = new Set(found.filter(item => !maybeFresh(item)).map(item => item.id));

  const ids = items => new Set(items.filter(maybeFresh).map(item => item.id));
  const mineSet = ids(mineFound);
  const requestedSet = ids(requestedFound);
  const reviewSet = new Set([...ids(reviewedFound), ...ids(commentedFound), ...requestedSet]);

  // Les PRs venues du flux d'événements n'ont pas traversé la search : ni leur état ni
  // leur auteur ne sont garantis. On les charge, puis on répartit sur l'auteur réel.
  const touchedIds = await resolvePullRequestIds(touchedRefs);
  const known = new Set([...mineSet, ...reviewSet]);
  const extraIds = touchedIds.filter(id => !known.has(id));

  const byId = await fetchPullRequests([...known, ...extraIds]);

  const shapes = new Map();
  for (const [id, node] of byId) {
    const shaped = baseShape(node, me);
    if (shaped.state !== 'OPEN') continue;
    if (new Date(shaped.lastActivityAt).getTime() >= cutoff) shapes.set(id, shaped);
    else stale.add(id);
  }

  for (const id of extraIds) {
    const shaped = shapes.get(id);
    if (!shaped) continue;
    (shaped.author === me ? mineSet : reviewSet).add(id);
  }

  // Reprendre la main sur la PR de quelqu'un d'autre, c'est en devenir responsable :
  // le prochain geste est le mien, donc elle passe côté « mes PRs ». Dès que l'auteur
  // repousse, le commit de tête change et elle repart côté review — c'est réversible.
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
    fetchedAt: new Date().toISOString(),
    mine,
    reviews,
    counts: {
      hiddenStale: stale.size,
      // PRs réellement prises en compte : affichées + écartées par la fenêtre d'âge.
      // Les PRs mergées venues du flux d'événements n'en font pas partie.
      seenTotal: shapes.size + stale.size,
      mineTotal: mine.length,
      mineAction: mine.filter(p => p.needsAction).length,
      reviewsTotal: reviews.length,
      reviewsAction: reviews.filter(p => p.needsAction).length,
      reviewsWaitingFix: reviews.filter(p => p.bucket === 'waiting').length,
    },
  };
}

module.exports = { fetchDashboard };
