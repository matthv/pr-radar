'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
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
  const prefix = name.replace(/-/g, '').slice(0, 4);
  const title = label || name.replace(/(^|-)(\w)/g, (_, dash, c) => (dash ? ' ' : '') + c.toUpperCase());
  await fs.writeFile(path.join(folder, 'theme.json'), `${JSON.stringify({ label: title, icon }, null, 2)}\n`);
  await fs.writeFile(path.join(folder, 'theme.css'), css(prefix));
  await fs.writeFile(path.join(folder, 'theme.js'), js(prefix));
  return folder;
}

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

module.exports = { createTheme };
