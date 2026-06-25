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
