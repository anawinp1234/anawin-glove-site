import test from 'node:test';
import assert from 'node:assert/strict';
import { breakInService, localProducts, purchasePrice } from '../src/catalog.js';
import {
  cartEntryTotal,
  cartUnitPrice,
  commerceErrorMessage,
  createLocalCommerce,
  createShopifyCommerce,
  migrateLocalCart,
  shopifyRequest,
  ShopifyRequestError,
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
    assert.equal(purchasePrice(product, breakInService, false), 155);
    assert.equal(purchasePrice(product, breakInService, true), 175);
    assert.equal(purchasePrice(product, breakInService, false), 155);
  }
  assert.equal(purchasePrice({ price: 160 }, { price: 25 }, true), 185);
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
  assert.equal(cart.subtotal, 175);
  assert.equal(cart.lines.find(line => line.isBreakIn).quantity, 1);

  cart = await commerce.setQuantity('black', 3);
  assert.equal(cart.subtotal, 525);
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
  assert.equal(validateShopifyConfig({
    VITE_COMMERCE_MODE: 'shopify',
    VITE_SHOPIFY_STORE_DOMAIN: 'store.myshopify.com',
    VITE_SHOPIFY_STOREFRONT_TOKEN: 'public-token',
    VITE_SHOPIFY_BR16_HANDLE: 'br16',
    VITE_SHOPIFY_OB16_HANDLE: 'ob16',
    VITE_SHOPIFY_CL16_HANDLE: 'cl16'
  }).breakInHandle, '');
});

test('Shopify request surfaces HTTP and GraphQL errors', async () => {
  const config = { domain: 'store.myshopify.com', apiVersion: '2026-07', accessToken: 'public-token' };
  await assert.rejects(shopifyRequest(config, 'query {}', {}, async () => ({ ok: false, status: 503 })), /503/);
  await assert.rejects(shopifyRequest(config, 'query {}', {}, async () => ({
    ok: true,
    json: async () => ({ errors: [{ message: 'Not permitted' }] })
  })), /Not permitted/);
});

test('a timed-out Shopify request aborts, clears loading, and can be retried safely', async () => {
  const config = { domain: 'store.myshopify.com', apiVersion: '2026-07', accessToken: 'public-token', timeoutMs: 20 };
  let calls = 0;
  let signal;
  const fetchImpl = async (_url, options) => {
    calls++;
    signal = options.signal;
    if (calls === 1) return new Promise(() => {});
    return { ok: true, json: async () => ({ data: { ready: true } }) };
  };
  await assert.rejects(shopifyRequest(config, 'query {}', {}, fetchImpl), error => error.code === 'timeout');
  assert.equal(signal.aborted, true);
  assert.match(commerceErrorMessage(new ShopifyRequestError('timeout', 'timeout')), /taking too long/);
  assert.deepEqual(await shopifyRequest(config, 'query {}', {}, fetchImpl), { ready: true });
  assert.equal(calls, 2);
});

