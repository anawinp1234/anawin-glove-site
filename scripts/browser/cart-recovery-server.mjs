import { fixtureProfile } from '../../test-support/commerce-profiles.js';
// Loopback-only fixture server for the cart recovery browser suite. No Shopify requests or real carts
// are used. `/__fixture-control` (loopback only) resets the fixture and injects Shopify faults.
import { createServer } from 'vite';
import { shopifyFixture } from '../../test-support/shopify-fixture.js';
let fixture = shopifyFixture();
// Settles once a delayed mutation has reached the fixture, so it is never released before it arrives.
let delayedArrival = null;
// Cart reads for one cart ID answered with a fixed GraphQL envelope (e.g. cart: null), until cleared.
let readOverride = null;
const env = { VITE_COMMERCE_MODE: 'shopify', VITE_SHOPIFY_STORE_DOMAIN: fixture.config.domain,
  VITE_SHOPIFY_STOREFRONT_TOKEN: 'local-fixture', VITE_SHOPIFY_API_VERSION: '2026-07',
  VITE_SHOPIFY_BR16_HANDLE: 'br16', VITE_SHOPIFY_OB16_HANDLE: 'ob16', VITE_SHOPIFY_CL16_HANDLE: 'cl16',
  VITE_SHOPIFY_BREAK_IN_HANDLE: 'break-in' };
const readBody = async request => { let body = ''; for await (const part of request) body += part; return body; };
const json = (response, value, status = 200) => {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(value));
};
const port = Number(process.env.ANAWIN_RECOVERY_PORT || 5201);
const server = await createServer({ server: { host: '127.0.0.1', port, strictPort: true }, plugins: [{
  name: 'local-cart-recovery-rehearsal', enforce: 'pre',
  transform(source, id) {
    if (!id.endsWith('/src/main.js')) return;
    if (source.split('commerce = createCommerce();').length !== 2) throw new Error('Unexpected commerce fixture entry.');
    return source.replace('commerce = createCommerce();',
      `commerce = createCommerce({ env: ${JSON.stringify(env)}, profiles: ${JSON.stringify([fixtureProfile])}, fetchImpl: (_url, options) => fetch('/__fixture', options) });`);
  },
  configureServer(vite) {
    vite.middlewares.use('/__fixture-control', async (request, response) => {
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)) return json(response, { error: 'loopback only' }, 403);
      try {
        const { action, args = [] } = JSON.parse(await readBody(request) || '{}');
        if (action === 'reset') { fixture = shopifyFixture(); readOverride = null; }
        else if (action === 'overrideCartReads') readOverride = args[0] ? { id: args[0], envelope: args[1] } : null;
        else if (action === 'state') {
          const mutations = fixture.requests.filter(item => /^mutation/.test(item.query));
          return json(response, { creates: mutations.filter(item => item.query.includes('CreateCart')).length, mutations: mutations.length,
            lines: fixture.cartLines(...args).map(line => ({ handle: line.merchandise.product.handle, merchandiseId: line.merchandise.id, quantity: line.quantity,
              attributes: line.attributes, service: Boolean(line.parentRelationship) })) });
        } else if (['setApiError', 'failAfterNextMutation', 'releaseDelayedMutation'].includes(action)) fixture[action](...args);
        else if (action === 'delayNextMutation') delayedArrival = fixture.delayNextMutation();
        else if (action === 'awaitDelayedMutation') await delayedArrival;
        else return json(response, { error: `unknown action ${action}` }, 400);
        json(response, { ok: true });
      } catch (error) { json(response, { error: error.message }, 500); }
    });
    vite.middlewares.use('/__fixture', async (request, response) => {
      try {
        const body = await readBody(request);
        const { query, variables } = JSON.parse(body);
        if (readOverride && query.includes('query Cart(') && variables?.id === readOverride.id) return json(response, readOverride.envelope);
        const result = await fixture.fetchImpl('https://store.myshopify.com/api/2026-07/graphql.json', { body });
        if (!result.ok) return json(response, { errors: [{ message: `Fixture status ${result.status}` }] }, result.status);
        json(response, await result.json());
      } catch (error) { json(response, { errors: [{ message: error.message }] }, 500); }
    });
  }
}] });
await server.listen();
console.log(`Isolated cart recovery rehearsal: http://127.0.0.1:${port}/product/br16`);
