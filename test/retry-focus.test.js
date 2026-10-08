import test from 'node:test';
import assert from 'node:assert/strict';
import { focusCommerceRetryResult, focusCommerceRetryStatus } from '../src/retry-focus.js';

const control = (state, hidden = false, disabled = false) => ({
  isConnected: true, hidden, disabled,
  closest: () => hidden ? {} : null,
  focus() { state.focused = this; }
});

test('retry keeps keyboard focus on the visible result or fallback cart control', () => {
  const state = {};
  const retry = control(state);
  const add = control(state);
  const cart = control(state);
  const entries = { '[data-retry-commerce]': retry, '[data-add]:not(:disabled)': add, '.cart-trigger': cart };
  const root = { querySelector: selector => entries[selector] || null };
  assert.equal(focusCommerceRetryResult(root), true);
  assert.equal(state.focused, retry);
  entries['[data-retry-commerce]'] = null;
  assert.equal(focusCommerceRetryResult(root), true);
  assert.equal(state.focused, add);
  add.hidden = true;
  assert.equal(focusCommerceRetryResult(root), true);
  assert.equal(state.focused, cart);
});

test('retry focuses its loading status while the request runs', () => {
  const state = {};
  const status = control(state);
  const root = { querySelector: () => status };
  assert.equal(focusCommerceRetryStatus(root), true);
  assert.equal(status.tabIndex, -1);
  assert.equal(state.focused, status);
});
