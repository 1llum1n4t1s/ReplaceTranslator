"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { SettingsSchema, StorageKeys, SettingsSync: S } = require("./_load-actions.js");
const source = fs.readFileSync(path.join(__dirname, "../src/service_worker.js"), "utf8");
const implementation = source.slice(source.indexOf("  async function saveSettings("), source.indexOf("  // 既存インストール移行 / SW 再起動時に CONTENT_FLAGS"));

const harness = ({ initial = {}, remote = {}, local, device = "device-a", time = 100 } = {}) => {
  const disk = local || { [StorageKeys.SETTINGS]: SettingsSchema.normalize(initial) };
  const writes = [], localWrites = [];
  let failSync = false, failLocal = false, failUpload = false, failRemove = false, reads = 0, alarm = null, listener, beforeGet;
  const get = async () => structuredClone(disk[StorageKeys.SETTINGS]);
  const api = vm.runInNewContext(`(() => {
    let settingsMem = null;
    let persistentTranslationCacheEnabled = false;
    ${implementation}
    return { applySettingsPatch, receiveSyncedSettings };
  })()`, {
    SettingsSchema, SettingsSync: S, StorageKeys, structuredClone,
    Date: { now: () => time }, crypto: { randomUUID: () => device },
    getSettings: get, getSettingsCached: get,
    contentFlagsOf: s => ({ showFab: s.showFab }), syncPersistentTranslationCache: async () => {},
    chrome: {
      alarms: { create: async name => { alarm = name; }, clear: async () => { alarm = null; }, onAlarm: { addListener: fn => { listener = fn; } } },
      storage: {
        local: {
          get: async key => ({ [key]: structuredClone(disk[key]) }),
          set: async data => {
            if (failLocal && Object.hasOwn(data, StorageKeys.SETTINGS)) throw Error("local quota");
            localWrites.push(structuredClone(data)); Object.assign(disk, structuredClone(data));
          },
        },
        sync: {
          get: async keys => {
            reads++; if (beforeGet) await beforeGet();
            if (failSync) throw Error("offline");
            return structuredClone(Object.fromEntries(keys.filter(key => Object.hasOwn(remote, key)).map(key => [key, remote[key]])));
          },
          set: async data => { if (failSync || failUpload) throw Error("quota"); S.checkQuota(data); writes.push(structuredClone(data)); Object.assign(remote, structuredClone(data)); },
          remove: async keys => { if (failRemove) throw Error("remove failure"); for (const key of keys) delete remote[key]; },
        },
      },
    },
  });
  return { ...api, remote, disk, writes, localWrites, listener: () => listener, alarm: () => alarm,
    reads: () => reads, settings: () => disk[StorageKeys.SETTINGS],
    failUpload: v => { failUpload = v; }, failRemove: v => { failRemove = v; },
    failSync: v => { failSync = v; }, failLocal: v => { failLocal = v; }, time: v => { time = v; }, beforeGet: fn => { beforeGet = fn; } };
};

test("OFFは同期通信せず、明示trueだけ有効", async () => {
  for (const v of [undefined, false, "true", 1]) assert.equal(SettingsSchema.normalize({ syncSettings: v }).syncSettings, false);
  const h = harness(); await h.receiveSyncedSettings(); await h.applySettingsPatch({ targetLang: "en" });
  assert.equal(h.reads(), 0); assert.equal(h.writes.length, 0);
});

test("V1を初参加時だけ取り込み、V2保存後に旧キーを撤去する", async () => {
  const h = harness({ initial: { apiKeys: { openai: "local-test-key" }, persistentTranslationCache: true },
    remote: { "settingsSyncV1.targetLang": "fr", "settingsSyncV1.apiKeys": { openai: "remote-test-key" } } });
  await h.applySettingsPatch({ syncSettings: true });
  assert.equal(h.settings().targetLang, "fr"); assert.equal(h.settings().apiKeys.openai, "local-test-key");
  assert.equal(h.settings().persistentTranslationCache, true);
  assert.equal(Object.hasOwn(h.remote, "settingsSyncV1.targetLang"), false);
  assert.equal(JSON.stringify(h.writes).includes("test-key"), false);
});

