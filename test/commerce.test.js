import test from 'node:test';
import assert from 'node:assert/strict';
import { breakInService, localProducts, purchasePrice } from '../src/catalog.js';
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

test('each glove has product-level hand orientation', () => {
  assert.equal(localProducts.length, 3);
  for (const product of localProducts) {
    assert.equal(product.throwingHand, 'Right');
    assert.equal(product.wornOnHand, 'Left');
  }
});

test('purchase price follows each glove and the selected service price', () => {
  for (const product of localProducts) {
    assert.equal(purchasePrice(product, breakInService, false), 150);
    assert.equal(purchasePrice(product, breakInService, true), 170);
    assert.equal(purchasePrice(product, breakInService, false), 150);
  }
  assert.equal(purchasePrice({ price: 155 }, { price: 25 }, true), 180);
});

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
  }), /token/);
  assert.throws(() => validateShopifyConfig({
    VITE_COMMERCE_MODE: 'shopify',
    VITE_SHOPIFY_STORE_DOMAIN: 'store.myshopify.com',
    VITE_SHOPIFY_STOREFRONT_TOKEN: 'public-token'
  }), /handles/);
  assert.throws(() => validateShopifyConfig({
    VITE_COMMERCE_MODE: 'shopify',
    VITE_SHOPIFY_STORE_DOMAIN: 'store.myshopify.com',
    VITE_SHOPIFY_STOREFRONT_TOKEN: 'public-token',
    VITE_SHOPIFY_BR16_HANDLE: 'br16',
    VITE_SHOPIFY_OB16_HANDLE: 'ob16',
    VITE_SHOPIFY_CL16_HANDLE: 'cl16'
  }), /break-in service handle/);
});

test('Shopify request surfaces HTTP and GraphQL errors', async () => {
  const config = { domain: 'store.myshopify.com', apiVersion: '2026-07', accessToken: 'public-token' };
  await assert.rejects(shopifyRequest(config, 'query {}', {}, async () => ({ ok: false, status: 503 })), /503/);
  await assert.rejects(shopifyRequest(config, 'query {}', {}, async () => ({
    ok: true,
    json: async () => ({ errors: [{ message: 'Not permitted' }] })
  })), /Not permitted/);
});

