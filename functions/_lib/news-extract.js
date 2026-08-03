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

export function parseDate(value) {
  const text = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(text)
    ? `${text.replace(' ', 'T')}+09:00`
    : text;
  const date = new Date(normalized);
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
    const articleStart = html.search(/<(?:article|div|td)[^>]+(?:(?:id|class)=["'][^"']*(?:dic_area|article_view|article-body|newsct_article|article_body|articleBody|news_body|view_cont|newsViewBody|story-news)[^"']*["']|itemprop=["']articleBody["'])[^>]*>/i);
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
