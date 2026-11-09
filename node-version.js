'use strict';

const { engines } = require('./package.json');

const MINIMUM = engines.node.replace(/^>=\s*/, '');

// A range such as `^22.4` would parse to NaN, and every comparison with NaN says "not too old".
if (!/^\d+(\.\d+){0,2}$/.test(MINIMUM)) {
  throw new Error(`engines.node in package.json must read ">=X.Y[.Z]", got "${engines.node}"`);
}

const parts = version => version.replace(/^v/, '').split('.').map(part => Number.parseInt(part, 10) || 0);

function tooOld(version, minimum = MINIMUM) {
  const have = parts(version);
  const need = parts(minimum);
  for (let i = 0; i < need.length; i += 1) {
    if ((have[i] ?? 0) !== need[i]) return (have[i] ?? 0) < need[i];
  }
  return false;
}

module.exports = { MINIMUM, tooOld };
