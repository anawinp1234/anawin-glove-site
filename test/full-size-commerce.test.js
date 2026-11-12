import test from 'node:test';
import assert from 'node:assert/strict';
import { shopifyFixture } from '../test-support/shopify-fixture.js';
import { cartCustomizationIsComplete, fullSizeProducts, normalizeFullSizeOptions, FULL_SIZE_SHAPING_FIELDS, fullSizeBreakInService, optionsFromAttributes, serviceAttributes, FULL_SIZE_SERVICE_VARIANT, fullSizeConfiguration, FULL_SIZE_CONFIGURATION_KEY } from '../src/catalog.js';
import { checkoutCartIsComplete, createCheckoutVerifier, redirectToVerifiedCheckout } from '../src/checkout-safety.js';
const options = { type: 'full-size', wearingStyle: 'Traditional — index finger out', closure: 'Ring finger', thumbShape: 'Straight', pinkyShape: 'Flared', fingerShape: 'Rolled', firmness: 'Medium', notes: '  slight thumb flare  ' };
async function fixture(config) { const f = shopifyFixture({ fullSize: true, ...config }); await f.commerce.listProducts(); return f; }
const add = (f, selected = options, hand = 'right') => f.commerce.addProduct('full-mint', true, selected, `gid://variant/mi26-${hand}`);
const parent = cart => cart.lines.find(line => line.productId === 'full-mint' && !line.isBreakIn);

