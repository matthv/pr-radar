'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ownerScope, parseExtraRepos, SEARCH_LIMIT } = require('../github');

test('extra repos: a comma list, blanks and spaces ignored', () => {
  assert.deepEqual(parseExtraRepos(' matthv/pr-radar, ,matthv/gitdeck '), ['matthv/pr-radar', 'matthv/gitdeck']);
  assert.deepEqual(parseExtraRepos(undefined), []);
  assert.deepEqual(parseExtraRepos(''), []);
});

test('extra repos: each one joins the org in the search scope', () => {
  assert.equal(ownerScope('ForestAdmin'), 'org:ForestAdmin');
  assert.equal(
    ownerScope('ForestAdmin', ['matthv/pr-radar', 'matthv/gitdeck']),
    'org:ForestAdmin repo:matthv/pr-radar repo:matthv/gitdeck',
  );
});

test('extra repos: a value that is not owner/name is refused, not searched', () => {
  assert.throws(() => ownerScope('ForestAdmin', ['pr-radar']), /not an owner\/name: pr-radar/);
  assert.throws(() => ownerScope('ForestAdmin', ['matthv/pr-radar is:merged']), /not an owner\/name/);
});

test('extra repos: too many for one GitHub search is refused up front', () => {
  const many = Array.from({ length: 12 }, (_, i) => `someone/a-rather-long-repository-${i}`);
  assert.throws(() => ownerScope('ForestAdmin', many), new RegExp(`${SEARCH_LIMIT} characters`));
  assert.doesNotThrow(() => ownerScope('ForestAdmin', many.slice(0, 3)));
});
