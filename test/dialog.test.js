import test from 'node:test';
import assert from 'node:assert/strict';
import { containTab } from '../src/dialog.js';

function fixture() {
  let focused = null;
  let prevented = false;
  const control = name => ({ name, getClientRects: () => [1], focus() { focused = name; } });
  const first = control('first');
  const last = control('last');
  const dialog = {
    querySelectorAll: () => [first, last],
    contains: element => element === first || element === last
  };
  const event = shiftKey => ({ key: 'Tab', shiftKey, preventDefault() { prevented = true; } });
  return { first, last, dialog, event, result: () => ({ focused, prevented }) };
}

test('Tab wraps from the last dialog control to the first', () => {
  const state = fixture();
  containTab(state.event(false), state.dialog, state.last);
  assert.deepEqual(state.result(), { focused: 'first', prevented: true });
});

test('Shift+Tab wraps from the first dialog control to the last', () => {
  const state = fixture();
  containTab(state.event(true), state.dialog, state.first);
  assert.deepEqual(state.result(), { focused: 'last', prevented: true });
});

test('Tab moves focus into the dialog when focus is outside', () => {
  const state = fixture();
  containTab(state.event(false), state.dialog, {});
  assert.deepEqual(state.result(), { focused: 'first', prevented: true });
});
