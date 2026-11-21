import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  breakInService, fullSizeBreakInService, fullSizeProducts, localProducts, PREORDER_BREAK_IN_NOTE, PREORDER_BREAK_IN_TIMING,
  preorderOrderAttributeValue, preorderState
} from '../src/catalog.js';
import { createStorefrontRenderer, escapeHtml, fullSizeSetupDetails, money } from '../src/storefront-render.js';
import { cartPreorderSummary, renderCartPreorderDisclosure, renderCartRow } from '../src/cart-row.js';
import { createBreakInEditor, renderBreakInEditor } from '../src/cart-break-in-editor.js';
import {
  preorderFaqItems, preorderOrderedNote, preorderPlacedOrderFaqItems, preorderProcessingNote, preorderShippingSection
} from '../src/policy-content.js';
import { productPath } from '../src/seo.js';

// The 1–3 business day promise covers in-stock orders only. Preorder gloves follow their Shopify-confirmed
// estimate; break-in time comes on top of it, and only for the glove receiving the service.
const ESTIMATE = 'December 4-10, 2026';
const LATER = 'January 8-14, 2027';
const variants = [{ id: 'gid://variant/right', availableForSale: true, selectedOptions: [{ name: 'Throwing Hand', value: 'Right' }], price: { amount: '295.00', currencyCode: 'USD' } }];
const live = (product, overrides = {}) => ({ ...product, available: true, variants, merchandiseId: variants[0].id, shopifyPreorderShipEstimate: ESTIMATE, ...overrides });
const confirmed = fullSizeProducts.map(product => live(product));
const renderer = (fullSize, extra = {}) => createStorefrontRenderer({ products: [...localProducts, ...fullSize], breakInService,
  fullSizeService: { ...fullSizeBreakInService, available: true }, ...extra });
const active = renderer(confirmed);
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const processingSection = html => text(html.match(/<section><h2>Processing Times<\/h2>.*?<\/section>/)[0]);
const orderTimingAnswer = html => text(html.match(/How long will my order take\?<\/h3>.*?<\/div>/)[0]);
const preorderPolicy = html => text(html.match(/<section class="preorder-policy">.*?<\/section>/)?.[0] || '');
const breakInTiming = html => html.match(/id="full-size-break-in-timing">([^<]*)</)[1];
const NEW_PREORDER = /paid in full|How do I pay for a preorder|What does Preorder mean|marked Preorder|Estimated to ship:/;

// Shopify can fail to confirm a configured preorder in several ways; each must fail closed on the PDP
// while the policy keeps placed-order guidance.
const unconfirmed = {
  'no sellable variants': renderer(confirmed.map(product => ({ ...product, available: false, variants: variants.map(variant => ({ ...variant, availableForSale: false })) }))),
  'missing Shopify estimate': renderer(confirmed.map(product => ({ ...product, shopifyPreorderShipEstimate: null }))),
  'mismatched estimate': renderer(confirmed.map(product => ({ ...product, shopifyPreorderShipEstimate: LATER }))),
  'Shopify error': renderer(confirmed, { commerceError: 'Shopify unavailable' }),
  'Shopify loading': renderer(fullSizeProducts, { commerceLoading: true })
};

test('the 1–3 business day processing promise is scoped to in-stock orders in every state', () => {
  for (const [state, view] of Object.entries({ active, ...unconfirmed })) {
    for (const html of [view.route('/shipping'), view.route('/faq')]) {
      assert.match(html, /In-stock orders are processed within 1–3 business days\./, state);
      assert.doesNotMatch(text(html), /(?<!In-stock )\b[Oo]rders are processed within 1–3/, state);
    }
    assert.match(processingSection(view.route('/shipping')), /Break-In Service adds 2–5 business days to in-stock orders\..*Business days exclude weekends and holidays\./, state);
    assert.match(orderTimingAnswer(view.route('/faq')), /Break-In Service adds 2–5 business days to in-stock orders\./, state);
    // The processing-time answers never state generic break-in timing without the in-stock scope.
    assert.doesNotMatch(processingSection(view.route('/shipping')) + orderTimingAnswer(view.route('/faq')), /Break-In Service adds 2–5 business days(?! to in-stock orders)/, state);
  }
});

test('free U.S. shipping and the 3–7 business day delivery estimate are unchanged', () => {
  const shipping = active.route('/shipping');
  assert.match(shipping, /<section><h2>United States<\/h2><p>Standard Shipping — FREE<\/p><\/section>/);
  assert.match(shipping, /U\.S\. standard shipping is typically delivered in 3–7 business days after shipment\./);
  assert.match(active.route('/faq'), /U\.S\. standard shipping usually arrives 3–7 business days after the order ships\./);
});

