// Claude Code approval bridge — multi-tenant backend for the ClaudeApprove
// iPhone/Watch app. Anyone can use the app; each user pairs their Mac(s) to
// their account with a short-lived code shown in the app. No shared secrets,
// no per-user deploys.
//
// Flow:
//   app:  POST /pair/new            -> creates account, returns token + code
//   mac:  POST /pair/claim {code}   -> returns the account token (single-use)
//   hook: POST /requests            -> APNs push to the account's devices
//   app:  POST /requests/:id/respond
//   hook: GET  /requests/:id?wait=1 -> long-poll, resolves instantly on tap
//
// All routes under /api/claude-approve. Auth: Authorization: Bearer <token>
// (account tokens, format "ca_<48 hex>"), except /pair/new and /pair/claim.
//
// Secrets (wrangler secret put ...): APNS_TEAM_ID, APNS_KEY_ID, APNS_P8.
// Var: APNS_ENV ("sandbox" for Xcode builds, "production" for App Store).

const PENDING_TTL_MS = 10 * 60 * 1000;   // pending requests expire after 10 min
const PAIR_CODE_TTL_MS = 10 * 60 * 1000; // pairing codes live 10 min
const KEEP_ROWS = 5000;                  // backstop cap on resolved/expired rows
const RESOLVED_TTL_MS = 7 * 24 * 60 * 60 * 1000; // keep resolved requests 7 days
const SWEEP_INTERVAL_MS = 60 * 1000;     // run housekeeping at most once a minute
const MAX_PENDING_PER_ACCOUNT = 20;
const PAIR_RATE_WINDOW_MS = 60 * 60 * 1000; // /pair/new: per-IP window
const PAIR_RATE_MAX = 20;                   // ...max new accounts per window
const UNPAIRED_ACCOUNT_TTL_MS = 24 * 60 * 60 * 1000; // prune never-paired accounts
// Unambiguous alphabet for pairing codes (no 0/O/1/I/L).
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function json(data, status = 200) {
  return Response.json(data, { status });
}

function randomToken() {
  const buf = new Uint8Array(24);
  crypto.getRandomValues(buf);
  return 'ca_' + [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomPairCode() {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  const chars = [...buf].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]);
  return chars.slice(0, 4).join('') + '-' + chars.slice(4).join('');
}

export async function handleClaudeApprove(request, env, url) {
  const subpath = url.pathname.replace(/^\/api\/claude-approve/, '') || '/';
  const stub = env.CLAUDE_APPROVALS.get(env.CLAUDE_APPROVALS.idFromName('hub'));
  return stub.fetch(new Request('https://do' + subpath + url.search, request));
}

