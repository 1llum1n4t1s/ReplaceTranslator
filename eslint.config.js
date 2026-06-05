/**
 * ESLint Flat Config (v9+ 形式)
 *
 * 設計方針:
 * - `src/` の IIFE + globalThis 公開定数を明示列挙 (no-implicit-globals 違反を防ぎつつ、
 *   actions.js / lang.js / providers.js が公開する定数を読み取り専用 global として承認する)
 * - Chrome 内蔵 AI のグローバル (Translator / LanguageDetector / LanguageModel) も将来利用のため許可
 * - `test/` は Node 標準 test runner 環境
 */

const globals = require("globals");

const ACTIONS_GLOBALS = {
  // src/lib/*.js が globalThis に公開する定数。
  // 新規 globalThis 公開を追加したら本リストにも追加すること。
  Actions: "readonly",          // src/lib/actions.js — メッセージアクション定数
  SettingsSchema: "readonly",   // src/lib/actions.js — 設定スキーマ + normalize
  StorageKeys: "readonly",      // src/lib/actions.js — storage キー
  Providers: "readonly",        // src/lib/actions.js — プロバイダ定義 (id/label/endpoint/model)
  TokenUsage: "readonly",       // src/lib/actions.js — usage 集計ヘルパー (currentMonthKey/addUsage)
  Lang: "readonly",             // src/lib/lang.js — 言語コード ⇔ 表示名テーブル
  ProviderApi: "readonly",      // src/lib/providers.js — buildRequest/parseResponse/parseUsage/parseModels
  BatchTuner: "readonly",       // src/lib/actions.js — バッチサイズ自動学習
  ModelPricing: "readonly",     // src/lib/model-pricing.js — モデル別概算価格
  StreamParse: "readonly",      // src/lib/stream.js — ストリーミング JSON から translations を逐次抽出
};

const COMMON_RULES = {
  // IIFE wrap 化は段階的に行う方針のため top-level の no-implicit-globals は warn 止まり。
  "no-implicit-globals": "warn",
  "no-undef": "error",
  "no-unused-vars": [
    "warn",
    { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
  ],
};

module.exports = [
  {
    ignores: [
      "node_modules/**",
      "firefox-build/**",
      "web-ext-artifacts/**",
      "temp-build*/**",
      "**/*.min.js",
    ],
  },
  {
    // 拡張機能本体 (src/): ブラウザ + WebExtensions + globalThis 公開定数 + 内蔵 AI
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        chrome: "readonly",
        browser: "readonly",
        importScripts: "readonly",
        Translator: "readonly",
        LanguageDetector: "readonly",
        LanguageModel: "readonly",
        ...ACTIONS_GLOBALS,
      },
    },
    rules: COMMON_RULES,
  },
  {
    // テスト: Node 標準 test runner + actions.js グローバル参照経路を許可
    files: ["test/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        ...globals.node,
        ...ACTIONS_GLOBALS,
      },
    },
    rules: COMMON_RULES,
  },
];
