import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import worker from '../worker/index.js';
import { handleNewsletter } from '../worker/newsletter.js';

const ENDPOINT = 'https://anawinofficial.com/api/newsletter';
const TEST_SECRET_SENTINEL = 'test-binding-present';
const customer = (state, email = 'hello@example.com') => ({
  id: 'gid://shopify/Customer/1',
  defaultEmailAddress: { emailAddress: email, marketingState: state }
});
const graphql = data => Response.json({ data });
const request = (body = { email: 'hello@example.com', consent: true }, options = {}) => new Request(ENDPOINT, {
  method: options.method || 'POST',
  headers: {
    Origin: options.origin ?? 'https://anawinofficial.com',
    'Content-Type': options.contentType ?? 'application/json',
    'CF-Connecting-IP': '192.0.2.10',
    ...options.headers
  },
  body: options.method === 'GET' ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
});
function fixture(replies = [], overrides = {}) {
  const calls = [];
  const keys = [];
  const authCache = { key: '', token: '', expiresAt: 0, pending: null };
  const env = {
    SHOPIFY_STORE_DOMAIN: 'example.myshopify.com',
    SHOPIFY_ADMIN_API_VERSION: '2026-07',
    SHOPIFY_ADMIN_ACCESS_TOKEN: TEST_SECRET_SENTINEL,
    NEWSLETTER_OPT_IN_MODE: 'single',
    NEWSLETTER_IP_LIMITER: { limit: async ({ key }) => { keys.push(key); return { success: true }; } },
    NEWSLETTER_EMAIL_LIMITER: { limit: async ({ key }) => { keys.push(key); return { success: true }; } },
    ...overrides
  };
  const fetchImpl = async (url, init) => {
    const body = init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : JSON.parse(init.body);
    calls.push({ url, init, body });
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    if (!reply) throw new Error('Unexpected Shopify request');
    return reply;
  };
  return { env, calls, keys, fetchImpl, run: (req = request()) => handleNewsletter(req, env, { fetchImpl, authCache, now: () => new Date('2026-09-26T00:00:00.000Z') }) };
}

