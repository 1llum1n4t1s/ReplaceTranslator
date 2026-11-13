"use strict";

// 言い換えモード (同じ言語のままページを書き換える) の設定・プロンプト・キャッシュキー・実行判定の契約。
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

// rewriteMode の「既定 OFF・厳密に true だけ有効」は actions.test.js の opt-in フラグ表で検証する。
test("言い換えスタイルは既定まろやかで、未知値を既定へ正規化する", () => {
  const base = SettingsSchema.normalize({});
  assert.equal(base.rewriteStyle, "mild");
  for (const style of ["mild", "formal", "toxic", "osaka", "ibaraki", "gyaru"]) assert.equal(SettingsSchema.normalize({ rewriteStyle: style }).rewriteStyle, style);
  for (const style of ["cute", "constructor", "", 3]) assert.equal(SettingsSchema.normalize({ rewriteStyle: style }).rewriteStyle, "mild");
});

test("言い換えのON/OFFは翻訳元・翻訳先・翻訳スタイルの保存値を変えない", () => {
  const before = SettingsSchema.normalize({ sourceLang: "en", targetLang: "ja", translationStyle: "custom", customPrompt: "短く" });
  const on = SettingsSchema.normalize(SettingsSchema.mergePatch(before, { rewriteMode: true, rewriteStyle: "osaka" }));
  assert.equal(on.sourceLang, "en");
  assert.equal(on.targetLang, "ja");
  assert.equal(on.translationStyle, "custom");
  assert.equal(on.customPrompt, "短く");
  const off = SettingsSchema.normalize(SettingsSchema.mergePatch(on, { rewriteMode: false }));
  assert.deepEqual({ ...off, rewriteStyle: before.rewriteStyle }, before);
});

test("キャッシュキーは通常翻訳と言い換え・スタイル別に分け、通常翻訳のキーは従来と同じ形を保つ", () => {
  const settings = SettingsSchema.normalize({ provider: "openai", sourceLang: "en", targetLang: "en", translationStyle: "custom", customPrompt: "短く" });
  const key = s => TranslationBatch.cacheKey("page", s, ProviderApi.promptVersion, "Hello", "");
  const normal = key(settings);
  // 通常翻訳では言い換えスタイルを変えてもキーは変わらない (= 既存キャッシュを失わない)
  assert.equal(key({ ...settings, rewriteStyle: "osaka" }), normal);
  const parsed = JSON.parse(normal);
  assert.equal(parsed.length, 11);
  assert.equal(parsed[6], "custom");
  assert.equal(parsed[7], "短く");
  const mild = key({ ...settings, rewriteMode: true, rewriteStyle: "mild" });
  const osaka = key({ ...settings, rewriteMode: true, rewriteStyle: "osaka" });
  const ibaraki = key({ ...settings, rewriteMode: true, rewriteStyle: "ibaraki" });
  const formal = key({ ...settings, rewriteMode: true, rewriteStyle: "formal" });
  const toxic = key({ ...settings, rewriteMode: true, rewriteStyle: "toxic" });
  const gyaru = key({ ...settings, rewriteMode: true, rewriteStyle: "gyaru" });
  assert.equal(new Set([normal, mild, formal, toxic, gyaru, osaka, ibaraki]).size, 7);
  assert.equal(JSON.parse(mild).length, 11);
  assert.equal(JSON.parse(mild)[6], "rewrite:mild");
  assert.equal(JSON.parse(mild)[7], "", "言い換えではカスタム指示を送らないのでキーにも含めない");
});

