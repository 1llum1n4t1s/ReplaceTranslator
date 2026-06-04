"use strict";

/**
 * image-translator.js — 画像内テキストの翻訳 (オプション・LLM vision)
 *
 * 設定 imageTranslate が ON のとき、画像ホバーで「訳」ボタンを出し、クリックで background の
 * TRANSLATE_IMAGE (vision) に投げ、返ってきた {translation, box} を画像の上にオーバーレイする。
 * Immersive Translate の画像翻訳を参考にした実験的機能。actions.js が先に注入される前提。
 */

(function () {
  if (window.__rtImgLoaded) return;
  window.__rtImgLoaded = true;
  // サブフレーム(iframe)は本文が十分ある枠だけ画像翻訳を有効化し、広告/ユーティリティ枠を除外して
  // 無駄な vision コストを抑える (translator.js の frameHasEnoughText=50字 と同じ意図)。メインフレームは常に有効。
  // sub-frame には background が imageTranslate ON のときだけ allFrames 注入する。
  if (window.top !== window.self) {
    const txt = (document.body && document.body.innerText) || "";
    if (txt.trim().length < 50) return;
  }

  const A = globalThis.Actions;
  // content には API キーを入れない: 全体 settings ではなく非機密フラグ (CONTENT_FLAGS) だけ読む
  const CFLAGS_KEY = (globalThis.StorageKeys && globalThis.StorageKeys.CONTENT_FLAGS) || "contentFlags";
  if (!A) return;

  let enabled = false;
  let btn = null;
  let target = null;

  const tr = (k, f) => {
    try { return (chrome.i18n && chrome.i18n.getMessage(k)) || f; } catch (_e) { return f; }
  };

  function applyEnabled(f) {
    enabled = Boolean(f && f.imageTranslate);
    if (!enabled && btn) btn.style.display = "none";
  }
  try { chrome.storage.local.get(CFLAGS_KEY, (d) => applyEnabled(d && d[CFLAGS_KEY])); } catch (_e) { /* noop */ }
  try {
    chrome.storage.onChanged.addListener((c, area) => {
      if (area === "local" && c[CFLAGS_KEY]) applyEnabled(c[CFLAGS_KEY].newValue);
    });
  } catch (_e) { /* noop */ }

  function eligible(el) {
    if (!el || el.tagName !== "IMG") return false;
    // <picture> 内の img は直接の子である必要があり、ensureWrap で span に包むと responsive な
    // source 選択が壊れる。translate 対象から外す (オーバーレイより元レイアウト維持を優先)。
    if (el.parentElement && el.parentElement.tagName === "PICTURE") return false;
    return el.clientWidth >= 80 && el.clientHeight >= 60 && Boolean(el.currentSrc || el.src);
  }

  function ensureBtn() {
    if (btn) return btn;
    btn = document.createElement("button");
    btn.className = "__rt-img-btn";
    btn.type = "button";
    btn.textContent = "訳";
    btn.title = tr("imgBtn", "画像内のテキストを翻訳");
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (target) translateImg(target);
    });
    document.documentElement.appendChild(btn);
    return btn;
  }

  function placeBtn(img) {
    const b = ensureBtn();
    const r = img.getBoundingClientRect();
    b.style.left = `${Math.round(r.right - 32)}px`;
    b.style.top = `${Math.round(r.top + 6)}px`;
    b.style.display = "block";
    b.textContent = "訳";
  }

  document.addEventListener("mouseover", (e) => {
    if (!enabled) return;
    if (eligible(e.target)) { target = e.target; placeBtn(e.target); }
  }, true);

  document.addEventListener("mouseout", (e) => {
    if (!enabled || !btn) return;
    const to = e.relatedTarget;
    if (to === btn || to === target || eligible(to)) return;
    btn.style.display = "none";
  }, true);

  window.addEventListener("scroll", () => { if (btn) btn.style.display = "none"; }, true);

  function ensureWrap(img) {
    const p = img.parentElement;
    if (p && p.classList.contains("__rt-img-wrap")) return p;
    const wrap = document.createElement("span");
    wrap.className = "__rt-img-wrap";
    img.parentNode.insertBefore(wrap, img);
    wrap.appendChild(img);
    return wrap;
  }

  function renderBlocks(img, blocks) {
    const wrap = ensureWrap(img);
    let layer = wrap.querySelector(".__rt-img-layer");
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "__rt-img-layer";
      wrap.appendChild(layer);
    }
    layer.replaceChildren();
    // 元のフォントサイズに追従させるため、画像の表示高さ × ブロック高さ から字サイズを推定する
    const rect = img.getBoundingClientRect();
    const imgH = rect.height || img.clientHeight || 0;
    blocks.forEach((blk) => {
      const el = document.createElement("div");
      el.className = "__rt-img-block";
      el.textContent = blk.translation;
      if (blk.original) el.title = blk.original;
      el.style.left = `${blk.box.x * 100}%`;
      el.style.top = `${blk.box.y * 100}%`;
      el.style.width = `${Math.max(0.04, blk.box.w) * 100}%`;
      el.style.minHeight = `${Math.max(0.03, blk.box.h) * 100}%`;
      // ブロック高さ(box.h)×画像高さ ≒ その文字の縦サイズ。1行ぶんに寄せて係数(やや小さめ 0.7)を掛け、極端値をクランプ。
      if (imgH > 0) {
        const fs = Math.max(9, Math.min(36, Math.round(imgH * Math.max(0.02, blk.box.h) * 0.7)));
        el.style.fontSize = `${fs}px`;
      }
      layer.appendChild(el);
    });
  }

  function translateImg(img) {
    const url = img.currentSrc || img.src;
    if (!url) return;
    const myRun = imgRunId; // 復元/再翻訳で無効化されたら描かない (translateOne と同じ世代チェック)
    if (btn) btn.textContent = "…";
    try {
      chrome.runtime.sendMessage({ action: A.TRANSLATE_IMAGE, imageUrl: url }, (res) => {
        if (chrome.runtime.lastError) { if (btn) btn.textContent = "訳"; return; }
        if (myRun !== imgRunId) { if (btn) btn.textContent = "訳"; return; } // 復元/再翻訳後の遅延応答は描画しない
        if (res && res.ok && Array.isArray(res.blocks) && res.blocks.length) {
          renderBlocks(img, res.blocks);
          if (btn) btn.style.display = "none";
        } else if (btn) {
          btn.textContent = "×";
          window.setTimeout(() => { if (btn) btn.textContent = "訳"; }, 1500);
        }
      });
    } catch (_e) { if (btn) btn.textContent = "訳"; } // context 失効は静かに無視
  }

  // ---- 一括並列翻訳 (複数画像を同時に投げて体感を上げる) ----
  // 並列度 (ゆろさん指定で 10)。vision は重く各社レートも厳しめなので 429 に注意。
  const BATCH_CONCURRENCY = 10;
  let imgRunId = 0; // 一括翻訳の世代。復元/再翻訳で ++ し、進行中ワーカーの新規送信と遅延描画を止める

  // 既にオーバーレイ済みか (二重翻訳・再 OCR を防ぐ)
  function isTranslated(img) {
    const p = img.parentElement;
    return Boolean(p && p.classList.contains("__rt-img-wrap") && p.querySelector(".__rt-img-block"));
  }

  // 1 画像を翻訳してオーバーレイを描く (ボタン UI なし版・完了を Promise で返す)
  function translateOne(img, myRun) {
    return new Promise((resolve) => {
      const url = img.currentSrc || img.src;
      if (!url) { resolve(); return; }
      try {
        chrome.runtime.sendMessage({ action: A.TRANSLATE_IMAGE, imageUrl: url }, (res) => {
          // 復元/再翻訳で世代が変わっていたら描画しない (クリア後にオーバーレイが再出現するのを防ぐ)
          if (myRun === imgRunId && !chrome.runtime.lastError && res && res.ok && Array.isArray(res.blocks) && res.blocks.length) {
            renderBlocks(img, res.blocks);
          }
          resolve();
        });
      } catch (_e) { resolve(); } // context 失効 (Extension context invalidated) は静かに無視
    });
  }

  // 対象画像リストを並列翻訳する (eligible && 未翻訳のみ。myRun で復元/再翻訳の世代を判定)
  async function translateImages(candidates, myRun) {
    const imgs = candidates.filter((im) => eligible(im) && !isTranslated(im));
    if (!imgs.length) return;
    let cursor = 0;
    async function worker() {
      while (cursor < imgs.length) {
        if (myRun !== imgRunId) return; // 復元/再翻訳で無効化されたら新規送信を止める (overlay 再出現・無駄なquota消費を防ぐ)
        await translateOne(imgs[cursor++], myRun);
      }
    }
    await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, imgs.length) }, worker));
  }

  // ページ内の対象画像をまとめて並列翻訳する (テキスト翻訳と並行で走る)
  async function translateAllImages() {
    const myRun = ++imgRunId; // この一括翻訳の世代 (復元/再翻訳で無効化される)
    startImgWatch();          // 一括後に SPA 挿入 / 遅延ロードされた画像も同じ翻訳状態で拾う
    await translateImages(Array.from(document.images), myRun);
  }

  // ---- 一括翻訳中に後から増えた画像の追従 (SPA 挿入 / lazy-load) ----
  // document.images のスナップショットは translateAllImages の 1 回きりなので、その後に現れた画像は
  // ホバーしない限り訳されない。一括が有効な間 (translateAllImages〜clearAllImages) だけ
  // MutationObserver + load で新規 eligible 画像を拾い、現世代 (imgRunId) で翻訳する。
  let imgMo = null;
  const pendingImgs = new Set();
  let pendingImgTimer = null;
  function flushPendingImgs() {
    pendingImgTimer = null;
    const list = Array.from(pendingImgs); pendingImgs.clear();
    if (list.length) translateImages(list, imgRunId); // clearAllImages で世代が変われば worker が止まる
  }
  function queueLateImage(img) {
    if (!enabled || !eligible(img) || isTranslated(img)) return;
    pendingImgs.add(img);
    if (!pendingImgTimer) pendingImgTimer = window.setTimeout(flushPendingImgs, 300); // 連続追加をまとめる
  }
  function onImgLoad(e) {
    const t = e.target;
    if (t && t.tagName === "IMG") queueLateImage(t); // lazy <img> が src 解決して load した瞬間に拾う
  }
  function collectImgsInto(node, sink) {
    if (!node || node.nodeType !== 1) return;
    if (node.tagName === "IMG") sink.push(node);
    else if (node.querySelectorAll) node.querySelectorAll("img").forEach((im) => sink.push(im));
  }
  function startImgWatch() {
    if (imgMo) return;
    imgMo = new MutationObserver((muts) => {
      if (!enabled) return;
      const found = [];
      for (const m of muts) {
        if (m.type === "attributes") { collectImgsInto(m.target, found); continue; } // data-src→src 等の差し替え
        for (const n of m.addedNodes) collectImgsInto(n, found);
      }
      for (const im of found) queueLateImage(im);
    });
    imgMo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "srcset"] });
    document.addEventListener("load", onImgLoad, true); // 遅延ロード画像の load を capture で拾う
  }
  function stopImgWatch() {
    if (imgMo) { imgMo.disconnect(); imgMo = null; }
    document.removeEventListener("load", onImgLoad, true);
    if (pendingImgTimer) { window.clearTimeout(pendingImgTimer); pendingImgTimer = null; }
    pendingImgs.clear();
  }

  // 画像オーバーレイをすべて消し、ensureWrap で挿入した span.__rt-img-wrap も解除して
  // 元の DOM 構造 (img が親の直接の子) に戻す (原文復元と連動)。
  function clearAllImages() {
    imgRunId++; // 進行中の一括翻訳を無効化 (復元後に新規 OCR を送らない / 遅延描画もしない)
    stopImgWatch(); // 後追い監視も止める (復元=画像翻訳終了 / 再翻訳時は translateAllImages が貼り直す)
    document.querySelectorAll(".__rt-img-wrap").forEach((wrap) => {
      const img = wrap.querySelector("img");
      const parent = wrap.parentNode;
      wrap.querySelectorAll(".__rt-img-layer").forEach((l) => l.remove());
      if (img && parent) {
        parent.insertBefore(img, wrap);  // img をラッパーの外へ戻す
        wrap.remove();                   // 空になったラッパーを除去
      }
    });
    // ラッパー無しで残っているレイヤーがあれば後始末
    document.querySelectorAll(".__rt-img-layer").forEach((l) => l.remove());
  }

  // ページ翻訳/復元に追従する (background が tabs.sendMessage で送る)
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || typeof msg.action !== "string") return undefined;
      if (msg.action === A.APPLY_TRANSLATE_CS) {
        // 再翻訳のたびに既存オーバーレイを一旦消す。translateAllImages は isTranslated(img) を除外するため、
        // clear しないと target/provider を変えた再翻訳で旧訳が残り、画像翻訳を OFF にした再翻訳でも
        // 前回のオーバーレイが居座る。clearAllImages は imgRunId を進め進行中の一括も打ち切る。
        clearAllImages();
        // 起動レース対策: storage 由来の enabled が未確定でも、メッセージ同梱の公開設定で判定する
        // (fab.js が先に TRANSLATE_PAGE を送り、こちらの flag ロードが間に合わないと画像一括が飛ぶため)。
        const on = (msg.settings && typeof msg.settings.imageTranslate === "boolean") ? msg.settings.imageTranslate : enabled;
        if (on) translateAllImages();
      } else if (msg.action === A.APPLY_RESTORE_CS) clearAllImages();
      return undefined;
    });
  } catch (_e) { /* noop */ }
})();
