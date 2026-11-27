// Phase 6 Task 2H: the fixed acceptance matrix for one browser-side cart transaction model. Every row runs a
// positive and a negative control from independent storage and fixture carts. Each asserts mutation counts by
// field, saved fixture carts by ID (independent of any response), the active pointer, the raw bytes of every
// retained or foreign journal record, terminal or blocking state, and checkout navigations, in the original
// commerce instance and in a new one sharing only durable storage. Scenarios ported from the independent 2G
// probe script assert the corrected outcome, never the unsafe baseline it recorded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { shopifyFixture, createLockManager } from '../test-support/shopify-fixture.js';
import { createShopifyCommerce, trustedCartId, UNSAFE_RECORD_PREFIX } from '../src/commerce.js';
import { cartFeedbackMarkup } from '../src/cart-feedback.js';

const ACTIVE = 'anawin-shopify-cart-id';
const fullSizeOptions = { type: 'full-size', wearingStyle: 'Traditional — index finger out', closure: 'Ring finger', thumbShape: 'Straight',
  pinkyShape: 'Flared', fingerShape: 'Rolled', firmness: 'Medium', notes: '' };
const FIELDS = { cartCreate: 'mutation CreateCart', cartLinesAdd: 'mutation AddLines', cartLinesUpdate: 'mutation UpdateLines',
  cartLinesRemove: 'mutation RemoveLines', cartDiscountCodesUpdate: 'mutation UpdateDiscountCodes', cartAttributesUpdate: 'mutation UpdateCartAttributes' };
async function loaded(commerce) {
  await commerce.listProducts();
  await commerce.getBreakInService();
  await commerce.getFullSizeBreakInService();
  return commerce;
}
const tab = fixture => loaded(fixture.restore());
const rawOps = storage => Object.fromEntries([...storage.values.entries()].filter(([key]) => key.startsWith(UNSAFE_RECORD_PREFIX)));
const ops = storage => Object.entries(rawOps(storage)).map(([key, raw]) => ({ key, raw, ...JSON.parse(raw) }));
const blocking = storage => ops(storage).filter(record => record.status !== 'terminal');
const everything = storage => Object.fromEntries(storage.values);
const count = (fixture, field) => fixture.requests.filter(request => request.query.startsWith(FIELDS[field])).length;
const allMutations = fixture => fixture.requests.filter(request => /^mutation/.test(request.query)).length;
const glove = (cart, productId = 'black') => cart.lines.find(line => line.productId === productId && !line.isBreakIn);
const service = (cart, parent) => cart.lines.find(line => line.isBreakIn && line.parentLineId === parent.remoteLineId);
const isCartRead = query => query.startsWith('query Cart(');
const answer = (payload, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => payload });
const namesId = (storage, id) => Object.values(rawOps(storage)).some(raw => raw.includes(JSON.stringify(id).slice(1, -1)));
// A commerce instance whose transport passes through `intercept(request, forward)`.
function intercepted(fixture, intercept) {
  return loaded(createShopifyCommerce(fixture.config, fixture.storage, (url, options) => {
    const request = JSON.parse(options.body);
    return intercept(request, () => fixture.fetchImpl(url, options), options);
  }, fixture.locks));
}
// Rewrites decoded envelopes after the fixture answered (the fixture's saved state is untouched).
const rewriting = (fixture, rewrite) => intercepted(fixture, async (request, forward) => {
  const response = await forward();
  if (!response.ok) return response;
  const envelope = await response.json();
  return answer((await rewrite(request, envelope)) ?? envelope);
});
async function checkout(commerce, cart) {
  let navigations = 0;
  const result = await commerce.checkout(cart, {}, () => { navigations++; });
  return { navigations, ...result };
}
async function repeatedCheckout(fixture, make, shown, clicks = 4) {
  let navigations = 0; let cart = shown; const statuses = [];
  for (let click = 0; click < clicks; click++) {
    const commerce = click === clicks - 1 ? await make() : (make.instance ||= await make());
    const result = await checkout(commerce, cart);
    navigations += result.navigations; statuses.push(result.status);
    if (result.cart) cart = result.cart;
  }
  return { navigations, statuses };
}
async function serviced(options = {}) {
  const fixture = shopifyFixture(options);
  await fixture.commerce.listProducts();
  const cart = await fixture.commerce.addProduct('black', true);
  return { fixture, cart };
}
// A frozen serviced cart (a checkout was handed off) that recovery copies into a new cart.
async function frozenServiced() {
  const { fixture, cart } = await serviced();
  assert.equal((await checkout(await tab(fixture), cart)).navigations, 1);
  return { fixture, cart, freeze: rawOps(fixture.storage) };
}

// ---- Row 1 (2G finding 1): a mutation Shopify saved, then answered with HTTP 422 ----

const ordinaryPaths = {
  'ordinary create': { field: 'cartCreate', setup: async () => null, run: commerce => commerce.addProduct('black', false),
    saved: fixture => fixture.cartLines().length === 1 },
  'add to an existing cart': { field: 'cartLinesAdd', setup: commerce => commerce.addProduct('black', false), run: commerce => commerce.addProduct('blue', false),
    saved: fixture => fixture.cartLines().length === 2 },
  'quantity update': { field: 'cartLinesUpdate', setup: commerce => commerce.addProduct('black', false),
    run: async commerce => commerce.setLineQuantity(glove(await commerce.getCart()).remoteLineId, 2), saved: fixture => fixture.cartLines()[0].quantity === 2 },
  'removal': { field: 'cartLinesRemove', setup: commerce => commerce.addProduct('black', false),
    run: async commerce => commerce.removeLine(glove(await commerce.getCart()).remoteLineId), saved: fixture => fixture.cartLines().length === 0 },
  'discount apply': { field: 'cartDiscountCodesUpdate', setup: commerce => commerce.addProduct('black', false), run: commerce => commerce.applyDiscountCode('SAVE'),
    saved: fixture => fixture.savedDiscountCodes.length === 1 },
  'discount remove': { field: 'cartDiscountCodesUpdate', setup: async commerce => { await commerce.addProduct('black', false); return commerce.applyDiscountCode('SAVE'); },
    run: commerce => commerce.removeDiscountCode('SAVE'), saved: fixture => fixture.savedDiscountCodes.length === 0 }
};
for (const [label, path] of Object.entries(ordinaryPaths)) {
  test(`1 positive: a clean ${label} settles only after a fresh verified read, with one dispatch`, async () => {
    const fixture = shopifyFixture();
    await fixture.commerce.listProducts();
    await path.setup(fixture.commerce);
    const before = count(fixture, path.field);
    await path.run(fixture.commerce);
    assert.equal(count(fixture, path.field), before + 1);
    assert.ok(await path.saved(fixture));
    assert.deepEqual(blocking(fixture.storage), []);
    const reloaded = await tab(fixture);
    assert.equal((await reloaded.getCart()).incomplete, false);
  });
  for (const body of [true, false]) {
    test(`1 negative: a ${label} saved by Shopify then answered HTTP 422 (${body ? 'original JSON' : 'no usable body'}) stays blocking; no replay`, async () => {
      const fixture = shopifyFixture();
      await fixture.commerce.listProducts();
      await path.setup(fixture.commerce);
      const shown = await fixture.commerce.getCart();
      fixture.faultAfterSave({ status: 422, body });
      await assert.rejects(path.run(fixture.commerce), error => ['uncertain', 'uncertain-create'].includes(error.code));
      assert.ok(await path.saved(fixture), 'Shopify saved the change');
      const [owner] = blocking(fixture.storage);
      assert.ok(owner, 'the owning journal still blocks');
      if (path.field === 'cartCreate' && body) assert.equal(owner.candidateCartId, fixture.mainId, 'the created ID is durable');
      const sent = allMutations(fixture);
      for (const commerce of [fixture.commerce, await tab(fixture)]) {
        await assert.rejects(path.run(commerce));
        assert.equal((await checkout(commerce, shown.id ? shown : await commerce.getCart().catch(() => shown))).navigations, 0);
      }
      assert.equal(allMutations(fixture), sent, 'zero duplicate mutations after the fault and after reload');
    });
  }
  test(`1 negative: a ${label} answered HTTP 422 before Shopify applied it still stays unresolved`, async () => {
    const fixture = shopifyFixture();
    await fixture.commerce.listProducts();
    await path.setup(fixture.commerce);
    fixture.rejectNextMutation();
    await assert.rejects(path.run(fixture.commerce));
    assert.equal(blocking(fixture.storage).length, 1);
    const sent = allMutations(fixture);
    await assert.rejects(path.run(await tab(fixture)));
    assert.equal(allMutations(fixture), sent);
  });
}

