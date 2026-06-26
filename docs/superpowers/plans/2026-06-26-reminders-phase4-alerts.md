# Reminders — Phase 4 (Need-Detection & Alerts) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** When a reminder call finishes, detect whether the person had a question, a need, refused their meds, or didn't answer — and alert the purchaser and emergency contact by **email + SMS** with the detail.

**Architecture:** Each Bland call carries a `webhook` URL (with a shared-secret token). When Bland posts the call result, `/reminders/api/bland-webhook` updates the `calls` row (transcript/status/duration/recording), then classifies the transcript with `gpt-4o-mini` (via the existing `OPENAI_API_KEY`). On a detected concern OR a no-answer/failed call, it emails (Resend, verified domain `mail.giftanagent.com`) and texts (Twilio, already configured) both contacts, and logs an `alerts` row. A new module `src/reminders-alerts.js` holds the pure logic (payload normalization, prompt building, response parsing, message formatting) + the I/O senders.

**Tech Stack:** Cloudflare Workers, D1, Bland webhooks, OpenAI `gpt-4o-mini`, Resend REST API, Twilio REST API, plain Node `.mjs` tests.

**Verified facts:** Resend from `Reminders <reminders@mail.giftanagent.com>` (domain verified in the giftagent Resend account; `RESEND_API_KEY` in Doppler `giftagent-web/dev`). Twilio creds already on the worker. OpenAI key already on the worker.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/reminders-alerts.js` | PURE: `normalizeBlandWebhook`, `buildConcernPrompt`, `parseConcernResponse`, `formatAlert`; I/O: `detectConcern`, `sendResendEmail`, `sendTwilioSms` |
| `src/reminders-bland.js` | MODIFY: thread an optional `webhook` URL into the call body |
| `src/reminders.js` | MODIFY: `alerts` table; pass webhook URL when placing/scheduling; `/reminders/api/bland-webhook` handler |
| `wrangler.toml` | MODIFY: add `PUBLIC_BASE_URL` var |
| `test/reminders-alerts.test.mjs` | Unit tests for the pure functions |

---

## Task 1: Alerts module — pure logic (TDD)

**Files:** Create `src/reminders-alerts.js`, Create `test/reminders-alerts.test.mjs`

- [ ] **Step 1: Failing tests** — create `test/reminders-alerts.test.mjs`:

```js
// Run: node test/reminders-alerts.test.mjs
import { normalizeBlandWebhook, buildConcernPrompt, parseConcernResponse, formatAlert } from '../src/reminders-alerts.js';

