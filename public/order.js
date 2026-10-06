(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PRRadarOrder = api;
})(this, () => {
  const DEFAULTS = {
    mine: ['action', 'ready', 'waiting', 'merged', 'idle'],
    reviews: ['action', 'waiting', 'merged', 'idle'],
  };

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

  return { DEFAULTS, normalize, move, isDefault };
});
