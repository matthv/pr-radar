#!/bin/sh
# Reverses daily-notes-install.sh: stops and removes the scheduled job. The digest cache
# and its log are left alone — this only ever un-schedules the pre-warm.
set -e
LABEL="local.pr-radar.daily-notes"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
rm -f "$PLIST"

echo "Notes de daily automatiques désactivées."
