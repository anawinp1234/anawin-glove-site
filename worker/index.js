import { handleNewsletter } from './newsletter.js';
import { HASHED_ASSET, serveHashedAsset } from './asset-cache.js';
import { CSP_REPORT_PATH, handleCspReport } from './csp-report.js';
import { OFFER_PAGE, serveProductPage } from './product-offer.js';

// The Workers runtime treats every export of this entry module as a handler: export only the default.
export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    if (pathname === '/api/newsletter') return handleNewsletter(request, env);
    if (pathname === CSP_REPORT_PATH) return handleCspReport(request, env);
    if (pathname.startsWith('/api/')) {
      return new Response(JSON.stringify({ error: 'not_found' }), {
        status: 404,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff'
        }
      });
    }
    if (HASHED_ASSET.test(pathname)) return serveHashedAsset(request, env);
    // Reached only if run_worker_first lists /product/*; inert unless PRODUCT_OFFER_SYNC is "on".
    if (OFFER_PAGE.test(pathname)) return serveProductPage(request, env);
    return env.ASSETS.fetch(request);
  }
};
