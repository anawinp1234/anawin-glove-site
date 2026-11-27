// Phase 6 Task 2G: structural transaction-integrity invariants behind five independent reproductions.
// Each test is a permanent negative control. It asserts the visible outcome and the saved fixture, cart
// and journal state (stored bytes, Shopify-side carts, mutation counts and checkout navigation).
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
const namesCandidate = (storage, id) => Object.values(rawOps(storage)).some(value => value.includes(id));
function hookedTab(fixture, { before, after } = {}) {
  const fetchImpl = async (url, options) => {
    const { query, variables } = JSON.parse(options.body);
    const early = await before?.({ query, variables, url, options });
    if (early) return early;
    const response = await fixture.fetchImpl(url, options);
    if (!response.ok || !after) return response;
    const payload = await response.json();
    return answer(await after({ query, variables, payload }) ?? payload);
  };
  return loaded(createShopifyCommerce(fixture.config, fixture.storage, fetchImpl, fixture.locks));
}
async function checkoutAttempt(commerce, cart) {
  let navigated = 0;
  const result = await commerce.checkout(cart, {}, () => { navigated++; });
  return { navigated, status: result.status, result };
}
// Clicks Checkout repeatedly the way the drawer does: each click carries the cart the last answer showed.
async function repeatedCheckout(commerce, shown, clicks = 4) {
  const outcomes = [];
  let cart = shown;
  for (let click = 0; click < clicks; click++) {
    const outcome = await checkoutAttempt(commerce, cart);
    outcomes.push(outcome);
    if (outcome.result.cart) cart = outcome.result.cart;
  }
  return outcomes;
}
async function unsafeCart(options = {}, { breakIn = false } = {}) {
  const fixture = shopifyFixture(options);
  await fixture.commerce.listProducts();
  const cart = await fixture.commerce.addProduct('black', breakIn);
  fixture.setApiError(true);
  await assert.rejects(fixture.commerce.addProduct('blue', false), error => error.code === 'uncertain');
  fixture.setApiError(false);
  return { fixture, cart };
}

// ---- 1. No cart ID is lost from any create response ----

// Shopify persists the cart but answers in a shape the ordinary path cannot confirm.
const createReplies = {
  // Shopify saved an empty cart (nothing added) and reports why: a complete, empty, non-null cart.
  'a complete empty cart with userErrors': {
    persistEmpty: true,
    reply: payload => ({ data: { cartCreate: { ...payload.data.cartCreate, userErrors: [{ message: 'Merchandise unavailable' }] } } })
  },
  'partial data with a GraphQL errors array': {
    reply: payload => ({ data: { cartCreate: { cart: { id: payload.data.cartCreate.cart.id } } }, errors: [{ message: 'Internal error' }] })
  },
  'partial data with a malformed errors object': {
    reply: payload => ({ data: { cartCreate: { cart: { id: payload.data.cartCreate.cart.id } } }, errors: { message: 'malformed' } })
  },
  'full data with a GraphQL errors array': {
    reply: payload => ({ ...payload, errors: [{ message: 'Throttled' }] })
  }
};
for (const [label, { persistEmpty = false, reply }] of Object.entries(createReplies)) {
  test(`1: a first create answered with ${label} journals the returned ID durably; exactly one CreateCart across reload`, async () => {
    const fixture = shopifyFixture();
    await fixture.commerce.listProducts();
    const shopper = await hookedTab(fixture, {
      before: ({ query, url, options }) => {
        if (!persistEmpty || !query.includes('mutation CreateCart')) return null;
        const body = JSON.parse(options.body);
        body.variables.input.lines = [];
        return fixture.fetchImpl(url, { ...options, body: JSON.stringify(body) }).then(async response => answer(reply(await response.json())));
      },
      after: ({ query, payload }) => query.includes('mutation CreateCart') ? reply(payload) : payload
    });
    await assert.rejects(shopper.addProduct('black', false), error => error.code === 'uncertain-create' && !error.definitiveRejection);
    const [record] = unsafeOps(fixture.storage);
    assert.equal(record.cartId, '*');
    assert.equal(record.candidateCartId, 'gid://shopify/Cart/c1?key=k1', 'the returned ID is journaled before the error is classified');
    assert.equal(fixture.storage.getItem(ACTIVE), null, 'an unverified cart never becomes active');
    for (const commerce of [shopper, await tab(fixture)]) {
      await assert.rejects(commerce.addProduct('black', false), error => error.code === 'create-unresolved');
      await assert.rejects(commerce.startNewCart(), error => error.code === 'create-reconcile-required');
      assert.equal((await commerce.getCart()).unconfirmedCandidate, true);
    }
    assert.equal(mutations(fixture, 'CreateCart'), 1, 'no second CreateCart');
    // Reconciliation reads the candidate with no write and adopts what Shopify holds.
    const reconciled = await (await tab(fixture)).reconcileUnconfirmedCart();
    assert.equal(reconciled.id, 'gid://shopify/Cart/c1?key=k1');
    assert.deepEqual(unsafeOps(fixture.storage).filter(record => record.status !== 'terminal'), []);
    assert.deepEqual(fixture.cartLines('gid://shopify/Cart/c1?key=k1').map(line => line.merchandise.id), persistEmpty ? [] : ['gid://variant/br16']);
    // The next add goes into that same cart: still exactly one CreateCart.
    const added = await (await tab(fixture)).addProduct('blue', false);
    assert.equal(added.id, 'gid://shopify/Cart/c1?key=k1');
    assert.equal(mutations(fixture, 'CreateCart'), 1);
  });
}

