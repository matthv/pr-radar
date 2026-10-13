(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PRRadarKanban = api;
})(this, () => {
  const AXIS = ['action', 'waiting', 'ready', 'merged', 'idle'];
  const DEFAULT_FOLDS = ['idle'];

  function readFolds(raw) {
    if (raw === null || raw === undefined) return [...DEFAULT_FOLDS];
    try {
      const list = JSON.parse(raw);
      return Array.isArray(list) ? list.filter(entry => typeof entry === 'string') : [...DEFAULT_FOLDS];
    } catch {
      return [...DEFAULT_FOLDS];
    }
  }

  const laneFold = side => `lane:${side}`;

  // A bucket a side never produces keeps an inapplicable cell, so the next columns stay
  // under their own headers.
  function layout({ axis, lanes, focus = null, folds = [] }) {
    const shown = focus ? lanes.filter(lane => lane.side === focus.column) : lanes;
    return {
      columns: axis.map(bucket => ({
        bucket,
        folded: folds.includes(bucket),
        dimmed: Boolean(focus) && focus.bucket !== bucket,
        count: shown.reduce((sum, lane) => sum + lane.prs.filter(pr => pr.bucket === bucket).length, 0),
      })),
      lanes: shown.map(lane => ({
        side: lane.side,
        folded: folds.includes(laneFold(lane.side)),
        total: lane.prs.length,
        cells: axis.map(bucket => ({
          bucket,
          applicable: lane.buckets.includes(bucket),
          prs: lane.prs.filter(pr => pr.bucket === bucket),
        })),
      })),
    };
  }

  function unfold(folds, keys) {
    let changed = false;
    for (const key of keys) {
      const [side, bucket] = key.split(':');
      changed = folds.delete(bucket) || changed;
      changed = folds.delete(laneFold(side)) || changed;
    }
    return changed;
  }

  return { AXIS, DEFAULT_FOLDS, readFolds, laneFold, layout, unfold };
});