test('preorder guidance never hard-codes a date and never says break-in time is included or guaranteed', () => {
  const copy = [preorderProcessingNote, preorderOrderedNote, ...preorderShippingSection.paragraphs, ...preorderShippingSection.placedOrderParagraphs,
    ...[...preorderFaqItems, ...preorderPlacedOrderFaqItems].flatMap(item => item.paragraphs)].join('\n');
  assert.doesNotMatch(copy, /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b|\b20\d\d\b/);
  assert.doesNotMatch(copy, /includ(es|ed|ing) (the )?Break-In|Break-In[^.]*included|Christmas|guarantee/i);
  assert.equal(PREORDER_BREAK_IN_NOTE, 'Break-In Service may add 2–5 business days beyond the estimated ship window for the glove receiving the service.');
  for (const paragraphs of [preorderShippingSection.paragraphs, preorderShippingSection.placedOrderParagraphs, preorderFaqItems[1].paragraphs, preorderPlacedOrderFaqItems[0].paragraphs]) {
    assert.equal(paragraphs.filter(paragraph => paragraph.includes(PREORDER_BREAK_IN_NOTE)).length, 1);
    // Tied to adding the service, never a delay for every preorder glove.
    assert.match(paragraphs.find(paragraph => paragraph.includes(PREORDER_BREAK_IN_NOTE)), /^If you add Break-In Service/);
  }
});

test('with a confirmed preorder the processing times point to the detailed Preorders section', () => {
  const shipping = active.route('/shipping');
  const faq = active.route('/faq');
  for (const copy of [processingSection(shipping), orderTimingAnswer(faq)]) {
    assert.ok(copy.includes(preorderProcessingNote));
    assert.ok(copy.indexOf('In-stock orders') < copy.indexOf(preorderProcessingNote));
    assert.ok(!copy.includes(preorderOrderedNote));
  }
  assert.ok(preorderPolicy(shipping).includes(PREORDER_BREAK_IN_NOTE));
  assert.match(text(faq), new RegExp(`When will my preorder ship\\?.*${PREORDER_BREAK_IN_NOTE.replace(/[.]/g, '\\.')}`));
  assert.doesNotMatch(text(shipping + faq), /December|2026|Christmas|guarantee/i);
});

test('policy guidance stays visible after availability failures without offering a new preorder', () => {
  for (const [state, view] of Object.entries(unconfirmed)) {
    const shipping = view.route('/shipping');
    const faq = view.route('/faq');
    assert.ok(processingSection(shipping).includes(preorderProcessingNote), state);
    assert.ok(orderTimingAnswer(faq).includes(preorderProcessingNote), state);
    assert.ok(preorderPolicy(shipping).startsWith(` Preorders ${preorderOrderedNote}`), state);
    assert.ok(preorderPolicy(shipping).includes(PREORDER_BREAK_IN_NOTE), state);
    assert.match(text(faq), /Preorders When will my preorder ship\? If you ordered a preorder glove/, state);
    assert.ok(text(faq).includes(PREORDER_BREAK_IN_NOTE), state);
    assert.doesNotMatch(shipping + faq, NEW_PREORDER, state);
    assert.doesNotMatch(text(shipping + faq), /December|2026|2027/, state);
  }
});

test('unconfirmed full-size pages keep the Shopify gate: no Preorder button, no stale estimate', () => {
  for (const [state, view] of Object.entries(unconfirmed)) {
    for (const product of fullSizeProducts) {
      const html = view.route(productPath(product));
      assert.doesNotMatch(html, new RegExp(`data-add="${product.id}"`), `${state}: ${product.name}`);
      if (state === 'Shopify loading') {
        // The approved catalog estimate reads as a preorder while Shopify loads; the button stays disabled.
        assert.match(html, /<button type="button" class="add-button" disabled aria-busy="true"[^>]*>Preorder<\/button>/);
        assert.equal(breakInTiming(html), PREORDER_BREAK_IN_NOTE);
      } else {
        assert.match(html, /isn’t available to order right now[\s\S]*>Unavailable<\/button>/, `${state}: ${product.name}`);
        assert.doesNotMatch(html, /Estimated to ship:|December|2027/, `${state}: ${product.name}`);
        assert.equal(breakInTiming(html), 'Adds 2–5 business days', `${state}: ${product.name}`);
        assert.doesNotMatch(html, /data-full-size-setup-summary[^>]*data-preorder/);
      }
    }
  }
});

