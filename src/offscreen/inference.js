// inference.js — Chrome offscreen document（Firefox は event page で同等動作）で動く ONNX 推論ホスト。
//
// 責務:
//   - ort-web（webgpu glue）を ESM import し、WebGPU→WASM の順で InferenceSession を作る
//   - モデル重み（.onnx）は実行時 DL + Cache API（バンドル wasm と違い「データ」なのでストア審査上 DL 可）
//   - MI-GAN で原文領域を inpaint 消去（Phase 3）／ PaddleOCR で OCR（Phase 4・別コミットで追加）
//   - API キーは一切扱わない（画像バイトと box のみ）。SW から RUN_INFERENCE エンベロープで呼ばれる
//
// 注意: このファイルは ESM（import 使用）。Chrome は offscreen.html の <script type="module"> から、
//       Firefox は event page で同等ロードする（background 配線は build-firefox-manifest.mjs 側で対応）。

import * as ort from "../libs/onnxruntime/ort.webgpu.bundle.min.mjs";

// wasm はバンドル済みファイルを指す（CDN ロードは Chrome 審査 NG）。
// offscreen/event-page は crossOriginIsolated でない → SharedArrayBuffer 不可 → 単一スレッド固定。
ort.env.wasm.proxy = false;
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = {
  mjs: chrome.runtime.getURL("src/libs/onnxruntime/ort-wasm-simd-threaded.jsep.mjs"),
  wasm: chrome.runtime.getURL("src/libs/onnxruntime/ort-wasm-simd-threaded.jsep.wasm"),
};
// rec モデルは出力長を 25 と固定宣言するが実際は入力幅で可変(T=W/4)。ORT が毎行 VerifyOutputSizes 警告を
// 吐きコンソールが埋まる(出力テンソルは実 T で正しく返る=無害)。warning を抑止して error 以上だけ出す。
ort.env.logLevel = "error";

// ---- モデル取得（実行時 DL + Cache API） ----
// URL は実機相当の検証済み(HEAD/GET 200 + ONNX I/O 実測)。404 なら fetchModelBytes が "model fetch 404"
// を投げ、呼び出し側が cloud にフォールバックする(壊れない)。差し替えは MODEL_URLS だけ直せばよい。
const MODEL_URLS = {
  // MI-GAN inpaint。入力 image[N,3,H,W]uint8 / mask[N,1,H,W]uint8(255=keep,0=hole) / 出力 result 同形(実測一致)。
  migan: "https://huggingface.co/andraniksargsyan/migan/resolve/main/migan_pipeline_v2.onnx",
  // PaddleOCR(ONNX・RapidOCR 配布)。det=PP-OCRv4(in "x"/out "sigmoid_0.tmp_0")、
  // rec=PP-OCRv4 日本語 CRNN(in "x"[N,3,48,?]/out [N,T,4401]・softmax・use_space_char)。v1 より誤読が大幅減。
  // dict=PaddleOCR 本家 4399 文字。v4 の class=4399(dict)+blank+space=4401(CTC decode が C 次元で自己適応)。
  ocrDet: "https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_det_infer.onnx",
  ocrRec: "https://huggingface.co/pitapo/rapidocr/resolve/main/onnx/PP-OCRv4/rec/japan_PP-OCRv4_rec_infer.onnx",
  ocrDict: "https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/release/2.7/ppocr/utils/dict/japan_dict.txt",
};
const CACHE_NAME = "rt-onnx-models-v2"; // rec を v1→v4 へ更新。Cache から旧 v1 重みを退役させるため版を上げる

// PaddleOCR rec(PP-OCRv4 japan)の trained 入力高さ 48(入力 dynamic だが 48 が学習解像度=精度最良)。
const REC_HEIGHT = 48;
const REC_MAX_WIDTH = 1920; // rec 入力幅の上限。狭いと長い行が横圧縮(squish)され精度低下するため緩める
// 小さい画像(メール ~600px)は OCR 前に upscale して glyph 解像度を稼ぐ(crop が 32/48px への縮小経路に乗る)。
const SRC_MIN_SIDE = 1600;  // この長辺未満なら upscale 対象
const UPSCALE_MAX = 3;      // upscale 上限倍率
const OCR_MAX_SIDE = 4096;  // canvas 長辺の絶対上限(メモリ暴発防止)

