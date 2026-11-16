import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cartDiscountSummary, discountEntryExpanded, discountResultFeedback, renderCartDiscounts, renderCartDiscountSection, renderDiscountEntry } from '../src/cart-discounts.js';
import { renderCartRow } from '../src/cart-row.js';
import { cartMoney } from '../src/storefront-render.js';

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

test('cart amounts always show two decimal places for cents and whole dollars', () => {
  const value = cart([glove(1, 155, 139.5, [allocation(15.5)])], 139.5, applied, percentage);
  const html = renderCartDiscounts(value, 'shopify', cartMoney, escapeHtml);
  assert.match(html, /Merchandise subtotal<\/span><span>\$155\.00/);
  assert.match(html, /Discount \(LAUNCH10\)<\/span><span>−\$15\.50/);
  assert.match(html, /Total before shipping\/tax<\/span><strong>\$139\.50/);
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
  assert.match(html, /<form id="cart-discount-panel" data-discount-form >/);
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
  assert.match(html, /data-remove-discount="&lt;SAVE&gt;" aria-label="Remove discount code &lt;SAVE&gt;" disabled/);
  assert.match(html, /&lt;SAVE&gt; applied/);
});

test('an applied code keeps the input, Apply, and its own Remove control above totals', () => {
  const value = { id: 'gid://cart/1', ...cart([glove(1, 155, 140, [allocation(15)])], 140, applied, percentage) };
  const html = renderCartDiscountSection(value, 'shopify', { expanded: true }, money, escapeHtml);
  assert.match(html, /<form id="cart-discount-panel" data-discount-form >.*?<input[^>]+placeholder="Enter code"[^>]*><button type="submit"[^>]*>Apply<\/button><\/form>/);
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

test('discount entry is a collapsed disclosure until opened, and applied codes stay visible', () => {
  const value = { id: 'gid://cart/1', ...cart([glove(1, 155, 140, [allocation(15)])], 140, applied, percentage) };
  const html = renderCartDiscountSection(value, 'shopify', {}, money, escapeHtml);
  assert.match(html, /<button type="button" id="discount-toggle" class="cart-discount-toggle" data-discount-toggle aria-expanded="false" aria-controls="cart-discount-panel">Have a discount code\?<\/button>/);
  assert.match(html, /<section class="cart-discount-entry" aria-labelledby="discount-toggle">/);
  assert.match(html, /<form id="cart-discount-panel" data-discount-form hidden>/);
  assert.match(html, /<label class="visually-hidden" for="cart-discount-input">Discount code<\/label>/);
  assert.ok(html.indexOf('</form>') < html.indexOf('LAUNCH10 applied'), 'applied code renders outside the collapsed panel');
  assert.match(html, /data-remove-discount="LAUNCH10"/);
  assert.match(html, /Total before shipping\/tax<\/span><strong>\$140/);
});

test('an opened disclosure or an error keeps the entry expanded; collapsing keeps the typed code', () => {
  assert.equal(discountEntryExpanded({}), false);
  assert.equal(discountEntryExpanded({ expanded: true }), true);
  assert.equal(discountEntryExpanded({ error: true }), true);
  assert.equal(discountEntryExpanded({ busy: true }), false);
  const value = cart([glove()], 155);
  const opened = renderDiscountEntry({ id: 'gid://cart/1', ...value }, { expanded: true }, escapeHtml);
  assert.match(opened, /aria-expanded="true"/);
  assert.doesNotMatch(opened, /data-discount-form hidden/);
  const failed = renderDiscountEntry({ id: 'gid://cart/1', ...value },
    { input: 'NOPE', message: 'Discount code isn’t valid for this cart.', error: true }, escapeHtml);
  assert.match(failed, /aria-expanded="true"/);
  assert.doesNotMatch(failed, /data-discount-form hidden/);
  assert.match(failed, /role="alert">Discount code isn’t valid for this cart\.</);
  const collapsed = renderDiscountEntry({ id: 'gid://cart/1', ...value }, { input: 'SAVE10' }, escapeHtml);
  assert.match(collapsed, /data-discount-form hidden>/);
  assert.match(collapsed, /value="SAVE10"/);
});

test('local mode renders no discount entry, only the subtotal', () => {
  const html = renderCartDiscountSection({ id: null, ...cart([glove()], 155) }, 'local', { expanded: true }, money, escapeHtml);
  assert.doesNotMatch(html, /data-discount-toggle|data-discount-form/);
  assert.match(html, /<span>Subtotal<\/span><strong>\$155<\/strong>/);
});

test('cart drawer wires the disclosure without re-rendering and falls back to the toggle for focus', () => {
  const mainSource = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(mainSource, /expanded: discountExpanded, announceOnly: discountAnnounceOnly \}/);
  assert.match(mainSource, /discountForm\.hidden = !discountExpanded;/);
  assert.match(mainSource, /input\?\.closest\('\[hidden\]'\) \? document\.querySelector\('\[data-discount-toggle\]'\) : input/);
});

test('Shopify fixture: the disclosure tracks a trainer + Break-In cart through apply, rerender, and removal', async () => {
  const { shopifyFixture } = await import('../test-support/shopify-fixture.js');
  const { checkoutCartIsComplete } = await import('../src/checkout-safety.js');
  const scenario = codes => {
    const launch = codes.some(code => code.toLowerCase() === 'launch10');
    return {
      discountCodes: codes.map(code => ({ code, applicable: code.toLowerCase() === 'launch10' })),
      discountedPrices: launch ? { br16: '140.00' } : {},
      discountAllocations: launch ? { br16: [{ discountedAmount: { amount: '15', currencyCode: 'USD' }, targetType: 'LINE_ITEM', sourceDiscountApplication: { code: 'LAUNCH10' } }] } : {}
    };
  };
  const fixture = shopifyFixture({ discountScenario: scenario });
  await fixture.commerce.listProducts();
  const before = await fixture.commerce.addProduct('black', true, { level: 'Game Ready (90%)', wearingStyle: 'Traditional' });
  const service = () => before.lines.find(line => line.isBreakIn);
  assert.ok(service(), 'Break-In line is paired with the glove');
  assert.equal(checkoutCartIsComplete(before), true);
  const section = (value, state) => renderCartDiscountSection(value, 'shopify', state, money, escapeHtml);
  assert.match(section(before, {}), /aria-expanded="false"[^>]*>Have a discount code\?/);

  const applied = await fixture.commerce.applyDiscountCode('LAUNCH10');
  assert.equal(applied.lines.length, before.lines.length, 'applying a code keeps glove and service lines');
  assert.deepEqual(applied.lines.find(line => line.isBreakIn).attributes, service().attributes);
  assert.equal(checkoutCartIsComplete(applied), true);
  // The opened disclosure survives the drawer rerender that follows an apply.
  const rerendered = section(applied, { expanded: true, message: 'LAUNCH10 applied.' });
  assert.match(rerendered, /aria-expanded="true"/);
  assert.match(rerendered, /LAUNCH10 applied<\/span><button type="button" data-remove-discount="LAUNCH10"/);
  assert.match(rerendered, /Discount \(LAUNCH10\)<\/span><span>−\$15/);
  assert.match(rerendered, /Total before shipping\/tax<\/span><strong>\$160/);
  // Collapsed, the applied code and its Remove control stay reachable.
  assert.match(section(applied, {}), /data-discount-form hidden>[\s\S]*data-remove-discount="LAUNCH10"/);

  const invalid = await fixture.commerce.applyDiscountCode('NOPE');
  assert.match(section(invalid, { error: true, input: 'NOPE', message: 'Discount code isn’t valid for this cart.' }), /aria-expanded="true"[\s\S]*value="NOPE"[\s\S]*role="alert"/);
  assert.equal(invalid.lines.length, before.lines.length);

  await fixture.commerce.removeDiscountCode('NOPE');
  const removed = await fixture.commerce.removeDiscountCode('LAUNCH10');
  assert.deepEqual(removed.discountCodes, []);
  assert.equal(removed.lines.length, before.lines.length, 'removing a code keeps the Break-In service');
  assert.equal(removed.checkoutUrl, before.checkoutUrl);
  assert.equal(checkoutCartIsComplete(removed), true);
  assert.match(section(removed, {}), /<span>Subtotal<\/span><strong>\$175<\/strong>/);
});

test('a successful apply shows one visible "applied" line and keeps the status line for screen readers only', () => {
  const value = { id: 'gid://cart/1', ...cart([glove(1, 155, 0, [allocation(155, 'ANAWINTEST100')])], 0,
    [{ code: 'ANAWINTEST100', applicable: true }]) };
  const html = renderDiscountEntry(value, { expanded: true, message: 'ANAWINTEST100 applied.', announceOnly: true }, escapeHtml);
  assert.equal((html.match(/ANAWINTEST100 applied/g) || []).length, 2, 'row text plus the announcement');
  assert.match(html, /<p id="cart-discount-message" class="cart-discount-message visually-hidden" role="status">ANAWINTEST100 applied\.<\/p>/);
  assert.match(html, /ANAWINTEST100 applied<\/span><button type="button" data-remove-discount="ANAWINTEST100"/);
  // Errors, removals, and Shopify warnings stay visible.
  const failed = renderDiscountEntry(value, { message: 'Discount code isn’t valid for this cart.', error: true, announceOnly: true }, escapeHtml);
  assert.doesNotMatch(failed, /visually-hidden" role="alert"/);
  const removed = renderDiscountEntry({ id: 'gid://cart/1', ...cart([glove()], 155) }, { message: 'Discount code removed.' }, escapeHtml);
  assert.match(removed, /class="cart-discount-message" role="status">Discount code removed\./);
});

test('an open discount entry scrolls the whole drawer so line items keep their height', () => {
  const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.cart-drawer:is\(\.is-editing-service,\.is-discount-open\)\{overflow-y:auto;/);
  assert.match(css, /\.cart-drawer:is\(\.is-editing-service,\.is-discount-open\) \.cart-body\{flex:0 0 auto;overflow:visible\}/);
  assert.match(css, /\.cart-drawer:is\(\.is-editing-service,\.is-discount-open\) \.cart-foot\{flex:0 0 auto;max-height:none;overflow:visible\}/);
  const mainSource = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(mainSource, /discountEntryExpanded\(\{ expanded: discountExpanded, error: discountError \}\) \? ' is-discount-open' : ''/);
  assert.match(mainSource, /classList\.toggle\('is-discount-open', discountExpanded\)/);
});

test('a closing drawer leaves the tab order at once and is hidden after its slide-out', () => {
  const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
  const mainSource = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(css, /\.cart-drawer\[inert\]\{visibility:hidden\}/);
  // The base drawer transition (all properties, .3s) keeps visibility until the slide ends.
  assert.match(css, /\.cart-drawer\{position:fixed;right:0;top:0;width:min\(500px,100%\);[^}]*transform:translateX\(100%\);transition:\.3s;/);
  assert.match(mainSource, /document\.body\.classList\.remove\('cart-open'\);\n[^\n]*\n\s+document\.querySelector\('\.cart-drawer'\)\?\.setAttribute\('inert', ''\);/);
  // A reopened drawer is always freshly rendered, so it never inherits inert.
  assert.match(mainSource, /document\.querySelector\('\.cart-drawer'\)\?\.remove\(\); document\.querySelector\('\.cart-backdrop'\)\?\.remove\(\);\n\s+breakInEditor\.prune/);
});

// Shapes recorded from the authorized test store (anawin-test) on 2026-11-15: Shopify keeps a rejected
// code on the cart and repeats its warning on every later discount update.
const invalidThenValid = {
  invalid: { discountCodes: [{ code: 'BADCODE-P2', applicable: false }], discountWarnings: ['Enter a valid discount code'] },
  valid: { discountCodes: [{ code: 'BADCODE-P2', applicable: false }, { code: 'ANAWINTEST100', applicable: true }], discountWarnings: ['Enter a valid discount code'] },
  removedValid: { discountCodes: [{ code: 'BADCODE-P2', applicable: false }], discountWarnings: ['Enter a valid discount code'] },
  removedInvalid: { discountCodes: [], discountWarnings: [] }
};

test('invalid → valid → remove: success never carries the stale warning and is shown once', () => {
  const invalid = discountResultFeedback(invalidThenValid.invalid, { code: 'BADCODE-P2' });
  assert.deepEqual(invalid, { message: 'Discount code isn’t valid for this cart.', error: true, announceOnly: false, applied: false });

  const valid = discountResultFeedback(invalidThenValid.valid, { code: 'ANAWINTEST100' });
  assert.deepEqual(valid, { message: 'ANAWINTEST100 applied.', error: false, announceOnly: true, applied: true });
  const cartValue = { id: 'gid://cart/1', ...cart([glove(1, 155, 0, [allocation(155, 'ANAWINTEST100')])], 0), ...invalidThenValid.valid };
  const html = renderDiscountEntry(cartValue, { ...valid, expanded: true }, escapeHtml);
  assert.doesNotMatch(html, /Enter a valid discount code/);
  assert.doesNotMatch(html, /aria-invalid/);
  assert.match(html, /class="cart-discount-message visually-hidden" role="status">ANAWINTEST100 applied\.</);
  // The rejected code stays on the Shopify cart, visible with its own labelled Remove.
  assert.match(html, /BADCODE-P2 not applicable<\/span><button type="button" data-remove-discount="BADCODE-P2" aria-label="Remove discount code BADCODE-P2"/);

  assert.deepEqual(discountResultFeedback(invalidThenValid.removedValid, { removingCode: 'ANAWINTEST100' }),
    { message: 'Discount code removed.', error: false, announceOnly: false, applied: false });
  assert.deepEqual(discountResultFeedback(invalidThenValid.removedInvalid, { removingCode: 'BADCODE-P2' }),
    { message: 'Discount code removed.', error: false, announceOnly: false, applied: false });
});

test('warnings with every code applicable stay visible; a failed removal is an error', () => {
  const warned = discountResultFeedback({ discountCodes: [{ code: 'LAUNCH10', applicable: true }], discountWarnings: ['Some discounts were not honored.'] }, { code: 'LAUNCH10' });
  assert.deepEqual(warned, { message: 'LAUNCH10 applied. Some discounts were not honored.', error: false, announceOnly: false, applied: true });
  const stuck = discountResultFeedback({ discountCodes: [{ code: 'LAUNCH10', applicable: true }] }, { removingCode: 'launch10' });
  assert.equal(stuck.error, true);
  assert.match(stuck.message, /could not be removed/);
});

test('an error marks the code field invalid for assistive technology, and only while it lasts', () => {
  const value = { id: 'gid://cart/1', ...cart([glove()], 155) };
  assert.match(renderDiscountEntry(value, { error: true, message: 'Discount code isn’t valid for this cart.' }, escapeHtml), /id="cart-discount-input"[^>]*aria-invalid="true"/);
  assert.doesNotMatch(renderDiscountEntry(value, { message: 'Discount code removed.' }, escapeHtml), /aria-invalid/);
});

test('unrelated cart changes clear discount feedback; discount controls meet 44px targets', () => {
  const mainSource = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(mainSource, /cartBusy = true; cartError = ''; cartGuidance = ''; serviceNotice = null;\n[^\n]*\n\s+discountMessage = ''; discountError = false; discountAnnounceOnly = false;\n\s+openCart\(opener\);/);
  const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.cart-foot \.cart-discount-code button\{[^}]*min-width:44px;min-height:44px/);
  assert.match(css, /\.cart-discount-entry input\{[^}]*height:44px/);
  assert.match(css, /\.cart-foot \.cart-discount-entry form button\{[^}]*height:44px/);
});

test('drawer re-renders restore focus through the shared helpers; a fresh open still starts on Close', () => {
  const mainSource = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(mainSource, /const previousDrawer = cartIsOpen \? document\.querySelector\('\.cart-drawer'\) : null;/);
  assert.match(mainSource, /const target = findCartFocusTarget\(drawer, focusKey\);/);
  assert.match(mainSource, /else document\.querySelector\('\.cart-head \[data-close-cart\]'\)\?\.focus\(\);/);
});

test('correcting a rejected code clears aria-invalid at once but keeps the error text until the next apply', () => {
  const mainSource = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const handler = mainSource.match(/querySelector\('input'\)\?\.addEventListener\('input', event => \{[\s\S]*?\n  \}\);/)[0];
  assert.match(handler, /event\.target\.removeAttribute\('aria-invalid'\);/);
  assert.doesNotMatch(handler, /discountMessage = ''|textContent = ''/);
});

test('the discount section is marked busy only while an update runs', () => {
  const value = { id: 'gid://cart/1', ...cart([glove()], 155) };
  assert.match(renderDiscountEntry(value, { busy: true, expanded: true }, escapeHtml), /<section class="cart-discount-entry" aria-labelledby="discount-toggle" aria-busy="true">/);
  assert.doesNotMatch(renderDiscountEntry(value, { expanded: true }, escapeHtml), /aria-busy/);
  assert.match(renderDiscountEntry(value, { expanded: true }, escapeHtml), /<button type="submit" data-discount-apply >Apply<\/button>/);
});

test('dismissing a discount error clears both its field state and associated explanation', async () => {
  const { dismissDiscountError } = await import('../src/cart-discounts.js');
  const attributes = new Map([['aria-invalid', 'true']]);
  const input = { removeAttribute: name => attributes.delete(name) };
  const classes = new Set(['cart-discount-message', 'cart-error']);
  const message = { textContent: 'Discount code isn’t valid for this cart.', role: 'alert',
    classList: { remove: name => classes.delete(name) }, setAttribute(name, value) { this[name] = value; } };
  dismissDiscountError(input, message);
  assert.equal(attributes.has('aria-invalid'), false);
  assert.equal(message.textContent, '');
  assert.equal(message.role, 'status');
  assert.equal(classes.has('cart-error'), false);
  assert.equal(classes.has('cart-discount-message'), true);
  dismissDiscountError(input, message);
  dismissDiscountError(null, null);
});
