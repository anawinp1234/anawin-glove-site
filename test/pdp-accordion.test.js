import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { breakInService, fullSizeProducts, localProducts } from '../src/catalog.js';
import { createStorefrontRenderer } from '../src/storefront-render.js';
import { productInfo } from '../src/product-info.js';
import { installPdpAccordions } from '../src/pdp-accordion.js';
import { productPath } from '../src/seo.js';

const renderer = createStorefrontRenderer({ products: [...localProducts, ...fullSizeProducts], breakInService });
const allProducts = [...localProducts, ...fullSizeProducts];
const unescape = value => value.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

test('all seven PDPs render Size & Fit, Description, and Details collapsed and in order', () => {
  assert.equal(allProducts.length, 7);
  for (const product of allProducts) {
    const html = renderer.route(productPath(product));
    const section = html.match(/<section class="pdp-accordions"[\s\S]*?<\/section>/)?.[0];
    assert.ok(section, product.name);
    const headings = [...section.matchAll(/data-pdp-accordion>([^<]+)<svg/g)].map(match => unescape(match[1]));
    assert.deepEqual(headings, ['Size & Fit', 'Description', 'Details'], product.name);
    for (const id of ['size-fit', 'description', 'details']) {
      assert.match(section, new RegExp(`<button type="button" class="pdp-accordion-trigger" id="pdp-${id}-trigger" aria-expanded="false" aria-controls="pdp-${id}" data-pdp-accordion>`));
      assert.match(section, new RegExp(`<div class="pdp-accordion-panel" id="pdp-${id}" role="region" aria-labelledby="pdp-${id}-trigger" inert>`));
      assert.equal(html.split(`id="pdp-${id}"`).length, 2, `${product.name} ${id} is unique`);
    }
    assert.equal(html.split('class="pdp-accordions"').length, 2, product.name);
    assert.ok(html.indexOf('class="pdp-accordions"') > html.indexOf('class="add-button"'), product.name);
    const reviews = html.indexOf('class="pdp-reviews"');
    if (reviews >= 0) assert.ok(html.indexOf('class="pdp-accordions"') < reviews, product.name);
    assert.ok(html.indexOf('class="pdp-accordions"') < html.indexOf('class="other-gloves"'), product.name);
    assert.doesNotMatch(html, /The details|Glove specs|Product information <span/, product.name);
  }
});

test('accordion content is the model’s own approved copy', () => {
  for (const product of allProducts) {
    const info = productInfo[product.id];
    const section = renderer.route(productPath(product)).match(/<section class="pdp-accordions"[\s\S]*?<\/section>/)[0];
    const rows = [...section.matchAll(/<div><dt>([^<]+)<\/dt><dd>([^<]+)<\/dd><\/div>/g)].map(match => [unescape(match[1]), unescape(match[2])]);
    assert.deepEqual(rows, info.sizeFit.rows, product.name);
    const description = section.match(/id="pdp-description"[^>]*><div class="pdp-accordion-content"><p>([^<]+)<\/p>/)[1];
    assert.equal(unescape(description), info.description);
    assert.match(info.description, new RegExp(`\\b${product.name}\\b`));
    for (const other of allProducts.filter(other => other.id !== product.id)) assert.doesNotMatch(info.description, new RegExp(`\\b${other.name}\\b`));
    const details = [...section.match(/<ul>([\s\S]*?)<\/ul>/)[1].matchAll(/<li>([^<]+)<\/li>/g)].map(match => unescape(match[1]));
    assert.deepEqual(details, info.details, product.name);
    assert.equal(new Set(details).size, details.length, product.name);
  }
});

test('accordion facts agree with the catalog', () => {
  const row = (product, label) => productInfo[product.id].sizeFit.rows.find(([key]) => key === label)?.[1];
  for (const product of allProducts) {
    assert.deepEqual(productInfo[product.id].sizeFit.rows.slice(0, 2).map(([label]) => label), ['Size', 'Wrist fit'], product.name);
    assert.equal(row(product, 'Wrist fit'), 'Regular fit (7–7.5 inches)', product.name);
    assert.equal(productInfo[product.id].sizeFit.note, undefined, product.name);
  }
  for (const product of localProducts) {
    assert.equal(row(product, 'Size'), '10.25 inches');
    assert.equal(row(product, 'Throwing hand'), `${product.throwingHand}-hand throw`);
    assert.equal(row(product, 'Worn on'), `${product.wornOnHand} hand`);
    assert.equal(productInfo[product.id].details.at(-1), `${product.tone} colorway`);
  }
  assert.equal(productInfo.brown.details.at(-1), 'Brown / Dark Brown / Red colorway');
  for (const product of fullSizeProducts) {
    const spec = label => product.specs.find(([key]) => key === label)[1];
    assert.equal(row(product, 'Size'), spec('Size'), product.name);
    assert.equal(row(product, 'Position'), spec('Position'), product.name);
    const both = product.throwHands.length === 2;
    assert.equal(row(product, 'Throwing hand'), both ? 'Right-hand or left-hand throw' : 'Right-hand throw', product.name);
    assert.equal(row(product, 'Left-hand throw'), both ? 'Worn on right hand' : undefined, product.name);
    assert.equal(productInfo[product.id].details.at(-1), `${product.tone} colorway`);
    assert.ok(productInfo[product.id].details.includes(`${spec('Leather')} leather`), product.name);
  }
});

