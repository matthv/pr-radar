'use strict';

const os = require('node:os');
const path = require('node:path');

// The contract a plugin writes against is in the README, under "Plugins".
const KINDS = new Set(['', 'todo', 'pending', 'good', 'alert']);
const TURNS = new Set(['me', 'author', 'bot']);
const HOOK_TIMEOUT_MS = 5000;
// A local clock a little behind GitHub's must not make a claim just made look like one from the future.
const CLOCK_SKEW_MS = 60_000;

// A plugin may throw anything, `null` or a string included.
const reason = error => (error instanceof Error ? error.message : String(error));

function load(value, req = require) {
  return String(value ?? '')
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean)
    .map(entry => {
      const file = path.resolve(entry.replace(/^~(?=\/|$)/, os.homedir()));
      let plugin;
      try {
        plugin = req(file);
      } catch (error) {
        throw new Error(`PR_RADAR_PLUGINS: cannot load ${entry}: ${reason(error)}`);
      }
      const decorate = typeof plugin?.decorate === 'function' ? plugin.decorate : null;
      const focus = typeof plugin?.focus === 'function' ? plugin.focus : null;
      const open = typeof plugin?.open === 'function' ? plugin.open : null;
      if (!decorate && !focus && !open) throw new Error(`PR_RADAR_PLUGINS: ${entry} exports none of decorate(), focus() or open()`);
      return { name: String(plugin.name ?? path.basename(file)), decorate, focus, open };
    });
}

const text = value => (value == null || value === '' ? null : String(value));

// A claim dated in the future could never lapse: no review of mine would ever come after it.
function claim(review) {
  const since = Date.parse(review?.since);
  if (!text(review?.claimedBy) || Number.isNaN(since) || since > Date.now() + CLOCK_SKEW_MS || !TURNS.has(review.turn)) return null;
  return { claimedBy: String(review.claimedBy), since: String(review.since), turn: review.turn, why: text(review.why) };
}

// What a plugin returns ends up in the page and in the sorting: the kind becomes a class, the URL an
// href, the claim a group. All are checked here, once, so a plugin cannot put a `javascript:` link or
// a stray class on a card, or a card in a group that does not exist.
function normalise(out) {
  return {
    pills: (out?.pills ?? []).filter(pill => text(pill?.text)).map(pill => ({
      text: String(pill.text),
      kind: KINDS.has(pill.kind ?? '') ? (pill.kind ?? '') : '',
      title: text(pill.title),
      url: /^https:\/\//.test(pill.url ?? '') ? pill.url : null,
      running: Boolean(pill.running),
    })),
    labels: (out?.labels ?? []).filter(label => text(label?.name)).map(label => ({
      name: String(label.name),
      text: text(label.text) ?? String(label.name),
      title: text(label.title),
    })),
    review: claim(out?.review),
  };
}

// A plugin that throws costs its own pills on that PR, never the board: its failures are counted in
// `failures`, one warning per plugin naming the first PR it failed on. The first plugin to claim wins.
function decoratePr(plugins, node, pr, failures) {
  const added = { pills: [], labels: [], review: null };
  for (const plugin of plugins) {
    if (!plugin.decorate) continue;
    try {
      const returned = plugin.decorate(node, pr);
      // The board is sorted before a promise could settle, and one that rejects with nobody
      // listening stops the server.
      if (typeof returned?.then === 'function') {
        returned.then(null, () => {});
        throw new Error('decorate() must be synchronous, it returned a promise');
      }
      const out = normalise(returned);
      added.pills.push(...out.pills);
      added.labels.push(...out.labels);
      added.review ??= out.review;
    } catch (error) {
      const failure = failures.get(plugin.name) ?? { count: 0, first: `${pr.repo}#${pr.number}: ${reason(error)}` };
      failure.count += 1;
      failures.set(plugin.name, failure);
    }
  }
  return added;
}

const pluginWarnings = failures => [...failures.entries()].map(([name, { count, first }]) => ({
  source: 'plugin',
  message: `${name} failed on ${count} PR(s), first ${first}`,
}));

// The first plugin whose `hook` answers true wins. One that throws, or has not answered after `ms`,
// is passed over, so a broken plugin never hides another's, and its message comes back for the
// error the click shows.
async function ask(plugins, hook, session, ms = HOOK_TIMEOUT_MS) {
  const failures = [];
  for (const plugin of plugins) {
    if (!plugin[hook]) continue;
    const late = new Error(`no answer after ${ms / 1000} s`);
    let timer;
    try {
      const answer = Promise.resolve().then(() => plugin[hook](session));
      answer.catch(() => {});
      const timeout = new Promise((_, reject) => { timer = setTimeout(reject, ms, late); });
      if (await Promise.race([answer, timeout])) return { done: true, failures, stalled: false };
    } catch (error) {
      failures.push(`${plugin.name}: ${reason(error)}`);
      // An open() still running may yet open the session: asking anyone else, the terminal
      // included, would put two processes on it and fork its history.
      if (error === late && hook === 'open') return { done: false, failures, stalled: true };
    } finally {
      clearTimeout(timer);
    }
  }
  return { done: false, failures, stalled: false };
}

const focusSession = (plugins, session, ms) => ask(plugins, 'focus', session, ms);
const openSession = (plugins, session, ms) => ask(plugins, 'open', session, ms);

// gh hands back GitHub's error body on stdout and runGh returns it as if it had worked: only the
// label list GitHub answers a successful add with counts. GitHub matches a label's name whatever
// its case and answers with the repo's spelling.
async function addLabel(pr, label, runGh) {
  const out = await runGh(['api', '-X', 'POST', `repos/${pr.repo}/issues/${pr.number}/labels`, '-f', `labels[]=${label}`]);
  let answer;
  try {
    answer = JSON.parse(out);
  } catch {
    throw new Error(`GitHub answered something other than JSON: ${out.trim().slice(0, 80)}`);
  }
  if (!Array.isArray(answer) || !answer.some(added => String(added?.name).toLowerCase() === label.toLowerCase())) {
    throw new Error(answer?.message ?? 'GitHub did not add the label');
  }
}

// A plugin's label button. Only a label a plugin offers on that PR, as the board last showed it,
// and only ever added: taking one off and putting it back would start its workflow again.
// The route, kept here with its guards so a test can drive it end to end; `refusal` is
// claude-sessions', handed in because that module already requires this one.
async function labelRoute({ headers, remoteAddress, readBody }, { refusal, demo, board, runGh, reload, logger }) {
  const refused = refusal({ contentType: headers['content-type'], remoteAddress, host: headers.host });
  if (refused) return [403, refused];
  if (demo) return [200, null];
  let body;
  try {
    body = await readBody();
  } catch (error) {
    return [400, reason(error)];
  }
  const pr = board && [...board.mine, ...board.reviews].find(candidate => candidate.id === body?.id);
  const offered = pr?.plugins?.labels.find(label => label.name === body.label);
  if (!offered) return [409, 'no plugin offers this label on this PR any more'];
  try {
    await addLabel(pr, offered.name, runGh);
  } catch (error) {
    logger.fail('plugins', `${offered.name} on ${pr.repo}#${pr.number}: ${reason(error)}`);
    return [502, reason(error)];
  }
  logger.info('plugins', `${offered.name} added to ${pr.repo}#${pr.number}`);
  // Answered once the card shows the label, so the button the page drew disappears with it.
  await reload(pr.id).catch(error => logger.fail('plugins', `reload after the label: ${reason(error)}`));
  return [200, null];
}

module.exports = { load, normalise, decoratePr, pluginWarnings, focusSession, openSession, labelRoute };
