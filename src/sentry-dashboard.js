// Sentry dashboard mounted at /sentry on christopherrathbun.com
//
// Auth: custom Google OAuth, gated to a single allowed email.
// Data: server-side Sentry API token (never exposed to the browser).
//
// Required Worker secrets / vars:
//   GOOGLE_CLIENT_ID       (secret)  OAuth client id
//   GOOGLE_CLIENT_SECRET   (secret)  OAuth client secret
//   SESSION_SECRET         (secret)  random string, signs session cookies
//   SENTRY_API_TOKEN       (secret)  read token (org:read, project:read, event:read)
//   SENTRY_ORG             (var)     org slug, defaults to lilac-impact-ventures-llc
//   ALLOWED_EMAIL          (var)     defaults to rathbunchristopher18@gmail.com

const DEFAULT_ORG = 'lilac-impact-ventures-llc';
const DEFAULT_EMAIL = 'rathbunchristopher18@gmail.com';
const SENTRY_API = 'https://sentry.io/api/0';
const SESSION_COOKIE = 'rb_sentry_sess';
const SESSION_TTL = 60 * 60 * 12; // 12h

// Map our Sentry project slugs -> the repo a fix lives in (helps the chat message).
const PROJECT_REPOS = {
  'buildanagent': 'buildanagent (buildanagent.org)',
  'envoi-work': 'envoi.work',
  'corporateexperiences': 'corporate-experiences (corporateexperiences.us)',
  'couch-director': 'couchdirector (couchdirector.com)',
  'rathbuntax': 'tax-write-off-finder (rathbuntax.com)',
  'giftanagent': 'giftagent-web (giftanagent.com)',
  'clawbackx': 'agent-deals (clawbackx)',
  'christopherrathbun': 'christopherrathbun-landing (christopherrathbun.com)',
};

