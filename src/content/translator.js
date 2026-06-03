"use strict";

/**
 * translator.js — ページ「インプレース置換翻訳」エンジン (content script)
 *
 * scripting.executeScript で actions.js / lang.js と共にオンデマンド注入される。
 * __rtTranslatorLoaded ガードで再注入されても初期化は 1 回 (リスナー重複なし)。
 *
 * Immersive Translate の拾い方を参考にしたビューポート優先翻訳:
 *   テキストノードを「ブロック要素」単位にまとめ、IntersectionObserver で
 *   ビューポート(+先読みマージン PREFETCH_MARGIN)に入ったブロックから順に翻訳する。
 *   → 画面外もスクロールに追従して確実に翻訳され、初期表示も速い。
 *   MutationObserver で動的追加 (無限スクロール / SPA) も取り込む。
 *
 * 失敗の局所化:
 *   1 バッチが 429/通信エラーでもページ全体を止めない。そのバッチだけ指数バックオフで
 *   リトライし、ダメなら飛ばして残りを続ける (以前は 1 バッチ失敗で全停止し、
 *   ページ下部が未翻訳のまま残っていた)。
 *
 * 要件 A(混在翻訳) は providers.js の system プロンプト側で担保。
 * クライアント側では数値/記号/URL/空白のみのノードを事前除外してトークンを節約する。
 */