for (const body of [true, false]) {
  test(`1: preorder attributes saved then answered HTTP 422 (${body ? 'with body' : 'no body'}) block this and later checkouts across reload`, async () => {
    const fixture = shopifyFixture({ fullSize: true });
    await fixture.commerce.listProducts();
    const cart = await fixture.commerce.addProduct('full-mint', false, undefined, 'gid://variant/mi26-right');
    fixture.faultAfterSave({ status: 422, body });
    const first = await checkout(fixture.commerce, cart);
    assert.equal(first.navigations, 0);
    assert.ok(fixture.cartAttributes.length, 'Shopify saved the attribute');
    assert.equal(blocking(fixture.storage).length, 1);
    const journal = rawOps(fixture.storage);
    const writes = count(fixture, 'cartAttributesUpdate');
    assert.equal(writes, 1);
    for (const commerce of [fixture.commerce, await tab(fixture), await tab(fixture), await tab(fixture)]) {
      assert.equal((await checkout(commerce, cart)).navigations, 0);
    }
    assert.equal(count(fixture, 'cartAttributesUpdate'), writes, 'never resent');
    assert.equal(Object.keys(journal).length, 1, 'no freeze was written');
    assert.deepEqual(rawOps(fixture.storage), journal, 'the unresolved journal survives reload and repeated refusals');
  });
}

test('1 positive: preorder attributes are written once, verified by a fresh read, then checkout navigates once', async () => {
  const fixture = shopifyFixture({ fullSize: true });
  await fixture.commerce.listProducts();
  const cart = await fixture.commerce.addProduct('full-mint', false, undefined, 'gid://variant/mi26-right');
  const result = await checkout(await tab(fixture), cart);
  assert.equal(result.navigations, 1);
  assert.equal(count(fixture, 'cartAttributesUpdate'), 1);
  assert.equal(blocking(fixture.storage).length, 1, 'only the checkout freeze');
  assert.deepEqual(blocking(fixture.storage)[0].kinds, ['checkout handoff']);
});

for (const body of [true, false]) {
  test(`1: a recovery create saved then answered HTTP 422 (${body ? 'with body' : 'no body'}) keeps the source frozen; a known candidate continues once`, async () => {
    const { fixture, cart, freeze } = await frozenServiced();
    fixture.faultAfterSave({ status: 422, body });
    await assert.rejects((await tab(fixture)).recoverCart(), error => error.code === 'uncertain');
    assert.equal(fixture.storage.getItem(ACTIVE), cart.id);
    for (const [key, raw] of Object.entries(freeze)) assert.equal(fixture.storage.getItem(key), raw, 'freeze bytes kept');
    const [attempt] = ops(fixture.storage).filter(record => record.kind === 'recovery');
    const candidate = Object.keys(fixture.savedCarts()).find(id => id !== cart.id);
    assert.equal(fixture.cartLines(candidate).length, 1, 'Shopify saved the parent-only candidate');
    assert.equal(attempt.recovery.candidateCartId, body ? candidate : undefined);
    const creates = count(fixture, 'cartCreate');
    const resumed = await (await tab(fixture)).recoverCart().catch(error => ({ error }));
    assert.equal(count(fixture, 'cartCreate'), creates, 'the create is never replayed');
    if (body) {
      assert.equal(resumed.id, candidate);
      assert.equal(count(fixture, 'cartLinesAdd'), 1);
      const parent = glove(resumed);
      assert.equal(service(resumed, parent).quantity, parent.quantity);
    } else {
      assert.equal(resumed.error.code, 'recovery-unconfirmed');
      assert.equal(count(fixture, 'cartLinesAdd'), 0);
      assert.equal(fixture.storage.getItem(ACTIVE), cart.id);
    }
  });
}

for (const body of [true, false]) {
  test(`1: a saved recovery attachment answered HTTP 422 (${body ? 'with body' : 'no body'}) is never replayed`, async () => {
    const { fixture, cart } = await frozenServiced();
    fixture.faultAfterSave({ offset: 2, status: 422, body });
    await assert.rejects((await tab(fixture)).recoverCart(), error => error.code === 'uncertain');
    assert.equal(fixture.storage.getItem(ACTIVE), cart.id);
    const [attempt] = blocking(fixture.storage).filter(record => record.kind === 'recovery');
    assert.ok(attempt);
    assert.equal(attempt.recovery.stage, 'children');
    const saved = fixture.cartLines(attempt.recovery.candidateCartId);
    assert.equal(saved.length, 2);
    const child = saved.find(line => line.parentRelationship);
    const parent = saved.find(line => !line.parentRelationship);
    assert.equal(child.parentRelationship.parent.id, parent.id);
    assert.equal(child.quantity, parent.quantity);
    const attachments = count(fixture, 'cartLinesAdd');
    const sent = allMutations(fixture);
    const reloaded = await tab(fixture);
    const journal = rawOps(fixture.storage);
    assert.equal((await checkout(reloaded, cart)).navigations, 0);
    assert.deepEqual(rawOps(fixture.storage), journal, 'the unresolved attachment survives reload');
    const adopted = await reloaded.recoverCart();
    assert.equal(count(fixture, 'cartLinesAdd'), attachments);
    assert.equal(allMutations(fixture), sent);
    assert.equal(adopted.id, attempt.recovery.candidateCartId);
    assert.notEqual(adopted.id, cart.id);
    assert.equal(service(adopted, glove(adopted)).quantity, 1);
  });
}

// ---- Row 2 (2G finding 2): evidence survives error formatting ----

const createEnvelopes = {
  'errors: [{ message: { toString: null } }]': envelope => ({ ...envelope, errors: [{ message: { toString: null } }] }),
  'a malformed errors object': envelope => ({ ...envelope, errors: { message: 'malformed' } }),
  'conventional GraphQL errors beside partial data': envelope => ({ data: { cartCreate: { cart: { id: envelope.data.cartCreate.cart.id } } }, errors: [{ message: 'Internal' }] }),
  'malformed userErrors': envelope => ({ data: { cartCreate: { ...envelope.data.cartCreate, userErrors: [{ message: 42 }] } } }),
  'valid userErrors beside the cart': envelope => ({ data: { cartCreate: { ...envelope.data.cartCreate, userErrors: [{ message: 'Partial' }] } } })
};
for (const [label, rewrite] of Object.entries(createEnvelopes)) {
  test(`2: a first create answered with ${label} keeps the usable ID durably; explicit reconciliation adopts it with one create`, async () => {
    const fixture = shopifyFixture();
    await fixture.commerce.listProducts();
    const shopper = await rewriting(fixture, (request, envelope) => request.query.startsWith(FIELDS.cartCreate) ? rewrite(envelope) : envelope);
    await assert.rejects(shopper.addProduct('black', false), error => error.code === 'uncertain-create');
    const [owner] = blocking(fixture.storage);
    assert.equal(owner.candidateCartId, fixture.mainId);
    assert.equal(fixture.storage.getItem(ACTIVE), null);
    for (const commerce of [shopper, await tab(fixture)]) {
      await assert.rejects(commerce.addProduct('black', false), error => error.code === 'create-unresolved');
      await assert.rejects(commerce.startNewCart({ abandonUnknown: true, binding: (await commerce.getCart()).abandonmentBinding }), error => error.code === 'create-reconcile-required');
    }
    const adopted = await (await tab(fixture)).reconcileUnconfirmedCart();
    assert.equal(adopted.id, fixture.mainId);
    assert.equal(count(fixture, 'cartCreate'), 1);
    assert.deepEqual(blocking(fixture.storage), []);
  });
}

