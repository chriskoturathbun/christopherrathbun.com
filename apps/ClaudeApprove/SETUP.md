# ClaudeApprove — your own iPhone + Watch approval app

Approve Claude Code permission prompts from a native app: push notification
with **real Approve/Deny buttons on the Apple Watch**, plus an in-app list of
pending requests on both devices.

```
Claude Code hook ──▶ christopherrathbun.com/api/claude-approve (Worker + DO)
                                   │ APNs push
                                   ▼
                     iPhone app  +  Watch app  ── tap Approve ──▶ Worker
                                   ▲                                │
                     hook polls the request until it resolves ◀────┘
```

Everything is yours: your Worker, your Apple developer account, no ntfy.

## Prerequisites

- **Apple Developer Program** membership ($99/yr) — push notifications
  require it. Enroll at https://developer.apple.com/programs/enroll/
- Xcode (Mac App Store), signed in with that Apple ID
  (Xcode → Settings → Accounts)

## Part 1 — Backend (10 min, on your Mac)

The Worker code is already in this repo (`src/claude-approve.js`, wired into
`src/worker.js` and `wrangler.toml`). From the repo root on the machine you
normally deploy from:

```bash
# 1. The shared secret the hook and the app both use (pick something long):
wrangler secret put APPROVE_SECRET

# 2. APNs credentials — created in Part 2 step 3; come back for these:
wrangler secret put APNS_TEAM_ID    # 10-char Team ID (developer.apple.com → Membership)
wrangler secret put APNS_KEY_ID     # 10-char Key ID of your APNs key
wrangler secret put APNS_P8         # paste the full contents of the .p8 file

# 3. Deploy
wrangler deploy
```

`APNS_ENV` in wrangler.toml is `"sandbox"` — correct while you run the app
from Xcode. Change it to `"production"` when you move to TestFlight/App Store.

Sanity check (expect `{"requests":[]}`):

```bash
curl -s https://christopherrathbun.com/api/claude-approve/requests \
  -H "Authorization: Bearer YOUR_APPROVE_SECRET"
```

## Part 2 — Apple setup (15 min, one-time)

1. **Team ID**: developer.apple.com → Account → Membership details → copy it.
2. **App IDs** are created automatically by Xcode when you set the bundle ids
   in Part 3 — nothing to do here.
3. **APNs key**: developer.apple.com → Account → Certificates, Identifiers &
   Profiles → **Keys** → **+** → name it `ClaudeApprove APNs`, check
   **Apple Push Notifications service (APNs)** → Continue → Register →
   **Download** the `.p8` file (one-time download — keep it safe) and note
   the **Key ID**. Feed all three values into `wrangler secret put` above.

## Part 3 — Xcode project (20 min)

1. Xcode → **File → New → Project → iOS → App**. Product Name:
   `ClaudeApprove`, Interface: SwiftUI, Language: Swift. Set your Team.
   Bundle identifier: e.g. `com.christopherrathbun.ClaudeApprove`.
2. **File → New → Target → watchOS → App**: check **"Watch App for Existing
   iOS App"**, name it `ClaudeApproveWatch`. Xcode gives it the bundle id
   `com.christopherrathbun.ClaudeApprove.watchkitapp` — keep it.
3. Delete the template `ContentView.swift` / `…App.swift` files Xcode made
   in **both** targets, then drag these folders in from this repo:
   - `Shared/` → add to **both** targets (check both boxes in the dialog)
   - `iOSApp/` → iOS target only
   - `WatchApp/` → watch target only
4. **Capabilities** (Signing & Capabilities tab, **both** targets):
   **+ Capability → Push Notifications**.
5. Select your iPhone as the run destination and hit **Run**. Accept the
   notification permission prompt. Then select the watch scheme and **Run**
   on your paired Watch (first install can take a few minutes).
6. In the iPhone app: tap the gear → the server URL is prefilled; enter your
   `APPROVE_SECRET` → Done. It syncs to the Watch automatically.

Launching each app registers its own device token with your Worker — check:

```bash
curl -s https://christopherrathbun.com/api/claude-approve/devices \
  -H "Authorization: Bearer YOUR_APPROVE_SECRET"
```

You want **two** devices listed: `ios` and `watchos`.

## Part 4 — Point the hook at your Worker (2 min)

```bash
python3 - <<'PY'
import json, os
p = os.path.expanduser("~/.claude/watch-approve/config.json")
cfg = json.load(open(p)) if os.path.exists(p) else {}
cfg["backend"] = "worker"
cfg["worker_url"] = "https://christopherrathbun.com/api/claude-approve"
cfg["worker_secret"] = "YOUR_APPROVE_SECRET"   # <-- edit me
cfg.setdefault("timeout_seconds", 240)
with open(p, "w") as f: json.dump(cfg, f, indent=2)
print("hook now uses:", cfg["worker_url"])
PY
```

(To go back to ntfy, set `"backend": "ntfy"` — the old config keys are
still honored.)

## Try it

```bash
~/.claude/watch-approve/away on
```

Ask Claude Code to create a file. Your Watch buzzes — **Approve and Deny
buttons are right on the notification** (they're a static category from your
own app, which is exactly what watchOS mirrors properly). Or open the Watch
app for the pending list with buttons. Claude proceeds within ~3 seconds of
the tap.

## Troubleshooting

- **No push arrives**: check `APNS_ENV` matches how the app was installed
  (Xcode run = `sandbox`, TestFlight/App Store = `production`); confirm both
  devices are registered (curl above); pushes only reach the Watch directly
  when the app is installed on the Watch — otherwise iOS mirrors the phone's.
- **401 from curl**: secret mismatch between `wrangler secret put
  APPROVE_SECRET` and what you're sending.
- **Push arrives but buttons missing**: launch the app once manually — the
  notification category registers on first app launch.
- **`wrangler deploy` fails on missing users-dashboard.js/vighnaa.js**:
  deploy from the machine that has those files (they're not committed to
  git; see repo README).
