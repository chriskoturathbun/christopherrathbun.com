// Dreamlist — a shared dream list for two. One list, two people, equal rights.
// Items are the product; map and calendar are views of the same items.
// Members sign in with Clerk; invites are claimed from an unguessable token.
import { verifyClerkJWT, getClerkUserEmail } from './reminders-clerk.js';
import { sendResendEmail } from './reminders-alerts.js';

// Caps sized for a small shared list — enough headroom that two people never
// hit them, low enough that a compromised account can't run up a bill.
const MAX_ITEMS_PER_LIST = 2000;
const MAX_NOTES_PER_ITEM = 200;
const MAX_MEMBERS_PER_LIST = 12;
const MAX_INVITES_PER_DAY = 20;
const MAX_TITLE = 300;
const MAX_NOTE = 4000;

export const ACCENTS = ['ember', 'bloom', 'tide', 'moss', 'dusk', 'clay'];
export const CATEGORIES = ['travel', 'food', 'outdoors', 'culture', 'home', 'someday'];

// --- Pure helpers (unit-tested in test/dreamlist.test.mjs) ---

export function isEmail(s) {
  return typeof s === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.trim());
}

export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Position of an item dropped between two neighbours. Positions are floats so
// a reorder writes exactly one row. When the gap closes to nothing (repeated
// drops in the same slot exhaust float precision) the caller renumbers.
export function midpoint(before, after) {
  const lo = Number.isFinite(before) ? before : null;
  const hi = Number.isFinite(after) ? after : null;
  if (lo === null && hi === null) return 1000;
  if (lo === null) return hi - 100;
  if (hi === null) return lo + 100;
  if (hi <= lo) return lo + 100;   // degenerate order — push past the anchor
  return lo + (hi - lo) / 2;
}

// True when the float gap between neighbours has collapsed and the list needs
// evenly-spaced positions rewritten.
export function needsRenumber(positions) {
  if (!Array.isArray(positions) || positions.length < 2) return false;
  for (let i = 1; i < positions.length; i++) {
    const gap = positions[i] - positions[i - 1];
    if (!(gap > 1e-6)) return true;
  }
  return false;
}

export function renumber(count, step = 1000) {
  return Array.from({ length: Math.max(0, count) }, (_, i) => (i + 1) * step);
}

// Trim to a cap without leaving a dangling partial word mid-sentence.
export function clampText(s, max) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (!t) return null;
  return t.length > max ? t.slice(0, max) : t;
}

// Day key in a given timezone — the bucket a dream falls into on the calendar.
// Uses en-CA because it formats as YYYY-MM-DD, which sorts lexically.
export function dayKey(iso, timeZone) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

// Group scheduled items by day for the calendar. Unscheduled items are left
// out entirely — the calendar only claims to show what has a date.
export function groupByDay(items, timeZone) {
  const out = {};
  for (const it of items || []) {
    const key = dayKey(it.scheduledAt, timeZone);
    if (!key) continue;
    (out[key] ||= []).push(it);
  }
  for (const key of Object.keys(out)) {
    out[key].sort((a, b) => String(a.scheduledAt).localeCompare(String(b.scheduledAt)));
  }
  return out;
}

// Split items into the ones the map can actually pin and the ones it can't,
// so the UI can show the leftovers instead of dropping them silently.
export function partitionByLocation(items) {
  const pinned = [], unpinned = [];
  for (const it of items || []) {
    if (Number.isFinite(it.lat) && Number.isFinite(it.lng)) pinned.push(it);
    else unpinned.push(it);
  }
  return { pinned, unpinned };
}

// Bounding box over pinned items, padded so pins never sit on the map edge.
// A single pin gets a small box around it rather than a zero-area one.
export function boundsFor(items, pad = 0.02) {
  const pts = (items || []).filter(i => Number.isFinite(i.lat) && Number.isFinite(i.lng));
  if (!pts.length) return null;
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const p of pts) {
    minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
    minLng = Math.min(minLng, p.lng); maxLng = Math.max(maxLng, p.lng);
  }
  if (minLat === maxLat && minLng === maxLng) {
    return [[minLat - pad, minLng - pad], [maxLat + pad, maxLng + pad]];
  }
  return [[minLat - pad, minLng - pad], [maxLat + pad, maxLng + pad]];
}

// Normalize one Nominatim result into the shape the client stores on an item.
export function normalizeGeoResult(r) {
  if (!r || typeof r !== 'object') return null;
  const lat = parseFloat(r.lat), lng = parseFloat(r.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const display = typeof r.display_name === 'string' ? r.display_name : '';
  if (!display) return null;
  const parts = display.split(',').map(s => s.trim()).filter(Boolean);
  const named = r.name && typeof r.name === 'string' ? r.name.trim() : '';
  return {
    label: named || parts[0] || display,
    address: display,
    lat, lng,
  };
}

// Human "when" for a scheduled dream, in the viewer's timezone.
export function formatWhen(iso, timeZone, allDay) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const opts = allDay
    ? { weekday: 'short', month: 'short', day: 'numeric' }
    : { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: timeZone || 'UTC', ...opts }).format(d);
  } catch {
    return d.toUTCString();
  }
}