const idlessEnvelopes = {
  'null data': () => ({ data: null, errors: [{ message: 'x' }] }),
  'array data': () => ({ data: [] }),
  'missing data': () => ({ errors: [] }),
  'a clean null cart with userErrors': () => ({ data: { cartCreate: { cart: null, userErrors: [{ message: 'Merchandise unavailable' }] } } })
};
for (const [label, rewrite] of Object.entries(idlessEnvelopes)) {
  test(`2: a first create answered with ${label} stays armed; only affirmative abandonment moves on, with no mutation itself`, async () => {
    const fixture = shopifyFixture();
    await fixture.commerce.listProducts();
    const shopper = await rewriting(fixture, (request, envelope) => request.query.startsWith(FIELDS.cartCreate) ? rewrite(envelope) : envelope);
    await assert.rejects(shopper.addProduct('black', false), error => error.code === 'uncertain-create');
    const [owner] = blocking(fixture.storage);
    assert.equal(owner.cartId, '*');
    assert.equal(owner.candidateCartId, undefined);
    const reloaded = await tab(fixture);
    const shown = await reloaded.getCart();
    assert.equal(shown.unconfirmedCreate, true);
    await assert.rejects(reloaded.addProduct('black', false), error => error.code === 'create-unresolved');
    await assert.rejects(reloaded.startNewCart(), error => error.code === 'create-unresolved', 'abandonment must be affirmative');
    const mutations = allMutations(fixture);
    const fresh = await reloaded.startNewCart({ abandonUnknown: true, binding: shown.abandonmentBinding });
    assert.equal(allMutations(fixture), mutations, 'the abandonment sends nothing');
    assert.equal(fresh.unconfirmedCreate, undefined);
    const [terminal] = ops(fixture.storage);
    assert.equal(terminal.status, 'terminal');
    assert.equal(terminal.resolution, 'abandoned');
    assert.equal((await reloaded.addProduct('blue', false)).lines.length, 1);
  });
}

test('2: the drawer discloses that an unconfirmed cart may already exist and offers only an explicit Start a new cart', () => {
  const html = cartFeedbackMarkup({ mode: 'shopify', unconfirmedCreate: true }, value => value);
  assert.match(html, /may already/i);
  assert.match(html, /data-start-new-cart/);
  assert.doesNotMatch(html, /data-checkout/);
});

test('2: recovery create evidence survives the same formatter faults', async () => {
  for (const rewrite of Object.values(createEnvelopes)) {
    const { fixture, cart } = await frozenServiced();
    const recovering = await rewriting(fixture, (request, envelope) => request.query.startsWith(FIELDS.cartCreate) ? rewrite(envelope) : envelope);
    await assert.rejects(recovering.recoverCart(), error => error.code === 'uncertain');
    const [attempt] = ops(fixture.storage).filter(record => record.kind === 'recovery');
    assert.equal(typeof attempt.recovery.candidateCartId, 'string');
    assert.equal(fixture.storage.getItem(ACTIVE), cart.id);
    assert.equal(count(fixture, 'cartLinesAdd'), 0, 'nothing attached to an unverified create');
  }
});

test('2 positive: a clean first create publishes after verification; a valid empty candidate is adopted by reconciliation', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  const cart = await fixture.commerce.addProduct('black', false);
  assert.equal(fixture.storage.getItem(ACTIVE), cart.id);
  const empty = shopifyFixture();
  await empty.commerce.listProducts();
  const shopper = await intercepted(empty, async (request, forward, options) => {
    if (!request.query.startsWith(FIELDS.cartCreate)) return forward();
    const body = JSON.parse(options.body); body.variables.input.lines = [];
    const saved = await empty.fetchImpl('https://store.myshopify.com/api/2026-07/graphql.json', { ...options, body: JSON.stringify(body) });
    const envelope = await saved.json();
    envelope.data.cartCreate.userErrors = [{ message: 'Merchandise unavailable' }];
    return answer(envelope);
  });
  await assert.rejects(shopper.addProduct('black', false), error => error.code === 'uncertain-create');
  const adopted = await (await tab(empty)).reconcileUnconfirmedCart();
  assert.equal(adopted.id, empty.mainId);
  assert.deepEqual(adopted.lines, []);
  assert.equal(count(empty, 'cartCreate'), 1);
});

// ---- Row 3 (2G finding 3): raw integrity and opaque IDs ----

const longId = n => `gid://shopify/Cart/hWN8vJv5sY3LtBqR2cXk7mZ1${'a'.repeat(600)}${n}?key=6f1e2d3c4b5a69788796a5b4c3d2e1f0&region=us`;
test('3: cart IDs are opaque production GIDs with a key; other forms are never trusted', () => {
  assert.equal(trustedCartId(longId(1)), longId(1), 'long native ID kept byte for byte');
  for (const bad of ['gid://shopify/ProductVariant/123', 'gid://shopify/Cart/?key=k', 'gid://shopify/Cart/c1?key=', 'gid://shopify/Cart/c1',
    'gid://shopify/Cart/c1?key=k#frag', 'gid://shopify/Cart/c 1?key=k', 'gid://shopify/Cart/c1?key=k\\x', 'gid://cart/1', 42, null]) {
    assert.equal(trustedCartId(bad), null, String(bad));
  }
});

test('3 positive: a long opaque ID, a multi-page cart, both hands and services stay valid; a price change reviews once then navigates once', async () => {
  const cartPrices = {};
  const fixture = shopifyFixture({ fullSize: true, pageSize: 2, cartIdFor: longId, cartPrices });
  await fixture.commerce.listProducts();
  await fixture.commerce.addProduct('full-mint', true, fullSizeOptions, 'gid://variant/mi26-right');
  await fixture.commerce.addProduct('full-mint', false, undefined, 'gid://variant/mi26-left');
  await fixture.commerce.addProduct('black', true);
  const shown = await fixture.commerce.addProduct('blue', false);
  assert.equal(shown.id, longId(1));
  assert.equal(fixture.storage.getItem(ACTIVE), longId(1));
  assert.equal(shown.lines.length, 6);
  assert.equal(shown.incomplete, false);
  cartPrices.ob16 = '165.00';
  const first = await checkout(await tab(fixture), shown);
  assert.equal(first.status, 'review');
  assert.equal(first.navigations, 0);
  const second = await checkout(await tab(fixture), first.cart);
  assert.equal(second.navigations, 1);
});

