import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeCachedIssues, onRequestGet } from '../functions/api/news/articles.js';
import { googleNewsSearch, isBadukRelevant, naverSectionCategory } from '../functions/api/news/collect.js';
import { claudeCostMicroUsd } from '../functions/_lib/news-ai-budget.js';
import { classifyIssues, isStandaloneEventArticle } from '../functions/_lib/news-issue-classify.js';
import { enforceIssueRules } from '../functions/api/news/classify-issues.js';
import { onRequestGet as getNewsHealth } from '../functions/api/news/health.js';
import { onRequestPost as updateNewsItem } from '../functions/api/news/item.js';

test('바둑은 대회가 명시된 기사만 한 건 독립 이슈 후보가 된다', () => {
  assert.equal(isStandaloneEventArticle({ title: '무안군, 중국 상숙시와 청소년 온라인 바둑대회 개최' }), true);
  assert.equal(isStandaloneEventArticle({ title: '한중 청소년 바둑 스포츠교류 개최' }), false);
  assert.equal(isStandaloneEventArticle({ title: '신진서 세계기전 우승' }), false);
  assert.equal(isStandaloneEventArticle({ title: '김동한 프로기사 근황', summary: '국제 바둑대회에 출전한 경력이 있다.' }), false);
  assert.equal(isStandaloneEventArticle({ title: '신진서 9단 최근 근황 공개' }), false);
});

test('이슈 저장 전 바둑 대회 단독은 살리고 나머지 단독은 기타로 강제한다', () => {
  const articles = [
    { url_key: 'tournament', title: '무안 청소년 온라인 바둑대회 개최', summary: '' },
    { url_key: 'profile', title: '김동한 프로기사 근황', summary: '' },
    { url_key: 'pair-a', title: '신진서 카타고 격파', summary: '' },
    { url_key: 'pair-b', title: 'AI 넘어선 신진서', summary: '' }
  ];
  const groups = enforceIssueRules([
    { key: '바둑|ai:1', title: '김동한 근황', url_keys: ['profile'] },
    { key: '바둑|ai:2', title: '신진서 AI 격파', url_keys: ['pair-a', 'pair-b'] },
    { key: '바둑|ai:misc', title: '기타', url_keys: ['tournament'], misc: true }
  ], articles, '바둑');
  assert.deepEqual(groups.map(group => [group.title, group.url_keys]), [
    ['신진서 AI 격파', ['pair-a', 'pair-b']],
    ['무안 청소년 온라인 바둑대회 개최', ['tournament']],
    ['기타', ['profile']]
  ]);
});

test('일반 뉴스는 대회 기사도 한 건이면 기타로 보낸다', () => {
  const articles = [{ url_key: 'general-event', title: '전국 창업대회 개최', summary: '' }];
  const groups = enforceIssueRules([
    { key: '일반|ai:0', title: '전국 창업대회', url_keys: ['general-event'] }
  ], articles, '일반');
  assert.deepEqual(groups, [
    { key: '일반|ai:misc', title: '기타', url_keys: ['general-event'], misc: true }
  ]);
});

test('기간별 이슈 표시와 클릭 필터는 같은 보정된 캐시를 사용한다', () => {
  const items = [
    { url_key: 'event', category: '바둑', title: '전국 어린이 바둑대회 개최', summary: '' },
    { url_key: 'profile', category: '바둑', title: '프로기사 근황', summary: '' }
  ];
  const normalized = normalizeCachedIssues(items, [
    { key: '바둑|ai:misc', title: '기타', url_keys: ['event'] },
    { key: '바둑|ai:old', title: '프로기사 근황', url_keys: ['profile'] }
  ]);
  assert.equal(normalized.find(group => group.key.includes('|ai:event:')).url_keys[0], 'event');
  assert.deepEqual(normalized.find(group => group.key.endsWith('|ai:misc')).url_keys, ['profile']);
});

