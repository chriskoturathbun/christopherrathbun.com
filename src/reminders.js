// Reminders — AI medication-reminder calls. Phase 1: foundation.
import { optimizeCallPlan } from './reminders-schedule.js';
import { nextOccurrencesUTC } from './reminders-schedule.js';
import { placeCall, scheduleCall, getCall } from './reminders-bland.js';
import { verifyClerkJWT, getClerkUserEmail } from './reminders-clerk.js';
import { normalizeBlandWebhook, detectConcern, formatAlert, sendResendEmail, sendTwilioSms } from './reminders-alerts.js';

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
    db.prepare(`CREATE TABLE IF NOT EXISTS call_plan (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id INTEGER NOT NULL,
      local_time TEXT NOT NULL,
      medicine_names TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')))`),
    db.prepare(`CREATE TABLE IF NOT EXISTS calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id INTEGER NOT NULL,
      call_plan_id INTEGER,
      scheduled_at_utc TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled',
      bland_call_id TEXT,
      placed_at TEXT,
      duration_sec INTEGER,
      transcript TEXT,
      recording_url TEXT,
      cost_usd REAL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')))`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_calls_sched ON calls (scheduled_at_utc, status)`),
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_calls_dedupe ON calls (patient_id, call_plan_id, scheduled_at_utc)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      call_id INTEGER, patient_id INTEGER NOT NULL,
      kind TEXT NOT NULL, severity TEXT, category TEXT, summary TEXT,
      channels_sent TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')))`),
    db.prepare(`CREATE TABLE IF NOT EXISTS sms_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_sid TEXT, to_number TEXT, status TEXT, error_code TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')))`),
  ]);
  schemaReady = true;
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

// Dynamic/auth pages (dashboard, admin) must never be edge-cached.
async function fetchPageNoStore(env, origin, file) {
  const res = await env.ASSETS.fetch(new Request(new URL(file, origin).toString()));
  return new Response(res.body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

function blandWebhookUrl(env) {
  const base = env.PUBLIC_BASE_URL || 'https://christopherrathbun.com';
  return env.REMINDERS_WEBHOOK_SECRET ? `${base}/reminders/api/bland-webhook?token=${env.REMINDERS_WEBHOOK_SECRET}` : undefined;
}

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

  // Intake API (implemented in a later task).
  if (path === '/reminders/api/intake' && request.method === 'POST') {
    return handleIntakeSubmit(request, env);
  }

  if (path === '/reminders/api/bland-webhook' && request.method === 'POST') {
    return handleBlandWebhook(request, env, url);
  }

  if (path === '/reminders/api/sms-status' && request.method === 'POST') return handleSmsStatus(request, env, url);

  if (path === '/reminders/api/admin/approve' && request.method === 'POST') {
    return handleApprove(request, env);
  }

  if (path === '/reminders/api/admin/pending' && request.method === 'GET') return handleAdminPending(request, env);
  if (path === '/reminders/admin' || path === '/reminders/admin/') return fetchPageNoStore(env, url.origin, '/reminders/admin.html');

  if (path === '/reminders/api/dashboard/data' && request.method === 'GET') return handleDashboardData(request, env);
  if (path === '/reminders/api/dashboard/medicines' && request.method === 'POST') return handleUpdateMedicines(request, env);
  if (path === '/reminders/api/dashboard/patient-status' && request.method === 'POST') return handlePatientStatus(request, env);
  if (path === '/reminders/dashboard' || path === '/reminders/dashboard/') return fetchPageNoStore(env, url.origin, '/reminders/dashboard.html');

  // Page routes.
  if (path === '/reminders/intake' || path === '/reminders/intake/') return fetchPage(env, url.origin, '/reminders/intake.html');
  if (path === '/reminders/privacy' || path === '/reminders/privacy/') return fetchPage(env, url.origin, '/reminders/privacy.html');
  if (path === '/reminders/terms' || path === '/reminders/terms/') return fetchPage(env, url.origin, '/reminders/terms.html');

  // Landing (default for /reminders and unknown sub-paths).
  return fetchPage(env, url.origin, '/reminders/index.html');
}

// Recompute and persist a patient's call_plan from their active medicines.
export async function computeAndStoreCallPlan(db, patientId, medicines) {
  const plan = optimizeCallPlan(medicines);
  await db.prepare('UPDATE call_plan SET active = 0 WHERE patient_id = ?').bind(patientId).run();
  const stmts = plan.map(p => db.prepare(
    'INSERT INTO call_plan (patient_id, local_time, medicine_names, active) VALUES (?, ?, ?, 1)')
    .bind(patientId, p.local_time, JSON.stringify(p.medicine_names)));
  if (stmts.length) await db.batch(stmts);
  return plan;
}

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

  await computeAndStoreCallPlan(db, patient.id, normalized.medicines);

  return json({ ok: true, patientId: patient.id, status: 'pending_approval' });
}

