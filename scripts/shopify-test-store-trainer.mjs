// Read/write against the ANAWIN *test* store's Storefront API: creates a cart only.
// Never visits checkout or pays. Configuration is read from .env.development.local and never printed.
import { readFileSync } from 'node:fs';
const repo = process.argv[2] || process.cwd();
const mod = path => import(`${repo}/src/${path}`);
const { createCommerce } = await mod('commerce.js');
const { checkoutCartIsComplete, createCheckoutVerifier, redirectToVerifiedCheckout } = await mod('checkout-safety.js');
const { renderCartDiscountSection, cartDiscountSummary } = await mod('cart-discounts.js');

const env = Object.fromEntries(readFileSync(`${repo}/.env.development.local`, 'utf8').split('\n')
  .filter(line => /^VITE_/.test(line)).map(line => line.split(/=(.*)/s).slice(0, 2)));
const values = new Map();
const storage = { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, String(v)), removeItem: k => values.delete(k),
    get length() { return values.size; }, key: index => [...values.keys()][index] ?? null };
const commerce = createCommerce({ env, storage, fetchImpl: fetch });
const money = (amount, currency) => new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
const esc = v => String(v).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]);
if (env.VITE_SHOPIFY_STORE_DOMAIN !== 'anawin-test.myshopify.com') throw new Error('This script is authorized for the test store only.');
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };
const describe = cart => cart.lines.map(l => `${l.isBreakIn ? '  service' : 'glove'}:${l.productId} x${l.quantity}`).join(', ');
const section = (cart, state = {}) => renderCartDiscountSection(cart, 'shopify', state, money, esc);
const serviceOf = (cart, glove) => cart.lines.find(l => l.isBreakIn && l.parentLineId === glove.remoteLineId);

console.log('mode:', commerce.mode);
const products = await commerce.listProducts();
const service = await commerce.getBreakInService();
console.log('break-in service:', service.available, service.price);
for (const p of products.filter(p => p.line !== 'full-size')) console.log(`product ${p.name}: available=${p.available} variants=${p.variants?.length} price=${p.price}`);

let cart = await commerce.addProduct('black', true, { level: 'Game Ready (90%)', wearingStyle: 'Traditional' });
let glove = cart.lines.find(l => !l.isBreakIn);
check('BR16 + Trainer Break-In added and paired', Boolean(serviceOf(cart, glove)), describe(cart));
check('cart is checkout-complete', checkoutCartIsComplete(cart));
check('disclosure collapsed by default', /aria-expanded="false"[^>]*>Have a discount code\?/.test(section(cart)) && /data-discount-form hidden/.test(section(cart)));
const serviceAttrs = JSON.stringify(serviceOf(cart, glove).attributes);

cart = await commerce.applyDiscountCode('ANAWINTEST100');
glove = cart.lines.find(l => !l.isBreakIn);
const applied = cart.discountCodes.find(d => d.code.toUpperCase() === 'ANAWINTEST100');
const summary = cartDiscountSummary(cart);
check('ANAWINTEST100 applicable', applied?.applicable === true, `subtotal=${cart.subtotal} final=${summary.final?.amount} savings=${summary.savings?.amount}`);
check('apply keeps glove + service and service choices', Boolean(serviceOf(cart, glove)) && JSON.stringify(serviceOf(cart, glove).attributes) === serviceAttrs, describe(cart));
check('applied code + Remove visible while collapsed', /data-discount-form hidden>[\s\S]*ANAWINTEST100 applied[\s\S]*data-remove-discount="ANAWINTEST100"/i.test(section(cart)));
check('checkout-complete after discount', checkoutCartIsComplete(cart));

cart = await commerce.setLineQuantity(glove.remoteLineId, 2);
glove = cart.lines.find(l => !l.isBreakIn);
const svcQty = cart.lines.filter(l => l.isBreakIn).reduce((s, l) => s + l.quantity, 0);
check('quantity 2 keeps service in step and code applied', cart.lines.filter(l => !l.isBreakIn).reduce((s, l) => s + l.quantity, 0) === 2 && svcQty === 2 &&
  cart.discountCodes.some(d => d.applicable), `${describe(cart)}; final=${cartDiscountSummary(cart).final?.amount}`);
check('checkout-complete after quantity change', checkoutCartIsComplete(cart));

cart = await commerce.applyDiscountCode('NOT-A-REAL-CODE-P2');
const bogus = cart.discountCodes.find(d => d.code === 'NOT-A-REAL-CODE-P2');
check('invalid code reported not applicable', bogus ? bogus.applicable === false : true, bogus ? 'kept as not applicable' : 'Shopify dropped it');
check('invalid code leaves valid code applied', cart.discountCodes.some(d => d.code.toUpperCase() === 'ANAWINTEST100' && d.applicable));
check('error state renders expanded with alert', /aria-expanded="true"[\s\S]*role="alert"/.test(section(cart, { error: true, input: 'NOT-A-REAL-CODE-P2', message: 'Discount code isn’t valid for this cart.' })));
if (bogus) cart = await commerce.removeDiscountCode('NOT-A-REAL-CODE-P2');

cart = await commerce.removeDiscountCode('ANAWINTEST100');
check('code removed; lines intact', cart.discountCodes.length === 0 && cart.lines.some(l => l.isBreakIn), `${describe(cart)}; subtotal=${cart.subtotal}`);
check('checkout-complete after removal', checkoutCartIsComplete(cart));

// Break-in removal and re-add from the cart, with a code re-applied.
cart = await commerce.applyDiscountCode('ANAWINTEST100');
for (const g of cart.lines.filter(l => !l.isBreakIn && serviceOf(cart, l))) cart = await commerce.removeBreakIn(g.remoteLineId);
check('one service removed with code and remaining pair preserved', cart.lines.filter(l => l.isBreakIn).reduce((sum, l) => sum + l.quantity, 0) === 1 &&
  cart.lines.filter(l => !l.isBreakIn).reduce((sum, l) => sum + l.quantity, 0) === 2 && checkoutCartIsComplete(cart) && cart.discountCodes.some(d => d.applicable), describe(cart));
glove = cart.lines.find(l => !l.isBreakIn && !serviceOf(cart, l));
cart = await commerce.addBreakIn(glove.remoteLineId, { level: 'Firm (40%)', wearingStyle: 'Two in the Pinky (TIP)' });
check('service re-added from cart with code still applied', cart.lines.some(l => l.isBreakIn) && cart.discountCodes.some(d => d.applicable), describe(cart));
check('checkout-complete after re-add', checkoutCartIsComplete(cart));

// Checkout handoff: verify only. The URL is checked, never opened.
const verify = createCheckoutVerifier({ getCart: () => commerce.getCart(), readSafety: () => commerce.readCartSafety() });
const verdict = await verify(cart);
let handoff = null;
const accepted = redirectToVerifiedCheckout(verdict.checkoutUrl, url => { handoff = new URL(url); });
check('checkout state verified; test-store URL rejected by production domain policy', verdict.status === 'ready' && !accepted && handoff === null, verdict.status);

// Clean up the test cart.
for (const line of (await commerce.getCart()).lines.filter(l => !l.isBreakIn)) cart = await commerce.removeLine(line.remoteLineId);
check('test cart emptied', (await commerce.getCart()).lines.length === 0);
console.log(`\n${results.filter(r => r.ok).length}/${results.length} checks passed`);

if (results.some(result => typeof result === 'boolean' ? !result : !result.ok)) process.exitCode = 1;
