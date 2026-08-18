import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, run, STALL_LIMIT_MS, utcMillis } from '../monitor/worker.js';

const NOW = Date.parse('2026-08-18T12:00:00Z');

function healthWith({ automaticStartedAt, lastRunStatus = 'ok' }) {
  return {
    ok: true,
    metrics: {
      last_run: { status: lastRunStatus },
      last_automatic_run: { started_at: automaticStartedAt, status: 'ok' }
    }
  };
}

function hoursAgo(hours) {
  return new Date(NOW - hours * 3600000).toISOString();
}

test('최근에 자동 수집이 돌았으면 끼어들지 않는다', () => {
  const verdict = evaluate({
    reachable: true, status: 200, nowMs: NOW,
    health: healthWith({ automaticStartedAt: hoursAgo(1.5) })
  });
  assert.equal(verdict.stalled, false);
  assert.equal(verdict.reason, 'alive');
});

test('GitHub이 예약을 몇 번 흘린 정도(3시간)로는 끼어들지 않는다', () => {
  // 이 저장소는 예약이 통째로 걸러지는 공백을 실제로 겪는다. 그때마다 예비
  // 수집이 끼어들면 예약과 겹쳐 유료 요약을 두 배로 산다.
  const verdict = evaluate({
    reachable: true, status: 200, nowMs: NOW,
    health: healthWith({ automaticStartedAt: hoursAgo(3) })
  });
  assert.equal(verdict.stalled, false);
});

test('4시간 넘게 자동 수집이 없으면 정지로 본다', () => {
  const verdict = evaluate({
    reachable: true, status: 200, nowMs: NOW,
    health: healthWith({ automaticStartedAt: hoursAgo(5) })
  });
  assert.equal(verdict.stalled, true);
  assert.equal(verdict.reason, 'collection_stalled');
  assert.equal(verdict.ageHours, 5);
});

test('이번 사고(30시간 정지)를 실제로 잡는다', () => {
  // 2026-08-16 18:49 자동 실행을 마지막으로 8/18 01:14까지 멈춰 있었다.
  const verdict = evaluate({
    reachable: true, status: 200,
    nowMs: Date.parse('2026-08-18T01:00:00Z'),
    health: healthWith({ automaticStartedAt: '2026-08-16T18:49:38.729Z' })
  });
  assert.equal(verdict.stalled, true);
  assert.equal(verdict.reason, 'collection_stalled');
});

test('수집이 도는 중이면 오래됐어도 끼어들지 않는다', () => {
  // 수집은 3분 넘게 걸린다. 그 사이에 한 번 더 부르면 같은 후보를 두 번
  // 처리해 유료 요약을 두 배로 산다.
  const verdict = evaluate({
    reachable: true, status: 200, nowMs: NOW,
    health: healthWith({ automaticStartedAt: hoursAgo(30), lastRunStatus: 'running' })
  });
  assert.equal(verdict.stalled, false);
  assert.equal(verdict.reason, 'run_in_progress');
});

test('health를 못 받으면 정지로 본다', () => {
  const verdict = evaluate({ reachable: false, status: 0, health: null, nowMs: NOW });
  assert.equal(verdict.stalled, true);
  assert.equal(verdict.reason, 'health_unreachable');
});

test('health가 오류 코드를 내면 정지로 본다', () => {
  const verdict = evaluate({ reachable: true, status: 500, health: null, nowMs: NOW });
  assert.equal(verdict.stalled, true);
  assert.equal(verdict.reason, 'health_http_error');
});

test('자동 실행 기록이 아예 없으면 정지로 본다', () => {
  const verdict = evaluate({
    reachable: true, status: 200, nowMs: NOW,
    health: { ok: true, metrics: { last_run: { status: 'ok' } } }
  });
  assert.equal(verdict.stalled, true);
  assert.equal(verdict.reason, 'no_automatic_run_recorded');
});

test('타임존 없는 옛 형식 시각도 UTC로 읽는다', () => {
  // health.js의 utcMillis와 규칙이 어긋나면 이 감시자만 시각을 다르게 읽어
  // 영영 안 울리거나 매번 울린다.
  assert.equal(utcMillis('2026-08-16 18:49:38'), Date.parse('2026-08-16T18:49:38Z'));
  assert.equal(utcMillis('2026-08-16T18:49:38.729Z'), Date.parse('2026-08-16T18:49:38.729Z'));
  assert.equal(utcMillis(''), 0);
});

test('정지면 source=watchdog로 수집을 부른다', async () => {
  // manual로 부르면 health가 자동 실행으로 세지 않아서, 예비 수집이 아무리
  // 돌아도 정지 판정이 안 풀리고 30분마다 영원히 다시 부른다.
  const calls = [];
  const env = {
    HEALTH_URL: 'https://example.test/health',
    COLLECT_URL: 'https://example.test/collect',
    NEWSBRIEF_COLLECT_TOKEN: 'tok'
  };
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/health')) {
      return new Response(JSON.stringify(healthWith({ automaticStartedAt: hoursAgo(30) })), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };
  const result = await run(env, NOW);
  assert.equal(result.triggered, true);
  const collect = calls.find((c) => c.url.includes('/collect'));
  assert.ok(collect, '수집을 불러야 한다');
  assert.match(collect.url, /source=watchdog/);
  assert.equal(collect.options.method, 'POST');
  assert.equal(collect.options.headers.authorization, 'Bearer tok');
});

test('정상이면 수집을 부르지 않는다', async () => {
  const calls = [];
  const env = {
    HEALTH_URL: 'https://example.test/health',
    COLLECT_URL: 'https://example.test/collect',
    NEWSBRIEF_COLLECT_TOKEN: 'tok'
  };
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify(healthWith({ automaticStartedAt: hoursAgo(1) })), { status: 200 });
  };
  const result = await run(env, NOW);
  assert.equal(result.triggered, false);
  assert.equal(calls.filter((u) => u.includes('/collect')).length, 0);
});

test('수집 응답이 끊겨도 예외로 터지지 않는다', async () => {
  // 수집은 3분 넘게 걸려서 응답을 끝까지 못 받는 일이 있다. 거기서 throw하면
  // Cloudflare가 실행을 오류로 적을 뿐 얻는 것이 없다.
  const env = {
    HEALTH_URL: 'https://example.test/health',
    COLLECT_URL: 'https://example.test/collect',
    NEWSBRIEF_COLLECT_TOKEN: 'tok'
  };
  globalThis.fetch = async (url) => {
    if (String(url).includes('/health')) {
      return new Response(JSON.stringify(healthWith({ automaticStartedAt: hoursAgo(30) })), { status: 200 });
    }
    throw new Error('timeout');
  };
  const result = await run(env, NOW);
  assert.equal(result.triggered, true);
  assert.equal(result.collectOk, false);
});

test('정지 판정 문턱은 4시간이다', () => {
  assert.equal(STALL_LIMIT_MS, 4 * 60 * 60 * 1000);
});
