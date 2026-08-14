import {
  isRejectedTitle, normalizeText, publishableSummary, reorderGeneralSummary,
  validateGeneralEditorialSummary, validateThreeLineSummary
} from '../../_lib/news-summary.js';
import { makeBestSummary } from '../../_lib/news-ai-summary.js';
import {
  canonicalUrl, ensureNewsDb, isCollectorAuthorized, json, runMessage, sha256
} from '../../_lib/news-db.js';
import {
  blockCloudflareForToday, canUseClaude, koreaDayKey as budgetDayKey, recordClaudeUsage, reserveCloudflareCall
} from '../../_lib/news-ai-budget.js';
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
// 하루 호출 상한은 폭주 방지용 거친 뚜껑이다. 2026-08-09에 canUseClaude의
// 하루 예산 게이트를 걷어냈으므로 이제 지출을 실제로 묶는 것은 월 목표/하드
// 한도뿐이다. 이 값을 예산에 맞춰 더 낮추지는 않는다 - 같은 것을 두 군데서
// 막으면 어느 쪽이 기사를 끊었는지 진단에서 구분되지 않는다.
const DAILY_ANTHROPIC_CALL_LIMIT = 60;
// 바둑이 이 서비스의 메인이다. 그런데 카운터 하나를 일반과 나눠 쓰면서 한도만
// 달랐다(일반 84, 바둑 60). 일반이 먼저 처리되고 바둑 전용 호출은 매 사이클
// 맨 마지막이라, 일반이 60을 넘겨 쓰는 순간 바둑은 그날 내내 한 건도 못 산다.
//
// 그래서 총량은 그대로 60에 두고 몫만 나눈다.
// - 일반: 24가 하드 상한. 이 위로는 바둑 몫이라 못 넘본다.
// - 바둑: 따로 상한을 두지 않는다(총량까지). 최소 36은 일반이 절대 못 건드리고,
//   일반이 24를 다 안 쓴 날은 남는 것까지 바둑이 가져간다.
// 하루 최대 지출은 예전과 같다 - 총량 60이 유일한 뚜껑이기 때문이다.
//
// 예약분을 20에서 36으로 올린 이유. "바둑 쓰고 남은 걸 일반에 쓴다"가 요구사항인데
// 20/40은 그 반대였다 - 2026-08-14 실측: 60건 중 일반이 39건을 먼저 써서 오전
// 11시에 총량이 바닥났고, 그 뒤 바둑 요약이 기준 미달로 내려갔을 때 다시 살 호출이
// 없었다. 그날 바둑 화면은 0건이었다. 바둑 실사용은 하루 21~28건이라 36이면 굶지
// 않는다. 일반은 24로도 하루 목표 10건을 채운다(최근 12건 발행에 39호출을 썼는데,
// 그 대부분이 이미 요약이 있는 기사의 재시도였다).
export const BADUK_RESERVED_ANTHROPIC_CALLS = 36;
const GENERAL_DAILY_ANTHROPIC_CALL_LIMIT = DAILY_ANTHROPIC_CALL_LIMIT - BADUK_RESERVED_ANTHROPIC_CALLS;
// 바둑의 하루가 사실상 끝난 뒤에는 남은 예약분을 일반이 쓴다. "바둑 쓰고 남은 걸
// 일반에"를 글자 그대로 지키려면, 아침에 미리 떼어 둔 몫을 밤까지 놀리면 안 된다.
// 한국시간 21시를 기준으로 삼는다 - 그 시각이면 그날 바둑 실행이 다 지났다.
const GENERAL_MAY_USE_BADUK_RESERVE_AFTER_KST_HOUR = 21;
const generalLimitForNow = (date = new Date()) => {
  const koreaHour = new Date(date.valueOf() + 9 * 3600000).getUTCHours();
  return koreaHour >= GENERAL_MAY_USE_BADUK_RESERVE_AFTER_KST_HOUR
    ? DAILY_ANTHROPIC_CALL_LIMIT
    : GENERAL_DAILY_ANTHROPIC_CALL_LIMIT;
};
// A boost adds 24 calls to the normal allowance. Keeping this below the
// normal limit made the old "boost" disable Claude once 24 calls were used.
// 부스트는 사람이 손으로 누르는 버튼이라 총량도 같이 올린다 - 일반 몫만 올리고
// 총량을 60에 두면 부스트가 바둑 예약분을 먹는다.
const GENERAL_BOOST_ANTHROPIC_CALL_LIMIT = GENERAL_DAILY_ANTHROPIC_CALL_LIMIT + 24;
const GENERAL_BOOST_DAILY_CEILING = DAILY_ANTHROPIC_CALL_LIMIT + 24;
const BACKFILL_ANTHROPIC_CALL_LIMIT = 200;
const ESTIMATED_SUMMARY_CALL_MICRO_USD = 15_000;
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

