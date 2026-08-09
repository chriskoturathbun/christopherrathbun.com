// Parties — create an event, invite people by text or email, guests RSVP
// from a link with no account and no questions. Host side is Clerk-gated;
// the guest side is identified purely by an unguessable token in the URL.
import { normalizePhone } from './reminders.js';
import { verifyClerkJWT, getClerkUserEmail } from './reminders-clerk.js';
import { sendResendEmail, sendTwilioSms } from './reminders-alerts.js';

// Guests a single event may hold, sends a single API call may perform, and
// sends a host may make per rolling day — modest caps so a compromised or
// abusive account can't burn the shared Twilio/Resend reputation.
const MAX_GUESTS_PER_EVENT = 200;
const MAX_SENDS_PER_REQUEST = 25;
const MAX_SENDS_PER_HOST_PER_DAY = 500;
const MAX_COMMENTS_PER_GUEST = 20;
// Auto-reminders drain in small per-minute cron batches inside a 22-24h
// pre-event window, so even a full 200-guest list clears with headroom.
const AUTO_REMINDER_BATCH = 12;

const RSVP_CHOICES = ['yes', 'maybe', 'no'];
export const COVER_THEMES = ['confetti', 'sunset', 'neon', 'ocean', 'garden', 'gold', 'midnight', 'cherry'];
export const TITLE_FONTS = ['classic', 'eclectic', 'fancy', 'literary'];
const MAX_DATE_OPTIONS = 8;

// --- Pure helpers (unit-tested in test/parties.test.mjs) ---

export function isEmail(s) {
  return typeof s === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.trim());
}

// Parse one line of pasted guest input into { name, phone, email }.
// Accepts: "Name, phone", "Name, email", "Name <email>", bare phone, bare
// email, or "Name, phone, email" in any order after the name. Returns null
// for a line with no usable contact info and no name.
export function parseGuestLine(line) {
  if (typeof line !== 'string') return null;
  const raw = line.trim();
  if (!raw) return null;

  let name = null, phone = null, email = null;

  // "Name <email@x.com>" form.
  const angled = raw.match(/^(.*?)<([^>]+)>\s*$/);
  if (angled && isEmail(angled[2])) {
    name = angled[1].trim().replace(/,\s*$/, '') || null;
    email = angled[2].trim().toLowerCase();
    return { name, phone, email };
  }

  const parts = raw.split(/[,;\t]/).map(p => p.trim()).filter(Boolean);
  const leftover = [];
  for (const part of parts) {
    if (!email && isEmail(part)) { email = part.toLowerCase(); continue; }
    const p = normalizePhone(part);
    if (!phone && p) { phone = p; continue; }
    leftover.push(part);
  }
  if (leftover.length) name = leftover.join(' ').trim() || null;
  if (!name && !phone && !email) return null;
  return { name, phone, email };
}

// Human-readable event time in the event's own timezone.
export function formatEventWhen(startsAtISO, timeZone) {
  if (!startsAtISO) return '';
  const d = new Date(startsAtISO);
  if (isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || 'UTC',
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    }).format(d);
  } catch {
    return d.toUTCString();
  }
}

export function buildInviteSms({ hostName, title, emoji, whenText, link }) {
  const lead = emoji ? `${emoji} ` : '';
  const when = whenText ? ` ${whenText}.` : '';
  return `${lead}${hostName} invited you to ${title}!${when} RSVP: ${link} Reply STOP to opt out`;
}

export function buildReminderSms({ title, emoji, whenText, link }) {
  const lead = emoji ? `${emoji} ` : '';
  const when = whenText ? ` ${whenText}.` : ' soon.';
  return `${lead}Reminder: ${title} is${when} Details + RSVP: ${link}`;
}

export function buildUpdateSms({ title, message, link }) {
  return `${title}: ${message} ${link}`;
}

export function buildAdmitSms({ title, emoji, whenText, link }) {
  const lead = emoji ? `${emoji} ` : '';
  const when = whenText ? ` ${whenText}.` : '';
  return `${lead}A spot opened up — you're in for ${title}!${when} Details: ${link}`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// OpenGraph/Twitter meta tags injected into the guest page server-side so
// the link unfurls as a rich card in iMessage/WhatsApp/Slack (unfurlers
// don't run JS, so this can't be done client-side).
export function buildOgMeta({ title, emoji, whenText, location, imageUrl, pageUrl }) {
  const t = `${emoji ? emoji + ' ' : ''}${title}`;
  const d = [whenText, location].filter(Boolean).join(' · ') || "You're invited! Tap to RSVP — no account needed.";
  const tags = [
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${escapeHtml(t)}">`,
    `<meta property="og:description" content="${escapeHtml(d)}">`,
    imageUrl ? `<meta property="og:image" content="${escapeHtml(imageUrl)}">` : '',
    pageUrl ? `<meta property="og:url" content="${escapeHtml(pageUrl)}">` : '',
    `<meta name="twitter:card" content="${imageUrl ? 'summary_large_image' : 'summary'}">`,
    `<meta name="twitter:title" content="${escapeHtml(t)}">`,
    `<meta name="twitter:description" content="${escapeHtml(d)}">`,
    imageUrl ? `<meta name="twitter:image" content="${escapeHtml(imageUrl)}">` : '',
  ];
  return tags.filter(Boolean).join('\n  ');
}

export function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

// --- IDs / tokens ---

function shortId(len = 10) {
  const a = 'abcdefghjkmnpqrstuvwxyz23456789';
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  let s = '';
  for (const b of buf) s += a[b % a.length];
  return s;
}

function hexToken(bytes = 10) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map(b => b.toString(16).padStart(2, '0')).join('');
}

// --- Schema (created on demand, same pattern as reminders/users dashboards) ---

let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  const db = env.DB;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS party_events (
      id TEXT PRIMARY KEY,
      host_clerk_id TEXT NOT NULL,
      host_email TEXT,
      host_name TEXT,
      title TEXT NOT NULL,
      emoji TEXT,
      description TEXT,
      location TEXT,
      starts_at TEXT,
      timezone TEXT,
      capacity INTEGER,
      share_token TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')))`),
    db.prepare(`CREATE TABLE IF NOT EXISTS party_guests (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      name TEXT,
      phone_e164 TEXT,
      email TEXT,
      token TEXT UNIQUE NOT NULL,
      rsvp TEXT NOT NULL DEFAULT 'pending',
      plus_ones INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      source TEXT NOT NULL DEFAULT 'host',
      invited_at TEXT,
      responded_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')))`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_party_guests_event ON party_guests (event_id)`),
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_party_guests_phone
      ON party_guests (event_id, phone_e164) WHERE phone_e164 IS NOT NULL`),
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_party_guests_email
      ON party_guests (event_id, email) WHERE email IS NOT NULL`),
    db.prepare(`CREATE TABLE IF NOT EXISTS party_sends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL,
      guest_id TEXT,
      channel TEXT NOT NULL,
      kind TEXT NOT NULL,
      ok INTEGER NOT NULL,
      sid TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')))`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_party_sends_event ON party_sends (event_id, created_at)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS party_comments (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      guest_id TEXT NOT NULL,
      name TEXT,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')))`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_party_comments_event ON party_comments (event_id, created_at)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS party_cohosts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL,
      email TEXT NOT NULL,
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (event_id, email))`),
    db.prepare(`CREATE TABLE IF NOT EXISTS party_date_options (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      starts_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')))`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_party_date_options_event ON party_date_options (event_id)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS party_date_votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      option_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      guest_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (option_id, guest_id))`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_party_date_votes_event ON party_date_votes (event_id)`),
  ]);
  // Additive columns (idempotent — ignore "duplicate column" on re-run).
  for (const stmt of [
    "ALTER TABLE party_events ADD COLUMN cover_theme TEXT DEFAULT 'confetti'",
    "ALTER TABLE party_events ADD COLUMN cover_image_url TEXT",
    "ALTER TABLE party_events ADD COLUMN show_guest_list INTEGER DEFAULT 1",
    "ALTER TABLE party_events ADD COLUMN allow_comments INTEGER DEFAULT 1",
    "ALTER TABLE party_events ADD COLUMN auto_reminder INTEGER DEFAULT 1",
    "ALTER TABLE party_guests ADD COLUMN reminded_at TEXT",
    "ALTER TABLE party_events ADD COLUMN host_nickname TEXT",
    "ALTER TABLE party_events ADD COLUMN cost_text TEXT",
    "ALTER TABLE party_events ADD COLUMN rsvp_deadline TEXT",
    "ALTER TABLE party_events ADD COLUMN link_url TEXT",
    "ALTER TABLE party_events ADD COLUMN playlist_url TEXT",
    "ALTER TABLE party_events ADD COLUMN registry_url TEXT",
    "ALTER TABLE party_events ADD COLUMN dress_code TEXT",
    "ALTER TABLE party_events ADD COLUMN is_public INTEGER DEFAULT 1",
    "ALTER TABLE party_events ADD COLUMN title_font TEXT DEFAULT 'classic'",
  ]) { try { await db.prepare(stmt).run(); } catch (e) { /* column exists */ } }
  schemaReady = true;
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

