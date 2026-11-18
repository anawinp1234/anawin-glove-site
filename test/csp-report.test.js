import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../worker/index.js';
import { handleCspReport, redactUrl, MAX_BODY_BYTES, MAX_REPORTS } from '../worker/csp-report.js';

const SITE = 'https://anawinofficial.com';
const post = (body, type, extra = {}) => new Request(`${SITE}/api/csp-report`, {
  method: 'POST', headers: { 'Content-Type': type, ...extra }, body: typeof body === 'string' ? body : JSON.stringify(body)
});
async function collect(request, env = {}) {
  const lines = [];
  const response = await handleCspReport(request, env, { log: line => lines.push(line) });
  return { response, lines };
}
const legacy = fields => ({ 'csp-report': { 'document-uri': `${SITE}/`, 'effective-directive': 'img-src', ...fields } });

test('a legacy report-uri report is reduced to sanitized, indexable fields', async () => {
  const { response, lines } = await collect(post(legacy({
    'document-uri': `${SITE}/product/br16?email=a%40b.com#x`,
    'blocked-uri': 'https://user:pw@evil.example/track/SECRET-TOKEN/pixel.gif?id=123', 'violated-directive': 'img-src',
    'source-file': `${SITE}/assets/index-abc12345.js?v=1`, 'line-number': 12, disposition: 'report',
    'status-code': 200, 'script-sample': 'secret()'
  }), 'application/csp-report'));
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.deepEqual(lines, [{
    event: 'csp-violation', directive: 'img-src', blocked: 'https://evil.example',
    document: `${SITE}/product/br16`, source: `${SITE}/assets/index-abc12345.js`,
    line: 12, disposition: 'report', status: 200
  }]);
  const text = JSON.stringify(lines);
  for (const secret of ['secret', 'SECRET-TOKEN', 'email', 'user', 'pw@', 'id=123']) assert.ok(!text.includes(secret), secret);
});

test('third-party script sources keep only their origin; control characters never reach the log', async () => {
  const { lines } = await collect(post(legacy({ 'source-file': 'https://cdn.example/a/b.js', 'blocked-uri': 'inline', 'document-uri': `${SITE}/faq\u0000\u001b[31m` }), 'application/csp-report'));
  assert.equal(lines[0].source, 'https://cdn.example');
  assert.equal(lines[0].blocked, 'inline');
  assert.ok(!/[\u0000-\u001f]/.test(JSON.stringify(lines[0])));
});

test('Reporting API batches log only distinct csp-violation entries, capped per request', async () => {
  const violation = n => ({ type: 'csp-violation', body: { documentURL: `${SITE}/p${n}`, blockedURL: 'inline', effectiveDirective: 'script-src-elem', disposition: 'report', sample: 'x' } });
  const batch = [violation(0), violation(0), { type: 'deprecation', body: {} }, ...Array.from({ length: 30 }, (_, n) => violation(n + 1))];
  const { response, lines } = await collect(post(batch, 'application/reports+json'));
  assert.equal(response.status, 204);
  assert.ok(lines.length <= MAX_REPORTS);
  assert.equal(new Set(lines.map(line => JSON.stringify(line))).size, lines.length, 'duplicates collapsed');
  assert.deepEqual(lines[0], { event: 'csp-violation', directive: 'script-src-elem', blocked: 'inline', document: `${SITE}/p0`, disposition: 'report' });
});

test('reports that do not describe a page on this site, or carry invalid fields, are dropped', async () => {
  for (const fields of [
    { 'document-uri': 'https://elsewhere.example/' },
    { 'document-uri': 'not a url' },
    { 'effective-directive': 'img-src; drop table' },
    { 'effective-directive': 42 }
  ]) {
    const { response, lines } = await collect(post(legacy(fields), 'application/csp-report'));
    assert.equal(response.status, 204, JSON.stringify(fields));
    assert.equal(lines.length, 0, JSON.stringify(fields));
  }
  const { lines } = await collect(post(legacy({ disposition: 'evil', 'line-number': -3, 'status-code': 1e9 }), 'application/csp-report'));
  assert.deepEqual(lines, [{ event: 'csp-violation', directive: 'img-src', document: `${SITE}/` }]);
});

test('wrong method, type, size or JSON is rejected without logging', async () => {
  const get = await handleCspReport(new Request(`${SITE}/api/csp-report`));
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('Allow'), 'POST');
  for (const [request, status] of [
    [post('{}', 'text/plain'), 415],
    [post('x'.repeat(MAX_BODY_BYTES + 1), 'application/csp-report'), 413],
    [post('{"csp-report":', 'application/csp-report'), 400]
  ]) {
    const { response, lines } = await collect(request);
    assert.equal(response.status, status);
    assert.equal(lines.length, 0);
  }
  assert.equal((await collect(post({ unrelated: true }, 'application/json'))).lines.length, 0);
});

test('a per-IP rate limit silently drops reports once exceeded; limiter errors fail closed', async () => {
  const keys = [];
  const limiter = allowed => ({ limit: async ({ key }) => { keys.push(key); return { success: allowed }; } });
  const request = () => post(legacy({}), 'application/csp-report', { 'CF-Connecting-IP': '203.0.113.9' });
  assert.equal((await collect(request(), { CSP_REPORT_LIMITER: limiter(true) })).lines.length, 1);
  const blocked = await collect(request(), { CSP_REPORT_LIMITER: limiter(false) });
  assert.equal(blocked.response.status, 204);
  assert.equal(blocked.lines.length, 0);
  assert.deepEqual(keys, ['csp:203.0.113.9', 'csp:203.0.113.9']);
  const broken = await collect(request(), { CSP_REPORT_LIMITER: { limit: async () => { throw new Error('down'); } } });
  assert.equal(broken.lines.length, 0);
  // Malformed bodies are rejected before the limiter is consulted.
  const before = keys.length;
  await collect(post('{', 'application/csp-report'), { CSP_REPORT_LIMITER: limiter(true) });
  assert.equal(keys.length, before);
});

test('URL redaction keeps scheme, host and (same-site only) path, and passes CSP keywords through', () => {
  assert.equal(redactUrl('https://a.example/p?q=1#f'), 'https://a.example/p');
  assert.equal(redactUrl('https://a.example/p', SITE), 'https://a.example');
  assert.equal(redactUrl(`${SITE}/x?y=1`, SITE), `${SITE}/x`);
  assert.equal(redactUrl(`${SITE}/x`, SITE, { keepPath: false }), SITE);
  assert.equal(redactUrl('data:image/png;base64,AAAA'), 'data');
  assert.equal(redactUrl('EVAL'), 'eval');
  assert.equal(redactUrl('not a url with spaces'), undefined);
  assert.equal(redactUrl(42), undefined);
});

test('the Worker routes /api/csp-report to the collector with its rate limiter', async () => {
  let used = false;
  const env = { CSP_REPORT_LIMITER: { limit: async () => { used = true; return { success: false }; } } };
  const response = await worker.fetch(post(legacy({}), 'application/csp-report'), env);
  assert.equal(response.status, 204);
  assert.equal(used, true);
});

test('deployment config keeps CSP summaries without per-request invocation logs, and rate limits reports', () => {
  const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  assert.deepEqual(config.observability, { enabled: true, logs: { enabled: true, invocation_logs: false, head_sampling_rate: 1 } });
  const limiter = config.ratelimits.find(item => item.name === 'CSP_REPORT_LIMITER');
  assert.deepEqual(limiter.simple, { limit: 30, period: 60 });
  assert.equal(new Set(config.ratelimits.map(item => item.namespace_id)).size, config.ratelimits.length, 'limiters must not share a namespace');
});