test('each approved full-size display price is explicit and products remain Coming Soon', () => {
  for (const [model, price] of [['MI26', 290], ['BL50', 290], ['OR17', 290], ['CM24', 285]]) {
    const product = fullSizeProducts.find(p => p.name === model);
    assert.equal(product.price, price); assert.equal(product.comingSoon, true);
  }
});
test('full-size options require deliberate choices and Other placement; text is trimmed and limited', () => {
  for (const key of ['wearingStyle', 'closure', 'thumbShape', 'pinkyShape', 'fingerShape', 'firmness']) assert.throws(() => normalizeFullSizeOptions({ ...options, [key]: undefined }));
  assert.throws(() => normalizeFullSizeOptions({ ...options, wearingStyle: 'Other — describe your finger placement', placement: '  ' }), /Describe/);
  const selected = normalizeFullSizeOptions({ ...options, notes: ' '+ 'a'.repeat(2200) + ' ', placement: 'ignored' });
  assert.equal(selected.notes.length, 2000); assert.equal(selected.placement, '');
});
test('all four models add with and without full-size service', async () => {
  for (const [id, code] of [['full-mint','mi26'], ['full-black','bl50'], ['full-orange','or17'], ['full-camel','cm24']]) {
    const f = await fixture();
    const plain = await f.commerce.addProduct(id, false, undefined, `gid://variant/${code}-right`);
    assert.equal(plain.lines.length, 1); assert.equal(plain.incomplete, false);
    const cart = await f.commerce.addProduct(id, true, options, `gid://variant/${code}-right`);
    assert.equal(cart.lines.length, 3); assert.equal(cart.incomplete, false);
    assert.equal(cart.lines.find(l => l.isBreakIn).merchandiseId, FULL_SIZE_SERVICE_VARIANT);
    assert.equal(cart.lines.find(l => l.isBreakIn).unitPrice.amount, 75);
    assert.ok(cartCustomizationIsComplete(cart.lines));
  }
});
test('mixed trainer and full-size cart preserves both service schemas and left-hand variant on reload', async () => {
  const f = await fixture(); await f.commerce.addProduct('black', true);
  const cart = await add(f, options, 'left');
  assert.equal(cart.subtotal, 540); assert.equal(cart.incomplete, false);
  assert.equal(parent(cart).merchandiseId, 'gid://variant/mi26-left');
  assert.equal(parent(cart).throwingHand, 'Left');
  assert.ok(parent(cart).attributes.every(attribute => attribute.key.startsWith('_')));
  const restored = await f.restore().getCart(); assert.deepEqual(restored.lines, cart.lines);
  assert.equal(checkoutCartIsComplete(restored), true);
});
test('same variant with different and repeated instructions resolves service parents by line ID', async () => {
  const f = await fixture(); await add(f); await add(f, { ...options, firmness: 'Firm' });
  const cart = await add(f);
  const parents = cart.lines.filter(l => !l.isBreakIn);
  assert.equal(parents.length, 2); assert.deepEqual(parents.map(l => l.quantity), [2,1]);
  for (const p of parents) {
    const child = cart.lines.find(l => l.parentLineId === p.remoteLineId);
    assert.equal(child.quantity, p.quantity);
    assert.equal(p.attributes.find(a => a.key === FULL_SIZE_CONFIGURATION_KEY).value, fullSizeConfiguration(optionsFromAttributes(child.attributes, 'full-size')));
  }
  const serviceAdds = f.requests.filter(r => r.variables.lines?.some(l => l.parent));
  assert.ok(serviceAdds.every(r => r.variables.lines.filter(l => l.parent).every(l => l.parent.lineId)));
});
test('full-size quantity synchronization, service-only split/removal and glove removal survive reload', async () => {
  const f = await fixture({ autoSyncChild: false }); let cart = await add(f);
  cart = await f.commerce.setLineQuantity(parent(cart).remoteLineId, 3);
  assert.equal(cart.lines.find(l => l.isBreakIn).quantity, 3);
  cart = await f.commerce.removeBreakIn(parent(cart).remoteLineId);
  assert.equal(cart.lines.find(l => l.isBreakIn).quantity, 2);
  assert.equal(cart.lines.filter(l => !l.isBreakIn).reduce((sum,l) => sum+l.quantity,0), 3);
  assert.equal(cart.incomplete, false);
  const serviced = cart.lines.find(l => !l.isBreakIn && l.serviceConfiguration === 'break-in');
  cart = await f.commerce.removeLine(serviced.remoteLineId);
  assert.equal(cart.lines.length, 1); assert.equal(cart.lines[0].serviceConfiguration, 'none');
  assert.deepEqual((await f.restore().getCart()).lines, cart.lines);
  cart = await add(f); cart = await f.commerce.removeBreakIn(cart.lines.find(l => !l.isBreakIn && l.serviceConfiguration === 'break-in').remoteLineId);
  assert.equal(cart.lines.filter(l => l.isBreakIn).length,0); assert.equal(cart.incomplete,false);
});
test('full-size service cannot be added from cart using trainer defaults', async () => {
  const f = await fixture(); const cart = await f.commerce.addProduct('full-mint', false, undefined, 'gid://variant/mi26-right');
  await assert.rejects(f.commerce.addBreakIn(parent(cart).remoteLineId), /instructions/);
  await assert.rejects(f.commerce.addProduct('full-mint', true, undefined, 'gid://variant/mi26-right'), /instructions|glove type/);
});
test('missing full-size selections never mutate Shopify and do not validate service when unselected', async () => {
  const f = await fixture();
  for (const selected of [{ type: 'full-size' }, { ...options, closure: '' }, { ...options, wearingStyle: 'Other — describe your finger placement' }]) {
    await assert.rejects(add(f, selected));
  }
  assert.equal(f.requests.filter(r => /mutation/.test(r.query)).length,0);
  await f.commerce.addProduct('full-mint', false, {}, 'gid://variant/mi26-right');
});
test('wrong service type/variant, parent, quantity, duplicate or missing instructions block checkout', async () => {
  const f = await fixture(); const cart = await add(f);
  for (const change of [
    c => { c.lines.find(l=>l.isBreakIn).serviceType='trainer'; },
    c => { c.lines.find(l=>l.isBreakIn).merchandiseId='gid://variant/old'; },
    c => { parent(c).attributes.push({key:'_anawin_break_in_level',value:'Medium (65%)'}); },
    c => { parent(c).attributes.push({key:'Finger Placement',value:'stale'}); c.lines.find(l=>l.isBreakIn).attributes.push({key:'Finger Placement',value:'stale'}); },
    c => { c.lines.find(l=>l.isBreakIn).parentLineId='missing'; },
    c => { c.lines.find(l=>l.isBreakIn).quantity=9; },
    c => { c.lines.find(l=>l.isBreakIn).attributes=[]; },
    c => { parent(c).attributes.push({ key: 'Firmness', value:'Medium' }); }
  ]) { const bad=structuredClone(cart);change(bad);assert.equal(checkoutCartIsComplete(bad),false); }
  f.lines.find(l=>l.parentRelationship).merchandise.id='gid://variant/wrong';
  assert.equal((await f.commerce.getCart()).incomplete,true);
});
test('partial full-size additions block checkout, retain old items, never retry and recover safely', async () => {
  const f=await fixture();await f.commerce.addProduct('black',true);await add(f);
  f.failNextMutation(2);
  await assert.rejects(add(f,{...options,firmness:'Firm'}));
  const unsafe=await f.commerce.getCart();assert.equal(unsafe.incomplete,true);
  assert.equal(unsafe.lines.filter(l=>l.productId==='black').length,2);
  assert.equal(unsafe.lines.filter(l=>!l.isBreakIn).reduce((sum,l)=>sum+l.quantity,0),3);
  const recovered=await f.restore().recoverCart();assert.equal(recovered.incomplete,false);
  assert.equal(recovered.lines.filter(l=>!l.isBreakIn).reduce((sum,l)=>sum+l.quantity,0),2);
});
test('full-size API rejection and ambiguous completed mutations do not report success or retry', async () => {
  const f=await fixture();await add(f);f.setUserError('Unavailable');
  await assert.rejects(add(f),/Unavailable/);f.setUserError('');
  f.failAfterNextMutation(); await assert.rejects(add(f),/uncertain/);
  assert.equal((await f.restore().getCart()).incomplete,true);
});
test('known partially created carts remain available for review rather than being lost',async()=>{
  const f=await fixture();f.partialUserErrorNextMutation();await assert.rejects(add(f),/reported errors/);
  const cart=await f.commerce.getCart();assert.ok(cart.id);assert.equal(cart.incomplete,true);
});
test('checkout verification uses fresh Shopify checkout URL after full-size mutations', async () => {
  const f=await fixture();const displayed=await add(f);const current={...displayed,checkoutUrl:'https://ignvv0-zh.myshopify.com/checkouts/current?key=fresh'};
  const verify=createCheckoutVerifier({getCart:async()=>current,readSafety:()=>({id:current.id,revision:'1'})});
  const result=await verify(displayed);assert.equal(result.status,'ready');
  let url;assert.equal(redirectToVerifiedCheckout(result.cart.checkoutUrl,value=>{url=value}),true);assert.equal(url,current.checkoutUrl);
});

