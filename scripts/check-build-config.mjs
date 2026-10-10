import { loadEnv } from 'vite';
import { validateShopifyConfig } from '../src/commerce.js';

const env = loadEnv('production', process.cwd(), 'VITE_');
const mode = env.VITE_COMMERCE_MODE;

if (mode !== 'local' && mode !== 'shopify') {
  throw new Error('Set VITE_COMMERCE_MODE explicitly to local or shopify before building.');
}

if (mode === 'shopify') {
  validateShopifyConfig(env);
  if (!env.VITE_SHOPIFY_BREAK_IN_HANDLE) {
    throw new Error('VITE_SHOPIFY_BREAK_IN_HANDLE is required for a Shopify build.');
  }
}

console.log(`Build configuration checked for ${mode} mode.`);
