import { ensureNewsDb, json } from '../../_lib/news-db.js';
import {
  MAX_USERS, adminUsername, configuredAccounts, passwordHash, validPassword, validUsername
} from '../../_lib/news-users.js';

function requester(request) {
  return String(request.headers.get('x-news-user') || '').replace(/^account:/, '');
}

function authorized(request, env) {
  return requester(request) === adminUsername(env);
}

async function mergedUsers(env) {
  await ensureNewsDb(env);
  const configured = configuredAccounts(env);
  const rows = (await env.DB.prepare(
    'SELECT username,role,active,created_at,updated_at FROM news_users ORDER BY username'
  ).all()).results || [];
  const byName = new Map([...configured.keys()].map(username => [username, {
    username, role: username === adminUsername(env) ? 'admin' : 'member', active: 1, source: 'configured'
  }]));
  for (const row of rows) byName.set(row.username, { ...row, active: Number(row.active), source: 'database' });
  return [...byName.values()].filter(user => user.active).sort((a, b) => a.username.localeCompare(b.username));
}

export async function onRequestGet({ request, env }) {
  if (!authorized(request, env)) return json({ ok: false, error: '관리자 권한이 필요합니다.' }, 403);
  const users = await mergedUsers(env);
  return json({ ok: true, users, count: users.length, max_users: MAX_USERS });
}

export async function onRequestPost({ request, env }) {
  if (!authorized(request, env)) return json({ ok: false, error: '관리자 권한이 필요합니다.' }, 403);
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: '잘못된 요청입니다.' }, 400); }
  const action = String(body?.action || '');
  const username = String(body?.username || '').trim();
  if (!validUsername(username)) return json({ ok: false, error: '아이디는 영문 소문자·숫자·._- 조합 3~32자로 입력하세요.' }, 400);
  if (action === 'delete') {
    if (username === adminUsername(env)) return json({ ok: false, error: '관리자 본인 계정은 삭제할 수 없습니다.' }, 400);
    await ensureNewsDb(env);
    const updatedAt = new Date().toISOString();
    const accountId = `account:${username}`;
    await env.DB.batch([
      env.DB.prepare('DELETE FROM news_saved WHERE user_id=?').bind(accountId),
      env.DB.prepare('DELETE FROM news_hidden WHERE user_id=?').bind(accountId),
      env.DB.prepare(`INSERT INTO news_users(username,password_hash,role,active,updated_at)
        VALUES (?,'','member',0,?)
        ON CONFLICT(username) DO UPDATE SET password_hash='',active=0,updated_at=excluded.updated_at`)
        .bind(username, updatedAt)
    ]);
    return json({ ok: true, preferences_deleted: true });
  }
  if (action === 'rename') {
    const oldUsername = String(body?.old_username || '').trim();
    if (!validUsername(oldUsername)) return json({ ok: false, error: '변경할 기존 아이디가 올바르지 않습니다.' }, 400);
    if (oldUsername === adminUsername(env)) return json({ ok: false, error: '관리자 아이디는 변경할 수 없습니다.' }, 400);
    if (oldUsername === username) return json({ ok: false, error: '새 아이디가 기존 아이디와 같습니다.' }, 400);
    const users = await mergedUsers(env);
    if (!users.some(user => user.username === oldUsername)) return json({ ok: false, error: '기존 아이디가 없습니다.' }, 404);
    if (users.some(user => user.username === username)) return json({ ok: false, error: '새 아이디가 이미 존재합니다.' }, 409);
    const password = String(body?.password || '');
    if (!validPassword(password)) return json({ ok: false, error: '아이디 변경 시 새 비밀번호 4~64자를 입력하세요.' }, 400);
    const hash = await passwordHash(env, username, password);
    const updatedAt = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO news_users(username,password_hash,role,active,updated_at)
        VALUES (?,?,'member',1,?)`).bind(username, hash, updatedAt),
      env.DB.prepare(`INSERT OR IGNORE INTO news_saved(user_id,url_key,saved_at)
        SELECT ?,url_key,saved_at FROM news_saved WHERE user_id=?`).bind(`account:${username}`, `account:${oldUsername}`),
      env.DB.prepare(`INSERT OR IGNORE INTO news_hidden(user_id,url_key,hidden_at)
        SELECT ?,url_key,hidden_at FROM news_hidden WHERE user_id=?`).bind(`account:${username}`, `account:${oldUsername}`),
      env.DB.prepare('DELETE FROM news_saved WHERE user_id=?').bind(`account:${oldUsername}`),
      env.DB.prepare('DELETE FROM news_hidden WHERE user_id=?').bind(`account:${oldUsername}`),
      env.DB.prepare(`INSERT INTO news_users(username,password_hash,role,active,updated_at)
        VALUES (?,'','member',0,?)
        ON CONFLICT(username) DO UPDATE SET password_hash='',active=0,updated_at=excluded.updated_at`).bind(oldUsername, updatedAt)
    ]);
    return json({ ok: true });
  }
  if (!['create', 'password'].includes(action)) return json({ ok: false, error: '지원하지 않는 작업입니다.' }, 400);
  const password = String(body?.password || '');
  if (!validPassword(password)) return json({ ok: false, error: '비밀번호는 4~64자로 입력하세요.' }, 400);
  const users = await mergedUsers(env);
  const exists = users.some(user => user.username === username);
  if (action === 'create' && exists) return json({ ok: false, error: '이미 존재하는 아이디입니다.' }, 409);
  if (action === 'password' && !exists) return json({ ok: false, error: '존재하지 않는 아이디입니다.' }, 404);
  if (!exists && users.length >= MAX_USERS) return json({ ok: false, error: `계정은 최대 ${MAX_USERS}개까지 만들 수 있습니다.` }, 409);
  const hash = await passwordHash(env, username, password);
  const role = username === adminUsername(env) ? 'admin' : 'member';
  const updatedAt = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO news_users(username,password_hash,role,active,updated_at)
    VALUES (?,?,?,1,?)
    ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash,role=excluded.role,active=1,updated_at=excluded.updated_at`)
    .bind(username, hash, role, updatedAt).run();
  return json({ ok: true });
}
