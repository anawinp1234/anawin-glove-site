import test from 'node:test';
import assert from 'node:assert/strict';
import { JUDGEME_PRODUCT_REVIEW_LINKS, productReviewLinks, validProductReviewLink } from '../src/review-links.js';
import { createStorefrontRenderer, escapeHtml } from '../src/storefront-render.js';
import { localProducts, breakInService } from '../src/catalog.js';

const links = {
  br16: 'https://judge.me/product_reviews/test-uuid/new?id=10332428697848&source=shareable-link',
  ob16: 'https://judge.me/product_reviews/test-uuid/new?id=10334704271608&source=shareable-link',
  cl16: 'https://judge.me/product_reviews/test-uuid/new?id=10334720360696&source=shareable-link'
};
const products = localProducts.map(product => ({ ...product, shopifyProductGid: `gid://shopify/Product/${{
  BR16: '10332428697848', OB16: '10334704271608', CL16: '10334720360696'
}[product.name]}` }));

test('Judge.me admin links map to the matching product page only', () => {
  const configured = productReviewLinks(products, links);
  assert.deepEqual(configured, links);
  assert.deepEqual(productReviewLinks(products), JUDGEME_PRODUCT_REVIEW_LINKS);
  const reviewData = Object.fromEntries(Object.entries(configured).map(([handle, writeReviewUrl]) => [handle, {
    status: 'ready', count: 0, average: null, reviews: [], writeReviewUrl
  }]));
  const renderer = createStorefrontRenderer({ products, breakInService, reviewData });
  for (const [model, url] of Object.entries(links)) {
    const page = renderer.route(`/product/${model}`);
    assert.ok(page.includes(`href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">WRITE A REVIEW`));
    for (const [otherModel, otherUrl] of Object.entries(links)) {
      if (otherModel !== model) assert.ok(!page.includes(escapeHtml(otherUrl)));
    }
  }
});

test('missing or invalid product links hide only that product action', () => {
  const configured = productReviewLinks(products, {
    br16: links.br16,
    ob16: 'https://judge.me/product_reviews/test-uuid/new?id=10334704271608',
    cl16: 'https://example.com/product_reviews/test-uuid/new?id=10334720360696&source=shareable-link'
  });
  assert.equal(configured.br16, links.br16);
  assert.equal(configured.ob16, null);
  assert.equal(configured.cl16, null);
  assert.equal(validProductReviewLink('https://judge.me/product_reviews/uuid/new?id=123&source=shareable-link', '123'), 'https://judge.me/product_reviews/uuid/new?id=123&source=shareable-link');
  assert.equal(validProductReviewLink(links.ob16, '10332428697848'), null);
  assert.equal(validProductReviewLink('https://judge.me/product_reviews/uuid/new?source=shareable-link'), null);
  assert.equal(validProductReviewLink('javascript:alert(1)'), null);
  const reviewData = Object.fromEntries(Object.entries(configured).map(([handle, writeReviewUrl]) => [handle, {
    status: 'unavailable', writeReviewUrl
  }]));
  const renderer = createStorefrontRenderer({ products, breakInService, reviewData });
  assert.match(renderer.route('/product/br16'), /WRITE A REVIEW/);
  assert.doesNotMatch(renderer.route('/product/ob16'), /WRITE A REVIEW/);
  assert.doesNotMatch(renderer.route('/product/cl16'), /WRITE A REVIEW/);
});

test('a link configured under the wrong model is rejected', () => {
  const configured = productReviewLinks(products, { br16: links.ob16, ob16: links.cl16, cl16: links.br16 });
  assert.deepEqual(configured, { br16: null, ob16: null, cl16: null });
  assert.deepEqual(productReviewLinks(localProducts, { br16: links.br16 }), { br16: null, ob16: null, cl16: null });
});
