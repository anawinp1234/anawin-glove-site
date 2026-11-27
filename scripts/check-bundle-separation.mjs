import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { releasedCommerceProfiles } from '../src/released-commerce-profiles.js';
import { testCommerceProfile } from './test-store/commerce-profile.mjs';

export const privateShopifyCredential = /\b(?:shpat|shppa|shpca|shpss|shpua|shpka)_[a-z0-9_-]+/i;
const production = releasedCommerceProfiles[0];
const serviceIds = ({ fullSizeService }) => Object.values(fullSizeService);
const identityTokens = profile => serviceIds(profile).map(gid => gid.split('/').at(-1));
const browserText = /\.(?:[cm]?js|html?|css|map|json|svg|xml|txt|webmanifest)$/i;

async function* outputFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Unexpected symlink in browser output.');
    if (entry.isDirectory()) yield* outputFiles(path);
    else if (entry.isFile()) yield path;
  }
}

export async function checkBundleSeparation(directory, mode, { excludedToken } = {}) {
  if (mode !== 'production' && mode !== 'test') throw new Error('Choose production or test bundle verification.');
  const expected = mode === 'production' ? production : testCommerceProfile;
  const excluded = mode === 'production' ? testCommerceProfile : production;
  const forbidden = [...identityTokens(excluded), ...(mode === 'production' ? [excluded.storeDomain] : [])];
  if (excludedToken) forbidden.push(excludedToken);
  const runtimeOnlyArtifacts = /\/\x5f\x5ffixture\b|isolated-test-store-profile|testCommerceProfile|ANAWIN_PURCHASE_ONLY/;
  const credentialKey = /VITE_[A-Z0-9_]*(?:ADMIN|PRIVATE|SECRET)[A-Z0-9_]*|X-Shopify-Access-Token/i;
  let scanned = 0;
  let profileEntries = 0;

  for await (const path of outputFiles(directory)) {
    if (!browserText.test(path) && !path.endsWith('/_headers')) continue;
    const content = await readFile(path, 'utf8');
    const context = relative(directory, path);
    scanned++;
    if (forbidden.some(value => content.includes(value))) throw new Error(`Forbidden commerce identity or token in ${context}.`);
    if (privateShopifyCredential.test(content) || credentialKey.test(content)) throw new Error(`Private Shopify credential pattern in ${context}.`);
    if (runtimeOnlyArtifacts.test(content)) throw new Error(`Unexpected isolated tooling in ${context}.`);
    if (/\.[cm]?js$/i.test(path) && serviceIds(expected).every(gid => content.includes(gid))) {
      const quoted = value => `["']${value.replaceAll('.', '\\.')}["']`;
      const entry = new RegExp(`storeDomain:\\s*${quoted(expected.storeDomain)},\\s*checkoutHost:\\s*${quoted(expected.checkoutHost)}`);
      if (entry.test(content)) profileEntries++;
    }
  }
  if (profileEntries !== 1) throw new Error('Expected exactly one executable browser asset containing the pinned commerce profile.');
  return { scanned, profileEntries };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode = 'production', directory = 'dist'] = process.argv.slice(2);
  const result = await checkBundleSeparation(resolve(directory), mode);
  console.log(`Verified ${mode} profile across ${result.scanned} browser output files.`);
}
