import test from 'node:test';
import assert from 'node:assert/strict';
import { createShopifyCommerce, UNSAFE_RECORD_PREFIX } from '../src/commerce.js';
import { shopifyFixture } from '../test-support/shopify-fixture.js';

const ACTIVE = 'anawin-shopify-cart-id';
const REVISION = 'anawin-shopify-cart-revision';
const journals = fixture => [...fixture.storage.values].filter(([key]) => key.startsWith(UNSAFE_RECORD_PREFIX));
const writes = fixture => fixture.requests.filter(({ query }) => query.startsWith('mutation'));
const answer = envelope => ({ ok: true, status: 200, json: async () => envelope });
const consent = shown => ({ abandonUnknown: true, binding: shown.abandonmentBinding });

function intercept(fixture, hook) {
  return createShopifyCommerce(fixture.config, fixture.storage, async (url, options) => {
    const request = JSON.parse(options.body);
    return hook(request, () => fixture.fetchImpl(url, options));
  }, fixture.locks);
}

async function paired(autoSyncChild = false) {
  const fixture = shopifyFixture({ autoSyncChild });
  await fixture.commerce.listProducts();
  await fixture.commerce.addProduct('black', true);
  const shown = await fixture.commerce.addProduct('blue', false);
  const parent = shown.lines.find(line => line.productId === 'black' && !line.isBreakIn);
  return { fixture, shown, parent };
}

async function assertBlocked(fixture, shown, expectedWrites, expectedJournal) {
  const reloaded = fixture.restore();
  assert.equal(writes(fixture).length, expectedWrites);
  const current = journals(fixture);
  assert.equal(current.length, 1);
  assert.notEqual(JSON.parse(current[0][1]).status, 'terminal');
  if (expectedJournal) assert.deepEqual(current, expectedJournal);
  assert.equal(fixture.storage.getItem(ACTIVE), shown.id || null);
  let navigations = 0;
  assert.equal((await reloaded.checkout(shown, {}, () => navigations++)).status, 'blocked');
  await assert.rejects(reloaded.applyDiscountCode('SAVE'), { code: 'cart-unresolved' });
  assert.equal(navigations, 0);
  assert.equal(writes(fixture).length, expectedWrites);
  assert.deepEqual(journals(fixture), current);
}

const readFaults = {
  'unrelated quantity': ({ unrelated }) => unrelated.quantity++,
  'unrelated identity': ({ unrelated }) => { unrelated.id += '-different'; },
  'unrelated attributes': ({ unrelated }) => unrelated.attributes.push({ key: 'extra', value: 'unrequested' }),
  'wrong child identity': ({ child }) => { child.id += '-different'; },
  'excess child quantity': ({ child }) => { child.quantity = 4; },
  'changed Break-In Level': ({ child }) => { child.attributes.find(a => a.key === 'Break-In Level').value = 'Unrequested'; },
  'wrong parent': ({ child, unrelated }) => { child.parentRelationship.parent = { id: unrelated.id, merchandise: unrelated.merchandise }; },
  'unexpected service child': ({ raw, child, unrelated }) => {
    const extra = structuredClone(child);
    extra.id += '-unexpected';
    extra.parentRelationship.parent = { id: unrelated.id, merchandise: unrelated.merchandise };
    raw.lines.nodes.push(extra);
  },
  'duplicate service child': ({ raw, child }) => raw.lines.nodes.push({ ...structuredClone(child), id: child.id + '-duplicate' }),
  'wrong merchandise': ({ parent }) => { parent.merchandise.id = 'gid://variant/wrong'; },
  'wrong throwing hand': ({ parent }) => { parent.merchandise.selectedOptions = [{ name: 'Throwing Hand', value: 'Left' }]; },
  'changed discounts': ({ raw }) => raw.discountCodes.push({ code: 'UNREQUESTED', applicable: true }),
  'changed cart attributes': ({ raw }) => raw.attributes.push({ key: 'note', value: 'unrequested' })
};
for (const [label, fault] of Object.entries(readFaults)) {
  test(`paired quantity rejects ${label} before a continuation can dispatch`, async () => {
    const { fixture, shown, parent } = await paired();
    const initial = writes(fixture).length;
    let reads = 0;
    const tab = intercept(fixture, async ({ query }, forward) => {
      const response = await forward();
      if (!query.startsWith('query Cart(') || writes(fixture).length !== initial + 1) return response;
      const envelope = await response.json();
      const raw = envelope.data.cart;
      const [glove, child, unrelated] = raw.lines.nodes;
      assert.ok(child.parentRelationship);
      fault({ raw, parent: glove, child, unrelated });
      reads++;
      return answer(envelope);
    });
    const result = await Promise.allSettled([tab.setLineQuantity(parent.remoteLineId, 2)]);
    assert.ok(reads);
    assert.equal(writes(fixture).length - initial, 1, 'only the initial parent mutation is allowed');
    assert.equal(result[0].status, 'rejected');
    assert.deepEqual(fixture.cartLines(shown.id).map(line => line.quantity), [2, 1, 1]);
    await assertBlocked(fixture, shown, initial + 1);
  });
}
for (const autoSync of [false, true]) {
  test(`paired quantity accepts a legitimate ${autoSync ? 'synchronized' : 'intermediate'} pair`, async () => {
    const { fixture, shown, parent } = await paired(autoSync);
    const initial = writes(fixture).length;
    const result = await fixture.commerce.setLineQuantity(parent.remoteLineId, 2);
    assert.equal(result.incomplete, false);
    assert.deepEqual(fixture.cartLines(shown.id).map(line => line.quantity), [2, 2, 1]);
    assert.equal(writes(fixture).length - initial, autoSync ? 1 : 2);
    assert.deepEqual(journals(fixture), []);
    let navigations = 0;
    assert.equal((await fixture.commerce.checkout(result, {}, () => navigations++)).status, 'navigating');
    assert.equal(navigations, 1);
  });
}

