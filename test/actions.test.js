"use strict";

const test = require("node:test");
const assert = require("node:assert");
const g = require("./_load-actions.js");

const {
  SettingsSchema, TokenUsage, Providers, BatchTuner, TranslationBatch, ModelPricing, RuntimeLimits,
  MessagePolicy, ImageRequestPolicy, ExtUtil,
} = g;

// ---- SettingsSchema.normalize ----

test("normalize fills defaults and drops unknown keys", () => {
  const s = SettingsSchema.normalize({ provider: "openai", bogus: 1 });
  assert.equal(s.provider, "openai");
  assert.equal(s.sourceLang, "auto");
  assert.equal(s.targetLang, "ja");
  assert.equal(typeof s.apiKeys.openai, "string");
  assert.equal(s.models.openai, "gpt-5.4-mini");
  assert.ok(!("bogus" in s));
});

test("normalize falls back to default provider on invalid value", () => {
  // 既定 provider は DEFAULTS を参照 (具体値はハードコードしない)
  assert.equal(SettingsSchema.normalize({ provider: "nope" }).provider, SettingsSchema.DEFAULTS.provider);
  assert.equal(SettingsSchema.normalize(null).provider, SettingsSchema.DEFAULTS.provider);
});

test("normalize preserves provided apiKeys/models and fills the rest", () => {
  const s = SettingsSchema.normalize({
    apiKeys: { openai: "sk-x" },
    models: { gemini: "gemini-2.5-flash" },
  });
  assert.equal(s.apiKeys.openai, "sk-x");
  assert.equal(s.apiKeys.anthropic, "");
  assert.equal(s.models.gemini, "gemini-2.5-flash");
  assert.equal(s.models.openai, "gpt-5.4-mini"); // default
});

test("normalize migrates retired models to the provider default (404 復旧)", () => {
  // Google が 2026-06-01 に廃止した gemini-2.0-flash が保存設定に残っていると 404 で詰む → 既定へ移行
  const s = SettingsSchema.normalize({ models: { gemini: "gemini-2.0-flash" } });
  assert.equal(s.models.gemini, Providers.get("gemini").defaultModel);
  assert.notEqual(s.models.gemini, "gemini-2.0-flash");
  // 現行モデルはそのまま保持する
  assert.equal(SettingsSchema.normalize({ models: { gemini: "gemini-3.5-flash" } }).models.gemini, "gemini-3.5-flash");
});

test("provider default/vision models are never themselves retired (期日到来時の足し忘れ検出)", () => {
  // defaultModel/visionModel が RETIRED 入りだと normalize が廃止モデルを書き戻し、実行時 404 自己修復と
  // 往復し続ける。「そのモデルを保存値として normalize したら同値が残る (= RETIRED でない)」を不変条件として
  // CI で守る。廃止期日 (例: gemini-2.5-flash 2026-10-16) で RETIRED に足したら defaultModel/visionModel も
  // 現行へ更新せよ、を強制する (足し忘れるとこのテストが赤くなる)。
  for (const id of Providers.ids) {
    const p = Providers.get(id);
    for (const m of [p.defaultModel, p.visionModel]) {
      if (!m) continue; // mymemory 等 (default/vision なし) はスキップ
      assert.equal(
        SettingsSchema.normalize({ models: { [id]: m } }).models[id], m,
        `${id} のモデル "${m}" が RETIRED 扱い。RETIRED_MODELS に足したなら defaultModel/visionModel も現行へ更新せよ`,
      );
    }
  }
});

test("normalize coerces boolean flags", () => {
  const s = SettingsSchema.normalize({ autoTranslate: "yes" });
  assert.equal(s.autoTranslate, true);
  assert.equal(SettingsSchema.normalize({ autoTranslate: 0 }).autoTranslate, false);
});

test("normalize defaults showFab to false when missing (FAB is opt-in)", () => {
  assert.equal(SettingsSchema.normalize({}).showFab, false);         // 既定 OFF (キー欠損 = OFF に倒す)
  assert.equal(SettingsSchema.normalize({ showFab: false }).showFab, false);
  assert.equal(SettingsSchema.normalize({ showFab: true }).showFab, true);
  assert.equal(SettingsSchema.normalize({ showFab: "x" }).showFab, false); // 厳密に true のときだけ有効
});

