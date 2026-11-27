// Phase 6 Task 2E: four independently reproduced acceptance blockers, the authoritative recovery
// return value, and the missing high-value fault cases. Each test is a permanent negative control.
import test from 'node:test';
import assert from 'node:assert/strict';
import { shopifyFixture, recoveryBindingOf } from '../test-support/shopify-fixture.js';
import { createShopifyCommerce, UNSAFE_RECORD_PREFIX } from '../src/commerce.js';

const ACTIVE = 'anawin-shopify-cart-id';
const fullSizeOptions = { type: 'full-size', wearingStyle: 'Traditional — index finger out', closure: 'Ring finger', thumbShape: 'Straight',
  pinkyShape: 'Flared', fingerShape: 'Rolled', firmness: 'Medium', notes: '' };
async function loaded(commerce) {
  await commerce.listProducts();
  await commerce.getBreakInService();
  await commerce.getFullSizeBreakInService();
  return commerce;
}
const tab = fixture => loaded(fixture.restore());
const unsafeOps = storage => [...storage.values.entries()].filter(([key]) => key.startsWith(UNSAFE_RECORD_PREFIX))
  .map(([key, value]) => ({ key, ...JSON.parse(value) }));
const rawOps = storage => Object.fromEntries([...storage.values.entries()].filter(([key]) => key.startsWith(UNSAFE_RECORD_PREFIX)));
const everything = storage => Object.fromEntries(storage.values);
const mutations = (fixture, name = '') => fixture.requests.filter(request => /^mutation/.test(request.query) && request.query.includes(name)).length;
const glove = (cart, productId) => cart.lines.find(line => line.productId === productId && !line.isBreakIn);
const service = (cart, parent) => cart.lines.find(line => line.isBreakIn && line.parentLineId === parent.remoteLineId);
const isCartRead = query => query.includes('query Cart(');
const answer = payload => ({ ok: true, json: async () => payload });
const recoveryRecords = storage => unsafeOps(storage).filter(record => record.kind === 'recovery');
function hookedTab(fixture, { before, after } = {}) {
  const fetchImpl = async (url, options) => {
    const { query, variables } = JSON.parse(options.body);
    const early = await before?.({ query, variables });
    if (early) return early;
    const response = await fixture.fetchImpl(url, options);
    if (!response.ok || !after) return response;
    const payload = await response.json();
    return answer(await after({ query, variables, payload }) ?? payload);
  };
  return loaded(createShopifyCommerce(fixture.config, fixture.storage, fetchImpl, fixture.locks));
}
function interceptWrites(storage, matches, behaviour) {
  const setItem = storage.setItem.bind(storage);
  storage.setItem = (key, value) => matches(key, String(value)) ? behaviour(setItem, key, value) : setItem(key, value);
  return () => { storage.setItem = setItem; };
}
function throwingReadBack(storage, matches) {
  const getItem = storage.getItem.bind(storage);
  let armed = false;
  let fired = false;
  const restoreWrites = interceptWrites(storage, () => true, (setItem, key, value) => {
    setItem(key, value);
    if (!armed && matches(key, String(value))) armed = key;
  });
  storage.getItem = key => {
    if (armed && !fired && key === armed) { fired = true; throw new DOMException('read refused', 'SecurityError'); }
    return getItem(key);
  };
  return () => { restoreWrites(); storage.getItem = getItem; };
}
function throwingRemoval(storage, keys) {
  const removeItem = storage.removeItem.bind(storage);
  storage.removeItem = key => { if (keys.includes(key)) throw new DOMException('refused', 'SecurityError'); return removeItem(key); };
  return () => { storage.removeItem = removeItem; };
}
async function checkoutNavigates(commerce, cart) {
  let navigated = false;
  const result = await commerce.checkout(cart, {}, () => { navigated = true; });
  return { navigated, status: result.status };
}
// Every Shopify cart in a payload (reads and mutation results) reports `hand` for its full-size gloves.
const reportHand = hand => ({ payload }) => {
  const carts = [payload.data?.cart, ...Object.values(payload.data || {}).map(value => value?.cart)].filter(Boolean);
  for (const cart of carts) for (const node of cart.lines.nodes) {
    if (!node.parentRelationship && /^mi26$/.test(node.merchandise.product.handle)) node.merchandise.selectedOptions = [{ name: 'Throwing Hand', value: hand }];
  }
  return payload;
};

