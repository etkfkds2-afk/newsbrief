import { json } from '../../_lib/news-db.js';
import { CLAUDE_MONTHLY_HARD_LIMIT_MICRO_USD } from '../../_lib/news-ai-budget.js';

function utcMillis(value) {
  const text = String(value || '');
  const parsed = Date.parse(/Z$|[+-]\d\d:\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}Z`);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function onRequestGet({ env }) {
  try {
    const [run, automaticRun, counts, missingTime, stateRows, exhausted] = await Promise.all([
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
        ('ai_blocked','claude_monthly_micro_usd','claude_budget_month')`).all(),
      env.DB.prepare(`SELECT COUNT(*) AS count FROM news_summary_attempts f
        JOIN news_articles a ON a.url_key=f.url_key
        WHERE f.attempts>=24 AND datetime(a.fetched_at)>=datetime('now','-30 days')`).first()
    ]);
    const state = Object.fromEntries((stateRows.results || []).map(row => [row.key, row.value]));
    const finishedAgeHours = run?.finished_at ? (Date.now() - utcMillis(run.finished_at)) / 3600000 : Infinity;
    const automaticAgeHours = automaticRun?.finished_at ? (Date.now() - utcMillis(automaticRun.finished_at)) / 3600000 : Infinity;
    const checks = {
      last_run_ok: run?.status === 'ok',
      last_run_within_6h: finishedAgeHours <= 6,
      automatic_run_within_4h: automaticAgeHours <= 4,
      general_has_recent_news: Number(counts?.general || 0) > 0,
      baduk_has_recent_news: Number(counts?.baduk || 0) > 0,
      published_time_complete: Number(missingTime?.count || 0) === 0,
      cloudflare_not_provider_blocked: Number(state.ai_blocked || 0) === 0,
      claude_under_hard_limit: Number(state.claude_monthly_micro_usd || 0) < CLAUDE_MONTHLY_HARD_LIMIT_MICRO_USD,
      summary_exhausted_below_threshold: Number(exhausted?.count || 0) < 5
    };
    const failures = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
    return json({
      ok: failures.length === 0,
      checked_at: new Date().toISOString(),
      failures,
      checks,
      metrics: {
        last_run: run || null,
        last_automatic_run: automaticRun || null,
        finished_age_hours: Number.isFinite(finishedAgeHours) ? Number(finishedAgeHours.toFixed(2)) : null,
        automatic_age_hours: Number.isFinite(automaticAgeHours) ? Number(automaticAgeHours.toFixed(2)) : null,
        general_24h: Number(counts?.general || 0),
        baduk_24h: Number(counts?.baduk || 0),
        missing_published_time: Number(missingTime?.count || 0),
        cloudflare_provider_blocked: Number(state.ai_blocked || 0),
        claude_monthly_micro_usd: Number(state.claude_monthly_micro_usd || 0),
        claude_budget_month: String(state.claude_budget_month || ''),
        summary_exhausted: Number(exhausted?.count || 0)
      }
    }, failures.length ? 503 : 200);
  } catch (error) {
    return json({ ok: false, failures: ['health_check_error'], error: error.message }, 503);
  }
}
