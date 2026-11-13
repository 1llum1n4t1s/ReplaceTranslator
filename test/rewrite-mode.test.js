"use strict";

// 言い換えモードの契約。言い換えは翻訳元/翻訳先による通常翻訳への「追加」処理で、
// すでに翻訳先言語で書かれた文を翻訳先言語のまま「まろやか」に言い換える (LLM のみ)。
// 設定・プロンプト・キャッシュキー・同一言語スキップの解除・SW の実効判定を検証する。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const g = require("./_load-actions.js");
const { functionSource } = require("./_source.js");
const workerHarness = require("./_worker-harness.js");

const { SettingsSchema, ProviderApi, TranslationBatch, Lang } = g;
const root = path.join(__dirname, "..");
const SOFTEN_RULE = /1\. If an element is already written in Japanese, do not translate it; rewrite it in Japanese by softening harmful, hostile, insulting, aggressive, or offensive expressions/;

// rewriteMode の「既定 OFF・厳密に true だけ有効」は actions.test.js の opt-in フラグ表で検証する。
test("言い換えスタイルは v1.0.34 と同じ値で、既定まろやか・未知値は既定へ正規化する", () => {
  assert.deepEqual([...SettingsSchema.REWRITE_STYLES], ["mild", "formal", "toxic", "osaka", "ibaraki", "gyaru"]);
  assert.equal(SettingsSchema.normalize({}).rewriteStyle, "mild");
  for (const style of SettingsSchema.REWRITE_STYLES) assert.equal(SettingsSchema.normalize({ rewriteStyle: style }).rewriteStyle, style);
  for (const style of ["cute", "constructor", "", 3]) assert.equal(SettingsSchema.normalize({ rewriteStyle: style }).rewriteStyle, "mild");
});

test("言い換えのON/OFFは翻訳元・翻訳先・翻訳スタイルの保存値を変えない", () => {
  const before = SettingsSchema.normalize({ sourceLang: "en", targetLang: "ja", translationStyle: "custom", customPrompt: "短く" });
  const on = SettingsSchema.normalize(SettingsSchema.mergePatch(before, { rewriteMode: true, rewriteStyle: "toxic" }));
  assert.equal(on.sourceLang, "en");
  assert.equal(on.targetLang, "ja");
  assert.equal(on.translationStyle, "custom");
  assert.equal(on.customPrompt, "短く");
  const off = SettingsSchema.normalize(SettingsSchema.mergePatch(on, { rewriteMode: false }));
  assert.deepEqual({ ...off, rewriteStyle: before.rewriteStyle }, before);
  assert.equal(off.rewriteStyle, "toxic", "OFF にしても言い換えスタイルの保存値は残す");
});

test("言い換えは LLM のときだけ実際に効き、NMT (MyMemory) では通常翻訳として扱う", () => {
  for (const provider of g.Providers.ids) {
    const llm = g.Providers.get(provider).batch !== false;
    assert.equal(SettingsSchema.rewriteActive({ provider, rewriteMode: true }), llm, provider);
    assert.equal(SettingsSchema.rewriteActive({ provider, rewriteMode: false }), false, provider);
  }
  assert.equal(SettingsSchema.rewriteActive({ provider: "unknown", rewriteMode: true }), false);
  assert.equal(SettingsSchema.rewriteActive(null), false);
});

test("キャッシュキーは言い換えのON/OFF・言い換えスタイル・翻訳スタイルで分け、通常翻訳のキーは従来と同じ形を保つ", () => {
  const settings = SettingsSchema.normalize({ provider: "openai", sourceLang: "en", targetLang: "ja", translationStyle: "custom", customPrompt: "短く" });
  const key = s => TranslationBatch.cacheKey("page", s, ProviderApi.promptVersion, "Hello", "");
  const normal = JSON.parse(key(settings));
  assert.equal(normal.length, 11);
  assert.equal(normal[6], "custom");
  assert.equal(normal[7], "短く");
  // 通常翻訳では言い換えスタイルを変えてもキーは変わらない (= 既存キャッシュを失わない)
  assert.equal(key({ ...settings, rewriteStyle: "osaka" }), key(settings));
  const on = JSON.parse(key({ ...settings, rewriteMode: true }));
  assert.equal(on.length, 11, "要素数を変えない (通常翻訳の既存キャッシュを失わない)");
  assert.equal(on[6], "soften:mild:custom");
  assert.equal(on[7], "短く", "言い換え中も翻訳部分にカスタム指示を送るのでキーに含める");
  // v1.0.34 の旧方式 ("rewrite:<style>") のキャッシュには当たらない
  const keys = SettingsSchema.REWRITE_STYLES.map(style => key({ ...settings, rewriteMode: true, rewriteStyle: style }));
  for (const k of keys) assert.doesNotMatch(JSON.parse(k)[6], /^rewrite:/);
  assert.equal(new Set([key(settings), ...keys]).size, SettingsSchema.REWRITE_STYLES.length + 1, "言い換えスタイルごとに別キー");
  // 翻訳スタイルを変えると言い換え中のキーも変わる
  assert.notEqual(key({ ...settings, rewriteMode: true }), key({ ...settings, rewriteMode: true, translationStyle: "cute" }));
});

