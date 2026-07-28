import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildIssuesFromCache, normalizeCachedIssues, onRequestGet } from '../functions/api/news/articles.js';
import { articleSectionCategory, googleNewsSearch, isBadukRelevant, naverSectionCategory } from '../functions/api/news/collect.js';
import { claudeCostMicroUsd } from '../functions/_lib/news-ai-budget.js';
import {
  classifyIssues, hasIncidentLocationConflict, hasLegalCaseConflict, isStandaloneEventArticle, rejectConflictingExistingMatches,
  standaloneBadukIssueTitle
} from '../functions/_lib/news-issue-classify.js';
import { buildClassificationPlan, enforceIssueRules } from '../functions/api/news/classify-issues.js';
import { onRequestGet as getNewsHealth } from '../functions/api/news/health.js';
import { onRequestPost as updateNewsItem } from '../functions/api/news/item.js';
import { createSessionCookie, readSession } from '../functions/_lib/session.js';
import { onRequest as authMiddleware } from '../functions/_middleware.js';
import { onRequestPost as login } from '../functions/api/auth/login.js';
import { validPassword, validUsername } from '../functions/_lib/news-users.js';
import { onRequestGet as listUsers, onRequestPost as updateUser } from '../functions/api/admin/users.js';
import { isBadukDisplayRelevant } from '../functions/_lib/baduk-relevance.js';

test('바둑은 공식 대회·리그 행사만 한 건 독립 이슈 후보로 보존한다', () => {
  assert.equal(isStandaloneEventArticle({ title: '무안군, 중국 상숙시와 청소년 온라인 바둑대회 개최' }), true);
  assert.equal(isStandaloneEventArticle({ title: '한중 청소년 바둑 스포츠교류 개최' }), false);
  assert.equal(isStandaloneEventArticle({ title: '신진서 세계기전 우승' }), false);
  assert.equal(isStandaloneEventArticle({ title: '김동한 프로기사 근황', summary: '국제 바둑대회에 출전한 경력이 있다.' }), false);
  assert.equal(isStandaloneEventArticle({ title: '신진서 9단 최근 근황 공개' }), false);
});

