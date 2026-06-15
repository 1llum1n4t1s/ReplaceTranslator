// Firefox 用 manifest を生成する。
//
// ソース manifest.json は Chrome 純正 (background.service_worker のみ) に保つ。background.scripts を
// 入れると Chrome が "'background.scripts' requires manifest version of 2 or lower." 警告を出し続けるため。
// Firefox は background.service_worker 非対応なので、xpi/AMO ビルド時にこのスクリプトで
// background を {scripts:[...]} 形式へ変換する (service_worker キーは外す)。
//
// scripts 配列は src/service_worker.js 冒頭の importScripts(...) を単一ソースに自動生成する
// (lib 群 → 末尾に service_worker 本体)。これで Chrome(importScripts) と Firefox(scripts) の
// ロード対象が二重管理にならず、片側更新漏れを防ぐ。
//
// 使い方: node build-firefox-manifest.mjs <出力先 manifest パス>
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2];
if (!out) {
  console.error("usage: node build-firefox-manifest.mjs <output-manifest-path>");
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const swText = readFileSync(join(root, "src/service_worker.js"), "utf8");

// importScripts("/src/lib/a.js", "/src/lib/b.js", ...) から lib パスを抽出 (先頭 / は manifest 相対へ落とす)
const m = swText.match(/importScripts\(([^)]*)\)/);
const libs = m
  ? m[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "").replace(/^\//, "")).filter(Boolean)
  : [];
if (libs.length === 0) {
  console.error("importScripts() が src/service_worker.js に見つかりません");
  process.exit(1);
}

manifest.background = { scripts: [...libs, "src/service_worker.js"] };

// Firefox は chrome.offscreen 非対応のため offscreen 権限を外す。
// ローカル ONNX 推論 (MI-GAN inpaint / PaddleOCR) は offscreen document 前提なので Chrome 限定で、
// Firefox では SW の ensureOffscreen が "offscreen_unavailable" を投げ、呼び出し側が cloud/canvas にフォールバックする。
if (Array.isArray(manifest.permissions)) {
  manifest.permissions = manifest.permissions.filter((p) => p !== "offscreen");
}

writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
console.log(`Firefox manifest 生成: ${out} (background.scripts: ${manifest.background.scripts.length} 件)`);
