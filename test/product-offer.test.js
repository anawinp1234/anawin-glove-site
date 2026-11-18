import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  applyOffer, offerFromStorefront, fetchOffer, serveProductPage, LIVE_OFFER_ATTRIBUTE as WORKER_ATTRIBUTE,
  FETCH_TIMEOUT_MS, OFFER_TTL_SECONDS, FAILURE_TTL_SECONDS
} from '../worker/product-offer.js';
import { keepsLiveOffer, LIVE_OFFER_ATTRIBUTE } from '../src/seo.js';

// Built by `npm test` before node --test runs.
const pageFor = model => readFileSync(new URL(`../dist/product/${model}.html`, import.meta.url), 'utf8');
const page = pageFor('br16');
const productBlock = html => JSON.parse(/<script type="application\/ld\+json" data-anawin-product[^>]*>([^<]*)<\/script>/.exec(html)[1]);
const storefront = (nodes, extra = {}) => ({ data: { product: { variants: { nodes } } }, ...extra });
const variant = (amount, availableForSale = true, currencyCode = 'USD') => ({ availableForSale, price: { amount, currencyCode } });
const memoryCache = () => {
  const map = new Map();
  return { map, match: async key => map.get(key.url)?.clone(), put: async (key, value) => { map.set(key.url, value); } };
};
const assets = (html = page) => ({
  requests: [],
  async fetch(request) {
    this.requests.push(request);
    return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', ETag: '"static"', 'X-Frame-Options': 'DENY' } });
  }
});
const env = (overrides = {}) => ({ PRODUCT_OFFER_SYNC: 'on', SHOPIFY_STORE_DOMAIN: 'ignvv0-zh.myshopify.com', ASSETS: assets(), ...overrides });
const shopify = (payload, calls = []) => async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify(payload)); };
const serve = (environment, options) => serveProductPage(new Request('https://anawinofficial.com/product/br16'), environment, { log: () => {}, ...options });

test('a single purchasable U.S.-market variant becomes a price and schema.org availability', () => {
  assert.deepEqual(offerFromStorefront(storefront([variant('155.0')])), { price: '155.00', currency: 'USD', availability: 'https://schema.org/InStock' });
  assert.equal(offerFromStorefront(storefront([variant('155.0', false)])).availability, 'https://schema.org/OutOfStock');
});

test('anything ambiguous yields no offer rather than a guess', () => {
  for (const payload of [
    null, {}, storefront([]), storefront([variant('155.0'), variant('160.0')]), storefront([variant('0')]),
    storefront([variant('abc')]), storefront([variant('155.0', 'yes')]), storefront([variant('250.0', true, 'CAD')]),
    storefront([variant('155.0')], { errors: [{ message: 'Throttled' }] }), { data: { product: null } }
  ]) assert.equal(offerFromStorefront(payload), null, JSON.stringify(payload));
});

test('each trainer page shows the same price in its visible HTML and its JSON-LD offer', () => {
  for (const model of ['br16', 'ob16', 'cl16']) {
    const html = pageFor(model);
    const offer = productBlock(html).offers;
    const visible = /<p class="price">\$([\d.,]+)<\/p>/.exec(html)?.[1];
    assert.equal(Number(visible), Number(offer.price), model);
    assert.equal(offer.priceCurrency, 'USD', model);
    assert.equal(offer.availability, undefined, `${model} ships without availability`);
  }
});

test('only availability is added, and only when Shopify agrees with the price already in the page', () => {
  const offer = { price: '155.00', currency: 'USD', availability: 'https://schema.org/OutOfStock' };
  const { html: updated } = applyOffer(page, offer);
  const before = productBlock(page), after = productBlock(updated);
  assert.deepEqual(after.offers, { ...before.offers, availability: 'https://schema.org/OutOfStock' });
  assert.deepEqual({ ...after, offers: null }, { ...before, offers: null });
  assert.ok(updated.includes(`data-anawin-product ${WORKER_ATTRIBUTE}>`));
  const strip = html => html.replace(/<script type="application\/ld\+json" data-anawin-product[^]*?<\/script>/, '');
  assert.equal(strip(updated), strip(page), 'visible HTML and other blocks are untouched');
  assert.deepEqual(applyOffer(page, { ...offer, price: '149.00' }), { reason: 'price-mismatch', built: '155.00' });
  assert.deepEqual(applyOffer(page, { ...offer, currency: 'CAD' }), { reason: 'currency-mismatch' });
  assert.deepEqual(applyOffer('<html></html>', offer), { reason: 'no-product-block' });
  assert.deepEqual(applyOffer(page, null), { reason: 'no-offer' });
});

