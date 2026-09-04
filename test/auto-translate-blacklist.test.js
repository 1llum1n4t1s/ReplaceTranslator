"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), "utf8");

test("popupに自動翻訳除外タブと複数行入力を備える", () => {
  const html = read("src/popup/popup.html");
  const popup = read("src/popup/popup.js");
  const css = read("src/popup/popup.css");

  assert.equal((html.match(/data-tab=/g) || []).length, 3);
  assert.match(html, /data-tab="blacklist"/);
  assert.match(html, /data-pane="blacklist"/);
  assert.match(html, /<textarea[^>]+id="auto-translate-blacklist"[^>]+rows="11"/);
  assert.match(popup, /AutoTranslateBlacklist\.normalize\(state\.settings\.autoTranslateBlacklist\)/);
  assert.match(popup, /save\(\{ autoTranslateBlacklistChanges \}/);
  assert.match(popup, /remove: blacklistBaseline\.filter/);
  assert.match(css, /body\s*\{[\s\S]*?width:\s*360px/);
  assert.match(css, /\.tab\s*\{[\s\S]*?flex:\s*1/);
});

test("Service Workerは自動翻訳だけをブラックリストで抑止する", () => {
  const worker = read("src/service_worker.js");

  assert.match(worker, /if \(!manual\)[\s\S]+AutoTranslateBlacklist\.matches\(tabUrl, settings\.autoTranslateBlacklist\)/);
  assert.match(worker, /if \(!settings\.autoTranslate\) return \{ ok: true, autoTranslateDisabled: true \}/);
  assert.match(worker, /if \(routeChange\) await restorePage\(tabId\)/);
  assert.match(worker, /translatePage\(tabId, msg\.manual === true, msg\.routeChange === true\)/);
  assert.match(worker, /return \{ ok: true, blacklisted: true \}/);
  assert.match(worker, /id: AUTO_TRANSLATE_SITE_MENU_ID[\s\S]+contexts: \["all"\]/);
  assert.match(worker, /AutoTranslateBlacklist\.toggleSite\(url, base\.autoTranslateBlacklist\)/);
});

test("英語と日本語に除外タブと右クリック切替文言が揃う", () => {
  for (const locale of ["en", "ja"]) {
    const messages = JSON.parse(read(`_locales/${locale}/messages.json`));
    for (const key of [
      "tabBlacklist", "blacklistTitle", "blacklistDesc", "blacklistPlaceholder",
      "blacklistHelp", "blacklistSaving", "blacklistSaved",
      "ctxAutoTranslateBlock", "ctxAutoTranslateAllow",
    ]) {
      assert.equal(typeof messages[key]?.message, "string", `${locale}: ${key}`);
      assert.ok(messages[key].message.length > 0, `${locale}: ${key} is not empty`);
    }
  }

  const ja = JSON.parse(read("_locales/ja/messages.json"));
  assert.equal(ja.ctxAutoTranslateBlock.message, "このサイトを自動翻訳対象外に追加");
  assert.equal(ja.ctxAutoTranslateAllow.message, "このサイトを自動翻訳対象外から削除");
});
