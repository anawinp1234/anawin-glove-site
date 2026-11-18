// Collects Content-Security-Policy-Report-Only violations so the policy can be tuned from real
// browsers before it is ever enforced. Accepts both report formats:
//   report-uri → application/csp-report     {"csp-report": {...}}         (used by public/_headers)
//   report-to  → application/reports+json   [{"type":"csp-violation","body":{...}}]  (accepted, not configured)
// Each accepted report becomes one compact JSON log line (Workers Logs indexes the fields; with
// observability.logs.invocation_logs false these lines are the only routine logs this Worker keeps).
//
// Sanitization: no query strings, fragments, credentials or script samples are logged. A blocked
// third-party URL is reduced to its origin (its path could carry tokens); document and source URLs
// keep their path only when they are on this site. Abuse controls: POST only, three content types,
// 8 KB body cap, at most 10 distinct reports per request, reports must name a page on this origin,
// and a per-IP rate limit. Dropped reports still get 204 so senders learn nothing.
export const CSP_REPORT_PATH = '/api/csp-report';
export const MAX_BODY_BYTES = 8 * 1024;
export const MAX_REPORTS = 10;
const TYPES = ['application/csp-report', 'application/reports+json', 'application/json'];
const HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const DISPOSITIONS = new Set(['enforce', 'report']);

const respond = (status, extra = {}) => new Response(null, { status, headers: { ...HEADERS, ...extra } });
const clean = value => value.replace(/[\u0000-\u001f\u007f]/g, '');

// keepPath: keep the path only for URLs on `origin`; anything else is reduced to its origin.
export function redactUrl(value, origin = null, { keepPath = true } = {}) {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return url.protocol.replace(/:$/, '').slice(0, 16);
    const samePage = keepPath && (origin === null || url.origin === origin);
    return clean(samePage ? `${url.origin}${url.pathname}` : url.origin).slice(0, 200);
  } catch {
    // CSP keywords: inline, eval, wasm-eval, trusted-types-sink, ...
    return /^[a-z-]{1,32}$/i.test(value) ? value.toLowerCase() : undefined;
  }
}

const integer = (value, max) => Number.isInteger(value) && value >= 0 && value <= max ? value : undefined;

export function summarizeReport(raw, origin = null) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  // Reporting API bodies use camelCase; legacy report-uri bodies use hyphenated keys.
  const legacy = 'document-uri' in raw || 'violated-directive' in raw || 'effective-directive' in raw;
  const pick = (camel, hyphen) => legacy ? raw[hyphen] : raw[camel];
  const rawDirective = pick('effectiveDirective', 'effective-directive') ?? raw['violated-directive'];
  const directive = typeof rawDirective === 'string' ? rawDirective.trim().split(/\s/)[0].toLowerCase() : '';
  if (!/^[a-z-]{1,40}$/.test(directive)) return null;
  const document = redactUrl(pick('documentURL', 'document-uri'), origin);
  // A report must describe a page on this site; anything else is noise or forgery.
  if (origin !== null && (!document || !document.startsWith(`${origin}/`) && document !== origin)) return null;
  const disposition = pick('disposition', 'disposition');
  return {
    event: 'csp-violation',
    directive,
    blocked: redactUrl(pick('blockedURL', 'blocked-uri'), origin, { keepPath: false }),
    document,
    source: redactUrl(pick('sourceFile', 'source-file'), origin),
    line: integer(pick('lineNumber', 'line-number'), 10_000_000),
    disposition: DISPOSITIONS.has(disposition) ? disposition : undefined,
    status: integer(pick('statusCode', 'status-code'), 999)
  };
}

export function extractReports(contentType, payload) {
  if (contentType === 'application/reports+json' || Array.isArray(payload)) {
    if (!Array.isArray(payload)) return [];
    return payload.filter(item => item?.type === 'csp-violation').map(item => item.body);
  }
  return payload && typeof payload === 'object' && payload['csp-report'] ? [payload['csp-report']] : [];
}

async function readLimitedText(request) {
  const advertised = Number(request.headers.get('Content-Length'));
  if (advertised > MAX_BODY_BYTES) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

export async function handleCspReport(request, env = {}, { log = console.log } = {}) {
  if (request.method !== 'POST') return respond(405, { Allow: 'POST' });
  const contentType = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (!TYPES.includes(contentType)) return respond(415);
  const body = await readLimitedText(request);
  if (body === null) return respond(413);
  let payload;
  try { payload = JSON.parse(body); } catch { return respond(400); }
  // Rate limit only well-formed reports, so junk never spends the sender's allowance check.
  const limiter = env.CSP_REPORT_LIMITER;
  if (limiter?.limit) {
    const key = request.headers.get('CF-Connecting-IP') || 'unknown';
    const { success } = await limiter.limit({ key: `csp:${key}` }).catch(() => ({ success: false }));
    if (!success) return respond(204);
  }
  const origin = new URL(request.url).origin;
  const seen = new Set();
  for (const raw of extractReports(contentType, payload).slice(0, MAX_REPORTS)) {
    const summary = summarizeReport(raw, origin);
    if (!summary) continue;
    // Strip undefined fields so each log line stays compact and indexable.
    const line = Object.fromEntries(Object.entries(summary).filter(([, value]) => value !== undefined));
    const key = JSON.stringify(line);
    if (seen.has(key)) continue;
    seen.add(key);
    log(line);
  }
  return respond(204);
}