function shopifyFixture({ autoSyncChild = true, rekeyOnAttributeUpdate = false } = {}) {
  const config = {
    domain: 'store.myshopify.com', accessToken: 'public-token', apiVersion: '2026-07',
    handles: { black: 'br16', blue: 'ob16', brown: 'cl16' }, breakInHandle: 'break-in'
  };
  const variants = {
    br16: ['gid://variant/br16', '150.00'], ob16: ['gid://variant/ob16', '150.00'],
    cl16: ['gid://variant/cl16', '150.00'], 'break-in': ['gid://variant/service', '20.00']
  };
  const storage = new MemoryStorage();
  const requests = [];
  let lines = [];
  let nextId = 1;
  let cartExists = false;
  let userError = '';
  let apiError = false;
  let failMutationAt = 0;
  let mutationCount = 0;
  const response = data => ({ ok: true, json: async () => ({ data }) });
  const snapshot = () => ({
    id: 'gid://cart/1', checkoutUrl: 'https://store.myshopify.com/checkouts/1',
    cost: { subtotalAmount: { amount: String(lines.reduce((sum, line) => sum + line.quantity * (line.merchandise.product.handle === 'break-in' ? 20 : 150), 0)), currencyCode: 'USD' } },
    lines: { nodes: structuredClone(lines) }
  });
  const makeLine = (handle, quantity, parentId = null, attributes = []) => ({
    id: `line-${nextId++}`, quantity,
    attributes: structuredClone(attributes),
    instructions: { canRemove: true, canUpdateQuantity: true },
    parentRelationship: parentId ? { parent: { id: parentId, merchandise: { id: variants.br16[0], product: { handle: 'br16' } } } } : null,
    merchandise: { id: variants[handle][0], product: { handle } }
  });
  const add = inputs => {
    if (inputs.length === 1 && inputs[0].parent?.lineId) {
      const parent = lines.find(line => line.id === inputs[0].parent.lineId && !line.parentRelationship);
      if (!parent) throw new Error('Unknown parent cart line');
      lines.push(makeLine('break-in', inputs[0].quantity, parent.id));
      return;
    }
    const parentInput = inputs[0];
    const handle = Object.keys(variants).find(key => variants[key][0] === parentInput.merchandiseId);
    const withService = inputs.length === 2;
    const existing = lines.find(line => line.merchandise.id === parentInput.merchandiseId && !line.parentRelationship &&
      JSON.stringify(line.attributes) === JSON.stringify(parentInput.attributes || []));
    const parent = existing || makeLine(handle, 0, null, parentInput.attributes);
    if (!existing) lines.push(parent);
    parent.quantity += parentInput.quantity;
    if (withService) {
      const child = lines.find(line => line.parentRelationship?.parent.id === parent.id) || makeLine('break-in', 0, parent.id);
      if (!lines.includes(child)) lines.push(child);
      child.quantity += inputs[1].quantity;
    }
  };
  const mergeEquivalentParents = () => {
    for (const parent of [...lines.filter(line => !line.parentRelationship)]) {
      if (!lines.includes(parent)) continue;
      const equivalent = lines.find(line => line !== parent && !line.parentRelationship &&
        line.merchandise.id === parent.merchandise.id && JSON.stringify(line.attributes) === JSON.stringify(parent.attributes));
      if (!equivalent) continue;
      const child = lines.find(line => line.parentRelationship?.parent.id === parent.id);
      const equivalentChild = lines.find(line => line.parentRelationship?.parent.id === equivalent.id);
      equivalent.quantity += parent.quantity;
      if (child) {
        if (equivalentChild) equivalentChild.quantity += child.quantity;
        else child.parentRelationship.parent.id = equivalent.id;
      }
      lines = lines.filter(line => line !== parent && (line !== child || !equivalentChild));
    }
  };
  const fetchImpl = async (url, options) => {
    assert.match(url, /\/api\/2026-07\/graphql\.json$/);
    const { query, variables } = JSON.parse(options.body);
    requests.push({ query, variables });
    if (query.includes('ProductByHandle')) {
      const [id, amount] = variants[variables.handle];
      return response({ product: {
        id: `gid://product/${variables.handle}`, title: variables.handle.toUpperCase(), handle: variables.handle,
        variants: { nodes: [{ id, availableForSale: true, price: { amount, currencyCode: 'USD' } }] }
      } });
    }
    assert.match(query, /parentRelationship/);
    assert.match(query, /attributes \{ key value \}/);
    assert.match(query, /canUpdateQuantity/);
    if (query.includes('query Cart(')) return response({ cart: cartExists ? snapshot() : null });
    if (apiError) return { ok: false, status: 503 };
    const field = query.includes('CreateCart') ? 'cartCreate' : query.includes('AddLines') ? 'cartLinesAdd' :
      query.includes('UpdateLines') ? 'cartLinesUpdate' : 'cartLinesRemove';
    mutationCount++;
    if (failMutationAt === mutationCount) return response({ [field]: { userErrors: [{ message: 'Partial mutation failed' }], cart: snapshot() } });
    if (userError) return response({ [field]: { userErrors: [{ message: userError }], cart: snapshot() } });
    if (field === 'cartCreate' || field === 'cartLinesAdd') {
      add(field === 'cartCreate' ? variables.input.lines : variables.lines);
      cartExists = true;
    } else if (field === 'cartLinesUpdate') {
      for (const update of variables.lines) {
        const line = lines.find(item => item.id === update.id);
        if (!line) throw new Error('Unknown cart line');
        if (update.quantity !== undefined) line.quantity = update.quantity;
        if (update.attributes) {
          line.attributes = structuredClone(update.attributes);
          if (rekeyOnAttributeUpdate) {
            const oldId = line.id;
            line.id = `line-${nextId++}`;
            for (const child of lines) if (child.parentRelationship?.parent.id === oldId) child.parentRelationship.parent.id = line.id;
          }
          mergeEquivalentParents();
        }
        if (autoSyncChild && update.quantity !== undefined && !line.parentRelationship) {
          const child = lines.find(item => item.parentRelationship?.parent.id === line.id);
          if (child) child.quantity = line.quantity;
        }
      }
    } else {
      lines = lines.filter(line => !variables.lineIds.includes(line.id) && !variables.lineIds.includes(line.parentRelationship?.parent.id));
    }
    return response({ [field]: { userErrors: [], cart: snapshot() } });
  };
  const commerce = createShopifyCommerce(config, storage, fetchImpl);
  return { commerce, storage, requests, restore: () => createShopifyCommerce(config, storage, fetchImpl),
    get lines() { return lines; }, setUserError(value) { userError = value; }, setApiError(value) { apiError = value; },
    failNextMutation(offset = 1) { failMutationAt = mutationCount + offset; } };
}

