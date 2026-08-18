// GitHub Actions 밖에서 도는 예비 수집기.
//
// 2026-08-16 18:51부터 8/18 01:14까지 30시간 동안 수집이 통째로 멈췄다. 예약은
// 21번 정확히 울렸고 GitHub이 매번 Actions 요금 한도를 이유로 실행을 거부했다
// ("The job was not started because ... spending limit"). 그동안 경고는 한 통도
// 안 갔는데, 경고를 보내는 health-check job이 거부당한 **바로 그 워크플로 안에**
// 있었기 때문이다. 감시자가 감시 대상 안에 살아서 대상이 죽자 같이 죽었고,
// 결국 사용자가 화면을 보고 발견했다.
//
// 그래서 이건 Cloudflare에 따로 산다. Actions가 통째로 막혀도 이건 돈다.
//
// **알리는 대신 직접 돌린다.** 알림은 사람이 눌러야 복구되고, 그건 이 저장소가
// 정한 기준으로는 고친 게 아니다. 수집은 Authorization 헤더 하나로 부르는
// HTTP 호출이고 그 토큰은 이미 배포 시크릿에 있으므로, 예비 수집기가 같은
// 호출을 대신 하면 Actions가 죽어 있어도 뉴스는 계속 들어온다.

// 수집 예약은 3시간마다(:17), 워치독은 그 사이 90분 지점(:47)이다. 정상이면
// 자동 실행이 90분에 한 번은 남는다. 그런데 GitHub은 바쁜 시간대에 예약을
// 통째로 흘리는 일이 있어서(이 저장소에서 여러 시간 공백을 실제로 겪었다),
// 흘림마다 끼어들면 예약과 예비 수집이 겹쳐 요약을 두 배로 사게 된다.
// 4시간은 자동 실행 기회를 두 번 넘게 놓쳐야 끼어드는 값이라, 흘림은 넘기고
// 진짜 정지에만 반응한다.
export const STALL_LIMIT_MS = 4 * 60 * 60 * 1000;

// health.js의 utcMillis와 같은 규칙으로 읽는다. 여기서만 다르게 해석하면
// 시각 계산이 조용히 어긋나 영영 안 울리거나 매번 울린다.
export function utcMillis(value) {
  const text = String(value || '');
  const parsed = Date.parse(/Z$|[+-]\d\d:\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}Z`);
  return Number.isFinite(parsed) ? parsed : 0;
}

// 판정만 하는 순수 함수다. 네트워크와 떼어 놔야 "몇 시간째 멈췄을 때 끼어드는가"를
// 테스트가 직접 확인할 수 있다.
export function evaluate({ reachable, status, health, nowMs, stallLimitMs = STALL_LIMIT_MS }) {
  if (!reachable) {
    return { stalled: true, reason: 'health_unreachable', detail: 'health 응답을 받지 못했다' };
  }
  if (status !== 200) {
    return { stalled: true, reason: 'health_http_error', detail: `health가 HTTP ${status}를 냈다` };
  }
  // 이미 돌고 있는 중이면 끼어들지 않는다. 수집은 3분 넘게 걸리므로 그 사이에
  // 한 번 더 부르면 같은 후보를 두 번 처리해 유료 요약을 두 배로 산다.
  if (health?.metrics?.last_run?.status === 'running') {
    return { stalled: false, reason: 'run_in_progress', detail: '수집이 지금 돌고 있다' };
  }
  const startedAt = health?.metrics?.last_automatic_run?.started_at;
  const startedMs = utcMillis(startedAt);
  if (!startedMs) {
    return { stalled: true, reason: 'no_automatic_run_recorded', detail: '자동 실행 기록이 아예 없다' };
  }
  const ageMs = nowMs - startedMs;
  const ageHours = Math.round((ageMs / 3600000) * 10) / 10;
  if (ageMs > stallLimitMs) {
    return {
      stalled: true,
      reason: 'collection_stalled',
      detail: `마지막 자동 수집이 ${ageHours}시간 전이다 (${startedAt})`,
      ageHours
    };
  }
  return { stalled: false, reason: 'alive', detail: `마지막 자동 수집 ${ageHours}시간 전`, ageHours };
}

async function probe(env, nowMs) {
  try {
    const res = await fetch(env.HEALTH_URL, {
      headers: { 'user-agent': 'newsbrief-watch' },
      signal: AbortSignal.timeout(20000)
    });
    let health = null;
    try {
      health = await res.json();
    } catch {
      health = null;
    }
    return evaluate({ reachable: true, status: res.status, health, nowMs });
  } catch {
    return evaluate({ reachable: false, status: 0, health: null, nowMs });
  }
}

export async function run(env, nowMs) {
  const verdict = await probe(env, nowMs);
  if (!verdict.stalled) {
    console.log(`정상: ${verdict.detail}`);
    return { ...verdict, triggered: false };
  }
  if (!env.NEWSBRIEF_COLLECT_TOKEN) {
    console.error('NEWSBRIEF_COLLECT_TOKEN이 없어 예비 수집을 못 돌린다');
    return { ...verdict, triggered: false, error: 'missing_token' };
  }
  // source=watchdog로 부른다. health가 자동 실행으로 세는 값이라, 이 호출이
  // 성공하면 정지 판정이 저절로 풀린다. manual로 부르면 예비 수집이 아무리
  // 돌아도 health는 계속 "자동 실행이 없다"고 보고한다.
  const endpoint = `${env.COLLECT_URL}?source=watchdog`;
  console.log(`정지 감지(${verdict.reason}): ${verdict.detail} - 예비 수집을 돌린다`);
  // 수집은 3분 넘게 걸린다. 응답을 끝까지 못 기다리고 끊기더라도 실패로 보지
  // 않는다 - 수집은 이미 시작됐고, 시작하는 순간 last_run이 running으로 바뀌어
  // 위의 run_in_progress 가드가 다음 tick의 중복 호출을 막는다. 여기서 throw
  // 하면 Cloudflare가 이 실행을 오류로 적을 뿐 얻는 것이 없다.
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.NEWSBRIEF_COLLECT_TOKEN}`,
        'user-agent': 'newsbrief-watch'
      },
      signal: AbortSignal.timeout(240000)
    });
    console.log(`예비 수집 결과: HTTP ${res.status}`);
    return { ...verdict, triggered: true, collectStatus: res.status, collectOk: res.ok };
  } catch (error) {
    console.log(`예비 수집 응답을 끝까지 못 받았다(${error}). 수집 자체는 시작됐을 수 있다.`);
    return { ...verdict, triggered: true, collectStatus: 0, collectOk: false };
  }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env, Date.now()));
  },

  // 손으로 눌러 확인하는 경로. 판정만 돌려주고 수집은 건드리지 않는다.
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/check') return new Response('newsbrief-watch', { status: 200 });
    const verdict = await probe(env, Date.now());
    return new Response(JSON.stringify(verdict, null, 2), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  }
};
