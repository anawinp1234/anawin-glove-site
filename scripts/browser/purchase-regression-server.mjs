// Loopback-only, scenario-controlled Storefront mock for the purchase regression suite
// (purchase-regression-browser.mjs starts it; it is not meant to be run by hand).
//
// - Starts only inside a verified closed network namespace (isolation.mjs) and only with the
//   per-run token the suite generated; listens on a random 127.0.0.1 port and reports it on stdout.
// - Serves the storefront with Shopify's fetch replaced by /__fixture, answered by the strict
//   multi-cart mock in purchase-regression-fixture.mjs. Nothing is forwarded anywhere.
// - Accepts only the expected Host, methods and routes. Anything else is refused and recorded as a
//   violation. /__control requires the run token, so a page cannot drive the mock.
// - Every Storefront request is logged with the scenario it arrived in. Requests can be held before
//   or after they commit and are released explicitly; reset cancels held requests and waits for
//   in-flight ones before replacing the mock.
import { createHash } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import { createServer } from 'vite';
import { requireIsolation } from './isolation.mjs';
import { createStorefrontMock, isMutation, operationOf, UnmodelledRequest } from './purchase-regression-fixture.mjs';

await requireIsolation('purchase-regression-server');
const TOKEN = process.env.ANAWIN_HARNESS_TOKEN;
if (!TOKEN || TOKEN.length < 32) { console.error('purchase-regression-server: ANAWIN_HARNESS_TOKEN is required.'); process.exit(2); }
// The production checkout policy only accepts this host (src/checkout-safety.js). The browser suite
// answers every request to it locally.
export const CHECKOUT_HOST = 'ignvv0-zh.myshopify.com';
const HOLD_LIMIT_MS = 30000;
const BODY_LIMIT = 1 << 20;
const env = { VITE_COMMERCE_MODE: 'shopify', VITE_SHOPIFY_STORE_DOMAIN: 'store.myshopify.com',
  VITE_SHOPIFY_STOREFRONT_TOKEN: 'local-fixture', VITE_SHOPIFY_API_VERSION: '2026-07',
  VITE_SHOPIFY_BR16_HANDLE: 'br16', VITE_SHOPIFY_OB16_HANDLE: 'ob16', VITE_SHOPIFY_CL16_HANDLE: 'cl16',
  VITE_SHOPIFY_BREAK_IN_HANDLE: 'break-in', VITE_SHOPIFY_MI26_HANDLE: 'mi26', VITE_SHOPIFY_BL50_HANDLE: 'bl50',
  VITE_SHOPIFY_OR17_HANDLE: 'or17', VITE_SHOPIFY_CM24_HANDLE: 'cm24' };

let port = 0;
let mock;
let epoch = 0;
let scenario = '(startup)';
let seq = 0;
// Mutations in the order the mock actually changed state (never reset). `seq` is arrival order; a held
// or slow request can arrive first and commit later, so ordering gates must use this instead.
let commitSeq = 0;
let log = [];
let unmatched = [];
let violations = [];
let checkoutMode = null;
let checkoutSerial = 0;
let failures = [];
// Armed response forgeries (1M): the next matching mutation is answered from a dry run, never committed.
// 1N: mode 'commit-then-substitute' commits it for real first, then substitutes the returned cart.
let forgeries = [];
let holds = [];
// Every unmatched request and violation of the whole run; no reset clears it.
const faults = [];
const inflight = new Set();
const resetState = ({ scenario: name = '(unnamed)', ...options } = {}) => {
  mock = createStorefrontMock({ checkoutHost: CHECKOUT_HOST, ...options });
  epoch++; scenario = name; log = []; unmatched = []; violations = []; checkoutMode = null; checkoutSerial = 0; failures = []; holds = []; forgeries = [];
};
resetState();
const violation = (request, reason) => { const item = { scenario, method: request.method, path: (request.url || '').slice(0, 120), reason }; violations.push(item); faults.push({ kind: 'violation', ...item }); };
const unmatchedRequest = item => { const record = { scenario, ...item }; unmatched.push(record); faults.push({ kind: 'unmatched', ...record }); };

