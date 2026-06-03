"use strict";

/**
 * model-pricing.js — モデル別の概算価格表 (相対比較用)
 *
 * 各社の models API は価格を返さないため、既知モデルの $/1M トークン (input/output) を同梱する。
 * 正確な課金額ではなく「どのモデルが相対的に高い/安いか」を示す用途。新モデルが出たら追記する。
 * lookup は部分一致 (最長マッチ優先) で、バージョン付きモデル ID にも当たるようにする。
 */

(function () {
  if (globalThis.__rtPricingLoaded) return;
  globalThis.__rtPricingLoaded = true;

  // [match(部分一致キー), input $/1M, output $/1M]
  const TABLE = [
    // OpenAI (新しい順: GPT-5.x → 4.x。価格は概算・相対比較用)
    ["gpt-5.5", 1.25, 10.00],
    ["gpt-5.4-nano", 0.05, 0.40],
    ["gpt-5.4-mini", 0.25, 2.00],
    ["gpt-5.4", 1.25, 10.00],
    ["gpt-5.2", 1.25, 10.00],
    ["gpt-5-mini", 0.25, 2.00],
    ["gpt-5", 1.25, 10.00],
    ["gpt-4o-mini", 0.15, 0.60],
    ["gpt-4.1-mini", 0.40, 1.60],
    ["gpt-4.1-nano", 0.10, 0.40],
    ["gpt-4.1", 2.00, 8.00],
    ["gpt-4o", 2.50, 10.00],
    ["o3-mini", 1.10, 4.40],
    ["o1-mini", 1.10, 4.40],
    ["o1", 15.00, 60.00],
    // Anthropic (4.x 世代を優先: claude-haiku-4-5 / sonnet-4-6 / opus-4-8。最長一致で 4.x が当たる)
    ["claude-haiku-4", 1.00, 5.00],
    ["claude-sonnet-4", 3.00, 15.00],
    ["claude-opus-4", 15.00, 75.00],
    ["claude-3-5-haiku", 0.80, 4.00],
    ["claude-3-haiku", 0.25, 1.25],
    ["claude-haiku", 0.80, 4.00],
    ["claude-3-5-sonnet", 3.00, 15.00],
    ["claude-3-7-sonnet", 3.00, 15.00],
    ["claude-sonnet", 3.00, 15.00],
    ["claude-opus", 15.00, 75.00],
    // Google Gemini
    ["gemini-1.5-flash-8b", 0.0375, 0.15],
    ["gemini-1.5-flash", 0.075, 0.30],
    ["gemini-2.0-flash-lite", 0.075, 0.30],
    ["gemini-2.0-flash", 0.10, 0.40],
    ["gemini-2.5-flash", 0.30, 2.50],
    ["gemini-2.5-pro", 1.25, 10.00],
    ["gemini-1.5-pro", 1.25, 5.00],
    // xAI Grok
    ["grok-4-1-fast", 0.20, 0.50],
    ["grok-4-fast", 0.20, 0.50],
    ["grok-4.3", 1.25, 2.50],
    ["grok-4", 3.00, 15.00],
    ["grok-3-mini", 0.30, 0.50],
    ["grok-3", 3.00, 15.00],
  ];

  function lookup(modelId) {
    if (!modelId) return null;
    const id = String(modelId).toLowerCase();
    let best = null;
    for (const row of TABLE) {
      if (id.indexOf(row[0]) >= 0 && (!best || row[0].length > best[0].length)) best = row;
    }
    if (!best) return null;
    return { input: best[1], output: best[2], total: best[1] + best[2] };
  }

  globalThis.ModelPricing = Object.freeze({ lookup });
})();
