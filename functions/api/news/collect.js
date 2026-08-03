import {
  isRejectedTitle, normalizeText, reorderGeneralSummary, validateGeneralEditorialSummary, validateThreeLineSummary
} from '../../_lib/news-summary.js';
import { makeBestSummary } from '../../_lib/news-ai-summary.js';
import {
  canonicalUrl, ensureNewsDb, isCollectorAuthorized, json, sha256
} from '../../_lib/news-db.js';
import {
  blockCloudflareForToday, canUseClaude, recordClaudeUsage, reserveCloudflareCall
} from '../../_lib/news-ai-budget.js';
import { isBadukRelevant } from '../../_lib/baduk-relevance.js';
export { isBadukRelevant } from '../../_lib/baduk-relevance.js';

const SEARCHES = [
  ['바둑', '바둑 대회 프로기사'],
  ['정치', '정치'], ['경제', '경제'], ['사회', '사회'],
  ['생활/문화', '생활 문화'], ['세계', '국제']
];

const BADUK_SEARCHES = [
  '바둑', 'baduk', '바둑 대회', '바둑 행사', '바둑 축제', '전국 바둑대회',
  '한국기원 대회', '대한바둑협회 바둑대회', '아마 바둑대회', '아마추어 바둑대회',
  '어린이 바둑대회', '전국 어린이 바둑대회', '초등 바둑대회', '학생 바둑대회',
  '청소년 바둑대회', '유소년 바둑대회', '꿈나무 바둑대회', '학교 바둑대회',
  '지역 바둑대회', '시니어 아마 바둑대회', '생활체육 바둑대회', '바둑 참가자 모집',
  '바둑교실 대회', '바둑문화 행사', '시도 바둑협회 대회', '전국체전 바둑',
  '소년체전 바둑', '바둑 신진서', '프로바둑 대회', '바둑리그', '여자바둑리그',
  '시니어바둑리그', '바둑 기전', '세계 바둑대회', '신진서 대국', '최정 바둑'
];

const GENERIC_TITLES = new Set(['이 시각 주요 뉴스', '오늘의 주요 뉴스', '주요 뉴스', '뉴스 브리핑']);
const DAILY_ANTHROPIC_CALL_LIMIT = 60;
// A boost adds 24 calls to the normal allowance. Keeping this below the
// normal limit made the old "boost" disable Claude once 24 calls were used.
const GENERAL_BOOST_ANTHROPIC_CALL_LIMIT = DAILY_ANTHROPIC_CALL_LIMIT + 24;
const BACKFILL_ANTHROPIC_CALL_LIMIT = 200;
const ESTIMATED_SUMMARY_CALL_MICRO_USD = 15_000;
// Popular pages frequently contain blocked/short-body articles. Process more
// than the ten-card home target so those failures do not collapse the feed.
const SCHEDULED_GENERAL_CANDIDATES = 12;
const SCHEDULED_BADUK_CANDIDATES = 20;
// Every discovery resolved here competes for the fixed 20-slot baduk batch
// against official.baduk.or.kr + search results, which alone usually already
// fill it. Resolving 20 discoveries (up to 2 subrequests each) was spending
// the run's Cloudflare subrequest budget on candidates the 20-slot cap then
// discarded anyway, leaving nothing left to actually fetch article bodies
// for the batch that got selected - every scheduled run was publishing 0
// new baduk/general articles with "body_too_short" that was really
// "Too many subrequests by single Worker invocation".
const SCHEDULED_GOOGLE_DISCOVERIES = 6;
const DAILY_CATEGORY_PUBLISH_LIMIT = 12;
const MAINTENANCE_BATCH_SIZE = 40;
const POPULARITY_REPAIR_BATCH_SIZE = 4;

const BODY_JUNK = /(?:무단전재|재배포\s*금지|저작권자|구독|로그인|회원가입|제보|관련기사|추천뉴스|많이\s*본\s*뉴스|기사제공|기자\s*[A-Z0-9._%+-]+@|기사의?\s*본문\s*내용|글자\s*크기|인쇄하기|공유하기)/i;
const DEAD_PAGE = /(?:존재하지\s*않는\s*페이지|요청하신\s*페이지를\s*찾을\s*수\s*없|삭제된\s*기사|기사가\s*존재하지\s*않|page\s*not\s*found|\b404\b)/i;
const LOCAL_GENERAL_PRESS = /(?:충청|대전|세종|청주|충북|충남|전북|전남|경북|경남|강원|제주|부산|울산|경기|인천).*(?:뉴스|일보|신문|투데이)|(?:중부|제주|경인|영남|호남)(?:매일|일보|신문)/i;

function validPublishedSummary(summary, title, category) {
  return validateThreeLineSummary(summary, title)
    && (category === '바둑' || validateGeneralEditorialSummary(summary, title));
}

function classify(category, title, body = '') {
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

function stripHtml(value) {
  return normalizeText(String(value || '')
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, ' '));
}

