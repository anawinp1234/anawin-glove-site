// Phase 6 Task 2D: cart identity, shopper consent and recovery safety. Each section is a permanent
// negative control for one independently reproduced integration blocker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { shopifyFixture, recoveryBindingOf } from '../test-support/shopify-fixture.js';
import { createShopifyCommerce, UNSAFE_RECORD_PREFIX } from '../src/commerce.js';
import { cartFeedbackMarkup } from '../src/cart-feedback.js';

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
const mutations = (fixture, name = '') => fixture.requests.filter(request => /^mutation/.test(request.query) && request.query.includes(name)).length;
const glove = (cart, productId) => cart.lines.find(line => line.productId === productId && !line.isBreakIn);
const service = (cart, parent) => cart.lines.find(line => line.isBreakIn && line.parentLineId === parent.remoteLineId);
const escapeHtml = value => String(value).replace(/[&<>"]/g, character => `&#${character.charCodeAt(0)};`);
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
    const replaced = await after({ query, variables, payload });
    return answer(replaced ?? payload);
  };
  return loaded(createShopifyCommerce(fixture.config, fixture.storage, fetchImpl, fixture.locks));
}
function interceptWrites(storage, matches, behaviour) {
  const setItem = storage.setItem.bind(storage);
  storage.setItem = (key, value) => matches(key, String(value)) ? behaviour(setItem, key, value) : setItem(key, value);
  return () => { storage.setItem = setItem; };
}
// The next write matching `matches` lands, and the read-back of that key then throws once.
function throwingReadBack(storage, matches) {
  const getItem = storage.getItem.bind(storage);
  let armed = false;
  const restoreWrites = interceptWrites(storage, () => true, (setItem, key, value) => {
    setItem(key, value);
    if (!armed && matches(key, String(value))) armed = key;
  });
  let fired = false;
  storage.getItem = key => {
    if (armed && !fired && key === armed) { fired = true; throw new DOMException('read refused', 'SecurityError'); }
    return getItem(key);
  };
  return () => { restoreWrites(); storage.getItem = getItem; };
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
// A first cart whose ID was received but never published, with `createIntent` as the attempted add.
function strandCandidate(fixture, candidateCartId, createIntent, name = 'closed-tab') {
  fixture.storage.removeItem(ACTIVE);
  fixture.storage.setItem(`${UNSAFE_RECORD_PREFIX}${name}`, JSON.stringify({ cartId: '*', candidateCartId, kind: 'addProduct',
    kinds: ['addition'], status: 'pending', createdAt: 1, dispatched: true, createIntent }));
}
const blueIntent = cart => [{ merchandiseId: 'gid://variant/ob16', quantity: 1, attributes: glove(cart, 'black').attributes, parentMerchandiseId: null }];

// ---- HIGH-1: Keep and Start a new cart are bound to the exact displayed review snapshot ----

for (const action of ['keep', 'discard']) {
  test(`HIGH-1: stale ${action} consent given for mismatched cart A never applies to mismatched cart B`, async () => {
    const fixture = shopifyFixture();
    await fixture.commerce.listProducts();
    const cartA = await fixture.commerce.addProduct('black', false);
    strandCandidate(fixture, cartA.id, blueIntent(cartA));
    const tabA = await tab(fixture);
    await tabA.reconcileUnconfirmedCart();
    const shownA = await tabA.getCart();
    assert.equal(shownA.createMismatch, true);
    // Another tab discards A, then a second mismatched first cart B becomes active.
    const other = await tab(fixture);
    await other.discardUnconfirmedCart(await other.getCart());
    const cartB = await other.addProduct('black', false);
    assert.notEqual(cartB.id, cartA.id);
    strandCandidate(fixture, cartB.id, blueIntent(cartB), 'closed-tab-b');
    await other.reconcileUnconfirmedCart();
    const before = { active: fixture.storage.getItem(ACTIVE), records: rawOps(fixture.storage) };
    assert.equal(before.active, cartB.id);
    await assert.rejects(action === 'keep' ? tabA.keepUnconfirmedCart(shownA) : tabA.discardUnconfirmedCart(shownA),
      error => error.code === 'cart-changed');
    assert.deepEqual({ active: fixture.storage.getItem(ACTIVE), records: rawOps(fixture.storage) }, before, 'nothing changes on stale consent');
    // Without any snapshot there is no consent either.
    await assert.rejects(action === 'keep' ? tabA.keepUnconfirmedCart() : tabA.discardUnconfirmedCart(), error => error.code === 'cart-changed');
    assert.deepEqual({ active: fixture.storage.getItem(ACTIVE), records: rawOps(fixture.storage) }, before);
    // A fresh review of B is required, and then applies to B only.
    const shownB = await tabA.getCart();
    assert.equal(shownB.id, cartB.id);
    assert.equal(shownB.createMismatch, true);
    const resolved = action === 'keep' ? await tabA.keepUnconfirmedCart(shownB) : await tabA.discardUnconfirmedCart(shownB);
    assert.equal(resolved.id, action === 'keep' ? cartB.id : null);
    assert.deepEqual(unsafeOps(fixture.storage).filter(record => record.status !== 'terminal'), []);
  });
}

test('HIGH-1: a snapshot of the same cart that no longer matches Shopify is refused for both actions', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  const cart = await fixture.commerce.addProduct('black', false);
  strandCandidate(fixture, cart.id, blueIntent(cart));
  const shopper = await tab(fixture);
  await shopper.reconcileUnconfirmedCart();
  const shown = await shopper.getCart();
  await (await fixture.detached()).setLineQuantity(glove(shown, 'black').remoteLineId, 2);
  const before = rawOps(fixture.storage);
  for (const resolve of [() => shopper.keepUnconfirmedCart(shown), () => shopper.discardUnconfirmedCart(shown)]) {
    await assert.rejects(resolve(), error => error.code === 'cart-changed');
    assert.deepEqual(rawOps(fixture.storage), before);
    assert.equal(fixture.storage.getItem(ACTIVE), cart.id);
  }
});

