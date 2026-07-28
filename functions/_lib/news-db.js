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
CREATE TABLE IF NOT EXISTS news_category_checks (
  url_key TEXT PRIMARY KEY,
  checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  detected_category TEXT NOT NULL DEFAULT ''
);`;

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
    const oldSports = url.hostname.toLowerCase() === 'sports.naver.com'
      ? url.pathname.match(/^\/(?:[^/]+)\/article\/(\d{3})\/(\d+)/)
      : null;
    if (oldSports) return `https://n.news.naver.com/mnews/article/${oldSports[1]}/${oldSports[2]}`;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_|fbclid|gclid|ref|from|sid$)/i.test(key)) url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase().replace(/^m\./, '');
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
