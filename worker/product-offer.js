// Prepared, NOT enabled (Phase 4 part 2). Publishes Shopify availability in the trainer pages'
// Product JSON-LD, so `availability` cannot go stale between deploys.
//
// It runs only when BOTH are set (see docs/phase-4-audit.md, "Decisions"):
//   wrangler.jsonc  assets.run_worker_first  includes "/product/*"
//   wrangler.jsonc  vars.PRODUCT_OFFER_SYNC  = "on"
//
// Rules (each one tested in test/product-offer.test.js):
// - Credentials: none. Shopify's Storefront API allows tokenless product reads.
// - Market: the query is pinned to the U.S. market (@inContext(country: US)), matching the page's
//   USD offer and U.S. shipping details. Other markets return other prices (CA: CAD). The cache key
//   carries the country and API version, and the result must be USD to be used.
// - Price: never changed by the Worker. The offer is used only when Shopify's price equals the
//   price already in the page (the build-time price that the static HTML also shows), so the HTML
//   and the JSON-LD always agree. A different Shopify price means the site needs a rebuild: the
//   page is served as built, without availability, and an `offer-price-mismatch` line is logged.
// - Variants: exactly one variant is expected (the trainers have one). Anything else → no offer.
// - Freshness: a fetched offer is reused for OFFER_TTL_SECONDS. A failure (timeout, HTTP or GraphQL
//   error, unexpected data) is remembered for FAILURE_TTL_SECONDS, so an outage costs at most one
//   FETCH_TIMEOUT_MS wait per edge location per minute instead of one per page view.
// - Failure: the page is served exactly as built (build-time price, no availability). Nothing is guessed.
export const OFFER_PAGE = /^\/product\/(br16|ob16|cl16)$/;
export const OFFER_TTL_SECONDS = 300;
export const FAILURE_TTL_SECONDS = 60;
export const FETCH_TIMEOUT_MS = 1000;
export const OFFER_COUNTRY = 'US';
export const OFFER_CURRENCY = 'USD';
export const LIVE_OFFER_ATTRIBUTE = 'data-anawin-live-offer';
const DEFAULT_API_VERSION = '2026-07';
const PRODUCT_BLOCK = /<script type="application\/ld\+json" data-anawin-product>([^<]*)<\/script>/;
const QUERY = 'query ProductOffer($handle: String!, $country: CountryCode!) @inContext(country: $country) { product(handle: $handle) { variants(first: 2) { nodes { availableForSale price { amount currencyCode } } } } }';
// Same escaping as src/seo.js serializeJsonLd.
const serializeJsonLd = value => JSON.stringify(value).replace(/</g, '\\u003c');

export const offerSyncEnabled = env => env?.PRODUCT_OFFER_SYNC === 'on';

// Returns { price: '155.00', currency: 'USD', availability } or null.
export function offerFromStorefront(payload) {
  const nodes = payload?.data?.product?.variants?.nodes;
  if (payload?.errors || !Array.isArray(nodes) || nodes.length !== 1) return null;
  const [{ availableForSale, price } = {}] = nodes;
  const amount = Number(price?.amount);
  if (typeof availableForSale !== 'boolean' || !Number.isFinite(amount) || amount <= 0) return null;
  if (price?.currencyCode !== OFFER_CURRENCY) return null;
  return {
    price: amount.toFixed(2),
    currency: price.currencyCode,
    availability: `https://schema.org/${availableForSale ? 'InStock' : 'OutOfStock'}`
  };
}

// Adds availability to the Product block. Returns { html } on success or { reason } when the page
// must be served as built.
export function applyOffer(html, offer) {
  if (!offer) return { reason: 'no-offer' };
  const match = PRODUCT_BLOCK.exec(html);
  if (!match) return { reason: 'no-product-block' };
  let product;
  try { product = JSON.parse(match[1]); } catch { return { reason: 'invalid-product-block' }; }
  if (product?.['@type'] !== 'Product' || !product.offers) return { reason: 'invalid-product-block' };
  if (product.offers.priceCurrency !== offer.currency) return { reason: 'currency-mismatch' };
  if (product.offers.price !== offer.price) return { reason: 'price-mismatch', built: product.offers.price };
  product.offers = { ...product.offers, availability: offer.availability };
  const script = `<script type="application/ld+json" data-anawin-product ${LIVE_OFFER_ATTRIBUTE}>${serializeJsonLd(product)}</script>`;
  return { html: html.slice(0, match.index) + script + html.slice(match.index + match[0].length) };
}

const cacheKey = (env, handle) => new Request(`https://product-offer.internal/${env.SHOPIFY_STOREFRONT_API_VERSION || DEFAULT_API_VERSION}/${OFFER_COUNTRY}/${handle}`);

// Returns { offer } (offer may be null after a remembered failure) — never throws.
export async function fetchOffer(handle, env, { fetchImpl = fetch, cache = globalThis.caches?.default, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const key = cacheKey(env, handle);
  try {
    const cached = await cache?.match(key);
    if (cached) return { offer: (await cached.json()).offer ?? null, cached: true };
  } catch { /* a cache failure is treated as a miss */ }
  let offer = null;
  try {
    const domain = env.SHOPIFY_STORE_DOMAIN;
    if (/^[a-z0-9-]+\.myshopify\.com$/.test(domain || '')) {
      const response = await fetchImpl(`https://${domain}/api/${env.SHOPIFY_STOREFRONT_API_VERSION || DEFAULT_API_VERSION}/graphql.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: QUERY, variables: { handle, country: OFFER_COUNTRY } }),
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (response.ok) offer = offerFromStorefront(await response.json());
    }
  } catch { offer = null; }
  const ttl = offer ? OFFER_TTL_SECONDS : FAILURE_TTL_SECONDS;
  await cache?.put(key, new Response(JSON.stringify({ offer }), { headers: { 'Cache-Control': `max-age=${ttl}` } })).catch(() => {});
  return { offer, cached: false };
}

export async function serveProductPage(request, env, { log = console.log, ...options } = {}) {
  const handle = OFFER_PAGE.exec(new URL(request.url).pathname)?.[1];
  if (!handle || !offerSyncEnabled(env) || (request.method !== 'GET' && request.method !== 'HEAD')) return env.ASSETS.fetch(request);
  // Ask for a full body: a 304 would let a cache keep an offer this Worker never saw.
  const headers = new Headers(request.headers);
  headers.delete('If-None-Match');
  headers.delete('If-Modified-Since');
  const asset = await env.ASSETS.fetch(new Request(request, { headers }));
  if (asset.status !== 200 || !(asset.headers.get('Content-Type') || '').includes('text/html')) return asset;
  const html = await asset.text();
  const { offer, cached } = await fetchOffer(handle, env, options);
  const result = offer ? applyOffer(html, offer) : { reason: 'no-offer' };
  // Logged once per fetch (not per cached view): the site needs a rebuild to show Shopify's price.
  if (result.reason === 'price-mismatch' && !cached) log({ event: 'offer-price-mismatch', handle, built: result.built, shopify: offer.price });
  const response = new Response(request.method === 'HEAD' ? null : (result.html ?? html), asset);
  // The body may differ from the static file, so its validators no longer describe it.
  response.headers.delete('ETag');
  response.headers.delete('Last-Modified');
  response.headers.delete('Content-Length');
  return response;
}
