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
  const writtenValue = new WeakMap();   // Node → 我々が書き込んだ訳文 (ページ側の書き換えと区別するため)
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
  let warmupLeft = 0;                   // 残り warm-up バッチ数 (>0 の間は小サイズで投げ TTF を縮める)
  let batchSeq = 0;                     // TRANSLATE_BATCH 連番 (streaming の partial を batchId で紐付ける)
  const pendingBatches = new Map();     // batchId → batch ({node,text}[])。TRANSLATE_PARTIAL の逐次適用に使う
  const queue = [];                     // 翻訳待ち {node, text}

  // ビューポートの先読みマージン(px)。見えている所＋上下これだけ先まで翻訳しておく。
  const PREFETCH_PX = 1200;
  const PREFETCH_MARGIN = `${PREFETCH_PX}px`;
  // 同時に投げるバッチ数 (高速化の主因。Immersive 同様に複数リクエストを並列処理)
  const CONCURRENCY = 10;
  // 翻訳開始直後の最初の数バッチは小さく投げる (TTF=最初の訳が出るまでを短縮)。
  // 大きい初回バッチ(BatchTuner DEFAULT 50)だと 1 リクエストの生成が重く、かつ共有カーソルで先頭ワーカーが
  // 食い尽くして残りワーカーが遊ぶ(実効並列1〜2)。小さく刻めば全ワーカーに行き渡り並列も効く。以降は自動学習サイズ。
  const WARMUP_BATCHES = CONCURRENCY;   // 最初のこの本数だけ小サイズで投げる
  const WARMUP_BATCH_SIZE = 12;         // warm-up 中の 1 バッチのテキスト数
  // 1 バッチの一時エラー時の最大リトライ回数 (指数バックオフ)
  const MAX_RETRY = 2;

  // バッチ非対応プロバイダ (MyMemory 等の NMT) か。並列度・401/403 恒久エラー判定の単一ソース。
  function isNmtProvider() {
    const p = (globalThis.Providers && settings) ? globalThis.Providers.get(settings.provider) : null;
    return Boolean(p && p.batch === false);
  }
  // 同時に投げるバッチ数。NMT (MyMemory) は translator 側を直列(1)にし、実効同時数は background の
  // translateEach 側 (8 並列) で決める。LLM 系はそのまま CONCURRENCY 並列。
  function concurrencyFor() {
    return isNmtProvider() ? 1 : CONCURRENCY;
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
          mo.observe(node.shadowRoot, { childList: true, subtree: true, characterData: true });
        }
      }
      const kids = node.childNodes;
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);     // 逆順 push で pop 時に document 順
    }
    return out;
  }

  // ブロックがビューポート(+先読みマージン)内にあるか。rootMargin "1200px 0px" 相当(縦に先読み)。
  // IntersectionObserver の初期通知に依存せず、初期表示分を確実に即翻訳するための判定。
  function isNearViewport(el) {
    try {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 && r.height <= 0) return false; // 非表示/0サイズは IO に委ねる
      const vh = window.innerHeight || document.documentElement.clientHeight || 0;
      const vw = window.innerWidth || document.documentElement.clientWidth || 0;
      return r.top <= vh + PREFETCH_PX && r.bottom >= -PREFETCH_PX && r.left < vw && r.right > 0;
    } catch (_e) { return false; }
  }

  // root 配下を翻訳対象に取り込む:
  //   可視(+先読み)ブロック → IO の初期通知を待たず即キュー (初期表示を確実に翻訳)
  //   画面外ブロック       → IntersectionObserver に登録 (スクロールで可視化されたら翻訳)
  //   可視化済みブロック内への追加 → 即キュー (動的追加の追従)
  function ingest(root) {
    if (!io) return;
    const toObserve = new Set();
    const nearCache = new Map(); // block→bool: 同一ブロックの getBoundingClientRect 重複読みを避ける
    let immediate = false;
    for (const node of collectNodes(root)) {
      const block = blockAncestor(node);
      if (flushedBlocks.has(block)) { enqueue(node); immediate = true; continue; }
      if (observedBlocks.has(block)) continue; // 監視中(画面外)ブロックは IO 発火を待つ
      let near = nearCache.get(block);
      if (near === undefined) { near = isNearViewport(block); nearCache.set(block, near); }
      if (near) {
        // 既に可視(+先読み)圏内 → IO の初期通知に頼らず即翻訳に回す(スクロールしないと訳されない問題の解消)
        flushedBlocks.add(block);
        observedBlocks.add(block);
        enqueue(node);
        immediate = true;
      } else {
        toObserve.add(block);
      }
    }
    for (const block of toObserve) { observedBlocks.add(block); io.observe(block); }
    if (immediate) scheduleFlush();
  }

  // collectNodes() が accept() 済みノードだけを返すため、ここでは再検証しない (二重 accept=closest 走査の回避)。
  // 全呼び出し元 (ingest / onIntersect) が collectNodes 経由なのが前提。
  function enqueue(node) {
    queue.push({ node, text: node.nodeValue });
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
  // batch ({node,text}[]) を渡す。batchId を採番して登録し、streaming の TRANSLATE_PARTIAL が
  // batchId→node を引いて逐次適用できるようにする。
  function sendBatch(batch) {
    const batchId = ++batchSeq;
    pendingBatches.set(batchId, batch);
    const texts = batch.map((b) => b.text);
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ action: A.TRANSLATE_BATCH, texts, settings, batchId }, (res) => {
          pendingBatches.delete(batchId);
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: "runtime", message: chrome.runtime.lastError.message });
            return;
          }
          resolve(res || { ok: false, error: "empty" });
        });
      } catch (_e) {
        // 拡張のリロード/更新で context が失効 (Extension context invalidated)。静かに停止する。
        pendingBatches.delete(batchId);
        shutdown();
        resolve({ ok: false, error: "context" });
      }
    });
  }

  function sleep(ms) { return new Promise((r) => window.setTimeout(r, ms)); }

  // 一時エラー (429 / 通信 / 5xx) は指数バックオフでリトライ。致命的/恒久エラーはそのまま返す。
  async function sendBatchWithRetry(batch, myRun) {
    for (let attempt = 0; ; attempt++) {
      if (myRun !== runId) return { ok: false, error: "aborted" };
      const res = await sendBatch(batch);
      if (res && res.ok) return res;
      const e = res && res.error;
      // MyMemory 等の NMT は無料枠で 429 を即返す。429 を数百ms 後にリトライしても解けず、
      // 指数バックオフ分(約2秒/バッチ)を丸ごと無駄にするだけなので、NMT の 429 は即諦める。
      const isNmt = isNmtProvider();
      const transient = e === "network" || e === "runtime" || e === "incomplete" ||
        (e === "http" && res.status >= 500) ||
        (e === "http" && res.status === 429 && !isNmt);
      if (transient && attempt < MAX_RETRY) {
        // 429 時のバッチ縮小は background(BatchTuner) を単一ソースにし、res.nextBatchSize で反映する
        // (クライアント側の自前半減は廃止 = 二重管理の解消)。ジッタで 10 並列ワーカーの同時リトライを分散。
        await sleep(700 * (attempt + 1) + Math.floor(Math.random() * 300));
        continue;
      }
      return res || { ok: false, error: "empty" };
    }
  }

  // 1 ノードに訳文を適用 (原文を保持しつつ in-place 置換)。streaming の早出しと最終確定で共用。
  function applyOne(item, t) {
    if (!item) return;
    const nv = item.node.nodeValue;
    // 適用してよいのは「原文のまま」or「我々が前に書いた値(streaming の早出し partial 含む)」のときだけ。
    // それ以外 (in-flight 中にページが書き換えた) は触らず retryable に残す (MutationObserver が新値を再キュー)。
    // → 最終確定 (完全 JSON) は、早出し partial と異なれば上書きして訂正できる。
    if (nv !== item.text && nv !== writtenValue.get(item.node)) return;
    translatedNodes.add(item.node);
    if (typeof t === "string" && t.length > 0 && t !== item.text && t !== nv) {
      if (!originalMap.has(item.node)) originalMap.set(item.node, item.text);
      item.node.nodeValue = t;
      writtenValue.set(item.node, t); // 我々が書いた値を記録 (ページの後続書き換えと判別する)
    }
  }
  // バッチ全体に適用 (最終確定)。streaming で既に適用済みのノードは nodeValue 不一致で applyOne がスキップする。
  function applyTranslations(batch, translations) {
    for (let i = 0; i < batch.length; i++) applyOne(batch[i], translations[i]);
  }

  // 翻訳の優先順位を「ページ上から下」にする: 各アイテムの絶対Y位置で昇順ソートする。
  // rect 読みは applyTranslations の書き込みより前に一括で行うので reflow は1回で済む。
  function sortTopDown(items) {
    const sy = window.scrollY || window.pageYOffset || 0;
    for (const it of items) {
      const el = it.node && it.node.parentElement; // queue は {node,text} のみ (block は持たない)
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
        // 開始直後の数バッチは小サイズ (TTF 短縮 + 全ワーカーに分散)。以降は自動学習サイズ。
        let size;
        if (warmupLeft > 0) { warmupLeft--; size = WARMUP_BATCH_SIZE; }
        else size = Math.max(1, currentBatchSize);
        const batch = pending.slice(cursor, cursor + size);
        cursor += batch.length;
        const res = await sendBatchWithRetry(batch, myRun);
        if (myRun !== runId) return;
        // バッチサイズ自動学習は background(tuningMem) を単一ソースとし、ok/エラー問わず nextBatchSize を採用する。
        if (res && res.nextBatchSize) currentBatchSize = res.nextBatchSize;
        if (res && res.ok && Array.isArray(res.translations)) {
          applyTranslations(batch, res.translations);
        } else if (res && res.error === "no_api_key") {
          fatal = res; // キーが無ければ何も訳せない → 全体中断
          return;
        } else if (res && res.error === "http" && (res.status === 401 || res.status === 403) && !isNmtProvider()) {
          // LLM のキー無効/失効(401/403)は恒久エラー。skip して done になると「翻訳済みなのに原文のまま」に
          // 見えるため、no_api_key 同様に全体中断して popup/FAB に設定問題を通知する (NMT は per-text 制限なので除外)。
          fatal = res;
          return;
        } else if (res && res.allFailed) {
          // バッチ全件失敗 (MyMemory クォータ枯渇等で 1 件も訳せず)。無言で done にせずエラー通知し原因を見せる。
          fatal = res;
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
      if (m.type === "characterData") {
        // サイトが既存テキストノードを書き換えたケース (SPA/チャット等の文言差し替え)。
        const tn = m.target;
        if (translatedNodes.has(tn)) {
          // 我々が書いた訳文のままなら無視 (自己書き換えでの再発火/ループ防止)。
          if (tn.nodeValue === writtenValue.get(tn)) continue;
          // ページが別テキストへ書き換えた → 翻訳済みマーク/原文記録を捨てて訳し直す (古い訳の残留や復元時の誤上書きを防ぐ)。
          translatedNodes.delete(tn);
          originalMap.delete(tn);
          writtenValue.delete(tn);
        }
        ingest(tn.parentNode || tn);
        continue;
      }
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
      mo.observe(document.body || document.documentElement, { childList: true, subtree: true, characterData: true });
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
    pendingBatches.clear(); // 復元時に in-flight の streaming partial 紐付けを破棄 (stale 適用防止)
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

  // 適用済みの訳文を原文へ戻し、翻訳済みマークをクリアする (再翻訳前のリセット / 復元で共用)
  function revertTranslations() {
    for (const node of translatedNodes) {
      const orig = originalMap.get(node);
      if (orig != null) node.nodeValue = orig; // 切断中ノードも戻す (仮想化 DOM の再アタッチで旧訳が復活しないように)
      originalMap.delete(node);  // 次回翻訳で最新の原文を取り直せるようメタを破棄 (古い原文での誤上書き防止)
      writtenValue.delete(node);
    }
    translatedNodes.clear();
  }

  function startTranslate(newSettings) {
    settings = newSettings;
    // 2 回目以降の翻訳 (言語/provider 変更で再実行) は先に原文へ戻す。前回の訳が残ると accept() が既訳ノードを
    // 全弾きし、iframe では frameHasEnoughText() が 0 字と誤判定して再翻訳されないため、閾値判定より前に revert する。
    revertTranslations();
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
    warmupLeft = WARMUP_BATCHES; // 開始直後の数バッチは小さく投げて最初の訳を早く出す
    queue.length = 0;
    pendingBatches.clear(); // 前セッションの streaming partial 紐付けを破棄
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
    revertTranslations();
    notifyProgress("restored");
  }

  // ---- メッセージ受信 ----
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.action !== "string") return undefined;
    if (msg.action === A.TRANSLATE_PARTIAL) {
      // streaming の早出し: 確定した訳文要素を該当ノードへ即適用 (最終 sendResponse でも整合確認される)。
      // 復元/再翻訳後は pendingBatches がクリアされ batchId が引けないので適用されない (stale 防止)。
      const batch = pendingBatches.get(msg.batchId);
      if (translating && batch && batch[msg.index]) applyOne(batch[msg.index], msg.text);
      return undefined;
    }
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
