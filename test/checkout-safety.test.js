import test from 'node:test';
import assert from 'node:assert/strict';
import { checkoutCartIsComplete, createCheckoutVerifier, isCartStorageKey } from '../src/checkout-safety.js';

const glove = (id = 'line-1', quantity = 1, service = 'none') => ({
  remoteLineId: id, parentLineId: null, merchandiseId: 'gid://variant/br16', productId: 'black',
  isBreakIn: false, quantity, attributes: [{ key: '_anawin_service', value: service }],
  unitPrice: { amount: 155, currencyCode: 'USD' }, lineTotal: { amount: 155 * quantity, currencyCode: 'USD' }
});
const child = (parentId = 'line-1') => ({
  remoteLineId: 'service-1', parentLineId: parentId, merchandiseId: 'gid://variant/service',
  productId: 'black', isBreakIn: true, quantity: 1, attributes: [],
  unitPrice: { amount: 20, currencyCode: 'USD' }, lineTotal: { amount: 20, currencyCode: 'USD' }
});
const cart = (id = 'gid://cart/1', lines = [glove()]) => ({
  id, checkoutUrl: `https://store.myshopify.com/checkouts/${id.split('/').at(-1)}`,
  lines, subtotal: lines.reduce((sum, line) => sum + line.lineTotal.amount, 0),
  currencyCode: 'USD', discountCodes: [], incomplete: false
});
const safety = id => ({ id, unsafeId: null, pendingCartId: null });

test('cross-tab cart ID, safety, and same-ID revision events invalidate cached checkout', () => {
  for (const key of ['anawin-shopify-cart-id', 'anawin-shopify-unsafe-cart-id',
    'anawin-shopify-pending-mutation', 'anawin-shopify-cart-revision', null]) {
    assert.equal(isCartStorageKey(key), true);
  }
  assert.equal(isCartStorageKey('unrelated-setting'), false);
});

test('checkout blocks an unsafe cart marked by another tab', async () => {
  const displayed = cart();
  const state = { ...safety(displayed.id), unsafeId: displayed.id };
  const verify = createCheckoutVerifier({ getCart: async () => ({ ...displayed, incomplete: true }), readSafety: () => state });
  const result = await verify(displayed);
  assert.equal(result.status, 'blocked');
  assert.equal(result.checkoutUrl, undefined);
});

test('an unchanged cart uses the latest Shopify checkout URL on the first click', async () => {
  const displayed = cart();
  const verified = { ...displayed, checkoutUrl: `${displayed.checkoutUrl}?fresh=1` };
  const state = { ...safety(displayed.id), revision: 'initial' };
  const verify = createCheckoutVerifier({ getCart: async () => verified, readSafety: () => state });
  const result = await verify(displayed);
  assert.equal(result.status, 'ready');
  assert.equal(result.checkoutUrl, verified.checkoutUrl);
  assert.equal(result.revision, 'initial');
});

test('rotating Shopify checkout URLs never cause a review loop', async () => {
  const displayed = cart();
  let reads = 0;
  const verify = createCheckoutVerifier({ getCart: async () => ({
    ...displayed, checkoutUrl: `${displayed.checkoutUrl}?fresh=${++reads}`
  }), readSafety: () => ({ ...safety(displayed.id), revision: 'stable' }) });
  for (let click = 1; click <= 3; click++) {
    const result = await verify(displayed);
    assert.equal(result.status, 'ready');
    assert.match(result.checkoutUrl, new RegExp(`fresh=${click}$`));
  }
  assert.equal(reads, 3);
});

test('a changed cart can be reviewed once while Shopify rotates its checkout URL', async () => {
  const displayed = cart();
  const changed = cart(displayed.id, [glove('line-1', 2)]);
  let reads = 0;
  const verify = createCheckoutVerifier({ getCart: async () => ({
    ...changed, checkoutUrl: `${changed.checkoutUrl}?fresh=${++reads}`
  }), readSafety: () => safety(changed.id) });
  const review = await verify(displayed);
  assert.equal(review.status, 'review');
  assert.equal(review.cart.lines[0].quantity, 2);
  const ready = await verify(review.cart);
  assert.equal(ready.status, 'ready');
  assert.match(ready.checkoutUrl, /fresh=2$/);
});

test('an unresolved mutation blocks checkout even when Shopify returns complete lines', async () => {
  const displayed = cart();
  const state = { ...safety(displayed.id), pendingCartId: displayed.id };
  const verify = createCheckoutVerifier({ getCart: async () => displayed, readSafety: () => state });
  const result = await verify(displayed);
  assert.equal(result.status, 'blocked');
  assert.equal(result.checkoutUrl, undefined);
});

