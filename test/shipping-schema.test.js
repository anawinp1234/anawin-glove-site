import test from 'node:test';
import assert from 'node:assert/strict';
import { LIVE_OFFER_ATTRIBUTE, productJsonLd, renderSeoHead, updateSeo, usShippingServiceId } from '../src/seo.js';
import { applyOffer } from '../worker/product-offer.js';

const reference = { '@type': 'OfferShippingDetails', hasShippingService: { '@id': usShippingServiceId } };

// Just enough DOM for updateSeo: tag[attr] and tag[attr="value"] selectors on head children.
class FakeElement {
  constructor(tagName, document) { this.tagName = tagName; this.document = document; this.attributes = new Map(); this.textContent = ''; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  get isConnected() { return this.document.head.children.includes(this); }
  remove() { this.document.head.children = this.document.head.children.filter(child => child !== this); }
}
const matchesSelector = (element, selector) => {
  const [, tag, rest] = /^(\w+)(.*)$/.exec(selector);
  if (element.tagName !== tag) return false;
  return [...rest.matchAll(/\[([\w:-]+)(?:="([^"]*)")?\]/g)].every(([, name, value]) =>
    value === undefined ? element.hasAttribute(name) : element.getAttribute(name) === value);
};
function fakeDocument() {
  const document = { title: '', createElement: tag => new FakeElement(tag, document) };
  document.head = {
    children: [],
    append(element) { this.children.push(element); },
    querySelectorAll(selector) { return this.children.filter(child => matchesSelector(child, selector)); }
  };
  return document;
}
const blocks = (document, attribute) => document.head.querySelectorAll(`script[type="application/ld+json"][${attribute}]`)
  .map(script => JSON.parse(script.textContent));

test('client navigation keeps the preorder shipping reference and places the shared service only on /shipping', () => {
  const document = fakeDocument();
  updateSeo(document, '/product/mi26');
  assert.deepEqual(blocks(document, 'data-anawin-product')[0].offers.shippingDetails, reference);
  assert.equal(blocks(document, 'data-anawin-site').length, 0);

  updateSeo(document, '/shipping');
  assert.equal(blocks(document, 'data-anawin-product').length, 0);
  const [organization, ...extra] = blocks(document, 'data-anawin-site');
  assert.equal(extra.length, 0);
  assert.equal(organization.hasShippingService['@id'], usShippingServiceId);

  updateSeo(document, '/');
  const [[home]] = blocks(document, 'data-anawin-site');
  assert.equal(home.hasShippingService, undefined, 'the homepage keeps its return-policy Organization only');
  assert.ok(home.hasMerchantReturnPolicy);

  updateSeo(document, '/product/br16');
  assert.equal(blocks(document, 'data-anawin-product')[0].offers.shippingDetails.deliveryTime.handlingTime.maxValue, 3);
  updateSeo(document, '/product/or17');
  assert.deepEqual(blocks(document, 'data-anawin-product')[0].offers.shippingDetails, reference);
  assert.equal(blocks(document, 'data-anawin-site').length, 0);
});

test('a Worker-refreshed preorder offer keeps its shipping reference through the rewrite and client navigation', () => {
  const head = renderSeoHead('/product/mi26');
  const { html } = applyOffer(`<html><head>${head}</head><body></body></html>`, { price: '295.00', currency: 'USD', availability: 'https://schema.org/PreOrder' });
  const live = JSON.parse(/<script type="application\/ld\+json" data-anawin-product data-anawin-live-offer>([^<]*)<\/script>/.exec(html)[1]);
  assert.deepEqual(live.offers, { ...productJsonLd('/product/mi26').offers, availability: 'https://schema.org/PreOrder' });
  assert.deepEqual(live.offers.shippingDetails, reference);

  // The browser keeps the live block while it describes the page (keepsLiveOffer).
  const document = fakeDocument();
  const script = document.createElement('script');
  script.setAttribute('type', 'application/ld+json');
  script.setAttribute('data-anawin-product', '');
  script.setAttribute(LIVE_OFFER_ATTRIBUTE, '');
  script.textContent = JSON.stringify(live);
  document.head.append(script);
  updateSeo(document, '/product/mi26');
  assert.equal(document.head.querySelectorAll('script[data-anawin-product]').length, 1);
  assert.deepEqual(blocks(document, 'data-anawin-product')[0], live);
  updateSeo(document, '/product/bl50');
  const [rebuilt] = blocks(document, 'data-anawin-product');
  assert.equal(rebuilt.offers.availability, undefined);
  assert.deepEqual(rebuilt.offers.shippingDetails, reference);
  assert.equal(script.hasAttribute(LIVE_OFFER_ATTRIBUTE), false);
});

test('the Worker still adds availability to trainer offers without touching their shipping timing', () => {
  const { html } = applyOffer(`<html><head>${renderSeoHead('/product/br16')}</head></html>`, { price: '155.00', currency: 'USD', availability: 'https://schema.org/InStock' });
  const live = JSON.parse(/data-anawin-live-offer>([^<]*)<\/script>/.exec(html)[1]);
  assert.deepEqual(live.offers.shippingDetails, productJsonLd('/product/br16').offers.shippingDetails);
  assert.equal(live.offers.availability, 'https://schema.org/InStock');
});
