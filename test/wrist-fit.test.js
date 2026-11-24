import test from 'node:test';
import assert from 'node:assert/strict';
import { shopifyFixture } from '../test-support/shopify-fixture.js';
import { checkoutCartIsComplete } from '../src/checkout-safety.js';
import { TIGHTENED_WRIST, WRIST_FIT_KEY, cartCustomizationIsComplete, withWristFit, wristFitOf } from '../src/catalog.js';
import { createLocalCommerce } from '../src/commerce.js';
import { renderCartRow } from '../src/cart-row.js';
import { cartUpdateAnnouncement } from '../src/cart-feedback.js';

const MEDIUM = { level: 'Medium (65%)', wearingStyle: 'Traditional' };
const FIRM_TIP = { level: 'Firm (40%)', wearingStyle: 'Two in the Pinky (TIP)' };
const FULL = { type: 'full-size', wearingStyle: 'Traditional — index finger out', placement: '', closure: 'Ring finger',
  thumbShape: 'Straight', pinkyShape: 'Flared', fingerShape: 'Rolled', firmness: 'Medium', notes: '' };

const attribute = (line, key) => line?.attributes.find(item => item.key === key)?.value;
const gloves = (cart, productId) => cart.lines.filter(line => !line.isBreakIn && line.productId === productId);
const childOf = (cart, parent) => cart.lines.find(line => line.isBreakIn && line.parentLineId === parent.remoteLineId);
const unsafeOps = storage => Array.from({ length: storage.length }, (_, index) => storage.key(index))
  .filter(key => key.startsWith('anawin-shopify-unsafe-op:')).map(key => JSON.parse(storage.getItem(key)));
const mutations = fixture => fixture.requests.filter(request => request.query.startsWith('mutation'));
const fits = cart => cart.lines.filter(line => !line.isBreakIn)
  .map(line => [line.productId, wristFitOf(line), line.quantity, childOf(cart, line)?.quantity || 0]).sort();

async function trainerFixture(config = {}) {
  const fixture = shopifyFixture({ checkoutHost: 'ignvv0-zh.myshopify.com', ...config });
  await fixture.commerce.listProducts();
  await fixture.commerce.getBreakInService();
  return fixture;
}
async function fullSizeFixture() {
  const fixture = shopifyFixture({ fullSize: true });
  await fixture.commerce.listProducts();
  await fixture.commerce.getBreakInService();
  await fixture.commerce.getFullSizeBreakInService();
  return fixture;
}

test('wrist fit is saved on the glove only when tightened', () => {
  assert.deepEqual(withWristFit([{ key: '_anawin_service', value: 'none' }], 'tightened'),
    [{ key: '_anawin_service', value: 'none' }, { key: WRIST_FIT_KEY, value: TIGHTENED_WRIST }]);
  assert.deepEqual(withWristFit([{ key: WRIST_FIT_KEY, value: TIGHTENED_WRIST }], 'regular'), []);
  assert.throws(() => withWristFit([], 'loose'), /wrist fit/);
  assert.equal(wristFitOf({ attributes: [] }), 'regular');
  assert.equal(wristFitOf({ attributes: [{ key: WRIST_FIT_KEY, value: TIGHTENED_WRIST }] }), 'tightened');
});

test('carts with an unknown, repeated, or misplaced wrist fit are not complete', () => {
  const glove = attributes => ({ remoteLineId: 'g', productId: 'black', quantity: 1,
    attributes: [{ key: '_anawin_service', value: 'none' }, ...attributes] });
  assert.equal(cartCustomizationIsComplete([glove([{ key: WRIST_FIT_KEY, value: TIGHTENED_WRIST }])]), true);
  assert.equal(cartCustomizationIsComplete([glove([{ key: WRIST_FIT_KEY, value: 'Loose' }])]), false);
  assert.equal(cartCustomizationIsComplete([glove([{ key: WRIST_FIT_KEY, value: TIGHTENED_WRIST }, { key: WRIST_FIT_KEY, value: TIGHTENED_WRIST }])]), false);
  const serviced = { ...glove([]), attributes: [{ key: '_anawin_service', value: 'break-in' },
    { key: '_anawin_break_in_level', value: MEDIUM.level }, { key: '_anawin_wearing_style', value: MEDIUM.wearingStyle }] };
  const child = extra => ({ isBreakIn: true, parentLineId: 'g', productId: 'black', quantity: 1, attributes: [
    { key: 'Break-In Level', value: MEDIUM.level }, { key: 'Glove Wearing Style', value: MEDIUM.wearingStyle }, ...extra] });
  assert.equal(cartCustomizationIsComplete([serviced, child([])]), true);
  assert.equal(cartCustomizationIsComplete([serviced, child([{ key: WRIST_FIT_KEY, value: TIGHTENED_WRIST }])]), false);
});

