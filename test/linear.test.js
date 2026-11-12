'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { fetchPrds } = require('../linear');

const issue = (identifier, extra = {}) => ({
  identifier,
  title: `Title of ${identifier}`,
  url: `https://linear.app/forestadmin/issue/${identifier}`,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-10T00:00:00Z',
  state: { name: 'In Progress', type: 'started', color: '#f2c94c', position: 2 },
  project: { name: 'Workflows', url: 'https://linear.app/forestadmin/project/workflows-1', color: '#26b5ce' },
  assignee: { isMe: true },
  labels: { nodes: [{ name: 'Backend', color: '#5e6ad2' }] },
  attachments: { nodes: [] },
  ...extra,
});

// Answers each query in turn, keeping what was asked.
function fakeLinear(...answers) {
  const asked = [];
  const fetch = async (url, init) => {
    asked.push({ url, init, query: JSON.parse(init.body).query });
    const answer = answers.shift();
    return { ok: answer.ok ?? true, status: answer.status ?? 200, statusText: 'x', json: async () => answer.body };
  };
  return { fetch, asked };
}

test('your started tickets come back with their status, project, labels and GitHub PRs', async () => {
  const { fetch, asked } = fakeLinear({
    body: {
      data: {
        viewer: {
          assignedIssues: {
            nodes: [issue('PRD-1', {
              attachments: {
                nodes: [
                  { url: 'https://github.com/ForestAdmin/claudine/pull/7', title: 'feat: seven' },
                  { url: 'https://github.com/ForestAdmin/claudine/pull/7/files', title: 'again' },
                  { url: 'https://forestadmin.slack.com/archives/C1/p2', title: 'thread' },
                ],
              },
            })],
          },
        },
      },
    },
  });
  const [prd] = await fetchPrds({ apiKey: 'lin_api_x', fetch });
  assert.equal(asked[0].init.headers.Authorization, 'lin_api_x');
  assert.match(asked[0].query, /type: \{ eq: "started" \}/);
  assert.deepEqual(prd, {
    ticket: 'PRD-1',
    title: 'Title of PRD-1',
    url: 'https://linear.app/forestadmin/issue/PRD-1',
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-10T00:00:00Z',
    status: { name: 'In Progress', type: 'started', color: '#f2c94c', position: 2 },
    project: 'Workflows',
    projectUrl: 'https://linear.app/forestadmin/project/workflows-1',
    projectColor: '#26b5ce',
    labels: [{ name: 'Backend', color: '#5e6ad2' }],
    prs: [{ url: 'https://github.com/ForestAdmin/claudine/pull/7', title: 'feat: seven' }],
    assigned: true,
  });
});

test('a ticket a session works on is fetched by its key, and one Linear cannot show is left out', async () => {
  const { fetch, asked } = fakeLinear(
    { body: { data: { viewer: { assignedIssues: { nodes: [issue('PRD-1')] } } } } },
    { body: { data: { t0: issue('PRD-2', { assignee: { isMe: false } }), t1: null }, errors: [{ message: 'Entity not found' }] } },
  );
  const prds = await fetchPrds({ apiKey: 'k', extra: ['PRD-1', 'PRD-2', 'PRD-3', 'not a key"}'], fetch });
  assert.deepEqual(prds.map(prd => [prd.ticket, prd.assigned]), [['PRD-1', true], ['PRD-2', false]]);
  assert.match(asked[1].query, /t0: issue\(id: "PRD-2"\)/);
  assert.match(asked[1].query, /t1: issue\(id: "PRD-3"\)/);
  assert.doesNotMatch(asked[1].query, /not a key/);
});

test('a refused key says what Linear answered', async () => {
  const { fetch } = fakeLinear({ ok: false, status: 400, body: { errors: [{ message: 'Authentication required' }] } });
  await assert.rejects(fetchPrds({ apiKey: 'bad', fetch }), /Linear answered Authentication required/);
});
