// AMO (addons.mozilla.org) listing メタデータ生成スクリプト
//
// listing の単一の真実の源（single source of truth）:
//   - webstore/store-listing.firefox.ja.txt   … 名前 / 概要 / 説明（ja）
//   - webstore/store-listing.firefox.en.txt   … Name / Summary / Description (en-US)
//   - vava.config.json (amo ブロック)         … categories / homepage / supportUrl
//   - package.json (license)                  … SPDX ライセンス slug
//
// これらを parse して `amo-metadata.json` を生成する。生成物は
// `web-ext sign --amo-metadata=amo-metadata.json` に渡され、AMO の listing
// （名前・概要・説明・カテゴリ・homepage・support_url・version.license）を
// 提出のたびに同期する。
//
// 実行: node update-amo-listing.mjs
// 出力: amo-metadata.json（リポジトリルート、.gitignore 済みの生成物）

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * store-listing テキストを「■」見出しで分割する。
 * 並び順は「名前 → 概要 → 説明」で固定。説明以降の section は
 * すべて description に結合する（ja/en 両ファイルのヘッダ仕様に準拠）。
 * ラベル名（日本語/英語）には依存せず、出現順だけで対応付ける。
 * @param {string} text
 * @returns {{ name: string, summary: string, description: string }}
 */
function parseListing(text) {
  const sections = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('■')) {
      cur = { body: [] };
      sections.push(cur);
    } else if (cur) {
      // 「■」より前のヘッダ装飾行（=== や注記）は cur===null なので無視される
      cur.body.push(line);
    }
  }
  const bodyOf = (i) => (sections[i] ? sections[i].body.join('\n').trim() : '');
  return {
    name: bodyOf(0),
    summary: bodyOf(1),
    // section[2] 以降をすべて description に結合（将来 ■ 見出しが増えても拾う）
    description: sections
      .slice(2)
      .map((s) => s.body.join('\n').trim())
      .filter(Boolean)
      .join('\n\n')
      .trim(),
  };
}

function readJson(relPath) {
  return JSON.parse(readFileSync(join(ROOT, relPath), 'utf8'));
}

function main() {
  const config = readJson('vava.config.json');
  const pkg = readJson('package.json');
  const amo = config.amo || {};

  const ja = parseListing(
    readFileSync(join(ROOT, amo.listingFiles?.ja || 'webstore/store-listing.firefox.ja.txt'), 'utf8')
  );
  const en = parseListing(
    readFileSync(join(ROOT, amo.listingFiles?.['en-US'] || 'webstore/store-listing.firefox.en.txt'), 'utf8')
  );

  // AMO 制約: "other" カテゴリは他カテゴリと併用不可。
  // 他カテゴリがあれば "other" を落とし、"other" しか無ければそのまま使う。
  let categories = Array.isArray(amo.categories) ? amo.categories.slice() : [];
  const nonOther = categories.filter((c) => c !== 'other');
  categories = nonOther.length > 0 ? nonOther : ['other'];

  const metadata = {
    categories,
    name: { ja: ja.name, 'en-US': en.name },
    summary: { ja: ja.summary, 'en-US': en.summary },
    description: { ja: ja.description, 'en-US': en.description },
    // AMO API v5 は homepage / support_url を { lang-code: value } で要求する
    homepage: { 'en-US': amo.homepage },
    support_url: { 'en-US': amo.supportUrl },
    // listed version は license（SPDX slug）必須。package.json から取得。
    version: { license: pkg.license || 'MIT' },
  };

  const outPath = join(ROOT, 'amo-metadata.json');
  writeFileSync(outPath, JSON.stringify(metadata, null, 2) + '\n', 'utf8');

  console.log('✅ amo-metadata.json を生成したよ');
  console.log(`   categories : ${categories.join(', ')}`);
  console.log(`   license    : ${metadata.version.license}`);
  console.log(`   name       : ${ja.name} / ${en.name}`);
  console.log(`   summary    : ${ja.summary.length} / ${en.summary.length} 文字`);
  console.log(`   description: ${ja.description.length} / ${en.description.length} 文字`);
}

main();
