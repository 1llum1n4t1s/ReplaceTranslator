# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

各社クラウド LLM / 無料 NMT でページをインプレース置換翻訳する Chrome / Firefox (MV3) 拡張機能。本ファイルは LLM 向けのアーキテクチャ・実装パターン集（肯定形で記述）。ビルドツール無しのネイティブ JS（`"type": "commonjs"`・ランタイム依存ゼロ・devDeps のみ）。

## ビルド / テスト / Lint コマンド
- `pnpm test` — Node 標準テスト（`node --test`。純粋関数のみ: actions / providers / lang）
- 単一ファイル: `node --test test/providers.test.js` ／ 単一テスト名: `node --test --test-name-pattern "BatchTuner"`
- `pnpm run lint` — ESLint（Flat Config v9+）
- `icons/icon{16,48,128}.png` は **commit 済み**（原本は `icons/icon.svg`）。ビルド時のアイコン生成は無い
- `zip.ps1` / `zip.sh` — 単一 `manifest.json` から Chrome zip + Firefox xpi を生成（中身は同一・generate なし）
- ストア掲載画像は `webstore/*.html`（テンプレ）+ `webstore/generate-screenshots.js`（puppeteer）→ `webstore/images/{ja,en}/`。依存は `webstore/package.json`（gitignore）に隔離し `pnpm -C webstore install` で ad-hoc 導入
- フォント同梱の作り直し: `uvx --from "fonttools[woff]" pyftsubset <IBMPlexSansJP-*.ttf> --unicodes=... --flavor=woff2`（§popup フォント参照）

## 規約上の前提（設計の根拠）
- 大手3社ともブラウザ拡張からサブスクのログインセッション流用は ToS 違反。**API トークンが唯一の正規ルート**。プロバイダ追加時も **API キー方式**で実装する
- 翻訳エンジン（translator.js）はコードに自動テストが無い（DOM + chrome API + LLM 依存）。変更時は `pnpm test`（純粋関数）+ `pnpm run lint` を通し、ロジックを慎重にレビューする。実機確認は API キーが要るためゆろさん側で行う

## アーキテクチャ（3 レイヤ + lib）
```
popup(翻訳 / API設定) / FAB / 右クリック ──APPLY_SETTINGS / TRANSLATE_PAGE / RESTORE_PAGE──▶ background(SW)
                                                                  │ APIキー保管 + 代理fetch + 動的モデル取得
  content(translator.js) ◀── APPLY_TRANSLATE_CS / APPLY_RESTORE_CS ─┤   (全フレームに executeScript 注入)
        └─ TRANSLATE_BATCH (テキスト配列) ───────────────────────────▶┘
```
- メッセージは `Actions`（actions.js）定数で識別。設定変更は `APPLY_SETTINGS` → background が `SettingsSchema.normalize` を通して storage 保存
- 共通定数・スキーマ・`Providers`/`BatchTuner`/`TokenUsage` は `actions.js`、言語表は `lang.js`、プロバイダ抽象（純粋関数）は `providers.js`、価格表は `model-pricing.js`。全て IIFE + globalThis 公開（直接 import 無し）
- 注入: `fab.js` / `image-translator.js` は manifest `content_scripts` で**トップフレーム常駐**。`translator.js` は `actions.js`+`lang.js` と共に `scripting.executeScript`（**`allFrames: true`**）でオンデマンド注入