for (const field of ['owner', 'step']) {
  test(`paired quantity refuses a replaced ${field} between steps`, async () => {
    const { fixture, shown, parent } = await paired();
    const initial = writes(fixture).length;
    let foreign;
    const tab = intercept(fixture, async ({ query }, forward) => {
      const response = await forward();
      if (!foreign && query.startsWith('query Cart(') && writes(fixture).length === initial + 1) {
        const [[key, raw]] = journals(fixture);
        const record = JSON.parse(raw);
        if (field === 'owner') record.owner = 'foreign';
        else record.step.n++;
        foreign = [[key, JSON.stringify(record)]];
        fixture.storage.setItem(...foreign[0]);
      }
      return response;
    });
    await assert.rejects(tab.setLineQuantity(parent.remoteLineId, 2));
    await assertBlocked(fixture, shown, initial + 1, foreign);
    assert.deepEqual(fixture.cartLines(shown.id).map(line => line.quantity), [2, 1, 1]);
  });
}

test('an interrupted legitimate intermediate cannot authorize a later operation after reload', async () => {
  const { fixture, shown, parent } = await paired();
  const initial = writes(fixture).length;
  fixture.failAfterNextMutation();
  await assert.rejects(fixture.commerce.setLineQuantity(parent.remoteLineId, 2));
  assert.deepEqual(fixture.cartLines(shown.id).map(line => line.quantity), [2, 1, 1]);
  await assertBlocked(fixture, shown, initial + 1);
});

for (const timing of ['revision', 'arm write', 'arm readback', 'rollback']) {
  test(`arm preserves foreign bytes during ${timing}`, async () => {
    const fixture = shopifyFixture();
    await fixture.commerce.listProducts();
    const storage = fixture.storage;
    const set = storage.setItem.bind(storage);
    const get = storage.getItem.bind(storage);
    const foreign = JSON.stringify({ cartId: '*', owner: 'foreign', status: 'unresolved', dispatched: true });
    let key; let phase = 'initial';
    storage.setItem = (name, value) => {
      set(name, value);
      if (name === REVISION && timing === 'revision' && phase === 'initial') {
        [[key]] = journals(fixture);
        set(key, foreign);
        phase = 'replaced';
      }
      if (name.startsWith(UNSAFE_RECORD_PREFIX) && JSON.parse(value).status === 'armed' && phase === 'initial') {
        key = name;
        if (timing === 'arm write') {
          set(key, foreign);
          phase = 'replaced';
        } else if (timing !== 'revision') phase = 'armed';
      }
    };
    storage.getItem = name => {
      if (name === key && phase === 'armed') {
        if (timing === 'rollback') {
          phase = 'failed readback';
          throw new Error('arm readback failed');
        }
        set(key, foreign);
        phase = 'replaced';
      } else if (name === key && phase === 'failed readback') {
        set(key, foreign);
        phase = 'replaced';
      }
      return get(name);
    };
    await assert.rejects(fixture.commerce.addProduct('black', false));
    assert.equal(writes(fixture).length, 0);
    assert.equal(get(key) === foreign, true, 'foreign record bytes must survive');
    await assert.rejects(fixture.restore().addProduct('black', false), { code: 'create-unresolved' });
    assert.equal(writes(fixture).length, 0);
  });
}

