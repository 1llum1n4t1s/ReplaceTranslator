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

  let enabled = true;      // selectionTranslate フラグ (CONTENT_FLAGS から読む。OFF なら起動しない)
  let dead = false;        // shutdown 済み
  let reqId = 0;           // 進行中翻訳の世代。新トリガー/消去で進めて stale 応答を捨てる
  let bubble = null;       // バブル要素 (1 つだけ)
  let textEl = null;       // 訳文/状態テキスト
  let copyBtn = null;      // コピーボタン
  let listening = false;   // dismiss リスナの登録状態
  let selRaf = 0;          // selectionchange の rAF coalesce
  let posRaf = 0;          // scroll/resize 再配置の rAF coalesce

  function contextAlive() {
    try { return Boolean(chrome.runtime && chrome.runtime.id); } catch (_e) { return false; }
  }
  function tr(key, fallback) {
    try { const m = chrome.i18n && chrome.i18n.getMessage(key); return m || fallback; } catch (_e) { return fallback; }
  }

  // 翻訳失敗の理由を i18n に展開する (popup の errorText / fab の errSummary と同じキーを再利用)。
  function selErrorText(res) {
    const generic = tr("statusError", "エラー");
    if (!res || typeof res !== "object") return generic;
    if (res.error === "no_api_key") return tr("statusNoKey", "API キーが未設定です");
    if (res.error === "network" || res.error === "runtime" || res.error === "context") return tr("statusNetwork", "ネットワークエラー");
    if (res.error === "http") {
      if (res.status === 401 || res.status === 403) return tr("statusBadKey", "API キーが無効か権限がありません");
      if (res.status === 429) return tr("statusQuotaDaily", "API の利用上限に達しました");
      return `HTTP ${res.status || ""}`.trim();
    }
    return generic;
  }

  // ---- 選択範囲 ----
  function selRect(sel) {
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    try {
      const r = sel.getRangeAt(0).getBoundingClientRect();
      if (r && (r.width || r.height)) return r;
    } catch (_e) { /* noop */ }
    return null;
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

  // kind: "loading" | "result" | "error"
  function setState(kind, text) {
    if (!bubble) return;
    bubble.classList.remove("__rt-sel-loading", "__rt-sel-result", "__rt-sel-error");
    bubble.classList.add(kind === "error" ? "__rt-sel-error" : (kind === "result" ? "__rt-sel-result" : "__rt-sel-loading"));
    if (textEl) textEl.textContent = text || "";
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
    const rect = selRect(window.getSelection());
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
      const sel = window.getSelection();
      const t = sel ? String(sel).trim() : "";
      if (!t) removeBubble(); // 選択が空になったら閉じる
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
    if (dead || !enabled) return;
    if (!contextAlive()) { shutdown(); return; }
    const sel = window.getSelection();
    const text = sel ? String(sel).trim() : "";
    if (!text) { removeBubble(); return; } // 選択が無ければ何もしない (右クリック経路は選択時のみ出る)
    if (!selRect(sel)) { removeBubble(); return; }
    ensureBubble();
    setState("loading", tr("selTranslating", "翻訳中…"));
    const my = ++reqId;
    sendBatch(text, (res) => {
      if (my !== reqId || dead) return; // 待つ間に閉じた/再トリガーされたら破棄
      if (res && res.ok && Array.isArray(res.translations) && res.translations[0]) {
        setState("result", res.translations[0]);
      } else {
        setState("error", selErrorText(res));
      }
    });
  }

  function onRuntimeMessage(m) {
    if (!m || m.action !== A.TRANSLATE_SELECTION_CS) return;
    trigger();
  }

  function shutdown() {
    if (dead) return;
    dead = true;
    removeBubble();
    try { chrome.runtime.onMessage.removeListener(onRuntimeMessage); } catch (_e) { /* noop */ }
  }

  // ---- 起動 ----
  try { chrome.runtime.onMessage.addListener(onRuntimeMessage); } catch (_e) { /* noop */ }

  // 有効フラグを読む (非機密フラグのみ。API キーは読まない)。popup トグルの変更に storage.onChanged で即追従。
  try {
    chrome.storage.local.get(CFLAGS_KEY, (d) => {
      const f = d && d[CFLAGS_KEY];
      if (f && typeof f.selectionTranslate === "boolean") enabled = f.selectionTranslate;
    });
  } catch (_e) { /* noop */ }
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes[CFLAGS_KEY]) return;
      const v = changes[CFLAGS_KEY].newValue;
      if (v && typeof v.selectionTranslate === "boolean") {
        enabled = v.selectionTranslate;
        if (!enabled) removeBubble(); // OFF にしたら開いているバブルを閉じる
      }
    });
  } catch (_e) { /* noop */ }
})();
