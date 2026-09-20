// Node sanity test for dreamlist helpers. Run: node test/dreamlist.test.mjs
import {
  isEmail, escapeHtml, midpoint, needsRenumber, renumber, clampText,
  dayKey, groupByDay, partitionByLocation, boundsFor, normalizeGeoResult,
  formatWhen, firstName, sanitizeItemFields, buildInviteEmail,
  ACCENTS, CATEGORIES,
} from '../src/dreamlist.js';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('FAIL:', msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

// --- isEmail ---
ok(isEmail('a@b.co'), 'simple email valid');
ok(!isEmail('nope'), 'garbage rejected');
ok(!isEmail('a@b'), 'missing TLD rejected');
ok(!isEmail(null), 'null rejected');

// --- escapeHtml ---
eq(escapeHtml('<script>'), '&lt;script&gt;', 'tags escaped');
eq(escapeHtml(`it's "x" & y`), 'it&#39;s &quot;x&quot; &amp; y', 'quotes and amp escaped');
eq(escapeHtml(null), '', 'null becomes empty string');

// --- midpoint ---
eq(midpoint(null, null), 1000, 'empty list gets a starting position');
eq(midpoint(null, 500), 400, 'dropping above the first item goes below it');
eq(midpoint(500, null), 600, 'dropping below the last item goes above it');
eq(midpoint(100, 200), 150, 'between two items is the midpoint');
eq(midpoint(200, 100), 300, 'reversed neighbours push past the anchor');
eq(midpoint(100, 100), 200, 'equal neighbours push past rather than collide');

// --- needsRenumber / renumber ---
ok(!needsRenumber([1, 2, 3]), 'healthy spacing needs no renumber');
ok(!needsRenumber([1000]), 'single item never needs renumber');
ok(!needsRenumber([]), 'empty never needs renumber');
ok(needsRenumber([1, 1]), 'duplicate positions force a renumber');
ok(needsRenumber([1, 1 + 1e-9]), 'collapsed float gap forces a renumber');
ok(needsRenumber([5, 3]), 'out-of-order positions force a renumber');
eq(renumber(3).join(','), '1000,2000,3000', 'renumber spaces evenly');
eq(renumber(0).length, 0, 'renumber of nothing is empty');

// --- clampText ---
eq(clampText('  hi  ', 10), 'hi', 'trims whitespace');
eq(clampText('', 10), null, 'empty becomes null');
eq(clampText('   ', 10), null, 'whitespace-only becomes null');
eq(clampText('abcdef', 3), 'abc', 'clamps to max');
eq(clampText(42, 10), null, 'non-string becomes null');

// --- dayKey ---
eq(dayKey('2026-03-14T18:30:00Z', 'UTC'), '2026-03-14', 'UTC day key');
eq(dayKey('2026-03-14T02:30:00Z', 'America/New_York'), '2026-03-13', 'timezone shifts the day back');
eq(dayKey(null, 'UTC'), null, 'no date means no day');
eq(dayKey('not a date', 'UTC'), null, 'unparseable date means no day');

// --- groupByDay ---
const scheduled = [
  { id: 'a', scheduledAt: '2026-03-14T18:00:00Z' },
  { id: 'b', scheduledAt: '2026-03-14T09:00:00Z' },
  { id: 'c', scheduledAt: null },
  { id: 'd', scheduledAt: '2026-03-15T12:00:00Z' },
];
const grouped = groupByDay(scheduled, 'UTC');
eq(Object.keys(grouped).length, 2, 'two days have dreams');
eq(grouped['2026-03-14'].length, 2, 'both March 14 dreams land together');
eq(grouped['2026-03-14'][0].id, 'b', 'same-day dreams sort by time');
ok(!Object.values(grouped).flat().some(i => i.id === 'c'), 'undated dream stays off the calendar');
eq(Object.keys(groupByDay(null, 'UTC')).length, 0, 'null input is an empty grouping');

// --- partitionByLocation ---
const mixed = [
  { id: 'p', lat: 35.6, lng: 139.7 },
  { id: 'q', lat: null, lng: null },
  { id: 'r', lat: 0, lng: 0 },
];
const part = partitionByLocation(mixed);
eq(part.pinned.length, 2, 'null island still counts as a real pin');
eq(part.unpinned.length, 1, 'coordinate-less dream is listed separately');
eq(partitionByLocation(null).pinned.length, 0, 'null input partitions cleanly');

// --- boundsFor ---
eq(boundsFor([]), null, 'no pins means no bounds');
eq(boundsFor([{ lat: null, lng: null }]), null, 'pinless items give no bounds');
const single = boundsFor([{ lat: 10, lng: 20 }], 0.5);
eq(single[0][0], 9.5, 'single pin gets padded south edge');
eq(single[1][1], 20.5, 'single pin gets padded east edge');
const multi = boundsFor([{ lat: 10, lng: 20 }, { lat: 30, lng: -5 }], 0);
eq(multi[0][0], 10, 'bounds take the min latitude');
eq(multi[1][0], 30, 'bounds take the max latitude');
eq(multi[0][1], -5, 'bounds take the min longitude');

// --- normalizeGeoResult ---
const geo = normalizeGeoResult({ lat: '35.6812', lon: '139.7671', display_name: 'Tokyo Station, Chiyoda, Japan', name: 'Tokyo Station' });
eq(geo.label, 'Tokyo Station', 'uses the place name when present');
eq(geo.address, 'Tokyo Station, Chiyoda, Japan', 'keeps the full address');
ok(Math.abs(geo.lat - 35.6812) < 1e-6, 'latitude parsed as a number');
eq(normalizeGeoResult({ lat: 'x', lon: 'y', display_name: 'nowhere' }), null, 'unparseable coords rejected');
eq(normalizeGeoResult({ lat: '1', lon: '2' }), null, 'result with no display name rejected');
eq(normalizeGeoResult(null), null, 'null result rejected');
eq(normalizeGeoResult({ lat: '1', lon: '2', display_name: 'Alpha, Beta' }).label, 'Alpha',
  'falls back to the first address part when unnamed');

// --- formatWhen ---
ok(formatWhen('2026-03-14T18:30:00Z', 'UTC', false).includes('6:30'), 'timed dream shows a time');
ok(!formatWhen('2026-03-14T18:30:00Z', 'UTC', true).includes('6:30'), 'all-day dream hides the time');
eq(formatWhen(null, 'UTC', true), '', 'no date formats to nothing');
eq(formatWhen('garbage', 'UTC', true), '', 'bad date formats to nothing');

// --- firstName ---
eq(firstName('Ada Lovelace'), 'Ada', 'takes the first word');
eq(firstName('  '), '', 'blank name stays blank');
eq(firstName(null), '', 'null name stays blank');

// --- sanitizeItemFields ---
let f = sanitizeItemFields({ title: '  Ramen in Tokyo  ' });
eq(f.title, 'Ramen in Tokyo', 'title trimmed on create');
ok(sanitizeItemFields({}).error, 'create without a title is rejected');
ok(!sanitizeItemFields({}, { partial: true }).error, 'patch without a title is fine');
ok(sanitizeItemFields({ title: '   ' }).error, 'whitespace title is rejected');

f = sanitizeItemFields({ title: 'x', category: 'invented' });
eq(f.category, null, 'unknown category falls back to null');
eq(sanitizeItemFields({ title: 'x', category: 'food' }).category, 'food', 'known category kept');
ok(CATEGORIES.includes('travel') && ACCENTS.includes('ember'), 'vocabularies exported');

ok(sanitizeItemFields({ title: 'x', status: 'sideways' }).error, 'unknown status rejected');
eq(sanitizeItemFields({ title: 'x', starred: 'yes' }).starred, 1, 'truthy star becomes 1');
eq(sanitizeItemFields({ title: 'x', starred: false }).starred, 0, 'falsy star becomes 0');

f = sanitizeItemFields({ title: 'x', lat: 35.6, lng: 139.7 });
eq(f.lat, 35.6, 'valid coords kept');
f = sanitizeItemFields({ title: 'x', lat: 999, lng: 10 });
eq(f.lat, null, 'out-of-range latitude drops the pin');
eq(f.lng, null, 'a dropped pin clears both halves');
f = sanitizeItemFields({ title: 'x', lat: 35.6 });
eq(f.lat, null, 'half a coordinate pair is not a pin');

f = sanitizeItemFields({ title: 'x', scheduledAt: '2026-03-14T18:30:00Z' });
eq(f.scheduled_at, '2026-03-14T18:30:00.000Z', 'date normalized to ISO');
eq(sanitizeItemFields({ title: 'x', scheduledAt: null }).scheduled_at, null, 'null date clears the schedule');
eq(sanitizeItemFields({ title: 'x', scheduledAt: '' }).scheduled_at, null, 'empty date clears the schedule');
ok(sanitizeItemFields({ title: 'x', scheduledAt: 'someday' }).error, 'unparseable date rejected');

eq(sanitizeItemFields({ title: 'x', placeLabel: '  Blue Bottle ' }).place_label, 'Blue Bottle', 'place label trimmed');
ok(!('notes' in sanitizeItemFields({ title: 'x' })), 'omitted field is not written on a patch');

// --- buildInviteEmail ---
let mail = buildInviteEmail({ hostName: 'Chris Rathbun', listName: 'Our Dreamlist', emoji: '✨', link: 'https://x.co/d/tok', itemCount: 3 });
ok(mail.subject.includes('Chris'), 'subject names the inviter by first name');
ok(!mail.subject.includes('Rathbun'), 'subject drops the surname');
ok(mail.subject.includes('Our Dreamlist'), 'subject names the list');
ok(mail.text.includes('https://x.co/d/tok'), 'plaintext carries the link');
ok(mail.html.includes('https://x.co/d/tok'), 'html carries the link');
ok(mail.text.includes('are 3 dreams'), 'teaser pluralizes a multi-item list');
ok(buildInviteEmail({ hostName: 'A', listName: 'L', link: '#', itemCount: 1 }).text.includes('is 1 dream'),
  'teaser stays singular for one dream');
ok(buildInviteEmail({ hostName: 'A', listName: 'L', link: '#', itemCount: 0 }).text.includes('empty so far'),
  'empty list gets its own teaser');
ok(buildInviteEmail({ listName: 'L', link: '#', itemCount: 0 }).subject.startsWith('Someone'),
  'missing inviter name falls back gracefully');

// The repo's email voice rule: no em dashes in anything we send.
ok(!mail.text.includes('—') && !mail.html.includes('—'), 'invite email has no em dashes');
ok(!mail.text.includes('–'), 'invite email has no en dashes');

mail = buildInviteEmail({ hostName: 'Chris', listName: '<b>bad</b>', emoji: '✨', link: 'https://x.co/d/t', itemCount: 0 });
ok(!mail.html.includes('<b>bad</b>'), 'list name is escaped in the html body');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
