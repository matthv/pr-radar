'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

const isDay = day => Array.isArray(day) && day.length === 2
  && Number.isInteger(day[0]) && day[0] >= 1 && day[0] <= 12
  && Number.isInteger(day[1]) && day[1] >= 1 && day[1] <= new Date(2024, day[0], 0).getDate();

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

async function listThemes(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const themes = [];
  const problems = [];
  for (const entry of entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name))) {
    try {
      themes.push(await readTheme(path.join(dir, entry.name), entry.name));
    } catch (error) {
      problems.push(`${entry.name}: ${error.message}`);
    }
  }
  return { themes, problems };
}

async function listAllThemes(shippedDir, customDir) {
  const shipped = await listThemes(shippedDir);
  const custom = await listThemes(customDir);
  const taken = new Set(shipped.themes.map(theme => theme.name));
  return {
    themes: [...shipped.themes, ...custom.themes.filter(theme => !taken.has(theme.name)).map(theme => ({ ...theme, custom: true }))]
      .sort((a, b) => a.name.localeCompare(b.name)),
    problems: [
      ...shipped.problems,
      ...custom.problems.map(problem => `custom-themes/${problem}`),
      ...custom.themes.filter(theme => taken.has(theme.name))
        .map(theme => `custom-themes/${theme.name}: a shipped theme has this name, rename the folder`),
    ],
  };
}

const dayKeys = ({ from, to }) => {
  const keys = new Set();
  const day = new Date(2024, from[0] - 1, from[1]);
  for (let step = 0; step < 366; step += 1) {
    keys.add(`${day.getMonth() + 1}-${day.getDate()}`);
    if (day.getMonth() + 1 === to[0] && day.getDate() === to[1]) break;
    day.setDate(day.getDate() + 1);
  }
  return keys;
};

function overlaps(themes) {
  const seasonal = themes.filter(theme => theme.season).map(theme => ({ name: theme.name, days: dayKeys(theme.season) }));
  return seasonal.flatMap((a, index) => seasonal.slice(index + 1)
    .filter(b => [...a.days].some(day => b.days.has(day)))
    .map(b => [a.name, b.name]));
}

async function themeFiles(dir) {
  const folders = (await fs.readdir(dir, { withFileTypes: true }).catch(() => [])).filter(entry => entry.isDirectory() && !entry.name.startsWith('.'));
  const files = await Promise.all(folders.map(async ({ name }) =>
    (await fs.readdir(path.join(dir, name)).catch(() => []))
      .filter(file => /^theme\.(json|css|js)$/.test(file))
      .map(file => path.join(name, file))));
  return files.flat();
}

module.exports = { NAME_RE, listThemes, listAllThemes, overlaps, themeFiles };
