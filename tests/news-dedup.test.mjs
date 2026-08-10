import assert from 'node:assert/strict';
import test from 'node:test';
import { createStoryIndex, isSameStory } from '../functions/_lib/news-dedup.js';

// 아래 제목은 전부 2026-08-10에 운영 DB와 구글 뉴스에서 그대로 가져온 것이다.
// 지어낸 예시로 임계값을 맞추면 실제 보도자료 표현을 못 잡는다.
const 부라보콘 = [
  "빙그레, '제3회 부라보콘 전국 어린이 바둑 대회' 개최",
  "'제3회 부라보콘 전국 어린이 바둑 대회' 개최...빙그레 후원",
  '빙그레, 전국 어린이 바둑 대회 개최... 권역별 예선 운영',
  "빙그레, '부라보콘 전국 어린이 바둑 대회' 개최",
  '빙그레, 어린이 바둑 저변 확대 나서…‘부라보콘 전국 어린이 바둑 대회’ 개최',
  '부라보콘 전국 어린이 바둑대회 3회째, 부산 지역 대회로 화려한 개막'
];

test('같은 보도자료가 매체만 바뀐 것은 같은 이야기로 본다', () => {
  for (let i = 1; i < 부라보콘.length; i += 1) {
    const index = createStoryIndex([부라보콘[0]]);
    assert.ok(index.match(부라보콘[i]) || isSameStory(부라보콘[i - 1], 부라보콘[i]),
      `묶이지 않음: ${부라보콘[i]}`);
  }
});

test('한 실행에 몰려 들어온 같은 보도자료는 첫 건만 남는다', () => {
  const index = createStoryIndex();
  const kept = [];
  for (const title of 부라보콘) {
    if (index.match(title)) continue;
    kept.push(title);
    index.add(title);
  }
  // 표현이 크게 다른 몇 건은 따로 남을 수 있다. 중요한 것은 전부 통과하지 않는 것이다.
  assert.ok(kept.length <= 3, `너무 많이 남음: ${kept.length}건`);
  assert.ok(kept.length >= 1);
});

test('같은 연재 칼럼의 다른 회차는 절대 묶지 않는다', () => {
  // 유사도만 보면 0.580 으로, 실제 중복인 신진서 랭킹 쌍(0.359)보다 높다.
  // 일련번호 가드가 없으면 여기서 진짜 기사가 사라진다.
  assert.equal(isSameStory(
    "[스포츠박사 기자의 스포츠용어 산책 1870] 바둑에서 왜 '에이징 커브(Aging Curve)'라고 말할까",
    "[스포츠박사 기자의 스포츠용어 산책 1869] 바둑에서 왜 '정선(定先)'이라 말할까"
  ), false);
});

test('같은 대회의 다른 경기 결과는 묶지 않는다', () => {
  assert.equal(isSameStory('부광 시린메드, 영천 3-0 완파하며 4연패 탈출', 'OK 만세보령, 여수 꺾고 3연패 탈출'), false);
  assert.equal(isSameStory('후반 지배한 한승주, 최정 꺾고 8강 진출', '신진서 80개월 연속 랭킹 1위, 최정 여자 1위 수성'), false);
  assert.equal(isSameStory('란커배 32강 한국 6승2패 취저우 대첩', '[제31회 LG배 조선일보 기왕전] 11년 만의 재회'), false);
});

test('같은 사건의 후속 보도는 표현이 달라도 묶는다', () => {
  assert.equal(isSameStory('경찰, 바둑 두다 흉기로 지인 살해한 60대 체포', '바둑 두다 흉기로 지인 살해…60대 남성 체포'), true);
  assert.equal(isSameStory(
    '일본 ‘천재 바둑 소녀’ 스미레, 한국 이적 후 첫 여자 랭킹 ‘톱3’ 진입',
    '스미레, 한국 이적 후 첫 여자 랭킹 톱3 진입'
  ), true);
});

