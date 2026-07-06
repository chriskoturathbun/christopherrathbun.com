#!/usr/bin/env bash
# One command: deploy the approval backend, wire the Claude Code hook, and
# print a link/QR that configures the iPhone app in one tap.
#
# Prereqs: wrangler logged in (this repo deploys christopherrathbun.com),
# an APNs key (.p8) from developer.apple.com -> Certificates -> Keys.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$APP_DIR/../.." && pwd)"
HOOK_DIR="$REPO_ROOT/tools/watch-approve"
INSTALL_DIR="${CLAUDE_WATCH_DIR:-$HOME/.claude/watch-approve}"
SETTINGS="${CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"
BASE_URL="https://christopherrathbun.com/api/claude-approve"

cd "$REPO_ROOT"
command -v wrangler >/dev/null || { echo "Install wrangler first: npm i -g wrangler" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }

# --- shared secret (stable across re-runs) ---
mkdir -p "$INSTALL_DIR"
SECRET_FILE="$INSTALL_DIR/.approve-secret"
if [ -f "$SECRET_FILE" ]; then
  SECRET="$(cat "$SECRET_FILE")"
  echo "Reusing existing APPROVE_SECRET."
else
  SECRET="$(python3 -c 'import secrets; print(secrets.token_hex(24))')"
  (umask 077; printf '%s' "$SECRET" > "$SECRET_FILE")
  echo "Generated new APPROVE_SECRET."
fi

# --- Cloudflare secrets + deploy ---
printf '%s' "$SECRET" | wrangler secret put APPROVE_SECRET
read -rp "Apple Team ID (developer.apple.com -> Membership, 10 chars): " TEAM_ID
printf '%s' "$TEAM_ID" | wrangler secret put APNS_TEAM_ID
read -rp "APNs Key ID (10 chars): " KEY_ID
printf '%s' "$KEY_ID" | wrangler secret put APNS_KEY_ID
read -rp "Path to your AuthKey_XXXXXXXXXX.p8 file: " P8_PATH
wrangler secret put APNS_P8 < "${P8_PATH/#\~/$HOME}"
wrangler deploy

echo "Verifying backend..."
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/requests" -H "Authorization: Bearer $SECRET")
[ "$CODE" = "200" ] && echo "Backend live at $BASE_URL" || {
  echo "Backend check returned HTTP $CODE — fix before continuing." >&2; exit 1; }

# --- install hook + worker config on this Mac ---
install -m 0755 "$HOOK_DIR/watch_approve.py" "$INSTALL_DIR/watch_approve.py"
install -m 0755 "$HOOK_DIR/away" "$INSTALL_DIR/away"
python3 - "$INSTALL_DIR" "$BASE_URL" "$SECRET" "$SETTINGS" <<'PY'
import json, os, shutil, sys, time
install_dir, base_url, secret, settings_path = sys.argv[1:5]

cfg_path = os.path.join(install_dir, "config.json")
cfg = {}
if os.path.exists(cfg_path):
    with open(cfg_path) as f:
        cfg = json.load(f)
cfg.update({"backend": "worker", "worker_url": base_url,
            "worker_secret": secret})
cfg.setdefault("timeout_seconds", 240)
with open(cfg_path, "w") as f:
    json.dump(cfg, f, indent=2)
os.chmod(cfg_path, 0o600)
print(f"Hook config: {cfg_path} (backend=worker)")

command = f'python3 "{install_dir}/watch_approve.py"'
entry = {"matcher": "Bash|Write|Edit|NotebookEdit|WebFetch|WebSearch",
         "hooks": [{"type": "command", "command": command, "timeout": 300}]}
settings = {}
if os.path.exists(settings_path):
    shutil.copy2(settings_path, settings_path + ".bak-" + time.strftime("%Y%m%d%H%M%S"))
    with open(settings_path) as f:
        settings = json.load(f)
pre = settings.setdefault("hooks", {}).setdefault("PreToolUse", [])
if not any(h.get("command") == command for g in pre for h in g.get("hooks", [])):
    pre.append(entry)
    os.makedirs(os.path.dirname(settings_path), exist_ok=True)
    with open(settings_path, "w") as f:
        json.dump(settings, f, indent=2)
        f.write("\n")
    print(f"Hook added to {settings_path} (restart Claude Code)")
else:
    print("Hook already installed.")
PY

# --- one-tap app config link ---
LINK="claudeapprove://config?url=$(python3 -c "import urllib.parse;print(urllib.parse.quote('$BASE_URL', safe=''))")&secret=$SECRET"
echo
echo "==============================================================="
echo "After installing the app on your iPhone, configure it in one tap:"
echo
echo "  $LINK"
echo
if command -v qrencode >/dev/null; then
  echo "Scan with the iPhone camera:"
  qrencode -t ANSIUTF8 "$LINK"
else
  echo "(brew install qrencode, re-run, and you'll get a scannable QR here."
  echo " Or AirDrop/iMessage the link above to your phone and tap it.)"
fi
echo "==============================================================="
echo "Finally:  $INSTALL_DIR/away on   — and you're live."