function shopifyFixture({ autoSyncChild = true, rekeyOnAttributeUpdate = false, rekeyOnAdd = false,
  rekeyOnQuantityUpdate = false, prices = {}, cartPrices = {}, discountedPrices = {}, currencies = {},
  subtotalOverride = null, discountCodes = [], discountApplications = [], discountAllocations = {},
  discountScenario = null, discountWarnings = [], serviceState = 'available', serviceHandle = 'break-in', timeoutMs,
  recoveryLocks = undefined } = {}) {
  const config = {
    domain: 'store.myshopify.com', accessToken: 'public-token', apiVersion: '2026-07',
    handles: { black: 'br16', blue: 'ob16', brown: 'cl16' }, breakInHandle: serviceHandle, timeoutMs
  };
  const variants = {
    br16: ['gid://variant/br16', prices.br16 || '155.00'], ob16: ['gid://variant/ob16', prices.ob16 || '155.00'],
    cl16: ['gid://variant/cl16', prices.cl16 || '155.00'], 'break-in': ['gid://variant/service', prices['break-in'] || '20.00']
  };
  const linePrice = handle => cartPrices[handle] || variants[handle][1];
  const finalUnitPrice = (handle, currentPrices = discountedPrices) => currentPrices[handle] || linePrice(handle);
  const storage = new MemoryStorage();
  let recoveryTail = Promise.resolve();
  const locks = recoveryLocks === undefined ? { request(_name, action) {
    const result = recoveryTail.then(action);
    recoveryTail = result.catch(() => {});
    return result;
  } } : recoveryLocks;
  const requests = [];
  let lines = [];
  let recoveryLines = null;
  let recoveryCartId = null;
  let nextCartId = 2;
  let nextId = 1;
  let cartExists = false;
  let userError = '';
  let apiError = false;
  let failMutationAt = 0;
  let failAfterMutationAt = 0;
  let userErrorAfterMutationAt = 0;
  let mutationCount = 0;
  let mutationObserver = null;
  let rejectStatusAt = 0;
  let delayMutationAt = 0;
  let delayResponseAfterAt = 0;
  let releaseDelayed = null;
  let signalDelayed = null;
  const response = data => ({ ok: true, json: async () => ({ data }) });
  const snapshot = (id = 'gid://cart/1') => {
    const cartLines = id === recoveryCartId ? recoveryLines : lines;
    const state = discountScenario?.(discountCodes.map(item => item.code)) || {};
    const currentPrices = state.discountedPrices || discountedPrices;
    const currentAllocations = state.discountAllocations || discountAllocations;
    return ({
    id, checkoutUrl: `https://store.myshopify.com/checkouts/${id.split('/').at(-1)}`,
    discountCodes: structuredClone(state.discountCodes || discountCodes), discountApplications: structuredClone(state.discountApplications || discountApplications),
    cost: { subtotalAmount: { amount: String(state.subtotalOverride ?? subtotalOverride ?? cartLines.reduce((sum, line) =>
      sum + line.quantity * Number(finalUnitPrice(line.merchandise.product.handle, currentPrices)), 0)), currencyCode: 'USD' } },
    lines: { nodes: structuredClone(cartLines).map(line => ({ ...line,
      allDiscountAllocations: structuredClone(currentAllocations[line.merchandise.product.handle] || []),
      cost: { amountPerQuantity: {
      amount: linePrice(line.merchandise.product.handle),
      currencyCode: currencies[line.merchandise.product.handle] || 'USD'
    }, subtotalAmount: {
      amount: String(line.quantity * Number(linePrice(line.merchandise.product.handle))),
      currencyCode: currencies[line.merchandise.product.handle] || 'USD'
    }, totalAmount: {
      amount: String(line.quantity * Number(finalUnitPrice(line.merchandise.product.handle, currentPrices))),
      currencyCode: currencies[line.merchandise.product.handle] || 'USD'
    } } })) }
  });
  };
  const makeLine = (handle, quantity, parent = null, attributes = []) => ({
    id: `line-${nextId++}`, quantity,
    attributes: structuredClone(attributes),
    instructions: { canRemove: true, canUpdateQuantity: true },
    parentRelationship: parent ? { parent: { id: parent.id, merchandise: structuredClone(parent.merchandise) } } : null,
    merchandise: { id: variants[handle][0], product: { handle } }
  });
  const attributeSignature = attributes => JSON.stringify([...attributes].sort((a, b) =>
    a.key.localeCompare(b.key) || a.value.localeCompare(b.value)));
  const add = (inputs, targetLines = lines) => {
    for (const input of inputs) {
      if (input.parent) {
        const parent = targetLines.find(line => !line.parentRelationship &&
          (input.parent.lineId ? line.id === input.parent.lineId :
            line.merchandise.id === input.parent.merchandiseId &&
            line.attributes.some(attribute => attribute.key === '_anawin_service' && attribute.value === 'break-in')));
        if (!parent) throw new Error('Unknown parent cart line');
        const child = targetLines.find(line => line.parentRelationship?.parent.id === parent.id) ||
          makeLine('break-in', 0, parent);
        if (!targetLines.includes(child)) targetLines.push(child);
        child.quantity += input.quantity;
        continue;
      }
      const handle = Object.keys(variants).find(key => variants[key][0] === input.merchandiseId);
      const existing = targetLines.find(line => line.merchandise.id === input.merchandiseId && !line.parentRelationship &&
        attributeSignature(line.attributes) === attributeSignature(input.attributes || []));
      const parent = existing || makeLine(handle, 0, null, input.attributes);
      if (!existing) targetLines.push(parent);
      parent.quantity += input.quantity;
    }
  };
  const mergeEquivalentParents = () => {
    for (const parent of [...lines.filter(line => !line.parentRelationship)]) {
      if (!lines.includes(parent)) continue;
      const equivalent = lines.find(line => line !== parent && !line.parentRelationship &&
        line.merchandise.id === parent.merchandise.id &&
        attributeSignature(line.attributes) === attributeSignature(parent.attributes));
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
  const rekeyLines = () => {
    const parentIds = new Map();
    for (const line of lines.filter(line => !line.parentRelationship)) {
      const previousId = line.id;
      line.id = `line-${nextId++}`;
      parentIds.set(previousId, line.id);
    }
    for (const line of lines.filter(line => line.parentRelationship)) {
      line.id = `line-${nextId++}`;
      line.parentRelationship.parent.id = parentIds.get(line.parentRelationship.parent.id);
    }
  };
  const fetchImpl = async (url, options) => {
    assert.match(url, /\/api\/2026-07\/graphql\.json$/);
    const { query, variables } = JSON.parse(options.body);
    requests.push({ query, variables });
    if (query.includes('ProductByHandle')) {
      if (variables.handle === 'break-in' && serviceState === 'missing') return response({ product: null });
      if (variables.handle === 'break-in' && serviceState === 'failed') return { ok: false, status: 503 };
      const [id, amount] = variants[variables.handle];
      return response({ product: {
        id: `gid://product/${variables.handle}`, title: variables.handle.toUpperCase(), handle: variables.handle,
        variants: { nodes: [{ id, availableForSale: variables.handle !== 'break-in' || serviceState !== 'sold-out', price: { amount: variables.handle === 'break-in' && serviceState === 'invalid-price' ? 'bad' : amount, currencyCode: currencies[variables.handle] || 'USD' } }] }
      } });
    }
    assert.match(query, /parentRelationship/);
    assert.match(query, /discountCodes \{ code applicable \}/);
    assert.match(query, /discountApplications \{/);
    assert.match(query, /subtotalAmount \{ amount currencyCode \} totalAmount \{ amount currencyCode \}/);
    assert.match(query, /discountAllocations\(lineLevelOnly: false\)/);
    assert.match(query, /attributes \{ key value \}/);
    assert.match(query, /canUpdateQuantity/);
    if (query.includes('query Cart(')) return response({ cart: cartExists ? snapshot(variables.id) : null });
    if (apiError) return { ok: false, status: 503 };
    const field = query.includes('CreateCart') ? 'cartCreate' : query.includes('AddLines') ? 'cartLinesAdd' :
      query.includes('UpdateLines') ? 'cartLinesUpdate' : query.includes('UpdateDiscountCodes') ? 'cartDiscountCodesUpdate' : 'cartLinesRemove';
    mutationCount++;
    mutationObserver?.({ field, variables, storage });
    if (rejectStatusAt === mutationCount) return { ok: false, status: 422 };
    if (delayMutationAt === mutationCount) {
      signalDelayed?.();
      await new Promise(resolve => { releaseDelayed = resolve; });
    }
    if (failMutationAt === mutationCount) return response({ [field]: { userErrors: [{ message: 'Partial mutation failed' }], cart: snapshot() } });
    if (userError) return response({ [field]: { userErrors: [{ message: userError }], cart: snapshot() } });
    if (field === 'cartDiscountCodesUpdate') {
      discountCodes = variables.discountCodes.map(code => ({ code, applicable: true }));
    } else if (field === 'cartCreate' || field === 'cartLinesAdd') {
      if (field === 'cartCreate' && cartExists) {
        recoveryCartId = `gid://cart/${nextCartId++}`;
        recoveryLines = [];
        add(variables.input.lines, recoveryLines);
      } else {
        add(field === 'cartCreate' ? variables.input.lines : variables.lines,
          variables.cartId === recoveryCartId ? recoveryLines : lines);
      }
      cartExists = true;
      if (rekeyOnAdd && variables.cartId !== recoveryCartId) rekeyLines();
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
      if (rekeyOnQuantityUpdate && variables.lines.some(line => line.quantity !== undefined)) rekeyLines();
    } else {
      lines = lines.filter(line => !variables.lineIds.includes(line.id) && !variables.lineIds.includes(line.parentRelationship?.parent.id));
    }
    if (failAfterMutationAt === mutationCount) return { ok: false, status: 503 };
    if (delayResponseAfterAt === mutationCount) {
      signalDelayed?.();
      await new Promise(resolve => { releaseDelayed = resolve; });
    }
    if (userErrorAfterMutationAt === mutationCount) return response({ [field]: { userErrors: [{ message: 'Partial Shopify error' }],
      cart: snapshot(field === 'cartCreate' ? recoveryCartId || 'gid://cart/1' : variables.cartId || 'gid://cart/1') } });
    return response({ [field]: { userErrors: [], warnings: field === 'cartDiscountCodesUpdate' ? discountWarnings : [],
      cart: snapshot(field === 'cartCreate' ? recoveryCartId || 'gid://cart/1' : variables.cartId || 'gid://cart/1') } });
  };
  const shopify = createShopifyCommerce(config, storage, fetchImpl, locks);
  const commerce = {
    ...shopify,
    async listProducts() {
      const products = await shopify.listProducts();
      await shopify.getBreakInService();
      return products;
    }
  };
  return { commerce, storage, requests, restore: () => createShopifyCommerce(config, storage, fetchImpl, locks),
    get lines() { return storage.getItem('anawin-shopify-cart-id') === recoveryCartId ? recoveryLines : lines; },
    setUserError(value) { userError = value; }, setApiError(value) { apiError = value; },
    failNextMutation(offset = 1) { failMutationAt = mutationCount + offset; },
    failAfterNextMutation(offset = 1) { failAfterMutationAt = mutationCount + offset; },
    partialUserErrorNextMutation() { userErrorAfterMutationAt = mutationCount + 1; },
    rejectNextMutation() { rejectStatusAt = mutationCount + 1; },
    delayNextMutation() {
      delayMutationAt = mutationCount + 1;
      return new Promise(resolve => { signalDelayed = resolve; });
    },
    delayNextMutationResponse() {
      delayResponseAfterAt = mutationCount + 1;
      return new Promise(resolve => { signalDelayed = resolve; });
    },
    releaseDelayedMutation() { releaseDelayed?.(); },
    observeMutations(observer) { mutationObserver = observer; } };
}

test('same-cart Shopify mutations publish a cross-tab revision signal', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  const first = await fixture.commerce.addProduct('black', false);
  const before = fixture.storage.getItem('anawin-shopify-cart-revision');
  await fixture.commerce.setLineQuantity(first.lines[0].remoteLineId, 2);
  assert.notEqual(fixture.storage.getItem('anawin-shopify-cart-revision'), before);
  assert.equal(fixture.storage.getItem('anawin-shopify-cart-id'), first.id);
});

test('read-only Shopify cart verification preserves revision and glove relationships', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  const added = await fixture.commerce.addProduct('blue', true);
  const revision = fixture.commerce.readCartSafety().revision;
  const mutationCount = fixture.requests.filter(request => /mutation\s/.test(request.query)).length;
  for (let attempt = 0; attempt < 3; attempt++) {
    const checked = await fixture.commerce.getCart();
    const glove = checked.lines.find(line => !line.isBreakIn);
    const service = checked.lines.find(line => line.isBreakIn);
    assert.equal(glove.quantity, 1);
    assert.equal(service.quantity, glove.quantity);
    assert.equal(service.parentLineId, glove.remoteLineId);
    assert.equal(checked.incomplete, false);
    assert.equal(fixture.commerce.readCartSafety().revision, revision);
  }
  assert.equal(added.lines.length, 2);
  assert.equal(fixture.requests.filter(request => /mutation\s/.test(request.query)).length, mutationCount);
});

test('failed first cart creation keeps the cart empty and a deliberate retry adds one glove', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  fixture.failNextMutation();
  await assert.rejects(fixture.commerce.addProduct('black', false), /Partial mutation failed/);
  assert.equal(fixture.storage.getItem('anawin-shopify-cart-id'), null);
  const empty = await fixture.commerce.getCart();
  assert.deepEqual(empty.lines, []);
  assert.notEqual(empty.incomplete, true);
  assert.match(commerceErrorMessage(new Error('rejected'), 'add'), /Couldn’t add to cart/);
  const cart = await fixture.commerce.addProduct('black', false);
  assert.equal(cart.lines.length, 1);
  assert.equal(cart.subtotal, 155);
});

test('failed addition to an existing cart preserves items and retries only after rejection', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  const original = await fixture.commerce.addProduct('black', false);
  fixture.failNextMutation();
  await assert.rejects(fixture.commerce.addProduct('blue', false), /Partial mutation failed/);
  const unchanged = await fixture.commerce.getCart();
  assert.equal(unchanged.subtotal, 155);
  assert.equal(unchanged.checkoutUrl, original.checkoutUrl);
  assert.equal(unchanged.incomplete, false);
  const retried = await fixture.commerce.addProduct('blue', false);
  assert.equal(retried.subtotal, 310);
  assert.equal(retried.lines.filter(line => !line.isBreakIn).length, 2);
});

test('an applied uncertain add remains isolated until the customer recovers a verified cart', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  await fixture.commerce.addProduct('black', false);
  fixture.failAfterNextMutation();
  await assert.rejects(fixture.commerce.addProduct('blue', false), error => error.code === 'uncertain');
  assert.equal((await fixture.commerce.getCart()).incomplete, true);
  assert.ok(fixture.storage.getItem('anawin-shopify-pending-mutation'));
  const mutationsBeforeCheck = fixture.requests.filter(item => /mutation /.test(item.query)).length;
  const checked = await fixture.restore().refreshCart();
  assert.equal(checked.incomplete, true);
  assert.equal(checked.recoveryAvailable, true);
  assert.equal(checked.subtotal, 310);
  assert.ok(fixture.storage.getItem('anawin-shopify-pending-mutation'));
  assert.equal(fixture.requests.filter(item => /mutation /.test(item.query)).length, mutationsBeforeCheck);
  const recovered = await fixture.restore().recoverCart();
  assert.equal(recovered.incomplete, false);
  assert.equal(recovered.subtotal, 310);
  assert.notEqual(recovered.id, checked.id);
  assert.equal(fixture.storage.getItem('anawin-shopify-pending-mutation'), null);
});

