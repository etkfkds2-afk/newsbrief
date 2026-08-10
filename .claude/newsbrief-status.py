"""세션 시작 훅이 쓰는 요약기. stdin으로 /api/news/health JSON을 받는다.

출력은 매 세션 Claude 컨텍스트에 들어가므로 짧게 유지한다.
"""
import datetime
import json
import sys

# 2026-08-07 03:43 UTC 측정. general만 기준선으로 쓴다.
BASE_GENERAL = 19
# 바둑은 기준선을 두지 않는다. 소스(한국기원)가 2~4일에 한 번 올려서 0인 날이
# 정상이고, 8/9에 이 값을 회귀로 오해해 예산 커밋을 반나절 뒤졌다. 실제로 볼
# 것은 "소스에 있는 걸 우리가 가져왔나"이고, 그건 아래 안내대로 소스 날짜를
# 직접 확인해야 한다.
# 2026-08-10: 오탐 세 개를 health.js에서 직접 고쳤으므로 여기서 걸러낼 것이 없다.
# 손으로 무시하는 목록은 증상만 가린다 - 새 오탐이 생길 때마다 늘어나고, 그 사이
# 진짜 실패가 목록에 묻힌다. 다시 채우기 전에 검사 자체를 고칠 수 없는지 본다.
KNOWN_FALSE_ALARMS = set()
CLAUDE_MONTHLY_TARGET = 4.75


def main():
    try:
        health = json.load(sys.stdin)
    except Exception:
        print('newsbrief: health 응답 파싱 실패')
        return

    metrics = health.get('metrics', {})
    general = metrics.get('general_24h', 0)
    baduk = metrics.get('baduk_24h', 0)
    spent = metrics.get('claude_daily_micro_usd', 0) / 1e6
    month = metrics.get('claude_monthly_micro_usd', 0) / 1e6

    now = datetime.datetime.now(datetime.timezone.utc)
    days_in_month = (now.replace(day=28) + datetime.timedelta(days=4)).replace(day=1)
    days_left = max((days_in_month - now).total_seconds() / 86400, 0.5)
    budget_per_day = max(CLAUDE_MONTHLY_TARGET - month, 0) / days_left

    run = metrics.get('last_automatic_run') or {}
    diag = {}
    try:
        diag = json.loads(run.get('message', '{}')).get('diagnostics') or {}
    except Exception:
        pass

    failures = [f for f in health.get('failures', []) if f not in KNOWN_FALSE_ALARMS]

    print('=== newsbrief 자동 점검 (2026-08-09 예산·게이트 변경 판정 중) ===')
    print('기사 24h: general {} (기준 {}, {}) / baduk {} (기준선 없음)'.format(
        general, BASE_GENERAL,
        '유지' if general >= BASE_GENERAL else '-{}'.format(BASE_GENERAL - general),
        baduk))
    print('Claude: 오늘 ${:.3f}  vs 지속가능 ${:.3f}/일  ({})  |  이번달 ${:.3f} / 목표 ${}'.format(
        spent, budget_per_day,
        'OK' if spent <= budget_per_day else '초과',
        month, CLAUDE_MONTHLY_TARGET))
    print('마지막 자동 실행: {} mode={} ({}시간 전)'.format(
        run.get('finished_at', '없음'), diag.get('mode', '?'),
        metrics.get('automatic_age_hours', '?')))

    # 재요약 게이트를 다시 켠 뒤 실제로 유료 호출이 신규 기사로 갔는지 보는 값.
    deferred = (diag.get('candidate_outcomes') or {}).get('existing_repair_deferred')
    failed = (diag.get('candidate_outcomes') or {}).get('existing_repair_failed')
    if deferred is not None or failed is not None:
        print('재요약: 미룸 {} / 실패 {}  (미룸이 늘고 실패가 줄면 게이트가 의도대로 동작)'.format(
            deferred or 0, failed or 0))

    print('헬스 실패: {}  (오탐 목록 없음 - 뜨면 진짜다)'.format(failures if failures else '없음'))
    print('바둑 수집: 소스 최신 {} / 우리 최신 {}'.format(
        metrics.get('baduk_source_latest') or '기록 없음',
        metrics.get('baduk_stored_latest') or '없음'))
    print('→ 판정: general이 19 이상이고 오늘 지출이 지속가능선 이하면 8/9 변경은 성공이다. '
          '어긋나면 사용자에게 알리고 `scripts/rollback.sh revert 31afcf0`을 제안할 것. '
          '수동 수집을 돌리면 두 값이 모두 오염되므로 판정 전에는 돌리지 말 것.')
    print('→ 바둑 24h가 0이어도 그 자체로는 이상이 아니다. 소스가 2~4일에 한 번 올린다. '
          '위 "바둑 수집" 줄에서 우리 최신이 소스 최신 이상이면 정상이고, '
          'baduk_source_collected 실패가 뜨면 그때가 진짜 누락이다.')
    print('배경: 메모리 project_newsbrief_claude_budget_2026_08 참고.')


main()