async function fetchModelBytes(url) {
  let cache = null;
  try { cache = await caches.open(CACHE_NAME); } catch (_e) { /* private mode 等で Cache 不可 */ }
  if (cache) {
    const hit = await cache.match(url);
    if (hit) return await hit.arrayBuffer();
  }
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`model fetch ${res.status}`);
  const buf = await res.arrayBuffer();
  if (cache) { try { await cache.put(url, new Response(buf.slice(0))); } catch (_e) { /* キャッシュ失敗は無視 */ } }
  return buf;
}

// ---- セッション（lazy・doc 生存中キャッシュ。WebGPU→WASM の順で試す） ----
const sessions = {};
async function createSession(bytes) {
  const nav = (typeof navigator !== "undefined") ? navigator : null;
  const candidates = [];
  if (nav && nav.gpu) candidates.push([{ name: "webgpu" }]); // SW には navigator.gpu が無い→offscreen/event-page でのみ
  candidates.push([{ name: "wasm" }]);                        // 常に最後（CPU フォールバック）
  let lastErr = null;
  for (const eps of candidates) {
    try {
      return await Promise.race([
        ort.InferenceSession.create(bytes, { executionProviders: eps, graphOptimizationLevel: "all", logSeverityLevel: 3 }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("ep-timeout")), 30000)),
      ]);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("no available backend");
}
function getSession(key, url) {
  if (!sessions[key]) {
    sessions[key] = fetchModelBytes(url)
      .then(createSession)
      .catch((e) => { sessions[key] = null; throw e; }); // 失敗は次回再試行できるよう破棄
  }
  return sessions[key];
}

// ---- 画像ユーティリティ ----
async function bitmapFromBase64(b64, mime) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return await createImageBitmap(new Blob([u8], { type: mime || "image/png" }));
}
async function canvasToBase64(canvas) {
  const blob = await canvas.convertToBlob({ type: "image/png" });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) bin += String.fromCharCode.apply(null, buf.subarray(i, i + chunk));
  return btoa(bin);
}

// ---- MI-GAN inpaint（Phase 3） ----
// pipeline モデル（migan_pipeline_v2.onnx）は crop/resize/normalize/blend を内蔵。JS は ImageData↔uint8 NCHW 変換のみ。
// 入力 image: uint8 NCHW [1,3,H,W] RGB 0..255 / mask: uint8 [1,1,H,W]（255=keep, 0=hole）/ 出力 result: 同形 RGB。
// 返り値は「原文を消去した画像」の base64（訳文の焼き込みは content 側で行う）。
async function runInpaint(payload) {
  const { base64, mime, blocks, maxSide } = payload;
  const bmp = await bitmapFromBase64(base64, mime);
  const scale = Math.min(1, (maxSide || 2048) / Math.max(bmp.width, bmp.height));
  const W = Math.max(1, Math.round(bmp.width * scale));
  const H = Math.max(1, Math.round(bmp.height * scale));
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, W, H);
  if (bmp.close) bmp.close();
  const src = ctx.getImageData(0, 0, W, H).data;
  const plane = W * H;
  // image tensor: uint8 NCHW RGB（alpha を落とす）
  const img = new Uint8Array(3 * plane);
  for (let p = 0, px = 0; px < plane; px++, p += 4) {
    img[px] = src[p];
    img[plane + px] = src[p + 1];
    img[2 * plane + px] = src[p + 2];
  }
  // mask tensor: 255=keep, 0=hole。box 内を hole(0) にする。pad で glyph の食み出しもカバー。
  const mask = new Uint8Array(plane).fill(255);
  const pad = Math.round(Math.min(W, H) * 0.006) + 2;
  for (const b of (blocks || [])) {
    if (!b || !b.box) continue;
    const x0 = Math.max(0, Math.floor(b.box.x * W - pad));
    const y0 = Math.max(0, Math.floor(b.box.y * H - pad));
    const x1 = Math.min(W, Math.ceil((b.box.x + b.box.w) * W + pad));
    const y1 = Math.min(H, Math.ceil((b.box.y + b.box.h) * H + pad));
    for (let yy = y0; yy < y1; yy++) {
      const row = yy * W;
      for (let xx = x0; xx < x1; xx++) mask[row + xx] = 0;
    }
  }
  const session = await getSession("migan", MODEL_URLS.migan);
  const feeds = {
    image: new ort.Tensor("uint8", img, [1, 3, H, W]),
    mask: new ort.Tensor("uint8", mask, [1, 1, H, W]),
  };
  const results = await session.run(feeds);
  const out = results[session.outputNames[0]].data; // Uint8Array NCHW [1,3,H,W]
  const rgba = new Uint8ClampedArray(plane * 4);
  for (let p = 0, px = 0; px < plane; px++, p += 4) {
    rgba[p] = out[px];
    rgba[p + 1] = out[plane + px];
    rgba[p + 2] = out[2 * plane + px];
    rgba[p + 3] = 255;
  }
  ctx.putImageData(new ImageData(rgba, W, H), 0, 0);
  // メッセージのディープコピー量を抑えるため raw RGBA でなく PNG base64 で返す。
  return { base64: await canvasToBase64(canvas), width: W, height: H };
}