test('full-size service reference and price mismatches fail closed while glove-only purchases work', async () => {
  const { createShopifyCommerce } = await import('../src/commerce.js');
  for (const alter of [
    p => { p.id = 'gid://shopify/Product/old'; },
    p => { p.variants.nodes[0].id = 'gid://shopify/ProductVariant/old'; },
    p => { p.variants.nodes[0].price.amount = '20'; },
    p => { p.variants.nodes[0].availableForSale = false; }
  ]) {
    const f = shopifyFixture({ fullSize: true });
    const commerce = createShopifyCommerce(f.config, f.storage, async (url, request) => {
      const response = await f.fetchImpl(url, request); const payload = await response.json();
      if (JSON.parse(request.body).variables.handle === 'full-size-glove-break-in-service') alter(payload.data.product);
      return { ok: true, json: async () => payload };
    });
    await commerce.listProducts(); assert.equal((await commerce.getFullSizeBreakInService()).available, false);
    await assert.rejects(commerce.addProduct('full-mint', true, options, 'gid://variant/mi26-right'), /not currently available/);
    assert.equal((await commerce.addProduct('full-mint', false, undefined, 'gid://variant/mi26-right')).incomplete, false);
  }
});

test('an available left-hand variant remains purchasable when the right-hand variant is unavailable', async () => {
  const { createShopifyCommerce } = await import('../src/commerce.js');
  const f = shopifyFixture({ fullSize: true });
  const commerce = createShopifyCommerce(f.config, f.storage, async (url, request) => {
    const response = await f.fetchImpl(url, request); const payload = await response.json();
    if (JSON.parse(request.body).variables.handle === 'mi26') payload.data.product.variants.nodes[0].availableForSale = false;
    return { ok: true, json: async () => payload };
  });
  await commerce.listProducts(); await commerce.getFullSizeBreakInService();
  const cart = await commerce.addProduct('full-mint', true, options, 'gid://variant/mi26-left');
  assert.equal(parent(cart).merchandiseId, 'gid://variant/mi26-left'); assert.equal(cart.incomplete, false);
  await assert.rejects(commerce.addProduct('full-mint', false, undefined, 'gid://variant/mi26-right'), /available throw hand/);
});