test('adds a glove without service using Shopify price and checkout', async () => {
  const fixture = shopifyFixture();
  const { commerce, requests } = fixture;
  const product = (await commerce.listProducts()).find(item => item.id === 'black');
  assert.equal(product.throwingHand, 'Right');
  assert.equal(product.wornOnHand, 'Left');
  assert.equal(product.accentColor, localProducts[0].accentColor);
  assert.equal(product.accentBackground, localProducts[0].accentBackground);
  const cart = await commerce.addProduct('black', false);
  assert.equal(cart.subtotal, 150);
  assert.equal(cart.checkoutUrl, 'https://store.myshopify.com/checkouts/1');
  assert.equal(cart.lines.length, 1);
  assert.deepEqual(requests.find(item => item.query.includes('CreateCart')).variables.input.lines,
    [{ merchandiseId: 'gid://variant/br16', quantity: 1, attributes: [{ key: '_anawin_service', value: 'none' }] }]);
});

test('adds a native nested Break-in line and restores its parent relationship', async () => {
  const { commerce, storage, requests, restore } = shopifyFixture();
  const products = await commerce.listProducts();
  assert.equal(products[0].merchandiseId, 'gid://variant/br16');
  assert.equal((await commerce.getBreakInService()).price, 20);
  const cart = await commerce.addProduct('black', true);
  assert.equal(cart.subtotal, 170);
  assert.equal(cart.lines.length, 2);
  assert.equal(cart.lines.find(line => line.isBreakIn).productId, 'black');
  assert.equal(cart.lines.find(line => line.isBreakIn).parentLineId, cart.lines.find(line => !line.isBreakIn).remoteLineId);
  assert.deepEqual(requests.find(item => item.query.includes('CreateCart')).variables.input.lines[1], {
    merchandiseId: 'gid://variant/service', quantity: 1, parent: { merchandiseId: 'gid://variant/br16' }
  });
  assert.equal(storage.getItem('anawin-shopify-cart-id'), 'gid://cart/1');
  const restored = await restore().getCart();
  assert.deepEqual(restored.lines, cart.lines);
});

test('updates a parent, follows Shopify child quantity, and removes only parents', async () => {
  const { commerce, requests } = shopifyFixture();
  await commerce.listProducts();
  await commerce.addProduct('black', true);
  let cart = await commerce.setQuantity('black', 3);
  assert.equal(cart.subtotal, 510);
  assert.equal(cart.lines.find(line => line.isBreakIn).quantity, 3);
  assert.equal(requests.filter(item => item.query.includes('UpdateLines')).length, 1);
  cart = await commerce.removeProduct('black');
  assert.deepEqual(cart.lines, []);
  assert.deepEqual(requests.find(item => item.query.includes('RemoveLines')).variables.lineIds, ['line-1']);
});

test('updates a child only when Shopify leaves it out of sync and permits it', async () => {
  const { commerce, requests } = shopifyFixture({ autoSyncChild: false });
  await commerce.listProducts();
  await commerce.addProduct('black', true);
  const cart = await commerce.setQuantity('black', 2);
  assert.equal(cart.subtotal, 340);
  assert.equal(requests.filter(item => item.query.includes('UpdateLines')).length, 2);
});

test('repeated additions keep same-choice lines together and different choices separate', async () => {
  const { commerce, requests } = shopifyFixture();
  await commerce.listProducts();
  await commerce.addProduct('black', true);
  await commerce.addProduct('black', true);
  await commerce.addProduct('black', false);
  const cart = await commerce.addProduct('black', false);
  assert.equal(cart.lines.filter(line => !line.isBreakIn).length, 2);
  assert.equal(cart.lines.find(line => line.isBreakIn).quantity, 2);
  assert.equal(cart.lines.filter(line => !line.isBreakIn).reduce((sum, line) => sum + line.quantity, 0), 4);
  assert.equal(cart.subtotal, 640);
  assert.equal(requests.filter(item => item.query.includes('AddLines')).length, 3);
  await assert.rejects(commerce.setQuantity('black', 3), /specific glove cart entry/);
});

