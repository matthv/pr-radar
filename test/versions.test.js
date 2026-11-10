'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { newerRelease } = require('../public/versions');

const NOTES = 'https://github.com/matthv/pr-radar/releases';

test('newerRelease: a newer tag is named, with the one that runs and the notes', () => {
  assert.deepEqual(
    newerRelease({ behind: 5, version: 'v1.2.0', latestVersion: 'v1.4.0', releasesUrl: NOTES }),
    { latest: 'v1.4.0', from: 'v1.2.0', notesUrl: NOTES },
  );
});

test('newerRelease: commits after a release without a new one are no newer version', () => {
  assert.equal(newerRelease({ behind: 3, version: 'v1.4.0', latestVersion: 'v1.4.0', releasesUrl: NOTES }), null);
});

test('newerRelease: no release out yet, or no update data, names nothing', () => {
  assert.equal(newerRelease({ behind: 3, version: null, latestVersion: null }), null);
  assert.equal(newerRelease(null), null);
});

test('newerRelease: a clone from before the first release, or off GitHub, still gets the name', () => {
  assert.deepEqual(newerRelease({ behind: 9, version: null, latestVersion: 'v1.0.0', releasesUrl: NOTES }), { latest: 'v1.0.0', from: null, notesUrl: NOTES });
  assert.deepEqual(newerRelease({ behind: 1, version: 'v1.0.0', latestVersion: 'v1.1.0', releasesUrl: null }), { latest: 'v1.1.0', from: 'v1.0.0', notesUrl: null });
});