test('an unresolved cart mutation blocks another add until its outcome is known', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  await fixture.commerce.addProduct('black', false);
  fixture.setApiError(true);
  await assert.rejects(fixture.commerce.addProduct('blue', false), error => error.code === 'uncertain');
  fixture.setApiError(false);
  const checked = await fixture.commerce.refreshCart();
  assert.equal(checked.subtotal, 155);
  assert.equal(checked.incomplete, true);
  const mutationsBeforeRetry = fixture.requests.filter(item => /mutation /.test(item.query)).length;
  await assert.rejects(fixture.commerce.addProduct('blue', false), /cart is incomplete/);
  assert.equal(fixture.requests.filter(item => /mutation /.test(item.query)).length, mutationsBeforeRetry);
  const recovered = await fixture.restore().recoverCart();
  assert.equal(recovered.incomplete, false);
  assert.equal(recovered.subtotal, 155);
  const retried = await fixture.commerce.addProduct('blue', false);
  assert.equal(retried.subtotal, 310);
});

test('an uncertain add to an existing empty cart stays blocked after a read', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  await fixture.commerce.addProduct('black', false);
  await fixture.commerce.removeProduct('black');
  fixture.setApiError(true);
  await assert.rejects(fixture.commerce.addProduct('blue', false), error => error.code === 'uncertain');
  fixture.setApiError(false);
  const empty = await fixture.restore().getCart();
  assert.equal(empty.lines.length, 0);
  assert.equal(empty.incomplete, true);
  await assert.rejects(fixture.commerce.addProduct('blue', false), /cart is incomplete/);
  const recovered = await fixture.restore().recoverCart();
  assert.equal(recovered.lines.length, 0);
  assert.equal(recovered.incomplete, false);
});

test('an HTTP rejection establishes no mutation and leaves the existing cart usable', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  await fixture.commerce.addProduct('black', false);
  fixture.rejectNextMutation();
  await assert.rejects(fixture.commerce.addProduct('blue', false), error => error.code === 'http-rejected');
  const cart = await fixture.commerce.getCart();
  assert.equal(cart.incomplete, false);
  assert.equal(cart.subtotal, 155);
  assert.equal(fixture.storage.getItem('anawin-shopify-unsafe-cart-id'), null);
  assert.equal((await fixture.commerce.addProduct('blue', false)).subtotal, 310);
});

test('a Shopify user error with changed cart contents is treated as uncertain', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  await fixture.commerce.addProduct('black', false);
  fixture.partialUserErrorNextMutation();
  await assert.rejects(fixture.commerce.addProduct('blue', false), error => error.code === 'uncertain');
  const blocked = await fixture.commerce.refreshCart();
  assert.equal(blocked.incomplete, true);
  assert.equal(blocked.subtotal, 310);
  const recovered = await fixture.restore().recoverCart();
  assert.equal(recovered.incomplete, false);
  assert.equal(recovered.subtotal, 310);
});

for (const applied of [false, true]) {
  test(`${applied ? 'applied' : 'unapplied'} timed-out addition recovers without replaying the old mutation`, async () => {
    const fixture = shopifyFixture({ timeoutMs: 20 });
    await fixture.commerce.listProducts();
    await fixture.commerce.addProduct('black', false);
    const reachedMutation = applied ? fixture.delayNextMutationResponse() : fixture.delayNextMutation();
    const attempt = fixture.commerce.addProduct('blue', false).catch(error => error);
    await reachedMutation;
    assert.equal((await attempt).code, 'uncertain');
    const observed = await fixture.restore().refreshCart();
    assert.equal(observed.incomplete, true);
    assert.equal(observed.subtotal, applied ? 310 : 155);
    const recovered = await fixture.restore().recoverCart();
    assert.equal(recovered.incomplete, false);
    assert.equal(recovered.subtotal, applied ? 310 : 155);
    fixture.releaseDelayedMutation();
    await new Promise(resolve => setTimeout(resolve, 0));
    const active = await fixture.restore().getCart();
    assert.equal(active.id, recovered.id);
    assert.equal(active.subtotal, recovered.subtotal);
    if (!applied) {
      const retried = await fixture.commerce.addProduct('blue', false);
      assert.equal(retried.subtotal, 310);
      assert.equal(retried.lines.filter(line => line.productId === 'blue' && !line.isBreakIn).reduce((sum, line) => sum + line.quantity, 0), 1);
    }
  });
}

for (const [label, target, applied] of [
  ['quantity increase', 2, false], ['quantity decrease', 1, true]
]) {
  test(`a failed ${label} recovers into a separate Shopify cart`, async () => {
    const fixture = shopifyFixture();
    await fixture.commerce.listProducts();
    await fixture.commerce.addProduct('black', true);
    if (applied) await fixture.commerce.setLineQuantity((await fixture.commerce.getCart()).lines.find(line => !line.isBreakIn).remoteLineId, 2);
    const before = await fixture.commerce.getCart();
    const parent = before.lines.find(line => !line.isBreakIn);
    fixture.failAfterNextMutation();
    await assert.rejects(fixture.commerce.setLineQuantity(parent.remoteLineId, target), error => error.code === 'uncertain');
    const blocked = await fixture.restore().refreshCart();
    assert.equal(blocked.incomplete, true);
    assert.equal(blocked.recoveryAvailable, true);
    const recovered = await fixture.restore().recoverCart();
    assert.equal(recovered.incomplete, false);
    assert.equal(recovered.lines.find(line => !line.isBreakIn).quantity, target);
    assert.equal(recovered.lines.find(line => line.isBreakIn).quantity, target);
    assert.notEqual(recovered.id, before.id);
  });
}

test('a failed removal preserves the verified remaining items after reload', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  await fixture.commerce.addProduct('black', true);
  await fixture.commerce.addProduct('blue', false);
  const before = await fixture.commerce.getCart();
  fixture.failAfterNextMutation();
  await assert.rejects(fixture.commerce.removeLine(before.lines.find(line => line.productId === 'black' && !line.isBreakIn).remoteLineId),
    error => error.code === 'uncertain');
  const recovered = await fixture.restore().recoverCart();
  assert.equal(recovered.incomplete, false);
  assert.equal(recovered.lines.length, 1);
  assert.equal(recovered.lines[0].productId, 'blue');
  assert.equal(recovered.subtotal, 155);
});

test('a partial Break-In change recovers the last consistent glove-only cart', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  await fixture.commerce.addProduct('black', false);
  const before = await fixture.commerce.getCart();
  fixture.failAfterNextMutation();
  await assert.rejects(fixture.commerce.addBreakIn(before.lines[0].remoteLineId), error => error.code === 'uncertain');
  const partial = await fixture.restore().refreshCart();
  assert.equal(partial.incomplete, true);
  assert.equal(partial.recoveryAvailable, true);
  const recovered = await fixture.restore().recoverCart();
  assert.equal(recovered.incomplete, false);
  assert.equal(recovered.subtotal, 155);
  assert.equal(recovered.lines.filter(line => line.isBreakIn).length, 0);
});

test('an incomplete cart cannot drop another tab’s confirmed glove from an older snapshot', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  const original = await fixture.commerce.addProduct('black', false);
  const otherTab = fixture.restore();
  await otherTab.listProducts();
  const reached = fixture.delayNextMutation();
  const changingService = fixture.commerce.addBreakIn(original.lines[0].remoteLineId).catch(error => error);
  await reached;
  const confirmed = await otherTab.addProduct('blue', false);
  assert.equal(confirmed.subtotal, 310);
  fixture.failNextMutation();
  fixture.releaseDelayedMutation();
  await changingService;
  await assert.rejects(fixture.restore().recoverCart(), error => error.code === 'recovery-ambiguous');
  assert.equal(fixture.storage.getItem('anawin-shopify-cart-id'), original.id);
  assert.equal(fixture.storage.getItem('anawin-shopify-unsafe-cart-id'), original.id);
  assert.equal(fixture.requests.filter(request => request.query.includes('CreateCart')).length, 1);
});

test('an outdated snapshot cannot overwrite another tab’s confirmed quantity', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  await fixture.commerce.addProduct('black', false);
  const original = await fixture.commerce.addProduct('blue', false);
  const black = original.lines.find(line => line.productId === 'black' && !line.isBreakIn);
  const blue = original.lines.find(line => line.productId === 'blue' && !line.isBreakIn);
  const otherTab = fixture.restore();
  await otherTab.listProducts();
  const reached = fixture.delayNextMutation();
  const changingService = fixture.commerce.addBreakIn(black.remoteLineId).catch(error => error);
  await reached;
  const confirmed = await otherTab.setLineQuantity(blue.remoteLineId, 2);
  assert.equal(confirmed.lines.find(line => line.productId === 'blue').quantity, 2);
  fixture.failNextMutation();
  fixture.releaseDelayedMutation();
  await changingService;
  await assert.rejects(fixture.restore().recoverCart(), error => error.code === 'recovery-ambiguous');
  assert.equal(fixture.storage.getItem('anawin-shopify-cart-id'), original.id);
  assert.equal(fixture.requests.filter(request => request.query.includes('CreateCart')).length, 1);
});

