import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import * as entry from '../worker/index.js';
import { HASHED_ASSET, IMMUTABLE_CACHE_CONTROL } from '../worker/asset-cache.js';

const worker = entry.default;

const REVALIDATE = 'public, max-age=0, must-revalidate';
const assetsEnv = (status = 200, body = 'asset') => {
  const calls = [];
  return {
    calls,
    ASSETS: {
      fetch: async request => {
        calls.push(new URL(request.url).pathname);
        return new Response(status === 304 ? null : body, {
          status,
          headers: { 'Cache-Control': REVALIDATE, 'ETag': '"abc"', 'X-Content-Type-Options': 'nosniff', 'Content-Type': status === 404 ? 'text/html' : 'text/javascript' }
        });
      }
    }
  };
};
const get = (path, env) => worker.fetch(new Request(`https://anawinofficial.com${path}`), env);

test('found hashed JS and CSS are cached as immutable, keeping body and asset headers', async () => {
  for (const path of ['/assets/index-DtO9cLB0.js', '/assets/index-COCzBZOZ.css', '/assets/index-a_b-C9xY.js']) {
    const env = assetsEnv();
    const response = await get(path, env);
    assert.equal(response.status, 200, path);
    assert.equal(await response.text(), 'asset');
    assert.equal(response.headers.get('Cache-Control'), IMMUTABLE_CACHE_CONTROL, path);
    assert.equal(response.headers.get('ETag'), '"abc"');
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.deepEqual(env.calls, [path]);
  }
  const revalidated = await get('/assets/index-DtO9cLB0.js', assetsEnv(304));
  assert.equal(revalidated.status, 304);
  assert.equal(revalidated.headers.get('Cache-Control'), IMMUTABLE_CACHE_CONTROL);
});

test('a missing hashed asset keeps the revalidating 404 so the not-found page is never cached long', async () => {
  const response = await get('/assets/index-MISSING1.js', assetsEnv(404, '<!doctype html>not found'));
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('Cache-Control'), REVALIDATE);
});

test('HTML, images, unhashed files, and API routes never receive the immutable policy', async () => {
  for (const path of ['/', '/about', '/product/br16', '/images/optimized/black1-960.webp', '/gallery-loading.js', '/assets/index.js', '/assets/logo-1.svg', '/sitemap.xml']) {
    const response = await get(path, assetsEnv());
    assert.equal(response.headers.get('Cache-Control'), REVALIDATE, path);
  }
  const api = await get('/api/unknown', assetsEnv());
  assert.equal(api.headers.get('Cache-Control'), 'no-store');
});

test('every built /assets file is hashed, and the Worker runs first only for /api and /assets', () => {
  const built = readdirSync(new URL('../dist/assets/', import.meta.url));
  assert.ok(built.length >= 2);
  for (const name of built) assert.match(`/assets/${name}`, HASHED_ASSET, name);
  const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  assert.deepEqual(config.assets.run_worker_first, ['/api/*', '/assets/*']);
  assert.equal(config.assets.not_found_handling, '404-page');
});

// workerd rejects any non-handler export from the entry module, so a stray constant export fails the deploy.
test('the Worker entry module exports only its default handler', () => {
  assert.deepEqual(Object.keys(entry), ['default']);
  assert.equal(typeof entry.default.fetch, 'function');
});
