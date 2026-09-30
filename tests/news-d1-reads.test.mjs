// D1 읽기량을 결과로 보는 테스트.
//
// 2026-09-30: 매 수집·health 가 기사 표 전체를 훑어 하루 1,600만 줄을 읽었다. D1 무료
// 한도(계정 전체 하루 500만 줄)를 넘겨 같은 계정의 올댓마인드 대관관리까지 멈췄다.
// 조건이 datetime(COALESCE(...)) 식이라 인덱스를 못 탔고, 기사가 쌓일수록 매 호출이
// 비싸졌다 - 코드는 그대로인데 어느 날 갑자기 터진 이유다.
//
// 여기서는 실제 SQLite 에 같은 스키마를 만들고 자동으로 도는 경로(수집·health·목록·
// 이슈 분류)를 그대로 돌린다. 실행된 쿼리마다 실행 계획을 보고, 기사 표를 통째로
// 훑는 것이 하나라도 있으면 실패한다. 쿼리를 고치다 이 테스트가 깨지면 조건을
// news-db.js 의 인덱스 식과 글자까지 맞추거나 인덱스를 더한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { NEWS_READ_INDEXES, NEWS_SCHEMA, ensureNewsReadIndexes } from '../functions/_lib/news-db.js';
import { D1_DAILY_READ_LIMIT_DEFAULT, d1ReadDayKey } from '../functions/_lib/news-d1-meter.js';
import { onRequestPost as collect } from '../functions/api/news/collect.js';
import { onRequestGet as health } from '../functions/api/news/health.js';
import { onRequestGet as articles } from '../functions/api/news/articles.js';
import { onRequestPost as classifyIssues } from '../functions/api/news/classify-issues.js';

const ARTICLES = 6000;
// 부분 인덱스(WHERE 가 붙은 것)는 조건에 맞는 몇 줄만 담는다. 그걸 훑는 것은 표 전체 훑기가 아니다.
const PARTIAL_INDEXES = NEWS_READ_INDEXES.filter(([, sql]) => / WHERE /.test(sql)).map(([name]) => name);
const scansWholeArticleTable = line => /^SCAN (news_articles|a)\b/.test(line)
  && !PARTIAL_INDEXES.some(name => new RegExp(`USING (COVERING )?INDEX ${name}\\b`).test(line));
const CATEGORIES = ['정치', '경제', '사회', 'IT/과학', '세계', '생활/문화', '스포츠', '바둑'];

function seed() {
  const db = new DatabaseSync(':memory:');
  db.exec(NEWS_SCHEMA);
  const now = Date.now();
  const insert = db.prepare(`INSERT INTO news_articles(url,url_key,title,source,press,category,published_at,fetched_at,
    raw_summary,body_text,summary,summary_quality,image_url) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  db.exec('BEGIN');
  // 90일에 고르게 퍼뜨린다. 24시간 창에는 60건 남짓, 30일 창에는 1/3 이 든다.
  for (let i = 0; i < ARTICLES; i += 1) {
    const at = new Date(now - (ARTICLES - i) * (90 * 86400000 / ARTICLES)).toISOString();
    const category = CATEGORIES[i % CATEGORIES.length];
    insert.run(`https://n.news.naver.com/mnews/article/001/${i}`, `k${i}`, `${category} 기사 ${i}`, 'naver', '연합뉴스',
      category, i % 50 === 0 ? at.slice(0, 10) : at, at, '원문', 'x'.repeat(320), '1) 요약입니다.',
      i % 20 === 0 ? 'none' : 'full', '');
  }
  const runs = db.prepare('INSERT INTO news_runs(started_at,finished_at,status,inserted_count,message) VALUES(?,?,?,?,?)');
  for (let i = 0; i < 640; i += 1) {
    const at = new Date(now - i * 3 * 3600000).toISOString();
    runs.run(at, at, 'ok', 3, '{"diagnostics":{"mode":"scheduled"}}');
  }
  const attempts = db.prepare('INSERT INTO news_summary_attempts(url_key,attempts,last_attempt) VALUES(?,?,?)');
  for (let i = 0; i < 400; i += 1) attempts.run(`k${i * 7}`, i % 7, new Date(now - i * 60000).toISOString());
  const popularity = db.prepare('INSERT INTO news_popularity(url_key,score,rank,source,collected_at) VALUES(?,?,?,?,?)');
  for (let i = 0; i < 1500; i += 1) popularity.run(`k${ARTICLES - 1 - i * 3}`, 100 - (i % 100), (i % 50) + 1, 'naver', new Date(now - i * 3600000).toISOString());
  db.exec('COMMIT');
  // 운영에서는 수집이 하나씩 만들어 둔다(ensureNewsReadIndexes). 여기서는 다 있는 상태를 본다.
  for (const [, sql] of NEWS_READ_INDEXES) db.exec(sql);
  db.exec('ANALYZE');
  return db;
}