// ---------- small crypto helpers (Web Crypto, available in Workers) ----------

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64urlEncode(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  );
}
async function sign(secret, data) {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return b64urlEncode(new Uint8Array(sig));
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function makeSession(secret, email) {
  const payload = b64urlEncode(enc.encode(JSON.stringify({
    email, exp: Math.floor(Date.now() / 1000) + SESSION_TTL,
  })));
  const sig = await sign(secret, payload);
  return `${payload}.${sig}`;
}
async function readSession(secret, cookieVal) {
  if (!cookieVal || !cookieVal.includes('.')) return null;
  const [payload, sig] = cookieVal.split('.');
  const expected = await sign(secret, payload);
  if (!timingSafeEqual(sig, expected)) return null;
  try {
    const data = JSON.parse(dec.decode(b64urlDecode(payload)));
    if (!data.exp || data.exp < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch { return null; }
}

function getCookie(request, name) {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(/;\s*/)) {
    const idx = part.indexOf('=');
    if (idx > -1 && part.slice(0, idx) === name) return decodeURIComponent(part.slice(idx + 1));
  }
  return null;
}

// random state for OAuth CSRF, also signed so we can verify on callback
async function makeState(secret) {
  const nonce = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
  const sig = await sign(secret, nonce);
  return `${nonce}.${sig}`;
}
async function checkState(secret, state) {
  if (!state || !state.includes('.')) return false;
  const [nonce, sig] = state.split('.');
  return timingSafeEqual(sig, await sign(secret, nonce));
}

// ---------- Sentry data ----------

async function sentryFetch(env, path) {
  const res = await fetch(`${SENTRY_API}${path}`, {
    headers: { Authorization: `Bearer ${env.SENTRY_API_TOKEN}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Sentry ${res.status} on ${path}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function getProjects(env, org) {
  const list = await sentryFetch(env, `/organizations/${org}/projects/`);
  // Only the live-site projects we instrument; ignore stray ones.
  const wanted = Object.keys(PROJECT_REPOS);
  return list.filter(p => wanted.includes(p.slug))
             .sort((a, b) => a.slug.localeCompare(b.slug));
}

async function getIssues(env, org, projectId) {
  const q = new URLSearchParams({
    project: String(projectId),
    query: 'is:unresolved',
    statsPeriod: '14d',
    sort: 'freq',
    limit: '8',
  });
  try {
    return await sentryFetch(env, `/organizations/${org}/issues/?${q}`);
  } catch {
    return [];
  }
}

// Heuristic: turn an issue into a recommended action.
function suggestAction(issue) {
  const t = `${issue.title || ''} ${issue.culprit || ''}`.toLowerCase();
  if (/chunkload|loading chunk|failed to fetch dynamically imported/.test(t))
    return 'Stale-deploy/cache issue — redeploy and add asset versioning; safe to ignore if transient.';
  if (/cannot read propert|undefined is not|null is not an object|reading '/.test(t))
    return 'Null/undefined access — add an optional-chain or guard at the culprit before use.';
  if (/hydrat/.test(t))
    return 'React hydration mismatch — make server and client render identical markup (no Date/random in render).';
  if (/network|fetch failed|failed to fetch|timeout|econn/.test(t))
    return 'Upstream/API call failing — wrap in try/catch, add a retry + user-facing fallback.';
  if (/\b(4\d\d|5\d\d)\b|http error|status code/.test(t))
    return 'API returning error status — inspect the route/handler and validate inputs.';
  if (/permission|unauthor|forbidden|401|403/.test(t))
    return 'Auth/permission failure — check token/session handling on this path.';
  return 'Investigate the stack trace at the culprit, reproduce locally, add handling + a test.';
}

function fixMessage(projectSlug, issue) {
  const repo = PROJECT_REPOS[projectSlug] || projectSlug;
  const count = issue.count || issue.metadata?.count || '?';
  return `Fix this Sentry error in ${repo}. ` +
    `Issue: "${issue.title}" (level: ${issue.level || 'error'}, ~${count} events in 14d). ` +
    `Culprit: ${issue.culprit || 'n/a'}. ` +
    `Sentry: ${issue.permalink || ''}. ` +
    `Please reproduce, find the root cause in the repo, fix it, verify the build, and resolve the issue in Sentry.`;
}

// ---------- HTML ----------

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function timeAgo(iso) {
  if (!iso) return '';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function levelColor(level) {
  return { fatal: '#7f1d1d', error: '#b91c1c', warning: '#b45309', info: '#1d4ed8', debug: '#475569' }[level] || '#b91c1c';
}

function loginPage(msg, methods = { google: false, passcode: false }) {
  const googleBtn = methods.google ? `
  <a class="btn" href="/sentry/login">
    <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.8-6.8C35.6 2.4 30.2 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.2C12.4 13.3 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.6c0-1.6-.1-3.1-.4-4.6H24v9.1h12.4c-.5 2.9-2.1 5.3-4.6 7l7.1 5.5c4.2-3.9 6.6-9.6 6.6-16.4z"/><path fill="#FBBC05" d="M10.5 28.6c-.5-1.5-.8-3-.8-4.6s.3-3.1.8-4.6l-7.9-6.2C1 16.5 0 20.1 0 24s1 7.5 2.6 10.8l7.9-6.2z"/><path fill="#34A853" d="M24 48c6.2 0 11.5-2 15.3-5.5l-7.1-5.5c-2 1.3-4.6 2.1-8.2 2.1-6.3 0-11.6-3.8-13.5-9.2l-7.9 6.2C6.5 42.6 14.6 48 24 48z"/></svg>
    Continue with Google
  </a>` : '';
  const divider = (methods.google && methods.passcode) ? `<div class="div"><span>or</span></div>` : '';
  const passcodeForm = methods.passcode ? `
  <form method="POST" action="/sentry/passcode" class="pc">
    <input type="password" name="passcode" placeholder="Enter passcode" autocomplete="current-password" autofocus required>
    <button type="submit">Unlock dashboard</button>
  </form>` : '';
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sentry Dashboard · Sign in</title>
<style>
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0f1117;color:#e5e7eb;display:grid;place-items:center;height:100vh}
  .card{background:#181b23;border:1px solid #262b36;border-radius:16px;padding:40px;max-width:340px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.4)}
  h1{font-size:20px;margin:0 0 6px} p{color:#9ca3af;font-size:14px;margin:0 0 24px}
  a.btn{display:inline-flex;align-items:center;gap:10px;background:#fff;color:#1f2937;font-weight:600;text-decoration:none;padding:12px 20px;border-radius:10px;font-size:14px}
  .err{color:#f87171;font-size:13px;margin-top:16px}
  .logo{width:44px;height:44px;margin:0 auto 16px;display:block}
  .div{display:flex;align-items:center;gap:10px;color:#4b5563;font-size:12px;margin:18px 0}
  .div::before,.div::after{content:"";flex:1;height:1px;background:#262b36}
  form.pc{display:flex;flex-direction:column;gap:10px}
  form.pc input{background:#0f1117;border:1px solid #262b36;border-radius:10px;padding:12px 14px;color:#e5e7eb;font-size:14px;text-align:center}
  form.pc input:focus{outline:none;border-color:#8b5cf6}
  form.pc button{background:#8b5cf6;color:#fff;border:none;border-radius:10px;padding:12px;font-size:14px;font-weight:600;cursor:pointer}
  form.pc button:hover{background:#7c3aed}
</style></head><body>
<div class="card">
  <svg class="logo" viewBox="0 0 72 66" fill="#8b5cf6" xmlns="http://www.w3.org/2000/svg"><path d="M29 2.26a4.67 4.67 0 0 0-8 0L1.44 36.06a4.67 4.67 0 0 0 4 7h6.18a32.5 32.5 0 0 0-6.49-19.3l5.43-9.4a43.5 43.5 0 0 1 9.7 28.7h8.62a52 52 0 0 0-13.3-37.3l3.86-6.68a60 60 0 0 1 17.05 44h6.16a4.67 4.67 0 0 0 4-7Z"/></svg>
  <h1>Sentry Error Dashboard</h1>
  <p>Private — authorized access only.</p>
  ${googleBtn}${divider}${passcodeForm}
  ${msg ? `<div class="err">${esc(msg)}</div>` : ''}
</div></body></html>`;
}

function setupNeededPage(missing) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Setup needed</title>
<style>body{font-family:ui-monospace,Menlo,monospace;background:#0f1117;color:#e5e7eb;padding:40px;line-height:1.6}
code{background:#181b23;padding:2px 6px;border-radius:4px;color:#a78bfa}</style></head><body>
<h2>⚙️ Dashboard not configured yet</h2>
<p>Missing Worker secrets/vars: ${missing.map(m => `<code>${esc(m)}</code>`).join(', ')}</p>
<p>Set them with <code>wrangler secret put NAME</code> (secrets) or in <code>wrangler.toml</code> [vars] (vars), then redeploy.</p>
</body></html>`;
}

function dashboardPage(org, email, projects) {
  const totalIssues = projects.reduce((n, p) => n + p.issues.length, 0);
  const cards = projects.map(p => {
    const rows = p.issues.length === 0
      ? `<div class="empty">No unresolved issues in the last 14 days 🎉</div>`
      : p.issues.map(iss => {
          const msg = fixMessage(p.slug, iss);
          return `<div class="issue">
            <div class="issue-head">
              <span class="lvl" style="background:${levelColor(iss.level)}">${esc(iss.level || 'error')}</span>
              <a class="title" href="${esc(iss.permalink)}" target="_blank" rel="noopener">${esc(iss.title)}</a>
            </div>
            <div class="meta">
              <span>${esc(iss.culprit || '')}</span>
              <span class="dot">·</span><span>${esc(iss.count || '?')} events</span>
              <span class="dot">·</span><span>${esc(timeAgo(iss.lastSeen))}</span>
            </div>
            <div class="action">→ ${esc(suggestAction(iss))}</div>
            <button class="copy" data-msg="${esc(msg)}">📋 Copy fix message for chat</button>
          </div>`;
        }).join('');
    return `<section class="card">
      <header class="card-head">
        <h2>${esc(p.slug)}</h2>
        <span class="repo">${esc(PROJECT_REPOS[p.slug] || '')}</span>
        <span class="badge ${p.issues.length ? 'bad' : 'ok'}">${p.issues.length} open</span>
      </header>
      ${rows}
    </section>`;
  }).join('');

  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sentry Dashboard</title>
<style>
  :root{--bg:#0f1117;--panel:#181b23;--border:#262b36;--mut:#9ca3af;--txt:#e5e7eb;--acc:#8b5cf6}
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--txt)}
  header.top{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:14px;padding:16px 28px;background:rgba(15,17,23,.9);backdrop-filter:blur(8px);border-bottom:1px solid var(--border)}
  header.top h1{font-size:17px;margin:0;font-weight:700}
  .spacer{flex:1}
  .who{font-size:13px;color:var(--mut)}
  .who a{color:var(--acc);text-decoration:none;margin-left:14px}
  .summary{padding:20px 28px;color:var(--mut);font-size:14px}
  .summary b{color:var(--txt)}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(380px,1fr));gap:18px;padding:0 28px 60px}
  .card{background:var(--panel);border:1px solid var(--border);border-radius:14px;overflow:hidden}
  .card-head{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--border)}
  .card-head h2{font-size:15px;margin:0;font-weight:700}
  .card-head .repo{font-size:11px;color:var(--mut);flex:1}
  .badge{font-size:11px;font-weight:600;padding:3px 9px;border-radius:20px}
  .badge.ok{background:#064e3b;color:#6ee7b7}.badge.bad{background:#7f1d1d;color:#fca5a5}
  .issue{padding:12px 16px;border-bottom:1px solid #20242e}
  .issue:last-child{border-bottom:none}
  .issue-head{display:flex;align-items:center;gap:8px}
  .lvl{font-size:10px;text-transform:uppercase;font-weight:700;color:#fff;padding:2px 7px;border-radius:5px;letter-spacing:.04em}
  a.title{color:var(--txt);font-weight:600;font-size:13.5px;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  a.title:hover{color:var(--acc)}
  .meta{font-size:12px;color:var(--mut);margin:5px 0 6px;display:flex;gap:6px;flex-wrap:wrap}.dot{opacity:.5}
  .action{font-size:12.5px;color:#c4b5fd;margin-bottom:8px}
  .copy{background:#23262f;color:#e5e7eb;border:1px solid var(--border);border-radius:7px;padding:6px 10px;font-size:12px;cursor:pointer}
  .copy:hover{background:#2c303b}.copy.done{background:#064e3b;color:#6ee7b7;border-color:#065f46}
  .empty{padding:16px;color:#6ee7b7;font-size:13px}
</style></head><body>
<header class="top">
  <svg width="22" height="20" viewBox="0 0 72 66" fill="#8b5cf6"><path d="M29 2.26a4.67 4.67 0 0 0-8 0L1.44 36.06a4.67 4.67 0 0 0 4 7h6.18a32.5 32.5 0 0 0-6.49-19.3l5.43-9.4a43.5 43.5 0 0 1 9.7 28.7h8.62a52 52 0 0 0-13.3-37.3l3.86-6.68a60 60 0 0 1 17.05 44h6.16a4.67 4.67 0 0 0 4-7Z"/></svg>
  <h1>Sentry Error Dashboard</h1>
  <div class="spacer"></div>
  <span class="who">${esc(email)}<a href="/sentry/logout">Sign out</a></span>
</header>
<div class="summary">
  Tracking <b>${projects.length}</b> projects in <b>${esc(org)}</b> ·
  <b>${totalIssues}</b> unresolved issues (last 14 days).
  ${totalIssues === 0 ? 'Everything is healthy. ✅' : 'Click <b>Copy fix message</b> on any issue and paste it into Claude to fix it.'}
</div>
<div class="grid">${cards}</div>
<script>
  document.querySelectorAll('.copy').forEach(btn => {
    btn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(btn.dataset.msg); }
      catch { const t=document.createElement('textarea');t.value=btn.dataset.msg;document.body.appendChild(t);t.select();document.execCommand('copy');t.remove(); }
      const old = btn.textContent; btn.textContent = '✓ Copied — paste into chat'; btn.classList.add('done');
      setTimeout(() => { btn.textContent = old; btn.classList.remove('done'); }, 1800);
    });
  });
</script>
</body></html>`;
}

function html(body, status = 200) {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}
function redirect(location, headers = {}) {
  return new Response(null, { status: 302, headers: { Location: location, ...headers } });
}

// ---------- main handler ----------

export async function handleSentry(request, env, url) {
  const org = env.SENTRY_ORG || DEFAULT_ORG;
  const allowedEmail = (env.ALLOWED_EMAIL || DEFAULT_EMAIL).toLowerCase();
  const path = url.pathname;
  const redirectUri = `${url.origin}/sentry/callback`;

  // auth methods available
  const haveGoogle = !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  const havePasscode = !!env.DASHBOARD_PASSCODE;
  const methods = { google: haveGoogle, passcode: havePasscode };

  // config guard — need session signing, a data token, and at least one auth method
  const missing = [];
  if (!env.SESSION_SECRET) missing.push('SESSION_SECRET');
  if (!env.SENTRY_API_TOKEN) missing.push('SENTRY_API_TOKEN');
  if (!haveGoogle && !havePasscode) missing.push('an auth method (DASHBOARD_PASSCODE, or GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET)');
  if (missing.length && path !== '/sentry/callback') {
    return html(setupNeededPage(missing), 503);
  }

  // ---- Passcode login (self-contained, no external provider) ----
  if (path === '/sentry/passcode' && request.method === 'POST') {
    if (!havePasscode) return html(loginPage('Passcode login is not enabled.', methods), 400);
    const form = await request.formData().catch(() => null);
    const input = form && form.get('passcode');
    // timing-safe compare via HMAC (equalizes length, hides the real passcode length)
    const ok = input != null &&
      timingSafeEqual(await sign(env.SESSION_SECRET, String(input)),
                      await sign(env.SESSION_SECRET, env.DASHBOARD_PASSCODE));
    if (!ok) return html(loginPage('Incorrect passcode.', methods), 401);
    const sess = await makeSession(env.SESSION_SECRET, allowedEmail);
    return redirect(`${url.origin}/sentry`, {
      'Set-Cookie': `${SESSION_COOKIE}=${sess}; HttpOnly; Secure; SameSite=Lax; Path=/sentry; Max-Age=${SESSION_TTL}`,
    });
  }

  if (path === '/sentry/login' && !haveGoogle) {
    return html(loginPage('', methods), 200);
  }

  // ---- OAuth: start ----
  if (path === '/sentry/login') {
    const state = await makeState(env.SESSION_SECRET);
    const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    auth.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
    auth.searchParams.set('redirect_uri', redirectUri);
    auth.searchParams.set('response_type', 'code');
    auth.searchParams.set('scope', 'openid email profile');
    auth.searchParams.set('state', state);
    auth.searchParams.set('prompt', 'select_account');
    return redirect(auth.toString(), {
      'Set-Cookie': `rb_oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/sentry; Max-Age=600`,
    });
  }

  // ---- OAuth: callback ----
  if (path === '/sentry/callback') {
    if (missing.length) return html(setupNeededPage(missing), 503);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const cookieState = getCookie(request, 'rb_oauth_state');
    if (!code || !state || state !== cookieState || !(await checkState(env.SESSION_SECRET, state))) {
      return html(loginPage('Login session expired or invalid. Please try again.'), 400);
    }
    // exchange code
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri, grant_type: 'authorization_code',
      }),
    });
    if (!tokenRes.ok) return html(loginPage('Google token exchange failed.'), 502);
    const tokens = await tokenRes.json();
    // id_token came directly from Google over TLS; decode its payload.
    let claims;
    try { claims = JSON.parse(dec.decode(b64urlDecode(tokens.id_token.split('.')[1]))); }
    catch { return html(loginPage('Could not read Google identity.'), 502); }
    const email = (claims.email || '').toLowerCase();
    if (claims.aud !== env.GOOGLE_CLIENT_ID || !claims.email_verified || email !== allowedEmail) {
      return html(loginPage(`Access denied for ${esc(claims.email || 'unknown')}. This dashboard is private.`), 403);
    }
    const sess = await makeSession(env.SESSION_SECRET, email);
    return redirect(`${url.origin}/sentry`, {
      'Set-Cookie': `${SESSION_COOKIE}=${sess}; HttpOnly; Secure; SameSite=Lax; Path=/sentry; Max-Age=${SESSION_TTL}`,
    });
  }

  // ---- logout ----
  if (path === '/sentry/logout') {
    return redirect(`${url.origin}/sentry`, {
      'Set-Cookie': `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/sentry; Max-Age=0`,
    });
  }

  // ---- everything else under /sentry requires a session ----
  const sess = await readSession(env.SESSION_SECRET, getCookie(request, SESSION_COOKIE));
  if (!sess || sess.email.toLowerCase() !== allowedEmail) {
    return html(loginPage('', methods), 200);
  }

  // ---- JSON API (optional, same-origin) ----
  if (path === '/sentry/api/issues') {
    try {
      const projects = await getProjects(env, org);
      const withIssues = await Promise.all(projects.map(async p => ({
        slug: p.slug, issues: await getIssues(env, org, p.id),
      })));
      return Response.json({ org, projects: withIssues });
    } catch (e) {
      return Response.json({ error: String(e.message || e) }, { status: 502 });
    }
  }

  // ---- dashboard ----
  try {
    const projects = await getProjects(env, org);
    const withIssues = await Promise.all(projects.map(async p => {
      const issues = await getIssues(env, org, p.id);
      return { slug: p.slug, id: p.id, issues };
    }));
    return html(dashboardPage(org, sess.email, withIssues));
  } catch (e) {
    return html(`<!doctype html><body style="font-family:monospace;background:#0f1117;color:#f87171;padding:40px">
      <h2>Failed to load Sentry data</h2><pre>${esc(e.message || e)}</pre>
      <p style="color:#9ca3af">Check that <code>SENTRY_API_TOKEN</code> has org:read, project:read, event:read.</p>
      </body>`, 502);
  }
}
