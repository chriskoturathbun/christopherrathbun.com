# Reminders — Phase 6 (Alert Reliability + Personalization) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Why:** A real call where the patient said "I'm not feeling super well" never alerted the family — because the call predated the webhook wiring and we depend 100% on Bland's webhook arriving. This phase (A) makes alerts reliable even if a webhook is dropped, and (B/C) personalizes calls: choose the agent's voice, choose what it calls the person, and hear a live demo during onboarding.

**Tracks:**
- **A. Reliability** — refactor webhook processing into a shared `processCallOutcome`, add a fallback cron that polls Bland for completed-but-unprocessed calls and runs concern detection → alerts.
- **B. Personalization** — `preferred_name` (what the agent calls them) + `voice` per patient, threaded into the Bland call.
- **C. Demo call** — an onboarding "call my phone now" that places a live demo in the chosen voice/name (also the voice preview), with throttling.

---

## Curated voices (Bland voice IDs)
```
june                                   → "June — warm & friendly (default)"
17a0eab8-d7d5-4304-bb41-7a7b6bda96d3   → "Grace — warm, Southern"
bbeabae6-ec8d-444f-92ad-c8e620d3de8d   → "Tina — gentle"
aec18940-3d5a-4454-acd2-66f685e83b67   → "Martha — casual & friendly"
ff2c405b-3dba-41e0-9261-bc8ee3f91f46   → "David — reassuring (male)"
17e8f694-d230-4b64-b040-6108088d9e6c   → "Dorothy — British"
```

---

## Task A1: Extract `processCallOutcome` from the webhook

**File:** `src/reminders.js`. READ `handleBlandWebhook` first.

- [ ] **Step 1:** Refactor: move everything in `handleBlandWebhook` that runs AFTER the `call` row is fetched (the idempotency guard, the status update, concern detection, recipient gathering, send email/SMS, insert alert) into a new exported function `processCallOutcome(env, call, wh)` that returns `{alerted, kind, channels}`. `handleBlandWebhook` keeps: token check, parse body, `normalizeBlandWebhook`, fetch `call` by `bland_call_id`, then `return json(await processCallOutcome(env, call, wh))`. The SMS statusCallback logic stays inside `processCallOutcome`. Keep behavior identical. After refactor:
```js
async function handleBlandWebhook(request, env, url) {
  if (!env.REMINDERS_WEBHOOK_SECRET || url.searchParams.get('token') !== env.REMINDERS_WEBHOOK_SECRET) return json({ ok:false, error:'unauthorized' }, 401);
  await ensureSchema(env);
  let body; try { body = await request.json(); } catch { return json({ ok:false, error:'bad json' }, 400); }
  const wh = normalizeBlandWebhook(body);
  if (!wh.callId) return json({ ok:true, note:'no call id' });
  const call = await env.REMINDERS_DB.prepare('SELECT * FROM calls WHERE bland_call_id = ?').bind(wh.callId).first();
  if (!call) return json({ ok:true, note:'unknown call' });
  return json(await processCallOutcome(env, call, wh));
}

// Shared by the webhook AND the fallback poller. Idempotent (skips terminal calls).
export async function processCallOutcome(env, call, wh) {
  const db = env.REMINDERS_DB;
  if (['completed','no_answer','failed'].includes(call.status)) return { ok:true, alerted:false, note:'already processed' };
  // ... (the existing finalStatus computation, UPDATE calls, patient fetch, kind/detection,
  //      recipient gathering, formatAlert, send email/SMS w/ statusCallback, insert alerts) ...
  return { ok:true, alerted: !!kind, kind, channels };
}
```
(Paste the existing body verbatim into `processCallOutcome`, adjusting the early returns to return objects instead of `json(...)`.)

- [ ] **Step 2:** `node --check src/reminders.js`; `node test/reminders.test.mjs` (15/0). Local: unauthorized webhook still 401.
- [ ] **Step 3:** commit `git add src/reminders.js && git commit --no-verify -m "refactor(reminders): extract processCallOutcome shared by webhook + fallback"`

---

## Task A2: Webhook-fallback poller cron

**File:** `src/reminders.js`, `src/worker.js`. `getCall` already exists in `reminders-bland.js`.

