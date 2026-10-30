"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const workerHarness = require("./_worker-harness");

const root = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const pageSender = url => ({ id: "translation-test", url, tab: { id: 1 } });

const pageHarness = (options = {}) => {
  const h = workerHarness(options);
  h.session.pageSessionsV1 = { 1: { id: 1, settings: h.context.SettingsSchema.normalize(h.disk.settings) } };
  return h;
};

const translate = (h, { url = "https://example.com/page", texts = ["Hello"], contexts = ["context"] } = {}) => {
  return h.send({ action: "TRANSLATE_BATCH", sessionId: 1, batchId: 1, texts, contexts }, pageSender(url));
};

test("cache hits and failed misses retain their original batch indices", async () => {
  const h = pageHarness({ initial: { provider: "mymemory" }, fetchResponse: async url =>
    new URL(url).hostname === "api.mymemory.translated.net"
      ? Response.json({ responseStatus: 200, responseData: { translatedText: "成功" } }) : null });
  const s = h.context.SettingsSchema.normalize(h.disk.settings);
  const key = h.context.TranslationBatch.cacheKey("https://example.com/page", s, h.context.ProviderApi.promptVersion, "cached text", "");
  h.session[h.context.StorageKeys.TRANSLATION_CACHE] = [[key, "キャッシュ訳", Date.now() + 600000]];
  const longText = "x".repeat(501);
  const result = await translate(h, { texts: ["cached text", longText, "new short text"] });
  assert.equal(result.ok, false);
  assert.equal(result.error, "too_long");
  assert.deepEqual(result.translations, ["キャッシュ訳", longText, "成功"]);
  assert.deepEqual(result.failedIndices, [1]);
  assert.equal(result.cacheHits, 1);
  assert.equal(result.attemptedTextCount, 2);
  assert.deepEqual(h.partials.map(p => [p.index, p.text]), [[0, "キャッシュ訳"]]);
});

test("opt-in persists translations across worker restart; opt-out clears both caches even with queued writes", async () => {
  const initial = { provider: "anthropic", apiKeys: { anthropic: "test-key" } };
  const h = pageHarness({ initial });
  const localKey = h.context.StorageKeys.PERSISTENT_TRANSLATION_CACHE;
  const sessionKey = h.context.StorageKeys.TRANSLATION_CACHE;
  assert.equal((await translate(h)).translations[0], "test translation");
  await h.suspend();
  assert.equal(h.disk[localKey], undefined);
  assert.equal((await h.send({ action: "APPLY_SETTINGS", patch: { persistentTranslationCache: true } })).ok, true);
  assert.equal(h.disk[localKey].length, 1);

  const restarted = pageHarness({ disk: h.disk });
  const restored = await translate(restarted);
  assert.equal(restored.translations[0], "test translation");
  assert.deepEqual(restored.usage, { input: 0, output: 0 });
  assert.equal(restored.cacheHits, 1);
  assert.equal(restarted.requests.length, 0);
  await restarted.suspend();
  assert.equal(restarted.session[sessionKey].length, 1);

  const storage = restarted.context.chrome.storage.session;
  const originalSet = storage.set;
  let release, started;
  const blocked = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  storage.set = async values => { started(); await blocked; return originalSet(values); };
  const write = restarted.suspend();
  await entered;
  const queuedWrite = restarted.suspend();
  const disable = restarted.send({ action: "APPLY_SETTINGS", patch: { persistentTranslationCache: false } });
  release();
  await Promise.all([write, queuedWrite]);
  assert.equal((await disable).ok, true);
  assert.equal(restarted.disk[localKey], undefined);
  assert.equal(restarted.session[sessionKey], undefined);
  assert.equal((await translate(restarted)).translations[0], "test translation");
  assert.equal(restarted.requests.length, 1);
});

test("cache reuses only matching context and page scope", async () => {
  const h = pageHarness({ initial: { provider: "anthropic", apiKeys: { anthropic: "test-key" } } });
  const a = { url: "https://example.com/page?first#one", contexts: ["bank of a river"] };
  assert.equal((await translate(h, a)).translations[0], "test translation");
  assert.equal((await translate(h, { ...a, url: "https://example.com/page?second#two" })).translations[0], "test translation");
  assert.equal(h.requests.length, 1);
  assert.equal((await translate(h, { ...a, contexts: ["bank for money"] })).translations[0], "test translation");
  assert.equal((await translate(h, { ...a, url: "https://example.com/other" })).translations[0], "test translation");
  assert.equal(h.requests.length, 3);
  assert.match(JSON.stringify(h.requests[0].body), /bank of a river/);
  assert.match(JSON.stringify(h.requests[1].body), /bank for money/);
});

test("an already-open tab upgrades an older TranslationBatch helper before the load guard returns", () => {
  const sandbox = {
    __rtActionsLoaded: true,
    TranslationBatch: Object.freeze({ groupExactTexts() { return []; } }),
  };
  vm.runInNewContext(read("src/lib/actions.js"), sandbox);
  assert.equal(typeof sandbox.TranslationBatch.groupContextualTexts, "function");
  assert.equal(typeof sandbox.TranslationBatch.contextKey, "function");
});
