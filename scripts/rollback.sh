#!/usr/bin/env bash
# 기사가 안 나올 때 원인 값을 찾고 그 값을 넣은 커밋만 골라 되돌린다.
#
# 2026-08-09에 바둑 발행이 0이 됐을 때, 원인인 하루 예산 게이트 한 줄을
# 찾는 데 커밋 4개와 파일 3개를 뒤져야 했다. "각각 독립 revert 가능"이라고
# 적어두는 것만으로는 되돌리기가 쉬워지지 않는다. 기사를 막을 수 있는 값을
# 한자리에 모아 보여주고, 각 값이 어느 커밋에서 왔는지까지 붙인다.
#
#   scripts/rollback.sh            현재 관문 값 + 라이브 상태
#   scripts/rollback.sh log        functions/를 건드린 최근 커밋
#   scripts/rollback.sh show <sha> 그 커밋이 관문 값을 어떻게 바꿨는지
#   scripts/rollback.sh revert <sha>  되돌리고 테스트까지 돌린다
set -euo pipefail
cd "$(dirname "$0")/.."

HEALTH_URL="https://newsbrief-etkfkds2.pages.dev/api/news/health"

# 기사를 끊을 수 있는 값들. "설명|파일|grep 정규식" 형식.
# 새 관문을 추가하면 여기에도 한 줄 넣는다. 그러지 않으면 다음 사람이
# 오늘처럼 파일을 뒤지게 된다.
GATES=(
  "월 예산 목표(넘으면 유료 요약 중단)|functions/_lib/news-ai-budget.js|CLAUDE_MONTHLY_TARGET_MICRO_USD ="
  "월 예산 하드 한도|functions/_lib/news-ai-budget.js|CLAUDE_MONTHLY_HARD_LIMIT_MICRO_USD ="
  "하루 예산 차단(있으면 낮에 요약이 끊긴다)|functions/_lib/news-ai-budget.js|today < allowance"
  "Cloudflare AI 하루 호출 수|functions/_lib/news-ai-budget.js|CLOUDFLARE_DAILY_CALL_LIMIT ="
  "Anthropic 하루 호출 수|functions/api/news/collect.js|^const DAILY_ANTHROPIC_CALL_LIMIT ="
  "재요약 시도 상한(낮으면 밀린 기사가 영구 제외)|functions/api/news/collect.js|retryAttemptLimit = forceRetry"
  "카테고리별 하루 발행 상한|functions/api/news/collect.js|^const DAILY_CATEGORY_PUBLISH_LIMIT ="
  "실행당 바둑 후보 수|functions/api/news/collect.js|^const SCHEDULED_BADUK_CANDIDATES ="
  "실행당 general 후보 수|functions/api/news/collect.js|^const SCHEDULED_GENERAL_CANDIDATES ="
  "Google 발견 해석 수(서브리퀘스트를 먹는다)|functions/api/news/collect.js|^const SCHEDULED_GOOGLE_DISCOVERIES ="
  "인기 기사 해석 수(서브리퀘스트를 먹는다)|functions/api/news/collect.js|allPopular.slice"
  "처리 순서(general 먼저면 바둑이 서브리퀘스트를 못 받는다)|functions/api/news/collect.js|for \(const candidate of generalCandidates\)"
)

gates() {
  printf '=== 기사를 막을 수 있는 값 (HEAD %s) ===\n' "$(git rev-parse --short HEAD)"
  for entry in "${GATES[@]}"; do
    IFS='|' read -r label file pattern <<<"$entry"
    line=$(grep -nE -- "$pattern" "$file" 2>/dev/null | head -1 || true)
    if [ -z "$line" ]; then
      printf '  %-46s (없음)\n' "$label"
      continue
    fi
    lineno=${line%%:*}
    code=$(printf '%s' "${line#*:}" | sed 's/^[[:space:]]*//')
    # 이 줄을 마지막으로 건드린 커밋.
    origin=$(git log -1 --format='%h %ad' --date=short -L "$lineno,$lineno:$file" 2>/dev/null | head -1 || true)
    printf '  %-46s %s\n' "$label" "$code"
    printf '    %s:%s  <- %s\n' "$file" "$lineno" "${origin:-?}"
  done
}

