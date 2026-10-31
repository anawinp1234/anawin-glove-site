import test from 'node:test';
import assert from 'node:assert/strict';
import { rememberScroll, savedScrollY, scrollToInstant } from '../src/scroll-memory.js';

test('a saved history position is restored only when it is a usable offset', () => {
  assert.equal(savedScrollY({ scrollY: 1840 }), 1840);
  for (const state of [null, undefined, {}, { scrollY: -20 }, { scrollY: Number.NaN }, { scrollY: '900' }, { scrollY: Infinity }]) {
    assert.equal(savedScrollY(state), 0);
  }
});

test('remembering scroll keeps other history state and stores a whole, nonnegative offset', () => {
  const calls = [];
  const historyRef = { state: { other: true, scrollY: 10 }, replaceState: (...args) => calls.push(args) };
  rememberScroll(historyRef, 512.6);
  assert.deepEqual(calls, [[{ other: true, scrollY: 513 }, '']]);
  rememberScroll({ state: null, replaceState: (...args) => calls.push(args) }, -4);
  assert.deepEqual(calls[1], [{ scrollY: 0 }, '']);
});

test('route scrolling bypasses the stylesheet smooth-scroll animation', () => {
  const calls = [];
  scrollToInstant({ scrollTo: options => calls.push(options) }, 320);
  assert.deepEqual(calls, [{ top: 320, left: 0, behavior: 'instant' }]);
});
