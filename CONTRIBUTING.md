# Contributing — Replace AI Translator API

開発者向けのセットアップ・ビルド・テスト手順。利用者向けの説明は [README.md](README.md) を参照。

## ディレクトリ構成
- `manifest.json` — MV3 マニフェスト。`background` は Chrome 純正 = `service_worker` のみ（`gecko` は inline）。Firefox 用の `background.scripts` 形式はビルド時に `build-firefox-manifest.mjs` が生成する
- `src/lib/` — 共通ライブラリ（IIFE + globalThis 公開）
  - `actions.js` — メッセージ定数・設定スキーマ・プロバイダ定義・トークン集計ヘルパー
  - `lang.js` — 言語コード ⇔ 表示名テーブル
  - `providers.js` — プロバイダ抽象（リクエスト/レスポンス/usage + モデル一覧取得。純粋関数）
  - `model-pricing.js` — モデル別の概算価格表（コスト相対表示用）
  - `stream.js` — ストリーミング JSON から translations を逐次抽出
- `src/service_worker.js` — Service Worker（LLM 代理 fetch・メッセージディスパッチ・usage 集計）
- `src/content/translator.js` — DOM インプレース置換翻訳エンジン
- `src/content/fab.js` + `fab.css` — 全ページ右端の翻訳タブ（レール型タブ形状・表面はアプリ専用「朱の栞」＝生成りの和紙×墨×朱・ホバーでせり出し・縦ドラッグ移動・ダーク対応）
- `src/content/image-translator.js` + `image-translator.css` — 画像内テキストの翻訳オーバーレイ（ホバー/右クリックの手動・LLM vision）
- `src/popup/` — ポップアップ UI（2タブ「翻訳 / API設定」。設定は popup に統合済み、options ページは廃止）
- `icons/` — `icon.svg`（原本）+ commit 済み `icon{16,48,128}.png`
- `_locales/{en,ja}/messages.json` — i18n
- `test/` — Node 標準テスト
- `webstore/` — ストア掲載素材（`*.html` テンプレ + `generate-screenshots.js`(puppeteer) → `images/{ja,en}/`、CWS/AMO listing テキスト）
- `update-amo-listing.mjs` — AMO listing メタデータ（`amo-metadata.json`）生成スクリプト

## セットアップ
```
pnpm install
```

## 開発（拡張機能の読み込み）
- Chrome: `chrome://extensions` → デベロッパーモード ON → 「パッケージ化されていない拡張機能を読み込む」でリポジトリルートを選択
- コードや CSS を変更したら、拡張機能を再読み込み（🔄）してから動作確認する

## テスト / Lint
```
pnpm test        # Node 標準テスト（actions / providers の純粋関数）
pnpm run lint    # ESLint（Flat Config）
```

## ビルド
アイコン（`icons/icon{16,48,128}.png`）は commit 済みなのでビルド時生成は不要です。
```
powershell -File zip.ps1         # 単一 manifest.json から Chrome zip + Firefox xpi を生成 (Windows)
./zip.sh                         # 同上 (Unix / macOS)
```
`zip.ps1 chrome` / `zip.sh firefox` のように対象を絞ることもできます。

### ストア掲載スクリーンショット
```
pnpm -C webstore install                 # puppeteer を webstore/ に ad-hoc 導入（gitignore 済み）
node webstore/generate-screenshots.js    # → webstore/images/{ja,en}/ にスクショ5枚(1280x800)+プロモ小(440x280)+マーキー(1400x560)
```

## リリース
`/vava` ワークフロー（設定は `vava.config.json`）で version bump → README 同期 → `release/x.y.z` ブランチ push → GitHub Actions が Chrome Web Store / Firefox AMO へ自動申請します。

CI（`.github/workflows/publish.yml`）に必要な準備:
- GitHub Secrets: `CWS_CLIENT_ID` / `CWS_CLIENT_SECRET` / `CWS_REFRESH_TOKEN` / `CWS_EXTENSION_ID` / `AMO_JWT_ISSUER` / `AMO_JWT_SECRET`
- `.cws-id` を実際の Chrome Web Store Extension ID に差し替える
- `manifest.json` の `browser_specific_settings.gecko.id` を自分の AMO アドオン ID に合わせる
- AMO listing（名前/概要/説明）は `webstore/store-listing.firefox.{ja,en}.txt` を編集（CI で `update-amo-listing.mjs` が `amo-metadata.json` を生成し `web-ext sign --amo-metadata` に渡す）

## アーキテクチャと実装パターン
設計の詳細・守るべきパターンは [AGENTS.md](AGENTS.md) を参照してください。
