"use strict";

/**
 * lang.js — 言語コード ⇔ 表示名テーブル
 *
 * source(翻訳元)/target(翻訳先) の言語選択 UI と、LLM プロンプトに渡す英語名解決に使う。
 * source は "auto"(自動判定) を含む。target は auto を除いたもの (Lang.targets())。
 */

(function () {
  if (globalThis.__rtLangLoaded) return;
  globalThis.__rtLangLoaded = true;

  const LANGUAGES = [
    { code: "auto", en: "Detect language", native: "自動判定" },
    { code: "en", en: "English", native: "English" },
    { code: "ja", en: "Japanese", native: "日本語" },
    { code: "zh-Hans", en: "Chinese (Simplified)", native: "简体中文" },
    { code: "zh-Hant", en: "Chinese (Traditional)", native: "繁體中文" },
    { code: "ko", en: "Korean", native: "한국어" },
    { code: "es", en: "Spanish", native: "Español" },
    { code: "fr", en: "French", native: "Français" },
    { code: "de", en: "German", native: "Deutsch" },
    { code: "pt", en: "Portuguese", native: "Português" },
    { code: "ru", en: "Russian", native: "Русский" },
    { code: "it", en: "Italian", native: "Italiano" },
    { code: "nl", en: "Dutch", native: "Nederlands" },
    { code: "pl", en: "Polish", native: "Polski" },
    { code: "tr", en: "Turkish", native: "Türkçe" },
    { code: "ar", en: "Arabic", native: "العربية" },
    { code: "hi", en: "Hindi", native: "हिन्दी" },
    { code: "th", en: "Thai", native: "ไทย" },
    { code: "vi", en: "Vietnamese", native: "Tiếng Việt" },
    { code: "id", en: "Indonesian", native: "Bahasa Indonesia" },
    { code: "uk", en: "Ukrainian", native: "Українська" },
  ];

  const byCode = {};
  for (const l of LANGUAGES) byCode[l.code] = l;

  function get(code) {
    return byCode[code] || null;
  }

  // LLM プロンプトに渡す言語名 (英語名)。auto / 未知コードは null (= "原文の言語" 扱い)。
  function promptName(code) {
    const l = byCode[code];
    if (!l || code === "auto") return null;
    return l.en;
  }

  // target で選べる言語 (auto を除外)
  function targets() {
    return LANGUAGES.filter((l) => l.code !== "auto");
  }

  const Lang = Object.freeze({
    LANGUAGES: Object.freeze(LANGUAGES.map((l) => Object.freeze(l))),
    get,
    promptName,
    targets,
  });

  globalThis.Lang = Lang;
})();
