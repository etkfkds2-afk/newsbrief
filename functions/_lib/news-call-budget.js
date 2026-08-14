// 한 번의 수집 실행이 밖으로 나가는 모든 호출을 한 곳에서 센다.
//
// 왜 모았나. 2026-08-14에 같은 종류의 고장이 하루에 세 번 났다:
//   - 요약이 실패하면 Cloudflare AI로 한 번 더 나가는데 1로 세고 있었다
//   - 중복 판정(findDuplicateStories)은 계수기를 아예 안 지났다
//   - 본문 수집은 세는데 검색·순위 수집은 안 셌다
// 전부 "세는 자리가 여러 군데라 하나를 빠뜨린" 것이다. 셈이 틀리면 Worker의
// 외부 요청 한도(50)를 넘기고, 넘긴 뒤에 죽은 후보는 그 매체의 본문 실패로
// 기록된다 - 우리 쪽 한도를 매체 고장으로 오진하게 된다.
//
// 그래서 여기서는 **호출하는 방법이 이 객체를 지나는 것 하나뿐**이 되게 한다.
// 새 외부 호출을 추가하면서 계수를 빠뜨리려면 이 파일을 고쳐야 하고, 그러면
// 눈에 띈다.
import {
  blockCloudflareForToday, canUseClaude, koreaDayKey, reserveCloudflareCall
} from './news-ai-budget.js';

// Worker 한 번 호출이 쓸 수 있는 외부 요청은 50이다. 44로 잡아 여유를 둔다 -
// 재시도나 리다이렉트로 실제 요청이 하나 더 나가는 경우가 있다.
export const SUBREQUEST_BUDGET = 44;

// 후보 하나가 최악의 경우 쓰는 양: 본문 2회(원주소 + 미러) + 요약 2회(Anthropic
// 실패 시 Cloudflare). 그만큼 안 남았으면 시작하지 않는다.
export const SUBREQUESTS_PER_CANDIDATE = 4;

export const DAILY_ANTHROPIC_CALL_LIMIT = 60;

// 바둑이 이 서비스의 메인이다. "바둑 쓰고 남은 걸 일반에 쓴다"가 요구사항인데
// 예전 배분(바둑 20 / 일반 40)은 그 반대였다 - 일반이 먼저 처리되므로 2026-08-14
// 실측으로 오전 11시에 일반이 39건을 써서 총량이 바닥났고, 그 뒤 바둑 요약이
// 기준 미달로 내려갔을 때 다시 살 호출이 없어 그날 바둑 화면이 0건이 됐다.
//
// 총량 60은 그대로다. 바꾼 것은 몫뿐이라 하루 최대 지출은 같다.
// - 일반: 24가 하드 상한. 이 위로는 바둑 몫이라 못 넘본다.
// - 바둑: 자기 상한이 없다(총량까지). 최소 36은 언제나 남는다.
export const BADUK_RESERVED_ANTHROPIC_CALLS = 36;
export const GENERAL_DAILY_ANTHROPIC_CALL_LIMIT =
  DAILY_ANTHROPIC_CALL_LIMIT - BADUK_RESERVED_ANTHROPIC_CALLS;

