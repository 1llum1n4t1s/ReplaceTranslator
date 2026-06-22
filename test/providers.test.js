"use strict";

const test = require("node:test");
const assert = require("node:assert");
const g = require("./_load-actions.js");

const { ProviderApi } = g;

// ---- buildSystemPrompt ----

test("buildSystemPrompt includes target language and the mixed-language rule", () => {
  const p = ProviderApi.buildSystemPrompt("auto", "ja");
  assert.match(p, /Japanese/);
  assert.match(p, /already written in Japanese/i); // 要件 A: 既に target の要素はそのまま
  assert.match(p, /translations/);                  // {"translations":[...]} 指示
});

test("buildSystemPrompt names an explicit source language", () => {
  const p = ProviderApi.buildSystemPrompt("en", "ja");
  assert.match(p, /source language is English/i);
});

test("buildSystemPrompt with explicit source translates ONLY that language (third languages stay)", () => {
  const p = ProviderApi.buildSystemPrompt("en", "ja");
  assert.match(p, /Translate ONLY the elements written in English/);
  assert.match(p, /any other language unchanged/i);
  assert.doesNotMatch(p, /NOT in Japanese/); // 「target 以外は全部訳す」ルールは source 確定時には出さない
});

test("buildSystemPrompt with auto source keeps the NOT-in-target rule", () => {
  const p = ProviderApi.buildSystemPrompt("auto", "ja");
  assert.match(p, /NOT in Japanese/);
  assert.doesNotMatch(p, /Translate ONLY the elements written in/);
});

// ---- buildRequest (3社の形状) ----