// ---- HIGH-1: the ordinary first add verifies the selected hand; checkout compares it ----

for (const [chosen, reported] of [['right', 'Left'], ['left', 'Right']]) {
  for (const breakIn of [false, true]) {
    test(`HIGH-1: a ${chosen}-hand first add that Shopify reports as ${reported} never completes or checks out (${breakIn ? 'serviced' : 'unserviced'})`, async () => {
      const fixture = shopifyFixture({ fullSize: true, checkoutHost: 'ignvv0-zh.myshopify.com' });
      await fixture.commerce.listProducts();
      const contradicting = await hookedTab(fixture, { after: reportHand(reported) });
      await assert.rejects(contradicting.addProduct('full-mint', breakIn, breakIn ? fullSizeOptions : undefined, `gid://variant/mi26-${chosen}`));
      assert.equal(mutations(fixture, 'CreateCart'), 1);
      // Shopify's saved line keeps the requested variant, glove/service pairing and quantity.
      const saved = fixture.cartLines('gid://shopify/Cart/c1?key=k1');
      assert.deepEqual(saved.filter(line => !line.parentRelationship).map(line => [line.merchandise.id, line.quantity]), [[`gid://variant/mi26-${chosen}`, 1]]);
      assert.equal(saved.filter(line => line.parentRelationship).length, breakIn ? 1 : 0);
      // Task 2H: a contradictory hand is invalid data, never returned as a cart (row 3); the read rejects.
      const shown = await contradicting.getCart().catch(error => ({ id: null, lines: [], unverified: error.code }));
      assert.ok(shown.unverified === 'cart-unverified' || shown.unconfirmedCreate, 'never a verified cart');
      assert.equal((await checkoutNavigates(contradicting, shown)).navigated, false, 'no checkout navigation');
      await assert.rejects(contradicting.addProduct('full-mint', false, undefined, `gid://variant/mi26-${chosen}`));
      assert.equal(mutations(fixture, 'CreateCart'), 1);
    });
  }
}

test('HIGH-1: checkout requires review when the selected hand changes after the cart was shown', async () => {
  const fixture = shopifyFixture({ fullSize: true, checkoutHost: 'ignvv0-zh.myshopify.com' });
  await fixture.commerce.listProducts();
  const shown = await fixture.commerce.addProduct('full-mint', false, undefined, 'gid://variant/mi26-right');
  assert.equal(shown.incomplete, false);
  const changed = await hookedTab(fixture, { after: reportHand('Left') });
  const result = await checkoutNavigates(changed, shown);
  assert.equal(result.navigated, false);
  assert.notEqual(result.status, 'navigating');
  // The honest cart still checks out.
  assert.equal((await checkoutNavigates(await tab(fixture), shown)).navigated, true);
});

test('HIGH-1: an honest first add of either hand completes as before', async () => {
  for (const hand of ['right', 'left']) {
    const fixture = shopifyFixture({ fullSize: true });
    await fixture.commerce.listProducts();
    const cart = await fixture.commerce.addProduct('full-mint', true, fullSizeOptions, `gid://variant/mi26-${hand}`);
    assert.equal(cart.incomplete, false);
    assert.equal(glove(cart, 'full-mint').throwingHand, hand === 'right' ? 'Right' : 'Left');
    assert.equal(service(cart, glove(cart, 'full-mint')).quantity, 1);
  }
});

for (const scope of ['reconciliation', 'recovery']) {
  test(`HIGH-1: an older handless full-size journal record never matches (${scope}); a handless trainer record still does`, async () => {
    for (const [productId, merchandiseId, matches] of [['full-mint', 'gid://variant/mi26-right', false], ['black', 'gid://variant/br16', true]]) {
      const fixture = shopifyFixture({ fullSize: true });
      await fixture.commerce.listProducts();
      const cart = await fixture.commerce.addProduct(productId, false, undefined, productId === 'black' ? null : merchandiseId);
      const createIntent = [{ merchandiseId, quantity: 1, attributes: glove(cart, productId).attributes, parentMerchandiseId: null }];
      if (scope === 'reconciliation') {
        fixture.storage.removeItem(ACTIVE);
        fixture.storage.setItem(`${UNSAFE_RECORD_PREFIX}legacy`, JSON.stringify({ cartId: '*', candidateCartId: cart.id, kind: 'addProduct',
          kinds: ['addition'], status: 'pending', createdAt: 1, createIntent }));
        const reconciled = await (await tab(fixture)).reconcileUnconfirmedCart();
        assert.equal(Boolean(reconciled.createMismatch), !matches, productId);
      } else {
        fixture.storage.setItem(`${UNSAFE_RECORD_PREFIX}legacy`, JSON.stringify({ cartId: cart.id, kind: 'addProduct', kinds: ['addition'],
          status: 'unresolved', createdAt: 1, createIntent }));
        const recovering = (await tab(fixture)).recoverCart();
        if (matches) assert.equal((await recovering).incomplete, false);
        else await assert.rejects(recovering, error => error.code === 'create-mismatch');
      }
    }
  });
}

