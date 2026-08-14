export const NEWS_SCHEMA = `
CREATE TABLE IF NOT EXISTS news_articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  url_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  press TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '기타',
  published_at TEXT NOT NULL DEFAULT '',
  fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  raw_summary TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  summary_quality TEXT NOT NULL DEFAULT 'none',
  image_url TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_news_articles_date ON news_articles(published_at DESC, fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_news_articles_category ON news_articles(category, published_at DESC);
CREATE TABLE IF NOT EXISTS news_saved (
  user_id TEXT NOT NULL,
  url_key TEXT NOT NULL,
  saved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_id, url_key)
);
CREATE TABLE IF NOT EXISTS news_hidden (
  user_id TEXT NOT NULL,
  url_key TEXT NOT NULL,
  hidden_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_id, url_key)
);
CREATE TABLE IF NOT EXISTS news_likes (
  user_id TEXT NOT NULL,
  url_key TEXT NOT NULL,
  liked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_id, url_key)
);
CREATE INDEX IF NOT EXISTS idx_news_likes_url_key ON news_likes(url_key);
CREATE TABLE IF NOT EXISTS news_users (
  username TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'member',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS news_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  inserted_count INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS news_popularity (
  url_key TEXT PRIMARY KEY,
  score REAL NOT NULL DEFAULT 0,
  rank INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT '',
  collected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS news_state (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS news_popular_items (
  title TEXT PRIMARY KEY,
  url_key TEXT NOT NULL DEFAULT '',
  score REAL NOT NULL DEFAULT 0,
  rank INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT '',
  collected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS news_summary_attempts (
  url_key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS news_issue_cache (
  category TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  built_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS news_issue_cache_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  payload TEXT NOT NULL,
  built_at TEXT NOT NULL,
  backed_up_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_news_issue_history_category ON news_issue_cache_history(category, id DESC);
CREATE TABLE IF NOT EXISTS news_category_checks (
  url_key TEXT PRIMARY KEY,
  checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  detected_category TEXT NOT NULL DEFAULT ''
);
-- 발행시각을 원문에서 되찾아 봤는지. 되찾지 못한 행(원문이 날짜만 싣는 매체)을
-- 기억해 두지 않으면 두 가지가 같이 망가진다: 복구가 매 실행 같은 기사를 다시
-- 긁어 subrequest를 태우고, health의 "날짜만 남은 행" 검사가 영영 안 꺼지는
-- 알람이 된다. 안 꺼지는 알람은 곧 무시되고, 그러면 진짜 고장도 같이 묻힌다
-- (이 저장소의 177통 전례).
CREATE TABLE IF NOT EXISTS news_time_checks (
  url_key TEXT PRIMARY KEY,
  checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  found_clock INTEGER NOT NULL DEFAULT 0
);`;

// news_runs.message에 넣을 진단 JSON을 길이 한도 안에서 만든다.
// 예전에는 호출부마다 JSON.stringify(...).slice(0, 500)을 썼는데, 문자열
// 중간에서 잘린 JSON은 파싱이 안 된다. 진단이 길어질수록 - 즉 문제가
// 많아 정작 읽어야 할 때일수록 - 확실히 못 읽는 상태였다. 잘라내는 대신
// 부피가 큰 진단 키부터 통째로 버려서 항상 유효한 JSON을 남긴다.
//
// 한도가 500이던 동안에는 이 방식이 정확히 읽어야 할 것부터 버렸다. 부피가
// 큰 키를 먼저 버리는데, 가장 큰 키가 candidate_outcomes_by_category와
// body_too_short_hosts - 후보가 어디서 떨어졌는지 알려주는 유일한 기록이다.
// 8월 7일 실행에는 "dropped_keys":12만 남아, 바둑이 하루 2건에 그친 이유를
// 진단에서 찾을 수 없었다. news_runs.message는 제약 없는 TEXT 열이므로
// 500을 지킬 이유가 없었다.
export function runMessage(payload, limit = 4000) {
  const encode = value => JSON.stringify(value) ?? '';
  const full = encode(payload);
  if (full.length <= limit) return full;
  let clone;
  try {
    clone = JSON.parse(full);
  } catch {
    return JSON.stringify({ truncated: true });
  }
  // 덜어낼 곳은 진단 묶음이고, 없으면 가장 부피가 큰 최상위 묶음을 쓴다.
  // status·warnings 같은 최상위 요약 값은 건드리지 않아 항상 남는다.
  const containers = Object.values(clone).filter(value => value && typeof value === 'object');
  const target = (clone.diagnostics && typeof clone.diagnostics === 'object' ? clone.diagnostics : null)
    || containers.sort((left, right) => encode(right).length - encode(left).length)[0];
  if (!target) return JSON.stringify({ truncated: true });
  let dropped = 0;
  while (encode(clone).length > limit) {
    const biggest = Object.keys(target)
      .map(key => [key, encode(target[key]).length])
      .sort((left, right) => right[1] - left[1])[0];
    if (!biggest) break;
    if (Array.isArray(target)) target.splice(Number(biggest[0]), 1);
    else delete target[biggest[0]];
    dropped += 1;
  }
  // 무엇이 빠졌는지 알 수 있게 개수를 남긴다. 표시 때문에 한도를 다시 넘으면
  // 표시를 포기한다 - 읽을 수 있는 JSON이 우선이다.
  if (dropped && !Array.isArray(target)) {
    target.dropped_keys = dropped;
    if (encode(clone).length > limit) delete target.dropped_keys;
  }
  const result = encode(clone);
  return result.length <= limit ? result : JSON.stringify({ truncated: true });
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    }
  });
}