test("buildRequest openai shape", () => {
  const r = ProviderApi.buildRequest("openai", {
    texts: ["Hello"], sourceLang: "auto", targetLang: "ja", model: "gpt-4o-mini", apiKey: "sk-x",
  });
  assert.equal(r.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(r.method, "POST");
  assert.equal(r.headers.Authorization, "Bearer sk-x");
  assert.equal(r.body.model, "gpt-4o-mini");
  assert.equal(r.body.response_format.type, "json_object");
  assert.equal(r.body.messages.length, 2);
  assert.match(r.body.messages[1].content, /Hello/);
});

test("buildRequest anthropic shape", () => {
  const r = ProviderApi.buildRequest("anthropic", {
    texts: ["Hi"], targetLang: "ja", model: "claude-3-5-haiku-latest", apiKey: "sk-ant",
  });
  assert.equal(r.url, "https://api.anthropic.com/v1/messages");
  assert.equal(r.headers["x-api-key"], "sk-ant");
  assert.equal(r.headers["anthropic-version"], "2023-06-01");
  assert.equal(r.headers["anthropic-dangerous-direct-browser-access"], "true");
  assert.ok(r.body.max_tokens > 0);
  assert.equal(typeof r.body.system, "string");
  assert.equal(r.body.messages[0].role, "user");
});

test("buildRequest gemini puts model in URL and key in header", () => {
  const r = ProviderApi.buildRequest("gemini", {
    texts: ["Hi"], targetLang: "ja", model: "gemini-2.0-flash", apiKey: "AIza-x",
  });
  assert.match(r.url, /models\/gemini-2\.0-flash:generateContent/);
  assert.equal(r.headers["x-goog-api-key"], "AIza-x");
  assert.ok(!r.url.includes("AIza-x")); // キーを URL に乗せない
  assert.equal(r.body.generationConfig.responseMimeType, "application/json");
});

test("buildRequest falls back to provider default model", () => {
  const r = ProviderApi.buildRequest("openai", { texts: [], targetLang: "ja", apiKey: "k" });
  // モデル未指定なら provider.defaultModel に落ちる (具体 ID はハードコードせず実定義を参照)
  assert.equal(r.body.model, g.Providers.openai.defaultModel);
});

test("OpenAI 互換プロバイダ(openrouter/deepseek/groq/fugu)は chat/completions 形状を共有する", () => {
  // OpenAI と同形 (Bearer 認証・chat/completions・json_object・max_tokens) を新 3 社で確認。
  ["openrouter", "deepseek", "groq", "fugu"].forEach((id) => {
    const provider = g.Providers.get(id);
    const r = ProviderApi.buildRequest(id, { texts: ["Hello"], sourceLang: "auto", targetLang: "ja", apiKey: "k-" + id });
    assert.equal(r.url, provider.endpoint, `${id} endpoint`);
    assert.equal(r.method, "POST", `${id} method`);
    assert.equal(r.headers.Authorization, "Bearer k-" + id, `${id} auth`);
    assert.equal(r.body.model, provider.defaultModel, `${id} default model`);
    assert.equal(r.body.response_format.type, "json_object", `${id} response_format`);
    assert.ok(r.body.max_tokens > 0, `${id} uses max_tokens (not max_completion_tokens)`);
    assert.ok(!("max_completion_tokens" in r.body), `${id} は max_completion_tokens を使わない`);
    assert.equal(r.body.messages.length, 2, `${id} messages`);
    assert.match(r.body.messages[1].content, /Hello/, `${id} user content`);
    // 非 OpenAI なので reasoning_effort は付かず temperature:0
    assert.equal(r.body.temperature, 0, `${id} temperature`);
    assert.ok(!("reasoning_effort" in r.body), `${id} no reasoning_effort`);
  });
});

test("OpenAI 互換プロバイダは parseResponse / streamDelta も openai と同じ経路に乗る", () => {
  ["openrouter", "deepseek", "groq", "fugu"].forEach((id) => {
    const json = { choices: [{ message: { content: '{"translations":["やあ"]}' } }] };
    assert.deepEqual(ProviderApi.parseResponse(id, json), ["やあ"], `${id} parseResponse`);
    assert.equal(ProviderApi.streamDelta(id, { choices: [{ delta: { content: "あ" } }] }), "あ", `${id} streamDelta`);
  });
});

test("OpenAI は reasoning_effort をモデル別の最小値に、旧モデルは temperature:0", () => {
  // gpt-5.1 以降: temperature を送らず reasoning_effort:"none" (推論OFF・最速)
  const rNew = ProviderApi.buildRequest("openai", { texts: ["x"], targetLang: "ja", model: "gpt-5.4-nano", apiKey: "k" });
  assert.equal(rNew.body.reasoning_effort, "none");
  assert.ok(!("temperature" in rNew.body));
  assert.equal(rNew.body.verbosity, "low"); // gpt-5 系は出力を簡潔化
  // gpt-5.0 系: none 非対応 → "minimal"
  const r50 = ProviderApi.buildRequest("openai", { texts: ["x"], targetLang: "ja", model: "gpt-5-mini", apiKey: "k" });
  assert.equal(r50.body.reasoning_effort, "minimal");
  assert.equal(r50.body.verbosity, "low");
  // o 系: none/minimal 非対応 → "low"。verbosity は付けない
  const ro = ProviderApi.buildRequest("openai", { texts: ["x"], targetLang: "ja", model: "o4-mini", apiKey: "k" });
  assert.equal(ro.body.reasoning_effort, "low");
  assert.ok(!("verbosity" in ro.body));
  // 旧来モデル(gpt-4 系): temperature:0、reasoning_effort / verbosity なし
  const r4 = ProviderApi.buildRequest("openai", { texts: ["x"], targetLang: "ja", model: "gpt-4o-mini", apiKey: "k" });
  assert.equal(r4.body.temperature, 0);
  assert.ok(!("reasoning_effort" in r4.body));
  assert.ok(!("verbosity" in r4.body));
  // xAI(Grok) 非 reasoning は temperature:0 維持
  const rx = ProviderApi.buildRequest("xai", { texts: ["x"], targetLang: "ja", model: "grok-4", apiKey: "k" });
  assert.equal(rx.body.temperature, 0);
  assert.ok(!("reasoning_effort" in rx.body));
});

test("各社とも reasoning/thinking を最小(low)に明示指定する", () => {
  // Anthropic: 思考対応(4.x)は thinking:disabled、旧 3-5 系には付けない(400回避)
  const a = ProviderApi.buildRequest("anthropic", { texts: ["x"], targetLang: "ja", model: "claude-haiku-4-5", apiKey: "k" });
  assert.deepEqual(a.body.thinking, { type: "disabled" });
  const a35 = ProviderApi.buildRequest("anthropic", { texts: ["x"], targetLang: "ja", model: "claude-3-5-haiku", apiKey: "k" });
  assert.ok(!("thinking" in a35.body));
  // Gemini: 2.5 flash は thinkingBudget 0、pro は 128、思考非対応世代(2.0)には付けない
  const gf = ProviderApi.buildRequest("gemini", { texts: ["x"], targetLang: "ja", model: "gemini-2.5-flash", apiKey: "k" });
  assert.equal(gf.body.generationConfig.thinkingConfig.thinkingBudget, 0);
  const gp = ProviderApi.buildRequest("gemini", { texts: ["x"], targetLang: "ja", model: "gemini-2.5-pro", apiKey: "k" });
  assert.equal(gp.body.generationConfig.thinkingConfig.thinkingBudget, 128);
  const g20 = ProviderApi.buildRequest("gemini", { texts: ["x"], targetLang: "ja", model: "gemini-2.0-flash", apiKey: "k" });
  assert.ok(!g20.body.generationConfig.thinkingConfig);
  // xAI: 旧 "reasoning" 名義スラグは effort:low、非 reasoning は temperature:0
  const xr = ProviderApi.buildRequest("xai", { texts: ["x"], targetLang: "ja", model: "grok-4-1-fast-reasoning", apiKey: "k" });
  assert.equal(xr.body.reasoning_effort, "low");
  const xn = ProviderApi.buildRequest("xai", { texts: ["x"], targetLang: "ja", model: "grok-4-1-fast-non-reasoning", apiKey: "k" });
  assert.equal(xn.body.temperature, 0);
  assert.ok(!("reasoning_effort" in xn.body));
  // xAI: ドット版 grok-4.x は既定 reasoning を "none" で切る (翻訳に推論不要・grok-4.3 等が既定で low を取るのを止める)
  const x43 = ProviderApi.buildRequest("xai", { texts: ["x"], targetLang: "ja", model: "grok-4.3", apiKey: "k" });
  assert.equal(x43.body.reasoning_effort, "none");
  assert.ok(!("temperature" in x43.body));
  // Groq: gpt-oss は none 非対応 (low/medium/high のみ) なので既定 medium を最小の low に明示する
  const goss = ProviderApi.buildRequest("groq", { texts: ["x"], targetLang: "ja", model: "openai/gpt-oss-120b", apiKey: "k" });
  assert.equal(goss.body.reasoning_effort, "low");
  assert.equal(goss.body.temperature, 0);
});

test("buildRequest throws on unknown provider", () => {
  assert.throws(() => ProviderApi.buildRequest("nope", { texts: [] }));
});

test("buildRequest opts.stream enables SSE for openai/xai (and usage in last chunk)", () => {
  const r = ProviderApi.buildRequest("openai", { texts: ["x"], targetLang: "ja", model: "gpt-5.4-mini", apiKey: "k", stream: true });
  assert.equal(r.body.stream, true);
  assert.deepEqual(r.body.stream_options, { include_usage: true });
  // stream 未指定なら付かない
  const r2 = ProviderApi.buildRequest("openai", { texts: ["x"], targetLang: "ja", model: "gpt-5.4-mini", apiKey: "k" });
  assert.ok(!("stream" in r2.body));
});

test("streamDelta extracts incremental content for openai/xai, empty otherwise", () => {
  assert.equal(ProviderApi.streamDelta("openai", { choices: [{ delta: { content: "あ" } }] }), "あ");
  assert.equal(ProviderApi.streamDelta("xai", { choices: [{ delta: { content: "い" } }] }), "い");
  assert.equal(ProviderApi.streamDelta("openai", { choices: [{ delta: {} }] }), "");   // 増分なし(role chunk 等)
  assert.equal(ProviderApi.streamDelta("openai", { usage: { prompt_tokens: 1 } }), ""); // usage のみ chunk
  assert.equal(ProviderApi.streamDelta("anthropic", { choices: [{ delta: { content: "x" } }] }), ""); // 非対応
});

// ---- parseResponse (順序保持・3社・コードフェンス耐性) ----

test("parseResponse openai", () => {
  const json = { choices: [{ message: { content: '{"translations":["こんにちは"]}' } }] };
  assert.deepEqual(ProviderApi.parseResponse("openai", json), ["こんにちは"]);
});

test("parseResponse anthropic tolerates a ```json code fence", () => {
  const json = { content: [{ text: '```json\n{"translations":["やあ","世界"]}\n```' }] };
  assert.deepEqual(ProviderApi.parseResponse("anthropic", json), ["やあ", "世界"]);
});

test("parseResponse gemini", () => {
  const json = { candidates: [{ content: { parts: [{ text: '{"translations":["テスト"]}' }] } }] };
  assert.deepEqual(ProviderApi.parseResponse("gemini", json), ["テスト"]);
});

test("parseResponse tolerates a bare array", () => {
  const json = { choices: [{ message: { content: '["a","b"]' } }] };
  assert.deepEqual(ProviderApi.parseResponse("openai", json), ["a", "b"]);
});

test("parseResponse returns [] on non-JSON garbage", () => {
  const json = { choices: [{ message: { content: "sorry, not json" } }] };
  assert.deepEqual(ProviderApi.parseResponse("openai", json), []);
});

test("parseResponse rejects non-string entries (schema slip → no [object Object])", () => {
  // 数が合っていてもオブジェクト等が混じれば貼らずに [] (パース失敗) にする
  const json = { choices: [{ message: { content: '{"translations":[{"translation":"x"}]}' } }] };
  assert.deepEqual(ProviderApi.parseResponse("openai", json), []);
});

// ---- parseUsage (3社の形状差) ----

test("parseUsage openai", () => {
  assert.deepEqual(
    ProviderApi.parseUsage("openai", { usage: { prompt_tokens: 12, completion_tokens: 7 } }),
    { input: 12, output: 7 }
  );
});

test("parseUsage anthropic", () => {
  assert.deepEqual(
    ProviderApi.parseUsage("anthropic", { usage: { input_tokens: 5, output_tokens: 9 } }),
    { input: 5, output: 9 }
  );
});

test("parseUsage gemini", () => {
  assert.deepEqual(
    ProviderApi.parseUsage("gemini", { usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 11 } }),
    { input: 30, output: 11 }
  );
});

