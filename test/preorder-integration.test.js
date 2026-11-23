// Cross-agent integration: preorder state, the order-level estimate snapshot, discounts, quantities,
// cart recovery and existing trainer purchase paths, all against the mocked Shopify fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import { shopifyFixture } from '../test-support/shopify-fixture.js';
import {
  FULL_SIZE_CONFIGURATION_KEY, PREORDER_CHECKOUT, PREORDER_ORDER_ATTRIBUTE, fullSizeProducts, preorderOrderAttributeValue, preorderState
} from '../src/catalog.js';
import { checkoutCartIsComplete } from '../src/checkout-safety.js';
import { cartDiscountSummary } from '../src/cart-discounts.js';

const ESTIMATE = 'first week of December 2026';
const options = { type: 'full-size', wearingStyle: 'Traditional — index finger out', closure: 'Ring finger', thumbShape: 'Straight',
  pinkyShape: 'Flared', fingerShape: 'Rolled', firmness: 'Medium', notes: '' };
const firm = { ...options, firmness: 'Firm', notes: 'shallow pocket' };
const TRAINER_BREAK_IN = { level: 'Game Ready (90%)', wearingStyle: 'Traditional' };
const byId = id => fullSizeProducts.find(product => product.id === id);

async function withPreorders(ids, run) {
  const saved = ids.map(id => [byId(id), { comingSoon: byId(id).comingSoon, preorder: byId(id).preorder }]);
  for (const [product] of saved) Object.assign(product, { comingSoon: false, preorder: { enabled: true, shipEstimate: ESTIMATE } });
  try { return await run(); } finally { for (const [product, original] of saved) Object.assign(product, original); }
}
async function fixture(config = {}) {
  const f = shopifyFixture({ fullSize: true, checkoutHost: 'ignvv0-zh.myshopify.com', metafields: { mi26: ESTIMATE, bl50: ESTIMATE }, ...config });
  await f.commerce.listProducts();
  return f;
}
const mutations = (f, name) => f.requests.filter(request => request.query.includes(name));
const attribute = cart => (cart.attributes || []).find(item => item.key === PREORDER_ORDER_ATTRIBUTE)?.value ?? null;
const gloveAttributes = cart => cart.lines.filter(line => !line.isBreakIn).map(line => JSON.stringify([...line.attributes].sort((a, b) => a.key.localeCompare(b.key))));
const checkout = async f => {
  const urls = [];
  const result = await f.commerce.checkout(await f.commerce.getCart(), {}, url => urls.push(url));
  return { result, urls };
};

test('mixed trainer and preorder cart: one order snapshot, unchanged line identity and service pairing', async () => {
  const baseline = await (async () => {
    // The shipped launch catalog with Shopify's matching estimates.
    const f = await fixture({ metafields: undefined });
    await f.commerce.addProduct('black', true, TRAINER_BREAK_IN);
    await f.commerce.addProduct('full-mint', true, options, 'gid://variant/mi26-right', 'tightened');
    await f.commerce.addProduct('full-mint', true, firm, 'gid://variant/mi26-left');
    return gloveAttributes(await f.commerce.addProduct('full-black', false, undefined, 'gid://variant/bl50-right'));
  })();
  await withPreorders(['full-mint', 'full-black'], async () => {
    const f = await fixture();
    for (const id of ['full-mint', 'full-black']) assert.equal(preorderState(byId(id)).reason, 'missing-shopify-estimate', 'catalog entries alone are not Shopify-confirmed');
    await f.commerce.addProduct('black', true, TRAINER_BREAK_IN);
    await f.commerce.addProduct('full-mint', true, options, 'gid://variant/mi26-right', 'tightened');
    await f.commerce.addProduct('full-mint', true, firm, 'gid://variant/mi26-left');
    const cart = await f.commerce.addProduct('full-black', false, undefined, 'gid://variant/bl50-right');
    assert.deepEqual(gloveAttributes(cart), baseline, 'glove attributes, wrist fit and fingerprints match a non-preorder cart');
    assert.ok(cart.lines.filter(line => line.productId === 'full-mint' && !line.isBreakIn).every(line => line.attributes.some(item => item.key === FULL_SIZE_CONFIGURATION_KEY)));
    assert.ok(checkoutCartIsComplete(cart));
    assert.equal(attribute(cart), null, 'nothing is written before checkout');

    const { result, urls } = await checkout(f);
    assert.equal(result.status, 'navigating');
    assert.equal(urls.length, 1);
    assert.deepEqual(f.cartAttributes, [{ key: PREORDER_ORDER_ATTRIBUTE, value: `BL-50: ${ESTIMATE}; MI-26: ${ESTIMATE}` }]);
    const after = await f.restore().getCart();
    assert.deepEqual(gloveAttributes(after), baseline, 'the attribute write leaves every line untouched');
    assert.equal(after.lines.filter(line => line.isBreakIn).length, 3);
    for (const service of after.lines.filter(line => line.isBreakIn)) {
      const parent = after.lines.find(line => line.remoteLineId === service.parentLineId);
      assert.equal(parent.quantity, service.quantity);
    }
  });
});