// D1 모양을 흉내 낸다. 쿼리마다 실행 계획을 적어 두고 meta.rows_read 를 채운다.
function d1(db, plans) {
  const count = name => db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n;
  const planOf = sql => {
    if (!/^\s*(SELECT|WITH|INSERT|UPDATE|DELETE)/i.test(sql)) return [];
    return db.prepare('EXPLAIN QUERY PLAN ' + sql).all().map(row => row.detail);
  };
  const statement = (sql, params = []) => {
    const execute = kind => {
      const plan = planOf(sql);
      plans.push({ sql: sql.replace(/\s+/g, ' ').trim(), plan });
      const scanned = plan.some(scansWholeArticleTable);
      const meta = { rows_read: scanned ? count('news_articles') : 1 };
      const prepared = db.prepare(sql);
      if (kind === 'run') { const result = prepared.run(...params); return { meta: { ...meta, changes: Number(result.changes) } }; }
      return { results: prepared.all(...params), meta };
    };
    return {
      bind: (...values) => statement(sql, values.map(value => value === undefined ? null : typeof value === 'boolean' ? Number(value) : value)),
      first: async column => { const row = execute('all').results[0] ?? null; return column === undefined ? row : row?.[column] ?? null; },
      all: async () => execute('all'),
      run: async () => /RETURNING/i.test(sql) ? execute('all') : execute('run'),
      raw: async () => execute('all').results.map(Object.values)
    };
  };
  return {
    prepare: sql => statement(sql),
    batch: async list => Promise.all(list.map(item => item.run())),
    exec: async sql => db.exec(sql)
  };
}

const collectorRequest = path => new Request(`https://newsbrief.test${path}`, {
  method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: '{}'
});

async function withNoNetwork(run) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('', { status: 404 });
  try { return await run(); } finally { globalThis.fetch = original; }
}

function fullArticleScans(plans) {
  return plans.filter(({ plan }) => plan.some(scansWholeArticleTable));
}

test('자동으로 도는 경로는 기사 표를 통째로 훑지 않는다', async () => {
  const paths = [
    ['수집', env => collect({ request: collectorRequest('/api/news/collect?source=scheduled'), env })],
    ['바둑 수집', env => collect({ request: collectorRequest('/api/news/collect?source=scheduled&baduk_only=1'), env })],
    ['재요약', env => collect({ request: collectorRequest('/api/news/collect?repair=1&force_retry=1'), env })],
    ['시각 복구', env => collect({ request: collectorRequest('/api/news/collect?repair_times=1'), env })],
    ['health', env => health({ env })],
    ['주간 목록', env => articles({ request: new Request('https://newsbrief.test/api/news/articles?limit=150&view=popular&exclude_baduk=1&hours=168&issues=1'), env })],
    ['월간 목록', env => articles({ request: new Request('https://newsbrief.test/api/news/articles?limit=150&view=popular&exclude_baduk=1&hours=720&issues=1'), env })],
    ['바둑 목록', env => articles({ request: new Request('https://newsbrief.test/api/news/articles?limit=120&view=latest&category=%EB%B0%94%EB%91%91&hours=24'), env })],
    ['이슈 분류', env => classifyIssues({ request: collectorRequest('/api/news/classify-issues?category=%EC%9D%BC%EB%B0%98'), env })]
  ];
  for (const [name, run] of paths) {
    const plans = [];
    const response = await withNoNetwork(() => run({ DB: d1(seed(), plans), NEWSBRIEF_COLLECT_TOKEN: 't' }));
    assert.equal(response.status, 200, name);
    const scans = fullArticleScans(plans);
    assert.deepEqual(scans.map(({ sql }) => sql.slice(0, 160)), [], `${name}: 기사 표 전체를 훑는 쿼리`);
  }
});

