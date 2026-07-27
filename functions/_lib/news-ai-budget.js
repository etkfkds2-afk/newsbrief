export const CLAUDE_MONTHLY_TARGET_MICRO_USD = 1_700_000;
export const CLAUDE_MONTHLY_HARD_LIMIT_MICRO_USD = 1_900_000;
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

export async function canUseClaude(env, estimatedMicroUsd = 0) {
  const spent = await getClaudeMonthlySpend(env);
  return {
    allowed: spent < CLAUDE_MONTHLY_TARGET_MICRO_USD
      && spent + Math.max(0, estimatedMicroUsd) <= CLAUDE_MONTHLY_HARD_LIMIT_MICRO_USD,
    spent
  };
}

export async function recordClaudeUsage(env, model, usage = {}) {
  const cost = claudeCostMicroUsd(model, usage);
  if (!cost) return { cost: 0, spent: await getClaudeMonthlySpend(env) };
  await getClaudeMonthlySpend(env);
  await env.DB.prepare("INSERT INTO news_state(key,value) VALUES('claude_monthly_micro_usd',?) ON CONFLICT(key) DO UPDATE SET value=value+excluded.value")
    .bind(cost).run();
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