test("parseUsage missing usage returns zeros", () => {
  assert.deepEqual(ProviderApi.parseUsage("openai", {}), { input: 0, output: 0 });
});

// ---- xAI (Grok) は OpenAI 互換 ----

test("buildRequest xai is OpenAI-compatible (Bearer + chat completions)", () => {
  const r = ProviderApi.buildRequest("xai", {
    texts: ["Hi"], targetLang: "ja", model: "grok-4-1-fast-non-reasoning", apiKey: "xai-key",
  });
  assert.equal(r.url, "https://api.x.ai/v1/chat/completions");
  assert.equal(r.headers.Authorization, "Bearer xai-key");
  assert.equal(r.body.model, "grok-4-1-fast-non-reasoning");
  assert.equal(r.body.messages.length, 2);
  assert.equal(r.body.response_format.type, "json_object");
});

test("parseResponse / parseUsage xai (OpenAI-compatible shape)", () => {
  const json = {
    choices: [{ message: { content: '{"translations":["やあ"]}' } }],
    usage: { prompt_tokens: 4, completion_tokens: 3 },
  };
  assert.deepEqual(ProviderApi.parseResponse("xai", json), ["やあ"]);
  assert.deepEqual(ProviderApi.parseUsage("xai", json), { input: 4, output: 3 });
});

