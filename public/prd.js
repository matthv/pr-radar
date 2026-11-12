(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PRRadarPrd = api;
})(this, () => {
  const GROUPS = ['status', 'project', 'label', 'none'];
  const ORDERS = ['updated', 'opened', 'title'];

  // The groups a PRD sits in. Several labels put it in each of theirs; none puts it in the
  // group with no key, shown last.
  function keysOf(prd, by) {
    if (by === 'status') return prd.status ? [{ key: prd.status.name, label: prd.status.name, rank: prd.status.position ?? 0, color: prd.status.color }] : [];
    if (by === 'project') return prd.project ? [{ key: prd.project, label: prd.project }] : [];
    if (by === 'label') return prd.labels.map(label => ({ key: label.name, label: label.name, color: label.color }));
    return [{ key: '', label: '' }];
  }

  const time = iso => Date.parse(iso) || 0;
  const COMPARE = {
    updated: (a, b) => time(b.updatedAt) - time(a.updatedAt),
    opened: (a, b) => time(b.createdAt) - time(a.createdAt),
    title: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
  };

  // Newest first for both dates, A to Z for titles; the ticket breaks a tie so the order holds
  // from one refresh to the next.
  const sortPrds = (prds, order) => [...prds].sort((a, b) => (COMPARE[order] ?? COMPARE.updated)(a, b) || a.ticket.localeCompare(b.ticket));

  function group(prds, { by = 'status', order = 'updated' } = {}) {
    const groups = new Map();
    for (const prd of prds) {
      const keys = keysOf(prd, by);
      for (const { key, ...rest } of keys.length ? keys : [{ key: null, label: null }]) {
        if (!groups.has(key)) groups.set(key, { key, ...rest, prds: [] });
        groups.get(key).prds.push(prd);
      }
    }
    return [...groups.values()]
      .sort((a, b) => (a.key === null) - (b.key === null) || (a.rank ?? 0) - (b.rank ?? 0) || String(a.label).localeCompare(String(b.label)))
      .map(entry => ({ ...entry, prds: sortPrds(entry.prds, order) }));
  }

  // The session you starred as a ticket's main one, while it is still among its sessions, alone
  // is main; otherwise the weighed guess stands. `first` is the one put first, the others keeping
  // their order.
  function withMain(sessions, chosen, first) {
    const has = id => Boolean(id) && sessions.some(session => session.sessionId === id);
    const marked = has(chosen) ? sessions.map(session => ({ ...session, main: session.sessionId === chosen })) : sessions;
    if (!has(first)) return marked;
    return [...marked].sort((a, b) => (b.sessionId === first) - (a.sessionId === first));
  }

  // A session as the Sessions view reads it: closed once its process is gone; waiting on you on a
  // skill's question or a prompt Claude Code blocks on (a permission), or idle for less than YOUR_TURN_MS (it finished its turn, or was started and
  // given nothing yet); working while busy; merely open once idle longer. Running with no status in its
  // file, which Claude Code does not document, it is unknown rather than guessed open.
  const YOUR_TURN_MS = 30 * 60_000;
  function sessionStatus(session, now = Date.now()) {
    if (!session.running) return 'closed';
    if (session.state === 'waiting' || session.status === 'waiting') return 'waiting';
    if (session.status === 'busy') return 'busy';
    if (!session.status) return 'unknown';
    return session.since && now - time(session.since) < YOUR_TURN_MS ? 'waiting' : 'open';
  }

  // Inside each of the Sessions view's groups: the latest to change state first (the one that just
  // finished leads), the longest in its state first, or by title, folder, PRD or skill, those
  // without one last and the title breaking ties.
  const SESSION_ORDERS = ['changed', 'longest', 'title', 'folder', 'prd', 'skill'];
  const LAST = '\uffff';
  function sortSessions(sessions, order) {
    const when = session => String(session.since ?? session.at ?? '');
    const title = session => String(session.title ?? session.name ?? session.sessionId).toLowerCase();
    const folder = session => {
      const path = session.folder ?? session.cwd;
      return path ? path.slice(path.lastIndexOf('/') + 1).toLowerCase() : LAST;
    };
    const prd = session => session.tickets?.find(link => link.primary)?.ticket ?? LAST;
    const skill = session => session.skill ?? LAST;
    const byTitle = (a, b) => title(a).localeCompare(title(b));
    const by = {
      changed: (a, b) => when(b).localeCompare(when(a)),
      longest: (a, b) => when(a).localeCompare(when(b)),
      title: byTitle,
      folder: (a, b) => folder(a).localeCompare(folder(b)) || byTitle(a, b),
      prd: (a, b) => prd(a).localeCompare(prd(b), undefined, { numeric: true }) || byTitle(a, b),
      skill: (a, b) => skill(a).localeCompare(skill(b)) || byTitle(a, b),
    };
    return [...sessions].sort(by[order] ?? by.changed);
  }

  // Each state's badge colour and label key, both views. Waiting on you splits by why: a skill's
  // question amber, a prompt Claude Code blocks on amber under its own name ("permission prompt"),
  // your turn cyan.
  const SESSION_STATES = {
    waiting: ['pending', 'prdWaiting'],
    busy: ['todo running', 'prdSessionBusy'],
    open: ['good', 'prdSessionOpen'],
    closed: ['', 'prdSessionClosed'],
    unknown: ['', 'sessNoStatus'],
  };
  function stateBadge(session, status) {
    if (status !== 'waiting') return { kind: SESSION_STATES[status][0], key: SESSION_STATES[status][1] };
    if (session.state === 'waiting') return { kind: 'pending', key: 'sessQuestion' };
    if (session.status === 'waiting') return { kind: 'pending', key: 'sessQuestion', text: session.waitingFor ?? null };
    return { kind: 'turn', key: 'sessYourTurn' };
  }

  // A status poll merged into the sessions the last full read drew. One it no longer lists has
  // closed; `unseen` is a running one that read never drew, which needs a full read for its links.
  const SESSION_FIELDS = ['running', 'status', 'waitingFor', 'name', 'skill', 'stage', 'state', 'question', 'outcome', 'at', 'since'];
  function mergeStatuses(sessions, statuses) {
    const fresh = new Map(statuses.map(session => [session.sessionId, session]));
    const known = new Set(sessions.map(session => session.sessionId));
    const unseen = statuses.some(session => session.running && !known.has(session.sessionId));
    const merged = sessions.map(session => {
      const next = fresh.get(session.sessionId);
      if (!next) return session.running ? { ...session, running: false, status: null } : session;
      const copy = { ...session };
      for (const field of SESSION_FIELDS) if (field !== 'at' || next.at) copy[field] = next[field];
      return copy;
    });
    return { sessions: merged, unseen };
  }

  // Whether any session started waiting on you since the last call, which chimes. `last` keeps each
  // session's previous status between calls; a session seen for the first time never chimes.
  function startedWaiting(last, sessions, now = Date.now()) {
    let started = false;
    for (const session of sessions) {
      const status = sessionStatus(session, now);
      const before = last.get(session.sessionId);
      if (before && before !== 'waiting' && status === 'waiting') started = true;
      last.set(session.sessionId, status);
    }
    return started;
  }

  // What the view drew, by status: it changes when the clock alone moves a session, idle past
  // YOUR_TURN_MS, so the view redraws though no data changed.
  const sessionSignature = (sessions, now = Date.now()) => sessions.map(session => `${session.sessionId}:${sessionStatus(session, now)}`).join();

  return {
    group, sortPrds, withMain, sessionStatus, sortSessions, stateBadge, mergeStatuses, startedWaiting, sessionSignature,
    GROUPS, ORDERS, SESSION_ORDERS, SESSION_STATES, YOUR_TURN_MS,
  };
});
