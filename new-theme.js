'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { NAME_RE } = require('./themes');

const THEMES_DIR = path.join(__dirname, 'custom-themes');
const SHIPPED_DIR = path.join(__dirname, 'public', 'themes');

const css = prefix => `/* Loaded only while this theme is worn. Never change the board's state colours
   (indigo, amber, green, red): dress the header, the logo, the empty states and the background.
   Full guide: public/themes/README.md */

:root { --${prefix}-accent: #0ea5e9; --bg-accent: color-mix(in srgb, var(--${prefix}-accent) 18%, transparent); }
:root[data-theme="dark"] { --${prefix}-accent: #38bdf8; }

.brand > span::after { content: " ✦"; color: var(--${prefix}-accent); }
.logo .blip { fill: var(--${prefix}-accent); }

.${prefix}-star {
  position: absolute; left: 0; top: 0; width: var(--s); height: var(--s);
  border-radius: 50%; background: var(--${prefix}-accent); opacity: .35;
}

@media (prefers-reduced-motion: no-preference) {
  .${prefix}-star.twinkle { animation: ${prefix}-twinkle var(--d) ease-in-out var(--delay) infinite; }
  @keyframes ${prefix}-twinkle { 50% { opacity: .9; } }
}
`;

const js = prefix => `'use strict';

// Optional: delete this file if CSS is enough. Guide: public/themes/README.md
(() => {
  PRRadarTheme.register({
    back: () => PRRadarTheme.stars({ seed: 7, count: 60, className: '${prefix}-star' }),
    ambient: () => {},
    every: [15_000, 30_000],
  });
})();
`;

const prefixOf = name => name.replace(/-/g, '').replace(/^(?=\d)/, 't').slice(0, 4);

const slugOf = label => label.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 40).replace(/-+$/, '');

// The page translates `reason`; the message is what the log and the CLI show.
const fail = (reason, message, params = {}) => Object.assign(new Error(message), { reason, params });

