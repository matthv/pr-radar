'use strict';

// Its own module: the board (github.js) and the standup notes (digest.js) both read it, and
// digest.js already requires github.js.
// Not the tail of a longer id: SNYK-JS-LODASH-1040724 holds no LODASH-1040724 ticket.
const TICKET_RE = /(?<![\w-])([A-Z]{2,}-\d{2,})\b/g;
const BRANCH_TICKET_RE = /(?:^|\/)([a-z]{2,}-\d{2,})(?=[-_/]|$)/gi;
// Shaped like a ticket, never one: an advisory, a hash, a cipher, an encoding, a standard or
// a runtime (CVE-2024-1111, CWE-79, SHA-256, AES-256, UTF-16, ISO-8601, node-20).
const NOT_TICKETS = new Set([
  'CVE', 'CWE', 'GO', 'PYSEC', 'RUSTSEC', 'SHA', 'AES', 'RSA', 'UTF', 'ISO', 'RFC', 'ES', 'NODE',
]);
// A bot's branch names a dependency and its version (renovate/react-18), not a ticket.
const BOT_BRANCH_RE = /^(dependabot|renovate)\//i;

const isTicket = key => !NOT_TICKETS.has(key.split('-')[0].toUpperCase());

function firstTicket(text) {
  for (const [, key] of String(text ?? '').matchAll(TICKET_RE)) if (isTicket(key)) return key;
  return null;
}

function branchTicket(branch) {
  if (!branch || BOT_BRANCH_RE.test(branch)) return null;
  for (const [, key] of branch.matchAll(BRANCH_TICKET_RE)) if (isTicket(key)) return key.toUpperCase();
  return null;
}

// A bot's description quotes the release notes of what it bumps, other projects' tickets.
function ticketKey(pr) {
  return firstTicket(pr.title) ?? branchTicket(pr.headRefName) ?? (pr.authorIsBot ? null : firstTicket(pr.body));
}

const titleKey = pr => String(pr.title ?? '').replace(/^\w+(\([^)]*\))?!?:\s*/, '').trim().toLowerCase();

// A live board card carries its ticket already, read from its branch too: the card has no
// branch left, so ticketKey on it would miss one.
const ticketOf = pr => ('ticket' in pr ? pr.ticket : ticketKey(pr));

// The same ticket, or the very same title once its conventional prefix is gone: the two
// halves of one change are opened with one title, and not always with the ticket in it.
function workKey(pr) {
  const ticket = ticketOf(pr);
  return ticket ? `ticket:${ticket}` : `title:${titleKey(pr)}`;
}

// The notes merge two lines on a short title at no cost; on the board it would pin a pill on
// "fix: typo" in two repos.
const TITLE_MIN_WORDS = 3;
// "Please review A, B, C, D" is a list, not one change in a few repos.
const ANNOUNCEMENT_MAX_PRS = 3;

// The board's own reading of "same piece of work": the same ticket; the same title, unless
// the two name different tickets; one Slack announcement for both, the way "Server / front"
// pairs are posted with unrelated titles and no ticket. Groups sharing a card are one group.
function withTwins(cards) {
  const parent = cards.map((_, index) => index);
  const root = index => (parent[index] === index ? index : (parent[index] = root(parent[index])));
  // The ticket a group already holds: a ticketless card sharing a title with two tickets
  // must not bridge them.
  const groupTicket = cards.map(ticketOf);
  const join = (a, b, byTitle) => {
    const [ra, rb] = [root(a), root(b)];
    if (ra === rb) return;
    if (byTitle && groupTicket[ra] && groupTicket[rb] && groupTicket[ra] !== groupTicket[rb]) return;
    parent[ra] = rb;
    groupTicket[rb] ??= groupTicket[ra];
  };
  const byKey = new Map();
  const add = (key, index) => byKey.set(key, [...(byKey.get(key) ?? []), index]);
  cards.forEach((card, index) => {
    const ticket = ticketOf(card);
    if (ticket) add(`ticket:${ticket}`, index);
    const title = titleKey(card);
    // A bot's PRs are bumps and releases, named alike in every repo.
    if (!card.authorIsBot && title.split(/\s+/).length >= TITLE_MIN_WORDS) add(`title:${title}`, index);
    if (card.slackUrl) add(`slack:${card.slackUrl}`, index);
  });
  // Titles last: by then each group holds the ticket its ticket and Slack links gave it.
  const order = key => (key.startsWith('title:') ? 1 : 0);
  for (const [key, members] of [...byKey].sort(([a], [b]) => order(a) - order(b))) {
    if (key.startsWith('slack:') && members.length > ANNOUNCEMENT_MAX_PRS) continue;
    for (const [i, a] of members.entries()) {
      for (const b of members.slice(i + 1)) join(a, b, key.startsWith('title:'));
    }
  }
  return cards.map((card, index) => ({
    ...card,
    twins: cards
      .filter((other, otherIndex) => otherIndex !== index && root(otherIndex) === root(index))
      .map(({ id, repo, number, title, side, url }) => ({ id, repo, number, title, side, url })),
  }));
}

// Across both sides at once: a back of mine and the front I review are one piece of work.
// The Slack links first, when there are any: one announcement is one of the signals.
function boardTwins(payload, slackLinks = null) {
  const withSlack = pr => (slackLinks ? { ...pr, slackUrl: slackLinks.get(pr.id) ?? null } : pr);
  const cards = withTwins([...payload.mine, ...payload.reviews].map(withSlack));
  return { ...payload, mine: cards.slice(0, payload.mine.length), reviews: cards.slice(payload.mine.length) };
}

module.exports = { ticketKey, workKey, withTwins, boardTwins };