export class ClaudeApprovals {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.apnsJwt = null;      // {token, issuedAt}
    this.waiters = new Map(); // request id -> [resolve, ...] for long-polls
    this.lastSweep = 0;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        token TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pair_codes (
        code TEXT PRIMARY KEY,
        account_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pair_rate (
        ip TEXT PRIMARY KEY,
        window_start INTEGER NOT NULL,
        count INTEGER NOT NULL
      );
      -- Keyed by (account, token): a device token registered by two accounts
      -- gets two rows, so no account can steal or delete another's channel.
      CREATE TABLE IF NOT EXISTS devices (
        account_token TEXT NOT NULL,
        token TEXT NOT NULL,
        topic TEXT NOT NULL,
        platform TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL DEFAULT '',
        env TEXT NOT NULL DEFAULT '',
        last_seen INTEGER NOT NULL,
        PRIMARY KEY (account_token, token)
      );
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY,
        account_token TEXT NOT NULL,
        tool TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        cwd TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        responded_at INTEGER,
        responded_by TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_requests_account
        ON requests (account_token, status, created_at);
    `);
  }

  sql(query, ...params) {
    return this.ctx.storage.sql.exec(query, ...params).toArray();
  }

  expireStale() {
    const now = Date.now();
    if (now - this.lastSweep < SWEEP_INTERVAL_MS) return;
    this.lastSweep = now;
    this.sql(
      `UPDATE requests SET status = 'expired' WHERE status = 'pending' AND created_at < ?`,
      now - PENDING_TTL_MS
    );
    this.sql(`DELETE FROM pair_codes WHERE expires_at < ?`, now);
    this.sql(`DELETE FROM pair_rate WHERE window_start < ?`, now - 2 * PAIR_RATE_WINDOW_MS);
    // Retention only ever touches resolved/expired rows — a pending request
    // can never be swept out from under a tenant's long-poll.
    this.sql(
      `DELETE FROM requests WHERE status != 'pending' AND created_at < ?`,
      now - RESOLVED_TTL_MS
    );
    this.sql(
      `DELETE FROM requests WHERE status != 'pending' AND id NOT IN
         (SELECT id FROM requests ORDER BY created_at DESC LIMIT ${KEEP_ROWS})`
    );
    // Accounts that never paired a device and have gone idle.
    this.sql(
      `DELETE FROM accounts WHERE last_seen < ?
         AND token NOT IN (SELECT DISTINCT account_token FROM devices)`,
      now - UNPAIRED_ACCOUNT_TTL_MS
    );
  }

  account(request) {
    const auth = request.headers.get('authorization') || '';
    const token = auth.replace(/^Bearer\s+/i, '');
    if (!/^ca_[0-9a-f]{48}$/.test(token)) return null;
    const rows = this.sql(`SELECT token FROM accounts WHERE token = ?`, token);
    if (!rows.length) return null;
    this.sql(`UPDATE accounts SET last_seen = ? WHERE token = ?`, Date.now(), token);
    return token;
  }

  issuePairCode(accountToken) {
    const code = randomPairCode();
    this.sql(
      `INSERT INTO pair_codes (code, account_token, expires_at) VALUES (?, ?, ?)`,
      code, accountToken, Date.now() + PAIR_CODE_TTL_MS
    );
    return { pair_code: code, expires_in_seconds: PAIR_CODE_TTL_MS / 1000 };
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    this.expireStale();

    // ---- pairing (no auth) ----

    if (path === '/pair/new' && method === 'POST') {
      // Rate-limit anonymous account creation per client IP.
      const ip = request.headers.get('cf-connecting-ip') || 'unknown';
      const now = Date.now();
      const rate = this.sql(`SELECT window_start, count FROM pair_rate WHERE ip = ?`, ip);
      if (rate.length && now - rate[0].window_start < PAIR_RATE_WINDOW_MS) {
        if (rate[0].count >= PAIR_RATE_MAX) {
          return json({ error: 'rate limited — try again later' }, 429);
        }
        this.sql(`UPDATE pair_rate SET count = count + 1 WHERE ip = ?`, ip);
      } else {
        this.sql(
          `INSERT INTO pair_rate (ip, window_start, count) VALUES (?, ?, 1)
           ON CONFLICT(ip) DO UPDATE SET window_start = excluded.window_start, count = 1`,
          ip, now
        );
      }
      const token = randomToken();
      this.sql(
        `INSERT INTO accounts (token, created_at, last_seen) VALUES (?, ?, ?)`,
        token, now, now
      );
      return json({ account_token: token, ...this.issuePairCode(token) });
    }

    if (path === '/pair/claim' && method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch {}
      const code = String(body.code || '').toUpperCase().replace(/[^A-Z2-9]/g, '');
      const formatted = code.length === 8 ? code.slice(0, 4) + '-' + code.slice(4) : code;
      const rows = this.sql(
        `SELECT account_token FROM pair_codes WHERE code = ? AND expires_at > ?`,
        formatted, Date.now()
      );
      if (!rows.length) return json({ error: 'invalid or expired code' }, 404);
      this.sql(`DELETE FROM pair_codes WHERE code = ?`, formatted); // single-use
      return json({ account_token: rows[0].account_token });
    }

    // ---- everything below requires an account token ----

    const account = this.account(request);
    if (!account) return json({ error: 'unauthorized' }, 401);

    if (path === '/pair/code' && method === 'POST') {
      return json(this.issuePairCode(account));
    }

    if (path === '/devices' && method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch {}
      if (!body.token || !body.topic) return json({ error: 'missing token or topic' }, 400);
      const env = body.env === 'sandbox' ? 'sandbox'
                : body.env === 'production' ? 'production' : '';
      this.sql(
        `INSERT INTO devices (account_token, token, topic, platform, name, env, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_token, token) DO UPDATE SET
           topic = excluded.topic, platform = excluded.platform,
           name = excluded.name, env = excluded.env, last_seen = excluded.last_seen`,
        account, String(body.token), String(body.topic),
        String(body.platform || ''), String(body.name || ''), env, Date.now()
      );
      return json({ ok: true });
    }

    if (path === '/devices' && method === 'GET') {
      const rows = this.sql(
        `SELECT topic, platform, name, env, last_seen FROM devices WHERE account_token = ?`,
        account
      );
      return json({ devices: rows });
    }

    if (path === '/requests' && method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch {}
      if (!body.tool) return json({ error: 'missing tool' }, 400);
      const pending = this.sql(
        `SELECT COUNT(*) AS n FROM requests WHERE account_token = ? AND status = 'pending'`,
        account
      )[0].n;
      if (pending >= MAX_PENDING_PER_ACCOUNT) {
        return json({ error: 'too many pending requests' }, 429);
      }
      const id = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
      this.sql(
        `INSERT INTO requests (id, account_token, tool, detail, cwd, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        id, account, String(body.tool), String(body.detail || ''),
        String(body.cwd || ''), Date.now()
      );
      const pushed = await this.pushToDevices(account, id, String(body.tool),
                                              String(body.detail || ''));
      return json({ id, pushed });
    }

