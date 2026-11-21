import test from 'node:test';
import assert from 'node:assert/strict';
import { shopifyFixture } from '../test-support/shopify-fixture.js';
import { FULL_SIZE_SERVICE_VARIANT } from '../src/catalog.js';
import { cartDiscountSummary, entryDisplayAmounts, renderCartDiscounts } from '../src/cart-discounts.js';
import { checkoutCartIsComplete } from '../src/checkout-safety.js';

// Models the proposed Shopify configuration (docs/preorder-commerce.md):
// PREORDER30 = Amount off products, $30.00 fixed, each eligible item, four full-size gloves only.
// WRECKER100 = Amount off products, $75.00 fixed, once per order, full-size service only, one customer.
const FULL_SIZE = ['mi26', 'bl50', 'or17', 'cm24'];
const SERVICE = 'full-size-glove-break-in-service';
const options = { type: 'full-size', wearingStyle: 'Traditional — index finger out', closure: 'Ring finger', thumbShape: 'Straight',
  pinkyShape: 'Flared', fingerShape: 'Rolled', firmness: 'Medium', notes: 'keep the pocket shallow' };
const money = (amount, currency) => new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 2 }).format(amount);
const escapeHtml = value => String(value);
const allocation = (amount, code) => ({ discountedAmount: { amount: String(amount), currencyCode: 'USD' }, targetType: 'LINE_ITEM',
  sourceDiscountApplication: { code } });

function preorderScenario(getLines, { wreckerIdentified = true } = {}) {
  return codes => {
    const keys = codes.map(code => code.toLowerCase());
    const lines = getLines();
    const quantity = handle => lines.filter(line => line.merchandise.product.handle === handle).reduce((sum, line) => sum + line.quantity, 0);
    const discountedPrices = {};
    const discountAllocations = {};
    const preorder = keys.includes('preorder30') && FULL_SIZE.some(handle => quantity(handle));
    const wrecker = keys.includes('wrecker100') && wreckerIdentified && quantity(SERVICE) > 0;
    if (preorder) {
      for (const handle of FULL_SIZE.filter(quantity)) {
        discountedPrices[handle] = '265.00';
        discountAllocations[handle] = [allocation(30 * quantity(handle), 'PREORDER30')];
      }
    }
    if (wrecker) {
      const q = quantity(SERVICE);
      discountedPrices[SERVICE] = String((75 * q - 75) / q);
      discountAllocations[SERVICE] = [allocation(75, 'WRECKER100')];
    }
    return {
      discountCodes: codes.map(code => ({ code, applicable: code.toLowerCase() === 'preorder30' ? preorder :
        code.toLowerCase() === 'wrecker100' ? wrecker : false })),
      discountApplications: [
        ...(preorder ? [{ code: 'PREORDER30', targetType: 'LINE_ITEM', value: { __typename: 'MoneyV2' } }] : []),
        ...(wrecker ? [{ code: 'WRECKER100', targetType: 'LINE_ITEM', value: { __typename: 'MoneyV2' } }] : [])
      ],
      discountedPrices, discountAllocations
    };
  };
}

async function preorderFixture(scenarioOptions) {
  let fixture;
  fixture = shopifyFixture({ fullSize: true, checkoutHost: 'ignvv0-zh.myshopify.com',
    discountScenario: preorderScenario(() => fixture?.lines || [], scenarioOptions) });
  await fixture.commerce.listProducts();
  return fixture;
}
const glove = (cart, id = 'full-mint') => cart.lines.find(line => line.productId === id && !line.isBreakIn);
const service = (cart, id = 'full-mint') => cart.lines.find(line => line.productId === id && line.isBreakIn);
const discountMutations = fixture => fixture.requests.filter(request => request.query.includes('UpdateDiscountCodes'));
const shape = cart => cart.lines.map(line => ({ id: line.remoteLineId, parent: line.parentLineId, merchandiseId: line.merchandiseId,
  quantity: line.quantity, attributes: line.attributes })).sort((a, b) => a.id.localeCompare(b.id));

async function twoGlovesTwoServices() {
  const fixture = await preorderFixture();
  await fixture.commerce.addProduct('full-mint', true, options, 'gid://variant/mi26-right');
  const cart = await fixture.commerce.setQuantity('full-mint', 2);
  assert.equal(glove(cart).quantity, 2);
  assert.equal(service(cart).quantity, 2);
  assert.equal(checkoutCartIsComplete(cart), true);
  return { fixture, cart };
}

