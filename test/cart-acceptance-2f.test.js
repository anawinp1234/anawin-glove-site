// Phase 6 Task 2F: five independently reproduced acceptance blockers. Each test is a permanent negative
// control and asserts both the visible outcome and the saved fixture, cart and journal state.
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
const sourceRecords = storage => Object.fromEntries(Object.entries(rawOps(storage)).filter(([, value]) => !value.includes('"kind":"recovery"')));
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
async function checkoutAttempt(commerce, cart) {
  let navigated = false;
  const result = await commerce.checkout(cart, {}, () => { navigated = true; });
  return { navigated, status: result.status };
}
// The next mutation of `field` gets its payload rewritten.
const rewriteNext = (fixture, field, rewrite) => fixture.observeMutations(({ field: sent }) => {
  if (sent !== field) return;
  fixture.observeMutations(null);
  fixture.transformNextMutationResponse(rewrite);
});
async function unsafeCart(options = {}, { breakIn = false } = {}) {
  const fixture = shopifyFixture(options);
  await fixture.commerce.listProducts();
  const cart = await fixture.commerce.addProduct('black', breakIn);
  fixture.setApiError(true);
  await assert.rejects(fixture.commerce.addProduct('blue', false), error => error.code === 'uncertain');
  fixture.setApiError(false);
  return { fixture, cart };
}

// Task 2H (row 3): invalid data is never returned as a cart. A read of it rejects with cart-unverified, and the
// drawer keeps an unverified view with checkout disabled; this is that view.
const observed = commerce => commerce.getCart().catch(error => {
  assert.equal(error.code, 'cart-unverified');
  return { id: null, lines: [], incomplete: true, unverified: true };
});

// ---- HIGH-1: a create reply naming a cart is never a rejection, and its ID is journaled ----

const createReplies = {
  'an ID-only cart with valid userErrors': payload => { payload.cart = { id: payload.cart.id }; payload.userErrors = [{ message: 'Partial failure' }]; },
  'a cart missing required fields': payload => { payload.cart = { id: payload.cart.id, lines: { nodes: [], pageInfo: { hasNextPage: false } } }; },
  'missing userErrors': payload => { delete payload.userErrors; },
  'malformed userErrors': payload => { payload.userErrors = { message: 'malformed' }; }
};
for (const [label, rewrite] of Object.entries(createReplies)) {
  // Task 2H: a clean envelope with an ID-only (non-null) cart is eligible for forward progress; the fresh
  // authoritative read of that ID, never the reply's contents, verifies and settles the add.
  if (label === 'a cart missing required fields') {
    test(`HIGH-1: a first create reply with ${label} settles only from the fresh read of its ID; exactly one CreateCart`, async () => {
      const fixture = shopifyFixture();
      await fixture.commerce.listProducts();
      fixture.transformNextMutationResponse(rewrite);
      const cart = await fixture.commerce.addProduct('black', false);
      assert.equal(cart.id, 'gid://shopify/Cart/c1?key=k1');
      assert.equal(cart.incomplete, false);
      assert.equal(fixture.storage.getItem(ACTIVE), cart.id);
      assert.deepEqual(unsafeOps(fixture.storage).filter(record => record.status !== 'terminal'), []);
      assert.equal(mutations(fixture, 'CreateCart'), 1);
    });
    continue;
  }
  test(`HIGH-1: a first create reply with ${label} keeps the journal and its candidate; no second cart after reload`, async () => {
    const fixture = shopifyFixture();
    await fixture.commerce.listProducts();
    fixture.transformNextMutationResponse(rewrite);
    await assert.rejects(fixture.commerce.addProduct('black', false), error => error.code === 'uncertain-create' && !error.definitiveRejection);
    const [record] = unsafeOps(fixture.storage);
    assert.equal(record.cartId, '*');
    assert.equal(record.candidateCartId, 'gid://shopify/Cart/c1?key=k1', 'the returned ID is journaled durably');
    assert.equal(fixture.storage.getItem(ACTIVE), null);
    const reloaded = await tab(fixture);
    await assert.rejects(reloaded.addProduct('black', false), error => error.code === 'create-unresolved');
    await assert.rejects(reloaded.startNewCart({ abandonUnknown: true, binding: (await reloaded.getCart()).abandonmentBinding }), error => error.code === 'create-reconcile-required');
    assert.equal(mutations(fixture, 'CreateCart'), 1, 'no second CreateCart');
    // The saved cart stays discoverable: reconciliation reads it and adopts exactly what was sent.
    const adopted = await reloaded.reconcileUnconfirmedCart();
    assert.equal(adopted.id, 'gid://shopify/Cart/c1?key=k1');
    assert.equal(adopted.incomplete, false);
    assert.deepEqual(fixture.cartLines('gid://shopify/Cart/c1?key=k1').map(line => line.merchandise.id), ['gid://variant/br16']);
    assert.equal(mutations(fixture, 'CreateCart'), 1);
  });
}