test("言い換えOFFのプロンプトは従来の文面のまま (1 文字も変えない)", () => {
  const expected = [
    "You are a professional translator. Translate text into Japanese.",
    "The source language is English.",
    "You receive a JSON array of strings.",
    `Return ONLY a JSON object of the form {"translations":[...]} whose array has the SAME length and SAME order as the input array.`,
    "Rules:",
    "1. If an element is already written in Japanese, return it unchanged.",
    "2. Translate ONLY the elements written in English. Return elements in any other language unchanged.",
    "3. Preserve numbers, URLs, emoji, inline code and symbols.",
    "4. Do not add explanations, notes, or any extra fields.",
    "5. Keep each translation natural and concise.",
  ].join("\n");
  assert.equal(ProviderApi.buildSystemPrompt("en", "ja", false, { translationStyle: "natural" }), expected);
  assert.equal(ProviderApi.buildSystemPrompt("en", "ja", false, { translationStyle: "natural", rewriteMode: false }), expected);
});

test("言い換えONのプロンプトは翻訳しつつ、翻訳先言語の要素だけをまろやかに言い換えさせる", () => {
  // 翻訳元が確定 (en→ja): en は訳し、ja は和らげ、第三言語はそのまま。「他言語はそのまま」から ja を除く。
  const fixed = ProviderApi.buildSystemPrompt("en", "ja", false, { rewriteMode: true, translationStyle: "natural" });
  assert.match(fixed, /Translate text into Japanese/);
  assert.match(fixed, /The source language is English/);
  assert.match(fixed, SOFTEN_RULE);
  assert.match(fixed, /Return it unchanged if it contains nothing harsh/);
  assert.match(fixed, /2\. Translate ONLY the elements written in English\. Return elements in any other language except Japanese unchanged\./);
  assert.doesNotMatch(fixed, /return it unchanged\.\n/, "OFF の規則 1 と併記しない");
  assert.doesNotMatch(fixed, /Return elements in any other language unchanged/);

  // 翻訳元未確定 (auto): target 以外を訳し、target は和らげる。
  const auto = ProviderApi.buildSystemPrompt("auto", "ja", true, { rewriteMode: true, translationStyle: "natural" });
  assert.match(auto, SOFTEN_RULE);
  assert.match(auto, /2\. Translate only the elements that are NOT in Japanese\./);
  assert.match(auto, /never translate or copy context/);

  // 翻訳元=翻訳先が明示されても「source だけ訳す」と規則 1 が矛盾しないよう、翻訳元未確定として扱う。
  const same = ProviderApi.buildSystemPrompt("ja", "ja", false, { rewriteMode: true });
  assert.doesNotMatch(same, /The source language is/);
  assert.match(same, /2\. Translate only the elements that are NOT in Japanese\./);

  // 規則番号は 1 から連番 (行数を変えていない)
  const rules = fixed.split("\n").slice(fixed.split("\n").indexOf("Rules:") + 1);
  rules.forEach((line, index) => assert.match(line, new RegExp(`^${index + 1}\\. \\S`)));
});

