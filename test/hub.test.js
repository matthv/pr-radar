'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createHub, createTabCounter, backoffDelay, wizzRef, withPrUrls } = require('../hub');

function fakeTimers() {
  let next = 0;
  const pending = new Map();
  return {
    set(fn, ms) {
      next += 1;
      pending.set(next, { fn, ms });
      return next;
    },
    clear(id) {
      pending.delete(id);
    },
    delays: () => [...pending.values()].map(entry => entry.ms),
    fire(ms) {
      for (const [id, entry] of [...pending]) {
        if (ms !== undefined && entry.ms !== ms) continue;
        pending.delete(id);
        entry.fn();
      }
    },
  };
}

function setup({ token = null, declined = false, availability = null, random = () => 0.5, clock = { now: 1_000_000 } } = {}) {
  const sockets = [];
  class FakeSocket extends EventTarget {
    constructor(url) {
      super();
      this.url = url;
      this.sent = [];
      this.closedWith = null;
      sockets.push(this);
    }

    send(data) {
      this.sent.push(JSON.parse(data));
    }

    close(code) {
      this.closedWith = code;
    }

    emit(type, fields = {}) {
      this.dispatchEvent(Object.assign(new Event(type), fields));
    }
  }
  const store = new Map();
  if (token) store.set('hub-token', token);
  if (declined) store.set('hub-declined', '2026-11-09T10:00:00.000Z');
  if (availability) store.set('hub-availability', availability);
  const files = {
    read: name => store.get(name) ?? null,
    write: (name, value) => store.set(name, value),
    remove: name => store.delete(name),
  };
  const timers = fakeTimers();
  const hub = createHub({
    url: 'wss://hub.test/ws',
    instanceId: 'instance-1234',
    files,
    WebSocketImpl: FakeSocket,
    timers,
    now: () => clock.now,
    random,
  });
  const last = () => sockets.at(-1);
  return {
    hub,
    sockets,
    store,
    timers,
    last,
    open: () => {
      last().emit('open');
      return last().sent.at(-1);
    },
    say: message => last().emit('message', { data: JSON.stringify(message) }),
    closeWith: (code, reason = '') => last().emit('close', { code, reason }),
  };
}

const welcome = (extra = {}) => ({ type: 'welcome', protocol: 1, login: 'matthv', avatarUrl: 'https://a/u/1', ...extra });

test('the first hello has no token, and carries the instance, the version and the tabs', () => {
  const t = setup();
  t.hub.setTabs(2);
  t.hub.setVersion({ commit: 'abc1234def', behind: 1 });
  t.hub.start();
  assert.equal(t.last().url, 'wss://hub.test/ws');
  assert.deepEqual(t.open(), {
    type: 'hello', protocol: 1, instanceId: 'instance-1234', version: { commit: 'abc1234def', behind: 1, tag: null }, tabs: 2,
  });
});

test('a code to type shows in the state, and the token from welcome is stored but never shown', () => {
  const t = setup();
  t.hub.start();
  t.open();
  t.say({ type: 'auth_required', userCode: '72CC-9A43', verificationUri: 'https://github.com/login/device', expiresIn: 900 });
  assert.equal(t.hub.state().status, 'auth');
  assert.deepEqual(t.hub.state().auth, { userCode: '72CC-9A43', verificationUri: 'https://github.com/login/device', expiresAt: 1_000_000 + 900_000 });
  t.say(welcome({ hubToken: 'rh_secret' }));
  assert.equal(t.store.get('hub-token'), 'rh_secret');
  const state = t.hub.state();
  assert.equal(state.status, 'online');
  assert.equal(state.login, 'matthv');
  assert.equal(state.auth, null);
  assert.ok(!JSON.stringify(state).includes('rh_secret'));
});

test('a stored token goes into every later hello', () => {
  const t = setup({ token: 'rh_kept' });
  t.hub.start();
  assert.equal(t.open().hubToken, 'rh_kept');
});