function fixture(ids = ['size-fit', 'description', 'details']) {
  const documentRef = { activeElement: null, getElementById: id => panels.get(id) };
  const node = () => {
    const attributes = new Map();
    const classes = new Set();
    const clicks = new Set();
    const style = new Map();
    return { attributes, classes, clicks, inert: true, offsetHeight: 0,
      style: { get transition() { return style.get('transition') || ''; }, set transition(value) { style.set('transition', value); }, removeProperty: key => style.delete(key) },
      setAttribute: (key, value) => attributes.set(key, value), getAttribute: key => attributes.get(key),
      classList: { toggle: (value, on) => on ? classes.add(value) : classes.delete(value) },
      addEventListener: (_, fn) => clicks.add(fn), removeEventListener: (_, fn) => clicks.delete(fn),
      click: () => { for (const fn of clicks) fn(); }, focus() { documentRef.activeElement = this; }
    };
  };
  const panels = new Map();
  const items = ids.map(id => {
    const trigger = node(), panel = node(), inner = node();
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', `pdp-${id}`);
    panel.id = `pdp-${id}`;
    panel.contains = element => element === inner;
    panels.set(panel.id, panel);
    return { trigger, panel, inner };
  });
  const root = { querySelectorAll: () => items.map(item => item.trigger) };
  return { root, documentRef, items };
}

test('sections open and close independently and stay inert while collapsed', () => {
  const { root, documentRef, items } = fixture();
  const open = new Set();
  installPdpAccordions(root, { open, documentRef });
  assert.ok(items.every(({ panel }) => panel.inert));
  items[0].trigger.click();
  items[2].trigger.click();
  assert.deepEqual(items.map(({ trigger }) => trigger.getAttribute('aria-expanded')), ['true', 'false', 'true']);
  assert.deepEqual(items.map(({ panel }) => panel.inert), [false, true, false]);
  assert.deepEqual(items.map(({ panel }) => panel.classes.has('is-expanded')), [true, false, true]);
  assert.deepEqual([...open], ['pdp-size-fit', 'pdp-details']);
  items[0].trigger.click();
  assert.equal(items[0].trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(items[2].trigger.getAttribute('aria-expanded'), 'true');
  assert.deepEqual([...open], ['pdp-details']);
});

test('collapsing a section with focus inside returns focus to its header', () => {
  const { root, documentRef, items } = fixture();
  installPdpAccordions(root, { documentRef });
  items[1].trigger.click();
  documentRef.activeElement = items[1].inner;
  items[1].trigger.click();
  assert.equal(documentRef.activeElement, items[1].trigger);
});

test('a re-render restores open sections without animating, and destroy removes listeners', () => {
  const { root, documentRef, items } = fixture();
  const destroy = installPdpAccordions(root, { open: new Set(['pdp-description']), documentRef });
  assert.deepEqual(items.map(({ trigger }) => trigger.getAttribute('aria-expanded')), ['false', 'true', 'false']);
  assert.equal(items[1].panel.inert, false);
  assert.equal(items[1].panel.style.transition, '');
  destroy();
  assert.ok(items.every(({ trigger }) => trigger.clicks.size === 0));
  assert.doesNotThrow(() => installPdpAccordions(null, { documentRef })());
});

test('accordion motion is brief and honors reduced motion', () => {
  const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.pdp-accordion-panel\{display:grid;grid-template-rows:0fr;visibility:hidden;transition:grid-template-rows 180ms ease,visibility 180ms\}/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)\{\s*\.pdp-accordion-chevron,\.pdp-accordion-panel\{transition:none\}/);
  assert.match(css, /\.pdp-accordion-trigger:focus-visible\{outline:2px solid var\(--ink\)/);
});
