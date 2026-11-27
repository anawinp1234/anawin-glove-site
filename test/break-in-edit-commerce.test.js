import test from 'node:test';
import assert from 'node:assert/strict';
import { shopifyFixture } from '../test-support/shopify-fixture.js';
import { checkoutCartIsComplete, createCheckoutVerifier } from '../test-support/commerce-profiles.js';
import { FULL_SIZE_CONFIGURATION_KEY, fullSizeConfiguration, normalizeFullSizeOptions } from '../src/catalog.js';
import { FULL_SIZE_SERVICE_VARIANT } from '../test-support/commerce-profiles.js';

const MEDIUM = { level: 'Medium (65%)', wearingStyle: 'Traditional' };
const FIRM_TIP = { level: 'Firm (40%)', wearingStyle: 'Two in the Pinky (TIP)' };
const FULL = { type: 'full-size', wearingStyle: 'Traditional — index finger out', placement: '', closure: 'Ring finger',
  thumbShape: 'Straight', pinkyShape: 'Flared', fingerShape: 'Rolled', firmness: 'Medium', notes: '' };
const FULL_CHANGED = { ...FULL, wearingStyle: 'Other — describe your finger placement', placement: 'Index and middle in one stall',
  firmness: 'Firm', notes: 'Keep the pocket deep' };

const attribute = (line, key) => line?.attributes.find(item => item.key === key)?.value;
const gloves = (cart, productId) => cart.lines.filter(line => !line.isBreakIn && line.productId === productId);
const childOf = (cart, parent) => cart.lines.find(line => line.isBreakIn && line.parentLineId === parent.remoteLineId);
const total = (lines, service) => lines.filter(line => Boolean(line.isBreakIn) === service).reduce((sum, line) => sum + line.quantity, 0);
const unsafeOps = storage => Array.from({ length: storage.length }, (_, index) => storage.key(index))
  .filter(key => key.startsWith('anawin-shopify-unsafe-op:')).map(key => JSON.parse(storage.getItem(key)));
const mutations = fixture => fixture.requests.filter(request => request.query.startsWith('mutation'));
const trainerChoices = (cart, parent) => ({
  glove: [attribute(parent, '_anawin_break_in_level'), attribute(parent, '_anawin_wearing_style')],
  service: [attribute(childOf(cart, parent), 'Break-In Level'), attribute(childOf(cart, parent), 'Glove Wearing Style')]
});

async function trainerFixture(config = {}) {
  const fixture = shopifyFixture({ checkoutHost: 'ignvv0-zh.myshopify.com', ...config });
  await fixture.commerce.listProducts();
  await fixture.commerce.getBreakInService();
  return fixture;
}
async function fullSizeFixture(config = {}) {
  const fixture = shopifyFixture({ fullSize: true, ...config });
  await fixture.commerce.listProducts();
  await fixture.commerce.getBreakInService();
  await fixture.commerce.getFullSizeBreakInService();
  return fixture;
}

test('editing a single trainer glove updates the glove and its service in one request', async () => {
  const fixture = await trainerFixture();
  const before = await fixture.commerce.addProduct('black', true, MEDIUM);
  const sent = mutations(fixture).length;
  const after = await fixture.commerce.editBreakIn(gloves(before, 'black')[0].remoteLineId, FIRM_TIP);
  assert.equal(mutations(fixture).length, sent + 1);
  assert.equal(mutations(fixture).at(-1).variables.lines.length, 2);
  const [glove] = gloves(after, 'black');
  assert.deepEqual(trainerChoices(after, glove), { glove: [FIRM_TIP.level, FIRM_TIP.wearingStyle], service: [FIRM_TIP.level, FIRM_TIP.wearingStyle] });
  assert.equal(glove.quantity, 1);
  assert.equal(total(after.lines, true), 1);
  assert.equal(after.subtotal, before.subtotal);
  assert.equal(after.incomplete, false);
  assert.equal(checkoutCartIsComplete(after), true);
  assert.deepEqual(unsafeOps(fixture.storage).filter(record => record.status !== 'terminal'), []);
});

