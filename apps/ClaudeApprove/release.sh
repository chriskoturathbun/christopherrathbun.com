#!/usr/bin/env bash
# Archive the app and upload it straight to App Store Connect.
#
# One-time prerequisites:
#   - bootstrap.sh has been run and the app builds in Xcode
#   - Xcode -> Settings -> Accounts: your Apple ID is signed in
#   - App Store Connect: the app record exists (see SETUP.md checklist)
#   - wrangler.toml APNS_ENV flipped to "production" + redeployed
#
# Then every release is just:  ./release.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

[ -d ClaudeApprove.xcodeproj ] || { echo "Run ./bootstrap.sh first." >&2; exit 1; }

# No APNs env flip needed: each device reports sandbox/production when it
# registers, and the backend picks the right APNs host per device.

ARCHIVE="build/ClaudeApprove.xcarchive"
rm -rf build

echo "==> Archiving (this builds the iPhone app with the Watch app inside)..."
xcodebuild archive \
  -project ClaudeApprove.xcodeproj \
  -scheme ClaudeApprove \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE" \
  -allowProvisioningUpdates

echo "==> Uploading to App Store Connect..."
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportOptionsPlist ExportOptions.plist \
  -allowProvisioningUpdates

echo
echo "✓ Uploaded. In App Store Connect (~5-15 min processing):"
echo "  - TestFlight tab: the build appears for beta testing"
echo "  - App Store tab: select the build, fill the listing, Submit for Review"