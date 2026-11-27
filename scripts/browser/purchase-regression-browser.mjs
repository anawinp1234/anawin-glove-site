import { FULL_SIZE_SERVICE_VARIANT } from '../../test-support/commerce-profiles.js';
// Purchase regression suite: viewports, Break-In pairing, discounts, checkout handoff, cart
// concurrency/failures and drawer accessibility, against the loopback mock storefront in
// purchase-regression-server.mjs, which this suite starts.
//
// Run it through run-isolated.mjs (npm run test:browser:purchase). It refuses to start unless it is
// inside a verified closed network namespace (isolation.mjs): only loopback exists, so nothing can
// reach Shopify, checkout, payment, newsletter, analytics or any other external host, whatever the
// page or a child process does. CDP interception is a second layer that routes and records requests:
// mock-storefront requests are checked by method and route, checkout-host navigations are answered
// locally and counted as handoffs, and anything else is failed and reported.
//
// Checks are labelled `baseline` (current safeguards that must keep holding), `risk:<n>` (the Phase 6
// known risks), `finding` (a defect found outside the known risks) or `harness` (the suite could not
// establish what a check needs). Failing checks are reported, never skipped.
// Exit status: 0 all checks passed, 1 application checks failed, 2 harness or infrastructure fault,
// 3 isolation unavailable.
// Evidence: results.json and screenshots in a per-run folder under ANAWIN_PURCHASE_EVIDENCE_DIR.
// Optional: ANAWIN_PURCHASE_ONLY=<scenario name substring> runs a subset (no match is an error).
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { release as osRelease, tmpdir } from 'node:os';
import { join } from 'node:path';
import { FULL_SIZE_CONFIGURATION_KEY, fullSizeBreakInService, fullSizeConfiguration, fullSizeProducts, localProducts, optionsFromAttributes, serviceAttributes } from '../../src/catalog.js';
import { codeKey } from '../../src/cart-discounts.js';
import { netnsOf, requireIsolation } from './isolation.mjs';
import { createStorefrontMock } from './purchase-regression-fixture.mjs';

const isolation = await requireIsolation('purchase-regression-browser');
const RUN_ID = randomUUID();
const TOKEN = randomBytes(32).toString('hex');
const CHECKOUT_HOST = 'ignvv0-zh.myshopify.com';
const startedAt = new Date().toISOString();
const dir = join(process.env.ANAWIN_PURCHASE_EVIDENCE_DIR || join(tmpdir(), 'anawin-purchase-regression-evidence'), `run-${startedAt.replace(/[:.]/g, '-')}`);
await mkdir(dir, { recursive: true });
const only = process.env.ANAWIN_PURCHASE_ONLY || '';
// The caller selects the application contract. Baseline adapters must opt in explicitly.
const contractArg = process.argv.slice(2);
const applicationContract = contractArg[0] || 'combined';
if (contractArg.length > 1 || !['baseline', 'combined'].includes(applicationContract)) throw new Error('Invalid purchase test application contract');
const VIEWPORTS = [[320, 568], [320, 640], [390, 844], [768, 1024], [1440, 900]];
// Long, realistic shopper text: a pasted link (one long unbroken token) and several sentences.
const LONG_NOTE = 'Please keep the heel firm but soften the thumb hinge noticeably; I catch mostly in the web. ' +
  'Reference photo: https://example.test/gloves/shaping/reference-pocket-shape-for-middle-infield-play-2026 ' +
  'Thanks — this is a synthetic note for regression testing only. '.repeat(3);
// The header renders more than one cart button; use the one that is laid out.
const VISIBLE_CART_BUTTON = `[...document.querySelectorAll('[data-cart]')].find(button => button.getClientRects().length)`;
// A visible alert or cart error, as a shopper (or a screen reader) would get it.
const VISIBLE_ALERTS = `[...document.querySelectorAll('.cart-error, [role="alert"]')].filter(e => e.getClientRects().length && !e.closest('.visually-hidden, [hidden]') && e.textContent.trim()).map(e => e.textContent.trim())`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const withDeadline = (promise, ms, what) => { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`deadline: ${what} took longer than ${ms} ms`)), ms); })]).finally(() => clearTimeout(timer)); };
const poll = async (test, timeoutMs, interval = 40) => { const end = Date.now() + timeoutMs; do { if (await test()) return true; await sleep(interval); } while (Date.now() < end); return false; };
const sanitize = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value, (_key, item) =>
  typeof item === 'string' ? item.replace(/key=[^&\s"]+/g, 'key=<synthetic>').slice(0, 800) : item));

const checks = [];
const diagnostics = [];
const external = [];
const violations = [];
const exceptions = [];
const handoffs = [];
const interceptErrors = [];
const browserRequests = [];
let requestTags = 0;
const infrastructure = [];
// Faults deliberately injected by the fault-preservation self-test, identified by a per-run marker.
const expectedFaults = new Set();
// The mock's cumulative fault log, which no reset clears; refreshed after every scenario and at the end.
let serverFaults = [];
const recordedFaults = () => serverFaults;
const isExpectedFault = item => [...expectedFaults].some(marker => JSON.stringify(item).includes(marker));
let scenario = '';
let viewport = null;
// Set for a harness self-test scenario: every check in it is about the harness, not the application.
let selfTest = false;
let scenarioInit = '';
function check(label, name, pass, detail = undefined) {
  if (selfTest && label !== 'harness') { name = `self-test expects: ${name}`; label = 'harness'; }
  const entry = { scenario, viewport, label, name, outcome: pass ? 'pass' : 'fail', ...(detail === undefined ? {} : { detail: sanitize(detail) }) };
  checks.push(entry);
  if (!pass) console.log(`  FAIL [${label}] ${name}${detail === undefined ? '' : ` — ${JSON.stringify(entry.detail).slice(0, 400)}`}`);
  return pass;
}
// Recorded evidence that is not itself a pass/fail gate (for example, how a race actually interleaved).
const observe = (name, data) => diagnostics.push({ scenario, viewport, name, data: sanitize(data) });

// ---- Owned child processes ----
const children = [];
function own(name, command, args, options) {
  const child = spawn(command, args, options);
  const entry = { name, child, exited: false, exitCode: null, error: null };
  // 'close' fires once the process has exited and its output streams are drained.
  entry.closed = new Promise(resolve => {
    child.on('close', code => { entry.exited = true; entry.exitCode = code; resolve(); });
    child.on('error', error => { entry.exited = true; entry.error = error.message; resolve(); });
  });
  child.on('exit', code => { entry.exited = true; entry.exitCode = code; });
  children.push(entry);
  return entry;
}
// Stops every owned process and waits until each has exited and its streams are drained. A process
// that survives SIGKILL is a hard infrastructure fault.
async function stopChildren() {
  for (const entry of [...children].reverse()) {
    if (!entry.exited) {
      entry.child.kill('SIGTERM');
      if (!await poll(() => entry.exited, 3000, 50)) { entry.child.kill('SIGKILL'); await poll(() => entry.exited, 3000, 50); }
    }
    const drained = await Promise.race([entry.closed.then(() => true), sleep(3000).then(() => false)]);
    if (!entry.exited || !drained) infrastructure.push({ fault: `${entry.name} (pid ${entry.child.pid}) did not exit and drain during teardown` });
  }
}

// Mock server: started here, on a random port, and trusted only after a token-and-PID handshake.
let BASE = null;
let serverEntry = null;
async function startServer() {
  serverEntry = own('server', process.execPath, [new URL('./purchase-regression-server.mjs', import.meta.url).pathname],
    { env: { ...process.env, ANAWIN_HARNESS_TOKEN: TOKEN }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  serverEntry.child.stderr.on('data', chunk => { err = (err + chunk).slice(-4000); });
  const ready = await new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), 45000);
    serverEntry.child.stdout.on('data', chunk => {
      out += chunk;
      for (const line of out.split('\n')) {
        try { const message = JSON.parse(line); if (message.ready === 'anawin-purchase-regression') { clearTimeout(timer); resolve(message); } } catch {}
      }
    });
    serverEntry.closed.then(() => { clearTimeout(timer); resolve(null); });
  });
  if (!ready) throw new Error(`mock server did not report ready${serverEntry.error ? ` (spawn error: ${serverEntry.error})` : ''}: ${err.trim().slice(-600) || 'no output'}`);
  // Keep draining its output so a chatty server can never block on a full pipe.
  serverEntry.child.stdout.on('data', () => {});
  if (ready.pid !== serverEntry.child.pid) throw new Error(`mock server PID ${ready.pid} is not the spawned child ${serverEntry.child.pid}`);
  if (ready.token !== createHash('sha256').update(TOKEN).digest('hex')) throw new Error('mock server reported a different run token');
  BASE = `http://127.0.0.1:${ready.port}`;
  const challenge = randomBytes(16).toString('hex');
  const hello = await control('hello', { challenge });
  if (hello.mock !== 'anawin-purchase-regression' || hello.pid !== serverEntry.child.pid || hello.challenge !== challenge || hello.port !== ready.port) {
    throw new Error(`mock server handshake mismatch: ${JSON.stringify(hello)}`);
  }
}
// A scenario that outlived its deadline keeps running in the background; it must not drive the mock
// or open tabs for the scenario after it. Its calls carry its generation and are refused once stale.
const scenarioScope = new AsyncLocalStorage();
let generation = 0;
function assertCurrent(what) {
  const caller = scenarioScope.getStore();
  if (caller && caller.generation !== generation) throw new Error(`${what}: refused for scenario "${caller.scenario}", which already ended`);
}
async function control(action, args = {}, timeoutMs = 15000) {
  assertCurrent(`control ${action}`);
  if (!BASE) throw new Error(`control ${action}: mock server is not running`);
  const response = await fetch(`${BASE}/__control`, { method: 'POST', headers: { 'x-harness-token': TOKEN },
    body: JSON.stringify({ action, ...args }), signal: AbortSignal.timeout(timeoutMs) });
  const body = await response.json();
  if (!response.ok) throw new Error(`control ${action}: ${body.error}`);
  // Every reset, including the ones scenarios make mid-way, hands back what the replaced mock recorded.
  if (action === 'reset') {
    if (!body.drained) infrastructure.push({ scenario: body.previous, fault: 'requests were still in flight past the reset deadline', leftover: body });
    if (body.unmatched?.length || body.violations?.length) infrastructure.push({ scenario: body.previous, fault: 'unmatched requests or violations discarded by a reset', unmatched: body.unmatched, violations: body.violations });
  }
  return body;
}

// Chrome: a fresh temporary profile, a random debugging port, and the endpoint confirmed through the
// profile's own DevToolsActivePort file, so the suite can only attach to the browser it started.
let profile = null;
let chromeEntry = null;
let browserVersion = null;
async function startChrome() {
  const chromePath = process.env.ANAWIN_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (/\.exe$/i.test(chromePath) || chromePath.startsWith('/mnt/')) throw new Error(`ANAWIN_CHROME must be a Linux Chrome inside the sandbox, not ${chromePath}`);
  if (!existsSync(chromePath)) throw new Error(`Chrome not found at ${chromePath}; set ANAWIN_CHROME`);
  profile = await mkdtemp(join(tmpdir(), 'anawin-purchase-chrome-'));
  chromeEntry = own('chrome', chromePath, ['--headless=new', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-domain-reliability',
    '--disable-sync', '--disable-default-apps', '--no-proxy-server', 'about:blank'], { stdio: 'ignore' });
  const portFile = join(profile, 'DevToolsActivePort');
  if (!await poll(() => chromeEntry.exited || existsSync(portFile) && readFileSync(portFile, 'utf8').trim().split('\n').length >= 2, 20000, 100) || chromeEntry.exited) {
    throw new Error(`Chrome did not open its debugging port (exited: ${chromeEntry.exited}, code ${chromeEntry.exitCode}${chromeEntry.error ? `, spawn error: ${chromeEntry.error}` : ''})`);
  }
  const [port, path] = readFileSync(portFile, 'utf8').trim().split('\n');
  const version = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(5000) }).then(r => r.json());
  if (version.webSocketDebuggerUrl !== `ws://127.0.0.1:${port}${path}`) throw new Error(`debugger endpoint ${version.webSocketDebuggerUrl} is not this run's Chrome (${path})`);
  if (netnsOf(chromeEntry.child.pid) !== netnsOf('self')) throw new Error('Chrome is not in this run\'s network namespace');
  browserVersion = version.Browser;
  return version.webSocketDebuggerUrl;
}

// ---- CDP over one browser connection; each tab is a flattened session. ----
let socket;
let seq = 0;
const pending = new Map();
const sessions = new Map();
const send = (method, params = {}, sessionId, timeoutMs = 15000) => new Promise((resolve, reject) => {
  if (!socket || socket.readyState !== WebSocket.OPEN) { reject(new Error(`${method}: CDP socket is closed`)); return; }
  const id = ++seq;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method}: no CDP reply within ${timeoutMs} ms`)); }, timeoutMs);
  pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); }, method });
  socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});

// Whether a real press was delivered, from what the window-capture listeners saw. The listeners must
// have been confirmed installed before dispatch. An enabled control must be seen receiving both
// pointerdown and click; anything reaching another control is a failure. A control disabled at aim or
// by pointerdown time may be pressed only explicitly (allowDisabled), and then nothing may activate it.
function tapDelivery({ disabledAtAim, allowDisabled, installed, pointerdown, click }) {
  if (!installed) return { ok: false, error: 'the delivery listeners were not confirmed installed before dispatch, so delivery is not proven' };
  if (pointerdown && !pointerdown.onTarget) return { ok: false, error: `pointerdown reached another control (${pointerdown.html}); the press was blocked there` };
  if (click && !click.onTarget) return { ok: false, error: `click reached another control (${click.html}); it was blocked there` };
  const disabled = disabledAtAim || !!pointerdown?.disabled;
  if (disabled && click) return { ok: false, error: 'a disabled control was activated by the press' };
  if (disabled && allowDisabled) return { ok: true, delivered: false, disabled: true };
  if (disabled) return { ok: false, error: 'the control was disabled; a disabled control may only be pressed explicitly' };
  if (!pointerdown) return { ok: false, error: `no pointerdown was observed on the enabled control${click ? ' (only a click arrived)' : ''}, so delivery is not proven` };
  if (!click) return { ok: false, error: 'pointerdown reached the control but no click activated it' };
  return { ok: true, delivered: true, disabled: false };
}

class Tab {
  constructor(sessionId, targetId, name) { Object.assign(this, { sessionId, targetId, name, checkoutResponse: 'page', closed: false }); }
  call(method, params, timeoutMs) {
    if (this.closed) return Promise.reject(new Error(`${this.name}: tab belongs to a finished scenario`));
    return send(method, params, this.sessionId, timeoutMs);
  }
  async eval(expression) {
    const result = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(`${this.name}: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}\n${expression.slice(0, 200)}`);
    return result.result.value;
  }
  // Waits on page state, bounded.
  async until(expression, timeout = 8000) {
    if (await poll(() => this.eval(expression), timeout)) return true;
    throw new Error(`${this.name}: timed out waiting for ${expression.slice(0, 300)}`);
  }
  async visit(path, ready = `document.querySelector('[data-add]') && !document.querySelector('[data-add]').disabled`) {
    await this.eval('window.__leaving = true');
    await this.call('Page.navigate', { url: BASE + path });
    await this.until(`!window.__leaving && document.readyState === 'complete' && (${ready})`, 15000);
  }
  async reload(ready = `document.querySelector('[data-add]') && !document.querySelector('[data-add]').disabled`) {
    await this.eval('window.__leaving = true');
    await this.call('Page.reload');
    await this.until(`!window.__leaving && document.readyState === 'complete' && (${ready})`, 15000);
  }
  viewport(width, height) { return this.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 1000 }); }
  async key(key, modifiers = 0) {
    const code = { Enter: 13, Tab: 9, Escape: 27, ' ': 32 }[key];
    await this.call('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key === ' ' ? 'Space' : key, windowsVirtualKeyCode: code, modifiers, ...(key === 'Enter' ? { text: '\r' } : {}) });
    await this.call('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key === ' ' ? 'Space' : key, windowsVirtualKeyCode: code, modifiers });
  }
  // Programmatic click, for setup steps only (radio choices, toggles). Critical controls use tap().
  click(selector) { return this.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) throw new Error('missing ${selector.replaceAll("'", '')}'); e.click(); })()`); }
  // Real pointer input at the control's centre. Aiming and the delivery listeners are installed in one
  // evaluation, re-measured until the control is the topmost element there (another tab's change can
  // re-render this one). The listeners sit on window in the capture phase, so they see the press before
  // any page handler, record whether pointerdown and click reached the control (re-rendered or not,
  // and whether it was disabled at pointerdown), and block a press that reached anything else before it
  // can act. Installation is confirmed by a per-tap token just before dispatch and again in what the
  // listeners report. A press is never retried after it was dispatched. Delivery is then judged by
  // tapDelivery; anything unproven throws.
  async tap(selector, count = 1, { allowDisabled = false } = {}) {
    const target = JSON.stringify(selector);
    let result = null;
    for (let i = 0; i < count; i++) {
      let point = null, armed = null;
      const token = randomBytes(8).toString('hex');
      const aimed = await poll(async () => {
        armed = null;
        point = await this.eval(`(() => { const e = document.querySelector(${target}); if (!e) return null; e.scrollIntoView({ block: 'center', behavior: 'instant' });
          const r = e.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, hit = document.elementFromPoint(x, y);
          const onTarget = !!hit && (hit === e || e.contains(hit));
          if (onTarget) {
            if (window.__tapWatch) for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) window.removeEventListener(type, window.__tapWatch, true);
            const state = window.__tap = { token: ${JSON.stringify(token)}, pointerdown: null, click: null, blocked: false };
            window.__tapWatch = event => {
              const now = document.querySelector(${target}), within = el => !!el && (event.target === el || el.contains(event.target));
              const record = { onTarget: within(e) || within(now), rerendered: !e.isConnected, disabled: !!(e.isConnected ? e : now || e).disabled,
                html: (event.target.outerHTML || event.target.nodeName || '').slice(0, 100) };
              if (event.type === 'pointerdown') { state.pointerdown ||= record; if (!record.onTarget) state.blocked = true; }
              if (event.type === 'click') state.click ||= record;
              if (state.blocked || !record.onTarget) { event.preventDefault(); event.stopImmediatePropagation(); }
            };
            for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) window.addEventListener(type, window.__tapWatch, true);
          }
          return { x, y, disabled: !!e.disabled, onTarget }; })()`);
        if (!point || !point.onTarget) return !point;
        // Just before dispatch: the listeners are this tap's and untouched, and the point still hits the
        // control (a re-render may have moved it). Nothing has been pressed yet, so re-aiming is safe.
        armed = await this.eval(`(() => { const e = document.querySelector(${target}), hit = document.elementFromPoint(${point.x}, ${point.y});
          return { installed: window.__tap?.token === ${JSON.stringify(token)} && typeof window.__tapWatch === 'function' && !window.__tap.pointerdown && !window.__tap.click,
            onTarget: !!e && !!hit && (hit === e || e.contains(hit)), disabled: !!e?.disabled }; })()`);
        if (armed.onTarget) point.disabled = armed.disabled;
        return !armed.installed || armed.onTarget;
      }, 2000);
      if (!point) throw new Error(`${this.name}: nothing to tap at ${selector}`);
      if (!aimed) throw new Error(`${this.name}: ${selector} is covered at its centre; refusing to tap whatever is on top`);
      // Nothing has been dispatched yet, so a missing listener here is a harness error, not a lost press.
      if (!armed?.installed) throw new Error(`${this.name}: the delivery listeners for ${selector} were not in place before dispatch; nothing was pressed`);
      await this.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      await this.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      const seen = await this.eval(`(() => { for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) window.removeEventListener(type, window.__tapWatch, true);
        const seen = window.__tap; window.__tap = null; window.__tapWatch = null; return seen; })()`);
      const installed = armed.installed && seen?.token === token;
      const delivery = tapDelivery({ disabledAtAim: point.disabled, allowDisabled, installed, pointerdown: seen?.pointerdown || null, click: seen?.click || null });
      if (!delivery.ok) throw new Error(`${this.name}: a tap aimed at ${selector}: ${delivery.error}`);
      result = this.lastTap = { selector, disabled: delivery.disabled, delivered: delivery.delivered, installedBeforeDispatch: installed,
        rerendered: !!(seen?.click?.rerendered || seen?.pointerdown?.rerendered) };
    }
    return result;
  }
  // A real pointer press at a point, observed and then cancelled before any handler runs, so hit
  // targets are verified with real input without changing the cart.
  async probeTap(selector, index, x, y) {
    await this.eval(`window.__probe = null; window.__probeHandler = event => { window.__probe = window.__probe || { target: event.target };
      event.preventDefault(); event.stopImmediatePropagation(); };
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) document.addEventListener(type, window.__probeHandler, true);`);
    try {
      await this.call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await this.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      return await this.eval(`(() => { const e = document.querySelectorAll(${JSON.stringify(selector)})[${index}]; const t = window.__probe?.target; return !!t && !!e && (t === e || e.contains(t)); })()`);
    } finally {
      await this.eval(`for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) document.removeEventListener(type, window.__probeHandler, true);`).catch(() => {});
    }
  }
  async openCart() {
    await this.eval(`${VISIBLE_CART_BUTTON}.click()`);
    await this.settled();
  }
  // The drawer is open, finished sliding in, and no cart request is in flight.
  settled(timeout = 8000) {
    return this.until(`(() => { const d = document.querySelector('.cart-drawer'); return d && !d.hasAttribute('inert') && document.body.classList.contains('cart-open') &&
      getComputedStyle(d).transform === 'none' && !document.querySelector('.cart-body[aria-busy]') && !document.querySelector('[data-checkout][aria-busy]') && !document.documentElement.dataset.harnessQueued; })()`, timeout);
  }
  busy() { return this.eval(`!!document.querySelector('.cart-body[aria-busy="true"], [data-checkout][aria-busy], [data-add][aria-busy="true"], html[data-harness-queued]')`); }
  async closeCart() {
    await this.key('Escape');
    await this.until(`!document.body.classList.contains('cart-open') && !document.querySelector('.cart-drawer')`);
  }
  async shot(name) {
    const { data } = await this.call('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(dir, `${name}.png`), Buffer.from(data, 'base64'));
  }
  text(selector) { return this.eval(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`); }
  alerts() { return this.eval(VISIBLE_ALERTS); }
  enabled(selector) { return this.eval(`!!document.querySelector(${JSON.stringify(selector.split(',').map(part => `${part.trim()}:not([disabled])`).join(', '))})`); }
}

let context = null;
const tabs = [];
async function openTab(name, { reducedMotion = true, init = '' } = {}) {
  assertCurrent(`open tab ${name}`);
  // Each tab gets its own window so none is a hidden background tab (those skip requestAnimationFrame).
  const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId: context, newWindow: true });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const tab = new Tab(sessionId, targetId, name);
  sessions.set(sessionId, tab);
  tabs.push(tab);
  await tab.call('Page.enable');
  await tab.call('Runtime.enable');
  await tab.call('Emulation.setFocusEmulationEnabled', { enabled: true });
  await tab.call('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  await tab.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reducedMotion ? 'reduce' : 'no-preference' }] });
  // Keeps the newsletter popup out of the way; it is covered by its own tests.
  await tab.call('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem('anawin-newsletter-popup', '{"subscribed":true}'); } catch {}\n${scenarioInit}\n${init}` });
  await tab.viewport(390, 844);
  return tab;
}
// Closes every tab of the finished scenario (aborting its requests) before the mock is reset.
async function closeContext() {
  for (const tab of tabs.splice(0)) { tab.closed = true; await send('Target.closeTarget', { targetId: tab.targetId }).catch(() => {}); sessions.delete(tab.sessionId); }
  if (context) await send('Target.disposeBrowserContext', { browserContextId: context }).catch(error => interceptErrors.push({ scenario, error: `dispose: ${error.message}` }));
  context = null;
}
async function newContext() { ({ browserContextId: context } = await send('Target.createBrowserContext', { disposeOnDetach: true })); }

// The submitted lines of one browser request, as the correlator compares them: line ID, merchandise,
// quantity and, for a nested AddLines line, its parent by line ID or by merchandise (1L).
const requestLinesOf = variables => (variables?.lines || []).map(line => ({ id: line.id, merchandiseId: line.merchandiseId, quantity: line.quantity,
  parent: line.parent ? { lineId: line.parent.lineId, merchandiseId: line.parent.merchandiseId } : undefined }));
// One submitted line's identity, for comparing a browser request with the mock's log entry.
const lineIdentity = line => [line.id ?? null, line.merchandiseId ?? null, line.quantity ?? null, line.parent?.lineId ?? null, line.parent?.merchandiseId ?? null];
// Second layer behind the namespace: route, check and record every browser request.
function onPaused(tab, { requestId, request, resourceType }) {
  const fail = reason => tab.call('Fetch.failRequest', { requestId, errorReason: reason });
  let url;
  try { url = new URL(request.url); } catch { external.push({ scenario, tab: tab.name, url: request.url.slice(0, 200), resourceType }); return fail('BlockedByClient'); }
  if (url.origin === BASE) {
    const route = url.pathname;
    const allowed = route === '/__fixture' ? request.method === 'POST' : !route.startsWith('/__') && ['GET', 'HEAD'].includes(request.method);
    if (!allowed) { violations.push({ scenario, tab: tab.name, method: request.method, route, reason: 'browser request outside the mock storefront routes' }); return fail('BlockedByClient'); }
    if (route === '/__fixture') {
      let operation = 'unknown', lines = [], createInput = null, lineIds = [], discountCodes = [], cartId = null, mutation = false;
      try {
        const body = JSON.parse(request.postData || '{}');
        operation = /^\s*(?:query|mutation)\s+(\w+)/.exec(body.query || '')?.[1] || 'unknown';
        lines = requestLinesOf(body.variables);
        if (operation === 'CreateCart' && applicationContract === 'baseline') createInput = body.variables?.input;
        lineIds = Array.isArray(body.variables?.lineIds) ? body.variables.lineIds : [];
        cartId = body.variables?.cartId ?? null;
        mutation = /^\s*mutation\b/.test(body.query || '');
        discountCodes = body.variables?.discountCodes || [];
      } catch {}
      // The tag travels with the request to the mock, so each write is tied to its tab through to commit.
      const tag = `${tab.name}-${++requestTags}`;
      browserRequests.push({ scenario, tab: tab.name, operation, cartId, lines, createInput, lineIds, discountCodes, mutation, tag, at: Date.now() });
      return tab.call('Fetch.continueRequest', { requestId, headers: [...Object.entries(request.headers || {}).map(([name, value]) => ({ name, value })), { name: 'X-Anawin-Request', value: tag }] });
    }
    return tab.call('Fetch.continueRequest', { requestId });
  }
  if (url.protocol === 'https:' && url.host === CHECKOUT_HOST && !url.username && !url.password) {
    // The stand-in checkout page's own favicon request: answered locally, not a handoff.
    if (request.method === 'GET' && url.pathname === '/favicon.ico' && resourceType !== 'Document') return tab.call('Fetch.fulfillRequest', { requestId, responseCode: 404, responseHeaders: [] });
    // Never forwarded. A page stands in for Shopify checkout; 'drop' models a navigation that never commits.
    if (request.method !== 'GET' || resourceType !== 'Document') { violations.push({ scenario, tab: tab.name, method: request.method, resourceType, reason: 'non-navigation request to the checkout host' }); return fail('BlockedByClient'); }
    handoffs.push({ scenario, tab: tab.name, url: request.url, resourceType, at: Date.now() });
    if (tab.checkoutResponse === 'drop') return tab.call('Fetch.fulfillRequest', { requestId, responseCode: 204, responseHeaders: [] });
    return tab.call('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html' }],
      body: Buffer.from('<!doctype html><title>Mock checkout</title><main>Mock checkout — no order is placed.</main>').toString('base64') });
  }
  external.push({ scenario, tab: tab.name, url: request.url.slice(0, 200), method: request.method, resourceType });
  return fail('BlockedByClient');
}

// ---- Mock state helpers ----
const serverCart = async id => (await control('cart', { id })).cart;
const cartStorage = tab => tab.eval(`Object.fromEntries(Object.keys(localStorage).filter(key => key.startsWith('anawin-shopify-')).sort().map(key => [key, localStorage.getItem(key)]))`);
const cartProbe = async tab => ({
  storage: await cartStorage(tab),
  journal: Object.entries(await cartStorage(tab)).filter(([key]) => key.startsWith('anawin-shopify-unsafe-op:')).map(([key, raw]) => ({ key, ...JSON.parse(raw) })),
  refresh: await tab.enabled('[data-refresh-cart]'),
  apply: await tab.enabled('[data-discount-apply]'),
  removeDiscount: await tab.enabled('[data-remove-discount]'),
  count: await tab.text('.cart-count'),
  rows: await tab.eval(`[...document.querySelectorAll('.cart-item')].map(row => row.innerText)`),
  checkout: await tab.enabled('[data-checkout]'),
  alerts: await tab.alerts(),
  recovery: await tab.enabled('[data-refresh-cart], [data-recover-cart], [data-abandon-cart]'),
  text: await tab.text('.cart-drawer')
});
const storedCartId = tab => tab.eval(`localStorage.getItem('anawin-shopify-cart-id')`);
const cartLines = async (tab = tabs[0]) => (await serverCart(await storedCartId(tab)))?.lines || [];
const requestLog = async () => (await control('log')).log;
const mutations = async (operation = null) => (await requestLog()).filter(entry => entry.mutation && (!operation || entry.operation === operation));
const attr = (line, key) => line?.attributes.find(item => item.key === key)?.value;
const sortAttributes = attributes => [...(attributes || [])].sort((a, b) => a.key.localeCompare(b.key));
const parents = lines => lines.filter(line => !line.parentId);
const childOf = (lines, parent) => lines.filter(line => line.parentId === parent.id);
const TRAINER_SERVICE_VARIANT = 'gid://variant/service';
const TRAINERS = ['br16', 'ob16', 'cl16'];
const SERVICE_CHOICE_KEYS = ['_anawin_break_in_level', '_anawin_wearing_style', '_anawin_service_type', FULL_SIZE_CONFIGURATION_KEY];
// Every Break-In invariant, as a list of issues (empty means sound): unique line IDs; each service
// under an existing, marked glove; the service variant that belongs to that glove type; equal
// quantities; trainer choices identical on glove and service; full-size service naming the model and
// the variant's throw hand, with the glove's configuration digest matching the service's choices;
// one service at most per glove; no service under an unmarked glove; no leftover choices on one.
function pairingIssues(lines) {
  const issues = [];
  const ids = lines.map(line => line.id);
  if (new Set(ids).size !== ids.length) issues.push({ duplicateLineIds: ids });
  for (const service of lines.filter(line => line.parentId)) {
    const parent = lines.find(line => line.id === service.parentId);
    if (!parent) { issues.push({ orphanService: service.id, parentId: service.parentId }); continue; }
    if (parent.parentId) issues.push({ serviceUnderService: service.id });
    const trainer = TRAINERS.includes(parent.handle);
    const expected = trainer ? TRAINER_SERVICE_VARIANT : FULL_SIZE_SERVICE_VARIANT;
    if (service.merchandiseId !== expected) issues.push({ wrongServiceMerchandise: service.id, expected, actual: service.merchandiseId });
    if (parent.quantity !== service.quantity) issues.push({ parity: parent.id, glove: parent.quantity, service: service.quantity });
    if (attr(parent, '_anawin_service') !== 'break-in') issues.push({ parentNotMarked: parent.id });
    if (trainer) {
      const level = attr(service, 'Break-In Level'), style = attr(service, 'Glove Wearing Style');
      if (!level || !style || attr(parent, '_anawin_break_in_level') !== level || attr(parent, '_anawin_wearing_style') !== style) {
        issues.push({ trainerChoicesMismatch: parent.id, glove: [attr(parent, '_anawin_break_in_level'), attr(parent, '_anawin_wearing_style')], service: [level, style] });
      }
    } else {
      const hand = parent.merchandiseId.endsWith('-left') ? 'Left' : 'Right';
      if (attr(service, 'Glove Model') !== parent.handle.toUpperCase() || attr(service, 'Throwing Hand') !== hand) {
        issues.push({ fulfillmentMismatch: service.id, model: attr(service, 'Glove Model'), hand: attr(service, 'Throwing Hand'), expected: [parent.handle.toUpperCase(), hand] });
      }
      let digest = null;
      try { digest = fullSizeConfiguration(optionsFromAttributes(service.attributes, 'full-size')); }
      catch (error) { issues.push({ fullSizeChoicesIncomplete: service.id, error: error.message }); }
      if (attr(parent, '_anawin_service_type') !== 'full-size' || digest && attr(parent, FULL_SIZE_CONFIGURATION_KEY) !== digest) {
        issues.push({ fullSizeConfigurationMismatch: parent.id, glove: attr(parent, FULL_SIZE_CONFIGURATION_KEY), service: digest });
      }
    }
  }
  for (const parent of parents(lines)) {
    // A Break-In service variant is never a glove, whatever its attributes say.
    if ([TRAINER_SERVICE_VARIANT, FULL_SIZE_SERVICE_VARIANT].includes(parent.merchandiseId) || ['break-in', 'full-size-glove-break-in-service'].includes(parent.handle)) {
      issues.push({ standaloneService: parent.id, merchandiseId: parent.merchandiseId }); continue;
    }
    const count = childOf(lines, parent).length;
    const marker = attr(parent, '_anawin_service');
    if (!marker) issues.push({ serviceMarkerMissing: parent.id });
    if (count > 1) issues.push({ multipleServices: parent.id });
    if (marker === 'break-in' && count !== 1) issues.push({ serviceMissing: parent.id });
    if (marker !== 'break-in' && count) issues.push({ unmarkedGloveHasService: parent.id });
    if (marker === 'none' && parent.attributes.some(item => SERVICE_CHOICE_KEYS.includes(item.key))) issues.push({ leftoverServiceChoices: parent.id });
  }
  return issues;
}
// Gloves with their services: identity (line IDs, merchandise) plus every attribute.
const gloves = lines => parents(lines).map(parent => ({ id: parent.id, handle: parent.handle, merchandiseId: parent.merchandiseId, quantity: parent.quantity,
  attributes: sortAttributes(parent.attributes), services: childOf(lines, parent).map(child => ({ id: child.id, handle: child.handle,
    merchandiseId: child.merchandiseId, quantity: child.quantity, attributes: sortAttributes(child.attributes) })) }));
// What the shopper bought, without line IDs: for comparing a cart with its recovery copy.
const configuration = lines => gloves(lines).map(({ merchandiseId, quantity, attributes, services }) => ({ merchandiseId, quantity, attributes,
  services: services.map(({ merchandiseId: service, quantity: count, attributes: choices }) => ({ merchandiseId: service, quantity: count, attributes: choices })) }))
  .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const without = (attributes, keys) => sortAttributes(attributes).filter(item => !keys.includes(item.key));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// A refusal counts only if it is visible, new since the action started (`before` holds the alerts
// shown just before it), names what was not done, says it was not done, and leaves a way to retry.
// Generic "your cart changed" copy names nothing, so it never counts.
// Each action has its own wording: an increase refusal must be about the quantity, and "BR16 was not
// removed" or "BR16 wasn't added" never stands in for one.
const ACTIONS = { add: { verbs: 'added' }, increase: { verbs: 'updated|increased|changed|saved', subject: /\b(quantity|increase)\b/i },
  apply: { verbs: 'applied' }, remove: { verbs: 'removed' } };
const notDone = verbs => new RegExp(`(wasn['’]t|was not|isn['’]t|is not|couldn['’]t|could not|not)\\b[^.]*\\b(${verbs})\\b`, 'i');
function classifyRefusal({ item, action, before, after, actionable }) {
  const rule = ACTIONS[action];
  if (!rule) throw new Error(`classifyRefusal: unknown action ${action}`);
  const fresh = after.filter(text => !before.includes(text));
  const specific = fresh.filter(text => text.toUpperCase().includes(item.toUpperCase()) && notDone(rule.verbs).test(text) && (!rule.subject || rule.subject.test(text)));
  return { refused: specific.length > 0 && actionable, specific, fresh, actionable, action };
}
// A press that found its control disabled is recorded as not offered. That is a separate state from a
// refusal: no refusal message is inferred from it (`refused` stays what classifyRefusal found). The
// gates decline both states (the action must not have been done) and check that nothing was committed.
const notOfferedOr = (notOffered, refusal) => notOffered ? { ...refusal, notOffered: true } : refusal;
const declined = refusal => !!(refusal.refused || refusal.notOffered);
const refusalOf = async (tab, item, action, before, recovery) => ({ ...classifyRefusal({ item, action, before, after: await tab.alerts(), actionable: await tab.enabled(recovery) }), alerts: await tab.alerts() });

// ---- Acceptance gates ----
// Pure functions of what was observed, so the self-tests can feed them known-good and known-bad outcomes.
const verdict = (label, name, pass, detail) => ({ label, name, pass: Boolean(pass), detail });
const emit = verdicts => verdicts.forEach(item => check(item.label, item.name, item.pass, item.detail));
const sameConfiguration = (line, expected) => line.merchandiseId === expected.merchandiseId && same(sortAttributes(line.attributes), sortAttributes(expected.attributes));
// Each first-add intent: in the authoritative active cart exactly once with its exact configuration,
// or refused (specific, fresh, actionable) without having been committed anywhere. Merchandise in any
// other cart must be accounted for by the active cart; a refusal does not excuse it. Recovery must
// keep exactly what it copies.
function firstAddGate({ intents, activeCartId, carts, recovery = null }) {
  const out = [];
  const linesOf = id => carts.find(cart => cart.id === id)?.lines || [];
  // The race lands in the cart that was active before any recovery; that is what the intents are judged on.
  const raceCartId = recovery ? recovery.sourceId : activeCartId;
  const raceLines = linesOf(raceCartId);
  const satisfied = {};
  for (const intent of intents) {
    const found = parents(raceLines).filter(line => sameConfiguration(line, intent.expected));
    const quantity = found.reduce((sum, line) => sum + line.quantity, 0);
    satisfied[intent.name] = found.length === 1 && quantity === intent.expected.quantity && !childOf(raceLines, found[0]).length;
    out.push(verdict('risk:3', `${intent.name} is in the active cart exactly once with its exact configuration, or refused by name`,
      satisfied[intent.name] || declined(intent.refusal) && quantity === 0, { found, quantity, refusal: intent.refusal, submitted: intent.submitted }));
    if (intent.claimed) out.push(verdict('risk:3', `${intent.name}: success is claimed only for a glove the active cart holds`, satisfied[intent.name], { claimed: intent.claimed }));
    if (declined(intent.refusal)) out.push(verdict('risk:3', `${intent.name}: a refusal is not contradicted by the glove being in the active cart`, !found.length, { found }));
  }
  const unexpected = raceLines.filter(line => line.parentId || !intents.some(intent => sameConfiguration(line, intent.expected)));
  out.push(verdict('risk:3', 'the active cart holds only the submitted gloves', !unexpected.length, { unexpected }));
  // Recovery must move the shopper to exactly one new, distinct cart holding an exact copy of the race cart.
  if (recovery) {
    out.push(verdict('risk:3', 'recovery moved the shopper to exactly one new, distinct cart', activeCartId === recovery.cartId && recovery.cartId !== recovery.sourceId &&
      same(recovery.created, [recovery.cartId]), { activeCartId, ...recovery }));
    out.push(verdict('risk:3', 'recovery neither discards nor duplicates merchandise', same(configuration(linesOf(activeCartId)), configuration(raceLines)) &&
      same(recovery.before, configuration(raceLines)) && same(recovery.after, configuration(linesOf(activeCartId))), recovery));
  }
  // Every other cart must be empty. Merchandise committed anywhere else is an orphan, whatever any tab
  // said and however many copies; only a verified recovery's source cart is exempt.
  const exempt = new Set([activeCartId, raceCartId]);
  const stranded = carts.filter(cart => !exempt.has(cart.id)).flatMap(cart => cart.lines.map(line => ({ cart: cart.id, ...line })));
  out.push(verdict('risk:3', 'no other cart holds merchandise (orphan carts must be empty)', !stranded.length, { stranded }));
  return out;
}
// ---- Commit evidence (1M) ----
// A committed line mutation's evidence is the fixture's cart before and after it (`cartBefore`,
// `cartAfter`) and its recorded `effects`. The harness never trusts the effects on their own: it derives
// the expected change set from the two snapshots alone and requires the recorded effects to match it in
// both directions. Lines compare by ID, merchandise, parent, quantity and attributes.
const lineView = line => ({ id: line?.id, merchandiseId: line?.merchandiseId, parentId: line?.parentId ?? null, quantity: line?.quantity,
  attributes: Array.isArray(line?.attributes) ? [...line.attributes].map(({ key, value }) => ({ key, value })).sort((a, b) => a.key.localeCompare(b.key) || String(a.value).localeCompare(String(b.value))) : line?.attributes });
const viewOrRaw = value => value && typeof value === 'object' ? lineView(value) : value ?? null;
// A snapshot must be a list of well-formed lines with unique IDs, each child under a top-level line of the same snapshot.
function snapshotIssues(lines, name) {
  if (!Array.isArray(lines)) return [{ snapshot: name, issue: 'missing' }];
  const issues = [];
  for (const line of lines) {
    if (typeof line?.id !== 'string' || !line.id) issues.push({ snapshot: name, issue: 'a line without an ID', line });
    if (typeof line?.merchandiseId !== 'string' || !line.merchandiseId) issues.push({ snapshot: name, issue: 'a line without merchandise', line });
    if (!Number.isInteger(line?.quantity) || line.quantity < 1) issues.push({ snapshot: name, issue: 'a line without a positive quantity', line });
    if (!Array.isArray(line?.attributes)) issues.push({ snapshot: name, issue: 'a line without attributes', line });
    if (line?.parentId != null) {
      const parent = lines.find(item => item?.id === line.parentId);
      if (!parent) issues.push({ snapshot: name, issue: 'a child whose parent is not in the cart', line });
      else if (parent.parentId != null) issues.push({ snapshot: name, issue: 'a child under another child', line });
    }
  }
  const ids = lines.map(line => line?.id);
  if (new Set(ids).size !== ids.length) issues.push({ snapshot: name, issue: 'duplicate line IDs', ids });
  return issues;
}
// Every way one commit's effects can fail to account for its snapshots; empty means the evidence is sound.
function effectEvidenceIssues(entry) {
  const issues = [...snapshotIssues(entry.cartBefore, 'cartBefore'), ...snapshotIssues(entry.cartAfter, 'cartAfter')];
  if (!Array.isArray(entry.effects)) issues.push({ effects: 'missing' });
  if (issues.length) return issues;
  const before = new Map(entry.cartBefore.map(line => [line.id, lineView(line)]));
  const after = new Map(entry.cartAfter.map(line => [line.id, lineView(line)]));
  // A rekey is the one identity claim the snapshots cannot show by themselves. Each must take a line that
  // existed before and is gone after onto a new ID that did not exist before, keeping its merchandise.
  const renames = new Map();
  for (const effect of entry.effects.filter(item => item?.change === 'rekeyed')) {
    const valid = before.has(effect.previousId) && !after.has(effect.previousId) && after.has(effect.id) && !before.has(effect.id) &&
      !renames.has(effect.previousId) && ![...renames.values()].includes(effect.id);
    if (!valid) { issues.push({ mismatchedRekey: effect }); continue; }
    if (before.get(effect.previousId).merchandiseId !== after.get(effect.id).merchandiseId) { issues.push({ rekeyChangesMerchandise: effect }); continue; }
    renames.set(effect.previousId, effect.id);
  }
  const current = id => renames.get(id) ?? id;
  const expected = [];
  for (const old of before.values()) {
    const id = current(old.id), now = after.get(id);
    if (!now) { expected.push({ change: 'removed', id: old.id, previousId: old.id, before: old, after: null }); continue; }
    if (id !== old.id) expected.push({ change: 'rekeyed', id, previousId: old.id, before: old, after: now });
    else if (!same({ ...old, parentId: old.parentId == null ? null : current(old.parentId) }, now)) expected.push({ change: 'changed', id, previousId: old.id, before: old, after: now });
  }
  const targets = new Set(renames.values());
  for (const line of after.values()) if (!before.has(line.id) && !targets.has(line.id)) expected.push({ change: 'added', id: line.id, previousId: null, before: null, after: line });
  const keyOf = effect => `${effect.change}|${effect.previousId ?? ''}|${effect.id}`;
  const recorded = entry.effects.map(effect => ({ change: effect?.change, id: effect?.id, previousId: effect?.previousId ?? null, before: viewOrRaw(effect?.before), after: viewOrRaw(effect?.after) }));
  const keys = recorded.map(keyOf);
  if (new Set(keys).size !== keys.length) issues.push({ duplicateEffects: keys });
  for (const want of expected) {
    const got = recorded.find(item => keyOf(item) === keyOf(want));
    if (!got) issues.push({ missingEffect: want });
    else if (!same(got.before, want.before) || !same(got.after, want.after)) issues.push({ effectDisagreesWithSnapshots: { recorded: got, expected: want } });
  }
  for (const got of recorded) if (!expected.some(want => keyOf(want) === keyOf(got))) issues.push({ spuriousEffect: got });
  return issues;
}
const sameSnapshot = (a, b) => Array.isArray(a) && Array.isArray(b) && same([...a].map(lineView).sort((x, y) => String(x.id).localeCompare(String(y.id))), [...b].map(lineView).sort((x, y) => String(x.id).localeCompare(String(y.id))));

// Two +1 actions from quantity 1: the glove keeps its merchandise, choices and service identity, the
// service stays paired, the final quantity is 1 + the actions not refused by name, and every accepted
// action reached Shopify as a committed write from its own tab.
function plusOneGate({ name, initial, cartId, finalLines, actions, committedLog }) {
  const out = [];
  const finals = gloves(finalLines);
  const glove = finals[0];
  out.push(verdict('risk:3', `${name} keeps the same lines, merchandise, choices and service identity`, finals.length === 1 && glove.id === initial.id &&
    glove.merchandiseId === initial.merchandiseId && same(glove.attributes, initial.attributes) &&
    same(glove.services.map(item => [item.id, item.merchandiseId, item.attributes]), initial.services.map(item => [item.id, item.merchandiseId, item.attributes])),
    { initial, final: finals }));
  out.push(verdict('risk:3', `${name}'s service stays paired at the glove quantity`, !!glove && !pairingIssues(finalLines).length &&
    glove.services.length === initial.services.length && glove.services.every(item => item.quantity === glove.quantity), { issues: pairingIssues(finalLines), glove }));
  // Three states per tap: not offered (its control was disabled before activation), refused by a fresh
  // named message, or accepted. The first two are declined: neither may have committed anything.
  const accepted = actions.filter(action => !declined(action.refusal));
  out.push(verdict('risk:3', `final ${name} quantity is ${initial.quantity} plus every +1 not refused by name`, glove?.quantity === initial.quantity + accepted.length,
    { initial: initial.quantity, final: glove?.quantity, accepted: accepted.map(action => action.tab), refused: actions.filter(action => action.refusal.refused).map(action => action.tab),
      notOffered: actions.filter(action => action.refusal.notOffered).map(action => action.tab), actions }));
  // A write is this tap's glove action only if: it went to this cart; it came back 200, committed, with
  // no userErrors and a returned cart; it names this glove line exactly once, wherever it appears in
  // the batch; it touches nothing but that glove and its own service; any service entry asks for the
  // glove's quantity; and the returned cart shows every requested quantity. Service-only writes, other
  // carts or lines, duplicates and contradictions never count.
  const serviceIds = initial.services.map(item => item.id);
  const gloveAction = write => {
    if (write.cartId !== cartId || write.status !== 200 || write.outcome !== 'committed' || (write.userErrors || []).length || !write.resultLines) return null;
    const entries = write.lines.filter(line => line.id === initial.id);
    if (entries.length !== 1) return null;
    const requestedQuantity = entries[0].quantity;
    if (write.lines.some(line => line.id !== initial.id && !serviceIds.includes(line.id))) return null;
    if (write.lines.some(line => serviceIds.includes(line.id) && line.quantity !== requestedQuantity)) return null;
    const returned = id => write.resultLines.find(line => line.id === id)?.quantity;
    if (write.lines.some(line => returned(line.id) !== line.quantity)) return null;
    return requestedQuantity;
  };
  const requested = [];
  for (const action of accepted) {
    const own = action.writes.map(gloveAction).find(quantity => quantity != null);
    if (own != null) requested.push(own);
    out.push(verdict('risk:3', `tab ${action.tab}'s accepted +1 reached Shopify as a successful write to this cart's ${name} line`, own != null, { writes: action.writes }));
  }
  // Each accepted tap asked for its own next quantity; two taps asking for the same quantity is a lost update.
  out.push(verdict('risk:3', `accepted +1 taps requested distinct, consecutive quantities from ${initial.quantity + 1}`,
    same([...requested].sort((a, b) => a - b), accepted.map((_, index) => initial.quantity + 1 + index)), { requested }));
  // A declined tap (not offered, or refused by name) must not have committed any write to this glove or
  // its service, even one a later write overwrote. Committed includes a commit whose response failed.
  // What a commit touched is decided by the mock's own record of what it changed (1L), not by the
  // request's shape: a nested AddLines names its parent by line ID or by merchandise, and either form can
  // raise the service, so only the commit's evidence can tell. That evidence is checked before it is used
  // (1M): each commit's cartBefore must be the cart the previous commit left (the first one, the race's
  // starting glove and service), and its effects must match the change set derived from its own
  // snapshots (effectEvidenceIssues). Absent, incomplete, inconsistent or ambiguous evidence is a harness
  // error; such a commit still counts as touching the glove, through its request's shape only, and its
  // effects are never trusted. Identities are followed through verified re-keys in commit order.
  const LINE_MUTATIONS = ['UpdateLines', 'RemoveLines', 'AddLines'];
  const kindOf = item => item.operation ?? 'UpdateLines';
  const isCommit = entry => /^committed/.test(entry.outcome || '') || Number.isFinite(entry.commitSeq);
  const validSeq = entry => Number.isInteger(entry.commitSeq) && entry.commitSeq > 0;
  const requests = actions.flatMap(action => action.writes.map(write => ({ tab: action.tab, write })));
  const browserCommitted = write => write.cartId === cartId && isCommit(write) && LINE_MUTATIONS.includes(kindOf(write));
  // The mock's own line commits to this cart, collected independently of browser correlation (1J). Every
  // one needs a unique positive integer commitSeq, or the commit order (and so identity) is unknown.
  const lineCommits = Array.isArray(committedLog) ? committedLog.filter(entry => entry.cartId === cartId && isCommit(entry) && LINE_MUTATIONS.includes(kindOf(entry))) : null;
  const problems = [];
  if (!lineCommits) problems.push({ problem: 'the mock commit log was not supplied' });
  for (const entry of lineCommits || []) {
    if (!validSeq(entry)) problems.push({ problem: 'commitSeq is not a positive integer', entry });
    else if (lineCommits.filter(item => item.commitSeq === entry.commitSeq).length > 1) problems.push({ problem: 'commitSeq is not unique', entry });
  }
  const orderKnown = !!lineCommits && !problems.length;
  const inOrder = orderKnown ? [...lineCommits].sort((a, b) => a.commitSeq - b.commitSeq) : [...(lineCommits || [])];
  // Current line ID → role and → the ID it had when the race began; every ID the glove or service has had.
  const roleOf = new Map([[initial.id, 'glove'], ...serviceIds.map(id => [id, 'service'])]);
  const originOf = new Map([...roleOf.keys()].map(id => [id, id]));
  const everTracked = new Set(roleOf.keys());
  const shapeTouches = item => [...(item.lines || []).flatMap(line => [line.id, line.parent?.lineId]), ...(kindOf(item) === 'RemoveLines' ? item.lineIds || [] : [])].some(id => id && everTracked.has(id)) ||
    (item.lines || []).some(line => line.parent?.merchandiseId && line.parent.merchandiseId === initial.merchandiseId);
  // The request's own view of what it wrote, for a commit whose evidence cannot be trusted: quantities,
  // and removals (a removed glove takes its service with it).
  const shapeWrites = item => (item.lines || []).filter(line => line.id && everTracked.has(line.id) && line.quantity > 0).map(line => ({ origin: originOf.get(line.id) ?? line.id, quantity: line.quantity }));
  const shapeRemovals = item => [...(kindOf(item) === 'RemoveLines' ? item.lineIds || [] : []), ...(item.lines || []).filter(line => line.quantity === 0).map(line => line.id)]
    .filter(id => id && everTracked.has(id)).flatMap(id => roleOf.get(id) === 'glove' ? [id, ...serviceIds] : [id]).map(id => originOf.get(id) ?? id);
  // The race's starting glove and services, as the first commit's cartBefore must show them.
  const startLines = [{ id: initial.id, merchandiseId: initial.merchandiseId, parentId: null, quantity: initial.quantity, attributes: initial.attributes },
    ...initial.services.map(item => ({ id: item.id, merchandiseId: item.merchandiseId, parentId: initial.id, quantity: item.quantity, attributes: item.attributes }))].map(lineView);
  let gloveId = initial.id, gloveQuantity = initial.quantity, glovePrevious = initial.quantity;
  let previousAfter = null;
  const relevant = [];
  for (const [index, entry] of inOrder.entries()) {
    const issues = effectEvidenceIssues(entry);
    if (Array.isArray(entry.cartBefore)) {
      if (index === 0 && !startLines.every(line => entry.cartBefore.some(item => same(lineView(item), line)))) issues.push({ chain: 'the first commit\'s cartBefore does not hold the race\'s starting glove and service', startLines });
      if (index > 0 && previousAfter && !sameSnapshot(entry.cartBefore, previousAfter)) issues.push({ chain: 'cartBefore is not the cart the previous commit left (an unlogged or misreported change)' });
    }
    previousAfter = Array.isArray(entry.cartAfter) ? entry.cartAfter : null;
    if (issues.length) {
      problems.push({ problem: 'committed line mutation whose evidence is absent, incomplete, inconsistent or ambiguous (its effects are not trusted)', entry, issues });
      relevant.push({ entry, effectsKnown: false, written: shapeWrites(entry), removed: shapeRemovals(entry), reconfigured: [], state: null, unpaired: false });
      continue;
    }
    const { effects, cartAfter } = entry;
    // Follow verified re-keys first, so the commit's other effects (and its children's parents) use the new IDs.
    const moves = effects.filter(effect => effect.change === 'rekeyed' && roleOf.has(effect.previousId)).map(effect => [effect.previousId, effect.id, roleOf.get(effect.previousId), originOf.get(effect.previousId)]);
    for (const [from] of moves) { roleOf.delete(from); originOf.delete(from); }
    for (const [, to, role, origin] of moves) { roleOf.set(to, role); originOf.set(to, origin); everTracked.add(to); if (role === 'glove') gloveId = to; }
    const renamedTo = new Map(effects.filter(effect => effect.change === 'rekeyed').map(effect => [effect.previousId, effect.id]));
    // A line is touched if it is the glove or its service, or sits under the glove (a nested add).
    const touched = effects.filter(effect => roleOf.has(effect.id) || effect.after?.parentId && roleOf.get(effect.after.parentId) === 'glove');
    const added = touched.filter(effect => !roleOf.has(effect.id));
    for (const effect of added) { roleOf.set(effect.id, 'service'); originOf.set(effect.id, effect.id); everTracked.add(effect.id); }
    // Quantity writes come only from quantity changes (an attribute-only change writes no quantity)...
    const written = touched.filter(effect => effect.after && (!effect.before || effect.before.quantity !== effect.after.quantity))
      .map(effect => ({ origin: originOf.get(effect.id), role: roleOf.get(effect.id), quantity: effect.after.quantity, change: effect.change }));
    // ...plus a request that set a tracked line to the quantity it already had: it changed nothing, but
    // still wrote it, a repeat, which the ordering verdict below must see.
    for (const line of entry.lines || []) if (line.id && roleOf.has(line.id) && line.quantity > 0 && !written.some(item => item.origin === originOf.get(line.id)))
      written.push({ origin: originOf.get(line.id), role: roleOf.get(line.id), quantity: line.quantity, change: 'unchanged' });
    // Configuration changes (1M): a +1 never authorizes one. A tracked line whose merchandise, choices
    // (attributes) or parent changed, or a new line under the glove, is reported even if later restored.
    const reconfigured = [...touched.filter(effect => effect.before && effect.after).flatMap(effect => {
      const fields = ['merchandiseId', 'attributes'].filter(field => !same(effect.before[field], effect.after[field]));
      const parentBefore = effect.before.parentId == null ? null : renamedTo.get(effect.before.parentId) ?? effect.before.parentId;
      if (parentBefore !== (effect.after.parentId ?? null)) fields.push('parentId');
      return fields.length ? [{ origin: originOf.get(effect.id), role: roleOf.get(effect.id), fields, before: effect.before, after: effect.after }] : [];
    }), ...added.map(effect => ({ origin: effect.id, role: 'service', fields: ['a new line under the glove'], before: null, after: effect.after }))];
    const removed = touched.filter(effect => effect.change === 'removed').map(effect => originOf.get(effect.id));
    for (const effect of touched.filter(item => item.change === 'removed')) roleOf.delete(effect.id);
    // The committed state: the glove may lead its service until the storefront's own catch-up write
    // (src/commerce.js updates the glove, then the service), but the service may never exceed the glove,
    // except at the glove's previous quantity right after a decrease. The glove keeps exactly its services.
    const glove = roleOf.get(gloveId) === 'glove' ? cartAfter.find(line => line.id === gloveId) : null;
    if (glove && glove.quantity !== gloveQuantity) { glovePrevious = gloveQuantity; gloveQuantity = glove.quantity; }
    const children = glove ? cartAfter.filter(line => line.parentId === glove.id) : [];
    const state = glove ? { glove: glove.quantity, glovePrevious, services: children.map(line => ({ id: line.id, quantity: line.quantity })) } : { gloveRemoved: true };
    const unpaired = !!glove && (children.length !== initial.services.length || children.some(line => line.quantity > Math.max(glove.quantity, glovePrevious)));
    if (touched.length || shapeTouches(entry)) relevant.push({ entry, effectsKnown: true, written, removed, reconfigured, state, unpaired });
  }
  // The complete log (1M): every line mutation the mock logged for this cart during the race, committed or
  // not, must have been sent by a browser request; an entry nobody sent is unaccounted for.
  for (const entry of (committedLog || []).filter(item => item.cartId === cartId && LINE_MUTATIONS.includes(kindOf(item)) && !isCommit(item))) {
    if (!entry.tag || !requests.some(item => item.write.tag === entry.tag)) problems.push({ problem: 'a line mutation in the mock log that no browser request sent', entry });
  }
  // Each relevant commit must belong to exactly one tagged browser request of the same operation, with
  // the same commitSeq; each committed browser line request must appear in the log exactly once.
  // Anything else means the harness cannot attribute a commit to a shopper action, which is a harness
  // error, not a missing action.
  for (const { entry } of relevant) {
    if (entry.tag && committedLog.filter(item => isCommit(item) && item.tag === entry.tag).length > 1) problems.push({ problem: 'several committed mock entries share one tag', entry });
    const owners = entry.tag ? requests.filter(item => item.write.tag === entry.tag) : [];
    if (!entry.tag) problems.push({ problem: 'committed mutation without a request tag', entry });
    else if (!owners.length) problems.push({ problem: 'committed mutation whose tag no browser request carries (orphaned or mismatched)', entry });
    else if (owners.length === 1 && owners[0].write.commitSeq !== entry.commitSeq) problems.push({ problem: 'the request\'s commitSeq differs from the mock\'s', entry, request: owners[0].write });
    else if (owners.length === 1 && kindOf(owners[0].write) !== kindOf(entry)) problems.push({ problem: 'the tagged browser request is a different operation (unmatched operation)', entry, request: owners[0].write });
  }
  for (const { tab, write } of requests) if (write.tag && requests.filter(item => item.write.tag === write.tag).length > 1) problems.push({ problem: 'several browser requests share one tag', tab, tag: write.tag });
  for (const { tab, write } of requests.filter(item => browserCommitted(item.write))) {
    if ((lineCommits || []).filter(entry => entry.tag && entry.tag === write.tag).length !== 1) problems.push({ problem: 'committed request not found exactly once in the mock log', tab, write });
  }
  out.push(verdict('harness', `every committed ${name} mutation in the mock log has consistent recorded effects (checked against its own before and after snapshots) and belongs to exactly one tagged browser request of the same operation, with a unique positive commitSeq; every logged line mutation was sent by a browser request`,
    !problems.length, { problems, relevant: relevant.map(item => item.entry) }));
  const ownerOf = entry => requests.find(item => entry.tag && item.write.tag === entry.tag)?.tab ?? null;
  const sequence = relevant.map(({ entry, effectsKnown, written, removed, reconfigured, state, unpaired }) => ({ tab: ownerOf(entry), operation: kindOf(entry), tag: entry.tag ?? null, seq: entry.seq ?? null,
    commitSeq: entry.commitSeq ?? null, effectsKnown, written, removed, reconfigured, state, unpaired }));
  // Explicit: a declined tab owns no relevant commit at any point, even one a later commit overwrote, by
  // the mock's attribution or by its own correlated writes.
  const relevantTags = new Set(relevant.map(item => item.entry.tag).filter(Boolean));
  for (const action of actions.filter(item => declined(item.refusal))) {
    const forbidden = [...sequence.filter(item => item.tab === action.tab),
      ...action.writes.filter(write => write.cartId === cartId && isCommit(write) && shapeTouches(write) && !(write.tag && relevantTags.has(write.tag)))];
    out.push(verdict('risk:3', `tab ${action.tab}'s ${action.refusal.notOffered ? 'not-offered' : 'refused'} +1 committed nothing to this cart's ${name} or its service, at any commit (even one later overwritten)`,
      !forbidden.length, { state: action.refusal.notOffered ? 'not offered' : 'refused by name', refusal: action.refusal, forbidden }));
  }
  out.push(verdict('risk:3', `${name}'s service stays at the glove quantity in every committed state (it may trail the glove until the storefront's catch-up write, never exceed it), and stays its only service`,
    !!lineCommits && !sequence.some(item => item.unpaired), { unpaired: sequence.filter(item => item.unpaired), states: sequence.map(({ tab, commitSeq, state }) => ({ tab, commitSeq, state })) }));
  // A +1 changes quantities only. Any committed change to the glove's or service's merchandise, choices,
  // parent or service grouping during the race fails, from any tab, even if a later commit restored it.
  const reconfigurations = sequence.filter(item => item.reconfigured.length);
  out.push(verdict('risk:3', `no committed mutation changed the configuration of this cart's ${name} or its service (merchandise, choices, parent or service grouping) during the +1 race, even temporarily`,
    !reconfigurations.length, { reconfigurations }));
  // Removing the tracked glove or its service during the +1 race is an application failure, never ignored.
  const removals = sequence.filter(item => item.removed.length);
  out.push(verdict('risk:3', `no committed mutation removed this cart's ${name} or its service during the +1 race`, !removals.length, { removals }));
  // Every committed write to this glove or its service, from any tab, in the order the mock committed it
  // (commitSeq, taken where the mock changed state, not when the request arrived), must raise each of
  // those lines: a later commit lowering or repeating one overwrote an increment. The mock's own
  // commits decide, including any the browser correlation missed. Every commit, even a single one,
  // needs a unique positive integer commitSeq, or the order is unknown, which fails.
  const overwritten = [...new Set(sequence.flatMap(item => item.written.map(line => line.origin)))].flatMap(origin => {
    const commits = sequence.flatMap(item => item.written.filter(line => line.origin === origin).map(line => ({ origin, tab: item.tab, commitSeq: item.commitSeq, quantity: line.quantity })));
    return commits.filter((item, index) => index && item.quantity <= commits[index - 1].quantity);
  });
  out.push(verdict('risk:3', `committed ${name} writes only ever raised the quantity (no increment overwritten)`, orderKnown && !overwritten.length, { orderKnown, sequence, overwritten }));
  return out;
}
// Shopify's final codes equal the start with every confirmed change applied; each action is either
// confirmed or refused by name, never both or neither.
function discountGate({ start, final, actions }) {
  const expected = new Set(start.map(codeKey));
  for (const action of actions) if (action.claimed && !declined(action.refusal)) { if (action.kind === 'apply') expected.add(codeKey(action.code)); else expected.delete(codeKey(action.code)); }
  const out = [verdict('risk:2', 'Shopify\'s codes equal the start plus every discount change a tab confirmed', same(final.map(codeKey).sort(), [...expected].sort()),
    { final, expected: [...expected].sort(), actions })];
  for (const action of actions) out.push(verdict('risk:2', `tab ${action.tab}'s ${action.kind} of ${action.code} is either confirmed or refused by name`, action.claimed !== declined(action.refusal), action));
  return out;
}

// Interrupted split recovery: the recovered cart must hold both BR16 gloves with their own services and
// instructions, either exactly as they were before the edit or exactly as edited. Anything else lost
// or changed a shopper's instructions.
function splitRecoveryGate({ beforeLines, intendedLines, recoveredLines }) {
  const got = configuration(recoveredLines);
  return [verdict('risk:4', 'recovery after the interrupted split keeps both BR16 gloves with their own services, as they were or as edited',
    same(got, configuration(beforeLines)) || same(got, configuration(intendedLines)), { recovered: got, before: configuration(beforeLines), intended: configuration(intendedLines) }),
  verdict('risk:4', 'recovered cart passes every pairing invariant', !pairingIssues(recoveredLines).length, { issues: pairingIssues(recoveredLines) })];
}
// The cart a split edit should produce: the original glove at 1, and one glove at 1 with the new wearing style.
function intendedSplit(lines, style) {
  const [glove] = gloves(lines);
  const service = glove.services[0];
  const restyle = (attributes, key) => sortAttributes(attributes.map(item => item.key === key ? { ...item, value: style } : item));
  return [{ id: 'kept', handle: glove.handle, merchandiseId: glove.merchandiseId, quantity: 1, parentId: null, attributes: glove.attributes },
    { id: 'kept-service', handle: service.handle, merchandiseId: service.merchandiseId, quantity: 1, parentId: 'kept', attributes: service.attributes },
    { id: 'moved', handle: glove.handle, merchandiseId: glove.merchandiseId, quantity: 1, parentId: null, attributes: restyle(glove.attributes, '_anawin_wearing_style') },
    { id: 'moved-service', handle: service.handle, merchandiseId: service.merchandiseId, quantity: 1, parentId: 'moved', attributes: restyle(service.attributes, 'Glove Wearing Style') }];
}
// Apply tapped while another cart update is held. Two behaviours are correct: (A) Apply is disabled and
// nothing is sent; (B) Apply stays enabled, the submission is queued and sent exactly once after the
// held update completed, and the confirmation is truthful. Being enabled is not itself a defect;
// dropping the tap silently, sending it early or twice, or confirming a code Shopify lacks is.
// Feedback is classified statement by statement, in each captured field separately, by what it tells
// the shopper (no closed list of exact messages):
// - a success claim is a statement about a discount/code that says it was applied, accepted, activated,
//   added, redeemed or saved, with no negation before that verb. It counts even beside pending or
//   failure wording ("Discount code applied. Updating your cart…", "applied, but checkout failed");
// - a discount failure is a statement that says something did not work and is about the discount, or
//   sits in the discount-message field without naming another operation (checkout, shipping, …);
// - pending wording ("Updating…", "Applying…") is neither, and never stands in for a result.
// Ambiguous text is resolved conservatively: anything that could be read as a success claim is one.
// - the failed operation is found for every failure word, wherever it sits (1I): the object of an
//   active verb after it ("couldn't load shipping for your discount" failed shipping; "couldn't apply
//   your discount" failed the discount), otherwise the head of the clause before it ("Checkout failed
//   while checking your discount code", "Shipping for your discount couldn't load"). Any failure of
//   another operation disqualifies the statement. Each failure word is resolved in its own clause
//   (1J): "Your discount code was checked and shipping failed to load" failed shipping. A statement is
//   discount-specific only when a failure's subject or object head is the discount or a code (1K).
//   Copy that names no operation counts only as the exact catch copy (CATCH_TEMPLATES) truthful for the
//   write's real outcome; anything else is an unsupported shape and fails. "Try again" / "retry"
//   alone reports nothing;
// - "<X> applied." (the storefront template) is matched against the submitted code first, by codeKey,
//   whatever X is (1K); another single-token X is a claim for code X. Otherwise:
// - a code is named by position, not shape: a token with letters and digits (SAVE20, synth10), a
//   quoted token, the word after "code"/"coupon"/"promo" (any case), an all-capitals word after
//   "discount", words in any case directly before applied/redeemed/activated ("freeship applied",
//   "FreeShip and SAVE20 applied"; 1J), all-capitals words directly before the other success verbs, or
//   the word after "with"/"using" following a success verb ("Saved 10% with SUMMER"). Product models,
//   operation words and function words never are.
//   A success claim naming any code other than the one submitted is false.
const DISCOUNT_TOPIC = /\b(discounts?|codes?|promos?|promotions?|coupons?)\b/i;
const OTHER_OPERATION = /\b(checkout|shipping|delivery|payments?|address(?:es)?|quantit(?:y|ies)|wrist|break-?in|gloves?|items?|orders?)\b/i;
const SUCCESS_VERB = /\b(applied|accepted|activated|added|redeemed|saved)\b/i;
const NEGATION = /\b(not|never|no longer|unable|cannot)\b|n['’]t\b|\bcould not\b/i;
// Words that report a failure. "Try again" and "retry" are advice, not a report of what failed.
const FAILURE = /\b(not|never|unable|cannot|failed|failure|invalid|error|rejected|declined|expired|unavailable|went wrong|problem|lost|timed? out|taking too long)\b|n['’]t\b/gi;
// Where a noun phrase ends: punctuation, a preposition or a conjunction.
const PHRASE_END = /[.,;:!?—–()]|\b(?:for|with|to|on|at|in|into|while|because|from|of|by|during|after|before|when|until|so|and|or|but|then|right|now)\b/i;
// Where a clause ends: punctuation or a conjunction. A failure word is judged in its own clause only.
const CLAUSE_BREAK = /[.,;:!?—–()]|\b(?:and|but|or|so|then|while|because|although|though|whereas|after|before|when|until|since|once)\b/i;
const PREPOSITION = /\b(?:for|with|to|on|at|in|into|from|of|by|during|right|now)\b/i;
// The discount action's catch copy (1K), exactly as src/main.js discountAction shows it in the discount
// field: commerceErrorMessage(error, 'cart') in src/commerce.js. Each template is truthful only for the
// write outcomes that reach it: any thrown failure (HTTP error, GraphQL error, or HTTP 200 with
// userErrors, which updateDiscountCodes throws as a plain Error) shows the generic copy; only a request
// that got no successful HTTP response can show the timeout or connection copy.
// 1L: a write is settled once the mock finished it; it committed only with HTTP 200, no top-level GraphQL
// errors, no userErrors and a returned cart. HTTP 200 alone is never proof of success.
// 1M: two independent facts are both required. The mock committed it (a positive integer commitSeq in its
// own log), and the response names the requested cart: src/commerce.js updateDiscountCodes throws
// "Shopify returned a different cart." unless the returned cart's id equals the requested cartId, and
// "Shopify did not return a cart." without one. A missing, blank or other cart ID is never a success.
// 1N: those are separate facts. Shopify can commit a write whose response names another cart, a blank ID
// or none (the mock's 'commit-then-substitute' forgery); that commit is real, but the response is not safe
// to accept. `remotelyCommitted` is the mock's own record; `writeCommitted` is a commit the storefront may accept.
const writeSettled = write => !!write && write.status !== 0 && write.outcome !== 'pending' && (write.finishedAt != null || write.committedAt != null);
const returnsRequestedCart = write => typeof write.cartId === 'string' && write.cartId.trim() !== '' && typeof write.returnedCartId === 'string' && write.returnedCartId === write.cartId;
const answeredCleanly = write => writeSettled(write) && write.status === 200 && !(write.userErrors || []).length && !(write.graphqlErrors || []).length;
const remotelyCommitted = write => answeredCleanly(write) && Number.isInteger(write.commitSeq) && write.commitSeq > 0 && !['malformed', 'failed-before-commit', 'response-forged'].includes(write.outcome);
const writeCommitted = write => remotelyCommitted(write) && returnsRequestedCart(write);
const CATCH_TEMPLATES = [
  { text: 'Couldn’t update your cart. Please try again.', truthfulFor: write => writeSettled(write) && !writeCommitted(write) },
  { text: 'Shopify is taking too long to respond. Please try again.', truthfulFor: write => writeSettled(write) && write.status !== 200 },
  { text: 'Connection lost. Check your connection and try again.', truthfulFor: write => writeSettled(write) && write.status !== 200 }
];
// src/cart-discounts.js discountResultFeedback, for a committed update that left the code applicable:false.
const UNCERTAIN_COPY = 'We could not confirm your cart update. Check your cart before trying again.';
const NOT_APPLICABLE_COPY = 'Discount code isn’t valid for this cart.';
const normalizeCopy = text => String(text || '').trim().replace(/\s+/g, ' ').replace(/'/g, '’');
const isCatchCopyFor = (text, write) => !!write && CATCH_TEMPLATES.some(template => template.text === normalizeCopy(text) && template.truthfulFor(write));
// The storefront's only success template (src/cart-discounts.js discountResultFeedback): `${code} applied.`,
// where code is the shopper's input after trim(), case kept. Codes compare by codeKey (trim, en-US lower case).
const templateCodeOf = statement => /^(.+?)\s+applied\.?$/i.exec(String(statement).trim())?.[1].trim() ?? null;
const DISCOUNT_NOUN = /^(discounts?|codes?|promos?|promotions?|coupons?)$/i;
// The code a template statement names: the submitted code when it matches (whatever it looks like), else a
// single-token code other than a discount noun ("Discount applied." is generic). Null: not this template.
function templateClaim(statement, code) {
  const named = templateCodeOf(statement);
  if (named == null) return null;
  if (code && codeKey(named) === codeKey(code)) return named;
  return /\s/.test(named) || DISCOUNT_NOUN.test(named) ? null : named;
}
const PENDING = /\b(applying|checking|working|loading|updating|processing|please wait)\b|…|\.\.\./i;
const PRODUCT_MODELS = new Set([...localProducts, ...fullSizeProducts].map(product => product.name.toUpperCase()));
const NOT_A_CODE = new Set(['THE', 'YOUR', 'THIS', 'THAT', 'AND', 'ARE', 'WAS', 'WERE', 'ISN', 'WASN', 'AREN', 'HAS', 'HASN', 'HAVE', 'BEEN', 'CAN', 'COULD', 'COULDN',
  'CANNOT', 'WILL', 'WON', 'DOES', 'DOESN', 'DID', 'DIDN', 'NOT', 'YOU', 'FIELD', 'ENTERED', 'VALID', 'INVALID', 'EXPIRED', 'REMOVED', 'UPDATED', 'APPLYING', 'SUCCESSFULLY',
  'ALREADY', 'NOW', 'SERVICE', 'ERROR', 'FAILED', 'UNAVAILABLE', 'REQUIRED', 'FOR', 'NEEDS', 'MUST',
  // Ordinary commerce words that can sit before a success verb or after "with" without being a code (1J).
  'CHANGES', 'CHANGE', 'SAVINGS', 'OFF', 'OFFER', 'DEAL', 'SALE', 'PRICE', 'PRICES', 'TOTAL', 'ACCOUNT', 'CARE', 'SELECTIONS', 'SELECTION',
  'SETTINGS', 'NOTES', 'NOTE', 'UPDATES', 'ALSO', 'AUTOMATICALLY']);
const isCodeWord = token => token.length >= 3 && !PRODUCT_MODELS.has(token.toUpperCase()) && !NOT_A_CODE.has(token.toUpperCase()) &&
  !SUCCESS_VERB.test(token) && !new RegExp(`^(?:${DISCOUNT_TOPIC.source}|${OTHER_OPERATION.source})$`, 'i').test(token);
const ALL_CAPS = /^[A-Z][A-Z0-9_-]{2,}$/;
function codesNamedIn(statement) {
  const text = String(statement);
  const named = [...text.matchAll(/\b(?=[a-z0-9-]*\d)(?=[a-z0-9-]*[a-z])[a-z0-9-]{3,}\b/gi)].map(match => match[0]);
  named.push(...[...text.matchAll(/["“”'‘’]([A-Za-z0-9][\w-]{2,})["“”'‘’]/g)].map(match => match[1]));
  named.push(...[...text.matchAll(/\b(?:codes?|coupons?|promos?)\s+(?=([A-Za-z0-9][\w-]*))/gi)].map(match => match[1]));
  named.push(...[...text.matchAll(/\bdiscount\s+(?=([A-Za-z0-9][\w-]*))/gi)].map(match => match[1]).filter(token => ALL_CAPS.test(token)));
  for (const verb of text.matchAll(new RegExp(SUCCESS_VERB.source, 'gi'))) {
    const list = /((?:[A-Za-z0-9][\w-]*\s*(?:,|\band\b|&)\s*)*[A-Za-z0-9][\w-]*)\s+$/.exec(text.slice(0, verb.index))?.[1] || '';
    // A discount-specific verb names the word before it in any case; the storefront echoes the code as typed.
    const anyCase = /^(applied|redeemed|activated)$/i.test(verb[0]);
    named.push(...list.split(/\s*(?:,|\band\b|&)\s*/i).filter(token => anyCase || ALL_CAPS.test(token)));
    named.push(...[...text.slice(verb.index).matchAll(/\b(?:with|using)\s+(?:(?:the|your)\s+)?(?:(?:discount|promo)\s+)?(?:codes?\s+)?["“]?([A-Za-z0-9][\w-]*)/gi)].map(match => match[1]));
  }
  return [...new Set(named.filter(isCodeWord).map(token => token.toUpperCase()))];
}
const statementsOf = text => String(text || '').split(/(?<=[.!?…])\s+|;\s+|,?\s+but\s+|\n+/i).map(part => part.trim()).filter(Boolean);
// Codes a statement names: the template's code first, else the positional heuristics plus any whole-word
// occurrence of the submitted code (which no exclusion list can rule out).
function namedCodes(statement, code) {
  const claimed = templateClaim(statement, code);
  if (claimed != null) return [claimed.toUpperCase()];
  const named = codesNamedIn(statement);
  if (code && new RegExp(`(?<![\\w-])${code.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'i').test(statement)) named.push(code.trim().toUpperCase());
  return [...new Set(named)];
}
const isSuccessClaim = (statement, code) => {
  if (templateClaim(statement, code) != null) return true;
  const verb = SUCCESS_VERB.exec(statement);
  return !!verb && (DISCOUNT_TOPIC.test(statement) || namedCodes(statement, code).length > 0) && !NEGATION.test(statement.slice(0, verb.index));
};
// The last operation named in a phrase: 'discount' (including a named code), 'other', or null.
const lastOperationIn = (phrase, codes) => {
  const terms = [...phrase.matchAll(new RegExp(DISCOUNT_TOPIC.source, 'gi'))].map(match => ({ at: match.index, kind: 'discount' }))
    .concat([...phrase.matchAll(new RegExp(OTHER_OPERATION.source, 'gi'))].map(match => ({ at: match.index, kind: 'other' })))
    .concat([...phrase.matchAll(/[A-Za-z0-9][\w-]*/g)].filter(match => codes.includes(match[0].toUpperCase())).map(match => ({ at: match.index, kind: 'discount' })));
  return terms.sort((a, b) => a.at - b.at).at(-1)?.kind ?? null;
};
// What one failure word says failed: the object of an active verb after it, and the head of its clause.
// Another operation in either place makes it that operation's failure ("Checkout couldn't verify your
// discount code" is ambiguous, so it is not discount feedback).
// A phrase is about the discount only when its head (last word, after auxiliaries, adverbs and "service")
// is a discount noun or a named code (1K): "The discount service is", "Discount code SYNTH10 couldn",
// "SYNTH10 isn", "your discount code". "Your discount’s image" and "Image service is … for your discount" are not.
const HEAD_FILLER = new Set(['is', 'was', 'are', 'were', 'has', 'have', 'had', 'been', 'be', 'being', 'could', 'can', 'did', 'does', 'do', 'will', 'would', 'should',
  'couldn', 'isn', 'wasn', 'aren', 'weren', 'hasn', 'haven', 'didn', 'doesn', 'won', 'wouldn', 'shouldn', 'temporarily', 'currently', 'now', 'right', 'still', 'service', 'services']);
const headIsDiscount = (phrase, codes) => {
  const words = phrase.split(/[^\w’'-]+/).filter(Boolean);
  while (words.length && HEAD_FILLER.has(words.at(-1).toLowerCase())) words.pop();
  return !!words.length && (DISCOUNT_NOUN.test(words.at(-1)) || codes.includes(words.at(-1).toUpperCase()));
};
function failedOperation(statement, cue, codes) {
  const after = statement.slice(cue.index + cue[0].length);
  const takesObject = /n['’]t|^(not|never|cannot)$/i.test(cue[0]) || /^(unable|failed)$/i.test(cue[0]) && /^\s+to\b/i.test(after);
  const active = takesObject && /^\s+(?:to\s+)?(?!(?:be|been|being)\b)[a-z]+\b(.*)$/is.exec(after);
  const objectPhrase = active ? active[1].split(PHRASE_END)[0] : '';
  // The cue's own clause: from the last clause break before it to the first one after it.
  const before = statement.slice(0, cue.index).split(CLAUSE_BREAK).at(-1);
  const subjectPhrase = before.split(PREPOSITION)[0];
  const ownClause = before + cue[0] + after.split(CLAUSE_BREAK)[0];
  if ([lastOperationIn(objectPhrase, codes), lastOperationIn(subjectPhrase, codes)].includes('other')) return 'other';
  if (headIsDiscount(objectPhrase, codes) || headIsDiscount(subjectPhrase, codes)) return 'discount';
  return OTHER_OPERATION.test(ownClause) ? 'other' : null;
}
// A discount-specific failure statement: some failure word's subject or object is the discount, and none
// is another operation. Copy that names no operation is never discount-specific (1K).
const isDiscountFailure = (statement, code) => {
  if (isSuccessClaim(statement, code)) return false;
  const codes = namedCodes(statement, code);
  const failed = [...statement.matchAll(FAILURE)].map(cue => failedOperation(statement, cue, codes));
  return failed.includes('discount') && !failed.includes('other');
};
const claimsDiscountSuccess = (text, code) => statementsOf(text).some(statement => isSuccessClaim(statement, code));
// Discount-field failure feedback: the exact catch copy truthful for this write's outcome, or a
// discount-specific failure statement. Anything else is an unsupported shape, and fails.
const reportsDiscountFailure = (text, { write, code } = {}) => isCatchCopyFor(text, write) || statementsOf(text).some(statement => isDiscountFailure(statement, code));
// Success claims (any field) that name a code other than the one submitted (compared by codeKey).
const foreignCodeClaims = (events, code) => events.flatMap(event => fieldsOf(event).flatMap(statementsOf)).filter(statement => isSuccessClaim(statement, code))
  .filter(statement => namedCodes(statement, code).some(named => codeKey(named) !== codeKey(code)));
// `events` are timestamped changes to: discount message | cart announcer | cart feedback | checkout status.
const fieldsOf = event => event.text.split(' | ').map(part => part.trim());
const discountMessageOf = event => fieldsOf(event)[0] || '';
function busyApplyGate({ applyEnabled, cartId, held, writes, codes, codeStates, message, events = [], code = 'SYNTH10', uncertainty = null }) {
  // 1L: completion, membership and applicability are separate facts; codes compare by codeKey.
  const key = codeKey(code);
  const states = (codeStates || []).filter(item => codeKey(item.code) === key);
  const others = (codeStates || []).filter(item => codeKey(item.code) !== key);
  const applicable = states.length === 1 && states[0].applicable === true;
  const inapplicable = states.length === 1 && states[0].applicable === false;
  const successes = events.filter(event => fieldsOf(event).some(field => claimsDiscountSuccess(field, code)));
  const misnamed = [...foreignCodeClaims(events, code), ...foreignCodeClaims([{ text: String(message || '') }], code)];
  const write = writes[0];
  const queuedAfterHeld = writes.length === 1 && write.cartId === cartId && write.seq > held.seq && write.startedAt >= held.finishedAt && same((write.discountCodes || []).map(codeKey), [key]);
  const committed = writeCommitted(write);
  const remote = remotelyCommitted(write);
  const settledAt = write?.committedAt ?? write?.finishedAt ?? Infinity;
  const disabledPath = !applyEnabled && !writes.length && !(codeStates || []).length && !successes.length;
  // Success: committed, the code present and applicable:true, every claim after the commit, no foreign code.
  const queuedSuccess = applyEnabled && queuedAfterHeld && committed && applicable && !others.length && claimsDiscountSuccess(message, code) &&
    successes.length > 0 && successes.every(event => event.at >= write.committedAt) && !misnamed.length;
  // Committed but inapplicable: the code present with applicable:false, never a success claim, and the
  // storefront's not-valid copy (or a discount-specific failure) shown after the commit.
  const notValid = text => normalizeCopy(text) === NOT_APPLICABLE_COPY || statementsOf(text).some(statement => isDiscountFailure(statement, code));
  const queuedInapplicable = applyEnabled && queuedAfterHeld && committed && inapplicable && !others.length && !successes.length && notValid(message) &&
    events.some(event => event.at >= write.committedAt && notValid(discountMessageOf(event)));
  // Failure: settled without committing, no code, no success claim, and truthful failure feedback after settling.
  const context = { write, code };
  const failureFeedback = events.filter(event => event.at >= settledAt && reportsDiscountFailure(discountMessageOf(event), context));
  // A write Shopify committed is never this branch (1N): its code is on the cart, so "no code" would be false.
  const queuedFailure = applyEnabled && queuedAfterHeld && writeSettled(write) && !committed && !remote && !(codeStates || []).length && !successes.length && reportsDiscountFailure(message, context) && failureFeedback.length > 0;
  // 1N: an HTTP 200 answer whose cart ID is missing, blank or another cart's, which the storefront must refuse
  // (src/commerce.js updateDiscountCodes throws) whether or not Shopify committed it. Its truthful feedback is
  // the catch copy after it settled, with no success claim anywhere. Nothing is credited as accepted, and the
  // cart must hold exactly what Shopify committed: the submitted code if it committed, no code otherwise.
  const rejectedResponse = answeredCleanly(write) && !returnsRequestedCart(write);
  const committedStateIntact = remote ? states.length === 1 && !others.length : !(codeStates || []).length;
  // 1O: a remote commit does not mean the storefront has the substituted response, so this branch never uses
  // committedAt. The mock sets finishedAt in its handler's finally block, after response.end() handed the
  // response to the socket: on the shared host clock, the earliest time the browser could have it. Every catch
  // copy shown in the discount field must come at or after it. A missing, non-numeric or non-finite finishedAt,
  // or one before the write started or committed, is no settlement evidence, and the branch fails.
  const responseSentAt = write && typeof write.finishedAt === 'number' && Number.isFinite(write.finishedAt) && write.finishedAt >= write.startedAt &&
    (write.committedAt == null || write.finishedAt >= write.committedAt) ? write.finishedAt : null;
  const rejectionFeedback = events.filter(event => isCatchCopyFor(discountMessageOf(event), write));
  const queuedRejected = applyEnabled && queuedAfterHeld && rejectedResponse && committedStateIntact && !successes.length && !claimsDiscountSuccess(message, code) && !misnamed.length &&
    isCatchCopyFor(message, write) && responseSentAt != null && rejectionFeedback.length > 0 && rejectionFeedback.every(event => event.at >= responseSentAt);
  // The mock's internal commitment is separate from the evidence the response supplied.
  // An HTTP failure, top-level execution error, or clean answer with an unusable cart gives
  // no authoritative outcome here. A clean order-level rejection via userErrors does.
  const responseAmbiguous = writeSettled(write) && !(write.userErrors || []).length &&
    (write.status !== 200 || (write.graphqlErrors || []).length > 0 || rejectedResponse);
  const uncertainEvents = events.filter(event => normalizeCopy(discountMessageOf(event)) === UNCERTAIN_COPY);
  const uncertainCopy = normalizeCopy(message) === UNCERTAIN_COPY;
  const discountHasOtherOutcome = events.some(event => {
    const text = normalizeCopy(discountMessageOf(event));
    return text && text !== UNCERTAIN_COPY;
  });
  const request = uncertainty?.dispatches?.[0];
  const journal = uncertainty?.journal?.[0];
  const correlated = uncertainty?.dispatches?.length === 1 && !!write?.tag && request.tag === write.tag &&
    request.operation === 'UpdateDiscountCodes' && request.cartId === cartId && request.at <= write.startedAt &&
    same((request.discountCodes || []).map(codeKey), [key]);
  const journalBound = uncertainty?.journal?.length === 1 && journal.key === 'anawin-shopify-unsafe-op:' + journal.owner &&
    journal.status === 'unresolved' && journal.dispatched === true && journal.cartId === cartId &&
    journal.kind === 'applyDiscountCode' && journal.kinds?.includes('discount update') &&
    journal.createdAt >= held.finishedAt && journal.createdAt <= request?.at &&
    journal.step?.state === 'dispatched-unknown' && journal.step?.n === 1 &&
    journal.step?.target === cartId && journal.step?.field === 'cartDiscountCodesUpdate';
  const expectedCodes = remote ? write.committedState?.discountApplicability : [];
  const queuedUncertain = applyEnabled && queuedAfterHeld && correlated && responseAmbiguous && responseSentAt != null &&
    same(codeStates, expectedCodes) && same((codes || []).map(codeKey), (expectedCodes || []).map(item => codeKey(item.code))) &&
    uncertainCopy && uncertainEvents.length > 0 && uncertainEvents.every(event => event.at >= responseSentAt) &&
    !discountHasOtherOutcome && !successes.length && !misnamed.length && journalBound && uncertainty.refresh &&
    uncertainty.checkout === false && uncertainty.apply === false && uncertainty.navigation === 0;
  const sawUncertainty = uncertainCopy || uncertainEvents.length > 0;
  const claimed = successes.length > 0 || claimsDiscountSuccess(message, code);
  const facts = { remotelyCommitted: remote, responseForRequestedCart: !!write && returnsRequestedCart(write), codePresent: states.length === 1, applicable: applicable ? true : inapplicable ? false : null,
    successClaimed: claimed, responseAcceptable: committed, responseSentAt, path: disabledPath ? 'disabled' : queuedSuccess ? 'accepted' : queuedInapplicable ? 'accepted-not-applicable' : queuedFailure ? 'failed' : queuedRejected ? 'rejected-response' : queuedUncertain ? 'uncertain' : null };
  return [verdict('finding', 'Apply while the cart is busy is disabled with nothing sent, or queued and sent once after the held update with truthful confirmation',
    (sawUncertainty ? queuedUncertain : disabledPath || queuedSuccess || queuedInapplicable || queuedFailure || queuedRejected), { facts, applyEnabled, cartId, held, writes, codes, codeStates, message, events }),
  verdict('baseline', 'no success claim comes before the discount write committed', successes.every(event => committed && event.at >= write.committedAt),
    { successes, committedAt: write?.committedAt ?? null }),
  verdict('baseline', 'no success is claimed for a code Shopify does not have', applicable || !(successes.length || claimsDiscountSuccess(message, code)), { codeStates, message, successes }),
  verdict('baseline', `every success claim that names a code names the submitted ${code}`, !misnamed.length, { code, misnamed })];
}
// An invalid checkout URL at handoff: the final Cart read before the refusal must be for this cart,
// succeed and return the injected URL, and the refusal must be new and about opening checkout (not a
// generic "being checked", "another tab" or connection message).
const URL_REFUSAL = /couldn['’]t open secure checkout/i;
const NOT_URL_REFUSAL = /still being checked|another tab|connection|could not verify|couldn['’]t check/i;
function invalidUrlGate({ label, pattern, reads, offered, alertsBefore, alertsAfter, activeCartId }) {
  const final = reads.filter(entry => entry.operation === 'Cart').at(-1) || null;
  const finalOk = !!final && final.cartId === activeCartId && final.status === 200 && pattern.test(final.checkoutUrl || '');
  const relevant = alertsAfter.filter(text => !alertsBefore.includes(text) && URL_REFUSAL.test(text) && !NOT_URL_REFUSAL.test(text));
  const out = [];
  if (offered) out.push(verdict('baseline', `${label}: the final Cart read was for this cart, succeeded and returned the injected URL`, finalOk,
    { final: final && { seq: final.seq, cartId: final.cartId, status: final.status, checkoutUrl: final.checkoutUrl }, activeCartId, injected: String(pattern) }));
  out.push(verdict('baseline', `${label} is refused with a new message about opening checkout`, (!offered || finalOk) && relevant.length > 0, { offered, relevant, alertsBefore, alertsAfter }));
  return out;
}

// Each tab's writes since `since`: its own requests (from CDP), each matched to the mock's log entry by
// its request tag (when tagged), operation, cart and submitted lines, with the response status,
// userErrors and resulting line quantity. Each write's lifecycle is one of: 'not received' (the mock
// never logged it), 'received' (logged but never executed: failed before commit, held, cancelled),
// 'rejected' (executed without changing state: userErrors or unmodelled), or 'committed' (the mock
// changed state and gave it a commitSeq).
function correlateRequests(requests, log, operation) {
  const used = new Set();
  const byTab = {};
  for (const request of requests.filter(item => item.operation === operation)) {
    const entry = log.find(item => !used.has(item.seq) && item.operation === operation && (!request.tag || item.tag === request.tag) && item.cartId === request.cartId &&
      same(item.lines.map(lineIdentity), request.lines.map(lineIdentity)) && (operation !== 'RemoveLines' || same(item.lineIds || [], request.lineIds || [])));
    if (entry) used.add(entry.seq);
    const lifecycle = !entry ? 'not received' : Number.isFinite(entry.commitSeq) ? 'committed' : entry.attemptedAt != null ? 'rejected' : 'received';
    // Every submitted line is kept, in order; which one is the glove is decided by the gate, by ID.
    (byTab[request.tab] ||= []).push({ operation, seq: entry?.seq ?? null, commitSeq: entry?.commitSeq ?? null, lifecycle, tag: request.tag ?? null, cartId: request.cartId, lines: request.lines,
      lineIds: operation === 'RemoveLines' ? request.lineIds || [] : undefined,
      outcome: entry?.outcome ?? 'not seen by the mock', status: entry?.status ?? null, userErrors: entry?.userErrors ?? null, resultLines: entry?.resultLines ?? null });
  }
  return byTab;
}
const correlateWrites = (operation, since, log) => correlateRequests(browserRequests.filter(item => item.scenario === scenario && item.at >= since), log, operation);

// ---- Races ----
// Holds the first matching Shopify request before it commits, starts the second tab's action, waits
// until that action has visibly started, gives it a bounded window to send its own write, then
// releases the first request whether or not the second write ever arrived. A storefront that
// serialises the two operations (the second waits for the first) passes through this the same way
// as one that sends both at once; only the final state decides the outcome.
async function race({ operation, first, second, secondTab, secondOperations = [operation], windowMs = 2000 }) {
  const { id } = await control('hold', { operation, phase: 'before' });
  const startedAtSeq = (await requestLog()).at(-1)?.seq || 0;
  await first();
  const held = await control('awaitHeld', { id, timeoutMs: 8000 });
  check('harness', `first ${operation} reached the mock and is held`, held.arrived, held);
  const mark = Date.now();
  const before = await secondTab.alerts();
  const dispatched = await second();
  // The second press either reached its enabled control (proven by tap) or found it disabled. A
  // disabled control is visible feedback that the action is not offered right now; that is the
  // storefront's choice to make, so it is recorded for the gate rather than treated as a harness fault.
  observe('second action dispatch', dispatched ?? null);
  check('harness', 'the second tab\'s press was delivered to its control, or found it disabled', dispatched?.delivered === true || dispatched?.disabled === true, dispatched);
  const notOffered = dispatched?.disabled === true;
  const started = notOffered || await poll(async () => browserRequests.some(item => item.scenario === scenario && item.tab === secondTab.name && item.at >= mark) ||
    await secondTab.busy() || !same(await secondTab.alerts(), before), 3000);
  check('harness', `second tab's action started while the first ${operation} was held`, started);
  const secondWrite = await poll(async () => (await requestLog()).some(entry => entry.seq > (held.seq || startedAtSeq) && entry.mutation &&
    secondOperations.includes(entry.operation)), windowMs);
  const released = await control('release', { id });
  check('harness', `held ${operation} was released`, released.released, released);
  observe('race interleaving', { operation, mode: secondWrite ? 'concurrent: second write reached Shopify while the first was held' : 'serialized: second write waited for the first' });
  if (selfTest) check('harness', 'self-test storefront really serialized the two writes', !secondWrite);
  return { secondWrite, notOffered };
}

// ---- Shared flows (real UI) ----
async function addTrainer(tab, id = 'black', { breakIn = null, wristFit = null } = {}) {
  const handle = { black: 'br16', blue: 'ob16', brown: 'cl16' }[id];
  if (!(await tab.eval(`location.pathname`)).endsWith(`/product/${handle}`)) await tab.visit(`/product/${handle}`);
  if (wristFit) await tab.click(`input[name="wrist-fit"][value="${wristFit}"]`);
  if (breakIn) {
    await tab.eval(`(() => { const box = document.querySelector('[data-break-in]'); if (!box.checked) box.click(); })()`);
    await tab.until(`!document.querySelector('[data-break-in-customization]').hidden`);
    await tab.eval(`document.querySelector('input[name="break-in-level"][value=${JSON.stringify(breakIn.level)}]').click();
      document.querySelector('input[name="glove-wearing-style"][value=${JSON.stringify(breakIn.wearingStyle)}]').click();`);
  }
  await tab.tap(`[data-add="${id}"]`);
  await tab.settled();
}
// Chooses every required full-size field: `choices` by input name, otherwise the first non-"Other" option.
async function addFullSize(tab, { breakIn = true, choices = {}, notes = '', hand = 'Right' } = {}) {
  if (!(await tab.eval(`location.pathname`)).endsWith('/product/mi26')) await tab.visit('/product/mi26');
  await tab.until(`!document.querySelector('[data-full-size-break-in]').disabled`);
  await tab.eval(`[...document.querySelectorAll('input[name="full-size-throw-hand"]')].find(input => input.value.startsWith(${JSON.stringify(hand)})).click()`);
  if (await tab.eval(`document.querySelector('[data-full-size-break-in]').checked`) !== breakIn) await tab.click('[data-full-size-break-in]');
  if (breakIn) {
    await tab.until(`!document.querySelector('[data-full-size-customization]').hidden`);
    await tab.eval(`(() => { const choices = ${JSON.stringify(choices)};
      const names = [...new Set([...document.querySelectorAll('[data-full-size-customization] input[type="radio"]')].map(input => input.name))];
      for (const name of names) {
        const inputs = [...document.querySelectorAll('input[name="' + name + '"]')];
        (inputs.find(input => input.value === choices[name]) || inputs.find(input => !input.value.startsWith('Other'))).click();
      }
      const notes = document.querySelector('#full-size-break-in-notes');
      notes.value = ${JSON.stringify(notes)}; notes.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
  }
  await tab.tap('[data-add="full-mint"]');
  await tab.settled();
}
async function typeDiscount(tab, code) {
  if (await tab.eval(`document.querySelector('[data-discount-toggle]').getAttribute('aria-expanded')`) !== 'true') await tab.tap('[data-discount-toggle]');
  await tab.eval(`(() => { const i = document.querySelector('#cart-discount-input'); i.value = ${JSON.stringify(code)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
}
async function applyDiscount(tab, code) { await typeDiscount(tab, code); await tab.tap('[data-discount-apply]'); }
const discountMessage = tab => tab.text('#cart-discount-message');
const lastCartRead = async (beforeAt = Infinity) => (await requestLog()).filter(entry => entry.operation === 'Cart' && entry.checkoutUrl && entry.finishedAt <= beforeAt).at(-1);
const documentHandoffs = since => handoffs.slice(since).filter(item => item.scenario === scenario && item.resourceType === 'Document');
// Expect an explicit control to exist before using it; absence is a failure, never a pass.
async function requireControl(tab, selector, label, name) {
  const present = await tab.enabled(selector);
  check(label, name, present, { selector, feedback: await tab.text('.cart-feedback'), alerts: await tab.alerts() });
  return present;
}

// Bounding-box, initial visibility, hit-test and real-pointer geometry for the cart's controls.
const CONTROL_SELECTORS = {
  'qty-minus': '[data-qty-line][data-delta="-1"]', 'qty-plus': '[data-qty-line][data-delta="1"]', remove: '.cart-item-side .remove',
  'service-add': '[data-add-service]', 'service-edit': '[data-edit-service]', 'service-remove': '[data-remove-service]',
  'service-confirm': '[data-confirm-service]', 'service-cancel': '[data-cancel-service]', 'wrist-fit': '[data-wrist-fit]',
  'discount-toggle': '[data-discount-toggle]', 'discount-input': '#cart-discount-input', 'discount-apply': '[data-discount-apply]',
  'discount-remove': '[data-remove-discount]', checkout: '[data-checkout]', close: '.cart-head [data-close-cart]'
};
const POINTER_PROBED = new Set(['qty-minus', 'qty-plus', 'checkout', 'discount-apply', 'service-add', 'service-edit', 'service-remove', 'service-confirm', 'remove']);
async function measureControls(tab, kinds = Object.keys(CONTROL_SELECTORS)) {
  const selectors = Object.fromEntries(kinds.map(kind => [kind, CONTROL_SELECTORS[kind]]));
  // Where every control is before anything scrolls.
  const initial = await tab.eval(`(() => { const out = {}; for (const [kind, selector] of Object.entries(${JSON.stringify(selectors)})) {
    out[kind] = [...document.querySelector('.cart-drawer').querySelectorAll(selector)].map(e => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth; }); } return out; })()`);
  const out = await tab.eval(`(() => {
    const selectors = ${JSON.stringify(selectors)};
    const drawer = document.querySelector('.cart-drawer');
    const d = drawer.getBoundingClientRect();
    const interactive = [...drawer.querySelectorAll('button, input, a[href], textarea')];
    const out = [];
    for (const [kind, selector] of Object.entries(selectors)) {
      drawer.querySelectorAll(selector).forEach((element, index) => {
        element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
        const r = element.getBoundingClientRect();
        const probe = (x, y) => { const hit = document.elementFromPoint(x, y); return !!hit && (hit === element || element.contains(hit)); };
        const inset = Math.min(3, r.width / 4, r.height / 4);
        const points = { centre: [r.left + r.width / 2, r.top + r.height / 2], left: [r.left + inset, r.top + r.height / 2],
          right: [r.right - inset, r.top + r.height / 2], top: [r.left + r.width / 2, r.top + inset], bottom: [r.left + r.width / 2, r.bottom - inset] };
        const missed = Object.entries(points).filter(([, [x, y]]) => x < 0 || y < 0 || x >= innerWidth || y >= innerHeight || !probe(x, y)).map(([name]) => name);
        const hitBy = missed.map(name => { const hit = document.elementFromPoint(...points[name]); return hit ? name + ':' + hit.tagName.toLowerCase() + (hit.className ? '.' + String(hit.className).split(' ')[0] : '') : name + ':none'; });
        const overlaps = interactive.filter(other => other !== element && !other.contains(element) && !element.contains(other) && (() => {
          const b = other.getBoundingClientRect(); return b.width && b.height && b.left < r.right - 0.5 && b.right > r.left + 0.5 && b.top < r.bottom - 0.5 && b.bottom > r.top + 0.5; })())
          .map(other => other.getAttribute('aria-label') || other.textContent.trim().slice(0, 30));
        const info = element.closest('.cart-item-info')?.getBoundingClientRect();
        out.push({ kind, index, selector, width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10, missed, hitBy, overlaps,
          centre: points.centre, edges: points, disabled: !!element.disabled,
          insideDrawer: r.left >= d.left - 0.5 && r.right <= d.right + 0.5, inViewport: r.top >= 0 && r.bottom <= innerHeight,
          beyondColumn: info ? Math.max(0, Math.round((r.right - info.right) * 10) / 10) : 0 });
      });
    }
    return out;
  })()`);
  for (const control of out) {
    control.initiallyVisible = initial[control.kind]?.[control.index] ?? false;
    if (!POINTER_PROBED.has(control.kind) || control.disabled) continue;
    // Real pointer input at the centre and at both side edges, after scrolling the control into view.
    await tab.eval(`document.querySelectorAll(${JSON.stringify(control.selector)})[${control.index}].scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })`);
    const box = await tab.eval(`(() => { const r = document.querySelectorAll(${JSON.stringify(control.selector)})[${control.index}].getBoundingClientRect(); const i = Math.min(3, r.width / 4);
      return [[r.left + r.width / 2, r.top + r.height / 2], [r.left + i, r.top + r.height / 2], [r.right - i, r.top + r.height / 2]]; })()`);
    control.pointerMissed = [];
    for (const [name, [x, y]] of [['centre', box[0]], ['left', box[1]], ['right', box[2]]]) {
      if (!await tab.probeTap(control.selector, control.index, x, y)) control.pointerMissed.push(name);
    }
  }
  return out;
}
const overflowReport = tab => tab.eval(`(() => {
  const drawer = document.querySelector('.cart-drawer'), body = document.querySelector('.cart-body'), foot = document.querySelector('.cart-foot');
  const d = drawer.getBoundingClientRect();
  // Visually hidden text is clipped to 1px by design and cannot cause overflow.
  const wide = [...drawer.querySelectorAll('*')].filter(e => !e.closest('.visually-hidden')).filter(e => { const r = e.getBoundingClientRect(); return r.width && (r.right > d.right + 0.5 || r.left < d.left - 0.5); })
    .slice(0, 5).map(e => e.className || e.tagName);
  return { drawer: drawer.scrollWidth - drawer.clientWidth, body: body ? body.scrollWidth - body.clientWidth : 0,
    foot: foot ? foot.scrollWidth - foot.clientWidth : 0, page: document.documentElement.scrollWidth - innerWidth, wide,
    drawerRight: Math.round(d.right), innerWidth };
})()`);

// A real tap on Apply while a quantity update's response is held (the cart is at quantity 2). `typed` is
// exactly what the shopper types (the storefront trims it); `failDiscount` arms a fault on the discount write;
// `forgeDiscount` (1M) answers it with another cart ('unrelated'), a blank ID, an omitted ID or no cart;
// `forgeMode` 'dry-run' commits nothing, 'commit-then-substitute' (1N) commits it first. `expectGate`
// 'reject' (1N) is for a shim that misreports the outcome: the gate must reject it.
async function busyApplyFlow(tab, { typed = 'SYNTH10', failDiscount = null, forgeDiscount = null, forgeMode = 'dry-run', expectGate = 'accept' } = {}) {
  await typeDiscount(tab, typed);
  if (failDiscount) await control('failNext', { operation: 'UpdateDiscountCodes', ...failDiscount });
  if (forgeDiscount) await control('forgeNext', { operation: 'UpdateDiscountCodes', cart: forgeDiscount, mode: forgeMode });
  const { id } = await control('hold', { operation: 'UpdateLines', phase: 'after' });
  await tab.tap('[data-qty-line][data-delta="-1"]');
  const held = await control('awaitHeld', { id });
  check('harness', 'quantity update is held', held.arrived);
  check('baseline', 'busy cart disables quantity, remove and checkout', await tab.eval(`[...document.querySelectorAll('[data-qty-line], .cart-item-side .remove, [data-checkout], [data-add-service], [data-wrist-fit]')].every(b => b.disabled)`));
  // Every change to the discount message, cart announcer, cart feedback and checkout status, with the
  // browser's time, so feedback can be ordered against the mock's commit times (same host clock).
  await tab.eval(`(() => { window.__feedback = []; let last = null;
    const read = () => ['#cart-discount-message', '[data-cart-announcer]', '.cart-feedback', '.checkout-status'].map(selector => document.querySelector(selector)?.textContent.trim() || '').join(' | ');
    const record = () => { const text = read(); if (text !== last) { last = text; window.__feedback.push({ at: Date.now(), text }); } };
    record(); window.__feedbackObserver?.disconnect();
    window.__feedbackObserver = new MutationObserver(record); window.__feedbackObserver.observe(document, { subtree: true, childList: true, characterData: true }); })()`);
  const applyEnabled = await tab.enabled('[data-discount-apply]');
  const discountWrites = (await mutations('UpdateDiscountCodes')).length;
  const dispatchStart = browserRequests.length, handoffStart = handoffs.length;
  if (applyEnabled) await tab.tap('[data-discount-apply]');
  await sleep(300);
  const atTap = { applyEnabled, message: await discountMessage(tab), alerts: await tab.alerts(), applyLabel: await tab.text('[data-discount-apply]') };
  await control('release', { id });
  await tab.settled(15000);
  await sleep(300);
  const heldEntry = (await requestLog()).find(entry => entry.seq === held.seq);
  const writes = (await mutations('UpdateDiscountCodes')).slice(discountWrites);
  const cartId = await storedCartId(tab);
  const stored = await serverCart(cartId);
  // Membership and applicability are separate facts from the mock's own cart (1L).
  const codes = stored.discountCodes, codeStates = stored.discountApplicability;
  const events = await tab.eval(`(window.__feedbackObserver?.disconnect(), window.__feedback || [])`);
  const storefront = await cartProbe(tab);
  const dispatches = browserRequests.slice(dispatchStart).filter(request => request.mutation);
  const uncertainty = { dispatches, journal: storefront.journal, refresh: storefront.refresh, checkout: storefront.checkout,
    apply: storefront.apply, navigation: documentHandoffs(handoffStart).length };
  const injection = await tab.eval('window.__falseDiscountSuccess ?? null');
  observe('busy Apply', { storefront, authoritative: stored, uncertainty, injection, fault: { failDiscount, forgeDiscount, forgeMode }, atTap, held: heldEntry && { seq: heldEntry.seq, finishedAt: heldEntry.finishedAt }, writes, codes, codeStates, message: await discountMessage(tab), events });
  // 1N: the fixture's own record of a forged write: one write, committed (with the saved state and the
  // cart ID it would have returned, recorded before substitution) or not, and the cart still holding that state.
  if (forgeDiscount) {
    const [write] = writes, committed = forgeMode === 'commit-then-substitute';
    const returned = { unrelated: 'gid://shopify/Cart/999999?key=k999999', blank: '', omitted: null, absent: null }[forgeDiscount];
    const savedKeys = (write?.committedState?.discountCodes || []).map(codeKey);
    check('harness', `fixture: one ${committed ? 'committed' : 'uncommitted'} discount write answered with a ${forgeDiscount} cart`, writes.length === 1 && write.forged === forgeDiscount && write.forgeMode === forgeMode &&
      write.returnedCartId === returned && (committed
        ? write.outcome === 'committed-response-substituted' && Number.isInteger(write.commitSeq) && write.committedReturnedCartId === cartId && same(savedKeys, [codeKey(typed)])
        : write.outcome === 'response-forged' && write.commitSeq === undefined && write.committedState === undefined),
    { writes: writes.map(item => ({ seq: item.seq, outcome: item.outcome, forged: item.forged, forgeMode: item.forgeMode, commitSeq: item.commitSeq, returnedCartId: item.returnedCartId, committedReturnedCartId: item.committedReturnedCartId, committedState: item.committedState?.discountApplicability })) });
    check('harness', `fixture: the saved cart holds ${committed ? 'exactly the committed code' : 'no code'}`, same((codes || []).map(codeKey), committed ? [codeKey(typed)] : []), { codes, codeStates });
  }
  const verdicts = busyApplyGate({ applyEnabled, cartId, held: { seq: heldEntry?.seq ?? Infinity, finishedAt: heldEntry?.finishedAt ?? Infinity }, writes, codes, codeStates, message: await discountMessage(tab), events, code: typed, uncertainty });
  if (expectGate === 'reject') {
    const injectionObserved = injection &&
      injection.at >= writes[0]?.finishedAt && normalizeCopy(injection.after) === normalizeCopy(`${typed.trim()} applied.`) &&
      events.some(event => normalizeCopy(discountMessageOf(event)) === normalizeCopy(injection.after));
    if (applicationContract === 'combined') check('harness', 'false-success injection replaced the catch feedback after the response settled', injectionObserved, injection);
    check('harness', 'rejects: the busy-Apply outcome as the shim reported it', injectionObserved && verdicts.some(item => !item.pass && item.name === 'no success claim comes before the discount write committed'),
      { failing: verdicts.filter(item => !item.pass).map(item => item.name), facts: verdicts[0].detail.facts });
  }
  else emit(verdicts);
}
// Test-only page shims standing in for the two correct busy-Apply behaviours.
// (A) Apply and the code field are disabled whenever the cart is busy.
const DISABLE_APPLY_WHILE_BUSY = `(() => { const sync = () => { if (!document.querySelector('.cart-body[aria-busy="true"]')) return;
  for (const control of document.querySelectorAll('[data-discount-apply], #cart-discount-input')) control.disabled = true; };
  new MutationObserver(sync).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-busy'] }); })();`;
// (B) Apply stays enabled; a submission made while the cart is busy is queued and replayed once it is not.
const QUEUE_APPLY_WHILE_BUSY = `(() => { const busy = () => !!document.querySelector('.cart-body[aria-busy="true"]');
  // Override only the test input while the competing quantity operation runs. The capture
  // listener consumes the intent, and its replay still goes through the real storefront.
  const enableTestInput = () => {
    if (!busy()) return;
    for (const control of document.querySelectorAll('[data-discount-apply]:disabled, #cart-discount-input:disabled')) control.disabled = false;
  };
  new MutationObserver(enableTestInput).observe(document, { subtree: true, childList: true });
  const queue = event => { if (!busy() || event.target.closest('[data-harness-replay]')) return; if (!event.target.closest('[data-discount-apply], [data-discount-form]')) return;
    event.preventDefault(); event.stopImmediatePropagation(); if (document.documentElement.dataset.harnessQueued) return;
    document.documentElement.dataset.harnessQueued = '1';
    (async () => { while (busy()) await new Promise(resolve => setTimeout(resolve, 40));
      await new Promise(resolve => requestAnimationFrame(() => resolve())); delete document.documentElement.dataset.harnessQueued;
      const apply = document.querySelector('[data-discount-apply]'); if (apply) { apply.setAttribute('data-harness-replay', ''); apply.click(); } })(); };
  document.addEventListener('click', queue, true); document.addEventListener('submit', queue, true); })();`;
// 1N, test-only and wrong on purpose: replaces the discount catch copy with a success claim for the typed code.
const CLAIM_SUCCESS_AFTER_CATCH = `(() => {
  const catchMessages = ${JSON.stringify([...CATCH_TEMPLATES.map(template => template.text), UNCERTAIN_COPY])};
  const fix = () => {
    const field = document.querySelector('#cart-discount-message');
    const before = field?.textContent.trim().replace(/'/g, '’');
    if (!catchMessages.includes(before)) return;
    const after = document.querySelector('#cart-discount-input').value.trim() + ' applied.';
    window.__falseDiscountSuccess = { before, after, at: Date.now() };
    field.textContent = after;
  };
  new MutationObserver(fix).observe(document, { subtree: true, childList: true, characterData: true });
})();`;
const busyApplyScenario = async (options = {}) => {
  const tab = await openTab('A');
  await addTrainer(tab, 'black');
  await tab.tap('[data-qty-line][data-delta="1"]');
  await tab.settled();
  await busyApplyFlow(tab, options);
};

// ---- Scenarios ----
const scenarios = [];
const define = (name, run, { mock = {}, deadlineMs = 120000, init = '', selfTest = false } = {}) => scenarios.push({ name, run, mock, deadlineMs, init, selfTest });
// Test-only page shim: every cart operation takes the storefront's cart lock exclusively instead of
// shared, so operations from different tabs run one after another. It stands in for a correct
// serialized implementation, to prove the race gates pass one (production code is unchanged).
const SERIALIZE_CART_LOCK = `(() => { const locks = navigator.locks; if (!locks) return; const request = locks.request.bind(locks);
  locks.request = (name, options, callback) => typeof options === 'function' ? request(name, options) : request(name, { ...options, mode: 'exclusive' }, callback); })();`;
// Test-only page shim for the +1 positive self-test: a stepper tap that finds the cart lock taken
// waits for it, waits until this tab shows the cart the other tab just changed, and only then
// replays the tap, so its +1 applies to fresh state. It stands in for a correctly queued and rebased
// implementation; it cannot make a lost update pass, because the gate still checks Shopify's result.
const QUEUE_AND_REBASE_STEPPER = `(() => { const NAME = 'anawin-shopify-cart-recovery';
  const wait = async (test, ms) => { const end = Date.now() + ms; while (Date.now() < end && !test()) await new Promise(resolve => setTimeout(resolve, 40)); return test(); };
  document.addEventListener('click', event => {
    const button = event.target.closest && event.target.closest('[data-qty-line]');
    if (!button || button.dataset.harnessReplay || !navigator.locks) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const line = button.dataset.qtyLine, delta = button.dataset.delta;
    const find = () => [...document.querySelectorAll('[data-qty-line]')].find(item => item.dataset.qtyLine === line && item.dataset.delta === delta);
    const shown = () => document.querySelector('.quantity span') && document.querySelector('.quantity span').textContent;
    const ready = () => { const item = find(); return !!item && !item.disabled && !document.querySelector('.cart-body[aria-busy]'); };
    const stale = shown();
    document.documentElement.dataset.harnessQueued = '1';
    const replay = () => { delete document.documentElement.dataset.harnessQueued; const fresh = find(); if (fresh) { fresh.dataset.harnessReplay = '1'; fresh.click(); } };
    navigator.locks.request(NAME, { mode: 'exclusive', ifAvailable: true }, lock => !!lock).then(free => free ? replay() :
      navigator.locks.request(NAME, { mode: 'exclusive' }, () => {}).then(async () => {
        // Rebase: take this tab to Shopify's current cart (Check cart when it asks for review), then tap.
        await wait(() => shown() !== stale || document.querySelector('[data-refresh-cart]:not([disabled])'), 5000);
        const check = document.querySelector('[data-refresh-cart]:not([disabled])');
        if (check) check.click();
        await wait(() => ready() && shown() !== stale, 5000);
        replay(); }));
  }, true); })();`;
// A race gate, plus the same scenario against a correct stand-in implementation as a harness self-test.
const defineRace = (name, run, options = {}, init = SERIALIZE_CART_LOCK, kind = 'serialized storefront') => {
  define(name, run, options);
  define(`${name} [harness self-test: ${kind}]`, run, { ...options, init, selfTest: true });
};

// The smallest cart selection the fixture accepts (its CART_SHAPE), for self-tests that drive it directly.
const FIXTURE_SELECTION = 'cart { id checkoutUrl parentRelationship discountCodes { code applicable } discountApplications { code } cost { subtotalAmount { amount currencyCode } totalAmount { amount currencyCode } } discountAllocations(lineLevelOnly: false) attributes { key value } canUpdateQuantity } userErrors { message }';
// Known-good and known-bad outcomes fed straight into the gates and the pairing helper. If a gate
// accepted a bad outcome (or rejected a good one) the suite could not be trusted as Task 2's gate.
define('harness self-test: gates reject false passes and accept correct outcomes', async () => {
  // +1 cases that do not supply the mock's own commit log get one derived from their writes: each write
  // is tagged (as the CDP layer tags real requests) and every committed write appears once in the log.
  const withCommitLog = observation => {
    if ('committedLog' in observation) return observation;
    const actions = observation.actions.map(action => ({ ...action, writes: action.writes.map((write, index) => ({ ...write, tag: write.tag ?? `${action.tab}-synthetic-${index + 1}` })) }));
    const committedLog = actions.flatMap(action => action.writes).filter(write => /^committed/.test(write.outcome || '') || Number.isFinite(write.commitSeq))
      .map(write => ({ operation: write.operation ?? 'UpdateLines', tag: write.tag, cartId: write.cartId, lines: write.lines, lineIds: write.lineIds, outcome: write.outcome, commitSeq: write.commitSeq }));
    return { ...observation, actions, committedLog };
  };
  // 1M: the real mock records each commit's cartBefore, effects and cartAfter. Pre-1M controls describe a
  // commit by its request only, so their evidence comes from replaying those requests, in commit order,
  // on the real fixture (createStorefrontMock), from the race's starting cart: BR16 p1 x1 with its service
  // s1 x1, plus one unrelated OB16 line for each other line ID a case names (x7, p9, ...). No second
  // effect calculation is involved: the fixture's own snapshots and effects are attached, with its line
  // IDs mapped back to the case's. An entry marked `asWritten` keeps exactly the evidence the case wrote
  // (deliberately absent, partial or forged), and a case whose request the fixture rejects is an error.
  const fixtureEvidence = log => {
    if (!Array.isArray(log)) return log;
    const committedLine = entry => entry.cartId === 'cart' && !entry.asWritten && ['UpdateLines', 'RemoveLines', 'AddLines'].includes(entry.operation ?? 'UpdateLines') &&
      (/^committed/.test(entry.outcome || '') || Number.isFinite(entry.commitSeq));
    const order = log.map((entry, index) => ({ entry, index })).filter(({ entry }) => committedLine(entry))
      .sort((a, b) => (Number.isFinite(a.entry.commitSeq) ? a.entry.commitSeq : Infinity) - (Number.isFinite(b.entry.commitSeq) ? b.entry.commitSeq : Infinity) || a.index - b.index);
    if (!order.length) return log;
    const named = order.flatMap(({ entry }) => [...(entry.lines || []).flatMap(line => [line.id, line.parent?.lineId]), ...(entry.lineIds || [])]);
    const others = [...new Set(named.filter(id => id && !['p1', 's1'].includes(id)))];
    const mock = createStorefrontMock({ checkoutHost: 'checkout.invalid' });
    const { cart } = mock.execute(`mutation CreateCart($input: CartInput!) { cartCreate(input: $input) { ${FIXTURE_SELECTION} } }`, { input: { lines: [
      { merchandiseId: serviced.merchandiseId, quantity: 1, attributes: serviced.attributes },
      { merchandiseId: TRAINER_SERVICE_VARIANT, quantity: 1, attributes: service.attributes, parent: { merchandiseId: serviced.merchandiseId } },
      ...others.map(alias => ({ merchandiseId: 'gid://variant/ob16', quantity: 1, attributes: [{ key: '_anawin_service', value: 'none' }, { key: '_harness_alias', value: alias }] }))] } }).cartCreate;
    const start = mock.cart(cart.id).lines;
    const toFixture = new Map([['p1', start.find(line => line.merchandiseId === serviced.merchandiseId).id], ['s1', start.find(line => line.parentId).id],
      ...others.map(alias => [alias, start.find(line => line.attributes.some(item => item.key === '_harness_alias' && item.value === alias)).id])]);
    const toCase = new Map([...toFixture].map(([alias, id]) => [id, alias]));
    const back = id => id == null ? id : toCase.get(id) ?? id;
    const backLine = line => line && { ...line, id: back(line.id), parentId: back(line.parentId) };
    const replayed = new Map();
    for (const { entry, index } of order) {
      const operation = entry.operation ?? 'UpdateLines';
      const variables = { cartId: cart.id };
      if (operation === 'RemoveLines') variables.lineIds = (entry.lineIds || []).map(id => toFixture.get(id) ?? id);
      else variables.lines = (entry.lines || []).map(line => operation === 'AddLines'
        ? { merchandiseId: line.merchandiseId, quantity: line.quantity, ...(line.attributes ? { attributes: line.attributes } : {}), ...(line.parent ? { parent: line.parent.lineId ? { lineId: toFixture.get(line.parent.lineId) ?? line.parent.lineId } : { merchandiseId: line.parent.merchandiseId } } : {}) }
        : { id: toFixture.get(line.id) ?? line.id, ...(line.quantity !== undefined ? { quantity: line.quantity } : {}), ...(Array.isArray(line.attributes) && typeof line.attributes[0] === 'object' ? { attributes: line.attributes } : {}) });
      const data = mock.execute(`mutation ${operation}($cartId: ID!) { x(cartId: $cartId) { ${FIXTURE_SELECTION} } }`, variables);
      const errors = Object.values(data)[0].userErrors;
      if (errors.length) throw new Error(`fixtureEvidence: the fixture rejected a committed case entry (${operation} ${JSON.stringify(entry.lines || entry.lineIds)}): ${errors.map(item => item.message).join(' ')}`);
      const recorded = mock.lastEffects();
      replayed.set(index, { cartBefore: recorded.cartBefore.map(backLine), cartAfter: recorded.cartAfter.map(backLine),
        effects: recorded.lines.map(effect => ({ ...effect, id: back(effect.id), previousId: back(effect.previousId), before: backLine(effect.before), after: backLine(effect.after) })) });
    }
    return log.map((entry, index) => replayed.has(index) ? { ...entry, ...replayed.get(index) } : entry);
  };
  const prepared = observation => { const withLog = withCommitLog(observation); return { ...withLog, committedLog: fixtureEvidence(withLog.committedLog) }; };
  const expect = (gate, label, observation, wanted) => {
    const verdicts = gate(gate === plusOneGate ? prepared(observation) : observation);
    const accepted = verdicts.every(item => item.pass);
    check('harness', `${wanted === 'accept' ? 'accepts' : 'rejects'}: ${label}`, accepted === (wanted === 'accept'), { failing: verdicts.filter(item => !item.pass).map(item => item.name) });
  };
  const none = [{ key: '_anawin_service', value: 'none' }];
  const BR16 = { merchandiseId: 'gid://variant/br16', quantity: 1, attributes: none };
  const OB16 = { merchandiseId: 'gid://variant/ob16', quantity: 1, attributes: none };
  const row = (id, item, extra = {}) => ({ id, handle: item.merchandiseId.split('/').at(-1), merchandiseId: item.merchandiseId, quantity: item.quantity, parentId: null, attributes: item.attributes, ...extra });
  const refused = { refused: true }, silent = { refused: false };
  const intents = (br16 = {}, ob16 = {}) => [{ name: 'BR16', expected: BR16, claimed: null, refusal: silent, ...br16 }, { name: 'OB16', expected: OB16, claimed: null, refusal: silent, ...ob16 }];
  const cart = (id, ...lines) => ({ id, lines });
  // First add.
  expect(firstAddGate, 'both gloves once in the one active cart', { intents: intents(), activeCartId: 'c1', carts: [cart('c1', row('l1', BR16), row('l2', OB16))] }, 'accept');
  expect(firstAddGate, 'BR16 refused by name before anything was committed', { intents: intents({ refusal: refused }), activeCartId: 'c1', carts: [cart('c1', row('l2', OB16))] }, 'accept');
  expect(firstAddGate, 'a duplicate empty-handed orphan is harmless only if it holds nothing', { intents: intents(), activeCartId: 'c1', carts: [cart('c1', row('l1', BR16), row('l2', OB16)), cart('c2')] }, 'accept');
  expect(firstAddGate, 'BR16 stranded in an orphan cart with only generic warnings', { intents: intents(), activeCartId: 'c1', carts: [cart('c1', row('l2', OB16)), cart('c2', row('l1', BR16))] }, 'reject');
  expect(firstAddGate, 'BR16 refused by name but already committed to an orphan cart', { intents: intents({ refusal: refused }), activeCartId: 'c1', carts: [cart('c1', row('l2', OB16)), cart('c2', row('l1', BR16))] }, 'reject');
  expect(firstAddGate, 'BR16 announced as added but missing from the active cart', { intents: intents({ claimed: 'BR16 added to cart.' }), activeCartId: 'c1', carts: [cart('c1', row('l2', OB16))] }, 'reject');
  expect(firstAddGate, 'BR16 twice in the active cart', { intents: intents(), activeCartId: 'c1', carts: [cart('c1', row('l1', { ...BR16, quantity: 2 }), row('l2', OB16))] }, 'reject');
  expect(firstAddGate, 'BR16 added with another configuration', { intents: intents(), activeCartId: 'c1', carts: [cart('c1', row('l1', { ...BR16, attributes: [{ key: '_anawin_service', value: 'break-in' }] }), row('l2', OB16))] }, 'reject');
  expect(firstAddGate, 'BR16 refused by name yet present in the active cart', { intents: intents({ refusal: refused }), activeCartId: 'c1', carts: [cart('c1', row('l1', BR16), row('l2', OB16))] }, 'reject');
  expect(firstAddGate, 'recovery drops OB16', { intents: intents(), activeCartId: 'c1', carts: [cart('c1', row('l1', BR16), row('l2', OB16))],
    recovery: { before: configuration([row('l1', BR16), row('l2', OB16)]), after: configuration([row('l3', BR16)]) } }, 'reject');
  expect(firstAddGate, 'recovery duplicates BR16', { intents: intents(), activeCartId: 'c1', carts: [cart('c1', row('l1', BR16), row('l2', OB16))],
    recovery: { before: configuration([row('l1', BR16), row('l2', OB16)]), after: configuration([row('l3', { ...BR16, quantity: 2 }), row('l4', OB16)]) } }, 'reject');
  // Refusal classification.
  const refusalCase = (label, input, wanted) => check('harness', `${wanted ? 'counts' : 'does not count'} as a refusal: ${label}`, classifyRefusal(input).refused === wanted, classifyRefusal(input));
  refusalCase('fresh, names BR16, says not added, retry available', { item: 'BR16', action: 'add', before: [], after: ['BR16 wasn’t added. Add it again.'], actionable: true }, true);
  refusalCase('generic "your cart changed in another tab"', { item: 'BR16', action: 'add', before: [], after: ['Your cart changed in another tab. Check your cart before checkout.'], actionable: true }, false);
  refusalCase('the same specific message already shown before the action (stale)', { item: 'BR16', action: 'add', before: ['BR16 wasn’t added. Add it again.'], after: ['BR16 wasn’t added. Add it again.'], actionable: true }, false);
  refusalCase('names another glove', { item: 'BR16', action: 'add', before: [], after: ['OB16 wasn’t added.'], actionable: true }, false);
  refusalCase('specific and fresh, but no way to retry', { item: 'BR16', action: 'add', before: [], after: ['BR16 wasn’t added.'], actionable: false }, false);
  // +1.
  const serviced = { id: 'p1', handle: 'br16', merchandiseId: 'gid://variant/br16', quantity: 1, parentId: null, attributes: sortAttributes([{ key: '_anawin_service', value: 'break-in' },
    { key: '_anawin_break_in_level', value: 'Firm (40%)' }, { key: '_anawin_wearing_style', value: 'Traditional' }]) };
  const service = { id: 's1', handle: 'break-in', merchandiseId: TRAINER_SERVICE_VARIANT, quantity: 1, parentId: 'p1', attributes: sortAttributes([{ key: 'Break-In Level', value: 'Firm (40%)' }, { key: 'Glove Wearing Style', value: 'Traditional' }]) };
  const [initial] = gloves([serviced, service]);
  const at = (glove, child = glove, extra = {}) => [{ ...serviced, quantity: glove, ...extra }, { ...service, quantity: child }];
  // A correlated write in the correlator's shape: the submitted lines and the cart state the mock returned.
  // Unless a case says otherwise, synthetic writes commit in the order they are built (1I: commitSeq).
  let synthCommit = 0;
  const write = (requested, { lineId = 'p1', resultQuantity = requested, ...extra } = {}) => ({ outcome: 'committed', status: 200, userErrors: [], cartId: 'cart',
    lines: [{ id: lineId, quantity: requested }], resultLines: [{ id: lineId, quantity: resultQuantity }], commitSeq: ++synthCommit, ...extra });
  const act = (tab, refusal = silent, writes = [write(tab === 'A' ? 2 : 3)]) => ({ tab, refusal, writes });
  expect(plusOneGate, 'two accepted taps end at 3 with the service at 3', { name: 'BR16', initial, cartId: 'cart', finalLines: at(3), actions: [act('A'), act('B')] }, 'accept');
  expect(plusOneGate, 'one tap refused by name, ending at 2', { name: 'BR16', initial, cartId: 'cart', finalLines: at(2), actions: [act('A'), act('B', refused, [])] }, 'accept');
  expect(plusOneGate, 'lost update: both accepted, ending at 2', { name: 'BR16', initial, cartId: 'cart', finalLines: at(2), actions: [act('A'), act('B')] }, 'reject');
  expect(plusOneGate, 'quantity 3 but the service stayed at 2', { name: 'BR16', initial, cartId: 'cart', finalLines: at(3, 2), actions: [act('A'), act('B')] }, 'reject');
  expect(plusOneGate, 'quantity 3 on a glove whose choices changed', { name: 'BR16', initial, cartId: 'cart', finalLines: [{ ...serviced, quantity: 3, attributes: sortAttributes([...serviced.attributes.filter(item => item.key !== '_anawin_break_in_level'), { key: '_anawin_break_in_level', value: 'Game Ready (90%)' }]) }, { ...service, quantity: 3 }], actions: [act('A'), act('B')] }, 'reject');
  expect(plusOneGate, 'a tap refused by name that was applied anyway (3)', { name: 'BR16', initial, cartId: 'cart', finalLines: at(3), actions: [act('A'), act('B', refused)] }, 'reject');
  expect(plusOneGate, 'an accepted tap that never reached Shopify', { name: 'BR16', initial, cartId: 'cart', finalLines: at(3), actions: [act('A'), act('B', silent, [{ outcome: 'failed-before-commit' }])] }, 'reject');
  // Discounts.
  const apply = (claimed, refusal = silent) => ({ tab: 'A', kind: 'apply', code: 'SYNTH5', claimed, refusal });
  const remove = (claimed, refusal = silent) => ({ tab: 'B', kind: 'remove', code: 'SYNTH10', claimed, refusal });
  expect(discountGate, 'both changes confirmed and both in Shopify', { start: ['SYNTH10'], final: ['SYNTH5'], actions: [apply(true), remove(true)] }, 'accept');
  expect(discountGate, 'apply refused by name, removal confirmed', { start: ['SYNTH10'], final: [], actions: [apply(false, refused), remove(true)] }, 'accept');
  expect(discountGate, 'both confirmed but the removal was lost', { start: ['SYNTH10'], final: ['SYNTH10', 'SYNTH5'], actions: [apply(true), remove(true)] }, 'reject');
  expect(discountGate, 'both confirmed but the apply was lost', { start: ['SYNTH10'], final: [], actions: [apply(true), remove(true)] }, 'reject');
  expect(discountGate, 'confirmed and refused at once', { start: ['SYNTH10'], final: ['SYNTH5'], actions: [apply(true, refused), remove(true)] }, 'reject');
  expect(discountGate, 'neither confirmed nor refused', { start: ['SYNTH10'], final: ['SYNTH10'], actions: [apply(false), remove(false)] }, 'reject');
  // Pairing.
  const pairing = (label, lines, wanted) => check('harness', `pairing helper ${wanted ? 'accepts' : 'rejects'}: ${label}`, !pairingIssues(lines).length === wanted, pairingIssues(lines));
  const options = { type: 'full-size', wearingStyle: fullSizeBreakInService.wearingStyles[0], closure: fullSizeBreakInService.closurePoints[0],
    thumbShape: 'None', pinkyShape: 'Recommend for me', fingerShape: 'Recommend for me', firmness: fullSizeBreakInService.firmness[0], notes: 'Synthetic' };
  const mi26 = { id: 'm1', handle: 'mi26', merchandiseId: 'gid://variant/mi26-left', quantity: 1, parentId: null, attributes: [{ key: '_anawin_service', value: 'break-in' },
    { key: '_anawin_service_type', value: 'full-size' }, { key: FULL_SIZE_CONFIGURATION_KEY, value: fullSizeConfiguration(options) }] };
  const mi26Service = { id: 'm2', handle: 'full-size-glove-break-in-service', merchandiseId: FULL_SIZE_SERVICE_VARIANT, quantity: 1, parentId: 'm1',
    attributes: [...serviceAttributes(options), { key: 'Glove Model', value: 'MI26' }, { key: 'Throwing Hand', value: 'Left' }] };
  const cl16 = { id: 'c1', handle: 'cl16', merchandiseId: 'gid://variant/cl16', quantity: 1, parentId: null, attributes: none };
  pairing('a trainer glove and its service', [serviced, service], true);
  pairing('a left-hand MI26 and its full-size service', [mi26, mi26Service], true);
  pairing('trainer glove with the full-size service variant', [serviced, { ...service, merchandiseId: FULL_SIZE_SERVICE_VARIANT }], false);
  pairing('trainer service that lost its Break-In Level', [serviced, { ...service, attributes: service.attributes.filter(item => item.key !== 'Break-In Level') }], false);
  pairing('service choices that differ from the glove\'s', [serviced, { ...service, attributes: sortAttributes([{ key: 'Break-In Level', value: 'Game Ready (90%)' }, { key: 'Glove Wearing Style', value: 'Traditional' }]) }], false);
  pairing('service attached to CL16 instead of its glove', [serviced, cl16, { ...service, parentId: 'c1' }], false);
  pairing('service whose parent line does not exist', [serviced, { ...service, parentId: 'gone' }], false);
  pairing('service quantity differs from the glove', [serviced, { ...service, quantity: 2 }], false);
  pairing('full-size service naming the wrong throw hand', [mi26, { ...mi26Service, attributes: mi26Service.attributes.map(item => item.key === 'Throwing Hand' ? { ...item, value: 'Right' } : item) }], false);
  pairing('full-size service whose shaping no longer matches the glove\'s configuration', [mi26, { ...mi26Service, attributes: mi26Service.attributes.map(item => item.key === 'Thumb Shape' ? { ...item, value: 'Flared' } : item) }], false);
  pairing('full-size service that lost its firmness', [mi26, { ...mi26Service, attributes: mi26Service.attributes.filter(item => item.key !== 'Firmness') }], false);
  pairing('two lines with the same ID', [serviced, { ...service, id: 'p1' }], false);

  // ---- Task 1D controls (added before the gate corrections; kept as permanent regression checks) ----
  // First add: orphans, duplicates and recovery provenance.
  const both = () => [row('l1', BR16), row('l2', OB16)];
  expect(firstAddGate, '1D: nine orphaned BR16 copies beside one correct active copy', { intents: intents(), activeCartId: 'c1', carts: [cart('c1', ...both()), cart('c2', row('l9', { ...BR16, quantity: 9 }))] }, 'reject');
  expect(firstAddGate, '1D: one orphaned duplicate of an accepted glove', { intents: intents(), activeCartId: 'c1', carts: [cart('c1', ...both()), cart('c2', row('l3', OB16))] }, 'reject');
  const recovered = (extra = {}) => ({ sourceId: 'c1', cartId: 'c3', created: ['c3'], before: configuration(both()), after: configuration([row('l5', BR16), row('l6', OB16)]), ...extra });
  expect(firstAddGate, '1D: recovery into a distinct, verified cart (source left as it was)', { intents: intents(), activeCartId: 'c3', carts: [cart('c1', ...both()), cart('c3', row('l5', BR16), row('l6', OB16))], recovery: recovered() }, 'accept');
  expect(firstAddGate, '1D: "recovery" that reuses the source cart', { intents: intents(), activeCartId: 'c1', carts: [cart('c1', ...both())], recovery: recovered({ cartId: 'c1', created: [] }) }, 'reject');
  expect(firstAddGate, '1D: recovery that creates an extra cart', { intents: intents(), activeCartId: 'c3', carts: [cart('c1', ...both()), cart('c3', row('l5', BR16), row('l6', OB16)), cart('c4', row('l7', OB16))], recovery: recovered({ created: ['c3', 'c4'] }) }, 'reject');
  expect(firstAddGate, '1D: recovery whose copy doubles a quantity', { intents: intents(), activeCartId: 'c3', carts: [cart('c1', ...both()), cart('c3', row('l5', { ...BR16, quantity: 2 }), row('l6', OB16))], recovery: recovered({ after: configuration([row('l5', { ...BR16, quantity: 2 }), row('l6', OB16)]) }) }, 'reject');
  expect(firstAddGate, '1D: recovery from a cart that was not the active one', { intents: intents(), activeCartId: 'c3', carts: [cart('c1', ...both()), cart('c2', row('l8', BR16)), cart('c3', row('l5', BR16), row('l6', OB16))], recovery: recovered({ sourceId: 'c2' }) }, 'reject');
  // +1: correlation by tab, cart, line, requested quantity, status and userErrors.
  const plus = (finalLines, a, b) => ({ name: 'BR16', initial, cartId: 'cart', finalLines, actions: [a, b] });
  expect(plusOneGate, '1D: rebased taps request 2 then 3 on the glove line', plus(at(3), act('A', silent, [write(2)]), act('B', silent, [write(3)])), 'accept');
  expect(plusOneGate, '1D: tab B "accepted" only by a write to another cart', plus(at(3), act('A', silent, [write(2), write(3)]), act('B', silent, [write(3, { cartId: 'other-cart', lineId: 'x9' })])), 'reject');
  expect(plusOneGate, '1D: tab B "accepted" by a write that came back with userErrors', plus(at(3), act('A', silent, [write(2), write(3)]), act('B', silent, [write(3, { userErrors: ['The merchandise line was not found.'], resultQuantity: 2 })])), 'reject');
  expect(plusOneGate, '1D: lost update: both taps requested quantity 2', plus(at(3), act('A', silent, [write(2)]), act('B', silent, [write(2)])), 'reject');
  expect(plusOneGate, '1D: tab B "refused" by a warning about a different action ("BR16 was not removed")', plus(at(2), act('A', silent, [write(2)]),
    act('B', classifyRefusal({ item: 'BR16', action: 'increase', before: [], after: ['BR16 was not removed. Try again.'], actionable: true }), [])), 'reject');
  refusalCase('1D: an increase refusal that names BR16 and the quantity', { item: 'BR16', action: 'increase', before: [], after: ['BR16 quantity wasn’t updated. Try again.'], actionable: true }, true);
  refusalCase('1D: "BR16 was not removed" offered as an increase refusal', { item: 'BR16', action: 'increase', before: [], after: ['BR16 was not removed. Try again.'], actionable: true }, false);
  refusalCase('1D: "BR16 was not added" offered as an increase refusal', { item: 'BR16', action: 'increase', before: [], after: ['BR16 wasn’t added.'], actionable: true }, false);
  // Pairing: standalone services and wrong child identity.
  pairing('1D: a standalone trainer service line, even marked none', [{ ...service, parentId: null, attributes: none }], false);
  pairing('1D: a standalone full-size service line', [{ ...mi26Service, parentId: null }], false);
  pairing('1D: a glove variant attached as the "service" child', [serviced, { ...service, handle: 'ob16', merchandiseId: 'gid://variant/ob16' }], false);
  // Interrupted split recovery: both BR16 configurations with their own services.
  const trad = { ...serviced, id: 'p1', quantity: 1 };
  const tip = { ...serviced, id: 'p2', quantity: 1, attributes: sortAttributes([...serviced.attributes.filter(item => item.key !== '_anawin_wearing_style'), { key: '_anawin_wearing_style', value: 'Two in the Pinky (TIP)' }]) };
  const svc = (parent, style) => ({ ...service, id: `s-${parent.id}`, parentId: parent.id, quantity: parent.quantity, attributes: sortAttributes([{ key: 'Break-In Level', value: 'Firm (40%)' }, { key: 'Glove Wearing Style', value: style }]) });
  const beforeSplit = [{ ...serviced, quantity: 2 }, { ...service, quantity: 2 }];
  const intended = [trad, svc(trad, 'Traditional'), tip, svc(tip, 'Two in the Pinky (TIP)')];
  const splitCase = (label, recoveredLines, wanted) => expect(splitRecoveryGate, label, { beforeLines: beforeSplit, intendedLines: intended, recoveredLines }, wanted);
  splitCase('1D: recovery keeps the original two serviced gloves', beforeSplit.map(line => ({ ...line, id: `r-${line.id}`, parentId: line.parentId && `r-${line.parentId}` })), 'accept');
  splitCase('1D: recovery keeps the intended split, each glove with its own service', intended, 'accept');
  splitCase('1D: recovery drops the TIP glove\'s service', [trad, svc(trad, 'Traditional'), { ...tip, attributes: sortAttributes([{ key: '_anawin_service', value: 'none' }]) }], 'reject');
  splitCase('1D: recovery keeps two gloves but loses the TIP instructions', [trad, svc(trad, 'Traditional'), { ...trad, id: 'p3' }, svc({ ...trad, id: 'p3' }, 'Traditional')], 'reject');
  // Checkout: the final read, its cart, status and URL, and a relevant fresh refusal.
  const injected = /^https:\/\/checkout\.example\.test\/checkouts\//;
  const read = (seq, url, extra = {}) => ({ seq, operation: 'Cart', cartId: 'cart', status: 200, checkoutUrl: url, ...extra });
  const urlCase = (label, observation, wanted) => expect(invalidUrlGate, label, { label: 'foreign URL (final read)', pattern: injected, offered: true, alertsBefore: [], activeCartId: 'cart', ...observation }, wanted);
  const refusalText = 'We couldn’t open secure checkout. Check your cart and try again.';
  urlCase('1D: the final read returned the injected URL and the URL refusal followed', { reads: [read(1, 'https://ignvv0-zh.myshopify.com/checkouts/1'), read(2, 'https://checkout.example.test/checkouts/1')], alertsAfter: [refusalText] }, 'accept');
  urlCase('1D: the injected URL came from an earlier read, the final read was valid', { reads: [read(1, 'https://checkout.example.test/checkouts/1'), read(2, 'https://ignvv0-zh.myshopify.com/checkouts/1')], alertsAfter: [refusalText] }, 'reject');
  urlCase('1D: the injected URL was returned for a different cart', { reads: [read(2, 'https://checkout.example.test/checkouts/9', { cartId: 'other-cart' })], alertsAfter: [refusalText] }, 'reject');
  urlCase('1D: the final read failed (HTTP 503)', { reads: [read(2, null, { status: 503 })], alertsAfter: [refusalText] }, 'reject');
  urlCase('1D: an unrelated generic checkout alert', { reads: [read(2, 'https://checkout.example.test/checkouts/1')], alertsAfter: ['A cart change is still being checked. Check your cart before checkout.'] }, 'reject');
  urlCase('1D: the URL refusal was already showing before the tap', { reads: [read(2, 'https://checkout.example.test/checkouts/1')], alertsBefore: [refusalText], alertsAfter: [refusalText] }, 'reject');
  // Busy Apply: disabled (A) and queued (B) are both correct; dropped, early or false success are not.
  const held = { seq: 10, finishedAt: 1000 };
  // As the real mock logs it (1M): a write that committed has a commitSeq and its response names the
  // requested cart; any other write has neither, unless a case says otherwise.
  const discountWrite = (extra = {}) => {
    const write = { seq: 11, cartId: 'cart', startedAt: 1100, committedAt: 1150, finishedAt: 1160, status: 200, userErrors: [], discountCodes: ['SYNTH10'], ...extra };
    const clean = write.status === 200 && !write.userErrors.length && !(write.graphqlErrors || []).length && !['malformed', 'failed-before-commit', 'pending'].includes(write.outcome);
    return { commitSeq: clean ? 1 : undefined, returnedCartId: write.status === 200 && !(write.graphqlErrors || []).length ? write.cartId : null, ...write };
  };
  const applied = at => ({ at, text: 'SYNTH10 applied. | | |' });
  // Synthetic shorthand: a control that lists only `codes` means those codes are present and applicable:true.
  const busy = (label, observation, wanted) => expect(busyApplyGate, label, { held, cartId: 'cart', events: [], enabledWhileBusy: [],
    ...observation, codeStates: observation.codeStates ?? (observation.codes || []).map(item => ({ code: item, applicable: true })) }, wanted);
  busy('1D: (A) Apply disabled while busy, nothing sent', { applyEnabled: false, writes: [], codes: [], message: '' }, 'accept');
  busy('1D: (B) Apply enabled, queued, sent once after the held update, truthfully confirmed', { applyEnabled: true, enabledWhileBusy: ['cart-discount-input', 'Apply'], writes: [discountWrite()], codes: ['SYNTH10'], message: 'SYNTH10 applied.', events: [applied(1200)] }, 'accept');
  busy('1D: Apply enabled and the tap silently dropped', { applyEnabled: true, enabledWhileBusy: ['cart-discount-input', 'Apply'], writes: [], codes: [], message: '' }, 'reject');
  busy('1D: queued Apply sent before the held update completed', { applyEnabled: true, enabledWhileBusy: ['Apply'], writes: [discountWrite({ seq: 9, startedAt: 900 })], codes: ['SYNTH10'], message: 'SYNTH10 applied.' }, 'reject');
  busy('1D: queued Apply sent twice', { applyEnabled: true, enabledWhileBusy: ['Apply'], writes: [discountWrite(), discountWrite({ seq: 12, startedAt: 1200 })], codes: ['SYNTH10'], message: 'SYNTH10 applied.' }, 'reject');
  busy('1D: "SYNTH10 applied." while Shopify has no code', { applyEnabled: true, enabledWhileBusy: ['Apply'], writes: [discountWrite({ userErrors: ['Code rejected'] })], codes: [], message: 'SYNTH10 applied.' }, 'reject');

  // ---- Task 1E controls (added before the corrections; kept as permanent regression checks) ----
  // Busy Apply: success may be announced only after the discount write committed.
  busy('1E: queued Apply announced "applied" before the held update finished, then written correctly', { applyEnabled: true, writes: [discountWrite()], codes: ['SYNTH10'],
    message: 'SYNTH10 applied.', events: [applied(950), applied(1200)] }, 'reject');
  busy('1E: queued Apply announced "applied" after the held update but before its own write committed', { applyEnabled: true, writes: [discountWrite()], codes: ['SYNTH10'],
    message: 'SYNTH10 applied.', events: [applied(1120)] }, 'reject');
  busy('1E: queued Apply whose write failed, with truthful failure feedback after it', { applyEnabled: true, writes: [discountWrite({ status: 503, userErrors: [] })], codes: [],
    message: 'The discount code could not be applied. Please try again.', events: [{ at: 1200, text: 'The discount code could not be applied. Please try again. | | |' }] }, 'accept');
  busy('1E: queued Apply whose write returned userErrors, with truthful failure feedback', { applyEnabled: true, writes: [discountWrite({ userErrors: ['Code rejected'] })], codes: [],
    message: 'SYNTH10 isn’t valid.', events: [{ at: 1200, text: 'SYNTH10 isn’t valid. | | |' }] }, 'accept');
  busy('1E: queued Apply whose write failed with no feedback at all', { applyEnabled: true, writes: [discountWrite({ status: 503 })], codes: [], message: '', events: [] }, 'reject');
  busy('1E: queued Apply written to another cart', { applyEnabled: true, writes: [discountWrite({ cartId: 'other-cart' })], codes: ['SYNTH10'], message: 'SYNTH10 applied.', events: [applied(1200)] }, 'reject');
  busy('1E: (A) disabled Apply that nevertheless announced "applied"', { applyEnabled: false, writes: [], codes: [], message: '', events: [applied(1200)] }, 'reject');

  // ---- Task 1F controls (added before the correction; kept as permanent regression checks) ----
  // Any success claim counts as success, not just the storefront's current "SYNTH10 applied." copy;
  // a pending "Applying…" is neither success nor failure; failure feedback must actually say so.
  const said = (at, message, announcer = '') => ({ at, text: `${message} | ${announcer} | |` });
  const failed503 = discountWrite({ status: 503 });
  const rejected = discountWrite({ userErrors: ['Code rejected'] });
  busy('1F: "Discount code applied." during the held update, then the real confirmation after commit', { applyEnabled: true, writes: [discountWrite()], codes: ['SYNTH10'],
    message: 'SYNTH10 applied.', events: [said(950, 'Discount code applied.'), applied(1200)] }, 'reject');
  busy('1F: the announcer says "Discount code applied" before the write committed', { applyEnabled: true, writes: [discountWrite()], codes: ['SYNTH10'],
    message: 'SYNTH10 applied.', events: [said(1120, '', 'Discount code applied'), applied(1200)] }, 'reject');
  busy('1F: "Applying SYNTH10…" left on screen after HTTP 503', { applyEnabled: true, writes: [failed503], codes: [], message: 'Applying SYNTH10…', events: [said(1200, 'Applying SYNTH10…')] }, 'reject');
  busy('1F: "Applying SYNTH10…" left on screen after userErrors', { applyEnabled: true, writes: [rejected], codes: [], message: 'Applying SYNTH10…', events: [said(1200, 'Applying SYNTH10…')] }, 'reject');
  busy('1F: "Discount code applied." after HTTP 503', { applyEnabled: true, writes: [failed503], codes: [], message: 'Discount code applied.', events: [said(1200, 'Discount code applied.')] }, 'reject');
  busy('1F: "Discount code applied." after userErrors', { applyEnabled: true, writes: [rejected], codes: [], message: 'Discount code applied.', events: [said(1200, 'Discount code applied.')] }, 'reject');
  busy('1F: the storefront\'s own rejection copy after userErrors', { applyEnabled: true, writes: [rejected], codes: [], message: 'Discount code isn’t valid for this cart.',
    events: [said(1200, 'Discount code isn’t valid for this cart.')] }, 'accept');
  // 1K: the storefront's real connection copy (src/commerce.js commerceErrorMessage); "Couldn’t reach Shopify…" is not source copy.
  busy('1F: a connection failure message after HTTP 503', { applyEnabled: true, writes: [failed503], codes: [], message: 'Connection lost. Check your connection and try again.',
    events: [said(1200, 'Connection lost. Check your connection and try again.')] }, 'accept');
  busy('1F: other success wording, shown only after the write committed', { applyEnabled: true, writes: [discountWrite()], codes: ['SYNTH10'], message: 'Discount code applied.',
    events: [said(1200, 'Discount code applied.')] }, 'accept');
  busy('1F: "Applying SYNTH10…" left on screen after a successful write', { applyEnabled: true, writes: [discountWrite()], codes: ['SYNTH10'], message: 'Applying SYNTH10…',
    events: [said(1200, 'Applying SYNTH10…')] }, 'reject');

  // ---- Task 1G controls (added before the corrections; kept as permanent regression checks) ----
  // Feedback is judged statement by statement: a success claim counts even beside pending or failure
  // wording, and a failure counts only when it is about the discount, not checkout or another action.
  busy('1G: (A) "Discount code applied. Updating your cart…" in the announcer before commit, then a real confirmation', { applyEnabled: true, writes: [discountWrite()],
    codes: ['SYNTH10'], message: 'SYNTH10 applied.', events: [said(1120, '', 'Discount code applied. Updating your cart…'), applied(1200)] }, 'reject');
  busy('1G: (A) the same mixed text in the discount message before commit', { applyEnabled: true, writes: [discountWrite()], codes: ['SYNTH10'],
    message: 'SYNTH10 applied.', events: [said(1120, 'Discount code applied. Updating your cart…'), applied(1200)] }, 'reject');
  busy('1G: (B) "Checkout failed." as the only feedback after a discount HTTP 503', { applyEnabled: true, writes: [failed503], codes: [], message: 'Checkout failed.',
    events: [said(1200, 'Checkout failed.')] }, 'reject');
  busy('1G: (B) "Checkout failed." as the only feedback after discount userErrors', { applyEnabled: true, writes: [rejected], codes: [], message: 'Checkout failed.',
    events: [said(1200, 'Checkout failed.')] }, 'reject');
  busy('1G: (C) "Discount service is temporarily unavailable." after a discount HTTP 503', { applyEnabled: true, writes: [failed503], codes: [],
    message: 'Discount service is temporarily unavailable.', events: [said(1200, 'Discount service is temporarily unavailable.')] }, 'accept');
  busy('1G: a failure about shipping, not the discount, after a discount HTTP 503', { applyEnabled: true, writes: [failed503], codes: [],
    message: 'Shipping rates couldn’t be loaded.', events: [said(1200, 'Shipping rates couldn’t be loaded.')] }, 'reject');
  busy('1G: "Discount code applied, but checkout failed." after a discount HTTP 503', { applyEnabled: true, writes: [failed503], codes: [],
    message: 'Discount code applied, but checkout failed.', events: [said(1200, 'Discount code applied, but checkout failed.')] }, 'reject');
  busy('1G: a truthful failure followed by "Updating your cart…" left as the final message', { applyEnabled: true, writes: [failed503], codes: [],
    message: 'Updating your cart…', events: [said(1200, 'The discount code could not be applied.'), said(1250, 'Updating your cart…')] }, 'reject');
  busy('1G: "SYNTH10 applied. Updating your cart…" shown only after commit', { applyEnabled: true, writes: [discountWrite()], codes: ['SYNTH10'],
    message: 'SYNTH10 applied. Updating your cart…', events: [said(1200, 'SYNTH10 applied. Updating your cart…')] }, 'accept');
  busy('1G: the discount failure stated in the announcer while the discount message shows the code was rejected', { applyEnabled: true, writes: [rejected], codes: [],
    message: 'Discount code isn’t valid for this cart.', events: [said(1200, 'Discount code isn’t valid for this cart.', 'Discount not applied')] }, 'accept');

  // Pointer delivery: a press counts only when the intended control is seen receiving it.
  // Listeners are confirmed installed unless a case says otherwise (1H).
  const deliveryCase = (label, input, wanted) => { const decision = tapDelivery({ installed: true, ...input });
    check('harness', `tap delivery ${wanted ? 'accepts' : 'rejects'}: ${label}`, decision.ok === wanted, decision); };
  const onTarget = { onTarget: true, html: '<button data-qty-line>' }, elsewhere = { onTarget: false, html: '<button data-wrist-fit>' };
  deliveryCase('1G: an enabled control seen receiving pointerdown and click', { disabledAtAim: false, allowDisabled: false, pointerdown: onTarget, click: onTarget }, true);
  deliveryCase('1G: CDP dispatch returned but no pointerdown was observed on the enabled control', { disabledAtAim: false, allowDisabled: false, pointerdown: null, click: null }, false);
  deliveryCase('1G: pointerdown on the enabled control but no click activated it', { disabledAtAim: false, allowDisabled: false, pointerdown: onTarget, click: null }, false);
  deliveryCase('1G: pointerdown reached a different control', { disabledAtAim: false, allowDisabled: false, pointerdown: elsewhere, click: null }, false);
  deliveryCase('1G: the click reached a different control', { disabledAtAim: false, allowDisabled: false, pointerdown: onTarget, click: elsewhere }, false);
  deliveryCase('1G: a disabled control pressed without an explicit disabled press', { disabledAtAim: true, allowDisabled: false, pointerdown: null, click: null }, false);
  deliveryCase('1G: an explicit disabled press that nothing received', { disabledAtAim: true, allowDisabled: true, pointerdown: null, click: null }, true);
  deliveryCase('1G: an explicit disabled press whose pointerdown went to another control', { disabledAtAim: true, allowDisabled: true, pointerdown: elsewhere, click: null }, false);

  // +1 correlation through the real correlator: a batched write may list the service before the glove.
  const request = (tab, lines, cartId = 'cart') => ({ tab, operation: 'UpdateLines', cartId, lines });
  // A committed entry carries the mock's commit sequence (here equal to its arrival sequence); others do not.
  const logged = (seq, lines, resultLines, extra = {}) => { const entry = { seq, operation: 'UpdateLines', cartId: 'cart', lines, outcome: 'committed', status: 200, userErrors: [], resultLines, ...extra };
    if (/^(committed|user-errors|unmatched)/.test(entry.outcome) && !('attemptedAt' in extra)) entry.attemptedAt = seq;
    return /^committed/.test(entry.outcome) && !('commitSeq' in extra) ? { ...entry, commitSeq: seq } : entry; };
  const tabA = [request('A', [{ id: 'p1', quantity: 2 }]), request('A', [{ id: 's1', quantity: 2 }])];
  const logA = [logged(1, [{ id: 'p1', quantity: 2 }], [{ id: 'p1', quantity: 2 }, { id: 's1', quantity: 1 }]), logged(2, [{ id: 's1', quantity: 2 }], [{ id: 'p1', quantity: 2 }, { id: 's1', quantity: 2 }])];
  const correlated = (label, requestsB, logB, wanted, finalLines = at(3)) => {
    const byTab = correlateRequests([...tabA, ...requestsB], [...logA, ...logB], 'UpdateLines');
    expect(plusOneGate, label, { name: 'BR16', initial, cartId: 'cart', finalLines, actions: ['A', 'B'].map(tab => ({ tab, refusal: silent, writes: byTab[tab] || [] })) }, wanted);
  };
  const three = [{ id: 'p1', quantity: 3 }, { id: 's1', quantity: 3 }];
  correlated('1E: batched write listing the service line before the glove line', [request('B', [{ id: 's1', quantity: 3 }, { id: 'p1', quantity: 3 }])],
    [logged(3, [{ id: 's1', quantity: 3 }, { id: 'p1', quantity: 3 }], three)], 'accept');
  correlated('1E: batched write listing the glove line first', [request('B', [{ id: 'p1', quantity: 3 }, { id: 's1', quantity: 3 }])],
    [logged(3, [{ id: 'p1', quantity: 3 }, { id: 's1', quantity: 3 }], three)], 'accept');
  correlated('1E: B\'s write went to another cart', [request('B', [{ id: 'p1', quantity: 3 }], 'other-cart')],
    [logged(3, [{ id: 'p1', quantity: 3 }], [{ id: 'p1', quantity: 3 }], { cartId: 'other-cart' })], 'reject');
  correlated('1E: B\'s write changed a different glove line', [request('B', [{ id: 'p9', quantity: 3 }])], [logged(3, [{ id: 'p9', quantity: 3 }], [{ id: 'p9', quantity: 3 }])], 'reject');
  correlated('1E: B\'s write lists the glove line twice', [request('B', [{ id: 'p1', quantity: 3 }, { id: 'p1', quantity: 3 }])],
    [logged(3, [{ id: 'p1', quantity: 3 }, { id: 'p1', quantity: 3 }], three)], 'reject');
  correlated('1E: B\'s write gives the glove line two different quantities', [request('B', [{ id: 's1', quantity: 3 }, { id: 'p1', quantity: 3 }, { id: 'p1', quantity: 2 }])],
    [logged(3, [{ id: 's1', quantity: 3 }, { id: 'p1', quantity: 3 }, { id: 'p1', quantity: 2 }], three)], 'reject');
  correlated('1E: B wrote only the service line', [request('B', [{ id: 's1', quantity: 3 }])], [logged(3, [{ id: 's1', quantity: 3 }], [{ id: 'p1', quantity: 2 }, { id: 's1', quantity: 3 }])], 'reject');
  correlated('1E: B\'s write came back with userErrors', [request('B', [{ id: 's1', quantity: 3 }, { id: 'p1', quantity: 3 }])],
    [logged(3, [{ id: 's1', quantity: 3 }, { id: 'p1', quantity: 3 }], [{ id: 'p1', quantity: 2 }, { id: 's1', quantity: 2 }], { outcome: 'user-errors', userErrors: ['The merchandise line was not found.'] })], 'reject');
  correlated('1E: B\'s write failed (HTTP 503)', [request('B', [{ id: 'p1', quantity: 3 }])], [logged(3, [{ id: 'p1', quantity: 3 }], null, { outcome: 'failed-before-commit', status: 503 })], 'reject');
  correlated('1E: B\'s write returned no cart state', [request('B', [{ id: 'p1', quantity: 3 }])], [logged(3, [{ id: 'p1', quantity: 3 }], null)], 'reject');
  correlated('1E: B\'s write asked for the stale quantity 2', [request('B', [{ id: 's1', quantity: 2 }, { id: 'p1', quantity: 2 }])],
    [logged(3, [{ id: 's1', quantity: 2 }, { id: 'p1', quantity: 2 }], [{ id: 'p1', quantity: 2 }, { id: 's1', quantity: 2 }])], 'reject');
  correlated('1E: B\'s batched write set the service to a different quantity than the glove', [request('B', [{ id: 's1', quantity: 2 }, { id: 'p1', quantity: 3 }])],
    [logged(3, [{ id: 's1', quantity: 2 }, { id: 'p1', quantity: 3 }], [{ id: 'p1', quantity: 3 }, { id: 's1', quantity: 2 }])], 'reject');
  correlated('1E: B\'s batched write also changed an unrelated line', [request('B', [{ id: 's1', quantity: 3 }, { id: 'p1', quantity: 3 }, { id: 'x7', quantity: 5 }])],
    [logged(3, [{ id: 's1', quantity: 3 }, { id: 'p1', quantity: 3 }, { id: 'x7', quantity: 5 }], [...three, { id: 'x7', quantity: 5 }])], 'reject');
  correlated('1E: quantities right but the service line was replaced by a new line', [request('B', [{ id: 's1', quantity: 3 }, { id: 'p1', quantity: 3 }])],
    [logged(3, [{ id: 's1', quantity: 3 }, { id: 'p1', quantity: 3 }], three)], 'reject', [{ ...serviced, quantity: 3 }, { ...service, id: 's9', quantity: 3 }]);

  // ---- Task 1H controls (added before the corrections; kept as permanent regression checks) ----
  // Fix 1: a failure counts as discount feedback only when the action that failed is the discount,
  // not when checkout, shipping or another operation failed and merely mentions the code.
  busy('1H: "Checkout failed while checking your discount code." after a discount HTTP 503', { applyEnabled: true, writes: [failed503], codes: [],
    message: 'Checkout failed while checking your discount code.', events: [said(1200, 'Checkout failed while checking your discount code.')] }, 'reject');
  busy('1H: "Checkout failed while checking your discount code." after discount userErrors', { applyEnabled: true, writes: [rejected], codes: [],
    message: 'Checkout failed while checking your discount code.', events: [said(1200, 'Checkout failed while checking your discount code.')] }, 'reject');
  busy('1H: "Shipping couldn’t be calculated for your discount code." after a discount HTTP 503', { applyEnabled: true, writes: [failed503], codes: [],
    message: 'Shipping couldn’t be calculated for your discount code.', events: [said(1200, 'Shipping couldn’t be calculated for your discount code.')] }, 'reject');
  busy('1H: "Payment failed — re-enter your discount code." after a discount HTTP 503', { applyEnabled: true, writes: [failed503], codes: [],
    message: 'Payment failed — re-enter your discount code.', events: [said(1200, 'Payment failed — re-enter your discount code.')] }, 'reject');
  busy('1H: "Discount code SYNTH10 couldn’t be applied. Try again." after a discount HTTP 503', { applyEnabled: true, writes: [failed503], codes: [],
    message: 'Discount code SYNTH10 couldn’t be applied. Try again.', events: [said(1200, 'Discount code SYNTH10 couldn’t be applied. Try again.')] }, 'accept');
  busy('1H: "We couldn’t apply your discount code. Try again." after discount userErrors', { applyEnabled: true, writes: [rejected], codes: [],
    message: 'We couldn’t apply your discount code. Try again.', events: [said(1200, 'We couldn’t apply your discount code. Try again.')] }, 'accept');
  busy('1H: "The discount service is unavailable right now." after a discount HTTP 503', { applyEnabled: true, writes: [failed503], codes: [],
    message: 'The discount service is unavailable right now.', events: [said(1200, 'The discount service is unavailable right now.')] }, 'accept');
  // Fix 2: a success claim that names a code must name the code this action submitted (any case).
  busy('1H: "Discount code SAVE20 applied." after SYNTH10 was committed', { applyEnabled: true, code: 'SYNTH10', writes: [discountWrite()], codes: ['SYNTH10'],
    message: 'Discount code SAVE20 applied.', events: [said(1200, 'Discount code SAVE20 applied.')] }, 'reject');
  busy('1H: "Discount code save20 applied." (lower case) after SYNTH10 was committed', { applyEnabled: true, code: 'SYNTH10', writes: [discountWrite()], codes: ['SYNTH10'],
    message: 'Discount code save20 applied.', events: [said(1200, 'Discount code save20 applied.')] }, 'reject');
  busy('1H: the announcer says "SAVE20 applied" while the discount message confirms SYNTH10', { applyEnabled: true, code: 'SYNTH10', writes: [discountWrite()], codes: ['SYNTH10'],
    message: 'SYNTH10 applied.', events: [said(1200, 'SYNTH10 applied.', 'Discount code SAVE20 applied.')] }, 'reject');
  busy('1H: "SYNTH10 and SAVE20 applied." after only SYNTH10 was committed', { applyEnabled: true, code: 'SYNTH10', writes: [discountWrite()], codes: ['SYNTH10'],
    message: 'SYNTH10 and SAVE20 applied.', events: [said(1200, 'SYNTH10 and SAVE20 applied.')] }, 'reject');
  busy('1H: generic "Discount code applied." after a 200 write that left Shopify without the code', { applyEnabled: true, code: 'SYNTH10', writes: [discountWrite()], codes: [],
    message: 'Discount code applied.', events: [said(1200, 'Discount code applied.')] }, 'reject');
  busy('1H: "Discount code synth10 applied." (lower case) after SYNTH10 was committed', { applyEnabled: true, code: 'SYNTH10', writes: [discountWrite()], codes: ['SYNTH10'],
    message: 'Discount code synth10 applied.', events: [said(1200, 'Discount code synth10 applied.')] }, 'accept');
  busy('1H: "Discount applied to BR16." names the glove, not another code', { applyEnabled: true, code: 'SYNTH10', writes: [discountWrite()], codes: ['SYNTH10'],
    message: 'Discount applied to BR16.', events: [said(1200, 'Discount applied to BR16.')] }, 'accept');

  // Fix 3: an enabled tap is delivered only when listeners installed before dispatch saw both
  // pointerdown and click on the intended control.
  deliveryCase('1H: an enabled control that received click but no observed pointerdown', { disabledAtAim: false, allowDisabled: false, installed: true, pointerdown: null, click: onTarget }, false);
  deliveryCase('1H: click on target after pointerdown went to another control', { disabledAtAim: false, allowDisabled: false, installed: true, pointerdown: elsewhere, click: onTarget }, false);
  deliveryCase('1H: both events seen, but the listeners were not confirmed installed before dispatch', { disabledAtAim: false, allowDisabled: false, installed: false, pointerdown: onTarget, click: onTarget }, false);
  deliveryCase('1H: an explicit disabled press that nevertheless activated the control (click)', { disabledAtAim: true, allowDisabled: true, installed: true, pointerdown: onTarget, click: onTarget }, false);
  deliveryCase('1H: a control disabled by pointerdown time, pressed without an explicit disabled press', { disabledAtAim: false, allowDisabled: false, installed: true, pointerdown: { ...onTarget, disabled: true }, click: null }, false);
  deliveryCase('1H: both events on the enabled control with listeners confirmed before dispatch', { disabledAtAim: false, allowDisabled: false, installed: true, pointerdown: onTarget, click: onTarget }, true);
  deliveryCase('1H: an explicit disabled press whose pointerdown reached the disabled control, no click', { disabledAtAim: true, allowDisabled: true, installed: true, pointerdown: { ...onTarget, disabled: true }, click: null }, true);
  deliveryCase('1H: an explicit press on a control disabled by pointerdown time, no click', { disabledAtAim: false, allowDisabled: true, installed: true, pointerdown: { ...onTarget, disabled: true }, click: null }, true);

  // Fix 4: a not-offered (disabled) or refused +1 must not have committed anything; an accepted one
  // must survive. A disabled observation never stands in for a refusal message.
  const generic = classifyRefusal({ item: 'BR16', action: 'increase', before: [], after: ['Your cart changed in another tab.'], actionable: true });
  const named = classifyRefusal({ item: 'BR16', action: 'increase', before: [], after: ['BR16 quantity wasn’t updated. Try again.'], actionable: true });
  const stale = classifyRefusal({ item: 'BR16', action: 'increase', before: ['BR16 quantity wasn’t updated. Try again.'], after: ['BR16 quantity wasn’t updated. Try again.'], actionable: true });
  const disabledB = notOfferedOr(true, generic);
  const pair = (requested, extra = {}) => ({ ...write(requested), lines: [{ id: 'p1', quantity: requested }, { id: 's1', quantity: requested }],
    resultLines: [{ id: 'p1', quantity: requested }, { id: 's1', quantity: requested }], ...extra });
  expect(plusOneGate, '1H: B recorded as disabled, but B committed quantity 3 and A\'s quantity 2 overwrote it', plus(at(2), act('A', silent, [pair(2, { seq: 3, commitSeq: 3 })]), act('B', disabledB, [pair(3, { seq: 2, commitSeq: 2 })])), 'reject');
  expect(plusOneGate, '1H: B refused by name, but B had committed quantity 3, later overwritten to 2', plus(at(2), act('A', silent, [pair(2, { seq: 3, commitSeq: 3 })]), act('B', named, [pair(3, { seq: 2, commitSeq: 2 })])), 'reject');
  expect(plusOneGate, '1H: B recorded as disabled, but B committed a service-only write', plus(at(2), act('A', silent, [pair(2, { seq: 1, commitSeq: 1 })]),
    act('B', disabledB, [{ ...write(3), lines: [{ id: 's1', quantity: 3 }], resultLines: [{ id: 'p1', quantity: 2 }, { id: 's1', quantity: 3 }], seq: 2, commitSeq: 2 }])), 'reject');
  expect(plusOneGate, '1H: B "refused" only by a stale refusal message, nothing written, ending at 2', plus(at(2), act('A', silent, [pair(2)]), act('B', stale, [])), 'reject');
  expect(plusOneGate, '1H: B "refused" only by a generic warning, nothing written, ending at 2', plus(at(2), act('A', silent, [pair(2)]), act('B', generic, [])), 'reject');
  expect(plusOneGate, '1H: B accepted, but its glove writes contradict each other (3, then 2)', plus(at(3), act('A', silent, [pair(2, { seq: 1, commitSeq: 1 })]), act('B', silent, [pair(3, { seq: 2, commitSeq: 2 }), pair(2, { seq: 3, commitSeq: 3 })])), 'reject');
  expect(plusOneGate, '1H: both accepted, but A\'s late quantity-2 write overwrote B\'s 3', plus(at(2), act('A', silent, [pair(2, { seq: 3, commitSeq: 3 })]), act('B', silent, [pair(3, { seq: 2, commitSeq: 2 })])), 'reject');
  expect(plusOneGate, '1H: B disabled with nothing committed, but the service parity broke', plus(at(2, 3), act('A', silent, [pair(2)]), act('B', disabledB, [])), 'reject');
  expect(plusOneGate, '1H: B disabled before activation, nothing committed from B, ending at 2', plus(at(2), act('A', silent, [pair(2, { seq: 1, commitSeq: 1 })]), act('B', disabledB, [])), 'accept');
  expect(plusOneGate, '1H: B refused by a fresh named quantity message, nothing committed, ending at 2', plus(at(2), act('A', silent, [pair(2, { seq: 1, commitSeq: 1 })]), act('B', named, [])), 'accept');
  expect(plusOneGate, '1H: serialized and rebased: A commits 2, then B commits 3', plus(at(3), act('A', silent, [pair(2, { seq: 1, commitSeq: 1 })]), act('B', silent, [pair(3, { seq: 2, commitSeq: 2 })])), 'accept');

  // ---- Task 1I controls (added before the corrections; kept as permanent regression checks) ----
  // A rejection must come from the named verdict, not incidentally from another one.
  const expectVerdict = (gate, label, observation, pattern) => {
    const verdicts = gate(gate === plusOneGate ? prepared(observation) : observation);
    const named = verdicts.filter(item => pattern.test(item.name));
    check('harness', `rejects: ${label}`, named.length > 0 && named.some(item => !item.pass), { verdict: String(pattern), named: named.map(item => ({ name: item.name, pass: item.pass })) });
  };
  // All four captured fields: discount message | announcer | cart feedback | checkout status.
  const shown = (at, discount, announcer = '', feedback = '', checkout = '') => ({ at, text: `${discount} | ${announcer} | ${feedback} | ${checkout}` });
  const failCase = (write, message, wanted) => busy(`1I: "${message}" after ${write === failed503 ? 'a discount HTTP 503' : 'discount userErrors'}`,
    { applyEnabled: true, writes: [write], codes: [], message, events: [said(1200, message)] }, wanted);
  // Fix 1: the failed operation is identified wherever it sits in the statement, not by word order.
  failCase(failed503, 'Couldn’t load shipping for your discount.', 'reject');
  failCase(rejected, 'Couldn’t load shipping for your discount.', 'reject');
  failCase(failed503, 'Unable to calculate shipping for discount code SYNTH10.', 'reject');
  failCase(failed503, 'Failed to start checkout with your discount code.', 'reject');
  failCase(failed503, 'We couldn’t update the quantity for your discount.', 'reject');
  failCase(failed503, 'Couldn’t load shipping rates for your discount code. Please try again.', 'reject');
  failCase(failed503, 'Your discount’s shipping estimate couldn’t load.', 'reject');
  failCase(failed503, 'Discount error: shipping is unavailable.', 'reject');
  failCase(failed503, 'Shipping couldn’t be loaded. Try again.', 'reject');
  failCase(failed503, 'Checkout couldn’t verify your discount code.', 'reject');
  failCase(rejected, 'Order total couldn’t include your discount.', 'reject');
  failCase(rejected, 'Your discount couldn’t be applied to shipping.', 'accept');
  failCase(failed503, 'Promo code service unavailable.', 'accept');
  failCase(failed503, 'Discount service unavailable.', 'accept');
  failCase(failed503, 'Discounts are temporarily unavailable. Try again.', 'accept');
  failCase(failed503, 'Couldn’t apply your discount. Service unavailable.', 'accept');
  failCase(failed503, 'Unable to apply discount code SYNTH10 right now.', 'accept');
  failCase(rejected, 'Discount code isn’t valid for items in your cart.', 'accept');
  failCase(rejected, 'DISCOUNT CODE SYNTH10 COULDN’T BE APPLIED.', 'accept');
  // Fix 2: alphabetic codes. A success claim naming another code fails in every field; a truthful bare
  // "<CODE> applied." for the submitted code is accepted once the write and Shopify's codes agree.
  const saved = discountWrite({ discountCodes: ['SAVE20'] }), free = discountWrite({ discountCodes: ['FREESHIP'] });
  const codeCase = (label, code, observation, wanted) => busy(`1I: ${label}`, { applyEnabled: true, code, codes: [code], writes: [code === 'FREESHIP' ? free : saved], ...observation }, wanted);
  codeCase('"Discount code FREESHIP applied." after SAVE20 was submitted and committed', 'SAVE20', { message: 'Discount code FREESHIP applied.', events: [shown(1200, 'Discount code FREESHIP applied.')] }, 'reject');
  codeCase('bare "FREESHIP applied" in the announcer beside a correct "SAVE20 applied."', 'SAVE20', { message: 'SAVE20 applied.', events: [shown(1200, 'SAVE20 applied.', 'FREESHIP applied')] }, 'reject');
  codeCase('mixed-case "Discount code FreeShip applied." in the cart feedback beside a correct message', 'SAVE20', { message: 'SAVE20 applied.', events: [shown(1200, 'SAVE20 applied.', '', 'Discount code FreeShip applied.')] }, 'reject');
  codeCase('"Code   freeship   applied" with odd spacing in the checkout status', 'SAVE20', { message: 'SAVE20 applied.', events: [shown(1200, 'SAVE20 applied.', '', '', 'Code   freeship   applied')] }, 'reject');
  codeCase('"FREESHIP applied." as the second statement of a correct message', 'SAVE20', { message: 'Discount code SAVE20 applied. FREESHIP applied.', events: [shown(1200, 'Discount code SAVE20 applied. FREESHIP applied.')] }, 'reject');
  codeCase('quoted “FREESHIP” applied in the announcer', 'SAVE20', { message: 'SAVE20 applied.', events: [shown(1200, 'SAVE20 applied.', 'Promo “FREESHIP” applied.')] }, 'reject');
  codeCase('"FREESHIP and SAVE20 applied." after only FREESHIP was committed', 'FREESHIP', { message: 'FREESHIP and SAVE20 applied.', events: [shown(1200, 'FREESHIP and SAVE20 applied.')] }, 'reject');
  codeCase('"FREESHIP applied." but Shopify holds no code', 'FREESHIP', { codes: [], message: 'FREESHIP applied.', events: [shown(1200, 'FREESHIP applied.')] }, 'reject');
  codeCase('"FREESHIP applied." after the write failed (HTTP 503)', 'FREESHIP', { codes: [], writes: [discountWrite({ status: 503, discountCodes: ['FREESHIP'] })], message: 'FREESHIP applied.', events: [shown(1200, 'FREESHIP applied.')] }, 'reject');
  codeCase('"FREESHIP applied." shown before the write committed', 'FREESHIP', { message: 'FREESHIP applied.', events: [shown(1120, 'FREESHIP applied.')] }, 'reject');
  codeCase('the storefront\'s own "FREESHIP applied." after FREESHIP was committed', 'FREESHIP', { message: 'FREESHIP applied.', events: [shown(1200, 'FREESHIP applied.')] }, 'accept');
  codeCase('"  FREESHIP   applied. " with odd spacing', 'FREESHIP', { message: '  FREESHIP   applied. ', events: [shown(1200, '  FREESHIP   applied. ')] }, 'accept');
  codeCase('"Discount code freeship applied." in lower case', 'FREESHIP', { message: 'Discount code freeship applied.', events: [shown(1200, 'Discount code freeship applied.')] }, 'accept');
  codeCase('"Discount applied to BR16." names the glove', 'FREESHIP', { message: 'Discount applied to BR16.', events: [shown(1200, 'Discount applied to BR16.')] }, 'accept');
  codeCase('product and service copy beside "FREESHIP applied." (BL50, ANAWIN, Break-in service, saved selections)', 'FREESHIP', { message: 'FREESHIP applied.',
    events: [shown(1200, 'FREESHIP applied.', 'ANAWIN BL50 added to cart.', 'Break-in service added to BR16. Your selections are saved.')] }, 'accept');
  // Fix 3: quantity writes are ordered by when the mock committed them, not when they arrived.
  const raised = /only ever raised the quantity/;
  expectVerdict(plusOneGate, '1I: B disabled; A\'s 2 arrived first but committed after B\'s 3', plus(at(2), act('A', silent, [pair(2, { seq: 1, commitSeq: 2 })]), act('B', disabledB, [pair(3, { seq: 2, commitSeq: 1 })])), raised);
  expectVerdict(plusOneGate, '1I: B accepted; A\'s 2 arrived first but committed after B\'s 3', plus(at(2), act('A', silent, [pair(2, { seq: 1, commitSeq: 2 })]), act('B', silent, [pair(3, { seq: 2, commitSeq: 1 })])), raised);
  expectVerdict(plusOneGate, '1I: B refused by name; A\'s 2 arrived first but committed after B\'s 3', plus(at(2), act('A', silent, [pair(2, { seq: 1, commitSeq: 2 })]), act('B', named, [pair(3, { seq: 2, commitSeq: 1 })])), raised);
  expectVerdict(plusOneGate, '1I: two committed writes with no commit sequence (order unknown)', plus(at(3), act('A', silent, [pair(2, { seq: 1, commitSeq: undefined })]), act('B', silent, [pair(3, { seq: 2, commitSeq: undefined })])), raised);
  expectVerdict(plusOneGate, '1I: A\'s late service-only 2 committed after B\'s glove and service 3', plus(at(3, 2), act('A', silent, [pair(2, { seq: 1, commitSeq: 1 }), { ...write(2, { lineId: 's1' }), seq: 3, commitSeq: 3 }]),
    act('B', silent, [pair(3, { seq: 2, commitSeq: 2 })])), raised);
  expect(plusOneGate, '1I: B\'s 3 arrived first but was queued; A\'s 2 committed first, then B\'s 3', plus(at(3), act('A', silent, [pair(2, { seq: 2, commitSeq: 1 })]), act('B', silent, [pair(3, { seq: 1, commitSeq: 2 })])), 'accept');
  expect(plusOneGate, '1I: B refused by name; its write was received and rejected with userErrors, never committed', plus(at(2), act('A', silent, [pair(2, { seq: 2, commitSeq: 1 })]),
    act('B', named, [pair(3, { seq: 1, commitSeq: undefined, outcome: 'user-errors', userErrors: ['The cart changed.'], resultLines: [{ id: 'p1', quantity: 2 }, { id: 's1', quantity: 2 }] })])), 'accept');
  expect(plusOneGate, '1I: B disabled with no write; A committed 2', plus(at(2), act('A', silent, [pair(2, { seq: 1, commitSeq: 1 })]), act('B', disabledB, [])), 'accept');
  // The same through the real correlator: arrival order (log seq) is the opposite of commit order.
  const pairOf = q => [{ id: 'p1', quantity: q }, { id: 's1', quantity: q }];
  const throughCorrelator = (requests, log, refusals) => { const byTab = correlateRequests(requests, log, 'UpdateLines');
    return { name: 'BR16', initial, cartId: 'cart', actions: ['A', 'B'].map(tab => ({ tab, refusal: refusals[tab], writes: byTab[tab] || [] })) }; };
  expectVerdict(plusOneGate, '1I (correlator): B disabled; A arrived first, B committed 3, then A overwrote it with 2', { ...throughCorrelator([request('A', pairOf(2)), request('B', pairOf(3))],
    [logged(1, pairOf(2), pairOf(2), { commitSeq: 2 }), logged(2, pairOf(3), pairOf(3), { commitSeq: 1 })], { A: silent, B: disabledB }), finalLines: at(2) }, raised);
  expect(plusOneGate, '1I (correlator): B arrived first but committed after A; 2 then 3 in commit order', { ...throughCorrelator([request('B', pairOf(3)), request('A', pairOf(2))],
    [logged(1, pairOf(3), pairOf(3), { commitSeq: 2 }), logged(2, pairOf(2), pairOf(2), { commitSeq: 1 })], { A: silent, B: silent }), finalLines: at(3) }, 'accept');
  const lifecycle = correlateRequests([request('A', pairOf(2)), request('B', pairOf(3)), request('B', pairOf(4)), request('B', pairOf(5))],
    [logged(1, pairOf(2), pairOf(2)), logged(2, pairOf(3), pairOf(2), { outcome: 'user-errors', userErrors: ['The cart changed.'] }), logged(3, pairOf(4), null, { outcome: 'failed-before-commit', status: 503 })], 'UpdateLines');
  check('harness', '1I: the correlator distinguishes committed, rejected, received-not-attempted and never-received writes',
    same([...lifecycle.A, ...lifecycle.B].map(item => item.lifecycle), ['committed', 'rejected', 'received', 'not received']), { lifecycle });

  // ---- Task 1J controls (added before the corrections; kept as permanent regression checks) ----
  // Fix 1: each failure word is judged in its own clause, and failure copy that names no operation is
  // judged by the discount action's real context (src/main.js discountAction: a thrown request shows
  // commerceErrorMessage(error, 'cart'); userErrors show the discount's own rejection copy).
  const timedOut = discountWrite({ status: null, outcome: 'cancelled (timeout)' });
  const writeLabel = write => write === failed503 ? 'a discount HTTP 503' : write === timedOut ? 'a discount timeout' : 'discount userErrors';
  const clauseCase = (write, message, wanted) => busy(`1J: "${message}" after ${writeLabel(write)}`, { applyEnabled: true, writes: [write], codes: [], message, events: [said(1200, message)] }, wanted);
  clauseCase(failed503, 'Your discount code was checked and shipping failed to load.', 'reject');
  clauseCase(rejected, 'Your discount code was checked and shipping failed to load.', 'reject');
  clauseCase(failed503, 'Your discount code was checked and checkout failed.', 'reject');
  clauseCase(failed503, 'Your discount code was checked and the quantity couldn’t be updated.', 'reject');
  clauseCase(failed503, 'Your discount code was checked, then the order couldn’t be placed.', 'reject');
  clauseCase(failed503, 'Shipping failed to load after your discount code was checked.', 'reject');
  clauseCase(failed503, 'Your discount code was checked and image failed to load.', 'reject');
  clauseCase(failed503, 'Your cart is unavailable. Check your cart and try again.', 'reject');
  clauseCase(failed503, 'Image unavailable. Close and try again.', 'reject');
  clauseCase(failed503, 'Reviews are temporarily unavailable.', 'reject');
  clauseCase(rejected, 'Something went wrong. Please try again.', 'reject');
  clauseCase(rejected, 'Connection lost. Check your connection and try again.', 'reject');
  clauseCase(rejected, 'Shopify is taking too long to respond. Please try again.', 'reject');
  clauseCase(failed503, 'Couldn’t update your cart. Please try again.', 'accept');
  // 1K: not storefront copy, and names no operation: an unsupported shape, so it now fails (was accepted in 1J).
  clauseCase(failed503, 'Something went wrong. Please try again.', 'reject');
  clauseCase(failed503, 'Connection lost. Check your connection and try again.', 'accept');
  clauseCase(timedOut, 'Shopify is taking too long to respond. Please try again.', 'accept');
  clauseCase(timedOut, 'Connection lost. Check your connection and try again.', 'accept');
  clauseCase(failed503, 'Shipping was loaded, but your discount code couldn’t be applied.', 'accept');
  clauseCase(failed503, 'After checking shipping, we couldn’t apply your discount code.', 'accept');
  clauseCase(rejected, 'We couldn’t apply your discount code because it expired.', 'accept');
  // Fix 2: bare code announcements in any case. The storefront echoes the code as typed ("freeship applied.").
  const summer = discountWrite({ discountCodes: ['SUMMER'] });
  const caseCase = (label, code, observation, wanted) => busy(`1J: ${label}`, { applyEnabled: true, code, codes: [code], writes: [{ SAVE20: saved, FREESHIP: free, SUMMER: summer }[code]], ...observation }, wanted);
  caseCase('bare "freeship applied" in the announcer beside a correct "SAVE20 applied."', 'SAVE20', { message: 'SAVE20 applied.', events: [shown(1200, 'SAVE20 applied.', 'freeship applied')] }, 'reject');
  caseCase('bare "FreeShip applied." in the cart feedback beside a correct message', 'SAVE20', { message: 'SAVE20 applied.', events: [shown(1200, 'SAVE20 applied.', '', 'FreeShip applied.')] }, 'reject');
  caseCase('"freeship redeemed" in the checkout status', 'SAVE20', { message: 'SAVE20 applied.', events: [shown(1200, 'SAVE20 applied.', '', '', 'freeship redeemed')] }, 'reject');
  caseCase('"freeship applied." as the second statement of the discount message', 'SAVE20', { message: 'SAVE20 applied. freeship applied.', events: [shown(1200, 'SAVE20 applied. freeship applied.')] }, 'reject');
  caseCase('"save20 and freeship applied." after only SAVE20 was committed', 'SAVE20', { message: 'save20 and freeship applied.', events: [shown(1200, 'save20 and freeship applied.')] }, 'reject');
  caseCase('a Shopify warning "Saved 10% with SUMMER" appended after SAVE20', 'SAVE20', { message: 'SAVE20 applied. Saved 10% with SUMMER', events: [shown(1200, 'SAVE20 applied. Saved 10% with SUMMER')] }, 'reject');
  caseCase('"Saved 10% with summer" in the announcer beside a correct message', 'SAVE20', { message: 'SAVE20 applied.', events: [shown(1200, 'SAVE20 applied.', 'Saved 10% with summer')] }, 'reject');
  caseCase('the storefront\'s "freeship applied." for a code typed in lower case', 'FREESHIP', { message: 'freeship applied.', events: [shown(1200, 'freeship applied.')] }, 'accept');
  caseCase('"FreeShip applied." in mixed case', 'FREESHIP', { message: 'FreeShip applied.', events: [shown(1200, 'FreeShip applied.')] }, 'accept');
  caseCase('"  freeship    applied " with odd spacing', 'FREESHIP', { message: '  freeship    applied ', events: [shown(1200, '  freeship    applied ')] }, 'accept');
  caseCase('"SUMMER applied. Saved 10% with SUMMER" for SUMMER', 'SUMMER', { message: 'SUMMER applied. Saved 10% with SUMMER', events: [shown(1200, 'SUMMER applied. Saved 10% with SUMMER')] }, 'accept');
  caseCase('ordinary words before a success verb beside "freeship applied." ("10% off applied")', 'FREESHIP', { message: 'freeship applied.',
    events: [shown(1200, 'freeship applied.', '10% off applied')] }, 'accept');
  // 1K: "<single token> applied." is the storefront's code template, and CHANGES is a valid code value, so
  // "Changes applied." beside another code is a foreign-code claim (no list may rule a code value out).
  caseCase('"Changes applied." beside "freeship applied." reads as the code CHANGES', 'FREESHIP', { message: 'freeship applied.',
    events: [shown(1200, 'freeship applied.', 'Changes applied.')] }, 'reject');
  caseCase('"Your selections are saved with your account." beside "freeship applied."', 'FREESHIP', { message: 'freeship applied.',
    events: [shown(1200, 'freeship applied.', '', 'Your selections are saved with your account.')] }, 'accept');
  caseCase('product, service and selection copy beside "freeship applied."', 'FREESHIP', { message: 'freeship applied.',
    events: [shown(1200, 'freeship applied.', 'BL50 added to cart.', 'Discount applied to BR16. Shaping notes added. Your selections are saved.')] }, 'accept');
  // Fix 3: every committed mock mutation to the glove or its service, collected from the mock's own log,
  // must belong to exactly one tagged browser request, and carry a unique positive integer commitSeq.
  // A committed entry's evidence comes from the real fixture (1M: fixtureEvidence), unless marked asWritten.
  const commit = (tag, quantity, commitSeq, extra = {}) => ({ operation: 'UpdateLines', tag, cartId: 'cart', lines: pairOf(quantity), outcome: 'committed', commitSeq, ...extra });
  const tag = (value, written) => ({ ...written, tag: value });
  const logged1J = (finalLines, a, b, committedLog) => ({ ...plus(finalLines, a, b), committedLog });
  expect(plusOneGate, '1J: B\'s tagged commit of 3 is in the mock log but correlated to no action; A then commits 2', logged1J(at(2),
    act('A', silent, [tag('A-1', pair(2, { seq: 1, commitSeq: 2 }))]), act('B', disabledB, []), [commit('B-1', 3, 1), commit('A-1', 2, 2)]), 'reject');
  expect(plusOneGate, '1J: B\'s request tag differs from its committed mock entry (B seen as not received)', logged1J(at(2), act('A', silent, [tag('A-1', pair(2, { seq: 1, commitSeq: 2 }))]),
    act('B', disabledB, [tag('B-1', { ...pair(3), outcome: 'not seen by the mock', lifecycle: 'not received', commitSeq: null, seq: null })]), [commit('B-7', 3, 1), commit('A-1', 2, 2)]), 'reject');
  expect(plusOneGate, '1J: an untagged committed mock entry for this glove', logged1J(at(2), act('A', silent, [tag('A-1', pair(2, { commitSeq: 2 }))]), act('B', disabledB, []),
    [commit(null, 3, 1), commit('A-1', 2, 2)]), 'reject');
  expect(plusOneGate, '1J: two browser requests share one tag', logged1J(at(3), act('A', silent, [tag('T-1', pair(2, { commitSeq: 1 }))]), act('B', silent, [tag('T-1', pair(3, { commitSeq: 2 }))]),
    [commit('T-1', 2, 1), commit('T-2', 3, 2)]), 'reject');
  expect(plusOneGate, '1J: an action\'s commitSeq disagrees with the mock log for its tag', logged1J(at(3), act('A', silent, [tag('A-1', pair(2, { commitSeq: 1 }))]), act('B', silent, [tag('B-1', pair(3, { commitSeq: 2 }))]),
    [commit('A-1', 2, 3), commit('B-1', 3, 2)]), 'reject');
  expect(plusOneGate, '1J: B "accepted" with its write seen as rejected, but the mock committed it before A overwrote it', logged1J(at(2), act('A', silent, [tag('A-1', pair(2, { seq: 1, commitSeq: 2 }))]),
    act('B', silent, [tag('B-1', { ...pair(3), outcome: 'user-errors', lifecycle: 'rejected', userErrors: ['x'], commitSeq: null })]), [commit('B-1', 3, 1), commit('A-1', 2, 2)]), 'reject');
  expect(plusOneGate, '1J: a single committed write with no commitSeq', plus(at(2), act('A', silent, [pair(2, { commitSeq: undefined })]), act('B', disabledB, [])), 'reject');
  expect(plusOneGate, '1J: a single committed write with commitSeq 0', plus(at(2), act('A', silent, [pair(2, { commitSeq: 0 })]), act('B', disabledB, [])), 'reject');
  expect(plusOneGate, '1J: a committed write with a fractional commitSeq', plus(at(3), act('A', silent, [pair(2, { commitSeq: 1 })]), act('B', silent, [pair(3, { commitSeq: 1.5 })])), 'reject');
  expect(plusOneGate, '1J: no mock commit log supplied to the gate', { ...plus(at(2), act('A', silent, [tag('A-1', pair(2, { commitSeq: 1 }))]), act('B', disabledB, [])), committedLog: null }, 'reject');
  expect(plusOneGate, '1J: tagged and consistent; B not offered with no write', logged1J(at(2), act('A', silent, [tag('A-1', pair(2, { commitSeq: 1 }))]), act('B', disabledB, []), [commit('A-1', 2, 1)]), 'accept');
  expect(plusOneGate, '1J: B arrived first but committed second; both tagged and logged', logged1J(at(3), act('A', silent, [tag('A-1', pair(2, { seq: 2, commitSeq: 1 }))]),
    act('B', silent, [tag('B-1', pair(3, { seq: 1, commitSeq: 2 }))]), [commit('A-1', 2, 1), commit('B-1', 3, 2)]), 'accept');
  expect(plusOneGate, '1J: B refused by name; its rejected write is in the log but never committed', logged1J(at(2), act('A', silent, [tag('A-1', pair(2, { commitSeq: 1 }))]),
    act('B', named, [tag('B-1', { ...pair(3), outcome: 'user-errors', lifecycle: 'rejected', userErrors: ['x'], commitSeq: null })]),
    [commit('B-1', 3, null, { outcome: 'user-errors' }), commit('A-1', 2, 1)]), 'accept');
  expect(plusOneGate, '1J: unrelated commits (another cart, another line) need no browser request here', logged1J(at(2), act('A', silent, [tag('A-1', pair(2, { commitSeq: 2 }))]), act('B', disabledB, []),
    [commit('X-1', 5, 1, { cartId: 'other-cart' }), commit('A-1', 2, 2), commit('X-2', 4, 3, { lines: [{ id: 'x7', quantity: 4 }] })]), 'accept');

  // ---- Task 1K controls (added before the corrections; kept as permanent regression checks) ----
  // Fix A: the storefront's catch path (src/main.js discountAction → commerceErrorMessage(error, 'cart'))
  // shows "Couldn’t update your cart. Please try again." for an HTTP 200 with userErrors too: Shopify's
  // userErrors become a plain Error in updateDiscountCodes (src/commerce.js), with no error code.
  const unavailableErrors = discountWrite({ userErrors: ['Discount unavailable'] });
  const catchCopy = 'Couldn’t update your cart. Please try again.';
  busy('1K: the catch-path copy after HTTP 200 with userErrors "Discount unavailable"', { applyEnabled: true, writes: [unavailableErrors], codes: [], message: catchCopy, events: [said(1200, catchCopy)] }, 'accept');
  busy('1K: the catch-path copy after a successful, committed discount write', { applyEnabled: true, writes: [discountWrite()], codes: ['SYNTH10'], message: catchCopy, events: [said(1200, catchCopy)] }, 'reject');
  busy('1K: the catch-path copy with no discount write sent', { applyEnabled: true, writes: [], codes: [], message: catchCopy, events: [said(1200, catchCopy)] }, 'reject');
  busy('1K: the catch-path copy shown only before the failed write settled', { applyEnabled: true, writes: [unavailableErrors], codes: [], message: catchCopy, events: [said(1120, catchCopy)] }, 'reject');
  // Fix B: generic copy counts only as an exact storefront catch template; keywords never do.
  const genericCase = (write, message, wanted) => busy(`1K: "${message}" after ${writeLabel(write)}`, { applyEnabled: true, writes: [write], codes: [], message, events: [said(1200, message)] }, wanted);
  for (const message of ['Image service is unavailable.', 'The image network timed out.', 'Image service is unavailable for your discount.', 'Your discount’s image failed to load.',
    'The review network timed out.', 'Checkout service is unavailable.', 'Shipping network timed out.', 'Quantity service unavailable.', 'Order network timed out.',
    'Your discount code was checked and the image network timed out.', 'The image network timed out after your discount code was checked.',
    'Couldn’t reach Shopify. Check your connection and try again.', 'Service unavailable.']) genericCase(failed503, message, 'reject');
  genericCase(timedOut, 'The image network timed out.', 'reject');
  genericCase(failed503, catchCopy, 'accept');
  genericCase(timedOut, 'Shopify is taking too long to respond. Please try again.', 'accept');
  genericCase(failed503, 'The discount service is unavailable right now.', 'accept');
  // Fix C: "<submitted code> applied." (src/cart-discounts.js discountResultFeedback) is matched against the
  // submitted code first, normalized as the storefront does (codeKey: trim, then en-US lower case).
  const codeWrite = code => discountWrite({ discountCodes: [code] });
  const exactCase = (label, code, observation, wanted) => busy(`1K: ${label}`, { applyEnabled: true, code, codes: [code], writes: [codeWrite(code)], ...observation }, wanted);
  for (const [code, message] of [['SALE', 'SALE applied.'], ['BR16', 'BR16 applied.'], ['GO', 'GO applied.'], ['GO', 'go applied.'], ['SALE', 'Sale applied.']])
    exactCase(`"${message}" for the submitted code ${code}`, code, { message, events: [shown(1200, message)] }, 'accept');
  exactCase('"GO applied." followed by a Shopify warning', 'GO', { message: 'GO applied. Some items in your cart are not eligible.', events: [shown(1200, 'GO applied. Some items in your cart are not eligible.')] }, 'accept');
  exactCase('"SAVE20 applied." beside "BL50 added to cart."', 'SAVE20', { message: 'SAVE20 applied.', events: [shown(1200, 'SAVE20 applied.', 'BL50 added to cart.')] }, 'accept');
  exactCase('"SALE applied." in the announcer after SAVE20', 'SAVE20', { message: 'SAVE20 applied.', events: [shown(1200, 'SAVE20 applied.', 'SALE applied.')] }, 'reject');
  exactCase('"BR16 applied." in the checkout status after SAVE20', 'SAVE20', { message: 'SAVE20 applied.', events: [shown(1200, 'SAVE20 applied.', '', '', 'BR16 applied.')] }, 'reject');
  exactCase('"go applied." in the cart feedback after SAVE20', 'SAVE20', { message: 'SAVE20 applied.', events: [shown(1200, 'SAVE20 applied.', '', 'go applied.')] }, 'reject');
  exactCase('"SAVE20 applied. GO applied." after SAVE20', 'SAVE20', { message: 'SAVE20 applied. GO applied.', events: [shown(1200, 'SAVE20 applied. GO applied.')] }, 'reject');
  exactCase('"BL50 applied." after a code named BR16', 'BR16', { message: 'BL50 applied.', events: [shown(1200, 'BL50 applied.')] }, 'reject');
  // Fix D: removals and other mutations of the tracked glove or its service are audited too.
  const removal = (tagValue, lineIds, commitSeq, extra = {}) => ({ operation: 'RemoveLines', tag: tagValue, cartId: 'cart', lines: [], lineIds, outcome: 'committed', status: 200, userErrors: [],
    resultLines: [{ id: 'p1', quantity: 2 }], commitSeq, ...extra });
  const correlation = /belongs to exactly one tagged browser request/, removed = /removed/, declinedNothing = /committed nothing/;
  expectVerdict(plusOneGate, '1K: B\'s committed RemoveLines of the service is in the mock log with no browser request', logged1J(at(2),
    act('A', silent, [tag('A-1', pair(2, { commitSeq: 1 }))]), act('B', disabledB, []), [commit('A-1', 2, 1), removal('B-9', ['s1'], 2)]), correlation);
  expectVerdict(plusOneGate, '1K: not-offered B committed a RemoveLines of the service', logged1J(at(2), act('A', silent, [tag('A-1', pair(2, { commitSeq: 1 }))]),
    act('B', disabledB, [removal('B-1', ['s1'], 2)]), [commit('A-1', 2, 1), removal('B-1', ['s1'], 2)]), declinedNothing);
  expectVerdict(plusOneGate, '1K: a committed RemoveLines of the tracked glove during the race', logged1J(at(2), act('A', silent, [tag('A-1', pair(2, { commitSeq: 1 })), removal('A-2', ['p1'], 2)]),
    act('B', disabledB, []), [commit('A-1', 2, 1), removal('A-2', ['p1'], 2)]), removed);
  expectVerdict(plusOneGate, '1K: a committed RemoveLines of the service with no commitSeq', logged1J(at(2), act('A', silent, [tag('A-1', pair(2, { commitSeq: 1 })), removal('A-2', ['s1'], undefined)]),
    act('B', disabledB, []), [commit('A-1', 2, 1), removal('A-2', ['s1'], undefined)]), correlation);
  expectVerdict(plusOneGate, '1K: an UpdateLines and a RemoveLines in the mock log share one tag', logged1J(at(2), act('A', silent, [tag('A-1', pair(2, { commitSeq: 1 }))]), act('B', disabledB, []),
    [commit('A-1', 2, 1), removal('A-1', ['s1'], 2)]), correlation);
  expectVerdict(plusOneGate, '1K: not-offered B committed an AddLines nesting another service under the glove', logged1J(at(2), act('A', silent, [tag('A-1', pair(2, { commitSeq: 1 }))]),
    act('B', disabledB, [{ operation: 'AddLines', tag: 'B-1', cartId: 'cart', lines: [{ merchandiseId: TRAINER_SERVICE_VARIANT, quantity: 1, parent: { lineId: 'p1' } }], outcome: 'committed', status: 200, userErrors: [], resultLines: null, commitSeq: 2 }]),
    [commit('A-1', 2, 1), { operation: 'AddLines', tag: 'B-1', cartId: 'cart', lines: [{ merchandiseId: TRAINER_SERVICE_VARIANT, quantity: 1, parent: { lineId: 'p1' } }], outcome: 'committed', commitSeq: 2 }]), declinedNothing);
  expect(plusOneGate, '1K: an unrelated RemoveLines of another line, tagged and correlated', logged1J(at(2), act('A', silent, [tag('A-1', pair(2, { commitSeq: 1 })), removal('A-2', ['x7'], 2)]),
    act('B', disabledB, []), [commit('A-1', 2, 1), removal('A-2', ['x7'], 2)]), 'accept');
  expect(plusOneGate, '1K: 2/2 then 3/3 with every mutation audited and tagged', logged1J(at(3), act('A', silent, [tag('A-1', pair(2, { commitSeq: 1 }))]), act('B', silent, [tag('B-1', pair(3, { commitSeq: 2 }))]),
    [commit('A-1', 2, 1), commit('B-1', 3, 2)]), 'accept');

  // ---- Task 1L controls (added before the corrections; kept as permanent regression checks) ----
  // A rejection must come only from the named verdicts, never from an unrelated final-state assertion.
  const expectOnly = (gate, label, observation, patterns) => {
    const verdicts = gate(gate === plusOneGate ? prepared(observation) : observation);
    const failing = verdicts.filter(item => !item.pass).map(item => item.name);
    check('harness', `rejects: ${label}`, failing.length > 0 && failing.every(name => patterns.some(pattern => pattern.test(name))), { expected: patterns.map(String), failing });
  };
  // Fix 1: completion, membership and applicability are separate facts. src/cart-discounts.js shows
  // "Discount code isn’t valid for this cart." for an HTTP 200 update that left the code applicable:false.
  const notValid = 'Discount code isn’t valid for this cart.';
  const state = (code, applicable) => ({ code, applicable });
  const settled = (label, observation, wanted) => busy(`1L: ${label}`, { applyEnabled: true, code: 'SAVE20', writes: [discountWrite({ discountCodes: ['SAVE20'] })], ...observation }, wanted);
  settled('committed, code present with applicable:false, truthful not-valid copy', { codes: ['SAVE20'], codeStates: [state('SAVE20', false)], message: notValid, events: [said(1200, notValid)] }, 'accept');
  settled('committed and applicable:true, "SAVE20 applied."', { codes: ['SAVE20'], codeStates: [state('SAVE20', true)], message: 'SAVE20 applied.', events: [said(1200, 'SAVE20 applied.')] }, 'accept');
  settled('applicable:false but "SAVE20 applied." claimed', { codes: ['SAVE20'], codeStates: [state('SAVE20', false)], message: 'SAVE20 applied.', events: [said(1200, 'SAVE20 applied.')] }, 'reject');
  settled('applicable:false with the not-valid copy shown before the write committed', { codes: ['SAVE20'], codeStates: [state('SAVE20', false)], message: notValid, events: [said(1120, notValid)] }, 'reject');
  settled('applicable:false with the catch copy (no thrown failure happened)', { codes: ['SAVE20'], codeStates: [state('SAVE20', false)], message: catchCopy, events: [said(1200, catchCopy)] }, 'reject');
  settled('success claimed with applicability not verified', { codes: ['SAVE20'], codeStates: [{ code: 'SAVE20' }], message: 'SAVE20 applied.', events: [said(1200, 'SAVE20 applied.')] }, 'reject');
  settled('a committed write that left the code off the cart, with the not-valid copy', { codes: [], codeStates: [], message: notValid, events: [said(1200, notValid)] }, 'reject');
  settled('userErrors rejection with the catch copy', { writes: [discountWrite({ discountCodes: ['SAVE20'], userErrors: ['Discount unavailable'] })], codes: [], codeStates: [], message: catchCopy, events: [said(1200, catchCopy)] }, 'accept');
  settled('malformed HTTP 200 response (no cart returned), with the catch copy', { writes: [discountWrite({ discountCodes: ['SAVE20'], returnedCartId: null, commitSeq: undefined, outcome: 'malformed' })], codes: [], codeStates: [], message: catchCopy, events: [said(1200, catchCopy)] }, 'accept');
  settled('malformed HTTP 200 response (no cart returned), with "SAVE20 applied."', { writes: [discountWrite({ discountCodes: ['SAVE20'], returnedCartId: null, commitSeq: undefined, outcome: 'malformed' })], codes: ['SAVE20'], codeStates: [state('SAVE20', true)], message: 'SAVE20 applied.', events: [said(1200, 'SAVE20 applied.')] }, 'reject');
  settled('pending request with premature not-valid copy', { writes: [discountWrite({ discountCodes: ['SAVE20'], status: 0, outcome: 'pending', committedAt: undefined, finishedAt: undefined })], codes: [], codeStates: [], message: notValid, events: [said(1200, notValid)] }, 'reject');
  settled('pending request with premature catch copy', { writes: [discountWrite({ discountCodes: ['SAVE20'], status: 0, outcome: 'pending', committedAt: undefined, finishedAt: undefined })], codes: [], codeStates: [], message: catchCopy, events: [said(1200, catchCopy)] }, 'reject');
  // Fix 2: top-level GraphQL errors at HTTP 200 throw in shopifyRequest (code 'graphql') and show the catch copy.
  const graphql = discountWrite({ discountCodes: ['SAVE20'], status: 200, userErrors: [], graphqlErrors: ['Internal error'], outcome: 'failed-before-commit', committedAt: undefined, commitSeq: undefined });
  settled('HTTP 200 with GraphQL errors, the catch copy after it settled', { writes: [graphql], codes: [], codeStates: [], message: catchCopy, events: [said(1200, catchCopy)] }, 'accept');
  settled('HTTP 200 with GraphQL errors, the catch copy only before it settled', { writes: [graphql], codes: [], codeStates: [], message: catchCopy, events: [said(1120, catchCopy)] }, 'reject');
  settled('HTTP 200 with GraphQL errors and "SAVE20 applied."', { writes: [graphql], codes: [], codeStates: [], message: 'SAVE20 applied.', events: [said(1200, 'SAVE20 applied.')] }, 'reject');
  settled('HTTP 200 with GraphQL errors and the connection-lost copy (Shopify did answer)', { writes: [graphql], codes: [], codeStates: [], message: 'Connection lost. Check your connection and try again.', events: [said(1200, 'Connection lost. Check your connection and try again.')] }, 'reject');
  settled('HTTP 503, the catch copy', { writes: [discountWrite({ discountCodes: ['SAVE20'], status: 503 })], codes: [], codeStates: [], message: catchCopy, events: [said(1200, catchCopy)] }, 'accept');
  settled('a successful commit followed by the catch copy', { codes: ['SAVE20'], codeStates: [state('SAVE20', true)], message: catchCopy, events: [said(1200, catchCopy)] }, 'reject');
  // Fix 3: codes compare by the storefront's codeKey (trim, en-US lower case) everywhere; the message
  // is still the shopper's trimmed spelling (`${code} applied.`), while Shopify may return its own.
  const keyed = (label, typed, sent, shopify, message, extra, wanted) => busy(`1L: ${label}`, { applyEnabled: true, code: typed, writes: [discountWrite({ discountCodes: [sent] })],
    codes: [shopify], codeStates: [state(shopify, true)], message, events: [shown(1200, message, ...(extra || []))] }, wanted);
  for (const [typed, shopify] of [['sAlE', 'SALE'], ['gO', 'GO'], ['bR16', 'BR16'], ['FreeShip', 'FREESHIP'], ['SaVe20', 'SAVE20']])
    keyed(`typed "${typed}", Shopify returns "${shopify}", "${typed} applied."`, typed, typed, shopify, `${typed} applied.`, null, 'accept');
  keyed('typed "  SaVe20 " (trimmed by the storefront), Shopify returns "SAVE20"', '  SaVe20 ', 'SaVe20', 'SAVE20', 'SaVe20 applied.', null, 'accept');
  keyed('typed "sAlE", Shopify "SALE", but the announcer says "GO applied."', 'sAlE', 'sAlE', 'SALE', 'sAlE applied.', ['GO applied.'], 'reject');
  keyed('typed "sAlE", but Shopify holds a different code "SALES"', 'sAlE', 'sAlE', 'SALES', 'sAlE applied.', null, 'reject');
  keyed('typed "sAlE", but the write sent "SALE2"', 'sAlE', 'SALE2', 'SALE2', 'sAlE applied.', null, 'reject');
  expect(discountGate, '1L: case variants of the same codes are identical by codeKey', { start: ['synth10'], final: ['SYNTH10', 'SYNTH5'], actions: [
    { tab: 'A', kind: 'apply', code: 'synth5', claimed: true, refusal: silent }, { tab: 'B', kind: 'remove', code: 'SYNTH5x', claimed: false, refusal: refused }] }, 'accept');
  expect(discountGate, '1L: an unrelated code removed while only an apply was confirmed', { start: ['synth10'], final: ['SYNTH5'], actions: [
    { tab: 'A', kind: 'apply', code: 'Synth5', claimed: true, refusal: silent }] }, 'reject');
  // Fix 4: nested AddLines. The mock's own committed effects decide; the correlator must keep parent data.
  const addLines = (tagValue, parent, commitSeq, effects, cartAfter) => ({ operation: 'AddLines', tag: tagValue, cartId: 'cart', lines: [{ merchandiseId: TRAINER_SERVICE_VARIANT, quantity: 1, parent }],
    lineIds: [], outcome: 'committed', status: 200, userErrors: [], commitSeq, effects, cartAfter });
  const serviceTo2 = [{ id: 's1', previousId: 's1', parentId: 'p1', merchandiseId: TRAINER_SERVICE_VARIANT, before: 1, after: 2, change: 'changed' }];
  const after = (glove, child) => [{ id: 'p1', parentId: null, quantity: glove }, { id: 's1', parentId: 'p1', quantity: child }];
  const gloveTo2 = commit('A-1', 2, 2, { lines: [{ id: 'p1', quantity: 2 }], effects: [{ id: 'p1', previousId: 'p1', parentId: null, before: 1, after: 2, change: 'changed' }], cartAfter: after(2, 2) });
  // B's write as the browser correlator records it today: the parent is lost.
  const lostParent = (tagValue, commitSeq) => ({ operation: 'AddLines', tag: tagValue, cartId: 'cart', lines: [{ quantity: 1 }], outcome: 'committed', status: 200, userErrors: [], resultLines: null, commitSeq, lifecycle: 'committed' });
  const audit = [/committed nothing/, /service stays at the glove quantity in every committed state/, /belongs to exactly one tagged browser request/];
  for (const [form, parent] of [['parent by line ID', { lineId: 'p1' }], ['parent by merchandise', { merchandiseId: 'gid://variant/br16' }]]) {
    for (const [state1, refusal] of [['not-offered', disabledB], ['refused', named]])
      expectOnly(plusOneGate, `1L: ${state1} B's nested AddLines (${form}) committed 1/2 before A's 2/2`, logged1J(at(2), act('A', silent, [tag('A-1', { ...write(2), lines: [{ id: 'p1', quantity: 2 }], commitSeq: 2 })]),
        act('B', refusal, [lostParent('B-1', 1)]), [addLines('B-1', parent, 1, serviceTo2, after(1, 2)), gloveTo2]), audit);
  }
  expectOnly(plusOneGate, '1L: A\'s service-only 3, later restored to 2/2', logged1J(at(2), act('A', silent, [tag('A-1', { ...write(2), lines: [{ id: 'p1', quantity: 2 }], commitSeq: 1 }), tag('A-2', { ...write(3, { lineId: 's1' }), commitSeq: 2 }), tag('A-3', { ...write(2, { lineId: 's1' }), commitSeq: 3 })]),
    act('B', disabledB, []), [commit('A-1', 2, 1, { lines: [{ id: 'p1', quantity: 2 }], effects: [{ id: 'p1', previousId: 'p1', parentId: null, before: 1, after: 2, change: 'changed' }], cartAfter: after(2, 1) }),
    commit('A-2', 3, 2, { lines: [{ id: 's1', quantity: 3 }], effects: [{ id: 's1', previousId: 's1', parentId: 'p1', before: 1, after: 3, change: 'changed' }], cartAfter: after(2, 3) }),
    commit('A-3', 2, 3, { lines: [{ id: 's1', quantity: 2 }], effects: [{ id: 's1', previousId: 's1', parentId: 'p1', before: 3, after: 2, change: 'changed' }], cartAfter: after(2, 2) })]),
    [/service stays at the glove quantity in every committed state/, /only ever raised/]);
  expectOnly(plusOneGate, '1L: a relevant committed mutation whose operation differs from its tagged request', logged1J(at(2), act('A', silent, [tag('A-1', { ...write(2), lines: [{ id: 'p1', quantity: 2 }], commitSeq: 2 })]),
    act('B', disabledB, [{ ...lostParent('B-1', 1), operation: 'UpdateLines', lines: [{ id: 'x7', quantity: 1 }] }]), [addLines('B-1', { lineId: 'p1' }, 1, serviceTo2, after(1, 2)), gloveTo2]), audit);
  expectOnly(plusOneGate, '1L: a committed line mutation for this cart with no recorded effects', logged1J(at(2), act('A', silent, [tag('A-1', { ...write(2), lines: [{ id: 'p1', quantity: 2 }], commitSeq: 1 })]),
    act('B', disabledB, [lostParent('B-1', 2)]), [commit('A-1', 2, 1, { lines: [{ id: 'p1', quantity: 2 }], effects: [{ id: 'p1', previousId: 'p1', parentId: null, before: 1, after: 2, change: 'changed' }], cartAfter: after(2, 2) }),
      { operation: 'AddLines', tag: 'B-1', cartId: 'cart', lines: [{ merchandiseId: TRAINER_SERVICE_VARIANT, quantity: 1, parent: { merchandiseId: 'gid://variant/br16' } }], outcome: 'committed', commitSeq: 2, asWritten: true }]), audit);
  expect(plusOneGate, '1L: the storefront\'s glove-then-service sync (2 then 2), with effects', logged1J(at(2), act('A', silent, [tag('A-1', { ...write(2), lines: [{ id: 'p1', quantity: 2 }], commitSeq: 1 }), tag('A-2', { ...write(2, { lineId: 's1' }), commitSeq: 2 })]),
    act('B', disabledB, []), [commit('A-1', 2, 1, { lines: [{ id: 'p1', quantity: 2 }], effects: [{ id: 'p1', previousId: 'p1', parentId: null, before: 1, after: 2, change: 'changed' }], cartAfter: after(2, 1) }),
    commit('A-2', 2, 2, { lines: [{ id: 's1', quantity: 2 }], effects: [{ id: 's1', previousId: 's1', parentId: 'p1', before: 1, after: 2, change: 'changed' }], cartAfter: after(2, 2) })]), 'accept');
  expect(plusOneGate, '1L: rebased 2/2 then 3/3, with effects', logged1J(at(3), act('A', silent, [tag('A-1', pair(2, { commitSeq: 1 }))]), act('B', silent, [tag('B-1', pair(3, { commitSeq: 2 }))]),
    [commit('A-1', 2, 1, { effects: [{ id: 'p1', previousId: 'p1', parentId: null, before: 1, after: 2, change: 'changed' }, { id: 's1', previousId: 's1', parentId: 'p1', before: 1, after: 2, change: 'changed' }], cartAfter: after(2, 2) }),
      commit('B-1', 3, 2, { effects: [{ id: 'p1', previousId: 'p1', parentId: null, before: 2, after: 3, change: 'changed' }, { id: 's1', previousId: 's1', parentId: 'p1', before: 2, after: 3, change: 'changed' }], cartAfter: after(3, 3) })]), 'accept');
  expect(plusOneGate, '1L: refused B whose nested AddLines was rejected (never committed)', logged1J(at(2), act('A', silent, [tag('A-1', { ...pair(2), commitSeq: 1 })]),
    act('B', named, [{ ...lostParent('B-1', null), outcome: 'user-errors', lifecycle: 'rejected', userErrors: ['x'] }]),
    [commit('A-1', 2, 1, { effects: [{ id: 'p1', previousId: 'p1', parentId: null, before: 1, after: 2, change: 'changed' }, { id: 's1', previousId: 's1', parentId: 'p1', before: 1, after: 2, change: 'changed' }], cartAfter: after(2, 2) }),
      { ...addLines('B-1', { lineId: 'p1' }, null, undefined, undefined), outcome: 'user-errors' }]), 'accept');
  // The browser capture keeps parent and merchandise data for correlation.
  const captured = requestLinesOf({ lines: [{ merchandiseId: TRAINER_SERVICE_VARIANT, quantity: 1, parent: { lineId: 'p1' } }, { merchandiseId: TRAINER_SERVICE_VARIANT, quantity: 1, parent: { merchandiseId: 'gid://variant/br16' } }] });
  check('harness', '1L: the browser request capture keeps nested parent data (by line ID and by merchandise)',
    captured[0]?.parent?.lineId === 'p1' && captured[1]?.parent?.merchandiseId === 'gid://variant/br16' && captured.every(line => line.merchandiseId === TRAINER_SERVICE_VARIANT), { captured });
  // Mock level: the same races run against the real fixture (createStorefrontMock). Each request is
  // logged as the server logs it (effects and cartAfter from the mock itself), captured as the CDP layer
  // captures it (requestLinesOf), and correlated by the real correlator before it reaches the gate.
  const SELECTION = FIXTURE_SELECTION;
  const mockRace = (steps, options = {}) => {
    const mock = createStorefrontMock({ checkoutHost: 'checkout.invalid', ...options });
    const choices = [{ key: 'Break-In Level', value: 'Firm (40%)' }, { key: 'Glove Wearing Style', value: 'Traditional' }];
    const { cart: created } = mock.execute(`mutation CreateCart($input: CartInput!) { cartCreate(input: $input) { ${SELECTION} } }`, { input: { lines: [
      { merchandiseId: 'gid://variant/br16', quantity: 1, attributes: [{ key: '_anawin_service', value: 'break-in' }, { key: '_anawin_break_in_level', value: 'Firm (40%)' }, { key: '_anawin_wearing_style', value: 'Traditional' }] },
      { merchandiseId: TRAINER_SERVICE_VARIANT, quantity: 1, attributes: choices, parent: { merchandiseId: 'gid://variant/br16' } }] } }).cartCreate;
    const cartId = created.id;
    const [start] = gloves(mock.cart(cartId).lines);
    const ids = { glove: start.id, service: start.services[0].id };
    const log = [], requests = [];
    let commits = 0;
    for (const [index, { tab, operation, lines }] of steps.entries()) {
      const variables = { cartId, lines: lines(ids) };
      const tagValue = `${tab}-${index + 1}`;
      requests.push({ tab, operation, cartId, lines: requestLinesOf(variables), lineIds: [], tag: tagValue });
      const data = mock.execute(`mutation ${operation}($cartId: ID!) { x(cartId: $cartId) { ${SELECTION} } }`, variables);
      const payload = Object.values(data)[0];
      const entry = { seq: index + 1, operation, cartId, tag: tagValue, lines: variables.lines.map(line => ({ id: line.id, merchandiseId: line.merchandiseId, quantity: line.quantity, parent: line.parent || undefined })),
        lineIds: [], status: 200, userErrors: payload.userErrors.map(error => error.message), attemptedAt: index + 1 };
      if (!entry.userErrors.length) { entry.commitSeq = ++commits; const effects = mock.lastEffects(); if (effects) { entry.cartBefore = effects.cartBefore; entry.effects = effects.lines; entry.cartAfter = effects.cartAfter; } }
      entry.outcome = entry.userErrors.length ? 'user-errors' : 'committed';
      entry.resultLines = payload.cart?.lines.nodes.map(line => ({ id: line.id, quantity: line.quantity })) ?? null;
      log.push(entry);
    }
    const writes = {};
    for (const operation of ['UpdateLines', 'RemoveLines', 'AddLines']) for (const [tab, items] of Object.entries(correlateRequests(requests, log, operation))) (writes[tab] ||= []).push(...items);
    return { ids, log, writes, observation: refusals => ({ name: 'BR16', initial: start, cartId, finalLines: mock.cart(cartId).lines,
      actions: ['A', 'B'].map(tab => ({ tab, refusal: refusals[tab], writes: writes[tab] || [] })), committedLog: log }) };
  };
  const nestedAdd = parent => ({ tab: 'B', operation: 'AddLines', lines: ids => [{ merchandiseId: TRAINER_SERVICE_VARIANT, quantity: 1, parent: parent(ids) }] });
  const gloveTo = quantity => ({ tab: 'A', operation: 'UpdateLines', lines: ids => [{ id: ids.glove, quantity }] });
  for (const [form, parent] of [['parent by line ID', ids => ({ lineId: ids.glove })], ['parent by merchandise', () => ({ merchandiseId: 'gid://variant/br16' })]]) {
    const nested = mockRace([nestedAdd(parent), gloveTo(2)]);
    const [added, raised] = nested.log;
    check('harness', `1L (mock): the fixture records B's nested AddLines (${form}) as raising the service under the glove to 2, then A's glove to 2`,
      // 1M effect shape: the service's full view before and after; only its quantity changed.
      added.effects.length === 1 && added.effects[0].change === 'changed' && added.effects[0].id === nested.ids.service && added.effects[0].previousId === nested.ids.service &&
      added.effects[0].before.quantity === 1 && added.effects[0].after.quantity === 2 && added.effects[0].after.parentId === nested.ids.glove &&
      added.effects[0].after.merchandiseId === TRAINER_SERVICE_VARIANT && same({ ...added.effects[0].before, quantity: 2 }, added.effects[0].after) &&
      same(added.cartAfter.map(line => line.quantity), [1, 2]) && same(raised.cartAfter.map(line => line.quantity), [2, 2]) &&
      nested.writes.B?.length === 1 && nested.writes.B[0].lifecycle === 'committed' && nested.writes.B[0].commitSeq === added.commitSeq, { log: nested.log, writes: nested.writes });
    for (const [state1, refusal] of [['not-offered', disabledB], ['refused', named]])
      expectOnly(plusOneGate, `1L (mock): ${state1} B's nested AddLines (${form}) committed 1/2 before A's 2/2`, nested.observation({ A: silent, B: refusal }), audit);
  }
  // The storefront's own sequence, serialized and rebased: glove then service for A, then for B.
  const serviceTo = (tab, quantity) => ({ tab, operation: 'UpdateLines', lines: ids => [{ id: ids.service, quantity }] });
  expect(plusOneGate, '1L (mock): serialized and rebased glove-then-service writes, 2/2 then 3/3', mockRace([gloveTo(2), serviceTo('A', 2), { ...gloveTo(3), tab: 'B' }, serviceTo('B', 3)])
    .observation({ A: silent, B: silent }), 'accept');
  expect(plusOneGate, '1L (mock): B refused with nothing sent; A 2 then 2', mockRace([gloveTo(2), serviceTo('A', 2)]).observation({ A: silent, B: named }), 'accept');

  // ---- Task 1M controls (added before the corrections; kept as permanent regression checks) ----
  // Fix A: effects are evidence and must be complete and consistent with the fixture's own before and
  // after snapshots. Each manipulation starts from the real fixture's serialized race 2/1 → 2/2 → 3/2 →
  // 3/3 and must be rejected by the harness evidence verdict alone.
  const evidence = /consistent recorded effects/, configured = /configuration/;
  const serialized = options => mockRace([gloveTo(2), serviceTo('A', 2), { ...gloveTo(3), tab: 'B' }, serviceTo('B', 3)], options);
  const verdictCase = (label, observation, pattern, pass) => {
    const named = plusOneGate(prepared(observation)).filter(item => pattern.test(item.name));
    check('harness', `1M (mock): ${label}`, named.length > 0 && named.every(item => item.pass === pass), { verdict: String(pattern), pass, named: named.map(item => ({ name: item.name, pass: item.pass, detail: item.detail })) });
  };
  const tampered = (label, edit) => {
    const run = serialized();
    const observation = run.observation({ A: silent, B: silent });
    observation.committedLog = structuredClone(observation.committedLog);
    edit(observation.committedLog, run.ids);
    expectOnly(plusOneGate, `1M (mock): ${label}`, observation, [evidence]);
  };
  const effectOf = (entry, id) => entry.effects.find(effect => effect.id === id);
  const setBefore = (effect, quantity) => { if (effect.before && typeof effect.before === 'object') effect.before.quantity = quantity; else effect.before = quantity; };
  const setMerchandise = (effect, merchandiseId) => { effect.merchandiseId = merchandiseId; for (const view of [effect.before, effect.after]) if (view && typeof view === 'object') view.merchandiseId = merchandiseId; };
  expect(plusOneGate, '1M (mock): the untampered serialized race 2/1 → 2/2 → 3/2 → 3/3', serialized().observation({ A: silent, B: silent }), 'accept');
  tampered('the service effect of A\'s 2/2 deleted, leaving effects: []', log => { log[1].effects = []; });
  tampered('A\'s glove effect claims a before quantity of 99', (log, ids) => { setBefore(effectOf(log[0], ids.glove), 99); });
  tampered('A\'s glove effect names another merchandise ID', (log, ids) => { setMerchandise(effectOf(log[0], ids.glove), 'gid://variant/ob16'); });
  tampered('B\'s 3/2 cartAfter lists the glove line twice', (log, ids) => { log[2].cartAfter.push({ ...log[2].cartAfter.find(line => line.id === ids.glove) }); });
  tampered('B\'s 3/2 cartAfter parents the service to a line that does not exist', (log, ids) => { log[2].cartAfter.find(line => line.id === ids.service).parentId = 'gid://shopify/CartLine/404'; });
  tampered('B\'s 3/2 cartAfter has a line without an ID', (log, ids) => { delete log[2].cartAfter.find(line => line.id === ids.glove).id; });
  tampered('a spurious effect for the unchanged service in B\'s 3/2', (log, ids) => { log[2].effects.push({ ...structuredClone(effectOf(log[1], ids.service)) }); });
  tampered('A\'s 2/2 has no before snapshot', log => { delete log[1].cartBefore; });
  tampered('B\'s 3/2 before snapshot is not the cart A\'s 2/2 left', log => { if (log[2].cartBefore) log[2].cartBefore = log[2].cartBefore.map(line => ({ ...line, quantity: 5 })); else log[2].cartBefore = []; });
  // A rekey must name a real line before and its new ID after. A real rekeying fixture passes the evidence
  // verdict (its other verdicts fail on the changed IDs, by design); a rekey from a line that never existed fails it.
  const rekeying = () => mockRace([{ tab: 'A', operation: 'UpdateLines', lines: ids => [{ id: ids.glove, quantity: 2 }, { id: ids.service, quantity: 2 }] }], { rekeyOnQuantityUpdate: true });
  verdictCase('a real rekeying commit passes the evidence verdict', rekeying().observation({ A: silent, B: named }), evidence, true);
  const misrekeyed = rekeying().observation({ A: silent, B: named });
  misrekeyed.committedLog = structuredClone(misrekeyed.committedLog);
  for (const effect of misrekeyed.committedLog[0].effects) if (effect.change === 'rekeyed' && effect.parentId == null && !(effect.after && effect.after.parentId)) effect.previousId = 'gid://shopify/CartLine/777';
  verdictCase('a rekey from a line ID that never existed fails the evidence verdict', misrekeyed, evidence, false);
  // Every mock log entry for this cart, committed or not, belongs to a browser request (complete log check).
  const orphaned = serialized().observation({ A: silent, B: silent });
  orphaned.committedLog = [...orphaned.committedLog, { seq: 99, operation: 'AddLines', cartId: orphaned.cartId, tag: 'Z-9', lines: [{ merchandiseId: TRAINER_SERVICE_VARIANT, quantity: 1, parent: { merchandiseId: 'gid://variant/br16' } }],
    lineIds: [], status: 200, userErrors: ['The cart changed.'], outcome: 'user-errors', attemptedAt: 99, resultLines: null }];
  expectOnly(plusOneGate, '1M (mock): a rejected nested AddLines in the mock log that no browser request sent', orphaned, [evidence]);
  // Fix B: attribute changes are committed changes. Temporary Break-In configuration changes to the
  // tracked glove or service during the +1 race are rejected even when restored before the +1.
  const serviceChoices = level => [{ key: 'Break-In Level', value: level }, { key: 'Glove Wearing Style', value: 'Traditional' }];
  const gloveChoices = style => [{ key: '_anawin_service', value: 'break-in' }, { key: '_anawin_break_in_level', value: 'Firm (40%)' }, { key: '_anawin_wearing_style', value: style }];
  const setServiceChoices = (tab, level) => ({ tab, operation: 'UpdateLines', lines: ids => [{ id: ids.service, attributes: serviceChoices(level) }] });
  const setGloveChoices = (tab, style) => ({ tab, operation: 'UpdateLines', lines: ids => [{ id: ids.glove, attributes: gloveChoices(style) }] });
  const levelRace = mockRace([setServiceChoices('A', 'Game Ready (90%)'), setServiceChoices('A', 'Firm (40%)'), gloveTo(2), serviceTo('A', 2)]);
  check('harness', '1M (mock): the fixture records an attribute-only change of the service as a committed effect', levelRace.log[0].effects?.length === 1 && levelRace.log[0].effects[0].id === levelRace.ids.service, { effects: levelRace.log[0].effects });
  expectOnly(plusOneGate, '1M (mock): A changes the service\'s Break-In Level, restores it, then +1 to 2/2', levelRace.observation({ A: silent, B: named }), [configured]);
  expectOnly(plusOneGate, '1M (mock): A changes the glove\'s wearing style, restores it, then +1 to 2/2', mockRace([setGloveChoices('A', 'Two-Finger'), setGloveChoices('A', 'Traditional'), gloveTo(2), serviceTo('A', 2)])
    .observation({ A: silent, B: named }), [configured]);
  expectOnly(plusOneGate, '1M (mock): refused B changes the service\'s Break-In Level and restores it while A goes to 2/2', mockRace([gloveTo(2), setServiceChoices('B', 'Game Ready (90%)'), serviceTo('A', 2), setServiceChoices('B', 'Firm (40%)')])
    .observation({ A: silent, B: named }), [configured, /committed nothing/]);
  // Legitimate attribute persistence: rewriting the same choices changes nothing and is accepted.
  expect(plusOneGate, '1M (mock): the service\'s choices rewritten unchanged, then +1 to 2/2', mockRace([setServiceChoices('A', 'Firm (40%)'), gloveTo(2), serviceTo('A', 2)]).observation({ A: silent, B: named }), 'accept');
  // Fix C: a discount write is a committed success only if the mock committed it and the response names
  // the requested cart, as src/commerce.js updateDiscountCodes requires (updated.id === cartId).
  const other = 'gid://shopify/Cart/999999?key=k999999';
  const credited = (label, write, wanted, observation = {}) => busy(`1M: ${label}`, { applyEnabled: true, code: 'SAVE20', writes: [discountWrite({ discountCodes: ['SAVE20'], ...write })],
    codes: ['SAVE20'], codeStates: [state('SAVE20', true)], message: 'SAVE20 applied.', events: [said(1200, 'SAVE20 applied.')], ...observation }, wanted);
  const caught = { codes: [], codeStates: [], message: catchCopy, events: [said(1200, catchCopy)] };
  credited('truthful "SAVE20 applied.", applicable, but the response omits the cart ID', { returnedCartId: undefined }, 'reject');
  credited('truthful "SAVE20 applied.", applicable, but the response cart ID is null', { returnedCartId: null }, 'reject');
  credited('truthful "SAVE20 applied.", applicable, but the response cart ID is blank', { returnedCartId: '  ' }, 'reject');
  credited('truthful "SAVE20 applied.", applicable, but the response names an unrelated cart', { returnedCartId: other }, 'reject');
  credited('truthful "SAVE20 applied.", applicable, but the mock log has no commit for it', { commitSeq: undefined }, 'reject');
  credited('the not-valid copy with applicable:false, but the response names an unrelated cart', { returnedCartId: other }, 'reject', { codeStates: [state('SAVE20', false)], message: notValid, events: [said(1200, notValid)] });
  credited('honest: committed, the response names the requested cart, "SAVE20 applied."', {}, 'accept');
  busy('1M: honest: typed "sAvE20", Shopify spells it SAVE20, the response names the requested cart', { applyEnabled: true, code: 'sAvE20', writes: [discountWrite({ discountCodes: ['sAvE20'] })],
    codes: ['SAVE20'], codeStates: [state('SAVE20', true)], message: 'sAvE20 applied.', events: [said(1200, 'sAvE20 applied.')] }, 'accept');
  credited('the response names an unrelated cart, nothing committed, the catch copy', { returnedCartId: other, commitSeq: undefined, outcome: 'response-forged' }, 'accept', caught);
  credited('the response has no cart, nothing committed, the catch copy', { returnedCartId: null, commitSeq: undefined, outcome: 'response-forged' }, 'accept', caught);

  // ---- Task 1N controls (added before the correction; kept as permanent regression checks) ----
  // Five independent facts: whether Shopify committed, whether the response names the requested cart,
  // whether the code is present and applicable, whether the storefront accepted the response, and whether
  // the shopper got truthful, settled feedback. A remote commit never makes a response safe to accept.
  // Each case runs the discount write on the real fixture, committed or dry-run as the server's forgeNext
  // modes do, and reads the code state and commit count from the fixture itself.
  const returnedIds = { matching: id => id, unrelated: () => other, blank: () => '', omitted: () => null };
  const fixtureDiscount = ({ commit, response, typed = 'sAvE20', codeCase = 'as-sent', outcome }) => {
    const mock = createStorefrontMock({ checkoutHost: 'checkout.invalid', acceptedCodes: ['SAVE20'], codeCase });
    const { cart: created } = mock.execute(`mutation CreateCart($input: CartInput!) { cartCreate(input: $input) { ${FIXTURE_SELECTION} } }`,
      { input: { lines: [{ merchandiseId: 'gid://variant/br16', quantity: 2, attributes: none }] } }).cartCreate;
    const submitted = [typed.trim()];
    let commits = 0;
    if (!outcome) {
      const data = mock.execute(`mutation UpdateDiscountCodes($cartId: ID!) { x(cartId: $cartId) { ${FIXTURE_SELECTION} } }`, { cartId: created.id, discountCodes: submitted }, { dryRun: !commit });
      if (Object.values(data)[0].userErrors.length) throw new Error('fixtureDiscount: the fixture rejected the discount write');
      if (commit) commits++;
    }
    const saved = mock.cart(created.id);
    const write = { seq: 11, cartId: created.id, startedAt: 1100, finishedAt: 1160, status: 200, userErrors: [], discountCodes: submitted,
      ...(outcome ?? (commit ? { committedAt: 1150, commitSeq: commits, outcome: response === 'matching' ? 'committed' : 'committed-response-substituted' } : { outcome: 'response-forged' })),
      returnedCartId: outcome ? null : returnedIds[response](created.id) };
    return { cartId: created.id, write, saved, commits };
  };
  const matrix = (label, { commit, response, outcome, typed = 'sAvE20', codeCase }, feedback, wanted, change = observation => observation) => {
    const run = fixtureDiscount({ commit, response, typed, codeCase, outcome });
    const codeOnCart = run.saved.discountApplicability.some(item => codeKey(item.code) === codeKey(typed));
    check('harness', `1N (fixture): ${label}: the fixture saved the code only if it committed, with ${commit ? 1 : 0} commit(s)`,
      codeOnCart === !!commit && run.commits === (commit ? 1 : 0) && run.saved.discountCodes.length === (commit ? 1 : 0), { saved: run.saved.discountApplicability, commits: run.commits });
    const message = feedback === 'success' ? `${typed.trim()} applied.` : catchCopy;
    busy(`1N: ${label}`, change({ applyEnabled: true, code: typed, cartId: run.cartId, writes: [run.write], codes: run.saved.discountCodes,
      codeStates: run.saved.discountApplicability, message, events: [said(1200, message)] }), wanted);
    return run;
  };
  for (const response of ['matching', 'unrelated', 'blank', 'omitted']) {
    const valid = response === 'matching';
    matrix(`committed, ${response} response ID, the catch copy`, { commit: true, response }, 'catch', valid ? 'reject' : 'accept');
    matrix(`committed, ${response} response ID, "sAvE20 applied."`, { commit: true, response }, 'success', valid ? 'accept' : 'reject');
  }
  matrix('not committed, unrelated response ID, the catch copy', { commit: false, response: 'unrelated' }, 'catch', 'accept');
  matrix('not committed, unrelated response ID, "sAvE20 applied."', { commit: false, response: 'unrelated' }, 'success', 'reject');
  const ordinary = { status: 503, outcome: 'failed-before-commit', committedAt: undefined };
  matrix('not committed, ordinary HTTP 503 failure, the catch copy', { outcome: ordinary }, 'catch', 'accept');
  matrix('not committed, ordinary HTTP 503 failure, "sAvE20 applied."', { outcome: ordinary }, 'success', 'reject');
  // Shopify's own spelling of the committed code, and a committed code that is not applicable.
  matrix('committed with Shopify spelling SAVE20, unrelated response ID, the catch copy', { commit: true, response: 'unrelated', codeCase: 'upper' }, 'catch', 'accept');
  matrix('committed with Shopify spelling SAVE20, unrelated response ID, "sAvE20 applied."', { commit: true, response: 'unrelated', codeCase: 'upper' }, 'success', 'reject');
  matrix('committed but applicable:false, unrelated response ID, the catch copy', { commit: true, response: 'unrelated', typed: 'SYNTH10' }, 'catch', 'accept',
    observation => ({ ...observation, codeStates: observation.codeStates.map(item => ({ ...item, applicable: false })) }));
  // Accepting the catch copy never suppresses anything else: the committed state must be exactly what was
  // committed, the write sent once after the held update, the copy shown after the write settled, no
  // success claimed in any field, and no other operation's failure or another code.
  const finding = /^Apply while the cart is busy/;
  const integrity = (label, change) => { const run = fixtureDiscount({ commit: true, response: 'unrelated' });
    expectVerdict(busyApplyGate, `1N: committed, unrelated response ID, the catch copy, but ${label}`, change({ held, applyEnabled: true, code: 'sAvE20', cartId: run.cartId, writes: [run.write],
      codes: run.saved.discountCodes, codeStates: run.saved.discountApplicability, message: catchCopy, events: [said(1200, catchCopy)] }, run), finding); };
  integrity('the committed code is missing from the saved cart', observation => ({ ...observation, codes: [], codeStates: [] }));
  integrity('another code is also on the cart', observation => ({ ...observation, codeStates: [...observation.codeStates, state('OTHER5', true)] }));
  integrity('the write was sent twice', (observation, run) => ({ ...observation, writes: [run.write, { ...run.write, seq: 12, startedAt: 1170 }] }));
  integrity('it was sent before the held update finished', (observation, run) => ({ ...observation, writes: [{ ...run.write, startedAt: 900 }] }));
  integrity('the copy was shown only before the write settled', observation => ({ ...observation, events: [said(1120, catchCopy)] }));
  integrity('the announcer claimed "sAvE20 applied."', observation => ({ ...observation, events: [said(1200, catchCopy, 'sAvE20 applied.')] }));
  integrity('it showed the connection-lost copy (Shopify did answer)', observation => ({ ...observation, message: 'Connection lost. Check your connection and try again.', events: [said(1200, 'Connection lost. Check your connection and try again.')] }));
  integrity('it showed another operation\'s failure', observation => ({ ...observation, message: 'Couldn’t update the quantity. Please try again.', events: [said(1200, 'Couldn’t update the quantity. Please try again.')] }));
  integrity('it showed no feedback', observation => ({ ...observation, message: '', events: [] }));
  integrity('it is still pending', (observation, run) => ({ ...observation, writes: [{ ...run.write, status: 0, outcome: 'pending', finishedAt: undefined, committedAt: undefined }] }));

  // ---- Task 1O controls (added before the correction; kept as permanent regression checks) ----
  // A remote commit does not mean the storefront has the substituted response. Rejected-response feedback
  // counts only at or after the mock finished sending that response (finishedAt), never from committedAt.
  // Here the write commits at 1150 and its response is sent at 1160.
  const settlement = (label, { write: change = {}, at = [1200], message = catchCopy }, wanted) => {
    const run = fixtureDiscount({ commit: true, response: 'unrelated' });
    const observation = { held, applyEnabled: true, code: 'sAvE20', cartId: run.cartId, writes: [{ ...run.write, ...change }],
      codes: run.saved.discountCodes, codeStates: run.saved.discountApplicability, message, events: at.map(time => said(time, message)) };
    if (wanted === 'accept') expect(busyApplyGate, `1O: committed, unrelated response ID, ${label}`, observation, 'accept');
    else expectVerdict(busyApplyGate, `1O: committed, unrelated response ID, ${label}`, observation, finding);
  };
  settlement('the catch copy before the commit', { at: [1120] }, 'reject');
  settlement('the catch copy at the commit, before the response was sent', { at: [1150] }, 'reject');
  settlement('the catch copy between the commit and the response', { at: [1155] }, 'reject');
  settlement('the catch copy at the commit and again after the response', { at: [1150, 1200] }, 'reject');
  settlement('the catch copy exactly when the response was sent', { at: [1160] }, 'accept');
  settlement('the catch copy after the response was sent', { at: [1200] }, 'accept');
  settlement('no response completion time recorded', { write: { finishedAt: undefined } }, 'reject');
  settlement('a response completion time that is not a number', { write: { finishedAt: '1160' } }, 'reject');
  settlement('a response completion time that is not finite', { write: { finishedAt: Infinity } }, 'reject');
  settlement('a response completion time before the commit', { write: { finishedAt: 1140 } }, 'reject');
  settlement('a response completion time before the write started', { write: { finishedAt: 1090, committedAt: 1085 } }, 'reject');
  settlement('"sAvE20 applied." after the response was sent', { message: 'sAvE20 applied.' }, 'reject');
  // The reported shape: committed at t, response sent at t + 1, the catch copy at t.
  settlement('committed at t, sent at t + 1, the catch copy at t', { write: { committedAt: 1795622380432, finishedAt: 1795622380433, startedAt: 1795622380432 }, at: [1795622380432] }, 'reject');
  // Deterministic replay of the six saved Task 1N full-run observations of the committed wrong-ID scenarios
  // (1N runs 1be33a54 and 2351a0a0; extracted from their results.json by phase6-1o-verification/extract-replays.mjs).
  // Each must pass as recorded and when the copy appears exactly at finishedAt; it must fail when the copy
  // appears 1 ms before finishedAt, at committedAt when that is earlier, or when finishedAt is missing.
  const REPLAY_TEXTS = [' |  |  | ', `${catchCopy} |  | We could not verify your cart. Check your cart before continuing.Check cartContinue with verified items in a new cartReview your items before checkout. A pending change may be missing. | `,
    `${catchCopy} | BR16 quantity 1. | We could not verify your cart. Check your cart before continuing.Check cartContinue with verified items in a new cartReview your items before checkout. A pending change may be missing. | `];
  const REPLAYS = [['1be33a54', 'unrelated', 1229, 1795622377914, 1232, 1795622377951, 1795622377951, 1795622377951, 133, 'gid://shopify/Cart/999999', [1795622377595, 1795622377965, 1795622378083]],
    ['1be33a54', 'blank', 1269, 1795622380393, 1272, 1795622380432, 1795622380432, 1795622380433, 141, '', [1795622380077, 1795622380451, 1795622380558]],
    ['1be33a54', 'omitted', 1309, 1795622382875, 1312, 1795622382912, 1795622382913, 1795622382913, 149, null, [1795622382560, 1795622382927, 1795622383036]],
    ['2351a0a0', 'unrelated', 1229, 1795622492849, 1232, 1795622492910, 1795622492910, 1795622492911, 133, 'gid://shopify/Cart/999999', [1795622492523, 1795622492925, 1795622493032]],
    ['2351a0a0', 'blank', 1269, 1795622495321, 1272, 1795622495357, 1795622495357, 1795622495357, 141, '', [1795622495006, 1795622495372, 1795622495484]],
    ['2351a0a0', 'omitted', 1309, 1795622497740, 1312, 1795622497774, 1795622497774, 1795622497774, 149, null, [1795622497423, 1795622497788, 1795622497907]]];
  for (const [run, forged, heldSeq, heldFinished, seq, startedAt, committedAt, finishedAt, commitSeq, returnedCartId, times] of REPLAYS) {
    const write = { seq, cartId: 'gid://shopify/Cart/1', startedAt, attemptedAt: startedAt, committedAt, finishedAt, status: 200, outcome: 'committed-response-substituted', commitSeq,
      userErrors: [], discountCodes: ['sAvE20'], returnedCartId, forged, forgeMode: 'commit-then-substitute' };
    const replay = (change = {}, at = time => time) => ({ held: { seq: heldSeq, finishedAt: heldFinished }, applyEnabled: true, code: 'sAvE20', cartId: 'gid://shopify/Cart/1',
      writes: [{ ...write, ...change }], codes: ['sAvE20'], codeStates: [state('sAvE20', true)], message: catchCopy,
      events: times.map((time, index) => ({ at: index ? at(time) : time, text: REPLAY_TEXTS[index] })) });
    const name = `1O (replay ${run}, ${forged}, committed ${committedAt}, sent ${finishedAt})`;
    expect(busyApplyGate, `${name}: as recorded`, replay(), 'accept');
    expect(busyApplyGate, `${name}: the copy exactly at finishedAt`, replay({}, () => finishedAt), 'accept');
    expectVerdict(busyApplyGate, `${name}: the copy 1 ms before finishedAt`, replay({}, () => finishedAt - 1), finding);
    if (committedAt < finishedAt) expectVerdict(busyApplyGate, `${name}: the copy at committedAt`, replay({}, () => committedAt), finding);
    expectVerdict(busyApplyGate, `${name}: finishedAt missing`, replay({ finishedAt: undefined }), finding);
  }
}, { deadlineMs: 10000 });

// Real taps in the browser: a normal enabled tap is delivered; a press nobody can see arrive is a
// harness error; a disabled control may only be pressed explicitly.
define('harness self-test: tap requires observed delivery', async () => {
  const tab = await openTab('A');
  await tab.visit('/product/br16');
  const normal = await tab.tap('input[name="wrist-fit"][value="tightened"]').then(result => ({ result }), error => ({ error: error.message }));
  check('harness', 'a normal enabled tap is delivered and activates the control', !normal.error && normal.result?.delivered === true &&
    await tab.eval(`document.querySelector('input[name="wrist-fit"][value="tightened"]').checked`), normal);
  // Something swallows the press before the harness can see it: delivery is not proven.
  await tab.eval(`window.__swallow = event => { event.preventDefault(); event.stopImmediatePropagation(); }; for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) window.addEventListener(type, window.__swallow, true);`);
  const swallowed = await tab.tap('input[name="wrist-fit"][value="regular"]').then(result => ({ result }), error => ({ error: error.message }));
  check('harness', 'a tap whose pointerdown is never observed is a harness error', !!swallowed.error && /pointerdown/.test(swallowed.error), swallowed);
  await tab.eval(`for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) window.removeEventListener(type, window.__swallow, true);`);
  // 1H: only pointerdown is swallowed, so the harness sees a click with no pointerdown: not proven.
  await tab.eval(`window.__swallowDown = event => { event.stopImmediatePropagation(); }; window.addEventListener('pointerdown', window.__swallowDown, true);`);
  const clickOnly = await tab.tap('input[name="wrist-fit"][value="regular"]').then(result => ({ result }), error => ({ error: error.message }));
  check('harness', '1H: a tap whose click arrives without an observed pointerdown is a harness error', !!clickOnly.error && /pointerdown/.test(clickOnly.error), clickOnly);
  await tab.eval(`window.removeEventListener('pointerdown', window.__swallowDown, true); document.querySelector('input[name="wrist-fit"][value="tightened"]').click();`);
  // 1H: a normal tap reports that its listeners were confirmed installed before the press was dispatched.
  const confirmed = await tab.tap('input[name="wrist-fit"][value="regular"]').then(result => ({ result }), error => ({ error: error.message }));
  check('harness', '1H: a delivered tap confirms its listeners were installed before dispatch', !confirmed.error && confirmed.result?.delivered === true && confirmed.result?.installedBeforeDispatch === true &&
    await tab.eval(`document.querySelector('input[name="wrist-fit"][value="regular"]').checked`), confirmed);
  await tab.eval(`document.querySelector('input[name="wrist-fit"][value="tightened"]').click()`);
  // A disabled control: an implicit tap is refused, an explicit disabled press reports that nothing received it.
  await tab.eval(`document.querySelector('input[name="wrist-fit"][value="regular"]').disabled = true`);
  const implicit = await tab.tap('input[name="wrist-fit"][value="regular"]').then(result => ({ result }), error => ({ error: error.message }));
  check('harness', 'an implicit tap on a disabled control is a harness error', !!implicit.error, implicit);
  const checkedBefore = await tab.eval(`document.querySelector('input[name="wrist-fit"][value="regular"]').checked`);
  const explicit = await tab.tap('input[name="wrist-fit"][value="regular"]', 1, { allowDisabled: true }).then(result => ({ result }), error => ({ error: error.message }));
  const checkedAfter = await tab.eval(`document.querySelector('input[name="wrist-fit"][value="regular"]').checked`);
  check('harness', 'an explicit disabled press reports a disabled, unactivated control', !explicit.error && explicit.result?.disabled === true && explicit.result?.delivered === false &&
    checkedAfter === checkedBefore, { ...explicit, checkedBefore, checkedAfter });
}, { deadlineMs: 20000 });

// A deliberate mock fault, then a mid-scenario reset: the fault must survive into the final results.
define('harness self-test: faults survive mid-scenario resets', async () => {
  const marker = `HarnessSelfTestFault${randomBytes(6).toString('hex')}`;
  expectedFaults.add(marker);
  const response = await fetch(`${BASE}/__fixture`, { method: 'POST', body: JSON.stringify({ query: `mutation ${marker} { nothing }`, variables: {} }), signal: AbortSignal.timeout(5000) });
  check('harness', 'the deliberate fault was refused by the mock', response.status === 500);
  await closeContext(); await control('reset', { scenario }); await newContext();
  serverFaults = (await control('faults')).faults;
  check('harness', 'the deliberate fault survived the reset in the run\'s infrastructure record', infrastructure.some(item => JSON.stringify(item).includes(marker)), { infrastructure: infrastructure.length });
  check('harness', 'the deliberate fault is in the mock\'s cumulative fault log', recordedFaults().some(item => JSON.stringify(item).includes(marker)), { faults: recordedFaults().length });
}, { deadlineMs: 15000 });

define('viewport layout and hit targets', async () => {
  const tab = await openTab('A');
  await tab.viewport(1440, 900);
  await addTrainer(tab, 'black', { breakIn: { level: 'Game Ready (90%)', wearingStyle: 'Two in the Pinky (TIP)' } });
  await tab.closeCart();
  await addFullSize(tab, { notes: LONG_NOTE, choices: { 'full-size-firmness': 'Game Ready' } });
  await tab.closeCart();
  await addTrainer(tab, 'blue');
  await tab.tap('[data-qty-line][data-delta="1"]:not([aria-label*="BR16"]):not([aria-label*="MI26"])');
  await tab.settled();
  await applyDiscount(tab, 'SYNTH10');
  await tab.settled();
  check('harness', 'cart for layout has 3 glove rows, 2 services, OB16 x2 and an applied code', (await cartLines()).length === 5 &&
    (await tab.eval(`document.querySelectorAll('.cart-item').length`)) === 3 && (await tab.text('.cart-discount-code'))?.includes('SYNTH10 applied'),
    { lines: await cartLines() });
  // Controls this cart must render; each must exist before its geometry means anything.
  const expected = { 'qty-minus': 3, 'qty-plus': 3, remove: 3, 'service-add': 1, 'service-edit': 2, 'service-remove': 2, 'wrist-fit': 3,
    'discount-toggle': 1, 'discount-input': 1, 'discount-apply': 1, 'discount-remove': 1, checkout: 1, close: 1 };
  for (const [width, height] of VIEWPORTS) {
    viewport = `${width}x${height}`;
    await tab.viewport(width, height);
    await tab.reload();
    await tab.openCart();
    // Expanded discount panel for every layout check.
    if ((await tab.eval(`document.querySelector('[data-discount-toggle]').getAttribute('aria-expanded')`)) !== 'true') await tab.tap('[data-discount-toggle]');
    const overflow = await overflowReport(tab);
    check('baseline', 'no horizontal overflow in drawer, cart body, foot or page', overflow.drawer <= 0 && overflow.body <= 0 && overflow.foot <= 0 && overflow.page <= 0 && !overflow.wide.length, overflow);
    const controls = await measureControls(tab);
    for (const [kind, count] of Object.entries(expected)) {
      const found = controls.filter(control => control.kind === kind).length;
      check('harness', `${count} ${kind} control(s) are present to measure`, found === count, { found, count });
    }
    const initiallyVisible = kind => controls.filter(control => control.kind === kind).every(control => control.initiallyVisible);
    check('baseline', 'Close is visible when the drawer opens, before any scrolling', initiallyVisible('close'));
    check('risk:5', 'the first row\'s steppers are visible when the drawer opens', controls.filter(control => control.kind.startsWith('qty') && control.index === 0).every(control => control.initiallyVisible),
      controls.filter(control => control.kind.startsWith('qty') && control.index === 0).map(({ kind, initiallyVisible }) => ({ kind, initiallyVisible })));
    for (const control of controls) {
      const id = `${control.kind}#${control.index}`;
      const label = control.kind.startsWith('qty') ? 'risk:1' : 'baseline';
      check(label, `${id} receives taps across its whole box (hit-test)`, !control.missed.length && !control.overlaps.length, control);
      if (control.pointerMissed) check(label, `${id} receives real pointer input at its centre and side edges`, !control.pointerMissed.length, { pointerMissed: control.pointerMissed });
      check('baseline', `${id} is at least 44x44 CSS px`, control.width >= 44 && control.height >= 44, { width: control.width, height: control.height });
      check('baseline', `${id} stays inside the drawer`, control.insideDrawer, control);
      if (control.kind.startsWith('qty')) check('risk:1', `${id} stays inside its details column`, control.beyondColumn <= 0.5, { beyondColumn: control.beyondColumn });
    }
    await tab.shot(`layout-${viewport}`);
    // With the panel collapsed only the rows scroll: checkout stays on screen and the rows keep room.
    await tab.tap('[data-discount-toggle]');
    await tab.eval(`document.querySelector('.cart-body').scrollTop = 0`);
    const cta = await tab.eval(`(() => { const r = document.querySelector('[data-checkout]').getBoundingClientRect(); const body = document.querySelector('.cart-body').getBoundingClientRect();
      return { checkoutBottom: Math.round(r.bottom), innerHeight, rowsHeight: Math.round(body.height) }; })()`);
    check('risk:5', 'collapsed panel: checkout is on screen without scrolling', cta.checkoutBottom <= cta.innerHeight, cta);
    check('risk:5', 'collapsed panel: cart rows keep a usable scroll area (>= 120px)', cta.rowsHeight >= 120, cta);
    const reach = (await measureControls(tab, ['checkout']))[0];
    check('risk:5', 'collapsed panel: checkout can be scrolled to and receives a real tap', !!reach && reach.inViewport && !reach.missed.length && !reach.pointerMissed?.length, reach);
    await tab.shot(`layout-collapsed-${viewport}`);
    await tab.tap('[data-discount-toggle]');
    // Service editor expanded on the full-size row.
    await tab.tap('[data-edit-service][aria-label*="MI26"]');
    await tab.until(`document.querySelector('[data-service-form]')`);
    const editorOverflow = await overflowReport(tab);
    check('baseline', 'no horizontal overflow with the full-size service editor open', editorOverflow.drawer <= 0 && editorOverflow.body <= 0 && !editorOverflow.wide.length, editorOverflow);
    const editor = await measureControls(tab, ['service-confirm', 'service-cancel']);
    check('harness', 'service editor renders Confirm and Cancel', editor.filter(c => c.kind === 'service-confirm').length === 1 && editor.filter(c => c.kind === 'service-cancel').length === 1, editor.map(c => c.kind));
    for (const control of editor) {
      check('baseline', `${control.kind}#${control.index} in editor receives taps and is 44x44`, !control.missed.length && !control.pointerMissed?.length && control.width >= 44 && control.height >= 44, control);
    }
    await tab.shot(`layout-editor-${viewport}`);
    await tab.tap('[data-cancel-service]');
    await tab.until(`!document.querySelector('[data-service-form]')`);
    // Keyboard focus on a short screen: each stop is on screen and visibly indicated.
    await tab.eval(`document.querySelector('.cart-head [data-close-cart]').focus()`);
    const stops = [];
    for (let i = 0; i < 40; i++) {
      await tab.key('Tab');
      const stop = await tab.eval(`(() => { const e = document.activeElement; const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
        return { label: e.getAttribute('aria-label') || e.id || e.textContent.trim().slice(0, 24), inDrawer: !!e.closest('.cart-drawer'),
          onScreen: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth,
          indicated: (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== 'none', close: e.matches('.cart-head [data-close-cart]') }; })()`);
      if (stop.close) break;
      stops.push(stop);
    }
    check('baseline', 'Tab stays in the drawer and wraps back to Close', stops.length > 5 && stops.length < 40 && stops.every(stop => stop.inDrawer), { stops: stops.length });
    const offscreen = stops.filter(stop => !stop.onScreen).map(stop => stop.label);
    check('risk:5', 'every focused control is scrolled on screen', !offscreen.length, { offscreen });
    const unindicated = stops.filter(stop => !stop.indicated).map(stop => stop.label);
    check('baseline', 'every focused control shows a focus indicator', !unindicated.length, { unindicated });
    await tab.closeCart();
  }
  viewport = null;
}, { deadlineMs: 300000 });

define('PDP Break-In totals: selectable service adds $75, unavailable service stays disabled', async () => {
  const tab = await openTab('A');
  await tab.visit('/product/mi26', `document.querySelector('[data-full-size-break-in]') && document.querySelector('[data-full-size-setup-summary]')`);
  const summary = () => tab.text('[data-full-size-setup-summary]');
  check('harness', 'service checkbox is enabled when the service is valid', await tab.until(`!document.querySelector('[data-full-size-break-in]').disabled`).then(() => true, () => false));
  check('baseline', 'MI26 alone totals $295', (await summary()).includes('Total before shipping/tax: $295.'), await summary());
  await tab.tap('[data-full-size-break-in]');
  check('baseline', 'a real tap selects the valid service', await tab.eval(`document.querySelector('[data-full-size-break-in]').checked`));
  check('baseline', 'MI26 with the valid service totals $295 + $75 = $370', (await summary()).includes('Total before shipping/tax: $370.'), await summary());
  await tab.tap('[data-full-size-break-in]');
  check('baseline', 'removing the service returns the total to $295', (await summary()).includes('Total before shipping/tax: $295.'), await summary());
  // The same page when Shopify does not offer the service: it must not be selectable or priced in.
  await closeContext(); await control('reset', { scenario, fullSizeServiceAvailable: false }); await newContext();
  const unavailable = await openTab('B');
  await unavailable.visit('/product/mi26', `document.querySelector('[data-add="full-mint"]') && !document.querySelector('[data-add="full-mint"]').disabled`);
  check('baseline', 'unavailable service checkbox is disabled', await unavailable.eval(`document.querySelector('[data-full-size-break-in]').disabled`));
  await unavailable.tap('[data-full-size-break-in]', 1, { allowDisabled: true });
  check('baseline', 'a real tap on the disabled service does not select it', await unavailable.eval(`!document.querySelector('[data-full-size-break-in]').checked`));
  check('baseline', 'unavailable service is not added to the total', (await unavailable.text('[data-full-size-setup-summary]')).includes('Total before shipping/tax: $295.'), await unavailable.text('[data-full-size-setup-summary]'));
});

define('trainer Break-In add, edit, remove and quantity parity', async () => {
  const tab = await openTab('A');
  await addTrainer(tab, 'black', { breakIn: { level: 'Firm (40%)', wearingStyle: 'Traditional' } });
  let lines = await cartLines();
  let [glove] = gloves(lines);
  check('baseline', 'PDP add creates one BR16 with one paired service', lines.length === 2 && glove?.merchandiseId === 'gid://variant/br16' &&
    glove.services.length === 1 && glove.services[0].merchandiseId === 'gid://variant/service' && !pairingIssues(lines).length, { lines, issues: pairingIssues(lines) });
  check('baseline', 'glove carries the service marker and choices', attr(glove, '_anawin_service') === 'break-in' && attr(glove, '_anawin_break_in_level') === 'Firm (40%)' &&
    attr(glove, '_anawin_wearing_style') === 'Traditional', glove?.attributes);
  check('baseline', 'service line carries the shopper-facing choices', attr(glove?.services[0], 'Break-In Level') === 'Firm (40%)' && attr(glove?.services[0], 'Glove Wearing Style') === 'Traditional', glove?.services[0]);
  check('baseline', 'cart row shows the saved choices', (await tab.text('.cart-service-preferences'))?.includes('Break-In Level: Firm (40%)'));
  check('baseline', 'add is announced', await tab.until(`document.querySelector('[data-cart-announcer]')?.textContent.includes('added to cart')`).then(() => true, () => false));
  // Edit in the cart: same glove line, same merchandise, only the level changes.
  const beforeEdit = glove;
  await tab.tap('[data-edit-service]');
  await tab.until(`document.querySelector('[data-service-form]')`);
  await tab.click('[data-service-form] input[value="Game Ready (90%)"]');
  await tab.tap('[data-confirm-service]');
  await tab.settled();
  await tab.until(`document.querySelector('[data-service-notice]')`);
  lines = await cartLines(); [glove] = gloves(lines);
  check('baseline', 'edit keeps the same glove line and merchandise', lines.length === 2 && glove?.id === beforeEdit.id && glove.merchandiseId === beforeEdit.merchandiseId, { before: beforeEdit, after: glove });
  check('baseline', 'edit changes only the level, on glove and service', attr(glove, '_anawin_break_in_level') === 'Game Ready (90%)' && attr(glove?.services[0], 'Break-In Level') === 'Game Ready (90%)' &&
    same(without(glove.attributes, ['_anawin_break_in_level']), without(beforeEdit.attributes, ['_anawin_break_in_level'])) &&
    same(without(glove.services[0].attributes, ['Break-In Level']), without(beforeEdit.services[0].attributes, ['Break-In Level'])) && !pairingIssues(lines).length, { before: beforeEdit, after: glove });
  check('baseline', 'edit success is announced through the service notice', (await tab.text('[data-service-notice]'))?.startsWith('Break-in updated'));
  // Quantity parity. The mock never moves a service quantity by itself, so the storefront must.
  const beforeQuantity = glove;
  const logStart = (await requestLog()).length;
  await tab.tap('[data-qty-line][data-delta="1"]');
  await tab.settled();
  lines = await cartLines(); [glove] = gloves(lines);
  const updates = (await requestLog()).slice(logStart).filter(entry => entry.operation === 'UpdateLines');
  check('baseline', 'glove quantity 2 keeps service quantity 2 on the same lines', glove?.id === beforeQuantity.id && glove.quantity === 2 && glove.services[0]?.id === beforeQuantity.services[0].id &&
    glove.services[0].quantity === 2 && !pairingIssues(lines).length, { lines });
  check('baseline', 'storefront itself updated the service quantity (no mock auto-sync)', updates.some(entry => entry.lines.some(line => line.id === beforeQuantity.services[0].id && line.quantity === 2)), updates);
  check('baseline', 'cart shows service quantity (2)', (await tab.text('.cart-service'))?.includes('Break-in service (2)'));
  await tab.tap('[data-qty-line][data-delta="-1"]');
  await tab.settled();
  lines = await cartLines(); [glove] = gloves(lines);
  check('baseline', 'glove quantity 1 keeps service quantity 1 and every attribute', glove?.quantity === 1 && glove.services[0]?.quantity === 1 &&
    same(glove.attributes, beforeQuantity.attributes) && same(glove.services[0].attributes, beforeQuantity.services[0].attributes) && !pairingIssues(lines).length, { lines });
  // Remove service.
  await tab.tap('[data-remove-service]');
  await tab.settled();
  lines = await cartLines(); [glove] = gloves(lines);
  check('baseline', 'removing service leaves the same glove merchandise without service', lines.length === 1 && glove?.merchandiseId === 'gid://variant/br16' &&
    attr(glove, '_anawin_service') === 'none' && !attr(glove, '_anawin_break_in_level'), lines);
  check('baseline', 'focus stays on a usable cart control after removal', await tab.eval(`!!document.activeElement.closest('.cart-drawer') && !document.activeElement.disabled`));
  // Add back through the cart editor.
  await tab.tap('[data-add-service]');
  await tab.until(`document.querySelector('[data-confirm-service]') && !document.querySelector('[data-confirm-service]').disabled`);
  await tab.tap('[data-confirm-service]');
  await tab.settled();
  lines = await cartLines(); [glove] = gloves(lines);
  check('baseline', 'cart editor adds one paired service with choices', lines.length === 2 && glove?.services.length === 1 && !!attr(glove.services[0], 'Break-In Level') && !pairingIssues(lines).length, lines);
});

define('split edit, identical variants with different service, throw hand, reload persistence', async () => {
  const tab = await openTab('A');
  await addTrainer(tab, 'black', { breakIn: { level: 'Medium (65%)', wearingStyle: 'Traditional' } });
  await tab.tap('[data-qty-line][data-delta="1"]');
  await tab.settled();
  const [source] = gloves(await cartLines());
  // Edit one of two serviced gloves: the line splits.
  await tab.tap('[data-edit-service]');
  await tab.until(`document.querySelector('[data-service-form]')`);
  await tab.click('[data-service-form] input[value="Two in the Pinky (TIP)"]');
  await tab.tap('[data-confirm-service]');
  await tab.settled();
  let lines = await cartLines();
  const split = gloves(lines);
  const kept = split.find(glove => glove.id === source.id);
  const moved = split.find(glove => glove.id !== source.id);
  check('baseline', 'split leaves the original glove line at 1 with its original choices', kept?.quantity === 1 && same(kept.attributes, source.attributes) &&
    kept.services.length === 1 && kept.services[0].quantity === 1 && same(kept.services[0].attributes, source.services[0].attributes), { source, kept });
  check('baseline', 'split moves one glove to a new line of the same merchandise with the new style', split.length === 2 && moved?.merchandiseId === source.merchandiseId && moved.quantity === 1 &&
    attr(moved, '_anawin_wearing_style') === 'Two in the Pinky (TIP)' && attr(moved.services[0], 'Glove Wearing Style') === 'Two in the Pinky (TIP)' &&
    attr(moved.services[0], 'Break-In Level') === 'Medium (65%)' && moved.services.length === 1 && moved.services[0].quantity === 1 && !pairingIssues(lines).length, { moved, issues: pairingIssues(lines) });
  // Full-size: same variant twice with different shaping stays as two lines; a left-hand glove keeps its hand.
  await tab.closeCart();
  await addFullSize(tab, { choices: { 'full-size-thumb-shape': 'None', 'full-size-pinky-shape': 'Recommend for me' }, notes: 'Synthetic note one' });
  await tab.closeCart();
  await addFullSize(tab, { choices: { 'full-size-thumb-shape': 'Recommend for me', 'full-size-pinky-shape': 'None' }, notes: 'Synthetic note two' });
  await tab.closeCart();
  await addFullSize(tab, { hand: 'Left', notes: 'Synthetic left-hand note' });
  lines = await cartLines();
  const minis = gloves(lines).filter(glove => glove.handle === 'mi26');
  const right = minis.filter(glove => glove.merchandiseId === 'gid://variant/mi26-right');
  const left = minis.filter(glove => glove.merchandiseId === 'gid://variant/mi26-left');
  const shapes = right.map(glove => `${attr(glove.services[0], 'Thumb Shape')}|${attr(glove.services[0], 'Pinky Shape')}|${attr(glove.services[0], 'Notes')}`).sort();
  check('baseline', 'two identical MI26 variants with different shaping stay separate, each with its own service', right.length === 2 && right.every(glove => glove.services.length === 1) &&
    same(shapes, ['None|Recommend for me|Synthetic note one', 'Recommend for me|None|Synthetic note two']) && right[0].id !== right[1].id &&
    attr(right[0], '_anawin_configuration') !== attr(right[1], '_anawin_configuration') && !pairingIssues(lines).length, { shapes, issues: pairingIssues(lines) });
  check('baseline', 'every full-size service names its glove and the variant\'s throw hand', minis.every(glove => attr(glove.services[0], 'Glove Model') === 'MI26' &&
    attr(glove.services[0], 'Throwing Hand') === (glove.merchandiseId.endsWith('-left') ? 'Left' : 'Right') && glove.services[0].merchandiseId === FULL_SIZE_SERVICE_VARIANT) &&
    left.length === 1 && attr(left[0].services[0], 'Throwing Hand') === 'Left', minis.map(glove => ({ merchandiseId: glove.merchandiseId, service: glove.services[0]?.attributes })));
  const snapshot = gloves(lines);
  const before = await tab.eval(`[...document.querySelectorAll('.cart-item')].map(item => item.textContent.replace(/\\s+/g, ' '))`);
  await tab.closeCart();
  await tab.reload();
  await tab.openCart();
  const after = await tab.eval(`[...document.querySelectorAll('.cart-item')].map(item => item.textContent.replace(/\\s+/g, ' '))`);
  check('baseline', 'reload restores the same rows, choices and pairing', same(before, after) && after.length === 5 && same(gloves(await cartLines()), snapshot), { before, after });
  check('baseline', 'checkout is offered for the restored cart', await tab.enabled('[data-checkout]'));
});

if (applicationContract === 'combined') define('Targeted whole-cart re-key during serviced add', async () => {
  const tab = await openTab('A');
  // Seed an unrelated line so the serviced add exposes whole-cart rotation at its intermediate step.
  await addTrainer(tab, 'brown');
  await tab.closeCart();
  const rekeyId = await storedCartId(tab);
  const beforeServiced = await serverCart(rekeyId);
  const rekeyLog = (await requestLog()).length;
  await addTrainer(tab, 'black', { breakIn: { level: 'Firm (40%)', wearingStyle: 'Traditional' } });
  const afterServiced = await serverCart(rekeyId);
  observe('serviced add under whole-cart line re-key', { beforeServiced, afterServiced,
    requests: (await requestLog()).slice(rekeyLog), storefront: await cartProbe(tab), pairing: pairingIssues(afterServiced?.lines || []), navigation: documentHandoffs(0) });
}, { mock: { rekeyOnAdd: true } });

const verifySplitPairing = async () => {
  const tab = await openTab('A');
  await addTrainer(tab, 'black', { breakIn: { level: 'Firm (40%)', wearingStyle: 'Traditional' } });
  await addTrainer(tab, 'brown');
  let before = await cartLines();
  await tab.tap('[data-qty-line][data-delta="1"][aria-label*="BR16"]');
  await tab.settled();
  let lines = await cartLines();
  const rekeyed = ids => ids.every(id => !before.some(line => line.id === id));
  check('harness', 're-key mode changed every line ID on the quantity update', lines.length === before.length && rekeyed(lines.map(line => line.id)), { before: before.map(l => l.id), after: lines.map(l => l.id) });
  const br16 = gloves(lines).find(glove => glove.handle === 'br16');
  check('risk:4', 'quantity change with re-keyed lines keeps parity, pairing and choices', !pairingIssues(lines).length && br16?.quantity === 2 && br16.services[0]?.quantity === 2 &&
    same(br16.attributes, gloves(before).find(glove => glove.handle === 'br16').attributes), { lines, issues: pairingIssues(lines) });
  check('risk:4', 'cart is verified (not blocked) after re-keyed quantity change', !(await tab.alerts()).length && await tab.enabled('[data-checkout]'), await tab.text('.cart-feedback'));
  before = await cartLines();
  const splitId = await storedCartId(tab);
  const beforeSplit = await serverCart(splitId);
  const splitLog = (await requestLog()).length;
  await tab.tap('[data-edit-service]');
  await tab.until(`document.querySelector('[data-service-form]')`);
  await tab.click('[data-service-form] input[value="Game Ready (90%)"]');
  await tab.tap('[data-confirm-service]');
  await tab.settled();
  lines = await cartLines();
  observe('historical re-key split edit state and effects', { beforeSplit, after: await serverCart(splitId),
    requests: (await requestLog()).slice(splitLog), storefront: await cartProbe(tab), navigation: documentHandoffs(0) });
  check('harness', 're-key mode changed line IDs during the split edit', lines.some(line => !before.some(old => old.id === line.id)) && !before.some(old => lines.some(line => line.id === old.id && line.parentId)),
    { before: before.map(l => l.id), after: lines.map(l => l.id) });
  if (applicationContract === 'combined') {
    const writes = (await requestLog()).slice(splitLog).filter(entry => entry.mutation);
    check('risk:4', 'supported re-key split accounts for each source write and preserves checkout',
      same(writes.map(entry => entry.operation), ['AddLines', 'AddLines', 'UpdateLines', 'UpdateLines']) &&
      writes.every(entry => entry.cartId === splitId && Number.isInteger(entry.commitSeq)) &&
      writes[0].lines.length === 1 && !writes[0].lines[0].parent && writes[1].lines.length === 1 && !!writes[1].lines[0].parent &&
      !pairingIssues(lines).length && lines.length === 5 && await tab.enabled('[data-checkout]') &&
      !(await cartProbe(tab)).journal.length, { writes, lines });
  }
  const trainers = gloves(lines).filter(glove => glove.handle === 'br16');
  const levels = trainers.map(glove => `${attr(glove, '_anawin_break_in_level')}=${attr(glove.services[0], 'Break-In Level')}`).sort();
  check('risk:4', 'split edit with re-keyed lines attaches each service to the right glove', same(levels, ['Firm (40%)=Firm (40%)', 'Game Ready (90%)=Game Ready (90%)']) &&
    trainers.every(glove => glove.quantity === 1 && glove.services.length === 1) && !pairingIssues(lines).length, { lines, issues: pairingIssues(lines) });
  const cl16 = gloves(lines).filter(glove => glove.handle === 'cl16');
  check('harness', 'the unserviced CL16 is in the cart to check', cl16.length === 1 && cl16[0].quantity === 1, cl16);
  check('risk:4', 'CL16 never receives a service line', cl16.length === 1 && !cl16[0].services.length && attr(cl16[0], '_anawin_service') === 'none', cl16);
};
define('pairing survives Shopify line ID changes', verifySplitPairing, {
  mock: { rekeyOnAttributeUpdate: true, rekeyOnQuantityUpdate: true, rekeyOnAdd: applicationContract === 'baseline' }
});

if (applicationContract === 'combined') define('Break-In split whole-cart re-key offers explicit verified recovery', async () => {
  const tab = await openTab('A');
  await addTrainer(tab, 'black', { breakIn: { level: 'Firm (40%)', wearingStyle: 'Traditional' } });
  await addTrainer(tab, 'brown');
  await tab.tap('[data-qty-line][data-delta="1"][aria-label*="BR16"]');
  await tab.settled();
  const sourceId = await storedCartId(tab);
  const before = await serverCart(sourceId);
  const start = (await requestLog()).length;
  const handoffStart = handoffs.length;
  await tab.tap('[data-edit-service]');
  await tab.click('[data-service-form] input[value="Game Ready (90%)"]');
  await tab.tap('[data-confirm-service]');
  await tab.settled();
  const source = await serverCart(sourceId);
  const frozen = await cartProbe(tab);
  const beforeConsent = (await requestLog()).slice(start).filter(entry => entry.mutation);
  const [record] = frozen.journal;
  check('risk:4', 'whole-cart re-key commits one parent add with no service attachment or replay',
    beforeConsent.length === 1 && beforeConsent[0].operation === 'AddLines' && Number.isInteger(beforeConsent[0].commitSeq) &&
    beforeConsent[0].lines.length === 1 && !beforeConsent[0].lines[0].parent &&
    !source.lines.some(line => before.lines.some(old => old.id === line.id)), { before, source, beforeConsent });
  check('risk:4', 'unresolved split freezes checkout and offers explicitly described pre-edit recovery',
    !frozen.checkout && !documentHandoffs(handoffStart).length && frozen.journal.length === 1 &&
    record.key === 'anawin-shopify-unsafe-op:' + record.owner && record.status === 'unresolved' &&
    record.cartId === sourceId && record.kind === 'editBreakIn' && record.step?.field === 'cartLinesAdd' &&
    record.step.state === 'dispatched-unknown' && record.step.n === 1 && !!record.splitObservedStamp &&
    frozen.text.includes('could not confirm your Break-In edit') && frozen.text.includes('restore your prior configuration') &&
    !/Game Ready.{0,30}(added|saved)/i.test(frozen.text) && await tab.enabled('[data-recover-cart]'), frozen);
  const savedBefore = (await control('carts')).carts;
  if (!await requireControl(tab, '[data-recover-cart]', 'risk:4', 'pre-edit recovery requires the explicit recovery button')) return;
  const consentAt = Date.now();
  await tab.tap('[data-recover-cart]');
  await tab.settled(15000);
  const recoveredId = await storedCartId(tab);
  const savedAfter = (await control('carts')).carts;
  const recovered = await serverCart(recoveredId);
  const during = (await requestLog()).slice(start);
  const newCarts = savedAfter.filter(cart => !savedBefore.some(old => old.id === cart.id));
  check('risk:4', 'consent restores exactly the verified pre-edit pairing into one distinct $505 cart',
    recoveredId !== sourceId && newCarts.length === 1 && newCarts[0].id === recoveredId &&
    same(configuration(recovered?.lines || []), configuration(before.lines)) &&
    same(recovered?.discountApplicability, before.discountApplicability) &&
    /\$505\.00/.test(await tab.text('.cart-foot')) && await tab.enabled('[data-checkout]') &&
    !!during.find(entry => entry.operation === 'Cart' && entry.returnedCartId === recoveredId) &&
    during.filter(entry => entry.operation === 'CreateCart' && entry.startedAt >= consentAt && entry.commitSeq).length === 1 &&
    during.filter(entry => entry.mutation && entry.cartId === sourceId).length === 1 &&
    same(source, await serverCart(sourceId)), { before, source, recovered, during, newCarts });
}, { mock: { rekeyOnAttributeUpdate: true, rekeyOnQuantityUpdate: true, rekeyOnAdd: true } });

define('Break-In partial failure blocks checkout and offers recovery', async () => {
  const tab = await openTab('A');
  await addTrainer(tab, 'black');
  // The service add commits at Shopify, then its response fails.
  await control('failNext', { operation: null, phase: 'after' });
  await tab.tap('[data-add-service]');
  await tab.until(`document.querySelector('[data-confirm-service]') && !document.querySelector('[data-confirm-service]').disabled`);
  await tab.tap('[data-confirm-service]');
  await tab.settled(15000);
  const lines = await cartLines();
  // Shopify may keep part of an uncertain change. That is allowed only while checkout stays blocked;
  // a service on the wrong glove never is.
  const wrong = pairingIssues(lines).filter(issue => !issue.serviceMissing);
  check('risk:4', 'no service is attached to the wrong glove after a failed response', !wrong.length, { lines, issues: pairingIssues(lines) });
  check('baseline', 'an error is shown for the uncertain change', (await tab.alerts()).length > 0 || await tab.eval(`!!document.querySelector('[data-service-error]:not([hidden])')`), await tab.alerts());
  check('baseline', 'checkout is not offered while the change is unresolved', !await tab.enabled('[data-checkout]'));
  if (await requireControl(tab, '[data-refresh-cart]', 'baseline', 'a Check cart control is offered')) { await tab.tap('[data-refresh-cart]'); await tab.settled(); }
  check('baseline', 'checking the partially changed cart keeps checkout blocked', !await tab.enabled('[data-checkout]'), await tab.text('.cart-feedback'));
  if (await requireControl(tab, '[data-recover-cart]', 'baseline', 'recovery into a new cart is offered')) {
    const unsafeId = await storedCartId(tab);
    await tab.tap('[data-recover-cart]');
    await tab.settled();
    const recoveredId = await storedCartId(tab);
    const recovered = await serverCart(recoveredId);
    check('baseline', 'recovery yields a separate, consistent cart with the BR16 glove', recoveredId !== unsafeId && gloves(recovered?.lines || []).filter(g => g.handle === 'br16').reduce((sum, g) => sum + g.quantity, 0) === 1 &&
      !pairingIssues(recovered.lines).length, recovered);
    check('baseline', 'recovered cart asks for review and then allows checkout', (await tab.text('.cart-feedback'))?.includes('Review the items') && await tab.enabled('[data-checkout]'), await tab.text('.cart-feedback'));
  }
});

define('Break-In failure between split-edit operations', async () => {
  const tab = await openTab('A');
  await addTrainer(tab, 'black', { breakIn: { level: 'Medium (65%)', wearingStyle: 'Traditional' } });
  await tab.tap('[data-qty-line][data-delta="1"]');
  await tab.settled();
  const beforeLines = await cartLines();
  const before = gloves(beforeLines);
  // The split adds the new glove line first; the next write (attach or decrement) fails before commit.
  const logStart = (await requestLog()).length;
  await control('failNext', { operation: null, phase: 'before', nth: 2 });
  await tab.tap('[data-edit-service]');
  await tab.until(`document.querySelector('[data-service-form]')`);
  await tab.click('[data-service-form] input[value="Two in the Pinky (TIP)"]');
  await tab.tap('[data-confirm-service]');
  await tab.settled(15000);
  const sent = (await requestLog()).slice(logStart).filter(entry => entry.mutation).map(entry => `${entry.operation}:${entry.outcome}`);
  check('harness', 'the first split write committed and the second failed', sent[0]?.endsWith(':committed') && sent[1]?.endsWith(':failed-before-commit'), sent);
  const lines = await cartLines();
  check('risk:4', 'no service is attached to the wrong glove mid-split', !pairingIssues(lines).filter(issue => !issue.serviceMissing).length, { lines, issues: pairingIssues(lines) });
  check('baseline', 'the interrupted split shows an error', (await tab.alerts()).length > 0 || await tab.eval(`!!document.querySelector('[data-service-error]:not([hidden])')`), await tab.alerts());
  check('baseline', 'checkout is blocked after the interrupted split', !await tab.enabled('[data-checkout]'));
  if (await requireControl(tab, '[data-recover-cart], [data-refresh-cart]', 'baseline', 'a recovery control is offered after the interrupted split')) {
    if (await tab.enabled('[data-refresh-cart]')) { await tab.tap('[data-refresh-cart]'); await tab.settled(); }
    check('baseline', 'checking the interrupted split keeps checkout blocked', !await tab.enabled('[data-checkout]'), await tab.text('.cart-feedback'));
    if (await requireControl(tab, '[data-recover-cart]', 'baseline', 'recovery into a new cart is offered after the interrupted split')) {
      await tab.tap('[data-recover-cart]');
      await tab.settled();
      const recovered = await serverCart(await storedCartId(tab));
      emit(splitRecoveryGate({ beforeLines, intendedLines: intendedSplit(beforeLines, 'Two in the Pinky (TIP)'), recoveredLines: recovered?.lines || [] }));
    }
  }
});

define('legacy carts from an earlier storefront version', async () => {
  const { cartId } = await control('legacyServiceCart');
  const tab = await openTab('A');
  await tab.visit('/product/br16');
  await tab.eval(`localStorage.setItem('anawin-shopify-cart-id', ${JSON.stringify(cartId)})`);
  await tab.reload();
  await tab.openCart();
  check('baseline', 'legacy service cart without saved choices blocks checkout', !await tab.enabled('[data-checkout]'));
  check('baseline', 'legacy service cart offers only the glove-only recovery', await tab.enabled('[data-recover-without-service]') && !await tab.eval(`!!document.querySelector('[data-recover-cart]')`),
    await tab.text('.cart-feedback'));
  await tab.tap('[data-recover-without-service]');
  await tab.settled();
  const recovered = await serverCart(await storedCartId(tab));
  check('baseline', 'glove-only recovery yields a new cart with exactly one BR16 and no service', recovered?.id !== cartId &&
    same(configuration(recovered?.lines || []), [{ merchandiseId: 'gid://variant/br16', quantity: 1, attributes: [{ key: '_anawin_service', value: 'none' }], services: [] }]) && !pairingIssues(recovered.lines).length, recovered);
  check('baseline', 'legacy cart is left untouched', same(gloves((await serverCart(cartId)).lines).map(g => g.services.length), [1]));
  check('baseline', 'recovered legacy cart can check out after review', await tab.enabled('[data-checkout]') && (await tab.text('.cart-feedback'))?.includes('Review the items'));
  // A pending-mutation record written by an older version keeps the cart blocked until recovery.
  await tab.closeCart();
  await tab.eval(`localStorage.setItem('anawin-shopify-pending-mutation', JSON.stringify({ cartId: localStorage.getItem('anawin-shopify-cart-id'), kind: 'addition' }))`);
  await tab.reload();
  await tab.openCart();
  check('baseline', 'legacy pending record blocks checkout', !await tab.enabled('[data-checkout]'), await tab.text('.cart-feedback'));
  await requireControl(tab, '[data-refresh-cart], [data-recover-cart]', 'baseline', 'legacy pending record offers a way forward');
});

define('discount apply, reject, repeat and remove', async () => {
  const tab = await openTab('A');
  await addTrainer(tab, 'black');
  check('baseline', 'discount panel starts collapsed', await tab.eval(`document.querySelector('[data-discount-toggle]').getAttribute('aria-expanded') === 'false' && document.querySelector('[data-discount-form]').hidden`));
  await tab.tap('[data-discount-toggle]');
  check('baseline', 'toggle expands the panel', await tab.eval(`document.querySelector('[data-discount-toggle]').getAttribute('aria-expanded') === 'true' && !document.querySelector('[data-discount-form]').hidden`));
  await applyDiscount(tab, 'NOTREAL');
  await tab.settled();
  check('baseline', 'rejected code shows a visible alert', await tab.eval(`(() => { const m = document.querySelector('#cart-discount-message'); return m.getAttribute('role') === 'alert' && m.textContent.includes('isn’t valid') && !m.classList.contains('visually-hidden'); })()`),
    await discountMessage(tab));
  check('baseline', 'rejected code marks the input invalid and keeps the panel open', await tab.eval(`document.querySelector('#cart-discount-input').getAttribute('aria-invalid') === 'true' && !document.querySelector('[data-discount-form]').hidden`));
  check('baseline', 'cart shows the rejected code as not applicable', (await tab.text('.cart-discount-code'))?.includes('NOTREAL not applicable'));
  await tab.tap('[data-remove-discount]');
  await tab.settled();
  check('baseline', 'rejected code can be removed', (await serverCart(await storedCartId(tab))).discountCodes.length === 0);
  // Repeat submission: a tap, a second tap and Enter before the first settles send one update.
  const before = (await mutations('UpdateDiscountCodes')).length;
  await typeDiscount(tab, 'SYNTH10');
  await tab.tap('[data-discount-apply]');
  // The second press lands while the first submission is in flight; Apply may already be disabled.
  await tab.tap('[data-discount-apply]', 1, { allowDisabled: true });
  await tab.key('Enter');
  await tab.settled();
  check('baseline', 'repeat submission sends a single discount update', (await mutations('UpdateDiscountCodes')).length - before === 1, await mutations('UpdateDiscountCodes'));
  let cart = await serverCart(await storedCartId(tab));
  check('baseline', 'server cart has exactly SYNTH10', same(cart.discountCodes, ['SYNTH10']), cart.discountCodes);
  check('baseline', 'applied code and discounted total are shown', (await tab.text('.cart-discount-code'))?.includes('SYNTH10 applied') &&
    (await tab.text('.cart-final-total'))?.includes('$139.50'), await tab.text('.cart-foot'));
  check('baseline', 'apply success is announced', (await discountMessage(tab)) === 'SYNTH10 applied.');
  // Re-applying an applied code does not send a mutation.
  const again = (await mutations('UpdateDiscountCodes')).length;
  await applyDiscount(tab, 'synth10');
  await tab.settled();
  check('baseline', 're-applying an applied code (any case) sends nothing', (await mutations('UpdateDiscountCodes')).length === again);
  // Collapse and expand keep state.
  await tab.tap('[data-discount-toggle]');
  check('baseline', 'collapsed panel still lists the applied code', (await tab.text('.cart-discount-code'))?.includes('SYNTH10 applied') && await tab.eval(`document.querySelector('[data-discount-form]').hidden`));
  await tab.tap('[data-remove-discount]');
  await tab.settled();
  cart = await serverCart(await storedCartId(tab));
  check('baseline', 'removal clears the code on the server and in the cart', !cart.discountCodes.length && !(await tab.eval(`document.querySelector('.cart-discount-code')`)) &&
    !(await tab.text('.cart-foot')).includes('Total before shipping/tax'));
  check('baseline', 'focus returns to the discount toggle after removing while collapsed', await tab.eval(`document.activeElement.matches('[data-discount-toggle]')`));
});

// Final state must equal the starting codes with every change a tab confirmed; a change may instead
// be refused only by a fresh, visible message that names its code (see discountGate).
defineRace('discount updates overlapping across two tabs', async () => {
  const a = await openTab('A');
  await addTrainer(a, 'black');
  await applyDiscount(a, 'SYNTH10');
  await a.settled();
  const b = await openTab('B');
  await b.visit('/product/br16');
  await b.openCart();
  await a.reload(); await a.openCart();
  const start = (await serverCart(await storedCartId(a))).discountCodes;
  check('harness', 'both tabs start from SYNTH10', same(start, ['SYNTH10']), start);
  await typeDiscount(a, 'SYNTH5');
  const before = { A: await a.alerts(), B: await b.alerts() };
  const { notOffered: removalNotOffered } = await race({ operation: 'UpdateDiscountCodes', secondTab: b, first: () => a.tap('[data-discount-apply]'), second: () => b.tap('[data-remove-discount]', 1, { allowDisabled: true }) });
  await a.settled(15000); await b.settled(15000);
  const codes = (await serverCart(await storedCartId(a))).discountCodes.map(code => code.toUpperCase()).sort();
  const actions = [
    { tab: 'A', kind: 'apply', code: 'SYNTH5', claimed: (await discountMessage(a)) === 'SYNTH5 applied.', refusal: await refusalOf(a, 'SYNTH5', 'apply', before.A, '[data-discount-apply]') },
    { tab: 'B', kind: 'remove', code: 'SYNTH10', claimed: (await discountMessage(b)) === 'Discount code removed.', refusal: notOfferedOr(removalNotOffered, await refusalOf(b, 'SYNTH10', 'remove', before.B, '[data-remove-discount], [data-discount-apply]')) }];
  emit(discountGate({ start, final: codes, actions }));
  for (const tab of [a, b]) {
    const shown = await tab.eval(`[...document.querySelectorAll('.cart-discount-code span')].map(s => s.textContent.trim().split(' ')[0].replace('✓', '').trim().toUpperCase()).filter(Boolean).sort()`);
    const warned = (await tab.alerts()).length > 0;
    check('risk:2', `tab ${tab.name} shows Shopify's codes or warns that the cart changed`, same(shown, codes) || warned, { shown, codes, warned });
    const claimed = /^(\w+) applied\.$/.exec(await discountMessage(tab) || '')?.[1];
    check('risk:2', `tab ${tab.name} does not report a code as applied that Shopify no longer has`, !claimed || codes.includes(claimed.toUpperCase()), { message: await discountMessage(tab), codes });
  }
  // Checkout in A must hand off only the cart A displays.
  const shownByA = await a.eval(`[...document.querySelectorAll('.cart-discount-code span')].map(s => s.textContent.trim().split(' ')[0].replace('✓', '').trim().toUpperCase()).filter(Boolean).sort()`);
  if (applicationContract === 'baseline' && await a.enabled('[data-checkout]')) {
    const count = handoffs.length;
    await a.tap('[data-checkout]');
    await poll(async () => documentHandoffs(count).length > 0 || (await a.eval(`!document.querySelector('[data-checkout][aria-busy]')`) && (await a.alerts()).length > 0), 8000);
    const handedOff = documentHandoffs(count).length > 0;
    check('baseline', 'checkout after the overlap hands off only a cart the tab displays', handedOff ? same(shownByA, codes) : (await a.alerts()).length > 0, { handedOff, shownByA, codes, feedback: await a.text('.cart-feedback') });
  }
  else if (applicationContract === 'combined') {
    const beforeRefresh = { A: await cartProbe(a), B: await cartProbe(b), authoritative: await serverCart(await storedCartId(a)) };
    const startNavigation = handoffs.length;
    const consistent = same(shownByA, codes);
    check('risk:2', 'checkout is withheld from a stale discount display and offers a verification action',
      (consistent || !beforeRefresh.A.checkout) && (beforeRefresh.A.checkout || beforeRefresh.A.refresh), beforeRefresh);
    const logStart = (await requestLog()).length;
    if (await a.enabled('[data-refresh-cart]')) { await a.tap('[data-refresh-cart]'); await a.settled(); }
    else { await a.reload(); await a.openCart(); }
    const afterRefresh = await cartProbe(a);
    const refreshReads = (await requestLog()).slice(logStart);
    const authoritative = beforeRefresh.authoritative;
    const activeId = await storedCartId(a);
    const synchronized = await storedCartId(b) === activeId && authoritative?.id === activeId;
    check('baseline', 'stale overlap tab has visible review with no freeze or unresolved journal',
      synchronized && (consistent || beforeRefresh.A.alerts.some(message => /cart changed in another tab/i.test(message))) &&
      !documentHandoffs(startNavigation).length &&
      !beforeRefresh.A.journal.length && !beforeRefresh.B.journal.length, beforeRefresh);
    const shownCodes = await a.eval(`[...document.querySelectorAll('[data-remove-discount]')].map(button => button.dataset.removeDiscount.toUpperCase()).sort()`);
    check('baseline', 'fresh authoritative read after the overlap restores the correct cart and checkout',
      afterRefresh.checkout && same(shownCodes, codes) && refreshReads.some(entry => entry.operation === 'Cart' &&
        entry.cartId === activeId && entry.returnedCartId === activeId && entry.status === 200) &&
      !refreshReads.some(entry => entry.mutation) && !afterRefresh.journal.length, { afterRefresh, shownCodes, codes, refreshReads });
    const count = handoffs.length;
    for (let i = 0; i < 2 && !documentHandoffs(count).length && await a.enabled('[data-checkout]'); i++) {
      await a.tap('[data-checkout]');
      await poll(async () => documentHandoffs(count).length > 0 || await a.eval(`!document.querySelector('[data-checkout][aria-busy]')`), 8000);
    }
    const navigation = documentHandoffs(count);
    const reads = (await requestLog()).slice(logStart);
    const final = reads.filter(entry => entry.operation === 'Cart' && entry.finishedAt <= navigation[0]?.at).at(-1);
    const verifiedHandoff = navigation.length === 1 && same(shownCodes, codes) && final?.cartId === activeId &&
      final.returnedCartId === activeId && final.checkoutUrl === navigation[0].url && !reads.some(entry => entry.mutation);
    check('baseline', 'checkout after the overlap hands off only a cart the tab displays', verifiedHandoff,
      { shownCodes, codes, final, navigation });
    check('harness', 'overlap coverage exercised authoritative refresh and checkout handoff', !!final &&
      refreshReads.some(entry => entry.operation === 'Cart' && entry.returnedCartId === activeId) && navigation.length === 1);
    observe('checkout unavailable after discount overlap', { beforeRefresh, afterRefresh, requests: reads, navigation });
  }
});

define('checkout handoff: held read, repeated taps, fresh exact URL', async () => {
  const tab = await openTab('A');
  await addTrainer(tab, 'black');
  await control('checkoutMode', { mode: 'rotate' });
  await tab.reload(); await tab.openCart();
  const rendered = (await lastCartRead())?.checkoutUrl;
  const cartNumber = (await storedCartId(tab))?.split('?')[0].split('/').at(-1);
  const start = handoffs.length;
  const logStart = (await requestLog()).length;
  // The handoff's verification read is held while the shopper keeps tapping.
  const { id } = await control('hold', { operation: 'Cart', phase: 'before' });
  await tab.tap('[data-checkout]');
  const held = await control('awaitHeld', { id, timeoutMs: 8000 });
  check('harness', 'the checkout verification read is held', held.arrived && await tab.eval(`!!document.querySelector('[data-checkout][aria-busy], [data-checkout][disabled]')`), held);
  await tab.tap('[data-checkout]', 3, { allowDisabled: true });
  await tab.key('Enter');
  check('baseline', 'no navigation while the verification read is held', !documentHandoffs(start).length);
  const released = await control('release', { id });
  check('harness', 'held read released', released.released, released);
  await tab.until(`document.title === 'Mock checkout'`, 10000).catch(() => {});
  await sleep(500); // any duplicate navigation would be requested within this window
  const mine = documentHandoffs(start);
  check('baseline', 'five checkout presses during a held read cause exactly one navigation', mine.length === 1, mine);
  const reads = (await requestLog()).slice(logStart).filter(entry => entry.operation === 'Cart' && entry.checkoutUrl && entry.finishedAt <= (mine[0]?.at ?? Infinity));
  const finalRead = reads.at(-1)?.checkoutUrl;
  const url = mine[0] && new URL(mine[0].url);
  const expected = finalRead && new URL(finalRead);
  check('baseline', 'handoff origin is exactly the approved HTTPS checkout host', url?.origin === `https://${CHECKOUT_HOST}` && url.port === '' && !url.username, mine[0]?.url);
  check('baseline', 'handoff path and query are exactly those of the final Shopify read', !!expected && mine[0]?.url === finalRead &&
    url.pathname === `/checkouts/${cartNumber}` && url.search === expected.search && /^\?key=synthetic-\d+&locale=en-US$/.test(url.search), { handedOff: mine[0]?.url, finalRead });
  check('baseline', 'handoff URL is fresh, not the one rendered before checkout', !!finalRead && finalRead !== rendered, { rendered, finalRead });
  const sent = (await requestLog()).slice(logStart).filter(entry => entry.mutation).map(entry => entry.operation);
  check('baseline', 'handoff sends no cart mutation (trainer cart has no preorder details)', !sent.length, sent);
});

define('checkout refuses invalid checkout URLs, on first render and on the final handoff read', async () => {
  const tab = await openTab('A');
  await addTrainer(tab, 'black');
  // What the mock returns for each mode (see rewriteCheckout in the server).
  const injected = { foreign: /^https:\/\/checkout\.example\.test\/checkouts\//, http: /^http:\/\/ignvv0-zh\.myshopify\.com\/checkouts\//,
    credentials: /^https:\/\/user:pass@ignvv0-zh\.myshopify\.com\/checkouts\//, lookalike: /^https:\/\/ignvv0-zh\.myshopify\.com\.example\.test\/checkouts\//,
    port: /^https:\/\/ignvv0-zh\.myshopify\.com:8443\/checkouts\// };
  for (const when of ['rendered', 'final read']) {
    for (const [mode, pattern] of Object.entries(injected)) {
      await control('checkoutMode', { mode: null }); await tab.reload(); await tab.openCart();
      const start = handoffs.length;
      const externalBefore = external.length;
      const logStart = (await requestLog()).length;
      const alertsBefore = await tab.alerts();
      await control('checkoutMode', { mode });
      if (when === 'rendered') { await tab.reload(); await tab.openCart(); }
      const offered = await tab.enabled('[data-checkout]');
      // A valid URL was rendered, so checkout must be offered and the injected URL can only arrive on the handoff read.
      if (when === 'final read') check('baseline', `${mode} URL (final read): checkout is offered for the valid rendered cart`, offered, { feedback: await tab.text('.cart-feedback') });
      const cartId = await storedCartId(tab);
      let refusedAt = Infinity;
      if (offered) {
        await tab.tap('[data-checkout]');
        if (await poll(async () => await tab.eval(`!document.querySelector('[data-checkout][aria-busy]')`) && (await tab.alerts()).some(text => !alertsBefore.includes(text)), 8000)) refusedAt = Date.now();
      }
      check('baseline', `${mode} URL (${when}) never navigates or leaves the mock`, !documentHandoffs(start).length && external.length === externalBefore, { offered });
      // The Cart reads that had finished when the refusal appeared; the last of them is the handoff's final read.
      const reads = (await requestLog()).slice(logStart).filter(entry => entry.operation === 'Cart' && entry.finishedAt <= refusedAt);
      if (when === 'rendered' && !offered && applicationContract === 'combined') {
        const final = reads.at(-1);
        check('baseline', `${mode} URL (rendered): the final Cart read was for this cart, succeeded and returned the injected URL`,
          final?.cartId === cartId && final.status === 200 && pattern.test(final.checkoutUrl || ''), final);
      }
      if (when === 'rendered' && applicationContract === 'combined') check('baseline', `${mode} URL (rendered): checkout is disabled`, !offered);
      emit(invalidUrlGate({ label: `${mode} URL (${when})`, pattern, reads, offered, alertsBefore, alertsAfter: await tab.alerts(), activeCartId: cartId }));
    }
  }
  // The refusal offers Check cart; once Shopify returns a valid URL again, checking the cart leads to one handoff.
  await control('checkoutMode', { mode: 'rotate' });
  if (await requireControl(tab, '[data-refresh-cart], [data-checkout]', 'baseline', 'after a refused URL a way forward (Check cart or Checkout) is offered')) {
    if (await tab.enabled('[data-refresh-cart]')) { await tab.tap('[data-refresh-cart]'); await tab.settled(); }
    const start = handoffs.length;
    for (let i = 0; i < 2 && !documentHandoffs(start).length; i++) {
      if (await tab.enabled('[data-checkout]')) await tab.tap('[data-checkout]');
      await poll(async () => documentHandoffs(start).length > 0 || await tab.eval(`!document.querySelector('[data-checkout][aria-busy]')`), 10000);
    }
    await sleep(300);
    check('baseline', 'after refusals and Check cart, a valid URL hands off once', documentHandoffs(start).length === 1, documentHandoffs(start));
  }
});

define('active mutation versus checkout, in the same tab and across tabs', async () => {
  const a = await openTab('A');
  await addTrainer(a, 'black');
  // Same tab: a quantity update is in flight when the shopper taps checkout.
  const { id } = await control('hold', { operation: 'UpdateLines', phase: 'before' });
  await a.tap('[data-qty-line][data-delta="1"]');
  check('harness', 'quantity update is held', (await control('awaitHeld', { id })).arrived);
  let start = handoffs.length;
  const disabled = await a.eval(`!!document.querySelector('[data-checkout][disabled]')`);
  await a.tap('[data-checkout]', 1, { allowDisabled: true });
  await sleep(300);
  check('baseline', 'checkout is disabled while this tab\'s update is in flight', disabled);
  check('baseline', 'tapping checkout during the update does not navigate', !documentHandoffs(start).length);
  await control('release', { id });
  await a.settled(15000);
  check('baseline', 'the update completes after release', (await cartLines())[0]?.quantity === 2);
  // Across tabs: B's update is in flight when A checks out.
  const b = await openTab('B');
  await b.visit('/product/br16'); await b.openCart();
  await a.reload(); await a.openCart();
  const hold = await control('hold', { operation: 'UpdateLines', phase: 'before' });
  await b.tap('[data-qty-line][data-delta="-1"]');
  check('harness', 'tab B\'s update is held', (await control('awaitHeld', { id: hold.id })).arrived);
  start = handoffs.length;
  if (await a.enabled('[data-checkout]')) {
    await a.tap('[data-checkout]');
    await poll(async () => documentHandoffs(start).length > 0 || (await a.eval(`!document.querySelector('[data-checkout][aria-busy]')`) && (await a.alerts()).length > 0), 8000);
  }
  check('baseline', 'tab A does not hand off while tab B\'s update is pending', !documentHandoffs(start).length);
  check('baseline', 'tab A explains why checkout did not open', (await a.alerts()).length > 0 || !await a.enabled('[data-checkout]'), await a.text('.cart-feedback'));
  await control('release', { id: hold.id });
  await b.settled(15000);
  // After B finishes, A must review the new quantity, then hand off once.
  if (await a.enabled('[data-refresh-cart]')) { await a.tap('[data-refresh-cart]'); await a.settled(); }
  start = handoffs.length;
  for (let i = 0; i < 2 && !documentHandoffs(start).length; i++) {
    if (await a.enabled('[data-checkout]')) await a.tap('[data-checkout]');
    await poll(async () => documentHandoffs(start).length > 0 || await a.eval(`!document.querySelector('[data-checkout][aria-busy]')`), 8000);
  }
  await sleep(300);
  check('baseline', 'after the update settles and is reviewed, checkout hands off once', documentHandoffs(start).length === 1, documentHandoffs(start));
});

define('cart change in another tab requires review before handoff', async () => {
  const a = await openTab('A');
  await addTrainer(a, 'black');
  const b = await openTab('B');
  await b.visit('/product/br16');
  await b.openCart();
  await b.tap('[data-qty-line][data-delta="1"]');
  await b.settled();
  const start = handoffs.length;
  if (await a.enabled('[data-checkout]')) {
    await a.tap('[data-checkout]');
    await a.until(`!document.querySelector('[data-checkout][aria-busy]')`);
  }
  check('baseline', 'stale tab does not hand off after another tab changed the cart', !documentHandoffs(start).length);
  check('baseline', 'stale tab explains the change', (await a.text('.cart-feedback'))?.includes('changed'), await a.text('.cart-feedback'));
  // Review shows quantity 2; then checkout proceeds with the reviewed cart.
  if (await a.enabled('[data-refresh-cart]')) { await a.tap('[data-refresh-cart]'); await a.settled(); }
  check('baseline', 'after review, the stale tab shows the current quantity', (await a.text('.quantity span')) === '2');
  for (let i = 0; i < 2 && !documentHandoffs(start).length; i++) {
    if (await a.enabled('[data-checkout]')) await a.tap('[data-checkout]');
    await poll(async () => documentHandoffs(start).length > 0 || await a.eval(`!document.querySelector('[data-checkout][aria-busy]')`), 10000);
  }
  await sleep(300);
  check('baseline', 'reviewed cart hands off once', documentHandoffs(start).length === 1, handoffs.slice(start));
});

define('frozen cart after a dropped handoff is visible across tabs, unmodifiable and recoverable', async () => {
  const a = await openTab('A');
  await addTrainer(a, 'black', { breakIn: { level: 'Firm (40%)', wearingStyle: 'Traditional' } });
  // A tab that loaded the cart before the freeze and still shows it as editable.
  const stale = await openTab('C');
  await stale.visit('/product/br16'); await stale.openCart();
  const frozenId = await storedCartId(a);
  const frozenBefore = await serverCart(frozenId);
  a.checkoutResponse = 'drop';
  const start = handoffs.length;
  const focusBefore = await a.eval(`(() => {
    window.__handoffFocus = [];
    const sample = type => {
      const element = document.activeElement;
      const control = document.querySelector('[data-checkout]');
      return { type, at: Date.now(), active: element?.outerHTML.split('>')[0] + '>',
        checkout: control ? { disabled: control.disabled, busy: control.getAttribute('aria-busy') } : null,
        recovery: !!document.querySelector('[data-recover-cart]') };
    };
    window.__handoffFocus.push(sample('before'));
    for (const type of ['focusin', 'focusout', 'pointerdown', 'keydown']) document.addEventListener(type, () => {
      window.__handoffFocus.push(sample(type));
    }, true);
    let previous;
    new MutationObserver(() => {
      const event = sample('render');
      const signature = JSON.stringify([event.active, event.checkout, event.recovery]);
      if (signature !== previous) window.__handoffFocus.push(event);
      previous = signature;
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled', 'aria-busy'] });
    return { active: document.activeElement?.outerHTML.split('>')[0], width: innerWidth, height: innerHeight };
  })()`);
  await a.tap('[data-checkout]');
  // The handoff watcher reports a page that stayed after 2s.
  await a.until(`(document.querySelector('.cart-feedback')?.textContent || '').includes('Secure checkout was started')`, 10000);
  check('baseline', 'dropped handoff attempted exactly one navigation', documentHandoffs(start).length === 1);
  check('baseline', 'frozen cart is announced as an alert', await a.eval(`document.querySelector('.cart-feedback .cart-error')?.getAttribute('role') === 'alert'`));
  check('baseline', 'frozen cart controls are disabled', await a.eval(`[...document.querySelectorAll('[data-qty-line], [data-edit-service], [data-remove-service], [data-wrist-fit]')].every(b => b.disabled)`));
  check('baseline', 'checkout is not offered again for the frozen cart', !await a.enabled('[data-checkout]'));
  observe('dropped checkout focus lifecycle', { before: focusBefore, events: await a.eval('window.__handoffFocus'),
    navigation: documentHandoffs(start) });
  check('baseline', 'focus moves to the recovery action', await a.eval(`document.activeElement.matches('[data-recover-cart], [data-refresh-cart]')`));
  const mutationsBefore = (await mutations()).length;
  // A new tab sees the freeze; a real tap on its stepper changes nothing.
  const b = await openTab('B');
  await b.visit('/product/br16');
  await b.openCart();
  check('baseline', 'another tab also sees the cart as frozen', !await b.enabled('[data-checkout]') && (await b.text('.cart-feedback') || '').includes('Secure checkout was started'), await b.text('.cart-feedback'));
  check('baseline', 'another tab\'s cart controls are disabled', await b.eval(`[...document.querySelectorAll('[data-qty-line], [data-edit-service], [data-remove-service], [data-wrist-fit]')].every(b => b.disabled)`));
  const frozenPress = await b.tap('[data-qty-line][data-delta="1"]', 1, { allowDisabled: true });
  check('baseline', 'a press on the frozen cart\'s + in another tab reaches only a disabled control', frozenPress.disabled === true && frozenPress.delivered === false, frozenPress);
  // The stale tab tries to change the frozen cart.
  const staleEnabled = await stale.enabled('[data-qty-line][data-delta="1"]');
  if (staleEnabled) { await stale.tap('[data-qty-line][data-delta="1"]'); await stale.settled(15000).catch(() => {}); }
  await sleep(300);
  const writes = (await mutations()).slice(mutationsBefore);
  check('baseline', 'no tab sends a write against the frozen cart', writes.every(entry => entry.cartId !== frozenId), writes);
  check('baseline', 'the stale tab refuses its change visibly or shows the cart frozen', !staleEnabled || (await stale.alerts()).length > 0, { staleEnabled, alerts: await stale.alerts() });
  check('baseline', 'the frozen cart is unchanged at Shopify', same(await serverCart(frozenId), frozenBefore));
  await b.closeCart();
  await a.tap('[data-recover-cart]');
  await a.settled();
  const newId = await storedCartId(a);
  const recovered = await serverCart(newId);
  check('baseline', 'recovery moves to a new cart', !!newId && newId !== frozenId, { frozenId, newId });
  check('baseline', 'recovered cart has exactly the frozen cart\'s gloves, quantities, service lines and attributes', same(configuration(recovered?.lines || []), configuration(frozenBefore.lines)) &&
    !pairingIssues(recovered.lines).length, { recovered: configuration(recovered?.lines || []), frozen: configuration(frozenBefore.lines) });
  check('baseline', 'frozen cart is never mutated after handoff', (await mutations()).slice(mutationsBefore).every(entry => entry.cartId !== frozenId) && same(await serverCart(frozenId), frozenBefore));
  check('baseline', 'recovered cart asks for review before checkout', (await a.text('.cart-feedback'))?.includes('Review the items'));
});

if (applicationContract === 'combined') {
  for (const [name, width, height, moveFocus] of [['desktop', 1440, 900, false], ['mobile', 390, 844, false],
    ['intentional move during verification', 1440, 900, true]]) {
    define(`Dropped checkout keyboard focus on ${name}`, async () => {
      const tab = await openTab('A');
      await tab.viewport(width, height);
      await addTrainer(tab, 'black');
      const source = await storedCartId(tab);
      const advanceFocus = async selector => {
        for (let i = 0; i < 25; i++) {
          if (await tab.eval(`document.activeElement.matches(${JSON.stringify(selector)})`)) return true;
          await tab.key('Tab');
        }
        return false;
      };
      check('baseline', 'keyboard reaches Checkout from the cart drawer', await advanceFocus('[data-checkout]'));
      const start = handoffs.length;
      const logStart = (await requestLog()).length;
      tab.checkoutResponse = 'drop';
      await tab.key('Enter');
      await tab.until(`document.querySelector('[data-checkout]')?.textContent === 'Opening checkout…'`);
      if (moveFocus) {
        const { id } = await control('hold', { operation: 'Cart', phase: 'before' });
        const held = await control('awaitHeld', { id });
        check('harness', 'frozen verification read is held during intentional keyboard movement', held.arrived);
        check('baseline', 'user can move focus during the pending verification read', await advanceFocus('.cart-head [data-close-cart]'));
        await control('release', { id });
      }
      await tab.until(`(document.querySelector('.cart-feedback')?.innerText || '').includes('Secure checkout was started')`, 10000);
      const target = moveFocus ? '.cart-head [data-close-cart]' : '[data-recover-cart]';
      const evidence = await tab.eval(`(() => {
        const el = document.activeElement;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return { matches: el.matches(${JSON.stringify(target)}), actionable: !el.disabled && !el.closest('[hidden], [inert], [aria-hidden=true]'),
          active: el.outerHTML.split('>')[0] + '>', width: innerWidth, height: innerHeight,
          visible: rect.height > 0 && rect.width > 0 && rect.bottom > 0 && rect.top < innerHeight,
          focusVisible: el.matches(':focus-visible'), outline: style.outlineStyle, shadow: style.boxShadow };
      })()`);
      check('baseline', 'dropped handoff respects keyboard focus and exposes a visible actionable control',
        evidence.matches && evidence.visible && evidence.actionable && evidence.focusVisible &&
        (evidence.outline !== 'none' || evidence.shadow !== 'none'), evidence);
      check('baseline', 'dropping checkout grants no recovery consent and leaves the source frozen',
        documentHandoffs(start).length === 1 && !(await requestLog()).slice(logStart).some(entry => entry.mutation) &&
        !await tab.enabled('[data-checkout]') && await storedCartId(tab) === source);
      if (moveFocus) check('baseline', 'the verification redraw leaves a keyboard route to recovery', await advanceFocus('[data-recover-cart]'));
      await tab.key('Enter');
      await tab.settled();
      const requests = (await requestLog()).slice(logStart).filter(entry => entry.mutation);
      check('baseline', 'keyboard recovery requires activation and leaves the frozen source untouched',
        await storedCartId(tab) !== source && requests.length === 1 && requests[0].operation === 'CreateCart' &&
        requests[0].cartId !== source && documentHandoffs(start).length === 1, requests);
    });
  }
}

define('preorder checkout handoff saves the estimate, and an unconfirmed estimate blocks checkout', async () => {
  const tab = await openTab('A');
  await addFullSize(tab, { breakIn: false });
  await control('checkoutMode', { mode: 'rotate' });
  const estimate = (await tab.eval(`document.querySelector('.cart-body')?.textContent || ''`));
  const cartId = await storedCartId(tab);
  const start = handoffs.length;
  const logStart = (await requestLog()).length;
  await tab.tap('[data-checkout]');
  await tab.until(`document.title === 'Mock checkout'`, 10000).catch(() => {});
  await sleep(300);
  const during = (await requestLog()).slice(logStart);
  const write = during.find(entry => entry.operation === 'UpdateCartAttributes');
  const mine = documentHandoffs(start);
  const cart = await serverCart(cartId);
  const saved = cart?.attributes.find(item => item.key === 'Preorder estimated ship')?.value || '';
  check('baseline', 'preorder handoff writes the estimate to the cart before navigating', !!write && write.attributeKeys.includes('Preorder estimated ship') && (mine[0]?.at ?? 0) >= write.finishedAt, { write, handoff: mine[0] });
  check('baseline', 'saved estimate names MI26', /^MI26: .+/.test(saved), { saved, cartText: estimate.slice(0, 200) });
  check('baseline', 'preorder cart hands off once to the final read\'s URL', mine.length === 1 && mine[0].url === during.filter(entry => entry.operation === 'Cart' && entry.checkoutUrl && entry.finishedAt <= mine[0].at).at(-1)?.checkoutUrl, mine);
  // Shopify now reports a different estimate than the storefront approved: the glove cannot be confirmed.
  await closeContext(); await control('reset', { scenario }); await newContext();
  const second = await openTab('B');
  await addFullSize(second, { breakIn: false });
  await second.closeCart();
  await control('setMetafield', { handle: 'mi26', value: 'Ships at an unconfirmed date' });
  await second.reload(`document.readyState === 'complete' && !!document.querySelector('main')`);
  await second.openCart();
  const blockedStart = handoffs.length;
  if (await second.enabled('[data-checkout]')) {
    await second.tap('[data-checkout]');
    await poll(async () => await second.eval(`!document.querySelector('[data-checkout][aria-busy]')`) && (await second.alerts()).length > 0, 8000);
  }
  check('baseline', 'an unconfirmed preorder estimate never hands off', !documentHandoffs(blockedStart).length);
  const drawer = await second.eval(`(() => { const d = document.querySelector('.cart-drawer'); return { text: d?.innerText.replace(/\\s+/g, ' ').slice(0, 600), checkout: document.querySelector('[data-checkout]')?.outerHTML.slice(0, 120) || null }; })()`);
  // The explanation may be a cart alert or the MI26 row's own notice; either way checkout must not be offered silently.
  const rowNotice = await second.eval(`[...document.querySelectorAll('.cart-item')].some(row => row.textContent.includes('MI26') && /not available/i.test(row.innerText))`);
  check('baseline', 'an unconfirmed preorder estimate is explained visibly', (await second.alerts()).length > 0 || rowNotice && !await second.enabled('[data-checkout]'), { alerts: await second.alerts(), rowNotice, drawer });
});

define('Web Locks unavailable blocks checkout safely', async () => {
  const hideLocks = `Object.defineProperty(Navigator.prototype, 'locks', { configurable: true, get: () => undefined });`;
  const tab = await openTab('A', { init: hideLocks });
  if (applicationContract === 'baseline') {
    await addTrainer(tab, 'black');
    check('baseline', 'add still works without Web Locks', (await cartLines()).length === 1);
  } else {
    await tab.visit('/product/br16');
    const before = await cartProbe(tab);
    const requestStart = browserRequests.length;
    check('harness', 'Web Locks are unavailable in the lockless tab', await tab.eval('navigator.locks === undefined'));
    await addTrainer(tab, 'black');
    const after = await cartProbe(tab);
    const { carts } = await control('carts');
    const dispatches = browserRequests.slice(requestStart).filter(request => request.mutation);
    const writes = await mutations();
    check('baseline', 'lockless add dispatches no mutation and creates no cart effect', !dispatches.length && !writes.length && !carts.length, { dispatches, writes, carts });
    check('baseline', 'lockless add preserves empty cart and storage', same(before.storage, after.storage) && !await storedCartId(tab) && before.count === after.count && after.count === '(0)', { before, after });
    check('baseline', 'lockless add is explained and the product control recovers', after.alerts.some(text => normalizeCopy(text) === 'Your cart can’t be changed safely in this browser. Try an up-to-date browser with site data turned on.') && await tab.enabled('[data-add="black"]'), after);
  }
  const normal = applicationContract === 'combined' ? await openTab('B') : null;
  if (normal) {
    await addTrainer(normal, 'black');
    await tab.reload(); await tab.openCart();
    check('baseline', 'lockless tab restores the populated cart', await storedCartId(tab) === await storedCartId(normal) &&
      (await cartLines()).length === 1 && (await cartProbe(tab)).rows.some(row => row.includes('BR16')));
  }
  const before = await cartStorage(tab);
  const requestStart = browserRequests.length;
  const writeCount = (await mutations()).length;
  const start = handoffs.length;
  if (await tab.enabled('[data-checkout]')) {
    await tab.tap('[data-checkout]');
    await tab.until(`!document.querySelector('[data-checkout][aria-busy]')`);
  }
  check('baseline', 'checkout without Web Locks never navigates', !documentHandoffs(start).length);
  check('baseline', 'checkout without Web Locks explains why', (await tab.text('.cart-feedback'))?.includes('Secure checkout is unavailable in this browser'), await tab.text('.cart-feedback'));
  if (normal) check('baseline', 'lockless checkout preserves cart storage and dispatches no mutation',
    same(before, await cartStorage(tab)) && (await mutations()).length === writeCount && !browserRequests.slice(requestStart).some(request => request.mutation));

});

for (const [name, width, height, ambiguous] of [['desktop', 1440, 900, false], ['mobile', 390, 844, false], ['ambiguous prior mutation', 1440, 900, true]]) {
  if (applicationContract === 'baseline') continue;
  define(`Busy discount controls on ${name}`, async () => {
    const tab = await openTab('A');
    await tab.viewport(width, height);
    await addTrainer(tab, 'black');
    await applyDiscount(tab, 'SYNTH5');
    await tab.settled();
    await typeDiscount(tab, 'SYNTH10');
    const formerCount = (await mutations('UpdateDiscountCodes')).length;
    const requestStart = browserRequests.length, navigationStart = handoffs.length;
    if (ambiguous) await control('failNext', { operation: 'UpdateLines', status: 503, phase: 'after' });
    const { id } = await control('hold', { operation: 'UpdateLines', phase: 'before' });
    await tab.tap('[data-qty-line][data-delta="1"]');
    const held = await control('awaitHeld', { id });
    check('harness', 'quantity mutation reached the hold', held.arrived, held);
    const controlState = () => tab.eval(`(() => {
      const button = document.querySelector('[data-discount-apply]'), input = document.querySelector('#cart-discount-input');
      return { button: button.disabled, input: input.disabled, value: input.value,
        remove: document.querySelector('[data-remove-discount]').disabled,
        focus: document.activeElement?.outerHTML.slice(0, 160),
        wait: [...document.querySelectorAll('.cart-discount-entry [role="status"]')].some(node => /Wait for your cart update/.test(node.textContent) && node.getClientRects().length) };
    })()`);
    const busy = await controlState();
    check('baseline', 'Apply, the input and discount removal are natively disabled with accessible busy feedback',
      busy.button && busy.input && busy.remove && busy.wait && busy.value === 'SYNTH10', busy);
    const apply = await tab.tap('[data-discount-apply]', 1, { allowDisabled: true });
    const remove = await tab.tap('[data-remove-discount]', 1, { allowDisabled: true });
    const keyboard = await tab.eval(`['[data-discount-apply]', '#cart-discount-input'].map(selector => {
      const node = document.querySelector(selector); node.focus(); return document.activeElement === node;
    })`);
    await tab.key(' '); await tab.key('Enter');
    check('baseline', 'disabled Apply and Remove ignore pointer input and the blocked form cannot take keyboard focus',
      apply.disabled && remove.disabled && keyboard.every(focused => !focused), { apply, remove, keyboard });
    await control('release', { id }); await tab.settled(15000);
    const after = await controlState();
    const storefront = await cartProbe(tab);
    const discountDispatches = () => browserRequests.slice(requestStart).filter(request => request.operation === 'UpdateDiscountCodes');
    check('baseline', 'busy interaction sent no discount request and preserved the entered code',
      !discountDispatches().length && (await mutations('UpdateDiscountCodes')).length === formerCount && after.value === 'SYNTH10', { after, storefront });
    if (ambiguous) {
      check('baseline', 'an unresolved conflicting operation keeps discounts and checkout unavailable',
        after.button && after.input && after.remove && !after.wait && !!storefront.journal.length && storefront.refresh && !storefront.checkout && !documentHandoffs(navigationStart).length, storefront);
      return;
    }
    check('baseline', 'authoritative settlement restores discount controls', !after.button && !after.input && !after.remove && !after.wait, after);
    await tab.eval(`document.querySelector('#cart-discount-input').focus()`);
    await tab.key('Enter');
    await tab.settled();
    const final = await serverCart(await storedCartId(tab));
    check('baseline', 'Enter after settlement applies exactly once and keeps focus in the discount entry',
      discountDispatches().length === 1 && (await mutations('UpdateDiscountCodes')).length === formerCount + 1 &&
      final.discountApplicability.some(entry => entry.code === 'SYNTH10' && entry.applicable) &&
      await tab.eval(`document.activeElement.id === 'cart-discount-input'`), final);
  });
}

if (applicationContract === 'combined') define('Targeted uncertain discount feedback gate controls', async () => {
  const write = { tag: 'A-1', operation: 'UpdateDiscountCodes', cartId: 'cart', seq: 11, startedAt: 1100,
    committedAt: 1150, finishedAt: 1160, status: 200, commitSeq: 1, discountCodes: ['SYNTH10'],
    returnedCartId: 'another', outcome: 'committed-response-substituted',
    committedState: { discountApplicability: [{ code: 'SYNTH10', applicable: true }] } };
  const journal = { key: 'anawin-shopify-unsafe-op:owner', owner: 'owner', kind: 'applyDiscountCode', kinds: ['discount update'],
    dispatched: true, status: 'unresolved', cartId: 'cart', createdAt: 1090,
    step: { n: 1, field: 'cartDiscountCodesUpdate', target: 'cart', state: 'dispatched-unknown' } };
  const uncertainty = { dispatches: [{ tag: 'A-1', operation: 'UpdateDiscountCodes', cartId: 'cart',
    discountCodes: ['SYNTH10'], at: 1099 }], journal: [journal], refresh: true, checkout: false, apply: false, navigation: 0 };
  const feedback = (text, at = 1200) => ({ at, text: `${text} |  |  | ` });
  const valid = { applyEnabled: true, cartId: 'cart', held: { seq: 10, finishedAt: 1000 }, writes: [write],
    codes: ['SYNTH10'], codeStates: write.committedState.discountApplicability, message: UNCERTAIN_COPY,
    events: [feedback(UNCERTAIN_COPY)], uncertainty };
  const test = (name, overrides, expected) => {
    const verdicts = busyApplyGate({ ...valid, ...overrides });
    check('harness', name, verdicts.every(item => item.pass) === expected, verdicts[0].detail.facts);
  };
  test('accepts uncertainty for a dispatched commit with unusable confirmation', {}, true);
  test('accepts uncertainty for a dispatched uncommitted request with unusable confirmation', {
    writes: [{ ...write, commitSeq: undefined, committedAt: undefined, outcome: 'response-forged' }], codes: [], codeStates: []
  }, true);
  test('rejects an uncertain claim before settlement', { events: [feedback(UNCERTAIN_COPY, 1159), ...valid.events] }, false);
  test('rejects unrelated feedback', { events: [{ at: 1200, text: ` | ${UNCERTAIN_COPY} |  | ` }] }, false);
  test('rejects feedback correlated to the wrong dispatch', {
    uncertainty: { ...uncertainty, dispatches: [{ ...uncertainty.dispatches[0], tag: 'B-2' }] }
  }, false);
  test('rejects feedback with a journal for the wrong operation', {
    uncertainty: { ...uncertainty, journal: [{ ...journal, kind: 'adjustLineQuantity' }] }
  }, false);
  test('rejects any false success during the uncertain result', { events: [...valid.events, feedback('SYNTH10 applied.')] }, false);
  test('rejects definitive rejection following commitment', { events: [...valid.events, feedback(NOT_APPLICABLE_COPY)] }, false);
  test('rejects an incorrect applicability state', { codeStates: [{ code: 'SYNTH10', applicable: false }] }, false);
  test('rejects missing recovery controls', { uncertainty: { ...uncertainty, refresh: false } }, false);
  test('rejects uncertain feedback after an authoritative success', { writes: [{ ...write, returnedCartId: 'cart', outcome: 'committed' }] }, false);
  test('rejects uncertainty when the response provides a definitive rejection', { writes: [{ ...write, userErrors: ['rejected'] }] }, false);
  test('rejects unsafe checkout eligibility', { uncertainty: { ...uncertainty, checkout: true } }, false);
  test('rejects unsafe checkout navigation', { uncertainty: { ...uncertainty, navigation: 1 } }, false);
  test('rejects an automatic replay', { uncertainty: { ...uncertainty, dispatches: [...uncertainty.dispatches, uncertainty.dispatches[0]] } }, false);
});

if (applicationContract === 'combined') define('Web Locks real same-origin coordination', async () => {
  const a = await openTab('A'), b = await openTab('B');
  await a.visit('/product/br16'); await b.visit('/product/br16');
  const secure = await Promise.all([a, b].map(tab => tab.eval(`({ secure: isSecureContext, origin: location.origin, locks: typeof navigator.locks?.request })`)));
  check('harness', 'normal tabs share the expected secure mock origin and expose Web Locks', secure.every(tab => tab.secure && tab.origin === BASE && tab.locks === 'function'), secure);
  await a.eval(`void (window.__lockDone = navigator.locks.request('phase6-probe', { mode: 'exclusive' }, lock =>
    new Promise(resolve => { window.__releaseLock = resolve; window.__heldMode = lock.mode; })))`);
  await a.until(`window.__heldMode === 'exclusive'`);
  const acquire = () => b.eval(`navigator.locks.request('phase6-probe', { mode: 'exclusive', ifAvailable: true }, lock => lock?.mode ?? null)`);
  try {
    check('baseline', 'tab B cannot acquire the exclusive lock while A holds it', await acquire() === null);
  } finally {
    await a.eval(`(window.__releaseLock(), window.__lockDone)`);
  }
  check('baseline', 'tab B acquires the exclusive lock after release', await acquire() === 'exclusive');
});

// Each glove must end up in the one active cart exactly once, or its tab must refuse it by name and
// still offer it; every cart Shopify created is inspected (see firstAddGate).
defineRace('simultaneous first add from two tabs', async () => {
  const a = await openTab('A');
  const b = await openTab('B');
  await a.visit('/product/br16');
  await b.visit('/product/ob16');
  const before = { A: await a.alerts(), B: await b.alerts() };
  const mark = Date.now();
  const { notOffered: secondAddNotOffered } = await race({ operation: 'CreateCart', secondTab: b, secondOperations: ['CreateCart', 'AddLines'],
    first: () => a.tap('[data-add="black"]'), second: () => b.tap('[data-add="blue"]', 1, { allowDisabled: true }) });
  for (const tab of [a, b]) await tab.settled(15000).catch(() => {});
  const { carts, created } = await control('carts');
  const activeId = await storedCartId(a);
  const intents = [];
  for (const [tab, name, id, merchandiseId] of [[a, 'BR16', 'black', 'gid://variant/br16'], [b, 'OB16', 'blue', 'gid://variant/ob16']]) {
    const said = await tab.eval(`document.querySelector('[data-cart-announcer]')?.textContent || ''`);
    intents.push({ name, tab: tab.name, expected: { merchandiseId, quantity: 1, attributes: [{ key: '_anawin_service', value: 'none' }] },
      submitted: browserRequests.filter(item => item.scenario === scenario && item.tab === tab.name && item.at >= mark && ['CreateCart', 'AddLines'].includes(item.operation)).map(item => item.operation),
      claimed: said.includes(name) && /added/i.test(said) ? said : null, refusal: notOfferedOr(tab === b && secondAddNotOffered, await refusalOf(tab, name, 'add', before[tab.name], `[data-add="${id}"]`)) });
  }
  if (applicationContract === 'combined') {
    const active = carts.find(cart => cart.id === activeId);
    const expected = intents.map(intent => intent.expected);
    check('risk:3', 'both first-add intents persist exactly once in the one active cart without recovery',
      await storedCartId(b) === activeId && !!active &&
      active.lines.length === expected.length && expected.every(item => active.lines.filter(line =>
        !line.parentId && line.quantity === 1 && sameConfiguration(line, item)).length === 1) &&
      carts.filter(cart => cart.lines.length).length === 1 &&
      !await a.enabled('[data-recover-cart]') && !await b.enabled('[data-recover-cart]'), { active, carts });
    observe('conditional first-add recovery identities', { exercised: false, mappedScenario: 'first-add recovery after an uncommitted ambiguous update' });
  }
  if (applicationContract === 'baseline' && !selfTest) {
    observe('baseline first-add committed evidence', {
      activeId, otherTabActiveId: await storedCartId(b), carts, created, intents,
      recoveryOffered: await a.enabled('[data-recover-cart]'),
      dispatches: browserRequests.filter(entry => entry.scenario === scenario && entry.mutation),
      writes: await mutations()
    });
  }
  // If the storefront offers recovery, it must create exactly one new cart holding an exact copy.
  let recovery = null;
  let finalCarts = carts;
  if (applicationContract === 'baseline' && await a.enabled('[data-recover-cart]')) {
    const copied = configuration(carts.find(cart => cart.id === activeId)?.lines || []);
    await a.tap('[data-recover-cart]');
    await a.settled(15000).catch(() => {});
    finalCarts = (await control('carts')).carts;
    const recoveredId = await storedCartId(a);
    recovery = { sourceId: activeId, cartId: recoveredId, created: finalCarts.map(cart => cart.id).filter(id => !carts.some(cart => cart.id === id)),
      before: copied, after: configuration(finalCarts.find(cart => cart.id === recoveredId)?.lines || []) };
  }
  if (applicationContract === 'baseline' && !selfTest) {
    observe('baseline first-add final mutation ledger', {
      activeId: await storedCartId(a), carts: finalCarts,
      dispatches: browserRequests.filter(entry => entry.scenario === scenario && entry.mutation), writes: await mutations()
    });
  }
  emit(firstAddGate({ intents, activeCartId: await storedCartId(a), carts: finalCarts, recovery }));
  observe('carts created during the race', { created, activeId, intents: intents.map(({ name, submitted, claimed, refusal }) => ({ name, submitted, claimed, refusal })) });
  // Each tab must agree with the cart that is actually stored.
  const stored = await serverCart(await storedCartId(a));
  const handles = (stored?.lines || []).filter(line => !line.parentId).map(line => line.handle.toUpperCase()).sort();
  for (const tab of [a, b]) {
    await tab.reload(); await tab.openCart();
    const rows = await tab.eval(`[...document.querySelectorAll('.cart-item h3')].map(h => h.textContent).sort()`);
    check('risk:3', `tab ${tab.name} shows the stored cart after reload`, same(rows, handles), { rows, handles });
  }
  check('risk:3', 'after the race the shopper can reach checkout or a visible recovery', await a.enabled('[data-checkout]') || await a.enabled('[data-recover-cart], [data-refresh-cart]'), await a.text('.cart-feedback'));
});

define(applicationContract === 'baseline' ? 'baseline first-add recovery after an uncommitted ambiguous update'
  : 'first-add recovery after an uncommitted ambiguous update', async () => {
  const tab = await openTab('A');
  await addTrainer(tab, 'black');
  await tab.closeCart();
  await addTrainer(tab, 'blue');
  const sourceId = await storedCartId(tab);
  const before = (await control('carts')).carts;
  const source = before.find(cart => cart.id === sourceId);
  const start = (await requestLog()).length;
  const navigateFrom = handoffs.length;
  await control('failNext', { operation: 'UpdateLines', status: 503, phase: 'before' });
  await tab.tap('[data-qty-line][data-delta="1"][aria-label*="BR16"]');
  await tab.settled();
  const blocked = await cartProbe(tab);
  const attempts = (await requestLog()).slice(start).filter(entry => entry.mutation);
  const journalMatches = applicationContract === 'baseline'
    ? same(blocked.journal.map(record => record.kind).sort(), ['quantity update', 'setLineQuantity'])
    : blocked.journal.length === 1;
  check('risk:3', 'uncommitted first-add recovery fault leaves the original cart journaled and checkout frozen',
    attempts.length === 1 && attempts[0].operation === 'UpdateLines' && attempts[0].cartId === sourceId &&
    attempts[0].outcome === 'failed-before-commit' && !attempts[0].commitSeq &&
    same(await serverCart(sourceId), source) && journalMatches &&
    blocked.journal.every(record => record.cartId === sourceId && record.status === 'unresolved') &&
    !blocked.checkout && !documentHandoffs(navigateFrom).length, { attempts, blocked, source });
  if (!await requireControl(tab, '[data-recover-cart]', 'risk:3', 'first-add recovery offers explicit consent')) return;
  await tab.tap('[data-recover-cart]');
  await tab.settled(15000);
  if (applicationContract === 'baseline') { await tab.reload(); await tab.openCart(); }
  const recoveredId = await storedCartId(tab);
  const { carts } = await control('carts');
  const recovered = carts.find(cart => cart.id === recoveredId);
  const intents = [['BR16', 'br16'], ['OB16', 'ob16']].map(([name, handle]) => ({ name, refusal: { refused: false },
    expected: { merchandiseId: 'gid://variant/' + handle, quantity: 1, attributes: [{ key: '_anawin_service', value: 'none' }] } }));
  const recovery = { sourceId, cartId: recoveredId, created: carts.filter(cart => !before.some(old => old.id === cart.id)).map(cart => cart.id),
    before: configuration(source.lines), after: configuration(recovered?.lines || []) };
  const proofs = firstAddGate({ intents, activeCartId: recoveredId, carts, recovery });
  emit(proofs);
  const requests = (await requestLog()).slice(start);
  check('harness', 'first-add recovery browser run executes both historical recovery predicates',
    proofs.filter(proof => /^recovery (moved|neither)/.test(proof.name)).length === 2);
  check('risk:3', 'consented first-add recovery never replays the ambiguous update and verifies the new cart',
    requests.filter(entry => entry.mutation).map(entry => entry.operation).join(',') === 'UpdateLines,CreateCart' &&
    same(await serverCart(sourceId), source) && requests.some(entry => entry.operation === 'Cart' && entry.returnedCartId === recoveredId) &&
    await tab.enabled('[data-checkout]'), { recovery, requests });
});

// Two +1 taps on a serviced BR16 must give quantity 3 with the service at 3, or each lost increment
// must be refused by name (see plusOneGate). A generic "your cart changed" warning does not make
// quantity 2 acceptable. The storefront turns a tap into an absolute quantity from the tab's displayed
// cart (src/main.js, `line.quantity + delta`), so serializing the lock alone still loses an update;
// the self-test therefore also queues and rebases the tap (QUEUE_AND_REBASE_STEPPER).
defineRace('overlapping +1 from two tabs', async () => {
  const a = await openTab('A');
  await addTrainer(a, 'black', { breakIn: { level: 'Firm (40%)', wearingStyle: 'Traditional' } });
  const b = await openTab('B');
  await b.visit('/product/br16'); await b.openCart();
  await a.reload(); await a.openCart();
  const [initial, ...others] = gloves(await cartLines());
  check('harness', 'both tabs start from one BR16 with its service, at quantity 1', !others.length && initial?.quantity === 1 && initial.services.length === 1 && initial.services[0].quantity === 1, initial);
  const before = { A: await a.alerts(), B: await b.alerts() };
  const mark = Date.now();
  const { notOffered: secondTapNotOffered } = await race({ operation: 'UpdateLines', secondTab: b, first: () => a.tap('[data-qty-line][data-delta="1"]'), second: () => b.tap('[data-qty-line][data-delta="1"]', 1, { allowDisabled: true }) });
  await a.settled(20000); await b.settled(20000);
  const finalLines = await cartLines();
  // Every line mutation from either tab is correlated, not only UpdateLines, so a removal or nested add is audited too.
  const allMutations = await mutations();
  const writes = {};
  for (const operation of ['UpdateLines', 'RemoveLines', 'AddLines']) for (const [tab, items] of Object.entries(correlateWrites(operation, mark, allMutations))) (writes[tab] ||= []).push(...items);
  // Every mutation the mock logged since the race began, independently of what the browser correlation saw.
  const committedLog = allMutations.filter(entry => entry.startedAt >= mark);
  const actions = [];
  for (const tab of [a, b]) actions.push({ tab: tab.name, writes: writes[tab.name] || [],
    refusal: notOfferedOr(tab === b && secondTapNotOffered, await refusalOf(tab, 'BR16', 'increase', before[tab.name], '[data-qty-line][data-delta="1"], [data-refresh-cart]')) });
  // Both +1 presses must be proven: A's reached its enabled stepper; B's did too, or found it disabled.
  check('harness', 'each +1 press was delivered to the enabled stepper (or recorded as not offered)', a.lastTap?.selector === '[data-qty-line][data-delta="1"]' && a.lastTap.delivered === true &&
    b.lastTap?.selector === '[data-qty-line][data-delta="1"]' && (b.lastTap.delivered === true || b.lastTap.disabled === true), { A: a.lastTap, B: b.lastTap });
  emit(plusOneGate({ name: 'BR16', initial, cartId: await storedCartId(a), finalLines, actions, committedLog }));
  observe('each +1 action, its submitted writes and outcome', actions);
  const quantity = gloves(finalLines)[0]?.quantity;
  for (const [index, tab] of [a, b].entries()) {
    const shown = Number(await tab.text('.quantity span'));
    check('baseline', `tab ${tab.name} shows the server quantity or warns`, shown === quantity || actions[index].refusal.alerts.length > 0, { shown, server: quantity });
  }
}, {}, SERIALIZE_CART_LOCK + '\n' + QUEUE_AND_REBASE_STEPPER, 'serialized and rebased storefront');

defineRace('overlapping quantity and discount mutations across tabs', async () => {
  const a = await openTab('A');
  await addTrainer(a, 'black');
  await a.tap('[data-qty-line][data-delta="1"]');
  await a.settled();
  const b = await openTab('B');
  await b.visit('/product/br16'); await b.openCart();
  await a.reload(); await a.openCart();
  await typeDiscount(b, 'SYNTH10');
  // Different fields of the same cart: both must persist.
  await race({ operation: 'UpdateLines', secondTab: b, secondOperations: ['UpdateDiscountCodes'],
    first: () => a.tap('[data-qty-line][data-delta="-1"]'), second: () => b.tap('[data-discount-apply]', 1, { allowDisabled: true }) });
  await a.settled(15000); await b.settled(15000);
  const cart = await serverCart(await storedCartId(a));
  check('baseline', 'overlapping quantity and discount updates both persist', cart.lines[0]?.quantity === 1 && same(cart.discountCodes, ['SYNTH10']), { quantity: cart.lines[0]?.quantity, codes: cart.discountCodes });
});

define('timeouts and connection failures', async () => {
  const tab = await openTab('A');
  await addTrainer(tab, 'black');
  // Shopify fails before committing.
  await control('failNext', { operation: 'UpdateLines', phase: 'before' });
  await tab.tap('[data-qty-line][data-delta="1"]');
  await tab.settled(15000);
  check('baseline', 'failure before commit shows an error', (await tab.alerts()).length > 0, await tab.text('.cart-feedback'));
  check('baseline', 'failure before commit leaves Shopify quantity at 1 (no duplicate)', (await cartLines())[0].quantity === 1);
  check('baseline', 'failure before commit blocks checkout until the cart is checked', !await tab.enabled('[data-checkout]'));
  await requireControl(tab, '[data-refresh-cart]', 'baseline', 'failure before commit offers Check cart');
  // Timeout after Shopify committed: the outcome is ambiguous to the browser.
  await closeContext(); await control('reset', { scenario }); await newContext();
  const t2 = await openTab('A2');
  await addTrainer(t2, 'black');
  const count = (await mutations('UpdateLines')).length;
  const { id } = await control('hold', { operation: 'UpdateLines', phase: 'after' });
  await t2.tap('[data-qty-line][data-delta="1"]');
  check('harness', 'committed update has its response held', (await control('awaitHeld', { id })).arrived);
  check('baseline', 'controls are disabled and the cart is busy during the update', await t2.eval(`!!document.querySelector('.cart-body[aria-busy="true"]') && [...document.querySelectorAll('[data-qty-line]')].every(b => b.disabled)`));
  await t2.settled(15000);
  check('baseline', 'ambiguous timeout shows an error', (await t2.alerts()).length > 0, await t2.text('.cart-feedback'));
  check('baseline', 'ambiguous timeout is not retried automatically (no duplicate write)', (await mutations('UpdateLines')).length - count === 1 && (await cartLines(t2))[0].quantity === 2);
  check('baseline', 'ambiguous timeout blocks checkout', !await t2.enabled('[data-checkout]'));
  await control('release', { id });
  if (await requireControl(t2, '[data-refresh-cart]', 'baseline', 'ambiguous timeout offers Check cart')) { await t2.tap('[data-refresh-cart]'); await t2.settled(); }
  check('baseline', 'checking the cart shows the committed quantity but keeps checkout blocked', (await t2.text('.quantity span')) === '2' && !await t2.enabled('[data-checkout]'), await t2.text('.cart-feedback'));
  await requireControl(t2, '[data-recover-cart]', 'baseline', 'recovery into a new cart is offered');
  // Timeout before Shopify commits: the request is held and never applied.
  await closeContext(); await control('reset', { scenario }); await newContext();
  const t3 = await openTab('A3');
  await addTrainer(t3, 'black');
  const never = await control('hold', { operation: 'UpdateLines', phase: 'before' });
  await t3.tap('[data-qty-line][data-delta="1"]');
  check('harness', 'uncommitted update is held', (await control('awaitHeld', { id: never.id })).arrived);
  await t3.settled(15000);
  check('baseline', 'timeout before commit shows an error and keeps quantity 1', (await t3.alerts()).length > 0 && (await cartLines(t3))[0].quantity === 1);
  check('baseline', 'timeout before commit blocks checkout', !await t3.enabled('[data-checkout]'));
  check('harness', 'held uncommitted update is released without committing', (await control('release', { id: never.id, commit: false })).released);
}, { deadlineMs: 150000 });

const expiredObservationPasses = ({ expiredId, absent, before, observations, reads, writes, navigation }) =>
  absent && !!expiredId && observations.length === 2 && reads.length >= 2 &&
  reads.every(read => read.cartId === expiredId && read.status === 200 && read.returnedCartId === null) &&
  observations.every(observed => observed.count === '(0)' && !observed.rows.length && !observed.checkout &&
    [undefined, expiredId].includes(observed.storage['anawin-shopify-cart-id']) &&
    same(observed.journal, before.journal)) && !writes.length && navigation === 0;

if (applicationContract === 'combined') define('expired cart observation predicate controls', async () => {
  const before = { journal: [['example-owner', 'exact bytes']] };
  const state = { count: '(0)', rows: [], checkout: false, storage: { 'anawin-shopify-cart-id': 'expired' }, journal: before.journal };
  const read = { cartId: 'expired', status: 200, returnedCartId: null };
  const good = { expiredId: 'expired', absent: true, before, observations: [state, state], reads: [read, read], writes: [], navigation: 0 };
  check('harness', 'accepts two authoritative absent reads and a preserved expired pointer', expiredObservationPasses(good));
  for (const [label, delta] of Object.entries({
    'checkout offered': { observations: [state, { ...state, checkout: true }] },
    'visible service or merchandise': { observations: [{ ...state, rows: ['unexpected'] }, state] },
    'unrelated pointer': { observations: [{ ...state, storage: { 'anawin-shopify-cart-id': 'other' } }, state] },
    'journal bytes changed': { observations: [{ ...state, journal: [] }, state] },
    'non-absent response': { reads: [read, { ...read, returnedCartId: 'expired' }] },
    'observational mutation': { writes: [{ operation: 'AddLines' }] }, 'checkout navigation': { navigation: 1 }
  })) check('harness', `rejects expired observation with ${label}`, !expiredObservationPasses({ ...good, ...delta }));
});

define('storage denial and expired cart', async () => {
  // Safety records cannot be written: no mutation may be sent.
  const denied = await openTab('A', { init: `const set = Storage.prototype.setItem; Storage.prototype.setItem = function (key, value) {
    if (String(key).startsWith('anawin-shopify-unsafe-op:')) throw new DOMException('Denied', 'QuotaExceededError'); return set.call(this, key, value); };` });
  await denied.visit('/product/br16');
  await denied.tap('[data-add="black"]');
  await denied.settled();
  check('baseline', 'with safety storage denied no cart is created', !(await mutations()).length);
  check('baseline', 'with safety storage denied an error is shown', (await denied.alerts()).length > 0, await denied.text('.cart-feedback'));
  check('baseline', 'with safety storage denied no glove is claimed', (await denied.text('.cart-count')) === '(0)');
  // Expired cart: Shopify no longer knows the stored cart ID.
  await closeContext(); await control('reset', { scenario }); await newContext();
  const tab = await openTab('B');
  await addTrainer(tab, 'black');
  await tab.closeCart();
  const expiredId = await storedCartId(tab);
  if (applicationContract === 'combined') {
    // A terminal, unrelated record lets this read prove byte preservation without gating the next add.
    await tab.eval(`localStorage.setItem('anawin-shopify-unsafe-op:expired-probe', '{"v":2, "owner":"expired-probe","kind":"addition","status":"terminal","cartId":"gid://shopify/Cart/9999?key=k9999"}')`);
  }
  const bytes = async () => Object.entries(await cartStorage(tab)).filter(([key]) => key.startsWith('anawin-shopify-unsafe-op:'));
  const beforeExpiry = { journal: await bytes() };
  const expireLog = (await requestLog()).length;
  const navigationStart = handoffs.length;
  check('harness', 'mock expired the stored cart', (await control('expire', { id: expiredId })).expired);
  await tab.reload();
  if (applicationContract === 'baseline') {
    check('baseline', 'expired cart is cleared, not shown as current', (await tab.text('.cart-count')) === '(0)' && !(await storedCartId(tab)));
  } else {
    const observations = [];
    for (let i = 0; i < 2; i++) {
      if (i) await tab.reload();
      await tab.openCart();
      observations.push({ ...await cartProbe(tab), journal: await bytes() });
    }
    const log = (await requestLog()).slice(expireLog);
    const evidence = { expiredId, before: beforeExpiry, observations, absent: (await serverCart(expiredId)) == null,
      reads: log.filter(entry => entry.operation === 'Cart'), writes: log.filter(entry => entry.mutation),
      navigation: documentHandoffs(navigationStart).length };
    check('baseline', 'authoritative expired-cart observation stays empty and preserves safety records on reload',
      expiredObservationPasses(evidence), evidence);
    await tab.closeCart();
  }
  const addStart = (await requestLog()).length;
  await addTrainer(tab, 'blue');
  const cart = await serverCart(await storedCartId(tab));
  if (applicationContract === 'combined') {
    const requests = (await requestLog()).slice(addStart);
    const writes = requests.filter(entry => entry.mutation);
    check('baseline', 'fresh add verifies only requested merchandise and leaves the expired cart untouched', cart?.id !== expiredId &&
      (await serverCart(expiredId)) == null && writes.length === 1 && writes.every(entry => entry.cartId !== expiredId) &&
      requests.some(entry => entry.operation === 'Cart' && entry.returnedCartId === cart?.id) &&
      cart?.lines.length === 1 && !cart.lines[0].parentId && cart.lines[0].quantity === 1 && cart.lines[0].handle === 'ob16' &&
      await tab.enabled('[data-checkout]'), { cart, requests });
  }
  check('baseline', 'next add creates a fresh verified cart', cart?.id !== expiredId && cart?.lines.length === 1 && cart.lines[0].handle === 'ob16' && await tab.enabled('[data-checkout]'));
});

define('keyboard drawer navigation, announcements, semantics and busy controls', async () => {
  const tab = await openTab('A', { reducedMotion: false });
  await addTrainer(tab, 'black');
  await tab.closeCart();
  // The add button, or its sticky twin when the add button has scrolled off screen.
  check('baseline', 'closing returns focus to the add control that opened the cart', await tab.eval(`document.activeElement.matches('[data-add="black"], [data-sticky-add]')`),
    await tab.eval(`document.activeElement.outerHTML.slice(0, 80)`));
  await tab.eval(`${VISIBLE_CART_BUTTON}.focus()`);
  check('harness', 'cart button took keyboard focus', await tab.eval(`document.activeElement.matches('[data-cart]')`));
  await tab.key('Enter');
  await tab.settled();
  check('baseline', 'keyboard open focuses Close', await tab.eval(`document.activeElement.matches('.cart-head [data-close-cart]')`));
  check('baseline', 'drawer is a labelled modal dialog and the page behind is inert', await tab.eval(`(() => { const d = document.querySelector('.cart-drawer'); return d.getAttribute('role') === 'dialog' && d.getAttribute('aria-modal') === 'true' &&
    document.getElementById(d.getAttribute('aria-labelledby'))?.textContent === 'Your cart' && document.querySelector('#app').inert; })()`));
  await tab.key('Tab', 8);
  check('baseline', 'Shift+Tab from Close wraps to the last drawer control', await tab.eval(`(() => { const all = [...document.querySelector('.cart-drawer').querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter(e => e.getClientRects().length); return document.activeElement === all.at(-1); })()`));
  // Keyboard quantity change keeps focus on the same control after the re-render.
  await tab.eval(`document.querySelector('[data-qty-line][data-delta="1"]').focus()`);
  await tab.key('Enter');
  await tab.settled();
  check('baseline', 'focus returns to + after the cart re-renders', await tab.eval(`document.activeElement.matches('[data-qty-line][data-delta="1"]')`),
    await tab.eval(`document.activeElement.outerHTML.slice(0, 80)`));
  check('baseline', 'quantity change is announced', await tab.until(`(document.querySelector('[data-cart-announcer]')?.textContent || '').includes('quantity 2')`).then(() => true, () => false));
  check('baseline', 'quantity buttons carry descriptive labels', await tab.eval(`[...document.querySelectorAll('[data-qty-line]')].every(b => /^(Increase|Decrease) BR16 /.test(b.getAttribute('aria-label')))`));
  check('baseline', 'discount toggle exposes aria-expanded and aria-controls', await tab.eval(`(() => { const t = document.querySelector('[data-discount-toggle]'); return t.getAttribute('aria-controls') === 'cart-discount-panel' && ['true','false'].includes(t.getAttribute('aria-expanded')); })()`));
  // Busy state: every mutating control is disabled and the checkout status is polite.
  await busyApplyFlow(tab);
  check('baseline', 'checkout status region is polite', await tab.eval(`document.querySelector('.checkout-status')?.getAttribute('aria-live') === 'polite'`));
  // Escape with the service editor focused closes only the editor.
  await tab.tap('[data-add-service]');
  await tab.until(`document.activeElement?.closest('[data-service-form]') || document.activeElement?.id === 'cart-service-editor-heading'`);
  await tab.eval(`document.querySelector('[data-service-form] input').focus()`);
  await tab.key('Escape');
  check('baseline', 'Escape in the service editor closes the editor, not the cart', await tab.eval(`!document.querySelector('[data-service-form]') && document.body.classList.contains('cart-open') && document.activeElement.matches('[data-add-service]')`));
  await tab.key('Escape');
  await tab.until(`!document.body.classList.contains('cart-open')`);
  check('baseline', 'Escape closes the cart and focus returns to the cart button', await tab.until(`document.activeElement === ${VISIBLE_CART_BUTTON}`).then(() => true, () => false));
  // Reduced motion.
  await tab.openCart();
  const motion = await tab.eval(`getComputedStyle(document.querySelector('.cart-drawer')).transitionDuration`);
  await tab.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const reduced = await tab.eval(`getComputedStyle(document.querySelector('.cart-drawer')).transitionDuration`);
  check('baseline', 'drawer animates normally and not at all with reduced motion', motion === '0.3s' && reduced === '0s', { motion, reduced });
  // An error is announced as an alert.
  await control('failNext', { operation: 'UpdateLines', phase: 'before' });
  await tab.tap('[data-qty-line][data-delta="1"]');
  await tab.settled(15000);
  check('baseline', 'cart error is an alert', await tab.eval(`document.querySelector('.cart-feedback .cart-error')?.getAttribute('role') === 'alert'`));
  check('baseline', 'after an error focus is in the drawer on a usable control', await tab.eval(`!!document.activeElement.closest('.cart-drawer') && !document.activeElement.disabled`),
    await tab.eval(`document.activeElement.outerHTML.slice(0, 80)`));
});

// Positive controls for the busy-Apply gate: both correct behaviours must pass it.
define('busy Apply [harness self-test: (A) disabled while busy]', () => busyApplyScenario(), { init: DISABLE_APPLY_WHILE_BUSY, selfTest: true });
define('busy Apply [harness self-test: (B) queued and replayed]', () => busyApplyScenario(), { init: QUEUE_APPLY_WHILE_BUSY, selfTest: true });
// 1L: the same queued Apply against the real storefront formatting for three settled outcomes.
define('busy Apply [harness self-test: (B) queued, code committed but not applicable]', () => busyApplyScenario(), { init: QUEUE_APPLY_WHILE_BUSY, selfTest: true, mock: { acceptedCodes: ['SYNTH5'] } });
define('busy Apply [harness self-test: (B) queued, mixed-case input, Shopify spelling]', () => busyApplyScenario({ typed: ' sYnTh10 ' }), { init: QUEUE_APPLY_WHILE_BUSY, selfTest: true, mock: { codeCase: 'upper' } });
define('busy Apply [harness self-test: (B) queued, HTTP 200 with GraphQL errors]', () => busyApplyScenario({ failDiscount: { status: 200, phase: 'before' } }), { init: QUEUE_APPLY_WHILE_BUSY, selfTest: true });
// 1M: Shopify answers HTTP 200 with another cart, or with no cart. src/commerce.js updateDiscountCodes throws
// ("Shopify returned a different cart." / "Shopify did not return a cart.") and the shopper sees the catch
// copy. Nothing was committed, so that is the truthful outcome; success may never be credited.
define('busy Apply [harness self-test: (B) queued, response for an unrelated cart]', () => busyApplyScenario({ forgeDiscount: 'unrelated' }), { init: QUEUE_APPLY_WHILE_BUSY, selfTest: true });
define('busy Apply [harness self-test: (B) queued, response with no cart]', () => busyApplyScenario({ forgeDiscount: 'absent' }), { init: QUEUE_APPLY_WHILE_BUSY, selfTest: true });
// 1N: the same responses after Shopify really committed " sAvE20" (applicable:true). The storefront still
// rejects them and shows the catch copy; that is truthful even though the code is now on the cart. A success
// claim after them (the CLAIM_SUCCESS_AFTER_CATCH shim) must be rejected.
const SAVE20 = { mock: { acceptedCodes: ['SAVE20'] } };
const committedForgery = forgeDiscount => ({ typed: 'sAvE20', forgeDiscount, forgeMode: 'commit-then-substitute' });
define('busy Apply [harness self-test: (B) queued, sAvE20 committed, matching response]', () => busyApplyScenario({ typed: 'sAvE20' }), { init: QUEUE_APPLY_WHILE_BUSY, selfTest: true, ...SAVE20 });
for (const forged of ['unrelated', 'blank', 'omitted']) {
  define(`busy Apply [harness self-test: (B) queued, sAvE20 committed, ${forged} response ID]`, () => busyApplyScenario(committedForgery(forged)), { init: QUEUE_APPLY_WHILE_BUSY, selfTest: true, ...SAVE20 });
  define(`busy Apply [harness self-test: (B) queued, sAvE20 committed, ${forged} response ID, false success claim]`, () => busyApplyScenario({ ...committedForgery(forged), expectGate: 'reject' }),
    { init: QUEUE_APPLY_WHILE_BUSY + CLAIM_SUCCESS_AFTER_CATCH, selfTest: true, ...SAVE20 });
}
define('busy Apply [harness self-test: (B) queued, sAvE20 not committed, unrelated response ID]', () => busyApplyScenario({ typed: 'sAvE20', forgeDiscount: 'unrelated' }), { init: QUEUE_APPLY_WHILE_BUSY, selfTest: true, ...SAVE20 });
define('busy Apply [harness self-test: (B) queued, sAvE20 not committed, unrelated response ID, false success claim]', () => busyApplyScenario({ typed: 'sAvE20', forgeDiscount: 'unrelated', expectGate: 'reject' }),
  { init: QUEUE_APPLY_WHILE_BUSY + CLAIM_SUCCESS_AFTER_CATCH, selfTest: true, ...SAVE20 });
define('busy Apply [harness self-test: (B) queued, sAvE20 not committed, ordinary HTTP 503]', () => busyApplyScenario({ typed: 'sAvE20', failDiscount: { status: 503, phase: 'before' } }), { init: QUEUE_APPLY_WHILE_BUSY, selfTest: true, ...SAVE20 });

// ---- Run ----
// The sandbox cannot read the shared Git directory, so run-isolated.mjs records the source state.
const revision = process.env.ANAWIN_SOURCE_REVISION || null;
const dirty = (() => { try { return JSON.parse(process.env.ANAWIN_SOURCE_STATUS || 'null'); } catch { return null; } })();
const os = { kernel: osRelease(), release: (() => { try { return /^PRETTY_NAME="?([^"\n]*)/m.exec(readFileSync('/etc/os-release', 'utf8'))?.[1] || null; } catch { return null; } })() };
const scenarioResults = [];
let fatal = null;
try {
  const selected = scenarios.filter(item => item.name.includes(only));
  if (!selected.length) throw new Error(`ANAWIN_PURCHASE_ONLY=${JSON.stringify(only)} matches no scenario`);
  await startServer();
  const wsUrl = await startChrome();
  socket = new WebSocket(wsUrl);
  await withDeadline(new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error('CDP connection failed')); }), 10000, 'CDP connect');
  socket.onclose = () => { for (const [id, waiter] of pending) { pending.delete(id); waiter.reject(new Error(`${waiter.method}: CDP socket closed`)); } };
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const waiter = pending.get(message.id); pending.delete(message.id);
      if (message.error) waiter?.reject(new Error(`${waiter.method}: ${JSON.stringify(message.error)}`)); else waiter?.resolve(message.result);
      return;
    }
    const tab = sessions.get(message.sessionId);
    if (!tab) return;
    if (message.method === 'Fetch.requestPaused') onPaused(tab, message.params).catch(error => { if (!tab.closed) interceptErrors.push({ scenario, tab: tab.name, url: message.params.request.url.slice(0, 120), error: error.message }); });
    if (message.method === 'Runtime.exceptionThrown') exceptions.push({ scenario, tab: tab.name, text: message.params.exceptionDetails.exception?.description?.slice(0, 300) || message.params.exceptionDetails.text });
  };
  console.log(`Chrome ${browserVersion}; revision ${revision}${dirty?.length ? ' (+ uncommitted files)' : ''}; isolated netns ${isolation.netns}; mock ${BASE}`);
  for (const item of selected) {
    scenario = item.name;
    viewport = null;
    selfTest = item.selfTest;
    scenarioInit = item.init;
    const began = Date.now();
    const checksBefore = checks.length;
    console.log(`SCENARIO ${scenario}`);
    try {
      await closeContext();
      await control('reset', { scenario, ...item.mock });
      await newContext();
      generation++;
      const running = scenarioScope.run({ generation, scenario }, () => item.run());
      running.catch(() => {});
      try { await withDeadline(running, item.deadlineMs, `scenario "${scenario}"`); }
      finally { generation++; }
    } catch (error) {
      // State at the point of failure, for diagnosis: each tab's cart and the mock's request log.
      const state = [];
      for (const tab of tabs) {
        state.push({ tab: tab.name, ...await tab.eval(`({ path: location.pathname, open: document.body.classList.contains('cart-open'),
          busy: !!document.querySelector('.cart-body[aria-busy]'), feedback: document.querySelector('.cart-feedback')?.textContent || '',
          count: document.querySelector('.cart-count')?.textContent })`).catch(e => ({ error: e.message })) });
        await tab.shot(`failure-${scenarioResults.length + 1}-${tab.name}`).catch(() => {});
      }
      const requests = await requestLog().then(log => log.map(entry => `${entry.operation}:${entry.outcome}`), e => [`log unavailable: ${e.message}`]);
      check('harness', 'scenario completed', false, { error: String(error.message || error).slice(0, 600), state, requests });
    }
    try {
      const { log, unmatched, violations: serverViolations } = await control('log');
      check('harness', 'every Storefront request matched the mock', !unmatched.filter(item => !isExpectedFault(item)).length, unmatched);
      check('harness', 'the mock accepted only expected hosts, methods and routes', !serverViolations.length, serverViolations);
      check('harness', 'every request belongs to this scenario', log.every(entry => entry.scenario === scenario), log.filter(entry => entry.scenario !== scenario));
      check('harness', 'no held request was left unreleased', !log.some(entry => /held/.test(entry.outcome) && !entry.finishedAt), log.filter(entry => /held/.test(entry.outcome)));
    } catch (error) { check('harness', 'mock log was readable', false, error.message); }
    check('harness', 'browser requests stayed on mock routes', !violations.some(item => item.scenario === scenario), violations.filter(item => item.scenario === scenario));
    check('harness', 'request interception reported no errors', !interceptErrors.some(item => item.scenario === scenario), interceptErrors.filter(item => item.scenario === scenario));
    check('baseline', 'no request was aimed outside the loopback mock (checkout handoffs answered locally)', !external.some(item => item.scenario === scenario), external.filter(item => item.scenario === scenario));
    check('baseline', 'no uncaught page exceptions', !exceptions.some(item => item.scenario === scenario), exceptions.filter(item => item.scenario === scenario));
    const own = checks.slice(checksBefore);
    scenarioResults.push({ name: scenario, durationMs: Date.now() - began, checks: own.length, failed: own.filter(c => c.outcome === 'fail').length,
      outcome: own.some(c => c.outcome === 'fail' && c.label === 'harness') ? 'harness-fault' : own.some(c => c.outcome === 'fail') ? 'app-regression' : 'passed' });
  }
  scenario = 'global';
  await closeContext();
  serverFaults = (await control('faults')).faults;
  const unexpected = serverFaults.filter(item => !isExpectedFault(item));
  check('harness', 'no interception error, route violation or unmatched request was recorded anywhere in the run', !interceptErrors.length && !violations.length && !unexpected.length,
    { interceptErrors, violations, serverFaults: unexpected });
  if (expectedFaults.size) check('harness', 'every deliberately injected fault appears in the final record', [...expectedFaults].every(marker => serverFaults.some(item => JSON.stringify(item).includes(marker))), [...expectedFaults]);
} catch (error) { fatal = String(error.stack || error); console.error(fatal); }
finally {
  // Teardown runs whatever failed above, including evidence writing.
  try { socket?.close(); } catch {}
  await stopChildren().catch(error => infrastructure.push({ fault: `teardown: ${error.message}` }));
  if (profile) await rm(profile, { recursive: true, force: true }).catch(() => {});
  const failed = checks.filter(item => item.outcome === 'fail');
  const appFailures = failed.filter(item => item.label !== 'harness');
  const harnessFailures = failed.filter(item => item.label === 'harness');
  // A deliberately injected self-test fault is reported, but only an unexpected fault is a failure.
  const unexpectedInfrastructure = infrastructure.filter(item => !isExpectedFault(item));
  const infraFault = Boolean(fatal) || harnessFailures.length > 0 || unexpectedInfrastructure.length > 0;
  const summary = {
    schema: 4, runId: RUN_ID, status: infraFault ? 'infrastructure-fault' : appFailures.length ? 'app-regressions' : 'passed',
    startedAt, finishedAt: new Date().toISOString(), revision, uncommitted: dirty, node: process.version, chrome: browserVersion, os,
    isolation, applicationContract, viewports: VIEWPORTS.map(([w, h]) => `${w}x${h}`), filter: only || null,
    totals: { checks: checks.length, passed: checks.length - failed.length, failed: failed.length,
      baselineFailed: failed.filter(item => item.label === 'baseline').length, riskFailed: failed.filter(item => item.label.startsWith('risk:')).length,
      findingFailed: failed.filter(item => item.label === 'finding').length, harnessFailed: harnessFailures.length, infrastructureFaults: unexpectedInfrastructure.length + (fatal ? 1 : 0),
      expectedSelfTestFaults: infrastructure.length - unexpectedInfrastructure.length },
    appRegressions: appFailures.map(({ label, scenario, viewport, name }) => ({ label, scenario, viewport, name })),
    infrastructure: [...unexpectedInfrastructure, ...harnessFailures.map(({ scenario, viewport, name, detail }) => ({ scenario, viewport, name, detail })), ...(fatal ? [{ fatal }] : [])],
    expectedSelfTestFaults: infrastructure.filter(isExpectedFault), serverFaults,
    scenarios: scenarioResults,
    handoffs: sanitize(handoffs.map(({ scenario, tab, url, resourceType }) => ({ scenario, tab, url, resourceType }))), external, violations, interceptErrors, exceptions, diagnostics, checks
  };
  try { await writeFile(join(dir, 'results.json'), JSON.stringify(summary, null, 2)); }
  catch (error) { console.error(`Could not write evidence: ${error.message}`); summary.status = 'infrastructure-fault'; }
  const t = summary.totals;
  console.log(`\n${summary.status.toUpperCase()}: ${t.passed}/${t.checks} checks passed; ${t.baselineFailed} baseline, ${t.riskFailed} known-risk, ` +
    `${t.findingFailed} new-finding, ${t.harnessFailed} harness failures, ${t.infrastructureFaults} infrastructure faults. Evidence: ${dir}`);
  process.exitCode = summary.status === 'passed' ? 0 : summary.status === 'app-regressions' ? 1 : 2;
}