test('a cart marked unsafe during verification never returns a checkout URL', async () => {
  const displayed = cart();
  const state = safety(displayed.id);
  const verify = createCheckoutVerifier({ getCart: async () => {
    state.unsafeId = displayed.id;
    return displayed;
  }, readSafety: () => state });
  const result = await verify(displayed);
  assert.equal(result.status, 'blocked');
  assert.equal(result.checkoutUrl, undefined);
});

test('checkout loads a replacement cart and requires review before redirect', async () => {
  const displayed = cart();
  const replacement = cart('gid://cart/2');
  const verify = createCheckoutVerifier({ getCart: async () => replacement,
    readSafety: () => safety(replacement.id) });
  assert.equal((await verify(displayed)).status, 'review');
  const confirmed = await verify(replacement);
  assert.equal(confirmed.status, 'ready');
  assert.equal(confirmed.checkoutUrl, replacement.checkoutUrl);
});

test('a cart ID switch during checkout verification cannot validate the stale response', async () => {
  const displayed = cart();
  const replacement = cart('gid://cart/2');
  let release;
  const started = new Promise(resolve => { release = resolve; });
  let resolveFirst;
  const first = new Promise(resolve => { resolveFirst = resolve; });
  let calls = 0;
  let state = safety(displayed.id);
  const verify = createCheckoutVerifier({ getCart: () => {
    calls++;
    if (calls === 1) { release(); return first; }
    return Promise.resolve(replacement);
  }, readSafety: () => state });
  const pending = verify(displayed);
  await started;
  state = safety(replacement.id);
  resolveFirst(displayed);
  const result = await pending;
  assert.equal(calls, 2);
  assert.equal(result.status, 'review');
  assert.equal(result.cart.id, replacement.id);
  assert.equal(result.checkoutUrl, undefined);
});

test('a same-cart quantity change during verification triggers a fresh read and review', async () => {
  const displayed = cart();
  const updated = cart(displayed.id, [glove('line-1', 2)]);
  let state = { ...safety(displayed.id), revision: 'before' };
  let calls = 0;
  const verify = createCheckoutVerifier({ getCart: async () => {
    calls++;
    if (calls === 1) {
      state = { ...state, revision: 'after' };
      return displayed;
    }
    return updated;
  }, readSafety: () => state });
  const result = await verify(displayed);
  assert.equal(calls, 2);
  assert.equal(result.status, 'review');
  assert.equal(result.cart.lines[0].quantity, 2);
});

test('a cross-tab revision change after verification forces a fresh cart read', async () => {
  const displayed = cart();
  const updated = cart(displayed.id, [glove('line-1', 2)]);
  let safetyReads = 0;
  let cartReads = 0;
  const verify = createCheckoutVerifier({ getCart: async () => ++cartReads === 1 ? displayed : updated,
    readSafety: () => ({ ...safety(displayed.id), revision: ++safetyReads >= 3 ? 'changed' : 'initial' }) });
  const result = await verify(displayed);
  assert.equal(cartReads, 2);
  assert.equal(result.status, 'review');
  assert.equal(result.cart.lines[0].quantity, 2);
  assert.equal(result.checkoutUrl, undefined);
});

test('Shopify verification failure reports a retryable error', async () => {
  const displayed = cart();
  const verify = createCheckoutVerifier({ getCart: async () => { throw new Error('network unavailable'); },
    readSafety: () => safety(displayed.id) });
  const result = await verify(displayed);
  assert.equal(result.status, 'blocked');
  assert.match(result.message, /Couldn’t check your cart with Shopify/);
});

test('changed glove quantity or Break-In association requires another explicit click', async () => {
  const displayed = cart();
  for (const changed of [cart(displayed.id, [glove('line-1', 2)]),
    cart(displayed.id, [glove('line-1', 1, 'break-in'), child()])]) {
    const verify = createCheckoutVerifier({ getCart: async () => changed,
      readSafety: () => safety(changed.id) });
    assert.equal((await verify(displayed)).status, 'review');
    assert.equal((await verify(changed)).status, 'ready');
  }
});

test('double-clicking checkout starts only one Shopify verification', async () => {
  const displayed = cart();
  let release;
  const pendingCart = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const verify = createCheckoutVerifier({ getCart: () => { calls++; return pendingCart; },
    readSafety: () => safety(displayed.id) });
  const first = verify(displayed);
  assert.equal((await verify(displayed)).status, 'busy');
  assert.equal(calls, 1);
  release(displayed);
  assert.equal((await first).status, 'ready');
});

test('a replacement cart must be explicitly reviewed even when items match', async () => {
  const displayed = cart('gid://cart/2');
  const verify = createCheckoutVerifier({ getCart: async () => displayed,
    readSafety: () => safety(displayed.id) });
  assert.equal((await verify(displayed, { requireReview: true })).status, 'review');
  assert.equal((await verify(displayed)).status, 'ready');
  assert.equal(checkoutCartIsComplete(cart(displayed.id, [glove('line-1', 1, 'break-in'), child()])), true);
});
