"use strict";

/**
 * popup.js — ポップアップ UI (2タブ: 翻訳 / API設定)
 *
 * - 翻訳タブ: 自動翻訳トグル / 言語(元・先) / オプション / 翻訳・復元 / status / クイック翻訳
 * - API設定タブ: サービス切替(状態) + キー入力 + 動的モデル一覧(新しい順10件 + コスト相対バー)
 * モデルは GET_MODELS で動的取得し、選択中が消えていれば background がマイグレーションする。
 */

(function () {
  const $ = (id) => document.getElementById(id);
  const state = { settings: null };
  const msg = ExtUtil.tr; // i18n 取得 (actions.js の共有実装)

  function applyI18n() {
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const m = chrome.i18n.getMessage(el.getAttribute("data-i18n"));
      if (m) el.textContent = m;
    });
    document.querySelectorAll("[data-i18n-title]").forEach((el) => {
      const m = chrome.i18n.getMessage(el.getAttribute("data-i18n-title"));
      if (m) el.title = m;
    });
  }

  // ---- タブ ----
  function moveInk(tabEl) {
    const ink = document.querySelector(".tab-ink");
    if (!ink || !tabEl) return;
    ink.style.left = `${tabEl.offsetLeft}px`;
    ink.style.width = `${tabEl.offsetWidth}px`;
  }
  function switchTab(name) {
    document.querySelectorAll(".tab").forEach((t) => {
      const active = t.dataset.tab === name;
      t.classList.toggle("is-active", active);
      t.setAttribute("aria-selected", active ? "true" : "false");
      if (active) moveInk(t);
    });
    document.querySelectorAll(".pane").forEach((p) => {
      p.classList.toggle("is-active", p.dataset.pane === name);
    });
  }

  function option(value, label) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    return o;
  }
  function fillLangSelect(sel, includeAuto) {
    sel.replaceChildren();
    (includeAuto ? Lang.LANGUAGES : Lang.targets()).forEach((l) => sel.appendChild(option(l.code, l.native)));
  }

  // ---- 翻訳タブ: サービス一覧 ----
  // 各プロバイダの静的カード(選択ヘッダ + キー入力を合体)の状態を in-place 更新する。
  // 入力欄は再生成しない (blur 自動保存中に値が消えないようにするため)。
  function renderProviderList() {
    const cur = state.settings.provider;
    Providers.ids.forEach((id) => {
      const card = document.querySelector(`.provider-card[data-provider="${id}"]`);
      if (!card) return;
      const p = Providers.get(id);
      const requiresKey = p.requiresKey !== false;
      const hasKey = Boolean(state.settings.apiKeys && state.settings.apiKeys[id]);
      const selected = id === cur;
      card.classList.toggle("selected", selected);
      const head = card.querySelector(".pc-head");
      if (head) head.setAttribute("aria-checked", selected ? "true" : "false");

      const badge = card.querySelector("[data-badge]");
      if (badge) {
        if (!requiresKey) { badge.className = "pi-badge free"; badge.textContent = msg("badgeFree", "No key"); }
        else if (hasKey) { badge.className = "pi-badge ok"; badge.textContent = "✓"; }
        else { badge.className = "pi-badge warn"; badge.textContent = msg("badgeKeyRequired", "Key"); }
      }
    });
    placeModelRow();
  }

  // モデル一覧 (#model-row) を選択中プロバイダのカード内 (アコーディオンの中) に移動する。
  // 「そのサービスのキー + モデル」を 1 枚のカードにまとめて見やすくするため。
  // 単一要素を appendChild で移すだけ (id 重複を避け、loadModels の参照 #model-list/#refresh-models も追従する)。
  function placeModelRow() {
    const card = document.querySelector(`.provider-card[data-provider="${state.settings.provider}"]`);
    const body = card && card.querySelector(".pc-body");
    const row = $("model-row");
    if (body && row && row.parentElement !== body) body.appendChild(row);
  }

  // ---- API設定タブ: 動的モデル一覧 (新しい順10件 + コスト相対バー) ----
  function renderModelList(models, currentId) {
    const list = $("model-list");
    list.replaceChildren();
    let maxCost = 0;
    models.forEach((m) => { if (m.price && m.price.total > maxCost) maxCost = m.price.total; });
    models.forEach((m) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "model-item" + (m.id === currentId ? " selected" : "");

      const name = document.createElement("span");
      name.className = "mi-name";
      name.textContent = m.name || m.id; // 公式表示名 ("GPT-5.6 Sol") 優先。無ければ生 ID

      const cost = document.createElement("span");
      cost.className = "mi-cost";
      if (m.price) {
        const track = document.createElement("span");
        track.className = "mi-track";
        const bar = document.createElement("span");
        bar.className = "mi-bar";
        bar.style.width = `${maxCost > 0 ? Math.max(8, Math.round((m.price.total / maxCost) * 100)) : 8}%`;
        track.appendChild(bar);
        cost.appendChild(track);
        // 表示名を出しているときは実 ID も tooltip に併記する (API に渡る ID を確認できるように)
        item.title = (m.name ? `${m.id}\n` : "") + `$${m.price.input} / $${m.price.output} per 1M tokens (in / out)`;
      } else {
        cost.textContent = msg("costUnknown", "—");
        item.title = (m.name ? `${m.id}\n` : "") + msg("costUnknownTitle", "Price unknown");
      }

      item.append(name, cost);
      item.addEventListener("click", () => {
        const models2 = Object.assign({}, state.settings.models, { [state.settings.provider]: m.id });
        save({ models: models2 }, () => renderModelList(models, m.id));
      });
      list.appendChild(item);
    });
  }

  function loadModels(force) {
    const requested = state.settings.provider; // 応答到着までにプロバイダが変わる可能性があるため捕捉
    const p = Providers.get(requested);
    const row = $("model-row");
    if (!p || p.batch === false) { // MyMemory 等はモデル概念なし
      $("model-list").replaceChildren();
      row.dataset.provider = requested;
      row.classList.add("hidden");
      return;
    }
    // 別プロバイダへ切り替えた直後は、旧プロバイダのモデル一覧を表示したままの #model-row が
    // placeModelRow で新カードへ移り、fadeDown で「旧モデル + 旧ハイライト」が一瞬見える (stale flash)。
    // 表示中の provider が変わったら同期で消して隠す (応答到着時に callback が正しい一覧で開き直す)。
    // 同一 provider の再取得 (キー保存 / 更新ボタン) では消さない (正しい一覧がチラつくのを防ぐ)。
    if (row.dataset.provider !== requested) {
      $("model-list").replaceChildren();
      row.classList.add("hidden");
    }
    // 取得 (API 通信) は force のときだけ走る = 「キー入力後」と「更新ボタン押下時」。
    const btn = $("refresh-models");
    if (force && btn) { btn.disabled = true; btn.classList.add("is-spinning"); }
    chrome.runtime.sendMessage(
      { action: Actions.GET_MODELS, provider: requested, force: Boolean(force) },
      (res) => {
        if (force && btn) { btn.disabled = false; btn.classList.remove("is-spinning"); }
        if (requested !== state.settings.provider) return; // 別プロバイダに切替済み → 古い応答は捨てる(誤モデル保存を防ぐ)
        const models = (res && res.ok && res.models) ? res.models : [];
        row.dataset.provider = requested; // 表示中の provider を記録 (次回切替時の stale 判定に使う)
        row.classList.toggle("hidden", models.length === 0);
        if (models.length) renderModelList(models, state.settings.models[requested]);
      }
    );
  }

  function updateKeyWarning() {
    const p = Providers.get(state.settings.provider);
    const requiresKey = !p || p.requiresKey !== false;
    const hasKey = !requiresKey || Boolean(state.settings.apiKeys && state.settings.apiKeys[state.settings.provider]);
    $("key-warning").classList.toggle("hidden", hasKey);
    $("translate").disabled = !hasKey;
  }

  function selectProvider(id) {
    if (id === state.settings.provider) return;
    save({ provider: id }, () => {
      renderProviderList();
      updateKeyWarning();
      loadModels(false);
    });
  }

  // ---- キータブ ----
  // キー入力欄 (#key-<id>) と取得リンク (#link-<id>) は Providers.ids を走査して一括配線する。
  // provider 追加時に個別の id 列挙を増やさず済む。要素が無い provider (例: mymemory はリンク無し) はガードでスキップ。
  function setLinks() {
    Providers.ids.forEach((id) => {
      const a = $(`link-${id}`);
      const p = Providers.get(id);
      if (a && p && p.keyUrl) a.href = p.keyUrl;
    });
  }
  function reflectKeys() {
    const keys = (state.settings && state.settings.apiKeys) || {};
    Providers.ids.forEach((id) => {
      const inp = $(`key-${id}`);
      if (inp) inp.value = keys[id] || "";
    });
  }
  function collectKeys() {
    const apiKeys = {};
    Providers.ids.forEach((id) => {
      const inp = $(`key-${id}`);
      if (inp) apiKeys[id] = inp.value.trim();
    });
    return { apiKeys };
  }
  // API キー欄はフォーカスが外れたら(blur)自動保存する。保存できたらその欄に緑チェックを一瞬出す。
  function flashSaved(id) {
    const kf = $(id).closest(".provider-card");
    const mark = kf && kf.querySelector(".saved-mark");
    if (!mark) return;
    mark.classList.add("is-saved");                 // pop イン
    window.clearTimeout(mark._t);
    mark._t = window.setTimeout(() => mark.classList.remove("is-saved"), 1300); // 一瞬出して自動で消す
  }
  function bindKeyAutosave() {
    Providers.ids.forEach((provider) => {
      const elId = `key-${provider}`;
      const inp = $(elId);
      if (!inp) return;
      inp.addEventListener("blur", () => {
        const val = inp.value.trim();
        const cur = (state.settings.apiKeys && state.settings.apiKeys[provider]) || "";
        if (val === cur) return; // 変化なしは保存もチェック表示もしない
        save(collectKeys(), () => {
          flashSaved(elId);
          renderProviderList();
          updateKeyWarning();
          if (provider === state.settings.provider) loadModels(true); // 選択中サービスのキー変更時は最新モデルを取得
        });
      });
    });
  }

  // ---- 共通 ----
  function reflect() {
    $("auto-translate").checked = Boolean(state.settings.autoTranslate);
    const fabOn = state.settings.showFab !== false;
    $("show-fab").checked = fabOn;
    // 不透明度スライダー: 乗数(0.2〜1.0)→パーセント表示。FAB 非表示のときは操作不可にして淡くする
    const opPct = Math.round((typeof state.settings.fabOpacity === "number" ? state.settings.fabOpacity : 1) * 100);
    $("fab-opacity").value = String(opPct);
    $("fab-opacity-val").textContent = opPct + "%";
    $("fab-opacity").disabled = !fabOn;
    const selOn = state.settings.selectionTranslate !== false;
    $("sel-translate").checked = selOn;
    $("sel-mode").value = state.settings.selectionMode === "inline" ? "inline" : "bubble";
    $("sel-mode").disabled = !selOn; // 選択翻訳 OFF のときは表示方法を選べないよう淡くする
    renderProviderList();
    $("source").value = state.settings.sourceLang;
    $("target").value = state.settings.targetLang;
    updateKeyWarning();
    reflectKeys();
    updateQtDir();
    loadModels(false);
  }

  let pendingSave = Promise.resolve(); // 直近の save() の storage 確定を待つための promise
  function save(patch, after) {
    state.settings = Object.assign({}, state.settings, patch); // 楽観更新 (UI 即応)
    // 全体ではなく patch (変更分) だけ送り、background が保管値にマージする (他経路の変更を巻き戻さない)
    pendingSave = new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: Actions.APPLY_SETTINGS, patch }, (res) => {
        if (res && res.settings) state.settings = res.settings;
        if (after) after();
        resolve();
      });
    });
    return pendingSave;
  }

  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }
  const setStatus = (t) => { $("status").textContent = t || ""; };

  // 翻訳エラーの「理由」を可読な文言にする。translator から届く fatal detail
  // ({error, status, message}) を見て、キー未設定 / キー無効(401/403) / HTTP+本文 / 通信失敗 を出し分ける。
  // 原因 (どのサービスの何が起きたか) を一目で分かるようにし、ただの「エラー」表示で詰まないようにする。
  function errorText(detail) {
    const generic = msg("statusError", "Error");
    if (!detail || typeof detail !== "object") return generic;
    // 失敗元プロバイダは detail.provider を優先採用する (翻訳中にサービスを切り替えても、実際に失敗したプロバイダ名で表示する)。
    // detail.provider が無いとき (旧経路) は現在選択中のプロバイダで代替して従来挙動を保つ。
    const provId = (detail && detail.provider) || (state.settings && state.settings.provider);
    const prov = provId && Providers.get(provId);
    const pfx = prov ? `${prov.label}: ` : "";
    if (detail.error === "no_api_key") return pfx + msg("statusNoKey", "API key is not set");
    if (detail.error === "network") return pfx + msg("statusNetwork", "Network error");
    if (detail.error === "http") {
      if (detail.status === 401 || detail.status === 403) return pfx + msg("statusBadKey", "API key is invalid or unauthorized");
      if (detail.status === 429) {
        // 無料枠の 1 日上限 (RPD) / 残高切れは「待っても並列を下げても解けない」ので専用表示にする。
        const lm = String(detail.message || "").toLowerCase();
        const capped = lm.includes("perday") || lm.includes("per day") || lm.includes("per-day") ||
          lm.includes("daily") || lm.includes("insufficient_quota");
        if (capped) return pfx + msg("statusQuotaDaily", "API quota reached (free daily limit or out of credit). Wait, upgrade, or switch provider.");
      }
      let reason = "";
      if (detail.message) {
        // Gemini/各社のエラー本文は {"error":{"message":"..."}} 形式が多い。message だけ抜く (無ければ生文字列)。
        try { reason = (JSON.parse(detail.message).error || {}).message || ""; } catch (_e) { reason = String(detail.message); }
      }
      reason = reason ? ` — ${reason.slice(0, 160)}` : "";
      return pfx + (detail.status ? `HTTP ${detail.status}` : generic) + reason;
    }
    return pfx + generic;
  }

  // ---- クイック翻訳 (ちょっとだけ訳す。上部の翻訳元⇄翻訳先を流用し TRANSLATE_BATCH に 1 件投げる) ----
  function langShort(coderef) {
    if (coderef === "auto") return msg("qtAuto", "自動");
    const l = Lang.get(coderef);
    return l ? l.native : coderef;
  }
  function updateQtDir() {
    const d = $("qt-dir");
    if (d && state.settings) d.textContent = `${langShort(state.settings.sourceLang)} → ${langShort(state.settings.targetLang)}`;
  }
  function setupQuickTranslate() {
    const qt = $("qt"), inEl = $("qt-in"), outEl = $("qt-out");
    const countEl = $("qt-count"), copyBtn = $("qt-copy"), clearBtn = $("qt-clear");
    const MAX = 5000;
    let timer = null, reqId = 0;

    inEl.placeholder = msg("qtPlaceholder", "ここに入力 / 貼り付け（このページは翻訳しません）");
    outEl.setAttribute("data-ph", msg("qtOutPlaceholder", "訳文がここに出ます"));

    function setCount() {
      const n = inEl.value.length;
      countEl.textContent = `${n.toLocaleString()} / 5,000`;
      countEl.classList.toggle("over", n > MAX);
    }
    function render(text, isErr) {
      outEl.classList.toggle("err", Boolean(isErr));
      outEl.replaceChildren();
      if (text) { const s = document.createElement("span"); s.className = "txt"; s.textContent = text; outEl.appendChild(s); }
    }
    async function run() {
      const text = inEl.value.trim();
      if (!text) { qt.classList.remove("busy"); render(""); return; }
      if (text.length > MAX) { qt.classList.remove("busy"); render(msg("qtTooLong", "5000文字を超えています"), true); return; }
      const myReq = ++reqId;
      qt.classList.add("busy");
      // 直前のカード操作 (provider 切替 / 言語変更) の save が storage に確定してから送る。
      // background は保管値で翻訳するため、await せず Ctrl+Enter で debounce を飛ばすと古い設定で訳す恐れがある。
      await pendingSave;
      if (myReq !== reqId) return; // 待っている間に入力が進んで別リクエストになっていたら破棄
      // texts のみ送る。provider / 言語 / API キーは background が保管値を使う (キーは content/popup に出さない)。
      chrome.runtime.sendMessage({ action: Actions.TRANSLATE_BATCH, texts: [text], quick: true }, (res) => {
        if (myReq !== reqId) return; // 入力が進んで別リクエストになっていたら破棄
        qt.classList.remove("busy");
        if (chrome.runtime.lastError) { render(msg("qtError", "翻訳できませんでした"), true); return; }
        if (res && res.ok && Array.isArray(res.translations) && res.translations[0]) render(res.translations[0]);
        else if (res && res.error === "no_api_key") render(msg("qtNoKey", "このサービスの API キーが未設定です"), true);
        else if (res && res.error === "too_long") render(msg("qtLimit", "このサービスには長すぎます（短くするか LLM プロバイダを選んでください）"), true);
        else render(msg("qtError", "翻訳できませんでした"), true);
      });
    }
    function schedule() {
      setCount();
      window.clearTimeout(timer);
      if (!inEl.value.trim()) { qt.classList.remove("busy"); reqId++; render(""); return; }
      timer = window.setTimeout(run, 550); // debounce
    }

    inEl.addEventListener("input", schedule);
    inEl.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); window.clearTimeout(timer); run(); }
    });
    // ---- 発音 (Web Speech API speechSynthesis。Chrome/Firefox 両対応・権限追加不要) ----
    const speakInBtn = $("qt-speak-in"), speakOutBtn = $("qt-speak-out");
    let speakingBtn = null; // 再生中ボタン (同じボタン再クリックで停止)
    // speechSynthesis は BCP47 を期待する。設定の言語コードのうち地域が要る中国語だけ写像する
    const bcp47 = (code) => (code === "zh-Hans" ? "zh-CN" : code === "zh-Hant" ? "zh-TW" : code);
    function stopSpeak() {
      try { window.speechSynthesis.cancel(); } catch (_e) { /* noop */ }
      if (speakingBtn) speakingBtn.classList.remove("speaking");
      speakingBtn = null;
    }
    async function speak(btn, text, langCode) {
      if (!("speechSynthesis" in window) || !text) return;
      if (speakingBtn === btn) { stopSpeak(); return; }
      stopSpeak();
      let lang = langCode;
      if (!lang || lang === "auto") {
        // 翻訳元 auto は実テキストから言語を推定 (translator.js の detectPageLang と同じ CLD)
        try {
          const d = await new Promise((resolve) => chrome.i18n.detectLanguage(text, resolve));
          const top = d && d.languages && d.languages[0];
          lang = top && top.language;
        } catch (_e) { /* 推定失敗はエンジン既定音声に任せる */ }
      }
      const u = new SpeechSynthesisUtterance(text);
      if (lang && lang !== "auto") u.lang = bcp47(Lang.normalizeCode(lang) || lang);
      u.onend = u.onerror = () => { if (speakingBtn === btn) { btn.classList.remove("speaking"); speakingBtn = null; } };
      speakingBtn = btn;
      btn.classList.add("speaking");
      window.speechSynthesis.speak(u);
    }
    if (speakInBtn) speakInBtn.addEventListener("click", () => speak(speakInBtn, inEl.value.trim(), state.settings && state.settings.sourceLang));
    if (speakOutBtn) speakOutBtn.addEventListener("click", () => {
      if (outEl.classList.contains("err")) return; // エラーメッセージは読み上げない
      speak(speakOutBtn, (outEl.textContent || "").trim(), state.settings && state.settings.targetLang);
    });

    clearBtn.addEventListener("click", () => { inEl.value = ""; reqId++; setCount(); render(""); stopSpeak(); inEl.focus(); });
    copyBtn.addEventListener("click", () => {
      const t = outEl.textContent || "";
      if (!t || outEl.classList.contains("err")) return;
      try { navigator.clipboard.writeText(t); } catch (_e) { /* noop */ }
      const orig = msg("qtCopy", "コピー");
      copyBtn.classList.add("done");
      copyBtn.textContent = msg("qtCopied", "✓ コピー");
      window.clearTimeout(copyBtn._t);
      copyBtn._t = window.setTimeout(() => { copyBtn.classList.remove("done"); copyBtn.textContent = orig; }, 1300);
    });
    setCount();
  }

  function init() {
    applyI18n();
    setLinks();
    fillLangSelect($("source"), true);
    fillLangSelect($("target"), false);

    // 自タブの直近翻訳エラーも受け取りたいので tabId を添えて状態を取得する。
    // (自動翻訳/FAB でエラーが出た後にこの popup を開くと、揮発した error イベントは逃すが last-error で再表示できる。)
    getActiveTab().then((tab) => {
      chrome.runtime.sendMessage({ action: Actions.GET_STATE, tabId: tab && tab.id }, (res) => {
        if (res && res.ok) {
          state.settings = res.settings;
          reflect();
          if (res.lastError) setStatus(errorText(res.lastError)); // 直近の失敗理由 (キー無効/quota 等) を出す
        }
      });
    });

    document.querySelectorAll(".tab").forEach((t) => {
      t.addEventListener("click", () => switchTab(t.dataset.tab));
    });
    moveInk(document.querySelector(".tab.is-active"));

    $("source").addEventListener("change", (e) => { save({ sourceLang: e.target.value }); updateQtDir(); });
    $("target").addEventListener("change", (e) => { save({ targetLang: e.target.value }); updateQtDir(); });

    $("translate").addEventListener("click", async () => {
      const tab = await getActiveTab();
      if (!tab) return;
      await pendingSave; // 直前の言語/provider 変更が storage に確定してから翻訳する (古い設定での初回実行を防ぐ)
      setStatus(msg("statusStarting", "Starting…"));
      chrome.runtime.sendMessage({ action: Actions.TRANSLATE_PAGE, tabId: tab.id }, (res) => {
        if (!res || !res.ok) setStatus(msg("statusError", "Error"));
      });
    });
    $("restore").addEventListener("click", async () => {
      const tab = await getActiveTab();
      if (!tab) return;
      chrome.runtime.sendMessage({ action: Actions.RESTORE_PAGE, tabId: tab.id });
      setStatus("");
    });
    $("warn-keys").addEventListener("click", () => switchTab("api"));
    // プロバイダカードのヘッダクリックで選択 (キー入力欄とは独立。入力は再生成しない)
    document.querySelectorAll(".pc-head").forEach((h) => {
      h.addEventListener("click", () => selectProvider(h.dataset.provider));
    });

    // 全ページ自動翻訳トグル: 永続フラグ(autoTranslate)を保存してから現在ページを翻訳/復元する。
    // ワンショットの「翻訳」ボタン/FAB/右クリックとは独立 — このトグルだけが autoTranslate を変える。
    $("auto-translate").addEventListener("change", async (e) => {
      const on = e.target.checked;
      await save({ autoTranslate: on }); // 保存の確定を待ってから翻訳/復元 (background が storage を再読みするため)
      const tab = await getActiveTab();
      if (!tab) return;
      setStatus(on ? msg("statusStarting", "Starting…") : "");
      chrome.runtime.sendMessage({ action: on ? Actions.TRANSLATE_PAGE : Actions.RESTORE_PAGE, tabId: tab.id });
    });

    // 翻訳タブに移動した各オプションは変更で即保存する (キー保存ボタンとは独立)
    $("show-fab").addEventListener("change", (e) => { save({ showFab: e.target.checked }); $("fab-opacity").disabled = !e.target.checked; });
    // 不透明度スライダー: input でラベルを即時更新 (保存はせず軽量に), change (ドラッグ確定) で保存する
    $("fab-opacity").addEventListener("input", (e) => { $("fab-opacity-val").textContent = e.target.value + "%"; });
    $("fab-opacity").addEventListener("change", (e) => save({ fabOpacity: Number(e.target.value) / 100 }));
    $("sel-translate").addEventListener("change", (e) => { save({ selectionTranslate: e.target.checked }); $("sel-mode").disabled = !e.target.checked; });
    $("sel-mode").addEventListener("change", (e) => save({ selectionMode: e.target.value }));
    // ショートカット変更: ブラウザのコマンド設定ページを開く (Chrome=extensions/shortcuts / Firefox=about:addons)
    $("sel-shortcut").addEventListener("click", () => {
      const ff = typeof navigator !== "undefined" && /firefox/i.test(navigator.userAgent || "");
      const url = ff ? "about:addons" : "chrome://extensions/shortcuts";
      try { chrome.tabs.create({ url }); } catch (_e) { /* noop */ }
    });

    // モデル更新ボタン: 明示的にこのときだけ最新モデルを取得する
    $("refresh-models").addEventListener("click", () => loadModels(true));

    setupQuickTranslate();
    bindKeyAutosave();
    document.querySelectorAll(".toggle").forEach((btn) => {
      btn.addEventListener("click", () => {
        const inp = document.getElementById(btn.getAttribute("data-target"));
        const showing = inp.type === "text";
        inp.type = showing ? "password" : "text";
        btn.textContent = msg(showing ? "optShow" : "optHide", showing ? "表示" : "隠す");
      });
    });

    chrome.runtime.onMessage.addListener((m, sender) => {
      if (!m || m.action !== Actions.TRANSLATION_PROGRESS) return;
      if (sender && sender.tab) return; // content フレーム直送(生)は無視。background が集約した進捗のみ受ける
      // auto-translate トグルは永続 autoTranslate 設定を表す。ワンショット翻訳の進捗で勝手に切り替えない。
      if (m.state === "progress") setStatus("");          // 進捗は FAB のシマーで示すので popup は無表示
      else if (m.state === "done") setStatus(m.partial ? msg("statusPartial", "Partly untranslated (rate limit / overload). Wait and retry.") : msg("statusDone", "Done"));
      else if (m.state === "error") setStatus(errorText(m.detail));
      else if (m.state === "restored") setStatus("");
      else if (m.state === "skipped") setStatus(msg("statusSameLang", "Page is already in the target language"));
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
