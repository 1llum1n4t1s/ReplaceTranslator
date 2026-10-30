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
const SELECTION_SOURCE = fs.readFileSync(path.join(ROOT, "src/content/selection-translator.js"), "utf8");
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

test("選択翻訳のコピーは成功時だけ表示し、古い完了やタイマーは新しい状態を変更しない", async () => {
  const timers = [];
  const navigator = {};
  const api = vm.runInNewContext(`(() => {
    let reqId = 0, bubble = null, textEl = null, copyBtn = null, copySeq = 0, selRaf = 0, posRaf = 0;
    const tr = (_key, fallback) => fallback;
    const detachListeners = () => {};
    const reposition = () => {};
    ${functionSource(SELECTION_SOURCE, "removeBubble")}
    ${functionSource(SELECTION_SOURCE, "setState")}
    ${functionSource(SELECTION_SOURCE, "onCopy")}
    return {
      open: (btn) => { copyBtn = btn; textEl = { textContent: "訳文" }; bubble = { classList: { add() {}, remove() {} }, remove() {} }; },
      copy: () => onCopy({ stopPropagation() {} }), setState, removeBubble,
    };
  })()`, { navigator, window: { setTimeout: (fn) => { timers.push(fn); return timers.length; } }, clearTimeout() {} });
  const button = () => ({ textContent: "コピー", style: {}, classList: { add() {}, remove() {} } });
  let btn = button();
  api.open(btn);
  navigator.clipboard = { writeText() { throw new Error("denied"); } };
  await api.copy();
  assert.equal(btn.textContent, "コピー");
  navigator.clipboard = { writeText: () => Promise.reject(new Error("denied")) };
  await api.copy();
  assert.equal(btn.textContent, "コピー");
  delete navigator.clipboard;
  await api.copy();
  assert.equal(btn.textContent, "コピー");

  let resolveOld;
  navigator.clipboard = { writeText: () => new Promise((resolve) => { resolveOld = resolve; }) };
  const old = api.copy();
  api.setState("result", "新しい訳文");
  resolveOld();
  await old;
  assert.equal(btn.textContent, "コピー", "再翻訳前のコピー完了を無視する");

  const beforeClose = api.copy();
  api.removeBubble();
  btn = button();
  api.open(btn);
  resolveOld();
  await beforeClose;
  assert.equal(btn.textContent, "コピー", "閉じたバブルの完了は新バブルに影響しない");

  const pending = [];
  navigator.clipboard = { writeText: () => new Promise((resolve) => { pending.push(resolve); }) };
  const first = api.copy();
  const second = api.copy();
  pending[0]();
  await first;
  assert.equal(btn.textContent, "コピー", "古いコピーの完了は新しい操作の完了を示さない");
  pending[1]();
  await second;
  assert.equal(btn.textContent, "✓ コピー");

  navigator.clipboard = { writeText: () => Promise.resolve() };
  await api.copy();
  assert.equal(btn.textContent, "✓ コピー");
  const oldTimer = timers.at(-1);
  await api.copy();
  oldTimer();
  assert.equal(btn.textContent, "✓ コピー", "前回のタイマーは新しいコピー表示を消さない");
  timers.at(-1)();
  assert.equal(btn.textContent, "コピー");
});

test("ページ上限の未翻訳ノードは強参照せず、更新と復元後に再評価する", () => {
  const api = vm.runInNewContext(`(() => {
    const translatedNodes = new Set(), originalMap = new WeakMap(), writtenValue = new WeakMap();
    let budgetSkippedNodes = new WeakSet(), originalReapplyAt = new WeakMap(), recentScopeWrites = new WeakMap();
    const translationMemo = new Map(), queuedNodes = new WeakSet(), queue = [];
    const PAGE_MAX_SINGLE_CHARS = 10, PAGE_MAX_TEXTS = 1, PAGE_MAX_CHARS = 100;
    let pageTextCount = 1, pageCharCount = 0, droppedTransient = 0, translating = true;
    const handleLocationChange = () => false;
    const blockAncestor = () => null, isNmtProvider = () => true;
    const ingest = (node) => enqueue(node, 0);
    ${functionSource(TRANSLATOR_SOURCE, "enqueue")}
    ${functionSource(TRANSLATOR_SOURCE, "onMutate")}
    ${functionSource(TRANSLATOR_SOURCE, "revertTranslations")}
    return { enqueue, onMutate, revertTranslations, translatedNodes, originalMap, writtenValue, queue,
      resetBudget: () => { pageTextCount = 0; }, count: () => droppedTransient };
  })()`);
  const skipped = { nodeValue: "原文", isConnected: false };
  const translated = { nodeValue: "訳文", isConnected: false };
  api.translatedNodes.add(translated);
  api.originalMap.set(translated, "元の文");
  api.writtenValue.set(translated, "訳文");
  api.enqueue(skipped, 0);
  api.enqueue(skipped, 0);
  assert.equal(api.count(), 1, "同じ上限超過ノードは重複計上しない");
  assert.equal(api.translatedNodes.has(skipped), false, "未翻訳ノードを復元用Setに保持しない");
  const otherSkipped = [{ nodeValue: "別の文" }, { nodeValue: "さらに別の文" }];
  for (const node of otherSkipped) api.enqueue(node, 0);
  assert.equal(api.count(), 3);
  assert.equal(api.translatedNodes.size, 1, "上限超過ノードが増えても復元用Setは増えない");
  api.resetBudget();
  skipped.nodeValue = "変更後";
  api.onMutate([{ type: "characterData", target: skipped }]);
  assert.equal(api.queue.length, 1, "文字更新後は再評価する");
  api.revertTranslations();
  assert.equal(translated.nodeValue, "元の文", "切断済みの翻訳ノードも復元する");
  const skippedAgain = { nodeValue: "長すぎる文章のテキストです" };
  api.enqueue(skippedAgain, 0);
  api.revertTranslations();
  skippedAgain.nodeValue = "短い";
  api.resetBudget();
  api.enqueue(skippedAgain, 0);
  assert.equal(api.queue.length, 2, "復元後はスキップ済み印を破棄する");
});

