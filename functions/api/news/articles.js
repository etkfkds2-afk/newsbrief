import { json, userId } from '../../_lib/news-db.js';
import {
  normalizeText, reorderGeneralSummary, validateGeneralEditorialSummary, validateThreeLineSummary
} from '../../_lib/news-summary.js';
import { isBadukDisplayRelevant, isBadukRelevant } from '../../_lib/baduk-relevance.js';
import { isSameStory } from '../../_lib/news-dedup.js';
import {
  BADUK_PROMO_OUTLETS, BADUK_PROMO_TITLE_PATTERNS, BLOCKED_HOST_SQL_FILTERS
} from '../../_lib/news-blocklist.js';
import { hasLegalCaseConflict, isStandaloneEventArticle, standaloneBadukIssueTitle } from '../../_lib/news-issue-classify.js';

const CATEGORIES = new Set(['정치', '경제', '사회', '생활/문화', '세계', '바둑', '기타']);
export const CONTENT_QUALITY_FILTERS = [
  "a.summary_quality='full'", "TRIM(a.summary)<>''",
  "instr(a.title,'�')=0",
  // 커뮤니티·블로그·위키 등 뉴스가 아닌 출처는 news-blocklist.js가 관리한다.
  ...BLOCKED_HOST_SQL_FILTERS,
  // 아래는 그 목록과 별개다. 수집 단계에서는 canonicalUrl이 옛 sports.naver.com
  // 주소를 정식 기사 주소로 바꿔 통과시키므로 차단 목록에 넣지 않고, 읽을 때만 거른다.
  "lower(a.url) NOT LIKE '%sports.naver.com/%'",
  // 아래 제목·요약 문구는 수집 단계의 isRejectedTitle(news-summary.js)과 짝을
  // 이룬다. 수집기를 통과했던 시절의 행이 남아 있어 읽을 때도 거른다.
  "a.summary NOT LIKE '%글자크기%'",
  "a.summary NOT LIKE '%글자 크기%'",
  "a.summary NOT LIKE '%본문 내용은%'",
  "a.title NOT LIKE '%시세 조회로%'",
  "a.title NOT LIKE '%현명한 투자하세요%'",
  "a.title NOT LIKE '%숙소 환급 상세 안내%'",
  "a.title NOT LIKE '%자동차월드%'"
];
const NAVER_OUTLETS = {
  '001': '연합뉴스', '003': '뉴시스', '005': '국민일보', '008': '머니투데이',
  '009': '매일경제', '011': '서울경제', '014': '파이낸셜뉴스', '015': '한국경제TV',
  '016': '헤럴드경제', '018': '이데일리', '020': '동아일보', '021': '문화일보',
  '022': '세계일보', '023': '조선일보', '025': '중앙일보', '028': '한겨레',
  '032': '경향신문', '052': 'YTN', '055': 'SBS', '056': 'KBS', '057': 'MBN',
  '081': '서울신문', '082': '부산일보', '087': '강원일보', '092': '부산MBC',
  '119': '데일리안', '214': 'MBC', '215': '한국경제', '277': '아시아경제',
  '079': '노컷뉴스', '293': '블로터', '366': '조선비즈', '374': 'SBS Biz',
  '421': '뉴스1', '448': 'TV조선'
};
const HOST_OUTLETS = {
  'cctoday.co.kr': '충청투데이', 'econovill.com': '이코노믹리뷰', 'etnews.com': '전자신문',
  'ichannela.com': '채널A', 'imaeil.com': '매일신문', 'kids.donga.com': '어린이동아',
  'mbn.mk.co.kr': 'MBN', 'ppss.kr': 'ㅍㅍㅅㅅ', 'topstarnews.net': '톱스타뉴스',
  'yna.co.kr': '연합뉴스'
};


const BADUK_NAMES = ['신진서', '최정', '박정환', '변상일', '커제', '구쯔하오', '이세돌', '김은지', '카타고', '한돌', 'NHN', '한국기원', '대한바둑협회'];
const ISSUE_STOPWORDS = new Set(['오늘', '이번', '관련', '전국', '한국', '중국', '세계', '프로', '기사', '대국', '승리', '패배', '소식', '전망', '발표', '바둑']);
const RESULT_WORDS = /(?:우승|준우승|결승|진출|승리|패배|개최|개막|폐막|공사|차질|중단|지원|교류|합동훈련|선발|입단)/;

