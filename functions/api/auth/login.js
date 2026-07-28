import { createSessionCookie } from '../../_lib/session.js';

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers }
  });
}

export async function onRequestPost({ request, env }) {
  if (!env.NEWSBRIEF_SITE_USER || !env.NEWSBRIEF_SITE_PASSWORD) {
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
  if (username !== env.NEWSBRIEF_SITE_USER || password !== env.NEWSBRIEF_SITE_PASSWORD) {
    return json({ ok: false, error: '아이디 또는 비밀번호가 올바르지 않습니다.' }, 401);
  }
  const cookie = await createSessionCookie(env.NEWSBRIEF_SITE_PASSWORD);
  return json({ ok: true }, 200, { 'set-cookie': cookie });
}
