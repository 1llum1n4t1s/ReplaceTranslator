"use strict";

const test = require("node:test");
const assert = require("node:assert");
const g = require("./_load-actions.js");

const { SettingsSchema, TokenUsage, Providers, BatchTuner, ModelPricing } = g;

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

test("normalize clamps batchSize into [1,100]", () => {
  assert.equal(SettingsSchema.normalize({ batchSize: 9999 }).batchSize, 100);
  assert.equal(SettingsSchema.normalize({ batchSize: 0 }).batchSize, 1);
  assert.equal(SettingsSchema.normalize({ batchSize: "abc" }).batchSize, 30);
  assert.equal(SettingsSchema.normalize({ batchSize: 25 }).batchSize, 25);
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

test("normalize coerces boolean flags", () => {
  const s = SettingsSchema.normalize({ useBuiltinDetector: "yes", autoTranslate: 0 });
  assert.equal(s.useBuiltinDetector, true);
  assert.equal(s.autoTranslate, false);
});

// ---- TokenUsage ----

test("currentMonthKey formats YYYY-MM", () => {
  assert.equal(TokenUsage.currentMonthKey(new Date(2026, 5, 3)), "2026-06");
  assert.equal(TokenUsage.currentMonthKey(new Date(2026, 0, 1)), "2026-01");
  assert.equal(TokenUsage.currentMonthKey(new Date(2026, 11, 31)), "2026-12");
});

test("addUsage accumulates without mutating the input store", () => {
  const a = TokenUsage.addUsage({}, "2026-06", "openai", 10, 5);
  const b = TokenUsage.addUsage(a, "2026-06", "openai", 3, 2);
  assert.deepEqual(a["2026-06"].openai, { input: 10, output: 5 });
  assert.deepEqual(b["2026-06"].openai, { input: 13, output: 7 });
});

test("addUsage separates months and providers", () => {
  let store = {};
  store = TokenUsage.addUsage(store, "2026-06", "openai", 10, 5);
  store = TokenUsage.addUsage(store, "2026-07", "openai", 1, 1);
  assert.deepEqual(store["2026-06"].openai, { input: 10, output: 5 });
  assert.deepEqual(store["2026-07"].openai, { input: 1, output: 1 });
});

test("usageForMonth sums per provider and grand total", () => {
  let store = {};
  store = TokenUsage.addUsage(store, "2026-06", "openai", 10, 5);
  store = TokenUsage.addUsage(store, "2026-06", "gemini", 20, 8);
  const r = TokenUsage.usageForMonth(store, "2026-06");
  assert.equal(r.perProvider.openai.total, 15);
  assert.equal(r.perProvider.gemini.total, 28);
  assert.equal(r.perProvider.anthropic.total, 0);
  assert.equal(r.total.total, 43);
});

test("usageForMonth on empty/missing month returns zeros (monthly reset behavior)", () => {
  const r = TokenUsage.usageForMonth({}, "2099-01");
  assert.equal(r.total.total, 0);
  assert.equal(r.perProvider.anthropic.total, 0);
});

test("pruneUsage keeps only the latest N months", () => {
  const store = { "2026-01": {}, "2026-02": {}, "2026-03": {} };
  const r = TokenUsage.pruneUsage(store, 2);
  assert.deepEqual(Object.keys(r).sort(), ["2026-02", "2026-03"]);
});

// ---- Providers ----

test("Providers expose ids and get()", () => {
  assert.deepEqual(Providers.ids, ["openai", "anthropic", "gemini", "xai", "mymemory"]);
  assert.equal(Providers.get("openai").label, "OpenAI");
  assert.equal(Providers.get("gemini").defaultModel, "gemini-2.5-flash");
  assert.equal(Providers.get("nope"), null);
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
