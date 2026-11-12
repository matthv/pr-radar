'use strict';

const PR_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/;

// The tickets a session works on that Linear has not already given us: the ones its stage
// lines name, and those of the board PRs it reported on.
function extraTickets(stageSessions, boardPrs) {
  const ticketOfUrl = new Map(boardPrs.filter(pr => pr.ticket).map(pr => [pr.url, pr.ticket]));
  return [...new Set(stageSessions.flatMap(session => [
    ...session.tickets,
    ...[...session.prUrls].map(url => ticketOfUrl.get(url)).filter(Boolean),
  ]))];
}

function prEntry(url, title, board) {
  const card = board.get(url);
  const [, repo = null, number = null] = PR_URL.exec(url) ?? [];
  return {
    url,
    title: card?.title ?? title ?? null,
    repo: card?.repo ?? repo,
    number: card?.number ?? (number && Number(number)),
    boardId: card?.id ?? null,
    state: card ? (card.merged ? 'merged' : card.isDraft ? 'draft' : 'open') : null,
    needsAction: card?.needsAction ?? false,
    branch: card?.branch ?? null,
  };
}

// One row per session: what its skill is doing from the stage lines, whether it runs and what
// to call it from the session registry, and the folder `--resume` needs from its transcript.
function sessionEntry(sessionId, { stage, record, cwd, seen }) {
  const run = stage?.current ?? null;
  return {
    sessionId,
    name: record?.name ?? null,
    running: Boolean(record),
    status: record?.status ?? null,
    resumable: Boolean(record || cwd),
    skill: run?.skill ?? null,
    stage: run?.stage ?? null,
    state: run?.state ?? null,
    question: run?.question ?? null,
    outcome: run?.outcome ?? null,
    at: run?.at ?? (record?.updatedAt ? new Date(record.updatedAt).toISOString() : seen ?? null),
  };
}

// The closed sessions kept per ticket, its heaviest: older work is history.
const ENDED_MENTIONS = 2;
// A skill reporting its stages on the ticket is the surest sign of the session doing its work;
// a PR of the ticket opened in it, or named by its stages, counts like a commit.
const STAGE_WEIGHT = 10;
const PR_WEIGHT = 2;

// A PRD's PRs are the ones Linear has attached and the board's PRs naming its ticket. Its
// sessions are the ones whose stage lines name it or one of its PRs, a running session that
// opened one of its PRs (a finished one is already the Claude button on that PR's card), and
// those that declared work on it: every running one, the heaviest closed ones. The heaviest
// comes first, the main one when it outweighs the next, then running before closed, newest first.
function buildPrds({ prds, boardPrs = [], stageSessions = [], live = [], sessionFor = () => null, sessionsOf = () => [], cwdOf = () => null }) {
  const board = new Map(boardPrs.map(pr => [pr.url, pr]));
  const liveById = new Map(live.map(record => [record.sessionId, record]));
  const stageById = new Map(stageSessions.map(session => [session.sessionId, session]));
  return prds.map(prd => {
    const prs = new Map(prd.prs.map(pr => [pr.url, prEntry(pr.url, pr.title, board)]));
    for (const pr of boardPrs) if (pr.ticket === prd.ticket && !prs.has(pr.url)) prs.set(pr.url, prEntry(pr.url, pr.title, board));

    const weights = new Map();
    const add = (id, weight) => weights.set(id, (weights.get(id) ?? 0) + weight);
    for (const session of stageSessions) {
      if (session.tickets.has(prd.ticket)) add(session.sessionId, STAGE_WEIGHT);
      if ([...session.prUrls].some(url => prs.has(url))) add(session.sessionId, PR_WEIGHT);
    }
    for (const url of prs.keys()) {
      const opened = sessionFor(url);
      if (opened && liveById.has(opened.sessionId)) add(opened.sessionId, PR_WEIGHT);
    }
    const mentions = sessionsOf(prd.ticket);
    const seen = new Map(mentions.map(mention => [mention.sessionId, mention.at]));
    const closed = mentions.filter(mention => !liveById.has(mention.sessionId) && !weights.has(mention.sessionId))
      .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0) || String(b.at).localeCompare(String(a.at)))
      .slice(0, ENDED_MENTIONS);
    for (const mention of [...mentions.filter(mention => liveById.has(mention.sessionId) || weights.has(mention.sessionId)), ...closed]) {
      add(mention.sessionId, mention.weight ?? 1);
    }
    const sessions = [...weights]
      .map(([id, weight]) => ({ ...sessionEntry(id, { stage: stageById.get(id), record: liveById.get(id), cwd: cwdOf(id), seen: seen.get(id) }), weight }))
      .sort((a, b) => b.weight - a.weight || b.running - a.running || String(b.at).localeCompare(String(a.at)))
      .map((session, index, all) => ({ ...session, main: index === 0 && all.length > 1 && session.weight > all[1].weight }));
    return { ...prd, prs: [...prs.values()], sessions };
  });
}

