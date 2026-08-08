// Node sanity test for parties helpers. Run: node test/parties.test.mjs
import {
  isEmail, parseGuestLine, formatEventWhen,
  buildInviteSms, buildReminderSms, buildUpdateSms, buildAdmitSms,
  buildInviteEmail, buildOgMeta, firstName, COVER_THEMES,
  TITLE_FONTS, httpsUrl, rsvpClosed,
} from '../src/parties.js';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('FAIL:', msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

// --- isEmail ---
ok(isEmail('a@b.co'), 'simple email valid');
ok(!isEmail('not-an-email'), 'garbage rejected');
ok(!isEmail('a@b'), 'missing TLD rejected');

// --- parseGuestLine ---
let g = parseGuestLine('Sam, 415-555-0132');
eq(g.name, 'Sam', 'name from "Name, phone"');
eq(g.phone, '+14155550132', 'phone normalized to E.164');
eq(g.email, null, 'no email on phone line');

g = parseGuestLine('Priya, priya@example.com');
eq(g.name, 'Priya', 'name from "Name, email"');
eq(g.email, 'priya@example.com', 'email captured');
eq(g.phone, null, 'no phone on email line');

g = parseGuestLine('Jordan Lee <Jordan@Example.COM>');
eq(g.name, 'Jordan Lee', 'angle-bracket name');
eq(g.email, 'jordan@example.com', 'angle-bracket email lowercased');

g = parseGuestLine('4155550177');
eq(g.name, null, 'bare phone has no name');
eq(g.phone, '+14155550177', 'bare phone normalized');

g = parseGuestLine('Dana, 415-555-0101, dana@example.com');
eq(g.name, 'Dana', 'three-part line name');
eq(g.phone, '+14155550101', 'three-part line phone');
eq(g.email, 'dana@example.com', 'three-part line email');

eq(parseGuestLine(''), null, 'empty line → null');
eq(parseGuestLine('   '), null, 'whitespace line → null');
g = parseGuestLine('Just A Name');
eq(g.name, 'Just A Name', 'name-only line keeps name');
eq(g.phone, null, 'name-only line has no phone');

// --- formatEventWhen ---
const when = formatEventWhen('2026-08-15T23:00:00.000Z', 'America/New_York');
ok(when.includes('Aug 15'), `event-tz date (got "${when}")`);
ok(when.includes('7:00'), `event-tz time (got "${when}")`);
eq(formatEventWhen(null, 'America/New_York'), '', 'null date → empty');
eq(formatEventWhen('garbage', 'America/New_York'), '', 'bad date → empty');

// --- SMS builders ---
const sms = buildInviteSms({ hostName: 'Chris', title: 'Rooftop Party', emoji: '🎉', whenText: 'Sat, Aug 15, 7:00 PM', link: 'https://christopherrathbun.com/e/abc123' });
ok(sms.includes('Chris invited you to Rooftop Party!'), 'invite SMS names host + title');
ok(sms.includes('https://christopherrathbun.com/e/abc123'), 'invite SMS has link');
ok(sms.includes('STOP'), 'invite SMS carries opt-out');
ok(sms.startsWith('🎉 '), 'invite SMS leads with emoji');

const noEmoji = buildInviteSms({ hostName: 'Chris', title: 'Dinner', emoji: '', whenText: '', link: 'x' });
ok(noEmoji.startsWith('Chris invited'), 'invite SMS works without emoji/when');

const rem = buildReminderSms({ title: 'Rooftop Party', emoji: '🎉', whenText: 'Sat, Aug 15, 7:00 PM', link: 'L' });
ok(rem.includes('Reminder: Rooftop Party is Sat, Aug 15, 7:00 PM.'), 'reminder SMS phrasing');

const upd = buildUpdateSms({ title: 'Rooftop Party', message: 'We start at 8 now!', link: 'L' });
eq(upd, 'Rooftop Party: We start at 8 now! L', 'update SMS phrasing');

// --- Invite email ---
const em = buildInviteEmail({ hostName: 'Chris', title: 'Rooftop <Party>', emoji: '🎉', whenText: 'Sat', location: 'Roof & Deck', description: 'BYOB', link: 'https://x/e/t' });
ok(em.subject.includes("You're invited: Rooftop <Party>"), 'email subject');
ok(em.html.includes('Rooftop &lt;Party&gt;'), 'email HTML escapes title');
ok(em.html.includes('Roof &amp; Deck'), 'email HTML escapes location');
ok(em.text.includes('RSVP here (no account needed): https://x/e/t'), 'email text has link');

// --- Admit SMS ---
const adm = buildAdmitSms({ title: 'Rooftop Party', emoji: '🎉', whenText: 'Sat 7 PM', link: 'L' });
ok(adm.includes("you're in for Rooftop Party!"), 'admit SMS phrasing');
ok(adm.includes('L'), 'admit SMS has link');

// --- firstName ---
eq(firstName('Sam Altman-Jones'), 'Sam', 'first name extracted');
eq(firstName('  '), '', 'blank name → empty');
eq(firstName(null), '', 'null name → empty');

// --- OG meta ---
const og = buildOgMeta({
  title: 'Rooftop "Party"', emoji: '🎉', whenText: 'Sat, Aug 15, 7:00 PM',
  location: 'Roof & Deck', imageUrl: 'https://img.example/x.png', pageUrl: 'https://x/e/sabc',
});
ok(og.includes('og:title'), 'og:title present');
ok(og.includes('Rooftop &quot;Party&quot;'), 'og title escaped');
ok(og.includes('Roof &amp; Deck'), 'og description escaped');
ok(og.includes('summary_large_image'), 'large card with image');
ok(og.includes('https://img.example/x.png'), 'og image url present');

const ogNoImg = buildOgMeta({ title: 'Dinner', emoji: '', whenText: '', location: '', imageUrl: '', pageUrl: '' });
ok(ogNoImg.includes('content="summary"'), 'summary card without image');
ok(ogNoImg.includes('You&#39;re invited!'), 'fallback description (escaped)');
ok(!ogNoImg.includes('og:image'), 'no og:image without url');

// --- themes ---
ok(COVER_THEMES.includes('confetti') && COVER_THEMES.length >= 8, 'cover themes defined');

// --- title fonts ---
ok(TITLE_FONTS.includes('classic') && TITLE_FONTS.length === 4, 'title fonts defined');

// --- httpsUrl ---
eq(httpsUrl('https://open.spotify.com/playlist/abc'), 'https://open.spotify.com/playlist/abc', 'valid https url kept');
eq(httpsUrl('http://example.com'), null, 'http (not https) rejected');
eq(httpsUrl('javascript:alert(1)'), null, 'javascript: url rejected');
eq(httpsUrl(''), null, 'empty url → null');
eq(httpsUrl('  https://a.co/x  '), 'https://a.co/x', 'url trimmed');

// --- rsvpClosed ---
ok(!rsvpClosed({ rsvp_deadline: null }), 'no deadline → open');
ok(!rsvpClosed(null), 'no event → open');
ok(rsvpClosed({ rsvp_deadline: '2020-01-01T00:00:00.000Z' }, new Date('2020-06-01T00:00:00Z')), 'past deadline → closed');
ok(!rsvpClosed({ rsvp_deadline: '2030-01-01T00:00:00.000Z' }, new Date('2020-06-01T00:00:00Z')), 'future deadline → open');
ok(!rsvpClosed({ rsvp_deadline: 'garbage' }), 'unparseable deadline → open');

console.log(`parties tests: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
