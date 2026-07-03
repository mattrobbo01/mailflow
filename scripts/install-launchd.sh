#!/bin/bash
# Install the MailFlow scheduled-send/snooze runner as a launchd agent (fires every 60s).
set -euo pipefail
PLIST_SRC="$(dirname "$0")/../launchd/com.mattrobertson.mailflow.runner.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.mattrobertson.mailflow.runner.plist"

mkdir -p "$HOME/Library/LaunchAgents"
cp "$PLIST_SRC" "$PLIST_DST"
launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load "$PLIST_DST"
echo "Installed. Check: launchctl list | grep mailflow ; log: tail -f /tmp/mailflow-runner.log"
