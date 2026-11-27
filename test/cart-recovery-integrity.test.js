// Phase 6 Task 2C: recovery integrity. Each section reproduces one independent-review finding.
import test from 'node:test';
import assert from 'node:assert/strict';
import { shopifyFixture, recoveryBindingOf } from '../test-support/shopify-fixture.js';
import { cartLineIdentity, commerceErrorMessage, createShopifyCommerce, UNSAFE_RECORD_PREFIX } from '../src/commerce.js';
import { cartFeedbackMarkup } from '../src/cart-feedback.js';

const ACTIVE = 'anawin-shopify-cart-id';
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
const mutations = (fixture, name = '') => fixture.requests.filter(request => /^mutation/.test(request.query) && request.query.includes(name)).length;
const glove = (cart, productId) => cart.lines.find(line => line.productId === productId && !line.isBreakIn);
const service = (cart, parent) => cart.lines.find(line => line.isBreakIn && line.parentLineId === parent.remoteLineId);
const shown = (cart, line) => ({ quantity: line.quantity, identity: cartLineIdentity(cart.lines, line) });
const escapeHtml = value => String(value).replace(/[&<>"]/g, character => `&#${character.charCodeAt(0)};`);
const serviceValue = line => line.attributes.find(attribute => attribute.key === '_anawin_service')?.value;
const isCartRead = query => query.includes('query Cart(');
// A tab whose Shopify traffic passes through `hooks`: `before` may answer instead of the fixture, and
// `after` may rewrite (or replace) a payload the fixture returned.
function hookedTab(fixture, { before, after } = {}) {
  const fetchImpl = async (url, options) => {
    const { query, variables } = JSON.parse(options.body);
    const early = await before?.({ query, variables });
    if (early) return early;
    const response = await fixture.fetchImpl(url, options);
    if (!response.ok || !after) return response;
    const payload = await response.json();
    const replaced = await after({ query, variables, payload });
    return { ok: true, json: async () => replaced ?? payload };
  };
  return loaded(createShopifyCommerce(fixture.config, fixture.storage, fetchImpl, fixture.locks));
}
const answer = payload => ({ ok: true, json: async () => payload });
function interceptWrites(storage, matches, behaviour) {
  const setItem = storage.setItem.bind(storage);
  storage.setItem = (key, value) => matches(key, String(value)) ? behaviour(setItem, key, value) : setItem(key, value);
  return () => { storage.setItem = setItem; };
}
// An existing cart whose last add got no answer, so recovery is the way forward.
async function unsafeCart(options = {}, { breakIn = false, productId = 'black', merchandiseId } = {}) {
  const fixture = shopifyFixture(options);
  await fixture.commerce.listProducts();
  const cart = await fixture.commerce.addProduct(productId, breakIn, undefined, merchandiseId);
  fixture.setApiError(true);
  await assert.rejects(fixture.commerce.addProduct('blue', false), error => error.code === 'uncertain');
  fixture.setApiError(false);
  return { fixture, cart };
}
const recoveryRecords = storage => unsafeOps(storage).filter(record => record.kind === 'recovery');
const checkoutBlocked = async (commerce, cart) => {
  let navigated = false;
  const result = await commerce.checkout(cart, {}, () => { navigated = true; });
  return result.status === 'blocked' && !navigated;
};

// ---- HIGH-1: every recovery response is bound to the journaled candidate ID ----

test('HIGH-1: an attachment response naming the frozen source cart is rejected and the checkout freeze holds', async () => {
  const fixture = shopifyFixture({ checkoutHost: 'ignvv0-zh.myshopify.com' });
  await fixture.commerce.listProducts();
  const cart = await fixture.commerce.addProduct('black', true);
  assert.equal((await fixture.commerce.checkout(cart, {}, () => {})).status, 'navigating');
  const freeze = rawOps(fixture.storage);
  assert.equal(Object.keys(freeze).length, 1);
  fixture.observeMutations(({ field }) => {
    if (field === 'cartLinesAdd') fixture.transformNextMutationResponse(payload => { payload.cart.id = cart.id; });
  });
  const recovering = await tab(fixture);
  await assert.rejects(recovering.recoverCart(), error => error.code === 'uncertain');
  fixture.observeMutations(null);
  assert.equal(fixture.storage.getItem(ACTIVE), cart.id, 'the source is never published as a replacement');
  for (const [key, value] of Object.entries(freeze)) assert.equal(fixture.storage.getItem(key), value, 'the freeze record is untouched');
  const frozen = await (await tab(fixture)).getCart();
  assert.equal(frozen.incomplete, true);
  assert.match(frozen.uncertainMutation, /checkout handoff/);
  assert.equal(await checkoutBlocked(await tab(fixture), frozen), true, 'checkout cannot be bypassed');
  // The real candidate is distinct and holds the full copy, so a later check adopts it, never the source.
  const [record] = recoveryRecords(fixture.storage);
  const recovered = await (await tab(fixture)).recoverCart();
  assert.equal(recovered.id, record.recovery.candidateCartId);
  assert.notEqual(recovered.id, cart.id);
  assert.equal(service(recovered, glove(recovered, 'black')).quantity, 1);
});

test('HIGH-1: an attachment response naming an unrelated cart is rejected without adoption', async () => {
  const { fixture, cart } = await unsafeCart({}, { breakIn: true });
  fixture.observeMutations(({ field }) => {
    if (field === 'cartLinesAdd') fixture.transformNextMutationResponse(payload => { payload.cart.id = 'gid://shopify/Cart/celsewhere?key=kelsewhere'; });
  });
  await assert.rejects((await tab(fixture)).recoverCart(), error => error.code === 'uncertain');
  fixture.observeMutations(null);
  assert.equal(fixture.storage.getItem(ACTIVE), cart.id);
  assert.equal(recoveryRecords(fixture.storage)[0].recovery.stage, 'children');
});

test('HIGH-1: a candidate read that answers with another cart ID is never adopted', async () => {
  const { fixture, cart } = await unsafeCart({}, { breakIn: true });
  fixture.failAfterNextMutation(2);
  await assert.rejects((await tab(fixture)).recoverCart(), error => error.code === 'uncertain');
  const [record] = recoveryRecords(fixture.storage);
  const lying = await hookedTab(fixture, { after: ({ query, variables, payload }) => {
    if (isCartRead(query) && variables.id === record.recovery.candidateCartId) payload.data.cart.id = cart.id;
  } });
  await assert.rejects(lying.recoverCart());
  assert.equal(fixture.storage.getItem(ACTIVE), cart.id);
  assert.equal(recoveryRecords(fixture.storage).length, 1);
});

// ---- HIGH-2: a first cart that differs from the attempted create is never made purchasable by recovery ----

async function servicedAttributes() {
  const other = shopifyFixture();
  await other.commerce.listProducts();
  const cart = await other.commerce.addProduct('black', true);
  const parent = glove(cart, 'black');
  return { parent: parent.attributes, child: service(cart, parent).attributes };
}

for (const scenario of ['blue requested, black saved', 'serviced requested, unserviced saved']) {
  test(`HIGH-2: ${scenario}: reconciliation keeps the mismatch and ordinary recovery refuses it`, async () => {
    const fixture = shopifyFixture({ checkoutHost: 'ignvv0-zh.myshopify.com' });
    await fixture.commerce.listProducts();
    const saved = await fixture.commerce.addProduct('black', false);
    const plain = glove(saved, 'black').attributes;
    const serviced = await servicedAttributes();
    const createIntent = scenario.startsWith('blue')
      ? [{ merchandiseId: 'gid://variant/ob16', quantity: 1, attributes: plain, parentMerchandiseId: null }]
      : [{ merchandiseId: 'gid://variant/br16', quantity: 1, attributes: serviced.parent, parentMerchandiseId: null },
        { merchandiseId: 'gid://variant/service', quantity: 1, attributes: serviced.child, parentMerchandiseId: 'gid://variant/br16' }];
    fixture.storage.removeItem(ACTIVE);
    fixture.storage.setItem(`${UNSAFE_RECORD_PREFIX}closed-tab`, JSON.stringify({ cartId: '*', candidateCartId: saved.id,
      kind: 'addProduct', kinds: ['addition'], status: 'pending', createdAt: 1, createIntent }));
    const reconciled = await (await tab(fixture)).reconcileUnconfirmedCart();
    assert.equal(reconciled.incomplete, true);
    assert.equal(reconciled.createMismatch, true);
    assert.equal(reconciled.recoveryAvailable, false, 'recovery is not offered for contents the shopper did not add');
    assert.deepEqual(reconciled.attemptedItems, scenario.startsWith('blue')
      ? [{ productId: 'blue', quantity: 1, breakIn: false }] : [{ productId: 'black', quantity: 1, breakIn: true }]);
    const markup = cartFeedbackMarkup({ ...reconciled, mode: 'shopify', attemptedNames: ['the requested glove'] }, escapeHtml);
    assert.match(markup, /data-keep-unconfirmed-cart/);
    assert.match(markup, /data-discard-unconfirmed-cart/);
    assert.doesNotMatch(markup, /data-recover-cart/);
    const creates = mutations(fixture, 'CreateCart');
    for (const commerce of [await tab(fixture), await tab(fixture)]) {
      await assert.rejects(commerce.recoverCart(), error => error.code === 'create-mismatch');
      await assert.rejects(commerce.recoverCart({ withoutBreakIn: true }), error => error.code === 'create-mismatch');
      await assert.rejects(commerce.recoverCart({ binding: await recoveryBindingOf(fixture), abandonUnconfirmed: true }), error => error.code === 'create-mismatch');
      assert.equal(await checkoutBlocked(commerce, reconciled), true);
    }
    assert.equal(mutations(fixture, 'CreateCart'), creates, 'no replacement copies the mismatched contents');
    assert.match(commerceErrorMessage({ code: 'create-mismatch' }), /different/);
    // Explicit resolution: start a new cart, which leaves the mismatched cart unused.
    // Task 2D: the choice carries the reviewed cart; without it nothing changes.
    const resolver = await tab(fixture);
    await assert.rejects(resolver.discardUnconfirmedCart(), error => error.code === 'cart-changed');
    const fresh = await resolver.discardUnconfirmedCart(await resolver.getCart());
    assert.equal(fresh.id, null);
    assert.deepEqual(unsafeOps(fixture.storage).filter(record => record.status !== 'terminal'), []);
    const added = await (await tab(fixture)).addProduct('blue', false);
    assert.notEqual(added.id, saved.id);
    assert.deepEqual(added.lines.map(line => line.productId), ['blue']);
  });
}

test('HIGH-2: keeping a mismatched first cart is explicit and only applies to the contents the shopper saw', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  const saved = await fixture.commerce.addProduct('black', false);
  fixture.storage.removeItem(ACTIVE);
  fixture.storage.setItem(`${UNSAFE_RECORD_PREFIX}closed-tab`, JSON.stringify({ cartId: '*', candidateCartId: saved.id,
    kind: 'addProduct', kinds: ['addition'], status: 'pending', createdAt: 1,
    createIntent: [{ merchandiseId: 'gid://variant/ob16', quantity: 1, attributes: glove(saved, 'black').attributes }] }));
  const reconciled = await (await tab(fixture)).reconcileUnconfirmedCart();
  // Another writer changes the cart after the shopper saw it: keeping it is refused.
  await (await fixture.detached()).setLineQuantity(glove(reconciled, 'black').remoteLineId, 2);
  await assert.rejects((await tab(fixture)).keepUnconfirmedCart(), error => error.code === 'cart-changed');
  const current = await (await tab(fixture)).getCart();
  assert.equal(current.createMismatch, true);
  const kept = await (await tab(fixture)).keepUnconfirmedCart(current);
  assert.equal(kept.incomplete, false);
  assert.equal(glove(kept, 'black').quantity, 2);
  assert.deepEqual(unsafeOps(fixture.storage).filter(record => record.status !== 'terminal'), []);
});

// ---- HIGH-3: only an explicit `cart: null` means Shopify has no such cart ----

const candidateFixture = async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  const saved = await fixture.commerce.addProduct('black', false);
  fixture.storage.removeItem(ACTIVE);
  fixture.storage.setItem(`${UNSAFE_RECORD_PREFIX}closed-tab`, JSON.stringify({ cartId: '*', candidateCartId: saved.id,
    kind: 'addProduct', kinds: ['addition'], status: 'pending', createdAt: 1,
    createIntent: [{ merchandiseId: 'gid://variant/br16', quantity: 1, attributes: glove(saved, 'black').attributes }] }));
  return { fixture, saved };
};
const unclearReads = { 'data: {}': { data: {} }, 'no data': {}, 'cart without lines': null };

