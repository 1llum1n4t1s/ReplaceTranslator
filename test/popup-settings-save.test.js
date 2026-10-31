"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { SettingsSchema, AutoTranslateBlacklist } = require("./_load-actions.js");

const startupHarness = () => {
  const popup = fs.readFileSync(path.join(__dirname, "../src/popup/popup.js"), "utf8");
  const controls = new Map();
  const requests = [];
  const timers = new Map();
  let nextTimer = 0;
  let directionUpdates = 0;
  const document = { activeElement: null, createElement: () => ({ textContent: "" }) };
  const state = { settings: SettingsSchema.normalize({}) };
  const element = id => {
    if (!controls.has(id)) {
      const classes = new Set();
      controls.set(id, { value: "", checked: false, textContent: "", listeners: {},
        classList: { add: name => classes.add(name), remove: name => classes.delete(name),
          contains: name => classes.has(name), toggle(name, force) { if (force) classes.add(name); else classes.delete(name); } },
        addEventListener(event, fn) { this.listeners[event] = fn; }, setAttribute() {}, focus() {},
        replaceChildren() { this.textContent = ""; }, appendChild(child) { this.textContent += child.textContent; } });
    }
    return controls.get(id);
  };
  const startup = popup.slice(popup.indexOf("    getActiveTab().then((tab) => {"),
    popup.indexOf('    document.querySelectorAll(".tab").forEach', popup.indexOf("  function init()")));
  const keys = popup.slice(popup.indexOf("  function reflectKeys()"), popup.indexOf("  // ---- 共通 ----"));
  const common = popup.slice(popup.indexOf("  function reflectStyleLanguage()"), popup.indexOf("  async function getActiveTab"));
  const quick = popup.slice(popup.indexOf("  let rerunQuickTranslate ="), popup.indexOf("  function init()"));
  const listeners = popup.slice(popup.indexOf('    $("sync-settings").addEventListener'),
    popup.indexOf("    // ショートカット変更:"));
  const api = vm.runInNewContext(`(() => {
    ${keys}
    ${common}
    ${quick}
    return { save, reflect, saveBlacklist, addCurrentSiteToBlacklist, bindKeyAutosave, setupQuickTranslate, bind() { ${listeners} }, start() { ${startup} } };
  })()`, { state, SettingsSchema, AutoTranslateBlacklist, Providers: { ids: ["openai", "xai"] },
    Actions: { APPLY_SETTINGS: "APPLY_SETTINGS", GET_STATE: "GET_STATE", TRANSLATE_BATCH: "TRANSLATE_BATCH" }, $: element,
    chrome: { runtime: { lastError: null, sendMessage: (message, callback) => requests.push({ message, callback }) } },
    getActiveTab: async () => ({ id: 1, url: "https://chatgpt.com/c/6aa436e4-b728-83ee-b1c1-c7d62b8379cb" }),
    document,
    window: { setTimeout: fn => { const id = ++nextTimer; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id) },
    msg: key => key, setStatus: () => {}, errorText: () => "error", renderProviderList: () => {},
    updateKeyWarning: () => {}, updateQtDir: () => { directionUpdates++; }, loadModels: () => {},
  });
  return { api, state, element, requests, document, get directionUpdates() { return directionUpdates; },
    runTimers() { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); } };
};

test("方言の選択肢は日本語の翻訳先だけに表示し、言語変更後も保存値を保持する", () => {
  const h = startupHarness();
  h.state.settings = SettingsSchema.normalize({ targetLang: "ja", translationStyle: "osaka" });
  h.api.reflect();
  assert.equal(h.element("style-osaka").hidden, false);
  assert.equal(h.element("translation-style").value, "osaka");
  h.state.settings.targetLang = "en";
  h.api.reflect();
  assert.equal(h.element("style-osaka").hidden, true);
  assert.equal(h.element("style-ibaraki").disabled, true);
  assert.equal(h.element("translation-style").value, "natural");
  assert.equal(h.state.settings.translationStyle, "osaka");
  h.state.settings.targetLang = "ja";
  h.api.reflect();
  assert.equal(h.element("translation-style").value, "osaka");
});

