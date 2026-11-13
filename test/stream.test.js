"use strict";

const test = require("node:test");
const assert = require("node:assert");
const g = require("./_load-actions.js");

const { StreamParse } = g;

// チャンク列を順に feed して、確定要素の連結と done 状態を返すヘルパー
const run = (chunks) => {
  const ex = StreamParse.createTranslationsExtractor();
  const out = [];
  for (const c of chunks) out.push(...ex.feed(c));
  return { out, done: ex.done() };
};

test("単一チャンクの完全 JSON から全要素を抽出し done になる", () => {
  const r = run(['{"translations":["こんにちは","世界"]}']);
  assert.deepEqual(r.out, ["こんにちは", "世界"]);
  assert.equal(r.done, true);
});

test("要素は確定した順に逐次返る (まだ閉じていない要素は返さない)", () => {
  const ex = StreamParse.createTranslationsExtractor();
  assert.deepEqual(ex.feed('{"translations":["first"'), ["first"]); // first だけ確定
  assert.deepEqual(ex.feed(',"sec'), []);                           // 第2要素は未確定
  assert.deepEqual(ex.feed('ond"]'), ["second"]);                   // 確定
  assert.equal(ex.done(), true);
});

test("コードフェンス/前置きは最初の '[' まで読み飛ばす", () => {
  const r = run(['```json\n{"translations":["x","y"]}\n```']);
  assert.deepEqual(r.out, ["x", "y"]);
});

test("エスケープ (\\\" \\\\ \\n \\t \\/) を正しく復元する", () => {
  const r = run(['{"translations":["a\\"b","c\\\\d","e\\nf","f\\tg","g\\/h"]}']);
  assert.deepEqual(r.out, ['a"b', "c\\d", "e\nf", "f\tg", "g/h"]);
});

test("\\uXXXX を復元し、4桁が分割されても結合する", () => {
  // あ = "あ"。"\u30" と "42" に分割
  const ex = StreamParse.createTranslationsExtractor();
  const out = [];
  out.push(...ex.feed('{"translations":["\\u30'));
  out.push(...ex.feed('42"]}'));
  assert.deepEqual(out, ["あ"]);
});

test("文字列内の [ ] , は区切りと誤認しない", () => {
  const r = run(['{"translations":["a[1],b]","ok"]}']);
  assert.deepEqual(r.out, ["a[1],b]", "ok"]);
  assert.equal(r.done, true);
});

test("空配列は要素ゼロで done", () => {
  const r = run(['{"translations":[]}']);
  assert.deepEqual(r.out, []);
  assert.equal(r.done, true);
});

test("done 後の余分なチャンクは無視する", () => {
  const ex = StreamParse.createTranslationsExtractor();
  ex.feed('{"translations":["a"]}');
  assert.equal(ex.done(), true);
  assert.deepEqual(ex.feed('garbage"x"'), []); // 終端後は何も拾わない
});

// 要素が文字列でない崩れた応答では、キー名や後続要素を訳文として返すと添字がずれる。早出しの訳文は
// applyOne で translatedNodes に登録され、完全パース失敗 (incomplete) 後の requeue でも直されないため、
// 崩れを検出したらそれ以降は何も返さない (それまでに確定した要素の添字は正しい)。
test("要素が文字列でない崩れた応答では、崩れ以降を返さず添字のずれた部分訳を出さない", () => {
  const objects = run(['{"translations":[{"translation":"こんにちは"},{"translation":"世界"}]}']);
  assert.deepEqual(objects.out, []);
  assert.equal(objects.done, false);
  const numberFirst = run(['{"translations":[1,"b"]}']);
  assert.deepEqual(numberFirst.out, []);
  // 崩れより前に確定した要素は正しい添字なので返す。
  const mixed = run(['{"translations":["a",{"x":"b"},"c"]}']);
  assert.deepEqual(mixed.out, ["a"]);
  // 1 文字ずつ届いても同じ (崩れの検出はチャンク境界に依存しない)。
  const ex = StreamParse.createTranslationsExtractor();
  const out = [];
  for (const ch of '{"translations":["a",null,"c"]}') out.push(...ex.feed(ch));
  assert.deepEqual(out, ["a"]);
});

// 旧「文字列の途中で分割されても結合して確定する」はこのテストに統合した。複数文字の要素を
// 1 文字ずつ feed するので、文字列の途中で分割されるあらゆる位置での結合をまとめて検証できる。
test("1 文字ずつ feed しても全要素を復元する (文字列途中の分割を含む極端な分割耐性)", () => {
  const full = '{"translations":["あいうえお","次","猫犬鳥"]}';
  const ex = StreamParse.createTranslationsExtractor();
  const out = [];
  for (const ch of full) out.push(...ex.feed(ch));
  assert.deepEqual(out, ["あいうえお", "次", "猫犬鳥"]);
  assert.equal(ex.done(), true);
});