for (const [label, payload] of Object.entries(unclearReads)) {
  test(`HIGH-3: a candidate read with ${label} keeps the candidate and every block`, async () => {
    const { fixture, saved } = await candidateFixture();
    const unclear = await hookedTab(fixture, { after: ({ query, variables, payload: real }) => {
      if (!isCartRead(query) || variables.id !== saved.id) return undefined;
      if (payload) return payload;
      delete real.data.cart.lines;
      return real;
    } });
    await assert.rejects(unclear.reconcileUnconfirmedCart(), error => error.code === 'cart-unverified');
    const [record] = unsafeOps(fixture.storage);
    assert.equal(record.candidateCartId, saved.id, 'the candidate reference is retained');
    for (const commerce of [unclear, await tab(fixture)]) {
      await assert.rejects(commerce.addProduct('blue', false), error => error.code === 'create-unresolved');
      await assert.rejects(commerce.addProduct('blue', false), error => error.code === 'create-unresolved');
      await assert.rejects(commerce.startNewCart(), error => error.code === 'create-reconcile-required');
      assert.equal((await commerce.getCart()).unconfirmedCandidate, true);
    }
    assert.equal(mutations(fixture, 'CreateCart'), 1);
    assert.equal(fixture.storage.getItem(ACTIVE), null);
  });
}