// How surely a linked PRD or PR is what a session is about. A PRD: the weight the session already
// has on it, more when the session's branch names it. A PR: most when its branch is the one the
// session is on, then having been made or opened in it (the latest most), then its PRD's score.
// Primary: the PRDs at the top score, the PRs on the session's branch, or else the PRs of a
// primary PRD and the latest one it opened.
const DEFAULT_BRANCHES = new Set(['main', 'master', 'develop', 'HEAD']);
const BRANCH_TICKET = 3;
const PR_ON_BRANCH = 20;
const PR_OPENED = 4;
const PR_LATEST = 2;

function rankLinks({ branch, links, prs, opened }) {
  const ownBranch = branch && !DEFAULT_BRANCHES.has(branch) ? branch : null;
  const tickets = [...links].map(([ticket, weight]) => ({
    ticket,
    score: weight + (ownBranch && ownBranch.toUpperCase().includes(ticket) ? BRANCH_TICKET : 0),
  })).sort((a, b) => b.score - a.score || a.ticket.localeCompare(b.ticket));
  const top = tickets[0]?.score ?? 0;
  for (const entry of tickets) entry.primary = entry.score === top && top > 0;
  const scoreOf = new Map(tickets.map(entry => [entry.ticket, entry]));
  const latest = opened.at(-1);
  const ranked = [...prs.values()].map(({ tickets: owners = [], ...pr }) => {
    const prdScore = Math.max(0, ...owners.map(ticket => scoreOf.get(ticket)?.score ?? 0));
    const onBranch = Boolean(ownBranch && pr.branch === ownBranch);
    const score = (onBranch ? PR_ON_BRANCH : 0) + (opened.includes(pr.url) ? PR_OPENED : 0) + (pr.url === latest ? PR_LATEST : 0) + prdScore;
    return { ...pr, score, onBranch, owners };
  });
  const anyOnBranch = ranked.some(pr => pr.onBranch);
  return {
    tickets,
    prs: ranked.map(({ onBranch, owners, ...pr }) => ({
      ...pr,
      primary: anyOnBranch ? onBranch : pr.url === latest || owners.some(ticket => scoreOf.get(ticket)?.primary),
    })).sort((a, b) => b.primary - a.primary || b.score - a.score),
  };
}

// The Sessions view turns the PRDs inside out: a card per session, every running one and the
// closed ones a PRD keeps, with the tickets it works on, their PRs and the PRs it made or opened
// itself, and what its transcript says it is about. Running first, then the most recent.
function buildSessions({ prds, boardPrs = [], stageSessions = [], live = [], detailsOf = () => null, cwdOf = () => null }) {
  const board = new Map(boardPrs.map(pr => [pr.url, pr]));
  const liveById = new Map(live.map(record => [record.sessionId, record]));
  const stageById = new Map(stageSessions.map(session => [session.sessionId, session]));
  const cards = new Map();
  const cardOf = id => {
    if (!cards.has(id)) cards.set(id, { session: null, links: new Map(), prs: new Map() });
    return cards.get(id);
  };
  for (const record of live) cardOf(record.sessionId);
  for (const prd of prds) {
    for (const session of prd.sessions) {
      const card = cardOf(session.sessionId);
      card.session ??= session;
      card.links.set(prd.ticket, session.weight ?? 0);
      for (const pr of prd.prs) {
        if (!card.prs.has(pr.url)) card.prs.set(pr.url, { ...pr, tickets: [] });
        card.prs.get(pr.url).tickets.push(prd.ticket);
      }
    }
  }
  return [...cards].map(([id, card]) => {
    const details = detailsOf(id);
    const opened = details?.prUrls ?? [];
    for (const url of opened) if (!card.prs.has(url)) card.prs.set(url, { ...prEntry(url, null, board), tickets: [] });
    const session = card.session ?? sessionEntry(id, { stage: stageById.get(id), record: liveById.get(id), cwd: cwdOf(id), seen: details?.at });
    const { prUrls, ...about } = details ?? {};
    const { main, weight, ...base } = session;
    const ranked = rankLinks({ branch: about.branch, links: card.links, prs: card.prs, opened });
    return { ...base, ...about, at: base.at ?? about.at ?? null, tickets: ranked.tickets, prs: ranked.prs };
  }).sort((a, b) => b.running - a.running || String(b.at).localeCompare(String(a.at)));
}

module.exports = { buildPrds, buildSessions, extraTickets };