// ---- PaddleOCR ローカル OCR（Phase 4） ----
// 構成: DET(DBNet) でテキスト行 box を検出 → 各 box を crop → REC(CRNN+CTC) で文字認識。
// 返り値 blocks[{box:{x,y,w,h}0..1, cy 0..1, original}] を SW が translateWith で訳して overlay に渡す。
//
// ★verify-on-device 多数: 入出力テンソル名・チャネル順(RGB/BGR)・正規化・REC 高さ・dict オフセットは
//   モデル実体に依存する。実機で OCR 結果（original 文字列）を確認し、ズレたら下記の該当箇所を調整する。

let dictCache = null;
async function loadDict() {
  if (dictCache) return dictCache;
  let text = null;
  let cache = null;
  try { cache = await caches.open(CACHE_NAME); } catch (_e) { /* private mode 等 */ }
  if (cache) { const hit = await cache.match(MODEL_URLS.ocrDict); if (hit) text = await hit.text(); }
  if (text == null) {
    const res = await fetch(MODEL_URLS.ocrDict, { redirect: "follow" });
    if (!res.ok) throw new Error(`dict fetch ${res.status}`);
    text = await res.text();
    if (cache) { try { await cache.put(MODEL_URLS.ocrDict, new Response(text)); } catch (_e) { /* 無視 */ } }
  }
  // 1 行 1 文字。末尾改行ぶんの空要素だけ落とし、途中行（空白文字を含む）は保持する。
  const lines = text.replace(/\r/g, "").split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  dictCache = lines;
  return dictCache;
}