// ---- HIGH-2: the candidate is re-read authoritatively after any attachment, before adoption ----

const cartReadQuery = fixture => fixture.requests.find(request => isCartRead(request.query)).query;
test('HIGH-2: a same-ID attachment response claiming a service Shopify never saved is not adopted', async () => {
  const { fixture, cart } = await unsafeCart({}, { breakIn: true });
  const sourceChild = structuredClone((await (await fixture.fetchImpl('https://store.myshopify.com/api/2026-07/graphql.json',
    { body: JSON.stringify({ query: cartReadQuery(fixture), variables: { id: cart.id } }) })).json()).data.cart.lines.nodes.find(line => line.parentRelationship));
  const lying = await hookedTab(fixture, { before: async ({ query, variables }) => {
    if (!query.includes('mutation AddLines') || variables.cartId === cart.id) return null;
    // Report the attachment as saved without sending it.
    const read = await (await fixture.fetchImpl('https://store.myshopify.com/api/2026-07/graphql.json',
      { body: JSON.stringify({ query: cartReadQuery(fixture), variables: { id: variables.cartId } }) })).json();
    const claimed = read.data.cart;
    const parentLine = claimed.lines.nodes[0];
    claimed.lines.nodes.push({ ...sourceChild, id: 'line-claimed', parentRelationship: { parent: { id: parentLine.id, merchandise: parentLine.merchandise } } });
    return answer({ data: { cartLinesAdd: { cart: claimed, userErrors: [], warnings: [] } } });
  } });
  await assert.rejects(lying.recoverCart());
  assert.equal(fixture.storage.getItem(ACTIVE), cart.id, 'no candidate is published');
  assert.ok(recoveryRecords(fixture.storage).length, 'the journal is preserved');
  assert.ok(unsafeOps(fixture.storage).some(record => record.kind === 'addProduct'), 'the source records are preserved');
});

