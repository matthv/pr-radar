'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const { listThemes, listAllThemes, overlaps, themeFiles } = require('../themes');
const { createTheme, generateTheme, removeTheme, parseGenerated } = require('../new-theme');
const { inSeason, pickDecor, stars } = require('../public/decor');

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

test('decor: the menu pick wins over the season and the default, the address over the pick', () => {
  const themes = [
    { name: 'halloween', season: { from: [10, 26], to: [10, 31] } },
    { name: 'mine', season: null },
    { name: 'starwars', season: { from: [5, 4], to: [5, 6] } },
  ];
  const catalog = { themes, fallback: 'mine' };
  assert.equal(pickDecor(catalog, { chosen: 'starwars', now: day(10, 28) }).name, 'starwars');
  assert.equal(pickDecor(catalog, { chosen: 'none', now: day(10, 28) }), null);
  assert.equal(pickDecor(catalog, { chosen: '', now: day(10, 28) }).name, 'halloween', 'auto follows the season');
  assert.equal(pickDecor(catalog, { chosen: 'gone', now: day(3, 1) }).name, 'mine', 'a removed theme falls back to auto');
  assert.equal(pickDecor(catalog, { asked: 'halloween', chosen: 'none', now: day(3, 1) }).name, 'halloween');
});

test('decor: two seasons on the same day, the first by name wins', () => {
  const themes = [
    { name: 'autumn', season: { from: [10, 1], to: [11, 30] } },
    { name: 'halloween', season: { from: [10, 26], to: [10, 31] } },
  ];
  assert.equal(pickDecor({ themes, fallback: null }, { now: day(10, 28) }).name, 'autumn');
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
    nodate: { 'theme.json': { label: 'No date', icon: '❓', season: { from: [2, 30], to: [3, 1] } }, 'theme.css': '' },
    Upper: { 'theme.json': { label: 'Upper', icon: '❓' }, 'theme.css': '' },
  });
  const { themes, problems } = await listThemes(dir);

  assert.deepEqual(themes, [
    { name: 'halloween', label: 'Halloween', icon: '🎃', season: { from: [10, 26], to: [10, 31] }, script: true },
    { name: 'mine', label: 'Mine', icon: '🌿', season: null, script: false },
  ]);
  assert.equal(problems.length, 5);
  assert.ok(problems.some(problem => problem.startsWith('nodate:')), 'February 30 does not exist');
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

test('themes: each shipped theme.js registers hooks that draw', async () => {
  const dir = path.join(__dirname, '..', 'public', 'themes');
  const { themes } = await listThemes(dir);
  for (const { name } of themes.filter(theme => theme.script)) {
    let registered = null;
    const PRRadarTheme = { register: definition => { registered = definition; }, stars };
    vm.runInNewContext(await fs.readFile(path.join(dir, name, 'theme.js'), 'utf8'), { PRRadarTheme });
    assert.ok(registered, `${name} registers`);
    for (const hook of ['front', 'back']) {
      if (registered[hook]) assert.equal(typeof registered[hook](), 'string', `${name} ${hook}()`);
    }
    if (registered.ambient) {
      assert.equal(typeof registered.ambient, 'function', `${name} ambient`);
      assert.ok(Array.isArray(registered.every) && registered.every.length === 2, `${name} every`);
    }
  }
});

test('new-theme: scaffolds a folder the server accepts, and never overwrites one', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-radar-new-theme-'));
  await createTheme('deep-sea', { icon: '🐙', dir, shippedDir: path.join(__dirname, '..', 'public', 'themes') });
  const { themes, problems } = await listThemes(dir);
  assert.deepEqual(problems, []);
  assert.deepEqual(themes, [{ name: 'deep-sea', label: 'Deep Sea', icon: '🐙', season: null, script: true }]);
  await assert.rejects(createTheme('deep-sea', { dir }), /already exists/);
  await assert.rejects(createTheme('Bad Name', { dir }), /lowercase/);
  await assert.rejects(createTheme('halloween', { dir }), /shipped theme/);
});

test('themes: custom-themes join the shipped ones, which keep their name', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-radar-custom-'));
  const shipped = path.join(root, 'shipped');
  const custom = path.join(root, 'custom');
  await createTheme('zeta', { dir: shipped, shippedDir: root });
  await createTheme('alpha', { dir: custom, shippedDir: root });
  await createTheme('zeta', { dir: custom, shippedDir: root });
  const { themes, problems } = await listAllThemes(shipped, custom);
  assert.deepEqual(themes.map(theme => [theme.name, Boolean(theme.custom)]), [['alpha', true], ['zeta', false]]);
  assert.match(problems.join('\n'), /custom-themes\/zeta: a shipped theme has this name/);
  assert.deepEqual(await listAllThemes(shipped, path.join(root, 'missing')).then(r => r.problems), []);
});

test('new-theme: a generated theme is written where the server finds it, a failed one leaves nothing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-radar-generate-'));
  const answer = '```css\n.cafe-x { color: red; }\n```\n```js\nPRRadarTheme.register({});\n```';
  let prompt = '';
  const name = await generateTheme(
    { label: 'Café Noir', icon: '☕', description: 'a warm coffee shop' },
    { dir, claude: async text => { prompt = text; return answer; } },
  );
  assert.equal(name, 'cafe-noir');
  assert.match(prompt, /a warm coffee shop/);
  assert.match(prompt, /"cafe-"/);
  assert.equal(await fs.readFile(path.join(dir, name, 'theme.css'), 'utf8'), '.cafe-x { color: red; }\n');
  const { themes, problems } = await listThemes(dir);
  assert.deepEqual([problems, themes.map(theme => [theme.name, theme.label, theme.icon])], [[], [['cafe-noir', 'Café Noir', '☕']]]);

  await assert.rejects(
    generateTheme({ label: 'Broken', description: 'x' }, { dir, claude: async () => '```css\na{}\n```\n```js\nfunction (\n```' }),
    /does not parse/,
  );
  await assert.rejects(fs.access(path.join(dir, 'broken')), 'a failed generation removes its folder');
  await assert.rejects(generateTheme({ label: '', description: 'x' }, { dir, claude: async () => answer }), /name/);
});

test('new-theme: a generated theme reaching the network is refused', () => {
  const wrap = (css, js) => `\`\`\`css\n${css}\n\`\`\`\n\`\`\`js\n${js}\n\`\`\``;
  assert.throws(() => parseGenerated(wrap('a{}', 'fetch("https://x")')), /network/);
  assert.throws(() => parseGenerated(wrap('@import "x.css";', '1')), /network/);
  assert.throws(() => parseGenerated(wrap('a{background:url(//x/y.png)}', '1')), /network/);
  assert.throws(() => parseGenerated('just prose'), /css and a js block/);
});

test('new-theme: removing a theme deletes its folder, and only a theme folder in that directory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-radar-remove-'));
  const dir = path.join(root, 'custom');
  await createTheme('gone', { dir, shippedDir: root });
  await fs.writeFile(path.join(root, 'keep.txt'), 'x');
  await removeTheme('gone', { dir });
  await assert.rejects(fs.access(path.join(dir, 'gone')));
  await assert.rejects(removeTheme('gone', { dir }), /no such theme/);
  await assert.rejects(removeTheme('..', { dir }), /no such theme/);
  await assert.rejects(removeTheme('../keep.txt', { dir }), /no such theme/);
  await fs.access(path.join(root, 'keep.txt'));
});