let schemaReadyFor;
let schemaReadyPromise;

export async function ensureNewsDb(env) {
  if (!env.DB) throw new Error('Cloudflare D1 binding DB가 없습니다.');
  // A Pages Functions isolate can serve many requests. Running every CREATE
  // TABLE/INDEX statement on every article and image read adds avoidable D1
  // contention, especially while the collector is writing. Initialize once per
  // binding/isolate and retry on the next request if initialization failed.
  if (schemaReadyFor === env.DB && schemaReadyPromise) return schemaReadyPromise;
  const statements = NEWS_SCHEMA.split(';').map(value => value.trim()).filter(Boolean);
  schemaReadyFor = env.DB;
  schemaReadyPromise = env.DB.batch(statements.map(sql => env.DB.prepare(sql))).catch(error => {
    schemaReadyFor = undefined;
    schemaReadyPromise = undefined;
    throw error;
  });
  return schemaReadyPromise;
}

export async function sha256(value) {
  const bytes = new TextEncoder().encode(String(value || ''));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function canonicalUrl(value) {
  try {
    const url = new URL(String(value || ''));
    // 아래 'm.' 제거보다 **먼저** 판정해야 한다. 예전에는 hostname이 정확히
    // 'sports.naver.com'일 때만 이 규칙이 돌아서, m.sports.naver.com 주소는
    // 규칙을 비껴간 다음 'm.'만 떨어졌다. 그 결과가 sports.naver.com/general/
    // article/079/0004178768인데 이 주소는 **404다**(2026-08-14 실측: m.을 붙이면
    // 200, 떼면 404). 화면에 카드가 떠서 눌렀는데 "페이지 주소가 잘못됐다"가
    // 나오는 상태였다. 네이버 스포츠에는 데스크톱 기사 주소가 없다.
    const naverHost = url.hostname.toLowerCase().replace(/^m\./, '');
    const sportsArticle = naverHost === 'sports.naver.com'
      ? url.pathname.match(/^\/(?:[^/]+)\/article\/(\d{3})\/(\d+)/)
      : null;
    // n.news.naver.com 형태는 뉴스와 스포츠 양쪽에서 모두 열린다(스포츠 기사는
    // m.sports.naver.com으로 넘겨준다). 주소 형태를 하나로 모으면 같은 기사가
    // 두 주소로 들어와 카드가 두 장이 되는 일도 함께 막힌다.
    if (sportsArticle) return `https://n.news.naver.com/mnews/article/${sportsArticle[1]}/${sportsArticle[2]}`;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_|fbclid|gclid|ref|from|sid$)/i.test(key)) url.searchParams.delete(key);
    }
    url.hostname = naverHost;
    return url.toString().replace(/\/$/, '');
  } catch {
    return String(value || '').trim();
  }
}

export function userId(request) {
  return (request.headers.get('x-news-user') || 'default').slice(0, 100);
}

export function isAuthorized(request, env) {
  const expected = env.NEWSBRIEF_ACCESS_TOKEN;
  if (!expected) return true;
  return request.headers.get('x-news-token') === expected;
}

export function isCollectorAuthorized(request, env) {
  const expected = env.NEWSBRIEF_COLLECT_TOKEN;
  return Boolean(expected) && request.headers.get('authorization') === `Bearer ${expected}`;
}
