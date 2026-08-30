# ReplaceTranslator 設計

ReplaceTranslator は、利用者が選んだクラウド LLM または無料 NMT を使い、表示中のページをブラウザ内でインプレース翻訳する Chrome / Firefox Manifest V3 拡張機能である。翻訳経路に開発者のサーバーを置かず、ページから抽出したデータは利用者が選んだ翻訳プロバイダへ直接送る。

本書はシステム全体の構造、責務、境界、データフロー、設計判断の正本である。実装時の作業規約と必須検証は [AGENTS.md](AGENTS.md)、機能別の細かな実装契約は [references/architecture.md](references/architecture.md)、開発手順は [CONTRIBUTING.md](CONTRIBUTING.md) を参照する。

## システム境界

- 拡張機能本体は `manifest.json`、`src/`、`icons/`、`_locales/` から構成し、実行時依存やバンドル工程を持たない。
- ポップアップ、常駐 content script、オンデマンド注入する翻訳エンジン、background Service Worker の3レイヤと共通ライブラリで動作する。
- APIキーと認証付き通信は Service Worker が所有する。content script はページ文脈で動くが、APIキーを受け取らない。
- `src/shared/` の問い合わせ・評価UIは `kagayoi-support-extension` から同期して拡張へ同梱する。問い合わせ内容は利用者の明示送信時だけ Kagayoi Support API へ送る。
- `web/` はランディングページとプライバシーページを配信する独立した Cloudflare Worker であり、翻訳処理や拡張機能の配布には関与しない。
- Chrome Web Store / Firefox AMO が拡張機能を配布する。GitHub Actions は `release/<version>` ブランチを契機に検証、パッケージ生成、各ストアへの提出を行う。

## 主要コンポーネント

| コンポーネント | 責務 |
| --- | --- |
| `manifest.json` | 権限、常駐 content script、ポップアップ、Chrome用 Service Worker、ロケールを定義する単一のソース |
| `src/popup/` | 翻訳・復元、言語とプロバイダの選択、APIキーや表示設定、クイック翻訳を提供する |
| `src/service_worker.js` | 設定とAPIキーの管理、プロバイダへの代理通信、タブへの注入、進捗集約、モデル取得、右クリック・コマンド処理を担う |
| `src/content/translator.js` | ページ言語判定、対象テキストの収集と優先付け、バッチ送信、DOM置換、原文復元、動的DOM追従を担う |
| `src/content/fab.*` | トップフレームに常駐し、翻訳・復元操作と進捗表示をページ上に提供する |
| `src/content/selection-translator.*` | 明示操作された選択テキストを翻訳し、バブルまたはインラインで表示する |
| `src/content/image-translator.*` | 明示操作された画像を取得し、vision対応プロバイダの結果をオーバーレイ描画する |
| `src/shared/kagayoi-support-*` | 設定画面の問い合わせ・評価UIを提供する、共通パッケージから同期した同梱資産 |
| `src/lib/actions.js` | メッセージ名、保存キー、設定正規化、プロバイダ定義、バッチ調整などの共有契約を定義する |
| `src/lib/providers.js` | 各プロバイダの要求・応答・usage・モデル一覧・画像要求を共通形式へ変換する |
| `src/lib/lang.js` | 対応言語とコード正規化を提供する |
| `src/lib/model-pricing.js` | モデル価格の照合と比較表示用データを提供する |
| `src/lib/stream.js` | ストリーミング応答から確定済み翻訳要素を逐次抽出する |
| `_locales/` | 利用者向け文言の英語・日本語リソースを保持する |
| `build-firefox-manifest.mjs` | Chrome用manifestからFirefox用 `background.scripts` 構成を生成する |
| `test/` | 共有契約・純粋関数に加え、実ソースから切り出した content / Service Worker 関数と静的整合性を Node 標準テストで検証する |

## データフロー

### ページ翻訳