test('silent service omission is not success and can recover only the verified prior cart without deleting originals', async () => {
  for (const existing of [false, true]) {
    const f = await fixture();
    if (existing) await f.commerce.addProduct('black', true);
    let omitted = false;
    f.observeQueries(({ lines }) => {
      const index = lines.findIndex(line => line.parentRelationship && line.merchandise.id === FULL_SIZE_SERVICE_VARIANT);
      if (!omitted && index >= 0) { lines.splice(index, 1); omitted = true; }
    });
    await assert.rejects(add(f), /did not preserve/);
    const unsafe = await f.commerce.getCart(); assert.equal(unsafe.incomplete, true); assert.equal(unsafe.recoveryAvailable, true);
    const originalLines = f.lines;
    const originalSnapshot = structuredClone(originalLines);
    const recovered = await f.commerce.recoverCart(); assert.equal(recovered.incomplete, false);
    assert.equal(recovered.lines.length, existing ? 2 : 0);
    assert.deepEqual(originalLines, originalSnapshot);
    assert.deepEqual(originalLines.filter(line => line.merchandise.product.handle === 'br16').map(line => line.quantity), existing ? [1] : []);
  }
});

test('missing or unsupported shaping choices identify the invalid field and never mutate Shopify', async () => {
  const f = await fixture();
  for (const field of FULL_SIZE_SHAPING_FIELDS) {
    for (const value of [undefined, '', 'No preference', ['Straight', 'Flared']]) {
      const selected = { ...options, [field.key]: value };
      assert.throws(() => normalizeFullSizeOptions(selected), error => error.field === field.name);
      await assert.rejects(add(f, selected));
    }
  }
  assert.equal(f.requests.filter(request => request.query.includes('mutation')).length, 0);
  const plain = await f.commerce.addProduct('full-mint', false, {}, 'gid://variant/mi26-right');
  assert.equal(plain.incomplete, false);
  assert.ok(!plain.lines[0].attributes.some(attribute => FULL_SIZE_SHAPING_FIELDS.some(field => field.attribute === attribute.key)));
});

test('all independent thumb/pinky combinations preserve None and recommendations through Shopify and reload', async () => {
  const f = await fixture();
  for (const thumbShape of FULL_SIZE_SHAPING_FIELDS[0].choices) {
    for (const pinkyShape of FULL_SIZE_SHAPING_FIELDS[1].choices) {
      const selected = { ...options, thumbShape, pinkyShape, fingerShape: 'Recommend for me', closure: 'Recommend for me' };
      const normalized = normalizeFullSizeOptions(selected);
      assert.equal(normalized.thumbShape, thumbShape); assert.equal(normalized.pinkyShape, pinkyShape);
      await add(f, selected);
    }
  }
  const cart = await f.restore().getCart();
  assert.equal(cart.incomplete, false); assert.equal(cart.lines.length, 32);
  const combinations = new Set();
  for (const glove of cart.lines.filter(line => !line.isBreakIn)) {
    const child = cart.lines.find(line => line.parentLineId === glove.remoteLineId);
    const selected = optionsFromAttributes(child.attributes, 'full-size');
    combinations.add(`${selected.thumbShape}/${selected.pinkyShape}`);
    assert.equal(selected.closure, 'Recommend for me'); assert.equal(selected.fingerShape, 'Recommend for me');
    for (const attribute of serviceAttributes(selected)) assert.deepEqual(child.attributes.find(item => item.key === attribute.key), attribute);
    assert.equal(child.merchandiseId, FULL_SIZE_SERVICE_VARIANT);
  }
  assert.equal(combinations.size, 16);
});

