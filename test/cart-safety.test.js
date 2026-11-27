import test from 'node:test';
import assert from 'node:assert/strict';
import { shopifyFixture, recoveryBindingOf } from '../test-support/shopify-fixture.js';
import { cartLineIdentity, commerceErrorMessage, createShopifyCommerce, UNSAFE_RECORD_PREFIX } from '../src/commerce.js';
import { cartFeedbackMarkup } from '../src/cart-feedback.js';
import { discountResultFeedback } from '../src/cart-discounts.js';

const ACTIVE = 'anawin-shopify-cart-id';
const REVISION = 'anawin-shopify-cart-revision';
async function loaded(commerce) {
  await commerce.listProducts();
  await commerce.getBreakInService();
  await commerce.getFullSizeBreakInService();
  return commerce;
}
const tab = fixture => loaded(fixture.restore());
const unsafeOps = storage => [...storage.values.entries()].filter(([key]) => key.startsWith(UNSAFE_RECORD_PREFIX))
  .map(([key, value]) => ({ key, ...JSON.parse(value) }));
const mutations = (fixture, name = '') => fixture.requests.filter(request => /^mutation/.test(request.query) && request.query.includes(name)).length;
const glove = (cart, productId) => cart.lines.find(line => line.productId === productId && !line.isBreakIn);
const service = (cart, parent) => cart.lines.find(line => line.isBreakIn && line.parentLineId === parent.remoteLineId);
const shown = (cart, line) => ({ quantity: line.quantity, identity: cartLineIdentity(cart.lines, line) });
const codes = cart => cart.discountCodes.map(item => item.code).sort();
const escapeHtml = value => String(value).replace(/[&<>"]/g, character => `&#${character.charCodeAt(0)};`);
// Replaces one storage method for matching keys/values until restored.
function interceptWrites(storage, matches, behaviour) {
  const setItem = storage.setItem.bind(storage);
  storage.setItem = (key, value) => matches(key, String(value)) ? behaviour(setItem, key, value) : setItem(key, value);
  return () => { storage.setItem = setItem; };
}
// A commerce instance whose cart reads pass through `transform`, as a malformed Shopify response would.
function transformedReads(fixture, transform) {
  const fetchImpl = async (url, options) => {
    const response = await fixture.fetchImpl(url, options);
    if (!JSON.parse(options.body).query.includes('query Cart(')) return response;
    const payload = await response.json();
    if (payload.data?.cart) transform(payload.data.cart);
    return { ok: true, json: async () => payload };
  };
  return loaded(createShopifyCommerce(fixture.config, fixture.storage, fetchImpl, fixture.locks));
}

// ---- P0-1: a created cart stays discoverable until it is durably the active cart ----

for (const failure of ['throws', 'ignored']) {
  test(`P0-1: an active-cart write that ${failure} after cartCreate keeps the candidate and never creates again`, async () => {
    const fixture = shopifyFixture();
    await fixture.commerce.listProducts();
    const restore = interceptWrites(fixture.storage, key => key === ACTIVE, () => {
      if (failure === 'throws') throw new Error('QuotaExceededError');
    });
    await assert.rejects(fixture.commerce.addProduct('black', false), error => ['uncertain-create', 'storage-unavailable'].includes(error.code));
    restore();
    assert.equal(fixture.storage.getItem(ACTIVE), null);
    const [record] = unsafeOps(fixture.storage);
    assert.equal(record.cartId, '*', 'the record still applies with no active cart');
    assert.equal(record.candidateCartId, 'gid://shopify/Cart/c1?key=k1');

    const reloaded = await tab(fixture);
    const empty = await reloaded.getCart();
    assert.equal(empty.unconfirmedCreate, true);
    assert.equal(empty.unconfirmedCandidate, true);
    await assert.rejects(reloaded.addProduct('blue', false), error => error.code === 'create-unresolved');
    await assert.rejects(reloaded.startNewCart(), error => error.code === 'create-reconcile-required',
      'a known candidate is checked before it can be abandoned');
    assert.equal(mutations(fixture, 'CreateCart'), 1);

    // The candidate holds exactly what was sent, so it is adopted as the active cart.
    const adopted = await reloaded.reconcileUnconfirmedCart();
    assert.equal(adopted.id, 'gid://shopify/Cart/c1?key=k1');
    assert.equal(adopted.incomplete, false);
    assert.deepEqual(adopted.lines.map(line => [line.productId, line.quantity]), [['black', 1]]);
    assert.deepEqual(unsafeOps(fixture.storage).filter(record => record.status !== 'terminal'), []);
    assert.equal((await reloaded.addProduct('blue', false)).lines.length, 2);
    assert.equal(mutations(fixture, 'CreateCart'), 1, 'no duplicate cart on the reconciled path');
  });
}

test('P0-1: reload between candidate persistence and publication reconciles; a mismatch stays blocked', async () => {
  for (const intent of ['matching', 'different']) {
    const fixture = shopifyFixture();
    await fixture.commerce.listProducts();
    const cart = await fixture.commerce.addProduct('black', false);
    // A tab stopped after journaling the candidate and before publishing it.
    fixture.storage.removeItem(ACTIVE);
    const merchandiseId = intent === 'matching' ? 'gid://variant/br16' : 'gid://variant/ob16';
    fixture.storage.setItem(`${UNSAFE_RECORD_PREFIX}stopped`, JSON.stringify({ cartId: '*', candidateCartId: cart.id,
      kind: 'addProduct', kinds: ['addition'], status: 'pending', createdAt: 1,
      createIntent: [{ merchandiseId, quantity: 1, attributes: cart.lines[0].attributes }] }));
    const reloaded = await tab(fixture);
    const adopted = await reloaded.reconcileUnconfirmedCart();
    assert.equal(fixture.storage.getItem(ACTIVE), cart.id, intent);
    if (intent === 'matching') {
      assert.equal(adopted.incomplete, false);
      assert.deepEqual(unsafeOps(fixture.storage).filter(record => record.status !== 'terminal'), []);
    } else {
      assert.equal(adopted.incomplete, true, 'contents that differ from the journaled intent are reviewed, not trusted');
      // Task 2C: a mismatch is resolved only by the shopper (keep or start a new cart), never by recovery.
      assert.equal(adopted.createMismatch, true);
      assert.equal(adopted.recoveryAvailable, false);
    }
    assert.equal(mutations(fixture, 'CreateCart'), 1);
  }
});

test('P0-1: a candidate Shopify no longer has may be abandoned only after reconciliation proves it gone', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  const cart = await fixture.commerce.addProduct('black', false);
  fixture.storage.removeItem(ACTIVE);
  fixture.storage.setItem(`${UNSAFE_RECORD_PREFIX}stopped`, JSON.stringify({ cartId: '*', candidateCartId: cart.id,
    kind: 'addProduct', kinds: ['addition'], status: 'pending', createdAt: 1, createIntent: [] }));
  fixture.expireCart();
  const reloaded = await tab(fixture);
  await assert.rejects(reloaded.startNewCart(), error => error.code === 'create-reconcile-required');
  // Task 2H: a candidate positively read missing is resolved absent for its exact ID; nothing else is needed.
  const checked = await reloaded.reconcileUnconfirmedCart();
  assert.equal(checked.id, null);
  assert.equal(checked.unconfirmedCreate, undefined);
  assert.equal(checked.unconfirmedCandidate, undefined);
  assert.equal((await reloaded.addProduct('blue', false)).lines.length, 1);
});

// Task 2H: a body that arrives after the timeout may add evidence to the same unresolved step only (under the lock,
// exact bytes); it never publishes, advances or thaws anything.
test('P0-1: a delayed create response after the timeout only adds evidence; nothing is published or created again', async () => {
  const fixture = shopifyFixture({ timeoutMs: 20 });
  await fixture.commerce.listProducts();
  const reached = fixture.delayNextMutationResponse();
  const adding = fixture.commerce.addProduct('black', false);
  await reached;
  await assert.rejects(adding, error => error.code === 'uncertain-create');
  fixture.releaseDelayedMutation();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fixture.storage.getItem(ACTIVE), null, 'a late answer never publishes a cart');
  const reloaded = await tab(fixture);
  await assert.rejects(reloaded.addProduct('black', false), error => error.code === 'create-unresolved');
  assert.equal(mutations(fixture, 'CreateCart'), 1);
  assert.equal((await reloaded.getCart()).unconfirmedCandidate, true, 'the late ID is kept as evidence');
  assert.equal(fixture.storage.getItem(ACTIVE), null);
});

