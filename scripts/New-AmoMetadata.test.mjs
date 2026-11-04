import { expect, test } from 'bun:test';
import { createMetadata, parseListing } from './New-AmoMetadata.mjs';

test('AMO listing preserves locale text, blank lines and extra description sections', () => {
  expect(parseListing('ignored\r\n■ Name\r\n名前 📝\r\n\r\n■ Summary\r\n概要\r\n■ Description\r\n最初\r\n\r\n続き\r\n■ More\r\n\r\n追加\r\n■ Empty\r\n')).toEqual({
    name: '名前 📝', summary: '概要', description: '最初\n\n続き\n\n追加',
  });
  expect(() => parseListing('■ Name\nname\n■ Summary\nsummary')).toThrow('Listing requires');
});

test('release metadata includes both source locales and the existing store identity', async () => {
  const metadata = await createMetadata();
  expect(metadata.categories).toEqual(['other']);
  expect(metadata.homepage['en-US']).toBe('https://github.com/1llum1n4t1s/ReplaceTranslator');
  expect(metadata.support_url['en-US']).toBe('https://github.com/1llum1n4t1s/ReplaceTranslator/issues');
  expect(metadata.version.license).toBeTruthy();
  for (const field of ['name', 'summary', 'description']) {
    expect(Object.keys(metadata[field])).toEqual(['ja', 'en-US']);
    expect(metadata[field].ja.length).toBeGreaterThan(0);
    expect(metadata[field]['en-US'].length).toBeGreaterThan(0);
    expect(metadata[field]['en-US']).not.toContain('■ Description');
  }
  expect(metadata.name['en-US']).toBe('Replace AI Translator API');
});
