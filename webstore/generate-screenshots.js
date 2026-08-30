// ストア掲載スクリーンショット生成（puppeteer + HTML テンプレ）
//
// webstore/*.html を 1280x800 のビューポートでレンダリングし、data-t 属性に
// COPY[slideId][locale] のテキストを注入して ja/en それぞれを撮影する。
//   出力: webstore/images/{ja,en}/0N-*.png（各 1280x800・CWS/AMO 仕様）
//
// 依存（puppeteer）は webstore/ に隔離（.gitignore 済み）:
//   pnpm -C webstore install        # 初回のみ
//   node webstore/generate-screenshots.js
//
// deviceScaleFactor=1 + clip で「ちょうど 1280x800」を出力する（2x にすると
// 2560x1600 になり CWS にアップロードできないため等倍で撮る）。
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const LOCALES = ['ja', 'en'];

// スクショ=1280x800、プロモタイル=440x280 / 1400x560（CWS 仕様）。w/h は viewport と clip に使う。
const SLIDES = [
  { id: '01-hero', file: '01-hero.html', w: 1280, h: 800 },
  { id: '02-popup-translate', file: '02-popup-translate.html', w: 1280, h: 800 },
  { id: '03-popup-api', file: '03-popup-api.html', w: 1280, h: 800 },
  { id: '04-floating-button', file: '04-floating-button.html', w: 1280, h: 800 },
  { id: '05-image-quick', file: '05-image-quick.html', w: 1280, h: 800 },
  { id: 'promo-small-440x280', file: 'promo-small.html', w: 440, h: 280 },
  { id: 'promo-marquee-1400x560', file: 'promo-marquee.html', w: 1400, h: 560 },
];

const COPY = {
  '01-hero': {
    ja: {
      tagline: '表示中のページをその場で置換翻訳。各社クラウド LLM で、文脈をふまえた自然な訳に。',
      c1: 'インプレース置換', c2: '各社 LLM 切替', c3: '混在言語ピンポイント', c4: '無限スクロール対応',
      nokey: 'MyMemory はキー不要',
    },
    en: {
      tagline: "Translate the page you're viewing in place — natural, context-aware results from cloud LLMs.",
      c1: 'In-place replace', c2: 'Switch LLMs', c3: 'Mixed-language', c4: 'Infinite scroll',
      nokey: 'MyMemory — no key',
    },
  },
  '02-popup-translate': {
    ja: {
      kicker: 'ポップアップ', title: 'ワンクリックで 翻訳 / 復元',
      sub: '翻訳元・翻訳先を選んで「翻訳」。トグルでいつでも原文に戻せます。',
      b1: '原文を訳文に差し替え（トグルで復元）', b2: '無限スクロール・SPA も自動で追従', b3: '混在言語はピンポイントで翻訳',
      tabTranslate: '翻訳', tabApi: 'API設定', tabBlacklist: '除外リスト', autoLabel: '全ページ自動翻訳',
      srcLang: '自動検出', tgtLang: '日本語', imgOpt: '画像内テキストの翻訳',
      btnTranslate: '翻訳', btnRestore: '復元', statusMsg: '翻訳が完了しました',
    },
    en: {
      kicker: 'Popup', title: 'Translate or restore in one click',
      sub: 'Pick source and target, hit Translate. Toggle back to the original anytime.',
      b1: 'Replace original text (toggle to restore)', b2: 'Follows infinite scroll & SPAs automatically', b3: 'Pinpoint translation for mixed-language pages',
      tabTranslate: 'Translate', tabApi: 'Keys', tabBlacklist: 'Exclusions', autoLabel: 'Auto-translate every page',
      srcLang: 'Detect language', tgtLang: 'English', imgOpt: 'Image text translation',
      btnTranslate: 'Translate', btnRestore: 'Restore', statusMsg: 'Translation complete',
    },
  },
  '03-popup-api': {
    ja: {
      kicker: 'API設定', title: '自分の API キーで各社 LLM を切替',
      sub: 'プロバイダを選んでキーを入力。キーはブラウザ内にだけ保存されます。',
      nokey: 'MyMemory はキー不要',
      note: 'API キーはページに渡さず background から代理通信。コスト相対バーでモデルを選べます。',
      tabTranslate: '翻訳', tabApi: 'API設定', tabBlacklist: '除外リスト', tagPay: '従量課金', tagFree: '無料枠あり', tagNokey: 'キー不要',
    },
    en: {
      kicker: 'Keys', title: 'Bring your own key — switch providers',
      sub: 'Pick a provider and enter your key. Keys are stored only in your browser.',
      nokey: 'MyMemory — no key',
      note: 'Keys never touch the page — calls are proxied from the background. Compare models by relative cost.',
      tabTranslate: 'Translate', tabApi: 'Keys', tabBlacklist: 'Exclusions', tagPay: 'Pay as you go', tagFree: 'Free tier', tagNokey: 'No key',
    },
  },
  '04-floating-button': {
    // ja = 日本語へ翻訳（before=英語 / after=日本語）
    ja: {
      kicker: 'フローティングボタン', title: 'ページ右下のボタンで 原文 ⇄ 訳文',
      beforeTag: 'Original', beforeH: 'The Future of Productivity',
      beforeP: 'Modern teams move fast. This tool helps you read foreign-language pages without leaving your workflow, keeping the original layout intact.',
      afterTag: '翻訳後', afterH: '生産性の未来',
      afterP: '現代のチームは素早く動きます。このツールは、レイアウトをそのままに、ワークフローから離れずに外国語のページを読む手助けをします。',
      foot: '右クリックメニューや、常駐するフローティングボタンからも翻訳・復元できます。',
    },
    // en = 英語へ翻訳（before=日本語 / after=英語）
    en: {
      kicker: 'Floating button', title: 'Original ⇄ translation, right on the page',
      beforeTag: '原文', beforeH: '生産性の未来',
      beforeP: '現代のチームは素早く動きます。このツールは、レイアウトをそのままに、ワークフローから離れずに外国語のページを読む手助けをします。',
      afterTag: 'Translated', afterH: 'The Future of Productivity',
      afterP: 'Modern teams move fast. This tool helps you read foreign-language pages without leaving your workflow, keeping the original layout intact.',
      foot: 'Translate or restore from the right-click menu or the floating button too.',
    },
  },
  '05-image-quick': {
    // ja = 画像/短文を日本語へ
    ja: {
      kicker: '画像翻訳 & クイック翻訳', title: '画像内テキストの翻訳と、その場の短文翻訳',
      sub: '画像にホバーして「訳」。ポップアップのクイック翻訳は短文をその場で。',
      imgOrig: 'SALE 50% OFF', imgT1: 'セール 50%オフ', imgT2: '本日かぎり',
      imgNote: 'vision 対応 LLM で画像内テキストを読み取り（実験的・既定はオフ）。',
      quickTitle: 'クイック翻訳', quickFlow: '自動検出 → 日本語',
      quickIn: 'Could you send me the report by Friday?',
      quickOut: '金曜日までにレポートを送ってもらえますか？',
      quickChars: '38 文字', quickCopy: 'コピー',
    },
    // en = 画像/短文を英語へ
    en: {
      kicker: 'Image & quick translate', title: 'Translate text inside images, and short text on the spot',
      sub: 'Hover an image and click 訳. Quick translate handles short text in the popup.',
      imgOrig: '本日 50%オフ', imgT1: '50% OFF today', imgT2: 'Today only',
      imgNote: 'Reads text inside images with vision-capable LLMs (experimental, off by default).',
      quickTitle: 'Quick translate', quickFlow: 'Detect → English',
      quickIn: '金曜日までにレポートを送ってもらえますか？',
      quickOut: 'Could you send me the report by Friday?',
      quickChars: '21 chars', quickCopy: 'Copy',
    },
  },
  'promo-small-440x280': {
    ja: { tag: 'ページをその場で置換翻訳' },
    en: { tag: 'In-place page translation' },
  },
  'promo-marquee-1400x560': {
    ja: { tag: '各社クラウド LLM で、表示中のページをその場で置換翻訳。', c1: 'インプレース置換', c2: '各社 LLM 切替', c3: '混在言語ピンポイント', nokey: 'MyMemory はキー不要' },
    en: { tag: "Translate the page you're viewing in place, with cloud LLMs.", c1: 'In-place replace', c2: 'Switch LLMs', c3: 'Mixed-language', nokey: 'MyMemory — no key' },
  },
};