async function createTheme(name, { label, icon = '🎨', dir = THEMES_DIR, shippedDir = SHIPPED_DIR } = {}) {
  if (!NAME_RE.test(name ?? '')) throw fail('badName', 'the name must be lowercase letters, digits and dashes');
  if (name === 'none') throw fail('reserved', '"none" means no theme, pick another name');
  if (await fs.access(path.join(shippedDir, name)).then(() => true, () => false)) {
    throw fail('shipped', `${name} is a shipped theme, pick another name`, { name });
  }
  const folder = path.join(dir, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(folder).catch(error => {
    throw error.code === 'EEXIST' ? fail('exists', `${folder} already exists`, { name }) : error;
  });
  const prefix = prefixOf(name);
  const title = label || name.replace(/(^|-)(\w)/g, (_, dash, c) => (dash ? ' ' : '') + c.toUpperCase());
  await fs.writeFile(path.join(folder, 'theme.json'), `${JSON.stringify({ label: title, icon }, null, 2)}\n`);
  await fs.writeFile(path.join(folder, 'theme.css'), css(prefix));
  await fs.writeFile(path.join(folder, 'theme.js'), js(prefix));
  return folder;
}

// A lint for the obvious slips, not the boundary: the page's Content-Security-Policy is what keeps
// a theme from reaching the network.
const NETWORK = /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|\bimport\s*\(|importScripts|@import|url\(\s*['"]?(https?:)?\/\/|<script|document\.cookie|localStorage/i;

function parseGenerated(text) {
  const block = lang => new RegExp('```' + lang + '\\s*\\n([\\s\\S]*?)```', 'i').exec(text)?.[1].trim();
  const css = block('css');
  const js = block('(?:js|javascript)');
  if (!css || !js) throw fail('noBlocks', 'Claude did not answer with a css and a js block');
  const found = NETWORK.exec(css) ?? NETWORK.exec(js);
  if (found) throw fail('network', `the generated theme reaches the network or the page storage (${found[0]}), refused`, { match: found[0] });
  try {
    new vm.Script(js);
  } catch (error) {
    throw fail('parse', `the generated theme.js does not parse (${error.message})`, { error: error.message });
  }
  return { css: `${css}\n`, js: `${js}\n` };
}

async function generationPrompt({ label, icon, description, prefix }) {
  const read = file => fs.readFile(path.join(SHIPPED_DIR, file), 'utf8');
  const [guide, exampleCss, exampleJs] = await Promise.all([
    read('README.md'), read('masseffect/theme.css'), read('masseffect/theme.js'),
  ]);
  return `You write a decorative theme for PR Radar, a local dashboard of GitHub pull requests.

Theme: "${label}" ${icon}
What the user wants: ${description}

Rules, beyond the guide below:
- Prefix every class, custom property and keyframes name with "${prefix}-".
- Original artwork only: inline SVG or CSS shapes you draw yourself, no copyrighted characters'
  likeness traced from a source, no images, no fonts, no URL of any kind, no network access, no storage.
- Light and dark: colours on :root and again on :root[data-theme="dark"].
- Every animation under @media (prefers-reduced-motion: no-preference).
- Never change the board's state colours. Keep front() small and at the edges; large art goes in back().
- theme.js must call PRRadarTheme.register exactly once, inside an IIFE, like the example.

Answer with exactly two fenced blocks and nothing else: first \`\`\`css, then \`\`\`js.

--- The theme guide (public/themes/README.md) ---
${guide}

--- A shipped theme, as an example of the expected quality and shape: theme.css ---
${exampleCss}

--- Its theme.js ---
${exampleJs}`;
}

const exists = file => fs.access(file).then(() => true, () => false);

// Drawn in a dot folder the theme list skips, then moved in whole: a server stopped mid-way
// leaves no half theme in the menu, nor a name taken by one. One folder per run, so two
// generations of the same name never share one.
async function generateTheme({ label, icon, description }, { dir = THEMES_DIR, claude = require('./digest').claude } = {}) {
  const cleanLabel = String(label ?? '').trim().slice(0, 40);
  const cleanIcon = String(icon ?? '').trim().slice(0, 8) || '🎨';
  const cleanDescription = String(description ?? '').trim().slice(0, 1000);
  const name = slugOf(cleanLabel);
  if (!name) throw fail('noName', 'give the theme a name');
  if (!cleanDescription) throw fail('noDescription', 'describe the theme');
  const target = path.join(dir, name);
  if (await exists(target)) throw fail('exists', `${target} already exists`, { name });
  await fs.mkdir(path.join(dir, '.generating'), { recursive: true });
  const staging = await fs.mkdtemp(path.join(dir, '.generating', `${name}-`));
  try {
    const folder = await createTheme(name, { label: cleanLabel, icon: cleanIcon, dir: staging });
    const prompt = await generationPrompt({ label: cleanLabel, icon: cleanIcon, description: cleanDescription, prefix: prefixOf(name) });
    const { css, js } = parseGenerated(await claude(prompt, GENERATE_ARGS, undefined, GENERATE_TIMEOUT_MS));
    await fs.writeFile(path.join(folder, 'theme.css'), css);
    await fs.writeFile(path.join(folder, 'theme.js'), js);
    if (await exists(target)) throw fail('exists', `${target} already exists`, { name });
    await fs.rename(folder, target);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
  return name;
}

async function removeTheme(name, { dir = THEMES_DIR } = {}) {
  if (!NAME_RE.test(name ?? '')) throw fail('missing', 'no such theme');
  const folder = path.join(dir, name);
  if (!(await fs.stat(folder).then(stat => stat.isDirectory(), () => false))) throw fail('missing', 'no such theme');
  await fs.rm(folder, { recursive: true });
}

// The hub closes on a frame over 16 KiB; the margin covers the envelope and the login.
const OFFER_MAX_BYTES = 15 * 1024;
const LABEL_MAX = 60;
const ICON_MAX = 16;

async function readForOffer(name, { dir = THEMES_DIR } = {}) {
  if (!NAME_RE.test(name ?? '') || name.length > 40) throw fail('missing', 'no such theme');
  const folder = path.join(dir, name);
  // Only a file that is not there means no theme, or no script; any other failure says so.
  const read = (file, { optional = false } = {}) => fs.readFile(path.join(folder, file), 'utf8').catch(error => {
    if (error.code === 'ENOENT') {
      if (optional) return null;
      throw fail('missing', 'no such theme');
    }
    throw fail('unreadable', `${name}/${file} cannot be read (${error.message})`, { name, file });
  });
  let meta;
  try {
    meta = JSON.parse(await read('theme.json'));
  } catch (error) {
    if (error.reason) throw error;
    throw fail('unreadable', `${name}/theme.json is not valid JSON (${error.message})`, { name, file: 'theme.json' });
  }
  const css = await read('theme.css');
  const js = await read('theme.js', { optional: true });
  const theme = {
    name,
    label: String(meta.label ?? name).trim().slice(0, LABEL_MAX),
    icon: String(meta.icon ?? '🎨').trim().slice(0, ICON_MAX),
    css,
    js,
  };
  if (Buffer.byteLength(JSON.stringify(theme)) > OFFER_MAX_BYTES) throw fail('tooBig', `${name} is too big to send`, { name });
  return theme;
}

const asLogin = login => String(login ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 39);

// What came over the hub is checked like a generated theme, then lands next to the others,
// under a name of its own when a shipped or a custom theme already has it.
async function installTheme(theme, { from, dir = THEMES_DIR, shippedDir = SHIPPED_DIR } = {}) {
  const name = String(theme?.name ?? '');
  if (!NAME_RE.test(name) || name.length > 40 || name === 'none') throw fail('badOffer', 'the offered theme has no valid name');
  // The protocol counts an absent js as null.
  const script = theme.js ?? null;
  if (typeof theme.css !== 'string' || (script !== null && typeof script !== 'string')) throw fail('badOffer', 'the offered theme is malformed');
  const label = String(theme.label ?? '').trim().slice(0, LABEL_MAX) || name;
  const icon = String(theme.icon ?? '').trim().slice(0, ICON_MAX) || '🎨';
  const found = NETWORK.exec(theme.css) ?? (script ? NETWORK.exec(script) : null);
  if (found) throw fail('network', `the offered theme reaches the network or the page storage (${found[0]}), refused`, { match: found[0] });
  if (script) {
    try {
      new vm.Script(script);
    } catch (error) {
      throw fail('parse', `the offered theme.js does not parse (${error.message})`, { error: error.message });
    }
  }
  const taken = async candidate => candidate === 'none' || await exists(path.join(dir, candidate)) || await exists(path.join(shippedDir, candidate));
  const base = (await taken(name)) && asLogin(from) ? `${name}-${asLogin(from)}`.slice(0, 40).replace(/-+$/, '') : name;
  let target = base;
  for (let n = 2; await taken(target); n += 1) target = `${base.slice(0, 37)}-${n}`;
  await fs.mkdir(path.join(dir, '.generating'), { recursive: true });
  const staging = await fs.mkdtemp(path.join(dir, '.generating', `${target}-`));
  try {
    await fs.writeFile(path.join(staging, 'theme.json'), `${JSON.stringify({ label, icon, ...(from ? { from: String(from) } : {}) }, null, 2)}\n`);
    await fs.writeFile(path.join(staging, 'theme.css'), theme.css);
    if (script) await fs.writeFile(path.join(staging, 'theme.js'), script);
    if (await taken(target)) throw fail('exists', `${target} already exists`, { name: target });
    await fs.rename(staging, path.join(dir, target));
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
  return target;
}

const GENERATE_TIMEOUT_MS = 300_000;

const GENERATE_ARGS = [
  '-p', '--model', 'sonnet',
  '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
  '--disallowedTools', '*',
  '--no-session-persistence',
];

if (require.main === module) {
  const [name, label, icon] = process.argv.slice(2);
  createTheme(name, { label, icon }).then(folder => {
    console.log(`Created ${path.relative(process.cwd(), folder)}/ (theme.json, theme.css, theme.js).`);
    console.log(`Reload the page and pick it from the theme menu in the header, or preview it with ?theme=${name}.`);
  }, error => {
    console.error(`new-theme: ${error.message}`);
    console.error('usage: npm run new-theme -- <name> ["Label"] [icon]');
    process.exitCode = 1;
  });
}

module.exports = { createTheme, generateTheme, removeTheme, readForOffer, installTheme, parseGenerated, slugOf, prefixOf };
