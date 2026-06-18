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

# Chrome/Firefox 両 variant に同梱する共有ディレクトリ(単一ソース)。CI(publish.yml の job env PKG_DIRS)と揃える。
# manifest.json は variant 別(Chrome=純正 / Firefox=生成)なので含めず build_pkg 内で個別に扱う。
PKG_DIRS="icons src _locales"

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
  # 同梱ディレクトリは単一ソース (PKG_DIRS)。CI(.github/workflows/publish.yml の job env PKG_DIRS) と同じ列挙を保つ。
  for d in $PKG_DIRS; do cp -r "$d" "$tmp/"; done

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
