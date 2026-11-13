"use strict";

/**
 * 設定同期の旧版（v1.0.33）互換テスト。
 *
 * 旧版は `settingsSyncV2.` のバケットを、自分が知る項目・値だけで丸ごと書き戻す。新版が同じバケットへ
 * 旧版の知らない項目（言い換え設定）や値（gyaru）を書くと、新旧が互いに書き戻して往復が止まらなかった。
 * 新版は `settingsSyncV3.` にだけ書き、V2 は読むだけにした。ここでは次を確かめる。
 * - 旧版コード（test/fixtures/settings-sync-v1.0.33/ の逐語コピー）を別 vm で動かし、同じ模擬同期領域を共有させる
 * - 新版は実 SW（src/service_worker.js）の同期処理を切り出して動かし、sync.set / sync.remove を全件記録する
 * - realm をまたぐ値は JSON で受け渡し、比較も JSON 文字列で行う（deepEqual はプロトタイプ不一致で落ちるため）
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { SettingsSchema, StorageKeys, SettingsSync: S } = require("./_load-actions.js");

const source = fs.readFileSync(path.join(__dirname, "../src/service_worker.js"), "utf8");
const implementation = source.slice(source.indexOf("  async function saveSettings("), source.indexOf("  // 既存インストール移行 / SW 再起動時に CONTENT_FLAGS"));
const FIXTURE = path.join(__dirname, "fixtures", "settings-sync-v1.0.33");
const J = value => JSON.parse(JSON.stringify(value));
const same = (a, b) => assert.equal(JSON.stringify(a), JSON.stringify(b));
const V2 = "settingsSyncV2.", V3 = "settingsSyncV3.";

// 旧版・新版共通のバケット配置（ID の文字列ハッシュ % 64）。テストから同期領域へ直接記録を入れるために使う。
const bucketOf = function (prefix, id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (Math.imul(hash, 31) + id.charCodeAt(i)) >>> 0;
  return prefix + (hash % 64);
};
const inject = function (remote, prefix, id, record) {
  const key = bucketOf(prefix, id);
  const bucket = remote[key] = J(remote[key] || { version: 2, items: {} });
  bucket.items[id] = record;
};
const pick = (remote, keys) => J(Object.fromEntries(keys.filter(key => Object.hasOwn(remote, key)).map(key => [key, remote[key]])));
const v2Snapshot = remote => JSON.stringify(Object.keys(remote).filter(key => key.startsWith(V2)).sort().map(key => [key, remote[key]]));

// ---- 旧版端末（v1.0.33）。fixture を独立した vm で読み、旧 SW の同期 API 呼び出し3種を模擬する ----
const oldDevice = function (remote, device) {
  const ctx = vm.createContext({ TextEncoder, URL, console });
  ctx.globalThis = ctx;
  for (const file of ["actions.js", "translation-core.js", "settings-sync.js"]) {
    vm.runInContext(fs.readFileSync(path.join(FIXTURE, file), "utf8"), ctx, { filename: file });
  }
  const OS = ctx.SettingsSync;
  const me = {
    ctx, writes: 0, removes: [],
    state: OS.fresh(device),
    base: ctx.SettingsSchema.normalize({ syncSettings: true }),
    // 旧 SW: get(KEYS + LEGACY) → join → project → pack → set(差分) → remove(settingsSyncV1.*)
    sync() {
      const state = J(me.state);
      const got = pick(remote, [...OS.KEYS, ...(!state.joined ? OS.LEGACY_KEYS : state.legacyCleanup)]);
      OS.join(state, me.base, got);
      const projected = OS.project(state, me.base);
      const desired = J(OS.pack(state));
      const uploads = Object.fromEntries(Object.entries(desired).filter(([key, value]) => !OS.equal(value, got[key])));
      const legacy = OS.LEGACY_KEYS.filter(key => Object.hasOwn(got, key));
      if (Object.keys(uploads).length) { Object.assign(remote, J(uploads)); me.writes++; }
      for (const key of legacy) { delete remote[key]; me.removes.push(key); }
      state.legacyCleanup = [];
      me.state = J(state); me.base = J(projected);
      return Object.keys(uploads).length;
    },
    change(patch, at) {
      const next = ctx.SettingsSchema.mergePatch(me.base, patch);
      OS.recordChanges(me.state, me.base, next, at);
      me.base = J(next);
    },
  };
  return me;
};

// ---- 新版端末。実 SW の同期処理を切り出して動かし、同期 API 呼び出しを全件記録する ----
const newDevice = function (remote, device, { local, time = 100 } = {}) {
  const disk = local ? J(local) : { [StorageKeys.SETTINGS]: SettingsSchema.normalize({}) };
  const sets = [], removes = [];
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
      alarms: { create: async () => {}, clear: async () => {}, onAlarm: { addListener: () => {} } },
      storage: {
        local: {
          get: async key => ({ [key]: structuredClone(disk[key]) }),
          set: async data => { Object.assign(disk, structuredClone(data)); },
        },
        sync: {
          get: async keys => pick(remote, keys),
          set: async data => { S.checkQuota(data); sets.push(Object.keys(data)); Object.assign(remote, J(data)); },
          remove: async keys => { removes.push([...keys]); for (const key of keys) delete remote[key]; },
        },
      },
    },
  });
  const me = {
    ...api, disk, sets, removes,
    settings: () => disk[StorageKeys.SETTINGS],
    state: () => disk[S.STATE_KEY],
    time: v => { time = v; },
    // 新版は V2 のキーを一度も set / remove しない（検証3）。
    assertNoV2Writes() {
      for (const keys of [...sets, ...removes]) {
        assert.equal(keys.some(key => key.startsWith(V2)), false, `V2 へ書いた: ${keys.join(",")}`);
      }
    },
    sync: async () => { const before = sets.length; await api.receiveSyncedSettings(); return sets.length - before; },
  };
  return me;
};

// 全端末を順に同期し、1ラウンドで同期領域へ書いた端末数を返す。
const round = async function (devices) {
  let writes = 0;
  for (const d of devices) writes += d.ctx ? (d.sync() ? 1 : 0) : (await d.sync() ? 1 : 0);
  return writes;
};
// 数ラウンド以内に「全端末の書込みがゼロ」のラウンドへ到達することを確かめる。
const settle = async function (devices, limit = 4) {
  const log = [];
  for (let i = 0; i < limit; i++) {
    const writes = await round(devices);
    log.push(writes);
    if (writes === 0) {
      // 収束後にもう1ラウンド回しても誰も書かない（往復していない）。
      assert.equal(await round(devices), 0, `収束後に再び書込みが発生: ${log.join(",")}`);
      return log;
    }
  }
  assert.fail(`${limit}ラウンドで収束しない（各ラウンドの書込み端末数: ${log.join(",")}）`);
};

const setup = async function () {
  const remote = {};
  const n1 = newDevice(remote, "device-n1"), o = oldDevice(remote, "device-o"), n2 = newDevice(remote, "device-n2");
  await n1.applySettingsPatch({ syncSettings: true });
  o.sync();
  await n2.applySettingsPatch({ syncSettings: true });
  await settle([n1, o, n2]);
  return { remote, n1, o, n2, all: [n1, o, n2] };
};

test("新版の言い換え設定・gyaru の変更は旧版と往復せず、数ラウンドで全端末の書込みがゼロになる", async () => {
  const { remote, n1, o, n2, all } = await setup();
  const v2Before = v2Snapshot(remote);
  n1.time(1000);
  await n1.applySettingsPatch({ rewriteMode: true, rewriteStyle: "gyaru", translationStyle: "gyaru" });
  await settle(all);
  for (const d of [n1, n2]) {
    assert.equal(d.settings().rewriteMode, true);
    assert.equal(d.settings().rewriteStyle, "gyaru");
    assert.equal(d.settings().translationStyle, "gyaru");
  }
  // 新版での変更は旧版へ届かない（受け入れた制約）。旧版は自分の設定のまま安定する。
  assert.equal(o.base.translationStyle, "natural");
  assert.equal(v2Snapshot(remote), v2Before, "新版の変更で V2 が書き換わった");
  for (const d of [n1, n2]) d.assertNoV2Writes();
});

test("旧版の casual・targetLang の変更は新版へ取り込まれ（casual は natural 表示）、往復しない", async () => {
  const { remote, n1, o, n2, all } = await setup();
  o.change({ translationStyle: "casual", targetLang: "en" }, 2000);
  await settle(all);
  for (const d of [n1, n2]) {
    assert.equal(d.settings().translationStyle, "natural");
    assert.equal(d.settings().targetLang, "en");
    // 記録は旧版の値のまま保持する（正規化で値が変わる記録を拒否しない）。
    assert.equal(d.state().records['["translationStyle"]'].value, "casual");
    same(d.state().records['["translationStyle"]'].stamp, [2000, 0, "device-o"]);
  }
  // 旧版端末の変更は新版が V3 へ転記し、新版同士はそこから受け取る。
  assert.equal(remote[bucketOf(V3, '["targetLang"]')].items['["targetLang"]'].value, "en");
  assert.equal(o.base.translationStyle, "casual");
  // その後に新版で変更しても、旧版の V2 はそのまま（新版は V2 を読むだけ）。
  n2.time(3000);
  await n2.applySettingsPatch({ translationStyle: "formal" });
  await settle(all);
  assert.equal(n1.settings().translationStyle, "formal");
  assert.equal(o.base.translationStyle, "casual");
  for (const d of [n1, n2]) d.assertNoV2Writes();
});

test("新版は V2 のキーを一度も set / remove しない（旧版の書込み・開発版の残骸・V1 撤去を含む）", async () => {
  const remote = { "settingsSyncV1.targetLang": "fr" };
  // 開発版が V2 に書いた rewriteMode が残っている状態から始める。
  inject(remote, V2, '["rewriteMode"]', { value: true, stamp: [500, 0, "device-dev"] });
  const n1 = newDevice(remote, "device-n1"), o = oldDevice(remote, "device-o");
  await n1.applySettingsPatch({ syncSettings: true });
  o.sync();
  await settle([n1, o]);
  o.change({ translationStyle: "literal" }, 2000);
  await settle([n1, o]);
  n1.time(3000);
  await n1.applySettingsPatch({ rewriteStyle: "toxic", translationStyle: "gyaru" });
  await settle([n1, o]);
  assert.equal(n1.settings().rewriteMode, true);
  assert.equal(n1.settings().translationStyle, "gyaru");
  assert.equal(Object.hasOwn(remote, "settingsSyncV1.targetLang"), false, "V1 は従来どおり撤去する");
  n1.assertNoV2Writes();
  // V1 の撤去（旧試作キー）は V2 とは別扱い。remove したのは V1 だけ。
  assert.ok(n1.removes.flat().every(key => key.startsWith("settingsSyncV1.")));
  assert.ok(n1.sets.flat().every(key => key.startsWith(V3)));
});

test("V3 の未知IDは保持・再送して設定へ反映せず、apiKeys は拒否する", async () => {
  const { remote, n1, n2, all } = await setup();
  const future = [
    ['["futureFeature"]', { value: "x", stamp: [5000, 0, "device-future"] }],
    ['["models","futureprovider"]', { value: "future-model", stamp: [5000, 0, "device-future"] }],
    ['["reasoningEfforts","futureprovider","m"]', { value: "high", stamp: [5000, 0, "device-future"] }],
    ['["rewriteStyle"]', { value: "pirate", stamp: [5000, 0, "device-future"], note: "future-field" }],
    ['["targetLang"]', { deleted: true, stamp: [5000, 0, "device-future"] }],
  ];
  for (const [id, record] of future) inject(remote, V3, id, record);
  inject(remote, V3, '["apiKeys","openai"]', { value: "remote-test-key", stamp: [5000, 0, "device-future"] });
  inject(remote, V3, '["syncSettings"]', { value: false, stamp: [5000, 0, "device-future"] });
  await settle(all);
  for (const d of [n1, n2]) {
    for (const [id, record] of future) same(d.state().records[id], record);
    assert.equal(Object.hasOwn(d.state().records, '["apiKeys","openai"]'), false);
    assert.equal(Object.hasOwn(d.state().records, '["syncSettings"]'), false);
    assert.equal(Object.hasOwn(d.settings(), "futureFeature"), false);
    assert.equal(Object.hasOwn(d.settings().models, "futureprovider"), false);
    assert.equal(d.settings().rewriteStyle, "mild", "未知の値は正規化で既定値を表示");
    assert.equal(d.settings().targetLang, "ja", "既知スカラーの削除記録は保持するだけで適用しない");
    assert.equal(d.settings().apiKeys.openai, "");
    assert.equal(d.settings().syncSettings, true);
  }
  // 未知IDは V3 に原形のまま残る（新版が書き戻しても消えない）。
  for (const [id, record] of future) same(remote[bucketOf(V3, id)].items[id], record);
  // 同期領域から消えても、保持していた端末が再送する。
  delete remote[bucketOf(V3, '["futureFeature"]')].items['["futureFeature"]'];
  await settle(all);
  same(remote[bucketOf(V3, '["futureFeature"]')].items['["futureFeature"]'], future[0][1]);
  // SW 再起動（local state からの復元）後も保持したまま、書込みゼロで安定する。
  const restarted = newDevice(remote, "unused-id", { local: n1.disk, time: 9000 });
  assert.equal(await restarted.sync(), 0);
  same(restarted.state().records['["futureFeature"]'], future[0][1]);
  // 同期領域には本テスト自身が鍵入りの記録を注入しているので、取り込み側 (端末) に入らないことだけを確かめる。
  assert.equal(JSON.stringify(n1.disk).includes("remote-test-key"), false, "同期領域の apiKeys 記録を端末へ取り込まない");
  for (const d of [n1, n2, restarted]) d.assertNoV2Writes();
});

test("新版同士は V3 経由で双方向に収束し、削除した除外ルール・推論量は古い値の再受信でも復活しない", async () => {
  const { remote, n1, n2, all } = await setup();
  n1.time(1000);
  await n1.applySettingsPatch({ autoTranslateBlacklist: ["a.example"], reasoningEfforts: { openai: { "custom-a": "low" } } });
  await settle(all);
  assert.deepEqual(n2.settings().autoTranslateBlacklist, ["a.example"]);
  assert.equal(n2.settings().reasoningEfforts.openai["custom-a"], "low");
  const stale = J(remote);
  n2.time(2000);
  await n2.applySettingsPatch({ autoTranslateBlacklist: [], reasoningEfforts: { openai: { "custom-a": null } }, targetLang: "de" });
  await settle(all);
  // 古い同期領域が後着しても削除記録が勝つ。
  Object.assign(remote, stale);
  await settle(all);
  for (const d of [n1, n2]) {
    assert.deepEqual(d.settings().autoTranslateBlacklist, []);
    assert.equal(d.settings().reasoningEfforts.openai?.["custom-a"], undefined);
    assert.equal(d.settings().targetLang, "de");
    d.assertNoV2Writes();
  }
});

test("v1.0.33 の local state を持つ端末をアップグレードすると、記録を失わず V3 へ移行する", async () => {
  const remote = {};
  const o = oldDevice(remote, "device-up");
  o.sync();
  o.change({ translationStyle: "literal", targetLang: "fr", autoTranslateBlacklist: ["old.example"] }, 700);
  o.sync();
  const oldState = J(o.state), v2Before = v2Snapshot(remote);
  // 旧版が保存した設定と同期状態をそのまま local に持つ端末を、新版のコードで起動する。
  const up = newDevice(remote, "unused-id", { time: 9000,
    local: { [StorageKeys.SETTINGS]: J(o.base), [S.STATE_KEY]: oldState } });
  await up.sync();
  assert.equal(up.state().device, "device-up", "端末IDを引き継ぐ");
  for (const [id, record] of Object.entries(oldState.records)) {
    same(up.state().records[id], record);
    same(remote[bucketOf(V3, id)].items[id], record);
  }
  assert.equal(up.settings().translationStyle, "natural");
  assert.equal(up.settings().targetLang, "fr");
  assert.deepEqual(up.settings().autoTranslateBlacklist, ["old.example"]);
  assert.equal(v2Snapshot(remote), v2Before, "移行で V2 を消さない・書き換えない");
  assert.equal(await up.sync(), 0, "移行後は書込みゼロ");
  up.assertNoV2Writes();
});

test("新版の state を旧版へ戻しても壊れず、再アップグレードで V3 の記録が戻る", async () => {
  const { remote, n1, all } = await setup();
  n1.time(1000);
  await n1.applySettingsPatch({ rewriteMode: true, translationStyle: "gyaru" });
  inject(remote, V3, '["futureFeature"]', { value: "x", stamp: [5000, 0, "device-future"] });
  await settle(all);
  // 旧版へ戻す: 新版が書いた state を旧版の restore → join → project → pack に通す。
  const o = oldDevice(remote, "unused-old-id");
  o.state = o.ctx.SettingsSync.restore(J(n1.state()), "unused-old-id");
  o.base = J(o.ctx.SettingsSchema.normalize(n1.settings()));
  assert.doesNotThrow(() => o.sync());
  assert.equal(o.state.device, "device-n1", "旧版でも端末IDを引き継ぐ");
  assert.equal(Object.hasOwn(o.state.records, '["futureFeature"]'), false);
  assert.equal(o.base.translationStyle, "natural");
  // 旧版が保存し直した state で新版を再起動すると、V3 の記録が戻り書込みゼロで落ち着く。
  const again = newDevice(remote, "unused-id", { time: 9000,
    local: { [StorageKeys.SETTINGS]: SettingsSchema.normalize({ ...J(o.base), syncSettings: true }), [S.STATE_KEY]: J(o.state) } });
  await again.sync();
  assert.equal(again.state().device, "device-n1");
  assert.equal(again.state().records['["futureFeature"]'].value, "x");
  assert.equal(again.settings().translationStyle, "gyaru");
  assert.equal(again.settings().rewriteMode, true);
  assert.equal(await again.sync(), 0);
  again.assertNoV2Writes();
});

test("容量判定は書き換えない V2・V1 の残量も合計へ含める", () => {
  const big = { version: 2, items: { '["customPrompt"]': { value: "x".repeat(7000), stamp: [1, 0, "a"] } } };
  const remote = Object.fromEntries(Array.from({ length: 14 }, (_, i) => [V2 + i, big]));
  const desired = { [V3 + "0"]: big };
  assert.doesNotThrow(() => S.checkQuota(desired));
  assert.throws(() => S.checkQuota(desired, remote), /settings_sync_quota/);
  // 今回送るバケットと同名の既存値は二重に数えない。
  assert.doesNotThrow(() => S.checkQuota(desired, { [V3 + "0"]: big }));
});