// ---- P0-2: a pending record left by another tab blocks every write ----

const abandoned = (storage, cartId, kind = 'quantity update') => storage.setItem(`${UNSAFE_RECORD_PREFIX}closed-tab`,
  JSON.stringify({ cartId, kind: 'adjustLineQuantity', kinds: [kind], status: 'pending', createdAt: 1 }));

test('P0-2: an abandoned pending record blocks every cart write until recovery, across reloads', async () => {
  const fixture = shopifyFixture({ discountCodes: [{ code: 'KEEP', applicable: true }] });
  await fixture.commerce.listProducts();
  await fixture.commerce.addProduct('black', true);
  const cart = await fixture.commerce.addProduct('blue', false);
  abandoned(fixture.storage, cart.id);
  const black = glove(cart, 'black');
  const blue = glove(cart, 'blue');
  const before = mutations(fixture);
  for (const commerce of [fixture.commerce, await tab(fixture)]) {
    const writes = {
      addProduct: () => commerce.addProduct('brown', false),
      setLineQuantity: () => commerce.setLineQuantity(blue.remoteLineId, 2),
      adjustLineQuantity: () => commerce.adjustLineQuantity(blue.remoteLineId, 1, shown(cart, blue)),
      adjustQuantity: () => commerce.adjustQuantity('blue', 1),
      setQuantity: () => commerce.setQuantity('blue', 2),
      removeLine: () => commerce.removeLine(blue.remoteLineId),
      removeProduct: () => commerce.removeProduct('blue'),
      addBreakIn: () => commerce.addBreakIn(blue.remoteLineId),
      editBreakIn: () => commerce.editBreakIn(black.remoteLineId, { type: 'trainer', level: 'Game Ready (90%)', wearingStyle: 'Traditional' }),
      removeBreakIn: () => commerce.removeBreakIn(black.remoteLineId),
      setWristFit: () => commerce.setWristFit(blue.remoteLineId, 'tightened'),
      applyDiscountCode: () => commerce.applyDiscountCode('A10'),
      removeDiscountCode: () => commerce.removeDiscountCode('KEEP')
    };
    for (const [name, write] of Object.entries(writes)) await assert.rejects(write(), Error, name);
  }
  assert.equal(mutations(fixture), before, 'no write was sent past the abandoned record');
  const blocked = await fixture.restore().getCart();
  assert.equal(blocked.incomplete, true);
  assert.equal(blocked.recoveryAvailable, true);
  // Explicit recovery under the lock is the safe way forward.
  const recovered = await fixture.restore().recoverCart();
  assert.notEqual(recovered.id, cart.id);
  assert.equal(recovered.incomplete, false);
  assert.deepEqual(codes(recovered), ['KEEP']);
  assert.equal(glove(await fixture.commerce.adjustLineQuantity(glove(recovered, 'blue').remoteLineId, 1), 'blue').quantity, 2);
});

