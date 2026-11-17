'use strict';

// What the PRDs and Sessions views read: the board's cached PRs, the skills' stage lines, the
// running sessions, their transcripts and Linear. Kept out of server.js, which only routes to it.
const claudeSessions = require('./claude-sessions');
const skillStages = require('./skill-stages');
const linear = require('./linear');
const { buildPrds, buildSessions, extraTickets, sessionStatuses } = require('./prds');

function createPrdView({ boardPrs, linearApiKey, claudeSessionsOn, sessionChime, maxAgeDays, stageWindowMs, cacheTtlMs }) {
  // The PRs made or opened in a session that a scan here met: the board's change check takes
  // them, since this scan moved its transcripts past them.
  let touched = new Set();
  const takeTouched = () => {
    const urls = touched;
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

  async function view(force) {
    const prs = boardPrs();
    const warnings = [];
    const stageSessions = await skillStages.readStages({ maxAgeMs: stageWindowMs }).catch(error => {
      warnings.push({ source: 'stages', message: `${skillStages.STAGES_DIR}: ${error.message}` });
      return [];
    });
    const live = await claudeSessions.liveSessions().catch(error => {
      warnings.push({ source: 'claude', message: error.message });
      return [];
    });
    if (claudeSessions.agentsProblem()) warnings.push({ source: 'claude', message: claudeSessions.agentsProblem() });
    // A session started since the last scan has no title, folder or branch until its transcript is read.
    if (claudeSessionsOn) {
      await claudeSessions.scan({ maxAgeDays }).then(scan => {
        for (const url of scan.touched) touched.add(url);
      }, () => {});
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
        warnings.push({ source: 'linear', failed: true, message: `Linear: ${error.message}` });
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
    const [stageSessions, live] = await Promise.all([skillStages.readStages({ maxAgeMs: stageWindowMs }), claudeSessions.liveSessions()]);
    return { enabled: true, sessions: sessionStatuses({ stageSessions, live }) };
  }

  return { view, statuses, takeTouched };
}

module.exports = { createPrdView };
