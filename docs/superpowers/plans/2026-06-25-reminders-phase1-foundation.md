# Reminders — Phase 1 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the public-facing foundation of the Reminders product — a fluid.glass-style landing page, a two-flow intake wizard with consent capture, privacy/terms pages, and a D1-backed intake API — with **no calls placed yet**.

**Architecture:** New module `src/reminders.js` (handler `handleReminders` + self-initializing D1 schema via `ensureSchema`) dispatched from `src/worker.js` by pathname prefix, exactly like `handleUsers`/`handleVighnaa`. Static pages live in `public/reminders/`. A dedicated D1 database `reminders` (binding `REMINDERS_DB`) isolates health-adjacent data from the analytics `DB`.

**Tech Stack:** Cloudflare Workers, D1 (SQLite), vanilla HTML/CSS/JS (no build step), plain Node `--test`-free `.mjs` assertion files (matching `test/engine.test.mjs`).

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/reminders.js` | Route handler `handleReminders`, `ensureSchema`, pure helpers (phone normalization, intake validation), intake API |
| `src/worker.js` | Add `/reminders*` dispatch (modify) |
| `wrangler.toml` | Add `REMINDERS_DB` binding + `run_worker_first` entries (modify) |
| `public/reminders/index.html` | fluid.glass-style marketing landing |
| `public/reminders/intake.html` | Two-flow intake wizard + consent |
| `public/reminders/privacy.html` | Privacy policy |
| `public/reminders/terms.html` | Terms of service |
| `public/reminders/reminders.css` | Shared glassmorphism design system |
| `test/reminders.test.mjs` | Unit tests for pure helpers |

**Conventions to follow (verified in repo):**
- Handlers return a `Response`; static assets with a file extension pass through to `env.ASSETS.fetch`.
- D1 schema is created on demand in `ensureSchema()` (see `users-dashboard.js`), no migration files.
- Tests are hand-rolled `.mjs` with `ok`/`eq` helpers, run via `node test/<name>.test.mjs`.
- Pure helpers are exported from the module so Node can import them without the Workers runtime.

---

## Task 1: Create the `reminders` D1 database and bind it

**Files:**
- Modify: `wrangler.toml`

- [ ] **Step 1: Create the D1 database**

Run:
```bash
cd /Users/christopherrathbun/Desktop/Claude/christopherrathbun-landing
npx wrangler d1 create reminders
```
Expected: prints a `database_id` UUID. Copy it.

- [ ] **Step 2: Add the binding to `wrangler.toml`**

Append after the existing `[[d1_databases]]` block (the one for `christopherrathbun_users`):

```toml
[[d1_databases]]
binding = "REMINDERS_DB"
database_name = "reminders"
database_id = "PASTE-THE-UUID-FROM-STEP-1"

# NOTE: schema is created on-demand by src/reminders.js (ensureSchema),
# so no D1 migration is needed here.
```

- [ ] **Step 3: Add `/reminders` routes to `run_worker_first`**

In `wrangler.toml`, edit the `run_worker_first` array under `[assets]` to add the reminders entries (keep all existing entries):

```toml
run_worker_first = ["/twistedchess", "/twistedchess/*", "/sentry", "/sentry/*", "/stella-in-the-woods", "/stella-in-the-woods/", "/stella-in-the-woods-countdown", "/stella-in-the-woods-countdown/", "/vighnaatextllm", "/vighnaatextllm/*", "/users", "/users/*", "/api/users", "/api/users/*", "/reminders", "/reminders/*"]
```

- [ ] **Step 4: Verify the binding parses**

Run:
```bash
npx wrangler deploy --dry-run 2>&1 | grep -i "reminders\|error" || echo "dry-run clean"
```
Expected: shows the `REMINDERS_DB` binding, no errors. (Dry-run does not deploy.)

- [ ] **Step 5: Commit**

```bash
git add wrangler.toml
git commit -m "feat(reminders): create reminders D1 database + worker routes"
```

---

## Task 2: Pure helper — phone normalization to E.164 (TDD)

**Files:**
- Create: `src/reminders.js`
- Test: `test/reminders.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `test/reminders.test.mjs`:

```js
// Node sanity test for reminders helpers. Run: node test/reminders.test.mjs
import { normalizePhone } from '../src/reminders.js';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('FAIL:', msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

// US 10-digit → +1 E.164
eq(normalizePhone('(415) 555-0132'), '+14155550132', 'US 10-digit formatted');
eq(normalizePhone('4155550132'), '+14155550132', 'US 10-digit bare');
// Already +1 11-digit
eq(normalizePhone('14155550132'), '+14155550132', 'US 11-digit leading 1');
eq(normalizePhone('+14155550132'), '+14155550132', 'already E.164');
// International passthrough (keeps + and digits)
eq(normalizePhone('+44 20 7946 0958'), '+442079460958', 'UK intl');
// Invalid → null
eq(normalizePhone('12345'), null, 'too short → null');
eq(normalizePhone('not a phone'), null, 'garbage → null');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/reminders.test.mjs`
Expected: FAIL — `Cannot find module '../src/reminders.js'` (or `normalizePhone is not a function`).

