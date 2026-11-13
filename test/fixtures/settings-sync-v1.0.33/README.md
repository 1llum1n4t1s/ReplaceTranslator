# settings-sync-v1.0.33 fixture

`test/settings-sync-compat.test.js` が旧版（v1.0.33）の設定同期と新版の共存を検証するための、旧版コードの逐語コピーです。
CI は浅いクローンで `git show` を使えないため、ファイルとして置いています。編集しないでください。

- 出所コミット: `978486f24e4819e9eb04365fcba3be7e207d83b0`（v1.0.33 リリース）
- 書き出し方法: `git show 978486f:src/lib/<file> > test/fixtures/settings-sync-v1.0.33/<file>`

| ファイル | 元のパス |
| --- | --- |
| `actions.js` | `src/lib/actions.js` |
| `translation-core.js` | `src/lib/translation-core.js` |
| `settings-sync.js` | `src/lib/settings-sync.js` |

配布物は `package-dirs.txt`（icons / src / _locales）だけなので、この fixture は拡張機能に含まれません。
lint 対象からは `eslint.config.js` の `ignores` で外しています。
