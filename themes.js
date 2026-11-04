'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

const isDay = day => Array.isArray(day) && day.length === 2
  && Number.isInteger(day[0]) && day[0] >= 1 && day[0] <= 12
  && Number.isInteger(day[1]) && day[1] >= 1 && day[1] <= 31;

const exists = file => fs.access(file).then(() => true, () => false);

async function readTheme(dir, name) {
  if (!NAME_RE.test(name)) throw new Error('the folder name must be lowercase letters, digits and dashes');
  let meta;
  try {
    meta = JSON.parse(await fs.readFile(path.join(dir, 'theme.json'), 'utf8'));
  } catch (error) {
    throw new Error(`theme.json unreadable (${error.message})`);
  }
  const label = typeof meta.label === 'string' ? meta.label.trim() : '';
  const icon = typeof meta.icon === 'string' ? meta.icon.trim() : '';
  if (!label || !icon) throw new Error('theme.json needs a "label" and an "icon"');
  if (meta.season !== undefined && !(isDay(meta.season?.from) && isDay(meta.season?.to))) {
    throw new Error('"season" needs "from" and "to" as [month, day]');
  }
  if (!(await exists(path.join(dir, 'theme.css')))) throw new Error('theme.css is missing');
  return {
    name,
    label,
    icon,
    season: meta.season ? { from: meta.season.from, to: meta.season.to } : null,
    script: await exists(path.join(dir, 'theme.js')),
  };
}

// A broken theme is left out and named, never the others with it.
async function listThemes(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const themes = [];
  const problems = [];
  for (const entry of entries.filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    try {
      themes.push(await readTheme(path.join(dir, entry.name), entry.name));
    } catch (error) {
      problems.push(`${entry.name}: ${error.message}`);
    }
  }
  return { themes, problems };
}

module.exports = { listThemes };
