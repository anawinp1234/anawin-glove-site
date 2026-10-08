import test from 'node:test';
import assert from 'node:assert/strict';
import { nextHeaderHidden } from '../src/header-scroll.js';

test('the announcement and navigation stay visible for a short scroll, hide downward, and return upward', () => {
  assert.equal(nextHeaderHidden({ scrollY: 100, previousY: 80, hidden: false }), false);
  assert.equal(nextHeaderHidden({ scrollY: 180, previousY: 150, hidden: false }), true);
  assert.equal(nextHeaderHidden({ scrollY: 178, previousY: 180, hidden: true }), false);
  assert.equal(nextHeaderHidden({ scrollY: 220, previousY: 180, hidden: false, menuOpen: true }), false);
  assert.equal(nextHeaderHidden({ scrollY: 0, previousY: 200, hidden: true }), false);
});
