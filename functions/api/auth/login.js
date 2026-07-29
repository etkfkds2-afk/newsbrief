import { createSessionCookie } from '../../_lib/session.js';
import { configuredAccounts, verifyAccount } from '../../_lib/news-users.js';

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers }
  });
}

export async function onRequestPost({ request, env }) {
  const configured = configuredAccounts(env);
  const sessionSecret = env.NEWSBRIEF_SESSION_SECRET || env.NEWSBRIEF_SITE_PASSWORD;
  if (!configured.size || !sessionSecret) {
    return json({ ok: false, error: '로그인이 아직 설정되지 않았습니다.' }, 500);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: '잘못된 요청입니다.' }, 400);
  }
  const username = String(body?.username || '');
  const password = String(body?.password || '');
  try {
    if (!await verifyAccount(env, username, password)) {
      return json({ ok: false, error: '아이디 또는 비밀번호가 올바르지 않습니다.' }, 401);
    }
    const cookie = await createSessionCookie(sessionSecret, username);
    return json({ ok: true }, 200, { 'set-cookie': cookie });
  } catch (error) {
    return json({ ok: false, error: error.message }, 500);
  }
}
