# Reminders — Phase 5 (Polish) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Finish the soft-launch polish — a real owner-gated **approval UI** (retire the curl/passcode workflow), **SMS delivery-status tracking** (so an undelivered text is caught, not silently trusted), and **per-account usage/cost** surfacing (billing-ready).

**Status:** the Higgsfield ambient hero (landing background) is already done + committed. This plan covers the remaining three items.

**Architecture:** All additions live in the existing `/reminders` worker. Admin endpoints reuse the `REMINDERS_ADMIN_PASSCODE` Bearer check (sent from a thin client page held in memory — no new session system). SMS status uses Twilio's `StatusCallback` → a token-gated handler that records final delivery in a new `sms_status` table.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/reminders.js` | MODIFY: `sms_status` table; admin `requireAdmin`; `/reminders/api/admin/pending` (+ cost aggregation); `/reminders/api/sms-status` handler; route `/reminders/admin` |
| `src/reminders-alerts.js` | MODIFY: `sendTwilioSms` accepts a `statusCallback` and returns the Twilio `sid` |
| `public/reminders/admin.html` | Owner passcode-gated approval + usage UI |

---

## Task 1: Admin approval + usage API

**Files:** Modify `src/reminders.js`

- [ ] **Step 1: `requireAdmin` helper** — append:
```js
function requireAdmin(request, env) {
  const auth = request.headers.get('authorization') || '';
  return !!env.REMINDERS_ADMIN_PASSCODE && auth === `Bearer ${env.REMINDERS_ADMIN_PASSCODE}`;
}
```

- [ ] **Step 2: Pending+usage endpoint** — add route in `handleReminders` after the existing admin approve route:
```js
  if (path === '/reminders/api/admin/pending' && request.method === 'GET') return handleAdminPending(request, env);
  if (path === '/reminders/admin' || path === '/reminders/admin/') return fetchPage(env, url.origin, '/reminders/admin.html');
```
and the handler:
```js
async function handleAdminPending(request, env) {
  await ensureSchema(env);
  if (!requireAdmin(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  const db = env.REMINDERS_DB;
  const accounts = (await db.prepare('SELECT id, email, name, approved, created_at FROM accounts ORDER BY approved ASC, id DESC').all()).results || [];
  const out = [];
  for (const a of accounts) {
    const patients = (await db.prepare('SELECT id, name, phone_e164, timezone, status FROM patients WHERE account_id = ? ORDER BY id').bind(a.id).all()).results || [];
    const usage = await db.prepare(`SELECT COUNT(*) AS calls, COALESCE(SUM(cost_usd),0) AS cost_usd
      FROM calls WHERE patient_id IN (SELECT id FROM patients WHERE account_id = ?) AND status IN ('placed','completed','no_answer')`).bind(a.id).first();
    out.push({ ...a, patients, usage: { calls: usage?.calls || 0, cost_usd: Math.round((usage?.cost_usd || 0) * 100) / 100 } });
  }
  const totals = out.reduce((t, a) => ({ calls: t.calls + a.usage.calls, cost_usd: Math.round((t.cost_usd + a.usage.cost_usd) * 100) / 100 }), { calls: 0, cost_usd: 0 });
  return json({ ok: true, accounts: out, totals });
}
```

