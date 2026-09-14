import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLocalCommerce,
  createShopifyCommerce,
  migrateLocalCart,
  shopifyRequest,
  validateShopifyConfig
} from '../src/commerce.js';

class MemoryStorage {
  constructor(initial = {}) { this.values = new Map(Object.entries(initial)); }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

test('migrates the original local cart and caps unsafe quantities', () => {
  assert.deepEqual(migrateLocalCart({ black: 12, 'breakin-black': 1, blue: -2 }), {
    version: 2,
    items: { black: { quantity: 9, breakInQuantity: 9 } }
  });
});

test('local cart keeps break-in quantity synchronized when quantity changes', async () => {
  const storage = new MemoryStorage();
  const commerce = createLocalCommerce(storage);
  let cart = await commerce.addProduct('black', true);
  assert.equal(cart.subtotal, 170);
  assert.equal(cart.lines.find(line => line.isBreakIn).quantity, 1);

  cart = await commerce.setQuantity('black', 3);
  assert.equal(cart.subtotal, 510);
  assert.equal(cart.lines.find(line => line.isBreakIn).quantity, 3);

  cart = await commerce.removeProduct('black');
  assert.deepEqual(cart.lines, []);
});

test('local cart recovers from malformed persisted JSON', async () => {
  const commerce = createLocalCommerce(new MemoryStorage({ 'anawin-cart': '{broken' }));
  assert.deepEqual((await commerce.getCart()).lines, []);
});

test('Shopify mode requires public connection details and every product handle', () => {
  assert.equal(validateShopifyConfig({ VITE_COMMERCE_MODE: 'local' }), null);
  assert.throws(() => validateShopifyConfig({ VITE_COMMERCE_MODE: 'shopify' }), /domain/);
  assert.throws(() => validateShopifyConfig({
    VITE_COMMERCE_MODE: 'shopify',
    VITE_SHOPIFY_STORE_DOMAIN: 'store.myshopify.com',
    VITE_SHOPIFY_STOREFRONT_ACCESS_TOKEN: 'public-token'
  }), /handles/);
});

test('Shopify request surfaces HTTP and GraphQL errors', async () => {
  const config = { domain: 'store.myshopify.com', apiVersion: '2026-07', accessToken: 'public-token' };
  await assert.rejects(shopifyRequest(config, 'query {}', {}, async () => ({ ok: false, status: 503 })), /503/);
  await assert.rejects(shopifyRequest(config, 'query {}', {}, async () => ({
    ok: true,
    json: async () => ({ errors: [{ message: 'Not permitted' }] })
  })), /Not permitted/);
});

test('Shopify adapter normalizes products and creates an authoritative cart', async () => {
  const config = {
    domain: 'store.myshopify.com', accessToken: 'public-token', apiVersion: '2026-07',
    handles: { black: 'br16', blue: 'ob16', brown: 'cl16' }, breakInHandle: 'break-in'
  };
  const variants = {
    br16: ['gid://variant/br16', '150.00'], ob16: ['gid://variant/ob16', '150.00'],
    cl16: ['gid://variant/cl16', '150.00'], 'break-in': ['gid://variant/service', '20.00']
  };
  const fetchImpl = async (_url, options) => {
    const { query, variables } = JSON.parse(options.body);
    if (query.includes('ProductByHandle')) {
      const [id, amount] = variants[variables.handle];
      return { ok: true, json: async () => ({ data: { product: {
        id: `gid://product/${variables.handle}`, title: variables.handle.toUpperCase(), handle: variables.handle,
        variants: { nodes: [{ id, availableForSale: true, price: { amount, currencyCode: 'USD' } }] }
      } } }) };
    }
    if (query.includes('CreateCart')) {
      return { ok: true, json: async () => ({ data: { cartCreate: { userErrors: [], cart: {
        id: 'gid://cart/1', checkoutUrl: 'https://store.myshopify.com/checkouts/1',
        cost: { subtotalAmount: { amount: '170.00', currencyCode: 'USD' } },
        lines: { nodes: [
          { id: 'line-1', quantity: 1, attributes: [], merchandise: { id: 'gid://variant/br16', product: { handle: 'br16' } } },
          { id: 'line-2', quantity: 1, attributes: [{ key: '_anawin_parent', value: 'black' }], merchandise: { id: 'gid://variant/service', product: { handle: 'break-in' } } }
        ] }
      } } } }) };
    }
    throw new Error('Unexpected operation');
  };

  const storage = new MemoryStorage();
  const commerce = createShopifyCommerce(config, storage, fetchImpl);
  const products = await commerce.listProducts();
  assert.equal(products[0].merchandiseId, 'gid://variant/br16');
  assert.equal((await commerce.getBreakInService()).price, 20);

  const cart = await commerce.addProduct('black', true);
  assert.equal(cart.subtotal, 170);
  assert.equal(cart.lines.length, 2);
  assert.equal(cart.lines.find(line => line.isBreakIn).productId, 'black');
  assert.equal(storage.getItem('anawin-shopify-cart-id'), 'gid://cart/1');
});
