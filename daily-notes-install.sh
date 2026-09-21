#!/bin/sh
# Schedules daily-notes.js on weekday mornings via launchd — the only thing on macOS
# that still tries once the day resumes if the laptop was asleep at the exact minute,
# which plain cron does not.
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
TIME="$(grep -E '^PR_RADAR_DAILY_NOTES_TIME=' .env 2>/dev/null | tail -1 | cut -d= -f2-)"
TIME="${TIME:-08:30}"
HOUR="$(echo "$TIME" | cut -d: -f1 | sed 's/^0*//')"
MINUTE="$(echo "$TIME" | cut -d: -f2 | sed 's/^0*//')"
HOUR="${HOUR:-8}"
MINUTE="${MINUTE:-30}"

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
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Weekday</key><integer>1</integer><key>Hour</key><integer>$HOUR</integer><key>Minute</key><integer>$MINUTE</integer></dict>
    <dict><key>Weekday</key><integer>2</integer><key>Hour</key><integer>$HOUR</integer><key>Minute</key><integer>$MINUTE</integer></dict>
    <dict><key>Weekday</key><integer>3</integer><key>Hour</key><integer>$HOUR</integer><key>Minute</key><integer>$MINUTE</integer></dict>
    <dict><key>Weekday</key><integer>4</integer><key>Hour</key><integer>$HOUR</integer><key>Minute</key><integer>$MINUTE</integer></dict>
    <dict><key>Weekday</key><integer>5</integer><key>Hour</key><integer>$HOUR</integer><key>Minute</key><integer>$MINUTE</integer></dict>
  </array>
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

echo "Planifié : tous les jours ouvrés à $TIME."
echo "Journal  : $REPO_DIR/.daily-notes.log"
echo "Test immédiat : node daily-notes.js"
echo "Pour retirer  : ./daily-notes-uninstall.sh"
