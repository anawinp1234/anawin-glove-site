import test from 'node:test';
import assert from 'node:assert/strict';
import { renderCartRow } from '../src/cart-row.js';

const product = { id: 'blue', name: 'OB16', tone: 'Sky Blue / Royal / Navy', images: ['/images/blue1.PNG'] };
const serviceProduct = { price: 20, currencyCode: 'USD', available: true };
const money = (amount, currency) => new Intl.NumberFormat('en-US', {
  style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 2
}).format(amount);
const escapeHtml = value => String(value).replace(/[&<>'"]/g, character =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
const glove = (quantity, total) => ({ remoteLineId: 'glove-1', quantity,
  lineTotal: { amount: total, currencyCode: 'USD' }, instructions: { canUpdateQuantity: true } });
const service = (quantity, total, currencyCode = 'USD') => ({ parentLineId: 'glove-1', quantity,
  lineTotal: { amount: total, currencyCode }, instructions: { canRemove: true, canUpdateQuantity: true } });
const render = (line, child = null, incomplete = false) => renderCartRow({ product, line, service: child,
  mode: 'shopify', serviceProduct, busy: false, incomplete, money, escapeHtml });

test('cart row places Shopify entry totals in the right price rail', () => {
  for (const [line, child, expected] of [
    [glove(1, 150), null, '$150'],
    [glove(2, 300), null, '$300'],
    [glove(1, 150), service(1, 20), '$170'],
    [glove(2, 300), service(2, 40), '$340']
  ]) {
    const html = render(line, child);
    assert.match(html, new RegExp(`<div class="cart-item-side"><strong class="cart-line-price">\\${expected}</strong>`));
    assert.match(html, /<div class="cart-item-info"><h3>OB16<\/h3><p>Sky Blue \/ Royal \/ Navy<\/p>/);
  }
});

test('cart row price refreshes from confirmed quantity and service line totals', () => {
  assert.match(render(glove(1, 150)), /cart-line-price">\$150/);
  assert.match(render(glove(2, 300)), /cart-line-price">\$300/);
  assert.match(render(glove(2, 300), service(2, 40)), /cart-line-price">\$340/);
  assert.match(render(glove(1, 150), service(1, 20)), /cart-line-price">\$170/);
  assert.match(render(glove(1, 155.5), service(1, 24.25)), /cart-line-price">\$179\.75/);
});

test('quantity greater than one service controls name the one-glove action', () => {
  assert.match(render(glove(2, 300)), />Add break-in to 1 <span>\+\$20<\/span><\/button>/);
  assert.match(render(glove(2, 300), service(2, 40)), />Remove break-in from 1<\/button>/);
  assert.match(render(glove(1, 150)), />Add Break-in service \+\$20<\/button>/);
  assert.match(render(glove(1, 150), service(1, 20)), />Remove break-in<\/button>/);
});

test('cart row refuses a combined total with mismatched currencies', () => {
  const html = render(glove(1, 150), service(1, 20, 'CAD'), true);
  assert.match(html, /cart-line-price">Price unavailable<\/strong>/);
  assert.match(html, /data-remove-service="glove-1"[^>]*disabled/);
});
