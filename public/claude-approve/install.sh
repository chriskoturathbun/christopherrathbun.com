#!/usr/bin/env bash
# ClaudeApprove installer — pairs this Mac with the ClaudeApprove iPhone app
# so Claude Code permission prompts go to your Apple Watch.
#
#   curl -fsSL https://christopherrathbun.com/claude-approve/install.sh | bash
#
# Prompts for the pairing code shown in the app, installs the Claude Code
# hook, and wires it into ~/.claude/settings.json (with a backup).
set -euo pipefail

BASE_URL="${CLAUDE_APPROVE_URL:-https://christopherrathbun.com/api/claude-approve}"
ASSETS_URL="${CLAUDE_APPROVE_ASSETS:-https://christopherrathbun.com/claude-approve}"
INSTALL_DIR="${CLAUDE_WATCH_DIR:-$HOME/.claude/watch-approve}"
SETTINGS="${CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"

command -v python3 >/dev/null || {
  echo "python3 is required (macOS: xcode-select --install)" >&2; exit 1; }
command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }

echo "ClaudeApprove — approve Claude Code from your Apple Watch"
echo
echo "Open the ClaudeApprove app on your iPhone. It shows a pairing code"
echo "like AB2K-9QXX (tap 'Pair a Computer' if you're past setup)."
echo
if [ -r /dev/tty ]; then
  read -rp "Pairing code: " PAIR_CODE < /dev/tty
else
  echo "No terminal available for input. Download and run instead:" >&2
  echo "  curl -fsSLO $ASSETS_URL/install.sh && bash install.sh" >&2
  exit 1
fi

CLAIM_BODY=$(PAIR_CODE="$PAIR_CODE" python3 -c \
  'import json,os; print(json.dumps({"code": os.environ["PAIR_CODE"]}))')
RESPONSE=$(curl -fsS -X POST "$BASE_URL/pair/claim" \
  -H "Content-Type: application/json" -d "$CLAIM_BODY") || {
  echo "Pairing failed — the code may be expired (they last 10 minutes)." >&2
  echo "Generate a fresh one in the app and re-run this installer." >&2
  exit 1
}
ACCOUNT_TOKEN=$(printf '%s' "$RESPONSE" | python3 -c \
  'import json,sys; print(json.load(sys.stdin)["account_token"])')

mkdir -p "$INSTALL_DIR"
curl -fsS "$ASSETS_URL/watch_approve.py" -o "$INSTALL_DIR/watch_approve.py"
curl -fsS "$ASSETS_URL/away" -o "$INSTALL_DIR/away"
chmod 0755 "$INSTALL_DIR/watch_approve.py" "$INSTALL_DIR/away"

INSTALL_DIR="$INSTALL_DIR" BASE_URL="$BASE_URL" ACCOUNT_TOKEN="$ACCOUNT_TOKEN" \
SETTINGS="$SETTINGS" python3 <<'PY'
import json, os, shutil, time

install_dir = os.environ["INSTALL_DIR"]
settings_path = os.environ["SETTINGS"]

cfg_path = os.path.join(install_dir, "config.json")
cfg = {}
if os.path.exists(cfg_path):
    try:
        with open(cfg_path) as f:
            cfg = json.load(f)
    except Exception:
        cfg = {}
cfg.update({
    "backend": "worker",
    "worker_url": os.environ["BASE_URL"],
    "worker_secret": os.environ["ACCOUNT_TOKEN"],
})
cfg.setdefault("timeout_seconds", 240)
with open(cfg_path, "w") as f:
    json.dump(cfg, f, indent=2)
os.chmod(cfg_path, 0o600)

command = f'python3 "{install_dir}/watch_approve.py"'
entry = {"matcher": "Bash|Write|Edit|NotebookEdit|WebFetch|WebSearch",
         "hooks": [{"type": "command", "command": command, "timeout": 300}]}
settings = {}
if os.path.exists(settings_path):
    shutil.copy2(settings_path,
                 settings_path + ".bak-" + time.strftime("%Y%m%d%H%M%S"))
    with open(settings_path) as f:
        settings = json.load(f)
pre = settings.setdefault("hooks", {}).setdefault("PreToolUse", [])
if not any(h.get("command") == command
           for g in pre for h in g.get("hooks", [])):
    pre.append(entry)
    os.makedirs(os.path.dirname(settings_path), exist_ok=True)
    with open(settings_path, "w") as f:
        json.dump(settings, f, indent=2)
        f.write("\n")
PY

echo
echo "✓ Paired and installed."
echo
echo "  1. Restart Claude Code (hooks load at startup)."
echo "  2. When you step away:   $INSTALL_DIR/away on"
echo "     When you're back:     $INSTALL_DIR/away off"
echo
echo "With away mode on, Claude Code approvals buzz your Apple Watch —"
echo "tap Approve right on the notification. No answer in ~4 minutes"
echo "falls back to the normal terminal prompt."