test('saving unchanged break-in choices sends nothing to Shopify', async () => {
  const fixture = await trainerFixture();
  const before = await fixture.commerce.addProduct('black', true, MEDIUM);
  const sent = mutations(fixture).length;
  const after = await fixture.commerce.editBreakIn(gloves(before, 'black')[0].remoteLineId, { ...MEDIUM });
  assert.equal(mutations(fixture).length, sent);
  assert.deepEqual(after.lines, before.lines);
});

test('editing one of several identical trainer gloves splits off only that glove', async () => {
  const fixture = await trainerFixture();
  await fixture.commerce.addProduct('black', true, MEDIUM);
  const before = await fixture.commerce.addProduct('black', true, MEDIUM);
  assert.equal(gloves(before, 'black')[0].quantity, 2);
  const after = await fixture.commerce.editBreakIn(gloves(before, 'black')[0].remoteLineId, FIRM_TIP);
  const lines = gloves(after, 'black');
  assert.equal(lines.length, 2);
  const kept = lines.find(line => attribute(line, '_anawin_break_in_level') === MEDIUM.level);
  const changed = lines.find(line => attribute(line, '_anawin_break_in_level') === FIRM_TIP.level);
  assert.equal(kept.quantity, 1);
  assert.equal(changed.quantity, 1);
  assert.deepEqual(trainerChoices(after, kept).service, [MEDIUM.level, MEDIUM.wearingStyle]);
  assert.deepEqual(trainerChoices(after, changed).service, [FIRM_TIP.level, FIRM_TIP.wearingStyle]);
  assert.equal(childOf(after, kept).quantity, 1);
  assert.equal(childOf(after, changed).quantity, 1);
  assert.equal(after.subtotal, before.subtotal);
  assert.equal(checkoutCartIsComplete(after), true);
  assert.deepEqual(unsafeOps(fixture.storage).filter(record => record.status !== 'terminal'), []);
});

test('an edit that matches another glove line merges into it with matching service', async () => {
  const fixture = await trainerFixture();
  await fixture.commerce.addProduct('black', true, FIRM_TIP);
  const before = await fixture.commerce.addProduct('black', true, MEDIUM);
  const medium = gloves(before, 'black').find(line => attribute(line, '_anawin_break_in_level') === MEDIUM.level);
  const after = await fixture.commerce.editBreakIn(medium.remoteLineId, FIRM_TIP);
  const [merged] = gloves(after, 'black');
  assert.equal(gloves(after, 'black').length, 1);
  assert.equal(merged.quantity, 2);
  assert.equal(childOf(after, merged).quantity, 2);
  assert.deepEqual(trainerChoices(after, merged).service, [FIRM_TIP.level, FIRM_TIP.wearingStyle]);
  assert.equal(checkoutCartIsComplete(after), true);
});

test('edits succeed when Shopify re-keys updated lines', async () => {
  for (const rekey of ['rekeyOnAttributeUpdate', 'rekeyOnAdd', 'rekeyOnQuantityUpdate']) {
    const fixture = await trainerFixture({ [rekey]: true });
    await fixture.commerce.addProduct('black', true, MEDIUM);
    let cart = await fixture.commerce.addProduct('blue', true, MEDIUM);
    cart = await fixture.commerce.editBreakIn(gloves(cart, 'black')[0].remoteLineId, FIRM_TIP);
    assert.deepEqual(trainerChoices(cart, gloves(cart, 'black')[0]).service, [FIRM_TIP.level, FIRM_TIP.wearingStyle], rekey);
    assert.deepEqual(trainerChoices(cart, gloves(cart, 'blue')[0]).service, [MEDIUM.level, MEDIUM.wearingStyle], rekey);
    assert.equal(checkoutCartIsComplete(cart), true, rekey);
  }
});

