import test from 'node:test';
import assert from 'node:assert/strict';
import { trackHeaderHeight } from '../src/header-offset.js';

const styleTarget = () => {
  const values = new Map();
  return { values, style: { setProperty: (name, value) => values.set(name, value), removeProperty: name => values.delete(name) } };
};

test('publishes the header height from resize reports and stops after cleanup', () => {
  const observers = [];
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
    observe(element, options) { this.element = element; this.options = options; }
    disconnect() { this.disconnected = true; }
    report(blockSize) { if (!this.disconnected) this.callback([{ target: this.element, borderBoxSize: [{ blockSize }] }]); }
  };
  try {
    const target = styleTarget();
    const header = { getBoundingClientRect: () => { throw new Error('no synchronous measurement expected'); } };
    const stop = trackHeaderHeight(header, target);
    assert.equal(observers.length, 1);
    assert.deepEqual(observers[0].options, { box: 'border-box' });
    observers[0].report(110);
    assert.equal(target.values.get('--site-header-height'), '110px');
    observers[0].report(76.5);
    assert.equal(target.values.get('--site-header-height'), '76.5px');
    stop();
    assert.equal(observers[0].disconnected, true);
    observers[0].report(200);
    assert.equal(target.values.get('--site-header-height'), '76.5px');
  } finally {
    delete globalThis.ResizeObserver;
  }
});

test('measures once without ResizeObserver and clears the value without a header', () => {
  const target = styleTarget();
  trackHeaderHeight({ getBoundingClientRect: () => ({ height: 98 }) }, target);
  assert.equal(target.values.get('--site-header-height'), '98px');
  trackHeaderHeight(null, target)();
  assert.equal(target.values.has('--site-header-height'), false);
});