test('an outdated snapshot cannot remove another tab’s confirmed Break-In association', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  await fixture.commerce.addProduct('black', false);
  const original = await fixture.commerce.addProduct('blue', false);
  const black = original.lines.find(line => line.productId === 'black' && !line.isBreakIn);
  const blue = original.lines.find(line => line.productId === 'blue' && !line.isBreakIn);
  const otherTab = fixture.restore();
  await otherTab.listProducts();
  await otherTab.getBreakInService();
  const reached = fixture.delayNextMutation();
  const changingService = fixture.commerce.addBreakIn(black.remoteLineId).catch(error => error);
  await reached;
  const confirmed = await otherTab.addBreakIn(blue.remoteLineId);
  assert.equal(confirmed.lines.filter(line => line.isBreakIn).length, 1);
  fixture.failNextMutation();
  fixture.releaseDelayedMutation();
  await changingService;
  await assert.rejects(fixture.restore().recoverCart(), error => error.code === 'recovery-ambiguous');
  assert.equal(fixture.storage.getItem('anawin-shopify-cart-id'), original.id);
  assert.equal(fixture.requests.filter(request => request.query.includes('CreateCart')).length, 1);
});

test('failed Break-In removal recovers mixed serviced and unserviced lines with correct parents', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  await fixture.commerce.addProduct('black', true);
  await fixture.commerce.addProduct('black', false);
  await fixture.commerce.addProduct('blue', true);
  const before = await fixture.commerce.getCart();
  const servicedBlack = before.lines.find(line => line.productId === 'black' && !line.isBreakIn && line.serviceConfiguration === 'break-in');
  fixture.failAfterNextMutation();
  await assert.rejects(fixture.commerce.removeBreakIn(servicedBlack.remoteLineId), error => error.code === 'uncertain');
  const recovered = await fixture.restore().recoverCart();
  assert.equal(recovered.incomplete, false);
  assert.equal(recovered.subtotal, 505);
  assert.equal(recovered.lines.filter(line => !line.isBreakIn).length, 3);
  assert.equal(recovered.lines.filter(line => line.isBreakIn).length, 2);
  for (const child of recovered.lines.filter(line => line.isBreakIn)) {
    const parent = recovered.lines.find(line => line.remoteLineId === child.parentLineId);
    assert.equal(parent.serviceConfiguration, 'break-in');
    assert.equal(parent.productId, child.productId);
  }
});

test('an explicit glove-only recovery can omit unavailable Break-In without dropping gloves', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  await fixture.commerce.addProduct('black', true);
  await fixture.commerce.addProduct('black', false);
  await fixture.commerce.addProduct('blue', true);
  const before = await fixture.commerce.getCart();
  fixture.setApiError(true);
  await assert.rejects(fixture.commerce.addProduct('brown', false), error => error.code === 'uncertain');
  fixture.setApiError(false);
  const blocked = await fixture.restore().refreshCart();
  assert.equal(blocked.recoveryHasBreakIn, true);
  const recovered = await fixture.restore().recoverCart({ withoutBreakIn: true });
  assert.equal(recovered.incomplete, false);
  assert.equal(recovered.subtotal, 465);
  assert.equal(recovered.lines.filter(line => !line.isBreakIn).reduce((sum, line) => sum + line.quantity, 0), 3);
  assert.equal(recovered.lines.filter(line => line.isBreakIn).length, 0);
  assert.notEqual(recovered.id, before.id);
});

test('failed recovery leaves the original cart and unresolved state available for another attempt', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  const original = await fixture.commerce.addProduct('black', false);
  fixture.setApiError(true);
  await assert.rejects(fixture.commerce.addProduct('blue', false), error => error.code === 'uncertain');
  await assert.rejects(fixture.commerce.recoverCart(), /503/);
  assert.equal(fixture.storage.getItem('anawin-shopify-cart-id'), original.id);
  assert.ok(fixture.storage.getItem('anawin-shopify-pending-mutation'));
  fixture.setApiError(false);
  assert.equal((await fixture.restore().recoverCart()).incomplete, false);
});

test('Web Locks serialize simultaneous recovery into one active replacement cart', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  const original = await fixture.commerce.addProduct('black', false);
  fixture.setApiError(true);
  await assert.rejects(fixture.commerce.addProduct('blue', false), error => error.code === 'uncertain');
  fixture.setApiError(false);
  const firstTab = fixture.restore();
  const secondTab = fixture.restore();
  const [first, second] = await Promise.all([firstTab.recoverCart(), secondTab.recoverCart()]);
  assert.notEqual(first.id, original.id);
  assert.equal(second.id, first.id);
  assert.equal(fixture.storage.getItem('anawin-shopify-cart-id'), first.id);
  assert.equal(fixture.requests.filter(request => request.query.includes('CreateCart')).length, 2);
});

test('recovery without Web Locks creates no replacement and preserves the original', async () => {
  const fixture = shopifyFixture({ recoveryLocks: null });
  await fixture.commerce.listProducts();
  const original = await fixture.commerce.addProduct('black', false);
  fixture.setApiError(true);
  await assert.rejects(fixture.commerce.addProduct('blue', false), error => error.code === 'uncertain');
  fixture.setApiError(false);
  await assert.rejects(fixture.restore().recoverCart(), error => error.code === 'recovery-lock-unavailable');
  assert.match(commerceErrorMessage(new ShopifyRequestError('lock', 'recovery-lock-unavailable')), /browser that supports Web Locks/);
  assert.equal(fixture.storage.getItem('anawin-shopify-cart-id'), original.id);
  assert.equal(fixture.storage.getItem('anawin-shopify-unsafe-cart-id'), original.id);
  assert.equal(fixture.requests.filter(request => request.query.includes('CreateCart')).length, 1);
});

test('two tabs cannot mistake one addition for a timed-out addition from the other tab', async () => {
  const fixture = shopifyFixture({ timeoutMs: 20 });
  await fixture.commerce.listProducts();
  await fixture.commerce.addProduct('black', false);
  const otherTab = fixture.restore();
  await otherTab.listProducts();
  const reachedMutation = fixture.delayNextMutation();
  const delayed = fixture.commerce.addProduct('blue', false).catch(error => error);
  await reachedMutation;
  assert.equal((await otherTab.addProduct('blue', false)).subtotal, 310);
  assert.equal((await delayed).code, 'uncertain');
  const blocked = await fixture.restore().refreshCart();
  assert.equal(blocked.incomplete, true);
  const recovered = await fixture.restore().recoverCart();
  assert.equal(recovered.lines.filter(line => line.productId === 'blue' && !line.isBreakIn).reduce((sum, line) => sum + line.quantity, 0), 1);
  fixture.releaseDelayedMutation();
  await new Promise(resolve => setTimeout(resolve, 0));
  const active = await fixture.restore().getCart();
  assert.equal(active.id, recovered.id);
  assert.equal(active.lines.filter(line => line.productId === 'blue' && !line.isBreakIn).reduce((sum, line) => sum + line.quantity, 0), 1);
});

test('a late successful response from an old tab cannot replace a recovered active cart', async () => {
  const fixture = shopifyFixture({ timeoutMs: 1000 });
  await fixture.commerce.listProducts();
  await fixture.commerce.addProduct('black', false);
  const otherTab = fixture.restore();
  await otherTab.listProducts();
  const reachedMutation = fixture.delayNextMutation();
  const delayed = otherTab.addProduct('blue', false).catch(error => error);
  await reachedMutation;
  fixture.failAfterNextMutation();
  await assert.rejects(fixture.commerce.addProduct('brown', false), error => error.code === 'uncertain');
  const recovered = await fixture.restore().recoverCart();
  fixture.releaseDelayedMutation();
  assert.equal((await delayed).code, 'cart-changed');
  const active = await fixture.restore().getCart();
  assert.equal(active.id, recovered.id);
  assert.equal(active.subtotal, 310);
  assert.equal(active.lines.some(line => line.productId === 'blue'), false);
});

for (const serviceState of ['missing', 'failed', 'sold-out', 'missing-handle', 'invalid-price']) {
  test(`${serviceState} Break-In Service leaves all gloves purchasable without service`, async () => {
    const fixture = shopifyFixture({ serviceState, serviceHandle: serviceState === 'missing-handle' ? '' : 'break-in' });
    const products = await fixture.commerce.listProducts();
    assert.equal(products.length, 3);
    assert.ok(products.every(product => product.available));
    assert.equal((await fixture.commerce.getBreakInService()).available, false);
    const cart = await fixture.commerce.addProduct('black', false);
    assert.equal(cart.subtotal, 155);
    assert.equal(cart.lines.filter(line => line.isBreakIn).length, 0);
    await assert.rejects(fixture.commerce.addProduct('blue', true), /not currently available/);
    assert.equal((await fixture.commerce.getCart()).subtotal, 155);
  });
}