test('HIGH-3: an explicit null candidate is gone; only then may a new cart be started', async () => {
  const { fixture, saved } = await candidateFixture();
  const gone = await hookedTab(fixture, { after: ({ query, variables }) =>
    isCartRead(query) && variables.id === saved.id ? { data: { cart: null } } : undefined });
  // Task 2H: a candidate positively read missing is resolved absent for its exact ID (a terminal record), so the
  // shopper may add directly; reconciliation itself sends nothing.
  const checked = await gone.reconcileUnconfirmedCart();
  assert.equal(checked.unconfirmedCandidate, undefined);
  assert.equal(checked.unconfirmedCreate, undefined);
  const reloaded = await tab(fixture);
  assert.equal((await reloaded.addProduct('blue', false)).lines.length, 1);
  assert.equal(mutations(fixture, 'CreateCart'), 2);
});

for (const [label, payload] of Object.entries(unclearReads)) {
  test(`HIGH-3: an active-cart read with ${label} never forgets the active cart or creates another`, async () => {
    const fixture = shopifyFixture();
    await fixture.commerce.listProducts();
    const cart = await fixture.commerce.addProduct('black', false);
    const unclear = await hookedTab(fixture, { after: ({ query, payload: real }) => {
      if (!isCartRead(query)) return undefined;
      if (payload) return payload;
      delete real.data.cart.lines;
      return real;
    } });
    await assert.rejects(unclear.getCart(), error => error.code === 'cart-unverified');
    for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(unclear.addProduct('blue', false));
    assert.equal(fixture.storage.getItem(ACTIVE), cart.id);
    assert.equal(mutations(fixture, 'CreateCart'), 1);
    const reloaded = await (await tab(fixture)).getCart();
    assert.equal(reloaded.id, cart.id);
    assert.equal(reloaded.incomplete, false);
  });
}