for (const [label, id] of [['a numeric ID', 42], ['an ID that is not a cart GID', 'javascript:alert(1)'], ['a blank ID', ' ']]) {
  test(`1: a create reply with ${label} is not trusted as a candidate, and still blocks a second create`, async () => {
    const fixture = shopifyFixture();
    await fixture.commerce.listProducts();
    const shopper = await hookedTab(fixture, { after: ({ query, payload }) => query.includes('mutation CreateCart')
      ? { data: { cartCreate: { cart: { id } } }, errors: [{ message: 'Internal error' }] } : payload });
    await assert.rejects(shopper.addProduct('black', false), error => error.code === 'uncertain-create');
    const [record] = unsafeOps(fixture.storage);
    assert.equal(record.cartId, '*');
    assert.equal(Object.hasOwn(record, 'candidateCartId'), false);
    await assert.rejects((await tab(fixture)).addProduct('black', false), error => error.code === 'create-unresolved');
    assert.equal(mutations(fixture, 'CreateCart'), 1);
  });
}

test('1: a recovery create answered with partial data and GraphQL errors keeps its ID; resume adopts without replaying', async () => {
  for (const errors of [[{ message: 'Internal error' }], { message: 'malformed' }]) {
    const { fixture, cart } = await unsafeCart({}, { breakIn: true });
    const attachments = mutations(fixture, 'AddLines');
    const recovering = await hookedTab(fixture, { after: ({ query, variables, payload }) =>
      query.includes('mutation CreateCart') ? { data: { cartCreate: { cart: { id: payload.data.cartCreate.cart.id } } }, errors } : payload });
    await assert.rejects(recovering.recoverCart(), error => error.code === 'uncertain');
    const [record] = recoveryRecords(fixture.storage);
    assert.equal(typeof record.recovery.candidateCartId, 'string', 'the candidate ID survives the error envelope');
    assert.equal(record.recovery.createUnverified, true);
    assert.equal(mutations(fixture, 'AddLines'), attachments, 'nothing is attached to an unverified create');
    assert.equal(fixture.storage.getItem(ACTIVE), cart.id);
    const creates = mutations(fixture, 'CreateCart');
    const recovered = await (await tab(fixture)).recoverCart();
    assert.equal(mutations(fixture, 'CreateCart'), creates, 'the create is never replayed');
    assert.equal(recovered.id, record.recovery.candidateCartId);
    assert.equal(service(recovered, glove(recovered, 'black')).quantity, 1);
  }
});

test('1: a fully lost create reply (after dispatch) blocks a second create across reload; a provably undispatched one does not', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  fixture.failAfterNextMutation();
  await assert.rejects(fixture.commerce.addProduct('black', false), error => error.code === 'uncertain-create');
  for (const commerce of [fixture.commerce, await tab(fixture)]) {
    await assert.rejects(commerce.addProduct('black', false), error => error.code === 'create-unresolved');
  }
  assert.equal(mutations(fixture, 'CreateCart'), 1);
  // Storage that refuses the journal: nothing is sent, so nothing is left unresolved.
  const refusing = shopifyFixture();
  await refusing.commerce.listProducts();
  const setItem = refusing.storage.setItem.bind(refusing.storage);
  refusing.storage.setItem = () => { throw new DOMException('refused', 'QuotaExceededError'); };
  await assert.rejects(refusing.commerce.addProduct('black', false), error => error.code === 'storage-unavailable');
  refusing.storage.setItem = setItem;
  assert.equal(mutations(refusing, 'CreateCart'), 0);
  assert.equal((await refusing.commerce.addProduct('black', false)).lines.length, 1);
});