const readFaults = {
  'hexadecimal money': cart => { cart.cost.subtotalAmount.amount = '0x9b'; },
  'blank money': cart => { cart.lines.nodes[0].cost.totalAmount.amount = ''; },
  'whitespace money': cart => { cart.cost.subtotalAmount.amount = ' 155.00'; },
  'exponent money': cart => { cart.lines.nodes[0].cost.amountPerQuantity.amount = '1.55e2'; },
  'numeric JSON money': cart => { cart.cost.subtotalAmount.amount = 155; },
  'negative money': cart => { cart.lines.nodes[0].cost.subtotalAmount.amount = '-155.00'; },
  'overflowing money': cart => { cart.cost.subtotalAmount.amount = `1${'0'.repeat(400)}`; },
  'nonzero money that underflows': cart => { cart.lines.nodes[0].cost.totalAmount.amount = `0.${'0'.repeat(400)}1`; },
  'a trailing-dot decimal': cart => { cart.cost.subtotalAmount.amount = '155.'; },
  'an unknown currency': cart => { cart.cost.subtotalAmount.currencyCode = 'ZZZ'; for (const line of cart.lines.nodes) for (const money of Object.values(line.cost)) money.currencyCode = 'ZZZ'; },
  'XXX currency': cart => { cart.cost.subtotalAmount.currencyCode = 'XXX'; for (const line of cart.lines.nodes) for (const money of Object.values(line.cost)) money.currencyCode = 'XXX'; },
  'mixed currency': cart => { cart.lines.nodes[0].cost.subtotalAmount.currencyCode = 'CAD'; },
  'an empty line ID': cart => { cart.lines.nodes[0].id = ''; },
  'a duplicate line ID': cart => { cart.lines.nodes[1].id = cart.lines.nodes[0].id; },
  'a hostile checkout URL': cart => { cart.checkoutUrl = 'https://evil.example/cart/c/1'; },
  'a userinfo checkout URL': cart => { cart.checkoutUrl = 'https://ignvv0-zh.myshopify.com@evil.example/cart'; },
  'another cart ID': cart => { cart.id = cart.id.split('?')[0]; },
  'a variant outside the catalog': cart => { cart.lines.nodes[0].merchandise.id = 'gid://variant/unknown'; },
  'a merchandise handle outside the catalog': cart => { cart.lines.nodes[0].merchandise.product.handle = 'unknown'; },
  'a malformed discount code': cart => { cart.discountCodes = [{ code: 7, applicable: true }]; },
  'duplicate discount codes': cart => { cart.discountCodes = [{ code: 'A', applicable: true }, { code: 'a', applicable: false }]; },
  'missing discount codes': cart => { delete cart.discountCodes; },
  'an unknown discount application type': cart => { cart.discountApplications = [{ __typename: 'Mystery', targetType: 'LINE_ITEM', value: { __typename: 'PricingPercentageValue', percentage: 10 } }]; },
  'an out-of-range percentage': cart => { cart.discountCodes = [{ code: 'A', applicable: true }]; cart.discountApplications = [{ __typename: 'CartCodeDiscountApplication', code: 'A', targetType: 'LINE_ITEM', value: { __typename: 'PricingPercentageValue', percentage: 150 } }]; },
  'a code application without a returned code': cart => { cart.discountApplications = [{ __typename: 'CartCodeDiscountApplication', code: 'NOPE', targetType: 'LINE_ITEM', value: { __typename: 'PricingPercentageValue', percentage: 10 } }]; },
  'a malformed allocation': cart => { cart.lines.nodes[0].allDiscountAllocations = [{ __typename: 'CartCodeDiscountAllocation', code: 'NOPE', targetType: 'LINE_ITEM', discountedAmount: { amount: '1.00', currencyCode: 'USD' } }]; },
  'a missing hasNextPage': cart => { delete cart.lines.pageInfo.hasNextPage; },
  'a next page without a cursor': cart => { cart.lines.pageInfo = { hasNextPage: true, endCursor: null }; },
  'duplicate attribute keys': cart => { cart.lines.nodes[0].attributes = [...cart.lines.nodes[0].attributes, cart.lines.nodes[0].attributes[0]]; },
  'a numeric quantity string': cart => { cart.lines.nodes[0].quantity = '1'; }
};
for (const [label, fault] of Object.entries(readFaults)) {
  test(`3 negative: a cart read with ${label} never reviews, freezes, navigates, recovers or mutates (4 attempts, reload)`, async () => {
    const fixture = shopifyFixture();
    await fixture.commerce.listProducts();
    await fixture.commerce.addProduct('black', true);
    const shown = await fixture.commerce.addProduct('blue', false);
    const before = everything(fixture.storage);
    const sent = allMutations(fixture);
    const make = () => rewriting(fixture, (request, envelope) => { if (isCartRead(request.query) && envelope.data?.cart) fault(envelope.data.cart); });
    const outcome = await repeatedCheckout(fixture, make, shown);
    assert.equal(outcome.navigations, 0);
    assert.ok(!outcome.statuses.includes('review') && !outcome.statuses.includes('navigating'), outcome.statuses.join());
    const corrupt = await make();
    await assert.rejects(corrupt.addProduct('brown', false));
    await assert.rejects(corrupt.applyDiscountCode('SAVE'));
    await corrupt.recoverCart().catch(() => null);
    assert.equal(allMutations(fixture), sent, 'no invalid read authorizes a mutation');
    assert.deepEqual(everything(fixture.storage), before, 'no freeze, record or pointer change');
  });
}

const pageFaults = {
  'a repeated cursor': (cart, request) => { if (request.variables.after) cart.lines.pageInfo.endCursor = request.variables.after; },
  'a line ID repeated across pages': (cart, request) => { if (request.variables.after) cart.lines.nodes[0].id = 'line-1'; },
  'cart attributes that drift between pages': (cart, request) => { if (request.variables.after) cart.attributes = [{ key: 'drift', value: '1' }]; },
  'an empty page that claims more': (cart, request) => { if (request.variables.after) { cart.lines.nodes = []; cart.lines.pageInfo = { hasNextPage: true, endCursor: 'cursor:99' }; } }
};
for (const [label, fault] of Object.entries(pageFaults)) {
  test(`3 negative: a paginated read with ${label} fails closed`, async () => {
    const fixture = shopifyFixture({ pageSize: 1 });
    await fixture.commerce.listProducts();
    await fixture.commerce.addProduct('black', false);
    await fixture.commerce.addProduct('blue', false);
    const shown = await fixture.commerce.addProduct('brown', false);
    const sent = allMutations(fixture);
    const make = () => rewriting(fixture, (request, envelope) => { if (isCartRead(request.query) && envelope.data?.cart) fault(envelope.data.cart, request); });
    assert.equal((await repeatedCheckout(fixture, make, shown)).navigations, 0);
    await assert.rejects((await make()).addProduct('black', false));
    assert.equal(allMutations(fixture), sent);
  });
}

test('3 negative: hand, model, parent and service contradictions never reach checkout', async () => {
  const faults = {
    'a glove-line hand attribute': cart => { const node = cart.lines.nodes.find(line => !line.parentRelationship); node.attributes = [...node.attributes, { key: 'Throwing Hand', value: 'Left' }]; },
    'a contradicting selected option': cart => { cart.lines.nodes.find(line => !line.parentRelationship).merchandise.selectedOptions = [{ name: 'Throwing Hand', value: 'Left' }]; },
    'a service naming another model': cart => { const child = cart.lines.nodes.find(line => line.parentRelationship); child.attributes = child.attributes.map(item => item.key === 'Glove Model' ? { ...item, value: 'BL50' } : item); },
    'a service linked to a missing parent': cart => { cart.lines.nodes.find(line => line.parentRelationship).parentRelationship.parent.id = 'line-404'; },
    'a service whose parent merchandise differs': cart => { cart.lines.nodes.find(line => line.parentRelationship).parentRelationship.parent.merchandise.id = 'gid://variant/mi26-left'; },
    'a glove nested under another line': cart => { const [first] = cart.lines.nodes; cart.lines.nodes.push({ ...structuredClone(first), id: 'line-nested', parentRelationship: { parent: { id: first.id, merchandise: first.merchandise } } }); },
    'a second service on one glove': cart => { const child = cart.lines.nodes.find(line => line.parentRelationship); cart.lines.nodes.push({ ...structuredClone(child), id: 'line-extra' }); }
  };
  for (const [label, fault] of Object.entries(faults)) {
    const fixture = shopifyFixture({ fullSize: true });
    await fixture.commerce.listProducts();
    const shown = await fixture.commerce.addProduct('full-mint', true, fullSizeOptions, 'gid://variant/mi26-right');
    const make = () => rewriting(fixture, (request, envelope) => { if (isCartRead(request.query) && envelope.data?.cart) fault(envelope.data.cart); });
    const outcome = await repeatedCheckout(fixture, make, shown);
    assert.equal(outcome.navigations, 0, label);
    assert.ok(!outcome.statuses.includes('review'), label);
    assert.equal(blocking(fixture.storage).length, 0, label);
  }
});