- [ ] **Step 1:** add import `getCall` to the bland import in `src/reminders.js`:
```js
import { placeCall, scheduleCall, getCall } from './reminders-bland.js';
```
- [ ] **Step 2:** append `runWebhookFallback`:
```js
// Safety net: if Bland's post-call webhook never arrives, poll for completed calls
// we haven't processed and run the same outcome logic. Guarantees alerts aren't missed.
export async function runWebhookFallback(env, nowISO) {
  await ensureSchema(env);
  const db = env.REMINDERS_DB;
  const cutoff = new Date(new Date(nowISO || new Date().toISOString()).getTime() - 3 * 60 * 1000).toISOString();
  const rows = (await db.prepare(
    `SELECT * FROM calls WHERE status = 'placed' AND bland_call_id IS NOT NULL AND placed_at IS NOT NULL AND placed_at <= ? LIMIT 25`)
    .bind(cutoff).all()).results || [];
  let processed = 0;
  for (const call of rows) {
    const res = await getCall(call.bland_call_id, env);
    if (!res.ok || !res.data) continue;
    const d = res.data;
    if (!(d.completed || ['completed','no-answer','failed'].includes(d.status))) continue; // not done yet
    const wh = normalizeBlandWebhook(d);
    await processCallOutcome(env, call, wh);
    processed++;
  }
  return { processed };
}
```
- [ ] **Step 3:** wire into the per-minute tick in `src/worker.js`. Import it, and in `scheduled`'s every-minute branch run both:
```js
import { runReconciler, runPreScheduler, runWebhookFallback } from './reminders.js';
...
    const job = event.cron === '0 * * * *'
      ? runPreScheduler
      : async (env) => { await runReconciler(env); await runWebhookFallback(env); };
    try { await job(env); } catch (e) { console.error('reminders scheduled error', (e&&e.stack)||String(e)); }
```
- [ ] **Step 4:** `node --check` both; `node test/reminders.test.mjs` (15/0).
- [ ] **Step 5:** commit `git add src/reminders.js src/worker.js && git commit --no-verify -m "feat(reminders): webhook-fallback poller — alerts fire even if Bland webhook is dropped"`

---

## Task B1: Schema — `preferred_name` + `voice` columns (idempotent ALTER)

**File:** `src/reminders.js`. `ensureSchema` only CREATEs; the prod `patients` table already exists, so add columns via guarded ALTER.

- [ ] **Step 1:** at the end of `ensureSchema`, after the `db.batch([...])`, add:
```js
  // Additive columns (idempotent — ignore "duplicate column" on re-run).
  for (const stmt of [
    "ALTER TABLE patients ADD COLUMN preferred_name TEXT",
    "ALTER TABLE patients ADD COLUMN voice TEXT",
  ]) { try { await db.prepare(stmt).run(); } catch (e) { /* column exists */ } }
```
- [ ] **Step 2:** `node --check`; `node test/reminders.test.mjs` (15/0).
- [ ] **Step 3:** commit `git add src/reminders.js && git commit --no-verify -m "feat(reminders): patients.preferred_name + voice columns"`

---

## Task B2: Thread preferred_name + voice into intake → Bland

**Files:** `src/reminders.js`, `src/reminders-bland.js`. READ `validateIntake`, `handleIntakeSubmit`, `runReconciler`, and `buildTask`/`placeCall` first.

