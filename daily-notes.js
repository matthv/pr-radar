'use strict';

// Pre-warms the standup notes before you open the board, so the click that used to cost
// 30-100 seconds finds the cache already written. Runs standalone — it never starts the
// HTTP server, and does not need it running either; it shares only the on-disk digest
// cache, reading and writing the same .digest-cache.json the server's /api/digest does.
//
// Fired every few minutes through the whole morning window (see daily-notes-install.sh),
// not once — a single shot went stale the first real morning it ran: launchd fired it on
// time (screen lock does not stop a LaunchAgent, only real sleep does), it wrote the
// cache, and 43 minutes of ordinary activity before the actual click was enough to move
// the board and miss the cache key anyway. Repeating narrows that gap to whatever the
// interval is, rather than betting everything on one moment picked in advance.
//
// It takes no browser filter into account — there is none to read from a cron job. It
// pre-warms the full board's "mine" and "reviews", windowed to the previous working day,
// the default the standup notes panel itself opens on. A board that has moved since the
// most recent run still regenerates on click, at full cost, exactly as it would without
// this script; this only ever saves time, it can never make the notes wrong.

const path = require('node:path');

try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch {
  /* no .env: fall back to the defaults */
}

const { fetchDashboard, mergedSince } = require('./github');
const digest = require('./digest');

const ORG = process.env.PR_RADAR_ORG;
const MAX_AGE_DAYS = Number(process.env.PR_RADAR_MAX_AGE_DAYS || 60);

function parseTime(value, fallbackHour, fallbackMinute) {
  const match = /^(\d{1,2}):(\d{2})$/.exec((value || '').trim());
  return match ? [Number(match[1]), Number(match[2])] : [fallbackHour, fallbackMinute];
}

const [FROM_HOUR, FROM_MINUTE] = parseTime(process.env.PR_RADAR_DAILY_NOTES_FROM, 7, 30);
const [UNTIL_HOUR, UNTIL_MINUTE] = parseTime(process.env.PR_RADAR_DAILY_NOTES_UNTIL, 9, 30);

// launchd fires this every few minutes, all day, every day (see daily-notes-install.sh) —
// the window is a property of *when you look*, not of the schedule, so it is a runtime
// check here rather than baked into the plist: changing it needs only an edit to .env,
// no re-install. Outside the window this is silent — logging a "skipped" line every few
// minutes for twenty-two hours a day would drown out the handful of lines that matter.
function withinMorningWindow(now) {
  if (now.getDay() === 0 || now.getDay() === 6) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  return minutes >= FROM_HOUR * 60 + FROM_MINUTE && minutes < UNTIL_HOUR * 60 + UNTIL_MINUTE;
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

// Same window as the panel's default "since <previous working day>" — oldest activity
// first, the way standupNotes words bullets against the order it is given.
function sinceLastWorkingDay(list) {
  const since = mergedSince();
  return list
    .filter(pr => new Date(pr.lastActivityAt).getTime() >= since)
    .sort((a, b) => new Date(a.lastActivityAt) - new Date(b.lastActivityAt))
    .map(pr => pr.id);
}

async function main() {
  // --force bypasses the window: without it, testing by hand outside the morning window
  // would silently do nothing, which reads as broken rather than as working correctly.
  const forced = process.argv.includes('--force');
  if (!forced && !withinMorningWindow(new Date())) return;

  if (!ORG) {
    log('PR_RADAR_ORG is missing: set it in .env (see .env.example) — skipping.');
    return;
  }
  if (!(await digest.available())) {
    log('claude CLI not found on PATH — skipping.');
    return;
  }

  const board = await fetchDashboard({ org: ORG, maxAgeDays: MAX_AGE_DAYS });
  const shaped = digest.pickForDigest(board, {
    mine: sinceLastWorkingDay(board.mine),
    reviews: sinceLastWorkingDay(board.reviews),
  });

  if (!shaped.mine.length && !shaped.reviews.length) {
    log('nothing since the previous working day — nothing to warm.');
    return;
  }

  // Both languages, since nothing here knows which one you will open to this morning.
  for (const lang of ['fr', 'en']) {
    const { cached, counts } = await digest.standupNotes(shaped, lang);
    log(`${lang}: ${cached ? 'already cached' : 'written'} (${counts.mine} mine, ${counts.reviews} reviews)`);
  }
}

main().catch(error => {
  log(`failed: ${error.message}`);
  process.exitCode = 1;
});
