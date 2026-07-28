export const SESSION_COOKIE = 'nb_session';
const SESSION_DAYS = 30;

function base64UrlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return base64UrlEncode(new Uint8Array(signature));
}

export async function createSessionCookie(secret) {
  const expiry = Date.now() + SESSION_DAYS * 86400000;
  const signature = await hmac(secret, String(expiry));
  const value = `${expiry}.${signature}`;
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function hasValidSession(cookieHeader, secret) {
  const match = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`).exec(cookieHeader || '');
  if (!match) return false;
  const [expiry, signature] = decodeURIComponent(match[1]).split('.');
  if (!expiry || !signature || !Number.isFinite(Number(expiry))) return false;
  if (Date.now() > Number(expiry)) return false;
  const expected = await hmac(secret, expiry);
  return expected === signature;
}