test('P0-2: an abandoned pending record stops checkout before any preorder attribute write', async () => {
  const fixture = shopifyFixture({ fullSize: true, checkoutHost: 'ignvv0-zh.myshopify.com' });
  await fixture.commerce.listProducts();
  const cart = await fixture.commerce.addProduct('full-mint', false, undefined, 'gid://variant/mi26-right');
  abandoned(fixture.storage, cart.id, 'discount update');
  let navigated = false;
  const result = await fixture.commerce.checkout(cart, {}, () => { navigated = true; });
  assert.equal(result.status, 'blocked');
  assert.equal(navigated, false);
  assert.equal(mutations(fixture, 'UpdateCartAttributes'), 0);
});

// ---- P0-3: recovery journals itself and never repeats an ambiguous write ----

async function unsafeCart({ breakIn = false } = {}) {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  const cart = await fixture.commerce.addProduct('black', breakIn);
  fixture.setApiError(true);
  await assert.rejects(fixture.commerce.addProduct('blue', false), error => error.code === 'uncertain');
  fixture.setApiError(false);
  return { fixture, cart };
}
const recoveryRecords = storage => unsafeOps(storage).filter(record => record.kind === 'recovery');

test('P0-3: a lost recovery-create response is never repeated without an explicit choice', async () => {
  const { fixture, cart } = await unsafeCart();
  fixture.failAfterNextMutation();
  await assert.rejects(fixture.restore().recoverCart(), error => error.code === 'uncertain');
  assert.equal(fixture.storage.getItem(ACTIVE), cart.id, 'the original cart stays active and frozen');
  const [record] = recoveryRecords(fixture.storage);
  assert.equal(record.recovery.stage, 'create');
  assert.equal(record.recovery.sourceCartId, cart.id);
  assert.deepEqual(record.recovery.intent.lines.map(line => [line.merchandiseId, line.quantity]), [['gid://variant/br16', 1]]);
  const creates = mutations(fixture, 'CreateCart');

  const reloaded = await tab(fixture);
  const frozen = await reloaded.getCart();
  assert.equal(frozen.incomplete, true);
  assert.equal(frozen.recoveryUnconfirmed, true);
  await assert.rejects(reloaded.recoverCart(), error => error.code === 'recovery-unconfirmed');
  await assert.rejects(reloaded.recoverCart(), error => error.code === 'recovery-unconfirmed', 'repeated clicks');
  assert.equal(mutations(fixture, 'CreateCart'), creates);
  assert.match(commerceErrorMessage({ code: 'recovery-unconfirmed' }), /Try recovery again/);
  assert.match(cartFeedbackMarkup({ incomplete: true, recoveryAvailable: true, recoveryUnconfirmed: true, mode: 'shopify' }, escapeHtml),
    /data-recover-retry/);

  const recovered = await reloaded.recoverCart({ binding: await recoveryBindingOf(fixture), abandonUnconfirmed: true });
  assert.notEqual(recovered.id, cart.id);
  assert.equal(recovered.incomplete, false);
  assert.deepEqual(recovered.lines.map(line => [line.productId, line.quantity]), [['black', 1]]);
  assert.equal(mutations(fixture, 'CreateCart'), creates + 1);
  assert.deepEqual(unsafeOps(fixture.storage).filter(record => record.status !== 'terminal'), []);
  assert.equal((await reloaded.recoverCart()).id, recovered.id, 'a later click finds nothing to recover');
  assert.equal(mutations(fixture, 'CreateCart'), creates + 1);
});