test('multiple quantities keep services paired and the snapshot stays one entry per model', async () => {
  await withPreorders(['full-mint'], async () => {
    const f = await fixture();
    let cart = await f.commerce.addProduct('full-mint', true, options, 'gid://variant/mi26-right');
    const glove = cart.lines.find(line => !line.isBreakIn);
    cart = await f.commerce.setLineQuantity(glove.remoteLineId, 3);
    assert.deepEqual(cart.lines.map(line => line.quantity), [3, 3]);
    cart = await f.commerce.setLineQuantity(cart.lines.find(line => !line.isBreakIn).remoteLineId, 2);
    assert.ok(checkoutCartIsComplete(cart));
    assert.equal(preorderOrderAttributeValue(cart.lines, id => byId(id)), '', 'raw catalog entries lack Shopify confirmation');
    assert.equal((await checkout(f)).result.status, 'navigating');
    assert.deepEqual(f.cartAttributes, [{ key: PREORDER_ORDER_ATTRIBUTE, value: `MI-26: ${ESTIMATE}` }]);
  });
});

test('PREORDER30 and WRECKER100 together survive the snapshot write and checkout', async () => {
  await withPreorders(['full-mint'], async () => {
    let f;
    const scenario = codes => {
      const keys = codes.map(code => code.toLowerCase());
      const gloves = (f?.lines || []).filter(line => line.merchandise.product.handle === 'mi26').reduce((sum, line) => sum + line.quantity, 0);
      const allocation = (amount, code) => ({ discountedAmount: { amount: String(amount), currencyCode: 'USD' }, targetType: 'LINE_ITEM', sourceDiscountApplication: { code } });
      const state = { discountCodes: codes.map(code => ({ code, applicable: true })), discountAllocations: {}, discountedPrices: {} };
      if (keys.includes('preorder30')) { state.discountAllocations.mi26 = [allocation(30 * gloves, 'PREORDER30')]; state.discountedPrices.mi26 = '265.00'; }
      if (keys.includes('wrecker100')) { state.discountAllocations['full-size-glove-break-in-service'] = [allocation(75, 'WRECKER100')]; state.discountedPrices['full-size-glove-break-in-service'] = String((75 * gloves - 75) / gloves); }
      return state;
    };
    f = await fixture({ discountScenario: scenario });
    // One entry at quantity 2 (2 gloves + 2 services): the mock allocates per handle, as one Shopify line would.
    const added = await f.commerce.addProduct('full-mint', true, options, 'gid://variant/mi26-right');
    await f.commerce.setLineQuantity(added.lines.find(line => !line.isBreakIn).remoteLineId, 2);
    await f.commerce.applyDiscountCode('PREORDER30');
    const cart = await f.commerce.applyDiscountCode('WRECKER100');
    assert.deepEqual(cart.discountCodes.map(item => item.code), ['PREORDER30', 'WRECKER100']);
    const summary = cartDiscountSummary(cart);
    assert.deepEqual(summary.discounts.map(item => [item.code, item.amount.amount]), [['PREORDER30', 60], ['WRECKER100', 75]]);
    assert.equal((await checkout(f)).result.status, 'navigating');
    const after = await f.restore().getCart();
    assert.deepEqual(after.discountCodes.map(item => item.code), ['PREORDER30', 'WRECKER100'], 'codes are kept');
    assert.equal(attribute(after), `MI-26: ${ESTIMATE}`);
    assert.equal(after.incomplete, true, 'the handed-off cart stays frozen for checkout (existing behavior)');
    assert.deepEqual(after.lines.map(line => [line.isBreakIn, line.quantity]), [[false, 2], [true, 2]], 'pairing and quantities unchanged');
  });
});

for (const mode of ['replace', 'merge']) {
  test(`a stale snapshot is cleared (${mode} semantics) and unrelated cart attributes are kept`, async () => {
    await withPreorders(['full-mint'], async () => {
      const f = await fixture({ cartAttributesMode: mode });
      await f.commerce.addProduct('black', false);
      f.setCartAttributes([{ key: 'gift-note', value: 'Happy birthday' }, { key: PREORDER_ORDER_ATTRIBUTE, value: `MI-26: ${ESTIMATE}` }]);
      assert.equal((await checkout(f)).result.status, 'navigating');
      const left = f.cartAttributes.find(item => item.key === PREORDER_ORDER_ATTRIBUTE);
      assert.ok(!left || left.value === '', 'no preorder claim remains on a trainer-only order');
      assert.ok(f.cartAttributes.some(item => item.key === 'gift-note' && item.value === 'Happy birthday'));
      assert.equal(mutations(f, 'UpdateCartAttributes').length, mode === 'merge' ? 2 : 1);
    });
  });
}

