import test from 'node:test';
import assert from 'node:assert/strict';
import { createCheckoutVerifier, redirectToVerifiedCheckout, verifiedCheckoutUrl } from '../src/checkout-safety.js';

const approved = 'https://ignvv0-zh.myshopify.com/checkouts/cn/token?key=a%2Fb&discount=SAVE%2020';

test('only the verified Shopify checkout origin is accepted', () => {
  assert.equal(verifiedCheckoutUrl(approved), approved);
  assert.equal(verifiedCheckoutUrl('https://IGNVV0-ZH.MYSHOPIFY.COM:443/checkouts/cn/token'),
    'https://IGNVV0-ZH.MYSHOPIFY.COM:443/checkouts/cn/token');
  for (const value of [
    'https://evil.example/checkouts/cn/token',
    'http://ignvv0-zh.myshopify.com/checkouts/cn/token',
    'https://ignvv0-zh.myshopify.com.evil.example/checkouts/cn/token',
    'https://checkout.ignvv0-zh.myshopify.com/checkouts/cn/token',
    'https://ignvv0-zh-myshopify.com/checkouts/cn/token',
    'https://user:pass@ignvv0-zh.myshopify.com/checkouts/cn/token',
    'https://@ignvv0-zh.myshopify.com/checkouts/cn/token',
    'https://ignvv0-zh.myshopify.com:8443/checkouts/cn/token',
    'https://ignvv0-zh.myshopify.com\\@evil.example/checkouts/cn/token',
    ' https://ignvv0-zh.myshopify.com/checkouts/cn/token',
    'not a URL', '//ignvv0-zh.myshopify.com/checkouts/cn/token', '', null, undefined
  ]) assert.equal(verifiedCheckoutUrl(value), null, String(value));
});

test('rejected checkout URLs never invoke navigation, while approved paths and queries pass through unchanged', () => {
  const navigations = [];
  const navigate = url => navigations.push(url);
  assert.equal(redirectToVerifiedCheckout('https://evil.example/checkout', navigate), false);
  assert.equal(redirectToVerifiedCheckout(null, navigate), false);
  assert.deepEqual(navigations, []);
  assert.equal(redirectToVerifiedCheckout(approved, navigate), true);
  assert.deepEqual(navigations, [approved]);
});

test('the final handoff validates the fresh Shopify cart URL, not the displayed URL', async () => {
  const displayed = { id: 'cart-1', checkoutUrl: 'https://evil.example/old', lines: [
    { remoteLineId: 'line-1', merchandiseId: 'variant-1', productId: 'black', quantity: 1,
      isBreakIn: false, attributes: [{ key: '_anawin_service', value: 'none' }] }
  ], subtotal: 155, currencyCode: 'USD', discountCodes: [], incomplete: false };
  const state = { id: displayed.id, unsafeId: null, pendingCartId: null, revision: 'stable' };
  const verify = createCheckoutVerifier({ getCart: async () => ({ ...displayed, checkoutUrl: approved }),
    readSafety: () => state });
  const result = await verify(displayed);
  assert.equal(result.status, 'ready');
  const navigations = [];
  assert.equal(redirectToVerifiedCheckout(result.checkoutUrl, url => navigations.push(url)), true);
  assert.deepEqual(navigations, [approved]);

  const verifyRejected = createCheckoutVerifier({ getCart: async () => ({ ...displayed,
    checkoutUrl: 'https://evil.example/fresh' }), readSafety: () => state });
  const rejected = await verifyRejected({ ...displayed, checkoutUrl: approved });
  assert.equal(rejected.status, 'ready');
  assert.equal(redirectToVerifiedCheckout(rejected.checkoutUrl, url => navigations.push(url)), false);
  assert.deepEqual(navigations, [approved]);
});