1. ポップアップ、FAB、右クリック、または自動翻訳が `TRANSLATE_PAGE` を Service Worker へ送る。自動翻訳だけは、保存済みのURL・ホストブラックリストに一致した場合、この境界で注入前に終了する。
2. Service Worker は `actions.js`、`lang.js`、`translator.js` を対象タブの全フレームへ注入し、翻訳開始を指示する。
3. translator はページ主要言語を判定し、除外規則を満たすテキストノードを収集する。可視領域とその近傍を優先し、同じ原文と周辺文脈の組をまとめ、プロバイダ別の並列上限と学習済みバッチサイズに従って処理する。
4. content script は原文と曖昧さ解消用の限定された周辺文脈を `TRANSLATE_BATCH` で Service Worker へ渡す。Service Worker はプロバイダ、モデル、言語、origin、文脈、プロンプト版を含む完全一致キーで翻訳キャッシュを照合し、未一致分だけ選択プロバイダへAPIキー付きで送信する。
5. Service Worker は応答を共通の文字列配列へ変換し、成功した未一致分をキャッシュへ保存して同じ入力を待つノードへ展開する。ストリーミング対応経路では確定済み要素を逐次contentへ中継し、完了時にusageとバッチ調整状態を更新する。
6. translator は応答の個数と順序を対応付けてDOMを書き換え、原文をノード単位で保持する。全フレームの進捗はService Workerがタブ単位に集約してポップアップとFABへ中継する。
7. `RESTORE_PAGE` では進行中処理を中断し、保持していた原文へ戻す。タブ世代番号により、古い非同期翻訳開始が後から復元操作を上書きすることを防ぐ。

### 選択テキスト・画像翻訳

- 選択翻訳はホットキーまたは右クリックという利用者の明示操作から開始する。content scriptが選択範囲を読み、1件のクイック翻訳としてService Workerへ送る。
- 画像翻訳はホバーボタンまたは右クリックという利用者の明示操作から開始する。Service Workerが外部URLと画像サイズを検証して取得し、vision対応プロバイダへ送る。content scriptは返された領域情報を使って訳文を重ねる。
- どちらもページ翻訳の実行世代とは独立し、ページ全体の自動翻訳設定を変更しない。

## 状態と保存

`chrome.storage.local` は次の状態を保持する。

- 正規化済み設定とAPIキー
- 月別・プロバイダ別のトークン使用量
- FABの縦位置
- 動的モデル一覧と価格のキャッシュ
- プロバイダ別のバッチサイズ学習状態
- 常駐content scriptへ渡す非機密フラグ
- 利用者が「永続翻訳キャッシュ」を明示的に有効化した場合だけ、原文・文脈・訳文からなる期限付きキャッシュ

`chrome.storage.session` は実行中のページセッションと、ブラウザ終了時に消える期限付き翻訳キャッシュを保持する。翻訳キャッシュは最大30日・2000件・合計200万文字に制限し、原文または周辺文脈が1文字でも変われば別キーになる。永続キャッシュは既定OFFで、OFFへ戻した時点で session/local の両層を削除する。AbortController、タブ世代、フレーム進捗、モデルフォールバックなどの一時状態はService Workerのメモリ上に保持する。translatorは翻訳対象ノード、原文、直近の訳文、同一実行中の原文―訳文メモをページ内で管理し、復元または実行の再開始で破棄する。

## 重要な不変条件

- APIキーをcontent scriptやページへ渡さず、認証付きfetchをService Workerへ集約する。
- 保存設定は `SettingsSchema.normalize` を通し、未知値・欠損値を既定値へ正規化する。
- 翻訳バッチは入力と同数・同順の文字列配列として扱い、形式不正や件数不一致をDOMへ適用しない。
- 翻訳元が確定している場合はその言語だけを翻訳し、未確定の場合は翻訳先言語以外だけを翻訳する。
- `code`、`pre`、SVG、MathML、`translate=no`、`.notranslate` などの対象外領域をプロバイダへ送らない。
- 原文を保持してから `nodeValue` を置換し、復元可能性を維持する。ページ由来の値で `innerHTML` を組み立てない。
- 画像送信と選択翻訳は利用者の明示操作を起点とし、自動で送信しない。
- fetchにはタイムアウトと中断を適用し、恒久エラーと一時エラーを区別して進捗へ反映する。
- content scriptと共通ライブラリは再注入可能な冪等ガードを持ち、拡張機能context失効時は静かに停止する。
- ソースの `manifest.json` はChrome用 `service_worker` 形式に保ち、Firefox用manifestはService Workerの `importScripts` を単一ソースとしてビルド時に生成する。
- 拡張機能パッケージへリモートJavaScriptやランディングページの `web/` を含めない。

