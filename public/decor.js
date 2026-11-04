// Which theme the page wears: one asked in the address, a seasonal one within its dates, or the
// PR_RADAR_THEME one. Loaded by the page as a global, and by the tests as a module.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PRRadarDecor = api;
})(this, () => {
  const compare = (a, b) => a[0] - b[0] || a[1] - b[1];

  // A window may run over the new year: December 20 to January 5.
  function inSeason({ from, to }, now) {
    const day = [now.getMonth() + 1, now.getDate()];
    return compare(from, to) <= 0
      ? compare(day, from) >= 0 && compare(day, to) <= 0
      : compare(day, from) >= 0 || compare(day, to) <= 0;
  }

  function pickDecor({ themes, fallback }, { asked = null, now = new Date() } = {}) {
    if (asked) return themes.find(theme => theme.name === asked) ?? null;
    return themes.find(theme => theme.season && inSeason(theme.season, now))
      ?? themes.find(theme => theme.name === fallback)
      ?? null;
  }

  return { inSeason, pickDecor };
});
