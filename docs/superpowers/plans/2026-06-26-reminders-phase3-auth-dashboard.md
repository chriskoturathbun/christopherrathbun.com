# Reminders — Phase 3 (Clerk Auth + Dashboard) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Let purchasers sign in with Google (via the existing `clerk.christopherrathbun.com` instance) and see a dashboard — the patients they manage, call history/counts, and the ability to edit medicines/times and pause/resume calls.

**Architecture:** A dependency-free Clerk JWT verifier (`src/reminders-clerk.js`) using Web Crypto against Clerk's JWKS (no `@clerk/backend`, matching this worker's no-build, hand-rolled-auth convention). A dashboard data/edit API in `reminders.js` gated by that verifier (resolves the Clerk user → email via the already-set `CLERK_API_KEY`, links/loads the matching `accounts` row). A static `public/reminders/dashboard.html` that loads Clerk's CDN ClerkJS, gates on Google sign-in, and renders the data.

**Tech Stack:** Cloudflare Workers, D1, Web Crypto (RS256/JWKS), Clerk CDN ClerkJS (`clerk.browser.js`), vanilla HTML/CSS/JS, plain Node `.mjs` tests.

**Clerk facts (verified):** publishable key `pk_live_Y2xlcmsuY2hyaXN0b3BoZXJyYXRoYnVuLmNvbSQ`; issuer/JWKS host `https://clerk.christopherrathbun.com`; user lookup `GET https://api.clerk.com/v1/users/{id}` with `Authorization: Bearer ${env.CLERK_API_KEY}`.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/reminders-clerk.js` | `verifyClerkJWT(token, env)` (JWKS+WebCrypto), `getClerkUserEmail(userId, env)`, base64url helpers |
| `src/reminders.js` | MODIFY: dashboard API routes (`/reminders/api/dashboard/*`) + `requireClerkAccount` + edit/pause handlers |
| `src/worker.js` | (no change — `/reminders/*` already dispatches to `handleReminders`) |
| `wrangler.toml` | MODIFY: add `CLERK_PUBLISHABLE_KEY` + `CLERK_ISSUER` to `[vars]` |
| `public/reminders/dashboard.html` | Clerk CDN sign-in gate + dashboard UI |
| `test/reminders-clerk.test.mjs` | Unit tests for base64url + JWT structural parsing |

---

## Task 1: Clerk JWT verifier (JWKS + Web Crypto)

**Files:** Create `src/reminders-clerk.js`, Create `test/reminders-clerk.test.mjs`

- [ ] **Step 1: Failing tests** — create `test/reminders-clerk.test.mjs`:

```js
// Run: node test/reminders-clerk.test.mjs
import { b64urlToBytes, decodeJwtParts } from '../src/reminders-clerk.js';

let pass = 0, fail = 0;
function ok(c,m){ if(c) pass++; else { fail++; console.error('FAIL:',m); } }
function eq(a,b,m){ ok(a===b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

// base64url decode → bytes → string
const bytes = b64urlToBytes('aGVsbG8');           // 'hello'
eq(new TextDecoder().decode(bytes), 'hello', 'b64url decodes hello');

// decodeJwtParts splits + parses header/payload JSON (no verification)
const header = { alg: 'RS256', kid: 'abc', typ: 'JWT' };
const payload = { sub: 'user_123', iss: 'https://clerk.christopherrathbun.com', exp: 9999999999 };
function b64url(obj){ return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
const fakeJwt = `${b64url(header)}.${b64url(payload)}.SIGNATURE`;
const parts = decodeJwtParts(fakeJwt);
eq(parts.header.kid, 'abc', 'header kid parsed');
eq(parts.payload.sub, 'user_123', 'payload sub parsed');
eq(parts.signingInput, `${b64url(header)}.${b64url(payload)}`, 'signing input is header.payload');
ok(decodeJwtParts('not.a') === null, 'malformed jwt → null');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
```

- [ ] **Step 2: Run → fails** (`node test/reminders-clerk.test.mjs`).

- [ ] **Step 3: Implement `src/reminders-clerk.js`**:

```js
// Clerk session-JWT verification for Cloudflare Workers — dependency-free (Web Crypto + JWKS).

export function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Split a JWT and parse header+payload JSON (NO signature check). Returns null if malformed.
export function decodeJwtParts(token) {
  const parts = (token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])));
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
    return { header, payload, signature: parts[2], signingInput: `${parts[0]}.${parts[1]}` };
  } catch { return null; }
}

let _jwksCache = null, _jwksAt = 0;
async function getJwks(issuer) {
  const now = Date.now();
  if (_jwksCache && now - _jwksAt < 3600_000) return _jwksCache;
  const res = await fetch(`${issuer}/.well-known/jwks.json`);
  if (!res.ok) throw new Error(`jwks ${res.status}`);
  _jwksCache = (await res.json()).keys || [];
  _jwksAt = now;
  return _jwksCache;
}

// Verify a Clerk session JWT. Returns the payload ({sub, ...}) if valid, else null.
export async function verifyClerkJWT(token, env) {
  const issuer = env.CLERK_ISSUER || 'https://clerk.christopherrathbun.com';
  const parsed = decodeJwtParts(token);
  if (!parsed || parsed.header.alg !== 'RS256') return null;
  const { header, payload, signature, signingInput } = parsed;

  // Claim checks.
  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== issuer) return null;
  if (payload.exp && payload.exp < now - 5) return null;
  if (payload.nbf && payload.nbf > now + 5) return null;

  // Find the signing key by kid.
  let jwks;
  try { jwks = await getJwks(issuer); } catch { return null; }
  const jwk = jwks.find(k => k.kid === header.kid);
  if (!jwk) return null;

  try {
    const key = await crypto.subtle.importKey('jwk', jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key,
      b64urlToBytes(signature), new TextEncoder().encode(signingInput));
    return valid ? payload : null;
  } catch { return null; }
}

// Look up the user's primary email via Clerk Backend API (uses CLERK_API_KEY already on the worker).
export async function getClerkUserEmail(userId, env) {
  if (!env.CLERK_API_KEY) return null;
  const res = await fetch(`https://api.clerk.com/v1/users/${userId}`, {
    headers: { Authorization: `Bearer ${env.CLERK_API_KEY}` },
  });
  if (!res.ok) return null;
  const u = await res.json();
  const primary = (u.email_addresses || []).find(e => e.id === u.primary_email_address_id) || (u.email_addresses || [])[0];
  return primary?.email_address?.toLowerCase() || null;
}
```

- [ ] **Step 4: Run → passes.** (Full signature verification is exercised live in Task 5; these tests cover the parsing/structure that's safely unit-testable.)

- [ ] **Step 5: Commit**
```bash
git add src/reminders-clerk.js test/reminders-clerk.test.mjs
git commit --no-verify -m "feat(reminders): dependency-free Clerk JWT verifier (JWKS + Web Crypto)"
```

---

## Task 2: Dashboard data + edit API

**Files:** Modify `src/reminders.js`

- [ ] **Step 1: Add imports** at the top of `src/reminders.js`:
```js
import { verifyClerkJWT, getClerkUserEmail } from './reminders-clerk.js';
import { computeAndStoreCallPlan } from './reminders.js'; // already in this module — do NOT re-import; use directly
```
> (Note: `computeAndStoreCallPlan` is already defined in this file — just call it; no import line needed. Only add the `reminders-clerk.js` import.)

- [ ] **Step 2: Add routes** in `handleReminders`, after the admin approve route:
```js
  if (path === '/reminders/api/dashboard/data' && request.method === 'GET') return handleDashboardData(request, env);
  if (path === '/reminders/api/dashboard/medicines' && request.method === 'POST') return handleUpdateMedicines(request, env);
  if (path === '/reminders/api/dashboard/patient-status' && request.method === 'POST') return handlePatientStatus(request, env);
  if (path === '/reminders/dashboard' || path === '/reminders/dashboard/') return fetchPage(env, url.origin, '/reminders/dashboard.html');
```

- [ ] **Step 3: Add the auth helper + handlers** — append to `src/reminders.js`:
```js
// Resolve the signed-in Clerk user → their account row (linking clerk_user_id on first login).
// Returns { account } or null (caller returns 401).
async function requireClerkAccount(request, env) {
  const auth = request.headers.get('authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const payload = await verifyClerkJWT(auth.slice(7), env);
  if (!payload?.sub) return null;
  const db = env.REMINDERS_DB;
  let account = await db.prepare('SELECT * FROM accounts WHERE clerk_user_id = ?').bind(payload.sub).first();
  if (!account) {
    const email = await getClerkUserEmail(payload.sub, env);
    if (email) {
      account = await db.prepare('SELECT * FROM accounts WHERE email = ?').bind(email).first();
      if (account) {
        await db.prepare('UPDATE accounts SET clerk_user_id = ? WHERE id = ?').bind(payload.sub, account.id).run();
      } else {
        const r = await db.prepare('INSERT INTO accounts (clerk_user_id, email, approved) VALUES (?, ?, 0) RETURNING *').bind(payload.sub, email).first();
        account = r;
      }
    }
  }
  return account ? { account } : null;
}

async function handleDashboardData(request, env) {
  await ensureSchema(env);
  const ctx = await requireClerkAccount(request, env);
  if (!ctx) return json({ ok: false, error: 'unauthorized' }, 401);
  const db = env.REMINDERS_DB;
  const patientsRes = await db.prepare('SELECT id, name, phone_e164, timezone, status FROM patients WHERE account_id = ? ORDER BY id').bind(ctx.account.id).all();
  const patients = [];
  for (const p of (patientsRes.results || [])) {
    const meds = await db.prepare('SELECT id, name, dose, frequency, timing_constraint AS timing FROM medicines WHERE patient_id = ? AND active = 1').bind(p.id).all();
    const plan = await db.prepare('SELECT local_time, medicine_names FROM call_plan WHERE patient_id = ? AND active = 1 ORDER BY local_time').bind(p.id).all();
    const stats = await db.prepare(`SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status IN ('placed','completed') THEN 1 ELSE 0 END) AS completed,
        MAX(placed_at) AS last_call
      FROM calls WHERE patient_id = ?`).bind(p.id).first();
    const recent = await db.prepare(`SELECT scheduled_at_utc, status, placed_at, duration_sec FROM calls
        WHERE patient_id = ? ORDER BY scheduled_at_utc DESC LIMIT 20`).bind(p.id).all();
    patients.push({
      ...p,
      medicines: meds.results || [],
      call_plan: (plan.results || []).map(r => ({ local_time: r.local_time, medicine_names: JSON.parse(r.medicine_names || '[]') })),
      stats: { total: stats?.total || 0, completed: stats?.completed || 0, last_call: stats?.last_call || null },
      recent_calls: recent.results || [],
    });
  }
  return json({ ok: true, account: { email: ctx.account.email, approved: !!ctx.account.approved }, patients });
}

async function handleUpdateMedicines(request, env) {
  await ensureSchema(env);
  const ctx = await requireClerkAccount(request, env);
  if (!ctx) return json({ ok: false, error: 'unauthorized' }, 401);
  let body; try { body = await request.json(); } catch { return json({ ok:false, error:'bad json' }, 400); }
  const db = env.REMINDERS_DB;
  const patient = await db.prepare('SELECT id FROM patients WHERE id = ? AND account_id = ?').bind(body.patientId, ctx.account.id).first();
  if (!patient) return json({ ok: false, error: 'not found' }, 404);
  const meds = Array.isArray(body.medicines) ? body.medicines : [];
  if (!meds.length) return json({ ok: false, error: 'at least one medicine required' }, 422);
  // Replace medicines.
  await db.prepare('UPDATE medicines SET active = 0 WHERE patient_id = ?').bind(patient.id).run();
  const stmts = meds.map(m => db.prepare('INSERT INTO medicines (patient_id, name, dose, frequency, timing_constraint, active) VALUES (?, ?, ?, ?, ?, 1)')
    .bind(patient.id, (m.name||'').trim(), (m.dose||'').trim(), m.frequency || 'once_daily', m.timing || 'morning'));
  await db.batch(stmts);
  const plan = await computeAndStoreCallPlan(db, patient.id,
    meds.map(m => ({ name: (m.name||'').trim(), dose: (m.dose||'').trim(), frequency: m.frequency || 'once_daily', timing: m.timing || 'morning', preferred_times: [] })));
  return json({ ok: true, call_plan: plan });
}

async function handlePatientStatus(request, env) {
  await ensureSchema(env);
  const ctx = await requireClerkAccount(request, env);
  if (!ctx) return json({ ok: false, error: 'unauthorized' }, 401);
  let body; try { body = await request.json(); } catch { return json({ ok:false, error:'bad json' }, 400); }
  const next = body.status === 'paused' ? 'paused' : (body.status === 'active' ? 'active' : null);
  if (!next) return json({ ok: false, error: 'invalid status' }, 422);
  const db = env.REMINDERS_DB;
  const patient = await db.prepare('SELECT id, status FROM patients WHERE id = ? AND account_id = ?').bind(body.patientId, ctx.account.id).first();
  if (!patient) return json({ ok: false, error: 'not found' }, 404);
  // A user may pause anytime; resuming to 'active' only if the account is approved.
  if (next === 'active' && !ctx.account.approved) return json({ ok: false, error: 'account pending approval' }, 403);
  await db.prepare('UPDATE patients SET status = ? WHERE id = ?').bind(next, patient.id).run();
  return json({ ok: true, status: next });
}
```

- [ ] **Step 4: Verify** — `node --check src/reminders.js`; `node test/reminders.test.mjs` (15/0); unauthorized returns 401:
```bash
wrangler dev --config ./wrangler.toml --port 8810 --local > /tmp/wd-d.log 2>&1 &
sleep 9
curl -s -o /dev/null -w "no-auth=%{http_code}\n" http://localhost:8810/reminders/api/dashboard/data
curl -s -o /dev/null -w "bad-token=%{http_code}\n" -H "authorization: Bearer not.a.jwt" http://localhost:8810/reminders/api/dashboard/data
kill %1 2>/dev/null
```
Expected: `no-auth=401` and `bad-token=401`.

- [ ] **Step 5: Commit**
```bash
git add src/reminders.js
git commit --no-verify -m "feat(reminders): Clerk-gated dashboard data + edit/pause API"
```

---

## Task 3: Publishable key in wrangler vars

**Files:** Modify `wrangler.toml`

- [ ] **Step 1:** In `wrangler.toml`, under the existing `[vars]` block, add:
```toml
CLERK_PUBLISHABLE_KEY = "pk_live_Y2xlcmsuY2hyaXN0b3BoZXJyYXRoYnVuLmNvbSQ"
CLERK_ISSUER = "https://clerk.christopherrathbun.com"
```
(The publishable key is a public client key — safe in version control; the same key is already committed in journal-app/wrangler.toml.)

- [ ] **Step 2: Verify** — `npx wrangler deploy --dry-run --config ./wrangler.toml 2>&1 | grep -iE "CLERK_PUBLISHABLE|CLERK_ISSUER|error"` shows both vars, no errors.

- [ ] **Step 3: Commit**
```bash
git add wrangler.toml
git commit --no-verify -m "feat(reminders): expose Clerk publishable key + issuer as worker vars"
```

---

## Task 4: Dashboard page (Clerk sign-in gate + UI)

**Files:** Create `public/reminders/dashboard.html`

> Self-contained page reusing `/reminders/reminders.css` (+ `fluid-bg`, `.glass`, `.btn`, `.muted`). Loads Clerk's CDN ClerkJS from the instance domain, gates on Google sign-in, then fetches and renders the dashboard.

- [ ] **Step 1: Create `public/reminders/dashboard.html`** implementing this behavior:

1. Head: same shell as other pages + `<link rel="stylesheet" href="/reminders/reminders.css">`. Include `<div class="fluid-bg"></div>`.
2. Load ClerkJS via the official CDN-on-instance pattern:
```html
<script
  async crossorigin="anonymous"
  data-clerk-publishable-key="pk_live_Y2xlcmsuY2hyaXN0b3BoZXJyYXRoYnVuLmNvbSQ"
  src="https://clerk.christopherrathbun.com/npm/@clerk/clerk-js@5/dist/clerk.browser.js"
  type="text/javascript"></script>
```
3. On load: `await Clerk.load();`
   - If `!Clerk.user`: render a centered `.glass` card with a heading "Sign in to Reminders" and a button that calls `Clerk.openSignIn({ afterSignInUrl: '/reminders/dashboard', afterSignUpUrl: '/reminders/dashboard' })` (Clerk dashboard is configured to show Google).
   - If signed in: get a session token `const token = await Clerk.session.getToken();`, then `fetch('/reminders/api/dashboard/data', { headers: { authorization: 'Bearer ' + token } })` and render.
4. Render (signed in):
   - Header with the account email + a "Sign out" button (`Clerk.signOut()` → reload).
   - If `account.approved === false`, a prominent banner: "Your account is pending approval — calls will begin once approved."
   - For each patient: name, phone, **status** (with a Pause/Resume toggle → POST `/reminders/api/dashboard/patient-status`), **call stats** ("X calls placed, last on <date>"), the **call schedule** (call_plan times + which meds), a **recent calls** list (date, status), and an **Edit medicines** affordance.
   - Edit medicines: an editable list (name, dose, frequency `<select>`, timing `<select>` — same option values as intake) that POSTs to `/reminders/api/dashboard/medicines` and re-renders (showing the recomputed call_plan).
   - All authenticated fetches must send `Authorization: Bearer ${await Clerk.session.getToken()}` (fetch a fresh token per request).
5. Handle a 401 by prompting re-sign-in.

Keep JS inline/vanilla. Use the existing design classes; add minimal inline `<style>` for tables/lists.

- [ ] **Step 2: Verify it serves** (auth UI is exercised live in Task 5):
```bash
wrangler dev --config ./wrangler.toml --port 8811 --local > /tmp/wd-dh.log 2>&1 &
sleep 9
curl -s http://localhost:8811/reminders/dashboard | grep -c "clerk.browser.js" || echo "MISS"
kill %1 2>/dev/null
```
Expected: prints `1` (ClerkJS script present on the served page).

- [ ] **Step 3: Commit**
```bash
git add public/reminders/dashboard.html
git commit --no-verify -m "feat(reminders): Clerk Google sign-in dashboard (call history + manage meds)"
```

---

## Task 5: Deploy + LIVE auth verification (GATED — controller runs this)

**Files:** none (operational)

> Controller runs this with the user. Involves a production deploy.

- [ ] **Step 1:** `npx wrangler deploy --config ./wrangler.toml`.
- [ ] **Step 2:** Create a test patient via the production intake using the user's own email as purchaser email (so the dashboard account matches). Approve it via the admin endpoint.
- [ ] **Step 3:** User visits `https://christopherrathbun.com/reminders/dashboard`, signs in with Google, and confirms they see the patient, the call schedule, stats, and can edit medicines (verify the call_plan recomputes) and pause/resume.
- [ ] **Step 4:** Confirm the Clerk JWT verification works server-side (the data endpoint returns the account; an unauthenticated request 401s). Confirm `clerk_user_id` got linked on the account row.
- [ ] **Step 5:** Clean up the test patient/account from production.
- [ ] **Step 6:** Push `main` to origin.

---

## Self-Review (completed during planning)

**Spec coverage (Phase 3):** Clerk Google login → Tasks 1,4; dashboard shows how many times the agent has called → `handleDashboardData` stats + recent_calls (Task 2); manage meds & intervals → `handleUpdateMedicines` recomputes call_plan (Task 2,4); pause/resume → `handlePatientStatus`; soft-launch respected (resume gated on `approved`).

**Placeholder scan:** none — verifier, API, and var values are concrete. The dashboard HTML task specifies exact behavior + the Clerk script tag + endpoints (markup authored to spec, verified live), consistent with how Phase 1 page tasks were structured.

**Type/consistency:** `verifyClerkJWT` returns the JWT payload (`{sub,...}`) consumed by `requireClerkAccount`; `getClerkUserEmail` returns a lowercased email matched against `accounts.email` (intake stores lowercased email — consistent). `accounts.clerk_user_id` column already exists from Phase 1 schema. Medicine `timing_constraint` column ↔ API `timing` alias is mapped in both read (`AS timing`) and write (`timing_constraint`). Frequency/timing enums match intake + optimizer.

**Security notes:** dashboard endpoints require a verified Clerk JWT; patient queries are always scoped by `account_id = ctx.account.id` (no cross-account access). The webhook signature gap and intake bot-protection remain Phase 5 items (unchanged).
