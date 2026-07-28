import { clearSessionCookie } from '../../_lib/session.js';

export async function onRequestPost() {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': clearSessionCookie()
    }
  });
}
