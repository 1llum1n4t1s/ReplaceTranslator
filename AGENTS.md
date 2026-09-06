# AGENTS.md

This file provides guidance to Codex when working in this repository.

各社クラウド LLM / 無料 NMT でページをインプレース置換翻訳する Chrome / Firefox (MV3) 拡張機能。本ファイルは LLM 向けの作業規約・実装パターン集（肯定形で記述）。全体の構造・責務・境界・データフロー・設計判断は [DESIGN.md](DESIGN.md)、機能別の実装詳細は [references/architecture.md](references/architecture.md) を正本とする。ビルドツール無しのネイティブ JS（`"type": "commonjs"`・ランタイム依存ゼロ・devDeps のみ）。

## ビルド / テスト / Lint コマンド
- `pnpm test` — Node 標準テスト（`node --test`。共有純粋関数に加え、実ソースから切り出した content / Service Worker 関数と静的契約も検証）
- 単一ファイル: `node --test test/providers.test.js` ／ 単一テスト名: `node --test --test-name-pattern "BatchTuner"`
- `pnpm run lint` — ESLint（Flat Config v9+）
- `icons/icon{16,48,128}.png` は **commit 済み**（原本は `icons/icon.svg`）。ビルド時のアイコン生成は無い
- `zip.ps1` / `zip.sh` — 単一 `manifest.json` から Chrome zip + Firefox xpi を生成（中身は同一・generate なし）
- ストア掲載画像は `webstore/*.html`（テンプレ）+ `webstore/generate-screenshots.js`（puppeteer）→ `webstore/images/{ja,en}/`。依存は `webstore/package.json`（gitignore）に隔離し `pnpm -C webstore install` で ad-hoc 導入
- フォント同梱の作り直し: `uvx --from "fonttools[woff]" pyftsubset <IBMPlexSansJP-*.ttf> --unicodes=... --flavor=woff2`（§popup フォント参照）
- `pnpm sync:support` — exact 固定した `kagayoi-support-extension` から `src/shared/` の共通問い合わせ JS 2本・CSS 3本を同期。これらの逐語コピーは直接編集せず、更新時は依存を上げて同期し、`pnpm exec kagayoi-support-sync --check` で一致を検証する

## 規約上の前提（設計の根拠）
- 大手3社ともブラウザ拡張からサブスクのログインセッション流用は ToS 違反。**API トークンが唯一の正規ルート**。プロバイダ追加時も **API キー方式**で実装する
- 翻訳エンジンと画像翻訳の一部関数・静的契約は `test/content-dom.test.js` で実ソースから検証する。ただし実 DOM + chrome API + LLM を組み合わせた統合テストは無い。変更時は `pnpm test` + `pnpm run lint` を通し、統合ロジックを慎重にレビューする。実機確認は API キーが要るためゆろさん側で行う

## アーキテクチャ（3 レイヤ + lib）
```
popup(翻訳 / API設定) / FAB / 右クリック ──APPLY_SETTINGS / TRANSLATE_PAGE / RESTORE_PAGE──▶ background(SW)
                                                                  │ APIキー保管 + 代理fetch + 動的モデル取得
  content(translator.js) ◀── APPLY_TRANSLATE_CS / APPLY_RESTORE_CS ─┤   (全フレームに executeScript 注入)
        └─ TRANSLATE_BATCH (テキスト配列) ───────────────────────────▶┘
```
- メッセージは `Actions`（actions.js）定数で識別。設定変更は `APPLY_SETTINGS` → background が `SettingsSchema.normalize` を通して storage 保存
- 共通定数・スキーマ・`Providers`/`BatchTuner`/`TokenUsage` は `actions.js`、言語表は `lang.js`、プロバイダ抽象（純粋関数）は `providers.js`、価格表は `model-pricing.js`。全て IIFE + globalThis 公開（直接 import 無し）
- 注入: `fab.js` / `image-translator.js` / `selection-translator.js` は manifest `content_scripts` で**トップフレーム常駐**（`actions.js` が先頭で先に注入）。`translator.js` は `actions.js`+`lang.js` と共に `scripting.executeScript`（**`allFrames: true`**）でオンデマンド注入。選択翻訳は既存タブ救済で `selection-translator.js` を `executeScript` フォールバック注入もする（§選択テキスト翻訳）
- **ローカル HTML（`file:///*`）も翻訳対象**: content_scripts の `matches` に `file:///*` を含める（`host_permissions` の `<all_urls>` は file スキームも覆うので追加不要）。ただし Chrome/Firefox とも**ユーザーが拡張の「ファイルの URL へのアクセスを許可する」を ON にするまで注入されない**（トグル OFF では常駐 content script も `scripting.executeScript` も効かず、SW は `not_injectable` を返す）。popup はこれを `statusNotInjectable` で「file:// なら許可設定を ON にして再読み込み」と案内する（`tab.url` は file 権限が無いと隠されて chrome:// と判別できないため、URL 判定に頼らず 1 文で両方を案内する）。画像翻訳は `isForbiddenImageUrl` が https 以外を弾くのでローカル画像には効かない（SSRF ガードを維持する）