test('3 positive: honest trainer, serviced trainer, both full-size hands and the CM24 right-only glove still check out', async () => {
  for (const [productId, breakIn, merchandiseId] of [['black', false, null], ['brown', true, null], ['full-mint', true, 'gid://variant/mi26-right'],
    ['full-mint', false, 'gid://variant/mi26-left'], ['full-camel', false, 'gid://variant/cm24-right']]) {
    const fixture = shopifyFixture({ fullSize: true });
    await fixture.commerce.listProducts();
    const cart = await fixture.commerce.addProduct(productId, breakIn, productId.startsWith('full-') ? fullSizeOptions : undefined, merchandiseId);
    assert.equal((await checkout(await tab(fixture), cart)).navigations, 1, `${productId} ${merchandiseId}`);
  }
});

// ---- Row 4 (2G finding 4): pure reads and scoped cleanup ----

const foreignPrepared = { [`${UNSAFE_RECORD_PREFIX}foreign-pending`]: JSON.stringify({ cartId: 'gid://shopify/Cart/cforeign?key=kforeign', kind: 'recovery',
  dispatched: false, status: 'pending', recovery: { supersededRecords: [{ key: `${UNSAFE_RECORD_PREFIX}old`, value: '{"recovery":{"candidateCartId":"gid://shopify/Cart/cknown?key=kknown"}}' }] } }),
  'anawin-shopify-pending-mutation': JSON.stringify({ cartId: 'gid://shopify/Cart/clegacy?key=klegacy', kind: 'cart change' }) };
const seed = (storage, entries) => { for (const [key, value] of Object.entries(entries)) storage.setItem(key, value); };
for (const state of ['valid', 'explicitly missing', 'service-unreadable']) {
  test(`4: every observation of a ${state} cart writes nothing; foreign and legacy records keep their bytes`, async () => {
    const { fixture, cart } = await serviced();
    seed(fixture.storage, foreignPrepared);
    if (state === 'explicitly missing') fixture.expireCart();
    if (state === 'service-unreadable') {
      fixture.lines.find(line => !line.parentRelationship).attributes = [{ key: '_anawin_service', value: 'break-in' }];
      fixture.lines.find(line => line.parentRelationship).attributes = [];
    }
    const before = everything(fixture.storage);
    const reader = await tab(fixture);
    const views = [];
    for (const read of ['getCart', 'peekCart', 'refreshCart']) views.push(await reader[read]());
    // Startup restore and the storage-event path.
    views.push(await (await tab(fixture)).getCart());
    reader.readCartSafety();
    assert.deepEqual(everything(fixture.storage), before);
    assert.equal(fixture.storage.getItem(ACTIVE), cart.id, 'a pure read never clears the active pointer');
    if (state === 'service-unreadable') assert.ok(views.every(view => view.incomplete && view.gloveOnlyRecoveryAvailable));
    if (state === 'explicitly missing') assert.ok(views.filter(Boolean).every(view => view.lines.length === 0));
  });
}

test('4: a legitimate write, checkout and recovery leave foreign records byte-identical; a same-key swap before cleanup is preserved', async () => {
  const { fixture, cart } = await serviced();
  seed(fixture.storage, foreignPrepared);
  const foreign = () => Object.fromEntries(Object.keys(foreignPrepared).map(key => [key, fixture.storage.getItem(key)]));
  const expected = foreign();
  await fixture.commerce.addProduct('blue', false);
  assert.deepEqual(foreign(), expected);
  // A participant record swapped under its own key after its dispatch: cleanup leaves the swapped value alone.
  let swapped = null;
  fixture.observeMutations(({ storage }) => {
    const [key] = Object.keys(rawOps(storage)).filter(key => !Object.hasOwn(foreignPrepared, key));
    if (!key) return;
    swapped = { key, value: JSON.stringify({ cartId: cart.id, kind: 'someone else', kinds: ['cart change'], status: 'unresolved' }) };
    storage.setItem(swapped.key, swapped.value);
  });
  // The verified write may still return; its cleanup refuses to touch a record whose bytes it does not own.
  await fixture.commerce.addProduct('brown', false).catch(() => null);
  fixture.observeMutations(null);
  assert.equal(fixture.storage.getItem(swapped.key), swapped.value, 'the swapped value is never removed or overwritten');
  assert.deepEqual(foreign(), expected);
});

// ---- Row 5 (2G finding 5): a late conflicting journal at adoption ----

const lateJournals = {
  'a wildcard candidate': () => JSON.stringify({ cartId: '*', kind: 'addProduct', status: 'unresolved', dispatched: true, candidateCartId: 'gid://shopify/Cart/cforeign?key=kforeign' }),
  'a source conflict': source => JSON.stringify({ v: 2, owner: 'late', cartId: source, kind: 'addProduct', kinds: ['addition'], status: 'armed', dispatched: true }),
  'a malformed journal': () => '{not json'
};
for (const [label, make] of Object.entries(lateJournals)) {
  for (const during of ['final source read', 'final candidate read']) {
    test(`5: ${label} injected during the ${during} stops adoption; nothing is lost or replayed`, async () => {
      const { fixture, cart, freeze } = await frozenServiced();
      const lateKey = `${UNSAFE_RECORD_PREFIX}late`;
      const lateRaw = make(cart.id);
      fixture.observeQueries(({ variables, storage }) => {
        if (count(fixture, 'cartLinesAdd') === 0) return;
        if ((during === 'final source read') === (variables.id === cart.id)) storage.setItem(lateKey, lateRaw);
      });
      await assert.rejects((await tab(fixture)).recoverCart());
      fixture.observeQueries(null);
      assert.equal(fixture.storage.getItem(ACTIVE), cart.id, 'the original pointer remains');
      for (const [key, raw] of Object.entries(freeze)) assert.equal(fixture.storage.getItem(key), raw);
      assert.equal(fixture.storage.getItem(lateKey), lateRaw, 'the late record survives');
      const candidate = Object.keys(fixture.savedCarts()).find(id => id !== cart.id);
      assert.ok(namesId(fixture.storage, candidate), 'the candidate stays discoverable');
      const sent = allMutations(fixture);
      await (await tab(fixture)).recoverCart().catch(() => null);
      assert.equal(allMutations(fixture), sent, 'retry sends no duplicate create or attachment');
      assert.equal(fixture.storage.getItem(ACTIVE), cart.id);
    });
  }
}

test('5: an authorized record replaced or deleted under the same key before adoption stops it', async () => {
  for (const change of ['replace', 'delete']) {
    const { fixture, cart, freeze } = await frozenServiced();
    const [freezeKey] = Object.keys(freeze);
    fixture.observeQueries(({ variables, storage }) => {
      if (count(fixture, 'cartLinesAdd') === 0 || variables.id !== cart.id) return;
      if (change === 'replace') storage.setItem(freezeKey, JSON.stringify({ ...JSON.parse(freeze[freezeKey]), owner: 'someone-else' }));
      else storage.removeItem(freezeKey);
    });
    await assert.rejects((await tab(fixture)).recoverCart());
    fixture.observeQueries(null);
    assert.equal(fixture.storage.getItem(ACTIVE), cart.id, change);
  }
});

test('5 positive: exact source and recovery records adopt the matching candidate after one attachment', async () => {
  const { fixture, cart } = await frozenServiced();
  const adopted = await (await tab(fixture)).recoverCart();
  assert.notEqual(adopted.id, cart.id);
  assert.equal(fixture.storage.getItem(ACTIVE), adopted.id);
  assert.equal(count(fixture, 'cartLinesAdd'), 1);
  assert.equal(service(adopted, glove(adopted)).quantity, 1);
  assert.deepEqual(blocking(fixture.storage), [], 'only the authorized participants are resolved');
});

