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
    assert.deepEqual([...html.matchAll(/<article class="product-card[^>]*data-product="([^"]+)"/g)].map(match => match[1]), ['brown', 'blue', 'black']);
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
    assert.deepEqual([...switcher.matchAll(/(?:model-switcher-current"[^>]*>|data-link>)(OB16|CL16|BR16)/g)].map(match => match[1]), ['CL16', 'OB16', 'BR16']);
    assert.match(switcher, new RegExp(`<span class="model-switcher-current" aria-current="page">${product.name}<small>Current</small></span>`));
    assert.equal((switcher.match(/aria-current="page"/g) || []).length, 1);
    for (const other of localProducts.filter(other => other.id !== product.id)) {
      assert.match(switcher, new RegExp(`<a href="${productPath(other)}" data-link>${other.name}</a>`));
    }
    const others = html.match(/<section class="other-gloves"[^]*?<\/section>/)?.[0];
    assert.ok(others, product.name);
    assert.deepEqual([...others.matchAll(/class="other-glove-meta"><strong>(OB16|CL16|BR16)<\/strong>/g)].map(match => match[1]), localProducts.filter(other => other.id !== product.id).map(other => other.name));
  }
});
