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

module.exports = { ticketKey };
