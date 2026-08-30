"use strict";

/**
 * actions.js — ReplaceTranslator の共通定数・スキーマ・ヘルパー
 *
 * IIFE + globalThis 公開方式。background(SW) / content / popup / options から読まれ、
 * メッセージアクション・設定スキーマ・プロバイダ定義・トークン集計ヘルパーを共有する。
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

  // actions.js が stale marker を更新して再評価されたときは、公開 helper も現行コードへ更新する。
  globalThis.TranslationBatch = Object.freeze({
    CONTEXT_MAX_CHARS: 240,
    groupExactTexts,
    groupContextualTexts,
    contextKey: translationContextKey,
    normalizeContexts: normalizeTranslationContexts,
    shouldRetry: shouldRetryTranslation,
    isOversize: isOversizeTranslation,
    cacheKey: translationCacheKey,
    normalizeCacheRecords: normalizeTranslationCacheRecords,
    attemptedTextCount,
  });

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
    TOKEN_USAGE: "tokenUsage",
    FAB_POSITION: "fabPosition",   // FAB(右端タブ) の縦位置比率 {ratio}。旧 {top}/{left,top} は ratio へ換算
    MODELS_CACHE: "modelsCache",   // 動的取得したモデル一覧 {provider: {models, fetchedAt}}
    PRICING_CACHE: "pricingCache", // models.dev から取得した動的価格 {map: {modelId: {input, output}}, fetchedAt}
    BATCH_TUNING: "batchTuning",   // バッチサイズ自動学習の状態 {provider: {size, throughput, dir}}
    CONTENT_FLAGS: "contentFlags", // content script 用の非機密フラグ {autoTranslate, showFab, imageCapable} (apiKeys を含めない)
    TRANSLATION_CACHE: "translationCacheV1", // storage.session 限定の原文完全一致キャッシュ (ブラウザ終了で消去)
    PERSISTENT_TRANSLATION_CACHE: "persistentTranslationCacheV1", // 明示 opt-in 時だけ storage.local に保存する翻訳キャッシュ
  });

  // ---- プロバイダ定義 ----
  // endpoint は background の代理 fetch が使う ({model} は Gemini で置換)。
  // models は popup / options のモデル選択用。keyUrl は API キー取得ページへの導線。
  const Providers = {
    openai: Object.freeze({
      id: "openai",
      label: "OpenAI",
      endpoint: "https://api.openai.com/v1/chat/completions",
      defaultModel: "gpt-5.4-mini",
      visionModel: "gpt-5.4-mini",  // 画像翻訳は速い軽量 vision を既定で使う (テキスト選択モデルに依らない)
      models: Object.freeze(["gpt-5.4-mini", "gpt-5.5", "gpt-4.1-mini"]),
      keyUrl: "https://platform.openai.com/api-keys",
    }),
    anthropic: Object.freeze({
      id: "anthropic",
      label: "Anthropic (Claude)",
      endpoint: "https://api.anthropic.com/v1/messages",
      defaultModel: "claude-haiku-4-5",
      visionModel: "claude-haiku-4-5",  // 画像翻訳は最速 vision (haiku) を既定で使う
      models: Object.freeze(["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-8"]),
      keyUrl: "https://console.anthropic.com/settings/keys",
    }),
    gemini: Object.freeze({
      id: "gemini",
      label: "Google Gemini",
      endpoint: "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
      defaultModel: "gemini-2.5-flash",
      visionModel: "gemini-2.5-flash",  // 画像翻訳は速い flash を既定で使う
      // gemini-2.0-flash(-lite) は 2026-06-01 に Google が廃止 (404) → 一覧から除外。
      // 既定は安価で現行の 2.5-flash (廃止 2026-10-16 予定 = 期日が来たら要 bump)。3.5-flash は高性能だが ~5x 高い選択肢。
      models: Object.freeze(["gemini-2.5-flash", "gemini-3.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite"]),
      keyUrl: "https://aistudio.google.com/app/apikey",
      // 無料枠の Gemini は RPM が低い (flash ~10 RPM)。既定 24 並列だと起動直後に 429/503 が多発し
      // リトライ枯渇で大量 skip → 未翻訳。並列を絞って無料枠でも訳し切れるようにする (有料枠は遅くなる代償)。
      maxConcurrency: 3,
    }),
    xai: Object.freeze({
      id: "xai",
      label: "xAI (Grok)",
      // xAI は OpenAI 互換 API (chat/completions・Bearer・usage 同形)
      endpoint: "https://api.x.ai/v1/chat/completions",
      // grok-4-1-fast(-non)-reasoning は 2026-05-15 に廃止 (API は grok-4.3 へリダイレクト) → 既定/一覧を現行へ。
      defaultModel: "grok-4.3",
      models: Object.freeze(["grok-4.3"]),
      keyUrl: "https://console.x.ai/",
    }),
    openrouter: Object.freeze({
      id: "openrouter",
      label: "OpenRouter",
      // OpenRouter は OpenAI 互換 (chat/completions・Bearer)。1 キーで各社モデルを横断利用できる
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      defaultModel: "google/gemini-2.5-flash",
      visionModel: "google/gemini-2.5-flash",  // 画像翻訳は bbox 精度の高い Gemini flash を OpenRouter 経由で使う
      // deepseek/deepseek-chat は退役済み。OpenRouter 側は無日付の公開版を配信しないため、
      // Anthropic と同じ扱いで日付入りスナップショットを載せる (latest エイリアスは filterTranslationModels が弾く)。
      models: Object.freeze(["google/gemini-2.5-flash", "openai/gpt-4.1-mini", "anthropic/claude-haiku-4.5", "deepseek/deepseek-v4-flash-0731"]),
      keyUrl: "https://openrouter.ai/keys",
    }),
    deepseek: Object.freeze({
      id: "deepseek",
      label: "DeepSeek",
      // DeepSeek は OpenAI 互換 (chat/completions・Bearer)。安価。テキストのみ (vision 無し)。
      // 旧エイリアス deepseek-chat / deepseek-reasoner は 2026-07-24 に退役し、公式 API は v4 系のみ。
      endpoint: "https://api.deepseek.com/v1/chat/completions",
      defaultModel: "deepseek-v4-flash",
      models: Object.freeze(["deepseek-v4-flash", "deepseek-v4-pro"]),
      keyUrl: "https://platform.deepseek.com/api_keys",
    }),
    groq: Object.freeze({
      id: "groq",
      label: "Groq",
      // Groq は OpenAI 互換 (chat/completions・Bearer)。超高速・無料枠あり
      endpoint: "https://api.groq.com/openai/v1/chat/completions",
      // developer/free tier では llama-3.3 が 2026-08-16、Llama 4 Scout が 2026-07-17 に停止済み。
      // テキストは公式移行先、画像は現行の vision 対応 Qwen を使う (enterprise の旧モデル選択は保存値として維持)。
      defaultModel: "openai/gpt-oss-120b",
      visionModel: "qwen/qwen3.6-27b",
      models: Object.freeze(["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.6-27b"]),
      keyUrl: "https://console.groq.com/keys",
    }),
    fugu: Object.freeze({
      id: "fugu",
      label: "Sakana AI (Fugu)",
      // Sakana Fugu は OpenAI 互換 (chat/completions・Bearer・/models・usage 同形)。
      // fugu = 既定ルーティングモデル (タスクに応じ最適な下位モデルへ自動振り分け)、fugu-ultra = 上位固定モデル。
      // vision は未対応 (visionModel なし → 画像翻訳「訳」ボタンは出さない)。
      endpoint: "https://api.sakana.ai/v1/chat/completions",
      defaultModel: "fugu",
      models: Object.freeze(["fugu", "fugu-ultra"]),
      keyUrl: "https://console.sakana.ai/",
    }),
    mymemory: Object.freeze({
      id: "mymemory",
      label: "MyMemory (free / no key)",
      // 無料の NMT。GET 方式・1 テキスト/リクエスト・q は最大 500 バイト・LLM ではない
      endpoint: "https://api.mymemory.translated.net/get",
      defaultModel: null,
      models: Object.freeze([]),
      keyUrl: "https://mymemory.translated.net/doc/spec.php",
      requiresKey: false,  // キー不要 (de にメールを入れると無料枠が拡大)
      batch: false,        // 1 テキスト/リクエスト
      maxBytes: 500,       // q は最大 500 バイト
    }),
  };
  // ids / get は列挙不可で持たせる (Object.keys(Providers) にプロバイダ ID だけが並ぶようにする)
  Object.defineProperty(Providers, "ids", {
    value: Object.freeze(["openai", "anthropic", "gemini", "xai", "openrouter", "deepseek", "groq", "fugu", "mymemory"]),
    enumerable: false,
  });
  Object.defineProperty(Providers, "get", {
    value: function (id) { return Providers[id] || null; },
    enumerable: false,
  });
  // 画像翻訳(vision)対応プロバイダか。visionModel を持つ社のみ true (openai/anthropic/gemini/openrouter/groq)。
  // xai/deepseek(text のみ)/mymemory(NMT) は false。content のボタン出し分けと SW の no_vision 判定で共有する。
  Object.defineProperty(Providers, "supportsImage", {
    value: function (id) { const p = Providers[id]; return Boolean(p && p.visionModel); },
    enumerable: false,
  });
  Object.freeze(Providers);

  const PROVIDER_IDS = Providers.ids;

  // モデル別 reasoning effort の保存値。API へ送れる値だけを通し、popup から未知値や巨大な辞書を
  // SETTINGS に持ち込ませない。Gemini 2.5 は named effort ではなく thinkingBudget なので、
  // UI の明示プリセットだけ budget:<tokens> として保存する。
  const REASONING_EFFORT_VALUES = Object.freeze(new Set([
    "none", "minimal", "low", "medium", "high", "xhigh", "max", "default",
    "budget:1024", "budget:4096", "budget:8192",
  ]));
  const REASONING_EFFORT_MAX_MODELS = 50;
  const REASONING_EFFORT_MAX_MODEL_CHARS = 300;

  function normalizeReasoningEfforts(value) {
    const source = value && typeof value === "object" ? value : {};
    const result = {};
    for (const providerId of PROVIDER_IDS) {
      const providerSource = source[providerId] && typeof source[providerId] === "object"
        ? source[providerId]
        : {};
      const providerResult = {};
      let count = 0;
      for (const [model, effort] of Object.entries(providerSource)) {
        if (count >= REASONING_EFFORT_MAX_MODELS) break;
        if (!model || model.length > REASONING_EFFORT_MAX_MODEL_CHARS ||
            model === "__proto__" || model === "constructor" || model === "prototype") continue;
        if (!REASONING_EFFORT_VALUES.has(effort)) continue;
        providerResult[model] = effort;
        count++;
      }
      result[providerId] = providerResult;
    }
    return result;
  }

  // ---- 自動翻訳ブラックリスト ----
  // popup の複数行入力・SW の自動翻訳 gate・右クリック切替で同じ判定を共有する。
  const AUTO_BLACKLIST_MAX_ENTRIES = 500;
  const AUTO_BLACKLIST_MAX_PATTERN_CHARS = 1000;

  function normalizeAutoTranslateBlacklist(value) {
    const source = Array.isArray(value) ? value : (typeof value === "string" ? [value] : []);
    const result = [];
    const seen = new Set();
    for (const item of source) {
      if (typeof item !== "string") continue;
      for (const raw of item.split(/\r?\n/)) {
        const pattern = raw.trim();
        if (!pattern || pattern.length > AUTO_BLACKLIST_MAX_PATTERN_CHARS || seen.has(pattern)) continue;
        seen.add(pattern);
        result.push(pattern);
        if (result.length >= AUTO_BLACKLIST_MAX_ENTRIES) return result;
      }
    }
    return result;
  }

  function globMatches(value, pattern, prefix) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    try { return new RegExp(`^${escaped}${prefix ? "" : "$"}`, "i").test(value); } catch (_e) { return false; }
  }

  function autoBlacklistPatternMatches(url, pattern) {
    if (pattern.includes("://")) {
      if (pattern.includes("*")) return globMatches(url.href, pattern, false);
      try {
        const ruleUrl = new URL(pattern);
        if (ruleUrl.origin !== url.origin) return false;
        const rulePath = ruleUrl.pathname + ruleUrl.search + ruleUrl.hash;
        const actualPath = url.pathname + url.search + url.hash;
        return actualPath.startsWith(rulePath);
      } catch (_e) { return false; }
    }

    const slash = pattern.indexOf("/");
    const hostPattern = slash >= 0 ? pattern.slice(0, slash) : pattern;
    const pathPattern = slash >= 0 ? pattern.slice(slash) : "";
    if (!hostPattern || !globMatches(url.hostname, hostPattern, false)) return false;
    if (!pathPattern) return true;
    const actualPath = url.pathname + url.search + url.hash;
    return globMatches(actualPath, pathPattern, !pathPattern.includes("*"));
  }

  function matchingAutoTranslatePatterns(urlValue, value) {
    let url;
    try { url = new URL(urlValue); } catch (_e) { return []; }
    return normalizeAutoTranslateBlacklist(value).filter((pattern) => autoBlacklistPatternMatches(url, pattern));
  }

  function autoTranslateBlacklistMatches(urlValue, value) {
    return matchingAutoTranslatePatterns(urlValue, value).length > 0;
  }

  function autoTranslateSitePattern(urlValue) {
    try {
      const url = new URL(urlValue);
      return (url.protocol === "http:" || url.protocol === "https:") && url.hostname ? url.hostname.toLowerCase() : null;
    } catch (_e) { return null; }
  }

  function toggleAutoTranslateSite(urlValue, value) {
    const patterns = normalizeAutoTranslateBlacklist(value);
    const matching = matchingAutoTranslatePatterns(urlValue, patterns);
    if (matching.length) {
      const remove = new Set(matching);
      return { patterns: patterns.filter((pattern) => !remove.has(pattern)), excluded: false };
    }
    const site = autoTranslateSitePattern(urlValue);
    if (!site) return { patterns, excluded: false };
    return { patterns: patterns.concat(site), excluded: true };
  }

  const AutoTranslateBlacklist = Object.freeze({
    normalize: normalizeAutoTranslateBlacklist,
    matches: autoTranslateBlacklistMatches,
    matchingPatterns: matchingAutoTranslatePatterns,
    sitePattern: autoTranslateSitePattern,
    toggleSite: toggleAutoTranslateSite,
  });

  // ---- 設定スキーマ ----
  const EMPTY_REASONING_EFFORTS = Object.freeze(Object.fromEntries(
    PROVIDER_IDS.map((id) => [id, Object.freeze({})])
  ));
  const DEFAULT_SETTINGS = Object.freeze({
    provider: "mymemory",        // キー不要で即翻訳できる MyMemory を既定に (インストール直後にすぐ使える)
    sourceLang: "auto",          // auto = ページの主要言語を検出して翻訳元にする (検出不能時は target 以外を翻訳)
    targetLang: "ja",
    apiKeys: Object.freeze({ openai: "", anthropic: "", gemini: "", xai: "", openrouter: "", deepseek: "", groq: "", fugu: "", mymemory: "" }),
    models: Object.freeze({
      openai: "gpt-5.4-mini",
      anthropic: "claude-haiku-4-5",
      gemini: "gemini-2.5-flash",
      xai: "grok-4.3",
      openrouter: "google/gemini-2.5-flash",
      deepseek: "deepseek-v4-flash",
      groq: "openai/gpt-oss-120b",
      fugu: "fugu",
      mymemory: null,
    }),
    reasoningEfforts: EMPTY_REASONING_EFFORTS, // provider → model ID → 明示 effort。欠損は翻訳向け自動最小値
    autoTranslate: false,        // 全ページ自動翻訳 (popup トグルで ON/OFF。ON で開いたページを自動翻訳)
    autoTranslateBlacklist: Object.freeze([]), // 自動翻訳だけを抑止する URL/host glob の複数行リスト
    persistentTranslationCache: false, // 原文/訳文の storage.local 永続キャッシュ (既定 OFF。明示 opt-in のみ)
    showFab: false,              // ページ右下のフローティング翻訳ボタン (既定 OFF。popup/右クリックから翻訳できるため希望者だけ ON)
    showImageButton: false,      // 画像ホバー時の「訳」ボタン (既定 OFF。希望者だけ ON)
    // 選択テキスト翻訳 (ホットキー Ctrl+Shift+L / 右クリック) は常時有効。ON/OFF フラグは持たない
    // (明示操作でしか起きないため無効化の必要が無く、UI に出ない false が残ると無反応の原因になる)。
    selectionMode: "bubble",     // 選択翻訳の表示方法: "bubble"=浮遊バブル / "inline"=選択ブロック直後に対訳を差し込む(累積保持)
    fabOpacity: 1,               // フローティングボタンの不透明度 (乗数)。1=既定の見た目、下げるほど透ける (fab.css の --rest に掛ける)
  });

  // フローティングボタンの不透明度 (乗数) の許容範囲。0=完全透明で操作不能になるのを防ぐため下限 0.2、上限 1.0 に丸める。
  const FAB_OPACITY_MIN = 0.2;
  const FAB_OPACITY_MAX = 1;
  function clampFabOpacity(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return DEFAULT_SETTINGS.fabOpacity; // 未設定 / 非数値は既定 (1) に倒す
    return Math.min(FAB_OPACITY_MAX, Math.max(FAB_OPACITY_MIN, n));
  }

  // 各社が廃止したモデル ID。保存設定 (settings.models[*]) に残っていると翻訳時に 404 で詰むため、
  // normalize 時に既定モデルへ自動移行する (動的取得 GET_MODELS を待たずに復旧する)。廃止が出たらここに足す。
  const RETIRED_MODELS = Object.freeze(new Set([
    // Google Gemini (2.0 系は 2026-06-01 廃止)
    "gemini-2.0-flash", "gemini-2.0-flash-001", "gemini-2.0-flash-lite", "gemini-2.0-flash-lite-001",
    "gemini-1.5-flash", "gemini-1.5-flash-8b", "gemini-1.5-pro",
    // xAI Grok (2026-05-15 廃止)
    "grok-4-1-fast-non-reasoning", "grok-4-1-fast-reasoning",
    // Groq (kimi-k2 廃止)
    "moonshotai/kimi-k2-instruct", "moonshotai/kimi-k2-instruct-0905",
    // DeepSeek (旧エイリアスは 2026-07-24 廃止 → v4 系へ移行。OpenRouter 側の同名 ID も同時に消滅)
    "deepseek-chat", "deepseek-reasoner", "deepseek/deepseek-chat", "deepseek/deepseek-reasoner",
    // Anthropic (旧世代スナップショット ID。日付付きを保存していた稀ケース向けの防御)
    "claude-3-7-sonnet-20250219", "claude-3-5-sonnet-20241022", "claude-3-5-sonnet-20240620",
    "claude-3-5-haiku-20241022", "claude-3-opus-20240229", "claude-3-sonnet-20240229",
    "claude-3-haiku-20240307", "claude-2.0", "claude-2.1",
  ]));

  /**
   * 任意の入力を完全な設定オブジェクトに正規化する純粋関数。
   * 未知キーは捨て、欠損キーはデフォルトで埋める (前方/後方互換 + APPLY_SETTINGS の partial payload 防御)。
   */
  function normalizeSettings(raw) {
    const r = (raw && typeof raw === "object") ? raw : {};
    const provider = PROVIDER_IDS.includes(r.provider) ? r.provider : DEFAULT_SETTINGS.provider;
    const apiKeysIn = (r.apiKeys && typeof r.apiKeys === "object") ? r.apiKeys : {};
    const modelsIn = (r.models && typeof r.models === "object") ? r.models : {};
    const apiKeys = {};
    const models = {};
    for (const id of PROVIDER_IDS) {
      apiKeys[id] = typeof apiKeysIn[id] === "string" ? apiKeysIn[id] : "";
      const saved = (typeof modelsIn[id] === "string" && modelsIn[id]) ? modelsIn[id] : null;
      // 廃止モデルが保存されていたら既定へ移行する (古い保存値で 404 のまま詰むのを防ぐ)。
      // 既定モデル自体が廃止済みのとき (廃止期日が来て RETIRED へ足したが defaultModel の更新を忘れた等) は、
      // 廃止モデルを書き戻して実行時 404 自己修復と往復し続けないよう null (未選択 → live 取得で解決) に倒す。
      const def = Providers[id].defaultModel;
      const fallbackModel = (def && RETIRED_MODELS.has(def)) ? null : def;
      models[id] = (saved && !RETIRED_MODELS.has(saved)) ? saved : fallbackModel;
    }
    return {
      provider,
      sourceLang: (typeof r.sourceLang === "string" && r.sourceLang) ? r.sourceLang : DEFAULT_SETTINGS.sourceLang,
      targetLang: (typeof r.targetLang === "string" && r.targetLang) ? r.targetLang : DEFAULT_SETTINGS.targetLang,
      apiKeys,
      models,
      reasoningEfforts: normalizeReasoningEfforts(r.reasoningEfforts),
      autoTranslate: Boolean(r.autoTranslate),
      autoTranslateBlacklist: normalizeAutoTranslateBlacklist(r.autoTranslateBlacklist),
      persistentTranslationCache: r.persistentTranslationCache === true, // 原文を永続保存するため厳密な明示 true だけ有効
      showFab: r.showFab === true, // 既定 OFF。明示的に ON にした保存値だけ有効 (キー欠損 = 既定の OFF に倒す)
      showImageButton: r.showImageButton === true, // 既定 OFF。明示的に ON にした保存値だけ有効 (showFab と同形)
      selectionMode: r.selectionMode === "inline" ? "inline" : "bubble", // 未知値は既定の "bubble" に倒す (後方互換)
      fabOpacity: clampFabOpacity(r.fabOpacity), // 0.2〜1.0 に丸める (欠損設定でも既定 1 に倒す)
    };
  }

  const SettingsSchema = Object.freeze({
    DEFAULTS: DEFAULT_SETTINGS,
    normalize: normalizeSettings,
  });

  // ---- トークン使用量ヘルパー ----
  // tokenUsage の形: { "YYYY-MM": { openai:{input,output}, anthropic:{...}, gemini:{...} } }

  // 月キー生成 (テスト容易化のため Date を引数で受ける。省略時は現在)
  function currentMonthKey(date) {
    const d = date || new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    return `${y}-${m}`;
  }

  // 古い月キーを間引く (最新 keepMonths 件だけ残す。"YYYY-MM" は辞書順 = 時系列順)
  function pruneUsage(store, keepMonths) {
    if (!store || typeof store !== "object") return {};
    const keys = Object.keys(store).sort();
    const keep = keys.slice(Math.max(0, keys.length - (keepMonths || 12)));
    const next = {};
    for (const k of keep) next[k] = store[k];
    return next;
  }

  const TokenUsage = Object.freeze({
    currentMonthKey,
    pruneUsage,
  });


  // ---- バッチサイズ自動学習 ----
  // 各バッチの「テキスト数 / 所要時間」(スループット) が最大化するサイズを hill-climbing で探索する。
  // ユーザーが最適値を考えなくて済むよう、翻訳しながら内部で size を調整する。
  const BatchTuner = Object.freeze({
    DEFAULT: 50,   // 初期サイズ。往復回数を減らすため大きめから始める(旧 25 は小さすぎて往復過多だった)
    MIN: 5,
    MAX: 100,
    STEP: 25,      // 1 ステップの増減幅。MAX まで素早く育つよう大きめ(旧 12)
    initialState() { return { size: this.DEFAULT, throughput: 0, dir: 1 }; },
    // sample: { textCount, durationMs, rateLimited } → 次の state
    next(state, sample) {
      const s = (state && typeof state === "object") ? state : this.initialState();
      const sz = Number(s.size) || this.DEFAULT;
      if (sample && sample.rateLimited) {
        // レート制限を踏んだらサイズを半減して回避。dir は +1 に戻し、クールダウン後また登れるようにする
        return { size: Math.max(this.MIN, Math.round(sz / 2)), throughput: 0, dir: 1 };
      }
      const dur = sample ? Number(sample.durationMs) : 0;
      const cnt = sample ? Number(sample.textCount) : 0;
      const tp = dur > 0 ? (cnt / (dur / 1000)) : 0; // texts/sec
      let dir = Number(s.dir) || 1;
      const prev = Number(s.throughput) || 0;
      if (prev > 0 && tp < prev * 0.9) dir = -dir; // ネットワークジッタでの誤反転を抑えるため閾値を緩める(旧 0.98)
      let size = sz + dir * this.STEP;
      size = Math.min(this.MAX, Math.max(this.MIN, size));
      return { size, throughput: tp, dir };
    },
    sizeOf(state) {
      const sz = state && Number(state.size);
      return (sz && sz >= this.MIN && sz <= this.MAX) ? sz : this.DEFAULT;
    },
  });

  // ---- 翻訳バッチ共通ヘルパー ----
  // content と background の双方で使う「完全一致 + 文脈」判定・リトライ判定・session cache key を純粋関数へ集約する。
  // 正規化や trim は行わない。空白・大文字小文字・Unicode 表現を含め 1 文字でも変われば別テキストとして扱い、
  // 編集後の文字列へ古い訳文を当てないことを最優先にする。
  function groupExactTexts(texts) {
    return groupContextualTexts(texts, []).map(({ text, indices }) => ({ text, indices }));
  }

  function translationContextKey(text, context) {
    if (typeof text !== "string") return null;
    return JSON.stringify([text, typeof context === "string" ? context : ""]);
  }

  // content script から届く context はページ由来なので、件数を texts と揃え、1 件ごとの上限をここで強制する。
  // trim/Unicode 正規化はせず、文脈内の誤字修正も cache miss として扱う。
  function normalizeTranslationContexts(contexts, count, maxChars) {
    const total = Number.isInteger(count) && count > 0 ? count : 0;
    const requestedCap = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : 240;
    const cap = Math.min(requestedCap, 240);
    const input = Array.isArray(contexts) ? contexts : [];
    return Array.from({ length: total }, (_, index) =>
      typeof input[index] === "string" ? input[index].slice(0, cap) : ""
    );
  }

  function groupContextualTexts(texts, contexts) {
    const groups = [];
    const groupByKey = new Map();
    const normalizedContexts = normalizeTranslationContexts(contexts, texts.length, 240);
    for (let i = 0; i < texts.length; i++) {
      const text = texts[i];
      const context = normalizedContexts[i];
      const key = translationContextKey(text, context);
      const known = groupByKey.get(key);
      if (known !== undefined) {
        groups[known].indices.push(i);
      } else {
        groupByKey.set(key, groups.length);
        groups.push({ text, context, indices: [i] });
      }
    }
    return groups;
  }

  function shouldRetryTranslation(res, options) {
    if (!res || res.ok || res.ambiguous) return false;
    const opts = options || {};
    if (res.error === "network" || res.error === "runtime") return true;
    if (res.error !== "http") return false;
    if (Number(res.status) >= 500) return true;
    return Number(res.status) === 429 && !opts.isNmt && opts.quotaScope !== "day";
  }

  function isOversizeTranslation(res) {
    if (!res || res.error !== "http") return false;
    if (Number(res.status) === 413) return true;
    if (Number(res.status) !== 400) return false;
    const message = String(res.message || "").toLowerCase();
    return message.includes("context_length") || message.includes("context length") ||
      message.includes("maximum context") || message.includes("too large") ||
      message.includes("too long") || message.includes("request entity too large") ||
      message.includes("reduce the length") || message.includes("string too long");
  }

  function translationCacheKey(scope, settings, promptVersion, text, context) {
    if (typeof text !== "string") return null;
    const s = settings && typeof settings === "object" ? settings : {};
    const provider = typeof s.provider === "string" ? s.provider : "";
    const model = s.models && typeof s.models[provider] === "string" ? s.models[provider] : "";
    const reasoningEffort = s.reasoningEfforts && s.reasoningEfforts[provider] &&
      typeof s.reasoningEfforts[provider][model] === "string" ? s.reasoningEfforts[provider][model] : "";
    return JSON.stringify([
      String(scope || ""), provider, model, reasoningEffort,
      typeof s.sourceLang === "string" ? s.sourceLang : "",
      typeof s.targetLang === "string" ? s.targetLang : "",
      Number(promptVersion) || 0,
      text,
      typeof context === "string" ? context : "",
    ]);
  }

  // storage はユーザー/旧版/同期競合で壊れた値を含み得るため、cache record を純粋関数で検証する。
  // 文字列は完全一致のまま保持し、正規化・trim はしない。重複 key は保存順で後勝ち (LRU の新しい側) とする。
  function normalizeTranslationCacheRecords(stored, now, maxEntryChars, maxTtlMs) {
    const input = Array.isArray(stored) ? stored : [];
    const currentTime = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const maxChars = Number.isFinite(Number(maxEntryChars)) && Number(maxEntryChars) > 0
      ? Number(maxEntryChars)
      : Number.POSITIVE_INFINITY;
    const maxExpiry = Number.isFinite(Number(maxTtlMs)) && Number(maxTtlMs) > 0
      ? currentTime + Number(maxTtlMs)
      : Number.POSITIVE_INFINITY;
    const byKey = new Map();
    let needsRewrite = stored != null && !Array.isArray(stored);
    for (const record of input) {
      if (!Array.isArray(record) || record.length !== 3) { needsRewrite = true; continue; }
      const [key, translation, expiresAt] = record;
      const expiry = Number(expiresAt);
      const valid = typeof key === "string" && key && typeof translation === "string" && translation &&
        Number.isFinite(expiry) && expiry > currentTime && expiry <= maxExpiry &&
        key.length + translation.length <= maxChars;
      if (!valid) { needsRewrite = true; continue; }
      if (byKey.has(key)) { byKey.delete(key); needsRewrite = true; }
      byKey.set(key, [key, translation, expiry]);
    }
    if (byKey.size !== input.length) needsRewrite = true;
    return { records: Array.from(byKey.values()), needsRewrite };
  }

  function attemptedTextCount(res, total) {
    const count = res && Number(res.attemptedTextCount);
    return Number.isInteger(count) && count > 0 && count <= total ? count : total;
  }

  const TranslationBatch = globalThis.TranslationBatch;

  // runtime message の送信元を「content script」と「拡張ページ」へ分類する。
  // sender.id の自拡張照合は chrome.runtime.id が必要なため SW 側で行い、ここでは分類と対象 tab 固定だけを純粋化する。
  function isExtensionPageSender(sender, extensionBase) {
    return Boolean(sender && typeof sender.url === "string" && typeof extensionBase === "string" && extensionBase &&
      sender.url.startsWith(extensionBase));
  }
  function isContentScriptSender(sender, extensionBase) {
    return Boolean(sender && !isExtensionPageSender(sender, extensionBase) && sender.tab &&
      Number.isInteger(sender.tab.id) && sender.tab.id >= 0);
  }
  function runtimeTargetTabId(msg, sender, extensionBase) {
    // 拡張ページだけが明示 tabId を指定できる。content の msg.tabId は信用せず sender.tab.id へ固定する。
    if (isExtensionPageSender(sender, extensionBase)) {
      return msg && Number.isInteger(msg.tabId) && msg.tabId >= 0 ? msg.tabId : null;
    }
    return isContentScriptSender(sender, extensionBase) ? sender.tab.id : null;
  }
  function canInvokeRuntimeAction(action, msg, sender, extensionBase) {
    const fromExtensionPage = isExtensionPageSender(sender, extensionBase);
    const fromContent = isContentScriptSender(sender, extensionBase);
    switch (action) {
      case Actions.APPLY_SETTINGS:
      case Actions.GET_STATE:
      case Actions.GET_MODELS:
        return fromExtensionPage;
      case Actions.TRANSLATION_PROGRESS:
      case Actions.TRANSLATE_IMAGE:
        return fromContent;
      case Actions.TRANSLATE_BATCH:
        // popup のクイック翻訳だけは拡張ページから直接 1 件送る。通常ページバッチは content 限定。
        return fromContent || (fromExtensionPage && msg && msg.quick === true);
      case Actions.TRANSLATE_PAGE:
      case Actions.RESTORE_PAGE:
        return fromContent || fromExtensionPage;
      default:
        // 未知 action は既知の自拡張 context だけ switch の unknown_action 応答へ通す。
        return fromContent || fromExtensionPage;
    }
  }
  const MessagePolicy = Object.freeze({
    isExtensionPageSender,
    isContentScriptSender,
    targetTabId: runtimeTargetTabId,
    canInvoke: canInvokeRuntimeAction,
  });

  // IPv4 がループバック/プライベート/リンクローカル/CGNAT かどうか (先頭2オクテットで判定)
  function isPrivateV4(a, b) {
    return a === 0 || a === 127 || a === 10 ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19));
  }
  function hasEmbeddedPrivateV4(hostname) {
    const parts = hostname.split(/[.-]/u);
    for (let i = 0; i <= parts.length - 4; i += 1) {
      const raw = parts.slice(i, i + 4);
      if (!raw.every((part) => /^\d{1,3}$/.test(part))) continue;
      const octets = raw.map(Number);
      if (octets.every((n) => n >= 0 && n <= 255) && isPrivateV4(octets[0], octets[1])) return true;
    }
    return false;
  }
  function parseIpv6Words(hostname) {
    const halves = hostname.split("::");
    if (halves.length > 2) return null;
    const parseHalf = (half) => {
      if (!half) return [];
      const parts = half.split(":");
      if (!parts.every((part) => /^[0-9a-f]{1,4}$/i.test(part))) return null;
      return parts.map((part) => parseInt(part, 16));
    };
    const left = parseHalf(halves[0]);
    const right = parseHalf(halves[1] || "");
    if (!left || !right) return null;
    if (halves.length === 1) return left.length === 8 ? left : null;
    const missing = 8 - left.length - right.length;
    return missing >= 1 ? [...left, ...new Array(missing).fill(0), ...right] : null;
  }
  function isForbiddenIpv6Literal(hostname) {
    const words = parseIpv6Words(hostname);
    if (!words) return true;
    const first = words[0];
    if (words.every((word) => word === 0) || words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return true;
    if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0) return true;
    // RFC 8215 の 64:ff9b:1::/48 はローカル用途で、公開画像取得先として扱わない。
    if (words[0] === 0x64 && words[1] === 0xff9b && words[2] === 1) return true;

    let v4WordIndex = -1;
    if (words.slice(0, 6).every((word) => word === 0)) v4WordIndex = 6; // IPv4-compatible
    else if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) v4WordIndex = 6; // IPv4-mapped
    else if (words[0] === 0x64 && words[1] === 0xff9b && words.slice(2, 6).every((word) => word === 0)) v4WordIndex = 6; // NAT64 WKP
    else if (words[0] === 0x2002) v4WordIndex = 1; // 6to4
    if (v4WordIndex < 0) return false;
    const hi = words[v4WordIndex];
    return isPrivateV4((hi >> 8) & 0xff, hi & 0xff);
  }
  function isForbiddenImageUrl(rawUrl) {
    let u;
    try { u = new URL(rawUrl); } catch (_e) { return true; }
    if (u.protocol !== "https:" || u.username || u.password) return true;
    let h = u.hostname.toLowerCase();
    if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
    // FQDN の終端ドットは DNS 上同じホストを表すため、ポリシー判定前に除く。
    // URL parser が既に正規化する IPv4 リテラルにも同じ判定を適用できる。
    h = h.replace(/\.+$/u, "");
    if (!h || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
    // nip.io / sslip.io 型の wildcard DNS や任意ドメインに埋め込まれた private IPv4 を拒否する。
    // Chrome stable には content script/SW から最終 DNS 解決先を検査する API が無いため、文字列表現で
    // 判定できる rebinding helper をここで塞ぎ、リダイレクト先は SW 側の manual redirect ループで再検証する。
    if (hasEmbeddedPrivateV4(h)) return true;
    const privateDnsSuffixes = ["localtest.me", "lvh.me", "vcap.me", "nip.io", "sslip.io", "xip.io"];
    if (privateDnsSuffixes.some((suffix) => h === suffix || h.endsWith(`.${suffix}`))) return true;
    const looksIp = h.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(h);
    if (!looksIp && (!h.includes(".") || /\.(internal|intranet|corp|home|lan|private|test|example|invalid|localdomain)$/.test(h))) {
      return true;
    }
    if (h.includes(":") && isForbiddenIpv6Literal(h)) return true;
    const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    return Boolean(m && isPrivateV4(+m[1], +m[2]));
  }
  // decoderへ渡す前に拒否する画像画素数上限。byte数だけでは高圧縮pixel bombを防げない。
  const MAX_IMAGE_PIXELS = 25000000;
  const RuntimeLimits = Object.freeze({ MAX_IMAGE_PIXELS });

  // 本拡張が画像入力として扱う PNG/JPEG/GIF/WebP だけをマジックバイトで確定する。
  // SVG や寸法パーサを持たない形式は、展開後サイズを検証できないまま decoder/API へ渡さない。
  function sniffSupportedImageMime(bytes) {
    if (!bytes || bytes.length < 4) return null;
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
        bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 &&
        bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return "image/gif";
    if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
    return null;
  }

  function readSupportedImageDimensions(bytes, mime) {
    if (!bytes || bytes.length < 10) return null;
    if (mime === "image/png" && bytes.length >= 24 && bytes[8] === 0x00 && bytes[9] === 0x00 &&
        bytes[10] === 0x00 && bytes[11] === 0x0d && bytes[12] === 0x49 && bytes[13] === 0x48 &&
        bytes[14] === 0x44 && bytes[15] === 0x52) {
      const u32 = (i) => (((bytes[i] * 0x100 + bytes[i + 1]) * 0x100 + bytes[i + 2]) * 0x100 + bytes[i + 3]);
      return { width: u32(16), height: u32(20) };
    }
    if (mime === "image/gif") {
      return { width: bytes[6] | (bytes[7] << 8), height: bytes[8] | (bytes[9] << 8) };
    }
    if (mime === "image/webp" && bytes.length >= 16) {
      const type = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
      if (type === "VP8X" && bytes.length >= 30) {
        return {
          width: 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16),
          height: 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16),
        };
      }
      if (type === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
        return { width: (bytes[26] | (bytes[27] << 8)) & 0x3fff, height: (bytes[28] | (bytes[29] << 8)) & 0x3fff };
      }
      if (type === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
        const b = (bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24)) >>> 0;
        return { width: (b & 0x3fff) + 1, height: ((b >>> 14) & 0x3fff) + 1 };
      }
      return null;
    }
    if (mime === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8) {
      let i = 2;
      while (i + 1 < bytes.length) {
        if (bytes[i] !== 0xff) { i += 1; continue; }
        while (i < bytes.length && bytes[i] === 0xff) i += 1;
        if (i >= bytes.length) break;
        const marker = bytes[i++];
        if (marker === 0x00 || marker === 0xd8 || marker === 0xd9 || marker === 0x01 ||
            (marker >= 0xd0 && marker <= 0xd7)) continue;
        if (i + 1 >= bytes.length) break;
        const size = (bytes[i] << 8) | bytes[i + 1];
        if (size < 2 || i + size > bytes.length) break;
        const isSof = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
        if (isSof && size >= 7) {
          return { height: (bytes[i + 3] << 8) | bytes[i + 4], width: (bytes[i + 5] << 8) | bytes[i + 6] };
        }
        if (marker === 0xda) break;
        i += size;
      }
    }
    return null;
  }

  function inspectImageBytes(bytes, declaredMime) {
    const declared = String(declaredMime || "").toLowerCase().split(";")[0].trim();
    const mime = sniffSupportedImageMime(bytes);
    if (!mime) return { ok: false, error: "not_image", mime: declared };
    const dims = readSupportedImageDimensions(bytes, mime);
    if (!dims || !Number.isFinite(dims.width) || !Number.isFinite(dims.height) || dims.width <= 0 || dims.height <= 0) {
      return { ok: false, error: "not_image", mime };
    }
    if (dims.width > MAX_IMAGE_PIXELS / dims.height) {
      return { ok: false, error: "image_too_large", mime, width: dims.width, height: dims.height };
    }
    return { ok: true, mime, width: dims.width, height: dims.height };
  }

  const ImageRequestPolicy = Object.freeze({
    isForbiddenUrl: isForbiddenImageUrl,
    inspectBytes: inspectImageBytes,
  });

  // ---- globalThis 公開 (ExtUtil は IIFE 冒頭・ガード前で定義済み) ----
  globalThis.Actions = Actions;
  globalThis.StorageKeys = StorageKeys;
  globalThis.Providers = Providers;
  globalThis.SettingsSchema = SettingsSchema;
  globalThis.AutoTranslateBlacklist = AutoTranslateBlacklist;
  globalThis.TokenUsage = TokenUsage;
  globalThis.BatchTuner = BatchTuner;
  globalThis.TranslationBatch = TranslationBatch;
  globalThis.MessagePolicy = MessagePolicy;
  globalThis.ImageRequestPolicy = ImageRequestPolicy;
  globalThis.RuntimeLimits = RuntimeLimits;
})();
