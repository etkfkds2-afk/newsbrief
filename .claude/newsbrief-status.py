"""세션 시작 훅이 쓰는 요약기. stdin으로 /api/news/health JSON을 받는다.

출력은 매 세션 Claude 컨텍스트에 들어가므로 짧게 유지한다.
"""
import json
import sys

# 2026-08-07 03:43 UTC, 예산 페이싱 + 재요약 게이트 배포 직후 측정한 기준선.
BASE_GENERAL = 19
BASE_BADUK = 7
# 임계값이 실제 값보다 낮게 잡혀 매번 뜨는 것으로 확인된 항목. 며칠 데이터를
# 보고 조정할 때까지 새 문제와 섞이지 않도록 걸러낸다.
KNOWN_FALSE_ALARMS = {'summary_exhausted_below_threshold', 'published_time_complete'}


def mark(now, base):
    return '유지' if now >= base else '하락(-{})'.format(base - now)


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
    allowance = metrics.get('claude_daily_allowance_micro_usd', 0) / 1e6
    month = metrics.get('claude_monthly_micro_usd', 0) / 1e6

    run = metrics.get('last_automatic_run') or {}
    try:
        mode = (json.loads(run.get('message', '{}')).get('diagnostics') or {}).get('mode', '?')
    except Exception:
        mode = '?'
    finished = run.get('finished_at', '없음')
    age = metrics.get('automatic_age_hours', '?')

    failures = [f for f in health.get('failures', []) if f not in KNOWN_FALSE_ALARMS]

    print('=== newsbrief 자동 점검 (2026-08-07 Claude 예산 변경 추적) ===')
    print('기사 24h: general {} (기준 {}, {}) / baduk {} (기준 {}, {})'.format(
        general, BASE_GENERAL, mark(general, BASE_GENERAL),
        baduk, BASE_BADUK, mark(baduk, BASE_BADUK)))
    print('Claude: 오늘 ${:.3f} / 허용 ${:.3f}  |  이번달 ${:.3f} / 목표 $4.75 (하드 $5)'.format(
        spent, allowance, month))
    print('마지막 자동 실행: {} mode={} ({}시간 전)'.format(finished, mode, age))
    print('헬스 실패: {}  (summary_exhausted/published_time은 알려진 오탐이라 제외)'.format(
        failures if failures else '없음'))
    print('→ 기사 수가 기준 아래면 사용자에게 먼저 알리고, 원인 커밋만 골라 revert 가능하다고 안내할 것. '
          '자세한 배경은 메모리 project_newsbrief_claude_budget_2026_08 참고.')


main()