test("クイック翻訳は入力変更直後に旧応答を捨て、新しい入力の応答だけ表示する", async () => {
  const h = startupHarness();
  h.api.setupQuickTranslate();
  const input = h.element("qt-in"), output = h.element("qt-out"), qt = h.element("qt");
  input.value = "first";
  input.listeners.input();
  h.runTimers();
  await Promise.resolve();
  assert.equal(h.requests[0].message.texts[0], "first");
  input.value = "second";
  input.listeners.input();
  h.requests[0].callback({ ok: true, translations: ["first translation"] });
  assert.equal(output.textContent, "");
  assert.equal(qt.classList.contains("busy"), true);
  h.runTimers();
  await Promise.resolve();
  assert.equal(h.requests[1].message.texts[0], "second");
  h.requests[1].callback({ ok: true, translations: ["second translation"] });
  assert.equal(output.textContent, "second translation");
  assert.equal(qt.classList.contains("busy"), false);
});

test("クイック翻訳は長すぎる入力とクリア後も旧応答を表示しない", async () => {
  const h = startupHarness();
  h.api.setupQuickTranslate();
  const input = h.element("qt-in"), output = h.element("qt-out"), qt = h.element("qt");
  input.value = "first";
  input.listeners.input();
  h.runTimers();
  await Promise.resolve();
  input.value = "x".repeat(5001);
  input.listeners.input();
  h.runTimers();
  assert.equal(output.textContent, "qtTooLong");
  assert.equal(qt.classList.contains("busy"), false);
  h.requests[0].callback({ ok: true, translations: ["first translation"] });
  assert.equal(output.textContent, "qtTooLong");
  input.value = "new";
  input.listeners.input();
  h.runTimers();
  await Promise.resolve();
  h.element("qt-clear").listeners.click();
  assert.equal(input.value, "");
  assert.equal(qt.classList.contains("busy"), false);
  h.requests[1].callback({ ok: true, translations: ["new translation"] });
  assert.equal(output.textContent, "");
});

test("クイック翻訳は保存待ちの入力を変更すると旧送信を中止し、Ctrl+Enter は一度だけ送る", async () => {
  const h = startupHarness();
  h.api.setupQuickTranslate();
  const saved = h.api.save({ quickTargetLang: "en" });
  const input = h.element("qt-in");
  input.value = "first";
  input.listeners.input();
  h.runTimers();
  input.value = "second";
  input.listeners.input();
  let prevented = false;
  input.listeners.keydown({ ctrlKey: true, key: "Enter", preventDefault() { prevented = true; } });
  h.runTimers();
  assert.equal(h.requests.length, 1);
  h.requests[0].callback({ ok: true, settings: SettingsSchema.normalize({ quickTargetLang: "en" }) });
  await saved;
  await Promise.resolve();
  assert.equal(prevented, true);
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].message.texts[0], "second");
  h.requests[1].callback({ ok: true, translations: ["second translation"] });
  assert.equal(h.element("qt-out").textContent, "second translation");
  assert.equal(h.element("qt").classList.contains("busy"), false);
});

test("クイック翻訳は連続送信の古い応答と空入力後の応答を無視する", async () => {
  const h = startupHarness();
  h.api.setupQuickTranslate();
  const input = h.element("qt-in"), output = h.element("qt-out"), qt = h.element("qt");
  input.value = "first";
  input.listeners.input();
  const key = { ctrlKey: true, key: "Enter", preventDefault() {} };
  input.listeners.keydown(key);
  await Promise.resolve();
  input.listeners.keydown(key);
  await Promise.resolve();
  assert.equal(h.requests.length, 2);
  h.requests[0].callback({ ok: true, translations: ["first translation"] });
  assert.equal(output.textContent, "");
  assert.equal(qt.classList.contains("busy"), true);
  h.requests[1].callback({ ok: true, translations: ["first translation"] });
  assert.equal(output.textContent, "first translation");
  input.value = "second";
  input.listeners.input();
  h.runTimers();
  await Promise.resolve();
  input.value = " ";
  input.listeners.input();
  assert.equal(qt.classList.contains("busy"), false);
  h.requests[2].callback({ ok: true, translations: ["second translation"] });
  assert.equal(output.textContent, "");
});