// Task 2G: a read never forgets the active cart, even on an explicit null. The cart is shown empty, and the next
// add (an explicit, journal-checked transition) replaces it.
test('HIGH-3: an explicit null active cart is shown empty, kept by reads, and replaced by the next add', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  const expired = await fixture.commerce.addProduct('black', false);
  fixture.expireCart();
  const shown = await fixture.commerce.getCart();
  assert.deepEqual(shown.lines, []);
  assert.notEqual(shown.incomplete, true);
  assert.equal(fixture.storage.getItem(ACTIVE), expired.id);
  const added = await fixture.commerce.addProduct('blue', false);
  assert.notEqual(added.id, expired.id);
  assert.equal(fixture.storage.getItem(ACTIVE), added.id);
});

// ---- HIGH-4: glove-only recovery never resumes an attempt that carries a paid Break-In ----

test('HIGH-4: an unanswered serviced attachment is never adopted by a glove-only choice', async () => {
  const { fixture, cart } = await unsafeCart({}, { breakIn: true });
  fixture.failAfterNextMutation(2);
  await assert.rejects((await tab(fixture)).recoverCart(), error => error.code === 'uncertain');
  const writes = mutations(fixture);
  const gloveOnly = await tab(fixture);
  await assert.rejects(gloveOnly.recoverCart({ withoutBreakIn: true }), error => error.code === 'recovery-mode-mismatch');
  assert.equal(mutations(fixture), writes, 'nothing is replayed');
  assert.equal(fixture.storage.getItem(ACTIVE), cart.id);
  assert.match(commerceErrorMessage({ code: 'recovery-mode-mismatch' }), /Break-In/);
  const markup = cartFeedbackMarkup({ incomplete: true, recoveryAvailable: true, recoveryHasBreakIn: true,
    recoveryUnconfirmed: true, mode: 'shopify' }, escapeHtml);
  assert.match(markup, /data-recover-retry-without-service/);
  // Explicitly starting over without service gives a cart with no paid service at all.
  const recovered = await gloveOnly.recoverCart({ binding: await recoveryBindingOf(fixture), withoutBreakIn: true, abandonUnconfirmed: true });
  assert.notEqual(recovered.id, cart.id);
  assert.equal(recovered.lines.some(line => line.isBreakIn), false);
  assert.equal(serviceValue(glove(recovered, 'black')), 'none');
  assert.equal(recovered.incomplete, false);
  assert.deepEqual(unsafeOps(fixture.storage).filter(record => record.status !== 'terminal'), []);
});

test('HIGH-4: a glove-only attempt is never resumed by a recovery that includes service', async () => {
  const { fixture } = await unsafeCart({}, { breakIn: true });
  fixture.failAfterNextMutation(1);
  await assert.rejects((await tab(fixture)).recoverCart({ withoutBreakIn: true }), error => error.code === 'uncertain');
  const creates = mutations(fixture, 'CreateCart');
  await assert.rejects((await tab(fixture)).recoverCart(), error => error.code === 'recovery-mode-mismatch');
  assert.equal(mutations(fixture, 'CreateCart'), creates);
});

// ---- HIGH-5: blank discount codes are malformed data, never "no code" ----

