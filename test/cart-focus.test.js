import test from 'node:test';
import assert from 'node:assert/strict';
import { isVisibleFocusTarget, restoreFocusWithVisibleFallback, restoreFocusWithoutScroll } from '../src/cart-focus.js';

function environment() {
  const contained = new Set();
  const documentRef = { documentElement: { contains: element => contained.has(element) } };
  const windowRef = { innerHeight: 800, visualViewport: null,
    getComputedStyle: element => element.style || { display: 'block', visibility: 'visible', opacity: '1' } };
  const make = ({ top = 100, bottom = 148, width = 120, connected = true, disabled = false,
    hidden = false, style = null } = {}) => {
    const element = { isConnected: connected, disabled, style, focusCalls: [],
      getBoundingClientRect: () => ({ top, bottom, width, height: bottom - top }),
      closest: () => hidden ? {} : null,
      focus(options) { this.focusCalls.push(options); } };
    if (connected) contained.add(element);
    return element;
  };
  return { documentRef, windowRef, make };
}

test('cart focus returns to the activated sticky or original control without scrolling', () => {
  for (const activated of ['sticky', 'original']) {
    const env = environment();
    const sticky = env.make();
    const original = env.make({ top: 300, bottom: 348 });
    const opener = activated === 'sticky' ? sticky : original;
    const target = restoreFocusWithoutScroll([opener, sticky, original], env);
    assert.equal(target, opener);
    assert.deepEqual(opener.focusCalls, [{ preventScroll: true }]);
  }
});

test('hidden, disabled, removed, or offscreen sticky controls use a visible fallback', () => {
  const env = environment();
  const sticky = env.make({ hidden: true });
  const original = env.make({ top: 900, bottom: 948 });
  const cart = env.make({ top: 20, bottom: 68 });
  assert.equal(restoreFocusWithoutScroll([sticky, original, cart], env), cart);
  assert.equal(isVisibleFocusTarget(env.make({ disabled: true }), env), false);
  assert.equal(isVisibleFocusTarget(env.make({ connected: false }), env), false);
  assert.equal(isVisibleFocusTarget(env.make({ style: { display: 'none', visibility: 'visible', opacity: '1' } }), env), false);
  assert.equal(isVisibleFocusTarget(env.make({ top: 900, bottom: 948 }), env), false);
  assert.deepEqual(cart.focusCalls, [{ preventScroll: true }]);
});

test('cart focus reveals the fallback header only when every return control is unavailable', () => {
  const env = environment();
  const unavailable = env.make({ hidden: true });
  const headerCart = env.make({ top: -90, bottom: -42 });
  let revealed = false;
  headerCart.getBoundingClientRect = () => revealed
    ? { top: 20, bottom: 68, width: 80, height: 48 }
    : { top: -90, bottom: -42, width: 80, height: 48 };
  const target = restoreFocusWithVisibleFallback([unavailable, headerCart], [headerCart], () => { revealed = true; }, env);
  assert.equal(target, headerCart);
  assert.deepEqual(headerCart.focusCalls, [{ preventScroll: true }]);
});