// DBNet 検出: 入力は ImageNet 正規化した RGB NCHW float32。出力 prob map を閾値→連結成分→軸並行 bbox。
// 正式 DBNet は Vatti polygon の unclip を使うが、ここでは box 寸法比の dilate で近似する（HTML overlay 用途に十分）。
async function detect(canvas) {
  const W0 = canvas.width, H0 = canvas.height;
  const limit = 960;
  const scale = Math.min(1, limit / Math.max(W0, H0));
  let rw = Math.max(32, Math.round((W0 * scale) / 32) * 32);
  let rh = Math.max(32, Math.round((H0 * scale) / 32) * 32);
  const rc = new OffscreenCanvas(rw, rh);
  const rctx = rc.getContext("2d", { willReadFrequently: true });
  rctx.imageSmoothingEnabled = true; rctx.imageSmoothingQuality = "high";
  rctx.drawImage(canvas, 0, 0, rw, rh);
  const data = rctx.getImageData(0, 0, rw, rh).data;
  const plane = rw * rh;
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  const inp = new Float32Array(3 * plane); // RapidOCR det は BGR 投入(cvtColor 無し)。RGBA から B/G/R 順に詰める。
  for (let p = 0, i = 0; i < plane; i++, p += 4) {
    inp[i] = (data[p + 2] / 255 - mean[0]) / std[0];          // ch0 = B
    inp[plane + i] = (data[p + 1] / 255 - mean[1]) / std[1];  // ch1 = G
    inp[2 * plane + i] = (data[p] / 255 - mean[2]) / std[2];  // ch2 = R
  }
  const session = await getSession("ocrDet", MODEL_URLS.ocrDet);
  const inName = session.inputNames[0];
  const out = await session.run({ [inName]: new ort.Tensor("float32", inp, [1, 3, rh, rw]) });
  const prob = out[session.outputNames[0]].data; // [1,1,rh,rw] 0..1

  const thr = 0.3;        // bin 化しきい値（DB postprocess thresh）
  const boxThr = 0.6;     // box の平均確信度しきい値（box_thresh）
  const visited = new Uint8Array(plane);
  const stack = [];
  const boxes = [];
  for (let sy = 0; sy < rh; sy++) {
    for (let sx = 0; sx < rw; sx++) {
      const seed = sy * rw + sx;
      if (visited[seed] || prob[seed] < thr) continue;
      let minx = sx, maxx = sx, miny = sy, maxy = sy, cnt = 0, psum = 0;
      stack.length = 0; stack.push(seed); visited[seed] = 1;
      while (stack.length) {
        const idx = stack.pop();
        const y = (idx / rw) | 0, x = idx - y * rw;
        cnt++; psum += prob[idx];
        if (x < minx) minx = x; if (x > maxx) maxx = x;
        if (y < miny) miny = y; if (y > maxy) maxy = y;
        if (x > 0 && !visited[idx - 1] && prob[idx - 1] >= thr) { visited[idx - 1] = 1; stack.push(idx - 1); }
        if (x < rw - 1 && !visited[idx + 1] && prob[idx + 1] >= thr) { visited[idx + 1] = 1; stack.push(idx + 1); }
        if (y > 0 && !visited[idx - rw] && prob[idx - rw] >= thr) { visited[idx - rw] = 1; stack.push(idx - rw); }
        if (y < rh - 1 && !visited[idx + rw] && prob[idx + rw] >= thr) { visited[idx + rw] = 1; stack.push(idx + rw); }
      }
      const bw = maxx - minx + 1, bh = maxy - miny + 1;
      if (psum / cnt < boxThr || Math.min(bw, bh) < 3 || cnt < 12) continue;
      // unclip 近似。rec 切り抜きの glyph 解像度を稼ぐため縦は控えめ(0.08)・横は字端確保で 0.12 に締める
      // (25% だと crop 内で文字が ~67% しか占めず 32px へ縮小時に潰れ精度低下。消去は描画側マージンが補う)。
      const dx = Math.round(bw * 0.12), dy = Math.round(bh * 0.08);
      const x0 = Math.max(0, minx - dx) * (W0 / rw), y0 = Math.max(0, miny - dy) * (H0 / rh);
      const x1 = Math.min(rw, maxx + dx) * (W0 / rw), y1 = Math.min(rh, maxy + dy) * (H0 / rh);
      boxes.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    }
  }
  boxes.sort((a, b) => (a.y - b.y) || (a.x - b.x)); // 上→下・左→右
  return boxes;
}