test('changing only one shaping instruction keeps identical glove variants separate, including repeated additions', async () => {
  const f = await fixture();
  await add(f);
  for (const field of FULL_SIZE_SHAPING_FIELDS) await add(f, { ...options, [field.key]: 'Recommend for me' });
  const cart = await add(f);
  const gloves = cart.lines.filter(line => !line.isBreakIn);
  assert.equal(gloves.length, 4); assert.deepEqual(gloves.map(line => line.quantity), [2, 1, 1, 1]);
  assert.equal(new Set(gloves.map(line => line.merchandiseId)).size, 1);
  assert.equal((await f.restore().getCart()).incomplete, false);
});

test('None and Recommend for me are serialized literally only on the linked service', async () => {
  const f = await fixture();
  const selected = { ...options, thumbShape: 'None', pinkyShape: 'Recommend for me', fingerShape: 'Recommend for me', closure: 'Recommend for me' };
  const cart = await add(f, selected, 'left');
  const mutation = f.requests.find(request => request.query.includes('CreateCart'));
  assert.ok(mutation.variables.input.lines[0].attributes.every(attribute => attribute.key.startsWith('_')));
  for (const line of mutation.variables.input.lines.filter(line => line.parent)) {
    for (const [key, value] of [['Thumb Shape', 'None'], ['Pinky Shape', 'Recommend for me'], ['Finger Shape', 'Recommend for me'], ['Thumb Closure', 'Recommend for me'], ['Throwing Hand', 'Left']]) {
      assert.deepEqual(line.attributes.find(attribute => attribute.key === key), { key, value });
    }
  }
  assert.equal(cart.lines.find(line => line.isBreakIn).parentLineId, parent(cart).remoteLineId);
});

test('missing, duplicated or mismatched shaping instructions block checkout without inventing defaults', async () => {
  const f = await fixture(); const cart = await add(f);
  for (const field of FULL_SIZE_SHAPING_FIELDS) {
    for (const lineIndex of [1]) {
      const missing = structuredClone(cart);
      missing.lines[lineIndex].attributes = missing.lines[lineIndex].attributes.filter(attribute => attribute.key !== field.attribute);
      assert.equal(checkoutCartIsComplete(missing), false);
      const duplicate = structuredClone(cart);
      duplicate.lines[lineIndex].attributes.push({ key: field.attribute, value: 'Recommend for me' });
      assert.equal(checkoutCartIsComplete(duplicate), false);
    }
  }
});

test('quantity changes cannot clear an unresolved full-size addition and unblock checkout', async () => {
  const f = await fixture(); const original = await add(f);
  f.failAfterNextMutation();
  await assert.rejects(f.commerce.addProduct('full-black', true, options, 'gid://variant/bl50-right'), /uncertain/);
  const unsafe = await f.commerce.getCart(); assert.equal(unsafe.incomplete, true);
  const count = f.requests.filter(request => request.query.includes('mutation')).length;
  await assert.rejects(f.commerce.setLineQuantity(parent(original).remoteLineId, 2), /incomplete/);
  assert.equal(f.requests.filter(request => request.query.includes('mutation')).length, count);
  assert.equal((await f.commerce.getCart()).incomplete, true);
});

test('a partial cartCreate response cannot replace a cart activated in another tab', async () => {
  const f = await fixture();
  f.partialUserErrorNextMutation(); const delayed = f.delayNextMutationResponse();
  const addition = add(f); await delayed;
  f.storage.setItem('anawin-shopify-cart-id', 'gid://cart/another-tab');
  f.releaseDelayedMutation();
  await assert.rejects(addition, error => error.code === 'cart-changed');
  assert.equal(f.storage.getItem('anawin-shopify-cart-id'), 'gid://cart/another-tab');
});