// Task 2H: a clean `cart: null` with userErrors on a mutation leaves the remote outcome unresolved: it stays armed
// (ID-less), and only the shopper's affirmative abandonment, which sends nothing, allows another create.
test('HIGH-1: cart: null with userErrors and a lost reply both keep the journal; no create without abandonment', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  fixture.setUserError('Merchandise unavailable');
  // The fixture's userError reply carries an (empty) cart; Shopify's rejection carries cart: null.
  const rejecting = await hookedTab(fixture, { after: ({ query, payload }) => {
    if (query.includes('mutation CreateCart')) payload.data.cartCreate.cart = null;
    return payload;
  } });
  await assert.rejects(rejecting.addProduct('black', false), error => error.code === 'uncertain-create' && !error.definitiveRejection);
  fixture.setUserError('');
  assert.equal(unsafeOps(fixture.storage)[0].candidateCartId, undefined);
  await assert.rejects(fixture.commerce.addProduct('black', false), error => error.code === 'create-unresolved');
  await fixture.commerce.startNewCart({ abandonUnknown: true, binding: (await fixture.commerce.getCart()).abandonmentBinding });
  fixture.failAfterNextMutation();
  await assert.rejects(fixture.commerce.addProduct('black', false), error => error.code === 'uncertain-create');
  await assert.rejects((await tab(fixture)).addProduct('black', false), error => error.code === 'create-unresolved');
  assert.equal(mutations(fixture, 'CreateCart'), 2, 'the rejected create and the lost one; never a third');
});

// ---- HIGH-2: wrong-hand data never checks out, however often checkout is tried ----

const reportHand = hand => ({ payload }) => {
  const carts = [payload.data?.cart, ...Object.values(payload.data || {}).map(value => value?.cart)].filter(Boolean);
  for (const cart of carts) for (const node of cart.lines.nodes) {
    if (!node.parentRelationship && node.merchandise.product.handle === 'mi26') node.merchandise.selectedOptions = [{ name: 'Throwing Hand', value: hand }];
  }
  return payload;
};
for (const [chosen, reported] of [['right', 'Left'], ['left', 'Right']]) {
  for (const breakIn of [false, true]) {
    test(`HIGH-2: a ${chosen}-hand cart later reported as ${reported} never navigates on repeated checkout or reload (${breakIn ? 'serviced' : 'unserviced'})`, async () => {
      const fixture = shopifyFixture({ fullSize: true, checkoutHost: 'ignvv0-zh.myshopify.com' });
      await fixture.commerce.listProducts();
      const shown = await fixture.commerce.addProduct('full-mint', breakIn, breakIn ? fullSizeOptions : undefined, `gid://variant/mi26-${chosen}`);
      assert.equal(shown.incomplete, false);
      const attempts = [];
      const contradicting = await hookedTab(fixture, { after: reportHand(reported) });
      attempts.push(await checkoutAttempt(contradicting, shown));
      // The second click carries whatever the drawer now shows.
      attempts.push(await checkoutAttempt(contradicting, await observed(contradicting)));
      attempts.push(await checkoutAttempt(contradicting, await observed(contradicting)));
      const reloaded = await hookedTab(fixture, { after: reportHand(reported) });
      const afterReload = await observed(reloaded);
      assert.equal(afterReload.incomplete, true, 'the contradiction is never accepted as a verified cart');
      attempts.push(await checkoutAttempt(reloaded, afterReload));
      assert.deepEqual(attempts.map(attempt => attempt.navigated), [false, false, false, false], 'zero navigations');
      // The honest cart still checks out, with Shopify's own prices.
      const honest = await (await tab(fixture)).getCart();
      assert.equal(honest.incomplete, false);
      assert.equal((await checkoutAttempt(await tab(fixture), honest)).navigated, true);
    });
  }
}

