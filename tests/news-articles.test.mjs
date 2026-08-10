import test from 'node:test';
import assert from 'node:assert/strict';
import { feedCandidateLimit, issueCandidateLimit, onRequestGet } from '../functions/api/news/articles.js';

const summary = [
  '1) 신진서 9단은 인공지능 카타고와의 대국에서 최종 승리를 거뒀다.',
  '2) 신진서는 첫 대국 패배 뒤 경기 방식을 분석해 두 번째 대국에서 승리했다.',
  '3) 마지막 대국에서도 안정적인 운영을 이어가며 최종 전적 2승 1패를 기록했다.'
].join('\n');

function mockEnv(rows, issueCache = null) {
  let articleSql = '';
  return {
    get articleSql() { return articleSql; },
    DB: {
      batch: async () => [],
      prepare(sql) {
        if (sql.includes('SELECT a.id')) articleSql = sql;
        return {
          bind() { return this; },
          async first() { return sql.includes('news_issue_cache') && issueCache ? { payload: JSON.stringify(issueCache) } : null; },
          async all() { return { results: sql.includes('SELECT a.id') ? rows : [] }; }
        };
      }
    }
  };
}

test('같은 사건은 대표 기사와 관련 보도로 묶고 실제 언론사명을 표시한다', async () => {
  const base = { category: '바둑', published_at: '2026-07-23T01:00:00Z', fetched_at: '2026-07-23T01:00:00Z', summary, summary_quality: 'full', image_url: '', saved: 0, press: '' };
  const env = mockEnv([
    { ...base, id: 1, url_key: 'a', url: 'https://n.news.naver.com/mnews/article/055/1', title: '신진서, 바둑 AI 카타고에 2승 1패 역전승', source: 'NAVER' },
    { ...base, id: 2, url_key: 'b', url: 'https://n.news.naver.com/mnews/article/009/2', title: '신진서, AI 카타고 상대로 2승 1패 역전승', source: 'NAVER' }
  ]);
  const response = await onRequestGet({ request: new Request('https://example.com/api/news/articles?view=home'), env });
  const data = await response.json();
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].outlet, 'SBS');
  assert.equal(data.items[0].related_count, 1);
  assert.equal(data.items[0].related[0].outlet, '매일경제');
});

test('바둑 숨김 설정은 API 조회 조건에도 적용한다', async () => {
  const env = mockEnv([]);
  await onRequestGet({ request: new Request('https://example.com/api/news/articles?exclude_baduk=1'), env });
  assert.match(env.articleSql, /a\.category NOT IN \('바둑','IT\/과학'\)/);
});

test('이슈 조회는 500행 고정 조인 대신 화면 크기에 맞는 후보만 읽는다', () => {
  assert.equal(issueCandidateLimit(150, true), 150);
  assert.equal(issueCandidateLimit(120, true, true), 240);
  assert.equal(issueCandidateLimit(60, false), 60);
});

test('오늘 목록 10건과 핵심뉴스 6건을 위해 검증 전 인기 후보를 넉넉히 읽는다', () => {
  assert.equal(feedCandidateLimit(10, 'popular', false), 50);
  assert.equal(feedCandidateLimit(10, 'home', false), 50);
  assert.equal(feedCandidateLimit(150, 'popular', true), 150);
  assert.equal(feedCandidateLimit(10, 'latest', false), 10);
});

test('이슈 상세는 목록과 같은 후보 수를 쓰고 인기 테이블을 LEFT JOIN하지 않는다', async () => {
  const env = mockEnv([], [{ key: '일반|ai:0', title: '테스트 이슈', url_keys: ['a', 'b'] }]);
  await onRequestGet({ request: new Request('https://example.com/api/news/articles?limit=150&exclude_baduk=1&issue_key=일반%7Cai%3A0'), env });
  assert.doesNotMatch(env.articleSql, /JOIN news_popularity/);
  assert.doesNotMatch(env.articleSql, /JOIN news_popular_items/);
  assert.match(env.articleSql, /a\.url_key IN \(\?,\?\)/);
});

test('도메인 출처는 사람이 읽는 언론사명으로 변환한다', async () => {
  const row = { id: 3, url_key: 'c', url: 'https://www.yna.co.kr/view/AKR1', title: '정부는 오늘 새로운 산업 지원 대책을 공식 발표했다', source: 'yna.co.kr', press: '', category: '경제', published_at: '2026-07-23T01:00:00Z', fetched_at: '2026-07-23T01:00:00Z', summary, summary_quality: 'full', image_url: '', saved: 0 };
  const env = mockEnv([row]);
  const response = await onRequestGet({ request: new Request('https://example.com/api/news/articles'), env });
  const data = await response.json();
  assert.equal(data.items[0].outlet, '연합뉴스');
});