async function shoot(browser, slide, locale) {
  const page = await browser.newPage();
  const { w: W, h: H } = slide;
  try {
    await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
    const url = 'file://' + path.resolve(DIR, slide.file).replace(/\\/g, '/');
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });

    const copy = COPY[slide.id][locale];
    await page.evaluate((copy, lang) => {
      document.documentElement.lang = lang;
      document.querySelectorAll('[data-t]').forEach((el) => {
        const k = el.getAttribute('data-t');
        if (copy[k] !== undefined) el.textContent = copy[k];
      });
    }, copy, locale);

    // 同梱 woff2 のロード完了を待ってから撮る（フォント未ロードでのフォールバック撮影を防ぐ）
    await page.evaluate(async () => { if (document.fonts) { await document.fonts.ready; } });
    await new Promise((r) => setTimeout(r, 350));

    const outDir = path.join(DIR, 'images', locale);
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, slide.id + '.png');
    await page.screenshot({ path: outPath, type: 'png', omitBackground: false, clip: { x: 0, y: 0, width: W, height: H } });
    console.log(`✅ ${locale}/${slide.id}.png`);
  } catch (error) {
    console.error(`❌ ${locale}/${slide.id}: ${error.message}`);
    throw error;
  } finally {
    await page.close();
  }
}

async function main() {
  console.log('🎨 ストア掲載スクリーンショットを生成中...\n');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--font-render-hinting=none', '--force-color-profile=srgb'],
    protocolTimeout: 300000,
  });
  try {
    for (const locale of LOCALES) {
      for (const slide of SLIDES) {
        await shoot(browser, slide, locale);
      }
    }
  } finally {
    await browser.close();
  }
  console.log('\n✨ 完了: webstore/images/{ja,en}/ にスクショ5枚(1280x800) + プロモ小(440x280) + マーキー(1400x560)');
}

main().catch((error) => {
  console.error('❌ エラー:', error);
  process.exit(1);
});
