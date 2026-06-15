"use strict";

/**
 * image-translator.js — 画像内テキストの翻訳 (LLM vision・ホバー手動)
 *
 * 画像ホバーで「訳」ボタンを出し、クリックで background の TRANSLATE_IMAGE (vision) に投げ、
 * 返ってきた {translation, box} を画像の上にオーバーレイする。オーバーレイ後はボタンが「原」に
 * 変わり、押すとその画像だけ原文に戻せる。Immersive Translate の画像翻訳を参考にした機能。
 * actions.js が先に注入される前提。
 */

(function () {
  if (window.__rtImgLoaded) return;
  window.__rtImgLoaded = true;
  // 画像翻訳はホバー手動のみ (一括・後追い watcher・iframe 一括注入は廃止)。本スクリプトは manifest の
  // content_scripts で top フレームにのみ常駐する (all_frames 指定なし) ため、フレーム判定は不要。
  // 設定トグルは廃止: 翻訳はホバー+クリックの明示操作でしか起きないので、ホバーボタンは常時出す。

  const A = globalThis.Actions;
  if (!A) return;

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
    try { document.removeEventListener("mouseover", onMouseOver, true); } catch (_e) { /* noop */ }
    try { document.removeEventListener("mouseout", onMouseOut, true); } catch (_e) { /* noop */ }
    try { window.removeEventListener("scroll", onScroll, true); } catch (_e) { /* noop */ }
    try { chrome.runtime.onMessage.removeListener(onRuntimeMessage); } catch (_e) { /* noop */ }
    try { if (btn) btn.remove(); } catch (_e) { /* noop */ }
    btn = null;
    target = null;
  }

  const tr = (k, f) => {
    try { return (chrome.i18n && chrome.i18n.getMessage(k)) || f; } catch (_e) { return f; }
  };

  function eligible(el) {
    if (!el || el.tagName !== "IMG") return false;
    // <picture> 内の img は直接の子である必要があり、ensureWrap で span に包むと responsive な
    // source 選択が壊れる。translate 対象から外す (オーバーレイより元レイアウト維持を優先)。
    if (el.parentElement && el.parentElement.tagName === "PICTURE") return false;
    return el.clientWidth >= 80 && el.clientHeight >= 60 && Boolean(el.currentSrc || el.src);
  }

  // img が翻訳オーバーレイ付きか (ensureWrap で包まれ layer を持つ)。ボタンの 訳/原 切替に使う。
  function isTranslated(img) {
    const p = img && img.parentElement;
    return Boolean(p && p.classList.contains("__rt-img-wrap") && p.querySelector(".__rt-img-layer"));
  }

  // ボタンの見た目を img の状態に合わせる (未翻訳=「訳」/ 翻訳済み=「原」で元に戻す)。
  function setBtnMode(img) {
    if (!btn) return;
    const on = isTranslated(img);
    btn.textContent = on ? "原" : "訳";
    btn.title = on ? tr("imgRevert", "画像の翻訳を消して元に戻す") : tr("imgBtn", "画像内のテキストを翻訳");
    btn.classList.toggle("__rt-img-btn-on", on);
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
      if (!target) return;
      if (isTranslated(target)) revertImg(target); // 翻訳済み → その 1 枚だけ原文に戻す
      else translateImg(target);
    });
    document.documentElement.appendChild(btn);
    return btn;
  }

  function placeBtn(img) {
    const b = ensureBtn();
    const r = img.getBoundingClientRect();
    // 左下に配置 (他サービスの翻訳/保存ボタンが画像右上に被りがちなのを避ける)。ボタンは 28px (image-translator.css)。
    b.style.left = `${Math.round(r.left + 6)}px`;
    b.style.top = `${Math.round(r.bottom - 34)}px`;
    b.style.display = "block";
    setBtnMode(img);
  }

  // カーソル直下から翻訳対象の img を解決する。多くのサイトは画像の上にリンク (<a>) やホバー用の
  // オーバーレイ要素を重ねるため、mouseover の e.target が img にならず、被さった要素だけが見える。
  // その場合は elementsFromPoint でカーソル位置の要素スタック (最前面→奥) を辿り、最初の eligible な
  // img を拾う (被った要素の下の img も pointer-events:auto ならスタックに含まれる)。
  function imgAtPoint(e) {
    if (eligible(e.target)) return e.target;            // 速い経路: img が最前面
    if (typeof e.clientX !== "number") return null;
    let stack;
    try { stack = document.elementsFromPoint(e.clientX, e.clientY); } catch (_e) { return null; }
    for (const el of stack) {
      if (el === btn) continue;                         // 自前のボタン/オーバーレイは飛ばす
      if (eligible(el)) return el;                      // 被さった要素 (アンカー等) の下の img を採用
    }
    return null;
  }

  function pointInRect(x, y, el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  function onMouseOver(e) {
    if (dead) return;
    if (!contextAlive()) { shutdown(); return; } // 失効した旧スクリプトはボタンを出さず後始末
    if (e.target === btn) return;                // 自前ボタン上では target/位置を保持して何もしない
    const img = imgAtPoint(e);
    if (img) { target = img; placeBtn(img); }
  }

  // オーバーレイ付き画像ではカード内の子要素を跨ぐたび mouseout が連発し relatedTarget 依存だとちらつく。
  // 「カーソルの新位置が対象画像の矩形 or ボタンの矩形の中か」で判定し、両方から外れたときだけ隠す。
  function onMouseOut(e) {
    if (dead || !btn || btn.style.display === "none") return;
    if (pointInRect(e.clientX, e.clientY, target) || pointInRect(e.clientX, e.clientY, btn)) return;
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
    wrap.style.display = (cs.display === "" || cs.display.startsWith("inline")) ? "inline-block" : "block";
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
        // 垂直位置は cy (テキストの縦中央) に帯の中心を合わせる。VLM は box.y (枠上端) より cy を桁違いに
        // 安定して当てるため、box.y の系統的な上ズレに依存せず原文行へ重なる (align-items:center で訳文中央=cy)。
        // cy 欠落時は box の縦中央へフォールバック。最後に画像内へクランプ。
        const cyN = (typeof blk.cy === "number" && blk.cy >= 0 && blk.cy <= 1)
          ? blk.cy
          : Math.min(1, Math.max(0, blk.box.y + Math.max(0.03, blk.box.h) / 2));
        const topPx = Math.min(Math.max(0, cyN * imgH - boxHpx / 2), Math.max(0, imgH - boxHpx));
        el.style.top = `${topPx}px`;
        layer.appendChild(el); // clientWidth/Height 計測のため先に DOM へ
        const targetW = Math.max(8, el.clientWidth - 8);   // 左右 padding 4px*2 (負値ガード)
        const targetH = Math.max(8, el.clientHeight - 2);  // 上下 padding 1px*2 (負値ガード)
        // 「文字が枠を埋める1行ぶんの高さ」を文字面積モデルで推定し、フォント上限にする。これを常に効かせて、
        // 原文 (original) が来ないとき上限が箱の高さ (最大48px) に張り付き、短い訳文が巨大化するのを防ぐ。
        // 面積モデル: 行高 L・文字幅≈0.6L とすると len·0.6·L² ≈ boxW·boxH → L = √(boxW·boxH / (len·0.6))。
        // original が来れば密度信号に使う。無い/極短なら訳文長から原文長を概算する (EN→JA は訳文が原文の約半分の文字数)。
        const origLen = (blk.original || "").trim().length;
        const effLen = origLen > 1 ? origLen : Math.max(2, (blk.translation || "").trim().length) * 2;
        const lineHpx = Math.sqrt((targetW * boxHpx) / (effLen * 0.6));
        // 単一行の箱 (高さが小さい) は箱の高さで頭打ち、複数行の箱は1行ぶんに抑える。絶対上限も 40px に控える。
        const maxFs = Math.min(40, Math.max(9, Math.round(Math.min(boxHpx, lineHpx) / 1.15)));
        fitFontSize(span, targetW, targetH, 9, maxFs);
        // 9px でも枠に収まらない多行訳文は、中央寄せだと全行が均等に欠ける。上寄せにして先頭行を必ず丸ごと残す。
        if (span.getBoundingClientRect().height > targetH + 0.5) el.style.alignItems = "flex-start";
      } else {
        el.style.top = `${blk.box.y * 100}%`; // 画像高さ不明時は cy→px 換算できないので従来どおり box.y
        layer.appendChild(el); // CSS フォールバック (12px) のまま
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
        if (!contextAlive()) { shutdown(); return; } // 応答到着時に失効していたら DOM を触らず停止
        // 復元後の遅延応答 / 削除済み画像は描かない。さらに送信中に src が差し替わった (カルーセル/レスポンシブ/
        // lazy placeholder) 場合は、古い url の OCR を別画像に重ねないよう描画をスキップする (ボタンは戻して再実行可能に)。
        if (myRun !== imgRunId || !img.isConnected || (img.currentSrc || img.src) !== url) { if (btn) btn.textContent = "訳"; return; }
        if (res && res.ok && Array.isArray(res.blocks) && res.blocks.length) {
          try { renderBlocks(img, res.blocks); setBtnMode(img); } // 翻訳済み → ボタンを「原」(元に戻す) に切替
          catch (_e) { if (btn) btn.textContent = "訳"; } // 画像が消えていた等で描画失敗 → 無視
        } else if (btn) {
          btn.textContent = "×";
          window.setTimeout(() => { if (btn) btn.textContent = "訳"; }, 1500);
        }
      });
    } catch (_e) { if (btn) btn.textContent = "訳"; } // context 失効は静かに無視
  }

  let imgRunId = 0; // 画像翻訳の世代。復元時に ++ し、進行中ホバー OCR の遅延描画を止める

  // 1 つの wrap (ensureWrap で挿入) を解除して元 DOM 構造に戻す。layer 除去 + img の退避 style 復元 + ラッパー除去。
  function unwrapImage(wrap) {
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
  }

  // ホバーボタンの「原」で、その 1 枚だけオーバーレイを消して原文に戻す (ページ全体の復元とは独立)。
  function revertImg(img) {
    const wrap = img && img.parentElement;
    if (wrap && wrap.classList.contains("__rt-img-wrap")) unwrapImage(wrap);
    setBtnMode(img); // ボタンを「訳」に戻す (続けて再翻訳できる)
  }

  // 画像オーバーレイをすべて消し、ensureWrap で挿入した span.__rt-img-wrap も解除して
  // 元の DOM 構造 (img が親の直接の子) に戻す (原文復元と連動)。
  function clearAllImages() {
    imgRunId++; // 世代を進めて進行中ホバー OCR の遅延描画を無効化する
    document.querySelectorAll(".__rt-img-wrap").forEach(unwrapImage);
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