- [ ] **Step 3: Write minimal implementation**

Create `src/reminders.js`:

```js
// Reminders — AI medication-reminder calls. Phase 1: foundation.

// Normalize a phone string to E.164 (+ and digits). Returns null if invalid.
export function normalizePhone(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  const hadPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/[^0-9]/g, '');
  if (hadPlus) {
    // International: 8–15 digits per E.164.
    if (digits.length < 8 || digits.length > 15) return null;
    return '+' + digits;
  }
  // No +: treat as North American.
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/reminders.test.mjs`
Expected: `7 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add src/reminders.js test/reminders.test.mjs
git commit -m "feat(reminders): phone E.164 normalization helper + tests"
```

---

## Task 3: Pure helper — intake payload validation (TDD)

**Files:**
- Modify: `src/reminders.js`
- Modify: `test/reminders.test.mjs`

- [ ] **Step 1: Add failing tests**

Append to `test/reminders.test.mjs` BEFORE the final `console.log` summary line (add `validateIntake` to the import at the top):

```js
import { validateIntake } from '../src/reminders.js';

const goodPayload = {
  flow: 'loved_one',
  relationship: 'grandmother',
  patient: { name: 'Rose', phone: '(415) 555-0132', timezone: 'America/Los_Angeles' },
  purchaser: { name: 'Chris', email: 'chris@example.com', phone: '4155550000' },
  emergency: { name: 'Dana', phone: '4155550001', email: 'dana@example.com', relationship: 'aunt' },
  consent: { tcpa: true, recording: true, attestation: true },
  medicines: [{ name: 'Lisinopril', dose: '10mg', frequency: 'once_daily', timing: 'morning' }],
};

let g = validateIntake(goodPayload);
ok(g.valid, 'good payload valid');
eq(g.errors.length, 0, 'good payload no errors');
eq(g.normalized.patient.phone, '+14155550132', 'patient phone normalized');

// Missing TCPA consent → invalid
let c = validateIntake({ ...goodPayload, consent: { tcpa: false, recording: true, attestation: true } });
ok(!c.valid, 'no tcpa consent → invalid');
ok(c.errors.some(e => e.includes('consent')), 'consent error surfaced');

// Self flow does not require attestation
let s = validateIntake({ ...goodPayload, flow: 'self', consent: { tcpa: true, recording: true, attestation: false } });
ok(s.valid, 'self flow without attestation valid');

// Bad patient phone → invalid
let p = validateIntake({ ...goodPayload, patient: { ...goodPayload.patient, phone: '123' } });
ok(!p.valid, 'bad patient phone → invalid');

// No medicines → invalid
let m = validateIntake({ ...goodPayload, medicines: [] });
ok(!m.valid, 'no medicines → invalid');
```

- [ ] **Step 2: Run to verify it fails**

Run: `node test/reminders.test.mjs`
Expected: FAIL — `validateIntake is not a function`.

- [ ] **Step 3: Implement `validateIntake`**

Add to `src/reminders.js`:

```js
const VALID_FREQUENCIES = ['once_daily', 'twice_daily', 'three_times_daily', 'every_8h', 'every_12h', 'custom'];
const VALID_TIMINGS = ['morning', 'noon', 'evening', 'bedtime', 'with_food', 'empty_stomach', 'specific_time'];

function isEmail(s) {
  return typeof s === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.trim());
}

// Validate + normalize an intake payload. Returns { valid, errors:[], normalized }.
export function validateIntake(p) {
  const errors = [];
  if (!p || typeof p !== 'object') return { valid: false, errors: ['missing payload'], normalized: null };

  const flow = p.flow === 'self' ? 'self' : 'loved_one';

  const patientPhone = normalizePhone(p.patient?.phone);
  if (!p.patient?.name?.trim()) errors.push('patient name required');
  if (!patientPhone) errors.push('valid patient phone required');
  if (!p.patient?.timezone?.trim()) errors.push('patient timezone required');

  if (!p.purchaser?.name?.trim()) errors.push('purchaser name required');
  if (!isEmail(p.purchaser?.email)) errors.push('valid purchaser email required');
  const purchaserPhone = normalizePhone(p.purchaser?.phone);

  const emergencyPhone = normalizePhone(p.emergency?.phone);
  if (!p.emergency?.name?.trim()) errors.push('emergency contact name required');
  if (!emergencyPhone) errors.push('valid emergency contact phone required');

  if (!p.consent?.tcpa) errors.push('TCPA call consent required');
  if (!p.consent?.recording) errors.push('recording consent required');
  if (flow === 'loved_one' && !p.consent?.attestation) errors.push('permission attestation required for a loved one');

  const medicines = Array.isArray(p.medicines) ? p.medicines : [];
  if (medicines.length === 0) errors.push('at least one medicine required');
  medicines.forEach((m, i) => {
    if (!m?.name?.trim()) errors.push(`medicine ${i + 1}: name required`);
    if (m?.frequency && !VALID_FREQUENCIES.includes(m.frequency)) errors.push(`medicine ${i + 1}: invalid frequency`);
    if (m?.timing && !VALID_TIMINGS.includes(m.timing)) errors.push(`medicine ${i + 1}: invalid timing`);
  });

  const valid = errors.length === 0;
  const normalized = valid ? {
    flow,
    relationship: (p.relationship || '').trim(),
    patient: { name: p.patient.name.trim(), phone: patientPhone, timezone: p.patient.timezone.trim(), is_self: flow === 'self' ? 1 : 0 },
    purchaser: { name: p.purchaser.name.trim(), email: p.purchaser.email.trim().toLowerCase(), phone: purchaserPhone },
    emergency: { name: p.emergency.name.trim(), phone: emergencyPhone, email: isEmail(p.emergency?.email) ? p.emergency.email.trim().toLowerCase() : null, relationship: (p.emergency?.relationship || '').trim() },
    consent: { tcpa: true, recording: true, attestation: flow === 'loved_one' },
    medicines: medicines.map(m => ({ name: m.name.trim(), dose: (m.dose || '').trim(), frequency: m.frequency || 'once_daily', timing: m.timing || 'morning', preferred_times: Array.isArray(m.preferred_times) ? m.preferred_times : [] })),
  } : null;

  return { valid, errors, normalized };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node test/reminders.test.mjs`
Expected: all assertions pass, `0 failed`.

- [ ] **Step 5: Commit**

```bash
git add src/reminders.js test/reminders.test.mjs
git commit -m "feat(reminders): intake payload validation + tests"
```

---

## Task 4: D1 schema + route handler skeleton

**Files:**
- Modify: `src/reminders.js`
- Modify: `src/worker.js`

- [ ] **Step 1: Add `ensureSchema` and `handleReminders` to `src/reminders.js`**

Add to `src/reminders.js`:

```js
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  const db = env.REMINDERS_DB;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      clerk_user_id TEXT, email TEXT, name TEXT,
      approved INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')))`),
    db.prepare(`CREATE TABLE IF NOT EXISTS patients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      name TEXT NOT NULL, phone_e164 TEXT NOT NULL, timezone TEXT NOT NULL,
      relationship TEXT, is_self INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')))`),
    db.prepare(`CREATE TABLE IF NOT EXISTS emergency_contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id INTEGER NOT NULL,
      name TEXT NOT NULL, phone_e164 TEXT NOT NULL, email TEXT, relationship TEXT)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS medicines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id INTEGER NOT NULL,
      name TEXT NOT NULL, dose TEXT, frequency TEXT, timing_constraint TEXT,
      preferred_times TEXT, active INTEGER NOT NULL DEFAULT 1)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS consent_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id INTEGER NOT NULL,
      type TEXT NOT NULL, text_version TEXT, ip TEXT, user_agent TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')))`),
  ]);
  schemaReady = true;
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json' },
});

