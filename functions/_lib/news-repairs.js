// 이미 저장된 기사를 사후에 고치는 유지보수 작업 모음. 옛 코드가 잘못 저장한
// 제목·카테고리·발행시각을 되살리고, 품질 기준에 못 미치는 요약을 격리하고,
// 지난 인기 랭킹을 채워 넣는다.
//
// 수집 본 흐름과 성격이 다르다. 정기 수집은 새 기사를 가져오는 일이고 여기 있는
// 것들은 전부 수동/일회성 복구 모드다. collect.js에 섞여 있을 때는 onRequestPost
// 하나가 일곱 갈래로 분기하면서 어디까지가 정기 수집인지 알아보기 어려웠다.
import { canonicalUrl, sha256 } from './news-db.js';
import { publishableSummary } from './news-summary.js';
import {
  classify, cleanTitle, DEAD_PAGE, fetchArticleText, titleIsTruncationOf
} from './news-extract.js';
import { popularPage } from './news-sources.js';

// 커서 순회로는 닿지 않는 기사 하나를 제목 조각으로 직접 찾아 고친다.
// 어느 카테고리로 분류됐는지, 저장된 URL이 무엇인지, 원문에서 제목을 실제로
// 읽어왔는지를 함께 돌려주기 때문에 복구가 안 될 때 원인이 바로 보인다.
// 30일 창의 일반 기사는 DAILY_CATEGORY_PUBLISH_LIMIT(하루 12건) 때문에 최대
// 360건이라 이 한도가 지금은 걸리지 않는다. 다만 id 오름차순으로 읽으면 한도에
// 닿는 순간 조용히 "가장 오래된 N건만" 검사하게 되고, 정작 새로 들어온 기사가
// 영영 검사에서 빠진다. 최신순으로 읽어 그 상황에서도 최근 기사를 먼저 지키고,
// 한도에 닿았는지를 응답에 남겨 조용히 넘어가지 않게 한다.
const WEAK_SUMMARY_SCAN_LIMIT = 400;

