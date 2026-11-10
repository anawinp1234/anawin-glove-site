import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { canonicalOrigin, normalizePath, productPath, routeMetadata, seoRoutes, socialImageAlt } from '../src/seo.js';
import { fullSizeProducts, localProducts } from '../src/catalog.js';

const paths = [
  '/', '/shop', '/product/br16', '/product/ob16', '/product/cl16',
  '/full-size/mi26', '/full-size/bl50', '/full-size/cm24', '/full-size/or17',
  '/about', '/community', '/shipping', '/returns', '/warranty', '/care', '/break-in'
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
    assert.equal(route.type, /^\/(?:product|full-size)\//.test(path) ? 'product' : 'website');
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
  assert.deepEqual(localProducts.map(productPath), ['/product/cl16', '/product/ob16', '/product/br16']);
  assert.equal(normalizePath('/product/br16/'), '/product/br16');
  assert.equal(routeMetadata('/product/br16/'), routeMetadata('/product/br16'));
  for (const path of ['/product/black', '/product/blue', '/product/brown', '/product/br16/anything', '/product/unknown', '/missing', '/toString', '/__proto__']) {
    assert.equal(routeMetadata(path), null);
  }
});

test('old product URLs have exact permanent redirects', () => {
  const redirects = readFileSync(new URL('../public/_redirects', import.meta.url), 'utf8').trim().split('\n');
  assert.deepEqual(redirects, [
    '/product/black /product/br16 301',
    '/product/blue /product/ob16 301',
    '/product/brown /product/cl16 301',
    '/full-size/mint /full-size/mi26 301',
    '/full-size/black /full-size/bl50 301',
    '/full-size/camel /full-size/cm24 301',
    '/full-size/orange /full-size/or17 301'
  ]);
});

test('sitemap lists each canonical public URL once', () => {
  const xml = readFileSync(new URL('../public/sitemap.xml', import.meta.url), 'utf8');
  const urls = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(match => match[1]);
  assert.deepEqual(urls, paths.map(path => canonicalOrigin + path));
});

test('full-size titles lead with the model and old color routes have no canonical metadata', () => {
  const expected = [
    ['mi26', 'mint', 'MI26 Mint 12″ Japanese Kip Pitcher’s Glove | ANAWIN'],
    ['bl50', 'black', 'BL50 Black 12.75″ Japanese Kip Outfield Glove | ANAWIN'],
    ['cm24', 'camel', 'CM24 Camel 11.5″ Japanese Kip Infield Glove | ANAWIN'],
    ['or17', 'orange', 'OR17 Orange 11.75″ Japanese Kip Infield Glove | ANAWIN']
  ];
  for (const [model, color, title] of expected) {
    const product = fullSizeProducts.find(item => item.color === color);
    assert.equal(productPath(product), `/full-size/${model}`);
    assert.equal(routeMetadata(productPath(product)).title, title);
    assert.equal(routeMetadata(`/full-size/${color}`), null);
    assert.equal(routeMetadata(`/full-size/${model}/unknown`), null);
  }
});