## 機能別の実装詳細

各機能の内部仕様は [references/architecture.md](references/architecture.md) にある。**下の領域を触る前に必ず該当節を読む**。

| 触る対象 | 読む節 |
| --- | --- |
| 翻訳の中核、速度・網羅の調整 | 翻訳エンジン translator.js |
| モデル一覧の取得、バッチ自動学習 | 動的モデル取得 & バッチ自動学習 |
| 画像翻訳（ホバー / 右クリック、vision プロバイダ） | 画像翻訳 |
| popup の 3 タブ、FAB | UI 構成 |
| 設定保存・複数PC同期 | [DESIGN.md](DESIGN.md)「状態と保存」と UI 構成。変更時は `test/settings-sync.test.js` と `test/popup-settings-save.test.js` の契約も確認する |
| 選択テキスト翻訳、浮遊バブル | 選択テキスト翻訳 |

## 重要パターン（このとおりに実装する）
- **API キーを content に渡さない**: LLM fetch は必ず background(SW) で代理実行。content は翻訳対象テキストを `TRANSLATE_BATCH` で送る。これでキーがページ文脈に漏れず host_permissions で CORS も回避できる
- **プロバイダを追加するとき**: `actions.js` の `Providers` に定義（`requiresKey`/`batch`/`visionModel`/`defaultModel`/`models`/`keyUrl` 等）を足し、`Providers.ids` と `DEFAULT_SETTINGS.apiKeys`/`models` にも id を追加、`providers.js` の `buildRequest`/`parseResponse`/`parseUsage`/`buildModelsRequest`/`parseModels` に分岐を足し、`test/providers.test.js` にケースを足す。**popup の UI は静的カードを 1 個追加するだけ**（`popup.html` に `.provider-card[data-provider="X"]`＝`#key-X`/`#link-X` の id 規約に従う。`popup.js` の `setLinks`/`reflectKeys`/`bindKeyAutosave` は `Providers.ids` をループするので個別配線は不要）
- **OpenAI 互換プロバイダは `OPENAI_COMPAT` 集合に id を足すだけ**: chat/completions・Bearer・usage 同形・`/models` 一覧・OpenAI 画像形式を共有する provider（openai/xai/openrouter/deepseek/groq/fugu）は `providers.js` の `const OPENAI_COMPAT` 配列に id を追加すれば、`buildRequest`/`extractContent`/`streamDelta`/`parseUsage`/`buildModelsRequest`/`parseModels`/`buildImageRequest` の全分岐（`isOpenAICompat(id)`）に一括で乗る（各所の条件を二重管理しない）。models URL は endpoint の `/chat/completions` を `/models` に置換して導出。`maxTokensCap` は OpenAI だけ `max_completion_tokens`、他は `max_tokens`。`tuneReasoning` は各社APIの互換でない推論制御だけをprovider/model別に吸収し、未知モデルは`temperature:0`へ倒す。OpenRouter のモデル ID はベンダ接頭辞付き（`google/gemini-2.5-flash` 等）で `model-pricing.js` の部分一致に自然に当たる。vision 非対応の社（DeepSeek / Sakana Fugu）は `visionModel` を付けない（画像翻訳は使えない）。Sakana Fugu は variable-routing 価格のため `model-pricing.js` には載せない（fugu-ultra だけ載せると `pickPriced` で既定 fugu が一覧から消えるので両モデルを価格なしで並べる）
- **各社の推論はモデル別UIで設定し、未指定は最小化**: `reasoningEfforts[provider][model]` に明示値だけを保存し、「自動（推奨）」は翻訳向けの最小値を使う。`providers.js` の `reasoningProfile` が popup の選択肢と request builder の検証を共有し、そのモデルが受理しない値は自動値へ戻す。OpenAI/xAI/Groq は `reasoning_effort`、OpenRouter/Fugu は `reasoning`、DeepSeek v4 は thinking toggle + effort、Anthropic は `output_config.effort`、Gemini 2.5 は thinking budget、Gemini 3+ は `thinkingLevel` へ変換する。通常・stream・画像の全経路へ同じ値を渡し、effort変更時は翻訳キャッシュキーも分ける。未知モデルは推論パラメータを推測せず `temperature:0` に倒す
- **ページ言語ベースの翻訳元解決**: `sourceLang:"auto"` は translator.js の `detectPageLang()` がページ主要言語に解決してから TRANSLATE_BATCH に載せる（実テキストの `chrome.i18n.detectLanguage`(CLD) を優先し `html lang` 属性は補助、`Lang.normalizeCode` で `ja-JP`→`ja` / `zh`→`zh-Hans` 等に正規化。返り値は `{lang, langs}` で各言語の割合も持つ）。**自動翻訳では、ページ言語=翻訳先かつ非翻訳先言語の混在が少ないページは翻訳しない**（日本語ページの英語メニュー等の断片を巻き込まない + API 呼び出しゼロ）。ただし**非翻訳先の言語が一定量（CLD で合計 50% 以上）混在するページは skip せず**、`sourceLang` を確定させず `auto` のまま残して `buildSystemPrompt` の「target 以外を翻訳」で非翻訳先の本文を拾う（日本語UIに囲まれた英語本文記事を skip で取り残さない）。主要言語が翻訳先でないときだけ `sourceLang` を確定する。**popup の翻訳ボタン / FAB / 右クリックからの手動翻訳は `manual:true` を translator まで伝播し、この同一言語・混在率フィルターだけをバイパスする**（小さい iframe の文字数フィルターは維持）。メインフレームは `skipped` を通知し、SW の `handleFrameProgress` は他フレームが翻訳中でないときだけ中継 → FAB は未翻訳状態へ・popup は `statusSameLang` 表示。iframe の skip は静かに終わる
- **混在言語のピンポイント翻訳**: `providers.js` の `buildSystemPrompt` で「すでに target 言語の要素はそのまま、同数同順 JSON で返す」と LLM に指示。翻訳元が確定しているとき（ユーザー明示 or ページ言語検出）は「**source 言語の要素だけ**翻訳し他言語はそのまま」、未確定（auto で検出不能）のときだけ「target 以外を翻訳」。クライアント側は accept() で数値/記号/URL/1文字や 対象外 subtree を事前除外する。除外範囲と閲覧専用本文の例外は [DESIGN.md](DESIGN.md#重要な不変条件) に従う
- **設定は必ず normalize を通す**: `SettingsSchema.normalize` で未知キー除去・欠損補完・partial payload 防御。既定 provider は `mymemory`（キー不要で即翻訳）
- **DOM 構築は innerHTML を使わない**: 動的代入は `createElement` + `textContent` + `replaceChildren()`（AMO 静的解析 `UNSAFE_VAR_ASSIGNMENT` 回避 + XSS 防止）

## popup フォント（IBM Plex Sans JP を同梱）
- MV3 拡張は CSP/プライバシー/審査の都合で**外部 CDN フォント不可** → フル TTF を `pyftsubset` で必要範囲(Latin/かな/漢字 U+4E00-9FFF/記号)だけサブセット化した woff2 を `src/popup/fonts/` に同梱し `@font-face` で `'self'` から読む（400/600/700）。`popup.css` の `--display`/`--sans` 先頭に指定。明朝は使わない

## Firefox 対応（ソース manifest は Chrome 純正・Firefox はビルド時に変換）
- **`manifest.json` の `background` は Chrome 純正 = `service_worker` のみ**。`background.scripts` を入れると Chrome が「`'background.scripts' requires manifest version of 2 or lower.`」警告を開発・ストア両方で出し続けるため除去した。Chrome は `src/service_worker.js` 冒頭の `importScripts(...)` で lib をロード
- **Firefox は `background.service_worker` 非対応**なので、xpi/AMO ビルド時に **`build-firefox-manifest.mjs`** が `background` を `{scripts:[...]}` 形式へ変換する（`service_worker` キーは外す）。`scripts` 配列は `src/service_worker.js` の `importScripts(...)` を**単一ソースに自動生成**（lib 群 → 末尾に `src/service_worker.js`）＝ Chrome/Firefox のロード対象が二重管理にならない。`typeof importScripts === "function"` ガードで両対応
- 変換を噛ませる箇所: `zip.sh`/`zip.ps1` の firefox variant、CI `publish.yml` の「Firefox 用ソースディレクトリ構築」。Chrome zip はソース manifest をそのまま使う（警告なし）
- **Firefox で unpacked 動作確認するときは `manifest.json` 直読みでなく `./zip.sh firefox` で生成した xpi / firefox-build を使う**（ソース manifest には `scripts` が無いため background が動かない）
- `browser_specific_settings.gecko`（id / strict_min_version / data_collection_permissions）は `manifest.json` に inline（Chrome は警告なく無視する）
- offscreen / tabCapture など Firefox 未対応 API は不使用のため strip マーカー不要

## Lint / i18n 方針
- IIFE + globalThis 公開のため、公開する定数は `eslint.config.js` の `ACTIONS_GLOBALS` に列挙する（新規に globalThis 公開したら追記）。catch の未使用変数は `_` 始まり
- JSDoc コメント内に `*/` を生成する文字列（例: `gpt-5*/o*`）を書かない（コメントが途中で閉じて構文エラーになる）
- UI 文言は `_locales/{en,ja}/messages.json`、HTML は `data-i18n` 属性、JS は `chrome.i18n.getMessage`。文言を足すときは en/ja の両方に追加する

## リリース
- `vava.config.json` + `.cws-id` + AMO listing（`webstore/store-listing.firefox.{ja,en}.txt` を single source に、CI で `update-amo-listing.mjs` が `amo-metadata.json` を生成）を使い、`/vava` で version bump → CI 配信
- バージョン番号（`package.json` / `manifest.json`）の更新は**ゆろさんが明示的に指示したときだけ**行う
