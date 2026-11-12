import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { configurationDigest } from '../src/catalog.js';

test('configuration SHA-256 matches the platform implementation for UTF-8, padding boundaries and maximum instruction lengths', () => {
  for (const text of ['', 'abc', 'None', 'Recommend for me', '⚾ — 手套', ...[55, 56, 63, 64, 65, 127, 128, 2000, 5000].map(n => 'a'.repeat(n))]) {
    assert.equal(configurationDigest(text), createHash('sha256').update(text).digest('hex'));
  }
});