test("normalize defaults showImageButton to false when missing (image button is opt-in)", () => {
  assert.equal(SettingsSchema.normalize({}).showImageButton, false);         // 既定 OFF (キー欠損 = OFF に倒す)
  assert.equal(SettingsSchema.normalize({ showImageButton: false }).showImageButton, false);
  assert.equal(SettingsSchema.normalize({ showImageButton: true }).showImageButton, true);
  assert.equal(SettingsSchema.normalize({ showImageButton: "x" }).showImageButton, false); // 厳密に true のときだけ有効 (showFab と同形)
});

test("normalize drops the retired selectionTranslate flag (selection translate is always enabled)", () => {
  // 選択翻訳は明示操作でしか起きないので ON/OFF を持たない。旧インストールに残った false も
  // 未知キーとして捨て、UI に出ない設定で無反応になるのを防ぐ。
  assert.ok(!("selectionTranslate" in SettingsSchema.normalize({})));
  assert.ok(!("selectionTranslate" in SettingsSchema.normalize({ selectionTranslate: false })));
});

test("normalize clamps fabOpacity to [0.2, 1] and defaults to 1 when missing/invalid", () => {
  assert.equal(SettingsSchema.normalize({}).fabOpacity, 1);              // 欠損設定は既定 1 (現状の見た目)
  assert.equal(SettingsSchema.normalize({ fabOpacity: 0.5 }).fabOpacity, 0.5);
  assert.equal(SettingsSchema.normalize({ fabOpacity: 0 }).fabOpacity, 0.2);   // 下限クランプ (完全透明で操作不能を防ぐ)
  assert.equal(SettingsSchema.normalize({ fabOpacity: 2 }).fabOpacity, 1);     // 上限クランプ
  assert.equal(SettingsSchema.normalize({ fabOpacity: "x" }).fabOpacity, 1);   // 非数値は既定 1
});

test("Actions exposes the selection-translate trigger", () => {
  assert.equal(g.Actions.TRANSLATE_SELECTION_CS, "TRANSLATE_SELECTION_CS");
});

test("Actions exposes the image-translate trigger", () => {
  assert.equal(g.Actions.TRANSLATE_IMAGE_CS, "TRANSLATE_IMAGE_CS");
});

test("RuntimeLimits exposes a finite image pixel guard", () => {
  assert.equal(RuntimeLimits.MAX_IMAGE_PIXELS, 25000000);
});

// ---- TokenUsage ----

test("currentMonthKey formats YYYY-MM", () => {
  assert.equal(TokenUsage.currentMonthKey(new Date(2026, 5, 3)), "2026-06");
  assert.equal(TokenUsage.currentMonthKey(new Date(2026, 0, 1)), "2026-01");
  assert.equal(TokenUsage.currentMonthKey(new Date(2026, 11, 31)), "2026-12");
});

test("pruneUsage keeps only the latest N months", () => {
  const store = { "2026-01": {}, "2026-02": {}, "2026-03": {} };
  const r = TokenUsage.pruneUsage(store, 2);
  assert.deepEqual(Object.keys(r).sort(), ["2026-02", "2026-03"]);
});

// ---- Providers ----

test("Providers expose ids and get()", () => {
  assert.deepEqual(Providers.ids, ["openai", "anthropic", "gemini", "xai", "openrouter", "deepseek", "groq", "fugu", "mymemory"]);
  assert.equal(Providers.get("openai").label, "OpenAI");
  assert.equal(Providers.get("gemini").defaultModel, "gemini-2.5-flash");
  assert.equal(Providers.get("nope"), null);
});

test("Providers.supportsImage reflects visionModel presence (画像翻訳ボタンの出し分け根拠)", () => {
  // visionModel を持つ社のみ画像翻訳対応 (content の「訳」ボタン表示 + SW の no_vision 判定で共有)。
  for (const id of ["openai", "anthropic", "gemini", "openrouter", "groq"]) {
    assert.equal(Providers.supportsImage(id), true, `${id} は vision 対応のはず`);
  }
  for (const id of ["xai", "deepseek", "fugu", "mymemory"]) {
    assert.equal(Providers.supportsImage(id), false, `${id} は vision 非対応のはず`);
  }
  assert.equal(Providers.supportsImage("nope"), false); // 未知 ID は false
  // visionModel を持つ社は必ず supportsImage=true (定義の取りこぼし防止)
  for (const id of Providers.ids) {
    assert.equal(Providers.supportsImage(id), Boolean(Providers.get(id).visionModel));
  }
});

