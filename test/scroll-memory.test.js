import test from 'node:test';
import assert from 'node:assert/strict';
import { installScrollMemory, rememberScroll, savedScrollY, scrollToInstant } from '../src/scroll-memory.js';

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

// Traversal changes history.state before popstate, while manual restoration still
// exposes the outgoing document's scrollY. Exercise that ordering with real events.
function historyWindow({ storage = new Map() } = {}) {
  const windowRef = new EventTarget();
  const entries = [
    { anawinScrollEntry: 'shop', scrollY: 100, other: 'shop state' },
    { anawinScrollEntry: 'community', scrollY: 200, other: 'community state' }
  ];
  let index = 1;
  const timers = new Map();
  let nextTimer = 0;
  Object.assign(windowRef, {
    scrollY: 200,
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    history: {
      scrollRestoration: 'auto',
      get state() { return entries[index]; },
      replaceState(state) { entries[index] = structuredClone(state); },
      pushState(state) { entries.splice(++index, Infinity, structuredClone(state)); },
      go(delta) { index += delta; windowRef.dispatchEvent(new Event('popstate')); }
    }
  });
  const restores = [];
  const restore = top => { restores.push(top); windowRef.scrollY = top; windowRef.dispatchEvent(new Event('scroll')); };
  const flush = () => { const pending = [...timers.values()]; timers.clear(); pending.forEach(callback => callback()); };
  const scroll = top => { windowRef.scrollY = top; windowRef.dispatchEvent(new Event('scroll')); };
  return { windowRef, entries, restores, restore, flush, scroll, storage, timers };
}

test('rapid Back/Forward saves the outgoing position without overwriting destination history state', () => {
  const env = historyWindow();
  installScrollMemory(env.windowRef, env.restore);
  env.scroll(700);
  assert.equal(env.timers.size, 1, 'the 200ms save has not fired');
  env.windowRef.history.go(-1);
  assert.equal(env.windowRef.scrollY, 100);
  assert.deepEqual(env.entries[0], { anawinScrollEntry: 'shop', scrollY: 100, other: 'shop state' });
  env.flush(); // A canceled outgoing timer must not save 700 against the destination.
  assert.equal(env.entries[0].scrollY, 100);
  env.windowRef.history.go(1);
  assert.equal(env.windowRef.scrollY, 700);
  assert.deepEqual(env.restores, [100, 700]);
});

test('traversal captures an outgoing scroll even before its scroll event is delivered', () => {
  const env = historyWindow();
  installScrollMemory(env.windowRef, env.restore);
  env.windowRef.scrollY = 700;
  env.windowRef.history.go(-1);
  env.windowRef.history.go(1);
  assert.equal(env.windowRef.scrollY, 700);
  assert.equal(env.entries[0].scrollY, 100);
});

test('a rapid outgoing position survives reloading the destination before Forward', () => {
  const env = historyWindow();
  installScrollMemory(env.windowRef, env.restore);
  env.scroll(700);
  env.windowRef.history.go(-1);
  const reloaded = historyWindow({ storage: env.storage });
  Object.assign(reloaded.entries[0], env.entries[0]);
  Object.assign(reloaded.entries[1], env.entries[1]);
  // Start the new document at the destination, retaining both session-history entries.
  reloaded.windowRef.history.go(-1);
  const memory = installScrollMemory(reloaded.windowRef, reloaded.restore);
  assert.equal(memory.initialY, 100);
  reloaded.windowRef.scrollY = memory.initialY;
  reloaded.windowRef.history.go(1);
  assert.equal(reloaded.windowRef.scrollY, 700);
});

test('normal navigation, pagehide and reload retain entry state and the latest position', () => {
  const env = historyWindow();
  const memory = installScrollMemory(env.windowRef, env.restore, { createKey: () => 'product' });
  env.scroll(500);
  memory.navigate('/product/br16');
  assert.equal(env.entries[1].scrollY, 500);
  assert.equal(env.entries[1].other, 'community state');
  assert.equal(env.windowRef.scrollY, 0);
  env.scroll(900);
  env.windowRef.dispatchEvent(new Event('pagehide'));
  assert.equal(env.windowRef.history.state.scrollY, 900);
  assert.equal(env.timers.size, 0);
  assert.equal(env.windowRef.history.scrollRestoration, 'manual');
  const reloaded = historyWindow();
  reloaded.entries[1] = structuredClone(env.windowRef.history.state);
  assert.equal(installScrollMemory(reloaded.windowRef, reloaded.restore).initialY, 900);
});

test('rapid traversal still works when session storage is blocked', () => {
  const env = historyWindow();
  Object.defineProperty(env.windowRef, 'sessionStorage', { get() { throw new Error('Storage blocked'); } });
  installScrollMemory(env.windowRef, env.restore);
  env.scroll(700);
  env.windowRef.history.go(-1);
  env.windowRef.history.go(1);
  assert.equal(env.windowRef.scrollY, 700);
});
