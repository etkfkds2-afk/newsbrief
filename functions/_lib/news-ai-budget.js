// 사용자 예산은 월 5달러다. 목표치에서 신규 호출을 끊고, 하드 한도는 예산
// 자체에 맞춘다(예전에는 2.50/2.70이라 실제 상한이 2.70달러였다). 목표와
// 하드 사이의 0.25달러는 마지막 한 건이 추정보다 비싸게 끝날 때를 위한 여유다.
//
// 4달러로는 홈 10칸을 매일 채우지 못한다. 8월 실측 기준 유료 호출 3건에
// 기사 1건이 실리므로, 하루 10~12건을 실으려면 32호출 안팎이 필요하고 그게
// 하루 0.15달러다.
export const CLAUDE_MONTHLY_TARGET_MICRO_USD = 4_750_000;
export const CLAUDE_MONTHLY_HARD_LIMIT_MICRO_USD = 5_000_000;
export const CLOUDFLARE_DAILY_CALL_LIMIT = 4;

const PRICES = {
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
  // Use the post-introductory Sonnet 5 price so the budget remains safe after
  // the temporary 2026 discount ends.
  'claude-sonnet-5': { input: 3, output: 15 }
};

function monthKey(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

// 월 예산을 남은 날짜로 나눠 하루치 한도를 만든다. 고정 호출 횟수(예전 하루
// 60회)로 막으면 한 건의 실제 단가를 알아야 하는데, 요약 원문 길이와 이슈
// 분류 출력 길이에 따라 단가가 몇 배씩 흔들린다. 그래서 8월에는 6일 만에
// 1.71달러를 써서 예산의 45%가 사라졌고, 이대로면 중순에 Claude가 꺼진
// 채로 보름을 보내게 된다. 남은 예산 기준으로 매일 다시 계산하면 단가를
// 몰라도 월말까지 균등하게 버티고, 적게 쓴 날의 몫은 다음 날로 넘어간다.
export function dailyAllowanceMicroUsd(spentBeforeToday, date = new Date()) {
  const daysInMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  const daysLeft = Math.max(1, daysInMonth - date.getUTCDate() + 1);
  const remaining = Math.max(0, CLAUDE_MONTHLY_TARGET_MICRO_USD - Math.max(0, spentBeforeToday));
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
  return {
    allowed: spent < CLAUDE_MONTHLY_TARGET_MICRO_USD
      && spent + Math.max(0, estimatedMicroUsd) <= CLAUDE_MONTHLY_HARD_LIMIT_MICRO_USD
      && today < allowance,
    spent,
    today,
    allowance
  };
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