test('presence replaces the previous one, and unknown types and broken JSON are ignored', () => {
  const t = setup({ token: 'rh_kept' });
  t.hub.start();
  t.open();
  t.say(welcome());
  t.say({ type: 'presence', online: [{ login: 'a' }, { login: 'b' }], recent: [] });
  t.say({ type: 'presence', online: [{ login: 'b' }], recent: [{ login: 'a' }] });
  t.say({ type: 'kudos', from: 'b' });
  t.last().emit('message', { data: 'not json' });
  assert.deepEqual(t.hub.state().presence.online, [{ login: 'b' }]);
  assert.deepEqual(t.hub.state().presence.recent, [{ login: 'a' }]);
  assert.equal(t.hub.state().status, 'online');
});

for (const [label, close] of [
  ['the hub restarting (1001)', t => t.closeWith(1001)],
  ['an internal error (1011)', t => t.closeWith(1011)],
  ['a message too big (1009)', t => t.closeWith(1009)],
  ['hello_timeout', t => t.closeWith(4001, 'hello_timeout')],
  ['bad_message', t => t.closeWith(4002, 'bad_message')],
  ['a refused connection, an error with no close', t => t.last().emit('error')],
]) {
  test(`${label}: reconnects after a backoff`, () => {
    const t = setup({ token: 'rh_kept' });
    t.hub.start();
    t.open();
    close(t);
    assert.equal(t.hub.state().status, 'waiting');
    assert.deepEqual(t.timers.delays(), [1000]);
    t.timers.fire();
    assert.equal(t.sockets.length, 2);
  });
}

test('auth_unavailable reconnects and keeps the token', () => {
  const t = setup({ token: 'rh_kept' });
  t.hub.start();
  t.open();
  t.say({ type: 'error', code: 'auth_unavailable', message: 'GitHub is down' });
  t.closeWith(4012, 'auth_unavailable');
  assert.equal(t.store.get('hub-token'), 'rh_kept');
  t.timers.fire();
  assert.equal(t.open().hubToken, 'rh_kept');
});

test('rate_limited waits at least 60 s', () => {
  const t = setup({ token: 'rh_kept', random: () => 0 });
  t.hub.start();
  t.open();
  t.closeWith(4003, 'rate_limited');
  assert.deepEqual(t.timers.delays(), [60_000]);
});

for (const [code, close, forgets] of [
  ['not_member', 4014, true],
  ['revoked', 4015, true],
  ['replaced', 4004, false],
  ['protocol_unsupported', 4000, false],
  ['auth_expired', 4010, false],
  ['auth_denied', 4011, false],
]) {
  test(`${code}: stops for good${forgets ? ' and forgets the token' : ''}`, () => {
    const t = setup({ token: 'rh_kept' });
    t.hub.start();
    t.open();
    t.say({ type: 'error', code, message: '…' });
    t.closeWith(close, code);
    assert.equal(t.hub.state().status, 'stopped');
    assert.deepEqual(t.hub.state().stopped, { code });
    assert.equal(t.store.has('hub-token'), !forgets);
    assert.deepEqual(t.timers.delays(), []);
  });
}

test('the close reason is enough when the error message was missed', () => {
  const t = setup({ token: 'rh_kept' });
  t.hub.start();
  t.open();
  t.closeWith(4015, 'revoked');
  assert.deepEqual(t.hub.state().stopped, { code: 'revoked' });
  assert.equal(t.store.has('hub-token'), false);
});

test('bad_token forgets the token and tries once at once without it, then backs off', () => {
  const t = setup({ token: 'rh_old' });
  t.hub.start();
  t.open();
  t.closeWith(4013, 'bad_token');
  assert.equal(t.store.has('hub-token'), false);
  assert.equal(t.sockets.length, 2);
  assert.equal(t.open().hubToken, undefined);
  t.closeWith(4013, 'bad_token');
  assert.equal(t.sockets.length, 2);
  assert.equal(t.hub.state().status, 'waiting');
});

test('a close after an error event does not schedule a second reconnection', () => {
  const t = setup({ token: 'rh_kept' });
  t.hub.start();
  t.open();
  const socket = t.last();
  socket.emit('error');
  socket.emit('close', { code: 1006, reason: '' });
  assert.equal(t.timers.delays().length, 1);
});

