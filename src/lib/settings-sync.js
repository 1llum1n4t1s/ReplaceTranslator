"use strict";

// 同期レコードの比較・マージはブラウザーAPIから分離し、到着順に依存しない。
(function () {
  const PREFIX = "settingsSyncV2.";
  const STATE_KEY = "settingsSyncStateV2";
  const STATUS_KEY = StorageKeys.SETTINGS_SYNC_STATUS;
  const ALARM = "settings-sync-retry";
  const SCALARS = ["provider", "sourceLang", "targetLang", "autoTranslate", "showFab",
    "showImageButton", "selectionMode", "fabOpacity"];
  const LEGACY_FIELDS = [...SCALARS, "models", "reasoningEfforts", "autoTranslateBlacklist"];
  const LEGACY_KEYS = LEGACY_FIELDS.map(key => "settingsSyncV1." + key);
  const KEYS = Array.from({ length: 64 }, (_, index) => PREFIX + index);
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const idOf = (...parts) => JSON.stringify(parts);

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

  function pathOf(id) {
    try {
      const p = JSON.parse(id);
      if (!Array.isArray(p) || !p.every(key => typeof key === "string" && key.length <= 1000)) return null;
      if (JSON.stringify(p) !== id) return null;
      if (p.length === 1 && SCALARS.includes(p[0])) return p;
      if (p[0] === "models" && p.length === 2 && Providers.ids.includes(p[1])) return p;
      if (p[0] === "reasoningEfforts" && p.length === 3 && Providers.ids.includes(p[1]) &&
          p[2] && !["__proto__", "constructor", "prototype"].includes(p[2])) return p;
      if (p[0] === "autoTranslateBlacklist" && p.length === 2 && AutoTranslateBlacklist.normalize([p[1]])[0] === p[1]) return p;
    } catch (_e) { /* 不正なキーは受信しない */ }
    return null;
  }

  function validStamp(stamp) {
    return Array.isArray(stamp) && stamp.length === 3 &&
      Number.isSafeInteger(stamp[0]) && stamp[0] >= 0 && stamp[0] < 8640000000000000 &&
      Number.isSafeInteger(stamp[1]) && stamp[1] >= 0 && stamp[1] < Number.MAX_SAFE_INTEGER &&
      typeof stamp[2] === "string" && /^[a-z0-9-]{1,64}$/i.test(stamp[2]);
  }

  function validRecord(id, record) {
    const p = pathOf(id);
    if (!p || !record || typeof record !== "object" || !validStamp(record.stamp)) return false;
    if (record.deleted === true) return p[0] === "reasoningEfforts" || p[0] === "autoTranslateBlacklist";
    if (!Object.hasOwn(record, "value")) return false;
    const value = record.value;
    if (value !== null && !["string", "boolean", "number"].includes(typeof value)) return false;
    if (typeof value === "string" && value.length > 1000) return false;
    if (p[0] === "autoTranslateBlacklist") return value === true;
    const raw = p.length === 1 ? { [p[0]]: value } : p.length === 2
      ? { models: { [p[1]]: value } } : { reasoningEfforts: { [p[1]]: { [p[2]]: value } } };
    return equal(snapshot(raw)[id], value);
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

  function bucket(id) {
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = (Math.imul(hash, 31) + id.charCodeAt(i)) >>> 0;
    return KEYS[hash % KEYS.length];
  }

  function fresh(device) {
    return { version: 2, device, clock: [0, 0], joined: false, records: {}, pending: false, legacyCleanup: [] };
  }

  function observe(state, stamp) {
    if (stamp[0] > state.clock[0] || stamp[0] === state.clock[0] && stamp[1] > state.clock[1]) state.clock = stamp.slice(0, 2);
  }

  function restore(raw, device) {
    const state = fresh(raw?.version === 2 && validStamp([0, 0, raw.device]) ? raw.device : device);
    if (raw?.version !== 2) return state;
    state.joined = raw.joined === true;
    state.pending = raw.pending === true;
    if (Array.isArray(raw.legacyCleanup)) state.legacyCleanup = LEGACY_KEYS.filter(key => raw.legacyCleanup.includes(key));
    if (Array.isArray(raw.clock) && validStamp([...raw.clock, state.device])) state.clock = raw.clock.slice();
    for (const [id, record] of Object.entries(raw.records || {})) {
      if (!validRecord(id, record)) continue;
      state.records[id] = record.deleted ? { deleted: true, stamp: record.stamp.slice() } : { value: record.value, stamp: record.stamp.slice() };
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

  function merge(state, remote) {
    for (const key of KEYS) {
      const data = remote[key];
      if (data?.version !== 2 || !data.items || typeof data.items !== "object") continue;
      for (const [id, r] of Object.entries(data.items)) {
        if (bucket(id) !== key || !validRecord(id, r)) continue;
        if (!state.records[id] || compare(r, state.records[id]) > 0) {
          state.records[id] = r.deleted ? { deleted: true, stamp: r.stamp.slice() } : { value: r.value, stamp: r.stamp.slice() };
        }
        observe(state, r.stamp);
      }
    }
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
      if (!p || r.deleted) continue;
      if (p.length === 1) out[p[0]] = r.value;
      else if (p[0] === "models") out.models[p[1]] = r.value;
      else if (p[0] === "reasoningEfforts") (out.reasoningEfforts[p[1]] ||= {})[p[2]] = r.value;
      else out.autoTranslateBlacklist.push(p[1]);
    }
    return SettingsSchema.normalize(out);
  }

  function pack(state) {
    const data = {};
    for (const id of Object.keys(state.records).sort()) {
      const key = bucket(id);
      (data[key] ||= { version: 2, items: {} }).items[id] = state.records[id];
    }
    return data;
  }

  function checkQuota(data) {
    const encoder = new TextEncoder();
    let total = 0;
    for (const [key, value] of Object.entries(data)) {
      const size = encoder.encode(key + JSON.stringify(value)).length;
      if (size > 8192) throw new Error("settings_sync_quota");
      total += size;
    }
    if (total > 102400) throw new Error("settings_sync_quota");
  }

  globalThis.SettingsSync = Object.freeze({ PREFIX, STATE_KEY, STATUS_KEY, ALARM, KEYS, LEGACY_KEYS,
    snapshot, equal, fresh, restore, recordChanges, join, project, pack, checkQuota });
})();