test('HIGH-2: a service whose Throwing Hand attribute contradicts its glove never checks out', async () => {
  const fixture = shopifyFixture({ fullSize: true, checkoutHost: 'ignvv0-zh.myshopify.com' });
  await fixture.commerce.listProducts();
  await fixture.commerce.addProduct('full-mint', true, fullSizeOptions, 'gid://variant/mi26-right');
  const contradicting = await hookedTab(fixture, { after: ({ payload }) => {
    for (const node of payload.data?.cart?.lines.nodes || []) {
      if (node.parentRelationship) node.attributes = node.attributes.map(attribute => attribute.key === 'Throwing Hand' ? { ...attribute, value: 'Left' } : attribute);
    }
    return payload;
  } });
  const cart = await observed(contradicting);
  assert.equal(cart.incomplete, true);
  for (let attempt = 0; attempt < 2; attempt++) assert.equal((await checkoutAttempt(contradicting, await observed(contradicting))).navigated, false);
});

test('HIGH-2: honest full-size carts of either hand and legacy trainer carts still check out', async () => {
  for (const [productId, merchandiseId] of [['full-mint', 'gid://variant/mi26-right'], ['full-mint', 'gid://variant/mi26-left'], ['black', null]]) {
    const fixture = shopifyFixture({ fullSize: true, checkoutHost: 'ignvv0-zh.myshopify.com' });
    await fixture.commerce.listProducts();
    const cart = await fixture.commerce.addProduct(productId, false, undefined, merchandiseId);
    assert.equal((await checkoutAttempt(await tab(fixture), cart)).navigated, true, `${productId} ${merchandiseId}`);
  }
});

// ---- MEDIUM-1: a refused consent leaves cart ownership alone, including the drawer's refresh ----

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
  return { fixture, cart, shown: await shopper.getCart() };
}
for (const action of ['keep', 'discard']) {
  for (const [label, envelope] of [['repeated explicit null', { data: { cart: null } }],
    ['a malformed envelope', { data: { cart: null }, errors: { message: 'malformed' } }]]) {
    test(`MEDIUM-1: a refused ${action} with ${label}, then the drawer's refresh read, keeps cart ownership byte-identical`, async () => {
      const { fixture, cart, shown } = await reviewedMismatch();
      const before = everything(fixture.storage);
      const writes = mutations(fixture);
      const reading = await hookedTab(fixture, { before: ({ query, variables }) =>
        isCartRead(query) && variables.id === cart.id ? answer(envelope) : null });
      for (let attempt = 0; attempt < 2; attempt++) {
        await assert.rejects(action === 'keep' ? reading.keepUnconfirmedCart(shown) : reading.discardUnconfirmedCart(shown));
        // What the drawer does after a refused consent: a side-effect-free read to redraw.
        const redraw = await reading.peekCart().catch(error => ({ error }));
        assert.ok(redraw === null || redraw.error || redraw.id === cart.id);
        assert.deepEqual(everything(fixture.storage), before, `attempt ${attempt + 1}: active ID and records unchanged`);
      }
      assert.equal(mutations(fixture), writes, 'no Shopify write');
      // With the real cart readable again, the reviewed snapshot still applies.
      const resolved = action === 'keep' ? await (await tab(fixture)).keepUnconfirmedCart(shown) : await (await tab(fixture)).discardUnconfirmedCart(shown);
      assert.equal(resolved.id, action === 'keep' ? cart.id : null);
    });
  }
}

test('MEDIUM-1: a side-effect-free redraw shows a changed cart for a fresh review without touching storage', async () => {
  const { fixture, shown } = await reviewedMismatch();
  await (await fixture.detached()).setLineQuantity(glove(shown, 'black').remoteLineId, 2);
  const before = everything(fixture.storage);
  const shopper = await tab(fixture);
  await assert.rejects(shopper.keepUnconfirmedCart(shown), error => error.code === 'cart-changed');
  const redraw = await shopper.peekCart();
  assert.equal(glove(redraw, 'black').quantity, 2);
  assert.equal(redraw.createMismatch, true);
  assert.notEqual(redraw.reviewStamp, shown.reviewStamp);
  assert.deepEqual(everything(fixture.storage), before);
});

