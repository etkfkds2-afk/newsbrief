// 사용자 예산은 월 5달러다(특정 달만 다르게 보는 예외는 아래 표에 있다).
// 목표치에서 신규 호출을 끊고, 하드 한도는 예산
// 자체에 맞춘다(예전에는 2.50/2.70이라 실제 상한이 2.70달러였다). 목표와
// 하드 사이의 0.25달러는 마지막 한 건이 추정보다 비싸게 끝날 때를 위한 여유다.
//
// 4달러로는 홈 10칸을 매일 채우지 못한다. 8월 실측 기준 유료 호출 3건에
// 기사 1건이 실리므로, 하루 10~12건을 실으려면 32호출 안팎이 필요하고 그게
// 하루 0.15달러다.
export const CLAUDE_MONTHLY_TARGET_MICRO_USD = 4_750_000;
export const CLAUDE_MONTHLY_HARD_LIMIT_MICRO_USD = 5_000_000;
export const CLOUDFLARE_DAILY_CALL_LIMIT = 4;

// 특정 달만 예산을 달리 본다. **이 표에 없는 달은 위 기본값을 쓴다** - 한 달만
// 올리고 다음 달에 되돌리는 것을 잊는 사고를 막으려고 표로 뒀다.
//
// 2026-08: 하루 발행 상한이 유료 요약을 사는 세 경로 중 한 곳에만 걸려 있어서
// (2026-08-11 수정) 월 중반까지 설계값의 두 배를 썼다 - 하루 12건이어야 할 발행이
// 27건이었고 지출도 정확히 두 배인 $0.298/일이었다. 11일 만에 $3.28을 쓴 상태라,
// 누수를 고쳐 $0.15/일로 돌아가도 남은 20일에 $3.0이 더 필요해 $4.75로는 8월
// 21일경 멈춘다. 이번 달만 $7로 보고 끝까지 돌리기로 했다(사용자 결정 2026-08-11).
// 9월은 이 표에 없으므로 자동으로 $4.75/$5.00로 돌아간다.
const MONTHLY_BUDGET_OVERRIDES = {
  '2026-08': { target: 6_750_000, hard: 7_000_000 }
};

export function claudeMonthlyTargetMicroUsd(date = new Date()) {
  return MONTHLY_BUDGET_OVERRIDES[monthKey(date)]?.target ?? CLAUDE_MONTHLY_TARGET_MICRO_USD;
}

export function claudeMonthlyHardLimitMicroUsd(date = new Date()) {
  return MONTHLY_BUDGET_OVERRIDES[monthKey(date)]?.hard ?? CLAUDE_MONTHLY_HARD_LIMIT_MICRO_USD;
}

const PRICES = {
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
  // Use the post-introductory Sonnet 5 price so the budget remains safe after
  // the temporary 2026 discount ends.
  'claude-sonnet-5': { input: 3, output: 15 }
};

// 날짜 경계는 전부 한국시간으로 센다. 예전에는 toISOString()의 UTC 날짜를 썼는데,
// UTC 자정은 한국시간 오전 9시다. 그래서 하루 호출 카운터가 아침 9시에 리셋됐고,
// 새벽 수집(KST 00:17/03:17/06:17)은 언제나 "어제 UTC 하루"의 꼬리에 걸려 이미
// 60/60으로 소진된 카운터를 봤다. 실측 2026-08-12 07:08 KST 자동 실행:
// anthropic_calls_today 60/60, anthropic_budget_exhausted=true, 바둑 발행 0건.
//
// 발행 상한은 이미 KST 기준이었다(collect.js의 dayStart). 한쪽은 "오늘 아직 0건
// 실었으니 채워라"라고 하고 다른 쪽은 "오늘 예산 다 썼다"라고 하는 어긋남이
// 매일 아침 재현되던 고장의 정체다. 두 경계를 같은 하루로 맞춘다.
const KST_OFFSET_MS = 9 * 3600000;