test("追加指示の未保存入力は再描画で消えず、保存後に表示と保存値が一致する", async () => {
  const h = startupHarness();
  h.api.bind();
  const input = h.element("custom-prompt");
  input.value = "  かわいく訳して  ";
  input.listeners.input();
  h.api.reflect();
  assert.equal(input.value, "  かわいく訳して  ");
  const saved = input.listeners.blur({ target: input });
  assert.equal(h.requests[0].message.patch.customPrompt, "  かわいく訳して  ");
  h.requests[0].callback({ ok: true, settings: SettingsSchema.normalize({ customPrompt: input.value }) });
  await saved;
  h.api.reflect();
  assert.equal(input.value, "かわいく訳して");
  assert.equal(h.state.settings.customPrompt, "かわいく訳して");
});

test("追加指示は保存失敗後も再入力せず再試行でき、空欄にも戻せる", async () => {
  const h = startupHarness();
  h.api.bind();
  const input = h.element("custom-prompt");
  input.value = "かわいく訳して";
  input.listeners.input();
  let saved = input.listeners.blur({ target: input });
  h.requests[0].callback({ ok: false, settings: SettingsSchema.normalize({}) });
  await saved;
  h.api.reflect();
  assert.equal(input.value, "かわいく訳して");
  saved = input.listeners.blur({ target: input });
  h.requests[1].callback({ ok: true, settings: SettingsSchema.normalize({ customPrompt: input.value }) });
  await saved;
  assert.equal(h.state.settings.customPrompt, "かわいく訳して");
  input.value = "";
  input.listeners.input();
  saved = input.listeners.blur({ target: input });
  h.requests[2].callback({ ok: true, settings: SettingsSchema.normalize({}) });
  await saved;
  h.api.reflect();
  assert.equal(h.state.settings.customPrompt, "");
  assert.equal(input.value, "");
});

test("起動GET_STATEの遅延応答は完了済みの設定変更を巻き戻さない", async () => {
  const h = startupHarness();
  h.api.start();
  await Promise.resolve();
  const saved = h.api.save({ autoTranslate: true, targetLang: "en" });
  h.requests[1].callback({ ok: true, settings: SettingsSchema.normalize({ autoTranslate: true, targetLang: "en" }) });
  await saved;
  await h.requests[0].callback({ ok: true, settings: SettingsSchema.normalize({}) });
  assert.equal(h.state.settings.autoTranslate, true);
  assert.equal(h.element("target").value, "en");
});

test("起動GET_STATE待ちの保存が未完了なら、その確定値を表示する", async () => {
  const h = startupHarness();
  h.api.start();
  await Promise.resolve();
  const saved = h.api.save({ autoTranslate: true });
  const reflected = h.requests[0].callback({ ok: true, settings: SettingsSchema.normalize({}) });
  h.requests[1].callback({ ok: true, settings: SettingsSchema.normalize({ autoTranslate: true }) });
  await saved;
  await reflected;
  assert.equal(h.element("auto-translate").checked, true);
});

test("設定の再描画はblur前のAPIキー入力を保持する", () => {
  const h = startupHarness();
  h.api.bindKeyAutosave();
  const input = h.element("key-openai");
  input.value = "draft-key";
  input.listeners.input?.();
  h.api.reflect();
  assert.equal(input.value, "draft-key");
});

test("初期設定は未操作のときに反映し、保存通信失敗時も保管値を表示する", async () => {
  for (const fail of [false, true]) {
    const h = startupHarness();
    h.api.start();
    await Promise.resolve();
    if (fail) {
      const saved = h.api.save({ showFab: true });
      h.requests[1].callback(undefined);
      assert.equal(await saved, false);
    }
    await h.requests[0].callback({ ok: true, settings: SettingsSchema.normalize({ targetLang: "fr" }) });
    assert.equal(h.element("target").value, "fr");
    assert.equal(h.element("show-fab").checked, false);
  }
});

test("同期切替の再描画は後続保存を待ち、除外リストとスライダーの入力を残す", async () => {
  const h = startupHarness();
  h.api.bind();
  const sync = h.element("sync-settings");
  sync.checked = true;
  const toggled = sync.listeners.change({ target: sync });
  const list = h.element("auto-translate-blacklist");
  list.value = "draft.example";
  list.listeners.input();
  const slider = h.element("fab-opacity");
  slider.value = "45";
  slider.listeners.input({ target: slider });
  const saved = h.api.save({ targetLang: "en" });
  h.requests[0].callback({ ok: true, settings: SettingsSchema.normalize({ syncSettings: true }) });
  await Promise.resolve();
  assert.equal(sync.disabled, true);
  h.requests[1].callback({ ok: true, settings: SettingsSchema.normalize({ syncSettings: true, targetLang: "en" }) });
  await saved;
  await toggled;
  assert.equal(h.element("target").value, "en");
  assert.equal(list.value, "draft.example");
  assert.equal(slider.value, "45");
  assert.equal(h.element("fab-opacity-val").textContent, "45%");
  assert.equal(sync.disabled, false);
});

