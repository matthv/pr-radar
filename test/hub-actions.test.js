'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { hubAction } = require('../hub-actions');
const { wizzRef } = require('../hub');

const BOARD = 'https://github.com/ForestAdmin/agent-nodejs/pull/1942';

function setup({ offers = [], offerOnline = true, catalogFails = false, installFails = null } = {}) {
  const calls = [];
  const record = name => (...args) => {
    calls.push([name, ...args]);
    return true;
  };
  let live = [...offers];
  const hub = {
    signIn: record('signIn'),
    decline: async () => calls.push(['decline']),
    setAvailability: record('setAvailability'),
    sendKudos: record('sendKudos'),
    sendWizz: record('sendWizz'),
    offerTheme: (...args) => {
      calls.push(['offerTheme', ...args]);
      return offerOnline;
    },
    peekOffer: id => live.find(offer => offer.id === id) ?? null,
    takeOffer: id => {
      calls.push(['takeOffer', id]);
      live = live.filter(offer => offer.id !== id);
    },
    setTabs: record('setTabs'),
    state: () => ({ status: 'online', wizzes: [], wizzSent: [] }),
  };
  const tabs = [];
  const tabCounter = { beat: (id, hidden) => tabs.push(['beat', id, hidden]), bye: id => tabs.push(['bye', id]), count: () => 1 };
  const deps = {
    hub,
    tabCounter,
    boardUrls: () => [BOARD],
    readForOffer: async name => {
      if (name !== 'foret') throw Object.assign(new Error('no such theme'), { reason: 'missing' });
      return { name: 'foret', label: 'Forêt', icon: '🌲', css: 'a{}', js: null };
    },
    installTheme: async theme => {
      if (installFails) throw Object.assign(new Error(installFails), { reason: installFails === 'disk' ? undefined : installFails });
      return theme.name;
    },
    themeCatalog: async () => {
      if (catalogFails) throw new Error('readdir failed');
      return { themes: [] };
    },
  };
  return { deps, calls, tabs, live: () => live };
}

const sent = (calls, name) => calls.filter(call => call[0] === name);

test('hub route: a nudge only for a PR of the board, a plain wizz always, nothing for a bad login', async () => {
  const t = setup();
  await hubAction({ action: 'wizz', to: 'bexchauveto', pr: BOARD }, t.deps);
  await hubAction({ action: 'wizz', to: 'bexchauveto', pr: 'https://github.com/x/y/pull/1' }, t.deps);
  await hubAction({ action: 'wizz', to: 'bexchauveto' }, t.deps);
  await hubAction({ action: 'wizz', to: ['bexchauveto'] }, t.deps);
  await hubAction({ action: 'wizz', to: 'not a login' }, t.deps);
  await hubAction({ action: 'kudos', to: 'x'.repeat(40) }, t.deps);
  assert.deepEqual(sent(t.calls, 'sendWizz'), [['sendWizz', 'bexchauveto', wizzRef(BOARD)], ['sendWizz', 'bexchauveto', null]]);
  assert.deepEqual(sent(t.calls, 'sendKudos'), []);
});

test('hub route: every request counts the tab, a bye removes it, and the page never sees raw refs', async () => {
  const t = setup();
  const answer = await hubAction({ tabId: 'abcdefgh12', hidden: true }, t.deps);
  await hubAction({ action: 'bye', tabId: 'abcdefgh12' }, t.deps);
  await hubAction({ tabId: ['abcdefgh12'] }, t.deps);
  assert.deepEqual(t.tabs, [['beat', 'abcdefgh12', true], ['bye', 'abcdefgh12'], ['beat', '', false]]);
  assert.equal(sent(t.calls, 'setTabs').length, 3);
  assert.ok(!('wizzSent' in answer.hub));
});

test('hub route: offering a theme says sent, missing, or that the hub is offline', async () => {
  const t = setup();
  assert.equal((await hubAction({ action: 'offerTheme', to: 'bexchauveto', name: 'foret' }, t.deps)).sent, 'foret');
  assert.equal((await hubAction({ action: 'offerTheme', to: 'bexchauveto', name: 'halloween' }, t.deps)).error.reason, 'missing');
  const offline = setup({ offerOnline: false });
  assert.equal((await hubAction({ action: 'offerTheme', to: 'bexchauveto', name: 'foret' }, offline.deps)).error.reason, 'offline');
  assert.deepEqual(await hubAction({ action: 'offerTheme', to: 42, name: 'foret' }, t.deps).then(answer => answer.sent), undefined);
});

const OFFER = { id: 'o1', from: 'bexchauveto', theme: { name: 'aurore' } };

test('hub route: an offer installs, then goes; an unknown one is gone', async () => {
  const t = setup({ offers: [OFFER] });
  const answer = await hubAction({ action: 'acceptOffer', id: 'o1' }, t.deps);
  assert.equal(answer.installed, 'aurore');
  assert.deepEqual(answer.catalog, { themes: [] });
  assert.deepEqual(t.live(), []);
  assert.equal((await hubAction({ action: 'acceptOffer', id: 'o1' }, t.deps)).error.reason, 'gone');
});

test('hub route: a refused theme takes its offer with it, a passing failure keeps it for a retry', async () => {
  const refused = setup({ offers: [OFFER], installFails: 'network' });
  assert.equal((await hubAction({ action: 'acceptOffer', id: 'o1' }, refused.deps)).error.reason, 'network');
  assert.deepEqual(refused.live(), []);
  const passing = setup({ offers: [OFFER], installFails: 'disk' });
  const answer = await hubAction({ action: 'acceptOffer', id: 'o1' }, passing.deps);
  assert.ok(answer.error && !answer.installed);
  assert.equal(passing.live().length, 1);
});

test('hub route: an installed theme stays installed when the catalog cannot be read back', async () => {
  const t = setup({ offers: [OFFER], catalogFails: true });
  const answer = await hubAction({ action: 'acceptOffer', id: 'o1' }, t.deps);
  assert.equal(answer.installed, 'aurore');
  assert.equal(answer.catalog, undefined);
  assert.equal(answer.error, undefined);
});

test('hub route: a kudos or a wizz says whether it went out', async () => {
  const t = setup();
  assert.equal((await hubAction({ action: 'kudos', to: 'bexchauveto' }, t.deps)).sent, true);
  assert.equal((await hubAction({ action: 'kudos', to: 'a b' }, t.deps)).sent, false);
  assert.equal((await hubAction({ action: 'wizz', to: 'bexchauveto', pr: 'https://github.com/x/y/pull/1' }, t.deps)).sent, false);
  t.deps.hub.sendWizz = () => false;
  assert.equal((await hubAction({ action: 'wizz', to: 'bexchauveto' }, t.deps)).sent, false);
});

test('hub route: a second install of the same offer while the first runs does nothing', async () => {
  const t = setup({ offers: [OFFER] });
  let release;
  t.deps.installTheme = () => new Promise(resolve => {
    release = () => resolve('aurore');
  });
  const first = hubAction({ action: 'acceptOffer', id: 'o1' }, t.deps);
  await new Promise(resolve => setImmediate(resolve));
  const second = await hubAction({ action: 'acceptOffer', id: 'o1' }, t.deps);
  assert.equal(second.installed, undefined);
  assert.equal(second.error, undefined);
  release();
  assert.equal((await first).installed, 'aurore');
});
