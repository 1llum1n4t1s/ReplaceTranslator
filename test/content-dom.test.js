"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const IMAGE_SOURCE = fs.readFileSync(path.join(ROOT, "src/content/image-translator.js"), "utf8") + "\n" + fs.readFileSync(path.join(ROOT, "src/content/image-renderer.js"), "utf8");
const FAB_SOURCE = fs.readFileSync(path.join(ROOT, "src/content/fab.js"), "utf8");
const TRANSLATOR_SOURCE = fs.readFileSync(path.join(ROOT, "src/content/translator.js"), "utf8");
const SELECTION_SOURCE = fs.readFileSync(path.join(ROOT, "src/content/selection-translator.js"), "utf8");
const WORKER_SOURCE = fs.readFileSync(path.join(ROOT, "src/service_worker.js"), "utf8");

// IIFE の content script は直接 import できないため、対象の関数宣言だけを実ソースから切り出して評価する。
// 切り出し規則は他のテストと共有する (test/_source.js の functionSource。失敗時は関数名付きで落ちる)。
const { functionSource } = require("./_source.js");

const loadImageFunctions = (names, context, prelude = "") => {
  const declarations = names.map((name) => functionSource(IMAGE_SOURCE, name)).join("\n");
  return vm.runInNewContext(`(() => { ${prelude}\n${declarations}\nreturn { ${names.join(", ")} }; })()`, context);
};

test("画像rendererの初回ロードを共有し、失敗後は再試行できる", async () => {
  let calls = 0, finish;
  const context = { chrome: { runtime: { sendMessage: () => { calls++; return new Promise(resolve => { finish = resolve; }); } } },
    createImageRenderer: () => ({ renderTranslated() {}, filterBlocks() {} }),
    isStaleImg() {}, unwrapImage() {}, stopFollow() {}, dbg() {}, contextAlive: () => true, dead: false };
  const api = loadImageFunctions(["loadRenderer"], context, 'let rendererPromise = null; const A = { LOAD_IMAGE_RENDERER: "load" };');
  const first = api.loadRenderer(), second = api.loadRenderer();
  assert.equal(first, second);
  assert.equal(calls, 1);
  finish({ ok: false });
  await assert.rejects(first, /renderer_load/);
  const retry = api.loadRenderer();
  assert.equal(calls, 2);
  finish({ ok: true });
  assert.equal(typeof (await retry).renderTranslated, "function");
});

test("画像renderer待機中の重複操作・復元・差替・旧contextはAPI送信を増やさない", async () => {
  for (const change of ["restore", "url", "context"]) {
    let finish, sends = 0, alive = true, restore;
    const img = { src: "https://example.com/a.png", isConnected: true };
    const api = loadImageFunctions(["translateImg", "isStaleImg"], {
      img, btn: null, dead: false, contextAlive: () => alive, shutdown() {},
      chrome: { runtime: { sendMessage() { sends++; } } },
      loadRenderer: () => new Promise(resolve => { finish = resolve; }),
      setRestore: fn => { restore = fn; },
    }, 'let imgRunId = 0, imageRequestSeq = 0; const imageRequestIds = new WeakMap(), inflightImgs = new WeakSet(), MAX_IMAGE_PIXELS = 25000000; const A = {}; const target = img; setRestore(() => { imgRunId++; });');
    const first = api.translateImg(img);
    await api.translateImg(img);
    if (change === "restore") {
      // 世代更新はclearAllImagesと同じ境界を通す。
      restore();
    } else if (change === "url") img.src = "https://example.com/b.png";
    else alive = false;
    finish({ filterBlocks() {}, renderTranslated() {} });
    await first;
    assert.equal(sends, 0, change);
  }
});

