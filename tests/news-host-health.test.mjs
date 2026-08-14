// 매체 격리 장부의 **동작**을 검증한다.
//
// 이 장부는 잘못 잡으면 고치려던 것보다 큰 고장을 만든다 - 2026-08-14에 하루 만에
// 8개 호스트가 갇혔고 그 사이 24시간 바둑 발행이 0건이 됐다. 아래는 그때의 사고를
// 각각 재현해 두고, 지금 코드가 그 사고를 내지 않는지 본다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadHostHealth } from '../functions/_lib/news-host-health.js';

function fakeDb(stored = null) {
  const state = { article_host_health: stored === null ? null : JSON.stringify(stored) };
  return {
    state,
    DB: {
      prepare: sql => {
        let binds = [];
        const stmt = {
          bind: (...values) => { binds = values; return stmt; },
          first: async () => (state.article_host_health === null
            ? null : { value: state.article_host_health }),
          run: async () => {
            if (/INSERT INTO news_state/.test(sql)) state.article_host_health = binds[0];
            return { meta: {} };
          }
        };
        return stmt;
      }
    }
  };
}

const ledgerOf = db => JSON.parse(db.state.article_host_health || '{}');
const now = () => new Date().toISOString();
const failing = (host, count) => ({ __rule: '2', [host]: { fail: count, at: now() } });

test('연속 실패가 기준을 넘긴 매체는 후보에서 빠진다', async () => {
  const db = fakeDb(failing('www.kukinews.com', 5));
  const health = await loadHostHealth(db, {});
  assert.equal(health.isQuarantined('https://www.kukinews.com/article/1'), true);
  assert.equal(health.isQuarantined('https://www.otherpaper.co.kr/a/1'), false);
});

test('기준에 못 미치면 가두지 않는다', async () => {
  const db = fakeDb(failing('www.kukinews.com', 4));
  const health = await loadHostHealth(db, {});
  assert.equal(health.isQuarantined('https://www.kukinews.com/article/1'), false);
});

test('하루가 지나면 스스로 한 번 다시 시도한다', async () => {
  const twoDaysAgo = new Date(Date.now() - 48 * 3600000).toISOString();
  const db = fakeDb({ __rule: '2', 'sjbnews.com': { fail: 9, at: twoDaysAgo } });
  const health = await loadHostHealth(db, {});
  assert.equal(health.isQuarantined('https://sjbnews.com/news/1'), false,
    '사람이 아무것도 안 해도 돌아와야 한다');
});

test('본문을 받아오면 실패 기록이 지워진다', async () => {
  const db = fakeDb(failing('www.viva100.com', 6));
  const health = await loadHostHealth(db, {});
  assert.equal(health.isQuarantined('https://www.viva100.com/a/1'), true);
  health.record('https://www.viva100.com/a/1', true);
  assert.equal(health.isQuarantined('https://www.viva100.com/a/1'), false);
});

test('selector_miss로는 절대 가두지 않는다', async () => {
  // 2026-08-14의 사고: gamefocus·game.donga가 selector_miss만으로 갇혔다.
  // 그건 매체가 막은 게 아니라 우리가 그 CMS의 본문 자리를 모르는 것이고,
  // 가두면 기사와 함께 "무엇을 고쳐야 하는지"라는 단서까지 사라진다.
  const db = fakeDb();
  const health = await loadHostHealth(db, {});
  for (let i = 0; i < 10; i += 1) health.record('https://gamefocus.co.kr/n/1', false, 'selector_miss');
  assert.equal(health.isQuarantined('https://gamefocus.co.kr/n/1'), false);
  assert.deepEqual(health.quarantinedHosts(), []);
});

test('우리 쪽 사정으로 죽은 실패는 매체 탓으로 적지 않는다', async () => {
  // 외부 요청 한도 초과(error_...)와 그 기사 한 건이 지워진 것(404)은 매체 고장이
  // 아니다. 그것까지 세면 멀쩡한 매체가 하루 차단된다.
  const db = fakeDb();
  const health = await loadHostHealth(db, {});
  for (const status of ['error_Error:Too many subrequests', 'http_404', 'dead_page']) {
    for (let i = 0; i < 6; i += 1) health.record('https://www.example.co.kr/a/1', false, status);
  }
  assert.equal(health.isQuarantined('https://www.example.co.kr/a/1'), false);
});

test('차단·서버다운은 매체 탓으로 적는다', async () => {
  const db = fakeDb();
  const health = await loadHostHealth(db, {});
  for (let i = 0; i < 5; i += 1) health.record('https://www.kukinews.com/a/1', false, 'http_403');
  assert.equal(health.isQuarantined('https://www.kukinews.com/a/1'), true);

  const health2 = await loadHostHealth(fakeDb(), {});
  for (let i = 0; i < 5; i += 1) health2.record('https://sjbnews.com/a/1', false, 'http_522');
  assert.equal(health2.isQuarantined('https://sjbnews.com/a/1'), true);
});

test('핵심 소스와 본문이 오는 포털은 격리 대상이 아니다', async () => {
  const db = fakeDb();
  const health = await loadHostHealth(db, {});
  for (const url of ['https://www.baduk.or.kr/n/1', 'https://n.news.naver.com/a/1', 'https://v.daum.net/v/1']) {
    for (let i = 0; i < 20; i += 1) health.record(url, false, 'http_403');
    assert.equal(health.isQuarantined(url), false, `${url}는 격리하면 안 된다`);
  }
});

test('판정 규칙이 바뀌면 옛 장부는 버린다', async () => {
  // 규칙만 고치고 장부를 두면, 이제는 가두지 않기로 한 사유로 이미 쌓인 매체가
  // 하루 더 갇혀 있다 - 고쳤는데 아무것도 안 달라지는 상태가 된다.
  const db = fakeDb({ __rule: '1', 'gamefocus.co.kr': { fail: 9, at: now() } });
  const diagnostics = {};
  const health = await loadHostHealth(db, diagnostics);
  assert.equal(health.isQuarantined('https://gamefocus.co.kr/n/1'), false);
  assert.equal(diagnostics.host_quarantine_reset, 1);
});

test('저장할 때 규칙 표시를 지우지 않는다', async () => {
  // __rule은 호스트가 아니라 시각이 없다. 오래된 기록을 버리면서 같이 지우면
  // 다음 실행이 "규칙이 바뀌었다"고 오인해 장부를 매번 비운다 - 격리가 영영
  // 발동하지 않게 된다.
  const db = fakeDb();
  const health = await loadHostHealth(db, {});
  for (let i = 0; i < 5; i += 1) health.record('https://www.kukinews.com/a/1', false, 'http_403');
  await health.save();
  const saved = ledgerOf(db);
  assert.equal(saved.__rule, '2');
  assert.equal(saved['www.kukinews.com'].fail, 5);
});