// ---- Sakana Fugu は OpenAI 互換 ----

test("buildRequest fugu (Sakana) is OpenAI-compatible (Bearer + chat completions)", () => {
  const r = ProviderApi.buildRequest("fugu", {
    texts: ["Hi"], targetLang: "ja", model: "fugu", apiKey: "sakana-key",
  });
  assert.equal(r.url, "https://api.sakana.ai/v1/chat/completions");
  assert.equal(r.headers.Authorization, "Bearer sakana-key");
  assert.equal(r.body.model, "fugu");
  assert.equal(r.body.response_format.type, "json_object");
  // OpenAI/xAI/Groq の reasoning 分岐に当たらないので temperature:0 パススルー
  assert.equal(r.body.temperature, 0);
  assert.ok(!("reasoning_effort" in r.body));
  assert.ok(r.body.max_tokens > 0);                 // max_completion_tokens ではなく max_tokens
  assert.ok(!("max_completion_tokens" in r.body));
});

test("buildModelsRequest fugu → GET /models with Bearer (endpoint の /chat/completions を /models に置換)", () => {
  const r = ProviderApi.buildModelsRequest("fugu", "sakana-key");
  assert.equal(r.url, "https://api.sakana.ai/v1/models");
  assert.equal(r.headers.Authorization, "Bearer sakana-key");
});

