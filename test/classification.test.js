'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  baseShape,
  decorateMine,
  decorateReview,
  lastActivity,
  contributorsOf,
  discussionThread,
  cleanExcerpt,
  isBot,
  byActionThenFreshness,
} = require('../github');

const ME = 'me';
const DAY = 24 * 60 * 60 * 1000;
const ago = days => new Date(Date.now() - days * DAY).toISOString();

const user = (login, avatarUrl = `https://avatars/${login}`) => ({ __typename: 'User', login, avatarUrl });
const bot = login => ({ __typename: 'Bot', login });

// A minimal but complete GraphQL node: each test overrides only what it examines.
function node(overrides = {}) {
  return {
    id: 'PR_1',
    number: 1,
    title: 'a pull request',
    url: 'https://github.com/o/r/pull/1',
    state: 'OPEN',
    isDraft: false,
    createdAt: ago(10),
    updatedAt: ago(10),
    mergeable: 'MERGEABLE',
    merged: false,
    mergedAt: null,
    mergeCommit: null,
    reviewDecision: null,
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    author: user('author'),
    repository: { nameWithOwner: 'o/r' },
    labels: { nodes: [] },
    head: { nodes: [{ commit: { committedDate: ago(9), author: { user: user('author') }, statusCheckRollup: null } }] },
    recent: { nodes: [{ commit: { author: { user: user('author') } } }] },
    reviews: { nodes: [] },
    comments: { nodes: [] },
    reviewRequests: { nodes: [] },
    reviewThreads: { nodes: [] },
    ...overrides,
  };
}

const thread = ({ comments, isResolved = false, path = 'src/a.rb' }) => ({
  id: 'T_1',
  isResolved,
  isOutdated: false,
  path,
  line: 12,
  comments: {
    totalCount: comments.length,
    nodes: comments.map(([author, at]) => ({
      author: typeof author === 'string' ? user(author) : author,
      body: 'some remark',
      createdAt: at,
      url: 'https://github.com/o/r/pull/1#discussion_r1',
    })),
  },
});

const issueComment = ([author, at]) => ({
  author: typeof author === 'string' ? user(author) : author,
  createdAt: at,
  url: 'https://github.com/o/r/pull/1#issuecomment-1',
  body: 'a plain comment',
});

test('lastActivity ignores updatedAt, which GitHub moves for a label or a CI re-run', () => {
  // The real case: agent-ruby#259, no commit for 204 days, `updatedAt` at 2 days.
  const pr = node({
    createdAt: ago(204),
    updatedAt: ago(2),
    head: { nodes: [{ commit: { committedDate: ago(204), author: { user: user('author') }, statusCheckRollup: null } }] },
  });
  const days = (Date.now() - new Date(lastActivity(pr))) / DAY;
  assert.ok(days > 200, `attendu > 200 jours d'inactivité, obtenu ${days.toFixed(0)}`);
});

test('lastActivity ignores bot comments — a linter passing by does not wake a PR up', () => {
  const pr = node({
    createdAt: ago(100),
    head: { nodes: [{ commit: { committedDate: ago(100), author: { user: user('author') }, statusCheckRollup: null } }] },
    comments: { nodes: [issueComment([bot('qltysh'), ago(1)])] },
  });
  const days = (Date.now() - new Date(lastActivity(pr))) / DAY;
  assert.ok(days > 90, `attendu > 90 jours, obtenu ${days.toFixed(0)}`);
});

test('lastActivity counts a human comment', () => {
  const pr = node({ createdAt: ago(100), comments: { nodes: [issueComment(['someone', ago(1)])] } });
  const days = (Date.now() - new Date(lastActivity(pr))) / DAY;
  assert.ok(days < 2, `attendu < 2 jours, obtenu ${days.toFixed(0)}`);
});

test('a review comment left in the PR conversation becomes a thread', () => {
  const pr = node({
    comments: { nodes: [issueComment(['author', ago(5)]), issueComment([ME, ago(3)])] },
  });
  const discussion = discussionThread(pr, ME);

  assert.ok(discussion, 'un thread de discussion était attendu');
  assert.equal(discussion.path, null, 'une discussion n’a pas de fichier');
  assert.equal(discussion.author, 'author');
  assert.equal(discussion.iParticipated, true);
  assert.equal(discussion.lastByMe, true);
  assert.equal(discussion.commentCount, 2);
});

