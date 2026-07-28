import { ensureNewsDb } from './news-db.js';

export const MAX_USERS = 100;
export const DEFAULT_ADMIN_USER = 'admin0221';

function hex(bytes) {
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function configuredAccounts(env) {
  const configured = new Map();
  try {
    const parsed = JSON.parse(String(env.NEWSBRIEF_SITE_USERS || '{}'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [username, password] of Object.entries(parsed)) {
        if (username && typeof password === 'string' && password) configured.set(username.slice(0, 100), password);
      }
    }
  } catch {}
  if (env.NEWSBRIEF_SITE_USER && env.NEWSBRIEF_SITE_PASSWORD) {
    configured.set(String(env.NEWSBRIEF_SITE_USER).slice(0, 100), String(env.NEWSBRIEF_SITE_PASSWORD));
  }
  return configured;
}

export function adminUsername(env) {
  return String(env.NEWSBRIEF_ADMIN_USER || DEFAULT_ADMIN_USER).slice(0, 100);
}

export function validUsername(value) {
  return /^[a-z0-9._-]{3,32}$/.test(String(value || ''));
}

export function validPassword(value) {
  const length = String(value || '').length;
  return length >= 4 && length <= 64;
}

export async function passwordHash(env, username, password) {
  const secret = env.NEWSBRIEF_SESSION_SECRET || env.NEWSBRIEF_SITE_PASSWORD;
  if (!secret) throw new Error('세션 비밀값이 없습니다.');
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${username}\u0000${password}`)));
}

export async function loadDbUser(env, username) {
  if (!env.DB) return null;
  await ensureNewsDb(env);
  return env.DB.prepare('SELECT username,password_hash,role,active,created_at,updated_at FROM news_users WHERE username=?')
    .bind(username).first();
}

export async function verifyAccount(env, username, password) {
  const row = await loadDbUser(env, username);
  if (row) {
    if (!row.active || !row.password_hash) return null;
    return await passwordHash(env, username, password) === row.password_hash ? row : null;
  }
  const configured = configuredAccounts(env);
  if (!configured.has(username) || configured.get(username) !== password) return null;
  return { username, role: username === adminUsername(env) ? 'admin' : 'member', active: 1, source: 'configured' };
}
