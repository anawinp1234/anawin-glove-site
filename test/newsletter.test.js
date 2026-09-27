import test from 'node:test';
import assert from 'node:assert/strict';
import { createNewsletterSignup, validateNewsletterSignup } from '../src/newsletter.js';
import { createStorefrontRenderer } from '../src/storefront-render.js';
import { breakInService, localProducts } from '../src/catalog.js';

test('Home places the labeled signup above the footer with explicit unchecked consent', () => {
  const renderer = createStorefrontRenderer({ products: localProducts, breakInService });
  const home = renderer.route('/');
  assert.match(home, /JOIN OUR<br>COMMUNITY/);
  assert.match(home, /Be the first to hear about new gloves, releases, and what’s next\./);
  assert.match(home, /<label class="visually-hidden" for="newsletter-email">Email address<\/label>/);
  assert.match(home, /type="email"[^>]*required/);
  assert.match(home, /type="checkbox"[^>]*required/);
  assert.doesNotMatch(home, /type="checkbox"[^>]*checked/);
  assert.ok(home.indexOf('class="newsletter"') > home.indexOf('class="statement"'));
  assert.doesNotMatch(renderer.route('/shop'), /data-newsletter-form/);
});

test('empty and invalid emails are rejected without a network call', async () => {
  let calls = 0;
  const signup = createNewsletterSignup({ fetchImpl: () => { calls++; } });
  assert.deepEqual(validateNewsletterSignup('', true), { field: 'email', message: 'Enter your email address.' });
  assert.equal((await signup.submit('', true)).status, 'invalid');
  assert.equal((await signup.submit('not-an-email', true)).status, 'invalid');
  assert.equal((await signup.submit('name@example..com', true)).status, 'invalid');
  assert.equal(calls, 0);
});

test('affirmative marketing consent is required and sent with a valid signup', async () => {
  const requests = [];
  const signup = createNewsletterSignup({ fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({ marketingState: 'SUBSCRIBED' }) };
  } });
  assert.equal((await signup.submit('hello@example.com', false)).field, 'consent');
  assert.equal(requests.length, 0);
  const result = await signup.submit(' hello@example.com ', true);
  assert.equal(result.status, 'success');
  assert.equal(result.message, 'YOU’RE IN. WELCOME TO THE COMMUNITY.');
  assert.equal(requests[0].url, '/api/newsletter');
  assert.deepEqual(JSON.parse(requests[0].options.body), { email: 'hello@example.com', consent: true });
});

test('pending consent asks for confirmation rather than claiming subscription', async () => {
  const signup = createNewsletterSignup({ fetchImpl: async () => ({ ok: true, json: async () => ({ marketingState: 'PENDING' }) }) });
  assert.equal((await signup.submit('hello@example.com', true)).status, 'pending');
});

test('server validation and rate-limit responses have useful client messages', async () => {
  const invalid = createNewsletterSignup({ fetchImpl: async () => ({
    ok: false, status: 400, json: async () => ({ error: 'invalid_email' })
  }) });
  assert.deepEqual(await invalid.submit('hello@example.com', true), {
    status: 'invalid', field: 'email', message: 'Enter a valid email address.'
  });
  const limited = createNewsletterSignup({ fetchImpl: async () => ({
    ok: false, status: 429, json: async () => ({ error: 'too_many_requests' })
  }) });
  assert.match((await limited.submit('hello@example.com', true)).message, /Too many signup attempts/);
});

test('Shopify rejection, API failure, and network failure never show success', async () => {
  for (const response of [
    { ok: true, json: async () => ({ marketingState: 'NOT_SUBSCRIBED' }) },
    { ok: false, status: 500 },
    new Error('Network failed')
  ]) {
    const signup = createNewsletterSignup({ fetchImpl: async () => {
      if (response instanceof Error) throw response;
      return response;
    } });
    assert.equal((await signup.submit('hello@example.com', true)).status, 'error');
  }
});

test('duplicate submissions are blocked until the first request completes', async () => {
  let release;
  let calls = 0;
  const signup = createNewsletterSignup({ fetchImpl: () => {
    calls++;
    return new Promise(resolve => { release = resolve; });
  } });
  const first = signup.submit('hello@example.com', true);
  assert.equal(signup.busy, true);
  assert.deepEqual(await signup.submit('hello@example.com', true), { status: 'busy' });
  assert.equal(calls, 1);
  release({ ok: true, json: async () => ({ marketingState: 'SUBSCRIBED' }) });
  assert.equal((await first).status, 'success');
  assert.equal(signup.busy, false);
});