test('new subscriber is created with single opt-in and returned only after Shopify confirms', async () => {
  const f = fixture([graphql({ customers: { nodes: [] } }), graphql({ customerCreate: { userErrors: [], customer: customer('SUBSCRIBED') } })]);
  const response = await f.run(request({ email: ' HELLO@Example.com ', consent: true }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { marketingState: 'SUBSCRIBED' });
  assert.match(f.calls[0].body.query, /customers\(/);
  assert.match(f.calls[1].body.query, /customerCreate\(/);
  assert.deepEqual(f.calls[1].body.variables.input, {
    email: 'hello@example.com',
    emailMarketingConsent: {
      marketingState: 'SUBSCRIBED', marketingOptInLevel: 'SINGLE_OPT_IN', consentUpdatedAt: '2026-09-26T00:00:00.000Z'
    }
  });
  assert.equal(f.calls[0].url, 'https://example.myshopify.com/admin/api/2026-07/graphql.json');
  assert.equal(f.calls[0].init.headers['X-Shopify-Access-Token'], TEST_SECRET_SENTINEL);
  assert.doesNotMatch(JSON.stringify(await (await f.run(request({ email: 'bad', consent: true }))).json()), /test-binding-present/);
  assert.equal(f.keys.length, 2);
  assert.ok(f.keys.every(key => /^[a-f0-9]{64}$/.test(key)));
});

test('new Dev Dashboard app credentials obtain and reuse a server-side 24-hour Admin token', async () => {
  const runtimeToken = 'runtime-test-sentinel';
  const f = fixture([
    Response.json({ access_token: runtimeToken, expires_in: 86399 }),
    graphql({ customers: { nodes: [] } }),
    graphql({ customerCreate: { userErrors: [], customer: customer('SUBSCRIBED') } }),
    graphql({ customers: { nodes: [customer('SUBSCRIBED')] } })
  ], { SHOPIFY_ADMIN_ACCESS_TOKEN: '', SHOPIFY_CLIENT_ID: 'test-client-id', SHOPIFY_CLIENT_SECRET: 'test-client-secret' });
  assert.equal((await f.run()).status, 200);
  assert.equal((await f.run()).status, 200);
  assert.equal(f.calls.length, 4);
  assert.equal(f.calls[0].url, 'https://example.myshopify.com/admin/oauth/access_token');
  assert.deepEqual(f.calls[0].body, { grant_type: 'client_credentials', client_id: 'test-client-id', client_secret: 'test-client-secret' });
  assert.equal(f.calls[1].init.headers['X-Shopify-Access-Token'], runtimeToken);
  assert.equal(f.calls[3].init.headers['X-Shopify-Access-Token'], runtimeToken);
});

test('existing unsubscribed customer receives a consent update, not a new customer', async () => {
  const f = fixture([
    graphql({ customers: { nodes: [customer('UNSUBSCRIBED')] } }),
    graphql({ customerEmailMarketingConsentUpdate: { userErrors: [], customer: customer('SUBSCRIBED') } })
  ]);
  assert.deepEqual(await (await f.run()).json(), { marketingState: 'SUBSCRIBED' });
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[1].body.query, /customerEmailMarketingConsentUpdate\(/);
  assert.equal(f.calls[1].body.variables.input.customerId, 'gid://shopify/Customer/1');
});

test('already subscribed and pending customers keep their Shopify states without mutation', async () => {
  for (const state of ['SUBSCRIBED', 'PENDING']) {
    const f = fixture([graphql({ customers: { nodes: [customer(state)] } })]);
    assert.deepEqual(await (await f.run()).json(), { marketingState: state });
    assert.equal(f.calls.length, 1);
  }
});

test('a concurrent duplicate creation re-queries and updates the existing customer', async () => {
  const f = fixture([
    graphql({ customers: { nodes: [] } }),
    graphql({ customerCreate: { userErrors: [{ field: ['email'], message: 'already taken' }], customer: null } }),
    graphql({ customers: { nodes: [customer('NOT_SUBSCRIBED')] } }),
    graphql({ customerEmailMarketingConsentUpdate: { userErrors: [], customer: customer('SUBSCRIBED') } })
  ]);
  assert.deepEqual(await (await f.run()).json(), { marketingState: 'SUBSCRIBED' });
  assert.equal(f.calls.length, 4);
});

test('new and existing customers can return pending without a subscribed claim', async () => {
  const created = fixture([graphql({ customers: { nodes: [] } }), graphql({ customerCreate: { userErrors: [], customer: customer('PENDING') } })]);
  assert.deepEqual(await (await created.run()).json(), { marketingState: 'PENDING' });
  const updated = fixture([
    graphql({ customers: { nodes: [customer('NOT_SUBSCRIBED')] } }),
    graphql({ customerEmailMarketingConsentUpdate: { userErrors: [], customer: customer('PENDING') } })
  ]);
  assert.deepEqual(await (await updated.run()).json(), { marketingState: 'PENDING' });
});

test('request validation rejects missing or malformed email, consent, body, type, method, and origin', async () => {
  const cases = [
    [request({ consent: true }), 400, 'email_required'],
    [request({ email: 'bad', consent: true }), 400, 'invalid_email'],
    [request({ email: 'hello@example..com', consent: true }), 400, 'invalid_email'],
    [request({ email: 'hello@example.com', consent: false }), 400, 'consent_required'],
    [request('{', {}), 400, 'malformed_body'],
    [request({ email: 'hello@example.com', consent: true, customerId: 'fake' }), 400, 'malformed_body'],
    [request({ email: 'hello@example.com', consent: true }, { contentType: 'text/plain' }), 415, 'unsupported_media_type'],
    [request({}, { method: 'GET' }), 405, 'method_not_allowed'],
    [request({}, { origin: 'https://evil.example' }), 403, 'forbidden'],
    [request('x'.repeat(1025)), 413, 'body_too_large']
  ];
  for (const [req, status, code] of cases) {
    const f = fixture();
    const response = await f.run(req);
    assert.equal(response.status, status, code);
    assert.deepEqual(await response.json(), { error: code });
    assert.equal(f.calls.length, 0, code);
  }
});

test('Shopify userErrors, GraphQL errors, HTTP and network errors fail closed', async () => {
  const cases = [
    [graphql({ customers: { nodes: [] } }), graphql({ customerCreate: { userErrors: [{ message: 'private Shopify error' }], customer: null } }), graphql({ customers: { nodes: [] } })],
    [graphql({ customers: { nodes: [customer('UNSUBSCRIBED')] } }), graphql({ customerEmailMarketingConsentUpdate: { userErrors: [{ message: 'private Shopify error' }], customer: null } })],
    [Response.json({ errors: [{ message: 'private Shopify error' }] })],
    [new Response('bad gateway', { status: 502 })],
    [new Error('private network error')],
    [graphql({ customers: { nodes: [] } }), graphql({ customerCreate: { userErrors: [], customer: customer('NOT_SUBSCRIBED') } })]
  ];
  for (const replies of cases) {
    const f = fixture(replies);
    const response = await f.run();
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'shopify_unavailable' });
    assert.doesNotMatch(await response.text().catch(() => ''), /private Shopify error|private network error/);
  }
});

test('client credentials exchange failure does not call the Admin API', async () => {
  const f = fixture([new Response('denied', { status: 401 })], {
    SHOPIFY_ADMIN_ACCESS_TOKEN: '', SHOPIFY_CLIENT_ID: 'test-client-id', SHOPIFY_CLIENT_SECRET: 'test-client-secret'
  });
  const response = await f.run();
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'shopify_unavailable' });
  assert.equal(f.calls.length, 1);
});

