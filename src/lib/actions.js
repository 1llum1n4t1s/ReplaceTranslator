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
    GET_STATE: "GET_STATE",                 // 設定 + 当月 usage を取得
    APPLY_SETTINGS: "APPLY_SETTINGS",       // 設定を保存
    GET_MODELS: "GET_MODELS",               // プロバイダのモデル一覧を動的取得 (新しい順10件 + 価格)
    // content → background
    TRANSLATE_BATCH: "TRANSLATE_BATCH",     // テキスト配列の翻訳を代理依頼
    TRANSLATE_IMAGE: "TRANSLATE_IMAGE",     // 画像内テキストの翻訳 (vision・オプション)
    // background → content
    APPLY_TRANSLATE_CS: "APPLY_TRANSLATE_CS", // content に翻訳開始を指示
    APPLY_RESTORE_CS: "APPLY_RESTORE_CS",     // content に復元を指示
    // content → runtime (進捗通知; popup が開いていれば受信)
    TRANSLATION_PROGRESS: "TRANSLATION_PROGRESS",
  });

  // ---- storage キー ----
  const StorageKeys = Object.freeze({
    SETTINGS: "settings",
    TOKEN_USAGE: "tokenUsage",
    FAB_POSITION: "fabPosition",   // FAB のドラッグ位置 {left, top}
    MODELS_CACHE: "modelsCache",   // 動的取得したモデル一覧 {provider: {models, fetchedAt}}
    BATCH_TUNING: "batchTuning",   // バッチサイズ自動学習の状態 {provider: {size, throughput, dir}}
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
      models: Object.freeze(["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"]),
      keyUrl: "https://aistudio.google.com/app/apikey",
    }),
    xai: Object.freeze({
      id: "xai",
      label: "xAI (Grok)",
      // xAI は OpenAI 互換 API (chat/completions・Bearer・usage 同形)
      endpoint: "https://api.x.ai/v1/chat/completions",
      defaultModel: "grok-4-1-fast-non-reasoning",
      models: Object.freeze(["grok-4-1-fast-non-reasoning", "grok-4-1-fast-reasoning", "grok-4.3"]),
      keyUrl: "https://console.x.ai/",
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
    value: Object.freeze(["openai", "anthropic", "gemini", "xai", "mymemory"]),
    enumerable: false,
  });
  Object.defineProperty(Providers, "get", {
    value: function (id) { return Providers[id] || null; },
    enumerable: false,
  });
  Object.freeze(Providers);

  const PROVIDER_IDS = Providers.ids;

  // ---- 設定スキーマ ----
  const DEFAULT_SETTINGS = Object.freeze({
    provider: "mymemory",        // キー不要で即翻訳できる MyMemory を既定に (インストール直後にすぐ使える)
    sourceLang: "auto",          // auto = 自動判定 (target 以外の言語を翻訳)
    targetLang: "ja",
    apiKeys: Object.freeze({ openai: "", anthropic: "", gemini: "", xai: "", mymemory: "" }),
    models: Object.freeze({
      openai: "gpt-5.4-mini",
      anthropic: "claude-haiku-4-5",
      gemini: "gemini-2.5-flash",
      xai: "grok-4-1-fast-non-reasoning",
      mymemory: null,
    }),
    batchSize: 30,
    useBuiltinDetector: false,   // Chrome 内蔵 LanguageDetector で target 言語を事前除外 (任意・既定 OFF)
    autoTranslate: false,        // ページを開いたら自動翻訳 (将来用フラグ)
    imageTranslate: false,       // 画像内テキストの翻訳 (オプション・vision)
  });

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
      models[id] = (typeof modelsIn[id] === "string" && modelsIn[id])
        ? modelsIn[id]
        : Providers[id].defaultModel;
    }
    let batchSize = Number(r.batchSize);
    if (!Number.isFinite(batchSize)) batchSize = DEFAULT_SETTINGS.batchSize;
    batchSize = Math.min(100, Math.max(1, Math.round(batchSize)));
    return {
      provider,
      sourceLang: (typeof r.sourceLang === "string" && r.sourceLang) ? r.sourceLang : DEFAULT_SETTINGS.sourceLang,
      targetLang: (typeof r.targetLang === "string" && r.targetLang) ? r.targetLang : DEFAULT_SETTINGS.targetLang,
      apiKeys,
      models,
      batchSize,
      useBuiltinDetector: Boolean(r.useBuiltinDetector),
      autoTranslate: Boolean(r.autoTranslate),
      imageTranslate: Boolean(r.imageTranslate),
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

  // usage 加算 (純粋関数: 入力を破壊せず新しい store を返す)
  function addUsage(store, monthKey, provider, input, output) {
    const next = (store && typeof store === "object") ? JSON.parse(JSON.stringify(store)) : {};
    if (!next[monthKey]) next[monthKey] = {};
    if (!next[monthKey][provider]) next[monthKey][provider] = { input: 0, output: 0 };
    next[monthKey][provider].input += Number(input) || 0;
    next[monthKey][provider].output += Number(output) || 0;
    return next;
  }

  // 当月のプロバイダ別 + 合計を取り出す
  function usageForMonth(store, monthKey) {
    const month = (store && store[monthKey]) ? store[monthKey] : {};
    const perProvider = {};
    let totalIn = 0;
    let totalOut = 0;
    for (const id of PROVIDER_IDS) {
      const u = month[id] || { input: 0, output: 0 };
      const input = Number(u.input) || 0;
      const output = Number(u.output) || 0;
      perProvider[id] = { input, output, total: input + output };
      totalIn += input;
      totalOut += output;
    }
    return { perProvider, total: { input: totalIn, output: totalOut, total: totalIn + totalOut } };
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
    addUsage,
    usageForMonth,
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