// ---- HIGH-2: a cartCreate reply without its cart field is ambiguous, never a rejection ----

test('HIGH-2: userErrors with the cart field omitted keep the create unresolved; no second cart, even after reload', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  fixture.transformNextMutationResponse(payload => { delete payload.cart; payload.userErrors = [{ message: 'Partial failure' }]; });
  await assert.rejects(fixture.commerce.addProduct('black', false), error => error.code === 'uncertain-create' && !error.definitiveRejection);
  assert.deepEqual(fixture.cartLines('gid://shopify/Cart/c1?key=k1').map(line => line.merchandise.id), ['gid://variant/br16'], 'Shopify did create the cart');
  const [record] = unsafeOps(fixture.storage);
  assert.equal(record.cartId, '*');
  for (const commerce of [fixture.commerce, await tab(fixture)]) {
    await assert.rejects(commerce.addProduct('black', false), error => error.code === 'create-unresolved');
    await assert.rejects(commerce.addProduct('blue', false), error => error.code === 'create-unresolved');
  }
  assert.deepEqual(fixture.requests.filter(request => /^mutation/.test(request.query)).map(request => request.query.match(/mutation (\w+)/)[1]),
    ['CreateCart'], 'exactly one Shopify mutation was ever sent');
});

for (const [label, rewrite] of [
  ['a non-array userErrors', payload => { payload.userErrors = { message: 'malformed' }; }],
  ['a malformed userError entry', payload => { payload.userErrors = [{ field: ['lines'] }]; }],
  ['a missing userErrors field', payload => { delete payload.userErrors; }]
]) {
  test(`HIGH-2: a create reply with ${label} is ambiguous and never creates a second cart`, async () => {
    const fixture = shopifyFixture();
    await fixture.commerce.listProducts();
    fixture.transformNextMutationResponse(rewrite);
    await assert.rejects(fixture.commerce.addProduct('black', false), error => error.code === 'uncertain-create');
    await assert.rejects((await tab(fixture)).addProduct('black', false), error => error.code === 'create-unresolved');
    assert.equal(mutations(fixture, 'CreateCart'), 1);
  });

  test(`HIGH-2: an update reply with ${label} is unresolved, never success`, async () => {
    const fixture = shopifyFixture();
    await fixture.commerce.listProducts();
    const cart = await fixture.commerce.addProduct('black', false);
    fixture.transformNextMutationResponse(rewrite);
    await assert.rejects(fixture.commerce.setLineQuantity(glove(cart, 'black').remoteLineId, 2), error => error.code === 'uncertain');
    assert.equal(unsafeOps(fixture.storage)[0].status, 'unresolved');
  });
}

// Task 2H: a clean `cart: null` with userErrors on a mutation is an application error whose remote outcome is
// unresolved (no rollback or exactly-once guarantee is documented). It stays armed; only affirmative abandonment moves on.
test('HIGH-2: a well-formed create rejection (cart: null with userErrors) stays unresolved until explicitly abandoned', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  fixture.setUserError('Merchandise not available');
  fixture.transformNextMutationResponse(payload => { payload.cart = null; });
  await assert.rejects(fixture.commerce.addProduct('black', false), error => error.code === 'uncertain-create' && !error.definitiveRejection);
  fixture.setUserError('');
  const [record] = unsafeOps(fixture.storage);
  assert.equal(record.cartId, '*');
  assert.equal(record.candidateCartId, undefined);
  await assert.rejects(fixture.commerce.addProduct('black', false), error => error.code === 'create-unresolved');
  await fixture.commerce.startNewCart({ abandonUnknown: true, binding: (await fixture.commerce.getCart()).abandonmentBinding });
  assert.equal((await fixture.commerce.addProduct('black', false)).lines.length, 1);
});

