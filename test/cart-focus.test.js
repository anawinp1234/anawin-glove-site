import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cartFocusKey, findCartFocusTarget, isVisibleFocusTarget, restoreFocusWithVisibleFallback, restoreFocusWithoutScroll } from '../src/cart-focus.js';

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

// A minimal element tree: enough selector support for the cart focus helpers.
function node(tag, attributes = {}, children = []) {
  const element = { tag, attributes: { ...attributes }, children, parent: null, disabled: Boolean(attributes.disabled), focused: 0,
    get id() { return this.attributes.id || ''; },
    hasAttribute(name) { return name in this.attributes; },
    getAttribute(name) { return name in this.attributes ? String(this.attributes[name]) : null; },
    matches(selector) {
      return selector.split(',').map(part => part.trim()).some(part => {
        if (part === 'button' || part === 'input') return this.tag === part;
        if (part === 'a[href]') return this.tag === 'a' && this.hasAttribute('href');
        if (part === '[hidden]') return this.hasAttribute('hidden');
        if (part.startsWith('.')) return (this.attributes.class || '').split(' ').includes(part.slice(1));
        return false;
      });
    },
    closest(selector) { for (let current = this; current; current = current.parent) if (current.matches(selector)) return current; return null; },
    contains(other) { for (let current = other; current; current = current.parent) if (current === this) return true; return false; },
    querySelectorAll(selector) {
      const [scope, target] = selector.startsWith('.empty-cart ') ? ['.empty-cart', selector.slice(12)] : [null, selector];
      const found = [];
      const walk = item => { for (const child of item.children) { if (child.matches(target) && (!scope || child.closest(scope))) found.push(child); walk(child); } };
      walk(this);
      return found;
    },
    focus() { this.focused++; }
  };
  children.forEach(child => { child.parent = element; });
  return element;
}
const qty = (lineId, delta, disabled) => node('button', { 'data-qty-line': lineId, 'data-delta': delta, ...(disabled ? { disabled: true } : {}) });
const row = (product, lineId, { service = false, disabled = false } = {}) => node('article', { class: 'cart-item', 'data-product': product }, [
  node('button', { [service ? 'data-remove-service' : 'data-add-service']: lineId, ...(disabled ? { disabled: true } : {}) }),
  qty(lineId, -1, disabled), qty(lineId, 1, disabled), node('button', { 'data-remove-line': lineId, ...(disabled ? { disabled: true } : {}) })
]);
const drawer = rows => node('aside', { class: 'cart-drawer' }, [node('button', { 'data-close-cart': '' }), node('div', { class: 'cart-body' }, rows)]);
const find = (root, attribute, value, delta) => root.querySelectorAll('button').find(element =>
  element.getAttribute(attribute) === value && (delta === undefined || element.getAttribute('data-delta') === delta));

test('a keyboard quantity change keeps focus on the same control through the busy re-render', () => {
  const before = drawer([row('black', 'line-a'), row('blue', 'line-b')]);
  const key = cartFocusKey(find(before, 'data-qty-line', 'line-b', '1'), before);
  const busy = drawer([row('black', 'line-a', { disabled: true }), row('blue', 'line-b', { disabled: true })]);
  assert.equal(findCartFocusTarget(busy, key), null, 'disabled controls are never chosen; the caller holds the key');
  const after = drawer([row('black', 'line-a'), row('blue', 'line-b')]);
  assert.equal(findCartFocusTarget(after, key), find(after, 'data-qty-line', 'line-b', '1'));
  assert.notEqual(findCartFocusTarget(after, key), after.querySelectorAll('button')[0], 'not the Close button');
});

test('a Shopify line ID change from a Break-In split restores the same control in the same glove row', () => {
  const before = drawer([row('black', 'line-a', { service: true })]);
  const key = cartFocusKey(find(before, 'data-qty-line', 'line-a', '-1'), before);
  const after = drawer([row('black', 'line-new-1', { service: true }), row('black', 'line-new-2')]);
  assert.equal(findCartFocusTarget(after, key), find(after, 'data-qty-line', 'line-new-1', '-1'));
});

test('removing Break-In falls back to a control in the same row; removing a row uses its neighbour', () => {
  const before = drawer([row('black', 'line-a', { service: true }), row('blue', 'line-b')]);
  const serviceKey = cartFocusKey(find(before, 'data-remove-service', 'line-a'), before);
  const afterService = drawer([row('black', 'line-a'), row('blue', 'line-b')]);
  assert.equal(findCartFocusTarget(afterService, serviceKey), find(afterService, 'data-add-service', 'line-a'));

  const removeKey = cartFocusKey(find(before, 'data-qty-line', 'line-a', '-1'), before);
  const afterRemoval = drawer([row('blue', 'line-b')]);
  assert.equal(findCartFocusTarget(afterRemoval, removeKey), find(afterRemoval, 'data-qty-line', 'line-b', '-1'));
});

test('emptying the cart moves focus to the empty-cart link; a fresh drawer has no key', () => {
  const before = drawer([row('black', 'line-a')]);
  const key = cartFocusKey(find(before, 'data-remove-line', 'line-a'), before);
  const link = node('a', { href: '/shop', 'data-close-cart': '' });
  const empty = node('aside', { class: 'cart-drawer' }, [node('button', { 'data-close-cart': '' }), node('div', { class: 'empty-cart' }, [link])]);
  assert.equal(findCartFocusTarget(empty, key), link);
  assert.equal(cartFocusKey(null, before), null);
  assert.equal(cartFocusKey(before, before), null, 'focus parked on the drawer itself is not a control');
  assert.equal(findCartFocusTarget(before, null), null);
});

test('a busy discount apply parks focus on the drawer instead of Close, then the code field takes it', () => {
  const apply = node('button', { 'data-discount-apply': '' });
  const before = node('aside', { class: 'cart-drawer' }, [node('button', { 'data-close-cart': '' }), apply]);
  const key = cartFocusKey(apply, before);
  assert.equal(key.kind, 'discount-apply');
  const busy = node('aside', { class: 'cart-drawer' }, [node('button', { 'data-close-cart': '' }), node('button', { 'data-discount-apply': '', disabled: true })]);
  assert.equal(findCartFocusTarget(busy, key), null, 'the caller keeps the key and parks focus on the drawer');
  const mainSource = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(mainSource, /openCart\(null, \{ manageFocus: false \}\);\n\s+focusDiscountEntry\(\);/);
  assert.match(mainSource, /if \(!manageFocus\) \{ pendingCartFocus = null; return; \}/);
});
