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

const SEARCHES = [
  ['바둑', '바둑 대회 프로기사'],
  ['정치', '정치'], ['경제', '경제'], ['사회', '사회'],
  ['생활/문화', '생활 문화'], ['세계', '국제'],
  ['IT/과학', '과학 기술']
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
const DAILY_ANTHROPIC_CALL_LIMIT = 12;
const BACKFILL_ANTHROPIC_CALL_LIMIT = 200;
const ESTIMATED_SUMMARY_CALL_MICRO_USD = 15_000;
const MAX_SCHEDULED_CANDIDATES = 10;
const MAINTENANCE_BATCH_SIZE = 40;

const BODY_JUNK = /(?:무단전재|재배포\s*금지|저작권자|구독|로그인|회원가입|제보|관련기사|추천뉴스|많이\s*본\s*뉴스|기사제공|기자\s*[A-Z0-9._%+-]+@|기사의?\s*본문\s*내용|글자\s*크기|인쇄하기|공유하기)/i;
const DEAD_PAGE = /(?:존재하지\s*않는\s*페이지|요청하신\s*페이지를\s*찾을\s*수\s*없|삭제된\s*기사|기사가\s*존재하지\s*않|page\s*not\s*found|\b404\b)/i;

function validPublishedSummary(summary, title, category) {
  return validateThreeLineSummary(summary, title)
    && (category === '바둑' || validateGeneralEditorialSummary(summary, title));
}

export function isBadukRelevant(title, body = '') {
  const titleText = String(title || '');
  if (/(?:바둑|대국|기전|한국기원|대한바둑협회|신진서|최정\s*9단|카타고|프로기사)/i.test(titleText)) return true;
  const bodyText = String(body || '').slice(0, 5000);
  const signals = [
    /바둑/i, /한국기원/i, /대한바둑협회/i, /신진서/i, /최정\s*9단/i,
    /카타고/i, /(?:프로|아마추어)\s*기사/i, /(?:본선|결승|예선)\s*대국/i, /바둑리그/i
  ];
  return signals.filter(pattern => pattern.test(bodyText)).length >= 2;
}

function classify(category, title, body = '') {
  const titleText = String(title || '');
  const bodyText = String(body || '').slice(0, 800);
  if (isBadukRelevant(titleText, bodyText)) return '바둑';
  const rules = [
    ['사회', /(?:폭행|살인|사망|숨진|경찰|검찰|법원|사건|사고|성매매|성범죄|조폭|검거|재판|수사|학교|교사|학생)/],
    ['경제', /(?:증시|주가|금리|환율|기업|투자|금융|부동산|아파트|원유|산업|수출|매출|순이익)/],
    ['정치', /(?:대통령|국회|국회의원|민주당|국민의힘|선거|정당|총리|장관|외교부|정부\s*정책)/],
    ['IT/과학', /(?:인공지능|\bAI\b|반도체|과학|로봇|스마트폰|소프트웨어|클라우드|우주)/i],
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
    .replace(/\s*[-|–—]\s*[^-|–—]{1,30}$/u, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
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
  const date = new Date(value || '');
  return Number.isNaN(date.valueOf()) ? '' : date.toISOString();
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
    if (discovery === 'KAKAO') return host === 'v.daum.net' || host.endsWith('.news.daum.net') || host === 'news.daum.net';
    return !/(?:dcinside\.com|tistory\.com|blog\.naver\.com|cafe\.naver\.com|fmkorea\.com|theqoo\.net|ruliweb\.com|clien\.net|ppomppu\.co\.kr|instiz\.net|youtube\.com|namu\.wiki)$/i.test(host);
  } catch { return false; }
}

async function fetchArticleText(url) {
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 NewsBrief/Cloudflare' },
      cf: { cacheTtl: 300, cacheEverything: false }
    });
    if (!response.ok) return { body: '', image: '', press: '' };
    const type = response.headers.get('content-type') || '';
    if (!type.includes('text/html')) return { body: '', image: '', press: '' };
    const html = (await response.text()).slice(0, 800000);
    if (DEAD_PAGE.test(html.slice(0, 30000))) return { body: '', image: '', press: '' };
    const image = normalizeText(html.match(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)/i)?.[1]
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image)["']/i)?.[1] || '');
    const siteName = cleanPressName(html.match(/<meta[^>]+(?:property|name)=["']og:site_name["'][^>]+content=["']([^"']+)/i)?.[1]
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:site_name["']/i)?.[1] || '');
    let jsonBody = '';
    for (const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
      try {
        const data = JSON.parse(match[1]);
        for (const found of findArticleBodies(data)) if (found.length > jsonBody.length) jsonBody = found;
      } catch {}
    }
    const articleStart = html.search(/<(?:article|div)[^>]+(?:id|class)=["'][^"']*(?:dic_area|article_view|article-body|newsct_article|article_body|articleBody|news_body|view_cont)[^"']*["'][^>]*>/i);
    const article = articleStart >= 0 ? html.slice(articleStart, Math.min(html.length, articleStart + 180000)) : '';
    const body = cleanBody(jsonBody || stripHtml(article
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')));
    return { body, image: /^https?:\/\//.test(image) ? image : '', press: siteName };
  } catch {
    return { body: '', image: '', press: '' };
  }
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
  const selected = [pages[slot % 5], pages[5]];
  const rows = [];
  for (const [url, source, category] of selected) rows.push(...(await popularPage(url, source)).map(row => ({ ...row, category })));
  return rows;
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

async function reserveAnthropicCall(env, diagnostics, forceRetry = false) {
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
  const dailyLimit = forceRetry ? BACKFILL_ANTHROPIC_CALL_LIMIT : DAILY_ANTHROPIC_CALL_LIMIT;
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

async function collect(env, { backfill = false, repair = false, forceRetry = false, googleDiscoveries = [] } = {}) {
  const diagnostics = { mode: backfill ? 'backfill' : 'scheduled', retry_attempted: 0, retry_repaired: 0, samples: [] };
  const summarize = async (payload, detail, purpose = 'new') => {
    const trace = detail || {};
    const sourceLength = normalizeText(payload.body || payload.rawSummary).length;
    if (sourceLength < 300) {
      return payload.category === '바둑'
        ? makeBestSummary({ AI: undefined, ANTHROPIC_API_KEY: undefined }, payload, trace)
        : '';
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

    if (env.ANTHROPIC_API_KEY && await reserveAnthropicCall(env, diagnostics, forceRetry)) {
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

    if (payload.category !== '바둑') return '';
    return summary || makeBestSummary({ AI: undefined, ANTHROPIC_API_KEY: undefined }, payload, trace);
  };
  // Maintenance is deliberately bounded. Scanning and updating the complete
  // archive on every request exhausted the Pages Worker CPU during backfills.
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
  const retryRowLimit = repair ? 4 : (backfill ? 4 : 3);
  const retryRows = await env.DB.prepare(`SELECT a.id,a.url_key,a.title,a.raw_summary,a.body_text,a.category FROM news_articles a
    LEFT JOIN news_summary_attempts f ON f.url_key=a.url_key
    WHERE a.summary_quality='none' AND length(a.body_text)>=300 AND COALESCE(f.attempts,0)<?
      AND (? OR f.last_attempt IS NULL OR f.last_attempt < datetime('now','-20 hours'))
    ORDER BY CASE WHEN a.category='바둑' THEN 0 ELSE 1 END,
      COALESCE(f.attempts,0), COALESCE(f.last_attempt,'1970-01-01'), length(a.body_text) DESC LIMIT ?`)
    .bind(24, forceRetry ? 1 : 0, retryRowLimit).all();
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
      diagnostics.retry_repaired += 1;
    } else if (detail.ai_attempted && !detail.ai_error) {
      await env.DB.prepare(`INSERT INTO news_summary_attempts(url_key,attempts,last_attempt) VALUES(?,1,CURRENT_TIMESTAMP)
        ON CONFLICT(url_key) DO UPDATE SET attempts=attempts+1,last_attempt=CURRENT_TIMESTAMP`).bind(row.url_key).run();
    }
  };
  const pendingRetries = retryRows.results || [];
  const candidates = [];
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
  const selectedSearches = backfill
    ? SEARCHES.filter(([category]) => category === '바둑')
    : [SEARCHES[0], generalSearches[slot % generalSearches.length], generalSearches[(slot + 1) % generalSearches.length]];
  for (const [category, query] of selectedSearches) {
    // A broad "바둑" query at ever-higher offsets repeatedly returned the same small
    // set of usable portal articles. Search several distinct beats per run instead.
    const effectiveQueries = category === '바둑'
      ? Array.from({ length: backfill ? 3 : 1 }, (_, index) =>
          BADUK_SEARCHES[(slot * (backfill ? 3 : 1) + index) % BADUK_SEARCHES.length])
      : [query];
    for (const effectiveQuery of effectiveQueries) {
      const pageBand = backfill ? Math.floor(slot / Math.ceil(BADUK_SEARCHES.length / 4)) % 5 : 0;
      const start = category === '바둑' ? pageBand * 20 + 1 : (backfill ? backfillStart : 1);
      const display = category === '바둑' ? 10 : (backfill ? 10 : 4);
      const items = await naverSearch(env, effectiveQuery, start, display);
      const naverTake = category === '바둑' ? (backfill ? 4 : 3) : (backfill ? 2 : 2);
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
  // Google News is discovery-only: resolve each headline through the licensed
  // Naver API, then fetch and validate the real article like every other item.
  // Never expose a Google wrapper or its short RSS description as a summary.
  for (const discovery of googleDiscoveries.slice(0, backfill ? 20 : 2)) {
    const discoveredTitle = cleanTitle(discovery?.title || '');
    if (!discoveredTitle || isRejectedTitle(discoveredTitle)) continue;
    try {
      const matches = await naverSearch(env, `"${discoveredTitle}"`, 1, 3);
      const match = matches.find(item => {
        const candidateTitle = cleanTitle(item.title);
        const left = candidateTitle.replace(/[^0-9A-Za-z가-힣]/g, '');
        const right = discoveredTitle.replace(/[^0-9A-Za-z가-힣]/g, '');
        return left === right || (Math.min(left.length, right.length) >= 18 && (left.includes(right) || right.includes(left)));
      });
      if (match) candidates.push({ category: '바둑', item: match, source: 'NAVER' });
    } catch (error) {
      diagnostics.google_resolve_error = String(error?.message || error).slice(0, 120);
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
  if (!backfill && !googleDiscoveries.length) try {
    for (const item of (await googleNewsSearch(badukQuery, 30)).slice(0, 3)) candidates.push({ category: '바둑', item, source: 'GOOGLE' });
  } catch (error) {
    diagnostics.google_error = String(error?.message || error).slice(0, 120);
  } else if (!backfill) {
    diagnostics.google_fallback_skipped = true;
  }
  if (!backfill) try {
    const allPopular = await collectPopularity(slot);
    const popular = allPopular.slice(0, 12);
    diagnostics.popular_found = popular.length;
    for (const row of popular.filter(row => row.rank <= 2)) candidates.push({
      category: row.category,
      source: row.source,
      item: { title: row.title, link: row.href, originallink: row.href, description: '', pubDate: '' }
    });
    for (const row of popular) {
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

  const processCandidate = async ({ category, item, source }) => {
    const preferredUrl = source === 'NAVER' && /naver\.com\//i.test(item.link || '') ? item.link : (item.originallink || item.link);
    const url = canonicalUrl(preferredUrl);
    const title = cleanTitle(item.title);
    const publishedAt = parseDate(item.pubDate);
    if (!url || !title || GENERIC_TITLES.has(title) || isRejectedTitle(title) || !/^https?:\/\//.test(url)) return 0;
    if (!allowedCandidate(url, source)) return 0;
    if (publishedAt && Date.parse(publishedAt) < Date.now() - 30 * 86400000) return 0;
    const press = item.press || pressFromTitle(item.title);
    const urlKey = await sha256(url);
    const exists = await env.DB.prepare('SELECT id,image_url,summary_quality,raw_summary,body_text,category FROM news_articles WHERE url_key=?').bind(urlKey).first();
    if (exists) {
      if (!exists.image_url || exists.summary_quality !== 'full') {
        const fetchUrl = /^https?:\/\/(?:n\.)?news\.naver\.com\//i.test(item.link || '') ? item.link : url;
        let article = await fetchArticleText(fetchUrl);
        if (article.body.length < 300 && fetchUrl !== url) article = await fetchArticleText(url);
        const repaired = await summarize({ title, rawSummary: stripHtml(item.description) || exists.raw_summary, body: article.body || exists.body_text, category }, null, 'retry');
        const valid = validPublishedSummary(repaired, title, exists.category || category);
        await env.DB.prepare(`UPDATE news_articles SET
          title=?,
          press=CASE WHEN ?<>'' THEN ? ELSE press END,
          image_url=CASE WHEN ?<>'' THEN ? ELSE image_url END,
          body_text=CASE WHEN ?<>'' THEN ? ELSE body_text END,
          summary=CASE WHEN ? THEN ? ELSE summary END,
          summary_quality=CASE WHEN ? THEN 'full' ELSE summary_quality END
          WHERE id=?`).bind(title, article.press, article.press, article.image, article.image, article.body, article.body, valid ? 1 : 0, repaired, valid ? 1 : 0, exists.id).run();
      }
      return 0;
    }

    const rawSummary = stripHtml(item.description);
    const fetchUrl = /^https?:\/\/(?:n\.)?news\.naver\.com\//i.test(item.link || '') ? item.link : url;
    let article = await fetchArticleText(fetchUrl);
    if (article.body.length < 300 && fetchUrl !== url) article = await fetchArticleText(url);
    const body = article.body;
    // Search snippets are discovery data, not an article body. Never create a
    // three-line card when the destination page is missing or cannot be read.
    if (body.length < 180) return 0;
    const finalCategory = classify(category, title, body || rawSummary);
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
      url, urlKey, title, articleSource(url, source, article.press || press), article.press || press, finalCategory, publishedAt, rawSummary,
      body, validSummary ? summary : '', validSummary ? 'full' : 'none', article.image
    ).run();
    return 1;
  };
  const uniqueCandidates = [];
  const candidateUrls = new Set();
  for (const candidate of candidates) {
    const key = canonicalUrl(candidate.item?.originallink || candidate.item?.link);
    if (!key || candidateUrls.has(key)) continue;
    candidateUrls.add(key);
    uniqueCandidates.push(candidate);
  }
  uniqueCandidates.sort((a, b) => Number(b.category === '바둑') - Number(a.category === '바둑'));
  const recentGeneral = await env.DB.prepare(`SELECT COUNT(*) AS count FROM news_articles
    WHERE category<>'바둑' AND summary_quality='full'
      AND datetime(COALESCE(NULLIF(published_at,''),fetched_at))>=datetime('now','-24 hours')`).first();
  const generalBelowDailyGoal = Number(recentGeneral?.count || 0) < 10;
  const scheduledCandidateLimit = generalBelowDailyGoal ? MAX_SCHEDULED_CANDIDATES + 4 : MAX_SCHEDULED_CANDIDATES;
  const limitedCandidates = backfill ? uniqueCandidates.slice(0, 8) : uniqueCandidates.slice(0, scheduledCandidateLimit);
  diagnostics.general_recent_publishable = Number(recentGeneral?.count || 0);
  diagnostics.general_daily_goal = 10;
  diagnostics.candidates = candidates.length;
  diagnostics.unique_candidates = uniqueCandidates.length;
  diagnostics.processed_candidates = limitedCandidates.length;
  let inserted = 0;
  const badukRetries = pendingRetries.filter(row => row.category === '바둑');
  const generalRetries = pendingRetries.filter(row => row.category !== '바둑');
  const badukCandidates = limitedCandidates.filter(candidate => candidate.category === '바둑');
  const generalCandidates = limitedCandidates.filter(candidate => candidate.category !== '바둑');
  for (const row of badukRetries) await retrySummary(row);
  for (const candidate of badukCandidates) inserted += await processCandidate(candidate);
  for (const row of generalRetries) await retrySummary(row);
  for (const candidate of generalCandidates) inserted += await processCandidate(candidate);
  return { inserted, diagnostics };
}

export async function onRequestPost({ request, env }) {
  if (!isCollectorAuthorized(request, env)) return json({ ok: false, error: 'Unauthorized' }, 401);
  let runId;
  try {
    await ensureNewsDb(env);
    await env.DB.prepare(`UPDATE news_runs SET finished_at=?,status='error',message='이전 수집이 비정상 종료됨'
      WHERE status='running' AND datetime(started_at) < datetime('now','-10 minutes')`).bind(new Date().toISOString()).run();
    const started = new Date().toISOString();
    const run = await env.DB.prepare("INSERT INTO news_runs(started_at,status) VALUES(?,'running') RETURNING id").bind(started).first();
    runId = run?.id;
    const requestUrl = new URL(request.url);
    const backfill = requestUrl.searchParams.get('backfill') === '1';
    const repair = requestUrl.searchParams.get('repair') === '1';
    const forceRetry = requestUrl.searchParams.get('force_retry') === '1';
    let payload = {};
    try {
      if ((request.headers.get('content-type') || '').includes('application/json')) payload = await request.json();
    } catch {}
    const googleDiscoveries = Array.isArray(payload?.googleDiscoveries) ? payload.googleDiscoveries : [];
    const result = await collect(env, { backfill, repair, forceRetry, googleDiscoveries });
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