test('the discussion thread excludes bots', () => {
  const pr = node({ comments: { nodes: [issueComment([bot('qltysh'), ago(1)])] } });
  assert.equal(discussionThread(pr, ME), null);
});

// Observed on forest-rails#796: a reviewer wrote in the body of their review, I answered
// in the PR conversation seventeen minutes later, and the board showed both "1 to fix"
// and "1 awaiting a reply" — one exchange, counted twice.
test('answering in the conversation settles a remark left in a review body', () => {
  const pr = node({
    reviews: {
      nodes: [
        { author: user('reviewer'), state: 'COMMENTED', submittedAt: ago(3), url: 'u', body: 'index and count still hold' },
      ],
    },
    comments: { nodes: [issueComment([ME, ago(2)])] },
  });
  const decorated = decorateMine(baseShape(pr, ME));

  assert.equal(decorated.toFix.length, 0, 'ma réponse a répondu à sa remarque');
  assert.equal(decorated.waitingOnThem.length, 1);
  assert.equal(decorated.bucket, 'waiting');
});

test('the discussion is one thread across both of its forms', () => {
  const pr = node({
    reviews: {
      nodes: [
        { author: user('reviewer'), state: 'COMMENTED', submittedAt: ago(3), url: 'u', body: 'a remark' },
      ],
    },
    comments: { nodes: [issueComment([ME, ago(2)])] },
  });
  const threads = baseShape(pr, ME).threads;

  assert.equal(threads.length, 1);
  assert.equal(threads[0].commentCount, 2);
  // Named after the form the last word took, which is the one the excerpt shows.
  assert.equal(threads[0].channel, 'conversation');
});

test('reviewing: I spoke last, so I am waiting on the author', () => {
  const pr = node({ comments: { nodes: [issueComment([ME, ago(3)])] } });
  const decorated = decorateReview(baseShape(pr, ME), ME, false);

  assert.equal(decorated.awaitingAuthor.length, 1);
  assert.equal(decorated.answeredToMe.length, 0);
  assert.equal(decorated.awaitingFix, true);
  assert.equal(decorated.bucket, 'waiting');
  assert.equal(decorated.needsAction, false);
});

test('reviewing: the author replied after me, so the ball is back in my court', () => {
  const pr = node({
    comments: { nodes: [issueComment([ME, ago(3)]), issueComment(['author', ago(1)])] },
  });
  const decorated = decorateReview(baseShape(pr, ME), ME, false);

  assert.equal(decorated.answeredToMe.length, 1);
  assert.equal(decorated.bucket, 'action');
  assert.ok(decorated.reasons.some(r => r.kind === 'answers'));
});

test('reviewing: commits pushed after my feedback need a re-check', () => {
  const pr = node({
    comments: { nodes: [issueComment([ME, ago(5)])] },
    head: { nodes: [{ commit: { committedDate: ago(1), author: { user: user('author') }, statusCheckRollup: null } }] },
  });
  const decorated = decorateReview(baseShape(pr, ME), ME, false);

  assert.equal(decorated.pushedSinceMyFeedback, true);
  assert.ok(decorated.reasons.some(r => r.kind === 'recheck'));
});

// The bug: `pushedSinceMyFeedback` only compared dates, never the commit author — a PR
// you had just fixed yourself asked you to re-read your own work.
test('reviewing: my own commits are never something for me to re-check', () => {
  const pr = node({
    comments: { nodes: [issueComment([ME, ago(5)])] },
    head: { nodes: [{ commit: { committedDate: ago(1), author: { user: user(ME) }, statusCheckRollup: null } }] },
  });
  const decorated = decorateReview(baseShape(pr, ME), ME, false);

  assert.equal(decorated.pushedSinceMyFeedback, false);
  assert.equal(decorated.reasons.some(r => r.kind === 'recheck'), false);
});

test('reviewing: a review requested and not done is an action', () => {
  const pr = node();
  const decorated = decorateReview(baseShape(pr, ME), ME, true);

  assert.equal(decorated.iHaveReviewed, false);
  assert.ok(decorated.reasons.some(r => r.kind === 'to-review'));
  assert.equal(decorated.bucket, 'action');
});

