'use strict';

const os = require('node:os');
const path = require('node:path');

// Plugins live outside this repo: CommonJS modules listed, comma-separated, in PR_RADAR_PLUGINS.
// Each exports `decorate(node, pr)`, called for every PR before the board sorts it, with the PR as
// GitHub answered the board's query (`node`) and as the board shaped it (`pr`), and returns what to
// add to its card:
//   { pills: [{ text, kind, title, url, running }], labels: [{ name, text, title }], review }
// A pill is a label to read; a label is a button that puts that GitHub label on the PR. `review`
// claims someone else's PR for review and says whose turn it is: { claimedBy, since, turn, why }.
const KINDS = new Set(['', 'todo', 'pending', 'good', 'alert']);
const TURNS = new Set(['me', 'author', 'bot']);

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
        throw new Error(`PR_RADAR_PLUGINS: cannot load ${entry}: ${error.message}`);
      }
      if (typeof plugin?.decorate !== 'function') throw new Error(`PR_RADAR_PLUGINS: ${entry} exports no decorate()`);
      return { name: String(plugin.name ?? path.basename(file)), decorate: plugin.decorate };
    });
}

const text = value => (value == null || value === '' ? null : String(value));

// A claim the board can act on: who, since when, and a turn it knows. Anything else is no claim.
function claim(review) {
  if (!text(review?.claimedBy) || Number.isNaN(Date.parse(review.since)) || !TURNS.has(review.turn)) return null;
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
    try {
      const out = normalise(plugin.decorate(node, pr));
      added.pills.push(...out.pills);
      added.labels.push(...out.labels);
      added.review ??= out.review;
    } catch (error) {
      const failure = failures.get(plugin.name) ?? { count: 0, first: `${pr.repo}#${pr.number}: ${error.message}` };
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

module.exports = { load, normalise, decoratePr, pluginWarnings };
