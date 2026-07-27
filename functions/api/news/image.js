import { ensureNewsDb } from '../../_lib/news-db.js';

function blockedHost(hostname) {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '0.0.0.0' || host === '::1'
    || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)
    || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}

export async function onRequestGet({ request, env }) {
  try {
    await ensureNewsDb(env);
    const key = new URL(request.url).searchParams.get('key') || '';
    if (!/^[a-f0-9]{64}$/.test(key)) return new Response('Bad request', { status: 400 });
    const row = await env.DB.prepare('SELECT image_url FROM news_articles WHERE url_key=?').bind(key).first();
    if (!row?.image_url) return new Response('Not found', { status: 404 });
    const target = new URL(row.image_url);
    if (!['http:', 'https:'].includes(target.protocol) || blockedHost(target.hostname)) return new Response('Forbidden', { status: 403 });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    let upstream;
    try {
      upstream = await fetch(target, {
        headers: { 'user-agent': 'Mozilla/5.0' }, signal: controller.signal,
        cf: { cacheEverything: true, cacheTtl: 86400 }
      });
    } finally {
      clearTimeout(timer);
    }
    if (!upstream.ok) return new Response('Image unavailable', { status: 502 });
    const type = upstream.headers.get('content-type') || '';
    if (!type.startsWith('image/')) return new Response('Invalid image', { status: 415 });
    return new Response(upstream.body, { headers: { 'content-type': type, 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' } });
  } catch {
    return new Response('Image unavailable', { status: 502 });
  }
}
