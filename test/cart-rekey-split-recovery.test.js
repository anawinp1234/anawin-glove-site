import test from 'node:test';
import assert from 'node:assert/strict';
import { createShopifyCommerce, UNSAFE_RECORD_PREFIX } from '../src/commerce.js';
import { shopifyFixture } from '../test-support/shopify-fixture.js';

const firm = { level: 'Firm (40%)', wearingStyle: 'Traditional' };
const game = { level: 'Game Ready (90%)', wearingStyle: 'Traditional' };
const writes = fixture => fixture.requests.filter(({ query }) => query.startsWith('mutation'));
const journal = fixture => [...fixture.storage.values].filter(([key]) => key.startsWith(UNSAFE_RECORD_PREFIX));

async function split({ fault, beforeSplit } = {}) {
  const fixture = shopifyFixture({ rekeyOnAdd: true, rekeyOnQuantityUpdate: true, rekeyOnAttributeUpdate: true });
  const { commerce } = fixture;
  await commerce.listProducts();
  await commerce.addProduct('black', true, firm);
  await commerce.addProduct('brown', false);
  let before = await commerce.getCart();
  await commerce.setLineQuantity(before.lines.find(line => line.productId === 'black' && !line.isBreakIn).remoteLineId, 2);
  await beforeSplit?.(fixture);
  before = await commerce.getCart();
  const parent = before.lines.find(line => line.productId === 'black' && !line.isBreakIn);
  const start = writes(fixture).length;
  const tab = fault ? createShopifyCommerce(fixture.config, fixture.storage, async (url, request) => {
    const { query } = JSON.parse(request.body);
    const response = await fixture.fetchImpl(url, request);
    if (writes(fixture).length !== start + 1 || !/^(mutation AddLines|query Cart\()/.test(query)) return response;
    const envelope = await response.json();
    const raw = query.startsWith('mutation') ? envelope.data.cartLinesAdd.cart : envelope.data.cart;
    fault(raw, before);
    return { ok: true, status: 200, json: async () => envelope };
  }, fixture.locks) : commerce;
  if (fault) await tab.getBreakInService();
  if (fault) await assert.rejects(tab.editBreakIn(parent.remoteLineId, game));
  else await assert.rejects(tab.editBreakIn(parent.remoteLineId, game), { code: 'cart-unverified' });
  assert.equal(writes(fixture).length, start + 1, 'the source receives only the initial parent add');
  assert.match(writes(fixture).at(-1).query, /^mutation AddLines/);
  assert.equal(writes(fixture).at(-1).variables.lines.length, 1);
  assert.equal(writes(fixture).at(-1).variables.lines[0].parent, undefined);
  return { fixture, tab, before };
}

test('a whole-cart re-key freezes the split and offers consent-bound recovery of the $505 pre-edit cart', async () => {
  const { fixture, tab, before } = await split();
  assert.equal(before.subtotal, 505);
  const [[key, bytes]] = journal(fixture);
  const record = JSON.parse(bytes);
  assert.equal(key, UNSAFE_RECORD_PREFIX + record.owner);
  assert.equal(record.kind, 'editBreakIn');
  assert.equal(record.status, 'unresolved');
  assert.equal(record.step.n, 1);
  assert.equal(record.step.field, 'cartLinesAdd');
  assert.equal(record.step.state, 'dispatched-unknown');
  const source = fixture.cartLines(before.id);
  const count = writes(fixture).length;
  const shown = await tab.getCart();
  assert.equal(shown.recoveryAvailable, true);
  assert.ok(shown.splitRecoveryBinding);
  const handoffs = [];
  assert.equal((await tab.checkout(shown, {}, url => handoffs.push(url))).status, 'blocked');
  await assert.rejects(tab.recoverCart(), { code: 'recovery-ambiguous' });
  await assert.rejects(tab.recoverCart({ splitBinding: shown.splitRecoveryBinding, withoutBreakIn: true }), { code: 'recovery-ambiguous' });
  assert.equal(writes(fixture).length, count);
  assert.deepEqual(journal(fixture), [[key, bytes]]);
  const recovered = await tab.recoverCart({ splitBinding: shown.splitRecoveryBinding });
  assert.notEqual(recovered.id, before.id);
  assert.equal(Object.keys(fixture.savedCarts()).length, 2);
  const recoveryWrites = writes(fixture).slice(count);
  assert.equal(recoveryWrites.filter(entry => entry.query.startsWith('mutation CreateCart')).length, 1);
  assert.ok(recoveryWrites.every(entry => entry.variables.cartId !== before.id));
  assert.deepEqual(fixture.cartLines(before.id), source);
  assert.equal(recovered.subtotal, 505);
  assert.deepEqual(recovered.discountCodes, before.discountCodes);
  const [br16, cl16, service] = ['black', 'brown', 'service'].map(role =>
    recovered.lines.find(line => role === 'service' ? line.isBreakIn : !line.isBreakIn && line.productId === role));
  assert.equal(recovered.lines.length, 3);
  assert.deepEqual([br16.quantity, cl16.quantity, service.quantity], [2, 1, 2]);
  assert.equal(service.parentLineId, br16.remoteLineId);
  assert.equal(service.attributes.find(item => item.key === 'Break-In Level').value, firm.level);
  const checkAt = fixture.requests.length;
  assert.equal((await tab.checkout(recovered, {}, url => handoffs.push(url))).status, 'navigating');
  assert.ok(fixture.requests.slice(checkAt).some(entry => entry.query.startsWith('query Cart(') && entry.variables.id === recovered.id));
  assert.deepEqual(handoffs, [recovered.checkoutUrl]);
  assert.equal((await tab.checkout(recovered, {}, url => handoffs.push(url))).status, 'blocked');
});

const leftover = raw => raw.lines.nodes.find(line => line.attributes.some(item => item.value === game.level));
const faults = {
  'partial rotation': (raw, before) => {
    const parent = raw.lines.nodes.find(line => line.merchandise.product.handle === 'br16' && line.quantity === 2);
    const child = raw.lines.nodes.find(line => line.parentRelationship?.parent.id === parent.id);
    parent.id = before.lines.find(line => line.productId === 'black' && !line.isBreakIn).remoteLineId;
    child.parentRelationship.parent.id = parent.id;
  },
  'multiple leftover parents': raw => raw.lines.nodes.push({ ...structuredClone(leftover(raw)), id: 'line-9000' }),
  'incorrect leftover quantity': raw => { leftover(raw).quantity = 2; },
  'wrong merchandise': raw => { leftover(raw).merchandise = structuredClone(raw.lines.nodes.find(line => line.merchandise.product.handle === 'cl16').merchandise); },
  'changed non-service attributes': raw => leftover(raw).attributes.push({ key: 'unrequested', value: 'yes' }),
  'invalid Break-In configuration': raw => { leftover(raw).attributes.find(item => item.value === game.level).value = 'Unknown'; },
  'unexpected service child': raw => {
    const child = structuredClone(raw.lines.nodes.find(line => line.parentRelationship));
    child.id = 'line-9000';
    child.quantity = 1;
    child.parentRelationship.parent = { id: leftover(raw).id, merchandise: structuredClone(leftover(raw).merchandise) };
    raw.lines.nodes.push(child);
  },
  'unrelated quantity': raw => { raw.lines.nodes.find(line => line.merchandise.product.handle === 'cl16').quantity++; },
  'changed unrelated service relationship': raw => {
    const child = raw.lines.nodes.find(line => line.parentRelationship);
    const unrelated = raw.lines.nodes.find(line => line.merchandise.product.handle === 'cl16');
    child.parentRelationship.parent = { id: unrelated.id, merchandise: unrelated.merchandise };
  },
  'changed discount code': raw => raw.discountCodes.push({ code: 'UNREQUESTED', applicable: false })
};

for (const [label, fault] of Object.entries(faults)) {
  test(`split recovery refuses ${label}`, async () => {
    const { fixture, tab } = await split({ fault });
    assert.equal((await tab.getCart().catch(() => ({}))).splitRecoveryBinding, undefined);
    const count = writes(fixture).length;
    await assert.rejects(tab.recoverCart());
    assert.equal(writes(fixture).length, count);
    assert.equal(Object.keys(fixture.savedCarts()).length, 1);
  });
}

for (const [label, tamper] of Object.entries({
  'incorrect operation kind': record => { record.kind = 'addProduct'; },
  'incorrect step': record => { record.step.n++; },
  'stale ownership': record => { record.owner = 'foreign'; },
  'changed journal bytes after consent': record => { record.createdAt++; }
})) {
  test(`split recovery refuses ${label}`, async () => {
    const { fixture, tab } = await split();
    const { splitRecoveryBinding } = await tab.getCart();
    assert.ok(splitRecoveryBinding);
    const [[key, bytes]] = journal(fixture);
    const record = JSON.parse(bytes);
    tamper(record);
    fixture.storage.setItem(key, JSON.stringify(record));
    const count = writes(fixture).length;
    await assert.rejects(tab.recoverCart({ splitBinding: splitRecoveryBinding }), { code: 'recovery-ambiguous' });
    assert.equal(writes(fixture).length, count);
  });
}

test('split recovery refuses changed authoritative evidence after consent', async () => {
  const { fixture, tab } = await split();
  const { splitRecoveryBinding } = await tab.getCart();
  assert.ok(splitRecoveryBinding);
  fixture.lines.find(line => line.merchandise.product.handle === 'cl16').attributes.push({ key: 'later', value: 'changed' });
  const count = writes(fixture).length;
  await assert.rejects(tab.recoverCart({ splitBinding: splitRecoveryBinding }), { code: 'recovery-ambiguous' });
  assert.equal(writes(fixture).length, count);
});

test('a plain whole-rotation addition cannot use the split recovery exception', async () => {
  const fixture = shopifyFixture({ rekeyOnAdd: true });
  await fixture.commerce.listProducts();
  await fixture.commerce.addProduct('brown', false);
  fixture.failAfterNextMutation();
  await assert.rejects(fixture.commerce.addProduct('black', true, game));
  assert.equal((await fixture.commerce.getCart()).splitRecoveryBinding, undefined);
});

test('split recovery rejects ambiguous correspondence among rotated pre-edit parents', async () => {
  const { fixture, tab } = await split({ beforeSplit(fixture) {
    const unrelated = fixture.lines.find(line => line.merchandise.product.handle === 'cl16');
    fixture.lines.push({ ...structuredClone(unrelated), id: 'line-9000' });
  } });
  const shown = await tab.getCart();
  assert.equal(shown.recoveryAvailable, false);
  assert.equal(shown.splitRecoveryBinding, undefined);
  const count = writes(fixture).length;
  await assert.rejects(tab.recoverCart(), { code: 'recovery-ambiguous' });
  assert.equal(writes(fixture).length, count);
});
