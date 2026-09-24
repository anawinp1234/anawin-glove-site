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
