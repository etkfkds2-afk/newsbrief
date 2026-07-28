import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSummary, isJunkLine, isRejectedTitle, normalizeText, reorderGeneralSummary, sanitizeStoredSummary, validateGeneralEditorialSummary, validateThreeLineSummary } from '../functions/_lib/news-summary.js';
import { makeBestSummary } from '../functions/_lib/news-ai-summary.js';

test('포털 자동요약 안내와 UI 문장을 제거한다', () => {
  const summary = buildSummary({
    title: '정부가 새 정책을 발표했다',
    rawSummary: '기사 제목과 주요 문장을 기반으로 자동 요약한 결과입니다.\n음성으로 듣기 번역 베타 타임톡',
    body: '정부는 23일 새 정책의 세부 내용을 공개했다. 지원 대상은 다음 달부터 확대된다. 관계 부처는 현장 의견을 추가로 수렴할 계획이다.'
  });
  assert.equal(summary.split('\n').length, 3);
  assert.doesNotMatch(summary, /자동\s*요약|음성으로 듣기|타임톡/);
});

test('여러 소식을 합친 편집 기사와 방송 예고를 제외한다', () => {
  assert.equal(isRejectedTitle('[건설 Pick] GS건설·대방건설·대우건설'), true);
  assert.equal(isRejectedTitle('[패트롤] 익산시-익산시체육회'), true);
  assert.equal(isRejectedTitle("7월 21일 '뉴스 9' 예고"), true);
});

test('제목 복붙과 중복 문장을 요약에 넣지 않는다', () => {
  const summary = buildSummary({
    title: '한국 대표팀이 결승에 진출했다',
    rawSummary: '한국 대표팀이 결승에 진출했다. 한국 대표팀이 결승에 진출했다.',
    body: '대표팀은 준결승에서 두 점 차 승리를 거뒀다. 결승전은 오는 일요일 서울에서 열린다.'
  });
  assert.equal(summary.split('\n').length, 2);
  assert.doesNotMatch(summary, /한국 대표팀이 결승에 진출했다/);
});

test('제목과 주제가 같아도 날짜와 결과가 추가된 사실 문장은 허용한다', () => {
  const summary = '1) 신진서 9단은 21일 열린 최종 대국에서 카타고를 꺾고 2승 1패를 기록했다.\n2) 두 번째 대국에서는 안정적인 운영으로 승리를 거뒀다고 밝혔다.\n3) 마지막 대국은 221수 만에 흑의 승리로 끝났다고 전했다.';
  assert.equal(validateThreeLineSummary(summary, '신진서, 카타고에 2승 1패 역전승'), true);
});

test('짧은 정상 기사는 억지로 세 줄을 만들지 않는다', () => {
  const result = sanitizeStoredSummary({
    title: '지역 축제가 주말에 열린다',
    body: '지역 축제는 토요일 오전 시민공원에서 개막한다.'
  });
  assert.equal(result.lineCount, 1);
  assert.equal(result.quality, 'short');
});

test('연락처·저작권·해시태그 라인을 잡음으로 판정한다', () => {
  assert.equal(isJunkLine('▶ 제보 전화 02-1234-5678'), true);
  assert.equal(isJunkLine('저작권자 © 뉴스 무단전재 및 재배포 금지'), true);
  assert.equal(isJunkLine('#정치 #경제 #오늘의뉴스'), true);
});

test('편집국 메타와 잘린 문장을 요약에서 제외한다', () => {
  const summary = buildSummary({
    title: '아시아 주요 현안',
    rawSummary: '편집국 July 23, 2026 완독 약 5 분 소요\n물류 센터 피격으로 직원들이 부상당했고...\n현지 정부는 피해 현황을 조사하고 있다고 밝혔다.'
  });
  assert.equal(summary, '1) 현지 정부는 피해 현황을 조사하고 있다고 밝혔다.');
});

test('오염되거나 세 줄이 아닌 요약은 저장을 거부한다', () => {
  assert.equal(validateThreeLineSummary('1) 정상적인 첫 문장이다.\n2) 정상적인 둘째 문장이다.\n3) updateLiveOnAirNews()', '제목'), false);
  assert.equal(validateThreeLineSummary('1) 한 줄뿐인 요약 문장으로 저장하면 안 된다.', '제목'), false);
  assert.equal(validateThreeLineSummary('1) 정부는 지원 정책의 세부 기준을 오늘 공개했다.\n2) 지원 대상은 다음 달부터 전국으로 확대될 예정이다.\n3) 관계 부처는 현장 의견을 반영해 후속 대책을 마련한다.', '새 지원 정책 발표'), true);
});

test('해설성 문장과 깨진 따옴표를 거부한다', () => {
  assert.equal(validateThreeLineSummary("1) 이번 행사의 진짜 관전 포인트다.\n2) 바둑판에 제3의 언어가 더해진 셈이다.\n3) 주최사는 프로그램을 제공했다고 밝혔다.", '행사'), false);
  assert.equal(validateThreeLineSummary("1) 협회는 아시아 각국의 현안을 정리했다고 밝혔다.\n2) 한국'엄마와 아빠 대신 보호자를 권고했다.\n3) 교육청은 논란 이후 권고안을 철회했다고 밝혔다.", '교육청 권고'), false);
});