for (const blank of ['', '   ']) {
  test(`HIGH-5: KEEP plus a blank code (${JSON.stringify(blank)}) blocks Apply NEW, remove, checkout and recovery`, async () => {
    const fixture = shopifyFixture({ checkoutHost: 'ignvv0-zh.myshopify.com', discountCodes: [{ code: 'KEEP', applicable: true }] });
    await fixture.commerce.listProducts();
    await fixture.commerce.addProduct('black', false);
    // Shopify's reads now also list a blank code.
    const commerce = await hookedTab(fixture, { after: ({ query, payload }) => {
      if (isCartRead(query) && payload.data?.cart) payload.data.cart.discountCodes.push({ code: blank, applicable: true });
    } });
    // Task 2H (row 3): a blank code is invalid data, so the read rejects; the drawer keeps the last valid view.
    await assert.rejects(commerce.getCart(), error => error.code === 'cart-unverified');
    const cart = await (await tab(fixture)).getCart();
    const before = mutations(fixture, 'UpdateDiscountCodes');
    await assert.rejects(commerce.applyDiscountCode('NEW'));
    await assert.rejects(commerce.removeDiscountCode('KEEP'));
    assert.equal(mutations(fixture, 'UpdateDiscountCodes'), before, 'no replacement list is sent');
    assert.equal(await checkoutBlocked(commerce, cart), true);
    // Even once the cart is unresolved for another reason, recovery never copies the malformed codes.
    fixture.setApiError(true);
    await assert.rejects(fixture.commerce.setLineQuantity(glove(cart, 'black').remoteLineId, 2));
    fixture.setApiError(false);
    const creates = mutations(fixture, 'CreateCart');
    await assert.rejects(commerce.recoverCart(), error => ['recovery-ambiguous', 'cart-unverified'].includes(error.code));
    assert.equal(mutations(fixture, 'CreateCart'), creates);
    assert.deepEqual((await (await tab(fixture)).getCart()).discountCodes.map(item => item.code), ['KEEP']);
  });
}

// Task 2H: a mutation reply's contents are never authority. A blank code in the reply is ignored; only the fresh
// authoritative read (which has no blank code) decides, and it must hold exactly the intended codes.
for (const action of ['apply', 'remove']) {
  test(`HIGH-5: a ${action} response containing a blank code settles only from the fresh read`, async () => {
    const fixture = shopifyFixture({ discountCodes: [{ code: 'KEEP', applicable: true }, { code: 'OLD', applicable: true }] });
    await fixture.commerce.listProducts();
    await fixture.commerce.addProduct('black', false);
    fixture.transformNextMutationResponse(payload => { payload.cart.discountCodes.push({ code: ' ', applicable: true }); });
    const updated = await (action === 'apply' ? fixture.commerce.applyDiscountCode('NEW') : fixture.commerce.removeDiscountCode('OLD'));
    assert.deepEqual(updated.discountCodes.map(item => item.code), action === 'apply' ? ['KEEP', 'OLD', 'NEW'] : ['KEEP']);
    assert.deepEqual(unsafeOps(fixture.storage).filter(record => record.status !== 'terminal'), []);
  });
}

// ---- HIGH-6: the final source read must be complete and unchanged in every field that matters ----

const finalSourceRead = (fixture, sourceId, rewrite) => {
  let reads = 0;
  return hookedTab(fixture, { after: ({ query, variables, payload }) => {
    if (!isCartRead(query) || variables.id !== sourceId) return undefined;
    reads += 1;
    if (reads === 2) rewrite(payload.data.cart);
    return payload;
  } });
};

for (const [label, rewrite, options] of [
  ['discountCodes null after a verified empty list', cart => { cart.discountCodes = null; }],
  ['an omitted line (unknown merchandise)', cart => { cart.lines.nodes.push({ ...cart.lines.nodes[0], id: 'line-x',
    merchandise: { ...cart.lines.nodes[0].merchandise, product: { handle: 'unknown' } } }); }],
  ['a further page of lines', cart => { cart.lines.pageInfo = { hasNextPage: true }; }],
  ['a changed selected hand', cart => { cart.lines.nodes[0].merchandise.selectedOptions = [{ name: 'Throwing Hand', value: 'Left' }]; },
    { fixture: { fullSize: true }, product: { productId: 'full-mint', merchandiseId: 'gid://variant/mi26-right' } }]
]) {
  test(`HIGH-6: ${label} at the final source read stops adoption`, async () => {
    const { fixture, cart } = await unsafeCart(options?.fixture, options?.product);
    const recovering = await finalSourceRead(fixture, cart.id, rewrite);
    // Task 2H: malformed data is invalid (cart-unverified); a valid but changed source is recovery-ambiguous.
    await assert.rejects(recovering.recoverCart(), error => ['recovery-ambiguous', 'cart-unverified'].includes(error.code));
    assert.equal(fixture.storage.getItem(ACTIVE), cart.id, 'no replacement is published');
    assert.ok(recoveryRecords(fixture.storage).length, 'the candidate stays journaled');
    assert.equal((await (await tab(fixture)).getCart()).incomplete, true);
  });
}

// ---- MEDIUM-1: Try recovery again keeps the earlier attempt until the next one is durably prepared ----

async function lostRecovery({ breakIn = true, failAt = 2 } = {}) {
  const setup = await unsafeCart({}, { breakIn });
  setup.fixture.failAfterNextMutation(failAt);
  await assert.rejects((await tab(setup.fixture)).recoverCart(), error => error.code === 'uncertain');
  return { ...setup, earlier: rawOps(setup.fixture.storage) };
}

