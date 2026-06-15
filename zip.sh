#!/bin/bash

# Replace AI Translator API 拡張機能パッケージ生成スクリプト
# 使い方:
#   ./zip.sh                 # Chrome zip + Firefox xpi 両方
#   ./zip.sh chrome          # Chrome のみ
#   ./zip.sh firefox         # Firefox のみ
#
# ソース manifest.json は Chrome 純正（background.service_worker のみ）。Chrome 版はそのまま .zip 出力。
# Firefox は service_worker 非対応のため build-firefox-manifest.mjs で background.scripts 形式へ変換して .xpi 出力する。

set -euo pipefail
cd "$(dirname "$0")"

TARGET="${1:-both}"
case "$TARGET" in
  chrome|firefox|both) ;;
  *) echo "Usage: $0 [chrome|firefox|both]"; exit 2 ;;
esac

echo "拡張機能パッケージを生成中... (Target: $TARGET)"

if ! command -v zip &> /dev/null; then
  echo "zip をインストールしてください"
  exit 1
fi

build_pkg() {
  local variant="$1"           # chrome | firefox
  local output="$2"            # replace-translator-chrome.zip | replace-translator-firefox.xpi

  echo ""
  echo "==== $variant 版をビルド中 ===="
  rm -f "$output"

  local tmp="temp-build-$variant"
  rm -rf "$tmp"
  mkdir -p "$tmp"

  if [ "$variant" = "firefox" ]; then
    # Firefox は background.service_worker 非対応 → scripts 形式へ変換 (importScripts を単一ソースに生成)
    node build-firefox-manifest.mjs "$tmp/manifest.json"
  else
    cp manifest.json "$tmp/manifest.json"  # Chrome はソース manifest (service_worker のみ) をそのまま
  fi
  cp -r icons "$tmp/"
  cp -r src "$tmp/"
  cp -r _locales "$tmp/"

  find "$tmp" \( -name "*.DS_Store" -o -name "*.swp" -o -name "*~" \) -delete

  (cd "$tmp" && zip -r "../$output" . -x "*.DS_Store" "*.swp" "*~") >/dev/null
  rm -rf "$tmp"

  if [ -f "$output" ]; then
    echo "$variant 版 作成成功: $output ($(ls -lh "$output" | awk '{print $5}'))"
  else
    echo "$variant 版 作成失敗"
    exit 1
  fi
}

if [ "$TARGET" = "chrome" ] || [ "$TARGET" = "both" ]; then
  build_pkg "chrome" "replace-translator-chrome.zip"
fi
if [ "$TARGET" = "firefox" ] || [ "$TARGET" = "both" ]; then
  build_pkg "firefox" "replace-translator-firefox.xpi"
fi

echo ""
echo "✨ パッケージング完了"
echo "   Chrome Web Store: https://chrome.google.com/webstore/devconsole"
echo "   Firefox AMO:      https://addons.mozilla.org/developers/"
