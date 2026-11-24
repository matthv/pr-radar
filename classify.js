'use strict';

// What each PR asks of me: the reasons it needs action, the group it sits in and the board's
// order, from the shape github.js gives it. No network here: github.js fetches and shapes.

const LINT_BOTS = new Set(['qltysh', 'qlty-cloud-legacy']);

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
  const lintOnly = t => t.fromBot && LINT_BOTS.has(t.author) && (t.lastAuthor === t.author || t.lastByMe);
  const unresolved = pr.threads.filter(t => !t.isResolved && !lintOnly(t));
  const toFix = unresolved.filter(t => !t.lastByMe);
  const waitingOnThem = unresolved.filter(t => t.lastByMe);
  // Asking the reviewer again hands them the PR back. GitHub drops a request once its
  // reviewer submits a review, so one still pending is newer than their changes-requested.
  const changesRequested = latestReviewPerAuthor(pr.reviews)
    .filter(r => r.state === 'CHANGES_REQUESTED' && !pr.requestedReviewers.includes(r.author));

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
      : readyToMerge
        ? 'ready'
        : waitingOnThem.length || awaitingReview
          ? 'waiting'
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
  // Asked again after I reviewed: GitHub drops a request once its reviewer submits, so one
  // still pending is newer than my review — the author handing the PR back on purpose.
  const reRequested = myReviews.length > 0 && pr.requestedReviewers.includes(me);
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
  if (reRequested) reasons.push({ kind: 're-requested' });
  // A reply hands the PR back only once none of my threads still waits on the author: one
  // answered out of several means they are working through them, not that they are done.
  if (answeredToMe.length && !awaitingAuthor.length) reasons.push({ kind: 'answers', count: answeredToMe.length });
  // Remarks I raised, answered and resolved, then new commits: the PR waits on my second look
  // and my verdict, though nothing is left open — forestadmin-server#8561 sat in "nothing to
  // report" for its only reviewer. Raising the remark, not just commenting, is what counts:
  // a passing comment should not ring on every push. A push with a remark of mine still
  // unanswered is the same as a partial reply: the author is mid-way, not done.
  const raisedRemarks = myThreads.some(thread => thread.startedByMe);
  if (
    pushedSinceMyFeedback &&
    !awaitingAuthor.length &&
    (myLatestVerdict === 'CHANGES_REQUESTED' || (raisedRemarks && myLatestVerdict !== 'APPROVED'))
  ) {
    reasons.push({ kind: 'recheck' });
  }

  const awaitingFix = awaitingAuthor.length > 0 || myLatestVerdict === 'CHANGES_REQUESTED';

  // A review I claimed through a plugin (the validator's label, say) is held by whoever the plugin says
  // has the turn, until my first review or remark after the claim; then the rules above take over.
  // A bot's turn is a group of its own: "waiting on the author" would name the wrong party.
  const claim = pr.plugins?.review;
  // Logins compare whatever their case, as GitHub's do.
  const since = claim?.claimedBy.toLowerCase() === me.toLowerCase() ? Date.parse(claim.since) : NaN;
  const reviewedSince = [...myReviews.map(r => r.submittedAt), ...myThreads.map(t => t.myLastAt)]
    .some(at => at && Date.parse(at) >= since);
  if (!pr.merged && !Number.isNaN(since) && !reviewedSince) {
    const mine = claim.turn === 'me';
    return {
      ...pr,
      side: 'review',
      // The claim's own reason says it, "to review" included: this one would add a second pill.
      reviewOwedByMe: false,
      iHaveReviewed,
      myLatestVerdict,
      myLastActivity: myLastActivity ?? null,
      awaitingAuthor,
      answeredToMe,
      pushedSinceMyFeedback,
      reasons: mine ? [{ kind: 'claim', text: claim.why }] : [],
      needsAction: mine,
      awaitingFix: claim.turn === 'author',
      bucket: mine ? 'action' : claim.turn === 'author' ? 'waiting' : 'bot',
    };
  }

  // Once merged, every pending state is history — the same rule my own PRs follow. Left
  // in, a merged PR would keep claiming a reply was waiting for me on something closed,
  // which is exactly what kept other people's merges off the board in the first place.
  return {
    ...pr,
    side: 'review',
    reviewOwedByMe,
    reRequested: pr.merged ? false : reRequested,
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

module.exports = { latestReviewPerAuthor, decorateMine, decorateReview, byActionThenFreshness };
