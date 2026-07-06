# ClaudeApprove — build & release runbook

Written to be executed by Claude Code running locally on the Mac (with the
human doing only the steps marked 👤). Work through the phases in order;
verify each gate before moving on.

## Phase 0 — Preflight

```bash
git pull
xcodebuild -version        # Xcode 15+ required
wrangler whoami            # logged into the right Cloudflare account
```

👤 One-time, if not already done: Apple Developer membership active; APNs
key created (developer.apple.com → Certificates → Keys → + → APNs →
download .p8, note Key ID and Team ID).

## Phase 1 — Backend deploy

```bash
./apps/ClaudeApprove/setup-backend.sh        # prompts for APNs values
```

**Gate:** `curl -s -X POST https://christopherrathbun.com/api/claude-approve/pair/new`
returns JSON with `account_token` and `pair_code`. If 500: check
`wrangler tail` while re-curling; likely a missing secret.

Note: deploy must run from the Mac clone that has `src/users-dashboard.js`
and `src/vighnaa.js` (never committed to git). If they're missing, STOP and
tell the human — do not create stubs on this machine, a stub deploy would
break the live users/vighnaa pages.

## Phase 2 — Generate + build the app

```bash
./apps/ClaudeApprove/bootstrap.sh            # xcodegen -> .xcodeproj, opens Xcode
```

👤 In Xcode: select the project → each target → Signing & Capabilities →
set Team.

Then build from CLI to surface errors in text:

```bash
cd apps/ClaudeApprove
xcodebuild -project ClaudeApprove.xcodeproj -scheme ClaudeApprove \
  -destination 'generic/platform=iOS' build -allowProvisioningUpdates 2>&1 | tail -40
```

**Fix compile errors yourself** — the Swift was written without a compiler
available, so expect possibly a few. Likely candidates:
- SwiftUI API availability (`ContentUnavailableView`, `ShareLink`) — iOS 17
  deployment target should cover them; if not, raise the target in
  project.yml and re-run xcodegen.
- `WKApplicationDelegateAdaptor` / `WKApplication` need watchOS 9+;
  target is 10.0.
- WCSessionDelegate conformance differences between platforms — the
  `#if os(...)` blocks in SettingsSync.swift are the first place to look.
- XcodeGen watch pairing: if the watch app doesn't embed, check
  `WKCompanionAppBundleIdentifier` in project.yml matches the iOS bundle id
  exactly, then `xcodegen generate` again.

**Gate:** both schemes build clean.

👤 Run on the real iPhone, then the real Watch (scheme:
ClaudeApproveWatch). Accept notification permissions on both.

## Phase 3 — Live end-to-end test (sandbox)

`wrangler.toml` should still have `APNS_ENV = "sandbox"` for Xcode builds.

1. 👤 In the app: tap **Set Up**, note the pairing code.
2. On this Mac: `curl -fsSL https://christopherrathbun.com/claude-approve/install.sh | bash`
   and enter the code.
3. Verify both devices registered (expect ios + watchos):
   ```bash
   TOKEN=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.claude/watch-approve/config.json')))['worker_secret'])")
   curl -s https://christopherrathbun.com/api/claude-approve/devices -H "Authorization: Bearer $TOKEN"
   ```
4. Fire a test approval:
   ```bash
   curl -s -X POST https://christopherrathbun.com/api/claude-approve/requests \
     -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"tool":"Bash","detail":"end-to-end test","cwd":"/tmp"}'
   ```
   👤 Watch should buzz with Approve/Deny buttons. Tap Approve.
5. Confirm: re-GET the request (`/requests/<id>`) → `"status":"approved"`.
6. Full loop: `~/.claude/watch-approve/away on`, restart Claude Code, ask it
   to create a file, approve from the wrist, confirm it proceeds.

**Gate:** all of the above. If push doesn't arrive: APNS_ENV must be
`sandbox` for Xcode-installed builds; check `wrangler tail` for `apns error`
lines (403 = bad key/team id; 400 BadDeviceToken = env mismatch).

## Phase 4 — App Store

👤 One-time in App Store Connect (appstoreconnect.apple.com):
- My Apps → **+** → New App: iOS, name, bundle id
  `com.christopherrathbun.ClaudeApprove`, SKU anything.
- App Privacy: policy URL
  `https://christopherrathbun.com/claude-approve/privacy.html`; data
  collected: Identifiers + User Content, not linked, no tracking.

Then:

```bash
# flip push env to production
sed -i '' 's/APNS_ENV = "sandbox"/APNS_ENV = "production"/' wrangler.toml
./apps/ClaudeApprove/setup-backend.sh --deploy-only
git checkout wrangler.toml   # or commit the flip — human's call

./apps/ClaudeApprove/release.sh   # archive + upload to App Store Connect
```

👤 In App Store Connect: TestFlight → install via TestFlight on the phone,
re-verify Phase 3 (now on production APNs). Then App Store tab → select
build, screenshots, description → Submit for Review.

Review notes to include: "Utility for developers using Anthropic's Claude
Code CLI. Pairing: tap Set Up in-app for a code; the reviewer can see the
approval flow in the attached video. Requests are created by the user's own
machine via the documented installer at
https://christopherrathbun.com/claude-approve/."

## Known post-launch tasks

- Sandbox + production users can coexist only on one APNS_ENV — once on
  production, use TestFlight builds for your own testing too.
- Watch the DO: `wrangler tail` during the first external signups.
- Update the landing page's "App Store link coming soon" once approved.
