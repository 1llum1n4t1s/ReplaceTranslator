"use strict";

/**
 * fab.js — ページ右下のフローティング翻訳ボタン (content script・全ページ常駐)
 *
 * - クリックで翻訳 ON/OFF をトグル (アイコン表示・文字なし: 地球儀=翻訳 / 戻る矢印=原文復元、処理中はシマー)
 * - ドラッグは縦方向のみ・右端固定で上下に移動でき、縦位置は chrome.storage.local に保存・復元する
 * actions.js が先に注入される前提。実翻訳は background 経由で translator.js が行う。
 */

(function () {
  if (window.__rtFabLoaded) return;
  window.__rtFabLoaded = true;
  if (window.top !== window.self) return; // トップフレームのみ
  // 動画/音声ファイルを直接開いたメディアページは翻訳対象テキストが無いので FAB を出さない
  // (ブラウザ生成の <video>/<audio> だけのページ。YouTube 等の通常の動画サイトは text/html なので対象外)
  if (/^(video|audio)\//.test(document.contentType || "")) return;

  const A = globalThis.Actions;
  const POS_KEY = (globalThis.StorageKeys && globalThis.StorageKeys.FAB_POSITION) || "fabPosition";
  // content には API キーを入れない: 全体 settings ではなく非機密フラグ (CONTENT_FLAGS) だけ読む
  const CFLAGS_KEY = (globalThis.StorageKeys && globalThis.StorageKeys.CONTENT_FLAGS) || "contentFlags";
  if (!A) return;

  // 拡張 context 失効時 (Extension context invalidated) は静かに無視する送信ラッパ
  function send(msg) {
    try {
      const p = chrome.runtime.sendMessage(msg); // callback 省略時は Promise。受信側不在の reject も無視する
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (_e) { /* noop */ }
  }

  let state = "off"; // "off" | "loading" | "on"

  const fab = document.createElement("button");
  fab.id = "__rt_fab";
  fab.type = "button";
  // 中央のアイコン (文字は描かない)。地球儀 = これから翻訳 / 戻る矢印 = 原文に戻す。
  // stroke=currentColor で fab.css の .__rt-fab-glyph 色 (状態別) をそのまま継承する。
  const SVG_NS = "http://www.w3.org/2000/svg";
  function buildIcon(cls, parts) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.7");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", `__rt-ico ${cls}`);
    parts.forEach((p) => {
      const el = document.createElementNS(SVG_NS, p.t);
      Object.keys(p).forEach((k) => { if (k !== "t") el.setAttribute(k, p[k]); });
      svg.appendChild(el);
    });
    return svg;
  }
  const glyph = document.createElement("span");
  glyph.className = "__rt-fab-glyph";
  glyph.append(
    buildIcon("__rt-ico-tr", [ // 地球儀 (翻訳)
      { t: "circle", cx: "12", cy: "12", r: "9" },
      { t: "path", d: "M3.6 9h16.8" },
      { t: "path", d: "M3.6 15h16.8" },
      { t: "path", d: "M11.5 3a17 17 0 0 0 0 18" },
      { t: "path", d: "M12.5 3a17 17 0 0 1 0 18" },
    ]),
    buildIcon("__rt-ico-og", [ // 戻る矢印 (原文に戻す)
      { t: "path", d: "M9 14l-4 -4l4 -4" },
      { t: "path", d: "M5 10h11a4 4 0 1 1 0 8h-1" },
    ]),
  );
  // ホバーで滑り出るラベル
  const label = document.createElement("span");
  label.className = "__rt-fab-label";
  label.setAttribute("aria-hidden", "true");
  // 処理中は外周リングではなく、ボタン表面のシマー(::after)で示す
  fab.append(glyph, label);

  function tr(key, fallback) {
    try {
      const m = chrome.i18n && chrome.i18n.getMessage(key);
      return m || fallback;
    } catch (_e) {
      return fallback;
    }
  }

  function render() {
    const isOn = state === "on";
    fab.classList.toggle("__rt-on", isOn);
    fab.classList.toggle("__rt-loading", state === "loading");
    // アイコンの出し分けは fab.css が .__rt-on で行う (文字は描かない)。ここでは説明文だけ更新する。
    const base = isOn ? tr("fabRestore", "原文に戻す") : tr("fabTranslate", "ページを翻訳");
    label.textContent = base;
    fab.title = `${base}（ドラッグで移動）`;
    fab.setAttribute("aria-label", base);
    fab.setAttribute("aria-pressed", isOn ? "true" : "false");
  }

  function pulse() {
    fab.classList.remove("__rt-pulse");
    void fab.offsetWidth;
    fab.classList.add("__rt-pulse");
  }

  // ---- 位置 (右端固定・縦ドラッグ + 保存/復元) ----
  // 右側から離れないよう、水平位置は CSS の right:20px に固定し、ドラッグでは縦 (top) だけ動かす。
  function clampTop(top) {
    const h = fab.offsetHeight || 54;
    const maxT = Math.max(4, window.innerHeight - h - 4);
    return Math.min(Math.max(4, top), maxT);
  }
  function applyTop(top) {
    fab.style.top = `${clampTop(top)}px`;
    fab.style.bottom = "auto"; // top 基準に切替 (CSS の right:20px はそのまま = 右端固定)
  }

  let dragging = false;
  let moved = false;
  let startX = 0;
  let startY = 0;
  let originTop = 0;

  fab.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    dragging = true;
    moved = false;
    startX = e.clientX;
    startY = e.clientY;
    originTop = fab.getBoundingClientRect().top;
    try { fab.setPointerCapture(e.pointerId); } catch (_e) { /* noop */ }
  });

  fab.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    // 斜め/横移動も「ドラッグ」と見なしてクリック誤発火を抑止するが、位置は縦 (dy) だけ反映する (右端固定)
    if (!moved && Math.hypot(dx, dy) > 4) {
      moved = true;
      fab.classList.add("__rt-dragging");
    }
    if (moved) applyTop(originTop + dy);
  });

  fab.addEventListener("pointerup", (e) => {
    if (!dragging) return;
    dragging = false;
    fab.classList.remove("__rt-dragging");
    try { fab.releasePointerCapture(e.pointerId); } catch (_e) { /* noop */ }
    if (moved) {
      const r = fab.getBoundingClientRect();
      try { chrome.storage.local.set({ [POS_KEY]: { top: r.top } }); } catch (_e) { /* noop */ }
    }
  });

  // クリックはトグル。ただしドラッグ直後のクリックは抑制する
  fab.addEventListener("click", (e) => {
    if (!e.isTrusted) return; // 合成 click (悪意サイトの __rt_fab.click()) を無視。ユーザー操作なしに翻訳開始＝ページ文章送信を防ぐ
    if (moved) {
      e.preventDefault();
      e.stopImmediatePropagation();
      moved = false;
      return;
    }
    if (state === "loading") return;
    if (state === "on") {
      send({ action: A.RESTORE_PAGE });
      state = "off";
      render();
    } else {
      state = "loading";
      render();
      send({ action: A.TRANSLATE_PAGE });
    }
  });

  // 画面リサイズで画面外に出たら引き戻す (縦位置のみ。右端は CSS の right:20px 固定)
  window.addEventListener("resize", () => {
    if (fab.style.top) applyTop(parseFloat(fab.style.top));
  });

  // translator の進捗で状態同期
  chrome.runtime.onMessage.addListener((m) => {
    if (!m || m.action !== A.TRANSLATION_PROGRESS) return;
    if (m.state === "progress") { state = "loading"; render(); }
    else if (m.state === "done") { state = "on"; render(); pulse(); }
    else if (m.state === "error") { state = "off"; render(); }
    else if (m.state === "restored") { state = "off"; render(); }
    else if (m.state === "skipped") { state = "off"; render(); } // ページ言語=翻訳先 → 訳すものが無いので未翻訳状態へ戻す
  });

  render();

  // FAB の表示可否 (showFab)。インライン display は fab.css (#__rt_fab) より優先されるので確実に消せる。
  function applyVisibility(flags) {
    fab.style.display = (flags && flags.showFab === false) ? "none" : "";
  }
  function mount() {
    (document.body || document.documentElement).appendChild(fab);
  }

  // 保存済みの縦位置を復元 (DOM 追加前でも style 適用は有効)。旧形式 {left,top} でも top だけ使う (右端固定)。
  try {
    chrome.storage.local.get(POS_KEY, (d) => {
      const pos = d && d[POS_KEY];
      if (pos && typeof pos.top === "number") applyTop(pos.top);
    });
  } catch (_e) { /* noop */ }

  // 非機密フラグを読んでから DOM に載せる (showFab=OFF 設定でのチラつき防止)。
  // グローバル翻訳 ON (autoTranslate) なら開いたページを自動で翻訳する (FAB 非表示でも独立して動く)。
  try {
    chrome.storage.local.get(CFLAGS_KEY, (d) => {
      const f = d && d[CFLAGS_KEY];
      applyVisibility(f);
      mount();
      if (f && f.autoTranslate) {
        state = "loading";
        render();
        send({ action: A.TRANSLATE_PAGE });
      }
    });
  } catch (_e) { mount(); }

  // popup でトグルされたら開いているページにも即時反映する
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[CFLAGS_KEY]) applyVisibility(changes[CFLAGS_KEY].newValue);
    });
  } catch (_e) { /* noop */ }
})();