for (const [label, rewrite] of [
  ['a missing child', nodes => nodes.filter(line => !line.parentRelationship)],
  ['a duplicate child', nodes => [...nodes, { ...nodes.find(line => line.parentRelationship), id: 'line-duplicate' }]],
  ['a child attached to the wrong parent', nodes => nodes.map(line => line.parentRelationship
    ? { ...line, parentRelationship: { parent: { ...line.parentRelationship.parent, id: 'line-elsewhere' } } } : line)],
  ['changed child options', nodes => nodes.map(line => line.parentRelationship
    ? { ...line, attributes: line.attributes.map(attribute => attribute.key === 'Break-In Level' ? { ...attribute, value: 'Firm (40%)' } : attribute) } : line)]
]) {
  test(`HIGH-2: an authoritative re-read with ${label} after attachment stops adoption`, async () => {
    const { fixture, cart } = await unsafeCart({}, { breakIn: true });
    let attached = false;
    const recovering = await hookedTab(fixture, { after: ({ query, variables, payload }) => {
      if (query.includes('mutation AddLines') && variables.cartId !== cart.id) attached = true;
      if (attached && isCartRead(query) && variables.id !== cart.id) payload.data.cart.lines.nodes = rewrite(payload.data.cart.lines.nodes);
      return payload;
    } });
    await assert.rejects(recovering.recoverCart());
    assert.equal(attached, true);
    assert.equal(fixture.storage.getItem(ACTIVE), cart.id);
    assert.ok(recoveryRecords(fixture.storage).length);
  });
}

// ---- HIGH-3: completeness requires explicit, well-formed pagination data ----

const pageInfoCases = [
  ['missing pageInfo', lines => { delete lines.pageInfo; }],
  ['null pageInfo', lines => { lines.pageInfo = null; }],
  ['missing hasNextPage', lines => { lines.pageInfo = {}; }],
  ['null hasNextPage', lines => { lines.pageInfo = { hasNextPage: null }; }],
  ['a string hasNextPage', lines => { lines.pageInfo = { hasNextPage: 'false' }; }],
  ['a further page', lines => { lines.pageInfo = { hasNextPage: true }; }]
];
for (const [label, rewrite] of pageInfoCases) {
  test(`HIGH-3: ${label} on the final source read stops adoption`, async () => {
    const { fixture, cart } = await unsafeCart();
    let reads = 0;
    const recovering = await hookedTab(fixture, { after: ({ query, variables, payload }) => {
      if (isCartRead(query) && variables.id === cart.id && ++reads === 2) rewrite(payload.data.cart.lines);
      return payload;
    } });
    // Task 2H: malformed pagination is invalid data (cart-unverified); a well-formed further page that changes
    // the cart is a changed source (recovery-ambiguous). Either way nothing is adopted.
    await assert.rejects(recovering.recoverCart(), error => ['recovery-ambiguous', 'cart-unverified'].includes(error.code));
    assert.equal(fixture.storage.getItem(ACTIVE), cart.id);
    assert.ok(recoveryRecords(fixture.storage).length);
  });

  test(`HIGH-3: ${label} on a candidate read keeps the candidate unconfirmed`, async () => {
    const fixture = shopifyFixture();
    await fixture.commerce.listProducts();
    const cart = await fixture.commerce.addProduct('black', false);
    strandCandidate(fixture, cart.id, [{ merchandiseId: 'gid://variant/br16', quantity: 1, attributes: glove(cart, 'black').attributes }]);
    const checking = await hookedTab(fixture, { after: ({ query, payload }) => {
      if (isCartRead(query) && payload.data?.cart) rewrite(payload.data.cart.lines);
      return payload;
    } });
    await assert.rejects(checking.reconcileUnconfirmedCart(), error => error.code === 'cart-unverified');
    assert.equal(fixture.storage.getItem(ACTIVE), null);
    assert.equal(unsafeOps(fixture.storage)[0].candidateCartId, cart.id);
  });
}

