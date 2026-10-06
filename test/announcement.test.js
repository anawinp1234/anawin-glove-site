import test from 'node:test';
import assert from 'node:assert/strict';
import { announcement } from '../src/announcement.js';
import { breakInService, localProducts } from '../src/catalog.js';
import { createStorefrontRenderer } from '../src/storefront-render.js';

const renderer = config => createStorefrontRenderer({
  products: localProducts,
  breakInService,
  announcement: config
});

test('the free-shipping announcement appears above the header when enabled', () => {
  const html = renderer(announcement).header();
  assert.ok(html.startsWith('<aside class="announcement-bar"'));
  assert.match(html, /<aside class="announcement-bar" aria-label="Store announcement"><p>FREE U\.S\. SHIPPING ON ALL ORDERS<\/p><\/aside>/);
  assert.ok(html.indexOf(announcement.message) < html.indexOf('<header class="site-header">'));
  assert.equal(announcement.enabled, true);
});

test('the disabled announcement removes its markup without changing the header', () => {
  const enabled = renderer(announcement).header();
  const disabled = renderer({ ...announcement, enabled: false }).header();
  assert.ok(disabled.startsWith('<header class="site-header">'));
  assert.equal(disabled, enabled.slice(enabled.indexOf('<header class="site-header">')));
});

test('announcement text is escaped', () => {
  const html = renderer({ enabled: true, message: '<script>alert(1)</script>' }).header();
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.includes('<script>'));
});