## 翻訳エンジン translator.js（速度と網羅の要）
- **ビューポート優先**: IntersectionObserver で各ブロックを observe し、可視(+`PREFETCH_MARGIN` 1200px 先読み)に入った順にテキストノードを enqueue。`sortTopDown` で**ページ上→下の優先順位**に並べてから投げる
- **直列 flush + 動的バッチ + ワーカープール**: `flush()` は `flushing` ガードで**1本に直列化**（同時多発を防ぎ 429 を抑える＝BatchTuner が育つ）。共有カーソルから**その時点の `currentBatchSize`** 個ずつ取り出すので、自動学習の成長が同一 flush 内で即反映される。並列度は `concurrencyFor()`（LLM=`CONCURRENCY` 24 / MyMemory 等 `batch:false` は直列 1）。初回 flush は即時、以降 200ms デバウンス
- **失敗の局所化**: 1 バッチが 429/通信エラーでも全停止せず、指数バックオフでリトライ→ダメなら飛ばして続行。NMT(MyMemory)の 429 は解けないので即諦める
- **Shadow DOM**: `collectNodes` は TreeWalker でなく**開いた shadowRoot を辿る DFS**。辿った shadow root は MutationObserver にも登録し内部の動的更新も拾う（closed shadow は仕様上不可）
- **iframe**: `allFrames:true` 注入で各フレームが独立翻訳。広告枠対策に `frameHasEnoughText()`（サブフレームは翻訳対象 50 字未満なら訳さない＝Immersive の mainFrameMinTextCount 相当。メインフレームは常時）
- **SPA 追従**: `onMutate` で `location.href` 変化を検知 + `popstate` リスナー → `scheduleReingest()`（350/1200ms の 2 回 ingest）で遷移後ページを訳し直す
- **動的追加**: MutationObserver（`childList`+`subtree`+`characterData`）。`characterData` mutation は `translatedNodes.has(m.target)` でガードし、自分の nodeValue 書き換えでの再発火を防ぎつつ SPA/チャットの既存テキスト差し替えを取り込む
- **原文復元**: 翻訳ノードは WeakMap(`originalMap`) に原文保持、復元で nodeValue を戻す。`runId` インクリメントで進行中ループを中断
- **拡張 context 失効ハードニング**: リロード/更新で置き去りになった旧 content script が `chrome.runtime.sendMessage` で例外を投げる問題に対し、`contextAlive()`/`shutdown()` + try/catch で静かに停止する（translator / fab / image-translator 全て）
- **再注入の冪等性**: `window.__rtTranslatorLoaded` ガード。lib 各ファイルは `__rt*Loaded` ガード

## 重要パターン（このとおりに実装する）
- **API キーを content に渡さない**: LLM fetch は必ず background(SW) で代理実行。content は翻訳対象テキストを `TRANSLATE_BATCH` で送る。これでキーがページ文脈に漏れず host_permissions で CORS も回避できる
- **プロバイダを追加するとき**: `actions.js` の `Providers` に定義（`requiresKey`/`batch`/`visionModel`/`defaultModel`/`models` 等）を足し、`providers.js` の `buildRequest`/`parseResponse`/`parseUsage`/`buildModelsRequest`/`parseModels` に分岐を足し、`test/providers.test.js` にケースを足す
- **各社の推論を最小化して高速化**: 翻訳は推論不要。`providers.js` の `tuneReasoning` が OpenAI を**モデル別**に振り分ける（gpt-5.1+→`reasoning_effort:"none"` / gpt-5.0系→`"minimal"` / o系→`"low"`、**reasoning モデルには temperature を送らない**＝gpt-5.5 の 400 回避）。Anthropic は思考対応(3.7/4.x)に `thinking:{type:"disabled"}`、Gemini 2.5+ は `thinkingConfig.thinkingBudget`(flash 0/pro 128)、xAI reasoning grok は `reasoning_effort:"low"`。旧 gpt-4 系・非 reasoning は `temperature:0`
- **ページ言語ベースの翻訳元解決**: `sourceLang:"auto"` は translator.js の `detectPageLang()` がページ主要言語に解決してから TRANSLATE_BATCH に載せる（実テキストの `chrome.i18n.detectLanguage`(CLD) を優先し `html lang` 属性は補助、`Lang.normalizeCode` で `ja-JP`→`ja` / `zh`→`zh-Hans` 等に正規化）。**ページ言語=翻訳先のページは翻訳しない**（日本語ページの英語メニュー等の断片を巻き込まない + API 呼び出しゼロ）。メインフレームは `skipped` を通知し、SW の `handleFrameProgress` は他フレームが翻訳中でないときだけ中継 → FAB は未翻訳状態へ・popup は `statusSameLang` 表示。iframe の skip は静かに終わる
- **混在言語のピンポイント翻訳**: `providers.js` の `buildSystemPrompt` で「すでに target 言語の要素はそのまま、同数同順 JSON で返す」と LLM に指示。翻訳元が確定しているとき（ユーザー明示 or ページ言語検出）は「**source 言語の要素だけ**翻訳し他言語はそのまま」、未確定（auto で検出不能）のときだけ「target 以外を翻訳」。クライアント側は accept() で数値/記号/URL/1文字や `code/pre/svg/math/[translate=no]/.notranslate` subtree を事前除外
- **設定は必ず normalize を通す**: `SettingsSchema.normalize` で未知キー除去・欠損補完・partial payload 防御。既定 provider は `mymemory`（キー不要で即翻訳）
- **DOM 構築は innerHTML を使わない**: 動的代入は `createElement` + `textContent` + `replaceChildren()`（AMO 静的解析 `UNSAFE_VAR_ASSIGNMENT` 回避 + XSS 防止）

