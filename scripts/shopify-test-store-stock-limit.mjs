import { releasedCommerceProfiles, testCommerceProfile } from './test-store/commerce-profile.mjs';
const repo = process.argv[2] || process.cwd();
const { createCommerce, commerceErrorMessage } = await import(`${repo}/src/commerce.js`);
const { checkoutCartIsComplete } = await import(`${repo}/src/checkout-safety.js`);
const { cartDiscountSummary } = await import(`${repo}/src/cart-discounts.js`);
const env = process.env;
if (env.VITE_COMMERCE_MODE !== 'shopify' || env.VITE_SHOPIFY_STORE_DOMAIN !== testCommerceProfile.storeDomain) {
  throw new Error('Explicit Shopify mode and the verified test-store domain are required.');
}
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };
const session = () => { const values = new Map(); return createCommerce({ env, profiles: releasedCommerceProfiles, fetchImpl: fetch,
  storage: { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, String(v)), removeItem: k => values.delete(k),
    get length() { return values.size; }, key: index => [...values.keys()][index] ?? null } }); };
const glove = (cart, id) => cart.lines.find(l => !l.isBreakIn && l.productId === id);
const svc = (cart, id) => cart.lines.filter(l => l.isBreakIn && l.productId === id).reduce((s, l) => s + l.quantity, 0);
const safe = c => { const s = c.readCartSafety(); return s.unsafeId !== s.id && s.pendingCartId !== s.id; };
const empty = async c => { for (const l of (await c.getCart()).lines.filter(l => !l.isBreakIn)) await c.removeLine(l.remoteLineId); };

// A. Unserviced CL16 at its stock limit.
let c = session(); await c.listProducts(); await c.getBreakInService();
let cart = await c.addProduct('brown', false);
cart = await c.setLineQuantity(glove(cart, 'brown').remoteLineId, 15);
check('CL16 reaches 15', glove(cart, 'brown').quantity === 15);
for (const attempt of [1, 2]) {
  let error = null;
  try { await c.setLineQuantity(glove(cart, 'brown').remoteLineId, 16); } catch (e) { error = e; }
  cart = await c.getCart();
  check(`attempt ${attempt} at 16: definitive stock rejection, cart safe at 15`, error?.code === 'stock-limit' && safe(c) && !cart.incomplete && glove(cart, 'brown').quantity === 15 && checkoutCartIsComplete(cart, testCommerceProfile),
    `"${commerceErrorMessage(error, 'cart')}"`);
}
let addError = null; try { await c.addProduct('brown', false); } catch (e) { addError = e; }
cart = await c.getCart();
check('adding CL16 again from its page is the same rejection', addError?.code === 'stock-limit' && safe(c) && glove(cart, 'brown').quantity === 15);
cart = await c.addProduct('black', true, { level: 'Medium (65%)', wearingStyle: 'Traditional' });
check('the same cart then adds BR16 + Break-In', glove(cart, 'black')?.quantity === 1 && svc(cart, 'black') === 1 && checkoutCartIsComplete(cart, testCommerceProfile));
cart = await c.applyDiscountCode('ANAWINTEST100');
const savings = cartDiscountSummary(cart).savings?.amount;
let again = null; try { await c.setLineQuantity(glove(cart, 'brown').remoteLineId, 16); } catch (e) { again = e; }
cart = await c.getCart();
check('rejection with a discount applied keeps the code and totals', again?.code === 'stock-limit' && cart.discountCodes.some(d => d.applicable) && cartDiscountSummary(cart).savings?.amount === savings && checkoutCartIsComplete(cart, testCommerceProfile), `savings $${savings}`);
await empty(c);

// B. CL16 with Break-In at the limit (the service is synchronized line by line).
c = session(); await c.listProducts(); await c.getBreakInService();
cart = await c.addProduct('brown', true, { level: 'Firm (40%)', wearingStyle: 'Traditional' });
cart = await c.setLineQuantity(glove(cart, 'brown').remoteLineId, 15);
check('serviced CL16 reaches 15 with 15 services', glove(cart, 'brown').quantity === 15 && svc(cart, 'brown') === 15);
let serviced = null; try { await c.setLineQuantity(glove(cart, 'brown').remoteLineId, 16); } catch (e) { serviced = e; }
cart = await c.getCart();
check('serviced attempt at 16: rejection clears the pre-flight lock and keeps 15 + 15', serviced?.code === 'stock-limit' && safe(c) && glove(cart, 'brown').quantity === 15 && svc(cart, 'brown') === 15 && checkoutCartIsComplete(cart, testCommerceProfile));
cart = await c.setLineQuantity(glove(cart, 'brown').remoteLineId, 14);
check('the serviced pair still decreases normally', glove(cart, 'brown').quantity === 14 && svc(cart, 'brown') === 14 && checkoutCartIsComplete(cart, testCommerceProfile));
await empty(c);
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);

if (results.some(result => typeof result === 'boolean' ? !result : !result.ok)) process.exitCode = 1;