test('a tightened wrist can be added with or without break-in', async () => {
  const fixture = await trainerFixture();
  await fixture.commerce.addProduct('black', false, undefined, null, 'tightened');
  await fixture.commerce.addProduct('black', false);
  const cart = await fixture.commerce.addProduct('blue', true, MEDIUM, null, 'tightened');
  assert.deepEqual(fits(cart), [['black', 'regular', 1, 0], ['black', 'tightened', 1, 0], ['blue', 'tightened', 1, 1]]);
  const [blue] = gloves(cart, 'blue');
  assert.equal(attribute(blue, WRIST_FIT_KEY), TIGHTENED_WRIST);
  assert.equal(attribute(childOf(cart, blue), WRIST_FIT_KEY), undefined);
  assert.equal(checkoutCartIsComplete(cart), true);
  assert.deepEqual(unsafeOps(fixture.storage), []);
});

test('a full-size glove keeps a tightened wrist beside its break-in configuration', async () => {
  const fixture = await fullSizeFixture();
  const cart = await fixture.commerce.addProduct('full-mint', true, FULL, 'gid://variant/mi26-left', 'tightened');
  assert.deepEqual(fits(cart), [['full-mint', 'tightened', 1, 1]]);
  assert.equal(checkoutCartIsComplete(cart), true);
});

test('changing the wrist fit of a single glove keeps its break-in in one request', async () => {
  const fixture = await trainerFixture();
  const before = await fixture.commerce.addProduct('black', true, MEDIUM);
  const sent = mutations(fixture).length;
  const after = await fixture.commerce.setWristFit(gloves(before, 'black')[0].remoteLineId, 'tightened');
  assert.equal(mutations(fixture).length, sent + 1);
  const [glove] = gloves(after, 'black');
  assert.equal(attribute(glove, WRIST_FIT_KEY), TIGHTENED_WRIST);
  assert.equal(attribute(glove, '_anawin_break_in_level'), MEDIUM.level);
  assert.equal(attribute(childOf(after, glove), 'Break-In Level'), MEDIUM.level);
  assert.equal(after.subtotal, before.subtotal);
  assert.equal(checkoutCartIsComplete(after), true);
  const back = await fixture.commerce.setWristFit(glove.remoteLineId, 'regular');
  assert.deepEqual(fits(back), [['black', 'regular', 1, 1]]);
  assert.deepEqual(unsafeOps(fixture.storage), []);
});

test('choosing the wrist fit a glove already has sends nothing', async () => {
  const fixture = await trainerFixture();
  const before = await fixture.commerce.addProduct('black', false);
  const sent = mutations(fixture).length;
  await fixture.commerce.setWristFit(gloves(before, 'black')[0].remoteLineId, 'regular');
  assert.equal(mutations(fixture).length, sent);
  await assert.rejects(fixture.commerce.setWristFit(gloves(before, 'black')[0].remoteLineId, 'loose'), /wrist fit/);
});

test('changing the wrist fit of one of several gloves splits off only that glove', async () => {
  for (const service of [false, true]) {
    const fixture = await trainerFixture();
    await fixture.commerce.addProduct('black', service, service ? MEDIUM : undefined);
    const before = await fixture.commerce.addProduct('black', service, service ? MEDIUM : undefined);
    const after = await fixture.commerce.setWristFit(gloves(before, 'black')[0].remoteLineId, 'tightened');
    const expected = Number(service);
    assert.deepEqual(fits(after), [['black', 'regular', 1, expected], ['black', 'tightened', 1, expected]]);
    if (service) for (const glove of gloves(after, 'black')) assert.equal(attribute(childOf(after, glove), 'Break-In Level'), MEDIUM.level);
    assert.equal(after.subtotal, before.subtotal);
    assert.equal(checkoutCartIsComplete(after), true, String(service));
    assert.deepEqual(unsafeOps(fixture.storage), []);
  }
});

