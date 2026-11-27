import test from 'node:test';
import assert from 'node:assert/strict';
import { createLockManager, shopifyFixture } from '../test-support/shopify-fixture.js';
import { cartLineIdentity, commerceErrorMessage, createShopifyCommerce, UNSAFE_RECORD_PREFIX } from '../src/commerce.js';
import { cartFeedbackMarkup } from '../src/cart-feedback.js';

// Tabs in one browser profile share storage and the Web Locks manager; restore() is another such tab.
async function tab(fixture) {
  const commerce = fixture.restore();
  await commerce.listProducts();
  await commerce.getBreakInService();
  await commerce.getFullSizeBreakInService();
  return commerce;
}
const unsafeOps = storage => [...storage.values.entries()].filter(([key]) => key.startsWith(UNSAFE_RECORD_PREFIX))
  .map(([key, value]) => ({ key, ...JSON.parse(value) }));
const mutations = (fixture, name = '') => fixture.requests.filter(request => /^mutation/.test(request.query) && request.query.includes(name)).length;
const glove = (cart, productId) => cart.lines.find(line => line.productId === productId && !line.isBreakIn);
const service = (cart, parent) => cart.lines.find(line => line.isBreakIn && line.parentLineId === parent.remoteLineId);
const shown = (cart, line) => ({ quantity: line.quantity, identity: cartLineIdentity(cart.lines, line) });
const codes = cart => cart.discountCodes.map(item => item.code).sort();
const escapeHtml = value => String(value).replace(/[&<>"]/g, character => `&#${character.charCodeAt(0)};`);

test('two simultaneous first adds create one cart and both gloves land in it', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  const other = await tab(fixture);
  const [first, second] = await Promise.all([fixture.commerce.addProduct('black', false), other.addProduct('blue', false)]);
  assert.equal(mutations(fixture, 'CreateCart'), 1, 'the queued add reuses the published cart');
  assert.equal(mutations(fixture, 'AddLines'), 1);
  assert.equal(first.id, second.id);
  assert.equal(fixture.storage.getItem('anawin-shopify-cart-id'), first.id);
  const cart = await fixture.restore().getCart();
  assert.deepEqual(cart.lines.map(line => [line.productId, line.quantity]).sort(), [['black', 1], ['blue', 1]]);
  assert.equal(cart.incomplete, false);
  assert.deepEqual(unsafeOps(fixture.storage).filter(record => record.status !== 'terminal'), []);
});

// Web Locks cannot serialize a writer that skips the lock. One that still shares this storage is
// refused by the first create's journal record; another device or profile has its own cart anyway.
test('a writer outside the lock that shares storage is refused by the pending first-create journal', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  const outside = fixture.uncoordinated();
  await outside.listProducts();
  const reached = fixture.delayNextMutation();
  const first = fixture.commerce.addProduct('black', false);
  await reached;
  await assert.rejects(outside.addProduct('blue', false), error => error.code === 'create-unresolved');
  fixture.releaseDelayedMutation();
  assert.equal((await first).incomplete, false);
  assert.equal(mutations(fixture, 'CreateCart'), 1);
  assert.equal((await outside.addProduct('blue', false)).lines.length, 2);
});

test('a first create that times out keeps an unresolved journal, refuses a queued add and survives reload', async () => {
  const fixture = shopifyFixture({ timeoutMs: 20 });
  await fixture.commerce.listProducts();
  const other = await tab(fixture);
  fixture.delayNextMutation();
  const [timedOut, queued] = await Promise.allSettled([fixture.commerce.addProduct('black', false), other.addProduct('blue', false)]);
  assert.equal(timedOut.reason.code, 'uncertain-create');
  assert.equal(queued.reason.code, 'create-unresolved', 'the queued first add never recreates automatically');
  assert.equal(mutations(fixture, 'CreateCart'), 1);
  assert.equal(fixture.storage.getItem('anawin-shopify-cart-id'), null);
  const [record] = unsafeOps(fixture.storage);
  assert.equal(record.cartId, '*');
  assert.equal(record.status, 'unresolved');
  assert.deepEqual(record.createIntent.map(line => [line.merchandiseId, line.quantity]), [['gid://variant/br16', 1]]);

  const reloaded = await tab(fixture);
  const cart = await reloaded.getCart();
  assert.equal(cart.unconfirmedCreate, true);
  await assert.rejects(reloaded.addProduct('black', false), error => error.code === 'create-unresolved');
  assert.equal(mutations(fixture, 'CreateCart'), 1, 'reload does not replay the write');
  assert.match(commerceErrorMessage({ code: 'create-unresolved' }), /Start a new cart/);
  const feedback = cartFeedbackMarkup({ unconfirmedCreate: true, mode: 'shopify' }, escapeHtml);
  assert.match(feedback, /data-start-new-cart/);
  assert.match(feedback, /role="alert"/);

  // Only the shopper's explicit, affirmative choice retires the record; then one new cart is created.
  await assert.rejects(reloaded.startNewCart(), error => error.code === 'create-unresolved');
  assert.equal((await reloaded.startNewCart({ abandonUnknown: true, binding: cart.abandonmentBinding })).unconfirmedCreate, undefined);
  assert.deepEqual(unsafeOps(fixture.storage).filter(record => record.status !== 'terminal'), []);
  const added = await reloaded.addProduct('black', false);
  assert.equal(added.incomplete, false);
  assert.equal(mutations(fixture, 'CreateCart'), 2);
});

