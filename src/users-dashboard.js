// STUB — the original src/users-dashboard.js was never committed to the repo,
// and no machine with a copy could be found, so deploys from a fresh clone
// failed on the import in worker.js. This keeps /users and /api/users
// responding while the original is missing. If the original file turns up,
// replace this stub with it and everything reconnects — worker.js is unchanged.
export async function handleUsers(request, env, url) {
  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Users Dashboard</title></head>
<body style="font-family: monospace; background:#0c0c0c; color:#e8e8e8; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0;">
  <p>The users dashboard is temporarily offline.</p>
</body>
</html>`,
    { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } }
  );
}
