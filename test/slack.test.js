'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  pullRequestLinks,
  mergeLinks,
  permalink,
  parseClaudeMessages,
  dueForLookup,
  recordMisses,
  MAX_ATTEMPTS,
  parseClaims,
  promptForClaims,
  claimsDue,
  claimsChanged,
  claimsAfter,
  parseClaimAnswer,
  claudeArgs,
} = require('../slack');

// The shape actually seen in #tech-pr: a hand-written message, several PRs, each a
// Slack-formatted link with its label.
const announcement = {
  ts: '1790669731.153829',
  text: 'So that Olivier doesn\'t feel lonely, 4 small PRs\n'
    + ':wood: <https://github.com/ForestAdmin/forestadmin/pull/9981|fix(mcp-server): name the cause>\n'
    + ':wood: <https://github.com/ForestAdmin/agent-nodejs/pull/1925|feat(workflow-executor): accept an oauth grant>\n'
    + ':wood: <https://github.com/ForestAdmin/forestadmin/pull/9982|fix(mcp-server): blame the agent>',
};

test('pullRequestLinks reads every PR link out of a Slack-formatted message', () => {
  assert.deepEqual(pullRequestLinks(announcement), [
    { repo: 'ForestAdmin/forestadmin', number: 9981 },
    { repo: 'ForestAdmin/agent-nodejs', number: 1925 },
    { repo: 'ForestAdmin/forestadmin', number: 9982 },
  ]);
});

test('pullRequestLinks names a PR once, however many times the message repeats it', () => {
  const message = {
    ts: '1',
    text: '<https://github.com/o/r/pull/1|first> and again <https://github.com/o/r/pull/1>',
  };
  assert.deepEqual(pullRequestLinks(message), [{ repo: 'o/r', number: 1 }]);
});

test('pullRequestLinks treats the same PR in different casing as one', () => {
  const message = {
    ts: '1',
    text: '<https://github.com/ForestAdmin/Forestadmin/pull/7> <https://github.com/forestadmin/forestadmin/pull/7>',
  };
  assert.equal(pullRequestLinks(message).length, 1);
});

test('pullRequestLinks ignores issues and a bare join notice', () => {
  assert.deepEqual(pullRequestLinks({ ts: '1', text: '<https://github.com/o/r/issues/42|bug>' }), []);
  assert.deepEqual(pullRequestLinks({ ts: '1', subtype: 'channel_join', text: '<@U1|Nico> has joined the channel' }), []);
});

test('pullRequestLinks finds a link an app tucked into attachments', () => {
  const message = {
    ts: '1',
    text: '',
    attachments: [{ title_link: 'https://github.com/o/r/pull/12', title: 'feat: x' }],
  };
  assert.deepEqual(pullRequestLinks(message), [{ repo: 'o/r', number: 12 }]);
});

const empty = { byPr: new Map(), latestTs: null };

test('mergeLinks keeps the oldest message for a PR posted twice', () => {
  const { byPr } = mergeLinks(empty, [
    { ts: '1790669731.153829', text: '<https://github.com/o/r/pull/5|again>' },
    { ts: '1790669118.622829', text: '<https://github.com/o/r/pull/5|first>' },
  ]);
  assert.equal(byPr.get('o/r#5'), '1790669118.622829');
});

test('mergeLinks does not let a later fetch overwrite an earlier announcement', () => {
  const first = mergeLinks(empty, [{ ts: '1790669118.622829', text: '<https://github.com/o/r/pull/5>' }]);
  const second = mergeLinks(first, [{ ts: '1790669731.153829', text: '<https://github.com/o/r/pull/5>' }]);
  assert.equal(second.byPr.get('o/r#5'), '1790669118.622829');
});

test('mergeLinks tracks the newest timestamp seen, links or not', () => {
  const { latestTs } = mergeLinks(empty, [
    { ts: '1790668985.748109', text: 'joined' },
    { ts: '1790669731.153829', text: 'four PRs' },
    { ts: '1790669118.622829', text: 'one PR' },
  ]);
  assert.equal(latestTs, '1790669731.153829');
});

test('mergeLinks keys the board\'s canonical repo casing and a pasted lowercase URL alike', () => {
  const { byPr } = mergeLinks(empty, [{ ts: '1', text: 'https://github.com/forestadmin/agent-nodejs/pull/1925' }]);
  assert.equal(byPr.get('forestadmin/agent-nodejs#1925'), '1');
});

