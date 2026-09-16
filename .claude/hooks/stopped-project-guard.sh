#!/usr/bin/env bash
# 이 저장소는 v0.2.3 에서 개발이 멈췄다 (README 맨 위 공지 참고).
# 그래서 실행·빌드·의존성 설치 계열 명령은 그냥 통과시키지 않고 사용자에게 한 번 묻는다.
# 지금 굳이 되살리려는 건지, 아니면 멈춘 저장소인 줄 모르고 들어온 건지
# 명령이 나가기 직전에 갈라야 나중에 헛수고를 줄일 수 있다.
set -uo pipefail

cmd=$(jq -r '.tool_input.command // ""')

# 읽기만 하는 것들(git log, ls, cat …)은 건드리지 않는다. 부수효과가 있는 것만 잡는다.
if ! printf '%s' "$cmd" | grep -qiE '(^|[;&|[:space:]])(npm|pnpm|yarn|bun|npx|vite|tauri|cargo|rustc)([[:space:]]|$)'; then
  exit 0
fi

# npm/cargo 중에도 순수 조회는 통과시킨다.
if printf '%s' "$cmd" | grep -qiE '(^|[;&|[:space:]])(npm|pnpm|yarn|bun|cargo)[[:space:]]+(ls|list|view|info|why|outdated|--version|-v|search|metadata|tree)([[:space:]]|$)'; then
  exit 0
fi

jq -n --arg cmd "$cmd" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "ask",
    permissionDecisionReason: (
      "이 저장소(invoice_extractor)는 개발이 멈춘 상태다 — 마지막은 2026-08-20 v0.2.3, 기능은 다른 곳으로 이관됐다. README.md 맨 위 중단 공지를 먼저 읽을 것.\n\n" +
      "받아서 그냥 돌리면 동작하지 않는 게 정상이다 (Claude Code CLI 로그인 · 구글시트 서비스 계정 · 고정되지 않은 의존성).\n\n" +
      "실행하려는 명령: " + $cmd + "\n\n" +
      "멈춘 걸 알고도 되살리려는 것이면 진행하고, 멈춘 저장소인 줄 모르고 들어온 것이면 여기서 멈출 것."
    )
  }
}'
