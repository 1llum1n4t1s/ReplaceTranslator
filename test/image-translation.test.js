"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ProviderApi } = require("./_load-actions");
const workerHarness = require("./_worker-harness");

const visionProviders = ["openai", "anthropic", "gemini", "openrouter", "groq"];
const block = { original: "Hello", translation: "こんにちは", box: { x: 0.1, y: 0.2, w: 0.5, h: 0.1 } };
const rowFor = provider => provider === "gemini" ? { ...block, box_2d: [200, 100, 300, 600] } : block;
const envelope = (provider, content, truncated = false) => {
  if (provider === "anthropic") return { content: [{ type: "text", text: content }],
    stop_reason: truncated ? "max_tokens" : "end_turn", usage: { input_tokens: 10, output_tokens: 20 } };
  if (provider === "gemini") return { candidates: [{ content: { parts: [{ text: content }] },
    finishReason: truncated ? "MAX_TOKENS" : "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 } };
  return { choices: [{ message: { content }, finish_reason: truncated ? "length" : "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 20 } };
};

test("画像応答: 全visionプロバイダで正常な空配列・不正応答・打ち切りを区別する", () => {
  for (const provider of visionProviders) {
    const parse = (content, truncated) => ProviderApi.parseImageResult(provider, envelope(provider, content, truncated));
    assert.deepEqual(parse('{"blocks":[]}'), { ok: true, blocks: [] }, provider);
    assert.deepEqual(parse("```json\n[]\n```"), { ok: true, blocks: [] }, provider);
    for (const invalid of ["not-json", "{}", '{"blocks":null}', '{"blocks":[{"translation":"hi"}]}',
      '{"blocks":[{"translation":{},"box":{"x":0,"y":0,"w":1,"h":1}}]}']) {
      assert.deepEqual(parse(invalid), { ok: false, error: "parse" }, `${provider}: ${invalid}`);
    }
    for (const unfinished of ['{"blocks":[', '{"blocks":[]}', '{"blocks":[{"translation":"hi"}']) {
      assert.deepEqual(parse(unfinished, true), { ok: false, error: "output_truncated" }, provider);
    }
    const row = rowFor(provider), complete = JSON.stringify({ blocks: [row] });
    assert.equal(parse(complete).blocks.length, 1, provider);
    assert.equal(parse(complete, true).partial, true, provider);
    const partial = parse(`{"blocks":[${JSON.stringify(row)},{"translation":"unfinished`, true);
    assert.equal(partial.partial, true, provider);
    assert.deepEqual(partial.blocks, parse(complete).blocks, provider);
    assert.deepEqual(parse(`{"blocks":[${JSON.stringify(row)},{"translation":"unfinished`),
      { ok: false, error: "parse" }, provider);
  }
});

test("画像応答: 打ち切り救済は文字列中の括弧・引用符とネストを区別し、未完の要素を捨てる", () => {
  const row = { ...block, translation: '訳文: \\"quoted\\" } ] { \\ 日本語', extra: { values: [1, { text: "}" }] } };
  const result = ProviderApi.parseImageResult("openai", envelope("openai",
    `\`\`\`json\n[${JSON.stringify(row)}, {"translation":"末尾`, true));
  assert.equal(result.partial, true);
  assert.equal(result.blocks.length, 1);
  assert.equal(result.blocks[0].translation, row.translation);
  for (const invalid of ['{"translation":"x","box":{"x":0,"y":0,"w":1,"h":1}}',
    '{"blocks":[{"box":{"x":0,"y":0,"w":1,"h":1},"translation":"unfinished',
    '[{"translation":"x","box":{"x":"0","y":0,"w":1,"h":1}},']) {
    assert.deepEqual(ProviderApi.parseImageResult("openai", envelope("openai", invalid, true)),
      { ok: false, error: "output_truncated" });
  }
});

const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const loop = Buffer.from([0x21, 0xff, 11, ...Buffer.from("NETSCAPE2.0"), 3, 1, 0, 0, 0]);
const imageUrl = "https://images.example.com/text.gif";
const contentSender = { id: "translation-test", url: "https://example.com/", tab: { id: 1 } };
const imageHarness = ({ provider = "openai", bytes = gif, mime = "image/gif", result = envelope(provider, '{"blocks":[]}') } = {}) => {
  const apiRequests = [];
  const h = workerHarness({ initial: { provider, apiKeys: { [provider]: "test-key" } },
    fetchResponse: (url, options) => {
      if (url === imageUrl) return new Response(bytes, { headers: { "content-type": mime } });
      if (options.method === "POST") {
        apiRequests.push(JSON.parse(options.body));
        return Response.json(result);
      }
    } });
  return { ...h, apiRequests, translate: () => h.send({ action: h.context.Actions.TRANSLATE_IMAGE, imageUrl }, contentSender) };
};

test("実SWの画像経路: 不正応答も打ち切りも再送せず、利用量を一度だけ記録する", async () => {
  for (const provider of visionProviders) {
    for (const [text, truncated, error] of [["not-json", false, "parse"], ['{"blocks":[', true, "output_truncated"]]) {
      const h = imageHarness({ provider, result: envelope(provider, text, truncated) });
      assert.deepEqual(await h.translate(), { ok: false, error }, provider);
      assert.equal(h.apiRequests.length, 1, provider);
      h.suspend();
      const usage = Object.values(h.disk.tokenUsage)[0][provider];
      assert.deepEqual(usage, { input: 10, output: 20 }, provider);
    }
    const h = imageHarness({ provider, result: envelope(provider,
      `{"blocks":[${JSON.stringify(rowFor(provider))},{"translation":"unfinished`, true) });
    const partial = await h.translate();
    assert.equal(partial.ok, true, provider);
    assert.equal(partial.partial, true, provider);
    assert.equal(partial.blocks.length, 1, provider);
    assert.equal(partial.image.base64, gif.toString("base64"), provider);
    assert.equal(h.apiRequests.length, 1, provider);
  }
});

const pngChunk = (type, data) => {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length); header.write(type, 4);
  return Buffer.concat([header, data, Buffer.alloc(4)]);
};
const webpChunk = (type, data) => {
  const header = Buffer.alloc(8);
  header.write(type); header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data, Buffer.alloc(data.length % 2)]);
};
const webp = (...chunks) => {
  const header = Buffer.from("RIFF\0\0\0\0WEBP");
  const payload = Buffer.concat(chunks);
  header.writeUInt32LE(payload.length + 4, 4);
  return Buffer.concat([header, payload]);
};

test("実SWのGIF判定: 1フレームのループ情報・コメント内のGCEを静止画として通す", async () => {
  const comment = Buffer.from([0x21, 0xfe, 6, 0x21, 0xf9, 4, 0x21, 0xf9, 4, 0]);
  for (const extension of [loop, comment]) {
    const h = imageHarness({ bytes: Buffer.concat([gif.subarray(0, 19), extension, gif.subarray(19)]) });
    assert.deepEqual(await h.translate(), { ok: true, blocks: [], image: { base64:
      Buffer.concat([gif.subarray(0, 19), extension, gif.subarray(19)]).toString("base64"), mime: "image/gif" } });
    assert.equal(h.apiRequests.length, 1);
  }
});

test("実SWのアニメ判定: 2フレームGIF・APNG・アニメWebPをAPI呼び出し前に止める", async () => {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1); ihdr.writeUInt32BE(1, 4);
  const pngHead = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), pngChunk("IHDR", ihdr)]);
  const actl = Buffer.alloc(8); actl.writeUInt32BE(2);
  const vp8x = webpChunk("VP8X", Buffer.alloc(10));
  // 構造判定の境界fixture。PNGのCRCとWebPの圧縮画素はデコード対象にせず、実SWの送信前ガードを通す。
  for (const [bytes, mime] of [
    [Buffer.concat([gif.subarray(0, -1), gif.subarray(19)]), "image/gif"],
    [Buffer.concat([pngHead, pngChunk("acTL", actl), pngChunk("IDAT", Buffer.alloc(1))]), "image/png"],
    [webp(vp8x, webpChunk("ANIM", Buffer.alloc(6))), "image/webp"],
    [webp(vp8x, webpChunk("EXIF", Buffer.alloc(70001)), webpChunk("ANIM", Buffer.alloc(6))), "image/webp"],
  ]) {
    const h = imageHarness({ bytes, mime });
    assert.deepEqual(await h.translate(), { ok: false, error: "animated" }, mime);
    assert.equal(h.apiRequests.length, 0, mime);
  }
});

test("実SWのチャンク判定: 圧縮データ・メタデータ中の同名文字列と不完全なチャンクを誤認しない", async () => {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1); ihdr.writeUInt32BE(1, 4);
  const pngHead = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), pngChunk("IHDR", ihdr)]);
  const vp8x = webpChunk("VP8X", Buffer.alloc(10));
  const badSize = webpChunk("EXIF", Buffer.from("ANIM")); badSize.writeUInt32LE(0xffffffff, 4);
  for (const [bytes, mime] of [
    [Buffer.concat([pngHead, pngChunk("tEXt", Buffer.from("note\0acTL")), pngChunk("IDAT", Buffer.from("acTL"))]), "image/png"],
    [webp(vp8x, webpChunk("EXIF", Buffer.from("xANIM"))), "image/webp"],
    [webp(vp8x, badSize), "image/webp"],
  ]) {
    const h = imageHarness({ bytes, mime });
    assert.equal((await h.translate()).ok, true, mime);
    assert.equal(h.apiRequests.length, 1, mime);
  }
});
