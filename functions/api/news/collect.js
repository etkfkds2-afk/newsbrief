import {
  isRejectedTitle, normalizeText, publishableSummary, summaryRejectionReason
} from '../../_lib/news-summary.js';
import { makeBestSummary } from '../../_lib/news-ai-summary.js';
import {
  canonicalUrl, ensureNewsDb, isCollectorAuthorized, json, runMessage, sha256
} from '../../_lib/news-db.js';
import { recordClaudeUsage } from '../../_lib/news-ai-budget.js';
import { createCallBudget, SUBREQUESTS_PER_CANDIDATE } from '../../_lib/news-call-budget.js';
import { loadHostHealth } from '../../_lib/news-host-health.js';
import { createStoryIndex, sharesTitleKeywords } from '../../_lib/news-dedup.js';
import { findDuplicateStories } from '../../_lib/news-issue-classify.js';
import { isBadukRelevant } from '../../_lib/baduk-relevance.js';
import { BADUK_SEARCH_QUERIES as BADUK_SEARCHES } from '../../_lib/baduk-queries.js';
import {
  allowedCandidate, articleSource, classify, cleanTitle, fetchArticleText,
  parseDate, pressFromTitle, readableArticleUrl, stripHtml, titleIsTruncationOf, titleSimilarity
} from '../../_lib/news-extract.js';
import {
  collectArchivedTop, collectPopularity, googleNewsSearch, kakaoSearch, koreanBadukLatest,
  naverSearch
} from '../../_lib/news-sources.js';
import {
  backfillPopularityDate, quarantineWeakSummaries, repairGeneralArticleTimes,
  repairGeneralCategories, repairTitleByQuery, repairTruncatedTitles
} from '../../_lib/news-repairs.js';
export { isBadukRelevant } from '../../_lib/baduk-relevance.js';
// 기사 파싱 계층은 news-extract.js로, 외부 후보 수집은 news-sources.js로
// 옮겼다. 이 모듈을 통해 쓰던 호출자와 테스트가 그대로 동작하도록 같은
// 이름으로 다시 내보낸다.
export {
  articleSectionCategory, fetchArticleText, naverSectionCategory
} from '../../_lib/news-extract.js';
export { googleNewsSearch } from '../../_lib/news-sources.js';

const SEARCHES = [
  ['바둑', '바둑 대회 프로기사'],
  ['정치', '정치'], ['경제', '경제'], ['사회', '사회'],
  ['생활/문화', '생활 문화'], ['세계', '국제']
];

const GENERIC_TITLES = new Set(['이 시각 주요 뉴스', '오늘의 주요 뉴스', '주요 뉴스', '뉴스 브리핑']);
// AI 호출 몫과 외부 요청 예산은 news-call-budget.js가 전부 들고 있다. 여기에
// 같은 상수를 두면 두 곳이 어긋나고, 그러면 health의 굶주림 판정이 거짓말을 한다.
// health가 예약분을 읽어야 하므로 이름만 다시 내보낸다.
export { BADUK_RESERVED_ANTHROPIC_CALLS } from '../../_lib/news-call-budget.js';
// Popular pages frequently contain blocked/short-body articles. Process more
// than the ten-card home target so those failures do not collapse the feed.
const SCHEDULED_GENERAL_CANDIDATES = 12;
const SCHEDULED_BADUK_CANDIDATES = 20;
// Every discovery resolved here competes for the fixed 20-slot baduk batch
// against official.baduk.or.kr + search results, which alone usually already
// fill it. Resolving 20 discoveries (up to 2 subrequests each) was spending
// the run's Cloudflare subrequest budget on candidates the 20-slot cap then
// discarded anyway, leaving nothing left to actually fetch article bodies
// for the batch that got selected - every scheduled run was publishing 0
// new baduk/general articles with "body_too_short" that was really
// "Too many subrequests by single Worker invocation".
const SCHEDULED_GOOGLE_DISCOVERIES = 6;
// 바둑 전용 호출은 일반 후보도, 인기 랭킹 해석도 돌리지 않는다. 그 몫의
// subrequest가 통째로 남으므로 디스커버리를 더 많이 해석할 수 있다. 6은 일반과
// 예산을 다투던 시절의 값이다 - 디스커버리가 40건을 찾아 보내는데 6건만 쓰고
// 34건을 버리고 있었다(2026-08-11 실측 google_discovered=40).
// 10인 이유: 해석 1건당 보통 subrequest 1회(네이버 성공 시), 실패해야 2회다.
// 여기에 본문 fetch 20건과 기본 검색 3회가 더해지므로 무료 플랜 상한 50에
// 여유를 남긴다. 남는지는 진단의 body_too_short 사유로 확인할 수 있다 -
// 예산이 바닥나면 "Too many subrequests"가 error_ 로 찍힌다.
const BADUK_ONLY_GOOGLE_DISCOVERIES = 10;
const DAILY_CATEGORY_PUBLISH_LIMIT = 12;
const MAINTENANCE_BATCH_SIZE = 40;
const POPULARITY_REPAIR_BATCH_SIZE = 4;

// 같은 이야기인지 견줘 볼 기간. 길게 잡으면 해마다 열리는 같은 대회의 올해 기사가
// 작년 기사와 묶인다. 보도자료 재탕은 며칠 안에 몰려 들어오므로 이 정도면 잡힌다.
const STORY_INDEX_WINDOW_DAYS = 7;

const LOCAL_GENERAL_PRESS = /(?:충청|대전|세종|청주|충북|충남|전북|전남|경북|경남|강원|제주|부산|울산|경기|인천).*(?:뉴스|일보|신문|투데이)|(?:중부|제주|경인|영남|호남)(?:매일|일보|신문)/i;

// 판정은 news-summary.js의 publishableSummary 하나만 쓴다. 여기 조합을 따로
// 들고 있으면 사후 복구(news-repairs.js)와 어긋나고, 어긋나는 순간 "새로는 안
// 실리는데 이미 실린 것은 안 내려가는" 상태가 된다.
const validPublishedSummary = publishableSummary;

// 요약이 왜 화면에 못 갔는지를 진단에 남긴다. "안 나온 건 기록에 남긴다"가
// 요구사항이고, 없으면 화면이 빌 때마다 사람이 기사를 손으로 받아 코드를
// 태워 봐야 원인을 안다(2026-08-14에 실제로 그랬다).
const recordSummaryRejection = (diagnostics, summary, title, category, detail) => {
  // 예산이 없어 아예 물어보지 못한 건은 품질 장부에 적지 않는다. 이미
  // summary_skipped_no_budget으로 세었고, 여기 'empty'로 또 적으면 "요약이
  // 나쁘다"와 "요약을 살 돈이 없었다"가 한 칸에 쌓여 구분이 사라진다.
  if (detail?.budget_blocked) return false;
  const reason = summaryRejectionReason(summary, title, category);
  if (!reason) return true;
  diagnostics.summary_rejected_by_rule ||= {};
  diagnostics.summary_rejected_by_rule[reason]
    = Number(diagnostics.summary_rejected_by_rule[reason] || 0) + 1;
  diagnostics.summary_rejected_samples ||= [];
  if (diagnostics.summary_rejected_samples.length < 5) {
    diagnostics.summary_rejected_samples.push(`${reason}|${String(title).slice(0, 34)}`);
  }
  return false;
};




