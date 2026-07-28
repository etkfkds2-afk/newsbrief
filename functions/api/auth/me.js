import { adminUsername } from '../../_lib/news-users.js';

export async function onRequestGet({ request, env }) {
  const username = String(request.headers.get('x-news-user') || '').replace(/^account:/, '');
  return new Response(JSON.stringify({ ok: true, username, admin: username === adminUsername(env) }), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}