test('failed arm safely retires its own prepared record when the exact armed bytes are still present', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  const storage = fixture.storage;
  const get = storage.getItem.bind(storage);
  let failed = false;
  storage.getItem = key => {
    const raw = get(key);
    if (!failed && key.startsWith(UNSAFE_RECORD_PREFIX) && raw && JSON.parse(raw).status === 'armed') {
      failed = true;
      throw new Error('arm readback failed');
    }
    return raw;
  };
  await assert.rejects(fixture.commerce.addProduct('black', false), { code: 'storage-unavailable' });
  assert.ok(failed);
  assert.deepEqual(journals(fixture), []);
  assert.equal(writes(fixture).length, 0);
  await fixture.commerce.addProduct('black', false);
  assert.equal(writes(fixture).length, 1);
});

test('owned rollback cannot clean up a record replaced before outer retirement', async () => {
  const fixture = shopifyFixture();
  await fixture.commerce.listProducts();
  const storage = fixture.storage;
  const get = storage.getItem.bind(storage);
  const set = storage.setItem.bind(storage);
  const foreign = JSON.stringify({ cartId: '*', owner: 'foreign', status: 'unresolved', dispatched: true });
  let ownerKey;
  let phase = 'initial';
  storage.getItem = key => {
    const raw = get(key);
    if (!key.startsWith(UNSAFE_RECORD_PREFIX) || !raw) return raw;
    const { status } = JSON.parse(raw);
    if (phase === 'initial' && status === 'armed') {
      ownerKey = key;
      phase = 'arm readback failed';
      throw new Error('arm readback failed');
    }
    if (key === ownerKey && status === 'prepared' && phase === 'arm readback failed') phase = 'restored';
    else if (key === ownerKey && phase === 'restored') {
      set(key, foreign);
      return foreign;
    }
    return raw;
  };
  await assert.rejects(fixture.commerce.addProduct('black', false), { code: 'storage-unavailable' });
  assert.equal(phase, 'restored');
  assert.equal(get(ownerKey) === foreign, true);
  assert.equal(writes(fixture).length, 0);
  await assert.rejects(fixture.restore().addProduct('black', false), { code: 'create-unresolved' });
  assert.equal(writes(fixture).length, 0);
});

async function createUnknown(fixture, body = true, product = 'black') {
  fixture.faultAfterSave({ status: 422, body });
  await assert.rejects(fixture.commerce.addProduct(product, false), { code: 'uncertain-create' });
  return fixture.commerce.getCart();
}

function invalidCandidate(fixture, duringRead = () => {}) {
  return intercept(fixture, async ({ query }, forward) => {
    const response = await forward();
    if (!query.startsWith('query Cart(')) return response;
    const envelope = await response.json();
    duringRead();
    if (envelope.data.cart) envelope.data.cart.cost.subtotalAmount.amount = '0x1';
    return answer(envelope);
  });
}

