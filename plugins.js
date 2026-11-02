'use strict';

const os = require('node:os');
const path = require('node:path');

// Plugins live outside this repo: CommonJS modules listed, comma-separated, in PR_RADAR_PLUGINS.
// Each exports `decorate(node, pr)`, called for every PR on the board with the PR as GitHub
// answered the board's query (`node`) and as the board shaped it (`pr`), and returns what to add
// to its card:
//   { pills: [{ text, kind, title, url, running }], labels: [{ name, text, title }] }
// A pill is a label to read; a label is a button that puts that GitHub label on the PR.
const KINDS = new Set(['', 'todo', 'pending', 'good', 'alert']);

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

// What a plugin returns ends up in the page: the kind becomes a class, the URL an href. Both are
// checked here, once, so a plugin cannot put a `javascript:` link or a stray class on a card.
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
  };
}

// A plugin that throws costs its own pills on that PR, never the board: the failure is one
// warning per plugin, naming the first PR it failed on.
function decorateBoard(plugins, board, nodes) {
  if (!plugins.length) return board;
  const failures = new Map();
  const decorate = pr => {
    const added = { pills: [], labels: [] };
    for (const plugin of plugins) {
      try {
        const out = normalise(plugin.decorate(nodes.get(pr.id), pr));
        added.pills.push(...out.pills);
        added.labels.push(...out.labels);
      } catch (error) {
        const failure = failures.get(plugin.name) ?? { count: 0, first: `${pr.repo}#${pr.number}: ${error.message}` };
        failure.count += 1;
        failures.set(plugin.name, failure);
      }
    }
    return { ...pr, plugins: added };
  };
  const decorated = { ...board, mine: board.mine.map(decorate), reviews: board.reviews.map(decorate) };
  return {
    ...decorated,
    warnings: [
      ...board.warnings.filter(warning => warning.source !== 'plugin'),
      ...[...failures.entries()].map(([name, { count, first }]) => ({
        source: 'plugin',
        message: `${name} failed on ${count} PR(s), first ${first}`,
      })),
    ],
  };
}

module.exports = { load, normalise, decorateBoard };
