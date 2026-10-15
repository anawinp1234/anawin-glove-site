import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { bindCartImageFallbacks, renderCartRow } from '../src/cart-row.js';
import { localProducts } from '../src/catalog.js';

const product = { id: 'blue', name: 'OB16', tone: 'Baby Blue / Royal / Navy', images: ['/images/blue1.PNG'] };
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
    [glove(1, 155), null, '$155'],
    [glove(2, 310), null, '$310'],
    [glove(1, 155), service(1, 20), '$175'],
    [glove(2, 310), service(2, 40), '$350']
  ]) {
    const html = render(line, child);
    assert.match(html, new RegExp(`<div class="cart-item-side"><strong class="cart-line-price">\\${expected}</strong>`));
    assert.match(html, /<div class="cart-item-info"><h3>OB16<\/h3><p>Baby Blue \/ Royal \/ Navy<\/p>/);
  }
});

test('cart row price refreshes from confirmed quantity and service line totals', () => {
  assert.match(render(glove(1, 155)), /cart-line-price">\$155/);
  assert.match(render(glove(2, 310)), /cart-line-price">\$310/);
  assert.match(render(glove(2, 310), service(2, 40)), /cart-line-price">\$350/);
  assert.match(render(glove(1, 155), service(1, 20)), /cart-line-price">\$175/);
  assert.match(render(glove(1, 155.5), service(1, 24.25)), /cart-line-price">\$179\.75/);
});

test('quantity greater than one service controls name the one-glove action', () => {
  assert.match(render(glove(2, 310)), />Add break-in to 1 <span>\+\$20<\/span><\/button>/);
  assert.match(render(glove(2, 310), service(2, 40)), />Remove break-in from 1<\/button>/);
  assert.match(render(glove(1, 155)), />Add Break-in service \+\$20<\/button>/);
  assert.match(render(glove(1, 155), service(1, 20)), />Remove break-in<\/button>/);
});

test('quantity controls are clearly labeled and disabled while cart changes are pending', () => {
  const line = glove(10, 1550);
  const html = renderCartRow({ product, line, service: null, mode: 'shopify', serviceProduct,
    busy: true, incomplete: false, money, escapeHtml });
  assert.match(html, /aria-label="Decrease OB16 quantity"[^>]*disabled/);
  assert.match(html, /aria-label="Increase OB16 quantity"[^>]*disabled/);
  assert.match(html, /<span>10<\/span>/);
});

test('cart row refuses a combined total with mismatched currencies', () => {
  const html = render(glove(1, 155), service(1, 20, 'CAD'), true);
  assert.match(html, /cart-line-price">Price unavailable<\/strong>/);
  assert.match(html, /data-remove-service="glove-1"[^>]*disabled/);
});

test('cart row shows escaped Shopify service preferences only while service is present', () => {
  const child = { ...service(1, 20), attributes: [
    { key: 'Break-In Level', value: 'Game Ready (90%)' },
    { key: 'Glove Wearing Style', value: 'Two in the Pinky (TIP)' }
  ] };
  const html = render(glove(1, 155), child);
  assert.match(html, /Break-In Level: Game Ready \(90%\)/);
  assert.match(html, /Glove Wearing Style: Two in the Pinky \(TIP\)/);
  assert.doesNotMatch(render(glove(1, 155)), /Break-In Level:/);
});

for (const [model, original, optimized] of [
  ['BR16', '/images/black1.PNG', '/images/optimized/black1-480.webp'],
  ['OB16', '/images/blue1.PNG', '/images/optimized/blue1-480.webp'],
  ['CL16', '/images/brown1.PNG', '/images/optimized/brown1-480.webp']
]) {
  for (const serviced of [false, true]) {
    test(`${model} ${serviced ? 'serviced' : 'unserviced'} cart entry uses its matching thumbnail and original fallback`, async () => {
      const item = localProducts.find(item => item.name === model);
      const html = renderCartRow({ product: item, line: glove(1, 155), service: serviced ? service(1, 20) : null,
        mode: 'shopify', serviceProduct, busy: false, incomplete: false, money, escapeHtml });
      assert.ok(html.includes(`<img src="${optimized}" data-cart-image-fallback="${original}" alt="${model} glove in ${item.tone}">`));
      assert.match(html, /data-qty-line="glove-1" data-delta="-1"/);
      assert.match(html, /data-qty-line="glove-1" data-delta="1"/);
      assert.match(html, /class="remove" data-remove-line="glove-1"/);
      assert.ok(html.includes(`class="cart-line-price">${serviced ? '$175' : '$155'}</strong>`));
      assert.equal(item.images[0], original);
      await access(new URL(`../public${optimized}`, import.meta.url));
      await access(new URL(`../public${original}`, import.meta.url));
    });
  }
}

test('an unmapped cart photo retains its original URL instead of guessing a thumbnail', () => {
  const html = renderCartRow({ product: { ...product, images: ['/images/new-photo.png'] }, line: glove(1, 155),
    mode: 'shopify', serviceProduct, busy: false, incomplete: false, money, escapeHtml });
  assert.match(html, /<img src="\/images\/new-photo.png" alt="OB16 glove in Baby Blue \/ Royal \/ Navy">/);
  assert.doesNotMatch(html, /data-cart-image-fallback/);
});

test('cart thumbnail alternative text and original image URLs are escaped', () => {
  const html = renderCartRow({ product: { ...product, name: 'OB16 "Special"', tone: 'Blue & Navy', images: ['/images/a"b.png'] },
    line: glove(1, 155), mode: 'shopify', serviceProduct, busy: false, incomplete: false, money, escapeHtml });
  assert.match(html, /src="\/images\/a&quot;b.png"/);
  assert.match(html, /alt="OB16 &quot;Special&quot; glove in Blue &amp; Navy"/);
});

test('a failed optimized thumbnail retries the original only once', () => {
  const image = new EventTarget();
  image.src = '/images/optimized/blue1-480.webp';
  const attributes = new Map([['data-cart-image-fallback', '/images/blue1.PNG']]);
  image.getAttribute = name => attributes.get(name);
  image.removeAttribute = name => attributes.delete(name);
  bindCartImageFallbacks({ querySelectorAll: () => [image] });
  image.dispatchEvent(new Event('error'));
  assert.equal(image.src, '/images/blue1.PNG');
  assert.equal(attributes.has('data-cart-image-fallback'), false);
  image.src = '/images/original-also-failed.PNG';
  image.dispatchEvent(new Event('error'));
  assert.equal(image.src, '/images/original-also-failed.PNG');
});
