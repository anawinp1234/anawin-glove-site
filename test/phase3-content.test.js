import test from 'node:test';
import assert from 'node:assert/strict';
import { breakInService, fullSizeProducts, localProducts } from '../src/catalog.js';
import { createStorefrontRenderer } from '../src/storefront-render.js';
import { productPath } from '../src/seo.js';

const renderer = createStorefrontRenderer({ products: localProducts, breakInService });
const text = html => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');

test('related-product cards label every unreleased glove as coming soon', () => {
  for (const product of [...localProducts, ...fullSizeProducts]) {
    const html = renderer.route(productPath(product));
    const cards = [...html.matchAll(/<a class="other-glove-card"[^>]*data-product="([^"]+)"[^]*?<\/a>/g)];
    assert.ok(cards.length, product.name);
    for (const [card, id] of cards) {
      const comingSoon = fullSizeProducts.some(other => other.id === id);
      assert.equal(card.includes('other-glove-status">Coming soon<'), comingSoon, `${product.name} → ${id}`);
    }
  }
});

test('the FAQ is reachable from the header and footer and answers every Phase 3 topic', () => {
  assert.match(renderer.header(), /<a href="\/faq" data-link>FAQ<\/a>/);
  assert.match(renderer.footer(), /<a href="\/faq" data-link>FAQ<\/a>/);
  const html = renderer.route('/faq');
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
  for (const topic of ['Sizing &amp; fit', 'Throwing hand', 'Trainer gloves', 'Break-in', 'Shipping', 'Returns &amp; exchanges', 'Free product', 'Warranty']) {
    assert.ok(html.includes(`<h2>${topic}</h2>`), topic);
  }
  const copy = text(html);
  for (const product of fullSizeProducts) assert.match(copy, new RegExp(`${product.name}: ${product.specs[0][1]}`));
  assert.match(copy, /right-hand throw glove is worn on the left hand/);
  assert.match(copy, /30 days of delivery/);
  assert.match(copy, /1-year limited warranty/);
  assert.match(copy, /Why does the full-size Full-Service Break-In cost more\?/);
  assert.match(copy, /arrives formed for you instead of just softened/);
  assert.match(copy, /For exchange requests, contact the ANAWIN team at support@anawinofficial\.com\./);
  assert.doesNotMatch(copy, /same requirements as a return/);
  assert.match(html, /<a href="https:\/\/discord\.com\/invite\/[^"]+" target="_blank" rel="noreferrer">Join the ANAWIN Discord<\/a>/);
  assert.match(copy, /Firm \(40%\), Medium \(65%\), Game Ready \(90%\)/);
});

test('the About page tells one origin story and links shoppers onward', () => {
  const html = renderer.route('/about');
  assert.equal((html.match(/sixth grade/g) || []).length, 1);
  assert.equal((html.match(/<h2[^>]*>OUR STORY<\/h2>/g) || []).length, 1);
  assert.ok(html.includes('<p><strong>We’re building ANAWIN from the ground up, and we’ve been documenting each and every step. We want you to be part of the journey and what comes next.</strong></p>'));
  assert.ok(!html.includes('It was built with them.'));
  assert.match(html, /HOW WE<br>BUILD GLOVES/);
  for (const path of ['/shop', '/faq', '/community']) assert.match(html, new RegExp(`class="about-next"[^]*href="${path}"`));
});

test('full-size pitches name models and make no unsupported performance promises', () => {
  for (const product of fullSizeProducts) {
    assert.doesNotMatch(product.pitch, /swallow every ball|\b(?:Mint|Black|Camel|Orange) is\b|than Camel/, product.name);
  }
});
