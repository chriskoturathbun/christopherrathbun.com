// Clerk session-JWT verification for Cloudflare Workers — dependency-free (Web Crypto + JWKS).

export function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Split a JWT and parse header+payload JSON (NO signature check). Returns null if malformed.
export function decodeJwtParts(token) {
  const parts = (token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])));
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
    return { header, payload, signature: parts[2], signingInput: `${parts[0]}.${parts[1]}` };
  } catch { return null; }
}

let _jwksCache = null, _jwksAt = 0;
async function getJwks(issuer) {
  const now = Date.now();
  if (_jwksCache && now - _jwksAt < 3600_000) return _jwksCache;
  const res = await fetch(`${issuer}/.well-known/jwks.json`);
  if (!res.ok) throw new Error(`jwks ${res.status}`);
  _jwksCache = (await res.json()).keys || [];
  _jwksAt = now;
  return _jwksCache;
}

// Verify a Clerk session JWT. Returns the payload ({sub, ...}) if valid, else null.
export async function verifyClerkJWT(token, env) {
  const issuer = env.CLERK_ISSUER || 'https://clerk.christopherrathbun.com';
  const parsed = decodeJwtParts(token);
  if (!parsed || parsed.header.alg !== 'RS256') return null;
  const { header, payload, signature, signingInput } = parsed;

  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== issuer) return null;
  if (payload.exp && payload.exp < now - 5) return null;
  if (payload.nbf && payload.nbf > now + 5) return null;

  let jwks;
  try { jwks = await getJwks(issuer); } catch { return null; }
  const jwk = jwks.find(k => k.kid === header.kid);
  if (!jwk) return null;

  try {
    const key = await crypto.subtle.importKey('jwk', jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key,
      b64urlToBytes(signature), new TextEncoder().encode(signingInput));
    return valid ? payload : null;
  } catch { return null; }
}

// Look up the user's primary email via Clerk Backend API (uses CLERK_API_KEY already on the worker).
export async function getClerkUserEmail(userId, env) {
  if (!env.CLERK_API_KEY) return null;
  const res = await fetch(`https://api.clerk.com/v1/users/${userId}`, {
    headers: { Authorization: `Bearer ${env.CLERK_API_KEY}` },
  });
  if (!res.ok) return null;
  const u = await res.json();
  const primary = (u.email_addresses || []).find(e => e.id === u.primary_email_address_id) || (u.email_addresses || [])[0];
  return primary?.email_address?.toLowerCase() || null;
}
