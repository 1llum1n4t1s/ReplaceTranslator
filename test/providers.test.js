"use strict";

const test = require("node:test");
const assert = require("node:assert");
const g = require("./_load-actions.js");

const { ProviderApi } = g;

// ---- buildSystemPrompt ----

test("ProviderApi exposes a positive translation prompt version for cache invalidation", () => {
  assert.equal(Number.isInteger(ProviderApi.promptVersion) && ProviderApi.promptVersion > 0, true);
});

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

test("buildSystemPrompt treats page context as untrusted disambiguation input only", () => {
  const p = ProviderApi.buildSystemPrompt("en", "ja", true);
  assert.match(p, /use "context" only to disambiguate "text"/i);
  assert.match(p, /translate only "text"/i);
  assert.match(p, /untrusted content/i);
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
  assert.deepEqual(JSON.parse(r.body.messages[1].content), ["Hello"]);
});

test("buildRequest sends bounded per-item context without changing output order", () => {
  const r = ProviderApi.buildRequest("openai", {
    texts: ["Bank", "Bank", "Plain"],
    contexts: ["Before: river", "Before: finance", ""],
    sourceLang: "en", targetLang: "ja", model: "gpt-4o-mini", apiKey: "sk-x",
  });
  assert.deepEqual(JSON.parse(r.body.messages[1].content), [
    { text: "Bank", context: "Before: river" },
    { text: "Bank", context: "Before: finance" },
    "Plain",
  ]);
  assert.match(r.body.messages[0].content, /SAME length and SAME order/);
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
    // OpenAI 互換でも provider/model 固有の最小推論設定は維持する。
    if (id === "openrouter") assert.deepEqual(r.body.reasoning, { effort: "none" }, `${id} reasoning off`);
    else if (id === "deepseek") {
      assert.deepEqual(r.body.thinking, { type: "disabled" }, `${id} thinking off`);
      assert.equal(r.body.temperature, 0, `${id} temperature`);
    } else if (id === "groq") {
      assert.equal(r.body.reasoning_effort, "low", `${id} minimum reasoning_effort`);
      assert.equal(r.body.temperature, 0, `${id} temperature`);
    } else if (id === "fugu") assert.deepEqual(r.body.reasoning, { effort: "high" }, `${id} minimum reasoning`);
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
  const rPro = ProviderApi.buildRequest("openai", { texts: ["x"], targetLang: "ja", model: "gpt-5-pro", apiKey: "k" });
  assert.equal(rPro.body.reasoning_effort, "high"); // pro は high のみ
  const r56Pro = ProviderApi.buildRequest("openai", { texts: ["x"], targetLang: "ja", model: "gpt-5.6-pro", apiKey: "k" });
  assert.equal(r56Pro.body.reasoning_effort, "none"); // 5.6+ の pro mode と effort は独立
  const roPro = ProviderApi.buildRequest("openai", { texts: ["x"], targetLang: "ja", model: "o1-pro", apiKey: "k" });
  assert.equal(roPro.body.reasoning_effort, "high");
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

test("各社とも reasoning/thinking をモデルが許す最小値に明示指定する", () => {
  // Anthropic: 思考対応モデルは disabled、effort 対応モデルは output_config.low かつ temperature なし
  const a = ProviderApi.buildRequest("anthropic", { texts: ["x"], targetLang: "ja", model: "claude-haiku-4-5", apiKey: "k" });
  assert.deepEqual(a.body.thinking, { type: "disabled" });
  assert.equal(a.body.temperature, 0);
  const a46 = ProviderApi.buildRequest("anthropic", { texts: ["x"], targetLang: "ja", model: "claude-sonnet-4-6", apiKey: "k" });
  assert.deepEqual(a46.body.thinking, { type: "disabled" });
  assert.deepEqual(a46.body.output_config, { effort: "low" });
  assert.ok(!("temperature" in a46.body));
  const a48 = ProviderApi.buildRequest("anthropic", { texts: ["x"], targetLang: "ja", model: "claude-opus-4-8", apiKey: "k" });
  assert.deepEqual(a48.body.output_config, { effort: "low" });
  assert.ok(!("temperature" in a48.body));
  for (const model of ["claude-fable-5", "claude-mythos-5", "claude-mythos-preview"]) {
    const alwaysThinking = ProviderApi.buildRequest("anthropic", { texts: ["x"], targetLang: "ja", model, apiKey: "k" });
    assert.deepEqual(alwaysThinking.body.output_config, { effort: "low" }, model);
    assert.ok(!("thinking" in alwaysThinking.body), `${model} cannot disable thinking`);
    assert.ok(!("temperature" in alwaysThinking.body), `${model} omits sampling controls`);
  }
  const a35 = ProviderApi.buildRequest("anthropic", { texts: ["x"], targetLang: "ja", model: "claude-3-5-haiku", apiKey: "k" });
  assert.ok(!("thinking" in a35.body));
  // Gemini: 2.5 は budget、3.x は thinkingLevel (minimal 非対応モデルは low)
  const gf = ProviderApi.buildRequest("gemini", { texts: ["x"], targetLang: "ja", model: "gemini-2.5-flash", apiKey: "k" });
  assert.equal(gf.body.generationConfig.thinkingConfig.thinkingBudget, 0);
  const gp = ProviderApi.buildRequest("gemini", { texts: ["x"], targetLang: "ja", model: "gemini-2.5-pro", apiKey: "k" });
  assert.equal(gp.body.generationConfig.thinkingConfig.thinkingBudget, 128);
  const g35 = ProviderApi.buildRequest("gemini", { texts: ["x"], targetLang: "ja", model: "gemini-3.5-flash", apiKey: "k" });
  assert.equal(g35.body.generationConfig.thinkingConfig.thinkingLevel, "minimal");
  assert.ok(!("temperature" in g35.body.generationConfig));
  const g37 = ProviderApi.buildRequest("gemini", { texts: ["x"], targetLang: "ja", model: "gemini-3.7-flash", apiKey: "k" });
  assert.equal(g37.body.generationConfig.thinkingConfig.thinkingLevel, "low");
  for (const model of ["gemini-3.1-pro-preview", "gemini-3.5-pro", "gemini-3.8-pro"]) {
    const pro = ProviderApi.buildRequest("gemini", { texts: ["x"], targetLang: "ja", model, apiKey: "k" });
    assert.equal(pro.body.generationConfig.thinkingConfig.thinkingLevel, "low", model);
  }
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
  for (const model of ["grok-4.5", "grok-4.6", "grok-4.20", "grok-4.20-0309-reasoning"]) {
    const x = ProviderApi.buildRequest("xai", { texts: ["x"], targetLang: "ja", model, apiKey: "k" });
    assert.equal(x.body.reasoning_effort, "low");
    assert.ok(!("temperature" in x.body));
  }
  // Groq: gpt-oss は none 非対応 (low/medium/high のみ) なので既定 medium を最小の low に明示する
  const goss = ProviderApi.buildRequest("groq", { texts: ["x"], targetLang: "ja", model: "openai/gpt-oss-120b", apiKey: "k" });
  assert.equal(goss.body.reasoning_effort, "low");
  assert.equal(goss.body.temperature, 0);
  const gqwen = ProviderApi.buildRequest("groq", { texts: ["x"], targetLang: "ja", model: "qwen/qwen3.6-27b", apiKey: "k" });
  assert.equal(gqwen.body.reasoning_effort, "none");
  const safeguard = ProviderApi.buildRequest("groq", { texts: ["x"], targetLang: "ja", model: "openai/gpt-oss-safeguard-20b", apiKey: "k" });
  assert.ok(!("reasoning_effort" in safeguard.body));
  assert.equal(safeguard.body.temperature, 0);
  // DeepSeek v4: 既定 high の thinking を明示的に無効化する
  for (const model of ["deepseek-v4-flash", "deepseek-v4-pro"]) {
    const ds = ProviderApi.buildRequest("deepseek", { texts: ["x"], targetLang: "ja", model, apiKey: "k" });
    assert.deepEqual(ds.body.thinking, { type: "disabled" });
    assert.equal(ds.body.temperature, 0);
  }
  // Fugu は high が API 上の最小値 (none/minimal/low は非対応)
  for (const model of ["fugu", "fugu-ultra"]) {
    const f = ProviderApi.buildRequest("fugu", { texts: ["x"], targetLang: "ja", model, apiKey: "k" });
    assert.deepEqual(f.body.reasoning, { effort: "high" });
    assert.ok(!("temperature" in f.body));
  }
});

test("OpenRouter はモデル系列ごとの最小 reasoning を使い未知モデルは安全にフォールバックする", () => {
  const cases = [
    ["google/gemini-2.5-flash", { effort: "none" }],
    ["google/gemini-2.5-pro", { max_tokens: 128 }],
    ["google/gemini-3.5-flash", { effort: "minimal" }],
    ["google/gemini-3.5-pro", { effort: "low" }],
    ["google/gemini-3.7-flash", { effort: "low" }],
    ["anthropic/claude-haiku-4.5", { effort: "none" }],
    ["anthropic/claude-fable-5", { effort: "low" }],
    ["anthropic/claude-mythos-preview", { effort: "low" }],
    ["deepseek/deepseek-v4-flash-0731", { effort: "none" }],
    ["openai/gpt-5.4-mini", { effort: "none" }],
    ["openai/gpt-5-pro", { effort: "high" }],
    ["openai/gpt-5.6-pro", { effort: "none" }],
    ["openai/o1-pro", { effort: "high" }],
    ["openai/o4-mini", { effort: "low" }],
    ["x-ai/grok-4.3", { effort: "none" }],
    ["x-ai/grok-4.6", { effort: "low" }],
    ["x-ai/grok-4.20", { effort: "low" }],
  ];
  for (const [model, expected] of cases) {
    const r = ProviderApi.buildRequest("openrouter", { texts: ["x"], targetLang: "ja", model, apiKey: "k" });
    assert.deepEqual(r.body.reasoning, expected, model);
    assert.ok(!("temperature" in r.body), `${model} reasoning request omits temperature`);
  }
  for (const model of [
    "vendor/unknown-model",
    "google/gemini-2.5-flashjunk",
    "deepseek/deepseek-v4foo",
    "x-ai/grok-4.5foo",
    "openai/gpt-5.4foo",
  ]) {
    const unknown = ProviderApi.buildRequest("openrouter", { texts: ["x"], targetLang: "ja", model, apiKey: "k" });
    assert.ok(!("reasoning" in unknown.body), `${model} is not classified as a known reasoning family`);
    assert.equal(unknown.body.temperature, 0, `${model} fallback temperature`);
  }
  const nativeUnknown = ProviderApi.buildRequest("openai", { texts: ["x"], targetLang: "ja", model: "gpt-5.4foo", apiKey: "k" });
  assert.ok(!("reasoning_effort" in nativeUnknown.body));
  assert.equal(nativeUnknown.body.temperature, 0);
  const geminiUnknown = ProviderApi.buildRequest("gemini", { texts: ["x"], targetLang: "ja", model: "gemini-3.5foo", apiKey: "k" });
  assert.ok(!geminiUnknown.body.generationConfig.thinkingConfig);
  assert.equal(geminiUnknown.body.generationConfig.temperature, 0);
});

test("reasoningProfile はモデルが受理する選択肢だけを UI 向けに返す", () => {
  assert.deepEqual(ProviderApi.reasoningProfile("openai", "gpt-5.4-mini"), {
    automatic: "none", options: ["none", "low", "medium", "high", "xhigh"], mode: "effort",
  });
  assert.deepEqual(ProviderApi.reasoningProfile("openai", "gpt-5.6-sol").options,
    ["none", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(ProviderApi.reasoningProfile("anthropic", "claude-sonnet-4-6").options,
    ["low", "medium", "high", "max"]);
  assert.deepEqual(ProviderApi.reasoningProfile("anthropic", "claude-fable-5").options,
    ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(ProviderApi.reasoningProfile("gemini", "gemini-2.5-pro"), {
    automatic: "minimal", options: ["budget:1024", "budget:4096", "budget:8192"], mode: "budget",
  });
  assert.deepEqual(ProviderApi.reasoningProfile("gemini", "gemini-3.1-flash-lite-image").options,
    ["minimal", "high"]);
  assert.deepEqual(ProviderApi.reasoningProfile("groq", "qwen/qwen3.6-27b").options, ["none", "default"]);
  assert.deepEqual(ProviderApi.reasoningProfile("fugu", "fugu-ultra").options, ["high", "xhigh", "max"]);
  assert.equal(ProviderApi.reasoningProfile("openai", "gpt-4.1-mini"), null);
  assert.equal(ProviderApi.reasoningProfile("openrouter", "vendor/unknown"), null);
});

test("明示したモデル別 effort を各社のネイティブ request 形式へ変換する", () => {
  const openai = ProviderApi.buildRequest("openai", {
    texts: ["x"], targetLang: "ja", model: "gpt-5.4-mini", apiKey: "k", reasoningEffort: "xhigh",
  });
  assert.equal(openai.body.reasoning_effort, "xhigh");

  const invalidForO = ProviderApi.buildRequest("openai", {
    texts: ["x"], targetLang: "ja", model: "o4-mini", apiKey: "k", reasoningEffort: "none",
  });
  assert.equal(invalidForO.body.reasoning_effort, "low"); // unsupported は自動最小値へ

  const anthropic = ProviderApi.buildRequest("anthropic", {
    texts: ["x"], targetLang: "ja", model: "claude-opus-4-8", apiKey: "k", reasoningEffort: "max",
  });
  assert.deepEqual(anthropic.body.output_config, { effort: "max" });
  const anthropicSonnet = ProviderApi.buildRequest("anthropic", {
    texts: ["x"], targetLang: "ja", model: "claude-sonnet-4-6", apiKey: "k", reasoningEffort: "max",
  });
  assert.deepEqual(anthropicSonnet.body.output_config, { effort: "max" });

  const gemini3 = ProviderApi.buildRequest("gemini", {
    texts: ["x"], targetLang: "ja", model: "gemini-3.5-flash", apiKey: "k", reasoningEffort: "high",
  });
  assert.equal(gemini3.body.generationConfig.thinkingConfig.thinkingLevel, "high");

  const gemini25 = ProviderApi.buildRequest("gemini", {
    texts: ["x"], targetLang: "ja", model: "gemini-2.5-pro", apiKey: "k", reasoningEffort: "budget:4096",
  });
  const gemini25Auto = ProviderApi.buildRequest("gemini", {
    texts: ["x"], targetLang: "ja", model: "gemini-2.5-pro", apiKey: "k",
  });
  assert.equal(gemini25.body.generationConfig.thinkingConfig.thinkingBudget, 4096);
  assert.equal(gemini25.body.generationConfig.maxOutputTokens, gemini25Auto.body.generationConfig.maxOutputTokens + 4096);

  const xai = ProviderApi.buildRequest("xai", {
    texts: ["x"], targetLang: "ja", model: "grok-4.6", apiKey: "k", reasoningEffort: "xhigh",
  });
  assert.equal(xai.body.reasoning_effort, "xhigh");

  const deepseek = ProviderApi.buildRequest("deepseek", {
    texts: ["x"], targetLang: "ja", model: "deepseek-v4-pro", apiKey: "k", reasoningEffort: "max",
  });
  assert.deepEqual(deepseek.body.thinking, { type: "enabled" });
  assert.equal(deepseek.body.reasoning_effort, "max");
  assert.ok(!("temperature" in deepseek.body));

  const groq = ProviderApi.buildRequest("groq", {
    texts: ["x"], targetLang: "ja", model: "qwen/qwen3.6-27b", apiKey: "k", reasoningEffort: "default",
  });
  assert.equal(groq.body.reasoning_effort, "default");

  const fugu = ProviderApi.buildRequest("fugu", {
    texts: ["x"], targetLang: "ja", model: "fugu", apiKey: "k", reasoningEffort: "xhigh",
  });
  assert.deepEqual(fugu.body.reasoning, { effort: "xhigh" });

  const openrouter = ProviderApi.buildRequest("openrouter", {
    texts: ["x"], targetLang: "ja", model: "google/gemini-2.5-pro", apiKey: "k", reasoningEffort: "high",
  });
  assert.deepEqual(openrouter.body.reasoning, { effort: "high" });
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
  // Fugu は high が API の受理する最小値 (none/minimal/low は拒否)
  assert.deepEqual(r.body.reasoning, { effort: "high" });
  assert.ok(!("temperature" in r.body));
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

test("filterTranslationModels keeps curated dated snapshots but rejects uncurated dated/rolling IDs", () => {
  const models = [
    { id: "deepseek/deepseek-v4-flash-0731", created: 4 },
    { id: "google/gemini-2.5-flash", created: 3 },
    { id: "vendor/model-20240806", created: 2 },
    { id: "vendor/model-latest", created: 1 },
    { id: "vendor/text-embedding-3", created: 0 },
  ];
  assert.deepEqual(
    ProviderApi.filterTranslationModels("openrouter", models).map((m) => m.id),
    ["deepseek/deepseek-v4-flash-0731", "google/gemini-2.5-flash"],
  );
});

// ---- 画像内テキストの翻訳 (vision) ----

test("buildImageRequest openai embeds a data URL image and uses json mode", () => {
  const r = ProviderApi.buildImageRequest("openai", { imageBase64: "AAA", mimeType: "image/png", targetLang: "ja", model: "gpt-4o-mini", apiKey: "k" });
  assert.equal(r.url, "https://api.openai.com/v1/chat/completions");
  const content = r.body.messages[0].content;
  assert.ok(content.some((c) => c.type === "image_url" && c.image_url.url === "data:image/png;base64,AAA"));
  assert.equal(r.body.response_format.type, "json_object");
});

test("buildImageRequest openrouter applies the same model-specific reasoning policy", () => {
  const r = ProviderApi.buildImageRequest("openrouter", {
    imageBase64: "AAA", mimeType: "image/png", targetLang: "ja", model: "google/gemini-2.5-flash", apiKey: "k",
  });
  assert.deepEqual(r.body.reasoning, { effort: "none" });
  assert.ok(!("temperature" in r.body));
  const high = ProviderApi.buildImageRequest("openrouter", {
    imageBase64: "AAA", mimeType: "image/png", targetLang: "ja", model: "google/gemini-2.5-flash", apiKey: "k",
    reasoningEffort: "high",
  });
  assert.deepEqual(high.body.reasoning, { effort: "high" });
});

test("buildImageRequest anthropic/gemini carry the base64 image", () => {
  const a = ProviderApi.buildImageRequest("anthropic", { imageBase64: "B", mimeType: "image/jpeg", targetLang: "ja", apiKey: "k" });
  const aImg = a.body.messages[0].content.find((c) => c.type === "image");
  assert.equal(aImg.source.data, "B");
  assert.equal(aImg.source.media_type, "image/jpeg");
  const g = ProviderApi.buildImageRequest("gemini", { imageBase64: "C", targetLang: "ja", model: "gemini-2.0-flash", apiKey: "k" });
  const part = g.body.contents[0].parts.find((p) => p.inline_data);
  assert.equal(part.inline_data.data, "C");
  const a48 = ProviderApi.buildImageRequest("anthropic", {
    imageBase64: "D", mimeType: "image/png", targetLang: "ja", model: "claude-opus-4-8", apiKey: "k",
  });
  assert.deepEqual(a48.body.output_config, { effort: "low" });
  assert.ok(!("temperature" in a48.body));
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
