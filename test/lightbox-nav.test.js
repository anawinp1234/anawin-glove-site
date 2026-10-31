import test from 'node:test';
import assert from 'node:assert/strict';
import { lightboxCounter, stepLightboxIndex } from '../src/lightbox-nav.js';

test('lightbox navigation wraps in both directions across the product views', () => {
  assert.equal(stepLightboxIndex(0, 1, 4), 1);
  assert.equal(stepLightboxIndex(3, 1, 4), 0);
  assert.equal(stepLightboxIndex(0, -1, 4), 3);
  assert.equal(stepLightboxIndex(2, -1, 4), 1);
  assert.equal(stepLightboxIndex(0, 1, 1), 0);
});

test('an empty gallery never produces an out-of-range index', () => {
  assert.equal(stepLightboxIndex(0, 1, 0), 0);
  assert.equal(stepLightboxIndex(0, -1, Number.NaN), 0);
});

test('the counter reads as a one-based position', () => {
  assert.equal(lightboxCounter(0, 4), '1 of 4');
  assert.equal(lightboxCounter(3, 4), '4 of 4');
});
