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

  // 訳文 span が枠 (boxW×boxH px) に収まる最大フォント (px) を二分探索で求める。
  // 係数ベース (高さ×0.7) だと元が複数行の枠で box.h が数行ぶんになり字が巨大化したが、
  // 実測フィットなら多行ブロックは自動で小さくなり、訳文が日本語化で伸びても枠内に収まる。
  function fitFontSize(span, boxW, boxH, minFs, maxFs) {
    let lo = minFs, hi = Math.max(minFs, maxFs), best = minFs;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      span.style.fontSize = `${mid}px`;
      const r = span.getBoundingClientRect();
      if (r.height <= boxH + 0.5 && r.width <= boxW + 0.5) { best = mid; lo = mid + 1; }
      else { hi = mid - 1; }
    }
    span.style.fontSize = `${best}px`;
    return best;
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
    const rect = img.getBoundingClientRect();
    const imgH = rect.height || img.clientHeight || 0;
    const imgW = rect.width || img.clientWidth || 0;
    blocks.forEach((blk) => {
      const el = document.createElement("div");
      el.className = "__rt-img-block";
      if (blk.original) el.title = blk.original;
      // 訳文は span に入れて実測する (flex 中央寄せの div を直接測ると不安定なため)。
      const span = document.createElement("span");
      span.className = "__rt-img-text";
      span.textContent = blk.translation;
      el.appendChild(span);
      el.style.top = `${blk.box.y * 100}%`;
      // 幅は box.w を使うが、極小幅 (LLM が w≈0 の劣化 bbox を返す等) は判読不能な縦帯になるため px 下限 (~48px) を
      // 設ける。画像幅の 60% は超えない (枠を画像いっぱいに広げない)。
      let wPct = Math.max(0.04, blk.box.w);
      if (imgW > 0) wPct = Math.max(wPct, Math.min(0.6, 48 / imgW));
      // 下限で広げた枠が画像右端をはみ出すと、layer の overflow:hidden で画面外が切れる一方、fitFontSize は
      // はみ出し分込みの clientWidth で測るため見えない幅向けに組まれ訳文がクリップされる。左へずらして画像内へ収める。
      let leftPct = blk.box.x;
      if (leftPct + wPct > 1) leftPct = Math.max(0, 1 - wPct);
      el.style.left = `${leftPct * 100}%`;
      el.style.width = `${wPct * 100}%`;
      // 高さも OCR の元枠 (box.h) に固定。min-height だと訳文が伸びたとき div が下へ膨張し隣のブロックに重なる。
      // ただし極小画像/極小 box.h で 1 行も描けない高さ (例 60px 画像 × box.h 0.03 = 1.8px) に潰れないよう、
      // 最小フォント (9px) 1 行ぶん (~14px) を下限にする (旧 min-height が 1 行ぶん確保していた挙動の代替)。
      const boxHpx = Math.max(14, Math.max(0.03, blk.box.h) * imgH);
      if (imgH > 0) {
        el.style.height = `${boxHpx}px`;
        layer.appendChild(el); // clientWidth/Height 計測のため先に DOM へ
        const targetW = Math.max(8, el.clientWidth - 8);   // 左右 padding 4px*2 (負値ガード)
        const targetH = Math.max(8, el.clientHeight - 2);  // 上下 padding 1px*2 (負値ガード)
        let maxFs = Math.min(48, Math.max(9, Math.round(boxHpx)));
        // 多行の箱 (box.h が数行ぶん) に短い訳語1行が入ると、箱の高さいっぱい (最大48px) まで膨らみ巨大化が再発する。
        // 原文の文字数と箱の面積から「ソース1行ぶんの高さ」を逆算して上限にする (1行あたりの字サイズへ揃える)。
        // 面積モデル: 行高 L で文字幅≈0.6L とすると origLen·0.6·L² ≈ boxW·boxH → L = √(boxW·boxH / (origLen·0.6))。
        const origLen = (blk.original || "").trim().length;
        if (origLen > 1) {
          const lineHpx = Math.sqrt((targetW * boxHpx) / (origLen * 0.6));
          maxFs = Math.min(maxFs, Math.max(9, Math.round(lineHpx / 1.15))); // line-height 1.15 ぶんを割り戻す
        }
        fitFontSize(span, targetW, targetH, 9, maxFs);
        // 9px でも枠に収まらない多行訳文は、中央寄せだと全行が均等に欠ける。上寄せにして先頭行を必ず丸ごと残す。
        if (span.getBoundingClientRect().height > targetH + 0.5) el.style.alignItems = "flex-start";
      } else {
        layer.appendChild(el); // 画像高さ不明時は CSS フォールバック (12px) のまま
      }
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
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || typeof msg.action !== "string") return undefined;
      if (msg.action === A.APPLY_RESTORE_CS) clearAllImages();
      return undefined;
    });
  } catch (_e) { /* noop */ }
})();
