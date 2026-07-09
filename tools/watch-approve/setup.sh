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

# Reuse existing ntfy topics if present; otherwise generate and merge them
# into whatever config exists (a worker-backend config from the app installer
# must survive — only backend/ntfy keys change).
TOPIC="$(python3 -c "import json,os;p='$CONFIG';print(json.load(open(p)).get('topic','') if os.path.exists(p) else '')")"
if [ -n "$TOPIC" ]; then
  echo "Keeping existing ntfy topics in: $CONFIG"
else
  TOPIC="cc-approve-$(python3 -c 'import secrets;print(secrets.token_hex(8))')"
  RESPONSE_TOPIC="cc-resp-$(python3 -c 'import secrets;print(secrets.token_hex(8))')"
  CONFIG="$CONFIG" SERVER="$SERVER" TOPIC="$TOPIC" RESPONSE_TOPIC="$RESPONSE_TOPIC" python3 <<'PY'
import json, os
p = os.environ["CONFIG"]
cfg = {}
if os.path.exists(p):
    try:
        with open(p) as f:
            cfg = json.load(f)
    except Exception:
        cfg = {}
cfg.update({
    "backend": "ntfy",
    "server": os.environ["SERVER"],
    "topic": os.environ["TOPIC"],
    "response_topic": os.environ["RESPONSE_TOPIC"],
})
cfg.setdefault("timeout_seconds", 240)
with open(p, "w") as f:
    json.dump(cfg, f, indent=2)
os.chmod(p, 0o600)
print(f"Wrote config: {p} (backend=ntfy)")
PY
fi

# Merge the PreToolUse hook into settings.json without clobbering anything else.
python3 - "$SETTINGS" "$INSTALL_DIR" <<'PY'
import json, os, shutil, sys, time

settings_path, install_dir = sys.argv[1], sys.argv[2]
# Shell fast path (skip python entirely when away mode is off) and a baked-in
# CLAUDE_WATCH_DIR so custom install dirs work at hook runtime.
command = (
    f'[ -f "{install_dir}/away-mode-on" ] || [ "$CLAUDE_WATCH_ALWAYS" = "1" ] '
    f'&& CLAUDE_WATCH_DIR="{install_dir}" python3 "{install_dir}/watch_approve.py" || true'
)
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
updated = False
for group in pre:
    for h in group.get("hooks", []):
        if "watch_approve.py" in h.get("command", ""):
            h["command"] = command
            h["timeout"] = 300
            updated = True
if not updated:
    pre.append(entry)
os.makedirs(os.path.dirname(settings_path), exist_ok=True)
with open(settings_path, "w") as f:
    json.dump(settings, f, indent=2)
    f.write("\n")
print(("Updated" if updated else "Added") + f" PreToolUse hook in {settings_path}")
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
