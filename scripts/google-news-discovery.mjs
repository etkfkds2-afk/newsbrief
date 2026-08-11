import { BADUK_SEARCH_QUERIES as queries } from '../functions/_lib/baduk-queries.js';

function text(block, tag) {
  return (block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1] || '')
    .replace(/^<!\[CDATA\[|\]\]>$/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').trim();
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchWithRetry(input, init = {}, { attempts = 3, timeout = 12000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(input, { ...init, signal: controller.signal });
      if (response.ok || response.status < 500 || attempt === attempts - 1) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1) throw error;
    } finally {
      clearTimeout(timer);
    }
    await wait(300 * (2 ** attempt));
  }
  throw lastError || new Error('Request failed');
}

const token = process.env.NEWSBRIEF_COLLECT_TOKEN;
if (!token) throw new Error('NEWSBRIEF_COLLECT_TOKEN is missing');
const full = process.env.NEWSBRIEF_BACKFILL === '1';
const generalBoost = process.env.NEWSBRIEF_GENERAL_BOOST === '1';
const hourSlot = Math.floor(Date.now() / 1800000);
const selected = full ? queries : Array.from({ length: 8 }, (_, i) => queries[(hourSlot * 8 + i) % queries.length]);
const found = new Map();
for (const query of selected) {
  const endpoint = new URL('https://news.google.com/rss/search');
  endpoint.searchParams.set('q', `${query} when:30d`);
  endpoint.searchParams.set('hl', 'ko'); endpoint.searchParams.set('gl', 'KR'); endpoint.searchParams.set('ceid', 'KR:ko');
  const response = await fetchWithRetry(endpoint, { headers: { 'user-agent': 'Mozilla/5.0 NewsBrief personal feed reader' } });
  if (!response.ok) continue;
  const xml = await response.text();
  let addedForQuery = 0;
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const raw = text(match[1], 'title');
    const parts = raw.split(/\s+-\s+/); const press = parts.length > 1 ? parts.pop() : '';
    const title = parts.join(' - ') || raw;
    if (title.length >= 8 && !found.has(title)) {
      found.set(title, { title, press, pubDate: text(match[1], 'pubDate'), link: text(match[1], 'link') });
      addedForQuery += 1;
    }
    // Sample every rotated query instead of letting one broad query fill the
    // entire payload with near-duplicate or repeatedly unresolvable headlines.
    if (addedForQuery >= (full ? 10 : 5) || found.size >= (full ? 100 : 40)) break;
  }
  if (found.size >= (full ? 100 : 40)) break;
}
const collectUrl = new URL('https://newsbrief-etkfkds2.pages.dev/api/news/collect');
collectUrl.searchParams.set('source', process.env.NEWSBRIEF_RUN_SOURCE || 'scheduled');
if (full) collectUrl.searchParams.set('backfill', '1');
if (generalBoost) collectUrl.searchParams.set('general_boost', '1');
const endpoint = collectUrl.toString();
const discoveries = [...found.values()];
const response = await fetchWithRetry(endpoint, {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ googleDiscoveries: discoveries })
}, { attempts: 3, timeout: 180000 });
const result = await response.text();
console.log(`Google discoveries=${found.size} collector=${response.status} ${result}`);

// 바둑 전용 호출에도 같은 헤드라인을 넘긴다. 예전에는 이 스크립트가 위 한 곳에만
// POST했고, deploy.yml의 baduk_only curl은 본문 없이 호출돼서 디스커버리를
// 하나도 못 받았다. 바둑에 자기 subrequest 예산을 주려고 따로 만든 호출인데
// 정작 가장 좋은 후보 목록이 그 호출에는 안 갔던 것이다. 그래서 그 호출은
// 자체 RSS 폴백 3건에만 의존했다.
//
// 이 POST는 위 호출과 같은 헤드라인을 보내지만, url_key가 같은 기사는 D1에서
// 이미 발행된 것으로 걸러지므로 중복 처리가 아니라 못 다룬 나머지를 훑는 셈이다.
// 실패해도 위 수집은 이미 끝났으므로 경고만 남기고 성공으로 둔다.
if (!full && discoveries.length) {
  const badukUrl = new URL('https://newsbrief-etkfkds2.pages.dev/api/news/collect');
  badukUrl.searchParams.set('source', process.env.NEWSBRIEF_RUN_SOURCE || 'scheduled');
  badukUrl.searchParams.set('baduk_only', '1');
  try {
    const badukResponse = await fetchWithRetry(badukUrl.toString(), {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ googleDiscoveries: discoveries })
    }, { attempts: 2, timeout: 180000 });
    console.log(`Baduk-only collector=${badukResponse.status} ${await badukResponse.text()}`);
  } catch (error) {
    console.warn(`::warning::Baduk-only collection failed: ${error?.message || error}`);
  }
}
if (!response.ok) {
  process.exitCode = 1;
} else {
  try {
    const payload = JSON.parse(result);
    if (payload.status === 'degraded') {
      const warning = `Collector degraded: ${(payload.warnings || []).join(', ')}`;
      console.warn(`::warning::${warning}`);
      // Optional providers may be unavailable while the core collector and
      // existing feed remain healthy. Preserve the warning in D1/Actions, but
      // do not turn a Google-only outage into a whole-service outage.
    }
  } catch {
    console.error('Collector returned a non-JSON response');
    process.exitCode = 1;
  }
}