// Hourly: materialize the next 48h of `calls` rows for active, approved patients,
// and best-effort pre-register each with Bland. Never let a Bland error block insertion.
export async function runPreScheduler(env, nowISO) {
  await ensureSchema(env);
  const db = env.REMINDERS_DB;
  const now = nowISO || new Date().toISOString();
  const patients = await db.prepare(
    `SELECT p.id, p.name, p.phone_e164, p.timezone FROM patients p
     JOIN accounts a ON a.id = p.account_id
     WHERE p.status = 'active' AND a.approved = 1`).all();
  let made = 0;
  for (const p of (patients.results || [])) {
    const plans = await db.prepare('SELECT id, local_time, medicine_names FROM call_plan WHERE patient_id = ? AND active = 1').bind(p.id).all();
    for (const plan of (plans.results || [])) {
      const occ = nextOccurrencesUTC([plan.local_time], p.timezone, now, 48);
      for (const iso of occ) {
        const r = await db.prepare(
          `INSERT OR IGNORE INTO calls (patient_id, call_plan_id, scheduled_at_utc, status) VALUES (?, ?, ?, 'scheduled')`)
          .bind(p.id, plan.id, iso).run();
        if (r.meta && r.meta.changes > 0) made++;
      }
    }
  }
  return { made };
}

async function handleApprove(request, env) {
  await ensureSchema(env);
  const auth = request.headers.get('authorization') || '';
  if (!env.REMINDERS_ADMIN_PASSCODE || auth !== `Bearer ${env.REMINDERS_ADMIN_PASSCODE}`) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }
  let body; try { body = await request.json(); } catch { return json({ ok:false, error:'bad json' }, 400); }
  const db = env.REMINDERS_DB;
  if (body.accountEmail) {
    await db.prepare('UPDATE accounts SET approved = 1 WHERE email = ?').bind(String(body.accountEmail).toLowerCase()).run();
  }
  if (body.activatePatientId) {
    await db.prepare("UPDATE patients SET status = 'active' WHERE id = ?").bind(body.activatePatientId).run();
  }
  return json({ ok: true });
}

// Every minute: place any call that is due now and not yet handed off, immediately.
// This is the on-time guarantee — fully within our control.
export async function runReconciler(env, nowISO) {
  await ensureSchema(env);
  const db = env.REMINDERS_DB;
  const now = new Date(nowISO || new Date().toISOString());
  const windowStart = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
  const dueAt = new Date(now.getTime() + 30 * 1000).toISOString();
  const rows = await db.prepare(
    `SELECT c.id, c.patient_id, c.call_plan_id, c.scheduled_at_utc, c.status, p.name, p.phone_e164,
            (SELECT medicine_names FROM call_plan WHERE id = c.call_plan_id) AS medicine_names
     FROM calls c
       JOIN patients p ON p.id = c.patient_id
       JOIN accounts a ON a.id = p.account_id
     WHERE c.placed_at IS NULL
       AND c.status = 'scheduled'
       AND p.status = 'active' AND a.approved = 1
       AND c.scheduled_at_utc <= ? AND c.scheduled_at_utc >= ?`)
    .bind(dueAt, windowStart).all();
  let placed = 0;
  for (const r of (rows.results || [])) {
    const meds = JSON.parse(r.medicine_names || '[]');
    const res = await placeCall({ to: r.phone_e164, patientName: r.name, medicineNames: meds, webhook: blandWebhookUrl(env) }, env);
    if (res.ok) {
      await db.prepare(`UPDATE calls SET status='placed', placed_at=?, bland_call_id=COALESCE(?, bland_call_id) WHERE id=?`)
        .bind(new Date().toISOString(), res.callId, r.id).run();
      placed++;
    } else {
      await db.prepare(`UPDATE calls SET status='failed', placed_at=? WHERE id=?`).bind(new Date().toISOString(), r.id).run();
    }
  }
  return { placed };
}

