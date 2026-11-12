import test from 'node:test';
import assert from 'node:assert/strict';
import { shopifyFixture } from '../test-support/shopify-fixture.js';
import { checkoutCartIsComplete } from '../src/checkout-safety.js';
import { createCartStateTracker, startStartupCartRestore } from '../src/startup-cart.js';

// Tabs are separate commerce instances sharing one storage and one mocked Shopify cart.
async function openTab(fixture) {
  const tab = fixture.restore();
  await tab.listProducts();
  await tab.getBreakInService();
  return tab;
}

// A getCart wrapper whose individual reads can be held and released.
function controlledReads(read) {
  const calls = [];
  let holdNext = false;
  const getCart = () => {
    const call = { result: null, released: null };
    calls.push(call);
    if (!holdNext) return (call.result = read());
    holdNext = false;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    call.released = release;
    return (call.result = gate.then(read));
  };
  return { getCart, calls, holdNext() { holdNext = true; } };
}

async function startupWithCart() {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  await fixture.commerce.addProduct('black', true, { level: 'Game Ready (90%)', wearingStyle: 'Two in the Pinky (TIP)' });
  const tab = await openTab(fixture);
  const tracker = createCartStateTracker(() => tab.readCartSafety());
  return { fixture, tab, tracker };
}

const gloves = cart => cart.lines.filter(line => !line.isBreakIn);

test('a populated cart restored during startup keeps its pairing, customization and checkout eligibility', async () => {
  const { tab, tracker } = await startupWithCart();
  const reads = controlledReads(() => tab.getCart());
  const finish = startStartupCartRestore({ getCart: reads.getCart, tracker });
  const result = await finish();
  assert.equal(result.status, 'current');
  const cart = result.value;
  assert.equal(gloves(cart).length, 1);
  const child = cart.lines.find(line => line.isBreakIn);
  assert.equal(child.parentLineId, gloves(cart)[0].remoteLineId);
  assert.ok(child.attributes.some(({ key, value }) => key === 'Break-In Level' && value === 'Game Ready (90%)'));
  assert.equal(cart.subtotal, 175);
  assert.equal(checkoutCartIsComplete(cart), true);
  assert.equal(reads.calls.length, 1, 'no extra read when nothing changed');
});

test('another-tab update after the early answer triggers one guarded fresh read', async () => {
  for (const announce of [true, false]) {
    const { fixture, tab, tracker } = await startupWithCart();
    const reads = controlledReads(() => tab.getCart());
    const finish = startStartupCartRestore({ getCart: reads.getCart, tracker });
    const early = await reads.calls[0].result;
    assert.equal(gloves(early).length, 1, 'early answer predates the other tab');
    const other = await openTab(fixture);
    await other.addProduct('blue', false);
    // A storage event normally announces this; the persisted revision alone must also be detected.
    if (announce) tracker.externalChange();
    const result = await finish();
    assert.equal(result.status, 'current', `announce=${announce}`);
    assert.equal(gloves(result.value).length, 2, `announce=${announce}: shows the newer cart`);
    assert.equal(reads.calls.length, 2, `announce=${announce}: exactly one fresh read`);
  }
});

test('another tab replacing the active cart id is detected and only the new id is read', async () => {
  const { fixture, tab, tracker } = await startupWithCart();
  const original = fixture.storage.getItem('anawin-shopify-cart-id');
  const readIds = [];
  const finish = startStartupCartRestore({ getCart: () => { readIds.push(fixture.storage.getItem('anawin-shopify-cart-id')); return tab.getCart(); }, tracker });
  const replacement = 'gid://cart/other-tab';
  fixture.storage.setItem('anawin-shopify-cart-id', replacement); // before the early answer is applied
  const result = await finish();
  assert.deepEqual(readIds, [original, replacement]);
  assert.equal(result.status, 'current');
  assert.notEqual(result.value.id, original, 'the old cart is never applied under a replaced id');
});

