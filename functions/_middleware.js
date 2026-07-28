import { createSessionCookie, readSession, sessionNeedsRefresh } from './_lib/session.js';

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

  // A missing password is a deployment/configuration fault. Never expose a
  // paid feed publicly just because a runtime binding disappeared.
  const sessionSecret = env.NEWSBRIEF_SESSION_SECRET || env.NEWSBRIEF_SITE_PASSWORD;
  if (!sessionSecret) {
    const message = 'Service authentication is temporarily unavailable.';
    if (url.pathname.startsWith('/api/')) {
      return new Response(JSON.stringify({ ok: false, error: message }), {
        status: 503,
        headers: { 'content-type': 'application/json; charset=utf-8', 'retry-after': '60' }
      });
    }
    return new Response(message, { status: 503, headers: { 'retry-after': '60' } });
  }

  const cookieHeader = request.headers.get('cookie');
  const session = await readSession(cookieHeader, sessionSecret, env.NEWSBRIEF_SITE_USER || 'default');
  if (session) {
    if (env.DB && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin'))) {
      const account = await env.DB.prepare('SELECT active,updated_at FROM news_users WHERE username=?').bind(session.userId).first()
        .catch(error => {
          if (/no such table/i.test(error.message)) return null;
          throw error;
        });
      const changedText = String(account?.updated_at || '');
      const changedAt = changedText ? Date.parse(/Z$|[+-]\d\d:\d\d$/.test(changedText) ? changedText : `${changedText.replace(' ', 'T')}Z`) : 0;
      if (account && (!account.active || !session.issuedAt || changedAt > session.issuedAt)) {
        if (url.pathname.startsWith('/api/')) {
          return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), {
            status: 401,
            headers: { 'content-type': 'application/json; charset=utf-8' }
          });
        }
        return Response.redirect(`${url.origin}/login?next=${encodeURIComponent(url.pathname + url.search)}`, 302);
      }
    }
    const headers = new Headers(request.headers);
    headers.set('x-news-user', `account:${session.userId}`);
    const response = await next(new Request(request, { headers }));
    // Active browsers remain signed in: renew only during the final week to
    // avoid sending Set-Cookie on every image/API request.
    if (await sessionNeedsRefresh(cookieHeader, sessionSecret, session)) {
      const renewed = new Response(response.body, response);
      renewed.headers.append('set-cookie', await createSessionCookie(sessionSecret, session.userId));
      return renewed;
    }
    return response;
  }

  if (url.pathname.startsWith('/api/')) {
    return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  }
  const next_param = encodeURIComponent(url.pathname + url.search);
  return Response.redirect(`${url.origin}/login?next=${next_param}`, 302);
}