test('HIGH-2: a recovery create reply without its cart field stays journaled and is never resent', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  const cart = await fixture.commerce.addProduct('black', false);
  fixture.setApiError(true);
  await assert.rejects(fixture.commerce.addProduct('blue', false));
  fixture.setApiError(false);
  fixture.observeMutations(({ field }) => {
    if (field !== 'cartCreate') return;
    fixture.observeMutations(null);
    fixture.transformNextMutationResponse(payload => { delete payload.cart; payload.userErrors = [{ message: 'Partial failure' }]; });
  });
  await assert.rejects((await tab(fixture)).recoverCart(), error => error.code === 'uncertain');
  const [record] = recoveryRecords(fixture.storage);
  assert.equal(record.recovery.stage, 'create');
  const creates = mutations(fixture, 'CreateCart');
  await assert.rejects((await tab(fixture)).recoverCart(), error => error.code === 'recovery-unconfirmed');
  assert.equal(mutations(fixture, 'CreateCart'), creates, 'no second recovery create');
  assert.equal(fixture.storage.getItem(ACTIVE), cart.id);
});

// ---- MEDIUM-1: consent verification reads without side effects ----

async function reviewedMismatch() {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  const cart = await fixture.commerce.addProduct('black', false);
  fixture.storage.removeItem(ACTIVE);
  fixture.storage.setItem(`${UNSAFE_RECORD_PREFIX}closed-tab`, JSON.stringify({ cartId: '*', candidateCartId: cart.id, kind: 'addProduct',
    kinds: ['addition'], status: 'pending', createdAt: 1, dispatched: true,
    createIntent: [{ merchandiseId: 'gid://variant/ob16', quantity: 1, attributes: glove(cart, 'black').attributes, parentMerchandiseId: null }] }));
  const shopper = await tab(fixture);
  await shopper.reconcileUnconfirmedCart();
  const shown = await shopper.getCart();
  assert.equal(shown.createMismatch, true);
  return { fixture, cart, shown };
}
const consentReads = {
  'an explicit null cart': ['cart-changed', { data: { cart: null } }],
  'an omitted cart field': ['cart-unverified', { data: {} }],
  'a malformed envelope': ['cart-unverified', { data: { cart: null }, errors: { message: 'malformed' } }]
};
for (const action of ['keep', 'discard']) {
  for (const [label, [code, envelope]] of Object.entries(consentReads)) {
    test(`MEDIUM-1: ${action} with ${label} on the consent read leaves local state byte-identical`, async () => {
      const { fixture, cart, shown } = await reviewedMismatch();
      const before = everything(fixture.storage);
      const reading = await hookedTab(fixture, { before: ({ query, variables }) =>
        isCartRead(query) && variables.id === cart.id ? answer(envelope) : null });
      await assert.rejects(action === 'keep' ? reading.keepUnconfirmedCart(shown) : reading.discardUnconfirmedCart(shown), error => error.code === code);
      assert.deepEqual(everything(fixture.storage), before);
    });
  }

  test(`MEDIUM-1: ${action} with a changed cart or a mismatched review stamp changes nothing; fresh consent applies`, async () => {
    const { fixture, cart, shown } = await reviewedMismatch();
    const before = everything(fixture.storage);
    const shopper = await tab(fixture);
    const resolve = displayed => action === 'keep' ? shopper.keepUnconfirmedCart(displayed) : shopper.discardUnconfirmedCart(displayed);
    await assert.rejects(resolve({ ...shown, reviewStamp: `${shown.reviewStamp} ` }), error => error.code === 'cart-changed');
    await assert.rejects(resolve({ ...shown, id: 'gid://shopify/Cart/cother?key=kother' }), error => error.code === 'cart-changed');
    assert.deepEqual(everything(fixture.storage), before);
    await (await fixture.detached()).setLineQuantity(glove(shown, 'black').remoteLineId, 2);
    await assert.rejects(resolve(shown), error => error.code === 'cart-changed');
    assert.deepEqual(everything(fixture.storage), before);
    const fresh = await shopper.getCart();
    const resolved = await resolve(fresh);
    assert.equal(resolved.id, action === 'keep' ? cart.id : null);
    // Task 2H: nothing gates any more; a discarded cart's ID stays in a terminal abandonment record.
    assert.deepEqual(unsafeOps(fixture.storage).filter(record => record.status !== 'terminal'), []);
    if (action === 'discard') assert.ok(unsafeOps(fixture.storage).some(record => record.resolution === 'abandoned' && record.abandonedCartId === cart.id));
  });
}