- [ ] **Step 1:** `validateIntake` — in the `normalized.patient` object, carry two new optional fields from `p.patient`:
```js
    patient: { name: p.patient.name.trim(), phone: patientPhone, timezone: p.patient.timezone.trim(), is_self: flow === 'self' ? 1 : 0,
               preferred_name: (p.patient.preferred_name || '').trim() || null,
               voice: typeof p.patient.voice === 'string' && p.patient.voice.trim() ? p.patient.voice.trim() : null },
```
- [ ] **Step 2:** `handleIntakeSubmit` — include the two columns in the patient INSERT. Change the patient insert to:
```js
  const patient = await db.prepare(
    `INSERT INTO patients (account_id, name, phone_e164, timezone, relationship, is_self, status, preferred_name, voice)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?) RETURNING id`)
    .bind(acct.id, normalized.patient.name, normalized.patient.phone, normalized.patient.timezone,
          normalized.relationship, normalized.patient.is_self, normalized.patient.preferred_name, normalized.patient.voice).first();
```
- [ ] **Step 3:** `reminders-bland.js` — `buildTask(callName, medicineNames)` should use the call-name; `placeCall`/`scheduleCall` already accept `voice`. (No signature change needed; callers pass the right name string.)
- [ ] **Step 4:** `runReconciler` — select `preferred_name` and `voice`, and pass them. In the reconciler SQL add `p.preferred_name, p.voice` to the selected columns, and change the placeCall call to:
```js
    const res = await placeCall({ to: r.phone_e164, patientName: (r.preferred_name || r.name), medicineNames: meds, voice: r.voice || undefined, webhook: blandWebhookUrl(env) }, env);
```
- [ ] **Step 5:** `node --check`; `node test/reminders.test.mjs` (15/0). Local integration: POST intake with `patient.preferred_name:"Grandma Rose"` and `patient.voice:"june"`, confirm the row stores them:
```bash
wrangler dev --config ./wrangler.toml --port 8840 --local > /tmp/wd-b.log 2>&1 &
sleep 9
curl -s -X POST http://localhost:8840/reminders/api/intake -H 'content-type: application/json' -d '{"flow":"loved_one","relationship":"gma","patient":{"name":"Rose Miller","preferred_name":"Grandma Rose","voice":"june","phone":"4155551212","timezone":"America/Los_Angeles"},"purchaser":{"name":"C","email":"vb@example.com","phone":"4155550000"},"emergency":{"name":"E","phone":"4155550001","relationship":"x"},"consent":{"tcpa":true,"recording":true,"attestation":true},"medicines":[{"name":"Vit","frequency":"once_daily","timing":"morning"}]}'
echo; wrangler d1 execute reminders --local --config ./wrangler.toml --command "SELECT name, preferred_name, voice FROM patients ORDER BY id DESC LIMIT 1;"
kill %1 2>/dev/null
```
Expected: row shows name `Rose Miller`, preferred_name `Grandma Rose`, voice `june`.
- [ ] **Step 6:** commit `git add src/reminders.js src/reminders-bland.js && git commit --no-verify -m "feat(reminders): personalize calls with preferred name + chosen voice"`

---

## Task C1: Demo-call endpoint (throttled)

**File:** `src/reminders.js`. Uses `placeCall`.

- [ ] **Step 1:** add a `demo_calls` table to `ensureSchema` batch (for throttling):
```js
    db.prepare(`CREATE TABLE IF NOT EXISTS demo_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`),
```
- [ ] **Step 2:** add route after the intake route:
```js
  if (path === '/reminders/api/demo-call' && request.method === 'POST') return handleDemoCall(request, env);
```
- [ ] **Step 3:** append the handler (throttle: max 3 per phone per rolling hour, max 30/day globally — cheap guardrails):
```js
async function handleDemoCall(request, env) {
  await ensureSchema(env);
  let body; try { body = await request.json(); } catch { return json({ ok:false, error:'bad json' }, 400); }
  const to = normalizePhone(body.phone);
  if (!to) return json({ ok:false, error:'Enter a valid phone number.' }, 422);
  const db = env.REMINDERS_DB;
  const perPhone = await db.prepare("SELECT COUNT(*) AS n FROM demo_calls WHERE phone = ? AND created_at >= datetime('now','-1 hour')").bind(to).first();
  if ((perPhone?.n || 0) >= 3) return json({ ok:false, error:"That number has had several demo calls recently — please try again later." }, 429);
  const perDay = await db.prepare("SELECT COUNT(*) AS n FROM demo_calls WHERE created_at >= datetime('now','-1 day')").first();
  if ((perDay?.n || 0) >= 30) return json({ ok:false, error:'Demo calls are busy right now — please try again later.' }, 429);
  const callName = (body.callName || 'there').toString().slice(0, 40);
  const voice = typeof body.voice === 'string' && body.voice.trim() ? body.voice.trim() : 'june';
  const res = await placeCall({ to, patientName: callName, medicineNames: ['your morning medicine (this is just a quick demo)'], voice }, env);
  await db.prepare('INSERT INTO demo_calls (phone) VALUES (?)').bind(to).run();
  if (!res.ok) return json({ ok:false, error:'Could not place the demo call right now.' }, 502);
  return json({ ok:true, message:'Calling you now — answer to hear it.' });
}
```
- [ ] **Step 4:** `node --check`; `node test/reminders.test.mjs` (15/0). Local: invalid phone → 422.
- [ ] **Step 5:** commit `git add src/reminders.js && git commit --no-verify -m "feat(reminders): throttled demo-call endpoint"`

