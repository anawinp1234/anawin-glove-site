import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLocalCommerce } from '../src/commerce.js';
import { createJudgeMeService, judgeMeWidgetUrl, parseJudgeMeBadge, parseJudgeMeReviews, parseJudgeMeWidget, shopifyProductId } from '../src/judgeme.js';

const products = [
  { name: 'BR16', shopifyProductGid: 'gid://shopify/Product/111' },
  { name: 'OB16', shopifyProductGid: 'gid://shopify/Product/222' },
  { name: 'CL16', shopifyProductGid: 'gid://shopify/Product/333' }
];
const badgePayload = (id, average, count) => ({ product_external_id: Number(id), badge: `<div class="jdgm-prev-badge" data-average-rating="${average}" data-number-of-reviews="${count}"></div>` });
const parseBadgeHtml = html => {
  const average = /data-average-rating="([^"]+)"/.exec(html)?.[1];
  const count = /data-number-of-reviews="([^"]+)"/.exec(html)?.[1];
  return { querySelector: () => average && count ? { getAttribute: key => key === 'data-average-rating' ? average : count } : null };
};

test('public Widget API URL uses numeric Shopify ID and only the public token', () => {
  assert.equal(shopifyProductId('gid://shopify/Product/1234567890'), '1234567890');
  for (const bad of ['gid://shopify/ProductVariant/123', 'gid://shopify/Product/br16', 'gid://shopify/Product/0', '123', null]) assert.equal(shopifyProductId(bad), null);
  const url = new URL(judgeMeWidgetUrl({ publicToken: 'test-public', productId: '111', widget: 'preview_badge' }));
  assert.equal(url.origin, 'https://cdn.judge.me');
  assert.equal(url.pathname, '/api/v1/widgets/preview_badge');
  assert.equal(url.searchParams.get('shop_domain'), 'ignvv0-zh.myshopify.com');
  assert.equal(url.searchParams.get('api_token'), 'test-public');
  assert.equal(url.searchParams.get('external_id'), '111');
  assert.equal(url.searchParams.has('json_request'), false);
  const reviewUrl = new URL(judgeMeWidgetUrl({ publicToken: 'test-public', productId: '111', widget: 'product_review', page: 2 }));
  assert.equal(reviewUrl.searchParams.get('json_request'), 'true');
  assert.equal(reviewUrl.searchParams.get('page'), '2');
  assert.equal(judgeMeWidgetUrl({ publicToken: 'test-public', productId: 'bad', widget: 'preview_badge' }), null);
  const clientSource = ['src/judgeme.js', 'src/main.js', 'src/reviews.js'].map(file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')).join('\n');
  assert.doesNotMatch(clientSource, /JUDGEME_PRIVATE|VITE_.*ADMIN|api\.judge\.me\/api\/v1\/reviews/);
});

test('missing token, network failure, and malformed badge responses stay unavailable', async () => {
  let calls = 0;
  const missing = createJudgeMeService({ publicToken: '', fetchImpl: () => { calls++; } });
  assert.deepEqual(await missing.load(products), { status: 'unavailable', products: {} });
  assert.equal(calls, 0);
  const failing = createJudgeMeService({ publicToken: 'test-public', fetchImpl: async () => { throw new Error('offline'); } });
  const failed = await failing.load(products);
  assert.equal(failed.products.br16.status, 'unavailable');
  assert.equal(failed.products.ob16.status, 'unavailable');
  assert.equal(failed.products.cl16.status, 'unavailable');
  const malformed = createJudgeMeService({ publicToken: 'test-public', parseHtml: parseBadgeHtml, fetchImpl: async () => ({ ok: true, json: async () => ({ badge: '<div>bad</div>' }) }) });
  assert.equal((await malformed.load(products)).products.br16.status, 'unavailable');
});

test('live response shape preserves BR16, OB16, and CL16 rating isolation and dedupes requests', async () => {
  const requests = [];
  const service = createJudgeMeService({ publicToken: 'test-public', parseHtml: parseBadgeHtml, fetchImpl: async url => {
    requests.push(url);
    const id = new URL(url).searchParams.get('external_id');
    return { ok: true, json: async () => ({ 111: badgePayload(id, '4.50', 2), 222: badgePayload(id, '3.00', 1), 333: badgePayload(id, '0.00', 0) })[id] };
  } });
  const [first, second] = await Promise.all([service.load(products), service.load(products)]);
  assert.equal(requests.length, 3);
  assert.equal(first.products.br16.average, 4.5);
  assert.equal(first.products.br16.count, 2);
  assert.equal(first.products.ob16.average, 3);
  assert.equal(first.products.ob16.count, 1);
  assert.equal(first.products.cl16.count, 0);
  assert.equal(first.products.cl16.average, null);
  assert.deepEqual(second, first);
  assert.equal(parseJudgeMeBadge(badgePayload('999', 5, 1), '111', parseBadgeHtml), null);
});

test('published review data is normalized without customer email or cross-product reviews', () => {
  const payload = { total_pages: 1, reviews: [
    { id: 1, product_external_id: 111, rating: 5, reviewer: { name: 'Test Customer', email: 'hidden@example.test' }, created_at: '2026-10-01T10:00:00Z', title: 'Test title', body: '<b>Test body</b>', verified: true, pictures: [{ url: '//example.test/photo.jpg' }] },
    { id: 2, product_external_id: 222, rating: 4, reviewer_name: 'Wrong Product', body: 'Wrong body' },
    { id: 3, product_external_id: 111, rating: 3, published: false, body: 'Hidden body' }
  ] };
  const parsed = parseJudgeMeReviews(payload, '111', 'br16');
  assert.equal(parsed.reviews.length, 1);
  assert.equal(parsed.reviews[0].customer, 'Test Customer');
  assert.equal(parsed.reviews[0].date, '2026-10-01');
  assert.equal(parsed.reviews[0].verified, true);
  assert.equal(parsed.reviews[0].media.length, 1);
  assert.equal(parsed.reviews[0].media[0].url, 'https://example.test/photo.jpg');
  assert.doesNotMatch(JSON.stringify(parsed), /hidden@example|Wrong Product|Hidden body/);
  assert.equal(parseJudgeMeReviews({ reviews: 'broken' }, '111', 'br16'), null);
});

test('public widget histogram supplies the five-star distribution without enabling a script-only review action', () => {
  const rows = [5, 4, 3, 2, 1].map(rating => ({ getAttribute: key => key === 'data-rating' ? String(rating) : String(rating >= 4 ? 1 : 0) }));
  const root = {
    querySelector: () => ({ getAttribute: () => '#' }),
    querySelectorAll: selector => selector.startsWith('.jdgm-histogram') ? rows : []
  };
  const parsed = parseJudgeMeWidget({ product_external_id: 111, widget: '<div></div>' }, '111', 2, 'br16', () => root);
  assert.deepEqual(parsed.distribution, { 1: 0, 2: 0, 3: 0, 4: 1, 5: 1 });
  assert.equal(parsed.writeReviewUrl, null);
  assert.deepEqual(parsed.fallbackReviews, []);
  assert.equal(parseJudgeMeWidget({ product_external_id: 222, widget: '<div></div>' }, '111', 2, 'br16', () => root), null);
});

test('Add to Cart remains usable after Judge.me fails', async () => {
  const reviews = createJudgeMeService({ publicToken: 'test-public', fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal((await reviews.load(products)).products.br16.status, 'unavailable');
  const commerce = createLocalCommerce();
  const cart = await commerce.addProduct('black', false);
  assert.equal(cart.lines[0].productId, 'black');
  assert.equal(cart.subtotal, 155);
});
