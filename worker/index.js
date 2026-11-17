import { handleNewsletter } from './newsletter.js';
import { HASHED_ASSET, serveHashedAsset } from './asset-cache.js';

// The Workers runtime treats every export of this entry module as a handler: export only the default.
export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    if (pathname === '/api/newsletter') return handleNewsletter(request, env);
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
    return env.ASSETS.fetch(request);
  }
};
