"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const IMAGE_SOURCE = fs.readFileSync(path.join(ROOT, "src/content/image-translator.js"), "utf8");
const FAB_SOURCE = fs.readFileSync(path.join(ROOT, "src/content/fab.js"), "utf8");
const TRANSLATOR_SOURCE = fs.readFileSync(path.join(ROOT, "src/content/translator.js"), "utf8");
const WORKER_SOURCE = fs.readFileSync(path.join(ROOT, "src/service_worker.js"), "utf8");

// IIFE の content script は直接 import できないため、対象の関数宣言だけを実ソースから切り出して評価する。
// このテストで扱う関数には template literal が無く、文字列・コメント内の波括弧だけを読み飛ばせば安全に抽出できる。
const functionSource = (source, name) => {
  const match = new RegExp(`\\b(?:async\\s+)?function\\*?\\s+${name}\\s*\\(`).exec(source);
  if (!match) assert.fail(`${name} の宣言が必要`);
  const start = match.index;
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  let quote = "";
  let lineComment = false;
  let blockComment = false;
  for (let i = bodyStart; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (lineComment) { if (ch === "\n") lineComment = false; continue; }
    if (blockComment) { if (ch === "*" && next === "/") { blockComment = false; i++; } continue; }
    if (quote) {
      if (ch === "\\") { i++; continue; }
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === "/" && next === "/") { lineComment = true; i++; continue; }
    if (ch === "/" && next === "*") { blockComment = true; i++; continue; }
    if (ch === "\"" || ch === "'") { quote = ch; continue; }
    if (ch === "{") depth++;
    if (ch === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  assert.fail(`${name} の終端を解決できない`);
};

const loadImageFunctions = (names, context, prelude = "") => {
  const declarations = names.map((name) => functionSource(IMAGE_SOURCE, name)).join("\n");
  return vm.runInNewContext(`(() => { ${prelude}\n${declarations}\nreturn { ${names.join(", ")} }; })()`, context);
};

test("open root の画像をURLフォールバックで解決する", () => {
  const lightImg = {
    currentSrc: "https://example.com/shared.png",
    getBoundingClientRect: () => ({ top: 20, left: 20, bottom: 60, right: 60, width: 40, height: 40 }),
  };
  const shadowImg = {
    currentSrc: "https://example.com/shared.png",
    getBoundingClientRect: () => ({ top: 10, left: 10, bottom: 210, right: 310, width: 300, height: 200 }),
  };
  const shadowRoot = {
    querySelectorAll: (selector) => selector === "img" ? [shadowImg] : [],
  };
  const host = { shadowRoot };
  const document = {
    querySelectorAll: (selector) => selector === "*" ? [host] : selector === "img" ? [lightImg] : [],
  };
  const { openRoots, queryOpenRoots, findBySrcUrl } = loadImageFunctions(
    ["openRoots", "queryOpenRoots", "findBySrcUrl"],
    { document, window: { innerWidth: 1280, innerHeight: 720 } },
  );

  assert.deepEqual([...openRoots()], [document, shadowRoot]);
  assert.deepEqual([...queryOpenRoots("img")], [lightImg, shadowImg]);
  assert.equal(findBySrcUrl("https://example.com/shared.png"), shadowImg);
});

test("point hit-test がShadow Root内のオーバーレイ下の画像へ降りる", () => {
  const shadowImg = { tagName: "IMG", clientWidth: 320, clientHeight: 180, currentSrc: "https://example.com/image.png" };
  const shadowOverlay = { tagName: "A" };
  const shadowRoot = {
    contains: (node) => node === shadowOverlay || node === shadowImg,
    elementsFromPoint: () => [shadowOverlay, shadowImg],
  };
  const host = { tagName: "X-CARD", shadowRoot };
  const document = { elementsFromPoint: () => [host] };
  const { elementsFromPointDeep, imgAtPoint } = loadImageFunctions(
    ["elementsFromPointDeep", "imgAtPoint"],
    { document, Set },
    "let btn = null; const eligible = (el) => Boolean(el && el.tagName === 'IMG' && el.clientWidth >= 80 && el.clientHeight >= 60 && (el.currentSrc || el.src)); const coversVideo = () => false;",
  );

  assert.deepEqual([...elementsFromPointDeep(document, 10, 10)], [shadowOverlay, shadowImg, host]);
  assert.equal(imgAtPoint({ target: host, clientX: 10, clientY: 10, composedPath: () => [shadowOverlay, host] }), shadowImg);
  assert.equal(imgAtPoint({ target: host, clientX: 10, clientY: 10, composedPath: () => [shadowImg, host] }), shadowImg);
});

test("Shadow DOM内の画像オーバーレイもページ復元で除去する", () => {
  const wrapper = {};
  const styledImg = {};
  const layer = { removed: false, remove() { this.removed = true; } };
  const shadowRoot = {
    querySelectorAll(selector) {
      if (selector === ".__rt-img-wrap") return [wrapper];
      if (selector === "img[style*='100%']") return [styledImg];
      if (selector === ".__rt-img-layer") return [layer];
      return [];
    },
  };
  const host = { shadowRoot };
  const document = { querySelectorAll: (selector) => selector === "*" ? [host] : [] };
  const restored = [];
  const { clearAllImages } = loadImageFunctions(
    ["openRoots", "queryOpenRoots", "clearAllImages"],
    { document, restored },
    "let imgRunId = 0; const unwrapImage = (node) => restored.push(['wrap', node]); const restorePrevStyle = (node) => restored.push(['style', node]);",
  );

  clearAllImages();
  assert.equal(restored.length, 2);
  assert.equal(restored[0][0], "wrap");
  assert.equal(restored[0][1], wrapper);
  assert.equal(restored[1][0], "style");
  assert.equal(restored[1][1], styledImg);
  assert.equal(layer.removed, true);
});

test("遅延再走査の実装と設計契約が12秒まで一致する", () => {
  const translator = fs.readFileSync(path.join(ROOT, "src/content/translator.js"), "utf8");
  const architecture = fs.readFileSync(path.join(ROOT, "references/architecture.md"), "utf8");
  const match = /const REINGEST_DELAYS = \[([^\]]+)\]/.exec(translator);
  if (!match) assert.fail("REINGEST_DELAYS の宣言が必要");
  const delays = match[1].split(",").map((value) => Number(value.trim()));

  assert.deepEqual(delays, [350, 1200, 2500, 4500, 7500, 12000]);
  assert.match(architecture, /REINGEST_DELAYS=\[350,1200,2500,4500,7500,12000\]/);
});

test("SPA URL変化は新しいpage runとして自動再評価または手動再開始する", async () => {
  const routeHandler = functionSource(TRANSLATOR_SOURCE, "handleLocationChange");
  const startTranslate = functionSource(TRANSLATOR_SOURCE, "startTranslate");

  assert.match(FAB_SOURCE, /const AUTO_ROUTE_POLL_MS = 250/);
  assert.match(FAB_SOURCE, /send\(\{ action: A\.TRANSLATE_PAGE, routeChange: true \}\)/);
  assert.match(FAB_SOURCE, /flags && flags\.autoTranslate/);
  assert.match(FAB_SOURCE, /res\.blacklisted \|\| res\.autoTranslateDisabled/);
  assert.match(routeHandler, /if \(automatic && window\.top === window\.self\)[\s\S]*?translating = false;[\s\S]*?runId \+= 1;[\s\S]*?stopObservers\(\)/);
  assert.match(routeHandler, /if \(manualRun \|\| automatic\)[\s\S]*?startTranslate\(requestedSettings \|\| settings, sessionId, manualRun\)/);
  assert.match(startTranslate, /pageTextCount = 0;[\s\S]*?pageCharCount = 0;/);
  assert.match(startTranslate, /announced = false;[\s\S]*?droppedTransient = 0;/);

  const fabRoute = vm.runInNewContext(`(() => {
    const A = { TRANSLATE_PAGE: "TRANSLATE_PAGE" };
    const location = { href: "https://example.test/one" };
    const window = { clearInterval: () => {} };
    const sent = [];
    let autoRouteInterval = 1;
    let lastRouteHref = location.href;
    let lastFlags = { autoTranslate: true };
    let state = "on";
    let errText = "old error";
    let partialText = "old partial";
    let renders = 0;
    const contextAlive = () => true;
    const render = () => { renders += 1; };
    const send = (message) => { sent.push(message); };
    ${functionSource(FAB_SOURCE, "checkAutoRoute")}
    return {
      checkAutoRoute,
      navigate: (href) => { location.href = href; },
      setAuto: (enabled) => { lastFlags = { autoTranslate: enabled }; },
      snapshot: () => ({ sent, state, errText, partialText, renders }),
    };
  })()`);

  fabRoute.checkAutoRoute();
  assert.equal(fabRoute.snapshot().sent.length, 0);
  fabRoute.navigate("https://example.test/two");
  fabRoute.checkAutoRoute();
  assert.deepEqual(JSON.parse(JSON.stringify(fabRoute.snapshot())), {
    sent: [{ action: "TRANSLATE_PAGE", routeChange: true }],
    state: "loading",
    errText: "",
    partialText: "",
    renders: 1,
  });
  fabRoute.checkAutoRoute();
  assert.equal(fabRoute.snapshot().sent.length, 1, "同じURLをpollしても再送しない");
  fabRoute.setAuto(false);
  fabRoute.navigate("https://example.test/three");
  fabRoute.checkAutoRoute();
  assert.equal(fabRoute.snapshot().sent.length, 1, "自動翻訳OFFでは送らない");

  const translatorRoute = vm.runInNewContext(`(() => {
    const location = { href: "https://example.test/one" };
    const topWindow = {};
    const frameWindow = { top: topWindow };
    topWindow.top = topWindow;
    topWindow.self = topWindow;
    frameWindow.self = frameWindow;
    let window = topWindow;
    let lastHref = location.href;
    let settings = { autoTranslate: true };
    let requestedSettings = { sourceLang: "auto", targetLang: "ja" };
    let manualRun = false;
    let translating = true;
    let runId = 4;
    let sessionId = 9;
    let stopped = 0;
    let restored = 0;
    const starts = [];
    const stopObservers = () => { stopped += 1; };
    const restore = () => { restored += 1; };
    const shutdown = () => {};
    const startTranslate = (...args) => { starts.push(args); return Promise.resolve(); };
    ${routeHandler}
    return {
      handleLocationChange,
      navigate: (href) => { location.href = href; },
      setMode: (autoTranslate, manual) => {
        settings = { autoTranslate };
        manualRun = manual;
        translating = true;
        lastHref = location.href;
      },
      setTopFrame: (top) => { window = top ? topWindow : frameWindow; },
      snapshot: () => ({ translating, runId, stopped, restored, starts }),
    };
  })()`);

  translatorRoute.navigate("https://example.test/auto");
  assert.equal(translatorRoute.handleLocationChange(), true);
  assert.deepEqual(JSON.parse(JSON.stringify(translatorRoute.snapshot())), {
    translating: false, runId: 5, stopped: 1, restored: 0, starts: [],
  });
  translatorRoute.setMode(true, false);
  translatorRoute.setTopFrame(false);
  translatorRoute.navigate("https://example.test/iframe-auto");
  translatorRoute.handleLocationChange();
  assert.equal(translatorRoute.snapshot().starts.length, 1, "iframe内SPAは同じsessionで自動再開始する");
  assert.equal(translatorRoute.snapshot().starts[0][2], false);
  translatorRoute.setMode(false, true);
  translatorRoute.setTopFrame(true);
  translatorRoute.navigate("https://example.test/manual");
  translatorRoute.handleLocationChange();
  assert.equal(translatorRoute.snapshot().starts.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(translatorRoute.snapshot().starts[1])), [
    { sourceLang: "auto", targetLang: "ja" }, 9, true,
  ]);
  translatorRoute.setMode(false, false);
  translatorRoute.navigate("https://example.test/off");
  translatorRoute.handleLocationChange();
  assert.equal(translatorRoute.snapshot().restored, 1);

  const loadAutoGate = (autoTranslate, blacklisted) => vm.runInNewContext(`(() => {
    const settingsWriteChain = Promise.resolve();
    const getSettingsCached = async () => ({ autoTranslate, autoTranslateBlacklist: ["blocked.test"] });
    const chrome = { tabs: { get: async () => ({ url: "https://blocked.test/route" }) } };
    const AutoTranslateBlacklist = { matches: () => blacklisted };
    let restores = 0;
    const restorePage = async () => { restores += 1; };
    ${functionSource(WORKER_SOURCE, "translatePage")}
    return { translatePage, restores: () => restores };
  })()`, { autoTranslate, blacklisted });

  const disabledGate = loadAutoGate(false, false);
  assert.deepEqual(JSON.parse(JSON.stringify(await disabledGate.translatePage(1, false, true))), {
    ok: true, autoTranslateDisabled: true,
  });
  assert.equal(disabledGate.restores(), 0);

  const initialBlacklistGate = loadAutoGate(true, true);
  assert.deepEqual(JSON.parse(JSON.stringify(await initialBlacklistGate.translatePage(1, false, false))), {
    ok: true, blacklisted: true,
  });
  assert.equal(initialBlacklistGate.restores(), 0, "初回gateは既存の手動runを中断しない");

  const spaBlacklistGate = loadAutoGate(true, true);
  assert.deepEqual(JSON.parse(JSON.stringify(await spaBlacklistGate.translatePage(1, false, true))), {
    ok: true, blacklisted: true,
  });
  assert.equal(spaBlacklistGate.restores(), 1, "SPAで除外URLへ移ったときだけ旧runを復元する");
});