async function strandedCandidate(intentMerchandise = 'gid://variant/br16') {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  const cart = await fixture.commerce.addProduct('black', false);
  fixture.storage.removeItem(ACTIVE);
  fixture.storage.setItem(`${UNSAFE_RECORD_PREFIX}closed-tab`, JSON.stringify({ cartId: '*', candidateCartId: cart.id, kind: 'addProduct',
    kinds: ['addition'], status: 'pending', createdAt: 1, dispatched: true,
    createIntent: [{ merchandiseId: intentMerchandise, quantity: 1, attributes: glove(cart).attributes, parentMerchandiseId: null }] }));
  return { fixture, cart };
}
test('5: a late journal during first-create reconciliation or mismatch consent stops the transition', async () => {
  for (const flow of ['reconcile', 'keep']) {
    const { fixture, cart } = await strandedCandidate(flow === 'keep' ? 'gid://variant/ob16' : 'gid://variant/br16');
    let shown = null;
    if (flow === 'keep') { await (await tab(fixture)).reconcileUnconfirmedCart(); shown = await (await tab(fixture)).getCart(); }
    const lateKey = `${UNSAFE_RECORD_PREFIX}late`;
    const before = everything(fixture.storage);
    fixture.observeQueries(({ storage }) => storage.setItem(lateKey, lateJournals['a wildcard candidate']()));
    await assert.rejects(flow === 'keep' ? (await tab(fixture)).keepUnconfirmedCart(shown) : (await tab(fixture)).reconcileUnconfirmedCart());
    fixture.observeQueries(null);
    const after = everything(fixture.storage);
    delete after[lateKey];
    assert.deepEqual(after, before, flow);
    assert.ok(namesId(fixture.storage, cart.id));
  }
});

// ---- Row 6: candidate persistence and reload ----

test('6 positive: a thrown or dropped pointer write after a durable candidate is reconciled with the same ID and one create', async () => {
  for (const failure of ['throw', 'drop']) {
    const fixture = shopifyFixture();
    await fixture.commerce.listProducts();
    const setItem = fixture.storage.setItem.bind(fixture.storage);
    fixture.storage.setItem = (key, value) => {
      if (key === ACTIVE) { if (failure === 'throw') throw new DOMException('refused', 'QuotaExceededError'); return; }
      return setItem(key, value);
    };
    await assert.rejects(fixture.commerce.addProduct('black', false));
    fixture.storage.setItem = setItem;
    assert.equal(blocking(fixture.storage)[0].candidateCartId, fixture.mainId);
    const reloaded = await tab(fixture);
    await assert.rejects(reloaded.addProduct('black', false), error => error.code === 'create-unresolved');
    const adopted = await reloaded.reconcileUnconfirmedCart();
    assert.equal(adopted.id, fixture.mainId, failure);
    assert.equal(count(fixture, 'cartCreate'), 1);
  }
});

for (const failure of ['throws', 'is silently dropped', 'fails its readback']) {
  for (const path of ['first create', 'recovery create']) {
    test(`6 negative: a ${path} candidate write that ${failure} after commit leaves only the armed record; nothing creates, attaches, publishes or navigates`, async () => {
      const setup = path === 'first create' ? null : await frozenServiced();
      const fixture = setup?.fixture || shopifyFixture();
      if (!setup) await fixture.commerce.listProducts();
      const { setItem, getItem } = { setItem: fixture.storage.setItem.bind(fixture.storage), getItem: fixture.storage.getItem.bind(fixture.storage) };
      let committed = false;
      fixture.observeMutations(({ field }) => { if (field === 'cartCreate') committed = true; });
      const candidateWrite = (key, value) => committed && key.startsWith(UNSAFE_RECORD_PREFIX) && /candidateCartId|candidateCartIds/.test(String(value));
      let refused = null;
      fixture.storage.setItem = (key, value) => {
        if (candidateWrite(key, value)) {
          if (failure === 'throws') throw new DOMException('refused', 'QuotaExceededError');
          if (failure === 'is silently dropped') return;
          if (!refused) refused = { key, armed: getItem(key) };
        }
        return setItem(key, value);
      };
      fixture.storage.getItem = key => refused?.key === key ? 'not what was written' : getItem(key);
      const shopper = await tab(fixture);
      await assert.rejects(path === 'first create' ? shopper.addProduct('black', false) : shopper.recoverCart());
      fixture.storage.setItem = setItem; fixture.storage.getItem = getItem;
      fixture.observeMutations(null);
      // A readback that failed proves nothing landed: reload with only the last verified (armed) record.
      if (refused) fixture.storage.setItem(refused.key, refused.armed);
      const sent = allMutations(fixture);
      const reloaded = await tab(fixture);
      const shown = await reloaded.getCart().catch(() => null);
      if (path === 'first create') {
        assert.equal(shown.unconfirmedCreate, true, 'the drawer says a cart may already exist');
        await assert.rejects(reloaded.addProduct('black', false));
      } else {
        await reloaded.recoverCart().catch(() => null);
      }
      for (let click = 0; click < 3; click++) assert.equal((await checkout(await tab(fixture), shown || setup?.cart || {})).navigations, 0);
      assert.equal(allMutations(fixture), sent, 'no create, attachment or other mutation');
      if (path === 'recovery create') assert.equal(fixture.storage.getItem(ACTIVE), setup.cart.id);
      else {
        assert.equal(fixture.storage.getItem(ACTIVE), null);
        const abandoned = await reloaded.startNewCart({ abandonUnknown: true, binding: shown.abandonmentBinding }).catch(error => ({ error }));
        assert.equal(allMutations(fixture), sent, 'abandonment itself sends nothing');
        if (!abandoned.error) assert.ok(ops(fixture.storage).some(record => record.resolution === 'abandoned'));
      }
    });
  }
}

// ---- Row 7: journal and revision storage failures ----

const preArmFailures = {
  'a prepare write that throws': storage => { const setItem = storage.setItem.bind(storage); storage.setItem = (key, value) => { if (key.startsWith(UNSAFE_RECORD_PREFIX)) throw new DOMException('refused', 'QuotaExceededError'); return setItem(key, value); }; },
  'a prepare write that is dropped': storage => { const setItem = storage.setItem.bind(storage); storage.setItem = (key, value) => key.startsWith(UNSAFE_RECORD_PREFIX) ? undefined : setItem(key, value); },
  'an enumeration that throws': storage => { Object.defineProperty(storage, 'length', { get() { throw new DOMException('refused', 'SecurityError'); }, configurable: true }); },
  'a revision notice that fails': storage => { const setItem = storage.setItem.bind(storage); storage.setItem = (key, value) => { if (key === 'anawin-shopify-cart-revision') throw new DOMException('refused', 'QuotaExceededError'); return setItem(key, value); }; },
  'an arm write that throws after the prepare': storage => { const setItem = storage.setItem.bind(storage); let writes = 0; storage.setItem = (key, value) => { if (key.startsWith(UNSAFE_RECORD_PREFIX) && ++writes === 2) throw new DOMException('refused', 'QuotaExceededError'); return setItem(key, value); }; }
};
for (const [label, inject] of Object.entries(preArmFailures)) {
  test(`7: ${label} sends zero mutations, for a first cart and an existing one`, async () => {
    for (const existing of [false, true]) {
      const fixture = shopifyFixture();
      await fixture.commerce.listProducts();
      if (existing) await fixture.commerce.addProduct('black', false);
      const sent = allMutations(fixture);
      inject(fixture.storage);
      await assert.rejects(fixture.commerce.addProduct('blue', false), error => ['storage-unavailable', 'cart-changed'].includes(error.code));
      assert.equal(allMutations(fixture), sent, `${label} ${existing}`);
    }
  });
}

test('7: a failed retirement after a verified write keeps a non-gating terminal record; later work proceeds', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  const removeItem = fixture.storage.removeItem.bind(fixture.storage);
  fixture.storage.removeItem = key => { if (key.startsWith(UNSAFE_RECORD_PREFIX)) throw new DOMException('refused', 'SecurityError'); return removeItem(key); };
  const cart = await fixture.commerce.addProduct('black', false);
  fixture.storage.removeItem = removeItem;
  assert.deepEqual(blocking(fixture.storage), []);
  assert.equal(ops(fixture.storage)[0].status, 'terminal');
  assert.equal((await (await tab(fixture)).addProduct('blue', false)).id, cart.id);
});

