import { json } from '../../_lib/news-db.js';
import { d1DailyReadLimit, d1RowsReadToday, meterD1 } from '../../_lib/news-d1-meter.js';
import {
  claudeMonthlyHardLimitMicroUsd, claudeMonthlyTargetMicroUsd, dailyAllowanceMicroUsd, koreaDayKey
} from '../../_lib/news-ai-budget.js';
import { sharesTitleKeywords } from '../../_lib/news-dedup.js';
import { BADUK_PROMO_TITLE_PATTERNS } from '../../_lib/news-blocklist.js';
import { BADUK_TAB_FILTER, CONTENT_QUALITY_FILTERS } from './articles.js';
// 바둑 예약분. 굶주림 판정이 수집 쪽 상수와 어긋나면 그 알람은 거짓말이 된다.
import { BADUK_RESERVED_ANTHROPIC_CALLS } from './collect.js';
import { isBadukDisplayRelevant } from '../../_lib/baduk-relevance.js';

function utcMillis(value) {
  const text = String(value || '');
  const parsed = Date.parse(/Z$|[+-]\d\d:\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}Z`);
  return Number.isFinite(parsed) ? parsed : 0;
}

// 조건별 탈락 건수를 세는 SELECT 열. 중첩 템플릿 리터럴 안에서 만들면 정적
// 참조 검사기가 SQL의 SUM/NOT을 자바스크립트 호출로 읽는다 - 밖에서 문자열로 잇는다.
const filterHitColumns = CONTENT_QUALITY_FILTERS
  .map((filter, index) => 'SUM(CASE WHEN NOT (' + filter + ') THEN 1 ELSE 0 END) AS f' + index)
  .join(', ');

export async function onRequestGet({ env }) {
  // health 는 막지 않는다 - 퓨즈가 걸렸는지 알려 주는 곳이 health 다. 대신 자기 읽기도 장부에 넣는다.
  const d1ReadToday = await d1RowsReadToday(env);
  const d1ReadLimit = d1DailyReadLimit(env);
  const meter = meterD1(env);
  env = meter.env;
  try {
    const [run, automaticRun, counts, missingTime, dateOnlyTime, futureTime, stateRows, exhausted, storageResult, badukStored,
      badukPortal, recentRuns, paidSameDay, badukTitles, badukFilterHits, brokenUrls] = await Promise.all([
      env.DB.prepare('SELECT started_at,finished_at,status,message FROM news_runs ORDER BY id DESC LIMIT 1').first(),
      env.DB.prepare(`SELECT started_at,finished_at,status,message FROM news_runs
        WHERE message LIKE '%\"mode\":\"scheduled\"%' OR message LIKE '%\"mode\":\"watchdog\"%'
        ORDER BY id DESC LIMIT 1`).first(),
      // 바둑/일반을 가르는 기준은 **화면과 같아야 한다.** 예전에는 category='바둑'
      // 만 셌는데, 바둑 탭은 제목에 '바둑'이 든 다른 분류 기사도 함께 싣는다.
      // 그래서 화면에는 여러 장이 떠 있는데 health는 "24시간 바둑 1건"이라고
      // 보고했다(2026-08-14). 진단이 화면과 다른 것을 세면 그 숫자로 내리는
      // 판단이 전부 틀어진다.
      env.DB.prepare(`SELECT
        SUM(CASE WHEN ${BADUK_TAB_FILTER} THEN 1 ELSE 0 END) AS baduk,
        SUM(CASE WHEN a.category<>'바둑' THEN 1 ELSE 0 END) AS general
        FROM news_articles a WHERE a.summary_quality='full'
          AND datetime(COALESCE(NULLIF(a.published_at,''),a.fetched_at))>=datetime('now','-24 hours')`).first(),
      // 30일 창은 오래전에 한 번 잘못 저장된 행 두 개 때문에 매일 실패했다.
      // 물어야 할 것은 "지금 들어오는 기사에 발행시각이 붙나"이므로 최근 것만
      // 본다. 옛 행은 창을 벗어나 사라지고, 진짜 회귀는 하루 안에 다시 뜬다.
      env.DB.prepare(`SELECT COUNT(*) AS count FROM news_articles
        WHERE summary_quality='full' AND TRIM(published_at)=''
          AND datetime(fetched_at)>=datetime('now','-3 days')`).first(),
      // 날짜만 있고 **시각이 없는** 행. 위 검사는 published_at이 통째로 빈 것만
      // 셌기 때문에 'YYYY-MM-DD'로 저장된 행은 전부 통과였다 - 2026-08-14 실측:
      // missing_published_time은 0인데 사용자는 "시간 안 나오는 카드가 많다"고
      // 했고, 실제로 화면(newsbrief.html의 fmt)은 그런 값을 "8. 14."로 그린다.
      // health가 "발행시각이 붙나"를 물으면서 정작 화면이 시각을 못 그리는
      // 경우를 안 세고 있었던 것이다. 물어야 할 것은 단계가 아니라 결과다.
      //
      // 한국기원(baduk.or.kr)은 뺀다. 그쪽은 목록에 날짜만 싣고 시각을 아예
      // 내지 않으므로 날짜만 남는 것이 **정상**이다(사용자 확인 2026-08-14).
      // 넣어 두면 조용한 날마다 울리고, 그렇게 울린 알람은 곧 무시된다.
      // 원문을 확인해 본 행은 뺀다. 날짜만 싣는 매체가 있는 것은 고장이 아니라
      // 사실이고, 그걸 계속 세면 이 검사는 영영 안 꺼지는 알람이 된다. 안 꺼지는
      // 알람은 곧 무시되고 그러면 진짜 고장도 같이 묻힌다(177통 전례).
      // 남는 것은 "날짜만 있는데 아직 확인도 못 한" 행이고, 복구가 매 실행
      // 조금씩 확인하므로 정상이면 0으로 수렴한다. 추출이 망가지면 새로 들어온
      // 행이 확인 전 상태로 쌓이므로 이 값이 다시 뛴다.
      env.DB.prepare(`SELECT COUNT(*) AS count FROM news_articles a
        WHERE a.summary_quality='full' AND a.published_at GLOB '????-??-??'
          AND a.url NOT LIKE '%baduk.or.kr%'
          AND NOT EXISTS(SELECT 1 FROM news_time_checks t WHERE t.url_key=a.url_key)
          AND datetime(a.fetched_at)>=datetime('now','-3 days')`).first(),
      // 발행시각이 **미래**인 행. 시각을 못 읽는 고장은 위에서 잡히지만, 잘못 읽는
      // 고장은 아무 데도 안 잡혔다. 2026-08-12: 타임존 없는 시각을 UTC로 읽어 +9시간
      // 미래가 된 기사가 목록 맨 위에 하루 종일 박혀 있었는데 health는 ok였다.
      // 사람이 "미래에서 왔냐"고 물어야 드러나는 종류라 반드시 기계가 먼저 잡아야 한다.
      // 2시간 여유는 서버 시계 오차용이고, 진짜 회귀는 9시간이라 이 창에 안 숨는다.
      env.DB.prepare(`SELECT COUNT(*) AS count FROM news_articles
        WHERE TRIM(published_at)<>''
          AND datetime(published_at)>datetime('now','+2 hours')
          -- +: 조건은 같다. 3일 인덱스 대신 발행시각 인덱스로 미래 행(보통 0건)만 읽는다.
          AND +datetime(fetched_at)>=datetime('now','-3 days')`).first(),
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
      // 가장 늦은 한 건만 읽는다(idx_news_articles_kba_latest). MAX(date(...)) 로 물으면
      // 바둑 기사 전체를 훑는다. 같은 값이다: date() 는 시각 순서를 그대로 따르고, 행이
      // 없으면 둘 다 아래 badukStoredLatest 에서 ''가 된다.
      env.DB.prepare(`SELECT date(COALESCE(NULLIF(published_at,''),fetched_at)) AS latest
        FROM news_articles WHERE category='바둑' AND summary_quality='full'
          AND url LIKE '%baduk.or.kr%'
        ORDER BY datetime(COALESCE(NULLIF(published_at,''),fetched_at)) DESC LIMIT 1`).first(),
      // 한국기원 밖에서 들어온 바둑 기사. 위 badukStored와 baduk_source_latest는
      // 둘 다 baduk.or.kr만 보므로, 포털(네이버·카카오·구글)에서 오는 바둑이
      // 통째로 끊겨도 두 값은 꿈쩍하지 않는다. 2026-08-11이 정확히 그랬다 -
      // 포털 바둑 발행이 하루 종일 0건인데 health는 ok를 반환했다.
      // +category: 조건은 같다. 그냥 두면 SQLite 가 category 인덱스로 바둑 기사 전체를
      // 읽고 24시간을 줄마다 거른다. +를 붙이면 24시간 인덱스로 찾는다.
      env.DB.prepare(`SELECT COUNT(*) AS count FROM news_articles
        WHERE +category='바둑' AND summary_quality='full' AND url NOT LIKE '%baduk.or.kr%'
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
        -- +id: 순서는 id 그대로다. 그냥 id 로 두면 SQLite 가 id 순으로 기사 전체를 훑는 길을 고르고,
        -- 24시간 안 기사가 60건이 안 되는 날은 끝까지 읽는다. +를 붙이면 위 시간 인덱스로 찾고 정렬한다.
        ORDER BY +id DESC LIMIT 60`).all(),
      // 저장은 됐는데 화면 규칙이 버리는 바둑 기사. 지금까지 어느 검사도 저장과
      // 화면을 견주지 않았다 - health는 DB 건수만 세고, 화면 필터는 읽을 때만
      // 돌기 때문이다. 그래서 사람이 목록을 직접 세어 봐야만 드러났다
      // (2026-08-12: DB 6건인데 화면 1건, 원인은 '바둑이' 정규식이 주격 조사가
      // 붙은 정상 제목까지 막던 것).
      // 화면이 거는 조건을 그대로 얹어 읽는다. 여기 통과한 뒤에도 JS 단계(바둑
      // 관련성·홍보 제목)가 더 있으므로 아래에서 단계별로 세어 어디서 줄어드는지
      // 드러낸다.
      env.DB.prepare(`SELECT a.title, a.summary FROM news_articles a
        WHERE ${BADUK_TAB_FILTER} AND a.summary_quality='full'
          AND datetime(COALESCE(NULLIF(a.published_at,''),a.fetched_at))>=datetime('now','-24 hours')
          AND ${CONTENT_QUALITY_FILTERS.join(' AND ')}
        ORDER BY a.id DESC LIMIT 60`).all(),
      // 화면 조건 하나하나가 몇 건을 떨어뜨리는지. 단계별 수만으로는 "SQL에서
      // 5건이 죽었다"까지만 알 수 있고 어느 조건인지는 또 코드를 읽어야 했다.
      // 조건별로 세어 두면 다음에는 숫자만 보고 바로 그 줄로 간다.
      env.DB.prepare(`SELECT ${filterHitColumns}
        FROM news_articles a
        WHERE +a.category='바둑' AND a.summary_quality='full'
          AND datetime(COALESCE(NULLIF(a.published_at,''),a.fetched_at))>=datetime('now','-24 hours')`).first(),
      // 브라우저에서 열리지 않는 주소 형태가 저장돼 있는지. 카드는 떴는데 누르면
      // "페이지 주소가 잘못됐다"가 나오는 고장은 지금까지 어느 검사도 묻지 않았다
      // - health는 기사가 **있는지**만 봤고 그 링크가 **열리는지**는 안 봤다.
      // 2026-08-14: canonicalUrl이 m.sports.naver.com에서 m.을 떼어 404 주소를
      // 만들고 있었고, 사람이 눌러 보고서야 드러났다. 네이버 스포츠에는 데스크톱
      // 기사 주소가 없다. 외부 요청 없이 주소 모양만 보므로 값이 들지 않는다.
      // 시간 조건 앞 +: 조건은 같다. 30일 인덱스 대신 이 주소 모양만 모은 부분 인덱스
      // (idx_news_articles_sports_url)를 읽게 한다. 수집이 매번 고쳐 두므로 거의 비어 있다.
      env.DB.prepare(`SELECT COUNT(*) AS count FROM news_articles
        WHERE url LIKE 'https://sports.naver.com/%/article/%'
          AND +datetime(COALESCE(NULLIF(published_at,''),fetched_at))>=datetime('now','-30 days')`).first()
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
    // 바둑이 "요약을 살 돈이 없어서" 굶은 실행 수. 본문을 못 긁은 것도, 소스가
    // 조용한 것도 아니고 호출 몫에 막힌 경우다. 2026-08-12 아침의 고장이 정확히
    // 이것이었는데 그때 health는 전 항목 통과였다 - 어느 검사도 예산 관문이 바둑을
    // 끊고 있는지를 묻지 않았기 때문이다.
    let badukQuotaBlockedRuns = 0;
    // 하루 동안 바둑 후보를 몇 건이나 실제로 붙잡아 봤는지. "없어서 안 나온 것"과
    // "있는데 못 가져온 것"을 가르는 값이다 - 이게 0이면 조용한 날이니 울리지
    // 않고, 0이 아닌데 화면이 비어 있으면 그건 고장이다.
    let badukCandidatesSeen = 0;
    // Worker 한 번 호출의 외부 요청 한도(50)를 넘겨 죽은 후보. 이건 매체 고장이
    // 아니라 우리 쪽 한도인데, 지금까지 body_too_short로 섞여 들어가 매체 탓으로
    // 보였다. 따로 세어야 "선택자를 넓혀야 하나"와 "배치가 큰가"를 가를 수 있다.
    let subrequestOverflowFailures = 0;
    let subrequestStoppedCandidates = 0;
    // 유료 요약을 **사고도 버린** 건수와 그 사유. 이 값이 없어서 오늘 하루를
    // 통째로 헛돌았다: 2026-08-14 04:31~04:42에 3줄 요약의 "1) 2) 3)"을 원문에
    // 없는 숫자로 판정해 AI가 써준 요약을 통째로 폐기하고 있었다. 돈은 나가는데
    // 기사는 0건이었고, 진단에는 그 사실이 어디에도 안 남아서 사람이 기사를 손으로
    // 받아 코드를 태워 보고서야 찾았다.
    //
    // 사는 것과 싣는 것을 나란히 세어 두면 "요약이 나쁘다"와 "검사가 과하다"와
    // "돈이 없다"가 처음부터 갈린다. 셋은 손댈 곳이 전부 다르다.
    const summaryRejections = {};
    let summaryRejected = 0;
    let summarySkippedNoBudget = 0;
    const badukFailureHosts = {};
    for (const row of recentRuns?.results || []) {
      let diagnostics = null;
      try {
        diagnostics = JSON.parse(String(row.message || '') || '{}')?.diagnostics;
      } catch { continue; }
      if (!diagnostics) continue;
      for (const [rule, count] of Object.entries(diagnostics.summary_rejected_by_rule || {})) {
        summaryRejections[rule] = Number(summaryRejections[rule] || 0) + Number(count || 0);
        summaryRejected += Number(count || 0);
      }
      summarySkippedNoBudget += Number(diagnostics.summary_skipped_no_budget || 0);
      const reason = String(diagnostics.anthropic_exhausted_reason || '');
      // 바둑 후보를 실제로 처리한 실행만 센다. 바둑을 아예 안 돌린 일반 실행이
      // 총량에 걸린 것은 바둑의 굶주림이 아니다.
      //
      // 그리고 **하루 총량을 다 쓰는 것 자체는 정상이다.** 예약분(20)을 이미 받고
      // 나서 상한에 닿은 것까지 세면, 설계대로 돈 날마다 알람이 울린다. 그렇게
      // 울리는 알람은 곧 무시된다 - 이 저장소에 그 전례가 이미 있다.
      // 물어야 할 것은 "바둑이 제 몫을 받았는가"다. 예약분에 못 미친 채로 관문에
      // 막힌 실행만 굶주림으로 센다.
      const badukCallsUsed = Number(diagnostics.anthropic_calls_by_bucket?.baduk || 0);
      if ((reason === 'bucket_baduk' || reason === 'daily_total')
        && Number(diagnostics.processed_by_category?.baduk || 0) > 0
        && badukCallsUsed < BADUK_RESERVED_ANTHROPIC_CALLS) badukQuotaBlockedRuns += 1;
      badukCandidatesSeen += Number(diagnostics.processed_by_category?.baduk || 0);
      subrequestStoppedCandidates += Number(diagnostics.subrequest_budget_stopped || 0);
      // 한도를 실제로 넘겨 죽은 흔적. 예산을 세기 시작한 뒤로는 0이어야 한다.
      // 세기 전 코드로 돈 실행(subrequests_used가 없다)은 빼고 본다. 안 그러면
      // 배포 직후 24시간 동안 옛 실행 때문에 계속 울리고, 그렇게 울린 알람은
      // 사람이 무시하게 된다 - 이 저장소가 이미 겪은 실패다.
      if (diagnostics.subrequests_used !== undefined) {
        for (const key of Object.keys(diagnostics.body_too_short_hosts || {})) {
          if (/Too many subrequests/i.test(key)) subrequestOverflowFailures += 1;
        }
      }
      // 어느 매체의 어느 실패인지. 이 값이 없어서 "본문 23건 실패"까지만 알고
      // 무엇을 고쳐야 하는지는 매번 실행 기록을 손으로 파야 했다.
      for (const [key, count] of Object.entries(diagnostics.body_too_short_hosts || {})) {
        if (!key.startsWith('baduk:')) continue;
        badukFailureHosts[key] = Number(badukFailureHosts[key] || 0) + Number(count || 0);
      }
      const outcomes = diagnostics.candidate_outcomes_by_category?.baduk;
      if (!outcomes) continue;
      badukBodyTooShort += Number(outcomes.body_too_short || 0);
      // inserted_duplicate는 뺀다. 그건 이미 있는 기사에 묶인 것이라 화면에 새
      // 카드가 생기지 않는다. 이걸 "발행"으로 세는 바람에 아래 본문 검사가
      // 빠져나갔다 - 2026-08-14 실측: 본문 실패 23건에 화면 0건인데 이 값이
      // 20이라 baduk_body_fetch_healthy가 통과했고 health는 ok를 반환했다.
      badukPublishedByRuns += Number(outcomes.inserted_publishable || 0)
        + Number(outcomes.existing_repaired || 0);
    }
    // 저장된 바둑 기사 중 화면 규칙(홍보·도박 제목)이 버리는 건수. 수집기의
    // isRejectedTitle을 이미 통과해 요약까지 붙은 기사이므로, 여기서 버려지는
    // 것은 대개 규칙이 과하게 넓다는 뜻이다.
    //
    // 저장 → 화면 사이의 단계를 그대로 다시 밟아 각 단계에서 몇 건이 남는지 센다.
    // 지금까지 health는 DB 건수만 봤고 화면 필터는 읽을 때만 돌아서, 중간에서
    // 조용히 사라지는 기사를 아무도 세지 않았다. 2026-08-12: DB 6건인데 화면
    // 1장이었고, 어느 단계가 먹었는지 코드를 읽어 추측하는 수밖에 없었다.
    const badukDisplayRows = (badukTitles?.results || [])
      .map(row => ({ title: String(row.title || ''), summary: String(row.summary || '') }));
    // 화면은 본문이 아니라 3줄 요약으로 바둑 관련성을 다시 판정한다(articles.js).
    // 수집은 본문 800자로 판정했으므로 같은 함수라도 답이 달라질 수 있다.
    const badukAfterRelevance = badukDisplayRows
      .filter(row => isBadukDisplayRelevant(row.title, row.summary));
    const badukHiddenTitles = badukAfterRelevance
      .map(row => row.title)
      .filter(title => title && BADUK_PROMO_TITLE_PATTERNS.some(pattern => pattern.test(title)));
    const badukStoredCount = Number(counts?.baduk || 0);
    // 아래 상세 조회는 60건에서 끊긴다. 저장 건수와 그대로 빼면 60을 넘는 날마다
    // 사라진 것처럼 보이므로, 두 수를 견주는 것은 60 이하일 때만 한다.
    const badukDetailTruncated = badukStoredCount > 60;
    const badukDisplayStages = {
      stored: badukStoredCount,
      after_sql_quality: badukDisplayRows.length,
      after_relevance: badukAfterRelevance.length,
      after_promo: badukAfterRelevance.length - badukHiddenTitles.length,
      detail_truncated: badukDetailTruncated
    };
    // JS 단계(관련성·홍보)에서 버려진 건수는 조회 한계와 무관하게 정확하다.
    const badukDroppedByJs = badukDisplayRows.length - badukDisplayStages.after_promo;
    const badukDroppedBySql = badukDetailTruncated ? 0 : badukStoredCount - badukDisplayRows.length;
    const badukDroppedBeforeScreen = badukDroppedByJs + badukDroppedBySql;
    const badukRelevanceDropped = badukDisplayRows
      .filter(row => !isBadukDisplayRelevant(row.title, row.summary))
      .map(row => row.title.slice(0, 40));
    const state = Object.fromEntries((stateRows.results || []).map(row => [row.key, row.value]));
    const now = new Date();
    const monthlySpend = Number(state.claude_monthly_micro_usd || 0);
    // 저장 쪽이 한국시간 날짜로 적으므로 비교도 한국시간으로 한다. UTC 날짜로
    // 견주던 동안, 한국시간 오전 9시가 지나면 "오늘 지출"이 0으로 초기화돼 보였다
    // (2026-08-12 10:19 KST 실측: 월 $3.34인데 오늘 $0). 실제로는 돈이 나갔는데
    // 계기판만 0을 가리키니 "왜 돈이 안 나가지"를 사람이 물어야 했다.
    const dailySpend = String(state.claude_spend_day || '') === koreaDayKey(now)
      ? Number(state.claude_daily_micro_usd || 0) : 0;
    // 하루치 페이스는 계속 보여주되 실패 조건에서는 뺐다. 이 값이 호출을
    // 막던 동안 요약이 낮에 끊겨 바둑 발행이 0이 됐다. 지출 속도를 눈으로
    // 보는 용도로만 남긴다 - 차단은 월 목표/하드 한도가 한다.
    const dailyAllowance = dailyAllowanceMicroUsd(monthlySpend - dailySpend, now);
    const finishedAgeHours = run?.finished_at ? (Date.now() - utcMillis(run.finished_at)) / 3600000 : Infinity;
    const startedAgeHours = run?.started_at ? (Date.now() - utcMillis(run.started_at)) / 3600000 : Infinity;
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
      // 실행 중인 것은 실패가 아니다. 수집은 1분 안팎 걸리는데 그 사이에 health를
      // 보면 status가 'running'이고 finished_at이 없어서 두 검사가 동시에 빨갛게
      // 떴다. 워치독이 매시 health를 읽고 알림도 거기서 나가므로, 이건 하루에도
      // 몇 번씩 울릴 수 있는 가짜 경보다 - 그렇게 무시하게 된 알람이 이미 한 번
      // 있었다. 15분을 넘겨도 안 끝난 실행은 진짜 멈춘 것이므로 그때는 울린다.
      last_run_ok: run?.status === 'ok' || run?.status === 'degraded'
        || (run?.status === 'running' && startedAgeHours <= 0.25),
      last_run_within_6h: finishedAgeHours <= 6
        || (run?.status === 'running' && startedAgeHours <= 0.25),
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
      // 사람이 화면을 보고 "바둑이 왜 없어"라고 묻기 전에 기계가 먼저 잡아야
      // 하는 것. 위 검사들은 전부 "어느 단계가 이상한가"를 묻는데, 그 단계들이
      // 각자 정상이어도 결과가 0일 수 있다 - 2026-08-14가 정확히 그랬다.
      // 24시간 화면 0건인데 15개 검사가 모두 통과였다.
      //
      // 묻는 방식이 중요하다. "오늘 바둑이 있나"로 물으면 소스가 조용한 날마다
      // 틀리고, 그렇게 울린 알람은 사람이 무시하게 된다(이 저장소의 177통 전례).
      // 그래서 **우리가 후보를 붙잡아 본 날에만** 묻는다. 붙잡은 게 없으면 조용한
      // 날이니 통과, 붙잡았는데 화면이 0이면 중간 어딘가가 고장 난 것이다.
      baduk_reaches_screen: badukCandidatesSeen === 0 || badukDisplayStages.after_promo > 0,
      // 예산을 세기 시작한 뒤로는 한도를 넘겨 죽는 일이 없어야 한다. 남아 있으면
      // 세지 않는 외부 요청 경로가 어딘가 더 있다는 뜻이다.
      subrequest_budget_respected: subrequestOverflowFailures === 0,
      // 0을 요구한다. 안 열리는 주소는 "몇 건은 어쩔 수 없는" 종류가 아니라
      // 우리가 만든 모양이므로, 하나라도 있으면 정규화가 틀린 것이다.
      stored_urls_openable: Number(brokenUrls?.count || 0) === 0,
      // 같은 날 같은 사건에 유료 요약을 두 번 이상 산 흔적. 1쌍은 오판정 여지를
      // 두고 넘긴다(키워드 3개는 우연히도 걸린다). 2쌍부터는 중복 판정이 실제로
      // 새고 있다는 뜻이고, 그건 곧바로 돈이다.
      duplicate_paid_summaries_low: duplicatePaidPairs < 2,
      // 0을 요구하면 발행시각을 아예 안 내는 매체가 한 곳만 걸려도 실패한다.
      // 추출이 망가지면 이 값은 몇 건이 아니라 수십 건으로 뛰므로 여유를 둔다.
      published_time_healthy: Number(missingTime?.count || 0) <= 3,
      // 날짜만 남은 행. 한국기원을 뺀 값이라 여기 잡히는 것은 전부 "원문에 시각이
      // 있는데 우리가 못 읽은" 경우다. 여유를 5로 둔 이유는 발행시각을 정말로
      // 안 내는 지역 매체가 섞이기 때문이고, 추출이 망가지면 이 값은 몇 건이
      // 아니라 수십 건으로 뛴다.
      published_time_has_clock: Number(dateOnlyTime?.count || 0) <= 5,
      // 미래 시각은 0을 요구한다. 발행시각을 안 내는 매체는 있어도 아직 오지 않은
      // 시각을 내는 매체는 없다 - 하나라도 있으면 우리 파싱이 틀린 것이다.
      published_time_not_future: Number(futureTime?.count || 0) === 0,
      // 바둑 몫이 막혀 굶은 실행이 하루에 셋 이상이면 몫 배분이 틀어진 것이다.
      // 한두 번은 총량을 다 쓴 바쁜 날일 수 있어 넘긴다.
      baduk_ai_quota_available: badukQuotaBlockedRuns < 3,
      // 유료 요약을 사놓고 우리 검사가 버리기만 한 날. 예산이 없어 못 산 것
      // (summarySkippedNoBudget)은 여기 안 들어온다 - 그건 돈 문제지 품질
      // 문제가 아니다. 2026-08-14에 정확히 이 상태였는데 어느 검사도 묻지
      // 않았다: 요약을 사고, 버리고, 하루 예산을 세 배 쓰고, 화면은 1건.
      // 열 건 넘게 버렸는데 실린 것이 하나도 없으면 검사가 과한 것이다.
      paid_summary_reaches_screen: summaryRejected < 10 || badukPublishedByRuns > 0,
      // 저장은 됐는데 화면까지 못 가는 바둑 기사. 홍보 규칙만이 아니라 SQL 품질
      // 조건과 바둑 관련성 재판정까지 합쳐서 본다. 1건은 진짜 스팸이 요약까지
      // 받았을 여지를 두고 넘기고, 2건부터는 어딘가 과하게 넓다고 본다.
      // "있는데 안 나오는" 것은 사람이 세어 보기 전에는 어디에도 안 드러났다.
      baduk_display_not_over_filtered: badukDroppedBeforeScreen < 2,
      cloudflare_not_provider_blocked: Number(state.ai_blocked || 0) === 0,
      claude_under_hard_limit: monthlySpend < claudeMonthlyHardLimitMicroUsd(now),
      // 하루에 새로 재시도 상한에 닿은 건수. 누적이 아니라 속도를 본다(위 쿼리 주석).
      summary_exhausted_below_threshold: Number(exhausted?.count || 0) < 15,
      // 퓨즈가 걸리면 그날 수집이 멈춘다. 정상 사용량은 한도보다 훨씬 작으므로 걸렸다면
      // 어딘가 다시 기사 전체를 훑고 있다는 뜻이다(news-d1-meter.js).
      d1_reads_under_daily_limit: d1ReadToday < d1ReadLimit,
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
        // 어느 매체가 어떤 이유로 실패하는지. selector_miss가 몰려 있으면 그 CMS의
        // 본문 자리를 news-extract.js에 넣어야 한다는 뜻이고, http_403이 몰려
        // 있으면 그쪽은 영영 못 긁는다는 뜻이다 - 대응이 정반대라 구분이 필요하다.
        baduk_body_too_short_hosts_24h: badukFailureHosts,
        baduk_candidates_seen_24h: badukCandidatesSeen,
        broken_url_rows: Number(brokenUrls?.count || 0),
        subrequest_overflow_failures_24h: subrequestOverflowFailures,
        subrequest_budget_stopped_24h: subrequestStoppedCandidates,
        duplicate_paid_pairs_24h: duplicatePaidPairs,
        duplicate_paid_samples: duplicatePaidSample,
        baduk_published_by_runs_24h: badukPublishedByRuns,
        missing_published_time: Number(missingTime?.count || 0),
        date_only_published_time: Number(dateOnlyTime?.count || 0),
        // 산 요약을 버린 건수와 사유, 그리고 돈이 없어 아예 못 산 건수.
        summary_rejected_24h: summaryRejected,
        summary_rejected_by_rule_24h: summaryRejections,
        summary_skipped_no_budget_24h: summarySkippedNoBudget,
        future_published_time: Number(futureTime?.count || 0),
        // 저장 → 화면 각 단계에 몇 건이 남는지. 줄어드는 자리가 원인 자리다.
        baduk_display_stages: badukDisplayStages,
        baduk_hidden_by_display_filters: badukDroppedBeforeScreen,
        baduk_hidden_by_promo_samples: badukHiddenTitles.slice(0, 3).map(title => title.slice(0, 40)),
        baduk_hidden_by_relevance_samples: badukRelevanceDropped.slice(0, 3),
        // 어느 화면 조건이 몇 건을 떨어뜨렸는지. 조건식을 그대로 열쇠로 쓴다 -
        // 번호만 남기면 다음에 또 코드를 세어 맞춰봐야 한다.
        baduk_dropped_by_rule: Object.fromEntries(CONTENT_QUALITY_FILTERS
          .map((filter, index) => [filter.slice(0, 70), Number(badukFilterHits?.[`f${index}`] || 0)])
          .filter(([, hits]) => hits > 0)),
        baduk_quota_blocked_runs_24h: badukQuotaBlockedRuns,
        cloudflare_provider_blocked: Number(state.ai_blocked || 0),
        claude_monthly_micro_usd: monthlySpend,
        claude_budget_month: String(state.claude_budget_month || ''),
        // 이 달에 적용 중인 예산. 한 달만 올려둔 것을 나중에 잊지 않도록 드러낸다.
        claude_monthly_target_micro_usd: claudeMonthlyTargetMicroUsd(now),
        claude_monthly_hard_limit_micro_usd: claudeMonthlyHardLimitMicroUsd(now),
        claude_daily_micro_usd: dailySpend,
        claude_daily_allowance_micro_usd: dailyAllowance,
        summary_exhausted: Number(exhausted?.count || 0),
        database_bytes: databaseBytes || null,
        // 오늘(UTC) newsbrief 가 D1 에서 읽은 줄 수. 이 health 호출 전까지의 값이다.
        d1_rows_read_today: d1ReadToday,
        d1_daily_read_limit: d1ReadLimit,
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
  } finally {
    await meter.save();
  }
}
