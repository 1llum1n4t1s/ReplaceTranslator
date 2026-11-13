"use strict";

/**
 * actions.js — ReplaceTranslator の常駐用の軽量共通定義
 *
 * IIFE + globalThis 公開方式。background(SW) / content / popup / options から読まれ、
 * メッセージアクション・storageキー・入力上限を共有する。翻訳と設定は translation-core.js で読む。
 * Node テストからは test/_load-actions.js が vm.runInThisContext で評価して globalThis から取り出す。
 * runtime/version-aware な __rtActionsLoaded ガードで、同一 context 内の重複評価だけを抑止する。
 */

(function () {
  // ---- 拡張共通ユーティリティ (content/popup 共有の小物・重複実装の一本化先) ----
  // 古い extension context の ExtUtil 関数を再利用すると chrome.runtime 参照も失効したままになるため、
  // actions.js の評価ごとに現行 context で作り直す。
  function runtimeStamp() {
    try {
      const runtime = chrome.runtime;
      const version = runtime && runtime.getManifest && runtime.getManifest().version;
      return { runtime, version: (typeof version === "string" && version) ? version : "unknown" };
    } catch (_e) {
      return { runtime: null, version: "unavailable" };
    }
  }

  function claimScript(marker) {
    if (typeof marker !== "string" || !marker) return false;
    const current = runtimeStamp();
    const previous = globalThis[marker];
    if (previous && typeof previous === "object" &&
        previous.runtime === current.runtime && previous.version === current.version) {
      return false;
    }
    // 旧版の boolean marker、別 extension runtime、別 manifest version は stale とみなし再初期化する。
    globalThis[marker] = Object.freeze(current);
    return true;
  }

  globalThis.ExtUtil = Object.freeze({
    // i18n 文言取得。取得失敗/未定義キーは fallback (fab/image-translator/selection-translator/popup で共有)
    tr(key, fallback) {
      try { return (chrome.i18n && chrome.i18n.getMessage(key)) || fallback; } catch (_e) { return fallback; }
    },
    // 拡張 context が生きているか (リロード/更新で置き去りになった旧 content script の検出)
    contextAlive(marker, owner) {
      try {
        if (!(chrome.runtime && chrome.runtime.id)) return false;
        return !(marker && owner) || globalThis[marker] === owner;
      } catch (_e) { return false; }
    },
    claimScript,
  });

  if (!globalThis.ExtUtil.claimScript("__rtActionsLoaded")) return;

  // ---- メッセージアクション定数 ----
  const Actions = Object.freeze({
    // popup / options → background
    TRANSLATE_PAGE: "TRANSLATE_PAGE",       // アクティブタブの翻訳を開始
    RESTORE_PAGE: "RESTORE_PAGE",           // 原文に復元
    GET_STATE: "GET_STATE",                 // 設定を取得 (usage はメモリ集計のみで UI 非表示)
    APPLY_SETTINGS: "APPLY_SETTINGS",       // 設定を保存
    GET_MODELS: "GET_MODELS",               // プロバイダのモデル一覧を動的取得 (新しい順10件 + 価格)
    // content → background
    TRANSLATE_BATCH: "TRANSLATE_BATCH",     // テキスト配列の翻訳を代理依頼
    TRANSLATE_IMAGE: "TRANSLATE_IMAGE",     // 画像内テキストの翻訳 (vision)
    LOAD_IMAGE_RENDERER: "LOAD_IMAGE_RENDERER", // content → SW: 固定rendererの注入
    PING_SELECTION_CS: "PING_SELECTION_CS", // SW → content: 選択翻訳の明示ack
    SELECTION_CSS_READY: "SELECTION_CSS_READY", // SW → content: CSS注入の完了通知
    // background → content
    APPLY_TRANSLATE_CS: "APPLY_TRANSLATE_CS", // content に翻訳開始を指示
    APPLY_RESTORE_CS: "APPLY_RESTORE_CS",     // content に復元を指示
    TRANSLATE_PARTIAL: "TRANSLATE_PARTIAL",   // ストリーミングで確定した訳文要素を逐次 content へ (早出し)
    TRANSLATE_SELECTION_CS: "TRANSLATE_SELECTION_CS", // ホットキー/右クリックで選択テキスト翻訳の起動を content に合図
    TRANSLATE_IMAGE_CS: "TRANSLATE_IMAGE_CS",         // 右クリック「画像を翻訳」の起動を content(image-translator) に合図
    // content → runtime (進捗通知; popup が開いていれば受信)
    TRANSLATION_PROGRESS: "TRANSLATION_PROGRESS",
  });

  // ---- storage キー ----
  const StorageKeys = Object.freeze({
    SETTINGS: "settings",
    SETTINGS_SYNC_STATUS: "settingsSyncStatusV2", // 同期の再送待ち・成功・失敗表示
    TOKEN_USAGE: "tokenUsage",
    FAB_POSITION: "fabPosition",   // FAB(右端タブ) の縦位置比率 {ratio}。旧 {top}/{left,top} は ratio へ換算
    MODELS_CACHE: "modelsCache",   // 動的取得したモデル一覧 {provider: {models, fetchedAt}}
    PRICING_CACHE: "pricingCache", // models.dev から取得した動的価格 {map: {modelId: {input, output}}, fetchedAt}
    BATCH_TUNING: "batchTuning",   // バッチサイズ自動学習の状態 {provider: {size, throughput, dir}}
    CONTENT_FLAGS: "contentFlags", // content script 用の非機密フラグ {autoTranslate, showFab, imageCapable} (apiKeys を含めない)
    TRANSLATION_CACHE: "translationCacheV1", // storage.session 限定の原文完全一致キャッシュ (ブラウザ終了で消去)
    PERSISTENT_TRANSLATION_CACHE: "persistentTranslationCacheV1", // 明示 opt-in 時だけ storage.local に保存する翻訳キャッシュ
  });

  const MAX_IMAGE_PIXELS = 25000000;
  const RuntimeLimits = Object.freeze({ MAX_IMAGE_PIXELS });
  globalThis.Actions = Actions;
  globalThis.StorageKeys = StorageKeys;
  globalThis.RuntimeLimits = RuntimeLimits;
})();