test('같은 보도자료가 매체만 바뀐 것은 카드 하나로 접고 관련 보도로 남긴다', async () => {
  // 2026-08-10 운영 데이터: 빙그레 부라보콘 대회 기사 14건이 바둑 탭에 카드
  // 14개로 떴다. 제목 임계값 0.86은 다른 대국이 합쳐지는 것을 막으려 높게
  // 잡혀 있어 이런 표현 차이를 못 잡는다.
  const row = (id, title) => ({
    id, url_key: `k${id}`, url: `https://example.com/${id}`, title,
    source: 'example.com', press: '', category: '바둑',
    published_at: '2026-08-05T02:00:00Z', fetched_at: '2026-08-05T02:00:00Z',
    summary, summary_quality: 'full', image_url: '', saved: 0
  });
  const env = mockEnv([
    row(1, "빙그레, '제3회 부라보콘 전국 어린이 바둑 대회' 개최"),
    row(2, "'제3회 부라보콘 전국 어린이 바둑 대회' 개최...빙그레 후원")
  ]);
  const data = await (await onRequestGet({
    request: new Request('https://example.com/api/news/articles?category=%EB%B0%94%EB%91%91'), env
  })).json();
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].related_count, 1);
});

test('서로 다른 대국 결과는 접지 않는다', async () => {
  // 요약도 서로 달라야 한다. 같은 요약을 주면 제목이 아니라 요약 유사도로
  // 묶여서, 정작 보려던 제목 판정을 검사하지 못한다.
  const row = (id, title, rowSummary) => ({
    id, url_key: `k${id}`, url: `https://example.com/${id}`, title,
    source: 'example.com', press: '', category: '바둑',
    published_at: '2026-08-09T02:00:00Z', fetched_at: '2026-08-09T02:00:00Z',
    summary: rowSummary, summary_quality: 'full', image_url: '', saved: 0
  });
  const env = mockEnv([
    row(1, '부광 시린메드, 영천 3-0 완파하며 4연패 탈출', [
      '1) 부광 시린메드가 영천을 3대 0으로 완파하며 4연패에서 벗어났다.',
      '2) 선봉으로 나선 김채영 9단이 초반부터 주도권을 잡고 상대를 제압했다.',
      '3) 이번 승리로 부광 시린메드는 여자바둑리그 순위를 한 계단 끌어올렸다.'
    ].join('\n')),
    row(2, 'OK 만세보령, 여수 꺾고 3연패 탈출', [
      '1) OK 만세보령이 여수를 꺾고 이어지던 3연패 사슬을 끊어냈다.',
      '2) 주장 대결에 나선 오유진 9단이 끝내기에서 앞서며 팀 승리를 이끌었다.',
      '3) OK 만세보령은 이번 결과로 여자바둑리그 중위권 경쟁에 다시 합류했다.'
    ].join('\n'))
  ]);
  const data = await (await onRequestGet({
    request: new Request('https://example.com/api/news/articles?category=%EB%B0%94%EB%91%91'), env
  })).json();
  assert.equal(data.items.length, 2);
});

test('바둑 탭은 기원 사건처럼 분류가 일반인 바둑 관련 기사도 함께 싣는다', async () => {
  // 일반 탭은 인기순만 쓰므로 인기에 못 든 이런 기사는 어디에도 안 뜬다.
  // 실측 2026-08-10: 노원구 기원 살인 보도 4건이 모두 일반 탭 미노출이었다.
  const env = mockEnv([]);
  await onRequestGet({
    request: new Request('https://example.com/api/news/articles?category=%EB%B0%94%EB%91%91'), env
  });
  assert.match(env.articleSql, /a\.title LIKE '%바둑%'/);
  assert.match(env.articleSql, /a\.title LIKE '%기원%' AND a\.summary LIKE '%바둑%'/);
});

test('바둑 탭에 함께 싣는 일반 기사에도 광고 차단을 적용한다', async () => {
  // 규칙이 제목의 '바둑'만 보므로 게임 광고가 이 경로로 새어 들어올 수 있다.
  // 차단 판정을 item.category가 아니라 보고 있는 탭 기준으로 걸어야 막힌다.
  const row = {
    id: 1, url_key: 'p1', url: 'https://example.com/1',
    title: '넷마블 바둑 설치 다운로드 방법 안내',
    source: 'example.com', press: '', category: '사회',
    published_at: '2026-08-09T02:00:00Z', fetched_at: '2026-08-09T02:00:00Z',
    summary, summary_quality: 'full', image_url: '', saved: 0
  };
  const data = await (await onRequestGet({
    request: new Request('https://example.com/api/news/articles?category=%EB%B0%94%EB%91%91'), env: mockEnv([row])
  })).json();
  assert.equal(data.items.length, 0);
});
