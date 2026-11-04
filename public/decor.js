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

  // The year the current window opened: December 20 to January 5 is one season, not two.
  function seasonYear(season, now) {
    return wraps(season) && compare(today(now), season.to) <= 0 ? now.getFullYear() - 1 : now.getFullYear();
  }

  function pickDecor({ themes, fallback }, { asked = null, now = new Date() } = {}) {
    return themes.find(theme => theme.name === asked)
      ?? themes.find(theme => theme.season && inSeason(theme.season, now))
      ?? themes.find(theme => theme.name === fallback)
      ?? null;
  }

  // What is remembered as turned off, per theme: `true` for the default one, the season's year
  // for a seasonal one. The single value the first version kept is read once, then dropped.
  function offKey(theme, now) {
    return theme.season ? seasonYear(theme.season, now) : true;
  }

  function readOff(raw, legacy) {
    let off = {};
    try {
      const parsed = JSON.parse(raw ?? '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) off = parsed;
    } catch {
      off = {};
    }
    const match = /^([a-z0-9][a-z0-9-]*)-(\d{4})$/.exec(legacy ?? '');
    if (match && !(match[1] in off)) off[match[1]] = Number(match[2]);
    return off;
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

  return { inSeason, seasonYear, pickDecor, offKey, readOff, stars };
});