// ---- 2. No contradictory hand or malformed money reaches checkout ----

const withGloveAttribute = (hand, handle = 'mi26') => ({ payload }) => {
  for (const cart of [payload.data?.cart, ...Object.values(payload.data || {}).map(value => value?.cart)].filter(Boolean)) {
    for (const node of cart.lines?.nodes || []) {
      if (!node.parentRelationship && node.merchandise.product.handle === handle) node.attributes = [...node.attributes, { key: 'Throwing Hand', value: hand }];
    }
  }
  return payload;
};
for (const [chosen, attribute] of [['right', 'Left'], ['left', 'Right']]) {
  test(`2: a ${chosen}-hand MI26 whose glove line says "Throwing Hand: ${attribute}" never navigates (4 clicks, reload)`, async () => {
    const fixture = shopifyFixture({ fullSize: true, checkoutHost: 'ignvv0-zh.myshopify.com' });
    await fixture.commerce.listProducts();
    const shown = await fixture.commerce.addProduct('full-mint', false, undefined, `gid://variant/mi26-${chosen}`);
    const contradicting = await hookedTab(fixture, { after: withGloveAttribute(attribute) });
    // Task 2H (row 3): invalid data is never returned as a cart; the read rejects with cart-unverified.
    await assert.rejects(contradicting.getCart(), error => error.code === 'cart-unverified');
    const outcomes = await repeatedCheckout(contradicting, shown);
    const reloaded = await hookedTab(fixture, { after: withGloveAttribute(attribute) });
    outcomes.push(...await repeatedCheckout(reloaded, shown, 2));
    assert.deepEqual(outcomes.map(outcome => outcome.navigated), [0, 0, 0, 0, 0, 0]);
    assert.ok(outcomes.every(outcome => outcome.status === 'blocked'));
    assert.deepEqual(unsafeOps(fixture.storage), [], 'no freeze or record from a refused checkout');
    // The same glove line naming the matching hand is honest.
    const matching = await hookedTab(fixture, { after: withGloveAttribute(chosen === 'right' ? 'Right' : 'Left') });
    assert.equal((await matching.getCart()).incomplete, false);
  });
}

test('2: a serviced glove whose service names another glove model never checks out', async () => {
  const fixture = shopifyFixture({ fullSize: true, checkoutHost: 'ignvv0-zh.myshopify.com' });
  await fixture.commerce.listProducts();
  const shown = await fixture.commerce.addProduct('full-mint', true, fullSizeOptions, 'gid://variant/mi26-right');
  const contradicting = await hookedTab(fixture, { after: ({ payload }) => {
    for (const node of payload.data?.cart?.lines.nodes || []) {
      if (node.parentRelationship) node.attributes = node.attributes.map(item => item.key === 'Glove Model' ? { ...item, value: 'BL50' } : item);
    }
    return payload;
  } });
  const outcomes = await repeatedCheckout(contradicting, shown);
  assert.deepEqual(outcomes.map(outcome => outcome.navigated), [0, 0, 0, 0]);
});