let pass = 0, fail = 0;
function ok(c,m){ if(c) pass++; else { fail++; console.error('FAIL:',m); } }
function eq(a,b,m){ ok(a===b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

// normalizeBlandWebhook — pull the fields we need from Bland's payload shape
const wh = normalizeBlandWebhook({
  call_id: 'abc', answered_by: 'human', completed: true, call_length: 1.5,
  recording_url: 'https://rec/x.mp3',
  concatenated_transcript: "assistant: time for your meds\nuser: what is this pill for?",
});
eq(wh.callId, 'abc', 'callId');
eq(wh.answeredByHuman, true, 'answered by human');
eq(wh.durationSec, 90, 'call_length minutes → seconds');
eq(wh.recordingUrl, 'https://rec/x.mp3', 'recording url');
ok(wh.transcript.includes('what is this pill for'), 'transcript text');

// no-answer detection
const wh2 = normalizeBlandWebhook({ call_id: 'd', answered_by: 'no-answer', completed: false });
eq(wh2.answeredByHuman, false, 'no-answer → not human');

// buildConcernPrompt includes patient name + transcript
const msgs = buildConcernPrompt('Rose', 'user: I feel dizzy');
ok(Array.isArray(msgs), 'returns messages array');
ok(JSON.stringify(msgs).includes('Rose'), 'prompt names patient');
ok(JSON.stringify(msgs).includes('I feel dizzy'), 'prompt includes transcript');

// parseConcernResponse handles plain JSON and fenced JSON
const a = parseConcernResponse('{"concern":true,"severity":"high","category":"health","summary":"dizzy"}');
eq(a.concern, true, 'parsed concern'); eq(a.severity, 'high', 'parsed severity');
const b = parseConcernResponse('```json\n{"concern":false,"severity":"none","category":"none","summary":"ok"}\n```');
eq(b.concern, false, 'parsed fenced'); 
const c = parseConcernResponse('garbage not json');
eq(c.concern, false, 'malformed → safe default no-concern'); eq(c.severity, 'none', 'malformed severity none');

// formatAlert builds subject + body text from inputs
const al = formatAlert({ patientName:'Rose', kind:'concern', summary:'asked what a pill is for', transcript:'...', recordingUrl:'https://rec', detectedAtISO:'2026-06-26T15:00:00Z' });
ok(al.subject.toLowerCase().includes('rose'), 'subject names patient');
ok(al.text.includes('asked what a pill is for'), 'body includes summary');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
```

- [ ] **Step 2: Run → fails.**

- [ ] **Step 3: Implement `src/reminders-alerts.js`**:

```js
// Reminders — post-call need detection + alert delivery.

// Normalize Bland's webhook payload to the fields we use.
export function normalizeBlandWebhook(body) {
  body = body || {};
  let transcript = '';
  if (typeof body.concatenated_transcript === 'string') transcript = body.concatenated_transcript;
  else if (Array.isArray(body.transcripts)) transcript = body.transcripts.map(t => `${t.user || t.role || 'speaker'}: ${t.text || ''}`).join('\n');
  const lenMin = typeof body.call_length === 'number' ? body.call_length : (typeof body.corrected_duration === 'number' ? body.corrected_duration / 60 : 0);
  return {
    callId: body.call_id || body.callId || null,
    status: body.status || (body.completed ? 'completed' : 'unknown'),
    answeredByHuman: body.answered_by === 'human',
    answeredBy: body.answered_by || null,
    completed: !!body.completed,
    durationSec: Math.round(lenMin * 60),
    recordingUrl: body.recording_url || null,
    transcript,
    costUsd: typeof body.price === 'number' ? body.price : null,
  };
}

// Build the gpt-4o-mini classification messages.
export function buildConcernPrompt(patientName, transcript) {
  return [
    { role: 'system', content:
      'You analyze a transcript of an automated medication-reminder phone call to an elderly person. ' +
      'Decide if a human caregiver should be alerted. Alert if the person: expresses confusion about their medication, ' +
      'asks a question that needs follow-up, reports a health problem or symptom, refuses or says they will skip the medication, ' +
      'sounds distressed, or asks for help. Do NOT alert for a normal, friendly acknowledgement. ' +
      'Respond with ONLY a compact JSON object: {"concern": boolean, "severity": "none"|"low"|"medium"|"high", ' +
      '"category": "none"|"question"|"health"|"refusal"|"confusion"|"help", "summary": "one short sentence"}.' },
    { role: 'user', content: `Patient: ${patientName}\nTranscript:\n${transcript || '(no transcript available)'}` },
  ];
}

// Parse the model's reply into a safe object (default: no concern).
export function parseConcernResponse(text) {
  const safe = { concern: false, severity: 'none', category: 'none', summary: '' };
  if (!text) return safe;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{'), end = s.lastIndexOf('}');
  if (start === -1 || end === -1) return safe;
  try {
    const o = JSON.parse(s.slice(start, end + 1));
    return {
      concern: !!o.concern,
      severity: ['none','low','medium','high'].includes(o.severity) ? o.severity : (o.concern ? 'medium' : 'none'),
      category: typeof o.category === 'string' ? o.category : 'none',
      summary: typeof o.summary === 'string' ? o.summary : '',
    };
  } catch { return safe; }
}

// Build a human-readable alert (subject + plaintext + html).
export function formatAlert({ patientName, kind, summary, transcript, recordingUrl, detectedAtISO }) {
  const label = kind === 'no_answer' ? 'did not answer their reminder call'
    : kind === 'failed' ? 'reminder call could not be completed'
    : 'may need help after their reminder call';
  const subject = `Reminders alert: ${patientName} ${label}`;
  const lines = [
    `${patientName} ${label}.`,
    summary ? `\nWhat happened: ${summary}` : '',
    detectedAtISO ? `\nTime: ${detectedAtISO}` : '',
    recordingUrl ? `\nCall recording: ${recordingUrl}` : '',
    transcript ? `\n\nTranscript:\n${transcript}` : '',
    `\n\n— Reminders (this is an automated safety alert; Reminders is not a substitute for emergency services).`,
  ];
  const text = lines.filter(Boolean).join('');
  const html = `<div style="font-family:system-ui,sans-serif;line-height:1.5">` +
    `<h2 style="margin:0 0 8px">${escapeHtml(patientName)} ${escapeHtml(label)}</h2>` +
    (summary ? `<p><strong>What happened:</strong> ${escapeHtml(summary)}</p>` : '') +
    (detectedAtISO ? `<p><strong>Time:</strong> ${escapeHtml(detectedAtISO)}</p>` : '') +
    (recordingUrl ? `<p><a href="${escapeHtml(recordingUrl)}">Listen to the call recording</a></p>` : '') +
    (transcript ? `<pre style="white-space:pre-wrap;background:#f5f5f7;padding:12px;border-radius:8px">${escapeHtml(transcript)}</pre>` : '') +
    `<p style="color:#888;font-size:13px">Automated safety alert — Reminders is not a substitute for emergency services.</p></div>`;
  return { subject, text, html };
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

// --- I/O ---

export async function detectConcern(patientName, transcript, env) {
  if (!transcript || !env.OPENAI_API_KEY) return { concern: false, severity: 'none', category: 'none', summary: '' };
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', temperature: 0, messages: buildConcernPrompt(patientName, transcript) }),
    });
    if (!res.ok) return { concern: false, severity: 'none', category: 'none', summary: '' };
    const data = await res.json();
    return parseConcernResponse(data.choices?.[0]?.message?.content || '');
  } catch { return { concern: false, severity: 'none', category: 'none', summary: '' }; }
}

