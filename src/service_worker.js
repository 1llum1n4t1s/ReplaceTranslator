"use strict";

/**
 * service_worker.js — Service Worker (メッセージディスパッチ + LLM 代理 fetch + usage 集計)
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
  importScripts("/src/lib/actions.js", "/src/lib/lang.js", "/src/lib/model-pricing.js", "/src/lib/providers.js", "/src/lib/stream.js", "/src/lib/settings-sync.js");
}

(function () {
  // ---- 設定の取得/保存 ----
  let persistentTranslationCacheEnabled = false;
  async function getSettings() {
    const data = await chrome.storage.local.get(StorageKeys.SETTINGS);
    const settings = SettingsSchema.normalize(data[StorageKeys.SETTINGS]);
    persistentTranslationCacheEnabled = settings.persistentTranslationCache === true;
    return settings;
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
      if (area === "local" && changes[StorageKeys.SETTINGS]) {
        settingsMem = null;
        refreshActiveAutoTranslateSiteMenu();
      }
      if (area === "sync" && Object.keys(changes).some(key => key.startsWith(SettingsSync.PREFIX))) {
        receiveSyncedSettings().catch(() => {});
      }
    });
  } catch (_e) { /* noop */ }

  // ---- fetch タイムアウト ----
  // 全 LLM/画像 fetch にリクエスト上限を課す。これが無いと half-open 接続や無応答ストリームで fetch/reader が
  // 永久にハングし、ワーカーが stuck → flush の flushing ガードが張り付き → ページ翻訳が無言で永久停止する。
  // タブ単位 abort signal と timeout を AbortSignal.any で合成し、どちらの中断でも fetch が確実に reject する。
  // timeout 中断は TimeoutError(name) で reject するため各 catch の AbortError(=ユーザー中断) 判定に当たらず、
  // network 系エラー(=translator の transient リトライ対象)へ落ちる(D-003 の error 種別を増やさない最小設計)。
  const FETCH_TIMEOUT_MS = 60000; // 1 リクエスト上限。バッチ(≤100短文)/vision は通常数秒で完了するので 60s は十分な天井
  function withTimeout(signal) {
    const to = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    return signal ? AbortSignal.any([signal, to]) : to;
  }

  // content script に渡す設定から秘密情報 (apiKeys) を除く。
  // content は翻訳対象テキストを TRANSLATE_BATCH で送るだけで、API キーは bg 側でのみ保持・使用する。
  function publicSettings(s) {
    const { apiKeys: _omit, ...rest } = s;
    return rest;
  }

  // content script (fab/image-translator) が読む非機密フラグだけを抽出する。saveSettings と
  // ensureContentFlags の両所で使い、フラグ追加時の片側更新漏れ (= content 側だけ欠落) を防ぐ。
  function contentFlagsOf(s) {
    // imageCapable: 選択中プロバイダが画像翻訳(vision)対応か。content(image-translator) がこれを見て、
    // 非対応プロバイダ選択中はホバーの「訳」ボタンを出さない (クリックしても no_vision になるだけのため)。
    // selectionMode: 選択翻訳の表示方法 (bubble=浮遊バブル / inline=対訳差し込み)。content(selection-translator) が読む。
    // fabOpacity: フローティングボタンの不透明度 (乗数)。content(fab) が --fab-alpha に載せて透け具合を反映する。
    return { autoTranslate: s.autoTranslate, showFab: s.showFab, showImageButton: s.showImageButton, imageCapable: Providers.supportsImage(s.provider), selectionMode: s.selectionMode, fabOpacity: s.fabOpacity };
  }

  // provider の API キーを取り出す (未設定は "")。複数ハンドラで使う共通アクセサ。
  function keyFor(settings, providerId) {
    return (settings.apiKeys && settings.apiKeys[providerId]) || "";
  }

  function reasoningEffortFor(settings, providerId, model) {
    const byProvider = settings.reasoningEfforts && settings.reasoningEfforts[providerId];
    return byProvider && typeof byProvider[model] === "string" ? byProvider[model] : undefined;
  }

  // content が送ってきた設定の apiKeys は信用せず、必ず bg 保管値で上書きする (キー漏洩防止)。
  // この不変条件を 1 箇所に集約し、TRANSLATE_BATCH / TRANSLATE_IMAGE での書き忘れ事故を防ぐ。
  function resolveSettings(incoming, stored) {
    if (!incoming) return stored;
    // provider/models/apiKeys は SW 保管値を真実とする (content/page 由来の値で課金プロバイダ/モデルを
    // 勝手に選ばせない内部不変条件)。sourceLang/targetLang だけは translator が auto 解決したページ言語を
    // 運ぶので incoming を残す (ページ言語ベースの翻訳元解決を壊さない)。
    return Object.assign({}, incoming, {
      provider: stored.provider,
      models: stored.models,
      apiKeys: stored.apiKeys,
    });
  }

  // HTTP エラー応答の本文を安全に読む (失敗吸収 + 300 字に切り詰め)。各 fetch のエラー message 生成で共用。
  async function readDetail(res) {
    // 600 字確保: Gemini 等の 429 本文は quota_id ("...PerDayPerProjectPerModel-FreeTier" 等) が
    // 後方にあることがあり、content 側の quotaScope 判定 (日次 vs 分次) に必要なため広めに取る。
    try { return (await res.text()).slice(0, 600); } catch (_e) { return ""; }
  }

  async function saveSettings(raw, syncState) {
    const normalized = SettingsSchema.normalize(raw);
    const previousCachePreference = persistentTranslationCacheEnabled;
    await chrome.storage.local.set({
      [StorageKeys.SETTINGS]: normalized,
      // content script (fab/image-translator) が読む非機密フラグ。apiKeys を content 文脈に出さないため分離する。
      [StorageKeys.CONTENT_FLAGS]: contentFlagsOf(normalized),
      ...(syncState ? { [SettingsSync.STATE_KEY]: syncState,
        [SettingsSync.STATUS_KEY]: normalized.syncSettings ? "pending" : "off" } : {}),
    });
    if (syncState) settingsSyncMem = structuredClone(syncState);
    // 設定保存が成功する前に true にすると、storage 書き込み失敗時でも in-flight 翻訳が原文を
    // 永続化し得る。必ず保存成功後に preference を切り替える。
    persistentTranslationCacheEnabled = normalized.persistentTranslationCache === true;
    settingsMem = normalized; // キャッシュを最新化 (onChanged より先に確定させる)
    if (previousCachePreference !== persistentTranslationCacheEnabled) {
      await syncPersistentTranslationCache(persistentTranslationCacheEnabled);
    }
    return normalized;
  }

  // APPLY_SETTINGS の patch 適用を直列化する。popup が短時間に複数の patch を送ると、各ハンドラが
  // 同じ base を読んでから順に上書きし先の変更を取りこぼす (lost update)。チェーンで 1 件ずつ直列化し、
  // base には直前の save が同期確定した settingsMem を使うことで、後続 patch が最新値に積み増しされる。
  let settingsWriteChain = Promise.resolve();
  let settingsSyncMem = null;
  let settingsSyncGeneration = 0;

  async function loadSettingsSync() {
    if (!settingsSyncMem) {
      const data = await chrome.storage.local.get(SettingsSync.STATE_KEY);
      settingsSyncMem = SettingsSync.restore(data[SettingsSync.STATE_KEY], crypto.randomUUID());
    }
    return structuredClone(settingsSyncMem);
  }

  function queueSettings(run) {
    const next = settingsWriteChain.then(run, run);
    settingsWriteChain = next.catch(() => {});
    return next;
  }

  async function synchronizeSettings() {
    const base = settingsMem || await getSettingsCached();
    if (!base.syncSettings) return base;
    const generation = settingsSyncGeneration;
    try {
      // ワーカー終了後も再送できるよう、通信前に次回実行を確保する。
      await chrome.alarms.create(SettingsSync.ALARM, { delayInMinutes: 1 });
      const state = await loadSettingsSync();
      const remote = await chrome.storage.sync.get([...SettingsSync.KEYS, ...(!state.joined ? SettingsSync.LEGACY_KEYS : state.legacyCleanup)]);
      if (generation !== settingsSyncGeneration) return base;
      SettingsSync.join(state, base, remote);
      const projected = SettingsSync.project(state, base);
      const desired = SettingsSync.pack(state);
      const uploads = Object.fromEntries(Object.entries(desired).filter(([key, value]) => !SettingsSync.equal(value, remote[key])));
      state.legacyCleanup = SettingsSync.LEGACY_KEYS.filter(key => state.legacyCleanup.includes(key) || Object.hasOwn(remote, key));
      const legacy = state.legacyCleanup;
      // 勝者と未送信状態を同じlocal.setへ保存してから、設定を適用・送信する。
      state.pending = Object.keys(uploads).length > 0 || legacy.length > 0;
      const changed = !SettingsSync.equal(state, settingsSyncMem) || !SettingsSync.equal(projected, base);
      if (!changed && !state.pending) {
        const status = await chrome.storage.local.get(SettingsSync.STATUS_KEY);
        if (status[SettingsSync.STATUS_KEY] !== "synced") await chrome.storage.local.set({ [SettingsSync.STATUS_KEY]: "synced" });
        await chrome.alarms.clear(SettingsSync.ALARM);
        return base;
      }
      if (changed) await saveSettings(projected, state);
      if (generation !== settingsSyncGeneration) return settingsMem || base;
      SettingsSync.checkQuota(desired);
      if (Object.keys(uploads).length) await chrome.storage.sync.set(uploads);
      if (generation !== settingsSyncGeneration) return settingsMem || base;
      // 旧試作形式は初回移行時だけ読み、V2保存成功後に撤去する。
      if (legacy.length) await chrome.storage.sync.remove(legacy);
      state.pending = false;
      state.legacyCleanup = [];
      await chrome.storage.local.set({ [SettingsSync.STATE_KEY]: state, [SettingsSync.STATUS_KEY]: "synced" });
      settingsSyncMem = state;
      await chrome.alarms.clear(SettingsSync.ALARM);
    } catch (_e) {
      // localの更新は確定済みでも同期失敗はあり得る。元のstampを保持して再試行する。
      await chrome.storage.local.set({ [SettingsSync.STATUS_KEY]: "error" }).catch(() => {});
      await chrome.alarms.create(SettingsSync.ALARM, { delayInMinutes: 1 }).catch(() => {});
    }
    return settingsMem || base;
  }

  function receiveSyncedSettings() {
    return queueSettings(synchronizeSettings);
  }

  function applySettingsPatch(patch) {
    const changedAt = Date.now(); // 送信時でなく、利用者の変更を受け付けた時刻
    if (patch && typeof patch === "object" && Object.hasOwn(patch, "syncSettings")) settingsSyncGeneration++;
    const run = async () => {
      const base = settingsMem || await getSettingsCached();
      const p = typeof patch === "function" ? await patch(base) : patch; // 関数 patch は最新 base を見てマージ内容を決める
      if (p == null) return base; // 変更不要 (例: migrateModel が載せ替え不要と判断) → 保存しない
      const next = SettingsSchema.mergePatch(base, p);
      let state;
      let syncChanged = false;
      if (next.syncSettings || base.syncSettings) {
        state = await loadSettingsSync();
        if (next.syncSettings !== base.syncSettings) state = { ...state, joined: false, records: {}, pending: false };
        if (next.syncSettings) {
          syncChanged = SettingsSync.recordChanges(state, base, next, changedAt) || !base.syncSettings;
          state.pending ||= syncChanged;
        }
      }
      await saveSettings(next, syncChanged || next.syncSettings !== base.syncSettings ? state : undefined);
      if (!next.syncSettings && base.syncSettings) await chrome.alarms.clear(SettingsSync.ALARM).catch(() => {});
      if (syncChanged) return synchronizeSettings();
      return next;
    };
    return queueSettings(run);
  }

  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === SettingsSync.ALARM) receiveSyncedSettings().catch(() => {});
  });

  // 既存インストール移行 / SW 再起動時に CONTENT_FLAGS を用意する (未作成なら SETTINGS から導出)。
  async function ensureContentFlags() {
    const cur = (await chrome.storage.local.get(StorageKeys.CONTENT_FLAGS))[StorageKeys.CONTENT_FLAGS];
    // contentFlagsOf の返すキー集合を「揃っているべきフラグ」の単一の真実とする (フラグを足すたびに
    // ここの条件を手で増やさずに済む。列挙漏れ = 旧フォーマットが補完されず content がデフォルト動作に
    // 黙って固着する、を防ぐ)。キー集合は値に依存しないので空オブジェクトから導く (storage の追加読みは不要)。
    const keys = Object.keys(contentFlagsOf({}));
    if (cur && keys.every((k) => k in cur)) return; // 全フラグが揃っていれば既存値を保つ
    // 未作成 / 旧フォーマット (新フラグ欠落 = 更新前のインストール) は SETTINGS から導出して補完する。
    const s = await getSettings();
    await chrome.storage.local.set({ [StorageKeys.CONTENT_FLAGS]: contentFlagsOf(s) });
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
  // 保留中の tuning/usage をまとめて storage へ書き出す (デバウンス満了時・SW suspend 直前に呼ぶ)。
  function flushPersist() {
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    const patch = {};
    if (tuningMem) patch[StorageKeys.BATCH_TUNING] = tuningMem;
    if (usageMem) patch[StorageKeys.TOKEN_USAGE] = usageMem;
    try { chrome.storage.local.set(patch); } catch (_e) { /* noop */ }
  }
  function schedulePersist() {
    if (persistTimer) return;
    persistTimer = setTimeout(flushPersist, 2000);
  }
  // MV3 SW は無活動で suspend される。デバウンス保留中の最新増分 (直近 1 ページ分の usage 集計/バッチ学習) が
  // 取りこぼされないよう、suspend 直前に flush する。onSuspend 非対応環境 (Firefox 等) は無視。
  try {
    if (chrome.runtime && chrome.runtime.onSuspend) {
      chrome.runtime.onSuspend.addListener(() => { if (persistTimer) flushPersist(); });
    }
  } catch (_e) { /* noop */ }

  // ---- トークン使用量の記録 (SW 専有の usageMem にインプレース加算・デバウンス永続化) ----
  // usageMem は SW 専有の可変 state。毎成功バッチで呼ばれるため、store 全体の deep-copy/再構築を避け
  // インプレース加算 (O(1)) する。間引き (pruneUsage) は新しい月キーを初めて作ったときだけ走らせる。
  function recordUsage(providerId, usage) {
    if (!usage || (!usage.input && !usage.output)) return;
    if (!usageMem) usageMem = {};
    const monthKey = TokenUsage.currentMonthKey();
    const isNewMonth = !usageMem[monthKey];
    if (isNewMonth) usageMem[monthKey] = {};
    const slot = usageMem[monthKey][providerId] || (usageMem[monthKey][providerId] = { input: 0, output: 0 });
    slot.input += Number(usage.input) || 0;
    slot.output += Number(usage.output) || 0;
    if (isNewMonth) usageMem = TokenUsage.pruneUsage(usageMem, 12); // 月が変わったときだけ古い月を間引く
    schedulePersist();
  }

  // ---- in-flight fetch 中断 (復元/再翻訳で無駄なネットワーク・課金枠を切る) ----
  // 操作種別ごとに AbortController を所有する。ページ再翻訳で画像OCRまで中断しないよう、
  // page/image の cancellation group を分離し、restore/tab close だけが全 group を止める。
  const inflightByTab = new Map(); // tabId -> Map<group, Set<AbortController>>
  function trackController(tabId, controller, group = "page") {
    if (tabId == null) return () => {};
    let groups = inflightByTab.get(tabId);
    if (!groups) { groups = new Map(); inflightByTab.set(tabId, groups); }
    let set = groups.get(group);
    if (!set) { set = new Set(); groups.set(group, set); }
    set.add(controller);
    return () => {
      const current = inflightByTab.get(tabId);
      const currentSet = current && current.get(group);
      if (!currentSet) return;
      currentSet.delete(controller);
      if (!currentSet.size) current.delete(group);
      if (!current.size) inflightByTab.delete(tabId);
    };
  }
  function abortGroup(tabId, group) {
    const groups = inflightByTab.get(tabId);
    const set = groups && groups.get(group);
    if (!set) return;
    for (const c of set) { try { c.abort(); } catch (_e) { /* noop */ } }
    groups.delete(group);
    if (!groups.size) inflightByTab.delete(tabId);
  }
  function abortTab(tabId) {
    const groups = inflightByTab.get(tabId);
    if (!groups) return;
    for (const set of groups.values()) {
      for (const c of set) { try { c.abort(); } catch (_e) { /* noop */ } }
    }
    inflightByTab.delete(tabId);
  }

  // ---- タブ単位の翻訳/復元 世代トークン (translate ⇄ restore の順序競合を断つ) ----
  // translatePage と restorePage は別々の async メッセージハンドラで、タブ単位の直列化が無い。
  // autoTranslate ON でページを開くと fab が TRANSLATE_PAGE を送り、translatePage が injectTranslator
  // (executeScript・低速) を await している"最中"にユーザーが popup で OFF にすると、restorePage が先に
  // APPLY_RESTORE_CS を送って原文へ戻しても、後から translatePage の await が解けて APPLY_TRANSLATE_CS を
  // 後着送信し、startTranslate が新しい runId を採番して再翻訳してしまう (restore() の runId++ は旧ループしか
  // 止められず後発 translate を打ち消せない)。結果「OFF にしたのに今のタブが翻訳済みのまま」になる。
  // 対策: タブ単位の世代番号を採番し、translatePage は APPLY_TRANSLATE_CS を送る直前に「自分の世代が最新か」を
  // 確認する。await 中に restorePage (や別の translatePage) が世代を進めていたら送信を取り止める = stale な
  // 再翻訳を発生源で断つ。Map は tabId キーなので裏タブには一切干渉しない (今のタブだけ確実に意図どおりへ)。
  const tabGen = new Map(); // tabId -> number (translate/restore の最新意図の世代)
  const pageSessions = new Map(); // tabId -> { id, settings } (1 page run = 1 immutable provider/key snapshot)
  // MV3 SW は翻訳途中でも suspend/再起動され得る。pageSessions がメモリだけだと再起動で消え、注入済み
  // translator の後続 TRANSLATE_BATCH (スクロール/動的追加分) が全部 stale_session 拒否になり「ページの
  // 残りが訳されない」まま復旧しない。storage.session (ディスク非永続・拡張コンテキスト限定・ブラウザ終了で
  // 消える) へミラーし、SW 再起動後の最初の参照で復元する。tabGen も session.id 以上へシードして、再起動後の
  // 新しい翻訳指示が旧セッションより小さい世代を採番しないようにする。
  const PAGE_SESSIONS_KEY = "pageSessionsV1";
  let pageSessionsLoaded = null; // 復元は一度だけ (Promise 共有で並行呼び出しを一本化)
  function ensurePageSessions() {
    if (!pageSessionsLoaded) {
      pageSessionsLoaded = (async () => {
        try {
          const saved = (await chrome.storage.session.get(PAGE_SESSIONS_KEY))[PAGE_SESSIONS_KEY] || {};
          for (const [k, s] of Object.entries(saved)) {
            const tabId = Number(k);
            if (!Number.isInteger(tabId) || !s || typeof s.id !== "number") continue;
            if (!pageSessions.has(tabId)) pageSessions.set(tabId, s);
            if ((tabGen.get(tabId) || 0) < s.id) tabGen.set(tabId, s.id);
          }
        } catch (_e) { /* storage.session 不可な環境は従来どおりメモリのみで動く */ }
      })();
    }
    return pageSessionsLoaded;
  }
  function persistPageSessions() {
    try {
      const obj = {};
      for (const [tabId, s] of pageSessions) obj[tabId] = s;
      const p = chrome.storage.session.set({ [PAGE_SESSIONS_KEY]: obj });
      if (p && p.catch) p.catch(() => { /* noop */ });
    } catch (_e) { /* noop */ }
  }

  // ---- 翻訳キャッシュ (browser-session + 明示 opt-in の永続層) ----
  // content 側の Map は同じ frame/run だけで消えるため、同一 origin の再読込・別 tab/frame で同じ原文を再送する。
  // storage.session の bounded L2 は常時、storage.local の同形コピーはユーザーが明示 ON にしたときだけ使う。
  // raw text は HTTP(S) origin 内だけで共有し、provider/model/lang/prompt version を key に含めて設定変更時の
  // 古い訳文利用を防ぐ。1文字でも変われば key が変わるため、誤字修正後に旧訳を返さない。
  const TRANSLATION_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const TRANSLATION_CACHE_MAX_ENTRIES = 2000;
  const TRANSLATION_CACHE_MAX_CHARS = 2000000;
  const TRANSLATION_CACHE_MAX_ENTRY_CHARS = 50000;
  const translationCache = new Map(); // key -> { translation, expiresAt, chars }
  let translationCacheChars = 0;
  let translationCacheLoaded = null;
  let persistentTranslationCacheLoaded = null;
  let translationCacheReady = false;
  let translationCachePersistTimer = null;
  let translationCacheWriteChain = Promise.resolve();

  function trimTranslationCache() {
    let trimmed = false;
    while (translationCache.size > TRANSLATION_CACHE_MAX_ENTRIES || translationCacheChars > TRANSLATION_CACHE_MAX_CHARS) {
      const oldest = translationCache.keys().next().value;
      if (oldest === undefined) break;
      const entry = translationCache.get(oldest);
      translationCache.delete(oldest);
      translationCacheChars -= entry ? entry.chars : 0;
      trimmed = true;
    }
    return trimmed;
  }

  function importTranslationCacheRecords(stored) {
    const normalized = TranslationBatch.normalizeCacheRecords(
      stored, Date.now(), TRANSLATION_CACHE_MAX_ENTRY_CHARS, TRANSLATION_CACHE_TTL_MS
    );
    let changedMap = false;
    for (const [key, translation, expiresAt] of normalized.records) {
      const previous = translationCache.get(key);
      // 同じ完全一致 key が両層にあるときは、後に保存された (expiry が遠い) 訳文を採用する。
      if (previous && previous.expiresAt >= expiresAt) {
        if (previous.expiresAt !== expiresAt || previous.translation !== translation) changedMap = true;
        continue;
      }
      if (previous) translationCacheChars -= previous.chars;
      const chars = key.length + translation.length;
      translationCache.delete(key);
      translationCache.set(key, { translation, expiresAt, chars });
      translationCacheChars += chars;
      changedMap = true;
    }
    return { needsRewrite: normalized.needsRewrite || trimTranslationCache(), changedMap };
  }

  async function ensureTranslationCache(includePersistent = false) {
    if (!translationCacheLoaded) {
      translationCacheLoaded = (async () => {
        try {
          const stored = (await chrome.storage.session.get(StorageKeys.TRANSLATION_CACHE))[StorageKeys.TRANSLATION_CACHE];
          const imported = importTranslationCacheRecords(stored);
          // TTL 切れ・不正・重複・上限超過を読み飛ばした場合は session 側も遅延清掃する。
          if (imported.needsRewrite) scheduleTranslationCachePersist();
        } catch (_e) { /* storage.session 不可なら SW の生存中だけ Map cache として動く */ }
        translationCacheReady = true;
      })();
    }
    await translationCacheLoaded;
    if (includePersistent && !persistentTranslationCacheLoaded) {
      persistentTranslationCacheLoaded = (async () => {
        try {
          const stored = (await chrome.storage.local.get(StorageKeys.PERSISTENT_TRANSLATION_CACHE))[StorageKeys.PERSISTENT_TRANSLATION_CACHE];
          const imported = importTranslationCacheRecords(stored);
          // browser 再起動直後は永続層だけにあるため session へも反映する。両層の差異/期限切れも同時清掃。
          if (imported.needsRewrite || imported.changedMap) scheduleTranslationCachePersist();
        } catch (_e) { /* storage.local 読み込み失敗時も session/Map cache は継続 */ }
      })();
    }
    if (includePersistent && persistentTranslationCacheLoaded) await persistentTranslationCacheLoaded;
  }

  function persistTranslationCache() {
    if (!translationCacheReady) return Promise.resolve();
    const records = Array.from(translationCache, ([key, entry]) => [key, entry.translation, entry.expiresAt]);
    const write = async () => {
      try { await chrome.storage.session.set({ [StorageKeys.TRANSLATION_CACHE]: records }); } catch (_e) { /* noop */ }
      // 実行時点の preference を見る。OFF と競合した古い予約書き込みが local を復活させないため。
      if (persistentTranslationCacheEnabled) {
        try { await chrome.storage.local.set({ [StorageKeys.PERSISTENT_TRANSLATION_CACHE]: records }); } catch (_e) { /* quota 等でも翻訳自体は継続 */ }
      }
    };
    const next = translationCacheWriteChain.then(write, write);
    translationCacheWriteChain = next.catch(() => {});
    return next;
  }

  function scheduleTranslationCachePersist() {
    if (translationCachePersistTimer) return;
    translationCachePersistTimer = setTimeout(() => {
      translationCachePersistTimer = null;
      persistTranslationCache();
    }, 2000);
  }

  async function syncPersistentTranslationCache(enabled) {
    if (enabled) {
      await ensureTranslationCache(true);
      await persistTranslationCache(); // 現在の session cache も opt-in 時点で永続層へ反映する
      return;
    }
    if (translationCachePersistTimer) {
      clearTimeout(translationCachePersistTimer);
      translationCachePersistTimer = null;
    }
    // 起動時 load / 既存 write の完了後に clear+remove し、古い非同期処理が永続 cache を復活させない。
    if (translationCacheLoaded) await translationCacheLoaded.catch(() => {});
    if (persistentTranslationCacheLoaded) await persistentTranslationCacheLoaded.catch(() => {});
    await translationCacheWriteChain.catch(() => {});
    translationCache.clear();
    translationCacheChars = 0;
    translationCacheReady = true;
    const remove = async () => {
      await Promise.allSettled([
        chrome.storage.session.remove(StorageKeys.TRANSLATION_CACHE),
        chrome.storage.local.remove(StorageKeys.PERSISTENT_TRANSLATION_CACHE),
      ]);
    };
    const next = translationCacheWriteChain.then(remove, remove);
    translationCacheWriteChain = next.catch(() => {});
    await next;
    persistentTranslationCacheLoaded = null;
  }

  function getCachedTranslation(key) {
    const entry = key && translationCache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      translationCache.delete(key);
      translationCacheChars -= entry.chars;
      scheduleTranslationCachePersist();
      return undefined;
    }
    // Map の insertion order を LRU として使う。hit のたびの storage 書き込みは不要。
    translationCache.delete(key);
    translationCache.set(key, entry);
    return entry.translation;
  }

  function putCachedTranslation(key, translation) {
    if (!key || typeof translation !== "string" || !translation) return;
    const chars = key.length + translation.length;
    if (chars > TRANSLATION_CACHE_MAX_ENTRY_CHARS) return;
    const old = translationCache.get(key);
    if (old) translationCacheChars -= old.chars;
    translationCache.delete(key);
    translationCache.set(key, { translation, expiresAt: Date.now() + TRANSLATION_CACHE_TTL_MS, chars });
    translationCacheChars += chars;
    trimTranslationCache();
    scheduleTranslationCachePersist();
  }

  function translationCacheScope(sender, quick) {
    if (quick || (sender.tab && sender.tab.incognito)) return null;
    try {
      const url = new URL(sender.url || (sender.tab && sender.tab.url) || "");
      // 同一 origin の別ページで孤立した同文ラベルを誤再利用しない。query/hash は一時値・個人識別子を
      // 含みやすく cache を過分割するため除き、pathname までをページ範囲とする。
      return url.protocol === "http:" || url.protocol === "https:" ? url.origin + url.pathname : null;
    } catch (_e) { return null; }
  }

  function bumpTabGen(tabId) {
    if (tabId == null) return 0;
    const g = (tabGen.get(tabId) || 0) + 1;
    tabGen.set(tabId, g);
    return g;
  }

  // ---- provider/API-key 単位の中央バックプレッシャ ----
  // content script の並列度は frame ごとに存在するため、ここで全 frame/tab を合算する。
  // maxConcurrency 未指定の provider は content 側の既定値と同じ 24 を上限にする。
  const providerQueues = new Map(); // provider+key -> { active, limit, waiters[] }
  const DEFAULT_PROVIDER_CONCURRENCY = 24;
  function providerLimit(providerId) {
    const provider = Providers.get(providerId);
    const cap = provider && Number(provider.maxConcurrency);
    if (cap && cap > 0) return cap;
    // batch 不可 provider (MyMemory) は 1 TRANSLATE_BATCH = translateEach の内部 8 並列 GET に展開される。
    // 既定 24 スロットだと最悪 ~192 GET が同時に走り、共有キー/IP の 429/quota 枯渇を自ら誘発するため
    // スロットは 1 に絞る (実効上限は内部並列の 8。content 側もフレーム毎に直列 = 挙動一貫)。
    if (provider && provider.batch === false) return 1;
    return DEFAULT_PROVIDER_CONCURRENCY;
  }
  function providerQueueKey(settings) {
    return `${settings.provider}:${keyFor(settings, settings.provider) || "__no_key__"}`;
  }
  function withProviderSlot(settings, signal, work) {
    const key = providerQueueKey(settings);
    let q = providerQueues.get(key);
    if (!q) { q = { active: 0, limit: providerLimit(settings.provider), waiters: [] }; providerQueues.set(key, q); }
    const take = () => {
      q.active++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        q.active--;
        pump();
      };
    };
    const pump = () => {
      while (q.active < q.limit && q.waiters.length) {
        const waiter = q.waiters.shift();
        if (waiter.cancelled) continue;
        waiter.cleanup();
        waiter.resolve(take());
      }
      if (!q.active && !q.waiters.length) providerQueues.delete(key);
    };
    return new Promise((resolve, reject) => {
      const waiter = { cancelled: false, resolve, cleanup: () => {} };
      const onAbort = () => {
        waiter.cancelled = true;
        waiter.cleanup();
        reject({ ok: false, error: "aborted" });
      };
      waiter.cleanup = () => { if (signal) signal.removeEventListener("abort", onAbort); };
      if (signal && signal.aborted) { onAbort(); return; }
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      if (q.active < q.limit) {
        waiter.cleanup();
        resolve(take());
      } else {
        q.waiters.push(waiter);
      }
    }).then(async (release) => {
      try { return await work(); } finally { release(); }
    });
  }

  // ページ翻訳は開始時の provider/model/key を固定し、content が auto 解決した言語だけを許可する。
  // 設定変更中に batch ごとへ最新設定を混ぜると、1 run 内で課金先・認証情報が切り替わるため。
  function resolvePageSessionSettings(incoming, session) {
    if (!session || !session.settings) return null;
    const base = session.settings;
    return Object.assign({}, base, {
      sourceLang: incoming && typeof incoming.sourceLang === "string" ? incoming.sourceLang : base.sourceLang,
      targetLang: incoming && typeof incoming.targetLang === "string" ? incoming.targetLang : base.targetLang,
    });
  }

  // ---- 翻訳代理 fetch (核心) ----
  async function translateBatch(settings, texts, contexts, signal, opts) {
    const providerId = settings.provider;
    const tune = !(opts && opts.tune === false); // quick translate (単発) は学習(BatchTuner)を汚さない
    const provider = Providers.get(providerId);
    const apiKey = keyFor(settings, providerId);
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
        contexts,
        sourceLang: settings.sourceLang,
        targetLang: settings.targetLang,
        model,
        apiKey,
        reasoningEffort: reasoningEffortFor(settings, providerId, model),
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
        signal: withTimeout(signal),
      });
    } catch (e) {
      if (e && e.name === "AbortError") return { ok: false, error: "aborted" };
      return { ok: false, error: "network", message: String((e && e.message) || e) };
    }
    const durationMs = Date.now() - t0;

    if (!res.ok) {
      const detail = await readDetail(res);
      const failure = {
        ok: false, error: "http", status: res.status, message: detail, provider: providerId,
      };
      if (tune && (res.status === 429 || TranslationBatch.isOversize(failure))) {
        updateBatchTuning(providerId, texts.length, durationMs, true);
      }
      return Object.assign(failure, { nextBatchSize: currentBatchSizeFor(providerId) });
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
      // 出力切れ/フォーマット崩れ = バッチが大きすぎる兆候。サイズ失敗として次サイズを縮小して返し、
      // 同じ大きさで再試行/再キューを繰り返して未翻訳のまま諦めるのを防ぐ (quick は学習を汚さない)。
      return {
        ok: false, error: "incomplete",
        got: Array.isArray(translations) ? translations.length : 0, want: texts.length,
        nextBatchSize: tune ? updateBatchTuning(providerId, texts.length, durationMs, true) : currentBatchSizeFor(providerId),
      };
    }
    const usage = ProviderApi.parseUsage(providerId, json);
    recordUsage(providerId, usage); // 同期メモリ更新 (storage await を critical path から除去)
    // バッチサイズを最速方向へ自動調整し、次のサイズを translator に返す (quick は学習せず現状サイズを返す)
    const nextBatchSize = tune ? updateBatchTuning(providerId, texts.length, durationMs, false) : currentBatchSizeFor(providerId);
    return { ok: true, translations, usage, nextBatchSize };
  }

  // OpenAI 互換社を SSE ストリーミングで翻訳し、確定要素ごとに onPartial(index, text) を呼ぶ (早出し)。
  // 戻り値: 非stream と同形の結果、stream 非対応時だけ null。送信後の通信失敗は配信結果不明として返し、
  // 同じ論理batchを非streamで二重送信しない。
  // 翻訳の真実は蓄積した完全 JSON の extractTranslations。partial がズレても最終結果が確定し直す。
  async function translateBatchStream(settings, texts, contexts, signal, onPartial) {
    const providerId = settings.provider;
    if (!ProviderApi.supportsStream(providerId)) return null; // stream 対応は OpenAI 互換社のみ
    const apiKey = keyFor(settings, providerId);
    if (!apiKey) return { ok: false, error: "no_api_key", provider: providerId };
    const model = (settings.models && settings.models[providerId]) || undefined;
    let req;
    try {
      req = ProviderApi.buildRequest(providerId, {
        texts, contexts, sourceLang: settings.sourceLang, targetLang: settings.targetLang, model, apiKey,
        reasoningEffort: reasoningEffortFor(settings, providerId, model), stream: true,
      });
    } catch (_e) { return null; }
    await ensureMem();
    const t0 = Date.now();
    let res;
    try {
      res = await fetch(req.url, { method: req.method, headers: req.headers, body: JSON.stringify(req.body), signal: withTimeout(signal) });
    } catch (e) {
      if (e && e.name === "AbortError") return { ok: false, error: "aborted" };
      return { ok: false, error: "network", ambiguous: true, provider: providerId };
    }
    if (!res.ok) {
      // 429/5xx を非stream で即再送すると失敗が二重化しスロットリングを悪化させる。HTTP エラーを返して
      // content 側のリトライ/バックオフ/サイズ縮小に委ねる (429 は学習サイズを縮小)。null フォールバックは stream 非対応時のみ。
      const detail = await readDetail(res);
      const failure = { ok: false, error: "http", status: res.status, message: detail, provider: providerId };
      if (res.status === 429 || TranslationBatch.isOversize(failure)) {
        updateBatchTuning(providerId, texts.length, Date.now() - t0, true);
      }
      return Object.assign(failure, { nextBatchSize: currentBatchSizeFor(providerId) });
    }
    if (!res.body || typeof res.body.getReader !== "function") return null; // stream 非対応レスポンス → 非stream フォールバック

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
      // 途中で切れても蓄積済み content で完全パースを試みる (下へ)。half-open の body を GC まで
      // 持ち続けないよう reader は明示破棄する (readCappedBytes と同じ後始末)。
      try { reader.cancel(); } catch (_e) { /* noop */ }
    }
    const translations = ProviderApi.extractTranslations(content);
    if (!Array.isArray(translations) || translations.length !== texts.length) {
      // stream は通ったが出力が不完全。非stream にフォールバックすると二重課金なので incomplete を返し translator にリトライさせる。
      // 出力切れはバッチが大きすぎる兆候なので、サイズ失敗として次サイズを縮小して返す (同サイズでの再試行ループを防ぐ)。
      return { ok: false, error: "incomplete", got: Array.isArray(translations) ? translations.length : 0, want: texts.length, nextBatchSize: updateBatchTuning(providerId, texts.length, Date.now() - t0, true) };
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
    const failedIndices = [];
    const CONCURRENCY = 8;  // MyMemory(無料 NMT)の実効同時リクエスト数。translator 側はこのとき直列(1)
    let cursor = 0;
    let firstError = null;     // 表示用 (最初に起きた種別)
    let providerError = null;  // provider 全体の失敗 (build/http/quota/network)。too_long(局所スキップ)とは区別し fatal 判定に使う
    let okCount = 0;           // API が応答した件数。訳文==原文(固有名詞/既に target 言語)でも成功なので translation!==input では数えない
    let giveUp = false;        // provider 全体のレート制限/拒否(429/403)を検知したら残りの無駄 GET を止める(quota 枯渇後の大量 GET 回避)

    async function worker() {
      while (cursor < texts.length) {
        const i = cursor++;
        const text = texts[i];
        // 既に provider 全体失敗(429/403)を検知済み → 送らず原文で埋める。同じキー/IP が rate-limit/拒否されている以上
        // 残りノードに GET を撃っても全て失敗するだけで、無駄リクエストが制限を悪化させ復帰を遅らせる(C2-N3)。
        if (giveUp) { failedIndices.push(i); translations[i] = text; continue; }
        // 長すぎるテキストは送れない。原文を返すと「翻訳成功」に見えてしまうため too_long エラーを立てる
        // (Quick Translate は原文を成功表示せずエラー文言を出す。ページ翻訳は部分適用で原文のまま残る)。
        if (encoder.encode(text).length > maxBytes) {
          firstError = firstError || { error: "too_long", maxBytes };
          failedIndices.push(i);
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
          failedIndices.push(i);
          translations[i] = text;
          continue;
        }
        try {
          const res = await fetch(req.url, { method: req.method, headers: req.headers, signal: withTimeout(signal) });
          if (!res.ok) { const err = { error: "http", status: res.status }; providerError = providerError || err; firstError = firstError || err; failedIndices.push(i); translations[i] = text; if (res.status === 429 || res.status === 403) giveUp = true; continue; }
          const json = await res.json();
          // MyMemory は本文 200 でも responseStatus に実ステータス (403/429 等) を入れる
          const rs = Number(json && json.responseStatus);
          if (rs && rs !== 200) {
            const err = { error: "quota", status: rs, message: String((json && json.responseDetails) || "") };
            providerError = providerError || err; firstError = firstError || err;
            failedIndices.push(i);
            translations[i] = text;
            if (rs === 429 || rs === 403 || rs >= 500) giveUp = true; // 共有キー/IP の rate-limit/拒否は残り全件で再発 → 打ち切り
            continue;
          }
          const parsed = ProviderApi.parseResponse(providerId, json);
          translations[i] = (parsed && parsed[0]) || text;
          okCount++; // responseStatus 200 で応答が返った = 成功 (訳文が原文と同一でも成功扱い)
        } catch (e) {
          const err = { error: "network", message: String((e && e.message) || e) };
          providerError = providerError || err; firstError = firstError || err;
          failedIndices.push(i);
          translations[i] = text;
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, texts.length || 1) }, worker));
    if (firstError) {
      // 1 件でも訳せていれば部分成功として translations を返す (呼び出し側が適用)。
      // allFailed(=translator が fatal でページ全体を停止) は provider 全体の失敗 (quota/auth/network) かつ全件未訳のときだけ立てる。
      // 全件 too_long のような局所スキップでは translations(原文) を返し、短い後続ノードを巻き添えで止めない。
      // 成功は okCount (API が応答した件数) で判定する。translation!==input で推測すると、同一文字列が返る
      // 正当な成功 (固有名詞/既に target 言語) を取りこぼし、別 item の失敗で誤って allFailed (=ページ全停止) になる。
      if (okCount === 0 && providerError) return Object.assign({ ok: false, allFailed: true }, providerError);
      failedIndices.sort((a, b) => a - b);
      return Object.assign({ ok: false, translations, failedIndices }, firstError);
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
  // ---- 動的価格の取得 (models.dev) ----
  // 同梱 model-pricing.js の TABLE は新モデルが出るたびに手更新が要る (更新漏れ = pickPriced が新モデルを
  // 一覧から隠す)。models.dev (オープンソースのモデルカタログ・全対象社を収録) の api.json から実勢価格を
  // 取得して ModelPricing.setDynamic へ流し込み、同梱表は取得失敗/未収録時のフォールバックに落とす。
  // 通信はモデル一覧の force 取得時のみ + PRICING_TTL_MS で抑制 (数MB 級 JSON を毎回引かない)。
  const PRICING_URL = "https://models.dev/api.json";
  const PRICING_TTL_MS = 60 * 60 * 1000; // 1h: force 連打 (キー blur 保存の連続等) での再取得を抑える
  const PRICING_VERSION = 4; // 抽出フォーマットの世代 (4 = 欠損価格の 0 化を排除)。旧世代キャッシュは TTL 内でも再取得する
  // 拡張の providerId → models.dev のプロバイダキー (fugu は変動価格で意図的に未収録・mymemory は無料)
  const PRICING_PROVIDERS = { openai: "openai", anthropic: "anthropic", gemini: "google", xai: "xai", deepseek: "deepseek", groq: "groq", openrouter: "openrouter" };
  let pricingLoaded = false;    // storage キャッシュを ModelPricing へ反映済みか (SW 起動ごとに 1 回)
  let pricingRefreshing = null; // 並行 force を 1 本の fetch に集約
  function extractPricing(json) {
    const map = {};
    for (const key of Object.values(PRICING_PROVIDERS)) {
      const models = json && json[key] && json[key].models;
      if (!models) continue;
      for (const id of Object.keys(models)) {
        const c = models[id] && models[id].cost;
        if (!c) continue;
        // Number(null)/Number("") は 0 になり欠損価格を「無料」として登録してしまう。
        // 数値型かつ有限・非負のものだけを取り込む (欠損は同梱表フォールバックに委ねる)
        const input = c.input, output = c.output;
        if (typeof input !== "number" || typeof output !== "number" ||
            !Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) continue;
        const lower = id.toLowerCase();
        const entry = { input, output };
        // 公式表示名 ("GPT-5.6 Sol" 等) も持ち帰り、popup のモデル一覧で生 ID の代わりに出す。
        // "(latest)" 装飾は剥がす (Anthropic のエイリアス ID に付く。一覧の表記を公開版と揃える)
        if (typeof models[id].name === "string" && models[id].name) {
          entry.name = models[id].name.replace(/\s*\(latest\)\s*$/i, "");
        }
        map[lower] = entry;
        // ベンダ接頭辞付き ID (openrouter の "google/gemini-…" 等) は末尾でも引けるようにする
        const slash = lower.lastIndexOf("/");
        if (slash >= 0 && !map[lower.slice(slash + 1)]) map[lower.slice(slash + 1)] = entry;
      }
    }
    return map;
  }
  async function ensurePricing(force) {
    if (pricingLoaded && !force) return; // ロード済みの非 force 呼び出しは storage を読み直さない (無駄な I/O 回避)
    const cached = (await chrome.storage.local.get(StorageKeys.PRICING_CACHE))[StorageKeys.PRICING_CACHE];
    if (!pricingLoaded) {
      pricingLoaded = true;
      if (cached && cached.map) ModelPricing.setDynamic(cached.map); // SW 再起動でもキャッシュ価格で即動く
    }
    if (!force) return;
    if (cached && cached.v === PRICING_VERSION && cached.fetchedAt && (Date.now() - cached.fetchedAt) < PRICING_TTL_MS) return;
    if (pricingRefreshing) { await pricingRefreshing; return; }
    pricingRefreshing = (async () => {
      try {
        const res = await fetch(PRICING_URL, { signal: withTimeout() });
        if (!res.ok) return;
        const map = extractPricing(await res.json());
        if (!Object.keys(map).length) return; // 形式変化等で空になったら既存キャッシュ/同梱表を保持 (壊さない)
        ModelPricing.setDynamic(map);
        await chrome.storage.local.set({ [StorageKeys.PRICING_CACHE]: { map, fetchedAt: Date.now(), v: PRICING_VERSION } });
      } catch (_e) { /* 取得失敗は同梱表フォールバックで続行 (モデル一覧表示を止めない) */ }
      finally { pricingRefreshing = null; }
    })();
    await pricingRefreshing;
  }

  // 価格ゲージを出せる (model-pricing に載っている) モデルだけを {id, price} 配列にして残す。
  // ユーザーはコスト比較できない "—" モデルを選びようがないので一覧から除く。
  // ただし 1 件も価格が付かないときは全件 (price:null 込み) を返す = 空一覧で詰むのを防ぐ保険。
  function pickPriced(ids) {
    // name は models.dev の公式表示名 (無ければ popup が ID 表示に倒す。undefined は storage 保存時に落ちる)
    const all = ids.map((id) => ({ id, price: ModelPricing.lookup(id), name: ModelPricing.displayName(id) || undefined }));
    const priced = all.filter((m) => m.price);
    return priced.length ? priced : all;
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
    // 他の全 fetch と同様に withTimeout を課す。これが無いと /models が half-open になったとき
    // resolveFallbackModel(404 自己修復) がここで永久ハングし、翻訳ホットパスが無言停止する。
    try { res = await fetch(req.url, { headers: req.headers, signal: withTimeout() }); }
    catch (e) { return { ok: false, error: "network", message: String((e && e.message) || e) }; }
    if (!res.ok) return { ok: false, error: "http", status: res.status };
    let json;
    try { json = await res.json(); } catch (_e) { return { ok: false, error: "parse" }; }
    const sorted = sortNewest(providerId, ProviderApi.filterTranslationModels(providerId, ProviderApi.parseModels(providerId, json)));
    const normalized = normalizeModelList(providerId, sorted);
    // 価格が引けるモデルだけに絞ってから上位 10 件 (圏外でも価格付きを優先して拾える)。
    const top = pickPriced(normalized.map((m) => m.id)).slice(0, 10);
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
    // SETTINGS 直書きは applySettingsPatch の直列化を迂回し、並行する APPLY_SETTINGS と lost-update を起こす。
    // 直列キュー経由 + 最新 base に対して判定/マージし、models の他 provider のエントリも保持する。
    await applySettingsPatch((base) => {
      if (valid.includes(base.models[providerId])) return null; // 選択中が有効 → 載せ替え不要 (保存しない)
      return { models: { [providerId]: models[0].id } };
    });
  }
  async function getModelsForProvider(providerId, force) {
    const provider = Providers.get(providerId);
    if (!provider || provider.batch === false) return { ok: true, models: [] };
    const settings = await getSettings();
    const apiKey = keyFor(settings, providerId);
    // 価格を pickPriced が引く前に動的価格を用意する (force 時のみ通信・それ以外は storage キャッシュ反映のみ)
    await ensurePricing(Boolean(force));
    const cacheAll = (await chrome.storage.local.get(StorageKeys.MODELS_CACHE))[StorageKeys.MODELS_CACHE] || {};
    const cached = cacheAll[providerId];
    // 静的な既定モデルを価格付きで返すフォールバック (価格ゲージを出せるものだけ)
    const fallback = () => ({
      ok: true, fallback: true,
      models: pickPriced(provider.models || []),
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

  // ---- 画像内テキストの翻訳 (vision・ホバー手動) ----
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB: 巨大画像でメモリspike/過大リクエストを防ぐ上限
  function base64FromBytes(bytes) {
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  // バイト列の先頭プレフィックスから ASCII マーカー (構造チャンクの FourCC/識別子) を探す。
  function hasMarker(bytes, marker, limit) {
    const lim = Math.min(bytes.length, limit), mlen = marker.length;
    for (let i = 0; i <= lim - mlen; i++) {
      let ok = true;
      for (let j = 0; j < mlen; j++) { if (bytes[i + j] !== marker.charCodeAt(j)) { ok = false; break; } }
      if (ok) return true;
    }
    return false;
  }

  // アニメーション画像 (アニメ GIF / アニメ WebP / APNG) 判定。createImageBitmap は先頭フレームしかデコードしない
  // ため canvas inpaint で焼くと元 <img> のアニメが静止画に隠れて固まる → これらは翻訳対象外にする (content が
  // ボタンを出さない)。構造マーカーを先頭プレフィックスから検出する (静止 GIF/WebP/PNG は素通り＝誤検出ほぼ無し)。
  function isAnimatedImage(bytes, mime) {
    if (!bytes || bytes.length < 16) return false;
    const SCAN = 65536; // マーカーは先頭付近 (WebP ANIM / APNG acTL / GIF NETSCAPE2.0・先頭フレーム群の GCE) で十分
    if (mime === "image/webp") return hasMarker(bytes, "ANIM", SCAN); // VP8X + ANIM チャンク = アニメ WebP
    if (mime === "image/png") return hasMarker(bytes, "acTL", SCAN);  // acTL = APNG の animation control
    if (mime === "image/gif") {
      if (hasMarker(bytes, "NETSCAPE2.0", SCAN)) return true; // ループ拡張 = アニメ GIF
      let gce = 0; const lim = Math.min(bytes.length, SCAN) - 2; // GCE (0x21 0xF9 0x04) が 2 個以上 = 複数フレーム
      for (let i = 0; i <= lim; i++) { if (bytes[i] === 0x21 && bytes[i + 1] === 0xF9 && bytes[i + 2] === 0x04 && ++gce >= 2) return true; }
    }
    return false;
  }

  // レスポンス body をストリームで読み、累積バイトが cap を超えたら読み取りを打ち切って null を返す。
  // Content-Length が無い/詐称のレスポンスで r.blob()(=全body をバッファ) がメモリを食うのを防ぐ。
  async function readCappedBytes(res, cap) {
    if (!res.body || typeof res.body.getReader !== "function") { // body stream 非対応環境のフォールバック
      const buf = new Uint8Array(await res.arrayBuffer());
      return buf.length > cap ? null : buf;
    }
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > cap) { try { await reader.cancel(); } catch (_e) { /* noop */ } return null; } // 上限超過で打ち切り
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }

  // 画像 URL を host_permissions 経由で取得し base64 化する (cloud vision 用)。
  // SSRF 防御 (forbidden 判定 / manual redirect / 最終 URL 再検証)・サイズ上限・MIME 確定を一括で行う。
  // 返り値: { ok:true, b64, mime } または { ok:false, error, ... }。
  async function fetchImageBytes(imageUrl, signal) {
    if (ImageRequestPolicy.isForbiddenUrl(imageUrl)) return { ok: false, error: "forbidden_target" };
    try {
      // redirect:"manual" で 30x をフォローしない。公開 URL → 30x で内部ホスト (nas / 127.0.0.1 等) へ飛ばす
      // SSRF を、フォロー前=内部ホストへリクエストが飛ぶ前に遮断する。opaqueredirect は Location を読めないので
      // 検証不能 → 拒否 (img の src は通常リダイレクト解決済みの最終 URL なので実害は小さい)。
      const r = await fetch(imageUrl, { signal: withTimeout(signal), redirect: "manual", credentials: "omit" });
      if (r.type === "opaqueredirect" || r.status === 0 || (r.status >= 300 && r.status < 400)) {
        return { ok: false, error: "forbidden_target" };
      }
      // 念のため最終 URL も検証 (manual では通常 r.url === imageUrl だが二重防御)。
      if (r.url && r.url !== imageUrl && ImageRequestPolicy.isForbiddenUrl(r.url)) return { ok: false, error: "forbidden_target" };
      // 4xx/5xx は取得失敗。CDN が 402/403/429 等でプレースホルダ画像 (image/*) を返すと以降の MIME 判定を
      // 通り抜け、エラー画像を vision へ送って課金し誤 OCR を焼き込むため、body を読む前に弾く
      // (LLM 側 fetch が全て !res.ok で早期 return しているのと契約を揃える)。error 種別は既存の
      // "http"+status を再利用し、imgErrorText の分岐と i18n を増やさない (メッセージ契約の drift 回避)。
      if (!r.ok) return { ok: false, error: "http", status: r.status };
      const cl = Number(r.headers.get("content-length") || 0);
      if (cl && cl > MAX_IMAGE_BYTES) return { ok: false, error: "image_too_large", size: cl };
      // Content-Length が無い/詐称でも、body をストリームで読みつつ累積監視し上限超過で打ち切る
      // (r.blob() は全body をバッファしてから size を見るので巨大/無限レスポンスでメモリを食う)。
      const bytes = await readCappedBytes(r, MAX_IMAGE_BYTES);
      if (!bytes) return { ok: false, error: "image_too_large" };
      // Content-Type が image/* のときだけ候補にする。欠落は許すが、最終的にはマジックバイト・寸法を
      // ImageRequestPolicy で検証し、本拡張が画像入力として扱う PNG/JPEG/GIF/WebP だけを送る。
      const ctype = (r.headers.get("content-type") || "").toLowerCase().split(";")[0].trim();
      if (ctype && !ctype.startsWith("image/")) return { ok: false, error: "not_image", mime: ctype };
      const inspected = ImageRequestPolicy.inspectBytes(bytes, ctype);
      if (!inspected.ok) return inspected;
      const { mime } = inspected;
      return { ok: true, b64: base64FromBytes(bytes), mime, animated: isAnimatedImage(bytes, mime) };
    } catch (e) {
      if (e && e.name === "AbortError") return { ok: false, error: "aborted" };
      return { ok: false, error: "image_fetch", message: String((e && e.message) || e) };
    }
  }

  async function translateImage(settings, imageUrl, signal) {
    const providerId = settings.provider;
    const provider = Providers.get(providerId);
    // vision 非対応プロバイダ (MyMemory/xai/deepseek 等 = visionModel 無し) は画像翻訳不可。
    // text モデルで vision を試して HTTP エラーになるより、明示的に no_vision を返して理由を出す。
    if (!Providers.supportsImage(providerId)) return { ok: false, error: "no_vision" };
    const apiKey = keyFor(settings, providerId);
    if (!apiKey) return { ok: false, error: "no_api_key" };

    // 画像を取得して base64 化 (host_permissions により CORS を回避)
    const got = await fetchImageBytes(imageUrl, signal);
    if (!got.ok) return got;
    // アニメーション画像 (アニメ GIF/WebP・APNG) は canvas inpaint で焼くと元 <img> のアニメが静止画に固まるため
    // 翻訳しない。content はこの error を受けて以後その画像の「訳」ボタンを出さない。vision を呼ぶ前に弾いて API 消費も避ける。
    if (got.animated) return { ok: false, error: "animated" };
    const b64 = got.b64, mime = got.mime;

    // 画像入力対応を明示した visionModel だけを使う。/models の通常一覧には modality 情報が無いため、
    // 404 時に text 用 defaultModel/一覧先頭へ自動フォールバックすると画像非対応モデルへ再送してしまう。
    // visionModel の更新は provider 定義を正本とし、404 はそのまま返して安全側に倒す。
    const model = provider.visionModel;

    // 1 回ぶんの vision リクエスト。404 自己修復で 2 回呼べるよう関数化する。
    async function runVision(useModel) {
      let req;
      try {
        req = ProviderApi.buildImageRequest(providerId, {
          imageBase64: b64, mimeType: mime,
          sourceLang: settings.sourceLang, targetLang: settings.targetLang,
          model: useModel, apiKey,
          reasoningEffort: reasoningEffortFor(settings, providerId, useModel),
        });
      } catch (e) {
        return { ok: false, error: "build", message: String((e && e.message) || e) };
      }
      if (!req) return { ok: false, error: "unsupported" };
      let res;
      try {
        res = await fetch(req.url, { method: req.method, headers: req.headers, body: JSON.stringify(req.body), signal: withTimeout(signal) });
      } catch (e) {
        if (e && e.name === "AbortError") return { ok: false, error: "aborted" };
        return { ok: false, error: "network", message: String((e && e.message) || e) };
      }
      if (!res.ok) {
        const detail = await readDetail(res);
        return { ok: false, error: "http", status: res.status, message: detail };
      }
      try { return { ok: true, json: await res.json() }; } catch (_e) { return { ok: false, error: "parse" }; }
    }

    const r = await runVision(model);
    if (!r.ok) return r;

    const blocks = ProviderApi.parseImageBlocks(providerId, r.json);
    const usage = ProviderApi.parseUsage(providerId, r.json);
    await ensureMem(); // 既存の月次 usage を読み込んでから加算 (cold start の初回が画像翻訳でも上書きしない)
    recordUsage(providerId, usage);
    // image: content 側の canvas inpaint 用に取得済みバイトを返す。ページ側で cross-origin <img> を
    // 直接 draw すると canvas が taint され getImageData/toDataURL が封じられるため、SW が host_permissions で
    // 取得済みの base64 を渡し content は createImageBitmap(blob) で CORS-safe に再構築する。
    return { ok: true, blocks, image: { base64: b64, mime } };
  }

  function imageDimensionsTooLarge(width, height) {
    const w = Number(width), h = Number(height);
    const max = (globalThis.RuntimeLimits && RuntimeLimits.MAX_IMAGE_PIXELS) || 25000000;
    return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 && w * h > max;
  }

  // ---- ページ翻訳/復元の指示 ----
  // 全フレームに注入する (右サイドパネル等が iframe のときも翻訳されるように)。
  // 各フレームの translator は文字数の少ない枠(広告等)を自前のしきい値で除外する。
  // APPLY_TRANSLATE_CS は tabs.sendMessage(frameId 省略) で全フレームに配信される。
  async function injectTranslator(tabId) {
    // 画像翻訳はホバー/右クリックの手動のみで manifest content script (image-translator.js・top 常駐 +
    // 右クリック時の frameId 注入) が担うため、ここでは翻訳エンジン (translator.js) だけを全フレームに注入する。
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["src/lib/actions.js", "src/lib/lang.js", "src/content/translator.js"],
    });
  }

  // ページ翻訳/復元はワンショット動作。全ページ自動翻訳 (autoTranslate) の永続フラグはここでは変更しない。
  // (翻訳ボタン/FAB/右クリックで 1 ページ訳しただけで、以後開く全ページが自動翻訳され課金枠を食うのを防ぐ。)
  // autoTranslate の保存は popup の「全ページ自動翻訳」トグル (APPLY_SETTINGS) でのみ行う。
  async function translatePage(tabId, manual = false, routeChange = false) {
    // ブラックリストは自動翻訳だけの gate。popup/FAB/右クリックの明示操作(manual=true)は常に通す。
    // 世代採番・既存翻訳のabortより先に判定し、対象外ページを開いただけで手動翻訳を中断しない。
    if (!manual) {
      await settingsWriteChain;
      const settings = await getSettingsCached();
      // CONTENT_FLAGS の更新と URL 監視tickが競合しても、OFF 後に新しい自動翻訳を開始しない。
      if (!settings.autoTranslate) return { ok: true, autoTranslateDisabled: true };
      let tabUrl = "";
      try { tabUrl = (await chrome.tabs.get(tabId)).url || ""; } catch (_e) { /* inject側の既存エラーへ委ねる */ }
      if (AutoTranslateBlacklist.matches(tabUrl, settings.autoTranslateBlacklist)) {
        // 同じ document 上の SPA 遷移では旧 translator が生存している。除外URLへ移った場合は旧runも復元し、
        // 先行翻訳・FABの前ルート状態・page session を残さない。初回gateは手動run競合を中断しない。
        if (routeChange) await restorePage(tabId);
        return { ok: true, blacklisted: true };
      }
    }
    await ensurePageSessions(); // SW 再起動後でも旧セッション/世代を踏まえてから採番する (persist が他タブ分を消さないようにも必要)
    const myGen = bumpTabGen(tabId); // この翻訳指示の世代を採番 (await 中に restore が割り込んだら陳腐化する)
    abortGroup(tabId, "page"); // 再翻訳: 前回のページfetchだけ中断 (手動画像OCRは継続)
    resetFrameProgress(tabId); // フレーム横断の進捗集約をリセット (watchdog も解除・新しい翻訳セッション)
    // FAB/右クリック/自動は popup の pendingSave を待てないため、進行中の APPLY_SETTINGS 保存を待ってから読む。
    // 設定変更直後に翻訳開始しても、ページ全体が旧 provider/旧言語で走り出すのを防ぐ。
    await settingsWriteChain;
    // 各 await 後に世代を確認する: 古い呼び出しが後から pageSessions.set で新セッションを上書きしたり、
    // 古い注入失敗が新セッションを巻き添え削除したりしないようにする (並行した翻訳開始/OFF との競合対策)
    if (tabGen.get(tabId) !== myGen) return { ok: true, superseded: true };
    const settings = await getSettings();
    if (tabGen.get(tabId) !== myGen) return { ok: true, superseded: true };
    pageSessions.set(tabId, { id: myGen, settings });
    persistPageSessions();
    try {
      await injectTranslator(tabId);
    } catch (_e) {
      // chrome:// / Web Store / PDF ビューア等の注入不可ページ。restorePage と同じく経路を局所化し、汎用 exception
      // ではなく専用エラーで返す (popup は !ok を一律 "Error" 表示するので UX は同値、将来の個別文言にも備える)。
      const cur = pageSessions.get(tabId);
      if (cur && cur.id === myGen) { pageSessions.delete(tabId); persistPageSessions(); } // 自分のセッションだけ消す (後発の新セッションを巻き添えにしない)
      return { ok: false, error: "not_injectable" };
    }
    // injectTranslator の await 中に restorePage (OFF) や別の翻訳指示が世代を進めていたら、この APPLY_TRANSLATE_CS は
    // stale。送ると復元を上書きして再翻訳してしまうので送信を取り止める (発生源で断つ)。ok:true で静かに無視し、
    // popup の「翻訳」ボタンが !ok を Error 表示するのを避ける (ユーザー意図は最新の restore/別翻訳が表現する)。
    if (tabGen.get(tabId) !== myGen) return { ok: true, superseded: true };
    // content には API キーを渡さない (publicSettings で除去)。キーは TRANSLATE_BATCH 受信時に bg 側で引く。
    await chrome.tabs.sendMessage(tabId, {
      action: Actions.APPLY_TRANSLATE_CS,
      settings: publicSettings(settings),
      sessionId: myGen,
      manual,
    });
    return { ok: true };
  }

  async function restorePage(tabId) {
    await ensurePageSessions(); // persist が SW 再起動前の他タブ分を消さないよう、削除前に必ず復元しておく
    bumpTabGen(tabId); // 世代を進める。await 中の translatePage の myGen を陳腐化させ、後発の APPLY_TRANSLATE_CS を止める
    abortTab(tabId); // 復元: 進行中の翻訳 fetch を中断し、無駄なネットワーク/課金枠を切る
    pageSessions.delete(tabId);
    persistPageSessions();
    // 集約状態を直接リセットする (translatePage と対称化)。通常は translator の "restored" 通知が reset を促すが、
    // フレームが context 失効/離脱して "restored" を返せないと st.errored/loading が残置する。ここで直接リセットすれば
    // 「翻訳が loading に張り付いた → FAB クリックで復元」が確実に状態を解除できる手動脱出になる。
    resetFrameProgress(tabId);
    // translator 未注入のタブ (画像翻訳のみ等) では translator の "restored" 通知が来ず、FAB/popup が
    // loading/on/error に張り付く。SW から能動的に restored を中継して確実に未翻訳状態へ戻す。
    relayProgress(tabId, { action: Actions.TRANSLATION_PROGRESS, state: "restored" });
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
  // 直近の翻訳エラーをタブ単位で状態化する。自動翻訳/FAB はエラー後に popup を開かないと理由が分からないため、
  // メモリに加えて短期の storage.session にも保存し、SW休止後でもTTL内なら原因 (キー無効/quota 等) を出せるようにする。
  const lastErrorByTab = new Map(); // tabId -> { detail, ts }
  const LAST_ERROR_TTL_MS = 90000;  // この時間内に開いた popup にだけ直近エラーを見せる (古いエラーの誤表示を防ぐ)
  const LAST_ERROR_STORAGE_PREFIX = "lastError:";
  function lastErrorStorageKey(tabId) { return LAST_ERROR_STORAGE_PREFIX + String(tabId); }
  async function persistLastError(tabId, detail) {
    try {
      if (chrome.storage.session) {
        await chrome.storage.session.set({ [lastErrorStorageKey(tabId)]: { detail, ts: Date.now() } });
      }
    } catch (_e) { /* session storage 非対応環境ではメモリ表示だけ継続 */ }
  }
  async function clearPersistedLastError(tabId) {
    try {
      if (chrome.storage.session) await chrome.storage.session.remove(lastErrorStorageKey(tabId));
    } catch (_e) { /* noop */ }
  }
  async function getLastError(tabId) {
    if (tabId == null) return null;
    const now = Date.now();
    const inMem = lastErrorByTab.get(tabId);
    if (inMem && now - inMem.ts < LAST_ERROR_TTL_MS) return inMem.detail;
    if (inMem) lastErrorByTab.delete(tabId);
    try {
      if (!chrome.storage.session) return null;
      const data = await chrome.storage.session.get(lastErrorStorageKey(tabId));
      const saved = data && data[lastErrorStorageKey(tabId)];
      if (saved && now - saved.ts < LAST_ERROR_TTL_MS) {
        lastErrorByTab.set(tabId, saved);
        return saved.detail;
      }
      if (saved) await clearPersistedLastError(tabId);
    } catch (_e) { /* noop */ }
    return null;
  }
  function relayProgress(tabId, msg) {
    chrome.tabs.sendMessage(tabId, msg).catch(() => { /* 受信端が無ければ無視 */ }); // FAB (content top frame)
    // popup が閉じていると runtime.sendMessage は「Receiving end does not exist」で非同期に reject する。
    // relayProgress は fire-and-forget で呼ばれ、同期 try/catch では捕まらないので Promise.catch で握りつぶす
    // (content の send() ラッパと同パターン。popup/options 不在でも無害)。
    try {
      const p = chrome.runtime.sendMessage(msg); // popup (集約済みのみ受理)
      if (p && typeof p.catch === "function") p.catch(() => { /* 受信端が無ければ無視 */ });
    } catch (_e) { /* context 失効など同期例外も無視 */ }
  }
  function clearFrameTimer(st) { if (st && st.timer) { clearTimeout(st.timer); st.timer = null; } }
  function resetFrameProgress(tabId) {
    clearFrameTimer(frameProgress.get(tabId));
    frameProgress.delete(tabId);
    lastErrorByTab.delete(tabId); // 新セッション開始/復元で直近エラーをクリア (古い理由が残らないように)
    void clearPersistedLastError(tabId);
  }
  function handleFrameProgress(tabId, frameId, msg) {
    let st = frameProgress.get(tabId);
    if (!st) { st = { active: new Set(), done: new Set(), errored: false, timer: null }; frameProgress.set(tabId, st); }
    // error は終端。どれかのフレームが error を出したら、その後の done/progress で上書きしない
    // (別フレームの done が error 表示を消して「成功したように見える」のを防ぐ)。restore/新セッションでリセット。
    if (msg.state === "error") {
      st.errored = true; clearFrameTimer(st);
      lastErrorByTab.set(tabId, { detail: msg.detail, ts: Date.now() }); // 後から popup を開いても理由を出せるよう状態化
      void persistLastError(tabId, msg.detail);
      relayProgress(tabId, msg); return;
    }
    if (st.errored && msg.state !== "restored") return; // 終端後は restore 以外を中継しない
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
        if (msg.partial) st.partial = true; // どれかのフレームがレート制限等で一部未訳なら集約して done に乗せる
        clearFrameTimer(st);
        if ([...st.active].every((f) => st.done.has(f))) {
          relayProgress(tabId, Object.assign({}, msg, { partial: Boolean(st.partial) })); // 全参加フレーム完了
        } else {
          // 未完フレームが残る。iframe の離脱/ナビゲーションで永久に loading へ張り付くのを防ぐが、
          // 生存中の遅いframeを「完全done」と偽装しない。猶予後は pending_frames 付き partial として通知する。
          st.timer = setTimeout(() => {
            const cur = frameProgress.get(tabId);
            if (cur) {
              cur.timer = null;
              cur.partial = true;
              const pendingFrames = [...cur.active].filter((f) => !cur.done.has(f));
              relayProgress(tabId, Object.assign({}, msg, { partial: true, pendingFrames }));
            }
          }, FRAME_DONE_GRACE_MS);
        }
        break;
      case "skipped":
        // メインフレームが「ページ言語=翻訳先」で翻訳不要と判定。iframe が翻訳中ならそちらの done 表示に任せ、
        // どのフレームも翻訳していないときだけ中継して FAB/popup を未翻訳状態に戻す。
        if (st.active.size === 0) relayProgress(tabId, msg);
        break;
      case "restored":
        resetFrameProgress(tabId);
        relayProgress(tabId, msg);
        break;
      default: // 未知の state は念のため中継 (error は上の専用パスで終端化済み)
        relayProgress(tabId, msg);
    }
  }
  // タブが閉じたら集約状態と in-flight を後始末する (離脱フレーム/タブの取り残し防止)
  try {
    chrome.tabs.onRemoved.addListener((tabId) => {
      resetFrameProgress(tabId); abortTab(tabId); tabGen.delete(tabId); lastErrorByTab.delete(tabId);
      // pageSessions は storage.session ミラーがあるため、復元を待ってから消して他タブ分を巻き添えにしない
      ensurePageSessions().then(() => { pageSessions.delete(tabId); persistPageSessions(); });
    });
  } catch (_e) { /* noop */ }

  // ---- メッセージディスパッチ ----
  // ---- 廃止モデルの動的フォールバック (404 → 同プロバイダの現行モデルへ自動切替 + 1 回再試行) ----
  // 静的 RETIRED_MODELS(actions.js) は通信ゼロの保険。実行時に実際に 404 を食らったらこちらが自己修復するので、
  // 未知の廃止 (今後どのモデルがいつ死んでも) を手動メンテ無しで吸収できる。
  const modelFallback = new Map();     // "providerId:deadModelId" -> goodModelId (解決結果のキャッシュ)
  const resolvingFallback = new Map(); // "providerId:deadModelId" -> Promise (10 並列が同時 404 でも解決を 1 回に集約)
  // キーは provider でスコープする (同一モデル ID を 2 社が公開していても互いのフォールバックを汚染しない)。

  function isModelGone(res) {
    // LLM の chat/completions・:generateContent での 404 はほぼ「モデル ID 無効/廃止」。
    // フォールバックの代償は最大 1 回の再試行のみなので 404 は一律モデル起因として扱う。
    return Boolean(res && !res.ok && res.error === "http" && res.status === 404);
  }

  // 廃止モデルの代替を解決: まず provider.defaultModel(現行に保守)、既定自体が廃止なら live /models の先頭。
  async function resolveFallbackModel(providerId, deadModel) {
    const key = providerId + ":" + deadModel; // provider スコープのキー (社をまたぐ同名モデルの相互汚染を防ぐ)
    if (modelFallback.has(key)) return modelFallback.get(key);
    if (resolvingFallback.has(key)) return resolvingFallback.get(key);
    const job = (async () => {
      const provider = Providers.get(providerId);
      const def = provider && provider.defaultModel;
      if (def && def !== deadModel) return def;
      try {
        const s = await getSettingsCached();
        const r = await fetchModels(providerId, keyFor(s, providerId));
        const first = r && r.ok && r.models && r.models[0] && r.models[0].id;
        if (first && first !== deadModel) return first;
      } catch (_e) { /* live 取得失敗 → 復旧不可 */ }
      return null;
    })();
    resolvingFallback.set(key, job);
    let out = null;
    try { out = await job; } finally { resolvingFallback.delete(key); }
    // 解決成功はその現行モデルを、解決不能(null)は deadModel 自身を記録する。後者で「これ以上良いモデルは無い」を
    // 表し、後続バッチが毎回 fetchModels を再発火するスラッシングを抑える (呼び出し側は cached!==cur / good!==dead で
    // 再試行しないので deadModel キャッシュは安全)。SW は MV3 で頻繁に再起動 → キャッシュ揮発で再解決され、キー追加後も復旧する。
    modelFallback.set(key, out || deadModel);
    return out;
  }

  // 解決した現行モデルを settings に永続化 (applySettingsPatch で直列化 = 並行バッチの二重保存/lost update 回避)。
  // deadModel ガード: 保存時点で当該 provider のモデルがまだ「死んだモデル」のときだけ書き換える。フォールバック解決中に
  // ユーザーが別モデルへ手動変更していたら、その新しい選択を上書きしない (遅延フォールバックによる巻き戻し防止)。
  async function persistModelSwitch(providerId, newModel, deadModel) {
    await applySettingsPatch((base) => {
      if (typeof deadModel === "string" && base.models[providerId] !== deadModel) return null; // ユーザーが変更済み → 触らない
      if (base.models[providerId] === newModel) return null;
      return { models: { [providerId]: newModel } };
    });
  }

  // 廃止モデル(404)を同プロバイダの現行モデルへ自動フォールバックして 1 回だけ再試行する共通ヘルパ。
  // ① キャッシュ済みの「死亡モデル→現行」があれば最初の呼び出し前に先回りで差し替える(以後のバッチ/行で無駄な 404 を出さない)。
  // ② 実際に 404 を食らったら resolveFallbackModel→persistModelSwitch(dead ガード付き)→同入力を 1 回再試行する。
  // TRANSLATE_BATCH(ページ/クイック)から呼び、廃止モデルの自己修復を共通化する。
  async function translateWithHeal(settings, texts, contexts, signal, batchId, tabId, frameId, quick, indexMap) {
    if (settings.provider !== "mymemory") {
      const cur = (settings.models && settings.models[settings.provider]) || "";
      const cached = modelFallback.get(settings.provider + ":" + cur);
      if (cached && cached !== cur) {
        settings = Object.assign({}, settings, { models: Object.assign({}, settings.models, { [settings.provider]: cached }) });
      }
    }
    let res = await translateWith(settings, texts, contexts, signal, batchId, tabId, frameId, quick, indexMap);
    if (isModelGone(res) && settings.provider !== "mymemory") {
      const dead = (settings.models && settings.models[settings.provider]) || "";
      const good = await resolveFallbackModel(settings.provider, dead);
      if (good && good !== dead) {
        await persistModelSwitch(settings.provider, good, dead); // 保存 → 以後のバッチ/popup 表示も現行に揃う
        settings = Object.assign({}, settings, { models: Object.assign({}, settings.models, { [settings.provider]: good }) });
        res = await translateWith(settings, texts, contexts, signal, batchId, tabId, frameId, quick, indexMap);
      }
    }
    return res;
  }

  // stream(OpenAI 互換のみ) → 非stream の順で 1 バッチ翻訳する (404 フォールバックで 2 回呼べるよう関数化)。
  function sendTranslationPartial(tabId, frameId, batchId, index, text) {
    if (tabId == null || batchId == null) return Promise.resolve();
    try {
      const delivery = chrome.tabs.sendMessage(tabId, { action: Actions.TRANSLATE_PARTIAL, batchId, index, text }, { frameId });
      return delivery && typeof delivery.catch === "function"
        ? delivery.catch(() => { /* 受信端が無ければ無視 */ })
        : Promise.resolve();
    } catch (_e) { return Promise.resolve(); }
  }

  async function translateWith(settings, texts, contexts, signal, batchId, tabId, frameId, quick, indexMap) {
    let res = null;
    if (batchId != null && ProviderApi.supportsStream(settings.provider)) {
      res = await translateBatchStream(settings, texts, contexts, signal, (index, text) => {
        const originalIndex = Array.isArray(indexMap) && Number.isInteger(indexMap[index]) ? indexMap[index] : index;
        sendTranslationPartial(tabId, frameId, batchId, originalIndex, text);
      });
    }
    if (!res) res = await translateBatch(settings, texts, contexts, signal, { tune: !quick }); // stream 非対応レスポンスだけ非streamへ
    return res;
  }

  async function translateWithCache(settings, texts, contexts, signal, batchId, tabId, frameId, quick, scope) {
    if (!scope || batchId == null) {
      return withProviderSlot(settings, signal, () =>
        translateWithHeal(settings, texts, contexts, signal, batchId, tabId, frameId, quick)
      );
    }
    await ensureTranslationCache(persistentTranslationCacheEnabled);
    const translations = new Array(texts.length);
    const missTexts = [];
    const missContexts = [];
    const missIndices = [];
    const missKeys = [];
    const cacheDeliveries = [];
    for (let i = 0; i < texts.length; i++) {
      const key = TranslationBatch.cacheKey(scope, settings, ProviderApi.promptVersion, texts[i], contexts[i]);
      const cached = getCachedTranslation(key);
      if (cached === undefined) {
        missTexts.push(texts[i]);
        missContexts.push(contexts[i]);
        missIndices.push(i);
        missKeys.push(key);
      } else {
        translations[i] = cached;
        // cache hit は API miss の成否を待たず適用する。index は元 batch の位置のまま送る。
        cacheDeliveries.push(sendTranslationPartial(tabId, frameId, batchId, i, cached));
      }
    }
    // miss が no_api_key/HTTP エラー等で即時終了しても、hit の適用が sendResponse より後着して
    // pendingBatches 削除に弾かれないよう、cache hit だけは content への配送完了を待つ。
    if (cacheDeliveries.length) await Promise.all(cacheDeliveries);
    if (missTexts.length === 0) {
      return {
        ok: true, translations, usage: { input: 0, output: 0 },
        cacheHits: texts.length,
      };
    }
    const res = await withProviderSlot(settings, signal, () =>
      translateWithHeal(settings, missTexts, missContexts, signal, batchId, tabId, frameId, quick, missIndices)
    );
    if (res && Array.isArray(res.translations) && res.translations.length === missTexts.length) {
      for (let i = 0; i < missTexts.length; i++) translations[missIndices[i]] = res.translations[i];
      if (res.ok) {
        for (let i = 0; i < missTexts.length; i++) putCachedTranslation(missKeys[i], res.translations[i]);
      }
      return Object.assign({}, res, {
        translations,
        cacheHits: texts.length - missTexts.length,
        attemptedTextCount: missTexts.length,
      });
    }
    return res && typeof res === "object"
      ? Object.assign({}, res, { cacheHits: texts.length - missTexts.length, attemptedTextCount: missTexts.length })
      : res;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.action !== "string") return undefined;
    // sender.id を必須にして自拡張由来だけを受理し、さらに action ごとに content / 拡張ページの権限を分離する。
    // content はページと同じ renderer にいる低信頼境界なので、設定変更・モデル取得・全 state 取得は許可しない。
    const extensionId = chrome.runtime.id;
    const extensionBase = chrome.runtime.getURL("");
    if (!sender || !extensionId || sender.id !== extensionId) return undefined;
    if (!MessagePolicy.canInvoke(msg.action, msg, sender, extensionBase)) {
      sendResponse({ ok: false, error: "forbidden_sender" });
      return false;
    }

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
            const tabId = sender.tab && sender.tab.id;
            const frameId = sender.frameId || 0;
            if (!msg.quick) await ensurePageSessions(); // SW 再起動後の後続バッチを stale_session で全滅させない
            const session = (!msg.quick && msg.sessionId != null && tabId != null)
              ? pageSessions.get(tabId)
              : null;
            let settings;
            if (!msg.quick) {
              if (!session || msg.sessionId == null || session.id !== msg.sessionId) {
                sendResponse({ ok: false, error: "stale_session" });
                break;
              }
              settings = resolvePageSessionSettings(msg.settings, session);
            } else {
              // quick (選択テキスト翻訳 / ホットキー) はページから直接来る = popup の pendingSave を待てないため、
              // 進行中の APPLY_SETTINGS 保存を待ってから設定を読む。provider/target を変えた直後の 1 回目が
              // 旧 provider・旧キー・旧言語で実行されるのを防ぐ (TRANSLATE_IMAGE と同じ理由)。
              await settingsWriteChain;
              settings = resolveSettings(msg.settings, await getSettingsCached()); // quick等は最新設定を使う
            }
            // 復元/再翻訳で中断できるよう AbortController をタブ単位で登録する。ただし quick
            // (popup クイック翻訳 / 選択テキスト翻訳) は短い単発で、ページの復元/再翻訳 (abortTab) に
            // 巻き込んで中断させたくないため abort グループに登録しない (content 側は reqId ガードで stale 応答を捨てる)。
            const controller = new AbortController();
            const untrack = msg.quick ? () => {} : trackController(tabId, controller, "page");
            try {
              const texts = Array.isArray(msg.texts) ? msg.texts : [];
              const provider = Providers.get(settings.provider);
              const contexts = provider && provider.batch === false
                ? TranslationBatch.normalizeContexts([], texts.length, TranslationBatch.CONTEXT_MAX_CHARS)
                : TranslationBatch.normalizeContexts(msg.contexts, texts.length, TranslationBatch.CONTEXT_MAX_CHARS);
              // 廃止モデルの 404 は translateWithHeal が同プロバイダの現行モデルへ自動フォールバック + 1 回再試行する
              // (静的 RETIRED に依存せず未知の廃止も自己修復。キャッシュ先回りで 2 バッチ目以降の無駄な 404 も出さない)。
              let res;
              try {
                res = await translateWithCache(
                  settings, texts, contexts, controller.signal, msg.batchId, tabId, frameId, msg.quick,
                  translationCacheScope(sender, msg.quick)
                );
              } catch (e) {
                res = (e && e.error) ? e : {
                  ok: false, error: "exception", message: String((e && e.message) || e),
                };
              }
              sendResponse(res);
            } finally { untrack(); }
            break;
          }
          case Actions.TRANSLATE_IMAGE: {
            if (imageDimensionsTooLarge(msg.imageWidth, msg.imageHeight)) {
              sendResponse({ ok: false, error: "image_too_large" });
              break;
            }
            // ページから直接来る (popup の pendingSave を待てない) ため、進行中の APPLY_SETTINGS 保存を待ってから
            // 設定を読む。target/provider を変えて即ホバー翻訳しても、初回が旧 provider/旧言語で実行されるのを防ぐ。
            await settingsWriteChain;
            const stored = await getSettingsCached();
            const settings = resolveSettings(msg.settings, stored);
            const controller = new AbortController();
            const imageTabId = sender.tab && sender.tab.id;
            const untrack = trackController(imageTabId, controller, "image");
            try {
              let res;
              try {
                res = await withProviderSlot(settings, controller.signal, () =>
                  translateImage(settings, msg.imageUrl, controller.signal)
                );
              } catch (e) {
                res = (e && e.error) ? e : { ok: false, error: "aborted" };
              }
              sendResponse(res);
            } finally { untrack(); }
            break;
          }
          case Actions.TRANSLATE_PAGE: {
            // content が別 tabId を偽装しても sender.tab.id へ固定。明示 tabId は popup 等の拡張ページだけ受理する。
            const tabId = MessagePolicy.targetTabId(msg, sender, extensionBase);
            if (tabId == null) { sendResponse({ ok: false, error: "no_tab" }); break; }
            sendResponse(await translatePage(tabId, msg.manual === true, msg.routeChange === true));
            break;
          }
          case Actions.RESTORE_PAGE: {
            const tabId = MessagePolicy.targetTabId(msg, sender, extensionBase);
            if (tabId == null) { sendResponse({ ok: false, error: "no_tab" }); break; }
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
            try {
              const saved = await applySettingsPatch(incoming);
              sendResponse({ ok: true, settings: saved });
            } catch (_e) {
              sendResponse({ ok: false, error: "settings_save_failed", settings: await getSettings() });
            }
            break;
          }
          case Actions.GET_STATE: {
            // popup が自タブの直近エラーを再表示できるよう、TTL 内の last-error も返す
            // (自動翻訳/FAB はエラー後に popup を開かず、即時イベントを逃すため)。
            const errTab = msg.tabId;
            const lastError = await getLastError(errTab);
            await settingsWriteChain; // 起動時の同期取り込み・進行中の保存も表示へ反映する
            const stateSettings = await getSettings();
            // MessagePolicy が拡張ページだけをこの case へ通す。content へは API キーを含む state を返さない。
            sendResponse({ ok: true, settings: stateSettings, lastError });
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
  const AUTO_TRANSLATE_SITE_MENU_ID = "rt-auto-translate-site";

  function autoTranslateSiteMenuTitle(excluded) {
    const key = excluded ? "ctxAutoTranslateAllow" : "ctxAutoTranslateBlock";
    const fallback = excluded ? "Remove this site from auto-translate exclusions" : "Exclude this site from auto-translate";
    return (chrome.i18n && chrome.i18n.getMessage(key)) || fallback;
  }

  async function refreshAutoTranslateSiteMenu(tab) {
    if (!chrome.contextMenus) return;
    const url = tab && tab.url;
    const site = AutoTranslateBlacklist.sitePattern(url);
    let excluded = false;
    if (site) {
      const settings = await getSettingsCached();
      excluded = AutoTranslateBlacklist.matches(url, settings.autoTranslateBlacklist);
    }
    await new Promise((resolve) => {
      chrome.contextMenus.update(AUTO_TRANSLATE_SITE_MENU_ID, {
        enabled: Boolean(site),
        title: autoTranslateSiteMenuTitle(excluded),
      }, () => {
        void chrome.runtime.lastError; // menu 未作成直後等の非致命エラーを回収
        resolve();
      });
    });
    if (typeof chrome.contextMenus.refresh === "function") {
      try { await chrome.contextMenus.refresh(); } catch (_e) { /* Chrome等の未対応実装は無視 */ }
    }
  }

  async function refreshActiveAutoTranslateSiteMenu() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await refreshAutoTranslateSiteMenu(tab);
    } catch (_e) { /* menu 更新失敗は翻訳機能へ影響させない */ }
  }

  async function toggleAutoTranslateSite(url) {
    if (!AutoTranslateBlacklist.sitePattern(url)) return;
    await applySettingsPatch((base) => ({
      autoTranslateBlacklist: AutoTranslateBlacklist.toggleSite(url, base.autoTranslateBlacklist).patterns,
    }));
  }

  function setupContextMenus() {
    if (!chrome.contextMenus) return;
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: "rt-translate",
        title: (chrome.i18n && chrome.i18n.getMessage("ctxTranslate")) || "Translate this page",
        contexts: ["page"], // 選択時は専用の rt-translate-selection を出すため page のみ (二重表示を避ける)
      });
      chrome.contextMenus.create({
        id: "rt-translate-selection",
        title: (chrome.i18n && chrome.i18n.getMessage("ctxTranslateSelection")) || "Translate selection",
        contexts: ["selection"],
      });
      chrome.contextMenus.create({
        id: "rt-translate-image",
        title: (chrome.i18n && chrome.i18n.getMessage("ctxTranslateImage")) || "Translate this image",
        contexts: ["image"],
      });
      chrome.contextMenus.create({
        id: "rt-restore",
        title: (chrome.i18n && chrome.i18n.getMessage("ctxRestore")) || "Restore original",
        contexts: ["page"],
      });
      chrome.contextMenus.create({
        id: AUTO_TRANSLATE_SITE_MENU_ID,
        title: autoTranslateSiteMenuTitle(false),
        contexts: ["all"],
      });
      refreshActiveAutoTranslateSiteMenu();
    });
  }

  // SW 発の常駐 content script 向けメッセージ送信 (selection/image 共通)。Chrome は「拡張の更新/リロード前から
  // 開いていたタブ」へ content_scripts を遡及注入しないため、受信端不在の sendMessage は黙殺されて無反応になる。
  // そこで送信失敗時は executeScript/insertCSS でオンデマンド注入してから再送する (冪等ガード __rt*Loaded 済みなので
  // 既注入フレームへの誤再注入は無害)。frameId 指定でトップ以外のフレームにも配送できる (非常駐の iframe へは
  // 注入フォールバックが必ず効く)。frameId を常に明示するのは、全フレーム配信だと過去に注入済みの iframe が
  // 同一 srcUrl の別画像を重複処理し得るため (対象フレームだけに届ける)。
  function sendCsOrInject(tabId, msg, files, css, frameId) {
    if (tabId == null) return;
    const fid = Number.isInteger(frameId) && frameId > 0 ? frameId : 0;
    chrome.tabs.sendMessage(tabId, msg, { frameId: fid }).catch(async () => {
      try {
        await chrome.scripting.executeScript({ target: { tabId, frameIds: [fid] }, files });
        await chrome.scripting.insertCSS({ target: { tabId, frameIds: [fid] }, files: [css] });
        await chrome.tabs.sendMessage(tabId, msg, { frameId: fid });
      } catch (_e) { /* chrome:// / Web Store 等の注入不可ページは無視 */ }
    });
  }

  // ホットキー/右クリックで content(selection-translator) に選択テキスト翻訳の起動を合図する。
  // SW はページの選択を直接読めないため、content 側が window.getSelection() を読みバブルを出す (トップフレームのみ)。
  function triggerSelectionTranslate(tabId) {
    sendCsOrInject(tabId, { action: Actions.TRANSLATE_SELECTION_CS },
      ["src/lib/actions.js", "src/content/selection-translator.js"], "src/content/selection-translator.css");
  }

  // 右クリック「この画像を翻訳」で content(image-translator) に画像翻訳の起動を合図する。
  // srcUrl を渡し、content 側は直近 contextmenu の対象 img (注入直後は srcUrl 照合) を解決して translateImg する。
  // iframe 内の画像は info.frameId をそのまま配送先にし、非常駐フレームへはオンデマンド注入で届ける
  // (常駐はトップのみ＝広告枠コスト回避を保ちつつ、明示操作のあったフレームだけ注入する。これが無いと
  // iframe 画像の右クリック翻訳がトップで解決できず、メニューを押しても何も起きない無言 no-op になる)。
  function triggerImageTranslate(tabId, srcUrl, frameId) {
    sendCsOrInject(tabId, { action: Actions.TRANSLATE_IMAGE_CS, srcUrl: srcUrl || "" },
      ["src/lib/actions.js", "src/content/image-translator.js"], "src/content/image-translator.css", frameId);
  }

  chrome.runtime.onInstalled.addListener(() => { setupContextMenus(); ensureContentFlags().catch(() => { /* noop */ }); });
  ensureContentFlags().catch(() => { /* noop */ }); // SW 起動ごとに content 用フラグの存在を保証
  // SW 起動時に翻訳ホットパスの設定/集計メモリをプリロードし、cold start 後の最初の TRANSLATE_BATCH の
  // storage 待ち (設定 + BATCH_TUNING + TOKEN_USAGE) を消す (warm 時は settingsMem/tuningMem が効くので無害)。
  const preloadSettings = getSettingsCached();
  settingsWriteChain = preloadSettings.then(() => {}, () => {}); // 初回読込の後で同期値を確定する
  receiveSyncedSettings().catch(() => {}); // 休止中・終了中に届いた設定も起動時に取り込む
  Promise.all([
    preloadSettings,
    ensureMem(),
    preloadSettings.then(async (settings) => {
      const enabled = settings.persistentTranslationCache === true;
      await ensureTranslationCache(enabled);
      // OFF が正本なら、以前の削除失敗等で残った永続コピーも SW 起動ごとに再清掃する。
      if (!enabled) {
        const cleanup = async () => {
          // 起動中にユーザーが ON へ切り替えた場合は、新しい永続 cache を消さない。
          if (!persistentTranslationCacheEnabled) {
            try { await chrome.storage.local.remove(StorageKeys.PERSISTENT_TRANSLATION_CACHE); } catch (_e) { /* 次回起動で再試行 */ }
          }
        };
        const next = translationCacheWriteChain.then(cleanup, cleanup);
        translationCacheWriteChain = next.catch(() => {});
        await next;
      }
    }),
  ]).catch(() => { /* noop */ });
  if (chrome.runtime.onSuspend) chrome.runtime.onSuspend.addListener(() => persistTranslationCache());

  if (chrome.contextMenus) {
    if (chrome.contextMenus.onShown) {
      chrome.contextMenus.onShown.addListener((_info, tab) => {
        refreshAutoTranslateSiteMenu(tab).catch(() => { /* noop */ });
      });
    }
    chrome.contextMenus.onClicked.addListener(async (info, tab) => {
      if (!tab || !tab.id) return;
      if (info.menuItemId === "rt-translate") await translatePage(tab.id, true);
      else if (info.menuItemId === "rt-restore") await restorePage(tab.id);
      else if (info.menuItemId === "rt-translate-selection") triggerSelectionTranslate(tab.id);
      else if (info.menuItemId === "rt-translate-image") triggerImageTranslate(tab.id, info.srcUrl, info.frameId);
      else if (info.menuItemId === AUTO_TRANSLATE_SITE_MENU_ID) {
        await toggleAutoTranslateSite(tab.url || info.pageUrl || "");
        await refreshAutoTranslateSiteMenu(tab);
      }
    });
  }

  if (chrome.tabs) {
    chrome.tabs.onActivated.addListener(() => { refreshActiveAutoTranslateSiteMenu(); });
    chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
      if (changeInfo.url || changeInfo.status === "complete") refreshAutoTranslateSiteMenu(tab).catch(() => { /* noop */ });
    });
  }

  // 割り当て可能なホットキー (manifest commands: translate-selection / 既定 Ctrl+Shift+L)。
  // ユーザーは chrome://extensions/shortcuts (Firefox は about:addons) で再割り当てできる。
  if (chrome.commands) {
    chrome.commands.onCommand.addListener(async (command, tab) => {
      if (command !== "translate-selection") return;
      let tabId = tab && tab.id;
      if (tabId == null) {
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        tabId = active && active.id;
      }
      triggerSelectionTranslate(tabId);
    });
  }
})();