// ---- BatchTuner (バッチサイズ自動学習) ----

test("BatchTuner.next grows size when throughput improves", () => {
  // tp = 30/1s = 30 > prev 10 → 改善、方向維持で +STEP
  const s = BatchTuner.next({ size: 25, throughput: 10, dir: 1 }, { textCount: 30, durationMs: 1000, rateLimited: false });
  assert.equal(s.dir, 1);
  assert.equal(s.size, 25 + BatchTuner.STEP);
});

test("BatchTuner.next reverses direction when throughput worsens", () => {
  // tp = 10 < prev 30 → 探索方向を反転
  const s = BatchTuner.next({ size: 50, throughput: 30, dir: 1 }, { textCount: 10, durationMs: 1000, rateLimited: false });
  assert.equal(s.dir, -1);
  assert.equal(s.size, 50 - BatchTuner.STEP);
});

test("BatchTuner.next halves size on rate limit", () => {
  const s = BatchTuner.next({ size: 60, throughput: 20, dir: 1 }, { rateLimited: true });
  assert.equal(s.size, 30);
  assert.equal(s.dir, 1); // クールダウン後また登れるよう +1 に戻す
});

test("BatchTuner.next clamps to [MIN, MAX]", () => {
  const hi = BatchTuner.next({ size: 95, throughput: 5, dir: 1 }, { textCount: 100, durationMs: 100, rateLimited: false });
  assert.ok(hi.size <= BatchTuner.MAX);
  const lo = BatchTuner.next({ size: 8, throughput: 50, dir: -1 }, { textCount: 1, durationMs: 1000, rateLimited: false });
  assert.ok(lo.size >= BatchTuner.MIN);
});

test("BatchTuner.sizeOf falls back to DEFAULT for invalid state", () => {
  assert.equal(BatchTuner.sizeOf(null), BatchTuner.DEFAULT);
  assert.equal(BatchTuner.sizeOf({ size: 999 }), BatchTuner.DEFAULT);
  assert.equal(BatchTuner.sizeOf({ size: 30 }), 30);
});

test("Groq uses separate current text and vision models", () => {
  const groq = Providers.get("groq");
  assert.equal(groq.defaultModel, "openai/gpt-oss-120b");
  assert.equal(SettingsSchema.DEFAULTS.models.groq, groq.defaultModel);
  assert.equal(groq.visionModel, "qwen/qwen3.6-27b");
  assert.notEqual(groq.defaultModel, groq.visionModel);
});

test("ExtUtil.claimScript upgrades stale guards and stays idempotent in one runtime", () => {
  const marker = "__rtTestScriptLoaded";
  const originalChrome = globalThis.chrome;
  const originalMarker = globalThis[marker];
  try {
    globalThis.chrome = { runtime: { id: "test-extension", getManifest: () => ({ version: "1.0.0" }) } };
    globalThis[marker] = true; // 旧版の boolean guard
    assert.equal(ExtUtil.claimScript(marker), true);
    const firstOwner = globalThis[marker];
    assert.equal(ExtUtil.contextAlive(marker, firstOwner), true);
    assert.equal(ExtUtil.claimScript(marker), false);

    // 同じ version でも extension reload 後は runtime object が入れ替わるため stale 扱いにする。
    globalThis.chrome = { runtime: { id: "test-extension", getManifest: () => ({ version: "1.0.0" }) } };
    assert.equal(ExtUtil.claimScript(marker), true);
    assert.equal(ExtUtil.contextAlive(marker, firstOwner), false);
    assert.equal(ExtUtil.contextAlive(marker, globalThis[marker]), true);
  } finally {
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
    if (originalMarker === undefined) delete globalThis[marker];
    else globalThis[marker] = originalMarker;
  }
});

test("normalize defaults persistent translation cache to off and requires literal true", () => {
  assert.equal(SettingsSchema.normalize({}).persistentTranslationCache, false);
  assert.equal(SettingsSchema.normalize({ persistentTranslationCache: false }).persistentTranslationCache, false);
  assert.equal(SettingsSchema.normalize({ persistentTranslationCache: true }).persistentTranslationCache, true);
  assert.equal(SettingsSchema.normalize({ persistentTranslationCache: "yes" }).persistentTranslationCache, false);
});