for (const scenario of ['replacement candidate', 'changed journal bytes', 'changed pointer', 'replacement ID-less attempt', 'change during read']) {
  test(`abandonment refuses stale consent after ${scenario}`, async () => {
    const fixture = shopifyFixture();
    await fixture.commerce.listProducts();
    const idless = scenario === 'replacement ID-less attempt';
    const shown = await createUnknown(fixture, !idless);
    const modify = () => {
      const [key, raw] = journals(fixture).find(([, value]) => JSON.parse(value).status !== 'terminal');
      fixture.storage.setItem(key, JSON.stringify({ ...JSON.parse(raw), auditChange: true }));
    };
    let tab = invalidCandidate(fixture);
    if (scenario === 'replacement candidate' || idless) {
      await tab.startNewCart(consent(shown));
      await createUnknown(fixture, !idless, 'blue');
    } else if (scenario === 'changed journal bytes') modify();
    else if (scenario === 'changed pointer') {
      const id = Object.keys(fixture.savedCarts())[0];
      fixture.storage.setItem(ACTIVE, id);
      fixture.expireCart();
    } else tab = invalidCandidate(fixture, modify);
    const before = [...fixture.storage.values];
    const count = writes(fixture).length;
    const result = await Promise.allSettled([tab.startNewCart(consent(shown))]);
    assert.equal(result[0].status, 'rejected');
    assert.equal(result[0].reason.code, 'cart-changed');
    if (scenario === 'change during read') {
      const [key, raw] = journals(fixture)[0];
      const prior = new Map(before);
      assert.equal(JSON.stringify({ ...JSON.parse(prior.get(key)), auditChange: true }) === raw, true);
      prior.set(key, raw);
      assert.deepEqual([...fixture.storage.values], [...prior]);
    } else assert.deepEqual([...fixture.storage.values], before);
    assert.equal(writes(fixture).length, count);
  });
}

for (const body of [true, false]) {
  test(`freshly displayed ${body ? 'invalid candidate' : 'ID-less attempt'} can be explicitly abandoned without a write`, async () => {
    const fixture = shopifyFixture();
    await fixture.commerce.listProducts();
    const shown = await createUnknown(fixture, body);
    const [id] = Object.keys(fixture.savedCarts());
    if (body) await assert.rejects(fixture.restore().startNewCart(consent(shown)), { code: 'create-reconcile-required' });
    assert.equal((await invalidCandidate(fixture).startNewCart(consent(shown))).unconfirmedCreate, undefined);
    const record = JSON.parse(journals(fixture)[0][1]);
    assert.equal(record.resolution, 'abandoned');
    assert.equal(record.abandonedCartId === id, body);
    assert.deepEqual(fixture.cartLines(id).map(line => line.quantity), [1]);
    assert.equal(writes(fixture).length, 1);
    assert.equal(fixture.storage.getItem(ACTIVE), null);
  });
}


test('paired recovery will not attach paid service when the parent-only candidate changed cart attributes', async () => {
  const { fixture, shown } = await paired();
  assert.equal((await fixture.commerce.checkout(shown, {}, () => {})).status, 'navigating');
  const source = journals(fixture);
  const initial = writes(fixture).length;
  const recovery = intercept(fixture, async ({ query, variables }, forward) => {
    const response = await forward();
    if (!query.startsWith('query Cart(') || variables.id === shown.id) return response;
    const envelope = await response.json();
    envelope.data.cart.attributes.push({ key: 'note', value: 'unrequested' });
    return answer(envelope);
  });
  const result = await Promise.allSettled([recovery.recoverCart()]);
  assert.equal(writes(fixture).length - initial, 1, 'only the recovery create is allowed');
  assert.equal(result[0].status, 'rejected');
  const [candidate] = Object.keys(fixture.savedCarts()).filter(id => id !== shown.id);
  assert.equal(fixture.cartLines(candidate).length, 2);
  assert.equal(fixture.cartLines(candidate).some(line => line.parentRelationship), false);
  assert.equal(fixture.storage.getItem(ACTIVE) === shown.id, true);
  const journal = journals(fixture);
  assert.equal(journal.some(([key, raw]) => key === source[0][0] && raw === source[0][1]), true);
  assert.equal(journal.some(([, raw]) => JSON.parse(raw).recovery?.candidateCartId === candidate), true);
  let navigations = 0;
  assert.equal((await fixture.restore().checkout(shown, {}, () => navigations++)).status, 'blocked');
  assert.equal(navigations, 0);
  assert.equal(writes(fixture).length, initial + 1);
  assert.deepEqual(journals(fixture), journal);
});