test('an expired client-credentials token is renewed once after Shopify returns 401', async () => {
  const f = fixture([
    Response.json({ access_token: 'first-runtime-sentinel', expires_in: 86399 }),
    new Response('expired', { status: 401 }),
    Response.json({ access_token: 'renewed-runtime-sentinel', expires_in: 86399 }),
    graphql({ customers: { nodes: [customer('SUBSCRIBED')] } })
  ], { SHOPIFY_ADMIN_ACCESS_TOKEN: '', SHOPIFY_CLIENT_ID: 'test-client-id', SHOPIFY_CLIENT_SECRET: 'test-client-secret' });
  assert.deepEqual(await (await f.run()).json(), { marketingState: 'SUBSCRIBED' });
  assert.equal(f.calls[3].init.headers['X-Shopify-Access-Token'], 'renewed-runtime-sentinel');
});

test('missing secret, domain, opt-in decision, or limiter prevents Shopify access', async () => {
  for (const override of [
    { SHOPIFY_ADMIN_ACCESS_TOKEN: '' }, { SHOPIFY_STORE_DOMAIN: '' },
    { NEWSLETTER_OPT_IN_MODE: '' }, { NEWSLETTER_IP_LIMITER: null },
    { SHOPIFY_CLIENT_ID: 'id', SHOPIFY_CLIENT_SECRET: 'secret' }
  ]) {
    const f = fixture([], override);
    const response = await f.run();
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'signup_unavailable' });
    assert.equal(f.calls.length, 0);
  }
});

test('native rate limit returns 429 without contacting Shopify', async () => {
  const f = fixture([], { NEWSLETTER_IP_LIMITER: { limit: async () => ({ success: false }) } });
  const response = await f.run();
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('Retry-After'), '60');
  assert.equal(f.calls.length, 0);
});

test('newsletter API success and errors keep JSON security and cache headers', async () => {
  const success = fixture([
    graphql({ customers: { nodes: [] } }),
    graphql({ customerCreate: { userErrors: [], customer: customer('SUBSCRIBED') } })
  ]);
  const invalid = fixture();
  const method = fixture();
  const limited = fixture([], { NEWSLETTER_IP_LIMITER: { limit: async () => ({ success: false }) } });
  const unexpected = fixture([], { NEWSLETTER_IP_LIMITER: { limit: async () => { throw new Error('private limiter detail'); } } });
  const cases = [
    [await success.run(), 200],
    [await worker.fetch(request({ consent: true }), invalid.env), 400],
    [await worker.fetch(request({}, { method: 'GET' }), method.env), 405],
    [await worker.fetch(request(), limited.env), 429],
    [await worker.fetch(request(), unexpected.env), 503]
  ];
  for (const [response, status] of cases) {
    assert.equal(response.status, status);
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(response.headers.get('Content-Type'), 'application/json; charset=utf-8');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('Strict-Transport-Security'), null);
    assert.equal(response.headers.get('Content-Security-Policy'), null);
  }
  assert.equal(cases[2][0].headers.get('Allow'), 'POST');
  assert.equal(cases[3][0].headers.get('Retry-After'), '60');
  assert.deepEqual(await cases[4][0].json(), { error: 'signup_unavailable' });
});

test('unknown API routes stay JSON 404 and static requests delegate to the assets binding', async () => {
  const env = { ASSETS: { fetch: async () => new Response('static asset') } };
  const missing = await worker.fetch(new Request('https://anawinofficial.com/api/other'), env);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'not_found' });
  assert.equal(missing.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(missing.headers.get('Content-Type'), 'application/json; charset=utf-8');
  assert.equal(missing.headers.get('Cache-Control'), 'no-store');
  assert.equal(missing.headers.get('Strict-Transport-Security'), null);
  assert.equal(missing.headers.get('Content-Security-Policy'), null);
  const staticResponse = await worker.fetch(new Request('https://anawinofficial.com/about'), env);
  assert.equal(await staticResponse.text(), 'static asset');
  assert.equal(staticResponse.headers.get('X-Content-Type-Options'), null);
});

test('production client bundle contains no Admin token or Admin secret binding name', async () => {
  const assets = new URL('../dist/assets/', import.meta.url);
  const names = (await readdir(assets)).filter(name => name.endsWith('.js'));
  const bundle = (await Promise.all(names.map(name => readFile(new URL(name, assets), 'utf8')))).join('\n');
  assert.ok(bundle.length > 0);
  assert.doesNotMatch(bundle, /SHOPIFY_ADMIN_ACCESS_TOKEN|SHOPIFY_CLIENT_SECRET|test-binding-present|\/admin\/api\//);
});
