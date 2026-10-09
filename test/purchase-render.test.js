import test from 'node:test';
import assert from 'node:assert/strict';
import { breakInService, localProducts } from '../src/catalog.js';
import { createStorefrontRenderer } from '../src/storefront-render.js';
import { productPath } from '../src/seo.js';
import { stickyPurchaseAccent } from '../src/sticky-purchase.js';

const renderProduct = (product, state = {}) => createStorefrontRenderer({
  products: localProducts,
  breakInService,
  ...state
}).route(productPath(product));

test('PDPs disable Break-In while inventory loads or fails, then enable it when ready', () => {
  for (const product of localProducts) {
    const loading = renderProduct(product, { commerceLoading: true });
    assert.match(loading, /data-break-in[^>]* disabled/);
    assert.match(loading, /Checking glove and Break-In Service availability/);
    assert.match(loading, /disabled>Checking availability… <span data-add-price>\$155/);

    const error = renderProduct(product, { commerceError: 'Inventory connection failed.' });
    assert.match(error, /data-break-in[^>]* disabled/);
    assert.match(error, /class="purchase-status purchase-status-error">Unable to confirm availability/);
    assert.match(error, /disabled>Unavailable <span data-add-price>\$155/);

    const ready = renderProduct(product);
    assert.doesNotMatch(ready, /data-break-in[^>]* disabled/);
    assert.match(ready, /\+\$20/);
    assert.match(ready, />Add to cart <span data-add-price>\$155/);
  }
});

test('every trainer offers accessible break-in choices above Add to Cart', () => {
  for (const product of localProducts) {
    const html = renderProduct(product);
    assert.ok(html.indexOf('data-break-in-customization') > html.indexOf('data-break-in'));
    assert.ok(html.indexOf('data-break-in-customization') < html.indexOf('class="add-button"'));
    assert.match(html, /data-break-in-customization hidden aria-labelledby="break-in-customization-heading"/);
    assert.match(html, /<fieldset><legend>How broken in do you want your glove\?<\/legend>/);
    assert.match(html, /<fieldset><legend>How do you wear your glove\?<\/legend>/);
    assert.match(html, /name="break-in-level" value="Medium \(65%\)" checked/);
    assert.match(html, /name="glove-wearing-style" value="Traditional" checked/);
    for (const value of ['Firm (40%)', 'Game Ready (90%)', 'Two in the Pinky (TIP)']) {
      assert.ok(html.includes(`value="${value}"`));
    }
    assert.match(html, /Break-in percentages are approximate\. Your glove's final feel develops with use\./);
  }
});

test('mobile purchase bar reuses each glove color and confirmed product price', () => {
  const accents = { black: '#202326', blue: '#2560ae', brown: '#9a622d' };
  for (const product of localProducts) {
    const confirmed = { ...product, price: 163 };
    const html = createStorefrontRenderer({ products: [confirmed], breakInService }).route(productPath(confirmed));
    assert.equal(stickyPurchaseAccent(product), accents[product.id]);
    assert.match(html, new RegExp(`data-sticky-purchase hidden style="--sticky-accent:${accents[product.id]}"`));
    assert.match(html, /data-sticky-price aria-label="Selected price">\$163/);
    assert.match(html, /data-sticky-add aria-label="Add to cart (BR16|OB16|CL16)" >Add to cart/);
  }
});

test('mobile purchase bar mirrors loading, error, and sold-out purchase states', () => {
  const product = localProducts[1];
  const loading = renderProduct(product, { commerceLoading: true });
  assert.match(loading, /data-sticky-price aria-label="Selected price">Checking price…/);
  assert.match(loading, /data-sticky-add aria-label="Checking availability… OB16" disabled/);
  const error = renderProduct(product, { commerceError: 'Shopify failed' });
  assert.match(error, /data-sticky-price aria-label="Selected price">Price unavailable/);
  assert.match(error, /data-sticky-add aria-label="Unavailable OB16" disabled/);
  const soldOut = { ...product, available: false };
  const sold = createStorefrontRenderer({ products: [soldOut], breakInService }).route(productPath(soldOut));
  assert.match(sold, /data-sticky-add aria-label="Sold out OB16" disabled/);
});

test('a failed Shopify product lookup offers a keyboard-accessible retry', () => {
  const renderer = createStorefrontRenderer({ products: localProducts, breakInService,
    commerceError: 'Couldn’t connect to Shopify. Please try again.', commerceRetry: true });
  assert.match(renderer.commerceNotice(), /role="alert"[^>]*>Couldn’t connect to Shopify\. Please try again\. <button type="button" data-retry-commerce>Try again<\/button>/);
});

test('an unavailable Break-In Service disables only its option', () => {
  const html = renderProduct(localProducts[0], { breakInService: { ...breakInService, available: false } });
  assert.match(html, /data-break-in[^>]* disabled/);
  assert.match(html, /Break-In Service is unavailable\./);
  assert.match(html, /data-add="brown" >Add to cart <span data-add-price>\$155/);
});

test('a sold-out glove cannot be added', () => {
  const soldOut = { ...localProducts[0], available: false };
  const html = createStorefrontRenderer({ products: [soldOut, ...localProducts.slice(1)], breakInService }).route(productPath(soldOut));
  assert.match(html, /data-add="brown" disabled>Sold out/);
  assert.match(html, /data-break-in[^>]* disabled/);
});

test('PDPs show price before fixed facts and link purchase policies near the CTA', () => {
  for (const product of localProducts) {
    const html = renderProduct(product);
    const markers = ['<h1>', 'class="product-descriptor"', 'class="price"', 'class="product-pitch"', 'class="pdp-colorway"', 'class="hand-orientation"', 'class="service-option"', 'class="add-button"', 'class="purchase-trust"'];
    const positions = markers.map(marker => html.indexOf(marker));
    assert.ok(positions.every(position => position >= 0), product.name);
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b), product.name);
    for (const path of ['/shipping', '/returns', '/warranty', '/care']) {
      assert.match(html.slice(positions.at(-1)), new RegExp(`href="${path}"`));
    }
  }
});

