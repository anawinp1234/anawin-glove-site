// Vite names every built JS/CSS file after its content hash, so a hashed URL never changes meaning.
export const HASHED_ASSET = /^\/assets\/[\w.-]+-[\w-]{8,}\.(?:js|css)$/;
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

// Only a found asset is marked immutable. A missing hash returns the 404 page, which keeps the
// platform's revalidating cache policy (a /assets/* rule in _headers would also apply to that 404).
export async function serveHashedAsset(request, env) {
  const response = await env.ASSETS.fetch(request);
  if (response.status !== 200 && response.status !== 304) return response;
  const cached = new Response(response.body, response);
  cached.headers.set('Cache-Control', IMMUTABLE_CACHE_CONTROL);
  return cached;
}