test('all seven product pages keep their purchasing behavior and only trainers promise 1–3 day processing', () => {
  for (const product of localProducts) {
    const html = active.route(productPath(product));
    assert.match(html, new RegExp(`class="add-button" data-add="${product.id}"`), product.name);
    assert.match(html, /Processes in 1–3 business days/, product.name);
    assert.match(html, /In-stock orders process in 1–3 business days; Break-In Service adds 2–5 business days\./, product.name);
    assert.match(html, /id="break-in-timing">Adds 2–5 business days\.</, product.name);
    assert.doesNotMatch(html, /estimated ship window/, product.name);
  }
  for (const product of fullSizeProducts) {
    const html = active.route(productPath(product));
    assert.match(html, new RegExp(`class="add-button" data-add="${product.id}"[^>]*>Preorder</button>`), product.name);
    assert.match(html, /Estimated to ship: December 4-10, 2026/, product.name);
    assert.doesNotMatch(html, /1–3 business days/, product.name);
    assert.equal(breakInTiming(html), PREORDER_BREAK_IN_NOTE, product.name);
    assert.match(html, /data-full-size-setup-summary[^>]*data-preorder/, product.name);
  }
});

test('mixed active and blocked preorder models: each page follows its own Shopify state', () => {
  const [mint, black, ...rest] = confirmed;
  const view = renderer([mint, { ...black, shopifyPreorderShipEstimate: null }, ...rest]);
  assert.match(view.route(productPath(mint)), new RegExp(`data-add="${mint.id}"[^>]*>Preorder</button>`));
  assert.match(view.route(productPath(black)), />Unavailable<\/button>/);
  assert.doesNotMatch(view.route(productPath(black)), /Estimated to ship:/);
  // One active preorder is enough for the full policy.
  assert.ok(processingSection(view.route('/shipping')).includes(preorderProcessingNote));
  assert.match(view.route('/faq'), /How do I pay for a preorder\?/);
  const disclosure = renderCartPreorderDisclosure(cartPreorderSummary([mint, { ...black, shopifyPreorderShipEstimate: null }]), escapeHtml);
  assert.match(disclosure, /BL50 isn’t available to order right now/);
});

test('two distinct Shopify-confirmed estimates stay attached to their own gloves', () => {
  const [mint, black, ...rest] = confirmed;
  const later = { ...black, preorder: { enabled: true, shipEstimate: LATER }, shopifyPreorderShipEstimate: LATER };
  const view = renderer([mint, later, ...rest]);
  assert.match(view.route(productPath(mint)), /Estimated to ship: December 4-10, 2026/);
  assert.match(view.route(productPath(later)), /Estimated to ship: January 8-14, 2027/);
  assert.doesNotMatch(view.route(productPath(later)), /December 4-10/);
  const disclosure = renderCartPreorderDisclosure(cartPreorderSummary([mint, later, localProducts[0]]), escapeHtml);
  assert.match(disclosure, /<li>MI26: Preorder · Estimated to ship: December 4-10, 2026<\/li><li>BL50: Preorder · Estimated to ship: January 8-14, 2027<\/li>/);
  const lines = [{ productId: mint.id }, { productId: later.id }];
  assert.equal(preorderOrderAttributeValue(lines, id => [mint, later].find(product => product.id === id)), 'BL50: January 8-14, 2027; MI26: December 4-10, 2026');
  assert.doesNotMatch(text(view.route('/shipping') + view.route('/faq')), /December|January|2026|2027/);
});

test('the full-size setup summary adds preorder break-in timing only once break-in is selected', () => {
  const base = { model: 'MI26', hand: 'Right-Hand Throw', wrist: 'Regular', servicePrice: 75, total: 295 };
  const breakIn = { placement: 'Traditional — index finger in', closure: 'Pinky', shaping: [['Thumb', 'None']], firmness: 'Medium', notes: '' };
  assert.doesNotMatch(fullSizeSetupDetails({ ...base, preorder: true, breakIn: null }).rows, /business days/);
  assert.ok(fullSizeSetupDetails({ ...base, preorder: true, breakIn }).rows.includes(`<small>${PREORDER_BREAK_IN_TIMING}</small>`));
  assert.ok(fullSizeSetupDetails({ ...base, preorder: false, breakIn }).rows.includes('<small>Adds 2–5 business days</small>'));
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(main, /const preorder = summary\.hasAttribute\('data-preorder'\);/);
  assert.match(main, /\$\{preorder \? PREORDER_BREAK_IN_TIMING : 'Adds 2–5 business days'\}/);
});