test('HIGH-3: every cart read reports explicit pagination, and a well-formed last page is complete', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  const cart = await fixture.commerce.addProduct('black', false);
  assert.equal(cart.lineCoverageComplete, true);
  const read = fixture.requests.filter(request => isCartRead(request.query)).at(-1);
  // Task 2H: reads page by cursor and assemble every page before validation.
  assert.match(read.query, /lines\(first: 50, after: \$after\) \{\s*pageInfo \{ hasNextPage endCursor \}/);
});

// ---- HIGH-4: the selected hand is part of the first-cart intent ----

async function strandedFullSize({ hand, breakIn }) {
  const fixture = shopifyFixture({ fullSize: true });
  await fixture.commerce.listProducts();
  const restore = interceptWrites(fixture.storage, key => key === ACTIVE, () => {});
  await assert.rejects(fixture.commerce.addProduct('full-mint', breakIn, breakIn ? fullSizeOptions : undefined, `gid://variant/mi26-${hand}`),
    error => error.code === 'uncertain-create');
  restore();
  const [record] = unsafeOps(fixture.storage);
  return { fixture, record };
}
const handOf = node => node.merchandise.selectedOptions.find(option => option.name === 'Throwing Hand')?.value;

for (const breakIn of [false, true]) {
  test(`HIGH-4: a right-hand request whose candidate reports a left hand is never adopted (${breakIn ? 'serviced' : 'unserviced'})`, async () => {
    const { fixture, record } = await strandedFullSize({ hand: 'right', breakIn });
    assert.equal(record.createIntent.find(line => !line.parentMerchandiseId).throwingHand, 'Right', 'the shopper’s hand is journaled');
    const contradicting = await hookedTab(fixture, { after: ({ query, payload }) => {
      if (!isCartRead(query) || !payload.data?.cart) return payload;
      for (const node of payload.data.cart.lines.nodes) {
        if (!node.parentRelationship) node.merchandise.selectedOptions = [{ name: 'Throwing Hand', value: 'Left' }];
      }
      return payload;
    } });
    // Task 2H: a contradictory hand is invalid data, which cannot enter the consent flow: reconciliation refuses it
    // and changes nothing, so the candidate stays journaled and nothing is created.
    const before = rawOps(fixture.storage);
    await assert.rejects(contradicting.reconcileUnconfirmedCart(), error => error.code === 'cart-unverified');
    assert.deepEqual(rawOps(fixture.storage), before);
    assert.equal(fixture.storage.getItem(ACTIVE), null);
    await assert.rejects(contradicting.addProduct('full-mint', false, undefined, 'gid://variant/mi26-right'), error => error.code === 'create-unresolved');
    assert.equal(mutations(fixture, 'CreateCart'), 1);
  });
}

for (const hand of ['right', 'left']) {
  test(`HIGH-4: an honest ${hand}-hand candidate is adopted with its hand`, async () => {
    const { fixture, record } = await strandedFullSize({ hand, breakIn: false });
    assert.equal(record.createIntent[0].throwingHand, hand === 'right' ? 'Right' : 'Left');
    const adopted = await (await tab(fixture)).reconcileUnconfirmedCart();
    assert.equal(adopted.incomplete, false);
    assert.equal(glove(adopted, 'full-mint').throwingHand, hand === 'right' ? 'Right' : 'Left');
    assert.deepEqual(unsafeOps(fixture.storage).filter(record => record.status !== 'terminal'), []);
  });
}

test('HIGH-4: recovery of an active unresolved first cart compares the journaled hand', async () => {
  const fixture = shopifyFixture({ fullSize: true });
  await fixture.commerce.listProducts();
  const cart = await fixture.commerce.addProduct('full-mint', false, undefined, 'gid://variant/mi26-right');
  fixture.storage.setItem(`${UNSAFE_RECORD_PREFIX}create`, JSON.stringify({ cartId: cart.id, kind: 'addProduct', kinds: ['addition'],
    status: 'unresolved', createdAt: 1, dispatched: true, createIntent: [{ merchandiseId: 'gid://variant/mi26-right', quantity: 1,
      attributes: glove(cart, 'full-mint').attributes, parentMerchandiseId: null, throwingHand: 'Left' }] }));
  await assert.rejects((await tab(fixture)).recoverCart(), error => error.code === 'create-mismatch');
  assert.equal(mutations(fixture, 'CreateCart'), 1);
});

