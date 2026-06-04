"use strict";

/**
 * stream.js — LLM ストリーミング応答から {"translations":[...]} の配列要素を逐次抽出する純粋関数。
 *
 * SSE で少しずつ届く本文断片を feed() に渡すと、確定した文字列要素を順に返す。
 * 目的は「最初の数件を全件完了前に画面へ出す」体感改善 (TTF)。
 *
 * 設計の安全弁: これは早出し用のベストエフォート抽出器であり、翻訳の真実は最終的な完全 JSON
 * (ProviderApi.extractTranslations) が担保する。本抽出器が取りこぼし/誤抽出しても、ストリーム完了後の
 * 完全パース結果で全件が確定し直されるため、致命的にならない。
 *
 * 対象形状: {"translations":["a","b",...]} (system プロンプトで固定)。コードフェンスや前置きは
 * 最初の '[' を配列開始とみなすことで読み飛ばす。文字列内の '[' / ']' は状態管理で誤検出しない。
 *
 * 他 lib 同様 IIFE + globalThis 公開 (直接 import 無し)。
 */
(function () {
  if (globalThis.__rtStreamLoaded) return;
  globalThis.__rtStreamLoaded = true;

  function unescapeChar(c) {
    switch (c) {
      case "n": return "\n";
      case "t": return "\t";
      case "r": return "\r";
      case "b": return "\b";
      case "f": return "\f";
      case "/": return "/";
      case '"': return '"';
      case "\\": return "\\";
      default: return c; // 不明なエスケープはその文字をそのまま (JSON 厳密性より頑健性を優先)
    }
  }

  /**
   * ステートフルな逐次抽出器を作る。
   *   feed(chunk: string): string[]  — そのチャンクで新たに確定した訳文要素 (0 個以上)
   *   done(): boolean                — 配列終端 ']' に達したか
   */
  function createTranslationsExtractor() {
    // phase: scan(配列開始'['待ち) | between(要素間) | str(文字列中) | esc(エスケープ) | u(\uXXXX) | done
    let phase = "scan";
    let buf = "";    // 組み立て中の文字列要素
    let uHex = "";   // \u の 16 進 4 桁

    function feed(chunk) {
      const out = [];
      const s = String(chunk == null ? "" : chunk);
      for (let i = 0; i < s.length; i++) {
        if (phase === "done") break;
        const c = s[i];
        if (phase === "scan") {
          if (c === "[") phase = "between"; // 最初の '[' = translations 配列開始 (フェンス/前置きは読み飛ばす)
          continue;
        }
        if (phase === "between") {
          if (c === '"') { phase = "str"; buf = ""; }
          else if (c === "]") phase = "done";
          // ',' や空白は無視
          continue;
        }
        if (phase === "str") {
          if (c === "\\") phase = "esc";
          else if (c === '"') { out.push(buf); buf = ""; phase = "between"; }
          else buf += c;
          continue;
        }
        if (phase === "esc") {
          if (c === "u") { phase = "u"; uHex = ""; }
          else { buf += unescapeChar(c); phase = "str"; }
          continue;
        }
        if (phase === "u") {
          uHex += c;
          if (uHex.length === 4) { buf += String.fromCharCode(parseInt(uHex, 16) || 0); phase = "str"; }
        }
      }
      return out;
    }

    function done() { return phase === "done"; }

    return { feed, done };
  }

  const StreamParse = Object.freeze({ createTranslationsExtractor });
  globalThis.StreamParse = StreamParse;
})();
