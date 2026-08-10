// 같은 사건을 다룬 보도자료가 매체만 바꿔 10건 넘게 들어오는 것을 수집 단계에서
// 알아보기 위한 판정. 화면에서 이슈로 묶는 일(news-issue-classify.js)과는 목적이
// 다르다. 저쪽은 AI로 "무엇에 관한 이슈인가"를 이름 붙이는 일이고, 여기는 유료
// 요약을 한 번만 쓰기 위해 "이미 본 이야기인가"만 보는 무료 판정이다.
//
// 실측 근거(2026-08-10, 바둑 DB 25건 + 놓쳤던 실제 기사 6건):
// 빙그레 부라보콘 보도자료가 14건 들어와 전부 유료 요약을 받았다. 한 건당 유료
// 호출 3회이므로 이 한 건의 이야기에 약 $0.16, 월 예산 $4.75의 3%를 썼다.
import { cleanTitle, titleSimilarity } from './news-extract.js';

// 문자 bigram Dice. 0.45는 실측으로 잡았다. 이 값 아래로 내리면 아래 SERIAL
// 가드를 통과하는 다른 연재물까지 묶이기 시작한다.
export const SAME_STORY_THRESHOLD = 0.45;

// 제목 앞머리의 [코너명]·【】·<> 는 연재 칼럼 표지다. 같은 코너의 다른 회차는
// 이 표지 때문에 유사도가 크게 부풀려진다. 실측: "[스포츠박사 기자의 스포츠용어
// 산책 1870] 바둑에서 왜 '에이징 커브'라고 말할까" 와 1869회 '정선(定先)' 편이
// 0.580 으로, 실제로 같은 기사인 신진서 랭킹 쌍(0.359)보다 높게 나왔다.
function stripSeriesTag(value) {
  return String(value || '').replace(/^\s*(?:\[[^\]]*\]|【[^】]*】|<[^>]*>)\s*/u, '').trim();
}

// 3자리 이상 숫자는 회차·호수처럼 그 기사만 가리키는 일련번호일 때가 많다.
// 양쪽에 있는데 겹치는 값이 하나도 없으면 다른 회차로 본다. 2자리 이하는 제외한다
// ('80개월 연속 1위' 와 '80개월째 …5위 도약' 처럼, 같은 사건인데 숫자만 다른
// 제목이 흔해서 여기까지 막으면 진짜 중복을 놓친다.)
function serialNumbers(value) {
  return new Set(String(value || '').match(/\d{3,}/gu) || []);
}

function hasSerialConflict(left, right) {
  const a = serialNumbers(left), b = serialNumbers(right);
  if (!a.size || !b.size) return false;
  for (const value of a) if (b.has(value)) return false;
  return true;
}

// 같은 이야기인지 판정한다. 놓치는 쪽(중복을 새 기사로 보는 것)은 예전과 같은
// 동작이라 손해가 없지만, 잘못 묶으면 진짜 기사가 유료 요약을 못 받고 사라진다.
// 그래서 애매하면 false 로 기운다.
export function isSameStory(left, right, threshold = SAME_STORY_THRESHOLD) {
  const a = cleanTitle(left), b = cleanTitle(right);
  if (!a || !b) return false;
  if (hasSerialConflict(a, b)) return false;
  if (titleSimilarity(a, b) < threshold) return false;
  // 표지를 떼고도 닮아야 한다. 같은 코너의 다른 회차는 여기서 걸린다.
  return titleSimilarity(stripSeriesTag(a), stripSeriesTag(b)) >= threshold;
}

// 이미 본 이야기들을 담아두고 새 제목이 그중 하나와 같은지 물어보는 그릇.
// 한 실행 안에서 새로 처리한 기사도 계속 넣기 때문에, 같은 실행에 10건이
// 몰려 들어와도 첫 건만 유료 요약을 받는다.
export function createStoryIndex(titles = []) {
  const known = [];
  const add = title => {
    const clean = cleanTitle(title);
    if (clean) known.push(clean);
  };
  // 같은 이야기가 이미 있으면 그 제목을, 없으면 '' 를 준다.
  const match = (title, threshold = SAME_STORY_THRESHOLD) => {
    const clean = cleanTitle(title);
    if (!clean) return '';
    return known.find(seen => isSameStory(seen, clean, threshold)) || '';
  };
  for (const title of titles) add(title);
  return { add, match };
}