test("言い換えプロンプトは翻訳指示を含まず、同じ言語のまま書き換えさせる", () => {
  const normal = ProviderApi.buildSystemPrompt("en", "en", false, { translationStyle: "natural" });
  assert.equal(ProviderApi.buildSystemPrompt("en", "en", false, { translationStyle: "natural", rewriteMode: false, rewriteStyle: "osaka" }), normal);
  const prompts = {};
  for (const style of ["mild", "formal", "toxic", "osaka", "ibaraki", "gyaru"]) {
    const p = ProviderApi.buildSystemPrompt("ja", "ja", false, { rewriteMode: true, rewriteStyle: style, translationStyle: "custom", customPrompt: "Use a formal tone" });
    prompts[style] = p;
    assert.match(p, /Never translate/);
    assert.match(p, /same language as its input element/);
    assert.match(p, /SAME length and SAME order/);
    assert.match(p, /\{"translations":\[\.\.\.\]\}/);
    assert.doesNotMatch(p, /Translate text into/);
    assert.doesNotMatch(p, /already written in/);
    assert.doesNotMatch(p, /Use a formal tone/);
    assert.doesNotMatch(p, /\n\n/);
  }
  assert.match(prompts.mild, /harmful, hostile, insulting, aggressive/);
  // フォーマルは全言語で同じ言語のまま丁寧な文体へ (日本語限定の指示を含まない)
  assert.match(prompts.formal, /SAME language it is written in, into a formal, polite, professional register/);
  assert.doesNotMatch(prompts.formal, /Japanese/);
  // トキシックは全言語で辛辣な口調へ。差別・脅迫・性的表現などの禁止を必ず含める
  assert.match(prompts.toxic, /SAME language it is written in, into a blunt, snarky, sarcastic, rude/);
  assert.match(prompts.toxic, /Never use slurs, hate speech toward protected groups, threats of violence, sexual content/);
  assert.doesNotMatch(prompts.toxic, /Japanese/);
  assert.doesNotMatch(prompts.toxic, /softening harmful/);
  assert.match(prompts.osaka, /Kansai dialect/);
  assert.match(prompts.ibaraki, /Ibaraki dialect/);
  assert.match(prompts.gyaru, /written in Japanese in decorated Japanese gyaru-moji/);
  // 方言でも日本語以外の要素は「まろやか」と同じく穏やかにする (他言語の有害表現を素通りさせない)
  // 日本語の要素も穏やかにしつつ方言・ギャル文字へ書き換える
  for (const style of ["osaka", "ibaraki", "gyaru"]) {
    assert.match(prompts[style], /written in Japanese (?:into natural, recognizable \w+ dialect|in decorated Japanese gyaru-moji).*preserving the original meaning, and also softening harmful, hostile/);
    assert.match(prompts[style], /For elements not written in Japanese, keep their language and only rewrite them by softening harmful, hostile/);
    assert.doesNotMatch(prompts[style], /not written in Japanese unchanged/);
  }
  assert.equal(ProviderApi.buildSystemPrompt("en", "en", false, { rewriteMode: true, rewriteStyle: "constructor" }), prompts.mild);
  const withContext = ProviderApi.buildSystemPrompt("en", "en", true, { rewriteMode: true, rewriteStyle: "mild" });
  assert.match(withContext, /never rewrite or copy context/);
});

test("言い換えは各LLMの通常・ストリーム要求に反映される", () => {
  const opts = { texts: ["You idiot"], sourceLang: "en", targetLang: "en", rewriteMode: true, rewriteStyle: "mild" };
  for (const provider of g.Providers.ids.filter(id => g.Providers.get(id).batch !== false)) {
    for (const stream of [false, true]) {
      const body = JSON.stringify(ProviderApi.buildRequest(provider, { ...opts, stream }).body);
      assert.match(body, /Never translate/);
      assert.doesNotMatch(body, /Translate text into/);
    }
  }
});

test("言い換えの送信言語はページ主要言語 (不明なら auto) で、言語によるスキップをしない", () => {
  assert.equal(Lang.resolveRewriteLang({ lang: "en", langs: [{ code: "en", pct: 100 }] }), "en");
  assert.equal(Lang.resolveRewriteLang({ lang: "ja", langs: [] }), "ja");
  assert.equal(Lang.resolveRewriteLang({ lang: null, langs: [] }), "auto");
  assert.equal(Lang.resolveRewriteLang(null), "auto");
});