export async function sendResendEmail({ to, subject, html, text }, env) {
  if (!env.RESEND_API_KEY || !to) return { ok: false, error: 'no key/recipient' };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: 'Reminders <reminders@mail.giftanagent.com>', to: Array.isArray(to) ? to : [to], subject, html, text }),
  });
  return { ok: res.ok, status: res.status };
}

export async function sendTwilioSms({ to, body }, env) {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_PHONE_NUMBER || !to) return { ok: false, error: 'twilio not configured' };
  const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`;
  const form = new URLSearchParams({ To: to, From: env.TWILIO_PHONE_NUMBER, Body: body });
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: 'Basic ' + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`), 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  return { ok: res.ok, status: res.status };
}
```

- [ ] **Step 4: Run → all pass.** `node --check src/reminders-alerts.js`.

- [ ] **Step 5: Commit**
```bash
git add src/reminders-alerts.js test/reminders-alerts.test.mjs
git commit --no-verify -m "feat(reminders): alerts module — concern detection + email/SMS senders + tests"
```

---

## Task 2: Thread webhook URL into Bland calls

**Files:** Modify `src/reminders-bland.js`, Modify `src/reminders.js`, Modify `wrangler.toml`

- [ ] **Step 1: `reminders-bland.js`** — accept an optional `webhook` in both `placeCall` and `scheduleCall` and include it in the body. In `placeCall`'s opts add `webhook`, and in the `_post({...})` call add `...(webhook ? { webhook } : {})`. Do the same for `scheduleCall`. (Bland posts call results to this URL on completion.)

Concretely, change the `placeCall` signature/body to:
```js
export async function placeCall({ to, patientName, medicineNames, voice = 'june', from, webhook }, env) {
  return _post({ phone_number: to, task: buildTask(patientName, medicineNames), voice, record: true, max_duration: 5, wait_for_greeting: true, ...(from ? { from } : {}), ...(webhook ? { webhook } : {}) }, env);
}
```
and `scheduleCall` similarly (add `webhook` to its destructured opts and `...(webhook ? { webhook } : {})` to its `_post` body).

- [ ] **Step 2: `reminders.js`** — add a helper and pass it. Near the top-level helpers add:
```js
function blandWebhookUrl(env) {
  const base = env.PUBLIC_BASE_URL || 'https://christopherrathbun.com';
  return env.REMINDERS_WEBHOOK_SECRET ? `${base}/reminders/api/bland-webhook?token=${env.REMINDERS_WEBHOOK_SECRET}` : undefined;
}
```
Then in `runReconciler`, change the `placeCall(...)` call to include the webhook:
```js
    const res = await placeCall({ to: r.phone_e164, patientName: r.name, medicineNames: meds, webhook: blandWebhookUrl(env) }, env);
