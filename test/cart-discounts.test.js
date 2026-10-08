import test from 'node:test';
import assert from 'node:assert/strict';
import { cartDiscountSummary, renderCartDiscounts, renderCartDiscountSection, renderDiscountEntry } from '../src/cart-discounts.js';
import { renderCartRow } from '../src/cart-row.js';

const money = (amount, currency) => new Intl.NumberFormat('en-US', {
  style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 2
}).format(amount);
const escapeHtml = value => String(value).replace(/[&<>'"]/g, character =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
const usd = amount => ({ amount, currencyCode: 'USD' });
const allocation = (amount, code = 'LAUNCH10') => ({ amount: usd(amount), code, targetType: 'LINE_ITEM' });
const glove = (quantity = 1, original = 155, final = original, allocations = []) => ({
  remoteLineId: 'glove-1', productId: 'black', quantity, lineSubtotal: usd(original), lineTotal: usd(final),
  allDiscountAllocations: allocations, instructions: { canUpdateQuantity: true }
});
const service = (quantity = 1, original = 20, final = original, allocations = []) => ({
  remoteLineId: 'service-1', parentLineId: 'glove-1', productId: 'black', quantity, isBreakIn: true,
  lineSubtotal: usd(original), lineTotal: usd(final), allDiscountAllocations: allocations,
  instructions: { canRemove: true, canUpdateQuantity: true }
});
const cart = (lines, subtotal, codes = [], applications = []) => ({
  lines, subtotal, currencyCode: 'USD', discountCodes: codes, discountApplications: applications
});
const applied = [{ code: 'LAUNCH10', applicable: true }];
const percentage = [{ code: 'LAUNCH10', targetType: 'LINE_ITEM', percentage: 10 }];
const totals = value => renderCartDiscounts(value, 'shopify', money, escapeHtml);
const entry = value => renderDiscountEntry({ id: 'gid://cart/1', ...value }, {}, escapeHtml);
const row = (line, child = null) => renderCartRow({
  product: { id: 'black', name: 'BR16', tone: 'Black / Red / Gray', images: ['/images/black1.PNG'] },
  line, service: child, mode: 'shopify', serviceProduct: { price: 20, currencyCode: 'USD', available: true },
  busy: false, incomplete: false, money, escapeHtml
});

test('no discount keeps the original subtotal and line price', () => {
  const value = cart([glove()], 155);
  assert.match(totals(value), /<span>Subtotal<\/span><strong>\$155<\/strong>/);
  assert.doesNotMatch(totals(value), /applied|Discount \(|cart-final-total/);
  assert.equal(totals(value), '<div class="cart-total-row"><span>Subtotal</span><strong>$155</strong></div>');
  assert.match(row(value.lines[0]), /cart-line-price">\$155/);
  assert.doesNotMatch(row(value.lines[0]), /cart-line-original/);
});

test('applicable percentage code shows the configured percentage and Shopify savings', () => {
  const value = cart([glove(1, 155, 140, [allocation(15)])], 140, applied, percentage);
  const html = totals(value);
  assert.match(entry(value), /LAUNCH10 applied/);
  assert.match(html, /Merchandise subtotal<\/span><span>\$155/);
  assert.match(html, /Discount \(LAUNCH10\)<\/span><span>−\$15/);
  assert.match(html, /Total before shipping\/tax<\/span><strong>\$140/);
  assert.match(row(value.lines[0]), /<div class="cart-price-pair"><s class="cart-line-original">\$155<\/s><strong class="cart-line-price">\$140<\/strong>/);
});

test('an inapplicable code is never shown as applied', () => {
  const value = cart([glove()], 155, [{ code: 'LAUNCH10', applicable: false }], percentage);
  assert.doesNotMatch(totals(value), /LAUNCH10|applied/);
  assert.equal(cartDiscountSummary(value).codes.length, 0);
});

test('a fixed code omits a percentage and keeps cart-level allocation separate from Shopify subtotal', () => {
  const value = cart([glove(1, 155, 155, [allocation(15, 'SAVE15')])], 155,
    [{ code: 'SAVE15', applicable: true }], [{ code: 'SAVE15', targetType: 'LINE_ITEM', percentage: null }]);
  assert.match(entry(value), /SAVE15 applied/);
  assert.doesNotMatch(totals(value), /% off/);
  assert.match(totals(value), /Discount \(SAVE15\)<\/span><span>−\$15/);
  assert.match(totals(value), /Total before shipping\/tax<\/span><strong>\$140/);
  assert.match(row(value.lines[0]), /cart-line-original">\$155<\/s><strong class="cart-line-price">\$140/);
});

test('a shipping-only code is applied without claiming a merchandise percentage or savings', () => {
  const value = cart([glove()], 155, [{ code: 'FREESHIP', applicable: true }],
    [{ code: 'FREESHIP', targetType: 'SHIPPING_LINE', percentage: 100 }]);
  assert.match(entry(value), /FREESHIP applied/);
  assert.doesNotMatch(totals(value), /% off|Discount \(|cart-final-total/);
  assert.match(totals(value), /<span>Subtotal<\/span><strong>\$155/);
});

test('Break-In Service uses its own Shopify amount and eligibility', () => {
  const parent = glove(1, 155, 140, [allocation(15)]);
  const child = service();
  const value = cart([parent, child], 160, applied, percentage);
  assert.match(row(parent, child), /Break-in service · \$20/);
  assert.match(row(parent, child), /cart-line-original">\$175<\/s><strong class="cart-line-price">\$160/);
  assert.match(totals(value), /Merchandise subtotal<\/span><span>\$175/);
  assert.match(totals(value), /Total before shipping\/tax<\/span><strong>\$160/);

  const discountedService = service(1, 20, 18, [allocation(2, 'SERVICE2')]);
  assert.match(row(glove(), discountedService), /Break-in service · <s>\$20<\/s> \$18/);
  assert.match(row(glove(), discountedService), /cart-line-original">\$175<\/s><strong class="cart-line-price">\$173/);
});

test('quantities above one use extended Shopify line amounts', () => {
  const parent = glove(2, 310, 280, [allocation(30)]);
  const child = service(2, 40);
  const value = cart([parent, child], 320, applied, percentage);
  assert.match(row(parent, child), /Break-in service \(2\) · \$40/);
  assert.match(row(parent, child), /cart-line-original">\$350<\/s><strong class="cart-line-price">\$320/);
  assert.match(totals(value), /Discount \(LAUNCH10\)<\/span><span>−\$30/);
  assert.match(totals(value), /Total before shipping\/tax<\/span><strong>\$320/);
});

test('code names are escaped and mismatched allocation currency does not invent savings', () => {
  const bad = glove(1, 155, 155, [{ amount: { amount: 15, currencyCode: 'CAD' }, code: '<SAVE>', targetType: 'LINE_ITEM' }]);
  const value = cart([bad], 155, [{ code: '<SAVE>', applicable: true }]);
  assert.match(entry(value), /&lt;SAVE&gt; applied/);
  assert.doesNotMatch(totals(value), /−\$15|Total before shipping\/tax/);
});

test('discount form is labeled, submits with Enter, and announces non-applicable status', () => {
  const value = cart([glove()], 155, [{ code: 'NOPE', applicable: false }]);
  const html = renderDiscountEntry({ id: 'gid://cart/1', ...value },
    { input: 'NOPE', message: 'Discount code isn’t valid for this cart.', error: true }, escapeHtml);
  assert.match(html, /<label[^>]*for="cart-discount-input"/);
  assert.match(html, /<form data-discount-form>/);
  assert.match(html, /type="submit"/);
  assert.match(html, /NOPE not applicable/);
  assert.match(html, /role="alert"/);
  assert.match(html, /data-remove-discount="NOPE"/);
  assert.doesNotMatch(html, /NOPE applied/);
});

test('discount controls disable during an update and escape input and code attributes', () => {
  const value = cart([glove()], 155, [{ code: '<SAVE>', applicable: true }]);
  const html = renderDiscountEntry({ id: 'gid://cart/1', ...value }, { busy: true, input: '"<test>' }, escapeHtml);
  assert.match(html, /value="&quot;&lt;test&gt;" disabled/);
  assert.match(html, /Applying…/);
  assert.match(html, /data-remove-discount="&lt;SAVE&gt;" disabled/);
  assert.match(html, /&lt;SAVE&gt; applied/);
});

test('an applied code keeps the input, Apply, and its own Remove control above totals', () => {
  const value = { id: 'gid://cart/1', ...cart([glove(1, 155, 140, [allocation(15)])], 140, applied, percentage) };
  const html = renderCartDiscountSection(value, 'shopify', {}, money, escapeHtml);
  assert.match(html, /<form data-discount-form><input[^>]+placeholder="Enter code"[^>]*><button type="submit"[^>]*>Apply<\/button><\/form>/);
  assert.match(html, /LAUNCH10 applied<\/span><button type="button" data-remove-discount="LAUNCH10"[^>]*>Remove<\/button>/);
  assert.ok(html.indexOf('data-discount-form') < html.indexOf('LAUNCH10 applied'));
  assert.ok(html.indexOf('LAUNCH10 applied') < html.indexOf('Merchandise subtotal'));
  assert.match(html, /Total before shipping\/tax<\/span><strong>\$140/);
});

test('another code can be entered while multiple applied codes each retain Remove', () => {
  const value = { id: 'gid://cart/1', ...cart([glove()], 155,
    [{ code: 'LAUNCH10', applicable: true }, { code: 'EXTRA', applicable: true }]) };
  const html = renderCartDiscountSection(value, 'shopify', { input: 'NEXTCODE' }, money, escapeHtml);
  assert.match(html, /value="NEXTCODE"/);
  assert.match(html, /<button type="submit"[^>]*>Apply<\/button>/);
  assert.equal((html.match(/data-remove-discount=/g) || []).length, 2);
  assert.match(html, /data-remove-discount="LAUNCH10"/);
  assert.match(html, /data-remove-discount="EXTRA"/);
});