test('backoff grows, is capped at 300 s, and starts over after 60 s up past welcome', () => {
  assert.equal(backoffDelay(0, () => 0.999), 1998);
  assert.equal(backoffDelay(3, () => 0.5), 8000);
  assert.equal(backoffDelay(20, () => 1), 300_000);

  const t = setup({ token: 'rh_kept', random: () => 1 });
  t.hub.start();
  for (const expected of [2000, 4000, 8000]) {
    t.open();
    t.closeWith(1006);
    assert.deepEqual(t.timers.delays(), [expected]);
    t.timers.fire();
  }
  t.open();
  t.say(welcome());
  t.timers.fire(60_000);
  t.closeWith(1006);
  assert.deepEqual(t.timers.delays(), [2000]);
});

test('a connection lost before 60 s up keeps growing the backoff', () => {
  const t = setup({ token: 'rh_kept', random: () => 1 });
  t.hub.start();
  t.open();
  t.closeWith(1006);
  t.timers.fire();
  t.open();
  t.say(welcome());
  t.closeWith(1006);
  assert.deepEqual(t.timers.delays(), [4000]);
});

test('status is grouped, holds only what changed, and waits for welcome', () => {
  const t = setup({ token: 'rh_kept' });
  t.hub.setVersion({ commit: 'abc', behind: 0 });
  t.hub.start();
  t.open();
  t.hub.setTabs(1);
  assert.deepEqual(t.timers.delays(), []);
  t.say(welcome());
  t.timers.fire(2500);
  assert.deepEqual(t.last().sent.at(-1), { type: 'status', tabs: 1 });
  t.hub.setTabs(2);
  t.hub.setTabs(3);
  t.hub.setVersion({ commit: 'abc', behind: 2 });
  t.timers.fire(2500);
  assert.deepEqual(t.last().sent.at(-1), { type: 'status', tabs: 3, version: { commit: 'abc', behind: 2, tag: null } });
  t.hub.setTabs(2);
  t.hub.setTabs(3);
  const sentBefore = t.last().sent.length;
  t.timers.fire(2500);
  assert.equal(t.last().sent.length, sentBefore);
});

test('stop closes with 1000 and resolves once closed, without reconnecting', async () => {
  const t = setup({ token: 'rh_kept' });
  t.hub.start();
  t.open();
  t.say(welcome());
  const socket = t.last();
  const stopped = t.hub.stop();
  assert.equal(socket.closedWith, 1000);
  socket.emit('close', { code: 1000, reason: '' });
  await stopped;
  assert.equal(t.hub.state().status, 'off');
  assert.deepEqual(t.timers.delays(), []);
});

test('Not now remembers the choice: no connection until sign in is asked for', async () => {
  const t = setup();
  t.hub.start();
  t.open();
  t.say({ type: 'auth_required', userCode: 'AAAA-BBBB', verificationUri: 'https://github.com/login/device', expiresIn: 900 });
  const declining = t.hub.decline();
  assert.equal(t.sockets[0].closedWith, 1000);
  t.timers.fire(500);
  await declining;
  assert.ok(t.store.has('hub-declined'));
  assert.equal(t.hub.state().status, 'declined');

  const later = setup({ declined: true });
  later.hub.start();
  assert.equal(later.sockets.length, 0);
  assert.equal(later.hub.state().status, 'declined');
  later.hub.signIn();
  assert.equal(later.store.has('hub-declined'), false);
  assert.equal(later.sockets.length, 1);
});

test('sign in after a stop on revoked starts over without a token', () => {
  const t = setup({ token: 'rh_kept' });
  t.hub.start();
  t.open();
  t.closeWith(4015, 'revoked');
  t.hub.signIn();
  assert.equal(t.sockets.length, 2);
  assert.equal(t.open().hubToken, undefined);
});

test('with no URL the hub stays off and opens nothing', () => {
  let opened = 0;
  const hub = createHub({ url: '', instanceId: null, files: { read: () => null }, WebSocketImpl: class { constructor() { opened += 1; } } });
  hub.start();
  hub.signIn();
  assert.equal(opened, 0);
  assert.equal(hub.state().status, 'off');
});

test('tabs count arrivals and departures, and expire later when hidden', () => {
  const tabs = createTabCounter({ visibleMs: 75_000, hiddenMs: 150_000 });
  tabs.beat('tab-aaaaaaaa', false, 0);
  tabs.beat('tab-bbbbbbbb', true, 0);
  tabs.beat('tab-cccccccc', false, 0);
  assert.equal(tabs.count(1000), 3);
  tabs.bye('tab-cccccccc');
  assert.equal(tabs.count(1000), 2);
  assert.equal(tabs.count(100_000), 1);
  assert.equal(tabs.count(200_000), 0);
  tabs.beat('../../etc', false, 0);
  tabs.beat(undefined, false, 0);
  assert.equal(tabs.count(1000), 0);
});