// Resolve the signed-in Clerk user → their account row (linking clerk_user_id on first login).
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
        account = await db.prepare('INSERT INTO accounts (clerk_user_id, email, approved) VALUES (?, ?, 0) RETURNING *').bind(payload.sub, email).first();
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
  if (next === 'active' && !ctx.account.approved) return json({ ok: false, error: 'account pending approval' }, 403);
  await db.prepare('UPDATE patients SET status = ? WHERE id = ?').bind(next, patient.id).run();
  if (next === 'paused') {
    await db.prepare("DELETE FROM calls WHERE patient_id = ? AND status = 'scheduled' AND placed_at IS NULL").bind(patient.id).run();
  }
  return json({ ok: true, status: next });
}

async function handleBlandWebhook(request, env, url) {
  if (!env.REMINDERS_WEBHOOK_SECRET || url.searchParams.get('token') !== env.REMINDERS_WEBHOOK_SECRET) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }
  await ensureSchema(env);
  let body; try { body = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const wh = normalizeBlandWebhook(body);
  if (!wh.callId) return json({ ok: true, note: 'no call id' });

  const call = await env.REMINDERS_DB.prepare('SELECT * FROM calls WHERE bland_call_id = ?').bind(wh.callId).first();
  if (!call) return json({ ok: true, note: 'unknown call' });

  return json(await processCallOutcome(env, call, wh));
}

// Shared by the webhook AND the fallback poller. Idempotent (skips terminal calls).
export async function processCallOutcome(env, call, wh) {
  const db = env.REMINDERS_DB;
  if (['completed', 'no_answer', 'failed'].includes(call.status)) {
    return { ok: true, alerted: false, note: 'already processed' };
  }

  const finalStatus = wh.answeredByHuman ? 'completed' : (wh.completed ? 'no_answer' : 'failed');
  await db.prepare(`UPDATE calls SET status=?, duration_sec=?, transcript=?, recording_url=?, cost_usd=COALESCE(?, cost_usd) WHERE id=?`)
    .bind(finalStatus, wh.durationSec || 0, wh.transcript || null, wh.recordingUrl || null, wh.costUsd, call.id).run();

  const patient = await db.prepare('SELECT * FROM patients WHERE id = ?').bind(call.patient_id).first();
  if (!patient) return { ok: true };

  let kind = null, detection = { concern: false, severity: 'none', category: 'none', summary: '' };
  if (finalStatus === 'no_answer') kind = 'no_answer';
  else if (finalStatus === 'failed') kind = 'failed';
  else {
    detection = await detectConcern(patient.name, wh.transcript, env);
    if (detection.concern) kind = 'concern';
  }
  if (!kind) return { ok: true, alerted: false };

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
  const smsCb = env.REMINDERS_WEBHOOK_SECRET ? `${env.PUBLIC_BASE_URL || 'https://christopherrathbun.com'}/reminders/api/sms-status?token=${env.REMINDERS_WEBHOOK_SECRET}` : undefined;
  for (const to of phones) { const r = await sendTwilioSms({ to, body: smsBody.slice(0, 320), statusCallback: smsCb }, env); if (r.ok) channels.push(`sms:${to}`); }

  await db.prepare('INSERT INTO alerts (call_id, patient_id, kind, severity, category, summary, channels_sent) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(call.id, patient.id, kind, detection.severity, detection.category, alert.subject, JSON.stringify(channels)).run();

  return { ok: true, alerted: !!kind, kind, channels };
}

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
    if (!(d.completed || ['completed', 'no-answer', 'failed'].includes(d.status))) continue; // not done yet
    const wh = normalizeBlandWebhook(d);
    await processCallOutcome(env, call, wh);
    processed++;
  }
  return { processed };
}

function requireAdmin(request, env) {
  const auth = request.headers.get('authorization') || '';
  return !!env.REMINDERS_ADMIN_PASSCODE && auth === `Bearer ${env.REMINDERS_ADMIN_PASSCODE}`;
}

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
