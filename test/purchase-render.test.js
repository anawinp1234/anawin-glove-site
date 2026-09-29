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
    assert.match(loading, /disabled>Checking availability… <span data-add-price>\$150/);

    const error = renderProduct(product, { commerceError: 'Inventory connection failed.' });
    assert.match(error, /data-break-in[^>]* disabled/);
    assert.match(error, /class="purchase-status purchase-status-error">Unable to confirm availability/);
    assert.match(error, /disabled>Unavailable <span data-add-price>\$150/);

    const ready = renderProduct(product);
    assert.doesNotMatch(ready, /data-break-in[^>]* disabled/);
    assert.match(ready, /\+\$20/);
    assert.match(ready, />Add to cart <span data-add-price>\$150/);
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

test('Shipping Policy states the confirmed U.S. rate, threshold, and delivery timing', () => {
  const html = createStorefrontRenderer({ products: localProducts, breakInService }).route('/shipping');
  assert.match(html, /Standard shipping within the United States is \$9\. Standard shipping is free on orders \$225 or more\./);
  assert.match(html, /Orders without Break-In Service are processed within 1–3 business days\./);
  assert.match(html, /Orders that include Break-In Service require an additional 2–5 business days of processing before shipment\./);
  assert.match(html, /After an order ships, estimated delivery is typically 3–7 business days\./);
  assert.doesNotMatch(html, /shipping costs are calculated at checkout/i);
});

test('all PDP shipping accordions retain timing and returns with the confirmed rates', () => {
  for (const product of localProducts) {
    const html = renderProduct(product);
    const accordion = html.match(/<details><summary>Shipping & returns .*?<\/details>/)?.[0];
    assert.ok(accordion, product.name);
    assert.match(accordion, /Standard orders process in 1–3 business days\. Break-In Service adds 2–5 business days\./);
    assert.match(accordion, /Standard shipping within the United States is \$9\. Standard shipping is free on orders \$225 or more\./);
    assert.match(accordion, /Estimated delivery is 3–7 business days after shipment\./);
    assert.match(accordion, /Eligible returns are accepted within 30 days of delivery, and ANAWIN provides a prepaid return label\./);
    assert.doesNotMatch(accordion, /shipping is calculated at checkout/i);
  }
});