// ---- MyMemory (無料 NMT・GET・1テキスト/リクエスト) ----

test("buildRequest mymemory is a GET with langpair query and no body", () => {
  const r = ProviderApi.buildRequest("mymemory", { texts: ["Hello"], sourceLang: "en", targetLang: "ja" });
  assert.equal(r.method, "GET");
  assert.match(r.url, /api\.mymemory\.translated\.net\/get\?/);
  assert.match(r.url, /q=Hello/);
  assert.match(r.url, /langpair=en%7Cja/); // "|" は %7C にエンコードされる
  assert.equal(r.body, undefined);
});

test("buildRequest mymemory uses Autodetect for auto source and de for email", () => {
  const r = ProviderApi.buildRequest("mymemory", { texts: ["Hi"], sourceLang: "auto", targetLang: "ja", apiKey: "me@example.com" });
  assert.match(r.url, /langpair=Autodetect%7Cja/);
  assert.match(r.url, /de=me%40example\.com/);
});

test("parseResponse mymemory extracts responseData.translatedText", () => {
  const json = { responseData: { translatedText: "こんにちは" }, responseStatus: 200 };
  assert.deepEqual(ProviderApi.parseResponse("mymemory", json), ["こんにちは"]);
});

test("parseUsage mymemory returns zeros (NMT has no token usage)", () => {
  assert.deepEqual(ProviderApi.parseUsage("mymemory", { responseData: {} }), { input: 0, output: 0 });
});

// ---- モデル一覧の動的取得 ----

test("buildModelsRequest openai/xai → GET /models with Bearer", () => {
  const r = ProviderApi.buildModelsRequest("openai", "sk-x");
  assert.equal(r.url, "https://api.openai.com/v1/models");
  assert.equal(r.headers.Authorization, "Bearer sk-x");
  assert.equal(ProviderApi.buildModelsRequest("xai", "xk").url, "https://api.x.ai/v1/models");
});

test("buildModelsRequest anthropic/gemini carry the right auth header", () => {
  const a = ProviderApi.buildModelsRequest("anthropic", "ak");
  assert.match(a.url, /api\.anthropic\.com\/v1\/models/);
  assert.equal(a.headers["x-api-key"], "ak");
  const gm = ProviderApi.buildModelsRequest("gemini", "gk");
  assert.match(gm.url, /generativelanguage\.googleapis\.com\/v1beta\/models/);
  assert.equal(gm.headers["x-goog-api-key"], "gk");
});

test("buildModelsRequest returns null for mymemory (no model list)", () => {
  assert.equal(ProviderApi.buildModelsRequest("mymemory", ""), null);
});

