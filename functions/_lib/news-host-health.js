// 본문을 못 주는 매체를 스스로 기억하고 스스로 풀어주는 장부.
//
// 사람이 차단 목록을 손으로 관리하면, 새로 막힌 매체가 생길 때마다 누군가 진단을
// 읽고 목록에 적어야 한다. 그 사이 그 매체는 매 실행 슬롯과 외부 요청을 가져간다
// (2026-08-12 실측: 바둑 20칸 중 6칸이 body_too_short).
//
// 연속 실패가 기준을 넘으면 하루 동안 후보에서 뺀다. 하루가 지나면 자동으로 한 번
// 다시 시도하고, 그때 성공하면 기록이 지워진다. 매체가 차단을 풀거나 페이지 구조를
// 되돌리면 사람이 아무것도 안 해도 돌아온다.
//
// **이 장부는 잘못 쓰면 고치려던 것보다 큰 고장을 만든다.** 2026-08-14 실측:
// 하루 만에 8개 호스트가 갇혔고 그 사이 24시간 바둑 발행이 0건이 됐다. 그래서
// 아래 세 가지 경계가 전부 "덜 가두는" 쪽으로 잡혀 있다.
const QUARANTINE_FAIL_THRESHOLD = 5;
const QUARANTINE_HOURS = 24;

// 경계 1: 핵심 소스는 격리하지 않는다. 한국기원이 잠깐 흔들렸다고 바둑의 원천을
// 하루 끊으면 안 된다. 다만 예외는 **본문을 실제로 주는 호스트**로 좁힌다.
// naver.com 전체를 열면 entertain.naver.com처럼 JS로만 그리는 페이지가 영원히
// 재시도된다(2026-08-12 실측: 2KB 껍데기, 매 실행 selector_miss 2건).
// 예외는 "믿는 곳"이 아니라 "본문이 오는 곳"이어야 한다.
const NEVER_QUARANTINE = /(?:^|\.)(?:baduk\.or\.kr|news\.naver\.com|v\.daum\.net|news\.daum\.net)$/i;

// 경계 2: 매체 탓인 실패만 적는다. 본문 실패에는 원인이 뒤섞여 들어온다 - 우리가
// 그 실행의 외부 요청을 다 써서 못 가져온 것(error_...)도, 그 기사 한 건이 지워진
// 것(http_404·dead_page)도 같은 자리로 떨어진다. 그것까지 세면 우리 쪽 사정으로
// 멀쩡한 매체가 하루 차단된다.
//
// selector_miss도 뺀다. 그건 매체가 막은 게 아니라 **우리가 그 CMS의 본문 자리를
// 모르는 것**이고, 고칠 수 있는 유일한 종류다. 격리하면 그 매체의 기사와 함께
// "무엇을 고쳐야 하는지"라는 단서까지 사라진다. 조용히 감추면 영영 안 고친다.
const HOST_ATTRIBUTABLE_FAILURE = /^(?:non_html|http_(?:403|429|5\d\d))$/;

// 경계 3: 판정 규칙을 바꾸면 옛 규칙으로 쌓인 장부는 버린다. 규칙만 고치고 장부를
// 두면, 이제는 가두지 않기로 한 사유로 이미 5회가 쌓인 매체가 그대로 갇혀 있다 -
// 고쳤는데 하루 동안 아무것도 안 달라진다. 위 두 경계를 고칠 때는 이 값을 함께
// 올려야 한다. 그게 "옛 판정으로 갇힌 곳을 전부 풀어준다"는 뜻이다.
const QUARANTINE_RULE_VERSION = '2';

const STATE_KEY = 'article_host_health';

function hostOf(value) {
  try { return new URL(value).hostname.toLowerCase(); } catch { return ''; }
}

export async function loadHostHealth(env, diagnostics = {}) {
  const row = await env.DB.prepare(`SELECT value FROM news_state WHERE key='${STATE_KEY}'`).first();
  let ledger = {};
  try { ledger = JSON.parse(String(row?.value || '{}')) || {}; } catch { ledger = {}; }
  let changed = false;
  if (String(ledger.__rule || '') !== QUARANTINE_RULE_VERSION) {
    diagnostics.host_quarantine_reset = Object.keys(ledger).filter(key => key !== '__rule').length;
    ledger = { __rule: QUARANTINE_RULE_VERSION };
    changed = true;
  }

  return {
    isQuarantined: value => {
      const host = hostOf(value);
      if (!host || NEVER_QUARANTINE.test(host)) return false;
      const record = ledger[host];
      if (!record || Number(record.fail || 0) < QUARANTINE_FAIL_THRESHOLD) return false;
      const lastAttempt = Date.parse(String(record.at || '')) || 0;
      // 하루가 지나면 한 번 통과시켜 본다(탐침). 실패하면 at이 갱신돼 또 하루 쉰다.
      return Date.now() - lastAttempt < QUARANTINE_HOURS * 3600000;
    },

    record: (value, ok, fetchStatus = '') => {
      const host = hostOf(value);
      if (!host || NEVER_QUARANTINE.test(host)) return;
      if (ok) {
        if (ledger[host]) { delete ledger[host]; changed = true; }
        return;
      }
      if (!HOST_ATTRIBUTABLE_FAILURE.test(String(fetchStatus || ''))) return;
      ledger[host] = { fail: Number(ledger[host]?.fail || 0) + 1, at: new Date().toISOString() };
      changed = true;
    },

    quarantinedHosts: () => {
      return Object.entries(ledger)
        .filter(([, record]) => Number(record?.fail || 0) >= QUARANTINE_FAIL_THRESHOLD)
        .map(([host, record]) => `${host}:${record.fail}`);
    },

    // 실행당 한 번만 쓴다. 후보마다 쓰면 D1 쓰기가 후보 수만큼 늘고, 어차피 다음
    // 실행 전에는 아무도 읽지 않는다.
    save: async () => {
      if (!changed) return;
      // 오래된 기록은 버린다. 격리가 24시간이므로 이틀 넘게 조용한 매체는 기억할
      // 이유가 없다. 규칙 표시(__rule)는 호스트가 아니라 시각이 없으므로 남긴다 -
      // 같이 지우면 다음 실행이 "규칙이 바뀌었다"고 오인해 장부를 매번 비운다.
      const staleBefore = Date.now() - 2 * QUARANTINE_HOURS * 3600000;
      const trimmed = Object.fromEntries(Object.entries(ledger)
        .filter(([host, record]) => host === '__rule'
          || (Date.parse(String(record?.at || '')) || 0) >= staleBefore));
      await env.DB.prepare(`INSERT INTO news_state(key,value) VALUES('${STATE_KEY}',?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(JSON.stringify(trimmed)).run();
    }
  };
}
