# christopherrathbun.com

Cloudflare Worker serving a personal site + several sub-apps. No build
step; deploy with `wrangler deploy` (see gotcha below).

## Layout

- `src/worker.js` — routing; each sub-app has a handler module in `src/`
- `src/twisted-chess-do.js`, `src/claude-approve.js` — Durable Objects
- `public/` — static assets (Workers Assets binding)
- `tools/watch-approve/` — Claude Code → Apple Watch approval hook (source
  of truth; copies are served from `public/claude-approve/`)
- `apps/ClaudeApprove/` — SwiftUI iPhone+Watch app; see `SETUP.md` and
  `RELEASE_RUNBOOK.md` there. Project is generated: edit `project.yml`,
  run `bootstrap.sh` (XcodeGen) — never hand-edit the .xcodeproj.
- `test/engine.test.mjs` — chess engine tests (`node test/engine.test.mjs`)

## Gotchas

- **`src/users-dashboard.js` and `src/vighnaa.js` are NOT in git** but are
  imported by worker.js — they exist only on the owner's deploy machine.
  Fresh clones don't build; never deploy with stub versions of these files,
  and never commit stubs.
- ClaudeApprove backend (`/api/claude-approve`) is multi-tenant: anonymous
  `ca_` account tokens, single-use pairing codes. Tenant isolation is
  enforced in the DO — keep `account_token` scoping on every query.
- APNs environment is per device: the app reports `sandbox` (Debug/Xcode) or
  `production` (Release) when registering, and the backend picks the host per
  device. `APNS_ENV` in wrangler.toml is only the fallback for old rows.
- `public/claude-approve/{watch_approve.py,away}` are copies of the
  `tools/watch-approve/` originals — edit the `tools/` copies. The
  wrangler `[build]` command re-syncs them on every deploy.