test('a created cart ID that cannot be journaled is never published as the active cart', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  const setItem = fixture.storage.setItem.bind(fixture.storage);
  fixture.storage.setItem = (key, value) => {
    if (key.startsWith(UNSAFE_RECORD_PREFIX) && value.includes('"candidateCartId":"gid://shopify/Cart/')) throw new Error('QuotaExceededError');
    return setItem(key, value);
  };
  await assert.rejects(fixture.commerce.addProduct('black', false), error => error.code === 'uncertain-create');
  assert.equal(fixture.storage.getItem('anawin-shopify-cart-id'), null);
  const [record] = unsafeOps(fixture.storage);
  assert.equal(record.cartId, '*');
  assert.equal(record.status, 'unresolved');
  await assert.rejects(fixture.commerce.addProduct('black', false), error => error.code === 'create-unresolved');
  assert.equal(mutations(fixture, 'CreateCart'), 1);
});

test('two +1 intents from tabs that both showed quantity 1 give 2 and then 3', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  const cart = await fixture.commerce.addProduct('black', false);
  const line = glove(cart, 'black');
  const other = await tab(fixture);
  const [first, second] = await Promise.all([
    fixture.commerce.adjustLineQuantity(line.remoteLineId, 1, shown(cart, line)),
    other.adjustLineQuantity(line.remoteLineId, 1, shown(cart, line))
  ]);
  assert.equal(glove(first, 'black').quantity, 2);
  assert.equal(glove(second, 'black').quantity, 3);
  assert.equal(first.rebased, undefined);
  assert.equal(second.rebased, true, 'the second step landed on a quantity its tab did not show');
  assert.equal(glove(await fixture.restore().getCart(), 'black').quantity, 3);
  assert.deepEqual(unsafeOps(fixture.storage).filter(record => record.status !== 'terminal'), []);
});

test('explicit absolute setters keep their meaning: two "set to 2" calls leave 2', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  const cart = await fixture.commerce.addProduct('black', false);
  const other = await tab(fixture);
  const id = glove(cart, 'black').remoteLineId;
  await Promise.all([fixture.commerce.setLineQuantity(id, 2), other.setLineQuantity(id, 2)]);
  assert.equal(glove(await fixture.restore().getCart(), 'black').quantity, 2);
});

for (const autoSyncChild of [true, false]) {
  test(`paired Break-In steps keep glove and service quantities equal (Shopify ${autoSyncChild ? 'syncs' : 'does not sync'} the child)`, async () => {
    const fixture = shopifyFixture({ autoSyncChild });
    await fixture.commerce.listProducts();
    const cart = await fixture.commerce.addProduct('black', true);
    const line = glove(cart, 'black');
    const other = await tab(fixture);
    await Promise.all([
      fixture.commerce.adjustLineQuantity(line.remoteLineId, 1, shown(cart, line)),
      other.adjustLineQuantity(line.remoteLineId, 1, shown(cart, line))
    ]);
    let current = await fixture.restore().getCart();
    assert.equal(glove(current, 'black').quantity, 3);
    assert.equal(service(current, glove(current, 'black')).quantity, 3);
    current = await other.adjustLineQuantity(glove(current, 'black').remoteLineId, -1, shown(current, glove(current, 'black')));
    assert.equal(glove(current, 'black').quantity, 2);
    assert.equal(service(current, glove(current, 'black')).quantity, 2);
    assert.equal(current.incomplete, false);
  });
}