test("NMT部分失敗は明示された要素だけを未翻訳として数える", () => {
  const failedNode = { nodeValue: "too long" };
  const unchangedSuccessNode = { nodeValue: "proper noun" };
  const batch = [
    { node: failedNode, text: "too long" },
    { node: unchangedSuccessNode, text: "proper noun" },
  ];
  const { markFailedTranslations } = vm.runInNewContext(`(() => {
    let droppedTransient = 0;
    const translatedNodes = new Set(batch.map((item) => item.node));
    const batchMembers = (item) => item.members || [item];
    ${functionSource(TRANSLATOR_SOURCE, "markFailedTranslations")}
    return { markFailedTranslations };
  })()`, { batch, Set });

  assert.equal(markFailedTranslations(batch, [0]), 1);
  assert.equal(markFailedTranslations(batch, [99, "0"]), 0);
});

const loadTranslateEach = (fetchImpl) => vm.runInNewContext(`(() => {
  ${functionSource(WORKER_SOURCE, "translateEach")}
  return translateEach;
})()`, {
  TextEncoder,
  fetch: fetchImpl,
  withTimeout: (signal) => signal,
  ProviderApi: {
    buildRequest: (_providerId, { texts }) => ({ url: `https://example.test/?text=${encodeURIComponent(texts[0])}`, method: "GET", headers: {} }),
    parseResponse: (_providerId, json) => [json.translation],
  },
});