async function mixedCartFixture(options) {
  const fixture = shopifyFixture(options);
  await fixture.commerce.listProducts();
  await fixture.commerce.addProduct('black', true);
  const cart = await fixture.commerce.addProduct('black', false);
  const child = cart.lines.find(line => line.isBreakIn);
  const serviced = cart.lines.find(line => line.remoteLineId === child.parentLineId);
  const unserviced = cart.lines.find(line => !line.isBreakIn && line.remoteLineId !== serviced.remoteLineId);
  return { ...fixture, cart, servicedId: serviced.remoteLineId, unservicedId: unserviced.remoteLineId };
}

function mixedQuantities(cart, servicedId, unservicedId) {
  return {
    serviced: cart.lines.find(line => line.remoteLineId === servicedId)?.quantity || 0,
    unserviced: cart.lines.find(line => line.remoteLineId === unservicedId)?.quantity || 0,
    service: cart.lines.find(line => line.isBreakIn && line.parentLineId === servicedId)?.quantity || 0
  };
}

test('one serviced and one unserviced BR16 have separate parent cart-line identities', async () => {
  const { cart, servicedId, unservicedId } = await mixedCartFixture();
  assert.notEqual(servicedId, unservicedId);
  assert.deepEqual(mixedQuantities(cart, servicedId, unservicedId), { serviced: 1, unserviced: 1, service: 1 });
  assert.equal(cart.subtotal, 320);
});

test('adding unserviced then serviced BR16 keeps distinct Shopify parent attributes', async () => {
  const { commerce, restore, requests } = shopifyFixture();
  await commerce.listProducts();
  await commerce.addProduct('black', false);
  const cart = await commerce.addProduct('black', true);
  const parents = cart.lines.filter(line => !line.isBreakIn);
  assert.equal(parents.length, 2);
  assert.deepEqual(parents.map(line => line.serviceConfiguration), ['none', 'break-in']);
  assert.equal(cart.subtotal, 320);
  assert.equal(cart.lines.find(line => line.isBreakIn).parentLineId, parents[1].remoteLineId);
  assert.equal(requests.filter(item => item.query.includes('AddLines'))[0].variables.lines[0].attributes[0].value, 'break-in');
  assert.equal((await restore().getCart()).incomplete, false);
});

test('adding serviced then unserviced BR16 keeps distinct Shopify parent attributes', async () => {
  const { commerce, restore } = shopifyFixture();
  await commerce.listProducts();
  await commerce.addProduct('black', true);
  const cart = await commerce.addProduct('black', false);
  assert.deepEqual(cart.lines.filter(line => !line.isBreakIn).map(line => line.serviceConfiguration), ['break-in', 'none']);
  assert.equal(cart.subtotal, 320);
  assert.equal((await restore().getCart()).incomplete, false);
});

test('repeated unserviced additions combine by attribute without a service child', async () => {
  const { commerce } = shopifyFixture();
  await commerce.listProducts();
  await commerce.addProduct('black', false);
  const cart = await commerce.addProduct('black', false);
  assert.equal(cart.lines.length, 1);
  assert.equal(cart.lines[0].quantity, 2);
  assert.equal(cart.lines[0].serviceConfiguration, 'none');
  assert.equal(cart.subtotal, 300);
});

test('repeated serviced additions combine with matching nested child quantity', async () => {
  const { commerce } = shopifyFixture();
  await commerce.listProducts();
  await commerce.addProduct('black', true);
  const cart = await commerce.addProduct('black', true);
  assert.equal(cart.lines.filter(line => !line.isBreakIn).length, 1);
  assert.equal(cart.lines.find(line => !line.isBreakIn).quantity, 2);
  assert.equal(cart.lines.find(line => line.isBreakIn).quantity, 2);
  assert.equal(cart.subtotal, 340);
});

test('incrementing the serviced BR16 changes only its parent and nested child', async () => {
  const { commerce, requests, servicedId, unservicedId } = await mixedCartFixture({ autoSyncChild: false });
  const cart = await commerce.setLineQuantity(servicedId, 2);
  assert.deepEqual(mixedQuantities(cart, servicedId, unservicedId), { serviced: 2, unserviced: 1, service: 2 });
  assert.equal(cart.subtotal, 490);
  assert.deepEqual(requests.filter(item => item.query.includes('UpdateLines')).map(item => item.variables.lines[0].id), [servicedId, 'line-2']);
});