export function koreaDayKey(date = new Date()) {
  return new Date(date.valueOf() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

export function koreaMonthKey(date = new Date()) {
  return new Date(date.valueOf() + KST_OFFSET_MS).toISOString().slice(0, 7);
}

function monthKey(date = new Date()) {
  return koreaMonthKey(date);
}

function dayKey(date = new Date()) {
  return koreaDayKey(date);
}

// 월 예산을 남은 날짜로 나눈 하루치 페이스. 2026-08-09부터 이 값은 **표시
// 전용**이고 호출을 막지 않는다. canUseClaude의 관문으로 쓰던 동안 하루 한도
// ($0.12)에 걸려 요약이 낮에 끊겼고, 그 뒤로 들어온 기사는 요약 없이
// pending_summary로 쌓였다. 바둑은 서브리퀘스트 고갈에서 살아남는 후보가
// 애초에 두어 건뿐이라 그 두어 건이 잘리자 하루 발행이 0이 됐다.
// 사용자 판단: 월 예산을 넘기더라도 기사가 끊기지 않는 쪽을 택한다. 월
// 목표/하드 한도는 그대로 남아 있으므로 지출이 무한정 늘지는 않는다.
export function dailyAllowanceMicroUsd(spentBeforeToday, date = new Date()) {
  // 달력도 한국시간으로 센다. 하루·한 달 경계를 KST로 옮겼는데 여기만 UTC를 보면
  // 매달 1일 오전 9시 이전에 "남은 날"이 하루 더 많게 나온다. 표시 전용 값이지만
  // 계기판이 어긋나는 것을 보고 또 원인을 찾게 된다.
  const korea = new Date(date.valueOf() + KST_OFFSET_MS);
  const daysInMonth = new Date(Date.UTC(korea.getUTCFullYear(), korea.getUTCMonth() + 1, 0)).getUTCDate();
  const daysLeft = Math.max(1, daysInMonth - korea.getUTCDate() + 1);
  const remaining = Math.max(0, claudeMonthlyTargetMicroUsd(date) - Math.max(0, spentBeforeToday));
  return Math.floor(remaining / daysLeft);
}

export function claudeCostMicroUsd(model, usage = {}) {
  const price = PRICES[model];
  if (!price) return 0;
  const input = Number(usage.input_tokens || 0);
  const output = Number(usage.output_tokens || 0);
  return Math.ceil(input * price.input + output * price.output);
}

export async function getClaudeMonthlySpend(env) {
  const month = monthKey();
  const monthRow = await env.DB.prepare("SELECT value FROM news_state WHERE key='claude_budget_month'").first();
  if (String(monthRow?.value || '') !== month) {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO news_state(key,value) VALUES('claude_budget_month',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(month),
      env.DB.prepare("INSERT INTO news_state(key,value) VALUES('claude_monthly_micro_usd',0) ON CONFLICT(key) DO UPDATE SET value=0")
    ]);
    return 0;
  }
  const row = await env.DB.prepare("SELECT value FROM news_state WHERE key='claude_monthly_micro_usd'").first();
  return Number(row?.value || 0);
}

export async function getClaudeDailySpend(env) {
  const day = dayKey();
  const dayRow = await env.DB.prepare("SELECT value FROM news_state WHERE key='claude_spend_day'").first();
  if (String(dayRow?.value || '') !== day) {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO news_state(key,value) VALUES('claude_spend_day',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(day),
      env.DB.prepare("INSERT INTO news_state(key,value) VALUES('claude_daily_micro_usd',0) ON CONFLICT(key) DO UPDATE SET value=0")
    ]);
    return 0;
  }
  const row = await env.DB.prepare("SELECT value FROM news_state WHERE key='claude_daily_micro_usd'").first();
  return Number(row?.value || 0);
}

export async function canUseClaude(env, estimatedMicroUsd = 0) {
  const spent = await getClaudeMonthlySpend(env);
  const today = await getClaudeDailySpend(env);
  const allowance = dailyAllowanceMicroUsd(spent - today);
  // 하루치 페이싱은 관문에서 뺐다(위 dailyAllowanceMicroUsd 주석 참고).
  // today/allowance는 health가 그대로 보여주되 차단은 하지 않는다.
  return {
    allowed: spent < claudeMonthlyTargetMicroUsd()
      && spent + Math.max(0, estimatedMicroUsd) <= claudeMonthlyHardLimitMicroUsd(),
    spent,
    today,
    allowance
  };
}