// Checkout URLs Shopify might return, so the storefront's handoff policy is tested end to end.
const rewriteCheckout = url => {
  if (!url || !checkoutMode) return url;
  const path = new URL(url).pathname;
  if (checkoutMode === 'rotate') return `https://${CHECKOUT_HOST}${path}?key=synthetic-${++checkoutSerial}&locale=en-US`;
  if (checkoutMode === 'foreign') return `https://checkout.example.test${path}`;
  if (checkoutMode === 'http') return `http://${CHECKOUT_HOST}${path}`;
  if (checkoutMode === 'credentials') return `https://user:pass@${CHECKOUT_HOST}${path}`;
  if (checkoutMode === 'lookalike') return `https://${CHECKOUT_HOST}.example.test${path}`;
  if (checkoutMode === 'port') return `https://${CHECKOUT_HOST}:8443${path}`;
  throw new Error(`Unknown checkout mode ${checkoutMode}`);
};
const rewriteCarts = value => {
  if (!value || typeof value !== 'object') return;
  if (typeof value.checkoutUrl === 'string') value.checkoutUrl = rewriteCheckout(value.checkoutUrl);
  for (const child of Object.values(value)) rewriteCarts(child);
};

async function readBody(request) {
  let body = '';
  for await (const part of request) { body += part; if (body.length > BODY_LIMIT) throw new Error('request body too large'); }
  return body;
}
const send = (response, status, payload) => {
  if (response.writableEnded) return;
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(payload));
};

// A hold pauses the nth matching request after it is armed, before ('before') or after ('after') the
// mock commits it. Nothing is released by time except the 30 s safety limit, which is a violation.
function armedHold(entry) {
  for (const hold of holds) {
    if (hold.entry || hold.operation !== entry.operation) continue;
    if (++hold.seen === hold.nth) { hold.entry = entry; hold.arrived(); return hold; }
  }
  return null;
}
const waitForRelease = hold => new Promise(resolve => {
  hold.release = resolve;
  hold.limit = setTimeout(() => { const item = { scenario, reason: `hold on ${hold.operation} was never released` }; violations.push(item); faults.push({ kind: 'violation', ...item }); resolve({ commit: false, cancelled: 'limit' }); }, HOLD_LIMIT_MS);
});