test('요약의 공식 대회명과 바둑 기록 기사도 단건 이슈로 보존한다', () => {
  const gwangju = {
    title: '광주 바둑 꿈나무들, 문성고 체육관서 열띤 경쟁',
    summary: '1) 광주광역시체육회가 주최한 제2회 광주광역시체육회장배 학생바둑대회가 열렸다.'
  };
  assert.equal(standaloneBadukIssueTitle(gwangju), '광주광역시체육회장배 학생바둑대회');
  assert.equal(standaloneBadukIssueTitle({ title: '김명훈, 명인전서 통산 500승 달성' }), '');
  assert.equal(standaloneBadukIssueTitle({ title: '최정, 여자 바둑 1위 탈환' }), '');
  assert.equal(standaloneBadukIssueTitle({ title: '"2점 차 랭킹 역전" 최정, 여자 바둑 1위 탈환' }), '');
  assert.equal(standaloneBadukIssueTitle({ title: '신민준, 박정환 꺾고 GS칼텍스배 탈환' }), '');
  assert.equal(standaloneBadukIssueTitle({ title: '춘천서 챌린지 바둑 리그 6라운드 개최' }), '챌린지 바둑 리그');
  assert.equal(isStandaloneEventArticle(gwangju), true);
  const normalized = normalizeCachedIssues([{ ...gwangju, url_key: 'gwangju', category: '바둑' }], [{
    key: '바둑|ai:misc', title: '기타', url_keys: ['gwangju']
  }]);
  assert.equal(normalized[0].title, '광주광역시체육회장배 학생바둑대회');
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
    ['무안 청소년 온라인 바둑대회', ['tournament']],
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

test('해외 사망 이슈에 지역이 다른 국내 사망 사고를 합치지 않는다', () => {
  const domestic = {
    url_key: 'wanju',
    title: '전국 극한 폭염 전북 완주서 밭일하던 할머니 숨져',
    summary: '전북 완주군 농경지에서 100세 여성이 숨진 채 발견됐다.'
  };
  const context = '일본 열대야 사망 일본에서 기록적인 열대야로 고령자가 숨졌다.';
  assert.equal(hasIncidentLocationConflict(context, domestic), true);
  assert.equal(hasIncidentLocationConflict('전북 폭염 사망 전북 완주군에서 고령자가 숨졌다.', domestic), false);
  assert.deepEqual(rejectConflictingExistingMatches(
    [{ title: '일본 열대야 사망', url_keys: ['wanju'] }],
    [domestic],
    [{ key: '일반|ai:1', title: '일본 열대야 사망', context }]
  ), [{ title: '기타', url_keys: ['wanju'], misc: true }]);
});

test('같은 정치인이라도 정치자금 재판과 허위사실공표 고발은 분리한다', () => {
  const article = { title: '오세훈 허위사실공표 혐의로 고발', summary: '선거 보전액 환수 요구가 제기됐다.' };
  assert.equal(hasLegalCaseConflict('오세훈 정치자금법 위반 1심 판결', article), true);
  assert.equal(hasLegalCaseConflict('오세훈 정치자금법 위반 1심 판결', { title: '오세훈 정치자금법 1심 항소' }), false);
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

test('월간 이슈가 12개를 넘어도 주간에 보인 바둑 대회를 잘라내지 않는다', () => {
  const items = Array.from({ length: 13 }, (_, index) => ({
    url_key: `event-${index}`, category: '바둑', title: `제${index + 1}회 바둑대회`
  }));
  const cached = items.map((item, index) => ({
    key: `바둑|ai:${index}`, title: `바둑대회 ${index + 1}`, url_keys: [item.url_key]
  }));
  const issues = buildIssuesFromCache(items, cached);
  assert.equal(issues.length, 13);
  assert.equal(issues.some(issue => issue.key === '바둑|ai:12'), true);
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

test('이슈 재분류 전 캐시 백업과 직전 상태 복원 경로를 제공한다', async () => {
  const endpoint = await readFile(new URL('../functions/api/news/classify-issues.js', import.meta.url), 'utf8');
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  assert.match(endpoint, /news_issue_cache_history/);
  assert.match(endpoint, /rollbackIssues/);
  assert.match(workflow, /rollback_issues:/);
  assert.doesNotMatch(endpoint, /DELETE\s+FROM\s+news_articles/i);
});

test('예약 이슈 분류는 신규 기사와 기타 풀만 재검사한다', () => {
  const articles = [
    { url_key: 'established' }, { url_key: 'misc-old' }, { url_key: 'new-one' }
  ];
  const existing = [
    { key: '바둑|ai:0', title: '기존 이슈', url_keys: ['established'] },
    { key: '바둑|ai:misc', title: '기타', url_keys: ['misc-old'], misc: true }
  ];
  const plan = buildClassificationPlan(articles, existing, false);
  assert.deepEqual(plan.genuinelyNewArticles.map(article => article.url_key), ['new-one']);
  assert.deepEqual(plan.candidateArticles.map(article => article.url_key), ['misc-old', 'new-one']);
  const reset = buildClassificationPlan(articles, existing, true);
  assert.deepEqual(reset.candidateArticles.map(article => article.url_key), ['established', 'misc-old', 'new-one']);
});

test('Claude 이슈 분류가 가능하면 Cloudflare 호출을 미리 예약하지 않는다', async () => {
  const endpoint = await readFile(new URL('../functions/api/news/classify-issues.js', import.meta.url), 'utf8');
  assert.match(endpoint, /const useClaude = !forceFree && budget\.allowed && Boolean\(env\?\.ANTHROPIC_API_KEY\)/);
  assert.match(endpoint, /if \(!useClaude\) cloudflare = await reserveCloudflareCall/);
  assert.match(endpoint, /classification\.provider === 'anthropic-failed'/);
  assert.doesNotMatch(endpoint, /Promise\.all\(\[\s*reserveCloudflareCall/);
});

test('수동 이슈 재분류는 비용 없는 Cloudflare AI 전용 모드를 제공한다', async () => {
  const endpoint = await readFile(new URL('../functions/api/news/classify-issues.js', import.meta.url), 'utf8');
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  assert.match(endpoint, /forceFree/);
  assert.match(endpoint, /!forceFree && budget\.allowed/);
  assert.match(workflow, /free_issue_ai:/);
});

test('일반 이슈는 기존 제목을 유지하면서 기사 소속만 재분류할 수 있다', async () => {
  const endpoint = await readFile(new URL('../functions/api/news/classify-issues.js', import.meta.url), 'utf8');
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  assert.match(endpoint, /regroupIssues/);
  assert.match(endpoint, /regroupIssues \? existingPayload : basePayload/);
  assert.match(workflow, /regroup_issues:/);
  const prompt = await readFile(new URL('../functions/_lib/news-issue-classify.js', import.meta.url), 'utf8');
  assert.match(prompt, /핵심 단어가 실제 기사에 없거나 번역투·오타/);
});

test('일반 카테고리는 네이버 원문 섹션으로 복구하고 전용 복구 모드를 제공한다', async () => {
  const collector = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  assert.match(collector, /NAVER_SECTION_CATEGORIES/);
  assert.match(collector, /repairGeneralCategories/);
  assert.match(collector, /repair_categories/);
  assert.match(workflow, /repair_categories:/);
  assert.equal(naverSectionCategory(`sectionId : "100"`), '정치');
  assert.equal(naverSectionCategory(`"section_id":"105"`), '');
});

test('네이버 외 언론사의 JSON-LD·메타 섹션도 카테고리로 사용한다', () => {
  assert.equal(articleSectionCategory('<script type="application/ld+json">{"articleSection":"경제"}</script>'), '경제');
  assert.equal(articleSectionCategory('<meta property="article:section" content="국제">'), '세계');
  assert.equal(articleSectionCategory('<meta name="section" content="문화/연예">'), '생활/문화');
  assert.equal(articleSectionCategory('<meta name="section" content="IT과학">'), '');
});

test('IT 과학 카테고리는 수집·분류·화면·일반 피드에서 제외한다', async () => {
  const page = await readFile(new URL('../newsbrief.html', import.meta.url), 'utf8');
  const collector = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  const articles = await readFile(new URL('../functions/api/news/articles.js', import.meta.url), 'utf8');
  const issues = await readFile(new URL('../functions/api/news/classify-issues.js', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /'IT\/과학'/);
  assert.doesNotMatch(collector, /\['IT\/과학', '과학 기술'\]/);
  assert.doesNotMatch(collector, /'105': 'IT\/과학'/);
  assert.match(articles, /a\.category NOT IN \('바둑','IT\/과학'\)/);
  assert.match(issues, /a\.category NOT IN \('바둑','IT\/과학'\)/);
});

test('일반 카테고리 복구는 최근 미검사 네이버 기사부터 공식 섹션으로 교정한다', async () => {
  const collector = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  const db = await readFile(new URL('../functions/_lib/news-db.js', import.meta.url), 'utf8');
  assert.equal(naverSectionCategory('sectionId : "101"'), '경제');
  assert.match(db, /CREATE TABLE IF NOT EXISTS news_category_checks/);
  assert.match(collector, /LEFT JOIN news_category_checks c ON c\.url_key=a\.url_key/);
  assert.match(collector, /c\.url_key IS NULL/);
  assert.match(collector, /ORDER BY datetime\(COALESCE\(NULLIF\(a\.published_at/);
  assert.match(collector, /INSERT INTO news_category_checks/);
  assert.doesNotMatch(collector, /general_category_repair_cursor/);
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

test('건강 점검 API는 콘텐츠 경고를 서버 장애 응답과 분리한다', async () => {
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
  assert.equal(unhealthy.status, 200);
  const warning = await unhealthy.json();
  assert.equal(warning.ok, false);
  assert.deepEqual(warning.failures, ['published_time_complete']);
});

test('예약 건강 점검은 HTTP 200이어도 응답의 ok가 false면 경고한다', async () => {
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  assert.match(workflow, /health_ok=\$\(jq -r '\.ok \/\/ false'/);
  assert.match(workflow, /\[ "\$health_ok" != "true" \]/);
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
  assert.match(collector, /SCHEDULED_GOOGLE_DISCOVERIES = 20/);
  assert.match(collector, /backfill \? 20 : SCHEDULED_GOOGLE_DISCOVERIES/);
});

test('Google 바둑 발견은 한 검색어가 전체 후보를 독점하지 않는다', async () => {
  const discovery = await readFile(new URL('../scripts/google-news-discovery.mjs', import.meta.url), 'utf8');
  assert.match(discovery, /let addedForQuery = 0/);
  assert.match(discovery, /addedForQuery >= \(full \? 10 : 5\)/);
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

test('선택적 Google 장애는 전체 수집 워크플로를 중단하지 않는다', async () => {
  const discovery = await readFile(new URL('../scripts/google-news-discovery.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(discovery, /process\.exitCode = 2/);
  assert.match(discovery, /Google-only outage/);
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
  assert.match(collector, /DAILY_ANTHROPIC_CALL_LIMIT = 60/);
  assert.match(collector, /GENERAL_BOOST_ANTHROPIC_CALL_LIMIT = DAILY_ANTHROPIC_CALL_LIMIT \+ 24/);
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

test('바둑과 일반 뉴스는 각각 하루 10개까지 게시한다', async () => {
  const collector = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  assert.match(collector, /DAILY_CATEGORY_PUBLISH_LIMIT = 10/);
  assert.doesNotMatch(collector, /MONTHLY_CATEGORY_PUBLISH_LIMIT/);
  assert.match(collector, /publicationCounts\[bucket\]\.daily >= DAILY_CATEGORY_PUBLISH_LIMIT/);
  assert.match(collector, /home_display_limits = \{ baduk: 30, general: 10 \}/);
  assert.match(collector, /consumePublicationCapacity/);
  assert.match(collector, /publish_counts_before/);
  assert.match(collector, /publish_counts_after/);
  assert.match(collector, /validPublishedSummary\(row\.summary, row\.title, row\.category\)/);
  assert.match(collector, /const dayStart = Date\.UTC/);
});

test('바둑은 네이버 재확인 없이 한국기원 최신 원문을 직접 수집한다', async () => {
  const collector = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  assert.match(collector, /async function koreanBadukLatest/);
  assert.match(collector, /source: 'TRUSTED_BADUK'/);
  assert.match(collector, /official_baduk_found/);
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
  assert.match(source, /const queryLimit = issueCandidateLimit\(limit, issues \|\| Boolean\(issueKeyFilter\), category === '바둑'\)/);
  assert.doesNotMatch(source, /const queryLimit = issueKeyFilter \?/);
  assert.match(page, /if\(sub==='weekly'\)p\.set\('hours','168'\)/);
  assert.doesNotMatch(page, /if\(!state\.issueKey\)\{\s*if\(sub==='weekly'\)/);
});

test('헤더 로그아웃은 계정 표시와 확인 후 세션 종료를 제공한다', async () => {
  const page = await readFile(new URL('../newsbrief.html', import.meta.url), 'utf8');
  assert.match(page, /id="accountName"/);
  assert.match(page, /id="logoutButton"/);
  assert.match(page, /confirm\('로그아웃할까요\?'\)/);
  assert.match(page, /fetch\('\/api\/auth\/logout',\{method:'POST'\}\)/);
  assert.match(page, /location\.replace\('\/login\?next=%2F'\)/);
  assert.match(page, /\.accountName,.accountDivider\{display:none\}/);
});

test('과거 인기기사 시간은 임의의 오후 9시를 만들지 않고 날짜만 저장한다', async () => {
  const collector = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  const articles = await readFile(new URL('../functions/api/news/articles.js', import.meta.url), 'utf8');
  const page = await readFile(new URL('../newsbrief.html', import.meta.url), 'utf8');
  assert.doesNotMatch(collector, /popularityDate \+ 12 \* 3600000/);
  assert.match(collector, /article\.publishedAt \|\| publishedAt/);
  assert.match(collector, /synthetic_times_cleared/);
  assert.match(collector, /published_at=substr\(published_at,1,10\)/);
  assert.match(articles, /date\(datetime\(COALESCE[\s\S]*'\+9 hours'\)[\s\S]*\$\{popularityScore\} DESC/);
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
  assert.doesNotMatch(html, /clearIssue/);
  assert.match(html, /sub==='home'&&!state\.q&&!state\.issueKey/);
  assert.match(html, /relatedHtml\(x\)/);
  assert.doesNotMatch(html, /같은 이슈에 속한 기사 전체입니다/);
  assert.doesNotMatch(html, /issueRelated/);
});

test('이슈 상세는 직관적인 뒤로가기와 브라우저 앞뒤 탐색 상태를 제공한다', async () => {
  const html = await readFile(new URL('../newsbrief.html', import.meta.url), 'utf8');
  assert.match(html, /id="issueBack" aria-label="이전 화면으로">←/);
  assert.match(html, /history\.replaceState\(\{newsbriefSource:true/);
  assert.match(html, /history\.pushState\(\{newsbriefIssue:true/);
  assert.match(html, /addEventListener\('popstate',e=>restoreLocation\(e\.state\)\)/);
  assert.match(html, /url\.searchParams\.set\('issue',issueKey\)/);
  assert.match(html, /initialParams\.get\('issue'\)/);
  assert.doesNotMatch(html, /이슈 목록으로/);
});

test('이슈 선택 후에도 전체 이슈 목록을 유지하고 선택 타일만 강조한다', async () => {
  const html = await readFile(new URL('../newsbrief.html', import.meta.url), 'utf8');
  assert.match(html, /class="issueCard \$\{selected\?'on':''\}"/);
  assert.match(html, /aria-pressed="\$\{selected\?'true':'false'\}"/);
  assert.match(html, /선택됨 · /);
  assert.match(html, /else if\(!state\.issueKey\)state\.issueItems=d\.issues\|\|\[\]/);
  assert.match(html, /indexParams\.delete\('issue_key'\)/);
  assert.match(html, /Promise\.all\(\[fetchViewJson\(detailUrl/);
  assert.match(html, /@media\(hover:hover\) and \(pointer:fine\)\{\.issueCard:hover/);
});

test('모바일 이슈 목록은 390px에서도 한 줄에 두 개씩 표시한다', async () => {
  const html = await readFile(new URL('../newsbrief.html', import.meta.url), 'utf8');
  assert.match(html, /@media\(max-width:680px\)\{\.issueGrid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\);gap:8px\}/);
  assert.doesNotMatch(html, /@media\(max-width:420px\)\{\.issueGrid\{grid-template-columns:1fr\}\}/);
  assert.match(html, /\.issueName\{[^}]*word-break:keep-all;overflow-wrap:anywhere/);
  assert.match(html, /\.issueCard\{min-height:108px;[^}]*text-align:center\}/);
  assert.match(html, /\.issueName\{display:-webkit-box;[^}]*-webkit-line-clamp:3/);
  assert.match(html, /\.issueView\{white-space:nowrap\}/);
  assert.match(html, /\.issueViewDesktop\{display:none\}/);
  assert.match(html, /class="issueViewMobile">전체보기 <\/span><span class="issueArrow" aria-hidden="true">↓/);
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
  assert.match(html, /const attempts=isGet\?4:1/);
  assert.match(html, /response\.status===429/);
  assert.match(html, /sessionStorage\.setItem\(cacheKey/);
  assert.match(html, /NewsBrief API fallback/);
  assert.match(html, /activeLoadController\?\.abort\(\)/);
  assert.match(html, /Date\.now\(\)-lastSuccessfulLoad>300000/);
  assert.match(html, /id="retryLoad"/);
  assert.match(html, /closest\('#retryLoad'\)/);
  assert.match(html, /if\(sub==='home'\)\$\('hot'\)\.innerHTML='<div class="empty">핵심 뉴스를 불러오는 중입니다/);
});

test('화면은 대용량 기간 선조회를 제거하고 로그인 만료를 서버 장애와 구분한다', async () => {
  const html = await readFile(new URL('../newsbrief.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /prefetchPeriods|requestIdleCallback/);
  assert.match(html, /response\.redirected&&new URL\(response\.url\)\.pathname==='\/login'/);
  assert.doesNotMatch(html, /id="clearIssue"/);
  assert.match(html, /전체 카드 보기/);
  assert.doesNotMatch(html, /첫 카드로 이동/);
});

test('읽기 API는 요청마다 D1 스키마 DDL을 다시 실행하지 않는다', async () => {
  for (const path of [
    '../functions/api/news/articles.js', '../functions/api/news/image.js',
    '../functions/api/news/status.js', '../functions/api/news/health.js'
  ]) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /ensureNewsDb/);
  }
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

test('자동 수집은 3시간 주기와 watchdog을 사용하고 화면은 10분마다 확인한다', async () => {
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const html = await readFile(new URL('../newsbrief.html', import.meta.url), 'utf8');
  assert.match(workflow, /cron: '17 \*\/3 \* \* \*'/);
  assert.match(workflow, /cron: '47 \* \* \* \*'/);
  assert.match(workflow, /automatic_age_hours \/\/ 999\) > 4/);
  assert.match(html, /setInterval\(\(\)=>load\(\{silent:true\}\),600000\)/);
});

test('일일 이슈 분류는 남은 Workers AI를 사용하고 Claude로 fallback한다', async () => {
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const classifier = await readFile(new URL('../functions/_lib/news-issue-classify.js', import.meta.url), 'utf8');
  assert.match(workflow, /categories=\("바둑" "일반"\)/);
  assert.match(workflow, /remaining Workers AI or Claude/);
  assert.match(classifier, /env\.AI\.run/);
  assert.match(classifier, /WORKERS_AI_CLASSIFY_MODEL/);
  assert.match(classifier, /classifyWithAnthropic/);
});

test('일반 뉴스는 AI 실패 시 검증된 추출식 요약을 사용하고 기타 이슈를 마지막에 표시한다', async () => {
  const collector = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  const articles = await readFile(new URL('../functions/api/news/articles.js', import.meta.url), 'utf8');
  assert.doesNotMatch(collector, /if \(payload\.category !== '바둑'\) return ''/);
  assert.match(collector, /diagnostics\.extractive_fallback_used/);
  assert.match(collector, /AI: undefined,\s+ANTHROPIC_API_KEY: undefined/);
  assert.match(articles, /validateGeneralEditorialSummary/);
  assert.doesNotMatch(articles, /group\.key !== '일반\|ai:misc'/);
  assert.match(articles, /return \[\.\.\.rest, \.\.\.misc\]/);
  assert.doesNotMatch(articles, /rest\.slice\(0, misc\.length \? 11 : 12\)/);
  assert.match(articles, /reorderGeneralSummary/);
  assert.match(collector, /general_daily_goal = 10/);
  assert.match(collector, /SCHEDULED_GENERAL_CANDIDATES = 6/);
  assert.match(collector, /SCHEDULED_BADUK_CANDIDATES = 10/);
  assert.match(collector, /Date\.parse\(b\.item\?\.pubDate/);
  assert.match(collector, /processed_by_category/);
  assert.match(collector, /candidate_outcomes/);
  assert.match(collector, /SELECT url_key FROM news_articles WHERE url_key IN/);
  assert.match(collector, /const newOrder = Number\(knownCandidateKeys\.has/);
  assert.match(collector, /diagnostics\.new_candidates/);
});

test('일반 홈·주간·월간은 인기 랭킹 기사만 표시하고 저장 탭은 저장 기사만 표시한다', async () => {
  const html = await readFile(new URL('../newsbrief.html', import.meta.url), 'utf8');
  assert.match(html, /const view=isBaduk\?'latest':'popular'/);
  assert.match(html, /sub==='saved'\?'saved':\(isBaduk\?'latest':'popular'\)/);
  assert.match(html, /view=\$\{view\}/);
  assert.match(html, /const homeHours=24/);
  assert.match(html, /const homeLimit=isBaduk\?30:10/);
});

test('인기뉴스 조회는 OR 조인 없이 URL·제목 인덱스를 따로 사용한다', async () => {
  const source = await readFile(new URL('../functions/api/news/articles.js', import.meta.url), 'utf8');
  assert.match(source, /EXISTS\(SELECT 1 FROM news_popularity npv WHERE npv\.url_key=a\.url_key\)/);
  assert.match(source, /EXISTS\(SELECT 1 FROM news_popular_items pp WHERE pp\.title=a\.title\)/);
  assert.doesNotMatch(source, /LEFT JOIN news_popularity/);
  assert.match(source, /similarTokens\(titleTokens, old\.titleTokens/);
});

test('NewsBrief 로고를 누르면 현재 섹션의 홈으로 복귀한다', async () => {
  const html = await readFile(new URL('../newsbrief.html', import.meta.url), 'utf8');
  assert.match(html, /e\.target\.closest\('\.brand'\)/);
  assert.match(html, /setSubview\('home'\);state\.category='';state\.q='';state\.issueKey=''/);
});

test('조회 결과는 5분간 재사용하되 주간·월간 데이터는 사용자가 열 때만 요청한다', async () => {
  const html = await readFile(new URL('../newsbrief.html', import.meta.url), 'utf8');
  assert.match(html, /const VIEW_CACHE_TTL=300000/);
  assert.doesNotMatch(html, /function prefetchPeriods\(section\)/);
  assert.doesNotMatch(html, /requestIdleCallback/);
  assert.match(html, /if\(viewRequests\.has\(url\)\)return viewRequests\.get\(url\)/);
  assert.match(html, /const detailUrl=`\/api\/news\/articles\?\$\{p\}`/);
  assert.match(html, /fetchViewJson\(detailUrl/);
  assert.match(html, /viewCache\.clear\(\);viewRequests\.clear\(\)/);
  assert.match(html, /viewCacheGeneration\+=1/);
  assert.match(html, /content-visibility:auto/);
});

test('주간·월간 조회량은 Worker CPU 한도 안으로 제한한다', async () => {
  const page = await readFile(new URL('../newsbrief.html', import.meta.url), 'utf8');
  assert.match(page, /limit:isBaduk\?'120':'150'/);
});

test('핵심 뉴스는 원문 대신 아래에 선택한 요약 카드 한 장만 표시한다', async () => {
  const html = await readFile(new URL('../newsbrief.html', import.meta.url), 'utf8');
  assert.match(html, /id="hotTitleReset" type="button" disabled>오늘의 핵심 뉴스/);
  assert.doesNotMatch(html, />전체 보기</);
  assert.match(html, /href="#article-\$\{esc\(x\.url_key\)\}" data-jump-key/);
  assert.match(html, /\$\('hotTitleReset'\)\.disabled=!state\.focusKey/);
  assert.match(html, /class="hotchip \$\{selected\?'on':''\}"/);
  assert.match(html, /closest\('\[data-jump-key\]'\)/);
  assert.match(html, /state\.focusKey\?state\.items\.filter\(item=>item\.url_key===state\.focusKey\):state\.items/);
  assert.match(html, /state\.focusKey=jump\.dataset\.jumpKey;render\(\)/);
  assert.match(html, /closest\('#hotTitleReset'\)\)\{state\.focusKey='';render\(\);return\}/);
  assert.match(html, /state\.focusKey='';/);
  assert.match(html, /scrollIntoView\(\{behavior:'smooth',block:'center'\}\)/);
  assert.match(html, /card\.classList\.add\('issue-focus'\)/);
  assert.doesNotMatch(html, /class="hotchip" href="\$\{esc\(x\.url\)\}"/);
});

test('Claude 월간 비용은 2.50달러 목표와 2.70달러 절대 한도를 사용한다', async () => {
  const budget = await readFile(new URL('../functions/_lib/news-ai-budget.js', import.meta.url), 'utf8');
  const classifier = await readFile(new URL('../functions/api/news/classify-issues.js', import.meta.url), 'utf8');
  assert.match(budget, /CLAUDE_MONTHLY_TARGET_MICRO_USD = 2_500_000/);
  assert.match(budget, /CLAUDE_MONTHLY_HARD_LIMIT_MICRO_USD = 2_700_000/);
  assert.match(budget, /claude_budget_month/);
  assert.doesNotMatch(classifier, /MAX_NEW_ARTICLES_PER_RUN/);
  assert.match(classifier, /buildClassificationPlan\(articles, existingPayload, resetIssues \|\| regroupIssues\)/);
  assert.match(classifier, /const existingIssues = \(regroupIssues \? existingPayload : basePayload\)/);
  assert.match(classifier, /recordClaudeUsage/);
  assert.equal(claudeCostMicroUsd('claude-haiku-4-5-20251001', { input_tokens: 1000, output_tokens: 100 }), 1500);
  assert.equal(claudeCostMicroUsd('claude-sonnet-5', { input_tokens: 1000, output_tokens: 100 }), 4500);
});

test('이슈 예산이 부족하면 기존 캐시를 유지하고 새 기사는 다음 실행에 남긴다', async () => {
  const classifier = await readFile(new URL('../functions/api/news/classify-issues.js', import.meta.url), 'utf8');
  assert.match(classifier, /provider: 'budget-blocked'/);
  assert.match(classifier, /issues: enforceIssueRules\(existingPayload, articles, category\)\.map/);
  assert.doesNotMatch(classifier, /buildIssues|issueKey\(/);
});

test('바둑 검색에 섞인 무관한 기사는 Claude 대상으로 분류하지 않는다', () => {
  assert.equal(isBadukRelevant('신진서, 카타고와 세 번째 대국', ''), true);
  assert.equal(isBadukRelevant('희망과 절망', '신진서 9단이 한국기원에서 바둑 인공지능 카타고와 대국했다.'), true);
  assert.equal(isBadukRelevant("tvN 드라마 응답하라 1988 다시보기", '박보검과 혜리가 출연한 가족 드라마가 시청률을 기록했다.'), false);
});

test('바둑 표현을 비유로만 쓴 환경·기술 기사는 바둑으로 분류하지 않는다', () => {
  assert.equal(isBadukRelevant('일론 머스크가 그린 환경 유토피아', '세계 시장을 바둑판처럼 보는 기술 기사다.'), false);
  assert.equal(isBadukRelevant("[한경에세이] 일론 머스크의 '로봇 유토피아'", 'AI와 로봇 발전으로 모든 상품과 서비스가 공급되는 사회를 전망했다.'), false);
  assert.equal(isBadukRelevant('김영훈 장관 "AI시대엔 새 사회제도 발명해야"', '노동 복지 체계를 논의했다.'), false);
  assert.equal(isBadukRelevant('신진서, 세계바둑 결승 진출', '신진서 9단이 결승 대국을 치른다.'), true);
});

test('기존 바둑 목록은 정상 기사를 보존하고 명백한 AI 일반기사만 숨긴다', () => {
  assert.equal(isBadukDisplayRelevant('쏘팔코사놀 최고기사 결정전, 최강 vs 어린이 승부 펼쳐', '어린이와 프로의 특별 대국'), true);
  assert.equal(isBadukDisplayRelevant('알파고 쇼크 10년', '바둑 AI와 함께 성장한 기사들의 이야기'), true);
  assert.equal(isBadukDisplayRelevant("[한경에세이] 일론 머스크의 '로봇 유토피아'", 'AI와 노동의 미래를 전망했다.'), false);
  assert.equal(isBadukDisplayRelevant('궤도, AI 시대 경쟁력은 검증과 본질', '기업의 AI 활용을 강연했다.'), false);
});

test('요약 실패 기사는 같은 날 반복 호출하지 않고 적게 시도한 순서로 순환한다', async () => {
  const source = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  assert.match(source, /f\.last_attempt < datetime\('now','-20 hours'\)/);
  assert.match(source, /COALESCE\(f\.attempts,0\), COALESCE\(f\.last_attempt,'1970-01-01'\)/);
});

test('이미 정상 요약인 기사는 메타데이터만 보강하고 AI 요약을 다시 호출하지 않는다', async () => {
  const source = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  assert.match(source, /if \(exists\.summary_quality === 'full'\)/);
  assert.match(source, /if \(!exists\.image_url \|\| hasSyntheticTime \|\| hasDateOnly \|\| hasMissingTime \|\| hasGenericImage\)/);
  assert.match(source, /return outcome\('existing_full'\)/);
  assert.doesNotMatch(source, /hasPublicationCapacity/);
});

test('수동 한 달 백필만 대기 중인 요약을 강제 순환한다', async () => {
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const collector = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  assert.match(workflow, /backfill=1&force_retry=1/);
  assert.match(workflow, /repair=1&force_retry=1/);
  assert.match(collector, /forceRetry \? 1 : 0/);
  assert.match(collector, /retryAttemptLimit = forceRetry \? 25 : 24/);
});

test('watchdog은 재시도된 헬스 응답에서도 단일 실행 결정을 출력한다', async () => {
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  assert.match(workflow, /jq -r '[^\n]+' \| tail -n 1/);
  assert.match(workflow, /should_collect=\$\{should_collect:-true\}/);
});

test('배포는 필수 비밀값이 없으면 production 설정을 건드리기 전에 중단한다', async () => {
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  assert.match(workflow, /Validate required deployment secrets/);
  assert.match(workflow, /production settings were not changed/);
});

test('Cloudflare Pages 배포는 유지보수 중인 Wrangler action을 사용한다', async () => {
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  assert.match(workflow, /cloudflare\/wrangler-action@v3/);
  assert.match(workflow, /pages deploy dist --project-name=newsbrief-etkfkds2 --branch=main/);
  assert.doesNotMatch(workflow, /cloudflare\/pages-action/);
});

test('운영 테이블은 장기 실행에도 크기가 제한된다', async () => {
  const collector = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  assert.match(collector, /SELECT id FROM news_runs ORDER BY id DESC LIMIT 500/);
  assert.match(collector, /datetime\('now','-60 days'\)/);
});

test('만료 직전의 유효한 로그인 세션은 활동 시 갱신한다', async () => {
  const middleware = await readFile(new URL('../functions/_middleware.js', import.meta.url), 'utf8');
  const session = await readFile(new URL('../functions/_lib/session.js', import.meta.url), 'utf8');
  assert.match(middleware, /sessionNeedsRefresh/);
  assert.match(middleware, /set-cookie/);
  assert.match(session, /SESSION_REFRESH_DAYS = 7/);
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

test('브라우저는 사용자 ID를 만들거나 전송하지 않고 삭제 UI만 제공한다', async () => {
  const html = await readFile(new URL('../newsbrief.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /USER_KEY/);
  assert.doesNotMatch(html, /x-news-user/);
  assert.doesNotMatch(html, /data-view="hidden"/);
  assert.doesNotMatch(html, /data-action="unhide"/);
  assert.match(html, /data-action="hide">삭제/);
  assert.match(html, /기사를 삭제했습니다/);
  assert.match(html, /item\.related\|\|\[\]/);
  assert.match(html, /url_keys:urlKeys/);
});

test('복수 계정 로그인은 서명된 쿠키에 서로 다른 사용자 ID를 저장한다', async () => {
  const env = {
    NEWSBRIEF_SITE_USERS: JSON.stringify({ member_a: 'pw-a', member_b: 'pw-b' }),
    NEWSBRIEF_SESSION_SECRET: 'independent-session-secret'
  };
  const responseA = await login({
    request: new Request('https://example.com/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'member_a', password: 'pw-a' })
    }), env
  });
  const responseB = await login({
    request: new Request('https://example.com/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'member_b', password: 'pw-b' })
    }), env
  });
  const cookieA = responseA.headers.get('set-cookie');
  const cookieB = responseB.headers.get('set-cookie');
  assert.equal(responseA.status, 200);
  assert.equal(responseB.status, 200);
  assert.equal((await readSession(cookieA, env.NEWSBRIEF_SESSION_SECRET)).userId, 'member_a');
  assert.equal((await readSession(cookieB, env.NEWSBRIEF_SESSION_SECRET)).userId, 'member_b');
});

test('관리 계정 입력은 소문자 아이디와 4~64자 비밀번호만 허용한다', () => {
  assert.equal(validUsername('member_01'), true);
  assert.equal(validUsername('Member_01'), false);
  assert.equal(validUsername('ab'), false);
  assert.equal(validPassword('1234'), true);
  assert.equal(validPassword('123'), false);
});

test('일반 사용자는 계정 관리 API를 열거나 수정할 수 없다', async () => {
  const request = new Request('https://example.com/api/admin/users', { headers: { 'x-news-user': 'account:member' } });
  assert.equal((await listUsers({ request, env: {} })).status, 403);
  assert.equal((await updateUser({ request: new Request(request, { method: 'POST' }), env: {} })).status, 403);
});

test('관리자 본인 계정 삭제는 서버에서 거부한다', async () => {
  const response = await updateUser({
    request: new Request('https://example.com/api/admin/users', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-news-user': 'account:admin0221' },
      body: JSON.stringify({ action: 'delete', username: 'admin0221' })
    }), env: {}
  });
  assert.equal(response.status, 400);
});

test('관리자 화면과 배포 산출물은 관리자 전용 계정 관리를 포함한다', async () => {
  const page = await readFile(new URL('../admin.html', import.meta.url), 'utf8');
  const home = await readFile(new URL('../newsbrief.html', import.meta.url), 'utf8');
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const schema = await readFile(new URL('../functions/_lib/news-db.js', import.meta.url), 'utf8');
  assert.match(page, /계정 추가/);
  assert.match(page, /비밀번호 변경/);
  assert.match(page, /아이디 변경/);
  assert.match(page, /data-action="delete"/);
  assert.match(page, /무료 DB 저장공간/);
  assert.match(page, /\/api\/admin\/usage/);
  assert.match(home, /me\?\.admin/);
  assert.match(workflow, /cp admin\.html dist\/admin\.html/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS news_users/);
});

test('계정 삭제는 해당 계정의 저장·삭제 기록도 함께 제거한다', async () => {
  const source = await readFile(new URL('../functions/api/admin/users.js', import.meta.url), 'utf8');
  assert.match(source, /const accountId = `account:\$\{username\}`/);
  assert.match(source, /DELETE FROM news_saved WHERE user_id=\?/);
  assert.match(source, /DELETE FROM news_hidden WHERE user_id=\?/);
  assert.match(source, /preferences_deleted: true/);
});

test('계정 삭제 API는 대상 계정 저장·삭제 행과 계정을 한 배치로 정리한다', async () => {
  const executed = [];
  const env = {
    NEWSBRIEF_SITE_USER: 'admin0221', NEWSBRIEF_SITE_PASSWORD: 'admin-pass',
    DB: {
      prepare(sql) {
        return { sql, values: [], bind(...values) { this.values = values; return this; } };
      },
      async batch(statements) { executed.push(...statements); return statements.map(() => ({})); }
    }
  };
  const response = await updateUser({
    request: new Request('https://example.com/api/admin/users', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-news-user': 'account:admin0221' },
      body: JSON.stringify({ action: 'delete', username: 'member01' })
    }), env
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.preferences_deleted, true);
  const cleanup = executed.filter(statement => /DELETE FROM news_(?:saved|hidden) WHERE user_id=\?/.test(statement.sql));
  assert.equal(cleanup.length, 2);
  assert.deepEqual(cleanup.map(statement => statement.values), [['account:member01'], ['account:member01']]);
});

test('무료 DB 저장공간 70%는 관리자와 자동 건강 점검에서 경고한다', async () => {
  const usage = await readFile(new URL('../functions/api/admin/usage.js', import.meta.url), 'utf8');
  const health = await readFile(new URL('../functions/api/news/health.js', import.meta.url), 'utf8');
  assert.match(usage, /FREE_DATABASE_BYTES = 500 \* 1024 \* 1024/);
  assert.match(usage, /storagePercent >= 85 \? 'danger' : storagePercent >= 70 \? 'warning'/);
  assert.match(health, /database_storage_below_70_percent/);
});

test('아이디 변경은 저장·삭제 데이터를 새 계정으로 이전하고 기존 계정을 비활성화한다', async () => {
  const source = await readFile(new URL('../functions/api/admin/users.js', import.meta.url), 'utf8');
  assert.match(source, /INSERT OR IGNORE INTO news_saved/);
  assert.match(source, /INSERT OR IGNORE INTO news_hidden/);
  assert.match(source, /DELETE FROM news_saved WHERE user_id=/);
  assert.match(source, /oldUsername === adminUsername/);
  assert.match(source, /active=0/);
});

test('미들웨어는 브라우저의 위조 사용자 ID를 로그인 계정 ID로 덮어쓴다', async () => {
  const secret = 'middleware-session-secret';
  const cookie = await createSessionCookie(secret, 'member_a');
  let forwardedUser = '';
  const response = await authMiddleware({
    request: new Request('https://example.com/api/news/articles', {
      headers: { cookie, 'x-news-user': 'account:member_b' }
    }),
    env: { NEWSBRIEF_SESSION_SECRET: secret },
    next: async request => {
      forwardedUser = request.headers.get('x-news-user');
      return new Response('ok');
    }
  });
  assert.equal(response.status, 200);
  assert.equal(forwardedUser, 'account:member_a');
});

test('미들웨어는 검증한 세션을 갱신 판단에 재사용한다', async () => {
  const middleware = await readFile(new URL('../functions/_middleware.js', import.meta.url), 'utf8');
  assert.match(middleware, /sessionNeedsRefresh\(cookieHeader, sessionSecret, session\)/);
});

test('삭제되거나 비밀번호가 변경된 계정의 기존 세션은 즉시 거부한다', async () => {
  const secret = 'revocation-session-secret';
  const cookie = await createSessionCookie(secret, 'removed');
  const env = { NEWSBRIEF_SESSION_SECRET: secret, DB: {
    prepare() { return { bind() { return this; }, async first() { return { active: 0, updated_at: '2026-07-28 00:00:00' }; } }; }
  } };
  const response = await authMiddleware({
    request: new Request('https://example.com/api/news/articles', { headers: { cookie } }), env,
    next: async () => new Response('should not run')
  });
  assert.equal(response.status, 401);
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

test('보조 공급자 장애는 신규 등록 여부와 무관하게 경고만 남긴다', async () => {
  const script = await readFile(new URL('../scripts/google-news-discovery.mjs', import.meta.url), 'utf8');
  assert.match(script, /::warning::/);
  assert.doesNotMatch(script, /process\.exitCode = 2/);
});