```
And in `runPreScheduler`, change the `scheduleCall(...)` call to include `webhook: blandWebhookUrl(env)`.

- [ ] **Step 3: `wrangler.toml`** — under `[vars]` add:
```toml
PUBLIC_BASE_URL = "https://christopherrathbun.com"
```

- [ ] **Step 4: Verify** — `node --check src/reminders-bland.js && node --check src/reminders.js`; `node test/reminders.test.mjs` (15/0).

- [ ] **Step 5: Commit**
```bash
git add src/reminders-bland.js src/reminders.js wrangler.toml
git commit --no-verify -m "feat(reminders): attach post-call webhook URL to Bland calls"
```

---

## Task 3: `alerts` table + webhook handler

**Files:** Modify `src/reminders.js`

- [ ] **Step 1: Add the `alerts` table** to the `ensureSchema` `db.batch([...])`:
```js
    db.prepare(`CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      call_id INTEGER, patient_id INTEGER NOT NULL,
      kind TEXT NOT NULL, severity TEXT, category TEXT, summary TEXT,
      channels_sent TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')))`),
```

- [ ] **Step 2: Add imports** at the top of `src/reminders.js`:
```js
import { normalizeBlandWebhook, detectConcern, formatAlert, sendResendEmail, sendTwilioSms } from './reminders-alerts.js';
```

- [ ] **Step 3: Add the route** in `handleReminders`, after the intake route:
```js
  if (path === '/reminders/api/bland-webhook' && request.method === 'POST') {
    return handleBlandWebhook(request, env, url);
  }
