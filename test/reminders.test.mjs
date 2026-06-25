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
