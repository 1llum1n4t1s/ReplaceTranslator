"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

test("popup は選択モデル専用の reasoning effort UI と保存経路を備える", () => {
  const html = read("src/popup/popup.html");
  const popup = read("src/popup/popup.js");
  const css = read("src/popup/popup.css");
  assert.match(html, /id="reasoning-effort-row"/);
  assert.match(html, /id="reasoning-effort"/);
  assert.ok(html.indexOf("../lib/providers.js") < html.indexOf('src="popup.js"'));
  assert.match(popup, /ProviderApi\.reasoningProfile\(providerId, modelId\)/);
  assert.match(popup, /profile\.options\.filter\(\(effort\) => effort !== profile\.automatic\)/);
  assert.match(popup, /renderReasoningEffort\(providerId, currentId, currentModelName\)/);
  assert.match(popup, /\$\("reasoning-effort-model"\)\.textContent = modelName/);
  assert.doesNotMatch(popup, /\$\("reasoning-effort-model"\)\.textContent = modelId/);
  assert.match(popup, /save\(\{ reasoningEfforts: all \}/);
  assert.match(css, /\.reasoning-effort\s*\{/);
});

test("service worker は通常・stream・画像の全経路へモデル別 effort を渡す", () => {
  const worker = read("src/service_worker.js");
  const calls = worker.match(/reasoningEffort:\s*reasoningEffortFor\(/g) || [];
  assert.equal(calls.length, 3);
});

test("日英 locale に effort UI 文言が揃う", () => {
  for (const locale of ["ja", "en"]) {
    const messages = JSON.parse(read(`_locales/${locale}/messages.json`));
    for (const key of ["labelReasoningEffort", "reasoningEffortHelp", "effortAuto", "effortNone", "effortMax", "effortTokenUnit"]) {
      assert.equal(typeof messages[key].message, "string", `${locale}:${key}`);
    }
  }
});