const online = (options = {}) => {
  const t = setup({ token: 'rh_kept', ...options });
  t.hub.start();
  t.open();
  t.say(welcome());
  return t;
};

test('availability: sent in hello only once chosen, at once on a click, and kept across restarts', () => {
  const t = setup({ token: 'rh_kept', availability: 'focus' });
  t.hub.start();
  assert.equal(t.open().availability, 'focus');
  t.say(welcome());
  t.hub.setAvailability('available');
  assert.deepEqual(t.last().sent.at(-1), { type: 'status', availability: 'available', acceptsWizz: true });
  assert.equal(t.store.get('hub-availability'), 'available');
  t.hub.setAvailability('nonsense');
  assert.deepEqual(t.last().sent.at(-1), { type: 'status', availability: null, acceptsWizz: true });
  assert.equal(t.store.has('hub-availability'), false);
  const sent = t.last().sent.length;
  t.timers.fire(2500);
  assert.equal(t.last().sent.length, sent);

  const fresh = setup({ token: 'rh_kept' });
  fresh.hub.start();
  assert.equal('availability' in fresh.open(), false);
});

test('availability set from another of my radars is taken from presence', () => {
  const t = online();
  t.say({ type: 'presence', online: [{ login: 'MatthV', availability: 'focus' }], recent: [] });
  assert.equal(t.hub.state().availability, 'focus');
  assert.equal(t.store.get('hub-availability'), 'focus');
  const sent = t.last().sent.length;
  t.timers.fire(2500);
  assert.equal(t.last().sent.length, sent);
  t.say({ type: 'presence', online: [{ login: 'matthv', availability: null }], recent: [] });
  assert.equal(t.hub.state().availability, null);
});

test('a kudos goes out only while online', () => {
  const t = setup({ token: 'rh_kept' });
  t.hub.start();
  assert.equal(t.hub.sendKudos('bexchauveto'), false);
  t.open();
  t.say(welcome());
  assert.equal(t.hub.sendKudos('bexchauveto'), true);
  assert.deepEqual(t.last().sent.at(-1), { type: 'kudos', to: 'bexchauveto' });
  assert.equal(t.hub.sendKudos('MATTHV'), false);
});

test('kudos received keep the last ten, each with its own id', () => {
  const t = online();
  for (let i = 0; i < 12; i += 1) t.say({ type: 'kudos', from: `p${i}`, avatarUrl: null, at: '2026-11-09T16:00:00Z' });
  const { kudos } = t.hub.state();
  assert.equal(kudos.length, 10);
  assert.equal(kudos[0].from, 'p2');
  assert.equal(new Set(kudos.map(k => k.id)).size, 10);
});

test('undelivered says who could not be reached', () => {
  const t = online();
  t.say({ type: 'undelivered', kind: 'kudos', to: 'Scra3' });
  assert.deepEqual(t.hub.state().undelivered, { kind: 'kudos', to: 'Scra3', at: 1_000_000 });
});

test('theme offers: shown without their code, deduplicated, capped, expired after an hour, taken once', () => {
  const clock = { now: 1_000_000 };
  const t = online({ clock });
  const theme = { name: 'foret', label: 'Forêt', icon: '🌲', css: ':root{}', js: '(() => {})();' };
  t.say({ type: 'theme_offer', id: 'o1', from: 'bexchauveto', avatarUrl: null, theme });
  t.say({ type: 'theme_offer', id: 'o1', from: 'bexchauveto', avatarUrl: null, theme });
  assert.deepEqual(t.hub.state().offers, [
    { id: 'o1', from: 'bexchauveto', avatarUrl: null, receivedAt: 1_000_000, name: 'foret', label: 'Forêt', icon: '🌲', hasScript: true },
  ]);
  assert.ok(!JSON.stringify(t.hub.state()).includes(':root'));
  for (let i = 2; i <= 7; i += 1) t.say({ type: 'theme_offer', id: `o${i}`, from: 'x', theme: { ...theme, js: null } });
  assert.deepEqual(t.hub.state().offers.map(o => o.id), ['o3', 'o4', 'o5', 'o6', 'o7']);
  assert.equal(t.hub.state().offers[0].hasScript, false);
  assert.equal(t.hub.takeOffer('o3').theme.css, ':root{}');
  assert.equal(t.hub.takeOffer('o3'), null);
  clock.now += 60 * 60_000;
  assert.deepEqual(t.hub.state().offers, []);
});

