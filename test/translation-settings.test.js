"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const workerHarness = require("./_worker-harness.js");

test("popupのクイック翻訳は専用言語を使い、選択翻訳とページ翻訳の言語を変更しない", async () => {
  const h = workerHarness({ initial: { provider: "openai", apiKeys: { openai: "test-key" },
    sourceLang: "auto", targetLang: "ja", quickSourceLang: "ja", quickTargetLang: "en" } });
  assert.equal((await h.send({ action: "TRANSLATE_BATCH", quick: true, texts: ["こんにちは"] })).ok, true);
  assert.match(h.requests[0].body.messages[0].content, /Translate text into English/);
  assert.match(h.requests[0].body.messages[0].content, /source language is Japanese/);
  const content = { id: "translation-test", url: "https://example.com", tab: { id: 1 } };
  assert.equal((await h.send({ action: "TRANSLATE_BATCH", quick: true, texts: ["Hello"] }, content)).ok, true);
  assert.match(h.requests[1].body.messages[0].content, /Translate text into Japanese/);
  await h.send({ action: "APPLY_SETTINGS", patch: { quickTargetLang: "fr" } });
  const state = await h.send({ action: "GET_STATE" });
  assert.equal(state.settings.targetLang, "ja");
  assert.equal(state.settings.sourceLang, "auto");
  assert.equal(state.settings.quickTargetLang, "fr");
});

test("かわいくとカスタムのプロンプトは実際の翻訳要求でも同時に送らない", async () => {
  const h = workerHarness({ initial: { provider: "openai", apiKeys: { openai: "test-key" },
    translationStyle: "cute", customPrompt: "Use a formal tone" } });
  await h.send({ action: "TRANSLATE_BATCH", quick: true, texts: ["Hello"] });
  assert.match(h.requests[0].body.messages[0].content, /adorable, sweet, playful/);
  assert.doesNotMatch(h.requests[0].body.messages[0].content, /Use a formal tone/);
  await h.send({ action: "APPLY_SETTINGS", patch: { translationStyle: "custom" } });
  await h.send({ action: "TRANSLATE_BATCH", quick: true, texts: ["Hello"] });
  assert.match(h.requests[1].body.messages[0].content, /Use a formal tone/);
  assert.doesNotMatch(h.requests[1].body.messages[0].content, /adorable, sweet, playful/);
});

test("新しいGeminiの推論深度をカタログから取得し、SW再起動後も保存した深度で送信する", async () => {
  const h = workerHarness({ initial: { provider: "gemini", apiKeys: { gemini: "test-key" }, models: { gemini: "gemini-future" } },
    catalog: { google: { models: { "gemini-future": { cost: { input: 1, output: 2 }, reasoning: true,
      reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }] } } } },
    models: { gemini: { models: [{ name: "models/gemini-future", supportedGenerationMethods: ["generateContent"] }] } } });
  const list = await h.send({ action: "GET_MODELS", provider: "gemini", force: true });
  assert.equal(list.ok, true);
  assert.deepEqual(list.models[0].reasoning.options, ["low", "medium", "high"]);
  await h.send({ action: "APPLY_SETTINGS", patch: { reasoningEfforts: { gemini: { "gemini-future": "high" } } } });
  await h.send({ action: "TRANSLATE_BATCH", quick: true, texts: ["Hello"] });
  assert.equal(h.requests[0].body.generationConfig.thinkingConfig.thinkingLevel, "high");
  const restarted = workerHarness({ disk: h.disk });
  const result = await restarted.send({ action: "TRANSLATE_BATCH", quick: true, texts: ["Hello"] });
  assert.equal(result.ok, true);
  assert.equal(restarted.requests[0].body.generationConfig.thinkingConfig.thinkingLevel, "high");
  assert.equal(restarted.fetches.some(url => url.includes("models.dev")), false);
});

test("モデル更新で選択中モデルを移行した場合も実際のモデルIDをpopupへ返す", async () => {
  const h = workerHarness({ initial: { provider: "fugu", apiKeys: { fugu: "test-key" }, models: { fugu: "fugu" } },
    models: { fugu: { data: [{ id: "fugu-max" }] } } });
  const list = await h.send({ action: "GET_MODELS", provider: "fugu", force: true });
  assert.equal(list.ok, true);
  assert.equal(list.currentModel, "fugu-max");
  assert.equal(h.disk.settings.models.fugu, "fugu-max");
});