test('incrementing the unserviced BR16 never updates Break-in Service', async () => {
  const { commerce, requests, servicedId, unservicedId } = await mixedCartFixture();
  const cart = await commerce.setLineQuantity(unservicedId, 2);
  assert.deepEqual(mixedQuantities(cart, servicedId, unservicedId), { serviced: 1, unserviced: 2, service: 1 });
  assert.equal(cart.subtotal, 470);
  assert.deepEqual(requests.filter(item => item.query.includes('UpdateLines')).map(item => item.variables.lines[0].id), [unservicedId]);
});

test('decrementing the serviced BR16 synchronizes only its nested child', async () => {
  const { commerce, servicedId, unservicedId } = await mixedCartFixture({ autoSyncChild: false });
  await commerce.setLineQuantity(servicedId, 2);
  const cart = await commerce.setLineQuantity(servicedId, 1);
  assert.deepEqual(mixedQuantities(cart, servicedId, unservicedId), { serviced: 1, unserviced: 1, service: 1 });
  assert.equal(cart.subtotal, 320);
});

test('decrementing the unserviced BR16 leaves the serviced line unchanged', async () => {
  const { commerce, servicedId, unservicedId } = await mixedCartFixture();
  await commerce.setLineQuantity(unservicedId, 2);
  const cart = await commerce.setLineQuantity(unservicedId, 1);
  assert.deepEqual(mixedQuantities(cart, servicedId, unservicedId), { serviced: 1, unserviced: 1, service: 1 });
  assert.equal(cart.subtotal, 320);
});

test('removing the serviced parent cascades its child and retains unserviced BR16', async () => {
  const { commerce, requests, servicedId, unservicedId } = await mixedCartFixture();
  const cart = await commerce.removeLine(servicedId);
  assert.deepEqual(mixedQuantities(cart, servicedId, unservicedId), { serviced: 0, unserviced: 1, service: 0 });
  assert.equal(cart.subtotal, 150);
  assert.deepEqual(requests.find(item => item.query.includes('RemoveLines')).variables.lineIds, [servicedId]);
});

test('removing the unserviced parent retains serviced BR16 and its child', async () => {
  const { commerce, requests, servicedId, unservicedId } = await mixedCartFixture();
  const cart = await commerce.removeLine(unservicedId);
  assert.deepEqual(mixedQuantities(cart, servicedId, unservicedId), { serviced: 1, unserviced: 0, service: 1 });
  assert.equal(cart.subtotal, 170);
  assert.deepEqual(requests.find(item => item.query.includes('RemoveLines')).variables.lineIds, [unservicedId]);
});

test('restoring a mixed BR16 cart preserves both parent IDs and child mapping', async () => {
  const { restore, servicedId, unservicedId } = await mixedCartFixture();
  const cart = await restore().getCart();
  assert.deepEqual(mixedQuantities(cart, servicedId, unservicedId), { serviced: 1, unserviced: 1, service: 1 });
  assert.equal(cart.incomplete, false);
});

test('removing service from one glove retains it and uses Shopify subtotal', async () => {
  const { commerce, requests } = shopifyFixture();
  await commerce.listProducts();
  const before = await commerce.addProduct('black', true);
  const parent = before.lines.find(line => !line.isBreakIn);
  const child = before.lines.find(line => line.isBreakIn);
  const after = await commerce.removeBreakIn(parent.remoteLineId);
  assert.equal(before.subtotal, 170);
  assert.equal(after.subtotal, 150);
  assert.equal(after.lines.find(line => !line.isBreakIn).quantity, 1);
  assert.equal(after.lines.some(line => line.isBreakIn), false);
  assert.deepEqual(requests.find(item => item.query.includes('RemoveLines')).variables.lineIds, [child.remoteLineId]);
});

test('removing service from two gloves retains both parent gloves', async () => {
  const { commerce, restore } = shopifyFixture();
  await commerce.listProducts();
  const first = await commerce.addProduct('black', true);
  const parentId = first.lines.find(line => !line.isBreakIn).remoteLineId;
  const before = await commerce.setLineQuantity(parentId, 2);
  assert.equal(before.subtotal, 340);
  const after = await commerce.removeBreakIn(parentId);
  assert.equal(after.subtotal, 300);
  assert.equal(after.lines.find(line => !line.isBreakIn).quantity, 2);
  assert.equal(after.lines.some(line => line.isBreakIn), false);
  assert.deepEqual((await restore().getCart()).lines, after.lines);
});

