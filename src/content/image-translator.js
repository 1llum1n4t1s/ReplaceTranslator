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
    // <picture> 内の img も対象にする。直接 span 包みすると <source> 解像度選択が壊れるため、
    // ensureWrap が <picture> ごと包んで source 選択を保つ (旧: picture を一律除外していた)。
    return el.clientWidth >= 80 && el.clientHeight >= 60 && Boolean(el.currentSrc || el.src);
  }

  // img が翻訳オーバーレイ付きか (ensureWrap で包まれ layer を持つ)。ボタンの 訳/原 切替に使う。
  // <picture> ごと包むケースでは img の親が <picture> になるため closest で wrap を辿る。
  function isTranslated(img) {
    const w = img && img.closest(".__rt-img-wrap");
    return Boolean(w && w.querySelector(".__rt-img-layer"));
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
    // <picture> 内の img は、img だけ span で包むと img が <picture> の外に出て <source> 解像度選択が
    // 外れる (別解像度/プレースホルダ化)。その場合は <picture> 自体を host として包み、source 選択を保つ。
    const host = (img.parentElement && img.parentElement.tagName === "PICTURE") ? img.parentElement : img;
    const p = host.parentElement;
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
    host.parentNode.insertBefore(wrap, host);
    wrap.appendChild(host);
    // img を wrap いっぱいにフィット。元の inline style は退避し、復元 (clearAllImages) で戻す。
    if (img.__rtPrevStyle === undefined) img.__rtPrevStyle = img.getAttribute("style") || "";
    img.style.width = "100%";
    img.style.height = "100%";
    img.style.maxWidth = "100%";
    img.style.objectFit = cs.objectFit || "contain";
    // host が <picture> のときは picture 自体も wrap を満たすようにする (picture 既定の inline だと潰れる)。
    if (host !== img) {
      if (host.__rtPrevStyle === undefined) host.__rtPrevStyle = host.getAttribute("style") || "";
      host.style.display = "block";
      host.style.width = "100%";
      host.style.height = "100%";
    }
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

  // ===== Phase 1: canvas inpaint (原文を消して訳文を画像に焼き込む) =====
  // SW が host_permissions で取得済みの base64 から CORS-safe に ImageBitmap を作る。
  // (cross-origin <img> を直接 canvas に draw すると taint され getImageData/toDataURL が封じられる)
  function bitmapFromBase64(b64, mime) {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return createImageBitmap(new Blob([u8], { type: mime || "image/png" }));
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return; }
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // box の外周リング (内側=文字部分は除外) をサンプリングし、背景の代表色・平坦さ(std)・明暗を返す。
  // 平坦なら「背景色 fill で原文を消す」、textured なら「半透明の帯で隠す」を選ぶ判断に使う。
  function ringStats(ctx, x, y, w, h, W, H) {
    const pad = Math.max(2, Math.round(Math.min(w, h) * 0.15));
    const x0 = Math.max(0, Math.floor(x - pad)), y0 = Math.max(0, Math.floor(y - pad));
    const x1 = Math.min(W, Math.ceil(x + w + pad)), y1 = Math.min(H, Math.ceil(y + h + pad));
    const rw = x1 - x0, rh = y1 - y0;
    if (rw < 2 || rh < 2) return null;
    let data;
    try { data = ctx.getImageData(x0, y0, rw, rh).data; } catch (_e) { return null; }
    const ix0 = x - x0, iy0 = y - y0, ix1 = x + w - x0, iy1 = y + h - y0;
    const step = Math.max(1, Math.round(Math.min(rw, rh) / 40));
    let n = 0, sr = 0, sg = 0, sb = 0, s2 = 0;
    for (let py = 0; py < rh; py += step) {
      for (let px = 0; px < rw; px += step) {
        if (px >= ix0 && px < ix1 && py >= iy0 && py < iy1) continue; // box 内側 (文字) は除外
        const o = (py * rw + px) * 4;
        const r = data[o], g = data[o + 1], b = data[o + 2];
        sr += r; sg += g; sb += b; s2 += r * r + g * g + b * b; n++;
      }
    }
    if (!n) return null;
    const mr = sr / n, mg = sg / n, mb = sb / n;
    const variance = Math.max(0, s2 / n - (mr * mr + mg * mg + mb * mb)) / 3; // チャンネル平均分散
    const lum = (0.299 * mr + 0.587 * mg + 0.114 * mb) / 255;
    return { color: [Math.round(mr), Math.round(mg), Math.round(mb)], std: Math.sqrt(variance), dark: lum < 0.5 };
  }

  // 訳文を maxWidth に折り返す。空白で割れない CJK は 1 文字ずつ詰め、長い英単語も文字単位で割る。
  function wrapCanvasText(ctx, text, maxWidth) {
    const lines = [];
    let line = "";
    for (const ch of String(text)) {
      const test = line + ch;
      if (ch !== " " && line && ctx.measureText(test).width > maxWidth) {
        lines.push(line); line = ch;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
    return lines.length ? lines : [String(text)];
  }

  // 枠 (innerW×innerH) に収まる最大フォント(px)と折り返し行を二分探索で求める (canvas 版 fitFontSize)。
  function fitCanvasFont(ctx, text, innerW, innerH, family) {
    let lo = 7, hi = Math.max(7, Math.floor(innerH)), best = 7, bestLines = [String(text)];
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      ctx.font = `600 ${mid}px ${family}`;
      const lines = wrapCanvasText(ctx, text, innerW);
      const fits = lines.length * mid * 1.18 <= innerH && lines.every((l) => ctx.measureText(l).width <= innerW);
      if (fits) { best = mid; bestLines = lines; lo = mid + 1; } else hi = mid - 1;
    }
    return { fontSize: best, lines: bestLines };
  }

  const CANVAS_FONT = 'system-ui, -apple-system, "Segoe UI", "Hiragino Kaku Gothic ProN", "Yu Gothic UI", sans-serif';

  // Phase 2: 平坦背景のとき box(+余白)内で背景色と差のある画素=文字インクの外接矩形を求め、
  // 「ink 外接 ∪ 元 box」(縮めず広げるのみ)へ消去域を補正する。LLM/OCR の右ズレ box が行頭グリフを
  // 取りこぼすのを防ぐため左を字高基準で厚く探索する。左右の拡張は maxExtend で頭打ちし、離れた
  // グラフィック(ロゴ等)へ到達させない。文字が無い/探索域がほぼ全面インク(背景判定ミス)なら null。
  function snapToInk(ctx, x, y, w, h, bg, W, H) {
    // 左を厚く(行頭の取りこぼし対策・字高 1 文字ぶんは必ず左を見る)、右と上下は控えめ。
    const mxL = Math.max(w * 0.30, h * 0.7), mxR = w * 0.14, my = h * 0.28;
    const sx = Math.max(0, Math.floor(x - mxL)), sy = Math.max(0, Math.floor(y - my));
    const ex = Math.min(W, Math.ceil(x + w + mxR)), ey = Math.min(H, Math.ceil(y + h + my));
    const rw = ex - sx, rh = ey - sy;
    if (rw < 3 || rh < 3) return null;
    let d;
    try { d = ctx.getImageData(sx, sy, rw, rh).data; } catch (_e) { return null; }
    const step = Math.max(1, Math.round(Math.min(rw, rh) / 120)); // 大きい box は間引いて高速化
    let minx = rw, miny = rh, maxx = -1, maxy = -1, count = 0, sampled = 0;
    for (let py = 0; py < rh; py += step) {
      for (let px = 0; px < rw; px += step) {
        sampled++;
        const o = (py * rw + px) * 4;
        const dr = d[o] - bg[0], dg = d[o + 1] - bg[1], db = d[o + 2] - bg[2];
        if (dr * dr + dg * dg + db * db > 2304) { // RGB ユークリッド距離 ~48 超 = 文字インク(細い縦画/薄字/AA 縁も拾う)
          if (px < minx) minx = px; if (px > maxx) maxx = px;
          if (py < miny) miny = py; if (py > maxy) maxy = py; count++;
        }
      }
    }
    if (count < 4 || maxx < minx || maxy < miny) return null;     // 文字らしき画素が無い
    if (count / sampled > 0.9) return null;                       // 探索域のほぼ全面=背景判定ミス/textured
    // ink 外接矩形と元 box の union(縮めない=行頭グリフを絶対に削らない)。左右拡張は maxExtend で
    // 頭打ちし、離れたグラフィック(ロゴ等)へ到達させない。縦は ink 側へ素直に広げる(隣行は my 制限で抑制)。
    const ix = sx + Math.max(0, minx - 1), iy = sy + Math.max(0, miny - 1);
    const iex = sx + Math.min(rw, maxx + step + 1), iey = sy + Math.min(rh, maxy + step + 1);
    const maxExtend = Math.min(W * 0.04, h * 1.5);
    const ux = Math.max(x - maxExtend, Math.min(x, ix));
    const uy = Math.min(y, iy);
    const uex = Math.min(x + w + maxExtend, Math.max(x + w, iex));
    const uey = Math.max(y + h, iey);
    return { x: ux, y: uy, w: Math.max(2, uex - ux), h: Math.max(2, uey - uy) };
  }

  // 1 ブロックぶん: 原文を消し (平坦=背景色 fill / textured=半透明帯) 訳文を縦中央 (cy) に焼き込む。
  function drawInpaintBlock(ctx, blk, W, H) {
    let w = Math.max(2, blk.box.w * W);
    let h = Math.max(2, blk.box.h * H);
    let x = Math.min(Math.max(0, blk.box.x * W), Math.max(0, W - w));
    const cyN = (typeof blk.cy === "number" && blk.cy >= 0 && blk.cy <= 1) ? blk.cy : (blk.box.y + blk.box.h / 2);
    let y = Math.min(Math.max(0, cyN * H - h / 2), Math.max(0, H - h));
    const st = ringStats(ctx, x, y, w, h, W, H);
    const flat = st && st.std < 24; // 外周の色ブレが小さい=平坦背景 → 背景色 fill で原文を消せる
    if (flat) {
      const snap = snapToInk(ctx, x, y, w, h, st.color, W, H); // Phase 2: 実 glyph 位置へ消去域を補正(union・広げるのみ)
      if (snap) { x = snap.x; y = snap.y; w = snap.w; h = snap.h; }
      // 消去マージンを字高(h)基準の非対称に。横6%固定では行頭グリフ縁と行間/周囲の薄残りを覆えない。
      const dl = Math.max(3, h * 0.34); // 左: 行頭余白を厚く(行頭ゴースト対策)
      const dr = Math.max(2, h * 0.16); // 右: 訳文はみ出し抑制で控えめ
      const dy = Math.max(2, h * 0.30); // 上下: アセンダ/ディセンダ+行間の薄残り回収
      ctx.fillStyle = `rgb(${st.color[0]},${st.color[1]},${st.color[2]})`;
      ctx.fillRect(x - dl, y - dy, w + dl + dr, h + 2 * dy);
    } else {
      ctx.fillStyle = "rgba(20,28,38,0.84)"; // textured: 半透明の暗い帯で隠す (従来オーバーレイ相当を canvas に焼く)
      roundRectPath(ctx, x, y, w, h, Math.min(6, h * 0.2));
      ctx.fill();
    }
    const padX = w * 0.05, padY = h * 0.08;
    const innerW = Math.max(4, w - 2 * padX), innerH = Math.max(4, h - 2 * padY);
    const { fontSize, lines } = fitCanvasFont(ctx, blk.translation, innerW, innerH, CANVAS_FONT);
    ctx.font = `600 ${fontSize}px ${CANVAS_FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = flat ? (st.dark ? "#f5f5f5" : "#1a1a1a") : "#ffffff";
    if (!flat) { ctx.shadowColor = "rgba(0,0,0,0.55)"; ctx.shadowBlur = 2; ctx.shadowOffsetY = 1; }
    const lineH = fontSize * 1.18;
    const startY = y + h / 2 - (lines.length - 1) * lineH / 2;
    lines.forEach((ln, i) => ctx.fillText(ln, x + w / 2, startY + i * lineH));
    ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
  }

  const INPAINT_MAX_SIDE = 4096; // 巨大画像で canvas メモリが膨らむのを抑える長辺上限

  // 元画像を canvas に描き各ブロックを inpaint して、wrap の最前面レイヤーとして被せる (img 自体は触らない)。
  // canvas は __rt-img-layer クラスを持つので isTranslated/unwrapImage/revertImg がそのまま機能する。
  async function renderInpaint(img, blocks, image) {
    const bmp = await bitmapFromBase64(image.base64, image.mime);
    try {
      const scale = Math.min(1, INPAINT_MAX_SIDE / Math.max(bmp.width, bmp.height));
      const W = Math.max(1, Math.round(bmp.width * scale)), H = Math.max(1, Math.round(bmp.height * scale));
      const canvas = document.createElement("canvas");
      canvas.className = "__rt-img-layer __rt-img-canvas";
      canvas.width = W; canvas.height = H;
      canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;";
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("no 2d ctx");
      ctx.drawImage(bmp, 0, 0, W, H);
      for (const blk of blocks) {
        if (!blk || !blk.box || typeof blk.translation !== "string" || !blk.translation) continue;
        try { drawInpaintBlock(ctx, blk, W, H); } catch (_e) { /* 1 ブロック失敗は無視して継続 */ }
      }
      const wrap = ensureWrap(img);
      wrap.querySelectorAll(".__rt-img-layer").forEach((l) => l.remove()); // 旧オーバーレイ/canvas を除去
      wrap.appendChild(canvas);
    } finally {
      if (bmp && bmp.close) bmp.close();
    }
  }

  const INPAINT_NEURAL_MAX_SIDE = 1536; // MI-GAN は重いので neural 経路は小さめにスケール

  // neural 消去後の clean 背景に、訳文だけを焼き込む (塗り潰しはしない・背景明暗で文字色を決定)。
  function drawTextOnly(ctx, blk, W, H) {
    const w = Math.max(2, blk.box.w * W);
    const h = Math.max(2, blk.box.h * H);
    const x = Math.min(Math.max(0, blk.box.x * W), Math.max(0, W - w));
    const cyN = (typeof blk.cy === "number" && blk.cy >= 0 && blk.cy <= 1) ? blk.cy : (blk.box.y + blk.box.h / 2);
    const y = Math.min(Math.max(0, cyN * H - h / 2), Math.max(0, H - h));
    const st = ringStats(ctx, x, y, w, h, W, H); // 消去後の clean 背景をサンプリングして文字色を決める
    const dark = st ? st.dark : false;
    const padX = w * 0.05, padY = h * 0.08;
    const { fontSize, lines } = fitCanvasFont(ctx, blk.translation, Math.max(4, w - 2 * padX), Math.max(4, h - 2 * padY), CANVAS_FONT);
    ctx.font = `600 ${fontSize}px ${CANVAS_FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = dark ? "#f5f5f5" : "#1a1a1a";
    ctx.shadowColor = dark ? "rgba(0,0,0,0.6)" : "rgba(255,255,255,0.6)"; // 背景と同系の縁取りで可読性確保
    ctx.shadowBlur = 2;
    const lineH = fontSize * 1.18;
    const startY = y + h / 2 - (lines.length - 1) * lineH / 2;
    lines.forEach((ln, i) => ctx.fillText(ln, x + w / 2, startY + i * lineH));
    ctx.shadowColor = "transparent"; ctx.shadowBlur = 0;
  }

  // MI-GAN(offscreen)で原文領域を inpaint 消去 → 返ってきた消去済み画像に訳文を焼き込む (Phase 3・Chrome 限定)。
  async function renderInpaintNeural(img, blocks, image) {
    const resp = await chrome.runtime.sendMessage({
      action: A.INPAINT_IMAGE,
      payload: {
        base64: image.base64, mime: image.mime, maxSide: INPAINT_NEURAL_MAX_SIDE,
        blocks: blocks.map((b) => ({ box: b.box })),
      },
    });
    if (!resp || !resp.ok || !resp.result || !resp.result.base64) throw new Error("inpaint failed");
    const r = resp.result;
    const bmp = await bitmapFromBase64(r.base64, "image/png");
    try {
      const W = r.width || bmp.width, H = r.height || bmp.height;
      const canvas = document.createElement("canvas");
      canvas.className = "__rt-img-layer __rt-img-canvas";
      canvas.width = W; canvas.height = H;
      canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;";
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("no 2d ctx");
      ctx.drawImage(bmp, 0, 0, W, H);
      for (const blk of blocks) {
        if (!blk || !blk.box || typeof blk.translation !== "string" || !blk.translation) continue;
        try { drawTextOnly(ctx, blk, W, H); } catch (_e) { /* 1 ブロック失敗は無視 */ }
      }
      const wrap = ensureWrap(img);
      wrap.querySelectorAll(".__rt-img-layer").forEach((l) => l.remove());
      wrap.appendChild(canvas);
    } finally {
      if (bmp && bmp.close) bmp.close();
    }
  }

  // 描画方式の選択: neuralErase なら MI-GAN 消去 → 失敗で背景色 fill canvas → さらに失敗で HTML オーバーレイ。
  async function renderTranslated(img, blocks, image, opts) {
    if (image && image.base64) {
      if (opts && opts.neuralErase) {
        try { await renderInpaintNeural(img, blocks, image); return; } catch (_e) { /* canvas fill へ */ }
      }
      try { await renderInpaint(img, blocks, image); return; } catch (_e) { /* HTML オーバーレイへ */ }
    }
    renderBlocks(img, blocks);
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
          // canvas inpaint (原文消去 + 訳文焼き込み) を試し、画像バイトが無い/失敗時は HTML オーバーレイへ。
          // neuralErase は SW がレスポンスに乗せる (Chrome のみ。Firefox/失敗時は背景色 fill にフォールバック)。
          renderTranslated(img, res.blocks, res.image, { neuralErase: res.neuralErase })
            .then(() => { if (myRun === imgRunId) setBtnMode(img); }) // 翻訳済み → ボタンを「原」に切替
            .catch(() => { if (btn) btn.textContent = "訳"; });        // 画像が消えていた等で描画失敗 → 無視
        } else if (btn) {
          btn.textContent = "×";
          window.setTimeout(() => { if (btn) btn.textContent = "訳"; }, 1500);
        }
      });
    } catch (_e) { if (btn) btn.textContent = "訳"; } // context 失効は静かに無視
  }

  let imgRunId = 0; // 画像翻訳の世代。復元時に ++ し、進行中ホバー OCR の遅延描画を止める

  // ensureWrap で退避した元 inline style を戻す (フィット用の width/height 等を除去)。
  function restorePrevStyle(el) {
    if (!el || el.__rtPrevStyle === undefined) return;
    if (el.__rtPrevStyle) el.setAttribute("style", el.__rtPrevStyle); else el.removeAttribute("style");
    try { delete el.__rtPrevStyle; } catch (_e) { el.__rtPrevStyle = undefined; }
  }

  // 1 つの wrap (ensureWrap で挿入) を解除して元 DOM 構造に戻す。layer 除去 + 退避 style 復元 + ラッパー除去。
  // 包んだ実体 (host) は <picture> ごと包んだなら picture、そうでなければ img。host を外へ戻す。
  function unwrapImage(wrap) {
    const img = wrap.querySelector("img");
    const host = wrap.querySelector("picture") || img;
    const parent = wrap.parentNode;
    wrap.querySelectorAll(".__rt-img-layer").forEach((l) => l.remove());
    if (!host || !parent) return;
    restorePrevStyle(img);
    if (host !== img) restorePrevStyle(host); // picture に付けた display/width/height も戻す
    parent.insertBefore(host, wrap);          // host (picture か img) をラッパーの外へ戻す
    wrap.remove();                            // 空になったラッパーを除去
  }

  // ホバーボタンの「原」で、その 1 枚だけオーバーレイを消して原文に戻す (ページ全体の復元とは独立)。
  function revertImg(img) {
    const wrap = img && img.closest(".__rt-img-wrap"); // <picture> ネストでも wrap を辿れる
    if (wrap) unwrapImage(wrap);
    setBtnMode(img); // ボタンを「訳」に戻す (続けて再翻訳できる)
  }

  // 画像オーバーレイをすべて消し、ensureWrap で挿入した span.__rt-img-wrap も解除して
  // 元の DOM 構造 (img が親の直接の子) に戻す (原文復元と連動)。
  function clearAllImages() {
    imgRunId++; // 世代を進めて進行中ホバー OCR の遅延描画を無効化する
    document.querySelectorAll(".__rt-img-wrap").forEach(unwrapImage);
    // 念のため: ラッパー解除前に取り残された __rtPrevStyle 付き img/picture があれば素の状態へ戻す (二重防御)
    document.querySelectorAll("img[style*='100%']").forEach(restorePrevStyle);
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
