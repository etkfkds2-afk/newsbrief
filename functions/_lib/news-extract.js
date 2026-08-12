// 기사 페이지에서 본문·이미지·발행시각·카테고리를 뽑아내고, 제목과 언론사명을
// 정리하는 계층. 외부 HTML의 모양에만 의존하고 D1이나 수집 정책은 모른다.
//
// 예전에는 이 전부가 collect.js 안에 있었다. 수집 정책·요약·복구·라우팅이 한
// 파일에 1500줄로 뭉쳐 있어서, 셀렉터 하나를 고치려 해도 관계없는 코드를 계속
// 지나쳐야 했다.
import { normalizeText } from './news-summary.js';
import { isBadukRelevant } from './baduk-relevance.js';
import { isBlockedArticleHost } from './news-blocklist.js';

const NAVER_SECTION_CATEGORIES = {
  '100': '정치', '101': '경제', '102': '사회', '103': '생활/문화',
  '104': '세계'
};

export const DEAD_PAGE = /(?:존재하지\s*않는\s*페이지|요청하신\s*페이지를\s*찾을\s*수\s*없|삭제된\s*기사|기사가\s*존재하지\s*않|page\s*not\s*found|\b404\b)/i;

const BODY_JUNK = /(?:무단전재|재배포\s*금지|저작권자|구독|로그인|회원가입|제보|관련기사|추천뉴스|많이\s*본\s*뉴스|기사제공|기자\s*[A-Z0-9._%+-]+@|기사의?\s*본문\s*내용|글자\s*크기|인쇄하기|공유하기)/i;

export function classify(category, title, body = '') {
  const titleText = String(title || '');
  const bodyText = String(body || '').slice(0, 800);
  if (isBadukRelevant(titleText, bodyText)) return '바둑';
  const rules = [
    ['사회', /(?:폭행|살인|사망|숨진|경찰|검찰|법원|사건|사고|성매매|성범죄|조폭|검거|재판|수사|학교|교사|학생)/],
    ['경제', /(?:증시|주가|금리|환율|기업|투자|금융|부동산|아파트|원유|산업|수출|매출|순이익)/],
    ['정치', /(?:대통령|국회|국회의원|민주당|국민의힘|선거|정당|총리|장관|외교부|정부\s*정책)/],
    ['세계', /(?:미국|중국|일본|러시아|이란|유럽|중동|트럼프|해외|국제사회)/],
    ['생활/문화', /(?:여행|축제|문화|영화|공연|음식|건강|날씨|관광|스포츠)/],
  ];
  return rules.find(([, pattern]) => pattern.test(titleText))?.[0]
    || rules.find(([, pattern]) => pattern.test(bodyText))?.[0]
    || (category === '바둑' ? '기타' : category);
}

export function stripHtml(value) {
  return normalizeText(String(value || '')
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, ' '));
}

export function cleanBody(value) {
  const lines = normalizeText(value).split(/\n+/).map(line => line.trim()).filter(line =>
    line.length >= 12 && !BODY_JUNK.test(line) && !/^\s*(?:사진|영상|그래픽|ADVERTISEMENT)\s*[=:]/i.test(line)
  );
  return lines.join('\n').slice(0, 16000);
}

function findArticleBodies(value, found = []) {
  if (!value || found.length > 30) return found;
  if (Array.isArray(value)) {
    for (const item of value) findArticleBodies(item, found);
  } else if (typeof value === 'object') {
    if (typeof value.articleBody === 'string') found.push(value.articleBody);
    for (const child of Object.values(value)) findArticleBodies(child, found);
  }
  return found;
}

