#!/bin/sh
# Schedules daily-notes.js to fire every few minutes, all day, via launchd — the script
# itself is what narrows that down to weekday mornings (see PR_RADAR_DAILY_NOTES_FROM/
# UNTIL in .env.example), so the window can change with an edit to .env, no re-install.
#
# A single fixed time was tried first and went stale the first real morning it ran:
# launchd fired it on time — screen lock does not stop a LaunchAgent, only real sleep
# does — but the ordinary activity between that one run and the actual click was enough
# to move the board and miss the cache key anyway. Repeating narrows that gap to the
# interval below instead of betting everything on one moment picked in advance. A run
# outside the window costs nothing at all — the script exits before any GitHub call; one
# inside it still fetches the board (a few seconds) but skips the expensive part, the
# `claude` spawn, whenever nothing has changed since the last run.
#
# launchd runs the agent with almost no PATH, so `node`/`claude`/`gh` are resolved here,
# in the user's own shell, and baked into the plist as absolute paths — the plist itself
# is static XML, it cannot re-resolve them at run time the way this script can.
set -e
cd "$(dirname "$0")"
REPO_DIR="$(pwd)"
LABEL="local.pr-radar.daily-notes"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "node introuvable dans le PATH courant — installe-le d'abord." >&2
  exit 1
fi
CLAUDE_BIN="$(command -v claude || true)"
GH_BIN="$(command -v gh || true)"

# A colon-joined PATH covering whatever was found, so the same lookups digest.js and
# github.js already do (spawn('claude', ...), execFile('gh', ...)) resolve under launchd
# too, plus the usual system locations.
JOB_PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
[ -n "$CLAUDE_BIN" ] && JOB_PATH="$(dirname "$CLAUDE_BIN"):$JOB_PATH"
[ -n "$GH_BIN" ] && JOB_PATH="$(dirname "$GH_BIN"):$JOB_PATH"
JOB_PATH="$(dirname "$NODE_BIN"):$JOB_PATH"

# Read once from .env (a targeted grep, not a source — .env is data, not a script to run).
# Only the interval goes into the plist: the FROM/UNTIL window is read by the script
# itself on every run, straight from .env, so narrowing or widening it later needs only
# an edit there — not a re-run of this installer.
read_env() {
  grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2-
}
INTERVAL_MINUTES="$(read_env PR_RADAR_DAILY_NOTES_INTERVAL_MINUTES)"
INTERVAL_MINUTES="${INTERVAL_MINUTES:-10}"
INTERVAL_SECONDS=$((INTERVAL_MINUTES * 60))
WINDOW_FROM="$(read_env PR_RADAR_DAILY_NOTES_FROM)"
WINDOW_FROM="${WINDOW_FROM:-07:30}"
WINDOW_UNTIL="$(read_env PR_RADAR_DAILY_NOTES_UNTIL)"
WINDOW_UNTIL="${WINDOW_UNTIL:-09:30}"

mkdir -p "$HOME/Library/LaunchAgents"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$REPO_DIR/daily-notes.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$REPO_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$JOB_PATH</string>
  </dict>
  <key>StartInterval</key>
  <integer>$INTERVAL_SECONDS</integer>
  <key>StandardOutPath</key>
  <string>$REPO_DIR/.daily-notes.log</string>
  <key>StandardErrorPath</key>
  <string>$REPO_DIR/.daily-notes.log</string>
</dict>
</plist>
PLIST_EOF

launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/$LABEL"

echo "Planifié : toutes les $INTERVAL_MINUTES min, jours ouvrés entre $WINDOW_FROM et $WINDOW_UNTIL."
echo "Journal  : $REPO_DIR/.daily-notes.log"
echo "Test immédiat, même hors fenêtre : node daily-notes.js --force"
echo "Pour retirer  : ./daily-notes-uninstall.sh"
