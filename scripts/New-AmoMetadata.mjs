import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// AMO は見出しより後の本文だけを受け取る。説明内の追加セクションも保持する。
export function parseListing(text) {
  const sections = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('■')) sections.push([]);
    else if (sections.length) sections.at(-1).push(line);
  }
  if (sections.length < 3) throw new Error('Listing requires name, summary and description sections');
  const [name, summary, ...description] = sections.map(lines => lines.join('\n').trim());
  return { name, summary, description: description.filter(Boolean).join('\n\n').trim() };
}

export async function createMetadata(root = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const metadata = {
    categories: ['other'],
    homepage: { 'en-US': 'https://github.com/1llum1n4t1s/ReplaceTranslator' },
    support_url: { 'en-US': 'https://github.com/1llum1n4t1s/ReplaceTranslator/issues' },
    version: { license: pkg.license || 'MIT' },
    name: {}, summary: {}, description: {},
  };
  for (const [locale, language] of [['ja', 'ja'], ['en-US', 'en']]) {
    const listing = parseListing(await readFile(resolve(root, `webstore/store-listing.firefox.${language}.txt`), 'utf8'));
    for (const field of ['name', 'summary', 'description']) metadata[field][locale] = listing[field];
  }
  return metadata;
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || args[0]?.startsWith('-')) throw new Error('Usage: bun scripts/New-AmoMetadata.mjs [output-path]');
    const metadata = await createMetadata();
    await writeFile(resolve(args[0] || 'amo-metadata.json'), JSON.stringify(metadata, null, 2) + '\n', 'utf8');
    console.log('AMO metadata generated');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