// 부스트는 사람이 손으로 누르는 버튼이라 총량도 같이 올린다 - 일반 몫만 올리고
// 총량을 60에 두면 부스트가 바둑 예약분을 먹는다.
export const GENERAL_BOOST_ANTHROPIC_CALL_LIMIT = GENERAL_DAILY_ANTHROPIC_CALL_LIMIT + 24;
export const GENERAL_BOOST_DAILY_CEILING = DAILY_ANTHROPIC_CALL_LIMIT + 24;
// 사람이 손으로 누르는 복구 실행(force_retry / baduk_now)의 상한.
//
// 200이던 값을 90으로 내린다. 200은 사실상 상한이 없는 것과 같았다 - 2026-08-14
// 실측: 하루 상한 60인 날에 baduk_now를 여러 번 누르자 anthropic_calls_today가
// 146까지 갔고 그날 지출은 $0.46, 설계값 $0.15의 세 배였다. 그러고도 바둑
// 화면은 1건이다. 복구 실행은 상한을 **넓히는** 것이지 없애는 것이 아니다.
//
// 이 값만으로 막지는 않는다. 진짜 관문은 하루 지출 절대선
// (CLAUDE_DAILY_HARD_LIMIT_MICRO_USD)이다 - 모드마다 호출 상한이 다르면 언젠가
// 또 한 모드가 빠져나가지만, 지출은 한 줄로 흐르므로 거기 하나만 막으면 된다.
export const BACKFILL_ANTHROPIC_CALL_LIMIT = 90;
export const ESTIMATED_SUMMARY_CALL_MICRO_USD = 15_000;

// 바둑의 하루가 사실상 끝난 뒤에는 남은 예약분을 일반이 쓴다. 아침에 미리 떼어
// 둔 몫을 밤까지 놀리면 "바둑 쓰고 남은 걸 일반에"가 아니라 그냥 버리는 것이다.
// 한국시간 21시면 그날 바둑 실행이 다 지났다.
const GENERAL_MAY_USE_BADUK_RESERVE_AFTER_KST_HOUR = 21;

export function generalLimitForNow(date = new Date()) {
  const koreaHour = new Date(date.valueOf() + 9 * 3600000).getUTCHours();
  return koreaHour >= GENERAL_MAY_USE_BADUK_RESERVE_AFTER_KST_HOUR
    ? DAILY_ANTHROPIC_CALL_LIMIT
    : GENERAL_DAILY_ANTHROPIC_CALL_LIMIT;
}

// 하루 경계는 한국시간이다. 이 값이 UTC이던 동안 카운터는 아침 9시에 리셋되는데
// 수집은 새벽 0시·3시·6시에 돌아서, 새벽 실행이 통째로 "어제치 소진분"을 물려받아
// 바둑이 한 건도 못 샀다.
async function resetDailyCountersIfNewDay(env) {
  const day = koreaDayKey();
  const dayRow = await env.DB.prepare("SELECT value FROM news_state WHERE key='anthropic_budget_day'").first();
  if (String(dayRow?.value || '') === day) return;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO news_state(key,value) VALUES('anthropic_budget_day',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(day),
    env.DB.prepare("INSERT INTO news_state(key,value) VALUES('anthropic_calls_today',0) ON CONFLICT(key) DO UPDATE SET value=0"),
    env.DB.prepare("INSERT INTO news_state(key,value) VALUES('anthropic_calls_today_baduk',0) ON CONFLICT(key) DO UPDATE SET value=0"),
    env.DB.prepare("INSERT INTO news_state(key,value) VALUES('anthropic_calls_today_general',0) ON CONFLICT(key) DO UPDATE SET value=0")
  ]);
}