test("古い同期値が後着しても新しい更新を保持して同期先を修復する", async () => {
  const remote = {}, a = harness({ remote }); await a.applySettingsPatch({ syncSettings: true });
  const old = structuredClone(remote); a.time(200); await a.applySettingsPatch({ targetLang: "en" });
  Object.assign(remote, old); await a.receiveSyncedSettings(); assert.equal(a.settings().targetLang, "en");
  const b = harness({ remote, device: "device-b" }); await b.applySettingsPatch({ syncSettings: true });
  assert.equal(b.settings().targetLang, "en");
});

test("別PCのプロバイダ別モデル・モデル別推論量・別ルールの変更は両方残る", async () => {
  const remote = {}, a = harness({ remote }), b = harness({ remote, device: "device-b" });
  await a.applySettingsPatch({ syncSettings: true }); await b.applySettingsPatch({ syncSettings: true });
  a.failSync(true); b.failSync(true);
  await a.applySettingsPatch({ models: { ...a.settings().models, openai: "custom-a" },
    reasoningEfforts: { openai: { "custom-a": "low" } }, autoTranslateBlacklist: ["a.example"] });
  await b.applySettingsPatch({ models: { ...b.settings().models, gemini: "custom-b" },
    reasoningEfforts: { gemini: { "custom-b": "high" } }, autoTranslateBlacklist: ["b.example"] });
  a.failSync(false); b.failSync(false);
  await b.receiveSyncedSettings(); await a.receiveSyncedSettings(); await b.receiveSyncedSettings();
  for (const h of [a, b]) {
    assert.equal(h.settings().models.openai, "custom-a"); assert.equal(h.settings().models.gemini, "custom-b");
    assert.equal(h.settings().reasoningEfforts.openai["custom-a"], "low"); assert.equal(h.settings().reasoningEfforts.gemini["custom-b"], "high");
    assert.deepEqual(h.settings().autoTranslateBlacklist, ["a.example", "b.example"]);
  }
});

test("除外ルール・推論量の削除は古い値の再受信でも復活しない", async () => {
  const h = harness(); await h.applySettingsPatch({ syncSettings: true });
  await h.applySettingsPatch({ autoTranslateBlacklist: ["a.example"], reasoningEfforts: { openai: { "custom-a": "low" } } });
  const old = structuredClone(h.remote);
  await h.applySettingsPatch({ autoTranslateBlacklist: [], reasoningEfforts: { openai: { "custom-a": null } } });
  Object.assign(h.remote, old); await h.receiveSyncedSettings();
  assert.deepEqual(h.settings().autoTranslateBlacklist, []);
  assert.equal(h.settings().reasoningEfforts.openai?.["custom-a"], undefined);
  assert.ok(Object.values(h.disk[S.STATE_KEY].records).some(r => r.deleted));
});

test("同時刻と時計逆行でもカウンターが進み、端末IDで同時編集を決着する", () => {
  const base = SettingsSchema.normalize({}), a = S.fresh("a"), b = S.fresh("b");
  S.join(a, base, {}); S.join(b, base, {});
  S.recordChanges(a, base, { ...base, targetLang: "en" }, 100); S.recordChanges(b, base, { ...base, targetLang: "fr" }, 100);
  const pa = S.pack(a), pb = S.pack(b); S.join(a, base, pb); S.join(b, base, pa);
  assert.equal(S.project(a, base).targetLang, "fr"); assert.equal(S.project(b, base).targetLang, "fr");
  S.recordChanges(a, S.project(a, base), { ...base, targetLang: "de" }, 10);
  assert.deepEqual(a.clock, [100, 1]); S.join(b, base, S.pack(a)); assert.equal(S.project(b, base).targetLang, "de");
});

