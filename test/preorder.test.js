import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  breakInService, fullSizeBreakInService, fullSizeProducts, localProducts, preorderCartNote, preorderConfigured,
  preorderShipLine, preorderState, PREORDER_CHECKOUT, PREORDER_LABEL, PREORDER_METAFIELD, PREORDER_PAYMENT_NOTE
} from '../src/catalog.js';
import { createStorefrontRenderer, escapeHtml, cartMoney } from '../src/storefront-render.js';
import { cartPreorderSummary, renderCartPreorderDisclosure, renderCartRow } from '../src/cart-row.js';
import { productPath } from '../src/seo.js';

// An owner-style example estimate. No real product is configured with it.
const ESTIMATE = 'first week of December 2026';
const mint = fullSizeProducts.find(product => product.id === 'full-mint');
const variants = [
  { id: 'gid://variant/mi26-right', availableForSale: true, selectedOptions: [{ name: 'Throwing Hand', value: 'Right' }], price: { amount: '295.00', currencyCode: 'USD' } },
  { id: 'gid://variant/mi26-left', availableForSale: true, selectedOptions: [{ name: 'Throwing Hand', value: 'Left' }], price: { amount: '295.00', currencyCode: 'USD' } }
];
const preorderMint = (overrides = {}) => ({ ...mint, comingSoon: false, preorder: { enabled: true, shipEstimate: ESTIMATE },
  available: true, variants, merchandiseId: variants[0].id, shopifyPreorderShipEstimate: ESTIMATE, ...overrides });
const renderer = (products, extra = {}) => createStorefrontRenderer({ products: [...localProducts, ...products], breakInService,
  fullSizeService: { ...fullSizeBreakInService, available: true }, ...extra });
const pdp = (product, extra) => renderer([product], extra).route(productPath(product));


test('shared preorder copy matches the cross-agent contract exactly', () => {
  assert.equal(PREORDER_LABEL, 'Preorder');
  assert.equal(preorderShipLine(ESTIMATE), 'Estimated to ship: first week of December 2026');
  assert.equal(preorderCartNote(ESTIMATE), 'Preorder · Estimated to ship: first week of December 2026');
  assert.deepEqual({ ...PREORDER_METAFIELD }, { namespace: 'custom', key: 'preorder_ship_estimate' });
});

const LAUNCH_ESTIMATE = 'December 4-10, 2026';

test('production catalog launches every full-size model as a preorder with one approved estimate', () => {
  assert.equal(fullSizeProducts.length, 4);
  assert.equal(PREORDER_CHECKOUT.chargedInFullAtCheckout, true);
  for (const product of fullSizeProducts) {
    assert.equal(product.comingSoon, false, product.name);
    assert.deepEqual(product.preorder, { enabled: true, shipEstimate: LAUNCH_ESTIMATE }, product.name);
    assert.equal(preorderConfigured(product), true);
    assert.deepEqual(preorderState({ ...product, available: true, shopifyPreorderShipEstimate: LAUNCH_ESTIMATE }), { status: 'active', estimate: LAUNCH_ESTIMATE });
    // Shopify must still confirm the same estimate.
    assert.equal(preorderState({ ...product, available: true, shopifyPreorderShipEstimate: null }).status, 'blocked');
  }
  for (const product of localProducts) assert.equal(preorderState(product).status, 'inactive', product.name);
});

test('production full-size pages sell as preorders only once Shopify confirms them', () => {
  const confirmed = renderer(fullSizeProducts.map(product => ({ ...product, available: true, variants, shopifyPreorderShipEstimate: LAUNCH_ESTIMATE })));
  for (const product of fullSizeProducts) {
    const html = confirmed.route(productPath(product));
    assert.match(html, /<p class="price">\$295<\/p><p class="preorder-status"><span class="preorder-badge">Preorder<\/span><\/p>/, product.name);
    assert.match(html, /Estimated to ship: December 4-10, 2026/);
    assert.match(html, new RegExp(`class="add-button" data-add="${product.id}"[^>]*>Preorder</button>`));
  }
  assert.equal((confirmed.route('/shop').match(/>Preorder</g) || []).length, 4);
  for (const views of [renderer([]), renderer(fullSizeProducts.map(product => ({ ...product, available: true, variants })))]) {
    for (const product of fullSizeProducts) {
      const html = views.route(productPath(product));
      assert.match(html, /class="add-button" disabled[^>]*>Unavailable<\/button>/, product.name);
      assert.doesNotMatch(html, /data-add=|Estimated to ship/);
    }
  }
  assert.match(renderer([], { commerceLoading: true }).route('/product/mi26'), /class="add-button" disabled aria-busy="true"[^>]*>Preorder<\/button>/);
  for (const path of ['/', '/product/br16']) assert.doesNotMatch(confirmed.route(path), /Estimated to ship/i, path);
});