test('뉴스 프로그램 도입부와 묶음형 기사를 거부한다', () => {
  const intro = '1) 한주간 세계 주요 뉴스를 전해드립니다.\n2) 태평양에서 엘니뇨가 발생한 것으로 확인됐습니다.\n3) 기상 이변이 세계 여러 지역에 영향을 미치고 있습니다.';
  assert.equal(validateThreeLineSummary(intro, '이준영의 WE'), false);
  assert.equal(validateThreeLineSummary('1) 오늘의 이슈를 모아 제공합니다.\n2) 여러 소식이 온라인에서 관심을 모았습니다.\n3) 관련 인물들이 입장을 공개했다고 밝혔습니다.', '[퇴근길이슈] 오늘의 소식'), false);
});

test('신문 미리보기와 증시 묶음형 제목을 거부한다', () => {
  const summary = '1) 첫 번째 시장 소식을 구체적인 사실에 따라 전달했다고 밝혔다.\n2) 두 번째 기업 소식을 별개의 사실에 따라 전달했다고 밝혔다.\n3) 세 번째 정치 소식을 또 다른 사실에 따라 전달했다고 밝혔다.';
  assert.equal(validateThreeLineSummary(summary, '[미리보는 이데일리 신문]프로그램 매매 폭증'), false);
  assert.equal(validateThreeLineSummary(summary, '[아주증시포커스] 중국 반도체기업들 IPO 러시'), false);
  assert.equal(validateThreeLineSummary(summary, '뉴욕증시 반등 이끈 반도체주[뉴스 새벽배송]'), false);
  assert.equal(validateThreeLineSummary(summary, '미·이란 충돌에 증시 하락[ 뉴스 ...'), false);
  assert.equal(validateThreeLineSummary(summary, '[스포츠박사 기자의 스포츠용어 산책 1852] 화점'), false);
});

test('기사 글자크기 UI와 광고성 제목을 거부한다', () => {
  const polluted = '1) 카타고는 오픈소스 바둑 인공지능으로 연구와 훈련에 활용된다.\n2) 신진서 9단은 카타고와 세 차례 대국을 진행했다고 밝혔다.\n3) 기사의 본문 내용은 이 글자크기로 변경됩니다.';
  assert.equal(validateThreeLineSummary(polluted, '신진서, 바둑 AI에 역전승'), false);
  assert.equal(validateThreeLineSummary(polluted.replace('기사의 본문 내용은 이 글자크기로 변경됩니다.', '정상적인 경기 결과를 구체적으로 설명했다고 밝혔다.'), '2026 고창 반값여행 신청 및 숙소 환급 상세 안내'), false);
});

test('HTML 숫자 엔티티를 실제 줄바꿈으로 정규화한다', () => {
  assert.equal(normalizeText('첫 문장.&#10;둘째 문장.'), '첫 문장.\n둘째 문장.');
  assert.equal(normalizeText('&amp;lt;설국&amp;gt;'), '<설국>');
  assert.equal(normalizeText('초&middot;중&middot;고등학생'), '초·중·고등학생');
  assert.equal(normalizeText("바둑 협회가 '학생 바둑대회 '가 문성고등 학교에서 열린다."), "바둑협회가 '학생 바둑대회'가 문성고등학교에서 열린다.");
  assert.equal(normalizeText('신진서 는 대국 료를 받고, 접 바둑에 나선다.'), '신진서는 대국료를 받고, 접바둑에 나선다.');
});

test('칼럼·사설·기고는 일반 뉴스 요약에서 제외한다', () => {
  const summary = '1) 신진서 9단은 카타고와 세 차례 공식 대국을 치렀다.\n2) 대국은 접바둑과 시간 항드를 적용해 진행됐다.\n3) 주최 측은 향후 추가 대국을 검토한다고 밝혔다.';
  assert.equal(validateThreeLineSummary(summary, '[윤성민 칼럼] 신진서 對 카타고 기신전에 부쳐'), false);
  assert.equal(validateThreeLineSummary(summary, '[사설] 바둑 인공지능 대국의 과제'), false);
});

test('제목이 주제어 하나인 설명형 페이지는 뉴스에서 제외한다', () => {
  const summary = '1) 신진서 9단은 카타고와 세 차례 대국을 치렀다.\n2) 두 대국자는 서로 다른 제한 시간을 적용받았다.\n3) 신진서 9단은 최종 전적 2승 1패를 기록했다.';
  assert.equal(validateThreeLineSummary(summary, '카타고'), false);
});

test('행사 의미를 덧붙이는 홍보성 문장을 요약으로 인정하지 않는다', () => {
  const summary = '1) 울산 시민바둑대회에 약 400명이 참가했다.\n2) 대회는 연령과 실력에 따라 여러 부문으로 운영됐다.\n3) 주요 관계자들이 참석해 대회의 의미를 더했다.';
  assert.equal(validateThreeLineSummary(summary, '울산 주말 바둑 생활체육 대회 열전'), false);
});

