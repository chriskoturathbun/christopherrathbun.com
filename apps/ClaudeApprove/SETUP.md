# ClaudeApprove — approve Claude Code from your Apple Watch

Native iPhone + Watch app: when Claude Code needs permission, your Watch
buzzes with **real Approve/Deny buttons on the notification**. A tap
unblocks Claude **instantly** — the hook long-polls your Worker, so the
decision lands in ~100 ms, not on a polling delay.

```
Claude Code hook ──▶ christopherrathbun.com/api/claude-approve (Worker + DO)
                                   │ APNs push (instant)
                                   ▼
                     iPhone app  +  Watch app  ── tap Approve ──▶ Worker
                                   ▲                                │
                     hook long-polls (?wait=1) ◀── resolves instantly
```

## One-time prerequisites (~20 min, mostly Apple)

1. **Apple Developer Program** ($99/yr): https://developer.apple.com/programs/enroll/
   — push notifications require it. Note your **Team ID** (Account → Membership).
2. **APNs key**: developer.apple.com → Certificates, Identifiers & Profiles →
   **Keys** → **+** → check **APNs** → Register → **Download the .p8**
   (one-time download) and note the **Key ID**.
3. Xcode installed and signed in (Xcode → Settings → Accounts).
4. `brew install xcodegen qrencode` (bootstrap.sh installs xcodegen for you
   if you skip this; qrencode is optional but gives you a scannable QR).

## The fast path

From the repo root on your Mac (`git pull` first):

```bash
# 1 — backend + hook + config QR, one command (asks for Team ID, Key ID, .p8):
./apps/ClaudeApprove/setup-backend.sh

# 2 — generate + open the Xcode project, fully wired (targets, entitlements,
#     watch embedding, URL scheme):
./apps/ClaudeApprove/bootstrap.sh
```

Then the five taps:

1. **Tap your Team** in Xcode's Signing & Capabilities (both targets), then
2. **Tap Run** with your iPhone as destination (allow notifications),
3. **Tap Run** on the ClaudeApproveWatch scheme with your Watch as destination,
4. **Scan the QR** that setup-backend.sh printed (or tap the link it shows) —
   the app configures itself and syncs the settings to your Watch,
5. **Tap Approve** on your wrist when the test request comes in:

```bash
~/.claude/watch-approve/away on
# then ask Claude Code to create a test file
```

Restart Claude Code once after step 4 if it was running (hooks load at startup).

## Verify

```bash
SECRET=$(cat ~/.claude/watch-approve/.approve-secret)
# both devices registered?
curl -s https://christopherrathbun.com/api/claude-approve/devices \
  -H "Authorization: Bearer $SECRET"
# fire a fake approval request end-to-end (watch should buzz):
curl -s -X POST https://christopherrathbun.com/api/claude-approve/requests \
  -H "Authorization: Bearer $SECRET" -H "Content-Type: application/json" \
  -d '{"tool":"Bash","detail":"echo hello from setup","cwd":"/tmp"}'
```

## Day to day

- `away on` when you leave (or install `tools/watch-approve/setup-auto-away.sh`
  to follow your Mac's screen lock automatically), `away off` when back.
- Approve from the notification buttons (phone or watch), or open either app
  for the pending list.
- No answer within 4 minutes → Claude falls back to the normal terminal prompt.

## Configuration notes

- `APNS_ENV` in wrangler.toml is `"sandbox"` — correct for apps installed by
  Xcode. Flip to `"production"` when you distribute via TestFlight/App Store.
- The hook config lives at `~/.claude/watch-approve/config.json`
  (`backend: "worker"`); switch `backend` to `"ntfy"` to go back to ntfy.
- Bundle IDs are set in `project.yml` (`com.christopherrathbun.ClaudeApprove`
  and `.watchkitapp`). If Xcode says the ID is taken, change the prefix there
  and re-run bootstrap.sh.

## Troubleshooting

- **No push**: `APNS_ENV` must match the install method (Xcode = sandbox);
  re-check both devices show up in the `devices` curl above; launch each app
  once manually so it registers.
- **401s**: the same secret must be in Cloudflare (`APPROVE_SECRET`), the Mac
  (`~/.claude/watch-approve/config.json`), and the app (via the QR link).
  Re-running setup-backend.sh keeps the secret stable and re-syncs everything.
- **Buttons missing on the notification**: launch the app once (categories
  register at first launch), then send the fake request again.
- **`wrangler deploy` fails on users-dashboard.js/vighnaa.js**: deploy from
  the Mac that has those files — they were never committed to git.

## Manual Xcode setup (fallback if you'd rather not use XcodeGen)

1. File → New → Project → iOS App, SwiftUI, name `ClaudeApprove`.
2. File → New → Target → watchOS → App, check "Watch App for Existing iOS
   App", name `ClaudeApproveWatch`.
3. Delete the template swift files in both targets; drag in `Shared/` (both
   targets), `iOSApp/` (iOS), `WatchApp/` (watch).
4. Both targets: Signing & Capabilities → + Capability → Push Notifications.
5. iOS target → Info → URL Types → add scheme `claudeapprove`.