async function fetchPage(env, origin, file) {
  const res = await env.ASSETS.fetch(new Request(new URL(file, origin).toString()));
  return new Response(res.body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

// Main entry, dispatched from worker.js for any /reminders* path.
export async function handleReminders(request, env, url) {
  const path = url.pathname;

  // Static assets (css/js/img) pass through to ASSETS.
  if (/\.(js|css|png|jpg|jpeg|svg|ico|webmanifest|map|webp)$/.test(path)) {
    return env.ASSETS.fetch(request);
  }

  // Intake API (implemented in Task 6).
  if (path === '/reminders/api/intake' && request.method === 'POST') {
    return handleIntakeSubmit(request, env);
  }

  // Page routes.
  if (path === '/reminders/intake' || path === '/reminders/intake/') return fetchPage(env, url.origin, '/reminders/intake.html');
  if (path === '/reminders/privacy' || path === '/reminders/privacy/') return fetchPage(env, url.origin, '/reminders/privacy.html');
  if (path === '/reminders/terms' || path === '/reminders/terms/') return fetchPage(env, url.origin, '/reminders/terms.html');

  // Landing (default for /reminders and unknown sub-paths).
  return fetchPage(env, url.origin, '/reminders/index.html');
}

// Placeholder until Task 6 — keeps the module importable.
async function handleIntakeSubmit(request, env) {
  await ensureSchema(env);
  return json({ ok: false, error: 'not implemented' }, 501);
}
```

- [ ] **Step 2: Wire the route into `src/worker.js`**

In `src/worker.js`, add the import at the top with the other handler imports:

```js
import { handleReminders } from './reminders.js';
```

Then add this dispatch block inside `fetch`, immediately after the `handleUsers` block:

```js
    // Reminders — AI medication-reminder calls
    if (path === '/reminders' || path === '/reminders/' || path.startsWith('/reminders/')) {
      return handleReminders(request, env, url);
    }
```

- [ ] **Step 3: Verify the module still imports cleanly**

Run: `node test/reminders.test.mjs`
Expected: still passes (helpers unaffected; new code is not imported by the test but must parse — confirm no syntax error by running `node --check src/reminders.js`).

Run: `node --check src/reminders.js`
Expected: no output (valid syntax).

- [ ] **Step 4: Commit**

```bash
git add src/reminders.js src/worker.js
git commit -m "feat(reminders): D1 schema + route handler skeleton"
```

---

## Task 5: Shared design system + landing page (fluid.glass clone)

**Files:**
- Create: `public/reminders/reminders.css`
- Create: `public/reminders/index.html`

> **Design target:** Clone <https://fluid.glass/> as closely as possible — a dark, immersive
> background with a soft animated gradient/fluid blur, frosted-glass ("glassmorphism") panels
> with `backdrop-filter: blur()`, thin light borders, large airy typography, generous spacing.
> Higgsfield-generated ambient hero art is added in Phase 5; Phase 1 uses a pure-CSS animated
> gradient so the page stands alone.

- [ ] **Step 1: Create the design system `public/reminders/reminders.css`**

```css
:root {
  --bg: #07080c;
  --glass: rgba(255,255,255,0.06);
  --glass-strong: rgba(255,255,255,0.10);
  --border: rgba(255,255,255,0.14);
  --text: #f4f6fb;
  --muted: rgba(244,246,251,0.62);
  --accent: #8ab4ff;
  --accent-2: #c79bff;
  --radius: 22px;
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: var(--font); color: var(--text); background: var(--bg);
  min-height: 100vh; overflow-x: hidden; line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
/* Animated fluid background */
.fluid-bg { position: fixed; inset: 0; z-index: -1; overflow: hidden; }
.fluid-bg::before, .fluid-bg::after {
  content: ""; position: absolute; width: 70vmax; height: 70vmax; border-radius: 50%;
  filter: blur(80px); opacity: 0.55; mix-blend-mode: screen;
}
.fluid-bg::before { background: radial-gradient(circle, var(--accent), transparent 60%); top: -10%; left: -10%; animation: drift1 22s ease-in-out infinite alternate; }
.fluid-bg::after { background: radial-gradient(circle, var(--accent-2), transparent 60%); bottom: -15%; right: -10%; animation: drift2 26s ease-in-out infinite alternate; }
@keyframes drift1 { to { transform: translate(20vw, 12vh) scale(1.2); } }
@keyframes drift2 { to { transform: translate(-16vw, -10vh) scale(1.15); } }
@media (prefers-reduced-motion: reduce) { .fluid-bg::before, .fluid-bg::after { animation: none; } }

.glass {
  background: var(--glass); border: 1px solid var(--border); border-radius: var(--radius);
  backdrop-filter: blur(18px) saturate(140%); -webkit-backdrop-filter: blur(18px) saturate(140%);
  box-shadow: 0 8px 40px rgba(0,0,0,0.35);
}
.wrap { max-width: 1080px; margin: 0 auto; padding: 0 24px; }
.btn {
  display: inline-block; padding: 14px 26px; border-radius: 999px; font-weight: 600;
  text-decoration: none; color: #0a0c12; background: linear-gradient(120deg, var(--accent), var(--accent-2));
  border: none; cursor: pointer; font-size: 16px; transition: transform .15s ease, box-shadow .15s ease;
}
.btn:hover { transform: translateY(-2px); box-shadow: 0 10px 30px rgba(138,180,255,0.35); }
.btn-ghost { background: var(--glass-strong); color: var(--text); border: 1px solid var(--border); }
h1 { font-size: clamp(40px, 7vw, 76px); line-height: 1.05; letter-spacing: -0.02em; margin: 0 0 18px; }
h2 { font-size: clamp(26px, 3.5vw, 38px); letter-spacing: -0.01em; }
.muted { color: var(--muted); }
.lede { font-size: clamp(18px, 2.2vw, 22px); max-width: 620px; }
```

- [ ] **Step 2: Create the landing page `public/reminders/index.html`**

The page must contain these sections (frosted-glass cards on the fluid background):
1. **Top nav** — product name "Reminders", links to `#how`, `/reminders/privacy`, and a "Sign in" link placeholder (Clerk wired in Phase 3 — link to `/reminders/dashboard` for now).
2. **Hero** — `<h1>` headline ("Never miss a dose. A friendly voice that calls every day."), a `.lede` subhead, and two CTAs: primary `Get started` → `/reminders/intake`, ghost `How it works` → `#how`.
3. **`#how` — 3-step glass cards**: "Tell us the medicines & times", "Our AI calls at the right time, every time", "If they need anything, we alert you instantly".
4. **Trust strip** — short line: calls are recorded for quality, you're alerted to any concern, "not a substitute for professional medical care."
5. **Footer** — links to `/reminders/privacy`, `/reminders/terms`.

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Reminders — a friendly voice that calls every day</title>
  <meta name="description" content="An AI voice agent that calls your loved ones every day to remind them to take their medication — and alerts you if they need anything." />
  <link rel="stylesheet" href="/reminders/reminders.css" />
</head>
<body>
  <div class="fluid-bg"></div>
  <header class="wrap" style="display:flex;align-items:center;justify-content:space-between;padding:22px 24px;">
    <strong style="font-size:18px;letter-spacing:-0.01em;">Reminders</strong>
    <nav style="display:flex;gap:18px;align-items:center;">
      <a href="#how" class="muted" style="text-decoration:none;">How it works</a>
      <a href="/reminders/dashboard" class="btn btn-ghost" style="padding:10px 18px;">Sign in</a>
    </nav>
  </header>

  <main class="wrap" style="padding-top:8vh;">
    <section style="text-align:center;max-width:760px;margin:0 auto;">
      <h1>Never miss a dose.<br/>A friendly voice that calls every day.</h1>
      <p class="lede muted" style="margin:0 auto 30px;">Reminders calls your loved ones at the right time, every time, in a warm human voice — and tells you the moment they need anything.</p>
      <div style="display:flex;gap:14px;justify-content:center;flex-wrap:wrap;">
        <a href="/reminders/intake" class="btn">Get started</a>
        <a href="#how" class="btn btn-ghost">How it works</a>
      </div>
    </section>

    <section id="how" style="margin-top:14vh;">
      <h2 style="text-align:center;margin-bottom:36px;">How it works</h2>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:20px;">
        <div class="glass" style="padding:28px;">
          <div style="font-size:13px;letter-spacing:.12em;text-transform:uppercase;" class="muted">Step 1</div>
          <h3>Tell us the medicines & times</h3>
          <p class="muted">Add each medication and when it should be taken. We automatically group medicines that can be taken together.</p>
        </div>
        <div class="glass" style="padding:28px;">
          <div style="font-size:13px;letter-spacing:.12em;text-transform:uppercase;" class="muted">Step 2</div>
          <h3>We call — on time, every time</h3>
          <p class="muted">A warm AI voice calls at each scheduled time: "Hi Rose, it's time to take your morning medicine."</p>
        </div>
        <div class="glass" style="padding:28px;">
          <div style="font-size:13px;letter-spacing:.12em;text-transform:uppercase;" class="muted">Step 3</div>
          <h3>You're alerted to anything</h3>
          <p class="muted">If they have a question or need help, we detect it and alert you and the emergency contact by email and text.</p>
        </div>
      </div>
    </section>

    <section class="glass" style="margin-top:10vh;padding:26px 30px;text-align:center;">
      <p class="muted" style="margin:0;">Calls are recorded for quality and safety. Reminders is a supportive tool and is <strong>not a substitute for professional medical care or emergency services</strong>.</p>
    </section>
  </main>

  <footer class="wrap" style="padding:48px 24px;display:flex;gap:18px;justify-content:center;">
    <a href="/reminders/privacy" class="muted" style="text-decoration:none;">Privacy</a>
    <a href="/reminders/terms" class="muted" style="text-decoration:none;">Terms</a>
  </footer>
</body>
</html>
```

- [ ] **Step 3: Start the dev server and verify the landing page**

Run: `npx wrangler dev` (use the preview tools: `preview_start` then `preview_snapshot` / `preview_screenshot`).
Verify:
- Page loads at `/reminders` with the animated fluid background and frosted-glass cards.
- "Get started" links to `/reminders/intake`; "How it works" scrolls to `#how`.
- No console errors (`preview_console_logs`).
- Responsive at mobile width (`preview_resize` to 390px) — cards stack.

- [ ] **Step 4: Commit**

```bash
git add public/reminders/reminders.css public/reminders/index.html
git commit -m "feat(reminders): fluid.glass-style landing page + design system"
```

---

## Task 6: Intake API endpoint (persist to D1)

**Files:**
- Modify: `src/reminders.js`

- [ ] **Step 1: Replace the placeholder `handleIntakeSubmit`**

In `src/reminders.js`, replace the placeholder `handleIntakeSubmit` from Task 4 with the real implementation:

```js
async function handleIntakeSubmit(request, env) {
  await ensureSchema(env);
  let payload;
  try { payload = await request.json(); } catch { return json({ ok: false, errors: ['invalid JSON'] }, 400); }

  const { valid, errors, normalized } = validateIntake(payload);
  if (!valid) return json({ ok: false, errors }, 422);

  const db = env.REMINDERS_DB;
  const ip = request.headers.get('cf-connecting-ip') || '';
  const ua = request.headers.get('user-agent') || '';
  const consentText = 'reminders-consent-v1';

  // Account: dedupe by purchaser email (Clerk linkage added in Phase 3).
  let acct = await db.prepare('SELECT id FROM accounts WHERE email = ?').bind(normalized.purchaser.email).first();
  if (!acct) {
    const r = await db.prepare('INSERT INTO accounts (email, name, approved) VALUES (?, ?, 0) RETURNING id')
      .bind(normalized.purchaser.email, normalized.purchaser.name).first();
    acct = r;
  }

  const patient = await db.prepare(
    `INSERT INTO patients (account_id, name, phone_e164, timezone, relationship, is_self, status)
     VALUES (?, ?, ?, ?, ?, ?, 'pending') RETURNING id`)
    .bind(acct.id, normalized.patient.name, normalized.patient.phone, normalized.patient.timezone,
          normalized.relationship, normalized.patient.is_self).first();

  const stmts = [];
  stmts.push(db.prepare('INSERT INTO emergency_contacts (patient_id, name, phone_e164, email, relationship) VALUES (?, ?, ?, ?, ?)')
    .bind(patient.id, normalized.emergency.name, normalized.emergency.phone, normalized.emergency.email, normalized.emergency.relationship));
  for (const m of normalized.medicines) {
    stmts.push(db.prepare('INSERT INTO medicines (patient_id, name, dose, frequency, timing_constraint, preferred_times) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(patient.id, m.name, m.dose, m.frequency, m.timing, JSON.stringify(m.preferred_times)));
  }
  for (const t of ['tcpa', 'recording', ...(normalized.consent.attestation ? ['attestation'] : [])]) {
    stmts.push(db.prepare('INSERT INTO consent_log (patient_id, type, text_version, ip, user_agent) VALUES (?, ?, ?, ?, ?)')
      .bind(patient.id, t, consentText, ip, ua));
  }
  await db.batch(stmts);

  return json({ ok: true, patientId: patient.id, status: 'pending_approval' });
}
```

- [ ] **Step 2: Verify syntax**

Run: `node --check src/reminders.js`
Expected: no output.

Run: `node test/reminders.test.mjs`
Expected: still `0 failed` (validation logic unchanged).

- [ ] **Step 3: Integration test against local D1**

Run `npx wrangler dev` (local mode uses a local SQLite for `REMINDERS_DB`). With the dev server up, POST a valid payload:

```bash
curl -s -X POST http://localhost:8787/reminders/api/intake \
  -H 'content-type: application/json' \
  -d '{"flow":"loved_one","relationship":"grandmother","patient":{"name":"Rose","phone":"4155550132","timezone":"America/Los_Angeles"},"purchaser":{"name":"Chris","email":"chris@example.com","phone":"4155550000"},"emergency":{"name":"Dana","phone":"4155550001","email":"dana@example.com","relationship":"aunt"},"consent":{"tcpa":true,"recording":true,"attestation":true},"medicines":[{"name":"Lisinopril","dose":"10mg","frequency":"once_daily","timing":"morning"}]}'
```
Expected: `{"ok":true,"patientId":1,"status":"pending_approval"}`.

Then verify rows persisted:
```bash
npx wrangler d1 execute reminders --local --command "SELECT name, phone_e164, status FROM patients;"
```
Expected: one row — Rose / +14155550132 / pending.

Also confirm a bad payload is rejected:
```bash
curl -s -X POST http://localhost:8787/reminders/api/intake -H 'content-type: application/json' -d '{"flow":"loved_one"}'
```
Expected: HTTP 422 with `{"ok":false,"errors":[...]}`.

- [ ] **Step 4: Commit**

```bash
git add src/reminders.js
git commit -m "feat(reminders): intake API persists account/patient/meds/consent to D1"
```

---

## Task 7: Intake wizard page (two flows + consent)

**Files:**
- Create: `public/reminders/intake.html`

> A single-page wizard (vanilla JS, no framework) that steps through the intake and POSTs the
> assembled payload to `/reminders/api/intake`. Reuses `/reminders/reminders.css`.

- [ ] **Step 1: Create `public/reminders/intake.html`**

The wizard must implement these steps and behaviors. Build it as one HTML file with inline `<script>` managing a `state` object and rendering steps into a `.glass` card:

1. **Step "flow"** — two big buttons: "I'm signing up for myself" (`flow='self'`) and "I'm signing up for a loved one" (`flow='loved_one'`). Selecting sets `state.flow` and advances.
2. **Step "patient"** — name, phone, timezone (`<select>` of common IANA zones: America/Los_Angeles, America/Denver, America/Chicago, America/New_York, plus a default from `Intl.DateTimeFormat().resolvedOptions().timeZone`). For `self` flow, label is "Your details".
3. **Step "purchaser"** — name, email, phone. For `self` flow, pre-hint "this is you".
4. **Step "emergency"** — name, phone, email (optional), relationship.
5. **Step "consent"** — three checkboxes (attestation only shown when `flow==='loved_one'`):
   - "I consent to receive automated AI voice phone calls at this number." (tcpa)
   - "I understand calls are recorded and transcribed." (recording)
   - "I confirm I have this person's permission to set up reminders for them." (attestation)
   Each links the relevant phrase to `/reminders/privacy` and `/reminders/terms`. Next is disabled until required boxes are checked.
6. **Step "medicines"** — repeatable rows; each row: name, dose, frequency (`<select>`: once_daily, twice_daily, three_times_daily, every_8h, every_12h, custom), timing (`<select>`: morning, noon, evening, bedtime, with_food, empty_stomach, specific_time). "Add another medicine" button. At least one required.
7. **Step "review"** — render a summary of everything, plus a note: "Your account will be pending approval before calls begin." Submit button POSTs to `/reminders/api/intake`.
8. **Success state** — on `{ok:true}`, show a confirmation card: "You're all set — pending approval. We'll be in touch." with a link to `/reminders/dashboard`. On `{ok:false}`, render `errors` inline above the current step.

Validation mirrors `validateIntake` client-side (cheap guard); the server remains the source of truth. Use `fetch('/reminders/api/intake', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(state) })`.

> The engineer writes the markup/JS to satisfy the above. Keep it within one file, styled with
> the existing `.glass`, `.btn`, `.muted` classes. A progress indicator (Step N of 7) sits atop
> the card.

- [ ] **Step 2: Verify the full intake flow in the browser**

Run `npx wrangler dev` and use the preview tools:
- Walk both flows (`self` and `loved_one`); confirm the attestation checkbox only appears for `loved_one` (`preview_click`, `preview_snapshot`).
- Confirm "Next" is disabled on the consent step until required boxes are checked.
- Add two medicines; submit; confirm the success card renders.
- Confirm a new patient row exists: `npx wrangler d1 execute reminders --local --command "SELECT COUNT(*) FROM patients;"` increments.
- Confirm submitting with a bad phone shows the server `errors` inline.
- No console errors (`preview_console_logs`).

- [ ] **Step 3: Commit**

```bash
git add public/reminders/intake.html
git commit -m "feat(reminders): two-flow intake wizard with consent capture"
```

---

## Task 8: Privacy policy + terms pages

**Files:**
- Create: `public/reminders/privacy.html`
- Create: `public/reminders/terms.html`

> Plain, readable legal pages styled with `reminders.css` (a `.glass` content column on the
> fluid background). Content is specific to this product, not boilerplate.

- [ ] **Step 1: Create `public/reminders/privacy.html`**

Must cover, in clear language, with a "Last updated: 2026-06-25" line:
- **What we collect:** patient name, phone, timezone, medication names/schedules, purchaser & emergency contact details, consent records (with timestamp/IP), and call recordings + transcripts.
- **How calls work:** outbound AI voice calls are placed and **recorded & transcribed by our calling provider (Bland AI)**; transcripts are analyzed by an AI model (OpenAI) to detect if the person needs help.
- **Who we share with:** the calling provider, the AI analysis provider, and SMS/email providers — only to operate the service. We do not sell data.
- **Alerts:** when a need is detected (or a call is missed), we notify the purchaser and emergency contact by email and SMS.
- **Retention & deletion:** how long recordings/transcripts are kept and how to request deletion (email contact).
- **Consent & your rights:** how consent was captured and how to withdraw it (stops all calls).
- **Not medical advice:** Reminders is a supportive reminder tool, **not a medical device, not medical advice, and not a substitute for professional care or emergency services (call 911 for emergencies).**

Use the same `<head>`/`reminders.css`/`fluid-bg` shell as `index.html`, with a `.wrap` + `.glass` article column and a back link to `/reminders`.

- [ ] **Step 2: Create `public/reminders/terms.html`**

Must cover, with "Last updated: 2026-06-25":
- **Eligibility & authority:** you must be 18+ and, if signing up for a loved one, confirm you have their permission.
- **Consent to calls (TCPA):** by signing up you consent to automated AI voice calls at the number provided; you can withdraw consent anytime to stop calls.
- **Service description & reliability:** we make reasonable efforts to place calls on time but do not guarantee delivery; the service is **not for emergencies**.
- **No medical advice / assumption of risk:** same disclaimer as privacy; users are responsible for their own medical decisions.
- **Acceptable use:** no signing up numbers you don't have permission for; emergency/crisis numbers are blocked.
- **Liability limitation & changes to terms.**
- Back link to `/reminders`.

- [ ] **Step 3: Verify both pages render**

Run `npx wrangler dev` and load `/reminders/privacy` and `/reminders/terms` (`preview_snapshot`). Confirm:
- Both render with the glass styling and are readable.
- The footer links from `index.html` reach them.
- The consent-step links in `intake.html` reach them.

- [ ] **Step 4: Commit**

```bash
git add public/reminders/privacy.html public/reminders/terms.html
git commit -m "feat(reminders): privacy policy + terms pages"
```

---

## Task 9: Phase 1 end-to-end verification + deploy

**Files:** none (verification only)

- [ ] **Step 1: Run the unit tests**

Run: `node test/reminders.test.mjs`
Expected: all pass, `0 failed`.

- [ ] **Step 2: Full local walkthrough**

With `npx wrangler dev`:
- `/reminders` → landing renders, CTAs work.
- Complete the intake wizard (loved_one flow) end-to-end → success card.
- `npx wrangler d1 execute reminders --local --command "SELECT (SELECT COUNT(*) FROM patients) AS patients, (SELECT COUNT(*) FROM medicines) AS meds, (SELECT COUNT(*) FROM consent_log) AS consents;"` → all non-zero and consistent (3 consents for a loved_one signup).
- `/reminders/privacy` and `/reminders/terms` render.

- [ ] **Step 3: Deploy the schema to remote D1**

The schema self-initializes on first request, but seed it explicitly so production is ready:
```bash
npx wrangler d1 execute reminders --remote --command "SELECT name FROM sqlite_master WHERE type='table';"
```
(After first deploy + one request, tables appear. No manual migration needed.)

- [ ] **Step 4: Deploy**

Run: `npx wrangler deploy`
Expected: deploys successfully; `REMINDERS_DB` binding listed.

- [ ] **Step 5: Production smoke test**

- Load `https://christopherrathbun.com/reminders` → landing renders.
- Submit one test intake via the live wizard → success card.
- `npx wrangler d1 execute reminders --remote --command "SELECT name, status FROM patients ORDER BY id DESC LIMIT 1;"` → your test patient, status `pending`.

- [ ] **Step 6: Final commit / push**

```bash
git push -u origin reminders
```

---

## Self-Review (completed during planning)

**Spec coverage (Phase 1 scope):**
- Landing page (fluid.glass) → Task 5 ✓
- Two-flow intake + phone + emergency contact + consent → Tasks 6, 7 ✓
- Privacy + terms → Task 8 ✓
- D1 data model (accounts/patients/emergency_contacts/medicines/consent_log) → Tasks 1, 4 ✓
- Consent logged with timestamp + IP → Task 6 (`consent_log`) ✓
- Soft-launch gate (`accounts.approved`, patient `status=pending`) → Tasks 4, 6 ✓
- *Deferred to later phases (correctly out of Phase 1 scope):* grouping optimizer (Phase 2), Bland calls + crons (Phase 2), Clerk dashboard (Phase 3), webhook + alerts (Phase 4), Higgsfield visuals + Stripe-ready accounting (Phase 5). The intake currently stores raw medicines; the optimizer in Phase 2 reads them to build `call_plan`.

**Placeholder scan:** No "TBD"/"add error handling" placeholders. The page-markup tasks (5,7,8) specify exact required sections + behaviors + the design system + verification criteria rather than dumping full markup, because the visual clone is browser-verified, not unit-tested — this is intentional, not a hand-wave.

**Type consistency:** `normalizePhone`, `validateIntake` (returns `{valid, errors, normalized}`), `ensureSchema`, `handleReminders`, `handleIntakeSubmit`, `fetchPage`, `json` are defined once and referenced consistently. Table/column names match between `ensureSchema` (Task 4) and the inserts (Task 6). Frequency/timing enums match between `validateIntake` (Task 3) and the wizard selects (Task 7).
