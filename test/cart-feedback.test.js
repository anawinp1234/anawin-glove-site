import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cartFeedbackMarkup, cartUpdateAnnouncement, createCartAnnouncer } from '../src/cart-feedback.js';
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

const glove = (productId, quantity, extra = {}) => ({ productId, quantity, isBreakIn: false, ...extra });
const service = (productId, quantity) => ({ productId, quantity, isBreakIn: true });
const names = { black: 'BR-16', blue: 'OB-16' };
const announce = (before, after) => cartUpdateAnnouncement({ lines: before }, { lines: after }, id => names[id]);

test('confirmed cart changes produce one concise sentence', () => {
  assert.equal(announce([], [glove('black', 1), service('black', 1)]), 'BR-16 with Break-in service added to cart.');
  assert.equal(announce([glove('black', 1)], [glove('black', 2)]), 'BR-16 quantity 2.');
  // A paired service that moves with its glove is not announced separately.
  assert.equal(announce([glove('black', 1), service('black', 1)], [glove('black', 2), service('black', 2)]), 'BR-16 quantity 2.');
  assert.equal(announce([glove('black', 1), service('black', 1)], [glove('black', 1)]), 'Break-in service removed from BR-16.');
  // Shopify splits a serviced pair when service is removed from one glove.
  assert.equal(announce([glove('black', 2), service('black', 2)], [glove('black', 1), glove('black', 1), service('black', 1)]), 'Break-in service removed from 1 BR-16.');
  assert.equal(announce([glove('black', 1), glove('blue', 1)], [glove('blue', 1)]), 'BR-16 removed from cart.');
  assert.equal(announce([glove('black', 1), service('black', 1)], []), 'BR-16 removed from cart. Your cart is empty.');
  assert.equal(announce([glove('black', 1)], [glove('black', 1)]), '', 'a no-op refresh says nothing');
});

function fakeDocument() {
  const make = tag => ({ tag, attributes: {}, textContent: '', className: '', parent: null,
    setAttribute(name, value) { this.attributes[name] = value; },
    get isConnected() { for (let node = this; node; node = node.parent) if (node === documentRef.body) return true; return false; },
    appendChild(child) { child.parent = this; return child; } });
  const documentRef = { body: null, createElement: make };
  documentRef.body = make('body');
  return documentRef;
}
function manualTimers() {
  const pending = new Map(); let next = 1;
  return { setTimer(fn) { const id = next++; pending.set(id, fn); return id; }, clearTimer(id) { pending.delete(id); },
    flush() { const fns = [...pending.values()]; pending.clear(); fns.forEach(fn => fn()); }, get size() { return pending.size; } };
}