test('adds a glove without service using Shopify price and checkout', async () => {
  const fixture = shopifyFixture();
  const { commerce, requests } = fixture;
  const product = (await commerce.listProducts()).find(item => item.id === 'black');
  assert.equal(product.throwingHand, 'Right');
  assert.equal(product.wornOnHand, 'Left');
  assert.equal(product.accentColor, localProducts.find(item => item.id === 'black').accentColor);
  assert.equal(product.accentBackground, localProducts.find(item => item.id === 'black').accentBackground);
  assert.equal(product.shopifyProductGid, 'gid://product/br16');
  const cart = await commerce.addProduct('black', false);
  assert.equal(cart.subtotal, 155);
  assert.equal(cart.checkoutUrl, 'https://store.myshopify.com/checkouts/1');
  assert.equal(cart.lines.length, 1);
  assert.deepEqual(requests.find(item => item.query.includes('CreateCart')).variables.input.lines,
    [{ merchandiseId: 'gid://variant/br16', quantity: 1, attributes: [{ key: '_anawin_service', value: 'none' }] }]);
});

test('all three available gloves remain purchasable with the normal $20 Break-In option', async () => {
  const fixture = shopifyFixture();
  const products = await fixture.commerce.listProducts();
  assert.deepEqual(products.map(product => [product.name, product.price, product.available]), [
    ['CL16', 155, true], ['OB16', 155, true], ['BR16', 155, true]
  ]);
  assert.equal((await fixture.commerce.getBreakInService()).price, 20);
  await fixture.commerce.addProduct('black', true);
  await fixture.commerce.addProduct('blue', false);
  const cart = await fixture.commerce.addProduct('brown', false);
  assert.equal(cart.subtotal, 485);
  assert.equal(cart.lines.filter(line => !line.isBreakIn).length, 3);
  assert.equal(cart.lines.filter(line => line.isBreakIn).length, 1);
});