test('a wrist change that matches another glove line merges into it', async () => {
  const fixture = await trainerFixture();
  await fixture.commerce.addProduct('black', true, MEDIUM, null, 'tightened');
  const before = await fixture.commerce.addProduct('black', true, MEDIUM);
  const regular = gloves(before, 'black').find(line => wristFitOf(line) === 'regular');
  const after = await fixture.commerce.setWristFit(regular.remoteLineId, 'tightened');
  assert.deepEqual(fits(after), [['black', 'tightened', 2, 2]]);
  assert.equal(checkoutCartIsComplete(after), true);
});

test('wrist changes succeed when Shopify re-keys updated lines', async () => {
  for (const rekey of ['rekeyOnAttributeUpdate', 'rekeyOnAdd', 'rekeyOnQuantityUpdate']) {
    const fixture = await trainerFixture({ [rekey]: true });
    await fixture.commerce.addProduct('black', true, MEDIUM);
    let cart = await fixture.commerce.addProduct('black', true, MEDIUM);
    cart = await fixture.commerce.setWristFit(gloves(cart, 'black')[0].remoteLineId, 'tightened');
    assert.deepEqual(fits(cart), [['black', 'regular', 1, 1], ['black', 'tightened', 1, 1]], rekey);
    assert.equal(checkoutCartIsComplete(cart), true, rekey);
  }
});

test('break-in changes in the cart keep the glove’s wrist fit', async () => {
  const fixture = await trainerFixture();
  let cart = await fixture.commerce.addProduct('black', false, undefined, null, 'tightened');
  cart = await fixture.commerce.addBreakIn(gloves(cart, 'black')[0].remoteLineId, MEDIUM);
  assert.deepEqual(fits(cart), [['black', 'tightened', 1, 1]]);
  cart = await fixture.commerce.editBreakIn(gloves(cart, 'black')[0].remoteLineId, FIRM_TIP);
  assert.deepEqual(fits(cart), [['black', 'tightened', 1, 1]]);
  cart = await fixture.commerce.removeBreakIn(gloves(cart, 'black')[0].remoteLineId);
  assert.deepEqual(fits(cart), [['black', 'tightened', 1, 0]]);
  assert.equal(checkoutCartIsComplete(cart), true);
});

test('an unanswered wrist change blocks checkout', async () => {
  const fixture = await trainerFixture();
  const cart = await fixture.commerce.addProduct('black', true, MEDIUM);
  fixture.failAfterNextMutation();
  await assert.rejects(fixture.commerce.setWristFit(gloves(cart, 'black')[0].remoteLineId, 'tightened'));
  assert.equal((await fixture.restore().getCart()).incomplete, true);
});

test('the local cart remembers the chosen wrist fit', async () => {
  const storage = new Map();
  const commerce = createLocalCommerce({ getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) });
  const cart = await commerce.addProduct('brown', false, undefined, null, 'tightened');
  assert.equal(wristFitOf(cart.lines[0]), 'tightened');
});

test('the cart row shows the wrist fit and offers the other one', () => {
  const escapeHtml = value => String(value).replace(/[&<>'"]/g, character =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
  const row = (attributes, quantity = 1, mode = 'shopify') => renderCartRow({
    product: { id: 'blue', name: 'OB16', tone: 'Blue', images: ['/images/blue1.PNG'] },
    line: { remoteLineId: 'glove-1', quantity, attributes, lineTotal: { amount: 155 * quantity, currencyCode: 'USD' }, instructions: { canUpdateQuantity: true } },
    service: null, mode, serviceProduct: { price: 20, currencyCode: 'USD', available: true }, busy: false, incomplete: false,
    money: amount => `$${amount}`, escapeHtml });
  assert.match(row([]), /Wrist fit: Regular \(7–7\.5 inch opening\) <button[^>]*data-fit="tightened"[^>]*>Tighten wrist<\/button>/);
  assert.match(row([{ key: WRIST_FIT_KEY, value: TIGHTENED_WRIST }], 2), /Wrist fit: Tightened \(6\.5–7 inch opening\) <button[^>]*data-fit="regular"[^>]*>Use regular wrist for 1<\/button>/);
  assert.doesNotMatch(row([], 1, 'local'), /data-wrist-fit/);
});

test('a wrist change is announced', () => {
  const line = fit => ({ productId: 'black', quantity: 1, attributes: withWristFit([], fit) });
  assert.equal(cartUpdateAnnouncement({ lines: [line('regular')] }, { lines: [line('tightened')] }, () => 'BR16'), 'BR16 wrist fit updated.');
});