test('Anthropic 요약 fallback은 바둑과 일반 기사에 모두 사용할 수 있다', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({
      content: [{ type: 'text', text: '1) 신진서 9단은 24일 열린 본선 대국에서 승리했다.\n2) 대국은 서울 한국기원에서 제한시간 방식으로 진행됐다.\n3) 주최 측은 다음 대국이 25일 열린다고 밝혔다.' }],
      usage: { input_tokens: 500, output_tokens: 90 }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const body = '신진서 9단은 24일 열린 본선 대국에서 승리했다. 대국은 서울 한국기원에서 제한시간 방식으로 진행됐다. 주최 측은 다음 대국이 25일 열린다고 밝혔다. '.repeat(4);
    const baduk = await makeBestSummary({ ANTHROPIC_API_KEY: 'test-key', NEWSBRIEF_USE_ANTHROPIC: '1' }, { title: '신진서 본선 승리', body, category: '바둑' });
    assert.equal(calls, 1);
    assert.equal(validateThreeLineSummary(baduk, '신진서 본선 승리'), true);
    await makeBestSummary({ ANTHROPIC_API_KEY: 'test-key', NEWSBRIEF_USE_ANTHROPIC: '1' }, { title: '경제 정책 발표', body, category: '경제' });
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('일반 뉴스의 문장 조각과 기자 표기를 거부한다', () => {
  const broken = '1) 50%, 0.73% 상승했고 프랑스 지수도 올랐다.\n2) 시장은 국제 유가 변동을 주시하고 있다고 밝혔다.\n3) 투자자들은 기업 실적 발표를 기다리고 있다고 전했다.';
  const byline = '1) 정부는 신규 지원 정책을 발표했다고 밝혔다.\n2) [서울경제 홍길동 기자] 기업들은 정책을 검토하고 있다고 밝혔다.\n3) 관계 기관은 다음 달 세부안을 마련할 예정이라고 밝혔다.';
  assert.equal(validateGeneralEditorialSummary(broken, '뉴욕증시 혼조 출발'), false);
  assert.equal(validateGeneralEditorialSummary(byline, '정부 신규 지원 정책 발표'), false);
});

test('일반 뉴스의 제목 핵심 문장을 첫 줄로 재정렬한다', () => {
  const btn = '1) 1,600억 원의 제작비를 투입해 고대인도 생활상을 구현했습니다.\n2) 힙불교 열풍으로 부처님에 대한 청년층의 관심이 뜨겁습니다.\n3) 드라마 붓다가 다시 시청자들을 찾아갑니다.';
  const chenle = '1) 이후 2016년 초 SM엔터테인먼트의 캐스팅 제의를 받아 한국으로 건너와 연습생으로 합류했다.\n2) 그룹 NCT 천러가 감각적인 비주얼이 담긴 사진으로 최근 근황을 전했다.\n3) 안경을 착용한 정면 클로즈업을 통해 차분한 일상 모습을 공개했다.';
  assert.match(reorderGeneralSummary(btn, "'힙불교'로 부처님 관심…드라마 붓다 돌아온다"), /^1\) 힙불교/);
  assert.match(reorderGeneralSummary(chenle, '천러, 팬미팅 앞두고 감각적인 비주얼 공개'), /^1\) 그룹 NCT 천러/);
  assert.equal(validateGeneralEditorialSummary(reorderGeneralSummary(chenle, '천러, 팬미팅 앞두고 감각적인 비주얼 공개'), '천러, 팬미팅 앞두고 감각적인 비주얼 공개'), true);
});

test('일반 뉴스의 사진 출처와 스틸컷 문구를 거부한다', () => {
  const photo = '1) 일본 국가대표 선수의 은퇴 후 근황이 알려졌다. [사진출처 = 인스타그램]\n2) 해당 선수는 국제대회에 여러 차례 출전했다고 밝혔다.\n3) 그는 최근 인터뷰에서 새로운 진로를 공개했다고 전했다.';
  const still = '1) 영화 천녀유혼 스틸컷 제작자가 홍콩에서 별세했다.\n2) 고인은 여러 흥행작 제작에 참여했다고 알려졌다.\n3) 영화계 관계자들은 고인의 업적을 기렸다고 밝혔다.';
  assert.equal(validateGeneralEditorialSummary(photo, '일본 국가대표 선수 근황 공개'), false);
  assert.equal(validateGeneralEditorialSummary(still, '홍콩 영화 제작자 별세'), false);
});

test('일반 뉴스의 행사 사진 캡션을 요약으로 거부한다', () => {
  const summary = '1) 이재명 대통령이 청와대에서 열린 국무회의에서 발언하고 있다.\n2) 정부는 임신 중지 제도의 공백을 해소하는 방안을 검토한다고 밝혔다.\n3) 관계 부처는 관련 법률과 의약품 도입 절차를 논의할 예정이라고 밝혔다.';
  assert.equal(validateGeneralEditorialSummary(summary, '임신 중지 제도 공백 해소 기대'), false);
});
