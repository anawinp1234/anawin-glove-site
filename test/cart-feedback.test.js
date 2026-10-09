import test from 'node:test';
import assert from 'node:assert/strict';
import { cartFeedbackMarkup } from '../src/cart-feedback.js';
import { createCartActionGate } from '../src/cart-action-gate.js';

const escapeHtml = value => String(value).replace(/[&<>'"]/g, character =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);

test('a failed first addition has an accessible error and a cart check with no items required', () => {
  const html = cartFeedbackMarkup({ error: 'Couldn’t add to cart. Please try again.', mode: 'shopify' }, escapeHtml);
  assert.match(html, /role="alert">Couldn’t add to cart\. Please try again\./);
  assert.match(html, /data-refresh-cart/);
  assert.equal(cartFeedbackMarkup({ mode: 'shopify' }, escapeHtml), '');
});

test('cart feedback escapes Shopify text and disables checks during a request', () => {
  const html = cartFeedbackMarkup({ error: '<failed>', incomplete: true, busy: true, mode: 'shopify' }, escapeHtml);
  assert.match(html, /&lt;failed&gt;/);
  assert.doesNotMatch(html, /<failed>/);
  assert.match(html, /data-refresh-cart disabled/);
});

test('an unresolved mutation offers an explicit verified-cart recovery action', () => {
  const html = cartFeedbackMarkup({ incomplete: true, recoveryAvailable: true, mode: 'shopify' }, escapeHtml);
  assert.match(html, /data-refresh-cart/);
  assert.match(html, /data-recover-cart/);
  assert.match(html, /A pending change may be missing/);
  assert.match(html, /role="alert"/);
});

test('a serviced cart offers an explicit glove-only recovery choice', () => {
  const html = cartFeedbackMarkup({ incomplete: true, recoveryAvailable: true,
    recoveryHasBreakIn: true, mode: 'shopify' }, escapeHtml);
  assert.match(html, /data-recover-without-service/);
  assert.match(html, /Continue without Break-In Service/);
});

test('a legacy service cart offers only the safe glove-only recovery choice', () => {
  const html = cartFeedbackMarkup({ incomplete: true, gloveOnlyRecoveryAvailable: true,
    mode: 'shopify' }, escapeHtml);
  assert.match(html, /data-recover-without-service/);
  assert.doesNotMatch(html, /data-recover-cart/);
});

test('repeated clicks during a pending cart action run only one mutation', async () => {
  let release;
  const gate = createCartActionGate();
  let additions = 0;
  const first = gate(async () => { additions++; await new Promise(resolve => { release = resolve; }); });
  const second = gate(async () => { additions++; });
  assert.equal(await second, false);
  assert.equal(additions, 1);
  release();
  assert.equal(await first, true);
  assert.equal(await gate(async () => { additions++; }), true);
  assert.equal(additions, 2);
});
