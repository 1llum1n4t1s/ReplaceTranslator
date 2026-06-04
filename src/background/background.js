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
  importScripts("/src/lib/actions.js", "/src/lib/lang.js", "/src/lib/model-pricing.js", "/src/lib/providers.js", "/src/lib/stream.js");
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
    await chrome.storage.local.set({
      [StorageKeys.SETTINGS]: normalized,
      // content script (fab/image-translator) が読む非機密フラグ。apiKeys を content 文脈に出さないため分離する。
      [StorageKeys.CONTENT_FLAGS]: { autoTranslate: normalized.autoTranslate, imageTranslate: normalized.imageTranslate },
    });
    settingsMem = normalized; // キャッシュを最新化 (onChanged より先に確定させる)
    return normalized;
  }

  // APPLY_SETTINGS の patch 適用を直列化する。popup が短時間に複数の patch を送ると、各ハンドラが
  // 同じ base を読んでから順に上書きし先の変更を取りこぼす (lost update)。チェーンで 1 件ずつ直列化し、
  // base には直前の save が同期確定した settingsMem を使うことで、後続 patch が最新値に積み増しされる。
  let settingsWriteChain = Promise.resolve();
  function applySettingsPatch(patch) {
    const run = async () => {
      const base = settingsMem || await getSettings(); // 直前の saveSettings が settingsMem を確定済み
      return saveSettings(Object.assign({}, base, patch));
    };
    // 直前の patch が成功/失敗どちらでも次を最新 base から直列適用する (then の両ハンドラに run を渡す)
    const next = settingsWriteChain.then(run, run);
    settingsWriteChain = next.catch(() => {}); // チェーンは常に解決させ、1 件の失敗で後続を詰まらせない
    return next; // 呼び出し側にはこの patch 自身の結果 (保存後の設定) / 失敗を返す
  }

  // 既存インストール移行 / SW 再起動時に CONTENT_FLAGS を用意する (未作成なら SETTINGS から導出)。
  async function ensureContentFlags() {
    const cur = (await chrome.storage.local.get(StorageKeys.CONTENT_FLAGS))[StorageKeys.CONTENT_FLAGS];
    if (cur) return;
    const s = await getSettings();
    await chrome.storage.local.set({ [StorageKeys.CONTENT_FLAGS]: { autoTranslate: s.autoTranslate, imageTranslate: s.imageTranslate } });
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

  // ---- in-flight fetch 中断 (復元/再翻訳で無駄なネットワーク・課金枠を切る) ----
  // タブ単位で進行中の AbortController を保持し、translatePage/restorePage 開始時に中断する。
  const inflightByTab = new Map(); // tabId -> Set<AbortController>
  function trackController(tabId, controller) {
    if (tabId == null) return () => {};
    let set = inflightByTab.get(tabId);
    if (!set) { set = new Set(); inflightByTab.set(tabId, set); }
    set.add(controller);
    return () => { const s = inflightByTab.get(tabId); if (s) { s.delete(controller); if (!s.size) inflightByTab.delete(tabId); } };
  }
  function abortTab(tabId) {
    const set = inflightByTab.get(tabId);
    if (!set) return;
    for (const c of set) { try { c.abort(); } catch (_e) { /* noop */ } }
    inflightByTab.delete(tabId);
  }

  // ---- 翻訳代理 fetch (核心) ----
  async function translateBatch(settings, texts, signal) {
    const providerId = settings.provider;
    const provider = Providers.get(providerId);
    const apiKey = (settings.apiKeys && settings.apiKeys[providerId]) || "";
    const requiresKey = !provider || provider.requiresKey !== false;
    if (requiresKey && !apiKey) return { ok: false, error: "no_api_key", provider: providerId };

    // バッチ非対応プロバイダ (MyMemory 等) は 1 テキストずつ並列処理する
    if (provider && provider.batch === false) {
      return translateEach(settings, provider, texts, apiKey, signal);
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
        signal,
      });
    } catch (e) {
      if (e && e.name === "AbortError") return { ok: false, error: "aborted" };
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
    // 訳文数が要求数と不一致 (出力切れ / フォーマット崩れ) のときはバッチ全体を不完全とみなし、
    // ok:true で確定させない。取りこぼしたノードが未翻訳のまま「処理済み」にされるのを防ぎ、リトライ可能にする。
    if (!Array.isArray(translations) || translations.length !== texts.length) {
      return {
        ok: false, error: "incomplete",
        got: Array.isArray(translations) ? translations.length : 0, want: texts.length,
        nextBatchSize: currentBatchSizeFor(providerId),
      };
    }
    const usage = ProviderApi.parseUsage(providerId, json);
    recordUsage(providerId, usage); // 同期メモリ更新 (storage await を critical path から除去)
    // バッチサイズを最速方向へ自動調整し、次のサイズを translator に返す
    const nextBatchSize = updateBatchTuning(providerId, texts.length, durationMs, false);
    return { ok: true, translations, usage, nextBatchSize };
  }

  // OpenAI/xAI を SSE ストリーミングで翻訳し、確定要素ごとに onPartial(index, text) を呼ぶ (早出し)。
  // 戻り値: 非stream と同形の結果、stream 不可/通信失敗時は null (呼び出し側が非stream にフォールバック)。
  // 翻訳の真実は蓄積した完全 JSON の extractTranslations。partial がズレても最終結果が確定し直す。
  async function translateBatchStream(settings, texts, signal, onPartial) {
    const providerId = settings.provider;
    if (providerId !== "openai" && providerId !== "xai") return null; // stream 対応は OpenAI/xAI のみ
    const apiKey = (settings.apiKeys && settings.apiKeys[providerId]) || "";
    if (!apiKey) return { ok: false, error: "no_api_key", provider: providerId };
    const model = (settings.models && settings.models[providerId]) || undefined;
    let req;
    try {
      req = ProviderApi.buildRequest(providerId, {
        texts, sourceLang: settings.sourceLang, targetLang: settings.targetLang, model, apiKey, stream: true,
      });
    } catch (_e) { return null; }
    await ensureMem();
    const t0 = Date.now();
    let res;
    try {
      res = await fetch(req.url, { method: req.method, headers: req.headers, body: JSON.stringify(req.body), signal });
    } catch (e) {
      if (e && e.name === "AbortError") return { ok: false, error: "aborted" };
      return null; // 通信失敗 → 非stream で再試行させる
    }
    if (!res.ok || !res.body || typeof res.body.getReader !== "function") return null; // stream 弾かれ → フォールバック

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const extractor = StreamParse.createTranslationsExtractor();
    let sseBuf = "";       // 行バッファ (SSE は \n\n 区切り。1 行ずつ処理)
    let content = "";      // 蓄積した delta (最終の完全パース用 = 真実)
    let usageObj = null;
    let idx = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        sseBuf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = sseBuf.indexOf("\n")) >= 0) {
          const line = sseBuf.slice(0, nl).trim();
          sseBuf = sseBuf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          let obj;
          try { obj = JSON.parse(data); } catch (_e) { continue; }
          const delta = ProviderApi.streamDelta(providerId, obj);
          if (delta) {
            content += delta;
            for (const text of extractor.feed(delta)) { if (onPartial) { try { onPartial(idx, text); } catch (_e) { /* noop */ } } idx++; }
          }
          if (obj.usage) usageObj = obj;
        }
      }
    } catch (e) {
      if (e && e.name === "AbortError") return { ok: false, error: "aborted" };
      // 途中で切れても蓄積済み content で完全パースを試みる (下へ)
    }
    const translations = ProviderApi.extractTranslations(content);
    if (!Array.isArray(translations) || translations.length !== texts.length) {
      // stream は通ったが出力が不完全。非stream にフォールバックすると二重課金なので incomplete を返し translator にリトライさせる。
      return { ok: false, error: "incomplete", got: Array.isArray(translations) ? translations.length : 0, want: texts.length, nextBatchSize: currentBatchSizeFor(providerId) };
    }
    const usage = usageObj ? ProviderApi.parseUsage(providerId, usageObj) : null;
    if (usage) recordUsage(providerId, usage);
    const nextBatchSize = updateBatchTuning(providerId, texts.length, Date.now() - t0, false);
    return { ok: true, translations, usage: usage || { input: 0, output: 0 }, nextBatchSize };
  }

  // バッチ非対応プロバイダ用: 1 テキストずつ並列 GET (MyMemory など)。usage は集計しない。
  async function translateEach(settings, provider, texts, apiKey, signal) {
    const providerId = provider.id;
    const maxBytes = provider.maxBytes || Infinity;
    const encoder = new TextEncoder();
    const translations = new Array(texts.length);
    const CONCURRENCY = 8;  // MyMemory(無料 NMT)の実効同時リクエスト数。translator 側はこのとき直列(1)
    let cursor = 0;
    let firstError = null;     // 表示用 (最初に起きた種別)
    let providerError = null;  // provider 全体の失敗 (build/http/quota/network)。too_long(局所スキップ)とは区別し fatal 判定に使う

    async function worker() {
      while (cursor < texts.length) {
        const i = cursor++;
        const text = texts[i];
        // 長すぎるテキストは送れない。原文を返すと「翻訳成功」に見えてしまうため too_long エラーを立てる
        // (Quick Translate は原文を成功表示せずエラー文言を出す。ページ翻訳は部分適用で原文のまま残る)。
        if (encoder.encode(text).length > maxBytes) {
          firstError = firstError || { error: "too_long", maxBytes };
          translations[i] = text;
          continue;
        }
        let req;
        try {
          req = ProviderApi.buildRequest(providerId, {
            texts: [text], sourceLang: settings.sourceLang, targetLang: settings.targetLang, apiKey,
          });
        } catch (e) {
          const err = { error: "build", message: String((e && e.message) || e) };
          providerError = providerError || err; firstError = firstError || err;
          translations[i] = text;
          continue;
        }
        try {
          const res = await fetch(req.url, { method: req.method, headers: req.headers, signal });
          if (!res.ok) { const err = { error: "http", status: res.status }; providerError = providerError || err; firstError = firstError || err; translations[i] = text; continue; }
          const json = await res.json();
          // MyMemory は本文 200 でも responseStatus に実ステータス (403/429 等) を入れる
          const rs = Number(json && json.responseStatus);
          if (rs && rs !== 200) {
            const err = { error: "quota", status: rs, message: String((json && json.responseDetails) || "") };
            providerError = providerError || err; firstError = firstError || err;
            translations[i] = text;
            continue;
          }
          const parsed = ProviderApi.parseResponse(providerId, json);
          translations[i] = (parsed && parsed[0]) || text;
        } catch (e) {
          const err = { error: "network", message: String((e && e.message) || e) };
          providerError = providerError || err; firstError = firstError || err;
          translations[i] = text;
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, texts.length || 1) }, worker));
    if (firstError) {
      // 1 件でも訳せていれば部分成功として translations を返す (呼び出し側が適用)。
      // allFailed(=translator が fatal でページ全体を停止) は provider 全体の失敗 (quota/auth/network) かつ全件未訳のときだけ立てる。
      // 全件 too_long のような局所スキップでは translations(原文) を返し、短い後続ノードを巻き添えで止めない。
      const anySuccess = translations.some((t, i) => t !== texts[i]);
      if (!anySuccess && providerError) return Object.assign({ ok: false, allFailed: true }, providerError);
      return Object.assign({ ok: false, translations }, firstError);
    }
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
      openai: /^(gpt-|o[1-9]|chatgpt-)/i,  // o1/o3 に限らず o4-mini 等 o 系全世代を拾う (buildRequest/tuneReasoning の /^o[1-9]/ と一致)
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
    await migrateModel(providerId, top, normalized.map((m) => m.id));
    return { ok: true, models: top };
  }
  // 選択中モデルが「取得した全モデル」に無いときだけ最新(先頭)へ載せ替える (要件: マイグレーション)。
  // 判定は表示用 top10 ではなく allIds (全取得リスト) で行い、ユーザーが選んだ古め/安めの有効モデル
  // (top10 圏外) を勝手に最新へ差し替えないようにする。
  async function migrateModel(providerId, models, allIds) {
    if (!models || !models.length) return;
    const valid = (allIds && allIds.length) ? allIds : models.map((m) => m.id);
    const data = await chrome.storage.local.get(StorageKeys.SETTINGS);
    const settings = SettingsSchema.normalize(data[StorageKeys.SETTINGS]);
    if (!valid.includes(settings.models[providerId])) {
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
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB: 巨大画像でメモリspike/過大リクエストを防ぐ上限
  function base64FromBytes(bytes) {
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  // IPv4 がループバック/プライベート/リンクローカル/CGNAT かどうか (先頭2オクテットで判定)
  function isPrivateV4(a, b) {
    return a === 0 || a === 127 || a === 10 ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127);
  }
  // ページが任意に指定できる imageUrl を外部 LLM へ中継する前の SSRF/内部リソース流出対策。
  // http/https 以外のスキームと、localhost / プライベート IP / リンクローカル宛先を拒否する。
  function isForbiddenImageUrl(rawUrl) {
    let u;
    try { u = new URL(rawUrl); } catch (_e) { return true; }
    // https のみ許可 (http を弾く)。MV3 に DNS 解決 API が無く公開ホスト名→プライベートIP の解決を検証できないため、
    // plain-http の内部ターゲット (http://internal, http://127.0.0.1 等) を入口で遮断して DNS リバインディングを軽減する。
    if (u.protocol !== "https:") return true;
    let h = u.hostname.toLowerCase();
    if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1); // IPv6 リテラル
    if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
    // IPv6 リテラル (":" を含む) のときだけ範囲判定する。fc/fd を裸の startsWith で見ると "fcbarcelona.com" 等の
    // 通常ホストを誤ブロックするため、先頭ヘクステットを数値化して fe80::/10 と fc00::/7 全域を弾く。
    if (h.includes(":")) {
      if (h === "::1" || h === "::") return true;          // loopback / unspecified
      const hx = parseInt(h.split(":")[0], 16);
      if (Number.isFinite(hx)) {
        if ((hx & 0xffc0) === 0xfe80) return true;         // fe80::/10 link-local (fe80–febf)
        if ((hx & 0xfe00) === 0xfc00) return true;         // fc00::/7 ULA (fc00–fdff)
      }
    }
    // IPv4-mapped IPv6 (::ffff:127.0.0.1 / ::ffff:7f00:1) は埋め込み IPv4 へ展開してプライベート判定する
    const mapped = h.match(/^::ffff:(.+)$/i);
    if (mapped) {
      const tail = mapped[1];
      const dq = tail.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
      if (dq) { if (isPrivateV4(+dq[1], +dq[2])) return true; }
      else {
        const hx = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
        if (hx) { const hi = parseInt(hx[1], 16); if (isPrivateV4((hi >> 8) & 0xff, hi & 0xff)) return true; }
      }
    }
    const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m && isPrivateV4(+m[1], +m[2])) return true;
    return false;
  }

  // 先頭バイト (マジックナンバー) から画像 mime を判定する。Content-Type 欠落時の安全弁。非画像は null。
  function sniffImageMime(b) {
    if (!b || b.length < 4) return null;
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
    if (b[0] === 0x42 && b[1] === 0x4d) return "image/bmp";
    if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
        b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
    return null;
  }

  async function translateImage(settings, imageUrl, signal) {
    const providerId = settings.provider;
    const provider = Providers.get(providerId);
    if (!provider || provider.batch === false) return { ok: false, error: "no_vision" }; // MyMemory は不可
    const apiKey = (settings.apiKeys && settings.apiKeys[providerId]) || "";
    if (!apiKey) return { ok: false, error: "no_api_key" };
    // 危険な fetch 先 (内部/ローカル/特殊スキーム) は取得も中継もしない
    if (isForbiddenImageUrl(imageUrl)) return { ok: false, error: "forbidden_target" };

    // 画像を取得して base64 化 (host_permissions により CORS を回避)
    let b64, mime;
    try {
      const r = await fetch(imageUrl, { signal });
      // リダイレクト後の最終 URL も検証する (公開 URL → 30x で localhost/private へ飛ばす SSRF を防ぐ。
      // 取得済みでも、禁止先なら base64 化せず LLM へ送らないことで内部コンテンツの外部流出を止める)。
      if (r.url && r.url !== imageUrl && isForbiddenImageUrl(r.url)) return { ok: false, error: "forbidden_target" };
      const cl = Number(r.headers.get("content-length") || 0);
      if (cl && cl > MAX_IMAGE_BYTES) return { ok: false, error: "image_too_large", size: cl };
      const blob = await r.blob();
      if (blob.size > MAX_IMAGE_BYTES) return { ok: false, error: "image_too_large", size: blob.size };
      const bytes = new Uint8Array(await blob.arrayBuffer());
      // Content-Type が image/* のときだけ送る。欠落時はマジックバイトで実体が画像と確認できたものだけ許可し、
      // それ以外 (動画 / Content-Type 未設定の内部レスポンス等) は送らない (任意コンテンツの外部流出を防ぐ)。
      if (blob.type && blob.type.indexOf("image/") === 0) {
        mime = blob.type;
      } else if (!blob.type) {
        mime = sniffImageMime(bytes);
        if (!mime) return { ok: false, error: "not_image", mime: "" };
      } else {
        return { ok: false, error: "not_image", mime: blob.type };
      }
      b64 = base64FromBytes(bytes);
    } catch (e) {
      if (e && e.name === "AbortError") return { ok: false, error: "aborted" };
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
      res = await fetch(req.url, { method: req.method, headers: req.headers, body: JSON.stringify(req.body), signal });
    } catch (e) {
      if (e && e.name === "AbortError") return { ok: false, error: "aborted" };
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
  async function injectTranslator(tabId, withImages) {
    const files = ["src/lib/actions.js", "src/lib/lang.js", "src/content/translator.js"];
    // 画像翻訳 ON のときは image-translator も全フレームへ注入する (iframe 内の画像も訳す)。
    // 各フレーム側で本文量ガードを通すので広告枠は実際には bulk を走らせない。top フレームは
    // manifest 常駐済みだが __rtImgLoaded ガードで二重 init しない (CSS は同一規則の再適用で無害)。
    if (withImages) files.push("src/content/image-translator.js");
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files });
    if (withImages) {
      try {
        await chrome.scripting.insertCSS({ target: { tabId, allFrames: true }, files: ["src/content/image-translator.css"] });
      } catch (_e) { /* 注入不可フレーム(about:blank 等)は無視 */ }
    }
  }

  // ページ翻訳/復元はワンショット動作。全ページ自動翻訳 (autoTranslate) の永続フラグはここでは変更しない。
  // (翻訳ボタン/FAB/右クリックで 1 ページ訳しただけで、以後開く全ページが自動翻訳され課金枠を食うのを防ぐ。)
  // autoTranslate の保存は popup の「全ページ自動翻訳」トグル (APPLY_SETTINGS) でのみ行う。
  async function translatePage(tabId) {
    abortTab(tabId); // 再翻訳: このタブの前回の in-flight fetch を中断 (古い設定の無駄リクエストを切る)
    resetFrameProgress(tabId); // フレーム横断の進捗集約をリセット (watchdog も解除・新しい翻訳セッション)
    const settings = await getSettings();
    await injectTranslator(tabId, settings.imageTranslate);
    // content には API キーを渡さない (publicSettings で除去)。キーは TRANSLATE_BATCH 受信時に bg 側で引く。
    await chrome.tabs.sendMessage(tabId, { action: Actions.APPLY_TRANSLATE_CS, settings: publicSettings(settings) });
  }

  async function restorePage(tabId) {
    abortTab(tabId); // 復元: 進行中の翻訳 fetch を中断し、無駄なネットワーク/課金枠を切る
    try {
      await chrome.tabs.sendMessage(tabId, { action: Actions.APPLY_RESTORE_CS });
    } catch (_e) {
      // translator 未注入のタブでは receiving end が無いので無視
    }
  }

  // ---- フレーム横断の進捗集約 ----
  // 同一タブの複数フレーム (allFrames 注入) の進捗を集約し、参加フレームが全部 done になってから
  // グローバル done を発行する。小さい iframe / 子フレームが先に done で UI が早期確定するのを防ぐ。
  const frameProgress = new Map(); // tabId -> { active:Set<frameId>, done:Set<frameId>, timer:id|null }
  const FRAME_DONE_GRACE_MS = 8000; // 一部フレーム done 後、残りがこの時間応答しなければ離脱とみなし done を発行
  function relayProgress(tabId, msg) {
    chrome.tabs.sendMessage(tabId, msg).catch(() => { /* 受信端が無ければ無視 */ }); // FAB (content top frame)
    try { chrome.runtime.sendMessage(msg); } catch (_e) { /* popup が無ければ無視 */ }   // popup (集約済みのみ受理)
  }
  function clearFrameTimer(st) { if (st && st.timer) { clearTimeout(st.timer); st.timer = null; } }
  function resetFrameProgress(tabId) {
    clearFrameTimer(frameProgress.get(tabId));
    frameProgress.delete(tabId);
  }
  function handleFrameProgress(tabId, frameId, msg) {
    let st = frameProgress.get(tabId);
    if (!st) { st = { active: new Set(), done: new Set(), timer: null }; frameProgress.set(tabId, st); }
    switch (msg.state) {
      case "progress":
        st.done.delete(frameId);
        st.active.add(frameId);
        clearFrameTimer(st); // 新たに翻訳中のフレームが出たので done watchdog を解除
        if (st.done.size === 0 && st.active.size === 1) relayProgress(tabId, msg); // 最初の進捗で loading 表示
        break;
      case "done":
        st.active.add(frameId);
        st.done.add(frameId);
        clearFrameTimer(st);
        if ([...st.active].every((f) => st.done.has(f))) {
          relayProgress(tabId, msg); // 全参加フレーム完了
        } else {
          // 未完フレームが残る。iframe の離脱/ナビゲーションで永久に done が来ず FAB/popup が loading に
          // 張り付くのを防ぐため watchdog を張る (猶予後に done を発行)。
          st.timer = setTimeout(() => {
            const cur = frameProgress.get(tabId);
            if (cur) { cur.timer = null; relayProgress(tabId, msg); }
          }, FRAME_DONE_GRACE_MS);
        }
        break;
      case "restored":
        resetFrameProgress(tabId);
        relayProgress(tabId, msg);
        break;
      default: // error 等はどのフレーム由来でも即通知
        relayProgress(tabId, msg);
    }
  }
  // タブが閉じたら集約状態と in-flight を後始末する (離脱フレーム/タブの取り残し防止)
  try {
    chrome.tabs.onRemoved.addListener((tabId) => { resetFrameProgress(tabId); abortTab(tabId); });
  } catch (_e) { /* noop */ }

  // ---- メッセージディスパッチ ----
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.action !== "string") return undefined;
    // 自拡張由来のみ受理 (content / popup / options はいずれも sender.id が拡張 ID)
    if (sender && sender.id && chrome.runtime.id && sender.id !== chrome.runtime.id) return undefined;

    (async () => {
      try {
        switch (msg.action) {
          case Actions.TRANSLATION_PROGRESS: {
            // content(translator) 各フレームの進捗を background で集約し、FAB(content top) と popup へ中継する
            // (content script 間は runtime.sendMessage が直接届かないため background が転送)。
            const tabId = sender.tab && sender.tab.id;
            if (tabId != null) handleFrameProgress(tabId, sender.frameId || 0, msg);
            sendResponse({ ok: true });
            break;
          }
          case Actions.TRANSLATE_BATCH: {
            // content が送ってきた設定の apiKeys は信用せず、必ず bg 保管値で上書きする (キー漏洩防止)
            const stored = await getSettingsCached();
            const settings = msg.settings
              ? Object.assign({}, msg.settings, { apiKeys: stored.apiKeys })
              : stored;
            const tabId = sender.tab && sender.tab.id;
            const frameId = sender.frameId || 0;
            // 復元/再翻訳で中断できるよう AbortController をタブ単位で登録
            const controller = new AbortController();
            const untrack = trackController(tabId, controller);
            try {
              let res = null;
              // OpenAI/xAI かつ content が batchId 付き(=逐次適用に対応)なら SSE ストリームで早出しを試す
              if (msg.batchId != null && (settings.provider === "openai" || settings.provider === "xai")) {
                res = await translateBatchStream(settings, msg.texts || [], controller.signal, (index, text) => {
                  if (tabId != null) {
                    chrome.tabs.sendMessage(tabId, { action: Actions.TRANSLATE_PARTIAL, batchId: msg.batchId, index, text }, { frameId })
                      .catch(() => { /* 受信端が無ければ無視 */ });
                  }
                });
              }
              if (!res) res = await translateBatch(settings, msg.texts || [], controller.signal); // stream 非対応/失敗は非stream へ
              sendResponse(res);
            } finally { untrack(); }
            break;
          }
          case Actions.TRANSLATE_IMAGE: {
            const stored = await getSettingsCached();
            const settings = msg.settings
              ? Object.assign({}, msg.settings, { apiKeys: stored.apiKeys })
              : stored;
            const controller = new AbortController();
            const untrack = trackController(sender.tab && sender.tab.id, controller);
            try { sendResponse(await translateImage(settings, msg.imageUrl, controller.signal)); }
            finally { untrack(); }
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
            // patch (変更分) を保管中の設定にマージしてから保存する。popup が開いたまま別経路で設定が
            // 変わった場合に、古い全体設定で上書きして巻き戻すのを防ぐ (msg.settings は後方互換で受理)。
            // 連続して届く patch は applySettingsPatch がチェーンで直列化し lost update を防ぐ。
            const incoming = (msg.patch && typeof msg.patch === "object") ? msg.patch
              : ((msg.settings && typeof msg.settings === "object") ? msg.settings : {});
            const saved = await applySettingsPatch(incoming);
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

  chrome.runtime.onInstalled.addListener(() => { setupContextMenus(); ensureContentFlags().catch(() => { /* noop */ }); });
  ensureContentFlags().catch(() => { /* noop */ }); // SW 起動ごとに content 用フラグの存在を保証
  // SW 起動時に翻訳ホットパスの設定/集計メモリをプリロードし、cold start 後の最初の TRANSLATE_BATCH の
  // storage 待ち (設定 + BATCH_TUNING + TOKEN_USAGE) を消す (warm 時は settingsMem/tuningMem が効くので無害)。
  Promise.all([getSettingsCached(), ensureMem()]).catch(() => { /* noop */ });

  if (chrome.contextMenus) {
    chrome.contextMenus.onClicked.addListener(async (info, tab) => {
      if (!tab || !tab.id) return;
      if (info.menuItemId === "rt-translate") await translatePage(tab.id);
      else if (info.menuItemId === "rt-restore") await restorePage(tab.id);
    });
  }
})();