// ---- HIGH-5: only a well-formed GraphQL envelope can say a cart does not exist ----

const envelopes = {
  'cart null with a malformed errors object': { data: { cart: null }, errors: { message: 'malformed' } },
  'cart null with an errors string': { data: { cart: null }, errors: 'malformed' },
  'cart null with a nonempty errors array': { data: { cart: null }, errors: [{ message: 'Throttled' }] },
  'missing data': { errors: [] },
  'null data': { data: null },
  'an absent cart field': { data: {} }
};
for (const [label, envelope] of Object.entries(envelopes)) {
  test(`HIGH-5: a candidate read with ${label} keeps the candidate and blocks another cart`, async () => {
    const fixture = shopifyFixture();
    await fixture.commerce.listProducts();
    const cart = await fixture.commerce.addProduct('black', false);
    strandCandidate(fixture, cart.id, [{ merchandiseId: 'gid://variant/br16', quantity: 1, attributes: glove(cart, 'black').attributes }]);
    const unclear = await hookedTab(fixture, { before: ({ query, variables }) =>
      isCartRead(query) && variables.id === cart.id ? answer(envelope) : null });
    await assert.rejects(unclear.reconcileUnconfirmedCart(), error => error.code === 'cart-unverified');
    assert.equal(unsafeOps(fixture.storage)[0].candidateCartId, cart.id);
    await assert.rejects(unclear.startNewCart(), error => error.code === 'create-reconcile-required');
    await assert.rejects(unclear.addProduct('blue', false), error => error.code === 'create-unresolved');
    assert.equal(mutations(fixture, 'CreateCart'), 1);
  });

  test(`HIGH-5: an active-cart read with ${label} never forgets the cart`, async () => {
    const fixture = shopifyFixture();
    await fixture.commerce.listProducts();
    const cart = await fixture.commerce.addProduct('black', false);
    const unclear = await hookedTab(fixture, { before: ({ query }) => isCartRead(query) ? answer(envelope) : null });
    await assert.rejects(unclear.getCart(), error => error.code === 'cart-unverified');
    assert.equal(fixture.storage.getItem(ACTIVE), cart.id);
  });
}

test('HIGH-5: a well-formed explicit null clears the candidate', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  const cart = await fixture.commerce.addProduct('black', false);
  strandCandidate(fixture, cart.id, []);
  for (const envelope of [{ data: { cart: null } }, { data: { cart: null }, errors: [] }]) {
    fixture.storage.setItem(`${UNSAFE_RECORD_PREFIX}closed-tab`, JSON.stringify({ cartId: '*', candidateCartId: cart.id, kind: 'addProduct',
      kinds: ['addition'], status: 'pending', createdAt: 1, dispatched: true, createIntent: [] }));
    const gone = await hookedTab(fixture, { before: ({ query, variables }) =>
      isCartRead(query) && variables.id === cart.id ? answer(envelope) : null });
    assert.equal((await gone.reconcileUnconfirmedCart()).unconfirmedCandidate, undefined, JSON.stringify(envelope));
  }
});

test('HIGH-5: a mutation whose envelope carries malformed errors is unresolved, never success', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  const cart = await fixture.commerce.addProduct('black', false);
  const malformed = await hookedTab(fixture, { after: ({ query, payload }) => query.startsWith('mutation') ? { ...payload, errors: { message: 'malformed' } } : payload });
  await assert.rejects(malformed.setLineQuantity(glove(cart, 'black').remoteLineId, 2), error => error.code === 'uncertain');
  assert.equal(unsafeOps(fixture.storage)[0].status, 'unresolved');
});

