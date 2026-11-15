"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { SettingsSchema, AutoTranslateBlacklist, Providers } = require("./_load-actions.js");

// keyWarning: true のときは updateKeyWarning を実ソースから切り出して使う (既定はスタブ)。
// プロバイダ別の操作可否 (MyMemory で言い換えを無効化する等) を実装どおりに確かめるため。
const startupHarness = ({ keyWarning = false } = {}) => {
  const popup = fs.readFileSync(path.join(__dirname, "../src/popup/popup.js"), "utf8");
  const controls = new Map();
  const requests = [];
  const timers = new Map();
  let nextTimer = 0;
  let directionUpdates = 0;
  const document = { activeElement: null, createElement: () => ({ textContent: "" }) };
  const navigator = {}; // クイック翻訳のコピー (navigator.clipboard) をテストごとに差し替える
  const window = { setTimeout: fn => { const id = ++nextTimer; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id) };
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
  const keyWarningSource = keyWarning
    ? popup.slice(popup.indexOf("  function updateKeyWarning()"), popup.indexOf("  function selectProvider("))
    : "";
  const api = vm.runInNewContext(`(() => {
    ${keyWarningSource}
    ${keys}
    ${common}
    ${quick}
    return { save, reflect, saveBlacklist, addCurrentSiteToBlacklist, bindKeyAutosave, setupQuickTranslate, bind() { ${listeners} }, start() { ${startup} } };
  })()`, { state, SettingsSchema, AutoTranslateBlacklist, Providers: { ids: ["openai", "xai"], get: id => Providers.get(id) },
    Actions: { APPLY_SETTINGS: "APPLY_SETTINGS", GET_STATE: "GET_STATE", TRANSLATE_BATCH: "TRANSLATE_BATCH" }, $: element,
    chrome: { runtime: { lastError: null, sendMessage: (message, callback) => requests.push({ message, callback }) } },
    getActiveTab: async () => ({ id: 1, url: "https://chatgpt.com/c/6aa436e4-b728-83ee-b1c1-c7d62b8379cb" }),
    document, navigator, window,
    msg: key => key, setStatus: () => {}, errorText: () => "error", renderProviderList: () => {},
    updateKeyWarning: () => {}, updateQtDir: () => { directionUpdates++; }, loadModels: () => {},
  });
  return { api, state, element, requests, document, navigator, timers, get directionUpdates() { return directionUpdates; },
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

test("ギャル文字の選択肢も日本語の翻訳先だけに表示し、保存値を保持する", () => {
  const h = startupHarness();
  h.state.settings = SettingsSchema.normalize({ targetLang: "ja", translationStyle: "gyaru" });
  h.api.reflect();
  assert.equal(h.element("style-gyaru").hidden, false);
  assert.equal(h.element("translation-style").value, "gyaru");
  h.state.settings.targetLang = "en";
  h.api.reflect();
  assert.equal(h.element("style-gyaru").hidden, true);
  assert.equal(h.element("style-gyaru").disabled, true);
  assert.equal(h.element("translation-style").value, "natural");
  assert.equal(h.state.settings.translationStyle, "gyaru");
});

test("言い換えモードは翻訳元/翻訳先/翻訳スタイルの欄を変えず、rewriteMode だけを保存する", () => {
  const h = startupHarness();
  h.api.bind();
  h.state.settings = SettingsSchema.normalize({ sourceLang: "en", targetLang: "fr", translationStyle: "formal" });
  h.api.reflect();
  assert.equal(h.element("rewrite-mode").checked, false);
  assert.equal(h.element("source").value, "en");
  assert.equal(h.element("target").value, "fr");
  assert.equal(h.element("translation-style").value, "formal");

  h.element("rewrite-mode").checked = true;
  h.element("rewrite-mode").listeners.change({ target: h.element("rewrite-mode") });
  // rewriteMode だけを保存し、翻訳元/翻訳先/翻訳スタイルの保存値・表示には触れない (言い換えは翻訳への追加処理)
  assert.deepEqual({ ...h.requests.at(-1).message.patch }, { rewriteMode: true });
  assert.equal(h.element("source").value, "en");
  assert.equal(h.element("target").value, "fr");
  assert.notEqual(h.element("source").disabled, true, "翻訳元は言い換え中も操作できる");
  assert.notEqual(h.element("target").disabled, true, "翻訳先は言い換え中も操作できる");
  assert.equal(h.element("translation-style").value, "formal");
  assert.equal(h.element("translation-style-row").classList.contains("hidden"), false);
  // 言い換えスタイル欄は ON のときだけ出す (翻訳スタイル欄と入れ替えず、両方を並べる)
  assert.equal(h.element("rewrite-style-row").classList.contains("hidden"), false);
  assert.equal(h.element("rewrite-style").value, "mild");

  h.element("rewrite-style").listeners.change({ target: { value: "toxic" } });
  assert.deepEqual({ ...h.requests.at(-1).message.patch }, { rewriteStyle: "toxic" }, "言い換えスタイルだけを保存する");

  // 言い換え ON の保存値でも、翻訳元/翻訳先は保存値どおりに表示する
  h.state.settings = SettingsSchema.normalize({ rewriteMode: true, rewriteStyle: "formal", sourceLang: "en", targetLang: "fr" });
  h.api.reflect();
  assert.equal(h.element("rewrite-mode").checked, true);
  assert.equal(h.element("source").value, "en");
  assert.equal(h.element("target").value, "fr");
  assert.equal(h.element("rewrite-style").value, "formal");

  h.element("rewrite-mode").checked = false;
  h.element("rewrite-mode").listeners.change({ target: h.element("rewrite-mode") });
  assert.deepEqual({ ...h.requests.at(-1).message.patch }, { rewriteMode: false });
  assert.equal(h.element("rewrite-style-row").classList.contains("hidden"), true, "OFF では言い換えスタイル欄を隠す");
});

test("言い換えスタイルの方言・ギャル文字は翻訳先が日本語のときだけ選べ、保存値は保持する", () => {
  const h = startupHarness();
  h.state.settings = SettingsSchema.normalize({ rewriteMode: true, rewriteStyle: "osaka", targetLang: "ja" });
  h.api.reflect();
  for (const style of SettingsSchema.JAPANESE_ONLY_STYLES) assert.equal(h.element(`rewrite-style-${style}`).hidden, false, style);
  assert.equal(h.element("rewrite-style").value, "osaka");
  h.state.settings.targetLang = "en";
  h.api.reflect();
  for (const style of SettingsSchema.JAPANESE_ONLY_STYLES) {
    assert.equal(h.element(`rewrite-style-${style}`).hidden, true, style);
    assert.equal(h.element(`rewrite-style-${style}`).disabled, true, style);
  }
  assert.equal(h.element("rewrite-style").value, "mild", "日本語以外の翻訳先では mild として表示する");
  assert.equal(h.state.settings.rewriteStyle, "osaka", "保存値は書き換えない");
});

test("popup には廃止した翻訳先の「自動判定」が無い", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "src/popup/popup.html"), "utf8");
  const js = fs.readFileSync(path.join(__dirname, "..", "src/popup/popup.js"), "utf8");
  assert.doesNotMatch(html, /id="target-rewrite-auto"/);
  assert.doesNotMatch(js, /"target-rewrite-auto"/);
});

