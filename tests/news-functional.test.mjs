import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { onRequestGet } from '../functions/api/news/articles.js';
import { googleNewsSearch, isBadukRelevant } from '../functions/api/news/collect.js';

test('정기 수집은 기존 게시 기사를 비노출 상태로 강등하지 않는다', async () => {
  const source = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /UPDATE news_articles SET summary='',summary_quality='none'/);
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
  assert.match(source, /DAILY_AI_CALL_LIMIT = 4/);
  assert.match(source, /ai_budget_day/);
  assert.match(source, /ai_blocked/);
});

test('Anthropic 요약 fallback은 평시·백필·누적 호출 상한을 적용한다', async () => {
  const collector = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  const ai = await readFile(new URL('../functions/_lib/news-ai-summary.js', import.meta.url), 'utf8');
  assert.match(collector, /DAILY_ANTHROPIC_CALL_LIMIT = 12/);
  assert.match(collector, /BACKFILL_ANTHROPIC_CALL_LIMIT = 200/);
  assert.match(collector, /TOTAL_ANTHROPIC_CALL_LIMIT = 600/);
  assert.match(collector, /reserveAnthropicCall/);
  assert.match(collector, /NEWSBRIEF_USE_ANTHROPIC: '1'/);
  assert.match(ai, /NEWSBRIEF_USE_ANTHROPIC === '1'/);
  assert.match(ai, /claude-haiku-4-5-20251001/);
});

test('Cloudflare AI 3줄 요약은 바둑과 일반 뉴스 모두 대상으로 한다', async () => {
  const collector = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  assert.match(collector, /cloudflareReserved = Boolean\(env\.AI\)/);
  assert.match(collector, /aiNewRemaining = \{ 바둑: newQuota, 일반: newQuota \}/);
  assert.match(collector, /quotaKey = payload\.category === '바둑' \? '바둑' : '일반'/);
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

test('이슈 필터는 기간 제한 없이 전체 관련 기사를 보여준다', async () => {
  const source = await readFile(new URL('../functions/api/news/articles.js', import.meta.url), 'utf8');
  const page = await readFile(new URL('../newsbrief.html', import.meta.url), 'utf8');
  assert.match(source, /issueCategory = issueKeyFilter\.split\('\|'\)\[0\]/);
  assert.match(source, /CATEGORIES\.has\(issueCategory\)/);
  assert.match(source, /const queryLimit = issueKeyFilter \? 900/);
  // Clicking an issue tile must not carry the sub-view's own hours window
  // (e.g. 주간's 168h) into the filtered result, or articles belonging to
  // the same issue but older than that window would be silently dropped.
  assert.match(page, /if\(!state\.issueKey\)\{\s*if\(sub==='weekly'\)/);
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

test('일일 이슈 분류는 바둑과 일반을 모두 Workers AI 우선으로 처리한다', async () => {
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const classifier = await readFile(new URL('../functions/_lib/news-issue-classify.js', import.meta.url), 'utf8');
  assert.match(workflow, /categories=\("바둑" "일반"\)/);
  assert.match(workflow, /Workers AI and Claude fallback/);
  assert.match(classifier, /if \(env\?\.AI\)/);
  assert.match(classifier, /classifyWithAnthropic/);
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