test("言い換えスタイルは規則 1 (翻訳先言語の要素) だけを変え、方言・ギャル文字は翻訳先が日本語のときだけ効く", () => {
  const prompt = (style, target = "ja", src = "en") => ProviderApi.buildSystemPrompt(src, target, false, { rewriteMode: true, rewriteStyle: style });
  const rule1 = p => p.split("\n").find(line => line.startsWith("1. "));
  const prompts = Object.fromEntries(SettingsSchema.REWRITE_STYLES.map(style => [style, prompt(style)]));
  // 全スタイルが専用の指示を持つ (未知値の mild フォールバックに頼らない)
  assert.equal(new Set(Object.values(prompts).map(rule1)).size, SettingsSchema.REWRITE_STYLES.length);
  for (const [style, p] of Object.entries(prompts)) {
    assert.match(rule1(p), /^1\. If an element is already written in Japanese, do not translate it; rewrite it/, style);
    // 規則 1 以外 (翻訳の規則) はスタイルに関わらず同じ
    assert.deepEqual(p.split("\n").filter(line => !line.startsWith("1. ")), prompts.mild.split("\n").filter(line => !line.startsWith("1. ")), style);
  }
  assert.match(rule1(prompts.formal), /formal, polite, professional register, also softening harmful/);
  assert.match(rule1(prompts.toxic), /blunt, snarky, sarcastic, rude/);
  assert.match(rule1(prompts.toxic), /Never use slurs, hate speech toward protected groups, threats of violence, sexual content/);
  assert.doesNotMatch(rule1(prompts.toxic), /softening harmful/);
  assert.match(rule1(prompts.osaka), /Kansai dialect \(関西弁\).*also softening harmful/);
  assert.match(rule1(prompts.ibaraki), /Ibaraki dialect \(茨城弁\).*also softening harmful/);
  assert.match(rule1(prompts.gyaru), /gyaru-moji.*also softening harmful/);
  // 翻訳先が日本語以外: 方言・ギャル文字は mild に倒し、全言語スタイルはそのまま効く
  for (const style of SettingsSchema.JAPANESE_ONLY_STYLES) assert.equal(prompt(style, "en", "ja"), prompt("mild", "en", "ja"), style);
  assert.match(rule1(prompt("toxic", "en", "ja")), /already written in English, do not translate it; rewrite it in English into a blunt/);
  // 未知値は mild
  assert.equal(prompt("constructor"), prompts.mild);
});

test("言い換えON中も翻訳スタイル・カスタム指示は訳文に適用する", () => {
  const cute = ProviderApi.buildSystemPrompt("en", "ja", false, { rewriteMode: true, translationStyle: "cute" });
  assert.match(cute, /adorable/);
  assert.match(cute, /apply only to translated text/);
  const custom = ProviderApi.buildSystemPrompt("en", "ja", false, { rewriteMode: true, translationStyle: "custom", customPrompt: "短く訳す" });
  assert.match(custom, /短く訳す/);
});

test("言い換えは各LLMの通常・ストリーム要求に反映される", () => {
  const opts = { texts: ["バカじゃないの"], sourceLang: "en", targetLang: "ja", rewriteMode: true };
  for (const provider of g.Providers.ids.filter(id => g.Providers.get(id).batch !== false)) {
    for (const stream of [false, true]) {
      const body = JSON.stringify(ProviderApi.buildRequest(provider, { ...opts, stream }).body);
      assert.match(body, /do not translate it; rewrite it in Japanese/, `${provider} stream=${stream}`);
      assert.match(body, /Translate text into Japanese/, `${provider} stream=${stream}`);
    }
  }
});

// translator.js の startTranslate を実ソースから切り出し、DOM・observer・送信まわりだけをスタブにして実行する。
// 言語検出 (detectPageLang) の結果とプロバイダ種別を差し替え、同一言語スキップの有無と送信言語を挙動で確かめる。
const loadStartTranslate = (detected, { nmt = false } = {}) => {
  const src = fs.readFileSync(path.join(root, "src/content/translator.js"), "utf8");
  const threshold = /const MIXED_LANG_THRESHOLD = (\d+);/.exec(src);
  assert.ok(threshold, "MIXED_LANG_THRESHOLD の宣言が必要");
  return vm.runInNewContext(`(() => {
    // startTranslate が参照・更新するモジュールスコープの状態。前 run の値が残っている状態から始める。
    let requestedSettings = null, settings = null, sessionId = null, manualRun = false;
    let translating = false, runId = 0, announced = true, fatal = "old", droppedTransient = 3;
    let flushing = true, firstFlush = false, currentBatchSize = 9, warmupLeft = 0;
    let queuedNodes = null, pageTextCount = 7, pageCharCount = 70;
    let observedBlocks = null, flushedBlocks = null, observedShadowRoots = null, zeroSizedBlocks = null;
    let io = null, mo = null, ro = null;
    const reingestTimers = [], queue = [], pendingBatches = new Map();
    const RT_BUILD = "test", WARMUP_BATCHES = 2, MIXED_LANG_THRESHOLD = ${threshold[1]};
    const location = { href: "https://example.test/" };
    const window = { setTimeout: () => 0 };
    window.top = window; window.self = window; // メインフレームとして実行する
    const document = { body: {} };
    const progress = [];
    const dbg = () => {};
    const revertTranslations = () => {};
    const frameHasEnoughText = () => true;
    const stopObservers = () => {};
    const startObservers = () => {};
    const ingest = () => {};
    const scheduleReingest = () => {};
    const maybeAnnounceDone = () => {};
    const notifyProgress = (state) => { progress.push(state); };
    const detectPageLang = async () => detected;
    const isNmtProvider = () => nmt;
    ${functionSource(src, "startTranslate")}
    return {
      startTranslate,
      snapshot: () => ({ translating, progress: progress.join(",") /* vm 別 realm の配列は deepStrictEqual で不一致になるため文字列で返す */, sourceLang: settings.sourceLang, targetLang: settings.targetLang,
        pageTextCount, pageCharCount, announced, droppedTransient }),
    };
  })()`, { Lang, detected, nmt, Map, WeakSet, Set, Object, JSON });
};