// The channel the tool read nowhere: a review carrying its remarks in its own body, with
// no inline comment. Observed on forest-rails#801, which sat in "nothing to report".
test('reviewing: a commented review with a body awaits a fix', () => {
  const pr = node({
    reviews: {
      nodes: [
        { author: user(ME), state: 'COMMENTED', submittedAt: ago(2), url: 'u', body: 'A few things before merge' },
      ],
    },
  });
  const decorated = decorateReview(baseShape(pr, ME), ME, false);

  assert.equal(decorated.awaitingAuthor.length, 1);
  assert.equal(decorated.awaitingFix, true);
  assert.equal(decorated.bucket, 'waiting');
  assert.equal(decorated.awaitingAuthor[0].channel, 'review');
  assert.match(decorated.awaitingAuthor[0].excerpt, /A few things before merge/);
});

test('reviewing: an approval body is not pending feedback', () => {
  const pr = node({
    reviews: {
      nodes: [
        { author: user(ME), state: 'APPROVED', submittedAt: ago(2), url: 'u', body: 'LGTM, nice one' },
      ],
    },
  });
  const decorated = decorateReview(baseShape(pr, ME), ME, false);

  assert.equal(decorated.awaitingFix, false);
  assert.equal(decorated.bucket, 'idle');
});

test('mine: a reviewer who only wrote in the review body is something to address', () => {
  const pr = node({
    reviews: {
      nodes: [
        { author: user('reviewer'), state: 'COMMENTED', submittedAt: ago(2), url: 'u', body: 'Two questions' },
      ],
    },
  });
  const decorated = decorateMine(baseShape(pr, ME));

  assert.equal(decorated.toFix.length, 1);
  assert.ok(decorated.reasons.some(r => r.kind === 'threads'));
  assert.equal(decorated.bucket, 'action');
});

test('reviewing: a bot review body is not feedback of mine', () => {
  const pr = node({
    reviews: {
      nodes: [
        { author: { __typename: 'Bot', login: 'macroscopeapp' }, state: 'COMMENTED', submittedAt: ago(2), url: 'u', body: 'scan complete' },
      ],
    },
  });
  const decorated = decorateReview(baseShape(pr, ME), ME, false);

  assert.equal(decorated.awaitingFix, false);
  assert.equal(decorated.bucket, 'idle');
});

// A PR I reviewed used to vanish the moment it merged, though it is what I talk about at
// the next standup. Its pending states have to go with the merge, or it would keep saying
// a reply was waiting for me on something closed.
test('reviewing: a merge settles everything that was pending', () => {
  const pr = node({
    merged: true,
    mergedAt: ago(1),
    state: 'MERGED',
    reviews: {
      nodes: [
        { author: user(ME), state: 'CHANGES_REQUESTED', submittedAt: ago(4), url: 'u', body: '' },
      ],
    },
    reviewThreads: {
      nodes: [thread({ comments: [[ME, ago(4)]] })],
    },
  });
  const decorated = decorateReview(baseShape(pr, ME), ME, true);

  assert.equal(decorated.bucket, 'merged');
  assert.equal(decorated.needsAction, false);
  assert.equal(decorated.awaitingFix, false);
  assert.equal(decorated.awaitingAuthor.length, 0);
  assert.deepEqual(decorated.reasons, []);
  // The verdict survives: "I approved it and it shipped" is the line worth having.
  assert.equal(decorated.myLatestVerdict, 'CHANGES_REQUESTED');
});

test('reviewing: a changes-requested with no inline comment still awaits a fix', () => {
  const pr = node({
    reviews: { nodes: [{ author: user(ME), state: 'CHANGES_REQUESTED', submittedAt: ago(4), url: 'u' }] },
  });
  const decorated = decorateReview(baseShape(pr, ME), ME, false);

  assert.equal(decorated.myLatestVerdict, 'CHANGES_REQUESTED');
  assert.equal(decorated.awaitingFix, true);
  assert.equal(decorated.bucket, 'waiting');
});

test('my PR: an unanswered remark is mine to address, my own reply is not', () => {
  const withRemark = node({ reviewThreads: { nodes: [thread({ comments: [['reviewer', ago(2)]] })] } });
  const answered = node({
    reviewThreads: { nodes: [thread({ comments: [['reviewer', ago(2)], [ME, ago(1)]] })] },
  });

  const a = decorateMine(baseShape(withRemark, ME));
  assert.equal(a.toFix.length, 1);
  assert.equal(a.bucket, 'action');

  const b = decorateMine(baseShape(answered, ME));
  assert.equal(b.toFix.length, 0);
  assert.equal(b.waitingOnThem.length, 1);
  assert.equal(b.bucket, 'waiting');
});

