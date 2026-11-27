import test from 'node:test';
import assert from 'node:assert/strict';
import { shopifyFixture } from '../test-support/shopify-fixture.js';
import { createShopifyCommerce } from '../src/commerce.js';
import { FULL_SIZE_CONFIGURATION_KEY, PREORDER_CHECKOUT, fullSizeProducts, preorderState } from '../src/catalog.js';

const ESTIMATE = 'first week of December 2026';
const options = { type: 'full-size', wearingStyle: 'Traditional — index finger out', closure: 'Ring finger', thumbShape: 'Straight', pinkyShape: 'Flared', fingerShape: 'Rolled', firmness: 'Medium', notes: '' };
const mint = fullSizeProducts.find(product => product.id === 'full-mint');

// Each test file runs in its own process; the catalog entry is restored after every test.
async function withMintPreorder(config, run) {
  const original = { comingSoon: mint.comingSoon, preorder: mint.preorder };
  if (config) Object.assign(mint, { comingSoon: false, preorder: config });
  try { return await run(); } finally { Object.assign(mint, original); }
}

// The shared fixture without its launch metafields, answering only the custom.preorder_ship_estimate given here.
function commerceWithMetafield(metafields = {}) {
  const fixture = shopifyFixture({ fullSize: true, metafields: {} });
  const fetchImpl = async (url, init) => {
    const response = await fixture.fetchImpl(url, init);
    const { query, variables } = JSON.parse(init.body);
    if (!query.includes('ProductByHandle') || !response.ok) return response;
    const payload = await response.json();
    if (payload.data.product && Object.hasOwn(metafields, variables.handle)) {
      payload.data.product.preorderShipEstimate = metafields[variables.handle] === null ? null : { value: metafields[variables.handle] };
    }
    return { ok: true, json: async () => payload };
  };
  return { fixture, commerce: createShopifyCommerce(fixture.config, fixture.storage, fetchImpl, fixture.locks) };
}

test('the product query optionally reads custom.preorder_ship_estimate', async () => {
  const { fixture, commerce } = commerceWithMetafield({ mi26: ESTIMATE, bl50: null });
  const products = await commerce.listProducts();
  const query = fixture.requests.find(request => request.query.includes('ProductByHandle')).query;
  assert.match(query, /preorderShipEstimate: metafield\(namespace: "custom", key: "preorder_ship_estimate"\) \{ value \}/);
  const byId = Object.fromEntries(products.map(product => [product.id, product]));
  assert.equal(byId['full-mint'].shopifyPreorderShipEstimate, ESTIMATE);
  assert.equal(byId['full-black'].shopifyPreorderShipEstimate, null, 'unset or unexposed metafield');
  assert.equal(byId['full-orange'].shopifyPreorderShipEstimate, null, 'field absent from the response');
  assert.equal(Object.hasOwn(byId.black, 'shopifyPreorderShipEstimate'), false, 'trainers are unchanged');
  // Production catalog: no launched preorder sells unless Shopify returns its exact estimate.
  for (const product of products) assert.equal(preorderState(product).status, product.line === 'full-size' ? 'blocked' : 'inactive', product.id);
  assert.equal(PREORDER_CHECKOUT.chargedInFullAtCheckout, true);
});

test('a confirmed preorder adds to the cart with exactly the same glove line attributes', async () => {
  const baseline = await (async () => {
    const { commerce } = shopifyFixture({ fullSize: true });
    await commerce.listProducts(); await commerce.getFullSizeBreakInService();
    return commerce.addProduct('full-mint', true, options, 'gid://variant/mi26-right');
  })();
  await withMintPreorder({ enabled: true, shipEstimate: ESTIMATE }, async () => {
    for (const metafield of [ESTIMATE, `  ${ESTIMATE}  `]) {
      const { commerce } = commerceWithMetafield({ mi26: metafield });
      const products = await commerce.listProducts(); await commerce.getFullSizeBreakInService();
      assert.deepEqual(preorderState(products.find(product => product.id === 'full-mint')), { status: 'active', estimate: ESTIMATE });
      const cart = await commerce.addProduct('full-mint', true, options, 'gid://variant/mi26-right');
      assert.equal(cart.incomplete, false);
      const parent = cart.lines.find(line => line.productId === 'full-mint' && !line.isBreakIn);
      const before = baseline.lines.find(line => line.productId === 'full-mint' && !line.isBreakIn);
      assert.deepEqual(parent.attributes, before.attributes, 'the _anawin_configuration fingerprint is unchanged');
      assert.ok(parent.attributes.some(attribute => attribute.key === FULL_SIZE_CONFIGURATION_KEY));
      assert.ok(!cart.lines.flatMap(line => line.attributes).some(attribute => /preorder|ship/i.test(`${attribute.key} ${attribute.value}`)));
    }
  });
});

test('a mismatched, missing or unavailable preorder is never added to a cart', async () => {
  for (const [config, metafields, reason] of [
    [{ enabled: true, shipEstimate: ESTIMATE }, { mi26: 'mid-December 2026' }, 'estimate-mismatch'],
    [{ enabled: true, shipEstimate: null }, {}, 'missing-estimate'],
    [{ enabled: true, shipEstimate: ESTIMATE }, {}, 'missing-shopify-estimate'],
    [{ enabled: true, shipEstimate: ESTIMATE }, { mi26: null }, 'missing-shopify-estimate'],
    [{ enabled: false, shipEstimate: null }, { mi26: ESTIMATE }, 'not-enabled']
  ]) {
    await withMintPreorder(config, async () => {
      const { fixture, commerce } = commerceWithMetafield(metafields);
      const products = await commerce.listProducts();
      assert.deepEqual(preorderState(products.find(product => product.id === 'full-mint')), { status: 'blocked', reason });
      await assert.rejects(commerce.addProduct('full-mint', false, undefined, 'gid://variant/mi26-right'), /not currently available for preorder/);
      assert.ok(!fixture.requests.some(request => /mutation/.test(request.query)), `${reason}: no cart mutation`);
      // Other gloves are unaffected.
      const cart = await commerce.addProduct('blue', false);
      assert.equal(cart.lines.length, 1);
    });
  }
});
