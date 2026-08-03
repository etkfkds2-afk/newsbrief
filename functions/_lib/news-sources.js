// 외부에서 기사 후보를 찾아오는 계층. 네이버·카카오 검색 API, 구글 뉴스 RSS,
// 한국기원 공지, 포털 인기 랭킹 페이지를 다룬다. 어떤 후보를 채택할지(수집
// 정책)는 모르고, 가져온 목록을 그대로 돌려준다.
import { isRejectedTitle, normalizeText } from './news-summary.js';
import { cleanTitle } from './news-extract.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function naverSearch(env, query, start = 1, display = 5) {
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

export async function kakaoSearch(env, query, page = 1, size = 5) {
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

export async function fetchGoogleRss(endpoint, attempts = 3) {
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

export async function koreanBadukLatest() {
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

export async function popularPage(url, source) {
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

export async function collectPopularity(slot = 0) {
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

export async function collectArchivedTop(slot) {
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