test('offering a theme sends it whole, only while online', () => {
  const t = online();
  const theme = { name: 'foret', label: 'Forêt', icon: '🌲', css: 'a{}', js: null };
  assert.equal(t.hub.offerTheme('bexchauveto', theme), true);
  assert.deepEqual(t.last().sent.at(-1), { type: 'theme_offer', to: 'bexchauveto', theme });
});

const REF = 'a'.repeat(64);

test('the wizz ref is the SHA-256 of the PR URL, whatever its case or a trailing slash', () => {
  const ref = wizzRef('https://github.com/matthv/pr-radar/pull/33');
  assert.match(ref, /^[0-9a-f]{64}$/);
  assert.equal(wizzRef('https://github.com/MatthV/PR-Radar/pull/33/'), ref);
  assert.notEqual(wizzRef('https://github.com/matthv/pr-radar/pull/34'), ref);
});

test('focus refuses plain wizzes: acceptsWizz follows availability, in hello once chosen and at once on a click', () => {
  const t = setup({ token: 'rh_kept' });
  t.hub.start();
  assert.equal('acceptsWizz' in t.open(), false);
  t.say(welcome());
  t.hub.setAvailability('focus');
  assert.deepEqual(t.last().sent.at(-1), { type: 'status', availability: 'focus', acceptsWizz: false });
  assert.equal(t.hub.state().acceptsWizz, false);
  t.hub.setAvailability('available');
  assert.deepEqual(t.last().sent.at(-1), { type: 'status', availability: 'available', acceptsWizz: true });
  const restarted = setup({ token: 'rh_kept', availability: 'focus' });
  restarted.hub.start();
  assert.equal(restarted.open().acceptsWizz, false);
});

test('a wizz goes out plain or with a ref, never to oneself nor with a malformed ref', () => {
  const t = online();
  assert.equal(t.hub.sendWizz('bexchauveto'), true);
  assert.deepEqual(t.last().sent.at(-1), { type: 'wizz', to: 'bexchauveto' });
  assert.equal(t.hub.sendWizz('Scra3', REF), true);
  assert.deepEqual(t.last().sent.at(-1), { type: 'wizz', to: 'Scra3', ref: REF });
  assert.equal(t.hub.sendWizz('MATTHV'), false);
  assert.equal(t.hub.sendWizz('Scra3', 'A'.repeat(64)), false);
});

test('a plain wizz is held back toward someone in focus, a nudge is not', () => {
  const t = online();
  t.say({ type: 'presence', online: [{ login: 'bexchauveto', acceptsWizz: false }, { login: 'Scra3', availability: 'focus' }], recent: [] });
  assert.equal(t.hub.sendWizz('bexchauveto'), false);
  assert.equal(t.hub.sendWizz('Scra3'), false);
  assert.equal(t.hub.sendWizz('bexchauveto', REF), true);
});

test('wizz limits mirror the hub: 5 minutes plain, 10 minutes per ref, 3 nudges per pair', () => {
  const clock = { now: 1_000_000 };
  const t = online({ clock });
  const ref = n => String(n).repeat(64);
  assert.equal(t.hub.sendWizz('bexchauveto'), true);
  assert.equal(t.hub.sendWizz('bexchauveto'), false);
  assert.equal(t.hub.sendWizz('Scra3'), true);
  assert.equal(t.hub.sendWizz('bexchauveto', ref(1)), true);
  assert.equal(t.hub.sendWizz('bexchauveto', ref(1)), false);
  assert.equal(t.hub.sendWizz('bexchauveto', ref(2)), true);
  clock.now += 60_000;
  assert.equal(t.hub.sendWizz('bexchauveto', ref(3)), true);
  assert.equal(t.hub.sendWizz('BexChauveto', ref(4)), false);
  assert.equal(t.hub.sendWizz('Scra3', ref(4)), true);
  clock.now += 4 * 60_000;
  assert.equal(t.hub.sendWizz('bexchauveto'), true);
  assert.equal(t.hub.sendWizz('bexchauveto', ref(4)), false);
  clock.now += 5 * 60_000;
  assert.equal(t.hub.sendWizz('bexchauveto', ref(4)), true);
  assert.equal(t.hub.sendWizz('bexchauveto', ref(1)), true);
  assert.ok(t.hub.state().wizzSent.every(entry => clock.now - entry.at < 10 * 60_000));
});

