// 2026-08-14에 실제로 서비스를 멈춘 고장들을 각각 재현해 둔다.
//
// 그날 테스트 191개가 전부 통과하는 동안 화면에는 24시간 바둑 0건, 일반에는
// 포털 안내문이 요약이라고 떠 있었고, 카드를 누르면 404가 났다. 테스트가
// "소스에 이 문자열이 있나"만 보고 있었기 때문이다.
//
// 아래는 전부 결과를 본다. 이 파일이 통과하는 한 그날의 고장은 다시 안 난다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { numbersGrounded } from '../functions/_lib/news-ai-summary.js';
import { publishableSummary, summaryRejectionReason, normalizeText } from '../functions/_lib/news-summary.js';
import { canonicalUrl } from '../functions/_lib/news-db.js';
import { fetchArticleText, parseDate } from '../functions/_lib/news-extract.js';

// ── 고장 1: 요약의 줄 번호를 기사 숫자로 셌다 ───────────────────────────────
// 이게 바둑 0건의 최종 원인이다. AI 요약은 정확했는데 "1) 2) 3)"의 2와 3이
// 원문에 없는 숫자로 판정돼 통째로 버려졌다. 짧은 기사일수록 잘 걸린다.
test('요약의 줄 번호는 기사 숫자로 세지 않는다', () => {
  const source = '지난 11일 열린 제6기 최고기사 결정전에서 우승한 신진서 9단. '
    + '14일 한국기원에 따르면 신진서는 8월 한국 바둑랭킹에서 1위를 차지했다. 80개월 연속이다.';
  const summary = '1) 신진서 9단이 8월 한국 바둑랭킹에서 1위를 차지하며 80개월 연속으로 정상을 지켰다.\n'
    + '2) 한국기원이 14일 이를 밝혔다.\n'
    + '3) 제6기 최고기사 결정전 시상식은 11일 열렸다.';
  assert.equal(numbersGrounded(summary, source), true,
    '원문에 2와 3이 없어도 줄 번호 때문에 탈락하면 안 된다');
});

test('원문에 없는 숫자를 지어내면 여전히 걸러낸다', () => {
  const source = '한국기원은 14일 8월 바둑랭킹을 발표했다.';
  const summary = '1) 한국기원이 14일 8월 랭킹을 발표했다.\n'
    + '2) 상금은 7000만원으로 정해졌다.\n'
    + '3) 참가자는 32명이다.';
  assert.equal(numbersGrounded(summary, source), false,
    '숫자 검증 자체는 살아 있어야 한다');
});

