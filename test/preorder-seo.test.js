import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fullSizeProducts, PREORDER_CHECKOUT } from '../src/catalog.js';
import { productJsonLd, productPath, renderSeoHead } from '../src/seo.js';
import {
  OFFER_PAGE, applyOffer, fetchOffer, offerFromStorefront, offerPageFor, preorderOfferPages, serveProductPage
} from '../worker/product-offer.js';

const ESTIMATE = 'first week of December 2026';
// Each test file runs in its own process. Active preorders need confirmed full payment at checkout;
// the shipped catalog keeps PREORDER_CHECKOUT.chargedInFullAtCheckout false.
PREORDER_CHECKOUT.chargedInFullAtCheckout = true;
const preorderCatalog = fullSizeProducts.map(product => product.id === 'full-mint'
  ? { ...product, comingSoon: false, preorder: { enabled: true, shipEstimate: ESTIMATE } } : product);
const storefront = (nodes, metafield) => ({ data: { product: { ...(metafield === undefined ? {} : { preorderShipEstimate: metafield === null ? null : { value: metafield } }), variants: { nodes } } } });
const variant = (amount = '285.0', availableForSale = true, currencyCode = 'USD') => ({ availableForSale, price: { amount, currencyCode } });
const memoryCache = () => {
  const map = new Map();
  return { map, match: async key => map.get(key.url)?.clone(), put: async (key, value) => { map.set(key.url, value); } };
};
const productBlock = html => JSON.parse(/<script type="application\/ld\+json" data-anawin-product[^>]*>([^<]*)<\/script>/.exec(html)[1]);

test('Coming Soon full-size pages keep Product/Offer JSON-LD absent, including the built HTML', () => {
  for (const product of fullSizeProducts) {
    const path = productPath(product);
    assert.equal(productJsonLd(path), null, path);
    assert.doesNotMatch(renderSeoHead(path), /data-anawin-product/);
    const built = readFileSync(new URL(`../dist${path}.html`, import.meta.url), 'utf8');
    assert.doesNotMatch(built, /data-anawin-product|schema\.org\/(InStock|PreOrder)/, path);
    assert.match(built, /Add to cart — Coming soon/);
  }
  assert.deepEqual(preorderOfferPages(), {});
  assert.equal(OFFER_PAGE.source, '^\\/product\\/(br16|ob16|cl16)$');
});

test('a configured preorder gets a Product offer without build-time availability or delivery time', () => {
  const data = productJsonLd('/product/mi26', { fullSize: preorderCatalog });
  assert.equal(data['@type'], 'Product');
  assert.deepEqual(data.offers, { '@type': 'Offer', url: 'https://anawinofficial.com/product/mi26', priceCurrency: 'USD', price: '285.00' });
  assert.equal(data.image, 'https://anawinofficial.com/images/full-size/mint-back.jpg');
  assert.doesNotMatch(JSON.stringify(data), /InStock|availability|shippingDetails|deliveryTime/);
  assert.equal(productJsonLd('/product/bl50', { fullSize: preorderCatalog }), null);
  const missing = preorderCatalog.map(product => product.id === 'full-mint' ? { ...product, preorder: { enabled: true, shipEstimate: ' ' } } : product);
  assert.equal(productJsonLd('/product/mi26', { fullSize: missing }), null);
  assert.equal(productJsonLd('/product/br16', { fullSize: preorderCatalog }).offers.price, '155.00', 'trainers unchanged');
});

test('the prerender refuses to ship a page that claims availability', () => {
  const source = readFileSync(new URL('../scripts/prerender.mjs', import.meta.url), 'utf8');
  assert.match(source, /if \(\/schema\\\.org\\\/\(InStock\|PreOrder\)\/\.test\(head\)\) throw/);
});

