import { ensureNewsDb, json } from '../../_lib/news-db.js';
import { adminUsername, configuredAccounts } from '../../_lib/news-users.js';

const FREE_DATABASE_BYTES = 500 * 1024 * 1024;

function requester(request) {
  return String(request.headers.get('x-news-user') || '').replace(/^account:/, '');
}

export async function onRequestGet({ request, env }) {
  if (requester(request) !== adminUsername(env)) {
    return json({ ok: false, error: '관리자 권한이 필요합니다.' }, 403);
  }
  try {
    await ensureNewsDb(env);
    const result = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM news_saved) AS saved_count,
      (SELECT COUNT(*) FROM news_hidden) AS hidden_count,
      (SELECT COUNT(*) FROM news_users WHERE active=1) AS database_user_count`).all();
    const row = result.results?.[0] || {};
    const databaseBytes = Number(result.meta?.size_after || 0);
    const storagePercent = databaseBytes > 0 ? databaseBytes / FREE_DATABASE_BYTES * 100 : null;
    const configuredCount = configuredAccounts(env).size;
    return json({
      ok: true,
      storage: {
        bytes: databaseBytes || null,
        limit_bytes: FREE_DATABASE_BYTES,
        percent: storagePercent === null ? null : Number(storagePercent.toFixed(2)),
        level: storagePercent === null ? 'unknown' : storagePercent >= 85 ? 'danger' : storagePercent >= 70 ? 'warning' : 'ok'
      },
      records: {
        saved: Number(row.saved_count || 0),
        hidden: Number(row.hidden_count || 0),
        database_users: Number(row.database_user_count || 0),
        configured_users: configuredCount
      },
      daily_limits: { requests: 100000, rows_read: 5000000, rows_written: 100000, measured_here: false }
    });
  } catch (error) {
    return json({ ok: false, error: error.message }, 500);
  }
}