test('adds a native nested Break-in line and restores its parent relationship', async () => {
  const { commerce, storage, requests, restore } = shopifyFixture();
  const products = await commerce.listProducts();
  assert.deepEqual(products.map(product => product.id), ['brown', 'blue', 'black']);
  assert.equal(products.find(product => product.id === 'black').merchandiseId, 'gid://variant/br16');
  assert.equal((await commerce.getBreakInService()).price, 20);
  const cart = await commerce.addProduct('black', true);
  assert.equal(cart.subtotal, 175);
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
  assert.equal(cart.subtotal, 525);
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
  assert.equal(cart.subtotal, 350);
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
  assert.equal(cart.subtotal, 660);
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

function entryUnitPrice(cart, parentId) {
  const parent = cart.lines.find(line => line.remoteLineId === parentId);
  const service = cart.lines.find(line => line.isBreakIn && line.parentLineId === parentId);
  return cartUnitPrice(parent, service);
}

function entryTotal(cart, parentId) {
  const parent = cart.lines.find(line => line.remoteLineId === parentId);
  const service = cart.lines.find(line => line.isBreakIn && line.parentLineId === parentId);
  return cartEntryTotal(parent, service);
}

test('Shopify cart entry totals cover one and two gloves with and without service', async () => {
  for (const withService of [false, true]) {
    const { commerce } = shopifyFixture();
    await commerce.listProducts();
    const first = await commerce.addProduct('black', withService);
    const parentId = first.lines.find(line => !line.isBreakIn).remoteLineId;
    assert.deepEqual(entryTotal(first, parentId), { amount: withService ? 175 : 155, currencyCode: 'USD' });
    const second = await commerce.setLineQuantity(parentId, 2);
    assert.deepEqual(entryTotal(second, parentId), { amount: withService ? 350 : 310, currencyCode: 'USD' });
    assert.equal(second.subtotal, withService ? 350 : 310);
    const backToOne = await commerce.setLineQuantity(parentId, 1);
    assert.equal(entryTotal(backToOne, parentId).amount, withService ? 175 : 155);
  }
});

test('Shopify entry total refreshes after whole-line service changes', async () => {
  const { commerce } = shopifyFixture();
  await commerce.listProducts();
  const plain = await commerce.addProduct('black', false);
  const parentId = plain.lines[0].remoteLineId;
  assert.equal(entryTotal(plain, parentId).amount, 155);
  const serviced = await commerce.addBreakIn(parentId);
  assert.equal(entryTotal(serviced, parentId).amount, 175);
  const removed = await commerce.removeBreakIn(parentId);
  assert.equal(entryTotal(removed, parentId).amount, 155);
});

test('line total uses Shopify discounts and cart prices rather than variant prices', async () => {
  const { commerce } = shopifyFixture({ cartPrices: { br16: '160.00', 'break-in': '25.00' },
    discountedPrices: { br16: '145.00', 'break-in': '18.00' }, subtotalOverride: 999 });
  await commerce.listProducts();
  const cart = await commerce.addProduct('black', true);
  const parent = cart.lines.find(line => !line.isBreakIn);
  assert.equal(parent.unitPrice.amount, 160);
  assert.equal(parent.lineTotal.amount, 145);
  assert.equal(cart.lines.find(line => line.isBreakIn).lineTotal.amount, 18);
  assert.deepEqual(entryTotal(cart, parent.remoteLineId), { amount: 163, currencyCode: 'USD' });
  assert.equal(cart.subtotal, 999);
});

test('Shopify cart query normalizes code applicability and separate glove/service allocations', async () => {
  const { commerce, requests } = shopifyFixture({
    discountedPrices: { br16: '140.00' },
    discountCodes: [{ code: 'LAUNCH10', applicable: true }, { code: 'EXPIRED', applicable: false }],
    discountApplications: [{ code: 'LAUNCH10', targetType: 'LINE_ITEM', value: {
      __typename: 'PricingPercentageValue', percentage: 10
    } }],
    discountAllocations: { br16: [{ discountedAmount: { amount: '15.00', currencyCode: 'USD' },
      targetType: 'LINE_ITEM', sourceDiscountApplication: { code: 'LAUNCH10' } }] }
  });
  await commerce.listProducts();
  const cart = await commerce.addProduct('black', true);
  assert.deepEqual(cart.discountCodes, [{ code: 'LAUNCH10', applicable: true }, { code: 'EXPIRED', applicable: false }]);
  assert.deepEqual(cart.discountApplications, [{ code: 'LAUNCH10', targetType: 'LINE_ITEM', percentage: 10 }]);
  const parent = cart.lines.find(line => !line.isBreakIn);
  const child = cart.lines.find(line => line.isBreakIn);
  assert.deepEqual(parent.lineSubtotal, { amount: 155, currencyCode: 'USD' });
  assert.deepEqual(parent.lineTotal, { amount: 140, currencyCode: 'USD' });
  assert.deepEqual(parent.allDiscountAllocations, [{ amount: { amount: 15, currencyCode: 'USD' },
    targetType: 'LINE_ITEM', code: 'LAUNCH10' }]);
  assert.deepEqual(child.allDiscountAllocations, []);
  assert.equal(cart.subtotal, 160);
  assert.ok(requests.some(({ query }) => query.includes('sourceDiscountApplication')));
});

test('line total currency mismatch blocks checkout without combining money', async () => {
  const currencies = {};
  const { commerce } = shopifyFixture({ currencies });
  await commerce.listProducts();
  const before = await commerce.addProduct('black', true);
  const parentId = before.lines.find(line => !line.isBreakIn).remoteLineId;
  currencies['break-in'] = 'CAD';
  const cart = await commerce.getCart();
  assert.equal(entryTotal(cart, parentId), null);
  assert.equal(cart.incomplete, true);
});

test('unserviced glove unit price comes from its Shopify cart line', async () => {
  const { commerce } = shopifyFixture();
  await commerce.listProducts();
  const cart = await commerce.addProduct('black', false);
  assert.deepEqual(entryUnitPrice(cart, cart.lines[0].remoteLineId), { amount: 155, currencyCode: 'USD' });
  assert.equal(cart.incomplete, false);
});

test('serviced glove unit price combines its Shopify parent and child prices', async () => {
  const { commerce } = shopifyFixture();
  await commerce.listProducts();
  const cart = await commerce.addProduct('black', true);
  const parent = cart.lines.find(line => !line.isBreakIn);
  assert.deepEqual(parent.unitPrice, { amount: 155, currencyCode: 'USD' });
  assert.deepEqual(cart.lines.find(line => line.isBreakIn).unitPrice, { amount: 20, currencyCode: 'USD' });
  assert.deepEqual(entryUnitPrice(cart, parent.remoteLineId), { amount: 175, currencyCode: 'USD' });
});

test('adding service updates the selected glove unit price after Shopify confirms it', async () => {
  const { commerce } = shopifyFixture();
  await commerce.listProducts();
  const before = await commerce.addProduct('black', false);
  const parentId = before.lines[0].remoteLineId;
  assert.equal(entryUnitPrice(before, parentId).amount, 155);
  const after = await commerce.addBreakIn(parentId);
  assert.equal(entryUnitPrice(after, parentId).amount, 175);
  assert.equal(after.subtotal, 175);
});

test('removing service updates the selected glove unit price after Shopify confirms it', async () => {
  const { commerce } = shopifyFixture();
  await commerce.listProducts();
  const before = await commerce.addProduct('black', true);
  const parentId = before.lines.find(line => !line.isBreakIn).remoteLineId;
  assert.equal(entryUnitPrice(before, parentId).amount, 175);
  const after = await commerce.removeBreakIn(parentId);
  assert.equal(entryUnitPrice(after, parentId).amount, 155);
  assert.equal(after.subtotal, 155);
});

test('quantity two keeps the Shopify unit price rather than the extended total', async () => {
  const { commerce } = shopifyFixture();
  await commerce.listProducts();
  const first = await commerce.addProduct('black', true);
  const parentId = first.lines.find(line => !line.isBreakIn).remoteLineId;
  const cart = await commerce.setLineQuantity(parentId, 2);
  assert.equal(cart.lines.find(line => line.remoteLineId === parentId).quantity, 2);
  assert.equal(cart.lines.find(line => line.isBreakIn).quantity, 2);
  assert.equal(entryUnitPrice(cart, parentId).amount, 175);
  assert.equal(cart.subtotal, 350);
});

test('mixed serviced and unserviced entries use only their own child prices', async () => {
  const { cart, servicedId, unservicedId } = await mixedCartFixture();
  assert.equal(entryUnitPrice(cart, servicedId).amount, 175);
  assert.equal(entryUnitPrice(cart, unservicedId).amount, 155);
  assert.equal(cart.subtotal, 330);
});

test('nonstandard Shopify cart prices determine the displayed unit price', async () => {
  const { commerce } = shopifyFixture({ cartPrices: { br16: '160.00', 'break-in': '25.00' } });
  await commerce.listProducts();
  assert.equal((await commerce.getBreakInService()).price, 20);
  const unserviced = await commerce.addProduct('black', false);
  assert.equal(entryUnitPrice(unserviced, unserviced.lines[0].remoteLineId).amount, 160);
  const cart = await commerce.addProduct('black', true);
  const serviced = cart.lines.find(line => !line.isBreakIn && line.serviceConfiguration === 'break-in');
  assert.equal(entryUnitPrice(cart, serviced.remoteLineId).amount, 185);
  assert.equal(cart.subtotal, 345);
});

test('currency mismatch leaves the combined price unavailable and blocks checkout', async () => {
  const currencies = {};
  const { commerce } = shopifyFixture({ currencies });
  await commerce.listProducts();
  const before = await commerce.addProduct('black', true);
  const parentId = before.lines.find(line => !line.isBreakIn).remoteLineId;
  currencies['break-in'] = 'CAD';
  const cart = await commerce.getCart();
  assert.equal(entryUnitPrice(cart, parentId), null);
  assert.equal(cart.incomplete, true);
  assert.equal(cart.subtotal, 175);
});

test('one serviced and one unserviced BR16 have separate parent cart-line identities', async () => {
  const { cart, servicedId, unservicedId } = await mixedCartFixture();
  assert.notEqual(servicedId, unservicedId);
  assert.deepEqual(mixedQuantities(cart, servicedId, unservicedId), { serviced: 1, unserviced: 1, service: 1 });
  assert.equal(cart.subtotal, 330);
});

test('adding unserviced then serviced BR16 keeps distinct Shopify parent attributes', async () => {
  const { commerce, restore, requests } = shopifyFixture();
  await commerce.listProducts();
  await commerce.addProduct('black', false);
  const cart = await commerce.addProduct('black', true);
  const parents = cart.lines.filter(line => !line.isBreakIn);
  assert.equal(parents.length, 2);
  assert.deepEqual(parents.map(line => line.serviceConfiguration), ['none', 'break-in']);
  assert.equal(cart.subtotal, 330);
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
  assert.equal(cart.subtotal, 330);
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
  assert.equal(cart.subtotal, 310);
});

test('repeated serviced additions combine with matching nested child quantity', async () => {
  const { commerce } = shopifyFixture();
  await commerce.listProducts();
  await commerce.addProduct('black', true);
  const cart = await commerce.addProduct('black', true);
  assert.equal(cart.lines.filter(line => !line.isBreakIn).length, 1);
  assert.equal(cart.lines.find(line => !line.isBreakIn).quantity, 2);
  assert.equal(cart.lines.find(line => line.isBreakIn).quantity, 2);
  assert.equal(cart.subtotal, 350);
});

test('incrementing the serviced BR16 changes only its parent and nested child', async () => {
  const { commerce, requests, servicedId, unservicedId } = await mixedCartFixture({ autoSyncChild: false });
  const cart = await commerce.setLineQuantity(servicedId, 2);
  assert.deepEqual(mixedQuantities(cart, servicedId, unservicedId), { serviced: 2, unserviced: 1, service: 2 });
  assert.equal(cart.subtotal, 505);
  assert.deepEqual(requests.filter(item => item.query.includes('UpdateLines')).map(item => item.variables.lines[0].id), [servicedId, 'line-2']);
});

test('incrementing the unserviced BR16 never updates Break-in Service', async () => {
  const { commerce, requests, servicedId, unservicedId } = await mixedCartFixture();
  const cart = await commerce.setLineQuantity(unservicedId, 2);
  assert.deepEqual(mixedQuantities(cart, servicedId, unservicedId), { serviced: 1, unserviced: 2, service: 1 });
  assert.equal(cart.subtotal, 485);
  assert.deepEqual(requests.filter(item => item.query.includes('UpdateLines')).map(item => item.variables.lines[0].id), [unservicedId]);
});

test('decrementing the serviced BR16 synchronizes only its nested child', async () => {
  const { commerce, servicedId, unservicedId } = await mixedCartFixture({ autoSyncChild: false });
  await commerce.setLineQuantity(servicedId, 2);
  const cart = await commerce.setLineQuantity(servicedId, 1);
  assert.deepEqual(mixedQuantities(cart, servicedId, unservicedId), { serviced: 1, unserviced: 1, service: 1 });
  assert.equal(cart.subtotal, 330);
});

test('decrementing the unserviced BR16 leaves the serviced line unchanged', async () => {
  const { commerce, servicedId, unservicedId } = await mixedCartFixture();
  await commerce.setLineQuantity(unservicedId, 2);
  const cart = await commerce.setLineQuantity(unservicedId, 1);
  assert.deepEqual(mixedQuantities(cart, servicedId, unservicedId), { serviced: 1, unserviced: 1, service: 1 });
  assert.equal(cart.subtotal, 330);
});

test('removing the serviced parent cascades its child and retains unserviced BR16', async () => {
  const { commerce, requests, servicedId, unservicedId } = await mixedCartFixture();
  const cart = await commerce.removeLine(servicedId);
  assert.deepEqual(mixedQuantities(cart, servicedId, unservicedId), { serviced: 0, unserviced: 1, service: 0 });
  assert.equal(cart.subtotal, 155);
  assert.deepEqual(requests.find(item => item.query.includes('RemoveLines')).variables.lineIds, [servicedId]);
});

test('removing the unserviced parent retains serviced BR16 and its child', async () => {
  const { commerce, requests, servicedId, unservicedId } = await mixedCartFixture();
  const cart = await commerce.removeLine(unservicedId);
  assert.deepEqual(mixedQuantities(cart, servicedId, unservicedId), { serviced: 1, unserviced: 0, service: 1 });
  assert.equal(cart.subtotal, 175);
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
  assert.equal(before.subtotal, 175);
  assert.equal(after.subtotal, 155);
  assert.equal(after.lines.find(line => !line.isBreakIn).quantity, 1);
  assert.equal(after.lines.some(line => line.isBreakIn), false);
  assert.deepEqual(requests.find(item => item.query.includes('RemoveLines')).variables.lineIds, [child.remoteLineId]);
});

test('removing service from two gloves changes only one glove', async () => {
  const { commerce, restore } = shopifyFixture();
  await commerce.listProducts();
  const first = await commerce.addProduct('black', true);
  const parentId = first.lines.find(line => !line.isBreakIn).remoteLineId;
  const before = await commerce.setLineQuantity(parentId, 2);
  assert.equal(before.subtotal, 350);
  const after = await commerce.removeBreakIn(parentId);
  assert.equal(after.subtotal, 330);
  assert.deepEqual(after.lines.filter(line => !line.isBreakIn).map(line => [line.serviceConfiguration, line.quantity]),
    [['break-in', 1], ['none', 1]]);
  assert.equal(after.lines.find(line => line.isBreakIn).quantity, 1);
  assert.deepEqual((await restore().getCart()).lines, after.lines);
});

test('adding service to one existing glove uses parent.lineId and Shopify subtotal', async () => {
  const { commerce, requests, restore } = shopifyFixture();
  await commerce.listProducts();
  const before = await commerce.addProduct('black', false);
  const parentId = before.lines[0].remoteLineId;
  const after = await commerce.addBreakIn(parentId);
  assert.equal(before.subtotal, 155);
  assert.equal(after.subtotal, 175);
  assert.equal(after.lines.find(line => line.isBreakIn).parentLineId, parentId);
  assert.deepEqual(requests.filter(item => item.query.includes('AddLines')).at(-1).variables.lines,
    [{ merchandiseId: 'gid://variant/service', quantity: 1, parent: { lineId: parentId } }]);
  assert.deepEqual((await restore().getCart()).lines, after.lines);
});

test('adding service to two existing gloves changes only one glove', async () => {
  const { commerce, requests } = shopifyFixture();
  await commerce.listProducts();
  const first = await commerce.addProduct('black', false);
  const parentId = first.lines[0].remoteLineId;
  const before = await commerce.setLineQuantity(parentId, 2);
  assert.equal(before.subtotal, 310);
  const after = await commerce.addBreakIn(parentId);
  assert.equal(after.subtotal, 330);
  assert.equal(after.lines.find(line => line.isBreakIn).quantity, 1);
  assert.deepEqual(requests.filter(item => item.query.includes('AddLines')).at(-1).variables.lines,
    [{ merchandiseId: 'gid://variant/service', quantity: 1,
      parent: { lineId: after.lines.find(line => line.serviceConfiguration === 'break-in').remoteLineId } }]);
});

test('adding service targets only the chosen unserviced BR16 parent', async () => {
  const { commerce, servicedId, unservicedId, requests } = await mixedCartFixture();
  const after = await commerce.addBreakIn(unservicedId);
  const children = after.lines.filter(line => line.isBreakIn);
  assert.equal(children.reduce((sum, line) => sum + line.quantity, 0), 2);
  assert.equal(after.lines.filter(line => !line.isBreakIn).reduce((sum, line) => sum + line.quantity, 0), 2);
  assert.equal(after.subtotal, 350);
  assert.ok(requests.some(item => item.query.includes('UpdateLines') &&
    item.variables.lines[0].id === unservicedId &&
    item.variables.lines[0].attributes[0].value === 'break-in'));
  assert.equal(after.lines.some(line => line.remoteLineId === servicedId || line.remoteLineId === unservicedId), true);
});

test('removing service targets only the chosen serviced BR16 parent', async () => {
  const { commerce, servicedId, unservicedId } = await mixedCartFixture();
  const after = await commerce.removeBreakIn(servicedId);
  assert.equal(after.subtotal, 310);
  assert.equal(after.lines.some(line => line.isBreakIn), false);
  assert.equal(after.lines.filter(line => !line.isBreakIn).reduce((sum, line) => sum + line.quantity, 0), 2);
  assert.equal(after.lines.some(line => line.remoteLineId === unservicedId), true);
});

test('service removal accepts Shopify merging equivalent unserviced parents', async () => {
  const { commerce, restore, servicedId } = await mixedCartFixture();
  const after = await commerce.removeBreakIn(servicedId);
  assert.equal(after.subtotal, 310);
  assert.equal(after.lines.filter(line => !line.isBreakIn).reduce((sum, line) => sum + line.quantity, 0), 2);
  assert.equal(after.lines.some(line => line.isBreakIn), false);
  assert.deepEqual((await restore().getCart()).lines, after.lines);
});

test('service addition accepts Shopify merging the selected parent into an equivalent serviced entry', async () => {
  const { commerce, restore, unservicedId } = await mixedCartFixture();
  const after = await commerce.addBreakIn(unservicedId);
  assert.equal(after.subtotal, 350);
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
  assert.equal(after.subtotal, 310);
  assert.equal(after.lines.filter(line => !line.isBreakIn).reduce((sum, line) => sum + line.quantity, 0), 2);
  assert.equal(after.lines.some(line => line.isBreakIn), false);
  assert.equal((await restore().getCart()).incomplete, false);
});

async function splitFixture(withService, quantity, options = {}) {
  const fixture = shopifyFixture(options);
  await fixture.commerce.listProducts();
  const first = await fixture.commerce.addProduct('black', withService);
  let cart = first;
  if (options.rekeyOnQuantityUpdate) {
    for (let count = 1; count < quantity; count++) cart = await fixture.commerce.addProduct('black', withService);
  } else if (quantity > 1) {
    cart = await fixture.commerce.setLineQuantity(first.lines.find(line => !line.isBreakIn).remoteLineId, quantity);
  }
  const parentId = cart.lines.find(line => !line.isBreakIn).remoteLineId;
  return { fixture, cart, parentId };
}

function assertServiceChildrenMatch(cart) {
  for (const parent of cart.lines.filter(line => !line.isBreakIn)) {
    const children = cart.lines.filter(line => line.isBreakIn && line.parentLineId === parent.remoteLineId);
    assert.equal(children.length, parent.serviceConfiguration === 'break-in' ? 1 : 0);
    if (children.length) assert.equal(children[0].quantity, parent.quantity);
  }
}

function gloveCount(cart) {
  return cart.lines.filter(line => !line.isBreakIn).reduce((sum, line) => sum + line.quantity, 0);
}

test('serviced quantity two splits into one serviced and one unserviced glove', async () => {
  const { fixture, cart: before, parentId } = await splitFixture(true, 2);
  const markerAtMutation = [];
  fixture.observeMutations(({ storage }) => markerAtMutation.push(storage.getItem('anawin-shopify-unsafe-cart-id')));
  const after = await fixture.commerce.removeBreakIn(parentId);
  assert.deepEqual(after.lines.filter(line => !line.isBreakIn).map(line => [line.serviceConfiguration, line.quantity]),
    [['break-in', 1], ['none', 1]]);
  assertServiceChildrenMatch(after);
  assert.equal(gloveCount(before), gloveCount(after));
  assert.equal(after.subtotal, 330);
  assert.equal(entryTotal(after, after.lines.find(line => line.serviceConfiguration === 'break-in').remoteLineId).amount, 175);
  assert.equal(entryTotal(after, after.lines.find(line => line.serviceConfiguration === 'none').remoteLineId).amount, 155);
  assert.ok(markerAtMutation.every(value => value === after.id));
  assert.equal(fixture.storage.getItem('anawin-shopify-unsafe-cart-id'), null);
  assert.equal((await fixture.restore().getCart()).incomplete, false);
});

test('unserviced quantity two splits into one unserviced and one serviced glove', async () => {
  const { fixture, cart: before, parentId } = await splitFixture(false, 2);
  const markerAtMutation = [];
  fixture.observeMutations(({ storage }) => markerAtMutation.push(storage.getItem('anawin-shopify-unsafe-cart-id')));
  const after = await fixture.commerce.addBreakIn(parentId);
  assert.deepEqual(after.lines.filter(line => !line.isBreakIn).map(line => [line.serviceConfiguration, line.quantity]),
    [['none', 1], ['break-in', 1]]);
  assertServiceChildrenMatch(after);
  assert.equal(gloveCount(before), gloveCount(after));
  assert.equal(after.subtotal, 330);
  assert.ok(markerAtMutation.every(value => value === after.id));
  assert.equal(fixture.storage.getItem('anawin-shopify-unsafe-cart-id'), null);
  assert.equal((await fixture.restore().getCart()).incomplete, false);
});

test('serviced quantity three removes service from exactly one glove', async () => {
  const { fixture, parentId } = await splitFixture(true, 3, { autoSyncChild: false });
  const after = await fixture.commerce.removeBreakIn(parentId);
  assert.equal(after.lines.find(line => line.serviceConfiguration === 'break-in').quantity, 2);
  assert.equal(after.lines.find(line => line.serviceConfiguration === 'none').quantity, 1);
  assertServiceChildrenMatch(after);
  assert.equal(gloveCount(after), 3);
  assert.equal(after.subtotal, 505);
});

test('split destination keeps source merchandise and non-service attributes', async () => {
  const { fixture, parentId } = await splitFixture(true, 2);
  const source = fixture.lines.find(line => line.id === parentId);
  source.attributes.push({ key: 'gift-note', value: 'practice' });
  const after = await fixture.commerce.removeBreakIn(parentId);
  const destination = after.lines.find(line => line.serviceConfiguration === 'none');
  assert.equal(destination.merchandiseId, after.lines.find(line => line.serviceConfiguration === 'break-in').merchandiseId);
  assert.deepEqual(destination.attributes, [{ key: 'gift-note', value: 'practice' }, { key: '_anawin_service', value: 'none' }]);
  assertServiceChildrenMatch(after);
});

test('adding service to one glove preserves its other source attributes', async () => {
  const { fixture, parentId } = await splitFixture(false, 2);
  fixture.lines.find(line => line.id === parentId).attributes.push({ key: 'gift-note', value: 'practice' });
  const after = await fixture.commerce.addBreakIn(parentId);
  const destination = after.lines.find(line => line.serviceConfiguration === 'break-in');
  assert.deepEqual(destination.attributes, [{ key: 'gift-note', value: 'practice' },
    { key: '_anawin_service', value: 'break-in' }]);
  assert.equal(destination.merchandiseId, after.lines.find(line => line.serviceConfiguration === 'none').merchandiseId);
  assertServiceChildrenMatch(after);
});

test('one serviced glove merges into an existing compatible unserviced line', async () => {
  const { fixture, parentId } = await splitFixture(true, 2);
  const mixed = await fixture.commerce.addProduct('black', false);
  const existing = mixed.lines.find(line => line.serviceConfiguration === 'none');
  const after = await fixture.commerce.removeBreakIn(parentId);
  assert.equal(after.lines.filter(line => line.serviceConfiguration === 'none').length, 1);
  assert.equal(after.lines.find(line => line.serviceConfiguration === 'none').remoteLineId, existing.remoteLineId);
  assert.equal(after.lines.find(line => line.serviceConfiguration === 'none').quantity, 2);
  assert.equal(after.lines.find(line => line.serviceConfiguration === 'break-in').quantity, 1);
  assertServiceChildrenMatch(after);
  assert.equal(gloveCount(after), 3);
  assert.equal(after.subtotal, 485);
});

test('one unserviced glove merges into an existing compatible serviced line', async () => {
  const { fixture, parentId } = await splitFixture(false, 2);
  const mixed = await fixture.commerce.addProduct('black', true);
  const existing = mixed.lines.find(line => line.serviceConfiguration === 'break-in');
  const after = await fixture.commerce.addBreakIn(parentId);
  assert.equal(after.lines.filter(line => line.serviceConfiguration === 'break-in').length, 1);
  assert.equal(after.lines.find(line => line.serviceConfiguration === 'break-in').remoteLineId, existing.remoteLineId);
  assert.equal(after.lines.find(line => line.serviceConfiguration === 'break-in').quantity, 2);
  assert.equal(after.lines.find(line => line.serviceConfiguration === 'none').quantity, 1);
  assertServiceChildrenMatch(after);
  assert.equal(gloveCount(after), 3);
  assert.equal(after.subtotal, 505);
});

for (const withService of [false, true]) {
  test(`split follows re-keyed line IDs when ${withService ? 'removing' : 'adding'} service`, async () => {
    const { fixture, parentId } = await splitFixture(withService, 2,
      { rekeyOnAdd: true, rekeyOnQuantityUpdate: true, autoSyncChild: false });
    const after = withService ? await fixture.commerce.removeBreakIn(parentId) : await fixture.commerce.addBreakIn(parentId);
    assert.equal(after.incomplete, false);
    assert.equal(gloveCount(after), 2);
    assertServiceChildrenMatch(after);
    assert.equal((await fixture.restore().getCart()).incomplete, false);
  });
}

for (const withService of [false, true]) {
  for (const boundary of [1, 2, 3]) {
    test(`split ${withService ? 'removal' : 'addition'} failure at mutation ${boundary} stays safe`, async () => {
      const { fixture, parentId } = await splitFixture(withService, 2, { autoSyncChild: false });
      fixture.failNextMutation(boundary);
      await assert.rejects(withService ? fixture.commerce.removeBreakIn(parentId) : fixture.commerce.addBreakIn(parentId),
        /Partial mutation failed/);
      const restored = await fixture.restore().getCart();
      assert.equal(restored.incomplete, boundary !== 1);
      if (boundary === 1) assertServiceChildrenMatch(restored);
      assert.equal(fixture.storage.getItem('anawin-shopify-unsafe-cart-id'), boundary === 1 ? null : restored.id);
    });
  }
}

for (const withService of [false, true]) {
  test(`uncertain split ${withService ? 'removal' : 'addition'} leaves checkout blocked after refresh`, async () => {
    const { fixture, parentId } = await splitFixture(withService, 2);
    fixture.failAfterNextMutation();
    await assert.rejects(withService ? fixture.commerce.removeBreakIn(parentId) : fixture.commerce.addBreakIn(parentId), /503/);
    assert.equal((await fixture.restore().getCart()).incomplete, true);
    assert.equal(fixture.storage.getItem('anawin-shopify-unsafe-cart-id'), 'gid://cart/1');
  });
}

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
  await assert.rejects(fixture.commerce.removeBreakIn(fixture.servicedId), /cart is incomplete/);
  const cart = await fixture.commerce.getCart();
  assert.equal(cart.incomplete, true);
  assert.equal(cart.subtotal, 330);
  assert.deepEqual(mixedQuantities(cart, fixture.servicedId, fixture.unservicedId), { serviced: 1, unserviced: 1, service: 1 });
});