test('the Worker publishes PreOrder, never InStock, for a confirmed preorder', () => {
  const pre = { preorderEstimate: ESTIMATE };
  assert.deepEqual(offerFromStorefront(storefront([variant(), variant()], ESTIMATE), pre), { price: '285.00', currency: 'USD', availability: 'https://schema.org/PreOrder' });
  assert.equal(offerFromStorefront(storefront([variant(), variant('285.0', false)], ` ${ESTIMATE} `), pre).availability, 'https://schema.org/PreOrder');
  assert.equal(offerFromStorefront(storefront([variant('285.0', false), variant('285.0', false)], ESTIMATE), pre).availability, 'https://schema.org/OutOfStock');
  for (const payload of [
    storefront([variant()], 'mid-December 2026'), storefront([variant()], null), storefront([variant()]), storefront([variant()], '  '), storefront([]), storefront([variant('285.0'), variant('295.0')]),
    storefront([variant('285.0', true, 'CAD')]), storefront([variant('0')]), storefront([variant('285.0', 'yes')]),
    storefront(Array.from({ length: 20 }, () => variant())), { data: { product: null } }, { errors: [{ message: 'x' }] }, null
  ]) assert.equal(offerFromStorefront(payload, pre), null, JSON.stringify(payload));
  // Trainer offers are unchanged.
  assert.equal(offerFromStorefront(storefront([variant('155.0')])).availability, 'https://schema.org/InStock');
});

test('only catalog-configured preorder pages are synced, with the estimate in the cache key', async () => {
  assert.equal(offerPageFor('/product/mi26'), null);
  assert.deepEqual(offerPageFor('/product/mi26', preorderCatalog), { handle: 'mi26', preorderEstimate: ESTIMATE });
  assert.equal(offerPageFor('/product/bl50', preorderCatalog), null);
  assert.deepEqual(offerPageFor('/product/br16'), { handle: 'br16', preorderEstimate: null });
  assert.equal(offerPageFor('/product/mi26/x', preorderCatalog), null);

  const head = renderSeoHead('/product/mi26').replace(/<\/script>[\s\S]*$/, '');
  const block = `<script type="application/ld+json" data-anawin-product>${JSON.stringify(productJsonLd('/product/mi26', { fullSize: preorderCatalog }))}</script>`;
  const html = `<html><head>${head}${block}</head><body>MI26</body></html>`;
  const updated = applyOffer(html, offerFromStorefront(storefront([variant(), variant()], ESTIMATE), { preorderEstimate: ESTIMATE })).html;
  assert.equal(productBlock(updated).offers.availability, 'https://schema.org/PreOrder');

  const calls = [];
  const cache = memoryCache();
  const fetchImpl = async (url, init) => { calls.push(JSON.parse(init.body)); return new Response(JSON.stringify(storefront([variant(), variant()], ESTIMATE))); };
  const assets = { async fetch() { return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } }); } };
  const env = { PRODUCT_OFFER_SYNC: 'on', SHOPIFY_STORE_DOMAIN: 'ignvv0-zh.myshopify.com', ASSETS: assets };
  const served = await serveProductPage(new Request('https://anawinofficial.com/product/mi26'), env, { fetchImpl, cache, catalog: preorderCatalog, log: () => {} });
  assert.equal(productBlock(await served.text()).offers.availability, 'https://schema.org/PreOrder');
  assert.match(calls[0].query, /preorderShipEstimate: metafield\(namespace: "custom", key: "preorder_ship_estimate"\)/);
  assert.deepEqual([...cache.map.keys()], ['https://product-offer.internal/2026-07/US/mi26/preorder/first%20week%20of%20December%202026']);

  // A mismatched Shopify estimate leaves the page exactly as built.
  const mismatch = async () => new Response(JSON.stringify(storefront([variant()], 'mid-December 2026')));
  assert.deepEqual(await fetchOffer('mi26', env, { fetchImpl: mismatch, cache: memoryCache(), preorderEstimate: ESTIMATE }), { offer: null, cached: false });
  const asBuilt = await serveProductPage(new Request('https://anawinofficial.com/product/mi26'), env, { fetchImpl: mismatch, cache: memoryCache(), catalog: preorderCatalog, log: () => {} });
  assert.equal(await asBuilt.text(), html);
});
