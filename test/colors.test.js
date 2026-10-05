'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { hexToOklch, toTint, nearState, PRESETS, MIN_CHROMA, MAX_CHROMA } = require('../public/colors');

const near = (actual, expected, tolerance) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} not within ${tolerance} of ${expected}`);

test('colors: sRGB to OKLCH on known values', () => {
  const red = hexToOklch('#ff0000');
  near(red.l, 0.628, 0.002);
  near(red.c, 0.258, 0.002);
  near(red.h, 29.2, 0.3);

  const blue = hexToOklch('#0000ff');
  near(blue.l, 0.452, 0.002);
  near(blue.h, 264.1, 0.3);

  near(hexToOklch('#808080').c, 0, 0.0005);
  assert.throws(() => hexToOklch('blue'), /not a #rrggbb colour/);
});

test('colors: a tint keeps the hue and caps the intensity, never the lightness', () => {
  const navy = toTint('#0b1f4d');
  near(navy.h, hexToOklch('#0b1f4d').h, 0.1);
  assert.equal(navy.hex, '#0b1f4d');
  assert.deepEqual(Object.keys(navy).sort(), ['c', 'h', 'hex']);

  assert.equal(toTint('#808080').c, MIN_CHROMA, 'a grey still gets a visible tint');
  assert.equal(toTint('#ff00ff').c, MAX_CHROMA, 'a fluorescent colour is calmed down');
});

test('colors: no ready-made hue reads as a state', () => {
  for (const preset of PRESETS) assert.equal(nearState(preset), null, preset.id);
});

test('colors: a hue close to a state is flagged, a distant one or a grey is not', () => {
  assert.equal(nearState(toTint('#d93a2b')), 'rose');
  assert.equal(nearState(toTint('#c98a12')), 'amber');
  assert.equal(nearState(toTint('#1f9a6f')), 'emerald');
  assert.equal(nearState(toTint('#5b4fe0')), 'indigo');
  assert.equal(nearState(toTint('#1e9aa0')), null, 'teal');
  assert.equal(nearState(toTint('#7a7a7a')), null, 'grey');
});
