# Themes

One folder per theme, named after it (lowercase letters, digits and dashes):

```
public/themes/<name>/
  theme.json   required: its label, its icon, and its dates if it is seasonal
  theme.css    required: loaded only while the theme is worn
  theme.js     optional: decorations drawn by script, and an event played now and then
```

Which one is worn: a seasonal theme within its dates, otherwise the one named in
`PR_RADAR_THEME`, otherwise none. `?theme=<name>` in the address shows any, whatever the date;
an unknown name falls back to that rule. The 🎨 line at start-up says which one is set, names
any folder left out and why, and any two seasons sharing a day (the first by name wins).

## theme.json

```json
{
  "label": "Halloween",
  "icon": "🎃",
  "season": { "from": [10, 26], "to": [10, 31] }
}
```

- `label`: shown in the button's tooltip.
- `icon`: the header button, which turns the theme off and on again.
- `season` (optional): `[month, day]`, both days included. A window may run over the new
  year (`[12, 20]` to `[1, 5]`). Without it, the theme is only worn through `PR_RADAR_THEME`.
  Pick days no other season uses.

## theme.css

Plain CSS, no prefix needed: the stylesheet is only loaded while the theme is worn, and
switched off with the button.

- **Never change the board's state colours** (indigo, amber, green, red): they say what a card
  needs. Dress the header, the logo, the empty states and the background.
- Define your colours on `:root` for the light theme, and again on `:root[data-theme="dark"]`.
- Put every animation under `@media (prefers-reduced-motion: no-preference)`.
- Prefix your own classes after the theme (`hw-` for Halloween) so two themes never clash.
- Useful hooks: `--bg-accent` (the header glow), `header`, `.logo`, `.logo .blip`,
  `#sweepGrad stop`, `.brand > span::after` (a mark after the title),
  `.empty:not(.kb-cell)::before` (empty columns), `.card:hover`.

## theme.js

Registers what CSS alone cannot draw:

```js
'use strict';

(() => {
  PRRadarTheme.register({
    front: () => '<svg class="my-corner">…</svg>',
    back: () => '<i class="my-star"></i>',
    ambient: ({ front, back }) => { /* play the event once */ },
    every: [15_000, 30_000],
  });
})();
```

- `front()`: HTML laid over the page, under the header's menus. Keep it to corners and edges, it
  covers what is beneath it.
- `back()`: HTML behind the cards, seen only in the gaps between them.
- `ambient({ front, back })`: called a few seconds after load, then every `every` milliseconds
  (a random delay within the range). It gets the two layers to draw into. Never called when the
  system asks for reduced motion.
- `PRRadarTheme.stars({ seed, count, className })`: a starfield as HTML, the same on every load
  for a given seed. Each star is an `<i class="<className>">`, with `twinkle` on about a third,
  and `--s`, `--d`, `--delay` for its size, twinkle duration and phase.

Everything is optional. Nothing in a theme takes a click: both layers ignore the pointer.

## A personal theme

Create its folder here and set `PR_RADAR_THEME=<name>` in `.env`. An untracked folder does not
stop the page's **Update** button from pulling. Pick a name no shipped theme uses, or a later
update adding one with the same name will refuse to pull until you rename yours.