test('P0-3: a lost Break-In attachment response is inspected, then adopted without another write', async () => {
  const { fixture, cart } = await unsafeCart({ breakIn: true });
  fixture.failAfterNextMutation(2);
  await assert.rejects(fixture.restore().recoverCart(), error => error.code === 'uncertain');
  const [record] = recoveryRecords(fixture.storage);
  assert.equal(record.recovery.stage, 'children');
  assert.ok(record.recovery.candidateCartId);
  assert.equal(fixture.storage.getItem(ACTIVE), cart.id);
  const writes = mutations(fixture);
  const recovered = await (await tab(fixture)).recoverCart();
  assert.equal(mutations(fixture), writes, 'the attachment had landed; nothing is sent again');
  assert.equal(recovered.id, record.recovery.candidateCartId);
  assert.equal(glove(recovered, 'black').quantity, 1);
  assert.equal(service(recovered, glove(recovered, 'black')).quantity, 1);
  assert.equal(recovered.incomplete, false);
  assert.deepEqual(unsafeOps(fixture.storage).filter(record => record.status !== 'terminal'), []);
});

test('P0-3: a partial recovery (parents without their service) is refused until a fresh attempt is chosen', async () => {
  const { fixture, cart } = await unsafeCart({ breakIn: true });
  fixture.failNextMutation(2);
  await assert.rejects(fixture.restore().recoverCart());
  const writes = mutations(fixture);
  await assert.rejects(fixture.restore().recoverCart(), error => error.code === 'recovery-unconfirmed');
  assert.equal(mutations(fixture), writes);
  assert.equal(fixture.storage.getItem(ACTIVE), cart.id);
  const recovered = await fixture.restore().recoverCart({ binding: await recoveryBindingOf(fixture), abandonUnconfirmed: true });
  assert.equal(service(recovered, glove(recovered, 'black')).quantity, 1);
  assert.equal(recovered.incomplete, false);
});