test('수집 앞 정리는 최근 실행 500건을 남기고 요약이 붙은 기사의 시도 기록만 지운다', async () => {
  const db = seed();
  const fullWithAttempts = db.prepare(`SELECT COUNT(*) AS n FROM news_summary_attempts f
    JOIN news_articles a ON a.url_key=f.url_key WHERE a.summary_quality='full'`).get().n;
  const attemptsBefore = db.prepare('SELECT COUNT(*) AS n FROM news_summary_attempts').get().n;
  const newestRun = db.prepare('SELECT MAX(id) AS id FROM news_runs').get().id;
  assert.ok(fullWithAttempts > 0);
  await withNoNetwork(() => collect({ request: collectorRequest('/api/news/collect?source=scheduled'), env: { DB: d1(db, []), NEWSBRIEF_COLLECT_TOKEN: 't' } }));
  // 정리 뒤 이번 실행이 한 줄 더한다.
  const runs = db.prepare('SELECT COUNT(*) AS n, MIN(id) AS low FROM news_runs').get();
  assert.equal(runs.n, 501);
  assert.equal(runs.low, newestRun - 499);
  const remainingFull = db.prepare(`SELECT COUNT(*) AS n FROM news_summary_attempts f
    JOIN news_articles a ON a.url_key=f.url_key WHERE a.summary_quality='full'`).get().n;
  assert.equal(remainingFull, 0);
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM news_summary_attempts').get().n >= attemptsBefore - fullWithAttempts);
});

test('하루 읽기 한도에 닿으면 수집과 이슈 분류는 읽지 않고 건너뛰고 health 가 알린다', async () => {
  const db = seed();
  const env = { DB: d1(db, []), NEWSBRIEF_COLLECT_TOKEN: 't' };
  await withNoNetwork(() => collect({ request: collectorRequest('/api/news/collect?source=scheduled'), env }));
  const recorded = db.prepare('SELECT value FROM news_state WHERE key=?').get(d1ReadDayKey())?.value;
  assert.ok(recorded > 0, '수집이 읽은 줄 수를 장부에 남긴다');

  db.prepare('UPDATE news_state SET value=? WHERE key=?').run(D1_DAILY_READ_LIMIT_DEFAULT, d1ReadDayKey());
  const plans = [];
  const skipped = await withNoNetwork(() => collect({ request: collectorRequest('/api/news/collect?source=scheduled'), env: { ...env, DB: d1(db, plans) } }));
  assert.equal(skipped.status, 200, '5xx 면 curl 과 수집 스크립트가 되풀이한다');
  assert.equal((await skipped.json()).skipped, 'd1_daily_read_limit');
  // 남는 것은 스키마 준비(CREATE ... IF NOT EXISTS)뿐이어야 한다.
  assert.deepEqual(plans.filter(({ sql }) => /news_articles/.test(sql) && !/\bCREATE (TABLE|INDEX) IF NOT EXISTS\b/i.test(sql)).map(({ sql }) => sql), []);

  const classify = await withNoNetwork(() => classifyIssues({ request: collectorRequest('/api/news/classify-issues?category=%EC%9D%BC%EB%B0%98'), env }));
  assert.equal((await classify.json()).skipped, 'd1_daily_read_limit');

  const report = await (await health({ env })).json();
  assert.ok(report.failures.includes('d1_reads_under_daily_limit'));
  assert.equal(report.metrics.d1_rows_read_today, D1_DAILY_READ_LIMIT_DEFAULT);

  const raised = await withNoNetwork(() => collect({ request: collectorRequest('/api/news/collect?source=scheduled'), env: { ...env, NEWSBRIEF_D1_DAILY_READ_LIMIT: String(D1_DAILY_READ_LIMIT_DEFAULT * 2) } }));
  assert.notEqual((await raised.json()).skipped, 'd1_daily_read_limit');
});

test('읽기 인덱스는 수집마다 하나씩 만들고, 만들다 실패해도 수집은 그대로 한다', async () => {
  // 이미 있는 표에 인덱스를 만들면 행 수만큼 쓰기가 잡힌다(무료 하루 10만 줄, 계정 공용).
  // 한 번에 다 만들다 한도에 걸리면 수집이 매번 실패하며 되풀이된다.
  const db = new DatabaseSync(':memory:');
  db.exec(NEWS_SCHEMA);
  const made = () => {
    const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(row => row.name));
    return NEWS_READ_INDEXES.filter(([name]) => names.has(name)).length;
  };
  assert.equal(made(), 0);
  for (let call = 1; call <= NEWS_READ_INDEXES.length; call += 1) {
    const response = await withNoNetwork(() => collect({ request: collectorRequest('/api/news/collect?source=scheduled'), env: { DB: d1(db, []), NEWSBRIEF_COLLECT_TOKEN: 't' } }));
    assert.equal(response.status, 200);
    assert.equal(made(), call, `${call}번째 수집 뒤`);
  }

  const bare = new DatabaseSync(':memory:');
  bare.exec(NEWS_SCHEMA);
  const failing = d1(bare, []);
  const prepare = failing.prepare;
  failing.prepare = sql => {
    const statement = prepare(sql);
    if (!NEWS_READ_INDEXES.some(([, create]) => create === sql)) return statement;
    return { ...statement, run: async () => { throw new Error('D1_ERROR: exceeded daily rows written limit'); } };
  };
  const response = await withNoNetwork(() => collect({ request: collectorRequest('/api/news/collect?source=scheduled'), env: { DB: failing, NEWSBRIEF_COLLECT_TOKEN: 't' } }));
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.ok, true);
  assert.match(body.diagnostics.d1_read_index.error, /rows written/);
});

