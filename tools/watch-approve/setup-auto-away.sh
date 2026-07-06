#!/usr/bin/env bash
# Install the auto-away LaunchAgent (macOS only): away mode turns on when
# the screen locks and off when it unlocks. Run after setup.sh.
#
# Usage: ./setup-auto-away.sh            install + start
#        ./setup-auto-away.sh uninstall  stop + remove
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${CLAUDE_WATCH_DIR:-$HOME/.claude/watch-approve}"
LABEL="com.claude.watch-approve.auto-away"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

[ "$(uname)" = "Darwin" ] || { echo "auto-away requires macOS (launchd + ioreg)" >&2; exit 1; }

if [ "${1:-}" = "uninstall" ]; then
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
  rm -f "$PLIST" "$INSTALL_DIR/auto-away.sh" "$INSTALL_DIR/.away-set-by-auto"
  echo "auto-away removed. Manual 'away on/off' still works."
  exit 0
fi

[ -d "$INSTALL_DIR" ] || { echo "Run setup.sh first ($INSTALL_DIR not found)" >&2; exit 1; }

install -m 0755 "$SRC_DIR/auto-away.sh" "$INSTALL_DIR/auto-away.sh"

mkdir -p "$(dirname "$PLIST")"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$INSTALL_DIR/auto-away.sh</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
EOF

# Restart cleanly if already installed.
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "auto-away installed and running."
echo "Lock your Mac -> away mode ON (approvals go to your watch)."
echo "Unlock        -> away mode OFF."
echo "Check anytime: $INSTALL_DIR/away status"
echo "Remove with:   $SRC_DIR/setup-auto-away.sh uninstall"
