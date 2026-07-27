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
  if (line.length < 18 || line.length > 220) return false;
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
  /(?:진짜\s*관전\s*포인트|오랜\s*격언|제3의\s*언어|인\s*셈이다|주목할\s*만하다|의미가\s*크다)/i,
  /(?:의의가\s*있다|의미를\s*(?:더했다|부여했다)|더\s*빠르게\s*이동하려고\s*발명한\s*기계가\s*자동차)/i,
  /&#(?:x[0-9a-f]+|\d+);/i,
  /(?:가치가?\s*(?:더욱|한층)\s*높|사고방식과\s*(?:잘\s*)?부합)/i,
  /&[a-z][a-z0-9]+;/i,
  /(?:\.{3,}|…$)/
];

export function validateThreeLineSummary(summary, title = '') {
  if (isRejectedTitle(title)) return false;
  const lines = normalizeText(summary).split('\n').map(stripNumbering).filter(Boolean);
  if (lines.length !== 3) return false;
  const titleKey = comparisonKey(title);
  for (const line of lines) {
    if (line.length < 24 || line.length > 190) return false;
    if (POISON_PATTERNS.some(pattern => pattern.test(line)) || isJunkLine(line)) return false;
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
  /(?:\[[^\]]*기자\]|기자\s*[=｜]|특파원\s*[=｜]|ⓒ|사진\s*(?:=|출처)|스틸컷)/u
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
  if (/(?:시세\s*조회로|현명한\s*투자하세요|신청\s*및\s*.*(?:환급|상세)\s*안내|자동차월드)/i.test(title)) return true;
  return /(?:\[?[^\]\n]{0,20}(?:칼럼|사설|기고|시론|논단|오피니언)\]?|퇴근길\s*이슈|뉴스\s*브리핑|뉴스\s*잇\s*\(|뉴스\s*바이트|모닝픽|주요\s*뉴스\s*]|주요뉴스\s*…|미리보는\s*.*신문|증시\s*포커스|증시포커스|뉴스\s*새벽배송|\[\s*뉴스\s*(?:\.{2,}|…)|스포츠용어\s*산책)/i.test(title);
}