export async function repairGeneralCategories(env, limit = 10, reset = false) {
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

// 이미 실려 있는 요약이 **오늘의 기준**을 여전히 통과하는지 다시 묻는다.
//
// 두 가지가 바뀌었다. 첫째, 바둑도 검사한다. 예전에는 category<>'바둑'이라
// 바둑 요약은 어떤 사후 검사도 받지 않았다 - 2026-08-14 실측: "그가 인간 바둑
// 에서도 전대미문의 역사를 써 내려가고 있다"가 화면에 그대로 떠 있었다.
// 둘째, 판정을 publishableSummary 하나로 통일했다. 발행할 때와 다른 기준으로
// 재검사하면, 기준을 올려도 이미 떠 있는 것은 안 내려간다.
//
// 기준을 한 번 올리면 옛 행까지 다음 실행이 알아서 정리한다. 사람이 화면을 보고
// 알려 줄 필요가 없다 - 그게 이 함수가 있는 이유다.
export async function quarantineWeakSummaries(env, { limit = WEAK_SUMMARY_SCAN_LIMIT, days = 30 } = {}) {
  const rows = await env.DB.prepare(`SELECT id,title,summary,category FROM news_articles
    WHERE summary_quality='full'
      AND datetime(COALESCE(NULLIF(published_at,''),fetched_at))>=datetime('now',?)
    ORDER BY datetime(COALESCE(NULLIF(published_at,''),fetched_at)) DESC, id DESC
    LIMIT ?`).bind(`-${days} days`, limit).all();
  const weak = (rows.results || []).filter(row => !publishableSummary(row.summary, row.title, row.category));
  for (let index = 0; index < weak.length; index += 50) {
    await env.DB.batch(weak.slice(index, index + 50).map(row =>
      env.DB.prepare("UPDATE news_articles SET summary='',summary_quality='none' WHERE id=?").bind(row.id)));
  }
  const checked = (rows.results || []).length;
  return {
    checked,
    quarantined: weak.length,
    scan_limit_reached: checked >= limit,
    // 무엇이 왜 내려갔는지 남긴다. "안 나온 건 기록에 남긴다"는 것이 요구사항이고,
    // 이 목록이 없으면 검사를 너무 조인 것과 실제로 요약이 나쁜 것을 구분할 수 없다.
    samples: weak.slice(0, 5).map(row => `${row.category}|${String(row.title).slice(0, 30)}`),
    ids: weak.map(row => row.id)
  };
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

export async function repairTitleByQuery(env, query) {
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

export async function repairTruncatedTitles(env, limit = 10, reset = false) {
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

export async function repairGeneralArticleTimes(env, limit = 10) {
  const cursorKey = 'general_time_repair_cursor';
  const cursorRow = await env.DB.prepare('SELECT value FROM news_state WHERE key=?').bind(cursorKey).first();
  const cursor = Number(cursorRow?.value || 0);
  const rows = await env.DB.prepare(`SELECT id,url_key,url,published_at FROM news_articles
    WHERE datetime(COALESCE(NULLIF(published_at,''),fetched_at))>=datetime('now','-30 days')
      -- 이미 원문을 확인해 본 행은 다시 긁지 않는다. 날짜만 싣는 매체의 기사는
      -- 몇 번을 다시 불러도 결과가 같은데, 그 사이 subrequest만 나간다.
      -- 빈 값/날짜만 있는 행은 커서로 조금씩 훑는다(수가 많다).
      -- 카테고리로 가르지 않고 **한국기원(baduk.or.kr)만** 뺀다. 예전에는
      -- category<>'바둑'이라 바둑 기사는 시각을 영영 못 되찾았는데, 시각을 정말로
      -- 안 내는 곳은 카테고리가 아니라 한국기원 한 곳이다(그쪽은 목록에 날짜만
      -- 싣는다 - 사용자 확인 2026-08-14). 나머지 바둑 매체는 원문에 시각이 있고,
      -- 그게 안 붙어 화면에 "8. 14."로만 뜨던 카드가 많았다. health의
      -- published_time_has_clock 검사와 **같은 집합**을 봐야 한다 - 검사가 세는
      -- 것과 복구가 고치는 것이 다르면 값이 영원히 안 떨어진다.
      -- 미래 시각은 커서·카테고리·요약품질을 가리지 않고 매번 전부 잡는다. 커서를
      -- 태우면 커서가 이미 지나간 행은 한 바퀴를 다 돌 때까지 안 고쳐지는데,
      -- 미래 시각은 목록 맨 위에 박혀 그날 기사를 가리므로 그때까지 둘 수 없다.
      -- 실측 2026-08-12: 남은 1건이 커서 뒤에 있어 복구를 두 번 돌려도 그대로였다.
      -- 미래 행은 보통 0~2건이라 매번 훑어도 비용이 없다.
      AND ((id>? AND summary_quality='full' AND url NOT LIKE '%baduk.or.kr%'
          AND (TRIM(published_at)='' OR published_at GLOB '????-??-??')
          AND NOT EXISTS(SELECT 1 FROM news_time_checks t WHERE t.url_key=news_articles.url_key))
        OR datetime(published_at)>datetime('now','+2 hours'))
    -- +id: 순서는 같다. 없으면 id 순 전체 훑기를 골라 30일 인덱스를 안 탄다(health.js 같은 이유).
    ORDER BY +id LIMIT ?`).bind(cursor, Math.min(Math.max(Number(limit) || 10, 1), 10)).all();
  const candidates = rows.results || [];
  if (!candidates.length) {
    await env.DB.prepare(`INSERT INTO news_state(key,value) VALUES(?,0)
      ON CONFLICT(key) DO UPDATE SET value=0`).bind(cursorKey).run();
    return { attempted: 0, repaired: 0, done: true };
  }
  let repaired = 0;
  // 2시간 여유는 서버 시계 오차용이다. 진짜 고장은 9시간이라 여기 안 숨는다.
  const futureCutoff = Date.now() + 2 * 3600000;
  const storedMillis = value => {
    const text = String(value || '');
    const parsed = Date.parse(/Z$|[+-]\d\d:\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}Z`);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  let noClock = 0;
  for (const row of candidates) {
    const article = await fetchArticleText(row.url);
    const fetched = article.publishedAt;
    const usable = fetched && !/^\d{4}-\d{2}-\d{2}$/.test(fetched) && storedMillis(fetched) <= futureCutoff;
    // 확인했다는 사실을 남긴다. 성공이든 실패든 같은 기사를 매 실행 다시 긁지
    // 않고, health도 "아직 확인 안 한 것"만 세게 된다.
    if (row.url_key) {
      await env.DB.prepare(`INSERT INTO news_time_checks(url_key,checked_at,found_clock)
        VALUES(?,CURRENT_TIMESTAMP,?) ON CONFLICT(url_key) DO UPDATE SET
        checked_at=CURRENT_TIMESTAMP,found_clock=excluded.found_clock`)
        .bind(row.url_key, usable ? 1 : 0).run();
      if (!usable) noClock += 1;
    }
    if (!usable) {
      // 원문에서 쓸 만한 시각을 못 얻었는데 저장된 값이 미래라면, 그 값은 틀린
      // 것이 확실하다. 틀린 채로 두면 목록이 발행시각 내림차순이라 그 기사가
      // 맨 위에 박혀 그날 기사를 통째로 가린다. 비워 두면 읽기 경로가 전부
      // fetched_at으로 대체한다(articles.js의 COALESCE, 정렬·필터·화면 모두).
      // 모르는 시각을 지어내는 것보다 수집 시각으로 물러서는 편이 정직하다.
      if (storedMillis(row.published_at) > futureCutoff) {
        await env.DB.prepare("UPDATE news_articles SET published_at='' WHERE id=?").bind(row.id).run();
        repaired += 1;
      }
      continue;
    }
    await env.DB.prepare('UPDATE news_articles SET published_at=? WHERE id=?')
      .bind(fetched, row.id).run();
    repaired += 1;
  }
  // 커서 뒤에 있는 미래 행이 배치에 섞이므로 커서가 뒤로 밀리지 않게 한다.
  const nextCursor = Math.max(cursor, ...candidates.map(row => Number(row.id || 0)));
  await env.DB.prepare(`INSERT INTO news_state(key,value) VALUES(?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(cursorKey, nextCursor).run();
  // no_clock은 "원문이 정말로 시각을 안 싣는다"고 확인한 건수다. 실패가 아니라
  // 확정이므로 이 값이 크다고 해서 고장은 아니다 - 진단에서 갈라 보이게 남긴다.
  return { attempted: candidates.length, repaired, no_clock: noClock, done: candidates.length < 10 };
}

export async function backfillPopularityDate(env, ymd) {
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
