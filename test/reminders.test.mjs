// Node sanity test for reminders helpers. Run: node test/reminders.test.mjs
import { normalizePhone, validateIntake } from '../src/reminders.js';

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

let c = validateIntake({ ...goodPayload, consent: { tcpa: false, recording: true, attestation: true } });
ok(!c.valid, 'no tcpa consent → invalid');
ok(c.errors.some(e => e.includes('consent')), 'consent error surfaced');

let s = validateIntake({ ...goodPayload, flow: 'self', consent: { tcpa: true, recording: true, attestation: false } });
ok(s.valid, 'self flow without attestation valid');

let p = validateIntake({ ...goodPayload, patient: { ...goodPayload.patient, phone: '123' } });
ok(!p.valid, 'bad patient phone → invalid');

let m = validateIntake({ ...goodPayload, medicines: [] });
ok(!m.valid, 'no medicines → invalid');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
