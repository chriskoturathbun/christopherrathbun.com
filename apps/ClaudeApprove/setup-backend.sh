#!/usr/bin/env bash
# Operator script (run by YOU, not app users): configure APNs secrets, sync
# the installer assets, and deploy the multi-tenant backend.
#
# Users never touch this — they install the app and run:
#   curl -fsSL https://christopherrathbun.com/claude-approve/install.sh | bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$APP_DIR/../.." && pwd)"
cd "$REPO_ROOT"

command -v wrangler >/dev/null || { echo "Install wrangler first: npm i -g wrangler" >&2; exit 1; }

# Keep the publicly-served hook files in sync with the source of truth.
cp tools/watch-approve/watch_approve.py public/claude-approve/watch_approve.py
cp tools/watch-approve/away public/claude-approve/away
echo "Synced hook assets into public/claude-approve/."

if [ "${1:-}" != "--deploy-only" ]; then
  echo "APNs credentials (developer.apple.com -> Certificates -> Keys):"
  read -rp "Apple Team ID (10 chars): " TEAM_ID
  printf '%s' "$TEAM_ID" | wrangler secret put APNS_TEAM_ID
  read -rp "APNs Key ID (10 chars): " KEY_ID
  printf '%s' "$KEY_ID" | wrangler secret put APNS_KEY_ID
  read -rp "Path to AuthKey_XXXXXXXXXX.p8: " P8_PATH
  wrangler secret put APNS_P8 < "${P8_PATH/#\~/$HOME}"
fi

wrangler deploy

echo
echo "Backend deployed. Reminders:"
echo "- wrangler.toml APNS_ENV is currently: $(grep '^APNS_ENV' wrangler.toml || echo '(default: production)')"
echo "  Use 'sandbox' while running the app from Xcode; 'production' for"
echo "  TestFlight/App Store builds."
echo "- Landing page: https://christopherrathbun.com/claude-approve/"
echo "- Installer:    https://christopherrathbun.com/claude-approve/install.sh"
echo "- Re-run with --deploy-only to skip the APNs prompts."