## 動的モデル取得 & バッチ自動学習
- **モデル一覧**: `GET_MODELS` で各社 models API から動的取得（`buildModelsRequest`/`parseModels`）。`fetchModels` が新しい順(created / Gemini はバージョン)に並べ翻訳系に絞り、**上位 10 件**に `ModelPricing` で価格を付け `MODELS_CACHE`(24h) に保存。選択中が一覧に無ければ `migrateModel` が先頭へ
- **取得は force のときだけ通信** = 「API キー入力後（保存）」と「モデル更新ボタン押下時」。provider 切替/popup 起動は通信せずキャッシュ/同梱フォールバック表示
- **Anthropic は日付入りスナップショット ID しか配信しない** → `anthropicAlias()` で日付を剥がしてエイリアス化し重複排除（除外正規表現で全弾きしないこと）
- **価格**: 各社 models API は価格を返さないため `model-pricing.js` の同梱表（部分一致・最長優先）。新モデルが出たら表を更新する
- **バッチサイズは自動学習**: `BatchTuner`(actions.js・純粋関数)が texts/秒 を hill-climbing（DEFAULT 50 / STEP 25 / MIN5 / MAX100、429 でサイズ半減）。`background` はメモリ(`tuningMem`)で同期更新し、storage 永続化はデバウンス集約（**毎バッチ storage I/O と 10 並列の read-modify-write 競合を避ける**）
- **トークン集計はメモリ保持・非表示**: `recordUsage` が `usageMem`(`tokenUsage[YYYY-MM][provider]`) に加算しデバウンス永続化。popup のトークン表示 UI は撤去済み（表示は無いが集計は残る）

## 画像翻訳（オプション `imageTranslate`）— ホバー手動のみ
- **ホバー手動翻訳に一本化**（一括翻訳 `translateAllImages` / 後追い watcher / iframe 一括注入は廃止＝「読みたい1枚だけ訳す」）。`image-translator.js` が画像ホバーで「訳」ボタンを出し、クリックで `translateImg`→`TRANSLATE_IMAGE`、background が画像を fetch→base64→LLM vision に投げ、`parseImageBlocks` の正規化 bbox をオーバーレイ。`<img>` 限定（**動画は送らない**。background でも非画像 mime を弾く）
- ページ翻訳とは**非連動**。`APPLY_TRANSLATE_CS` では何もせず、`APPLY_RESTORE_CS`（原文復元）でだけ `clearAllImages` がオーバーレイを消す。`imageTranslate` が ON のときだけホバーボタンを出す（`enabled` で gate）
- 速度/コスト優先: 各 provider の軽量 `visionModel` を既定使用、出力上限 `IMAGE_MAX_OUTPUT_TOKENS`(2048)。`ensureWrap` は元 img の表示ボックス(`getBoundingClientRect`)・display・object-fit を wrap に px 固定で引き継ぎ（レスポンシブ画像が inline-block ラップで拡大されるのを防ぐ）、復元時に元 inline style を戻す。オーバーレイ文字は `box.h × 画像高さ × 0.7` で元サイズに追従。vision 対応 LLM のみ（MyMemory 不可）
- `image-translator.js` は manifest `content_scripts` で**トップフレームのみ常駐**（iframe には注入しない）

