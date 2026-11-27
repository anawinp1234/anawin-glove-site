import test from 'node:test';
import assert from 'node:assert/strict';
import { selectCommerceProfile } from '../src/commerce-profile.js';
import { releasedCommerceProfiles } from '../src/released-commerce-profiles.js';
import { testCommerceProfile } from '../scripts/test-store/commerce-profile.mjs';
import { checkoutCartIsComplete, redirectToVerifiedCheckout, verifiedCheckoutUrl } from '../src/checkout-safety.js';
import { createShopifyCommerce, validateShopifyConfig } from '../src/commerce.js';
import { shopifyFixture } from '../test-support/shopify-fixture.js';
import { FULL_SIZE_SERVICE_HANDLE, PREORDER_ORDER_ATTRIBUTE } from '../src/catalog.js';

const production = releasedCommerceProfiles[0];
const testStore = testCommerceProfile;
const options = { type: 'full-size', wearingStyle: 'Traditional — index finger out', closure: 'Ring finger',
  thumbShape: 'Straight', pinkyShape: 'Flared', fingerShape: 'Rolled', firmness: 'Medium' };
const add = commerce => commerce.addProduct('full-mint', true, options, 'gid://variant/mi26-right');
const mutations = fixture => fixture.requests.filter(({ query }) => query.includes('mutation'));
const checkoutUrl = profile => `https://${profile.checkoutHost}/checkouts/example?key=synthetic`;

test('the production and isolated test configuration each select exactly their own pinned profile', () => {
  for (const [profile, other] of [[production, testStore], [testStore, production]]) {
    const env = { VITE_COMMERCE_MODE: 'shopify', VITE_SHOPIFY_STORE_DOMAIN: `https://${profile.storeDomain}/`,
      VITE_SHOPIFY_STOREFRONT_TOKEN: 'synthetic-public-token', VITE_SHOPIFY_BR16_HANDLE: 'br16',
      VITE_SHOPIFY_OB16_HANDLE: 'ob16', VITE_SHOPIFY_CL16_HANDLE: 'cl16' };
    assert.deepEqual(validateShopifyConfig(env, [profile]).profile, profile);
    assert.throws(() => validateShopifyConfig(env, [other]), /exactly one/);
    assert.throws(() => validateShopifyConfig({ ...env, VITE_SHOPIFY_STORE_DOMAIN: profile.storeDomain.toUpperCase() }, [profile]), /Invalid.*domain/);
  }
});

test('configuration rejects missing, unknown, malformed, duplicate and inconsistent profiles before making requests', () => {
  for (const [domain, profiles] of [
    [undefined, [production]], ['unrelated.myshopify.com', [production]], [production.storeDomain, undefined],
    [production.storeDomain, []], [production.storeDomain, [production, production]],
    [`nested.${production.storeDomain}`, [production]], [`${production.storeDomain}:443`, [production]],
    [production.storeDomain, [{ ...production, checkoutHost: '*.myshopify.com' }]],
    [production.storeDomain, [{ ...production, fullSizeService: undefined }]],
    [production.storeDomain, [{ ...production, fullSizeService: { ...production.fullSizeService, productId: 'gid://shopify/ProductVariant/1' } }]],
    [production.storeDomain, [{ ...production, fullSizeService: { ...production.fullSizeService, variantId: 'gid://shopify/Product/1' } }]],
    [production.storeDomain, [{ ...production, accessToken: 'not-a-profile-field' }]]
  ]) assert.throws(() => selectCommerceProfile(domain, profiles), /domain|profile/);
  const fixture = shopifyFixture({ profile: production });
  for (const profile of [undefined, testStore, { ...production, checkoutHost: 'https://evil.example' }]) {
    assert.throws(() => createShopifyCommerce({ ...fixture.config, profile }, fixture.storage, fixture.fetchImpl, fixture.locks));
  }
  assert.deepEqual(fixture.requests, []);
});