test('preorder is active only with every condition met, and fails closed otherwise', () => {
  assert.deepEqual(preorderState(preorderMint()), { status: 'active', estimate: ESTIMATE });
  assert.deepEqual(preorderState(preorderMint({ preorder: { enabled: true, shipEstimate: `  ${ESTIMATE} ` } })), { status: 'active', estimate: ESTIMATE });
  assert.deepEqual(preorderState(preorderMint({ shopifyPreorderShipEstimate: `  ${ESTIMATE}  ` })), { status: 'active', estimate: ESTIMATE });
  for (const [overrides, reason] of [
    [{ preorder: { enabled: true, shipEstimate: null } }, 'missing-estimate'],
    [{ preorder: { enabled: true, shipEstimate: '   ' } }, 'missing-estimate'],
    [{ preorder: { enabled: true } }, 'missing-estimate'],
    [{ shopifyPreorderShipEstimate: null }, 'missing-shopify-estimate'],
    [{ shopifyPreorderShipEstimate: '  ' }, 'missing-shopify-estimate'],
    [{ available: false }, 'unavailable'],
    [{ available: undefined }, 'unavailable'],
    [{ shopifyPreorderShipEstimate: 'mid-December 2026' }, 'estimate-mismatch'],
    [{ shopifyPreorderShipEstimate: 'First week of December 2026' }, 'estimate-mismatch'],
    [{ preorder: { enabled: false, shipEstimate: ESTIMATE }, shopifyPreorderShipEstimate: ESTIMATE }, 'not-enabled'],
    [{ preorder: undefined, shopifyPreorderShipEstimate: ESTIMATE }, 'not-enabled']
  ]) assert.deepEqual(preorderState(preorderMint(overrides)), { status: 'blocked', reason }, JSON.stringify(overrides));
  // Unconfirmed full payment at checkout blocks every otherwise-valid preorder and its catalog offer.
  PREORDER_CHECKOUT.chargedInFullAtCheckout = false;
  try {
    assert.deepEqual(preorderState(preorderMint()), { status: 'blocked', reason: 'payment-unverified' });
    assert.equal(preorderConfigured(preorderMint()), false);
  } finally { PREORDER_CHECKOUT.chargedInFullAtCheckout = true; }
  // Not a preorder at all: Coming Soon, or a normal launch without preorder config or Shopify estimate.
  assert.equal(preorderState(preorderMint({ comingSoon: true })).status, 'inactive');
  assert.equal(preorderState(preorderMint({ preorder: { enabled: false, shipEstimate: null }, shopifyPreorderShipEstimate: null })).status, 'inactive');
  assert.equal(preorderState(preorderMint({ preorder: { enabled: 'yes', shipEstimate: ESTIMATE }, shopifyPreorderShipEstimate: null })).status, 'inactive');
  assert.equal(preorderConfigured(preorderMint({ available: false })), true, 'catalog configuration ignores Shopify data');
});

test('an active preorder PDP shows the status, Preorder button and estimate beside the purchase controls', () => {
  const html = pdp(preorderMint());
  assert.match(html, /<p class="price">\$295<\/p><p class="preorder-status"><span class="preorder-badge">Preorder<\/span><\/p>/);
  assert.match(html, /<p data-full-size-error role="alert" tabindex="-1" hidden><\/p>\s*<p id="full-size-ship-estimate" class="preorder-ship-estimate">Estimated to ship: first week of December 2026<\/p>\s*<p id="full-size-payment-note" class="preorder-payment-note">Preorders are paid in full at checkout, the same as in-stock items.<\/p>\s*<button type="button" class="add-button" data-add="full-mint" aria-describedby="full-size-ship-estimate full-size-payment-note full-size-setup-summary">Preorder<\/button>/);
  assert.doesNotMatch(html, /coming-soon-price|Add to cart|Get notified at launch|when this glove launches/);
  assert.doesNotMatch(html, /in stock|ships now|ready to ship|only \d+ left|hurry|limited time|countdown/i);
  // Throw hand, wrist fit and full-size break-in customization are unchanged.
  assert.match(html, /name="full-size-throw-hand" value="Right-Hand Throw \(worn on left hand\)"/);
  assert.match(html, /name="full-size-throw-hand" value="Left-Hand Throw \(worn on right hand\)"/);
  assert.match(html, /name="wrist-fit" value="regular" checked/);
  assert.match(html, /<input type="checkbox" data-full-size-break-in  aria-controls="full-size-break-in-options"/);
  assert.match(html, /data-full-size-setup-summary data-price="295"/);
  assert.equal((html.match(/Estimated to ship:/g) || []).length, 1);
});