test('7: a recovery whose pointer publication fails keeps the candidate gated across reload until explicitly reconciled', async () => {
  const { fixture, cart } = await frozenServiced();
  const setItem = fixture.storage.setItem.bind(fixture.storage);
  fixture.storage.setItem = (key, value) => { if (key === ACTIVE) throw new DOMException('refused', 'QuotaExceededError'); return setItem(key, value); };
  await assert.rejects((await tab(fixture)).recoverCart());
  fixture.storage.setItem = setItem;
  assert.equal(fixture.storage.getItem(ACTIVE), cart.id);
  const adopting = ops(fixture.storage).find(record => record.status === 'adopting');
  assert.ok(adopting, 'an adopting record gates the candidate');
  const sent = allMutations(fixture);
  const finished = await (await tab(fixture)).recoverCart();
  assert.equal(allMutations(fixture), sent, 'completion is reads only');
  assert.equal(finished.id, adopting.recovery.candidateCartId);
});

// ---- Row 8: recovery supersession and no replay ----

async function interruptedAttempt() {
  const { fixture, cart } = await frozenServiced();
  fixture.failAfterNextMutation(2);
  await assert.rejects((await tab(fixture)).recoverCart(), error => error.code === 'uncertain');
  const [known] = ops(fixture.storage).filter(record => record.kind === 'recovery');
  return { fixture, cart, known };
}
test('8: a failed successor setup leaves the earlier attempt byte-identical and sends nothing', async () => {
  const { fixture, known } = await interruptedAttempt();
  const before = rawOps(fixture.storage);
  const sent = allMutations(fixture);
  const setItem = fixture.storage.setItem.bind(fixture.storage);
  fixture.storage.setItem = (key, value) => { if (key.startsWith(UNSAFE_RECORD_PREFIX) && !Object.hasOwn(before, key)) throw new DOMException('refused', 'QuotaExceededError'); return setItem(key, value); };
  const shopper = await tab(fixture);
  const shown = await shopper.getCart();
  await assert.rejects(shopper.recoverCart({ abandonUnconfirmed: true, binding: shown.recoveryBinding }));
  fixture.storage.setItem = setItem;
  assert.deepEqual(rawOps(fixture.storage), before);
  assert.equal(allMutations(fixture), sent);
  assert.ok(namesId(fixture.storage, known.recovery.candidateCartId));
});

test('8: a successor saved then answered HTTP 422 keeps both known candidates discoverable and blocked; nothing is replayed', async () => {
  const { fixture, cart, known } = await interruptedAttempt();
  const before = rawOps(fixture.storage);
  const shopper = await tab(fixture);
  const shown = await shopper.getCart();
  assert.ok(shown.recoveryBinding);
  fixture.faultAfterSave({ status: 422, body: true });
  await assert.rejects(shopper.recoverCart({ abandonUnconfirmed: true, binding: shown.recoveryBinding }));
  for (const [key, raw] of Object.entries(before)) assert.equal(fixture.storage.getItem(key), raw, 'earlier bytes intact');
  const successorCandidate = Object.keys(fixture.savedCarts()).filter(id => id !== cart.id && id !== known.recovery.candidateCartId).at(-1);
  assert.ok(namesId(fixture.storage, known.recovery.candidateCartId));
  assert.ok(namesId(fixture.storage, successorCandidate));
  assert.equal(fixture.storage.getItem(ACTIVE), cart.id);
  const creates = count(fixture, 'cartCreate');
  await (await tab(fixture)).recoverCart().catch(() => null);
  assert.equal(count(fixture, 'cartCreate'), creates);
});

test('8: a fresh attempt without the exact displayed binding is refused before anything is written', async () => {
  const { fixture } = await interruptedAttempt();
  const before = everything(fixture.storage);
  for (const binding of [undefined, 'stale']) {
    await assert.rejects((await tab(fixture)).recoverCart({ abandonUnconfirmed: true, binding }), error => error.code === 'cart-changed');
  }
  assert.deepEqual(everything(fixture.storage), before);
});

for (const variant of ['aborted before apply', 'aborted after apply', 'a clean-looking reply that was never saved']) {
  test(`8: a recovery attachment ${variant}: only an actually saved exact pair is adopted, with zero replay`, async () => {
    const { fixture, cart } = await frozenServiced();
    const shopper = await intercepted(fixture, async (request, forward) => {
      if (!request.query.startsWith(FIELDS.cartLinesAdd)) return forward();
      if (variant === 'aborted before apply') throw new DOMException('aborted', 'AbortError');
      if (variant === 'aborted after apply') { await forward(); throw new DOMException('aborted', 'AbortError'); }
      const candidate = request.variables.cartId;
      const read = await fixture.fetchImpl('https://store.myshopify.com/api/2026-07/graphql.json', { body: JSON.stringify({ query: `query Cart($id: ID!, $after: String) { cart(id: $id) { parentRelationship discountCodes { code applicable } discountApplications { subtotalAmount { amount currencyCode } totalAmount { amount currencyCode } discountAllocations(lineLevelOnly: false) attributes { key value } canUpdateQuantity } }`, variables: { id: candidate } }) });
      const envelope = await read.json();
      return answer({ data: { cartLinesAdd: { cart: envelope.data.cart, userErrors: [], warnings: [] } } });
    });
    await assert.rejects(shopper.recoverCart());
    assert.equal(fixture.storage.getItem(ACTIVE), cart.id);
    const attachments = count(fixture, 'cartLinesAdd');
    const resumed = await (await tab(fixture)).recoverCart().catch(error => ({ error }));
    assert.equal(count(fixture, 'cartLinesAdd'), attachments, 'zero replay');
    if (variant === 'aborted after apply') {
      assert.notEqual(resumed.id, cart.id);
      assert.equal(service(resumed, glove(resumed)).quantity, 1);
    } else {
      assert.equal(resumed.error?.code, 'recovery-unconfirmed');
      assert.equal(fixture.storage.getItem(ACTIVE), cart.id);
    }
  });
}

// ---- Row 9: dispatch boundary and legitimate rejection ----

test('9 positive: refused input, unavailable or cancelled locks and pre-arm failures make zero calls', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  const cart = await fixture.commerce.addProduct('black', false);
  const sent = allMutations(fixture);
  await assert.rejects(fixture.commerce.setLineQuantity(glove(cart).remoteLineId, -1));
  await assert.rejects(fixture.commerce.adjustLineQuantity(glove(cart).remoteLineId, 2));
  const noLock = await loaded(createShopifyCommerce(fixture.config, fixture.storage, fixture.fetchImpl, null));
  await assert.rejects(noLock.addProduct('blue', false), error => error.code === 'lock-unavailable');
  const cancelled = await loaded(createShopifyCommerce(fixture.config, fixture.storage, fixture.fetchImpl,
    { request: () => Promise.reject(new DOMException('cancelled', 'AbortError')) }));
  await assert.rejects(cancelled.addProduct('blue', false), error => error.code === 'lock-timeout');
  assert.equal(allMutations(fixture), sent);
  assert.deepEqual(blocking(fixture.storage), []);
});

test('9 positive: a verified unchanged user error and a stock limit keep actionable feedback and allow later work', async () => {
  const fixture = shopifyFixture({ stock: { br16: 1 } });
  await fixture.commerce.listProducts();
  const cart = await fixture.commerce.addProduct('black', false);
  fixture.setUserError('Merchandise unavailable');
  await assert.rejects(fixture.commerce.setLineQuantity(glove(cart).remoteLineId, 2), error => error.definitiveRejection === true && /Merchandise unavailable/.test(error.message));
  fixture.setUserError('');
  assert.deepEqual(blocking(fixture.storage), []);
  await assert.rejects(fixture.commerce.setLineQuantity(glove(cart).remoteLineId, 2), error => error.code === 'stock-limit' && /still has 1/.test(error.message));
  assert.deepEqual(blocking(fixture.storage), []);
  fixture.setStock('br16', 5);
  assert.equal(glove(await fixture.commerce.setLineQuantity(glove(cart).remoteLineId, 2)).quantity, 2);
});

