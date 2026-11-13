"use strict";

/**
 * src/lib の actions.js / translation-core.js / lang.js / providers.js 等を Node から評価して globalThis から取り出すヘルパー。
 *
 * これらは IIFE + globalThis 公開方式なので、vm.runInThisContext で host と同じ realm で評価する
 * (sandbox 別 realm だと URL / Array.prototype 不一致で assert がすり抜けるため)。
 * 各ファイルの __rt*Loaded ガードにより複数回 require されても再評価されない。
 * 読み込み順は依存順 (translation-core.js は actions.js、providers.js は translation-core.js / lang.js のグローバルに依存)。
 * その順序は src/service_worker.js の importScripts(...) を単一ソースとして導出する (_source.js の workerLibScripts)。
 * ここで手書きの一覧を持つと、SW に lib を足したときにテストだけ古い順序・欠けた状態で評価してしまう。
 */

const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { ROOT, workerLibScripts } = require("./_source.js");

for (const rel of workerLibScripts()) {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, rel), "utf8"));
}

module.exports = globalThis;