test("選択翻訳の初回注入は明示ackを使い、並行操作は最新だけ送る", async () => {
  let finish, injections = 0, translations = 0, pings = 0;
  const chrome = { tabs: { sendMessage: async (_tab, msg) => {
    if (msg.action === "ping") { pings++; return undefined; }
    if (msg.action === "css") return { cssReady: true };
    translations++;
  } }, scripting: {
    executeScript: () => { injections++; return new Promise(resolve => { finish = resolve; }); },
    insertCSS: async () => {},
  } };
  const trigger = vm.runInNewContext(`(() => {
    const selectionInjections = new Map();
    ${functionSource(WORKER_SOURCE, "triggerSelectionTranslate")}
    return triggerSelectionTranslate;
  })()`, { chrome, Actions: { PING_SELECTION_CS: "ping", TRANSLATE_SELECTION_CS: "translate", SELECTION_CSS_READY: "css" } });
  const first = trigger(1), second = trigger(1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(injections, 1);
  finish();
  await Promise.all([first, second]);
  assert.equal(pings, 2);
  assert.equal(translations, 1);
  chrome.tabs.sendMessage = async (_tab, msg) => msg.action === "ping" ? { selectionReady: true, cssReady: true } : translations++;
  await trigger(1);
  assert.equal(injections, 1);
  assert.equal(translations, 2);
});

test("選択翻訳は初回設定を待ち、最新選択だけ実行し復元・変更を捨てる", async () => {
  for (const cancel of ["latest", "changed", "restore", "context"]) {
    let finish, alive = true, sent = 0;
    const node = {};
    const selection = { anchorNode: node, focusNode: node, anchorOffset: 0, focusOffset: 4, text: "text" };
    const context = { deepSelection: () => selection, selText: sel => sel.text,
      contextAlive: () => alive, shutdown() {}, isEditableSelection: () => false,
      triggerInline: () => { sent++; }, Promise };
    const api = vm.runInNewContext(`(() => {
      let triggerSeq = 0, preparedSelection = { text: "text", nodes: [deepSelection().anchorNode, 0, deepSelection().focusNode, 4] }, dead = false, mode = "inline";
      const MAX_SEL_CHARS = 5000;
      const flagsReady = new Promise(resolve => { finish = resolve; });
      ${functionSource(SELECTION_SOURCE, "trigger")}
      return { trigger, ready: () => finish(), restore: () => { triggerSeq++; } };
    })()`, { ...context, finish });
    const first = api.trigger();
    assert.equal(sent, 0);
    let second;
    if (cancel === "latest") second = api.trigger();
    if (cancel === "changed") selection.text = "changed";
    if (cancel === "restore") api.restore();
    if (cancel === "context") alive = false;
    api.ready();
    await Promise.all([first, second]);
    assert.equal(sent, cancel === "latest" ? 1 : 0, cancel);
  }
});

test("選択注入待機中の復元は対象タブだけ無効化し、復元後の操作を受け付けてentryを解放する", async () => {
  for (const newRequest of [false, true]) {
    let finish;
    const sent = [];
    const chrome = { tabs: { sendMessage: async (tabId, msg) => {
      if (msg.action === "translate") sent.push(tabId);
      if (msg.action === "css") return { cssReady: true };
    } }, scripting: {
      executeScript: () => new Promise(resolve => { finish = resolve; }), insertCSS: async () => {},
    } };
    const api = vm.runInNewContext(`(() => {
      const selectionInjections = new Map(), pageSessions = new Map();
      ${functionSource(WORKER_SOURCE, "triggerSelectionTranslate")}
      ${functionSource(WORKER_SOURCE, "restorePage")}
      return { triggerSelectionTranslate, restorePage, size: () => selectionInjections.size };
    })()`, { chrome, Actions: { PING_SELECTION_CS: "ping", TRANSLATE_SELECTION_CS: "translate", SELECTION_CSS_READY: "css" },
      ensurePageSessions: async () => {}, bumpTabGen() {}, abortTab() {}, persistPageSessions() {}, resetFrameProgress() {}, relayProgress() {} });
    const first = api.triggerSelectionTranslate(1);
    await new Promise(resolve => setImmediate(resolve));
    await api.restorePage(2); // 他タブの復元では保留選択を中断しない。
    await api.restorePage(1);
    const second = newRequest ? api.triggerSelectionTranslate(1) : undefined;
    finish();
    await Promise.all([first, second]);
    assert.deepEqual(sent, newRequest ? [1] : []);
    assert.equal(api.size(), 0);
  }
});

test("選択翻訳は注入時・ping時の選択を保持し、CSS待機中の選択変更や消去を送らない", async () => {
  let sent = 0;
  const node = {};
  const selection = { text: "first", anchorNode: node, focusNode: node, anchorOffset: 0, focusOffset: 5 };
  const api = vm.runInNewContext(`(() => {
    let triggerSeq = 0, preparedSelection = null, dead = false, mode = "inline";
    const flagsReady = Promise.resolve(), MAX_SEL_CHARS = 5000;
    ${functionSource(SELECTION_SOURCE, "prepareSelection")}
    ${functionSource(SELECTION_SOURCE, "onPendingSelectionChange")}
    ${functionSource(SELECTION_SOURCE, "trigger")}
    return { prepareSelection, onPendingSelectionChange, trigger };
  })()`, { deepSelection: () => selection, selText: sel => sel.text, contextAlive: () => true,
    isEditableSelection: () => false, triggerInline: () => { sent++; } });
  for (const next of ["second", ""]) {
    selection.text = "first";
    api.prepareSelection(); // 初回評価またはping。
    selection.text = next;
    api.onPendingSelectionChange();
    selection.text = "first"; // 戻しても明示操作がなければ再開しない。
    await api.trigger();
    assert.equal(sent, 0);
  }
  selection.text = "second";
  api.prepareSelection(); // 待機中の後続の明示操作は現在の選択を採用。
  await api.trigger();
  assert.equal(sent, 1);
});

test("選択CSSだけの注入失敗は次回再試行し、成功後は重複挿入しない", async () => {
  let injected = false, styled = false, cssCalls = 0, jsCalls = 0, translations = 0;
  const chrome = { tabs: { sendMessage: async (_tab, msg) => {
    if (msg.action === "ping") return injected ? { selectionReady: true, cssReady: styled } : undefined;
    if (msg.action === "css") { styled = true; return { cssReady: true }; }
    if (msg.action === "translate") translations++;
  } }, scripting: {
    executeScript: async () => { injected = true; jsCalls++; },
    insertCSS: async () => { if (++cssCalls === 1) throw new Error("css_failure"); },
  } };
  const trigger = vm.runInNewContext(`(() => {
    const selectionInjections = new Map();
    ${functionSource(WORKER_SOURCE, "triggerSelectionTranslate")}
    return triggerSelectionTranslate;
  })()`, { chrome, Actions: { PING_SELECTION_CS: "ping", TRANSLATE_SELECTION_CS: "translate", SELECTION_CSS_READY: "css" } });
  await trigger(1);
  assert.equal(translations, 0);
  await trigger(1);
  await trigger(1);
  assert.equal(cssCalls, 2);
  assert.equal(jsCalls, 1);
  assert.equal(translations, 2);
});

test("画像ロード失敗の旧エラータイマーは再試行・復元・差替後のボタンを上書きしない", () => {
  for (const change of ["retry", "restore", "url", "context"]) {
    let timer, alive = true, restore;
    const img = { src: "https://example.com/a.png", isConnected: true };
    const btn = { textContent: "…", title: "" };
    const ids = new WeakMap();
    ids.set(img, 1);
    const api = loadImageFunctions(["showImageError", "isStaleImg"], {
      img, btn, imageRequestIds: ids, dead: false, contextAlive: () => alive,
      imgErrorText: () => "error", tr: (_key, fallback) => fallback,
      window: { setTimeout: fn => { timer = fn; } }, setRestore: fn => { restore = fn; },
    }, 'let imgRunId = 0; const target = img; const markTranslate = () => tr("imgMarkTranslate", "訳"); setRestore(() => { imgRunId++; });');
    api.showImageError(img, "renderer_load");
    if (change === "retry") ids.set(img, 2);
    if (change === "restore") restore();
    if (change === "url") img.src = "https://example.com/b.png";
    if (change === "context") alive = false;
    btn.textContent = "…";
    timer();
    assert.equal(btn.textContent, "…", change);
  }
});

test("renderer待機中の復元は同期で表示を戻し、復元・差替後のロード失敗は古いエラーを出さない", async () => {
  for (const change of ["restore", "url", "hidden"]) {
    let reject, errors = 0;
    const img = { src: "https://example.com/a.png", isConnected: true };
    const btn = { textContent: "…", title: "", style: { display: "block" } };
    const api = loadImageFunctions(["translateImg", "isStaleImg", "clearAllImages"], {
      img, btn, dead: false, contextAlive: () => true, shutdown() {},
      showImageError: () => { errors++; }, setBtnMode: () => { btn.textContent = "訳"; },
      loadRenderer: () => new Promise((_resolve, fail) => { reject = fail; }),
      // clearAllImages は open root を 1 回だけ列挙して queryOpenRoots へ渡すため、両方をスタブする。
      openRoots: () => [], queryOpenRoots: () => [], unwrapImage() {}, restorePrevStyle() {},
    }, `let imgRunId = 0, imageRequestSeq = 0; const target = img, imageRequestIds = new WeakMap(), inflightImgs = new WeakSet();
      const MAX_IMAGE_PIXELS = 25000000, showImageButton = ${change !== "hidden"}, imageCapable = true, animatedImgs = new WeakSet();`);
    const pending = api.translateImg(img);
    if (change === "restore" || change === "hidden") {
      api.clearAllImages();
      assert.equal(btn.textContent, "訳", "復元自体が同期で待機表示を消す");
    } else img.src = "https://example.com/b.png";
    reject(new Error("renderer_load"));
    await pending;
    assert.equal(errors, 0);
    if (change === "hidden") assert.equal(btn.style.display, "none");
    else assert.equal(btn.textContent, "訳");
  }
});

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
  const button = () => ({ textContent: "Copy", style: {}, classList: { add() {}, remove() {} } });
  let btn = button();
  api.open(btn);
  navigator.clipboard = { writeText() { throw new Error("denied"); } };
  await api.copy();
  assert.equal(btn.textContent, "Copy");
  navigator.clipboard = { writeText: () => Promise.reject(new Error("denied")) };
  await api.copy();
  assert.equal(btn.textContent, "Copy");
  delete navigator.clipboard;
  await api.copy();
  assert.equal(btn.textContent, "Copy");

  let resolveOld;
  navigator.clipboard = { writeText: () => new Promise((resolve) => { resolveOld = resolve; }) };
  const old = api.copy();
  api.setState("result", "新しい訳文");
  resolveOld();
  await old;
  assert.equal(btn.textContent, "Copy", "再翻訳前のコピー完了を無視する");

  const beforeClose = api.copy();
  api.removeBubble();
  btn = button();
  api.open(btn);
  resolveOld();
  await beforeClose;
  assert.equal(btn.textContent, "Copy", "閉じたバブルの完了は新バブルに影響しない");

  const pending = [];
  navigator.clipboard = { writeText: () => new Promise((resolve) => { pending.push(resolve); }) };
  const first = api.copy();
  const second = api.copy();
  pending[0]();
  await first;
  assert.equal(btn.textContent, "Copy", "古いコピーの完了は新しい操作の完了を示さない");
  pending[1]();
  await second;
  assert.equal(btn.textContent, "✓ Copied");

  navigator.clipboard = { writeText: () => Promise.resolve() };
  await api.copy();
  assert.equal(btn.textContent, "✓ Copied");
  const oldTimer = timers.at(-1);
  await api.copy();
  oldTimer();
  assert.equal(btn.textContent, "✓ Copied", "前回のタイマーは新しいコピー表示を消さない");
  timers.at(-1)();
  assert.equal(btn.textContent, "Copy");
});