test("translator は言い換えON (LLM) のとき翻訳先言語のページも同一言語スキップせず、翻訳元/翻訳先は通常どおり使う", async () => {
  // ページ全体が翻訳先と同じ日本語。通常の自動翻訳ならスキップされる条件。
  const jaPage = { lang: "ja", langs: [{ code: "ja", pct: 100 }] };
  const base = { sourceLang: "auto", targetLang: "ja" };

  // 対照: 言い換えOFFの自動翻訳は同一言語ページをスキップし、メインフレームは skipped を通知する。
  const normal = loadStartTranslate(jaPage);
  await normal.startTranslate({ ...base, rewriteMode: false }, 1, false);
  assert.equal(normal.snapshot().translating, false);
  assert.equal(normal.snapshot().progress, "skipped");

  // 言い換えON: 同じ条件 (自動・同一言語) でもスキップせず、翻訳元は auto のまま (target 以外を訳し target を和らげる)。
  const rewrite = loadStartTranslate(jaPage);
  await rewrite.startTranslate({ ...base, rewriteMode: true }, 1, false);
  const run = rewrite.snapshot();
  assert.equal(run.translating, true);
  assert.equal(run.progress, "progress", "言い換えは翻訳先言語のページでもスキップしない");
  assert.equal(run.sourceLang, "auto");
  assert.equal(run.targetLang, "ja", "翻訳先の保存値をそのまま使う");
  // 新 run ではページ上限カウンターと done 通知状態を初期化する (前 run の値を持ち越さない)。
  assert.equal(run.pageTextCount, 0);
  assert.equal(run.pageCharCount, 0);
  assert.equal(run.announced, false);
  assert.equal(run.droppedTransient, 0);

  // 他言語のページは従来どおりページ言語を翻訳元に確定して翻訳する。
  const enPage = loadStartTranslate({ lang: "en", langs: [{ code: "en", pct: 100 }] });
  await enPage.startTranslate({ ...base, rewriteMode: true }, 1, false);
  assert.equal(enPage.snapshot().progress, "progress");
  assert.equal(enPage.snapshot().sourceLang, "en");
  assert.equal(enPage.snapshot().targetLang, "ja");

  // NMT で ON が届いても言い換えはできないので、従来どおり同一言語スキップする (無駄な呼び出しを出さない)。
  const nmt = loadStartTranslate(jaPage, { nmt: true });
  await nmt.startTranslate({ ...base, rewriteMode: true }, 1, false);
  assert.equal(nmt.snapshot().translating, false);
  assert.equal(nmt.snapshot().progress, "skipped");
});

// ページ翻訳を開始し、APPLY_TRANSLATE_CS の sessionId を返す (content へ渡る実効 rewriteMode も確認する)。
const content = { id: "translation-test", url: "https://example.com/", tab: { id: 1 }, frameId: 0 };
const startRun = async (h, rewriteMode) => {
  h.context.chrome.scripting = { executeScript: async () => [] };
  const before = h.partials.length;
  assert.equal((await h.send({ action: "TRANSLATE_PAGE", tabId: 1, manual: true })).ok, true);
  const apply = h.partials.slice(before).find(m => m.action === g.Actions.APPLY_TRANSLATE_CS);
  assert.ok(apply, "APPLY_TRANSLATE_CS が送られる");
  assert.equal(apply.settings.rewriteMode, rewriteMode);
  return apply.sessionId;
};