test("オフライン変更をlocalへ保存し、再起動後も同じstampで再送する", async () => {
  const h = harness(); await h.applySettingsPatch({ syncSettings: true }); h.failSync(true);
  h.time(300); await h.applySettingsPatch({ targetLang: "en" });
  const record = structuredClone(h.disk[S.STATE_KEY].records['["targetLang"]']);
  assert.equal(h.settings().targetLang, "en"); assert.equal(h.disk[S.STATUS_KEY], "error"); assert.equal(h.alarm(), S.ALARM);
  const restarted = harness({ local: h.disk, remote: h.remote, device: "new-unused-id", time: 999 });
  await restarted.receiveSyncedSettings();
  assert.deepEqual(restarted.disk[S.STATE_KEY].records['["targetLang"]'], record);
  assert.equal(restarted.disk[S.STATUS_KEY], "synced"); assert.equal(restarted.alarm(), null);
});

test("local保存失敗では同期先を変更しない", async () => {
  const h = harness(); await h.applySettingsPatch({ syncSettings: true });
  const old = structuredClone(h.remote); h.failLocal(true);
  await assert.rejects(h.applySettingsPatch({ targetLang: "en" }), /local quota/);
  assert.deepEqual(h.remote, old); assert.equal(h.settings().targetLang, "ja");
});

test("同期有効中の端末専用設定では同期APIを呼ばない", async () => {
  const h = harness(); await h.applySettingsPatch({ syncSettings: true }); const reads = h.reads(); h.failSync(true);
  await h.applySettingsPatch({ apiKeys: { openai: "local-test-key" }, persistentTranslationCache: true });
  assert.equal(h.reads(), reads); assert.equal(h.settings().apiKeys.openai, "local-test-key");
  assert.equal(h.settings().persistentTranslationCache, true); assert.equal(h.disk[S.STATUS_KEY], "synced");
});

test("同値通知では設定とcontentフラグを再保存しない", async () => {
  const h = harness(); await h.applySettingsPatch({ syncSettings: true });
  const saves = () => h.localWrites.filter(d => Object.hasOwn(d, StorageKeys.SETTINGS)).length;
  const before = saves(); await h.receiveSyncedSettings(); await h.receiveSyncedSettings(); assert.equal(saves(), before);
});

test("同期読込中のOFF要求は反映・送信を止め、再試行アラームも解除する", async () => {
  const h = harness(); await h.applySettingsPatch({ syncSettings: true });
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  h.beforeGet(async () => { entered(); await gate; });
  const receiving = h.receiveSyncedSettings(); await started;
  const off = h.applySettingsPatch({ syncSettings: false }); release(); await receiving; await off;
  assert.equal(h.settings().syncSettings, false); assert.equal(h.alarm(), null);
  const reads = h.reads(); await h.receiveSyncedSettings(); assert.equal(h.reads(), reads);
});

test("容量超過でも設定と更新情報を保持し、再試行待ちを表示する", async () => {
  const h = harness(); await h.applySettingsPatch({ syncSettings: true });
  await h.applySettingsPatch({ autoTranslateBlacklist: Array.from({ length: 500 }, (_, i) => `${"x".repeat(800)}${i}.example`) });
  assert.equal(h.settings().autoTranslateBlacklist.length, 500);
  assert.equal(h.disk[S.STATUS_KEY], "error"); assert.equal(h.alarm(), S.ALARM);
});

test("未知キー・不正stamp・秘密情報は同期レコードに取り込まない", () => {
  const state = S.restore({ version: 2, device: "a", records: {
    '["apiKeys","openai"]': { value: "secret", stamp: [1, 0, "a"] },
    '["targetLang"]': { value: "en", stamp: [-1, 0, "a"] },
    '["reasoningEfforts","openai","__proto__"]': { value: "high", stamp: [1, 0, "a"] },
  } }, "b");
  assert.equal(Object.keys(state.records).length, 0);
});