test('my PR: a resolved thread asks nothing', () => {
  const pr = node({
    reviewThreads: { nodes: [thread({ comments: [['reviewer', ago(2)]], isResolved: true })] },
  });
  const decorated = decorateMine(baseShape(pr, ME));

  assert.equal(decorated.toFix.length, 0);
  assert.equal(decorated.needsAction, false);
  // Not settled either: with no approval, the PR is still blocked on a review.
  assert.equal(decorated.bucket, 'waiting');
});

test('my PR: failing CI and conflicts are actionable on their own', () => {
  const ci = decorateMine(baseShape(node({
    head: { nodes: [{ commit: { committedDate: ago(1), author: { user: user(ME) }, statusCheckRollup: { state: 'FAILURE' } } }] },
  }), ME));
  assert.ok(ci.reasons.some(r => r.kind === 'ci'));

  const conflicting = decorateMine(baseShape(node({ mergeable: 'CONFLICTING' }), ME));
  assert.ok(conflicting.reasons.some(r => r.kind === 'conflict'));

  // UNKNOWN means "GitHub has not finished computing", not "no conflict".
  const unknown = decorateMine(baseShape(node({ mergeable: 'UNKNOWN' }), ME));
  assert.equal(unknown.reasons.some(r => r.kind === 'conflict'), false);
});

test('my PR: changes requested carries who asked', () => {
  const pr = node({
    reviews: { nodes: [{ author: user('reviewer'), state: 'CHANGES_REQUESTED', submittedAt: ago(2), url: 'u' }] },
  });
  const reason = decorateMine(baseShape(pr, ME)).reasons.find(r => r.kind === 'changes-requested');

  assert.deepEqual(reason.authors, ['reviewer']);
});

test('a dismissed or superseded review does not count as the latest verdict', () => {
  const pr = node({
    reviews: {
      nodes: [
        { author: user('reviewer'), state: 'CHANGES_REQUESTED', submittedAt: ago(5), url: 'u' },
        { author: user('reviewer'), state: 'APPROVED', submittedAt: ago(1), url: 'u' },
      ],
    },
  });
  const decorated = decorateMine(baseShape(pr, ME));

  assert.equal(decorated.reasons.some(r => r.kind === 'changes-requested'), false);
});

test('contributors list the author first, then commit authors in order', () => {
  const pr = node({
    author: user('author'),
    recent: {
      nodes: [
        { commit: { author: { user: user('author') } } },
        { commit: { author: { user: user(ME) } } },
        { commit: { author: { user: user(ME) } } },
      ],
    },
  });

  assert.deepEqual(contributorsOf(pr).map(p => p.login), ['author', ME]);
});

test('an unlinked commit author is skipped rather than shown as a hole', () => {
  const pr = node({ recent: { nodes: [{ commit: { author: { user: null } } }] } });
  assert.deepEqual(contributorsOf(pr).map(p => p.login), ['author']);
});

test('headCommitAuthor is what moves a taken-over PR to my column', () => {
  const pr = baseShape(node({
    head: { nodes: [{ commit: { committedDate: ago(1), author: { user: user(ME) }, statusCheckRollup: null } }] },
  }), ME);

  assert.equal(pr.author, 'author');
  assert.equal(pr.headCommitAuthor, ME);
});

test('bots are detected by type, not only by a login list', () => {
  assert.equal(isBot(bot('some-new-linter')), true);
  assert.equal(isBot({ __typename: 'User', login: 'dependabot' }), true);
  assert.equal(isBot({ __typename: 'User', login: 'someone[bot]' }), true);
  assert.equal(isBot(user('a-human')), false);
});

test('excerpts drop the HTML and escaped markdown that bots post', () => {
  const raw = 'Function with many parameters \\(count = 4\\)<i>[qlty]</i><a href="http://x">doc</a>';
  const { text: clean } = cleanExcerpt(raw);

  assert.equal(clean.includes('<'), false);
  assert.equal(clean.includes('\\('), false);
  assert.ok(clean.includes('(count = 4)'));
});

// The bug: a reply was compared against my last comment *in that thread* only, so an
// approval — a reviewer's terminal act — could not close anything out.
test('reviewing: approving settles the replies that came before it', () => {
  const pr = node({
    comments: { nodes: [issueComment([ME, ago(3)]), issueComment(['author', ago(2)])] },
    reviews: { nodes: [{ author: user(ME), state: 'APPROVED', submittedAt: ago(1), url: 'u' }] },
  });
  const decorated = decorateReview(baseShape(pr, ME), ME, false);

  assert.equal(decorated.answeredToMe.length, 0, 'the reply predates my approval');
  assert.equal(decorated.needsAction, false);
  assert.equal(decorated.bucket, 'idle');
});

