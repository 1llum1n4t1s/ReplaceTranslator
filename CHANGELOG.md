# 変更履歴

Git のバージョン記録・コミット差分と既存の変更履歴をもとに、確認できた版ごとの変更点をまとめています。「Git 記録日」は公開日ではありません。番号の欠番だけから未確認のリリースは補っていません。

## 未リリース

## [1.0.25] — Git 記録日: 2026-09-05

- 項目単位の設定同期とポップアップの入力保護を追加する
- 言語辞書の参照を堅牢化し未使用スタイルを整理する
- kagayoi-support-extensionを1.0.5へ更新する
- Serena設定の除外を解除する

出典: [版の記録](https://github.com/1llum1n4t1s/ReplaceTranslator/commit/3d78e014f955ed8b3dfb11b50840f85f4e6be547) / [変更差分](https://github.com/1llum1n4t1s/ReplaceTranslator/compare/4bcffb0e9103e3113f4510c6dc3dba6888466717...3d78e014f955ed8b3dfb11b50840f85f4e6be547)。

## [1.0.24] — Git 記録日: 2026-08-31

- SPA遷移ごとに自動翻訳を再判定する
- モデル別に推論量を設定できるようにする

出典: [版の記録](https://github.com/1llum1n4t1s/ReplaceTranslator/commit/4bcffb0e9103e3113f4510c6dc3dba6888466717) / [変更差分](https://github.com/1llum1n4t1s/ReplaceTranslator/compare/2015cda19a2f5fb821974bf170e06b4014f95ac8...4bcffb0e9103e3113f4510c6dc3dba6888466717)。

## [1.0.23] — Git 記録日: 2026-08-30

- 共通サポート部品を1.0.4へ更新する
- 自動翻訳除外と翻訳処理の堅牢性を改善する

出典: [版の記録](https://github.com/1llum1n4t1s/ReplaceTranslator/commit/2015cda19a2f5fb821974bf170e06b4014f95ac8) / [変更差分](https://github.com/1llum1n4t1s/ReplaceTranslator/compare/f2b0b76f44adec8f475b70eb2948f224ac121abb...2015cda19a2f5fb821974bf170e06b4014f95ac8)。

## [1.0.22] — Git 記録日: 2026-08-29

- 文脈付き翻訳キャッシュと安全性を強化する
- 問い合わせUIのCSPと表示を改善する
- プライバシーポリシーにお問い合わせフォームの取り扱いを追記
- 設定画面に Kagayoi Support のお問い合わせフォームを追加
- Node依存関係を更新 (#14)

出典: [版の記録](https://github.com/1llum1n4t1s/ReplaceTranslator/commit/f2b0b76f44adec8f475b70eb2948f224ac121abb) / [変更差分](https://github.com/1llum1n4t1s/ReplaceTranslator/compare/53aeaf3d5d448c0a05712dc1f0e3e0028554dbc6...f2b0b76f44adec8f475b70eb2948f224ac121abb)。

## [1.0.21] — Git 記録日: 2026-08-11

- 選択翻訳の設定反映レースと画像寸法ガードのすり抜けを修正

出典: [版の記録](https://github.com/1llum1n4t1s/ReplaceTranslator/commit/53aeaf3d5d448c0a05712dc1f0e3e0028554dbc6) / [変更差分](https://github.com/1llum1n4t1s/ReplaceTranslator/compare/9ff9992dce4a874b6605a6acc77120d68fe61611...53aeaf3d5d448c0a05712dc1f0e3e0028554dbc6)。

## [1.0.20] — Git 記録日: 2026-08-09

- popup UI刷新・選択翻訳の常時有効化・DeepSeek モデル移行
- 選択テキスト翻訳のトグル廃止 + popup UI刷新（並び順・アイコン・デザイン刷新）
- 品質改善(Grok監査対応): DeepSeek モデル移行・画像取得の HTTP エラーガード

出典: [版の記録](https://github.com/1llum1n4t1s/ReplaceTranslator/commit/9ff9992dce4a874b6605a6acc77120d68fe61611) / [変更差分](https://github.com/1llum1n4t1s/ReplaceTranslator/compare/2936326f3822305449615a64076c0a5953810360...9ff9992dce4a874b6605a6acc77120d68fe61611)。

## [1.0.19] — Git 記録日: 2026-08-02

- ローカルファイル(file://)のページ翻訳に対応
- ランディングページを追加

出典: [版の記録](https://github.com/1llum1n4t1s/ReplaceTranslator/commit/2936326f3822305449615a64076c0a5953810360) / [変更差分](https://github.com/1llum1n4t1s/ReplaceTranslator/compare/1d92d4d3a9e358ae73e3cdb3221efb696a602813...2936326f3822305449615a64076c0a5953810360)。

## [1.0.18] — Git 記録日: 2026-07-22

- 画像の右クリック翻訳を追加
- OAuth応答のログ露出を防止

出典: [版の記録](https://github.com/1llum1n4t1s/ReplaceTranslator/commit/1d92d4d3a9e358ae73e3cdb3221efb696a602813) / [変更差分](https://github.com/1llum1n4t1s/ReplaceTranslator/compare/6841a6a8cafea7711edfe1592b36f860daf53b25...1d92d4d3a9e358ae73e3cdb3221efb696a602813)。

## [1.0.17] — Git 記録日: 2026-07-22

- 手動翻訳で言語混在率フィルターを解除
- CWS pre-flight の OAuth 失敗を errexit で即死させずフォールバックさせる

出典: [版の記録](https://github.com/1llum1n4t1s/ReplaceTranslator/commit/6841a6a8cafea7711edfe1592b36f860daf53b25) / [変更差分](https://github.com/1llum1n4t1s/ReplaceTranslator/compare/4835de2a8c32d7df9d846ca13ea221d56b9c4ffd...6841a6a8cafea7711edfe1592b36f860daf53b25)。

## [1.0.16] — Git 記録日: 2026-07-18

- Reddit 応答停止の修正と画像翻訳ボタンの表示設定を追加

出典: [版の記録](https://github.com/1llum1n4t1s/ReplaceTranslator/commit/4835de2a8c32d7df9d846ca13ea221d56b9c4ffd) / [変更差分](https://github.com/1llum1n4t1s/ReplaceTranslator/compare/c5e54fb6544cdefc7ebbaa45003466e9adb9ff66...4835de2a8c32d7df9d846ca13ea221d56b9c4ffd)。

## [1.0.15] — Git 記録日: 2026-07-15

- 配布用のバージョン情報を更新。機能変更はありません。

出典: [版の記録](https://github.com/1llum1n4t1s/ReplaceTranslator/commit/c5e54fb6544cdefc7ebbaa45003466e9adb9ff66) / [変更差分](https://github.com/1llum1n4t1s/ReplaceTranslator/compare/02900cfdf317f3009027a3826da7847783dc0b00...c5e54fb6544cdefc7ebbaa45003466e9adb9ff66)。

## [1.0.14] — Git 記録日: 2026-07-15

- 翻訳済みページの操作停止を修正

出典: [版の記録](https://github.com/1llum1n4t1s/ReplaceTranslator/commit/02900cfdf317f3009027a3826da7847783dc0b00) / [変更差分](https://github.com/1llum1n4t1s/ReplaceTranslator/compare/c07770133a5b085ae7b5aba21f54e5f32d26e0b3...02900cfdf317f3009027a3826da7847783dc0b00)。

## [1.0.13] — Git 記録日: 2026-07-11

- クイック翻訳に原文と訳文の読み上げを追加し、フッターの折り返しを修正。
- モデル名・価格の取得、大きいページの処理、未翻訳部分の表示と再起動後の動作を改善。

出典: [版の記録](https://github.com/1llum1n4t1s/ReplaceTranslator/commit/c07770133a5b085ae7b5aba21f54e5f32d26e0b3) / [変更差分](https://github.com/1llum1n4t1s/ReplaceTranslator/compare/939629ce56a4550beb09085a0ffa89ea10267179...c07770133a5b085ae7b5aba21f54e5f32d26e0b3)。

## [1.0.12] — Git 記録日: 2026-07-08

- ストア掲載文のキーワードスパム指摘を修正（CWS 審査対応）

出典: [版の記録](https://github.com/1llum1n4t1s/ReplaceTranslator/commit/939629ce56a4550beb09085a0ffa89ea10267179) / [変更差分](https://github.com/1llum1n4t1s/ReplaceTranslator/compare/409255af61a5be95fcbe727cbf1592a60c569aaf...939629ce56a4550beb09085a0ffa89ea10267179)。

## [1.0.11] — Git 記録日: 2026-07-05

- フローティングボタンの不透明度スライダーを追加

出典: [版の記録](https://github.com/1llum1n4t1s/ReplaceTranslator/commit/409255af61a5be95fcbe727cbf1592a60c569aaf) / [変更差分](https://github.com/1llum1n4t1s/ReplaceTranslator/compare/deeeb55980008973cfefe707dd96b136ffea6a65...409255af61a5be95fcbe727cbf1592a60c569aaf)。

## [1.0.10] — Git 記録日: 2026-07-01

- X.com等SNSフィードで混在言語判定が過剰発動する問題を修正
- DOM読み込み済みでも非0×0ブロックがnear化を取りこぼす問題を修正
- extractDisplayValue を正規表現からCSSOMパースへ変更
- styleVisibilityChanged がクラス+インライン上書きの可視化を見逃す問題を修正
- レビュー指摘対応 (shadow DOM内video検出・endDrag例外回避)
- 自動翻訳ONで静止ページが再翻訳ループに入る問題を修正

出典: [版の記録](https://github.com/1llum1n4t1s/ReplaceTranslator/commit/deeeb55980008973cfefe707dd96b136ffea6a65) / [変更差分](https://github.com/1llum1n4t1s/ReplaceTranslator/compare/6534c0fea1a5c311ff311cd15f2b5ee94658cd4a...deeeb55980008973cfefe707dd96b136ffea6a65)。

## [1.0.9] — Git 記録日: 2026-06-26

- 選択したテキストのインライン対訳を追加し、挿入位置・色・編集領域の保護を改善。自己更新する時刻表示の再翻訳ループを修正。

出典: [版の記録](https://github.com/1llum1n4t1s/ReplaceTranslator/commit/6534c0fea1a5c311ff311cd15f2b5ee94658cd4a) / [変更差分](https://github.com/1llum1n4t1s/ReplaceTranslator/compare/998f937fce33249a7f9b503bf69264c92ad44f74...6534c0fea1a5c311ff311cd15f2b5ee94658cd4a)。

## [1.0.8] — Git 記録日: 2026-06-23

- 選択テキスト翻訳のバブル再翻訳と「解析エラー」表示を修正

出典: [版の記録](https://github.com/1llum1n4t1s/ReplaceTranslator/commit/998f937fce33249a7f9b503bf69264c92ad44f74) / [変更差分](https://github.com/1llum1n4t1s/ReplaceTranslator/compare/32f12bd7addb6a15532f6b353c6c05e8f211303c...998f937fce33249a7f9b503bf69264c92ad44f74)。

## [1.0.7] — Git 記録日: 2026-06-23

- Sakana AI (Fugu) を OpenAI 互換プロバイダとして追加

出典: [版の記録](https://github.com/1llum1n4t1s/ReplaceTranslator/commit/32f12bd7addb6a15532f6b353c6c05e8f211303c) / [変更差分](https://github.com/1llum1n4t1s/ReplaceTranslator/compare/e73a0f077f66fa98007ab9250f265a988bfa397e...32f12bd7addb6a15532f6b353c6c05e8f211303c)。

## [1.0.6] — Git 記録日: 2026-06-21

- 全ページ自動翻訳 OFF で今のタブが原文に戻らない競合を修正
- 自動翻訳で翻訳済み箇所を再翻訳する問題を修正(原文書き戻し+原文キャッシュ)
- FAB の地球アイコンが左に寄る問題を修正(朱バー幅ぶん中央へ)
- FAB と選択翻訳バブルをフラットデザインに刷新
- 選択翻訳を Shadow DOM 内の選択に対応(Reddit サイドパネル等)
- 選択翻訳が既存タブで無反応になる問題(content未注入)を修正

出典: [版の記録](https://github.com/1llum1n4t1s/ReplaceTranslator/commit/e73a0f077f66fa98007ab9250f265a988bfa397e) / [変更差分](https://github.com/1llum1n4t1s/ReplaceTranslator/compare/c59faf971e04d4ed7a39afcaa86d83306f66b7a4...e73a0f077f66fa98007ab9250f265a988bfa397e)。

## [1.0.5] — Git 記録日: 2026-06-18

- 廃止モデル耐性・モデル一覧フィルタ・価格表更新・FAB/画像翻訳/popup UI 刷新 (#5)

出典: [版の記録](https://github.com/1llum1n4t1s/ReplaceTranslator/commit/c59faf971e04d4ed7a39afcaa86d83306f66b7a4) / [変更差分](https://github.com/1llum1n4t1s/ReplaceTranslator/compare/4cf649c744238a2e3b2f634c0d6e22395cb2d7ed...c59faf971e04d4ed7a39afcaa86d83306f66b7a4)。

## [1.0.4] — Git 記録日: 2026-06-14

- 依存関係の既知の脆弱性へ対応し、ページへの通知で受信側がいない場合の例外を修正。内部の共通処理を整理。

出典: [版の記録](https://github.com/1llum1n4t1s/ReplaceTranslator/commit/4cf649c744238a2e3b2f634c0d6e22395cb2d7ed) / [変更差分](https://github.com/1llum1n4t1s/ReplaceTranslator/compare/550ce20ccf4b16e88b5bfbb133fe2c45f56bd521...4cf649c744238a2e3b2f634c0d6e22395cb2d7ed)。

## [1.0.3] — Git 記録日: 2026-06-11

- ページ言語ベースの翻訳元解決 + FAB 表示設定を追加

出典: [版の記録](https://github.com/1llum1n4t1s/ReplaceTranslator/commit/550ce20ccf4b16e88b5bfbb133fe2c45f56bd521) / [変更差分](https://github.com/1llum1n4t1s/ReplaceTranslator/compare/939ab04175775f60c53b7cd20c45a35b04ad39e1...550ce20ccf4b16e88b5bfbb133fe2c45f56bd521)。

## [1.0.2] — Git 記録日: 2026-06-06

- バージョンを 1.0.2 に更新（Firefox AMO v1.0.2 提出に合わせ main を同期）
- フォルダ構成を ReviewForMD 規約へ整合 + アプリ名統一(Replace AI Translator API)
- publish.yml の Node を 20→22 に (pnpm 11 が Node v22.13+ 必須)

出典: [版の記録](https://github.com/1llum1n4t1s/ReplaceTranslator/commit/939ab04175775f60c53b7cd20c45a35b04ad39e1) / [変更差分](https://github.com/1llum1n4t1s/ReplaceTranslator/compare/7867de7efc81480022c51be637f2bfdf3833e51a...939ab04175775f60c53b7cd20c45a35b04ad39e1)。

## [1.0.1] — Git 記録日: 2026-06-05

- npm→pnpm 移行 + ドキュメント/CI 調整

出典: [版の記録](https://github.com/1llum1n4t1s/ReplaceTranslator/commit/7867de7efc81480022c51be637f2bfdf3833e51a) / [変更差分](https://github.com/1llum1n4t1s/ReplaceTranslator/compare/9bdfbbbafe9045ea05504cab6a1b5d2be6ec1c4d...7867de7efc81480022c51be637f2bfdf3833e51a)。

## [1.0.0] — Git 記録日: 2026-06-04

- リプレース翻訳: 各社LLM/NMTでインプレース置換翻訳するMV3拡張を実装 (#1)

出典: [版の記録](https://github.com/1llum1n4t1s/ReplaceTranslator/commit/9bdfbbbafe9045ea05504cab6a1b5d2be6ec1c4d)。