test('P0-3: a recovery stopped between create and attachment continues from the journaled candidate', async () => {
  const { fixture, cart } = await unsafeCart({ breakIn: true });
  const attachments = mutations(fixture, 'AddLines');
  let once = true;
  const restore = interceptWrites(fixture.storage, (key, value) => once && key.startsWith(UNSAFE_RECORD_PREFIX) &&
    value.includes('"stage":"children"'), () => { once = false; throw new Error('QuotaExceededError'); });
  await assert.rejects(fixture.restore().recoverCart(), error => error.code === 'storage-unavailable');
  restore();
  const [record] = recoveryRecords(fixture.storage);
  assert.equal(record.recovery.stage, 'created');
  assert.equal(mutations(fixture, 'AddLines'), attachments, 'the attachment was not sent');
  const creates = mutations(fixture, 'CreateCart');
  const recovered = await fixture.restore().recoverCart();
  assert.equal(mutations(fixture, 'CreateCart'), creates);
  assert.equal(recovered.id, record.recovery.candidateCartId);
  assert.notEqual(recovered.id, cart.id);
  assert.equal(service(recovered, glove(recovered, 'black')).quantity, 1);
  assert.deepEqual(unsafeOps(fixture.storage).filter(record => record.status !== 'terminal'), []);
});

test('P0-3: recovery that cannot journal itself sends nothing and leaves the original frozen', async () => {
  const { fixture, cart } = await unsafeCart();
  const restore = interceptWrites(fixture.storage, (key, value) => key.startsWith(UNSAFE_RECORD_PREFIX) && value.includes('"recovery"'),
    () => { throw new Error('QuotaExceededError'); });
  const creates = mutations(fixture, 'CreateCart');
  await assert.rejects(fixture.restore().recoverCart(), error => error.code === 'storage-unavailable');
  restore();
  assert.equal(mutations(fixture, 'CreateCart'), creates);
  assert.equal(fixture.storage.getItem(ACTIVE), cart.id);
  assert.equal((await fixture.restore().getCart()).incomplete, true);
});

// ---- P0-4: discount data must be complete before it is trusted ----

for (const [label, transform] of [
  ['absent', cart => { delete cart.discountCodes; }],
  ['null', cart => { cart.discountCodes = null; }],
  ['malformed code', cart => { cart.discountCodes = [{ code: 5, applicable: true }]; }],
  ['malformed applicable', cart => { cart.discountCodes = [{ code: 'KEEP', applicable: 'yes' }]; }]
]) {
  test(`P0-4: ${label} discount data on a read blocks discount writes and checkout without inventing an empty list`, async () => {
    const fixture = shopifyFixture({ discountCodes: [{ code: 'KEEP', applicable: true }], checkoutHost: 'ignvv0-zh.myshopify.com' });
    await fixture.commerce.listProducts();
    await fixture.commerce.addProduct('black', true);
    const commerce = await transformedReads(fixture, transform);
    // Task 2H (row 3): malformed discount data is invalid, never an empty list; the read rejects.
    await assert.rejects(commerce.getCart(), error => error.code === 'cart-unverified');
    const cart = await fixture.commerce.getCart();
    const before = mutations(fixture);
    await assert.rejects(commerce.applyDiscountCode('A10'));
    await assert.rejects(commerce.removeDiscountCode('KEEP'));
    assert.equal(mutations(fixture), before);
    assert.equal((await commerce.checkout(cart, {}, () => assert.fail('navigated'))).status, 'blocked');
    assert.deepEqual(unsafeOps(fixture.storage), [], 'a malformed read writes no service-data mark');
    assert.deepEqual(codes(await fixture.commerce.getCart()), ['KEEP']);
  });
}

