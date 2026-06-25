export { TwistedChessGame } from './twisted-chess-do.js';
import { handleSentry } from './sentry-dashboard.js';
import { handleVighnaa } from './vighnaa.js';
import { handleUsers } from './users-dashboard.js';
import { handleReminders } from './reminders.js';

function newGameId() {
  // short, URL-friendly id
  const a = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  for (const b of buf) s += a[b % a.length];
  return s;
}

// Fetch a static asset, following the assets server's trailing-slash /
// index.html redirects so we return the actual 200 HTML content.
async function fetchAssetFollow(env, origin, path) {
  let target = new URL(path, origin);
  for (let i = 0; i < 3; i++) {
    const res = await env.ASSETS.fetch(new Request(target.toString()));
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      target = new URL(loc, origin);
      continue;
    }
    return res;
  }
  return env.ASSETS.fetch(new Request(target.toString()));
}

async function handleTwistedChess(request, env, url) {
  const path = url.pathname;

  // Create a new game room.
  if (path === '/twistedchess/api/new' && request.method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch {}
    const gameId = newGameId();
    const stub = env.TWISTED_CHESS.get(env.TWISTED_CHESS.idFromName(gameId));
    const res = await stub.fetch('https://do/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseMinutes: body.baseMinutes,
        incrementSeconds: body.incrementSeconds,
        creatorId: body.creatorId,
        creatorName: body.creatorName,
      }),
    });
    if (!res.ok) return new Response('failed to create game', { status: 500 });
    return Response.json({ gameId });
  }

  // WebSocket connection to a game room.
  if (path === '/twistedchess/ws') {
    const gameId = url.searchParams.get('g');
    if (!gameId) return new Response('missing game id', { status: 400 });
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    const stub = env.TWISTED_CHESS.get(env.TWISTED_CHESS.idFromName(gameId));
    return stub.fetch(request);
  }

  // Does a game exist? (used by the client before connecting)
  if (path === '/twistedchess/api/exists') {
    const gameId = url.searchParams.get('g');
    if (!gameId) return Response.json({ exists: false });
    const stub = env.TWISTED_CHESS.get(env.TWISTED_CHESS.idFromName(gameId));
    const res = await stub.fetch('https://do/exists');
    return new Response(await res.text(), {
      headers: { 'content-type': 'application/json' },
    });
  }

  // Serve the game app for /twistedchess and any sub-path (invite links).
  const res = await fetchAssetFollow(env, url.origin, '/twistedchess/index.html');
  return new Response(res.body, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Canonical redirect: www → non-www
    if (url.hostname === 'www.christopherrathbun.com') {
      url.hostname = 'christopherrathbun.com';
      return Response.redirect(url.toString(), 301);
    }

    // Users dashboard (Clerk-authenticated)
    if (path === '/users' || path === '/users/' || path.startsWith('/users/') || path === '/api/users' || path.startsWith('/api/users/')) {
      return handleUsers(request, env, url);
    }

    // Reminders — AI medication-reminder calls
    if (path === '/reminders' || path === '/reminders/' || path.startsWith('/reminders/')) {
      return handleReminders(request, env, url);
    }

    // Sentry error dashboard (private, Google-auth gated)
    if (path === '/sentry' || path === '/sentry/' || path.startsWith('/sentry/')) {
      return handleSentry(request, env, url);
    }

    // Vighnaa Text LLM (fun text-style transformer)
    if (path === '/vighnaatextllm' || path === '/vighnaatextllm/' || path.startsWith('/vighnaatextllm/')) {
      // Real static assets pass through to ASSETS.
      if (/\.(js|css|png|jpg|jpeg|svg|ico|webmanifest|map)$/.test(path)) {
        return env.ASSETS.fetch(request);
      }
      const handled = await handleVighnaa(request, env, url);
      if (handled) return handled;
      // Serve the page for /vighnaatextllm and sub-paths.
      const res = await fetchAssetFollow(env, url.origin, '/vighnaatextllm/index.html');
      return new Response(res.body, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    // Twisted Chess (game + realtime backend)
    if (path === '/twistedchess' || path === '/twistedchess/' || path.startsWith('/twistedchess/')) {
      // Let real static assets (engine.js, app.js, style.css) pass through to ASSETS.
      if (/\.(js|css|png|svg|ico|webmanifest|map)$/.test(path)) {
        return env.ASSETS.fetch(request);
      }
      return handleTwistedChess(request, env, url);
    }

    // Stella in the Woods countdown → serve the dedicated page
    // Clean route /stella-in-the-woods, plus the original -countdown path.
    if (
      path === '/stella-in-the-woods' || path === '/stella-in-the-woods/' ||
      path === '/stella-in-the-woods-countdown' || path === '/stella-in-the-woods-countdown/'
    ) {
      const res = await fetchAssetFollow(env, url.origin, '/stella-in-the-woods-countdown/index.html');
      return new Response(res.body, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    // Redirect /mood-log and /mood-log/* to the dedicated subdomain
    if (path === '/mood-log' || path === '/mood-log/' || path.startsWith('/mood-log/')) {
      const dest = 'https://mood-log.christopherrathbun.com' + path.slice('/mood-log'.length) + url.search;
      return Response.redirect(dest, 301);
    }

    // /profile → serve profile.html (strip trailing slash for asset lookup)
    if (path === '/profile' || path === '/profile/') {
      const profileReq = new Request(new URL('/profile.html', url.origin), request);
      return env.ASSETS.fetch(profileReq);
    }

    // Everything else → landing page static assets
    return env.ASSETS.fetch(request);
  },
};
