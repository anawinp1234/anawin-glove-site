import test from 'node:test';
import assert from 'node:assert/strict';
import { createStickyPurchase, stickyPurchaseVisible } from '../src/sticky-purchase.js';

class EventTargetStub {
  listeners = new Map();
  addEventListener(type, listener) {
    const set = this.listeners.get(type) || new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatch(type) { for (const listener of this.listeners.get(type) || []) listener(); }
}

test('sticky visibility follows the original button and excludes overlays and desktop', () => {
  const ready = { mobile: true, originalVisible: false, purchaseAreaVisible: true,
    cartOpen: false, navOpen: false, overlayOpen: false, keyboardOpen: false };
  assert.equal(stickyPurchaseVisible(ready), true);
  for (const key of ['originalVisible', 'cartOpen', 'navOpen', 'overlayOpen', 'keyboardOpen']) {
    assert.equal(stickyPurchaseVisible({ ...ready, [key]: true }), false, key);
  }
  assert.equal(stickyPurchaseVisible({ ...ready, mobile: false }), false);
  assert.equal(stickyPurchaseVisible({ ...ready, purchaseAreaVisible: false }), false);
});

test('sticky action mirrors price and selection, uses one original click, and cleans up', () => {
  const button = new EventTargetStub();
  button.disabled = false;
  const price = { textContent: '$155' };
  const bar = { hidden: true, querySelector: selector => selector === '[data-sticky-add]' ? button : price };
  const original = { disabled: false, firstChild: { textContent: 'Add to cart ' },
    amount: { textContent: '$155' }, dataset: { add: 'blue' }, service: { checked: true },
    getBoundingClientRect: () => ({ top: 900, bottom: 960 }),
    querySelector: () => original.amount,
    click() { throw new Error('Sticky actions must not synthesize a click on the original button.'); } };
  const purchaseArea = { getBoundingClientRect: () => ({ top: -100, bottom: 1400 }) };
  const nav = { hidden: true };
  const windowRef = new EventTargetStub();
  windowRef.innerHeight = 700;
  windowRef.visualViewport = new EventTargetStub();
  windowRef.visualViewport.height = 700;
  windowRef.visualViewport.offsetTop = 0;
  windowRef.matchMedia = () => ({ matches: true });
  windowRef.requestAnimationFrame = callback => { windowRef.frame = callback; return 1; };
  windowRef.cancelAnimationFrame = () => { windowRef.frame = null; };
  windowRef.flush = () => { const callback = windowRef.frame; windowRef.frame = null; callback?.(); };
  const documentRef = new EventTargetStub();
  documentRef.activeElement = null;
  documentRef.querySelector = () => null;
  let blocked = false;
  const activations = [];
  const controller = createStickyPurchase({ bar, original, purchaseArea, nav,
    windowRef, documentRef, blocked: () => blocked,
    onActivate: (trigger, source) => activations.push({ trigger, product: source.dataset.add, service: source.service.checked }) });
  assert.equal(bar.hidden, false);
  assert.equal(button.textContent, 'ADD TO CART');
  original.amount.textContent = '$175';
  documentRef.dispatch('change');
  windowRef.flush();
  assert.equal(price.textContent, '$175');
  original.disabled = true;
  original.firstChild.textContent = 'Checking availability… ';
  controller.refresh();
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, 'CHECKING AVAILABILITY…');
  original.disabled = false;
  original.firstChild.textContent = 'Add to cart ';
  controller.refresh();
  button.dispatch('click');
  button.dispatch('click');
  assert.deepEqual(activations, [{ trigger: button, product: 'blue', service: true }]);
  blocked = true;
  controller.refresh();
  assert.equal(bar.hidden, true);
  blocked = false;
  nav.hidden = false;
  controller.refresh();
  assert.equal(bar.hidden, true);
  nav.hidden = true;
  documentRef.activeElement = { matches: () => true };
  controller.refresh();
  assert.equal(bar.hidden, true);
  documentRef.activeElement = null;
  windowRef.visualViewport.height = 500;
  controller.refresh();
  assert.equal(bar.hidden, true);
  windowRef.visualViewport.height = 700;
  original.getBoundingClientRect = () => ({ top: 200, bottom: 260 });
  controller.refresh();
  assert.equal(bar.hidden, true);
  original.getBoundingClientRect = () => ({ top: 900, bottom: 960 });
  purchaseArea.getBoundingClientRect = () => ({ top: -100, bottom: 600 });
  controller.refresh();
  assert.equal(bar.hidden, true);
  controller.destroy();
  assert.equal(button.listeners.get('click').size, 0);
  assert.equal(windowRef.listeners.get('scroll').size, 0);
  button.dispatch('click');
  assert.equal(activations.length, 1);

  const nextButton = new EventTargetStub();
  const nextBar = { hidden: true, querySelector: selector => selector === '[data-sticky-add]' ? nextButton : price };
  const nextOriginal = { ...original, dataset: { add: 'brown' }, disabled: false,
    service: { checked: false }, firstChild: { textContent: 'Add to cart ' }, getBoundingClientRect: () => ({ top: 900, bottom: 960 }) };
  const next = createStickyPurchase({ bar: nextBar, original: nextOriginal, purchaseArea, nav,
    windowRef, documentRef, onActivate: (trigger, source) => activations.push({ trigger, product: source.dataset.add, service: false }) });
  nextButton.dispatch('click');
  assert.deepEqual(activations.at(-1), { trigger: nextButton, product: 'brown', service: false });
  next.destroy();
});
