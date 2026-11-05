"use strict";

/**
 * image-translator.js — 画像内テキストの翻訳 (LLM vision・ホバー/右クリックの手動)
 *
 * 画像ホバーで「訳」ボタンを出し、クリックで background の TRANSLATE_IMAGE (vision) に投げ、
 * 返ってきた {translation, box} を画像の上にオーバーレイする。オーバーレイ後はボタンが「原」に
 * 変わり、押すとその画像だけ原文に戻せる。Immersive Translate の画像翻訳を参考にした機能。
 * actions.js が先に注入される前提。
 */

(function () {
  const SCRIPT_MARKER = "__rtImgLoaded";
  if (!globalThis.ExtUtil || !ExtUtil.claimScript(SCRIPT_MARKER)) return;
  const scriptOwner = globalThis[SCRIPT_MARKER];
  // 画像翻訳はホバー/右クリックの手動のみ (一括・後追い watcher・iframe 一括注入は廃止)。本スクリプトは
  // manifest の content_scripts で top フレームにのみ常駐する (all_frames 指定なし)。iframe 内画像は
  // 右クリック時に SW が info.frameId のフレームへ本スクリプトをオンデマンド注入して届ける (常駐はしない)。
  // 設定トグルは廃止: 翻訳はホバー/右クリック+クリックの明示操作でしか起きない。

  const A = globalThis.Actions;
  if (!A) return;

  let btn = null;
  let target = null;
  let dead = false; // shutdown 済みフラグ (リスナー解除後の再入を弾く)
  let imageCapable = false; // 選択中プロバイダが画像翻訳(vision)対応か。CONTENT_FLAGS から読む。確定まで false=安全側
  let showImageButton = false; // 画像ホバー「訳」ボタンの表示設定 (CONTENT_FLAGS)。既定 OFF・フラグ確定前も出さない (安全側)。OFF でも翻訳済み画像の「原(戻す)」だけは出す (右クリック翻訳した画像を個別に戻せるように)
  // (既定 provider は mymemory=非対応。楽観的に true 初期化すると get 解決前の数ms に非対応でもボタンが一瞬出るため false 始動)
  // アニメーション画像 (アニメ GIF/WebP・APNG) は canvas inpaint で焼くと静止画に固まるため翻訳対象外。SW が翻訳時に
  // バイトから判定し error:"animated" を返す → その画像をここに登録し、以後ホバーしても「訳」ボタンを出さない。
  // (cross-origin 画像のバイトは content から読めずホバー時点では判定不能なので、初回クリックで確定して登録する方式)
  const animatedImgs = new WeakSet();

  // 拡張 context が生きているか (リロード/更新後に置き去りになった古いスクリプトかの判定)。
  // 失効すると chrome.runtime.id が undefined になり、chrome API 呼び出しは例外を投げる。
  const contextAlive = () => ExtUtil.contextAlive(SCRIPT_MARKER, scriptOwner);
  // context 失効時などに、登録リスナーを解除し btn 除去・state クリアして、これ以上 chrome API / DOM を
  // 触らないよう静かに停止する。各操作は try/catch で例外を吸収する (translator.js の shutdown と同パターン)。
  function shutdown() {
    if (dead) return;
    dead = true;
    try { document.removeEventListener("mouseover", onMouseOver, true); } catch (_e) { /* noop */ }
    try { document.removeEventListener("mouseout", onMouseOut, true); } catch (_e) { /* noop */ }
    try { document.removeEventListener("contextmenu", onContextMenu, true); } catch (_e) { /* noop */ }
    try { window.removeEventListener("scroll", onScroll, true); } catch (_e) { /* noop */ }
    try { chrome.runtime.onMessage.removeListener(onRuntimeMessage); } catch (_e) { /* noop */ }
    try { chrome.storage.onChanged.removeListener(onStorageChanged); } catch (_e) { /* noop */ }
    try { if (btn) btn.remove(); } catch (_e) { /* noop */ }
    // 翻訳済み画像の監視タイマーを止める (context 失効時に死んだスクリプトのタイマーが回り続けるのを防ぐ)。
    try { queryOpenRoots(".__rt-img-wrap").forEach((w) => { if (w.__rtChk) clearInterval(w.__rtChk); }); } catch (_e) { /* noop */ }
    btn = null;
    target = null;
  }

  const tr = ExtUtil.tr; // i18n 取得 (actions.js の共有実装)
  const MAX_IMAGE_PIXELS = (globalThis.RuntimeLimits && RuntimeLimits.MAX_IMAGE_PIXELS) || 25000000;

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
    btn.title = on ? (img.closest(".__rt-img-wrap").__rtPartial ?
      tr("imgPartial", "出力上限に達したため一部のみ翻訳しました。クリックで元に戻します") :
      tr("imgRevert", "画像の翻訳を消して元に戻す")) : tr("imgBtn", "画像内のテキストを翻訳");
    btn.classList.toggle("__rt-img-btn-on", on);
  }

  // ボタンは全画像で共有なので、遅延更新 (タイマー/OCR 応答) は「今もその画像がボタンの対象か」を
  // 確認してから触る。別画像へホバーが移った後に古い結果が表示や「原」状態を上書きしないようにする。
  function showImageError(img, error) {
    if (!btn || target !== img) return;
    const guard = { myRun: imgRunId, url: img.currentSrc || img.src, requestId: imageRequestIds.get(img) };
    btn.title = imgErrorText({ error });
    btn.textContent = "×";
    window.setTimeout(() => {
      if (!dead && contextAlive() && btn && target === img && imageRequestIds.get(img) === guard.requestId && !isStaleImg(guard, img)) {
        btn.textContent = "訳"; btn.title = tr("imgBtn", "画像内のテキストを翻訳");
      }
    }, 4000);
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
  // カーソル位置を動画が覆っているか。カスタムプレーヤーは video を開いた Shadow DOM に包むため、
  // document.elementsFromPoint はシャドウホストしか返さず tagName === "VIDEO" では検出できない。
  // ShadowRoot.elementsFromPoint (Chrome/Firefox 対応) でカーソル位置の内側スタックだけを再帰確認する
  // (querySelector 全走査だと mouseover 毎に重く、video を含む大きなコンポーネント全面をブロックしてしまう)。
  // 要素が視覚上見えているか (透明プリロード動画対策)。サイトはホバー再生用 video を opacity:0 で
  // サムネの上に重ねることがあり、ヒットテストには乗るが実際に見えているのはサムネ。
  // display:none はヒットテストに乗らないので、visibility と自身の computed opacity だけ見れば足りる。
  function isShown(el) {
    try {
      const view = el.ownerDocument.defaultView;
      // visibility は継承されて computed に現れる (子の visible 上書きも反映済み) ため自身だけ見る
      if (view.getComputedStyle(el).visibility === "hidden") return false;
      // opacity は継承されず親の透明度が computed に現れないため、祖先 (Shadow DOM ホスト含む) を
      // 遡って実効透明度を積算する (opacity:0 のラッパー内の video を透明と判定するため)
      let opacity = 1;
      for (let node = el; node;) {
        opacity *= parseFloat(view.getComputedStyle(node).opacity);
        if (opacity < 0.1) return false;
        node = node.parentElement || node.getRootNode().host || null;
      }
      return true;
    } catch (_e) { return true; }
  }

  function coversVideo(el, x, y) {
    if (!isShown(el)) return false;                     // 透明レイヤーは動画ごと無視して奥のサムネを生かす
    if (el.tagName === "VIDEO") return true;
    const root = el.shadowRoot;
    if (!root || typeof root.elementsFromPoint !== "function") return false;
    // ShadowRoot.elementsFromPoint は shadow 内の要素だけでなくホストの祖先 (light DOM 側のスタック) も返す。
    // 祖先へ再帰すると「祖先の root が子孫ホストを返し返す」相互再帰になり、shadow ネストが深いサイト
    // (Reddit の shreddit-* 等) で指数的に発散しメインスレッドを塞ぐ (= クリック不可のページ応答停止)。
    // root.contains で「この root の内側」だけに絞れば深さ方向のみの再帰になり必ず終わる。
    try { return root.elementsFromPoint(x, y).some((n) => n !== el && root.contains(n) && coversVideo(n, x, y)); } catch (_e) { return false; }
  }

  // document.querySelectorAll / document.images は開いた Shadow DOM を貫通しない。右クリック注入後の
  // URL 解決・ページ復元・context 失効時のタイマー停止で同じ画像集合を扱えるよう、open root を DFS する。
  // 呼ばれるのは明示操作/後始末時だけで、mouseover の高頻度経路では全 DOM 走査しない。
  function* openRoots() {
    const stack = [document];
    while (stack.length) {
      const root = stack.pop();
      yield root;
      let elements;
      try { elements = root.querySelectorAll("*"); } catch (_e) { continue; }
      for (let i = elements.length - 1; i >= 0; i--) {
        if (elements[i].shadowRoot) stack.push(elements[i].shadowRoot);
      }
    }
  }

  function queryOpenRoots(selector) {
    const matches = [];
    for (const root of openRoots()) {
      try { matches.push(...root.querySelectorAll(selector)); } catch (_e) { /* noop */ }
    }
    return matches;
  }

  // カーソル位置にある要素だけを open Shadow DOM へ降りて最前面順に平坦化する。ShadowRoot の
  // elementsFromPoint は host の祖先も返すため root.contains で内側だけへ絞り、seen で重複を除く。
  function elementsFromPointDeep(root, x, y, seen = new Set()) {
    let stack;
    try { stack = root.elementsFromPoint(x, y); } catch (_e) { return []; }
    const found = [];
    for (const el of stack) {
      if (!el || seen.has(el) || (root !== document && !root.contains(el))) continue;
      seen.add(el);
      if (el.shadowRoot && typeof el.shadowRoot.elementsFromPoint === "function") {
        found.push(...elementsFromPointDeep(el.shadowRoot, x, y, seen));
      }
      found.push(el);
    }
    return found;
  }

  function eventPathHasClass(e, className) {
    if (!e || typeof e.composedPath !== "function") return false;
    try { return e.composedPath().some((n) => n && n.classList && n.classList.contains(className)); } catch (_e) { return false; }
  }

  function imgAtPoint(e) {
    // composed event は document 側で target が shadow host へリターゲットされるが、composedPath には
    // 内側の IMG が残る。まずこの最短経路を使い、オーバーレイ被りは下の deep hit-test で解決する。
    if (typeof e.composedPath === "function") {
      try {
        for (const el of e.composedPath()) {
          if (el !== btn && eligible(el)) return el;
        }
      } catch (_e) { /* fallback below */ }
    }
    if (eligible(e.target)) return e.target;            // 速い経路: light DOM の img が最前面
    if (typeof e.clientX !== "number") return null;
    for (const el of elementsFromPointDeep(document, e.clientX, e.clientY)) {
      if (el === btn) continue;                         // 自前のボタン/オーバーレイは飛ばす
      if (coversVideo(el, e.clientX, e.clientY)) return null; // 見えているのは動画: 下に敷かれたポスター/サムネ img を拾わない
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
    // ボタン表示 OFF / vision 非対応プロバイダでは未翻訳画像にボタンを出さないので、翻訳済み画像の
    // 「原(戻す)」候補 (= .__rt-img-wrap 内) にいるときだけ画像解決へ進み、それ以外は imgAtPoint
    // (elementsFromPoint + getComputedStyle 走査) ごと省く (mouseover 高頻度イベントの無駄な style flush を防ぐ)。
    if ((!showImageButton || !imageCapable) &&
        !(e.target && e.target.closest && e.target.closest(".__rt-img-wrap")) &&
        !eventPathHasClass(e, "__rt-img-wrap")) return;
    if (!contextAlive()) { shutdown(); return; } // 失効した旧スクリプトはボタンを出さず後始末
    if (e.target === btn) return;                // 自前ボタン上では target/位置を保持して何もしない
    const img = imgAtPoint(e);
    if (!img) {
      // 表示中のボタンは隠す: 対象画像の矩形内でも動画等に覆われた位置では残さない (onMouseOut は
      // 矩形内判定でボタンを保持するため、ここで消さないと動画の上にボタンが残る)。ボタン自身の
      // ホバーは冒頭の e.target === btn で return 済みなので誤って消えない。
      if (btn) btn.style.display = "none";
      return;
    }
    // 画像翻訳に未対応のプロバイダ (vision 無し = xai/deepseek/mymemory 等) を選択中は「訳」ボタンを出さない
    // (クリックしても no_vision になるだけなので無意味な操作を見せない)。ボタン表示 OFF 設定も同様。
    // ただし既に翻訳済みの画像は「原(戻す)」を出して元に戻せるようにする (翻訳後にプロバイダを非対応へ
    // 切り替えた / 表示 OFF のまま右クリック翻訳したケースで取り残さない)。
    if ((!imageCapable || !showImageButton) && !isTranslated(img)) return;
    // 翻訳済みでないアニメーション画像 (SW が判定済み) はボタンを出さない。アニメは焼き込みで固まるので翻訳対象外。
    if (animatedImgs.has(img) && !isTranslated(img)) return;
    target = img; placeBtn(img);
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

  // capture + passive: 全ページに常駐するので、ハンドラがスクロール/ホバーを妨げない (preventDefault しない) ことを
  // ブラウザに明示してイベント処理の最適化を許す。onMouseOver は eligible(IMG 以外は即 return) で軽い。
  // 右クリック「この画像を翻訳」用: 直近の contextmenu で解決した画像を覚える (SW の TRANSLATE_IMAGE_CS が
  // 届いたときの第一候補)。imgAtPoint 経由なのでオーバーレイ (<a> 等) 被りの画像も拾える。
  let ctxImg = null;
  function onContextMenu(e) {
    if (dead) return;
    ctxImg = imgAtPoint(e);
  }

  // srcUrl に一致する img を解決する。同一 URL の画像が複数あるとき (ロゴ/サムネ複製) に先頭一致だと
  // 別の画像へオーバーレイが乗るため、ビューポート内 (右クリックした画像は必ず可視) を優先し、
  // 同率なら表示面積の大きい方を採る。
  function findBySrcUrl(srcUrl) {
    let best = null, bestScore = -1;
    for (const i of queryOpenRoots("img")) {
      if ((i.currentSrc || i.src) !== srcUrl) continue;
      const r = i.getBoundingClientRect();
      const visible = r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
      const score = (visible ? 1e9 : 0) + Math.min(r.width * r.height, 1e8);
      if (score > bestScore) { bestScore = score; best = i; }
    }
    return best;
  }

  // 右クリックメニューからの画像翻訳。直近 contextmenu の対象 img を優先し、オンデマンド注入直後
  // (contextmenu を見ていない) は srcUrl 照合で解決する。明示操作なのでホバーボタン表示設定 (showImageButton)
  // には従わず、進捗/結果 (…/原/×+理由) は共有ホバーボタン UI で可視化する (vision 非対応や失敗も title で読める)。
  function translateImgFromContext(srcUrl) {
    if (dead) return;
    if (!contextAlive()) { shutdown(); return; }
    let img = (ctxImg && ctxImg.isConnected) ? ctxImg : null;
    if (img && srcUrl && (img.currentSrc || img.src) !== srcUrl) img = null; // 別画像を指していたら srcUrl 照合へ
    if (!img && srcUrl) img = findBySrcUrl(srcUrl);
    if (!img) return; // SW が info.frameId のフレームへ配送するため通常ここには来ない (src 差し替え直後等のみ)
    target = img;
    placeBtn(img);
    if (isTranslated(img)) return; // 翻訳済み: 「原(戻す)」ボタンを出すだけ (戻す操作はボタン/ページ復元に委ねる)
    // 既知のアニメーション画像 (SW 判定済み) は再送しない (画像 fetch の無駄打ち防止)。理由だけ ×+title で出す。
    if (animatedImgs.has(img)) { showImageError(img, "animated"); return; }
    translateImg(img);
  }

  document.addEventListener("mouseover", onMouseOver, { capture: true, passive: true });
  document.addEventListener("mouseout", onMouseOut, { capture: true, passive: true });
  document.addEventListener("contextmenu", onContextMenu, { capture: true, passive: true });
  window.addEventListener("scroll", onScroll, { capture: true, passive: true });

  // 選択中プロバイダの画像翻訳対応可否 (imageCapable) を CONTENT_FLAGS から読む。非対応なら「訳」ボタンを出さない。
  // popup でプロバイダを切り替えたら storage.onChanged で即追従する (開いているページもリロード不要)。
  const CFLAGS_KEY = (globalThis.StorageKeys && globalThis.StorageKeys.CONTENT_FLAGS) || "contentFlags";
  function applyFlags(f) {
    if (f && typeof f.imageCapable === "boolean") imageCapable = f.imageCapable;
    if (f && typeof f.showImageButton === "boolean") showImageButton = f.showImageButton;
    // ボタン表示 OFF へ切り替わった瞬間は表示中のボタンを隠す (翻訳済み画像は再ホバーで「原」だけ再表示できる)。
    if (!showImageButton && btn) { btn.style.display = "none"; return; }
    // 非対応へ切り替わった瞬間に、表示中の「訳」ボタン (未翻訳画像) を隠す (翻訳済みの「原」は残す)。
    if (!imageCapable && btn && (!target || !isTranslated(target))) btn.style.display = "none";
  }
  function onStorageChanged(changes, area) {
    if (!contextAlive()) { shutdown(); return; }
    if (area === "local" && changes[CFLAGS_KEY]) applyFlags(changes[CFLAGS_KEY].newValue);
  }
  try {
    chrome.storage.local.get(CFLAGS_KEY, (d) => { if (dead || !contextAlive()) return; applyFlags(d && d[CFLAGS_KEY]); });
    chrome.storage.onChanged.addListener(onStorageChanged);
  } catch (_e) { /* noop */ }

  function isStaleImg(guard, img) {
    if (!guard) return false;
    if (typeof guard.myRun === "number" && guard.myRun !== imgRunId) return true;
    if (typeof guard.requestId === "number" && imageRequestIds.get(img) !== guard.requestId) return true;
    if (!img || !img.isConnected) return true;
    if (guard.url && (img.currentSrc || img.src) !== guard.url) return true;
    return false;
  }

  function stopFollow(wrap) {
    if (wrap && wrap.__rtChk) { clearInterval(wrap.__rtChk); wrap.__rtChk = 0; }
  }

  function debugEnabled() { try { return Boolean(localStorage.getItem("__rt_debug")); } catch (_e) { return false; } }
  function dbg(...a) { try { if (debugEnabled()) console.debug("[rt-img]", ...a); } catch (_e) { /* ログ出力失敗時は無音 */ } }

  // 画像翻訳の失敗理由をユーザー向け文言に展開する (無言の「×」で原因不明にしないため。ページ翻訳の errorText 相当)。
  // SW(translateImage/fetchImageBytes) が返す error 種別を「×」ボタンの title(ホバーで表示) に載せる。
  function imgErrorText(res) {
    const e = res && res.error;
    switch (e) {
      case "animated": return tr("imgErrAnimated", "アニメーション画像は翻訳できません");
      case "no_vision": return tr("imgErrNoVision", "この翻訳サービスは画像翻訳に対応していません（API設定で対応サービスとキーを設定してください）");
      case "no_api_key": return tr("imgErrNoKey", "API キーが未設定です（API設定で入力してください）");
      case "forbidden_target": return tr("imgErrForbidden", "この画像は取得できませんでした");
      case "image_too_large": return tr("imgErrTooLarge", "画像が大きすぎて翻訳できません");
      case "not_image": return tr("imgErrNotImage", "画像として読み取れませんでした");
      case "output_truncated": return tr("imgErrTruncated", "出力上限に達したため翻訳を完了できませんでした");
      case "parse": return tr("imgErrParse", "翻訳結果を読み取れませんでした。もう一度お試しください");
      case "http": return tr("imgErrHttp", "翻訳に失敗しました") + (res && res.status ? "（HTTP " + res.status + "）" : "");
      case "aborted": return tr("imgErrAborted", "翻訳を中止しました");
      default: return tr("imgErrGeneric", "翻訳に失敗しました");
    }
  }

  let imgRunId = 0; // 画像翻訳の全体世代。復元時に ++ し、進行中ホバー OCR の遅延描画を止める
  let imageRequestSeq = 0;
  const imageRequestIds = new WeakMap(); // img -> 最新の個別OCR要求
  // 翻訳リクエスト送信中の img。imageRequestIds は「古い応答を描かない」ための世代ガードで送信自体は
  // 止めないため、「…」表示中の再クリック/右クリック連打がそのまま vision API の重複課金になる。
  // 応答 (成功/失敗/lastError) で必ず解除する。
  const inflightImgs = new WeakSet();

  function invalidateImageRequest(img) {
    if (img) imageRequestIds.set(img, ++imageRequestSeq);
  }

  let rendererPromise = null;
  function loadRenderer() {
    if (!rendererPromise) {
      rendererPromise = chrome.runtime.sendMessage({ action: A.LOAD_IMAGE_RENDERER }).then((res) => {
        if (!res || !res.ok || typeof globalThis.createImageRenderer !== "function") throw new Error("renderer_load");
        return globalThis.createImageRenderer({ isStaleImg, isDead: () => dead || !contextAlive(), unwrapImage, stopFollow, dbg });
      }).catch((error) => { rendererPromise = null; throw error; });
    }
    return rendererPromise;
  }

  async function translateImg(img) {
    const url = img.currentSrc || img.src;
    if (!url) return;
    if (inflightImgs.has(img)) return; // この画像は翻訳リクエスト送信中 (連打による重複課金を防ぐ)
    const width = Number(img.naturalWidth) || 0;
    const height = Number(img.naturalHeight) || 0;
    if (width > 0 && height > 0 && width * height > MAX_IMAGE_PIXELS) {
      showImageError(img, "image_too_large");
      return;
    }
    const myRun = imgRunId; // 復元後に届いた遅延応答を描かないための世代チェック
    const requestId = ++imageRequestSeq;
    imageRequestIds.set(img, requestId);
    // 共有ボタンをこの応答が触ってよいか (対象画像がまだこの img で、最新リクエストのままか)。
    // 別画像へホバーが移った/同じ画像を再クリックした後に、古い応答がボタン表示を上書きするのを防ぐ。
    const ownsBtn = () => Boolean(btn && target === img && imageRequestIds.get(img) === requestId);
    if (btn) btn.textContent = "…";
    inflightImgs.add(img);
    try {
      const { filterBlocks, renderTranslated } = await loadRenderer();
      if (dead || !contextAlive()) { shutdown(); inflightImgs.delete(img); return; }
      if (isStaleImg({ myRun, url, requestId }, img)) { inflightImgs.delete(img); if (ownsBtn()) setBtnMode(img); return; }
      chrome.runtime.sendMessage({ action: A.TRANSLATE_IMAGE, imageUrl: url, imageWidth: width, imageHeight: height }, (res) => {
        inflightImgs.delete(img);
        if (chrome.runtime.lastError) { if (ownsBtn()) btn.textContent = "訳"; return; }
        if (!contextAlive()) { shutdown(); return; } // 応答到着時に失効していたら DOM を触らず停止
        // 復元後の遅延応答 / 削除済み画像は描かない。さらに送信中に src が差し替わった (カルーセル/レスポンシブ/
        // lazy placeholder) 場合は、古い url の OCR を別画像に重ねないよう描画をスキップする (ボタンは戻して再実行可能に)。
        if (myRun !== imgRunId || imageRequestIds.get(img) !== requestId || !img.isConnected || (img.currentSrc || img.src) !== url) { if (ownsBtn()) btn.textContent = "訳"; return; }
        // 切り分けログ (localStorage __rt_debug=1 のときだけ): vision が読んだ原文(orig)と訳文(trans)を出す。
        // orig が既に崩れていれば vision の読み取り段、orig 正常で trans 崩れなら翻訳段、と一目で確定できる。
        if (res && res.ok && Array.isArray(res.blocks)) {
          dbg("img-result", "n=" + res.blocks.length);
          if (debugEnabled()) res.blocks.forEach((b, i) => dbg("  block#" + i, "kind=" + ((b && b.kind) || "-"),
            "orig=" + JSON.stringify((b && b.original) || ""), "trans=" + JSON.stringify((b && b.translation) || "")));
        } else {
          dbg("img-result", "ok=" + !!(res && res.ok), "error=" + (res && res.error));
        }
        // アニメーション画像 (SW がバイトから判定) はこの画像を以後ボタン非表示にする。初回だけ理由を出して隠す。
        if (res && res.error === "animated") {
          animatedImgs.add(img);
          if (ownsBtn()) {
            btn.title = imgErrorText(res);
            btn.textContent = "×";
            window.setTimeout(() => { if (btn && target === img) { btn.style.display = "none"; btn.textContent = "訳"; btn.title = tr("imgBtn", "画像内のテキストを翻訳"); } }, 2000);
          }
          return;
        }
        const blocks = (res && res.ok) ? filterBlocks(res.blocks) : []; // ロゴ/ブランド語の重畳を除外
        if (blocks.length) {
          // canvas inpaint (背景色 fill で原文消去 + 訳文焼き込み) を試し、画像バイトが無い/失敗時は HTML オーバーレイへ。
          renderTranslated(img, blocks, res.image, { myRun, url, requestId })
            .then(() => {
              if (isStaleImg({ myRun, url, requestId }, img)) return;
              const wrap = img.closest(".__rt-img-wrap");
              if (wrap) wrap.__rtPartial = !!res.partial;
              if (ownsBtn()) setBtnMode(img);
            }) // 翻訳済み → ボタンを「原」に切替
            .catch(() => { if (ownsBtn()) btn.textContent = "訳"; });   // 画像が消えていた等で描画失敗 → 無視
        } else if (ownsBtn()) {
          // 「×」表示。完全な応答の空結果は文字無し/全ロゴ(正常)。打ち切り・不正応答は失敗。
          // 失敗時は理由を title(ホバーで表示)に載せ、原因不明の無言失敗を防ぐ(ページ翻訳の errorText 相当)。
          // 失敗は読めるよう「×」を長め(4s)に保持し、文字無しは短く(1.5s)戻す。
          const failed = !(res && res.ok) || res.partial;
          btn.title = failed ? imgErrorText(res?.partial ? { error: "output_truncated" } : res) : tr("imgNoText", "翻訳できる文字が見つかりませんでした");
          btn.textContent = "×";
          window.setTimeout(() => {
            if (myRun === imgRunId && ownsBtn()) { btn.textContent = "訳"; btn.title = tr("imgBtn", "画像内のテキストを翻訳"); }
          }, failed ? 4000 : 1500);
        }
      });
    } catch (_e) {
      inflightImgs.delete(img);
      if (!dead && contextAlive() && ownsBtn()) {
        if (!isStaleImg({ myRun, url, requestId }, img)) showImageError(img, "renderer_load");
        else if (img.isConnected && showImageButton && imageCapable && !animatedImgs.has(img)) setBtnMode(img);
        else btn.style.display = "none";
      }
    }
  }

  // ensureWrap で退避した元 inline style を戻す (フィット用の width/height 等を除去)。
  function restorePrevStyle(el) {
    if (!el || el.__rtPrevStyle === undefined) return;
    if (el.__rtPrevStyle) el.setAttribute("style", el.__rtPrevStyle); else el.removeAttribute("style");
    try { delete el.__rtPrevStyle; } catch (_e) { el.__rtPrevStyle = undefined; }
  }

  // 1 つの wrap (ensureWrap で挿入) を解除して元 DOM 構造に戻す。layer 除去 + 退避 style 復元 + ラッパー除去。
  // 包んだ実体 (host) は <picture> ごと包んだなら picture、そうでなければ img。host を外へ戻す。
  function unwrapImage(wrap) {
    stopFollow(wrap); // 監視タイマーを止める (leak 防止)
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
    invalidateImageRequest(img); // その画像だけ、遅れて届くOCR結果を無効化する
    if (wrap) unwrapImage(wrap);
    setBtnMode(img); // ボタンを「訳」に戻す (続けて再翻訳できる)
  }

  // 画像オーバーレイをすべて消し、ensureWrap で挿入した span.__rt-img-wrap も解除して
  // 元の DOM 構造 (img が親の直接の子) に戻す (原文復元と連動)。
  function clearAllImages() {
    imgRunId++; // 世代を進めて進行中ホバー OCR の遅延描画を無効化する
    queryOpenRoots(".__rt-img-wrap").forEach(unwrapImage);
    // 念のため: ラッパー解除前に取り残された __rtPrevStyle 付き img/picture があれば素の状態へ戻す (二重防御)
    queryOpenRoots("img[style*='100%']").forEach(restorePrevStyle);
    // ラッパー無しで残っているレイヤーがあれば後始末
    queryOpenRoots(".__rt-img-layer").forEach((l) => l.remove());
    if (btn && target) {
      setBtnMode(target);
      if (!target.isConnected || !showImageButton || !imageCapable || animatedImgs.has(target)) btn.style.display = "none";
    }
  }

  // 画像翻訳はホバー/右クリックの手動のみ (一括は廃止)。ページ翻訳には連動せず、原文復元時にだけ
  // 付けたオーバーレイを消す (= ページを元に戻すと画像も元に戻る)。
  function onRuntimeMessage(msg) {
    if (!contextAlive()) { shutdown(); return undefined; }
    if (!msg || typeof msg.action !== "string") return undefined;
    if (msg.action === A.APPLY_RESTORE_CS) clearAllImages();
    else if (msg.action === A.TRANSLATE_IMAGE_CS) translateImgFromContext(msg.srcUrl || "");
    return undefined;
  }
  try { chrome.runtime.onMessage.addListener(onRuntimeMessage); } catch (_e) { /* noop */ }
})();
