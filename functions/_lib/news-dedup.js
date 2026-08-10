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
