'use strict';

// Pre-warms the standup notes before you open the board, so the click that used to cost
// 30-100 seconds finds the cache already written. Runs standalone — it never starts the
// HTTP server, and does not need it running either; it shares only the on-disk digest
// cache, reading and writing the same .digest-cache.json the server's /api/digest does.
//
// Meant to run unattended from launchd (see daily-notes-install.sh), so it takes no
// browser filter into account — there is none to read from a cron job. It pre-warms the
// full board's "mine" and "reviews", windowed to the previous working day, the default
// the standup notes panel itself opens on. A board that has moved by the time you actually
// click still regenerates then, at full cost, exactly as it would without this script;
// this only ever saves time, it can never make the notes wrong.

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