export function cleanTitle(value) {
  return stripHtml(value)
    // 끝에 붙은 " - 언론사" 꼬리표만 떼어낸다. 예전에는 구분자 양옆 공백을
    // 요구하지 않아서 "전북바둑협회-장쑤성 청소년 바둑대회 성료" 같은 제목이
    // 통째로 "전북바둑협회"로 잘려 DB에 저장됐다. 한국어 제목은 공백 없이
    // 하이픈으로 두 주체를 잇는 경우가 흔하고, 언론사 꼬리표는 항상 공백을
    // 사이에 둔다(googleNewsSearch도 같은 " - " 형식을 가정한다).
    .replace(/\s+[-|–—]\s+[^-|–—]{1,30}$/u, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

// 저장된 제목이 원문 제목의 앞부분이 잘린 것인지 판정한다. 비교할 때 공백은
// 무시한다. 검색 API가 준 제목과 원문 og:title은 띄어쓰기가 다른 경우가 흔해서
// ("전북 바둑협회"로 저장된 기사의 원문 제목은 "전북바둑협회-장쑤성 청소년
// 바둑대회 성료"였다) 글자 그대로 비교하면 정작 고쳐야 할 행을 전부 놓친다.
//
// 수집 중 되살리는 경로(collect.js)와 사후 복구(news-repairs.js)가 같은 판정을
// 써야 한다. 한쪽만 공백을 무시하면 같은 기사가 경로에 따라 다르게 처리된다.
export const titleIsTruncationOf = (stored, fresh) => Boolean(fresh)
  && fresh.length > stored.length
  && fresh.replace(/\s+/g, '').startsWith(stored.replace(/\s+/g, ''));

export function titleSimilarity(left, right) {
  const normalize = value => cleanTitle(value).replace(/[^0-9A-Za-z가-힣]/g, '').toLowerCase();
  const a = normalize(left), b = normalize(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const grams = value => {
    const out = new Set();
    for (let index = 0; index < value.length - 1; index += 1) out.add(value.slice(index, index + 2));
    return out;
  };
  const aa = grams(a), bb = grams(b);
  let common = 0;
  for (const gram of aa) if (bb.has(gram)) common += 1;
  return aa.size && bb.size ? (2 * common) / (aa.size + bb.size) : 0;
}

export function pressFromTitle(value) {
  const text = stripHtml(value);
  return cleanPressName(text.match(/\s[-|–—]\s([^\-|–—]{1,30})$/u)?.[1] || '');
}

export function cleanPressName(value) {
  return stripHtml(value)
    .replace(/\s+(?:[-|–—]|·)\s+(?:[^\n]{2,})$/u, '')
    .replace(/\s*(?:대한민국|울산)\s*(?:최초|최고)[^\n]*$/u, '')
    .trim()
    .slice(0, 40);
}

// 타임존이 안 붙은 시각은 전부 한국시간으로 읽는다. 국내 매체가 메타태그에 적는
// 시각에 오프셋이 없으면 그건 한국 벽시계 시각이지 UTC가 아니다.
//
// 예전에는 'YYYY-MM-DD HH:MM(:SS)' 딱 한 표기만 +09:00으로 봤다. 밀리초가 붙거나
// 구분자가 점·슬래시면 이 정규식에 안 걸려 new Date()로 흘러갔고, Workers 런타임의
// 로컬 타임존이 UTC라 한국 시각이 UTC로 해석됐다. 그 결과가 화면에서 정확히 +9시간
// 미래다 - 2026-08-12 실측: 실제 오전 5시 10분 기사가 오후 2시 10분으로 떴고,
// 목록이 발행시각 내림차순이라 그 기사가 하루 종일 맨 위에 박혀 있었다.
//
// 걸러야 할 표기를 하나씩 늘리는 대신 방향을 뒤집었다: 오프셋이 있으면 그대로 믿고,
// 없으면 한국시간으로 본다. 새 매체가 또 다른 표기를 들고 와도 같은 규칙에 걸린다.
const NAIVE_DATETIME = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?:[ T]+(?:(오전|오후)\s*)?(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)$/u;

export function parseDate(value) {
  const text = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  // 점·슬래시로 쓴 날짜도 날짜만 남긴다. 시각을 모르는 값을 타임스탬프로 바꾸면
  // 자정(=한국시간 오전 9시)이라는 없는 시각이 생기고, 화면은 날짜만 보여주면 될
  // 자리에 "오전 9:00"을 적는다. 날짜만 있는 값을 그대로 두는 규칙은 이미
  // 위 한 줄에 있었는데 대시 표기에만 걸려 있었다.
  const dateOnly = text.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/);
  if (dateOnly) {
    const [, year, month, day] = dateOnly;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  const naive = text.match(NAIVE_DATETIME);
  if (naive) {
    const [, year, month, day, meridiem, rawHour, minute, second] = naive;
    let hour = Number(rawHour);
    if (meridiem === '오후' && hour < 12) hour += 12;
    if (meridiem === '오전' && hour === 12) hour = 0;
    const pad = number => String(number).padStart(2, '0');
    if (hour > 23 || Number(minute) > 59) return '';
    const date = new Date(`${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${minute}:${second || '00'}+09:00`);
    return Number.isNaN(date.valueOf()) ? '' : date.toISOString();
  }
  const date = new Date(text);
  return Number.isNaN(date.valueOf()) ? '' : date.toISOString();
}

export function naverSectionCategory(html = '') {
  const sectionId = String(html).match(/\bsectionId\s*:\s*["'](10[0-5])["']/i)?.[1]
    || String(html).match(/["']section[_-]?id["']\s*:\s*["'](10[0-5])["']/i)?.[1]
    || String(html).match(/\bsid1[=:]["']?(10[0-5])/i)?.[1]
    || '';
  return NAVER_SECTION_CATEGORIES[sectionId] || '';
}

export function articleSectionCategory(html = '') {
  const text = String(html || '');
  // Some outlets (e.g. 중앙일보) put their own brand name in article:section
  // ("중앙일보") and the real category in article:section2/3 instead - reading
  // only article:section there always returns the publisher name, which
  // matches no category and silently falls through to whatever category the
  // article was originally searched under. Check every section-like tag and
  // use the first one that actually matches a known category.
  const candidates = [
    text.match(/["']articleSection["']\s*:\s*["']([^"']+)/i)?.[1],
    text.match(/<meta[^>]+(?:property|name)=["']article:section2["'][^>]+content=["']([^"']+)/i)?.[1],
    text.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']article:section2["']/i)?.[1],
    text.match(/<meta[^>]+(?:property|name)=["'](?:article:section|section)["'][^>]+content=["']([^"']+)/i)?.[1],
    text.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:article:section|section)["']/i)?.[1]
  ].filter(Boolean);
  for (const raw of candidates) {
    if (/(?:정치|국회|대통령)/u.test(raw)) return '정치';
    if (/(?:경제|금융|증권|부동산|산업|기업)/u.test(raw)) return '경제';
    if (/(?:사회|지역|교육|사건|법원)/u.test(raw)) return '사회';
    if (/(?:생활|문화|연예|스포츠|건강|여행)/u.test(raw)) return '생활/문화';
    if (/(?:세계|국제|글로벌|해외)/u.test(raw)) return '세계';
  }
  return '';
}

export function articleSource(url, discovery = '', press = '') {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    if (host.endsWith('naver.com')) return 'NAVER';
    if (host.endsWith('daum.net')) return 'DAUM';
    if (host.endsWith('google.com')) return 'GOOGLE';
    return cleanPressName(press) || host;
  } catch { return cleanPressName(press) || discovery || '기타'; }
}

// 본문을 받으러 갈 때 먼저 시도할 주소를 고른다. 호출부는 반드시 이 값이
// 실패하면 원래 url로 한 번 더 받아야 한다(collect.js의 두 번 fetch 패턴).
// 그 폴백이 있기 때문에 여기서 고른 주소가 틀려도 기사를 잃지 않는다.
//
// 1) 네이버 뉴스: 검색 API가 주는 link(n.news.naver.com)가 원문 사이트보다
//    본문 추출이 잘 된다. 원래 collect.js 세 곳에 같은 식이 복붙돼 있었다.
// 2) 네이버 스포츠: sports.naver.com/news?oid=X&aid=Y 형태가 http_404로
//    떨어진다(2026-08-11 실측 4건). 같은 기사가 일반 뉴스 리더
//    n.news.naver.com/mnews/article/X/Y 로도 열리므로 그쪽을 먼저 시도한다.
//    주의: 이 치환은 실제 스포츠 기사로 확인하지 못했다(네이버 스포츠 목록이
//    전부 JS라 확인용 기사 주소를 못 구했다). 실패하면 위 폴백이 원래 주소로
//    되돌아가므로 지금보다 나빠질 수는 없고, 진단의 sports.naver.com http_404
//    건수가 줄어드는지로 판정하면 된다.
export function readableArticleUrl(url, link = '') {
  if (/^https?:\/\/(?:n\.)?news\.naver\.com\//i.test(link)) return link;
  for (const candidate of [link, url]) {
    const sports = String(candidate || '')
      .match(/^https?:\/\/(?:m\.|sports\.)?sports\.(?:news\.)?naver\.com\/[^?]*\?(?=.*\boid=(\d{3})\b)(?=.*\baid=(\d{8,10})\b)/i);
    if (sports) return `https://n.news.naver.com/mnews/article/${sports[1]}/${sports[2]}`;
    const sportsPath = String(candidate || '')
      .match(/^https?:\/\/(?:m\.)?sports\.naver\.com\/[a-z]+\/article\/(\d{3})\/(\d{8,10})/i);
    if (sportsPath) return `https://n.news.naver.com/mnews/article/${sportsPath[1]}/${sportsPath[2]}`;
  }
  return url;
}

export function allowedCandidate(url, discovery) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    // Only the broad keyword-search KAKAO path is restricted to Daum's own
    // news domains, since that query can return arbitrary web results.
    // KAKAO_RESOLVED already matched a specific known headline by title, so
    // it just needs the normal spam/UGC blocklist like every other source.
    if (discovery === 'KAKAO') return host === 'v.daum.net' || host.endsWith('.news.daum.net') || host === 'news.daum.net';
    return !isBlockedArticleHost(host);
  } catch { return false; }
}

export async function fetchArticleText(url) {
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 NewsBrief/Cloudflare' },
      cf: { cacheTtl: 300, cacheEverything: false }
    });
    if (!response.ok) return { body: '', image: '', press: '', publishedAt: '', sectionCategory: '', fetchStatus: `http_${response.status}` };
    const type = response.headers.get('content-type') || '';
    if (!type.includes('text/html')) return { body: '', image: '', press: '', publishedAt: '', sectionCategory: '', fetchStatus: 'non_html' };
    // Some (mostly smaller/regional) Korean outlets serve EUC-KR bytes but
    // send a wrong or missing charset in the HTTP header, which made every
    // regex extraction below silently fail on mojibake. Same detection
    // heuristic already used in popularPage().
    const bytes = await response.arrayBuffer();
    let html = new TextDecoder('utf-8').decode(bytes);
    if (/euc-?kr|ks_c_5601|cp949/i.test(type) || (html.match(/�/g) || []).length >= 3) {
      html = new TextDecoder('euc-kr').decode(bytes);
    }
    html = html.slice(0, 800000);
    if (DEAD_PAGE.test(html.slice(0, 30000))) return { body: '', image: '', press: '', publishedAt: '', sectionCategory: '', fetchStatus: 'dead_page' };
    let image = normalizeText(html.match(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)/i)?.[1]
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image)["']/i)?.[1] || '');
    // baduk.or.kr's og:image is a fixed site-wide placeholder, never the real
    // article photo, so every article ended up with the same thumbnail. Fall
    // back to the first inline image inside the article body instead.
    if (/\/\/(?:www\.)?baduk\.or\.kr\//i.test(image) && /\/images\/common\//i.test(image)) image = '';
    const siteName = cleanPressName(html.match(/<meta[^>]+(?:property|name)=["']og:site_name["'][^>]+content=["']([^"']+)/i)?.[1]
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:site_name["']/i)?.[1] || '');
    const publishedAt = parseDate(
      html.match(/<meta[^>]+(?:property|name)=["'](?:article:published_time|og:article:published_time)["'][^>]+content=["']([^"']+)/i)?.[1]
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:article:published_time|og:article:published_time)["']/i)?.[1]
      || html.match(/["']datePublished["']\s*:\s*["']([^"']+)/i)?.[1]
      || html.match(/data-date-time=["']([^"']+)/i)?.[1]
      // 위 지역지 CMS는 메타태그에 시각을 안 넣고 화면에만 "승인 2026.08.11"로
      // 적는다(2026-08-12 실측 paxetv). 그러면 발행시각이 비어 fetched_at으로
      // 물러서는데, 며칠 지난 기사가 수집일로 찍혀 목록 위쪽에 섞인다.
      // 날짜만이라도 원문 것을 쓰는 편이 낫다. parseDate가 점 구분자와 시각
      // 유무를 모두 읽으므로 붙어 있으면 시각까지 살린다.
      || stripHtml(html).match(/(?:입력|승인|등록)\s*[:：]?\s*(\d{4}[-./]\d{1,2}[-./]\d{1,2}(?:[ T]+\d{1,2}:\d{2}(?::\d{2})?)?)/u)?.[1]
      || ''
    );
    const sectionCategory = naverSectionCategory(html) || articleSectionCategory(html);
    let jsonBody = '';
    for (const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
      try {
        const data = JSON.parse(match[1]);
        for (const found of findArticleBodies(data)) if (found.length > jsonBody.length) jsonBody = found;
      } catch {}
    }
    // Older table-layout sites (common among small/regional outlets) put the
    // body in a <td>, not an <article>/<div>. Yonhap (story-news, syndicated
    // to most outlets via Naver) and schema.org itemprop="articleBody" sites
    // (e.g. mk.co.kr) don't use any of the id/class keywords below, so check
    // for those separately instead of only id/class name matching.
    //
    // section/main이 태그 목록에 없어서, 바로 위 itemprop="articleBody" 폴백이
    // 정작 그것을 쓰는 사이트에서 한 번도 발동하지 못했다. 뉴스핌 실측
    // (2026-08-11): 본문이 <section class="contents" itemprop="articleBody">에
    // 들어 있는데 태그가 안 맞아 selector_miss로 떨어졌다. id/class 이름이
    // 아니라 태그 이름 때문에 놓치는 것이므로 목록을 넓히는 편이 맞다.
    // news-contents는 뉴스핌 바깥 컨테이너 이름이기도 해서 같이 넣는다.
    // article-veiw-body / article-view-content-div 는 국내 지역지 수백 곳이 쓰는
    // 같은 CMS(주소가 articleView.html?idxno=)의 본문 컨테이너다. 오타(veiw)까지
    // 그 CMS의 표준이라 그대로 적는다. 이 하나가 빠져 있어서 지역지 바둑 기사가
    // 통째로 selector_miss로 떨어지고 있었다 - 2026-08-12 실측: 파이낸스투데이
    // (paxetv) 기사가 <article class="article-veiw-body view-page">인데 목록에
    // 없어 본문 0자. 바둑은 지역지 비중이 커서 이 한 줄이 24시간 body_too_short
    // 95건의 상당 부분이다.
    const articleStart = html.search(/<(?:article|div|td|section|main)[^>]+(?:(?:id|class)=["'][^"']*(?:dic_area|article_view|article-body|article-veiw-body|article-view-content|newsct_article|article_body|articleBody|news_body|news-contents|view_cont|newsViewBody|story-news)[^"']*["']|itemprop=["']articleBody["'])[^>]*>/i);
    const article = articleStart >= 0 ? html.slice(articleStart, Math.min(html.length, articleStart + 180000)) : '';
    if (!image) {
      const bodyImageSrc = article.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1] || '';
      if (bodyImageSrc) {
        try { image = new URL(bodyImageSrc, url).toString(); } catch {}
      }
    }
    const body = cleanBody(jsonBody || stripHtml(article
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')));
    return {
      body, image: /^https?:\/\//.test(image) ? image : '', press: siteName, publishedAt, sectionCategory,
      fetchStatus: body.length >= 180 ? 'ok' : 'selector_miss'
    };
  } catch (error) {
    // Every return path here must share the same shape - a caller reading
    // article.sectionCategory with no fallback (the exists/republish path)
    // sent a bare `undefined` into a D1 bind and crashed the whole run.
    return {
      body: '', image: '', press: '', publishedAt: '', sectionCategory: '',
      fetchStatus: `error_${String(error?.name || 'unknown')}:${String(error?.message || '').slice(0, 80)}`
    };
  }
}