// ---- MEDIUM-2: the known candidate stays durable even when rollback fails ----

async function twoEarlierAttempts() {
  const { fixture, cart } = await unsafeCart({ checkoutHost: 'ignvv0-zh.myshopify.com' }, { breakIn: true });
  fixture.failAfterNextMutation(2);
  await assert.rejects((await tab(fixture)).recoverCart(), error => error.code === 'uncertain');
  const [known] = recoveryRecords(fixture.storage);
  const { key: _key, ...knownRecord } = known;
  fixture.storage.setItem(`${UNSAFE_RECORD_PREFIX}interrupted-retry`, JSON.stringify({ ...knownRecord, createdAt: knownRecord.createdAt + 1,
    dispatched: true, recovery: { ...knownRecord.recovery, stage: 'create', candidateCartId: undefined } }));
  return { fixture, cart, known, attempts: recoveryRecords(fixture.storage).map(record => record.key) };
}
const namesCandidate = (storage, candidateCartId) => Object.values(rawOps(storage)).some(value => value.includes(candidateCartId));
// Task 2H: supersession is logical. A fresh attempt never removes, restores or withdraws earlier records before a
// verified resolution, so these rollback faults have nothing to fail. With removals and restores refused anyway,
// the attempt proceeds exactly once and the known candidate stays named in a durable record.
for (const failure of ['restoring the removed record fails', 'withdrawing the replacement fails after a restore']) {
  test(`MEDIUM-2: when ${failure} (no removal or restore is ever attempted), the known candidate stays durable and one create is sent`, async () => {
    const { fixture, cart, known, attempts } = await twoEarlierAttempts();
    const { setItem, removeItem } = { setItem: fixture.storage.setItem.bind(fixture.storage), removeItem: fixture.storage.removeItem.bind(fixture.storage) };
    let earlierTouchedBeforeDispatch = false;
    let dispatched = false;
    fixture.observeMutations(({ field }) => { if (field === 'cartCreate') dispatched = true; });
    fixture.storage.removeItem = key => {
      if (attempts.includes(key) && !dispatched) earlierTouchedBeforeDispatch = true;
      if (key === attempts[1]) throw new DOMException('refused', 'SecurityError');
      return removeItem(key);
    };
    fixture.storage.setItem = (key, value) => {
      if (attempts.includes(key) && !dispatched) earlierTouchedBeforeDispatch = true;
      return setItem(key, value);
    };
    const creates = mutations(fixture, 'CreateCart');
    const recovered = await (await tab(fixture)).recoverCart({ binding: await recoveryBindingOf(fixture), abandonUnconfirmed: true });
    fixture.storage.removeItem = removeItem;
    fixture.storage.setItem = setItem;
    fixture.observeMutations(null);
    assert.equal(earlierTouchedBeforeDispatch, false, 'earlier attempts are never removed or restored before a verified resolution');
    assert.equal(mutations(fixture, 'CreateCart'), creates + 1);
    assert.notEqual(recovered.id, cart.id);
    assert.equal(service(recovered, glove(recovered, 'black')).quantity, 1);
    assert.equal(namesCandidate(fixture.storage, known.recovery.candidateCartId), true, 'a durable record still names the known candidate');
  });
}

// ---- MEDIUM-3: recovery create and attachment replies must have their documented shape ----

