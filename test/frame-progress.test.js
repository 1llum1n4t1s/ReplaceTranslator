"use strict";

// SW のフレーム横断進捗集約 (handleFrameProgress) と、右クリックメニュー文言の更新条件を検証する。
// 進捗は実 SW を _worker-harness で読み込み、content script 送信元として TRANSLATION_PROGRESS を送る。
// 中継 (relayProgress) は chrome.tabs.sendMessage として harness の partials に記録される。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const workerHarness = require("./_worker-harness");

const TAB = 1;
const frame = frameId => ({ id: "translation-test", url: "https://example.com/", tab: { id: TAB }, frameId });

const progressHarness = () => {
  const h = workerHarness({ initial: { provider: "openai", apiKeys: { openai: "test-key" } } });
  const A = h.context.Actions;
  const send = (frameId, state, extra = {}) => h.send({ action: A.TRANSLATION_PROGRESS, state, ...extra }, frame(frameId));
  // 中継済みメッセージの state (と partial) だけを取り出す。clear で次の区間だけを見られるようにする。
  const relayed = () => h.partials.filter(m => m.action === A.TRANSLATION_PROGRESS)
    .map(m => (m.state === "done" ? `done:${Boolean(m.partial)}` : m.state));
  const clear = () => { h.partials.length = 0; };
  const lastError = async () => (await h.send({ action: A.GET_STATE, tabId: TAB })).lastError;
  return { h, send, relayed, clear, lastError };
};

test("SPA遷移: 同じフレームの done(partial) 後の progress は新runとして前ルートの partial を持ち越さない", async () => {
  const p = progressHarness();
  await p.send(0, "progress");
  await p.send(0, "done", { partial: true });
  assert.deepEqual(p.relayed(), ["progress", "done:true"]);
  p.clear();
  // translator.js は announced 後に progress を送らないため、done 後の progress = startTranslate による新 run。
  await p.send(0, "progress");
  await p.send(0, "done");
  assert.deepEqual(p.relayed(), ["progress", "done:false"]);
});

test("SPA遷移: 新runに入ったフレームの partial だけを消し、他フレームの partial は残す", async () => {
  const p = progressHarness();
  await p.send(0, "progress");
  await p.send(5, "progress");
  await p.send(5, "done", { partial: true });
  await p.send(0, "done");
  assert.deepEqual(p.relayed(), ["progress", "done:true"]);
  p.clear();
  // トップフレームだけが SPA 遷移して新 run。新 run の進捗は中継し (loading 表示)、
  // iframe 5 の一部未訳は依然として事実なので done は partial のまま。
  await p.send(0, "progress");
  await p.send(0, "done");
  assert.deepEqual(p.relayed(), ["progress", "done:true"]);
  p.clear();
  // iframe 5 も新 run を完走すれば partial は解消する。
  await p.send(5, "progress");
  await p.send(5, "done");
  assert.deepEqual(p.relayed(), ["progress", "done:false"]);
});

test("SPA遷移: 前ルートの error 後でも、同じフレームの新runの progress / done を中継し直近エラーを消す", async () => {
  const p = progressHarness();
  await p.send(0, "progress");
  await p.send(0, "error", { detail: { error: "http", status: 401 } });
  assert.deepEqual(p.relayed(), ["progress", "error"]);
  assert.deepEqual(await p.lastError(), { error: "http", status: 401 });
  p.clear();
  await p.send(0, "progress");
  await p.send(0, "done");
  assert.deepEqual(p.relayed(), ["progress", "done:false"]);
  assert.equal(await p.lastError(), null);
});

test("error は他フレームの done / progress では解除されず、error 中の done も記録して解除後の未完扱いを防ぐ", async () => {
  const p = progressHarness();
  await p.send(0, "progress");
  await p.send(3, "progress");
  await p.send(0, "error", { detail: { error: "network" } });
  p.clear();
  // 別フレームの done / 未知 state / skipped は error を上書きしない (成功に見せない)。
  await p.send(3, "done");
  await p.send(3, "mystery");
  await p.send(0, "skipped");
  assert.deepEqual(p.relayed(), []);
  assert.deepEqual(await p.lastError(), { error: "network" });
  // error 元のフレームが新 run に入ると、他フレームが done 済みでも新 run の進捗を中継する (error 表示のまま固まらない)。
  // 完走すれば、error 中に done したフレーム 3 も完了済みとして全体 done になる (watchdog 待ちにならない)。
  await p.send(0, "progress");
  await p.send(0, "done");
  assert.deepEqual(p.relayed(), ["progress", "done:false"]);
});

test("done watchdog の猶予切れ partial は未完フレームに帰属し、そのフレームの新runで消える", async () => {
  const p = progressHarness();
  // harness の setTimeout は発火しないため、SW が登録した watchdog callback を捕まえて手動で発火する。
  const timers = [];
  p.h.context.setTimeout = fn => { timers.push(fn); return timers.length; };
  await p.send(0, "progress");
  await p.send(3, "progress");
  await p.send(0, "done");
  assert.equal(timers.length, 1);
  p.clear();
  timers.pop()();
  const fired = p.h.partials.at(-1);
  assert.equal(fired.state, "done");
  assert.equal(fired.partial, true);
  assert.deepEqual(fired.pendingFrames, [3]);
  p.clear();
  // 遅れて done したフレーム 3 の partial は従来どおり残す (猶予切れを一度通知した事実を消さない)。
  await p.send(3, "done");
  assert.deepEqual(p.relayed(), ["done:true"]);
  p.clear();
  // フレーム 3 が新 run を完走すれば、そのフレームに帰属した partial は消える。
  await p.send(3, "progress");
  await p.send(3, "done");
  assert.deepEqual(p.relayed(), ["progress", "done:false"]);
});