test('adding service to one existing glove uses parent.lineId and Shopify subtotal', async () => {
  const { commerce, requests, restore } = shopifyFixture();
  await commerce.listProducts();
  const before = await commerce.addProduct('black', false);
  const parentId = before.lines[0].remoteLineId;
  const after = await commerce.addBreakIn(parentId);
  assert.equal(before.subtotal, 150);
  assert.equal(after.subtotal, 170);
  assert.equal(after.lines.find(line => line.isBreakIn).parentLineId, parentId);
  assert.deepEqual(requests.filter(item => item.query.includes('AddLines')).at(-1).variables.lines,
    [{ merchandiseId: 'gid://variant/service', quantity: 1, parent: { lineId: parentId } }]);
  assert.deepEqual((await restore().getCart()).lines, after.lines);
});

test('adding service to two existing gloves charges for two child units', async () => {
  const { commerce, requests } = shopifyFixture();
  await commerce.listProducts();
  const first = await commerce.addProduct('black', false);
  const parentId = first.lines[0].remoteLineId;
  const before = await commerce.setLineQuantity(parentId, 2);
  assert.equal(before.subtotal, 300);
  const after = await commerce.addBreakIn(parentId);
  assert.equal(after.subtotal, 340);
  assert.equal(after.lines.find(line => line.isBreakIn).quantity, 2);
  assert.deepEqual(requests.filter(item => item.query.includes('AddLines')).at(-1).variables.lines,
    [{ merchandiseId: 'gid://variant/service', quantity: 2, parent: { lineId: parentId } }]);
});

test('adding service targets only the chosen unserviced BR16 parent', async () => {
  const { commerce, servicedId, unservicedId, requests } = await mixedCartFixture();
  const after = await commerce.addBreakIn(unservicedId);
  const children = after.lines.filter(line => line.isBreakIn);
  assert.equal(children.reduce((sum, line) => sum + line.quantity, 0), 2);
  assert.equal(after.lines.filter(line => !line.isBreakIn).reduce((sum, line) => sum + line.quantity, 0), 2);
  assert.equal(after.subtotal, 340);
  assert.ok(requests.some(item => item.query.includes('UpdateLines') &&
    item.variables.lines[0].id === unservicedId &&
    item.variables.lines[0].attributes[0].value === 'break-in'));
  assert.equal(after.lines.some(line => line.remoteLineId === servicedId || line.remoteLineId === unservicedId), true);
});

test('removing service targets only the chosen serviced BR16 parent', async () => {
  const { commerce, servicedId, unservicedId } = await mixedCartFixture();
  const after = await commerce.removeBreakIn(servicedId);
  assert.equal(after.subtotal, 300);
  assert.equal(after.lines.some(line => line.isBreakIn), false);
  assert.equal(after.lines.filter(line => !line.isBreakIn).reduce((sum, line) => sum + line.quantity, 0), 2);
  assert.equal(after.lines.some(line => line.remoteLineId === unservicedId), true);
});

test('service removal accepts Shopify merging equivalent unserviced parents', async () => {
  const { commerce, restore, servicedId } = await mixedCartFixture();
  const after = await commerce.removeBreakIn(servicedId);
  assert.equal(after.subtotal, 300);
  assert.equal(after.lines.filter(line => !line.isBreakIn).reduce((sum, line) => sum + line.quantity, 0), 2);
  assert.equal(after.lines.some(line => line.isBreakIn), false);
  assert.deepEqual((await restore().getCart()).lines, after.lines);
});

test('service addition accepts Shopify merging the selected parent into an equivalent serviced entry', async () => {
  const { commerce, restore, unservicedId } = await mixedCartFixture();
  const after = await commerce.addBreakIn(unservicedId);
  assert.equal(after.subtotal, 340);
  assert.equal(after.lines.filter(line => !line.isBreakIn).reduce((sum, line) => sum + line.quantity, 0), 2);
  assert.equal(after.lines.find(line => line.isBreakIn).quantity, 2);
  assert.deepEqual((await restore().getCart()).lines, after.lines);
});

