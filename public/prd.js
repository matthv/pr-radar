(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PRRadarPrd = api;
})(this, () => {
  const GROUPS = ['skill', 'status', 'project', 'label', 'none'];
  const ORDERS = ['updated', 'opened', 'title'];
  const ACTIVE = new Set(['running', 'waiting']);

  // The skills a PRD's sessions are running now: one that ended has nothing left to show.
  const runningSkills = prd => [...new Set(prd.sessions.filter(session => ACTIVE.has(session.state) && session.skill).map(session => session.skill))];

  // The groups a PRD sits in. Several skills or several labels put it in each of theirs; none
  // puts it in the group with no key, shown last.
  function keysOf(prd, by) {
    if (by === 'skill') return runningSkills(prd).map(skill => ({ key: skill, label: skill }));
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

  function group(prds, { by = 'skill', order = 'updated' } = {}) {
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

  return { group, sortPrds, runningSkills, GROUPS, ORDERS };
});
