// store-assets.steps.mjs — ストア画像の撮影前操作（vitrina が読む）。
//
// 翻訳結果を見せる画面は、実際の LLM を呼ばず「翻訳済みの状態」を固定の文で作る（fixture）。
//  - popup-translate / popup-api / popup-quick: ロケール別の設定（翻訳先言語など）を storage.local へ書いて再読込する。
//    API キーはダミー値（password 入力欄なので伏字で描かれる。実キーは一切使わない）。
//  - popup-quick: 入力欄と訳文欄を DOM へ直接置く（input イベントを発火しない = 翻訳 API を呼ばない）。
//  - page-translated: 架空記事の文言をロケール別の「翻訳済み」の文へ差し替え、FAB を「翻訳済み」状態にする。

// popup の翻訳先言語コード（src/lib/lang.js）
const TARGET = { en: "en", ja: "ja", zh_CN: "zh-Hans", zh_TW: "zh-Hant", ko: "ko", es: "es", fr: "fr", de: "de", pt_BR: "pt" };

// ダミーの API キー（伏字表示。実在しない値）
const DUMMY_KEYS = { openai: "sk-demo-0000000000", anthropic: "sk-ant-demo-0000000000", gemini: "AIza-demo-0000000000" };

// 架空記事の翻訳済み文言（ロケール別）
const ARTICLE = {
  en: { meta: "Local news · 3 min read", title: "Harbor Library Opens Its Doors", p1: "After two years of renovation, the old harbor warehouse has reopened as a public library with reading rooms, a children’s corner, and a quiet garden.", p2: "Members can borrow books for three weeks, and the building stays open until nine in the evening on weekdays." },
  ja: { meta: "地域ニュース · 読了3分", title: "港の図書館がオープン", p1: "2年間の改装を経て、旧港倉庫が閲覧室、子ども向けコーナー、静かな庭を備えた公共図書館として生まれ変わりました。", p2: "利用者は本を3週間借りられ、平日は午後9時まで開館します。" },
  zh_CN: { meta: "本地新闻 · 阅读约3分钟", title: "港口图书馆正式开放", p1: "经过两年改造，旧港口仓库重新开放为公共图书馆，设有阅览室、儿童区和一座安静的花园。", p2: "读者可借阅图书三周，工作日开放至晚上九点。" },
  zh_TW: { meta: "地方新聞 · 閱讀約3分鐘", title: "港口圖書館正式開放", p1: "經過兩年整修，舊港口倉庫重新開放為公共圖書館，設有閱覽室、兒童區與一座寧靜的花園。", p2: "讀者可借閱書籍三週，平日開放至晚上九點。" },
  ko: { meta: "지역 뉴스 · 읽는 데 3분", title: "항구 도서관이 문을 엽니다", p1: "2년간의 리모델링을 거쳐 옛 항구 창고가 열람실, 어린이 코너, 조용한 정원을 갖춘 공공 도서관으로 다시 문을 열었습니다.", p2: "이용자는 책을 3주 동안 빌릴 수 있으며, 평일에는 저녁 9시까지 운영합니다." },
  es: { meta: "Noticias locales · 3 min de lectura", title: "La biblioteca del puerto abre sus puertas", p1: "Tras dos años de reformas, el antiguo almacén del puerto ha vuelto a abrir como biblioteca pública, con salas de lectura, un rincón infantil y un jardín tranquilo.", p2: "Los socios pueden llevarse libros prestados durante tres semanas, y el edificio permanece abierto hasta las nueve de la noche en días laborables." },
  fr: { meta: "Actualité locale · 3 min de lecture", title: "La bibliothèque du port ouvre ses portes", p1: "Après deux ans de travaux, l’ancien entrepôt du port rouvre en bibliothèque publique, avec des salles de lecture, un coin pour les enfants et un jardin paisible.", p2: "Les adhérents peuvent emprunter des livres pendant trois semaines, et le bâtiment reste ouvert jusqu’à 21 h en semaine." },
  de: { meta: "Lokalnachrichten · 3 Min. Lesezeit", title: "Hafenbibliothek öffnet ihre Türen", p1: "Nach zwei Jahren Umbau ist das alte Hafenlager als öffentliche Bibliothek mit Leseräumen, einer Kinderecke und einem ruhigen Garten wieder eröffnet worden.", p2: "Mitglieder können Bücher drei Wochen lang ausleihen, und das Gebäude ist werktags bis 21 Uhr geöffnet." },
  pt_BR: { meta: "Notícias locais · 3 min de leitura", title: "Biblioteca do porto abre as portas", p1: "Depois de dois anos de reforma, o antigo armazém do porto reabriu como biblioteca pública, com salas de leitura, um cantinho infantil e um jardim tranquilo.", p2: "Os associados podem levar livros emprestados por três semanas, e o prédio fica aberto até as nove da noite nos dias úteis." },
};

