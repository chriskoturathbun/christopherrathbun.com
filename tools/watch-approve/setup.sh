#!/usr/bin/env bash
# Installer for the Claude Code -> Apple Watch approval bridge.
#
# - Generates random, unguessable ntfy topic names (they act as the shared secret)
# - Installs watch_approve.py + the `away` toggle to ~/.claude/watch-approve/
# - Adds the PreToolUse hook to ~/.claude/settings.json (backing it up first)
# - Sends a test notification so you can confirm your phone/watch receives it
#
# Usage: ./setup.sh [--server https://ntfy.sh]
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${CLAUDE_WATCH_DIR:-$HOME/.claude/watch-approve}"
CONFIG="$INSTALL_DIR/config.json"
SETTINGS="${CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"
SERVER="https://ntfy.sh"

if [ "${1:-}" = "--server" ] && [ -n "${2:-}" ]; then
  SERVER="${2%/}"
fi

command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }
command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }

mkdir -p "$INSTALL_DIR"
install -m 0755 "$SRC_DIR/watch_approve.py" "$INSTALL_DIR/watch_approve.py"
install -m 0755 "$SRC_DIR/away" "$INSTALL_DIR/away"

if [ -f "$CONFIG" ]; then
  echo "Keeping existing config: $CONFIG"
  TOPIC="$(python3 -c "import json;print(json.load(open('$CONFIG'))['topic'])")"
else
  TOPIC="cc-approve-$(python3 -c 'import secrets;print(secrets.token_hex(8))')"
  RESPONSE_TOPIC="cc-resp-$(python3 -c 'import secrets;print(secrets.token_hex(8))')"
  cat > "$CONFIG" <<EOF
{
  "server": "$SERVER",
  "topic": "$TOPIC",
  "response_topic": "$RESPONSE_TOPIC",
  "timeout_seconds": 240
}
EOF
  chmod 0600 "$CONFIG"
  echo "Wrote config: $CONFIG"
fi

# Merge the PreToolUse hook into settings.json without clobbering anything else.
python3 - "$SETTINGS" "$INSTALL_DIR" <<'PY'
import json, os, shutil, sys, time

settings_path, install_dir = sys.argv[1], sys.argv[2]
command = f'python3 "{install_dir}/watch_approve.py"'
entry = {
    "matcher": "Bash|Write|Edit|NotebookEdit|WebFetch|WebSearch",
    "hooks": [{"type": "command", "command": command, "timeout": 300}],
}

settings = {}
if os.path.exists(settings_path):
    shutil.copy2(settings_path, settings_path + ".bak-" + time.strftime("%Y%m%d%H%M%S"))
    with open(settings_path) as f:
        settings = json.load(f)

pre = settings.setdefault("hooks", {}).setdefault("PreToolUse", [])
already = any(
    h.get("command") == command
    for group in pre
    for h in group.get("hooks", [])
)
if already:
    print(f"Hook already present in {settings_path}")
else:
    pre.append(entry)
    os.makedirs(os.path.dirname(settings_path), exist_ok=True)
    with open(settings_path, "w") as f:
        json.dump(settings, f, indent=2)
        f.write("\n")
    print(f"Added PreToolUse hook to {settings_path}")
PY

echo
echo "Sending a test notification to topic: $TOPIC"
if curl -sS -o /dev/null -X POST "$SERVER" \
  -H "Content-Type: application/json" \
  -d "{\"topic\":\"$TOPIC\",\"title\":\"Watch bridge installed\",\"message\":\"If you can read this on your iPhone/Apple Watch, you're all set.\",\"tags\":[\"white_check_mark\"]}"; then
  echo "Test notification sent."
else
  echo "Could not reach $SERVER — check your network, then re-run setup.sh." >&2
fi

cat <<EOF

Next steps
==========
1. Install the "ntfy" app on your iPhone (App Store), open it, and
   subscribe to this topic:

       $TOPIC

   (server: $SERVER). Allow notifications when prompted.
2. On your iPhone: Watch app -> Notifications -> confirm "Mirror iPhone
   Alerts" includes ntfy. Notifications (and their Approve/Deny buttons)
   now show up on your Apple Watch.
3. Restart Claude Code so it picks up the new hook.
4. When you step away, run:  $INSTALL_DIR/away on
   When you're back:         $INSTALL_DIR/away off

Tip: add $INSTALL_DIR to your PATH so you can just type "away on".
EOF