live() {
  printf '\n=== 라이브 상태 ===\n'
  if ! health=$(curl -sS --max-time 20 "$HEALTH_URL" 2>/dev/null); then
    printf '  health 조회 실패\n'; return
  fi
  printf '%s' "$health" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("  health 파싱 실패"); sys.exit()
m = d.get("metrics", {})
print("  기사 24h: general {} / baduk {}".format(m.get("general_24h"), m.get("baduk_24h")))
print("  Claude: 이번달 ${:.3f} / 오늘 ${:.3f}".format(
    m.get("claude_monthly_micro_usd", 0)/1e6, m.get("claude_daily_micro_usd", 0)/1e6))
print("  헬스 실패: {}".format(d.get("failures") or "없음"))
run = m.get("last_automatic_run") or {}
try:
    diag = json.loads(run.get("message", "{}")).get("diagnostics") or {}
except Exception:
    diag = {}
# 바둑이 0일 때 예산 탓인지 서브리퀘스트 탓인지 여기서 갈린다.
hosts = diag.get("body_too_short_hosts") or {}
sub = sum(v for k, v in hosts.items() if "Too many subrequests" in k)
if sub:
    print("  ⚠ 마지막 자동 실행에서 본문 {}건이 서브리퀘스트 고갈로 실패 - 예산과 무관한 원인".format(sub))
if diag.get("retry_attempted") == 0:
    print("  ⚠ retry_attempted=0 - 재요약 경로가 멈춰 있다 (retryAttemptLimit 확인)")
for key in ("ai_budget_exhausted", "anthropic_budget_exhausted"):
    if diag.get(key):
        print("  ⚠ {} - 예산 관문이 요약을 끊었다".format(key))
by_cat = diag.get("candidate_outcomes_by_category") or {}
if by_cat:
    print("  후보 결과: {}".format(json.dumps(by_cat, ensure_ascii=False)))
'
}

case "${1:-status}" in
  status) gates; live ;;
  log)
    printf '=== functions/를 건드린 최근 커밋 ===\n'
    git log -20 --date=short --format='%C(auto)%h %ad %s' -- functions/
    printf '\n되돌리려면: scripts/rollback.sh revert <sha>\n'
    ;;
  show)
    [ $# -ge 2 ] || { printf 'sha가 필요하다\n' >&2; exit 1; }
    git show --stat "$2"
    printf '\n=== 이 커밋이 바꾼 관문 값 ===\n'
    for entry in "${GATES[@]}"; do
      IFS='|' read -r label file pattern <<<"$entry"
      hit=$(git show "$2" -- "$file" 2>/dev/null | grep -E "^[-+].*($pattern)" || true)
      [ -n "$hit" ] && printf '  %s\n%s\n' "$label" "$(printf '%s' "$hit" | sed 's/^/    /')"
    done
    ;;
  revert)
    [ $# -ge 2 ] || { printf 'sha가 필요하다\n' >&2; exit 1; }
    git diff --quiet && git diff --cached --quiet || {
      printf '작업 트리가 깨끗하지 않다. 먼저 정리할 것.\n' >&2; exit 1; }
    git revert --no-edit "$2"
    printf '\n=== 되돌린 뒤 관문 값 ===\n'
    gates
    printf '\n=== 테스트 ===\n'
    if npm test >/tmp/newsbrief-revert-test.log 2>&1; then
      grep -E 'tests [0-9]+|pass [0-9]+|fail [0-9]+' /tmp/newsbrief-revert-test.log || true
      printf '\n배포하려면: env -u GITHUB_TOKEN -u GH_TOKEN git push origin main\n'
    else
      printf '테스트 실패. 로그: /tmp/newsbrief-revert-test.log\n'
      grep -E '✖|fail [0-9]+' /tmp/newsbrief-revert-test.log | head || true
      printf '되돌리기를 취소하려면: git reset --hard HEAD~1\n'
      exit 1
    fi
    ;;
  *) sed -n '2,14p' "$0" | sed 's/^# \?//' ;;
esac