test('existing trainer purchases make no extra Shopify read or attribute write at checkout', async () => {
  const f = await fixture();
  await f.commerce.addProduct('black', true, TRAINER_BREAK_IN);
  const cart = await f.commerce.addProduct('blue', false, undefined, null, 'tightened');
  const before = f.requests.length;
  const urls = [];
  assert.equal((await f.commerce.checkout(cart, {}, url => urls.push(url))).status, 'navigating');
  assert.equal(mutations(f, 'UpdateCartAttributes').length, 0);
  assert.equal(f.requests.length - before, 1, 'only the existing verification read');
  assert.equal(urls.length, 1);
});

test('a preorder that stops being confirmed blocks checkout without writing anything', async () => {
  await withPreorders(['full-mint'], async () => {
    const f = await fixture();
    const cart = await f.commerce.addProduct('full-mint', false, undefined, 'gid://variant/mi26-right');
    byId('full-mint').preorder = { enabled: true, shipEstimate: 'mid-January 2027' };
    // A reload (new release or tab) now sees a catalog estimate that no longer matches Shopify's metafield.
    const restored = f.restore(); await restored.listProducts();
    const urls = [];
    const result = await restored.checkout(cart, {}, url => urls.push(url));
    assert.equal(result.status, 'blocked');
    assert.match(result.message, /preorder glove in your cart isn’t available/);
    assert.equal(urls.length, 0);
    assert.equal(mutations(f, 'UpdateCartAttributes').length, 0);
  });
});

test('a failed or uncertain snapshot write blocks checkout, then the cart recovers and checks out', async () => {
  await withPreorders(['full-mint'], async () => {
    const f = await fixture();
    await f.commerce.addProduct('full-mint', true, options, 'gid://variant/mi26-right');
    f.failAfterNextMutation();
    const { result, urls } = await checkout(f);
    assert.equal(result.status, 'blocked');
    assert.match(result.message, /preorder details/);
    assert.equal(urls.length, 0);
    assert.equal((await f.commerce.getCart()).incomplete, true, 'an uncertain write freezes the cart for recovery');
    const recovered = await f.restore().recoverCart();
    assert.equal(recovered.incomplete, false);
    assert.equal(recovered.lines.filter(line => !line.isBreakIn).length, 1);
    assert.ok(checkoutCartIsComplete(recovered));
    const restored = f.restore(); await restored.listProducts();
    const urls2 = [];
    assert.equal((await restored.checkout(await restored.getCart(), {}, url => urls2.push(url))).status, 'navigating');
    assert.equal(attribute(await restored.getCart()), `MI-26: ${ESTIMATE}`);
  });
});

test('cart reload restores preorder lines and the snapshot is rewritten from current Shopify data', async () => {
  await withPreorders(['full-mint'], async () => {
    const f = await fixture();
    await f.commerce.addProduct('full-mint', true, options, 'gid://variant/mi26-right', 'tightened');
    const reloaded = f.restore(); await reloaded.listProducts(); await reloaded.getFullSizeBreakInService();
    const cart = await reloaded.getCart();
    assert.equal(cart.lines.length, 2);
    assert.ok(checkoutCartIsComplete(cart));
    assert.equal((await reloaded.checkout(cart, {}, () => {})).status, 'navigating');
    assert.equal(attribute(await reloaded.getCart()), `MI-26: ${ESTIMATE}`);
  });
});

test('with payment unconfirmed, a fully configured preorder still cannot be added or checked out', async () => {
  await withPreorders(['full-mint'], async () => {
    PREORDER_CHECKOUT.chargedInFullAtCheckout = false;
    try {
      const f = await fixture();
      await assert.rejects(f.commerce.addProduct('full-mint', false, undefined, 'gid://variant/mi26-right'), /not currently available for preorder/);
      assert.equal(f.requests.filter(request => /mutation/.test(request.query)).length, 0);
      const trainer = await f.commerce.addProduct('black', false);
      assert.equal((await f.commerce.checkout(trainer, {}, () => {})).status, 'navigating', 'trainers are unaffected');
    } finally { PREORDER_CHECKOUT.chargedInFullAtCheckout = true; }
  });
});
