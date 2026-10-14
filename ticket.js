'use strict';

// Its own module: the board (github.js) and the standup notes (digest.js) both read it, and
// digest.js already requires github.js.
const TICKET_RE = /\b([A-Z]{2,}-\d{2,})\b/;
const BRANCH_TICKET_RE = /(?:^|\/)([a-z]{2,}-\d{2,})(?=[-_/]|$)/i;

function ticketKey(pr) {
  return pr.title?.match(TICKET_RE)?.[1]
    ?? pr.headRefName?.match(BRANCH_TICKET_RE)?.[1]?.toUpperCase()
    ?? pr.body?.match(TICKET_RE)?.[1]
    ?? null;
}

// A standup is told by piece of work, not by pull request: the back and the front of one
// change are one thing to say (Alban's feedback, forestadmin#9977 + forestadmin-server#8522).
// The same ticket, or the very same title once its conventional prefix is gone: the two
// halves of one change are opened with one title, and not always with the ticket in it.
// A board card carries its ticket already, read from a branch the card no longer has.
function workKey(pr) {
  const ticket = 'ticket' in pr ? pr.ticket : ticketKey(pr);
  if (ticket) return `ticket:${ticket}`;
  return `title:${String(pr.title ?? '').replace(/^\w+(\([^)]*\))?!?:\s*/, '').trim().toLowerCase()}`;
}

// The board's own reading of "same piece of work": the notes' key, plus one Slack
// announcement naming several PRs, the way "Server / front" pairs are posted with two
// unrelated titles and no ticket. Groups sharing a card are one group.
function withTwins(cards) {
  const parent = cards.map((_, index) => index);
  const root = index => (parent[index] === index ? index : (parent[index] = root(parent[index])));
  const firstWith = new Map();
  cards.forEach((card, index) => {
    const keys = [workKey(card), card.slackUrl ? `slack:${card.slackUrl}` : null];
    for (const key of keys) {
      if (!key || key === 'title:') continue;
      if (firstWith.has(key)) parent[root(index)] = root(firstWith.get(key));
      else firstWith.set(key, index);
    }
  });
  return cards.map((card, index) => ({
    ...card,
    twins: cards
      .filter((other, otherIndex) => otherIndex !== index && root(otherIndex) === root(index))
      .map(({ id, repo, number, title, side, url }) => ({ id, repo, number, title, side, url })),
  }));
}

module.exports = { ticketKey, workKey, withTwins };
