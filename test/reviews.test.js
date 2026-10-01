import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorefrontRenderer } from '../src/storefront-render.js';
import { breakInService, localProducts } from '../src/catalog.js';
import { productPath } from '../src/seo.js';
import { customerReviews, productReviewSummary } from '../src/reviews.js';

const renderer = reviews => createStorefrontRenderer({
  products: localProducts,
  breakInService,
  ...(reviews === undefined ? {} : { reviews })
});

// Synthetic fixtures exist only in tests. The storefront review source remains empty.
const fixtures = [
  { id: 'test-br-1', productHandle: 'br16', rating: 5, customer: 'Test BR Customer', verified: true, date: '2026-10-01', title: 'Test title', body: 'Test BR body & details', media: [] },
  { id: 'test-br-2', productHandle: 'br16', rating: 4, customer: 'Second test customer', date: '2026-09-20', body: 'Second BR test body' },
  { id: 'test-ob-1', productHandle: 'ob16', rating: 3, customer: 'Test OB Customer', date: '2026-09-19', body: 'Test OB body' },
  { id: 'test-cl-1', productHandle: 'cl16', rating: 2, customer: 'Test CL Customer', date: '2026-09-18', body: 'Test CL body' }
];

test('empty source has no fake reviews, homepage section, card stars, or review action', () => {
  assert.deepEqual(customerReviews, []);
  const home = renderer().route('/');
  const shop = renderer().route('/shop');
  assert.doesNotMatch(home, /FROM THE<br>|class="reviews"|rating-stars|WRITE A REVIEW/);
  assert.doesNotMatch(shop, /rating-stars|WRITE A REVIEW/);
  for (const product of localProducts) {
    const page = renderer().route(productPath(product));
    assert.match(page, /<h2 id="customer-reviews-heading">CUSTOMER REVIEWS<\/h2>/);
    assert.match(page, /No reviews yet\./);
    assert.match(page, /Be the first to review this glove\./);
    assert.doesNotMatch(page, /rating-stars|0\.0 out of 5|WRITE A REVIEW|customer-review-list/);
  }
});

test('aggregation calculates count, average, distribution, and verified count per model', () => {
  const br = productReviewSummary(fixtures, 'br16');
  assert.equal(br.count, 2);
  assert.equal(br.average, 4.5);
  assert.deepEqual(br.distribution, { 1: 0, 2: 0, 3: 0, 4: 1, 5: 1 });
  assert.equal(br.verifiedCount, 1);
  assert.deepEqual(br.reviews.map(review => review.id), ['test-br-1', 'test-br-2']);
  assert.equal(productReviewSummary(fixtures, 'ob16').average, 3);
  assert.equal(productReviewSummary(fixtures, 'cl16').average, 2);
  const empty = productReviewSummary(fixtures, 'not-a-model');
  assert.equal(empty.count, 0);
  assert.equal(empty.average, null);
  assert.deepEqual(empty.distribution, { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 });
});

test('homepage and shop cards derive compact ratings from the product summary', () => {
  for (const path of ['/', '/shop']) {
    const markup = renderer(fixtures).route(path);
    assert.equal((markup.match(/class="product-card-rating"/g) || []).length, 3);
    assert.match(markup, /aria-label="4\.5 out of 5 stars"/);
    assert.match(markup, /4\.5 \(2\)/);
    assert.match(markup, /3\.0 \(1\)/);
    assert.match(markup, /2\.0 \(1\)/);
    assert.doesNotMatch(markup, /CUSTOMER REVIEWS|Test BR body/);
  }
});

test('each PDP shows only its own reviews and a matching summary and breakdown', () => {
  const br = renderer(fixtures).route('/product/br16');
  assert.match(br, /<h2 id="customer-reviews-heading">CUSTOMER REVIEWS<\/h2>/);
  assert.match(br, /4\.5 <span>out of 5<\/span>/);
  assert.match(br, /Based on 2 reviews/);
  assert.match(br, /aria-label="5 stars: 1 review \(50%\)"/);
  assert.match(br, /aria-label="4 stars: 1 review \(50%\)"/);
  assert.match(br, /aria-label="3 stars: 0 reviews \(0%\)"/);
  assert.match(br, /Test BR body &amp; details/);
  assert.match(br, /Verified purchase/);
  assert.match(br, /<time datetime="2026-10-01">October 1, 2026<\/time>/);
  assert.match(br, /<h3>Test title<\/h3>/);
  assert.doesNotMatch(br, /Test OB body|Test CL body|WRITE A REVIEW/);

  const ob = renderer(fixtures).route('/product/ob16');
  assert.match(ob, /Test OB body/);
  assert.match(ob, /Based on 1 review/);
  assert.doesNotMatch(ob, /Test BR body|Test CL body/);

  const cl = renderer(fixtures).route('/product/cl16');
  assert.match(cl, /Test CL body/);
  assert.doesNotMatch(cl, /Test BR body|Test OB body/);
});

test('optional approved media renders only on its own review', () => {
  const review = { ...fixtures[0], media: [
    { type: 'image', url: '/customer/br-photo.jpg', alt: 'Glove in fielding position' },
    { type: 'video', url: 'https://example.test/customer/br-video.mp4', alt: 'Glove in use' }
  ] };
  const br = renderer([review]).route('/product/br16');
  assert.match(br, /<img src="\/customer\/br-photo\.jpg" alt="Glove in fielding position" loading="lazy">/);
  assert.match(br, /<video controls preload="none" aria-label="Glove in use">/);
  assert.doesNotMatch(renderer([review]).route('/product/ob16'), /customer-review-media/);
});

test('Judge.me summaries drive both views and only a valid Judge.me review link appears', () => {
  const reviewData = {
    br16: { status: 'ready', count: 2, average: 4.5, distribution: { 5: 1, 4: 1, 3: 0, 2: 0, 1: 0 }, reviews: fixtures.slice(0, 2), writeReviewUrl: 'https://judge.me/product_reviews/abc-123/new?id=123&source=shareable-link' },
    ob16: { status: 'ready', count: 0, average: null, reviews: [] },
    cl16: { status: 'unavailable' }
  };
  const storefront = createStorefrontRenderer({ products: localProducts, breakInService, reviewData });
  const home = storefront.route('/');
  assert.equal((home.match(/class="product-card-rating"/g) || []).length, 1);
  assert.match(home, /4\.5 out of 5 stars, based on 2 reviews/);
  const br = storefront.route('/product/br16');
  assert.match(br, /Based on 2 reviews/);
  assert.match(br, /WRITE A REVIEW/);
  assert.match(br, /href="https:\/\/judge\.me\/product_reviews\/abc-123\/new\?id=123&amp;source=shareable-link"/);
  assert.doesNotMatch(storefront.route('/product/ob16'), /rating-stars|WRITE A REVIEW/);
  assert.match(storefront.route('/product/cl16'), /Reviews are temporarily unavailable\./);
  reviewData.br16.writeReviewUrl = 'https://example.com/not-a-review';
  assert.doesNotMatch(storefront.route('/product/br16'), /WRITE A REVIEW/);
});