test('a same-tab refresh during startup supersedes the older startup answer without another read', async () => {
  const { tab, tracker } = await startupWithCart();
  const reads = controlledReads(() => tab.getCart());
  let busy = false;
  const finish = startStartupCartRestore({ getCart: reads.getCart, tracker, isBusy: () => busy });
  await reads.calls[0].result;
  tracker.localChange(); // cartAction start: e.g. Check cart
  busy = true;
  const refreshed = tab.refreshCart();
  assert.equal((await finish()).status, 'superseded');
  busy = false;
  assert.equal(gloves(await refreshed).length, 1);
  assert.equal(reads.calls.length, 1);
  // Completed same-tab actions also supersede, even when no longer busy.
  const next = startStartupCartRestore({ getCart: reads.getCart, tracker });
  await reads.calls[1].result;
  tracker.localChange();
  assert.equal((await next()).status, 'superseded');
});

test('another change while the fresh read is pending ends stale after a bounded number of reads', async () => {
  const { fixture, tab, tracker } = await startupWithCart();
  const reads = controlledReads(() => tab.getCart());
  const finish = startStartupCartRestore({ getCart: reads.getCart, tracker });
  await reads.calls[0].result;
  const other = await openTab(fixture);
  await other.addProduct('blue', false);
  tracker.externalChange();
  reads.holdNext();
  const settled = finish();
  while (reads.calls.length < 2) await new Promise(resolve => setTimeout(resolve, 0));
  await other.addProduct('brown', false); // changes again while the fresh read is pending
  tracker.externalChange();
  reads.calls[1].released();
  assert.equal((await settled).status, 'stale');
  assert.equal(reads.calls.length, 2, 'no unbounded re-reading');
  // A same-tab action during the fresh read also wins.
  const again = startStartupCartRestore({ getCart: reads.getCart, tracker });
  await reads.calls[2].result;
  tracker.externalChange();
  reads.holdNext();
  const pending = again();
  while (reads.calls.length < 4) await new Promise(resolve => setTimeout(resolve, 0));
  tracker.localChange();
  reads.calls[3].released();
  assert.equal((await pending).status, 'superseded');
});

test('restoration failure is reported as an error, blocks nothing else, and a later read recovers the cart', async () => {
  const { tab, tracker } = await startupWithCart();
  let fail = true;
  const getCart = () => fail ? Promise.reject(new Error('Shopify request failed (503).')) : tab.getCart();
  const result = await startStartupCartRestore({ getCart, tracker })();
  assert.equal(result.status, 'current');
  assert.match(result.error.message, /503/);
  fail = false;
  const recovered = await tab.refreshCart();
  assert.equal(gloves(recovered).length, 1);
  assert.equal(checkoutCartIsComplete(recovered), true);
  // A failing fresh read is reported the same way, not retried.
  let reads = 0;
  const flaky = () => (reads += 1) === 1 ? tab.getCart() : Promise.reject(new Error('Shopify network request failed.'));
  const finish = startStartupCartRestore({ getCart: flaky, tracker });
  await new Promise(resolve => setTimeout(resolve, 0));
  tracker.externalChange();
  const second = await finish();
  assert.equal(second.status, 'current');
  assert.match(second.error.message, /network/);
  assert.equal(reads, 2);
});

test('an expired cart cleared by the startup read itself is not mistaken for another tab', async () => {
  const { fixture, tab, tracker } = await startupWithCart();
  fixture.expireCart();
  let reads = 0;
  const result = await startStartupCartRestore({ getCart: () => { reads += 1; return tab.getCart(); }, tracker })();
  assert.equal(result.status, 'current');
  assert.equal(result.value.lines.length, 0);
  assert.equal(fixture.storage.getItem('anawin-shopify-cart-id'), null);
  assert.equal(reads, 1);
});

test('synchronous and asynchronous read failures never become unhandled rejections', async () => {
  const unhandled = [];
  const listener = error => unhandled.push(error);
  process.on('unhandledRejection', listener);
  try {
    const tracker = createCartStateTracker(() => ({ id: null, revision: null }));
    const sync = startStartupCartRestore({ getCart: () => { throw new Error('sync'); }, tracker });
    const async = startStartupCartRestore({ getCart: () => Promise.reject(new Error('async')), tracker });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal((await sync()).error.message, 'sync');
    assert.equal((await async()).error.message, 'async');
    assert.deepEqual(unhandled, []);
  } finally { process.off('unhandledRejection', listener); }
});
