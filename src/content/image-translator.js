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
  // 画像翻訳はホバー手動のみ (一括・後追い watcher・iframe 一括注入は廃止)。本スクリプトは manifest の
  // content_scripts で top フレームにのみ常駐する (all_frames 指定なし) ため、フレーム判定は不要。

  const A = globalThis.Actions;
  // content には API キーを入れない: 全体 settings ではなく非機密フラグ (CONTENT_FLAGS) だけ読む
  const CFLAGS_KEY = (globalThis.StorageKeys && globalThis.StorageKeys.CONTENT_FLAGS) || "contentFlags";
  if (!A) return;

  let enabled = false;
  let btn = null;
  let target = null;
  let dead = false; // shutdown 済みフラグ (リスナー解除後の再入を弾く)

  // 拡張 context が生きているか (リロード/更新後に置き去りになった古いスクリプトかの判定)。
  // 失効すると chrome.runtime.id が undefined になり、chrome API 呼び出しは例外を投げる。
  function contextAlive() {
    try { return Boolean(chrome.runtime && chrome.runtime.id); } catch (_e) { return false; }
  }
  // context 失効時などに、登録リスナーを解除し btn 除去・state クリアして、これ以上 chrome API / DOM を
  // 触らないよう静かに停止する。各操作は try/catch で例外を吸収する (translator.js の shutdown と同パターン)。
  function shutdown() {
    if (dead) return;
    dead = true;
    enabled = false;
    try { document.removeEventListener("mouseover", onMouseOver, true); } catch (_e) { /* noop */ }
    try { document.removeEventListener("mouseout", onMouseOut, true); } catch (_e) { /* noop */ }
    try { window.removeEventListener("scroll", onScroll, true); } catch (_e) { /* noop */ }
    try { chrome.storage.onChanged.removeListener(onStorageChanged); } catch (_e) { /* noop */ }
    try { chrome.runtime.onMessage.removeListener(onRuntimeMessage); } catch (_e) { /* noop */ }
    try { if (btn) btn.remove(); } catch (_e) { /* noop */ }
    btn = null;
    target = null;
  }

  const tr = (k, f) => {
    try { return (chrome.i18n && chrome.i18n.getMessage(k)) || f; } catch (_e) { return f; }
  };

  function applyEnabled(f) {
    enabled = Boolean(f && f.imageTranslate);
    if (!enabled && btn) btn.style.display = "none";
  }
  try { chrome.storage.local.get(CFLAGS_KEY, (d) => applyEnabled(d && d[CFLAGS_KEY])); } catch (_e) { /* noop */ }
  function onStorageChanged(c, area) {
    if (area === "local" && c[CFLAGS_KEY]) applyEnabled(c[CFLAGS_KEY].newValue);
  }
  try { chrome.storage.onChanged.addListener(onStorageChanged); } catch (_e) { /* noop */ }

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
      if (!e.isTrusted) return; // 合成 click を無視 (サイトが勝手に OCR させ、ページ内の機微画像を vision へ送るのを防ぐ)
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

  function onMouseOver(e) {
    if (dead) return;
    if (!contextAlive()) { shutdown(); return; } // 失効した旧スクリプトはボタンを出さず後始末
    if (!enabled) return;
    if (eligible(e.target)) { target = e.target; placeBtn(e.target); }
  }

  function onMouseOut(e) {
    if (dead || !enabled || !btn) return;
    const to = e.relatedTarget;
    if (to === btn || to === target || eligible(to)) return;
    btn.style.display = "none";
  }

  function onScroll() {
    if (dead) return;
    if (!contextAlive()) { shutdown(); return; }
    if (btn) btn.style.display = "none";
  }

  document.addEventListener("mouseover", onMouseOver, true);
  document.addEventListener("mouseout", onMouseOut, true);
  window.addEventListener("scroll", onScroll, true);

  function ensureWrap(img) {
    const p = img.parentElement;
    if (p && p.classList.contains("__rt-img-wrap")) return p;
    // 元 img の「表示中のボックス」を wrap に px 固定で引き継ぐ。これをしないと、親にサイズ指定されていた
    // レスポンシブ画像 (例: width:100% の img を持つ Twitter 等) が inline-block ラップ内で自然サイズに膨らみ
    // 「画像が拡大される」。wrap を表示サイズに固定し img を 100% でフィットさせて見た目を維持する。
    const cs = window.getComputedStyle(img);
    const r = img.getBoundingClientRect();
    const wrap = document.createElement("span");
    wrap.className = "__rt-img-wrap";
    wrap.style.display = (cs.display === "" || cs.display.indexOf("inline") === 0) ? "inline-block" : "block";
    wrap.style.width = Math.round(r.width) + "px";
    wrap.style.height = Math.round(r.height) + "px";
    wrap.style.verticalAlign = cs.verticalAlign; // 行内画像のベースラインずれを抑える
    img.parentNode.insertBefore(wrap, img);
    wrap.appendChild(img);
    // img を wrap いっぱいにフィット。元の inline style は退避し、復元 (clearAllImages) で戻す。
    if (img.__rtPrevStyle === undefined) img.__rtPrevStyle = img.getAttribute("style") || "";
    img.style.width = "100%";
    img.style.height = "100%";
    img.style.maxWidth = "100%";
    img.style.objectFit = cs.objectFit || "contain";
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
    const myRun = imgRunId; // 復元後に届いた遅延応答を描かないための世代チェック
    if (btn) btn.textContent = "…";
    try {
      chrome.runtime.sendMessage({ action: A.TRANSLATE_IMAGE, imageUrl: url }, (res) => {
        if (chrome.runtime.lastError) { if (btn) btn.textContent = "訳"; return; }
        if (!contextAlive()) { shutdown(); return; } // 応答到着時に失効していたら DOM を触らず停止
        // 復元後の遅延応答 / 削除済み画像は描かない。さらに送信中に src が差し替わった (カルーセル/レスポンシブ/
        // lazy placeholder) 場合は、古い url の OCR を別画像に重ねないよう描画をスキップする (ボタンは戻して再実行可能に)。
        if (myRun !== imgRunId || !img.isConnected || (img.currentSrc || img.src) !== url) { if (btn) btn.textContent = "訳"; return; }
        if (res && res.ok && Array.isArray(res.blocks) && res.blocks.length) {
          try { renderBlocks(img, res.blocks); if (btn) btn.style.display = "none"; }
          catch (_e) { if (btn) btn.textContent = "訳"; } // 画像が消えていた等で描画失敗 → 無視
        } else if (btn) {
          btn.textContent = "×";
          window.setTimeout(() => { if (btn) btn.textContent = "訳"; }, 1500);
        }
      });
    } catch (_e) { if (btn) btn.textContent = "訳"; } // context 失効は静かに無視
  }

  let imgRunId = 0; // 画像翻訳の世代。復元時に ++ し、進行中ホバー OCR の遅延描画を止める

  // 画像オーバーレイをすべて消し、ensureWrap で挿入した span.__rt-img-wrap も解除して
  // 元の DOM 構造 (img が親の直接の子) に戻す (原文復元と連動)。
  function clearAllImages() {
    imgRunId++; // 世代を進めて進行中ホバー OCR の遅延描画を無効化する
    document.querySelectorAll(".__rt-img-wrap").forEach((wrap) => {
      const img = wrap.querySelector("img");
      const parent = wrap.parentNode;
      wrap.querySelectorAll(".__rt-img-layer").forEach((l) => l.remove());
      if (img && parent) {
        if (img.__rtPrevStyle !== undefined) { // ensureWrap で退避した元 inline style を戻す (フィット用の width/height 等を除去)
          if (img.__rtPrevStyle) img.setAttribute("style", img.__rtPrevStyle); else img.removeAttribute("style");
          try { delete img.__rtPrevStyle; } catch (_e) { img.__rtPrevStyle = undefined; }
        }
        parent.insertBefore(img, wrap);  // img をラッパーの外へ戻す
        wrap.remove();                   // 空になったラッパーを除去
      }
    });
    // 念のため: ラッパー解除前に取り残された __rtPrevStyle 付き img があれば素の状態へ戻す (二重防御)
    document.querySelectorAll("img[style*='100%']").forEach((im) => {
      if (im.__rtPrevStyle === undefined) return;
      if (im.__rtPrevStyle) im.setAttribute("style", im.__rtPrevStyle); else im.removeAttribute("style");
      try { delete im.__rtPrevStyle; } catch (_e) { im.__rtPrevStyle = undefined; }
    });
    // ラッパー無しで残っているレイヤーがあれば後始末
    document.querySelectorAll(".__rt-img-layer").forEach((l) => l.remove());
  }

  // 画像翻訳はホバー手動のみ (一括は廃止)。ページ翻訳には連動せず、原文復元時にだけ
  // ホバーで付けたオーバーレイを消す (= ページを元に戻すと画像も元に戻る)。
  function onRuntimeMessage(msg) {
    if (!msg || typeof msg.action !== "string") return undefined;
    if (msg.action === A.APPLY_RESTORE_CS) clearAllImages();
    return undefined;
  }
  try { chrome.runtime.onMessage.addListener(onRuntimeMessage); } catch (_e) { /* noop */ }
})();
