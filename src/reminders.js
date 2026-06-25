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

  // Intake API (implemented in a later task).
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