// ── 고장 2: 본문 끝을 안 봐서 남의 기사 제목까지 요약했다 ────────────────────
test('본문은 컨테이너가 닫히는 자리에서 끊는다', async () => {
  const originalFetch = globalThis.fetch;
  try {
    const html = `<html><body>
      <div id="dic_area">${'실제 기사 본문 문장이다. '.repeat(12)}</div>
      <div class="media_end_categorize">
        이 기사는 언론사에서 세계 섹션으로 분류했습니다.
        기사의 섹션 정보는 해당 언론사의 분류를 따르고 있습니다.
      </div>
      <ul class="related"><li>北 무인기 침투 알리는 軍 전파체계, 3시간 먹통이었다고 한다</li>
      <li>클릭보다 칩 CXMT, 텐센트 제치고 중화권 시총 1위에 올랐다고 한다</li></ul>
      </body></html>`;
    globalThis.fetch = async () => new Response(html, {
      status: 200, headers: { 'content-type': 'text/html' }
    });
    const article = await fetchArticleText('https://n.news.naver.com/mnews/article/1/2');
    assert.match(article.body, /실제 기사 본문/);
    assert.doesNotMatch(article.body, /섹션으로 분류했습니다/,
      '본문 뒤 페이지 안내문이 요약 재료로 들어가면 안 된다');
    assert.doesNotMatch(article.body, /무인기 침투/,
      '다른 기사 제목이 요약 재료로 들어가면 안 된다');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('포털 안내문을 요약한 것은 화면에 올리지 않는다', () => {
  const title = '[속보] 트럼프, 드론·드론부품에 최대 100% 관세…한국은 15%';
  const junk = '1) 이 기사는 언론사에서 세계 섹션으로 분류했습니다.\n'
    + '2) 기사의 섹션 정보는 해당 언론사의 분류를 따르고 있습니다.\n'
    + '3) 언론사는 개별 기사를 2개 이상 섹션으로 중복 분류할 수 있습니다.';
  assert.equal(publishableSummary(junk, title, '세계'), false);
});

test('제목과 아무 상관 없는 요약은 카테고리를 가리지 않고 막는다', () => {
  // 아직 겪지 않은 종류의 쓰레기도 걸려야 한다. 모양이 아니라 내용을 본다.
  const title = 'GS칼텍스배 프로기전 신민준 우승…상금 7000만원';
  const unrelated = '1) 서울 강남구에서 열린 교육 박람회에 참가 기업이 대거 몰렸다고 주최 측이 밝혔다.\n'
    + '2) 행사는 사흘 동안 코엑스 전시장에서 진행됐다고 주최 측은 설명했다.\n'
    + '3) 관람객 수는 지난해 같은 행사보다 크게 늘어난 것으로 집계됐다.';
  assert.equal(summaryRejectionReason(unrelated, title, '바둑'), 'title_not_mentioned');
});

// ── 고장 3: 앞 문장 없이 대명사로 시작하는 조각 요약 ─────────────────────────
test('앞 문장에 기대는 첫 줄은 거부한다', () => {
  const title = 'AI도 人도, 대체 누가 이기나…신진서, 80개월째 바둑 왕좌';
  const fragment = '1) 그가 인간 바둑에서도 전대미문의 역사를 써 내려가고 있다.\n'
    + '2) 14일 한국기원에 따르면 신진서는 8월 한국 바둑랭킹에서 1위를 차지했다.\n'
    + '3) 이로써 80개월 연속 정상의 자리를 지켰다.';
  assert.equal(summaryRejectionReason(fragment, title, '바둑'), 'dependent_first_line');
});

test('지시어처럼 보이는 멀쩡한 첫 줄은 버리지 않는다', () => {
  // 검사를 조이면 AI가 써준 정상 요약까지 버린다 - 2026-08-14에 실제로 그랬고
  // 그날 바둑 화면이 0건이 됐다. '그 대회', '그 결과'는 대명사가 아니다.
  const title = 'GS칼텍스배 프로기전 신민준 우승…상금 7000만원';
  for (const first of ['그 대회는 나흘 동안 서울에서 열렸다고 주최 측이 밝혔다.',
    '그 결과 신민준 9단이 우승 상금을 받게 됐다고 한국기원이 전했다.']) {
    const summary = `1) ${first}\n`
      + '2) 신민준 9단은 결승에서 상대를 꺾고 우승했다고 한국기원이 밝혔다.\n'
      + '3) 우승 상금은 7000만원으로 정해졌다고 대회 측이 설명했다.';
    assert.equal(summaryRejectionReason(summary, title, '바둑'), '',
      `"${first}"는 버리면 안 된다`);
  }
});

test('떨어져 나온 조사는 버리지 않고 다시 붙인다', () => {
  // 공백은 원문이 아니라 우리가 만든 흠이다(태그를 지운 자리에 공백이 들어간다).
  // 버리는 것보다 고치는 편이 맞다.
  assert.equal(normalizeText('인간 바둑 에서도 역사를 썼다.'), '인간 바둑에서도 역사를 썼다.');
  assert.equal(normalizeText('서울 에서 열린 대회다.'), '서울에서 열린 대회다.');
  // 낱말로도 쓰이는 말은 건드리면 안 된다.
  assert.equal(normalizeText('이 대회는 처음이다.'), '이 대회는 처음이다.');
  assert.equal(normalizeText('도 관계자가 말했다.'), '도 관계자가 말했다.');
  assert.equal(normalizeText('만 5세 아동이다.'), '만 5세 아동이다.');
});

// ── 고장 4: 카드를 누르면 열리지 않는 주소를 만들었다 ────────────────────────
test('네이버 스포츠 주소는 열리는 형태로 저장한다', () => {
  // sports.naver.com/<섹션>/article/<OID>/<AID>는 브라우저에서 404다.
  // canonicalUrl이 m.을 떼면서 그 형태를 만들고 있었다.
  const expected = 'https://n.news.naver.com/mnews/article/079/0004178768';
  assert.equal(canonicalUrl('https://m.sports.naver.com/general/article/079/0004178768'), expected);
  assert.equal(canonicalUrl('https://sports.naver.com/general/article/079/0004178768'), expected);
  assert.equal(canonicalUrl('https://n.news.naver.com/mnews/article/079/0004178768'), expected);
});

// ── 고장 5(2026-08-12): 시각을 UTC로 읽어 +9시간 미래가 됐다 ─────────────────
test('타임존이 없는 시각은 한국시간으로 읽는다', () => {
  assert.equal(parseDate('2026-08-12 05:10:00'), '2026-08-11T20:10:00.000Z');
  assert.equal(parseDate('2026.08.12 오후 02:10'), '2026-08-12T05:10:00.000Z');
  // 오프셋이 붙어 있으면 그것을 믿는다.
  assert.equal(parseDate('2026-08-12T05:10:00Z'), '2026-08-12T05:10:00.000Z');
});