test('MEDIUM-1: a source read error keeps the earlier candidate, and plain recovery can still adopt it', async () => {
  const { fixture, cart, earlier } = await lostRecovery();
  const failing = await hookedTab(fixture, { before: ({ query, variables }) => {
    if (isCartRead(query) && variables.id === cart.id) throw new TypeError('Failed to fetch');
  } });
  await assert.rejects(failing.recoverCart({ binding: await recoveryBindingOf(fixture), abandonUnconfirmed: true }));
  assert.deepEqual(rawOps(fixture.storage), earlier, 'every earlier record is kept unchanged');
  const adopted = await (await tab(fixture)).recoverCart();
  assert.notEqual(adopted.id, cart.id);
  assert.equal(adopted.incomplete, false);
});

test('MEDIUM-1: a journal setup failure keeps the earlier candidate and sends nothing', async () => {
  const { fixture, cart, earlier } = await lostRecovery();
  const earlierKeys = Object.keys(earlier);
  const restore = interceptWrites(fixture.storage, key => key.startsWith(UNSAFE_RECORD_PREFIX) && !earlierKeys.includes(key),
    () => { throw new Error('QuotaExceededError'); });
  const writes = mutations(fixture);
  await assert.rejects((await tab(fixture)).recoverCart({ binding: await recoveryBindingOf(fixture), abandonUnconfirmed: true }), error => error.code === 'storage-unavailable');
  restore();
  assert.equal(mutations(fixture), writes);
  assert.deepEqual(rawOps(fixture.storage), earlier);
  assert.equal(fixture.storage.getItem(ACTIVE), cart.id);
});

test('MEDIUM-1: repeated fresh attempts across reloads keep one current attempt and end in one adopted cart', async () => {
  const { fixture, cart } = await lostRecovery({ breakIn: false, failAt: 1 });
  for (let attempt = 0; attempt < 2; attempt++) {
    fixture.failAfterNextMutation(1);
    await assert.rejects((await tab(fixture)).recoverCart({ binding: await recoveryBindingOf(fixture), abandonUnconfirmed: true }), error => error.code === 'uncertain');
    // Task 2H: supersession is logical. Earlier attempts stay intact; exactly one attempt is current.
    assert.equal(recoveryRecords(fixture.storage).length, attempt + 2, 'every attempt stays journaled');
    assert.equal((await (await tab(fixture)).getCart()).recoveryUnconfirmed, true);
    assert.equal(fixture.storage.getItem(ACTIVE), cart.id);
  }
  const recovered = await (await tab(fixture)).recoverCart({ binding: await recoveryBindingOf(fixture), abandonUnconfirmed: true });
  assert.notEqual(recovered.id, cart.id);
  assert.equal(recovered.incomplete, false);
  assert.deepEqual(unsafeOps(fixture.storage).filter(record => record.status !== 'terminal'), []);
  assert.match(cartFeedbackMarkup({ incomplete: true, recoveryUnconfirmed: true, mode: 'shopify' }, escapeHtml),
    /unused recovery cart may remain/);
});

// ---- MEDIUM-2: a read-back that throws after a successful journal write ----

function throwingReadBack(storage, matches, { removeThrows = false } = {}) {
  const getItem = storage.getItem.bind(storage);
  const removeItem = storage.removeItem.bind(storage);
  let armed = false;
  const restoreWrites = interceptWrites(storage, () => true, (setItem, key, value) => {
    setItem(key, value);
    if (matches(key, String(value))) armed = key;
  });
  storage.getItem = key => {
    if (armed && key === armed) { armed = false; throw new DOMException('read refused', 'SecurityError'); }
    return getItem(key);
  };
  if (removeThrows) storage.removeItem = key => { if (key.startsWith(UNSAFE_RECORD_PREFIX)) throw new DOMException('refused', 'SecurityError'); return removeItem(key); };
  return () => { restoreWrites(); storage.getItem = getItem; storage.removeItem = removeItem; };
}

test('MEDIUM-2: a journal read-back that throws sends nothing and leaves no unconfirmed create', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  const restore = throwingReadBack(fixture.storage, key => key.startsWith(UNSAFE_RECORD_PREFIX));
  await assert.rejects(fixture.commerce.addProduct('black', false), error => error.code === 'storage-unavailable');
  restore();
  assert.equal(mutations(fixture), 0);
  assert.deepEqual(unsafeOps(fixture.storage).filter(record => record.status !== 'terminal'), []);
  const reloaded = await tab(fixture);
  assert.equal((await reloaded.getCart()).unconfirmedCreate, undefined);
  assert.equal((await reloaded.addProduct('black', false)).lines.length, 1);
  assert.equal(mutations(fixture, 'CreateCart'), 1);
});

test('MEDIUM-2: when cleanup also fails, the leftover record is never reported as a possible Shopify cart', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  const restore = throwingReadBack(fixture.storage, key => key.startsWith(UNSAFE_RECORD_PREFIX), { removeThrows: true });
  await assert.rejects(fixture.commerce.addProduct('black', false), error => error.code === 'storage-unavailable');
  restore();
  assert.equal(mutations(fixture), 0);
  const [leftover] = unsafeOps(fixture.storage);
  assert.equal(leftover.dispatched, false, 'the record proves nothing was sent');
  const reloaded = await tab(fixture);
  assert.equal((await reloaded.getCart()).unconfirmedCreate, undefined);
  assert.equal((await reloaded.addProduct('black', false)).incomplete, false);
  assert.equal(mutations(fixture, 'CreateCart'), 1);
  // Task 2H: a provably never-armed prepared remnant is ignored for admission; its removal is optional and scoped.
  assert.deepEqual(unsafeOps(fixture.storage).filter(record => !['terminal', 'prepared'].includes(record.status)), []);
});