test('Shopify user errors leave the cart intact', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  await fixture.commerce.addProduct('black', false);
  fixture.setUserError('Quantity unavailable');
  await assert.rejects(fixture.commerce.setQuantity('black', 2), /Quantity unavailable/);
  assert.equal((await fixture.commerce.getCart()).subtotal, 155);
});

const discountMoney = amount => ({ amount: String(amount), currencyCode: 'USD' });
const discountScenario = codes => {
  const launch = codes.some(code => code.toLowerCase() === 'launch10');
  const extra = codes.some(code => code.toLowerCase() === 'extra');
  const amount = (launch ? 15 : 0) + (extra ? 5 : 0);
  return {
    discountCodes: codes.map(code => ({ code, applicable: ['launch10', 'extra'].includes(code.toLowerCase()) })),
    discountApplications: codes.filter(code => ['launch10', 'extra'].includes(code.toLowerCase()))
      .map(code => ({ code, targetType: 'LINE_ITEM', value: { __typename: 'PricingPercentageValue', percentage: 10 } })),
    discountedPrices: { br16: String(155 - amount) },
    discountAllocations: amount ? { br16: codes.filter(code => ['launch10', 'extra'].includes(code.toLowerCase()))
      .map(code => ({ discountedAmount: discountMoney(code.toLowerCase() === 'extra' ? 5 : 15),
        targetType: 'LINE_ITEM', sourceDiscountApplication: { code } })) } : {}
  };
};