test('removing a full-size glove detects unchanged or wrong removals and blocks checkout', async () => {
  for (const wrongRemoval of [false, true]) {
    const f = await fixture();
    const first = await f.commerce.addProduct('full-mint', false, undefined, 'gid://variant/mi26-right');
    await f.commerce.addProduct('black', false);
    f.observeMutations(({ field, variables }) => {
      if (field === 'cartLinesRemove') variables.lineIds = wrongRemoval ? [f.lines.find(line => line.merchandise.product.handle === 'br16').id] : [];
    });
    await assert.rejects(f.commerce.removeLine(parent(first).remoteLineId), /remove|preserve/);
    assert.equal((await f.commerce.getCart()).incomplete, true);
  }
});

test('full-size quantity changes resolve refreshed parent and child IDs by the exact instructions', async () => {
  for (const autoSyncChild of [true, false]) {
    const f = await fixture({ rekeyOnQuantityUpdate: true, autoSyncChild });
    await add(f, { ...options, thumbShape: 'None', pinkyShape: 'Recommend for me' });
    const before = await add(f, { ...options, thumbShape: 'Flared', pinkyShape: 'None' });
    const target = parent(before);
    const after = await f.commerce.setLineQuantity(target.remoteLineId, 3);
    assert.equal(after.incomplete, false);
    const gloves = after.lines.filter(line => !line.isBreakIn);
    assert.deepEqual(gloves.map(line => line.quantity), [3, 1]);
    for (const glove of gloves) {
      const child = after.lines.find(line => line.parentLineId === glove.remoteLineId);
      assert.equal(child.quantity, glove.quantity);
      assert.equal(optionsFromAttributes(child.attributes, 'full-size').thumbShape, glove.quantity === 3 ? 'None' : 'Flared');
    }
    assert.deepEqual((await f.restore().getCart()).lines, after.lines);
  }
});

test('a partial new cart containing only unrecognized lines is retained and blocked for review', async () => {
  const { createShopifyCommerce } = await import('../src/commerce.js');
  const f = shopifyFixture({ fullSize: true });
  const commerce = createShopifyCommerce(f.config, f.storage, async (url, request) => {
    const response = await f.fetchImpl(url, request); const payload = await response.json();
    if (payload.data.cartCreate) {
      payload.data.cartCreate.userErrors = [{ message: 'Unknown transformed lines' }];
      for (const line of payload.data.cartCreate.cart.lines.nodes) {
        line.merchandise.product.handle = 'unrecognized'; line.parentRelationship = null;
      }
    }
    return { ok: true, json: async () => payload };
  });
  await commerce.listProducts(); await commerce.getFullSizeBreakInService();
  await assert.rejects(commerce.addProduct('full-mint', true, options, 'gid://variant/mi26-right'), /reported errors/);
  assert.ok(f.storage.getItem('anawin-shopify-cart-id'));
  assert.equal((await commerce.getCart()).incomplete, true);
  await assert.rejects(commerce.addProduct('full-mint', true, options, 'gid://variant/mi26-right'), /incomplete/);
});

test('every supported full-size selection serializes literally onto only its service and survives reload', async () => {
  const fields = [
    ['wearingStyle', fullSizeBreakInService.wearingStyles], ['closure', fullSizeBreakInService.closurePoints],
    ...FULL_SIZE_SHAPING_FIELDS.map(field => [field.key, field.choices]), ['firmness', fullSizeBreakInService.firmness]
  ];
  for (const [key, values] of fields) for (const value of values) {
    const f = await fixture();
    const selected = { ...options, [key]: value, placement: '  Custom placement  ', notes: '  <b>Keep these instructions</b>  ' };
    const cart = await add(f, selected, 'left');
    const glove = parent(cart); const child = cart.lines.find(line => line.parentLineId === glove.remoteLineId);
    assert.equal(optionsFromAttributes(child.attributes, 'full-size')[key], value);
    for (const attribute of serviceAttributes(selected)) {
      assert.equal(glove.attributes.find(item => item.key === attribute.key), undefined);
      assert.deepEqual(child.attributes.find(item => item.key === attribute.key), attribute);
    }
    assert.ok(glove.attributes.every(attribute => attribute.key.startsWith('_')));
    for (const line of [child]) {
      assert.equal(line.attributes.find(item => item.key === 'Glove Model').value, 'MI26');
      assert.equal(line.attributes.find(item => item.key === 'Throwing Hand').value, 'Left');
    }
    assert.deepEqual((await f.restore().getCart()).lines, cart.lines);
  }
});

