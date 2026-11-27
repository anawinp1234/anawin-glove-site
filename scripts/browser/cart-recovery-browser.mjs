// Cart recovery regression in a real browser: two same-origin tabs of one profile share localStorage and
// Web Locks. Covers Start a new cart, Check unconfirmed cart (adopt and mismatch), Check the new cart,
// Try recovery again, stale Keep/Start a new cart consent, and a serviced then glove-only recovery: labels, keyboard activation, focus, live announcements, busy states, exact cart and
// service contents, and checkout refusal while unresolved. Uses the loopback-only recovery fixture server
// (started here if it is not already running); every non-loopback request is blocked.
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const port = Number(process.env.ANAWIN_RECOVERY_PORT || 5201);
const origin = `http://127.0.0.1:${port}`;
const debugPort = 9419;
const dir = process.env.ANAWIN_RECOVERY_EVIDENCE_DIR || join(tmpdir(), 'anawin-cart-recovery-evidence');
await mkdir(dir, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const up = () => fetch(`${origin}/`).then(response => response.ok, () => false);
const server = await up() ? null : spawn(process.execPath, [new URL('./cart-recovery-server.mjs', import.meta.url).pathname], { stdio: 'ignore' });
const chrome = spawn(process.env.ANAWIN_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new',
  `--remote-debugging-port=${debugPort}`, `--user-data-dir=${dir}/chrome`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
const control = async (action, ...args) => {
  const response = await fetch(`${origin}/__fixture-control`, { method: 'POST', body: JSON.stringify({ action, args }) });
  const value = await response.json();
  if (!response.ok) throw new Error(`control ${action}: ${value.error}`);
  return value;
};
const errors = [], blocked = [], results = [];
// Checkout navigations to the approved Shopify host, captured and failed locally: no request ever leaves loopback.
const checkoutNavigations = [];
const sockets = [];

// One CDP page session: `run(fn, ...args)` evaluates a function in the page.
async function session(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  sockets.push(socket);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let seq = 0;
  const pending = new Map();
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) { const entry = pending.get(message.id); pending.delete(message.id); message.error ? entry?.reject(new Error(JSON.stringify(message.error))) : entry?.resolve(message.result); }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
    if (message.method === 'Fetch.requestPaused') {
      const { requestId, request } = message.params;
      if (request.url.startsWith('https://ignvv0-zh.myshopify.com/')) {
        checkoutNavigations.push(request.url.replace(/key=[^&]*/, 'key=[redacted]'));
        // Aborting keeps the current document, like a cancelled leave; the handoff watcher then shows the frozen cart.
        void call('Fetch.failRequest', { requestId, errorReason: 'Aborted' });
      } else if (!request.url.startsWith('http://127.0.0.1:')) { blocked.push(request.url); void call('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }); }
      else void call('Fetch.continueRequest', { requestId });
    }
  };
  await call('Page.enable'); await call('Runtime.enable');
  await call('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  const run = async (fn, ...args) => {
    const result = await call('Runtime.evaluate', { expression: `(${fn})(...${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const until = async (fn, label, ...args) => {
    for (let i = 0; i < 200; i++) { if (await run(fn, ...args)) return; await sleep(50); }
    throw new Error(`Timeout: ${label}`);
  };
  const page = {
    call, run, until,
    async visit(path) {
      await call('Page.bringToFront');
      await run(() => { window.__leaving = true; });
      await call('Page.navigate', { url: `${origin}${path}` });
      await until(() => !window.__leaving && document.readyState === 'complete' && document.querySelector('main'), `load ${path}`);
      // Records every alert and polite status the shopper's screen reader would hear.
      await run(() => {
        window.__announced = [];
        const record = node => { const text = node.textContent.trim(); if (text) window.__announced.push({ role: node.getAttribute('role'), text }); };
        new MutationObserver(changes => {
          for (const change of changes) {
            const target = change.target.nodeType === 1 ? change.target : change.target.parentElement;
            for (const node of [target, ...change.addedNodes].filter(item => item?.nodeType === 1)) {
              for (const live of [node, ...node.querySelectorAll('[role="alert"],[role="status"]')]) {
                if (live.matches?.('[role="alert"],[role="status"]')) record(live);
              }
            }
          }
        }).observe(document.body, { subtree: true, childList: true, characterData: true });
      });
    },
    // Keyboard activation: focus, then a real Enter key press.
    async press(selector) {
      await call('Page.bringToFront');
      await run(selector => document.querySelector(selector).focus(), selector);
      assert.equal(await run(selector => document.activeElement === document.querySelector(selector), selector), true, `${selector} takes focus`);
      for (const type of ['keyDown', 'keyUp']) await call('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) });
    },
    click: selector => run(selector => document.querySelector(selector).click(), selector),
    async openCart() {
      // Animation frames run only in the foreground tab, as for a shopper switching tabs.
      await call('Page.bringToFront');
      // The trigger is bound once the app has rendered over the prerendered page, so the click is retried.
      await until(() => {
        if (document.body.classList.contains('cart-open') && document.querySelector('.cart-drawer')) return true;
        if (!document.querySelector('.cart-drawer')) document.querySelector('.cart-trigger')?.click();
        return false;
      }, 'cart opens');
    },
    // What the drawer shows: its alert, polite status, feedback buttons, checkout control, glove rows and focus.
    drawer: () => run(() => {
      const drawer = document.querySelector('.cart-drawer');
      if (!drawer) return null;
      return {
        alert: drawer.querySelector('.cart-feedback .cart-error')?.textContent.trim() || '',
        guidance: drawer.querySelector('.cart-feedback .cart-guidance')?.textContent.trim() || '',
        buttons: [...drawer.querySelectorAll('.cart-feedback button')].map(button => ({ text: button.textContent.trim(),
          data: [...button.attributes].map(attribute => attribute.name).find(name => name.startsWith('data-')), disabled: button.disabled })),
        checkoutEnabled: Boolean(drawer.querySelector('button[data-checkout]:not([disabled])')),
        rows: [...drawer.querySelectorAll('.cart-item')].map(row => row.querySelector('h3, .cart-item-name, strong')?.textContent.trim() || row.textContent.trim().slice(0, 40)),
        quantities: [...drawer.querySelectorAll('.cart-item .quantity span')].map(span => span.textContent.trim()),
        empty: Boolean(drawer.querySelector('.empty-cart')),
        focusInDrawer: drawer.contains(document.activeElement),
        busy: drawer.querySelector('.cart-feedback button')?.disabled ?? null
      };
    }),
    announced: () => run(() => window.__announced),
    clearAnnounced: () => run(() => { window.__announced = []; }),
    storage: () => run(() => ({ active: localStorage.getItem('anawin-shopify-cart-id'),
      records: Object.keys(localStorage).filter(key => key.startsWith('anawin-shopify-unsafe-op:')).map(key => JSON.parse(localStorage.getItem(key))) }))
  };
  return page;
}

// The drawer marks its body busy for the whole cart action, including the follow-up read.
const settled = page => page.until(() => document.querySelector('.cart-drawer') && !document.querySelector('.cart-body[aria-busy="true"]') &&
  !document.querySelector('.cart-feedback button:disabled'), 'cart action settles');
// Task 2H: terminal records do not gate anything; a discarded or superseded cart's ID is kept in one.
const live = records => records.filter(record => record.status !== 'terminal');
const hasButton = (state, data, text) => state.buttons.some(button => button.data === data && (!text || button.text === text));
const assertRefusesCheckout = (state, label) => assert.equal(state.checkoutEnabled, false, `${label}: checkout is refused`);
async function addBlack(page) {
  await page.visit('/product/br16');
  await page.until(() => document.querySelector('[data-add="black"]') && !document.querySelector('[data-add="black"]').disabled, 'add enabled');
  await page.click('[data-add="black"]');
  await page.until(() => document.querySelector('.cart-drawer'), 'drawer opens');
  await settled(page);
}

try {
  for (let i = 0; i < 200 && !await up(); i++) await sleep(100);
  assert.ok(await up(), `Recovery fixture server on ${origin}`);
  let targets;
  for (let i = 0; i < 100; i++) { try { targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then(response => response.json()); if (targets.length) break; } catch {} await sleep(100); }
  assert.ok(targets?.length, 'Chrome connection');
  const first = await session(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  const second = await session((await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' }).then(response => response.json())).webSocketDebuggerUrl);
  const reset = async () => {
    await control('reset');
    await first.visit('/');
    await first.run(() => { localStorage.clear(); localStorage.setItem('anawin-newsletter-popup', '{"subscribed":true}'); });
  };

  // 1. Start a new cart: the first create's answer is lost, so no cart ID was received.
  await reset();
  await control('failAfterNextMutation', 1);
  await addBlack(first);
  let state = await first.drawer();
  assert.match(state.alert, /could not confirm whether Shopify saved your new cart/);
  assert.ok(hasButton(state, 'data-start-new-cart', 'Start a new cart'), JSON.stringify(state));
  assertRefusesCheckout(state, 'unconfirmed create');
  assert.ok((await first.announced()).some(item => item.role === 'alert' && /could not confirm/.test(item.text)), 'the failure is announced as an alert');
  // The second tab shares the record: its add is refused and nothing is created.
  await second.visit('/product/br16');
  await second.until(() => document.querySelector('[data-add="black"]') && !document.querySelector('[data-add="black"]').disabled, 'tab 2 add enabled');
  await second.click('[data-add="black"]');
  await second.until(() => document.querySelector('.cart-drawer .cart-error'), 'tab 2 refusal');
  await settled(second);
  const refused = await second.drawer();
  assert.match(refused.alert, /could not confirm whether Shopify saved your new cart/);
  assert.equal((await control('state')).creates, 1, 'the refused add created nothing');
  // Keyboard: Start a new cart in tab 1, then add once.
  await first.press('[data-start-new-cart]');
  await first.until(() => !document.querySelector('[data-start-new-cart]'), 'start new cart completes');
  state = await first.drawer();
  assert.equal(state.empty, true);
  assert.equal(state.focusInDrawer, true, 'focus stays in the drawer');
  await addBlack(first);
  state = await first.drawer();
  assert.deepEqual(state.quantities, ['1']);
  assert.equal(state.checkoutEnabled, true);
  assert.equal((await control('state')).creates, 2);
  results.push({ scenario: 'start-new-cart', twoTabs: true, keyboard: true, alert: true, checkoutRefused: true });
  console.log('PASS Start a new cart: alert, second-tab refusal with no create, keyboard activation, focus kept, one new cart');

  // 2. Check unconfirmed cart: a created cart ID was received but never published (adopt, then mismatch).
  for (const variant of ['matching', 'mismatch']) {
    await reset();
    await addBlack(first);
    // What Shopify really holds; the attempted create is that (matching) or the blue glove (mismatch).
    const [saved] = (await control('state', (await first.storage()).active)).lines;
    const createIntent = [{ merchandiseId: variant === 'matching' ? saved.merchandiseId : 'gid://variant/ob16',
      quantity: 1, attributes: saved.attributes, parentMerchandiseId: null }];
    // A tab stopped after journaling the created cart's ID and before publishing it.
    await first.run(createIntent => {
      const id = localStorage.getItem('anawin-shopify-cart-id');
      localStorage.removeItem('anawin-shopify-cart-id');
      localStorage.setItem('anawin-shopify-unsafe-op:closed-tab', JSON.stringify({ cartId: '*', candidateCartId: id, kind: 'addProduct',
        kinds: ['addition'], status: 'pending', createdAt: 1, dispatched: true, createIntent }));
    }, createIntent);
    await first.visit('/product/br16');
    await first.openCart();
    await second.visit('/product/br16');
    await second.openCart();
    for (const page of [first, second]) {
      state = await page.drawer();
      assert.ok(hasButton(state, 'data-reconcile-cart', 'Check unconfirmed cart'), JSON.stringify(state));
      // Task 2H: Check unconfirmed cart comes first; Start a new cart is only the disclosed fallback for a cart the
      // check cannot verify, and commerce refuses it for a valid candidate.
      const order = state.buttons.map(button => button.data);
      assert.ok(order.indexOf('data-reconcile-cart') < order.indexOf('data-start-new-cart'), 'the check is offered first');
      assertRefusesCheckout(state, 'unconfirmed candidate');
    }
    const creates = (await control('state')).creates;
    const journalsBefore = (await first.storage()).records;
    await first.press('[data-start-new-cart]');
    await first.until(() => /Check unconfirmed cart/.test(document.querySelector('.cart-feedback .cart-error')?.textContent || '') && !document.querySelector('.cart-body[aria-busy="true"]'), 'abandonment of a valid candidate is refused');
    await settled(first);
    assert.deepEqual((await first.storage()).records, journalsBefore, 'the refused fallback changes no record');
    assert.equal((await control('state')).creates, creates, 'and creates nothing');
    await first.clearAnnounced();
    await first.press('[data-reconcile-cart]');
    await first.until(() => !document.querySelector('[data-reconcile-cart]'), 'reconciliation completes');
    await settled(first);
    state = await first.drawer();
    assert.equal(state.focusInDrawer, true);
    assert.equal((await control('state')).creates, creates, 'checking the cart creates nothing');
    if (variant === 'matching') {
      assert.deepEqual(state.quantities, ['1']);
      assert.equal(state.alert, '');
      assert.equal(state.checkoutEnabled, true);
      assert.deepEqual(live((await first.storage()).records), []);
    } else {
      assert.match(state.alert, /Shopify saved different items than you added\. You added .*OB16/i);
      assert.ok(hasButton(state, 'data-keep-unconfirmed-cart', 'Keep the items shown'));
      assert.ok(hasButton(state, 'data-discard-unconfirmed-cart', 'Start a new cart'));
      assert.equal(hasButton(state, 'data-recover-cart'), false, 'recovery is never offered for a mismatch');
      assertRefusesCheckout(state, 'mismatch');
      assert.ok((await first.announced()).some(item => item.role === 'alert' && /different items/.test(item.text)));
      // The other tab is told its cart changed; checking shows the same mismatch, still refusing checkout.
      await second.until(() => /changed in another tab/.test(document.querySelector('.cart-feedback .cart-error')?.textContent || ''), 'tab 2 sees the change');
      await second.press('[data-refresh-cart]');
      await second.until(() => document.querySelector('[data-keep-unconfirmed-cart]'), 'tab 2 shows the mismatch');
      assertRefusesCheckout(await second.drawer(), 'mismatch in tab 2');
      await first.press('[data-discard-unconfirmed-cart]');
      await first.until(() => document.querySelector('.cart-drawer .empty-cart'), 'discard empties the cart');
      assert.deepEqual(live((await first.storage()).records), []);
      assert.equal((await first.storage()).active, null);
    }
    results.push({ scenario: `check-unconfirmed-${variant}`, twoTabs: true, keyboard: true, checkoutRefused: true });
    console.log(`PASS Check unconfirmed cart (${variant}): offered in both tabs, keyboard activation, no create${variant === 'mismatch' ? ', mismatch described, keep/start-new offered, recovery withheld, tab 2 refreshed' : ', adopted and purchasable'}`);
  }

  // 3. Check the new cart / Try recovery again: a recovery's create answer is lost.
  await reset();
  await addBlack(first);
  await control('setApiError', true);
  await first.click('[data-qty-line][data-delta="1"]');
  await first.until(() => document.querySelector('.cart-drawer .cart-error'), 'ambiguous step reported');
  await control('setApiError', false);
  await settled(first);
  state = await first.drawer();
  assert.ok(hasButton(state, 'data-recover-cart', 'Continue with verified items in a new cart'), JSON.stringify(state));
  assertRefusesCheckout(state, 'ambiguous step');
  await control('failAfterNextMutation', 1);
  await first.press('[data-recover-cart]');
  await first.until(() => document.querySelector('[data-recover-retry]'), 'unconfirmed recovery offered');
  await settled(first);
  state = await first.drawer();
  assert.ok(hasButton(state, 'data-recover-cart', 'Check the new cart'));
  assert.ok(hasButton(state, 'data-recover-retry', 'Try recovery again'));
  assert.match(await first.run(() => document.querySelector('.cart-feedback small').textContent), /unused recovery cart may remain in Shopify/);
  assertRefusesCheckout(state, 'unconfirmed recovery');
  const afterLost = (await control('state')).creates;
  // Tab 2 checks the earlier attempt: its new-cart ID is unknown, so it is refused without another create.
  await second.visit('/product/br16');
  await second.openCart();
  state = await second.drawer();
  assert.ok(hasButton(state, 'data-recover-retry', 'Try recovery again'), JSON.stringify(state));
  await second.press('[data-recover-cart]');
  await second.until(() => /Try recovery again/.test(document.querySelector('.cart-feedback .cart-error')?.textContent || ''), 'tab 2 refusal explains the next step');
  await settled(second);
  assert.equal((await control('state')).creates, afterLost, 'checking never repeats the lost create');
  assertRefusesCheckout(await second.drawer(), 'unconfirmed recovery in tab 2');
  // Busy state: while the fresh attempt is in flight every recovery action is disabled.
  await control('delayNextMutation');
  await first.visit('/product/br16');
  await first.openCart();
  await first.press('[data-recover-retry]');
  await first.until(() => [...document.querySelectorAll('.cart-feedback button')].every(button => button.disabled), 'recovery actions busy');
  await control('awaitDelayedMutation');
  assertRefusesCheckout(await first.drawer(), 'busy recovery');
  await control('releaseDelayedMutation');
  await first.until(() => !document.querySelector('[data-recover-retry]') && document.querySelector('.cart-feedback .cart-guidance'), 'fresh recovery completes');
  state = await first.drawer();
  assert.match(state.guidance, /Review the items in your new cart/);
  assert.equal(state.focusInDrawer, true);
  assert.deepEqual(state.quantities, ['1'], 'the ambiguous +1 is never replayed');
  assert.equal((await control('state')).creates, afterLost + 1, 'exactly one fresh recovery cart');
  assert.deepEqual(live((await first.storage()).records), []);
  assert.ok((await first.announced()).some(item => item.role === 'status' && /Review the items/.test(item.text)), 'the outcome is announced politely');
  results.push({ scenario: 'recovery-check-and-retry', twoTabs: true, keyboard: true, busy: true, checkoutRefused: true });
  console.log('PASS Check the new cart / Try recovery again: labels and unused-cart copy, tab 2 check refused with no create, busy state, one fresh cart, quantity not replayed');

  // 4. Stale consent (Task 2D): tab 1 reviews mismatched cart A while tab 2 discards A and establishes
  // mismatched cart B. Tab 1's Keep or Start a new cart, still bound to A, is refused and changes nothing.
  const strand = async (page, intentFor) => {
    const active = (await page.storage()).active;
    assert.ok(active, 'the saved cart has an active pointer before it is stranded');
    const [saved] = (await control('state', active)).lines;
    assert.ok(saved, 'the fixture saved the glove before the pointer is detached');
    await page.run(intent => {
      const id = localStorage.getItem('anawin-shopify-cart-id');
      localStorage.removeItem('anawin-shopify-cart-id');
      localStorage.setItem(`anawin-shopify-unsafe-op:${crypto.randomUUID()}`, JSON.stringify({ cartId: '*', candidateCartId: id, kind: 'addProduct',
        kinds: ['addition'], status: 'pending', createdAt: 1, dispatched: true, createIntent: intent }));
    }, intentFor(saved));
    return active;
  };
  const blueIntent = saved => [{ merchandiseId: 'gid://variant/ob16', quantity: 1, attributes: saved.attributes, parentMerchandiseId: null }];
  const reviewMismatch = async page => {
    await page.visit('/product/br16');
    await page.openCart();
    // Another tab may already have checked the cart, in which case the mismatch is shown directly.
    await page.until(() => document.querySelector('[data-keep-unconfirmed-cart], [data-reconcile-cart]'), 'cart state shown');
    if (await page.run(() => Boolean(document.querySelector('[data-reconcile-cart]')))) await page.press('[data-reconcile-cart]');
    await page.until(() => document.querySelector('[data-keep-unconfirmed-cart]'), 'mismatch shown');
    await settled(page);
  };
  for (const [action, selector] of [['keep', '[data-keep-unconfirmed-cart]'], ['discard', '[data-discard-unconfirmed-cart]']]) {
    await reset();
    await addBlack(first);
    const cartA = await strand(first, blueIntent);
    await reviewMismatch(first);
    // Tab 2 reviews A itself, discards it, then a second mismatched cart B is established there.
    await reviewMismatch(second);
    await second.press('[data-discard-unconfirmed-cart]');
    await second.until(() => document.querySelector('.cart-drawer .empty-cart'), 'tab 2 discards A');
    await addBlack(second);
    const cartB = await strand(second, blueIntent);
    assert.notEqual(cartB, cartA);
    await reviewMismatch(second);
    const before = { storage: await second.storage(), shopify: await control('state', cartB) };
    // Tab 1 still shows A: its stale choice is refused, nothing changes, and it must review B afresh.
    await first.call('Page.bringToFront');
    await first.until(selector => document.querySelector(selector), 'tab 1 still offers the stale choice', selector);
    await first.clearAnnounced();
    await first.press(selector);
    await first.until(() => /changed in another tab/.test(document.querySelector('.cart-feedback .cart-error')?.textContent || ''), 'stale refusal explained');
    await settled(first);
    assert.deepEqual(await first.storage(), before.storage, `stale ${action}: active cart and journals unchanged`);
    assert.deepEqual(await control('state', cartB), before.shopify, `stale ${action}: Shopify state unchanged`);
    state = await first.drawer();
    assert.equal(state.focusInDrawer, true, 'focus stays in the drawer after the refusal');
    assert.ok(hasButton(state, 'data-keep-unconfirmed-cart') && hasButton(state, 'data-discard-unconfirmed-cart'), 'B is offered for a fresh review');
    assertRefusesCheckout(state, `stale ${action}`);
    assert.ok((await first.announced()).some(item => item.role === 'alert' && /changed in another tab/.test(item.text)), 'the refusal is announced');
    // The fresh review of B applies to B.
    await first.press(selector);
    if (action === 'keep') {
      await first.until(() => !document.querySelector('[data-keep-unconfirmed-cart]') && document.querySelector('button[data-checkout]:not([disabled])'), 'B kept');
      assert.equal((await first.storage()).active, cartB);
    } else {
      await first.until(() => document.querySelector('.cart-drawer .empty-cart'), 'B discarded');
      assert.equal((await first.storage()).active, null);
    }
    assert.deepEqual(live((await first.storage()).records), []);
    results.push({ scenario: `stale-${action}`, twoTabs: true, keyboard: true, checkoutRefused: true });
    console.log(`PASS Stale ${action === 'keep' ? 'Keep the items shown' : 'Start a new cart'}: consent for cart A refused once B is active, journals and Shopify unchanged, focus kept, fresh review of B applies`);
  }

  // 4b. A refused Keep or Start a new cart (Task 2F): Shopify answers the consent read with cart: null or a
  // malformed envelope. The drawer's redraw after the refusal must not forget the active cart either.
  await reset();
  await addBlack(first);
  const reviewed = await strand(first, blueIntent);
  await reviewMismatch(first);
  const localState = () => first.run(() => Object.fromEntries(Object.keys(localStorage).filter(key => key !== 'anawin-shopify-cart-revision')
    .map(key => [key, localStorage.getItem(key)])));
  const untouched = await localState();
  const writesBefore = (await control('state')).mutations;
  for (const [label, envelope] of [['cart: null', { data: { cart: null } }], ['a repeated cart: null', { data: { cart: null } }],
    ['a malformed envelope', { data: { cart: null }, errors: { message: 'malformed' } }]]) {
    await control('overrideCartReads', reviewed, envelope);
    for (const selector of ['[data-keep-unconfirmed-cart]', '[data-discard-unconfirmed-cart]']) {
      await first.until(selector => document.querySelector(selector), `${label}: the reviewed choice is still offered`, selector);
      await first.clearAnnounced();
      await first.press(selector);
      await first.until(() => document.querySelector('.cart-feedback .cart-error') && !document.querySelector('.cart-body[aria-busy="true"]'), `${label}: refusal shown`);
      await settled(first);
      assert.deepEqual(await localState(), untouched, `${label} ${selector}: active cart and journals byte-identical after the drawer redraw`);
      assert.equal((await control('state')).mutations, writesBefore, `${label}: no Shopify write`);
      state = await first.drawer();
      assert.equal(state.focusInDrawer, true, `${label}: focus stays in the drawer`);
      assert.ok((await first.announced()).some(item => item.role === 'alert'), `${label}: the refusal is announced`);
      assertRefusesCheckout(state, `${label} refusal`);
    }
  }
  // Task 2G: Check cart after the refusal is a read too. Repeated null and malformed answers never forget the
  // active cart or touch a journal; a cart Shopify reports gone is shown as such, with an explicit choice.
  for (const [label, envelope] of [['cart: null', { data: { cart: null } }], ['a repeated cart: null', { data: { cart: null } }],
    ['a malformed envelope', { data: { cart: null }, errors: { message: 'malformed' } }]]) {
    await control('overrideCartReads', reviewed, envelope);
    await first.until(() => document.querySelector('[data-refresh-cart]:not([disabled])'), `${label}: Check cart offered`);
    await first.clearAnnounced();
    await first.press('[data-refresh-cart]');
    await first.until(() => document.querySelector('.cart-feedback .cart-error') && !document.querySelector('.cart-body[aria-busy="true"]'), `${label}: Check cart answered`);
    await settled(first);
    assert.deepEqual(await localState(), untouched, `${label} Check cart: active cart and journals byte-identical`);
    assert.equal((await control('state')).mutations, writesBefore, `${label} Check cart: no Shopify write`);
    state = await first.drawer();
    assert.equal(state.focusInDrawer, true, `${label} Check cart: focus stays in the drawer`);
    assert.ok((await first.announced()).some(item => item.role === 'alert'), `${label} Check cart: the outcome is announced`);
    assertRefusesCheckout(state, `${label} Check cart`);
    if (label !== 'a malformed envelope') {
      assert.equal(await first.run(() => Boolean(document.querySelector('[data-start-new-cart]'))), true, `${label}: Start a new cart offered for a missing cart`);
    }
  }
  // Once Shopify answers again, Check cart brings the same review back and the reviewed choice applies to the same cart.
  await control('overrideCartReads', null);
  await first.press('[data-refresh-cart]');
  await first.until(() => document.querySelector('[data-keep-unconfirmed-cart]:not([disabled])'), 'the review is offered again');
  assert.deepEqual(await localState(), untouched);
  await first.press('[data-keep-unconfirmed-cart]');
  await first.until(() => !document.querySelector('[data-keep-unconfirmed-cart]') && document.querySelector('button[data-checkout]:not([disabled])'), 'kept after Shopify answers');
  assert.equal((await first.storage()).active, reviewed);
  assert.deepEqual(live((await first.storage()).records), []);
  results.push({ scenario: 'refused-consent-redraw', keyboard: true, checkoutRefused: true, storageUnchanged: true });
  console.log('PASS Refused consent: cart: null (repeated) and malformed reads refuse Keep and Start a new cart; the redraw and repeated Check cart keep the active cart and journals byte-identical, no write, focus kept, missing cart offers Start a new cart');

  // 5. A serviced recovery whose create is lost, an explicit glove-only restart whose create is also
  // lost, then the default retry: it stays glove-only and Shopify holds no paid service.
  await reset();
  await addBlack(first);
  await first.click('[data-add-service]');
  await first.until(() => document.querySelector('[data-confirm-service]'), 'service editor');
  await first.press('[data-confirm-service]');
  await first.until(() => document.querySelector('[data-remove-service]'), 'service attached');
  await settled(first);
  const serviced = await control('state', (await first.storage()).active);
  assert.deepEqual(serviced.lines.map(line => [line.handle, line.quantity, line.service]), [['br16', 1, false], ['break-in', 1, true]]);
  await control('setApiError', true);
  await first.click('[data-qty-line][data-delta="1"]');
  await first.until(() => document.querySelector('.cart-drawer .cart-error'), 'ambiguous step reported');
  await control('setApiError', false);
  await settled(first);
  await control('failAfterNextMutation', 1);
  await first.press('[data-recover-cart]');
  await first.until(() => document.querySelector('[data-recover-retry]'), 'serviced attempt unconfirmed');
  await settled(first);
  state = await first.drawer();
  assert.ok(hasButton(state, 'data-recover-retry', 'Try recovery again with Break-In Service'), JSON.stringify(state));
  assert.ok(hasButton(state, 'data-recover-retry-without-service', 'Start over without Break-In Service'));
  assertRefusesCheckout(state, 'serviced attempt unconfirmed');
  await control('failAfterNextMutation', 1);
  await first.press('[data-recover-retry-without-service]');
  await first.until(() => /without Break-In Service/.test(document.querySelector('[data-recover-retry]')?.textContent || ''), 'glove-only attempt unconfirmed');
  await settled(first);
  state = await first.drawer();
  assert.ok(hasButton(state, 'data-recover-retry', 'Try recovery again without Break-In Service'), JSON.stringify(state));
  assert.ok(hasButton(state, 'data-recover-retry-with-service', 'Start over with Break-In Service'), 'adding service back is an explicit, labelled switch');
  assert.equal(hasButton(state, 'data-recover-retry-without-service'), false);
  const createsBefore = (await control('state')).creates;
  await control('delayNextMutation');
  await first.press('[data-recover-retry]');
  await first.until(() => [...document.querySelectorAll('.cart-feedback button')].every(button => button.disabled), 'retry busy');
  await control('awaitDelayedMutation');
  assertRefusesCheckout(await first.drawer(), 'busy glove-only retry');
  await control('releaseDelayedMutation');
  await first.until(() => !document.querySelector('[data-recover-retry]') && document.querySelector('.cart-feedback .cart-guidance'), 'glove-only retry completes');
  const recoveredId = (await first.storage()).active;
  const saved = await control('state', recoveredId);
  assert.deepEqual(saved.lines.map(line => [line.handle, line.quantity, line.service]), [['br16', 1, false]], 'Shopify holds the glove only');
  assert.equal(saved.lines[0].attributes.find(attribute => attribute.key === '_anawin_service')?.value, 'none');
  assert.equal(saved.creates, createsBefore + 1);
  state = await first.drawer();
  assert.equal(await first.run(() => Boolean(document.querySelector('.cart-drawer [data-remove-service]'))), false, 'no service shown');
  assert.deepEqual(state.quantities, ['1']);
  assert.equal(state.focusInDrawer, true);
  assert.deepEqual(live((await first.storage()).records), []);
  results.push({ scenario: 'serviced-then-glove-only-recovery', keyboard: true, busy: true, checkoutRefused: true, fixtureVerified: true });
  console.log('PASS Serviced recovery then glove-only restart: mode labels, default retry stays glove-only, busy state, Shopify holds no service');

  // A stale mobile abandonment button remains bound to candidate A after another tab has replaced it with B.
  await reset();
  await first.call('Emulation.setDeviceMetricsOverride', { width: 375, height: 800, deviceScaleFactor: 2, mobile: true });
  await addBlack(first);
  const abandonSelector = '[data-start-new-cart]';
  const invalidCandidateRead = id => ({ data: { cart: { id, lines: { nodes: [], pageInfo: { hasNextPage: false } } } } });
  const abandonA = await strand(first, blueIntent);
  await control('overrideCartReads', abandonA, invalidCandidateRead(abandonA));
  await first.visit('/product/br16');
  await first.openCart();
  await first.until(selector => document.querySelector(selector), 'candidate A offers abandonment', abandonSelector);
  await second.visit('/product/br16');
  await second.openCart();
  await second.until(selector => document.querySelector(selector), 'second tab sees A', abandonSelector);
  await second.press(abandonSelector);
  await second.until(() => Object.keys(localStorage).some(key => key.startsWith('anawin-shopify-unsafe-op:') &&
    JSON.parse(localStorage.getItem(key)).resolution === 'abandoned'), 'second tab durably abandons A');
  await settled(second);
  await control('overrideCartReads', null);
  await addBlack(second);
  await second.until(() => Boolean(localStorage.getItem('anawin-shopify-cart-id')), 'second tab saves candidate B');
  const abandonB = await strand(second, blueIntent);
  assert.equal(abandonB !== abandonA, true);
  await control('overrideCartReads', abandonB, invalidCandidateRead(abandonB));
  const rawStorage = page => page.run(() => Object.keys(localStorage).filter(key =>
    key === 'anawin-shopify-cart-id' || key.startsWith('anawin-shopify-unsafe-op:')).sort()
    .map(key => [key, localStorage.getItem(key)]));
  const beforeAbandonment = { storage: await rawStorage(second), shopify: await control('state', abandonB) };
  await first.clearAnnounced();
  await first.press(abandonSelector);
  await settled(first);
  assert.match((await first.drawer()).alert, /changed in another tab.*before trying again/);
  assert.equal(JSON.stringify(await rawStorage(second)) === JSON.stringify(beforeAbandonment.storage), true, 'stale consent leaves exact journal bytes');
  assert.deepEqual(await control('state', abandonB), beforeAbandonment.shopify, 'stale consent sends no writes');
  assert.equal((await first.drawer()).focusInDrawer, true);
  assertRefusesCheckout(await first.drawer(), 'stale abandonment');
  assert.ok((await first.announced()).some(item => item.role === 'alert' && /before trying again/.test(item.text)));
  await first.press(abandonSelector);
  await first.until(selector => !document.querySelector(selector), 'freshly reviewed B can be abandoned', abandonSelector);
  assert.equal((await control('state', abandonB)).mutations, beforeAbandonment.shopify.mutations);
  assert.equal((await first.storage()).records.filter(record => record.resolution === 'abandoned').length, 2);
  await first.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  results.push({ scenario: 'stale-candidate-abandonment', twoTabs: true, keyboard: true, mobile: true, checkoutRefused: true });
  console.log('PASS Stale candidate abandonment: mobile keyboard action refused, exact journals kept, fresh consent sends no writes');

  // 6. Task 2H: a verified checkout on the mobile drawer, activated by keyboard, navigates exactly once (captured
  // locally) and leaves the exact checkout freeze; a later click is refused.
  await reset();
  await first.call('Emulation.setDeviceMetricsOverride', { width: 375, height: 800, deviceScaleFactor: 2, mobile: true });
  await addBlack(first);
  await first.until(() => document.querySelector('button[data-checkout]:not([disabled])'), 'checkout offered on mobile');
  await first.clearAnnounced();
  await first.press('button[data-checkout]');
  for (let wait = 0; wait < 200 && checkoutNavigations.length === 0; wait++) await sleep(50);
  assert.equal(checkoutNavigations.length, 1, 'one captured navigation');
  await first.until(() => document.readyState === 'complete' && document.querySelector('.cart-drawer'), 'the page stays after the cancelled handoff');
  assert.ok((await first.announced()).some(item => item.role === 'status' && /secure checkout/i.test(item.text)), 'polite status announced');
  const frozen = await first.storage();
  assert.deepEqual(frozen.records.map(record => record.kind), ['checkout handoff'], 'the exact freeze is persisted');
  await first.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  assert.equal(checkoutNavigations.length, 1, 'exactly one navigation');
  results.push({ scenario: 'mobile-verified-checkout', keyboard: true, navigations: checkoutNavigations.length, freeze: true });
  console.log('PASS Mobile verified checkout: keyboard activation, polite status, one locally captured navigation, exact freeze persisted');

  assert.deepEqual(errors, [], 'no page exceptions');
  assert.deepEqual(blocked, [], 'no non-loopback requests');
  await writeFile(`${dir}/results.json`, JSON.stringify({ status: 'passed', results, errors, blocked, checkoutNavigations }, null, 2));
} catch (error) {
  await writeFile(`${dir}/results.json`, JSON.stringify({ status: 'failed', error: String(error?.stack || error), results, errors, blocked }, null, 2));
  console.error(String(error?.stack || error), JSON.stringify({ errors, blocked }, null, 2));
  process.exitCode = 1;
} finally {
  for (const socket of sockets) socket.close();
  chrome.kill();
  server?.kill();
}
