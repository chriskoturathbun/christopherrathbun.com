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

const RSVP_VALUES = ['pending', 'yes', 'maybe', 'no'];

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

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
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
    (location ? `<p style="margin:4px 0"><strong>Where:</strong> ${escapeHtml(location)}</p>` : '') +
    (description ? `<p style="white-space:pre-wrap;margin:14px 0">${escapeHtml(description)}</p>` : '') +
    `<p style="text-align:center;margin:26px 0"><a href="${escapeHtml(link)}" ` +
    `style="background:#7c5cff;color:#fff;text-decoration:none;padding:14px 34px;border-radius:999px;font-weight:600;display:inline-block">RSVP</a></p>` +
    `<p style="color:#999;font-size:13px;text-align:center">No account needed — one tap and you're done.</p>` +
    `</div>`;
  return { subject, text, html };
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
  ]);
  schemaReady = true;
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

async function fetchPageNoStore(env, origin, file) {
  const res = await env.ASSETS.fetch(new Request(new URL(file, origin).toString()));
  return new Response(res.body, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function baseUrl(env) {
  return env.PUBLIC_BASE_URL || 'https://christopherrathbun.com';
}

function rsvpLink(env, token) {
  return `${baseUrl(env)}/e/${token}`;
}

function emailFrom(env) {
  return env.PARTY_EMAIL_FROM || 'Invites <reminders@mail.giftanagent.com>';
}

// --- Auth ---

async function requireHost(request, env) {
  const auth = request.headers.get('authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const payload = await verifyClerkJWT(auth.slice(7), env);
  if (!payload?.sub) return null;
  return { clerkId: payload.sub };
}

async function loadHostEvent(env, eventId, clerkId) {
  return env.DB.prepare('SELECT * FROM party_events WHERE id = ? AND host_clerk_id = ?')
    .bind(eventId, clerkId).first();
}

// Public projection of an event (never leaks host ids or other guests).
function publicEvent(ev, env) {
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
  };
}

// --- Handlers: host API ---

async function handleCreateEvent(request, env) {
  const host = await requireHost(request, env);
  if (!host) return json({ ok: false, error: 'unauthorized' }, 401);
  let body; try { body = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }

  const title = String(body.title || '').trim().slice(0, 120);
  if (!title) return json({ ok: false, error: 'title required' }, 400);
  const emoji = String(body.emoji || '🎉').trim().slice(0, 8);
  const description = String(body.description || '').trim().slice(0, 2000) || null;
  const location = String(body.location || '').trim().slice(0, 300) || null;
  const timezone = String(body.timezone || 'America/New_York').trim().slice(0, 60);
  let startsAt = null;
  if (body.starts_at) {
    const d = new Date(body.starts_at);
    if (isNaN(d.getTime())) return json({ ok: false, error: 'invalid starts_at' }, 400);
    startsAt = d.toISOString();
  }
  const capacity = Number.isInteger(body.capacity) && body.capacity > 0 ? Math.min(body.capacity, 1000) : null;
  const hostName = String(body.host_name || '').trim().slice(0, 80) || 'Your friend';

  const hostEmail = await getClerkUserEmail(host.clerkId, env);
  const id = shortId(10);
  const shareToken = 's' + hexToken(8);
  await env.DB.prepare(
    `INSERT INTO party_events (id, host_clerk_id, host_email, host_name, title, emoji, description, location, starts_at, timezone, capacity, share_token)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, host.clerkId, hostEmail, hostName, title, emoji, description, location, startsAt, timezone, capacity, shareToken).run();

  return json({ ok: true, event: { id, share_token: shareToken } });
}

async function handleListEvents(request, env) {
  const host = await requireHost(request, env);
  if (!host) return json({ ok: false, error: 'unauthorized' }, 401);
  const rows = await env.DB.prepare(
    `SELECT e.*,
       (SELECT COUNT(*) FROM party_guests g WHERE g.event_id = e.id) AS guest_count,
       (SELECT COUNT(*) FROM party_guests g WHERE g.event_id = e.id AND g.rsvp = 'yes') AS yes_count,
       (SELECT COALESCE(SUM(g.plus_ones), 0) FROM party_guests g WHERE g.event_id = e.id AND g.rsvp = 'yes') AS plus_ones
     FROM party_events e WHERE e.host_clerk_id = ? ORDER BY e.created_at DESC`
  ).bind(host.clerkId).all();
  const events = (rows.results || []).map(ev => ({
    id: ev.id, title: ev.title, emoji: ev.emoji, starts_at: ev.starts_at, timezone: ev.timezone,
    when_text: formatEventWhen(ev.starts_at, ev.timezone), location: ev.location, status: ev.status,
    guest_count: ev.guest_count, yes_count: ev.yes_count, plus_ones: ev.plus_ones,
    share_token: ev.share_token,
  }));
  return json({ ok: true, events });
}

async function handleEventDetail(request, env, eventId) {
  const host = await requireHost(request, env);
  if (!host) return json({ ok: false, error: 'unauthorized' }, 401);
  const ev = await loadHostEvent(env, eventId, host.clerkId);
  if (!ev) return json({ ok: false, error: 'not found' }, 404);
  const guests = await env.DB.prepare(
    `SELECT id, name, phone_e164, email, token, rsvp, plus_ones, note, source, invited_at, responded_at
     FROM party_guests WHERE event_id = ? ORDER BY created_at`
  ).bind(eventId).all();
  return json({
    ok: true,
    event: { ...publicEvent(ev, env), id: ev.id, capacity: ev.capacity, share_token: ev.share_token, share_link: rsvpLink(env, ev.share_token) },
    guests: (guests.results || []).map(g => ({ ...g, link: rsvpLink(env, g.token) })),
  });
}

async function handleUpdateEvent(request, env, eventId) {
  const host = await requireHost(request, env);
  if (!host) return json({ ok: false, error: 'unauthorized' }, 401);
  const ev = await loadHostEvent(env, eventId, host.clerkId);
  if (!ev) return json({ ok: false, error: 'not found' }, 404);
  let body; try { body = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }

  const fields = {};
  if (body.title !== undefined) { const t = String(body.title).trim().slice(0, 120); if (!t) return json({ ok: false, error: 'title required' }, 400); fields.title = t; }
  if (body.emoji !== undefined) fields.emoji = String(body.emoji).trim().slice(0, 8);
  if (body.description !== undefined) fields.description = String(body.description).trim().slice(0, 2000) || null;
  if (body.location !== undefined) fields.location = String(body.location).trim().slice(0, 300) || null;
  if (body.timezone !== undefined) fields.timezone = String(body.timezone).trim().slice(0, 60);
  if (body.starts_at !== undefined) {
    if (body.starts_at === null) fields.starts_at = null;
    else {
      const d = new Date(body.starts_at);
      if (isNaN(d.getTime())) return json({ ok: false, error: 'invalid starts_at' }, 400);
      fields.starts_at = d.toISOString();
    }
  }
  if (body.capacity !== undefined) fields.capacity = Number.isInteger(body.capacity) && body.capacity > 0 ? Math.min(body.capacity, 1000) : null;
  if (body.status !== undefined && ['active', 'cancelled'].includes(body.status)) fields.status = body.status;

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
  const ev = await loadHostEvent(env, eventId, host.clerkId);
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
  const ev = await loadHostEvent(env, eventId, host.clerkId);
  if (!ev) return json({ ok: false, error: 'not found' }, 404);
  await env.DB.prepare('DELETE FROM party_guests WHERE id = ? AND event_id = ?').bind(guestId, eventId).run();
  return json({ ok: true });
}

// Send invites / reminders / a custom update. The client batches guestIds
// (<= MAX_SENDS_PER_REQUEST per call) and shows progress between calls.
async function handleSend(request, env, eventId) {
  const host = await requireHost(request, env);
  if (!host) return json({ ok: false, error: 'unauthorized' }, 401);
  const ev = await loadHostEvent(env, eventId, host.clerkId);
  if (!ev) return json({ ok: false, error: 'not found' }, 404);
  if (ev.status !== 'active') return json({ ok: false, error: 'event is cancelled' }, 400);
  let body; try { body = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }

  const kind = ['invite', 'reminder', 'update'].includes(body.kind) ? body.kind : 'invite';
  const message = String(body.message || '').trim().slice(0, 320);
  if (kind === 'update' && !message) return json({ ok: false, error: 'message required for an update' }, 400);
  const dryRun = !!body.dryRun;

  // Resolve targets: explicit guestIds, else a sensible default per kind.
  let guests;
  if (Array.isArray(body.guestIds) && body.guestIds.length) {
    const ids = body.guestIds.slice(0, MAX_SENDS_PER_REQUEST).map(String);
    const placeholders = ids.map(() => '?').join(',');
    const rows = await env.DB.prepare(
      `SELECT * FROM party_guests WHERE event_id = ? AND id IN (${placeholders})`
    ).bind(eventId, ...ids).all();
    guests = rows.results || [];
  } else {
    const where = kind === 'invite' ? `invited_at IS NULL` : `rsvp != 'no'`;
    const rows = await env.DB.prepare(
      `SELECT * FROM party_guests WHERE event_id = ? AND ${where} ORDER BY created_at LIMIT ?`
    ).bind(eventId, MAX_SENDS_PER_REQUEST).all();
    guests = rows.results || [];
  }
  if (!guests.length) return json({ ok: true, sent: [], remaining: 0, dryRun });

  // Rolling-day cap across all of this host's events.
  const used = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM party_sends s JOIN party_events e ON e.id = s.event_id
     WHERE e.host_clerk_id = ? AND s.created_at > datetime('now', '-1 day')`
  ).bind(host.clerkId).first();
  if ((used?.n || 0) + guests.length > MAX_SENDS_PER_HOST_PER_DAY) {
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

    let channel, res;
    if (g.phone_e164) {
      channel = 'sms';
      res = await sendTwilioSms({ to: g.phone_e164, body: smsBody }, env);
    } else {
      channel = 'email';
      const em = kind === 'update'
        ? { subject: `${ev.emoji ? ev.emoji + ' ' : ''}Update: ${ev.title}`,
            text: `${message}\n\nDetails + RSVP: ${link}`,
            html: `<div style="font-family:system-ui,sans-serif;line-height:1.55"><p>${escapeHtml(message)}</p><p><a href="${escapeHtml(link)}">Details + RSVP</a></p></div>` }
        : buildInviteEmail({ hostName: ev.host_name, title: ev.title, emoji: ev.emoji, whenText, location: ev.location, description: ev.description, link });
      res = await sendResendEmail({ to: g.email, subject: em.subject, html: em.html, text: em.text, from: emailFrom(env) }, env);
    }

    await env.DB.prepare(
      `INSERT INTO party_sends (event_id, guest_id, channel, kind, ok, sid, error) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(eventId, g.id, channel, kind, res.ok ? 1 : 0, res.sid || null, res.ok ? null : String(res.error || res.status || 'send failed')).run();
    if (res.ok && kind === 'invite' && !g.invited_at) {
      await env.DB.prepare(`UPDATE party_guests SET invited_at = datetime('now') WHERE id = ?`).bind(g.id).run();
    }
    results.push({ guestId: g.id, channel, ok: !!res.ok });
  }

  // How many un-invited guests remain (so the client can keep batching).
  let remaining = 0;
  if (kind === 'invite' && !(Array.isArray(body.guestIds) && body.guestIds.length)) {
    const r = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM party_guests WHERE event_id = ? AND invited_at IS NULL`
    ).bind(eventId).first();
    remaining = r?.n || 0;
  }
  return json({ ok: true, sent: results, remaining, dryRun });
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
    return json({ ok: true, type: 'open', event: publicEvent(shared, env), at_capacity: atCapacity });
  }

  const guest = await env.DB.prepare('SELECT * FROM party_guests WHERE token = ?').bind(token).first();
  if (!guest) return json({ ok: false, error: 'not found' }, 404);
  const ev = await env.DB.prepare('SELECT * FROM party_events WHERE id = ?').bind(guest.event_id).first();
  if (!ev) return json({ ok: false, error: 'not found' }, 404);
  return json({
    ok: true, type: 'guest', event: publicEvent(ev, env),
    guest: { name: guest.name, rsvp: guest.rsvp, plus_ones: guest.plus_ones, note: guest.note },
  });
}

async function handleRsvp(request, env, token) {
  await ensureSchema(env);
  let body; try { body = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const rsvp = RSVP_VALUES.includes(body.rsvp) ? body.rsvp : null;
  if (!rsvp || rsvp === 'pending') return json({ ok: false, error: 'rsvp must be yes, maybe, or no' }, 400);
  const plusOnes = Number.isInteger(body.plus_ones) ? Math.max(0, Math.min(body.plus_ones, 10)) : 0;
  const note = String(body.note || '').trim().slice(0, 500) || null;
  const name = String(body.name || '').trim().slice(0, 80) || null;

  const guest = await env.DB.prepare('SELECT * FROM party_guests WHERE token = ?').bind(token).first();
  if (!guest) return json({ ok: false, error: 'not found' }, 404);
  const ev = await env.DB.prepare('SELECT * FROM party_events WHERE id = ?').bind(guest.event_id).first();
  if (!ev || ev.status !== 'active') return json({ ok: false, error: 'this event is no longer active' }, 400);

  await env.DB.prepare(
    `UPDATE party_guests SET rsvp = ?, plus_ones = ?, note = ?, name = COALESCE(?, name), responded_at = datetime('now') WHERE id = ?`
  ).bind(rsvp, plusOnes, note, name, guest.id).run();
  return json({ ok: true, rsvp });
}

// Open share link: anyone with the link RSVPs by leaving a name and
// (optionally) a phone or email so they can get updates.
async function handleOpenRsvp(request, env, shareToken) {
  await ensureSchema(env);
  let body; try { body = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const ev = await env.DB.prepare('SELECT * FROM party_events WHERE share_token = ?').bind(shareToken).first();
  if (!ev) return json({ ok: false, error: 'not found' }, 404);
  if (ev.status !== 'active') return json({ ok: false, error: 'this event is no longer active' }, 400);

  const rsvp = RSVP_VALUES.includes(body.rsvp) ? body.rsvp : null;
  if (!rsvp || rsvp === 'pending') return json({ ok: false, error: 'rsvp must be yes, maybe, or no' }, 400);
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
    if ((yes?.n || 0) + (yes?.p || 0) + 1 + plusOnes > ev.capacity) {
      return json({ ok: false, error: 'sorry — this event is at capacity' }, 400);
    }
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

// --- Entry point, dispatched from worker.js for /parties* and /e/* ---

export async function handleParties(request, env, url) {
  const path = url.pathname;

  // Static assets (css/js/img) pass straight through.
  if (/\.(js|css|png|jpg|jpeg|svg|ico|webmanifest|map|webp)$/.test(path)) {
    return env.ASSETS.fetch(request);
  }

  // Guest RSVP page: /e/<token>
  const eMatch = path.match(/^\/e\/([A-Za-z0-9]+)\/?$/);
  if (eMatch) return fetchPageNoStore(env, url.origin, '/parties/rsvp.html');

  // Public API.
  let m = path.match(/^\/parties\/api\/link\/([A-Za-z0-9]+)$/);
  if (m && request.method === 'GET') return handleLinkLookup(env, m[1]);
  m = path.match(/^\/parties\/api\/rsvp\/([A-Za-z0-9]+)$/);
  if (m && request.method === 'POST') return handleRsvp(request, env, m[1]);
  m = path.match(/^\/parties\/api\/open\/([A-Za-z0-9]+)$/);
  if (m && request.method === 'POST') return handleOpenRsvp(request, env, m[1]);

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
    m = path.match(/^\/parties\/api\/events\/([A-Za-z0-9]+)\/send$/);
    if (m && request.method === 'POST') return handleSend(request, env, m[1]);
    return json({ ok: false, error: 'not found' }, 404);
  }

  // Host app page for /parties and any sub-path.
  return fetchPageNoStore(env, url.origin, '/parties/index.html');
}