test('a Shopify price stays authoritative on the preorder page', () => {
  assert.match(pdp(preorderMint({ price: 295 })), /<p class="price">\$295<\/p>[\s\S]*data-price="295"/);
});

test('blocked preorders render a calm unavailable state without Preorder or an estimate', () => {
  for (const overrides of [
    { preorder: { enabled: true, shipEstimate: null } }, { available: false },
    { shopifyPreorderShipEstimate: 'mid-December 2026' }, { preorder: { enabled: false, shipEstimate: null }, shopifyPreorderShipEstimate: ESTIMATE }
  ]) {
    const html = pdp(preorderMint(overrides));
    assert.match(html, /<p class="coming-soon-price">Currently unavailable<\/p>/);
    assert.match(html, /<p id="full-size-preorder-status" class="purchase-status">MI26 isn’t available to order right now\. Sign up below to hear when it is\.<\/p>\s*<button type="button" class="add-button" disabled aria-describedby="full-size-preorder-status full-size-setup-summary">Unavailable<\/button>/);
    assert.match(html, /<input type="checkbox" data-full-size-break-in disabled/);
    assert.match(html, /Get notified at launch/);
    assert.doesNotMatch(html, /data-add=|Preorder|Estimated to ship|preorder-ship-estimate/);
  }
  const errored = pdp(preorderMint(), { commerceError: 'Shopify is unavailable.' });
  assert.match(errored, />Unavailable<\/button>/);
  assert.doesNotMatch(errored, /data-add=|Estimated to ship/);
});

test('while Shopify is loading a configured preorder reads as a preorder but cannot be added yet', () => {
  const html = pdp(preorderMint({ available: undefined, shopifyPreorderShipEstimate: undefined }), { commerceLoading: true });
  assert.match(html, /<p class="preorder-status"><span class="preorder-badge">Preorder<\/span><\/p>/);
  assert.match(html, /Estimated to ship: first week of December 2026/);
  assert.match(html, /Preorders are paid in full at checkout/);
  assert.match(html, /<button type="button" class="add-button" disabled aria-busy="true" aria-describedby="full-size-ship-estimate full-size-payment-note full-size-setup-summary">Preorder<\/button>/);
  assert.doesNotMatch(html, /data-add=|Get notified at launch|Available to add when this glove launches|Coming soon<\/p>|Unavailable/);
  // Without an approved catalog estimate there is nothing to show yet.
  const unset = pdp(preorderMint({ available: undefined, preorder: { enabled: true, shipEstimate: null } }), { commerceLoading: true });
  assert.match(unset, /<button type="button" class="add-button" disabled aria-describedby="full-size-setup-summary">Checking availability…<\/button>/);
  assert.doesNotMatch(unset, /data-add=|preorder-badge|Estimated to ship|>Preorder<\/button>/);
});

test('cards and related links say Preorder only for a Shopify-confirmed preorder', () => {
  const views = renderer([preorderMint()]);
  const shop = views.route('/shop');
  assert.match(shop, /data-product="full-mint"[\s\S]*?class="coming-soon-label">Preorder</);
  assert.equal((shop.match(/class="coming-soon-label">Coming soon</g) || []).length, 3);
  assert.match(shop, /<p class="collection-cue">4 full-size gloves<\/p>/);
  assert.match(views.route('/product/ob16'), /<strong>MI26<\/strong>[^]*?<small class="other-glove-status">Preorder<\/small>/);
  const blocked = renderer([preorderMint({ available: false })]).route('/shop');
  assert.doesNotMatch(blocked, /Preorder/);
  // While Shopify loads, the launched catalog's cards already read Preorder (they are links, not purchase controls).
  const loading = renderer([], { commerceLoading: true }).route('/shop');
  assert.equal((loading.match(/class="coming-soon-label">Preorder</g) || []).length, 4);
  assert.match(loading, /<p class="collection-cue">4 full-size gloves<\/p>/);
});