// 호출 전에 예상 비용을 먼저 적어 두고, 끝난 뒤 차액으로 정산한다.
// recordClaudeUsage는 호출이 끝난 뒤에만 돌기 때문에, 응답을 돌려주지 못하고
// 죽은 실행은 돈을 쓰고도 기록에 안 남는다. 2026-08-10 실측: 이슈 재분류가
// 실제 $0.91을 썼는데 예산에는 $0.041만 잡혔다. 계기판이 실제 지출의 20분의
// 1을 보여주고 있었고, 월 $4.75 관리가 그만큼 헛돌았다.
//
// 미리 적는 쪽이 안전하다. 죽으면 예상치가 남아 과다 계상되지만, 그건 다음
// 호출을 일찍 막을 뿐이다. 반대 방향의 실수는 예산을 조용히 넘긴다.
export async function reserveClaudeSpend(env, estimatedMicroUsd = 0) {
  const amount = Math.max(0, Math.round(estimatedMicroUsd));
  if (!amount) return 0;
  await getClaudeMonthlySpend(env);
  await getClaudeDailySpend(env);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO news_state(key,value) VALUES('claude_monthly_micro_usd',?) ON CONFLICT(key) DO UPDATE SET value=value+excluded.value").bind(amount),
    env.DB.prepare("INSERT INTO news_state(key,value) VALUES('claude_daily_micro_usd',?) ON CONFLICT(key) DO UPDATE SET value=value+excluded.value").bind(amount)
  ]);
  return amount;
}

// 미리 적어 둔 예상치와 실제 비용의 차액만 반영한다. 차액이 음수면 되돌린다.
export async function settleClaudeSpend(env, reservedMicroUsd, model, usage = {}) {
  const actual = claudeCostMicroUsd(model, usage);
  const delta = actual - Math.max(0, Math.round(reservedMicroUsd || 0));
  if (delta) {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO news_state(key,value) VALUES('claude_monthly_micro_usd',?) ON CONFLICT(key) DO UPDATE SET value=MAX(0,value+excluded.value)").bind(delta),
      env.DB.prepare("INSERT INTO news_state(key,value) VALUES('claude_daily_micro_usd',?) ON CONFLICT(key) DO UPDATE SET value=MAX(0,value+excluded.value)").bind(delta)
    ]);
  }
  const row = await env.DB.prepare("SELECT value FROM news_state WHERE key='claude_monthly_micro_usd'").first();
  return { cost: actual, spent: Number(row?.value || 0) };
}

export async function recordClaudeUsage(env, model, usage = {}) {
  const cost = claudeCostMicroUsd(model, usage);
  if (!cost) return { cost: 0, spent: await getClaudeMonthlySpend(env) };
  await getClaudeMonthlySpend(env);
  await getClaudeDailySpend(env);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO news_state(key,value) VALUES('claude_monthly_micro_usd',?) ON CONFLICT(key) DO UPDATE SET value=value+excluded.value").bind(cost),
    env.DB.prepare("INSERT INTO news_state(key,value) VALUES('claude_daily_micro_usd',?) ON CONFLICT(key) DO UPDATE SET value=value+excluded.value").bind(cost)
  ]);
  const row = await env.DB.prepare("SELECT value FROM news_state WHERE key='claude_monthly_micro_usd'").first();
  return { cost, spent: Number(row?.value || 0) };
}

export async function reserveCloudflareCall(env) {
  if (!env?.AI) return { allowed: false, used: 0, reason: 'not-bound' };
  const day = new Date().toISOString().slice(0, 10);
  const dayRow = await env.DB.prepare("SELECT value FROM news_state WHERE key='ai_budget_day'").first();
  if (String(dayRow?.value || '') !== day) {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO news_state(key,value) VALUES('ai_budget_day',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(day),
      env.DB.prepare("INSERT INTO news_state(key,value) VALUES('ai_calls_today',0) ON CONFLICT(key) DO UPDATE SET value=0"),
      env.DB.prepare("INSERT INTO news_state(key,value) VALUES('ai_blocked',0) ON CONFLICT(key) DO UPDATE SET value=0")
    ]);
  }
  const [blockedRow, callsRow] = await Promise.all([
    env.DB.prepare("SELECT value FROM news_state WHERE key='ai_blocked'").first(),
    env.DB.prepare("SELECT value FROM news_state WHERE key='ai_calls_today'").first()
  ]);
  const used = Number(callsRow?.value || 0);
  if (Number(blockedRow?.value || 0)) return { allowed: false, used, reason: 'blocked' };
  if (used >= CLOUDFLARE_DAILY_CALL_LIMIT) return { allowed: false, used, reason: 'daily-limit' };
  await env.DB.prepare("INSERT INTO news_state(key,value) VALUES('ai_calls_today',1) ON CONFLICT(key) DO UPDATE SET value=value+1").run();
  return { allowed: true, used: used + 1, reason: '' };
}

export async function blockCloudflareForToday(env) {
  await env.DB.prepare("INSERT INTO news_state(key,value) VALUES('ai_blocked',1) ON CONFLICT(key) DO UPDATE SET value=1").run();
}
