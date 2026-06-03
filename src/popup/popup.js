"use strict";

/**
 * popup.js — ポップアップ UI (2タブ: 翻訳 / キー)
 *
 * - API設定タブ: サービス切替(状態) + キー入力 / 動的モデル一覧(新しい順10件 + コスト相対バー)
 * - キータブ: API キー入力 + 内蔵検出 (バッチサイズは自動学習に委ねるため UI なし)
 * モデルは GET_MODELS で動的取得し、選択中が消えていれば background がマイグレーションする。
 */

(function () {
  const $ = (id) => document.getElementById(id);
  const state = { settings: null };
  const msg = (k, f) => {
    try { return chrome.i18n.getMessage(k) || f; } catch (_e) { return f; }
  };

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
      name.textContent = m.id;

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
        item.title = `$${m.price.input} / $${m.price.output} per 1M tokens (in / out)`;
      } else {
        cost.textContent = msg("costUnknown", "—");
        item.title = msg("costUnknownTitle", "Price unknown");
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
    const p = Providers.get(state.settings.provider);
    if (!p || p.batch === false) { // MyMemory 等はモデル概念なし
      $("model-row").classList.add("hidden");
      return;
    }
    // 取得 (API 通信) は force のときだけ走る = 「キー入力後」と「更新ボタン押下時」。
    const btn = $("refresh-models");
    if (force && btn) { btn.disabled = true; btn.classList.add("is-spinning"); }
    chrome.runtime.sendMessage(
      { action: Actions.GET_MODELS, provider: state.settings.provider, force: Boolean(force) },
      (res) => {
        if (force && btn) { btn.disabled = false; btn.classList.remove("is-spinning"); }
        const models = (res && res.ok && res.models) ? res.models : [];
        $("model-row").classList.toggle("hidden", models.length === 0);
        if (models.length) renderModelList(models, state.settings.models[state.settings.provider]);
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
  function setLinks() {
    $("link-openai").href = Providers.openai.keyUrl;
    $("link-anthropic").href = Providers.anthropic.keyUrl;
    $("link-gemini").href = Providers.gemini.keyUrl;
    $("link-xai").href = Providers.xai.keyUrl;
  }
  function reflectKeys() {
    const s = state.settings;
    $("key-openai").value = s.apiKeys.openai || "";
    $("key-anthropic").value = s.apiKeys.anthropic || "";
    $("key-gemini").value = s.apiKeys.gemini || "";
    $("key-xai").value = s.apiKeys.xai || "";
    $("key-mymemory").value = s.apiKeys.mymemory || "";
  }
  function collectKeys() {
    return {
      apiKeys: {
        openai: $("key-openai").value.trim(),
        anthropic: $("key-anthropic").value.trim(),
        gemini: $("key-gemini").value.trim(),
        xai: $("key-xai").value.trim(),
        mymemory: $("key-mymemory").value.trim(),
      },
    };
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
    const fields = [
      ["key-openai", "openai"], ["key-anthropic", "anthropic"], ["key-gemini", "gemini"],
      ["key-xai", "xai"], ["key-mymemory", "mymemory"],
    ];
    fields.forEach(([id, provider]) => {
      $(id).addEventListener("blur", () => {
        const val = $(id).value.trim();
        const cur = (state.settings.apiKeys && state.settings.apiKeys[provider]) || "";
        if (val === cur) return; // 変化なしは保存もチェック表示もしない
        save(collectKeys(), () => {
          flashSaved(id);
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
    $("image-translate").checked = Boolean(state.settings.imageTranslate);
    $("builtin-detector").checked = Boolean(state.settings.useBuiltinDetector);
    renderProviderList();
    $("source").value = state.settings.sourceLang;
    $("target").value = state.settings.targetLang;
    updateKeyWarning();
    reflectKeys();
    loadModels(false);
  }

  function save(patch, after) {
    state.settings = Object.assign({}, state.settings, patch);
    chrome.runtime.sendMessage({ action: Actions.APPLY_SETTINGS, settings: state.settings }, (res) => {
      if (res && res.settings) state.settings = res.settings;
      if (after) after();
    });
  }

  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }
  const setStatus = (t) => { $("status").textContent = t || ""; };

  function init() {
    applyI18n();
    setLinks();
    fillLangSelect($("source"), true);
    fillLangSelect($("target"), false);

    chrome.runtime.sendMessage({ action: Actions.GET_STATE }, (res) => {
      if (res && res.ok) {
        state.settings = res.settings;
        reflect();
      }
    });

    document.querySelectorAll(".tab").forEach((t) => {
      t.addEventListener("click", () => switchTab(t.dataset.tab));
    });
    moveInk(document.querySelector(".tab.is-active"));

    $("source").addEventListener("change", (e) => save({ sourceLang: e.target.value }));
    $("target").addEventListener("change", (e) => save({ targetLang: e.target.value }));

    $("translate").addEventListener("click", async () => {
      const tab = await getActiveTab();
      if (!tab) return;
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

    // 全ページ自動翻訳トグル: ON でこのページを翻訳 + グローバル保存、OFF で復元
    $("auto-translate").addEventListener("change", async (e) => {
      const on = e.target.checked;
      const tab = await getActiveTab();
      if (!tab) return;
      setStatus(on ? msg("statusStarting", "Starting…") : "");
      chrome.runtime.sendMessage({ action: on ? Actions.TRANSLATE_PAGE : Actions.RESTORE_PAGE, tabId: tab.id });
    });

    // 翻訳タブに移動した各オプションは変更で即保存する (キー保存ボタンとは独立)
    $("image-translate").addEventListener("change", (e) => save({ imageTranslate: e.target.checked }));
    $("builtin-detector").addEventListener("change", (e) => save({ useBuiltinDetector: e.target.checked }));

    // モデル更新ボタン: 明示的にこのときだけ最新モデルを取得する
    $("refresh-models").addEventListener("click", () => loadModels(true));

    bindKeyAutosave();
    document.querySelectorAll(".toggle").forEach((btn) => {
      btn.addEventListener("click", () => {
        const inp = document.getElementById(btn.getAttribute("data-target"));
        const showing = inp.type === "text";
        inp.type = showing ? "password" : "text";
        btn.textContent = msg(showing ? "optShow" : "optHide", showing ? "表示" : "隠す");
      });
    });

    chrome.runtime.onMessage.addListener((m) => {
      if (!m || m.action !== Actions.TRANSLATION_PROGRESS) return;
      if (m.state === "progress") {
        // 進捗は FAB の処理中リングで示すので、popup には「翻訳中」テキストを出さない
        setStatus("");
      } else if (m.state === "done") {
        setStatus(msg("statusDone", "Done"));
        $("auto-translate").checked = true;
      } else if (m.state === "error") {
        setStatus(msg("statusError", "Error"));
      } else if (m.state === "restored") {
        setStatus("");
        $("auto-translate").checked = false;
      }
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
