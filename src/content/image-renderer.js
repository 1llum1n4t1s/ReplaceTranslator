"use strict";

(function () {
  if (!ExtUtil.claimScript("__rtImageRendererLoaded")) return;
  globalThis.createImageRenderer = function createImageRenderer({ isStaleImg, isDead, unwrapImage, stopFollow, dbg }) {
  const MIN_IMAGE_FONT_SIZE = 12;
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
    const style = getComputedStyle(img);
    if (imgW > 0 && imgH > 0 && img.naturalWidth > 0 && img.naturalHeight > 0) {
      const fit = fitDrawRect(style.objectFit, img.naturalWidth, img.naturalHeight, imgW, imgH, style.objectPosition);
      blocks = remapBlocksToFit(blocks, fit, imgW, imgH).filter(blockInView);
    }
    const items = blocks.map(blk => {
      const r = blockPixelRect(blk, imgW, imgH);
      return { pb: { x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h, w: r.w, h: r.h, cyPx: r.y + r.h / 2 } };
    });
    blocks.forEach((blk, index) => {
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
      // 最小フォント12pxの1行とpaddingを下限にする。
      const boxHpx = Math.max(MIN_IMAGE_FONT_SIZE * 1.18 + 2, Math.max(0.03, blk.box.h) * imgH);
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
        let targetW = Math.max(8, el.clientWidth - 8);
        let targetH = Math.max(8, el.clientHeight - 2);
        // 12pxで溢れる小さい枠は、隣の文字に重ならない余白へ先に広げる。
        span.style.fontSize = `${MIN_IMAGE_FONT_SIZE}px`;
        if (span.getBoundingClientRect().height > targetH + 0.5) {
          const item = items[index], hw = availHWForFlat(items, item, imgW);
          const align = hw.r > hw.l * 1.5 + MIN_IMAGE_FONT_SIZE ? "left"
            : hw.l > hw.r * 1.5 + MIN_IMAGE_FONT_SIZE ? "right" : "center";
          const width = Math.min(imgW, item.pb.w + (align === "left" ? hw.r : align === "right" ? hw.l : 2 * Math.min(hw.l, hw.r)));
          const left = align === "left" ? item.pb.x0 : align === "right" ? item.pb.x1 - width : (item.pb.x0 + item.pb.x1 - width) / 2;
          el.style.left = `${Math.max(0, Math.min(imgW - width, left))}px`;
          el.style.width = `${width}px`;
          span.style.textAlign = align;
          targetW = Math.max(8, el.clientWidth - 8);
          const needed = span.getBoundingClientRect().height + 2;
          let topLimit = 0, bottomLimit = imgH;
          for (const other of items) {
            if (other === item || other.pb.x1 <= left || other.pb.x0 >= left + width) continue;
            if (other.pb.cyPx < item.pb.cyPx) topLimit = Math.max(topLimit, other.pb.y1 + 2);
            else bottomLimit = Math.min(bottomLimit, other.pb.y0 - 2);
          }
          const height = Math.max(boxHpx, Math.min(needed, bottomLimit - topLimit));
          el.style.height = `${height}px`;
          el.style.top = `${Math.max(topLimit, Math.min(bottomLimit - height, cyN * imgH - height / 2))}px`;
          targetH = Math.max(8, el.clientHeight - 2);
        }
        // 「文字が枠を埋める1行ぶんの高さ」を文字面積モデルで推定し、フォント上限にする。これを常に効かせて、
        // 原文 (original) が来ないとき上限が箱の高さ (最大48px) に張り付き、短い訳文が巨大化するのを防ぐ。
        // 面積モデル: 行高 L・文字幅≈0.6L とすると len·0.6·L² ≈ boxW·boxH → L = √(boxW·boxH / (len·0.6))。
        // original が来れば密度信号に使う。無い/極短なら訳文長から原文長を概算する (EN→JA は訳文が原文の約半分の文字数)。
        const origLen = (blk.original || "").trim().length;
        const effLen = origLen > 1 ? origLen : Math.max(2, (blk.translation || "").trim().length) * 2;
        const lineHpx = Math.sqrt((targetW * boxHpx) / (effLen * 0.6));
        // 単一行の箱 (高さが小さい) は箱の高さで頭打ち、複数行の箱は1行ぶんに抑える。絶対上限も 40px に控える。
        const maxFs = Math.min(40, Math.max(MIN_IMAGE_FONT_SIZE, Math.round(Math.min(boxHpx, lineHpx) / 1.15)));
        fitFontSize(span, targetW, targetH, MIN_IMAGE_FONT_SIZE, maxFs);
        // 周囲の余白を使っても収まらない場合は上寄せにし、先頭行を残す。
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

  // renderInpaint が描画前に object-fit 描画域 (fitDrawRect の戻り) を入れる。ringStats が contain の
  // レターボックス透明画素をサンプリングから除外するのに使う (null=全面=恒等)。renderInpaint の描画区間は
  // await を挟まない同期処理なので、set→使用→finally で null クリアまで他の renderInpaint と競合しない。
  let inpaintFit = null;
  function imageContentBounds(W, H) {
    return inpaintFit ? {
      x0: Math.max(0, Math.ceil(inpaintFit.dx)), y0: Math.max(0, Math.ceil(inpaintFit.dy)),
      x1: Math.min(W, Math.floor(inpaintFit.dx + inpaintFit.dw)), y1: Math.min(H, Math.floor(inpaintFit.dy + inpaintFit.dh)),
    } : { x0: 0, y0: 0, x1: W, y1: H };
  }

  // box の外周リング (内側=文字部分は除外) をサンプリングし、背景の代表色・平坦さ(std)・明暗・不透明度(alpha)を返す。
  // 平坦なら「背景色 fill で原文を消す」、textured なら「半透明の帯で隠す」を選ぶ判断に使う。alpha は透過背景の保護用。
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
    let n = 0, sr = 0, sg = 0, sb = 0, s2 = 0, sa = 0;
    const fit = inpaintFit; // object-fit 描画域。contain のレターボックス透明画素を弾き alpha/色の誤検出を防ぐ
    for (let py = 0; py < rh; py += step) {
      for (let px = 0; px < rw; px += step) {
        if (px >= ix0 && px < ix1 && py >= iy0 && py < iy1) continue; // box 内側 (文字) は除外
        if (fit && (x0 + px < fit.dx || x0 + px >= fit.dx + fit.dw || y0 + py < fit.dy || y0 + py >= fit.dy + fit.dh)) continue; // 描画域外 (透明レターボックス) は除外
        const o = (py * rw + px) * 4;
        const r = data[o], g = data[o + 1], b = data[o + 2];
        sr += r; sg += g; sb += b; s2 += r * r + g * g + b * b; sa += data[o + 3]; n++;
      }
    }
    if (!n) return null;
    const mr = sr / n, mg = sg / n, mb = sb / n;
    const variance = Math.max(0, s2 / n - (mr * mr + mg * mg + mb * mb)) / 3; // チャンネル平均分散
    const lum = (0.299 * mr + 0.587 * mg + 0.114 * mb) / 255;
    return { color: [Math.round(mr), Math.round(mg), Math.round(mb)], std: Math.sqrt(variance), dark: lum < 0.5, alpha: sa / n / 255 };
  }

  // 訳文を maxWidth に折り返す。空白で割れない CJK は 1 文字ずつ詰め、長い英単語も文字単位で割る。
  function wrapCanvasText(ctx, text, maxWidth) {
    const lines = [];
    let line = "";
    for (const ch of String(text)) {
      if (ch === "\r") continue;
      if (ch === "\n") { lines.push(line); line = ""; continue; }
      const test = line + ch;
      if (ch !== " " && line && ctx.measureText(test).width > maxWidth) {
        lines.push(line); line = ch;
      } else {
        line = test;
      }
    }
    lines.push(line);
    return lines;
  }

  // font-sizeのemではなく実際の文字面を測り、英字とCJKのベースライン差も含めて中央を合わせる。
  function canvasLineMetrics(ctx, lines, fontSize) {
    let ascent = 0, descent = 0;
    for (const line of lines) {
      const metrics = ctx.measureText(line || "Mg");
      ascent = Math.max(ascent, Number(metrics.actualBoundingBoxAscent) || 0);
      descent = Math.max(descent, Number(metrics.actualBoundingBoxDescent) || 0);
    }
    if (ascent + descent <= 0) { ascent = fontSize * 0.8; descent = fontSize * 0.2; }
    const lineHeight = Math.max(fontSize * 1.18, ascent + descent);
    return { ascent, descent, lineHeight, height: ascent + descent + Math.max(0, lines.length - 1) * lineHeight };
  }

  // 枠 (innerW×innerH) に収まる最大フォント(px)と折り返し行を二分探索で求める (canvas 版 fitFontSize)。
  function fitCanvasFont(ctx, text, innerW, innerH, family, minFs = MIN_IMAGE_FONT_SIZE, maxFs = innerH) {
    const minimum = Math.max(1, Math.ceil(minFs));
    let lo = minimum, hi = Math.max(minimum, Math.floor(maxFs)), best = minimum;
    ctx.font = `600 ${minimum}px ${family}`;
    let bestLines = wrapCanvasText(ctx, text, innerW);
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      ctx.font = `600 ${mid}px ${family}`;
      const lines = wrapCanvasText(ctx, text, innerW);
      const fits = canvasLineMetrics(ctx, lines, mid).height <= innerH && lines.every((l) => ctx.measureText(l).width <= innerW);
      if (fits) { best = mid; bestLines = lines; lo = mid + 1; } else hi = mid - 1;
    }
    return { fontSize: best, lines: bestLines };
  }

  const CANVAS_FONT = 'system-ui, -apple-system, "Segoe UI", "Hiragino Kaku Gothic ProN", "Yu Gothic UI", sans-serif';

  // 焼き込みフォント問題の切り分け用ログ。既定は完全無音。ページ console で localStorage.__rt_debug を立てると出る。
  // 例: localStorage.setItem("__rt_debug","1") → 再翻訳すると [rt-img] 経路/解像度/各 block の font を出力。

  // Phase 2: 平坦背景のとき box(+余白)内で背景色と差のある画素=文字インクの外接矩形を求め、
  // 「ink 外接 ∪ 元 box」(縮めず広げるのみ)へ消去域を補正する。LLM/OCR の右ズレ box が行頭グリフを
  // 取りこぼすのを防ぐため左を字高基準で厚く探索する。左右の拡張は maxExtend で頭打ちし、離れた
  // グラフィック(ロゴ等)へ到達させない。文字が無い/探索域がほぼ全面インク(背景判定ミス)なら null。
  function snapToInk(ctx, x, y, w, h, bg, W, H) {
    // 左を厚く(行頭の取りこぼし対策・字高 1 文字ぶんは必ず左を見る)、右と上下は控えめ。
    const mxL = Math.max(w * 0.30, h * 0.7), mxR = w * 0.14, my = h * 0.28;
    const bounds = imageContentBounds(W, H);
    const sx = Math.max(bounds.x0, Math.floor(x - mxL)), sy = Math.max(bounds.y0, Math.floor(y - my));
    const ex = Math.min(bounds.x1, Math.ceil(x + w + mxR)), ey = Math.min(bounds.y1, Math.ceil(y + h + my));
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
        if (d[o + 3] < 128) continue;
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
    // 消去域はunionのまま保持し、文字の配置・サイズには余白を含まないinkを使う。
    const inkX = Math.max(x - maxExtend, sx + minx), inkRight = Math.min(x + w + maxExtend, sx + maxx + step);
    return { x: ux, y: uy, w: Math.max(2, uex - ux), h: Math.max(2, uey - uy),
      ink: { x: inkX, y: sy + miny, w: Math.max(2, inkRight - inkX), h: Math.max(2, maxy - miny + step) } };
  }

  // ===== 行間ストリップ埋め (症状: 段落の行間に原文の黒帯が残る) =====
  // vision は段落を「行ごとの別 block」で返しがち。各行を独立 fill すると隣接行の間に未塗りの隙間が残り、
  // 原文の上下端ストロークが帯状に居残る。dy を増やすと隣行訳文背景を侵食するため、同一段落と判定できた
  // 隣接行の「行間 (x 重なり区間 × 隙間)」だけを背景色で連結 fill する前段パスを drawInpaintBlock の前に挟む。
  function colorDist(a, b) {
    const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
    return Math.sqrt(dr * dr + dg * dg + db * db);
  }

  // VLM が返す縦中央 cy を描画座標へ変換する規則を、判定・計測・描画で共有する。
  function blockPixelRect(blk, W, H) {
    const w = Math.max(2, blk.box.w * W), h = Math.max(2, blk.box.h * H);
    const x = Math.min(Math.max(0, blk.box.x * W), Math.max(0, W - w));
    const cyN = (typeof blk.cy === "number" && blk.cy >= 0 && blk.cy <= 1) ? blk.cy : (blk.box.y + blk.box.h / 2);
    const y = Math.min(Math.max(0, cyN * H - h / 2), Math.max(0, H - h));
    return { x, y, w, h };
  }

  // drawInpaintBlock と同じ pixel box で flat 背景色も返す (textured/極小は null)。
  function flatBoxOf(ctx, blk, W, H) {
    if (!blk || !blk.box || typeof blk.translation !== "string" || !blk.translation) return null;
    const { x, y, w, h } = blockPixelRect(blk, W, H);
    const st = ringStats(ctx, x, y, w, h, W, H);
    if (!st || st.std >= 24 || (st.alpha != null && st.alpha < 0.5)) return null; // flat 不透明背景のみ (textured/透過は除外し行間 fill を乗せない)
    return { x0: x, y0: y, x1: x + w, y1: y + h, w, h, color: st.color };
  }

  // 隣接 2 box が「同一段落の連続行」か (全 AND)。段組/別色/別段落/ロゴ↔本文の誤連結を弾く。
  function shouldLinkRows(prev, cur) {
    const overlapX = Math.min(prev.x1, cur.x1) - Math.max(prev.x0, cur.x0);
    const lineRef = Math.max(prev.h, cur.h);
    const gap = cur.y0 - prev.y1;
    const hRatio = cur.h / prev.h;
    return colorDist(prev.color, cur.color) < 40 &&    // 同色背景のみ (別パネル/別背景境界を塗らない)
      overlapX > 0.5 * Math.min(prev.w, cur.w) &&      // x が半分以上重なる=同一カラム (段組を弾く)
      hRatio > 0.5 && hRatio < 2.0 &&                  // 高さ近似 (見出し↔本文・ロゴ↔本文を弾く)
      gap > 0 && gap < 0.7 * lineRef;                  // 行間相当の隙間のみ (段落境界の広い余白を塗らない)
  }

  // flat 同色の隣接行ペアの行間だけを背景色で 1 回 fill。renderInpaint の per-block ループ直前に呼ぶ。
  function fillInterlineStrips(ctx, blocks, W, H) {
    const boxes = [];
    for (const blk of blocks) { const fb = flatBoxOf(ctx, blk, W, H); if (fb && fb.h >= 6) boxes.push(fb); }
    boxes.sort((a, b) => a.y0 - b.y0);
    for (let i = 1; i < boxes.length; i++) {
      const prev = boxes[i - 1], cur = boxes[i];
      if (!shouldLinkRows(prev, cur)) continue;
      const ox = Math.max(prev.x0, cur.x0), ow = Math.min(prev.x1, cur.x1) - ox; // x 重なり区間のみ
      const gap = cur.y0 - prev.y1, pad = Math.min(2, gap * 0.25);
      const sy = prev.y1 - pad, sh = (cur.y0 + pad) - sy;
      if (ow <= 1 || sh <= 0) continue;
      const c = [(prev.color[0] + cur.color[0]) >> 1, (prev.color[1] + cur.color[1]) >> 1, (prev.color[2] + cur.color[2]) >> 1];
      ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
      ctx.fillRect(Math.round(ox), Math.round(sy), Math.round(ow), Math.round(sh));
    }
  }

  // ===== 焼き込みフォントを「行送りピッチ」で決める (症状: 訳文が小さく・細く・薄い) =====
  // det 締め (dilation 0.08/0.12) で OCR box.h が cap-height 寄りに痩せ、box.h に枠フィットすると font が
  // 元の見た目より小さくなる。元テキストの見た目サイズは行送り (cy 間隔=pitch) が最も素直な信号なので、
  // pitch から font を決める。単独行は pitch が無いので box.h から外挿する。
  const PITCH_TO_FONT = 0.78;     // font = pitch * 0.78 (行送り 1.28 倍 ≒ leading の逆数)
  const PITCH_FROM_H = 1.30;      // 単独行の pitch ≒ box.h * 1.30 (異常値ガード用の pitch 外挿)
  const H_TO_FONT = 1.85;         // 単独行 font = box.h * 1.85。原文の見た目(box.h≒cap-height で font の ~0.7 倍)より一回り
                                  // 大きく焼き、同 px だと窮屈な CJK の可読性を確保する。行重なりは avail*availClamp(<1.0)
                                  // クランプ + wrap/fitCanvasFont の縦予算で構造的に防ぐ(各行高さ ≤ 隣行ピッチの 90%)ので、
                                  // 隣に余白がある行(見出し/孤立行)だけが ABS_MAX まで実際に伸び、密な行は avail で頭打ちになる
  const ABS_MAX = 40;             // 焼き込みフォントの絶対上限 px (短語/極短 box の暴発防止)

  function median(arr) {
    if (!arr.length) return 0;
    const s = arr.slice().sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  // flatBoxOf の flat 限定を外した版 (pitch 計測は textured 段落も対象)。flat/textured は flat フラグで返し、
  // 連結判定 (shouldLinkRowsPitch) の色条件は両方 flat のときだけ要求する。cyPx=描画と同じ縦中央。
  function pixelBoxOf(ctx, blk, W, H) {
    if (!blk || !blk.box || typeof blk.translation !== "string" || !blk.translation) return null;
    const rect = blockPixelRect(blk, W, H);
    const st = ringStats(ctx, rect.x, rect.y, rect.w, rect.h, W, H);
    const flat = !!(st && st.std < 24 && (st.alpha == null || st.alpha >= 0.5));
    const snap = flat ? snapToInk(ctx, rect.x, rect.y, rect.w, rect.h, st.color, W, H) : null;
    const { x, y, w, h } = snap ? snap.ink : rect;
    blk.__rtTextBox = { x, y, w, h };
    blk.__rtEraseBox = snap || rect;
    blk.__rtBackground = st;
    // cyPx は描画と同じ「クランプ後の縦中央」(y+h/2)。pitch 計測も availPitch も実際の描画位置と一致させる
    // (端でクランプされた行を cyN*H にすると gap を過小評価し font が不要に縮む)。
    return { x0: x, y0: y, x1: x + w, y1: y + h, w, h, cyPx: y + h / 2, color: st ? st.color : [128, 128, 128], flat };
  }

  // shouldLinkRows と同条件だが、色一致は「両方 flat」のときだけ要求 (textured 段落も同段落として連結し pitch を測る)。
  function shouldLinkRowsPitch(prev, cur) {
    const overlapX = Math.min(prev.x1, cur.x1) - Math.max(prev.x0, cur.x0);
    const lineRef = Math.max(prev.h, cur.h);
    const gap = cur.y0 - prev.y1;
    const hRatio = cur.h / prev.h;
    const colorOk = (prev.flat && cur.flat) ? colorDist(prev.color, cur.color) < 40 : true;
    return colorOk &&
      overlapX > 0.5 * Math.min(prev.w, cur.w) &&
      hRatio > 0.5 && hRatio < 2.0 &&
      gap > 0 && gap < 0.7 * lineRef;
  }

  // 同カラム(x 重なり)で最も近い行との cy 実測間隔を「真上・真下の両方向」で測り、近い側を返す。隣が無ければ Infinity。
  // 訳文は cy 中央寄せで上下対称に伸びるため、下方向だけ見ると段落「最終行」が avail=Infinity になり上の行へ食い込む
  // (H_TO_FONT を上げると顕在化)。両方向の最小間隔で頭打ちすれば、各行の高さ ≤ 0.9×間隔 となり上下どちらも重ならない (G1)。
  function availPitchFor(items, i) {
    const cur = items[i].pb;
    let best = Infinity;
    // 呼び出し元で cy 昇順に並べてあるため、各方向の最初の同カラム行より先は調べなくてよい。
    for (let direction = -1; direction <= 1; direction += 2) {
      for (let j = i + direction; j >= 0 && j < items.length; j += direction) {
        const o = items[j].pb;
        const d = Math.abs(o.cyPx - cur.cyPx);
        if (d >= best) break;
        if (d === 0) continue;
        const overlapX = Math.min(cur.x1, o.x1) - Math.max(cur.x0, o.x0);
        if (overlapX <= 0) continue;
        best = d;
        break;
      }
    }
    return best;
  }

  // flat 単独行を「均一余白」へ横展開するための、同一 y 帯での左右の安全余白(px)。隣 block か画像端まで。
  // 英→全角で訳文が英文 box.w を超え縮小されるのを、左右の余白を使って原文サイズ 1 行に保つために測る。
  function availHWForFlat(items, cur, W) {
    const c = cur.pb;
    let l = c.x0, r = Math.max(0, W - c.x1); // 既定は画像端までの余白
    for (const o of items) {
      if (o === cur) continue;
      const p = o.pb;
      if (Math.abs(p.cyPx - c.cyPx) >= (c.h + p.h) / 2) continue; // 同一 y 帯 (縦に重なる) のみ水平の隣として扱う
      if (p.x1 <= c.x0) { const g = c.x0 - p.x1; if (g < l) l = g; }      // 左隣の右端まで
      else if (p.x0 >= c.x1) { const g = p.x0 - c.x1; if (g < r) r = g; } // 右隣の左端まで
    }
    return { l: Math.max(0, l - 4), r: Math.max(0, r - 4) }; // gap 4px のマージンを残す
  }

  // 段落 (shouldLinkRowsPitch で連結する隣接行) ごとに pitch を測り、font = pitch*PITCH_TO_FONT で per-block 確定。
  // box.h は det 締めで信用できないため pitch (cy 間隔) を主信号にする。各 index に確定 font(px) を返す
  // (0 = 縦書き/textured で無効化 → 呼び出し側の個別 fit に委譲)。
  function computeGroupFonts(ctx, blocks, W, H, scale = 1) {
    const minFont = Math.max(1, Math.ceil(MIN_IMAGE_FONT_SIZE * scale));
    const fonts = new Array(blocks.length).fill(0);
    const items = [];
    blocks.forEach((blk, idx) => { const pb = pixelBoxOf(ctx, blk, W, H); if (pb) items.push({ idx, pb, blk }); });
    if (!items.length) return fonts;
    items.sort((a, b) => a.pb.cyPx - b.pb.cyPx);
    items.forEach((it, i) => { it.avail = availPitchFor(items, i); });
    const pitchClamp = 0.92; // pitch に対する font 上限係数
    const availClamp = 0.96; // 実測 availPitch に対する頭打ち係数
    // 連続行をグループ化
    const groups = [];
    let cur = [];
    for (const it of items) {
      if (cur.length && !shouldLinkRowsPitch(cur[cur.length - 1].pb, it.pb)) { groups.push(cur); cur = []; }
      cur.push(it);
    }
    if (cur.length) groups.push(cur);
    for (const group of groups) {
      // --- pitch (行送り) を決める ---
      let pitch;
      if (group.length >= 2) {
        const diffs = [];
        for (let i = 1; i < group.length; i++) {
          const a = group[i - 1].pb, b = group[i].pb;
          const hRatio = b.h / a.h;
          if (hRatio > 0.5 && hRatio < 2.0) diffs.push(b.cyPx - a.cyPx); // 見出し (高さ比外) は pitch ソースから除外 (E2)
        }
        const base = diffs.length ? diffs : group.slice(1).map((g, i) => g.pb.cyPx - group[i].pb.cyPx);
        const m0 = median(base);
        const inliers = base.filter((d) => d >= m0 * 0.6 && d <= m0 * 1.8); // 外れ値除去して再 median
        pitch = median(inliers.length ? inliers : base) || m0;
      } else {
        pitch = group[0].pb.h * PITCH_FROM_H; // 単独行は box.h から外挿 (白背景メールの最頻ケース)
      }
      if (!(pitch > 0)) continue; // 異常値はグループ全体を個別 fit へ委譲 (fonts は 0 のまま)
      // 単独行は box.h から直接 font を復元 (tight な det/visible-glyph box は font の ~0.75 倍に痩せるため
      // H_TO_FONT で戻す)。複数行は cy 間隔 (pitch=行送り) が原文サイズの直接信号なので pitch*PITCH_TO_FONT を保つ。
      const isSingle = group.length < 2;
      let targetFont = isSingle
        ? Math.round(group[0].pb.h * H_TO_FONT)
        : Math.min(Math.round(pitch * PITCH_TO_FONT), Math.round(pitch * pitchClamp));
      const measured = group.filter(it => typeof it.blk.original === "string" && it.blk.original.trim())
        .map(it => fitCanvasFont(ctx, it.blk.original, it.pb.w, it.pb.h, CANVAS_FONT, 1, ABS_MAX * scale).fontSize);
      if (measured.length) targetFont = median(measured);
      targetFont = Math.max(minFont, targetFont);
      dbg("group", "lines=" + group.length, "single=" + isSingle, "pitch=" + Math.round(pitch), "target=" + targetFont);
      // --- 各 block にガード + 上限 + 折返し縮小を適用 ---
      for (const it of group) {
        const pb = it.pb, trans = it.blk.translation;
        const w = pb.w, h = pb.h;
        if (!pb.flat) { fonts[it.idx] = 0; it.blk.__rtEffInnerW = 0; dbg("blk", "textured-skip"); continue; } // textured は従来 fit
        const aspect = h / w;
        if ((aspect > 2.2 && w < targetFont * 1.2) || trans.trim().length <= 1) { fonts[it.idx] = 0; it.blk.__rtEffInnerW = 0; dbg("blk", "vert/1char-skip"); continue; } // G2
        const innerW = Math.max(4, w - 2 * (w * 0.05));
        // 単独行は均一余白へ横展開する (英→全角で訳文が英文 box.w を超え、折返し/縮小で原文より小さくなるのを防ぐ)。
        // 左右の安全余白の小さい側ぶんだけ対称に広げる (中央寄せ描画と整合・はみ出さない)。
        // flat は背景色 fill で消すため flat 時のみ展開する。多行は box.w のまま。
        let effInnerW = innerW;
        it.blk.__rtTextAlign = "center";
        if (isSingle && pb.flat) {
          const hw = availHWForFlat(items, it, W);
          if (hw.r > hw.l * 1.5 + minFont) {
            it.blk.__rtTextAlign = "left";
            effInnerW = Math.min(innerW + hw.r, W - pb.x0);
          } else if (hw.l > hw.r * 1.5 + minFont) {
            it.blk.__rtTextAlign = "right";
            effInnerW = Math.min(innerW + hw.l, pb.x1);
          } else effInnerW = Math.min(innerW + 2 * Math.min(hw.l, hw.r), W * 0.96);
        } else if (group.length > 1) {
          const leftSpread = Math.max(...group.map(row => row.pb.x0)) - Math.min(...group.map(row => row.pb.x0));
          const rightSpread = Math.max(...group.map(row => row.pb.x1)) - Math.min(...group.map(row => row.pb.x1));
          if (leftSpread + scale < rightSpread) it.blk.__rtTextAlign = "left";
          else if (rightSpread + scale < leftSpread) it.blk.__rtTextAlign = "right";
        }
        it.blk.__rtEffInnerW = (effInnerW > innerW + 1) ? effInnerW : 0; // 展開幅を drawInpaintBlock へ伝達 (未展開は 0)
        let font = Math.min(targetFont, ABS_MAX * scale);
        // 面積上限 areaCap は診断ログ用に残すが font の縮小には使わない。実際のあふれは下の avail クランプ(縦)と
        // wrap/fitCanvasFont(横+縦)が捉えるので、areaCap の「1 行ぶんの面積モデル」で『2 行に折れば大きく入る訳文』
        // まで潰すのを避ける (textured 行が target を割って小さく焼かれていた主因＝logs の flat=false areaCap<target)。
        const transLen = Math.max(1, trans.trim().length);
        const areaCap = Math.round(Math.sqrt((effInnerW * h) / (transLen * 0.55)) / 1.10);
        if (it.avail !== Infinity) font = Math.min(font, Math.round(it.avail * availClamp)); // G1 隣行重なりクランプ (1 行想定)
        if (font < 1) { fonts[it.idx] = 0; continue; }
        // 折返し縮小: 縦に使える高さ (隣行までの実測 availPitch・無ければ box.h*2.4) を予算に、幅 or 高さが
        // あふれるときだけ fitCanvasFont で詰める。横展開した effInnerW を使うので、原文サイズ 1 行に収まりやすい。
        ctx.font = `600 ${font}px ${CANVAS_FONT}`;
        const wrapped = wrapCanvasText(ctx, trans, effInnerW);
        const vBudget = (it.avail !== Infinity) ? it.avail * availClamp : h * 2.4;
        const tooWide = wrapped.some((l) => ctx.measureText(l).width > effInnerW);
        const tooTall = canvasLineMetrics(ctx, wrapped, font).height > vBudget;
        if (tooWide || tooTall) {
          const fit = fitCanvasFont(ctx, trans, effInnerW, vBudget, CANVAS_FONT, minFont, font);
          font = Math.min(font, fit.fontSize);
        }
        dbg("blk", "h=" + Math.round(h), "single=" + isSingle, "flat=" + pb.flat, "target=" + targetFont, "areaCap=" + areaCap,
          "avail=" + (it.avail === Infinity ? "inf" : Math.round(it.avail)), "eff=" + Math.round(effInnerW) + "/" + Math.round(innerW), "font=" + font, "wrap=" + wrapped.length);
        fonts[it.idx] = Math.max(minFont, font);
      }
    }
    return fonts;
  }

  // 原文の文字面を基準に配置し、計測で決めたサイズにも表示上12pxの下限を適用する。
  function layoutInpaintText(ctx, blk, W, H, forcedFont, scale = 1) {
    const { x, y, w, h } = blk.__rtTextBox || blockPixelRect(blk, W, H);
    const bounds = imageContentBounds(W, H);
    const minFont = Math.max(1, Math.ceil(MIN_IMAGE_FONT_SIZE * scale));
    let effW = Math.min(bounds.x1 - bounds.x0, Math.max(minFont, w * 0.9, blk.__rtEffInnerW || 0));
    const fontSize = Math.max(minFont, forcedFont || fitCanvasFont(ctx, blk.translation, effW,
      Math.max(h * 0.84, minFont), CANVAS_FONT, minFont, ABS_MAX * scale).fontSize);
    ctx.font = `600 ${fontSize}px ${CANVAS_FONT}`;
    let lines = wrapCanvasText(ctx, blk.translation, effW);
    const lineWidths = lines.map(line => ctx.measureText(line).width);
    if (lineWidths.some(width => width > effW)) {
      effW = Math.min(bounds.x1 - bounds.x0, Math.max(effW, ...lineWidths));
      lines = wrapCanvasText(ctx, blk.translation, effW);
    }
    const metrics = canvasLineMetrics(ctx, lines, fontSize);
    const textWidth = Math.max(0, ...lines.map(line => ctx.measureText(line).width));
    const center = (value, start, end, extent) => extent >= end - start ? (start + end) / 2
      : Math.max(start + extent / 2, Math.min(end - extent / 2, value));
    const align = blk.__rtTextAlign || "center";
    const desiredX = align === "left" ? x + textWidth / 2 : align === "right" ? x + w - textWidth / 2 : x + w / 2;
    const cx = center(desiredX, bounds.x0, bounds.x1, textWidth);
    const cy = center(y + h / 2, bounds.y0, bounds.y1, metrics.height);
    const textX = align === "left" ? cx - textWidth / 2 : align === "right" ? cx + textWidth / 2 : cx;
    return { fontSize, lines, metrics, width: textWidth, cx, cy, align, textX };
  }

  // 背景の計測と原文消去を描画から分離し、隣の訳文を次のblockの消去で消さない。
  function eraseInpaintBlock(ctx, blk, W, H) {
    const { x, y, w, h } = blk.__rtEraseBox || blockPixelRect(blk, W, H);
    const st = blk.__rtBackground;
    const flat = st && st.std < 24; // 外周の色ブレが小さい=平坦背景 → 背景色 fill で原文を消せる
    if (flat) {
      // 消去マージンを字高(h)基準の非対称に。横6%固定では行頭グリフ縁と行間/周囲の薄残りを覆えない。
      const dl = Math.max(3, h * 0.34); // 左: 行頭余白を厚く(行頭ゴースト対策)
      const dr = Math.max(2, h * 0.16); // 右: 訳文はみ出し抑制で控えめ
      const dy = Math.max(2, h * 0.30); // 上下: アセンダ/ディセンダ+行間の薄残り回収
      // 平坦背景は背景色 fill で原文を消す。ただし背景が概ね透明 (alpha<0.5) のときは不透明 fill を省いて透過を保つ
      // (透過 PNG/SVG の透明部が単色箱になるのを防ぐ)。かつて誤発火源だった object-fit 描画域外の透明レターボックスは
      // ringStats が inpaintFit でサンプリング域から除外済みなので、ここでの alpha は実画像の透過のみを反映する。
      if (st.alpha == null || st.alpha >= 0.5) {
        ctx.fillStyle = `rgb(${st.color[0]},${st.color[1]},${st.color[2]})`;
        ctx.fillRect(x - dl, y - dy, w + dl + dr, h + 2 * dy);
      }
    } else {
      ctx.fillStyle = "rgba(20,28,38,0.84)"; // textured: 半透明の暗い帯で隠す (従来オーバーレイ相当を canvas に焼く)
      const layout = blk.__rtTextLayout;
      const left = layout ? Math.min(x, layout.cx - layout.width / 2 - 2) : x;
      const top = layout ? Math.min(y, layout.cy - layout.metrics.height / 2 - 2) : y;
      const right = layout ? Math.max(x + w, layout.cx + layout.width / 2 + 2) : x + w;
      const bottom = layout ? Math.max(y + h, layout.cy + layout.metrics.height / 2 + 2) : y + h;
      roundRectPath(ctx, left, top, right - left, bottom - top, Math.min(6, h * 0.2));
      ctx.fill();
    }
  }

  function drawInpaintBlock(ctx, blk, W, H, forcedFont, scale) {
    const { fontSize, lines, metrics, cy, align, textX } = blk.__rtTextLayout || layoutInpaintText(ctx, blk, W, H, forcedFont, scale);
    const st = blk.__rtBackground;
    const flat = st && st.std < 24;
    ctx.font = `600 ${fontSize}px ${CANVAS_FONT}`;
    ctx.textAlign = align;
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = flat ? (st.dark ? "#f5f5f5" : "#1a1a1a") : "#ffffff";
    // 同色細縁: 縮小/低面積でのコントラスト低下を補強 (太字化せず stroke を fill と同色で薄く重ねる)。
    ctx.lineJoin = "round"; ctx.lineWidth = Math.min(1.5, fontSize * 0.06); ctx.strokeStyle = ctx.fillStyle;
    const startY = cy - metrics.height / 2 + metrics.ascent;
    if (!flat) { ctx.shadowColor = "rgba(0,0,0,0.55)"; ctx.shadowBlur = 2; ctx.shadowOffsetY = 1; }
    lines.forEach((ln, i) => ctx.strokeText(ln, textX, startY + i * metrics.lineHeight));
    ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    lines.forEach((ln, i) => ctx.fillText(ln, textX, startY + i * metrics.lineHeight));
    ctx.lineWidth = 0;
  }

  const INPAINT_MAX_SIDE = 4096; // 巨大画像で canvas メモリが膨らむのを抑える長辺上限

  // 非同期描画(decode)中に復元(imgRunId++)や別画像への差替が起きたかを判定する。stale なら append を中止し、
  // 取り残しオーバーレイの発生を防ぐ (translateImg の初期チェックは await の前なので、await 後にもう一度確認する)。
  // object-fit:cover/contain を canvas 上で再現する描画先矩形 (canvas px)。
  // 元画像(全体)をこの矩形へ drawImage(9引数) すると、その object-fit の表示クロップ/レターボックスを複製できる。
  // fill/none/その他は全面 (= 現行と同一の恒等描画)。これで cover の X 画像等でも歪まず原文消去できる。
  function objectPositionOffset(value, free, scale) {
    if (["left", "top"].includes(value)) return 0;
    if (["right", "bottom"].includes(value)) return free;
    if (value === "center") return free / 2;
    if (/^[+-]?[\d.]+%$/.test(value)) return free * parseFloat(value) / 100 || 0;
    if (/^[+-]?[\d.]+px$/.test(value)) return parseFloat(value) * scale;
    const calc = String(value).match(/^calc\(\s*([+-]?[\d.]+)%\s*([+-])\s*([\d.]+)px\s*\)$/);
    if (calc) return free * Number(calc[1]) / 100 + (calc[2] === "+" ? 1 : -1) * Number(calc[3]) * scale;
    return free / 2;
  }

  function fitDrawRect(fit, srcW, srcH, W, H, position = "50% 50%", scale = 1) {
    if ((fit === "cover" || fit === "contain") && srcW > 0 && srcH > 0) {
      const s = fit === "cover" ? Math.max(W / srcW, H / srcH) : Math.min(W / srcW, H / srcH);
      const dw = srcW * s, dh = srcH * s;
      const parts = String(position || "50% 50%").match(/calc\([^)]*\)|[^\s]+/g) || [];
      if (parts.length === 1) parts.push("50%");
      if (["top", "bottom"].includes(parts[0])) parts.reverse();
      return { dx: objectPositionOffset(parts[0], W - dw, scale), dy: objectPositionOffset(parts[1], H - dh, scale), dw, dh };
    }
    return { dx: 0, dy: 0, dw: W, dh: H };
  }

  // VLM の block 座標 (フル画像基準の 0..1) を、object-fit 描画後の canvas 正規化座標へ写す。
  // box/cy のみ写し translation 等の他フィールドは保持。全面 (恒等) のときは元配列をそのまま返す (= 現行維持)。
  function remapBlocksToFit(blocks, fr, W, H) {
    if (fr.dx === 0 && fr.dy === 0 && fr.dw === W && fr.dh === H) return blocks;
    return blocks.map((b) => {
      if (!b || !b.box) return b;
      const nb = {
        ...b,
        box: {
          x: (fr.dx + b.box.x * fr.dw) / W,
          y: (fr.dy + b.box.y * fr.dh) / H,
          w: (b.box.w * fr.dw) / W,
          h: (b.box.h * fr.dh) / H,
        },
      };
      if (typeof b.cy === "number") nb.cy = (fr.dy + b.cy * fr.dh) / H;
      return nb;
    });
  }

  // cover で表示外へクロップされた block は焼かない (中心が canvas 内にあるものだけ残す)。
  function blockInView(b) {
    if (!b || !b.box) return false;
    const cx = b.box.x + b.box.w / 2;
    const cy = (typeof b.cy === "number") ? b.cy : (b.box.y + b.box.h / 2);
    return cx > 0 && cx < 1 && cy > 0 && cy < 1;
  }

  // 元画像を canvas に描き各ブロックを inpaint して、wrap の最前面レイヤーとして被せる (img 自体は触らない)。
  // canvas は __rt-img-layer クラスを持つので isTranslated/unwrapImage/revertImg がそのまま機能する。
  async function renderInpaint(img, blocks, image, guard) {
    const bmp = await bitmapFromBase64(image.base64, image.mime);
    try {
      // canvas 論理解像度 = 表示ボックス px × dpr (等倍〜拡大のみ)。ナチュラル解像度で焼いて CSS で縮小表示すると
      // 細い CJK 縦画が bilinear で灰色に溶ける (= 訳文が薄く細く見える主因) ため、表示サイズに解像度を合わせて
      // 縮小経路を消す。表示サイズ不明 (未レイアウト) のときだけ従来のナチュラル解像度へフォールバック。
      const rect = img.getBoundingClientRect();
      let W, H, scale;
      if (rect.width >= 1 && rect.height >= 1) {
        const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
        const dispW = rect.width, dispH = rect.height;
        const want = Math.min(dpr, Math.max(1, bmp.width / dispW, bmp.height / dispH));
        const rasterScale = Math.min(want, INPAINT_MAX_SIDE / dispW, INPAINT_MAX_SIDE / dispH);
        W = Math.max(1, Math.round(dispW * rasterScale));
        H = Math.max(1, Math.round(dispH * rasterScale));
        scale = W / dispW; // 物理 px ↔ 論理 px 換算 (可読下限に使う)
      } else {
        const s = Math.min(1, INPAINT_MAX_SIDE / Math.max(bmp.width, bmp.height));
        W = Math.max(1, Math.round(bmp.width * s)); H = Math.max(1, Math.round(bmp.height * s)); scale = 1;
      }
      const canvas = document.createElement("canvas");
      canvas.className = "__rt-img-layer __rt-img-canvas";
      canvas.width = W; canvas.height = H;
      canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;";
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("no 2d ctx");
      ctx.imageSmoothingQuality = "high";
      // object-fit:cover/contain を canvas 上で再現してから描く (X 等の cover クロップでも歪まず原文を消す)。
      let objFit = "fill", objPosition = "50% 50%";
      try {
        const style = getComputedStyle(img);
        objFit = style.objectFit || "fill"; objPosition = style.objectPosition || objPosition;
      } catch (_e) { /* 既定の全面表示を使う */ }
      const fr = fitDrawRect(objFit, bmp.width, bmp.height, W, H, objPosition, scale);
      inpaintFit = fr; // ringStats が描画域外 (contain レターボックス) の透明画素を弾くため (finally で null クリア)
      ctx.drawImage(bmp, 0, 0, bmp.width, bmp.height, fr.dx, fr.dy, fr.dw, fr.dh);
      let fitBlocks = remapBlocksToFit(blocks, fr, W, H); // block 座標も同変換。cover で見切れた分は除外 (恒等時は元配列のまま)
      if (fitBlocks !== blocks) fitBlocks = fitBlocks.filter(blockInView);
      dbg("inpaint", W + "x" + H, "scale=" + scale.toFixed(2), "fit=" + objFit, "disp=" + Math.round(rect.width) + "x" + Math.round(rect.height), "blocks=" + fitBlocks.length);
      // 段落の行間に残る原文黒帯を先に消す (flat 同色の隣接行の隙間だけを連結 fill)。失敗は従来挙動へ。
      let groupFonts = [];
      try { groupFonts = computeGroupFonts(ctx, fitBlocks, W, H, scale); } catch (_e) { groupFonts = []; }
      fitBlocks.forEach((blk, i) => {
        if (!blk || !blk.box || !blk.translation) return;
        blk.__rtTextLayout = layoutInpaintText(ctx, blk, W, H, groupFonts[i], scale);
      });
      const bounds = imageContentBounds(W, H);
      ctx.save(); ctx.beginPath(); ctx.rect(bounds.x0, bounds.y0, bounds.x1 - bounds.x0, bounds.y1 - bounds.y0); ctx.clip();
      try { fillInterlineStrips(ctx, fitBlocks, W, H); } catch (_e) { /* 失敗時は per-block fill のみ */ }
      for (const blk of fitBlocks) {
        if (!blk || !blk.box || !blk.translation) continue;
        try { eraseInpaintBlock(ctx, blk, W, H); } catch (_e) { /* 他のblockの消去は継続 */ }
      }
      for (let bi = 0; bi < fitBlocks.length; bi++) {
        const blk = fitBlocks[bi];
        if (!blk || !blk.box || typeof blk.translation !== "string" || !blk.translation) continue;
        try { drawInpaintBlock(ctx, blk, W, H, groupFonts[bi], scale); } catch (_e) { /* 1 ブロック失敗は無視して継続 */ }
      }
      ctx.restore();
      if (isStaleImg(guard, img)) return; // 復元/差替が decode 中に起きた → wrap を作らず中止 (取り残し防止)
      const wrap = ensureWrap(img);
      wrap.querySelectorAll(".__rt-img-layer").forEach((l) => l.remove()); // 旧オーバーレイ/canvas を除去
      wrap.appendChild(canvas);
    } finally {
      inpaintFit = null; // 描画区間外では常に全面 (恒等) に戻す
      if (bmp && bmp.close) bmp.close();
    }
  }

  // 描画方式の選択: canvas inpaint (背景色 fill 消去 + 焼き込み) → 失敗で HTML オーバーレイ。
  // 描画後は startFollow で「外部リサイズ/移動/差替 (ライトボックス等)」を監視し、取り残しオーバーレイを掃除する。
  async function renderTranslated(img, blocks, image, opts) {
    dbg("render", image && image.base64 ? "inpaint" : "html", "blocks=" + (blocks ? blocks.length : 0));
    // requestId もガードに含める: 応答到着後〜decode/描画中に「原(戻す)」や再 OCR が走った古い結果を
    // canvas/フォールバックオーバーレイとして重ねない (ownsBtn はボタン表示しか守らない)
    const guard = opts && { myRun: opts.myRun, url: opts.url, requestId: opts.requestId };
    // canvas inpaint(原文消去+焼き込み)が本線。renderInpaint は object-fit:cover/contain を
    // canvas 上で再現(fitDrawRect)するので、X 等の cover クロップ画像でも歪まず原文を消せる。
    // base64 が無い/canvas が失敗したときだけ、画像を壊さない HTML オーバーレイ(renderBlocks)へ落とす。
    if (image && image.base64) {
      try { await renderInpaint(img, blocks, image, guard); startFollow(img); return; }
      catch (e) { dbg("inpaint-fail", (e && e.message) || String(e)); /* HTML オーバーレイへ */ }
    }
    if (isStaleImg(guard, img)) return; // inpaint 失敗までの間に復元/再OCR/差替が起きた → 古い結果を重ねない
    dbg("render", "fallback=blocks", "hasImg=" + !!image, "hasB64=" + !!(image && image.base64));
    renderBlocks(img, blocks);
    startFollow(img);
  }

  // 翻訳済み画像を監視し、ライトボックス等が「画像を外部リサイズ/別位置へ移動/別 img へ差替/DOM から除去」したら、
  // 元位置に取り残された canvas オーバーレイ (px 固定 wrap に張り付き追従できない) を unwrapImage で消す。
  // 再描画でなく「掃除」に徹する: ライトボックスの大きい画像はユーザーが訳し直せば、横展開+解像度合わせで可読になる。
  function startFollow(img) {
    const wrap = img && img.closest(".__rt-img-wrap");
    if (!wrap || wrap.__rtChk) return; // 既に監視中なら二重起動しない
    const r0 = img.getBoundingClientRect();
    wrap.__rtSrc = img.currentSrc || img.src;
    wrap.__rtW = Math.round(r0.width); wrap.__rtH = Math.round(r0.height);
    wrap.__rtChk = window.setInterval(() => {
      if (isDead()) { stopFollow(wrap); return; }
      const cur = wrap.querySelector("img");
      // 取り残し条件: wrap が外れた / img が消えた・別 DOM へ移った / src が差し替わった (カルーセル/ライトボックス複製)
      if (!wrap.isConnected || !cur || !cur.isConnected || (cur.currentSrc || cur.src) !== wrap.__rtSrc) { stopFollow(wrap); unwrapImage(wrap); return; }
      const r = cur.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) { stopFollow(wrap); unwrapImage(wrap); return; } // 非表示化
      // 外部が img を描画時サイズから有意に変えた (ライトボックスでの拡大/ズーム) → canvas は px 固定で追従不能 → 掃除。
      if (Math.abs(r.width - wrap.__rtW) > 8 || Math.abs(r.height - wrap.__rtH) > 8) { stopFollow(wrap); unwrapImage(wrap); }
    }, 1000);
  }

  // ロゴ/ブランドワードマークを翻訳 overlay から除外する (症状: ヘッダ/フッタの "Claude" 等に訳文が重畳)。
  // 主役は vision の kind フラグ。kind 非対応モデル向けの保険として、端帯(最上部/最下部)+短語+固定辞書の
  // AND でのみ弾く (本文巻き込みを避ける)。完全には弾けない前提で扱う。
  const BRAND_WORDS = new Set(["claude", "anthropic", "chatgpt", "openai", "gemini", "gpt", "copilot", "github", "google", "grok"]);
  function looksLikeBrandWordmark(blk) {
    const t = (blk.original || "").trim();
    if (!t) return false;
    const words = t.split(/\s+/);
    if (words.length > 2) return false;                            // 短語のみ (本文は通常 3 語以上)
    if (!/^[A-Za-z][A-Za-z0-9.-]*$/.test(words[0])) return false; // 英数ワードマーク形のみ
    const cy = typeof blk.cy === "number" ? blk.cy : (blk.box.y + blk.box.h / 2);
    return (cy < 0.12 || cy > 0.88) && BRAND_WORDS.has(words[0].toLowerCase()); // 最上部/最下部の帯のみ
  }
  function filterBlocks(blocks) {
    const list = Array.isArray(blocks) ? blocks : [];
    const hasKind = list.some((b) => b && b.kind);  // kind 対応モデルか
    return list.filter((b) => {
      if (!b) return false;
      if (b.kind === "logo") return false;          // 主役: モデルが logo と分類 → 捨てる
      if (!hasKind && looksLikeBrandWordmark(b)) return false; // 保険: kind 非対応のときだけ端帯辞書で弾く
      return true;
    });
  }

  return { renderTranslated, filterBlocks };
  };
})();