test("parseModels openai extracts id + created", () => {
  const json = { data: [{ id: "gpt-4o", created: 100 }, { id: "gpt-4o-mini", created: 200 }] };
  assert.deepEqual(ProviderApi.parseModels("openai", json), [
    { id: "gpt-4o", created: 100 },
    { id: "gpt-4o-mini", created: 200 },
  ]);
});

test("parseModels anthropic parses created_at ISO into a timestamp", () => {
  const json = { data: [{ id: "claude-3-5-haiku-latest", created_at: "2024-11-01T00:00:00Z" }] };
  const r = ProviderApi.parseModels("anthropic", json);
  assert.equal(r[0].id, "claude-3-5-haiku-latest");
  assert.ok(r[0].created > 0);
});

test("parseModels gemini keeps only generateContent models, strips models/ prefix", () => {
  const json = {
    models: [
      { name: "models/gemini-2.0-flash", supportedGenerationMethods: ["generateContent"] },
      { name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] },
    ],
  };
  const r = ProviderApi.parseModels("gemini", json);
  assert.equal(r.length, 1);
  assert.equal(r[0].id, "gemini-2.0-flash");
});

// ---- 画像内テキストの翻訳 (vision) ----

test("buildImageRequest openai embeds a data URL image and uses json mode", () => {
  const r = ProviderApi.buildImageRequest("openai", { imageBase64: "AAA", mimeType: "image/png", targetLang: "ja", model: "gpt-4o-mini", apiKey: "k" });
  assert.equal(r.url, "https://api.openai.com/v1/chat/completions");
  const content = r.body.messages[0].content;
  assert.ok(content.some((c) => c.type === "image_url" && c.image_url.url === "data:image/png;base64,AAA"));
  assert.equal(r.body.response_format.type, "json_object");
});

test("buildImageRequest anthropic/gemini carry the base64 image", () => {
  const a = ProviderApi.buildImageRequest("anthropic", { imageBase64: "B", mimeType: "image/jpeg", targetLang: "ja", apiKey: "k" });
  const aImg = a.body.messages[0].content.find((c) => c.type === "image");
  assert.equal(aImg.source.data, "B");
  assert.equal(aImg.source.media_type, "image/jpeg");
  const g = ProviderApi.buildImageRequest("gemini", { imageBase64: "C", targetLang: "ja", model: "gemini-2.0-flash", apiKey: "k" });
  const part = g.body.contents[0].parts.find((p) => p.inline_data);
  assert.equal(part.inline_data.data, "C");
});

test("buildImageRequest returns null for mymemory (no vision)", () => {
  assert.equal(ProviderApi.buildImageRequest("mymemory", { imageBase64: "x" }), null);
});

test("parseImageBlocks extracts blocks and clamps box to 0..1", () => {
  const json = { choices: [{ message: { content: '{"blocks":[{"original":"Hi","translation":"やあ","box":{"x":0.1,"y":0.2,"w":1.5,"h":-0.3}}]}' } }] };
  const r = ProviderApi.parseImageBlocks("openai", json);
  assert.equal(r.length, 1);
  assert.equal(r[0].translation, "やあ");
  assert.equal(r[0].box.w, 1);  // 1.5 → clamp 1
  assert.equal(r[0].box.h, 0);  // -0.3 → clamp 0
});

test("parseImageBlocks returns [] when there are no blocks", () => {
  const json = { choices: [{ message: { content: '{"blocks":[]}' } }] };
  assert.deepEqual(ProviderApi.parseImageBlocks("openai", json), []);
});

test("parseImageBlocks rejects non-string translation (schema slip → no [object Object])", () => {
  const json = { choices: [{ message: { content: '{"blocks":[{"translation":{"text":"x"},"box":{"x":0,"y":0,"w":0.5,"h":0.1}}]}' } }] };
  assert.deepEqual(ProviderApi.parseImageBlocks("openai", json), []);
});