## UI 構成（popup 2タブ + FAB）
- **popup 2タブ**: 「翻訳」＝自動翻訳トグル / 言語(元・先) / オプション(画像翻訳) / 翻訳・復元ボタン / status / クイック翻訳。「API設定」＝**各プロバイダのカードに「選択ラジオ + 名前 + バッジ + キー入力 + 取得リンク」を合体**＋選択中サービスのモデル一覧(更新ボタン・コスト相対バー)
- **キーは blur 自動保存**: 入力欄からフォーカスが外れたら保存し、そのカードに緑チェックを一瞬出す（保存ボタンは無い）
- FAB は content 常駐（`fab.js`+`fab.css`、トップフレームのみ）。クリックで `TRANSLATE_PAGE`/`RESTORE_PAGE`、`TRANSLATION_PROGRESS` で状態同期。グリフは「訳=これから翻訳 / 原=原文に戻す」、**処理中はボタン表面のシマー**（外周リングは廃止）。ドラッグ移動（位置は `StorageKeys.FAB_POSITION`）。`#__rt_fab` の id プレフィックス + `all:initial` でページ CSS と衝突しない
- **自動翻訳**（`autoTranslate`）: **popup の「全ページ自動翻訳」トグルのみ**が永続フラグを保存する。ワンショット翻訳（popup 翻訳ボタン / FAB / 右クリック）は永続化しない（1 ページ訳しただけで以後の全ページが自動翻訳されるのを防ぐ）。ON なら常駐 fab.js が開いたページを自動翻訳。進捗は `TRANSLATION_PROGRESS` で 3 者同期（トグルの ON/OFF はワンショット進捗では切り替えない）
- **クイック翻訳**（popup「翻訳」タブ末尾・常時表示）: 上部の翻訳元⇄翻訳先を流用し、入力を debounce して `TRANSLATE_BATCH` に 1 件投げる。ページは翻訳しない短文用。コピー/クリア/文字数/`Ctrl+Enter`
- デザインはパステル・モダン（生成り × 墨 × 朱のテーマ色を維持しつつ柔らかく）

## popup フォント（IBM Plex Sans JP を同梱）
- MV3 拡張は CSP/プライバシー/審査の都合で**外部 CDN フォント不可** → フル TTF を `pyftsubset` で必要範囲(Latin/かな/漢字 U+4E00-9FFF/記号)だけサブセット化した woff2 を `src/popup/fonts/` に同梱し `@font-face` で `'self'` から読む（400/600/700）。`popup.css` の `--display`/`--sans` 先頭に指定。明朝は使わない

## Firefox 対応（単一 manifest.json で Chrome / Firefox 共用）
- `manifest.json` の `background` に **`service_worker`（Chrome 用）と `scripts`（Firefox 用 = lib 全ファイル + `src/service_worker.js`）を併記**する。Chrome は `service_worker` を読み、`src/service_worker.js` 冒頭の `importScripts(...)` で lib をロード。Firefox は `scripts` 配列を順次ロード。`typeof importScripts === "function"` ガードで両対応（`manifest.firefox.json` は廃止）
- `browser_specific_settings.gecko`（id / strict_min_version / data_collection_permissions）は `manifest.json` に inline（Chrome は無視するので安全）
- offscreen / tabCapture など Firefox 未対応 API は不使用のため strip マーカー不要

## Lint / i18n 方針
- IIFE + globalThis 公開のため、公開する定数は `eslint.config.js` の `ACTIONS_GLOBALS` に列挙する（新規に globalThis 公開したら追記）。catch の未使用変数は `_` 始まり
- JSDoc コメント内に `*/` を生成する文字列（例: `gpt-5*/o*`）を書かない（コメントが途中で閉じて構文エラーになる）
- UI 文言は `_locales/{en,ja}/messages.json`、HTML は `data-i18n` 属性、JS は `chrome.i18n.getMessage`。文言を足すときは en/ja の両方に追加する

## リリース
- `vava.config.json` + `.cws-id`（実 ID へ要差し替え）+ AMO listing（`webstore/store-listing.firefox.{ja,en}.txt` を single source に、CI で `update-amo-listing.mjs` が `amo-metadata.json` を生成）を使い、`/vava` で version bump → CI 配信
- バージョン番号（`package.json` / `manifest.json`）の更新は**ゆろさんが明示的に指示したときだけ**行う