// ---- MEDIUM-1: the earlier recovery attempt stays until the replacement is journaled and ready ----

async function lostAttachment() {
  const setup = await unsafeCart({}, { breakIn: true });
  setup.fixture.failAfterNextMutation(2);
  await assert.rejects((await tab(setup.fixture)).recoverCart(), error => error.code === 'uncertain');
  const earlier = rawOps(setup.fixture.storage);
  return { ...setup, earlier, candidateCartId: recoveryRecords(setup.fixture.storage)[0].recovery.candidateCartId };
}
const isNewRecovery = earlier => (key, value) => key.startsWith(UNSAFE_RECORD_PREFIX) && !Object.hasOwn(earlier, key) && value.includes('"recovery"');
const boundaries = {
  'the replacement journal write throws': ({ storage, earlier }) =>
    interceptWrites(storage, isNewRecovery(earlier), () => { throw new Error('QuotaExceededError'); }),
  'the replacement journal read-back throws': ({ storage, earlier }) => throwingReadBack(storage, isNewRecovery(earlier)),
  'the ready (dispatched) write throws': ({ storage, earlier }) =>
    interceptWrites(storage, (key, value) => isNewRecovery(earlier)(key, value) && value.includes('"dispatched":true'), () => { throw new Error('QuotaExceededError'); }),
  'the ready (dispatched) read-back throws': ({ storage, earlier }) =>
    throwingReadBack(storage, (key, value) => isNewRecovery(earlier)(key, value) && value.includes('"dispatched":true')),
  'removing the earlier record throws': ({ storage, earlier }) => {
    const removeItem = storage.removeItem.bind(storage);
    storage.removeItem = key => { if (Object.hasOwn(earlier, key)) throw new Error('SecurityError'); return removeItem(key); };
    return () => { storage.removeItem = removeItem; };
  }
};
for (const [label, fault] of Object.entries(boundaries)) {
  // Task 2H: supersession is logical, so a fresh attempt never removes the earlier record; this fault never fires.
  if (label === 'removing the earlier record throws') {
    test(`MEDIUM-1: when ${label}, the earlier record is never removed and the fresh attempt completes once`, async () => {
      const { fixture, cart, earlier, candidateCartId } = await lostAttachment();
      const restore = fault({ storage: fixture.storage, earlier });
      const creates = mutations(fixture, 'CreateCart');
      const recovered = await (await tab(fixture)).recoverCart({ binding: await recoveryBindingOf(fixture), abandonUnconfirmed: true });
      restore();
      assert.equal(mutations(fixture, 'CreateCart'), creates + 1);
      assert.notEqual(recovered.id, cart.id);
      assert.notEqual(recovered.id, candidateCartId);
      assert.ok(Object.values(rawOps(fixture.storage)).some(raw => raw.includes(candidateCartId)), 'the earlier candidate stays discoverable');
    });
    continue;
  }
  test(`MEDIUM-1: when ${label}, nothing is sent and the earlier candidate stays adoptable across reload`, async () => {
    const { fixture, cart, earlier, candidateCartId } = await lostAttachment();
    const writes = mutations(fixture);
    const restore = fault({ storage: fixture.storage, earlier });
    await assert.rejects((await tab(fixture)).recoverCart({ binding: await recoveryBindingOf(fixture), abandonUnconfirmed: true }), error => error.code === 'storage-unavailable');
    restore();
    assert.equal(mutations(fixture), writes, 'no CreateCart or attachment is sent');
    for (const [key, value] of Object.entries(earlier)) assert.equal(fixture.storage.getItem(key), value, 'every earlier record is kept');
    assert.equal(fixture.storage.getItem(ACTIVE), cart.id);
    const adopted = await (await tab(fixture)).recoverCart();
    assert.equal(adopted.id, candidateCartId);
    assert.equal(service(adopted, glove(adopted, 'black')).quantity, 1);
  });
}

// ---- MEDIUM-2: a stage read-back that throws before the attachment is sent stays resumable ----