const moneyFaults = {
  'a missing subtotal amount': cart => { delete cart.cost.subtotalAmount.amount; },
  'a null subtotal amount': cart => { cart.cost.subtotalAmount.amount = null; },
  'a non-numeric subtotal': cart => { cart.cost.subtotalAmount.amount = 'abc'; },
  'a NaN subtotal': cart => { cart.cost.subtotalAmount.amount = 'NaN'; },
  'a negative subtotal': cart => { cart.cost.subtotalAmount.amount = '-1.00'; },
  'an infinite subtotal': cart => { cart.cost.subtotalAmount.amount = 'Infinity'; },
  'a missing subtotal currency': cart => { delete cart.cost.subtotalAmount.currencyCode; },
  'a malformed currency': cart => { cart.cost.subtotalAmount.currencyCode = 'usd '; },
  'a missing cost': cart => { delete cart.cost; },
  'a missing line total': cart => { delete cart.lines.nodes[0].cost.totalAmount.amount; },
  'a negative line subtotal': cart => { cart.lines.nodes[0].cost.subtotalAmount.amount = '-5'; },
  'a line in another currency': cart => { cart.lines.nodes[0].cost.subtotalAmount.currencyCode = 'CAD'; },
  'a non-numeric discount allocation': cart => { cart.lines.nodes[0].allDiscountAllocations = [{ discountedAmount: { amount: 'x', currencyCode: 'USD' }, targetType: 'LINE_ITEM', sourceDiscountApplication: {} }]; }
};
for (const [label, fault] of Object.entries(moneyFaults)) {
  test(`2: a fresh cart with ${label} blocks checkout on every click and after reload`, async () => {
    const fixture = shopifyFixture({ checkoutHost: 'ignvv0-zh.myshopify.com' });
    await fixture.commerce.listProducts();
    const shown = await fixture.commerce.addProduct('black', false);
    const faulty = { after: ({ query, payload }) => {
      if (isCartRead(query) && payload.data?.cart) fault(payload.data.cart);
      return payload;
    } };
    const broken = await hookedTab(fixture, faulty);
    // Bad values make the cart incomplete; a reply with no cost object at all is unreadable.
    const read = await broken.getCart().catch(error => ({ ...shown, unreadable: error.code }));
    assert.ok(read.incomplete === true || read.unreadable === 'cart-unverified');
    const outcomes = await repeatedCheckout(broken, shown);
    outcomes.push(...await repeatedCheckout(await hookedTab(fixture, faulty), read, 2));
    assert.deepEqual(outcomes.map(outcome => outcome.navigated), [0, 0, 0, 0, 0, 0]);
    assert.ok(outcomes.every(outcome => outcome.status === 'blocked' && typeof outcome.result.message === 'string'));
    assert.deepEqual(unsafeOps(fixture.storage).filter(record => record.status !== 'terminal'), []);
    // The same cart with Shopify's real totals still checks out.
    assert.equal((await checkoutAttempt(await tab(fixture), shown)).navigated, 1);
  });
}

test('2: a legitimate price change asks for review once and then checks out with Shopify\'s price', async () => {
  const cartPrices = {};
  const fixture = shopifyFixture({ checkoutHost: 'ignvv0-zh.myshopify.com', cartPrices });
  await fixture.commerce.listProducts();
  const shown = await fixture.commerce.addProduct('black', false);
  cartPrices.br16 = '165.00';
  const [first, second] = await repeatedCheckout(await tab(fixture), shown, 2);
  assert.equal(first.status, 'review');
  assert.equal(first.result.cart.subtotal, 165);
  assert.equal(second.navigated, 1);
});

test('2: honest trainer, serviced trainer and full-size carts of both hands still check out', async () => {
  for (const [productId, breakIn, merchandiseId] of [['black', false, null], ['brown', true, null],
    ['full-mint', false, 'gid://variant/mi26-left'], ['full-mint', true, 'gid://variant/mi26-right']]) {
    const fixture = shopifyFixture({ fullSize: true, checkoutHost: 'ignvv0-zh.myshopify.com' });
    await fixture.commerce.listProducts();
    const cart = await fixture.commerce.addProduct(productId, breakIn, productId.startsWith('full-') ? fullSizeOptions : undefined, merchandiseId);
    assert.equal((await checkoutAttempt(await tab(fixture), cart)).navigated, 1, `${productId} ${breakIn}`);
  }
});

// ---- 3. Reads and refreshes never delete ownership ----

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
    ['a malformed envelope', { data: { cart: null }, errors: { message: 'malformed' } }],
    ['an omitted cart', { data: {} }]]) {
    test(`3: a refused ${action} (${label}), then Check cart, getCart, peekCart and reload, never write storage`, async () => {
      const { fixture, cart, shown } = await reviewedMismatch();
      const before = everything(fixture.storage);
      const writes = mutations(fixture);
      const reading = await hookedTab(fixture, { before: ({ query, variables }) =>
        isCartRead(query) && variables.id === cart.id ? answer(envelope) : null });
      for (let attempt = 0; attempt < 3; attempt++) {
        await assert.rejects(action === 'keep' ? reading.keepUnconfirmedCart(shown) : reading.discardUnconfirmedCart(shown));
        await reading.peekCart().catch(() => null);
        // The drawer's Check cart button, then its ordinary redraw.
        await reading.refreshCart().catch(() => null);
        await reading.getCart().catch(() => null);
        const reloaded = await hookedTab(fixture, { before: ({ query, variables }) =>
          isCartRead(query) && variables.id === cart.id ? answer(envelope) : null });
        await reloaded.getCart().catch(() => null);
        assert.deepEqual(everything(fixture.storage), before, `round ${attempt + 1}: every stored byte unchanged`);
      }
      assert.equal(fixture.storage.getItem(ACTIVE), cart.id);
      assert.equal(mutations(fixture), writes, 'no Shopify write');
      // Once Shopify answers again, the reviewed cart is still owned and the shopper's choice still applies.
      const resolved = action === 'keep' ? await (await tab(fixture)).keepUnconfirmedCart(shown) : await (await tab(fixture)).discardUnconfirmedCart(shown);
      assert.equal(resolved.id, action === 'keep' ? cart.id : null);
    });
  }
}