// Task 2H: a response's cart contents are never authority; the fresh authoritative read decides and must hold
// exactly the intended codes, with unrelated codes kept.
for (const action of ['apply', 'remove']) {
  test(`P0-4: a ${action} response without discount data settles only from the fresh read`, async () => {
    const fixture = shopifyFixture({ discountCodes: [{ code: 'KEEP', applicable: true }, { code: 'OLD', applicable: true }] });
    await fixture.commerce.listProducts();
    await fixture.commerce.addProduct('black', false);
    fixture.transformNextMutationResponse(payload => { delete payload.cart.discountCodes; });
    const updated = await (action === 'apply' ? fixture.commerce.applyDiscountCode('A10') : fixture.commerce.removeDiscountCode('OLD'));
    assert.deepEqual(codes(updated), action === 'apply' ? ['A10', 'KEEP', 'OLD'] : ['KEEP']);
    assert.deepEqual(unsafeOps(fixture.storage).filter(record => record.status !== 'terminal'), []);
  });
}

test('P0-4: an inapplicable code is kept and reported as not valid; a rejected write keeps every code', async () => {
  const fixture = shopifyFixture({ discountCodes: [{ code: 'KEEP', applicable: true }],
    discountScenario: list => ({ discountCodes: list.map(code => ({ code, applicable: code !== 'NOPE' })) }) });
  await fixture.commerce.listProducts();
  await fixture.commerce.addProduct('black', false);
  const cart = await fixture.commerce.applyDiscountCode('NOPE');
  assert.deepEqual(codes(cart), ['KEEP', 'NOPE']);
  const feedback = discountResultFeedback(cart, { code: 'NOPE' });
  assert.equal(feedback.applied, false);
  assert.equal(feedback.error, true);
  fixture.setUserError('Code cannot be removed');
  await assert.rejects(fixture.commerce.removeDiscountCode('KEEP'), error => error.definitiveRejection === true);
  fixture.setUserError('');
  assert.deepEqual(codes(await fixture.commerce.getCart()), ['KEEP', 'NOPE']);
});

// ---- P1: pre-dispatch journal setup failures ----

test('P1: a revision write that fails before dispatch is a storage failure, not an unconfirmed create', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  const restore = interceptWrites(fixture.storage, key => key === REVISION, () => { throw new Error('SecurityError'); });
  await assert.rejects(fixture.commerce.addProduct('black', false), error => error.code === 'storage-unavailable');
  restore();
  assert.equal(fixture.requests.filter(request => /^mutation/.test(request.query)).length, 0);
  assert.deepEqual(unsafeOps(fixture.storage), [], 'no phantom record is left behind');
  assert.equal((await fixture.commerce.getCart()).unconfirmedCreate, undefined);
  assert.equal((await fixture.commerce.addProduct('black', false)).incomplete, false);
});

test('P1: unreadable storage is reported as such and offers no unusable Start a new cart action', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  // Enumeration itself fails, as it does when the browser blocks site data.
  Object.defineProperty(fixture.storage, 'length', { get() { throw new Error('SecurityError'); } });
  fixture.storage.key = () => { throw new Error('SecurityError'); };
  const cart = await fixture.commerce.getCart();
  assert.equal(cart.storageUnavailable, true);
  assert.equal(cart.unconfirmedCreate, undefined);
  const markup = cartFeedbackMarkup({ storageUnavailable: true, mode: 'shopify' }, escapeHtml);
  assert.doesNotMatch(markup, /data-start-new-cart/);
  assert.match(markup, /role="alert"/);
  assert.match(markup, /Allow site data/);
});

// ---- Web Locks failures ----