test("画像の旧エラー・空結果タイマーは、再翻訳の一部成功表示を上書きしない", async () => {
  for (const response of [{ ok: true, blocks: [] }, { ok: false, error: "parse" }, { ok: false, error: "output_truncated" }]) {
    const timers = [], state = { response, translated: false };
    const wrap = { querySelector: () => state.translated ? {} : null };
    const img = { src: "https://example.com/text.png", isConnected: true, closest: () => wrap };
    const btn = { textContent: "訳", title: "", classList: { toggle: () => {} } };
    const api = loadImageFunctions(["translateImg", "setBtnMode", "isTranslated", "isStaleImg", "imgErrorText"], {
      img, btn, chrome: { runtime: { sendMessage: (_msg, cb) => cb(state.response) } },
      window: { setTimeout: fn => timers.push(fn) }, tr: (key, fallback) => key === "imgPartial" ? "partial" : fallback,
      contextAlive: () => true, dbg: () => {}, debugEnabled: () => false, filterBlocks: blocks => blocks,
      renderTranslated: async () => { state.translated = true; },
    }, `let imgRunId = 0, imageRequestSeq = 0; const target = img, MAX_IMAGE_PIXELS = 25000000;
      const imageRequestIds = new WeakMap(), inflightImgs = new WeakSet(), A = { TRANSLATE_IMAGE: "TRANSLATE_IMAGE" };`);
    api.translateImg(img);
    assert.equal(timers.length, 1);
    state.response = { ok: true, partial: true, blocks: [{ translation: "訳文" }] };
    api.translateImg(img);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(btn.textContent, "原");
    assert.equal(btn.title, "partial");
    timers[0]();
    assert.equal(btn.textContent, "原");
    assert.equal(btn.title, "partial");
  }
});

test("画像のcover/contain座標はobject-positionとCSS pxのオフセットを反映する", () => {
  const api = loadImageFunctions(["objectPositionOffset", "fitDrawRect"], {});
  const top = api.fitDrawRect("cover", 200, 400, 200, 200, "50% 0%");
  assert.equal(top.dy, 0);
  const bottom = api.fitDrawRect("contain", 400, 200, 200, 200, "right bottom");
  assert.equal(bottom.dy, 100);
  assert.equal(api.objectPositionOffset("calc(100% - 10px)", -100, 2), -120);
});

const imageTextContext = () => ({
  font: "600 12px sans-serif", strokeText: () => {}, fillText: () => {},
  measureText(text) {
    const size = Number(this.font.match(/([\d.]+)px/)[1]);
    return { width: Array.from(text).length * size * 0.6, actualBoundingBoxAscent: size * 0.7, actualBoundingBoxDescent: size * 0.15 };
  },
});

test("画像の最小文字サイズは表示上12pxを保ち、改行と実際の文字面で中央を測る", () => {
  const api = loadImageFunctions(["wrapCanvasText", "canvasLineMetrics", "fitCanvasFont", "imageContentBounds",
    "blockPixelRect", "layoutInpaintText"], {}, 'const MIN_IMAGE_FONT_SIZE = 12, ABS_MAX = 40, CANVAS_FONT = "sans-serif"; let inpaintFit = null;');
  for (const scale of [0.5, 1, 2, 3]) {
    const ctx = imageTextContext();
    const blk = { translation: "短い訳文", box: { x: 0.2, y: 0.4, w: 0.3, h: 0.02 }, cy: 0.41 };
    const layout = api.layoutInpaintText(ctx, blk, 400 * scale, 200 * scale, 4 * scale, scale);
    assert.ok(layout.fontSize / scale >= 12);
    assert.ok(Math.abs(layout.cy - 82 * scale) < 0.01);
    const fit = api.fitCanvasFont(ctx, "one\ntwo", 400 * scale, 100 * scale, "sans-serif", 12 * scale, 12 * scale);
    assert.deepEqual(Array.from(fit.lines), ["one", "two"]);
  }
});

test("画像のインク位置と、原文を覆う消去領域を独立して保持する", () => {
  const ctx = { getImageData(x, y, w, h) {
    const data = new Uint8ClampedArray(w * h * 4).fill(255);
    for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
      if (x + px >= 24 && x + px < 56 && y + py >= 24 && y + py < 32) {
        const offset = (py * w + px) * 4; data[offset] = data[offset + 1] = data[offset + 2] = 0;
      }
    }
    return { data };
  } };
  const api = loadImageFunctions(["imageContentBounds", "snapToInk", "blockPixelRect", "pixelBoxOf"], {
    ringStats: () => ({ color: [255, 255, 255], std: 0, alpha: 1 }),
  }, "let inpaintFit = null;");
  const blk = { translation: "訳文", box: { x: 0.1, y: 0.1, w: 0.25, h: 0.1 }, cy: 0.15 };
  api.pixelBoxOf(ctx, blk, 200, 200);
  assert.equal(blk.__rtTextBox.x, 24);
  assert.equal(blk.__rtTextBox.h, 8);
  assert.equal(blk.__rtEraseBox.x, 20);
  assert.equal(blk.__rtEraseBox.w, 50);
});

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