test("ページ翻訳の言い換えは翻訳と言い換えの両方を指示し、選択・クイック翻訳は通常翻訳のまま", async () => {
  const h = workerHarness({ initial: { provider: "openai", apiKeys: { openai: "test-key" }, rewriteMode: true,
    sourceLang: "auto", targetLang: "ja", translationStyle: "cute" } });
  const sessionId = await startRun(h, true);
  // 既定の模擬応答は訳文 1 件なので、送るテキストも 1 件にする。
  const res = await h.send({ action: "TRANSLATE_BATCH", sessionId, texts: ["バカじゃないの"],
    settings: { sourceLang: "auto", targetLang: "ja" } }, content);
  assert.equal(res.ok, true);
  const prompt = h.requests[0].body.messages[0].content;
  assert.match(prompt, /Translate text into Japanese/);
  assert.match(prompt, SOFTEN_RULE);
  assert.match(prompt, /adorable/, "訳文には翻訳スタイルを適用する");
  // 選択テキスト翻訳 (content 発の quick) は言い換えを適用せず、翻訳スタイルで訳す
  assert.equal((await h.send({ action: "TRANSLATE_BATCH", quick: true, texts: ["Hello"] }, content)).ok, true);
  assert.match(h.requests[1].body.messages[0].content, /adorable/);
  assert.doesNotMatch(h.requests[1].body.messages[0].content, /do not translate it; rewrite it/);
  // popup のクイック翻訳も同様
  assert.equal((await h.send({ action: "TRANSLATE_BATCH", quick: true, texts: ["Hello"] })).ok, true);
  assert.doesNotMatch(h.requests[2].body.messages[0].content, /do not translate it; rewrite it/);
});

test("言い換えONでも MyMemory は通常翻訳として送り、エラーにしない", async () => {
  const h = workerHarness({ initial: { provider: "mymemory", rewriteMode: true, sourceLang: "auto", targetLang: "ja" },
    fetchResponse: (url) => new URL(url).hostname.includes("mymemory")
      ? Response.json({ responseStatus: 200, responseData: { translatedText: "こんにちは" } }) : null });
  // content へは実効値 (OFF) を渡すので、translator は従来どおり同一言語スキップできる
  const sessionId = await startRun(h, false);
  const res = await h.send({ action: "TRANSLATE_BATCH", sessionId, texts: ["Hello"],
    settings: { sourceLang: "en", targetLang: "ja" } }, content);
  assert.equal(res.ok, true);
  assert.deepEqual([...res.translations], ["こんにちは"]);
  assert.ok(h.fetches.some(url => url.includes("mymemory")));
});

// ---- batchId 付き (content の実際のページバッチと同形) の SW 結合 ----
// batchId が無い TRANSLATE_BATCH は translateWithCache のキャッシュ経路も OpenAI 互換の stream 分岐も通らない。
// ここでは batchId を付けて、両経路でも言い換えの指定が正しく効くことを確かめる。

// OpenAI 互換の SSE 応答を返すハーネス。送信された要求本文 (stream 指定を含む) を bodies に記録する。
const streamHarness = (initial) => {
  const bodies = [];
  const h = workerHarness({ initial: { provider: "openai", apiKeys: { openai: "test-key" }, sourceLang: "auto", targetLang: "ja", ...initial },
    fetchResponse: (url, options) => {
      if (new URL(url).hostname !== "api.openai.com" || options.method !== "POST") return null;
      const body = JSON.parse(options.body);
      bodies.push(body);
      const texts = JSON.parse(body.messages.at(-1).content);
      const content = JSON.stringify({ translations: texts.map((_text, i) => `rewritten ${i}`) });
      const sse = `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`;
      return new Response(sse, { headers: { "content-type": "text/event-stream" } });
    } });
  return { ...h, bodies };
};
let batchSeq = 0;
const pageBatch = (h, sessionId, texts) => h.send({ action: "TRANSLATE_BATCH", sessionId, batchId: ++batchSeq, texts,
  settings: { sourceLang: "auto", targetLang: "ja" } }, content);

