"use strict";

// 同期レコードの比較・マージはブラウザーAPIから分離し、到着順に依存しない。
//
// キー空間の方針（v1.0.33 以前の旧版との共存）:
// - 新版は `settingsSyncV3.` の64バケットにだけ書く。旧版が使う `settingsSyncV2.` は読むだけで、
//   set も remove もしない。旧版は受信時に自分が知らない項目・値を捨て、残りでバケットを丸ごと
//   書き戻すため、同じバケットを新旧で共有すると書込みが往復して止まらない（言い換え設定・gyaru・
//   廃止スタイル値 casual/literal で実際に起きた）。キー空間を分けると往復は構造的に起きない。
// - 旧→新の片方向だけ維持する: 旧版端末が V2 へ書いた変更は新版が取り込み、V3 へ転記する。
//   新版での変更は旧版端末には届かない（V1 撤去時と同じく、旧クライアントとの継続同期は行わない）。
// - 将来の版への備え: V3 で受信した記録は、構造（IDの形・stamp・型・長さ）が妥当で端末専用キーでない
//   限り、この版が適用できなくても原形のまま保持して再送する。適用できるかは project だけが判定する。
//   こうしておくと次に同期項目を足したときも、古い新版が未知の記録を捨ててバケットを書き戻す往復が起きない。
(function () {
  const PREFIX = "settingsSyncV3.";
  // 旧版（v1.0.33 以前）が書くキー空間。新版は読むだけ。
  const V2_PREFIX = "settingsSyncV2.";
  // local state のキーと形式（version 2）は旧版と共用する。旧版へ戻したときも端末ID・clock・joined と
  // 旧版が表現できる記録を引き継げるようにするため。version を上げたり、新版専用のフィールドに
  // 依存したりしない（旧版は state を保存し直すとき知らないフィールドを消す）。V3 への移行は
  // 「V3 側と差があるバケットを送る」既存の uploads 判定だけで成立する。
  const STATE_KEY = "settingsSyncStateV2";
  const STATUS_KEY = StorageKeys.SETTINGS_SYNC_STATUS;
  const ALARM = "settings-sync-retry";
  const SCALARS = ["provider", "sourceLang", "targetLang", "autoTranslate", "showFab",
    "showImageButton", "selectionMode", "fabOpacity", "translationStyle", "customPrompt", "quickSourceLang", "quickTargetLang",
    "rewriteMode", "rewriteStyle"];
  const LEGACY_FIELDS = [...SCALARS, "models", "reasoningEfforts", "autoTranslateBlacklist"];
  const LEGACY_KEYS = LEGACY_FIELDS.map(key => "settingsSyncV1." + key);
  const BUCKETS = 64;
  const KEYS = Array.from({ length: BUCKETS }, (_, index) => PREFIX + index);
  const V2_KEYS = Array.from({ length: BUCKETS }, (_, index) => V2_PREFIX + index);
  // 端末専用の設定（APIキー・同期ON/OFF・永続キャッシュ同意など）。どのキー空間から来ても受理しない。
  // 設定スキーマのうち同期対象でないキーを自動で導出し、将来の端末専用キー追加にも追従させる。
  // 明示の3件は、スキーマ側の変更で漏れても秘密情報を同期しない契約を守るための保険。
  const SYNCED_ROOTS = new Set(LEGACY_FIELDS);
  const LOCAL_ONLY = new Set(["apiKeys", "syncSettings", "persistentTranslationCache",
    ...Object.keys(SettingsSchema.normalize({})).filter(key => !SYNCED_ROOTS.has(key))]);
  const FORBIDDEN_SEGMENTS = ["__proto__", "constructor", "prototype"];
  // 受理する記録の構造上限。未知IDは中身を解釈しないため、ここで大きさだけを抑える。
  const MAX_ID_SEGMENTS = 8;
  const MAX_ID_LENGTH = 2048;
  const MAX_STRING = 2000;
  const MAX_RECORD_JSON = 4096;
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const idOf = (...parts) => JSON.stringify(parts);
  // realm をまたいでも同じ形になるよう JSON で複製する（受信値は JSON 由来なので失う情報は無い）。
  const clone = value => JSON.parse(JSON.stringify(value));

  function snapshot(raw) {
    const s = SettingsSchema.normalize(raw);
    const entries = Object.create(null);
    for (const key of SCALARS) entries[idOf(key)] = s[key];
    for (const provider of Providers.ids) {
      entries[idOf("models", provider)] = s.models[provider];
      for (const [model, effort] of Object.entries(s.reasoningEfforts[provider] || {})) {
        entries[idOf("reasoningEfforts", provider, model)] = effort;
      }
    }
    for (const rule of s.autoTranslateBlacklist) entries[idOf("autoTranslateBlacklist", rule)] = true;
    return entries;
  }

  // ID の構造だけを検証する（この版が知っている項目かは問わない）。
  // JSON 配列の文字列で、正規の直列化と一致し、端末専用キーやプロトタイプ汚染の名前を含まないこと。
  function segmentsOf(id) {
    if (typeof id !== "string" || id.length > MAX_ID_LENGTH) return null;
    try {
      const p = JSON.parse(id);
      if (!Array.isArray(p) || p.length < 1 || p.length > MAX_ID_SEGMENTS) return null;
      if (!p.every(key => typeof key === "string" && key.length > 0 && key.length <= 1000)) return null;
      if (JSON.stringify(p) !== id) return null;
      if (p.some(key => FORBIDDEN_SEGMENTS.includes(key))) return null;
      if (LOCAL_ONLY.has(p[0])) return null;
      return p;
    } catch (_e) { return null; /* 不正なキーは受信しない */ }
  }

  // この版が設定へ適用できる既知IDなら path を返す。未知ID（将来の項目・未知のプロバイダ等）は null。
  function pathOf(id) {
    const p = segmentsOf(id);
    if (!p) return null;
    if (p.length === 1 && SCALARS.includes(p[0])) return p;
    if (p[0] === "models" && p.length === 2 && Providers.ids.includes(p[1])) return p;
    if (p[0] === "reasoningEfforts" && p.length === 3 && Providers.ids.includes(p[1])) return p;
    if (p[0] === "autoTranslateBlacklist" && p.length === 2 && AutoTranslateBlacklist.normalize([p[1]])[0] === p[1]) return p;
    return null;
  }

  function validStamp(stamp) {
    return Array.isArray(stamp) && stamp.length === 3 &&
      Number.isSafeInteger(stamp[0]) && stamp[0] >= 0 && stamp[0] < 8640000000000000 &&
      Number.isSafeInteger(stamp[1]) && stamp[1] >= 0 && stamp[1] < Number.MAX_SAFE_INTEGER &&
      typeof stamp[2] === "string" && /^[a-z0-9-]{1,64}$/i.test(stamp[2]);
  }

  // 記録の構造検証。値の意味（列挙値として正しいか等）は見ない。
  // 旧版の廃止値（casual/literal）や将来の版の新しい値も受理して保持し、表示値は project の正規化に任せる。
  // 値を正規化して比べ「変わる記録は不正」とすると、相手が書いた値を拒否して自値を再送し続けるため。
  function validRecord(id, record) {
    if (!segmentsOf(id)) return false;
    if (!record || typeof record !== "object" || Array.isArray(record) || !validStamp(record.stamp)) return false;
    if (JSON.stringify(record).length > MAX_RECORD_JSON) return false;
    if (record.deleted === true) return true;
    if (!Object.hasOwn(record, "value")) return false;
    const value = record.value;
    if (value !== null && !["string", "boolean", "number"].includes(typeof value)) return false;
    if (typeof value === "number" && !Number.isFinite(value)) return false;
    return typeof value !== "string" || value.length <= MAX_STRING;
  }

  // 保持している記録をこの版の設定へ適用できるか。未知ID・削除記録・上限超えの文字列は適用しない
  // （保持と再送は続ける）。旧版と同じ長さ上限を保ち、customPrompt 以外の長文を設定へ入れない。
  function applicable(p, record) {
    if (!p || record.deleted) return false;
    const value = record.value;
    if (typeof value === "string" && value.length > (p[0] === "customPrompt" ? 2000 : 1000)) return false;
    if (p[0] === "autoTranslateBlacklist") return value === true;
    return true;
  }

  function compare(a, b) {
    for (let i = 0; i < 3; i++) {
      if (a.stamp[i] !== b.stamp[i]) return a.stamp[i] > b.stamp[i] ? 1 : -1;
    }
    // 破損した同一更新IDでも全端末が同じ勝者を選ぶ。
    const av = JSON.stringify(a.deleted ? [true] : [false, a.value]);
    const bv = JSON.stringify(b.deleted ? [true] : [false, b.value]);
    return av === bv ? 0 : av > bv ? 1 : -1;
  }

  // ID からバケット番号を決める。V2 と V3 で同じハッシュを使う（旧版の配置と一致させる）。
  function bucketIndex(id) {
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = (Math.imul(hash, 31) + id.charCodeAt(i)) >>> 0;
    return hash % BUCKETS;
  }

  function fresh(device) {
    return { version: 2, device, clock: [0, 0], joined: false, records: {}, pending: false, legacyCleanup: [] };
  }

  function observe(state, stamp) {
    if (stamp[0] > state.clock[0] || stamp[0] === state.clock[0] && stamp[1] > state.clock[1]) state.clock = stamp.slice(0, 2);
  }

  // local state を復元する。旧版（v1.0.33）が書いた state も同じ形式なのでそのまま受理する。
  // 記録は原形のまま保持し（未知IDも含む）、端末専用キーと構造不正だけを落とす。
  function restore(raw, device) {
    const state = fresh(raw?.version === 2 && validStamp([0, 0, raw.device]) ? raw.device : device);
    if (raw?.version !== 2) return state;
    state.joined = raw.joined === true;
    state.pending = raw.pending === true;
    if (Array.isArray(raw.legacyCleanup)) state.legacyCleanup = LEGACY_KEYS.filter(key => raw.legacyCleanup.includes(key));
    if (Array.isArray(raw.clock) && validStamp([...raw.clock, state.device])) state.clock = raw.clock.slice();
    for (const [id, record] of Object.entries(raw.records || {})) {
      if (!validRecord(id, record)) continue;
      state.records[id] = clone(record);
      observe(state, record.stamp);
    }
    return state;
  }

  function recordChanges(state, before, after, at) {
    const a = snapshot(before), b = snapshot(after);
    const changed = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(id => !equal(a[id], b[id]));
    if (!changed.length) return false;
    const time = Math.max(at, state.clock[0]);
    const count = time === state.clock[0] ? state.clock[1] + 1 : 0;
    const stamp = [time, count, state.device];
    if (!validStamp(stamp)) throw new Error("settings_sync_clock");
    state.clock = stamp.slice(0, 2);
    for (const id of changed) state.records[id] = Object.hasOwn(b, id) ? { value: b[id], stamp } : { deleted: true, stamp };
    state.pending = true;
    return true;
  }

  // 1つのキー空間のバケット群を後勝ちで取り込む。
  // knownOnly: V2（旧版の空間）からは既知IDだけを取り込む。旧版は未知IDを書かないうえ、
  // 新版は V2 へ書かないので、ここで捨てても往復は起きない。
  function mergeSpace(state, remote, keys, knownOnly) {
    keys.forEach((key, index) => {
      const data = remote[key];
      if (data?.version !== 2 || !data.items || typeof data.items !== "object") return;
      for (const [id, r] of Object.entries(data.items)) {
        if (bucketIndex(id) !== index || !validRecord(id, r)) continue;
        if (knownOnly && !pathOf(id)) continue;
        if (!state.records[id] || compare(r, state.records[id]) > 0) state.records[id] = clone(r);
        observe(state, r.stamp);
      }
    });
  }

  function merge(state, remote) {
    // V2（旧版端末の変更）と V3（新版端末の変更）を同じ記録表へ後勝ちで合流させる。
    // 旧版端末の変更はここで新版の記録になり、pack で V3 へ転記される（旧→新の片方向）。
    mergeSpace(state, remote, V2_KEYS, true);
    mergeSpace(state, remote, KEYS, false);
  }

  function join(state, base, remote) {
    merge(state, remote);
    if (state.joined) return;
    const initial = { ...base };
    for (const key of LEGACY_FIELDS) {
      if (Object.hasOwn(remote, "settingsSyncV1." + key)) initial[key] = remote["settingsSyncV1." + key];
    }
    for (const [id, value] of Object.entries(snapshot(initial))) {
      state.records[id] ||= { value, stamp: [0, 0, state.device] };
    }
    state.joined = true;
  }

  function project(state, base) {
    const out = SettingsSchema.normalize(base);
    out.autoTranslateBlacklist = [];
    out.reasoningEfforts = {};
    for (const id of Object.keys(state.records).sort()) {
      const r = state.records[id], p = pathOf(id);
      if (!applicable(p, r)) continue;
      if (p.length === 1) out[p[0]] = r.value;
      else if (p[0] === "models") out.models[p[1]] = r.value;
      else if (p[0] === "reasoningEfforts") (out.reasoningEfforts[p[1]] ||= {})[p[2]] = r.value;
      else out.autoTranslateBlacklist.push(p[1]);
    }
    // 旧版の廃止値（casual→natural 等）や未知の列挙値は、ここの正規化で表示値へ落とす。記録自体は保持する。
    return SettingsSchema.normalize(out);
  }

  // 送信内容は V3 のバケットだけ。保持している未知IDの記録も含めて丸ごと書く。
  function pack(state) {
    const data = {};
    for (const id of Object.keys(state.records).sort()) {
      const key = KEYS[bucketIndex(id)];
      (data[key] ||= { version: 2, items: {} }).items[id] = state.records[id];
    }
    return data;
  }

  // chrome.storage.sync の上限（1項目8192バイト・合計102400バイト）を送信前に確かめる。
  // remote には今回読んだ同期領域（V2・未撤去の V1・V3）を渡す。V2 と V1 は新版が消せないため、
  // 今回書き換えない項目のバイトも合計へ含め、実際の保存時と同じ判定にする。項目数は
  // V3 64 + V2 64 + V1 17 で上限512に収まる。
  function checkQuota(data, remote = {}) {
    const encoder = new TextEncoder();
    const sizeOf = (key, value) => encoder.encode(key + JSON.stringify(value)).length;
    let total = 0;
    for (const [key, value] of Object.entries(data)) {
      const size = sizeOf(key, value);
      if (size > 8192) throw new Error("settings_sync_quota");
      total += size;
    }
    for (const [key, value] of Object.entries(remote)) {
      if (!Object.hasOwn(data, key) && value !== undefined) total += sizeOf(key, value);
    }
    if (total > 102400) throw new Error("settings_sync_quota");
  }

  // storage.sync の変更通知のうち、同期の再収束が必要なキーか（V3 と、旧版端末が書く V2）。
  function isSyncKey(key) {
    return typeof key === "string" && (key.startsWith(PREFIX) || key.startsWith(V2_PREFIX));
  }

  globalThis.SettingsSync = Object.freeze({ PREFIX, V2_PREFIX, STATE_KEY, STATUS_KEY, ALARM, KEYS, V2_KEYS, LEGACY_KEYS,
    snapshot, equal, fresh, restore, recordChanges, join, project, pack, checkQuota, isSyncKey });
})();