// ---- MEDIUM-2: a retry with several earlier records never loses a known candidate ----

async function twoEarlierAttempts() {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  const cart = await fixture.commerce.addProduct('black', true);
  fixture.setApiError(true);
  await assert.rejects(fixture.commerce.addProduct('blue', false));
  fixture.setApiError(false);
  fixture.failAfterNextMutation(2);
  await assert.rejects((await tab(fixture)).recoverCart(), error => error.code === 'uncertain');
  const [known] = recoveryRecords(fixture.storage);
  // An interrupted earlier retry left a second, ready record beside the known candidate.
  const { key: _key, ...knownRecord } = known;
  fixture.storage.setItem(`${UNSAFE_RECORD_PREFIX}interrupted-retry`, JSON.stringify({ ...knownRecord, createdAt: knownRecord.createdAt + 1,
    dispatched: true, recovery: { ...knownRecord.recovery, stage: 'create', candidateCartId: undefined } }));
  return { fixture, cart, known, earlier: rawOps(fixture.storage), attempts: recoveryRecords(fixture.storage).map(record => record.key) };
}
const isReplacement = earlier => (key, value) => key.startsWith(UNSAFE_RECORD_PREFIX) && !Object.hasOwn(earlier, key) && value.includes('"recovery"');
const preparationFaults = {
  'the replacement write throws': ({ storage, earlier }) => interceptWrites(storage, isReplacement(earlier), () => { throw new Error('QuotaExceededError'); }),
  'the replacement read-back throws': ({ storage, earlier }) => throwingReadBack(storage, isReplacement(earlier)),
  'the ready write throws': ({ storage, earlier }) => interceptWrites(storage, (key, value) => isReplacement(earlier)(key, value) &&
    value.includes('"dispatched":true'), () => { throw new Error('QuotaExceededError'); }),
  'the ready read-back throws': ({ storage, earlier }) => throwingReadBack(storage, (key, value) => isReplacement(earlier)(key, value) &&
    value.includes('"dispatched":true'))
};
for (const [label, fault] of Object.entries(preparationFaults)) {
  test(`MEDIUM-2: with two earlier attempts, when ${label}, nothing is sent and every earlier record survives reload`, async () => {
    const { fixture, cart, earlier, known } = await twoEarlierAttempts();
    const writes = mutations(fixture);
    const restore = fault({ storage: fixture.storage, earlier });
    await assert.rejects((await tab(fixture)).recoverCart({ binding: await recoveryBindingOf(fixture), abandonUnconfirmed: true }), error => error.code === 'storage-unavailable');
    restore();
    assert.equal(mutations(fixture), writes, 'zero Shopify dispatch');
    assert.deepEqual(rawOps(fixture.storage), earlier, 'the known candidate and the interrupted retry are untouched');
    const reloaded = await tab(fixture);
    assert.equal((await reloaded.getCart()).recoveryUnconfirmed, true);
    await assert.rejects(reloaded.recoverCart(), error => error.code === 'recovery-unconfirmed');
    assert.equal(JSON.parse(fixture.storage.getItem(known.key)).recovery.candidateCartId, known.recovery.candidateCartId);
    assert.equal(fixture.storage.getItem(ACTIVE), cart.id);
  });
}