test('trainer pages are unaffected by full-size preorder state', () => {
  const plain = renderer([]);
  const withPreorder = renderer([preorderMint()]);
  for (const path of ['/product/br16', '/product/ob16']) {
    const html = withPreorder.route(path);
    assert.match(html, /data-add="(black|blue)"[^>]*>Add to cart <span data-add-price>\$155<\/span>/);
    assert.doesNotMatch(html.replace(/<section class="other-gloves"[\s\S]*$/, ''), /Preorder|Estimated to ship/);
  }
  assert.equal(withPreorder.route('/product/cl16'), plain.route('/product/cl16'));
});

const money = cartMoney;
const line = (id, productId, total) => ({ remoteLineId: id, productId, quantity: 1, attributes: [],
  lineTotal: { amount: total, currencyCode: 'USD' }, instructions: { canUpdateQuantity: true } });
const row = (product, cartLine) => renderCartRow({ product, line: cartLine, service: null, mode: 'shopify',
  serviceProduct: { ...fullSizeBreakInService, available: true }, busy: false, incomplete: false, money, escapeHtml });
const trainer = { ...localProducts.find(product => product.id === 'blue'), available: true };

test('cart rows mark only the preorder glove, derived from product data rather than line attributes', () => {
  const preorderLine = { ...line('glove-1', 'full-mint', 295), throwingHand: 'Right' };
  const html = row(preorderMint(), preorderLine);
  assert.match(html, /<h3>MI26<\/h3><p>Mint \/ Silver<\/p><p class="cart-preorder-note">Preorder · Estimated to ship: first week of December 2026<\/p><p>Throwing Hand: Right<\/p>/);
  assert.deepEqual(preorderLine.attributes, [], 'no attribute was added to the glove line');
  assert.doesNotMatch(row(trainer, line('glove-2', 'blue', 155)), /cart-preorder|Preorder|Estimated to ship/);
  assert.doesNotMatch(row({ ...mint, comingSoon: true, preorder: { enabled: false, shipEstimate: null }, available: true }, line('glove-3', 'full-mint', 295)), /cart-preorder|Preorder/);
  const blocked = row(preorderMint({ shopifyPreorderShipEstimate: 'mid-December 2026' }), line('glove-4', 'full-mint', 295));
  assert.match(blocked, /<p class="cart-preorder-note cart-preorder-blocked">Not available to order right now\. Remove it to continue to checkout\.<\/p>/);
  assert.doesNotMatch(blocked, /Estimated to ship/);
});

test('the cart disclosure lists each preorder and its estimate before checkout', () => {
  const black = preorderMint({ ...fullSizeProducts.find(product => product.id === 'full-black'), comingSoon: false,
    preorder: { enabled: true, shipEstimate: 'mid-January 2027' }, shopifyPreorderShipEstimate: 'mid-January 2027', available: true });
  assert.equal(renderCartPreorderDisclosure(cartPreorderSummary([trainer]), escapeHtml), '');
  assert.equal(renderCartPreorderDisclosure(cartPreorderSummary([]), escapeHtml), '');
  const mixed = renderCartPreorderDisclosure(cartPreorderSummary([trainer, preorderMint(), preorderMint(), undefined]), escapeHtml);
  assert.equal(mixed, '<div class="cart-preorder-disclosure" id="cart-preorder-disclosure"><p><strong>Your cart includes a preorder.</strong></p><ul><li>MI26: Preorder · Estimated to ship: first week of December 2026</li></ul><p>Other items in your cart are not preorders.</p><p>Preorders are paid in full at checkout, the same as in-stock items.</p></div>');
  assert.doesNotMatch(mixed, /role=|aria-live/, 'the disclosure is static text, not another alert');
  const two = renderCartPreorderDisclosure(cartPreorderSummary([preorderMint(), black]), escapeHtml);
  assert.match(two, /Your cart includes preorders\.[\s\S]*<li>MI26: Preorder · Estimated to ship: first week of December 2026<\/li><li>BL50: Preorder · Estimated to ship: mid-January 2027<\/li><\/ul><p>Preorders are paid in full at checkout, the same as in-stock items.<\/p><\/div>$/);
  const blocked = cartPreorderSummary([trainer, preorderMint({ available: false })]);
  assert.deepEqual(blocked, { preorders: [], blocked: ['MI26'], others: 1 });
  assert.equal(renderCartPreorderDisclosure(blocked, escapeHtml), '<p class="cart-preorder-disclosure cart-preorder-blocked" id="cart-preorder-disclosure">MI26 isn’t available to order right now. Remove it to continue to checkout.</p>');
  assert.equal(renderCartPreorderDisclosure(cartPreorderSummary([preorderMint({ available: false }), { ...black, available: false }]), escapeHtml),
    '<p class="cart-preorder-disclosure cart-preorder-blocked" id="cart-preorder-disclosure">MI26, BL50 aren’t available to order right now. Remove them to continue to checkout.</p>');
  assert.match(renderCartPreorderDisclosure(cartPreorderSummary([{ ...preorderMint(), name: '<b>' }]), escapeHtml), /<li>&lt;b&gt;:/);
});

