# ClaudeApprove — approve Claude Code from your Apple Watch

A product anyone can use: download the iPhone + Watch app, tap **Set Up**,
run one command on the Mac, done. No Cloudflare account, no secrets to
copy, no Shortcuts.

```
                          you (the operator)
                    host the backend + ship the app
                                  │
   user's Mac                     ▼                    user's iPhone/Watch
 Claude Code hook ──▶ /api/claude-approve (Worker+DO) ◀── ClaudeApprove app
   POST /requests          multi-tenant, paired           APNs push, native
   long-poll ?wait=1       by one-time codes              Approve/Deny buttons
```

## The user experience (what "anyone" does)

1. Install **ClaudeApprove** from the App Store (iPhone; the Watch app
   installs alongside).
2. Open it, tap **Set Up** → it shows a pairing code like `MKT4-P7XW`.
3. On their Mac:
   ```bash
   curl -fsSL https://christopherrathbun.com/claude-approve/install.sh | bash
   ```
   …enter the code. The installer claims it, installs the Claude Code hook,
   and wires `~/.claude/settings.json` (with a backup).
4. Restart Claude Code, then `~/.claude/watch-approve/away on` when leaving.
5. Watch buzzes → tap **Approve** on the notification → Claude proceeds in
   ~100 ms.

Accounts are anonymous random tokens; pairing codes are single-use and
expire in 10 minutes; each user only ever sees their own requests
(tenant-isolation is enforced server-side and covered by tests).

## Operator guide (you)

### Backend

```bash
./apps/ClaudeApprove/setup-backend.sh     # APNs secrets + deploy
./apps/ClaudeApprove/setup-backend.sh --deploy-only   # redeploys
```

Secrets: `APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_P8` (the .p8 contents).
`APNS_ENV` in wrangler.toml: `"sandbox"` for Xcode-installed builds,
`"production"` for TestFlight/App Store. Deploy from the Mac that has the
uncommitted `users-dashboard.js`/`vighnaa.js` files.

Public pages (served from `public/claude-approve/`):
- `/claude-approve/` — landing page
- `/claude-approve/privacy.html` — privacy policy (App Store requires this URL)
- `/claude-approve/install.sh` + hook files — the one-line installer

### Build the app

```bash
./apps/ClaudeApprove/bootstrap.sh   # XcodeGen -> ClaudeApprove.xcodeproj
```

Set your Team on both targets, Run on iPhone, Run on Watch. For
distribution: Product → Archive → App Store Connect.

### App Store submission checklist

1. App Store Connect → New App: name **ClaudeApprove** (or your pick),
   bundle id `com.christopherrathbun.ClaudeApprove`.
2. Privacy policy URL: `https://christopherrathbun.com/claude-approve/privacy.html`.
3. App Privacy questionnaire: collects **Identifiers** (anonymous account
   token, push tokens) and **User Content** (approval request summaries),
   not linked to identity, not used for tracking.
4. Flip `APNS_ENV` to `"production"` and redeploy **before** TestFlight.
5. Review notes: explain the pairing flow and include a demo pairing code
   you generate right before submitting (codes last 10 min — better: attach
   a screen recording of the full flow).
6. Export compliance: standard HTTPS only → "uses exempt encryption".

### API quick reference

All under `/api/claude-approve`. Auth: `Authorization: Bearer <ca_ token>`
except the pairing endpoints.

| Route | Auth | Purpose |
|-------|------|---------|
| `POST /pair/new` | none | create account + first pairing code (app) |
| `POST /pair/claim {code}` | none | exchange code for account token (installer) |
| `POST /pair/code` | token | extra pairing code (more Macs) |
| `POST /devices` | token | register APNs device token |
| `POST /requests` | token | hook creates an approval request (pushes) |
| `GET /requests/:id?wait=1` | token | hook long-polls the decision |
| `POST /requests/:id/respond` | token | app approves/denies |
| `GET /requests?status=pending` | token | app's pending list |

### Scaling notes

Everything lives in one Durable Object ("hub") — simple and fine into the
thousands of users. If it ever becomes hot, shard by account: route
`idFromName(accountToken)` and move pair-code lookup to its own directory
DO. The schema already keys everything by `account_token`.

### Self-hosters

Power users can run their own Worker and point the app at it via
`claudeapprove://config?url=https://their.domain/api/claude-approve`
(open the link before tapping Set Up), and set `CLAUDE_APPROVE_URL` /
`CLAUDE_APPROVE_ASSETS` when running the installer.