test('3: a cart Shopify reports missing is shown, never forgotten by a read; the next add replaces it explicitly', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  const expired = await fixture.commerce.addProduct('black', false);
  fixture.expireCart();
  const before = everything(fixture.storage);
  for (const read of ['getCart', 'peekCart', 'refreshCart']) await fixture.commerce[read]();
  assert.deepEqual(everything(fixture.storage), before);
  const shown = await fixture.commerce.getCart();
  assert.deepEqual(shown.lines, []);
  assert.notEqual(shown.incomplete, true, 'a missing cart with no records is simply empty');
  const added = await fixture.commerce.addProduct('blue', false);
  assert.notEqual(added.id, expired.id);
  assert.equal(fixture.storage.getItem(ACTIVE), added.id);
});

test('3: a missing cart that still has records is never forgotten by a write either; Start a new cart keeps the records', async () => {
  const { fixture, cart } = await unsafeCart();
  fixture.expireCart();
  const records = rawOps(fixture.storage);
  const view = await (await tab(fixture)).getCart();
  assert.equal(view.cartMissing, true);
  await assert.rejects((await tab(fixture)).addProduct('blue', false), error => error.code === 'cart-unresolved');
  assert.equal(fixture.storage.getItem(ACTIVE), cart.id);
  assert.deepEqual(rawOps(fixture.storage), records);
  // The shopper's explicit choice, after a fresh explicit null under the lock, forgets only the active ID.
  const fresh = await (await tab(fixture)).startNewCart();
  assert.equal(fresh.id, null);
  assert.equal(fixture.storage.getItem(ACTIVE), null);
  assert.deepEqual(rawOps(fixture.storage), records, 'every record naming the old cart is kept');
  assert.equal((await (await tab(fixture)).addProduct('blue', false)).lines.length, 1);
});

test('3: Start a new cart refuses a cart Shopify still has or answers unclearly', async () => {
  for (const envelope of [null, { data: {} }, { data: { cart: null }, errors: [{ message: 'Throttled' }] }]) {
    const { fixture, cart } = await unsafeCart();
    const before = everything(fixture.storage);
    const shopper = await hookedTab(fixture, { before: ({ query }) => envelope && isCartRead(query) ? answer(envelope) : null });
    await shopper.startNewCart().catch(() => null);
    assert.equal(fixture.storage.getItem(ACTIVE), cart.id);
    assert.deepEqual(everything(fixture.storage), before);
  }
});

test('3: a serviced cart missing its service attributes is observed with zero writes; glove-only recovery still works', async () => {
  const fixture = shopifyFixture({ checkoutHost: 'ignvv0-zh.myshopify.com' });
  await fixture.commerce.listProducts();
  const cart = await fixture.commerce.addProduct('black', true);
  fixture.lines.find(line => !line.parentRelationship).attributes = [{ key: '_anawin_service', value: 'break-in' }];
  fixture.lines.find(line => line.parentRelationship).attributes = [];
  const before = everything(fixture.storage);
  const observer = await tab(fixture);
  const views = [];
  for (const read of ['peekCart', 'getCart', 'refreshCart']) views.push(await observer[read]());
  views.push(await (await tab(fixture)).getCart());
  assert.deepEqual(everything(fixture.storage), before, 'reads never write a safety record');
  for (const view of views) {
    assert.equal(view.incomplete, true);
    assert.equal(view.gloveOnlyRecoveryAvailable, true);
  }
  // Protection is kept without records: checkout and every write refuse.
  assert.equal((await checkoutAttempt(observer, views[0])).navigated, 0);
  for (const write of [() => observer.addProduct('blue', false), () => observer.removeLine(glove(views[0], 'black').remoteLineId),
    () => observer.setLineQuantity(glove(views[0], 'black').remoteLineId, 2), () => observer.applyDiscountCode('SAVE')]) {
    await assert.rejects(write());
  }
  assert.equal(mutations(fixture), 1, 'only the original create');
  await assert.rejects(observer.recoverCart(), error => error.code === 'recovery-ambiguous');
  // The explicit glove-only choice journals its safety record before anything is sent.
  const recovered = await observer.recoverCart({ withoutBreakIn: true });
  assert.notEqual(recovered.id, cart.id);
  assert.equal(recovered.lines.some(line => line.isBreakIn), false);
  assert.equal(recovered.incomplete, false);
});