test('the app wires the disclosure to checkout and keeps checkout closed for blocked preorders', () => {
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(main, /const canCheckout = \(\) => commerce\.mode === 'shopify' && commerce\.isCheckoutComplete\(cart\) && !cartPreorders\(\)\.blocked\.length;/);
  assert.match(main, /\$\{preorderDisclosure\}\$\{checkout\}/);
  assert.match(main, /setAttribute\('aria-describedby', CART_PREORDER_DISCLOSURE_ID\)/);
  assert.match(main, /if \(preorderState\(product\)\.status === 'blocked'\) return;/);
  assert.match(main, /cartUpdateAnnouncement\(before, cart, cartProductName\)/);
});

test('preorder styles keep the estimate as wrapping text that fits a 375px screen', () => {
  const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
  for (const selector of ['.preorder-ship-estimate', '.cart-item .cart-preorder-note', '.cart-foot .cart-preorder-disclosure']) {
    const rule = css.slice(css.indexOf(`${selector}{`)).split('}')[0];
    assert.match(rule, /overflow-wrap:anywhere/, selector);
    assert.doesNotMatch(rule, /white-space:nowrap|width:\d{3,}px/, selector);
  }
});

test('shipping policy and FAQ show full preorder copy only while a Shopify-confirmed preorder is active', () => {
  const active = renderer([preorderMint()]);
  const shipping = active.route('/shipping');
  assert.match(shipping, /<section class="preorder-policy"><h2>Preorders<\/h2>/);
  assert.match(shipping, /Preorders are paid in full at checkout, the same as in-stock items\./);
  assert.ok(shipping.indexOf('Processing Times') < shipping.indexOf('preorder-policy') && shipping.indexOf('preorder-policy') < shipping.indexOf('Delivery Estimates'));
  const faq = active.route('/faq');
  assert.match(faq, /<h2>Preorders<\/h2>[\s\S]*What does Preorder mean\?[\s\S]*How do I pay for a preorder\?/);
  assert.match(faq, /four Japanese Kip leather gloves:<\/p>/, 'no "all coming soon" claim once one is a preorder');
  assert.doesNotMatch(`${shipping}${faq}`, /WRECKER100|PREORDER30|December 2026/);
  // Configured but not confirmed: placed-order guidance only, never purchase wording, payment or estimates.
  for (const inactive of [renderer([]), renderer([preorderMint({ comingSoon: true })]), renderer([preorderMint({ available: false })]),
    renderer([preorderMint({ shopifyPreorderShipEstimate: null })]), renderer([preorderMint()], { commerceError: 'Shopify unavailable' })]) {
    const pages = inactive.route('/shipping') + inactive.route('/faq');
    assert.match(pages, /If you ordered a preorder glove and need its estimated ship window, email support@anawinofficial\.com with your order number\./);
    assert.doesNotMatch(pages, /paid in full|How do I pay for a preorder|What does Preorder mean|marked Preorder|Estimated to ship:|December 2026/);
  }
  assert.match(renderer([]).route('/faq'), /four Japanese Kip leather gloves:<\/p>/, 'the launched catalog never claims Coming soon');
  assert.doesNotMatch(renderer([]).route('/faq'), /coming soon|when the Kip Series launches/i);
  PREORDER_CHECKOUT.chargedInFullAtCheckout = false;
  try { assert.doesNotMatch(renderer([preorderMint()]).route('/shipping'), /preorder-policy/); }
  finally { PREORDER_CHECKOUT.chargedInFullAtCheckout = true; }
});

// Same renderer state as scripts/prerender.mjs, so the check does not depend on a stale dist/ build.
test('prerendered shipping and FAQ pages carry only placed-order preorder guidance with the shipped catalog', () => {
  const prerender = createStorefrontRenderer({ products: localProducts, breakInService, commerceLoading: true });
  for (const page of ['/shipping', '/faq']) {
    const html = prerender.route(page);
    assert.match(html, /If you ordered a preorder glove and need its estimated ship window, email support@anawinofficial\.com with your order number\./, page);
    assert.doesNotMatch(html, /Preorders are paid in full|How do I pay for a preorder|cart-preorder-disclosure|Estimated to ship:/, page);
  }
});
