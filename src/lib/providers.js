"use strict";

/**
 * providers.js — プロバイダ抽象 (ProviderApi)
 *
 * OpenAI / Anthropic / Google Gemini の差を吸収する純粋関数群:
 *   - buildSystemPrompt(sourceLang, targetLang)  → 混在翻訳を担保する system 指示文
 *   - buildRequest(providerId, opts)             → { url, method, headers, body } (body はオブジェクト)
 *   - parseResponse(providerId, json)            → string[] (翻訳結果。順序保持)
 *   - parseUsage(providerId, json)               → { input, output } (トークン数)
 *
 * 実際の fetch は background(SW) が行う (API キーをページ文脈に晒さないため)。
 * これらはすべて副作用なしの純粋関数で、test/providers.test.js が直接検証する。
 * 依存: globalThis.Providers (actions.js) / globalThis.Lang (lang.js)。
 */

(function () {
  if (globalThis.__rtProvidersLoaded) return;
  globalThis.__rtProvidersLoaded = true;

  const MAX_OUTPUT_TOKENS = 8192;
  // 画像翻訳は出力(OCR+訳+bbox JSON)が大きくなりがちで生成も遅いため、上限を低めに抑える(速度/コスト優先)。
  // 文字量の多い画像(漫画・図表)では足りずに切れることがあるので、その場合はここを上げる。
  const IMAGE_MAX_OUTPUT_TOKENS = 2048;

  // OpenAI 互換プロバイダ集合 (chat/completions・Bearer・usage 同形・/models 一覧・OpenAI 画像形式を共有)。
  // 新しい OpenAI 互換サービスはここに id を足すだけで buildRequest/extractContent/streamDelta/parseUsage/
  // buildModelsRequest/parseModels/buildImageRequest の全分岐に乗る (各所の条件分岐を二重管理しないため)。
  const OPENAI_COMPAT = ["openai", "xai", "openrouter", "deepseek", "groq"];
  function isOpenAICompat(id) { return OPENAI_COMPAT.indexOf(id) !== -1; }

  // 出力上限パラメータ。OpenAI の gpt-5/o 系は max_tokens 非対応のため max_completion_tokens、
  // xAI(Grok) は max_tokens。テキスト/画像の両 buildRequest が同じ分岐を持つので 1 箇所に集約する。
  function maxTokensCap(providerId, n) {
    return providerId === "openai" ? { max_completion_tokens: n } : { max_tokens: n };
  }

  /**
   * 混在翻訳を担保する system 指示文を組み立てる。
   * 「すでに target 言語の要素はそのまま、それ以外のみ翻訳」を明示し、要件 A を実現する。
   */
  function buildSystemPrompt(sourceLang, targetLang) {
    const Lang = globalThis.Lang;
    const targetName = (Lang && Lang.promptName(targetLang)) || targetLang || "the target language";
    const srcName = Lang ? Lang.promptName(sourceLang) : null; // auto なら null
    const lines = [
      `You are a professional translator. Translate text into ${targetName}.`,
      srcName ? `The source language is ${srcName}.` : "",
      `You receive a JSON array of strings.`,
      `Return ONLY a JSON object of the form {"translations":[...]} whose array has the SAME length and SAME order as the input array.`,
      `Rules:`,
      `1. If an element is already written in ${targetName}, return it unchanged.`,
      // 翻訳元が確定しているとき (ユーザー明示 or ページ言語検出) は source の要素だけを訳す。
      // 「target 以外は全部訳す」だと第三言語の断片 (メニュー/引用等) まで巻き込むため、確定時は source-only に絞る。
      srcName
        ? `2. Translate ONLY the elements written in ${srcName}. Return elements in any other language unchanged.`
        : `2. Translate only the elements that are NOT in ${targetName}.`,
      `3. Preserve numbers, URLs, emoji, inline code and symbols.`,
      `4. Do not add explanations, notes, or any extra fields.`,
      `5. Keep each translation natural and concise.`,
    ];
    return lines.filter(Boolean).join("\n");
  }

  /**
   * OpenAI 系 chat/completions(OpenAI / xAI) の body に推論/温度パラメータを付与する。
   * 翻訳は推論不要なので、推論を「各モデルが許す最小」に明示指定して高速化する(実測: none で ~1.8s / low で ~6.5s)。
   * reasoning モデルは temperature が default(1)固定で 0 を送ると 400 になるため temperature は送らない。
   * モデル別の最小値(実測で確認):
   * - OpenAI gpt-5.1 以降(5.1/5.2/5.4/5.5): reasoning_effort:"none"(=推論OFF・最速)。
   * - OpenAI gpt-5.0 系(gpt-5 / gpt-5-mini / gpt-5-nano): "none" 非対応 → "minimal"。
   * - OpenAI o 系(o1/o3/o4): "none"/"minimal" 非対応 → "low"。
   * - xAI(Grok) の reasoning モデル: "low"(none/minimal 非対応)。
   * - 旧 OpenAI(gpt-4 系)等・xAI 非 reasoning: temperature:0。
   */
  function tuneReasoning(providerId, model, body) {
    const m = String(model || "");
    if (providerId === "openai" && /^(gpt-5|o[1-9])/i.test(m)) {
      let effort = "minimal";                      // gpt-5.0 系 (none 非対応)
      if (/^gpt-5\.\d/i.test(m)) effort = "none";  // gpt-5.1 以降 (推論OFF)
      else if (/^o[1-9]/i.test(m)) effort = "low"; // o 系 (none/minimal 非対応)
      body.reasoning_effort = effort;
      // gpt-5 系は verbosity:"low" で出力を簡潔化 (翻訳は前置き不要・出力トークン削減で生成短縮)。o 系には付けない。
      if (/^gpt-5/i.test(m)) body.verbosity = "low";
      return body;
    }
    if (providerId === "xai" && /reasoning/i.test(m) && !/non-reasoning/i.test(m)) {
      body.reasoning_effort = "low";
      return body;
    }
    body.temperature = 0;
    return body;
  }

  // Anthropic は reasoning_effort を持たず既定で拡張思考オフ。思考対応(3.7 / 4.x)には
  // thinking:{type:"disabled"} を明示して「思考オフ(=最小)」を確定させる(実測 200・既定と同速)。
  function anthropicThinking(model) {
    return /claude-(3-7|(opus|sonnet|haiku)-[4-9])/i.test(String(model || "")) ? { type: "disabled" } : null;
  }

  // Gemini 2.5+ は既定で動的に思考して遅くなりうる。翻訳は思考不要なので最小化する。
  // flash/lite は 0(無効化)、pro 等は最小 128。思考非対応世代(2.0/1.5)には付けない(400回避)。
  function geminiThinkingConfig(model) {
    const m = String(model || "");
    if (!/gemini-(2\.5|[3-9])/i.test(m)) return null;
    return { thinkingBudget: /flash|lite/i.test(m) ? 0 : 128 };
  }

  /**
   * fetch の素材を組み立てる (純粋関数)。body はオブジェクトで返し、background が JSON.stringify する。
   * opts = { texts:string[], sourceLang, targetLang, model, apiKey }
   */
  // MyMemory は BCP47 の script サブタグ (zh-Hans / zh-Hant) を解釈できず Simplified に倒れるため、
  // ロケールベースのコード (zh-CN / zh-TW) に正規化してから langpair に渡す。
  const MYMEMORY_LANG_MAP = { "zh-Hans": "zh-CN", "zh-Hant": "zh-TW" };
  function mymemoryLang(code) {
    return MYMEMORY_LANG_MAP[code] || code;
  }

  function buildRequest(providerId, opts) {
    const provider = globalThis.Providers && globalThis.Providers.get(providerId);
    if (!provider) throw new Error("unknown provider: " + providerId);
    const o = opts || {};
    const model = o.model || provider.defaultModel;
    const apiKey = o.apiKey || "";

    // MyMemory は GET・1テキスト/リクエストの NMT (LLM プロンプト不要)
    if (providerId === "mymemory") {
      const text = (o.texts && o.texts[0]) || "";
      const src = mymemoryLang((o.sourceLang && o.sourceLang !== "auto") ? o.sourceLang : "Autodetect");
      const tgt = mymemoryLang(o.targetLang || "en");
      const params = new URLSearchParams({ q: text, langpair: `${src}|${tgt}` });
      if (apiKey) params.set("de", apiKey); // de = 連絡先メール (無料枠拡大)
      return { url: `${provider.endpoint}?${params.toString()}`, method: "GET", headers: {}, body: undefined };
    }

    const system = buildSystemPrompt(o.sourceLang, o.targetLang);
    const userContent = JSON.stringify(o.texts || []);

    if (isOpenAICompat(providerId)) {
      // xAI(Grok) は OpenAI 互換なので chat/completions 形式を共有する。
      // 出力上限を付け、prompt injection / format drift で verbose 化したときの遅延・課金枠浪費を防ぐ。
      const cap = maxTokensCap(providerId, MAX_OUTPUT_TOKENS);
      const body = tuneReasoning(providerId, model, Object.assign({
        model,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: userContent },
        ],
      }, cap));
      // ストリーミング (SSE) 要求。最後の chunk に usage を含めてもらう。
      if (o.stream) { body.stream = true; body.stream_options = { include_usage: true }; }
      return {
        url: provider.endpoint,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body,
      };
    }

    if (providerId === "anthropic") {
      const body = {
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        temperature: 0,
        system,
        messages: [{ role: "user", content: userContent }],
      };
      const think = anthropicThinking(model);
      if (think) body.thinking = think; // 思考対応モデルは明示的に思考オフ(=最小)
      return {
        url: provider.endpoint,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          // ブラウザ(拡張)からの直接呼び出しを許可するヘッダ
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body,
      };
    }

    if (providerId === "gemini") {
      // endpoint の {model} を実モデル名に置換。キーは URL ではなく x-goog-api-key ヘッダで渡す
      // (URL に乗せるとログ/履歴に残りやすいため)。
      const url = provider.endpoint.replace("{model}", encodeURIComponent(model));
      return {
        url,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: userContent }] }],
          generationConfig: Object.assign({
            temperature: 0,
            responseMimeType: "application/json",
            maxOutputTokens: MAX_OUTPUT_TOKENS,
          }, geminiThinkingConfig(model) ? { thinkingConfig: geminiThinkingConfig(model) } : {}),
        },
      };
    }

    throw new Error("unsupported provider: " + providerId);
  }

  // 各社レスポンスから LLM の生成テキスト (本文) を取り出す
  function extractContent(providerId, json) {
    if (!json || typeof json !== "object") return "";
    if (isOpenAICompat(providerId)) {
      const c = json.choices && json.choices[0] && json.choices[0].message;
      return (c && typeof c.content === "string") ? c.content : "";
    }
    if (providerId === "anthropic") {
      const parts = json.content;
      if (Array.isArray(parts)) return parts.map((p) => (p && p.text) || "").join("");
      return "";
    }
    if (providerId === "gemini") {
      const cand = json.candidates && json.candidates[0];
      const parts = cand && cand.content && cand.content.parts;
      if (Array.isArray(parts)) return parts.map((p) => (p && p.text) || "").join("");
      return "";
    }
    return "";
  }

  // LLM 応答本文 (JSON 文字列) を緩くパースする。コードフェンス除去 → JSON.parse → 失敗時は
  // 最初の { 〜 最後の } を救出して再パース。パース不能は null。(extractTranslations と parseImageBlocks で共用)
  function parseJsonLoose(content) {
    if (typeof content !== "string" || !content.trim()) return null;
    let text = content.trim();
    const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fence) text = fence[1].trim();
    try { return JSON.parse(text); } catch (_e) { /* フォールバックへ */ }
    const s = text.indexOf("{");
    const e = text.lastIndexOf("}");
    if (s >= 0 && e > s) { try { return JSON.parse(text.slice(s, e + 1)); } catch (_e2) { return null; } }
    return null;
  }

  // 本文 (JSON 文字列) から translations 配列を取り出す。コードフェンスや前後ノイズに耐性を持たせる。
  function extractTranslations(content) {
    const obj = parseJsonLoose(content);
    const arr = (obj && Array.isArray(obj.translations)) ? obj.translations : (Array.isArray(obj) ? obj : null);
    if (!arr) return [];
    // 全要素が文字列のときだけ採用する。オブジェクト等が混じるスキーマ崩れ (例 [{translation:"..."}]) を
    // String 化して "[object Object]" を貼り付けてしまうのを避け、パース失敗 ([]) 扱いでリトライに回す。
    return arr.every((x) => typeof x === "string") ? arr : [];
  }

  function parseResponse(providerId, json) {
    if (providerId === "mymemory") {
      const t = json && json.responseData && json.responseData.translatedText;
      return typeof t === "string" ? [t] : [];
    }
    return extractTranslations(extractContent(providerId, json));
  }

  // ストリーミング SSE の 1 data オブジェクトから増分テキストを取り出す (OpenAI/xAI chat-completions の delta.content)。
  // 増分が無い chunk (usage のみ等) は空文字。stream 対応は openai/xai のみ。
  function streamDelta(providerId, obj) {
    if (isOpenAICompat(providerId)) {
      const d = obj && obj.choices && obj.choices[0] && obj.choices[0].delta;
      return (d && typeof d.content === "string") ? d.content : "";
    }
    return "";
  }

  // usage を { input, output } に正規化 (3社の形状差を吸収)
  function parseUsage(providerId, json) {
    let input = 0;
    let output = 0;
    if (json && typeof json === "object") {
      if (isOpenAICompat(providerId)) {
        const u = json.usage || {};
        input = u.prompt_tokens || 0;
        output = u.completion_tokens || 0;
      } else if (providerId === "anthropic") {
        const u = json.usage || {};
        input = u.input_tokens || 0;
        output = u.output_tokens || 0;
      } else if (providerId === "gemini") {
        const u = json.usageMetadata || {};
        input = u.promptTokenCount || 0;
        output = u.candidatesTokenCount || 0;
      }
    }
    return { input: Number(input) || 0, output: Number(output) || 0 };
  }

  // ---- モデル一覧の動的取得 (各社 models API。価格は含まれないので別途 ModelPricing で付与) ----
  function buildModelsRequest(providerId, apiKey) {
    const provider = globalThis.Providers && globalThis.Providers.get(providerId);
    if (!provider) return null;
    const key = apiKey || "";
    if (isOpenAICompat(providerId)) {
      const base = provider.endpoint.replace(/\/chat\/completions$/, "");
      return { url: `${base}/models`, headers: { Authorization: `Bearer ${key}` } };
    }
    if (providerId === "anthropic") {
      return {
        url: "https://api.anthropic.com/v1/models?limit=100",
        headers: {
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
      };
    }
    if (providerId === "gemini") {
      return { url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", headers: { "x-goog-api-key": key } };
    }
    return null; // mymemory 等はモデル一覧を持たない
  }

  // レスポンスを [{ id, created }] に正規化 (created は新しい順ソート用)。
  // Gemini は created を持たないため 0 + version で、呼び出し側がバージョン降順に並べる。
  function parseModels(providerId, json) {
    if (!json || typeof json !== "object") return [];
    if (isOpenAICompat(providerId)) {
      return (json.data || []).map((m) => ({ id: m.id, created: Number(m.created) || 0 }));
    }
    if (providerId === "anthropic") {
      return (json.data || []).map((m) => ({ id: m.id, created: Date.parse(m.created_at) || 0 }));
    }
    if (providerId === "gemini") {
      return (json.models || [])
        .filter((m) => {
          const methods = m.supportedGenerationMethods || m.supported_actions;
          return !methods || methods.includes("generateContent");
        })
        .map((m) => ({ id: String(m.name || "").replace(/^models\//, ""), created: 0, version: m.version || "" }));
    }
    return [];
  }

  // ---- 画像内テキストの翻訳 (LLM vision: OCR + 翻訳 + 正規化 bbox) ----
  function clamp01(v) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
  }

  function buildImagePrompt(sourceLang, targetLang) {
    const Lang = globalThis.Lang;
    const targetName = (Lang && Lang.promptName(targetLang)) || targetLang || "the target language";
    const srcName = Lang ? Lang.promptName(sourceLang) : null;
    return [
      `You are an OCR translator. Detect every text block in the image.`,
      srcName ? `The source language is ${srcName}.` : "",
      `Return ONLY a JSON object {"blocks":[{"original":"...","translation":"...","cy":0,"box":{"x":0,"y":0,"w":0,"h":0}}]}`,
      `All coordinates are normalized 0..1 over the FULL image; the origin (0,0) is the TOP-LEFT pixel and y increases downward.`,
      // VLM は枠の上端(box.y)より「テキストの縦中央(cy)」を桁違いに安定して当てる。cy を一次量として要求し、
      // クライアントは cy に帯の中心を合わせて配置する。これで box.y の系統的な上ズレに依存せず原文行へ重なる。
      `cy is THE MOST IMPORTANT field: the vertical CENTER (midline) of the text. A horizontal line drawn at y=cy must pass exactly through the middle of the visible glyphs — not the top of the line, not the baseline. Get cy right first; models locate this midline far more reliably than edges.`,
      `box tightly encloses ONLY the visible glyphs: x = left edge, x+w = right edge, y = top edge (= cy - h/2), y+h = bottom edge. Exclude avatars, profile pictures, icons, buttons, logos and any surrounding padding.`,
      `Group text into its natural visual blocks (one paragraph or sentence sharing a position); do not merge blocks that are far apart.`,
      `Before answering, re-check every cy: imagine a horizontal line at y=cy; it must cut through the middle of that text. Fix any cy that sits above or below the glyphs.`,
      `Translate each block into ${targetName}; if a block is already in ${targetName}, copy it unchanged.`,
      `If the image has no text, return {"blocks":[]}. No explanations.`,
    ].filter(Boolean).join("\n");
  }

  // Gemini 専用プロンプト。Gemini 2.5 は object detection を「box_2d = [ymin,xmin,ymax,xmax]・0..1000 正規化」で
  // 返すよう訓練されており、自由形式 {x,y,w,h} より bbox 精度が高い。parseImageBlocks で {x,y,w,h}0..1 + cy に変換する。
  function buildImagePromptGemini(sourceLang, targetLang) {
    const Lang = globalThis.Lang;
    const targetName = (Lang && Lang.promptName(targetLang)) || targetLang || "the target language";
    const srcName = Lang ? Lang.promptName(sourceLang) : null;
    return [
      `Detect every text block in the image and translate it.`,
      srcName ? `The source language is ${srcName}.` : "",
      `Return ONLY a JSON array. Each item: {"box_2d":[ymin,xmin,ymax,xmax],"original":"...","translation":"..."}.`,
      `box_2d is the standard 2D bounding box: [ymin, xmin, ymax, xmax] (y first), each an integer normalized 0..1000 over the FULL image with the top-left as origin. Make it tightly enclose ONLY the visible glyphs — exclude avatars, profile pictures, icons, buttons, logos and surrounding padding.`,
      `Translate each block into ${targetName}; if a block is already in ${targetName}, copy it unchanged.`,
      `If the image has no text, return [].`,
    ].filter(Boolean).join("\n");
  }

  // opts: { imageBase64, mimeType, sourceLang, targetLang, model, apiKey }
  function buildImageRequest(providerId, opts) {
    const provider = globalThis.Providers && globalThis.Providers.get(providerId);
    if (!provider || provider.batch === false) return null; // NMT(MyMemory) は vision 不可
    const o = opts || {};
    const model = o.model || provider.defaultModel;
    const apiKey = o.apiKey || "";
    const prompt = buildImagePrompt(o.sourceLang, o.targetLang);
    const mime = o.mimeType || "image/png";
    const b64 = o.imageBase64 || "";

    if (isOpenAICompat(providerId)) {
      // 出力上限を付け、verbose 化による課金枠の浪費を防ぐ (Anthropic/Gemini と同じ IMAGE_MAX_OUTPUT_TOKENS)。
      const cap = maxTokensCap(providerId, IMAGE_MAX_OUTPUT_TOKENS);
      const body = tuneReasoning(providerId, model, Object.assign({
        model, response_format: { type: "json_object" },
        messages: [{ role: "user", content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },
        ] }],
      }, cap));
      return {
        url: provider.endpoint, method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body,
      };
    }
    if (providerId === "anthropic") {
      const body = {
        model, max_tokens: IMAGE_MAX_OUTPUT_TOKENS, temperature: 0,
        messages: [{ role: "user", content: [
          { type: "text", text: prompt },
          { type: "image", source: { type: "base64", media_type: mime, data: b64 } },
        ] }],
      };
      const think = anthropicThinking(model);
      if (think) body.thinking = think;
      return {
        url: provider.endpoint, method: "POST",
        headers: {
          "Content-Type": "application/json", "x-api-key": apiKey,
          "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true",
        },
        body,
      };
    }
    if (providerId === "gemini") {
      const url = provider.endpoint.replace("{model}", encodeURIComponent(model));
      // Gemini はネイティブ box_2d 形式が高精度。responseSchema で型を固定し JSON 崩れも防ぐ。
      // required は translation のみ (テキスト無し画像で空配列を返せるよう box_2d は任意に)。
      const responseSchema = {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            box_2d: { type: "ARRAY", items: { type: "INTEGER" } },
            original: { type: "STRING" },
            translation: { type: "STRING" },
          },
          required: ["translation"],
        },
      };
      return {
        url, method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: {
          contents: [{ role: "user", parts: [
            { text: buildImagePromptGemini(o.sourceLang, o.targetLang) },
            { inline_data: { mime_type: mime, data: b64 } },
          ] }],
          generationConfig: Object.assign({ temperature: 0, responseMimeType: "application/json", responseSchema, maxOutputTokens: IMAGE_MAX_OUTPUT_TOKENS },
            geminiThinkingConfig(model) ? { thinkingConfig: geminiThinkingConfig(model) } : {}),
        },
      };
    }
    return null;
  }

  function parseImageBlocks(providerId, json) {
    const obj = parseJsonLoose(extractContent(providerId, json));
    // Gemini はネイティブの box_2d=[ymin,xmin,ymax,xmax] 0..1000 で返す → {x,y,w,h}0..1 + cy(縦中央) へ変換。
    if (providerId === "gemini") {
      const arr = Array.isArray(obj) ? obj : ((obj && Array.isArray(obj.blocks)) ? obj.blocks : []);
      return arr
        .filter((b) => b && Array.isArray(b.box_2d) && b.box_2d.length === 4 && typeof b.translation === "string" && b.translation)
        .map((b) => {
          const ymin = clamp01(Number(b.box_2d[0]) / 1000), xmin = clamp01(Number(b.box_2d[1]) / 1000);
          const ymax = clamp01(Number(b.box_2d[2]) / 1000), xmax = clamp01(Number(b.box_2d[3]) / 1000);
          const y = Math.min(ymin, ymax), x = Math.min(xmin, xmax);
          const h = clamp01(Math.abs(ymax - ymin)), w = clamp01(Math.abs(xmax - xmin));
          return {
            original: typeof b.original === "string" ? b.original : "",
            translation: b.translation,
            box: { x, y, w, h },
            cy: clamp01(y + h / 2), // box_2d は枠なので縦中央を算出 (配置の主アンカー)
          };
        });
    }
    const blocks = (obj && Array.isArray(obj.blocks)) ? obj.blocks : (Array.isArray(obj) ? obj : []);
    return blocks
      // translation は文字列のみ採用 (オブジェクト等を String 化して "[object Object]" を画像に貼らない)。original も文字列のみ。
      .filter((b) => b && b.box && typeof b.translation === "string" && b.translation)
      .map((b) => {
        const box = { x: clamp01(b.box.x), y: clamp01(b.box.y), w: clamp01(b.box.w), h: clamp01(b.box.h) };
        // cy(縦中央)を優先採用。VLM は枠上端(box.y)より縦中央を安定して当てるため配置の主アンカーにする。無ければ box 縦中央。
        const cy = Number.isFinite(Number(b.cy)) ? clamp01(Number(b.cy)) : clamp01(box.y + box.h / 2);
        return { original: typeof b.original === "string" ? b.original : "", translation: b.translation, box, cy };
      });
  }

  const ProviderApi = Object.freeze({
    buildSystemPrompt,
    buildRequest,
    extractContent,
    extractTranslations,
    parseResponse,
    streamDelta,
    supportsStream: isOpenAICompat, // SSE 早出しは OpenAI 互換社のみ (stream + stream_options を共有)
    parseUsage,
    buildModelsRequest,
    parseModels,
    buildImagePrompt,
    buildImagePromptGemini,
    buildImageRequest,
    parseImageBlocks,
  });

  globalThis.ProviderApi = ProviderApi;
})();
