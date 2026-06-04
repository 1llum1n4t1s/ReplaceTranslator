# プライバシーポリシー — リプレース翻訳

最終更新: 2026-06-03

## 収集する情報
本拡張機能の開発者は、利用者のデータを収集・保存・受信しません。解析ツールやトラッキングも一切使用しません。翻訳するテキスト（および画像翻訳を有効にした場合は画像）は、利用者が選んだ翻訳プロバイダにのみ送信されます（詳細は下記「翻訳対象テキストの扱い」「画像翻訳（任意）」を参照）。

## API キーの扱い
- 各 LLM プロバイダ（OpenAI / Anthropic / Google / xAI）の API キーは、お使いのブラウザ内（`chrome.storage.local`）にのみ保存されます。MyMemory はキー不要です。
- API キーは、翻訳実行時に該当プロバイダの API へ認証目的でのみ送信されます。本拡張機能の開発者を含む第三者には一切送信されません。

## 翻訳対象テキストの扱い
- 「翻訳」を実行したとき、ページ上のテキストは、利用者が選択したプロバイダの API にのみ送信され、翻訳結果を受け取ります。
- 送信先での扱いは、各プロバイダのプライバシーポリシー・利用規約に従います:
  - OpenAI: https://openai.com/policies/
  - Anthropic: https://www.anthropic.com/legal
  - Google AI: https://ai.google.dev/gemini-api/terms
  - xAI (Grok): https://x.ai/legal/privacy-policy
  - MyMemory (Translated): https://mymemory.translated.net/doc/en/tos.php
- 本拡張機能の開発者が運営するサーバーには、テキストを一切送信しません（送信先は利用者が選んだプロバイダの API のみ）。

## 画像翻訳（任意）
- 画像翻訳を有効にすると、選択した画像（またはページ上の画像）が取得され、選択中の vision 対応プロバイダの API に画像データとして送信され、画像内のテキストを読み取って翻訳します。
- 送信先での扱いは、上記と同じ各プロバイダのプライバシーポリシー・利用規約に従います。MyMemory は画像翻訳に非対応です。この機能は既定でオフです。

## トークン使用量
- トークン使用量は、お使いのブラウザ内（`chrome.storage.local`）に月別で保存されるだけで、外部には送信されません。

## 権限の用途
- `storage`: 設定・API キー・トークン使用量のローカル保存
- `scripting` / `activeTab` / `host_permissions`: 翻訳対象ページへのスクリプト注入と、選択したプロバイダ API への通信
- `contextMenus`: 右クリックメニューからの翻訳 / 原文復元

## お問い合わせ
GitHub Issues: https://github.com/1llum1n4t1s/ReplaceTranslator/issues