async function handleFixture(request, response) {
  const body = await readBody(request);
  let query, variables;
  try { ({ query = '', variables = {} } = JSON.parse(body || '{}')); }
  catch { violation(request, 'fixture body is not JSON'); return send(response, 400, { errors: [{ message: 'bad JSON' }] }); }
  const entry = { seq: ++seq, epoch, scenario, operation: operationOf(query), mutation: isMutation(query),
    cartId: variables.cartId || variables.id || null, lineIds: variables.lineIds || (variables.lines || []).map(line => line.id).filter(Boolean),
    lines: (variables.lines || variables.input?.lines || []).map(line => ({ id: line.id, merchandiseId: line.merchandiseId, quantity: line.quantity,
      attributes: line.attributes?.map(item => item.key), parent: line.parent || undefined })),
    discountCodes: variables.discountCodes, attributeKeys: variables.attributes?.map(item => item.key),
    tag: typeof request.headers['x-anawin-request'] === 'string' ? request.headers['x-anawin-request'].slice(0, 64) : null,
    status: 0, outcome: 'pending', startedAt: Date.now() };
  log.push(entry);
  const own = { entry, epoch };
  inflight.add(own);
  try {
    // The nth matching mutation after a failure is armed fails; earlier ones pass through.
    const failure = entry.mutation && failures.find(item => !item.used && (!item.operation || item.operation === entry.operation) && ++item.seen === item.nth);
    if (failure) failure.used = true;
    // Top-level GraphQL errors are recorded separately from the HTTP status and from mutation userErrors
    // (1L): failNext with status 200 is an HTTP 200 response carrying only top-level errors.
    if (failure?.phase === 'before') { entry.outcome = 'failed-before-commit'; entry.graphqlErrors = ['mock outage before commit']; return send(response, entry.status = failure.status, { errors: [{ message: 'mock outage before commit' }] }); }
    const hold = armedHold(entry);
    if (hold?.phase === 'before') {
      entry.outcome = 'held-before-commit';
      const { commit, cancelled } = await waitForRelease(hold);
      if (!commit) { entry.outcome = cancelled ? `cancelled (${cancelled})` : 'released-without-commit'; return send(response, entry.status = 503, { errors: [{ message: 'mock released without commit' }] }); }
    }
    if (own.epoch !== epoch) { entry.outcome = 'stale'; return send(response, entry.status = 503, { errors: [{ message: 'mock was reset' }] }); }
    let data;
    // Received is not attempted: everything above can answer without executing. From here the mock runs it.
    entry.attemptedAt = Date.now();
    // 1M: an HTTP 200 answer whose cart is not the requested one (another cart's ID, a blank ID, an omitted ID,
    // or no cart at all). Mode 'dry-run' (the default) only dry-runs the mutation, so nothing is committed and
    // no commitSeq is taken. 1N: mode 'commit-then-substitute' executes it for real, takes its commitSeq,
    // effects and the committed cart state, and only then replaces the returned cart.
    const forgery = entry.mutation && forgeries.find(item => !item.used && item.operation === entry.operation);
    if (forgery) {
      forgery.used = true;
      const commit = forgery.mode === 'commit-then-substitute';
      try { data = mock.execute(query, variables, { dryRun: !commit }); }
      catch (error) { if (!(error instanceof UnmodelledRequest)) throw error; unmatchedRequest({ seq: entry.seq, operation: entry.operation, message: error.message }); entry.outcome = 'unmatched'; return send(response, entry.status = 500, { errors: [{ message: `Unmatched mock request: ${error.message}` }] }); }
      const payload = Object.values(data).find(value => value && typeof value === 'object' && 'cart' in value);
      entry.userErrors = (payload?.userErrors || []).map(error => error.message);
      if (commit && !entry.userErrors.length) {
        entry.committedAt = Date.now();
        entry.commitSeq = ++commitSeq;
        const effects = mock.lastEffects(); if (effects) { entry.cartBefore = effects.cartBefore; entry.effects = effects.lines; entry.cartAfter = effects.cartAfter; }
        // The fixture's own saved state and the cart ID it would have returned, both read before substitution.
        entry.committedState = mock.cart(entry.cartId);
        entry.committedReturnedCartId = payload?.cart?.id ?? null;
      }
      if (payload) {
        if (forgery.cart === 'absent') payload.cart = null;
        else if (payload.cart && forgery.cart === 'omitted') delete payload.cart.id;
        else if (payload.cart) payload.cart.id = forgery.cart === 'blank' ? '' : 'gid://shopify/Cart/999999?key=k999999';
      }
      rewriteCarts(data);
      entry.outcome = entry.commitSeq ? 'committed-response-substituted' : 'response-forged';
      entry.forged = forgery.cart;
      entry.forgeMode = forgery.mode;
      entry.returnedCartId = payload ? (payload.cart ? payload.cart.id ?? null : null) : null;
      entry.resultLines = payload?.cart?.lines?.nodes?.map(line => ({ id: line.id, quantity: line.quantity })) || null;
      return send(response, entry.status = 200, { data });
    }
    try { data = mock.execute(query, variables); }
    catch (error) {
      if (!(error instanceof UnmodelledRequest)) throw error;
      unmatchedRequest({ seq: entry.seq, operation: entry.operation, message: error.message });
      entry.outcome = 'unmatched';
      return send(response, entry.status = 500, { errors: [{ message: `Unmatched mock request: ${error.message}` }] });
    }
    entry.committedAt = Date.now();
    entry.userErrors = Object.values(data).flatMap(value => value?.userErrors || []).map(error => error.message);
    // The state change happened inside execute (all or nothing; userErrors leave the cart unchanged), so the
    // commit sequence is taken here, synchronously, before any later await can reorder it.
    if (entry.mutation && !entry.userErrors.length) entry.commitSeq = ++commitSeq;
    // What the commit actually changed, resolved by the mock at execution time (1L, 1M): the cart's lines
    // before and after, and every added, removed, changed (quantity, merchandise, parent or attributes) or
    // re-keyed line with its full view before and after.
    if (entry.commitSeq) { const effects = mock.lastEffects(); if (effects) { entry.cartBefore = effects.cartBefore; entry.effects = effects.lines; entry.cartAfter = effects.cartAfter; } }
    // A mutation answered with userErrors did not commit what was asked; it is never reported as committed.
    entry.outcome = entry.userErrors.length ? 'user-errors' : 'committed';
    entry.resultLines = Object.values(data).map(value => value?.cart?.lines?.nodes).find(Boolean)?.map(line => ({ id: line.id, quantity: line.quantity })) || null;
    rewriteCarts(data);
    // Recorded exactly as returned (1M): a blank ID stays blank, a missing cart is null.
    const returned = Object.values(data).find(value => value && typeof value === 'object' && 'cart' in value);
    entry.returnedCartId = returned ? (returned.cart ? returned.cart.id ?? null : null) : entry.operation === 'Cart' ? Object.values(data)[0]?.id ?? null : null;
    entry.checkoutUrl = Object.values(data).map(value => value?.checkoutUrl || value?.cart?.checkoutUrl).find(Boolean) || null;
    if (failure?.phase === 'after') { entry.outcome = 'committed-then-failed'; entry.graphqlErrors = ['mock outage after commit']; return send(response, entry.status = failure.status, { errors: [{ message: 'mock outage after commit' }] }); }
    if (hold?.phase === 'after') {
      entry.outcome = 'committed-response-held';
      const { cancelled } = await waitForRelease(hold);
      if (cancelled) { entry.outcome = `committed-response-cancelled (${cancelled})`; return send(response, entry.status = 503, { errors: [{ message: 'mock cancelled held response' }] }); }
      entry.outcome = entry.userErrors.length ? 'user-errors' : 'committed';
    }
    send(response, entry.status = 200, { data });
  } finally {
    entry.finishedAt = Date.now();
    inflight.delete(own);
  }
}

