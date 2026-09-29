import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localProducts } from '../src/catalog.js';
import { canonicalOrigin, productPath, seoRoutes } from '../src/seo.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => readFileSync(join(root, path), 'utf8');
const htmlFor = path => read(path === '/' ? 'dist/index.html' : `dist/${path.slice(1)}.html`);
const matches = (html, pattern) => [...html.matchAll(pattern)];

test('all 11 public routes have complete raw HTML and unique route metadata', () => {
  assert.equal(Object.keys(seoRoutes).length, 11);
  for (const [path, metadata] of Object.entries(seoRoutes)) {
    const html = htmlFor(path);
    const canonical = canonicalOrigin + path;
    assert.ok(html.includes(`<title>${metadata.title.replace('&', '&amp;')}</title>`), path);
    assert.ok(html.includes(`<meta name="description" content="${metadata.description.replace('&', '&amp;')}" />`), path);
    assert.equal(matches(html, /<link rel="canonical"/g).length, 1, path);
    assert.ok(html.includes(`<link rel="canonical" href="${canonical}" />`), path);
    assert.ok(html.includes(`<meta property="og:url" content="${canonical}" />`), path);
    assert.ok(html.includes(`<meta property="og:type" content="${metadata.type}" />`), path);
    assert.ok(html.includes(`<meta property="og:image" content="${canonicalOrigin + metadata.image}" />`), path);
    assert.ok(html.includes('property="og:image:alt"'), path);
    assert.ok(html.includes('name="twitter:image:alt"'), path);
    assert.equal(matches(html, /<h1\b/g).length, 1, path);
    assert.ok(html.includes('<main') && html.includes('<a href="/shop"'), path);
    assert.ok(!html.includes('anawin:app') && !html.includes('anawin:seo'), path);
    assert.doesNotMatch(html, /(?:href|content)="(?:https:\/\/anawinofficial\.com)?\/product\/(?:black|blue|brown)"/, path);
  }
});

test('prerendered shipping pages and the cart bundle carry the confirmed rates', () => {
  const shipping = htmlFor('/shipping');
  assert.match(shipping, /Standard shipping within the United States is \$9\. Standard shipping is free on orders \$225 or more\./);
  assert.match(shipping, /<meta name="description" content="Standard U\.S\. shipping is \$9, or free on orders \$225\+/);
  for (const product of localProducts) {
    const html = htmlFor(productPath(product));
    assert.match(html, /Standard shipping within the United States is \$9\. Standard shipping is free on orders \$225 or more\./);
    assert.doesNotMatch(html, /U\.S\. shipping is calculated at checkout/i);
  }
  const bundles = readdirSync(join(root, 'dist/assets')).filter(name => /^index-.*\.js$/.test(name));
  assert.equal(bundles.length, 1);
  const bundle = read(`dist/assets/${bundles[0]}`);
  assert.match(bundle, /<p>Standard U\.S\. shipping is \$9, or free on orders \$225\+\. Taxes are calculated at checkout\.<\/p>/);
  assert.doesNotMatch(bundle, /U\.S\. shipping is calculated at checkout|shipping costs are calculated at checkout|Taxes and shipping calculated at checkout/i);
});

test('every prerendered footer links to the exact published legal policies', () => {
  const privacy = '<a href="https://checkout.shopify.com/84529185016/policies/46558740728.html?locale=en" target="_blank" rel="noreferrer">Privacy Policy</a>';
  const terms = '<a href="https://checkout.shopify.com/84529185016/policies/47782691064.html?locale=en" target="_blank" rel="noreferrer">Terms of Service</a>';
  for (const path of [...Object.keys(seoRoutes), '/404']) {
    const html = path === '/404' ? read('dist/404.html') : htmlFor(path);
    const footer = html.match(/<footer>.*?<\/footer>/s)?.[0];
    assert.ok(footer, path);
    assert.equal(footer.split(privacy).length - 1, 1, path);
    assert.equal(footer.split(terms).length - 1, 1, path);
    assert.ok(footer.includes('<a href="/shipping" data-link>Shipping Policy</a>'), path);
    assert.ok(footer.includes('<a href="/returns" data-link>Returns &amp; Refunds Policy</a>'), path);
  }
  assert.equal(seoRoutes['/privacy'], undefined);
  assert.equal(seoRoutes['/terms'], undefined);
  assert.equal(existsSync(join(root, 'dist/privacy.html')), false);
  assert.equal(existsSync(join(root, 'dist/terms.html')), false);
});

test('each PDP has one self-contained Product and minimal approved Offer', () => {
  for (const product of localProducts) {
    const path = productPath(product);
    const html = htmlFor(path);
    assert.ok(existsSync(join(root, `dist/${path.slice(1)}.html`)), path);
    const scripts = matches(html, /<script type="application\/ld\+json" data-anawin-product>(.*?)<\/script>/g);
    assert.equal(scripts.length, 1, path);
    const data = JSON.parse(scripts[0][1]);
    // Google requires Product.name and one of offers/review/aggregateRating;
    // Offer.price is required, and priceCurrency avoids ambiguity.
    assert.equal(data['@context'], 'https://schema.org');
    assert.equal(data['@type'], 'Product');
    assert.equal(data.name, product.name);
    assert.ok(data.description && data.image && data.url);
    assert.deepEqual(data.brand, { '@type': 'Brand', name: 'ANAWIN' });
    assert.equal(data.color, product.tone);
    assert.equal(data.image, canonicalOrigin + product.images[0]);
    assert.equal(data.url, canonicalOrigin + path);
    assert.deepEqual(data.offers, {
      '@type': 'Offer',
      url: canonicalOrigin + path,
      priceCurrency: 'USD',
      price: '150.00'
    });
    for (const forbidden of ['review', 'aggregateRating', 'sku', 'gtin', 'mpn', 'availability', 'inventoryLevel']) {
      assert.equal(data[forbidden], undefined, `${path}: ${forbidden}`);
      assert.equal(data.offers[forbidden], undefined, `${path}: ${forbidden}`);
    }
  }
});

test('old product pages are absent from the build and redirects are deployed', () => {
  for (const id of ['black', 'blue', 'brown']) {
    assert.equal(existsSync(join(root, `dist/product/${id}.html`)), false);
  }
  assert.equal(read('dist/_redirects'), read('public/_redirects'));
});

test('non-product routes have no Product JSON-LD and 404 is noindex', () => {
  for (const path of Object.keys(seoRoutes).filter(value => !value.startsWith('/product/'))) {
    assert.doesNotMatch(htmlFor(path), /application\/ld\+json/, path);
  }
  const html = read('dist/404.html');
  assert.match(html, /<meta name="robots" content="noindex"/);
  assert.match(html, /<main class="not-found"/);
  assert.equal(matches(html, /<h1\b/g).length, 1);
  assert.doesNotMatch(html, /rel="canonical"|property="og:url"|application\/ld\+json/);
});

test('robots, sitemap, and security headers survive the build', () => {
  for (const name of ['robots.txt', 'sitemap.xml', '_headers']) {
    assert.equal(read(`dist/${name}`), read(`public/${name}`));
  }
  assert.doesNotMatch(read('dist/sitemap.xml'), /404/);
});