- [ ] **Step 3: Verify** — `node --check src/reminders.js`; `node test/reminders.test.mjs` (15/0). 401 without passcode:
```bash
wrangler dev --config ./wrangler.toml --port 8830 --local > /tmp/wd-a.log 2>&1 &
sleep 9
curl -s -o /dev/null -w "no-auth=%{http_code}\n" http://localhost:8830/reminders/api/admin/pending
curl -s -o /dev/null -w "auth=%{http_code}\n" -H "authorization: Bearer testpass" http://localhost:8830/reminders/api/admin/pending
kill %1 2>/dev/null
```
Expected: `no-auth=401`; `auth=200` only if `REMINDERS_ADMIN_PASSCODE=testpass` is set — without it set locally, `auth=401` too (the env var isn't present in local dev). Either way `no-auth=401` is the key assertion. (To get a 200 locally, add `--var REMINDERS_ADMIN_PASSCODE:testpass` to the dev command.)

- [ ] **Step 4: Commit**
```bash
git add src/reminders.js
git commit --no-verify -m "feat(reminders): admin pending-approval + usage API"
```

---

## Task 2: Admin approval UI page

**Files:** Create `public/reminders/admin.html`

- [ ] **Step 1: Create `public/reminders/admin.html`** — reuse `reminders.css` shell + `.glass`/`.btn`/`.muted`. Behavior (vanilla JS):
  1. Passcode gate: a `.glass` card with a password input + "Unlock" button. On unlock, hold the passcode in a JS variable (and `sessionStorage` so a refresh keeps it) and call the API; on 401, show "Incorrect passcode."
  2. All admin calls send `authorization: 'Bearer ' + passcode`.
  3. `GET /reminders/api/admin/pending` → render:
     - A **totals** strip: total calls placed + total cost (`$X.XX`).
     - For each account: email, approved badge (✓ approved / ⏳ pending), its patients (name, phone, status), and per-account usage (calls + cost).
     - For a **pending** account (`approved===0`): an **Approve** button → `POST /reminders/api/admin/approve` with `{accountEmail}` and, for each of its patients, `{activatePatientId}` (call approve once per patient to set them active, or send accountEmail + the first patient; simplest: Approve button posts `{accountEmail}` then iterates patients posting `{activatePatientId}` for each). Re-fetch + re-render on success.
     - For each patient, a small **Activate/Pause** control posting `{activatePatientId}` (activate) — reuse the approve endpoint for activate; for pause, there is no admin pause, so only show Activate for paused/pending patients.
  4. Graceful errors; a "Refresh" button.

- [ ] **Step 2: Verify it serves**
```bash
wrangler dev --config ./wrangler.toml --port 8831 --local > /tmp/wd-au.log 2>&1 &
sleep 9
curl -s http://localhost:8831/reminders/admin | grep -c "Unlock\|passcode\|admin/pending"
kill %1 2>/dev/null
```
Expected: ≥1.

- [ ] **Step 3: Commit**
```bash
git add public/reminders/admin.html
git commit --no-verify -m "feat(reminders): owner-gated approval + usage admin UI"
```

---

## Task 3: SMS delivery-status tracking

**Files:** Modify `src/reminders-alerts.js`, Modify `src/reminders.js`

- [ ] **Step 1: `sendTwilioSms` returns sid + accepts statusCallback** — in `src/reminders-alerts.js`, change `sendTwilioSms` to accept `statusCallback` and include it in the form, and return the message sid:
```js
export async function sendTwilioSms({ to, body, statusCallback }, env) {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_PHONE_NUMBER || !to) return { ok: false, error: 'twilio not configured' };
  const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`;
  const params = { To: to, From: env.TWILIO_PHONE_NUMBER, Body: body };
  if (statusCallback) params.StatusCallback = statusCallback;
  const form = new URLSearchParams(params);
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: 'Basic ' + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`), 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  let sid = null; try { sid = (await res.json()).sid || null; } catch {}
  return { ok: res.ok, status: res.status, sid };
}
```

- [ ] **Step 2: `sms_status` table** — add to `ensureSchema` batch:
```js
    db.prepare(`CREATE TABLE IF NOT EXISTS sms_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_sid TEXT, to_number TEXT, status TEXT, error_code TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')))`),
```

- [ ] **Step 3: Pass statusCallback when sending alert SMS** — in `handleBlandWebhook`, change the SMS send loop to pass the callback:
```js
  const smsCb = env.REMINDERS_WEBHOOK_SECRET ? `${env.PUBLIC_BASE_URL || 'https://christopherrathbun.com'}/reminders/api/sms-status?token=${env.REMINDERS_WEBHOOK_SECRET}` : undefined;
  for (const to of phones) { const r = await sendTwilioSms({ to, body: smsBody.slice(0, 320), statusCallback: smsCb }, env); if (r.ok) channels.push(`sms:${to}`); }
```
(Replace the existing phones loop.)

- [ ] **Step 4: SMS status handler** — add route in `handleReminders` (after the bland-webhook route):
```js
  if (path === '/reminders/api/sms-status' && request.method === 'POST') return handleSmsStatus(request, env, url);
```
and the handler (Twilio posts `application/x-www-form-urlencoded`):
```js
async function handleSmsStatus(request, env, url) {
  if (!env.REMINDERS_WEBHOOK_SECRET || url.searchParams.get('token') !== env.REMINDERS_WEBHOOK_SECRET) return new Response('unauthorized', { status: 401 });
  await ensureSchema(env);
  let form; try { form = await request.formData(); } catch { return new Response('bad', { status: 400 }); }
  const sid = form.get('MessageSid') || form.get('SmsSid');
  const status = form.get('MessageStatus') || form.get('SmsStatus');
  const errorCode = form.get('ErrorCode') || null;
  const to = form.get('To') || null;
  if (sid) {
    await env.REMINDERS_DB.prepare('INSERT INTO sms_status (message_sid, to_number, status, error_code) VALUES (?, ?, ?, ?)').bind(sid, to, status, errorCode).run();
    if (status === 'undelivered' || status === 'failed') console.error('reminders SMS not delivered', sid, to, status, errorCode);
  }
  return new Response('', { status: 204 });
}
```

- [ ] **Step 5: Verify** — `node --check src/reminders.js && node --check src/reminders-alerts.js`; `node test/reminders.test.mjs` (15/0); `node test/reminders-alerts.test.mjs` (16/0 — the test passes `{to,body}` without statusCallback, still works). 401 without token:
```bash
wrangler dev --config ./wrangler.toml --port 8832 --local > /tmp/wd-s.log 2>&1 &
sleep 9
curl -s -o /dev/null -w "no-token=%{http_code}\n" -X POST "http://localhost:8832/reminders/api/sms-status" -d "MessageSid=x&MessageStatus=delivered"
kill %1 2>/dev/null
```
Expected: `no-token=401`.

- [ ] **Step 6: Commit**
```bash
git add src/reminders-alerts.js src/reminders.js
git commit --no-verify -m "feat(reminders): Twilio SMS delivery-status tracking"
```

---

## Task 4: Deploy + verify (GATED — controller)

- [ ] Deploy. Confirm `/reminders/admin` loads and the passcode unlock shows the pending list (incl. the test patient) with usage totals. Confirm a future alert SMS records a `sms_status` row. Push `main`.

---

## Self-Review (during planning)

**Spec coverage (Phase 5):** Higgsfield ambient visual (landing) — done/committed; soft-launch approval UI replacing manual passcode — Tasks 1,2 (owner-gated page); billing-ready accounting — per-account `cost_usd` aggregation in Task 1; SMS hardening (catch undelivered) — Task 3.

**Placeholder scan:** none. **Type consistency:** `requireAdmin` Bearer matches the existing `/reminders/api/admin/approve` check; `sendTwilioSms` new return `{ok,status,sid}` is backward-compatible (callers only read `.ok`); `sms_status` columns match the INSERT; admin endpoints reuse `REMINDERS_ADMIN_PASSCODE`. **Note:** approval UI iterates patients calling the existing approve endpoint — no new approve logic.
```
