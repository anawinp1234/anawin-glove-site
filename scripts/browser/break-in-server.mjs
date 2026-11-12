// Loopback-only fixture server. No Shopify requests or real carts are used.
import { createServer } from 'vite';
import { shopifyFixture } from '../../test-support/shopify-fixture.js';
const fixture = shopifyFixture({ fullSize: true });
const env = { VITE_COMMERCE_MODE: 'shopify', VITE_SHOPIFY_STORE_DOMAIN: fixture.config.domain,
  VITE_SHOPIFY_STOREFRONT_TOKEN: 'local-fixture', VITE_SHOPIFY_API_VERSION: '2026-07',
  VITE_SHOPIFY_BR16_HANDLE: 'br16', VITE_SHOPIFY_OB16_HANDLE: 'ob16', VITE_SHOPIFY_CL16_HANDLE: 'cl16',
  VITE_SHOPIFY_BREAK_IN_HANDLE: 'break-in', VITE_SHOPIFY_MI26_HANDLE: 'mi26', VITE_SHOPIFY_BL50_HANDLE: 'bl50',
  VITE_SHOPIFY_OR17_HANDLE: 'or17', VITE_SHOPIFY_CM24_HANDLE: 'cm24' };
const server = await createServer({ server: { host: '127.0.0.1', port: 5199, strictPort: true }, plugins: [{
  name: 'local-break-in-rehearsal', enforce: 'pre',
  transform(source, id) {
    if (id.endsWith('/src/catalog.js')) return source.replaceAll('comingSoon: true', 'comingSoon: false');
    if (id.endsWith('/src/main.js')) return source.replace('commerce = createCommerce();',
      `commerce = createCommerce({ env: ${JSON.stringify(env)}, fetchImpl: (_url, options) => fetch('/__fixture', options) });`);
  },
  configureServer(server) {
    server.middlewares.use('/__fixture', async (request, response) => {
      try {
        let body = ''; for await (const part of request) body += part;
        const result = await fixture.fetchImpl('https://store.myshopify.com/api/2026-07/graphql.json', { body });
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(await result.json()));
      } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ errors: [{ message: error.message }] })); }
    });
  }
}] });
await server.listen();
const production = await createServer({ server: { host:'127.0.0.1', port:5200, strictPort:true } });
await production.listen();
console.log('Isolated mock purchase rehearsal: http://127.0.0.1:5199/product/mi26');
console.log('Unmodified Coming Soon gate: http://127.0.0.1:5200/product/mi26');
