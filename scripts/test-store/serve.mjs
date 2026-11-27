import { build, preview } from 'vite';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateShopifyConfig } from '../../src/commerce.js';
import { releasedCommerceProfiles, testCommerceProfile } from './commerce-profile.mjs';
import { checkBundleSeparation, privateShopifyCredential } from '../check-bundle-separation.mjs';

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--build-only')) {
  throw new Error('Usage: node scripts/test-store/serve.mjs [--build-only]');
}

const root = fileURLToPath(new URL('../../', import.meta.url));
const productionProfileModule = fileURLToPath(new URL('../../src/released-commerce-profiles.js', import.meta.url));
const testProfileModule = fileURLToPath(new URL('./commerce-profile.mjs', import.meta.url));
const fixedHandles = {
  VITE_SHOPIFY_MI26_HANDLE: 'mi26',
  VITE_SHOPIFY_BL50_HANDLE: 'bl50',
  VITE_SHOPIFY_OR17_HANDLE: 'or17',
  VITE_SHOPIFY_CM24_HANDLE: 'cm24'
};
const keys = [
  'VITE_COMMERCE_MODE', 'VITE_SHOPIFY_STORE_DOMAIN', 'VITE_SHOPIFY_STOREFRONT_TOKEN',
  'VITE_SHOPIFY_API_VERSION', 'VITE_SHOPIFY_BR16_HANDLE', 'VITE_SHOPIFY_OB16_HANDLE',
  'VITE_SHOPIFY_CL16_HANDLE', 'VITE_SHOPIFY_BREAK_IN_HANDLE', ...Object.keys(fixedHandles)
];

if (Object.keys(process.env).some(key => /SHOPIFY.*(?:ADMIN|PRIVATE|SECRET)|(?:ADMIN|PRIVATE|SECRET).*SHOPIFY/i.test(key))) {
  throw new Error('Remove private Shopify credentials from the test build environment.');
}
const env = Object.fromEntries(keys.map(key => [key, process.env[key]]));
if (env.VITE_COMMERCE_MODE !== 'shopify' || env.VITE_SHOPIFY_STORE_DOMAIN !== testCommerceProfile.storeDomain) {
  throw new Error('The isolated build requires explicit Shopify mode and the verified test store.');
}
for (const [key, handle] of Object.entries(fixedHandles)) {
  if (env[key] !== handle) throw new Error(`Set ${key} to the verified test-store handle.`);
}
if (!env.VITE_SHOPIFY_BREAK_IN_HANDLE ||
  Object.values(env).some(value => value && (privateShopifyCredential.test(value) || value.includes('ignvv0-zh.myshopify.com')))) {
  throw new Error('Invalid test-store configuration.');
}
validateShopifyConfig(env, releasedCommerceProfiles);
const output = await mkdtemp(join(tmpdir(), 'anawin-test-store-'));
let profileReplaced = false;
const config = {
  root, configFile: false, envFile: false, envPrefix: [], mode: 'production', clearScreen: false,
  logLevel: 'silent',
  build: { outDir: output, emptyOutDir: false },
  define: Object.fromEntries(keys.filter(key => env[key] !== undefined)
    .map(key => [`import.meta.env.${key}`, JSON.stringify(env[key])])),
  plugins: [{
    name: 'isolated-test-store-profile',
    enforce: 'pre',
    async resolveId(source, importer) {
      if (source !== './released-commerce-profiles.js' || !importer) return null;
      const resolved = await this.resolve(source, importer, { skipSelf: true });
      if (resolved?.id !== productionProfileModule) this.error('Unexpected commerce profile entry.');
      profileReplaced = true;
      return testProfileModule;
    }
  }]
};

try {
  await build(config);
  if (!profileReplaced) throw new Error('Failed to replace commerce profile entry.');
  await checkBundleSeparation(output, 'test');
} catch {
  throw new Error('Isolated test-store build or bundle verification failed.');
}
console.log(`Verified isolated test-store build at ${output}`);
if (!args.includes('--build-only')) {
  const host = '127.0.0.1';
  const server = await preview({ ...config, plugins: [], preview: { host, port: 4174, strictPort: true } });
  console.log(`Isolated test-store preview at http://${host}:${server.httpServer.address().port}`);
}
