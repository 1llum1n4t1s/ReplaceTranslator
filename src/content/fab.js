"use strict";

/**
 * fab.js — 画面右端の翻訳タブ (content script・全ページ常駐)
 *
 * レール型タブの形状 (右端に貼り付き・ホバーでページ側へ「にょき！」とせり出す) を踏まえつつ、表面の
 * デザインはこのアプリ専用 (生成りの和紙 × 墨 × 朱の「栞」。詳細は fab.css)。せり出しは fab.css の
 * :hover が担当。クリックで翻訳 ON/OFF をトグル
 * (地球儀=翻訳前 / 戻る矢印=翻訳済み、処理中は呼吸を速める)。
 * 縦方向にドラッグで移動でき、縦位置の比率(ratio)を chrome.storage.local に保存してリサイズにも追従する。
 * actions.js が先に注入される前提。実翻訳は background 経由で translator.js が行う。
 */

(function () {
  if (window.__rtFabLoaded) return;
  window.__rtFabLoaded = true;
  if (window.top !== window.self) return; // トップフレームのみ
  // 動画/音声ファイルを直接開いたメディアページは翻訳対象テキストが無いので出さない
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

  const clamp01 = (v) => Math.min(1, Math.max(0, v));

  let state = "off"; // "off" | "loading" | "on"
  let errText = ""; // 直近の翻訳エラーの理由 (FAB の title に出す。空なら通常表示。無言失敗の可視化)
  let posRatio = 0.82; // 縦位置の比率 (0=最上 / 1=最下)。初期は右下寄り。保存値で上書きする

  const fab = document.createElement("button");
  fab.id = "__rt_fab";
  fab.type = "button";

  // 中央のアイコン (文字は描かない)。地球儀 = 翻訳前 / 戻る矢印 = 原文に戻す。
  // stroke=currentColor で fab.css の .__rt-spine 色 (状態別 --ink) をそのまま継承し、出し分けは .__rt-on で行う。
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
  // 背(spine) = ドラッグ取っ手 + 中央アイコン入れ
  const spine = document.createElement("span");
  spine.className = "__rt-spine";
  spine.append(
    buildIcon("__rt-ico-tr", [ // 地球儀 (翻訳前)
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
  fab.append(spine);

  function tr(key, fallback) {
    try {
      const m = chrome.i18n && chrome.i18n.getMessage(key);
      return m || fallback;
    } catch (_e) {
      return fallback;
    }
  }

  // 翻訳エラーの理由を FAB の title 用に短くまとめる。popup の errorText と同じ i18n キーを再利用し、
  // detail({error,status,provider}) からキー無効/quota/通信/HTTP を出し分ける (popup を開かなくても原因が読める)。
  function errSummary(detail) {
    const base = tr("fabError", "翻訳に失敗しました");
    if (!detail || typeof detail !== "object") return base;
    const prov = detail.provider ? `${detail.provider}: ` : "";
    let why = "";
    if (detail.error === "no_api_key") why = tr("statusNoKey", "API キーが未設定です");
    else if (detail.error === "network") why = tr("statusNetwork", "ネットワークエラー");
    else if (detail.error === "http") {
      if (detail.status === 401 || detail.status === 403) why = tr("statusBadKey", "API キーが無効か権限がありません");
      else if (detail.status === 429) why = tr("statusQuotaDaily", "API の利用上限に達しました");
      else why = `HTTP ${detail.status || ""}`;
    }
    if (why) return `${base}（${prov}${why}）`;
    return prov ? `${base}（${prov.replace(/: $/, "")}）` : base;
  }

  function render() {
    const isOn = state === "on";
    const isLoading = state === "loading";
    const isErr = Boolean(errText);
    fab.classList.toggle("__rt-on", isOn);
    fab.classList.toggle("__rt-loading", isLoading);
    fab.classList.toggle("__rt-error", isErr);
    // アイコンの出し分けは fab.css が .__rt-on で行う (文字は描かない)。ここでは説明文だけ更新する。
    // loading 中もクリックで中止できる (fab.css の pointer-events を殺さない方針) ので、その旨を伝える。
    let base;
    if (isLoading) base = tr("fabCancel", "翻訳中…（クリックで中止）");
    else if (isOn) base = tr("fabRestore", "原文に戻す");
    else base = tr("fabTranslate", "ページを翻訳");
    // エラー時は失敗理由を title/aria に出す (popup を開かなくてもホバーで原因が読める = 無言失敗の可視化)。
    const label = isErr ? errText : base;
    fab.title = (isErr || isLoading) ? label : `${label}（ドラッグで移動）`;
    fab.setAttribute("aria-label", label);
    fab.setAttribute("aria-pressed", isOn ? "true" : "false");
  }

  // ---- 位置 (右端固定・縦ドラッグ。比率で保存しリサイズに追従) ----
  // 右側から離れないよう水平位置は CSS の right:0 に固定し、ドラッグでは縦 (top) だけ動かす。
  function clampTop(top) {
    const h = fab.offsetHeight || 32;
    const maxT = Math.max(0, window.innerHeight - h);
    return Math.min(Math.max(0, top), maxT);
  }
  function applyTop(top) {
    fab.style.top = `${clampTop(top)}px`;
    fab.style.bottom = "auto"; // top 基準に切替 (CSS の right:0 はそのまま = 右端固定)
  }
  function applyRatio(ratio) {
    const h = fab.offsetHeight || 32;
    const maxT = Math.max(0, window.innerHeight - h);
    applyTop(ratio * maxT);
  }
  function ratioFromTop(top) {
    const h = fab.offsetHeight || 32;
    const maxT = Math.max(1, window.innerHeight - h);
    return clamp01(top / maxT);
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

  // pointerup と pointercancel で後始末を共有する。pointercancel (ブラウザがジェスチャを横取り等) は
  // 後続の click が来ないため moved を即解除し、次の正規クリックを誤って握り潰さないようにする。
  function endDrag(e, cancelled) {
    if (!dragging) return;
    dragging = false;
    fab.classList.remove("__rt-dragging");
    try { fab.releasePointerCapture(e.pointerId); } catch (_e) { /* noop */ }
    if (moved) {
      posRatio = ratioFromTop(fab.getBoundingClientRect().top);
      try { chrome.storage.local.set({ [POS_KEY]: { ratio: posRatio } }); } catch (_e) { /* noop */ }
      if (cancelled) moved = false;
    }
  }
  fab.addEventListener("pointerup", (e) => endDrag(e, false));
  fab.addEventListener("pointercancel", (e) => endDrag(e, true));

  // クリックはトグル。ただしドラッグ直後のクリックは抑制する
  fab.addEventListener("click", (e) => {
    if (!e.isTrusted) return; // 合成 click (悪意サイトの __rt_fab.click()) を無視。ユーザー操作なしの翻訳開始=ページ文章送信を防ぐ
    if (moved) {
      e.preventDefault();
      e.stopImmediatePropagation();
      moved = false;
      return;
    }
    if (state === "off") {
      errText = ""; // 再翻訳で前回のエラー表示をクリア
      state = "loading";
      render();
      send({ action: A.TRANSLATE_PAGE });
    } else {
      // on (翻訳済み) も loading (翻訳中) も、クリックで原文へ戻す = 復元/中止。
      // loading 中のクリックを無視すると、autoTranslate で重い/詰まったページでは FAB が
      // ずっと無反応に見え中止すらできないため、いつでも止められるようにする (RESTORE_PAGE が runId を進めて進行中ループも中断する)。
      send({ action: A.RESTORE_PAGE });
      state = "off";
      render();
    }
  });

  // 画面リサイズで画面外に出ないよう、保持中の比率から縦位置を再計算する (右端は CSS の right:0 固定)。
  // resize は連続発火し applyRatio→clampTop が offsetHeight(forced layout) を読むため、rAF で 1 フレーム 1 回に
  // coalesce してドラッグリサイズ中の reflow 連打を抑える (全ページ常駐コストの軽減)。
  let resizeRaf = 0;
  window.addEventListener("resize", () => {
    if (resizeRaf) return;
    resizeRaf = window.requestAnimationFrame(() => {
      resizeRaf = 0;
      if (fab.isConnected) applyRatio(posRatio);
    });
  });

  // translator の進捗で状態同期
  chrome.runtime.onMessage.addListener((m) => {
    if (!m || m.action !== A.TRANSLATION_PROGRESS) return;
    if (m.state === "progress") { errText = ""; state = "loading"; render(); }
    else if (m.state === "done") { errText = ""; state = "on"; render(); }
    else if (m.state === "error") { errText = errSummary(m.detail); state = "off"; render(); } // 失敗理由を title に出す
    else if (m.state === "restored") { errText = ""; state = "off"; render(); }
    else if (m.state === "skipped") { errText = ""; state = "off"; render(); } // ページ言語=翻訳先 → 訳すものが無いので未翻訳状態へ戻す
  });

  render();

  let lastFlags = null; // 直近の CONTENT_FLAGS (showFab 判定をフルスクリーン切替時にも再利用する)
  // 動画 <video> がブラウザ全画面表示中はページ操作の妨げになるため隠す。標準 Fullscreen API ベースなので
  // YouTube/Twitch/U-NEXT/Prime Video 等、動画サイトを問わず汎用的に効く (サイト別の判定を持たない)。
  function isFullscreenVideo() {
    const el = document.fullscreenElement;
    if (!el) return false;
    // querySelector は shadow 境界を越えないため、カスタムプレイヤー/Web Components で <video> が
    // open shadow DOM 内にあると検出できない。translator.js の collectNodes と同方針で shadow root も辿る
    // (closed shadow は仕様上不可)。
    function hasVideo(node) {
      if (!node) return false;
      if (node.tagName === "VIDEO") return true;
      if (node.shadowRoot && hasVideo(node.shadowRoot)) return true;
      const kids = node.children;
      if (kids) {
        for (let i = 0; i < kids.length; i++) {
          if (hasVideo(kids[i])) return true;
        }
      }
      return false;
    }
    return hasVideo(el);
  }
  // FAB の表示可否 (showFab 設定 + 動画全画面表示)。インライン display は fab.css (#__rt_fab) より優先されるので確実に消せる。
  function refreshVisibility() {
    const hidden = (lastFlags && lastFlags.showFab === false) || isFullscreenVideo();
    fab.style.display = hidden ? "none" : "";
  }
  document.addEventListener("fullscreenchange", () => {
    // 全画面化で FAB が非表示になる瞬間にドラッグ中だと、非表示要素への pointerup 配送がブラウザによっては
    // 行われず dragging=true が残留しうる (以後 pointermove が誤反応する) ため、先にドラッグを終了させる。
    if (dragging) endDrag({}, true); // pointerId 無しの空オブジェクト (e.pointerId は undefined になるだけで例外を投げない)
    refreshVisibility();
  });

  function applyVisibility(flags) {
    lastFlags = flags;
    refreshVisibility();
  }
  function mount() {
    (document.body || document.documentElement).appendChild(fab);
    applyRatio(posRatio); // mount 後は offsetHeight が取れるので縦位置を確定する
  }

  // 保存済みの縦位置比率を復元 (旧 {top}/{left,top} 形式なら現在のビューポートで ratio へ換算)。
  try {
    chrome.storage.local.get(POS_KEY, (d) => {
      const pos = d && d[POS_KEY];
      if (pos && typeof pos.ratio === "number") posRatio = clamp01(pos.ratio);
      else if (pos && typeof pos.top === "number") posRatio = ratioFromTop(pos.top);
      if (fab.isConnected) applyRatio(posRatio); // mount 済みなら即反映 (未 mount なら mount() 側で反映)
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
