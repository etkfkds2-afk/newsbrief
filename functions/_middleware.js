import { hasValidSession } from './_lib/session.js';

// Paths reachable with no session: the login page/API itself, and the two
// endpoints GitHub Actions calls server-to-server. Those already authorize
// with their own Bearer token (see isCollectorAuthorized in news-db.js) and
// never carry a browser session cookie, so gating them here would silently
// break the automated collection/classification schedule.
// '/login' (no extension) is included because Cloudflare Pages auto-redirects
// /login.html -> /login; without it here, that redirect would bounce back
// into this same gate and loop.
const OPEN_PATHS = new Set(['/login.html', '/login', '/api/auth/login', '/api/news/health']);
const TOKEN_PROTECTED_PREFIXES = ['/api/news/collect', '/api/news/classify-issues'];

export async function onRequest({ request, env, next }) {
  const url = new URL(request.url);

  if (OPEN_PATHS.has(url.pathname)) return next();
  if (TOKEN_PROTECTED_PREFIXES.some(prefix => url.pathname.startsWith(prefix))) return next();

  // No password configured yet (e.g. secrets not deployed) - fail open
  // rather than lock everyone out of a site with no way to log in.
  if (!env.NEWSBRIEF_SITE_PASSWORD) return next();

  if (await hasValidSession(request.headers.get('cookie'), env.NEWSBRIEF_SITE_PASSWORD)) return next();

  if (url.pathname.startsWith('/api/')) {
    return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  }
  const next_param = encodeURIComponent(url.pathname + url.search);
  return Response.redirect(`${url.origin}/login?next=${next_param}`, 302);
}