test('reviewing: a reply after my approval calls me back', () => {
  const pr = node({
    comments: { nodes: [issueComment([ME, ago(3)]), issueComment(['author', ago(1)])] },
    reviews: { nodes: [{ author: user(ME), state: 'APPROVED', submittedAt: ago(2), url: 'u' }] },
  });
  const decorated = decorateReview(baseShape(pr, ME), ME, false);

  assert.equal(decorated.answeredToMe.length, 1);
  assert.equal(decorated.bucket, 'action');
});

test('my PR: a freshly opened one is waiting on the reviewers, not settled', () => {
  const pr = node({ author: user(ME), reviewDecision: 'REVIEW_REQUIRED' });
  const decorated = decorateMine(baseShape(pr, ME));

  assert.equal(decorated.needsAction, false, 'it asks nothing of me');
  assert.equal(decorated.awaitingReview, true);
  assert.equal(decorated.bucket, 'waiting');
});

test('my PR: a draft waits on no one, and an approved one is done', () => {
  const draft = decorateMine(baseShape(node({ isDraft: true, reviewDecision: 'REVIEW_REQUIRED' }), ME));
  assert.equal(draft.awaitingReview, false);
  assert.equal(draft.bucket, 'idle');

  const approved = decorateMine(baseShape(node({ reviewDecision: 'APPROVED' }), ME));
  assert.equal(approved.awaitingReview, false);
  assert.equal(approved.bucket, 'idle');
});

test('my PR: a repo with no review policy still counts as awaiting review', () => {
  const decorated = decorateMine(baseShape(node({ reviewDecision: null }), ME));
  assert.equal(decorated.bucket, 'waiting');
});

// Same principle as the reply case, on the other side of the thread: approving after
// asking a question means I decided it was fine.
test('reviewing: approving settles my own open question', () => {
  const pr = node({
    comments: { nodes: [issueComment([ME, ago(3)])] },
    reviews: { nodes: [{ author: user(ME), state: 'APPROVED', submittedAt: ago(1), url: 'u' }] },
  });
  const decorated = decorateReview(baseShape(pr, ME), ME, false);

  assert.equal(decorated.awaitingAuthor.length, 0, 'my question predates my approval');
  assert.equal(decorated.awaitingFix, false);
  // The green class is applied in the browser from exactly this pair, because the
  // "hide bots" filter can shift the bucket there.
  assert.equal(decorated.bucket, 'idle');
  assert.equal(decorated.myLatestVerdict, 'APPROVED');
});

test('reviewing: a question asked after approving still awaits an answer', () => {
  const pr = node({
    comments: { nodes: [issueComment([ME, ago(1)])] },
    reviews: { nodes: [{ author: user(ME), state: 'APPROVED', submittedAt: ago(3), url: 'u' }] },
  });
  const decorated = decorateReview(baseShape(pr, ME), ME, false);

  assert.equal(decorated.awaitingAuthor.length, 1);
  assert.equal(decorated.bucket, 'waiting');
});

test('reviewing: a changes-requested still awaits a fix, approval or not', () => {
  const pr = node({
    comments: { nodes: [issueComment([ME, ago(3)])] },
    reviews: {
      nodes: [
        { author: user(ME), state: 'APPROVED', submittedAt: ago(2), url: 'u' },
        { author: user(ME), state: 'CHANGES_REQUESTED', submittedAt: ago(1), url: 'u' },
      ],
    },
  });
  const decorated = decorateReview(baseShape(pr, ME), ME, false);

  assert.equal(decorated.myLatestVerdict, 'CHANGES_REQUESTED');
  assert.equal(decorated.awaitingFix, true);
  assert.equal(decorated.bucket, 'waiting');
});

test('my PR: once merged, only the release pipeline can still ask anything', () => {
  // Head CI, conflicts and open threads are all about getting it merged.
  const base = {
    merged: true,
    mergedAt: ago(0.1),
    mergeable: 'CONFLICTING',
    reviewThreads: { nodes: [thread({ comments: [['reviewer', ago(2)]] })] },
    head: { nodes: [{ commit: { committedDate: ago(1), author: { user: user(ME) }, statusCheckRollup: { state: 'FAILURE' } } }] },
  };

  const green = decorateMine(baseShape(node({ ...base, mergeCommit: { oid: 'x', statusCheckRollup: { state: 'SUCCESS' } } }), ME));
  assert.equal(green.needsAction, false, 'a published release asks nothing');
  assert.equal(green.bucket, 'merged');
  assert.equal(green.awaitingReview, false, 'a merged PR waits on no reviewer');

  const red = decorateMine(baseShape(node({ ...base, mergeCommit: { oid: 'x', statusCheckRollup: { state: 'FAILURE' } } }), ME));
  assert.equal(red.needsAction, true);
  assert.equal(red.bucket, 'action');
  assert.deepEqual(red.reasons.map(r => r.kind), ['merge-pipeline']);
});