// 제목이 공유하는 고유 단어 수로 보는 판정. 위 문자 유사도가 놓치는 경우를
// 잡는다. 실측 2026-08-10 노원구 기원 살인 보도 3건은 제목 유사도가
// 0.146~0.375로 서로 멀지만("[단독] 기원에서 말다툼하다 흉기 휘둘러 지인
// 살해…60대 남성 체포" 대 "기원서 바둑 두다 말다툼…지인 살해한 60대 현행범
// 체포") 지인·살해·60대 같은 단어를 공유한다.
//
// 바둑 기사에는 쓰지 않는다. 제목마다 기사 이름과 대회 이름이 반복돼 서로 다른
// 대국이 쉽게 3개를 넘긴다. 호출부(articles.js)가 분류로 갈라 준다.
const TITLE_STOPWORDS = new Set([
  '오늘', '이번', '관련', '전국', '한국', '속보', '단독', '종합', '현장', '인터뷰',
  '뉴스', '기자', '사진', '영상', '오전', '오후', '올해', '지난', '최초', '국내',
  '우리', '대한', '이날', '이후', '이상', '대해', '통해', '위해'
]);

export function titleKeywords(value) {
  return [...new Set(String(cleanTitle(value)).match(/[0-9A-Za-z가-힣]{2,}/gu) || [])]
    .filter(word => !TITLE_STOPWORDS.has(word) && !/^\d+$/.test(word));
}

// 3개는 실측으로 잡았다. 일반 209건에 걸었을 때 10건이 묶였고 전부 같은
// 사건이었다(전당대회 경선, 호르무즈 합의, 태풍 돌핀, 기원 살인 3건,
// 전남도서관, 구글 AI 개편, 식품업계 소식, 덴마크 징병제). 4개로 올리면
// 안전하지만 기원 살인 3건이 2장으로 갈린다.
export function sharesTitleKeywords(left, right, minimum = 3) {
  const a = new Set(titleKeywords(left));
  if (!a.size) return false;
  return titleKeywords(right).filter(word => a.has(word)).length >= minimum;
}

// ── 미리 계산해 두고 쓰는 경로 ────────────────────────────────────────────
// 카드 묶기는 기사 쌍마다 판정을 부른다. 150장이면 비교가 1만 번을 넘는데,
// 그때마다 제목을 정규식으로 쪼개고 bigram 집합을 새로 만들면 Cloudflare
// Worker의 CPU 한도에 걸려 월간 화면이 통째로 죽는다(2026-08-10 실측).
// 기사당 한 번만 계산해 두고 집합끼리 비교한다. 판정 결과는 위 문자열 경로와
// 같아야 하므로 같은 가드를 그대로 쓴다.
function bigramSet(value) {
  const out = new Set();
  for (let index = 0; index + 1 < value.length; index += 1) out.add(value.slice(index, index + 2));
  return out;
}

function diceOfSets(left, right) {
  if (!left.size || !right.size) return 0;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  let common = 0;
  for (const gram of small) if (large.has(gram)) common += 1;
  return (2 * common) / (left.size + right.size);
}

function normalizeForGrams(value) {
  return cleanTitle(value).replace(/[^0-9A-Za-z가-힣]/g, '').toLowerCase();
}

// 기사 하나의 제목에서 판정에 필요한 것을 모두 뽑아 둔다.
export function storyFingerprint(title) {
  const clean = cleanTitle(title);
  const whole = normalizeForGrams(clean);
  const tail = normalizeForGrams(stripSeriesTag(clean));
  return {
    empty: !clean,
    whole,
    tail,
    grams: bigramSet(whole),
    tailGrams: bigramSet(tail),
    serials: serialNumbers(clean),
    keywords: new Set(titleKeywords(clean))
  };
}

// titleSimilarity는 정규화한 두 문자열이 같으면 bigram을 세지 않고 1을 준다.
// 한 글자 제목처럼 bigram이 아예 없는 경우가 있어서, 그 지름길까지 그대로
// 옮겨야 문자열 경로와 판정이 어긋나지 않는다.
function score(leftText, rightText, leftGrams, rightGrams) {
  if (!leftText || !rightText) return 0;
  if (leftText === rightText) return 1;
  return diceOfSets(leftGrams, rightGrams);
}

export function isSameStoryPrepared(left, right, threshold = SAME_STORY_THRESHOLD) {
  if (!left || !right || left.empty || right.empty) return false;
  if (left.serials.size && right.serials.size) {
    let shares = false;
    for (const value of left.serials) if (right.serials.has(value)) { shares = true; break; }
    if (!shares) return false;
  }
  if (score(left.whole, right.whole, left.grams, right.grams) < threshold) return false;
  return score(left.tail, right.tail, left.tailGrams, right.tailGrams) >= threshold;
}

export function sharesKeywordsPrepared(left, right, minimum = 3) {
  if (!left?.keywords.size || !right?.keywords.size) return false;
  const [small, large] = left.keywords.size <= right.keywords.size
    ? [left.keywords, right.keywords] : [right.keywords, left.keywords];
  let shared = 0;
  for (const word of small) {
    if (large.has(word) && (shared += 1) >= minimum) return true;
  }
  return false;
}
