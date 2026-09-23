import test from 'node:test';
import assert from 'node:assert/strict';
import { localProducts } from '../src/catalog.js';
import { warrantyParagraphs } from '../src/policy-content.js';

test('PDP product data keeps verified training descriptors and accent colors', () => {
  const expectedAccents = { black: '#d3423e', blue: '#2560ae', brown: '#9a622d' };

  for (const product of localProducts) {
    assert.equal(product.descriptor, '10.25" Trainer · US Steerhide');
    assert.equal(product.accentColor, expectedAccents[product.id]);
  }
});

test('the displayed warranty duration is explicitly supported by policy content', () => {
  assert.match(warrantyParagraphs[0], /1-year limited warranty/i);
});