// crop の輝度ヒストグラム両端 2% を clip して RGB を伸長し、薄い文字の stroke コントラストを補う。
// 単色/既に高コントラストな crop(hi-lo<16)は触らない(過処理回避)。RGBA を in-place 更新。
function contrastStretch(d) {
  const hist = new Uint32Array(256);
  let count = 0;
  for (let p = 0; p < d.length; p += 4) {
    const y = ((d[p] * 299 + d[p + 1] * 587 + d[p + 2] * 114) / 1000) | 0;
    hist[y]++; count++;
  }
  const clip = Math.max(1, Math.round(count * 0.02));
  let lo = 0, hi = 255, acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > clip) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > clip) { hi = v; break; } }
  if (hi - lo < 16) return; // 単色/高コントラストは触らない
  const scale = 255 / (hi - lo);
  for (let p = 0; p < d.length; p += 4) {
    d[p] = Math.min(255, Math.max(0, (d[p] - lo) * scale));
    d[p + 1] = Math.min(255, Math.max(0, (d[p + 1] - lo) * scale));
    d[p + 2] = Math.min(255, Math.max(0, (d[p + 2] - lo) * scale));
  }
}

// CRNN+CTC 認識: box を crop→REC_HEIGHT に高さ揃え(段階縮小+high 補間)→正規化(x/127.5-1)→ greedy CTC decode。
// 縦長 box（縦書き等）は 90° 回転して横書き化してから認識する。
async function recognize(canvas, box, recSession, dict) {
  const sx = Math.max(0, Math.round(box.x)), sy = Math.max(0, Math.round(box.y));
  const sw = Math.min(canvas.width - sx, Math.round(box.w)), sh = Math.min(canvas.height - sy, Math.round(box.h));
  if (sw < 2 || sh < 2) return { text: "", conf: 0 };
  const tmp = new OffscreenCanvas(sw, sh);
  tmp.getContext("2d", { willReadFrequently: true }).drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  let cropCanvas = tmp, cropW = sw, cropH = sh;
  if (sh > sw * 1.5) { // 縦長 → 反時計回り 90° で横長に
    const rot = new OffscreenCanvas(sh, sw);
    const rctx = rot.getContext("2d");
    rctx.imageSmoothingEnabled = true; rctx.imageSmoothingQuality = "high";
    rctx.translate(sh / 2, sw / 2); rctx.rotate(-Math.PI / 2); rctx.drawImage(tmp, -sw / 2, -sh / 2);
    cropCanvas = rot; cropW = sh; cropH = sw;
  }
  // 段階縮小: 一気に REC_HEIGHT へ落とすとエイリアスで細 stroke(ill/ui)が溶けて誤読する。半分ずつ high 補間で落とす。
  let stageW = cropW, stageH = cropH;
  while (stageH > REC_HEIGHT * 2) {
    const nw = Math.max(1, Math.round(stageW / 2)), nh = Math.max(1, Math.round(stageH / 2));
    const half = new OffscreenCanvas(nw, nh);
    const hctx = half.getContext("2d");
    hctx.imageSmoothingEnabled = true; hctx.imageSmoothingQuality = "high";
    hctx.drawImage(cropCanvas, 0, 0, stageW, stageH, 0, 0, nw, nh);
    cropCanvas = half; stageW = nw; stageH = nh;
  }
  const cw = Math.min(REC_MAX_WIDTH, Math.max(1, Math.round((REC_HEIGHT * stageW) / stageH)));
  const cc = new OffscreenCanvas(cw, REC_HEIGHT);
  const ccx = cc.getContext("2d", { willReadFrequently: true });
  ccx.imageSmoothingEnabled = true; ccx.imageSmoothingQuality = "high";
  ccx.drawImage(cropCanvas, 0, 0, stageW, stageH, 0, 0, cw, REC_HEIGHT);
  const d = ccx.getImageData(0, 0, cw, REC_HEIGHT).data;
  contrastStretch(d); // 薄い文字の stroke を締める(単色/高コントラストは内部ガードで素通し)
  const plane = cw * REC_HEIGHT;
  const inp = new Float32Array(3 * plane); // RapidOCR rec も BGR 投入。正規化 x/127.5-1((img/255-0.5)/0.5 と等価)。
  for (let p = 0, i = 0; i < plane; i++, p += 4) {
    inp[i] = d[p + 2] / 127.5 - 1;       // ch0 = B
    inp[plane + i] = d[p + 1] / 127.5 - 1; // ch1 = G
    inp[2 * plane + i] = d[p] / 127.5 - 1; // ch2 = R
  }
  const inName = recSession.inputNames[0];
  const out = await recSession.run({ [inName]: new ort.Tensor("float32", inp, [1, 3, REC_HEIGHT, cw]) });
  const o = out[recSession.outputNames[0]];
  const T = o.dims[1], C = o.dims[2], od = o.data; // [1,T,C]
  // CTC: index0=blank・1..dict.length=文字。use_space_char モデル(C=dict.length+2)は末尾 index が半角スペース。
  // C を見て自己適応するので v1(C=N+1・space無)/v4・v5(C=N+2・space有)のどれでも 1 コードで正しい。
  const hasSpace = C === dict.length + 2;
  let prev = 0, psum = 0, pn = 0;
  const chars = [];
  for (let t = 0; t < T; t++) {
    let best = 0, bestV = -Infinity;
    const base = t * C;
    for (let c = 0; c < C; c++) { const v = od[base + c]; if (v > bestV) { bestV = v; best = c; } }
    if (best !== 0 && best !== prev) {
      const ch = (hasSpace && best - 1 === dict.length) ? " " : dict[best - 1];
      if (ch != null) { chars.push(ch); psum += bestV; pn++; }
    }
    prev = best;
  }
  return { text: chars.join(""), conf: pn ? psum / pn : 0 };
}

