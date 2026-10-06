(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PRRadarOrder = api;
})(this, () => {
  // Ordered by what each state asks of you: your move, then waiting on someone, then a
  // merge to glance at, then nothing. A merge sat second before, which ranked a published
  // release above a PR actually blocked on a reviewer.
  // "Ready to merge" sits right under "to act": it is a move of mine too, and below the
  // merged group it read as already done.
  const DEFAULTS = {
    mine: ['action', 'ready', 'waiting', 'merged', 'idle'],
    reviews: ['action', 'waiting', 'merged', 'idle'],
  };

  function readMap(raw) {
    try {
      const map = JSON.parse(raw ?? '{}');
      return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
    } catch {
      return {};
    }
  }

  function normalize(saved, defaults) {
    const kept = Array.isArray(saved) ? [...new Set(saved.filter(bucket => defaults.includes(bucket)))] : [];
    for (const bucket of defaults) {
      if (kept.includes(bucket)) continue;
      const keptPredecessors = defaults.slice(0, defaults.indexOf(bucket)).filter(other => kept.includes(other));
      const insertAt = keptPredecessors.length ? kept.indexOf(keptPredecessors[keptPredecessors.length - 1]) + 1 : 0;
      kept.splice(insertAt, 0, bucket);
    }
    return kept;
  }

  function move(order, bucket, target, after) {
    if (bucket === target) return order;
    const rest = order.filter(entry => entry !== bucket);
    const at = rest.indexOf(target);
    if (at === -1) return order;
    rest.splice(after ? at + 1 : at, 0, bucket);
    return rest;
  }

  function isDefault(order, defaults) {
    return order.length === defaults.length && order.every((bucket, index) => bucket === defaults[index]);
  }

  return { DEFAULTS, readMap, normalize, move, isDefault };
});