test('MEDIUM-2: a children-stage read-back that throws before AddLines leaves a resumable stage', async () => {
  const { fixture, cart } = await unsafeCart({}, { breakIn: true });
  const restore = throwingReadBack(fixture.storage, (key, value) => key.startsWith(UNSAFE_RECORD_PREFIX) && value.includes('"stage":"children"'));
  const attachments = mutations(fixture, 'AddLines');
  await assert.rejects((await tab(fixture)).recoverCart(), error => error.code === 'storage-unavailable');
  restore();
  assert.equal(mutations(fixture, 'AddLines'), attachments, 'no attachment was dispatched');
  const creates = mutations(fixture, 'CreateCart');
  const recovered = await (await tab(fixture)).recoverCart();
  assert.equal(mutations(fixture, 'CreateCart'), creates, 'the journaled candidate is continued, not recreated');
  assert.notEqual(recovered.id, cart.id);
  assert.equal(service(recovered, glove(recovered, 'black')).quantity, 1);
  assert.deepEqual(unsafeOps(fixture.storage).filter(record => record.status !== 'terminal'), []);
});

test('MEDIUM-2: an attachment that may have been sent is reconciled from Shopify, never resent', async () => {
  const { fixture, cart } = await unsafeCart({}, { breakIn: true });
  fixture.failNextMutation(2);
  await assert.rejects((await tab(fixture)).recoverCart());
  const writes = mutations(fixture);
  await assert.rejects((await tab(fixture)).recoverCart(), error => error.code === 'recovery-unconfirmed');
  assert.equal(mutations(fixture), writes, 'the attachment is not replayed');
  assert.equal(fixture.storage.getItem(ACTIVE), cart.id);
});

// ---- UX: Try recovery again keeps the shopper's Break-In choice ----

test('UX: after a glove-only attempt, Try recovery again stays glove-only and adding service is an explicit switch', async () => {
  const { fixture, cart } = await unsafeCart({}, { breakIn: true });
  fixture.failAfterNextMutation(1);
  await assert.rejects((await tab(fixture)).recoverCart({ withoutBreakIn: true }), error => error.code === 'uncertain');
  const shown = await (await tab(fixture)).getCart();
  assert.equal(shown.recoveryAttemptWithoutBreakIn, true);
  const markup = cartFeedbackMarkup({ ...shown, mode: 'shopify' }, escapeHtml);
  assert.match(markup, /data-recover-retry [^>]*>Try recovery again without Break-In Service</);
  assert.match(markup, /data-recover-retry-with-service [^>]*>Start over with Break-In Service</);
  assert.doesNotMatch(markup, /data-recover-retry-without-service/);
  // The default retry, exactly as the drawer sends it, keeps the glove-only choice.
  const recovered = await (await tab(fixture)).recoverCart({ binding: await recoveryBindingOf(fixture), abandonUnconfirmed: true, withoutBreakIn: shown.recoveryAttemptWithoutBreakIn });
  assert.notEqual(recovered.id, cart.id);
  assert.equal(fixture.cartLines(recovered.id).some(line => line.parentRelationship), false, 'Shopify holds no paid service');
  assert.equal(recovered.lines.some(line => line.isBreakIn), false);
});

test('UX: after a serviced attempt, the labels name the Break-In choice each action makes', () => {
  const markup = cartFeedbackMarkup({ incomplete: true, recoveryAvailable: true, recoveryHasBreakIn: true, recoveryUnconfirmed: true,
    recoveryAttemptWithoutBreakIn: false, mode: 'shopify' }, escapeHtml);
  assert.match(markup, /data-recover-retry [^>]*>Try recovery again with Break-In Service</);
  assert.match(markup, /data-recover-retry-without-service [^>]*>Start over without Break-In Service</);
  const plain = cartFeedbackMarkup({ incomplete: true, recoveryAvailable: true, recoveryUnconfirmed: true, mode: 'shopify' }, escapeHtml);
  assert.match(plain, /data-recover-retry [^>]*>Try recovery again</);
});