// Task 2H: supersession is logical. A fresh attempt never removes or restores earlier records before a verified
// resolution, so a storage that refuses removals cannot cost a known candidate; it only leaves a record in place.
for (const failing of ['first', 'second', 'both']) {
  test(`MEDIUM-2: with two earlier attempts, a storage refusing removal of the ${failing} earlier record loses nothing`, async () => {
    const { fixture, cart, earlier, attempts, known } = await twoEarlierAttempts();
    const keys = failing === 'both' ? attempts : failing === 'first' ? [attempts[0]] : [attempts[1]];
    const restore = throwingRemoval(fixture.storage, keys);
    const creates = mutations(fixture, 'CreateCart');
    const recovered = await (await tab(fixture)).recoverCart({ binding: await recoveryBindingOf(fixture), abandonUnconfirmed: true });
    restore();
    assert.equal(mutations(fixture, 'CreateCart'), creates + 1, 'exactly one create');
    assert.notEqual(recovered.id, cart.id);
    assert.equal(service(recovered, glove(recovered, 'black')).quantity, 1);
    // The known candidate stays discoverable in a record (now a terminal superseded one); nothing gates the new cart.
    assert.ok(Object.values(rawOps(fixture.storage)).some(raw => raw.includes(known.recovery.candidateCartId)));
    assert.ok(Object.keys(earlier).every(key => fixture.storage.getItem(key) !== null || !keys.includes(key)));
    assert.equal(fixture.storage.getItem(ACTIVE), recovered.id);
  });
}

test('MEDIUM-2: once a fresh attempt is sent, the attempts it superseded never resume and it is never resent', async () => {
  const { fixture, known } = await twoEarlierAttempts();
  const restore = interceptWrites(fixture.storage, (key, value) => key.startsWith(UNSAFE_RECORD_PREFIX) && value.includes('"stage":"created"') &&
    !value.includes(known.recovery.candidateCartId), () => { throw new Error('QuotaExceededError'); });
  fixture.failAfterNextMutation(1);
  await assert.rejects((await tab(fixture)).recoverCart({ binding: await recoveryBindingOf(fixture), abandonUnconfirmed: true }), error => error.code === 'uncertain');
  restore();
  // The new attempt's create was sent: only it is current, and it is never resent automatically.
  const creates = mutations(fixture, 'CreateCart');
  await assert.rejects((await tab(fixture)).recoverCart(), error => error.code === 'recovery-unconfirmed');
  assert.equal(mutations(fixture, 'CreateCart'), creates);
});

// ---- Recovery returns the freshly confirmed candidate ----

test('recovery returns the authoritative candidate, not a stale attachment response', async () => {
  const fixture = shopifyFixture({ discountCodes: [{ code: 'KEEP', applicable: true }] });
  await fixture.commerce.listProducts();
  await fixture.commerce.addProduct('black', true);
  fixture.setApiError(true);
  await assert.rejects(fixture.commerce.addProduct('blue', false));
  fixture.setApiError(false);
  fixture.observeMutations(({ field }) => {
    if (field !== 'cartLinesAdd') return;
    fixture.observeMutations(null);
    fixture.transformNextMutationResponse(payload => {
      payload.cart.discountCodes = payload.cart.discountCodes.map(code => ({ ...code, applicable: false }));
      payload.cart.cost.subtotalAmount.amount = '999.00';
      for (const node of payload.cart.lines.nodes) node.cost.totalAmount.amount = '999.00';
    });
  });
  const recovered = await (await tab(fixture)).recoverCart();
  assert.equal(recovered.subtotal, 175, 'prices come from the confirmed read');
  assert.deepEqual(recovered.discountCodes, [{ code: 'KEEP', applicable: true }]);
  assert.equal(glove(recovered, 'black').lineTotal.amount, 155);
  assert.equal(fixture.storage.getItem(ACTIVE), recovered.id);
  assert.deepEqual(unsafeOps(fixture.storage).filter(record => record.status !== 'terminal'), []);
});

test('a saved service whose quantity differs from its glove is never adopted', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  const cart = await fixture.commerce.addProduct('black', true);
  fixture.setApiError(true);
  await assert.rejects(fixture.commerce.addProduct('blue', false));
  fixture.setApiError(false);
  let attached = false;
  const recovering = await hookedTab(fixture, { after: ({ query, variables, payload }) => {
    if (query.includes('mutation AddLines') && variables.cartId !== cart.id) attached = true;
    if (attached && isCartRead(query) && variables.id !== cart.id) {
      for (const node of payload.data.cart.lines.nodes) if (node.parentRelationship) node.quantity = 2;
    }
    return payload;
  } });
  await assert.rejects(recovering.recoverCart());
  assert.equal(fixture.storage.getItem(ACTIVE), cart.id);
  assert.ok(recoveryRecords(fixture.storage).length);
});