async function reserveAiCall(env, diagnostics) {
  const reservation = await reserveCloudflareCall(env);
  if (!reservation.allowed) {
    diagnostics.ai_budget_exhausted = true;
    diagnostics.ai_calls_today = reservation.used;
    return false;
  }
  diagnostics.ai_calls_today = reservation.used;
  return true;
}

// 하루 경계는 한국시간이다(news-ai-budget.js의 koreaDayKey 주석 참고). 이 함수가
// UTC 날짜를 쓰던 동안, 카운터는 아침 9시에 리셋되는데 수집은 새벽 0시·3시·6시에
// 돌아서 새벽 실행이 통째로 "어제치 소진분"을 물려받았다.
async function reserveAnthropicCall(env, diagnostics, forceRetry = false, generalBoost = false, bucket = 'general') {
  // collect() 안에는 타임스탬프를 받는 동명의 지역 함수가 따로 있어 별칭으로 들여온다.
  const day = budgetDayKey();
  const dayRow = await env.DB.prepare("SELECT value FROM news_state WHERE key='anthropic_budget_day'").first();
  if (String(dayRow?.value || '') !== day) {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO news_state(key,value) VALUES('anthropic_budget_day',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(day),
      env.DB.prepare("INSERT INTO news_state(key,value) VALUES('anthropic_calls_today',0) ON CONFLICT(key) DO UPDATE SET value=0"),
      env.DB.prepare("INSERT INTO news_state(key,value) VALUES('anthropic_calls_today_baduk',0) ON CONFLICT(key) DO UPDATE SET value=0"),
      env.DB.prepare("INSERT INTO news_state(key,value) VALUES('anthropic_calls_today_general',0) ON CONFLICT(key) DO UPDATE SET value=0")
    ]);
  }
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
  // 바둑은 자기 상한이 없다. 총량이 유일한 뚜껑이고, 일반이 24에서 멈추므로
  // 최소 36은 언제나 바둑에게 남는다. 밤 9시(한국시간)를 넘기면 그날 바둑
  // 실행이 다 지났으므로 남은 예약분을 일반이 가져다 쓴다.
  const bucketLimit = forceRetry || bucket === 'baduk'
    ? totalLimit
    : (generalBoost ? GENERAL_BOOST_ANTHROPIC_CALL_LIMIT : generalLimitForNow());
  const budget = await canUseClaude(env, ESTIMATED_SUMMARY_CALL_MICRO_USD);
  const recordCounts = () => {
    diagnostics.anthropic_calls_today = daily;
    diagnostics.anthropic_daily_limit = totalLimit;
    diagnostics.anthropic_calls_by_bucket = {
      ...(diagnostics.anthropic_calls_by_bucket || {}),
      [bucket]: bucketUsed
    };
    diagnostics.anthropic_bucket_limit = {
      ...(diagnostics.anthropic_bucket_limit || {}),
      [bucket]: bucketLimit
    };
  };
  if (daily >= totalLimit || bucketUsed >= bucketLimit || !budget.allowed) {
    recordCounts();
    diagnostics.anthropic_budget_exhausted = true;
    // 어느 쪽 뚜껑에 걸렸는지 남긴다. 총량인지, 자기 몫인지, 월 예산인지가
    // 구분되지 않으면 다음에 또 원인을 처음부터 찾게 된다.
    diagnostics.anthropic_exhausted_reason = !budget.allowed ? 'monthly_budget'
      : (daily >= totalLimit ? 'daily_total' : `bucket_${bucket}`);
    diagnostics.claude_monthly_micro_usd = budget.spent;
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

async function blockAiForToday(env, diagnostics) {
  await blockCloudflareForToday(env);
  diagnostics.ai_budget_exhausted = true;
  diagnostics.ai_provider_limited = true;
}

async function collect(env, {
  backfill = false, repair = false, forceRetry = false, generalBoost = false,
  generalOnly = false, badukOnly = false, qualityRepairIds = [], googleDiscoveries = [], popularityCandidates = [], popularityOffset = 0
} = {}) {
  const diagnostics = { mode: backfill ? 'backfill' : 'scheduled', retry_attempted: 0, retry_repaired: 0, samples: [] };
  const now = new Date();
  const koreaNow = new Date(now.valueOf() + 9 * 3600000);
  const dayStart = Date.UTC(koreaNow.getUTCFullYear(), koreaNow.getUTCMonth(), koreaNow.getUTCDate()) - 9 * 3600000;
  const monthStart = Date.UTC(koreaNow.getUTCFullYear(), koreaNow.getUTCMonth(), 1) - 9 * 3600000;
  const publishedRows = await env.DB.prepare(`SELECT a.category,a.title,a.summary,a.published_at,a.fetched_at,
      EXISTS(SELECT 1 FROM news_popular_items p WHERE p.url_key=a.url_key OR p.title=a.title) AS is_popular
    FROM news_articles a WHERE a.summary_quality='full'
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
    if (!validPublishedSummary(row.summary, row.title, row.category)) continue;
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
      if (!validPublishedSummary(row.summary, row.title, row.category)) continue;
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
  // Worker 한 번 호출이 쓸 수 있는 외부 요청은 50개다. 지금까지는 배치 크기
  // 상수를 조절해 그 아래를 맞추려 했는데, 경로가 하나 늘 때마다 다시 넘었다.
  // 2026-08-14 실측: 24시간에 7건이 "Too many subrequests by single Worker
  // invocation"으로 죽었고, 그 실패가 매체 탓으로 기록됐다 - 멀쩡한 기사가
  // body_too_short로 세어지고, 어제까지는 그 매체가 격리까지 됐다. 우리 쪽
  // 한도를 매체 고장으로 오진하는 구조였다.
  //
  // 상수로 맞추는 대신 센다. 후보마다 드는 비용이 다르므로(이미 아는 기사는
  // 본문만, 새 기사는 본문 2회 + 요약 1회) 세는 편이 항상 맞다. 남은 예산이
  // 없으면 후보를 **시작하지 않고** 진단에 남긴다 - 실패로 남기는 것보다
  // 안 하는 편이 낫고, 다음 실행이 그 후보를 그대로 이어받는다.
  const SUBREQUEST_BUDGET = 44;
  let subrequestsUsed = 0;
  const countedFetchArticle = async value => {
    subrequestsUsed += 1;
    return fetchArticleText(value);
  };
  const subrequestsLeft = () => SUBREQUEST_BUDGET - subrequestsUsed;
  // 검색·순위 수집도 같은 예산에서 나간다. 본문만 세면 후보를 처리하기도 전에
  // 예산의 절반이 이미 사라진 상태를 모른 채 시작하게 된다. 순위·아카이브 수집은
  // 안에서 여러 번 부르므로 넉넉히 잡는다 - 적게 잡아 넘기는 쪽이 더 나쁘다.
  const counted = (fn, cost = 1) => (...args) => { subrequestsUsed += cost; return fn(...args); };
  const countedNaverSearch = counted(naverSearch);
  const countedKakaoSearch = counted(kakaoSearch);
  const countedBadukLatest = counted(koreanBadukLatest);
  const countedGoogleNews = counted(googleNewsSearch, 2);
  const countedPopularity = counted(collectPopularity, 3);
  const countedArchivedTop = counted(collectArchivedTop, 3);
  const summarize = async (payload, detail, purpose = 'new', { freeOnly = false } = {}) => {
    const trace = detail || {};
    // 요약 한 번이 외부 요청 한 번이 아니다. Anthropic이 실패하면 Cloudflare AI로
    // 한 번 더 나간다. 1로 세다가 실제로는 2가 나가서, 예산을 센 뒤에도 한도를
    // 넘긴 실행이 남았다(2026-08-14 실측: subrequest_overflow_failures 2건).
    // 적게 세는 쪽이 더 나쁘다 - 넘기면 후보가 죽고 그게 매체 탓으로 기록된다.
    subrequestsUsed += 2;
    // 어느 몫에서 돈을 빼는지. payload.category가 비면 일반으로 본다 - 바둑 몫을
    // 실수로 쓰는 쪽보다 안 쓰는 쪽이 안전하다.
    const bucket = publicationBucket(payload.category);
    const sourceLength = normalizeText(payload.body || payload.rawSummary).length;
    // freeOnly: 이미 같은 이야기를 요약해 둔 기사다. 카드로 세워질 일이 없으므로
    // 무료 추출 요약이면 충분하다. 호출부는 이 결과가 검증을 통과하지 못하면
    // 유료 경로로 다시 부른다 - 중복 판정이 틀렸더라도 기사를 잃지 않기 위해서다.
    if (freeOnly || sourceLength < 300) {
      const extractive = await makeBestSummary({ AI: undefined, ANTHROPIC_API_KEY: undefined }, payload, trace);
      if (extractive) diagnostics.extractive_fallback_used = Number(diagnostics.extractive_fallback_used || 0) + 1;
      return extractive;
    }

    let cloudflareReserved = Boolean(env.AI);
    if (cloudflareReserved) cloudflareReserved = await reserveAiCall(env, diagnostics);

    let summary = '';
    if (cloudflareReserved) {
      summary = await makeBestSummary({ ...env, ANTHROPIC_API_KEY: undefined, NEWSBRIEF_USE_ANTHROPIC: '0' }, payload, trace);
      const cloudflareValid = trace.ai_provider === 'cloudflare'
        && trace.structurally_valid && trace.numbers_grounded;
      if (cloudflareValid) return summary;
    }
    if (cloudflareReserved && /(?:daily free allocation|Account limited|3036|4006)/i.test(String(trace.ai_error || ''))) {
      await blockAiForToday(env, diagnostics);
    }

    if (env.ANTHROPIC_API_KEY && await reserveAnthropicCall(env, diagnostics, forceRetry, generalBoost, bucket)) {
      const anthropicTrace = {};
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

    const extractive = summary || await makeBestSummary({
      AI: undefined,
      ANTHROPIC_API_KEY: undefined
    }, payload, trace);
    if (extractive) diagnostics.extractive_fallback_used = Number(diagnostics.extractive_fallback_used || 0) + 1;
    return extractive;
  };
  // 본문을 못 주는 매체를 스스로 기억하고 스스로 풀어준다.
  //
  // 사람이 차단 목록을 손으로 관리하면, 새로 막힌 매체가 생길 때마다 누군가
  // 진단을 읽고 목록에 적어야 한다. 그 사이 그 매체는 매 실행 슬롯과
  // subrequest를 가져간다(2026-08-12 실측: 바둑 20칸 중 6칸이 body_too_short).
  //
  // 연속 실패가 기준을 넘으면 하루 동안 후보에서 뺀다. 하루가 지나면 자동으로
  // 한 번 다시 시도하고, 그때 성공하면 기록이 지워진다. 매체가 차단을 풀거나
  // 페이지 구조를 바꾸면 사람이 아무것도 안 해도 돌아온다.
  //
  // 핵심 소스는 격리하지 않는다. 한국기원이 잠깐 흔들렸다고 바둑의 원천을
  // 하루 동안 끊으면, 고치려던 것보다 큰 구멍이 난다.
  //
  // 다만 예외는 **본문을 실제로 주는 뉴스 호스트**로 좁힌다. naver.com 전체를
  // 열어 두면 entertain.naver.com처럼 JS로만 그리는 페이지가 영원히 재시도된다
  // (2026-08-12 실측: 홈·랭킹·기사 모두 2KB 껍데기, 매 실행 selector_miss 2건).
  // 격리 예외는 "믿는 곳"이 아니라 "본문이 오는 곳"이어야 한다.
  const QUARANTINE_FAIL_THRESHOLD = 5;
  const QUARANTINE_HOURS = 24;
  const NEVER_QUARANTINE = /(?:^|\.)(?:baduk\.or\.kr|news\.naver\.com|v\.daum\.net|news\.daum\.net)$/i;
  // 판정 규칙을 바꾸면 옛 규칙으로 쌓인 장부는 버린다. 규칙만 고치고 장부를
  // 두면, 이제는 격리하지 않기로 한 사유로 이미 5회가 쌓인 매체가 그대로 갇혀
  // 있다 - 고쳤는데 아무것도 안 달라지는 상태가 24시간 이어진다. 이 값을 올리는
  // 것이 곧 "옛 판정으로 갇힌 곳을 전부 풀어준다"는 뜻이다.
  const QUARANTINE_RULE_VERSION = '2';
  const hostHealthRow = await env.DB.prepare("SELECT value FROM news_state WHERE key='article_host_health'").first();
  let hostHealth = {};
  try { hostHealth = JSON.parse(String(hostHealthRow?.value || '{}')) || {}; } catch { hostHealth = {}; }
  let hostHealthChanged = false;
  if (String(hostHealth.__rule || '') !== QUARANTINE_RULE_VERSION) {
    diagnostics.host_quarantine_reset = Object.keys(hostHealth).filter(key => key !== '__rule').length;
    hostHealth = { __rule: QUARANTINE_RULE_VERSION };
    hostHealthChanged = true;
  }
  const candidateHost = value => {
    try { return new URL(value).hostname.toLowerCase(); } catch { return ''; }
  };
  const quarantinedHost = value => {
    const host = candidateHost(value);
    if (!host || NEVER_QUARANTINE.test(host)) return false;
    const record = hostHealth[host];
    if (!record || Number(record.fail || 0) < QUARANTINE_FAIL_THRESHOLD) return false;
    const lastAttempt = Date.parse(String(record.at || '')) || 0;
    // 하루가 지나면 한 번 통과시켜 본다(탐침). 실패하면 at이 갱신돼 또 하루 쉰다.
    return Date.now() - lastAttempt < QUARANTINE_HOURS * 3600000;
  };
  // 매체 탓인 실패만 장부에 적는다. 본문 실패는 원인이 뒤섞여 들어온다 - 우리가
  // 그 실행의 subrequest를 다 써서 못 가져온 것(error_...)도, 그 기사 한 건이
  // 지워진 것(http_404·dead_page)도 같은 자리로 떨어진다. 그것까지 세면 우리
  // 쪽 사정으로 멀쩡한 매체가 24시간 차단되고, 바둑처럼 매체 수가 적은 쪽은
  // 그대로 기사가 끊긴다. 고치려던 것보다 큰 고장을 만드는 길이다.
  //
  // 그래서 "몇 번을 다시 불러도 결과가 같은" 것만 센다: 차단(403·429), 서버가
  // 계속 죽어 있는 것(5xx), HTML이 아닌 것.
  //
  // selector_miss는 뺀다. 그건 매체가 우리를 막은 게 아니라 **우리가 그 CMS의
  // 본문 자리를 모르는 것**이고, 고칠 수 있는 유일한 종류다. 격리해 버리면 두
  // 가지를 동시에 잃는다: 그 매체의 기사 전부, 그리고 body_too_short_hosts에서
  // 사라져 무엇을 고쳐야 하는지 알 단서까지. 2026-08-14 실측: 하루 만에 8개
  // 호스트가 격리됐고(gamefocus·game.donga는 selector_miss만으로) 그 사이 24시간
  // 바둑 발행이 0건이 됐다. 선택자를 넓히는 일은 사람이 해야 하므로, 계속 눈에
  // 띄게 두는 편이 맞다 - 조용히 감추면 영영 안 고친다.
  const HOST_ATTRIBUTABLE_FAILURE = /^(?:non_html|http_(?:403|429|5\d\d))$/;
  const recordHostResult = (value, ok, fetchStatus = '') => {
    const host = candidateHost(value);
    if (!host || NEVER_QUARANTINE.test(host)) return;
    if (ok) {
      if (hostHealth[host]) { delete hostHealth[host]; hostHealthChanged = true; }
      return;
    }
    if (!HOST_ATTRIBUTABLE_FAILURE.test(String(fetchStatus || ''))) return;
    hostHealth[host] = { fail: Number(hostHealth[host]?.fail || 0) + 1, at: new Date().toISOString() };
    hostHealthChanged = true;
  };
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
  if (!popularityCandidates.length && !backfill) {
    const freshQualitySweep = await quarantineWeakSummaries(env, { limit: 120, days: 3 });
    if (freshQualitySweep.quarantined) {
      diagnostics.weak_summary_quarantined = freshQualitySweep.quarantined;
      diagnostics.weak_summary_samples = freshQualitySweep.samples;
    }
    diagnostics.weak_summary_checked = freshQualitySweep.checked;
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
      if (fixedCategory !== '바둑' && row.summary) {
        const reordered = reorderGeneralSummary(row.summary, row.title);
        if (!validateGeneralEditorialSummary(reordered, row.title)) {
          await env.DB.prepare("UPDATE news_articles SET summary='',summary_quality='none' WHERE id=?").bind(row.id).run();
          diagnostics.general_summaries_quarantined = Number(diagnostics.general_summaries_quarantined || 0) + 1;
        } else if (reordered !== row.summary) {
          await env.DB.prepare('UPDATE news_articles SET summary=? WHERE id=?').bind(reordered, row.id).run();
          diagnostics.general_summaries_reordered = Number(diagnostics.general_summaries_reordered || 0) + 1;
        }
      }
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
    if (subrequestsLeft() < 4) {
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
          const fetchUrl = readableArticleUrl(url, item.link || '');
          let article = await countedFetchArticle(fetchUrl);
          if (article.body.length < 300 && fetchUrl !== url) article = await countedFetchArticle(url);
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
      const fetchUrl = readableArticleUrl(url, item.link || '');
      let article = await countedFetchArticle(fetchUrl);
      if (article.body.length < 300 && fetchUrl !== url) article = await countedFetchArticle(url);
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
        const valid = validPublishedSummary(repaired, title, exists.category || category);
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
    const fetchUrl = readableArticleUrl(url, item.link || '');
    let article = await countedFetchArticle(fetchUrl);
    if (article.body.length < 300 && fetchUrl !== url) article = await countedFetchArticle(url);
    // 매체가 우리를 막았을 뿐 기사 자체는 포털에 그대로 실려 있는 경우가 많다.
    // 그때는 기사를 버릴 이유가 없다 - 제목으로 포털 미러를 찾아 거기서 읽는다.
    // 2026-08-14 실측: 8/13 "최정, 김은지 꺾고 여자 최고기사 결정전 우승"은
    // 쿠키뉴스가 403, 같은 날 다른 바둑 기사는 sjbnews가 522였고, 그 매체들이
    // 24시간 바둑 실패의 대부분이었다. 둘 다 우리가 다시 불러도 결과가 같지만
    // 포털에는 있다. 이 저장소가 이미 쓰는 방법이고(위 repair 경로), 드는 값은
    // 검색 1회 + 본문 1회다.
    const blockedByHost = /^(?:non_html|http_(?:403|429|5\d\d))$/.test(String(article.fetchStatus || ''));
    if (article.body.length < 180 && blockedByHost && subrequestsLeft() >= 2) {
      try {
        const mirrors = await countedNaverSearch(env, `"${title}"`, 1, 3);
        const mirror = mirrors.find(found => titleIsTruncationOf(title, cleanTitle(found.title))
          || titleSimilarity(found.title, title) >= 0.9);
        const mirrorUrl = canonicalUrl(readableArticleUrl(mirror?.originallink || mirror?.link || '', mirror?.link || ''));
        if (mirrorUrl && mirrorUrl !== fetchUrl && mirrorUrl !== url) {
          const viaMirror = await countedFetchArticle(mirrorUrl);
          if (viaMirror.body.length >= 180) {
            article = viaMirror;
            diagnostics.portal_mirror_recovered = Number(diagnostics.portal_mirror_recovered || 0) + 1;
          }
        }
      } catch (error) {
        diagnostics.portal_mirror_error = String(error?.message || error).slice(0, 120);
      }
    }
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
      recordHostResult(url, false, article.fetchStatus);
      return outcome('body_too_short');
    }
    // 본문을 제대로 받아왔다. 이전 실패 기록이 있으면 지운다 - 매체가 차단을
    // 풀거나 구조를 되돌리면 사람 손 없이 바로 복귀해야 한다.
    recordHostResult(url, true);
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
      summary = await summarize(payload);
      validSummary = validPublishedSummary(summary, title, finalCategory);
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
    if (quarantinedHost(fetchTarget) && quarantinedHost(key)) { quarantineSkipped += 1; continue; }
    uniqueCandidates.push({ ...candidate, urlKey: await sha256(key) });
  }
  // 버린 건수는 남긴다. 안 남기면 후보가 왜 적은지 진단에서 사라진다.
  diagnostics.disallowed_before_batch = disallowedBeforeBatch;
  const knownCandidateKeys = new Set();
  if (uniqueCandidates.length) {
    const placeholders = uniqueCandidates.map(() => '?').join(',');
    const knownRows = await env.DB.prepare(`SELECT url_key FROM news_articles WHERE url_key IN (${placeholders})`)
      .bind(...uniqueCandidates.map(candidate => candidate.urlKey)).all();
    for (const row of knownRows.results || []) knownCandidateKeys.add(row.url_key);
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
        ...uniqueCandidates.filter(candidate => candidate.category === '바둑').slice(0, SCHEDULED_BADUK_CANDIDATES),
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
    && await reserveAnthropicCall(env, diagnostics, forceRetry, generalBoost, badukOnly ? 'baduk' : 'general')) {
    // 이 판정도 외부 요청이다. 계수기를 안 지나고 있었다.
    subrequestsUsed += 1;
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
  // 격리 장부는 실행당 한 번만 쓴다. 후보마다 쓰면 D1 쓰기가 후보 수만큼 늘고,
  // 어차피 다음 실행 전에는 아무도 읽지 않는다.
  if (hostHealthChanged) {
    // 오래된 기록은 버린다. 안 그러면 장부가 한없이 자라 매 실행 읽고 쓰는 값이
    // 커진다. 격리는 24시간이므로 이틀 넘게 조용한 매체는 기억할 이유가 없다.
    const staleBefore = Date.now() - 2 * QUARANTINE_HOURS * 3600000;
    const trimmed = Object.fromEntries(Object.entries(hostHealth)
      // 규칙 표시(__rule)는 호스트가 아니므로 시각이 없다. 같이 지우면 다음
      // 실행이 "규칙이 바뀌었다"고 오인해 장부를 매번 비운다 - 격리가 영영 발동
      // 안 하게 된다.
      .filter(([host, record]) => host === '__rule'
        || (Date.parse(String(record?.at || '')) || 0) >= staleBefore));
    await env.DB.prepare(`INSERT INTO news_state(key,value) VALUES('article_host_health',?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(JSON.stringify(trimmed)).run();
  }
  const quarantinedNow = Object.entries(hostHealth)
    .filter(([, record]) => Number(record?.fail || 0) >= QUARANTINE_FAIL_THRESHOLD)
    .map(([host, record]) => `${host}:${record.fail}`);
  if (quarantineSkipped) diagnostics.host_quarantine_skipped = quarantineSkipped;
  if (quarantinedNow.length) diagnostics.host_quarantined = quarantinedNow.slice(0, 8);
  diagnostics.baduk_only = badukOnly;
  // 이번 실행이 외부 요청을 얼마나 썼는지. 44에 붙어 있으면 배치가 한 번에
  // 소화할 수 있는 양을 넘었다는 뜻이고, 그건 상수를 조절할 근거가 된다.
  diagnostics.subrequests_used = subrequestsUsed;
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
