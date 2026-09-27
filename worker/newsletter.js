const MAX_BODY_BYTES = 1024;
const EMAIL_PATTERN = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;
const tokenCache = { key: '', token: '', expiresAt: 0, pending: null };

const FIND_CUSTOMER = `query NewsletterCustomer($query: String!) {
  customers(first: 10, query: $query) {
    nodes { id defaultEmailAddress { emailAddress marketingState } }
  }
}`;
const CREATE_CUSTOMER = `mutation NewsletterCustomerCreate($input: CustomerInput!) {
  customerCreate(input: $input) {
    customer { id defaultEmailAddress { emailAddress marketingState } }
    userErrors { field message }
  }
}`;
const UPDATE_CONSENT = `mutation NewsletterConsentUpdate($input: CustomerEmailMarketingConsentUpdateInput!) {
  customerEmailMarketingConsentUpdate(input: $input) {
    customer { id defaultEmailAddress { emailAddress marketingState } }
    userErrors { field message }
  }
}`;

class ApiError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders
    }
  });
}

function normalizeEmail(value) {
  if (typeof value !== 'string') throw new ApiError(400, 'invalid_email');
  const email = value.trim().toLowerCase();
  const local = email.split('@')[0];
  if (email.length > 254 || local.length > 64 || !EMAIL_PATTERN.test(email) ||
      local.startsWith('.') || local.endsWith('.') || local.includes('..')) {
    throw new ApiError(400, 'invalid_email');
  }
  return email;
}

async function readLimitedJson(request) {
  const advertisedLength = Number(request.headers.get('Content-Length'));
  if (advertisedLength > MAX_BODY_BYTES) throw new ApiError(413, 'body_too_large');
  if (!request.body) throw new ApiError(400, 'malformed_body');
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw new ApiError(413, 'body_too_large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new ApiError(400, 'malformed_body'); }
}

function getConfig(env) {
  const domain = env.SHOPIFY_STORE_DOMAIN;
  const version = env.SHOPIFY_ADMIN_API_VERSION;
  const hasStaticToken = Boolean(env.SHOPIFY_ADMIN_ACCESS_TOKEN);
  const hasClientCredentials = Boolean(env.SHOPIFY_CLIENT_ID && env.SHOPIFY_CLIENT_SECRET);
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain || '') ||
      !/^\d{4}-\d{2}$/.test(version || '') ||
      hasStaticToken === hasClientCredentials ||
      env.NEWSLETTER_OPT_IN_MODE !== 'single' ||
      !env.NEWSLETTER_IP_LIMITER?.limit || !env.NEWSLETTER_EMAIL_LIMITER?.limit) {
    throw new ApiError(503, 'signup_unavailable');
  }
  return {
    domain, version, token: env.SHOPIFY_ADMIN_ACCESS_TOKEN,
    clientId: env.SHOPIFY_CLIENT_ID, clientSecret: env.SHOPIFY_CLIENT_SECRET
  };
}

async function hashKey(value) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function enforceLimits(request, email, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const ipKey = await hashKey(`newsletter-ip:${ip}`);
  const ipResult = await env.NEWSLETTER_IP_LIMITER.limit({ key: ipKey });
  if (!ipResult?.success) throw new ApiError(429, 'too_many_requests');
  const emailKey = await hashKey(`newsletter-email:${email}`);
  const emailResult = await env.NEWSLETTER_EMAIL_LIMITER.limit({ key: emailKey });
  if (!emailResult?.success) throw new ApiError(429, 'too_many_requests');
}