test('my PR: a running release keeps it watched without demanding anything', () => {
  const pr = node({ merged: true, mergedAt: ago(0.1), mergeCommit: { oid: 'x', statusCheckRollup: { state: 'PENDING' } } });
  const decorated = decorateMine(baseShape(pr, ME));

  assert.equal(decorated.mergePipeline, 'PENDING');
  assert.equal(decorated.needsAction, false);
  assert.equal(decorated.bucket, 'merged');
});

test('a merge I took over is mine to watch, by the board\'s own notion of ownership', () => {
  const takenOver = baseShape(node({
    author: user('someone'),
    merged: true,
    mergedAt: ago(0.1),
    head: { nodes: [{ commit: { committedDate: ago(0.2), author: { user: user(ME) }, statusCheckRollup: null } }] },
    mergeCommit: { oid: 'x', statusCheckRollup: { state: 'SUCCESS' } },
  }), ME);

  assert.notEqual(takenOver.author, ME);
  assert.equal(takenOver.headCommitAuthor, ME, 'the head commit is what makes it mine');
});

// This once asserted the opposite: that decorateReview would claim a reply was waiting on
// a closed PR, which is why other people's merges were kept off the board entirely. The
// review side understands a merge now, so they can be shown — and a PR I reviewed is what
// I talk about at the next standup.
test('a merge by someone else is settled, not a reply waiting for me', () => {
  const theirs = baseShape(node({
    author: user('someone'),
    merged: true,
    mergedAt: ago(0.1),
    mergeCommit: { oid: 'x', statusCheckRollup: { state: 'FAILURE' } },
    comments: { nodes: [issueComment([ME, ago(3)]), issueComment(['someone', ago(1)])] },
  }), ME);

  assert.equal(theirs.merged, true);
  assert.notEqual(theirs.author, ME, 'the fixture is authored by someone else');

  const decorated = decorateReview(theirs, ME, false);
  assert.equal(decorated.answeredToMe.length, 0, 'the merge settled it');
  assert.equal(decorated.needsAction, false);
  assert.equal(decorated.bucket, 'merged');
});

test('within the merged group, a running release outranks a landed one', () => {
  // Freshness alone would not guarantee it: a pipeline that finished fast can be more
  // recent than one still in flight.
  const running = decorateMine(baseShape(node({
    merged: true, mergedAt: ago(2), lastActivityAt: ago(2),
    mergeCommit: { oid: 'a', statusCheckRollup: { state: 'PENDING' } },
    head: { nodes: [{ commit: { committedDate: ago(2), author: { user: user(ME) }, statusCheckRollup: null } }] },
  }), ME));

  const landed = decorateMine(baseShape(node({
    merged: true, mergedAt: ago(0.1),
    mergeCommit: { oid: 'b', statusCheckRollup: { state: 'SUCCESS' } },
    head: { nodes: [{ commit: { committedDate: ago(0.1), author: { user: user(ME) }, statusCheckRollup: null } }] },
  }), ME));

  const sorted = [landed, running].sort(byActionThenFreshness);
  assert.equal(sorted[0].mergePipeline, 'PENDING', 'the running one comes first');
});

test('a truncated excerpt says so, and does not cut mid-word', () => {
  const { text, truncated } = cleanExcerpt(`${'word '.repeat(200)}end`);

  assert.equal(truncated, true);
  assert.ok(text.endsWith('…'), 'the ellipsis is what tells a summary from a bug');
  assert.ok(text.length <= 321, `expected at most 321 chars, got ${text.length}`);
  assert.equal(/\s…$/.test(text), false, 'no dangling space before the ellipsis');
  assert.equal(text.replace('…', '').endsWith('word'), true, 'cut on a word boundary');
});

test('an excerpt that fits is left exactly as it is', () => {
  const short = 'A short remark about a field.';
  assert.deepEqual(cleanExcerpt(short), { text: short, truncated: false });
});
