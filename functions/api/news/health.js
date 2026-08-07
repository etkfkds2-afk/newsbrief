import { json } from '../../_lib/news-db.js';
import {
  CLAUDE_MONTHLY_HARD_LIMIT_MICRO_USD, CLAUDE_MONTHLY_TARGET_MICRO_USD, dailyAllowanceMicroUsd
} from '../../_lib/news-ai-budget.js';

function utcMillis(value) {
  const text = String(value || '');
  const parsed = Date.parse(/Z$|[+-]\d\d:\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}Z`);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function onRequestGet({ env }) {
  try {
    const [run, automaticRun, counts, missingTime, stateRows, exhausted, storageResult] = await Promise.all([
      env.DB.prepare('SELECT started_at,finished_at,status,message FROM news_runs ORDER BY id DESC LIMIT 1').first(),
      env.DB.prepare(`SELECT started_at,finished_at,status,message FROM news_runs
        WHERE message LIKE '%\"mode\":\"scheduled\"%' OR message LIKE '%\"mode\":\"watchdog\"%'
        ORDER BY id DESC LIMIT 1`).first(),
      env.DB.prepare(`SELECT
        SUM(CASE WHEN category='바둑' THEN 1 ELSE 0 END) AS baduk,
        SUM(CASE WHEN category<>'바둑' THEN 1 ELSE 0 END) AS general
        FROM news_articles WHERE summary_quality='full'
          AND datetime(COALESCE(NULLIF(published_at,''),fetched_at))>=datetime('now','-24 hours')`).first(),
      env.DB.prepare(`SELECT COUNT(*) AS count FROM news_articles
        WHERE summary_quality='full' AND TRIM(published_at)=''
          AND datetime(fetched_at)>=datetime('now','-30 days')`).first(),
      env.DB.prepare(`SELECT key,value FROM news_state WHERE key IN
        ('ai_blocked','claude_monthly_micro_usd','claude_budget_month',
         'claude_daily_micro_usd','claude_spend_day')`).all(),
      env.DB.prepare(`SELECT COUNT(*) AS count FROM news_summary_attempts f
        JOIN news_articles a ON a.url_key=f.url_key
        WHERE f.attempts>=6 AND datetime(a.fetched_at)>=datetime('now','-30 days')`).first(),
      env.DB.prepare('SELECT COUNT(*) AS count FROM news_saved').all()
    ]);
    const state = Object.fromEntries((stateRows.results || []).map(row => [row.key, row.value]));
    const now = new Date();
    const monthlySpend = Number(state.claude_monthly_micro_usd || 0);
    const dailySpend = String(state.claude_spend_day || '') === now.toISOString().slice(0, 10)
      ? Number(state.claude_daily_micro_usd || 0) : 0;
    const dailyAllowance = dailyAllowanceMicroUsd(monthlySpend - dailySpend, now);
    // 남은 예산을 남은 날짜로 나눈 값이 0에 가까워지면, 월말까지 Claude 요약이
    // 사실상 꺼진다는 뜻이다. 8월에는 이 신호가 없어서 6일 만에 예산의 45%가
    // 나간 것을 아무도 눈치채지 못했다.
    const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
    const finishedAgeHours = run?.finished_at ? (Date.now() - utcMillis(run.finished_at)) / 3600000 : Infinity;
    const automaticAgeHours = automaticRun?.finished_at ? (Date.now() - utcMillis(automaticRun.finished_at)) / 3600000 : Infinity;
    const databaseBytes = Number(storageResult.meta?.size_after || 0);
    const databaseStoragePercent = databaseBytes > 0 ? databaseBytes / (500 * 1024 * 1024) * 100 : null;
    const checks = {
      // A degraded run means an optional provider failed, not that the feed or
      // database is unavailable. Freshness checks below still catch real loss.
      last_run_ok: run?.status === 'ok' || run?.status === 'degraded',
      last_run_within_6h: finishedAgeHours <= 6,
      automatic_run_within_4h: automaticAgeHours <= 4,
      general_has_recent_news: Number(counts?.general || 0) > 0,
      baduk_has_recent_news: Number(counts?.baduk || 0) > 0,
      published_time_complete: Number(missingTime?.count || 0) === 0,
      cloudflare_not_provider_blocked: Number(state.ai_blocked || 0) === 0,
      claude_under_hard_limit: monthlySpend < CLAUDE_MONTHLY_HARD_LIMIT_MICRO_USD,
      claude_daily_allowance_left: dailyAllowance >= CLAUDE_MONTHLY_TARGET_MICRO_USD / daysInMonth / 2,
      // 임계값 5는 재시도 상한이 24이던 시절 기준이다. 상한이 6으로 내려가
      // 같은 기사가 훨씬 빨리 '소진' 상태가 되므로, 실제 값이 쌓이는 것을
      // 보고 다시 조일 때까지 알림이 매일 뜨지 않을 만큼 여유를 둔다.
      summary_exhausted_below_threshold: Number(exhausted?.count || 0) < 15,
      database_storage_below_70_percent: databaseStoragePercent === null || databaseStoragePercent < 70
    };
    const failures = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
    return json({
      ok: failures.length === 0,
      checked_at: new Date().toISOString(),
      failures,
      checks,
      metrics: {
        last_run: run || null,
        last_run_degraded: run?.status === 'degraded',
        last_automatic_run: automaticRun || null,
        finished_age_hours: Number.isFinite(finishedAgeHours) ? Number(finishedAgeHours.toFixed(2)) : null,
        automatic_age_hours: Number.isFinite(automaticAgeHours) ? Number(automaticAgeHours.toFixed(2)) : null,
        general_24h: Number(counts?.general || 0),
        baduk_24h: Number(counts?.baduk || 0),
        missing_published_time: Number(missingTime?.count || 0),
        cloudflare_provider_blocked: Number(state.ai_blocked || 0),
        claude_monthly_micro_usd: monthlySpend,
        claude_budget_month: String(state.claude_budget_month || ''),
        claude_daily_micro_usd: dailySpend,
        claude_daily_allowance_micro_usd: dailyAllowance,
        summary_exhausted: Number(exhausted?.count || 0),
        database_bytes: databaseBytes || null,
        database_storage_percent: databaseStoragePercent === null ? null : Number(databaseStoragePercent.toFixed(2))
      }
    // The endpoint itself is reachable and D1 queries succeeded. Content
    // freshness/quality failures are operational diagnostics, not an HTTP
    // service outage. Returning 503 here made curl, Cloudflare and external
    // monitors retry a healthy endpoint and report misleading server
    // disconnects. Callers should inspect `ok`/`failures`; 503 is reserved for
    // an actual health-check execution failure in the catch block below.
    }, 200);
  } catch (error) {
    return json({ ok: false, failures: ['health_check_error'], error: error.message }, 503);
  }
}
