# IBM Plex Sans JP 同梱情報

- 上流: `IBM/plex` の `@ibm/plex-sans-jp@3.0.0`（フォント内部版 `1.004`）
- ライセンス: SIL Open Font License 1.1（`LICENSE.txt`）
- 配布名: `Replace Translator Sans JP`（OFL の Reserved Font Name 条件に従う改変版名。primary name と PostScript CID name を独自名へ変更）
- 入力: 公式リリースの hinted TTF
  - Regular: Git blob `226ec05eb0032434f82b5fa0a69d8c6ca72f439e`
  - SemiBold: Git blob `d4720d09403678baf0a2b6a4e65f570f2e72e185`
  - Bold: Git blob `7861e098f6a069c696edd806a406ad3a8ccb875d`
- 公式 release asset `ibm-plex-sans-jp.zip` SHA-256: `4c14c41552934b0bc92fc216a76b36bdc78f745dfbeed1115f9b8bc405ee314f`

既存の 7,454 Unicode code point を全ウェイトで共通に保ち、`fonttools[woff] 4.65.0`
（Brotli 1.2.0）の
`pyftsubset` で WOFF2 化する。レイアウト機能は
`ccmp,dnom,liga,numr,vert,vrt2,halt,kern,palt,vhal,vkrn,vpal,mark,mkmk` を残す。
上流 1.004 は `minus` glyph を持つ一方で U+2212 の cmap が無いため、subset 前に
U+2212 を同 glyph へ割り当て、旧版の文字集合を維持している。

生成物 SHA-256:

- `ReplaceTranslatorSansJP-400.woff2`: `48bbd3af8d77fa3153643e976d4ba108f2f5916df3433ad6f7ff243e1073201b`
- `ReplaceTranslatorSansJP-600.woff2`: `d74348c35c823c367d9afbd344db3d7dde5d2c84eb472a8801401bc65ae8398e`
- `ReplaceTranslatorSansJP-700.woff2`: `2e974bac023bf55c429ef1a5b375dbc4e78a3472c10fbce7f79f7df5e6842f39`

上流リリース: <https://github.com/IBM/plex/releases/tag/%40ibm%2Fplex-sans-jp%403.0.0>
