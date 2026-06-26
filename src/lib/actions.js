"use strict";

/**
 * actions.js — ReplaceTranslator の共通定数・スキーマ・ヘルパー
 *
 * IIFE + globalThis 公開方式。background(SW) / content / popup / options から読まれ、
 * メッセージアクション・設定スキーマ・プロバイダ定義・トークン集計ヘルパーを共有する。
 * Node テストからは test/_load-actions.js が vm.runInThisContext で評価して globalThis から取り出す。
 * __rtActionsLoaded ガードで複数回評価されても再定義しない。
 */

(function () {
  if (globalThis.__rtActionsLoaded) return;
  globalThis.__rtActionsLoaded = true;

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
    // content → runtime (進捗通知; popup が開いていれば受信)
    TRANSLATION_PROGRESS: "TRANSLATION_PROGRESS",
  });

  // ---- storage キー ----
  const StorageKeys = Object.freeze({
    SETTINGS: "settings",
    TOKEN_USAGE: "tokenUsage",
    FAB_POSITION: "fabPosition",   // FAB(右端タブ) の縦位置比率 {ratio}。旧 {top}/{left,top} は ratio へ換算
    MODELS_CACHE: "modelsCache",   // 動的取得したモデル一覧 {provider: {models, fetchedAt}}
    BATCH_TUNING: "batchTuning",   // バッチサイズ自動学習の状態 {provider: {size, throughput, dir}}
    CONTENT_FLAGS: "contentFlags", // content script 用の非機密フラグ {autoTranslate, showFab, imageCapable} (apiKeys を含めない)
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
      models: Object.freeze(["google/gemini-2.5-flash", "openai/gpt-4.1-mini", "anthropic/claude-haiku-4.5", "deepseek/deepseek-chat"]),
      keyUrl: "https://openrouter.ai/keys",
    }),
    deepseek: Object.freeze({
      id: "deepseek",
      label: "DeepSeek",
      // DeepSeek は OpenAI 互換 (chat/completions・Bearer)。安価。deepseek-chat はテキストのみ (vision 無し)
      endpoint: "https://api.deepseek.com/v1/chat/completions",
      defaultModel: "deepseek-chat",
      models: Object.freeze(["deepseek-chat", "deepseek-reasoner"]),
      keyUrl: "https://platform.deepseek.com/api_keys",
    }),
    groq: Object.freeze({
      id: "groq",
      label: "Groq",
      // Groq は OpenAI 互換 (chat/completions・Bearer)。超高速・無料枠あり
      endpoint: "https://api.groq.com/openai/v1/chat/completions",
      defaultModel: "llama-3.3-70b-versatile",
      visionModel: "meta-llama/llama-4-scout-17b-16e-instruct",  // 画像翻訳は vision 対応の Llama 4 Scout を使う (llama-3.3 はテキストのみ)
      // moonshotai/kimi-k2-instruct は廃止のため除外。vision の llama-4-scout も選択肢に入れる。
      models: Object.freeze(["llama-3.3-70b-versatile", "openai/gpt-oss-120b", "meta-llama/llama-4-scout-17b-16e-instruct"]),
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

  // ---- 設定スキーマ ----
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
      deepseek: "deepseek-chat",
      groq: "llama-3.3-70b-versatile",
      fugu: "fugu",
      mymemory: null,
    }),
    autoTranslate: false,        // 全ページ自動翻訳 (popup トグルで ON/OFF。ON で開いたページを自動翻訳)
    showFab: true,               // ページ右下のフローティング翻訳ボタンを表示する (OFF でも popup/右クリックから翻訳可)
    selectionTranslate: true,    // 選択テキスト翻訳 (ホットキー Ctrl+Shift+L / 右クリックで選択範囲を翻訳)
    selectionMode: "bubble",     // 選択翻訳の表示方法: "bubble"=浮遊バブル / "inline"=選択ブロック直後に対訳を差し込む(累積保持)
  });

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
      autoTranslate: Boolean(r.autoTranslate),
      showFab: r.showFab !== false, // 既定 ON。既存ユーザーの保存済み設定 (キー欠損) でも FAB が消えないよう !== false で判定
      selectionTranslate: r.selectionTranslate !== false, // 既定 ON。欠損設定でも選択翻訳が消えないよう !== false で判定 (showFab と同形)
      selectionMode: r.selectionMode === "inline" ? "inline" : "bubble", // 未知値は既定の "bubble" に倒す (後方互換)
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

  // ---- globalThis 公開 ----
  globalThis.Actions = Actions;
  globalThis.StorageKeys = StorageKeys;
  globalThis.Providers = Providers;
  globalThis.SettingsSchema = SettingsSchema;
  globalThis.TokenUsage = TokenUsage;
  globalThis.BatchTuner = BatchTuner;
})();