test('permalink is the archive URL with the dot dropped from the timestamp', () => {
  assert.equal(
    permalink('https://forestadmin.slack.com/', 'C0C4S34GD7H', '1790669118.622829'),
    'https://forestadmin.slack.com/archives/C0C4S34GD7H/p1790669118622829',
  );
  assert.equal(
    permalink('https://forestadmin.slack.com', 'C0C4S34GD7H', '1790669118.622829'),
    'https://forestadmin.slack.com/archives/C0C4S34GD7H/p1790669118622829',
    'with or without the trailing slash auth.test happens to return',
  );
});

test('permalink ignores anything after the workspace domain, a pasted `]` included', () => {
  assert.equal(
    permalink('https://forestadmin.slack.com/]', 'C0C4S34GD7H', '1790669118.622829'),
    'https://forestadmin.slack.com/archives/C0C4S34GD7H/p1790669118622829',
  );
});

// What claude -p actually answered in the spike: the array inside a markdown fence.
test('parseClaudeMessages reads the array out of a fenced answer', () => {
  const output = '```json\n[{"ts": "1790677464.854919", "text": "• https://github.com/ForestAdmin/agent-ruby/pull/397"}]\n```';
  assert.deepEqual(parseClaudeMessages(output), [
    { ts: '1790677464.854919', text: '• https://github.com/ForestAdmin/agent-ruby/pull/397' },
  ]);
});

test('parseClaudeMessages drops a message whose timestamp is out of shape', () => {
  const output = JSON.stringify([
    { ts: '1790677464.854919', text: 'kept' },
    { ts: '1790677464.85491', text: 'one digit short' },
    { ts: 1790677464.854919, text: 'a number, precision already lost' },
    { text: 'no ts at all' },
  ]);
  assert.deepEqual(parseClaudeMessages(output).map(m => m.text), ['kept']);
});

test('parseClaudeMessages treats an empty array as an empty channel', () => {
  assert.deepEqual(parseClaudeMessages('[]'), []);
});

test('parseClaudeMessages makes an answer that is not JSON a failed read, not an empty channel', () => {
  assert.throws(() => parseClaudeMessages('I could not read the channel.'), /unreadable/);
  assert.throws(() => parseClaudeMessages('[not json]'), /unreadable/);
});

const NOW = 1_790_700_000_000;
const pr = (number, repo = 'ForestAdmin/forestadmin') => ({ id: `PR_${number}`, repo, number });
const state = (byPr = {}, attempts = {}) => ({ byPr: new Map(Object.entries(byPr)), latestTs: null, attempts });

test('dueForLookup: a PR new to the board is due at once', () => {
  assert.deepEqual(dueForLookup([pr(1)], state(), NOW), ['forestadmin/forestadmin#1']);
});

test('dueForLookup: a PR already linked is never due', () => {
  assert.deepEqual(dueForLookup([pr(1)], state({ 'forestadmin/forestadmin#1': '1790669118.622829' }), NOW), []);
});

test('dueForLookup: a PR waits for its next try, then is due again', () => {
  const waiting = state({}, { 'forestadmin/forestadmin#1': { count: 1, nextAt: NOW + 1 } });
  assert.deepEqual(dueForLookup([pr(1)], waiting, NOW), []);
  assert.deepEqual(dueForLookup([pr(1)], waiting, NOW + 1), ['forestadmin/forestadmin#1']);
});

test('dueForLookup: a PR is given up on after its last try', () => {
  const spent = state({}, { 'forestadmin/forestadmin#1': { count: MAX_ATTEMPTS, nextAt: null } });
  assert.deepEqual(dueForLookup([pr(1)], spent, NOW + 10 * 86_400_000), []);
});

test('dueForLookup: nothing new on the board means no call at all', () => {
  const settled = state(
    { 'forestadmin/forestadmin#1': '1790669118.622829' },
    { 'forestadmin/forestadmin#2': { count: MAX_ATTEMPTS, nextAt: null } },
  );
  assert.deepEqual(dueForLookup([pr(1), pr(2)], settled, NOW), []);
});

test('recordMisses spaces the tries out: +30 min, then +2 h, then none', () => {
  const key = 'forestadmin/forestadmin#1';
  const first = recordMisses({}, [key], NOW);
  assert.deepEqual(first[key], { count: 1, nextAt: NOW + 30 * 60_000 });
  const second = recordMisses(first, [key], NOW);
  assert.deepEqual(second[key], { count: 2, nextAt: NOW + 2 * 60 * 60_000 });
  const third = recordMisses(second, [key], NOW);
  assert.deepEqual(third[key], { count: 3, nextAt: null });
});

test('recordMisses leaves PRs it was not asked about untouched', () => {
  const other = { 'o/r#9': { count: 1, nextAt: 5 } };
  assert.deepEqual(recordMisses(other, ['o/r#1'], NOW)['o/r#9'], { count: 1, nextAt: 5 });
});