const findHold = id => { const hold = holds.find(item => item.id === id); if (!hold) throw new Error(`Unknown hold ${id}`); return hold; };
const deadline = (promise, ms) => Promise.race([promise.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), ms))]);
const controls = {
  hello: ({ challenge }) => ({ mock: 'anawin-purchase-regression', pid: process.pid, port, challenge }),
  // Cancels held requests, waits for in-flight ones, then replaces the mock. Reports what it had to cancel.
  reset: async options => {
    const cancelled = [];
    for (const hold of holds) {
      if (hold.entry && hold.release) { cancelled.push({ operation: hold.operation, seq: hold.entry.seq }); clearTimeout(hold.limit); hold.release({ commit: false, cancelled: 'reset' }); }
    }
    const pending = [...inflight].map(item => item.entry);
    const drained = await deadline((async () => { while (inflight.size) await new Promise(resolve => setTimeout(resolve, 20)); })(), 5000);
    const leftover = { cancelled, pendingAtReset: pending.map(entry => ({ seq: entry.seq, operation: entry.operation, outcome: entry.outcome })), drained, previous: scenario, unmatched, violations };
    resetState(options);
    return leftover;
  },
  log: () => ({ scenario, log, unmatched, violations, inflight: [...inflight].map(item => item.entry.seq) }),
  faults: () => ({ faults }),
  checkoutMode: ({ mode }) => { checkoutMode = mode; return {}; },
  failNext: ({ operation = null, phase = 'before', status = 503, nth = 1 }) => { failures.push({ operation, phase, status, nth, seen: 0, used: false }); return {}; },
  forgeNext: ({ operation, cart, mode = 'dry-run' }) => {
    if (!['unrelated', 'blank', 'omitted', 'absent'].includes(cart)) throw new Error(`Unknown forged cart ${cart}`);
    if (!['dry-run', 'commit-then-substitute'].includes(mode)) throw new Error(`Unknown forge mode ${mode}`);
    forgeries.push({ operation, cart, mode, used: false }); return {};
  },
  hold: ({ operation, phase = 'before', nth = 1 }) => {
    let arrived; const signal = new Promise(resolve => { arrived = resolve; });
    const hold = { id: `hold-${holds.length + 1}`, operation, phase, nth, seen: 0, entry: null, arrived, signal, release: null };
    holds.push(hold);
    return { id: hold.id };
  },
  awaitHeld: async ({ id, timeoutMs = 8000 }) => {
    const hold = findHold(id);
    return { arrived: await deadline(hold.signal, timeoutMs), seq: hold.entry?.seq ?? null };
  },
  release: ({ id, commit = true }) => {
    const hold = findHold(id);
    if (!hold.entry || !hold.release) return { arrived: Boolean(hold.entry), released: false };
    clearTimeout(hold.limit); hold.release({ commit }); hold.release = null;
    return { arrived: true, released: true };
  },
  cart: ({ id }) => ({ cart: mock.cart(id) }),
  carts: () => ({ carts: mock.carts(), created: mock.created() }),
  expire: ({ id }) => ({ expired: mock.expire(id) }),
  setMetafield: ({ handle, value }) => { mock.setMetafield(handle, value); return {}; },
  legacyServiceCart: () => ({ cartId: mock.legacyServiceCart() })
};