// translator.js の startTranslate を実ソースから切り出し、DOM・observer・送信まわりだけをスタブにして実行する。
// 言語検出 (detectPageLang) の結果を差し替え、同一言語スキップの有無と送信言語を挙動で確かめる
// (旧テストはソース文字列の並び順をなぞっていたため、分岐を同値に書き換えると誤検出していた)。
const loadStartTranslate = (detected) => {
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
    ${functionSource(src, "startTranslate")}
    return {
      startTranslate,
      snapshot: () => ({ translating, progress: progress.join(",") /* vm 別 realm の配列は deepStrictEqual で不一致になるため文字列で返す */, sourceLang: settings.sourceLang, targetLang: settings.targetLang,
        pageTextCount, pageCharCount, announced, droppedTransient }),
    };
  })()`, { Lang, detected, Map, WeakSet, Set, Object, JSON });
};

test("translator は言い換え時に同一言語スキップを通さず、翻訳元=翻訳先=ページ言語で送る", async () => {
  // ページ全体が翻訳先と同じ日本語。通常の自動翻訳ならスキップされる条件。
  const jaPage = { lang: "ja", langs: [{ code: "ja", pct: 100 }] };
  const base = { sourceLang: "auto", targetLang: "ja", rewriteStyle: "osaka" };

  // 対照: 通常の自動翻訳は同一言語ページをスキップし、メインフレームは skipped を通知する。
  const normal = loadStartTranslate(jaPage);
  await normal.startTranslate({ ...base, rewriteMode: false }, 1, false);
  assert.equal(normal.snapshot().translating, false);
  assert.equal(normal.snapshot().progress, "skipped");

  // 言い換え: 同じ条件 (自動・同一言語) でもスキップせず、翻訳元=翻訳先=ページ主要言語で翻訳 run を始める。
  const rewrite = loadStartTranslate(jaPage);
  await rewrite.startTranslate({ ...base, rewriteMode: true }, 1, false);
  const run = rewrite.snapshot();
  assert.equal(run.translating, true);
  assert.equal(run.progress, "progress", "言い換えは言語を理由にスキップしない");
  assert.equal(run.sourceLang, "ja");
  assert.equal(run.targetLang, "ja");
  // 新 run ではページ上限カウンターと done 通知状態を初期化する (前 run の値を持ち越さない)。
  assert.equal(run.pageTextCount, 0);
  assert.equal(run.pageCharCount, 0);
  assert.equal(run.announced, false);
  assert.equal(run.droppedTransient, 0);

  // ページ言語を検出できないときは翻訳元・翻訳先とも auto で送る (保存値の targetLang=ja は使わない)。
  const unknown = loadStartTranslate({ lang: null, langs: [] });
  await unknown.startTranslate({ ...base, rewriteMode: true }, 1, false);
  assert.equal(unknown.snapshot().progress, "progress");
  assert.equal(unknown.snapshot().sourceLang, "auto");
  assert.equal(unknown.snapshot().targetLang, "auto");
  // rewrite_unsupported の全体中断は、actions.test.js の分類テストと content-dom.test.js の flush 振る舞いテストで固定する。
});

// rewrite_unsupported を訳文付きでも NMT でも全体中断 (fatal) に分類することは、
// actions.test.js の classifyBatchResult 表テストで検証する。

// ページ翻訳を開始し、content からの後続バッチを模して送る (popup 送信元 → SW → content の流れ)。
const startPageRun = async (h) => {
  h.context.chrome.scripting = { executeScript: async () => [] };
  const started = await h.send({ action: "TRANSLATE_PAGE", tabId: 1, manual: true });
  assert.equal(started.ok, true);
  const apply = h.partials.find(m => m.action === g.Actions.APPLY_TRANSLATE_CS);
  assert.ok(apply, "APPLY_TRANSLATE_CS が送られる");
  assert.equal(apply.settings.rewriteMode, true);
  return apply.sessionId;
};
const content = { id: "translation-test", url: "https://example.com/", tab: { id: 1 }, frameId: 0 };

test("ページ翻訳の言い換えは同一言語ペアで言い換えプロンプトを送り、選択・クイック翻訳は通常翻訳のまま", async () => {
  const h = workerHarness({ initial: { provider: "openai", apiKeys: { openai: "test-key" }, rewriteMode: true, rewriteStyle: "mild",
    sourceLang: "auto", targetLang: "ja", translationStyle: "cute" } });
  const sessionId = await startPageRun(h);
  const res = await h.send({ action: "TRANSLATE_BATCH", sessionId, texts: ["You idiot"],
    settings: { sourceLang: "en", targetLang: "en" } }, content);
  assert.equal(res.ok, true);
  const prompt = h.requests[0].body.messages[0].content;
  assert.match(prompt, /Never translate/);
  assert.match(prompt, /harmful, hostile/);
  assert.doesNotMatch(prompt, /adorable/);
  // 選択テキスト翻訳 (content 発の quick) は言い換えを適用せず、翻訳スタイルで訳す
  assert.equal((await h.send({ action: "TRANSLATE_BATCH", quick: true, texts: ["Hello"] }, content)).ok, true);
  assert.match(h.requests[1].body.messages[0].content, /Translate text into Japanese/);
  assert.match(h.requests[1].body.messages[0].content, /adorable/);
  // popup のクイック翻訳も同様
  assert.equal((await h.send({ action: "TRANSLATE_BATCH", quick: true, texts: ["Hello"] })).ok, true);
  assert.match(h.requests[2].body.messages[0].content, /Translate text into Japanese/);
});

test("言い換えモードで MyMemory は送信せず rewrite_unsupported を返す", async () => {
  const h = workerHarness({ initial: { provider: "mymemory", rewriteMode: true } });
  const sessionId = await startPageRun(h);
  const res = await h.send({ action: "TRANSLATE_BATCH", sessionId, texts: ["Hello"],
    settings: { sourceLang: "en", targetLang: "en" } }, content);
  assert.equal(res.ok, false);
  assert.equal(res.error, "rewrite_unsupported");
  assert.equal(h.fetches.some(url => url.includes("mymemory")), false);
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
// ページ翻訳を開始し、直近の APPLY_TRANSLATE_CS の sessionId を返す (言い換えの ON/OFF も確認する)。
const startRun = async (h, rewriteMode) => {
  h.context.chrome.scripting = { executeScript: async () => [] };
  const before = h.partials.length;
  assert.equal((await h.send({ action: "TRANSLATE_PAGE", tabId: 1, manual: true })).ok, true);
  const apply = h.partials.slice(before).find(m => m.action === g.Actions.APPLY_TRANSLATE_CS);
  assert.ok(apply, "APPLY_TRANSLATE_CS が送られる");
  assert.equal(apply.settings.rewriteMode, rewriteMode);
  return apply.sessionId;
};
let batchSeq = 0;
const pageBatch = (h, sessionId, texts) => h.send({ action: "TRANSLATE_BATCH", sessionId, batchId: ++batchSeq, texts,
  settings: { sourceLang: "en", targetLang: "en" } }, content);

test("batchId 付き: 言い換えONの訳はキャッシュされるが、言い換えOFFの新セッションでは当たらず再送する", async () => {
  const h = streamHarness({ rewriteMode: true, rewriteStyle: "mild" });
  const on = await startRun(h, true);
  assert.equal((await pageBatch(h, on, ["You idiot"])).ok, true);
  assert.equal(h.bodies.length, 1);
  // 対照: 同じ言い換えセッションの同じ原文はキャッシュに当たり、fetch しない (= キャッシュ経路を通っている)。
  const hit = await pageBatch(h, on, ["You idiot"]);
  assert.equal(hit.ok, true);
  assert.equal(hit.cacheHits, 1);
  assert.equal(h.bodies.length, 1);

  // 言い換えを OFF にして新しいページ翻訳セッションを始めると、同じ原文でもキーが異なるため fetch が起きる。
  assert.equal((await h.send({ action: "APPLY_SETTINGS", patch: { rewriteMode: false } })).ok, true);
  const off = await startRun(h, false);
  const miss = await pageBatch(h, off, ["You idiot"]);
  assert.equal(miss.ok, true);
  assert.equal(miss.cacheHits, 0);
  assert.equal(h.bodies.length, 2, "言い換えの訳を通常翻訳へ流用しない");
  assert.doesNotMatch(h.bodies[1].messages[0].content, /Never translate/);

  // 言い換えへ戻すと、別セッションでも言い換えの訳がキャッシュから再利用される (キーが言い換え側で安定している)。
  assert.equal((await h.send({ action: "APPLY_SETTINGS", patch: { rewriteMode: true } })).ok, true);
  const again = await startRun(h, true);
  assert.equal((await pageBatch(h, again, ["You idiot"])).cacheHits, 1);
  assert.equal(h.bodies.length, 2);
});

test("batchId 付き: OpenAI 互換のストリーム要求にも言い換えプロンプトを送る", async () => {
  const h = streamHarness({ rewriteMode: true, rewriteStyle: "toxic", translationStyle: "cute" });
  const sessionId = await startRun(h, true);
  const res = await pageBatch(h, sessionId, ["Thank you so much"]);
  assert.equal(res.ok, true);
  assert.deepEqual(res.translations, ["rewritten 0"]);
  assert.equal(h.bodies.length, 1);
  const body = h.bodies[0];
  assert.equal(body.stream, true, "stream 分岐を通る");
  assert.match(body.messages[0].content, /Never translate/);
  assert.match(body.messages[0].content, /snarky/);
  assert.doesNotMatch(body.messages[0].content, /adorable/, "言い換え中は翻訳スタイルを送らない");
  assert.doesNotMatch(body.messages[0].content, /Translate text into/);
  // stream の部分訳も content へ届く (batchId があるので TRANSLATE_PARTIAL が送られる)。
  assert.ok(h.partials.some(m => m.action === g.Actions.TRANSLATE_PARTIAL && m.text === "rewritten 0"));
});

test("言い換え規則の番号は全スタイルで 1 からの連番になる", () => {
  for (const style of SettingsSchema.REWRITE_STYLES) {
    for (const hasContext of [false, true]) {
      const prompt = ProviderApi.buildSystemPrompt("ja", "ja", hasContext, { rewriteMode: true, rewriteStyle: style });
      const rules = prompt.split("\n").slice(prompt.split("\n").indexOf("Rules:") + 1);
      assert.ok(rules.length >= 3, style);
      rules.forEach((line, index) => assert.match(line, new RegExp(`^${index + 1}\\. \\S`), `${style} context=${hasContext}`));
    }
  }
});

test("全言い換えスタイルが専用の指示を持つ (未知値の mild フォールバックに頼らない)", () => {
  // 専用指示が無いスタイルは mild の文へ落ちるため、全スタイルのプロンプトが互いに異なれば専用指示がある。
  const prompts = SettingsSchema.REWRITE_STYLES.map(style =>
    ProviderApi.buildSystemPrompt("ja", "ja", false, { rewriteMode: true, rewriteStyle: style }));
  assert.equal(new Set(prompts).size, SettingsSchema.REWRITE_STYLES.length);
});

test("スタイル一覧は凍結配列で公開され、popup の選択肢と一致する", () => {
  const { TRANSLATION_STYLES, JAPANESE_ONLY_STYLES, REWRITE_STYLES } = SettingsSchema;
  for (const list of [TRANSLATION_STYLES, JAPANESE_ONLY_STYLES, REWRITE_STYLES]) assert.ok(Object.isFrozen(list));
  assert.ok(JAPANESE_ONLY_STYLES.every(style => TRANSLATION_STYLES.includes(style)));
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
  // 日本語専用スタイルの option は style-<id> の固定 id を持つ (popup.js の reflectStyleLanguage が参照する)。
  for (const style of JAPANESE_ONLY_STYLES) assert.match(html, new RegExp(`<option id="style-${style}" value="${style}"`));
});
