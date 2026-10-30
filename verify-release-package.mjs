// 提出する実物の版・内容をsourceと照合し、同じバイト列のSHA-256を記録する。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const JSZip = createRequire(require.resolve('web-ext'))('jszip');

export async function verifyReleasePackage(file, variant, version, sourceDir) {
  if (!['chrome', 'firefox'].includes(variant) || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid release target');
  const bytes = fs.readFileSync(file);
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const source = path.resolve(sourceDir);
  const entries = Object.values(zip.files).filter(entry => !entry.dir);
  const names = new Set(entries.map(entry => entry.name));
  for (const entry of entries) {
    const name = entry.unsafeOriginalName || entry.name;
    if (name !== entry.name || name.includes('\\') || name.split('/').some(part => part === '..') ||
        !(name === 'manifest.json' || /^(icons|src|_locales)\//.test(name))) throw new Error(`Unexpected package entry: ${name}`);
    const actual = await entry.async('nodebuffer');
    if (!actual.equals(fs.readFileSync(path.join(source, name)))) throw new Error(`Source mismatch: ${name}`);
  }
  const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
  if (manifest.version !== version) throw new Error(`Wrong package version: ${manifest.version}`);
  if (variant === 'chrome' ? (!manifest.background?.service_worker || manifest.background.scripts) :
    (manifest.background?.service_worker || !manifest.background?.scripts?.length)) throw new Error('Wrong background variant');
  const required = ['_locales/en/messages.json', '_locales/ja/messages.json', manifest.action?.default_popup,
    ...Object.values(manifest.icons || {}), ...Object.values(manifest.action?.default_icon || {}),
    ...(manifest.background.scripts || [manifest.background.service_worker]),
    ...(manifest.content_scripts || []).flatMap(script => [...(script.js || []), ...(script.css || [])])];
  // manifestから間接参照されるruntime資産・ライセンスの同梱漏れも拒否する。
  const walk = relative => {
    for (const item of fs.readdirSync(path.join(source, relative), { withFileTypes: true })) {
      const name = `${relative}/${item.name}`;
      if (item.isSymbolicLink()) throw new Error(`Source symlink: ${name}`);
      if (item.isDirectory()) walk(name);
      else if (!/\.md$/i.test(name) && !/(?:\.DS_Store|\.swp|~)$/.test(name)) required.push(name);
    }
  };
  for (const dir of ['src', 'icons', '_locales']) walk(dir);
  for (const name of required) if (!name || !names.has(name)) throw new Error(`Missing package file: ${name}`);
  const receipt = { version, variant, sourceSha: process.env.GITHUB_SHA || null,
    file: path.resolve(file), files: entries.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  console.log(JSON.stringify(receipt));
  return receipt;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await verifyReleasePackage(...process.argv.slice(2));
}
