import test from 'node:test';
import assert from 'node:assert/strict';
import { shopifyFixture } from '../test-support/shopify-fixture.js';
import { confirmedBreakInParent, createBreakInEditor, renderBreakInEditor } from '../src/cart-break-in-editor.js';
import { renderCartRow } from '../src/cart-row.js';
import { serviceAttributes } from '../src/catalog.js';

const money = (amount, currency) => new Intl.NumberFormat('en-US', {
  style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 2
}).format(amount);
const escapeHtml = value => String(value).replace(/[&<>'"]/g, character =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
const product = { id: 'black', name: 'BR16', tone: 'Black / Tan', images: ['/images/black1.PNG'] };
const serviceProduct = { price: 20, currencyCode: 'USD', available: true };
const GAME_READY_TIP = { level: 'Game Ready (90%)', wearingStyle: 'Two in the Pinky (TIP)' };
const FIRM_TRADITIONAL = { level: 'Firm (40%)', wearingStyle: 'Traditional' };
const attribute = (line, key) => line.attributes.find(item => item.key === key)?.value;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function trainerFixture() {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  const cart = await fixture.commerce.addProduct('black', false);
  return { ...fixture, cart, lineId: cart.lines[0].remoteLineId };
}

function pairing(cart) {
  return cart.lines.filter(line => !line.isBreakIn).map(parent => {
    const child = cart.lines.find(line => line.isBreakIn && line.parentLineId === parent.remoteLineId);
    return { quantity: parent.quantity, service: parent.serviceConfiguration,
      parentLevel: attribute(parent, '_anawin_break_in_level') || null,
      parentStyle: attribute(parent, '_anawin_wearing_style') || null,
      childQuantity: child?.quantity || 0,
      childLevel: child ? attribute(child, 'Break-In Level') : null,
      childStyle: child ? attribute(child, 'Glove Wearing Style') : null };
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

test('cart editor shows every firmness and wearing style, defaults Medium / Traditional, and the verified price', () => {
  const editor = createBreakInEditor();
  editor.open('glove-1', 'black');
  const html = renderBreakInEditor({ product, line: { remoteLineId: 'glove-1', quantity: 1 }, editor: editor.state,
    serviceProduct: { ...serviceProduct, price: 24.5 }, busy: false, incomplete: false, money, escapeHtml });
  for (const value of ['Firm (40%)', 'Medium (65%)', 'Game Ready (90%)', 'Traditional', 'Two in the Pinky (TIP)']) {
    assert.match(html, new RegExp(`type="radio" name="cart-(break-in-level|glove-wearing-style)" value="${value.replace(/[()]/g, '\\$&')}"`));
  }
  assert.match(html, /<legend>Firmness<\/legend>/);
  assert.match(html, /<legend>Wearing style<\/legend>/);
  assert.match(html, /value="Medium \(65%\)" checked/);
  assert.match(html, /value="Traditional" checked/);
  assert.equal(html.match(/ checked/g).length, 2);
  assert.match(html, /Break-in service <strong>\+\$24\.5<\/strong>/);
  assert.match(html, /<button type="submit" class="cart-service-confirm" data-confirm-service="glove-1" >Add break-in \+\$24\.5<\/button>/);
  assert.match(html, /<button type="button" class="cart-service-cancel" data-cancel-service="glove-1" >Cancel<\/button>/);
  assert.match(html, /aria-labelledby="cart-service-editor-heading"/);
  assert.match(html, /Customize break-in for BR16/);
});

test('cart editor reflects nondefault choices and names the one glove of a multi-quantity line', () => {
  const editor = createBreakInEditor();
  editor.open('glove-1', 'black');
  assert.equal(editor.select('level', 'Game Ready (90%)'), true);
  assert.equal(editor.select('wearingStyle', 'Two in the Pinky (TIP)'), true);
  assert.equal(editor.select('level', 'Extra Soft'), false);
  const html = renderBreakInEditor({ product, line: { remoteLineId: 'glove-1', quantity: 3 }, editor: editor.state,
    serviceProduct, busy: false, incomplete: false, money, escapeHtml });
  assert.match(html, /value="Game Ready \(90%\)" checked/);
  assert.match(html, /value="Two in the Pinky \(TIP\)" checked/);
  assert.doesNotMatch(html, /value="Medium \(65%\)" checked/);
  assert.match(html, /Customize break-in for 1 of 3 BR16 gloves/);
});

test('cart row replaces only the chosen line add button with the editor and shows confirmed customization', () => {
  const editor = createBreakInEditor();
  editor.open('glove-1', 'black');
  const line = id => ({ remoteLineId: id, quantity: 1, lineTotal: { amount: 155, currencyCode: 'USD' }, instructions: { canUpdateQuantity: true } });
  const row = id => renderCartRow({ product, line: line(id), service: null, mode: 'shopify', serviceProduct,
    busy: false, incomplete: false, money, escapeHtml, editor: editor.state });
  assert.match(row('glove-1'), /data-service-form="glove-1"/);
  assert.doesNotMatch(row('glove-1'), /data-add-service/);
  assert.match(row('glove-2'), /data-add-service="glove-2"/);
  assert.doesNotMatch(row('glove-2'), /data-service-form/);
  const serviced = renderCartRow({ product, line: line('glove-1'), mode: 'shopify', serviceProduct, busy: false,
    incomplete: false, money, escapeHtml, notice: 'Break-in service added: Game Ready (90%) · Two in the Pinky (TIP)',
    service: { parentLineId: 'glove-1', quantity: 1, lineTotal: { amount: 20, currencyCode: 'USD' },
      instructions: { canRemove: true }, attributes: serviceAttributes(GAME_READY_TIP) } });
  assert.match(serviced, /role="status" tabindex="-1" data-service-notice>Break-in service added: Game Ready \(90%\) · Two in the Pinky \(TIP\)/);
  assert.match(serviced, /Break-In Level: Game Ready \(90%\)/);
  assert.match(serviced, /Glove Wearing Style: Two in the Pinky \(TIP\)/);
  assert.doesNotMatch(serviced, /data-service-form/);
});

test('cancel closes the editor without performing any cart change', async () => {
  const { commerce, lineId, requests } = await trainerFixture();
  const editor = createBreakInEditor();
  editor.open(lineId, 'black');
  editor.select('level', 'Firm (40%)');
  const mutations = requests.filter(item => item.query.includes('mutation')).length;
  assert.equal(editor.cancel(), lineId);
  assert.equal(editor.state, null);
  assert.deepEqual(await editor.submit(lineId, () => assert.fail('cancelled editor must not submit')), { status: 'ignored' });
  assert.equal(requests.filter(item => item.query.includes('mutation')).length, mutations);
  const cart = await commerce.getCart();
  assert.equal(cart.lines.some(line => line.isBreakIn), false);
  assert.equal(cart.lines[0].serviceConfiguration, 'none');
});

test('confirming nondefault choices attaches matching service to the chosen glove only after Shopify confirms', async () => {
  const { commerce, lineId, requests } = await trainerFixture();
  const editor = createBreakInEditor();
  editor.open(lineId, 'black');
  editor.select('level', 'Game Ready (90%)');
  editor.select('wearingStyle', 'Two in the Pinky (TIP)');
  const result = await editor.submit(lineId, async options => ({ status: 'ok', cart: await commerce.addBreakIn(lineId, options) }));
  assert.equal(result.status, 'added');
  assert.deepEqual(result.options, GAME_READY_TIP);
  assert.equal(editor.state, null);
  const cart = await commerce.getCart();
  assert.deepEqual(pairing(cart), [{ quantity: 1, service: 'break-in', parentLevel: 'Game Ready (90%)',
    parentStyle: 'Two in the Pinky (TIP)', childQuantity: 1, childLevel: 'Game Ready (90%)', childStyle: 'Two in the Pinky (TIP)' }]);
  assert.equal(result.parentLineId, cart.lines.find(line => !line.isBreakIn).remoteLineId);
  assert.deepEqual(requests.filter(item => item.query.includes('AddLines')).at(-1).variables.lines[0].attributes,
    serviceAttributes(GAME_READY_TIP));
  assert.equal(cart.incomplete, false);
  assert.equal(cart.subtotal, 175);
});

test('duplicate confirm clicks submit one service addition', async () => {
  const { commerce, lineId } = await trainerFixture();
  const editor = createBreakInEditor();
  editor.open(lineId, 'black');
  const gate = deferred();
  let calls = 0;
  const first = editor.submit(lineId, async options => {
    calls++;
    await gate.promise;
    return { status: 'ok', cart: await commerce.addBreakIn(lineId, options) };
  });
  assert.equal(editor.state.submitting, true);
  assert.deepEqual(await editor.submit(lineId, () => { calls++; }), { status: 'ignored' });
  assert.equal(editor.cancel(), null, 'cancel is unavailable while the addition is pending');
  assert.equal(editor.select('level', 'Firm (40%)'), false, 'choices are locked while the addition is pending');
  gate.resolve();
  assert.equal((await first).status, 'added');
  assert.equal(calls, 1);
  const cart = await commerce.getCart();
  assert.equal(cart.lines.filter(line => line.isBreakIn).length, 1);
  assert.equal(cart.lines.find(line => line.isBreakIn).quantity, 1);
});

test('a resolved action without confirmed matching service is not reported as success', async () => {
  const { commerce, lineId } = await trainerFixture();
  const editor = createBreakInEditor();
  editor.open(lineId, 'black');
  editor.select('level', 'Firm (40%)');
  const unchanged = await commerce.getCart();
  const result = await editor.submit(lineId, async () => ({ status: 'ok', cart: unchanged }));
  assert.equal(result.status, 'failed');
  assert.equal(editor.state.submitting, false);
  assert.equal(editor.state.level, 'Firm (40%)');
  assert.match(editor.state.error, /could not confirm/);
  // Service with other choices than the ones confirmed is not success either.
  const otherChoices = await commerce.addBreakIn(lineId, GAME_READY_TIP);
  assert.equal(confirmedBreakInParent(otherChoices, 'black', FIRM_TRADITIONAL), null);
  assert.equal(confirmedBreakInParent({ ...otherChoices, incomplete: true }, 'black', GAME_READY_TIP), null);
});

test('mutation failure keeps the editor open with selections and allows a retry', async () => {
  const fixture = await trainerFixture();
  const { commerce, lineId } = fixture;
  const editor = createBreakInEditor();
  editor.open(lineId, 'black');
  editor.select('level', 'Firm (40%)');
  editor.select('wearingStyle', 'Two in the Pinky (TIP)');
  const perform = async options => {
    try { return { status: 'ok', cart: await commerce.addBreakIn(lineId, options) }; }
    catch { return { status: 'error', message: 'Couldn’t add break-in service. Please try again.' }; }
  };
  fixture.rejectNextMutation();
  const failed = await editor.submit(lineId, perform);
  assert.equal(failed.status, 'failed');
  assert.deepEqual({ level: editor.state.level, wearingStyle: editor.state.wearingStyle, submitting: editor.state.submitting },
    { level: 'Firm (40%)', wearingStyle: 'Two in the Pinky (TIP)', submitting: false });
  assert.equal(editor.state.error, 'Couldn’t add break-in service. Please try again. Your selections are saved.');
  const afterFailure = await commerce.getCart();
  assert.equal(afterFailure.lines.some(line => line.isBreakIn), false);
  assert.equal(afterFailure.lines[0].serviceConfiguration, 'none');
  const html = renderBreakInEditor({ product, line: afterFailure.lines[0], editor: editor.state, serviceProduct,
    busy: false, incomplete: afterFailure.incomplete, money, escapeHtml });
  assert.match(html, /role="alert" tabindex="-1" >Couldn’t add break-in service/);
  assert.match(html, /value="Firm \(40%\)" checked/);
  const retried = await editor.submit(lineId, perform);
  assert.equal(retried.status, 'added');
  assert.deepEqual(pairing(await commerce.getCart()), [{ quantity: 1, service: 'break-in', parentLevel: 'Firm (40%)',
    parentStyle: 'Two in the Pinky (TIP)', childQuantity: 1, childLevel: 'Firm (40%)', childStyle: 'Two in the Pinky (TIP)' }]);
});

test('invalid trainer options are rejected before any Shopify mutation', async () => {
  const { commerce, lineId, requests } = await trainerFixture();
  const mutations = requests.filter(item => item.query.includes('mutation')).length;
  await assert.rejects(commerce.addBreakIn(lineId, { level: 'Extra Soft', wearingStyle: 'Traditional' }), /Select a break-in level/);
  assert.equal(requests.filter(item => item.query.includes('mutation')).length, mutations);
  assert.equal((await commerce.getCart()).incomplete, false);
});

test('adding nondefault service to one of two gloves splits only one glove with the chosen customization', async () => {
  const { commerce, lineId } = await trainerFixture();
  await commerce.setLineQuantity(lineId, 2);
  const cart = await commerce.addBreakIn(lineId, FIRM_TRADITIONAL);
  assert.equal(cart.incomplete, false);
  assert.deepEqual(pairing(cart), [
    { quantity: 1, service: 'break-in', parentLevel: 'Firm (40%)', parentStyle: 'Traditional',
      childQuantity: 1, childLevel: 'Firm (40%)', childStyle: 'Traditional' },
    { quantity: 1, service: 'none', parentLevel: null, parentStyle: null, childQuantity: 0, childLevel: null, childStyle: null }
  ]);
  assert.equal(cart.subtotal, 330);
});

test('identical gloves with different break-in customizations stay as separate correctly paired entries', async () => {
  const { commerce } = await trainerFixture();
  await commerce.addProduct('black', true, FIRM_TRADITIONAL);
  const before = await commerce.getCart();
  const unserviced = before.lines.find(line => !line.isBreakIn && line.serviceConfiguration === 'none');
  const cart = await commerce.addBreakIn(unserviced.remoteLineId, GAME_READY_TIP);
  assert.equal(cart.incomplete, false);
  assert.deepEqual(pairing(cart), [
    { quantity: 1, service: 'break-in', parentLevel: 'Firm (40%)', parentStyle: 'Traditional',
      childQuantity: 1, childLevel: 'Firm (40%)', childStyle: 'Traditional' },
    { quantity: 1, service: 'break-in', parentLevel: 'Game Ready (90%)', parentStyle: 'Two in the Pinky (TIP)',
      childQuantity: 1, childLevel: 'Game Ready (90%)', childStyle: 'Two in the Pinky (TIP)' }
  ]);
  assert.equal(cart.subtotal, 350);
  // Adding the same customization again merges into the matching entry rather than the other one.
  const third = await commerce.addProduct('black', false);
  const plain = third.lines.find(line => !line.isBreakIn && line.serviceConfiguration === 'none');
  const merged = await commerce.addBreakIn(plain.remoteLineId, GAME_READY_TIP);
  assert.equal(merged.incomplete, false);
  assert.deepEqual(pairing(merged).map(entry => [entry.parentLevel, entry.quantity, entry.childQuantity]),
    [['Firm (40%)', 1, 1], ['Game Ready (90%)', 2, 2]]);
});

test('a line serviced elsewhere with other choices is refused and never reported as the shopper selection', async () => {
  const fixture = await trainerFixture();
  const { commerce, lineId } = fixture;
  await commerce.addProduct('black', true, FIRM_TRADITIONAL);
  const other = fixture.restore();
  await other.listProducts();
  await other.getBreakInService();
  await other.addBreakIn(lineId, { level: 'Medium (65%)', wearingStyle: 'Traditional' });
  const editor = createBreakInEditor();
  editor.open(lineId, 'black');
  editor.select('level', 'Firm (40%)');
  const reviewed = await commerce.getCart();
  const mutations = fixture.requests.filter(item => item.query.includes('mutation')).length;
  const result = await editor.submit(lineId, async options => {
    try { return { status: 'ok', cart: await commerce.addBreakIn(lineId, options) }; }
    catch (error) { assert.equal(error.code, 'cart-changed'); return { status: 'error', message: error.message }; }
  }, reviewed);
  assert.equal(result.status, 'failed');
  assert.equal(fixture.requests.filter(item => item.query.includes('mutation')).length, mutations, 'no mutation was sent');
  assert.equal(editor.state.level, 'Firm (40%)');
  const cart = await commerce.getCart();
  assert.deepEqual(pairing(cart).map(entry => [entry.parentLevel, entry.childQuantity]),
    [['Firm (40%)', 1], ['Medium (65%)', 1]]);
  // The same choices already on the line are an idempotent no-op rather than a second service.
  const same = await commerce.addBreakIn(lineId, { level: 'Medium (65%)', wearingStyle: 'Traditional' });
  assert.equal(same.lines.filter(line => line.isBreakIn).length, 2);
});

test('success follows a re-keyed parent only when its matching serviced quantity grew', async () => {
  const fixture = shopifyFixture({ rekeyOnAttributeUpdate: true });
  await fixture.commerce.listProducts();
  const reviewed = await fixture.commerce.addProduct('black', false);
  const oldId = reviewed.lines[0].remoteLineId;
  const editor = createBreakInEditor();
  editor.open(oldId, 'black');
  editor.select('wearingStyle', 'Two in the Pinky (TIP)');
  const result = await editor.submit(oldId, async options => ({ status: 'ok', cart: await fixture.commerce.addBreakIn(oldId, options) }), reviewed);
  assert.equal(result.status, 'added');
  const cart = await fixture.commerce.getCart();
  const parent = cart.lines.find(line => !line.isBreakIn);
  assert.notEqual(parent.remoteLineId, oldId);
  assert.equal(result.parentLineId, parent.remoteLineId);
  // Without growth since the reviewed cart, an existing matching entry is not success.
  assert.equal(confirmedBreakInParent(cart, 'black', { level: 'Medium (65%)', wearingStyle: 'Two in the Pinky (TIP)' },
    { lineId: oldId, before: cart }), null);
});

test('uncertain mutation failure blocks a retry from adding a second service', async () => {
  const fixture = await trainerFixture();
  const { commerce, lineId } = fixture;
  const editor = createBreakInEditor();
  editor.open(lineId, 'black');
  editor.select('level', 'Game Ready (90%)');
  const perform = async options => {
    try { return { status: 'ok', cart: await commerce.addBreakIn(lineId, options) }; }
    catch (error) { return { status: 'error', message: error.message }; }
  };
  // Shopify attaches the service line but the response to that mutation is lost.
  fixture.failAfterNextMutation(2);
  assert.equal((await editor.submit(lineId, perform)).status, 'failed');
  assert.equal(editor.state.level, 'Game Ready (90%)');
  assert.equal((await commerce.getCart()).incomplete, true, 'the cart is held for review');
  const html = renderBreakInEditor({ product, line: { remoteLineId: lineId, quantity: 1 }, editor: editor.state,
    serviceProduct, busy: false, incomplete: true, money, escapeHtml });
  assert.match(html, /data-confirm-service="[^"]+" disabled/);
  assert.equal((await editor.submit(lineId, perform)).status, 'failed');
  const serviceLines = fixture.lines.filter(line => line.parentRelationship);
  assert.equal(serviceLines.length, 1, 'Shopify holds exactly the one service line the lost response created');
  assert.equal(serviceLines[0].quantity, 1);
});

test('unverified or unavailable service pricing is never shown as a $20 fallback', () => {
  const line = { remoteLineId: 'glove-1', quantity: 1, lineTotal: { amount: 155, currencyCode: 'USD' }, instructions: { canUpdateQuantity: true } };
  for (const unverified of [{ price: 20, currencyCode: 'USD', available: false }, { price: 20, currencyCode: 'USD' }]) {
    const row = renderCartRow({ product, line, service: null, mode: 'shopify', serviceProduct: unverified,
      busy: false, incomplete: false, money, escapeHtml });
    assert.doesNotMatch(row, /data-add-service|\$20/);
    assert.match(row, /Break-in service is unavailable right now\./);
    const editor = createBreakInEditor();
    editor.open('glove-1', 'black');
    const form = renderBreakInEditor({ product, line, editor: editor.state, serviceProduct: unverified,
      busy: false, incomplete: false, money, escapeHtml });
    assert.doesNotMatch(form, /\$20/);
    assert.match(form, /data-confirm-service="glove-1" disabled>Unavailable/);
  }
});

test('editor escapes product names, line IDs and error text', () => {
  const editor = createBreakInEditor();
  editor.open('x"><img src=x onerror=alert(1)>', 'black');
  const html = renderBreakInEditor({ product: { ...product, name: '<b>BR16</b>' },
    line: { remoteLineId: 'x"><img src=x onerror=alert(1)>', quantity: 1 },
    editor: { ...editor.state, error: '<script>bad()</script>' }, serviceProduct, busy: false, incomplete: false, money, escapeHtml });
  assert.doesNotMatch(html, /<img|<script>|<b>BR16/);
  assert.match(html, /&lt;b&gt;BR16&lt;\/b&gt;/);
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
});

test('quantity changes keep nondefault trainer choices on glove and service lines', async () => {
  const { commerce, lineId } = await trainerFixture();
  await commerce.addBreakIn(lineId, GAME_READY_TIP);
  const parentId = (await commerce.getCart()).lines.find(line => !line.isBreakIn).remoteLineId;
  const doubled = await commerce.setLineQuantity(parentId, 2);
  assert.equal(doubled.incomplete, false);
  assert.deepEqual(pairing(doubled), [{ quantity: 2, service: 'break-in', parentLevel: 'Game Ready (90%)',
    parentStyle: 'Two in the Pinky (TIP)', childQuantity: 2, childLevel: 'Game Ready (90%)', childStyle: 'Two in the Pinky (TIP)' }]);
  const removed = await commerce.removeBreakIn(doubled.lines.find(line => !line.isBreakIn).remoteLineId);
  assert.equal(removed.incomplete, false);
  assert.deepEqual(pairing(removed).map(entry => [entry.service, entry.parentLevel, entry.quantity, entry.childQuantity]),
    [['break-in', 'Game Ready (90%)', 1, 1], ['none', null, 1, 0]]);
});