test('시각 복구는 커서 뒤의 날짜만 있는 기사와 어디에 있든 미래 시각 기사를 함께 id 순으로 고른다', async () => {
  // 한 쿼리의 OR 을 두 쿼리로 나눴다(각자 인덱스를 타게). 고르는 집합과 순서가 예전과 같아야 한다.
  const { repairGeneralArticleTimes } = await import('../functions/_lib/news-repairs.js');
  const db = seed();
  const future = new Date(Date.now() + 9 * 3600000).toISOString();
  // 커서(5900) 앞에 하나, 뒤에 하나 미래 시각을 심는다.
  db.prepare('UPDATE news_articles SET published_at=? WHERE id IN (5801, 5951)').run(future);
  db.prepare("INSERT INTO news_state(key,value) VALUES('general_time_repair_cursor',5900)").run();
  const expected = db.prepare(`SELECT id FROM news_articles
    WHERE datetime(COALESCE(NULLIF(published_at,''),fetched_at))>=datetime('now','-30 days')
      AND ((id>5900 AND summary_quality='full' AND url NOT LIKE '%baduk.or.kr%'
          AND (TRIM(published_at)='' OR published_at GLOB '????-??-??')
          AND NOT EXISTS(SELECT 1 FROM news_time_checks t WHERE t.url_key=news_articles.url_key))
        OR datetime(published_at)>datetime('now','+2 hours'))
    ORDER BY id LIMIT 10`).all().map(row => row.id);
  assert.ok(expected.includes(5801) && expected.includes(5951));
  const plans = [];
  const result = await withNoNetwork(() => repairGeneralArticleTimes({ DB: d1(db, plans) }));
  assert.equal(result.attempted, expected.length);
  const checked = new Set(db.prepare('SELECT url_key FROM news_time_checks').all().map(row => row.url_key));
  for (const id of expected) assert.ok(checked.has(`k${id - 1}`), `id ${id} 를 확인했다`);
  // 원문에서 시각을 못 얻었고 저장값이 미래였으므로 비운다.
  assert.equal(db.prepare('SELECT published_at FROM news_articles WHERE id=5801').get().published_at, '');
  assert.equal(db.prepare('SELECT published_at FROM news_articles WHERE id=5951').get().published_at, '');
  assert.deepEqual(fullArticleScans(plans).map(({ sql }) => sql.slice(0, 120)), []);
});

test('기사 목록은 정렬 값이 같은 기사를 id 오름차순으로 낸다', async () => {
  // 날짜만 있는 기사는 전부 그날 00:00 으로 같은 값이다. 예전에는 표를 id 순으로 훑어
  // 정렬해서 동률이 id 오름차순이었다. 시간 인덱스를 타도 그 순서가 그대로여야 LIMIT
  // 경계에서 들어가는 기사가 바뀌지 않는다.
  const db = seed();
  const day = new Date(Date.now() - 3600000).toISOString().slice(0, 10);
  // 제목·요약이 비슷하면 목록이 한 카드로 접으므로 서로 겹치지 않게 준다.
  db.prepare(`UPDATE news_articles SET published_at=?, summary_quality='full',
    title=hex(randomblob(8))||' '||hex(randomblob(8)), summary='1) '||hex(randomblob(12))||' '||hex(randomblob(12))
    WHERE id BETWEEN 5901 AND 5960`).run(day);
  const response = await articles({ request: new Request('https://newsbrief.test/api/news/articles?limit=200&view=latest'), env: { DB: d1(db, []) } });
  const items = (await response.json()).items.filter(item => item.published_at === day);
  assert.ok(items.length > 10);
  const ids = items.map(item => Number(item.id));
  assert.deepEqual(ids, [...ids].sort((left, right) => left - right));
});