// OCR_IMAGE: 画像を decode → detect → 各 box を recognize → blocks[{box(0..1),cy,original}]。
async function runOcr(payload) {
  const { base64, mime, maxSide } = payload;
  const bmp = await bitmapFromBase64(base64, mime);
  const srcMax = Math.max(bmp.width, bmp.height);
  // 小画像(メール ~600px)は upscale して glyph 解像度を稼ぐ。大画像は従来どおり maxSide で縮小。
  let scale = (srcMax < SRC_MIN_SIDE) ? Math.min(UPSCALE_MAX, SRC_MIN_SIDE / srcMax) : Math.min(1, (maxSide || 2048) / srcMax);
  let W = Math.max(1, Math.round(bmp.width * scale));
  let H = Math.max(1, Math.round(bmp.height * scale));
  const cap = OCR_MAX_SIDE / Math.max(W, H); // 長辺を絶対上限でクランプ(メモリ暴発防止)
  if (cap < 1) { W = Math.max(1, Math.round(W * cap)); H = Math.max(1, Math.round(H * cap)); }
  const canvas = new OffscreenCanvas(W, H);
  const octx = canvas.getContext("2d", { willReadFrequently: true });
  octx.imageSmoothingEnabled = true; octx.imageSmoothingQuality = "high";
  octx.drawImage(bmp, 0, 0, W, H);
  if (bmp.close) bmp.close();
  const boxes = await detect(canvas);
  if (!boxes.length) return { blocks: [] };
  const recSession = await getSession("ocrRec", MODEL_URLS.ocrRec);
  const dict = await loadDict();
  const blocks = [];
  for (const box of boxes) {
    const { text, conf } = await recognize(canvas, box, recSession, dict);
    if (!text || !text.trim() || conf < 0.4) continue;
    blocks.push({
      box: { x: box.x / W, y: box.y / H, w: box.w / W, h: box.h / H },
      cy: (box.y + box.h / 2) / H,
      original: text,
    });
  }
  return { blocks };
}

// ---- op ディスパッチャ ----
async function handleOp(op, payload) {
  switch (op) {
    case "INPAINT_IMAGE": return await runInpaint(payload);
    case "OCR_IMAGE": return await runOcr(payload);
    default: throw new Error("unknown op: " + op);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.action !== "RUN_INFERENCE" || !msg.op) return undefined;
  handleOp(msg.op, msg.payload || {})
    .then((result) => sendResponse({ ok: true, result }))
    .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true; // 非同期応答のためチャネルを開いたままにする
});