// クイック翻訳の例文。en だけ日本語→英語、他は英語→各言語。
const QUICK_EN = "Could you send me the report by Friday?";
const QUICK = {
  en: { src: "ja", input: "金曜日までにレポートを送っていただけますか？", output: QUICK_EN },
  ja: { src: "en", input: QUICK_EN, output: "金曜日までにレポートを送っていただけますか？" },
  zh_CN: { src: "en", input: QUICK_EN, output: "你能在周五前把报告发给我吗？" },
  zh_TW: { src: "en", input: QUICK_EN, output: "你能在週五前把報告寄給我嗎？" },
  ko: { src: "en", input: QUICK_EN, output: "금요일까지 보고서를 보내 주실 수 있나요?" },
  es: { src: "en", input: QUICK_EN, output: "¿Podría enviarme el informe antes del viernes?" },
  fr: { src: "en", input: QUICK_EN, output: "Pourriez-vous m’envoyer le rapport d’ici vendredi ?" },
  de: { src: "en", input: QUICK_EN, output: "Könnten Sie mir den Bericht bis Freitag schicken?" },
  pt_BR: { src: "en", input: QUICK_EN, output: "Você poderia me enviar o relatório até sexta-feira?" },
};

/** 設定を storage.local の settings へ merge して popup を再読込する（popup の寸法は撮影側で確定済み）。 */
async function applySettings({ page, session }, patch) {
  const worker = await session.getWorker();
  await worker.evaluate(async (p) => {
    const cur = (await chrome.storage.local.get("settings")).settings ?? {};
    await chrome.storage.local.set({ settings: { ...cur, ...p } });
  }, patch);
  await page.reload({ waitUntil: "load" });
  await page.evaluate(async () => { await document.fonts.ready; });
}

/**
 * popup の撮影高さを、指定要素の下端 + extra に合わせる。
 * 実際の popup は 600px で打ち切られるが、ロケールによって行数が変わり、固定の高さだと
 * 文の途中や枠の途中で切れる。要素の区切りで切って、どのロケールでも余白の位置を揃える。
 */
async function fitHeight(page, selector, extra) {
  const height = await page.evaluate((sel) => Math.ceil(document.querySelector(sel).getBoundingClientRect().bottom + window.scrollY), selector);
  const vp = page.viewport();
  await page.setViewport({ ...vp, height: Math.min(600, height + extra) });
}

export default {
  "popup-translate": async (ctx) => {
    await applySettings(ctx, {
      provider: "anthropic",
      apiKeys: { anthropic: DUMMY_KEYS.anthropic },
      sourceLang: "auto",
      targetLang: TARGET[ctx.locale],
      showFab: true,
    });
    // 翻訳スタイルの選択欄の下で切る（その下の補足文が途中で切れないように）
    await fitHeight(ctx.page, "#translation-style", 4);
  },

  "popup-api": async (ctx) => {
    await applySettings(ctx, { provider: "anthropic", apiKeys: DUMMY_KEYS, targetLang: TARGET[ctx.locale] });
    await ctx.page.click('.tab[data-tab="api"]');
    // モデル一覧の下で切る
    await fitHeight(ctx.page, "#model-list", 8);
  },

  "popup-quick": async (ctx) => {
    const q = QUICK[ctx.locale];
    await applySettings(ctx, {
      provider: "anthropic",
      apiKeys: { anthropic: DUMMY_KEYS.anthropic },
      quickSourceLang: q.src,
      quickTargetLang: TARGET[ctx.locale],
      targetLang: TARGET[ctx.locale],
    });
    await ctx.page.click('.tab[data-tab="quick"]');
    // 入力・訳文は DOM へ直接置く（input イベントを発火しない = 実際の翻訳 API は呼ばない）
    await ctx.page.evaluate((input, output) => {
      const inEl = document.getElementById("qt-in");
      inEl.value = input;
      document.getElementById("qt-count").textContent = `${[...input].length} / 5,000`;
      const outEl = document.getElementById("qt-out");
      outEl.classList.remove("err");
      const span = document.createElement("span");
      span.className = "txt";
      span.textContent = output;
      outEl.replaceChildren(span);
    }, q.input, q.output);
    // コピー等のボタン行の下で切る（その下のお問い合わせ欄は含めない）
    await fitHeight(ctx.page, ".qt-foot", 5);
  },

  "page-translated": async ({ page, locale }) => {
    await page.evaluate((texts, lang) => {
      document.documentElement.lang = lang;
      for (const el of document.querySelectorAll("[data-k]")) el.textContent = texts[el.dataset.k];
      // FAB を「翻訳済み（原文に戻す）」の見た目にする（実際の翻訳はしない）
      document.getElementById("__rt_fab")?.classList.add("__rt-on");
    }, ARTICLE[locale], locale.replace("_", "-"));
  },
};
