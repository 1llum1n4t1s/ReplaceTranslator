"use strict";

/**
 * テストで実ソースを読むための共有ヘルパー。
 *
 * - functionSource: IIFE の content script / Service Worker は直接 import できないため、
 *   対象の関数宣言だけを実ソースから切り出して vm で評価する。各テストで別々に書いていた
 *   indexOf による切り出し (次の関数宣言までを取る方式) をここへ寄せ、切り出し規則を 1 つにする。
 * - workerLibScripts: src/service_worker.js 冒頭の importScripts(...) を単一ソースとして、
 *   lib の読み込み順を導出する (build-firefox-manifest.mjs と同じ考え方)。テストヘルパー側に
 *   読み込み順を手書きで二重管理すると、SW に lib を足したときにテストだけ古い順序で評価してしまう。
 */

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

const ROOT = path.join(__dirname, "..");

/**
 * source から `function name(` (async / generator を含む) の宣言を 1 つ切り出して返す。
 *
 * 文字列 ("'`) と行・ブロックコメント内の波括弧を読み飛ばし、本体の対応する `}` までを返す。
 * 制約: テンプレート文字列は「1 つの文字列」として扱うため、`${...}` の中にさらにバッククォートを
 * 入れ子にした式、および波括弧や引用符を含む正規表現リテラルは正しく扱えない。対象関数がこれらを
 * 含むようになったら、終端解決の失敗 (assert.fail) か評価時の構文エラーで検出される。
 * 宣言が見つからない・終端を解決できないときは関数名付きで失敗させ、切り出し漏れを黙って通さない。
 */
const functionSource = (source, name) => {
  const match = new RegExp(`\\b(?:async\\s+)?function\\*?\\s+${name}\\s*\\(`).exec(source);
  if (!match) assert.fail(`${name} の宣言が必要`);
  const start = match.index;
  // 引数リストの既定値などに波括弧が無い前提で、最初の "{" を本体の開始とみなす。
  const bodyStart = source.indexOf("{", start);
  if (bodyStart < 0) assert.fail(`${name} の本体を解決できない`);
  let depth = 0;
  let quote = "";
  let lineComment = false;
  let blockComment = false;
  for (let i = bodyStart; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (lineComment) { if (ch === "\n") lineComment = false; continue; }
    if (blockComment) { if (ch === "*" && next === "/") { blockComment = false; i++; } continue; }
    if (quote) {
      if (ch === "\\") { i++; continue; }
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === "/" && next === "/") { lineComment = true; i++; continue; }
    if (ch === "/" && next === "*") { blockComment = true; i++; continue; }
    if (ch === "\"" || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "{") depth++;
    if (ch === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  assert.fail(`${name} の終端を解決できない`);
};

/**
 * src/service_worker.js の importScripts("/src/lib/a.js", ...) から、リポジトリルート相対の lib パス配列を返す。
 * 抽出規則は build-firefox-manifest.mjs と同じ (先頭の "/" を落とす)。見つからない・空なら失敗させる。
 */
const workerLibScripts = () => {
  const sw = fs.readFileSync(path.join(ROOT, "src/service_worker.js"), "utf8");
  const m = sw.match(/importScripts\(([^)]*)\)/);
  if (!m) assert.fail("src/service_worker.js に importScripts(...) が見つからない");
  const libs = m[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "").replace(/^\//, "")).filter(Boolean);
  if (libs.length === 0) assert.fail("src/service_worker.js の importScripts(...) が空");
  return libs;
};

module.exports = { ROOT, functionSource, workerLibScripts };
