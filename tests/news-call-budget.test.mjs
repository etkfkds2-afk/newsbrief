// 예산·호출 계수의 **동작**을 검증한다.
//
// 이 파일이 생긴 이유: 2026-08-14에 실제로 서비스를 멈춘 버그 세 개가 있었는데
// 그때 테스트 191개가 전부 통과했다. 그 테스트들이 "소스에 이 문자열이 있나"를
// 보고 있었기 때문이다. 여기서는 문자열이 아니라 결과를 본다 - 아래 테스트는
// 그날의 버그를 각각 실제로 잡는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BADUK_RESERVED_ANTHROPIC_CALLS, createCallBudget, DAILY_ANTHROPIC_CALL_LIMIT,
  generalLimitForNow, GENERAL_DAILY_ANTHROPIC_CALL_LIMIT, SUBREQUEST_BUDGET,
  SUBREQUESTS_PER_CANDIDATE
} from '../functions/_lib/news-call-budget.js';
import { koreaDayKey } from '../functions/_lib/news-ai-budget.js';

// news_state 한 장을 흉내 내는 최소 D1. 실제 SQL을 해석하지 않고, 이 모듈이
// 쓰는 질의 모양만 알아본다.
function fakeDb(initial = {}) {
  const state = { anthropic_budget_day: koreaDayKey(), ...initial };
  const run = (sql, binds) => {
    const key = sql.match(/VALUES\('([a-z_]+)'/)?.[1] || String(binds[0] || '');
    if (/value=value\+1/.test(sql)) state[key] = Number(state[key] || 0) + 1;
    else if (/SET value=0/.test(sql)) state[key] = 0;
    else if (/value=excluded\.value/.test(sql)) state[key] = binds[binds.length - 1];
    return { meta: {} };
  };
  const prepare = sql => {
    let binds = [];
    const stmt = {
      bind: (...values) => { binds = values; return stmt; },
      first: async () => {
        const key = sql.match(/key='([a-z_]+)'/)?.[1] || String(binds[0] || '');
        return key in state ? { value: state[key] } : null;
      },
      run: async () => run(sql, binds),
      __exec: () => run(sql, binds)
    };
    return stmt;
  };
  return {
    state,
    DB: {
      prepare,
      batch: async statements => statements.map(s => s.__exec())
    }
  };
}

const envWith = (db, over = {}) => ({
  DB: db.DB, ANTHROPIC_API_KEY: 'k', ...over
});

test('바둑은 일반이 몫을 다 써도 예약분만큼은 반드시 받는다', async () => {
  // 2026-08-14의 고장: 일반이 먼저 39건을 써서 총량이 바닥났고 그날 바둑이 0건이었다.
  const db = fakeDb({
    anthropic_calls_today: GENERAL_DAILY_ANTHROPIC_CALL_LIMIT,
    anthropic_calls_today_general: GENERAL_DAILY_ANTHROPIC_CALL_LIMIT,
    anthropic_calls_today_baduk: 0
  });
  const diagnostics = {};
  const budget = createCallBudget(envWith(db), diagnostics);

  assert.equal(await budget.reserveAnthropic('general'), false,
    '일반은 자기 상한에서 멈춰야 한다');
  assert.equal(diagnostics.anthropic_exhausted_reason, 'bucket_general');

  // 같은 상태에서 바둑은 예약분을 전부 받을 수 있어야 한다.
  let granted = 0;
  for (let i = 0; i < BADUK_RESERVED_ANTHROPIC_CALLS; i += 1) {
    if (await budget.reserveAnthropic('baduk')) granted += 1;
  }
  assert.equal(granted, BADUK_RESERVED_ANTHROPIC_CALLS,
    `일반이 몫을 다 써도 바둑은 ${BADUK_RESERVED_ANTHROPIC_CALLS}건을 받아야 한다`);
});

test('일반 몫과 바둑 예약분을 더하면 하루 총량이다', () => {
  assert.equal(
    GENERAL_DAILY_ANTHROPIC_CALL_LIMIT + BADUK_RESERVED_ANTHROPIC_CALLS,
    DAILY_ANTHROPIC_CALL_LIMIT,
    '몫 배분이 총량과 어긋나면 하루 최대 지출이 조용히 바뀐다');
  assert.ok(BADUK_RESERVED_ANTHROPIC_CALLS > GENERAL_DAILY_ANTHROPIC_CALL_LIMIT,
    '바둑이 메인이므로 예약분이 일반 몫보다 커야 한다');
});

test('밤 9시(한국시간)를 넘기면 일반이 남은 바둑 몫을 쓴다', () => {
  const atKst = hour => new Date(Date.UTC(2026, 7, 14, hour - 9, 0, 0));
  assert.equal(generalLimitForNow(atKst(20)), GENERAL_DAILY_ANTHROPIC_CALL_LIMIT);
  assert.equal(generalLimitForNow(atKst(21)), DAILY_ANTHROPIC_CALL_LIMIT);
  assert.equal(generalLimitForNow(atKst(23)), DAILY_ANTHROPIC_CALL_LIMIT);
});

test('하루 카운터는 한국시간 날짜가 바뀌면 초기화된다', async () => {
  // UTC 날짜를 쓰던 동안 카운터가 아침 9시에 리셋돼, 새벽 실행이 어제치 소진분을
  // 물려받았다. 어제 날짜로 남아 있으면 다음 예약에서 0으로 돌아가야 한다.
  const db = fakeDb({
    anthropic_budget_day: '2000-01-01',
    anthropic_calls_today: DAILY_ANTHROPIC_CALL_LIMIT,
    anthropic_calls_today_general: DAILY_ANTHROPIC_CALL_LIMIT
  });
  const budget = createCallBudget(envWith(db), {});
  assert.equal(await budget.reserveAnthropic('general'), true,
    '날짜가 바뀌었으면 어제 소진분을 물려받으면 안 된다');
  assert.equal(db.state.anthropic_budget_day, koreaDayKey());
});

test('감싼 호출은 빠짐없이 세어진다', async () => {
  // 2026-08-14의 고장: 본문만 세고 검색·중복판정·요약 두 번째 시도를 안 셌다.
  // 그 결과 Worker 외부 요청 한도를 넘겼고, 넘긴 뒤 죽은 후보가 매체 탓으로
  // 기록됐다. 여기서는 비용이 실제로 누적되는지만 본다.
  const budget = createCallBudget(envWith(fakeDb()), {});
  const search = budget.counted(async () => 'ok');
  const popular = budget.counted(async () => 'ok', 3);

  await search();
  assert.equal(budget.used(), 1);
  await popular();
  assert.equal(budget.used(), 4, '비용이 큰 호출은 그만큼 세어야 한다');
  budget.spend(2);
  assert.equal(budget.used(), 6);
  assert.equal(budget.remaining(), SUBREQUEST_BUDGET - 6);
});

test('예산이 모자라면 후보를 아예 시작하지 않는다', () => {
  const budget = createCallBudget(envWith(fakeDb()), {});
  budget.spend(SUBREQUEST_BUDGET - SUBREQUESTS_PER_CANDIDATE);
  assert.equal(budget.canStartCandidate(), true, '딱 맞으면 시작할 수 있어야 한다');
  budget.spend(1);
  assert.equal(budget.canStartCandidate(), false,
    '한 후보분이 안 남으면 시작하지 않아야 한다 - 도중에 한도를 넘기면 그 실패가 매체 탓으로 기록된다');
});

test('재시도 실행은 하루 상한을 넘어설 수 있다', async () => {
  const db = fakeDb({
    anthropic_calls_today: DAILY_ANTHROPIC_CALL_LIMIT,
    anthropic_calls_today_baduk: DAILY_ANTHROPIC_CALL_LIMIT
  });
  const normal = createCallBudget(envWith(db), {});
  assert.equal(await normal.reserveAnthropic('baduk'), false);

  const forced = createCallBudget(envWith(db), {}, { forceRetry: true });
  assert.equal(await forced.reserveAnthropic('baduk'), true,
    'force_retry는 상한이 찬 날을 사람이 직접 푸는 손잡이다');
});
