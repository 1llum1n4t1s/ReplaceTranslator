"use strict";

const test = require("node:test");
const assert = require("node:assert");
const g = require("./_load-actions.js");

const { Lang } = g;

// ---- normalizeCode (ページ言語検出コードの正規化) ----

test("normalizeCode strips region subtags", () => {
  assert.equal(Lang.normalizeCode("ja"), "ja");
  assert.equal(Lang.normalizeCode("ja-JP"), "ja");
  assert.equal(Lang.normalizeCode("en-US"), "en");
  assert.equal(Lang.normalizeCode("pt-BR"), "pt");
  assert.equal(Lang.normalizeCode("ko_KR"), "ko"); // アンダースコア区切りも受ける
});

test("normalizeCode is case-insensitive", () => {
  assert.equal(Lang.normalizeCode("JA"), "ja");
  assert.equal(Lang.normalizeCode("EN-us"), "en");
});

test("normalizeCode maps Chinese variants to zh-Hans / zh-Hant", () => {
  assert.equal(Lang.normalizeCode("zh"), "zh-Hans");       // CLD は簡体を "zh" で返す
  assert.equal(Lang.normalizeCode("zh-CN"), "zh-Hans");
  assert.equal(Lang.normalizeCode("zh-SG"), "zh-Hans");
  assert.equal(Lang.normalizeCode("zh-Hans"), "zh-Hans");
  assert.equal(Lang.normalizeCode("zh-TW"), "zh-Hant");
  assert.equal(Lang.normalizeCode("zh-HK"), "zh-Hant");
  assert.equal(Lang.normalizeCode("zh-MO"), "zh-Hant");
  assert.equal(Lang.normalizeCode("zh-Hant-TW"), "zh-Hant");
});

test("normalizeCode returns null for unknown / empty / non-string input", () => {
  assert.equal(Lang.normalizeCode("sv"), null);     // 表に無い言語は判定不能扱い (従来挙動へフォールバック)
  assert.equal(Lang.normalizeCode("auto"), null);   // auto は正規化結果として返さない
  assert.equal(Lang.normalizeCode(""), null);
  assert.equal(Lang.normalizeCode(null), null);
  assert.equal(Lang.normalizeCode(undefined), null);
  assert.equal(Lang.normalizeCode(42), null);
});

test("normalizeCode covers every selectable target language", () => {
  for (const l of Lang.targets()) {
    // UI で選べる言語コードはすべて自分自身へ正規化できる (ページ言語=翻訳先の比較が成立する)
    assert.equal(Lang.normalizeCode(l.code), l.code, `code: ${l.code}`);
  }
});

test("shouldSkipSameLanguage applies the mixed-language threshold only to automatic translation", () => {
  assert.equal(Lang.shouldSkipSameLanguage("ja", "ja", 49.9, 50, false), true);
  assert.equal(Lang.shouldSkipSameLanguage("ja", "ja", 50, 50, false), false);
  assert.equal(Lang.shouldSkipSameLanguage("ja", "ja", 0, 50, true), false);
  assert.equal(Lang.shouldSkipSameLanguage("en", "ja", 0, 50, false), false);
  assert.equal(Lang.shouldSkipSameLanguage(null, "ja", 0, 50, false), false);
});
