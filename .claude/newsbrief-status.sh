#!/usr/bin/env bash
# 세션 시작 훅. /api/news/health를 찍어 2026-08-07 기준선과 비교한 요약을 Claude
# 컨텍스트에 넣는다. 매번 "예산 어떻게 됐는지 봐줘"라고 말하지 않아도 되게 하는 게
# 목적이다. health가 안 뜨더라도 세션 시작을 막으면 안 되므로 항상 0으로 끝낸다.
set -uo pipefail
cd "$(dirname "$0")" || exit 0

body=$(curl -sS --max-time 15 "https://newsbrief-etkfkds2.pages.dev/api/news/health" 2>/dev/null || true)
if [ -z "$body" ]; then
  echo "newsbrief: health 응답 없음 (네트워크 또는 배포 문제일 수 있음)"
  exit 0
fi

printf '%s' "$body" | python3 newsbrief-status.py || echo "newsbrief: 상태 요약 실패"
exit 0
