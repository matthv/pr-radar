// Whether the update banner names a release or only counts commits. Loaded by the page as a
// global, and by the tests as a module.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PRRadarVersions = api;
})(this, () => {
  // Commits merged after a release without a new one leave both sides on the same tag: that
  // is no newer version, only commits behind.
  function newerRelease(update) {
    const latest = update?.latestVersion;
    if (!latest || latest === update.version) return null;
    return { latest, from: update.version || null, notesUrl: update.releasesUrl || null };
  }

  return { newerRelease };
});