test('a second code is appended: cartDiscountCodesUpdate always receives the full code list', async () => {
  const { fixture } = await twoGlovesTwoServices();
  await fixture.commerce.applyDiscountCode('PREORDER30');
  const both = await fixture.commerce.applyDiscountCode('WRECKER100');
  const sent = discountMutations(fixture).map(request => request.variables.discountCodes);
  assert.deepEqual(sent, [['PREORDER30'], ['PREORDER30', 'WRECKER100']]);
  assert.deepEqual(both.discountCodes, [{ code: 'PREORDER30', applicable: true }, { code: 'WRECKER100', applicable: true }]);
  // Re-entering an existing code in another case sends nothing and keeps both.
  const again = await fixture.commerce.applyDiscountCode('preorder30');
  assert.equal(discountMutations(fixture).length, 2);
  assert.equal(again.discountCodes.length, 2);
  // Removing one code sends the remaining list, never an empty list.
  const removed = await fixture.commerce.removeDiscountCode('WRECKER100');
  assert.deepEqual(discountMutations(fixture).at(-1).variables.discountCodes, ['PREORDER30']);
  assert.deepEqual(removed.discountCodes, [{ code: 'PREORDER30', applicable: true }]);
});

test('PREORDER30 takes $30 off each full-size glove and never reduces the $75 service', async () => {
  const { fixture } = await twoGlovesTwoServices();
  const cart = await fixture.commerce.applyDiscountCode('PREORDER30');
  assert.deepEqual(glove(cart).allDiscountAllocations, [{ amount: { amount: 60, currencyCode: 'USD' }, targetType: 'LINE_ITEM', code: 'PREORDER30' }]);
  assert.equal(glove(cart).lineTotal.amount, 530);
  assert.deepEqual(service(cart).allDiscountAllocations, []);
  assert.equal(service(cart).lineTotal.amount, 150);
  const summary = cartDiscountSummary(cart);
  assert.equal(summary.original.amount, 740);
  assert.equal(summary.final.amount, 680);
  assert.deepEqual(summary.discounts, [{ code: 'PREORDER30', amount: { amount: 60, currencyCode: 'USD' } }]);
  assert.deepEqual(entryDisplayAmounts(glove(cart), service(cart)), {
    original: { amount: 740, currencyCode: 'USD' }, discounted: { amount: 680, currencyCode: 'USD' } });
  assert.equal(checkoutCartIsComplete(cart), true);
});

test('PREORDER30 + WRECKER100 on 2 gloves + 2 services: $60 off gloves, exactly one service free', async () => {
  const { fixture, cart: before } = await twoGlovesTwoServices();
  await fixture.commerce.applyDiscountCode('PREORDER30');
  const cart = await fixture.commerce.applyDiscountCode('WRECKER100');
  assert.deepEqual(glove(cart).allDiscountAllocations.map(item => [item.code, item.amount.amount]), [['PREORDER30', 60]]);
  assert.deepEqual(service(cart).allDiscountAllocations.map(item => [item.code, item.amount.amount]), [['WRECKER100', 75]]);
  assert.equal(service(cart).lineTotal.amount, 75);
  const summary = cartDiscountSummary(cart);
  assert.equal(summary.final.amount, 740 - 60 - 75);
  assert.deepEqual(summary.discounts.map(item => [item.code, item.amount.amount]), [['PREORDER30', 60], ['WRECKER100', 75]]);
  const html = renderCartDiscounts(cart, 'shopify', money, escapeHtml);
  assert.match(html, /Discount \(PREORDER30\)<\/span><span>−\$60\.00/);
  assert.match(html, /Discount \(WRECKER100\)<\/span><span>−\$75\.00/);
  assert.match(html, /Total before shipping\/tax<\/span><strong>\$605\.00/);
  assert.doesNotMatch(html, /Other discounts/, 'no duplicated or unattributed discount rows');
  // Line structure, parent links, quantities and service customization survive both applies.
  assert.deepEqual(shape(cart), shape(before));
  assert.equal(service(cart).merchandiseId, FULL_SIZE_SERVICE_VARIANT);
  assert.equal(checkoutCartIsComplete(cart), true);
});

test('removing either code keeps the other code, the service pairing and its customization attributes', async () => {
  const { fixture, cart: before } = await twoGlovesTwoServices();
  await fixture.commerce.applyDiscountCode('PREORDER30');
  await fixture.commerce.applyDiscountCode('WRECKER100');
  const withoutPreorder = await fixture.commerce.removeDiscountCode('PREORDER30');
  assert.deepEqual(withoutPreorder.discountCodes, [{ code: 'WRECKER100', applicable: true }]);
  assert.deepEqual(glove(withoutPreorder).allDiscountAllocations, []);
  assert.equal(service(withoutPreorder).lineTotal.amount, 75);
  assert.deepEqual(shape(withoutPreorder), shape(before));
  assert.equal(checkoutCartIsComplete(withoutPreorder), true);
  const none = await fixture.commerce.removeDiscountCode('WRECKER100');
  assert.deepEqual(none.discountCodes, []);
  assert.equal(cartDiscountSummary(none).savings, null);
  assert.deepEqual(shape(none), shape(before));
  assert.equal(checkoutCartIsComplete(none), true);
});