    if (path === '/requests' && method === 'GET') {
      const status = url.searchParams.get('status') || 'pending';
      const rows = this.sql(
        `SELECT id, tool, detail, cwd, status, created_at, responded_at, responded_by
         FROM requests WHERE account_token = ? AND status = ?
         ORDER BY created_at DESC LIMIT 50`,
        account, status
      );
      return json({ requests: rows });
    }

    let m = path.match(/^\/requests\/([a-z0-9]+)$/);
    if (m && method === 'GET') {
      const load = () => this.sql(
        `SELECT id, tool, detail, cwd, status, created_at, responded_at, responded_by
         FROM requests WHERE id = ? AND account_token = ?`,
        m[1], account
      );
      let rows = load();
      if (!rows.length) return json({ error: 'not found' }, 404);
      // Long-poll: hold until the decision arrives (or ~25s), so the hook
      // unblocks the instant the user taps Approve.
      if (url.searchParams.get('wait') === '1' && rows[0].status === 'pending') {
        const id = m[1];
        await new Promise((resolve) => {
          const waiter = () => { clearTimeout(timer); resolve(); };
          // On timeout, remove this waiter so abandoned polls don't leak.
          const timer = setTimeout(() => {
            const list = this.waiters.get(id) || [];
            const i = list.indexOf(waiter);
            if (i !== -1) list.splice(i, 1);
            if (!list.length) this.waiters.delete(id);
            resolve();
          }, 25000);
          const list = this.waiters.get(id) || [];
          list.push(waiter);
          this.waiters.set(id, list);
        });
        rows = load();
        if (!rows.length) return json({ error: 'not found' }, 404);
      }
      return json(rows[0]);
    }

    m = path.match(/^\/requests\/([a-z0-9]+)\/respond$/);
    if (m && method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch {}
      const decision = body.decision === 'approve' ? 'approved'
                     : body.decision === 'deny' ? 'denied' : null;
      if (!decision) return json({ error: 'decision must be approve or deny' }, 400);
      const rows = this.sql(
        `SELECT status FROM requests WHERE id = ? AND account_token = ?`,
        m[1], account
      );
      if (!rows.length) return json({ error: 'not found' }, 404);
      if (rows[0].status !== 'pending') {
        return json({ error: `already ${rows[0].status}`, status: rows[0].status }, 409);
      }
      this.sql(
        `UPDATE requests SET status = ?, responded_at = ?, responded_by = ?
         WHERE id = ? AND account_token = ?`,
        decision, Date.now(), String(body.device || ''), m[1], account
      );
      for (const waiter of this.waiters.get(m[1]) || []) waiter();
      this.waiters.delete(m[1]);
      return json({ ok: true, status: decision });
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
    const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
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

  async pushToDevices(account, requestId, tool, detail) {
    if (!this.apnsConfigured()) return 0;
    const devices = this.sql(
      `SELECT token, topic, env FROM devices WHERE account_token = ?`, account
    );
    if (!devices.length) return 0;
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
    const results = await Promise.allSettled(
      devices.map((d) => this.pushOne(account, d, jwt, payload))
    );
    return results.filter((r) => r.status === 'fulfilled' && r.value).length;
  }

  async pushOne(account, device, jwt, payload) {
    // Each device registers with the APNs environment its own build uses
    // (Xcode = sandbox, TestFlight/App Store = production), so a mixed fleet
    // works; APNS_ENV is only the fallback for rows that didn't report one.
    const env = device.env || this.env.APNS_ENV || 'production';
    const host = env === 'sandbox'
      ? 'https://api.sandbox.push.apple.com'
      : 'https://api.push.apple.com';
    try {
      const res = await fetch(`${host}/3/device/${device.token}`, {
        method: 'POST',
        headers: {
          authorization: `bearer ${jwt}`,
          'apns-topic': device.topic,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'apns-expiration': String(Math.floor(Date.now() / 1000) + PENDING_TTL_MS / 1000),
        },
        body: payload,
      });
      if (res.ok) return true;
      if (res.status === 410) {
        this.sql(
          `DELETE FROM devices WHERE account_token = ? AND token = ?`,
          account, device.token
        );
      } else {
        console.log('apns error', res.status, await res.text());
      }
    } catch (e) {
      console.log('apns fetch failed', String(e));
    }
    return false;
  }
}
