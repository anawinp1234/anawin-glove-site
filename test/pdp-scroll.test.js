import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pdpColumnStickyTop, installPdpScroll } from '../src/pdp-scroll.js';

test('a column that fits the viewport sticks under the header', () => {
  assert.equal(pdpColumnStickyTop({ viewportHeight: 900, columnHeight: 600, headerOffset: 92 }), 92);
});

test('a column taller than the viewport sticks once its bottom is in view', () => {
  assert.equal(pdpColumnStickyTop({ viewportHeight: 900, columnHeight: 1400, headerOffset: 92 }), -516);
});

function fakeColumn(cls, height) {
  const props = new Map();
  return {
    cls, offsetHeight: height, props,
    matches: selector => selector.split(',').some(s => s.trim() === `.${cls}`),
    style: { setProperty: (k, v) => props.set(k, v), removeProperty: k => props.delete(k) }
  };
}

function fakeWindow({ desktop = true, innerHeight = 900 } = {}) {
  const listeners = new Set();
  let observed = 0, disconnected = false;
  return {
    innerHeight,
    get observed() { return observed; },
    get disconnected() { return disconnected; },
    listeners,
    ResizeObserver: class { observe() { observed++; } disconnect() { disconnected = true; } },
    matchMedia: () => ({ matches: desktop, addEventListener() {}, removeEventListener() {} }),
    getComputedStyle: () => ({ getPropertyValue: () => '92px' }),
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn)
  };
}

test('both desktop columns get a sticky top and cleanup removes it', () => {
  const gallery = fakeColumn('pdp-gallery-wrap', 1400), info = fakeColumn('pdp-info', 700);
  const win = fakeWindow();
  const destroy = installPdpScroll({ main: { children: [gallery, info] }, win });
  assert.equal(gallery.props.get('--pdp-column-top'), '-516px');
  assert.equal(info.props.get('--pdp-column-top'), '92px');
  assert.equal(win.observed, 2);
  destroy();
  assert.ok(win.disconnected && !win.listeners.size && !gallery.props.size && !info.props.size);
});

test('mobile leaves the columns alone', () => {
  const gallery = fakeColumn('pdp-gallery-wrap', 1400);
  installPdpScroll({ main: { children: [gallery] }, win: fakeWindow({ desktop: false }) });
  assert.equal(gallery.props.size, 0);
});

test('desktop CSS makes both PDP columns sticky from the computed top', async () => {
  const css = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.pdp-main > :is\(\.pdp-gallery-wrap,\.pdp-info\)\{position:sticky;top:var\(--pdp-column-top,var\(--pdp-gallery-top\)\);align-self:start\}/);
});