test('PREORDER30 does not apply to trainers or the trainer break-in service', async () => {
  const fixture = await preorderFixture();
  await fixture.commerce.addProduct('black', true, { level: 'Game Ready (90%)', wearingStyle: 'Traditional' });
  const cart = await fixture.commerce.applyDiscountCode('PREORDER30');
  assert.deepEqual(cart.discountCodes, [{ code: 'PREORDER30', applicable: false }]);
  assert.equal(cartDiscountSummary(cart).savings, null);
  assert.ok(cart.lines.every(line => line.allDiscountAllocations.length === 0));
  assert.equal(checkoutCartIsComplete(cart), true, 'a non-applicable code never blocks checkout');
});

test('mixed cart: PREORDER30 reduces only the full-size glove line', async () => {
  const fixture = await preorderFixture();
  await fixture.commerce.addProduct('black', true, { level: 'Game Ready (90%)', wearingStyle: 'Traditional' });
  await fixture.commerce.addProduct('full-black', true, options, 'gid://variant/bl50-right');
  const cart = await fixture.commerce.applyDiscountCode('PREORDER30');
  const discounted = cart.lines.filter(line => line.allDiscountAllocations.length);
  assert.deepEqual(discounted.map(line => [line.productId, line.isBreakIn, line.allDiscountAllocations[0].amount.amount]), [['full-black', false, 30]]);
  assert.equal(cartDiscountSummary(cart).final.amount, 155 + 20 + 295 + 75 - 30);
  assert.equal(checkoutCartIsComplete(cart), true);
});

test('an unidentified buyer keeps WRECKER100 on the cart as not applicable so checkout can evaluate it', async () => {
  const fixture = await preorderFixture({ wreckerIdentified: false });
  await fixture.commerce.addProduct('full-mint', true, options, 'gid://variant/mi26-right');
  await fixture.commerce.applyDiscountCode('PREORDER30');
  const cart = await fixture.commerce.applyDiscountCode('WRECKER100');
  assert.deepEqual(cart.discountCodes, [{ code: 'PREORDER30', applicable: true }, { code: 'WRECKER100', applicable: false }]);
  assert.equal(service(cart).lineTotal.amount, 75);
  // A later code change still forwards the pending customer-specific code.
  await fixture.commerce.removeDiscountCode('PREORDER30');
  assert.deepEqual(discountMutations(fixture).at(-1).variables.discountCodes, ['WRECKER100']);
  assert.equal(checkoutCartIsComplete(await fixture.commerce.getCart()), true);
});

test('quantity changes after both codes are applied keep glove and service quantities paired', async () => {
  const { fixture } = await twoGlovesTwoServices();
  await fixture.commerce.applyDiscountCode('PREORDER30');
  await fixture.commerce.applyDiscountCode('WRECKER100');
  const three = await fixture.commerce.setQuantity('full-mint', 3);
  assert.equal(glove(three).quantity, 3);
  assert.equal(service(three).quantity, 3);
  assert.equal(glove(three).allDiscountAllocations[0].amount.amount, 90);
  assert.equal(service(three).allDiscountAllocations[0].amount.amount, 75, 'still one free service per order');
  assert.equal(three.discountCodes.length, 2);
  assert.equal(checkoutCartIsComplete(three), true);
  const one = await fixture.commerce.setQuantity('full-mint', 1);
  assert.equal(service(one).quantity, 1);
  assert.equal(service(one).lineTotal.amount, 0);
  assert.equal(checkoutCartIsComplete(one), true);
});

test('checkout proceeds with both codes applied and blocks if a discount response ever splits the service line', async () => {
  const { fixture } = await twoGlovesTwoServices();
  await fixture.commerce.applyDiscountCode('PREORDER30');
  const applied = await fixture.commerce.applyDiscountCode('WRECKER100');
  assert.equal((await fixture.commerce.checkout(applied, {}, () => {})).status, 'navigating');

  const split = await twoGlovesTwoServices();
  split.fixture.transformNextMutationResponse(payload => {
    const nodes = payload.cart.lines.nodes;
    const child = nodes.find(line => line.parentRelationship);
    child.quantity = 1;
    nodes.push({ ...structuredClone(child), id: `${child.id}-split` });
  });
  const result = await split.fixture.commerce.applyDiscountCode('WRECKER100');
  assert.equal(result.lines.filter(line => line.isBreakIn).length, 2);
  assert.equal(checkoutCartIsComplete(result), false, 'a split service line never reaches checkout');
});

test('a service line whose discount reprices it below zero or in another currency is not displayed as a saving', () => {
  const line = (subtotal, total, allocations) => ({ lineSubtotal: { amount: subtotal, currencyCode: 'USD' }, lineTotal: { amount: total, currencyCode: 'USD' },
    allDiscountAllocations: allocations });
  const over = line(75, 0, [{ amount: { amount: 150, currencyCode: 'USD' }, targetType: 'LINE_ITEM', code: 'WRECKER100' }]);
  assert.equal(entryDisplayAmounts(line(285, 255, []), over), null);
  const foreign = line(75, 0, [{ amount: { amount: 75, currencyCode: 'CAD' }, targetType: 'LINE_ITEM', code: 'WRECKER100' }]);
  assert.equal(entryDisplayAmounts(line(285, 285, []), foreign), null);
});
