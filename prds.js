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

// The ended sessions whose prompts or branch name a ticket that are kept: older ones are history.
const ENDED_MENTIONS = 2;

// A PRD's PRs are the ones Linear has attached and the board's PRs naming its ticket. Its
// sessions are the ones whose stage lines name it or one of its PRs, a running session that
// opened one of its PRs (a finished one is already the Claude button on that PR's card), and
// those whose prompts or branch name the ticket: every running one, the newest ended ones.
function buildPrds({ prds, boardPrs = [], stageSessions = [], live = [], sessionFor = () => null, sessionsOf = () => [], cwdOf = () => null }) {
  const board = new Map(boardPrs.map(pr => [pr.url, pr]));
  const liveById = new Map(live.map(record => [record.sessionId, record]));
  const stageById = new Map(stageSessions.map(session => [session.sessionId, session]));
  return prds.map(prd => {
    const prs = new Map(prd.prs.map(pr => [pr.url, prEntry(pr.url, pr.title, board)]));
    for (const pr of boardPrs) if (pr.ticket === prd.ticket && !prs.has(pr.url)) prs.set(pr.url, prEntry(pr.url, pr.title, board));

    const ids = new Set(stageSessions
      .filter(session => session.tickets.has(prd.ticket) || [...session.prUrls].some(url => prs.has(url)))
      .map(session => session.sessionId));
    for (const url of prs.keys()) {
      const opened = sessionFor(url);
      if (opened && liveById.has(opened.sessionId)) ids.add(opened.sessionId);
    }
    const mentions = sessionsOf(prd.ticket);
    const seen = new Map(mentions.map(mention => [mention.sessionId, mention.at]));
    for (const id of mentions.filter(mention => liveById.has(mention.sessionId)).map(mention => mention.sessionId)) ids.add(id);
    for (const id of mentions.filter(mention => !liveById.has(mention.sessionId)).slice(0, ENDED_MENTIONS).map(mention => mention.sessionId)) ids.add(id);
    const sessions = [...ids]
      .map(id => sessionEntry(id, { stage: stageById.get(id), record: liveById.get(id), cwd: cwdOf(id), seen: seen.get(id) }))
      .sort((a, b) => b.running - a.running || String(b.at).localeCompare(String(a.at)));
    return { ...prd, prs: [...prs.values()], sessions };
  });
}

module.exports = { buildPrds, extraTickets };