test('바둑 단일 대회 AI 응답은 독립 이슈로 유지하고 일반 단독 행사는 제외한다', async () => {
  const articles = [{ url_key: 'mu-an', title: '무안군, 중국 상숙시와 청소년 온라인 바둑대회 개최', summary: '청소년들이 온라인 바둑대회로 국제 우호를 다졌다.' }];
  const env = { AI: { run: async () => ({ response: '[{"title":"무안 상숙 청소년 바둑대회","indices":[0]}]' }) } };
  const baduk = await classifyIssues(env, articles, [], { allowStandaloneEvents: true });
  const general = await classifyIssues(env, articles, [], { allowStandaloneEvents: false });
  assert.equal(baduk.groups[0].title, '무안 상숙 청소년 바둑대회');
  assert.equal(baduk.groups[0].url_keys[0], 'mu-an');
  assert.equal(general.groups[0].title, '기타');
  const omitted = await classifyIssues({ AI: { run: async () => ({ response: '[]' }) } }, articles, [], { allowStandaloneEvents: true });
  assert.notEqual(omitted.groups[0].title, '기타');
  assert.equal(omitted.groups[0].url_keys[0], 'mu-an');
});

test('기타 바둑소식은 별도 타일을 만들지 않고 기타로 합친다', async () => {
  const articles = [
    { url_key: 'plain-1', title: '기사 하나', summary: '' },
    { url_key: 'plain-2', title: '기사 둘', summary: '' }
  ];
  const env = { AI: { run: async () => ({ response: '[{"title":"기타 바둑소식","indices":[0,1]}]' }) } };
  const result = await classifyIssues(env, articles, [], { allowStandaloneEvents: true });
  assert.deepEqual(result.groups, [
    { title: '기타', url_keys: ['plain-1', 'plain-2'], misc: true }
  ]);
});

test('수동 이슈 재분류는 기존 캐시를 비우는 복구 모드를 제공한다', async () => {
  const endpoint = await readFile(new URL('../functions/api/news/classify-issues.js', import.meta.url), 'utf8');
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  assert.match(endpoint, /url\.searchParams\.get\('reset'\) === '1'/);
  assert.match(endpoint, /resetIssues \? \[\] : loadExistingPayload/);
  assert.match(workflow, /reset_issues:/);
});

test('일반 카테고리는 네이버 원문 섹션으로 복구하고 전용 복구 모드를 제공한다', async () => {
  const collector = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  assert.match(collector, /NAVER_SECTION_CATEGORIES/);
  assert.match(collector, /repairGeneralCategories/);
  assert.match(collector, /repair_categories/);
  assert.match(workflow, /repair_categories:/);
  assert.equal(naverSectionCategory(`sectionId : "100"`), '정치');
  assert.equal(naverSectionCategory(`"section_id":"105"`), 'IT/과학');
});

test('일반 저품질 요약은 문제 기사만 격리해 AI 재요약한다', async () => {
  const collector = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  assert.match(collector, /quarantineWeakGeneralSummaries/);
  assert.match(collector, /qualityRepairIds/);
  assert.match(collector, /repair_general_quality/);
  assert.match(workflow, /repair_general_quality:/);
});

test('예약 실행은 production 건강 점검 실패 시 GitHub 이슈를 만든다', async () => {
  const health = await readFile(new URL('../functions/api/news/health.js', import.meta.url), 'utf8');
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  assert.match(health, /last_run_within_6h/);
  assert.match(health, /published_time_complete/);
  assert.match(health, /summary_exhausted_below_threshold/);
  assert.match(workflow, /health-check:/);
  assert.match(workflow, /gh issue create/);
});

test('건강 점검 API는 정상 운영과 발행시간 누락 장애를 구분한다', async () => {
  const makeEnv = missing => ({ DB: {
    async batch() { return []; },
    prepare(sql) {
      return {
        bind() { return this; },
        async first() {
          if (sql.includes('FROM news_runs')) return { status: 'ok', finished_at: new Date().toISOString(), message: '' };
          if (sql.includes("AS baduk")) return { baduk: 4, general: 9 };
          if (sql.includes("TRIM(published_at)=''")) return { count: missing };
          if (sql.includes('f.attempts>=24')) return { count: 0 };
          return {};
        },
        async all() {
          if (sql.includes('FROM news_state')) return { results: [
            { key: 'ai_blocked', value: 0 },
            { key: 'claude_monthly_micro_usd', value: 500000 },
            { key: 'claude_budget_month', value: new Date().toISOString().slice(0, 7) }
          ] };
          return { results: [] };
        }
      };
    }
  } });
  const healthy = await getNewsHealth({ env: makeEnv(0) });
  const unhealthy = await getNewsHealth({ env: makeEnv(2) });
  assert.equal(healthy.status, 200);
  assert.equal((await healthy.json()).ok, true);
  assert.equal(unhealthy.status, 503);
  assert.deepEqual((await unhealthy.json()).failures, ['published_time_complete']);
});

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
  assert.match(collector, /POPULARITY_REPAIR_BATCH_SIZE = 4/);
  assert.match(collector, /uniqueCandidates\.slice\(popularityOffset, popularityOffset \+ POPULARITY_REPAIR_BATCH_SIZE\)/);
  assert.match(workflow, /popularity_offset=\$\{batch_offset\}/);
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