test("サブフレームの新runが done を出さずに無言終了しても、done watchdog で loading 張り付きを解く", async () => {
  const p = progressHarness();
  const timers = [];
  p.h.context.setTimeout = fn => { timers.push(fn); return timers.length; };
  await p.send(0, "progress");
  await p.send(4, "progress");
  await p.send(4, "done");
  await p.send(0, "done");
  assert.deepEqual(p.relayed(), ["progress", "done:false"]);
  p.clear();
  timers.length = 0; // 初回 run の途中 (frame 4 だけ done) で張られ、frame 0 の done で解除済みの watchdog を除く
  // iframe 4 が SPA 遷移して新 run に入る (loading を中継)。他フレームは全て done 済みなので watchdog を張る。
  await p.send(4, "progress");
  assert.deepEqual(p.relayed(), ["progress"]);
  assert.equal(timers.length, 1, "サブフレームの新 run の progress で watchdog を張る");
  // translator は startTranslate の progress の直後に初回 flush の progress も送る。同じ run の後続 progress でも
  // 解除したままにせず張り直す (直近に張られた watchdog が有効)。
  await p.send(4, "progress");
  assert.equal(timers.length, 2, "同じ run の後続 progress でも watchdog を張り直す");
  p.clear();
  // その run は done を出さずに無言終了した (再遷移でテキスト不足 / 同一言語)。猶予切れで未完フレーム付き done を中継する。
  timers.pop()();
  const fired = p.h.partials.at(-1);
  assert.equal(fired.state, "done");
  assert.equal(fired.partial, true);
  assert.deepEqual(fired.pendingFrames, [4]);
});

test("メインフレームの新runの progress では watchdog を張らない (遅い翻訳を partial と誤表示しない)", async () => {
  const p = progressHarness();
  const timers = [];
  p.h.context.setTimeout = fn => { timers.push(fn); return timers.length; };
  await p.send(0, "progress");
  await p.send(4, "progress");
  await p.send(4, "done");
  await p.send(0, "done");
  timers.length = 0; // 初回 run の途中 (frame 4 だけ done) で張られ、frame 0 の done で解除済みの watchdog を除く
  await p.send(0, "progress");
  assert.equal(timers.length, 0);
});

test("初回runの複数フレーム集約: progress 中の他フレームの progress では partial を消さない", async () => {
  const p = progressHarness();
  await p.send(0, "progress");
  await p.send(0, "done", { partial: true });
  // まだ done していないフレームの progress (初回 run の flush) は新 run ではない。
  await p.send(7, "progress");
  await p.send(7, "done");
  assert.deepEqual(p.relayed(), ["progress", "done:true", "done:true"]);
});

test("restored は全フレームの集約値を初期化する", async () => {
  const p = progressHarness();
  await p.send(0, "progress");
  await p.send(2, "error", { detail: { error: "no_api_key" } });
  await p.send(0, "restored");
  p.clear();
  await p.send(0, "progress");
  await p.send(0, "done");
  assert.deepEqual(p.relayed(), ["progress", "done:false"]);
  assert.equal(await p.lastError(), null);
});

// ---- 右クリックメニュー文言の更新条件 (T-D3) ----
// listener 登録ブロックだけを実ソースから切り出し、chrome.tabs のイベントを手で発火する。
const source = fs.readFileSync(path.join(__dirname, "../src/service_worker.js"), "utf8");
const menuListeners = () => {
  const start = source.search(/  if \(chrome\.tabs\) \{\r?\n    chrome\.tabs\.onActivated/);
  const end = source.indexOf("  // 割り当て可能なホットキー", start);
  assert.ok(start >= 0 && end > start, "メニュー更新 listener ブロックを取得できること");
  const listeners = {};
  const on = name => ({ addListener: fn => { listeners[name] = fn; } });
  const calls = { active: 0, direct: 0 };
  vm.runInNewContext(source.slice(start, end), {
    refreshActiveAutoTranslateSiteMenu: () => { calls.active++; },
    // event の tab で直接更新する旧経路は使わない (使われたら検知する)。
    refreshAutoTranslateSiteMenu: async () => { calls.direct++; },
    chrome: {
      tabs: { onActivated: on("activated"), onUpdated: on("updated") },
    },
  });
  return { listeners, calls };
};

test("右クリックメニュー: 背景タブの読み込み完了では全タブ共通の文言を更新しない", () => {
  const { listeners, calls } = menuListeners();
  listeners.updated(9, { status: "complete" }, { id: 9, active: false, url: "https://bg.example/" });
  listeners.updated(9, { url: "https://bg.example/next" }, { id: 9, active: false, url: "https://bg.example/next" });
  assert.deepEqual(calls, { active: 0, direct: 0 });
});

test("右クリックメニュー: アクティブタブの更新は最後にフォーカスされたウィンドウのアクティブタブで更新する", () => {
  const { listeners, calls } = menuListeners();
  listeners.updated(4, { status: "complete" }, { id: 4, active: true, url: "https://a.example/" });
  listeners.updated(4, { url: "https://a.example/b" }, { id: 4, active: true, url: "https://a.example/b" });
  // URL も読み込み完了も伴わない更新 (favicon 等) は無視する。
  listeners.updated(4, { favIconUrl: "x" }, { id: 4, active: true, url: "https://a.example/b" });
  assert.deepEqual(calls, { active: 2, direct: 0 });
});

test("右クリックメニュー: タブ切替でアクティブタブの文言へ合わせ直す", () => {
  const { listeners, calls } = menuListeners();
  listeners.activated({ tabId: 1, windowId: 1 });
  assert.deepEqual(calls, { active: 1, direct: 0 });
});