async function collect(env, {
  backfill = false, repair = false, forceRetry = false, generalBoost = false,
  generalOnly = false, badukOnly = false, qualityRepairIds = [], googleDiscoveries = [], popularityCandidates = [], popularityOffset = 0
} = {}) {
  const diagnostics = { mode: backfill ? 'backfill' : 'scheduled', retry_attempted: 0, retry_repaired: 0, samples: [] };
  const now = new Date();
  const koreaNow = new Date(now.valueOf() + 9 * 3600000);
  const dayStart = Date.UTC(koreaNow.getUTCFullYear(), koreaNow.getUTCMonth(), koreaNow.getUTCDate()) - 9 * 3600000;
  const monthStart = Date.UTC(koreaNow.getUTCFullYear(), koreaNow.getUTCMonth(), 1) - 9 * 3600000;
  // 이 쿼리가 실행 첫머리에서 Worker를 죽이고 있었다.
  //
  // 2026-08-14 실측: 이 달의 summary_quality='full' 행이 440건이다(일반 349 +
  // 바둑 91). 예전에는 그 440건의 **요약 본문까지** 전부 읽어 와서, 아래 루프가
  // 행마다 publishableSummary(정규식 수십 개)를 다시 돌렸다. 발행 건수를 세려고
  // 한 일인데, 그 판정은 저장할 때 이미 내려서 summary_quality에 적어 둔 것이다.
  // 달이 흐를수록 행이 늘어 CPU가 같이 늘고, 8월 중순에 한도를 넘겼다 - 수집이
  // 네트워크를 한 번도 안 타고 1초 만에 error code 1102(503)로 죽었다.
  // 저장된 판정을 그대로 믿는다. 재검사는 quarantineWeakSummaries의 몫이다.
  //
  // is_popular는 인기 랭킹 복구 실행에서만 쓴다. 그런데 OR로 묶인 상관 서브쿼리라
  // 인덱스를 못 타고 행마다 두 테이블을 훑는다 - 읽기 경로에서 같은 모양을 걷어낸
  // 이유가 그것이다(articles.js "인기뉴스 조회는 OR 조인 없이"). 정기 실행에서는
  // 쓰지도 않으면서 440번 돌고 있었으므로, 필요한 실행에서만 계산한다.
  const needsPopularFlag = popularityCandidates.length > 0;
  const publishedRows = await env.DB.prepare(`SELECT a.category,a.title,a.published_at,a.fetched_at
      ${needsPopularFlag
        ? ', EXISTS(SELECT 1 FROM news_popular_items p WHERE p.url_key=a.url_key OR p.title=a.title) AS is_popular'
        : ', 0 AS is_popular'}
    FROM news_articles a WHERE a.summary_quality='full' AND TRIM(a.summary)<>''
      AND datetime(COALESCE(NULLIF(a.published_at,''),a.fetched_at))>=datetime(?)`)
    .bind(new Date(monthStart).toISOString()).all();
  const publicationCounts = {
    baduk: { daily: 0, monthly: 0 },
    general: { daily: 0, monthly: 0 }
  };
  const storedTime = value => {
    const text = String(value || '');
    return Date.parse(/Z$|[+-]\d\d:\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}Z`);
  };
  // 이미 제대로 요약해 둔 이야기 목록. 같은 보도자료가 매체만 바꿔 다시 들어오면
  // 유료 요약을 또 쓰지 않기 위해 본다. 요약이 성립한 행만 넣는 것이 중요하다.
  // 요약에 실패해 둔 기사까지 넣으면, 다음에 들어온 같은 이야기가 제대로 요약될
  // 기회까지 막힌다.
  // 중복 판정은 **발행일이 같은 날**끼리만 한다. 날이 다르면 헤드라인도 달라지므로
  // 각각 요약을 산다. 사용자 결정(2026-08-10).
  const koreaDayKey = value => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || !parsed) return '';
    return new Date(parsed + 9 * 3600000).toISOString().slice(0, 10);
  };
  const recentStoryStart = now.valueOf() - STORY_INDEX_WINDOW_DAYS * 86400000;
  // 날짜별 이야기 목록. 같은 날 안에서만 "이미 다룬 이야기인가"를 묻는다.
  const storyIndexByDay = new Map();
  const storyTitlesByDay = new Map();
  const dayIndex = day => {
    if (!storyIndexByDay.has(day)) {
      storyIndexByDay.set(day, createStoryIndex());
      storyTitlesByDay.set(day, []);
    }
    return storyIndexByDay.get(day);
  };
  // 돈 안 드는 중복 판정. AI를 부르기 **전에** 이걸 먼저 태우고, 여기서 가려진
  // 후보는 AI 프롬프트에 아예 안 싣는다.
  //
  // 예전에는 문자 유사도(0.45) 하나만 봤다. 그 판정은 같은 사건인데 제목을 다르게
  // 쓴 보도를 놓친다. 실측 2026-08-11 노원구 기원 살인: 06:01 기사가 이미 있는데
  // 09:58 "서울 노원구 기원서 지인 흉기 살해 60대 구속"이 유사도 0.300~0.318로
  // 임계값에 못 미쳐 새 기사로 판정됐고, 3줄 요약을 또 샀다.
  //
  // 같은 파일(news-dedup.js)에 그 사건을 근거로 만든 키워드 규칙이 이미 있었다.
  // 그런데 화면(articles.js)에서만 쓰고 수집에서는 안 썼다. 위 두 제목은 각각
  // 4개·3개 단어를 공유해서 이 규칙에는 걸린다. 화면이 관련 보도로 접을 기사면
  // 수집도 요약을 사지 말아야 한다 - 기준이 다르면 돈만 새고 화면은 그대로다.
  //
  // 바둑에는 키워드 규칙을 걸지 않는다. 제목마다 기사 이름과 대회 이름이 반복돼
  // 서로 다른 대국이 쉽게 3단어를 넘긴다(news-dedup.js의 같은 주석 참고).
  const freeDuplicateOf = (title, day, category) => {
    if (!day || !title) return '';
    const index = storyIndexByDay.get(day);
    const byTitle = index ? index.match(title) : '';
    if (byTitle) return byTitle;
    if (category === '바둑') return '';
    return (storyTitlesByDay.get(day) || []).find(seen => sharesTitleKeywords(seen, title)) || '';
  };
  for (const row of publishedRows.results || []) {
    // 발행 자격은 위 쿼리의 summary_quality='full' AND TRIM(summary)<>''로 이미
    // 물었다. 여기서 정규식으로 다시 묻던 것이 CPU 한도 초과의 정체다(위 주석).
    const bucket = row.category === '바둑' ? 'baduk' : 'general';
    const timestamp = storedTime(row.published_at || row.fetched_at);
    publicationCounts[bucket].monthly += 1;
    if (timestamp >= dayStart) publicationCounts[bucket].daily += 1;
    if (timestamp >= recentStoryStart) {
      const day = koreaDayKey(timestamp);
      if (day) {
        dayIndex(day).add(row.title);
        storyTitlesByDay.get(day).push(row.title);
      }
    }
  }
  const popularityTargetStart = popularityCandidates.length
    ? Number(popularityCandidates[0].popularityDate) - 9 * 3600000
    : 0;
  const popularityTargetCounts = { baduk: 0, general: 0 };
  if (popularityTargetStart) {
    for (const row of publishedRows.results || []) {
      if (!Number(row.is_popular || 0)) continue;
      const timestamp = storedTime(row.published_at || row.fetched_at);
      if (timestamp < popularityTargetStart || timestamp >= popularityTargetStart + 86400000) continue;
      popularityTargetCounts[row.category === '바둑' ? 'baduk' : 'general'] += 1;
    }
  }
  const publicationBucket = category => category === '바둑' ? 'baduk' : 'general';
  // 하루 발행 상한이 남았는지. 예전에는 이 검사가 **신규 기사 삽입 한 곳에만**
  // 있었다. 그런데 유료 요약을 사고 발행 카운트를 올리는 경로는 셋이다 -
  // 신규 삽입, 재요약 재시도(retrySummary), 기존 기사 복구. 뒤의 둘에는 상한이
  // 없어서 12건 상한인데 하루 19건이 실렸다(2026-08-11 실측, 24시간 기준 27건).
  //
  // 화면에 보이는 일반 헤드라인은 10개다. 즉 초과분은 돈만 쓰고 사용자에게
  // 보이지도 않았다. 월 예산 $4.75가 11일 만에 $3.28까지 간 주된 이유다.
  //
  // 순서상 재시도가 먼저 돌고 신규가 나중이라, 상한이 찼을 때 굶는 쪽은 신규가
  // 아니라 그날 이미 여러 번 실패한 기사다. 그게 맞는 우선순위다 - 재시도는
  // 다음 실행에 또 기회가 있고, 신규는 30일이 지나면 too_old로 사라진다.
  const hasPublicationCapacity = category => Boolean(popularityTargetStart)
    || publicationCounts[publicationBucket(category)].daily < DAILY_CATEGORY_PUBLISH_LIMIT;
  const consumePublicationCapacity = category => {
    const bucket = publicationBucket(category);
    const count = publicationCounts[bucket];
    if (popularityTargetStart) popularityTargetCounts[bucket] += 1;
    else count.daily += 1;
    count.monthly += 1;
  };
  diagnostics.home_display_limits = { baduk: 30, general: 10 };
  diagnostics.publish_counts_before = JSON.parse(JSON.stringify(publicationCounts));
  if (popularityTargetStart) diagnostics.popularity_target_counts_before = { ...popularityTargetCounts };
  // 이 실행이 밖으로 나가는 모든 호출은 budget을 지난다. 세는 자리를 하나로
  // 모아 둔 이유는 news-call-budget.js 첫머리 주석에 있다 - 2026-08-14에 세는
  // 자리가 흩어져 있어서 같은 종류의 고장이 하루에 세 번 났다.
  const budget = createCallBudget(env, diagnostics, { forceRetry, generalBoost });
  const countedFetchArticle = budget.counted(fetchArticleText);
  const countedNaverSearch = budget.counted(naverSearch);
  const countedKakaoSearch = budget.counted(kakaoSearch);
  const countedBadukLatest = budget.counted(koreanBadukLatest);
  const countedGoogleNews = budget.counted(googleNewsSearch, 2);
  const countedPopularity = budget.counted(collectPopularity, 3);
  const countedArchivedTop = budget.counted(collectArchivedTop, 3);
  // 3줄 요약은 예외 없이 AI가 만든다. 본문 문장을 오려 붙이는 추출식 요약은
  // 이 경로에 없다 - 그게 화면의 이상한 요약("그가 인간 바둑에서도 …")을 만들던
  // 정체였다. AI가 못 만들면 빈 값을 돌려주고 기사는 저장만 된다.
  //
  // 외부 요청은 실제로 나가기 직전에 하나씩 센다. 미리 두 개를 깎아 두면,
  // 한 번만 부르고 끝난 실행에서도 예산이 잘못 줄어 뒤따르는 후보가 까닭 없이
  // 잘린다 - 고치려던 것보다 나쁜 결과다.
  const summarize = async (payload, detail, purpose = 'new') => {
    const trace = detail || {};
    // 어느 몫에서 돈을 빼는지. payload.category가 비면 일반으로 본다 - 바둑 몫을
    // 실수로 쓰는 쪽보다 안 쓰는 쪽이 안전하다.
    const bucket = publicationBucket(payload.category);
    const sourceLength = normalizeText(payload.body || payload.rawSummary).length;
    // 본문이 짧아도 AI에게 보낸다. 예전에는 300자 미만이면 추출식으로 돌렸는데,
    // 짧은 기사일수록 오려 붙인 문장이 더 이상해진다.
    if (sourceLength < 120) {
      diagnostics.summary_body_too_short = Number(diagnostics.summary_body_too_short || 0) + 1;
      return '';
    }

    let cloudflareReserved = Boolean(env.AI);
    if (cloudflareReserved) cloudflareReserved = await budget.reserveCloudflare();

    let summary = '';
    if (cloudflareReserved) {
      budget.spend(1);
      summary = await makeBestSummary({ ...env, ANTHROPIC_API_KEY: undefined, NEWSBRIEF_USE_ANTHROPIC: '0' }, payload, trace);
      const cloudflareValid = trace.ai_provider === 'cloudflare'
        && trace.structurally_valid && trace.numbers_grounded;
      if (cloudflareValid) return summary;
    }
    if (cloudflareReserved && /(?:daily free allocation|Account limited|3036|4006)/i.test(String(trace.ai_error || ''))) {
      await budget.blockCloudflareForToday();
    }

    const anthropicReserved = Boolean(env.ANTHROPIC_API_KEY) && await budget.reserveAnthropic(bucket);
    // 예산이 없어 **한 번도 물어보지 못한** 경우를 따로 표시한다. 이걸 안 하면
    // 아래에서 빈 문자열이 나가고, 부르는 쪽은 그것을 요약 품질 미달('empty')로
    // 기록한다. 2026-08-14 실측: 진단에 summary_rejected_by_rule {empty:3}만
    // 남아서 "AI가 요약을 못 만든다"로 읽혔는데 실제로는 그날 호출 상한을 이미
    // 146/60으로 넘겨 아무것도 물어보지 않은 것이었다. 원인이 품질이냐 예산이냐에
    // 따라 손댈 곳이 정반대라, 이 둘이 같은 이름으로 쌓이면 진단이 거짓말을 한다.
    if (!cloudflareReserved && !anthropicReserved) {
      trace.budget_blocked = true;
      diagnostics.summary_skipped_no_budget = Number(diagnostics.summary_skipped_no_budget || 0) + 1;
      return '';
    }
    if (anthropicReserved) {
      const anthropicTrace = {};
      budget.spend(1);
      const anthropicSummary = await makeBestSummary({
        ...env,
        AI: undefined,
        NEWSBRIEF_USE_ANTHROPIC: '1'
      }, payload, anthropicTrace);
      Object.assign(trace, anthropicTrace, {
        cloudflare_fallback: true,
        cloudflare_error: trace.ai_error || (cloudflareReserved ? 'invalid_response' : 'budget_unavailable')
      });
      if (anthropicTrace.ai_provider === 'anthropic') {
        const recorded = await recordClaudeUsage(env, anthropicTrace.ai_model, {
          input_tokens: anthropicTrace.ai_input_tokens,
          output_tokens: anthropicTrace.ai_output_tokens
        });
        diagnostics.claude_monthly_micro_usd = recorded.spent;
      }
      if (anthropicTrace.ai_provider === 'anthropic'
        && anthropicTrace.structurally_valid && anthropicTrace.numbers_grounded) return anthropicSummary;
      if (!summary) summary = anthropicSummary;
    }

    // AI가 답을 줬는데 우리 검사가 버린 경우를 실행 진단까지 올린다. trace는
    // 호출부가 들고 있을 뿐 어디에도 안 남아서, "AI가 요약을 못 한다"와 "우리
    // 검사가 과하다"를 구분할 근거가 진단에 전혀 없었다.
    if (trace.ai_reject_rule) {
      diagnostics.ai_rejected_by_rule ||= {};
      diagnostics.ai_rejected_by_rule[trace.ai_reject_rule]
        = Number(diagnostics.ai_rejected_by_rule[trace.ai_reject_rule] || 0) + 1;
      diagnostics.ai_rejected_samples ||= [];
      if (diagnostics.ai_rejected_samples.length < 4) {
        diagnostics.ai_rejected_samples.push(`${trace.ai_reject_rule}| ${trace.ai_first_line || ''}`);
      }
    }
    // AI가 못 만들었으면 아무것도 내지 않는다.
    //
    // 예전에는 여기서 추출식 요약(본문 문장을 그대로 오려 붙이는 방식)으로
    // 물러섰다. 그게 화면의 이상한 요약을 만드는 정체였다 - 2026-08-14 실측:
    //   "1) 그가 인간 바둑에서도 전대미문의 역사를 써 내려가고 있다."
    // 앞 문장이 없는데 '그가'로 시작한다. 본문에서는 바로 앞 문장이 신진서를
    // 소개하고 있어 말이 되지만, 그 문장만 떼어 첫 줄에 놓으면 읽는 사람은
    // 누구 얘기인지 알 수 없다. 문장을 고르는 방식으로는 이 문제를 못 고친다 -
    // 요약은 문장을 고르는 일이 아니라 다시 쓰는 일이기 때문이다.
    //
    // 빈 값을 돌려주면 호출부가 summary_quality를 'full'로 올리지 않으므로
    // 기사는 저장만 되고 화면에 안 나온다. 다음 실행이 AI로 다시 시도한다.
    if (summary) return summary;
    diagnostics.ai_summary_unavailable = Number(diagnostics.ai_summary_unavailable || 0) + 1;
    return '';
  };
  // 본문을 못 주는 매체를 스스로 기억하고 스스로 풀어주는 장부. 판정 경계와 그
  // 근거는 news-host-health.js에 있다 - 잘못 잡으면 바둑 기사가 통째로 사라지는
  // 쪽이라 경계 셋이 전부 "덜 가두는" 방향으로 맞춰져 있다.
  const hostHealth = await loadHostHealth(env, diagnostics);
  // 미래로 저장된 발행시각은 매 실행이 스스로 무력화한다. 시각을 잘못 읽는 고장은
  // 목록이 발행시각 내림차순이라 그 기사가 맨 위에 박혀 그날 기사를 통째로 가린다.
  //
  // 원문을 다시 긁어 진짜 시각을 되찾는 복구(repairGeneralArticleTimes)는 사람이
  // 버튼을 눌러야 돈다. 그것만 두면 새 표기를 쓰는 매체가 하나 들어올 때마다
  // 사람이 화면을 보고 "미래에서 왔냐"고 물어야 고쳐진다 - 그건 고친 게 아니다.
  //
  // 여기서는 fetch 없이 SQL 한 줄로 값을 비우기만 한다. 서브리퀘스트도 돈도 들지
  // 않고, 읽기 경로는 전부 COALESCE(NULLIF(published_at,''),fetched_at)이라 수집
  // 시각으로 물러선다. 진짜 시각 복구는 나중에 복구 경로가 이어서 하면 된다.
  // 2시간 여유는 서버 시계 오차용이다(진짜 고장은 9시간이라 여기 안 숨는다).
  // 최근에 들어온 것만 본다. 조건이 published_at 함수라 인덱스를 못 타므로 창을
  // 안 두면 매 실행이 기사 전체를 훑는다. 미래 시각은 방금 들어온 행에서 생기고,
  // 옛 행은 이미 이 정리를 지났다.
  const neutralizedFutureTimes = await env.DB.prepare(`UPDATE news_articles SET published_at=''
    WHERE TRIM(published_at)<>'' AND datetime(published_at)>datetime('now','+2 hours')
      AND datetime(fetched_at)>=datetime('now','-7 days')`).run();
  const neutralizedCount = Number(neutralizedFutureTimes?.meta?.changes || 0);
  if (neutralizedCount) diagnostics.future_published_time_cleared = neutralizedCount;
  // 이미 저장된 404 주소를 매 실행이 스스로 고친다. canonicalUrl이 만들던
  // sports.naver.com/<섹션>/article/<OID>/<AID>는 브라우저에서 열리지 않는다
  // (2026-08-14 실측 404). 카드는 떴는데 누르면 "페이지 주소가 잘못됐다"가 나왔다.
  // 코드를 고쳐도 이미 저장된 행은 그대로이므로 여기서 같이 옮긴다 - url_key는
  // 건드리지 않는다. 링크만 열리면 되고, 키를 바꾸면 중복 판정이 흔들린다.
  //
  // 창을 반드시 둔다. LIKE는 인덱스를 못 타므로 창이 없으면 매 실행이 기사
  // 전체를 훑는다 - 바로 위 미래시각 UPDATE에 7일 창이 있는 것도 같은 이유다.
  // 창 없이 넣었더니 백필 실행이 Cloudflare Worker CPU 한도를 넘겨 죽었다
  // (2026-08-14 실측: error code 1102, 503). 잘못된 주소는 방금 저장된 행에서
  // 생기고, 옛 행은 이 정리를 이미 지났다.
  const repairedSportsUrls = await env.DB.prepare(`UPDATE news_articles
    SET url='https://n.news.naver.com/mnews/article/'
      || substr(url, instr(url, '/article/') + 9)
    WHERE url LIKE 'https://sports.naver.com/%/article/%'
      AND datetime(fetched_at)>=datetime('now','-7 days')`).run();
  const repairedSportsCount = Number(repairedSportsUrls?.meta?.changes || 0);
  if (repairedSportsCount) diagnostics.sports_url_repaired = repairedSportsCount;
  // 이미 실려 있는 요약이 오늘의 기준을 여전히 통과하는지 매 실행이 다시 묻는다.
  //
  // 예전에는 이 검사가 workflow_dispatch 입력(repair_general_quality)으로만 돌았다.
  // 즉 **사람이 버튼을 눌러야** 나쁜 요약이 내려갔다. 그래서 검사를 아무리 촘촘히
  // 해도 이미 화면에 있는 것은 그대로였고, 사람이 보고 알려 줘야 사라졌다.
  // 2026-08-14: 신진서 기사의 "그가 인간 바둑 에서도 …"가 그렇게 떠 있었다.
  //
  // 외부 요청이 없어 subrequest 예산과 무관하고, 최근 사흘 120건만 본다 - 새로
  // 들어온 것과 방금 기준을 올린 것이 여기에 다 들어온다. 30일 전체 훑기는
  // 지금도 repair_general_quality로 따로 부를 수 있다.
  // 재시도 실행(forceRetry)에서는 건너뛴다. 그 실행은 이미 밀린 요약을 몰아서
  // 다시 사느라 CPU를 많이 쓰는데, 여기에 재검사까지 얹으면 Worker CPU 한도를
  // 넘겨 실행 전체가 죽는다(2026-08-14 실측: error code 1102로 3패스 모두 503).
  // 재검사는 정기 실행이 매번 하므로 한 번 걸러도 잃는 것이 없다.
  if (!popularityCandidates.length && !backfill && !forceRetry) {
    // 창을 번갈아 연다. 보통은 최근 사흘 60건만 본다 - 새로 들어온 것과 방금
    // 기준을 올린 것이 거기 다 들어온다. 여섯 시간마다 한 번은 **화면이 보여주는
    // 창 전체**(30일)를 200건까지 훑는다.
    //
    // 깊은 훑기가 필요해진 이유: 아래 유지보수 루프가 커서로 아카이브 전체를
    // 돌며 요약을 검사하고 있었는데 그 검사가 옛 조합이라 걷어냈다(아래 주석).
    // 걷어내기만 하면 사흘보다 오래된 행은 어떤 재검사도 안 받는데, 화면은 30일을
    // 보여주므로 나머지 27일이 통째로 사각지대가 된다. 읽기 단계에서 한 번 더
    // 거르는 방법도 있지만 그건 기준을 둘로 만드는 길이고, 그 길로 갔다가 기사가
    // 화면에서만 조용히 사라지는 고장을 이미 겪었다(articles.js의 같은 주석).
    const deepSweep = koreaNow.getUTCHours() % 6 === 0;
    const freshQualitySweep = await quarantineWeakSummaries(env,
      deepSweep ? { limit: 200, days: 30 } : { limit: 60, days: 3 });
    if (freshQualitySweep.quarantined) {
      diagnostics.weak_summary_quarantined = freshQualitySweep.quarantined;
      diagnostics.weak_summary_samples = freshQualitySweep.samples;
    }
    diagnostics.weak_summary_checked = freshQualitySweep.checked;
    diagnostics.weak_summary_deep_sweep = deepSweep;
  }
  // Maintenance is deliberately bounded. Scanning and updating the complete
  // archive on every request exhausted the Pages Worker CPU during backfills.
  if (!popularityCandidates.length) {
    const maintenanceCursor = await env.DB.prepare("SELECT value FROM news_state WHERE key='maintenance_cursor'").first();
    const maintenanceAfter = Number(maintenanceCursor?.value || 0);
    let stored = await env.DB.prepare(`SELECT id,title,summary,body_text,category,url,source,press FROM news_articles
      WHERE id>? ORDER BY id LIMIT ?`).bind(maintenanceAfter, MAINTENANCE_BATCH_SIZE).all();
    if (!(stored.results || []).length && maintenanceAfter > 0) {
      stored = await env.DB.prepare(`SELECT id,title,summary,body_text,category,url,source,press FROM news_articles
        ORDER BY id LIMIT ?`).bind(MAINTENANCE_BATCH_SIZE).all();
    }
    for (const row of stored.results || []) {
      const fixedCategory = classify(row.category, row.title, row.body_text);
      if (fixedCategory !== row.category) await env.DB.prepare('UPDATE news_articles SET category=? WHERE id=?').bind(fixedCategory, row.id).run();
      if (['NAVER', 'KAKAO', 'GOOGLE'].includes(row.source)) {
        const fixedSource = articleSource(row.url, row.source, row.press);
        if (fixedSource !== row.source) await env.DB.prepare('UPDATE news_articles SET source=? WHERE id=?').bind(fixedSource, row.id).run();
      }
      // 요약 품질 판정은 여기서 하지 않는다. 위 quarantineWeakSummaries가
      // publishableSummary 하나로 이미 매 실행 다시 묻고 있고, 여기 있던 검사는
      // 그보다 **헐거운 옛 조합**(validateGeneralEditorialSummary 단독)이었다.
      // 기준이 둘이면 한쪽이 실은 것을 다른 쪽이 내리는 왕복이 생긴다 - 내려간
      // 기사는 다음 실행이 유료 요약을 다시 사서 올리고, 그 다음 실행이 또
      // 내린다. 돈은 계속 나가는데 화면은 그대로다.
      //
      // reorderGeneralSummary도 뺐다. 읽기 경로(articles.js)가 화면에 내보내기
      // 직전에 같은 정렬을 하므로 저장본을 고쳐 둘 이유가 없고, 기사 40건마다
      // 정규식 다발을 돌리는 것이 이 실행에서 가장 무거운 CPU 작업이었다.
      // Worker CPU 한도 초과(error code 1102)로 수집이 503으로 죽던 원인 중
      // 하나다 - 2026-08-14 실측으로 그날 자동/수동 실행 4개가 이렇게 죽었다.
    }
    const lastMaintainedId = (stored.results || []).at(-1)?.id || 0;
    await env.DB.prepare("INSERT INTO news_state(key,value) VALUES('maintenance_cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind(lastMaintainedId).run();
  }
  // Only summaries that fail the narrow general-news editorial checks above
  // are quarantined. Other published summaries are never demoted routinely.
  if (repair) {
    const weakRows = await env.DB.prepare(`SELECT id,url,title,body_text,image_url,press FROM news_articles
      WHERE category='바둑' AND summary_quality='none' AND length(body_text)<300
        AND lower(url) NOT LIKE '%sports.naver.com/%'
      ORDER BY length(body_text) DESC, fetched_at DESC LIMIT 4`).all();
    const recovered = [];
    for (const row of weakRows.results || []) {
      let article = await countedFetchArticle(canonicalUrl(row.url));
      if (article.body.length < 300) {
        try {
          const matches = await countedNaverSearch(env, `"${cleanTitle(row.title)}"`, 1, 3);
          const match = matches.find(item => cleanTitle(item.title).replace(/[^0-9A-Za-z가-힣]/g, '')
            === cleanTitle(row.title).replace(/[^0-9A-Za-z가-힣]/g, '')) || matches[0];
          if (match) article = await countedFetchArticle(canonicalUrl(match.link || match.originallink));
        } catch {}
      }
      if (article.body.length < 300) {
        recovered.push(0);
        continue;
      }
      await env.DB.prepare(`UPDATE news_articles SET body_text=?,
        image_url=CASE WHEN ?<>'' THEN ? ELSE image_url END,
        press=CASE WHEN ?<>'' THEN ? ELSE press END WHERE id=?`)
        .bind(article.body, article.image, article.image, article.press, article.press, row.id).run();
      recovered.push(1);
    }
    diagnostics.body_recrawl_attempted = (weakRows.results || []).length;
    diagnostics.body_recrawl_recovered = recovered.reduce((sum, value) => sum + value, 0);
  }
  const retryRowLimit = popularityCandidates.length ? 0 : (repair ? 4 : (backfill ? 4 : 3));
  // force_retry gives exhausted rows exactly one additional attempt instead
  // of excluding exhausted rows forever or reopening them without a ceiling.
  //
  // 8/9에 이 값을 24로 되돌렸다가 다시 6으로 내린다. 되돌린 근거("73건이 빠져
  // 재요약이 멈췄다")가 틀렸다 - 그 73건은 length(body_text)>=300을 만족하지
  // 못해서 시도 횟수와 무관하게 애초에 이 쿼리에 잡히지 않는다. 상한을 24로
  // 올린 뒤에도 retry_attempted는 계속 0이었다. 아래 재요약 게이트가 이 값을
  // 함께 쓰므로, 6이면 20시간 간격으로 5일치 기회를 준다.
  const retryAttemptLimit = forceRetry ? 7 : 6;
  const retryRows = await env.DB.prepare(`SELECT a.id,a.url_key,a.title,a.raw_summary,a.body_text,a.category FROM news_articles a
    LEFT JOIN news_summary_attempts f ON f.url_key=a.url_key
    WHERE a.summary_quality='none' AND length(a.body_text)>=300 AND COALESCE(f.attempts,0)<?
      AND (?=0 OR a.category<>'바둑')
      AND (?=0 OR a.category='바둑')
      AND (?=0 OR instr(','||?||',', ','||a.id||',')>0)
      AND (? OR f.last_attempt IS NULL OR f.last_attempt < datetime('now','-20 hours'))
    ORDER BY CASE WHEN a.category='바둑' THEN 0 ELSE 1 END,
      COALESCE(f.attempts,0), COALESCE(f.last_attempt,'1970-01-01'), length(a.body_text) DESC LIMIT ?`)
    .bind(retryAttemptLimit, generalOnly ? 1 : 0, badukOnly ? 1 : 0, qualityRepairIds.length ? 1 : 0,
      qualityRepairIds.join(','), forceRetry ? 1 : 0, retryRowLimit).all();
  const retrySummary = async row => {
    if (isRejectedTitle(row.title)) return;
    // 상한이 찼으면 요약을 아예 사지 않는다. 예전에는 이 경로에 상한이 없었다.
    if (!hasPublicationCapacity(row.category)) {
      diagnostics.retry_over_daily_limit = Number(diagnostics.retry_over_daily_limit || 0) + 1;
      return;
    }
    const detail = {};
    const repaired = await summarize({ title: row.title, rawSummary: row.raw_summary, body: row.body_text, category: row.category }, detail, 'retry');
    diagnostics.retry_attempted += 1;
    if (diagnostics.samples.length < 2) diagnostics.samples.push({ title: row.title, ...detail });
    if (validPublishedSummary(repaired, row.title, row.category)) {
      await env.DB.batch([
        env.DB.prepare("UPDATE news_articles SET summary=?,summary_quality='full' WHERE id=?").bind(repaired, row.id),
        env.DB.prepare('DELETE FROM news_summary_attempts WHERE url_key=?').bind(row.url_key)
      ]);
      consumePublicationCapacity(row.category);
      diagnostics.retry_repaired += 1;
    } else if (detail.ai_attempted && !detail.ai_error) {
      await env.DB.prepare(`INSERT INTO news_summary_attempts(url_key,attempts,last_attempt) VALUES(?,1,CURRENT_TIMESTAMP)
        ON CONFLICT(url_key) DO UPDATE SET attempts=attempts+1,last_attempt=CURRENT_TIMESTAMP`).bind(row.url_key).run();
    }
  };
  const pendingRetries = retryRows.results || [];
  const candidates = popularityCandidates.map(row => ({
    category: row.category,
    source: 'NAVER',
    isPopular: true,
    popularityRank: row.rank,
    item: {
      title: row.title, link: row.href, originallink: row.href, description: '',
      // Archived ranking pages identify the day, not an exact publication
      // time. Keep that as a date-only value until the article page supplies
      // its real timestamp; inventing noon UTC displayed as 9 PM in Korea.
      pubDate: new Date(row.popularityDate).toISOString().slice(0, 10)
    }
  }));
  if (repair) {
    for (const row of pendingRetries) await retrySummary(row);
    return { inserted: 0, diagnostics };
  }
  const cursorKey = backfill ? 'history_cursor' : 'rotation_cursor';
  const cursorRow = await env.DB.prepare('SELECT value FROM news_state WHERE key=?').bind(cursorKey).first();
  const slot = Number(cursorRow?.value || 0);
  await env.DB.prepare('INSERT INTO news_state(key,value) VALUES(?,1) ON CONFLICT(key) DO UPDATE SET value=value+1').bind(cursorKey).run();
  const backfillStart = backfill ? (slot % 10) * 100 + 1 : (slot % 100) * 10 + 1;
  const badukQuery = BADUK_SEARCHES[slot % BADUK_SEARCHES.length];
  const generalSearches = SEARCHES.filter(([category]) => category !== '바둑');
  const selectedSearches = popularityCandidates.length ? [] : backfill
    ? SEARCHES.filter(([category]) => category === '바둑')
    : badukOnly ? [SEARCHES[0]]
    : [SEARCHES[0], generalSearches[slot % generalSearches.length], generalSearches[(slot + 1) % generalSearches.length]];
  if (!popularityCandidates.length && !backfill) {
    const official = await countedBadukLatest();
    diagnostics.official_baduk_found = official.length;
    // 한국기원은 2~4일에 한 번만 글을 올린다. 그래서 "24시간 안에 새 바둑
    // 기사가 있나"를 묻던 건강 검사는 조용한 날마다 틀렸고, 정작 소스엔 새 글이
    // 있는데 우리가 못 가져온 진짜 고장은 못 잡았다. 소스의 최신 날짜를 적어두면
    // health가 "소스에 있는 걸 우리가 가져왔나"를 물을 수 있다. 여기서 적는
    // 이유는 health가 매 호출마다 외부 사이트를 긁지 않게 하기 위해서다.
    const sourceLatest = official
      .map(item => String(item.pubDate || '').slice(0, 10))
      .filter(text => /^\d{4}-\d{2}-\d{2}$/.test(text))
      .sort()
      .pop() || '';
    if (sourceLatest) {
      diagnostics.baduk_source_latest = sourceLatest;
      await env.DB.prepare(`INSERT INTO news_state(key,value) VALUES('baduk_source_latest',?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(sourceLatest).run();
    }
    for (const item of official) candidates.push({ category: '바둑', item, source: 'TRUSTED_BADUK' });
  }
  for (const [category, query] of selectedSearches) {
    // A broad "바둑" query at ever-higher offsets repeatedly returned the same small
    // set of usable portal articles. Search several distinct beats per run instead.
    const effectiveQueries = category === '바둑'
      ? [...new Set([
          // The broad query is the freshest view users see on Naver. Always
          // run it instead of waiting for the 35-query rotation to return to
          // it, then add rotated specialist queries for long-tail coverage.
          '바둑',
          ...Array.from({ length: backfill ? 3 : 1 }, (_, index) =>
            BADUK_SEARCHES[(slot * (backfill ? 3 : 1) + index) % BADUK_SEARCHES.length])
        ])]
      : [query];
    for (const effectiveQuery of effectiveQueries) {
      const pageBand = backfill ? Math.floor(slot / Math.ceil(BADUK_SEARCHES.length / 4)) % 5 : 0;
      const start = category === '바둑' ? pageBand * 20 + 1 : (backfill ? backfillStart : 1);
      const display = category === '바둑' ? 20 : (backfill ? 10 : 4);
      // Every other naverSearch/kakaoSearch call site guards against a
      // transient upstream failure. This one didn't - a single 429/5xx from
      // Naver here threw past collect()'s only try/catch (in onRequestPost)
      // and aborted the entire run before baduk, general, or popularity ever
      // got a single candidate, not just this one query's results.
      let items = [];
      try {
        items = await countedNaverSearch(env, effectiveQuery, start, display);
      } catch (error) {
        diagnostics.naver_error = String(error?.message || error).slice(0, 120);
      }
      // 받아온 것을 버리지 않는다. 검색 API 호출 하나가 곧 subrequest 하나이고
      // 그 값은 이미 치렀는데, 바둑은 20건을 받아 10건만, 카카오는 10건을 받아
      // **1건만** 쓰고 나머지를 버리고 있었다. 더 쓰는 데는 추가 subrequest가
      // 들지 않는다. 후보가 늘어도 처리량은 아래 20슬롯 상한이 그대로 묶으므로
      // 늘어나는 것은 처리량이 아니라 그 20칸에 들어올 후보의 다양성이다.
      // 2026-08-11 실측: 20칸 중 8칸이 이미 아는 기사(existing_*)에 돌아갔다.
      // 두 번째 장은 쓰지 않는다. 2026-08-14에 넣어 봤더니 새 후보가 1건에서
      // 20건으로 늘었는데 그중 18건이 too_old였다 - 네이버 뉴스 검색은 '바둑'
      // 같은 낱말에도 최근 결과 자체가 20건 남짓이라, 그 뒤는 곧바로 30일 밖으로
      // 넘어간다. 슬롯만 먹고 아무것도 못 한다. 후보를 넓히려면 페이지가 아니라
      // 소스를 늘려야 한다(카카오·구글·한국기원은 이미 각각 부르고 있다).
      const naverTake = category === '바둑' ? (backfill ? 6 : 20) : (backfill ? 2 : 2);
      for (const item of items.slice(0, naverTake)) candidates.push({ category, item, source: 'NAVER' });
      try {
        const page = category === '바둑' ? pageBand + 1 : (backfill ? (slot % 10) * 5 + 1 : 1);
        const kakaoItems = await countedKakaoSearch(env, effectiveQuery, page, category === '바둑' ? 10 : (backfill ? 10 : 3));
        const kakaoTake = category === '바둑' ? (backfill ? 3 : 5) : (backfill ? 2 : 1);
        for (const item of kakaoItems.slice(0, kakaoTake)) candidates.push({ category, item, source: 'KAKAO' });
      } catch (error) {
        diagnostics.kakao_error = String(error?.message || error).slice(0, 120);
      }
    }
  }
  const recentGeneral = backfill ? null : await env.DB.prepare(`SELECT COUNT(*) AS count FROM news_articles
    WHERE category<>'바둑' AND summary_quality='full'
      AND datetime(COALESCE(NULLIF(published_at,''),fetched_at))>=datetime('now','-24 hours')`).first();
  // 이 게이트는 일반이 뒤처질 때 바둑 전용 해석에 쓰이는 subrequest를 아끼려고
  // 있다. 바둑 전용 실행에서는 아낄 일반 작업이 아예 없으므로 걸면 안 된다.
  // 걸어두면 바둑만 돌리는 호출이 정작 바둑 후보를 하나도 못 만든다.
  const generalBelowDailyGoal = backfill || badukOnly ? false : Number(recentGeneral?.count || 0) < 10;
  // Google News is discovery-only: resolve each headline through the licensed
  // Naver API, then fetch and validate the real article like every other item.
  // Never expose a Google wrapper or its short RSS description as a summary.
  // Discovery is intentionally broader than the processing batch. Some Google
  // headlines resolve to duplicates, blocked destinations, or pages whose body
  // cannot be extracted. Resolve enough headlines to still fill the six-item
  // scheduled baduk batch after those expected losses.
  //
  // Every resolution attempt here is a Worker subrequest (up to 2 each: Naver
  // then a Kakao fallback), and this loop is 100% baduk - googleDiscoveries is
  // fed only from the baduk-only discovery script. A Worker invocation has a
  // hard subrequest cap, and this loop alone can spend 40+ of them before a
  // single general candidate is ever fetched. Baduk already met its daily
  // publish goal in every run that measured this; general has been stuck at
  // ~2/10 for days. Skip this baduk-only spend entirely while general is
  // still behind so the budget survives long enough to fetch general bodies.
  // 구글이 주는 링크(news.google.com/rss/articles/...)는 클라이언트 JS로만 풀리는
  // 껍데기다. 2026-08-11 실측: 그 페이지를 받아보면 578KB짜리 구글 앱 셸이고 안에
  // 원문 URL이 아예 없다. 그러니 제목을 네이버·카카오에서 다시 찾아 **진짜 기사
  // 링크로 바꾼 것만** 후보에 넣는다. 못 바꾸면 후보 자체를 버린다.
  //
  // 아래 두 호출부(디스커버리 스크립트가 넘겨준 제목, 그리고 워커가 직접 부르는
  // RSS 폴백)가 같은 판정을 써야 한다. 예전에는 이 해석 로직이 디스커버리
  // 경로에만 있었고 폴백은 껍데기 URL을 그대로 밀어 넣었다.
  const headlineMatch = (matches, wanted) => matches.find(item => {
    const left = cleanTitle(item.title).replace(/[^0-9A-Za-z가-힣]/g, '');
    const right = wanted.replace(/[^0-9A-Za-z가-힣]/g, '');
    return left === right || (Math.min(left.length, right.length) >= 18 && (left.includes(right) || right.includes(left)));
  });
  const resolveBadukHeadline = async rawTitle => {
    const discoveredTitle = cleanTitle(rawTitle || '');
    if (!discoveredTitle || isRejectedTitle(discoveredTitle)) return false;
    try {
      const match = headlineMatch(await countedNaverSearch(env, `"${discoveredTitle}"`, 1, 3), discoveredTitle);
      if (match) { candidates.push({ category: '바둑', item: match, source: 'NAVER' }); return true; }
    } catch (error) {
      diagnostics.google_resolve_error = String(error?.message || error).slice(0, 120);
    }
    try {
      const match = headlineMatch(await countedKakaoSearch(env, `"${discoveredTitle}"`, 1, 3), discoveredTitle);
      // 이미 특정된 헤드라인을 제목으로 맞춰 찾은 것이라(광범위 키워드 검색이
      // 아니다) 일반 KAKAO 검색 루프와 달리 daum.net 전용 허용목록이 필요 없다.
      // 다른 소스와 같은 스팸/UGC 차단목록만 거치면 된다. 그 허용목록 때문에
      // 자체 도메인을 쓰는 지역 매체가 카카오 검색에 잡혀도 못 들어왔다.
      if (match) { candidates.push({ category: '바둑', item: match, source: 'KAKAO_RESOLVED' }); return true; }
    } catch (error) {
      diagnostics.google_resolve_kakao_error = String(error?.message || error).slice(0, 120);
    }
    return false;
  };
  const discoveryLimit = backfill ? 20 : (badukOnly ? BADUK_ONLY_GOOGLE_DISCOVERIES : SCHEDULED_GOOGLE_DISCOVERIES);
  const usedDiscoveries = generalBelowDailyGoal ? [] : googleDiscoveries.slice(0, discoveryLimit);
  let discoveriesResolved = 0;
  for (const discovery of usedDiscoveries) {
    if (await resolveBadukHeadline(discovery?.title)) discoveriesResolved += 1;
  }
  diagnostics.google_discovered = googleDiscoveries.length;
  // 상한 때문에 버린 건수를 남긴다. 안 적으면 "40건 다 봤다"로 읽힌다.
  diagnostics.google_discoveries_used = usedDiscoveries.length;
  diagnostics.google_discoveries_dropped = Math.max(0, googleDiscoveries.length - usedDiscoveries.length);
  diagnostics.google_discoveries_resolved = discoveriesResolved;
  if (backfill) {
    try {
      const archived = await countedArchivedTop(slot);
      candidates.push(...archived);
      for (const row of archived) {
        const key = await sha256(canonicalUrl(row.item.originallink || row.item.link));
        await env.DB.prepare(`INSERT INTO news_popular_items(title,url_key,score,rank,source,collected_at)
          VALUES(?,?,?,1,'NAVER',CURRENT_TIMESTAMP) ON CONFLICT(title) DO UPDATE SET
          url_key=excluded.url_key,score=MAX(news_popular_items.score,excluded.score),collected_at=CURRENT_TIMESTAMP`)
          .bind(cleanTitle(row.item.title), key, row.archiveScore).run();
      }
      diagnostics.archive_candidates = candidates.length;
    } catch (error) {
      diagnostics.archive_error = String(error?.message || error).slice(0, 120);
    }
  }
  // The GitHub discovery job already supplies Google headlines from a network
  // that Google accepts. Avoid a redundant Worker-origin RSS call, which is
  // frequently rejected with 503 even though discovery already succeeded.
  if (!popularityCandidates.length && !backfill && !googleDiscoveries.length) try {
    // 예전에는 RSS 항목을 source:'GOOGLE'로 그대로 밀어 넣었다. 그 link는 위에
    // 적은 껍데기 URL이라 본문 수집에서 100% 죽는다 - 2026-08-11 바둑 전용
    // 실행에서 body_too_short 8건 중 3건이 정확히 이 경로의
    // "news.google.com:http_503"이었다. 디스커버리 경로와 똑같이 해석해서
    // 진짜 기사 링크가 된 것만 넣는다.
    const headlines = (await countedGoogleNews(badukQuery, 30)).slice(0, 3);
    let resolvedCount = 0;
    for (const item of headlines) if (await resolveBadukHeadline(item.title)) resolvedCount += 1;
    diagnostics.google_fallback_headlines = headlines.length;
    diagnostics.google_fallback_resolved = resolvedCount;
  } catch (error) {
    diagnostics.google_error = String(error?.message || error).slice(0, 120);
  } else if (!backfill) {
    diagnostics.google_fallback_skipped = true;
  }
  // 인기뉴스는 전부 일반이다. 순위 하나를 실제 기사로 바꾸는 데 subrequest가
  // 최대 2회 들어가므로, 바둑 전용 실행에서 이걸 돌리면 정작 바둑 본문을 가져올
  // 예산이 남지 않는다. 이 호출을 따로 떼어낸 이유 자체가 그것이다.
  if (!popularityCandidates.length && !backfill && !badukOnly) try {
    const allPopular = await countedPopularity(slot);
    // Resolving each ranked headline costs up to 2 subrequests (title search
    // + fallback search). Resolving all 20 ate most of a run's Cloudflare
    // subrequest budget before any candidate body fetch, the same budget
    // exhaustion that starved baduk - see SCHEDULED_GOOGLE_DISCOVERIES above.
    // 8 was overly conservative once the double collect() call (see
    // deploy.yml) freed up headroom - test runs showed 0 body_too_short with
    // slack left in the general processing slot, so 12 trades a little of
    // that slack back for a bigger "popular" pool (drives view=popular's
    // home card count) without reintroducing the subrequest exhaustion.
    const popular = allPopular.slice(0, 12);
    // Naver ranking pages often expose legacy rankingRead links. Those links
    // are useful for ranking discovery but frequently return no article body
    // to Workers. Resolve the ranked headline back to its current article URL
    // before fetching and summarizing it.
    const resolvedPopular = await Promise.all(popular.map(async row => {
      if (row.source !== 'NAVER') return row;
      try {
        let matches = await countedNaverSearch(env, `"${row.title}"`, 1, 5);
        const wanted = cleanTitle(row.title).replace(/[^0-9A-Za-z가-힣]/g, '');
        let match = matches.find(item => cleanTitle(item.title).replace(/[^0-9A-Za-z가-힣]/g, '') === wanted)
          || matches.find(item => titleSimilarity(row.title, item.title) >= 0.72);
        if (!match) {
          matches = await countedNaverSearch(env, row.title, 1, 5);
          match = matches.find(item => titleSimilarity(row.title, item.title) >= 0.72);
        }
        // Prefer the publisher's original URL. Naver article pages frequently
        // return an empty/blocked body to Workers even when they open normally
        // in a browser, while the publisher page remains readable.
        const resolvedUrl = match?.originallink || match?.link || '';
        if (resolvedUrl) return { ...row, href: resolvedUrl };
      } catch {}
      return row;
    }));
    diagnostics.popular_resolved = resolvedPopular.filter((row, index) => row.href !== popular[index].href).length;
    diagnostics.popular_found = popular.length;
    for (const row of resolvedPopular) candidates.push({
      category: row.category,
      source: row.source,
      isPopular: true,
      popularityRank: row.rank,
      item: { title: row.title, link: row.href, originallink: row.href, description: '', pubDate: '' }
    });
    for (const row of resolvedPopular) {
      const key = await sha256(canonicalUrl(row.href));
      await env.DB.prepare(`INSERT INTO news_popularity(url_key,score,rank,source,collected_at)
        VALUES(?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(url_key) DO UPDATE SET
        score=excluded.score,rank=excluded.rank,source=excluded.source,collected_at=CURRENT_TIMESTAMP`)
        .bind(key, 101 - row.rank, row.rank, row.source).run();
      await env.DB.prepare(`INSERT INTO news_popular_items(title,url_key,score,rank,source,collected_at)
        VALUES(?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(title) DO UPDATE SET
        url_key=excluded.url_key,score=excluded.score,rank=excluded.rank,source=excluded.source,collected_at=CURRENT_TIMESTAMP`)
        .bind(row.title, key, 101 - row.rank, row.rank, row.source).run();
    }
  } catch (error) {
    diagnostics.popular_error = String(error?.message || error).slice(0, 120);
  }

  const candidateUrl = ({ item, source }) => canonicalUrl(
    source === 'NAVER' && /naver\.com\//i.test(item?.link || '') ? item.link : (item?.originallink || item?.link)
  );
  // 매체가 우리를 막았을 뿐 기사 자체는 포털에 그대로 실려 있는 경우가 많다.
  // 그때는 기사를 버릴 이유가 없다 - 제목으로 포털 미러를 찾아 거기서 읽는다.
  //
  // 2026-08-14 실측: 8/13 "최정, 김은지 꺾고 여자 최고기사 결정전 우승"을 쓴
  // 쿠키뉴스가 403(24시간 5건), 다른 바둑 기사의 sjbnews가 522(5건)였다. 둘 다
  // 다시 불러도 결과가 같지만 포털에는 있다.
  //
  // **두 경로가 같이 써야 한다.** 처음에 새 기사 경로에만 넣었더니 한 번도 발동하지
  // 않았다(portal_mirror_recovered 0) - 막히는 매체의 기사는 대부분 이미 DB에
  // 들어와 있어서 복구 경로를 타기 때문이다. 그래서 함수로 뺀다.
  //
  // 드는 값은 검색 1회 + 본문 1회이고, 예산이 모자라면 시도하지 않는다.
  const recoverViaPortalMirror = async (article, title, fetchUrl, url) => {
    const blockedByHost = /^(?:non_html|http_(?:403|429|5\d\d))$/.test(String(article.fetchStatus || ''));
    if (article.body.length >= 180 || !blockedByHost || budget.remaining() < 2) return article;
    try {
      const mirrors = await countedNaverSearch(env, `"${title}"`, 1, 3);
      const mirror = mirrors.find(found => titleIsTruncationOf(title, cleanTitle(found.title))
        || titleSimilarity(found.title, title) >= 0.9);
      const mirrorUrl = canonicalUrl(readableArticleUrl(mirror?.originallink || mirror?.link || '', mirror?.link || ''));
      if (!mirrorUrl || mirrorUrl === fetchUrl || mirrorUrl === url) {
        diagnostics.portal_mirror_missing = Number(diagnostics.portal_mirror_missing || 0) + 1;
        return article;
      }
      const viaMirror = await countedFetchArticle(mirrorUrl);
      if (viaMirror.body.length < 180) {
        diagnostics.portal_mirror_missing = Number(diagnostics.portal_mirror_missing || 0) + 1;
        return article;
      }
      diagnostics.portal_mirror_recovered = Number(diagnostics.portal_mirror_recovered || 0) + 1;
      return viaMirror;
    } catch (error) {
      diagnostics.portal_mirror_error = String(error?.message || error).slice(0, 120);
      return article;
    }
  };
  // 기사 본문을 받아오는 **유일한 입구**. 예전에는 같은 절차가 네 군데에 각각
  // 적혀 있었고, 그중 미러 복구가 붙은 곳은 두 군데뿐이었다. 그래서 정작 막히는
  // 매체의 기사가 대부분 지나가는 경로에는 복구가 없었고, 복구는 배포하고도
  // 한 번도 발동하지 않았다(2026-08-14 실측 portal_mirror_recovered 0).
  //
  // 절차는 셋이다:
  //   1) 읽기 좋은 주소(포털 미러가 있으면 그쪽)를 먼저 부른다
  //   2) 본문이 짧으면 원주소로 한 번 더 부른다
  //   3) 그래도 짧고 그 이유가 매체 차단이면 제목으로 미러를 찾아 거기서 읽는다
  // 새 호출 자리를 만들 때 이 함수를 쓰면 세 절차가 저절로 따라온다.
  const acquireArticle = async (url, link, title) => {
    const fetchUrl = readableArticleUrl(url, link || '');
    let article = await countedFetchArticle(fetchUrl);
    if (article.body.length < 300 && fetchUrl !== url) article = await countedFetchArticle(url);
    article = await recoverViaPortalMirror(article, title, fetchUrl, url);
    return { article, fetchUrl };
  };
  const processCandidate = async ({ category, item, source, isPopular = false, urlKey: knownUrlKey = '' }) => {
    const outcome = reason => {
      diagnostics.candidate_outcomes ||= {};
      diagnostics.candidate_outcomes[reason] = Number(diagnostics.candidate_outcomes[reason] || 0) + 1;
      diagnostics.candidate_outcomes_by_category ||= {};
      const bucket = category === '바둑' ? 'baduk' : 'general';
      diagnostics.candidate_outcomes_by_category[bucket] ||= {};
      diagnostics.candidate_outcomes_by_category[bucket][reason]
        = Number(diagnostics.candidate_outcomes_by_category[bucket][reason] || 0) + 1;
      return 0;
    };
    // 후보 하나가 최악의 경우 쓰는 양: 본문 2회 + 요약 2회. 그만큼 안 남았으면
    // 시작하지 않는다. 도중에 한도를 넘으면 그 후보는 error_로 죽으면서 멀쩡한
    // 매체의 실패로 기록되는데, 그건 진단을 오염시키고 예전에는 격리까지 불렀다.
    if (!budget.canStartCandidate()) {
      diagnostics.subrequest_budget_stopped = Number(diagnostics.subrequest_budget_stopped || 0) + 1;
      return outcome('subrequest_budget');
    }
    const url = candidateUrl({ item, source });
    const title = cleanTitle(item.title);
    const publishedAt = parseDate(item.pubDate);
    if (!url || !title || GENERIC_TITLES.has(title) || isRejectedTitle(title) || !/^https?:\/\//.test(url)) return outcome('invalid_metadata');
    if (!allowedCandidate(url, source)) return outcome('disallowed_url');
    if (publishedAt && Date.parse(publishedAt) < Date.now() - 30 * 86400000) return outcome('too_old');
    const press = item.press || pressFromTitle(item.title);
    const urlKey = knownUrlKey || await sha256(url);
    const exists = await env.DB.prepare(`SELECT a.id,a.title,a.image_url,a.summary_quality,a.raw_summary,
        a.body_text,a.category,a.published_at,
        COALESCE(f.attempts,0) AS summary_attempts, f.last_attempt AS summary_last_attempt
      FROM news_articles a LEFT JOIN news_summary_attempts f ON f.url_key=a.url_key
      WHERE a.url_key=?`).bind(urlKey).first();
    if (exists) {
      if (exists.summary_quality === 'full') {
        // 이미 발행된 기사는 제목을 다시 쓰지 않는다. 단 하나, 예전 cleanTitle이
        // 공백 없는 하이픈을 언론사 꼬리표로 오인해 잘라 저장한 제목만 되살린다
        // ("전북바둑협회-장쑤성 청소년 바둑대회 성료" -> "전북바둑협회").
        // 지금 검색 결과가 저장본으로 시작하면서 더 길 때만 늘리므로, 다른
        // 기사의 제목으로 바뀌는 일은 없다. 앞부분인지 볼 때 공백은 무시한다.
        // 검색 API가 준 제목은 띄어쓰기가 저장본과 다른 경우가 흔해서
        // ("전북 바둑협회"로 저장된 기사의 원문 제목은 "전북바둑협회-...")
        // 글자 그대로 비교하면 정작 고쳐야 할 행을 그냥 지나쳤다.
        if (titleIsTruncationOf(String(exists.title || ''), title)) {
          await env.DB.prepare('UPDATE news_articles SET title=? WHERE id=?').bind(title, exists.id).run();
          diagnostics.titles_restored = Number(diagnostics.titles_restored || 0) + 1;
        }
        const existingDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(String(exists.published_at || ''));
        const hasSyntheticTime = /T12:00:00\.000Z$/.test(String(exists.published_at || ''));
        const hasDateOnly = isPopular && existingDateOnly;
        const hasMissingTime = !String(exists.published_at || '').trim();
        const hasGenericImage = /baduk\.or\.kr\/images\/common\//i.test(String(exists.image_url || ''));
        // TRUSTED_BADUK (baduk.or.kr) never has a real timestamp, only a date
        // (see koreanBadukLatest, which now sends noon-KST for that date via
        // publishedAt). A literal date-only value here would otherwise never
        // get repaired by the generic path below, which is gated on isPopular
        // and refuses to overwrite a value with ''.
        if (source === 'TRUSTED_BADUK' && existingDateOnly && publishedAt) {
          await env.DB.prepare('UPDATE news_articles SET published_at=? WHERE id=?').bind(publishedAt, exists.id).run();
        }
        if (!exists.image_url || hasSyntheticTime || hasDateOnly || hasMissingTime || hasGenericImage) {
          const { article } = await acquireArticle(url, item.link, title);
          await env.DB.prepare(`UPDATE news_articles SET
            category=CASE WHEN ?<>'' THEN ? ELSE category END,
            press=CASE WHEN ?<>'' THEN ? ELSE press END,
            image_url=CASE WHEN ?<>'' THEN ? ELSE image_url END,
            body_text=CASE WHEN ?<>'' THEN ? ELSE body_text END,
            published_at=CASE WHEN ?<>'' THEN ? ELSE published_at END WHERE id=?`)
            .bind(exists.category === '바둑' ? '' : article.sectionCategory,
              exists.category === '바둑' ? '' : article.sectionCategory,
              article.press, article.press, article.image, article.image, article.body, article.body,
              article.publishedAt || publishedAt, article.publishedAt || publishedAt, exists.id).run();
        }
        return outcome('existing_full');
      }
      const { article } = await acquireArticle(url, item.link, title);
        // 이 경로에는 시도 횟수도 간격도 없어서, 후보에 다시 잡히기만 하면
        // 실행마다 유료 요약을 새로 불렀다. 8/9 07:20 정기 실행의 유료 호출
        // 5건이 전부 여기였고(실패 4 + 성공 1) 신규 기사 몫은 0이었다. 하루
        // 60호출 상한을 실패 복구가 다 먹는 구조다.
        //
        // 기사를 잃지 않는 근거는 위 fetchArticleText가 이 게이트 **밖**에
        // 있다는 것이다. 본문 재수집과 저장(아래 UPDATE의 body_text)은 그대로
        // 돌고, 미루는 것은 유료 호출 하나뿐이다. 재시도가 성공하는 유일한
        // 경로는 본문이 더 잘 긁히는 것인데 그건 계속 일어난다. 같은 본문으로
        // 같은 요약을 다시 요청하는 것만 막는다 - 입력이 같으면 결과도 같다.
        //
        // attempts=0인 첫 시도는 무조건 통과하므로 신규 유입에는 영향이 없다.
        // 기준(6회, 20시간)은 위 retryRows 쿼리와 일부러 똑같이 맞췄다.
        const lastAttemptAt = Date.parse(String(exists.summary_last_attempt || '').replace(' ', 'T') + 'Z');
        // 상한이 찼으면 복구도 요약을 사지 않는다. 이 경로에도 상한이 없어서
        // 하루 발행이 12건을 넘어갔다(2026-08-11 실측 19건).
        const withinDailyLimit = hasPublicationCapacity(exists.category || category);
        const mayResummarize = withinDailyLimit && (forceRetry
          || (Number(exists.summary_attempts || 0) < retryAttemptLimit
            && !(Number.isFinite(lastAttemptAt) && Date.now() - lastAttemptAt < 20 * 3600000)));
        const retryDetail = {};
        const repaired = mayResummarize
          ? await summarize({ title, rawSummary: stripHtml(item.description) || exists.raw_summary, body: article.body || exists.body_text, category }, retryDetail, 'retry')
          : '';
        const valid = recordSummaryRejection(diagnostics, repaired, title, exists.category || category, retryDetail);
        await env.DB.prepare(`UPDATE news_articles SET
          title=?,
          category=CASE WHEN ?<>'' THEN ? ELSE category END,
          press=CASE WHEN ?<>'' THEN ? ELSE press END,
          image_url=CASE WHEN ?<>'' THEN ? ELSE image_url END,
          body_text=CASE WHEN ?<>'' THEN ? ELSE body_text END,
          published_at=CASE WHEN ?<>'' THEN ? ELSE published_at END,
          summary=CASE WHEN ? THEN ? ELSE summary END,
          summary_quality=CASE WHEN ? THEN 'full' ELSE summary_quality END
          WHERE id=?`).bind(title,
            exists.category === '바둑' ? '' : article.sectionCategory,
            exists.category === '바둑' ? '' : article.sectionCategory,
            article.press, article.press, article.image, article.image, article.body, article.body,
            article.publishedAt || publishedAt, article.publishedAt || publishedAt,
            valid ? 1 : 0, repaired, valid ? 1 : 0, exists.id).run();
        if (valid && exists.summary_quality !== 'full') {
          await env.DB.prepare('DELETE FROM news_summary_attempts WHERE url_key=?').bind(urlKey).run();
          consumePublicationCapacity(exists.category || category);
        } else if (retryDetail.ai_attempted && !retryDetail.ai_error) {
          await env.DB.prepare(`INSERT INTO news_summary_attempts(url_key,attempts,last_attempt) VALUES(?,1,CURRENT_TIMESTAMP)
            ON CONFLICT(url_key) DO UPDATE SET attempts=attempts+1,last_attempt=CURRENT_TIMESTAMP`).bind(urlKey).run();
        }
      // 미룬 것과 실제로 실패한 것을 구분해 센다. 둘을 한 이름으로 묶으면
      // 상한 6회가 너무 빡빡한지(미룬 것만 쌓이고 복구가 멈춘다) 판단할 근거가
      // 사라진다.
      // 상한 때문에 미룬 것과 재시도 정책(6회·20시간) 때문에 미룬 것을 구분한다.
      // 한 이름으로 묶으면 어느 쪽을 조절해야 하는지 진단에서 알 수 없다.
      if (!withinDailyLimit) return outcome('existing_repair_over_daily_limit');
      if (!mayResummarize) return outcome('existing_repair_deferred');
      return outcome(valid ? 'existing_repaired' : 'existing_repair_failed');
    }

    if (!hasPublicationCapacity(category)) {
      return outcome('daily_publish_limit');
    }

    const rawSummary = stripHtml(item.description);
    const { article, fetchUrl } = await acquireArticle(url, item.link, title);
    const body = article.body;
    const resolvedPublishedAt = article.publishedAt || publishedAt;
    const resolvedPress = article.press || press;
    if (category !== '바둑' && !isPopular && LOCAL_GENERAL_PRESS.test(resolvedPress)) return outcome('local_general_filtered');
    // Search snippets are discovery data, not an article body. Never create a
    // three-line card when the destination page is missing or cannot be read.
    if (body.length < 180) {
      // Which hosts fail and *why* (blocked/non-html vs. fetched fine but no
      // selector matched) determines whether the fix is a selector tweak or a
      // source that can never be scraped this way. Without this,
      // "body_too_short: 12" gives no lead on what to try next.
      // 예전에는 일반 기사만 기록했다. 그래서 바둑이 하루 2건에 그치는 동안
      // 그 20개 후보가 차단된 건지, 선택자가 안 맞은 건지, 아니면 일반을 먼저
      // 처리하느라 subrequest가 떨어져서 애초에 못 가져온 건지 구분할 근거가
      // 전혀 없었다. 바둑도 같은 기록을 남긴다.
      diagnostics.body_too_short_hosts ||= {};
      try {
        const host = new URL(fetchUrl).hostname;
        const key = `${category === '바둑' ? 'baduk' : 'general'}:${host}:${article.fetchStatus || 'unknown'}`;
        diagnostics.body_too_short_hosts[key] = Number(diagnostics.body_too_short_hosts[key] || 0) + 1;
      } catch {}
      // 장부는 기사 원주소(url)로 적는다. 실제로 받으러 간 주소(fetchUrl)는 네이버
      // 미러일 수 있는데, 후보를 거를 때 보는 것은 원주소다. 둘을 섞어 적으면
      // 장부의 열쇠와 거르는 열쇠가 달라 격리가 영영 발동하지 않는다.
      hostHealth.record(url, false, article.fetchStatus);
      return outcome('body_too_short');
    }
    // 본문을 제대로 받아왔다. 이전 실패 기록이 있으면 지운다 - 매체가 차단을
    // 풀거나 구조를 되돌리면 사람 손 없이 바로 복귀해야 한다.
    hostHealth.record(url, true);
    const finalCategory = category === '바둑'
      ? classify(category, title, body || rawSummary)
      : (article.sectionCategory || classify(category, title, body || rawSummary));
    const payload = { title, rawSummary, body, category: finalCategory };
    // 하나의 보도자료가 매체만 바꿔 10건 넘게 들어오면 예전에는 그 전부가 유료
    // 요약을 받았다. 실측(2026-08-10): 빙그레 부라보콘 대회 기사 14건, 유료 호출
    // 약 42회, 월 예산의 3%. 화면에서는 어차피 한 이슈로 묶여 관련 보도로 보인다.
    // 이미 다룬 이야기면 요약을 아예 사지 않는다. 화면에서 관련 보도로 뜰 때는
    // 제목·언론사·링크만 쓰고 요약은 보이지도 않는다. 예전에는 무료 추출 요약을
    // 만들어 보고 그것이 검증에 걸리면 유료로 되샀는데, 쓰지도 않을 요약 때문에
    // 돈을 쓰는 셈이었다(2026-08-10 실측: 판정 3건, 절감 0원).
    //
    // 대신 summary_quality='duplicate'로 표시해 둔다. 읽기 단계가 이 행을 카드로
    // 세우지 않고 대표 기사의 관련 보도로만 붙인다.
    // 이 기사의 발행일과 같은 날 안에서만 중복을 본다.
    const itemDay = koreaDayKey(Date.parse(resolvedPublishedAt || '') || storedTime(resolvedPublishedAt));
    const dayStories = itemDay ? dayIndex(itemDay) : null;
    const aiSame = aiDuplicates.get(knownUrlKey) || '';
    const duplicateOf = freeDuplicateOf(title, itemDay, finalCategory)
      || (aiSame && itemDay && (storyTitlesByDay.get(itemDay) || []).includes(aiSame) ? aiSame : '');
    let summary = '';
    let validSummary = false;
    if (duplicateOf) {
      diagnostics.story_duplicate_skipped = Number(diagnostics.story_duplicate_skipped || 0) + 1;
      (diagnostics.story_duplicate_samples ||= []).length < 2
        && diagnostics.story_duplicate_samples.push(`${title.slice(0, 28)} <- ${duplicateOf.slice(0, 28)}`);
    } else {
      const newDetail = {};
      summary = await summarize(payload, newDetail);
      validSummary = recordSummaryRejection(diagnostics, summary, title, finalCategory, newDetail);
      // 같은 실행에 같은 보도자료가 몰려 들어와도 첫 건만 요약을 받게 한다.
      if (validSummary && dayStories) {
        dayStories.add(title);
        storyTitlesByDay.get(itemDay).push(title);
      }
    }

    await env.DB.prepare(`
      INSERT INTO news_articles
        (url,url_key,title,source,press,category,published_at,raw_summary,body_text,summary,summary_quality,image_url)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(url_key) DO UPDATE SET
        title=excluded.title, press=excluded.press, category=excluded.category,
        published_at=excluded.published_at, raw_summary=excluded.raw_summary,
        body_text=CASE WHEN length(excluded.body_text)>length(news_articles.body_text) THEN excluded.body_text ELSE news_articles.body_text END,
        summary=CASE WHEN length(excluded.summary)>length(news_articles.summary) THEN excluded.summary ELSE news_articles.summary END,
        summary_quality=excluded.summary_quality
    `).bind(
      url, urlKey, title, articleSource(url, source, article.press || press), article.press || press, finalCategory, resolvedPublishedAt, rawSummary,
      body, validSummary ? summary : '', duplicateOf ? 'duplicate' : (validSummary ? 'full' : 'none'), article.image
    ).run();
    if (validSummary) consumePublicationCapacity(finalCategory);
    outcome(duplicateOf ? 'inserted_duplicate' : (validSummary ? 'inserted_publishable' : 'inserted_pending_summary'));
    return 1;
  };
  const uniqueCandidates = [];
  const candidateUrls = new Set();
  let disallowedBeforeBatch = 0;
  let quarantineSkipped = 0;
  for (const candidate of candidates) {
    const key = candidateUrl(candidate);
    if (!key || candidateUrls.has(key)) continue;
    candidateUrls.add(key);
    // 통과할 수 없는 후보는 배치 상한 **앞에서** 버린다. 예전에는 20슬롯을 채운
    // 뒤 처리 단계에서 걸러서, 절대 못 들어올 후보가 슬롯을 차지했다. 실측
    // 2026-08-11: 카카오 채택을 1건에서 5건으로 올리자 바둑 20칸 중 10칸이
    // disallowed_url로 날아갔다 - 카카오 광범위 검색은 daum.net만 허용되는데
    // 그 판정이 슬롯을 배정한 다음에야 돌았기 때문이다.
    if (!allowedCandidate(key, candidate.source)) { disallowedBeforeBatch += 1; continue; }
    // 계속 실패하는 매체는 슬롯을 배정하기 전에 뺀다. 본문을 영영 못 주는 곳이
    // 매 실행 20칸 중 몇 칸씩 가져가고 subrequest까지 쓰는 동안, 정작 가져올 수
    // 있는 기사가 밀렸다. 실측 2026-08-12: kukinews는 브라우저 UA로도 403,
    // esquirekorea는 JS로만 그려 2KB 껍데기만 온다 - 둘 다 몇 번을 다시 불러도
    // 결과가 같은데 매 실행 다시 불렀다.
    //
    // 다만 **버리는 것은 기사가 아니라 그 주소**여야 한다. 격리 판정을 원문
    // 주소에 걸었더니, 포털에 그대로 미러돼 있어 얼마든지 읽을 수 있는 기사까지
    // 통째로 사라졌다 - 2026-08-14 실측: 8/13 "최정, 김은지 꺾고 여자 최고기사
    // 결정전 우승"을 쿠키뉴스가 썼는데 그 호스트가 403으로 격리돼 있어서 24시간
    // 바둑이 0건이 됐다. 실제로 받으러 갈 주소(readableArticleUrl)가 격리 대상이
    // 아니면 통과시킨다. 이 값이 곧 fetchArticleText가 먼저 부르는 주소다.
    const fetchTarget = readableArticleUrl(key, candidate.item?.link || '');
    if (hostHealth.isQuarantined(fetchTarget) && hostHealth.isQuarantined(key)) { quarantineSkipped += 1; continue; }
    uniqueCandidates.push({ ...candidate, urlKey: await sha256(key) });
  }
  // 버린 건수는 남긴다. 안 남기면 후보가 왜 적은지 진단에서 사라진다.
  diagnostics.disallowed_before_batch = disallowedBeforeBatch;
  const knownCandidateKeys = new Set();
  // 이미 저장된 후보의 카테고리도 같이 읽는다. 바둑 검색에는 저장 카테고리가
  // 일반인 기사가 섞이는데(기원에서 벌어진 사건, 바둑을 소재로 쓴 문화 기사),
  // 바둑 전용 실행에서 그것들이 슬롯을 가져가면 정작 바둑이 밀린다.
  const storedCategoryByKey = new Map();
  if (uniqueCandidates.length) {
    const placeholders = uniqueCandidates.map(() => '?').join(',');
    const knownRows = await env.DB.prepare(`SELECT url_key,category FROM news_articles WHERE url_key IN (${placeholders})`)
      .bind(...uniqueCandidates.map(candidate => candidate.urlKey)).all();
    for (const row of knownRows.results || []) {
      knownCandidateKeys.add(row.url_key);
      storedCategoryByKey.set(row.url_key, String(row.category || ''));
    }
  }
  uniqueCandidates.sort((a, b) => {
    // Official baduk.or.kr candidates are few (<=12) and high-trust, so a new
    // one should never lose its slot to noisy generic-search candidates that
    // mostly fail allowedCandidate(). But once an official item is already
    // stored, it doesn't need a slot every single run - only boost it while
    // it's still new, or every already-published TRUSTED_BADUK item
    // permanently occupies most of the fixed-size baduk batch forever and
    // starves out every other source (which is what happened here).
    const trustedNewOrder = Number(b.source === 'TRUSTED_BADUK' && !knownCandidateKeys.has(b.urlKey))
      - Number(a.source === 'TRUSTED_BADUK' && !knownCandidateKeys.has(a.urlKey));
    if (trustedNewOrder) return trustedNewOrder;
    const newOrder = Number(knownCandidateKeys.has(a.urlKey)) - Number(knownCandidateKeys.has(b.urlKey));
    if (newOrder) return newOrder;
    const badukOrder = Number(b.category === '바둑') - Number(a.category === '바둑');
    if (badukOrder) return badukOrder;
    const popularOrder = Number(Boolean(b.isPopular)) - Number(Boolean(a.isPopular));
    if (popularOrder) return popularOrder;
    const recentOrder = (Date.parse(b.item?.pubDate || '') || 0) - (Date.parse(a.item?.pubDate || '') || 0);
    if (recentOrder) return recentOrder;
    return Number(a.popularityRank || 999) - Number(b.popularityRank || 999);
  });
  const limitedCandidates = popularityCandidates.length
    ? uniqueCandidates.slice(popularityOffset, popularityOffset + POPULARITY_REPAIR_BATCH_SIZE)
    : (backfill ? uniqueCandidates.slice(0, 8) : [
        ...uniqueCandidates
          // 바둑 전용 실행에서는 이미 일반으로 분류돼 저장된 기사에 슬롯을 주지
          // 않는다. 그 기사들은 일반의 하루 상한(12)에 걸려 어차피 아무것도 못
          // 하면서 칸만 먹는다 - 2026-08-14 실측: baduk_only 실행의 20칸 중
          // 8칸이 existing_repair_over_daily_limit이었고 바둑 발행은 0건이었다.
          // 아직 저장 안 된 후보(카테고리 미상)는 그대로 통과시킨다.
          .filter(candidate => candidate.category === '바둑'
            && !(badukOnly && (storedCategoryByKey.get(candidate.urlKey) || '바둑') !== '바둑'))
          .slice(0, SCHEDULED_BADUK_CANDIDATES),
        ...(badukOnly ? []
          : uniqueCandidates.filter(candidate => candidate.category !== '바둑').slice(0, SCHEDULED_GENERAL_CANDIDATES))
      ]);
  diagnostics.general_recent_publishable = Number(recentGeneral?.count || 0);
  diagnostics.general_daily_goal = 10;
  diagnostics.google_discovery_resolve_skipped = generalBelowDailyGoal;
  diagnostics.candidates = candidates.length;
  diagnostics.unique_candidates = uniqueCandidates.length;
  diagnostics.new_candidates = uniqueCandidates.filter(candidate => !knownCandidateKeys.has(candidate.urlKey)).length;
  diagnostics.existing_candidates = uniqueCandidates.length - diagnostics.new_candidates;
  diagnostics.processed_candidates = limitedCandidates.length;
  diagnostics.processed_by_category = {
    baduk: limitedCandidates.filter(candidate => candidate.category === '바둑').length,
    general: limitedCandidates.filter(candidate => candidate.category !== '바둑').length
  };
  // 요약을 사기 전에 AI에게 "이미 다룬 이야기인가"를 한 번 묻는다. 실행당 1회,
  // 약 $0.0015. 요약 한 건($0.0126)만 막아도 여덟 번치가 나온다.
  //
  // 예전에는 바둑 후보에만 걸었다("효과와 오판정을 먼저 보고 일반으로 넓힌다").
  // 그래서 일반 기사는 유료 요약을 사기 전에 AI 판정을 한 번도 안 받았다. 실측
  // 2026-08-11: 노원구 기원 살인(분류는 사회다) 후속 기사가 같은 날 이미 실린
  // 기사와 겹치는데 그대로 요약을 샀다. 이제 일반도 함께 싣는다.
  //
  // 호출 수는 늘지 않는다. 이 판정은 후보를 한 번에 묶어 보내는 배치라, 바둑과
  // 일반을 같은 호출에 실으면 실행당 1회 그대로다. 늘어나는 것은 프롬프트 길이뿐.
  //
  // 그 길이도 아낀다: 위 무료 규칙(freeDuplicateOf)이 이미 중복이라고 판정한
  // 후보는 AI에 물어볼 이유가 없으므로 프롬프트에서 뺀다. 무료로 가릴 수 있는
  // 것에 토큰을 쓰지 않는다.
  const aiDuplicates = new Map();
  const candidateDay = candidate => koreaDayKey(
    Date.parse(parseDate(candidate.item?.pubDate) || '') || 0
  );
  const dedupTargets = limitedCandidates.filter(candidate => candidate.urlKey
    && !knownCandidateKeys.has(candidate.urlKey)
    && !freeDuplicateOf(cleanTitle(candidate.item?.title || ''), candidateDay(candidate), candidate.category));
  const recentStoryTitles = [...storyTitlesByDay.values()].flat();
  // 중복 판정은 실행당 1회이고 후보가 섞여 있다. 바둑 전용 실행이면 바둑 몫에서,
  // 아니면 일반 몫에서 뺀다 - 바둑 예약분이 일반 실행의 판정 비용에 쓰이지 않게.
  if (dedupTargets.length && recentStoryTitles.length && env.ANTHROPIC_API_KEY
    && await budget.reserveAnthropic(badukOnly ? 'baduk' : 'general')) {
    budget.spend(1);
    const judged = await findDuplicateStories(env,
      dedupTargets.map(candidate => ({ title: cleanTitle(candidate.item?.title || '') })), recentStoryTitles);
    for (const [index, sameTitle] of judged.duplicates) {
      if (dedupTargets[index]?.urlKey) aiDuplicates.set(dedupTargets[index].urlKey, sameTitle);
    }
    if (judged.model) {
      const recorded = await recordClaudeUsage(env, judged.model, judged.usage);
      diagnostics.claude_monthly_micro_usd = recorded.spent;
    }
    diagnostics.ai_dedup_checked = dedupTargets.length;
    diagnostics.ai_dedup_free_skipped = limitedCandidates.filter(candidate => candidate.urlKey
      && !knownCandidateKeys.has(candidate.urlKey)).length - dedupTargets.length;
    diagnostics.ai_dedup_matched = aiDuplicates.size;
  }
  let inserted = 0;
  const badukRetries = pendingRetries.filter(row => row.category === '바둑');
  const generalRetries = pendingRetries.filter(row => row.category !== '바둑');
  const badukCandidates = limitedCandidates.filter(candidate => candidate.category === '바둑');
  const generalCandidates = limitedCandidates.filter(candidate => candidate.category !== '바둑');
  // General is processed first, baduk second. Every fetchArticleText call is
  // a Worker subrequest, and a single invocation has a hard subrequest cap;
  // once the search/popularity-resolution phase above and a batch of baduk
  // candidates had already spent it, every general fetch failed with
  // "Too many subrequests by single Worker invocation" - not a bad URL or a
  // missing selector, an exception thrown before those checks ever ran. Baduk
  // was already hitting its daily goal even starved of leftover budget, so
  // give general first claim on it instead.
  // 2026-08-10: 위 순서가 이제 바둑을 굶기고 있었다. 실측 - 바둑 본문 실패 7건 중
  // 6건이 "Too many subrequests"였고, 정작 일반은 발행 가능한 후보가 22건이나
  // 남아돌았다. 순서를 되돌리면 이번엔 일반이 굶으므로(그래서 이 순서가 됐다)
  // 대신 바둑 전용 호출(badukOnly)을 따로 둔다. Worker 호출마다 subrequest 예산이
  // 새로 주어지므로, 바둑은 일반과 경쟁하지 않는 자기 몫의 예산을 갖게 된다.
  if (!badukOnly) {
    for (const row of generalRetries) await retrySummary(row);
    for (const candidate of generalCandidates) inserted += await processCandidate(candidate);
  }
  for (const row of badukRetries) await retrySummary(row);
  for (const candidate of badukCandidates) inserted += await processCandidate(candidate);
  // 날짜만 남은 발행시각을 매 실행이 조금씩 스스로 되찾는다.
  //
  // 예전에는 이 복구가 workflow_dispatch 입력(repair_times)으로만 돌았다. 즉
  // **사람이 버튼을 눌러야** 카드에 시각이 붙었고, 그래서 "시간 안 나오는 카드가
  // 많다"는 것을 사용자가 먼저 발견해 알려 주는 구조였다. health도 빈 값만 세고
  // 날짜만 있는 값은 통과시켰으니 기계는 아무 말도 안 했다.
  //
  // 남은 subrequest 예산 안에서만, 후보 하나 몫(4)을 남겨 두고 돈다. 본문 수집을
  // 밀어내면 고치려던 것보다 나쁜 결과가 된다. 한 실행에 최대 3건이라 느리지만
  // 정기 실행이 하루 여러 번 돌므로 사람 손 없이 줄어든다.
  //
  // 예산이 빠듯한 실행(백필·바둑전용·인기복구·강제재시도)에서는 건너뛴다.
  if (!backfill && !badukOnly && !forceRetry && !popularityCandidates.length) {
    const timeRepairLimit = Math.min(3, Math.floor((budget.remaining() - SUBREQUESTS_PER_CANDIDATE) / 2));
    // 0을 넘기면 안 된다. repairGeneralArticleTimes의 `Number(limit) || 10`이
    // 0을 거짓으로 보고 기본값 10으로 되돌린다.
    if (timeRepairLimit > 0) {
      const timeRepair = await repairGeneralArticleTimes(env, timeRepairLimit);
      budget.spend(timeRepair.attempted);
      if (timeRepair.attempted) diagnostics.published_time_repair = timeRepair;
    }
  }
  // 격리 장부는 실행당 한 번만 쓴다. 후보마다 쓰면 D1 쓰기가 후보 수만큼 늘고,
  // 어차피 다음 실행 전에는 아무도 읽지 않는다.
  await hostHealth.save();
  const quarantinedNow = hostHealth.quarantinedHosts();
  if (quarantineSkipped) diagnostics.host_quarantine_skipped = quarantineSkipped;
  if (quarantinedNow.length) diagnostics.host_quarantined = quarantinedNow.slice(0, 8);
  diagnostics.baduk_only = badukOnly;
  // 이번 실행이 외부 요청을 얼마나 썼는지. 44에 붙어 있으면 배치가 한 번에
  // 소화할 수 있는 양을 넘었다는 뜻이고, 그건 상수를 조절할 근거가 된다.
  diagnostics.subrequests_used = budget.used();
  diagnostics.publish_counts_after = publicationCounts;
  if (popularityTargetStart) diagnostics.popularity_target_counts_after = popularityTargetCounts;
  return { inserted, diagnostics };
}

export async function onRequestPost({ request, env }) {
  if (!isCollectorAuthorized(request, env)) return json({ ok: false, error: 'Unauthorized' }, 401);
  let runId;
  try {
    await ensureNewsDb(env);
    await env.DB.prepare(`UPDATE news_runs SET finished_at=?,status='error',message='이전 수집이 비정상 종료됨'
      WHERE status='running' AND datetime(started_at) < datetime('now','-10 minutes')`).bind(new Date().toISOString()).run();
    // Bound operational tables so years of scheduled runs do not gradually
    // turn every status/popularity query into an ever-growing scan.
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM news_runs WHERE id NOT IN
        (SELECT id FROM news_runs ORDER BY id DESC LIMIT 500)`),
      env.DB.prepare("DELETE FROM news_popularity WHERE datetime(collected_at)<datetime('now','-60 days')"),
      env.DB.prepare("DELETE FROM news_popular_items WHERE datetime(collected_at)<datetime('now','-60 days')"),
      env.DB.prepare(`DELETE FROM news_summary_attempts WHERE url_key IN
        (SELECT url_key FROM news_articles WHERE summary_quality='full')`)
    ]);
    const started = new Date().toISOString();
    const run = await env.DB.prepare("INSERT INTO news_runs(started_at,status) VALUES(?,'running') RETURNING id").bind(started).first();
    runId = run?.id;
    const requestUrl = new URL(request.url);
    const requestedSource = requestUrl.searchParams.get('source') || 'manual';
    const runSource = ['scheduled', 'watchdog', 'manual'].includes(requestedSource) ? requestedSource : 'manual';
    const backfill = requestUrl.searchParams.get('backfill') === '1';
    const repair = requestUrl.searchParams.get('repair') === '1';
    const forceRetry = requestUrl.searchParams.get('force_retry') === '1';
    const generalBoost = requestUrl.searchParams.get('general_boost') === '1';
    const repairTimes = requestUrl.searchParams.get('repair_times') === '1';
    const repairCategories = requestUrl.searchParams.get('repair_categories') === '1';
    const resetCategories = requestUrl.searchParams.get('reset_categories') === '1';
    const repairGeneralQuality = requestUrl.searchParams.get('repair_general_quality') === '1';
    const popularityDate = requestUrl.searchParams.get('popularity_date') || '';
    const popularityOffset = Math.max(0, Math.min(Number(requestUrl.searchParams.get('popularity_offset')) || 0, 48));
    const repairTitles = requestUrl.searchParams.get('repair_titles') === '1';
    if (repairTitles) {
      const titleQuery = (requestUrl.searchParams.get('q') || '').trim().slice(0, 100);
      const titleRepair = titleQuery
        ? await repairTitleByQuery(env, titleQuery)
        : await repairTruncatedTitles(env, 10, requestUrl.searchParams.get('reset') === '1');
      await env.DB.prepare("UPDATE news_runs SET finished_at=?,status='ok',inserted_count=0,message=? WHERE id=?")
        .bind(new Date().toISOString(), runMessage({ title_repair: titleRepair }), runId).run();
      return json({ ok: true, title_repair: titleRepair });
    }
    if (repairTimes) {
      const timeRepair = await repairGeneralArticleTimes(env);
      await env.DB.prepare("UPDATE news_runs SET finished_at=?,status='ok',inserted_count=0,message=? WHERE id=?")
        .bind(new Date().toISOString(), runMessage({ time_repair: timeRepair }), runId).run();
      return json({ ok: true, time_repair: timeRepair });
    }
    if (repairCategories) {
      const categoryRepair = await repairGeneralCategories(env, 10, resetCategories);
      await env.DB.prepare("UPDATE news_runs SET finished_at=?,status='ok',inserted_count=0,message=? WHERE id=?")
        .bind(new Date().toISOString(), runMessage({ category_repair: categoryRepair }), runId).run();
      return json({ ok: true, category_repair: categoryRepair });
    }
    if (repairGeneralQuality) {
      const qualityRepair = await quarantineWeakSummaries(env);
      const result = await collect(env, {
        repair: true, forceRetry: true, generalBoost: true, generalOnly: true,
        qualityRepairIds: qualityRepair.ids
      });
      await env.DB.prepare("UPDATE news_runs SET finished_at=?,status='ok',inserted_count=0,message=? WHERE id=?")
        .bind(new Date().toISOString(), runMessage({ quality_repair: qualityRepair, diagnostics: result.diagnostics }), runId).run();
      return json({ ok: true, quality_repair: qualityRepair, diagnostics: result.diagnostics });
    }
    if (popularityDate) {
      const popularity = await backfillPopularityDate(env, popularityDate);
      const parsedPopularityDate = Date.parse(`${popularityDate.slice(0, 4)}-${popularityDate.slice(4, 6)}-${popularityDate.slice(6, 8)}T00:00:00Z`);
      const result = await collect(env, {
        forceRetry: true,
        popularityCandidates: popularity.rows.map(row => ({ ...row, popularityDate: parsedPopularityDate })),
        popularityOffset
      });
      // Old popularity repairs stored a made-up noon UTC timestamp, which
      // rendered as 9 PM in Korea. After trying to recover the real timestamp
      // from each article, downgrade only the remaining synthetic values for
      // this ranking day to an honest date-only value.
      const targetDate = `${popularityDate.slice(0, 4)}-${popularityDate.slice(4, 6)}-${popularityDate.slice(6, 8)}`;
      const cleared = await env.DB.prepare(`UPDATE news_articles
        SET published_at=substr(published_at,1,10)
        WHERE published_at=?`).bind(`${targetDate}T12:00:00.000Z`).run();
      result.diagnostics.synthetic_times_cleared = Number(cleared?.meta?.changes || 0);
      await env.DB.prepare("UPDATE news_runs SET finished_at=?,status='ok',inserted_count=?,message=? WHERE id=?")
        .bind(new Date().toISOString(), result.inserted,
          runMessage({ popularity: { date: popularity.date, ranking_items: popularity.ranking_items }, diagnostics: result.diagnostics }), runId).run();
      return json({
        ok: true,
        popularity: { date: popularity.date, ranking_items: popularity.ranking_items },
        inserted: result.inserted,
        diagnostics: result.diagnostics
      });
    }
    let payload = {};
    try {
      if ((request.headers.get('content-type') || '').includes('application/json')) payload = await request.json();
    } catch {}
    const googleDiscoveries = Array.isArray(payload?.googleDiscoveries) ? payload.googleDiscoveries : [];
    const badukOnly = requestUrl.searchParams.get('baduk_only') === '1';
    const result = await collect(env, { backfill, repair, forceRetry, generalBoost, badukOnly, googleDiscoveries });
    result.diagnostics.mode = runSource;
    const warnings = Object.entries(result.diagnostics)
      .filter(([key, value]) => /_error$/.test(key) && value)
      .map(([key, value]) => `${key}: ${value}`);
    if (result.diagnostics.ai_provider_limited) warnings.push('ai_provider_limited');
    const status = warnings.length ? 'degraded' : 'ok';
    const message = runMessage({ warnings, diagnostics: result.diagnostics });
    await env.DB.prepare("UPDATE news_runs SET finished_at=?,status=?,inserted_count=?,message=? WHERE id=?")
      .bind(new Date().toISOString(), status, result.inserted, message, runId).run();
    return json({ ok: true, status, warnings, ...result });
  } catch (error) {
    if (runId) {
      await env.DB.prepare("UPDATE news_runs SET finished_at=?,status='error',message=? WHERE id=?")
        .bind(new Date().toISOString(), String(error.message || error).slice(0, 500), runId).run();
    }
    return json({ ok: false, error: error.message }, 500);
  }
}
