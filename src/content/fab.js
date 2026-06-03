"use strict";

/**
 * fab.js — ページ右下のフローティング翻訳ボタン (content script・全ページ常駐)
 *
 * - クリックで翻訳 ON/OFF をトグル (漢字グリフ: 文=原文 / 訳=翻訳中 / ⟳=処理中)
 * - ドラッグで好きな位置へ移動でき、位置は chrome.storage.local に保存・復元する
 * actions.js が先に注入される前提。実翻訳は background 経由で translator.js が行う。
 */

(function () {
  if (window.__rtFabLoaded) return;
  window.__rtFabLoaded = true;
  if (window.top !== window.self) return; // トップフレームのみ

  const A = globalThis.Actions;
  const POS_KEY = (globalThis.StorageKeys && globalThis.StorageKeys.FAB_POSITION) || "fabPosition";
  const SETTINGS_KEY = (globalThis.StorageKeys && globalThis.StorageKeys.SETTINGS) || "settings";
  if (!A) return;

  // 拡張 context 失効時 (Extension context invalidated) は静かに無視する送信ラッパ
  function send(msg) {
    try { chrome.runtime.sendMessage(msg); } catch (_e) { /* noop */ }
  }

  let state = "off"; // "off" | "loading" | "on"

  const fab = document.createElement("button");
  fab.id = "__rt_fab";
  fab.type = "button";
  // 中央のグリフ (訳 = これから翻訳 / 原 = 原文に戻す)
  const glyph = document.createElement("span");
  glyph.className = "__rt-fab-glyph";
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
    // 訳 = これから翻訳する / 原 = 原文に戻す (クリックで起きる動作を示す)
    glyph.textContent = isOn ? "原" : "訳";
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

  // ---- 位置 (ドラッグ + 保存/復元) ----
  function clampPos(left, top) {
    const w = fab.offsetWidth || 54;
    const h = fab.offsetHeight || 54;
    const maxL = Math.max(4, window.innerWidth - w - 4);
    const maxT = Math.max(4, window.innerHeight - h - 4);
    return { left: Math.min(Math.max(4, left), maxL), top: Math.min(Math.max(4, top), maxT) };
  }
  function applyPos(left, top) {
    const c = clampPos(left, top);
    fab.style.left = `${c.left}px`;
    fab.style.top = `${c.top}px`;
    fab.style.right = "auto";
    fab.style.bottom = "auto";
  }

  let dragging = false;
  let moved = false;
  let startX = 0;
  let startY = 0;
  let originLeft = 0;
  let originTop = 0;

  fab.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    dragging = true;
    moved = false;
    startX = e.clientX;
    startY = e.clientY;
    const r = fab.getBoundingClientRect();
    originLeft = r.left;
    originTop = r.top;
    try { fab.setPointerCapture(e.pointerId); } catch (_e) { /* noop */ }
  });

  fab.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!moved && Math.hypot(dx, dy) > 4) {
      moved = true;
      fab.classList.add("__rt-dragging");
    }
    if (moved) applyPos(originLeft + dx, originTop + dy);
  });

  fab.addEventListener("pointerup", (e) => {
    if (!dragging) return;
    dragging = false;
    fab.classList.remove("__rt-dragging");
    try { fab.releasePointerCapture(e.pointerId); } catch (_e) { /* noop */ }
    if (moved) {
      const r = fab.getBoundingClientRect();
      try { chrome.storage.local.set({ [POS_KEY]: { left: r.left, top: r.top } }); } catch (_e) { /* noop */ }
    }
  });

  // クリックはトグル。ただしドラッグ直後のクリックは抑制する
  fab.addEventListener("click", (e) => {
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

  // 画面リサイズで画面外に出たら引き戻す
  window.addEventListener("resize", () => {
    if (fab.style.left) applyPos(parseFloat(fab.style.left), parseFloat(fab.style.top));
  });

  // translator の進捗で状態同期
  chrome.runtime.onMessage.addListener((m) => {
    if (!m || m.action !== A.TRANSLATION_PROGRESS) return;
    if (m.state === "progress") { state = "loading"; render(); }
    else if (m.state === "done") { state = "on"; render(); pulse(); }
    else if (m.state === "error") { state = "off"; render(); }
    else if (m.state === "restored") { state = "off"; render(); }
  });

  render();
  (document.body || document.documentElement).appendChild(fab);

  // 保存済みの位置を復元
  try {
    chrome.storage.local.get(POS_KEY, (d) => {
      const pos = d && d[POS_KEY];
      if (pos && typeof pos.left === "number" && typeof pos.top === "number") {
        applyPos(pos.left, pos.top);
      }
    });
  } catch (_e) { /* noop */ }

  // グローバル翻訳 ON (autoTranslate) なら、開いたページを自動で翻訳する
  try {
    chrome.storage.local.get(SETTINGS_KEY, (d) => {
      const s = d && d[SETTINGS_KEY];
      if (s && s.autoTranslate) {
        state = "loading";
        render();
        send({ action: A.TRANSLATE_PAGE });
      }
    });
  } catch (_e) { /* noop */ }
})();
