"use strict";

/**
 * selection-translator.js — 選択テキストのインライン翻訳 (content script・トップフレーム常駐)
 *
 * テキストを選択して割り当て可能なホットキー (manifest commands: translate-selection / 既定 Ctrl+Shift+L)
 * または右クリック「選択テキストを翻訳」を実行すると、選択範囲の近くに浮遊バブルで訳文を出す。
 * 起動の合図 (TRANSLATE_SELECTION_CS) は background から来る (SW はページ選択を直接読めないため)。
 * 翻訳はユーザーの明示操作でのみ起き、「選択しただけ」では送らない (FAB/画像翻訳と同じ "勝手に送らない" 原則)。
 *
 * actions.js が先に注入される前提 (globalThis.Actions/StorageKeys を使う)。実翻訳は popup クイック翻訳と同形で
 * background 経由 (TRANSLATE_BATCH + quick:true)。API キーは content に渡さず SW 保管値を使う。
 * UI はページ CSS と衝突しないよう #__rt_sel_bubble に all:initial + __rt-sel-* 接頭辞で隔離する (selection-translator.css)。
 */

(function () {
  if (window.__rtSelectionLoaded) return;
  window.__rtSelectionLoaded = true;
  if (window.top !== window.self) return; // トップフレームのみ (iframe 内選択は対象外。fab.js と同方針)
  if (/^(video|audio)\//.test(document.contentType || "")) return; // メディア直開きは翻訳対象テキスト無し

  const A = globalThis.Actions;
  const CFLAGS_KEY = (globalThis.StorageKeys && globalThis.StorageKeys.CONTENT_FLAGS) || "contentFlags";
  if (!A) return;

  // 選択テキストの最大長。Ctrl+A でページ全文を選択したまま起動すると巨大な 1 リクエストになり、
  // LLM は context/output 上限で失敗・MyMemory は too_long と、いずれも課金と待ち時間だけ消えるため
  // 送信前に弾く。上限値と文言は popup クイック翻訳 (MAX 5000 / qtTooLong) と共有する。
  const MAX_SEL_CHARS = 5000;

  let mode = "bubble";     // 表示方法 "bubble"=浮遊バブル / "inline"=選択ブロック直後に対訳差し込み (CONTENT_FLAGS から読む)
  let inlineEls = [];      // 挿入済みインライン対訳要素 (累積保持。各 × / 原文復元 / リロードで除去)
  let dead = false;        // shutdown 済み
  let reqId = 0;           // 進行中翻訳の世代。新トリガー/消去で進めて stale 応答を捨てる
  let bubble = null;       // バブル要素 (1 つだけ)
  let textEl = null;       // 訳文/状態テキスト
  let copyBtn = null;      // コピーボタン
  let listening = false;   // dismiss リスナの登録状態
  let selRaf = 0;          // selectionchange の rAF coalesce
  let posRaf = 0;          // scroll/resize 再配置の rAF coalesce
  let lastSelRoot = null;  // 直近に選択が見つかった shadow root (scroll 連打での再走査を避けるキャッシュ)

  const contextAlive = ExtUtil.contextAlive; // 拡張 context 生存判定 (actions.js の共有実装)
  const tr = ExtUtil.tr;                     // i18n 取得 (同上)

  // 翻訳失敗の理由を i18n に展開する (popup の errorText / fab の errSummary と同じキーを再利用)。
  // 全 SW error 種別を網羅する: 漏れがあると generic「エラー」に倒れて原因が分からなくなる
  // (parse/incomplete/build/empty などは LLM 応答が JSON 崩れ・要素数不一致のときの SW 自己診断種別)。
  function selErrorText(res) {
    const generic = tr("statusError", "エラー");
    if (!res || typeof res !== "object") return generic;
    const e = res.error;
    if (e === "no_api_key") return tr("statusNoKey", "API キーが未設定です");
    if (e === "network" || e === "runtime" || e === "context") return tr("statusNetwork", "ネットワークエラー");
    if (e === "http") {
      if (res.status === 401 || res.status === 403) return tr("statusBadKey", "API キーが無効か権限がありません");
      if (res.status === 429) return tr("statusQuotaDaily", "API の利用上限に達しました");
      return `HTTP ${res.status || ""}`.trim();
    }
    // MyMemory 共有キーの quota 枯渇 (本文 200 でも responseStatus に 403/429 が入る) は http 429 と同じ表現に倒す。
    if (e === "quota") return tr("statusQuotaDaily", "API の利用上限に達しました");
    // バッチ非対応プロバイダで 1 テキストが上限超過。クイック翻訳と同じ文言で長さ起因と明示する。
    if (e === "too_long") return tr("qtLimit", "このサービスには長すぎます（短くするか LLM プロバイダを選んでください）");
    return generic;
  }

  // bubble.title に出すデバッグ詳細 (どの error 種別/HTTP status か)。本文文字列だけでは parse/incomplete/build を
  // 区別できず原因特定が遅れるため、ホバー tooltip で読めるようにする (fab.js の errText と同方針)。
  function selErrorDetail(res) {
    if (!res || typeof res !== "object") return "";
    const e = res.error || "unknown";
    const parts = [e];
    if (res.status) parts.push(`HTTP ${res.status}`);
    if (res.message) parts.push(String(res.message).slice(0, 200));
    return parts.join(" — ");
  }

  // ---- 選択範囲 (Shadow DOM 対応) ----
  // window.getSelection() は Chrome/Firefox とも shadow tree 内の選択を貫通せず anchorNode が shadow host に
  // なる (Reddit のサイドパネル等 Web Components で選択が取れない主因)。通常選択が空なら host の
  // shadowRoot.getSelection() (Chromium/Firefox がサポート) へ降り、さらに保険で開いた shadow root を辿って探す
  // (translator.js の collectNodes と同じ "開いた shadowRoot を辿る" 方針)。
  function selText(sel) {
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return "";
    return String(sel).trim();
  }
  function rectFor(sel) {
    try {
      const r = sel.getRangeAt(0).getBoundingClientRect();
      if (r && (r.width || r.height)) return r;
    } catch (_e) { /* noop */ }
    // range の rect が空 (一部 shadow 経路の既知の癖) のときは anchorNode 周辺へフォールバック
    try {
      const a = sel.anchorNode;
      const el = a && (a.nodeType === 1 ? a : a.parentElement);
      const r = el && el.getBoundingClientRect && el.getBoundingClientRect();
      if (r && (r.width || r.height)) return r;
    } catch (_e) { /* noop */ }
    return null;
  }
  // 開いた shadow root を辿って選択を持つ root を探す (見つけたら lastSelRoot にキャッシュ)。
  function scanShadowSelection(root, depth) {
    if (!root || depth > 8) return null;
    let els;
    try { els = root.querySelectorAll("*"); } catch (_e) { return null; }
    for (const el of els) {
      const sr = el.shadowRoot;
      if (!sr) continue;
      if (typeof sr.getSelection === "function") {
        const s = sr.getSelection();
        if (selText(s)) { lastSelRoot = sr; return s; }
      }
      const nested = scanShadowSelection(sr, depth + 1);
      if (nested) return nested;
    }
    return null;
  }
  // いまアクティブな選択 (通常 or shadow 内) を返す。無ければ null。
  function deepSelection() {
    const top = window.getSelection();
    if (selText(top)) { lastSelRoot = null; return top; }
    // 直近の shadow root を先に試す (scroll/selectionchange 連打での再走査を避ける)
    if (lastSelRoot && typeof lastSelRoot.getSelection === "function") {
      const s = lastSelRoot.getSelection();
      if (selText(s)) return s;
    }
    // anchorNode が shadow host のとき中の選択へ降りる (ネスト shadow も辿る)
    let cur = top, guard = 0;
    while (cur && guard++ < 12) {
      const a = cur.anchorNode;
      const host = a && (a.nodeType === 1 ? a : a.parentElement);
      const sr = host && host.shadowRoot;
      if (!sr || typeof sr.getSelection !== "function") break;
      const inner = sr.getSelection();
      if (!inner || inner === cur) break;
      if (selText(inner)) { lastSelRoot = sr; return inner; }
      cur = inner;
    }
    // 保険: 開いた shadow root を全走査 (anchorNode 経路が外れた場合)
    const found = scanShadowSelection(document, 0);
    if (!found) lastSelRoot = null;
    return found;
  }

  // ---- バブル ----
  function ensureBubble() {
    if (bubble) return;
    bubble = document.createElement("div");
    bubble.id = "__rt_sel_bubble";
    bubble.className = "__rt-sel-bubble";

    const body = document.createElement("div");
    body.className = "__rt-sel-body";
    textEl = document.createElement("span");
    textEl.className = "__rt-sel-text";
    body.appendChild(textEl);

    const foot = document.createElement("div");
    foot.className = "__rt-sel-foot";
    copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "__rt-sel-copy";
    copyBtn.textContent = tr("selCopy", "コピー");
    copyBtn.addEventListener("click", onCopy);
    foot.appendChild(copyBtn);

    bubble.append(body, foot);
    (document.body || document.documentElement).appendChild(bubble);
    attachListeners();
  }

  function removeBubble() {
    if (selRaf) { cancelAnimationFrame(selRaf); selRaf = 0; }
    if (posRaf) { cancelAnimationFrame(posRaf); posRaf = 0; }
    reqId++; // 進行中の応答を無効化 (返ってきても描かない)
    detachListeners();
    if (!bubble) return;
    try { if (copyBtn && copyBtn._t) clearTimeout(copyBtn._t); } catch (_e) { /* noop */ }
    try { bubble.remove(); } catch (_e) { /* noop */ }
    bubble = null; textEl = null; copyBtn = null;
  }

  // kind: "loading" | "result" | "error"。hint はエラー時に bubble.title へ載せるデバッグ詳細 (任意)。
  function setState(kind, text, hint) {
    if (!bubble) return;
    bubble.classList.remove("__rt-sel-loading", "__rt-sel-result", "__rt-sel-error");
    bubble.classList.add(kind === "error" ? "__rt-sel-error" : (kind === "result" ? "__rt-sel-result" : "__rt-sel-loading"));
    if (textEl) textEl.textContent = text || "";
    // エラー時のみ tooltip に原因を載せる (parse/incomplete/build を generic「エラー」表示と区別する)。
    bubble.title = (kind === "error" && hint) ? hint : "";
    if (copyBtn) {
      copyBtn.style.display = (kind === "result" && text) ? "" : "none";
      copyBtn.textContent = tr("selCopy", "コピー");
      copyBtn.classList.remove("__rt-sel-copied");
      if (copyBtn._t) { clearTimeout(copyBtn._t); copyBtn._t = 0; }
    }
    reposition();
  }

  function placeBubble(rect) {
    if (!bubble) return;
    const gap = 8, margin = 8;
    const bw = bubble.offsetWidth, bh = bubble.offsetHeight;
    let left = rect.left + rect.width / 2 - bw / 2;
    left = Math.min(Math.max(margin, left), Math.max(margin, window.innerWidth - bw - margin));
    let top = rect.top - bh - gap;       // 既定は選択の上
    if (top < margin) top = rect.bottom + gap; // 上に余白が無ければ下へ
    top = Math.min(Math.max(margin, top), Math.max(margin, window.innerHeight - bh - margin));
    bubble.style.left = `${left}px`;
    bubble.style.top = `${top}px`;
  }

  function reposition() {
    if (!bubble) return;
    const sel = deepSelection();
    const rect = sel && rectFor(sel);
    if (!rect) { removeBubble(); return; } // 選択が消えたら閉じる
    placeBubble(rect);
  }

  function onCopy(e) {
    e.stopPropagation();
    const t = (textEl && textEl.textContent) || "";
    if (!t || !copyBtn) return;
    try { navigator.clipboard.writeText(t); } catch (_e) { /* noop */ }
    copyBtn.textContent = tr("selCopied", "✓ コピー");
    copyBtn.classList.add("__rt-sel-copied");
    if (copyBtn._t) clearTimeout(copyBtn._t);
    copyBtn._t = window.setTimeout(() => {
      if (!copyBtn) return;
      copyBtn.textContent = tr("selCopy", "コピー");
      copyBtn.classList.remove("__rt-sel-copied");
    }, 1300);
  }

  // ---- インライン対訳 (選択ブロックの直後に訳文を差し込む。墨色本文 + 左に朱の縦線で原文と区別) ----
  // バブルと違い「選択しただけ」では出さず、明示トリガー時に挿入する。累積保持し、各 × / 原文復元 / リロードで消える。

  // テキストノード/要素から、ブロックレベルの祖先要素を返す (対訳をその直後＝原文の下に置くため)。
  // 部分選択 (段落内の数語) でも段落の直後に差し込む = Immersive の選択インラインと同方針。
  function blockAncestorEl(node) {
    let el = node && (node.nodeType === 1 ? node : node.parentElement);
    // table と inline-table のみブロック扱い。table-cell/table-row/table-row-group 等まで拾うと <td>/<tr> を返してしまい、
    // その直後 (= <tr>/<tbody> 直下) に div を挿入して不正な表構造になる → セル選択時は上位の <table> 直後へ挿入させる。
    const blockish = (d) => d === "block" || d === "flex" || d === "grid" || d === "list-item" || d === "table" || d === "inline-table";
    while (el && el.parentElement && el !== document.body && el !== document.documentElement) {
      let d = "";
      try { d = getComputedStyle(el).display; } catch (_e) { /* noop */ }
      if (blockish(d)) return el;
      el = el.parentElement;
    }
    return el || document.body || document.documentElement;
  }

  // CSS クラス (.__rt-sel-inline) は light DOM でしか効かない。shadow 内へ挿入したときは selection-translator.css が
  // 届かないので、最低限の見た目を inline style で当てる (色は本文と同じ inherit + 朱の左縦線で区別)。
  function applyShadowFallbackStyle(host, textEl, xBtn) {
    host.__rtShadow = true;
    host.style.cssText = "all:initial;display:block;box-sizing:border-box;position:relative;margin:6px 0 10px;" +
      "padding:6px 30px 6px 12px;border-left:3px solid #d8462b;background:rgba(216,70,43,.06);color:inherit;" +
      "font:inherit;font-size:0.95em;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;border-radius:0 3px 3px 0;";
    if (textEl) textEl.style.cssText = "color:inherit;font-style:italic;opacity:.65;";
    if (xBtn) xBtn.style.cssText = "all:unset;position:absolute;top:4px;right:6px;cursor:pointer;font-size:14px;line-height:1;color:#9aa3b2;padding:2px 4px;";
  }

  function buildInlineHost() {
    const host = document.createElement("div");
    host.className = "__rt-sel-inline __rt-sel-inline-loading";
    const textEl = document.createElement("span");
    textEl.className = "__rt-sel-inline-text";
    const xBtn = document.createElement("button");
    xBtn.type = "button";
    xBtn.className = "__rt-sel-inline-x";
    xBtn.textContent = "×"; // ×
    xBtn.setAttribute("aria-label", tr("selClose", "閉じる"));
    xBtn.title = tr("selClose", "閉じる");
    xBtn.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); closeInline(host); });
    host.append(textEl, xBtn);
    host.__rtText = textEl;
    return host;
  }

  // kind: "loading" | "result" | "error"。hint はエラー時に host.title へ載せるデバッグ詳細 (任意)。
  function setInlineState(host, kind, text, hint) {
    if (!host) return;
    host.classList.remove("__rt-sel-inline-loading", "__rt-sel-inline-result", "__rt-sel-inline-error");
    host.classList.add(kind === "error" ? "__rt-sel-inline-error" : (kind === "result" ? "__rt-sel-inline-result" : "__rt-sel-inline-loading"));
    if (host.__rtText) host.__rtText.textContent = text || "";
    host.title = (kind === "error" && hint) ? hint : "";
    // shadow フォールバック時は CSS クラスが効かないので状態色を inline style で反映する。
    if (host.__rtShadow && host.__rtText) {
      host.__rtText.style.color = kind === "error" ? "#d8462b" : "inherit";
      host.__rtText.style.fontStyle = kind === "loading" ? "italic" : "normal";
      host.__rtText.style.opacity = kind === "loading" ? ".65" : "1";
    }
  }

  function closeInline(host) {
    const i = inlineEls.indexOf(host);
    if (i >= 0) inlineEls.splice(i, 1);
    try { host.remove(); } catch (_e) { /* noop */ }
  }

  // 全インライン対訳を撤去 (原文復元 APPLY_RESTORE_CS で呼ぶ = FAB/popup の「原文に戻す」と連動)。
  function clearAllInline() {
    for (const el of inlineEls.splice(0, inlineEls.length)) {
      try { el.remove(); } catch (_e) { /* noop */ }
    }
  }

  // 選択が編集領域 (contentEditable) 内か。リッチエディタ (Gmail 作成 / GitHub コメント欄等) の選択へ
  // 対訳ブロックを挿入するとユーザーの編集内容を壊すため、インライン挿入を避けてバブルへフォールバックする判定に使う。
  function isEditableSelection(sel) {
    try {
      if (!sel) return false;
      const editable = (n) => { const el = n && (n.nodeType === 1 ? n : n.parentElement); return Boolean(el && el.isContentEditable); };
      // 始点(anchor)と終点(focus)の両方を見る: 通常テキストから contenteditable へドラッグした選択でも、
      // insertInline は range 終端側へ挿入するため、片側でも編集領域なら inline 挿入を避けてバブルへ倒す (草稿破壊の防止)。
      return editable(sel.anchorNode) || editable(sel.focusNode);
    } catch (_e) { return false; }
  }

  // 選択ブロックの直後に loading 状態の対訳を挿入し、host を返す (失敗時 null)。
  function insertInline(sel) {
    let range;
    try { range = sel.getRangeAt(sel.rangeCount - 1); } catch (_e) { return null; }
    if (!range) return null;
    const block = blockAncestorEl(range.endContainer);
    if (!block || !block.parentNode) return null;
    const host = buildInlineHost();
    // 配置と色を決めるため block(と親)の実効スタイルを読む。
    let inside = false, blockColor = "";
    try {
      const bs = getComputedStyle(block);
      blockColor = bs.color;
      let pd = "";
      try { pd = getComputedStyle(block.parentNode).display; } catch (_e2) { /* parentNode が document 等で取れない場合は sibling 挿入 */ }
      // 既定は block の直後(sibling)。ただし下記はコンテナ構造/レイアウトを壊すので block の内側(末尾)へ入れる:
      //  - block が list-item: <ul>/<ol> の直子に非 li の div を作らない (記号/間隔が崩れない)
      //  - block の親が flex/grid: host が新たな flex/grid item になって隣の列/セルへ流れない
      inside = bs.display === "list-item" || /flex|grid/.test(pd);
    } catch (_e) { /* noop */ }
    try {
      if (inside) block.appendChild(host);
      else block.parentNode.insertBefore(host, block.nextSibling);
    } catch (_e) { return null; }
    // shadow 内へ入った場合は CSS が効かないので inline style フォールバックを当てる (light DOM なら CSS クラスに任せる)。
    const root = host.getRootNode ? host.getRootNode() : document;
    if (root && root !== document) applyShadowFallbackStyle(host, host.__rtText, host.querySelector(".__rt-sel-inline-x"));
    // 選択ブロックの実効文字色をコピーする。sibling 挿入では color:inherit が挿入先の親から継承するため、
    // 白文字 on 暗色カード等で訳文が読めなくなる。原文と同じ色で出す ("本文と同じ色に追従" の意図に忠実)。
    if (blockColor) { try { host.style.color = blockColor; } catch (_e) { /* noop */ } }
    inlineEls = inlineEls.filter((el) => el.isConnected); // SPA がページごと旧 host を外したら参照を掃除 (累積配列のリーク防止)
    inlineEls.push(host);
    return host;
  }

  function triggerInline(text, sel) {
    const host = insertInline(sel);
    if (!host) return;
    setInlineState(host, "loading", tr("selTranslating", "翻訳中…"));
    sendBatch(text, (res) => {
      if (dead || !host.isConnected) return; // 待つ間に × / 復元 / リロードで消えたら破棄
      if (res && res.ok && Array.isArray(res.translations) && res.translations[0]) {
        setInlineState(host, "result", res.translations[0]);
      } else {
        setInlineState(host, "error", selErrorText(res), selErrorDetail(res));
      }
    });
  }

  // ---- dismiss (バブル外クリック / Esc / 選択解除 / スクロール) ----
  function onDocPointerDown(e) {
    if (bubble && e.target && bubble.contains(e.target)) {
      // バブル内 (コピー操作) は維持。default を止めてページ選択の解除を防ぐ
      // (解除されると selectionchange でバブルが即閉じてしまうため)。click は別途発火するのでコピーは効く。
      e.preventDefault();
      return;
    }
    removeBubble();
  }
  function onKeyDown(e) { if (e.key === "Escape") removeBubble(); }
  function onSelChange() {
    if (selRaf) return;
    selRaf = window.requestAnimationFrame(() => {
      selRaf = 0;
      if (!selText(deepSelection())) removeBubble(); // 選択が空になったら閉じる (shadow 内も考慮)
    });
  }
  function onScrollResize() {
    if (posRaf) return;
    posRaf = window.requestAnimationFrame(() => { posRaf = 0; reposition(); });
  }
  function attachListeners() {
    if (listening) return;
    listening = true;
    document.addEventListener("pointerdown", onDocPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("selectionchange", onSelChange);
    window.addEventListener("scroll", onScrollResize, true);
    window.addEventListener("resize", onScrollResize);
  }
  function detachListeners() {
    if (!listening) return;
    listening = false;
    try { document.removeEventListener("pointerdown", onDocPointerDown, true); } catch (_e) { /* noop */ }
    try { document.removeEventListener("keydown", onKeyDown, true); } catch (_e) { /* noop */ }
    try { document.removeEventListener("selectionchange", onSelChange); } catch (_e) { /* noop */ }
    try { window.removeEventListener("scroll", onScrollResize, true); } catch (_e) { /* noop */ }
    try { window.removeEventListener("resize", onScrollResize); } catch (_e) { /* noop */ }
  }

  // ---- 翻訳 ----
  function sendBatch(text, cb) {
    try {
      chrome.runtime.sendMessage({ action: A.TRANSLATE_BATCH, texts: [text], quick: true }, (res) => {
        if (chrome.runtime.lastError) { cb({ ok: false, error: "runtime", message: chrome.runtime.lastError.message }); return; }
        cb(res || { ok: false, error: "empty" });
      });
    } catch (_e) {
      shutdown();
      cb({ ok: false, error: "context" });
    }
  }

  // ホットキー/右クリックの合図で起動する。選択中テキストを訳してバブル表示する。
  function trigger() {
    if (dead) return;
    if (!contextAlive()) { shutdown(); return; }
    const sel = deepSelection();
    const text = selText(sel);
    // 上限超過は API へ送らず理由を出す。インライン経路も含めてバブルで出す (インラインは累積保持で
    // 消えないため、一時的なエラー表示をページへ残さない)。
    if (text.length > MAX_SEL_CHARS) {
      if (!rectFor(sel)) { removeBubble(); return; }
      reqId++; // 進行中の応答があれば捨てる (この操作が最新の意図)
      ensureBubble();
      setState("error", tr("qtTooLong", "5,000 文字を超えています"));
      return;
    }
    // インラインモード: 選択ブロックの直後に対訳を差し込む (rect は不要。累積保持なので選択解除でも消さない)。
    // ただし編集領域 (contentEditable) 内の選択はページの編集内容を壊すので挿入せず、下のバブル表示へフォールバックする。
    if (mode === "inline" && text && !isEditableSelection(sel)) { triggerInline(text, sel); return; }
    if (!text) { removeBubble(); return; } // 選択が無ければ何もしない (右クリック経路は選択時のみ出る)
    if (!rectFor(sel)) { removeBubble(); return; }
    ensureBubble();
    setState("loading", tr("selTranslating", "翻訳中…"));
    const my = ++reqId;
    sendBatch(text, (res) => {
      if (my !== reqId || dead) return; // 待つ間に閉じた/再トリガーされたら破棄
      if (res && res.ok && Array.isArray(res.translations) && res.translations[0]) {
        setState("result", res.translations[0]);
      } else {
        setState("error", selErrorText(res), selErrorDetail(res));
      }
    });
  }

  function onRuntimeMessage(m) {
    if (!m) return;
    if (m.action === A.TRANSLATE_SELECTION_CS) { trigger(); return; }
    // FAB/popup の「原文に戻す」(RESTORE_PAGE→APPLY_RESTORE_CS) で、ページ翻訳と一緒にインライン対訳も撤去する。
    if (m.action === A.APPLY_RESTORE_CS) { clearAllInline(); return; }
  }

  function shutdown() {
    if (dead) return;
    dead = true;
    removeBubble();
    try { chrome.runtime.onMessage.removeListener(onRuntimeMessage); } catch (_e) { /* noop */ }
  }

  // ---- 起動 ----
  try { chrome.runtime.onMessage.addListener(onRuntimeMessage); } catch (_e) { /* noop */ }

  // 表示方法フラグを読む (非機密フラグのみ。API キーは読まない)。popup の変更に storage.onChanged で即追従。
  try {
    chrome.storage.local.get(CFLAGS_KEY, (d) => {
      const f = d && d[CFLAGS_KEY];
      if (f && typeof f.selectionMode === "string") mode = f.selectionMode === "inline" ? "inline" : "bubble";
    });
  } catch (_e) { /* noop */ }
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes[CFLAGS_KEY]) return;
      const v = changes[CFLAGS_KEY].newValue;
      if (v && typeof v.selectionMode === "string") {
        mode = v.selectionMode === "inline" ? "inline" : "bubble";
        if (mode === "inline") removeBubble(); // インラインへ切替えたら開いているバブルを閉じる
      }
    });
  } catch (_e) { /* noop */ }
})();