export function createCallBudget(env, diagnostics, { forceRetry = false, generalBoost = false } = {}) {
  let subrequestsUsed = 0;

  const spend = (cost = 1) => { subrequestsUsed += cost; };
  const remaining = () => SUBREQUEST_BUDGET - subrequestsUsed;

  return {
    spend,
    remaining,
    used: () => subrequestsUsed,
    // 후보 하나를 시작해도 되는지. 도중에 한도를 넘으면 그 후보는 error_로 죽고
    // 그 실패가 매체 탓으로 기록된다 - 시작하지 않는 편이 낫다.
    canStartCandidate: () => remaining() >= SUBREQUESTS_PER_CANDIDATE,

    // 외부 함수를 계수기에 물려 준다. 순위·아카이브 수집처럼 안에서 여러 번
    // 부르는 것은 비용을 넉넉히 잡는다 - 적게 잡아 넘기는 쪽이 더 나쁘다.
    counted: (fn, cost = 1) => (...args) => { spend(cost); return fn(...args); },

    reserveCloudflare: async () => {
      const reservation = await reserveCloudflareCall(env);
      diagnostics.ai_calls_today = reservation.used;
      if (!reservation.allowed) diagnostics.ai_budget_exhausted = true;
      return reservation.allowed;
    },

    blockCloudflareForToday: async () => {
      await blockCloudflareForToday(env);
      diagnostics.ai_budget_exhausted = true;
      diagnostics.ai_provider_limited = true;
    },

    reserveAnthropic: async (bucket = 'general') => {
      await resetDailyCountersIfNewDay(env);
      const bucketKey = bucket === 'baduk' ? 'anthropic_calls_today_baduk' : 'anthropic_calls_today_general';
      const [totalRow, bucketRow] = await Promise.all([
        env.DB.prepare("SELECT value FROM news_state WHERE key='anthropic_calls_today'").first(),
        env.DB.prepare('SELECT value FROM news_state WHERE key=?').bind(bucketKey).first()
      ]);
      const daily = Number(totalRow?.value || 0);
      const bucketUsed = Number(bucketRow?.value || 0);
      const totalLimit = forceRetry
        ? BACKFILL_ANTHROPIC_CALL_LIMIT
        : (generalBoost ? GENERAL_BOOST_DAILY_CEILING : DAILY_ANTHROPIC_CALL_LIMIT);
      const bucketLimit = forceRetry || bucket === 'baduk'
        ? totalLimit
        : (generalBoost ? GENERAL_BOOST_ANTHROPIC_CALL_LIMIT : generalLimitForNow());
      const budget = await canUseClaude(env, ESTIMATED_SUMMARY_CALL_MICRO_USD);
      const recordCounts = () => {
        diagnostics.anthropic_calls_today = daily;
        diagnostics.anthropic_daily_limit = totalLimit;
        diagnostics.anthropic_calls_by_bucket = {
          ...(diagnostics.anthropic_calls_by_bucket || {}), [bucket]: bucketUsed
        };
        diagnostics.anthropic_bucket_limit = {
          ...(diagnostics.anthropic_bucket_limit || {}), [bucket]: bucketLimit
        };
      };
      if (daily >= totalLimit || bucketUsed >= bucketLimit || !budget.allowed) {
        recordCounts();
        diagnostics.anthropic_budget_exhausted = true;
        // 어느 뚜껑에 걸렸는지 남긴다. 총량인지, 자기 몫인지, 월 예산인지가
        // 구분되지 않으면 다음에 또 원인을 처음부터 찾게 된다.
        // 하루 지출선과 월 예산선을 구분한다. 앞의 것은 내일 00:00 KST에 저절로
        // 풀리고 뒤의 것은 다음 달까지 안 풀린다 - 사람이 봐야 할 대응이 정반대라
        // 'monthly_budget' 하나로 뭉개면 안 된다.
        diagnostics.anthropic_exhausted_reason = budget.blockedBy === 'monthly' ? 'monthly_budget'
          : budget.blockedBy === 'daily' ? 'daily_spend'
          : (daily >= totalLimit ? 'daily_total' : `bucket_${bucket}`);
        diagnostics.claude_monthly_micro_usd = budget.spent;
        diagnostics.claude_daily_micro_usd = budget.today;
        return false;
      }
      await env.DB.batch([
        env.DB.prepare("INSERT INTO news_state(key,value) VALUES('anthropic_calls_today',1) ON CONFLICT(key) DO UPDATE SET value=value+1"),
        env.DB.prepare('INSERT INTO news_state(key,value) VALUES(?,1) ON CONFLICT(key) DO UPDATE SET value=value+1').bind(bucketKey)
      ]);
      recordCounts();
      diagnostics.anthropic_calls_today = daily + 1;
      diagnostics.anthropic_calls_by_bucket[bucket] = bucketUsed + 1;
      return true;
    }
  };
}