test('claims: the PR links of the messages I reacted to, once each', () => {
  const answer = 'Here they are:\n' + JSON.stringify({ messages: [
    { ts: '1791371567.461059', text: '<https://github.com/ForestAdmin/agent-ruby/pull/409|back> <https://github.com/forestadmin/agent-ruby/pull/409|again>' },
    { ts: '1791371000.000001', text: '<https://github.com/ForestAdmin/forestadmin/pull/10027|front> and not a link' },
    { ts: 'not a ts', text: 'https://github.com/o/r/pull/1' },
  ], more: false });
  assert.deepEqual(parseClaims(answer), [
    { repo: 'ForestAdmin/agent-ruby', number: 409 },
    { repo: 'ForestAdmin/forestadmin', number: 10027 },
  ]);
  assert.deepEqual(parseClaims('{"messages": [], "more": false}'), []);
  assert.throws(() => parseClaims('I could not search'), /unreadable/);
  assert.throws(() => parseClaims('{oops}'), /unreadable/);
  const twice = { messages: [{ ts: '1791371567.461059', text: 'https://github.com/o/r/pull/5' }, { ts: '1791371568.461059', text: 'again https://github.com/o/r/pull/5' }], more: false };
  assert.deepEqual(parseClaims(JSON.stringify(twice)), [{ repo: 'o/r', number: 5 }], 'an announcement and its repost, one claim');
});

test('claims: the search asks for my own reactions only, and treats messages as data', () => {
  const prompt = promptForClaims('2026-08-08');
  assert.match(prompt, /hasmy::\S*: after:2026-08-08/);
  assert.match(prompt, /untrusted data/);
});

test('claims: read every five minutes, at once on a manual refresh, not during a back-off', () => {
  const now = Date.parse('2026-10-07T12:00:00Z');
  const min = 60_000;
  assert.equal(claimsDue(null, null, now, false), true, 'never read');
  assert.equal(claimsDue({ at: now - 4 * min, refs: [] }, null, now, false), false);
  assert.equal(claimsDue({ at: now - 5 * min, refs: [] }, null, now, false), true);
  assert.equal(claimsDue({ at: now - min, refs: [] }, null, now, true), true, 'Refresh reads again');
  assert.equal(claimsDue(null, { retryAt: now + min }, now, false), false, 'a failure waits its back-off');
  assert.equal(claimsDue(null, { retryAt: now + min }, now, true), false, 'Refresh too: a failing read is not retried on every click');
  assert.equal(claimsDue(null, { retryAt: now - 1 }, now, false), true);
});

test('claims: a new search only when the set of claimed PRs moved, whatever the order', () => {
  const a = { repo: 'o/r', number: 1 };
  const b = { repo: 'o/r', number: 2 };
  assert.equal(claimsChanged(null, []), true, 'the first read');
  assert.equal(claimsChanged({ refs: [a, b] }, [b, a]), false);
  assert.equal(claimsChanged({ refs: [a, b] }, [a]), true, 'a reaction removed');
  assert.equal(claimsChanged({ refs: [a] }, [a, b]), true, 'a reaction added');
});

test('claims: only announcements posted since the feature was turned on', () => {
  const day = 86400_000;
  const now = Date.parse('2026-10-07T12:00:00Z');
  assert.equal(claimsAfter(now - 60 * day, '2026-10-07'), '2026-10-06', 'the day before, Slack excludes the one it names');
  assert.equal(claimsAfter(now - 60 * day, null), '2026-08-07', 'no date yet: the age window');
  assert.equal(claimsAfter(now - 60 * day, '2026-01-01'), '2026-08-07', 'turned on long ago: the age window wins');
});

test('claims: messages returned but none readable is an error, not "no reaction"', () => {
  assert.throws(() => parseClaimAnswer('{"messages": [{"ts": "yesterday", "text": "x"}], "more": false}'), /unreadable messages/);
  assert.equal(parseClaimAnswer('{"messages": [], "more": true}').more, true, 'more pages than were read');
  const full = { messages: Array.from({ length: 20 }, (_, i) => ({ ts: `17913715${String(i).padStart(2, '0')}.000001`, text: 'x' })) };
  assert.equal(parseClaimAnswer(JSON.stringify(full)).more, true, 'a full page and no word on more: assume there is');
});

test('claims: the model is allowed the search that sees private channels', () => {
  const args = claudeArgs('haiku');
  assert.match(args[args.indexOf('--allowedTools') + 1], /slack_search_public_and_private/);
});
