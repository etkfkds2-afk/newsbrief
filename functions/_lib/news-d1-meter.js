// D1 하루 읽기 퓨즈.
//
// Cloudflare 무료 요금제의 D1 읽기 한도(하루 500만 줄)는 **계정 전체가 같이 쓴다.**
// 같은 계정에 올댓마인드 대관관리(homepage-payment)와 data-lab 이 있다. newsbrief 가
// 한도를 다 쓰면 그 둘도 UTC 자정까지 D1 을 못 읽는다. 2026-09-30 이 그랬다: 기사가
// 쌓일수록 매 수집이 기사 전체를 훑어 하루 1,600만 줄을 읽었고, 대관관리 예약 목록이
// 오전 내내 500 이었다.
//
// 쿼리는 인덱스를 타도록 고쳤다(news-db.js). 이 퓨즈는 그다음 안전장치다 - 나중에
// 누가 쿼리를 바꿔 다시 전체를 훑게 되더라도, newsbrief 는 정해 둔 몫 이상을 읽기
// 전에 그날 수집을 스스로 멈춘다. 평소 사용량은 이 몫보다 훨씬 작아서 정상일 때는
// 걸리지 않는다. 걸렸다면 어딘가 새고 있다는 뜻이다(health 가 알린다).
//
// D1 은 쿼리마다 meta.rows_read 로 읽은 줄 수를 돌려준다. 그걸 요청 동안 더해서
// 끝날 때 news_state 에 날짜별로 한 번 쓴다. 날짜는 UTC 다 - D1 한도가 UTC 자정에 풀린다.

// 계정 한도(500만)의 20%. 고친 뒤 실측(scanstats, 기사 8천 건 가정) 평소 사용량은 하루 약
// 30만 줄이라 3배 넘게 남는다 - 50만으로 두면 기사가 많은 날 정상인데도 수집이 멈출 수 있다.
// 폭주(2026-09-30 이전 코드는 이슈 분류 한 번에 천만 줄 단위)는 이 값으로도 바로 막힌다.
// 나머지 80%는 같은 계정의 대관관리와 data-lab 몫이다.
export const D1_DAILY_READ_LIMIT_DEFAULT = 1000000;
const KEY_PREFIX = 'd1_rows_read:';

export function d1ReadDayKey(now = new Date()) {
  return KEY_PREFIX + now.toISOString().slice(0, 10);
}

export function d1DailyReadLimit(env) {
  const configured = Number(env?.NEWSBRIEF_D1_DAILY_READ_LIMIT);
  return Number.isFinite(configured) && configured > 0 ? configured : D1_DAILY_READ_LIMIT_DEFAULT;
}

export async function d1RowsReadToday(env, now = new Date()) {
  try {
    const row = await env.DB.prepare('SELECT value FROM news_state WHERE key=?').bind(d1ReadDayKey(now)).first();
    const value = Number(row?.value || 0);
    return Number.isFinite(value) ? value : 0;
  } catch {
    // 장부를 못 읽었다고 수집을 막지 않는다. 한도 초과로 못 읽는 때라면 어차피 수집도 못 한다.
    return 0;
  }
}

// env.DB 를 감싸 읽은 줄 수를 센다. 쿼리와 결과는 그대로 넘긴다.
//
// first() 는 D1 에서 meta 를 주지 않아서 all() 로 부르고 첫 행을 돌려준다. D1 의
// first() 도 LIMIT 을 붙이지 않고 같은 쿼리를 돌리므로 읽는 양은 같다.
// all() 이 meta 를 안 주면(테스트의 가짜 DB) 원래 first() 를 쓴다 - 가짜는 first 와
// all 이 서로 다른 값을 주도록 만들어진 것이 있다.
export function meterD1(env) {
  const db = env.DB;
  let rowsRead = 0;
  const add = result => { rowsRead += Number(result?.meta?.rows_read || 0); };
  const wrap = statement => ({
    __inner: statement,
    bind: (...values) => wrap(statement.bind(...values)),
    first: async column => {
      if (typeof statement.all !== 'function') return statement.first(column);
      const result = await statement.all();
      if (!result || typeof result.meta !== 'object' || result.meta === null) return statement.first(column);
      add(result);
      const row = result.results?.[0] ?? null;
      if (column === undefined) return row;
      return row ? (row[column] ?? null) : null;
    },
    all: async () => { const result = await statement.all(); add(result); return result; },
    run: async () => { const result = await statement.run(); add(result); return result; },
    raw: (...args) => statement.raw(...args)
  });
  const metered = new Proxy(db, {
    get: (target, property) => {
      // 감싸기 전 DB. 요청마다 새로 감싸므로 "이 DB 에 이미 했다"는 기억은 이걸로 한다.
      if (property === '__raw') return target;
      if (property === 'prepare') return sql => wrap(target.prepare(sql));
      if (property === 'batch') {
        return async statements => {
          const results = await target.batch(statements.map(statement => statement?.__inner || statement));
          for (const result of results || []) add(result);
          return results;
        };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  return {
    env: { ...env, DB: metered },
    rowsRead: () => rowsRead,
    // 요청이 끝날 때 한 번 쓴다. 장부 쓰기가 실패해도 요청 결과는 바꾸지 않는다.
    save: async (now = new Date()) => {
      if (!rowsRead) return;
      try {
        await db.batch([
          db.prepare('INSERT INTO news_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=value+excluded.value')
            .bind(d1ReadDayKey(now), rowsRead),
          // 일주일 지난 날짜 장부는 지운다. news_state 는 몇십 줄이라 훑어도 싸다.
          db.prepare(`DELETE FROM news_state WHERE key LIKE '${KEY_PREFIX}%' AND key<?`)
            .bind(d1ReadDayKey(new Date(now.getTime() - 7 * 86400000)))
        ]);
      } catch {}
    }
  };
}
