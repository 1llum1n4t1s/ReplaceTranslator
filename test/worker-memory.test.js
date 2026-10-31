"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { setImmediate } = require("node:timers/promises");
const workerHarness = require("./_worker-harness");

const deferredMemoryRead = () => {
  const reads = [];
  return {
    reads,
    localGet(keys, get) {
      if (!Array.isArray(keys) || !keys.includes("batchTuning")) return get(keys);
      return new Promise((resolve, reject) => {
        reads.push({ resolve: () => resolve(get(keys)), reject });
      });
    },
  };
};

const translate = (h, text) => h.send({ action: "TRANSLATE_BATCH", quick: true, texts: [text] });
const initial = { provider: "openai", apiKeys: { openai: "test-key" } };

test("起動先読みと並行翻訳は集計メモリの初回読込を共有し、保存値を保持する", async () => {
  const read = deferredMemoryRead();
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  let apiCalls = 0;
  const h = workerHarness({ ...read, disk: { settings: initial,
    tokenUsage: { [month]: { openai: { input: 100, output: 200 } } } },
  fetchResponse: async url => {
    if (!new URL(url).pathname.endsWith("/chat/completions")) return null;
    apiCalls++;
    return Response.json({ choices: [{ message: { content: '{"translations":["翻訳"]}' } }],
      usage: { prompt_tokens: 2, completion_tokens: 3 } });
  } });
  const pending = [translate(h, "first"), translate(h, "second")];
  await setImmediate();
  assert.equal(read.reads.length, 1);
  assert.equal(apiCalls, 0);
  read.reads[0].resolve();
  assert.ok((await Promise.all(pending)).every(result => result.ok));
  assert.equal((await translate(h, "third")).ok, true);
  assert.equal(apiCalls, 3);
  assert.equal(read.reads.length, 1);
  await h.suspend();
  assert.deepEqual(h.disk.tokenUsage[month].openai, { input: 106, output: 209 });
});

test("集計メモリの共有読込が失敗しても次の翻訳で再試行できる", async () => {
  const read = deferredMemoryRead();
  const h = workerHarness({ ...read, initial });
  const pending = [translate(h, "first"), translate(h, "second")];
  await setImmediate();
  assert.equal(read.reads.length, 1);
  read.reads[0].reject(new Error("storage unavailable"));
  assert.ok((await Promise.all(pending)).every(result => !result.ok));
  const retry = translate(h, "retry");
  await setImmediate();
  assert.equal(read.reads.length, 2);
  read.reads[1].resolve();
  assert.equal((await retry).ok, true);
  assert.equal((await translate(h, "warm")).ok, true);
  assert.equal(read.reads.length, 2);
});