test('edits are refused without a mutation for unserviced, mismatched, or unresolved carts', async () => {
  const fixture = await trainerFixture();
  await fixture.commerce.addProduct('blue', false);
  const cart = await fixture.commerce.addProduct('black', true, MEDIUM);
  const sent = mutations(fixture).length;
  await assert.rejects(fixture.commerce.editBreakIn(gloves(cart, 'blue')[0].remoteLineId, FIRM_TIP), /no break-in choices/);
  await assert.rejects(fixture.commerce.editBreakIn(gloves(cart, 'black')[0].remoteLineId, FULL), /glove type/);
  await assert.rejects(fixture.commerce.editBreakIn(gloves(cart, 'black')[0].remoteLineId, { level: 'Soft', wearingStyle: 'Traditional' }), /Select a break-in level/);
  fixture.storage.setItem('anawin-shopify-unsafe-op:other-tab', JSON.stringify({ cartId: cart.id, kind: 'quantity update', kinds: ['quantity update'], status: 'unresolved' }));
  await assert.rejects(fixture.commerce.editBreakIn(gloves(cart, 'black')[0].remoteLineId, FIRM_TIP), /incomplete/);
  assert.equal(mutations(fixture).length, sent);
});

test('a rejected edit leaves the cart usable; an unanswered or unconfirmed edit blocks checkout', async () => {
  const rejected = await trainerFixture();
  let cart = await rejected.commerce.addProduct('black', true, MEDIUM);
  // Task 2H: a verified-unchanged user error is the definitive rejection (an HTTP status never settles a write).
  rejected.setUserError('Edit not allowed');
  await assert.rejects(rejected.commerce.editBreakIn(gloves(cart, 'black')[0].remoteLineId, FIRM_TIP), error => error.definitiveRejection === true);
  rejected.setUserError('');
  assert.deepEqual(unsafeOps(rejected.storage), []);
  assert.equal((await rejected.commerce.getCart()).incomplete, false);

  const unanswered = await trainerFixture();
  cart = await unanswered.commerce.addProduct('black', true, MEDIUM);
  unanswered.failAfterNextMutation();
  await assert.rejects(unanswered.commerce.editBreakIn(gloves(cart, 'black')[0].remoteLineId, FIRM_TIP));
  const blocked = await unanswered.restore().getCart();
  assert.equal(blocked.incomplete, true);
  assert.equal(blocked.recoveryAvailable, true);

  // Shopify answers but its cart lost the service line's new choices.
  const unconfirmed = await trainerFixture();
  cart = await unconfirmed.commerce.addProduct('black', true, MEDIUM);
  let tamper = false;
  unconfirmed.observeMutations(({ field }) => { if (field === 'cartLinesUpdate') tamper = true; });
  unconfirmed.observeQueries(() => {
    if (!tamper) return;
    tamper = false;
    const child = unconfirmed.lines.find(line => line.parentRelationship);
    child.attributes = child.attributes.map(item => item.key === 'Break-In Level' ? { ...item, value: MEDIUM.level } : item);
  });
  await assert.rejects(unconfirmed.commerce.editBreakIn(gloves(cart, 'black')[0].remoteLineId, FIRM_TIP), /incomplete|both cart lines/);
  assert.ok(unsafeOps(unconfirmed.storage).some(record => record.kinds.includes('Break-In change')));
  assert.equal(checkoutCartIsComplete(await unconfirmed.restore().getCart()), false);
});

test('a cart frozen for checkout cannot be edited', async () => {
  const fixture = await trainerFixture();
  const cart = await fixture.commerce.addProduct('black', true, MEDIUM);
  assert.equal((await fixture.commerce.checkout(cart, {}, () => {})).status, 'navigating');
  const sent = mutations(fixture).length;
  await assert.rejects(fixture.commerce.editBreakIn(gloves(cart, 'black')[0].remoteLineId, FIRM_TIP), /incomplete/);
  assert.equal(mutations(fixture).length, sent);
});

test('checkout in another tab is blocked while an edit is in flight', async () => {
  const fixture = await trainerFixture();
  const cart = await fixture.commerce.addProduct('black', true, MEDIUM);
  const reached = fixture.delayNextMutation();
  const editing = fixture.commerce.editBreakIn(gloves(cart, 'black')[0].remoteLineId, FIRM_TIP);
  await reached;
  const other = fixture.restore();
  const verify = createCheckoutVerifier({ getCart: () => other.getCart(), readSafety: () => other.readCartSafety() });
  assert.equal((await verify(cart)).status, 'blocked');
  fixture.releaseDelayedMutation();
  await editing;
  assert.deepEqual(unsafeOps(fixture.storage).filter(record => record.status !== 'terminal'), []);
});