## 採用済みの設計判断

### ネイティブJavaScriptとIIFE

ビルドツールと実行時依存を持たず、MV3で読み込むファイルをそのまま配布する。共通ライブラリはIIFEから `globalThis` へ限定公開するため、Chromeの `importScripts`、Firefoxのbackground scripts、contentへのオンデマンド注入で同じファイルを共有できる。一方でモジュール境界は静的importより弱いため、ESLintのglobal定義と純粋関数テストで契約を補強する。

### Service Workerによるプロバイダ抽象と秘密情報の隔離

全プロバイダ通信をService Workerへ寄せ、`providers.js` が会社ごとの差を共通形式へ変換する。新しいプロバイダは定義・要求変換・応答変換を追加すればUIと翻訳エンジンを共有できる。Service Workerの休止・再起動を前提に、永続すべき状態はstorageへ置き、進行中処理だけをメモリへ置く。

### 共通サポート部品のローカル同梱

問い合わせ・評価UIの正本は exact 固定した `kagayoi-support-extension` とし、JavaScript 2本とCSS 3本を `src/shared/` へ逐語同期して配布物へ含める。各拡張での分岐を防ぎつつ、MV3で禁止されるリモートJavaScriptと実行時依存を避ける代わりに、パッケージ更新時は同期と一致検証を必要とする。

### ビューポート優先・動的バッチ・限定並列

ページ全体を一括送信せず、利用者が先に読む領域を優先してバッチ化する。往復回数を抑えつつ、実測スループットとレート制限からバッチサイズを調整し、プロバイダ固有の並列上限を適用する。速度とAPI制限への耐性を得る代わりに、DOM監視、再試行、部分完了の状態管理が複雑になる。

### 文脈付き完全一致キャッシュ

同じ原文でも見出しや前後の文章が違えば訳し分けられるよう、限定された周辺文脈を要求とキャッシュキーへ含める。完全一致した入力だけを再利用するため、誤字修正や設定・モデル・プロンプト変更後に古い訳文を返さない。ブラウザセッション内の共有キャッシュは常時使い、原文を再起動後まで残す永続層はプライバシー上の判断から明示オプトインに限定する。

### 動的DOM追従と復元可能な置換

MutationObserver、IntersectionObserver、ResizeObserverと遅延再走査を組み合わせ、SPA、無限スクロール、open Shadow DOM、遅延描画を追跡する。原文と拡張機能が書いた訳文を区別し、仮想DOMによる書き戻しと実際の文言更新を別処理にする。closed Shadow DOMと小さなiframeは対象外という境界を持つ。

### Chrome manifestを単一ソースにするクロスブラウザ配布

Chromeが受理する `background.service_worker` だけをソースmanifestに記述する。Firefox用の `background.scripts` はパッケージ生成時に自動導出し、二重管理による読み込み漏れを防ぐ。ローカルのFirefox確認でも生成済みXPIまたはFirefox buildを使う。

### 既存ページとUIの分離

FAB、選択翻訳、画像翻訳は接頭辞付きID・クラス、`all: initial`、同梱CSSでページ側スタイルとの衝突を抑える。動的文字列はDOM APIと `textContent` で構築し、拡張ページのCSPを `self` に限定する。

## 検証境界

- `pnpm test` は設定スキーマ、プロバイダ変換、言語処理、ストリーム解析などの純粋ロジックと、実ソースから切り出した content / Service Worker 関数・静的契約を検証する。
- `pnpm run lint` は `src/` と `test/` の静的規約を検証する。
- `pnpm exec kagayoi-support-sync --check` は `src/shared/` と exact 固定した共通サポートパッケージの一致を検証する。
- `pnpm install --frozen-lockfile` はCIと配布時の依存再現性を保証する。
- ページ翻訳エンジン、ブラウザAPI、各社APIを組み合わせた統合動作は自動テストの外側にあり、拡張機能を再読み込みした実ブラウザと利用者のAPIキーで確認する。
- ChromeとFirefoxの配布物は同じ共有ディレクトリから作り、Firefox版は生成manifestを `web-ext lint` で検証する。
