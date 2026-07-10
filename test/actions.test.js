"use strict";

const test = require("node:test");
const assert = require("node:assert");
const g = require("./_load-actions.js");

const { SettingsSchema, TokenUsage, Providers, BatchTuner, ModelPricing, RuntimeLimits } = g;

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

test("normalize defaults showFab to true when missing (existing installs keep the FAB)", () => {
  assert.equal(SettingsSchema.normalize({}).showFab, true);          // 既存ユーザーの保存済み設定にはキーが無い
  assert.equal(SettingsSchema.normalize({ showFab: false }).showFab, false);
  assert.equal(SettingsSchema.normalize({ showFab: true }).showFab, true);
});

test("normalize defaults selectionTranslate to true when missing (existing installs keep selection translate)", () => {
  assert.equal(SettingsSchema.normalize({}).selectionTranslate, true);          // 欠損設定でも選択翻訳は有効
  assert.equal(SettingsSchema.normalize({ selectionTranslate: false }).selectionTranslate, false);
  assert.equal(SettingsSchema.normalize({ selectionTranslate: true }).selectionTranslate, true);
  assert.equal(SettingsSchema.normalize({ selectionTranslate: "x" }).selectionTranslate, true); // 厳密に false のときだけ無効 (showFab と同形)
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
