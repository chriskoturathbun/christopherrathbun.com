// Claude Code approval bridge — backend for the ClaudeApprove iPhone/Watch app.
//
// The PreToolUse hook on a dev machine POSTs permission requests here; the
// Worker pushes an APNs notification to every registered device; the app (or
// its notification action buttons) POSTs back approve/deny; the hook polls
// the request until it resolves.
//
// Routes (all under /api/claude-approve, bearer-auth with APPROVE_SECRET):
//   POST /requests               {tool, detail, cwd}        -> {id}
//   GET  /requests/:id                                      -> {id, status, ...}
//   POST /requests/:id/respond   {decision, device?}        -> {ok}
//   GET  /requests?status=pending                           -> {requests: [...]}
//   POST /devices                {token, topic, platform, name} -> {ok}
//
// Secrets (wrangler secret put ...): APPROVE_SECRET, APNS_TEAM_ID,
// APNS_KEY_ID, APNS_P8 (the .p8 file contents). Var: APNS_ENV
// ("sandbox" for Xcode dev builds, "production" for TestFlight/App Store).

const PENDING_TTL_MS = 10 * 60 * 1000; // pending requests expire after 10 min
const KEEP_ROWS = 200;                 // keep this many recent requests

function json(data, status = 200) {
  return Response.json(data, { status });
}

function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const ba = enc.encode(a);
  const bb = enc.encode(b);
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
  return diff === 0;
}

export async function handleClaudeApprove(request, env, url) {
  if (!env.APPROVE_SECRET) {
    return json({ error: 'not configured: set APPROVE_SECRET' }, 503);
  }
  const auth = request.headers.get('authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token || !timingSafeEqual(token, env.APPROVE_SECRET)) {
    return json({ error: 'unauthorized' }, 401);
  }
  const subpath = url.pathname.replace(/^\/api\/claude-approve/, '') || '/';
  const stub = env.CLAUDE_APPROVALS.get(env.CLAUDE_APPROVALS.idFromName('hub'));
  return stub.fetch(new Request('https://do' + subpath + url.search, request));
}