// ---- TranslationBatch (exact dedupe / retry / session cache) ----

test("TranslationBatch.groupExactTexts groups only exactly equivalent strings", () => {
  assert.deepEqual(TranslationBatch.groupExactTexts(["Hello", "Hello", " hello", "Hello ", "Ｈello", "Hello"]), [
    { text: "Hello", indices: [0, 1, 5] },
    { text: " hello", indices: [2] },
    { text: "Hello ", indices: [3] },
    { text: "Ｈello", indices: [4] },
  ]);
  // NFC/NFD も勝手に正規化しない。文字が変わった可能性を cache hit で隠さないため。
  assert.equal(TranslationBatch.groupExactTexts(["é", "e\u0301"]).length, 2);
});

test("TranslationBatch.groupContextualTexts separates the same source text in different contexts", () => {
  assert.deepEqual(
    TranslationBatch.groupContextualTexts(
      ["Bank", "Bank", "Bank", "Bank!"],
      ["Before: river", "Before: finance", "Before: river", "Before: river"],
    ),
    [
      { text: "Bank", context: "Before: river", indices: [0, 2] },
      { text: "Bank", context: "Before: finance", indices: [1] },
      { text: "Bank!", context: "Before: river", indices: [3] },
    ],
  );
  assert.notEqual(
    TranslationBatch.contextKey("Bank", "Before: river"),
    TranslationBatch.contextKey("Bank", "Before: finance"),
  );
});

test("TranslationBatch.normalizeContexts aligns and caps untrusted page context", () => {
  assert.deepEqual(TranslationBatch.normalizeContexts(["river", 123, "abcdef"], 4, 5), ["river", "", "abcde", ""]);
  assert.equal(TranslationBatch.normalizeContexts(["x".repeat(500)], 1, 999)[0].length, TranslationBatch.CONTEXT_MAX_CHARS);
  assert.deepEqual(TranslationBatch.normalizeContexts("not-an-array", 2), ["", ""]);
});

test("TranslationBatch.shouldRetry excludes incomplete and ambiguous responses", () => {
  assert.equal(TranslationBatch.shouldRetry({ error: "network" }), true);
  assert.equal(TranslationBatch.shouldRetry({ error: "runtime" }), true);
  assert.equal(TranslationBatch.shouldRetry({ error: "http", status: 503 }), true);
  assert.equal(TranslationBatch.shouldRetry({ error: "http", status: 413 }), false);
  assert.equal(TranslationBatch.shouldRetry({ error: "incomplete" }), false);
  assert.equal(TranslationBatch.shouldRetry({ error: "network", ambiguous: true }), false);
  assert.equal(TranslationBatch.shouldRetry({ error: "http", status: 429 }, { isNmt: true }), false);
  assert.equal(TranslationBatch.shouldRetry({ error: "http", status: 429 }, { quotaScope: "day" }), false);
  assert.equal(TranslationBatch.shouldRetry({ error: "http", status: 429 }, { quotaScope: "minute" }), true);
});

test("TranslationBatch.isOversize distinguishes input-size 400 from request-shape 400", () => {
  assert.equal(TranslationBatch.isOversize({ error: "http", status: 400, message: "maximum context length exceeded" }), true);
  assert.equal(TranslationBatch.isOversize({ error: "http", status: 400, message: "unsupported parameter" }), false);
  assert.equal(TranslationBatch.isOversize({ error: "http", status: 413, message: "" }), true);
});

test("TranslationBatch.cacheKey includes every translation variant but excludes API keys", () => {
  const base = {
    provider: "openai", sourceLang: "en", targetLang: "ja",
    models: { openai: "gpt-x" }, apiKeys: { openai: "secret-a" },
  };
  const key = TranslationBatch.cacheKey("https://example.com", base, 1, "Hello");
  assert.equal(key, TranslationBatch.cacheKey("https://example.com", Object.assign({}, base, { apiKeys: { openai: "secret-b" } }), 1, "Hello"));
  assert.notEqual(key, TranslationBatch.cacheKey("https://example.net", base, 1, "Hello"));
  assert.notEqual(key, TranslationBatch.cacheKey("https://example.com", base, 2, "Hello"));
  assert.notEqual(key, TranslationBatch.cacheKey("https://example.com", base, 1, "Hello!"));
  assert.notEqual(key, TranslationBatch.cacheKey("https://example.com", base, 1, "Hello", "Before: greeting"));
  assert.notEqual(key, TranslationBatch.cacheKey("https://example.com/other", base, 1, "Hello"));
  assert.notEqual(key, TranslationBatch.cacheKey("https://example.com", Object.assign({}, base, { targetLang: "fr" }), 1, "Hello"));
  assert.notEqual(key, TranslationBatch.cacheKey("https://example.com", Object.assign({}, base, { models: { openai: "gpt-y" } }), 1, "Hello"));
  assert.equal(key.includes("secret-a"), false);
});

