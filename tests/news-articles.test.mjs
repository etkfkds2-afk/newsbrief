import test from 'node:test';
import assert from 'node:assert/strict';
import { issueCandidateLimit, onRequestGet } from '../functions/api/news/articles.js';

const summary = [
  '1) 신진서 9단은 인공지능 카타고와의 대국에서 최종 승리를 거뒀다.',
  '2) 신진서는 첫 대국 패배 뒤 경기 방식을 분석해 두 번째 대국에서 승리했다.',
  '3) 마지막 대국에서도 안정적인 운영을 이어가며 최종 전적 2승 1패를 기록했다.'
].join('\n');

function mockEnv(rows) {
  let articleSql = '';
  return {
    get articleSql() { return articleSql; },
    DB: {
      batch: async () => [],
      prepare(sql) {
        if (sql.includes('SELECT a.id')) articleSql = sql;
        return {
          bind() { return this; },
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

test('도메인 출처는 사람이 읽는 언론사명으로 변환한다', async () => {
  const row = { id: 3, url_key: 'c', url: 'https://www.yna.co.kr/view/AKR1', title: '정부는 오늘 새로운 산업 지원 대책을 공식 발표했다', source: 'yna.co.kr', press: '', category: '경제', published_at: '2026-07-23T01:00:00Z', fetched_at: '2026-07-23T01:00:00Z', summary, summary_quality: 'full', image_url: '', saved: 0 };
  const env = mockEnv([row]);
  const response = await onRequestGet({ request: new Request('https://example.com/api/news/articles'), env });
  const data = await response.json();
  assert.equal(data.items[0].outlet, '연합뉴스');
});
