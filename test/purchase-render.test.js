import test from 'node:test';
import assert from 'node:assert/strict';
import { breakInService, localProducts } from '../src/catalog.js';
import { createStorefrontRenderer } from '../src/storefront-render.js';
import { productPath } from '../src/seo.js';

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

test('Shipping Policy lists all five destinations without fixed international rates', () => {
  const html = createStorefrontRenderer({ products: localProducts, breakInService }).route('/shipping');
  assert.match(html, /We currently ship to the United States, Canada, Australia, Japan, and South Korea\./);
  assert.match(html, /<section><h2>United States<\/h2><p>Standard Shipping — FREE<\/p><\/section>/);
  assert.match(html, /<section><h2>Canada, Australia, Japan &amp; South Korea<\/h2><p>International shipping rates and available services are calculated at checkout based on destination and shipping method\.<\/p><\/section>/);
  assert.doesNotMatch(html, /\$\d+|Express Shipping —/);
  assert.match(html, /Orders without Break-In Service are processed within 1–3 business days\./);
  assert.match(html, /Orders that include Break-In Service require an additional 2–5 business days of processing before shipment\./);
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
    assert.match(accordion, /International shipping is available to Canada, Australia, Japan, and South Korea\./);
    assert.match(accordion, /International rates are calculated at checkout\./);
    assert.match(accordion, /Orders process in 1–3 business days; Break-In Service adds 2–5 business days\./);
    assert.match(accordion, /U\.S\. standard delivery is typically 3–7 business days after shipment\./);
    assert.match(accordion, /Eligible returns are accepted within 30 days of delivery\./);
    assert.match(accordion, /Prepaid return labels are provided for eligible U\.S\. returns\./);
  }
});