---

## Task D: Intake UI — preferred name, voice picker, demo call

**File:** `public/reminders/intake.html`. READ it first to match the wizard structure.

- [ ] **Step 1:** On the **patient step**, add two fields below the existing name/phone/timezone:
  - **"What should the agent call them on the call?"** (text, placeholder "Grandma Rose, Rose, Mom…") → bound to `state.patient.preferred_name`. Helper: "Leave blank to use their name."
  - **"Voice"** (`<select>` of the curated voices; value = the Bland id/name, label = the friendly name). Default `june`. Bound to `state.patient.voice`. The six options:
    `june`→"June — warm & friendly (default)", `17a0eab8-d7d5-4304-bb41-7a7b6bda96d3`→"Grace — warm, Southern", `bbeabae6-ec8d-444f-92ad-c8e620d3de8d`→"Tina — gentle", `aec18940-3d5a-4454-acd2-66f685e83b67`→"Martha — casual & friendly", `ff2c405b-3dba-41e0-9261-bc8ee3f91f46`→"David — reassuring", `17e8f694-d230-4b64-b040-6108088d9e6c`→"Dorothy — British".
  - A small **"🔊 Hear this voice — call my phone"** control: a phone input (defaults to the patient phone) + a button that POSTs `{phone, voice: state.patient.voice, callName: state.patient.preferred_name || state.patient.name}` to `/reminders/api/demo-call`. Show the returned `message` or `error` inline. Disable the button for ~20s after a click to prevent double-taps.
- [ ] **Step 2:** Ensure `buildPayload()` includes `patient.preferred_name` and `patient.voice` in the POST to `/reminders/api/intake` (the server reads `p.patient.preferred_name` / `p.patient.voice`).
- [ ] **Step 3:** verify it serves + the field/select render:
```bash
wrangler dev --config ./wrangler.toml --port 8841 --local > /tmp/wd-ui.log 2>&1 &
sleep 9
curl -s http://localhost:8841/reminders/intake | grep -c "demo-call\|preferred_name\|Hear this voice"
kill %1 2>/dev/null
```
Expected ≥1. (Full flow verified live by the controller.)
- [ ] **Step 4:** commit `git add public/reminders/intake.html && git commit --no-verify -m "feat(reminders): intake voice picker, call-name, and live demo-call"`

---

## Task E: Deploy + LIVE verification (GATED — controller)

- [ ] Deploy.
- [ ] **Real alert path:** place a real call (via demo or a scheduled call), the user says "I'm not feeling well," confirm the post-call webhook → concern detection → **real email + SMS** arrive. This closes the exact gap that failed.
- [ ] **Fallback path:** simulate a dropped webhook (place a call but don't deliver the webhook) and confirm `runWebhookFallback` polls Bland and alerts anyway.
- [ ] **Demo + voice:** trigger a demo call in a non-default voice; confirm it rings and uses the chosen voice + call-name.
- [ ] Clean up test rows. Push `main`.

---

## Self-Review (planning)
Reliability: `processCallOutcome` is idempotent (terminal-status guard) so webhook + fallback can't double-alert; fallback only polls `placed` calls >3 min old (gives the webhook first chance). Personalization: additive columns are backfilled NULL → callers fall back to `name`/`june`. Demo: throttled per-phone + global/day to bound cost/abuse. Types: `placeCall({voice})` already supported; `buildTask` takes the name string; `normalizeBlandWebhook` shape consumed identically by webhook + fallback.
```