test('MEDIUM-2: a recovery journal read-back that throws sends nothing and a later recovery runs once', async () => {
  const { fixture, cart } = await unsafeCart();
  const restore = throwingReadBack(fixture.storage, (key, value) => key.startsWith(UNSAFE_RECORD_PREFIX) && value.includes('"recovery"'),
    { removeThrows: true });
  const creates = mutations(fixture, 'CreateCart');
  await assert.rejects((await tab(fixture)).recoverCart(), error => error.code === 'storage-unavailable');
  restore();
  assert.equal(mutations(fixture, 'CreateCart'), creates);
  assert.equal(fixture.storage.getItem(ACTIVE), cart.id);
  const recovered = await (await tab(fixture)).recoverCart();
  assert.notEqual(recovered.id, cart.id);
  assert.equal(mutations(fixture, 'CreateCart'), creates + 1);
  assert.deepEqual(unsafeOps(fixture.storage).filter(record => !['terminal', 'prepared'].includes(record.status)), []);
});

// ---- Restored coverage: only an operation's own record is retired ----

const foreignRecord = cartId => JSON.stringify({ cartId, kind: 'setLineQuantity', kinds: ['quantity update'], status: 'pending', createdAt: 1 });
for (const outcome of ['completion', 'rejection', 'timeout', 'ambiguity']) {
  test(`ownership: ${outcome} retires only the operation's own record; a foreign pending record and the checkout block stay`, async () => {
    const fixture = shopifyFixture({ timeoutMs: outcome === 'timeout' ? 20 : undefined, checkoutHost: 'ignvv0-zh.myshopify.com' });
    await fixture.commerce.listProducts();
    const cart = await fixture.commerce.addProduct('black', false);
    const foreignKey = `${UNSAFE_RECORD_PREFIX}foreign`;
    let ownKey = null;
    fixture.observeMutations(({ storage }) => {
      fixture.observeMutations(null);
      ownKey = unsafeOps(storage).find(record => ['pending', 'prepared', 'armed'].includes(record.status)).key;
      storage.setItem(foreignKey, foreignRecord(cart.id));
    });
    if (outcome === 'rejection') fixture.setUserError('Quantity not allowed');
    if (outcome === 'ambiguity') fixture.failAfterNextMutation();
    const reached = outcome === 'timeout' ? fixture.delayNextMutationResponse() : null;
    const writing = fixture.commerce.setLineQuantity(glove(cart, 'black').remoteLineId, 2);
    if (reached) await reached;
    const result = await writing.then(value => ({ value }), error => ({ error }));
    fixture.setUserError('');
    fixture.releaseDelayedMutation();
    assert.equal(fixture.storage.getItem(foreignKey), foreignRecord(cart.id), 'the foreign record is untouched');
    const own = fixture.storage.getItem(ownKey);
    if (outcome === 'completion') { assert.ok(result.value); assert.equal(own, null); }
    if (outcome === 'rejection') { assert.equal(result.error.definitiveRejection, true); assert.equal(own, null); }
    if (['timeout', 'ambiguity'].includes(outcome)) {
      assert.equal(result.error.code, 'uncertain');
      assert.equal(JSON.parse(own).status, 'unresolved');
    }
    const current = await (await tab(fixture)).getCart();
    assert.equal(current.incomplete, true);
    assert.equal(await checkoutBlocked(await tab(fixture), current), true);
  });
}

test('coordinated tabs queue serviced +1 steps in lock order and keep glove and service quantities equal at the stock limit', async () => {
  const fixture = shopifyFixture({ stock: { br16: 2 } });
  await fixture.commerce.listProducts();
  const cart = await fixture.commerce.addProduct('black', true);
  const line = glove(cart, 'black');
  const [first, second] = [fixture.commerce, await tab(fixture)];
  const order = [];
  fixture.observeMutations(({ variables }) => order.push(variables.lines?.map(item => item.quantity).join(',')));
  const results = await Promise.allSettled([first.adjustLineQuantity(line.remoteLineId, 1, shown(cart, line)),
    second.adjustLineQuantity(line.remoteLineId, 1, shown(cart, line))]);
  fixture.observeMutations(null);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(glove(results[0].value, 'black').quantity, 2);
  assert.equal(service(results[0].value, glove(results[0].value, 'black')).quantity, 2);
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[1].reason.code, 'stock-limit');
  assert.deepEqual(order, ['2', '3'], 'the queued step is sent only after the first completes, from the fresh quantity');
  const current = await (await tab(fixture)).getCart();
  assert.equal(glove(current, 'black').quantity, 2);
  assert.equal(service(current, glove(current, 'black')).quantity, 2);
  assert.equal(current.incomplete, false);
  assert.deepEqual(unsafeOps(fixture.storage).filter(record => record.status !== 'terminal'), []);
});

