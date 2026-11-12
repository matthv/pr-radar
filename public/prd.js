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

  return { group, sortPrds, withMain, GROUPS, ORDERS };
});
