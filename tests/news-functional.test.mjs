import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { onRequestGet } from '../functions/api/news/articles.js';
import { googleNewsSearch, isBadukRelevant } from '../functions/api/news/collect.js';
import { claudeCostMicroUsd } from '../functions/_lib/news-ai-budget.js';

test('정기 수집은 명백히 불량한 일반 요약만 재요약 대기열로 격리한다', async () => {
  const source = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  assert.match(source, /validateGeneralEditorialSummary/);
  assert.match(source, /general_summaries_quarantined/);
});

test('외부 Google 발견 결과가 있으면 Worker의 중복 RSS 호출을 생략한다', async () => {
  const collector = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  assert.match(collector, /!backfill && !googleDiscoveries\.length/);
  assert.match(collector, /google_fallback_skipped = true/);
});

test('Google RSS 5xx는 제한된 횟수만 재시도한다', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return calls < 3
      ? new Response('', { status: 503 })
      : new Response('<rss><channel><item><title>신진서 바둑 대회 우승 - 테스트신문</title><link>https://example.com/a</link></item></channel></rss>', { status: 200 });
  };
  try {
    const items = await googleNewsSearch('바둑');
    assert.equal(calls, 3);
    assert.equal(items.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('AI 호출은 일일 예산과 당일 차단 상태를 확인한다', async () => {
  const source = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  const budget = await readFile(new URL('../functions/_lib/news-ai-budget.js', import.meta.url), 'utf8');
  assert.match(budget, /CLOUDFLARE_DAILY_CALL_LIMIT = 4/);
  assert.match(budget, /ai_budget_day/);
  assert.match(budget, /ai_blocked/);
});

test('Anthropic 요약 fallback은 평시·백필·월간 비용 상한을 적용한다', async () => {
  const collector = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  const ai = await readFile(new URL('../functions/_lib/news-ai-summary.js', import.meta.url), 'utf8');
  assert.match(collector, /DAILY_ANTHROPIC_CALL_LIMIT = 12/);
  assert.match(collector, /GENERAL_BOOST_ANTHROPIC_CALL_LIMIT = 24/);
  assert.match(collector, /BACKFILL_ANTHROPIC_CALL_LIMIT = 200/);
  assert.doesNotMatch(collector, /TOTAL_ANTHROPIC_CALL_LIMIT/);
  assert.match(collector, /canUseClaude/);
  assert.match(collector, /recordClaudeUsage/);
  assert.match(collector, /reserveAnthropicCall/);
  assert.match(collector, /NEWSBRIEF_USE_ANTHROPIC: '1'/);
  assert.match(ai, /NEWSBRIEF_USE_ANTHROPIC === '1'/);
  assert.match(ai, /claude-haiku-4-5-20251001/);
  assert.doesNotMatch(collector, /anthropic_general_calls_today/);
  assert.doesNotMatch(collector, /general >= 2/);
});

test('일반 보강 실행은 인기 뉴스를 먼저 처리하고 지역 매체 검색 단신을 제외한다', async () => {
  const collector = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  assert.match(collector, /isPopular: true/);
  assert.match(collector, /popularOrder/);
  assert.match(collector, /LOCAL_GENERAL_PRESS\.test\(resolvedPress\)/);
  assert.match(collector, /groups\.flatMap/);
  assert.match(workflow, /general_boost:/);
  assert.match(workflow, /general_boost=1/);
  assert.match(workflow, /NEWSBRIEF_GENERAL_BOOST/);
  const discovery = await readFile(new URL('../scripts/google-news-discovery.mjs', import.meta.url), 'utf8');
  assert.match(discovery, /NEWSBRIEF_GENERAL_BOOST/);
  assert.match(discovery, /searchParams\.set\('general_boost', '1'\)/);
});

test('최근 인기 랭킹 복구는 날짜별 누락 인기기사를 일일 상한 안에서 처리한다', async () => {
  const collector = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  assert.match(collector, /backfillPopularityDate/);
  assert.match(collector, /popularity_date/);
  assert.match(collector, /popularityCandidates/);
  assert.match(collector, /forceRetry: true/);
  assert.match(collector, /uniqueCandidates\.slice\(0, DAILY_CATEGORY_PUBLISH_LIMIT\)/);
  assert.match(collector, /popularityTargetCounts/);
  assert.match(collector, /popularity_target_counts_before/);
  assert.match(collector, /popularity_target_counts_after/);
  assert.match(collector, /AS is_popular/);
  assert.match(collector, /if \(!Number\(row\.is_popular \|\| 0\)\) continue/);
  assert.match(collector, /if \(!popularityCandidates\.length\) \{\s*const maintenanceCursor/);
  assert.match(workflow, /repair_popularity:/);
  assert.match(workflow, /!inputs\.repair_popularity/);
  assert.match(workflow, /popularity_date=\$\{ymd\}/);
});

test('바둑과 일반 뉴스는 각각 하루 10건·월 300건 게시 상한을 적용한다', async () => {
  const collector = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  assert.match(collector, /DAILY_CATEGORY_PUBLISH_LIMIT = 10/);
  assert.match(collector, /MONTHLY_CATEGORY_PUBLISH_LIMIT = 300/);
  assert.match(collector, /hasPublicationCapacity/);
  assert.match(collector, /consumePublicationCapacity/);
  assert.match(collector, /publish_counts_before/);
  assert.match(collector, /publish_counts_after/);
  assert.match(collector, /validPublishedSummary\(row\.summary, row\.title, row\.category\)/);
  assert.match(collector, /const dayStart = Date\.UTC/);
});

test('Cloudflare AI 3줄 요약은 바둑과 일반 뉴스 모두 대상으로 한다', async () => {
  const collector = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  assert.match(collector, /cloudflareReserved = Boolean\(env\.AI\)/);
  assert.doesNotMatch(collector, /aiNewRemaining|aiRetryRemaining/);
  assert.match(collector, /for \(const row of badukRetries\)/);
  assert.match(collector, /for \(const candidate of badukCandidates\)/);
  assert.match(collector, /for \(const row of generalRetries\)/);
  assert.match(collector, /for \(const candidate of generalCandidates\)/);
});

test('Cloudflare 요약 한도·오류·검증 실패 시 Claude로 재시도한다', async () => {
  const collector = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  const ai = await readFile(new URL('../functions/_lib/news-ai-summary.js', import.meta.url), 'utf8');
  assert.match(collector, /cloudflareValid/);
  assert.match(collector, /cloudflare_fallback: true/);
  assert.match(collector, /budget_unavailable/);
  assert.match(collector, /NEWSBRIEF_USE_ANTHROPIC: '1'/);
  assert.doesNotMatch(ai, /category === '바둑'\s*&& env\?\.NEWSBRIEF_USE_ANTHROPIC/);
});

test('production은 Cloudflare AI를 우선하고 Claude는 fallback으로만 동작한다', async () => {
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const collector = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  assert.match(workflow, /NEWSBRIEF_USE_ANTHROPIC:\{type:"plain_text",value:"0"\}/);
  assert.match(collector, /if \(cloudflareValid\) return summary/);
  assert.match(collector, /reserveAnthropicCall/);
});

test('이슈 식별은 제목의 대회·선수 조합을 사용하고 일반 단어를 배제한다', async () => {
  const source = await readFile(new URL('../functions/api/news/articles.js', import.meta.url), 'utf8');
  assert.match(source, /BADUK_NAMES/);
  assert.match(source, /(?:대회|리그|기전|컵|배|선수권|오픈)/);
  assert.match(source, /ISSUE_STOPWORDS/);
  assert.match(source, /RESULT_WORDS/);
  assert.match(source, /if \(category === '바둑'\)[\s\S]*return '';/);
});

test('이슈 필터는 현재 주간·월간 기간을 유지한다', async () => {
  const source = await readFile(new URL('../functions/api/news/articles.js', import.meta.url), 'utf8');
  const page = await readFile(new URL('../newsbrief.html', import.meta.url), 'utf8');
  assert.match(source, /issueCategory = issueKeyFilter\.split\('\|'\)\[0\]/);
  assert.match(source, /CATEGORIES\.has\(issueCategory\)/);
  assert.match(source, /const queryLimit = issueKeyFilter \? 900/);
  assert.match(page, /if\(sub==='weekly'\)p\.set\('hours','168'\)/);
  assert.doesNotMatch(page, /if\(!state\.issueKey\)\{\s*if\(sub==='weekly'\)/);
});

test('과거 인기기사 시간은 임의의 오후 9시를 만들지 않고 날짜만 저장한다', async () => {
  const collector = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  const articles = await readFile(new URL('../functions/api/news/articles.js', import.meta.url), 'utf8');
  const page = await readFile(new URL('../newsbrief.html', import.meta.url), 'utf8');
  assert.doesNotMatch(collector, /popularityDate \+ 12 \* 3600000/);
  assert.match(collector, /article\.publishedAt \|\| publishedAt/);
  assert.match(collector, /synthetic_times_cleared/);
  assert.match(collector, /published_at=substr\(published_at,1,10\)/);
  assert.match(articles, /date\(datetime\(COALESCE[\s\S]*'\+9 hours'\)[\s\S]*p\.score DESC/);
  assert.match(page, /\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$/);
});

test('날짜만 남은 일반기사는 원문 발행시각을 묶음 복구한다', async () => {
  const collector = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  assert.match(collector, /repairGeneralArticleTimes/);
  assert.match(collector, /published_at GLOB '....-..-..'/);
  assert.match(collector, /general_time_repair_cursor/);
  assert.match(collector, /hasDateOnly/);
  assert.match(workflow, /repair_times=1/);
});

test('화면은 이슈 목차와 기존 관련 보도 묶음을 함께 사용하되 중복 제목 목록을 만들지 않는다', async () => {
  const html = await readFile(new URL('../newsbrief.html', import.meta.url), 'utf8');
  assert.match(html, /issuesPanel/);
  assert.match(html, /관련 기사 \$\{issue\.count\}건/);
  assert.match(html, /data-issue-key/);
  assert.match(html, /issue_key/);
  assert.match(html, /clearIssue/);
  assert.match(html, /sub==='home'&&!state\.q&&!state\.issueKey/);
  assert.match(html, /relatedHtml\(x\)/);
  assert.doesNotMatch(html, /같은 이슈에 속한 기사 전체입니다/);
  assert.doesNotMatch(html, /issueRelated/);
});

test('일반 카테고리 필터에서는 이슈키워드를 요청하거나 표시하지 않는다', async () => {
  const html = await readFile(new URL('../newsbrief.html', import.meta.url), 'utf8');
  assert.match(html, /!state\.category&&sub!=='saved'&&sub!=='home'/);
  assert.match(html, /if\(sub!=='saved'&&!state\.category\)p\.set\('issues','1'\)/);
  assert.match(html, /sub==='weekly'\?'주간':sub==='monthly'\?'월간'/);
  assert.match(html, /\$\{categoryPeriod\} \$\{state\.category\} 3줄 요약/);
});

test('화면 API는 타임아웃과 GET 재시도 및 수동 재시도를 제공한다', async () => {
  const html = await readFile(new URL('../newsbrief.html', import.meta.url), 'utf8');
  assert.match(html, /fetchTimed/);
  assert.match(html, /const attempts=.*GET.*\?2:1/);
  assert.match(html, /id="retryLoad"/);
  assert.match(html, /closest\('#retryLoad'\)/);
});

test('대량 백필은 CPU 제한을 피하도록 작은 묶음으로 처리한다', async () => {
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const collector = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  assert.match(collector, /MAINTENANCE_BATCH_SIZE = 40/);
  assert.match(collector, /uniqueCandidates\.slice\(0, 8\)/);
  assert.match(collector, /repair \? 4 : \(backfill \? 4 : 3\)/);
  assert.match(workflow, /then runs=18/);
  assert.match(workflow, /seq 1 10/);
});

test('자동 수집과 화면 갱신은 3시간 주기로 동작한다', async () => {
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const html = await readFile(new URL('../newsbrief.html', import.meta.url), 'utf8');
  assert.match(workflow, /cron: '0 \*\/3 \* \* \*'/);
  assert.match(html, /setInterval\(\(\)=>load\(\{silent:true\}\),10800000\)/);
});

test('일일 이슈 분류는 남은 Workers AI를 사용하고 Claude로 fallback한다', async () => {
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const classifier = await readFile(new URL('../functions/_lib/news-issue-classify.js', import.meta.url), 'utf8');
  assert.match(workflow, /categories=\("바둑"\)/);
  assert.match(workflow, /remaining Workers AI or Claude/);
  assert.match(classifier, /env\.AI\.run/);
  assert.match(classifier, /WORKERS_AI_CLASSIFY_MODEL/);
  assert.match(classifier, /classifyWithAnthropic/);
  assert.match(workflow, /date -u \+%u/);
  assert.match(workflow, /categories\+=\("일반"\)/);
});

test('일반 뉴스는 코드 추출식 요약을 게시하지 않고 기타 이슈를 마지막에 표시한다', async () => {
  const collector = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  const articles = await readFile(new URL('../functions/api/news/articles.js', import.meta.url), 'utf8');
  assert.match(collector, /if \(payload\.category !== '바둑'\) return ''/);
  assert.match(articles, /validateGeneralEditorialSummary/);
  assert.doesNotMatch(articles, /group\.key !== '일반\|ai:misc'/);
  assert.match(articles, /return \[\.\.\.rest\.slice\(0, misc\.length \? 11 : 12\), \.\.\.misc\]/);
  assert.match(articles, /reorderGeneralSummary/);
  assert.match(collector, /general_daily_goal = 10/);
  assert.match(collector, /MAX_SCHEDULED_CANDIDATES \+ 4/);
});

test('일반 홈·주간·월간은 인기 랭킹 기사만 표시하고 저장 탭은 보존한다', async () => {
  const html = await readFile(new URL('../newsbrief.html', import.meta.url), 'utf8');
  assert.match(html, /const view=isBaduk\?'latest':'popular'/);
  assert.match(html, /sub==='saved'\?'saved':\(isBaduk\?'latest':'popular'\)/);
  assert.match(html, /view=\$\{view\}/);
  assert.match(html, /const homeHours=24/);
  assert.match(html, /const homeLimit=isBaduk\?30:10/);
});

test('Claude 월간 비용은 2.50달러 목표와 2.70달러 절대 한도를 사용한다', async () => {
  const budget = await readFile(new URL('../functions/_lib/news-ai-budget.js', import.meta.url), 'utf8');
  const classifier = await readFile(new URL('../functions/api/news/classify-issues.js', import.meta.url), 'utf8');
  assert.match(budget, /CLAUDE_MONTHLY_TARGET_MICRO_USD = 2_500_000/);
  assert.match(budget, /CLAUDE_MONTHLY_HARD_LIMIT_MICRO_USD = 2_700_000/);
  assert.match(budget, /claude_budget_month/);
  assert.match(classifier, /MAX_NEW_ARTICLES_PER_RUN = 40/);
  assert.match(classifier, /recordClaudeUsage/);
  assert.equal(claudeCostMicroUsd('claude-haiku-4-5-20251001', { input_tokens: 1000, output_tokens: 100 }), 1500);
  assert.equal(claudeCostMicroUsd('claude-sonnet-5', { input_tokens: 1000, output_tokens: 100 }), 4500);
});

test('이슈 예산이 부족하면 기존 캐시를 유지하고 새 기사는 다음 실행에 남긴다', async () => {
  const classifier = await readFile(new URL('../functions/api/news/classify-issues.js', import.meta.url), 'utf8');
  assert.match(classifier, /provider: 'budget-blocked'/);
  assert.match(classifier, /issues: existingPayload\.map/);
  assert.doesNotMatch(classifier, /buildIssues|issueKey\(/);
});

test('바둑 검색에 섞인 무관한 기사는 Claude 대상으로 분류하지 않는다', () => {
  assert.equal(isBadukRelevant('신진서, 카타고와 세 번째 대국', ''), true);
  assert.equal(isBadukRelevant('희망과 절망', '신진서 9단이 한국기원에서 바둑 인공지능 카타고와 대국했다.'), true);
  assert.equal(isBadukRelevant("tvN 드라마 응답하라 1988 다시보기", '박보검과 혜리가 출연한 가족 드라마가 시청률을 기록했다.'), false);
});

test('요약 실패 기사는 같은 날 반복 호출하지 않고 적게 시도한 순서로 순환한다', async () => {
  const source = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  assert.match(source, /f\.last_attempt < datetime\('now','-20 hours'\)/);
  assert.match(source, /COALESCE\(f\.attempts,0\), COALESCE\(f\.last_attempt,'1970-01-01'\)/);
});

test('이미 정상 요약인 기사는 이미지가 없어도 AI 요약을 다시 호출하지 않는다', async () => {
  const source = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  assert.match(source, /if \(exists\.summary_quality === 'full'\)/);
  assert.match(source, /if \(!exists\.image_url \|\| hasSyntheticTime \|\| hasDateOnly\)/);
  assert.match(source, /return 0;\s*}\s*if \(!hasPublicationCapacity/);
});

test('수동 한 달 백필만 대기 중인 요약을 강제 순환한다', async () => {
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const collector = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  assert.match(workflow, /backfill=1&force_retry=1/);
  assert.match(workflow, /repair=1&force_retry=1/);
  assert.match(collector, /forceRetry \? 1 : 0/);
});

test('바둑 이슈는 캐시가 있으면 정규식 대신 Claude 분류 결과를 사용한다', async () => {
  let usedFirst = false;
  const env = { DB: {
    batch: async () => [],
    prepare(sql) {
      if (sql.includes('SELECT payload FROM news_issue_cache')) {
        return { bind() { return this; }, async first() { usedFirst = true; return { payload: JSON.stringify([{ key: '바둑|ai:0', title: '신진서 삼성화재배 우승', url_keys: ['k1', 'k2'] }]) }; } };
      }
      return { bind() { return this; }, async all() { return { results: [
        { id: 1, url: 'https://a', url_key: 'k1', title: '신진서 9단이 삼성화재배 결승에서 우승했다', source: 'x', press: '', category: '바둑', published_at: '2026-07-20 00:00:00', fetched_at: '2026-07-20 00:00:00', summary: '1) 신진서 9단이 삼성화재배 결승전에서 상대를 꺾고 우승했다.\n2) 이번 대회 상금은 삼억 원이며 신진서가 모두 가져갔다.\n3) 한국기원은 시상식을 다음달에 개최한다고 밝혔다.', summary_quality: 'full', image_url: '', saved: 0 },
        { id: 2, url: 'https://b', url_key: 'k2', title: '이세돌 전 9단 근황 공개', source: 'x', press: '', category: '바둑', published_at: '2026-07-20 00:00:00', fetched_at: '2026-07-20 00:00:00', summary: '1) 유튜브 채널이 은퇴한 프로기사의 일상을 담은 영상을 올렸다.\n2) 그는 현재 바둑 교육 사업에 집중하고 있다고 말했다.\n3) 팬들은 오랜만의 소식이라며 반가움을 나타냈다고 전했다.', summary_quality: 'full', image_url: '', saved: 0 }
      ] }; } };
    }
  } };
  const response = await onRequestGet({ request: new Request('https://example.com/api/news/articles?category=%EB%B0%94%EB%91%91&issues=1'), env });
  const body = await response.json();
  assert.equal(usedFirst, true);
  assert.equal(body.issues.length, 1);
  assert.equal(body.issues[0].title, '신진서 삼성화재배 우승');
  assert.equal(body.issues[0].count, 2);
});

test('숨김 목록은 현재 방문자의 숨긴 기사만 조회한다', async () => {
  let query = '';
  const env = { DB: {
    batch: async () => [],
    prepare(sql) {
      if (sql.includes('SELECT a.id')) query = sql;
      return { bind() { return this; }, async all() { return { results: [] }; } };
    }
  } };
  await onRequestGet({ request: new Request('https://example.com/api/news/articles?view=hidden', { headers: { 'x-news-user': 'visitor-a' } }), env });
  assert.match(query, /h\.url_key IS NOT NULL/);
});

test('브라우저는 방문자 ID를 저장·조회 API에 함께 보내고 삭제 UI만 제공한다', async () => {
  const html = await readFile(new URL('../newsbrief.html', import.meta.url), 'utf8');
  assert.match(html, /localStorage\.getItem\(USER_KEY\)/);
  assert.match(html, /'x-news-user':userId/);
  assert.doesNotMatch(html, /data-view="hidden"/);
  assert.doesNotMatch(html, /data-action="unhide"/);
  assert.match(html, /data-action="hide">삭제/);
  assert.match(html, /기사를 삭제했습니다/);
});

test('D1 UTC 시각 문자열을 UTC로 해석한다', async () => {
  const html = await readFile(new URL('../newsbrief.html', import.meta.url), 'utf8');
  assert.match(html, /replace\(' ','T'\).*Z/);
});

test('보조 공급자 장애 중 신규 기사가 등록되면 경고만 남긴다', async () => {
  const script = await readFile(new URL('../scripts/google-news-discovery.mjs', import.meta.url), 'utf8');
  assert.match(script, /::warning::/);
  assert.match(script, /if \(!Number\(payload\.inserted \|\| 0\)\) process\.exitCode = 2/);
});
