import test from 'node:test';
import assert from 'node:assert/strict';
import { breakInService, localProducts } from '../src/catalog.js';
import { createStorefrontRenderer } from '../src/storefront-render.js';
import { productPath } from '../src/seo.js';

const views = createStorefrontRenderer({ products: localProducts, breakInService });

test('homepage hero names the product category and keeps the shop CTA', () => {
  const hero = views.route('/').match(/<section class="hero">[^]*?<\/section>/)[0];
  assert.match(hero, /<p class="eyebrow">ANAWIN \/ Baseball gloves<\/p><h1>COMMUNITY<br><em>BUILT<\/em><\/h1><\/div>/);
  assert.doesNotMatch(hero, /hero-subhead/);
  assert.match(hero, /<a href="\/shop" data-link class="hero-cta">View all gloves/);
});

test('every link to the break-in page uses the same label', () => {
  const html = [views.header(), views.footer(), ...localProducts.map(product => views.route(productPath(product))), views.route('/product/mi26')].join('');
  const labels = [...html.matchAll(/href="\/break-in" data-link>([^<]*)</g)].map(match => match[1]);
  assert.ok(labels.length >= 5);
  assert.deepEqual([...new Set(labels)], ['Break-In Guide']);
});

test('footer lists only the support address', () => {
  const emails = [...views.footer().matchAll(/mailto:([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(emails, ['support@anawinofficial.com']);
});
