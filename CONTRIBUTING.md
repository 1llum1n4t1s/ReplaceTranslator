# Contributing — Replace Translator

開発者向けのセットアップ・ビルド・テスト手順。利用者向けの説明は [README.md](README.md) を参照。

## ディレクトリ構成
- `manifest.json` / `manifest.firefox.json` — Chrome / Firefox 用 MV3 マニフェスト
- `src/lib/` — 共通ライブラリ（IIFE + globalThis 公開）
  - `actions.js` — メッセージ定数・設定スキーマ・プロバイダ定義・トークン集計ヘルパー
  - `lang.js` — 言語コード ⇔ 表示名テーブル
  - `providers.js` — プロバイダ抽象（リクエスト/レスポンス/usage + モデル一覧取得。純粋関数）
  - `model-pricing.js` — モデル別の概算価格表（コスト相対表示用）
- `src/background/background.js` — Service Worker（LLM 代理 fetch・メッセージディスパッチ・usage 集計）
- `src/content/translator.js` — DOM インプレース置換翻訳エンジン
- `src/content/fab.js` + `fab.css` — 全ページ右下のフローティング翻訳ボタン（ドラッグ移動・36px）
- `src/content/image-translator.js` + `image-translator.css` — 画像内テキストの翻訳オーバーレイ（オプション・LLM vision）
- `src/popup/` — ポップアップ UI（2タブ「翻訳 / キー」。設定は popup に統合済み、options ページは廃止）
- `_locales/{en,ja}/messages.json` — i18n
- `scripts/generate-icons.js` — SVG → PNG（sharp）
- `test/` — Node 標準テスト

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
```
pnpm run generate-icons          # icons/icon.svg → icon-16/48/128.png
powershell -File zip.ps1         # Chrome zip + Firefox xpi を生成 (Windows)
./zip.sh                         # 同上 (Unix / macOS)
```
`zip.ps1 chrome` / `zip.sh firefox` のように対象を絞ることもできます。

## リリース
`/vava` ワークフロー（設定は `vava.config.json`）で version bump → README 同期 → `release/x.y.z` ブランチ push → GitHub Actions が Chrome Web Store / Firefox AMO へ自動申請します。

CI（`.github/workflows/publish.yml`）に必要な準備:
- GitHub Secrets: `CWS_CLIENT_ID` / `CWS_CLIENT_SECRET` / `CWS_REFRESH_TOKEN` / `CWS_EXTENSION_ID` / `AMO_JWT_ISSUER` / `AMO_JWT_SECRET`
- `.cws-id` を実際の Chrome Web Store Extension ID に差し替える
- `manifest.firefox.json` の `browser_specific_settings.gecko.id` を自分の AMO アドオン ID に合わせる

## アーキテクチャと実装パターン
設計の詳細・守るべきパターンは [CLAUDE.md](CLAUDE.md) を参照してください。