async function handleControl(request, response) {
  if (request.headers['x-harness-token'] !== TOKEN) { violation(request, 'control request without the run token'); return send(response, 403, { error: 'forbidden' }); }
  try {
    const { action, ...args } = JSON.parse(await readBody(request) || '{}');
    if (!Object.hasOwn(controls, action)) throw new Error(`Unknown control ${action}`);
    send(response, 200, await controls[action](args));
  } catch (error) { send(response, 500, { error: error.message }); }
}

// Runs before Vite's own middlewares.
function guard(request, response, next) {
  const path = (request.url || '').split('?')[0];
  if (request.headers.host !== `127.0.0.1:${port}`) { violation(request, `unexpected Host ${request.headers.host}`); return send(response, 421, { error: 'host' }); }
  if (path === '/__control') return request.method === 'POST' ? handleControl(request, response) : (violation(request, 'control method'), send(response, 405, {}));
  if (path === '/__fixture') {
    if (request.method !== 'POST') { violation(request, 'fixture method'); return send(response, 405, {}); }
    return handleFixture(request, response).catch(error => { unmatchedRequest({ message: `server error: ${error.message}` }); send(response, 500, { errors: [{ message: 'mock server error' }] }); });
  }
  if (path.startsWith('/__')) { violation(request, 'unknown harness route'); return send(response, 404, {}); }
  if (!['GET', 'HEAD'].includes(request.method)) { violation(request, 'non-GET storefront request'); return send(response, 405, {}); }
  next();
}

// Vite treats port 0 as "use the default", so take a free port from the kernel first. Inside the
// run's private network namespace nothing else can claim it in between.
const freePort = await new Promise((resolve, reject) => {
  const probe = createNetServer().once('error', reject).listen(0, '127.0.0.1', () => { const { port: free } = probe.address(); probe.close(() => resolve(free)); });
});
const server = await createServer({ logLevel: 'error', clearScreen: false,
  server: { host: '127.0.0.1', port: freePort, strictPort: true, hmr: false, watch: null }, plugins: [{
    name: 'local-purchase-regressions', enforce: 'pre',
    transform(source, id) {
      if (id.endsWith('/src/catalog.js')) return source.replaceAll('comingSoon: true', 'comingSoon: false');
      if (id.endsWith('/src/main.js')) {
        if (!source.includes('commerce = createCommerce();')) throw new Error('main.js no longer creates commerce the way the mock expects');
        return source.replace('commerce = createCommerce();',
          `commerce = createCommerce({ env: ${JSON.stringify(env)}, fetchImpl: (_url, options) => fetch('/__fixture', options) });`);
      }
    },
    configureServer(vite) { vite.middlewares.use(guard); }
  }] });
await server.listen();
port = server.httpServer.address().port;
// The suite matches this line, then confirms the PID and token through /__control hello.
console.log(JSON.stringify({ ready: 'anawin-purchase-regression', port, pid: process.pid, token: createHash('sha256').update(TOKEN).digest('hex') }));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close().finally(() => process.exit(0)));
