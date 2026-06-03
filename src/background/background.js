"use strict";

/**
 * background.js — Service Worker (メッセージディスパッチ + LLM 代理 fetch + usage 集計)
 *
 * 責務:
 *   1. 設定 (chrome.storage.local) の取得/保存・正規化
 *   2. content からの TRANSLATE_BATCH を受け、設定の provider で各社 LLM API へ代理 fetch
 *      → API キーをページ文脈に晒さず、host_permissions により CORS を回避
 *   3. レスポンスから usage を抽出し tokenUsage[YYYY-MM][provider] に加算 (永続・月次)
 *   4. popup/options/contextMenus からの TRANSLATE_PAGE / RESTORE_PAGE で translator.js を
 *      オンデマンド注入 (scripting.executeScript) し、翻訳/復元を指示
 */

// 依存ライブラリ読み込み (Chrome: importScripts / Firefox: manifest の background.scripts で既読)
if (typeof importScripts === "function") {
  importScripts("/src/lib/actions.js", "/src/lib/lang.js", "/src/lib/model-pricing.js", "/src/lib/providers.js");
}

(function () {
  // ---- 設定の取得/保存 ----
  async function getSettings() {
    const data = await chrome.storage.local.get(StorageKeys.SETTINGS);
    return SettingsSchema.normalize(data[StorageKeys.SETTINGS]);
  }

  // 設定の SW メモリキャッシュ。TRANSLATE_BATCH/IMAGE で API キーを bg 側から引く際に使う
  // (content が送ってくる設定の apiKeys は信用せず、ここの保管値で上書きする)。storage 変更で破棄。
  let settingsMem = null;
  async function getSettingsCached() {
    if (!settingsMem) settingsMem = await getSettings();
    return settingsMem;
  }
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[StorageKeys.SETTINGS]) settingsMem = null;
    });
  } catch (_e) { /* noop */ }

  // content script に渡す設定から秘密情報 (apiKeys) を除く。
  // content は翻訳対象テキストを TRANSLATE_BATCH で送るだけで、API キーは bg 側でのみ保持・使用する。
  function publicSettings(s) {
    const { apiKeys: _omit, ...rest } = s;
    return rest;
  }

  async function saveSettings(raw) {
    const normalized = SettingsSchema.normalize(raw);
    await chrome.storage.local.set({ [StorageKeys.SETTINGS]: normalized });
    settingsMem = normalized; // キャッシュを最新化 (onChanged より先に確定させる)
    return normalized;
  }

  // ---- メモリ集約: BATCH_TUNING / TOKEN_USAGE を SW メモリに保持し、毎バッチの storage I/O を
  //      クリティカルパスから外す。永続化はデバウンスで集約する。
  //      (10 並列ワーカーが同一キーを read-modify-write してロストアップデートする競合も解消)
  let tuningMem = null;   // { [provider]: BatchTuner state }
  let usageMem = null;    // tokenUsage store
  let persistTimer = null;
  async function ensureMem() {
    if (tuningMem && usageMem) return;
    const data = await chrome.storage.local.get([StorageKeys.BATCH_TUNING, StorageKeys.TOKEN_USAGE]);
    if (!tuningMem) tuningMem = data[StorageKeys.BATCH_TUNING] || {};
    if (!usageMem) usageMem = data[StorageKeys.TOKEN_USAGE] || {};
  }
  function schedulePersist() {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      const patch = {};
      if (tuningMem) patch[StorageKeys.BATCH_TUNING] = tuningMem;
      if (usageMem) patch[StorageKeys.TOKEN_USAGE] = usageMem;
      try { chrome.storage.local.set(patch); } catch (_e) { /* noop */ }
    }, 2000);
  }

  // ---- トークン使用量の記録 / 取得 (メモリ上で集約・同期) ----
  function recordUsage(providerId, usage) {
    if (!usage || (!usage.input && !usage.output)) return;
    const monthKey = TokenUsage.currentMonthKey();
    usageMem = TokenUsage.pruneUsage(TokenUsage.addUsage(usageMem || {}, monthKey, providerId, usage.input, usage.output), 12);
    schedulePersist();
  }

  // ---- 翻訳代理 fetch (核心) ----
  async function translateBatch(settings, texts) {
    const providerId = settings.provider;
    const provider = Providers.get(providerId);
    const apiKey = (settings.apiKeys && settings.apiKeys[providerId]) || "";
    const requiresKey = !provider || provider.requiresKey !== false;
    if (requiresKey && !apiKey) return { ok: false, error: "no_api_key", provider: providerId };

    // バッチ非対応プロバイダ (MyMemory 等) は 1 テキストずつ並列処理する
    if (provider && provider.batch === false) {
      return translateEach(settings, provider, texts, apiKey);
    }

    await ensureMem(); // 初回のみ storage 読み込み (以降は同期メモリ操作)
    const model = (settings.models && settings.models[providerId]) || undefined;
    let req;
    try {
      req = ProviderApi.buildRequest(providerId, {
        texts,
        sourceLang: settings.sourceLang,
        targetLang: settings.targetLang,
        model,
        apiKey,
      });
    } catch (e) {
      return { ok: false, error: "build", message: String((e && e.message) || e) };
    }

    const t0 = Date.now();
    let res;
    try {
      res = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: JSON.stringify(req.body),
      });
    } catch (e) {
      return { ok: false, error: "network", message: String((e && e.message) || e) };
    }
    const durationMs = Date.now() - t0;

    if (!res.ok) {
      let detail = "";
      try { detail = await res.text(); } catch (_e) { /* noop */ }
      if (res.status === 429) updateBatchTuning(providerId, texts.length, durationMs, true);
      return {
        ok: false, error: "http", status: res.status, message: detail.slice(0, 300),
        nextBatchSize: currentBatchSizeFor(providerId),
      };
    }

    let json;
    try {
      json = await res.json();
    } catch (_e) {
      return { ok: false, error: "parse" };
    }

    const translations = ProviderApi.parseResponse(providerId, json);
    const usage = ProviderApi.parseUsage(providerId, json);
    recordUsage(providerId, usage); // 同期メモリ更新 (storage await を critical path から除去)
    // バッチサイズを最速方向へ自動調整し、次のサイズを translator に返す
    const nextBatchSize = updateBatchTuning(providerId, texts.length, durationMs, false);
    return { ok: true, translations, usage, nextBatchSize };
  }

  // バッチ非対応プロバイダ用: 1 テキストずつ並列 GET (MyMemory など)。usage は集計しない。
  async function translateEach(settings, provider, texts, apiKey) {
    const providerId = provider.id;
    const maxBytes = provider.maxBytes || Infinity;
    const encoder = new TextEncoder();
    const translations = new Array(texts.length);
    const CONCURRENCY = 8;  // MyMemory(無料 NMT)の実効同時リクエスト数。translator 側はこのとき直列(1)
    let cursor = 0;
    let firstError = null;

    async function worker() {
      while (cursor < texts.length) {
        const i = cursor++;
        const text = texts[i];
        // 長すぎるテキストは送らず原文のまま (translator 側でスキップ扱いになる)
        if (encoder.encode(text).length > maxBytes) { translations[i] = text; continue; }
        let req;
        try {
          req = ProviderApi.buildRequest(providerId, {
            texts: [text], sourceLang: settings.sourceLang, targetLang: settings.targetLang, apiKey,
          });
        } catch (e) {
          firstError = firstError || { error: "build", message: String((e && e.message) || e) };
          translations[i] = text;
          continue;
        }
        try {
          const res = await fetch(req.url, { method: req.method, headers: req.headers });
          if (!res.ok) { firstError = firstError || { error: "http", status: res.status }; translations[i] = text; continue; }
          const json = await res.json();
          // MyMemory は本文 200 でも responseStatus に実ステータス (403/429 等) を入れる
          const rs = Number(json && json.responseStatus);
          if (rs && rs !== 200) {
            firstError = firstError || { error: "quota", status: rs, message: String((json && json.responseDetails) || "") };
            translations[i] = text;
            continue;
          }
          const parsed = ProviderApi.parseResponse(providerId, json);
          translations[i] = (parsed && parsed[0]) || text;
        } catch (e) {
          firstError = firstError || { error: "network", message: String((e && e.message) || e) };
          translations[i] = text;
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, texts.length || 1) }, worker));
    if (firstError) return Object.assign({ ok: false, translations }, firstError);
    return { ok: true, translations, usage: { input: 0, output: 0 } };
  }

  // ---- バッチサイズ自動学習 (メモリ上で同期更新。永続化はデバウンス) ----
  function updateBatchTuning(providerId, textCount, durationMs, rateLimited) {
    tuningMem = tuningMem || {};
    tuningMem[providerId] = BatchTuner.next(tuningMem[providerId], { textCount, durationMs, rateLimited });
    schedulePersist();
    return BatchTuner.sizeOf(tuningMem[providerId]);
  }
  function currentBatchSizeFor(providerId) {
    return BatchTuner.sizeOf((tuningMem || {})[providerId]);
  }

  // ---- モデル一覧の動的取得 (新しい順10件 + 価格) ----
  // Anthropic の /v1/models は日付入りスナップショット ID (claude-sonnet-4-5-20250929) しか返さないため、
  // 日付サフィックスを剥がしてエイリアス (claude-sonnet-4-5 = 常に最新スナップショットを指す有効な ID) 化する。
  function anthropicAlias(id) {
    return String(id)
      .replace(/-\d{4}-\d{2}-\d{2}$/, "")  // -2025-09-29
      .replace(/-\d{8}$/, "")               // -20250929
      .replace(/-latest$/, "");
  }
  function filterTranslationModels(providerId, models) {
    const include = {
      openai: /^(gpt-|o1|o3|chatgpt-)/i,
      anthropic: /^claude-/i,
      gemini: /gemini-/i,
      xai: /^grok-/i,
    }[providerId];
    const exclude = /embed|whisper|tts|dall-e|image|audio|realtime|moderation|search|guard/i;
    // 日付/版数が入った ID (例 -2024-08-06 / -20241022 / -0709) は除外し、エイリアス (latest 等) を優先。
    // ただし Anthropic は日付入り ID しか配信しないため除外せず、後段の normalizeModelList でエイリアス化+重複排除する。
    const dated = /\d{4}-\d{2}-\d{2}|\d{6,}|[-_]\d{4}$/;
    return models.filter((m) =>
      m && m.id &&
      (!include || include.test(m.id)) &&
      !exclude.test(m.id) &&
      (providerId === "anthropic" || !dated.test(m.id)));
  }
  // Anthropic は日付入り ID をエイリアス化し、同一エイリアスは新しい順で先頭(最新)だけ残す。
  function normalizeModelList(providerId, models) {
    if (providerId !== "anthropic") return models;
    const seen = new Set();
    const out = [];
    for (const m of models) {
      const id = anthropicAlias(m.id);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, created: m.created });
    }
    return out;
  }
  function geminiVerKey(id) {
    const m = String(id).match(/(\d+)\.(\d+)/);
    let v = m ? Number(m[1]) * 100 + Number(m[2]) : 0;
    if (/flash/i.test(id)) v += 5;   // 翻訳向きの flash を pro より優先
    if (/lite|8b/i.test(id)) v -= 1;
    return v;
  }
  function sortNewest(providerId, models) {
    const arr = models.slice();
    if (providerId === "gemini") arr.sort((a, b) => geminiVerKey(b.id) - geminiVerKey(a.id));
    else arr.sort((a, b) => (b.created || 0) - (a.created || 0));
    return arr;
  }
  async function fetchModels(providerId, apiKey) {
    const req = ProviderApi.buildModelsRequest(providerId, apiKey);
    if (!req) return { ok: false, error: "unsupported" };
    let res;
    try { res = await fetch(req.url, { headers: req.headers }); }
    catch (e) { return { ok: false, error: "network", message: String((e && e.message) || e) }; }
    if (!res.ok) return { ok: false, error: "http", status: res.status };
    let json;
    try { json = await res.json(); } catch (_e) { return { ok: false, error: "parse" }; }
    const sorted = sortNewest(providerId, filterTranslationModels(providerId, ProviderApi.parseModels(providerId, json)));
    const normalized = normalizeModelList(providerId, sorted);
    const top = normalized.slice(0, 10).map((m) => ({ id: m.id, price: ModelPricing.lookup(m.id) }));
    const cacheAll = (await chrome.storage.local.get(StorageKeys.MODELS_CACHE))[StorageKeys.MODELS_CACHE] || {};
    cacheAll[providerId] = { models: top, fetchedAt: Date.now() };
    await chrome.storage.local.set({ [StorageKeys.MODELS_CACHE]: cacheAll });
    await migrateModel(providerId, top);
    return { ok: true, models: top };
  }
  // 選択中モデルが新リストから消えたら最新(先頭)へ載せ替える (要件: マイグレーション)
  async function migrateModel(providerId, models) {
    if (!models || !models.length) return;
    const data = await chrome.storage.local.get(StorageKeys.SETTINGS);
    const settings = SettingsSchema.normalize(data[StorageKeys.SETTINGS]);
    if (!models.some((m) => m.id === settings.models[providerId])) {
      settings.models[providerId] = models[0].id;
      await chrome.storage.local.set({ [StorageKeys.SETTINGS]: SettingsSchema.normalize(settings) });
    }
  }
  async function getModelsForProvider(providerId, force) {
    const provider = Providers.get(providerId);
    if (!provider || provider.batch === false) return { ok: true, models: [] };
    const settings = await getSettings();
    const apiKey = (settings.apiKeys && settings.apiKeys[providerId]) || "";
    const cacheAll = (await chrome.storage.local.get(StorageKeys.MODELS_CACHE))[StorageKeys.MODELS_CACHE] || {};
    const cached = cacheAll[providerId];
    // 静的な既定モデルを価格付きで返すフォールバック
    const fallback = () => ({
      ok: true, fallback: true,
      models: (provider.models || []).map((id) => ({ id, price: ModelPricing.lookup(id) })),
    });
    // API 通信 (取得) は force のときだけ = 「API キー入力後」と「モデル更新ボタン押下時」のみ。
    // それ以外 (provider 切替 / popup 起動) は通信せず、キャッシュ or 同梱フォールバックを表示する。
    if (!force) {
      if (cached) return { ok: true, models: cached.models, cached: true };
      return fallback();
    }
    if (!apiKey) return fallback();
    const result = await fetchModels(providerId, apiKey);
    if (!result.ok) {
      if (cached) return { ok: true, models: cached.models, cached: true, stale: true };
      return Object.assign(fallback(), { error: result.error });
    }
    return result;
  }

  // ---- 画像内テキストの翻訳 (vision・オプション) ----
  async function blobToBase64(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }
  async function translateImage(settings, imageUrl) {
    const providerId = settings.provider;
    const provider = Providers.get(providerId);
    if (!provider || provider.batch === false) return { ok: false, error: "no_vision" }; // MyMemory は不可
    const apiKey = (settings.apiKeys && settings.apiKeys[providerId]) || "";
    if (!apiKey) return { ok: false, error: "no_api_key" };

    // 画像を取得して base64 化 (host_permissions により CORS を回避)
    let b64, mime;
    try {
      const r = await fetch(imageUrl);
      const blob = await r.blob();
      // 画像以外 (動画 video/* 等) は vision に送らない安全弁。type 空は <img> 由来として画像扱い。
      if (blob.type && blob.type.indexOf("image/") !== 0) {
        return { ok: false, error: "not_image", mime: blob.type };
      }
      mime = (blob.type && blob.type.indexOf("image/") === 0) ? blob.type : "image/png";
      b64 = await blobToBase64(blob);
    } catch (e) {
      return { ok: false, error: "image_fetch", message: String((e && e.message) || e) };
    }

    let req;
    try {
      req = ProviderApi.buildImageRequest(providerId, {
        imageBase64: b64, mimeType: mime,
        sourceLang: settings.sourceLang, targetLang: settings.targetLang,
        // 画像翻訳は速い vision モデルを優先 (無ければテキストと同じ選択モデルにフォールバック)
        model: provider.visionModel || settings.models[providerId], apiKey,
      });
    } catch (e) {
      return { ok: false, error: "build", message: String((e && e.message) || e) };
    }
    if (!req) return { ok: false, error: "unsupported" };

    let res;
    try {
      res = await fetch(req.url, { method: req.method, headers: req.headers, body: JSON.stringify(req.body) });
    } catch (e) {
      return { ok: false, error: "network", message: String((e && e.message) || e) };
    }
    if (!res.ok) {
      let detail = "";
      try { detail = await res.text(); } catch (_e) { /* noop */ }
      return { ok: false, error: "http", status: res.status, message: detail.slice(0, 300) };
    }
    let json;
    try { json = await res.json(); } catch (_e) { return { ok: false, error: "parse" }; }
    const blocks = ProviderApi.parseImageBlocks(providerId, json);
    const usage = ProviderApi.parseUsage(providerId, json);
    await ensureMem(); // 既存の月次 usage を読み込んでから加算 (cold start の初回が画像翻訳でも上書きしない)
    recordUsage(providerId, usage);
    return { ok: true, blocks };
  }

  // ---- ページ翻訳/復元の指示 ----
  // 全フレームに注入する (右サイドパネル等が iframe のときも翻訳されるように)。
  // 各フレームの translator は文字数の少ない枠(広告等)を自前のしきい値で除外する。
  // APPLY_TRANSLATE_CS は tabs.sendMessage(frameId 省略) で全フレームに配信される。
  async function injectTranslator(tabId) {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["src/lib/actions.js", "src/lib/lang.js", "src/content/translator.js"],
    });
  }

  // 翻訳 ON/OFF をグローバルに保存 (autoTranslate)。ON ならページ遷移時に fab.js が自動翻訳する。
  async function setAutoTranslate(on) {
    const data = await chrome.storage.local.get(StorageKeys.SETTINGS);
    const s = SettingsSchema.normalize(data[StorageKeys.SETTINGS]);
    if (Boolean(s.autoTranslate) !== on) {
      s.autoTranslate = on;
      await chrome.storage.local.set({ [StorageKeys.SETTINGS]: s });
    }
  }

  async function translatePage(tabId) {
    await setAutoTranslate(true);
    const settings = await getSettings();
    await injectTranslator(tabId);
    // content には API キーを渡さない (publicSettings で除去)。キーは TRANSLATE_BATCH 受信時に bg 側で引く。
    await chrome.tabs.sendMessage(tabId, { action: Actions.APPLY_TRANSLATE_CS, settings: publicSettings(settings) });
  }

  async function restorePage(tabId) {
    await setAutoTranslate(false);
    try {
      await chrome.tabs.sendMessage(tabId, { action: Actions.APPLY_RESTORE_CS });
    } catch (_e) {
      // translator 未注入のタブでは receiving end が無いので無視
    }
  }

  // ---- メッセージディスパッチ ----
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.action !== "string") return undefined;
    // 自拡張由来のみ受理 (content / popup / options はいずれも sender.id が拡張 ID)
    if (sender && sender.id && chrome.runtime.id && sender.id !== chrome.runtime.id) return undefined;

    (async () => {
      try {
        switch (msg.action) {
          case Actions.TRANSLATION_PROGRESS: {
            // content(translator) の進捗を同じタブの fab.js へ中継する
            // (content script 間は runtime.sendMessage が直接届かないため background が転送)
            const tabId = sender.tab && sender.tab.id;
            if (tabId != null) chrome.tabs.sendMessage(tabId, msg).catch(() => { /* 受信端が無ければ無視 */ });
            sendResponse({ ok: true });
            break;
          }
          case Actions.TRANSLATE_BATCH: {
            // content が送ってきた設定の apiKeys は信用せず、必ず bg 保管値で上書きする (キー漏洩防止)
            const stored = await getSettingsCached();
            const settings = msg.settings
              ? Object.assign({}, msg.settings, { apiKeys: stored.apiKeys })
              : stored;
            sendResponse(await translateBatch(settings, msg.texts || []));
            break;
          }
          case Actions.TRANSLATE_IMAGE: {
            const stored = await getSettingsCached();
            const settings = msg.settings
              ? Object.assign({}, msg.settings, { apiKeys: stored.apiKeys })
              : stored;
            sendResponse(await translateImage(settings, msg.imageUrl));
            break;
          }
          case Actions.TRANSLATE_PAGE: {
            const tabId = msg.tabId || (sender.tab && sender.tab.id);
            if (!tabId) { sendResponse({ ok: false, error: "no_tab" }); break; }
            await translatePage(tabId);
            sendResponse({ ok: true });
            break;
          }
          case Actions.RESTORE_PAGE: {
            const tabId = msg.tabId || (sender.tab && sender.tab.id);
            if (!tabId) { sendResponse({ ok: false, error: "no_tab" }); break; }
            await restorePage(tabId);
            sendResponse({ ok: true });
            break;
          }
          case Actions.APPLY_SETTINGS: {
            const saved = await saveSettings(msg.settings);
            sendResponse({ ok: true, settings: saved });
            break;
          }
          case Actions.GET_STATE: {
            sendResponse({ ok: true, settings: await getSettings() });
            break;
          }
          case Actions.GET_MODELS: {
            sendResponse(await getModelsForProvider(msg.provider, msg.force));
            break;
          }
          default:
            sendResponse({ ok: false, error: "unknown_action" });
        }
      } catch (e) {
        sendResponse({ ok: false, error: "exception", message: String((e && e.message) || e) });
      }
    })();

    return true; // 非同期 sendResponse を使うため true を返す
  });

  // ---- contextMenus (右クリックメニュー) ----
  function setupContextMenus() {
    if (!chrome.contextMenus) return;
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: "rt-translate",
        title: (chrome.i18n && chrome.i18n.getMessage("ctxTranslate")) || "Translate this page",
        contexts: ["page", "selection"],
      });
      chrome.contextMenus.create({
        id: "rt-restore",
        title: (chrome.i18n && chrome.i18n.getMessage("ctxRestore")) || "Restore original",
        contexts: ["page"],
      });
    });
  }

  chrome.runtime.onInstalled.addListener(setupContextMenus);

  if (chrome.contextMenus) {
    chrome.contextMenus.onClicked.addListener(async (info, tab) => {
      if (!tab || !tab.id) return;
      if (info.menuItemId === "rt-translate") await translatePage(tab.id);
      else if (info.menuItemId === "rt-restore") await restorePage(tab.id);
    });
  }
})();