test("古いpopupからの差分は他のモデル・推論量・除外ルールを巻き戻さない", () => {
  const base = SettingsSchema.normalize({ models: { openai: "remote-model" },
    reasoningEfforts: { openai: { "remote-model": "high" } }, autoTranslateBlacklist: ["remote.example", "remove.example"] });
  const next = SettingsSchema.mergePatch(base, { models: { gemini: "local-model" },
    reasoningEfforts: { openai: { "local-model": "low" } },
    autoTranslateBlacklistChanges: { add: ["local.example"], remove: ["remove.example"] } });
  assert.equal(next.models.openai, "remote-model");
  assert.equal(next.reasoningEfforts.openai["remote-model"], "high");
  assert.equal(next.reasoningEfforts.openai["local-model"], "low");
  assert.deepEqual(next.autoTranslateBlacklist, ["remote.example", "local.example"]);
});

test("V2送信と旧キー削除の失敗は再起動後に完了できる", async () => {
  for (const fail of ["failUpload", "failRemove"]) {
    const h = harness({ remote: { "settingsSyncV1.targetLang": "fr" } }); h[fail](true);
    await h.applySettingsPatch({ syncSettings: true });
    assert.equal(h.settings().targetLang, "fr");
    assert.equal(h.remote["settingsSyncV1.targetLang"], "fr");
    assert.equal(h.disk[S.STATUS_KEY], "error");
    const restarted = harness({ local: h.disk, remote: h.remote });
    await restarted.receiveSyncedSettings();
    assert.equal(Object.hasOwn(h.remote, "settingsSyncV1.targetLang"), false);
    assert.equal(h.disk[S.STATUS_KEY], "synced");
    assert.deepEqual(h.disk[S.STATE_KEY].legacyCleanup, []);
  }
});

test("アラームと同期イベントから再収束処理へ接続する", async () => {
  const h = harness(); await h.applySettingsPatch({ syncSettings: true }); h.failUpload(true);
  await h.applySettingsPatch({ targetLang: "en" }); assert.equal(h.disk[S.STATUS_KEY], "error");
  h.failUpload(false); h.listener()({ name: S.ALARM });
  await h.applySettingsPatch(() => null); // イベントで投入した処理の完了を待つ
  assert.equal(h.disk[S.STATUS_KEY], "synced");
  let listener, received = 0;
  const start = source.search(/  try \{\r?\n    chrome\.storage\.onChanged/);
  const end = source.indexOf("  // ---- fetch", start);
  assert.ok(start >= 0 && end > start);
  vm.runInNewContext(source.slice(start, end), {
    SettingsSync: S, StorageKeys, settingsMem: null, refreshActiveAutoTranslateSiteMenu: () => {},
    receiveSyncedSettings: async () => { received++; },
    chrome: { storage: { onChanged: { addListener: fn => { listener = fn; } } } },
  });
  listener({ unrelated: { newValue: 1 } }, "sync");
  listener({ [S.KEYS[0]]: { newValue: {} } }, "local"); assert.equal(received, 0);
  listener({ [S.KEYS[0]]: { newValue: {} } }, "sync"); assert.equal(received, 1);
});

test("V2だけの初参加では同期側のルールと推論量を復活させず優先する", async () => {
  const remote = {}, a = harness({ remote }); await a.applySettingsPatch({ syncSettings: true });
  await a.applySettingsPatch({ autoTranslateBlacklistChanges: { add: ["x.example"] } });
  await a.applySettingsPatch({ autoTranslateBlacklistChanges: { remove: ["x.example"] } });
  const b = harness({ remote, device: "device-b", initial: { autoTranslateBlacklist: ["x.example"] } });
  await b.applySettingsPatch({ syncSettings: true });
  assert.deepEqual(b.settings().autoTranslateBlacklist, []);
});