test('service addition re-reads a re-keyed parent ID before attaching its child', async () => {
  const { commerce, requests, restore } = shopifyFixture({ rekeyOnAttributeUpdate: true });
  await commerce.listProducts();
  const before = await commerce.addProduct('black', false);
  const oldId = before.lines[0].remoteLineId;
  const after = await commerce.addBreakIn(oldId);
  const parent = after.lines.find(line => !line.isBreakIn);
  assert.notEqual(parent.remoteLineId, oldId);
  assert.deepEqual(requests.filter(item => item.query.includes('AddLines')).at(-1).variables.lines[0].parent,
    { lineId: parent.remoteLineId });
  assert.equal(after.lines.find(line => line.isBreakIn).parentLineId, parent.remoteLineId);
  assert.equal((await restore().getCart()).incomplete, false);
});

test('service removal re-reads a re-keyed parent and may consolidate unserviced lines', async () => {
  const { commerce, servicedId, restore } = await mixedCartFixture({ rekeyOnAttributeUpdate: true });
  const after = await commerce.removeBreakIn(servicedId);
  assert.equal(after.subtotal, 300);
  assert.equal(after.lines.filter(line => !line.isBreakIn).reduce((sum, line) => sum + line.quantity, 0), 2);
  assert.equal(after.lines.some(line => line.isBreakIn), false);
  assert.equal((await restore().getCart()).incomplete, false);
});

test('native child and parent attribute disagreement blocks checkout after restoration', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  const cart = await fixture.commerce.addProduct('black', true);
  const parentId = cart.lines.find(line => !line.isBreakIn).remoteLineId;
  fixture.lines.find(line => line.id === parentId).attributes[0].value = 'none';
  assert.equal((await fixture.restore().getCart()).incomplete, true);
  fixture.lines.find(line => line.id === parentId).attributes[0].value = 'break-in';
  fixture.lines.find(line => line.id === parentId).attributes = [];
  assert.equal((await fixture.restore().getCart()).incomplete, true);
});

test('partial service addition failure remains fail-closed after refresh', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  const before = await fixture.commerce.addProduct('black', false);
  fixture.failNextMutation(2);
  await assert.rejects(fixture.commerce.addBreakIn(before.lines[0].remoteLineId), /Partial mutation failed/);
  const restored = await fixture.restore().getCart();
  assert.equal(restored.incomplete, true);
  assert.equal(restored.lines[0].serviceConfiguration, 'break-in');
  assert.equal(restored.lines.some(line => line.isBreakIn), false);
});

test('partial service removal failure remains fail-closed after refresh', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  const before = await fixture.commerce.addProduct('black', true);
  fixture.failNextMutation(2);
  await assert.rejects(fixture.commerce.removeBreakIn(before.lines.find(line => !line.isBreakIn).remoteLineId),
    /Partial mutation failed/);
  const restored = await fixture.restore().getCart();
  assert.equal(restored.incomplete, true);
  assert.equal(restored.lines[0].serviceConfiguration, 'break-in');
  assert.equal(restored.lines.some(line => line.isBreakIn), false);
});

test('service mutations surface Shopify user and API errors without changing cart', async () => {
  const fixture = await mixedCartFixture();
  fixture.setUserError('Service unavailable');
  await assert.rejects(fixture.commerce.addBreakIn(fixture.unservicedId), /Service unavailable/);
  await assert.rejects(fixture.commerce.removeBreakIn(fixture.servicedId), /Service unavailable/);
  fixture.setUserError('');
  fixture.setApiError(true);
  await assert.rejects(fixture.commerce.addBreakIn(fixture.unservicedId), /503/);
  await assert.rejects(fixture.commerce.removeBreakIn(fixture.servicedId), /503/);
  const cart = await fixture.commerce.getCart();
  assert.equal(cart.subtotal, 320);
  assert.deepEqual(mixedQuantities(cart, fixture.servicedId, fixture.unservicedId), { serviced: 1, unserviced: 1, service: 1 });
});

test('Shopify user errors leave the cart intact', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  await fixture.commerce.addProduct('black', false);
  fixture.setUserError('Quantity unavailable');
  await assert.rejects(fixture.commerce.setQuantity('black', 2), /Quantity unavailable/);
  assert.equal((await fixture.commerce.getCart()).subtotal, 150);
});