const afterInvocation = {
  'a lost response': fixture => fixture.faultAfterSave({ kind: 'lost' }),
  'an abort': fixture => fixture.faultAfterSave({ kind: 'abort' }),
  'a timeout': fixture => fixture.faultAfterSave({ kind: 'timeout' }),
  'a malformed body': fixture => fixture.faultAfterSave({ status: 200, body: false }),
  'a redirect': fixture => fixture.faultAfterSave({ status: 302, body: false }),
  'HTTP 400': fixture => fixture.faultAfterSave({ status: 400 }), 'HTTP 401': fixture => fixture.faultAfterSave({ status: 401 }),
  'HTTP 403': fixture => fixture.faultAfterSave({ status: 403 }), 'HTTP 404': fixture => fixture.faultAfterSave({ status: 404 }),
  'HTTP 408': fixture => fixture.faultAfterSave({ status: 408 }), 'HTTP 429': fixture => fixture.faultAfterSave({ status: 429 }),
  'HTTP 503': fixture => fixture.faultAfterSave({ status: 503 }),
  'a 503 before Shopify applied it': fixture => fixture.setApiError(true)
};
for (const [label, inject] of Object.entries(afterInvocation)) {
  test(`9 negative: ${label} after invocation stays unresolved across reload and is never replayed`, async () => {
    const fixture = shopifyFixture({ timeoutMs: 50 });
    await fixture.commerce.listProducts();
    const cart = await fixture.commerce.addProduct('black', false);
    inject(fixture);
    await assert.rejects(fixture.commerce.setLineQuantity(glove(cart).remoteLineId, 2), error => error.code === 'uncertain');
    fixture.setApiError(false);
    assert.equal(blocking(fixture.storage).length, 1);
    const sent = allMutations(fixture);
    for (const commerce of [fixture.commerce, await tab(fixture)]) {
      await assert.rejects(commerce.setLineQuantity(glove(cart).remoteLineId, 3), error => error.code === 'cart-unresolved');
      assert.equal((await checkout(commerce, cart)).navigations, 0);
    }
    assert.equal(allMutations(fixture), sent);
  });
}

test('9 negative: an unchanged-looking user error after an earlier committed step never settles the operation', async () => {
  const fixture = shopifyFixture({ autoSyncChild: false });
  await fixture.commerce.listProducts();
  const cart = await fixture.commerce.addProduct('black', true);
  fixture.failNextMutation(2);
  await assert.rejects(fixture.commerce.setLineQuantity(glove(cart).remoteLineId, 2));
  assert.equal(blocking(fixture.storage).length, 1, 'the paired change stays unresolved');
  const sent = allMutations(fixture);
  await assert.rejects((await tab(fixture)).setLineQuantity(glove(cart).remoteLineId, 3));
  assert.equal(allMutations(fixture), sent);
});

// ---- Row 10: serialized writes and pairing ----

test('10 positive: serialized first adds, +1 intents, discount with quantity, and service edits keep exact pairing', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  const second = await tab(fixture);
  let inFlight = 0; let peak = 0;
  fixture.observeMutations(() => { inFlight++; peak = Math.max(peak, inFlight); Promise.resolve().then(() => { inFlight--; }); });
  const [a, b] = await Promise.all([fixture.commerce.addProduct('black', true), second.addProduct('black', true)]);
  assert.equal(count(fixture, 'cartCreate'), 1);
  assert.equal(b.id, a.id);
  const line = glove(await fixture.commerce.getCart()).remoteLineId;
  await Promise.all([fixture.commerce.adjustLineQuantity(line, 1), second.adjustLineQuantity(line, 1)].map(p => p.catch(error => error)));
  const stepped = await fixture.commerce.getCart();
  const parent = stepped.lines.find(item => !item.isBreakIn);
  assert.equal(service(stepped, parent).quantity, parent.quantity);
  await Promise.all([fixture.commerce.applyDiscountCode('SAVE'), second.setLineQuantity(parent.remoteLineId, parent.quantity + 1)]);
  const both = await fixture.commerce.getCart();
  assert.equal(both.discountCodes[0].code, 'SAVE');
  assert.equal(service(both, glove(both)).quantity, glove(both).quantity);
  const edited = await fixture.commerce.setWristFit(glove(both).remoteLineId, 'tightened');
  for (const item of edited.lines.filter(entry => !entry.isBreakIn)) assert.equal(service(edited, item).quantity, item.quantity);
  assert.equal(peak, 1, 'at most one participating mutation in flight');
});

test('10 negative: a stale line identity is refused with no mutation; a mid-operation failure blocks further mutation and checkout', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  const cart = await fixture.commerce.addProduct('black', true);
  const expected = { quantity: 1, identity: 'stale' };
  const sent = allMutations(fixture);
  await assert.rejects(fixture.commerce.adjustLineQuantity(glove(cart).remoteLineId, 1, expected), error => error.code === 'cart-changed');
  assert.equal(allMutations(fixture), sent);
  fixture.failAfterNextMutation(2);
  await assert.rejects(fixture.commerce.addBreakIn(glove(await fixture.commerce.addProduct('blue', false), 'blue').remoteLineId, { level: 'Game Ready (90%)', wearingStyle: 'Traditional' }));
  const blocked = allMutations(fixture);
  await assert.rejects((await tab(fixture)).addProduct('brown', false));
  assert.equal((await checkout(await tab(fixture), await (await tab(fixture)).getCart())).navigations, 0);
  assert.equal(allMutations(fixture), blocked);
});

// ---- Row 11: checkout, disclosure and handoff ----

test('11: one verified navigation; a dropped or thrown navigation keeps the freeze across reload', async () => {
  for (const handoff of ['dropped', 'thrown']) {
    const fixture = shopifyFixture();
    await fixture.commerce.listProducts();
    const cart = await fixture.commerce.addProduct('black', false);
    let calls = 0;
    const result = await fixture.commerce.checkout(cart, {}, () => { calls++; if (handoff === 'thrown') throw new Error('navigation failed'); });
    assert.equal(calls, 1);
    assert.equal(result.status, handoff === 'thrown' ? 'blocked' : 'navigating');
    const [freeze] = blocking(fixture.storage);
    assert.deepEqual(freeze.kinds, ['checkout handoff']);
    const reloaded = await tab(fixture);
    assert.equal((await checkout(reloaded, await reloaded.getCart())).navigations, 0);
    await assert.rejects(reloaded.addProduct('blue', false), error => error.code === 'cart-unresolved');
  }
});

test('11: a displayed cart that differs gets a verified review first; stale or invalid states never enable checkout', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  const shown = await fixture.commerce.addProduct('black', false);
  await (await fixture.detached()).setLineQuantity(glove(shown).remoteLineId, 2);
  const review = await checkout(await tab(fixture), shown);
  assert.equal(review.status, 'review');
  assert.equal(review.navigations, 0);
  assert.deepEqual(blocking(fixture.storage), [], 'no freeze before the reviewed click');
  assert.equal((await checkout(await tab(fixture), review.cart)).navigations, 1);
});

test('11: a frozen cart Shopify reports gone lets the next add start a new cart and keeps the freeze record', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  const cart = await fixture.commerce.addProduct('black', false);
  assert.equal((await checkout(fixture.commerce, cart)).navigations, 1);
  const freeze = rawOps(fixture.storage);
  fixture.expireCart();
  const added = await (await tab(fixture)).addProduct('blue', false);
  assert.notEqual(added.id, cart.id);
  for (const [key, raw] of Object.entries(freeze)) assert.equal(fixture.storage.getItem(key), raw);
});

test('legacy: a stored non-production cart pointer and 2G records are read without rewriting and stay blocked', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  fixture.storage.setItem(ACTIVE, 'gid://cart/1');
  fixture.storage.setItem(`${UNSAFE_RECORD_PREFIX}legacy`, JSON.stringify({ cartId: 'gid://cart/1', kind: 'addProduct', kinds: ['addition'], status: 'unresolved', dispatched: true }));
  const before = everything(fixture.storage);
  await assert.rejects((await tab(fixture)).getCart(), error => error.code === 'cart-unverified');
  await assert.rejects((await tab(fixture)).addProduct('black', false));
  assert.deepEqual(everything(fixture.storage), before);
  assert.equal(allMutations(fixture), 0);
});
