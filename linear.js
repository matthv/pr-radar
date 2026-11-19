'use strict';

// The PRDs view's tickets come from Linear's GraphQL API, read with a personal API key: the
// ones assigned to you in a started state, plus any ticket a local Claude session is working
// on. The board itself never needs it.
const ENDPOINT = 'https://api.linear.app/graphql';
const IDENTIFIER = /^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/;
const GITHUB_PR = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;
// A Linear that hangs would hold the PRDs view, and the Sessions poll waiting on it, for minutes.
const TIMEOUT_MS = 15_000;

const FIELDS = `identifier title url createdAt updatedAt
  state { name type color position }
  project { name color }
  assignee { isMe }
  labels(first: 20) { nodes { name color } }
  attachments(first: 30) { nodes { url title } }`;

async function query(apiKey, text, { fetch = globalThis.fetch } = {}) {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    // A personal API key goes as is: Bearer is for OAuth tokens.
    headers: { 'Content-Type': 'application/json', Authorization: apiKey },
    body: JSON.stringify({ query: text }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok && !payload?.data) {
    const reason = payload?.errors?.[0]?.message ?? `${response.status} ${response.statusText}`;
    throw new Error(`Linear answered ${reason}`);
  }
  return payload ?? {};
}

function shape(issue) {
  const prs = new Map();
  for (const attachment of issue.attachments?.nodes ?? []) {
    const url = String(attachment.url ?? '').replace(/\/(files|commits)?\/?$/, '');
    if (GITHUB_PR.test(url) && !prs.has(url)) prs.set(url, attachment.title ?? null);
  }
  return {
    ticket: issue.identifier,
    title: issue.title,
    url: issue.url,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    status: issue.state ? { name: issue.state.name, type: issue.state.type, color: issue.state.color, position: issue.state.position } : null,
    project: issue.project?.name ?? null,
    projectColor: issue.project?.color ?? null,
    labels: (issue.labels?.nodes ?? []).map(label => ({ name: label.name, color: label.color })),
    prs: [...prs].map(([url, title]) => ({ url, title })),
    // Yours whatever its state: a ticket a session works on may be yours and already done.
    assigned: Boolean(issue.assignee?.isMe),
  };
}

// Your started tickets, then the extra ones by identifier in one aliased query. An extra one
// Linear does not know, or cannot show you, is left out rather than failing the rest; when none
// can be read (a rate limit, a 5xx), `warn` says so.
async function fetchPrds({ apiKey, extra = [], fetch, warn = () => {} } = {}) {
  const mine = await query(apiKey, `{ viewer { assignedIssues(first: 100, filter: { state: { type: { eq: "started" } } }) { nodes { ${FIELDS} } } } }`, { fetch });
  if (!mine.data?.viewer) throw new Error(`Linear answered ${mine.errors?.[0]?.message ?? 'no viewer'}`);
  const prds = mine.data.viewer.assignedIssues.nodes.map(shape);
  const known = new Set(prds.map(prd => prd.ticket));
  const wanted = [...new Set(extra)].filter(key => IDENTIFIER.test(key) && !known.has(key)).slice(0, 30);
  if (wanted.length) {
    try {
      for (const issue of await readIssues(apiKey, wanted, fetch)) prds.push(shape(issue));
    } catch (error) {
      // `issue` is non-null in Linear's schema: one key it cannot resolve nulls the whole answer.
      // Asked alone, each key it knows still comes back.
      const alone = wanted.length > 1 ? await Promise.allSettled(wanted.map(key => readIssues(apiKey, [key], fetch))) : [];
      for (const read of alone) if (read.status === 'fulfilled') for (const issue of read.value) prds.push(shape(issue));
      if (!alone.some(read => read.status === 'fulfilled')) warn(`The tickets your sessions work on could not be read: ${error.message}`);
    }
  }
  return prds;
}

async function readIssues(apiKey, keys, fetch) {
  const aliases = keys.map((key, index) => `t${index}: issue(id: "${key}") { ${FIELDS} }`).join('\n');
  const answer = await query(apiKey, `{ ${aliases} }`, { fetch });
  if (!answer.data) throw new Error(`Linear answered ${answer.errors?.[0]?.message ?? 'no data'}`);
  return Object.values(answer.data).filter(Boolean);
}

module.exports = { fetchPrds, shape };