test("初期読込前のAPIキー保存は変更したプロバイダだけを送る", () => {
  const h = startupHarness();
  h.api.bindKeyAutosave();
  const input = h.element("key-openai");
  input.value = "draft-key";
  input.listeners.input();
  input.listeners.blur();
  assert.deepEqual(JSON.parse(JSON.stringify(h.requests[0].message.patch)), { apiKeys: { openai: "draft-key" } });
});

test("除外リストの保存応答は保存中に追記した入力を上書きしない", async () => {
  const h = startupHarness();
  h.api.bind();
  const list = h.element("auto-translate-blacklist");
  list.value = "first.example";
  list.listeners.input();
  const saved = h.api.saveBlacklist();
  list.value += "\nsecond.example";
  list.listeners.input();
  h.requests[0].callback({ ok: true, settings: SettingsSchema.normalize({ autoTranslateBlacklist: ["first.example"] }) });
  await saved;
  h.api.reflect();
  assert.equal(list.value, "first.example\nsecond.example");
});

test("現在のサイト追加はURLのパスを捨ててhostnameだけを保存する", async () => {
  const h = startupHarness();
  h.api.bind();
  const adding = h.api.addCurrentSiteToBlacklist();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.requests.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.requests[0].message.patch)), {
    autoTranslateBlacklistChanges: { add: ["chatgpt.com"], remove: [] },
  });
  h.requests[0].callback({ ok: true, settings: SettingsSchema.normalize({ autoTranslateBlacklist: ["chatgpt.com"] }) });
  assert.equal(await adding, true);
  assert.equal(h.element("auto-translate-blacklist").value, "chatgpt.com");
  assert.equal(h.element("blacklist-add-current").disabled, false);
});

test("除外リストの保存失敗を編集中のタブに表示し、再保存で回復する", async () => {
  const h = startupHarness();
  const input = h.element("auto-translate-blacklist");
  const label = h.element("blacklist-save-state");
  input.value = "example.com";
  h.document.activeElement = input;
  const settings = SettingsSchema.normalize({});
  let saved = h.api.saveBlacklist();
  h.requests[0].callback({ ok: false, settings });
  await saved;
  assert.equal(label.textContent, "settingsSaveFailed");
  assert.equal(input.value, "example.com");
  saved = h.api.saveBlacklist();
  h.requests[1].callback({ ok: true, settings });
  await saved;
  assert.equal(label.textContent, "blacklistSaved");
});

test("設定保存失敗時は変更した操作子だけを保存値へ戻す", async () => {
  const h = startupHarness();
  const controls = Object.fromEntries(["show-fab", "fab-opacity", "fab-opacity-val", "target", "qt-target",
    "sel-mode", "auto-translate-blacklist", "key-openai"].map(id => {
    const control = h.element(id);
    control.value = "unsaved";
    control.checked = true;
    return [id, control];
  }));
  const settings = SettingsSchema.normalize({});
  const saved = h.api.save({ showFab: true, fabOpacity: 0.5, targetLang: "en", quickTargetLang: "fr", selectionMode: "inline" });
  h.requests[0].callback({ ok: false, settings });
  assert.equal(await saved, false);
  assert.equal(controls["show-fab"].checked, false);
  assert.equal(controls["fab-opacity"].disabled, true);
  assert.equal(controls["fab-opacity"].value, "100");
  assert.equal(controls["fab-opacity-val"].textContent, "100%");
  assert.equal(controls.target.value, "ja");
  assert.equal(controls["qt-target"].value, "ja");
  assert.equal(controls["sel-mode"].value, "bubble");
  assert.equal(controls["key-openai"].value, "unsaved");
  assert.equal(controls["auto-translate-blacklist"].value, "unsaved");
  assert.equal(h.directionUpdates, 1);
});