test('applying and removing a code use Shopify cart prices and preserve checkout URL', async () => {
  const fixture = shopifyFixture({ discountScenario });
  await fixture.commerce.listProducts();
  const before = await fixture.commerce.addProduct('black', false);
  const applied = await fixture.commerce.applyDiscountCode('  LAUNCH10  ');
  assert.equal(applied.discountCodes[0].applicable, true);
  assert.equal(applied.lines[0].lineTotal.amount, 140);
  assert.equal(applied.checkoutUrl, before.checkoutUrl);
  assert.deepEqual(fixture.requests.find(item => item.query.includes('UpdateDiscountCodes')).variables,
    { cartId: before.id, discountCodes: ['LAUNCH10'] });
  const restored = await fixture.commerce.removeDiscountCode('launch10');
  assert.deepEqual(restored.discountCodes, []);
  assert.equal(restored.lines[0].lineTotal.amount, 155);
  assert.equal(restored.checkoutUrl, before.checkoutUrl);
  assert.deepEqual(fixture.requests.filter(item => item.query.includes('UpdateDiscountCodes')).at(-1).variables,
    { cartId: before.id, discountCodes: [] });
});

test('non-applicable code is retained as non-applicable without altering Shopify prices', async () => {
  const fixture = shopifyFixture({ discountScenario });
  await fixture.commerce.listProducts();
  await fixture.commerce.addProduct('black', false);
  const cart = await fixture.commerce.applyDiscountCode('NOPE');
  assert.deepEqual(cart.discountCodes, [{ code: 'NOPE', applicable: false }]);
  assert.equal(cart.lines[0].lineTotal.amount, 155);
  assert.equal(cart.subtotal, 155);
  assert.equal((await fixture.commerce.removeDiscountCode('NOPE')).discountCodes.length, 0);
});

test('existing codes survive additions and removing one preserves the other', async () => {
  const fixture = shopifyFixture({ discountScenario });
  await fixture.commerce.listProducts();
  await fixture.commerce.addProduct('black', false);
  await fixture.commerce.applyDiscountCode('LAUNCH10');
  const two = await fixture.commerce.applyDiscountCode('EXTRA');
  assert.deepEqual(two.discountCodes.map(item => item.code), ['LAUNCH10', 'EXTRA']);
  assert.equal(two.lines[0].lineTotal.amount, 135);
  const one = await fixture.commerce.removeDiscountCode('launch10');
  assert.deepEqual(one.discountCodes.map(item => item.code), ['EXTRA']);
  assert.equal(one.lines[0].lineTotal.amount, 150);
  const mutationVariables = fixture.requests.filter(item => item.query.includes('UpdateDiscountCodes')).map(item => item.variables.discountCodes);
  assert.deepEqual(mutationVariables, [['LAUNCH10'], ['LAUNCH10', 'EXTRA'], ['EXTRA']]);
});

test('duplicate codes are ignored regardless of case or surrounding spaces', async () => {
  const fixture = shopifyFixture({ discountScenario });
  await fixture.commerce.listProducts();
  await fixture.commerce.addProduct('black', false);
  await fixture.commerce.applyDiscountCode('LAUNCH10');
  const duplicate = await fixture.commerce.applyDiscountCode('  launch10 ');
  assert.equal(duplicate.discountCodes.length, 1);
  assert.equal(fixture.requests.filter(item => item.query.includes('UpdateDiscountCodes')).length, 1);
});

test('discount user errors and API failures are surfaced without invented savings', async () => {
  const fixture = shopifyFixture({ discountScenario });
  await fixture.commerce.listProducts();
  await fixture.commerce.addProduct('black', false);
  fixture.setUserError('Discount unavailable');
  await assert.rejects(fixture.commerce.applyDiscountCode('LAUNCH10'), /Discount unavailable/);
  fixture.setUserError('');
  fixture.setApiError(true);
  await assert.rejects(fixture.commerce.applyDiscountCode('LAUNCH10'), /503/);
  fixture.setApiError(false);
  const cart = await fixture.commerce.getCart();
  assert.equal(cart.subtotal, 155);
  assert.deepEqual(cart.discountCodes, []);
});

test('Shopify discount warnings remain available alongside the returned cart', async () => {
  const fixture = shopifyFixture({ discountScenario,
    discountWarnings: [{ code: 'DISCOUNT_CODE_NOT_HONOURED', message: 'Some discounts were not honored.' }] });
  await fixture.commerce.listProducts();
  await fixture.commerce.addProduct('black', false);
  const cart = await fixture.commerce.applyDiscountCode('NOPE');
  assert.equal(cart.discountCodes[0].applicable, false);
  assert.deepEqual(cart.discountWarnings, ['Some discounts were not honored.']);
});
