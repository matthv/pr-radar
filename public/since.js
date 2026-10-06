// What changed on a card since you last looked at it, from the board's own data: no call of
// its own. Loaded by the page as a global, and by the tests as a module.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PRRadarSince = api;
})(this, () => {
  // The page has no bot flag on reviews, only on threads: a login is what it can test.
  const isBotLogin = login => !login || /\[bot\]$/.test(login);

  const CI = { SUCCESS: 'ok', FAILURE: 'ko', ERROR: 'ko', PENDING: 'running', EXPECTED: 'running' };

  function snapshotOf(pr) {
    return {
      threads: Object.fromEntries(
        pr.threads.filter(thread => !thread.fromBot).map(thread => [thread.id, { lastAt: thread.lastAt, n: thread.commentCount }]),
      ),
      reviews: pr.reviews.map(review => `${review.author}|${review.state}|${review.submittedAt}`),
      commitAt: pr.lastCommitAt ?? null,
      ci: pr.ciState ?? null,
      mergeable: pr.mergeable ?? null,
      merged: Boolean(pr.merged),
      pipeline: pr.pipelineOutcome ?? null,
      release: pr.release?.tag ?? null,
    };
  }

  // Most pressing first: what asks for something, then what only informs.
  const ORDER = ['ciFailed', 'conflict', 'changesRequested', 'releaseFailed', 'commented', 'approved', 'pushed', 'ciPassed', 'merged', 'released'];

  function changesSince(photo, pr, me) {
    if (!photo) return [];
    const changes = [];
    const seenReviews = new Set(photo.reviews);
    const reviewers = { APPROVED: new Set(), CHANGES_REQUESTED: new Set() };
    const commenters = new Set();
    // The latest moment of each kind, so the list can say when; a CI or a conflict carries none.
    const latest = {};
    const at = (kind, when) => {
      if (when && (!latest[kind] || when > latest[kind])) latest[kind] = when;
    };

    for (const review of pr.reviews) {
      if (review.author === me || isBotLogin(review.author)) continue;
      if (seenReviews.has(`${review.author}|${review.state}|${review.submittedAt}`)) continue;
      if (reviewers[review.state]) {
        reviewers[review.state].add(review.author);
        at(review.state, review.submittedAt);
      } else if (review.state === 'COMMENTED') {
        commenters.add(review.author);
        at('commented', review.submittedAt);
      }
    }

    for (const thread of pr.threads) {
      if (thread.fromBot || thread.lastByMe || isBotLogin(thread.lastAuthor)) continue;
      const before = photo.threads[thread.id];
      const moved = !before || thread.lastAt > before.lastAt || thread.commentCount > before.n;
      if (!moved) continue;
      commenters.add(thread.lastAuthor);
      at('commented', thread.lastAt);
    }
    // A review's body also feeds the conversation thread: one move, said once.
    for (const set of Object.values(reviewers)) for (const who of set) commenters.delete(who);

    if (commenters.size) changes.push({ kind: 'commented', who: [...commenters], at: latest.commented ?? null });
    if (reviewers.APPROVED.size) changes.push({ kind: 'approved', who: [...reviewers.APPROVED], at: latest.APPROVED });
    if (reviewers.CHANGES_REQUESTED.size) changes.push({ kind: 'changesRequested', who: [...reviewers.CHANGES_REQUESTED], at: latest.CHANGES_REQUESTED });

    if (pr.lastCommitAt && pr.lastCommitAt !== photo.commitAt && pr.headCommitAuthor !== me) {
      changes.push({ kind: 'pushed', who: [pr.headCommitAuthor ?? '?'], at: pr.lastCommitAt });
    }

    if (!pr.merged) {
      const from = CI[photo.ci];
      const to = CI[pr.ciState];
      // Going back to "running" comes with a push, already said; only an outcome is news.
      if (from && to && from !== to && to !== 'running') changes.push({ kind: to === 'ok' ? 'ciPassed' : 'ciFailed', at: null });
      if (pr.mergeable === 'CONFLICTING' && photo.mergeable !== 'CONFLICTING') changes.push({ kind: 'conflict', at: null });
    }

    if (pr.merged && !photo.merged) changes.push({ kind: 'merged', at: pr.mergedAt ?? null });
    if (pr.release?.tag && pr.release.tag !== photo.release) changes.push({ kind: 'released', tag: pr.release.tag, at: pr.release.publishedAt ?? null });
    if (pr.pipelineOutcome === 'failed' && photo.pipeline !== 'failed') changes.push({ kind: 'releaseFailed', at: null });

    return changes.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  }

  return { snapshotOf, changesSince };
});
