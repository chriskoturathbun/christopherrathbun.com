// Run: node test/reminders-clerk.test.mjs
import { b64urlToBytes, decodeJwtParts } from '../src/reminders-clerk.js';

let pass = 0, fail = 0;
function ok(c,m){ if(c) pass++; else { fail++; console.error('FAIL:',m); } }
function eq(a,b,m){ ok(a===b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

const bytes = b64urlToBytes('aGVsbG8');
eq(new TextDecoder().decode(bytes), 'hello', 'b64url decodes hello');

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
