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
  const state = { settings: SettingsSchema.normalize({}) };
  const element = id => {
    if (!controls.has(id)) controls.set(id, { value: "", checked: false, textContent: "", listeners: {},
      addEventListener(event, fn) { this.listeners[event] = fn; } });
    return controls.get(id);
  };
  const startup = popup.slice(popup.indexOf("    getActiveTab().then((tab) => {"),
    popup.indexOf('    document.querySelectorAll(".tab").forEach', popup.indexOf("  function init()")));
  const keys = popup.slice(popup.indexOf("  function reflectKeys()"), popup.indexOf("  // ---- 共通 ----"));
  const common = popup.slice(popup.indexOf("  function reflect()"), popup.indexOf("  async function getActiveTab"));
  const listeners = popup.slice(popup.indexOf('    $("sync-settings").addEventListener'),
    popup.indexOf("    // ショートカット変更:"));
  const api = vm.runInNewContext(`(() => {
    ${keys}
    ${common}
    return { save, reflect, saveBlacklist, bindKeyAutosave, bind() { ${listeners} }, start() { ${startup} } };
  })()`, { state, SettingsSchema, AutoTranslateBlacklist, Providers: { ids: ["openai", "xai"] },
    Actions: { APPLY_SETTINGS: "APPLY_SETTINGS", GET_STATE: "GET_STATE" }, $: element,
    chrome: { runtime: { lastError: null, sendMessage: (message, callback) => requests.push({ message, callback }) } },
    getActiveTab: async () => ({ id: 1 }), document: { activeElement: null },
    window: { setTimeout: () => 1, clearTimeout: () => {} },
    msg: key => key, setStatus: () => {}, errorText: () => "error", renderProviderList: () => {},
    updateKeyWarning: () => {}, updateQtDir: () => {}, loadModels: () => {},
  });
  return { api, state, element, requests };
};

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
test("除外リストの保存失敗を編集中のタブに表示し、再保存で回復する", async () => {
  const popup = fs.readFileSync(path.join(__dirname, "../src/popup/popup.js"), "utf8");
  const start = popup.indexOf("  let pendingSave =");
  const end = popup.indexOf("  async function getActiveTab", start);
  const input = { value: "example.com" };
  const label = { textContent: "" };
  let fail = true;
  const settings = SettingsSchema.normalize({});
  const api = vm.runInNewContext(`(() => {
    ${popup.slice(start, end)}
    return { saveBlacklist };
  })()`, {
    state: { settings }, SettingsSchema, AutoTranslateBlacklist, Actions: { APPLY_SETTINGS: "APPLY_SETTINGS" },
    $: id => id === "auto-translate-blacklist" ? input : label,
    document: { activeElement: input },
    msg: key => key, setStatus: () => {},
    chrome: { runtime: {
      lastError: null,
      sendMessage: (_message, callback) => callback({ ok: !fail, settings }),
    } },
  });
  await api.saveBlacklist();
  assert.equal(label.textContent, "settingsSaveFailed");
  assert.equal(input.value, "example.com");
  fail = false;
  await api.saveBlacklist();
  assert.equal(label.textContent, "blacklistSaved");
});

test("設定保存失敗時は変更した操作子だけを保存値へ戻す", async () => {
  const popup = fs.readFileSync(path.join(__dirname, "../src/popup/popup.js"), "utf8");
  const start = popup.indexOf("  let pendingSave =");
  const end = popup.indexOf("  async function getActiveTab", start);
  const controls = Object.fromEntries(["show-fab", "fab-opacity", "fab-opacity-val", "target",
    "sel-mode", "auto-translate-blacklist", "key-openai"].map(id => [id, { value: "unsaved", checked: true }]));
  const settings = SettingsSchema.normalize({});
  let directionUpdates = 0;
  const api = vm.runInNewContext(`(() => {
    ${popup.slice(start, end)}
    return { save };
  })()`, {
    state: { settings }, SettingsSchema, Actions: { APPLY_SETTINGS: "APPLY_SETTINGS" },
    $: id => controls[id], msg: key => key, setStatus: () => {},
    updateQtDir: () => { directionUpdates++; },
    chrome: { runtime: { lastError: null,
      sendMessage: (_message, callback) => callback({ ok: false, settings }),
    } },
  });
  assert.equal(await api.save({ showFab: true, fabOpacity: 0.5, targetLang: "en", selectionMode: "inline" }), false);
  assert.equal(controls["show-fab"].checked, false);
  assert.equal(controls["fab-opacity"].disabled, true);
  assert.equal(controls["fab-opacity"].value, "100");
  assert.equal(controls["fab-opacity-val"].textContent, "100%");
  assert.equal(controls.target.value, "ja");
  assert.equal(controls["sel-mode"].value, "bubble");
  assert.equal(controls["key-openai"].value, "unsaved");
  assert.equal(controls["auto-translate-blacklist"].value, "unsaved");
  assert.equal(directionUpdates, 1);
});