test('the cart break-in editor describes preorder timing for confirmed preorders only', () => {
  const editor = (type, mode) => { const breakInEditor = createBreakInEditor(); breakInEditor.open('glove-1', 'x', { type, mode }); return breakInEditor.state; };
  const priceNote = (product, type, mode, quantity = 1) => renderBreakInEditor({ product, line: { remoteLineId: 'glove-1', quantity }, editor: editor(type, mode),
    serviceProduct: { price: type === 'full-size' ? 75 : 20, currencyCode: 'USD', available: true }, busy: false, incomplete: false, money, escapeHtml })
    .match(/id="cart-service-editor-price">(.*?)<\/p>/)[1];
  const preorder = confirmed[0];
  assert.equal(preorderState(preorder).status, 'active');
  assert.equal(priceNote(preorder, 'full-size', 'add'), `Full-size break-in <strong>+$75</strong> · ${PREORDER_BREAK_IN_NOTE}`);
  assert.equal(priceNote(preorder, 'full-size', 'edit'), `Changing your choices doesn’t change the price. ${PREORDER_BREAK_IN_NOTE}`);
  assert.equal(priceNote(preorder, 'full-size', 'edit', 2), `Only this glove changes. The price stays the same. ${PREORDER_BREAK_IN_NOTE}`);
  assert.equal(priceNote(localProducts[0], 'trainer', 'add'), 'Break-in service <strong>+$20</strong> · Adds 2–5 business days.');
  assert.equal(priceNote(localProducts[0], 'trainer', 'edit'), 'Changing your choices doesn’t change the price.');
  assert.equal(priceNote({ ...preorder, shopifyPreorderShipEstimate: null }, 'full-size', 'add'), 'Full-size break-in <strong>+$75</strong> · Adds 2–5 business days.');
});

test('a mixed cart pairs each break-in with its own glove and marks only the preorder glove', () => {
  const row = (product, id, service) => renderCartRow({ product, line: { remoteLineId: id, productId: product.id, quantity: 1, lineTotal: { amount: product.price, currencyCode: 'USD' }, attributes: [], instructions: { canUpdateQuantity: true } },
    service: service ? { parentLineId: id, quantity: 1, lineTotal: { amount: service, currencyCode: 'USD' }, attributes: [], instructions: { canRemove: true, canUpdateQuantity: true } } : null,
    mode: 'shopify', serviceProduct: { price: service || 20, currencyCode: 'USD', available: true }, busy: false, incomplete: false, money, escapeHtml });
  const preorderWithService = row(confirmed[0], 'glove-1', 75);
  const trainerWithService = row(localProducts[0], 'glove-2', 20);
  const preorderWithout = row(confirmed[1], 'glove-3', null);
  assert.match(preorderWithService, /cart-preorder-note">Preorder · Estimated to ship: December 4-10, 2026[\s\S]*Break-in service · \$75 \(included\)/);
  assert.match(trainerWithService, /Break-in service · \$20 \(included\)/);
  assert.doesNotMatch(trainerWithService, /Preorder|Estimated to ship/);
  assert.match(preorderWithout, /cart-preorder-note">Preorder · Estimated to ship: December 4-10, 2026/);
  assert.doesNotMatch(preorderWithout, /\(included\)|estimated ship window/);
  const disclosure = renderCartPreorderDisclosure(cartPreorderSummary([localProducts[0], confirmed[0], confirmed[1]]), escapeHtml);
  assert.match(disclosure, /Other items in your cart are not preorders\./);
  assert.doesNotMatch(disclosure, /1–3 business days|estimated ship window/);
});

// The live Shopify order confirmation does not show the preorder estimate, so no copy may point there for it.
test('no policy or FAQ copy says the order confirmation shows the preorder estimate', () => {
  const copy = [...preorderShippingSection.paragraphs, ...preorderShippingSection.placedOrderParagraphs,
    ...[...preorderFaqItems, ...preorderPlacedOrderFaqItems].flatMap(item => item.paragraphs), preorderProcessingNote, preorderOrderedNote].join('\n');
  assert.doesNotMatch(copy, /order confirmation|confirmation email/i);
  for (const view of [active, ...Object.values(unconfirmed)]) {
    assert.doesNotMatch(text(view.route('/shipping') + view.route('/faq')), /order confirmation|confirmation email/i);
  }
  assert.match(preorderOrderedNote, /email support@anawinofficial\.com with your order number/);
});

// Existing preorder customers get the same support route whether or not Shopify confirms a preorder.
test('the preorder support guidance appears once on the FAQ and Shipping Policy in active and unavailable states', () => {
  const support = 'If you ordered a preorder glove and need its estimated ship window, email support@anawinofficial.com with your order number.';
  assert.equal(preorderOrderedNote, support);
  for (const [state, view] of Object.entries({ active, ...unconfirmed })) {
    for (const page of ['/shipping', '/faq']) {
      const copy = text(view.route(page));
      assert.equal(copy.split(support).length - 1, 1, `${state} ${page}`);
    }
    assert.ok(preorderPolicy(view.route('/shipping')).includes(support), `${state}: in the Preorders section`);
    assert.match(text(view.route('/faq')), new RegExp(`When will my preorder ship\\?[^?]*${support.replace(/[.]/g, '\\.')}`), `${state}: in the FAQ answer`);
  }
});
