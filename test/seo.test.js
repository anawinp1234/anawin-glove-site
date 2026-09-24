import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { canonicalOrigin, normalizePath, routeMetadata, seoRoutes, socialImageAlt } from '../src/seo.js';

const paths = [
  '/', '/shop', '/product/black', '/product/blue', '/product/brown',
  '/about', '/shipping', '/returns', '/warranty', '/care', '/break-in'
];

test('metadata covers exactly the public routes with unique titles and descriptions', () => {
  assert.deepEqual(Object.keys(seoRoutes), paths);
  assert.equal(new Set(paths.map(path => routeMetadata(path).title)).size, paths.length);
  assert.equal(new Set(paths.map(path => routeMetadata(path).description)).size, paths.length);
  for (const path of paths) {
    const route = routeMetadata(path);
    assert.ok(route.title && route.description);
    assert.ok(existsSync(new URL(`../public${route.image}`, import.meta.url)));
    assert.ok(socialImageAlt(route.image));
    assert.equal(new URL(canonicalOrigin + route.image).origin, canonicalOrigin);
    assert.equal(route.type, path.startsWith('/product/') ? 'product' : 'website');
  }
});

test('generic source HTML has no homepage canonical or og:url', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /rel="canonical"|property="og:url"/);
  assert.match(html, /ANAWIN \| Baseball Gloves/);
  assert.match(html, /property="og:image:alt"/);
  assert.match(html, /name="twitter:image:alt"/);
});

test('route lookup accepts one trailing slash but rejects invalid product subpaths', () => {
  assert.equal(normalizePath('/product/black/'), '/product/black');
  assert.equal(routeMetadata('/product/black/'), routeMetadata('/product/black'));
  for (const path of ['/product/black/anything', '/product/unknown', '/missing', '/toString', '/__proto__']) {
    assert.equal(routeMetadata(path), null);
  }
});

test('sitemap lists each canonical public URL once', () => {
  const xml = readFileSync(new URL('../public/sitemap.xml', import.meta.url), 'utf8');
  const urls = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(match => match[1]);
  assert.deepEqual(urls, paths.map(path => canonicalOrigin + path));
});