test('a rejected or cancelled lock request writes nothing and reports why', async () => {
  const fixture = shopifyFixture({ checkoutHost: 'ignvv0-zh.myshopify.com' });
  await fixture.commerce.listProducts();
  const cart = await fixture.commerce.addProduct('black', false);
  for (const [name, code] of [['SecurityError', 'lock-unavailable'], ['InvalidStateError', 'lock-unavailable'],
    ['AbortError', 'lock-timeout'], ['TimeoutError', 'lock-timeout']]) {
    const locks = { request: () => Promise.reject(new DOMException('lock refused', name)) };
    const commerce = await loaded(createShopifyCommerce(fixture.config, fixture.storage, fixture.fetchImpl, locks));
    const before = mutations(fixture);
    await assert.rejects(commerce.adjustLineQuantity(glove(cart, 'black').remoteLineId, 1), error => error.code === code, name);
    await assert.rejects(commerce.recoverCart(), error => error.code === code, name);
    assert.equal((await commerce.checkout(cart, {}, () => assert.fail('navigated'))).status, 'blocked', name);
    assert.equal(mutations(fixture), before, name);
  }
  // An error raised inside a held lock keeps its own meaning.
  const failing = shopifyFixture();
  await failing.commerce.listProducts();
  failing.setApiError(true);
  await assert.rejects(failing.commerce.addProduct('black', false), error => error.code === 'uncertain-create');
});

// ---- Same-variant siblings with different Break-In choices ----

test('same-variant siblings with different Break-In choices: a step after Shopify re-keys lines is refused', async () => {
  const fixture = shopifyFixture({ rekeyOnQuantityUpdate: true });
  await fixture.commerce.listProducts();
  await fixture.commerce.addProduct('black', true, { type: 'trainer', level: 'Game Ready (90%)', wearingStyle: 'Traditional' });
  const cart = await fixture.commerce.addProduct('black', true, { type: 'trainer', level: 'Firm (40%)', wearingStyle: 'Traditional' });
  const siblings = cart.lines.filter(line => line.productId === 'black' && !line.isBreakIn);
  assert.equal(siblings.length, 2);
  const [first, second] = siblings;
  assert.notEqual(cartLineIdentity(cart.lines, first), cartLineIdentity(cart.lines, second));
  const other = await tab(fixture);
  // The other tab's step makes Shopify re-key every line.
  const stepped = await other.adjustLineQuantity(second.remoteLineId, 1, shown(cart, second));
  const before = mutations(fixture);
  await assert.rejects(fixture.commerce.adjustLineQuantity(first.remoteLineId, 1, shown(cart, first)), error => error.code === 'cart-changed');
  assert.equal(mutations(fixture), before, 'the step never lands on the sibling');
  const current = await fixture.restore().getCart();
  const quantities = current.lines.filter(line => !line.isBreakIn).map(line => [cartLineIdentity(current.lines, line), line.quantity,
    service(current, line).quantity]).sort();
  assert.deepEqual(quantities, [[cartLineIdentity(cart.lines, first), 1, 1], [cartLineIdentity(cart.lines, second), 2, 2]].sort());
  // A step from the fresh view changes only the selected sibling and its own service.
  const fresh = current.lines.find(line => !line.isBreakIn && cartLineIdentity(current.lines, line) === cartLineIdentity(cart.lines, first));
  const after = await fixture.commerce.adjustLineQuantity(fresh.remoteLineId, 1, shown(current, fresh));
  const counts = after.lines.filter(line => !line.isBreakIn).map(line => [line.quantity, service(after, line).quantity]).sort();
  assert.deepEqual(counts, [[2, 2], [2, 2]]);
  assert.equal(stepped.incomplete, false);
});

// ---- Follow-up coverage for the corrections above ----

for (const failure of ['throws', 'ignored']) {
  test(`P1: a journal record write that ${failure} on an existing cart sends nothing and leaves no block behind`, async () => {
    const fixture = shopifyFixture();
    await fixture.commerce.listProducts();
    const cart = await fixture.commerce.addProduct('black', false);
    const restore = interceptWrites(fixture.storage, key => key.startsWith(UNSAFE_RECORD_PREFIX), () => {
      if (failure === 'throws') throw new Error('QuotaExceededError');
    });
    const before = mutations(fixture);
    await assert.rejects(fixture.commerce.setLineQuantity(glove(cart, 'black').remoteLineId, 2), error => error.code === 'storage-unavailable');
    restore();
    assert.equal(mutations(fixture), before);
    assert.deepEqual(unsafeOps(fixture.storage).filter(record => record.status !== 'terminal'), []);
    const same = await fixture.commerce.getCart();
    assert.equal(same.incomplete, false, 'this tab is not left blocked by a write that was never sent');
    assert.equal(glove(await fixture.commerce.setLineQuantity(glove(same, 'black').remoteLineId, 2), 'black').quantity, 2);
  });
}

