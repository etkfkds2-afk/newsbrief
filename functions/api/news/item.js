import { ensureNewsDb, isAuthorized, json, userId } from '../../_lib/news-db.js';

export async function onRequestPost({ request, env }) {
  if (!isAuthorized(request, env)) return json({ ok: false, error: 'Unauthorized' }, 401);
  try {
    await ensureNewsDb(env);
    const body = await request.json();
    const key = String(body.url_key || '').slice(0, 100);
    const keys = [...new Set([key, ...(Array.isArray(body.url_keys) ? body.url_keys : [])]
      .map(value => String(value || '').slice(0, 100)).filter(Boolean))].slice(0, 100);
    const action = body.action;
    if (!key || !['save', 'unsave', 'hide', 'unhide', 'like', 'unlike'].includes(action)) {
      return json({ ok: false, error: '올바른 url_key와 action이 필요합니다.' }, 400);
    }
    const uid = userId(request);
    if (action === 'save') {
      await env.DB.prepare('INSERT OR IGNORE INTO news_saved(user_id,url_key) VALUES(?,?)').bind(uid, key).run();
    } else if (action === 'unsave') {
      await env.DB.prepare('DELETE FROM news_saved WHERE user_id=? AND url_key=?').bind(uid, key).run();
    } else if (action === 'like') {
      await env.DB.prepare('INSERT OR IGNORE INTO news_likes(user_id,url_key) VALUES(?,?)').bind(uid, key).run();
    } else if (action === 'unlike') {
      await env.DB.prepare('DELETE FROM news_likes WHERE user_id=? AND url_key=?').bind(uid, key).run();
    } else if (action === 'hide') {
      await env.DB.batch(keys.flatMap(itemKey => [
        env.DB.prepare('INSERT OR IGNORE INTO news_hidden(user_id,url_key) VALUES(?,?)').bind(uid, itemKey),
        env.DB.prepare('DELETE FROM news_saved WHERE user_id=? AND url_key=?').bind(uid, itemKey)
      ]));
    } else {
      await env.DB.prepare('DELETE FROM news_hidden WHERE user_id=? AND url_key=?').bind(uid, key).run();
    }
    return json({ ok: true, action, affected: action === 'hide' ? keys.length : 1 });
  } catch (error) {
    return json({ ok: false, error: error.message }, 500);
  }
}