test("MyMemory では言い換えをONにできず、同期で来たONは外す操作だけ許可する", () => {
  const h = startupHarness({ keyWarning: true });
  h.api.bind();
  // OFF の保存値: NMT はプロンプトを持たないので ON にさせない。
  h.state.settings = SettingsSchema.normalize({ provider: "mymemory", rewriteMode: false });
  h.api.reflect();
  assert.equal(h.element("rewrite-mode").disabled, true);
  assert.equal(h.element("rewrite-style").disabled, true);

  // 別PCから同期で来た ON: チェックを外す操作だけ許可する (スタイル選択は引き続き無効)。
  h.state.settings = SettingsSchema.normalize({ provider: "mymemory", rewriteMode: true });
  h.api.reflect();
  assert.equal(h.element("rewrite-mode").checked, true);
  assert.equal(h.element("rewrite-mode").disabled, false);
  assert.equal(h.element("rewrite-style").disabled, true);

  // OFF にすると再び無効へ戻り、もう ON にはできない。
  h.element("rewrite-mode").checked = false;
  h.element("rewrite-mode").listeners.change({ target: h.element("rewrite-mode") });
  assert.deepEqual({ ...h.requests.at(-1).message.patch }, { rewriteMode: false });
  assert.equal(h.element("rewrite-mode").disabled, true);
});

