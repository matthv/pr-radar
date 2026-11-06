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

const prefixOf = name => name.replace(/-/g, '').slice(0, 4);

const slugOf = label => label.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

async function createTheme(name, { label, icon = '🎨', dir = THEMES_DIR, shippedDir = SHIPPED_DIR } = {}) {
  if (!NAME_RE.test(name ?? '')) throw new Error('the name must be lowercase letters, digits and dashes');
  if (await fs.access(path.join(shippedDir, name)).then(() => true, () => false)) {
    throw new Error(`${name} is a shipped theme, pick another name`);
  }
  const folder = path.join(dir, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(folder).catch(error => {
    throw new Error(error.code === 'EEXIST' ? `${folder} already exists` : error.message);
  });
  const prefix = prefixOf(name);
  const title = label || name.replace(/(^|-)(\w)/g, (_, dash, c) => (dash ? ' ' : '') + c.toUpperCase());
  await fs.writeFile(path.join(folder, 'theme.json'), `${JSON.stringify({ label: title, icon }, null, 2)}\n`);
  await fs.writeFile(path.join(folder, 'theme.css'), css(prefix));
  await fs.writeFile(path.join(folder, 'theme.js'), js(prefix));
  return folder;
}

// The page runs theme.js and loads theme.css as they are: whatever the model wrote must stay
// on this machine, so anything reaching the network is refused rather than written.
const NETWORK = /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|\bimport\s*\(|importScripts|@import|url\(\s*['"]?(https?:)?\/\/|<script|document\.cookie|localStorage/i;

function parseGenerated(text) {
  const block = lang => new RegExp('```' + lang + '\\s*\\n([\\s\\S]*?)```').exec(text)?.[1].trim();
  const css = block('css');
  const js = block('(?:js|javascript)');
  if (!css || !js) throw new Error('Claude did not answer with a css and a js block');
  if (NETWORK.test(css) || NETWORK.test(js)) throw new Error('the generated theme reaches the network or the page storage, refused');
  try {
    new vm.Script(js);
  } catch (error) {
    throw new Error(`the generated theme.js does not parse (${error.message})`);
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

async function generateTheme({ label, icon, description }, { dir = THEMES_DIR, claude = require('./digest').claude } = {}) {
  const cleanLabel = String(label ?? '').trim().slice(0, 40);
  const cleanIcon = String(icon ?? '').trim().slice(0, 8) || '🎨';
  const cleanDescription = String(description ?? '').trim().slice(0, 1000);
  const name = slugOf(cleanLabel);
  if (!name) throw new Error('give the theme a name');
  if (!cleanDescription) throw new Error('describe the theme');
  const folder = await createTheme(name, { label: cleanLabel, icon: cleanIcon, dir });
  try {
    const prompt = await generationPrompt({ label: cleanLabel, icon: cleanIcon, description: cleanDescription, prefix: prefixOf(name) });
    const { css, js } = parseGenerated(await claude(prompt, GENERATE_ARGS));
    await fs.writeFile(path.join(folder, 'theme.css'), css);
    await fs.writeFile(path.join(folder, 'theme.js'), js);
  } catch (error) {
    await fs.rm(folder, { recursive: true, force: true });
    throw error;
  }
  return name;
}

async function removeTheme(name, { dir = THEMES_DIR } = {}) {
  if (!NAME_RE.test(name ?? '')) throw new Error('no such theme');
  const folder = path.join(dir, name);
  if (!(await fs.stat(folder).then(stat => stat.isDirectory(), () => false))) throw new Error('no such theme');
  await fs.rm(folder, { recursive: true });
}

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

module.exports = { createTheme, generateTheme, removeTheme, parseGenerated, slugOf };
