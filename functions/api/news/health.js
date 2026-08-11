import { json } from '../../_lib/news-db.js';
import { CLAUDE_MONTHLY_HARD_LIMIT_MICRO_USD, dailyAllowanceMicroUsd } from '../../_lib/news-ai-budget.js';
import { sharesTitleKeywords } from '../../_lib/news-dedup.js';

function utcMillis(value) {
  const text = String(value || '');
  const parsed = Date.parse(/Z$|[+-]\d\d:\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}Z`);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function onRequestGet({ env }) {
  try {
    const [run, automaticRun, counts, missingTime, stateRows, exhausted, storageResult, badukStored,
      badukPortal, recentRuns, paidSameDay] = await Promise.all([
      env.DB.prepare('SELECT started_at,finished_at,status,message FROM news_runs ORDER BY id DESC LIMIT 1').first(),
      env.DB.prepare(`SELECT started_at,finished_at,status,message FROM news_runs
        WHERE message LIKE '%\"mode\":\"scheduled\"%' OR message LIKE '%\"mode\":\"watchdog\"%'
        ORDER BY id DESC LIMIT 1`).first(),
      env.DB.prepare(`SELECT
        SUM(CASE WHEN category='바둑' THEN 1 ELSE 0 END) AS baduk,
        SUM(CASE WHEN category<>'바둑' THEN 1 ELSE 0 END) AS general
        FROM news_articles WHERE summary_quality='full'
          AND datetime(COALESCE(NULLIF(published_at,''),fetched_at))>=datetime('now','-24 hours')`).first(),
      // 30일 창은 오래전에 한 번 잘못 저장된 행 두 개 때문에 매일 실패했다.
      // 물어야 할 것은 "지금 들어오는 기사에 발행시각이 붙나"이므로 최근 것만
      // 본다. 옛 행은 창을 벗어나 사라지고, 진짜 회귀는 하루 안에 다시 뜬다.
      env.DB.prepare(`SELECT COUNT(*) AS count FROM news_articles
        WHERE summary_quality='full' AND TRIM(published_at)=''
          AND datetime(fetched_at)>=datetime('now','-3 days')`).first(),
      env.DB.prepare(`SELECT key,value FROM news_state WHERE key IN
        ('ai_blocked','claude_monthly_micro_usd','claude_budget_month',
         'claude_daily_micro_usd','claude_spend_day','baduk_source_latest')`).all(),
      // 예전에는 30일 누적을 세어 고정 임계값과 견줬다. 누적은 줄어들 수가
      // 없으므로 한 번 넘어서면 영원히 실패다(실측 73건, 임계값 15). 알고 싶은
      // 것은 "지금도 재시도가 벽에 부딪히고 있나"라는 속도이므로 최근 하루에
      // 새로 상한에 닿은 건수를 센다.
      env.DB.prepare(`SELECT COUNT(*) AS count FROM news_summary_attempts f
        WHERE f.attempts>=6 AND datetime(f.last_attempt)>=datetime('now','-24 hours')`).first(),
      env.DB.prepare('SELECT COUNT(*) AS count FROM news_saved').all(),
      // 한국기원 기사를 어디까지 가져왔는지. 소스 최신 날짜(collect.js가 적는다)와
      // 견주기 위한 값이다.
      env.DB.prepare(`SELECT MAX(date(COALESCE(NULLIF(published_at,''),fetched_at))) AS latest
        FROM news_articles WHERE category='바둑' AND summary_quality='full'
          AND url LIKE '%baduk.or.kr%'`).first(),
      // 한국기원 밖에서 들어온 바둑 기사. 위 badukStored와 baduk_source_latest는
      // 둘 다 baduk.or.kr만 보므로, 포털(네이버·카카오·구글)에서 오는 바둑이
      // 통째로 끊겨도 두 값은 꿈쩍하지 않는다. 2026-08-11이 정확히 그랬다 -
      // 포털 바둑 발행이 하루 종일 0건인데 health는 ok를 반환했다.
      env.DB.prepare(`SELECT COUNT(*) AS count FROM news_articles
        WHERE category='바둑' AND summary_quality='full' AND url NOT LIKE '%baduk.or.kr%'
          AND datetime(COALESCE(NULLIF(published_at,''),fetched_at))>=datetime('now','-24 hours')`).first(),
      // 최근 하루치 수집 실행의 진단. "소스에 있는 걸 우리가 가져왔나"를 바둑
      // 전체에 대해 묻기 위해 후보가 어디서 죽었는지를 본다.
      env.DB.prepare(`SELECT message FROM news_runs
        WHERE datetime(started_at)>=datetime('now','-24 hours') AND message LIKE '%diagnostics%'
        ORDER BY id DESC LIMIT 30`).all(),
      // 같은 날 같은 사건에 3줄 요약을 두 번 산 흔적. 이건 사람이 화면을 보고
      // "왜 카드가 두 장이지"라고 물어야만 드러나던 종류의 고장이다(2026-08-11
      // 노원구 기원 살인). 돈이 새는 쪽이라 조용히 넘어가면 안 된다.
      env.DB.prepare(`SELECT title,
          date(datetime(COALESCE(NULLIF(published_at,''),fetched_at),'+9 hours')) AS day
        FROM news_articles
        WHERE summary_quality='full' AND category<>'바둑'
          AND datetime(COALESCE(NULLIF(published_at,''),fetched_at))>=datetime('now','-24 hours')
        ORDER BY id DESC LIMIT 60`).all()
    ]);
    // 바둑은 세지 않는다. 대회·기사 이름이 매 제목에 반복돼 서로 다른 대국이
    // 쉽게 3단어를 넘긴다(news-dedup.js의 같은 이유로 수집에서도 안 건다).
    const paidRows = (paidSameDay?.results || []).filter(row => row.day && row.title);
    let duplicatePaidPairs = 0;
    const duplicatePaidSample = [];
    for (let i = 0; i < paidRows.length; i += 1) {
      for (let j = i + 1; j < paidRows.length; j += 1) {
        if (paidRows[i].day !== paidRows[j].day) continue;
        if (!sharesTitleKeywords(paidRows[i].title, paidRows[j].title)) continue;
        duplicatePaidPairs += 1;
        if (duplicatePaidSample.length < 3) {
          duplicatePaidSample.push(`${paidRows[i].title.slice(0, 26)} / ${paidRows[j].title.slice(0, 26)}`);
        }
      }
    }
    // 바둑 후보를 실제로 처리했는데 본문 단계에서 줄줄이 죽었는지 센다. 발행
    // 건수만으로는 "조용한 날"과 "고장난 날"이 구분되지 않는다 - 한국기원이
    // 2~4일에 한 번 올린다는 이유로 예전 24시간 검사가 삭제된 것도 그래서다.
    // 시도 자체가 없었으면 이 값들이 0이라 아래 검사가 울리지 않는다.
    let badukBodyTooShort = 0;
    let badukPublishedByRuns = 0;
    for (const row of recentRuns?.results || []) {
      let outcomes = null;
      try {
        outcomes = JSON.parse(String(row.message || '') || '{}')?.diagnostics?.candidate_outcomes_by_category?.baduk;
      } catch { continue; }
      if (!outcomes) continue;
      badukBodyTooShort += Number(outcomes.body_too_short || 0);
      badukPublishedByRuns += Number(outcomes.inserted_publishable || 0)
        + Number(outcomes.inserted_duplicate || 0) + Number(outcomes.existing_repaired || 0);
    }
    const state = Object.fromEntries((stateRows.results || []).map(row => [row.key, row.value]));
    const now = new Date();
    const monthlySpend = Number(state.claude_monthly_micro_usd || 0);
    const dailySpend = String(state.claude_spend_day || '') === now.toISOString().slice(0, 10)
      ? Number(state.claude_daily_micro_usd || 0) : 0;
    // 하루치 페이스는 계속 보여주되 실패 조건에서는 뺐다. 이 값이 호출을
    // 막던 동안 요약이 낮에 끊겨 바둑 발행이 0이 됐다. 지출 속도를 눈으로
    // 보는 용도로만 남긴다 - 차단은 월 목표/하드 한도가 한다.
    const dailyAllowance = dailyAllowanceMicroUsd(monthlySpend - dailySpend, now);
    const finishedAgeHours = run?.finished_at ? (Date.now() - utcMillis(run.finished_at)) / 3600000 : Infinity;
    const automaticAgeHours = automaticRun?.finished_at ? (Date.now() - utcMillis(automaticRun.finished_at)) / 3600000 : Infinity;
    const databaseBytes = Number(storageResult.meta?.size_after || 0);
    const databaseStoragePercent = databaseBytes > 0 ? databaseBytes / (500 * 1024 * 1024) * 100 : null;
    // 둘 다 'YYYY-MM-DD' 라 문자열 비교로 날짜 비교가 된다. 소스 날짜를 아직 한
    // 번도 적지 못했으면(배포 직후 등) 비교하지 않고 통과시킨다 - 값이 없다는
    // 이유로 알람을 울리면 그 알람이 또 무시된다.
    const badukSourceLatest = String(state.baduk_source_latest || '');
    const badukStoredLatest = String(badukStored?.latest || '');
    const checks = {
      // A degraded run means an optional provider failed, not that the feed or
      // database is unavailable. Freshness checks below still catch real loss.
      last_run_ok: run?.status === 'ok' || run?.status === 'degraded',
      last_run_within_6h: finishedAgeHours <= 6,
      automatic_run_within_4h: automaticAgeHours <= 4,
      general_has_recent_news: Number(counts?.general || 0) > 0,
      // 예전 이름은 baduk_has_recent_news 였고 baduk_24h > 0 을 요구했다. 바둑
      // 소스가 2~4일에 한 번 올리므로 조용한 날마다 실패했고(그래서 사람이 손으로
      // 무시하게 됐다), 정작 소스엔 새 글이 있는데 우리가 못 가져온 경우는 지나쳤다.
      // 창을 넓히는 것은 답이 아니다 - 8/9의 간격이 4일이라 72시간으로도 실패하고,
      // 120시간으로 늘리면 닷새간 수집이 죽어도 조용하다. 물을 것은 기간이 아니라
      // "소스에 있는 걸 우리가 가져왔나"다.
      baduk_source_collected: !badukSourceLatest
        || (badukStoredLatest && badukStoredLatest >= badukSourceLatest),
      // 위 검사는 baduk.or.kr만 본다. 포털에서 오는 바둑이 통째로 끊기는 고장은
      // 그 검사에 안 잡히므로(2026-08-11 실측) 따로 묻는다. 묻는 것은 "오늘
      // 바둑이 있나"가 아니라 "가져오려고 했는데 실패했나"다 - 전자는 조용한
      // 날마다 틀려서 사람이 무시하게 되고, 그래서 예전에 삭제됐다.
      //
      // 임계값 6은 하루치 합계다. 실패가 몇 건 섞이는 것은 정상이고(차단·유료
      // 지면·삭제된 기사), 추출이 진짜 망가지면 그날 두 자리로 뛴다. 2026-08-11:
      // body_too_short 12건에 발행 0건이었다. 하나라도 실린 날은 통과시킨다 -
      // 경로가 살아 있다는 뜻이고, 개별 매체 실패까지 알람으로 만들면 또 무시된다.
      baduk_body_fetch_healthy: badukBodyTooShort < 6 || badukPublishedByRuns > 0,
      // 같은 날 같은 사건에 유료 요약을 두 번 이상 산 흔적. 1쌍은 오판정 여지를
      // 두고 넘긴다(키워드 3개는 우연히도 걸린다). 2쌍부터는 중복 판정이 실제로
      // 새고 있다는 뜻이고, 그건 곧바로 돈이다.
      duplicate_paid_summaries_low: duplicatePaidPairs < 2,
      // 0을 요구하면 발행시각을 아예 안 내는 매체가 한 곳만 걸려도 실패한다.
      // 추출이 망가지면 이 값은 몇 건이 아니라 수십 건으로 뛰므로 여유를 둔다.
      published_time_healthy: Number(missingTime?.count || 0) <= 3,
      cloudflare_not_provider_blocked: Number(state.ai_blocked || 0) === 0,
      claude_under_hard_limit: monthlySpend < CLAUDE_MONTHLY_HARD_LIMIT_MICRO_USD,
      // 하루에 새로 재시도 상한에 닿은 건수. 누적이 아니라 속도를 본다(위 쿼리 주석).
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
        baduk_source_latest: badukSourceLatest || null,
        baduk_stored_latest: badukStoredLatest || null,
        // baduk_24h는 한국기원까지 포함한 값이라, 포털만 끊겼을 때 한국기원
        // 한 건에 가려진다. 나눠서 보여준다.
        baduk_portal_24h: Number(badukPortal?.count || 0),
        baduk_body_too_short_24h: badukBodyTooShort,
        duplicate_paid_pairs_24h: duplicatePaidPairs,
        duplicate_paid_samples: duplicatePaidSample,
        baduk_published_by_runs_24h: badukPublishedByRuns,
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