// ---- 4. Superseded recovery references survive a post-dispatch rejection ----

async function twoEarlierAttempts() {
  const { fixture, cart } = await unsafeCart({ checkoutHost: 'ignvv0-zh.myshopify.com' }, { breakIn: true });
  fixture.failAfterNextMutation(2);
  await assert.rejects((await tab(fixture)).recoverCart(), error => error.code === 'uncertain');
  const [known] = recoveryRecords(fixture.storage);
  const { key: _key, ...knownRecord } = known;
  fixture.storage.setItem(`${UNSAFE_RECORD_PREFIX}interrupted-retry`, JSON.stringify({ ...knownRecord, createdAt: knownRecord.createdAt + 1,
    dispatched: true, recovery: { ...knownRecord.recovery, stage: 'create', candidateCartId: undefined } }));
  // A record for another cart, owned by nobody here.
  fixture.storage.setItem(`${UNSAFE_RECORD_PREFIX}foreign`, JSON.stringify({ cartId: 'gid://shopify/Cart/cforeign?key=kforeign', kind: 'recovery', kinds: ['recovery'],
    status: 'pending', createdAt: 1, dispatched: true, recovery: { stage: 'created', candidateCartId: 'gid://shopify/Cart/cforeign-candidate?key=kforeign-candidate' } }));
  return { fixture, cart, known };
}
const retryRejections = {
  'HTTP 422': fixture => fixture.rejectNextMutation(),
  'cart: null with userErrors': fixture => fixture.transformNextMutationResponse(payload => { payload.cart = null; payload.userErrors = [{ message: 'Rejected' }]; }),
  'a lost reply': fixture => fixture.failAfterNextMutation(),
  'partial data with errors': null
};
for (const [label, inject] of Object.entries(retryRejections)) {
  test(`4: a fresh recovery whose create meets ${label} keeps the superseded candidate discoverable; nothing is replayed`, async () => {
    const { fixture, cart, known } = await twoEarlierAttempts();
    const foreign = fixture.storage.getItem(`${UNSAFE_RECORD_PREFIX}foreign`);
    const writes = mutations(fixture);
    const retrying = inject ? await tab(fixture) : await hookedTab(fixture, { after: ({ query, payload }) => query.includes('mutation CreateCart')
      ? { data: { cartCreate: { cart: { id: payload.data.cartCreate.cart.id } } }, errors: [{ message: 'Internal' }] } : payload });
    inject?.(fixture);
    await assert.rejects(retrying.recoverCart({ binding: await recoveryBindingOf(fixture), abandonUnconfirmed: true }));
    assert.equal(mutations(fixture), writes + 1, 'exactly the one dispatched create');
    assert.equal(namesCandidate(fixture.storage, known.recovery.candidateCartId), true, 'the earlier candidate stays named durably');
    assert.equal(fixture.storage.getItem(`${UNSAFE_RECORD_PREFIX}foreign`), foreign, 'a foreign record is untouched');
    assert.equal(fixture.storage.getItem(ACTIVE), cart.id, 'the source stays active');
    // Reload: still blocked, still recoverable, nothing purchasable and nothing sent automatically.
    const reloaded = await tab(fixture);
    const shown = await reloaded.getCart();
    assert.equal(shown.incomplete, true);
    assert.equal(shown.recoveryUnconfirmed, true, 'the drawer still offers safe recovery');
    assert.equal((await checkoutAttempt(reloaded, shown)).navigated, 0);
    const creates = mutations(fixture, 'CreateCart');
    const resumed = await reloaded.recoverCart().catch(() => null);
    assert.equal(mutations(fixture, 'CreateCart'), creates, 'resuming never replays a create');
    if (resumed) {
      // Only a new attempt that kept its own candidate can resume: verified by Shopify's read, then attached once.
      assert.equal(label, 'partial data with errors');
      assert.equal(service(resumed, glove(resumed, 'black')).quantity, 1);
      return;
    }
    assert.equal(mutations(fixture), writes + 1, 'nothing else is sent');
    assert.equal(namesCandidate(fixture.storage, known.recovery.candidateCartId), true);
    // The shopper's explicit fresh attempt still works exactly once.
    const recovered = await (await tab(fixture)).recoverCart({ binding: await recoveryBindingOf(fixture), abandonUnconfirmed: true });
    assert.notEqual(recovered.id, cart.id);
    assert.equal(service(recovered, glove(recovered, 'black')).quantity, 1);
    assert.equal(fixture.storage.getItem(`${UNSAFE_RECORD_PREFIX}foreign`), foreign);
  });
}