(function () {
  if (window.__rtTranslatorLoaded) return;
  window.__rtTranslatorLoaded = true;

  const A = globalThis.Actions;

  // ---- 状態 ----
  const originalMap = new WeakMap();    // Node → 原文 (復元用)
  const translatedNodes = new Set();    // 翻訳/処理済みノード (再翻訳防止 + 復元走査用)
  let observedBlocks = new WeakSet();   // io.observe 済みのブロック要素
  let flushedBlocks = new WeakSet();    // 可視化して翻訳に回し終えたブロック (内部への動的追加は即取り込む)
  let observedShadowRoots = new WeakSet(); // MutationObserver で監視済みの shadow root (内部の動的更新も拾う)
  let lastHref = "";                    // SPA ナビゲーション検知用 (location.href の変化を見る)
  let translating = false;              // 翻訳 ON 状態
  let runId = 0;                        // 翻訳セッション ID (復元/再開で中断判定)
  let settings = null;
  let io = null;                        // IntersectionObserver (ビューポート優先)
  let mo = null;                        // MutationObserver (動的追加)
  let flushTimer = null;
  let flushing = false;                 // flush 走行中フラグ (同時多発を直列化して 429 を抑える)
  let firstFlush = true;                // 初回 flush は即時(最初の訳を早く出す)、以降デバウンス
  let announced = false;                // 初回 done 通知済みか (以降のスクロール翻訳では戻さない)
  let fatal = null;                     // 致命的エラー (no_api_key) で全体中断
  let currentBatchSize = 0;
  const queue = [];                     // 翻訳待ち {node, text}

  // ビューポートの先読みマージン。見えている所＋上下これだけ先まで翻訳しておく。
  const PREFETCH_MARGIN = "1200px";
  // 同時に投げるバッチ数 (高速化の主因。Immersive 同様に複数リクエストを並列処理)
  const CONCURRENCY = 10;
  // 1 バッチの一時エラー時の最大リトライ回数 (指数バックオフ)
  const MAX_RETRY = 2;

  // 同時に投げるバッチ数。バッチ非対応プロバイダ (MyMemory = 1件/req・無料枠が小さい) のときは
  // バッチを直列(1)にして攻めすぎを防ぎ、実効同時リクエスト数は background の translateEach 側
  // (= 5 並列) だけで決まるようにする。LLM 系はそのまま CONCURRENCY 並列。
  function concurrencyFor() {
    const p = globalThis.Providers && settings && Providers.get(settings.provider);
    return (p && p.batch === false) ? 1 : CONCURRENCY;
  }

  // インライン要素。テキストノードからブロック祖先を求めるとき、これらは透過して上に辿る。
  const INLINE_TAGS = new Set([
    "A", "ABBR", "B", "BDI", "BDO", "CITE", "CODE", "DATA", "DFN", "EM", "I",
    "KBD", "LABEL", "MARK", "Q", "RP", "RT", "RUBY", "S", "SAMP", "SMALL",
    "SPAN", "STRONG", "SUB", "SUP", "TIME", "U", "VAR", "WBR", "FONT", "INS", "DEL",
  ]);

  // ---- 対象判定 ----
  // 親要素がこれらなら翻訳しない (Immersive Translate の excludeTags / stayOriginalTags を参考)。
  const SKIP_PARENT_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "CODE", "PRE", "KBD", "SAMP", "VAR", "TT",
  ]);
  // 祖先のどこかにこれらがあれば subtree ごと翻訳しない (コード/数式/編集中/明示的な翻訳除外)。
  const SKIP_CLOSEST = "pre, code, kbd, samp, svg, math, [translate=no], .notranslate";

  function shouldTranslateText(s) {
    if (!s) return false;
    const t = s.trim();
    if (t.length <= 1) return false;              // 空 / 1 文字 (箇条点・単独記号・単独文字) はスキップ
    if (!/[\p{L}]/u.test(t)) return false;        // 文字(Letter)を含まない = 数値/記号のみ
    if (/^https?:\/\/\S+$/i.test(t)) return false; // URL 単体
    return true;
  }

  function accept(node) {
    if (translatedNodes.has(node)) return false;
    const p = node.parentNode;
    if (!p || p.nodeType !== 1) return false;
    if (SKIP_PARENT_TAGS.has(p.nodeName)) return false;
    if (p.isContentEditable) return false;
    if (!shouldTranslateText(node.nodeValue)) return false;
    // 残った候補だけ closest で subtree 除外を確認する (走査全体のコストを抑える)
    if (typeof p.closest === "function" && p.closest(SKIP_CLOSEST)) return false;
    return true;
  }

  // テキストノードを監視すべきブロック要素 (インライン親は透過して上へ辿る)
  function blockAncestor(node) {
    let el = node.parentElement;
    while (el && el.parentElement && el !== document.body && INLINE_TAGS.has(el.nodeName)) {
      el = el.parentElement;
    }
    return el || document.body;
  }

  // root 配下の翻訳対象テキストノードを集める。
  // TreeWalker は Shadow DOM を貫通しないので、開いた shadowRoot を辿る DFS で実装する
  // (Immersive 同様に Web コンポーネント内のテキストも翻訳対象にする)。子は document 順で積む。
  function collectNodes(root) {
    const out = [];
    if (!root) return out;
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      const t = node.nodeType;
      if (t === 3) { if (accept(node)) out.push(node); continue; }       // テキスト
      if (t !== 1 && t !== 11) continue;                                  // 要素 or DocumentFragment(shadowRoot)
      if (t === 1 && node.shadowRoot) {                                   // 開いた shadow DOM を辿る
        stack.push(node.shadowRoot);
        // shadow root 内部の動的更新も拾えるよう MutationObserver に登録する (翻訳中のみ)
        if (mo && !observedShadowRoots.has(node.shadowRoot)) {
          observedShadowRoots.add(node.shadowRoot);
          mo.observe(node.shadowRoot, { childList: true, subtree: true, characterData: false });
        }
      }
      const kids = node.childNodes;
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);     // 逆順 push で pop 時に document 順
    }
    return out;
  }

  // root 配下を翻訳対象に取り込む:
  //   未監視ブロック → IntersectionObserver に登録 (可視化されたら翻訳)
  //   可視化済みブロック内への追加 → 即キュー (動的追加の追従)
  function ingest(root) {
    if (!io) return;
    const newBlocks = new Set();
    let immediate = false;
    for (const node of collectNodes(root)) {
      const block = blockAncestor(node);
      if (flushedBlocks.has(block)) { enqueue(node); immediate = true; }
      else if (!observedBlocks.has(block)) newBlocks.add(block);
    }
    for (const block of newBlocks) { observedBlocks.add(block); io.observe(block); }
    if (immediate) scheduleFlush();
  }

  function enqueue(node) {
    if (accept(node)) queue.push({ node, text: node.nodeValue });
  }

  // 拡張 context が生きているか (リロード/更新後に置き去りになった古いスクリプトかの判定)。
  // 失効すると chrome.runtime.id が undefined になり、chrome API 呼び出しは例外を投げる。
  function contextAlive() {
    try { return Boolean(chrome.runtime && chrome.runtime.id); } catch (_e) { return false; }
  }
  // context 失効時などに翻訳を止め、observer/timer を後始末してこれ以上 chrome API を叩かないようにする。
  function shutdown() {
    translating = false;
    runId += 1; // 進行中ループを中断
    try { stopObservers(); } catch (_e) { /* noop */ }
  }

  // ---- background への翻訳依頼 ----
  function sendBatch(texts) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ action: A.TRANSLATE_BATCH, texts, settings }, (res) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: "runtime", message: chrome.runtime.lastError.message });
            return;
          }
          resolve(res || { ok: false, error: "empty" });
        });
      } catch (_e) {
        // 拡張のリロード/更新で context が失効 (Extension context invalidated)。静かに停止する。
        shutdown();
        resolve({ ok: false, error: "context" });
      }
    });
  }

  function sleep(ms) { return new Promise((r) => window.setTimeout(r, ms)); }

  // 一時エラー (429 / 通信 / 5xx) は指数バックオフでリトライ。致命的/恒久エラーはそのまま返す。
  async function sendBatchWithRetry(texts, myRun) {
    for (let attempt = 0; ; attempt++) {
      if (myRun !== runId) return { ok: false, error: "aborted" };
      const res = await sendBatch(texts);
      if (res && res.ok) return res;
      const e = res && res.error;
      // MyMemory 等の NMT は無料枠で 429 を即返す。429 を数百ms 後にリトライしても解けず、
      // 指数バックオフ分(約2秒/バッチ)を丸ごと無駄にするだけなので、NMT の 429 は即諦める。
      const p = globalThis.Providers && settings && Providers.get(settings.provider);
      const isNmt = Boolean(p && p.batch === false);
      const transient = e === "network" || e === "runtime" ||
        (e === "http" && res.status >= 500) ||
        (e === "http" && res.status === 429 && !isNmt);
      if (transient && attempt < MAX_RETRY) {
        if (res.status === 429) currentBatchSize = Math.max(5, Math.floor((currentBatchSize || 25) / 2));
        await sleep(700 * (attempt + 1));
        continue;
      }
      return res || { ok: false, error: "empty" };
    }
  }

  // 訳文を適用 (原文を保持しつつ in-place 置換)
  function applyTranslations(batch, translations) {
    for (let i = 0; i < batch.length; i++) {
      const item = batch[i];
      const t = translations[i];
      translatedNodes.add(item.node);
      // ノードが現在も同じ原文を保持している場合のみ書き換える (動的書き換え競合の防御)
      if (typeof t === "string" && t.length > 0 && t !== item.text && item.node.nodeValue === item.text) {
        if (!originalMap.has(item.node)) originalMap.set(item.node, item.text);
        item.node.nodeValue = t;
      }
    }
  }

  // 翻訳の優先順位を「ページ上から下」にする: 各アイテムの絶対Y位置で昇順ソートする。
  // rect 読みは applyTranslations の書き込みより前に一括で行うので reflow は1回で済む。
  function sortTopDown(items) {
    const sy = window.scrollY || window.pageYOffset || 0;
    for (const it of items) {
      const el = it.block || (it.node && it.node.parentElement);
      let y = 0;
      try { if (el) y = el.getBoundingClientRect().top + sy; } catch (_e) { y = 0; }
      it._y = y;
    }
    items.sort((a, b) => a._y - b._y);
  }

  // ---- バッチ翻訳 (キューを上→下順にワーカープールで捌く。同時 flush は1本に直列化) ----
  async function flush() {
    flushTimer = null;
    // 走行中の多重 flush を抑止。これで瞬間的な同時リクエストが concurrencyFor() に収まり、
    // 429 が激減 → BatchTuner が小さい値に張り付かず育つ (体感速度の核心)。
    if (flushing || !translating || fatal) return;
    if (!contextAlive()) { shutdown(); return; }
    flushing = true;
    const myRun = runId;
    if (!currentBatchSize) currentBatchSize = (globalThis.BatchTuner && BatchTuner.DEFAULT) || 25;

    // この時点の queue をスナップショット: 重複と陳腐化 (切断/書換済/翻訳済) を除き、上→下にソート
    const seen = new Set();
    const pending = [];
    for (const x of queue.splice(0, queue.length)) {
      if (seen.has(x.node)) continue;
      if (x.node.isConnected && x.node.nodeValue === x.text && !translatedNodes.has(x.node)) {
        seen.add(x.node); pending.push(x);
      }
    }
    if (pending.length === 0) { flushing = false; maybeAnnounceDone(myRun); return; }
    sortTopDown(pending);
    if (!announced) notifyProgress("progress");

    // 共有カーソルから「その時点の currentBatchSize」個ずつ取り出す。
    // → BatchTuner が育てたサイズが同一 flush 内のあとのバッチにも即反映される (旧: flush 開始時のサイズで固定)。
    let cursor = 0;
    async function worker() {
      while (cursor < pending.length) {
        if (myRun !== runId || fatal || !translating) return;
        const size = Math.max(1, currentBatchSize);
        const batch = pending.slice(cursor, cursor + size);
        cursor += batch.length;
        const res = await sendBatchWithRetry(batch.map((b) => b.text), myRun);
        if (myRun !== runId) return;
        if (res && res.ok && Array.isArray(res.translations)) {
          applyTranslations(batch, res.translations);
          if (res.nextBatchSize) currentBatchSize = res.nextBatchSize; // 自動学習を反映
        } else if (res && res.error === "no_api_key") {
          fatal = res; // キーが無ければ何も訳せない → 全体中断
          return;
        } else if (res && Array.isArray(res.translations)) {
          // 一時エラーでも部分的に成功した訳文は適用する (MyMemory は 1 件の 429/通信失敗で
          // バッチ全体が ok:false になるが成功分は translations に入る)。失敗分は原文のままなので
          // applyTranslations が書き換えをスキップし、全ノードは処理済み化されて再翻訳ループも防ぐ。
          applyTranslations(batch, res.translations);
        } else {
          // 訳文を伴わない一時エラーで諦めたバッチは、再翻訳ループを防ぐため処理済み扱いで飛ばし、残りは続ける
          for (const b of batch) translatedNodes.add(b.node);
        }
      }
    }
    await Promise.all(Array.from({ length: concurrencyFor() }, worker));
    flushing = false;
    if (fatal && myRun === runId) { notifyProgress("error", { detail: fatal }); return; }
    // 走行中に新規追加された分があれば次サイクルで処理
    if (myRun === runId && translating && queue.length > 0) { scheduleFlush(); return; }
    maybeAnnounceDone(myRun);
  }

  function scheduleFlush() {
    if (flushTimer || flushing || !translating) return;
    const delay = firstFlush ? 0 : 200; // 初回は即時(最初の訳を早く出す)、以降は 200ms デバウンス
    firstFlush = false;
    flushTimer = window.setTimeout(flush, delay);
  }

  // 処理中バッチが無くキューも空なら、初回だけ done を通知 (以降のスクロール翻訳は ON のまま)
  function maybeAnnounceDone(myRun) {
    if (myRun !== runId || !translating || announced) return;
    if (!flushing && queue.length === 0 && !flushTimer) {
      announced = true;
      notifyProgress("done");
    }
  }

  function notifyProgress(state, extra) {
    try {
      chrome.runtime.sendMessage(Object.assign({ action: A.TRANSLATION_PROGRESS, state }, extra || {}));
    } catch (_e) { /* 受信側が無ければ無視 */ }
  }

  // ---- IntersectionObserver: ビューポート(+先読み)に入ったブロックを翻訳 ----
  function onIntersect(entries) {
    if (!translating) return;
    let added = false;
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const block = entry.target;
      io.unobserve(block);        // 一度可視になったら監視解除 (翻訳は一度きり)
      flushedBlocks.add(block);
      for (const node of collectNodes(block)) { enqueue(node); added = true; }
    }
    if (added) scheduleFlush();
  }

  // ---- MutationObserver: 動的追加 (無限スクロール / SPA) を取り込む ----
  function onMutate(mutations) {
    if (!translating) return;
    if (location.href !== lastHref) {   // SPA ナビゲーション(pushState 等)で URL が変わった → 新ページを取り込み直す
      lastHref = location.href;
      scheduleReingest();
      return;
    }
    for (const m of mutations) {
      for (const node of m.addedNodes) ingest(node);
    }
  }

  // SPA 遷移後はコンテンツが段階的に差し変わるので、少し待ってから全体を取り込み直す (2 回)
  function scheduleReingest() {
    for (const delay of [350, 1200]) {
      window.setTimeout(() => {
        if (translating && contextAlive()) ingest(document.body || document.documentElement);
      }, delay);
    }
  }
  function onPopState() {
    if (translating && location.href !== lastHref) { lastHref = location.href; scheduleReingest(); }
  }

  function startObservers() {
    if (!io) {
      io = new IntersectionObserver(onIntersect, { root: null, rootMargin: `${PREFETCH_MARGIN} 0px`, threshold: 0 });
    }
    if (!mo) {
      mo = new MutationObserver(onMutate);
      mo.observe(document.body || document.documentElement, { childList: true, subtree: true, characterData: false });
    }
    lastHref = location.href;
    window.removeEventListener("popstate", onPopState);
    window.addEventListener("popstate", onPopState); // 戻る/進む等の SPA 遷移も検知
  }

  function stopObservers() {
    window.removeEventListener("popstate", onPopState);
    if (io) { io.disconnect(); io = null; }
    if (mo) { mo.disconnect(); mo = null; }
    if (flushTimer) { window.clearTimeout(flushTimer); flushTimer = null; }
    queue.length = 0;
    observedShadowRoots = new WeakSet();
  }

  // ---- 翻訳開始 / 復元 ----
  // サブフレーム(iframe)で翻訳対象文字が少ない枠(広告/ユーティリティ)を訳さないためのしきい値判定。
  // Immersive の mainFrameMinTextCount=50 相当。メインフレームは常に翻訳する。
  function frameHasEnoughText() {
    if (window.top === window.self) return true;
    let chars = 0;
    for (const n of collectNodes(document.body || document.documentElement)) {
      chars += (n.nodeValue || "").trim().length;
      if (chars >= 50) return true;
    }
    return false;
  }

  function startTranslate(newSettings) {
    settings = newSettings;
    // 広告等の小さな iframe は翻訳しない (メインフレームは常に対象)
    if (!frameHasEnoughText()) return Promise.resolve();
    translating = true;
    runId += 1;
    const myRun = runId;
    announced = false;
    fatal = null;
    flushing = false;
    firstFlush = true;
    currentBatchSize = 0;
    queue.length = 0;
    observedBlocks = new WeakSet(); // 再翻訳 (復元→再 ON) で取りこぼさないよう作り直す
    flushedBlocks = new WeakSet();
    observedShadowRoots = new WeakSet();
    startObservers();
    notifyProgress("progress");
    ingest(document.body || document.documentElement);
    // 翻訳対象が無いページでも状態が固まるよう、保険で done 判定を 1 度入れる
    window.setTimeout(() => maybeAnnounceDone(myRun), 1500);
    return Promise.resolve();
  }

  function restore() {
    translating = false;
    runId += 1; // 進行中ループを中断
    stopObservers();
    for (const node of translatedNodes) {
      const orig = originalMap.get(node);
      if (orig != null && node.isConnected) node.nodeValue = orig;
    }
    translatedNodes.clear();
    notifyProgress("restored");
  }

  // ---- メッセージ受信 ----
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.action !== "string") return undefined;
    if (msg.action === A.APPLY_TRANSLATE_CS) {
      startTranslate(msg.settings).then(() => sendResponse({ ok: true })).catch((e) =>
        sendResponse({ ok: false, message: String((e && e.message) || e) })
      );
      return true;
    }
    if (msg.action === A.APPLY_RESTORE_CS) {
      restore();
      sendResponse({ ok: true });
      return undefined;
    }
    return undefined;
  });
})();