```

- [ ] **Step 4: Implement `handleBlandWebhook`** — append to `src/reminders.js`:
```js
async function handleBlandWebhook(request, env, url) {
  // Shared-secret check (token in query string).
  if (!env.REMINDERS_WEBHOOK_SECRET || url.searchParams.get('token') !== env.REMINDERS_WEBHOOK_SECRET) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }
  await ensureSchema(env);
  let body; try { body = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const wh = normalizeBlandWebhook(body);
  if (!wh.callId) return json({ ok: true, note: 'no call id' });

  const db = env.REMINDERS_DB;
  const call = await db.prepare('SELECT * FROM calls WHERE bland_call_id = ?').bind(wh.callId).first();
  if (!call) return json({ ok: true, note: 'unknown call' });

  // Update the call row with the outcome.
  const finalStatus = wh.answeredByHuman ? 'completed' : (wh.completed ? 'no_answer' : 'failed');
  await db.prepare(`UPDATE calls SET status=?, duration_sec=?, transcript=?, recording_url=?, cost_usd=COALESCE(?, cost_usd) WHERE id=?`)
    .bind(finalStatus, wh.durationSec || 0, wh.transcript || null, wh.recordingUrl || null, wh.costUsd, call.id).run();

  const patient = await db.prepare('SELECT * FROM patients WHERE id = ?').bind(call.patient_id).first();
  if (!patient) return json({ ok: true });

  // Decide whether to alert.
  let kind = null, detection = { concern: false, severity: 'none', category: 'none', summary: '' };
  if (finalStatus === 'no_answer') kind = 'no_answer';
  else if (finalStatus === 'failed') kind = 'failed';
  else {
    detection = await detectConcern(patient.name, wh.transcript, env);
    if (detection.concern) kind = 'concern';
  }
  if (!kind) return json({ ok: true, alerted: false });

  // Gather recipients: purchaser (account email) + emergency contact (email + phone).
  const account = await db.prepare('SELECT email FROM accounts WHERE id = ?').bind(patient.account_id).first();
  const ec = await db.prepare('SELECT name, phone_e164, email FROM emergency_contacts WHERE patient_id = ? LIMIT 1').bind(patient.id).first();
  const emails = [...new Set([account?.email, ec?.email].filter(Boolean))];
  const phones = [...new Set([ec?.phone_e164].filter(Boolean))];

  const alert = formatAlert({
    patientName: patient.name, kind,
    summary: detection.summary || (kind === 'no_answer' ? 'No answer on the scheduled reminder call.' : kind === 'failed' ? 'The call could not be completed.' : ''),
    transcript: wh.transcript, recordingUrl: wh.recordingUrl, detectedAtISO: new Date().toISOString(),
  });
  const smsBody = `${alert.subject}.${detection.summary ? ' ' + detection.summary : ''} — Reminders`;

  const channels = [];
  for (const to of emails) { const r = await sendResendEmail({ to, subject: alert.subject, html: alert.html, text: alert.text }, env); if (r.ok) channels.push(`email:${to}`); }
  for (const to of phones) { const r = await sendTwilioSms({ to, body: smsBody.slice(0, 320) }, env); if (r.ok) channels.push(`sms:${to}`); }

  await db.prepare('INSERT INTO alerts (call_id, patient_id, kind, severity, category, summary, channels_sent) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(call.id, patient.id, kind, detection.severity, detection.category, alert.subject, JSON.stringify(channels)).run();

  return json({ ok: true, alerted: true, kind, channels });
}
```

- [ ] **Step 5: Verify** — `node --check src/reminders.js`; `node test/reminders.test.mjs` (15/0). Unauthorized webhook (no token) returns 401:
```bash
wrangler dev --config ./wrangler.toml --port 8820 --local > /tmp/wd-wh.log 2>&1 &
sleep 9
curl -s -o /dev/null -w "no-token=%{http_code}\n" -X POST "http://localhost:8820/reminders/api/bland-webhook" -H 'content-type: application/json' -d '{"call_id":"x"}'
kill %1 2>/dev/null
```
Expected: `no-token=401`.

- [ ] **Step 6: Commit**
```bash
git add src/reminders.js
git commit --no-verify -m "feat(reminders): Bland webhook → concern detection → email + SMS alerts"
```

---

## Task 4: Secrets + LIVE alert verification (GATED — controller runs)

**Files:** none (operational)

- [ ] **Step 1:** Set secrets:
```bash
doppler secrets get RESEND_API_KEY --plain -p giftagent-web -c dev | npx wrangler secret put RESEND_API_KEY --config ./wrangler.toml
printf '%s' "<generated-webhook-secret>" | npx wrangler secret put REMINDERS_WEBHOOK_SECRET --config ./wrangler.toml
```
- [ ] **Step 2:** Deploy (`npx wrangler deploy --config ./wrangler.toml`).
- [ ] **Step 3:** Directly POST a synthetic Bland-shaped payload to `/reminders/api/bland-webhook?token=<secret>` referencing a real `calls` row's `bland_call_id`, with a transcript containing a clear concern (e.g. "user: I'm not going to take it, I feel sick"). Confirm: the `calls` row updates, an `alerts` row is created, and a **real email + SMS** arrive at the user's address/number (with the user's consent for the test).
- [ ] **Step 4:** Verify a no-answer payload (`answered_by:"no-answer"`) also produces an alert.
- [ ] **Step 5:** Clean up test rows. Push `main` to origin.

---

## Self-Review (completed during planning)

**Spec coverage (Phase 4):** detect questions/needs on a call → `detectConcern` (gpt-4o-mini) Task 1,3; inform purchaser + emergency contact → email (Resend) + SMS (Twilio) to both, Task 3; missed-call safety → `no_answer`/`failed` alerting, Task 3; transcript/recording captured → `calls` update (columns already exist), Task 3. Webhook secured by shared-secret token (Task 3).

**Placeholder scan:** none in code. `<generated-webhook-secret>` (Task 4) is an operational value the controller generates.

**Type/consistency:** `normalizeBlandWebhook` → `{callId, answeredByHuman, transcript, durationSec, recordingUrl, costUsd, completed, status}` consumed in `handleBlandWebhook`. `detectConcern`/`parseConcernResponse` → `{concern, severity, category, summary}`. `formatAlert` → `{subject, text, html}`. `sendResendEmail`/`sendTwilioSms` → `{ok}`. `calls.bland_call_id` set in Phase 2 reconciler/pre-scheduler is the join key. `alerts` columns match the INSERT. Webhook URL (Task 2) and secret check (Task 3) use the same `REMINDERS_WEBHOOK_SECRET`.

**Notes:** Bland must be told the webhook per-call (Task 2 threads it). Resend `from` uses the verified `mail.giftanagent.com` domain (can switch to a christopherrathbun.com sender once that domain is verified in Resend). Webhook signature is shared-secret (sufficient for v1); upgrade to Bland's signing if/when needed.
```
