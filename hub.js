'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROTOCOL = 1;
const CONFIG_DIR = path.join(os.homedir(), '.config', 'pr-radar');
// The hub closes a connection past 30 messages a minute, of any kind: status changes grouped to
// one every 2.5 s take 24 at most, and leave the rest to clicks.
const STATUS_EVERY_MS = 2500;
const STABLE_MS = 60_000;
const RATE_LIMITED_MS = 60_000;
const STOP_GRACE_MS = 500;
const TOKEN = 'hub-token';
const DECLINED = 'hub-declined';
const AVAILABILITY = 'hub-availability';
const AVAILABILITIES = new Set(['available', 'focus']);
const WIZZ_KEPT = 10;
const WIZZ_LIMITS = { nudgeMs: 10 * 60_000, nudgesPerPair: 3, plainMs: 5 * 60_000 };
const NUDGE_MS = WIZZ_LIMITS.nudgeMs;
const WIZZ_REF = /^[0-9a-f]{64}$/;
const RELEASE_TAG = /^v[0-9]+\.[0-9]+\.[0-9]+$/;
const KUDOS_KEPT = 10;
const OFFERS_KEPT = 5;
const OFFER_TTL_MS = 60 * 60_000;

const CLOSE_CODES = {
  4000: 'protocol_unsupported',
  4001: 'hello_timeout',
  4002: 'bad_message',
  4003: 'rate_limited',
  4004: 'replaced',
  4010: 'auth_expired',
  4011: 'auth_denied',
  4012: 'auth_unavailable',
  4013: 'bad_token',
  4014: 'not_member',
  4015: 'revoked',
};
const KNOWN = new Set(Object.values(CLOSE_CODES));
// Reconnecting after these would sign the person in again and again, or fight another
// process over the same radar: only a restart or a click starts over.
const FINAL = new Set(['not_member', 'revoked', 'replaced', 'protocol_unsupported', 'auth_expired', 'auth_denied']);
const FORGETS_TOKEN = new Set(['not_member', 'revoked', 'bad_token']);

// Both radars hash the same string, so the recipient finds the PR in its own list; the hub
// only ever sees the digest.
const wizzRef = prUrl => crypto.createHash('sha256').update(String(prUrl).trim().replace(/\/+$/, '').toLowerCase()).digest('hex');

// Mirrors the hub's limits, which drop the surplus without a word: the page greys the button instead.
function wizzWaits(sent, to, at, { nudgeMs, nudgesPerPair, plainMs } = WIZZ_LIMITS) {
  const mine = sent.filter(entry => entry.to === to.toLowerCase());
  const nudges = mine.filter(entry => entry.ref && at - entry.at < nudgeMs);
  const plain = mine.filter(entry => !entry.ref && at - entry.at < plainMs);
  return {
    plainUntil: plain.length ? Math.max(...plain.map(entry => entry.at)) + plainMs : null,
    nudgesUntil: nudges.length >= nudgesPerPair ? Math.min(...nudges.map(entry => entry.at)) + nudgeMs : null,
    refsUntil: Object.fromEntries(nudges.map(entry => [entry.ref, entry.at + nudgeMs])),
  };
}

// The page knows PRs by URL: a ref turns back into a PR of this board, or stays unknown.
function withPrUrls(state, prUrls, at = Date.now(), limits = WIZZ_LIMITS) {
  const byRef = new Map(prUrls.map(url => [wizzRef(url), url]));
  const sent = state.wizzSent ?? [];
  const waits = Object.fromEntries([...new Set(sent.map(entry => entry.to))].map(to => {
    const { plainUntil, nudgesUntil, refsUntil } = wizzWaits(sent, to, at, limits);
    const prsUntil = Object.fromEntries(Object.entries(refsUntil).filter(([ref]) => byRef.has(ref)).map(([ref, until]) => [byRef.get(ref), until]));
    return [to, { plainUntil, nudgesUntil, prsUntil }];
  }));
  const { wizzSent, ...rest } = state;
  return {
    ...rest,
    wizzWaits: waits,
    wizzes: (state.wizzes ?? []).map(({ ref, ...wizz }) => ({ ...wizz, nudge: Boolean(ref), prUrl: ref ? byRef.get(ref) ?? null : null })),
  };
}

const backoffDelay = (attempt, random = Math.random) => Math.floor(random() * Math.min(300_000, 2000 * 2 ** attempt));

// Outside the clone: survives a `git clean`, never committed, shared by every clone on the machine.
function realFiles(dir = CONFIG_DIR) {
  const file = name => path.join(dir, name);
  return {
    read(name) {
      try {
        return fs.readFileSync(file(name), 'utf8').trim() || null;
      } catch {
        return null;
      }
    },
    write(name, value) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(file(name), `${value}\n`, { mode: 0o600 });
      // `mode` only applies when the file is created.
      fs.chmodSync(file(name), 0o600);
    },
    remove(name) {
      fs.rmSync(file(name), { force: true });
    },
  };
}

