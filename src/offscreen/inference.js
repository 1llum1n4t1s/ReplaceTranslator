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

// ---- モデル取得（実行時 DL + Cache API） ----
const MODEL_URLS = {
  migan: "https://huggingface.co/andraniksargsyan/migan/resolve/main/migan_pipeline_v2.onnx",
};
const CACHE_NAME = "rt-onnx-models-v1";

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
        ort.InferenceSession.create(bytes, { executionProviders: eps, graphOptimizationLevel: "all" }),
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

// ---- op ディスパッチャ ----
async function handleOp(op, payload) {
  switch (op) {
    case "INPAINT_IMAGE": return await runInpaint(payload);
    // Phase 4: case "OCR_DETECT" / "OCR_RECOGNIZE" をここに追加する
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
