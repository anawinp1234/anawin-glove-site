import test from 'node:test';
import assert from 'node:assert/strict';
import { createCheckoutHandoffWatcher } from '../src/checkout-safety.js';

function environment() {
  const listeners = [];
  const timers = new Map();
  let nextTimer = 0;
  return {
    listeners, timers,
    windowRef: { addEventListener: (type, listener) => listeners.push({ type, listener }) },
    setTimer: (fn, delay) => { timers.set(++nextTimer, { fn, delay }); return nextTimer; },
    clearTimer: id => { timers.delete(id); },
    fire(id) { const timer = timers.get(id); timers.delete(id); timer.fn(); },
    pageshow(persisted) { listeners.filter(({ type }) => type === 'pageshow').forEach(({ listener }) => listener({ persisted })); }
  };
}

test('a page still active after a handoff (a cancelled leave prompt) shows the frozen cart once', () => {
  const env = environment();
  let shown = 0;
  const watcher = createCheckoutHandoffWatcher({ ...env, onStillHere: () => shown++ });
  assert.equal(watcher.pending, false);
  watcher.start();
  assert.equal(watcher.pending, true);
  assert.deepEqual([...env.timers.values()].map(timer => timer.delay), [2000]);
  env.fire([...env.timers.keys()][0]);
  assert.equal(shown, 1);
  assert.equal(watcher.pending, false);
  env.pageshow(true);
  assert.equal(shown, 1, 'a later restore does not show it again');
});

test('a back/forward cache restore shows the frozen cart immediately and cancels the timer', () => {
  const env = environment();
  let shown = 0;
  const watcher = createCheckoutHandoffWatcher({ ...env, onStillHere: () => shown++ });
  watcher.start();
  env.pageshow(false);
  assert.equal(shown, 0, 'an ordinary page load is not a restore');
  env.pageshow(true);
  assert.equal(shown, 1);
  assert.equal(env.timers.size, 0);
  assert.equal(watcher.pending, false);
});

test('without a handoff, restores and page loads do nothing', () => {
  const env = environment();
  let shown = 0;
  createCheckoutHandoffWatcher({ ...env, onStillHere: () => shown++ });
  env.pageshow(true);
  env.pageshow(false);
  assert.equal(shown, 0);
});

test('repeated handoffs keep one listener and one timer', () => {
  const env = environment();
  let shown = 0;
  const watcher = createCheckoutHandoffWatcher({ ...env, onStillHere: () => shown++ });
  for (let attempt = 0; attempt < 3; attempt++) {
    watcher.start();
    assert.equal(env.timers.size, 1);
    env.fire([...env.timers.keys()][0]);
    assert.equal(shown, attempt + 1);
  }
  watcher.start();
  watcher.start();
  assert.equal(env.timers.size, 1);
  assert.equal(env.listeners.length, 1);
});