test("MyMemoryの500バイト超過は失敗indexを返して正常な無変更応答と区別する", async () => {
  const translateEach = loadTranslateEach(async (url) => ({
    ok: true,
    json: async () => ({ responseStatus: 200, translation: `訳:${new URL(url).searchParams.get("text")}` }),
  }));
  const long = "a".repeat(501);
  const result = await translateEach(
    { sourceLang: "en", targetLang: "ja" },
    { id: "mymemory", maxBytes: 500 },
    [long, "proper noun"],
    "",
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, "too_long");
  assert.deepEqual([...result.failedIndices], [0]);
  assert.deepEqual([...result.translations], [long, "訳:proper noun"]);
});

test("MyMemoryの途中quota失敗は成功分を保ち失敗indexだけを返す", async () => {
  const translateEach = loadTranslateEach(async (url) => {
    const text = new URL(url).searchParams.get("text");
    return {
      ok: true,
      json: async () => text === "quota"
        ? { responseStatus: 429, responseDetails: "limit" }
        : { responseStatus: 200, translation: `訳:${text}` },
    };
  });
  const result = await translateEach(
    { sourceLang: "en", targetLang: "ja" },
    { id: "mymemory", maxBytes: 500 },
    ["ok", "quota"],
    "",
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, "quota");
  assert.deepEqual([...result.failedIndices], [1]);
  assert.deepEqual([...result.translations], ["訳:ok", "quota"]);
});