async function adminToken(config, fetchImpl, cache) {
  if (config.token) return config.token;
  const key = `${config.domain}:${config.clientId}`;
  if (cache.key !== key) {
    cache.key = key; cache.token = ''; cache.expiresAt = 0; cache.pending = null;
  }
  if (cache.token && Date.now() < cache.expiresAt) return cache.token;
  if (!cache.pending) cache.pending = (async () => {
    let response;
    try {
      response = await fetchImpl(`https://${config.domain}/admin/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: config.clientId, client_secret: config.clientSecret }),
        signal: AbortSignal.timeout(8000)
      });
    } catch { throw new ApiError(503, 'shopify_unavailable'); }
    if (!response.ok) throw new ApiError(503, 'shopify_unavailable');
    let result;
    try { result = await response.json(); }
    catch { throw new ApiError(503, 'shopify_unavailable'); }
    if (typeof result?.access_token !== 'string' || !result.access_token ||
        !Number.isFinite(result.expires_in) || result.expires_in < 600) {
      throw new ApiError(503, 'shopify_unavailable');
    }
    cache.token = result.access_token;
    cache.expiresAt = Date.now() + (result.expires_in - 300) * 1000;
    return cache.token;
  })();
  try { return await cache.pending; }
  finally { cache.pending = null; }
}

async function shopify(config, query, variables, fetchImpl, authCache, retried = false) {
  const token = await adminToken(config, fetchImpl, authCache);
  let response;
  try {
    response = await fetchImpl(`https://${config.domain}/admin/api/${config.version}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(8000)
    });
  } catch { throw new ApiError(503, 'shopify_unavailable'); }
  if (response.status === 401 && !config.token && !retried) {
    authCache.token = '';
    authCache.expiresAt = 0;
    return shopify(config, query, variables, fetchImpl, authCache, true);
  }
  if (!response.ok) throw new ApiError(503, 'shopify_unavailable');
  let result;
  try { result = await response.json(); }
  catch { throw new ApiError(503, 'shopify_unavailable'); }
  if (!result || !result.data || result.errors?.length) throw new ApiError(503, 'shopify_unavailable');
  return result.data;
}

function confirmedState(customer, email) {
  const address = customer?.defaultEmailAddress;
  if (!customer?.id || address?.emailAddress?.toLowerCase() !== email) throw new ApiError(503, 'shopify_unavailable');
  const state = address.marketingState;
  if (state !== 'SUBSCRIBED' && state !== 'PENDING') throw new ApiError(503, 'shopify_unavailable');
  return state;
}

async function findCustomer(email, config, fetchImpl, authCache) {
  const escaped = email.replace(/[\\"]/g, '\\$&');
  const data = await shopify(config, FIND_CUSTOMER, { query: `email:"${escaped}"` }, fetchImpl, authCache);
  const nodes = data.customers?.nodes;
  if (!Array.isArray(nodes)) throw new ApiError(503, 'shopify_unavailable');
  const matches = nodes.filter(node => node?.defaultEmailAddress?.emailAddress?.toLowerCase() === email);
  if (matches.length > 1) throw new ApiError(503, 'shopify_unavailable');
  return matches[0] || null;
}

function consentInput(now) {
  return {
    marketingState: 'SUBSCRIBED',
    marketingOptInLevel: 'SINGLE_OPT_IN',
    consentUpdatedAt: now().toISOString()
  };
}

async function subscribeExisting(customer, email, config, fetchImpl, authCache, now) {
  const state = customer.defaultEmailAddress?.marketingState;
  if (state === 'SUBSCRIBED' || state === 'PENDING') return state;
  if (state !== 'NOT_SUBSCRIBED' && state !== 'UNSUBSCRIBED') throw new ApiError(503, 'shopify_unavailable');
  const data = await shopify(config, UPDATE_CONSENT, {
    input: { customerId: customer.id, emailMarketingConsent: consentInput(now) }
  }, fetchImpl, authCache);
  const result = data.customerEmailMarketingConsentUpdate;
  if (result?.userErrors?.length) throw new ApiError(503, 'shopify_unavailable');
  return confirmedState(result?.customer, email);
}

async function subscribe(email, config, fetchImpl, authCache, now) {
  const existing = await findCustomer(email, config, fetchImpl, authCache);
  if (existing) return subscribeExisting(existing, email, config, fetchImpl, authCache, now);
  const data = await shopify(config, CREATE_CUSTOMER, {
    input: { email, emailMarketingConsent: consentInput(now) }
  }, fetchImpl, authCache);
  const result = data.customerCreate;
  if (result?.userErrors?.length) {
    // A concurrent signup may have created the customer after the first lookup.
    const racedCustomer = await findCustomer(email, config, fetchImpl, authCache);
    if (racedCustomer) return subscribeExisting(racedCustomer, email, config, fetchImpl, authCache, now);
    throw new ApiError(503, 'shopify_unavailable');
  }
  return confirmedState(result?.customer, email);
}

export async function handleNewsletter(request, env, { fetchImpl = fetch, now = () => new Date(), authCache = tokenCache } = {}) {
  if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
  try {
    if (request.headers.get('Origin') !== new URL(request.url).origin) throw new ApiError(403, 'forbidden');
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('Content-Type') || '')) {
      throw new ApiError(415, 'unsupported_media_type');
    }
    const body = await readLimitedJson(request);
    if (!body || Array.isArray(body) || typeof body !== 'object' ||
        Object.keys(body).some(key => key !== 'email' && key !== 'consent')) {
      throw new ApiError(400, 'malformed_body');
    }
    if (body.email === undefined || body.email === null || body.email === '') throw new ApiError(400, 'email_required');
    const email = normalizeEmail(body.email);
    if (body.consent !== true) throw new ApiError(400, 'consent_required');
    const config = getConfig(env);
    await enforceLimits(request, email, env);
    const marketingState = await subscribe(email, config, fetchImpl, authCache, now);
    return json(200, { marketingState });
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 503;
    const code = error instanceof ApiError ? error.code : 'signup_unavailable';
    return json(status, { error: code }, status === 429 ? { 'Retry-After': '60' } : {});
  }
}