for (const [label, profile, other] of [['production', production, testStore], ['test', testStore, production]]) {
  test(`${label} checkout URL policy rejects cross-profile and spoofed destinations without navigation`, () => {
    const host = profile.checkoutHost;
    const accepted = checkoutUrl(profile);
    const normalized = `https://${host.toUpperCase()}:443/checkouts/example`;
    assert.equal(verifiedCheckoutUrl(accepted, host), accepted);
    assert.equal(verifiedCheckoutUrl(normalized, host), normalized);
    for (const rejected of [checkoutUrl(other), 'https://unrelated.myshopify.com/checkout', 'https://evil.example/checkout',
      `https://${host}.evil.example/checkout`, `https://sub.${host}/checkout`, `https://user:pass@${host}/checkout`,
      `https://@${host}/checkout`, `http://${host}/checkout`, `https://${host}:8443/checkout`,
      `https://${host}\\@evil.example/checkout`, ` https://${host}/checkout`, `//${host}/checkout`, 'not a URL', '', null, undefined]) {
      assert.equal(verifiedCheckoutUrl(rejected, host), null, String(rejected));
      assert.equal(redirectToVerifiedCheckout(rejected, () => assert.fail('unexpected navigation'), host), false);
    }
    assert.equal(verifiedCheckoutUrl(accepted), null);
  });

  test(`${label} adapter validates checkout on reads, handoff, and recovery under its own profile`, async () => {
    const fixture = shopifyFixture({ profile });
    await fixture.commerce.listProducts();
    const displayed = await fixture.commerce.addProduct('black', false);
    assert.ok(fixture.commerce.isCheckoutComplete(displayed));
    const rewritten = (change, config = fixture.config) => createShopifyCommerce(config, fixture.storage, async (url, request) => {
      const response = await fixture.fetchImpl(url, request);
      const body = await response.json();
      change(body.data);
      return { ...response, json: async () => body };
    }, fixture.locks);
    const rejected = rewritten(data => { if (data.cart) data.cart.checkoutUrl = checkoutUrl(other); });
    const before = mutations(fixture).length;
    await assert.rejects(rejected.getCart(), { code: 'checkout-url-invalid' });
    assert.equal((await rejected.checkout(displayed, {}, () => assert.fail('unexpected navigation'))).status, 'blocked');
    assert.equal(mutations(fixture).length, before);
    const destinations = [];
    assert.equal((await fixture.commerce.checkout(displayed, {}, url => destinations.push(url))).status, 'navigating');
    assert.deepEqual(destinations, [displayed.checkoutUrl]);
    const beforeRecovery = mutations(fixture).length;
    await assert.rejects(rejected.recoverCart());
    assert.equal(mutations(fixture).length, beforeRecovery);
    const invalidCandidate = rewritten(data => {
      if (data.cartCreate?.cart) data.cartCreate.cart.checkoutUrl = checkoutUrl(other);
      if (data.cart && data.cart.id !== displayed.id) data.cart.checkoutUrl = checkoutUrl(other);
    });
    await assert.rejects(invalidCandidate.recoverCart());
    assert.equal(fixture.storage.getItem('anawin-shopify-cart-id'), displayed.id);
    assert.equal(mutations(fixture).length, beforeRecovery + 1, 'only the explicitly requested recovery create');
  });

  test(`${label} final checkout blocks a foreign destination after the authorized preorder update`, async () => {
    const fixture = shopifyFixture({ profile });
    await fixture.commerce.listProducts();
    await fixture.commerce.addProduct('black', false);
    fixture.setCartAttributes([{ key: PREORDER_ORDER_ATTRIBUTE, value: 'old preorder details' }]);
    const displayed = await fixture.commerce.getCart();
    let updated = false;
    let readsAfterUpdate = 0;
    const checkout = createShopifyCommerce(fixture.config, fixture.storage, async (url, request) => {
      const response = await fixture.fetchImpl(url, request);
      const body = await response.json();
      if (body.data.cartAttributesUpdate) updated = true;
      if (body.data.cart && updated && ++readsAfterUpdate > 1) body.data.cart.checkoutUrl = checkoutUrl(other);
      return { ...response, json: async () => body };
    }, fixture.locks);
    const before = mutations(fixture).length;
    const result = await checkout.checkout(displayed, {}, () => assert.fail('unexpected navigation'));
    assert.equal(result.status, 'blocked');
    assert.match(result.message, /secure checkout/);
    assert.ok(readsAfterUpdate >= 2);
    assert.equal(mutations(fixture).length, before + 1);
    assert.equal(checkout.readCartSafety().unsafeId, null);
  });

  test(`${label} Full-size Break-In is paired and remains eligible after quantity, split edit and recovery`, async () => {
    const fixture = shopifyFixture({ profile, fullSize: true, autoSyncChild: false });
    const { commerce } = fixture;
    await commerce.listProducts();
    assert.equal((await commerce.getFullSizeBreakInService()).merchandiseId, profile.fullSizeService.variantId);
    const added = await add(commerce);
    const glove = added.lines.find(line => !line.isBreakIn);
    const quantity = await commerce.setLineQuantity(glove.remoteLineId, 2);
    assert.equal(quantity.lines.find(line => line.isBreakIn).quantity, 2);
    const edited = await commerce.editBreakIn(glove.remoteLineId, { ...options, firmness: 'Firm' });
    assert.equal(edited.lines.filter(line => line.isBreakIn).length, 2);
    assert.equal((await commerce.checkout(edited, {}, () => {})).status, 'navigating');
    const recovered = await fixture.restore().recoverCart();
    assert.notEqual(recovered.id, edited.id);
    assert.ok(commerce.isCheckoutComplete(recovered));
    assert.equal(recovered.lines.length, 4);
    for (const child of recovered.lines.filter(line => line.isBreakIn)) {
      assert.equal(child.merchandiseId, profile.fullSizeService.variantId);
      assert.equal(child.serviceProductId, profile.fullSizeService.productId);
      const parent = recovered.lines.find(line => line.remoteLineId === child.parentLineId);
      assert.equal(parent.quantity, child.quantity);
    }
    assert.equal(checkoutCartIsComplete(recovered, undefined), false);
  });

  test(`${label} Full-size Break-In refuses mismatched catalog identity, price, currency and availability`, async () => {
    for (const alter of [
      service => { service.id = other.fullSizeService.productId; },
      service => { service.variants.nodes[0].id = other.fullSizeService.variantId; },
      service => { service.id = other.fullSizeService.productId; service.variants.nodes[0].id = other.fullSizeService.variantId; },
      service => { service.variants.nodes[0].price.amount = '74.99'; },
      service => { service.variants.nodes[0].price.currencyCode = 'CAD'; },
      service => { service.variants.nodes[0].availableForSale = false; }
    ]) {
      const fixture = shopifyFixture({ profile, fullSize: true });
      const commerce = createShopifyCommerce(fixture.config, fixture.storage, async (url, request) => {
        const response = await fixture.fetchImpl(url, request);
        const body = await response.json();
        if (body.data.product?.handle === FULL_SIZE_SERVICE_HANDLE) alter(body.data.product);
        return { ...response, json: async () => body };
      }, fixture.locks);
      await commerce.listProducts();
      assert.equal((await commerce.getFullSizeBreakInService()).available, false);
      await assert.rejects(add(commerce), /not currently available/);
      assert.equal(mutations(fixture).length, 0);
    }
  });

  test(`${label} cart reads reject a foreign Full-size Break-In product, variant, or relationship`, async () => {
    const fixture = shopifyFixture({ profile, fullSize: true });
    await fixture.commerce.listProducts();
    const cart = await add(fixture.commerce);
    const service = fixture.lines.find(line => line.parentRelationship);
    const correct = structuredClone(service.merchandise);
    for (const alter of [
      merchandise => { merchandise.product.id = other.fullSizeService.productId; },
      merchandise => { merchandise.id = other.fullSizeService.variantId; },
      merchandise => { merchandise.id = other.fullSizeService.variantId; merchandise.product.id = other.fullSizeService.productId; },
      merchandise => { delete merchandise.product.id; }
    ]) {
      service.merchandise = structuredClone(correct);
      alter(service.merchandise);
      const before = mutations(fixture).length;
      await assert.rejects(fixture.commerce.getCart(), { code: 'cart-unverified' });
      assert.equal((await fixture.commerce.checkout(cart, {}, () => assert.fail('unexpected navigation'))).status, 'blocked');
      const mismatched = structuredClone(cart);
      mismatched.lines.find(line => line.isBreakIn).serviceProductId = service.merchandise.product.id;
      mismatched.lines.find(line => line.isBreakIn).merchandiseId = service.merchandise.id;
      assert.equal(fixture.commerce.isCheckoutComplete(mismatched), false);
      assert.equal(mutations(fixture).length, before);
    }
  });
}
