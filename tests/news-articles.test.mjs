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

test('이슈 판정과 건수는 카드가 아니라 관련 보도까지 센다', async () => {
  // 같은 보도자료 여러 건이 카드 하나로 접히면 카드 수는 1이다. 카드로 세면
  // 그 이야기가 '2건 이상' 조건에서 탈락해 기타로 밀려난다. 접기를 넣으면서
  // 생긴 회귀라, 접힌 보도까지 세야 예전 동작이 유지된다.
  const row = (id, title) => ({
    id, url_key: `k${id}`, url: `https://example.com/${id}`, title,
    source: 'example.com', press: '', category: '바둑',
    published_at: '2026-08-05T02:00:00Z', fetched_at: '2026-08-05T02:00:00Z',
    summary, summary_quality: 'full', image_url: '', saved: 0
  });
  const rows = [
    row(1, "빙그레, '제3회 부라보콘 전국 어린이 바둑 대회' 개최"),
    row(2, "'제3회 부라보콘 전국 어린이 바둑 대회' 개최...빙그레 후원")
  ];
  const cached = [{ key: '바둑|ai:0', title: '부라보콘 전국 어린이 바둑대회', url_keys: ['k1', 'k2'] }];
  const data = await (await onRequestGet({
    request: new Request('https://example.com/api/news/articles?category=%EB%B0%94%EB%91%91&issues=1'),
    env: mockEnv(rows, cached)
  })).json();
  assert.equal(data.items.length, 1, '카드는 하나로 접힌다');
  assert.equal(data.items[0].related_count, 1);
  const issue = (data.issues || []).find(g => !String(g.key).endsWith('|ai:misc'));
  assert.ok(issue, '카드가 1장이어도 보도가 2건이면 이슈로 남아야 한다');
  assert.equal(issue.count, 2, '타일 건수도 접힌 보도를 포함한다');
});

test('AI가 같은 이슈로 묶은 기사는 카드도 하나로 접는다', async () => {
  // 제목 표현이 달라 규칙이 못 묶는 것을 AI는 이미 알고 있다. 실측 2026-08-10:
  // 부라보콘 이슈 22건이 카드 4장으로 떴고 3장은 관련 보도 0건인 낱장이었다.
  // 요약도 서로 달라야 한다. 같은 요약을 주면 요약 유사도로 묶여서 정작
  // 보려던 이슈 캐시 경로를 검사하지 못한다.
  const row = (id, title, rowSummary) => ({
    id, url_key: `k${id}`, url: `https://example.com/${id}`, title,
    source: 'example.com', press: '', category: '바둑',
    published_at: '2026-08-05T02:00:00Z', fetched_at: '2026-08-05T02:00:00Z',
    summary: rowSummary, summary_quality: 'full', image_url: '', saved: 0
  });
  const rows = [
    row(1, "빙그레, '제3회 부라보콘 전국 어린이 바둑 대회' 개최", [
      '1) 빙그레가 제3회 부라보콘 전국 어린이 바둑 대회를 연다고 밝혔다.',
      '2) 대회는 전국 다섯 개 권역에서 예선을 치른 뒤 본선을 진행한다.',
      '3) 우승자에게는 국내 어린이 바둑 대회 최고 수준의 상금이 걸렸다.'
    ].join('\n')),
    row(2, '빙그레, 바둑으로 어린이·가족 고객 접점 확대…브랜드 마케팅 강화', [
      '1) 빙그레가 어린이와 가족을 겨냥한 브랜드 마케팅을 넓히고 있다.',
      '2) 회사는 스포츠 후원과 문화 행사로 접점을 만드는 전략을 택했다.',
      '3) 업계는 장기 고객을 확보하려는 시도로 이번 행보를 해석했다.'
    ].join('\n'))
  ];
  // 규칙만으로는 안 묶인다는 것부터 확인한다.
  const noCache = await (await onRequestGet({
    request: new Request('https://example.com/api/news/articles?category=%EB%B0%94%EB%91%91'), env: mockEnv(rows)
  })).json();
  assert.equal(noCache.items.length, 2);
  const cached = [{ key: '바둑|ai:9', title: '부라보콘 전국 어린이 바둑대회', url_keys: ['k1', 'k2'] }];
  const withCache = await (await onRequestGet({
    request: new Request('https://example.com/api/news/articles?category=%EB%B0%94%EB%91%91'), env: mockEnv(rows, cached)
  })).json();
  assert.equal(withCache.items.length, 1, 'AI가 같은 이슈로 본 것은 한 장으로 접힌다');
  assert.equal(withCache.items[0].related_count, 1);
});

