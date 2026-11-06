// Which theme the page wears, and the drawing helpers themes share. Loaded by the page as a
// global, and by the tests as a module.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PRRadarDecor = api;
})(this, () => {
  const compare = (a, b) => a[0] - b[0] || a[1] - b[1];
  const today = now => [now.getMonth() + 1, now.getDate()];
  const wraps = ({ from, to }) => compare(from, to) > 0;

  function inSeason(season, now) {
    const day = today(now);
    return wraps(season)
      ? compare(day, season.from) >= 0 || compare(day, season.to) <= 0
      : compare(day, season.from) >= 0 && compare(day, season.to) <= 0;
  }

  // `chosen` is the header menu's pick: '' (auto: the season, else the default), 'none', or a name.
  function pickDecor({ themes, fallback }, { asked = null, chosen = '', now = new Date() } = {}) {
    const named = name => themes.find(theme => theme.name === name);
    if (named(asked)) return named(asked);
    if (chosen === 'none') return null;
    return named(chosen)
      ?? themes.find(theme => theme.season && inSeason(theme.season, now))
      ?? named(fallback)
      ?? null;
  }

  function mulberry32(seed) {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
  }

  function stars({ seed, count, className }) {
    const random = mulberry32(seed);
    return Array.from({ length: count }, () => {
      const left = (random() * 100).toFixed(1);
      const top = (random() * 100).toFixed(1);
      const size = (1 + random() * 1.6).toFixed(1);
      const twinkle = random() < 0.35;
      const d = (2.5 + random() * 4).toFixed(1);
      const delay = (-random() * 6).toFixed(1);
      return `<i class="${className}${twinkle ? ' twinkle' : ''}" style="left:${left}%;top:${top}%;--s:${size}px;--d:${d}s;--delay:${delay}s"></i>`;
    }).join('');
  }

  return { inSeason, pickDecor, stars };
});
