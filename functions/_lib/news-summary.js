const NUMBERING = /^\s*(?:\d{1,2}[.)]|[①-⑳]|[-•▪▶])\s*/u;

const HTML_ENTITIES = {
  nbsp: ' ', middot: '·', bull: '•', ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  copy: '©', reg: '®', trade: '™'
};

const CUT_MARKERS = [
  '함께 찾은 검색어', '이 시각 추천뉴스', '많이 본 뉴스', '관련기사',
  '기사 더보기', '해당 언론사로 이동합니다', '뉴시스에서 직접 확인하세요'
];

const JUNK_PATTERNS = [
  /기사\s*제목과\s*주요\s*문장을\s*기반으로.*결과입니다/i,
  /(?:자동\s*요약|요약보기|음성으로\s*듣기|음성재생\s*설정|번역\s*(?:beta|베타)|타임톡)/i,
  /(?:무단전재|재배포\s*금지|저작권자|Copyright|인터넷신문윤리위원회|한국기자협회)/i,
  /(?:제보|문의).*(?:전화|이메일|메일|카카오톡|카톡|jebo)/i,
  /(?:전화|이메일|메일|카카오톡|카톡|jebo).*(?:제보|문의)/i,
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
  /^(?:입력|수정)\s*\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2}/,
  /^\s*(?:사진|자료사진|동영상|광고|ADVERTISEMENT)\s*$/i,
  /(?:구독|좋아요|공감|댓글)\s*(?:버튼|하기|눌러)/i
  ,/(?:^|\s)편집국\s+[A-Z][a-z]+\s+\d{1,2},\s*\d{4}.*완독/i
  ,/완독\s*약?\s*\d+\s*분\s*소요/i
];

// 요약 한 줄의 허용 길이. 후보를 고르는 buildSummary와 저장 직전에 검사하는
// validateThreeLineSummary가 같은 값을 봐야 한다. 예전에는 후보 선정이
// 18~220자, 최종 검사가 24~190자여서 그 사이 길이의 줄을 뽑아 넣은 요약은
// 반드시 검증에서 떨어졌다 - 다음 후보를 써보지도 못하고 기사 하나가
// 통째로 발행 대상에서 빠졌다.
const LINE_MIN_LENGTH = 24;
const LINE_MAX_LENGTH = 190;

