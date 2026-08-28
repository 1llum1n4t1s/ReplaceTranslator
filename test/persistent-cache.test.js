"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("persistent translation cache is exposed as an explicit localized opt-in", () => {
  const html = read("src/popup/popup.html");
  const popup = read("src/popup/popup.js");
  const en = JSON.parse(read("_locales/en/messages.json"));
  const ja = JSON.parse(read("_locales/ja/messages.json"));

  assert.match(html, /id="persistent-cache" type="checkbox"/);
  assert.match(html, /data-i18n="optPersistentCache"/);
  assert.match(html, /data-i18n="optPersistentCacheDesc"/);
  assert.match(popup, /state\.settings\.persistentTranslationCache === true/);
  assert.match(popup, /save\(\{ persistentTranslationCache: checkbox\.checked \}\)/);
  for (const locale of [en, ja]) {
    assert.ok(locale.optPersistentCache.message);
    assert.ok(locale.optPersistentCacheDesc.message);
  }
});

test("persistent cache storage is gated and removed on opt-out", () => {
  const worker = read("src/service_worker.js");
  assert.match(worker, /if \(persistentTranslationCacheEnabled\)/);
  assert.match(worker, /chrome\.storage\.local\.set\(\{ \[StorageKeys\.PERSISTENT_TRANSLATION_CACHE\]: records \}\)/);
  assert.match(worker, /chrome\.storage\.local\.remove\(StorageKeys\.PERSISTENT_TRANSLATION_CACHE\)/);
  assert.match(worker, /chrome\.storage\.session\.remove\(StorageKeys\.TRANSLATION_CACHE\)/);
});

test("page translation carries context through dedupe, cache lookup, and provider input", () => {
  const translator = read("src/content/translator.js");
  const worker = read("src/service_worker.js");
  const providers = read("src/lib/providers.js");

  assert.match(translator, /groupContextualTexts/);
  assert.match(translator, /texts, contexts, settings, batchId, sessionId/);
  assert.match(worker, /cacheKey\(scope, settings, ProviderApi\.promptVersion, texts\[i\], contexts\[i\]\)/);
  assert.match(worker, /ProviderApi\.buildRequest\(providerId, \{[\s\S]*?texts,[\s\S]*?contexts,/);
  assert.match(worker, /url\.origin \+ url\.pathname/);
  assert.match(providers, /const TRANSLATION_PROMPT_VERSION = 2/);
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