test("TranslationBatch.attemptedTextCount uses the actual cache-miss request size", () => {
  assert.equal(TranslationBatch.attemptedTextCount({ attemptedTextCount: 1 }, 100), 1);
  assert.equal(TranslationBatch.attemptedTextCount({ attemptedTextCount: 4 }, 4), 4);
  assert.equal(TranslationBatch.attemptedTextCount({ attemptedTextCount: 0 }, 10), 10);
  assert.equal(TranslationBatch.attemptedTextCount({ attemptedTextCount: 11 }, 10), 10);
  assert.equal(TranslationBatch.attemptedTextCount(null, 10), 10);
});

test("TranslationBatch.normalizeCacheRecords rejects stale/corrupt entries and keeps the newest duplicate", () => {
  const now = 1000;
  const normalized = TranslationBatch.normalizeCacheRecords([
    ["a", "old", 2000],
    ["expired", "訳", 999],
    ["a", "new", 3000],
    ["far-future", "訳", 9000],
    ["too-long", "123456", 3000],
    ["empty", "", 3000],
    ["bad"],
  ], now, 12, 3000);
  assert.deepEqual(normalized.records, [["a", "new", 3000]]);
  assert.equal(normalized.needsRewrite, true);
  assert.deepEqual(
    TranslationBatch.normalizeCacheRecords([["a", "訳", 2000]], now, 12, 3000),
    { records: [["a", "訳", 2000]], needsRewrite: false },
  );
});

test("StorageKeys exposes separate session and opt-in persistent cache keys", () => {
  assert.equal(g.StorageKeys.TRANSLATION_CACHE, "translationCacheV1");
  assert.equal(g.StorageKeys.PERSISTENT_TRANSLATION_CACHE, "persistentTranslationCacheV1");
});

// ---- ModelPricing (相対コスト用の概算価格) ----

test("ModelPricing.lookup matches known models with longest-match", () => {
  const mini = ModelPricing.lookup("gpt-4o-mini");
  assert.ok(mini && mini.input === 0.15 && mini.output === 0.60);
  // "gpt-4o-mini-2024-..." は gpt-4o ではなく gpt-4o-mini に当たる
  assert.equal(ModelPricing.lookup("gpt-4o-mini-2024-07-18").input, 0.15);
  assert.equal(ModelPricing.lookup("gpt-4o-2024-08-06").input, 2.50);
});

test("ModelPricing.lookup total equals input + output, null for unknown", () => {
  const p = ModelPricing.lookup("claude-3-5-haiku-latest");
  assert.ok(p && p.total === p.input + p.output);
  assert.equal(ModelPricing.lookup("totally-unknown"), null);
  assert.equal(ModelPricing.lookup(""), null);
});