test('일련번호 가드는 세 자리 이상에만 걸린다', () => {
  // 두 자리까지 막으면 '60대 남성'처럼 같은 사건인데 숫자 표기만 다른 후속
  // 보도를 전부 놓친다. 3자리 이상(회차·호수)만 다른 기사로 본다.
  assert.equal(isSameStory('빙그레, 전국 어린이 바둑 대회 12회 개최', '빙그레, 전국 어린이 바둑 대회 13회 개최'), true);
  assert.equal(isSameStory('빙그레, 전국 어린이 바둑 대회 120회 개최', '빙그레, 전국 어린이 바둑 대회 130회 개최'), false);
});

test('표현이 많이 다른 같은 사건은 일부러 놓친다', () => {
  // 실측 0.359. 임계값 0.45 아래라 통과시킨다. 이걸 잡으려고 임계값을 내리면
  // 진짜 다른 기사를 묶기 시작하므로, 돈을 조금 더 쓰더라도 놓치는 쪽을 택했다.
  // 놓쳐도 결과는 예전과 같을 뿐이고, 잘못 묶으면 기사가 손해를 본다.
  assert.equal(isSameStory(
    '신진서 80개월 연속 랭킹 1위, 최정 여자 1위 수성',
    '신진서, 80개월째 바둑 랭킹 정상…안성준 5위 도약'
  ), false);
});

test('빈 제목은 어떤 것과도 묶지 않는다', () => {
  assert.equal(isSameStory('', '빙그레, 전국 어린이 바둑 대회 개최'), false);
  assert.equal(createStoryIndex(['빙그레, 전국 어린이 바둑 대회 개최']).match(''), '');
});

test('제목이 공유하는 고유 단어로 같은 사건을 잡는다', async () => {
  const { sharesTitleKeywords } = await import('../functions/_lib/news-dedup.js');
  // 실측 2026-08-10 노원구 기원 살인 보도. 제목 유사도는 0.146~0.375로 서로
  // 멀어 isSameStory가 못 잡지만 지인·살해·60대를 공유한다.
  const a = '[단독] 기원에서 말다툼하다 흉기 휘둘러 지인 살해…60대 남성 체포';
  assert.equal(sharesTitleKeywords(a, '“왜 술 마시고 와” 지적에…기원에서 지인 흉기로 살해'), true);
  assert.equal(sharesTitleKeywords(a, '기원서 바둑 두다 말다툼…지인 살해한 60대 현행범 체포'), true);
  // 다른 사건은 걸리지 않아야 한다.
  assert.equal(sharesTitleKeywords(a, '말다툼 중 엄마 흉기 살해한 10대 아들…범행 직후 한 짓 충격'), false);
  assert.equal(sharesTitleKeywords('부광 시린메드, 영천 3-0 완파하며 4연패 탈출', 'OK 만세보령, 여수 꺾고 3연패 탈출'), false);
});

test('AI가 같은 대회에 다른 이름을 붙인 이슈는 합치고 부문이 다르면 나눈다', async () => {
  const { isSameIssueTitle } = await import('../functions/_lib/news-dedup.js');
  // 실측 2026-08-10 바둑 월간 이슈 타일에서 그대로 가져온 제목이다.
  assert.equal(isSameIssueTitle('Sh수협은행 여자바둑최강전', 'SH수협은행 여자바둑대회'), true);
  assert.equal(isSameIssueTitle('신진서 카타고 AI 격파', '신진서 AI 카타고 대국'), true);
  assert.equal(isSameIssueTitle('조상연 하찬석국수배 영재최강전 우승', '하찬석국수배 영재바둑대회 결승'), true);
  // 부문이 다르면 같은 대회라도 별개다. 이 예외가 없으면 영재부와 어린이부가 뭉개진다.
  assert.equal(isSameIssueTitle('하찬석국수배 어린이 바둑대회', '하찬석국수배 영재바둑대회 결승'), false);
  // 겹치는 것이 '전국바둑대회' 같은 일반 명사뿐이면 근거가 못 된다.
  assert.equal(isSameIssueTitle('부산광역시장배 전국 바둑대회', '영일만 사랑배 전국바둑대회'), false);
  // 인물 이름 하나만 겹치는 것도 마찬가지다.
  assert.equal(isSameIssueTitle('신진서 카타고 AI 격파', '신진서 80개월 연속 랭킹 1위'), false);
  assert.equal(isSameIssueTitle('부라보콘 전국 어린이 바둑대회', '하찬석국수배 어린이 바둑대회'), false);
});