test('removing only service rejects changes to another glove’s shaping instructions', async () => {
  const f = await fixture(); const first = await add(f);
  await add(f, { ...options, thumbShape: 'None' });
  f.observeMutations(({ field }) => {
    if (field !== 'cartLinesRemove') return;
    const otherChild = f.lines.find(line => line.parentRelationship && line.attributes.some(attribute => attribute.key === 'Thumb Shape' && attribute.value === 'None'));
    for (const line of [otherChild]) {
      line.attributes.find(attribute => attribute.key === 'Firmness').value = 'Firm';
    }
  });
  await assert.rejects(f.commerce.removeBreakIn(parent(first).remoteLineId), /unexpected|did not remove only/);
  assert.equal((await f.commerce.getCart()).incomplete, true);
  const mutations = f.requests.filter(request => /mutation/.test(request.query)).length;
  await assert.rejects(f.restore().recoverCart(), /differs from the last verified cart|Only glove-only recovery/);
  assert.equal(f.requests.filter(request => /mutation/.test(request.query)).length, mutations);
});

test('service-only layout binds choices to a private identity and the purchased variant, failing closed on tampering', async () => {
  const f = await fixture(); const cart = await add(f, options, 'left');
  const glove = parent(cart), child = cart.lines.find(line => line.parentLineId === glove.remoteLineId);
  assert.deepEqual(glove.attributes.map(attribute => attribute.key).sort(), ['_anawin_configuration', '_anawin_service', '_anawin_service_type']);
  assert.equal(glove.throwingHand, 'Left');
  assert.equal(child.attributes.find(attribute => attribute.key === 'Throwing Hand').value, 'Left');
  for (const change of [
    c => c.lines.find(line => line.isBreakIn).attributes.find(a => a.key === 'Thumb Shape').value = 'None',
    c => c.lines.find(line => line.isBreakIn).attributes.find(a => a.key === 'Throwing Hand').value = 'Right',
    c => c.lines.find(line => line.isBreakIn).attributes.find(a => a.key === 'Glove Model').value = 'BL50',
    c => parent(c).throwingHand = 'Right',
    c => parent(c).attributes = parent(c).attributes.filter(a => a.key !== FULL_SIZE_CONFIGURATION_KEY),
    c => parent(c).attributes.push({ key: FULL_SIZE_CONFIGURATION_KEY, value: fullSizeConfiguration(options) }),
    c => parent(c).attributes.push({ key: 'Notes', value: 'Should be on service only' })
  ]) {
    const changed = structuredClone(cart); change(changed); assert.equal(checkoutCartIsComplete(changed), false);
  }
  f.lines.find(line => line.parentRelationship).attributes.find(a => a.key === 'Firmness').value = 'Firm';
  const count = f.requests.filter(request => /mutation/.test(request.query)).length;
  assert.equal((await f.restore().getCart()).incomplete, true);
  assert.equal(f.requests.filter(request => /mutation/.test(request.query)).length, count);
});