test("ページ上限の未翻訳ノードは強参照せず、更新と復元後に再評価する", () => {
  const api = vm.runInNewContext(`(() => {
    const translatedNodes = new Set(), originalMap = new WeakMap(), writtenValue = new WeakMap();
    let budgetSkippedNodes = new WeakSet(), originalReapplyAt = new WeakMap(), recentScopeWrites = new WeakMap();
    let scopeConflictRetries = new WeakMap(), pendingScopeRetries = [], scopeRetryTimer = null;
    const translationMemo = new Map(), memoTexts = new Set(), queuedNodes = new WeakSet(), queue = [];
    const PAGE_MAX_SINGLE_CHARS = 10, PAGE_MAX_TEXTS = 1, PAGE_MAX_CHARS = 100;
    ${functionSource(TRANSLATOR_SOURCE, "clearScopeRetries")}
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

// ingest の文脈計算はメモに当たり得る原文 (memoTexts) と enqueue する分岐だけで行い、block ごとの snapshot を共有する。
const loadIngest = () => vm.runInNewContext(`(() => {
  const calls = { snapshot: 0, context: [], enqueue: [], apply: [], observe: [], promote: 0, flush: 0 };
  const translationMemo = new Map(), memoTexts = new Set(), translatedNodes = new Set(), queue = [];
  let observedBlocks = new WeakSet(), flushedBlocks = new WeakSet(), zeroSizedBlocks = new Set();
  const io = { observe: (block) => calls.observe.push(block) }, ro = null, ZEROSIZE_CAP = 10, rtDebug = false;
  const dbg = () => {};
  const isNmtProvider = () => false;
  const memoKey = (text, context) => text + "\\u0000" + context;
  function* collectNodes(root) { yield* root.nodes; }
  const blockAncestor = (node) => node.block;
  const blockMeta = (block) => block.meta;
  const blockContextSnapshot = () => { calls.snapshot++; return { before: "", after: "" }; };
  const translationContext = (node) => { calls.context.push(node.nodeValue); return "ctx:" + node.nodeValue; };
  const enqueue = (node, y, context) => calls.enqueue.push([node.nodeValue, y, context]);
  const applyOne = (item, memo) => calls.apply.push([item.text, item.context, memo]);
  const scopeWriteIsRecent = () => false, scheduleScopeRetry = () => {};
  const promoteSizedBlock = () => { calls.promote++; return false; };
  const scheduleFlush = () => { calls.flush++; };
  ${functionSource(TRANSLATOR_SOURCE, "ingest")}
  return { ingest, calls, translationMemo, memoTexts, memoKey,
    observe: (block) => observedBlocks.add(block), flushed: (block) => flushedBlocks.add(block) };
})()`);

test("ingest はメモに当たらない画面外ノードで文脈を計算せず、enqueue する分岐だけ block 単位の snapshot で計算する", () => {
  const api = loadIngest();
  const offscreen = { meta: { near: false, y: 900, zeroSized: false } };
  const watched = { meta: { near: false, y: 1800, zeroSized: false } };
  const near = { meta: { near: true, y: 10, zeroSized: false } };
  const flushed = { meta: { near: true, y: 20, zeroSized: false } };
  api.observe(watched);
  api.flushed(flushed);
  const nodes = [
    { nodeValue: "画面外1", block: offscreen }, { nodeValue: "画面外2", block: offscreen },
    { nodeValue: "監視中", block: watched },
    { nodeValue: "近傍1", block: near }, { nodeValue: "近傍2", block: near },
    { nodeValue: "流し済み", block: flushed },
  ];
  api.ingest({ nodes });
  assert.deepEqual([...api.calls.context], ["近傍1", "近傍2", "流し済み"], "画面外・監視中のノードでは文脈を計算しない");
  assert.equal(api.calls.snapshot, 2, "snapshot は文脈が要る block ごとに 1 回だけ");
  assert.deepEqual(Array.from(api.calls.enqueue, (entry) => [...entry]), [
    ["近傍1", 10, "ctx:近傍1"], ["近傍2", 10, "ctx:近傍2"], ["流し済み", 20, "ctx:流し済み"],
  ], "enqueue へは必ず計算済みの文字列文脈を渡す (enqueue 内蔵のノード単位フォールバックを使わない)");
  assert.deepEqual([...api.calls.observe], [offscreen]);
  assert.equal(api.calls.flush, 1);
});

test("ingest はメモ登録済みの原文だけ文脈を計算してメモを引き、外れたら同じ文脈で enqueue する", () => {
  const api = loadIngest();
  const watched = { meta: { near: false, y: 500, zeroSized: false } };
  const near = { meta: { near: true, y: 5, zeroSized: false } };
  api.observe(watched);
  api.memoTexts.add("Hello").add("Bank");
  api.translationMemo.set(api.memoKey("Hello", "ctx:Hello"), "こんにちは");
  api.translationMemo.set(api.memoKey("Bank", "ctx:other"), "銀行"); // 原文は同じでも文脈違い → メモ外れ
  api.ingest({ nodes: [
    { nodeValue: "Hello", block: watched }, // 監視中ブロックでもメモ一致は従来どおり同期適用する
    { nodeValue: "Bank", block: near },
    { nodeValue: "New", block: watched },
  ] });
  assert.deepEqual(Array.from(api.calls.apply, (entry) => [...entry]), [["Hello", "ctx:Hello", "こんにちは"]]);
  assert.deepEqual([...api.calls.context], ["Hello", "Bank"], "メモ照会で計算した文脈を enqueue で再計算しない");
  assert.deepEqual(Array.from(api.calls.enqueue, (entry) => [...entry]), [["Bank", 5, "ctx:Bank"]]);
  assert.equal(api.calls.snapshot, 2);
});

// 古い run の flush が await 中に新 run が始まっても、古い完了で flushing を下ろさない (T-D1)。
// 下ろすと新 run の 1.5 秒保険タイマー (maybeAnnounceDone) が、新 flush の走行中に done を通知してしまう。
const loadFlush = (translationBatch) => vm.runInNewContext(`(() => {
  const progress = [], sends = [];
  let flushTimer = null, flushing = false, translating = true, fatal = null, runId = 1, announced = false;
  let currentBatchSize = 0, warmupLeft = 0, droppedTransient = 0;
  const WARMUP_BATCH_SIZE = 1, INCOMPLETE_REQUEUE_MAX = 2, BatchTuner = { DEFAULT: 25 };
  const queue = [], translatedNodes = new Set(), queuedNodes = new Set(), translationMemo = new Map();
  const contextAlive = () => true, shutdown = () => {}, dbg = () => {}, isNmtProvider = () => false;
  const memoKey = (text, context) => text + "\\u0000" + context;
  const quotaScope = () => null, concurrencyFor = () => 1, scheduleFlush = () => {};
  const sortTopDown = () => {}, releaseBatchItem = () => {}, rememberTranslations = () => {};
  const markFailedTranslations = () => 0, batchMembers = (item) => item.members;
  const applyOne = (item, t) => { translatedNodes.add(item.node); item.node.nodeValue = t; };
  const applyTranslations = (batch, translations) => batch.forEach((group, i) => group.members.forEach((m) => applyOne(m, translations[i])));
  const groupBatchItems = (items) => items.map((item) => ({ text: item.text, context: item.context, members: [item] }));
  const notifyProgress = (state, extra) => progress.push(state);
  const sendBatchWithRetry = () => new Promise((resolve) => sends.push(resolve));
  ${functionSource(TRANSLATOR_SOURCE, "flush")}
  ${functionSource(TRANSLATOR_SOURCE, "maybeAnnounceDone")}
  const push = (text) => { const node = { nodeValue: text, isConnected: true }; queue.push({ node, text, context: "", _y: 0 }); };
  return {
    flush, maybeAnnounceDone, progress, sends, push,
    // startTranslate の run 切り替え (runId 更新と flushing / announced のリセット) と同じ状態遷移。
    newRun: () => { runId += 1; flushing = false; announced = false; return runId; },
    get flushing() { return flushing; },
  };
})()`, { TranslationBatch: translationBatch });

test("古い run の flush 完了は新 run の flushing を下ろさず、新 run の早すぎる done 通知を防ぐ", async () => {
  const { TranslationBatch } = require("./_load-actions.js");
  const api = loadFlush(TranslationBatch);
  api.push("old");
  const oldFlush = api.flush();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(api.sends.length, 1, "旧 run のバッチが送信待ち");

  const run2 = api.newRun();
  api.push("new");
  const newFlush = api.flush();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(api.sends.length, 2, "新 run のバッチも送信待ち");

  api.sends[0]({ ok: true, translations: ["旧"] }); // 旧 run の遅れた応答
  await oldFlush;
  assert.equal(api.flushing, true, "旧 flush の完了で新 flush の走行中フラグを下ろさない");
  api.maybeAnnounceDone(run2); // startTranslate の 1.5 秒保険タイマー
  assert.deepEqual([...api.progress].filter((state) => state === "done"), [], "新 flush の走行中に done を通知しない");

  api.sends[1]({ ok: true, translations: ["新"] });
  await newFlush;
  assert.equal(api.flushing, false);
  assert.deepEqual([...api.progress].filter((state) => state === "done"), ["done"], "新 flush の完了で 1 回だけ done");
});

test("flush はキー未設定の応答で全体中断し、done ではなく error を通知する", async () => {
  const { TranslationBatch } = require("./_load-actions.js");
  for (const error of ["no_api_key"]) {
    const api = loadFlush(TranslationBatch);
    api.push("text");
    const pending = api.flush();
    await new Promise((resolve) => setImmediate(resolve));
    api.sends[0]({ ok: false, error, translations: ["text"] }); // 訳文付きでも部分適用せず中断する
    await pending;
    assert.deepEqual([...api.progress].filter((state) => state !== "progress"), ["error"], error);
    assert.equal(api.flushing, false, error);
  }
});

test("ページ全体を包むcustom element内で一度だけ作り直された原文ノードは、クールダウン後に訳文へ戻す", () => {
  const api = vm.runInNewContext(`(() => {
    const clock = { t: 1000 }, timers = [];
    const Date = { now: () => clock.t };
    const window = { setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout: () => {} };
    const translatedNodes = new Set(), originalMap = new WeakMap(), writtenValue = new WeakMap();
    let recentScopeWrites = new WeakMap(), scopeConflictRetries = new WeakMap(), pendingScopeRetries = [], scopeRetryTimer = null;
    const translationMemo = new Map();
    const ORIGINAL_REAPPLY_COOLDOWN_MS = 1000, SCOPE_WRITE_MAX_TEXTS = 128;
    const SCOPE_CONFLICT_MAX_RETRIES = 3, SCOPE_RETRY_PENDING_MAX = 2000;
    let translating = true, runId = 1;
    const contextAlive = () => true, ingest = () => {};
    const memoKey = (text, context) => text + "\\u0000" + context;
    ${functionSource(TRANSLATOR_SOURCE, "rewriteScope")}
    ${functionSource(TRANSLATOR_SOURCE, "noteScopeWrite")}
    ${functionSource(TRANSLATOR_SOURCE, "scopeWriteIsRecent")}
    ${functionSource(TRANSLATOR_SOURCE, "scopeTextIsRecent")}
    ${functionSource(TRANSLATOR_SOURCE, "scopeRetryState")}
    ${functionSource(TRANSLATOR_SOURCE, "scheduleScopeRetry")}
    ${functionSource(TRANSLATOR_SOURCE, "armScopeRetryTimer")}
    ${functionSource(TRANSLATOR_SOURCE, "flushScopeRetries")}
    ${functionSource(TRANSLATOR_SOURCE, "applyOne")}
    // ingest のメモ一致経路と同じ判定 (競合中はページ側を優先し、再適用を予約する)。
    function ingestMemoHit(node) {
      const memo = translationMemo.get(memoKey(node.nodeValue, ""));
      if (scopeWriteIsRecent(node, node.nodeValue)) {
        translatedNodes.add(node);
        scheduleScopeRetry(node, node.nodeValue, "");
      } else applyOne({ node, text: node.nodeValue, context: "" }, memo);
    }
    function runTimers() { while (timers.length) timers.shift()(); }
    return { clock, translationMemo, applyOne, ingestMemoHit, runTimers, pending: () => pendingScopeRetries.length };
  })()`);
  const scope = { localName: "react-app", parentElement: null };
  const textNode = (value) => ({ nodeValue: value, parentElement: scope, isConnected: true });
  api.translationMemo.set("Hello\u0000", "こんにちは");

  const first = textNode("Hello");
  api.applyOne({ node: first, text: "Hello", context: "" }, "こんにちは");
  assert.equal(first.nodeValue, "こんにちは");

  // React が本文 subtree を一度だけ作り直し、同じ原文の新しい Text ノードが来る。
  const rerendered = textNode("Hello");
  api.clock.t += 100;
  api.ingestMemoHit(rerendered);
  assert.equal(rerendered.nodeValue, "Hello", "競合直後はページ側を優先して即時には書き換えない");
  api.clock.t += 1100;
  api.runTimers();
  assert.equal(rerendered.nodeValue, "こんにちは", "クールダウン後は作り直された原文ノードも訳文へ戻す");

  // 時間をおいた別の再描画で、同じ原文のノードが一度に複数作り直されても全て訳文へ戻す。
  api.clock.t += 5000;
  const firstWrite = textNode("Hello");
  api.applyOne({ node: firstWrite, text: "Hello", context: "" }, "こんにちは");
  const siblings = [textNode("Hello"), textNode("Hello"), textNode("Hello"), textNode("Hello")];
  api.clock.t += 50;
  for (const node of siblings) api.ingestMemoHit(node);
  api.clock.t += 1100;
  api.runTimers();
  assert.deepEqual(siblings.map((node) => node.nodeValue), ["こんにちは", "こんにちは", "こんにちは", "こんにちは"],
    "同じ再描画ラウンドの同一原文ノードは予算を1回分だけ使い、全て再適用する");

  // 訳文を書くたびに原文ノードを作り直し続けるコンポーネントは、再適用を上限回数で打ち切る。
  let current = rerendered;
  let writes = 0;
  for (let i = 0; i < 10; i++) {
    if (current.nodeValue !== "こんにちは") break; // ページは訳文を書かれたときだけ原文ノードを作り直す
    const recreated = textNode("Hello");
    api.clock.t += 10;
    api.ingestMemoHit(recreated);
    api.clock.t += 1100;
    api.runTimers();
    if (recreated.nodeValue === "こんにちは") writes++;
    current = recreated;
  }
  assert.ok(writes <= 3, `相互書き換えの再適用は上限内に収める (writes=${writes})`);
  assert.equal(current.nodeValue, "Hello", "上限到達後はページ側の原文で確定する");
  assert.equal(api.pending(), 0);
});

test("画像の旧エラー・空結果タイマーは、再翻訳の一部成功表示を上書きしない", async () => {
  for (const response of [{ ok: true, blocks: [] }, { ok: false, error: "parse" }, { ok: false, error: "output_truncated" }]) {
    const timers = [], state = { response, translated: false };
    const wrap = { querySelector: () => state.translated ? {} : null };
    const img = { src: "https://example.com/text.png", isConnected: true, closest: () => wrap };
    const btn = { textContent: "訳", title: "", classList: { toggle: () => {} } };
    const api = loadImageFunctions(["translateImg", "setBtnMode", "isTranslated", "isStaleImg", "imgErrorText"], {
      img, btn, chrome: { runtime: { sendMessage: (_msg, cb) => cb(state.response) } },
      window: { setTimeout: fn => timers.push(fn) }, tr: (key, fallback) => key === "imgPartial" ? "partial" : key === "imgMarkRevert" ? "原" : key === "imgMarkTranslate" ? "訳" : fallback,
      contextAlive: () => true, dbg: () => {}, debugEnabled: () => false, filterBlocks: blocks => blocks,
      renderTranslated: async () => { state.translated = true; },
      loadRenderer: async () => ({ filterBlocks: blocks => blocks, renderTranslated: async () => { state.translated = true; } }), dead: false,
    }, `let imgRunId = 0, imageRequestSeq = 0; const target = img, MAX_IMAGE_PIXELS = 25000000;
      const markTranslate = () => tr("imgMarkTranslate", "Tr"), markRevert = () => tr("imgMarkRevert", "Or");
      const imageRequestIds = new WeakMap(), inflightImgs = new WeakSet(), A = { TRANSLATE_IMAGE: "TRANSLATE_IMAGE" };`);
    await api.translateImg(img);
    assert.equal(timers.length, 1);
    state.response = { ok: true, partial: true, blocks: [{ translation: "訳文" }] };
    await api.translateImg(img);
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

test("行間の塗りつぶし判定は pixelBoxOf が塗る前に測った背景を再利用し、未計測のときだけ画素を読む", () => {
  let reads = 0;
  const api = loadImageFunctions(["blockPixelRect", "flatBoxOf"], {
    ringStats: () => { reads++; return { color: [1, 2, 3], std: 0, alpha: 1 }; },
  });
  const block = () => ({ translation: "訳文", box: { x: 0.1, y: 0.1, w: 0.5, h: 0.1 }, cy: 0.15 });
  const measured = Object.assign(block(), { __rtBackground: { color: [9, 9, 9], std: 0, alpha: 1 } });
  assert.deepEqual([...api.flatBoxOf({}, measured, 200, 200).color], [9, 9, 9]);
  const textured = Object.assign(block(), { __rtBackground: { color: [9, 9, 9], std: 40, alpha: 1 } });
  assert.equal(api.flatBoxOf({}, textured, 200, 200), null);
  const noResult = Object.assign(block(), { __rtBackground: null }); // 計測済みで結果なし
  assert.equal(api.flatBoxOf({}, noResult, 200, 200), null);
  assert.equal(reads, 0, "計測済み (null を含む) の block は画素を読み直さない");
  assert.deepEqual([...api.flatBoxOf({}, block(), 200, 200).color], [1, 2, 3]);
  assert.equal(reads, 1, "未計測の block だけ ringStats を呼ぶ");
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
  // open root の全 DOM 走査 (querySelectorAll("*")) は 3 段の後始末で共有し、root ごとに 1 回だけ行う。
  const walks = { document: 0, shadow: 0 };
  const shadowQuery = shadowRoot.querySelectorAll;
  shadowRoot.querySelectorAll = (selector) => { if (selector === "*") walks.shadow++; return shadowQuery(selector); };
  const document = { querySelectorAll: (selector) => { if (selector === "*") { walks.document++; return [host]; } return []; } };
  const restored = [];
  const { clearAllImages } = loadImageFunctions(
    ["openRoots", "queryOpenRoots", "clearAllImages"],
    { document, restored, btn: null },
    "let imgRunId = 0; const unwrapImage = (node) => restored.push(['wrap', node]); const restorePrevStyle = (node) => restored.push(['style', node]);",
  );

  clearAllImages();
  assert.equal(restored.length, 2);
  assert.equal(restored[0][0], "wrap");
  assert.equal(restored[0][1], wrapper);
  assert.equal(restored[1][0], "style");
  assert.equal(restored[1][1], styledImg);
  assert.equal(layer.removed, true);
  assert.deepEqual(walks, { document: 1, shadow: 1 });
});

test("SPA URL変化は新しいpage runとして自動再評価または手動再開始する", async () => {
  const routeHandler = functionSource(TRANSLATOR_SOURCE, "handleLocationChange");
  // startTranslate が新 run でページ上限カウンターと done 通知状態を初期化することは、
  // rewrite-mode.test.js の startTranslate 挙動テストで実関数を評価して確認する。

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

// 500 バイト超過 (too_long) の失敗 index と原文保持は persistent-cache.test.js の実 SW 経由テストで検証する。
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

test("画像ホバー: coversVideo は VIDEO / shadow host 以外では style を読まず、可視の動画だけを覆いとみなす", () => {
  let styleReads = 0;
  const styles = new Map();
  const view = { getComputedStyle: (node) => { styleReads += 1; return styles.get(node) || { visibility: "visible", opacity: "1" }; } };
  const doc = { defaultView: view };
  const el = (tagName, extra = {}) => ({ tagName, ownerDocument: doc, parentElement: null, getRootNode: () => ({ host: null }), ...extra });
  const api = vm.runInNewContext(`(() => {
    ${functionSource(IMAGE_SOURCE, "isShown")}
    ${functionSource(IMAGE_SOURCE, "coversVideo")}
    return { coversVideo };
  })()`);

  // 通常の要素 (動画でも shadow host でもない) は可視判定をせず false。
  assert.equal(api.coversVideo(el("DIV"), 1, 1), false);
  assert.equal(api.coversVideo(el("SPAN", { shadowRoot: null }), 1, 1), false);
  assert.equal(styleReads, 0, "対象外の要素では getComputedStyle を読まない");

  // 見えている動画は覆いとみなす。
  assert.equal(api.coversVideo(el("VIDEO"), 1, 1), true);
  // opacity 0 の祖先の下にある動画は透明レイヤーとして無視する (奥のサムネを生かす)。
  const wrapper = el("DIV");
  styles.set(wrapper, { visibility: "visible", opacity: "0" });
  assert.equal(api.coversVideo(el("VIDEO", { parentElement: wrapper }), 1, 1), false);

  // shadow host の内側に見えている動画があれば覆いとみなす (root の外の要素へは再帰しない)。
  const inner = el("VIDEO");
  const outside = el("VIDEO");
  const host = el("MY-PLAYER");
  host.shadowRoot = { elementsFromPoint: () => [inner, host, outside], contains: (n) => n === inner };
  assert.equal(api.coversVideo(host, 1, 1), true);
  const emptyHost = el("MY-CARD");
  emptyHost.shadowRoot = { elementsFromPoint: () => [emptyHost, outside], contains: () => false };
  assert.equal(api.coversVideo(emptyHost, 1, 1), false);
});

test("FAB: 自動翻訳の開始応答が除外対象・自動翻訳OFFなら loading を解除し、手動翻訳では解除しない", async () => {
  // 初回ページが除外対象、または自動翻訳OFFへの切替と競合すると translator から進捗が来ない。
  // send() の完了処理がその応答を正本に loading を解除しないと、FAB が loading のまま固まる (fab.js の send)。
  const makeFab = (response) => vm.runInNewContext(`(() => {
    const A = { TRANSLATE_PAGE: "TRANSLATE_PAGE" };
    let sendSeq = 0;
    let state = "loading", errText = "old", partialText = "old";
    let renders = 0;
    const render = () => { renders += 1; };
    const tr = (_k, fallback) => fallback;
    const contextAlive = () => true;
    const chrome = { runtime: { sendMessage: () => Promise.resolve(response) } };
    ${functionSource(FAB_SOURCE, "send")}
    return { send, snapshot: () => ({ state, errText, partialText, renders }) };
  })()`, { response });
  const settle = () => new Promise(resolve => setImmediate(resolve));

  for (const response of [{ ok: true, blacklisted: true }, { ok: true, autoTranslateDisabled: true }]) {
    const fab = makeFab(response);
    fab.send({ action: "TRANSLATE_PAGE" });
    await settle();
    assert.deepEqual({ ...fab.snapshot() }, { state: "off", errText: "", partialText: "", renders: 1 }, JSON.stringify(response));
  }
  // 通常の開始応答や、手動翻訳 (manual: true) の応答では状態を変えない (進捗は translator が送る)。
  for (const [msg, response] of [
    [{ action: "TRANSLATE_PAGE" }, { ok: true }],
    [{ action: "TRANSLATE_PAGE", manual: true }, { ok: true, blacklisted: true }],
  ]) {
    const fab = makeFab(response);
    fab.send(msg);
    await settle();
    assert.equal(fab.snapshot().state, "loading", JSON.stringify(msg));
    assert.equal(fab.snapshot().renders, 0);
  }
});