test('the Worker reads the U.S. market tokenless with a short timeout, caches it, and drops stale validators', async () => {
  const calls = [];
  const cache = memoryCache();
  const environment = env();
  const request = new Request('https://anawinofficial.com/product/br16', { headers: { 'If-None-Match': '"static"' } });
  const response = await serveProductPage(request, environment, { fetchImpl: shopify(storefront([variant('155.0')]), calls), cache });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('ETag'), null);
  assert.equal(response.headers.get('X-Frame-Options'), 'DENY', 'static security headers survive');
  assert.equal(environment.ASSETS.requests[0].headers.get('If-None-Match'), null);
  assert.equal(productBlock(await response.text()).offers.availability, 'https://schema.org/InStock');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://ignvv0-zh.myshopify.com/api/2026-07/graphql.json');
  assert.deepEqual(Object.keys(calls[0].init.headers), ['Content-Type'], 'no token of any kind');
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.variables, { handle: 'br16', country: 'US' });
  assert.match(body.query, /@inContext\(country: \$country\)/);
  assert.equal(FETCH_TIMEOUT_MS, 1000);
  const [key] = cache.map.keys();
  assert.equal(key, 'https://product-offer.internal/2026-07/US/br16');
  assert.match(cache.map.get(key).headers.get('Cache-Control'), new RegExp(`max-age=${OFFER_TTL_SECONDS}$`));
  await serve(env(), { fetchImpl: shopify(storefront([variant('155.0')]), calls), cache });
  assert.equal(calls.length, 1, 'second view is served from the edge cache');
});

test('a timeout is enforced through an abort signal', async () => {
  let signal;
  const fetchImpl = (_url, init) => { signal = init.signal; return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))); };
  const { offer } = await fetchOffer('br16', env(), { fetchImpl, cache: memoryCache(), timeoutMs: 20 });
  assert.equal(offer, null);
  assert.equal(signal.aborted, true);
});

test('failures serve the page exactly as built and are remembered briefly, so an outage is not retried per view', async () => {
  for (const fetchImpl of [
    async () => new Response('busy', { status: 503 }),
    async () => { throw new DOMException('timed out', 'TimeoutError'); },
    async () => new Response('not json'),
    shopify(storefront([variant('155.0'), variant('155.0')])),
    shopify(storefront([variant('155.0')], { errors: [{ message: 'Throttled' }] }))
  ]) {
    const cache = memoryCache();
    let calls = 0;
    const counted = async (...args) => { calls++; return fetchImpl(...args); };
    const response = await serve(env(), { fetchImpl: counted, cache });
    assert.equal(await response.text(), page);
    const [entry] = cache.map.values();
    assert.match(entry.headers.get('Cache-Control'), new RegExp(`max-age=${FAILURE_TTL_SECONDS}$`));
    assert.equal(await (await serve(env(), { fetchImpl: counted, cache })).text(), page);
    assert.equal(calls, 1, 'the remembered failure is not retried immediately');
  }
});

test('a Shopify price change leaves the page as built and logs one rebuild signal per fetch', async () => {
  const lines = [];
  const cache = memoryCache();
  const fetchImpl = shopify(storefront([variant('149.0')]));
  for (let view = 0; view < 3; view++) {
    const response = await serveProductPage(new Request('https://anawinofficial.com/product/br16'), env(), { fetchImpl, cache, log: line => lines.push(line) });
    assert.equal(await response.text(), page);
  }
  assert.deepEqual(lines, [{ event: 'offer-price-mismatch', handle: 'br16', built: '155.00', shopify: '149.00' }]);
});

test('disabled, other pages and non-GET requests go straight to static assets', async () => {
  let shopifyCalls = 0;
  const fetchImpl = async () => { shopifyCalls++; return new Response('{}'); };
  for (const [url, environment, method] of [
    ['https://anawinofficial.com/product/br16', env({ PRODUCT_OFFER_SYNC: undefined }), 'GET'],
    ['https://anawinofficial.com/product/mi26', env(), 'GET'],
    ['https://anawinofficial.com/product/br16', env(), 'POST']
  ]) {
    const response = await serveProductPage(new Request(url, { method }), environment, { fetchImpl, cache: memoryCache() });
    assert.equal(response.headers.get('ETag'), '"static"', url);
  }
  assert.equal(shopifyCalls, 0);
});

test('the client keeps a Worker-synced offer for the same page and replaces it on any other page', () => {
  assert.equal(WORKER_ATTRIBUTE, LIVE_OFFER_ATTRIBUTE);
  const script = text => ({ textContent: text, hasAttribute: name => name === LIVE_OFFER_ATTRIBUTE });
  const synced = JSON.stringify({ url: 'https://anawinofficial.com/product/br16' });
  assert.equal(keepsLiveOffer(script(synced), { url: 'https://anawinofficial.com/product/br16' }), true);
  assert.equal(keepsLiveOffer(script(synced), { url: 'https://anawinofficial.com/product/ob16' }), false);
  assert.equal(keepsLiveOffer(script('{'), { url: 'https://anawinofficial.com/product/br16' }), false);
  assert.equal(keepsLiveOffer({ textContent: synced, hasAttribute: () => false }, { url: 'https://anawinofficial.com/product/br16' }), false);
});

test('the shipped configuration leaves offer sync off', () => {
  const config = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  assert.ok(!config.includes('PRODUCT_OFFER_SYNC'));
  assert.ok(!config.includes('"/product/*"'));
});