test('a step for a glove another tab changed, re-keyed or removed is refused without a write', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  const cart = await fixture.commerce.addProduct('black', false);
  const line = glove(cart, 'black');
  const other = await tab(fixture);
  const changed = await other.setWristFit(line.remoteLineId, 'tightened');
  assert.equal(glove(changed, 'black').remoteLineId, line.remoteLineId, 'same Shopify line, different glove options');
  const before = mutations(fixture);
  await assert.rejects(fixture.commerce.adjustLineQuantity(line.remoteLineId, 1, shown(cart, line)), error => error.code === 'cart-changed');
  await other.removeLine(line.remoteLineId);
  const afterRemoval = mutations(fixture);
  assert.equal(afterRemoval, before + 1);
  await assert.rejects(fixture.commerce.adjustLineQuantity(line.remoteLineId, 1, shown(cart, line)), error => error.code === 'cart-changed');
  await assert.rejects(fixture.commerce.adjustQuantity('black', 1), error => error.code === 'cart-changed');
  assert.equal(mutations(fixture), afterRemoval);
  assert.match(commerceErrorMessage({ code: 'cart-changed' }), /another tab/);
  await assert.rejects(fixture.commerce.adjustLineQuantity(line.remoteLineId, 2), /\+1 or -1/);
});

test('a +1 step honors the Shopify stock limit and a -1 step at quantity 1 removes the glove', async () => {
  const fixture = shopifyFixture({ stock: { br16: 1 } });
  await fixture.commerce.listProducts();
  const cart = await fixture.commerce.addProduct('black', false);
  const line = glove(cart, 'black');
  await assert.rejects(fixture.commerce.adjustLineQuantity(line.remoteLineId, 1, shown(cart, line)), error => error.code === 'stock-limit');
  let current = await fixture.commerce.getCart();
  assert.equal(glove(current, 'black').quantity, 1);
  assert.equal(current.incomplete, false);
  current = await fixture.commerce.adjustLineQuantity(line.remoteLineId, -1, shown(current, glove(current, 'black')));
  assert.equal(glove(current, 'black'), undefined);
  assert.deepEqual(unsafeOps(fixture.storage).filter(record => record.status !== 'terminal'), []);
});

test('overlapping discount applies and removes from two tabs keep every accepted action', async () => {
  const fixture = shopifyFixture({ discountCodes: [{ code: 'KEEP', applicable: true }] });
  await fixture.commerce.listProducts();
  await fixture.commerce.addProduct('black', false);
  const other = await tab(fixture);
  const [a, b] = await Promise.all([fixture.commerce.applyDiscountCode('A10'), other.applyDiscountCode('B5')]);
  assert.deepEqual(codes(a), ['A10', 'KEEP']);
  assert.deepEqual(codes(b), ['A10', 'B5', 'KEEP'], 'the second apply rebased on the first');
  await Promise.all([fixture.commerce.removeDiscountCode('A10'), other.applyDiscountCode('C3')]);
  assert.deepEqual(codes(await fixture.restore().getCart()), ['B5', 'C3', 'KEEP']);
  assert.deepEqual(unsafeOps(fixture.storage).filter(record => record.status !== 'terminal'), []);
});

test('a quantity step and a discount apply from two tabs both take effect', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  const cart = await fixture.commerce.addProduct('black', true);
  const line = glove(cart, 'black');
  const other = await tab(fixture);
  const [stepped, discounted] = await Promise.all([
    fixture.commerce.adjustLineQuantity(line.remoteLineId, 1, shown(cart, line)),
    other.applyDiscountCode('A10')
  ]);
  assert.equal(stepped.incomplete, false);
  assert.equal(glove(discounted, 'black').quantity, 2, 'the discount was applied to the stepped cart');
  const current = await fixture.restore().getCart();
  assert.equal(glove(current, 'black').quantity, 2);
  assert.equal(service(current, glove(current, 'black')).quantity, 2);
  assert.deepEqual(codes(current), ['A10']);
});

test('without Web Locks no cart write is sent and the existing cart is kept', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  const cart = await fixture.commerce.addProduct('black', false);
  const lockless = createShopifyCommerce(fixture.config, fixture.storage, fixture.fetchImpl, null);
  await lockless.listProducts();
  const before = mutations(fixture);
  const line = glove(cart, 'black');
  for (const write of [() => lockless.addProduct('blue', false), () => lockless.adjustLineQuantity(line.remoteLineId, 1),
    () => lockless.setLineQuantity(line.remoteLineId, 3), () => lockless.applyDiscountCode('A10'), () => lockless.startNewCart()]) {
    await assert.rejects(write(), error => error.code === 'lock-unavailable');
  }
  assert.equal(mutations(fixture), before);
  assert.equal(fixture.storage.getItem('anawin-shopify-cart-id'), cart.id);
  assert.deepEqual(unsafeOps(fixture.storage).filter(record => record.status !== 'terminal'), []);
  assert.match(commerceErrorMessage({ code: 'lock-unavailable' }), /can’t be changed safely/);
});