test('a full-size glove can get break-in in the cart with its model and throw hand', async () => {
  for (const hand of ['right', 'left']) {
    const fixture = await fullSizeFixture();
    const before = await fixture.commerce.addProduct('full-mint', false, undefined, `gid://variant/mi26-${hand}`);
    const after = await fixture.commerce.addBreakIn(gloves(before, 'full-mint')[0].remoteLineId, FULL);
    const [glove] = gloves(after, 'full-mint');
    const service = childOf(after, glove);
    assert.equal(service.merchandiseId, FULL_SIZE_SERVICE_VARIANT);
    assert.equal(service.unitPrice.amount, 75);
    assert.equal(attribute(service, 'Glove Model'), 'MI26');
    assert.equal(attribute(service, 'Throwing Hand'), hand === 'left' ? 'Left' : 'Right');
    assert.equal(attribute(glove, FULL_SIZE_CONFIGURATION_KEY), fullSizeConfiguration(FULL));
    assert.equal(checkoutCartIsComplete(after), true, hand);
    assert.deepEqual(unsafeOps(fixture.storage).filter(record => record.status !== 'terminal'), []);
  }
});

test('full-size break-in can be added in the cart to one of several gloves', async () => {
  const fixture = await fullSizeFixture();
  await fixture.commerce.addProduct('full-mint', false, undefined, 'gid://variant/mi26-right');
  const before = await fixture.commerce.addProduct('full-mint', false, undefined, 'gid://variant/mi26-right');
  const after = await fixture.commerce.addBreakIn(gloves(before, 'full-mint')[0].remoteLineId, FULL);
  assert.deepEqual(gloves(after, 'full-mint').map(line => [line.serviceConfiguration, line.quantity]).sort(), [['break-in', 1], ['none', 1]]);
  assert.equal(total(after.lines, true), 1);
  assert.equal(checkoutCartIsComplete(after), true);
});

test('editing full-size break-in rewrites the instructions and their saved configuration', async () => {
  const fixture = await fullSizeFixture();
  const before = await fixture.commerce.addProduct('full-mint', true, FULL, 'gid://variant/mi26-left');
  const after = await fixture.commerce.editBreakIn(gloves(before, 'full-mint')[0].remoteLineId, FULL_CHANGED);
  const [glove] = gloves(after, 'full-mint');
  const service = childOf(after, glove);
  const expected = normalizeFullSizeOptions(FULL_CHANGED);
  assert.equal(attribute(glove, FULL_SIZE_CONFIGURATION_KEY), fullSizeConfiguration(expected));
  assert.equal(attribute(service, 'Finger Placement'), expected.placement);
  assert.equal(attribute(service, 'Firmness'), 'Firm');
  assert.equal(attribute(service, 'Notes'), 'Keep the pocket deep');
  assert.equal(attribute(service, 'Throwing Hand'), 'Left');
  assert.equal(attribute(service, 'Glove Model'), 'MI26');
  assert.equal(after.subtotal, before.subtotal);
  assert.equal(checkoutCartIsComplete(after), true);
  assert.deepEqual(unsafeOps(fixture.storage).filter(record => record.status !== 'terminal'), []);
});

test('editing one of several full-size gloves splits off only that glove', async () => {
  const fixture = await fullSizeFixture();
  await fixture.commerce.addProduct('full-mint', true, FULL, 'gid://variant/mi26-right');
  const before = await fixture.commerce.addProduct('full-mint', true, FULL, 'gid://variant/mi26-right');
  assert.equal(gloves(before, 'full-mint')[0].quantity, 2);
  const after = await fixture.commerce.editBreakIn(gloves(before, 'full-mint')[0].remoteLineId, FULL_CHANGED);
  const configurations = gloves(after, 'full-mint').map(line => [attribute(line, FULL_SIZE_CONFIGURATION_KEY), line.quantity, childOf(after, line).quantity]);
  assert.deepEqual(configurations.sort(), [[fullSizeConfiguration(FULL), 1, 1], [fullSizeConfiguration(FULL_CHANGED), 1, 1]].sort());
  assert.equal(checkoutCartIsComplete(after), true);
});