// Task 2H (row 1): an HTTP status after invocation never settles a step, so a first recovery attempt answered 422
// stays as an unresolved journal beside the untouched source records; resuming it sends nothing.
test('4: a first recovery attempt answered HTTP 422 after dispatch stays unresolved; nothing is resent', async () => {
  const { fixture, cart } = await unsafeCart({}, { breakIn: true });
  const before = rawOps(fixture.storage);
  fixture.rejectNextMutation();
  await assert.rejects((await tab(fixture)).recoverCart(), error => error.code === 'uncertain');
  for (const [key, raw] of Object.entries(before)) assert.equal(fixture.storage.getItem(key), raw);
  assert.equal(recoveryRecords(fixture.storage).length, 1);
  assert.equal(fixture.storage.getItem(ACTIVE), cart.id);
  const sent = mutations(fixture);
  await assert.rejects((await tab(fixture)).recoverCart(), error => error.code === 'recovery-unconfirmed');
  assert.equal(mutations(fixture), sent);
});

// ---- 5. Recovery replies use the same strict shape; the returned cart is the fresh verified read ----

test('5: a recovery attachment answered with GraphQL errors is never replayed; reconciliation adopts the fresh read', async () => {
  const { fixture, cart } = await unsafeCart({}, { breakIn: true });
  const recovering = await hookedTab(fixture, { after: ({ query, payload }) =>
    query.includes('mutation AddLines') ? { ...payload, errors: [{ message: 'Internal' }] } : payload });
  await assert.rejects(recovering.recoverCart(), error => error.code === 'uncertain');
  assert.equal(recoveryRecords(fixture.storage)[0].recovery.stage, 'children');
  assert.equal(fixture.storage.getItem(ACTIVE), cart.id);
  const attachments = mutations(fixture, 'AddLines');
  let candidateReads = 0;
  const resuming = await hookedTab(fixture, { after: ({ query, variables, payload }) => {
    if (isCartRead(query) && variables.id !== cart.id) candidateReads++;
    return payload;
  } });
  const recovered = await resuming.recoverCart();
  assert.equal(mutations(fixture, 'AddLines'), attachments, 'no blind replay');
  assert.ok(candidateReads >= 1, 'adoption rests on a fresh read of the candidate');
  const parent = glove(recovered, 'black');
  assert.equal(service(recovered, parent).quantity, parent.quantity);
  assert.equal(service(recovered, parent).parentLineId, parent.remoteLineId);
  assert.deepEqual(service(recovered, parent).attributes, service(cart, glove(cart, 'black')).attributes);
  assert.deepEqual(unsafeOps(fixture.storage).filter(record => record.status !== 'terminal'), []);
});

// ---- Equivalent branches found in the Task 2G review ----

// Task 2H: no restore is ever attempted. The successor stays blocked beside its exact, untouched predecessors.
test('4: a post-dispatch rejection leaves the successor blocked beside its untouched predecessors; the next fresh attempt completes once', async () => {
  const { fixture, cart, known } = await twoEarlierAttempts();
  const attempts = recoveryRecords(fixture.storage).filter(record => record.cartId === cart.id).map(record => record.key);
  const setItem = fixture.storage.setItem.bind(fixture.storage);
  let dispatched = false;
  fixture.observeMutations(({ field }) => { if (field === 'cartCreate') dispatched = true; });
  fixture.storage.setItem = (key, value) => {
    if (dispatched && attempts.includes(key)) throw new DOMException('refused', 'QuotaExceededError');
    return setItem(key, value);
  };
  fixture.rejectNextMutation();
  await assert.rejects((await tab(fixture)).recoverCart({ binding: await recoveryBindingOf(fixture), abandonUnconfirmed: true }), error => error.code === 'uncertain');
  fixture.storage.setItem = setItem;
  fixture.observeMutations(null);
  const current = recoveryRecords(fixture.storage).filter(record => record.cartId === cart.id);
  assert.equal(current.length, 3, 'both predecessors and the successor remain');
  assert.ok(attempts.every(key => current.some(record => record.key === key)));
  assert.ok(current.some(record => record.recovery.candidateCartId === known.recovery.candidateCartId));
  const reloaded = await tab(fixture);
  const shown = await reloaded.getCart();
  assert.equal(shown.recoveryUnconfirmed, true);
  const creates = mutations(fixture, 'CreateCart');
  await assert.rejects(reloaded.recoverCart(), error => error.code === 'recovery-unconfirmed');
  assert.equal(mutations(fixture, 'CreateCart'), creates);
  // The next explicit fresh attempt carries the references on, then completes once.
  const recovered = await (await tab(fixture)).recoverCart({ binding: await recoveryBindingOf(fixture), abandonUnconfirmed: true });
  assert.notEqual(recovered.id, cart.id);
  assert.equal(mutations(fixture, 'CreateCart'), creates + 1);
});

