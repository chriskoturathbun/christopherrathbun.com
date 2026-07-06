#!/usr/bin/env bash
# Generate and open the Xcode project — no manual target setup.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

if ! command -v xcodegen >/dev/null; then
  command -v brew >/dev/null || {
    echo "Homebrew is required to install xcodegen: https://brew.sh" >&2
    exit 1
  }
  echo "Installing xcodegen..."
  brew install xcodegen
fi

xcodegen generate
open ClaudeApprove.xcodeproj

cat <<'EOF'

Project opened in Xcode. Remaining clicks:
  1. Select the project -> each target -> Signing & Capabilities ->
     set your Team (Xcode fixes provisioning automatically).
  2. Destination: your iPhone -> Run. Allow notifications on the phone.
  3. Scheme: ClaudeApproveWatch -> destination: your Watch -> Run.
     (First watch install can take a few minutes.)
Then run ./setup-backend.sh if you haven't, and scan the QR it prints.
EOF