test("parseImageBlocks captures cy (midline) and falls back to box center", () => {
  const withCy = { choices: [{ message: { content: '{"blocks":[{"translation":"訳","cy":0.5,"box":{"x":0.1,"y":0.2,"w":0.3,"h":0.1}}]}' } }] };
  assert.equal(ProviderApi.parseImageBlocks("openai", withCy)[0].cy, 0.5); // 明示 cy を採用
  const noCy = { choices: [{ message: { content: '{"blocks":[{"translation":"訳","box":{"x":0.1,"y":0.2,"w":0.3,"h":0.1}}]}' } }] };
  assert.ok(Math.abs(ProviderApi.parseImageBlocks("openai", noCy)[0].cy - 0.25) < 1e-9); // 欠落時は y+h/2 = 0.25
});

test("parseImageBlocks converts Gemini box_2d [ymin,xmin,ymax,xmax]/1000 to box + cy", () => {
  const g = { candidates: [{ content: { parts: [{ text: '[{"box_2d":[200,100,400,600],"original":"Hi","translation":"やあ"}]' }] } }] };
  const r = ProviderApi.parseImageBlocks("gemini", g);
  assert.equal(r.length, 1);
  assert.equal(r[0].translation, "やあ");
  // ymin .2 / xmin .1 / ymax .4 / xmax .6 → x .1, y .2, w .5, h .2, cy .3 (x/y 反転していないことの確認)
  assert.ok(Math.abs(r[0].box.x - 0.1) < 1e-9);
  assert.ok(Math.abs(r[0].box.y - 0.2) < 1e-9);
  assert.ok(Math.abs(r[0].box.w - 0.5) < 1e-9);
  assert.ok(Math.abs(r[0].box.h - 0.2) < 1e-9);
  assert.ok(Math.abs(r[0].cy - 0.3) < 1e-9);
});

test("parseImageBlocks (gemini) drops items without a valid 4-element box_2d", () => {
  const g = { candidates: [{ content: { parts: [{ text: '[{"box_2d":[1,2,3],"translation":"x"},{"translation":"y"}]' }] } }] };
  assert.deepEqual(ProviderApi.parseImageBlocks("gemini", g), []);
});

test("parseImageBlocks keeps explicit kind and leaves missing/unknown kind undefined (kind 非対応モデル判別用)", () => {
  // openai 分岐: logo/text は明示値のみ保持、欠落・未知値は undefined (filterBlocks が hasKind=false を判定して
  // looksLikeBrandWordmark 保険を走らせるため。"text" に倒すと hasKind が常に真になり保険が死ぬ)。
  const oa = { choices: [{ message: { content: '{"blocks":[' +
    '{"translation":"Claude","kind":"logo","box":{"x":0,"y":0,"w":0.2,"h":0.05}},' +
    '{"translation":"本文","box":{"x":0,"y":0.5,"w":0.3,"h":0.05}},' +
    '{"translation":"見出し","kind":"text","box":{"x":0,"y":0.6,"w":0.3,"h":0.05}},' +
    '{"translation":"未知","kind":"banana","box":{"x":0,"y":0.7,"w":0.3,"h":0.05}}]}' } }] };
  const r = ProviderApi.parseImageBlocks("openai", oa);
  assert.equal(r.length, 4);
  assert.equal(r[0].kind, "logo");
  assert.equal(r[1].kind, undefined);  // 欠落 → undefined
  assert.equal(r[2].kind, "text");     // 明示 text は保持
  assert.equal(r[3].kind, undefined);  // 未知値 → undefined
  // gemini 分岐も同様: logo 保持、欠落は undefined
  const g = { candidates: [{ content: { parts: [{ text:
    '[{"box_2d":[0,0,50,200],"translation":"Claude","kind":"logo"},{"box_2d":[500,0,550,300],"translation":"本文"}]' }] } }] };
  const rg = ProviderApi.parseImageBlocks("gemini", g);
  assert.equal(rg[0].kind, "logo");
  assert.equal(rg[1].kind, undefined);
});
