#!/bin/bash
# 맥 배포본을 만든다.
#
# 서명되지 않은 앱은 받는 사람이 격리 표시를 직접 지워야 열린다. 그 과정을
# 더블클릭 한 번으로 끝내주는 설치 도우미를 앱과 함께 묶는다.

set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(python3 -c "import json;print(json.load(open('src-tauri/tauri.conf.json'))['version'])")
APP="src-tauri/target/universal-apple-darwin/release/bundle/macos/Invoice Extractor.app"
OUT="release"
STAGE="$OUT/InvoiceExtractor-$VERSION-mac"

if [ ! -d "$APP" ]; then
  echo "먼저 빌드가 필요합니다:"
  echo "  npm run tauri build -- --target universal-apple-darwin --bundles app,dmg"
  exit 1
fi

rm -rf "$STAGE"
mkdir -p "$STAGE"

cp -R "$APP" "$STAGE/"
cp scripts/mac-installer.command "$STAGE/설치하기.command"
chmod +x "$STAGE/설치하기.command"
cp release/설치방법.md "$STAGE/설치방법.md" 2>/dev/null || true

cat > "$STAGE/먼저 읽어주세요.txt" <<'TXT'
Invoice Extractor 설치

  "설치하기.command" 를 더블클릭하세요.

  그것만 하면 됩니다. 앱을 응용 프로그램 폴더에 넣고,
  macOS 의 보안 차단을 풀고, 앱을 실행해 줍니다.

  ─────────────────────────────────────────────────

  "확인되지 않은 개발자" 경고로 설치하기가 열리지 않으면:

    설치하기.command 를 우클릭 -> 열기 -> 열기

  ─────────────────────────────────────────────────

  이 앱은 PC에 설치되어 로그인된 Claude Code 를 사용합니다.
  터미널에서 claude --version 이 동작해야 합니다.
TXT

# 앱 자체에 격리 표시가 남아 있으면 배포본에도 따라간다
xattr -cr "$STAGE/Invoice Extractor.app" 2>/dev/null || true

ZIP="$OUT/InvoiceExtractor-$VERSION-mac.zip"
rm -f "$ZIP"
# ditto 는 리소스 포크와 심볼릭 링크를 보존한다. zip 은 앱 번들을 깨뜨릴 수 있다.
ditto -c -k --keepParent "$STAGE" "$ZIP"
rm -rf "$STAGE"

echo "완성: $ZIP  ($(du -h "$ZIP" | cut -f1))"
echo "이 파일 하나만 보내면 됩니다."