test('different notes and placements separate identical variants; equivalent trimmed choices merge only their own pair', async () => {
  const f = await fixture();
  const a = { ...options, wearingStyle: 'Other — describe your finger placement', placement: 'Placement A', notes: 'Notes A ⚾' };
  const b = { ...a, placement: 'Placement B', notes: 'Notes B' };
  await add(f, a, 'left'); await add(f, b, 'left');
  const cart = await add(f, { ...a, placement: ' Placement A ', notes: ' Notes A ⚾ ' }, 'left');
  assert.deepEqual(cart.lines.filter(line => !line.isBreakIn).map(line => line.quantity), [2, 1]);
  const signatures = new Set();
  for (const glove of cart.lines.filter(line => !line.isBreakIn)) {
    const child = cart.lines.find(line => line.parentLineId === glove.remoteLineId);
    assert.equal(child.quantity, glove.quantity);
    signatures.add(glove.attributes.find(a => a.key === FULL_SIZE_CONFIGURATION_KEY).value);
    assert.equal(optionsFromAttributes(child.attributes, 'full-size').notes, glove.quantity === 2 ? a.notes : b.notes);
  }
  assert.equal(signatures.size, 2);
  assert.deepEqual((await f.restore().getCart()).lines, cart.lines);
});

test('recovery preserves separate full-size service-only instructions and fingerprints without replaying the uncertain addition', async () => {
  const f = await fixture(); await add(f, { ...options, notes: 'First glove' }, 'left');
  const before = await add(f, { ...options, thumbShape: 'None', notes: 'Second glove' }, 'left');
  f.failNextMutation(2); await assert.rejects(add(f, { ...options, firmness: 'Firm', notes: 'Unconfirmed third' }, 'left'));
  const originalId = before.id;
  const recovered = await f.restore().recoverCart();
  assert.notEqual(recovered.id, originalId); assert.equal(recovered.incomplete, false); assert.equal(recovered.lines.length, 4);
  for (const glove of recovered.lines.filter(line => !line.isBreakIn)) {
    const child = recovered.lines.find(line => line.parentLineId === glove.remoteLineId);
    assert.ok(glove.attributes.every(a => a.key.startsWith('_')));
    assert.equal(glove.attributes.find(a => a.key === FULL_SIZE_CONFIGURATION_KEY).value, fullSizeConfiguration(optionsFromAttributes(child.attributes, 'full-size')));
    assert.ok(['First glove', 'Second glove'].includes(child.attributes.find(a => a.key === 'Notes').value));
  }
});

test('previously saved duplicated-layout full-size carts remain readable without rewriting their attributes', async () => {
  const f = await fixture(); await add(f, options, 'left');
  const glove = f.lines.find(line => !line.parentRelationship), child = f.lines.find(line => line.parentRelationship);
  glove.attributes = [{ key: '_anawin_service', value: 'break-in' }, { key: '_anawin_service_type', value: 'full-size' }, ...structuredClone(child.attributes)];
  const old = structuredClone(glove.attributes), count = f.requests.filter(request => /mutation/.test(request.query)).length;
  const cart = await f.restore().getCart(); assert.equal(cart.incomplete, false); assert.deepEqual(parent(cart).attributes, old);
  assert.equal(f.requests.filter(request => /mutation/.test(request.query)).length, count);
});

test('legacy pending recovery snapshots without variant metadata remain recoverable without altering their saved instructions', async () => {
  const f = await fixture(); await add(f, options, 'left');
  const rawParent = f.lines.find(line => !line.parentRelationship), rawChild = f.lines.find(line => line.parentRelationship);
  rawParent.attributes = [{ key: '_anawin_service', value: 'break-in' }, { key: '_anawin_service_type', value: 'full-size' }, ...structuredClone(rawChild.attributes)];
  const before = await f.commerce.getCart();
  const historical = { id: before.id, lines: before.lines.map(({ throwingHand, ...line }) => line), discountCodes: before.discountCodes };
  f.storage.setItem('anawin-shopify-unsafe-cart-id', before.id);
  f.storage.setItem('anawin-shopify-pending-mutation', JSON.stringify({ cartId: before.id, status: 'unresolved', kind: 'quantity update', kinds: ['quantity update'], before: historical }));
  rawParent.quantity = 2;
  assert.equal((await f.restore().getCart()).incomplete, true);
  const recovered = await f.restore().recoverCart();
  assert.equal(recovered.incomplete, false); assert.equal(parent(recovered).throwingHand, 'Left');
  assert.deepEqual(recovered.lines.find(line => line.isBreakIn).attributes, before.lines.find(line => line.isBreakIn).attributes);
});