test('a coordinated tab queued behind a write that ends unresolved is refused and sends nothing', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  const original = await fixture.commerce.addProduct('black', false);
  const otherTab = await tab(fixture);
  const reached = fixture.delayNextMutation();
  const changingService = fixture.commerce.addBreakIn(glove(original, 'black').remoteLineId).catch(error => error);
  await reached;
  const queued = otherTab.addProduct('blue', false).catch(error => error);
  fixture.failAfterNextMutation(0);
  fixture.releaseDelayedMutation();
  assert.equal((await changingService).code, 'uncertain');
  assert.equal((await queued).code, 'cart-unresolved');
  assert.equal(fixture.requests.some(request => request.query.includes('AddLines') &&
    request.variables.lines?.some(item => item.merchandiseId === 'gid://variant/ob16')), false);
  assert.equal(await checkoutBlocked(await tab(fixture), await (await tab(fixture)).getCart()), true);
});

for (const contents of ['different', 'exact']) {
  test(`HIGH-2: ordinary recovery of an active unresolved first cart with ${contents} contents`, async () => {
    const fixture = shopifyFixture();
    await fixture.commerce.listProducts();
    const saved = await fixture.commerce.addProduct('black', false);
    // The create's own record survived (its answer was lost after publication) and names what was sent.
    fixture.storage.setItem(`${UNSAFE_RECORD_PREFIX}create`, JSON.stringify({ cartId: saved.id, kind: 'addProduct', kinds: ['addition'],
      status: 'unresolved', createdAt: 1, dispatched: true, createIntent: [{ merchandiseId: contents === 'exact' ? 'gid://variant/br16' : 'gid://variant/ob16',
        quantity: 1, attributes: glove(saved, 'black').attributes }] }));
    const creates = mutations(fixture, 'CreateCart');
    if (contents === 'different') {
      await assert.rejects((await tab(fixture)).recoverCart(), error => error.code === 'create-mismatch');
      assert.equal(mutations(fixture, 'CreateCart'), creates);
      const shownCart = await (await tab(fixture)).getCart();
      assert.equal(shownCart.createMismatch, true);
      assert.deepEqual(shownCart.attemptedItems, [{ productId: 'blue', quantity: 1, breakIn: false }]);
    } else {
      const recovered = await (await tab(fixture)).recoverCart();
      assert.notEqual(recovered.id, saved.id);
      assert.deepEqual(recovered.lines.map(line => line.productId), ['black']);
    }
  });
}

test('MEDIUM-2: an active-ID read-back that throws after cartCreate keeps the candidate and never creates again', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  const restore = throwingReadBack(fixture.storage, key => key === ACTIVE);
  await assert.rejects(fixture.commerce.addProduct('black', false), error => error.code === 'uncertain-create');
  restore();
  const [record] = unsafeOps(fixture.storage);
  assert.equal(record.cartId, '*');
  assert.equal(typeof record.candidateCartId, 'string');
  const reloaded = await tab(fixture);
  // The write may have landed even though its read-back failed; either way the add is refused.
  await assert.rejects(reloaded.addProduct('blue', false), error => ['create-unresolved', 'cart-unresolved'].includes(error.code));
  assert.equal((await reloaded.reconcileUnconfirmedCart()).incomplete, false);
  assert.equal(mutations(fixture, 'CreateCart'), 1);
});

test('feedback: unconfirmed and mismatched first carts offer Check cart, the focus target when another tab changes the cart', () => {
  for (const state of [{ unconfirmedCreate: true }, { unconfirmedCreate: true, unconfirmedCandidate: true }, { createMismatch: true, incomplete: true }]) {
    assert.match(cartFeedbackMarkup({ ...state, mode: 'shopify' }, escapeHtml), /data-refresh-cart/, JSON.stringify(state));
  }
  assert.doesNotMatch(cartFeedbackMarkup({ storageUnavailable: true, mode: 'shopify' }, escapeHtml), /<button/);
});

test('HIGH-5: an add whose cart read has a blank code is reported as unverifiable, not as a glove configuration failure', async () => {
  const fixture = shopifyFixture({ discountCodes: [{ code: 'KEEP', applicable: true }, { code: ' ', applicable: true }] });
  await fixture.commerce.listProducts();
  // Task 2H: the create's fresh read is invalid, so the add stays an unconfirmed create (its candidate journaled),
  // never a glove configuration failure and never published.
  await assert.rejects(fixture.commerce.addProduct('black', false), error => error.code === 'uncertain-create');
  assert.match(commerceErrorMessage({ code: 'cart-unverified' }), /form we could check/);
  const kinds = unsafeOps(fixture.storage).flatMap(record => record.kinds);
  assert.equal(kinds.some(kind => kind.endsWith('validation failed')), false);
  assert.equal((await (await tab(fixture)).getCart()).unconfirmedCandidate, true);
});