function issueKey(title, category, summary = '') {
  const text = normalizeText(`${title} ${summary}`).replace(/[“”‘’'"()[\]{}:;,!?]/g, ' ');
  const names = BADUK_NAMES.filter(name => text.includes(name));
  const event = text.match(/[가-힣A-Za-z0-9]{2,24}(?:바둑)?(?:대회|리그|기전|컵|배|선수권|오픈|스포츠교류|합동훈련)/)?.[0] || '';
  const place = text.match(/[가-힣]{2,10}(?:시|군|구|읍|면)\s*[가-힣]{0,10}(?:공사|대회|리그)/)?.[0]?.replace(/\s+/g, '') || '';
  const result = text.match(RESULT_WORDS)?.[0] || '';
  if (category === '바둑') {
    if (event) return `바둑|${[event, ...names.filter(name => !event.includes(name))].sort().join('|')}`;
    if (names.length >= 2) return `바둑|${names.slice(0, 3).sort().join('|')}`;
    if (names.length === 1 && result) return `바둑|${names[0]}|${result}`;
    if (place) return `바둑|${place}`;
    return '';
  }
  const words = text.split(/\s+/).map(word => word.replace(/[^0-9A-Za-z가-힣]/g, ''))
    .filter(word => word.length >= 2 && !ISSUE_STOPWORDS.has(word) && !/^\d+$/.test(word));
  return words.length >= 2 && result ? `${category}|${words.slice(0, 3).join('|')}` : '';
}

function issueLabel(key) {
  return key.split('|').slice(1).filter(Boolean).join(' · ');
}

function buildIssues(items, category = '') {
  const groups = new Map();
  for (const item of items) {
    const key = issueKey(item.title, item.category || category, item.summary);
    if (!key) continue;
    const group = groups.get(key) || { key, title: issueLabel(key), category: item.category, representative: item, related: [], count: 0, latest: item.published_at || item.fetched_at };
    group.count += 1;
    if (!group.title) group.title = key.split(':').slice(1).filter(Boolean).join(' · ').replace(/·/g, ' · ').replace(/\s+·\s+$/, '');
    if (group.representative.url_key !== item.url_key) group.related.push({ url_key: item.url_key, url: item.url, title: item.title, outlet: item.outlet });
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((a, b) => String(b.latest).localeCompare(String(a.latest)) || b.count - a.count);
}

export function issueCandidateLimit(limit, issues, isBaduk = false) {
  if (!issues) return limit;
  return isBaduk ? Math.min(240, Math.max(limit * 2, 120)) : Math.min(limit, 150);
}

export function feedCandidateLimit(limit, view, issues, isBaduk = false) {
  const issueLimit = issueCandidateLimit(limit, issues, isBaduk);
  // Validation and related-story grouping happen after SQL. Pull a deeper
  // ranked pool so the daily list can still return 10 cards and the hero can
  // take its intended first 6 instead of both collapsing to two.
  if (view === 'home' || view === 'popular') return Math.min(150, Math.max(issueLimit, limit * 5, 50));
  return issueLimit;
}

async function loadIssueCache(env, category) {
  const row = await env.DB.prepare('SELECT payload FROM news_issue_cache WHERE category=?').bind(category).first();
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.payload);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function normalizeCachedIssues(items, cached) {
  const itemByKey = new Map(items.map(item => [item.url_key, item]));
  // A single-key group already earned its own tile at classify time (baduk's
  // title-names-an-event match, or general's portal-popularity gate - see
  // isStandaloneEventArticle). Baduk's check is a cheap title regex, safe to
  // re-run here; general's needs is_popular, which this read path doesn't
  // load on every request (that join across every card was the earlier cause
  // of intermittent Worker resource-limit 503s), so an already-cached
  // single-key general group is trusted instead of re-verified.
  const trustedStandalone = item => item?.category === '바둑' ? isStandaloneEventArticle(item) : Boolean(item);
  const forcedMisc = [];
  const mapped = cached.map(group => {
    const keys = group.url_keys.filter(key => {
      const item = itemByKey.get(key);
      if (!item) return false;
      if (!group.key.endsWith('|ai:misc') && hasLegalCaseConflict(group.title, item)) {
        forcedMisc.push(key);
        return false;
      }
      return true;
    });
    return { key: group.key, title: group.title, url_keys: keys };
  }).filter(group => group.url_keys.length > 0);
  const valid = mapped.filter(group => {
    if (group.key.endsWith('|ai:misc')) return true;
    if (group.url_keys.length >= 2) return true;
    const item = itemByKey.get(group.url_keys[0]);
    if (trustedStandalone(item)) return true;
    forcedMisc.push(...group.url_keys);
    return false;
  });
  const misc = valid.find(group => group.key.endsWith('|ai:misc'));
  const miscKeys = [...new Set([...(misc?.url_keys || []), ...forcedMisc])];
  // Only baduk's regex signal is cheap enough to re-run on the misc bucket
  // here; general's popularity-based rescue happens at classify time instead
  // (see enforceIssueRules in classify-issues.js).
  const missedTournaments = miscKeys.filter(key => isStandaloneEventArticle(itemByKey.get(key)));
  const missedSet = new Set(missedTournaments);
  for (const key of missedTournaments) {
    const item = itemByKey.get(key);
    valid.push({ key: `바둑|ai:event:${key.slice(0, 16)}`, title: standaloneBadukIssueTitle(item) || '바둑 이슈', url_keys: [key] });
  }
  const normalizedMisc = miscKeys.filter(key => !missedSet.has(key));
  const withoutMisc = valid.filter(group => !group.key.endsWith('|ai:misc'));
  if (normalizedMisc.length) withoutMisc.push({ key: `${items[0]?.category === '바둑' ? '바둑' : '일반'}|ai:misc`, title: '기타', url_keys: normalizedMisc });
  return withoutMisc;
}

export function buildIssuesFromCache(items, cached, capCount = Infinity) {
  const normalized = normalizeCachedIssues(items, cached);
  const itemByKey = new Map(items.map(item => [item.url_key, item]));
  const mapped = normalized.map(group => {
    const latest = group.url_keys.reduce((max, key) => {
      const time = String(itemByKey.get(key)?.published_at || itemByKey.get(key)?.fetched_at || '');
      return time > max ? time : max;
    }, '');
    // popularity_score only exists on the row when the caller opted into the
    // extra join (see includePopularityScore in onRequestGet) - baduk and
    // plain listings never carry it, so this is always 0 there and the sort
    // below degrades to the original recency order for them, unchanged.
    const score = group.url_keys.reduce((max, key) =>
      Math.max(max, Number(itemByKey.get(key)?.popularity_score) || 0), 0);
    return { key: group.key, title: group.title, count: group.url_keys.length, latest, score };
  });
  // The 기타 bucket (leftover singletons) can outnumber every real issue by
  // count, so it is kept out of the sort and appended last instead. Real
  // portal popularity (score) leads; recency only breaks ties among issues
  // that never ranked (score 0), which is most of them.
  const misc = mapped.filter(group => group.key.endsWith('|ai:misc'));
  const rest = mapped.filter(group => !group.key.endsWith('|ai:misc'))
    .sort((a, b) => b.score - a.score || b.latest.localeCompare(a.latest));
  // capCount bounds only the real issue tiles (weekly/monthly display caps).
  // Dropped tiles just stop being advertised as issues - their articles are
  // still reachable through the plain article feed, untouched by this cap.
  return [...rest.slice(0, capCount), ...misc];
}

function bigrams(value) {
  const text = String(value || '').toLowerCase().replace(/[^0-9a-z가-힣]/g, '');
  const out = new Set();
  for (let i = 0; i < text.length - 1; i += 1) out.add(text.slice(i, i + 2));
  return out;
}

function similarTokens(left, right, threshold = 0.64) {
  if (!left.size || !right.size) return false;
  let common = 0;
  for (const token of left) if (right.has(token)) common += 1;
  return (2 * common) / (left.size + right.size) >= threshold;
}

function cleanOutlet(value) {
  return normalizeText(value)
    .replace(/\s+(?:[-|–—]|·)\s+(?:[^\n]{2,})$/u, '')
    .replace(/\s*(?:대한민국|울산)\s*(?:최초|최고)[^\n]*$/u, '')
    .trim()
    .slice(0, 40);
}

function outletFor(item) {
  const press = cleanOutlet(item.press);
  if (press) return press;
  const oid = String(item.url || '').match(/\/article\/(\d{3})\//)?.[1];
  if (oid && NAVER_OUTLETS[oid]) return NAVER_OUTLETS[oid];
  if (item.source === 'NAVER') return '네이버 뉴스';
  if (item.source === 'DAUM' || item.source === 'KAKAO') return '다음 뉴스';
  if (item.source === 'GOOGLE') return 'Google 뉴스';
  const source = cleanOutlet(item.source);
  return HOST_OUTLETS[source.replace(/^www\./, '')] || source || '기타';
}

export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const category = url.searchParams.get('category') || '';
    const query = (url.searchParams.get('q') || '').trim().slice(0, 100);
    const hours = Math.min(Math.max(Number(url.searchParams.get('hours')) || 0, 0), 24 * 30);
    const requestedView = url.searchParams.get('view') || 'latest';
    const view = ['saved', 'hidden', 'popular', 'home'].includes(requestedView) ? requestedView : 'latest';
    const excludeBaduk = url.searchParams.get('exclude_baduk') === '1';
    const issues = url.searchParams.get('issues') === '1';
    // The popularity subquery join was previously run for every request and
    // caused intermittent Cloudflare "Worker exceeded resource limits" 503s
    // (see popularityScore below) - keep it scoped to general issue-keyword
    // requests only, not every plain article listing, and not baduk (whose
    // issue tiles are ordered by recency on purpose, untouched here).
    const includePopularityScore = issues && category !== '바둑';
    const issueKeyFilter = url.searchParams.get('issue_key') || '';
    const issueCategory = issueKeyFilter.split('|')[0] || '';
    const maxLimit = 300;
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 60, 1), maxLimit);
    const uid = userId(request);
    const cachedIssues = category === '바둑'
      ? await loadIssueCache(env, category)
      : ((!category && excludeBaduk) || issueCategory === '일반') ? await loadIssueCache(env, '일반') : null;
    const where = [
      view === 'hidden' ? "h.url_key IS NOT NULL" : "h.url_key IS NULL",
      ...CONTENT_QUALITY_FILTERS
    ];
    const bindings = [uid, uid, uid];

    if (category && CATEGORIES.has(category)) {
      where.push('a.category = ?');
      bindings.push(category);
    } else if (issueKeyFilter && CATEGORIES.has(issueCategory)) {
      // Home issue cards are built from a category-specific feed. Reapply
      // that category when the user opens an issue from the home view.
      where.push('a.category = ?');
      bindings.push(issueCategory);
    }
    if (excludeBaduk && category !== '바둑') where.push("a.category NOT IN ('바둑','IT/과학')");
    if (query) {
      where.push('(a.title LIKE ? OR a.summary LIKE ? OR a.press LIKE ?)');
      const term = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
      bindings.push(term, term, term);
    }
    if (view === 'saved') where.push('s.url_key IS NOT NULL');
    if (view === 'popular') where.push(`(
      EXISTS(SELECT 1 FROM news_popularity npv WHERE npv.url_key=a.url_key)
      OR EXISTS(SELECT 1 FROM news_popular_items pp WHERE pp.title=a.title)
    )`);
    // A named cached issue already owns an explicit URL-key set. Query those
    // rows directly instead of loading and validating the entire 150-card
    // period again merely to return two or three cards. Misc stays on the full
    // candidate path because it also absorbs ungrouped/invalid singleton rows.
    const directIssue = issueKeyFilter && !issueKeyFilter.endsWith('|ai:misc')
      ? cachedIssues?.find(group => group.key === issueKeyFilter)
      : null;
    const directKeys = [...new Set(directIssue?.url_keys || [])];
    if (!['saved', 'hidden'].includes(view)) where.push("datetime(COALESCE(NULLIF(a.published_at,''),a.fetched_at)) >= datetime('now','-30 days')");
    if (hours > 0 && !['saved', 'hidden'].includes(view)) {
      where.push("datetime(COALESCE(NULLIF(a.published_at,''),a.fetched_at)) >= datetime('now', ?)");
      bindings.push(`-${hours} hours`);
    }
    // Similar stories are collapsed after the query. Read extra rows so that
    // deduplication does not make a requested 100/300 item page needlessly short.
    // Issue counts and issue-click results must be derived from the exact same
    // candidate set. Otherwise a monthly issue can advertise one count and
    // reveal a different set after it is opened.
    const queryLimit = feedCandidateLimit(
      limit, view, issues || Boolean(issueKeyFilter), category === '바둑'
    );

    // Popularity tables are only needed by the compact home/popular feed.
    // Joining them on every latest/saved/issue request was the expensive path
    // behind intermittent Cloudflare "Worker exceeded resource limits" 503s.
    const popularityScore = `MAX(
      COALESCE((SELECT score FROM news_popularity nps WHERE nps.url_key=a.url_key),0),
      COALESCE((SELECT score FROM news_popular_items pps WHERE pps.title=a.title),0)
    )`;

    const order = view === 'popular'
      ? (hours > 0 && hours <= 24
        ? `${popularityScore} DESC, datetime(COALESCE(NULLIF(a.published_at,''),a.fetched_at)) DESC`
        : `date(datetime(COALESCE(NULLIF(a.published_at,''),a.fetched_at),'+9 hours')) DESC, ${popularityScore} DESC, datetime(COALESCE(NULLIF(a.published_at,''),a.fetched_at)) DESC`)
      : view === 'home'
        ? `CASE WHEN ${popularityScore}>0 THEN 1 ELSE 0 END DESC, ${popularityScore} DESC, datetime(COALESCE(NULLIF(a.published_at,''),a.fetched_at)) DESC`
      : "datetime(COALESCE(NULLIF(a.published_at,''), a.fetched_at)) DESC";

    const selectSql = (extraWhere) => `
      SELECT a.id, a.url, a.url_key, a.title, a.source, a.press, a.category,
             a.published_at, a.fetched_at, a.summary, a.summary_quality, a.image_url,
             CASE WHEN s.url_key IS NULL THEN 0 ELSE 1 END AS saved,
             CASE WHEN l.url_key IS NULL THEN 0 ELSE 1 END AS liked,
             (SELECT COUNT(*) FROM news_likes nl WHERE nl.url_key=a.url_key) AS like_count
             ${includePopularityScore ? `, ${popularityScore} AS popularity_score` : ''}
      FROM news_articles a
      LEFT JOIN news_saved s ON s.url_key=a.url_key AND s.user_id=?
      LEFT JOIN news_hidden h ON h.url_key=a.url_key AND h.user_id=?
      LEFT JOIN news_likes l ON l.url_key=a.url_key AND l.user_id=?
      WHERE ${[...where, ...(extraWhere ? [extraWhere] : [])].join(' AND ')}
      ORDER BY ${order}
      LIMIT ?
    `;
    // D1 rejects statements with more than 100 bound parameters. A long-running
    // story's cached issue can accumulate far more url_keys than that (a story
    // covered for weeks can pass 90+ articles), so the direct-key IN clause is
    // sent in batches instead of one query - otherwise the whole request fails
    // with SQLITE_ERROR and the issue card looks dead on click.
    const DIRECT_KEY_BATCH = 90;
    let resultRows;
    if (directKeys.length) {
      resultRows = [];
      for (let i = 0; i < directKeys.length; i += DIRECT_KEY_BATCH) {
        const chunk = directKeys.slice(i, i + DIRECT_KEY_BATCH);
        const chunkResult = await env.DB.prepare(selectSql(`a.url_key IN (${chunk.map(() => '?').join(',')})`))
          .bind(...bindings, ...chunk, queryLimit).all();
        resultRows.push(...(chunkResult.results || []));
      }
      // Each batch is individually ordered; restore a single date-DESC order
      // across the merged set so dedup/representative selection below behaves
      // the same as the unbatched query.
      resultRows.sort((a, b) => String(b.published_at || b.fetched_at || '').localeCompare(String(a.published_at || a.fetched_at || '')));
    } else {
      const result = await env.DB.prepare(selectSql(null)).bind(...bindings, queryLimit).all();
      resultRows = result.results || [];
    }
    const accepted = [];
    for (const item of resultRows) {
      item.summary = normalizeText(String(item.summary || '').replace(/([1-3][.)])\s*&#10;/gi, '$1 '));
      if (item.category !== '바둑') item.summary = reorderGeneralSummary(item.summary, item.title);
      item.image_url = normalizeText(item.image_url);
      item.source = cleanOutlet(item.source) || '기타';
      item.press = cleanOutlet(item.press);
      if (item.press === item.source) item.press = '';
      item.outlet = outletFor(item);
      if (excludeBaduk && item.category !== '바둑' && isBadukRelevant(item.title, item.summary)) continue;
      if (!validateThreeLineSummary(item.summary, item.title)) continue;
      if (item.category !== '바둑' && !validateGeneralEditorialSummary(item.summary, item.title)) continue;
      if (item.category === '바둑' && !isBadukDisplayRelevant(item.title, item.summary)) continue;
      if (item.category === '바둑'
        && (BADUK_PROMO_TITLE_PATTERNS.some(pattern => pattern.test(item.title))
          || BADUK_PROMO_OUTLETS.test(`${item.outlet} ${item.press} ${item.source}`))) continue;
      const first = String(item.summary || '').split('\n')[0].replace(/^\s*1[.)]\s*/, '');
      // Baduk headlines legitimately repeat player and tournament names. Use a
      // much stricter threshold so separate games are not collapsed together.
      const titleThreshold = category === '바둑' ? 0.86 : 0.64;
      const summaryThreshold = category === '바둑' ? 0.9 : 0.72;
      const titleTokens = bigrams(item.title);
      const firstTokens = bigrams(first);
      // 위 두 임계값은 제목이 거의 같을 때만 묶는다. 그래서 같은 보도자료가
      // 매체마다 조금씩 다르게 쓰이면 전부 따로 뜬다. 실측(2026-08-10): 빙그레
      // 부라보콘 대회 기사 14건이 바둑 탭에 카드 14개로 떴고 그중 12건은
      // related_count가 0이었다. 임계값을 그냥 낮추면 다른 대국 결과가 합쳐지므로
      // (0.86은 그래서 높게 잡혀 있다) 대신 연재 회차·일련번호 가드를 갖춘
      // isSameStory를 더한다. 수집 단계에서 유료 요약을 아끼는 판정과 같은 기준이라
      // 화면과 수집이 따로 놀지 않는다.
      const group = accepted.find(old => similarTokens(titleTokens, old.titleTokens, titleThreshold)
        || similarTokens(firstTokens, old.firstTokens, summaryThreshold)
        || isSameStory(item.title, old.title));
      if (group) {
        if (!group.related.some(old => old.url_key === item.url_key)) {
          group.related.push({ url_key: item.url_key, url: item.url, title: item.title, outlet: item.outlet });
          group.related_count = group.related.length;
        }
        continue;
      }
      accepted.push({ ...item, first, titleTokens, firstTokens, related: [], related_count: 0 });
    }
    const normalizedCachedIssues = cachedIssues ? normalizeCachedIssues(accepted, cachedIssues) : null;
    // Weekly/monthly show the same 30-day general cache, only differing in
    // which articles' hours window is in play (see `hours` above) - nothing
    // otherwise bounds how many tiles accumulate over a month. Cap general
    // issue tiles per period so a long month doesn't outgrow a short week:
    // weekly (hours<=168) gets 12, monthly (hours>168) gets 24. Baduk is
    // unbounded on purpose - untouched.
    const generalIssueCap = cachedIssues && category !== '바둑' ? (hours > 168 ? 24 : 12) : Infinity;
    const issueList = cachedIssues
      ? buildIssuesFromCache(accepted, cachedIssues, generalIssueCap)
      : buildIssues(accepted, category);
    let selected = accepted;
    if (issueKeyFilter) {
      if (normalizedCachedIssues) {
        const group = normalizedCachedIssues.find(entry => entry.key === issueKeyFilter);
        selected = group ? accepted.filter(item => group.url_keys.includes(item.url_key)) : [];
      } else {
        selected = accepted.filter(item => issueKey(item.title, item.category || category, item.summary) === issueKeyFilter);
      }
    }
    // A source that only gives a date (no time of day) is stored anchored to
    // noon Korea time so it still sorts/filters sanely, but showing that
    // fabricated "12:00" to users reads as a bug. Display just the date, the
    // same as any other date-only published_at.
    const items = selected.slice(0, issueKeyFilter ? 300 : limit).map(({ first, titleTokens, firstTokens, ...item }) => {
      if (/T03:00:00\.000Z$/.test(String(item.published_at || ''))) item.published_at = String(item.published_at).slice(0, 10);
      return item;
    });
    return json({ ok: true, items, issues: issues ? issueList : [] });
  } catch (error) {
    return json({ ok: false, error: error.message }, 500);
  }
}