test("ModelPricing.setDynamic prefers exact dynamic price over bundled table", () => {
  try {
    ModelPricing.setDynamic({ "gpt-99.6": { input: 5, output: 30 }, "gpt-4o-mini": { input: 9, output: 9 } });
    // 同梱表に無い新世代 (世代境界ガードで gpt-99 に落ちない ID) も動的価格で引ける
    assert.equal(ModelPricing.lookup("gpt-99.6").total, 35);
    // ベンダ接頭辞付き ID (OpenRouter 等) は末尾一致で引ける
    assert.equal(ModelPricing.lookup("some-vendor/gpt-99.6").input, 5);
    // 完全一致は同梱の部分一致より優先される (実勢価格が勝つ)
    assert.equal(ModelPricing.lookup("gpt-4o-mini").input, 9);
    // 動的に無いモデルは同梱表へフォールバック
    assert.equal(ModelPricing.lookup("gpt-4o-2024-08-06").input, 2.50);
    // 不正な価格 (数値でない) は無視して同梱表フォールバック
    ModelPricing.setDynamic({ "gpt-4o-mini": { input: "x", output: null } });
    assert.equal(ModelPricing.lookup("gpt-4o-mini").input, 0.15);
    // null 単独も 0 扱いにしない (Number(null)===0 の混入検知)。片側欠損はエントリごと不採用
    ModelPricing.setDynamic({ "gpt-4o-mini": { input: 1, output: null } });
    assert.equal(ModelPricing.lookup("gpt-4o-mini").input, 0.15);
    // 負値も不採用
    ModelPricing.setDynamic({ "gpt-4o-mini": { input: -1, output: 2 } });
    assert.equal(ModelPricing.lookup("gpt-4o-mini").input, 0.15);
  } finally {
    ModelPricing.setDynamic(null); // 他テストへ漏らさない
  }
  // 動的なし → 従来どおり世代境界ガードで価格不明に倒れる
  assert.equal(ModelPricing.lookup("gpt-99.6"), null);
});

test("ModelPricing.displayName returns official name from dynamic data, null otherwise", () => {
  try {
    ModelPricing.setDynamic({ "gpt-99.6-sol": { input: 5, output: 30, name: "GPT-99.6 Sol" }, "no-name": { input: 1, output: 2 } });
    assert.equal(ModelPricing.displayName("gpt-99.6-sol"), "GPT-99.6 Sol");
    assert.equal(ModelPricing.displayName("vendor/gpt-99.6-sol"), "GPT-99.6 Sol"); // ベンダ接頭辞は末尾一致
    assert.equal(ModelPricing.displayName("no-name"), null);   // name 無しエントリは null (ID 表示に倒す)
    assert.equal(ModelPricing.displayName("unknown"), null);
  } finally {
    ModelPricing.setDynamic(null);
  }
  assert.equal(ModelPricing.displayName("gpt-99.6-sol"), null); // 動的なしでも null
});

// ---- runtime message / image request security policy ----

test("MessagePolicy separates extension-page and content-script privileges", () => {
  const base = "chrome-extension://replace-translator/";
  const popup = { id: "replace-translator", url: `${base}src/popup/popup.html` };
  const content = { id: "replace-translator", url: "https://hostile.example/page", tab: { id: 7 } };
  const extensionTab = { id: "replace-translator", url: `${base}options.html`, tab: { id: 8 } };

  assert.equal(MessagePolicy.canInvoke("APPLY_SETTINGS", {}, popup, base), true);
  assert.equal(MessagePolicy.canInvoke("APPLY_SETTINGS", {}, content, base), false);
  assert.equal(MessagePolicy.canInvoke("GET_MODELS", {}, content, base), false);
  assert.equal(MessagePolicy.canInvoke("GET_STATE", {}, content, base), false);
  assert.equal(MessagePolicy.canInvoke("TRANSLATE_IMAGE", {}, content, base), true);
  assert.equal(MessagePolicy.canInvoke("TRANSLATE_IMAGE", {}, popup, base), false);
  assert.equal(MessagePolicy.canInvoke("TRANSLATE_BATCH", { quick: true }, popup, base), true);
  assert.equal(MessagePolicy.canInvoke("TRANSLATE_BATCH", { quick: false }, popup, base), false);
  assert.equal(MessagePolicy.canInvoke("TRANSLATE_PAGE", {}, content, base), true);
  assert.equal(MessagePolicy.isExtensionPageSender(extensionTab, base), true);
});

test("MessagePolicy pins content actions to sender.tab and accepts explicit tab only from extension pages", () => {
  const base = "moz-extension://replace-translator/";
  const popup = { url: `${base}src/popup/popup.html` };
  const content = { url: "https://example.com/", tab: { id: 12 } };
  assert.equal(MessagePolicy.targetTabId({ tabId: 99 }, content, base), 12);
  assert.equal(MessagePolicy.targetTabId({ tabId: 99 }, popup, base), 99);
  assert.equal(MessagePolicy.targetTabId({ tabId: "99" }, popup, base), null);
  assert.equal(MessagePolicy.targetTabId({ tabId: 99 }, { url: "https://example.com/" }, base), null);
});