test('cart writes request the lock exclusively with a bounded wait, and a timed-out wait writes nothing', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  await fixture.commerce.addProduct('black', false);
  const seen = [];
  const spy = { request(name, options, callback) { seen.push({ name, ...options }); return fixture.locks.request(name, options, callback); } };
  const spied = createShopifyCommerce(fixture.config, fixture.storage, fixture.fetchImpl, spy);
  await spied.listProducts();
  await spied.applyDiscountCode('A10');
  assert.equal(seen[0].name, 'anawin-shopify-cart-recovery');
  assert.equal(seen[0].mode, 'exclusive');
  assert.ok(seen[0].signal instanceof AbortSignal);

  const busy = { request: () => Promise.reject(new DOMException('The lock request timed out.', 'TimeoutError')) };
  const waiting = createShopifyCommerce(fixture.config, fixture.storage, fixture.fetchImpl, busy);
  await waiting.listProducts();
  const before = mutations(fixture);
  await assert.rejects(waiting.addProduct('blue', false), error => error.code === 'lock-timeout');
  assert.equal(mutations(fixture), before);
  assert.match(commerceErrorMessage({ code: 'lock-timeout' }), /another tab/);
});

test('storage that cannot journal a write refuses it before any Shopify request', async () => {
  for (const failure of ['write', 'silent-write', 'listing']) {
    const fixture = shopifyFixture();
    await fixture.commerce.listProducts();
    const cart = await fixture.commerce.addProduct('black', false);
    const setItem = fixture.storage.setItem.bind(fixture.storage);
    if (failure === 'listing') fixture.storage.key = () => { throw new Error('SecurityError'); };
    else fixture.storage.setItem = (key, value) => {
      if (!key.startsWith(UNSAFE_RECORD_PREFIX)) return setItem(key, value);
      if (failure === 'write') throw new Error('QuotaExceededError');
    };
    const before = mutations(fixture);
    await assert.rejects(fixture.commerce.adjustLineQuantity(glove(cart, 'black').remoteLineId, 1), error => error.code === 'storage-unavailable', failure);
    await assert.rejects(fixture.commerce.applyDiscountCode('A10'), error => error.code === 'storage-unavailable', failure);
    assert.equal(mutations(fixture), before, failure);
  }
  assert.match(commerceErrorMessage({ code: 'storage-unavailable' }), /Allow site data/);
});

test('a definitive discount rejection leaves the cart usable without announcing success', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  await fixture.commerce.addProduct('black', false);
  fixture.setUserError('Discount code is not valid');
  await assert.rejects(fixture.commerce.applyDiscountCode('NOPE'), error => error.definitiveRejection === true);
  fixture.setUserError('');
  const cart = await fixture.commerce.getCart();
  assert.equal(cart.incomplete, false);
  assert.deepEqual(codes(cart), []);
  assert.deepEqual(unsafeOps(fixture.storage).filter(record => record.status !== 'terminal'), []);
});

test('an unanswered discount write stays unresolved and is never replayed', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  await fixture.commerce.addProduct('black', false);
  fixture.failAfterNextMutation();
  await assert.rejects(fixture.commerce.applyDiscountCode('A10'), error => error.code === 'uncertain');
  assert.match(commerceErrorMessage({ code: 'uncertain' }), /could not confirm/);
  const [record] = unsafeOps(fixture.storage);
  assert.equal(record.status, 'unresolved');
  const reloaded = await tab(fixture);
  assert.equal((await reloaded.getCart()).incomplete, true);
  await assert.rejects(reloaded.applyDiscountCode('A10'), error => error.code === 'cart-unresolved');
  assert.equal(mutations(fixture, 'UpdateDiscountCodes'), 1);
});

// Task 2H: the fresh authoritative read, not the reply, decides a discount write. A reply claiming other codes is
// ignored when Shopify saved the intended set; a saved result without the intended codes (here KEEP was dropped)
// is unconfirmed and, having changed the cart, stays unresolved.
test('a discount result without the intended codes is reported as unconfirmed, not applied', async () => {
  const fixture = shopifyFixture({ discountCodes: [{ code: 'KEEP', applicable: true }] });
  await fixture.commerce.listProducts();
  await fixture.commerce.addProduct('black', false);
  fixture.transformNextMutationResponse(payload => { payload.cart.discountCodes = [{ code: 'A10', applicable: true }]; });
  const applied = await fixture.commerce.applyDiscountCode('A10');
  assert.deepEqual(applied.discountCodes.map(item => item.code), ['KEEP', 'A10']);

  const dropping = shopifyFixture({ discountCodes: [{ code: 'KEEP', applicable: true }],
    discountScenario: list => ({ discountCodes: (list.includes('A10') ? list.filter(code => code !== 'KEEP') : list).map(code => ({ code, applicable: true })) }) });
  await dropping.commerce.listProducts();
  await dropping.commerce.addProduct('black', false);
  await assert.rejects(dropping.commerce.applyDiscountCode('A10'), error => error.code === 'discount-unconfirmed');
  assert.equal(unsafeOps(dropping.storage).filter(record => record.status !== 'terminal').length, 1);
  assert.equal((await dropping.commerce.getCart()).incomplete, true);
});

