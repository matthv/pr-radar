'use strict';

const { engines } = require('./package.json');

const MINIMUM = engines.node.replace(/^>=\s*/, '');

const parts = version => version.replace(/^v/, '').split('.').map(Number);

function tooOld(version, minimum = MINIMUM) {
  const have = parts(version);
  const need = parts(minimum);
  for (let i = 0; i < need.length; i += 1) {
    if ((have[i] ?? 0) !== need[i]) return (have[i] ?? 0) < need[i];
  }
  return false;
}

module.exports = { MINIMUM, tooOld };
