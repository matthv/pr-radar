'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { listThemes, overlaps, themeFiles } = require('../themes');
const { inSeason, seasonYear, pickDecor, offKey, readOff, stars } = require('../public/decor');

const day = (month, date) => new Date(2026, month - 1, date, 12);

test('decor: a season holds within its dates, a window over the new year included', () => {
  const halloween = { from: [10, 26], to: [10, 31] };
  assert.equal(inSeason(halloween, day(10, 26)), true);
  assert.equal(inSeason(halloween, day(10, 31)), true);
  assert.equal(inSeason(halloween, day(11, 1)), false);

  const winter = { from: [12, 20], to: [1, 5] };
  assert.equal(inSeason(winter, day(12, 24)), true);
  assert.equal(inSeason(winter, day(1, 3)), true);
  assert.equal(inSeason(winter, day(2, 1)), false);
});

test('decor: a theme in season wins over PR_RADAR_THEME, which holds the rest of the year', () => {
  const themes = [
    { name: 'halloween', season: { from: [10, 26], to: [10, 31] } },
    { name: 'mine', season: null },
  ];
  assert.equal(pickDecor({ themes, fallback: 'mine' }, { now: day(10, 28) }).name, 'halloween');
  assert.equal(pickDecor({ themes, fallback: 'mine' }, { now: day(3, 1) }).name, 'mine');
  assert.equal(pickDecor({ themes, fallback: null }, { now: day(3, 1) }), null, 'no variable, no theme out of season');
  assert.equal(pickDecor({ themes, fallback: 'gone' }, { now: day(3, 1) }), null, 'an unknown name is no theme');
});

test('decor: a theme asked in the address shows whatever the date', () => {
  const themes = [{ name: 'halloween', season: { from: [10, 26], to: [10, 31] } }, { name: 'mine', season: null }];
  assert.equal(pickDecor({ themes, fallback: 'mine' }, { asked: 'halloween', now: day(3, 1) }).name, 'halloween');
  assert.equal(pickDecor({ themes, fallback: 'mine' }, { asked: 'nope', now: day(3, 1) }).name, 'mine', 'a typo falls back to the usual rule');
  assert.equal(pickDecor({ themes, fallback: 'mine' }, { asked: 'nope', now: day(10, 28) }).name, 'halloween');
});

test('decor: a season over the new year is one season, turned off once', () => {
  const winter = { name: 'winter', season: { from: [12, 20], to: [1, 5] } };
  assert.equal(seasonYear(winter.season, day(12, 24)), 2026);
  assert.equal(seasonYear(winter.season, new Date(2027, 0, 3, 12)), 2026);
  assert.equal(offKey(winter, day(12, 24)), offKey(winter, new Date(2027, 0, 3, 12)));
  assert.equal(offKey({ name: 'mine', season: null }, day(3, 1)), true);
});

test('decor: each theme keeps its own off state, the old single value read once', () => {
  assert.deepEqual(readOff('{"mine":true,"halloween":2026}', ''), { mine: true, halloween: 2026 });
  assert.deepEqual(readOff(null, 'halloween-2026'), { halloween: 2026 }, 'the first version kept one value');
  assert.deepEqual(readOff('{"halloween":2025}', 'halloween-2026'), { halloween: 2025 }, 'the new state wins');
  assert.deepEqual(readOff('not json', 'nonsense'), {});
});

test('decor: a starfield is the same from one load to the next', () => {
  const sky = stars({ seed: 42, count: 20, className: 'x-star' });
  assert.equal(sky, stars({ seed: 42, count: 20, className: 'x-star' }));
  assert.notEqual(sky, stars({ seed: 43, count: 20, className: 'x-star' }));
  assert.equal((sky.match(/class="x-star/g) ?? []).length, 20);
});

test('themes: seasons sharing a day are named, a window over the new year included', () => {
  const themes = [
    { name: 'autumn', season: { from: [10, 1], to: [11, 30] } },
    { name: 'halloween', season: { from: [10, 26], to: [10, 31] } },
    { name: 'winter', season: { from: [12, 20], to: [1, 5] } },
    { name: 'newyear', season: { from: [1, 1], to: [1, 2] } },
    { name: 'mine', season: null },
  ];
  assert.deepEqual(overlaps(themes), [['autumn', 'halloween'], ['winter', 'newyear']]);
});

async function themesDir(entries) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-radar-themes-'));
  for (const [name, files] of Object.entries(entries)) {
    await fs.mkdir(path.join(dir, name));
    for (const [file, content] of Object.entries(files)) {
      await fs.writeFile(path.join(dir, name, file), typeof content === 'string' ? content : JSON.stringify(content));
    }
  }
  return dir;
}

test('themes: each folder is read, a broken one left out and named', async () => {
  const dir = await themesDir({
    halloween: { 'theme.json': { label: 'Halloween', icon: '🎃', season: { from: [10, 26], to: [10, 31] } }, 'theme.css': '', 'theme.js': '' },
    mine: { 'theme.json': { label: 'Mine', icon: '🌿' }, 'theme.css': '' },
    nocss: { 'theme.json': { label: 'No CSS', icon: '❓' } },
    badseason: { 'theme.json': { label: 'Bad', icon: '❓', season: { from: [13, 1], to: [1, 1] } }, 'theme.css': '' },
    nolabel: { 'theme.json': { icon: '❓' }, 'theme.css': '' },
    Upper: { 'theme.json': { label: 'Upper', icon: '❓' }, 'theme.css': '' },
  });
  const { themes, problems } = await listThemes(dir);

  assert.deepEqual(themes, [
    { name: 'halloween', label: 'Halloween', icon: '🎃', season: { from: [10, 26], to: [10, 31] }, script: true },
    { name: 'mine', label: 'Mine', icon: '🌿', season: null, script: false },
  ]);
  assert.equal(problems.length, 4);
  assert.ok(problems.some(problem => problem.startsWith('nocss: theme.css is missing')));
  assert.ok(problems.some(problem => problem.startsWith('badseason:')));
  assert.ok(problems.some(problem => problem.startsWith('nolabel:')));
  assert.ok(problems.some(problem => problem.startsWith('Upper:')));
});

test('themes: no folder is no theme, not an error', async () => {
  assert.deepEqual(await listThemes(path.join(os.tmpdir(), 'pr-radar-no-such-dir')), { themes: [], problems: [] });
});

test('themes: the shipped ones are all valid, and no two share a day', async () => {
  const { themes, problems } = await listThemes(path.join(__dirname, '..', 'public', 'themes'));
  assert.deepEqual(problems, []);
  assert.deepEqual(overlaps(themes), []);
});

test('themes: the files the asset version is made of are listed without being read', async () => {
  const dir = await themesDir({ mine: { 'theme.json': '{', 'theme.css': '', 'notes.txt': '' } });
  assert.deepEqual((await themeFiles(dir)).sort(), [path.join('mine', 'theme.css'), path.join('mine', 'theme.json')]);
});