test('기타 묶음은 카드로 접지 않는다', async () => {
  // 기타는 서로 무관한 낱개 기사를 모아두는 자리다. 접으면 관계없는 기사가
  // 한 장으로 뭉개진다.
  const row = (id, title, rowSummary) => ({
    id, url_key: `k${id}`, url: `https://example.com/${id}`, title,
    source: 'example.com', press: '', category: '바둑',
    published_at: '2026-08-05T02:00:00Z', fetched_at: '2026-08-05T02:00:00Z',
    summary: rowSummary, summary_quality: 'full', image_url: '', saved: 0
  });
  const rows = [
    row(1, '신진서, 란커배 32강에서 중국 기사 꺾고 16강 진출', [
      '1) 신진서 9단이 란커배 32강에서 중국 기사를 꺾고 16강에 올랐다.',
      '2) 초반 포석에서 앞선 뒤 중반 전투에서 격차를 벌리며 승부를 갈랐다.',
      '3) 한국은 이번 라운드에서 여덟 명 가운데 여섯 명이 승리를 거뒀다.'
    ].join('\n')),
    row(2, '한국기원, 하반기 승단대회 일정 확정 발표', [
      '1) 한국기원이 올해 하반기 승단대회 일정을 확정해 공지했다.',
      '2) 참가 신청은 다음 달 초까지 온라인으로 받는다고 안내했다.',
      '3) 대회는 서울 한국기원 대국실에서 주말마다 순차로 열린다.'
    ].join('\n'))
  ];
  const cached = [{ key: '바둑|ai:misc', title: '기타', url_keys: ['k1', 'k2'] }];
  const data = await (await onRequestGet({
    request: new Request('https://example.com/api/news/articles?category=%EB%B0%94%EB%91%91'), env: mockEnv(rows, cached)
  })).json();
  assert.equal(data.items.length, 2);
});

test('이슈로 묶은 카드의 대표는 이슈 제목에 가장 가까운 기사로 고른다', async () => {
  // 목록 순서상 맨 앞 기사가 대표가 되면 제목과 내용이 어긋난다. 실측
  // 2026-08-10: 신진서-카타고 이슈 103건이 "[제49기 SG배 명인전] 옅은 지점"
  // 이라는 무관한 관전기를 달고 떴다.
  const row = (id, title, rowSummary) => ({
    id, url_key: `k${id}`, url: `https://example.com/${id}`, title,
    source: 'example.com', press: '', category: '바둑',
    published_at: '2026-08-05T02:00:00Z', fetched_at: '2026-08-05T02:00:00Z',
    summary: rowSummary, summary_quality: 'full', image_url: '', saved: 0
  });
  const rows = [
    row(1, '[제49기 SG배 한국일보 명인전] 옅은 지점', [
      '1) 제49기 SG배 명인전 본선 대국에서 신진서 9단이 좌하귀 접전으로 앞섰다.',
      '2) 상대는 두터움을 살리려 했으나 신진서의 삭감이 제때 들어갔다.',
      '3) 종반 끝내기에서 반집을 남긴 신진서 9단이 승부를 가져갔다.'
    ].join('\n')),
    row(2, '신진서, 카타고 꺾고 2승 1패 역전승', [
      '1) 신진서 9단이 인공지능 카타고를 상대로 2승 1패 역전승을 거뒀다.',
      '2) 첫 판을 내준 뒤 남은 두 판에서 승부호흡을 바꿔 흐름을 되찾았다.',
      '3) 대국 뒤 그는 인간 바둑의 승부수가 여전히 매력이라고 말했다.'
    ].join('\n'))
  ];
  const cached = [{ key: '바둑|ai:1', title: '신진서 카타고 AI 격파', url_keys: ['k1', 'k2'] }];
  const data = await (await onRequestGet({
    request: new Request('https://example.com/api/news/articles?category=%EB%B0%94%EB%91%91'), env: mockEnv(rows, cached)
  })).json();
  assert.equal(data.items.length, 1);
  assert.match(data.items[0].title, /카타고/, '이슈 제목에 가까운 기사가 대표가 된다');
  assert.equal(data.items[0].related_count, 1);
  assert.match(data.items[0].related[0].title, /명인전/, '기존 대표는 관련 보도로 내려간다');
});