test('wizzes received keep the last ten, a ref only when well formed', () => {
  const t = online();
  t.say({ type: 'wizz', from: 'bexchauveto', avatarUrl: null, at: '2026-11-10T10:00:00Z', ref: REF });
  t.say({ type: 'wizz', from: 'Scra3', avatarUrl: null, at: '2026-11-10T10:00:01Z', ref: 'nope' });
  assert.deepEqual(t.hub.state().wizzes.map(w => [w.from, w.ref]), [['bexchauveto', REF], ['Scra3', null]]);
  for (let i = 0; i < 12; i += 1) t.say({ type: 'wizz', from: `p${i}` });
  assert.equal(t.hub.state().wizzes.length, 10);
});

test('the page gets wizzes and waits by PR URL, and an unknown ref stays unknown', () => {
  const url = 'https://github.com/matthv/pr-radar/pull/33';
  const at = 1_000_000;
  const view = withPrUrls({
    status: 'online',
    wizzes: [
      { id: 1, from: 'bexchauveto', ref: wizzRef(url) },
      { id: 2, from: 'Scra3', ref: REF },
      { id: 3, from: 'hercemer42', ref: null },
    ],
    wizzSent: [{ to: 'bexchauveto', ref: wizzRef(url), at }, { to: 'bexchauveto', ref: null, at }],
  }, [url], at + 1000);
  assert.deepEqual(view.wizzes.map(w => [w.from, w.nudge, w.prUrl]), [['bexchauveto', true, url], ['Scra3', true, null], ['hercemer42', false, null]]);
  assert.ok(!('wizzSent' in view));
  assert.ok(!JSON.stringify(view).includes(REF));
  assert.deepEqual(view.wizzWaits.bexchauveto, { plainUntil: at + 5 * 60_000, nudgesUntil: null, prsUntil: { [url]: at + 10 * 60_000 } });
});

test('the release tag goes with commit and behind, a malformed one as null, a new one in the next status', () => {
  const t = setup({ token: 'rh_kept' });
  t.hub.setVersion({ commit: 'abc', behind: 0, tag: 'v1.2.0' });
  t.hub.start();
  assert.deepEqual(t.open().version, { commit: 'abc', behind: 0, tag: 'v1.2.0' });
  t.say(welcome());
  t.hub.setVersion({ commit: 'abc', behind: 0, tag: 'v1.3.0-beta.1' });
  t.timers.fire(2500);
  assert.deepEqual(t.last().sent.at(-1), { type: 'status', version: { commit: 'abc', behind: 0, tag: null } });
  t.hub.setVersion({ commit: 'abc', behind: 0, tag: 'v1.3.0' });
  t.timers.fire(2500);
  assert.deepEqual(t.last().sent.at(-1), { type: 'status', version: { commit: 'abc', behind: 0, tag: 'v1.3.0' } });
});

test('the sign-in link shown is GitHub over https, whatever the hub sends', () => {
  const t = setup();
  t.hub.start();
  t.open();
  t.say({ type: 'auth_required', userCode: 'ABCD-1234', verificationUri: 'javascript:alert(1)', expiresIn: 900 });
  assert.equal(t.hub.state().auth.verificationUri, 'https://github.com/login/device');
  t.say({ type: 'auth_required', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device?x=1', expiresIn: 900 });
  assert.equal(t.hub.state().auth.verificationUri, 'https://github.com/login/device?x=1');
});

test('a token that cannot be saved still holds for the next connection', () => {
  const t = setup();
  const write = t.store.set.bind(t.store);
  t.store.set = (name, value) => {
    if (name === 'hub-token') throw new Error('EROFS');
    return write(name, value);
  };
  t.hub.start();
  t.open();
  t.say(welcome({ hubToken: 'rh_new' }));
  t.closeWith(1006);
  t.timers.fire();
  assert.equal(t.open().hubToken, 'rh_new');
});