export function firstName(name) {
  const n = (name || '').trim();
  if (!n) return '';
  return n.split(/\s+/)[0];
}

function shortId(len = 12) {
  const a = 'abcdefghjkmnpqrstuvwxyz23456789';
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  return [...buf].map(b => a[b % a.length]).join('');
}

function hexToken(bytes = 16) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map(b => b.toString(16).padStart(2, '0')).join('');
}

// --- Schema (created on demand, same pattern as parties/reminders) ---

let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  const db = env.DB;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS dream_lists (
      id TEXT PRIMARY KEY,
      owner_clerk_id TEXT NOT NULL,
      owner_name TEXT,
      name TEXT NOT NULL,
      emoji TEXT,
      accent TEXT DEFAULT 'ember',
      timezone TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')))`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_dream_lists_owner ON dream_lists (owner_clerk_id)`),

    db.prepare(`CREATE TABLE IF NOT EXISTS dream_members (
      id TEXT PRIMARY KEY,
      list_id TEXT NOT NULL,
      clerk_id TEXT,
      email TEXT,
      name TEXT,
      role TEXT NOT NULL DEFAULT 'member',
      status TEXT NOT NULL DEFAULT 'pending',
      invite_token TEXT UNIQUE,
      invited_by TEXT,
      invited_at TEXT,
      joined_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')))`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_dream_members_list ON dream_members (list_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_dream_members_clerk ON dream_members (clerk_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_dream_members_email ON dream_members (email)`),

    db.prepare(`CREATE TABLE IF NOT EXISTS dream_items (
      id TEXT PRIMARY KEY,
      list_id TEXT NOT NULL,
      title TEXT NOT NULL,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      position REAL NOT NULL DEFAULT 1000,
      starred INTEGER NOT NULL DEFAULT 0,
      category TEXT,
      place_label TEXT,
      place_address TEXT,
      lat REAL,
      lng REAL,
      scheduled_at TEXT,
      all_day INTEGER NOT NULL DEFAULT 1,
      created_by_clerk_id TEXT,
      created_by_name TEXT,
      done_at TEXT,
      done_by_clerk_id TEXT,
      done_by_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')))`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_dream_items_list ON dream_items (list_id, status, position)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_dream_items_sched ON dream_items (list_id, scheduled_at)`),

    db.prepare(`CREATE TABLE IF NOT EXISTS dream_notes (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL,
      list_id TEXT NOT NULL,
      author_clerk_id TEXT,
      author_name TEXT,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')))`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_dream_notes_item ON dream_notes (item_id, created_at)`),

    db.prepare(`CREATE TABLE IF NOT EXISTS dream_geocache (
      query TEXT PRIMARY KEY,
      results TEXT NOT NULL,
      cached_at TEXT NOT NULL DEFAULT (datetime('now')))`),
  ]);
  schemaReady = true;
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

function baseUrl(env) {
  return env.PUBLIC_BASE_URL || 'https://christopherrathbun.com';
}

function inviteLink(env, token) {
  return `${baseUrl(env)}/d/${token}`;
}

function emailFrom(env) {
  return env.DREAMLIST_EMAIL_FROM || 'Dreamlist <dreamlist@mail.giftanagent.com>';
}

// --- Identity and membership ---

// Resolve the caller from their Clerk session JWT. Returns null when the
// request carries no valid session.
async function requireUser(request, env) {
  const auth = request.headers.get('authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const payload = await verifyClerkJWT(auth.slice(7), env);
  if (!payload?.sub) return null;
  // Clerk puts name/email claims on the session token when the JWT template
  // includes them; fall back to the Backend API only when they're absent.
  const name = [payload.first_name, payload.last_name].filter(Boolean).join(' ')
    || payload.name || payload.username || null;
  return { clerkId: payload.sub, name, email: (payload.email || '').toLowerCase() || null };
}

// The signed-in user's primary email, from the token when present and from
// Clerk's API otherwise. Cached per request by the caller.
async function userEmail(user, env) {
  if (user.email) return user.email;
  const e = await getClerkUserEmail(user.clerkId, env);
  if (e) user.email = e;
  return e;
}

// Claim any pending invite addressed to this user's email. Runs on every
// authenticated request, so clicking an invite link and signing up is the
// entire join flow — there is no separate "accept" step to get stuck on.
async function claimPendingInvites(env, user) {
  const email = await userEmail(user, env);
  if (!email) return;
  const pending = await env.DB.prepare(
    `SELECT id, list_id FROM dream_members
     WHERE status = 'pending' AND email = ? AND (clerk_id IS NULL OR clerk_id = '')`
  ).bind(email).all();
  for (const row of pending.results || []) {
    // A user already in the list (e.g. invited twice) just drops the dupe.
    const already = await env.DB.prepare(
      `SELECT id FROM dream_members WHERE list_id = ? AND clerk_id = ? AND status = 'active'`
    ).bind(row.list_id, user.clerkId).first();
    if (already) {
      await env.DB.prepare('DELETE FROM dream_members WHERE id = ?').bind(row.id).run();
      continue;
    }
    await env.DB.prepare(
      `UPDATE dream_members SET clerk_id = ?, name = COALESCE(NULLIF(?, ''), name),
       status = 'active', joined_at = datetime('now') WHERE id = ?`
    ).bind(user.clerkId, user.name || '', row.id).run();
  }
}

// A list the caller may read and write: they own it, or they hold an active
// membership. Owner and member have identical rights over items — the only
// owner-only powers are inviting and removing members.
async function loadMemberList(env, listId, user) {
  const own = await env.DB.prepare(
    'SELECT * FROM dream_lists WHERE id = ? AND owner_clerk_id = ?'
  ).bind(listId, user.clerkId).first();
  if (own) return { list: own, role: 'owner' };

  const member = await env.DB.prepare(
    `SELECT l.* FROM dream_lists l JOIN dream_members m ON m.list_id = l.id
     WHERE l.id = ? AND m.clerk_id = ? AND m.status = 'active'`
  ).bind(listId, user.clerkId).first();
  if (member) return { list: member, role: 'member' };
  return null;
}

// Every list the caller can see, owned first, then joined.
async function listsForUser(env, user) {
  const rows = await env.DB.prepare(
    `SELECT l.*, CASE WHEN l.owner_clerk_id = ?1 THEN 'owner' ELSE 'member' END AS role
       FROM dream_lists l
      WHERE l.owner_clerk_id = ?1
         OR EXISTS (SELECT 1 FROM dream_members m
                     WHERE m.list_id = l.id AND m.clerk_id = ?1 AND m.status = 'active')
      ORDER BY (l.owner_clerk_id = ?1) DESC, l.created_at ASC`
  ).bind(user.clerkId).all();
  return rows.results || [];
}

// First visit gets a working list rather than an empty-state decision.
async function ensureDefaultList(env, user) {
  const existing = await listsForUser(env, user);
  if (existing.length) return existing;
  const id = shortId();
  await env.DB.prepare(
    `INSERT INTO dream_lists (id, owner_clerk_id, owner_name, name, emoji, accent)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(id, user.clerkId, user.name || null, 'Our Dreamlist', '✨', 'ember').run();
  return listsForUser(env, user);
}

async function touchList(env, listId) {
  await env.DB.prepare(`UPDATE dream_lists SET updated_at = datetime('now') WHERE id = ?`)
    .bind(listId).run();
}

// --- Projections ---

function publicItem(r) {
  return {
    id: r.id,
    title: r.title,
    notes: r.notes || '',
    status: r.status,
    position: r.position,
    starred: !!r.starred,
    category: r.category || null,
    placeLabel: r.place_label || null,
    placeAddress: r.place_address || null,
    lat: r.lat == null ? null : Number(r.lat),
    lng: r.lng == null ? null : Number(r.lng),
    scheduledAt: r.scheduled_at || null,
    allDay: r.all_day == null ? true : !!r.all_day,
    createdByName: r.created_by_name || null,
    createdByClerkId: r.created_by_clerk_id || null,
    doneAt: r.done_at || null,
    doneByName: r.done_by_name || null,
    noteCount: Number(r.note_count || 0),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function publicMember(r) {
  return {
    id: r.id,
    name: r.name || null,
    email: r.email || null,
    role: r.role,
    status: r.status,
    joinedAt: r.joined_at || null,
  };
}

function publicList(l, role) {
  return {
    id: l.id, name: l.name, emoji: l.emoji || '✨',
    accent: l.accent || 'ember', role,
    createdAt: l.created_at, updatedAt: l.updated_at,
  };
}

async function membersOf(env, list) {
  const rows = await env.DB.prepare(
    `SELECT * FROM dream_members WHERE list_id = ? ORDER BY created_at ASC`
  ).bind(list.id).all();
  const out = (rows.results || []).map(publicMember);
  // The owner isn't a dream_members row — surface them so the UI can show
  // everyone on the list in one place.
  out.unshift({
    id: 'owner', name: list.owner_name || null, email: null,
    role: 'owner', status: 'active', joinedAt: list.created_at,
  });
  return out;
}

async function itemsOf(env, listId) {
  const rows = await env.DB.prepare(
    `SELECT i.*, (SELECT COUNT(*) FROM dream_notes n WHERE n.item_id = i.id) AS note_count
       FROM dream_items i WHERE i.list_id = ?
      ORDER BY i.status ASC, i.starred DESC, i.position ASC`
  ).bind(listId).all();
  return (rows.results || []).map(publicItem);
}

// --- Item field sanitization ---

// Accept only the fields a client is allowed to set, coerced to safe values.
// `partial` distinguishes a create (title required) from a patch (title only
// overwritten when present), so a patch can never blank a field by omission.
export function sanitizeItemFields(body, { partial } = { partial: false }) {
  const b = body && typeof body === 'object' ? body : {};
  const out = {};
  const err = (m) => ({ error: m });

  if (!partial || b.title !== undefined) {
    const title = clampText(b.title, MAX_TITLE);
    if (!title) return err('A dream needs a title.');
    out.title = title;
  }
  if (b.notes !== undefined) out.notes = clampText(b.notes, MAX_NOTE);
  if (b.category !== undefined) {
    out.category = CATEGORIES.includes(b.category) ? b.category : null;
  }
  if (b.starred !== undefined) out.starred = b.starred ? 1 : 0;
  if (b.status !== undefined) {
    if (!['open', 'done'].includes(b.status)) return err('Unknown status.');
    out.status = b.status;
  }

  // Location: a place can be freeform text with no coordinates. Coordinates
  // only stick when both are present and in range — a half-set pin would put
  // an item in the ocean off Africa.
  if (b.placeLabel !== undefined) out.place_label = clampText(b.placeLabel, 200);
  if (b.placeAddress !== undefined) out.place_address = clampText(b.placeAddress, 400);
  if (b.lat !== undefined || b.lng !== undefined) {
    const lat = Number(b.lat), lng = Number(b.lng);
    const ok = Number.isFinite(lat) && Number.isFinite(lng)
      && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
    out.lat = ok ? lat : null;
    out.lng = ok ? lng : null;
  }

  if (b.scheduledAt !== undefined) {
    if (b.scheduledAt === null || b.scheduledAt === '') {
      out.scheduled_at = null;
    } else {
      const d = new Date(b.scheduledAt);
      if (isNaN(d.getTime())) return err("That date didn't parse.");
      out.scheduled_at = d.toISOString();
    }
  }
  if (b.allDay !== undefined) out.all_day = b.allDay ? 1 : 0;

  return out;
}

// --- Item handlers ---

async function handleCreateItem(request, env, list, user) {
  let body = {};
  try { body = await request.json(); } catch {}
  const fields = sanitizeItemFields(body, { partial: false });
  if (fields.error) return json({ error: fields.error }, 400);

  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM dream_items WHERE list_id = ?')
    .bind(list.id).first();
  if (Number(count?.n || 0) >= MAX_ITEMS_PER_LIST) {
    return json({ error: 'This list is full.' }, 400);
  }

  // New dreams land at the top — the thing you just thought of is the thing
  // you're most excited about.
  const top = await env.DB.prepare(
    `SELECT MIN(position) AS p FROM dream_items WHERE list_id = ? AND status = 'open'`
  ).bind(list.id).first();
  const position = top?.p == null ? 1000 : Number(top.p) - 100;

  const id = shortId();
  const cols = {
    id, list_id: list.id, position,
    created_by_clerk_id: user.clerkId, created_by_name: user.name || null,
    status: 'open', starred: 0, all_day: 1,
    ...fields,
  };
  const keys = Object.keys(cols);
  await env.DB.prepare(
    `INSERT INTO dream_items (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`
  ).bind(...keys.map(k => cols[k])).run();
  await touchList(env, list.id);

  const row = await env.DB.prepare('SELECT * FROM dream_items WHERE id = ?').bind(id).first();
  return json({ item: publicItem(row) }, 201);
}

async function handleUpdateItem(request, env, list, user, itemId) {
  const existing = await env.DB.prepare(
    'SELECT * FROM dream_items WHERE id = ? AND list_id = ?'
  ).bind(itemId, list.id).first();
  if (!existing) return json({ error: 'not found' }, 404);

  let body = {};
  try { body = await request.json(); } catch {}
  const fields = sanitizeItemFields(body, { partial: true });
  if (fields.error) return json({ error: fields.error }, 400);

  // Completing records who did it; re-opening clears that, so an item that
  // gets un-done doesn't keep claiming it was finished.
  if (fields.status === 'done' && existing.status !== 'done') {
    fields.done_at = new Date().toISOString();
    fields.done_by_clerk_id = user.clerkId;
    fields.done_by_name = user.name || null;
  } else if (fields.status === 'open' && existing.status === 'done') {
    fields.done_at = null; fields.done_by_clerk_id = null; fields.done_by_name = null;
  }

  const keys = Object.keys(fields);
  if (!keys.length) return json({ item: publicItem(existing) });
  await env.DB.prepare(
    `UPDATE dream_items SET ${keys.map(k => `${k} = ?`).join(', ')},
     updated_at = datetime('now') WHERE id = ? AND list_id = ?`
  ).bind(...keys.map(k => fields[k]), itemId, list.id).run();
  await touchList(env, list.id);

  const row = await env.DB.prepare(
    `SELECT i.*, (SELECT COUNT(*) FROM dream_notes n WHERE n.item_id = i.id) AS note_count
       FROM dream_items i WHERE i.id = ?`
  ).bind(itemId).first();
  return json({ item: publicItem(row) });
}

async function handleDeleteItem(env, list, itemId) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM dream_notes WHERE item_id = ? AND list_id = ?').bind(itemId, list.id),
    env.DB.prepare('DELETE FROM dream_items WHERE id = ? AND list_id = ?').bind(itemId, list.id),
  ]);
  await touchList(env, list.id);
  return json({ ok: true });
}

// Drop an item between two neighbours. The client sends the ids it dropped
// between; the server computes the position so two people dragging at once
// can't corrupt each other's ordering.
async function handleReorder(request, env, list) {
  let body = {};
  try { body = await request.json(); } catch {}
  const { itemId, beforeId, afterId } = body || {};
  if (!itemId) return json({ error: 'itemId required' }, 400);

  const target = await env.DB.prepare(
    'SELECT id FROM dream_items WHERE id = ? AND list_id = ?'
  ).bind(itemId, list.id).first();
  if (!target) return json({ error: 'not found' }, 404);

  const posOf = async (id) => {
    if (!id) return null;
    const r = await env.DB.prepare(
      'SELECT position FROM dream_items WHERE id = ? AND list_id = ?'
    ).bind(id, list.id).first();
    return r ? Number(r.position) : null;
  };
  const position = midpoint(await posOf(beforeId), await posOf(afterId));

  await env.DB.prepare(
    `UPDATE dream_items SET position = ?, updated_at = datetime('now')
     WHERE id = ? AND list_id = ?`
  ).bind(position, itemId, list.id).run();

  // Once the float gap collapses, rewrite evenly-spaced positions so future
  // drops have room again.
  const open = await env.DB.prepare(
    `SELECT id, position FROM dream_items WHERE list_id = ? AND status = 'open'
     ORDER BY position ASC`
  ).bind(list.id).all();
  const rows = open.results || [];
  if (needsRenumber(rows.map(r => Number(r.position)))) {
    const fresh = renumber(rows.length);
    await env.DB.batch(rows.map((r, i) => env.DB.prepare(
      'UPDATE dream_items SET position = ? WHERE id = ?'
    ).bind(fresh[i], r.id)));
  }
  await touchList(env, list.id);
  return json({ ok: true, items: await itemsOf(env, list.id) });
}

// --- Notes ---

async function handleAddNote(request, env, list, user, itemId) {
  const item = await env.DB.prepare(
    'SELECT id FROM dream_items WHERE id = ? AND list_id = ?'
  ).bind(itemId, list.id).first();
  if (!item) return json({ error: 'not found' }, 404);

  let body = {};
  try { body = await request.json(); } catch {}
  const text = clampText(body.body, MAX_NOTE);
  if (!text) return json({ error: 'Write something first.' }, 400);

  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM dream_notes WHERE item_id = ?')
    .bind(itemId).first();
  if (Number(count?.n || 0) >= MAX_NOTES_PER_ITEM) {
    return json({ error: 'This dream has all the notes it can hold.' }, 400);
  }

  const id = shortId();
  await env.DB.prepare(
    `INSERT INTO dream_notes (id, item_id, list_id, author_clerk_id, author_name, body)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(id, itemId, list.id, user.clerkId, user.name || null, text).run();
  await touchList(env, list.id);

  const row = await env.DB.prepare('SELECT * FROM dream_notes WHERE id = ?').bind(id).first();
  return json({
    note: { id: row.id, body: row.body, authorName: row.author_name,
            authorClerkId: row.author_clerk_id, createdAt: row.created_at },
  }, 201);
}

async function handleListNotes(env, list, itemId) {
  const rows = await env.DB.prepare(
    'SELECT * FROM dream_notes WHERE item_id = ? AND list_id = ? ORDER BY created_at ASC'
  ).bind(itemId, list.id).all();
  return json({
    notes: (rows.results || []).map(n => ({
      id: n.id, body: n.body, authorName: n.author_name,
      authorClerkId: n.author_clerk_id, createdAt: n.created_at,
    })),
  });
}

async function handleDeleteNote(env, list, noteId) {
  await env.DB.prepare('DELETE FROM dream_notes WHERE id = ? AND list_id = ?')
    .bind(noteId, list.id).run();
  await touchList(env, list.id);
  return json({ ok: true });
}

// --- Places ---

// Geocoding proxies through the worker for three reasons: Nominatim's policy
// wants an identifying User-Agent we can only set server-side, results cache
// in D1 so repeat searches are instant and free, and the browser never talks
// to a third party about what the two of you are planning.
const GEOCACHE_TTL_DAYS = 90;

async function handleGeocode(env, url) {
  const q = (url.searchParams.get('q') || '').trim().slice(0, 200);
  if (q.length < 2) return json({ results: [] });
  const key = q.toLowerCase();

  const hit = await env.DB.prepare(
    `SELECT results FROM dream_geocache
      WHERE query = ? AND cached_at > datetime('now', ?)`
  ).bind(key, `-${GEOCACHE_TTL_DAYS} days`).first();
  if (hit) {
    try { return json({ results: JSON.parse(hit.results), cached: true }); } catch {}
  }

  let results = [];
  try {
    const endpoint = new URL('https://nominatim.openstreetmap.org/search');
    endpoint.searchParams.set('q', q);
    endpoint.searchParams.set('format', 'jsonv2');
    endpoint.searchParams.set('limit', '6');
    endpoint.searchParams.set('addressdetails', '0');
    const res = await fetch(endpoint, {
      headers: {
        'user-agent': 'Dreamlist/1.0 (christopherrathbun.com; dreamlist place search)',
        'accept-language': 'en',
      },
    });
    // A rate-limit or outage degrades to "no results" — you can still type a
    // freeform place, it just won't get a pin.
    if (res.ok) {
      const raw = await res.json();
      results = (Array.isArray(raw) ? raw : []).map(normalizeGeoResult).filter(Boolean);
    }
  } catch {
    return json({ results: [], unavailable: true });
  }

  if (results.length) {
    try {
      await env.DB.prepare(
        `INSERT INTO dream_geocache (query, results, cached_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(query) DO UPDATE SET results = excluded.results, cached_at = datetime('now')`
      ).bind(key, JSON.stringify(results)).run();
    } catch { /* cache write is best-effort */ }
  }
  return json({ results });
}

// --- Lists and members ---

async function handleGetList(env, list, role, user) {
  const [items, members] = await Promise.all([
    itemsOf(env, list.id),
    membersOf(env, list),
  ]);
  return json({
    list: publicList(list, role),
    items,
    members,
    me: { clerkId: user.clerkId, name: user.name || null },
  });
}

async function handleUpdateList(request, env, list) {
  let body = {};
  try { body = await request.json(); } catch {}
  const fields = {};
  if (body.name !== undefined) {
    const n = clampText(body.name, 120);
    if (!n) return json({ error: 'A list needs a name.' }, 400);
    fields.name = n;
  }
  if (body.emoji !== undefined) fields.emoji = clampText(body.emoji, 8);
  if (body.accent !== undefined) {
    fields.accent = ACCENTS.includes(body.accent) ? body.accent : 'ember';
  }
  const keys = Object.keys(fields);
  if (!keys.length) return json({ ok: true });
  await env.DB.prepare(
    `UPDATE dream_lists SET ${keys.map(k => `${k} = ?`).join(', ')},
     updated_at = datetime('now') WHERE id = ?`
  ).bind(...keys.map(k => fields[k]), list.id).run();
  const row = await env.DB.prepare('SELECT * FROM dream_lists WHERE id = ?').bind(list.id).first();
  return json({ list: publicList(row, 'owner') });
}

async function handleRemoveMember(request, env, list, memberId) {
  await env.DB.prepare('DELETE FROM dream_members WHERE id = ? AND list_id = ?')
    .bind(memberId, list.id).run();
  return json({ ok: true, members: await membersOf(env, list) });
}

// --- Invites ---

// The invite reads like one person telling another about a list, because
// that is what it is. Kept short: the recipient only needs to know who, what,
// and that signing in is one step.
export function buildInviteEmail({ hostName, listName, emoji, link, itemCount }) {
  const who = firstName(hostName) || 'Someone';
  const name = listName || 'a dream list';
  const subject = `${who} added you to ${name}`;
  const teaser = itemCount > 0
    ? `There ${itemCount === 1 ? 'is 1 dream' : `are ${itemCount} dreams`} on it already.`
    : `It's empty so far, which is the fun part.`;

  const text = [
    'Hi,',
    '',
    `${who} started a shared list called "${name}" and put you on it.`,
    '',
    `It's for the things you two keep meaning to do and never write down anywhere. ${teaser} Either of you can add to it, reorder it, pin a place on the map, or put a date on something. You'll both see every change.`,
    '',
    `Open the list: ${link}`,
    '',
    'Sign in with this email address the first time. It opens straight to the list after that.',
  ].join('\n');

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f6f3ee;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f3ee;padding:40px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fffdfa;border-radius:20px;padding:40px 36px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#2b2724;">
        <tr><td style="font-size:34px;line-height:1;padding-bottom:18px;">${escapeHtml(emoji || '✨')}</td></tr>
        <tr><td style="font-size:23px;font-weight:600;letter-spacing:-0.02em;line-height:1.25;padding-bottom:20px;">
          ${escapeHtml(who)} added you to ${escapeHtml(name)}
        </td></tr>
        <tr><td style="font-size:16px;line-height:1.6;color:#544d47;padding-bottom:14px;">
          It's for the things you two keep meaning to do and never write down anywhere. ${escapeHtml(teaser)}
        </td></tr>
        <tr><td style="font-size:16px;line-height:1.6;color:#544d47;padding-bottom:28px;">
          Either of you can add to it, reorder it, pin a place on the map, or put a date on something. You'll both see every change.
        </td></tr>
        <tr><td style="padding-bottom:26px;">
          <a href="${escapeHtml(link)}" style="display:inline-block;background:#c2562f;color:#fffdfa;text-decoration:none;font-size:16px;font-weight:600;padding:14px 28px;border-radius:999px;">Open the list</a>
        </td></tr>
        <tr><td style="font-size:14px;line-height:1.6;color:#8c837b;border-top:1px solid #ece5dc;padding-top:20px;">
          Sign in with this email address the first time. It opens straight to the list after that.
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;

  return { subject, text, html };
}

async function handleInvite(request, env, list, user) {
  let body = {};
  try { body = await request.json(); } catch {}
  const email = (body.email || '').trim().toLowerCase();
  if (!isEmail(email)) return json({ error: "That doesn't look like an email address." }, 400);

  const selfEmail = await userEmail(user, env);
  if (selfEmail && email === selfEmail) {
    return json({ error: "You're already on this list." }, 400);
  }

  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM dream_members WHERE list_id = ?')
    .bind(list.id).first();
  if (Number(count?.n || 0) >= MAX_MEMBERS_PER_LIST) {
    return json({ error: 'This list has all the people it can hold.' }, 400);
  }

  const today = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM dream_members
      WHERE invited_by = ? AND invited_at > datetime('now', '-1 day')`
  ).bind(user.clerkId).first();
  if (Number(today?.n || 0) >= MAX_INVITES_PER_DAY) {
    return json({ error: 'Too many invites today. Try again tomorrow.' }, 429);
  }

  // Re-inviting the same address resends rather than erroring: the common
  // case is an invite that got lost, not a mistake.
  const existing = await env.DB.prepare(
    'SELECT * FROM dream_members WHERE list_id = ? AND email = ?'
  ).bind(list.id, email).first();
  if (existing && existing.status === 'active') {
    return json({ error: 'They already joined this list.' }, 400);
  }

  const token = existing?.invite_token || hexToken(16);
  if (existing) {
    await env.DB.prepare(
      `UPDATE dream_members SET invite_token = ?, invited_by = ?, invited_at = datetime('now') WHERE id = ?`
    ).bind(token, user.clerkId, existing.id).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO dream_members (id, list_id, email, role, status, invite_token, invited_by, invited_at)
       VALUES (?, ?, ?, 'member', 'pending', ?, ?, datetime('now'))`
    ).bind(shortId(), list.id, email, token, user.clerkId).run();
  }

  const items = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM dream_items WHERE list_id = ? AND status = 'open'`
  ).bind(list.id).first();

  const mail = buildInviteEmail({
    hostName: user.name || list.owner_name,
    listName: list.name,
    emoji: list.emoji,
    link: inviteLink(env, token),
    itemCount: Number(items?.n || 0),
  });
  const sent = await sendResendEmail({
    to: email, subject: mail.subject, html: mail.html, text: mail.text, from: emailFrom(env),
  }, env);

  return json({
    ok: true,
    sent: !!sent.ok,
    // Surfaced so the owner can pass the link along by text if mail fails.
    link: inviteLink(env, token),
    members: await membersOf(env, list),
  });
}

// GET /d/<token> — the short invite link. It stores nothing server-side;
// the page keeps the token and claims it once Clerk reports a session.
async function handleInviteLanding(env, url, token) {
  const row = await env.DB.prepare(
    `SELECT m.*, l.name AS list_name, l.emoji AS list_emoji, l.owner_name
       FROM dream_members m JOIN dream_lists l ON l.id = m.list_id
      WHERE m.invite_token = ?`
  ).bind(token).first();
  if (!row) {
    return Response.redirect(`${baseUrl(env)}/dreamlist?invite=unknown`, 302);
  }
  const dest = new URL('/dreamlist', baseUrl(env));
  dest.searchParams.set('invite', token);
  return Response.redirect(dest.toString(), 302);
}

// Claim runs after Clerk sign-in: bind this token to the signed-in user.
async function handleClaimInvite(request, env, user) {
  let body = {};
  try { body = await request.json(); } catch {}
  const token = (body.token || '').trim();
  if (!token) return json({ error: 'missing token' }, 400);

  const row = await env.DB.prepare('SELECT * FROM dream_members WHERE invite_token = ?')
    .bind(token).first();
  if (!row) return json({ error: 'That invite link is no longer valid.' }, 404);

  if (row.status === 'active' && row.clerk_id && row.clerk_id !== user.clerkId) {
    return json({ error: 'That invite was already used by someone else.' }, 403);
  }

  const already = await env.DB.prepare(
    `SELECT id FROM dream_members WHERE list_id = ? AND clerk_id = ? AND status = 'active' AND id != ?`
  ).bind(row.list_id, user.clerkId, row.id).first();
  if (already) {
    await env.DB.prepare('DELETE FROM dream_members WHERE id = ?').bind(row.id).run();
    return json({ ok: true, listId: row.list_id });
  }

  await env.DB.prepare(
    `UPDATE dream_members SET clerk_id = ?, name = COALESCE(NULLIF(?, ''), name),
     email = COALESCE(email, ?), status = 'active', joined_at = datetime('now') WHERE id = ?`
  ).bind(user.clerkId, user.name || '', await userEmail(user, env), row.id).run();

  return json({ ok: true, listId: row.list_id });
}

// --- Router ---

async function fetchPage(env, origin) {
  const res = await env.ASSETS.fetch(new Request(new URL('/dreamlist/index.html', origin)));
  return new Response(res.body, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

export async function handleDreamlist(request, env, url) {
  const path = url.pathname;

  // Short invite link.
  if (path.startsWith('/d/')) {
    await ensureSchema(env);
    return handleInviteLanding(env, url, path.slice(3).split('/')[0]);
  }

  // Static assets for the app shell.
  if (/\.(js|css|png|jpg|jpeg|svg|ico|webmanifest|map|webp|woff2?)$/.test(path)) {
    return env.ASSETS.fetch(request);
  }

  const api = path.startsWith('/dreamlist/api/');
  if (!api) return fetchPage(env, url.origin);

  await ensureSchema(env);
  const rest = path.slice('/dreamlist/api/'.length).replace(/\/+$/, '');
  const seg = rest.split('/').filter(Boolean);
  const method = request.method;

  const user = await requireUser(request, env);
  if (!user) return json({ error: 'sign in required' }, 401);

  // Place search needs a session but not a list — it touches no list data.
  if (seg[0] === 'geocode' && method === 'GET') return handleGeocode(env, url);

  if (seg[0] === 'claim' && method === 'POST') return handleClaimInvite(request, env, user);

  // Any authenticated request is a chance to pick up a pending invite, so a
  // member who signed up before clicking the link still lands inside.
  await claimPendingInvites(env, user);

  // GET /dreamlist/api/lists — everything the caller can see, creating a
  // starter list on a first visit.
  if (seg[0] === 'lists' && seg.length === 1 && method === 'GET') {
    const lists = await ensureDefaultList(env, user);
    return json({
      lists: lists.map(l => publicList(l, l.role)),
      me: { clerkId: user.clerkId, name: user.name || null },
    });
  }

  if (seg[0] === 'lists' && seg.length >= 2) {
    const listId = seg[1];
    const found = await loadMemberList(env, listId, user);
    if (!found) return json({ error: 'not found' }, 404);
    const { list, role } = found;
    const tail = seg.slice(2);

    // Keep the owner's display name current so the members panel isn't stale
    // after they set a name in Clerk.
    if (role === 'owner' && user.name && user.name !== list.owner_name) {
      await env.DB.prepare('UPDATE dream_lists SET owner_name = ? WHERE id = ?')
        .bind(user.name, list.id).run();
      list.owner_name = user.name;
    }

    if (!tail.length) {
      if (method === 'GET') return handleGetList(env, list, role, user);
      if (method === 'PATCH') {
        if (role !== 'owner') return json({ error: 'Only the list owner can rename it.' }, 403);
        return handleUpdateList(request, env, list);
      }
    }

    if (tail[0] === 'items') {
      if (tail.length === 1 && method === 'POST') return handleCreateItem(request, env, list, user);
      if (tail.length === 2 && method === 'PATCH') return handleUpdateItem(request, env, list, user, tail[1]);
      if (tail.length === 2 && method === 'DELETE') return handleDeleteItem(env, list, tail[1]);
      if (tail.length === 3 && tail[2] === 'notes' && method === 'GET') return handleListNotes(env, list, tail[1]);
      if (tail.length === 3 && tail[2] === 'notes' && method === 'POST') return handleAddNote(request, env, list, user, tail[1]);
    }

    if (tail[0] === 'notes' && tail.length === 2 && method === 'DELETE') {
      return handleDeleteNote(env, list, tail[1]);
    }

    if (tail[0] === 'reorder' && method === 'POST') return handleReorder(request, env, list);

    if (tail[0] === 'invite' && method === 'POST') {
      if (role !== 'owner') return json({ error: 'Only the list owner can invite people.' }, 403);
      return handleInvite(request, env, list, user);
    }

    if (tail[0] === 'members' && tail.length === 2 && method === 'DELETE') {
      if (role !== 'owner') return json({ error: 'Only the list owner can remove people.' }, 403);
      return handleRemoveMember(request, env, list, tail[1]);
    }
  }

  return json({ error: 'not found' }, 404);
}