test("翻訳スタイルの保存失敗時、翻訳先が日本語以外なら方言の保存値を自然として表示する", async () => {
  const h = startupHarness();
  h.api.bind();
  h.state.settings = SettingsSchema.normalize({ targetLang: "en", translationStyle: "osaka" });
  h.api.reflect();
  assert.equal(h.element("translation-style").value, "natural");
  // 利用者が「かわいく」を選ぶが、保存が失敗する。
  h.element("translation-style").value = "cute";
  h.element("translation-style").listeners.change({ target: { value: "cute" } });
  assert.deepEqual({ ...h.requests.at(-1).message.patch }, { translationStyle: "cute" });
  h.requests.at(-1).callback({ ok: false });
  await Promise.resolve();
  // 保存値 (osaka) は保持しつつ、非表示・無効の方言 option ではなく自然を表示する。
  assert.equal(h.state.settings.translationStyle, "osaka");
  assert.equal(h.element("translation-style").value, "natural");
  assert.equal(h.element("style-osaka").hidden, true);

  // 翻訳先が日本語なら、方言の保存値をそのまま表示に戻す。
  h.state.settings = SettingsSchema.normalize({ targetLang: "ja", translationStyle: "osaka" });
  h.api.reflect();
  h.element("translation-style").value = "cute";
  h.element("translation-style").listeners.change({ target: { value: "cute" } });
  h.requests.at(-1).callback({ ok: false });
  await Promise.resolve();
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

test("popup は文言の置換を共通モジュールへ任せ、共有部品が参照する文書言語は変えず、翻訳元の自動判定も UI 言語で出す", () => {
  const popup = fs.readFileSync(path.join(__dirname, "../src/popup/popup.js"), "utf8");
  const i18n = popup.slice(popup.indexOf("  function applyI18n()"), popup.indexOf("  // ---- タブ ----"));
  const langs = popup.slice(popup.indexOf("  function option(value, label)"), popup.indexOf("  // ---- 翻訳タブ: サービス一覧 ----"));
  const messages = { langSourceAuto: "Detect language" };
  const calls = [];
  const document = {
    documentElement: { lang: "ja" },
    createElement: () => ({ value: "", textContent: "" }),
  };
  const api = vm.runInNewContext(`(() => { ${i18n}\n${langs}\nreturn { applyI18n, fillLangSelect }; })()`, {
    document, Localizer: { localizeDocument: () => calls.push("localizeDocument") },
    msg: (key, fallback) => messages[key] || fallback,
    Lang: { LANGUAGES: [{ code: "auto", native: "自動判定" }, { code: "ja", native: "日本語" }], targets: () => [{ code: "ja", native: "日本語" }] },
  });
  api.applyI18n();
  assert.deepEqual(calls, ["localizeDocument"], "data-i18n / data-i18n-attr の置換は Localizer.localizeDocument に一本化する");
  assert.equal(document.documentElement.lang, "ja", "applyI18n は <html lang> を書き換えない (文書言語は applyDocumentLang が先頭で確定する)");
  const options = [];
  api.fillLangSelect({ replaceChildren() {}, appendChild: (o) => options.push([o.value, o.textContent]) }, true);
  assert.deepEqual(options, [["auto", "Detect language"], ["ja", "日本語"]]);
});

// 選択バブルのコピー (content-dom.test.js) と同じ形: 失敗時は成功表示を出さず、古い完了・古いタイマーは新しい状態を変えない。
test("クイック翻訳のコピーは成功時だけ表示し、古い完了やタイマーは新しい状態を変更しない", async () => {
  const h = startupHarness();
  h.api.setupQuickTranslate();
  const btn = h.element("qt-copy"), output = h.element("qt-out"), input = h.element("qt-in");
  const copy = () => btn.listeners.click();
  output.textContent = "訳文";

  h.navigator.clipboard = { writeText() { throw new Error("denied"); } };
  await copy();
  assert.equal(btn.textContent, "qtCopy", "同期例外では成功表示しない");
  h.navigator.clipboard = { writeText: () => Promise.reject(new Error("denied")) };
  await copy();
  assert.equal(btn.textContent, "qtCopy", "reject では成功表示しない (未処理 reject も残さない)");
  delete h.navigator.clipboard;
  await copy();
  assert.equal(btn.textContent, "qtCopy", "clipboard 非対応では成功表示しない");

  // コピー待機中に訳文が描き直されたら、旧訳文のコピー完了は表示しない。
  let resolveOld;
  h.navigator.clipboard = { writeText: () => new Promise((resolve) => { resolveOld = resolve; }) };
  const old = copy();
  input.value = "next";
  input.listeners.keydown({ ctrlKey: true, key: "Enter", preventDefault() {} });
  await Promise.resolve();
  await Promise.resolve();
  h.requests.at(-1).callback({ ok: true, translations: ["新しい訳文"] });
  assert.equal(output.textContent, "新しい訳文");
  resolveOld();
  await old;
  assert.equal(btn.textContent, "qtCopy", "再翻訳前のコピー完了を無視する");

  // クリアも旧コピーの完了を無効化する。
  const beforeClear = copy();
  h.element("qt-clear").listeners.click();
  resolveOld();
  await beforeClear;
  assert.equal(btn.textContent, "qtCopy", "クリア前のコピー完了を表示しない");

  output.textContent = "訳文";
  const pending = [];
  h.navigator.clipboard = { writeText: () => new Promise((resolve) => { pending.push(resolve); }) };
  const first = copy();
  const second = copy();
  pending[0]();
  await first;
  assert.equal(btn.textContent, "qtCopy", "古いコピーの完了は新しい操作の完了を示さない");
  pending[1]();
  await second;
  assert.equal(btn.textContent, "qtCopied");
  assert.equal(btn.classList.contains("done"), true);

  h.navigator.clipboard = { writeText: () => Promise.resolve() };
  await copy();
  const oldTimer = [...h.timers.values()].at(-1);
  await copy();
  oldTimer();
  assert.equal(btn.textContent, "qtCopied", "前回のタイマーは新しいコピー表示を消さない");
  [...h.timers.values()].at(-1)();
  assert.equal(btn.textContent, "qtCopy");
  assert.equal(btn.classList.contains("done"), false);
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
