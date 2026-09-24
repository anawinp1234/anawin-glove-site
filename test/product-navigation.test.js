import test from 'node:test';
import assert from 'node:assert/strict';
import { breakInService, localProducts } from '../src/catalog.js';
import { createStorefrontRenderer } from '../src/storefront-render.js';
import { productPath } from '../src/seo.js';

const renderer = createStorefrontRenderer({ products: localProducts, breakInService });

test('Home and Shop identify three trainer gloves and name each card image link', () => {
  for (const path of ['/', '/shop']) {
    const html = renderer.route(path);
    assert.match(html, /3 trainer gloves/);
    for (const product of localProducts) {
      assert.match(html, new RegExp(`href="${productPath(product)}" data-link class="product-image" aria-label="View ${product.name}:`));
    }
  }
});

test('Each PDP marks its current model and directly links the other two', () => {
  for (const product of localProducts) {
    const html = renderer.route(productPath(product));
    const switcher = html.match(/<nav class="model-switcher"[^]*?<\/nav>/)?.[0];
    assert.ok(switcher, product.name);
    assert.match(switcher, new RegExp(`<span class="model-switcher-current" aria-current="page">${product.name}<small>Current</small></span>`));
    assert.equal((switcher.match(/aria-current="page"/g) || []).length, 1);
    for (const other of localProducts.filter(other => other.id !== product.id)) {
      assert.match(switcher, new RegExp(`<a href="${productPath(other)}" data-link>${other.name}</a>`));
    }
    assert.match(html, /class="other-gloves"/);
  }
});