test('Shipping Policy lists all seven destinations without fixed international rates', () => {
  const html = createStorefrontRenderer({ products: localProducts, breakInService }).route('/shipping');
  assert.match(html, /We currently ship to the United States, Canada, Australia, Japan, South Korea, Mexico, and the Philippines\./);
  assert.match(html, /<section><h2>United States<\/h2><p>Standard Shipping — FREE<\/p><\/section>/);
  assert.match(html, /<section><h2>Canada, Australia, Japan, South Korea, Mexico &amp; the Philippines<\/h2><p>International shipping rates and available services are calculated at checkout based on destination and shipping method\.<\/p><\/section>/);
  assert.doesNotMatch(html, /\$\d+|Express Shipping —/);
  assert.match(html, /Orders are processed within 1–3 business days\./);
  assert.match(html, /Break-In Service adds 2–5 business days\./);
  assert.match(html, /U\.S\. standard shipping is typically delivered in 3–7 business days after shipment\./);
  assert.match(html, /International delivery times vary by destination and shipping service\. Available transit estimates are shown at checkout\./);
  assert.doesNotMatch(html, /International delivery[^<]*3–7 business days/);
  assert.match(html, /Applicable duties, taxes, and import charges are shown at checkout when available\./);
  assert.doesNotMatch(html, /ships? (?:within|to) (?:the )?United States only|ships? to the U\.S\. and Canada\./i);
});

test('all PDP shipping accordions retain timing and returns with the confirmed rates', () => {
  for (const product of localProducts) {
    const html = renderProduct(product);
    const accordion = html.match(/<details><summary>Shipping & returns .*?<\/details>/)?.[0];
    assert.ok(accordion, product.name);
    assert.match(accordion, /Free U\.S\. standard shipping\./);
    assert.match(accordion, /International shipping available to Canada, Australia, Japan, South Korea, Mexico, and the Philippines\./);
    assert.match(accordion, /International rates are calculated at checkout\./);
    assert.match(accordion, /Orders process in 1–3 business days; Break-In Service adds 2–5 business days\./);
    assert.match(accordion, /U\.S\. standard delivery is typically 3–7 business days after shipment\./);
    assert.match(accordion, /Eligible returns are accepted within 30 days of delivery\./);
    assert.match(accordion, /Prepaid return labels are provided for eligible U\.S\. returns\./);
  }
});
