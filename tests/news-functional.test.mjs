import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildIssuesFromCache, normalizeCachedIssues, onRequestGet } from '../functions/api/news/articles.js';
import { articleSectionCategory, fetchArticleText, googleNewsSearch, isBadukRelevant, naverSectionCategory } from '../functions/api/news/collect.js';
import { claudeCostMicroUsd } from '../functions/_lib/news-ai-budget.js';
import { runMessage } from '../functions/_lib/news-db.js';
import { sourceFiles, undefinedRefs } from '../scripts/check-undefined-refs.mjs';
import {
  classifyIssues, hasExistingTopicMismatch, hasIncidentLocationConflict, hasLegalCaseConflict, isStandaloneEventArticle, rejectConflictingExistingMatches,
  rewriteStandaloneTitles, standaloneBadukIssueTitle
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
import { allowedCandidate, readableArticleUrl, titleSimilarity } from '../functions/_lib/news-extract.js';
import { SAME_STORY_THRESHOLD, isSameStory, sharesTitleKeywords } from '../functions/_lib/news-dedup.js';

test('분류 프롬프트는 같은 재해의 2차 피해를 별도 이슈로 쪼개지 않도록 지시한다', async () => {
  const classifier = await readFile(new URL('../functions/_lib/news-issue-classify.js', import.meta.url), 'utf8');
  assert.match(classifier, /지진·화재·사고처럼 하나의 재해가 원인이 되어 같은 날 이어진 2차 피해/);
});

test('바둑은 공식 대회·리그 행사만 한 건 독립 이슈 후보로 보존한다', () => {
  assert.equal(isStandaloneEventArticle({ category: '바둑', title: '무안군, 중국 상숙시와 청소년 온라인 바둑대회 개최' }), true);
  assert.equal(isStandaloneEventArticle({ category: '바둑', title: '한중 청소년 바둑 스포츠교류 개최' }), false);
  assert.equal(isStandaloneEventArticle({ category: '바둑', title: '신진서 세계기전 우승' }), false);
  assert.equal(isStandaloneEventArticle({ category: '바둑', title: '김동한 프로기사 근황', summary: '국제 바둑대회에 출전한 경력이 있다.' }), false);
  assert.equal(isStandaloneEventArticle({ category: '바둑', title: '신진서 9단 최근 근황 공개' }), false);
});

test('일반 기사는 대회 제목 정규식과 무관하게 포털 인기 신호로만 단독 이슈를 판단한다', () => {
  assert.equal(isStandaloneEventArticle({ category: '사회', title: '박다윤 선수, 2022년 4월 전국종별 육상경기선수권대회 우승' }), false);
  assert.equal(isStandaloneEventArticle({ category: '사회', title: '박다윤 선수, 2022년 4월 전국종별 육상경기선수권대회 우승', is_popular: 1 }), true);
});

test('요약의 공식 대회명과 바둑 기록 기사도 단건 이슈로 보존한다', () => {
  const gwangju = {
    category: '바둑',
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
    { url_key: 'tournament', category: '바둑', title: '무안 청소년 온라인 바둑대회 개최', summary: '' },
    { url_key: 'profile', category: '바둑', title: '김동한 프로기사 근황', summary: '' },
    { url_key: 'pair-a', category: '바둑', title: '신진서 카타고 격파', summary: '' },
    { url_key: 'pair-b', category: '바둑', title: 'AI 넘어선 신진서', summary: '' }
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
  const articles = [{ url_key: 'general-event', category: '일반', title: '전국 창업대회 개최', summary: '' }];
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

test('기존 이슈와 핵심어가 겹치지 않는 기사는 편입하지 않는다', () => {
  const bibi = { title: '가수 비비, 새 앨범 발매', summary: '비비가 신곡과 공연 계획을 공개했다.' };
  const nike = { title: '나이키, 중국 매장 전략 재편', summary: '나이키가 중국 시장 전략을 바꾼다.' };
  assert.equal(hasExistingTopicMismatch('나이키 중국 시장 전략 전환', bibi), true);
  assert.equal(hasExistingTopicMismatch('나이키 중국 시장 전략 전환', nike), false);
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

test('일반 이슈는 capCount로 자르되 기타 묶음은 그대로 둔다', () => {
  const items = Array.from({ length: 14 }, (_, index) => ({
    url_key: `solo-${index}`, category: '경제', title: `이슈 기사 ${index + 1}`,
    published_at: `2026-07-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`
  }));
  const cached = [
    ...items.map((item, index) => ({
      key: `일반|ai:event:${index}`, title: `이슈 ${index + 1}`, url_keys: [item.url_key]
    })),
    { key: '일반|ai:misc', title: '기타', url_keys: ['solo-0'] }
  ];
  const capped = buildIssuesFromCache(items, cached, 12);
  const real = capped.filter(issue => !issue.key.endsWith('|ai:misc'));
  assert.equal(real.length, 12);
  // Most recent activity survives the cut - solo-13 (July 14) beats solo-1 (July 2).
  assert.equal(real[0].key, '일반|ai:event:13');
  assert.equal(capped.some(issue => issue.key === '일반|ai:misc'), true);
  const uncapped = buildIssuesFromCache(items, cached, 24);
  assert.equal(uncapped.filter(issue => !issue.key.endsWith('|ai:misc')).length, 14);
});

test('인기 점수가 있으면 최신순보다 우선하고, 없으면 최신순으로 되돌아간다', () => {
  const items = [
    { url_key: 'old-popular', title: '오래됐지만 랭킹 상위', published_at: '2026-07-01T00:00:00.000Z', popularity_score: 95 },
    { url_key: 'new-quiet', title: '최근이지만 랭킹 밖', published_at: '2026-07-14T00:00:00.000Z' },
    { url_key: 'newer-quiet', title: '더 최근이지만 랭킹 밖', published_at: '2026-07-15T00:00:00.000Z' }
  ];
  const cached = items.map((item, index) => ({ key: `일반|ai:${index}`, title: item.title, url_keys: [item.url_key] }));
  const issues = buildIssuesFromCache(items, cached);
  // Score wins outright even against a two-week-older publish date.
  assert.equal(issues[0].key, '일반|ai:0');
  // Among the untracked (score 0) issues, recency still breaks the tie.
  assert.deepEqual(issues.slice(1).map(issue => issue.key), ['일반|ai:2', '일반|ai:1']);
});

test('이슈 키워드는 기사 수가 아니라 가장 최근 활동 순서로 정렬한다', () => {
  const items = [
    { url_key: 'a1', category: '바둑', title: '오래된 대형 이슈 기사 1', published_at: '2026-07-01T00:00:00.000Z' },
    { url_key: 'a2', category: '바둑', title: '오래된 대형 이슈 기사 2', published_at: '2026-07-02T00:00:00.000Z' },
    { url_key: 'a3', category: '바둑', title: '오래된 대형 이슈 기사 3', published_at: '2026-07-03T00:00:00.000Z' },
    { url_key: 'b1', category: '바둑', title: '번개 바둑대회 개최', published_at: '2026-07-29T00:00:00.000Z' }
  ];
  const cached = [
    { key: '바둑|ai:big', title: '오래된 대형 이슈', url_keys: ['a1', 'a2', 'a3'] },
    { key: '바둑|ai:fresh', title: '번개 바둑대회', url_keys: ['b1'] }
  ];
  const issues = buildIssuesFromCache(items, cached);
  assert.deepEqual(issues.map(issue => issue.key), ['바둑|ai:fresh', '바둑|ai:big']);
});

test('일반 뉴스도 포털 인기 신호가 있으면 단독 이슈 캐시를 화면에 그대로 보존한다', () => {
  const items = [{ url_key: 'solo', category: '경제', title: '전기요금 동결 발표' }];
  const cached = [{ key: '일반|ai:event:solo', title: '전기요금 동결', url_keys: ['solo'] }];
  const issues = buildIssuesFromCache(items, cached);
  assert.deepEqual(issues.map(issue => issue.key), ['일반|ai:event:solo']);
});

test('바둑 단일 대회 AI 응답은 독립 이슈로 유지하고, 일반은 포털 인기 신호가 있어야 단독 이슈로 유지한다', async () => {
  const badukArticles = [{ url_key: 'mu-an', category: '바둑', title: '무안군, 중국 상숙시와 청소년 온라인 바둑대회 개최', summary: '청소년들이 온라인 바둑대회로 국제 우호를 다졌다.' }];
  const badukEnv = { AI: { run: async () => ({ response: '[{"title":"무안 상숙 청소년 바둑대회","indices":[0]}]' }) } };
  const baduk = await classifyIssues(badukEnv, badukArticles, [], { allowStandaloneEvents: true });
  assert.equal(baduk.groups[0].title, '무안 상숙 청소년 바둑대회');
  assert.equal(baduk.groups[0].url_keys[0], 'mu-an');

  // General news has no title pattern like baduk's "대회" wording, so a lone
  // article only keeps its own tile when it already ranks in portal
  // popularity data (is_popular) - never on the classifier's say-so alone.
  const popularArticles = [{ url_key: 'pop-1', title: '정부, 전기요금 동결 발표', summary: '전기요금이 동결됐다.', is_popular: 1 }];
  const popularEnv = { AI: { run: async () => ({ response: '[{"title":"전기요금 동결","indices":[0]}]' }) } };
  const popular = await classifyIssues(popularEnv, popularArticles, [], { allowStandaloneEvents: false });
  assert.equal(popular.groups[0].title, '전기요금 동결');
  assert.equal(popular.groups[0].url_keys[0], 'pop-1');

  const quietArticles = [{ url_key: 'quiet-1', title: '정부, 전기요금 동결 발표', summary: '전기요금이 동결됐다.' }];
  const quietEnv = { AI: { run: async () => ({ response: '[{"title":"전기요금 동결","indices":[0]}]' }) } };
  const quiet = await classifyIssues(quietEnv, quietArticles, [], { allowStandaloneEvents: false });
  assert.equal(quiet.groups[0].title, '기타');

  const omitted = await classifyIssues({ AI: { run: async () => ({ response: '[]' }) } }, badukArticles, [], { allowStandaloneEvents: true });
  assert.notEqual(omitted.groups[0].title, '기타');
  assert.equal(omitted.groups[0].url_keys[0], 'mu-an');
});

test('단독 이슈 제목 재작성은 인덱스로 기사에 맞춰 매핑하고 실패 시 빈 결과를 낸다', async () => {
  const originalFetch = globalThis.fetch;
  try {
    const articles = [
      { url_key: 'a1', title: '[단독] 정부, 전기요금 동결 발표 - 연합뉴스', summary: '전기요금이 동결됐다.' },
      { url_key: 'a2', title: '서울시, 청년 지원금 확대 - 뉴시스', summary: '청년 지원금이 확대된다.' }
    ];
    globalThis.fetch = async () => new Response(JSON.stringify({
      content: [{ type: 'text', text: '[{"index":0,"title":"전기요금 동결"},{"index":1,"title":"청년 지원금 확대"}]' }],
      usage: { input_tokens: 10, output_tokens: 5 }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    const result = await rewriteStandaloneTitles({ ANTHROPIC_API_KEY: 'test-key' }, articles);
    assert.equal(result.titles.get('a1'), '전기요금 동결');
    assert.equal(result.titles.get('a2'), '청년 지원금 확대');

    globalThis.fetch = async () => new Response('', { status: 500 });
    const failed = await rewriteStandaloneTitles({ ANTHROPIC_API_KEY: 'test-key' }, articles);
    assert.equal(failed.titles.size, 0);

    const noKey = await rewriteStandaloneTitles({}, articles);
    assert.equal(noKey.titles.size, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
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
  assert.match(endpoint, /const savedPayload = loadExistingPayload/);
  assert.match(endpoint, /resetIssues \? \[\] : savedPayload/);
  assert.match(endpoint, /issues: enforceIssueRules\(savedPayload/);
  assert.match(workflow, /reset_issues:/);
});

test('이슈 분류에 Sonnet 경로가 남아 있지 않다', async () => {
  // 예전에는 reset/regroup을 Sonnet으로 돌렸다. 2026-08-10에 그 경로로 수동
  // 재분류 한 번이 실제 $0.91을 썼다. 월 목표가 $4.75인데 한 번에 5분의 1이다.
  // 게다가 응답이 늦어 재시도된 실행은 recordClaudeUsage까지 못 가 예산 기록에도
  // 안 남았다. 이슈 묶기는 Haiku로 충분하다.
  const classifier = await readFile(new URL('../functions/_lib/news-issue-classify.js', import.meta.url), 'utf8');
  const endpoint = await readFile(new URL('../functions/api/news/classify-issues.js', import.meta.url), 'utf8');
  assert.doesNotMatch(classifier, /claude-sonnet-5/);
  assert.doesNotMatch(classifier, /HIGH_ACCURACY/);
  assert.doesNotMatch(classifier, /highAccuracy/);
  assert.doesNotMatch(endpoint, /highAccuracy/);
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

test('일반 단독 이슈 제목은 저장 전에 재작성을 시도하고 무료 모드에서는 건너뛴다', async () => {
  const endpoint = await readFile(new URL('../functions/api/news/classify-issues.js', import.meta.url), 'utf8');
  assert.match(endpoint, /category === '일반' && !forceFree && env\?\.ANTHROPIC_API_KEY/);
  assert.match(endpoint, /group\.url_keys\.length === 1/);
  assert.match(endpoint, /rewriteStandaloneTitles\(env, standaloneArticles\)/);
  assert.match(endpoint, /const titleBudget = await canUseClaude\(env, ESTIMATED_TITLE_REWRITE_MICRO_USD\)/);
});

test('이슈 후보 조회는 일반 기사에도 포털 인기 신호를 함께 읽는다', async () => {
  const endpoint = await readFile(new URL('../functions/api/news/classify-issues.js', import.meta.url), 'utf8');
  assert.match(endpoint, /FROM news_popularity\s+WHERE datetime\(collected_at\) >= datetime\('now','-7 days'\)/);
  assert.match(endpoint, /FROM news_popular_items\s+WHERE datetime\(collected_at\) >= datetime\('now','-7 days'\)/);
  assert.match(endpoint, /SELECT match_key FROM ranked_popularity ORDER BY best_rank ASC, seen_at DESC LIMIT 12/);
  assert.match(endpoint, /AS is_popular/);
  assert.doesNotMatch(endpoint, /category === '바둑'\s*&&\s*isStandaloneEventArticle/);
});

test('일반 이슈의 포털 인기 신호는 최근 7일 상위 12건으로만 제한된다', async () => {
  const endpoint = await readFile(new URL('../functions/api/news/classify-issues.js', import.meta.url), 'utf8');
  // Guard against regressing to the old unbounded "any historical match" gate,
  // which made almost every general article qualify as a standalone issue.
  assert.doesNotMatch(endpoint, /EXISTS\(SELECT 1 FROM news_popularity np WHERE np\.url_key=a\.url_key\)/);
  assert.doesNotMatch(endpoint, /EXISTS\(SELECT 1 FROM news_popular_items npi WHERE npi\.title=a\.title\)/);
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
  const extract = await readFile(new URL('../functions/_lib/news-extract.js', import.meta.url), 'utf8');
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  assert.match(extract, /NAVER_SECTION_CATEGORIES/);
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

test('article:section이 언론사 이름뿐이면 article:section2의 실제 카테고리를 쓴다', () => {
  const joongangStyle = '<meta property="article:section" content="중앙일보" />'
    + '<meta property="article:section2" content="사회" />'
    + '<meta property="article:section3" content="사건사고" />';
  assert.equal(articleSectionCategory(joongangStyle), '사회');
});

test('IT 과학 카테고리는 수집·분류·화면·일반 피드에서 제외한다', async () => {
  const page = await readFile(new URL('../newsbrief.html', import.meta.url), 'utf8');
  const collector = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  const extract = await readFile(new URL('../functions/_lib/news-extract.js', import.meta.url), 'utf8');
  const articles = await readFile(new URL('../functions/api/news/articles.js', import.meta.url), 'utf8');
  const issues = await readFile(new URL('../functions/api/news/classify-issues.js', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /'IT\/과학'/);
  assert.doesNotMatch(collector, /\['IT\/과학', '과학 기술'\]/);
  // 네이버 섹션 표는 news-extract.js로 옮겼다. 여기서 collect.js만 보면
  // 검사가 항상 통과해 의미를 잃으므로 옮겨간 파일을 함께 본다.
  assert.doesNotMatch(extract, /'105': 'IT\/과학'/);
  assert.match(articles, /a\.category NOT IN \('바둑','IT\/과학'\)/);
  assert.match(issues, /a\.category NOT IN \('바둑','IT\/과학'\)/);
});

test('일반 카테고리 복구는 최근 미검사 네이버 기사부터 공식 섹션으로 교정한다', async () => {
  const collector = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  const repairs = await readFile(new URL('../functions/_lib/news-repairs.js', import.meta.url), 'utf8');
  const db = await readFile(new URL('../functions/_lib/news-db.js', import.meta.url), 'utf8');
  assert.equal(naverSectionCategory('sectionId : "101"'), '경제');
  assert.match(db, /CREATE TABLE IF NOT EXISTS news_category_checks/);
  // 복구 구현은 news-repairs.js로 옮겼다. collect.js에는 호출부만 남는다.
  assert.match(collector, /repairGeneralCategories\(env/);
  assert.match(repairs, /LEFT JOIN news_category_checks c ON c\.url_key=a\.url_key/);
  assert.match(repairs, /c\.url_key IS NULL/);
  assert.match(repairs, /ORDER BY datetime\(COALESCE\(NULLIF\(a\.published_at/);
  assert.match(repairs, /INSERT INTO news_category_checks/);
  assert.doesNotMatch(repairs, /general_category_repair_cursor/);
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
  assert.match(health, /published_time_healthy/);
  assert.match(health, /summary_exhausted_below_threshold/);
  assert.match(health, /baduk_source_collected/);
  // 위 검사는 baduk.or.kr만 본다. 포털 바둑 전멸을 잡는 검사가 함께 있어야 한다.
  assert.match(health, /baduk_body_fetch_healthy/);
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
          if (sql.includes('f.attempts>=6')) return { count: 0 };
          return {};
        },
        async all() {
          if (sql.includes('FROM news_state')) return { results: [
            { key: 'ai_blocked', value: 0 },
            { key: 'claude_monthly_micro_usd', value: 500000 },
            { key: 'claude_budget_month', value: new Date().toISOString().slice(0, 7) }
          ] };
          // 저장/화면 대조 검사가 보는 상세 목록. 위 baduk 집계(4건)와 같은 수를
          // 돌려줘야 "저장은 됐는데 화면까지 못 간 기사"가 0으로 나온다.
          if (sql.includes("a.category='바둑'")) return { results: [
            { title: '신진서, 여섯번째 최고기사에 올랐다', summary: '신진서 9단이 최고기사에 올랐다.' },
            { title: '박정환, 명인전 8강 진출', summary: '박정환 9단이 8강에 올랐다.' },
            { title: '김은지, 여자기성전 우승', summary: '김은지 9단이 우승했다.' },
            { title: '변상일, 국수산맥 4강행', summary: '변상일 9단이 4강에 진출했다.' }
          ] };
          return { results: [] };
        }
      };
    }
  } });
  const healthy = await getNewsHealth({ env: makeEnv(0) });
  // 2건은 통과해야 한다. 발행시각을 안 내는 매체가 섞이는 것은 정상이고, 예전에
  // 0을 요구하다 옛 행 두 개 때문에 매일 실패해 알람이 통째로 무시됐다.
  const tolerated = await getNewsHealth({ env: makeEnv(2) });
  const unhealthy = await getNewsHealth({ env: makeEnv(9) });
  assert.equal(healthy.status, 200);
  assert.equal((await healthy.json()).ok, true);
  assert.equal((await tolerated.json()).ok, true);
  assert.equal(unhealthy.status, 200);
  const warning = await unhealthy.json();
  assert.equal(warning.ok, false);
  assert.deepEqual(warning.failures, ['published_time_healthy']);
});

test('바둑 건강 점검은 조용한 날이 아니라 소스 누락에만 실패한다', async () => {
  const makeEnv = (sourceLatest, storedLatest, baduk24h) => ({ DB: {
    async batch() { return []; },
    prepare(sql) {
      return {
        bind() { return this; },
        async first() {
          if (sql.includes('FROM news_runs')) return { status: 'ok', finished_at: new Date().toISOString(), message: '' };
          if (sql.includes('AS baduk')) return { baduk: baduk24h, general: 9 };
          if (sql.includes("TRIM(published_at)=''")) return { count: 0 };
          if (sql.includes('f.attempts>=6')) return { count: 0 };
          if (sql.includes("url LIKE '%baduk.or.kr%'")) return { latest: storedLatest };
          return {};
        },
        async all() {
          if (sql.includes('FROM news_state')) return { results: [
            { key: 'ai_blocked', value: 0 },
            { key: 'claude_monthly_micro_usd', value: 500000 },
            { key: 'claude_budget_month', value: new Date().toISOString().slice(0, 7) },
            { key: 'baduk_source_latest', value: sourceLatest }
          ] };
          return { results: [] };
        }
      };
    }
  } });
  // 소스가 며칠째 조용해 24시간 신규가 0이어도, 그 최신 글을 갖고 있으면 정상이다.
  const quiet = await (await getNewsHealth({ env: makeEnv('2026-08-05', '2026-08-05', 0) })).json();
  assert.equal(quiet.checks.baduk_source_collected, true);
  assert.equal(quiet.ok, true);
  // 소스에 새 글이 올라왔는데 우리가 못 가져왔으면 그때가 진짜 실패다.
  const missed = await (await getNewsHealth({ env: makeEnv('2026-08-09', '2026-08-05', 0) })).json();
  assert.equal(missed.checks.baduk_source_collected, false);
  assert.deepEqual(missed.failures, ['baduk_source_collected']);
  // 소스 날짜를 아직 한 번도 적지 못했으면 비교하지 않는다.
  const unknown = await (await getNewsHealth({ env: makeEnv('', '', 0) })).json();
  assert.equal(unknown.checks.baduk_source_collected, true);
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
  assert.match(collector, /SCHEDULED_GOOGLE_DISCOVERIES = 6/);
  assert.match(collector, /backfill \? 20 : \(badukOnly \? BADUK_ONLY_GOOGLE_DISCOVERIES : SCHEDULED_GOOGLE_DISCOVERIES\)/);
  // 상한에 걸려 버린 건수를 진단에 남긴다. 안 남기면 "다 봤다"로 읽힌다.
  assert.match(collector, /google_discoveries_dropped/);
});

test('바둑 전용 호출은 디스커버리 헤드라인을 넘겨받아 더 많이 해석한다', async () => {
  // 바둑에 자기 subrequest 예산을 주려고 따로 만든 호출인데, 정작 가장 좋은
  // 후보 목록(디스커버리 40건)이 그 호출에는 안 갔다. deploy.yml의 baduk_only
  // curl은 본문 없이 호출되므로 googleDiscoveries가 늘 빈 배열이었고, 그래서
  // 자체 RSS 폴백 3건에만 의존했다. 2026-08-11 실측: google_discovered=40인데
  // 바둑 전용 실행은 그 40건을 한 건도 못 봤다.
  const collector = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  const discovery = await readFile(new URL('../scripts/google-news-discovery.mjs', import.meta.url), 'utf8');
  assert.match(collector, /const BADUK_ONLY_GOOGLE_DISCOVERIES = 10/);
  assert.match(discovery, /baduk_only', '1'/);
  assert.match(discovery, /googleDiscoveries: discoveries/);
  // 바둑 전용 POST가 실패해도 앞선 수집은 이미 끝났으므로 워크플로를 세우지 않는다.
  assert.match(discovery, /::warning::Baduk-only collection failed/);
});

test('Google 바둑 발견은 한 검색어가 전체 후보를 독점하지 않는다', async () => {
  const discovery = await readFile(new URL('../scripts/google-news-discovery.mjs', import.meta.url), 'utf8');
  assert.match(discovery, /let addedForQuery = 0/);
  assert.match(discovery, /addedForQuery >= \(full \? 10 : 5\)/);
});

test('예약 수집은 매번 네이버 전 분야 인기뉴스를 충분히 처리한다', async () => {
  const collector = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  const sources = await readFile(new URL('../functions/_lib/news-sources.js', import.meta.url), 'utf8');
  assert.match(collector, /const SCHEDULED_GENERAL_CANDIDATES = 12/);
  // 인기 랭킹 페이지를 읽는 부분은 news-sources.js로 옮겼다.
  assert.match(sources, /const naverPages = pages\.slice\(0, 5\)/);
  assert.match(collector, /const popular = allPopular\.slice\(0, 12\)/);
  assert.match(collector, /diagnostics\.popular_resolved/);
  assert.match(collector, /await naverSearch\(env, `"\$\{row\.title\}"`, 1, 5\)/);
  assert.match(collector, /titleSimilarity\(row\.title, item\.title\) >= 0\.72/);
  assert.match(collector, /match\?\.originallink \|\| match\?\.link/);
  assert.doesNotMatch(collector, /const selected = \[pages\[slot % 5\], pages\[5\]\]/);
});

test('연합뉴스(story-news)와 itemprop=articleBody 본문도 추출한다', async () => {
  // A large share of general-category candidates resolve to these two markup
  // patterns (Yonhap wire copy syndicated everywhere via Naver, and mk.co.kr's
  // schema.org itemprop). Neither used the id/class keywords this regex used
  // to check, so every such candidate silently failed as body_too_short and
  // the general feed stayed stuck at ~2 published items a day.
  const originalFetch = globalThis.fetch;
  const yonhapHtml = `<html><body><article id="articleWrap" class="article-wrap01">
    <div class="story-news article">
      <p>${'가'.repeat(100)} 첫번째 문단입니다.</p>
      <p>${'나'.repeat(100)} 두번째 문단입니다.</p>
    </div>
  </article></body></html>`;
  const mkHtml = `<html><body><div class="news_cnt_detail_wrap" itemprop="articleBody">
    <p>${'다'.repeat(100)} 첫번째 문단입니다.</p>
    <p>${'라'.repeat(100)} 두번째 문단입니다.</p>
  </div></body></html>`;
  try {
    for (const html of [yonhapHtml, mkHtml]) {
      globalThis.fetch = async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
      const article = await fetchArticleText('https://example.com/article');
      assert.ok(article.body.length >= 180, `expected extracted body >= 180 chars, got ${article.body.length}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchArticleText의 모든 조기 반환은 sectionCategory를 포함한다', async () => {
  // A branch missing sectionCategory sent a bare `undefined` into a D1 bind
  // (the republish path reads article.sectionCategory with no `|| ''`
  // fallback) and crashed the entire collection run with D1_TYPE_ERROR.
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('', { status: 500 });
    assert.equal((await fetchArticleText('https://example.com/a')).sectionCategory, '');
    globalThis.fetch = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    assert.equal((await fetchArticleText('https://example.com/b')).sectionCategory, '');
    globalThis.fetch = async () => { throw new Error('network down'); };
    assert.equal((await fetchArticleText('https://example.com/c')).sectionCategory, '');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('검색 루프의 naverSearch 호출은 kakaoSearch처럼 try/catch로 보호된다', async () => {
  // naverSearch throws on any non-ok response. Every other call site already
  // guards against that, but the main SEARCHES loop didn't - a single
  // transient Naver API failure there propagated past collect()'s only
  // try/catch (in onRequestPost) and aborted the whole run before baduk,
  // general, or popularity resolution ever got a single candidate.
  const collector = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  const loopStart = collector.indexOf('for (const effectiveQuery of effectiveQueries) {');
  const loopEnd = collector.indexOf('\n  }\n', loopStart);
  const loopBody = collector.slice(loopStart, loopEnd);
  const naverCallIndex = loopBody.indexOf('await naverSearch(env, effectiveQuery, start, display)');
  assert.ok(naverCallIndex > 0, 'expected the SEARCHES loop naverSearch call to still exist');
  const precedingTry = loopBody.lastIndexOf('try {', naverCallIndex);
  const precedingCatch = loopBody.indexOf('catch', naverCallIndex);
  assert.ok(precedingTry >= 0 && precedingTry < naverCallIndex && precedingCatch > naverCallIndex,
    'expected the naverSearch call to be wrapped in its own try/catch');
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

test('하루치 예산 페이스는 표시용이고 Claude 호출을 막지 않는다', async () => {
  const budgetSource = await readFile(new URL('../functions/_lib/news-ai-budget.js', import.meta.url), 'utf8');
  // 하루 한도를 canUseClaude의 관문으로 쓰던 동안 요약이 낮에 끊겼고, 그
  // 뒤에 들어온 기사는 pending_summary로만 쌓였다. 서브리퀘스트 고갈에서
  // 살아남는 후보가 두어 건뿐인 바둑은 그대로 하루 발행 0이 됐다.
  // 사용자 판단으로 월 예산을 넘기더라도 기사를 끊지 않기로 했다.
  assert.doesNotMatch(budgetSource, /today < allowance/);

  // 값 자체는 health가 지출 속도를 보여주는 데 계속 쓴다.
  // 기준 달은 예외 표(MONTHLY_BUDGET_OVERRIDES)에 없는 달로 잡는다. 예외 달을
  // 쓰면 이 검사가 "월 목표 ÷ 남은 날"이 아니라 예외 값을 따라가 의미가 흐려진다.
  const { claudeMonthlyTargetMicroUsd, dailyAllowanceMicroUsd } =
    await import('../functions/_lib/news-ai-budget.js');
  const plainMonth = new Date('2026-10-01T00:00:00Z');
  const first = dailyAllowanceMicroUsd(0, plainMonth);
  assert.equal(first, Math.floor(claudeMonthlyTargetMicroUsd(plainMonth) / 31));
  // 같은 이유로 예외 없는 달을 쓴다. 10월도 31일이라 기대값은 그대로다.
  const overspent = dailyAllowanceMicroUsd(1_709_224, new Date('2026-10-07T00:00:00Z'));
  assert.equal(overspent, 121_631);
  assert.ok(overspent < first, `${overspent} < ${first}`);

  // 차단은 월 목표와 하드 한도만 한다. 하루치를 이미 넘겨 쓴 상태에서도
  // 월 목표 아래면 호출이 허용되어야 한다.
  const state = { claude_budget_month: '2026-08', claude_monthly_micro_usd: 2_029_870,
    claude_spend_day: new Date().toISOString().slice(0, 10), claude_daily_micro_usd: 900_000 };
  const env = { DB: { prepare(sql) { return {
    bind() { return this; },
    async first() {
      const key = (sql.match(/key='([a-z_]+)'/) || [])[1];
      return key in state ? { value: state[key] } : null;
    },
    async run() {}
  }; }, async batch() {} } };
  const { canUseClaude } = await import('../functions/_lib/news-ai-budget.js');
  const verdict = await canUseClaude(env, 15_000);
  assert.equal(verdict.allowed, true);
  assert.ok(verdict.today > verdict.allowance, `${verdict.today} > ${verdict.allowance}`);
});

test('Anthropic 요약 fallback은 평시·백필·월간 비용 상한을 적용한다', async () => {
  const collector = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  const ai = await readFile(new URL('../functions/_lib/news-ai-summary.js', import.meta.url), 'utf8');
  assert.match(collector, /DAILY_ANTHROPIC_CALL_LIMIT = 60/);
  // 총 60은 그대로, 몫만 나눈다(일반 40 하드 상한 → 바둑에 최소 20 보장).
  assert.match(collector, /BADUK_RESERVED_ANTHROPIC_CALLS = 20/);
  assert.match(collector, /GENERAL_BOOST_ANTHROPIC_CALL_LIMIT = GENERAL_DAILY_ANTHROPIC_CALL_LIMIT \+ 24/);
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
  const sources = await readFile(new URL('../functions/_lib/news-sources.js', import.meta.url), 'utf8');
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  assert.match(collector, /isPopular: true/);
  assert.match(collector, /popularOrder/);
  assert.match(collector, /LOCAL_GENERAL_PRESS\.test\(resolvedPress\)/);
  // 랭킹 페이지를 교차로 섞는 부분은 news-sources.js로 옮겼다.
  assert.match(sources, /groups\.flatMap/);
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

test('바둑과 일반 뉴스는 각각 하루 12개까지 게시한다', async () => {
  const collector = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  assert.match(collector, /DAILY_CATEGORY_PUBLISH_LIMIT = 12/);
  assert.doesNotMatch(collector, /MONTHLY_CATEGORY_PUBLISH_LIMIT/);
  // 상한 검사는 함수 하나로 모았다. 유료 요약을 사는 경로가 셋인데(신규 삽입,
  // 재요약 재시도, 기존 복구) 예전에는 신규 삽입에만 검사가 있어서 하루 19건이
  // 실렸다(2026-08-11 실측). 세 경로가 전부 같은 함수를 지나야 한다.
  assert.match(collector, /const hasPublicationCapacity = category =>/);
  assert.match(collector, /publicationCounts\[publicationBucket\(category\)\]\.daily < DAILY_CATEGORY_PUBLISH_LIMIT/);
  assert.equal((collector.match(/hasPublicationCapacity\(/g) || []).length, 3,
    '유료 요약을 사는 세 경로가 각각 한 번씩 상한을 물어야 한다');
  // 어느 경로가 상한에 걸렸는지 진단에서 갈라 볼 수 있어야 한다.
  assert.match(collector, /retry_over_daily_limit/);
  assert.match(collector, /existing_repair_over_daily_limit/);
  assert.match(collector, /home_display_limits = \{ baduk: 30, general: 10 \}/);
  assert.match(collector, /consumePublicationCapacity/);
  assert.match(collector, /publish_counts_before/);
  assert.match(collector, /publish_counts_after/);
  assert.match(collector, /validPublishedSummary\(row\.summary, row\.title, row\.category\)/);
  assert.match(collector, /const dayStart = Date\.UTC/);
});

test('바둑은 네이버 재확인 없이 한국기원 최신 원문을 직접 수집한다', async () => {
  const collector = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  const sources = await readFile(new URL('../functions/_lib/news-sources.js', import.meta.url), 'utf8');
  // 한국기원 목록을 읽는 부분은 news-sources.js로 옮겼다.
  assert.match(sources, /async function koreanBadukLatest/);
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

test('홈 일간 헤드라인은 최대 10개까지만 만든다', async () => {
  const page = await readFile(new URL('../newsbrief.html', import.meta.url), 'utf8');
  // 이 값을 10으로 바꾸려던 커밋(0c05a46)이 정작 slice는 12로 둔 채 파일 끝에
  // '2' 한 글자만 덧붙이고 끝났다. 테스트가 없어서 아무도 몰랐다.
  assert.match(page, /state\.issueItems=state\.items\.slice\(0,10\)/);
  assert.doesNotMatch(page, /state\.issueItems=state\.items\.slice\(0,12\)/);
  // </html> 뒤에 문자가 남으면 그때와 같은 사고가 조용히 통과한다.
  assert.match(page, /<\/html>\n$/);
});

test('이슈 필터는 현재 주간·월간 기간을 유지한다', async () => {
  const source = await readFile(new URL('../functions/api/news/articles.js', import.meta.url), 'utf8');
  const page = await readFile(new URL('../newsbrief.html', import.meta.url), 'utf8');
  assert.match(source, /issueCategory = issueKeyFilter\.split\('\|'\)\[0\]/);
  assert.match(source, /CATEGORIES\.has\(issueCategory\)/);
  assert.match(source, /const queryLimit = feedCandidateLimit\(/);
  assert.match(source, /issues \|\| Boolean\(issueKeyFilter\), category === '바둑'/);
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
  const repairs = await readFile(new URL('../functions/_lib/news-repairs.js', import.meta.url), 'utf8');
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  assert.match(collector, /repairGeneralArticleTimes/);
  // 복구 구현은 news-repairs.js로 옮겼다.
  assert.match(repairs, /TRIM\(published_at\)='' OR published_at GLOB '....-..-..'/);
  assert.match(repairs, /general_time_repair_cursor/);
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
  assert.match(html, /function resetIssueSelectionUi\(\)\{\s*state\.issueKey='';\s*if\(document\.activeElement instanceof HTMLElement\)document\.activeElement\.blur\(\);\s*render\(\);/);
  assert.match(html, /state\.issueKey=issue;\$\('query'\)\.value='';\s*if\(!issue\)resetIssueSelectionUi\(\);\s*return load\(\)/);
  assert.match(html, /if\(history\.state\?\.newsbriefIssue\)\{resetIssueSelectionUi\(\);history\.back\(\);return\}/);
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
  assert.doesNotMatch(html, /\.issueCard\{[^}]*min-height:/);
  assert.match(html, /\.issueCard\{justify-content:center;padding:9px;text-align:center\}/);
  assert.match(html, /\.issueName\{display:flex;flex-direction:column;align-items:center;justify-content:center/);
  assert.doesNotMatch(html, /\.issueName\{[^}]*min-height:/);
  assert.match(html, /\.issueName>span:not\(\.issueNew\)\{display:-webkit-box;[^}]*-webkit-line-clamp:3/);
  assert.match(html, /\.issuePanel\{padding:10px 14px 14px\}/);
  assert.match(html, /\.issueMeta\{flex-direction:column;align-items:center;gap:1px;margin-top:5px;padding-top:0/);
  assert.doesNotMatch(html, /\.issueMeta\{[^}]*margin-top:auto/);
  assert.match(html, /\.issueView\{white-space:nowrap\}/);
  assert.match(html, /\.issueViewDesktop\{display:none\}/);
  assert.match(html, /class="issueViewMobile">전체보기 <\/span><span class="issueArrow" aria-hidden="true">↓/);
});

test('주간·월간 카테고리 필터에서는 AI 이슈 키워드를 요청하거나 표시하지 않지만, 일간 헤드라인은 카테고리와 무관하게 보인다', async () => {
  const html = await readFile(new URL('../newsbrief.html', import.meta.url), 'utf8');
  assert.match(html, /\(sub==='daily'\|\|!state\.category\)&&sub!=='saved'/);
  assert.match(html, /if\(sub!=='saved'&&sub!=='daily'&&!state\.category\)p\.set\('issues','1'\)/);
  assert.match(html, /sub==='daily'\?'일간':sub==='weekly'\?'주간':sub==='monthly'\?'월간'/);
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
  assert.match(articles, /return \[\.\.\.rest\.slice\(0, capCount\), \.\.\.misc\]/);
  assert.doesNotMatch(articles, /rest\.slice\(0, misc\.length \? 11 : 12\)/);
  assert.match(articles, /reorderGeneralSummary/);
  assert.match(collector, /general_daily_goal = 10/);
  assert.match(collector, /SCHEDULED_GENERAL_CANDIDATES = 12/);
  assert.match(collector, /SCHEDULED_BADUK_CANDIDATES = 20/);
  assert.match(collector, /The broad query is the freshest view users see on Naver/);
  assert.match(collector, /Date\.parse\(b\.item\?\.pubDate/);
  assert.match(collector, /processed_by_category/);
  assert.match(collector, /candidate_outcomes/);
  assert.match(collector, /candidate_outcomes_by_category/);
  assert.match(collector, /SELECT url_key FROM news_articles WHERE url_key IN/);
  assert.match(collector, /const newOrder = Number\(knownCandidateKeys\.has/);
  assert.match(collector, /diagnostics\.new_candidates/);
});

test('일반 일간·주간·월간은 인기 랭킹 기사만 표시하고 저장 탭은 저장 기사만 표시한다', async () => {
  const html = await readFile(new URL('../newsbrief.html', import.meta.url), 'utf8');
  assert.match(html, /sub==='saved'\?'saved':\(isBaduk\?'latest':'popular'\)/);
});

test('인기뉴스 조회는 OR 조인 없이 URL·제목 인덱스를 따로 사용한다', async () => {
  const source = await readFile(new URL('../functions/api/news/articles.js', import.meta.url), 'utf8');
  assert.match(source, /EXISTS\(SELECT 1 FROM news_popularity npv WHERE npv\.url_key=a\.url_key\)/);
  assert.match(source, /EXISTS\(SELECT 1 FROM news_popular_items pp WHERE pp\.title=a\.title\)/);
  assert.doesNotMatch(source, /LEFT JOIN news_popularity/);
  assert.match(source, /similarTokens\(titleTokens, old\.titleTokens/);
});

test('인기 점수 조인은 일반 이슈 조회에만 켜지고 바둑·일반 목록 조회에는 켜지지 않는다', async () => {
  const source = await readFile(new URL('../functions/api/news/articles.js', import.meta.url), 'utf8');
  // The past incident this guards against: joining popularity tables on
  // every request (not just issues=1) caused Cloudflare Worker resource
  // limit 503s - see the comment above includePopularityScore.
  assert.match(source, /const includePopularityScore = issues && category !== '바둑'/);
  assert.match(source, /\$\{includePopularityScore \? `, \$\{popularityScore\} AS popularity_score` : ''\}/);
});

test('NewsBrief 로고를 누르면 현재 섹션의 일간 탭으로 복귀한다', async () => {
  const html = await readFile(new URL('../newsbrief.html', import.meta.url), 'utf8');
  assert.match(html, /e\.target\.closest\('\.brand'\)/);
  assert.match(html, /setSubview\('daily'\);state\.category='';state\.q='';state\.issueKey=''/);
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


test('모든 모듈이 정의하지 않은 함수를 호출하지 않는다', () => {
  // 리팩토링으로 함수를 다른 파일로 옮기면서 호출부의 import를 빠뜨리면,
  // node --check도 통과하고 D1이 필요한 경로라 단위 테스트도 닿지 않는다.
  // 실제로 titleIsTruncationOf가 이렇게 빠져 운영 수집이 500을 냈다.
  const offenders = sourceFiles().map(file => [file, undefinedRefs(file)]).filter(([, missing]) => missing.length);
  assert.deepEqual(offenders, [], offenders.map(([file, missing]) => `${file}: ${missing.join(', ')}`).join('\n'));
});

test('수집 기록 메시지는 한도를 넘겨도 항상 파싱 가능한 JSON이다', async () => {
  const short = runMessage({ ok: true, count: 1 });
  assert.deepEqual(JSON.parse(short), { ok: true, count: 1 });

  // 실제 수집 진단과 같은 모양. 예전에는 slice(0, 500)으로 문자열 중간을
  // 잘라 JSON이 깨졌고, 진단이 길어질수록 - 문제가 많아 정작 읽어야 할
  // 때일수록 - 확실히 못 읽었다.
  const message = runMessage({
    warnings: ['naver_error: Naver API 429'],
    diagnostics: {
      mode: 'scheduled',
      retry_repaired: 1,
      samples: [{ title: 'a'.repeat(1500), normalized: 'b'.repeat(4000) }],
      body_too_short_hosts: { 'general:example.co.kr:selector_miss': 4 }
    }
  });
  assert.ok(message.length <= 4000);
  const parsed = JSON.parse(message);
  // 부피가 큰 진단부터 버리므로 요약 정보는 살아남는다.
  assert.deepEqual(parsed.warnings, ['naver_error: Naver API 429']);
  assert.equal(parsed.diagnostics.mode, 'scheduled');
  assert.equal(parsed.diagnostics.retry_repaired, 1);
  assert.ok(parsed.diagnostics.dropped_keys >= 1);

  // diagnostics 묶음이 없는 복구 응답도 같은 규칙을 따른다.
  const repair = runMessage({
    title_repair: { matched: 2, repaired: 1, found: [{ url: `http://${'u'.repeat(4200)}` }] }
  });
  assert.ok(repair.length <= 4000);
  assert.equal(JSON.parse(repair).title_repair.repaired, 1);

  // 덜어낼 것이 없을 만큼 통짜로 큰 값도 유효한 JSON을 낸다.
  assert.doesNotThrow(() => JSON.parse(runMessage({ diagnostics: { blob: 'z'.repeat(9000) } })));

  const collect = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  assert.doesNotMatch(collect, /JSON\.stringify\([^)]*\)\.slice\(0, 500\)/);
});

test('Claude 월간 비용은 4.75달러 목표와 5.00달러 절대 한도를 사용한다', async () => {
  const budget = await readFile(new URL('../functions/_lib/news-ai-budget.js', import.meta.url), 'utf8');
  const classifier = await readFile(new URL('../functions/api/news/classify-issues.js', import.meta.url), 'utf8');
  assert.match(budget, /CLAUDE_MONTHLY_TARGET_MICRO_USD = 4_750_000/);
  assert.match(budget, /CLAUDE_MONTHLY_HARD_LIMIT_MICRO_USD = 5_000_000/);
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

test('팀 이름의 단과 씨름 장사 최정만은 바둑으로 들어오지 않는다', () => {
  // 실제 유입 사례: 씨름단(단으로 끝나는 팀 이름) + 우승이 바둑 문맥과
  // 동작으로 동시에 인정돼 분류를 통과했고, 본문의 '최정만'이 화면 필터의
  // 맨 '최정'에 부분 일치해 노출까지 됐다.
  const ssireum = '111회 우승! 영암군민속씨름단 ‘영민씨’, 모래판 밖에서도 영암의 얼굴';
  assert.equal(isBadukRelevant(ssireum, ''), false);
  assert.equal(isBadukDisplayRelevant(ssireum, '최정만(35)과 김민재(24)가 나란히 장사에 등극했다.'), false);
  for (const title of ['현대건설 배구단 결승 진출', '부산 시립합창단 개최', 'LG 트윈스 구단 승리']) {
    assert.equal(isBadukRelevant(title, ''), false, title);
  }
  // 단수(9단)와 입단은 그대로 바둑 문맥으로 인정한다.
  for (const title of ['최정 9단, 여자기성전 결승 진출', '이세돌 9단 은퇴 대국', '김은지 입단 후 첫 승리']) {
    assert.equal(isBadukRelevant(title, ''), true, title);
  }
  assert.equal(isBadukDisplayRelevant('여자 바둑 1위 탈환', '최정이 랭킹을 역전했다.'), true);
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
  // 검사하려는 것은 "이 분기가 유료 요약을 다시 부르지 않는다"이다. 예전에는
  // 파일 전체에 특정 이름이 없는지로 대신 봤는데, 그 방식은 관계없는 함수가
  // 생기기만 해도 깨지면서 정작 이 분기는 안 본다. 분기만 잘라서 본다.
  const fullBranch = source.slice(source.indexOf("if (exists.summary_quality === 'full')"),
    source.indexOf("return outcome('existing_full')"));
  assert.doesNotMatch(fullBranch, /summarize\(/);
  assert.doesNotMatch(fullBranch, /reserveAnthropicCall/);
});

test('수동 한 달 백필만 대기 중인 요약을 강제 순환한다', async () => {
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const collector = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  assert.match(workflow, /backfill=1&force_retry=1/);
  assert.match(workflow, /repair=1&force_retry=1/);
  assert.match(collector, /forceRetry \? 1 : 0/);
  assert.match(collector, /retryAttemptLimit = forceRetry \? 7 : 6/);
});

test('재요약 게이트는 유료 호출만 미루고 본문 재수집은 막지 않는다', async () => {
  const collector = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  const path = collector.slice(collector.indexOf('const mayResummarize') - 3000,
    collector.indexOf("outcome('existing_repair_deferred')"));

  // 게이트가 기사를 잃지 않는 근거 전체가 이 순서에 걸려 있다. 본문 재수집이
  // 게이트 뒤로 옮겨가면 "본문이 더 잘 긁혀서 성공하는" 유일한 회복 경로가
  // 같이 막혀, 미룬 기사가 영영 못 살아난다.
  const fetchAt = path.lastIndexOf('await fetchArticleText');
  const gateAt = path.indexOf('const mayResummarize');
  assert.ok(fetchAt >= 0 && gateAt > fetchAt,
    `본문 재수집(${fetchAt})이 게이트(${gateAt})보다 먼저여야 한다`);

  // 개선된 본문은 요약 성공 여부와 무관하게 저장돼야 다음 시도가 이득을 본다.
  assert.match(path, /body_text=CASE WHEN \?<>'' THEN \? ELSE body_text END/);
  // 요약과 품질은 valid일 때만 덮어쓴다 - 미뤄도 기존 요약이 지워지지 않는다.
  assert.match(path, /summary=CASE WHEN \? THEN \? ELSE summary END/);
  assert.match(path, /summary_quality=CASE WHEN \? THEN 'full' ELSE summary_quality END/);
  // 첫 시도(attempts=0, last_attempt 없음)는 통과해야 신규 유입이 안 줄어든다.
  assert.match(path, /Number\(exists\.summary_attempts \|\| 0\) < retryAttemptLimit/);
  assert.match(path, /Number\.isFinite\(lastAttemptAt\) && Date\.now\(\) - lastAttemptAt < 20 \* 3600000/);
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
  assert.match(html, /action==='hide'&&!confirm\('이 기사를 삭제하시겠습니까\?'\)\)return/);
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
  assert.match(html, /state\.items=isBaduk\?\(d\.items\|\|\[\]\):sortByArticleTime\(d\.items\)/);
  assert.doesNotMatch(html, /fmt\(x\.published_at\|\|x\.fetched_at\)/);
});

test('보조 공급자 장애는 신규 등록 여부와 무관하게 경고만 남긴다', async () => {
  const script = await readFile(new URL('../scripts/google-news-discovery.mjs', import.meta.url), 'utf8');
  assert.match(script, /::warning::/);
  assert.doesNotMatch(script, /process\.exitCode = 2/);
});

test('바둑 전용 수집은 일반 작업을 건너뛰고 자기 subrequest 예산을 쓴다', async () => {
  // 일반을 먼저 처리하는 순서 자체는 옳다(그 전에는 바둑이 예산을 다 써서 일반이
  // 굶었다). 다만 이제 반대로 바둑이 남은 것만 받게 됐으므로 - 실측 2026-08-10,
  // 바둑 본문 실패 7건 중 6건이 "Too many subrequests" - 순서를 뒤집는 대신
  // 바둑에 자기 호출을 준다. 호출마다 예산이 새로 주어지는 것이 요점이다.
  const collector = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  assert.match(collector, /badukOnly = false/);
  assert.match(collector, /baduk_only'\) === '1'/);
  // 일반 후보·재요약 루프를 건너뛴다.
  assert.match(collector, /if \(!badukOnly\) \{[\s\S]{0,240}generalCandidates\) inserted/);
  // 인기뉴스 해석은 전부 일반이고 순위당 subrequest를 2회까지 쓴다.
  assert.match(collector, /!backfill && !badukOnly\) try \{/);
  // 일반이 뒤처졌다는 이유로 바둑 전용 실행의 구글 해석까지 막으면 안 된다.
  assert.match(collector, /backfill \|\| badukOnly \? false/);
  assert.match(workflow, /baduk_only=1/);
});

test('요약을 사기 전에 AI에게 이미 다룬 이야기인지 한 번 묻는다', async () => {
  // 글자 유사도만으로는 부족하다. 실측 2026-08-10: 빙그레 부라보콘 보도자료
  // 14건 중 표현이 다른 4건이 문턱을 못 넘어 각각 유료 요약을 받았다.
  const collector = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  const classify = await readFile(new URL('../functions/_lib/news-issue-classify.js', import.meta.url), 'utf8');
  assert.match(collector, /findDuplicateStories/);
  // 판정도 유료 호출이므로 하루 상한·월 예산 관문을 함께 지나야 한다.
  assert.match(collector, /reserveAnthropicCall\(env, diagnostics, forceRetry, generalBoost, badukOnly \? 'baduk' : 'general'\)\) \{/);
  assert.match(collector, /recordClaudeUsage\(env, judged\.model, judged\.usage\)/);
  // 판정 결과는 무료 요약 경로로 이어져야 의미가 있다.
  assert.match(collector, /aiDuplicates\.get\(knownUrlKey\)/);
  // 중복 판정은 발행일이 같은 날끼리만 한다. 날이 다르면 헤드라인도 달라지므로
  // 각각 요약을 산다(사용자 결정 2026-08-10).
  assert.match(collector, /storyIndexByDay/);
  assert.match(collector, /freeDuplicateOf\(title, itemDay, finalCategory\)/);
  // 무료 규칙을 먼저 태우고, 무료로 가려진 후보는 AI 프롬프트에서 뺀다.
  assert.match(collector, /!freeDuplicateOf\(cleanTitle\(candidate\.item\?\.title \|\| ''\), candidateDay\(candidate\), candidate\.category\)/);
  // 판정 대상을 바둑으로 제한하지 않는다. 일반도 같은 배치에 실어 호출 수를 늘리지 않는다.
  assert.doesNotMatch(collector, /limitedCandidates\.filter\(candidate => candidate\.category === '바둑'\s*\n\s*&& candidate\.urlKey/);
  // 잘못 묶는 쪽이 더 나쁘다는 지시가 프롬프트에 남아 있어야 한다.
  assert.match(classify, /확신이 없으면 묶지 않는다/);
  assert.match(classify, /다른 라운드, 다른 대국, 다른 경기 결과는 절대 묶지 않는다/);
});


test('이슈 분류는 AI 응답과 규칙 탈락 건수를 기록한다', async () => {
  // 이게 없으면 이슈가 안 생겼을 때 AI가 못 묶은 것인지 우리 후처리가 버린
  // 것인지 구분할 수 없다. 2026-08-10 기원 살인 보도 8건이 두 번 연속 기타로
  // 갔는데 어느 쪽인지 알 방법이 없었다.
  const endpoint = await readFile(new URL('../functions/api/news/classify-issues.js', import.meta.url), 'utf8');
  const classifier = await readFile(new URL('../functions/_lib/news-issue-classify.js', import.meta.url), 'utf8');
  assert.match(endpoint, /ai_groups: aiGroups/);
  assert.match(endpoint, /rule_rejections: ruleRejections/);
  // 규칙 이름이 나와야 어느 관문이 버렸는지 알 수 있다.
  assert.match(classifier, /'incident_location'/);
  assert.match(classifier, /'legal_case'/);
  assert.match(classifier, /'topic_mismatch'/);
});

test('이슈 분류 프롬프트가 한 응답 안의 중복 이슈를 금지한다', async () => {
  // 실측 2026-08-10 바둑 재분류: AI가 한 번의 응답에서 같은 사건에 여러 이름을
  // 붙여 이슈를 쪼갰다. "신진서 카타고 AI 격파"(58건)와 "신진서 AI 카타고
  // 대국"(40건), "Sh수협은행 여자바둑최강전"(11건)과 "여자 바둑대회"(1건),
  // "부산시장배"와 "부산광역시장배"가 각각 따로 나왔다.
  // 제목 유사도로는 못 가른다 - 합쳐야 할 쌍이 0.353~0.818, 따로 둬야 할 쌍이
  // 0.080~0.696으로 구간이 겹친다. 그래서 프롬프트에서 막는다.
  const classifier = await readFile(new URL('../functions/_lib/news-issue-classify.js', import.meta.url), 'utf8');
  assert.match(classifier, /이번에 만드는 이슈끼리도 중복을 만들지 않는다/);
  // 같은 대회의 다른 부문까지 합쳐지면 안 된다. 이 예외가 없으면 하찬석국수배
  // 영재부와 어린이부가 하나로 뭉개진다.
  assert.match(classifier, /같은 대회라도 부문이 다르면 별개다/);
  assert.match(classifier, /하찬석국수배 영재바둑대회/);
});

test('바둑 이슈 분류는 겹쳐 싣는 일반 기사도 함께 본다', async () => {
  // 바둑 탭은 분류가 사회여도 바둑 독자에게 소식인 기사를 함께 싣는다.
  // 분류기가 category='바둑'만 보면 그 기사들은 이슈 캐시에 없어서 카드로는
  // 떠도 이슈 키워드가 안 만들어진다. 실측 2026-08-10: 노원구 기원 살인 보도
  // 8건이 바둑 탭 카드에는 있는데 주간·월간 이슈 키워드에는 없었다.
  const endpoint = await readFile(new URL('../functions/api/news/classify-issues.js', import.meta.url), 'utf8');
  const articles = await readFile(new URL('../functions/api/news/articles.js', import.meta.url), 'utf8');
  assert.match(endpoint, /a\.title LIKE '%바둑%'/);
  assert.match(endpoint, /a\.title LIKE '%기원%' AND a\.summary LIKE '%바둑%'/);
  // 읽기와 분류가 같은 조건이어야 카드와 타일이 어긋나지 않는다.
  assert.match(articles, /a\.title LIKE '%기원%' AND a\.summary LIKE '%바둑%'/);
});

test('section·main 컨테이너에 담긴 본문도 추출한다', async () => {
  // 태그 목록에 section이 없어서, itemprop="articleBody" 폴백이 정작 그것을
  // 쓰는 사이트에서 한 번도 발동하지 못했다. 뉴스핌 실측(2026-08-11): 본문이
  // <section class="contents" itemprop="articleBody">에 들어 있는데 태그가 안
  // 맞아 selector_miss로 떨어졌고, 그날 바둑 발행이 0건이 된 원인 중 하나였다.
  const sentence = '북한이 10일 원산 갈마리조트 선전에 총력을 기울였다고 조선중앙TV가 보도했다. ';
  const shapes = [
    `<section class="contents" itemprop="articleBody"><p>${sentence.repeat(6)}</p></section>`,
    `<main id="news-contents"><p>${sentence.repeat(6)}</p></main>`
  ];
  const originalFetch = globalThis.fetch;
  try {
    for (const html of shapes) {
      globalThis.fetch = async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
      const article = await fetchArticleText('https://www.newspim.com/news/view/1');
      assert.ok(article.body.length >= 180, `본문 추출 실패: ${article.body.length}자, ${article.fetchStatus}`);
      assert.equal(article.fetchStatus, 'ok');
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('네이버 스포츠 기사는 일반 뉴스 리더 주소로 먼저 시도한다', () => {
  // sports.naver.com/news?oid=..&aid=.. 는 http_404로 떨어진다(2026-08-11 실측
  // 4건). 호출부가 실패 시 원래 주소로 한 번 더 받으므로 이 치환은 기사를
  // 잃게 만들 수 없다.
  const reader = 'https://n.news.naver.com/mnews/article/311/0001756000';
  assert.equal(readableArticleUrl('https://sports.naver.com/news?oid=311&aid=0001756000'), reader);
  assert.equal(readableArticleUrl('https://m.sports.naver.com/news?aid=0001756000&oid=311'), reader);
  assert.equal(readableArticleUrl('https://m.sports.naver.com/kbaseball/article/311/0001756000'), reader);
  // 검색 API가 준 n.news.naver.com 링크는 그대로 우선한다(기존 동작).
  assert.equal(readableArticleUrl('https://www.newspim.com/news/view/1', reader), reader);
  // 바꿀 근거가 없으면 건드리지 않는다.
  assert.equal(readableArticleUrl('https://www.newspim.com/news/view/1'), 'https://www.newspim.com/news/view/1');
  assert.equal(readableArticleUrl('https://sports.naver.com/news?oid=311'), 'https://sports.naver.com/news?oid=311');
});

test('구글 뉴스 중계 URL은 후보로 받지 않고 제목을 원문으로 해석해서만 쓴다', async () => {
  // news.google.com/rss/articles/... 는 클라이언트 JS로만 풀리는 껍데기다.
  // 2026-08-11 실측: 그 페이지는 578KB짜리 구글 앱 셸이고 안에 원문 URL이 없다.
  // 예전 RSS 폴백은 그 링크를 source:'GOOGLE'로 그대로 밀어 넣어서, 바둑
  // body_too_short 8건 중 3건이 이 경로의 news.google.com:http_503이었다.
  assert.equal(allowedCandidate('https://news.google.com/rss/articles/CBMiZ0FV', 'GOOGLE'), false);
  assert.equal(allowedCandidate('https://www.chosun.com/sports/2026/08/11/ABC/', 'GOOGLE'), true);
  const collector = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  // 폴백도 디스커버리와 같은 해석기를 거쳐야 한다.
  assert.match(collector, /resolveBadukHeadline\(item\.title\)/);
  assert.doesNotMatch(collector, /source: 'GOOGLE' \}\)/);
});

test('한국기원만 살아 있고 포털 바둑이 전멸하면 건강 점검이 잡아낸다', async () => {
  // 2026-08-11 실측 상황을 그대로 세운다. baduk_source_collected는 baduk.or.kr만
  // 보므로 그날 하루 종일 통과했고, 포털 바둑 발행이 0건인 채로 health가 ok를
  // 반환했다. 사람이 화면을 보고서야 알았다.
  const runMessage = outcomes => JSON.stringify({
    warnings: [], diagnostics: { candidate_outcomes_by_category: { baduk: outcomes } }
  });
  const makeEnv = runs => ({ DB: {
    async batch() { return []; },
    prepare(sql) {
      return {
        bind() { return this; },
        async first() {
          if (sql.includes('FROM news_runs')) return { status: 'ok', finished_at: new Date().toISOString(), message: '' };
          if (sql.includes('AS baduk')) return { baduk: 1, general: 24 };
          if (sql.includes("TRIM(published_at)=''")) return { count: 0 };
          if (sql.includes('f.attempts>=6')) return { count: 0 };
          return {};
        },
        async all() {
          if (sql.includes('FROM news_state')) return { results: [
            { key: 'ai_blocked', value: 0 },
            { key: 'claude_monthly_micro_usd', value: 500000 },
            { key: 'claude_budget_month', value: new Date().toISOString().slice(0, 7) }
          ] };
          if (sql.includes("message LIKE '%diagnostics%'")) return { results: runs.map(o => ({ message: runMessage(o) })) };
          return { results: [] };
        }
      };
    }
  } });

  // 그날 실제 값: 정기 실행 4건 + 바둑 전용 실행 8건 = body_too_short 12, 발행 0.
  const broken = await (await getNewsHealth({ env: makeEnv([
    { body_too_short: 4, inserted_pending_summary: 2 },
    { body_too_short: 8, existing_repair_deferred: 5 }
  ]) })).json();
  assert.equal(broken.ok, false);
  assert.ok(broken.failures.includes('baduk_body_fetch_healthy'), broken.failures.join(','));
  assert.equal(broken.metrics.baduk_body_too_short_24h, 12);

  // 조용한 날은 울리지 않는다. 후보가 적으면 실패도 적다 - 예전 24시간 검사가
  // 삭제된 이유가 조용한 날마다 틀려서였으므로 이 구분이 핵심이다.
  const quiet = await (await getNewsHealth({ env: makeEnv([{ body_too_short: 1, existing_full: 6 }]) })).json();
  assert.equal(quiet.ok, true);

  // 실패가 섞여도 하나라도 실렸으면 경로가 살아 있다는 뜻이라 통과시킨다.
  const partial = await (await getNewsHealth({ env: makeEnv([
    { body_too_short: 9, inserted_publishable: 2 }
  ]) })).json();
  assert.equal(partial.ok, true);
  assert.equal(partial.metrics.baduk_published_by_runs_24h, 2);
});

test('같은 날 같은 사건은 제목이 달라도 무료 규칙으로 걸러 요약을 사지 않는다', () => {
  // 실측 2026-08-11. 06:01에 노원구 기원 살인 기사가 이미 실려 있는데, 09:58에
  // 들어온 후속 기사가 유료 3줄 요약을 또 받았다. 문자 유사도가 0.300~0.318로
  // 임계값 0.45에 못 미쳤기 때문이다. 그런데 news-dedup.js의 키워드 규칙은 바로
  // 이 사건을 근거로 만들어졌고, 화면(articles.js)에서는 이미 쓰고 있었다.
  // 수집이 화면보다 느슨하면 화면에 안 보일 기사에 돈을 쓰게 된다.
  const 신규 = '서울 노원구 기원서 지인 흉기 살해 60대 구속';
  const 기존 = [
    '[단독] 기원에서 말다툼하다 흉기 휘둘러 지인 살해…60대 남성 체포',
    '기원서 바둑 두다 말다툼…지인 살해한 60대 현행범 체포'
  ];
  for (const old of 기존) {
    assert.ok(titleSimilarity(old, 신규) < SAME_STORY_THRESHOLD, '유사도 규칙은 이 쌍을 놓친다');
    assert.equal(isSameStory(old, 신규), false);
    assert.equal(sharesTitleKeywords(old, 신규), true, `키워드 규칙이 잡아야 한다: ${old}`);
  }
  // 바둑에는 키워드 규칙을 걸지 않는다. 대회·기사 이름이 매 제목에 반복돼
  // 서로 다른 대국이 쉽게 3단어를 넘긴다.
  assert.equal(sharesTitleKeywords(
    '신진서 9단, 제49기 명인전 본선 1국 승리',
    '박정환 9단, 제49기 명인전 본선 2국 승리'), true);
});

test('무료 규칙으로 가려진 후보는 AI 중복 판정 프롬프트에서 뺀다', async () => {
  // 돈을 두 번 아낀다. 무료로 가릴 수 있는 것에 토큰을 쓰지 않고, 판정 자체는
  // 배치 한 번이라 바둑과 일반을 같이 실어도 호출 수가 늘지 않는다.
  const collector = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  assert.match(collector, /const dedupTargets = limitedCandidates\.filter\(candidate => candidate\.urlKey/);
  assert.match(collector, /!freeDuplicateOf\(cleanTitle\(candidate\.item\?\.title \|\| ''\), candidateDay\(candidate\), candidate\.category\)/);
  assert.match(collector, /ai_dedup_free_skipped/);
});

test('아직 이슈 분류를 못 받은 기사도 기존 이슈 카드에 관련 보도로 붙는다', async () => {
  // 이슈 분류는 하루 한 번(UTC 21:23) 돈다. 그 뒤에 들어온 기사는 이슈가 비어
  // 있는데, 예전 코드는 "이슈 있는 것끼리, 없는 것끼리"만 묶어서 그 기사가 기존
  // 카드에 구조적으로 붙을 수 없었다. 실측 2026-08-11: 06:01 노원구 카드(관련
  // 보도 4건)가 있는데 09:58 후속이 낱장으로 따로 섰다.
  const articles = await readFile(new URL('../functions/api/news/articles.js', import.meta.url), 'utf8');
  assert.match(articles, /const similarityJoin = old =>/);
  assert.match(articles, /: accepted\.find\(old => similarityJoin\(old\)\);/);
  // 이슈를 받은 기사는 같은 이슈 카드에는 issueFloor로 붙는다.
  assert.match(articles, /issueOf\.get\(old\.url_key\) === itemIssue/);
  assert.match(articles, /\? issueFloor\(old\)/);
});

test('허용되지 않는 후보는 배치 상한 앞에서 버린다', async () => {
  // 카카오 광범위 검색은 daum.net만 허용된다. 그 판정이 슬롯 배정 뒤에 돌아서,
  // 채택을 5건으로 올리자 바둑 20칸 중 10칸이 통과 불가 후보로 날아갔다.
  const collector = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  assert.match(collector, /if \(!allowedCandidate\(key, candidate\.source\)\) \{ disallowedBeforeBatch \+= 1; continue; \}/);
  assert.match(collector, /disallowed_before_batch/);
});

test('이슈 분류를 못 받은 새 기사와 분류된 옛 기사가 한 카드로 묶인다', async () => {
  // 실측 2026-08-11. 06:01 노원구 기원 살인 기사는 전날 21:23(UTC) 분류에
  // 들어가 이슈가 있고, 09:58 후속 기사는 그 뒤에 들어와 이슈가 없다. 목록은
  // 최신순이라 이슈 없는 09:58이 먼저 카드가 되고 이슈 있는 06:01이 나중에
  // 처리된다. 예전에는 "이슈 있는 것끼리, 없는 것끼리"만 묶어서 둘이 끝내
  // 따로 섰고, 사용자 화면에 카드 두 장으로 보였다.
  const rows = [
    // 최신순: 09:58 (이슈 없음) 먼저
    { id: 2, url: 'https://b', url_key: 'new', title: '서울 노원구 기원서 지인 흉기 살해 60대 구속',
      source: 'x', press: '', category: '사회',
      published_at: '2026-08-11 00:58:00', fetched_at: '2026-08-11 00:58:00',
      summary: '1) 서울 노원구 기원에서 지인을 흉기로 살해한 60대 남성이 구속됐다.\n2) 경찰은 피의자가 범행을 인정했다고 이날 밝혔다.\n3) 법원은 도주 우려가 있다며 영장을 발부했다고 전했다.',
      summary_quality: 'full', image_url: '', saved: 0 },
    { id: 1, url: 'https://a', url_key: 'old', title: '기원서 바둑 두다 말다툼…지인 살해한 60대 현행범 체포',
      source: 'x', press: '', category: '사회',
      published_at: '2026-08-10 21:01:00', fetched_at: '2026-08-10 21:01:00',
      summary: '1) 서울 노원구 기원에서 바둑을 두던 중 말다툼이 벌어져 60대가 지인을 살해했다.\n2) 경찰은 현장에서 피의자를 현행범으로 체포했다고 밝혔다.\n3) 정확한 범행 경위를 조사하고 있다고 이날 전했다.',
      summary_quality: 'full', image_url: '', saved: 0 }
  ];
  let boundCategory = '';
  const env = { DB: {
    batch: async () => [],
    prepare(sql) {
      if (sql.includes('SELECT payload FROM news_issue_cache')) {
        return { bind(bound) { boundCategory = bound; return this; },
          // 옛 기사만 분류돼 있다. 새 기사는 아직 캐시에 없다.
          async first() { return { payload: JSON.stringify([{ key: '일반|ai:0', title: '노원구 기원 살인', url_keys: ['old'] }]) }; } };
      }
      return { bind() { return this; }, async all() { return { results: rows }; } };
    }
  } };
  const response = await onRequestGet({ request: new Request('https://example.com/api/news/articles?issues=1&exclude_baduk=1'), env });
  const body = await response.json();
  // 이 검사가 의미를 가지려면 이슈 캐시가 실제로 로드돼야 한다. 안 로드되면
  // 두 기사 모두 '이슈 없음'이 되어 게이트를 아예 타지 않는다.
  assert.equal(boundCategory, '일반', '일반 이슈 캐시가 로드되지 않았다');
  assert.equal(body.items.length, 1, `카드가 ${body.items.length}장이다 - 한 장으로 묶여야 한다`);
  assert.equal(body.items[0].related_count, 1);
  const relatedKeys = body.items[0].related.map(entry => entry.url_key);
  assert.ok(relatedKeys.includes('new') || relatedKeys.includes('old'), '나머지 한 건이 관련 보도로 붙어야 한다');
});

test('서로 다른 이슈의 카드는 유사도가 높아도 합치지 않는다', async () => {
  // 위 양방향 허용이 "다른 이슈끼리도 붙는다"로 번지면 타일과 카드가 어긋난다.
  // 이슈를 가진 기사가 붙을 수 있는 상대는 같은 이슈 카드이거나 이슈가 아직
  // 없는 카드뿐이다.
  const articles = await readFile(new URL('../functions/api/news/articles.js', import.meta.url), 'utf8');
  assert.match(articles, /issueOf\.get\(old\.url_key\) === itemIssue\s*\n\s*\? issueFloor\(old\)\s*\n\s*: !issueOf\.get\(old\.url_key\) && similarityJoin\(old\)/);
});

test('같은 날 같은 사건에 요약을 두 번 사면 건강 점검이 잡아낸다', async () => {
  // 이 종류의 고장은 지금까지 사람이 화면을 보고 "왜 카드가 두 장이지"라고
  // 물어야만 드러났다(2026-08-11 노원구 기원 살인). 돈이 새는 쪽이라 자동으로
  // 잡아야 한다.
  const makeEnv = titles => ({ DB: {
    async batch() { return []; },
    prepare(sql) {
      return {
        bind() { return this; },
        async first() {
          if (sql.includes('FROM news_runs')) return { status: 'ok', finished_at: new Date().toISOString(), message: '' };
          if (sql.includes('AS baduk')) return { baduk: 4, general: 9 };
          if (sql.includes("TRIM(published_at)=''")) return { count: 0 };
          if (sql.includes('f.attempts>=6')) return { count: 0 };
          return {};
        },
        async all() {
          if (sql.includes('FROM news_state')) return { results: [
            { key: 'ai_blocked', value: 0 },
            { key: 'claude_monthly_micro_usd', value: 500000 },
            { key: 'claude_budget_month', value: new Date().toISOString().slice(0, 7) }
          ] };
          if (sql.includes("category<>'바둑'") && sql.includes('SELECT title')) {
            return { results: titles.map(title => ({ title, day: '2026-08-11' })) };
          }
          // 저장/화면 대조 검사가 보는 목록. 위 baduk 집계(4건)와 수를 맞춰
          // 이 시험의 관심사(중복 유료 요약)만 실패하도록 둔다.
          if (sql.includes("a.category='바둑'")) return { results: [
            { title: '신진서, 여섯번째 최고기사에 올랐다', summary: '신진서 9단이 최고기사에 올랐다.' },
            { title: '박정환, 명인전 8강 진출', summary: '박정환 9단이 8강에 올랐다.' },
            { title: '김은지, 여자기성전 우승', summary: '김은지 9단이 우승했다.' },
            { title: '변상일, 국수산맥 4강행', summary: '변상일 9단이 4강에 진출했다.' }
          ] };
          return { results: [] };
        }
      };
    }
  } });

  const leaking = await (await getNewsHealth({ env: makeEnv([
    '서울 노원구 기원서 지인 흉기 살해 60대 구속',
    '기원서 바둑 두다 말다툼…지인 살해한 60대 현행범 체포',
    '[단독] 기원에서 말다툼하다 흉기 휘둘러 지인 살해…60대 남성 체포'
  ]) })).json();
  assert.equal(leaking.ok, false);
  assert.ok(leaking.failures.includes('duplicate_paid_summaries_low'), leaking.failures.join(','));
  assert.ok(leaking.metrics.duplicate_paid_pairs_24h >= 2);
  assert.ok(leaking.metrics.duplicate_paid_samples.length > 0, '어떤 쌍이 걸렸는지 보여줘야 고칠 수 있다');

  // 서로 무관한 기사끼리는 울리지 않는다.
  const clean = await (await getNewsHealth({ env: makeEnv([
    '태풍 돌핀 북상, 제주 항공편 무더기 결항',
    '국회 본회의서 예산안 처리 무산',
    '한국은행 기준금리 동결 결정'
  ]) })).json();
  assert.equal(clean.ok, true);
  assert.equal(clean.metrics.duplicate_paid_pairs_24h, 0);
});

test('월 예산은 지정한 달만 예외를 두고 다음 달에 자동으로 되돌아간다', async () => {
  // 한 달만 올리고 되돌리는 것을 잊는 사고를 막으려고 표로 뒀다. 표에 없는 달은
  // 기본값을 쓰므로, 9월이 오면 사람이 아무것도 안 해도 $4.75로 돌아간다.
  const budget = await import('../functions/_lib/news-ai-budget.js');
  const at = value => new Date(`${value}T00:00:00Z`);
  // 2026-08만 예외다. 하루 발행 상한 누수로 월 중반까지 설계값의 두 배를 썼고,
  // 누수를 고쳐도 남은 날이 $4.75로는 모자란다(사용자 결정 2026-08-11).
  assert.equal(budget.claudeMonthlyTargetMicroUsd(at('2026-08-11')), 6_750_000);
  assert.equal(budget.claudeMonthlyHardLimitMicroUsd(at('2026-08-11')), 7_000_000);
  // 앞뒤 달과 내년 같은 달은 기본값이다.
  for (const day of ['2026-07-31', '2026-09-01', '2026-12-25', '2027-08-05']) {
    assert.equal(budget.claudeMonthlyTargetMicroUsd(at(day)), budget.CLAUDE_MONTHLY_TARGET_MICRO_USD, day);
    assert.equal(budget.claudeMonthlyHardLimitMicroUsd(at(day)), budget.CLAUDE_MONTHLY_HARD_LIMIT_MICRO_USD, day);
  }
  // 하루치 페이스도 그 달의 예산을 따라야 한다. 안 그러면 계기판만 옛 숫자를 본다.
  assert.equal(budget.dailyAllowanceMicroUsd(0, at('2026-08-01')), Math.floor(6_750_000 / 31));
  assert.equal(budget.dailyAllowanceMicroUsd(0, at('2026-09-01')), Math.floor(4_750_000 / 30));
});

test('건강 점검은 이 달에 적용 중인 예산을 함께 보여준다', async () => {
  // 한 달만 올려둔 것을 나중에 잊지 않으려면 계기판에 드러나야 한다.
  const health = await readFile(new URL('../functions/api/news/health.js', import.meta.url), 'utf8');
  assert.match(health, /claude_monthly_target_micro_usd: claudeMonthlyTargetMicroUsd\(now\)/);
  assert.match(health, /claude_monthly_hard_limit_micro_usd: claudeMonthlyHardLimitMicroUsd\(now\)/);
  assert.match(health, /claude_under_hard_limit: monthlySpend < claudeMonthlyHardLimitMicroUsd\(now\)/);
});

test('건강 경고는 실패 목록이 바뀔 때만 알리고 회복되면 이슈를 닫는다', async () => {
  // 실측 2026-08-11: 경고 이슈 #3이 7월 30일부터 열린 채 댓글 177개가 쌓여
  // 있었다. 3시간마다 한 통씩 12일간 같은 제목의 메일이 갔다는 뜻이다. 그러면
  // 사람이 알람을 통째로 무시하게 되고, 정작 새로 생긴 고장은 사용자가 화면을
  // 보고 발견하게 된다. 코드 곳곳에 "그래서 사람이 손으로 무시하게 됐다"는
  // 주석이 있는데 알람 시스템 자신이 그 상태였다.
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  // 실패 목록을 서명으로 남기고, 직전 알림과 같으면 조용히 둔다.
  assert.match(workflow, /failures-signature: \$\{signature\}/);
  assert.match(workflow, /if \[ "\$signature" = "\$previous" \]; then/);
  // 회복 시 닫는 단계가 있어야 한다. 예전에는 닫는 로직이 아예 없어서 고쳐도
  // 경고가 열린 채 남았고, 그 상태가 길어지면 "원래 켜져 있는 것"이 된다.
  assert.match(workflow, /Close health alert issue on recovery/);
  assert.match(workflow, /steps\.health\.outputs\.unhealthy == 'false'/);
  assert.match(workflow, /gh issue close "\$issue"/);
  // 이슈를 만들거나 새 실패를 알릴 때만 job을 실패로 남긴다.
  assert.doesNotMatch(workflow, /gh issue comment "\$issue" --repo "\$GITHUB_REPOSITORY" --body "\$body"\n\s+fi\n\s+exit 1/);
});
