'use strict';

// What the PRDs and Sessions views read: the board's cached PRs, the skills' stage lines, the
// running sessions, their transcripts and Linear. Kept out of server.js, which only routes to it.
const claudeSessions = require('./claude-sessions');
const skillStages = require('./skill-stages');
const linear = require('./linear');
const { buildPrds, buildSessions, extraTickets, sessionStatuses } = require('./prds');
const demo = require('./demo');
const demoPrds = require('./demo-prds');

// The PRDs view reads your tickets from Linear's API; without a key the view says how to set one.
const LINEAR_API_KEY = (process.env.PR_RADAR_LINEAR_API_KEY ?? '').trim();
// The Sessions view chimes when a session turns to you only when asked to.
const SESSION_CHIME = process.env.PR_RADAR_SESSION_CHIME === 'true';
// A session that has written no stage for a day is not working on anything any more.
const STAGE_WINDOW_MS = 86_400_000;
const ROUTES = new Set(['/api/prds', '/api/sessions/status']);

function createPrdView({
  boardPrs, isDemo = false, linearApiKey = LINEAR_API_KEY, claudeSessionsOn, sessionChime = SESSION_CHIME,
  maxAgeDays, stageWindowMs = STAGE_WINDOW_MS, cacheTtlMs,
}) {
  // The PRs made or opened in a session that a scan here met: the board's change check takes
  // them with its own, since this scan moved their transcripts past them.
  let touched = new Set();
  const takeTouched = (boardTouched = []) => {
    const urls = [...new Set([...touched, ...boardTouched])];
    touched = new Set();
    return urls;
  };

  // Linear is read on the board's cadence, one read per set of extra tickets at a time; a forced
  // read never rides on one already under way.
  let linearCache = { at: 0, key: '', prds: null, warned: [] };
  const inFlight = new Map();
  function linearPrds(extra, force) {
    const key = [...extra].sort().join(',');
    if (!force && linearCache.prds && linearCache.key === key && Date.now() - linearCache.at < cacheTtlMs) return Promise.resolve(linearCache);
    if (!force && inFlight.has(key)) return inFlight.get(key);
    const warned = [];
    const read = linear.fetchPrds({ apiKey: linearApiKey, extra, warn: message => warned.push(message) })
      .then(prds => (linearCache = { at: Date.now(), key, prds, warned }))
      .finally(() => {
        if (inFlight.get(key) === read) inFlight.delete(key);
      });
    inFlight.set(key, read);
    return read;
  }

  // The stage lines and the running sessions, each failure a warning rather than an empty view.
  async function readLocal(warnings) {
    const [stageSessions, live] = await Promise.all([
      skillStages.readStages({ maxAgeMs: stageWindowMs }).catch(error => {
        warnings.push({ source: 'stages', message: `${skillStages.STAGES_DIR}: ${error.message}` });
        return [];
      }),
      claudeSessions.liveSessions().catch(error => {
        warnings.push({ source: 'claude', message: error.message });
        return [];
      }),
    ]);
    if (claudeSessions.agentsProblem()) warnings.push({ source: 'claude', message: claudeSessions.agentsProblem() });
    return { stageSessions, live };
  }

  async function view(force) {
    const prs = boardPrs();
    const warnings = [];
    const { stageSessions, live } = await readLocal(warnings);
    // A session started since the last scan has no title, folder or branch until its transcript is read.
    if (claudeSessionsOn) {
      await claudeSessions.scan({ maxAgeDays }).then(scan => {
        for (const url of scan.touched) touched.add(url);
        if (scan.unreadable) warnings.push({ source: 'claude', message: `${scan.unreadable} transcript(s) could not be read` });
      }, error => {
        warnings.push({ source: 'claude', message: `Claude transcripts: ${error.message}` });
      });
    }
    // The Sessions view needs no Linear: without a key, or with Linear failing, it still shows the
    // sessions and their own PRs.
    let fetched = [];
    if (linearApiKey) {
      try {
        const read = await linearPrds(extraTickets(stageSessions, prs), force);
        fetched = read.prds;
        for (const message of read.warned) warnings.push({ source: 'linear', message });
      } catch (error) {
        // One failed read keeps the last tickets drawn rather than blanking the view.
        fetched = linearCache.prds ?? [];
        warnings.push({ source: 'linear', failed: true, message: `Linear: ${error.message}${linearCache.prds ? ' (showing the last tickets read)' : ''}` });
      }
    }
    const prds = buildPrds({
      prds: fetched, boardPrs: prs, stageSessions, live,
      sessionFor: claudeSessionsOn ? claudeSessions.sessionFor : () => null,
      sessionsOf: claudeSessionsOn ? claudeSessions.sessionsForTicket : () => [],
      cwdOf: claudeSessions.cwdOf,
    });
    return {
      enabled: true,
      linear: Boolean(linearApiKey),
      claudeSessions: claudeSessionsOn,
      sessionChime,
      warnings,
      prds,
      sessions: buildSessions({ prds, boardPrs: prs, stageSessions, live, detailsOf: claudeSessionsOn ? claudeSessions.sessionDetails : () => null, cwdOf: claudeSessions.cwdOf }),
    };
  }

  // The Sessions view's poll, every second: local files only, no Linear and no GitHub.
  async function statuses() {
    const warnings = [];
    const { stageSessions, live } = await readLocal(warnings);
    return { enabled: true, warnings, sessions: sessionStatuses({ stageSessions, live }) };
  }

  // The demo's board is fixed: the PRDs view links it even before the page has asked for it.
  const demoBoard = () => {
    const { mine, reviews } = demo.payload(false);
    return [...mine, ...reviews];
  };

  // The two routes, as [status, body]. They read your prompts and recaps: never for another
  // machine, nor a page rebinding a hostname.
  async function answer({ pathname, force, remoteAddress, host }) {
    const refused = claudeSessions.localOnly({ remoteAddress, host });
    if (refused) return [403, { error: refused }];
    if (isDemo) return [200, pathname === '/api/prds' ? demoPrds.view(demoBoard()) : demoPrds.statuses()];
    try {
      return [200, pathname === '/api/prds' ? await view(force) : await statuses()];
    } catch (error) {
      return [502, { error: error.message }];
    }
  }

  return { serves: pathname => ROUTES.has(pathname), answer, view, statuses, takeTouched };
}

module.exports = { createPrdView };