test('a storage error raised while holding the lock is not reported as a lock failure', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  const cart = await fixture.commerce.addProduct('black', false);
  const getItem = fixture.storage.getItem.bind(fixture.storage);
  fixture.storage.getItem = () => { throw new DOMException('blocked', 'SecurityError'); };
  await assert.rejects(fixture.commerce.adjustLineQuantity(glove(cart, 'black').remoteLineId, 1),
    error => error.code !== 'lock-unavailable' && error.code !== 'lock-timeout');
  fixture.storage.getItem = getItem;
});

test('P0-4: recovery never copies a cart whose discount data Shopify did not return', async () => {
  const fixture = shopifyFixture({ discountCodes: [{ code: 'KEEP', applicable: true }] });
  await fixture.commerce.listProducts();
  const cart = await fixture.commerce.addProduct('black', false);
  fixture.setApiError(true);
  await assert.rejects(fixture.commerce.addProduct('blue', false));
  fixture.setApiError(false);
  const commerce = await transformedReads(fixture, payload => { payload.discountCodes = null; });
  const creates = mutations(fixture, 'CreateCart');
  await assert.rejects(commerce.recoverCart(), error => ['recovery-ambiguous', 'cart-unverified'].includes(error.code));
  assert.equal(mutations(fixture, 'CreateCart'), creates);
  assert.equal(fixture.storage.getItem(ACTIVE), cart.id);
});

test('P0-1: two different unconfirmed candidates are never adopted or abandoned automatically', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  const cart = await fixture.commerce.addProduct('black', false);
  fixture.storage.removeItem(ACTIVE);
  for (const [name, candidateCartId] of [['a', cart.id], ['b', 'gid://shopify/Cart/c99?key=k99']]) {
    fixture.storage.setItem(`${UNSAFE_RECORD_PREFIX}${name}`, JSON.stringify({ cartId: '*', candidateCartId,
      kind: 'addProduct', kinds: ['addition'], status: 'pending', createdAt: 1, createIntent: [] }));
  }
  const reloaded = await tab(fixture);
  await assert.rejects(reloaded.reconcileUnconfirmedCart(), error => error.code === 'recovery-ambiguous');
  await assert.rejects(reloaded.startNewCart(), error => error.code === 'create-reconcile-required');
  assert.equal(fixture.storage.getItem(ACTIVE), null);
  assert.equal(unsafeOps(fixture.storage).length, 2);
});

// Task 2H: with a known ID, Check unconfirmed cart comes first. Start a new cart follows only with the disclosure
// that the saved cart may remain, and commerce refuses it unless a fresh read shows that cart cannot be verified.
test('feedback offers a check first, and a disclosed new cart only as the fallback, when an unconfirmed cart ID is known', () => {
  const known = cartFeedbackMarkup({ unconfirmedCreate: true, unconfirmedCandidate: true, mode: 'shopify' }, escapeHtml);
  assert.match(known, /data-reconcile-cart/);
  assert.ok(known.indexOf('data-reconcile-cart') < known.indexOf('data-start-new-cart'));
  assert.match(known, /may still exist in Shopify/);
  const unknown = cartFeedbackMarkup({ unconfirmedCreate: true, mode: 'shopify' }, escapeHtml);
  assert.match(unknown, /data-start-new-cart/);
  assert.match(commerceErrorMessage({ code: 'create-reconcile-required' }), /Check unconfirmed cart/);
  assert.match(commerceErrorMessage({ code: 'cart-unresolved' }), /not been confirmed/);
});