const checkoutFixture = () => shopifyFixture({ checkoutHost: 'ignvv0-zh.myshopify.com' });

test('checkout does not run while another tab holds the cart lock', async () => {
  const fixture = checkoutFixture();
  await fixture.commerce.listProducts();
  const cart = await fixture.commerce.addProduct('black', false);
  const other = await tab(fixture);
  const reached = fixture.delayNextMutation();
  const stepping = other.adjustLineQuantity(glove(cart, 'black').remoteLineId, 1);
  await reached;
  let navigated = false;
  const result = await fixture.commerce.checkout(cart, {}, () => { navigated = true; });
  assert.equal(result.status, 'blocked');
  assert.equal(navigated, false);
  fixture.releaseDelayedMutation();
  assert.equal(glove(await stepping, 'black').quantity, 2);
});

test('a write queued during checkout waits for the handoff and then finds the cart frozen', async () => {
  const fixture = checkoutFixture();
  await fixture.commerce.listProducts();
  const cart = await fixture.commerce.addProduct('black', false);
  const other = await tab(fixture);
  let queued;
  const result = await fixture.commerce.checkout(cart, {}, () => {
    queued = other.adjustLineQuantity(glove(cart, 'black').remoteLineId, 1).catch(error => error);
  });
  assert.equal(result.status, 'navigating');
  const before = mutations(fixture);
  assert.equal((await queued).code, 'cart-unresolved');
  assert.equal(mutations(fixture), before, 'nothing was written to the checkout cart');
  const frozen = await fixture.restore().getCart();
  assert.equal(frozen.incomplete, true);
  assert.match(frozen.uncertainMutation, /checkout handoff/);
});

test('recovery after an ambiguous +1 copies what Shopify holds and never adds the unit twice', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  const cart = await fixture.commerce.addProduct('black', true);
  const line = glove(cart, 'black');
  fixture.failAfterNextMutation();
  await assert.rejects(fixture.commerce.adjustLineQuantity(line.remoteLineId, 1, shown(cart, line)), error => error.code === 'uncertain');
  const before = mutations(fixture);
  await assert.rejects(fixture.commerce.adjustLineQuantity(line.remoteLineId, 1, shown(cart, line)), error => error.code === 'cart-unresolved');
  assert.equal(mutations(fixture), before, 'the ambiguous step is not replayed');
  const blocked = await fixture.restore().getCart();
  assert.equal(blocked.recoveryAvailable, true);
  const recovered = await fixture.restore().recoverCart();
  assert.notEqual(recovered.id, cart.id);
  assert.equal(glove(recovered, 'black').quantity, 2);
  assert.equal(service(recovered, glove(recovered, 'black')).quantity, 2);
  assert.equal(recovered.lines.filter(item => !item.isBreakIn).length, 1);
  assert.deepEqual(unsafeOps(fixture.storage).filter(record => record.status !== 'terminal'), []);
  const stepped = await fixture.commerce.adjustLineQuantity(glove(recovered, 'black').remoteLineId, 1, shown(recovered, glove(recovered, 'black')));
  assert.equal(glove(stepped, 'black').quantity, 3);
});

test('recovery is refused while another tab still holds the cart lock', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  const cart = await fixture.commerce.addProduct('black', false);
  fixture.setApiError(true);
  await assert.rejects(fixture.commerce.addProduct('blue', false), error => error.code === 'uncertain');
  fixture.setApiError(false);
  const holder = createLockManager();
  let release;
  holder.request('anawin-shopify-cart-recovery', { mode: 'exclusive' }, () => new Promise(resolve => { release = resolve; }));
  await new Promise(resolve => setTimeout(resolve, 0));
  const blocked = createShopifyCommerce(fixture.config, fixture.storage, fixture.fetchImpl, holder);
  await assert.rejects(blocked.recoverCart(), error => error.code === 'recovery-ambiguous');
  release();
  assert.equal(fixture.storage.getItem('anawin-shopify-cart-id'), cart.id);
  assert.equal(mutations(fixture, 'CreateCart'), 1);
});
