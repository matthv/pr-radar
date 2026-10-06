// A repo's colour, kept as a hue and an intensity only: the lightness of the chip's
// background and text comes from the theme, so any colour picked stays readable in both.
// Loaded by the page as a global, and by the tests as a module.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PRRadarColors = api;
})(this, () => {
  const MIN_CHROMA = 0.03;
  const MAX_CHROMA = 0.16;

  // The board's own state colours, from their light-theme tokens: a repo too close to one
  // would read as that state.
  const STATES = {
    indigo: '#5a51d4',
    amber: '#a8710a',
    emerald: '#0f7f61',
    rose: '#c04440',
  };
  const NEAR_DEGREES = 18;
  // Below this a colour is close to grey, and its hue no longer reads as anything.
  const VISIBLE_CHROMA = 0.05;

  const linear = channel => {
    const v = channel / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };

  function hexToOklch(hex) {
    const match = String(hex).trim().match(/^#?([0-9a-f]{6})$/i);
    if (!match) throw new Error(`not a #rrggbb colour: ${hex}`);
    const n = parseInt(match[1], 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(linear);

    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

    const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
    const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;

    const c = Math.hypot(A, B);
    const h = (Math.atan2(B, A) * 180 / Math.PI + 360) % 360;
    return { l: L, c, h };
  }

  const round = (value, digits) => Number(value.toFixed(digits));

  function toTint(hex) {
    const { c, h } = hexToOklch(hex);
    return { h: round(h, 1), c: round(Math.min(MAX_CHROMA, Math.max(MIN_CHROMA, c)), 3), hex: String(hex).toLowerCase() };
  }

  const hueGap = (a, b) => {
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  };

  const STATE_HUES = Object.fromEntries(Object.entries(STATES).map(([name, hex]) => [name, hexToOklch(hex).h]));

  function nearState({ h, c }) {
    if (c < VISIBLE_CHROMA) return null;
    let closest = null;
    for (const [name, hue] of Object.entries(STATE_HUES)) {
      const gap = hueGap(h, hue);
      if (gap <= NEAR_DEGREES && (!closest || gap < closest.gap)) closest = { name, gap };
    }
    return closest?.name ?? null;
  }

  // Ready-made hues, each kept clear of the state colours (a test holds them to it).
  const PRESETS = [
    { id: 'blue', h: 250, c: 0.13 },
    { id: 'slate', h: 255, c: 0.04 },
    { id: 'plum', h: 320, c: 0.12 },
    { id: 'magenta', h: 345, c: 0.14 },
    { id: 'coral', h: 45, c: 0.13 },
    { id: 'ochre', h: 95, c: 0.11 },
    { id: 'olive', h: 125, c: 0.11 },
    { id: 'teal', h: 195, c: 0.1 },
  ];

  return { hexToOklch, toTint, nearState, PRESETS, STATE_HUES, MIN_CHROMA, MAX_CHROMA };
});