test("ImageRequestPolicy rejects internal targets including terminal-dot FQDN forms", () => {
  const forbidden = [
    "http://example.com/image.png",
    "https://localhost/image.png",
    "https://localhost./image.png",
    "https://printer.local./image.png",
    "https://nas.corp./image.png",
    "https://127.0.0.1./image.png",
    "https://2130706433/image.png",
    "https://[::1]/image.png",
    "https://user:pass@example.com/image.png",
    "https://127.0.0.1.nip.io/image.png",
    "https://10-0-0-1.sslip.io/image.png",
    "https://cdn.192.168.1.5.attacker.example.org/image.png",
    "https://localtest.me/image.png",
  ];
  for (const url of forbidden) assert.equal(ImageRequestPolicy.isForbiddenUrl(url), true, url);
  assert.equal(ImageRequestPolicy.isForbiddenUrl("https://cdn.example.org/image.png"), false);
  assert.equal(ImageRequestPolicy.isForbiddenUrl("https://cdn.example.org./image.png"), false);
});

const pngHeader = (width, height) => {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes[11] = 0x0d;
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const writeU32 = (offset, value) => {
    bytes[offset] = (value >>> 24) & 0xff;
    bytes[offset + 1] = (value >>> 16) & 0xff;
    bytes[offset + 2] = (value >>> 8) & 0xff;
    bytes[offset + 3] = value & 0xff;
  };
  writeU32(16, width);
  writeU32(20, height);
  return bytes;
};

const gifHeader = (width, height) => {
  return Uint8Array.from([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
    width & 0xff, (width >>> 8) & 0xff, height & 0xff, (height >>> 8) & 0xff,
  ]);
};

const webpVp8xHeader = (width, height) => {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  bytes.set([0x56, 0x50, 0x38, 0x58], 12);
  const w = width - 1, h = height - 1;
  bytes.set([w & 0xff, (w >>> 8) & 0xff, (w >>> 16) & 0xff], 24);
  bytes.set([h & 0xff, (h >>> 8) & 0xff, (h >>> 16) & 0xff], 27);
  return bytes;
};

const jpegHeader = (width, height) => {
  const bytes = new Uint8Array(21);
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]);
  bytes.set([(height >>> 8) & 0xff, height & 0xff, (width >>> 8) & 0xff, width & 0xff], 7);
  return bytes;
};

test("ImageRequestPolicy accepts only supported images whose dimensions are readable", () => {
  const samples = [
    [pngHeader(640, 480), "image/png", 640, 480],
    [jpegHeader(1024, 768), "image/jpeg", 1024, 768],
    [gifHeader(320, 240), "image/gif", 320, 240],
    [webpVp8xHeader(800, 600), "image/webp", 800, 600],
  ];
  for (const [bytes, mime, width, height] of samples) {
    assert.deepEqual(ImageRequestPolicy.inspectBytes(bytes, mime), { ok: true, mime, width, height });
  }
});

test("ImageRequestPolicy trusts supported magic bytes over a mismatched image content type", () => {
  assert.deepEqual(ImageRequestPolicy.inspectBytes(pngHeader(40, 30), "image/svg+xml"), {
    ok: true, mime: "image/png", width: 40, height: 30,
  });
});

test("ImageRequestPolicy rejects SVG, BMP, AVIF and malformed supported images before decode", () => {
  const unsupported = [
    [Uint8Array.from([0x3c, 0x73, 0x76, 0x67, 0x3e]), "image/svg+xml"],
    [Uint8Array.from([0x42, 0x4d, 0, 0]), "image/bmp"],
    [Uint8Array.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]), "image/avif"],
    [Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png"],
  ];
  for (const [bytes, mime] of unsupported) {
    assert.equal(ImageRequestPolicy.inspectBytes(bytes, mime).ok, false, mime);
    assert.equal(ImageRequestPolicy.inspectBytes(bytes, mime).error, "not_image", mime);
  }
});

test("ImageRequestPolicy enforces the pixel cap from image headers", () => {
  assert.equal(ImageRequestPolicy.inspectBytes(pngHeader(5000, 5000), "image/png").ok, true);
  assert.deepEqual(ImageRequestPolicy.inspectBytes(pngHeader(5001, 5000), "image/png"), {
    ok: false,
    error: "image_too_large",
    mime: "image/png",
    width: 5001,
    height: 5000,
  });
  assert.equal(ImageRequestPolicy.inspectBytes(pngHeader(0, 100), "image/png").error, "not_image");
});