test('3: a checkout freeze on a cart Shopify still has refuses an add with no request; once Shopify reports it gone the add starts a new cart', async () => {
  const fixture = shopifyFixture({ checkoutHost: 'ignvv0-zh.myshopify.com' });
  await fixture.commerce.listProducts();
  const cart = await fixture.commerce.addProduct('black', false);
  assert.equal((await checkoutAttempt(await tab(fixture), cart)).navigated, 1);
  const frozen = rawOps(fixture.storage);
  const writes = mutations(fixture);
  await assert.rejects((await tab(fixture)).addProduct('blue', false), error => error.code === 'cart-unresolved');
  assert.equal(mutations(fixture), writes, 'nothing is sent to a frozen cart');
  assert.deepEqual(rawOps(fixture.storage), frozen);
  // The checkout completed: Shopify has no such cart. Reads keep it; the add replaces it and keeps the freeze record.
  fixture.expireCart();
  const shown = await (await tab(fixture)).getCart();
  assert.deepEqual(shown.lines, []);
  assert.notEqual(shown.incomplete, true);
  assert.equal(fixture.storage.getItem(ACTIVE), cart.id);
  const added = await (await tab(fixture)).addProduct('blue', false);
  assert.notEqual(added.id, cart.id);
  assert.equal(added.incomplete, false);
  assert.deepEqual(rawOps(fixture.storage), frozen, 'the old freeze record is kept, inert');
});

test('1: a returned first-cart ID that storage refuses to journal still blocks a second cart in this tab', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  const setItem = fixture.storage.setItem.bind(fixture.storage);
  fixture.storage.setItem = (key, value) => {
    if (key.startsWith(UNSAFE_RECORD_PREFIX) && String(value).includes('candidateCartId')) throw new DOMException('refused', 'QuotaExceededError');
    return setItem(key, value);
  };
  fixture.transformNextMutationResponse(payload => { payload.userErrors = [{ message: 'Partial failure' }]; payload.cart = { id: payload.cart.id }; });
  await assert.rejects(fixture.commerce.addProduct('black', false), error => error.code === 'uncertain-create');
  fixture.storage.setItem = setItem;
  await assert.rejects(fixture.commerce.addProduct('black', false), error => error.code === 'create-unresolved');
  await assert.rejects(fixture.commerce.startNewCart(), error => error.code === 'create-reconcile-required');
  assert.equal((await fixture.commerce.getCart()).unconfirmedCandidate, true);
  assert.equal(mutations(fixture, 'CreateCart'), 1);
});

test('1: existing-cart updates and discount writes answered with partial data and GraphQL errors stay unresolved and are never replayed', async () => {
  for (const write of [commerce => commerce.addProduct('blue', false), commerce => commerce.applyDiscountCode('SAVE10')]) {
    const fixture = shopifyFixture();
    await fixture.commerce.listProducts();
    const cart = await fixture.commerce.addProduct('black', false);
    const partial = await hookedTab(fixture, { after: ({ query, payload }) => /^mutation/.test(query)
      ? { data: Object.fromEntries(Object.entries(payload.data).map(([field, value]) => [field, { cart: { id: value.cart.id } }])), errors: [{ message: 'Internal' }] } : payload });
    await assert.rejects(write(partial), error => error.code === 'uncertain');
    const writes = mutations(fixture);
    await assert.rejects(write(await tab(fixture)));
    assert.equal(mutations(fixture), writes, 'the unresolved write blocks the next one');
    assert.equal(fixture.storage.getItem(ACTIVE), cart.id);
    assert.equal((await checkoutAttempt(await tab(fixture), await (await tab(fixture)).getCart())).navigated, 0);
  }
});