function createHub({
  url,
  instanceId,
  files = realFiles(),
  WebSocketImpl = globalThis.WebSocket,
  now = Date.now,
  timers = { set: setTimeout, clear: clearTimeout },
  random = Math.random,
  log = () => {},
}) {
  let socket = null;
  let attempt = 0;
  let hubError = null;
  let lastFailure = '';
  let retriedWithoutToken = false;
  let stopping = false;
  let declined = Boolean(files.read(DECLINED));
  let tabs = 0;
  let version = { commit: null, behind: null, tag: null };
  let availability = AVAILABILITIES.has(files.read(AVAILABILITY)) ? files.read(AVAILABILITY) : null;
  let wizzSeen = 0;
  let wizzes = [];
  let wizzSent = [];
  let kudosSeen = 0;
  let kudos = [];
  let offers = [];
  let undelivered = null;
  let inHello = null;
  let known = null;
  const timer = { retry: null, stable: null, status: null };
  const view = { status: 'off', login: null, avatarUrl: null, presence: null, auth: null, stopped: null, nextTryAt: null };

  // A full disk or a read-only folder costs the remembered setting, never the radar: these run
  // inside socket listeners, where a throw would take the whole server down.
  const save = (name, value) => {
    try {
      if (value == null) files.remove(name);
      else files.write(name, value);
    } catch (error) {
      log('fail', `cannot save ${name}: ${error.message}`);
    }
  };

  const clear = name => {
    if (timer[name]) timers.clear(timer[name]);
    timer[name] = null;
  };

  const send = message => {
    try {
      socket?.send(JSON.stringify(message));
    } catch {
      /* closing: the close event takes it from here */
    }
  };

  function connect() {
    clear('retry');
    if (!url || socket) return;
    hubError = null;
    Object.assign(view, { status: 'connecting', stopped: null, nextTryAt: null });
    let ws;
    try {
      ws = new WebSocketImpl(url);
    } catch (error) {
      log('fail', `cannot open ${url}: ${error.message}`);
      ended(null, 1006, '');
      return;
    }
    socket = ws;
    ws.addEventListener('open', () => {
      if (socket !== ws) return;
      inHello = { tabs, version, availability, acceptsWizz: acceptsWizz() };
      // Availability belongs to the login on the hub: a null here would clear a focus set from
      // another of the person's radars, so it only goes out once chosen. acceptsWizz always
      // goes: the hub forgets a refusal once the person's last radar leaves.
      send({ type: 'hello', protocol: PROTOCOL, hubToken: files.read(TOKEN) ?? undefined, instanceId, version, tabs, acceptsWizz: acceptsWizz(), ...(availability ? { availability } : {}) });
    });
    ws.addEventListener('message', event => {
      if (socket === ws) received(event.data);
    });
    ws.addEventListener('close', event => ended(ws, event.code, event.reason));
    // Node's WebSocket reports a refused connection with an error and no close at all.
    ws.addEventListener('error', event => {
      if (socket === ws && event?.message) lastFailure = event.message;
      ended(ws, 1006, '');
    });
  }

  function received(data) {
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    switch (message?.type) {
      case 'auth_required':
        view.status = 'auth';
        view.auth = {
          userCode: String(message.userCode ?? ''),
          verificationUri: String(message.verificationUri ?? ''),
          expiresAt: now() + Number(message.expiresIn ?? 0) * 1000,
        };
        break;
      case 'welcome':
        if (message.hubToken) save(TOKEN, message.hubToken);
        retriedWithoutToken = false;
        Object.assign(view, { status: 'online', auth: null, login: message.login ?? null, avatarUrl: message.avatarUrl ?? null });
        known = inHello;
        clear('stable');
        timer.stable = timers.set(() => {
          attempt = 0;
        }, STABLE_MS);
        scheduleStatus();
        break;
      case 'presence': {
        view.presence = {
          online: Array.isArray(message.online) ? message.online : [],
          recent: Array.isArray(message.recent) ? message.recent : [],
          at: now(),
        };
        const mine = view.presence.online.find(person => person.login?.toLowerCase() === view.login?.toLowerCase());
        if (mine && 'availability' in mine) keepAvailability(mine.availability);
        break;
      }
      case 'wizz':
        wizzSeen += 1;
        wizzes = [...wizzes, {
          id: wizzSeen,
          from: String(message.from ?? ''),
          avatarUrl: message.avatarUrl ?? null,
          at: message.at ?? new Date(now()).toISOString(),
          ref: WIZZ_REF.test(message.ref ?? '') ? message.ref : null,
        }].slice(-WIZZ_KEPT);
        break;
      case 'kudos':
        kudosSeen += 1;
        kudos = [...kudos, { id: kudosSeen, from: String(message.from ?? ''), avatarUrl: message.avatarUrl ?? null, at: message.at ?? new Date(now()).toISOString() }]
          .slice(-KUDOS_KEPT);
        break;
      case 'theme_offer':
        if (typeof message.id !== 'string' || !message.theme || offers.some(offer => offer.id === message.id)) break;
        offers = [...offers, { id: message.id, from: String(message.from ?? ''), avatarUrl: message.avatarUrl ?? null, theme: message.theme, receivedAt: now() }]
          .slice(-OFFERS_KEPT);
        break;
      case 'undelivered':
        undelivered = { kind: String(message.kind ?? ''), to: String(message.to ?? ''), at: now() };
        break;
      case 'error':
        hubError = message.code ?? null;
        lastFailure = String(message.message ?? '');
        if (hubError === 'bad_message') log('fail', `the hub refused a message: ${lastFailure}`);
        break;
      default:
    }
  }

  function ended(ws, code, reason) {
    if (socket !== ws) return;
    socket = null;
    known = null;
    clear('stable');
    clear('status');
    view.auth = null;
    if (stopping) return;
    const why = hubError ?? CLOSE_CODES[code] ?? (KNOWN.has(reason) ? reason : null);
    if (FORGETS_TOKEN.has(why)) save(TOKEN, null);
    if (why === 'bad_token' && !retriedWithoutToken) {
      retriedWithoutToken = true;
      connect();
      return;
    }
    if (FINAL.has(why)) {
      Object.assign(view, { status: 'stopped', stopped: { code: why }, presence: null });
      log('info', `stopped (${why})`);
      return;
    }
    if (code === 1009) log('fail', 'the hub closed the connection on a message over 16 KiB');
    const delay = Math.max(backoffDelay(attempt, random), why === 'rate_limited' ? RATE_LIMITED_MS : 0);
    // Once per streak of retries, so a long outage says why without filling the log.
    if (attempt === 0) log('fail', `connection lost (${why ?? code}${lastFailure ? `: ${lastFailure}` : ''}), retrying in ${Math.round(delay / 1000)} s`);
    lastFailure = '';
    attempt += 1;
    Object.assign(view, { status: 'waiting', nextTryAt: now() + delay });
    timer.retry = timers.set(connect, delay);
  }

  function scheduleStatus() {
    if (!known || timer.status) return;
    timer.status = timers.set(flushStatus, STATUS_EVERY_MS);
  }

  function flushStatus() {
    timer.status = null;
    if (!known || !socket) return;
    const message = { type: 'status' };
    if (tabs !== known.tabs) message.tabs = tabs;
    if (['commit', 'behind', 'tag'].some(field => version[field] !== known.version[field])) message.version = version;
    if (availability !== known.availability) message.availability = availability;
    if (acceptsWizz() !== known.acceptsWizz) message.acceptsWizz = acceptsWizz();
    if (Object.keys(message).length === 1) return;
    send(message);
    known = { tabs, version, availability, acceptsWizz: acceptsWizz() };
  }

  function start() {
    if (!url) return;
    if (declined) {
      view.status = 'declined';
      return;
    }
    stopping = false;
    connect();
  }

  function stop(code = 1000) {
    stopping = true;
    Object.keys(timer).forEach(clear);
    const ws = socket;
    socket = null;
    known = null;
    Object.assign(view, { status: 'off', auth: null, presence: null, nextTryAt: null });
    if (!ws) return Promise.resolve();
    return new Promise(resolve => {
      const grace = timers.set(resolve, STOP_GRACE_MS);
      ws.addEventListener('close', () => {
        timers.clear(grace);
        resolve();
      });
      try {
        ws.close(code);
      } catch {
        timers.clear(grace);
        resolve();
      }
    });
  }

  function decline() {
    declined = true;
    save(DECLINED, new Date(now()).toISOString());
    const closed = stop(1000);
    Object.assign(view, { status: 'declined', stopped: null });
    return closed;
  }

  function signIn() {
    if (!url) return;
    if (declined) save(DECLINED, null);
    declined = false;
    if (socket) return;
    stopping = false;
    attempt = 0;
    retriedWithoutToken = false;
    connect();
  }

  function setTabs(count) {
    if (count === tabs) return;
    tabs = count;
    scheduleStatus();
  }

  // The hub replaces the whole version object on each one it gets: all three always go together.
  function setVersion({ commit = null, behind = null, tag = null } = {}) {
    const next = { commit, behind, tag: RELEASE_TAG.test(tag ?? '') && tag.length <= 32 ? tag : null };
    if (next.commit === version.commit && next.behind === version.behind && next.tag === version.tag) return;
    version = next;
    scheduleStatus();
  }

  function keepAvailability(value) {
    const next = AVAILABILITIES.has(value) ? value : null;
    if (next === availability) return false;
    availability = next;
    save(AVAILABILITY, next);
    if (known) known = { ...known, availability, acceptsWizz: acceptsWizz() };
    return true;
  }

  // Focus is the one way to be left alone: it refuses plain wizzes too, so a sender sees the
  // button greyed rather than shaking a page that will not shake.
  function acceptsWizz() {
    return availability !== 'focus';
  }

  // Unlike tabs, a status change is one deliberate click: it goes out at once.
  function setAvailability(value) {
    if (!keepAvailability(value) || !known || !socket) return;
    send({ type: 'status', availability, acceptsWizz: acceptsWizz() });
  }

  const online = () => view.status === 'online' && Boolean(socket);

  const recentWizzSent = () => {
    wizzSent = wizzSent.filter(entry => now() - entry.at < NUDGE_MS);
    return wizzSent;
  };

  // Plain without a ref, a nudge on a PR with one.
  function sendWizz(to, ref = null) {
    if (!online() || to.toLowerCase() === view.login?.toLowerCase()) return false;
    if (ref !== null && !WIZZ_REF.test(ref)) return false;
    const recipient = view.presence?.online.find(person => person.login?.toLowerCase() === to.toLowerCase());
    if (!ref && (recipient?.acceptsWizz === false || recipient?.availability === 'focus')) return false;
    const waits = wizzWaits(recentWizzSent(), to, now());
    if (ref ? waits.nudgesUntil || waits.refsUntil[ref] : waits.plainUntil) return false;
    send({ type: 'wizz', to, ...(ref ? { ref } : {}) });
    wizzSent = [...wizzSent, { to: to.toLowerCase(), ref, at: now() }];
    return true;
  }

  function sendKudos(to) {
    if (!online() || to.toLowerCase() === view.login?.toLowerCase()) return false;
    send({ type: 'kudos', to });
    return true;
  }

  function offerTheme(to, theme) {
    if (!online()) return false;
    send({ type: 'theme_offer', to, theme });
    return true;
  }

  const liveOffers = () => {
    offers = offers.filter(offer => now() - offer.receivedAt < OFFER_TTL_MS);
    return offers;
  };

  const peekOffer = id => liveOffers().find(candidate => candidate.id === id) ?? null;

  function takeOffer(id) {
    const offer = liveOffers().find(candidate => candidate.id === id) ?? null;
    offers = offers.filter(candidate => candidate.id !== id);
    return offer;
  }

  // The page gets what it shows, not the theme's code: that only leaves the server on install.
  const state = () => ({
    ...view,
    declined,
    availability,
    acceptsWizz: acceptsWizz(),
    kudos,
    wizzes,
    wizzSent: recentWizzSent(),
    undelivered,
    offers: liveOffers().map(({ id, from, avatarUrl, theme, receivedAt }) => ({
      id, from, avatarUrl, receivedAt,
      name: String(theme.name ?? ''), label: String(theme.label ?? ''), icon: String(theme.icon ?? ''), hasScript: typeof theme.js === 'string' && theme.js.trim() !== '',
    })),
  });

  return { start, stop, decline, signIn, setTabs, setVersion, setAvailability, sendKudos, sendWizz, offerTheme, peekOffer, takeOffer, state };
}

const TAB_ID = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_TABS = 100;

// Tabs have no connection of their own to the server, only a beat every 5 s (25 s hidden). A hidden one
// gets more slack: the browser slows its timers down to once a minute.
function createTabCounter({ visibleMs = 75_000, hiddenMs = 150_000 } = {}) {
  const seen = new Map();
  const expire = at => {
    for (const [id, tab] of seen) if (at - tab.at > (tab.hidden ? hiddenMs : visibleMs)) seen.delete(id);
  };
  return {
    beat(tabId, hidden, at = Date.now()) {
      if (!TAB_ID.test(String(tabId ?? ''))) return;
      expire(at);
      if (!seen.has(tabId) && seen.size >= MAX_TABS) return;
      seen.set(tabId, { at, hidden: Boolean(hidden) });
    },
    bye(tabId) {
      seen.delete(tabId);
    },
    count(at = Date.now()) {
      expire(at);
      return seen.size;
    },
  };
}

module.exports = { createHub, createTabCounter, backoffDelay, wizzRef, wizzWaits, withPrUrls, realFiles, CONFIG_DIR, CLOSE_CODES };