export class ClaudeApprovals {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.apnsJwt = null; // {token, issuedAt}
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY,
        tool TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        cwd TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        responded_at INTEGER,
        responded_by TEXT
      );
      CREATE TABLE IF NOT EXISTS devices (
        token TEXT PRIMARY KEY,
        topic TEXT NOT NULL,
        platform TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL DEFAULT '',
        last_seen INTEGER NOT NULL
      );
    `);
  }

  sql(query, ...params) {
    return this.ctx.storage.sql.exec(query, ...params).toArray();
  }

  expireStale() {
    this.sql(
      `UPDATE requests SET status = 'expired' WHERE status = 'pending' AND created_at < ?`,
      Date.now() - PENDING_TTL_MS
    );
    this.sql(
      `DELETE FROM requests WHERE id NOT IN
         (SELECT id FROM requests ORDER BY created_at DESC LIMIT ${KEEP_ROWS})`
    );
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    this.expireStale();

    if (path === '/requests' && method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch {}
      if (!body.tool) return json({ error: 'missing tool' }, 400);
      const id = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
      this.sql(
        `INSERT INTO requests (id, tool, detail, cwd, created_at) VALUES (?, ?, ?, ?, ?)`,
        id, String(body.tool), String(body.detail || ''), String(body.cwd || ''), Date.now()
      );
      const pushed = await this.pushToDevices(id, String(body.tool), String(body.detail || ''));
      return json({ id, pushed });
    }

    if (path === '/requests' && method === 'GET') {
      const status = url.searchParams.get('status') || 'pending';
      const rows = this.sql(
        `SELECT * FROM requests WHERE status = ? ORDER BY created_at DESC LIMIT 50`,
        status
      );
      return json({ requests: rows });
    }

    let m = path.match(/^\/requests\/([a-z0-9]+)$/);
    if (m && method === 'GET') {
      const rows = this.sql(`SELECT * FROM requests WHERE id = ?`, m[1]);
      if (!rows.length) return json({ error: 'not found' }, 404);
      return json(rows[0]);
    }

    m = path.match(/^\/requests\/([a-z0-9]+)\/respond$/);
    if (m && method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch {}
      const decision = body.decision === 'approve' ? 'approved'
                     : body.decision === 'deny' ? 'denied' : null;
      if (!decision) return json({ error: 'decision must be approve or deny' }, 400);
      const rows = this.sql(`SELECT status FROM requests WHERE id = ?`, m[1]);
      if (!rows.length) return json({ error: 'not found' }, 404);
      if (rows[0].status !== 'pending') {
        return json({ error: `already ${rows[0].status}`, status: rows[0].status }, 409);
      }
      this.sql(
        `UPDATE requests SET status = ?, responded_at = ?, responded_by = ? WHERE id = ?`,
        decision, Date.now(), String(body.device || ''), m[1]
      );
      return json({ ok: true, status: decision });
    }

    if (path === '/devices' && method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch {}
      if (!body.token || !body.topic) return json({ error: 'missing token or topic' }, 400);
      this.sql(
        `INSERT INTO devices (token, topic, platform, name, last_seen)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(token) DO UPDATE SET topic = excluded.topic,
           platform = excluded.platform, name = excluded.name, last_seen = excluded.last_seen`,
        String(body.token), String(body.topic), String(body.platform || ''),
        String(body.name || ''), Date.now()
      );
      return json({ ok: true });
    }

    if (path === '/devices' && method === 'GET') {
      const rows = this.sql(`SELECT topic, platform, name, last_seen FROM devices`);
      return json({ devices: rows });
    }

    return json({ error: 'not found' }, 404);
  }

  // ---- APNs ----

  apnsConfigured() {
    return this.env.APNS_TEAM_ID && this.env.APNS_KEY_ID && this.env.APNS_P8;
  }

  async apnsToken() {
    // APNs provider tokens are valid 20-60 min; refresh at 45.
    if (this.apnsJwt && Date.now() - this.apnsJwt.issuedAt < 45 * 60 * 1000) {
      return this.apnsJwt.token;
    }
    const pem = this.env.APNS_P8
      .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '')
      .replace(/\s+/g, '');
    const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
    const key = await crypto.subtle.importKey(
      'pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
    );
    const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const enc = new TextEncoder();
    const header = b64url(enc.encode(JSON.stringify({ alg: 'ES256', kid: this.env.APNS_KEY_ID })));
    const claims = b64url(enc.encode(JSON.stringify({
      iss: this.env.APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000),
    })));
    const signingInput = `${header}.${claims}`;
    const sig = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(signingInput)
    );
    const token = `${signingInput}.${b64url(sig)}`;
    this.apnsJwt = { token, issuedAt: Date.now() };
    return token;
  }

  async pushToDevices(requestId, tool, detail) {
    if (!this.apnsConfigured()) return 0;
    const devices = this.sql(`SELECT token, topic FROM devices`);
    if (!devices.length) return 0;
    const host = (this.env.APNS_ENV || 'production') === 'sandbox'
      ? 'https://api.sandbox.push.apple.com'
      : 'https://api.push.apple.com';
    const jwt = await this.apnsToken();
    const payload = JSON.stringify({
      aps: {
        alert: {
          title: `Claude Code wants to run ${tool}`,
          body: detail.slice(0, 300) || '(no detail)',
        },
        sound: 'default',
        category: 'CLAUDE_APPROVAL',
        'interruption-level': 'time-sensitive',
        'thread-id': 'claude-approve',
      },
      requestId,
    });
    let pushed = 0;
    for (const d of devices) {
      try {
        const res = await fetch(`${host}/3/device/${d.token}`, {
          method: 'POST',
          headers: {
            authorization: `bearer ${jwt}`,
            'apns-topic': d.topic,
            'apns-push-type': 'alert',
            'apns-priority': '10',
            'apns-expiration': String(Math.floor(Date.now() / 1000) + PENDING_TTL_MS / 1000),
          },
          body: payload,
        });
        if (res.ok) pushed++;
        else if (res.status === 410) {
          this.sql(`DELETE FROM devices WHERE token = ?`, d.token);
        } else {
          console.log('apns error', res.status, await res.text());
        }
      } catch (e) {
        console.log('apns fetch failed', String(e));
      }
    }
    return pushed;
  }
}