function cleanBody(value) {
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

function cleanTitle(value) {
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

function titleSimilarity(left, right) {
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

function pressFromTitle(value) {
  const text = stripHtml(value);
  return cleanPressName(text.match(/\s[-|–—]\s([^\-|–—]{1,30})$/u)?.[1] || '');
}

function cleanPressName(value) {
  return stripHtml(value)
    .replace(/\s+(?:[-|–—]|·)\s+(?:[^\n]{2,})$/u, '')
    .replace(/\s*(?:대한민국|울산)\s*(?:최초|최고)[^\n]*$/u, '')
    .trim()
    .slice(0, 40);
}

function parseDate(value) {
  const text = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(text)
    ? `${text.replace(' ', 'T')}+09:00`
    : text;
  const date = new Date(normalized);
  return Number.isNaN(date.valueOf()) ? '' : date.toISOString();
}

const NAVER_SECTION_CATEGORIES = {
  '100': '정치', '101': '경제', '102': '사회', '103': '생활/문화',
  '104': '세계'
};

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

function articleSource(url, discovery = '', press = '') {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    if (host.endsWith('naver.com')) return 'NAVER';
    if (host.endsWith('daum.net')) return 'DAUM';
    if (host.endsWith('google.com')) return 'GOOGLE';
    return cleanPressName(press) || host;
  } catch { return cleanPressName(press) || discovery || '기타'; }
}

function allowedCandidate(url, discovery) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    // Only the broad keyword-search KAKAO path is restricted to Daum's own
    // news domains, since that query can return arbitrary web results.
    // KAKAO_RESOLVED already matched a specific known headline by title, so
    // it just needs the normal spam/UGC blocklist like every other source.
    if (discovery === 'KAKAO') return host === 'v.daum.net' || host.endsWith('.news.daum.net') || host === 'news.daum.net';
    return !/(?:dcinside\.com|tistory\.com|blog\.naver\.com|cafe\.naver\.com|fmkorea\.com|theqoo\.net|ruliweb\.com|clien\.net|ppomppu\.co\.kr|instiz\.net|youtube\.com|namu\.wiki)$/i.test(host);
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

async function repairGeneralCategories(env, limit = 10, reset = false) {
  // news_category_checks marks a url_key done forever, even if a later fix
  // to the detection logic (e.g. reading article:section2 for outlets that
  // put their own brand name in article:section) would now classify it
  // differently. Without a way to clear it, articles checked under old,
  // buggier logic can never be reprocessed. Callers pass reset=1 once (see
  // deploy.yml's reset_categories input) to let everything be re-checked.
  if (reset) await env.DB.prepare('DELETE FROM news_category_checks').run();
  // Check the newest unchecked articles first. The former numeric cursor
  // walked from the oldest row in batches of ten, so newly reported mistakes
  // could remain visible for many maintenance runs.
  const rows = await env.DB.prepare(`SELECT a.id,a.url_key,a.url,a.title,a.body_text,a.category
    FROM news_articles a
    LEFT JOIN news_category_checks c ON c.url_key=a.url_key
    WHERE a.category<>'바둑' AND a.summary_quality='full' AND c.url_key IS NULL
      AND datetime(COALESCE(NULLIF(a.published_at,''),a.fetched_at))>=datetime('now','-30 days')
    ORDER BY datetime(COALESCE(NULLIF(a.published_at,''),a.fetched_at)) DESC, a.id DESC
    LIMIT ?`).bind(Math.min(Math.max(Number(limit) || 10, 1), 10)).all();
  const candidates = rows.results || [];
  if (!candidates.length) return { attempted: 0, repaired: 0, done: true };
  let repaired = 0;
  for (const row of candidates) {
    const article = await fetchArticleText(row.url);
    const fixedCategory = article.sectionCategory || classify(row.category, row.title, article.body || row.body_text);
    if (fixedCategory && fixedCategory !== row.category && fixedCategory !== '바둑') {
      await env.DB.prepare('UPDATE news_articles SET category=? WHERE id=?').bind(fixedCategory, row.id).run();
      repaired += 1;
    }
    await env.DB.prepare(`INSERT INTO news_category_checks(url_key,checked_at,detected_category)
      VALUES(?,CURRENT_TIMESTAMP,?) ON CONFLICT(url_key) DO UPDATE SET
      checked_at=CURRENT_TIMESTAMP,detected_category=excluded.detected_category`)
      .bind(row.url_key, fixedCategory || '').run();
  }
  return { attempted: candidates.length, repaired, done: candidates.length < 10 };
}

async function quarantineWeakGeneralSummaries(env) {
  const rows = await env.DB.prepare(`SELECT id,title,summary FROM news_articles
    WHERE category<>'바둑' AND summary_quality='full'
      AND datetime(COALESCE(NULLIF(published_at,''),fetched_at))>=datetime('now','-30 days')
    ORDER BY id LIMIT 400`).all();
  const weak = (rows.results || []).filter(row => !validateGeneralEditorialSummary(row.summary, row.title));
  for (let index = 0; index < weak.length; index += 50) {
    await env.DB.batch(weak.slice(index, index + 50).map(row =>
      env.DB.prepare("UPDATE news_articles SET summary='',summary_quality='none' WHERE id=?").bind(row.id)));
  }
  return { checked: (rows.results || []).length, quarantined: weak.length, ids: weak.map(row => row.id) };
}

// 옛 cleanTitle이 공백 없는 하이픈을 언론사 꼬리표로 오인해 잘라 저장한 제목을
// 되살린다("전북바둑협회-장쑤성 청소년 바둑대회 성료" -> "전북바둑협회").
// 검색으로 기사를 다시 찾는 경로는 같은 사건을 다룬 다른 매체 기사에 걸리거나
// http/https 차이로 url_key가 어긋나서 원본 행에 닿지 못했다. 저장된 URL에서
// og:title을 직접 읽는 이 경로는 그런 실패가 없다.
async function fetchArticleTitle(url) {
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 NewsBrief/Cloudflare' },
      cf: { cacheTtl: 300, cacheEverything: false }
    });
    if (!response.ok) return '';
    const type = response.headers.get('content-type') || '';
    if (!type.includes('text/html')) return '';
    const bytes = await response.arrayBuffer();
    let html = new TextDecoder('utf-8').decode(bytes);
    if (/euc-?kr|ks_c_5601|cp949/i.test(type) || (html.match(/�/g) || []).length >= 3) {
      html = new TextDecoder('euc-kr').decode(bytes);
    }
    html = html.slice(0, 200000);
    if (DEAD_PAGE.test(html.slice(0, 30000))) return '';
    return cleanTitle(html.match(/<meta[^>]+(?:property|name)=["']og:title["'][^>]+content=["']([^"']+)/i)?.[1]
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:title["']/i)?.[1] || '');
  } catch {
    return '';
  }
}

// 커서 순회로는 닿지 않는 기사 하나를 제목 조각으로 직접 찾아 고친다.
// 어느 카테고리로 분류됐는지, 저장된 URL이 무엇인지, 원문에서 제목을 실제로
// 읽어왔는지를 함께 돌려주기 때문에 복구가 안 될 때 원인이 바로 보인다.
// 저장본이 원문 제목의 앞부분인지 볼 때 공백은 무시한다. 검색 API가 준 제목과
// 원문 og:title은 띄어쓰기가 다른 경우가 흔하다("전북 바둑협회"로 저장된 기사의
// 원문 제목은 "전북바둑협회-장쑤성 청소년 바둑대회 성료"였다). 공백만 다른 걸
// 다른 기사로 보면 정작 고쳐야 할 행을 전부 놓친다.
const titleIsTruncationOf = (stored, fresh) => Boolean(fresh)
  && fresh.length > stored.length
  && fresh.replace(/\s+/g, '').startsWith(stored.replace(/\s+/g, ''));

async function repairTitleByQuery(env, query) {
  const rows = await env.DB.prepare(`SELECT id,url,title,category FROM news_articles
    WHERE title LIKE ? ORDER BY id DESC LIMIT 10`).bind(`%${String(query).replace(/[\\%_]/g, '\\$&')}%`).all();
  const found = [];
  let repaired = 0;
  for (const row of rows.results || []) {
    const stored = String(row.title || '');
    const fresh = await fetchArticleTitle(row.url);
    const willFix = titleIsTruncationOf(stored, fresh);
    if (willFix) {
      await env.DB.prepare('UPDATE news_articles SET title=? WHERE id=?').bind(fresh, row.id).run();
      repaired += 1;
    }
    found.push({ id: row.id, category: row.category, url: row.url, stored, fetched: fresh, repaired: willFix });
  }
  return { matched: (rows.results || []).length, repaired, found };
}

async function repairTruncatedTitles(env, limit = 10, reset = false) {
  const cursorKey = 'baduk_title_repair_cursor';
  if (reset) {
    await env.DB.prepare(`INSERT INTO news_state(key,value) VALUES(?,0)
      ON CONFLICT(key) DO UPDATE SET value=0`).bind(cursorKey).run();
  }
  const cursorRow = await env.DB.prepare('SELECT value FROM news_state WHERE key=?').bind(cursorKey).first();
  const cursor = reset ? 0 : Number(cursorRow?.value || 0);
  const rows = await env.DB.prepare(`SELECT id,url,title FROM news_articles
    WHERE id>? AND category='바둑'
      AND datetime(COALESCE(NULLIF(published_at,''),fetched_at))>=datetime('now','-30 days')
    ORDER BY id LIMIT ?`).bind(cursor, Math.min(Math.max(Number(limit) || 10, 1), 10)).all();
  const candidates = rows.results || [];
  if (!candidates.length) {
    await env.DB.prepare(`INSERT INTO news_state(key,value) VALUES(?,0)
      ON CONFLICT(key) DO UPDATE SET value=0`).bind(cursorKey).run();
    return { attempted: 0, repaired: 0, done: true, restored: [] };
  }
  let repaired = 0;
  const restored = [];
  for (const row of candidates) {
    const stored = String(row.title || '');
    const fresh = await fetchArticleTitle(row.url);
    // 저장본으로 시작하면서 더 길 때만 늘린다. 원문 제목이 통째로 바뀐
    // 경우에는 손대지 않으므로 다른 기사 제목으로 덮어쓸 수 없다.
    if (!titleIsTruncationOf(stored, fresh)) continue;
    await env.DB.prepare('UPDATE news_articles SET title=? WHERE id=?').bind(fresh, row.id).run();
    repaired += 1;
    if (restored.length < 5) restored.push({ from: stored, to: fresh });
  }
  const nextCursor = Math.max(...candidates.map(row => Number(row.id || 0)));
  await env.DB.prepare(`INSERT INTO news_state(key,value) VALUES(?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(cursorKey, nextCursor).run();
  return { attempted: candidates.length, repaired, done: candidates.length < 10, restored };
}

async function repairGeneralArticleTimes(env, limit = 10) {
  const cursorKey = 'general_time_repair_cursor';
  const cursorRow = await env.DB.prepare('SELECT value FROM news_state WHERE key=?').bind(cursorKey).first();
  const cursor = Number(cursorRow?.value || 0);
  const rows = await env.DB.prepare(`SELECT id,url,published_at FROM news_articles
    WHERE id>? AND category<>'바둑' AND summary_quality='full'
      AND (TRIM(published_at)='' OR published_at GLOB '????-??-??')
      AND datetime(COALESCE(NULLIF(published_at,''),fetched_at))>=datetime('now','-30 days')
    ORDER BY id LIMIT ?`).bind(cursor, Math.min(Math.max(Number(limit) || 10, 1), 10)).all();
  const candidates = rows.results || [];
  if (!candidates.length) {
    await env.DB.prepare(`INSERT INTO news_state(key,value) VALUES(?,0)
      ON CONFLICT(key) DO UPDATE SET value=0`).bind(cursorKey).run();
    return { attempted: 0, repaired: 0, done: true };
  }
  let repaired = 0;
  for (const row of candidates) {
    const article = await fetchArticleText(row.url);
    if (!article.publishedAt || /^\d{4}-\d{2}-\d{2}$/.test(article.publishedAt)) continue;
    await env.DB.prepare('UPDATE news_articles SET published_at=? WHERE id=?')
      .bind(article.publishedAt, row.id).run();
    repaired += 1;
  }
  const nextCursor = Math.max(...candidates.map(row => Number(row.id || 0)));
  await env.DB.prepare(`INSERT INTO news_state(key,value) VALUES(?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(cursorKey, nextCursor).run();
  return { attempted: candidates.length, repaired, done: candidates.length < 10 };
}

async function naverSearch(env, query, start = 1, display = 5) {
  if (!env.NAVER_CLIENT_ID || !env.NAVER_CLIENT_SECRET) {
    throw new Error('NAVER_CLIENT_ID 또는 NAVER_CLIENT_SECRET이 없습니다.');
  }
  const endpoint = new URL('https://openapi.naver.com/v1/search/news.json');
  endpoint.searchParams.set('query', query);
  endpoint.searchParams.set('display', String(Math.min(Math.max(display, 1), 100)));
  endpoint.searchParams.set('start', String(start));
  endpoint.searchParams.set('sort', 'date');
  const response = await fetch(endpoint, {
    headers: {
      'X-Naver-Client-Id': env.NAVER_CLIENT_ID,
      'X-Naver-Client-Secret': env.NAVER_CLIENT_SECRET
    }
  });
  if (!response.ok) throw new Error(`Naver API ${response.status}`);
  return (await response.json()).items || [];
}

async function kakaoSearch(env, query, page = 1, size = 5) {
  if (!env.KAKAO_REST_API_KEY) return [];
  const endpoint = new URL('https://dapi.kakao.com/v2/search/web');
  endpoint.searchParams.set('query', query);
  endpoint.searchParams.set('size', String(Math.min(Math.max(size, 1), 50)));
  endpoint.searchParams.set('page', String(page));
  endpoint.searchParams.set('sort', 'recency');
  const response = await fetch(endpoint, { headers: { Authorization: `KakaoAK ${env.KAKAO_REST_API_KEY}` } });
  if (!response.ok) throw new Error(`Kakao API ${response.status}`);
  return ((await response.json()).documents || []).map(doc => ({
    title: doc.title, link: doc.url, originallink: doc.url, description: doc.contents,
    pubDate: doc.datetime, thumbnail: doc.thumbnail || ''
  }));
}

function xmlText(block, tag) {
  return normalizeText((block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1] || '')
    .replace(/^<!\[CDATA\[|\]\]>$/g, ''));
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchGoogleRss(endpoint, attempts = 3) {
  let lastStatus = 0;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(endpoint, {
        signal: controller.signal,
        headers: {
          'user-agent': attempt ? 'Mozilla/5.0' : 'Mozilla/5.0 NewsBrief/1.0',
          accept: attempt ? 'application/xml,text/xml;q=0.9,*/*;q=0.8' : 'application/rss+xml, application/xml;q=0.9'
        }
      });
      lastStatus = response.status;
      if (response.ok || response.status < 500) return response;
    } catch (error) {
      if (error?.name !== 'AbortError' && attempt === attempts - 1) throw error;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < attempts - 1) await wait(250 * (2 ** attempt));
  }
  throw new Error(`Google News RSS ${lastStatus || 'timeout'}`);
}

async function koreanBadukLatest() {
  // report.asp is a JS shell whose list is loaded client-side from
  // report_in.asp; fetching report.asp itself always yields an empty list.
  const base = 'https://www.baduk.or.kr/news/report_in.asp';
  try {
    const response = await fetch(base, { headers: { 'user-agent': 'Mozilla/5.0 NewsBrief/1.0' } });
    if (!response.ok) return [];
    const html = await response.text();
    const items = [], seen = new Set();
    for (const match of html.matchAll(/<a[^>]+href=["']([^"']*report_view\.asp\?[^"']*news_no=\d+[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const url = new URL(match[1].replace(/&amp;/g, '&'), base).toString();
      const block = match[2];
      const title = cleanTitle(block.match(/<dt[^>]*>([\s\S]*?)<\/dt>/i)?.[1] || '');
      if (title.length < 8 || seen.has(url) || isRejectedTitle(title)) continue;
      seen.add(url);
      const dateText = normalizeText(block.match(/<span[^>]+class=["']date["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] || '');
      // The listing only gives a date, never a time of day, and the article
      // page has no timestamp meta either. Anchor to noon Korea time for that
      // date: a bare date parses as UTC midnight, which makes a same-day
      // article look >24h old for most of the day, while falling back to the
      // collection time (an earlier version of this fix) makes old backlog
      // articles look freshly published today. Noon keeps old articles on
      // their real date and still lands same-day articles inside a same-day
      // recency window for most of the day.
      const pubDate = /^\d{4}-\d{2}-\d{2}$/.test(dateText) ? `${dateText} 12:00:00` : '';
      items.push({ title, link: url, originallink: url, description: '', pubDate, press: '한국기원' });
      if (items.length >= 12) break;
    }
    return items;
  } catch {
    return [];
  }
}

export async function googleNewsSearch(query, days = 30) {
  const endpoint = new URL('https://news.google.com/rss/search');
  endpoint.searchParams.set('q', `${query} when:${Math.min(Math.max(days, 1), 30)}d`);
  endpoint.searchParams.set('hl', 'ko');
  endpoint.searchParams.set('gl', 'KR');
  endpoint.searchParams.set('ceid', 'KR:ko');
  const response = await fetchGoogleRss(endpoint);
  if (!response.ok) throw new Error(`Google News RSS ${response.status}`);
  const xml = await response.text();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].slice(0, 5).map(match => {
    const rawTitle = xmlText(match[1], 'title');
    const parts = rawTitle.split(/\s+-\s+/);
    const press = parts.length > 1 ? parts.pop() : '';
    return {
      title: parts.join(' - ') || rawTitle, link: xmlText(match[1], 'link'),
      originallink: xmlText(match[1], 'link'), description: xmlText(match[1], 'description'),
      pubDate: xmlText(match[1], 'pubDate'), press
    };
  });
}

async function popularPage(url, source) {
  const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 NewsBrief/1.0' } });
  if (!response.ok) return [];
  const bytes = await response.arrayBuffer();
  const declared = response.headers.get('content-type') || '';
  let html = new TextDecoder('utf-8').decode(bytes);
  if (/euc-?kr|ks_c_5601|cp949/i.test(declared) || (html.match(/�/g) || []).length >= 3) {
    html = new TextDecoder('euc-kr').decode(bytes);
  }
  const out = [], seen = new Set();
  for (const match of html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let href = normalizeText(match[1]);
    if (href.startsWith('//')) href = `https:${href}`;
    if (href.startsWith('/')) href = new URL(href, url).toString();
    if (source === 'NAVER' && !/naver\.com\/(?:main\/ranking\/(?:read|rankingRead)\.naver|mnews\/article|article\/)/i.test(href)) continue;
    if (source === 'DAUM' && !/(?:v\.daum\.net\/v\/|news\.daum\.net\/)/i.test(href)) continue;
    const title = cleanTitle(match[2]);
    if (title.length < 8 || seen.has(href) || isRejectedTitle(title)) continue;
    seen.add(href); out.push({ href, title, rank: out.length + 1, source });
    if (out.length >= 30) break;
  }
  return out;
}

async function collectPopularity(slot = 0) {
  const pages = [
    ...[['100','정치'],['101','경제'],['102','사회'],['103','생활/문화'],['104','세계']]
      .map(([sid, category]) => [`https://news.naver.com/main/ranking/popularDay.naver?mid=etc&sid1=${sid}`, 'NAVER', category]),
    ['https://news.daum.net/ranking/popular', 'DAUM', '기타']
  ];
  // Read every Naver ranking section on every run. The previous rotation read
  // only one of five sections; when Daum returned no parseable rows, a run had
  // just six candidates and commonly produced only one or two display cards.
  // Rotate the section order for fair tie-breaking, then interleave ranks so
  // no single section can dominate the candidate budget.
  const naverPages = pages.slice(0, 5);
  const rotated = [...naverPages.slice(slot % 5), ...naverPages.slice(0, slot % 5), pages[5]];
  const groups = await Promise.all(rotated.map(async ([url, source, category]) =>
    (await popularPage(url, source)).slice(0, 4).map(row => ({ ...row, category }))
  ));
  return Array.from({ length: 4 }, (_, index) => groups.flatMap(group => group[index] ? [group[index]] : [])).flat();
}

async function reserveAiCall(env, diagnostics) {
  const reservation = await reserveCloudflareCall(env);
  if (!reservation.allowed) {
    diagnostics.ai_budget_exhausted = true;
    diagnostics.ai_calls_today = reservation.used;
    return false;
  }
  diagnostics.ai_calls_today = reservation.used;
  return true;
}

async function reserveAnthropicCall(env, diagnostics, forceRetry = false, generalBoost = false) {
  const day = new Date().toISOString().slice(0, 10);
  const dayRow = await env.DB.prepare("SELECT value FROM news_state WHERE key='anthropic_budget_day'").first();
  if (String(dayRow?.value || '') !== day) {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO news_state(key,value) VALUES('anthropic_budget_day',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(day),
      env.DB.prepare("INSERT INTO news_state(key,value) VALUES('anthropic_calls_today',0) ON CONFLICT(key) DO UPDATE SET value=0")
    ]);
  }
  const dailyRow = await env.DB.prepare("SELECT value FROM news_state WHERE key='anthropic_calls_today'").first();
  const daily = Number(dailyRow?.value || 0);
  const dailyLimit = forceRetry
    ? BACKFILL_ANTHROPIC_CALL_LIMIT
    : (generalBoost ? GENERAL_BOOST_ANTHROPIC_CALL_LIMIT : DAILY_ANTHROPIC_CALL_LIMIT);
  const budget = await canUseClaude(env, ESTIMATED_SUMMARY_CALL_MICRO_USD);
  if (daily >= dailyLimit || !budget.allowed) {
    diagnostics.anthropic_budget_exhausted = true;
    diagnostics.anthropic_calls_today = daily;
    diagnostics.anthropic_daily_limit = dailyLimit;
    diagnostics.claude_monthly_micro_usd = budget.spent;
    return false;
  }
  await env.DB.prepare("INSERT INTO news_state(key,value) VALUES('anthropic_calls_today',1) ON CONFLICT(key) DO UPDATE SET value=value+1").run();
  diagnostics.anthropic_calls_today = daily + 1;
  diagnostics.anthropic_daily_limit = dailyLimit;
  return true;
}

async function blockAiForToday(env, diagnostics) {
  await blockCloudflareForToday(env);
  diagnostics.ai_budget_exhausted = true;
  diagnostics.ai_provider_limited = true;
}

async function collectArchivedTop(slot) {
  const rows = [];
  const baseOffset = (slot % 10) * 3;
  for (let extra = 0; extra < 3; extra += 1) {
    const date = new Date(Date.now() - (baseOffset + extra) * 86400000);
    const ymd = date.toISOString().slice(0, 10).replace(/-/g, '');
    for (const [sid, category] of [['100','정치'],['101','경제'],['102','사회'],['103','생활/문화'],['104','세계']]) {
      const url = `https://news.naver.com/main/ranking/popularDay.naver?mid=etc&sid1=${sid}&date=${ymd}`;
      const top = (await popularPage(url, 'NAVER'))[0];
      if (top) rows.push({
        category, source: 'NAVER', archiveScore: 70 - (baseOffset + extra),
        item: { title: top.title, link: top.href, originallink: top.href, description: '', pubDate: date.toISOString() }
      });
    }
  }
  return rows;
}

async function backfillPopularityDate(env, ymd) {
  if (!/^\d{8}$/.test(ymd)) throw new Error('popularity_date는 YYYYMMDD 형식이어야 합니다.');
  const parsed = Date.parse(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T00:00:00Z`);
  if (!Number.isFinite(parsed) || parsed > Date.now() + 86400000 || parsed < Date.now() - 31 * 86400000) {
    throw new Error('popularity_date는 최근 30일 이내여야 합니다.');
  }
  const groups = [];
  for (const [sid, category] of [['100','정치'],['101','경제'],['102','사회'],['103','생활/문화'],['104','세계']]) {
    const url = `https://news.naver.com/main/ranking/popularDay.naver?mid=etc&sid1=${sid}&date=${ymd}`;
    groups.push((await popularPage(url, 'NAVER')).slice(0, 10).map(row => ({ ...row, category })));
  }
  const rows = Array.from({ length: 10 }, (_, index) => groups.flatMap(group => group[index] ? [group[index]] : [])).flat();
  const statements = [];
  for (const row of rows) {
    const key = await sha256(canonicalUrl(row.href));
    statements.push(env.DB.prepare(`INSERT INTO news_popularity(url_key,score,rank,source,collected_at)
      VALUES(?,?,?,'NAVER',CURRENT_TIMESTAMP) ON CONFLICT(url_key) DO UPDATE SET
      score=MAX(news_popularity.score,excluded.score),rank=MIN(news_popularity.rank,excluded.rank),collected_at=CURRENT_TIMESTAMP`)
      .bind(key, 101 - row.rank, row.rank));
    statements.push(env.DB.prepare(`INSERT INTO news_popular_items(title,url_key,score,rank,source,collected_at)
      VALUES(?,?,?,?,'NAVER',CURRENT_TIMESTAMP) ON CONFLICT(title) DO UPDATE SET
      url_key=excluded.url_key,score=MAX(news_popular_items.score,excluded.score),
      rank=MIN(news_popular_items.rank,excluded.rank),collected_at=CURRENT_TIMESTAMP`)
      .bind(row.title, key, 101 - row.rank, row.rank));
  }
  for (let index = 0; index < statements.length; index += 50) {
    await env.DB.batch(statements.slice(index, index + 50));
  }
  return { date: ymd, ranking_items: rows.length, rows };
}

async function collect(env, {
  backfill = false, repair = false, forceRetry = false, generalBoost = false,
  generalOnly = false, qualityRepairIds = [], googleDiscoveries = [], popularityCandidates = [], popularityOffset = 0
} = {}) {
  const diagnostics = { mode: backfill ? 'backfill' : 'scheduled', retry_attempted: 0, retry_repaired: 0, samples: [] };
  const now = new Date();
  const koreaNow = new Date(now.valueOf() + 9 * 3600000);
  const dayStart = Date.UTC(koreaNow.getUTCFullYear(), koreaNow.getUTCMonth(), koreaNow.getUTCDate()) - 9 * 3600000;
  const monthStart = Date.UTC(koreaNow.getUTCFullYear(), koreaNow.getUTCMonth(), 1) - 9 * 3600000;
  const publishedRows = await env.DB.prepare(`SELECT a.category,a.title,a.summary,a.published_at,a.fetched_at,
      EXISTS(SELECT 1 FROM news_popular_items p WHERE p.url_key=a.url_key OR p.title=a.title) AS is_popular
    FROM news_articles a WHERE a.summary_quality='full'
      AND datetime(COALESCE(NULLIF(a.published_at,''),a.fetched_at))>=datetime(?)`)
    .bind(new Date(monthStart).toISOString()).all();
  const publicationCounts = {
    baduk: { daily: 0, monthly: 0 },
    general: { daily: 0, monthly: 0 }
  };
  const storedTime = value => {
    const text = String(value || '');
    return Date.parse(/Z$|[+-]\d\d:\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}Z`);
  };
  for (const row of publishedRows.results || []) {
    if (!validPublishedSummary(row.summary, row.title, row.category)) continue;
    const bucket = row.category === '바둑' ? 'baduk' : 'general';
    const timestamp = storedTime(row.published_at || row.fetched_at);
    publicationCounts[bucket].monthly += 1;
    if (timestamp >= dayStart) publicationCounts[bucket].daily += 1;
  }
  const popularityTargetStart = popularityCandidates.length
    ? Number(popularityCandidates[0].popularityDate) - 9 * 3600000
    : 0;
  const popularityTargetCounts = { baduk: 0, general: 0 };
  if (popularityTargetStart) {
    for (const row of publishedRows.results || []) {
      if (!validPublishedSummary(row.summary, row.title, row.category)) continue;
      if (!Number(row.is_popular || 0)) continue;
      const timestamp = storedTime(row.published_at || row.fetched_at);
      if (timestamp < popularityTargetStart || timestamp >= popularityTargetStart + 86400000) continue;
      popularityTargetCounts[row.category === '바둑' ? 'baduk' : 'general'] += 1;
    }
  }
  const publicationBucket = category => category === '바둑' ? 'baduk' : 'general';
  const consumePublicationCapacity = category => {
    const bucket = publicationBucket(category);
    const count = publicationCounts[bucket];
    if (popularityTargetStart) popularityTargetCounts[bucket] += 1;
    else count.daily += 1;
    count.monthly += 1;
  };
  diagnostics.home_display_limits = { baduk: 30, general: 10 };
  diagnostics.publish_counts_before = JSON.parse(JSON.stringify(publicationCounts));
  if (popularityTargetStart) diagnostics.popularity_target_counts_before = { ...popularityTargetCounts };
  const summarize = async (payload, detail, purpose = 'new') => {
    const trace = detail || {};
    const sourceLength = normalizeText(payload.body || payload.rawSummary).length;
    if (sourceLength < 300) {
      const extractive = await makeBestSummary({ AI: undefined, ANTHROPIC_API_KEY: undefined }, payload, trace);
      if (extractive) diagnostics.extractive_fallback_used = Number(diagnostics.extractive_fallback_used || 0) + 1;
      return extractive;
    }

    let cloudflareReserved = Boolean(env.AI);
    if (cloudflareReserved) cloudflareReserved = await reserveAiCall(env, diagnostics);

    let summary = '';
    if (cloudflareReserved) {
      summary = await makeBestSummary({ ...env, ANTHROPIC_API_KEY: undefined, NEWSBRIEF_USE_ANTHROPIC: '0' }, payload, trace);
      const cloudflareValid = trace.ai_provider === 'cloudflare'
        && trace.structurally_valid && trace.numbers_grounded;
      if (cloudflareValid) return summary;
    }
    if (cloudflareReserved && /(?:daily free allocation|Account limited|3036|4006)/i.test(String(trace.ai_error || ''))) {
      await blockAiForToday(env, diagnostics);
    }

    if (env.ANTHROPIC_API_KEY && await reserveAnthropicCall(env, diagnostics, forceRetry, generalBoost)) {
      const anthropicTrace = {};
      const anthropicSummary = await makeBestSummary({
        ...env,
        AI: undefined,
        NEWSBRIEF_USE_ANTHROPIC: '1'
      }, payload, anthropicTrace);
      Object.assign(trace, anthropicTrace, {
        cloudflare_fallback: true,
        cloudflare_error: trace.ai_error || (cloudflareReserved ? 'invalid_response' : 'budget_unavailable')
      });
      if (anthropicTrace.ai_provider === 'anthropic') {
        const recorded = await recordClaudeUsage(env, anthropicTrace.ai_model, {
          input_tokens: anthropicTrace.ai_input_tokens,
          output_tokens: anthropicTrace.ai_output_tokens
        });
        diagnostics.claude_monthly_micro_usd = recorded.spent;
      }
      if (anthropicTrace.ai_provider === 'anthropic'
        && anthropicTrace.structurally_valid && anthropicTrace.numbers_grounded) return anthropicSummary;
      if (!summary) summary = anthropicSummary;
    }

    const extractive = summary || await makeBestSummary({
      AI: undefined,
      ANTHROPIC_API_KEY: undefined
    }, payload, trace);
    if (extractive) diagnostics.extractive_fallback_used = Number(diagnostics.extractive_fallback_used || 0) + 1;
    return extractive;
  };
  // Maintenance is deliberately bounded. Scanning and updating the complete
  // archive on every request exhausted the Pages Worker CPU during backfills.
  if (!popularityCandidates.length) {
    const maintenanceCursor = await env.DB.prepare("SELECT value FROM news_state WHERE key='maintenance_cursor'").first();
    const maintenanceAfter = Number(maintenanceCursor?.value || 0);
    let stored = await env.DB.prepare(`SELECT id,title,summary,body_text,category,url,source,press FROM news_articles
      WHERE id>? ORDER BY id LIMIT ?`).bind(maintenanceAfter, MAINTENANCE_BATCH_SIZE).all();
    if (!(stored.results || []).length && maintenanceAfter > 0) {
      stored = await env.DB.prepare(`SELECT id,title,summary,body_text,category,url,source,press FROM news_articles
        ORDER BY id LIMIT ?`).bind(MAINTENANCE_BATCH_SIZE).all();
    }
    for (const row of stored.results || []) {
      const fixedCategory = classify(row.category, row.title, row.body_text);
      if (fixedCategory !== row.category) await env.DB.prepare('UPDATE news_articles SET category=? WHERE id=?').bind(fixedCategory, row.id).run();
      if (['NAVER', 'KAKAO', 'GOOGLE'].includes(row.source)) {
        const fixedSource = articleSource(row.url, row.source, row.press);
        if (fixedSource !== row.source) await env.DB.prepare('UPDATE news_articles SET source=? WHERE id=?').bind(fixedSource, row.id).run();
      }
      if (fixedCategory !== '바둑' && row.summary) {
        const reordered = reorderGeneralSummary(row.summary, row.title);
        if (!validateGeneralEditorialSummary(reordered, row.title)) {
          await env.DB.prepare("UPDATE news_articles SET summary='',summary_quality='none' WHERE id=?").bind(row.id).run();
          diagnostics.general_summaries_quarantined = Number(diagnostics.general_summaries_quarantined || 0) + 1;
        } else if (reordered !== row.summary) {
          await env.DB.prepare('UPDATE news_articles SET summary=? WHERE id=?').bind(reordered, row.id).run();
          diagnostics.general_summaries_reordered = Number(diagnostics.general_summaries_reordered || 0) + 1;
        }
      }
    }
    const lastMaintainedId = (stored.results || []).at(-1)?.id || 0;
    await env.DB.prepare("INSERT INTO news_state(key,value) VALUES('maintenance_cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind(lastMaintainedId).run();
  }
  // Only summaries that fail the narrow general-news editorial checks above
  // are quarantined. Other published summaries are never demoted routinely.
  if (repair) {
    const weakRows = await env.DB.prepare(`SELECT id,url,title,body_text,image_url,press FROM news_articles
      WHERE category='바둑' AND summary_quality='none' AND length(body_text)<300
        AND lower(url) NOT LIKE '%sports.naver.com/%'
      ORDER BY length(body_text) DESC, fetched_at DESC LIMIT 4`).all();
    const recovered = [];
    for (const row of weakRows.results || []) {
      let article = await fetchArticleText(canonicalUrl(row.url));
      if (article.body.length < 300) {
        try {
          const matches = await naverSearch(env, `"${cleanTitle(row.title)}"`, 1, 3);
          const match = matches.find(item => cleanTitle(item.title).replace(/[^0-9A-Za-z가-힣]/g, '')
            === cleanTitle(row.title).replace(/[^0-9A-Za-z가-힣]/g, '')) || matches[0];
          if (match) article = await fetchArticleText(canonicalUrl(match.link || match.originallink));
        } catch {}
      }
      if (article.body.length < 300) {
        recovered.push(0);
        continue;
      }
      await env.DB.prepare(`UPDATE news_articles SET body_text=?,
        image_url=CASE WHEN ?<>'' THEN ? ELSE image_url END,
        press=CASE WHEN ?<>'' THEN ? ELSE press END WHERE id=?`)
        .bind(article.body, article.image, article.image, article.press, article.press, row.id).run();
      recovered.push(1);
    }
    diagnostics.body_recrawl_attempted = (weakRows.results || []).length;
    diagnostics.body_recrawl_recovered = recovered.reduce((sum, value) => sum + value, 0);
  }
  const retryRowLimit = popularityCandidates.length ? 0 : (repair ? 4 : (backfill ? 4 : 3));
  // force_retry gives exhausted rows exactly one additional attempt instead
  // of excluding attempts=24 forever or reopening them without a ceiling.
  const retryAttemptLimit = forceRetry ? 25 : 24;
  const retryRows = await env.DB.prepare(`SELECT a.id,a.url_key,a.title,a.raw_summary,a.body_text,a.category FROM news_articles a
    LEFT JOIN news_summary_attempts f ON f.url_key=a.url_key
    WHERE a.summary_quality='none' AND length(a.body_text)>=300 AND COALESCE(f.attempts,0)<?
      AND (?=0 OR a.category<>'바둑')
      AND (?=0 OR instr(','||?||',', ','||a.id||',')>0)
      AND (? OR f.last_attempt IS NULL OR f.last_attempt < datetime('now','-20 hours'))
    ORDER BY CASE WHEN a.category='바둑' THEN 0 ELSE 1 END,
      COALESCE(f.attempts,0), COALESCE(f.last_attempt,'1970-01-01'), length(a.body_text) DESC LIMIT ?`)
    .bind(retryAttemptLimit, generalOnly ? 1 : 0, qualityRepairIds.length ? 1 : 0,
      qualityRepairIds.join(','), forceRetry ? 1 : 0, retryRowLimit).all();
  const retrySummary = async row => {
    if (isRejectedTitle(row.title)) return;
    const detail = {};
    const repaired = await summarize({ title: row.title, rawSummary: row.raw_summary, body: row.body_text, category: row.category }, detail, 'retry');
    diagnostics.retry_attempted += 1;
    if (diagnostics.samples.length < 2) diagnostics.samples.push({ title: row.title, ...detail });
    if (validPublishedSummary(repaired, row.title, row.category)) {
      await env.DB.batch([
        env.DB.prepare("UPDATE news_articles SET summary=?,summary_quality='full' WHERE id=?").bind(repaired, row.id),
        env.DB.prepare('DELETE FROM news_summary_attempts WHERE url_key=?').bind(row.url_key)
      ]);
      consumePublicationCapacity(row.category);
      diagnostics.retry_repaired += 1;
    } else if (detail.ai_attempted && !detail.ai_error) {
      await env.DB.prepare(`INSERT INTO news_summary_attempts(url_key,attempts,last_attempt) VALUES(?,1,CURRENT_TIMESTAMP)
        ON CONFLICT(url_key) DO UPDATE SET attempts=attempts+1,last_attempt=CURRENT_TIMESTAMP`).bind(row.url_key).run();
    }
  };
  const pendingRetries = retryRows.results || [];
  const candidates = popularityCandidates.map(row => ({
    category: row.category,
    source: 'NAVER',
    isPopular: true,
    popularityRank: row.rank,
    item: {
      title: row.title, link: row.href, originallink: row.href, description: '',
      // Archived ranking pages identify the day, not an exact publication
      // time. Keep that as a date-only value until the article page supplies
      // its real timestamp; inventing noon UTC displayed as 9 PM in Korea.
      pubDate: new Date(row.popularityDate).toISOString().slice(0, 10)
    }
  }));
  if (repair) {
    for (const row of pendingRetries) await retrySummary(row);
    return { inserted: 0, diagnostics };
  }
  const cursorKey = backfill ? 'history_cursor' : 'rotation_cursor';
  const cursorRow = await env.DB.prepare('SELECT value FROM news_state WHERE key=?').bind(cursorKey).first();
  const slot = Number(cursorRow?.value || 0);
  await env.DB.prepare('INSERT INTO news_state(key,value) VALUES(?,1) ON CONFLICT(key) DO UPDATE SET value=value+1').bind(cursorKey).run();
  const backfillStart = backfill ? (slot % 10) * 100 + 1 : (slot % 100) * 10 + 1;
  const badukQuery = BADUK_SEARCHES[slot % BADUK_SEARCHES.length];
  const generalSearches = SEARCHES.filter(([category]) => category !== '바둑');
  const selectedSearches = popularityCandidates.length ? [] : backfill
    ? SEARCHES.filter(([category]) => category === '바둑')
    : [SEARCHES[0], generalSearches[slot % generalSearches.length], generalSearches[(slot + 1) % generalSearches.length]];
  if (!popularityCandidates.length && !backfill) {
    const official = await koreanBadukLatest();
    diagnostics.official_baduk_found = official.length;
    for (const item of official) candidates.push({ category: '바둑', item, source: 'TRUSTED_BADUK' });
  }
  for (const [category, query] of selectedSearches) {
    // A broad "바둑" query at ever-higher offsets repeatedly returned the same small
    // set of usable portal articles. Search several distinct beats per run instead.
    const effectiveQueries = category === '바둑'
      ? [...new Set([
          // The broad query is the freshest view users see on Naver. Always
          // run it instead of waiting for the 35-query rotation to return to
          // it, then add rotated specialist queries for long-tail coverage.
          '바둑',
          ...Array.from({ length: backfill ? 3 : 1 }, (_, index) =>
            BADUK_SEARCHES[(slot * (backfill ? 3 : 1) + index) % BADUK_SEARCHES.length])
        ])]
      : [query];
    for (const effectiveQuery of effectiveQueries) {
      const pageBand = backfill ? Math.floor(slot / Math.ceil(BADUK_SEARCHES.length / 4)) % 5 : 0;
      const start = category === '바둑' ? pageBand * 20 + 1 : (backfill ? backfillStart : 1);
      const display = category === '바둑' ? 20 : (backfill ? 10 : 4);
      // Every other naverSearch/kakaoSearch call site guards against a
      // transient upstream failure. This one didn't - a single 429/5xx from
      // Naver here threw past collect()'s only try/catch (in onRequestPost)
      // and aborted the entire run before baduk, general, or popularity ever
      // got a single candidate, not just this one query's results.
      let items = [];
      try {
        items = await naverSearch(env, effectiveQuery, start, display);
      } catch (error) {
        diagnostics.naver_error = String(error?.message || error).slice(0, 120);
      }
      const naverTake = category === '바둑' ? (backfill ? 6 : 10) : (backfill ? 2 : 2);
      for (const item of items.slice(0, naverTake)) candidates.push({ category, item, source: 'NAVER' });
      try {
        const page = category === '바둑' ? pageBand + 1 : (backfill ? (slot % 10) * 5 + 1 : 1);
        const kakaoItems = await kakaoSearch(env, effectiveQuery, page, category === '바둑' ? 10 : (backfill ? 10 : 3));
        const kakaoTake = category === '바둑' ? (backfill ? 3 : 1) : (backfill ? 2 : 1);
        for (const item of kakaoItems.slice(0, kakaoTake)) candidates.push({ category, item, source: 'KAKAO' });
      } catch (error) {
        diagnostics.kakao_error = String(error?.message || error).slice(0, 120);
      }
    }
  }
  const recentGeneral = backfill ? null : await env.DB.prepare(`SELECT COUNT(*) AS count FROM news_articles
    WHERE category<>'바둑' AND summary_quality='full'
      AND datetime(COALESCE(NULLIF(published_at,''),fetched_at))>=datetime('now','-24 hours')`).first();
  const generalBelowDailyGoal = backfill ? false : Number(recentGeneral?.count || 0) < 10;
  // Google News is discovery-only: resolve each headline through the licensed
  // Naver API, then fetch and validate the real article like every other item.
  // Never expose a Google wrapper or its short RSS description as a summary.
  // Discovery is intentionally broader than the processing batch. Some Google
  // headlines resolve to duplicates, blocked destinations, or pages whose body
  // cannot be extracted. Resolve enough headlines to still fill the six-item
  // scheduled baduk batch after those expected losses.
  //
  // Every resolution attempt here is a Worker subrequest (up to 2 each: Naver
  // then a Kakao fallback), and this loop is 100% baduk - googleDiscoveries is
  // fed only from the baduk-only discovery script. A Worker invocation has a
  // hard subrequest cap, and this loop alone can spend 40+ of them before a
  // single general candidate is ever fetched. Baduk already met its daily
  // publish goal in every run that measured this; general has been stuck at
  // ~2/10 for days. Skip this baduk-only spend entirely while general is
  // still behind so the budget survives long enough to fetch general bodies.
  for (const discovery of generalBelowDailyGoal ? [] : googleDiscoveries.slice(0, backfill ? 20 : SCHEDULED_GOOGLE_DISCOVERIES)) {
    const discoveredTitle = cleanTitle(discovery?.title || '');
    if (!discoveredTitle || isRejectedTitle(discoveredTitle)) continue;
    let resolved = false;
    try {
      const matches = await naverSearch(env, `"${discoveredTitle}"`, 1, 3);
      const match = matches.find(item => {
        const candidateTitle = cleanTitle(item.title);
        const left = candidateTitle.replace(/[^0-9A-Za-z가-힣]/g, '');
        const right = discoveredTitle.replace(/[^0-9A-Za-z가-힣]/g, '');
        return left === right || (Math.min(left.length, right.length) >= 18 && (left.includes(right) || right.includes(left)));
      });
      if (match) { candidates.push({ category: '바둑', item: match, source: 'NAVER' }); resolved = true; }
    } catch (error) {
      diagnostics.google_resolve_error = String(error?.message || error).slice(0, 120);
    }
    // discovery.link is a Google News wrapper URL (news.google.com/rss/...)
    // that only resolves through client-side JS, which a plain fetch can
    // never follow - it was never actually reaching the real article, just
    // silently failing as body_too_short on every attempt. Try Kakao's web
    // search as a second real resolver instead of fetching that dead end.
    if (!resolved) {
      try {
        const matches = await kakaoSearch(env, `"${discoveredTitle}"`, 1, 3);
        const match = matches.find(item => {
          const candidateTitle = cleanTitle(item.title);
          const left = candidateTitle.replace(/[^0-9A-Za-z가-힣]/g, '');
          const right = discoveredTitle.replace(/[^0-9A-Za-z가-힣]/g, '');
          return left === right || (Math.min(left.length, right.length) >= 18 && (left.includes(right) || right.includes(left)));
        });
        // This is resolving an already-known, specific headline (title
        // matched, not a broad keyword search), so unlike the generic
        // KAKAO search loop it doesn't need the daum.net-only allowlist -
        // just the same spam/UGC blocklist every other source uses. That
        // allowlist was the reason small/regional outlets (their own
        // domains, not syndicated to Daum) never made it in even when
        // Kakao's search found them.
        if (match) candidates.push({ category: '바둑', item: match, source: 'KAKAO_RESOLVED' });
      } catch (error) {
        diagnostics.google_resolve_kakao_error = String(error?.message || error).slice(0, 120);
      }
    }
  }
  diagnostics.google_discovered = googleDiscoveries.length;
  if (backfill) {
    try {
      const archived = await collectArchivedTop(slot);
      candidates.push(...archived);
      for (const row of archived) {
        const key = await sha256(canonicalUrl(row.item.originallink || row.item.link));
        await env.DB.prepare(`INSERT INTO news_popular_items(title,url_key,score,rank,source,collected_at)
          VALUES(?,?,?,1,'NAVER',CURRENT_TIMESTAMP) ON CONFLICT(title) DO UPDATE SET
          url_key=excluded.url_key,score=MAX(news_popular_items.score,excluded.score),collected_at=CURRENT_TIMESTAMP`)
          .bind(cleanTitle(row.item.title), key, row.archiveScore).run();
      }
      diagnostics.archive_candidates = candidates.length;
    } catch (error) {
      diagnostics.archive_error = String(error?.message || error).slice(0, 120);
    }
  }
  // The GitHub discovery job already supplies Google headlines from a network
  // that Google accepts. Avoid a redundant Worker-origin RSS call, which is
  // frequently rejected with 503 even though discovery already succeeded.
  if (!popularityCandidates.length && !backfill && !googleDiscoveries.length) try {
    for (const item of (await googleNewsSearch(badukQuery, 30)).slice(0, 3)) candidates.push({ category: '바둑', item, source: 'GOOGLE' });
  } catch (error) {
    diagnostics.google_error = String(error?.message || error).slice(0, 120);
  } else if (!backfill) {
    diagnostics.google_fallback_skipped = true;
  }
  if (!popularityCandidates.length && !backfill) try {
    const allPopular = await collectPopularity(slot);
    // Resolving each ranked headline costs up to 2 subrequests (title search
    // + fallback search). Resolving all 20 ate most of a run's Cloudflare
    // subrequest budget before any candidate body fetch, the same budget
    // exhaustion that starved baduk - see SCHEDULED_GOOGLE_DISCOVERIES above.
    // 8 was overly conservative once the double collect() call (see
    // deploy.yml) freed up headroom - test runs showed 0 body_too_short with
    // slack left in the general processing slot, so 12 trades a little of
    // that slack back for a bigger "popular" pool (drives view=popular's
    // home card count) without reintroducing the subrequest exhaustion.
    const popular = allPopular.slice(0, 12);
    // Naver ranking pages often expose legacy rankingRead links. Those links
    // are useful for ranking discovery but frequently return no article body
    // to Workers. Resolve the ranked headline back to its current article URL
    // before fetching and summarizing it.
    const resolvedPopular = await Promise.all(popular.map(async row => {
      if (row.source !== 'NAVER') return row;
      try {
        let matches = await naverSearch(env, `"${row.title}"`, 1, 5);
        const wanted = cleanTitle(row.title).replace(/[^0-9A-Za-z가-힣]/g, '');
        let match = matches.find(item => cleanTitle(item.title).replace(/[^0-9A-Za-z가-힣]/g, '') === wanted)
          || matches.find(item => titleSimilarity(row.title, item.title) >= 0.72);
        if (!match) {
          matches = await naverSearch(env, row.title, 1, 5);
          match = matches.find(item => titleSimilarity(row.title, item.title) >= 0.72);
        }
        // Prefer the publisher's original URL. Naver article pages frequently
        // return an empty/blocked body to Workers even when they open normally
        // in a browser, while the publisher page remains readable.
        const resolvedUrl = match?.originallink || match?.link || '';
        if (resolvedUrl) return { ...row, href: resolvedUrl };
      } catch {}
      return row;
    }));
    diagnostics.popular_resolved = resolvedPopular.filter((row, index) => row.href !== popular[index].href).length;
    diagnostics.popular_found = popular.length;
    for (const row of resolvedPopular) candidates.push({
      category: row.category,
      source: row.source,
      isPopular: true,
      popularityRank: row.rank,
      item: { title: row.title, link: row.href, originallink: row.href, description: '', pubDate: '' }
    });
    for (const row of resolvedPopular) {
      const key = await sha256(canonicalUrl(row.href));
      await env.DB.prepare(`INSERT INTO news_popularity(url_key,score,rank,source,collected_at)
        VALUES(?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(url_key) DO UPDATE SET
        score=excluded.score,rank=excluded.rank,source=excluded.source,collected_at=CURRENT_TIMESTAMP`)
        .bind(key, 101 - row.rank, row.rank, row.source).run();
      await env.DB.prepare(`INSERT INTO news_popular_items(title,url_key,score,rank,source,collected_at)
        VALUES(?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(title) DO UPDATE SET
        url_key=excluded.url_key,score=excluded.score,rank=excluded.rank,source=excluded.source,collected_at=CURRENT_TIMESTAMP`)
        .bind(row.title, key, 101 - row.rank, row.rank, row.source).run();
    }
  } catch (error) {
    diagnostics.popular_error = String(error?.message || error).slice(0, 120);
  }

  const candidateUrl = ({ item, source }) => canonicalUrl(
    source === 'NAVER' && /naver\.com\//i.test(item?.link || '') ? item.link : (item?.originallink || item?.link)
  );
  const processCandidate = async ({ category, item, source, isPopular = false, urlKey: knownUrlKey = '' }) => {
    const outcome = reason => {
      diagnostics.candidate_outcomes ||= {};
      diagnostics.candidate_outcomes[reason] = Number(diagnostics.candidate_outcomes[reason] || 0) + 1;
      diagnostics.candidate_outcomes_by_category ||= {};
      const bucket = category === '바둑' ? 'baduk' : 'general';
      diagnostics.candidate_outcomes_by_category[bucket] ||= {};
      diagnostics.candidate_outcomes_by_category[bucket][reason]
        = Number(diagnostics.candidate_outcomes_by_category[bucket][reason] || 0) + 1;
      return 0;
    };
    const url = candidateUrl({ item, source });
    const title = cleanTitle(item.title);
    const publishedAt = parseDate(item.pubDate);
    if (!url || !title || GENERIC_TITLES.has(title) || isRejectedTitle(title) || !/^https?:\/\//.test(url)) return outcome('invalid_metadata');
    if (!allowedCandidate(url, source)) return outcome('disallowed_url');
    if (publishedAt && Date.parse(publishedAt) < Date.now() - 30 * 86400000) return outcome('too_old');
    const press = item.press || pressFromTitle(item.title);
    const urlKey = knownUrlKey || await sha256(url);
    const exists = await env.DB.prepare('SELECT id,title,image_url,summary_quality,raw_summary,body_text,category,published_at FROM news_articles WHERE url_key=?').bind(urlKey).first();
    if (exists) {
      if (exists.summary_quality === 'full') {
        // 이미 발행된 기사는 제목을 다시 쓰지 않는다. 단 하나, 예전 cleanTitle이
        // 공백 없는 하이픈을 언론사 꼬리표로 오인해 잘라 저장한 제목만 되살린다
        // ("전북바둑협회-장쑤성 청소년 바둑대회 성료" -> "전북바둑협회").
        // 지금 검색 결과가 저장본으로 시작하면서 더 길 때만 늘리므로, 다른
        // 기사의 제목으로 바뀌는 일은 없다. 앞부분인지 볼 때 공백은 무시한다.
        // 검색 API가 준 제목은 띄어쓰기가 저장본과 다른 경우가 흔해서
        // ("전북 바둑협회"로 저장된 기사의 원문 제목은 "전북바둑협회-...")
        // 글자 그대로 비교하면 정작 고쳐야 할 행을 그냥 지나쳤다.
        if (titleIsTruncationOf(String(exists.title || ''), title)) {
          await env.DB.prepare('UPDATE news_articles SET title=? WHERE id=?').bind(title, exists.id).run();
          diagnostics.titles_restored = Number(diagnostics.titles_restored || 0) + 1;
        }
        const existingDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(String(exists.published_at || ''));
        const hasSyntheticTime = /T12:00:00\.000Z$/.test(String(exists.published_at || ''));
        const hasDateOnly = isPopular && existingDateOnly;
        const hasMissingTime = !String(exists.published_at || '').trim();
        const hasGenericImage = /baduk\.or\.kr\/images\/common\//i.test(String(exists.image_url || ''));
        // TRUSTED_BADUK (baduk.or.kr) never has a real timestamp, only a date
        // (see koreanBadukLatest, which now sends noon-KST for that date via
        // publishedAt). A literal date-only value here would otherwise never
        // get repaired by the generic path below, which is gated on isPopular
        // and refuses to overwrite a value with ''.
        if (source === 'TRUSTED_BADUK' && existingDateOnly && publishedAt) {
          await env.DB.prepare('UPDATE news_articles SET published_at=? WHERE id=?').bind(publishedAt, exists.id).run();
        }
        if (!exists.image_url || hasSyntheticTime || hasDateOnly || hasMissingTime || hasGenericImage) {
          const fetchUrl = /^https?:\/\/(?:n\.)?news\.naver\.com\//i.test(item.link || '') ? item.link : url;
          let article = await fetchArticleText(fetchUrl);
          if (article.body.length < 300 && fetchUrl !== url) article = await fetchArticleText(url);
          await env.DB.prepare(`UPDATE news_articles SET
            category=CASE WHEN ?<>'' THEN ? ELSE category END,
            press=CASE WHEN ?<>'' THEN ? ELSE press END,
            image_url=CASE WHEN ?<>'' THEN ? ELSE image_url END,
            body_text=CASE WHEN ?<>'' THEN ? ELSE body_text END,
            published_at=CASE WHEN ?<>'' THEN ? ELSE published_at END WHERE id=?`)
            .bind(exists.category === '바둑' ? '' : article.sectionCategory,
              exists.category === '바둑' ? '' : article.sectionCategory,
              article.press, article.press, article.image, article.image, article.body, article.body,
              article.publishedAt || publishedAt, article.publishedAt || publishedAt, exists.id).run();
        }
        return outcome('existing_full');
      }
      const fetchUrl = /^https?:\/\/(?:n\.)?news\.naver\.com\//i.test(item.link || '') ? item.link : url;
      let article = await fetchArticleText(fetchUrl);
      if (article.body.length < 300 && fetchUrl !== url) article = await fetchArticleText(url);
        const retryDetail = {};
        const repaired = await summarize({ title, rawSummary: stripHtml(item.description) || exists.raw_summary, body: article.body || exists.body_text, category }, retryDetail, 'retry');
        const valid = validPublishedSummary(repaired, title, exists.category || category);
        await env.DB.prepare(`UPDATE news_articles SET
          title=?,
          category=CASE WHEN ?<>'' THEN ? ELSE category END,
          press=CASE WHEN ?<>'' THEN ? ELSE press END,
          image_url=CASE WHEN ?<>'' THEN ? ELSE image_url END,
          body_text=CASE WHEN ?<>'' THEN ? ELSE body_text END,
          published_at=CASE WHEN ?<>'' THEN ? ELSE published_at END,
          summary=CASE WHEN ? THEN ? ELSE summary END,
          summary_quality=CASE WHEN ? THEN 'full' ELSE summary_quality END
          WHERE id=?`).bind(title,
            exists.category === '바둑' ? '' : article.sectionCategory,
            exists.category === '바둑' ? '' : article.sectionCategory,
            article.press, article.press, article.image, article.image, article.body, article.body,
            article.publishedAt || publishedAt, article.publishedAt || publishedAt,
            valid ? 1 : 0, repaired, valid ? 1 : 0, exists.id).run();
        if (valid && exists.summary_quality !== 'full') {
          await env.DB.prepare('DELETE FROM news_summary_attempts WHERE url_key=?').bind(urlKey).run();
          consumePublicationCapacity(exists.category || category);
        } else if (retryDetail.ai_attempted && !retryDetail.ai_error) {
          await env.DB.prepare(`INSERT INTO news_summary_attempts(url_key,attempts,last_attempt) VALUES(?,1,CURRENT_TIMESTAMP)
            ON CONFLICT(url_key) DO UPDATE SET attempts=attempts+1,last_attempt=CURRENT_TIMESTAMP`).bind(urlKey).run();
        }
      return outcome(valid ? 'existing_repaired' : 'existing_repair_failed');
    }

    const bucket = publicationBucket(category);
    if (!popularityTargetStart && publicationCounts[bucket].daily >= DAILY_CATEGORY_PUBLISH_LIMIT) {
      return outcome('daily_publish_limit');
    }

    const rawSummary = stripHtml(item.description);
    const fetchUrl = /^https?:\/\/(?:n\.)?news\.naver\.com\//i.test(item.link || '') ? item.link : url;
    let article = await fetchArticleText(fetchUrl);
    if (article.body.length < 300 && fetchUrl !== url) article = await fetchArticleText(url);
    const body = article.body;
    const resolvedPublishedAt = article.publishedAt || publishedAt;
    const resolvedPress = article.press || press;
    if (category !== '바둑' && !isPopular && LOCAL_GENERAL_PRESS.test(resolvedPress)) return outcome('local_general_filtered');
    // Search snippets are discovery data, not an article body. Never create a
    // three-line card when the destination page is missing or cannot be read.
    if (body.length < 180) {
      // Which hosts fail and *why* (blocked/non-html vs. fetched fine but no
      // selector matched) determines whether the fix is a selector tweak or a
      // source that can never be scraped this way. Without this,
      // "body_too_short: 12" gives no lead on what to try next.
      if (category !== '바둑') {
        diagnostics.body_too_short_hosts ||= {};
        try {
          const host = new URL(fetchUrl).hostname;
          const key = `${host}:${article.fetchStatus || 'unknown'}`;
          diagnostics.body_too_short_hosts[key] = Number(diagnostics.body_too_short_hosts[key] || 0) + 1;
        } catch {}
      }
      return outcome('body_too_short');
    }
    const finalCategory = category === '바둑'
      ? classify(category, title, body || rawSummary)
      : (article.sectionCategory || classify(category, title, body || rawSummary));
    const summary = await summarize({ title, rawSummary, body, category: finalCategory });
    const validSummary = validPublishedSummary(summary, title, finalCategory);

    await env.DB.prepare(`
      INSERT INTO news_articles
        (url,url_key,title,source,press,category,published_at,raw_summary,body_text,summary,summary_quality,image_url)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(url_key) DO UPDATE SET
        title=excluded.title, press=excluded.press, category=excluded.category,
        published_at=excluded.published_at, raw_summary=excluded.raw_summary,
        body_text=CASE WHEN length(excluded.body_text)>length(news_articles.body_text) THEN excluded.body_text ELSE news_articles.body_text END,
        summary=CASE WHEN length(excluded.summary)>length(news_articles.summary) THEN excluded.summary ELSE news_articles.summary END,
        summary_quality=excluded.summary_quality
    `).bind(
      url, urlKey, title, articleSource(url, source, article.press || press), article.press || press, finalCategory, resolvedPublishedAt, rawSummary,
      body, validSummary ? summary : '', validSummary ? 'full' : 'none', article.image
    ).run();
    if (validSummary) consumePublicationCapacity(finalCategory);
    outcome(validSummary ? 'inserted_publishable' : 'inserted_pending_summary');
    return 1;
  };
  const uniqueCandidates = [];
  const candidateUrls = new Set();
  for (const candidate of candidates) {
    const key = candidateUrl(candidate);
    if (!key || candidateUrls.has(key)) continue;
    candidateUrls.add(key);
    uniqueCandidates.push({ ...candidate, urlKey: await sha256(key) });
  }
  const knownCandidateKeys = new Set();
  if (uniqueCandidates.length) {
    const placeholders = uniqueCandidates.map(() => '?').join(',');
    const knownRows = await env.DB.prepare(`SELECT url_key FROM news_articles WHERE url_key IN (${placeholders})`)
      .bind(...uniqueCandidates.map(candidate => candidate.urlKey)).all();
    for (const row of knownRows.results || []) knownCandidateKeys.add(row.url_key);
  }
  uniqueCandidates.sort((a, b) => {
    // Official baduk.or.kr candidates are few (<=12) and high-trust, so a new
    // one should never lose its slot to noisy generic-search candidates that
    // mostly fail allowedCandidate(). But once an official item is already
    // stored, it doesn't need a slot every single run - only boost it while
    // it's still new, or every already-published TRUSTED_BADUK item
    // permanently occupies most of the fixed-size baduk batch forever and
    // starves out every other source (which is what happened here).
    const trustedNewOrder = Number(b.source === 'TRUSTED_BADUK' && !knownCandidateKeys.has(b.urlKey))
      - Number(a.source === 'TRUSTED_BADUK' && !knownCandidateKeys.has(a.urlKey));
    if (trustedNewOrder) return trustedNewOrder;
    const newOrder = Number(knownCandidateKeys.has(a.urlKey)) - Number(knownCandidateKeys.has(b.urlKey));
    if (newOrder) return newOrder;
    const badukOrder = Number(b.category === '바둑') - Number(a.category === '바둑');
    if (badukOrder) return badukOrder;
    const popularOrder = Number(Boolean(b.isPopular)) - Number(Boolean(a.isPopular));
    if (popularOrder) return popularOrder;
    const recentOrder = (Date.parse(b.item?.pubDate || '') || 0) - (Date.parse(a.item?.pubDate || '') || 0);
    if (recentOrder) return recentOrder;
    return Number(a.popularityRank || 999) - Number(b.popularityRank || 999);
  });
  const limitedCandidates = popularityCandidates.length
    ? uniqueCandidates.slice(popularityOffset, popularityOffset + POPULARITY_REPAIR_BATCH_SIZE)
    : (backfill ? uniqueCandidates.slice(0, 8) : [
        ...uniqueCandidates.filter(candidate => candidate.category === '바둑').slice(0, SCHEDULED_BADUK_CANDIDATES),
        ...uniqueCandidates.filter(candidate => candidate.category !== '바둑').slice(0, SCHEDULED_GENERAL_CANDIDATES)
      ]);
  diagnostics.general_recent_publishable = Number(recentGeneral?.count || 0);
  diagnostics.general_daily_goal = 10;
  diagnostics.google_discovery_resolve_skipped = generalBelowDailyGoal;
  diagnostics.candidates = candidates.length;
  diagnostics.unique_candidates = uniqueCandidates.length;
  diagnostics.new_candidates = uniqueCandidates.filter(candidate => !knownCandidateKeys.has(candidate.urlKey)).length;
  diagnostics.existing_candidates = uniqueCandidates.length - diagnostics.new_candidates;
  diagnostics.processed_candidates = limitedCandidates.length;
  diagnostics.processed_by_category = {
    baduk: limitedCandidates.filter(candidate => candidate.category === '바둑').length,
    general: limitedCandidates.filter(candidate => candidate.category !== '바둑').length
  };
  let inserted = 0;
  const badukRetries = pendingRetries.filter(row => row.category === '바둑');
  const generalRetries = pendingRetries.filter(row => row.category !== '바둑');
  const badukCandidates = limitedCandidates.filter(candidate => candidate.category === '바둑');
  const generalCandidates = limitedCandidates.filter(candidate => candidate.category !== '바둑');
  // General is processed first, baduk second. Every fetchArticleText call is
  // a Worker subrequest, and a single invocation has a hard subrequest cap;
  // once the search/popularity-resolution phase above and a batch of baduk
  // candidates had already spent it, every general fetch failed with
  // "Too many subrequests by single Worker invocation" - not a bad URL or a
  // missing selector, an exception thrown before those checks ever ran. Baduk
  // was already hitting its daily goal even starved of leftover budget, so
  // give general first claim on it instead.
  for (const row of generalRetries) await retrySummary(row);
  for (const candidate of generalCandidates) inserted += await processCandidate(candidate);
  for (const row of badukRetries) await retrySummary(row);
  for (const candidate of badukCandidates) inserted += await processCandidate(candidate);
  diagnostics.publish_counts_after = publicationCounts;
  if (popularityTargetStart) diagnostics.popularity_target_counts_after = popularityTargetCounts;
  return { inserted, diagnostics };
}

export async function onRequestPost({ request, env }) {
  if (!isCollectorAuthorized(request, env)) return json({ ok: false, error: 'Unauthorized' }, 401);
  let runId;
  try {
    await ensureNewsDb(env);
    await env.DB.prepare(`UPDATE news_runs SET finished_at=?,status='error',message='이전 수집이 비정상 종료됨'
      WHERE status='running' AND datetime(started_at) < datetime('now','-10 minutes')`).bind(new Date().toISOString()).run();
    // Bound operational tables so years of scheduled runs do not gradually
    // turn every status/popularity query into an ever-growing scan.
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM news_runs WHERE id NOT IN
        (SELECT id FROM news_runs ORDER BY id DESC LIMIT 500)`),
      env.DB.prepare("DELETE FROM news_popularity WHERE datetime(collected_at)<datetime('now','-60 days')"),
      env.DB.prepare("DELETE FROM news_popular_items WHERE datetime(collected_at)<datetime('now','-60 days')"),
      env.DB.prepare(`DELETE FROM news_summary_attempts WHERE url_key IN
        (SELECT url_key FROM news_articles WHERE summary_quality='full')`)
    ]);
    const started = new Date().toISOString();
    const run = await env.DB.prepare("INSERT INTO news_runs(started_at,status) VALUES(?,'running') RETURNING id").bind(started).first();
    runId = run?.id;
    const requestUrl = new URL(request.url);
    const requestedSource = requestUrl.searchParams.get('source') || 'manual';
    const runSource = ['scheduled', 'watchdog', 'manual'].includes(requestedSource) ? requestedSource : 'manual';
    const backfill = requestUrl.searchParams.get('backfill') === '1';
    const repair = requestUrl.searchParams.get('repair') === '1';
    const forceRetry = requestUrl.searchParams.get('force_retry') === '1';
    const generalBoost = requestUrl.searchParams.get('general_boost') === '1';
    const repairTimes = requestUrl.searchParams.get('repair_times') === '1';
    const repairCategories = requestUrl.searchParams.get('repair_categories') === '1';
    const resetCategories = requestUrl.searchParams.get('reset_categories') === '1';
    const repairGeneralQuality = requestUrl.searchParams.get('repair_general_quality') === '1';
    const popularityDate = requestUrl.searchParams.get('popularity_date') || '';
    const popularityOffset = Math.max(0, Math.min(Number(requestUrl.searchParams.get('popularity_offset')) || 0, 48));
    const repairTitles = requestUrl.searchParams.get('repair_titles') === '1';
    if (repairTitles) {
      const titleQuery = (requestUrl.searchParams.get('q') || '').trim().slice(0, 100);
      const titleRepair = titleQuery
        ? await repairTitleByQuery(env, titleQuery)
        : await repairTruncatedTitles(env, 10, requestUrl.searchParams.get('reset') === '1');
      await env.DB.prepare("UPDATE news_runs SET finished_at=?,status='ok',inserted_count=0,message=? WHERE id=?")
        .bind(new Date().toISOString(), JSON.stringify({ title_repair: titleRepair }).slice(0, 500), runId).run();
      return json({ ok: true, title_repair: titleRepair });
    }
    if (repairTimes) {
      const timeRepair = await repairGeneralArticleTimes(env);
      await env.DB.prepare("UPDATE news_runs SET finished_at=?,status='ok',inserted_count=0,message=? WHERE id=?")
        .bind(new Date().toISOString(), JSON.stringify({ time_repair: timeRepair }), runId).run();
      return json({ ok: true, time_repair: timeRepair });
    }
    if (repairCategories) {
      const categoryRepair = await repairGeneralCategories(env, 10, resetCategories);
      await env.DB.prepare("UPDATE news_runs SET finished_at=?,status='ok',inserted_count=0,message=? WHERE id=?")
        .bind(new Date().toISOString(), JSON.stringify({ category_repair: categoryRepair }), runId).run();
      return json({ ok: true, category_repair: categoryRepair });
    }
    if (repairGeneralQuality) {
      const qualityRepair = await quarantineWeakGeneralSummaries(env);
      const result = await collect(env, {
        repair: true, forceRetry: true, generalBoost: true, generalOnly: true,
        qualityRepairIds: qualityRepair.ids
      });
      await env.DB.prepare("UPDATE news_runs SET finished_at=?,status='ok',inserted_count=0,message=? WHERE id=?")
        .bind(new Date().toISOString(), JSON.stringify({ quality_repair: qualityRepair, diagnostics: result.diagnostics }).slice(0, 500), runId).run();
      return json({ ok: true, quality_repair: qualityRepair, diagnostics: result.diagnostics });
    }
    if (popularityDate) {
      const popularity = await backfillPopularityDate(env, popularityDate);
      const parsedPopularityDate = Date.parse(`${popularityDate.slice(0, 4)}-${popularityDate.slice(4, 6)}-${popularityDate.slice(6, 8)}T00:00:00Z`);
      const result = await collect(env, {
        forceRetry: true,
        popularityCandidates: popularity.rows.map(row => ({ ...row, popularityDate: parsedPopularityDate })),
        popularityOffset
      });
      // Old popularity repairs stored a made-up noon UTC timestamp, which
      // rendered as 9 PM in Korea. After trying to recover the real timestamp
      // from each article, downgrade only the remaining synthetic values for
      // this ranking day to an honest date-only value.
      const targetDate = `${popularityDate.slice(0, 4)}-${popularityDate.slice(4, 6)}-${popularityDate.slice(6, 8)}`;
      const cleared = await env.DB.prepare(`UPDATE news_articles
        SET published_at=substr(published_at,1,10)
        WHERE published_at=?`).bind(`${targetDate}T12:00:00.000Z`).run();
      result.diagnostics.synthetic_times_cleared = Number(cleared?.meta?.changes || 0);
      await env.DB.prepare("UPDATE news_runs SET finished_at=?,status='ok',inserted_count=?,message=? WHERE id=?")
        .bind(new Date().toISOString(), result.inserted,
          JSON.stringify({ popularity: { date: popularity.date, ranking_items: popularity.ranking_items }, diagnostics: result.diagnostics }).slice(0, 500), runId).run();
      return json({
        ok: true,
        popularity: { date: popularity.date, ranking_items: popularity.ranking_items },
        inserted: result.inserted,
        diagnostics: result.diagnostics
      });
    }
    let payload = {};
    try {
      if ((request.headers.get('content-type') || '').includes('application/json')) payload = await request.json();
    } catch {}
    const googleDiscoveries = Array.isArray(payload?.googleDiscoveries) ? payload.googleDiscoveries : [];
    const result = await collect(env, { backfill, repair, forceRetry, generalBoost, googleDiscoveries });
    result.diagnostics.mode = runSource;
    const warnings = Object.entries(result.diagnostics)
      .filter(([key, value]) => /_error$/.test(key) && value)
      .map(([key, value]) => `${key}: ${value}`);
    if (result.diagnostics.ai_provider_limited) warnings.push('ai_provider_limited');
    const status = warnings.length ? 'degraded' : 'ok';
    const message = JSON.stringify({ warnings, diagnostics: result.diagnostics }).slice(0, 500);
    await env.DB.prepare("UPDATE news_runs SET finished_at=?,status=?,inserted_count=?,message=? WHERE id=?")
      .bind(new Date().toISOString(), status, result.inserted, message, runId).run();
    return json({ ok: true, status, warnings, ...result });
  } catch (error) {
    if (runId) {
      await env.DB.prepare("UPDATE news_runs SET finished_at=?,status='error',message=? WHERE id=?")
        .bind(new Date().toISOString(), String(error.message || error).slice(0, 500), runId).run();
    }
    return json({ ok: false, error: error.message }, 500);
  }
}