export function normalizeText(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&([a-z][a-z0-9]+);/gi, (match, name) => HTML_ENTITIES[name.toLowerCase()] ?? match)
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(parseInt(num, 10)))
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([가-힣])\s+([은는이가을를와과의에도만])(?=\s|[,.;:!?]|$)/gu, '$1$2')
    // 여러 글자 조사도 붙인다. 본문에서 태그를 지울 때 그 자리에 공백이 들어가면
    // "인간 바둑<b>에서도</b>"가 "인간 바둑 에서도"가 된다. 위 한 글자 규칙만
    // 있어서 이런 것이 그대로 화면까지 갔다 - 2026-08-14 실측: 신진서 기사의
    // 3줄 요약 첫 줄이 "그가 인간 바둑 에서도 전대미문의 역사를…"이었고, 원문은
    // "바둑에서도"로 멀쩡히 붙어 있었다. 우리가 만든 흠이다.
    //
    // 여기 넣는 것은 홀로 설 수 없는 조사뿐이다. 낱말로도 쓰이는 말(이·그·도·만)은
    // 위 규칙이 이미 앞뒤 문맥을 보고 처리하므로 건드리지 않는다.
    .replace(/([가-힣])\s+(에서도|에서는|에서만|에서|에게서|에게도|에게|에는|이라고|이라는|라고는|으로서|으로써|으로는|으로도|로서|로써|까지도|까지는|까지|부터는|부터|처럼|만큼|조차|마저)(?=\s|[,.;:!?]|$)/gu, '$1$2')
    .replace(/\s+(['’”])(?=[은는이가을를와과의에도로](?:\s|[.,]))/gu, '$1')
    .replace(/([가-힣])\s+([’”])/gu, '$1$2')
    .replace(/([가-힣]+(?:초등|중|고등))\s+학교/gu, '$1학교')
    .replace(/바둑\s+협회/gu, '바둑협회')
    .replace(/대국\s+료/gu, '대국료')
    .replace(/접\s+바둑/gu, '접바둑')
    .trim();
}

export function stripNumbering(value) {
  return normalizeText(value).replace(NUMBERING, '').trim();
}

function comparisonKey(value) {
  return stripNumbering(value).toLowerCase().replace(/[^0-9a-z가-힣]/g, '');
}

export function isJunkLine(value) {
  const line = stripNumbering(value);
  if (!line || line.length < 8) return true;
  if ((line.match(/#[0-9A-Za-z가-힣_]+/g) || []).length >= 2) return true;
  return JUNK_PATTERNS.some(pattern => pattern.test(line));
}

function isNearDuplicate(a, b) {
  const left = comparisonKey(a);
  const right = comparisonKey(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (Math.min(left.length, right.length) >= 14 && (left.includes(right) || right.includes(left))) return true;
  const leftSet = new Set(left.match(/.{1,2}/g) || []);
  const rightSet = new Set(right.match(/.{1,2}/g) || []);
  let common = 0;
  for (const token of leftSet) if (rightSet.has(token)) common += 1;
  return common / Math.max(leftSet.size, rightSet.size, 1) >= 0.82;
}

function isTitleCopy(line, title) {
  const left = comparisonKey(line);
  const right = comparisonKey(title);
  if (!left || !right) return false;
  if (left === right) return true;
  return Math.abs(left.length - right.length) <= 6 && isNearDuplicate(line, title);
}

function splitCandidates(value) {
  let text = normalizeText(value);
  let cut = text.length;
  for (const marker of CUT_MARKERS) {
    const at = text.indexOf(marker);
    if (at >= 0) cut = Math.min(cut, at);
  }
  text = text.slice(0, cut);
  return text
    .split(/\n+|(?<=[.!?…])\s+(?=["'“‘(]?[0-9A-Za-z가-힣])/u)
    .map(stripNumbering)
    .map(line => line.replace(/^(?:[가-힣]{2,4}\s*)?(?:기자|특파원)\s*[=:·-]?\s*/u, '').trim())
    .filter(Boolean);
}

function cleanCandidate(value) {
  return stripNumbering(value)
    .replace(/\b자동\s*요약\b/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[,;:·|]+|[,;:·|]+$/g, '')
    .trim();
}

function validCandidate(value, title) {
  if (isJunkLine(value)) return false;
  const line = cleanCandidate(value);
  if (line.length < LINE_MIN_LENGTH || line.length > LINE_MAX_LENGTH) return false;
  if (/(?:\.{3,}|…)$/.test(line)) return false;
  if (title && isTitleCopy(line, title)) return false;
  if (/^(?:기자|특파원|앵커)\s*[=:]/.test(line)) return false;
  return true;
}

export function buildSummary({ title = '', rawSummary = '', body = '', maxLines = 3 } = {}) {
  const candidates = [...splitCandidates(rawSummary), ...splitCandidates(body)];
  const lines = [];
  for (const raw of candidates) {
    const line = cleanCandidate(raw);
    if (!validCandidate(line, title)) continue;
    if (lines.some(existing => isNearDuplicate(existing, line))) continue;
    lines.push(line);
    if (lines.length >= maxLines) break;
  }
  return lines.map((line, index) => `${index + 1}) ${line}`).join('\n');
}

export function sanitizeStoredSummary({ title = '', summary = '', body = '' } = {}) {
  const cleaned = buildSummary({ title, rawSummary: summary, body });
  const lineCount = cleaned ? cleaned.split('\n').length : 0;
  return {
    summary: cleaned,
    quality: lineCount >= 3 ? 'full' : lineCount > 0 ? 'short' : 'none',
    lineCount
  };
}

const POISON_PATTERNS = [
  /(?:var\s+\w+|function\s*\(|=>|updateLive|setTimeout|\bconst\s+|\blet\s+)/i,
  /(?:송고\s*\d{4}|입력\s*\d{4}|수정\s*\d{4}|생방송\s*뉴스|FM\s*\d|완독\s*약)/i,
  /(?:텔레그램\s*채널|구독\s*상품|내구독|보관함|하이라이트\/메모|제보로\s*함께)/i,
  /(?:기사의?\s*본문\s*내용|글자\s*크기(?:로)?\s*변경|본문\s*글씨\s*크기|인쇄하기|공유하기)/i,
  /(?:주요\s*뉴스를\s*전해|뉴스를\s*모아|뉴스\s*서비스를\s*제공|놓쳐버린\s*주요\s*뉴스)/i,
  /(?:주요\s*뉴스와\s*현안을\s*정리|오늘의\s*주요\s*뉴스|뉴스\s*브리핑)/i,
  /(?:주요\s*뉴스\s*(?:와|및)?\s*이슈를\s*모아|한\s*주간\s*세계\s*주요\s*뉴스|바쁘고\s*소란스러운\s*나날)/i,
  /(?:【\s*앵커\s*】|\[\s*앵커\s*\]|진행자\s*\))/i,
  /(?:관련기사|추천뉴스|많이\s*본\s*뉴스|함께\s*본\s*뉴스)/i,
  // 댓글창 안내문. 실측 2026-08-10: "[포토뉴스] Sh수협은행, 여자 바둑 최강전
  // 개막"의 3번째 줄이 "답글과 추천수를 합산하여 자동으로 노출됩니다."였다.
  // 본문 추출이 댓글 위젯까지 긁어 와서 AI가 그걸 요약에 넣었다.
  // 좁게 잡는다. 같은 표본 140건에서 '댓글'이 정상적으로 쓰인 기사가 5건 있었다
  // ("피해자가 분노의 댓글을 남겼습니다" 등). 그런 문장은 걸리면 안 된다.
  /(?:답글과\s*추천수|자동으로\s*노출됩니다|댓글\s*정책|운영원칙에\s*따라)/i,
  /(?:진짜\s*관전\s*포인트|오랜\s*격언|제3의\s*언어|인\s*셈이다|주목할\s*만하다|의미가\s*크다)/i,
  /(?:의의가\s*있다|의미를\s*(?:더했다|부여했다)|더\s*빠르게\s*이동하려고\s*발명한\s*기계가\s*자동차)/i,
  /&#(?:x[0-9a-f]+|\d+);/i,
  /(?:가치가?\s*(?:더욱|한층)\s*높|사고방식과\s*(?:잘\s*)?부합)/i,
  /&[a-z][a-z0-9]+;/i,
  /(?:\.{3,}|…$)/
];

// AI가 요약 대신 프롬프트 자체를 화제로 삼은 응답. 구조 검사로는 절대 걸리지
// 않는다 - 세 줄이고, 번호가 붙어 있고, 전부 '~니다'로 끝나고, 길이도 따옴표
// 짝도 맞다. 실제로 아래 응답이 요약으로 저장돼 화면에 노출됐다:
//
//   1) 죄송하지만, 제공하신 원문에는 "..."는 제목의 기사 내용이 포함되어 있지 않습니다.
//   2) 원문은 제목 목록만 있고 해당 기사의 본문이 없어서 요약을 작성할 수 없습니다.
//   3) 기사 본문을 제공해주시면 정확히 3줄로 요약해드리겠습니다.
//
// 판별 기준은 어조다. 기사 요약은 독자에게 말을 걸지 않고("~주시면"),
// 사과하지 않고, 자기가 받은 원문·본문·제목 목록을 화제로 삼지 않는다.
// 뉴스 문장에도 나올 수 있는 '제공된' 같은 표현은 일부러 뺐다 - 2인칭 요청형과
// 짝을 이룬 형태만 잡는다.
const AI_META_PATTERNS = [
  /(?:죄송하지만|죄송합니다|유감스럽지만)/,
  /제공(?:하신|해\s*주신|해\s*주시면|해주시면|해\s*주세요|해주세요)/,
  /(?:알려|말씀해|보내|공유해|첨부해)\s*주(?:시면|세요)/,
  /(?:원문|기사\s*본문|본문|기사\s*내용)(?:에는|이|은|을|가|만)?\s*(?:포함되어\s*있지\s*않|제공되지\s*않|없어서|없습니다)/,
  /요약(?:을|이)?\s*(?:작성할\s*수\s*없|할\s*수\s*없|불가능)/,
  /요약해\s*드리|요약해드리|도와\s*드리겠|도와드리겠/,
  /제목\s*목록/,
  // 기사가 아니라 포털 페이지 장식을 요약한 응답. 2026-08-14 실측: 트럼프 드론
  // 관세 [속보]의 3줄이 통째로 네이버의 섹션 분류 안내문이었다. 본문 추출이
  // 꼬리를 물고 들어오던 것이 원인이고 그쪽(news-extract.js)을 고쳤지만, 화면에
  // 올라가는 마지막 관문에서도 막는다 - 추출이 또 어딘가에서 새더라도 사람이
  // 먼저 보는 일은 없어야 한다.
  /섹션으로\s*분류했습니다|섹션\s*정보는|중복\s*분류할\s*수\s*있|언론사(?:가|의)\s*분류|기사\s*섹션\s*분류/,
  /본문\s*듣기를\s*시작합니다|글자\s*크기\s*(?:변경|조절)|구독\s*(?:버튼을|하기를)|앱을?\s*(?:설치|다운)/
];

// 요약이 그 기사 이야기를 하고 있는지 본다. 위 패턴들은 "이미 본 적 있는
// 쓰레기"만 잡는다 - 처음 보는 종류의 쓰레기(다른 매체의 안내문, 옆 기사 제목
// 묶음, 광고 문구)는 전부 통과한다. 제목의 고유한 낱말이 세 줄 어디에도 없으면
// 그건 이 기사의 요약이 아니다. 이 검사는 모양이 아니라 내용을 보므로, 아직
// 겪지 않은 고장에도 걸린다.
//
// 제목에서 쓸 만한 낱말이 3개 미만이면 판정하지 않는다. 짧은 제목은 요약이
// 정당하게 바꿔 쓸 여지가 커서, 걸었다가는 멀쩡한 요약을 버린다.
export function summaryMentionsTitle(summary, title = '') {
  const words = titleWords(title);
  if (words.length < 3) return true;
  const text = normalizeText(summary).replace(/[^0-9A-Za-z가-힣]+/g, '');
  // 조사가 붙어 제목과 표기가 달라지는 경우가 흔하다("한국은" 대 "한국이").
  // 두 글자 이상 겹치면 같은 낱말로 본다.
  return words.some(word => text.includes(word) || (word.length >= 3 && text.includes(word.slice(0, -1))));
}

// 첫 줄이 앞 문장에 기대는 말로 시작하면 그건 본문에서 떼어 온 조각이지 요약의
// 첫 문장이 아니다. 읽는 사람은 '그가'가 누구인지 알 수 없다. 이 검사는 예전에
// 일반 기사에만 걸려 있었고 바둑 요약은 통째로 건너뛰었다 - 2026-08-14 실측:
// "1) 그가 인간 바둑 에서도 전대미문의 역사를 써 내려가고 있다."(신진서 기사)
const DEPENDENT_FIRST_LINE = /^(?:그(?:가|는|를|에게|와|의)?\s|이(?:로써|에|를|러한)\s|거치며\s|이어\s|이후\s|둘째[,，]\s*|한편\s|그러면서\s|그리고\s|또한\s|아울러\s|현재는\s|당시\s|결국\s)/u;

// 앞말에 붙어야 할 조사가 떨어져 홀로 선 것. 본문에서 조각을 이어 붙이면 이렇게
// 된다("인간 바둑 에서도"). 정상 한국어 문장에서는 나오지 않는다. 낱말로도 쓰일
// 수 있는 조사(이·그·도·만·와)는 일부러 뺐다 - "이 대회", "도 관계자"처럼 멀쩡한
// 문장을 버리게 된다. 홀로 설 수 없는 것만 센다.
const DETACHED_PARTICLE = /(?:^|\s)(?:에서도|에서는|에서|에게서|에게|이라고|이라는|으로서|으로써|로서|로써|까지|부터|처럼|만큼|조차|을|를)(?=\s|$)/u;

export function validateThreeLineSummary(summary, title = '') {
  if (isRejectedTitle(title)) return false;
  const lines = normalizeText(summary).split('\n').map(stripNumbering).filter(Boolean);
  if (lines.length !== 3) return false;
  // 카테고리를 가리지 않는다. 무료 추출 요약은 예산이 떨어진 날에만 쓰이는데,
  // 하필 그 날 품질 검사가 가장 헐거우면 사람이 보는 것은 늘 조각난 요약이다.
  if (DEPENDENT_FIRST_LINE.test(lines[0])) return false;
  if (lines.some(line => DETACHED_PARTICLE.test(line))) return false;
  const titleKey = comparisonKey(title);
  for (const line of lines) {
    if (line.length < LINE_MIN_LENGTH || line.length > LINE_MAX_LENGTH) return false;
    if (POISON_PATTERNS.some(pattern => pattern.test(line)) || isJunkLine(line)) return false;
    if (AI_META_PATTERNS.some(pattern => pattern.test(line))) return false;
    if (titleKey && isTitleCopy(line, title)) return false;
    if (!/(?:다|니다)[.!]?$/u.test(line)) return false;
    for (const [open, close] of [["'", "'"], ['"', '"'], ['(', ')'], ['[', ']'], ['‘', '’'], ['“', '”']]) {
      const left = line.split(open).length - 1;
      const right = open === close ? left : line.split(close).length - 1;
      if (open === close ? left % 2 !== 0 : left !== right) return false;
    }
  }
  return !isNearDuplicate(lines[0], lines[1]) && !isNearDuplicate(lines[0], lines[2]) && !isNearDuplicate(lines[1], lines[2]);
}

const GENERAL_EDITORIAL_TITLE_PATTERNS = [
  /\[(?:여백|전라\s*insight|[^\]]*다이어리)\]/i,
  /(?:뉴욕다이어리|\d+강의\s*시선|가볼\s*만한\s*곳)/i
];
const GENERAL_EDITORIAL_ARTIFACT_PATTERNS = [
  /(?:\[[^\]]*기자\]|기자\s*[=｜]|특파원\s*[=｜]|ⓒ|사진\s*(?:=|출처)|스틸컷)/u,
  /(?:에서\s*열린|회의에서|행사에서).{0,80}(?:발언|기념촬영|포즈|참석)하고\s*(?:있다|있었다)\.?$/u
];
const GENERAL_DEPENDENT_FIRST_LINE = /^(?:\[|거치며\s|이어\s|이후\s|둘째[,，]\s*|한편\s|그러면서\s|그는\s|현재는\s)/u;
const GENERAL_BROKEN_NUMBER_FIRST_LINE = /^\d+(?:[.,]\d+)?%\s*[,，]/u;

function editorialKey(value) {
  return normalizeText(value).replace(/[^0-9A-Za-z가-힣]/g, '').toLowerCase();
}

const TITLE_RELEVANCE_STOPWORDS = new Set([
  '관련', '이번', '오늘', '대한', '통해', '앞두고', '공개', '발표', '논란',
  '정부', '한국', '전국', '부터', '까지', '위한', '있는', '없는', '기록', '완성'
]);

function titleWords(title) {
  return normalizeText(title).replace(/[^0-9A-Za-z가-힣]+/g, ' ').split(/\s+/)
    .filter(word => word.length >= 2 && !TITLE_RELEVANCE_STOPWORDS.has(word));
}

export function reorderGeneralSummary(summary, title = '') {
  const rawLines = normalizeText(summary).split('\n').filter(Boolean);
  if (rawLines.length !== 3) return summary;
  const words = titleWords(title);
  if (!words.length) return summary;
  const plain = rawLines.map(stripNumbering);
  const scores = plain.map(line => words.filter(word => line.includes(word)).length);
  const bestScore = Math.max(...scores);
  const bestIndex = scores.indexOf(bestScore);
  const dependentFirst = /^(?:이후|그러면서|그는|한편|이어|둘째|현재는|사회\s*공헌|첫\s*발제자로|지난\s+\d+일)/u.test(plain[0]);
  if (bestIndex <= 0 || (!dependentFirst && !(scores[0] === 0 && bestScore >= 2))) return summary;
  const reordered = [rawLines[bestIndex], ...rawLines.filter((_, index) => index !== bestIndex)];
  return reordered.map((line, index) => `${index + 1}) ${stripNumbering(line)}`).join('\n');
}

// 화면에 실릴 자격. **한 곳에서만 판정한다.** 예전에는 수집(collect.js)이 이
// 조합을 직접 들고 있었고, 이미 저장된 행을 다시 보는 복구(news-repairs.js)는
// 그보다 헐거운 검사를 썼다. 그래서 기준을 올려도 이미 떠 있는 요약은 옛 기준
// 그대로 남았다 - 사람이 화면에서 보고 말해 줘야만 사라졌다.
//
// 이 함수가 유일한 기준이다. 새로 실을 때와 계속 실어 둘 때가 같은 것을 물으면,
// 기준을 한 번 올리는 것만으로 옛 행까지 자동으로 정리된다.
export function publishableSummary(summary, title, category) {
  return !summaryRejectionReason(summary, title, category);
}

// 왜 떨어졌는지를 이름으로 돌려준다. 통과하면 빈 문자열이다.
//
// "안 나온 건 기록에 남긴다"가 요구사항이고, 그게 없으면 화면이 빌 때마다 사람이
// 기사를 손으로 받아 코드를 태워 봐야 원인을 안다(2026-08-14에 실제로 그랬다).
// 검사를 너무 조인 것과 요약이 진짜 나쁜 것은 대응이 정반대인데, 이 이름 하나가
// 그 둘을 가른다.
export function summaryRejectionReason(summary, title, category) {
  const text = normalizeText(summary || '');
  if (!text) return 'empty';
  const lines = text.split('\n').map(stripNumbering).filter(Boolean);
  if (lines.length !== 3) return `not_three_lines_${lines.length}`;
  if (isRejectedTitle(title)) return 'rejected_title';
  if (DEPENDENT_FIRST_LINE.test(lines[0])) return 'dependent_first_line';
  const detached = lines.find(line => DETACHED_PARTICLE.test(line));
  if (detached) return 'detached_particle';
  if (!validateThreeLineSummary(summary, title)) return 'three_line_checks';
  if (!summaryMentionsTitle(summary, title)) return 'title_not_mentioned';
  if (category !== '바둑' && !validateGeneralEditorialSummary(summary, title)) return 'general_editorial';
  return '';
}

export function validateGeneralEditorialSummary(summary, title = '') {
  const ordered = reorderGeneralSummary(summary, title);
  if (!validateThreeLineSummary(ordered, title)) return false;
  if (GENERAL_EDITORIAL_TITLE_PATTERNS.some(pattern => pattern.test(title))) return false;
  const lines = normalizeText(ordered).split('\n').map(stripNumbering).filter(Boolean);
  if (GENERAL_DEPENDENT_FIRST_LINE.test(lines[0]) || GENERAL_BROKEN_NUMBER_FIRST_LINE.test(lines[0])) return false;
  if (lines.some(line => GENERAL_EDITORIAL_ARTIFACT_PATTERNS.some(pattern => pattern.test(line)))) return false;
  const keys = lines.map(editorialKey);
  for (let left = 0; left < keys.length; left += 1) {
    for (let right = left + 1; right < keys.length; right += 1) {
      const short = keys[left].length <= keys[right].length ? keys[left] : keys[right];
      const long = short === keys[left] ? keys[right] : keys[left];
      if (short.length >= 25 && long.includes(short.slice(0, Math.min(40, short.length)))) return false;
    }
  }
  return true;
}

export function isRejectedTitle(title = '') {
  if (/^(?:카타고|바둑)$/i.test(normalizeText(title))) return true;
  if (/�/.test(title) || (String(title).match(/\?/g) || []).length >= 5) return true;
  // 광고성 제목은 수집 단계(여기)와 조회 단계(articles.js의
  // CONTENT_QUALITY_FILTERS) 양쪽에서 막는다. 수집기를 통과했던 시절의 행이
  // DB에 남아 있어서 읽을 때도 걸러야 하기 때문이다. 여기를 고칠 때는 그쪽도
  // 함께 봐야 한다 - 표현이 서로 달라(정규식 대 SQL LIKE) 자동으로 맞춰지지 않는다.
  if (/(?:시세\s*조회로|현명한\s*투자하세요|신청\s*및\s*.*(?:환급|상세)\s*안내|자동차월드)/i.test(title)) return true;
  return /(?:\[?[^\]\n]{0,20}(?:칼럼|사설|기고|시론|논단|오피니언)\]?|\[(?:건설\s*Pick|패트롤)\]|퇴근길\s*이슈|뉴스\s*브리핑|뉴스\s*잇\s*\(|뉴스\s*바이트|모닝픽|주요\s*뉴스\s*]|주요뉴스\s*…|미리보는\s*.*신문|\d{1,2}월\s*\d{1,2}일\s*['‘]?뉴스\s*9['’]?\s*예고|증시\s*포커스|증시포커스|뉴스\s*새벽배송|\[\s*뉴스\s*(?:\.{2,}|…)|스포츠용어\s*산책)/i.test(title);
}
