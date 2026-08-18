#!/bin/bash
# Invoice Extractor 설치 도우미
#
# 서명되지 않은 앱은 macOS 가 격리 표시를 붙여 실행을 막는다. 이 파일을 더블클릭하면
# 앱을 응용 프로그램에 넣고 그 표시를 지워 준다. 받는 사람이 터미널을 열 필요가 없다.

set -u
APP_NAME="Invoice Extractor.app"
DEST="/Applications/$APP_NAME"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo ""
echo "  Invoice Extractor 설치"
echo "  ─────────────────────────────────────────"
echo ""

# 같은 폴더나 마운트된 디스크 이미지에서 앱을 찾는다
SRC=""
for candidate in "$HERE/$APP_NAME" "/Volumes/Invoice Extractor/$APP_NAME"; do
  [ -d "$candidate" ] && SRC="$candidate" && break
done

if [ -z "$SRC" ]; then
  echo "  ❌ '$APP_NAME' 을 찾지 못했습니다."
  echo "     이 파일을 앱과 같은 폴더에 두고 다시 실행해 주세요."
  echo ""
  read -n 1 -s -r -p "  아무 키나 누르면 닫힙니다."
  exit 1
fi

echo "  찾은 앱: $SRC"

# 실행 중이면 먼저 종료
if pgrep -f "invoice-extractor" >/dev/null 2>&1; then
  echo "  실행 중인 앱을 종료합니다..."
  osascript -e 'quit app "Invoice Extractor"' >/dev/null 2>&1
  sleep 2
  pkill -f "invoice-extractor" >/dev/null 2>&1
fi

echo "  응용 프로그램 폴더로 복사하는 중..."
rm -rf "$DEST" 2>/dev/null
if ! cp -R "$SRC" /Applications/ 2>/dev/null; then
  echo "  관리자 권한이 필요합니다. 로그인 암호를 입력해 주세요."
  sudo cp -R "$SRC" /Applications/ || {
    echo "  ❌ 복사에 실패했습니다."
    read -n 1 -s -r -p "  아무 키나 누르면 닫힙니다."
    exit 1
  }
fi

echo "  보안 격리 표시를 제거하는 중..."
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null ||
  sudo xattr -dr com.apple.quarantine "$DEST" 2>/dev/null

# 복사 과정에서 서명이 깨질 수 있어 다시 입힌다
codesign --force --deep --sign - "$DEST" >/dev/null 2>&1

echo ""
echo "  ✅ 설치가 끝났습니다."
echo ""

# Claude Code 설치 여부 확인 — 없으면 앱이 동작하지 않는다
CLAUDE=""
for p in "$(command -v claude 2>/dev/null)" "$HOME/.local/bin/claude" \
         "$HOME/.claude/local/claude" "/opt/homebrew/bin/claude" "/usr/local/bin/claude"; do
  [ -n "$p" ] && [ -x "$p" ] && CLAUDE="$p" && break
done

if [ -n "$CLAUDE" ]; then
  echo "  Claude Code 확인됨: $CLAUDE"
else
  echo "  ⚠️  Claude Code 를 찾지 못했습니다."
  echo "     이 앱은 PC에 설치되어 로그인된 Claude Code 를 사용합니다."
  echo "     먼저 설치하고 로그인한 뒤 앱을 실행해 주세요."
fi

echo ""
echo "  앱을 실행합니다..."
open "$DEST"
echo ""
read -n 1 -s -r -p "  아무 키나 누르면 이 창이 닫힙니다."
echo ""
