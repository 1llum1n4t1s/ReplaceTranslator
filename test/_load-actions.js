"use strict";

/**
 * src/lib の actions.js / translation-core.js / lang.js / providers.js 等を Node から評価して globalThis から取り出すヘルパー。
 *
 * これらは IIFE + globalThis 公開方式なので、vm.runInThisContext で host と同じ realm で評価する
 * (sandbox 別 realm だと URL / Array.prototype 不一致で assert がすり抜けるため)。
 * 各ファイルの __rt*Loaded ガードにより複数回 require されても再評価されない。
 * 読み込み順は依存順 (translation-core.js は actions.js、providers.js は translation-core.js / lang.js のグローバルに依存)。
 */

const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const load = (rel) => {
  const code = fs.readFileSync(path.join(__dirname, "..", "src", "lib", rel), "utf8");
  vm.runInThisContext(code);
};

load("actions.js");
load("translation-core.js");
load("lang.js");
load("model-pricing.js");
load("providers.js");
load("stream.js");
load("settings-sync.js");

module.exports = globalThis;
