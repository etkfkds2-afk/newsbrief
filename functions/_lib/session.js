export const SESSION_COOKIE = 'nb_session';
const SESSION_DAYS = 30;
const SESSION_REFRESH_DAYS = 7;

function base64UrlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value) {
  const base64 = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
  const binary = atob(padded);
  return new Uint8Array([...binary].map(char => char.charCodeAt(0)));
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return base64UrlEncode(new Uint8Array(signature));
}

export async function createSessionCookie(secret, userId = 'default') {
  const expiry = Date.now() + SESSION_DAYS * 86400000;
  const issuedAt = Date.now();
  const encodedUser = base64UrlEncode(new TextEncoder().encode(String(userId || 'default').slice(0, 100)));
  const message = `${expiry}.${encodedUser}.${issuedAt}`;
  const signature = await hmac(secret, message);
  const value = `${message}.${signature}`;
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function readSession(cookieHeader, secret, legacyUser = 'default') {
  const match = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`).exec(cookieHeader || '');
  if (!match || !secret) return null;
  const parts = decodeURIComponent(match[1]).split('.');
  const legacy = parts.length === 2;
  const previousUserCookie = parts.length === 3;
  const [expiry, encodedUser, issuedAt, signature] = legacy
    ? [parts[0], '', '0', parts[1]]
    : previousUserCookie ? [parts[0], parts[1], '0', parts[2]] : parts;
  if (!expiry || !signature || !Number.isFinite(Number(expiry)) || Date.now() > Number(expiry)) return null;
  const expected = await hmac(secret, legacy ? expiry : previousUserCookie ? `${expiry}.${encodedUser}` : `${expiry}.${encodedUser}.${issuedAt}`);
  if (expected !== signature) return null;
  if (legacy) return { userId: String(legacyUser || 'default').slice(0, 100), expiry: Number(expiry), issuedAt: 0, legacy: true };
  try {
    const userId = new TextDecoder().decode(base64UrlDecode(encodedUser)).slice(0, 100);
    return userId ? { userId, expiry: Number(expiry), issuedAt: Number(issuedAt) || 0, legacy: previousUserCookie } : null;
  } catch { return null; }
}

export async function hasValidSession(cookieHeader, secret) {
  return Boolean(await readSession(cookieHeader, secret));
}

export async function sessionNeedsRefresh(cookieHeader, secret, verifiedSession = null) {
  const match = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`).exec(cookieHeader || '');
  if (!match) return false;
  const session = verifiedSession || await readSession(cookieHeader, secret);
  return Boolean(session) && session.expiry - Date.now() <= SESSION_REFRESH_DAYS * 86400000;
}
