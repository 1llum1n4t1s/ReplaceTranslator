// web-extが実際に生成したXPIを、AMOへ送る直前に検証する。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import webExt from 'web-ext';
import { signAddon } from 'web-ext/util/submit-addon';
import { verifyReleasePackage } from './verify-release-package.mjs';

const require = createRequire(import.meta.url);
const entry = pathToFileURL(require.resolve('web-ext'));
const verifyOnly = process.argv.includes('--verify-only');
const sourceDir = path.resolve(process.env.FIREFOX_SOURCE_DIR || 'firefox-build');
const artifactsDir = path.resolve(process.env.FIREFOX_ARTIFACTS_DIR || 'web-ext-artifacts');
const version = JSON.parse(fs.readFileSync('manifest.json', 'utf8')).version;
const webextVersion = JSON.parse(fs.readFileSync(new URL('./package.json', entry), 'utf8')).version;
if (!verifyOnly && (!process.env.WEB_EXT_API_KEY || !process.env.WEB_EXT_API_SECRET)) throw new Error('AMO credentials are required');

await webExt.cmd.sign({ sourceDir, artifactsDir, channel: 'listed', amoMetadata: path.resolve('amo-metadata.json'),
  apiKey: process.env.WEB_EXT_API_KEY, apiSecret: process.env.WEB_EXT_API_SECRET, webextVersion }, {
  submitAddon: async options => {
    if (fs.existsSync(options.savedUploadUuidPath)) throw new Error('Unverified previous AMO upload UUID; refusing reuse');
    const receipt = await verifyReleasePackage(options.xpiPath, 'firefox', version, sourceDir);
    fs.writeFileSync(path.join(artifactsDir, 'submission-receipt.json'), JSON.stringify(receipt, null, 2));
    if (verifyOnly) return { success: true };
    return signAddon(options);
  },
});
