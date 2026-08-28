"use strict";

/**
 * translator.js — ページ「インプレース置換翻訳」エンジン (content script)
 *
 * scripting.executeScript で actions.js / lang.js と共にオンデマンド注入される。
 * runtime/version-aware な __rtTranslatorLoaded ガードで同一 context の重複初期化だけを防ぐ。
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
  const SCRIPT_MARKER = "__rtTranslatorLoaded";
  if (!globalThis.ExtUtil || !ExtUtil.claimScript(SCRIPT_MARKER)) return;
  const scriptOwner = globalThis[SCRIPT_MARKER];

  const A = globalThis.Actions;

  // 診断ログ (既定無音)。ページ console で localStorage.setItem("__rt_debug","1") を立てたときだけ出す。
  // content script は同一オリジンの localStorage を page と共有するので、page 側で立てれば次回注入時から出る。
  const RT_BUILD = "2026-06-19-diag";
  // フラグは起動時に 1 回だけ読み、以後は in-memory 参照(高頻度 ingest で毎回 localStorage を叩かない)。
  // 別タブでの変更は storage イベントで追従(同一タブは再注入/リロード時に読み直す)。
  let rtDebug = false;
  try { rtDebug = localStorage.getItem("__rt_debug") === "1"; } catch (_e) { /* noop */ }
  try { window.addEventListener("storage", (e) => { if (e && e.key === "__rt_debug") rtDebug = e.newValue === "1"; }); } catch (_e) { /* noop */ }
  function dbg() {
    if (!rtDebug) return;
    try { console.debug.apply(console, ["[rt]"].concat(Array.prototype.slice.call(arguments))); } catch (_e) { /* noop */ }
  }

  // ---- 状態 ----
  const originalMap = new WeakMap();    // Node → 原文 (復元用)
  const writtenValue = new WeakMap();   // Node → 我々が書き込んだ訳文 (ページ側の書き換えと区別するため)
  let originalReapplyAt = new WeakMap(); // Node → 原文書き戻しへ最後に訳文を再適用した時刻 (ページとの書き換え競合を止める)
  let recentScopeWrites = new WeakMap(); // 安定した親コンポーネント → 直近に訳文を書いた原文と時刻 (Text ノード再生成競合の検知)
  const translatedNodes = new Set();    // 翻訳/処理済みノード (再翻訳防止 + 復元走査用)
  // 原文テキスト → 訳文のセッション内メモ。SPA 再レンダで Text ノード実体が差し替わると WeakMap キーから
  // 外れて同一原文を再翻訳してしまう (= autoTranslate で「翻訳済みを何度も再翻訳」)。同じ原文を既に訳して
  // いれば API を呼ばずキャッシュ適用する。provider/targetLang が変わると訳が変わるので revert で clear する。
  const translationMemo = new Map();
  // メモの上限 (巨大ページでの無制限増加を防ぐ。超過後は新規登録のみ停止＝先勝ちで hot text を保持)。
  // 訳文=原文 (固有名詞等) もキャッシュする分エントリが増えるため、無限スクロール (YouTube コメント等) で
  // 一度訳した原文が evict されて再送信されないよう、容量を厚めに取る (原文+訳文の文字列ペアで ~数百KB/千件)。
  const MEMO_MAX = 8000;
  let observedBlocks = new WeakSet();   // io.observe 済みのブロック要素
  let flushedBlocks = new WeakSet();    // 可視化して翻訳に回し終えたブロック (内部への動的追加は即取り込む)
  let observedShadowRoots = new WeakSet(); // MutationObserver で監視済みの shadow root (内部の動的更新も拾う)
  let lastHref = "";                    // SPA ナビゲーション検知用 (location.href の変化を見る)
  let translating = false;              // 翻訳 ON 状態
  let runId = 0;                        // 翻訳セッション ID (復元/再開で中断判定)
  let sessionId = null;                 // background が固定した page-run の設定スナップショット ID
  let settings = null;
  let io = null;                        // IntersectionObserver (ビューポート優先)
  let mo = null;                        // MutationObserver (動的追加)
  let ro = null;                        // ResizeObserver (初回 0×0 で observe した block の高さ確定を能動検知)
  // 初回 ingest 時 0×0(near=false)で io.observe した block。高さ確定後に near 再評価する対象 (ResizeObserver + reingest で promote)。
  // Set にして (a) 監視数の上限ガード(size), (b) DOM から外れた block の掃除(列挙→ro.unobserve) を可能にする
  // (WeakSet では列挙不可。RO は元々ターゲットを強参照するため、Set 化で増える保持は無く掃除経路だけ得られる)。
  let zeroSizedBlocks = new Set();
  let flushTimer = null;
  let pendingAttrRoots = new Set();     // 可視性に効く属性変化があった要素 (デバウンスして再 ingest する対象)
  let attrTimer = null;                 // 属性駆動の再 ingest デバウンスタイマー
  let lastAttrFullScan = 0;
  let reingestTimers = [];              // scheduleReingest の遅延再走査タイマー群 (多重起動を畳む/停止時に解除)
  let flushing = false;                 // flush 走行中フラグ (同時多発を直列化して 429 を抑える)
  let firstFlush = true;                // 初回 flush は即時(最初の訳を早く出す)、以降デバウンス
  let announced = false;                // 初回 done 通知済みか (以降のスクロール翻訳では戻さない)
  let fatal = null;                     // 致命的エラー (no_api_key) で全体中断
  let droppedTransient = 0;             // 一時エラー(429/503/通信)でリトライ枯渇し未訳のまま諦めたノード数 (run 単位)。done 時に partial 通知に使う
  let currentBatchSize = 0;
  let warmupLeft = 0;                   // 残り warm-up バッチ数 (>0 の間は小サイズで投げ TTF を縮める)
  let batchSeq = 0;                     // TRANSLATE_BATCH 連番 (streaming の partial を batchId で紐付ける)
  const pendingBatches = new Map();     // batchId → exact text group[]。TRANSLATE_PARTIAL の逐次 fan-out に使う
  const queue = [];                     // 翻訳待ち {node, text}
  let queuedNodes = new WeakSet();      // 同じノードをin-flight前に重複キューへ積まない
  let pageTextCount = 0;
  let pageCharCount = 0;
  const INCOMPLETE_REQUEUE_MAX = 2;     // incomplete/oversize を小バッチへ分割して再キューする上限 (無限ループ防止)
  const ORIGINAL_REAPPLY_COOLDOWN_MS = 1000; // ページが直後に原文へ戻したノードではページ側を優先し、MO の相互書き換えを止める
  const SCOPE_WRITE_MAX_TEXTS = 128;    // 1 コンポーネントで保持する競合検知用原文数 (巨大 Web Component での増加を上限化)

  // 初回翻訳 / SPA 遷移のあと、コンテンツが段階的に描画されるのを待って全体を取り込み直す遅延(ms)。
  // qiankun 等の micro-frontend や非同期チャートは初回 ingest 時に 0-height で、可視内で高さが付いても IO は
  // 発火しない (スクロールしないと訳されない)。描画完了後に再走査して「高さの付いたブロック」を near として拾う。
  // 旧 [350,1200] は遅いダッシュボードの描画(2〜4s+)に間に合わず "翻訳済みなのに英語のまま" になっていた。
  const REINGEST_DELAYS = [350, 1200, 2500];
  // 1 page run の入力予算。スクロール追従は維持しつつ、悪意ある大量DOMで無制限に課金しない。
  const PAGE_MAX_TEXTS = 5000;
  const PAGE_MAX_CHARS = 500000;
  const PAGE_MAX_SINGLE_CHARS = 20000;
  // ResizeObserver で同時追跡する 0×0 block の上限。仮想化リスト等で 0×0 placeholder が大量生成されても
  // RO 監視(と強参照)が無制限に増えないようにする保険。超過分は io.observe + スクロールの IO 発火に委ねる。
  const ZEROSIZE_CAP = 400;
  // ページ言語=翻訳先のとき、非翻訳先の言語がこの割合(%)以上混在していれば skip せず訳す閾値。
  // 日本語UIに囲まれた英語本文記事のような「単一トピックページに異言語コンテンツが1つ埋まる」ケースを想定した
  // 閾値だが、X(Twitter)等の投稿ごとに言語がバラバラな SNS フィードでは、UI 自体は完全に日本語でも
  // タイムライン中の少数の外国語投稿だけで平均 20〜30% 程度に達してしまい、意図せず毎回「混在ページ」判定
  // されて発動していた。50 に引き上げ、フィードの過半数が非翻訳先言語のときだけ混在ページ扱いにする。
  const MIXED_LANG_THRESHOLD = 50;
  // ビューポートの先読みマージン(px)。見えている所＋上下これだけ先まで翻訳しておく。
  const PREFETCH_PX = 1200;
  const PREFETCH_MARGIN = `${PREFETCH_PX}px`;
  // 同時に投げるバッチ数 (高速化の主因。Immersive 同様に複数リクエストを並列処理)。
  // 実測 (gpt-5.4-nano): 1 リクエストの生成速度は ~139tok/s で頭打ちだが、並列度を上げても各バッチの
  // wall はほぼ一定でスループットが並列数にほぼ比例 (c=10→43, c=20→90, c=30→138 texts/s・30並列でも429ゼロ)。
  // 旧10は OpenAI 側の並列余力(3倍以上)を取りこぼしていたため24へ (出力トークン総量は不変=コスト増なし)。
  const CONCURRENCY = 24;
  // 翻訳開始直後の最初の数バッチは小さく投げる (TTF=最初の訳が出るまでを短縮)。
  // 大きい初回バッチ(BatchTuner DEFAULT 50)だと 1 リクエストの生成が重く、かつ共有カーソルで先頭ワーカーが
  // 食い尽くして残りワーカーが遊ぶ(実効並列1〜2)。小さく刻めば全ワーカーに行き渡り並列も効く。以降は自動学習サイズ。
  const WARMUP_BATCHES = CONCURRENCY;   // 最初のこの本数だけ小サイズで投げる
  const WARMUP_BATCH_SIZE = 12;         // warm-up 中の 1 バッチのテキスト数
  // 1 バッチの一時エラー時の最大リトライ回数 (指数バックオフ)
  const MAX_RETRY = 2;
  // 同じ短文でも会話・見出し等の周辺文脈が違えば別の訳になり得る。LLM へ添える文脈はトークン増を
  // 抑えるため前後合わせてこの長さへ制限し、background 側でも同じ上限を再検証する。
  const CONTEXT_MAX_CHARS = (globalThis.TranslationBatch && TranslationBatch.CONTEXT_MAX_CHARS) || 240;
  const CONTEXT_SIDE_CHARS = 96;
  const CONTEXT_SCAN_NODES = 200;

  // バッチ非対応プロバイダ (MyMemory 等の NMT) か。並列度・401/403 恒久エラー判定の単一ソース。
  function isNmtProvider() {
    const p = (globalThis.Providers && settings) ? globalThis.Providers.get(settings.provider) : null;
    return Boolean(p && p.batch === false);
  }
  // 同時に投げるバッチ数。NMT (MyMemory) は translator 側を直列(1)にし、実効同時数は background の
  // translateEach 側 (8 並列) で決める。LLM 系は CONCURRENCY が既定だが、provider が maxConcurrency を
  // 宣言していればそちらで上限を絞る (例: 無料枠 RPM の低い Gemini は 3。429/503 多発を防ぐ)。
  function concurrencyFor() {
    if (isNmtProvider()) return 1;
    const p = (globalThis.Providers && settings) ? globalThis.Providers.get(settings.provider) : null;
    const cap = p && Number(p.maxConcurrency);
    return (cap && cap > 0) ? Math.min(cap, CONCURRENCY) : CONCURRENCY;
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
  // 末尾は拡張自身の UI (FAB / 画像ホバーボタン / 画像オーバーレイ層 / 選択翻訳バブル)。これらは fab.js /
  // image-translator.js / selection-translator.js が描画・管理するので、collectNodes が訳文や「翻訳中…」を
  // 訳し直したり、復元時に stale な訳語へ戻すのを防ぐ。特に自動翻訳 ON で選択翻訳バブルが拾われると、
  // 「翻訳中…」自体が翻訳バッチに乗り、その応答が選択翻訳の TRANSLATE_BATCH と競合して
  // parse/incomplete エラーに化けることがある (= ユーザーから見た「解析エラー」の主因)。
  const SKIP_CLOSEST = "pre, code, kbd, samp, svg, math, [translate=no], .notranslate, #__rt_fab, #__rt_sel_bubble, .__rt-sel-inline, .__rt-img-btn, .__rt-img-layer";

  // 可視性に影響する属性。これらが変わったら display:none→表示になったドロップダウン/モーダル/タブ/
  // アコーディオン等の中身を取り込み直す (IO は display 切替を取りこぼすことがあるため属性駆動で補う)。
  // data-state は Radix/shadcn 等が open/closed の表示制御に使う。
  const ATTR_FILTER = ["class", "style", "hidden", "open", "aria-hidden", "aria-expanded", "data-state"];
  // MutationObserver の監視設定 (本体 / shadow root で共通)。childList+characterData で動的追加・文言差し替えを、
  // attributes(ATTR_FILTER) で表示トグルを拾う。我々は属性を書き換えないので自己再発火は起きない。
  const MO_OPTS = { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTR_FILTER, attributeOldValue: true };

  function shouldTranslateText(s) {
    if (!s) return false;
    const t = s.trim();
    if (t.length <= 1) return false;              // 空 / 1 文字 (箇条点・単独記号・単独文字) はスキップ
    if (!/[\p{L}]/u.test(t)) return false;        // 文字(Letter)を含まない = 数値/記号のみ
    if (/^https?:\/\/\S+$/i.test(t)) return false; // URL 単体
    return true;
  }

  // SKIP_CLOSEST を shadow 境界を越えて判定する。closest() は自分の root (shadowRoot) までしか遡らず host を見ないため、
  // <my-widget translate="no"> のようにホスト側に付いた除外マーカーを取りこぼす。getRootNode().host を辿って上位 tree も確認する。
  function skippedByMarker(el) {
    let cur = el;
    while (cur) {
      if (typeof cur.closest === "function" && cur.closest(SKIP_CLOSEST)) return true;
      const root = cur.getRootNode && cur.getRootNode();
      const host = root && root.host; // ShadowRoot なら host 要素。通常 document なら undefined で打ち切り
      if (!host) return false;
      cur = host; // ホストを起点にさらに上位 (ネストした shadow / light DOM) を辿る
    }
    return false;
  }

  function accept(node) {
    if (translatedNodes.has(node)) return false;
    const p = node.parentNode;
    if (!p || p.nodeType !== 1) return false;
    if (SKIP_PARENT_TAGS.has(p.nodeName)) return false;
    if (p.isContentEditable) return false;
    if (!shouldTranslateText(node.nodeValue)) return false;
    // 残った候補だけ除外マーカーを確認する (走査全体のコストを抑える)。shadow 内のテキストは host チェーンも遡る。
    if (skippedByMarker(p)) return false;
    return true;
  }

  // Text ノードやその直近ラッパーを作り直す Web Component でも同じ単位を引けるよう、最寄りの custom element
  // (shadow host を含む) を競合検知スコープにする。custom element が無い通常 DOM は直親を使う。
  function rewriteScope(node) {
    let el = node && node.parentElement;
    const directParent = el;
    while (el) {
      if (String(el.localName || "").includes("-")) return el;
      const parent = el.parentElement;
      if (parent) { el = parent; continue; }
      const root = el.getRootNode && el.getRootNode();
      el = root && root.host && root.host !== el ? root.host : null;
    }
    return directParent;
  }

  function noteScopeWrite(node, text) {
    const scope = rewriteScope(node);
    if (!scope || !text) return;
    let writes = recentScopeWrites.get(scope);
    if (!writes) { writes = new Map(); recentScopeWrites.set(scope, writes); }
    if (writes.size >= SCOPE_WRITE_MAX_TEXTS && !writes.has(text)) writes.delete(writes.keys().next().value);
    writes.delete(text); // Map の末尾へ動かし、上限到達時に古い原文から外せるようにする
    writes.set(text, Date.now());
  }

  function scopeWriteIsRecent(node, text) {
    const scope = rewriteScope(node);
    const writes = scope && recentScopeWrites.get(scope);
    if (!writes) return false;
    const last = writes.get(text);
    const now = Date.now();
    if (last == null || now - last >= ORIGINAL_REAPPLY_COOLDOWN_MS) return false;
    // ページが再生成を続ける間は時刻を延長し、静止してクールダウンした後だけ再適用できるようにする。
    writes.delete(text);
    writes.set(text, now);
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

  function sourceValue(node) {
    const original = originalMap.get(node);
    return typeof original === "string" ? original : String((node && node.nodeValue) || "");
  }

  function compactContextText(value, fromEnd) {
    const text = String(value || "").replace(/\s+/gu, " ").trim();
    if (text.length <= CONTEXT_SIDE_CHARS) return text;
    return fromEnd ? text.slice(-CONTEXT_SIDE_CHARS) : text.slice(0, CONTEXT_SIDE_CHARS);
  }

  // 既に翻訳した隣接ノードは originalMap の原文へ戻して読む。動的再描画後も、訳文を文脈キーへ
  // 混ぜて不要な cache miss を起こさないため。走査数と文字数は固定上限で抑える。
  function elementContextPreview(root, fromEnd) {
    if (!root) return "";
    let walker;
    try { walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); } catch (_e) { return ""; }
    let combined = "";
    let scanned = 0;
    for (let node = walker.nextNode(); node && scanned++ < CONTEXT_SCAN_NODES; node = walker.nextNode()) {
      if (node.parentElement && node.parentElement.closest(SKIP_CLOSEST)) continue;
      const text = compactContextText(sourceValue(node), false);
      if (!text) continue;
      combined = fromEnd ? `${combined} ${text}`.slice(-CONTEXT_SIDE_CHARS) : `${combined} ${text}`;
      if (!fromEnd && combined.length >= CONTEXT_SIDE_CHARS) break;
    }
    return compactContextText(combined, fromEnd);
  }

  function adjacentContextPreview(node, block, direction) {
    let walker;
    try {
      walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      walker.currentNode = node;
    } catch (_e) { return ""; }
    for (let scanned = 0; scanned < CONTEXT_SCAN_NODES; scanned++) {
      const candidate = direction < 0 ? walker.previousNode() : walker.nextNode();
      if (!candidate) break;
      if (candidate.parentElement && candidate.parentElement.closest(SKIP_CLOSEST)) continue;
      const text = compactContextText(sourceValue(candidate), direction < 0);
      if (text) return text;
    }
    return "";
  }

  function blockContextSnapshot(block) {
    return {
      before: elementContextPreview(block && block.previousElementSibling, true),
      after: elementContextPreview(block && block.nextElementSibling, false),
    };
  }

  function translationContext(node, block, snapshot) {
    if (isNmtProvider()) return ""; // MyMemory 等は文脈入力を受け取れないため従来の exact-text 経路を維持
    const target = String((node && node.nodeValue) || "").replace(/\s+/gu, " ").trim();
    const nearby = snapshot || blockContextSnapshot(block);
    const inlineBefore = adjacentContextPreview(node, block, -1);
    const inlineAfter = adjacentContextPreview(node, block, 1);
    const before = inlineBefore || nearby.before;
    const after = inlineAfter || nearby.after;
    const parts = [];
    if (before && before !== target) parts.push(`Before: ${before}`);
    if (after && after !== target) parts.push(`After: ${after}`);
    if (parts.length === 0) {
      // 孤立したラベル等にも最低限のページ文脈を与える。query/hash は個人識別子や一時値を含みやすいので送らない。
      let path = "";
      try { path = location.pathname || ""; } catch (_e) { /* noop */ }
      const page = compactContextText([path, document.title || ""].filter(Boolean).join(" — "), false);
      if (page && page !== target) parts.push(`Page: ${page}`);
    }
    return parts.join("\n").slice(0, CONTEXT_MAX_CHARS);
  }

  function memoKey(text, context) {
    return TranslationBatch.contextKey(text, isNmtProvider() ? "" : context);
  }

  // root 配下の翻訳対象テキストノードを document 順に遅延列挙する。
  // TreeWalker は Shadow DOM を貫通しないので、開いた shadowRoot を辿る DFS で実装する
  // (Immersive 同様に Web コンポーネント内のテキストも翻訳対象にする)。子は document 順で積む。
  // collectNodes の病的ガード: 通常ページでは到達しない大きさに置く (受理テキスト 5 万 / 走査 30 万ノード)。
  // 旧 PAGE_MAX_TEXTS(5000) での打ち切りは超過分が io.observe に載らず「完了なのに下半分が原文」の無言欠落
  // になるため撤去したが、無制限だと仮想化なしの超巨大 DOM で DFS + ingest(ブロック毎の rect 読み=reflow) が
  // メインスレッドを分単位で塞ぎ、REINGEST/属性再走査の繰り返しでページが応答停止に見える。上限到達は
  // droppedTransient に数えて done(partial) で正直に報告する (通常予算は従来どおり enqueue 側の PAGE_MAX_*)。
  const COLLECT_MAX_TEXTS = 50000;
  const COLLECT_MAX_VISITS = 300000;
  function* collectNodes(root) {
    if (!root) return;
    const stack = [root];
    let visited = 0;
    let accepted = 0;
    while (stack.length) {
      if (accepted >= COLLECT_MAX_TEXTS || ++visited > COLLECT_MAX_VISITS) { droppedTransient++; return; }
      const node = stack.pop();
      const t = node.nodeType;
      if (t === 3) {                                                   // テキスト
        if (accept(node)) { accepted++; yield node; }
        continue;
      }
      if (t !== 1 && t !== 11) continue;                                  // 要素 or DocumentFragment(shadowRoot)
      // accept() で全テキストを個別に落とす前に、翻訳対象外 subtree を入口で枝刈りする。
      if (t === 1 && node.matches(SKIP_CLOSEST)) continue;
      if (t === 1 && node.shadowRoot) {                                   // 開いた shadow DOM を辿る
        stack.push(node.shadowRoot);
        // shadow root 内部の動的更新も拾えるよう MutationObserver に登録する (翻訳中のみ)
        if (mo && !observedShadowRoots.has(node.shadowRoot)) {
          observedShadowRoots.add(node.shadowRoot);
          mo.observe(node.shadowRoot, MO_OPTS);
        }
      }
      const kids = node.childNodes;
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);     // 逆順 push で pop 時に document 順
    }
  }

  // ブロックの rect を 1 回だけ読み、(a) ビューポート(+先読みマージン)内か near と、
  // (b) ページ絶対 Y (= top + scrollY、スクロール不変) を返す。near は rootMargin "1200px 0px" 相当(縦に先読み)で、
  // IntersectionObserver の初期通知に頼らず初期表示分を即翻訳するための判定。絶対 Y を enqueue 時に確定させることで、
  // flush の sortTopDown が node 毎に getBoundingClientRect を読み直さずに済む (reflow を block 数ぶんに削減)。
  function blockMeta(el) {
    try {
      const r = el.getBoundingClientRect();
      const sy = window.scrollY || window.pageYOffset || 0;
      const vh = window.innerHeight || document.documentElement.clientHeight || 0;
      const vw = window.innerWidth || document.documentElement.clientWidth || 0;
      const visible = !(r.width <= 0 && r.height <= 0); // 非表示/0サイズは IO に委ねる
      const near = visible && r.top <= vh + PREFETCH_PX && r.bottom >= -PREFETCH_PX && r.left < vw && r.right > 0;
      // zeroSized = 幅も高さも 0(チャート未描画でパネルが潰れた等)。後から高さが付くと near 化しうるので
      // ResizeObserver + reingest で再評価する対象に印を付ける(0-height だが幅のある block は visible=true で near 判定に乗る)。
      return { near, y: r.top + sy, zeroSized: !visible };
    } catch (_e) { return { near: false, y: 0, zeroSized: false }; }
  }

  // root 配下を翻訳対象に取り込む:
  //   可視(+先読み)ブロック → IO の初期通知を待たず即キュー (初期表示を確実に翻訳)
  //   画面外ブロック       → IntersectionObserver に登録 (スクロールで可視化されたら翻訳)
  //   可視化済みブロック内への追加 → 即キュー (動的追加の追従)
  function ingest(root, fullRecheck) {
    if (!io) return;
    const toObserve = new Set();
    const metaCache = new Map(); // block→{near,y}: 同一ブロックの getBoundingClientRect 重複読みを避ける
    const contextCache = new Map(); // block→前後 block の原文 preview。同一 ingest 内の重複走査を避ける
    const metaOf = (block) => {
      let m = metaCache.get(block);
      if (m === undefined) { m = blockMeta(block); metaCache.set(block, m); }
      return m;
    };
    let immediate = false;
    const dc = { collected: 0, memo: 0, flushedHit: 0, promoted: 0, near: 0, observe: 0, zero: 0 }; // 診断カウンタ
    for (const node of collectNodes(root)) {
      dc.collected++;
      // 既訳原文の再出現はブロック可視判定(getBoundingClientRect=reflow)/IO 登録/flush を経ずメモから訳文を同期適用する。
      // 自己更新する時刻カスタム要素 (GitHub/Catalyst の <relative-time> 等) は open shadow DOM 内の span を
      // ティッカーで毎回 replaceChildren(新 span) し直す = 我々が登録した shadow root の MutationObserver に childList で
      // 届く。同一テキスト ("11 minutes ago" 等) を毎ティック ingest し直すと reflow/flush/progress が回り続け
      // 「無限に翻訳を繰り返す」ように見える (= GitHub issue ページの「4 days ago / 11 minutes ago」)。同一原文は
      // メモ適用なら API も reflow も無く、MO コールバック内の同期書き換えなのでペイント前に訳文へ戻りちらつかない。
      // 原文が実際に変化したとき (時刻が進んで "12 minutes ago" 等) はメモミス → 下の通常経路で訳す (翻訳を維持する)。
      const block = blockAncestor(node);
      let context = "";
      if (!isNmtProvider()) {
        let snapshot = contextCache.get(block);
        if (!snapshot) { snapshot = blockContextSnapshot(block); contextCache.set(block, snapshot); }
        context = translationContext(node, block, snapshot);
      }
      const memo = translationMemo.get(memoKey(node.nodeValue, context));
      if (memo !== undefined) {
        // ページが訳文への反応として同じ custom element 内の Text ノードを原文で作り直した場合は、ページ側を優先する。
        // translatedNodes に残すため同じノードを再キューせず、別テキストやクールダウン後の更新は通常どおり翻訳できる。
        if (scopeWriteIsRecent(node, node.nodeValue)) translatedNodes.add(node);
        else applyOne({ node, text: node.nodeValue, context }, memo);
        dc.memo++;
        continue;
      }
      if (flushedBlocks.has(block)) { enqueue(node, metaOf(block).y, context); immediate = true; dc.flushedHit++; continue; }
      if (observedBlocks.has(block)) {
        // 監視中ブロックは原則 IO 発火待ちで rect を読まない(性能)。例外1: 初回 0×0 で observe した block は
        // 高さが付いて near 化したか毎回再評価する(0×0→サイズ付与の in-viewport 遷移は IO が発火しないことが
        // あるため)。例外2: fullRecheck (scheduleReingest の定期再走査・350〜2500ms に最大3回) 時は、
        // 0×0 でなかった block も含め near 化したか再評価する。初回計測時に非 0×0 でも「近傍の要素がまだ描画/
        // 確定していない一時的なレイアウト」のせいで最終位置より下に見え near=false と判定されることがあり
        // (例: 上にあるローディングプレースホルダが後で縮む)、この class の block は zeroSizedBlocks に入らず
        // ResizeObserver の恩恵を受けないため、IO の自然な再発火 (実質スクロール待ち) に取り残されてしまう
        // (「DOM は読み込み済みなのにスクロールしないと翻訳が始まらない」の主因)。定期再走査に限定して
        // 再評価することで、高頻度な MutationObserver 起因の ingest は従来どおり rect を読まず性能を維持しつつ
        // この取りこぼしを解消する。promoteSizedBlock がその block の全ノードを enqueue する。
        if ((zeroSizedBlocks.has(block) || fullRecheck) && promoteSizedBlock(block, metaOf(block))) { immediate = true; dc.promoted++; }
        continue;
      }
      const meta = metaOf(block);
      if (meta.near) {
        // 既に可視(+先読み)圏内 → IO の初期通知に頼らず即翻訳に回す(スクロールしないと訳されない問題の解消)
        flushedBlocks.add(block);
        observedBlocks.add(block);
        enqueue(node, meta.y, context);
        immediate = true;
        dc.near++;
      } else {
        toObserve.add(block);
        if (meta.zeroSized) dc.zero++;
      }
    }
    dc.observe = toObserve.size;
    for (const block of toObserve) {
      observedBlocks.add(block);
      io.observe(block);
      // 初回 0×0 の block は遅延描画で後から高さが付く可能性 → ResizeObserver で能動監視し、
      // サイズ確定した瞬間に onResize→promoteSizedBlock で即取り込む(IO 再発火に依存しない)。
      // ZEROSIZE_CAP で監視数を上限化(仮想化リストの 0×0 大量生成で RO が無制限に増えるのを防ぐ)。
      if (metaOf(block).zeroSized && !zeroSizedBlocks.has(block) && zeroSizedBlocks.size < ZEROSIZE_CAP) {
        zeroSizedBlocks.add(block);
        if (ro) { try { ro.observe(block); } catch (_e) { /* noop */ } }
      }
    }
    if (rtDebug) dbg("ingest", JSON.stringify(dc), "queue=", queue.length); // JSON.stringify を無効時に評価しない
    if (immediate) scheduleFlush();
  }

  // collectNodes() が accept() 済みノードだけを返すため、ここでは再検証しない (二重 accept=closest 走査の回避)。
  // 全呼び出し元 (ingest / onIntersect) が collectNodes 経由なのが前提。
  function enqueue(node, y, context) {
    if (!node || queuedNodes.has(node) || translatedNodes.has(node)) return;
    const text = String(node.nodeValue || "");
    if (text.length > PAGE_MAX_SINGLE_CHARS || pageTextCount >= PAGE_MAX_TEXTS || pageCharCount + text.length > PAGE_MAX_CHARS) {
      // 上限超過分は原文のまま残し、done(partial)で正直に通知する。
      translatedNodes.add(node);
      droppedTransient++;
      return;
    }
    queuedNodes.add(node);
    pageTextCount++;
    pageCharCount += text.length;
    const block = blockAncestor(node);
    const resolvedContext = isNmtProvider()
      ? ""
      : typeof context === "string"
      ? context
      : translationContext(node, block, blockContextSnapshot(block));
    queue.push({ node, text, context: resolvedContext, _y: y || 0 }); // _y = 所属ブロックのページ絶対Y (sortTopDown 用)
  }

  // 拡張 context が生きているか (リロード/更新後に置き去りになった古いスクリプトかの判定)。
  // 失効すると chrome.runtime.id が undefined になり、chrome API 呼び出しは例外を投げる。
  const contextAlive = () => ExtUtil.contextAlive(SCRIPT_MARKER, scriptOwner);
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
    const contexts = batch.map((b) => b.context || "");
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ action: A.TRANSLATE_BATCH, texts, contexts, settings, batchId, sessionId }, (res) => {
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

  // 429 の理由を API 本文(res.message)から判定する。無料枠の「1日上限(RPD)」や残高切れ(insufficient_quota)は
  // その日ずっと 429 を返すので、リトライや並列削減では解けない。解ける「分あたり上限(RPM)」と区別する。
  function quotaScope(res) {
    if (!res || res.error !== "http" || res.status !== 429) return null;
    const m = String(res.message || "").toLowerCase();
    if (m.includes("perminute") || m.includes("per minute") || m.includes("per-minute")) return "minute";
    if (m.includes("perday") || m.includes("per day") || m.includes("per-day") || m.includes("daily")) return "day";
    if (m.includes("insufficient_quota")) return "day"; // OpenAI 互換: 残高切れ = リトライ無駄
    return null;
  }

  // 入力サイズ起因の 400 (context-length / request-too-large) はバッチ固有のエラー → BatchTuner がサイズを
  // 縮めれば通る。設定/リクエスト形状起因の 400 (モデル非対応パラメータ等) は全バッチ同型に必ず失敗するので
  // fatal のまま扱う。本文を見て両者を切り分け、サイズ 400 は per-batch の一時エラー (skip→partial) に倒す。
  function isOversizeRequest(res) {
    return TranslationBatch.isOversize(res);
  }

  // 一時エラー (429 / 通信 / 5xx) は指数バックオフでリトライ。致命的/恒久エラーはそのまま返す。
  async function sendBatchWithRetry(batch, myRun) {
    for (let attempt = 0; ; attempt++) {
      if (myRun !== runId) return { ok: false, error: "aborted" };
      const res = await sendBatch(batch);
      if (res && res.ok) return res;
      // MyMemory 等の NMT は無料枠で 429 を即返す。429 を数百ms 後にリトライしても解けず、
      // 指数バックオフ分(約2秒/バッチ)を丸ごと無駄にするだけなので、NMT の 429 は即諦める。
      const isNmt = isNmtProvider();
      // incomplete は同一 batch を再送しても入力/出力 token を重ねるだけなので、ここでは retry しない。
      // flush が background の nextBatchSize を採用し、未訳分をより小さい batch へ分割して再キューする。
      const transient = TranslationBatch.shouldRetry(res, { isNmt, quotaScope: quotaScope(res) });
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
      noteScopeWrite(item.node, item.text);
    }
  }
  function batchMembers(item) {
    return item && Array.isArray(item.members) ? item.members : (item ? [item] : []);
  }
  function applyBatchItem(item, t) {
    for (const member of batchMembers(item)) applyOne(member, t);
  }
  function groupBatchItems(items) {
    return TranslationBatch.groupContextualTexts(
      items.map((item) => item.text),
      items.map((item) => isNmtProvider() ? "" : item.context || "")
    ).map((group) => ({
      text: group.text,
      context: group.context,
      members: group.indices.map((index) => items[index]),
    }));
  }
  // in-flight 中にページ側が文字を直した場合、MutationObserver 時点では queuedNodes に阻まれていた新値を
  // 応答解放時に再キューする。applyOne の exact current-value guard と組み合わせ、古い訳文は適用しない。
  function releaseBatchItem(item) {
    for (const member of batchMembers(item)) {
      queuedNodes.delete(member.node);
      if (member.node.isConnected && member.node.nodeValue !== member.text && !translatedNodes.has(member.node)) {
        enqueue(member.node, member._y);
      }
    }
  }
  // バッチ全体に適用 (最終確定)。streaming で既に適用済みのノードは nodeValue 不一致で applyOne がスキップする。
  function applyTranslations(batch, translations) {
    for (let i = 0; i < batch.length; i++) applyBatchItem(batch[i], translations[i]);
  }
  // 原文→訳文をメモに登録 (同一原文の再翻訳を API なしでキャッシュ適用するため)。上限超過後は新規登録のみ止める。
  // バッチ応答を原文→訳文メモに登録する。SPA 再レンダで Text ノード実体が差し替わっても、同一原文を
  // API に再送せずキャッシュ適用するためのもの。full=true は「完全な正常応答 (res.ok)」を表す。
  // full のとき訳文=原文 (LLM が『既に target 言語』等で原文を返した・固有名詞/記号で変化なし) でも登録する。
  // これをしないと「訳しても変わらないテキスト」がメモに残らず、ノード差し替えのたびに毎回再送信され
  // (= 静止ページでも自動翻訳 ON でトークンを食い続ける)。一方 full=false (部分失敗で原文のまま返った可能性が
  // ある) のときは訳文=原文を登録しない (失敗を『訳不要』と誤キャッシュして永久に未訳化するのを防ぐ)。
  function rememberTranslations(batch, translations, full) {
    for (let i = 0; i < batch.length; i++) {
      const src = batch[i] && batch[i].text;
      const key = batch[i] && memoKey(src, batch[i].context || "");
      const t = translations[i];
      if (typeof src !== "string" || !src || typeof t !== "string" || !t) continue;
      if (t === src && !full) continue; // 部分失敗の原文返しはキャッシュしない (後で訳し直せるよう残す)
      if (translationMemo.size >= MEMO_MAX && !translationMemo.has(key)) continue;
      translationMemo.set(key, t);
    }
  }

  // 翻訳の優先順位を「ページ上から下」にする: enqueue 時に確定した各アイテムの所属ブロック絶対Y(_y)で昇順ソート。
  // 絶対Y(top+scrollY)はスクロール不変なので、flush 時に node 毎の getBoundingClientRect を読み直す必要はない
  // (旧実装は pending 全件で rect を読んでいた → block 単位で enqueue 時に 1 回読む方式に変更し reflow を削減)。
  function sortTopDown(items) {
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
      } else {
        // 陳腐化 (切断/書換済/翻訳済) で捨てるノードは queuedNodes からも外す。残したままだと
        // 以後テキストが変わって再度対象になっても enqueue 冒頭のガードで永久にスキップされる。
        queuedNodes.delete(x.node);
      }
    }
    if (pending.length === 0) { flushing = false; maybeAnnounceDone(myRun); return; }
    // 同一原文を既に訳済みなら API を呼ばずキャッシュ適用する (SPA 再レンダで Text 実体が変わった同文・
    // 繰り返し文言・原文書き戻しの「再翻訳」= 無駄な TRANSLATE_BATCH を防ぐ)。残りだけ API へ送る。
    const toSend = [];
    for (const x of pending) {
      const cached = translationMemo.get(memoKey(x.text, x.context || ""));
      if (cached !== undefined) { queuedNodes.delete(x.node); applyOne(x, cached); }
      else toSend.push(x);
    }
    if (toSend.length === 0) {
      flushing = false;
      if (myRun === runId && translating && queue.length > 0) scheduleFlush();
      else maybeAnnounceDone(myRun);
      return;
    }
    sortTopDown(toSend);
    // 同一 flush 内の「完全一致原文 + 同一文脈」は 1 要素だけ API へ送り、結果を全 Text node へ fan-out する。
    // 原文または文脈が 1 文字でも違えば統合しないため、会話上の意味が違う同じ短文へ別の訳を保持できる。
    const groupedToSend = groupBatchItems(toSend);
    if (!announced) notifyProgress("progress");

    // 共有カーソルから「その時点の currentBatchSize」個ずつ取り出す。
    // → BatchTuner が育てたサイズが同一 flush 内のあとのバッチにも即反映される (旧: flush 開始時のサイズで固定)。
    let cursor = 0;
    async function worker() {
      while (cursor < groupedToSend.length) {
        if (myRun !== runId || fatal || !translating) return;
        // 開始直後の数バッチは小サイズ (TTF 短縮 + 全ワーカーに分散)。以降は自動学習サイズ。
        let size;
        if (warmupLeft > 0) { warmupLeft--; size = WARMUP_BATCH_SIZE; }
        else size = Math.max(1, currentBatchSize);
        const batch = groupedToSend.slice(cursor, cursor + size);
        cursor += batch.length;
        const res = await sendBatchWithRetry(batch, myRun);
        if (myRun !== runId) return;
        for (const b of batch) releaseBatchItem(b);
        // バッチサイズ自動学習は background(tuningMem) を単一ソースとし、ok/エラー問わず nextBatchSize を採用する。
        if (res && res.nextBatchSize) currentBatchSize = res.nextBatchSize;
        if (res && res.ok && Array.isArray(res.translations)) {
          applyTranslations(batch, res.translations);
          rememberTranslations(batch, res.translations, true); // 正常応答 → 訳文=原文 (変化なし) もキャッシュし再送信を断つ
        } else if (res && res.error === "no_api_key") {
          fatal = res; // キーが無ければ何も訳せない → 全体中断
          return;
        } else if (res && res.error === "http" && ((res.status === 400 && !isOversizeRequest(res)) || res.status === 401 || res.status === 403 || res.status === 404) && !isNmtProvider()) {
          // LLM の恒久エラーは全体中断して popup/FAB に理由を通知する (NMT は per-text 制限なので除外):
          //  401/403 = キー無効/失効、400 = リクエスト不正 (モデル非対応パラメータ等)、404 = モデルが見つからない。
          // いずれもリクエスト形状/設定が原因で全バッチ同型 → 1 バッチ失敗なら残りも必ず失敗する。
          // skip して done にすると「未翻訳なのにエラーも出ない (理由不明で詰む)」ため、無言 skip せず原因を見せる。
          // ただし入力サイズ起因の 400/413 (isOversizeRequest) はバッチ固有 → 小バッチ再キューへ流し、
          // 残りのバッチは訳し続ける (BatchTuner が縮めれば後続は通る。全体中断しない)。
          fatal = res;
          return;
        } else if (res && res.error === "http" && res.status === 429 && quotaScope(res) === "day" && !isNmtProvider()) {
          // 無料枠の 1 日上限 (RPD) / 残高切れによる 429。その日は何度投げても・並列を下げても全て 429 になり、
          // リトライ(指数バックオフ)は時間の無駄、droppedTransient で「一部未翻訳」に流すと原因が分からず詰む。
          // 全体中断して popup/FAB に「利用上限に達した」と明示する (errorText が statusQuotaDaily へ展開)。
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
          rememberTranslations(batch, res.translations, false); // 部分成功 → 原文返しは失敗かもしれずキャッシュしない
        } else if (res && (res.error === "incomplete" || isOversizeRequest(res))) {
          // LLM 出力が途中で切れた/入力上限を超えた。確定済みの partial (nodeValue が訳文へ
          // 書き換わったノード) はそのまま残し、まだ原文のままのノードだけ能動的に queue へ戻す。
          // queue に積めば flush 末尾の queue.length>0 判定で再 flush され、BatchTuner が縮めたサイズで
          // 訳し直される。「将来の ingest/スクロール頼み」で done を誤announceし、手動再実行まで未訳放置に
          // なるのを防ぐ。無限ループ防止に再キュー回数を INCOMPLETE_REQUEUE_MAX で打ち切り、超えたら諦める。
          // nextBatchSize が BatchTuner.MIN で下げ止まる場合も、失敗した実 batch の半分以下へ必ず縮める。
          // 1 要素はこれ以上分割できないため同じ入力を再送せず、partial として正直に終了する。
          const attemptedCount = TranslationBatch.attemptedTextCount(res, batch.length);
          if (attemptedCount > 1) currentBatchSize = Math.max(1, Math.min(currentBatchSize, Math.floor(attemptedCount / 2)));
          for (const group of batch) {
            for (const b of batchMembers(group)) {
              if (!b.node.isConnected || b.node.nodeValue !== b.text || translatedNodes.has(b.node)) continue;
              // 再キュー上限を超えて諦めたノードは未訳のまま残る。transient drop と同様に数え、
              // done を partial で正直に通知する (「完了なのに一部未訳」の無言化を防ぐ)。
              if (attemptedCount === 1 || (b.incompleteRetry || 0) >= INCOMPLETE_REQUEUE_MAX) {
                translatedNodes.add(b.node); droppedTransient++; continue;
              }
              b.incompleteRetry = (b.incompleteRetry || 0) + 1;
              queuedNodes.add(b.node);
              queue.push(b);
            }
          }
        } else {
          // 訳文を伴わない一時エラーで諦めたバッチは、再翻訳ループを防ぐため処理済み扱いで飛ばし、残りは続ける。
          // 429/503/通信などレート制限・混雑由来の諦めは未訳ノード数を数え、done 時に「一部未翻訳」を正直に通知する
          // (無言 skip で「完了なのに訳されてない」を防ぐ)。
          // stale_session (SW 再起動でセッション復元に失敗した後続バッチ) も未訳のまま残るので数える
          // (通常は myRun ガード/ensurePageSessions で先に救済され、ここに来るのは縁ケースのみ)。
          const isTransientDrop = res && (res.error === "network" || res.error === "runtime" || res.error === "stale_session" ||
            (res.error === "http" && (res.status === 429 || res.status >= 500)) || isOversizeRequest(res));
          for (const group of batch) {
            for (const b of batchMembers(group)) {
              translatedNodes.add(b.node);
              if (isTransientDrop) droppedTransient++;
            }
          }
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
      dbg("DONE announced (queue 空) droppedTransient=", droppedTransient);
      announced = true;
      // レート制限/混雑(429/503)でリトライ枯渇し未訳のまま諦めたノードがあれば partial を立て、
      // popup が「完了」ではなく「一部未翻訳(レート制限)」を出せるようにする (一部は訳せているので state は done のまま)。
      notifyProgress("done", droppedTransient > 0 ? { partial: true } : undefined);
    }
  }

  function notifyProgress(state, extra) {
    try {
      // callback 省略の sendMessage は Promise を返す。受信側不在 (SW 起動の隙間等) の reject は
      // 同期 catch では拾えず unhandled rejection になるので、戻り Promise にも .catch を付けて無視する。
      const p = chrome.runtime.sendMessage(Object.assign({ action: A.TRANSLATION_PROGRESS, state }, extra || {}));
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (_e) { /* context 失効 (同期例外) は無視 */ }
  }

  // ---- IntersectionObserver: ビューポート(+先読み)に入ったブロックを翻訳 ----
  function onIntersect(entries) {
    if (!translating) return;
    let added = false;
    const sy = window.scrollY || window.pageYOffset || 0;
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const block = entry.target;
      io.unobserve(block);        // 一度可視になったら監視解除 (翻訳は一度きり)
      flushedBlocks.add(block);
      // entry.boundingClientRect は IO 仕様上常に存在し追加読みなし。万一欠落時のみ block を実測フォールバック
      // (0 固定だと画面下部の block が y=sy で上位に誤ソートされるのを防ぐ)。
      const y = (entry.boundingClientRect ? entry.boundingClientRect.top : block.getBoundingClientRect().top) + sy;
      const snapshot = isNmtProvider() ? null : blockContextSnapshot(block);
      for (const node of collectNodes(block)) {
        enqueue(node, y, snapshot ? translationContext(node, block, snapshot) : "");
        added = true;
      }
    }
    if (added) scheduleFlush();
  }

  // 0×0 で observe した block の再評価/RO 監視を打ち切る。
  function detachZeroSized(block) {
    zeroSizedBlocks.delete(block);
    if (ro) { try { ro.unobserve(block); } catch (_e) { /* noop */ } }
  }
  // DOM から外れた 0×0 block を掃除して RO の強参照を解放する。0×0 のまま resize せず除去された block は
  // onResize も ingest 再収集も来ず detach されないため、再走査タイミングで列挙して回収する(リーク上限)。
  function sweepZeroSized() {
    if (zeroSizedBlocks.size === 0) return;
    for (const b of zeroSizedBlocks) { if (!b.isConnected) detachZeroSized(b); } // Set は反復中の delete 安全
  }

  // 初回 0×0 で io.observe した block が、後から高さを得て near 化したら即翻訳へ promote する単一ソース。
  // ingest(reingest/MO 由来) と onResize(ResizeObserver 由来) の双方から呼ぶ。promote した block の全ノードを enqueue する。
  // 戻り値: enqueue したか(呼び出し側が scheduleFlush するため)。
  function promoteSizedBlock(block, meta) {
    if (!translating || !block) return false;
    if (flushedBlocks.has(block)) { detachZeroSized(block); return false; } // 既に取り込み済み
    if (!block.isConnected) { detachZeroSized(block); return false; }        // DOM から外れた
    // meta を渡されたら共有(ingest の metaCache 経由=同一 block を複数ノードで再評価しても rect は 1 回読み)。
    // onResize はサイズ変化イベントなので最新 rect が要る → 渡さず blockMeta で読み直す。
    const m = meta || blockMeta(block);
    if (m.zeroSized) return false;        // まだ 0×0 → 監視継続(次の resize/tick で再評価)
    detachZeroSized(block);                // サイズ確定 → 再評価/RO 監視を終了
    if (!m.near) return false;             // サイズは付いたが画面外 → IO(スクロール発火)に委ねる(io.observe 済み)
    if (io) { try { io.unobserve(block); } catch (_e) { /* noop */ } } // IO 後発火による二重取り込みを止める
    flushedBlocks.add(block);              // 以後この block 内の動的追加も即取り込み(冪等)
    let added = false;
    const snapshot = isNmtProvider() ? null : blockContextSnapshot(block);
    for (const node of collectNodes(block)) {
      enqueue(node, m.y, snapshot ? translationContext(node, block, snapshot) : "");
      added = true;
    } // collectNodes は既訳ノードを accept で弾く
    return added;
  }

  // ---- ResizeObserver: 初回 0×0 だった block の高さ確定を能動検知 ----
  // チャート(canvas/svg)のピクセル描画は DOM mutation を伴わずレイアウトサイズだけ変える=MO/IO では拾えないため、
  // サイズ変化そのものを購読する ResizeObserver で「描画完了でパネルに高さが付いた瞬間」を捉えて即翻訳する。
  function onResize(entries) {
    if (!translating) return;
    let added = false;
    for (const entry of entries) { if (promoteSizedBlock(entry.target)) added = true; }
    dbg("onResize entries=", entries.length, "promoted→queue=", added, "queue=", queue.length);
    if (added) scheduleFlush();
  }

  // ---- MutationObserver: 動的追加 (無限スクロール / SPA) を取り込む ----
  // style 属性文字列を DOM(CSSOM) に解釈させ "display" 宣言の実値 (無ければ null) だけを取り出す使い捨て要素。
  // 正規表現での文字列走査だと content:"display: grid" や background:url(...display:none...)、
  // カスタムプロパティ (--x: display:none) 等、他プロパティの値中に現れる "display:" を誤検知しうるため、
  // ブラウザ標準の CSSStyleDeclaration パーサに解釈させて実際の宣言だけを安全に得る。document に接続しない
  // ため layout/paint は発生しない (cssText 代入は純粋な CSSOM 文字列パース)。
  const displayProbe = document.createElement("div");
  function extractDisplayValue(styleStr) {
    displayProbe.style.cssText = styleStr || "";
    const v = displayProbe.style.display;
    return v ? v.trim().toLowerCase() : null;
  }
  // style 属性の変化が display プロパティに触れているときだけ true。動画のシークバー/プログレスバー等は
  // 再生中ずっと width/left/transform 等の style を高頻度に書き換え続けるが、それらは可視性とは無関係。
  // ATTR_FILTER に style を含めた本来の意図 (表示トグルの検知) に絞り込み、可視性と無関係な style 連打で
  // scheduleAttrReingest/ingest が回り続けてメインスレッドを食う (= 動画プレイヤー側の描画が乱れる一因) のを防ぐ。
  // display:none との単純な往復だけでなく、CSSクラス/スタイルシートで隠されていた要素にインラインで
  // display が新規追加/変更/削除される (= オーバーライドで可視化/非表示化しうる) ケースも値の変化として拾う。
  function styleVisibilityChanged(oldVal, newVal) {
    return extractDisplayValue(oldVal) !== extractDisplayValue(newVal);
  }

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
          // (a) 我々が書いた訳文のままなら無視 (自己書き換えでの再発火/ループ防止)。必ず最初に判定する。
          if (tn.nodeValue === writtenValue.get(tn)) continue;
          // (b) ページが「我々が訳した原文」へ書き戻しただけ (SPA 仮想 DOM の同値再適用) → 通常はキャッシュ済みの
          //     訳文を同期で即書き戻す。ページ側も MutationObserver 等で直後に原文へ戻す Web Component では、双方が
          //     マイクロタスク内で書き換え続けると入力イベントまで停止する。短時間の再衝突時はページ側を優先して連鎖を
          //     止める。translatedNodes は維持するため、原文になったノードを再キュー/API 送信するループにも入らない。
          const wv = writtenValue.get(tn);
          if (wv != null && tn.nodeValue === originalMap.get(tn)) {
            const now = Date.now();
            const last = originalReapplyAt.get(tn);
            originalReapplyAt.set(tn, now);
            if (last == null || now - last >= ORIGINAL_REAPPLY_COOLDOWN_MS) tn.nodeValue = wv;
            continue;
          }
          // (c) 別テキストへの実差し替え (チャット編集/SPA 本文入替) → 翻訳済みマーク/原文記録を捨てて訳し直す
          //     (古い訳の残留や復元時の誤上書きを防ぐ)。
          translatedNodes.delete(tn);
          originalMap.delete(tn);
          writtenValue.delete(tn);
          originalReapplyAt.delete(tn);
        }
        ingest(tn.parentNode || tn);
        continue;
      }
      if (m.type === "attributes") {
        const newAttrVal = m.target.getAttribute(m.attributeName);
        // 値が実質変化していない書き戻し (同値の再設定) は無視。class 連打 (動画プレイヤーの自動非表示制御等) で
        // 多いパターンを安価に弾く (文字列1回比較のみ・reflow なし)。
        if (m.oldValue === newAttrVal) continue;
        // style 連打 (動画シークバー等) は可視性遷移があったときだけ通す (詳細は styleVisibilityChanged 参照)。
        if (m.attributeName === "style" && !styleVisibilityChanged(m.oldValue, newAttrVal)) continue;
        // class/style/hidden/aria 等の変化で display:none→表示になったドロップダウン/モーダル/タブ/
        // アコーディオンの中身を取り込む。属性は高頻度で変わる(ホバー/アニメ)ので個別 ingest せず、
        // 対象をためてデバウンス再 ingest する (collectNodes は既訳/監視中ブロックを skip するので冪等)。
        scheduleAttrReingest(m.target);
        continue;
      }
      for (const node of m.addedNodes) ingest(node);
    }
  }

  // 属性駆動の再 ingest。高頻度な属性変化を 250ms に集約し、ためた要素 (および IO 盲点対策で body 全体) を
  // 取り込み直す。子孫関係でネストした要素は ingest の skip 判定で二重処理にならない。
  function scheduleAttrReingest(el) {
    if (el) pendingAttrRoots.add(el);
    if (attrTimer) return;
    attrTimer = window.setTimeout(() => {
      attrTimer = null;
      const roots = pendingAttrRoots;
      pendingAttrRoots = new Set();
      if (!translating || !contextAlive()) return;
      // 属性変化が多発するページ (アニメ/ホバーで class が頻繁に変わる) でも、body全走査は毎秒1回まで。
      if (roots.size > 30) {
        const now = Date.now();
        if (now - lastAttrFullScan >= 1000) {
          lastAttrFullScan = now;
          ingest(document.body || document.documentElement);
        } else {
          // スロットル中に退避済み集合を捨てるだけだと、以後属性変化が止まったとき今回ぶんの表示切替を
          // 永久に取りこぼす。残り時間後に body 全走査を 1 回予約して確実に拾う (待機中に溜まった分も畳まれる)。
          attrTimer = window.setTimeout(() => {
            attrTimer = null;
            if (!translating || !contextAlive()) return;
            lastAttrFullScan = Date.now();
            pendingAttrRoots = new Set();
            ingest(document.body || document.documentElement);
          }, Math.max(50, 1000 - (now - lastAttrFullScan)));
        }
        return;
      }
      for (const r of roots) {
        if (r && r.isConnected) ingest(r);
      }
    }, 250);
  }

  // 初回翻訳 / SPA 遷移後はコンテンツが段階的に描画されるので、REINGEST_DELAYS の各時点で全体を取り込み直す。
  // 描画完了後の再走査で「初回 ingest 時 0-height → 後から高さが付いた」ブロックを near として拾い、IO 非依存で訳す。
  // 前のスケジュールは貼り直し前に解除する (SPA 連続遷移で多重起動しないように)。
  function scheduleReingest() {
    for (const id of reingestTimers) window.clearTimeout(id);
    reingestTimers = REINGEST_DELAYS.map((delay) =>
      window.setTimeout(() => {
        if (!translating || !contextAlive()) return;
        sweepZeroSized(); // DOM から外れた 0×0 block の RO 監視を回収(リーク上限)
        ingest(document.body || document.documentElement, true); // fullRecheck: 非 0×0 だが near 化した block も拾う
      }, delay)
    );
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
      mo.observe(document.body || document.documentElement, MO_OPTS);
    }
    // ResizeObserver は遅延描画(0×0→高さ付与)の能動検知に使う。未対応環境では ro=null のまま
    // zeroSizedBlocks の reingest 再評価がフォールバックする(機能低下のみ・例外なし)。
    if (!ro && typeof ResizeObserver === "function") ro = new ResizeObserver(onResize);
    lastHref = location.href;
    window.removeEventListener("popstate", onPopState);
    window.addEventListener("popstate", onPopState); // 戻る/進む等の SPA 遷移も検知
  }

  function stopObservers() {
    window.removeEventListener("popstate", onPopState);
    if (io) { io.disconnect(); io = null; }
    if (mo) { mo.disconnect(); mo = null; }
    if (ro) { ro.disconnect(); ro = null; }
    zeroSizedBlocks = new Set();
    if (flushTimer) { window.clearTimeout(flushTimer); flushTimer = null; }
    if (attrTimer) { window.clearTimeout(attrTimer); attrTimer = null; }
    lastAttrFullScan = 0;
    pendingAttrRoots = new Set();
    for (const id of reingestTimers) window.clearTimeout(id);
    reingestTimers = [];
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

  // ---- ページ言語検出 (sourceLang=auto の解決) ----
  // 「翻訳先と異なる言語を全部訳す」だと日本語ページに散在する英語メニュー等まで訳してしまう。
  // ページの主要言語を翻訳元として解決し、ページ言語=翻訳先のページは翻訳しない。
  // 翻訳対象と同じ基準 (collectNodes) の実テキストから先頭をサンプルする。
  function samplePageText(limit) {
    let s = "";
    for (const n of collectNodes(document.body || document.documentElement)) {
      const t = (n.nodeValue || "").trim();
      if (t) s += (s ? " " : "") + t;
      if (s.length >= limit) break;
    }
    return s.slice(0, limit);
  }

  // chrome.i18n.detectLanguage (CLD) の言語内訳をそのまま返す ([{language, percentage}] / 不確実時 null)。
  // 主要言語だけでなく割合も使う = 「target 主体でも非 target 本文が一定量混在するページ」を skip しないため。
  function detectLanguagesOf(text) {
    return new Promise((resolve) => {
      try {
        chrome.i18n.detectLanguage(text, (res) => {
          const ok = !chrome.runtime.lastError && res && res.isReliable &&
            Array.isArray(res.languages) && res.languages.length > 0;
          resolve(ok ? res.languages : null);
        });
      } catch (_e) { resolve(null); }
    });
  }

  // 実テキストの CLD 判定を優先し、html lang 属性は補助に使う (テンプレ由来で実内容と違う lang が多いため)。
  // 返り値: { lang, langs }。lang = 主要言語 (正規化・null 可)、langs = [{code, pct}] (skip 判定で非 target の混在量を見る)。
  async function detectPageLang() {
    // 2000 字: ページ先頭に英語ナビ等の異言語が固まっていても、本文まで含めれば CLD は多数派言語を返す
    const text = samplePageText(2000);
    if (text.length >= 40) { // 短文すぎる判定は誤りやすいので CLD には最低量を要求
      const raw = await detectLanguagesOf(text);
      if (raw && raw.length) {
        const langs = raw
          .map((l) => ({ code: (globalThis.Lang && Lang.normalizeCode(l.language)) || null, pct: Number(l.percentage) || 0 }))
          .filter((l) => l.code);
        if (langs.length) return { lang: langs[0].code, langs };
      }
    }
    const attr = (document.documentElement && document.documentElement.lang) || "";
    const norm = (globalThis.Lang && Lang.normalizeCode(attr)) || null;
    return { lang: norm, langs: norm ? [{ code: norm, pct: 100 }] : [] };
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
    originalReapplyAt = new WeakMap();
    recentScopeWrites = new WeakMap();
    translationMemo.clear(); // provider/targetLang 変更での再翻訳時に古い訳をキャッシュ適用しないよう破棄
  }

  async function startTranslate(newSettings, newSessionId, manual) {
    settings = newSettings;
    sessionId = (newSessionId != null) ? newSessionId : null;
    dbg("startTranslate BUILD", RT_BUILD, "top=", window.top === window.self, "src=", newSettings && newSettings.sourceLang, "tgt=", newSettings && newSettings.targetLang, "provider=", newSettings && newSettings.provider, "url=", location.href.slice(0, 80));
    // 再翻訳では前runのobserverが保持する旧DOMターゲットを先に切断する。
    // WeakSet/zeroSizedBlocksだけを作り直すと、削除済み要素がIO/RO側に残り続ける。
    if (io || mo || ro || reingestTimers.length) stopObservers();
    // 2 回目以降の翻訳 (言語/provider 変更で再実行) は先に原文へ戻す。前回の訳が残ると accept() が既訳ノードを
    // 全弾きし、iframe では frameHasEnoughText() が 0 字と誤判定して再翻訳されないため、閾値判定より前に revert する。
    revertTranslations();
    // 広告等の小さな iframe は翻訳しない (メインフレームは常に対象)。
    // 以前このフレームが翻訳中だった場合、ゲート不通過になった今は旧セッションを確実に止める。
    // (translating/observers/queue/runId を残すと、旧 run の遅延バッチが現 runId で適用されたり、
    //  MutationObserver が新 settings で訳し続ける。runId++ で進行中ループ/遅延応答を無効化し observers を破棄。)
    if (!frameHasEnoughText()) {
      dbg("SKIP frameHasEnoughText=false (iframe テキスト不足)");
      translating = false;
      runId += 1;
      stopObservers(); // io/mo 切断 + queue/pendingBatches クリア (未起動なら no-op)
      return;
    }
    // sourceLang=auto はページの主要言語を検出して翻訳元に解決する。
    // 自動翻訳では、ページ言語=翻訳先のページを翻訳しない
    // (日本語ページの英語メニュー等の断片を巻き込まない + API 呼び出しゼロ)。
    // popup/FAB/右クリックからの手動翻訳は、少数の異言語テキストを明示的に訳したい意図なのでこの判定を通さない。
    if (settings.sourceLang === "auto") {
      translating = false; // 検出の await 中は旧 observers/ループを止めておく
      runId += 1;
      const myDetect = runId;
      const detected = await detectPageLang();
      if (runId !== myDetect) return; // 検出中に restore / 別の翻訳開始が走った
      const pageLang = detected.lang;
      // ページ主要言語が翻訳先でも、非翻訳先の言語が一定量混在していれば訳す
      // (日本語UI に囲まれた英語本文記事のような混在ページで、本文を skip で取り残さないため)。
      const otherPct = detected.langs.filter((l) => l.code !== settings.targetLang).reduce((a, l) => a + l.pct, 0);
      const mixedOther = otherPct >= MIXED_LANG_THRESHOLD; // 非 target がこの割合以上 = 混在ページとみなし skip しない (散在する数語の異言語は閾値未満で従来どおり skip)
      const skipSameLanguage = Lang.shouldSkipSameLanguage(pageLang, settings.targetLang, otherPct, MIXED_LANG_THRESHOLD, manual);
      dbg("detectPageLang lang=", pageLang, "langs=", JSON.stringify(detected.langs), "otherPct=", otherPct, "mixedOther=", mixedOther, "manual=", manual);
      if (skipSameLanguage) {
        // 実質ページ全体が翻訳先言語 → 訳すものが無い
        dbg("SKIP same-language (pageLang===targetLang)");
        stopObservers();
        // skip の通知はメインフレームのみ (iframe の skip は frameHasEnoughText 不通過と同様に静かに終わる)
        if (window.top === window.self) notifyProgress("skipped");
        return;
      }
      // 主要言語が翻訳先でないときだけ翻訳元として確定する。混在ページ (target 主体 + 非 target 本文) は
      // sourceLang を "auto" のまま残し、buildSystemPrompt の「target 以外を翻訳」で非 target 本文を拾う。
      if (pageLang && pageLang !== settings.targetLang) settings = Object.assign({}, settings, { sourceLang: pageLang });
    }
    translating = true;
    runId += 1;
    const myRun = runId;
    announced = false;
    fatal = null;
    droppedTransient = 0;
    flushing = false;
    firstFlush = true;
    currentBatchSize = 0;
    warmupLeft = WARMUP_BATCHES; // 開始直後の数バッチは小さく投げて最初の訳を早く出す
    queue.length = 0;
    queuedNodes = new WeakSet();
    pageTextCount = 0;
    pageCharCount = 0;
    pendingBatches.clear(); // 前セッションの streaming partial 紐付けを破棄
    observedBlocks = new WeakSet(); // 再翻訳 (復元→再 ON) で取りこぼさないよう作り直す
    flushedBlocks = new WeakSet();
    observedShadowRoots = new WeakSet();
    zeroSizedBlocks = new Set();
    startObservers();
    notifyProgress("progress");
    dbg("translating=true runId=", myRun, "ResizeObserver=", typeof ResizeObserver === "function");
    ingest(document.body || document.documentElement);
    // 初回 scan 後にアップグレードで open shadow root を遅延 attach する web component を取りこぼさないよう、
    // 少し待ってから再 ingest する (scheduleReingest=350/1200ms)。新規 shadow root とその MutationObserver を拾う。
    // (content script は isolated world で page の attachShadow をフック不可のため、bounded な再走査で対処。)
    scheduleReingest();
    // 翻訳対象が無いページでも状態が固まるよう、保険で done 判定を 1 度入れる
    window.setTimeout(() => maybeAnnounceDone(myRun), 1500);
  }

  function restore() {
    translating = false;
    sessionId = null;
    runId += 1; // 進行中ループを中断
    stopObservers();
    revertTranslations();
    notifyProgress("restored");
  }

  // ---- メッセージ受信 ----
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!contextAlive()) { shutdown(); return undefined; }
    if (!msg || typeof msg.action !== "string") return undefined;
    if (msg.action === A.TRANSLATE_PARTIAL) {
      // streaming の早出し: 確定した訳文要素を該当ノードへ即適用 (最終 sendResponse でも整合確認される)。
      // 復元/再翻訳後は pendingBatches がクリアされ batchId が引けないので適用されない (stale 防止)。
      const batch = pendingBatches.get(msg.batchId);
      if (translating && batch && batch[msg.index]) applyBatchItem(batch[msg.index], msg.text);
      return undefined;
    }
    if (msg.action === A.APPLY_TRANSLATE_CS) {
      startTranslate(msg.settings, msg.sessionId, msg.manual === true).then(() => sendResponse({ ok: true })).catch((e) =>
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
