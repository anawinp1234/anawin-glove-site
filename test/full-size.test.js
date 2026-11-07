import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { breakInService, fullSizeProducts, localProducts } from '../src/catalog.js';
import { createStorefrontRenderer } from '../src/storefront-render.js';
import { productPath } from '../src/seo.js';

const renderer = createStorefrontRenderer({ products: localProducts, breakInService });
const publicFile = path => new URL(`../public${path}`, import.meta.url);

test('full-size gloves stay out of the purchasable catalog', () => {
  assert.deepEqual(fullSizeProducts.map(product => product.color), ['mint', 'black', 'camel', 'orange']);
  for (const product of fullSizeProducts) {
    assert.equal(product.comingSoon, true);
    assert.ok(!localProducts.some(local => local.id === product.id));
    assert.equal(productPath(product), `/full-size/${product.color}`);
  }
});

test('every full-size photo and its WebP sizes exist', () => {
  for (const product of fullSizeProducts) {
    assert.equal(product.images.length, 4, product.name);
    for (const image of product.images) {
      assert.ok(existsSync(publicFile(image.src)), image.src);
      for (const width of [480, 960].filter(width => width < image.width).concat(image.width)) {
        assert.ok(existsSync(publicFile(`/images/full-size/${image.name}-${width}.webp`)), `${image.name}-${width}`);
      }
    }
  }
});

test('Home and Shop show a full-size section with every colorway', () => {
  for (const path of ['/', '/shop']) {
    const html = renderer.route(path);
    assert.match(html, /FULL-SIZE<br><em>GLOVES<\/em>|FULL-SIZE GLOVES/);
    assert.deepEqual([...html.matchAll(/<article class="product-card full-size-card[^>]*data-product="([^"]+)"/g)].map(match => match[1]),
      fullSizeProducts.map(product => product.id));
    assert.equal((html.match(/Coming soon<\/strong>/g) || []).length, fullSizeProducts.length);
  }
});

test('each full-size page shows four photos, all colorways, and a notify form instead of a cart button', () => {
  for (const product of fullSizeProducts) {
    const html = renderer.route(productPath(product));
    assert.equal((html.match(/class="gallery-image"/g) || []).length, 4, product.name);
    assert.match(html, new RegExp(`<h1>${product.name}</h1>`));
    assert.match(html, new RegExp(`aria-current="page" data-product="${product.id}"`));
    for (const other of fullSizeProducts.filter(other => other.id !== product.id)) {
      assert.match(html, new RegExp(`<a href="${productPath(other)}" data-link data-product="${other.id}">${other.name}</a>`));
    }
    assert.match(html, /class="pdp-notify"/);
    assert.match(html, new RegExp(`id="notify-${product.color}-email"`));
    assert.doesNotMatch(html, /data-add=|data-sticky-purchase|data-break-in/);
    assert.equal((html.match(/<h1\b/g) || []).length, 1);
  }
});
