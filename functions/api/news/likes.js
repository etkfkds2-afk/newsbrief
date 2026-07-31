import { ensureNewsDb, isAuthorized, json } from '../../_lib/news-db.js';

// user_id is stored as `account:<username>` (see userId() in news-db.js).
// Strip that prefix so the popover shows the plain login name.
function displayName(uid) {
  return String(uid || '').replace(/^account:/, '') || uid;
}

export async function onRequestGet({ request, env }) {
  if (!isAuthorized(request, env)) return json({ ok: false, error: 'Unauthorized' }, 401);
  try {
    await ensureNewsDb(env);
    const key = new URL(request.url).searchParams.get('url_key') || '';
    if (!key) return json({ ok: false, error: 'url_key가 필요합니다.' }, 400);
    const result = await env.DB.prepare(
      'SELECT user_id, liked_at FROM news_likes WHERE url_key=? ORDER BY liked_at ASC LIMIT 100'
    ).bind(key.slice(0, 100)).all();
    const users = (result.results || []).map(row => displayName(row.user_id));
    return json({ ok: true, url_key: key, count: users.length, users });
  } catch (error) {
    return json({ ok: false, error: error.message }, 500);
  }
}