test('날짜만 있거나 발행시간이 빈 일반기사는 원문 발행시각을 묶음 복구한다', async () => {
  const collector = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  assert.match(collector, /repairGeneralArticleTimes/);
  assert.match(collector, /TRIM\(published_at\)='' OR published_at GLOB '....-..-..'/);
  assert.match(collector, /general_time_repair_cursor/);
  assert.match(collector, /hasDateOnly/);
  assert.match(collector, /hasMissingTime/);
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
  assert.doesNotMatch(classifier, /MAX_NEW_ARTICLES_PER_RUN/);
  assert.match(classifier, /const newArticles = articles;/);
  assert.match(classifier, /const existingIssues = \[\];/);
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

test('이미 정상 요약인 기사는 메타데이터만 보강하고 AI 요약을 다시 호출하지 않는다', async () => {
  const source = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  assert.match(source, /if \(exists\.summary_quality === 'full'\)/);
  assert.match(source, /if \(!exists\.image_url \|\| hasSyntheticTime \|\| hasDateOnly \|\| hasMissingTime\)/);
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
  assert.match(html, /item\.related\|\|\[\]/);
  assert.match(html, /url_keys:urlKeys/);
});

test('삭제 API는 대표 기사와 관련 기사 키를 한 배치로 숨긴다', async () => {
  const bound = [];
  const env = { DB: {
    prepare(sql) {
      return { bind(...values) { bound.push({ sql, values }); return this; } };
    },
    async batch(statements) { return statements.map(() => ({})); }
  } };
  const response = await updateNewsItem({
    request: new Request('https://example.com/api/news/item', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-news-user': 'visitor-a' },
      body: JSON.stringify({ action: 'hide', url_key: 'main', url_keys: ['main', 'related'] })
    }), env
  });
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.affected, 2);
  assert.deepEqual(bound.filter(entry => entry.sql.includes('news_hidden')).map(entry => entry.values), [
    ['visitor-a', 'main'], ['visitor-a', 'related']
  ]);
});

test('D1 UTC 시각 문자열을 UTC로 해석한다', async () => {
  const html = await readFile(new URL('../newsbrief.html', import.meta.url), 'utf8');
  assert.match(html, /replace\(' ','T'\).*Z/);
});

test('일반 뉴스 카드는 인기 기사 선별 후 발행시간 최신순으로 표시한다', async () => {
  const html = await readFile(new URL('../newsbrief.html', import.meta.url), 'utf8');
  assert.match(html, /const sortByArticleTime=items=>\[\.\.\.\(items\|\|\[\]\)\]\.sort/);
  assert.match(html, /state\.items=isBaduk\?\(home\.items\|\|\[\]\):sortByArticleTime\(home\.items\)/);
  assert.match(html, /state\.items=isBaduk\?\(d\.items\|\|\[\]\):sortByArticleTime\(d\.items\)/);
  assert.match(html, /state\.heroItems=state\.items\.slice\(0,6\)/);
  assert.doesNotMatch(html, /fmt\(x\.published_at\|\|x\.fetched_at\)/);
});

test('보조 공급자 장애 중 신규 기사가 등록되면 경고만 남긴다', async () => {
  const script = await readFile(new URL('../scripts/google-news-discovery.mjs', import.meta.url), 'utf8');
  assert.match(script, /::warning::/);
  assert.match(script, /if \(!Number\(payload\.inserted \|\| 0\)\) process\.exitCode = 2/);
});
