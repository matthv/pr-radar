(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PRRadarPrd = api;
})(this, () => {
  const PREFIX = /^\w+(\([^)]*\))?!?:\s*/;

  // What the header says the ticket is about: the first PR's title without its conventional
  // prefix or the key itself, else the title Claude gave a session working on it.
  function subject({ ticket, prs, sessions }) {
    if (!ticket) return '';
    const title = prs[0]?.title;
    if (!title) return sessions.find(session => session.title)?.title ?? '';
    return title.replace(PREFIX, '').replace(new RegExp(`^\\[?${ticket}\\]?[\\s:-]*`, 'i'), '').trim();
  }

  // One group per ticket: its PRs, whichever side they sit on, and the sessions working on
  // it. The most recently active first; whatever names no ticket last, together. Only a
  // running session shows: a finished one that opened a PR is the button on that PR's card
  // already, and the rest is history.
  function group(prs, sessions) {
    const shown = sessions.filter(session => session.status != null);
    const groups = new Map();
    const of = ticket => {
      if (!groups.has(ticket)) groups.set(ticket, { ticket, prs: [], sessions: [], activeAt: 0 });
      return groups.get(ticket);
    };
    for (const pr of prs) {
      const entry = of(pr.ticket ?? null);
      entry.prs.push(pr);
      entry.activeAt = Math.max(entry.activeAt, Date.parse(pr.lastActivityAt) || 0);
    }
    for (const session of shown) {
      const entry = of(session.ticket ?? null);
      entry.sessions.push(session);
      entry.activeAt = Math.max(entry.activeAt, session.updatedAt || 0);
    }
    return [...groups.values()]
      .map(entry => ({ ...entry, subject: subject(entry) }))
      .sort((a, b) => (a.ticket === null) - (b.ticket === null) || b.activeAt - a.activeAt);
  }

  return { group, subject };
});