test('one polite status region survives drawer re-renders and announces only the latest result', () => {
  const documentRef = fakeDocument();
  const timers = manualTimers();
  const announcer = createCartAnnouncer({ documentRef, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  const drawer = () => { const element = documentRef.createElement('aside'); documentRef.body.appendChild(element); return element; };
  const first = drawer();
  announcer.attach(first);
  announcer.announce('BR-16 quantity 2.');
  // The drawer is replaced before the text lands; the same node moves into the new drawer.
  const second = drawer();
  first.parent = null;
  let region = null;
  const adopt = second.appendChild.bind(second);
  second.appendChild = child => { region = child; return adopt(child); };
  announcer.attach(second);
  timers.flush();
  assert.equal(region.parent, second);
  assert.deepEqual([region.attributes.role, region.attributes['aria-live'], region.attributes['aria-atomic'], region.className],
    ['status', 'polite', 'true', 'visually-hidden']);
  assert.equal(region.textContent, 'BR-16 quantity 2.');

  // Rapid updates: a newer sentence replaces a pending one; text is cleared first so a repeat is re-announced.
  announcer.announce('BR-16 quantity 3.');
  assert.equal(region.textContent, '');
  announcer.announce('BR-16 quantity 4.');
  assert.equal(timers.size, 1);
  timers.flush();
  assert.equal(region.textContent, 'BR-16 quantity 4.');
  announcer.announce('');
  assert.equal(region.textContent, '', 'starting a new update clears stale text');
  assert.equal(timers.size, 0);

  // If its drawer was removed, the region returns to the body instead of announcing from a detached node.
  second.parent = null;
  announcer.announce('Your cart is empty.');
  assert.equal(region.isConnected, true);
});

test('the cart announces only confirmed results and marks its item list busy during updates', () => {
  const mainSource = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(mainSource, /if \(outcome\.status === 'ok' && !cart\.incomplete && kind !== 'recovery' && kind !== 'break-in'\) \{\s+cartAnnouncer\.announce\(cartUpdateAnnouncement\(before, cart,/);
  assert.match(mainSource, /const before = cart;\n\s+cartAnnouncer\.announce\(''\);/);
  assert.match(mainSource, /cartAnnouncer\.attach\(drawer\);/);
  assert.match(mainSource, /<div class="cart-body"\$\{cartBusy \? ' aria-busy="true"' : ''\}>/);
});

test('a cart error alerts once; re-renders show it without re-announcing, and routine guidance is a status', () => {
  const first = cartFeedbackMarkup({ error: 'No more CL-16 available right now. Your cart still has 15.', mode: 'shopify' }, escapeHtml);
  assert.match(first, /<p class="cart-error" role="alert">No more CL-16 available right now\. Your cart still has 15\.<\/p>/);
  const again = cartFeedbackMarkup({ error: 'No more CL-16 available right now. Your cart still has 15.', mode: 'shopify', announce: false }, escapeHtml);
  assert.match(again, /<p class="cart-error">No more CL-16/);
  assert.doesNotMatch(again, /role="alert"/);
  const guidance = cartFeedbackMarkup({ guidance: 'Review the items in your new cart before checkout.', mode: 'shopify' }, escapeHtml);
  assert.equal(guidance, '<div class="cart-feedback"><p class="cart-guidance" role="status">Review the items in your new cart before checkout.</p></div>');
  const mainSource = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(mainSource, /announce: feedbackText !== announcedCartFeedback,/);
  assert.match(mainSource, /cartGuidance = 'Review the items in your new cart before checkout\.';/);
});

test('moving the status region into a new drawer never replays text it already delivered', () => {
  const documentRef = fakeDocument();
  const timers = manualTimers();
  const announcer = createCartAnnouncer({ documentRef, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  let region = null;
  const drawer = () => {
    const element = documentRef.createElement('aside'); documentRef.body.appendChild(element);
    const adopt = element.appendChild.bind(element);
    element.appendChild = child => { region = child; child.parentNode = element; return adopt(child); };
    return element;
  };
  announcer.attach(drawer());
  announcer.announce('BR-16 quantity 2.');
  timers.flush();
  assert.equal(region.textContent, 'BR-16 quantity 2.');
  announcer.attach(drawer());
  assert.equal(region.textContent, '', 'delivered text is cleared before the move');
  // A pending announcement survives the move and still lands once.
  announcer.announce('BR-16 quantity 3.');
  announcer.attach(drawer());
  timers.flush();
  assert.equal(region.textContent, 'BR-16 quantity 3.');
});

test('a cart frozen for checkout explains why it can’t change and offers a new cart', () => {
  const html = cartFeedbackMarkup({ incomplete: true, recoveryAvailable: true, recoveryHasBreakIn: true,
    checkoutStarted: true, mode: 'shopify' }, escapeHtml);
  assert.match(html, /role="alert">Secure checkout was started for this cart, so it can’t be changed here\. If checkout didn’t open, continue with your items in a new cart\./);
  assert.match(html, /data-recover-cart/);
  assert.match(html, /data-recover-without-service/);
  assert.match(html, /data-refresh-cart/);
  // A recovery or connection error still takes precedence over the explanation.
  assert.match(cartFeedbackMarkup({ error: 'Couldn’t check your cart.', incomplete: true, checkoutStarted: true, mode: 'shopify' }, escapeHtml),
    /role="alert">Couldn’t check your cart\.</);
});

test('a page left active after a checkout handoff stays busy, then shows the frozen cart from Shopify', () => {
  const mainSource = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const handler = mainSource.slice(mainSource.indexOf("document.querySelector('[data-checkout]')?.addEventListener"));
  // Navigation is not success: the busy state is kept and the watcher armed before returning.
  assert.match(handler, /if \(result\.status === 'navigating'\) \{\n[^}]*checkoutHandoff\.start\(\);[\s\S]*?return;\n\s+\}\n\s+checkoutBusy = false;/);
  const frozen = mainSource.slice(mainSource.indexOf('async function showFrozenCheckout'), mainSource.indexOf('function bind()'));
  assert.match(frozen, /cart = await commerce\.getCart\(\);/);
  assert.match(frozen, /cart = \{ \.\.\.cart, checkoutUrl: null, incomplete: true \};/);
  assert.match(frozen, /checkoutBusy = false;/);
  assert.doesNotMatch(frozen, /recoverCart|clearUnsafe|removeItem|checkout\(/, 'showing the frozen cart never lifts the freeze');
  assert.match(frozen, /\(document\.querySelector\('\[data-recover-cart\]'\) \|\| document\.querySelector\('\[data-refresh-cart\]'\)\)\?\.focus\(\);/);
  // One watcher for the page; a reopened drawer during the handoff is still not actionable.
  assert.equal(mainSource.match(/createCheckoutHandoffWatcher\(/g).length, 1);
  assert.match(mainSource, /<button data-checkout \$\{cartBusy \|\| checkoutBusy \? 'disabled' : ''\}\$\{checkoutBusy \? ' aria-busy="true"' : ''\}>\$\{checkoutHandoff\.pending \? 'Opening checkout…'/);
  assert.match(mainSource, /checkoutStarted: checkoutStarted\(\),/);
});