function baseUrl(env) {
  return env.PARTY_BASE_URL || env.PUBLIC_BASE_URL || 'https://christopherrathbun.com';
}

function rsvpLink(env, token) {
  return `${baseUrl(env)}/e/${token}`;
}

function emailFrom(env) {
  return env.PARTY_EMAIL_FROM || 'Party Plus One <reminders@mail.giftanagent.com>';
}

function ogImageUrl(env, ev) {
  // SVG covers render on the page but most unfurlers (iMessage, Twitter)
  // won't accept an SVG og:image — fall through to the screenshot service.
  if (ev.cover_image_url && !/\.svg(\?|#|$)/i.test(ev.cover_image_url)) return ev.cover_image_url;
  // Screenshot of the open-invite page (share token only — never a personal
  // token, which would leak a guest's private link to the screenshot service).
  return `https://image.thum.io/get/width/1200/crop/630/noanimate/${rsvpLink(env, ev.share_token)}`;
}

// --- Auth ---

async function requireHost(request, env) {
  const auth = request.headers.get('authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const payload = await verifyClerkJWT(auth.slice(7), env);
  if (!payload?.sub) return null;
  return { clerkId: payload.sub };
}

// An event is manageable by its creator or by any co-host (matched on the
// co-host's Clerk primary email). The email lookup is one Clerk API call and
// only happens when the cheap creator check misses.
async function loadHostEvent(env, eventId, host) {
  const own = await env.DB.prepare('SELECT * FROM party_events WHERE id = ? AND host_clerk_id = ?')
    .bind(eventId, host.clerkId).first();
  if (own) return own;
  const email = await getClerkUserEmail(host.clerkId, env);
  if (!email) return null;
  return env.DB.prepare(
    `SELECT e.* FROM party_events e JOIN party_cohosts c ON c.event_id = e.id
     WHERE e.id = ? AND c.email = ?`
  ).bind(eventId, email).first();
}

// Public projection of an event (never leaks host ids or contact info).
function publicEvent(ev) {
  return {
    title: ev.title,
    emoji: ev.emoji,
    description: ev.description,
    location: ev.location,
    starts_at: ev.starts_at,
    timezone: ev.timezone,
    when_text: formatEventWhen(ev.starts_at, ev.timezone),
    host_name: ev.host_name,
    status: ev.status,
    cover_theme: COVER_THEMES.includes(ev.cover_theme) ? ev.cover_theme : 'confetti',
    cover_image_url: ev.cover_image_url || null,
    show_guest_list: !!ev.show_guest_list,
    allow_comments: !!ev.allow_comments,
    host_nickname: ev.host_nickname || null,
    cost_text: ev.cost_text || null,
    dress_code: ev.dress_code || null,
    link_url: ev.link_url || null,
    playlist_url: ev.playlist_url || null,
    registry_url: ev.registry_url || null,
    rsvp_deadline: ev.rsvp_deadline || null,
    rsvp_closed: rsvpClosed(ev),
    is_public: ev.is_public === undefined || ev.is_public === null ? true : !!ev.is_public,
    title_font: TITLE_FONTS.includes(ev.title_font) ? ev.title_font : 'classic',
  };
}

// "Who's going" — first names only, never contact info.
async function goingList(env, eventId) {
  const rows = await env.DB.prepare(
    `SELECT name, plus_ones, rsvp FROM party_guests
     WHERE event_id = ? AND rsvp IN ('yes', 'maybe') ORDER BY responded_at LIMIT 120`
  ).bind(eventId).all();
  const going = [], maybe = [];
  for (const g of (rows.results || [])) {
    const entry = { name: firstName(g.name) || 'Guest', plus_ones: g.plus_ones || 0 };
    (g.rsvp === 'yes' ? going : maybe).push(entry);
  }
  return { going, maybe };
}

async function commentList(env, eventId) {
  const rows = await env.DB.prepare(
    `SELECT id, name, body, created_at FROM party_comments
     WHERE event_id = ? ORDER BY created_at DESC LIMIT 50`
  ).bind(eventId).all();
  return rows.results || [];
}

// Upload content types we accept for event covers, mapped to extensions.
export function imageExtFor(contentType) {
  const map = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
  return map[String(contentType || '').toLowerCase().split(';')[0].trim()] || null;
}
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

// A user-supplied URL is only stored if it's a plausible https URL.
export function httpsUrl(v) {
  const u = String(v || '').trim().slice(0, 500);
  return /^https:\/\/[^\s]+\.[^\s]+$/.test(u) ? u : null;
}

// True once the RSVP deadline (if any) has passed.
export function rsvpClosed(ev, now = new Date()) {
  if (!ev || !ev.rsvp_deadline) return false;
  const d = new Date(ev.rsvp_deadline);
  return !isNaN(d.getTime()) && now.getTime() > d.getTime();
}

// --- Event field sanitizing (shared by create + update) ---

function sanitizeEventFields(body, { partial }) {
  const fields = {};
  const has = k => body[k] !== undefined;

  if (!partial || has('title')) {
    const t = String(body.title || '').trim().slice(0, 120);
    if (!t) return { error: 'title required' };
    fields.title = t;
  }
  if (!partial || has('emoji')) fields.emoji = String(body.emoji || '🎉').trim().slice(0, 8);
  if (has('description') || !partial) fields.description = String(body.description || '').trim().slice(0, 2000) || null;
  if (has('location') || !partial) fields.location = String(body.location || '').trim().slice(0, 300) || null;
  if (has('timezone') || !partial) fields.timezone = String(body.timezone || 'America/New_York').trim().slice(0, 60);
  if (has('starts_at') || !partial) {
    if (!body.starts_at) fields.starts_at = null;
    else {
      const d = new Date(body.starts_at);
      if (isNaN(d.getTime())) return { error: 'invalid starts_at' };
      fields.starts_at = d.toISOString();
    }
  }
  if (has('capacity') || !partial) {
    fields.capacity = Number.isInteger(body.capacity) && body.capacity > 0 ? Math.min(body.capacity, 1000) : null;
  }
  if (has('host_nickname') || !partial) fields.host_nickname = String(body.host_nickname || '').trim().slice(0, 80) || null;
  if (has('cost_text') || !partial) fields.cost_text = String(body.cost_text || '').trim().slice(0, 120) || null;
  if (has('dress_code') || !partial) fields.dress_code = String(body.dress_code || '').trim().slice(0, 120) || null;
  for (const k of ['link_url', 'playlist_url', 'registry_url']) {
    if (has(k) || !partial) fields[k] = httpsUrl(body[k]);
  }
  if (has('rsvp_deadline') || !partial) {
    if (!body.rsvp_deadline) fields.rsvp_deadline = null;
    else {
      const d = new Date(body.rsvp_deadline);
      if (isNaN(d.getTime())) return { error: 'invalid rsvp_deadline' };
      fields.rsvp_deadline = d.toISOString();
    }
  }
  if (has('is_public') || !partial) fields.is_public = (body.is_public === undefined || body.is_public) ? 1 : 0;
  if (has('title_font') || !partial) fields.title_font = TITLE_FONTS.includes(body.title_font) ? body.title_font : 'classic';
  if (has('cover_theme')) {
    fields.cover_theme = COVER_THEMES.includes(body.cover_theme) ? body.cover_theme : 'confetti';
  }
  if (has('cover_image_url')) {
    const u = String(body.cover_image_url || '').trim().slice(0, 500);
    fields.cover_image_url = /^https:\/\/.+/.test(u) ? u : null;
  }
  for (const flag of ['show_guest_list', 'allow_comments', 'auto_reminder']) {
    if (has(flag)) fields[flag] = body[flag] ? 1 : 0;
  }
  if (partial && has('status') && ['active', 'cancelled'].includes(body.status)) fields.status = body.status;
  return { fields };
}

// --- Handlers: host API ---

async function handleCreateEvent(request, env) {
  const host = await requireHost(request, env);
  if (!host) return json({ ok: false, error: 'unauthorized' }, 401);
  let body; try { body = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }

  const { fields, error } = sanitizeEventFields(body, { partial: false });
  if (error) return json({ ok: false, error }, 400);
  const hostName = String(body.host_name || '').trim().slice(0, 80) || 'Your friend';

  const hostEmail = await getClerkUserEmail(host.clerkId, env);
  const id = shortId(10);
  const shareToken = 's' + hexToken(8);
  await env.DB.prepare(
    `INSERT INTO party_events (id, host_clerk_id, host_email, host_name, title, emoji, description, location,
       starts_at, timezone, capacity, share_token, cover_theme, cover_image_url, show_guest_list, allow_comments, auto_reminder,
       host_nickname, cost_text, dress_code, link_url, playlist_url, registry_url, rsvp_deadline, is_public, title_font)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, host.clerkId, hostEmail, hostName, fields.title, fields.emoji, fields.description, fields.location,
    fields.starts_at, fields.timezone, fields.capacity, shareToken,
    fields.cover_theme || 'confetti', fields.cover_image_url || null,
    fields.show_guest_list !== undefined ? fields.show_guest_list : 1,
    fields.allow_comments !== undefined ? fields.allow_comments : 1,
    fields.auto_reminder !== undefined ? fields.auto_reminder : 1,
    fields.host_nickname, fields.cost_text, fields.dress_code,
    fields.link_url, fields.playlist_url, fields.registry_url,
    fields.rsvp_deadline, fields.is_public, fields.title_font,
  ).run();

  // "Can't decide when? Poll your guests" — optional list of candidate dates.
  if (Array.isArray(body.date_options) && body.date_options.length) {
    await replaceDateOptions(env, id, body.date_options);
  }

  return json({ ok: true, event: { id, share_token: shareToken } });
}

async function handleListEvents(request, env) {
  const host = await requireHost(request, env);
  if (!host) return json({ ok: false, error: 'unauthorized' }, 401);
  const email = await getClerkUserEmail(host.clerkId, env);
  const rows = await env.DB.prepare(
    `SELECT e.*,
       (SELECT COUNT(*) FROM party_guests g WHERE g.event_id = e.id) AS guest_count,
       (SELECT COUNT(*) FROM party_guests g WHERE g.event_id = e.id AND g.rsvp = 'yes') AS yes_count,
       (SELECT COALESCE(SUM(g.plus_ones), 0) FROM party_guests g WHERE g.event_id = e.id AND g.rsvp = 'yes') AS plus_ones
     FROM party_events e
     WHERE e.host_clerk_id = ?
        OR (? IS NOT NULL AND e.id IN (SELECT event_id FROM party_cohosts WHERE email = ?))
     ORDER BY e.created_at DESC`
  ).bind(host.clerkId, email, email).all();
  const events = (rows.results || []).map(ev => ({
    id: ev.id, title: ev.title, emoji: ev.emoji, starts_at: ev.starts_at, timezone: ev.timezone,
    when_text: formatEventWhen(ev.starts_at, ev.timezone), location: ev.location, status: ev.status,
    guest_count: ev.guest_count, yes_count: ev.yes_count, plus_ones: ev.plus_ones,
    share_token: ev.share_token, cover_theme: ev.cover_theme,
    cohosted: ev.host_clerk_id !== host.clerkId,
  }));
  return json({ ok: true, events });
}

async function handleEventDetail(request, env, eventId) {
  const host = await requireHost(request, env);
  if (!host) return json({ ok: false, error: 'unauthorized' }, 401);
  const ev = await loadHostEvent(env, eventId, host);
  if (!ev) return json({ ok: false, error: 'not found' }, 404);
  const guests = await env.DB.prepare(
    `SELECT id, name, phone_e164, email, token, rsvp, plus_ones, note, source, invited_at, reminded_at, responded_at
     FROM party_guests WHERE event_id = ? ORDER BY created_at`
  ).bind(eventId).all();
  const cohosts = await env.DB.prepare('SELECT email FROM party_cohosts WHERE event_id = ? ORDER BY added_at').bind(eventId).all();
  return json({
    ok: true,
    event: {
      ...publicEvent(ev), id: ev.id, capacity: ev.capacity, auto_reminder: !!ev.auto_reminder,
      share_token: ev.share_token, share_link: rsvpLink(env, ev.share_token),
      og_image: ogImageUrl(env, ev),
    },
    guests: (guests.results || []).map(g => ({ ...g, link: rsvpLink(env, g.token) })),
    comments: await commentList(env, eventId),
    cohosts: (cohosts.results || []).map(c => c.email),
    date_poll: await datePoll(env, ev, null),
  });
}

async function handleUpdateEvent(request, env, eventId) {
  const host = await requireHost(request, env);
  if (!host) return json({ ok: false, error: 'unauthorized' }, 401);
  const ev = await loadHostEvent(env, eventId, host);
  if (!ev) return json({ ok: false, error: 'not found' }, 404);
  let body; try { body = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }

  const { fields, error } = sanitizeEventFields(body, { partial: true });
  if (error) return json({ ok: false, error }, 400);
  const keys = Object.keys(fields);
  if (!keys.length) return json({ ok: true });
  const sets = keys.map(k => `${k} = ?`).join(', ');
  await env.DB.prepare(`UPDATE party_events SET ${sets}, updated_at = datetime('now') WHERE id = ?`)
    .bind(...keys.map(k => fields[k]), eventId).run();
  return json({ ok: true });
}

async function handleAddGuests(request, env, eventId) {
  const host = await requireHost(request, env);
  if (!host) return json({ ok: false, error: 'unauthorized' }, 401);
  const ev = await loadHostEvent(env, eventId, host);
  if (!ev) return json({ ok: false, error: 'not found' }, 404);
  let body; try { body = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }

  const incoming = Array.isArray(body.guests) ? body.guests.slice(0, MAX_GUESTS_PER_EVENT) : [];
  const existing = await env.DB.prepare('SELECT COUNT(*) AS n FROM party_guests WHERE event_id = ?').bind(eventId).first();
  const room = MAX_GUESTS_PER_EVENT - (existing?.n || 0);
  if (room <= 0) return json({ ok: false, error: `event is at the ${MAX_GUESTS_PER_EVENT}-guest limit` }, 400);

  const added = [], skipped = [];
  for (const g of incoming.slice(0, room)) {
    const name = String(g?.name || '').trim().slice(0, 80) || null;
    const phone = g?.phone ? normalizePhone(String(g.phone)) : null;
    const email = isEmail(g?.email) ? String(g.email).trim().toLowerCase() : null;
    if (!phone && !email) { skipped.push({ name, reason: 'no valid phone or email' }); continue; }
    const id = shortId(12);
    const token = hexToken(10);
    try {
      await env.DB.prepare(
        `INSERT INTO party_guests (id, event_id, name, phone_e164, email, token) VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(id, eventId, name, phone, email, token).run();
      added.push({ id, name, phone, email });
    } catch (e) {
      // Unique index hit — this phone/email is already on the list.
      skipped.push({ name, phone, email, reason: 'already on the guest list' });
    }
  }
  return json({ ok: true, added, skipped });
}

async function handleDeleteGuest(request, env, eventId, guestId) {
  const host = await requireHost(request, env);
  if (!host) return json({ ok: false, error: 'unauthorized' }, 401);
  const ev = await loadHostEvent(env, eventId, host);
  if (!ev) return json({ ok: false, error: 'not found' }, 404);
  await env.DB.prepare('DELETE FROM party_guests WHERE id = ? AND event_id = ?').bind(guestId, eventId).run();
  return json({ ok: true });
}

async function hostDailySends(env, clerkId) {
  const used = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM party_sends s JOIN party_events e ON e.id = s.event_id
     WHERE e.host_clerk_id = ? AND s.created_at > datetime('now', '-1 day')`
  ).bind(clerkId).first();
  return used?.n || 0;
}

async function deliverToGuest(env, ev, g, { kind, smsBody, email }) {
  let channel, res;
  if (g.phone_e164) {
    channel = 'sms';
    res = await sendTwilioSms({ to: g.phone_e164, body: smsBody }, env);
  } else if (g.email) {
    channel = 'email';
    res = await sendResendEmail({ to: g.email, subject: email.subject, html: email.html, text: email.text, from: emailFrom(env) }, env);
  } else {
    return { ok: false, channel: 'none' };
  }
  await env.DB.prepare(
    `INSERT INTO party_sends (event_id, guest_id, channel, kind, ok, sid, error) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(ev.id, g.id, channel, kind, res.ok ? 1 : 0, res.sid || null, res.ok ? null : String(res.error || res.status || 'send failed')).run();
  return { ok: !!res.ok, channel };
}

export function buildInviteEmail({ hostName, title, emoji, whenText, location, description, link }) {
  const subject = `${emoji ? emoji + ' ' : ''}You're invited: ${title}`;
  const text = [
    `${hostName} invited you to ${title}!`,
    whenText ? `When: ${whenText}` : '',
    location ? `Where: ${location}` : '',
    description ? `\n${description}` : '',
    `\nRSVP here (no account needed): ${link}`,
  ].filter(Boolean).join('\n');
  const html =
    `<div style="font-family:system-ui,sans-serif;line-height:1.55;max-width:560px;margin:0 auto">` +
    `<div style="font-size:52px;text-align:center;margin:18px 0 6px">${escapeHtml(emoji || '🎉')}</div>` +
    `<h1 style="text-align:center;margin:0 0 6px;font-size:26px">${escapeHtml(title)}</h1>` +
    `<p style="text-align:center;color:#666;margin:0 0 20px">${escapeHtml(hostName)} invited you</p>` +
    (whenText ? `<p style="margin:4px 0"><strong>When:</strong> ${escapeHtml(whenText)}</p>` : '') +
    (location ? `<p style="margin:4px 0"><strong>Where:</strong> <a href="https://maps.google.com/?q=${encodeURIComponent(location)}" style="color:#7c5cff">${escapeHtml(location)}</a></p>` : '') +
    (description ? `<p style="white-space:pre-wrap;margin:14px 0">${escapeHtml(description)}</p>` : '') +
    `<p style="text-align:center;margin:26px 0"><a href="${escapeHtml(link)}" ` +
    `style="background:#7c5cff;color:#fff;text-decoration:none;padding:14px 34px;border-radius:999px;font-weight:600;display:inline-block">RSVP</a></p>` +
    `<p style="color:#999;font-size:13px;text-align:center">No account needed — one tap and you're done.</p>` +
    `</div>`;
  return { subject, text, html };
}

function plainEmail(subject, message, link, linkLabel) {
  return {
    subject,
    text: `${message}\n\n${linkLabel}: ${link}`,
    html: `<div style="font-family:system-ui,sans-serif;line-height:1.55"><p>${escapeHtml(message)}</p>` +
      `<p><a href="${escapeHtml(link)}">${escapeHtml(linkLabel)}</a></p></div>`,
  };
}

// Send invites / reminders / a custom update. The client batches guestIds
// (<= MAX_SENDS_PER_REQUEST per call) and shows progress between calls.
async function handleSend(request, env, eventId) {
  const host = await requireHost(request, env);
  if (!host) return json({ ok: false, error: 'unauthorized' }, 401);
  const ev = await loadHostEvent(env, eventId, host);
  if (!ev) return json({ ok: false, error: 'not found' }, 404);
  if (ev.status !== 'active') return json({ ok: false, error: 'event is cancelled' }, 400);
  let body; try { body = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }

  const kind = ['invite', 'reminder', 'update'].includes(body.kind) ? body.kind : 'invite';
  const message = String(body.message || '').trim().slice(0, 320);
  if (kind === 'update' && !message) return json({ ok: false, error: 'message required for an update' }, 400);
  const dryRun = !!body.dryRun;

  // Resolve targets: explicit guestIds, else a sensible default per kind
  // (waitlisted guests are never messaged here — the admit flow covers them).
  let guests;
  if (Array.isArray(body.guestIds) && body.guestIds.length) {
    const ids = body.guestIds.slice(0, MAX_SENDS_PER_REQUEST).map(String);
    const placeholders = ids.map(() => '?').join(',');
    const rows = await env.DB.prepare(
      `SELECT * FROM party_guests WHERE event_id = ? AND id IN (${placeholders})`
    ).bind(eventId, ...ids).all();
    guests = rows.results || [];
  } else {
    const where = kind === 'invite' ? `invited_at IS NULL AND rsvp != 'waitlist'` : `rsvp IN ('pending', 'yes', 'maybe')`;
    const rows = await env.DB.prepare(
      `SELECT * FROM party_guests WHERE event_id = ? AND ${where} ORDER BY created_at LIMIT ?`
    ).bind(eventId, MAX_SENDS_PER_REQUEST).all();
    guests = rows.results || [];
  }
  if (!guests.length) return json({ ok: true, sent: [], remaining: 0, dryRun });

  // Rolling-day cap across all of this event owner's events.
  const used = await hostDailySends(env, ev.host_clerk_id);
  if (used + guests.length > MAX_SENDS_PER_HOST_PER_DAY) {
    return json({ ok: false, error: 'daily send limit reached — try again tomorrow' }, 429);
  }

  const whenText = formatEventWhen(ev.starts_at, ev.timezone);
  const results = [];
  for (const g of guests) {
    const link = rsvpLink(env, g.token);
    const smsBody = kind === 'invite'
      ? buildInviteSms({ hostName: ev.host_name, title: ev.title, emoji: ev.emoji, whenText, link })
      : kind === 'reminder'
        ? buildReminderSms({ title: ev.title, emoji: ev.emoji, whenText, link })
        : buildUpdateSms({ title: ev.title, message, link });

    if (dryRun) {
      results.push({ guestId: g.id, channel: g.phone_e164 ? 'sms' : 'email', preview: smsBody, dryRun: true });
      continue;
    }

    const email = kind === 'update'
      ? plainEmail(`${ev.emoji ? ev.emoji + ' ' : ''}Update: ${ev.title}`, message, link, 'Details + RSVP')
      : kind === 'reminder'
        ? plainEmail(`${ev.emoji ? ev.emoji + ' ' : ''}Reminder: ${ev.title}`, `Reminder: ${ev.title} is ${whenText || 'coming up soon'}.`, link, 'Details + RSVP')
        : buildInviteEmail({ hostName: ev.host_name, title: ev.title, emoji: ev.emoji, whenText, location: ev.location, description: ev.description, link });

    const out = await deliverToGuest(env, ev, g, { kind, smsBody, email });
    if (out.ok && kind === 'invite' && !g.invited_at) {
      await env.DB.prepare(`UPDATE party_guests SET invited_at = datetime('now') WHERE id = ?`).bind(g.id).run();
    }
    results.push({ guestId: g.id, channel: out.channel, ok: out.ok });
  }

  // How many un-invited guests remain (so the client can keep batching).
  let remaining = 0;
  if (kind === 'invite' && !(Array.isArray(body.guestIds) && body.guestIds.length)) {
    const r = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM party_guests WHERE event_id = ? AND invited_at IS NULL AND rsvp != 'waitlist'`
    ).bind(eventId).first();
    remaining = r?.n || 0;
  }
  return json({ ok: true, sent: results, remaining, dryRun });
}

// Admit a waitlisted guest: flips them to "yes" and tells them the good news.
async function handleAdmitGuest(request, env, eventId, guestId) {
  const host = await requireHost(request, env);
  if (!host) return json({ ok: false, error: 'unauthorized' }, 401);
  const ev = await loadHostEvent(env, eventId, host);
  if (!ev) return json({ ok: false, error: 'not found' }, 404);
  const g = await env.DB.prepare('SELECT * FROM party_guests WHERE id = ? AND event_id = ?').bind(guestId, eventId).first();
  if (!g) return json({ ok: false, error: 'not found' }, 404);
  if (g.rsvp !== 'waitlist') return json({ ok: false, error: 'guest is not on the waitlist' }, 400);

  await env.DB.prepare(`UPDATE party_guests SET rsvp = 'yes', responded_at = datetime('now') WHERE id = ?`).bind(guestId).run();

  const whenText = formatEventWhen(ev.starts_at, ev.timezone);
  const link = rsvpLink(env, g.token);
  const smsBody = buildAdmitSms({ title: ev.title, emoji: ev.emoji, whenText, link });
  const email = plainEmail(`${ev.emoji ? ev.emoji + ' ' : ''}You're in: ${ev.title}`,
    `A spot opened up — you're in for ${ev.title}!${whenText ? ` ${whenText}.` : ''}`, link, 'Event details');
  const out = await deliverToGuest(env, ev, g, { kind: 'admit', smsBody, email });
  return json({ ok: true, notified: out.ok });
}

// --- Co-hosts ---

async function handleAddCohost(request, env, eventId) {
  const host = await requireHost(request, env);
  if (!host) return json({ ok: false, error: 'unauthorized' }, 401);
  const ev = await loadHostEvent(env, eventId, host);
  if (!ev) return json({ ok: false, error: 'not found' }, 404);
  let body; try { body = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  if (!isEmail(body.email)) return json({ ok: false, error: 'valid email required' }, 400);
  const email = String(body.email).trim().toLowerCase();
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM party_cohosts WHERE event_id = ?').bind(eventId).first();
  if ((count?.n || 0) >= 10) return json({ ok: false, error: 'co-host limit reached' }, 400);
  try {
    await env.DB.prepare('INSERT INTO party_cohosts (event_id, email) VALUES (?, ?)').bind(eventId, email).run();
  } catch (e) { /* duplicate — already a co-host */ }
  return json({ ok: true });
}

async function handleRemoveCohost(request, env, eventId) {
  const host = await requireHost(request, env);
  if (!host) return json({ ok: false, error: 'unauthorized' }, 401);
  const ev = await loadHostEvent(env, eventId, host);
  if (!ev) return json({ ok: false, error: 'not found' }, 404);
  let body; try { body = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const email = String(body.email || '').trim().toLowerCase();
  await env.DB.prepare('DELETE FROM party_cohosts WHERE event_id = ? AND email = ?').bind(eventId, email).run();
  return json({ ok: true });
}

// --- Comments ---

// Posting requires a personal guest token (open-link guests get one back
// after they RSVP), which keeps the wall spam-free without any login.
async function handlePostComment(request, env, token) {
  await ensureSchema(env);
  let body; try { body = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const text = String(body.body || '').trim().slice(0, 500);
  if (!text) return json({ ok: false, error: 'comment is empty' }, 400);

  const g = await env.DB.prepare('SELECT * FROM party_guests WHERE token = ?').bind(token).first();
  if (!g) return json({ ok: false, error: 'not found' }, 404);
  const ev = await env.DB.prepare('SELECT * FROM party_events WHERE id = ?').bind(g.event_id).first();
  if (!ev || ev.status !== 'active') return json({ ok: false, error: 'event is not active' }, 400);
  if (!ev.allow_comments) return json({ ok: false, error: 'comments are off for this event' }, 400);

  const mine = await env.DB.prepare('SELECT COUNT(*) AS n FROM party_comments WHERE guest_id = ?').bind(g.id).first();
  if ((mine?.n || 0) >= MAX_COMMENTS_PER_GUEST) return json({ ok: false, error: 'comment limit reached' }, 429);

  const name = firstName(g.name) || 'Guest';
  await env.DB.prepare('INSERT INTO party_comments (id, event_id, guest_id, name, body) VALUES (?, ?, ?, ?, ?)')
    .bind(shortId(12), ev.id, g.id, name, text).run();
  return json({ ok: true, comments: await commentList(env, ev.id) });
}

async function handleDeleteComment(request, env, eventId, commentId) {
  const host = await requireHost(request, env);
  if (!host) return json({ ok: false, error: 'unauthorized' }, 401);
  const ev = await loadHostEvent(env, eventId, host);
  if (!ev) return json({ ok: false, error: 'not found' }, 404);
  await env.DB.prepare('DELETE FROM party_comments WHERE id = ? AND event_id = ?').bind(commentId, eventId).run();
  return json({ ok: true });
}

// --- Cover uploads (R2) ---

// Host uploads a cover photo: raw image body, stored in R2, served back via
// /parties/img/<key>. The event's cover_image_url is set to the new URL.
async function handleUploadCover(request, env, eventId) {
  const host = await requireHost(request, env);
  if (!host) return json({ ok: false, error: 'unauthorized' }, 401);
  const ev = await loadHostEvent(env, eventId, host);
  if (!ev) return json({ ok: false, error: 'not found' }, 404);
  if (!env.PARTY_UPLOADS) return json({ ok: false, error: 'uploads are not configured' }, 500);

  const ext = imageExtFor(request.headers.get('content-type'));
  if (!ext) return json({ ok: false, error: 'upload a JPEG, PNG, WebP, or GIF' }, 400);
  const len = parseInt(request.headers.get('content-length') || '0', 10);
  if (len > MAX_UPLOAD_BYTES) return json({ ok: false, error: 'image too large — keep it under 4 MB' }, 413);
  const buf = await request.arrayBuffer();
  if (!buf.byteLength) return json({ ok: false, error: 'empty upload' }, 400);
  if (buf.byteLength > MAX_UPLOAD_BYTES) return json({ ok: false, error: 'image too large — keep it under 4 MB' }, 413);

  const key = `covers/${eventId}/${hexToken(8)}.${ext}`;
  await env.PARTY_UPLOADS.put(key, buf, {
    httpMetadata: { contentType: request.headers.get('content-type').split(';')[0].trim(), cacheControl: 'public, max-age=31536000, immutable' },
  });
  const url = `${baseUrl(env)}/parties/img/${key}`;
  await env.DB.prepare(`UPDATE party_events SET cover_image_url = ?, updated_at = datetime('now') WHERE id = ?`)
    .bind(url, eventId).run();
  return json({ ok: true, cover_image_url: url });
}

async function serveUploadedImage(env, key) {
  if (!env.PARTY_UPLOADS) return new Response('not found', { status: 404 });
  const obj = await env.PARTY_UPLOADS.get(key);
  if (!obj) return new Response('not found', { status: 404 });
  return new Response(obj.body, {
    headers: {
      'content-type': obj.httpMetadata?.contentType || 'application/octet-stream',
      'cache-control': obj.httpMetadata?.cacheControl || 'public, max-age=31536000, immutable',
      etag: obj.httpEtag,
    },
  });
}

// --- Date poll ("Can't decide when? Poll your guests") ---

// Replace an event's candidate dates wholesale. Votes for options that
// survive (same starts_at) are preserved by keeping their ids.
async function replaceDateOptions(env, eventId, isoList) {
  const dates = [];
  for (const v of isoList.slice(0, MAX_DATE_OPTIONS)) {
    const d = new Date(v);
    if (!isNaN(d.getTime())) dates.push(d.toISOString());
  }
  const existing = await env.DB.prepare('SELECT id, starts_at FROM party_date_options WHERE event_id = ?').bind(eventId).all();
  const keep = new Map();
  for (const row of (existing.results || [])) if (dates.includes(row.starts_at)) keep.set(row.starts_at, row.id);
  await env.DB.prepare('DELETE FROM party_date_options WHERE event_id = ?').bind(eventId).run();
  await env.DB.prepare('DELETE FROM party_date_votes WHERE event_id = ? AND option_id NOT IN (SELECT id FROM party_date_options)').bind(eventId).run();
  for (const iso of dates) {
    const oid = keep.get(iso) || shortId(12);
    await env.DB.prepare('INSERT INTO party_date_options (id, event_id, starts_at) VALUES (?, ?, ?)').bind(oid, eventId, iso).run();
  }
  // Drop votes that pointed at deleted options.
  await env.DB.prepare('DELETE FROM party_date_votes WHERE event_id = ? AND option_id NOT IN (SELECT id FROM party_date_options WHERE event_id = ?)').bind(eventId, eventId).run();
}

async function datePoll(env, ev, guestId) {
  const rows = await env.DB.prepare(
    `SELECT o.id, o.starts_at,
       (SELECT COUNT(*) FROM party_date_votes v WHERE v.option_id = o.id) AS votes
     FROM party_date_options o WHERE o.event_id = ? ORDER BY o.starts_at`
  ).bind(ev.id).all();
  const options = rows.results || [];
  if (!options.length) return null;
  let mine = new Set();
  if (guestId) {
    const my = await env.DB.prepare('SELECT option_id FROM party_date_votes WHERE event_id = ? AND guest_id = ?').bind(ev.id, guestId).all();
    mine = new Set((my.results || []).map(r => r.option_id));
  }
  return options.map(o => ({
    id: o.id, starts_at: o.starts_at,
    when_text: formatEventWhen(o.starts_at, ev.timezone),
    votes: o.votes, mine: mine.has(o.id),
  }));
}

async function handleSetDateOptions(request, env, eventId) {
  const host = await requireHost(request, env);
  if (!host) return json({ ok: false, error: 'unauthorized' }, 401);
  const ev = await loadHostEvent(env, eventId, host);
  if (!ev) return json({ ok: false, error: 'not found' }, 404);
  let body; try { body = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  if (!Array.isArray(body.options)) return json({ ok: false, error: 'options must be an array of dates' }, 400);
  await replaceDateOptions(env, eventId, body.options);
  return json({ ok: true, date_poll: await datePoll(env, ev, null) });
}

// Host picks the winning date: it becomes starts_at and the poll closes.
async function handlePickDate(request, env, eventId, optionId) {
  const host = await requireHost(request, env);
  if (!host) return json({ ok: false, error: 'unauthorized' }, 401);
  const ev = await loadHostEvent(env, eventId, host);
  if (!ev) return json({ ok: false, error: 'not found' }, 404);
  const opt = await env.DB.prepare('SELECT * FROM party_date_options WHERE id = ? AND event_id = ?').bind(optionId, eventId).first();
  if (!opt) return json({ ok: false, error: 'not found' }, 404);
  await env.DB.prepare(`UPDATE party_events SET starts_at = ?, updated_at = datetime('now') WHERE id = ?`).bind(opt.starts_at, eventId).run();
  await env.DB.prepare('DELETE FROM party_date_options WHERE event_id = ?').bind(eventId).run();
  await env.DB.prepare('DELETE FROM party_date_votes WHERE event_id = ?').bind(eventId).run();
  return json({ ok: true, starts_at: opt.starts_at });
}

// Guest votes with their personal token: the submitted set replaces their
// previous votes (checkbox semantics — multiple dates OK).
async function handleDateVote(request, env, token) {
  await ensureSchema(env);
  let body; try { body = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const ids = Array.isArray(body.option_ids) ? body.option_ids.slice(0, MAX_DATE_OPTIONS) : [];

  const g = await env.DB.prepare('SELECT * FROM party_guests WHERE token = ?').bind(token).first();
  if (!g) return json({ ok: false, error: 'not found' }, 404);
  const ev = await env.DB.prepare('SELECT * FROM party_events WHERE id = ?').bind(g.event_id).first();
  if (!ev || ev.status !== 'active') return json({ ok: false, error: 'event is not active' }, 400);

  await env.DB.prepare('DELETE FROM party_date_votes WHERE event_id = ? AND guest_id = ?').bind(ev.id, g.id).run();
  for (const oid of ids) {
    const opt = await env.DB.prepare('SELECT id FROM party_date_options WHERE id = ? AND event_id = ?').bind(String(oid), ev.id).first();
    if (opt) {
      await env.DB.prepare('INSERT OR IGNORE INTO party_date_votes (option_id, event_id, guest_id) VALUES (?, ?, ?)').bind(opt.id, ev.id, g.id).run();
    }
  }
  return json({ ok: true, date_poll: await datePoll(env, ev, g.id) });
}

// --- Handlers: public guest API ---

// One endpoint resolves both link types: a personal guest token or the
// event's open share token (prefixed 's').
async function handleLinkLookup(env, token) {
  await ensureSchema(env);
  if (!token || token.length < 8 || token.length > 64) return json({ ok: false, error: 'not found' }, 404);

  const shared = await env.DB.prepare('SELECT * FROM party_events WHERE share_token = ?').bind(token).first();
  if (shared) {
    const yes = await env.DB.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(plus_ones), 0) AS p FROM party_guests WHERE event_id = ? AND rsvp = 'yes'`
    ).bind(shared.id).first();
    const atCapacity = shared.capacity ? ((yes?.n || 0) + (yes?.p || 0)) >= shared.capacity : false;
    return json({
      ok: true, type: 'open', event: publicEvent(shared), at_capacity: atCapacity,
      date_poll: await datePoll(env, shared, null),
      ...(shared.show_guest_list ? await goingList(env, shared.id) : {}),
      comments: shared.allow_comments ? await commentList(env, shared.id) : [],
    });
  }

  const guest = await env.DB.prepare('SELECT * FROM party_guests WHERE token = ?').bind(token).first();
  if (!guest) return json({ ok: false, error: 'not found' }, 404);
  const ev = await env.DB.prepare('SELECT * FROM party_events WHERE id = ?').bind(guest.event_id).first();
  if (!ev) return json({ ok: false, error: 'not found' }, 404);
  return json({
    ok: true, type: 'guest', event: publicEvent(ev),
    guest: { name: guest.name, rsvp: guest.rsvp, plus_ones: guest.plus_ones, note: guest.note },
    date_poll: await datePoll(env, ev, guest.id),
    ...(ev.show_guest_list ? await goingList(env, ev.id) : {}),
    comments: ev.allow_comments ? await commentList(env, ev.id) : [],
  });
}

async function handleRsvp(request, env, token) {
  await ensureSchema(env);
  let body; try { body = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const rsvp = RSVP_CHOICES.includes(body.rsvp) ? body.rsvp : null;
  if (!rsvp) return json({ ok: false, error: 'rsvp must be yes, maybe, or no' }, 400);
  const plusOnes = Number.isInteger(body.plus_ones) ? Math.max(0, Math.min(body.plus_ones, 10)) : 0;
  const note = String(body.note || '').trim().slice(0, 500) || null;
  const name = String(body.name || '').trim().slice(0, 80) || null;

  const guest = await env.DB.prepare('SELECT * FROM party_guests WHERE token = ?').bind(token).first();
  if (!guest) return json({ ok: false, error: 'not found' }, 404);
  const ev = await env.DB.prepare('SELECT * FROM party_events WHERE id = ?').bind(guest.event_id).first();
  if (!ev || ev.status !== 'active') return json({ ok: false, error: 'this event is no longer active' }, 400);
  if (rsvpClosed(ev)) return json({ ok: false, error: 'RSVPs are closed for this event' }, 400);

  await env.DB.prepare(
    `UPDATE party_guests SET rsvp = ?, plus_ones = ?, note = ?, name = COALESCE(?, name), responded_at = datetime('now') WHERE id = ?`
  ).bind(rsvp, plusOnes, note, name, guest.id).run();
  return json({ ok: true, rsvp });
}

// Open share link: anyone with the link RSVPs by leaving a name and
// (optionally) a phone or email so they can get updates. When the event is
// at capacity a "yes" lands on the waitlist instead of bouncing.
async function handleOpenRsvp(request, env, shareToken) {
  await ensureSchema(env);
  let body; try { body = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const ev = await env.DB.prepare('SELECT * FROM party_events WHERE share_token = ?').bind(shareToken).first();
  if (!ev) return json({ ok: false, error: 'not found' }, 404);
  if (ev.status !== 'active') return json({ ok: false, error: 'this event is no longer active' }, 400);
  if (ev.is_public !== undefined && ev.is_public !== null && !ev.is_public) {
    return json({ ok: false, error: 'this event is invite-only — ask the host for a personal invite' }, 403);
  }
  if (rsvpClosed(ev)) return json({ ok: false, error: 'RSVPs are closed for this event' }, 400);

  let rsvp = RSVP_CHOICES.includes(body.rsvp) ? body.rsvp : null;
  if (!rsvp) return json({ ok: false, error: 'rsvp must be yes, maybe, or no' }, 400);
  const name = String(body.name || '').trim().slice(0, 80);
  if (!name) return json({ ok: false, error: 'name required' }, 400);
  const phone = body.phone ? normalizePhone(String(body.phone)) : null;
  if (body.phone && !phone) return json({ ok: false, error: 'that phone number doesn\'t look right' }, 400);
  const email = isEmail(body.email) ? String(body.email).trim().toLowerCase() : null;
  const plusOnes = Number.isInteger(body.plus_ones) ? Math.max(0, Math.min(body.plus_ones, 10)) : 0;
  const note = String(body.note || '').trim().slice(0, 500) || null;

  if (rsvp === 'yes' && ev.capacity) {
    const yes = await env.DB.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(plus_ones), 0) AS p FROM party_guests WHERE event_id = ? AND rsvp = 'yes'`
    ).bind(ev.id).first();
    if ((yes?.n || 0) + (yes?.p || 0) + 1 + plusOnes > ev.capacity) rsvp = 'waitlist';
  }

  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM party_guests WHERE event_id = ?').bind(ev.id).first();
  if ((count?.n || 0) >= MAX_GUESTS_PER_EVENT) return json({ ok: false, error: 'guest list is full' }, 400);

  // If this phone/email already RSVP'd via the share link, update in place.
  let existing = null;
  if (phone) existing = await env.DB.prepare('SELECT * FROM party_guests WHERE event_id = ? AND phone_e164 = ?').bind(ev.id, phone).first();
  if (!existing && email) existing = await env.DB.prepare('SELECT * FROM party_guests WHERE event_id = ? AND email = ?').bind(ev.id, email).first();

  let token;
  if (existing) {
    token = existing.token;
    await env.DB.prepare(
      `UPDATE party_guests SET rsvp = ?, plus_ones = ?, note = ?, name = ?, responded_at = datetime('now') WHERE id = ?`
    ).bind(rsvp, plusOnes, note, name, existing.id).run();
  } else {
    token = hexToken(10);
    await env.DB.prepare(
      `INSERT INTO party_guests (id, event_id, name, phone_e164, email, token, rsvp, plus_ones, note, source, responded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'share_link', datetime('now'))`
    ).bind(shortId(12), ev.id, name, phone, email, token, rsvp, plusOnes, note).run();
  }
  return json({ ok: true, rsvp, token });
}

// --- Guest page with server-injected OG tags (rich link previews) ---

async function serveRsvpPage(env, origin, token) {
  await ensureSchema(env);
  let ev = await env.DB.prepare('SELECT * FROM party_events WHERE share_token = ?').bind(token).first();
  if (!ev) {
    const g = await env.DB.prepare('SELECT event_id FROM party_guests WHERE token = ?').bind(token).first();
    if (g) ev = await env.DB.prepare('SELECT * FROM party_events WHERE id = ?').bind(g.event_id).first();
  }
  const res = await env.ASSETS.fetch(new Request(new URL('/parties/rsvp.html', origin).toString()));
  let html = await res.text();
  if (ev) {
    const meta = buildOgMeta({
      title: ev.title, emoji: ev.emoji,
      whenText: formatEventWhen(ev.starts_at, ev.timezone),
      location: ev.location,
      imageUrl: ogImageUrl(env, ev),
      pageUrl: rsvpLink(env, ev.share_token),
    });
    html = html
      .replace('<!--OG-->', meta)
      .replace('<title>You\'re invited</title>', `<title>${escapeHtml(`${ev.emoji ? ev.emoji + ' ' : ''}${ev.title}`)}</title>`);
  }
  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function servePage(env, origin, file) {
  const res = await env.ASSETS.fetch(new Request(new URL(file, origin).toString()));
  return new Response(res.body, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

// --- Cron: automatic reminder ~24h before the event ---

// Runs on the per-minute tick. Picks events inside the 22-24h pre-event
// window with auto_reminder on, and drains un-reminded, non-declined guests
// in small batches (12/minute → a full 200-guest list clears in ~17 min).
export async function runPartyReminders(env) {
  await ensureSchema(env);
  const evs = await env.DB.prepare(
    `SELECT * FROM party_events WHERE status = 'active' AND auto_reminder = 1 AND starts_at IS NOT NULL
       AND julianday(starts_at) > julianday('now', '+22 hours')
       AND julianday(starts_at) <= julianday('now', '+24 hours')
     LIMIT 5`
  ).all();
  let budget = AUTO_REMINDER_BATCH;
  for (const ev of (evs.results || [])) {
    if (budget <= 0) break;
    const rows = await env.DB.prepare(
      `SELECT * FROM party_guests WHERE event_id = ? AND reminded_at IS NULL
         AND rsvp IN ('pending', 'yes', 'maybe') AND (phone_e164 IS NOT NULL OR email IS NOT NULL)
       ORDER BY created_at LIMIT ?`
    ).bind(ev.id, budget).all();
    const guests = rows.results || [];
    budget -= guests.length;
    const whenText = formatEventWhen(ev.starts_at, ev.timezone);
    for (const g of guests) {
      const link = rsvpLink(env, g.token);
      const smsBody = buildReminderSms({ title: ev.title, emoji: ev.emoji, whenText, link });
      const email = plainEmail(`${ev.emoji ? ev.emoji + ' ' : ''}Reminder: ${ev.title}`,
        `Reminder: ${ev.title} is ${whenText || 'coming up soon'}.`, link, 'Details + RSVP');
      // Mark before sending so a crashed tick can't double-text anyone.
      await env.DB.prepare(`UPDATE party_guests SET reminded_at = datetime('now') WHERE id = ?`).bind(g.id).run();
      await deliverToGuest(env, ev, g, { kind: 'reminder', smsBody, email });
    }
  }
}

// --- Entry point, dispatched from worker.js for /parties* and /e/* ---

export async function handleParties(request, env, url) {
  const path = url.pathname;

  // Uploaded cover images (R2) — must run before the static-asset passthrough,
  // which would otherwise swallow these extensions.
  let m0 = path.match(/^\/parties\/img\/([A-Za-z0-9/_.-]+)$/);
  if (m0 && request.method === 'GET' && !m0[1].includes('..')) return serveUploadedImage(env, m0[1]);

  // Static assets (css/js/img) pass straight through.
  if (/\.(js|css|png|jpg|jpeg|svg|ico|webmanifest|map|webp)$/.test(path)) {
    return env.ASSETS.fetch(request);
  }

  // Guest RSVP page: /e/<token> (OG tags injected server-side).
  const eMatch = path.match(/^\/e\/([A-Za-z0-9]+)\/?$/);
  if (eMatch) return serveRsvpPage(env, url.origin, eMatch[1]);

  // Public API.
  let m = path.match(/^\/parties\/api\/link\/([A-Za-z0-9]+)$/);
  if (m && request.method === 'GET') return handleLinkLookup(env, m[1]);
  m = path.match(/^\/parties\/api\/rsvp\/([A-Za-z0-9]+)$/);
  if (m && request.method === 'POST') return handleRsvp(request, env, m[1]);
  m = path.match(/^\/parties\/api\/open\/([A-Za-z0-9]+)$/);
  if (m && request.method === 'POST') return handleOpenRsvp(request, env, m[1]);
  m = path.match(/^\/parties\/api\/comment\/([A-Za-z0-9]+)$/);
  if (m && request.method === 'POST') return handlePostComment(request, env, m[1]);
  m = path.match(/^\/parties\/api\/datevote\/([A-Za-z0-9]+)$/);
  if (m && request.method === 'POST') return handleDateVote(request, env, m[1]);

  // Host API (Clerk-gated).
  if (path.startsWith('/parties/api/')) {
    await ensureSchema(env);
    if (path === '/parties/api/events' && request.method === 'POST') return handleCreateEvent(request, env);
    if (path === '/parties/api/events' && request.method === 'GET') return handleListEvents(request, env);
    m = path.match(/^\/parties\/api\/events\/([A-Za-z0-9]+)$/);
    if (m && request.method === 'GET') return handleEventDetail(request, env, m[1]);
    if (m && request.method === 'PATCH') return handleUpdateEvent(request, env, m[1]);
    m = path.match(/^\/parties\/api\/events\/([A-Za-z0-9]+)\/guests$/);
    if (m && request.method === 'POST') return handleAddGuests(request, env, m[1]);
    m = path.match(/^\/parties\/api\/events\/([A-Za-z0-9]+)\/guests\/([A-Za-z0-9]+)$/);
    if (m && request.method === 'DELETE') return handleDeleteGuest(request, env, m[1], m[2]);
    m = path.match(/^\/parties\/api\/events\/([A-Za-z0-9]+)\/guests\/([A-Za-z0-9]+)\/admit$/);
    if (m && request.method === 'POST') return handleAdmitGuest(request, env, m[1], m[2]);
    m = path.match(/^\/parties\/api\/events\/([A-Za-z0-9]+)\/send$/);
    if (m && request.method === 'POST') return handleSend(request, env, m[1]);
    m = path.match(/^\/parties\/api\/events\/([A-Za-z0-9]+)\/cover$/);
    if (m && request.method === 'POST') return handleUploadCover(request, env, m[1]);
    m = path.match(/^\/parties\/api\/events\/([A-Za-z0-9]+)\/date-options$/);
    if (m && request.method === 'POST') return handleSetDateOptions(request, env, m[1]);
    m = path.match(/^\/parties\/api\/events\/([A-Za-z0-9]+)\/date-options\/([A-Za-z0-9]+)\/pick$/);
    if (m && request.method === 'POST') return handlePickDate(request, env, m[1], m[2]);
    m = path.match(/^\/parties\/api\/events\/([A-Za-z0-9]+)\/cohosts$/);
    if (m && request.method === 'POST') return handleAddCohost(request, env, m[1]);
    if (m && request.method === 'DELETE') return handleRemoveCohost(request, env, m[1]);
    m = path.match(/^\/parties\/api\/events\/([A-Za-z0-9]+)\/comments\/([A-Za-z0-9]+)$/);
    if (m && request.method === 'DELETE') return handleDeleteComment(request, env, m[1], m[2]);
    return json({ ok: false, error: 'not found' }, 404);
  }

  // Host app page for /parties and any sub-path.
  return servePage(env, url.origin, '/parties/index.html');
}