const replyShapes = {
  'no userErrors': payload => { delete payload.userErrors; },
  'wrongly typed userErrors': payload => { payload.userErrors = 'none'; },
  'an ID-only cart': payload => { payload.cart = { id: payload.cart.id }; }
};
for (const [label, rewrite] of Object.entries(replyShapes)) {
  // Task 2H: a clean envelope with an ID-only (non-null) cart is eligible; the fresh authoritative read of that ID
  // decides, so recovery continues in the same attempt with exactly one create and one attachment.
  if (label === 'an ID-only cart') {
    test('MEDIUM-3: recovery CreateCart and AddLines replies with an ID-only cart continue only from fresh reads, never resent', async () => {
      for (const field of ['cartCreate', 'cartLinesAdd']) {
        const { fixture, cart } = await unsafeCart({}, { breakIn: true });
        const creates = mutations(fixture, 'CreateCart');
        const attachments = mutations(fixture, 'AddLines');
        rewriteNext(fixture, field, rewrite);
        const recovered = await (await tab(fixture)).recoverCart();
        assert.notEqual(recovered.id, cart.id, field);
        assert.equal(mutations(fixture, 'CreateCart'), creates + 1);
        assert.equal(mutations(fixture, 'AddLines'), attachments + 1);
        assert.equal(service(recovered, glove(recovered, 'black')).quantity, 1);
      }
    });
    continue;
  }
  test(`MEDIUM-3: a recovery CreateCart reply with ${label} keeps the candidate, attaches nothing and keeps the source frozen`, async () => {
    const { fixture, cart } = await unsafeCart({}, { breakIn: true });
    const before = sourceRecords(fixture.storage);
    const attachments = mutations(fixture, 'AddLines');
    rewriteNext(fixture, 'cartCreate', rewrite);
    await assert.rejects((await tab(fixture)).recoverCart(), error => error.code === 'uncertain');
    assert.equal(mutations(fixture, 'AddLines'), attachments, 'no attachment after an unverified create');
    assert.equal(fixture.storage.getItem(ACTIVE), cart.id);
    assert.deepEqual(sourceRecords(fixture.storage), before, 'the source freeze and safety records stay');
    const [record] = recoveryRecords(fixture.storage);
    assert.equal(record.recovery.stage, 'create');
    assert.equal(typeof record.recovery.candidateCartId, 'string', 'the returned ID is kept for read-only reconciliation');
    // An explicit check verifies the create from Shopify's own read before anything else is sent.
    const creates = mutations(fixture, 'CreateCart');
    const recovered = await (await tab(fixture)).recoverCart();
    assert.equal(mutations(fixture, 'CreateCart'), creates, 'the create is never replayed');
    assert.equal(recovered.id, record.recovery.candidateCartId);
    assert.equal(service(recovered, glove(recovered, 'black')).quantity, 1);
    assert.equal(mutations(fixture, 'AddLines'), attachments + 1, 'one attachment, after verification');
  });

  test(`MEDIUM-3: a recovery AddLines reply with ${label} is not adopted in the same attempt and is never replayed`, async () => {
    const { fixture, cart } = await unsafeCart({}, { breakIn: true });
    const before = sourceRecords(fixture.storage);
    rewriteNext(fixture, 'cartLinesAdd', rewrite);
    await assert.rejects((await tab(fixture)).recoverCart(), error => error.code === 'uncertain');
    assert.equal(fixture.storage.getItem(ACTIVE), cart.id, 'nothing is adopted from a malformed reply');
    assert.deepEqual(sourceRecords(fixture.storage), before);
    assert.equal(recoveryRecords(fixture.storage)[0].recovery.stage, 'children');
    const attachments = mutations(fixture, 'AddLines');
    // Explicit reconciliation: Shopify's read shows the attachment landed, so it is adopted without a resend.
    const recovered = await (await tab(fixture)).recoverCart();
    assert.equal(mutations(fixture, 'AddLines'), attachments);
    assert.notEqual(recovered.id, cart.id);
    assert.equal(service(recovered, glove(recovered, 'black')).quantity, 1);
  });
}

test('MEDIUM-3: malformed GraphQL errors on recovery replies stay ambiguous; honest replies still adopt in one attempt', async () => {
  for (const field of ['CreateCart', 'AddLines']) {
    const { fixture, cart } = await unsafeCart({}, { breakIn: true });
    const malformed = await hookedTab(fixture, { after: ({ query, variables, payload }) =>
      query.includes(`mutation ${field}`) && variables.cartId !== cart.id ? { ...payload, errors: { message: 'malformed' } } : payload });
    await assert.rejects(malformed.recoverCart(), error => error.code === 'uncertain');
    assert.equal(fixture.storage.getItem(ACTIVE), cart.id, field);
  }
  const { fixture, cart } = await unsafeCart({}, { breakIn: true });
  const recovered = await (await tab(fixture)).recoverCart();
  assert.notEqual(recovered.id, cart.id);
  assert.equal(service(recovered, glove(recovered, 'black')).quantity, 1);
  assert.deepEqual(unsafeOps(fixture.storage).filter(record => record.status !== 'terminal'), []);
});