test("batchId 付き: 言い換えONの訳はキャッシュされるが、言い換えOFFの新セッションでは当たらず再送する", async () => {
  const h = streamHarness({ rewriteMode: true });
  const on = await startRun(h, true);
  assert.equal((await pageBatch(h, on, ["バカじゃないの"])).ok, true);
  assert.equal(h.bodies.length, 1);
  // 対照: 同じ言い換えセッションの同じ原文はキャッシュに当たり、fetch しない (= キャッシュ経路を通っている)。
  const hit = await pageBatch(h, on, ["バカじゃないの"]);
  assert.equal(hit.ok, true);
  assert.equal(hit.cacheHits, 1);
  assert.equal(h.bodies.length, 1);

  // 言い換えを OFF にして新しいページ翻訳セッションを始めると、同じ原文でもキーが異なるため fetch が起きる。
  assert.equal((await h.send({ action: "APPLY_SETTINGS", patch: { rewriteMode: false } })).ok, true);
  const off = await startRun(h, false);
  const miss = await pageBatch(h, off, ["バカじゃないの"]);
  assert.equal(miss.ok, true);
  assert.equal(miss.cacheHits, 0);
  assert.equal(h.bodies.length, 2, "言い換えの訳を通常翻訳へ流用しない");
  assert.doesNotMatch(h.bodies[1].messages[0].content, /do not translate it; rewrite it/);

  // 言い換えへ戻すと、別セッションでも言い換えの訳がキャッシュから再利用される (キーが言い換え側で安定している)。
  assert.equal((await h.send({ action: "APPLY_SETTINGS", patch: { rewriteMode: true } })).ok, true);
  const again = await startRun(h, true);
  assert.equal((await pageBatch(h, again, ["バカじゃないの"])).cacheHits, 1);
  assert.equal(h.bodies.length, 2);
});

test("batchId 付き: OpenAI 互換のストリーム要求にも言い換えスタイルの規則と翻訳スタイルを送る", async () => {
  const h = streamHarness({ rewriteMode: true, rewriteStyle: "toxic", translationStyle: "cute" });
  const sessionId = await startRun(h, true);
  const res = await pageBatch(h, sessionId, ["Thank you so much"]);
  assert.equal(res.ok, true);
  assert.deepEqual(res.translations, ["rewritten 0"]);
  assert.equal(h.bodies.length, 1);
  const body = h.bodies[0];
  assert.equal(body.stream, true, "stream 分岐を通る");
  assert.match(body.messages[0].content, /already written in Japanese, do not translate it; rewrite it in Japanese into a blunt, snarky/);
  assert.match(body.messages[0].content, /Translate text into Japanese/);
  assert.match(body.messages[0].content, /adorable/);
  // stream の部分訳も content へ届く (batchId があるので TRANSLATE_PARTIAL が送られる)。
  assert.ok(h.partials.some(m => m.action === g.Actions.TRANSLATE_PARTIAL && m.text === "rewritten 0"));
});

test("スタイル一覧は凍結配列で公開され、popup の選択肢と一致する", () => {
  const { TRANSLATION_STYLES, JAPANESE_ONLY_STYLES, REWRITE_STYLES } = SettingsSchema;
  for (const list of [TRANSLATION_STYLES, JAPANESE_ONLY_STYLES, REWRITE_STYLES]) assert.ok(Object.isFrozen(list));
  assert.ok(JAPANESE_ONLY_STYLES.every(style => TRANSLATION_STYLES.includes(style) && REWRITE_STYLES.includes(style)));
  for (const style of TRANSLATION_STYLES) assert.equal(SettingsSchema.normalize({ translationStyle: style }).translationStyle, style);
  const html = fs.readFileSync(path.join(root, "src/popup/popup.html"), "utf8");
  const optionValues = (id) => {
    const select = new RegExp(`<select id="${id}"[^>]*>([\\s\\S]*?)</select>`).exec(html);
    assert.ok(select, `#${id} が必要`);
    return [...select[1].matchAll(/<option\b[^>]*\bvalue="([^"]*)"/g)].map(m => m[1]);
  };
  assert.deepEqual(optionValues("translation-style"), [...TRANSLATION_STYLES]);
  // 言い換えの選択肢は表示順 (茨城弁→関西弁) が定数の順と異なるため、集合として比較する。
  assert.deepEqual(optionValues("rewrite-style").sort(), [...REWRITE_STYLES].sort());
  // 日本語専用スタイルの option は固定 id を持つ (popup.js の reflectStyleLanguage が参照する)。
  for (const style of JAPANESE_ONLY_STYLES) {
    assert.match(html, new RegExp(`<option id="style-${style}" value="${style}"`));
    assert.match(html, new RegExp(`<option id="rewrite-style-${style}" value="${style}"`));
  }
});
