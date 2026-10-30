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

test('all 12 public routes have complete raw HTML and unique route metadata', () => {
  assert.equal(Object.keys(seoRoutes).length, 12);
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

test('prerendered shipping copy covers seven destinations while cart totals remain before shipping', () => {
  const shipping = htmlFor('/shipping');
  assert.match(shipping, /We currently ship to the United States, Canada, Australia, Japan, South Korea, Mexico, and the Philippines\./);
  assert.match(shipping, /<meta name="description" content="ANAWIN ships to the United States, Canada, Australia, Japan, South Korea, Mexico, and the Philippines\. International shipping rates are calculated at checkout\./);
  assert.match(shipping, /Standard Shipping — FREE/);
  assert.match(shipping, /International shipping rates and available services are calculated at checkout based on destination and shipping method\./);
  assert.doesNotMatch(shipping, /\$\d+|Express Shipping —/);
  for (const product of localProducts) {
    const html = htmlFor(productPath(product));
    assert.match(html, /International shipping available to Canada, Australia, Japan, South Korea, Mexico, and the Philippines\./);
    assert.match(html, /International rates are calculated at checkout\./);
    assert.match(html, /Free U\.S\. standard shipping\./);
  }
  assert.match(htmlFor('/'), /FREE U\.S\. SHIPPING ON ALL ORDERS<\/p>/);
  const bundles = readdirSync(join(root, 'dist/assets')).filter(name => /^index-.*\.js$/.test(name));
  assert.equal(bundles.length, 1);
  const bundle = read(`dist/assets/${bundles[0]}`);
  assert.match(bundle, /<p>Free U\.S\. standard shipping\. Shipping options and rates are shown at checkout\. Taxes are calculated at checkout\.<\/p>/);
  assert.match(bundle, /Shipping options and rates are shown at checkout\./);
  assert.match(bundle, /Taxes are calculated at checkout\./);
  assert.match(bundle, /Total before shipping\/tax/);
  for (const html of [htmlFor('/'), shipping, ...localProducts.map(product => htmlFor(productPath(product))), bundle]) {
    assert.doesNotMatch(html, /\$9(?:\.00)?\s*(?:U\.S\.)?\s*shipping|\$10(?:\.00)?\s*(?:U\.S\.)?\s*shipping|free shipping over \$225|(?:ships?|shipping) (?:within|to) (?:the )?(?:U\.S\.|United States) only/i);
  }
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
      price: '155.00'
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

test('static responses carry one restrictive report-only CSP without changing HTML or existing headers', () => {
  const source = read('public/_headers');
  const built = read('dist/_headers');
  assert.equal(built, source);
  assert.match(source, /^\/\*$/m);
  const headerLines = source.trim().split('\n').slice(1).map(line => line.trim());
  const values = new Map(headerLines.map(line => {
    const separator = line.indexOf(':');
    return [line.slice(0, separator).toLowerCase(), line.slice(separator + 1).trim()];
  }));
  assert.equal(values.size, headerLines.length, 'duplicate headers would combine into conflicting policies');
  assert.equal(values.get('x-frame-options'), 'DENY');
  assert.equal(values.get('x-content-type-options'), 'nosniff');
  assert.equal(values.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(values.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()');
  assert.equal(values.has('content-security-policy'), false);
  assert.equal(values.has('strict-transport-security'), false);

  const policy = values.get('content-security-policy-report-only');
  assert.ok(policy, 'missing report-only policy');
  const directives = new Map(policy.split(';').map(part => {
    const [name, ...sources] = part.trim().split(/\s+/);
    return [name, sources];
  }));
  assert.equal(directives.size, policy.split(';').length, 'duplicate CSP directives');
  for (const [name, expected] of Object.entries({
    'default-src': ["'self'"], 'base-uri': ["'self'"], 'object-src': ["'none'"],
    'frame-ancestors': ["'none'"], 'frame-src': ["'none'"],
    'script-src': ["'self'", 'https://static.cloudflareinsights.com'],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:'], 'font-src': ["'self'"],
    'connect-src': ["'self'", 'https://ignvv0-zh.myshopify.com', 'https://cdn.judge.me'],
    'media-src': ["'self'"], 'form-action': ["'self'"]
  })) assert.deepEqual(directives.get(name), expected, name);
  assert.equal(directives.size, 12);
  assert.doesNotMatch(policy, /\*\.|https?:\/\/\*|unsafe-eval|report-uri|report-to|upgrade-insecure-requests/);
  for (const path of [...Object.keys(seoRoutes), '/404']) {
    const html = path === '/404' ? read('dist/404.html') : htmlFor(path);
    assert.doesNotMatch(html, /http-equiv=["']Content-Security-Policy/i, path);
    assert.match(html, /<main\b/, path);
  }
});
