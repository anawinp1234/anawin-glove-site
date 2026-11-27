import { createShopifyCommerce } from '../src/commerce.js';
import { FULL_SIZE_SERVICE_VARIANT, FULL_SIZE_SERVICE_PRODUCT, fullSizeProducts } from '../src/catalog.js';

// By default each full-size glove carries the catalog's approved estimate, as production must.
const launchMetafields = Object.fromEntries(fullSizeProducts.map(product => [product.name.toLowerCase(), product.preorder.shipEstimate]));
const assert = { match(value, pattern) { if (!pattern.test(value)) throw new Error(`Fixture query mismatch: ${pattern}`); } };
// A Web Locks model for one browser profile: shared and exclusive holders, a FIFO queue and ifAvailable.
export function createLockManager() {
  let sharedHolders = 0;
  let exclusiveHeld = false;
  const lockQueue = [];
  const drainLocks = () => {
    if (exclusiveHeld) return;
    while (lockQueue.length) {
      const next = lockQueue[0];
      if (next.mode !== 'shared' && sharedHolders) return;
      lockQueue.shift();
      if (next.mode === 'shared') sharedHolders++;
      else exclusiveHeld = true;
      const release = () => {
        if (next.mode === 'shared') sharedHolders--;
        else exclusiveHeld = false;
        drainLocks();
      };
      Promise.resolve().then(() => next.action({})).then(
        value => { release(); next.resolve(value); },
        error => { release(); next.reject(error); }
      );
      if (exclusiveHeld) return;
    }
  };
  return {
    get held() { return exclusiveHeld || sharedHolders > 0; },
    get queued() { return lockQueue.length; },
    request(_name, options, callback) {
      const action = callback || options;
      if (options?.ifAvailable && (exclusiveHeld || sharedHolders || lockQueue.length)) {
        return Promise.resolve().then(() => action(null));
      }
      return new Promise((resolve, reject) => {
        lockQueue.push({ mode: options?.mode || 'exclusive', action, resolve, reject });
        drainLocks();
      });
    }
  };
}
class MemoryStorage {
  constructor(initial = {}) { this.values = new Map(Object.entries(initial)); }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
}
// A production-shaped Storefront cart ID (`gid://shopify/Cart/<token>?key=<secret>`) for fixture cart `n`.
export const cartGid = n => `gid://shopify/Cart/c${n}?key=k${n}`;
// The recovery-attempt binding the drawer shows for the current cart: a fresh recovery attempt is consent for exactly it.
export const recoveryBindingOf = async fixture => {
  const reader = fixture.restore();
  return (await reader.getCart().catch(() => ({}))).recoveryBinding;
};
const PAGE_LIMIT = 50;
export function shopifyFixture({ autoSyncChild = true, rekeyOnAttributeUpdate = false, rekeyOnAdd = false,
  rekeyOnQuantityUpdate = false, prices = {}, cartPrices = {}, discountedPrices = {}, currencies = {},
  subtotalOverride = null, discountCodes = [], discountApplications = [], discountAllocations = {},
  discountScenario = null, discountWarnings = [], serviceState = 'available', serviceHandle = 'break-in', timeoutMs,
  recoveryLocks = undefined, fullSize = false, stock: initialStock = {}, checkoutHost = 'ignvv0-zh.myshopify.com',
  cartAttributesMode = 'replace', metafields = launchMetafields, pageSize = PAGE_LIMIT, cartIdFor = cartGid } = {}) {
  // Cart-level attributes. Shopify does not document whether cartAttributesUpdate replaces or merges, so both are modelled.
  let cartAttributes = [];
  const config = {
    domain: 'store.myshopify.com', accessToken: 'public-token', apiVersion: '2026-07',
    handles: { black: 'br16', blue: 'ob16', brown: 'cl16', ...(fullSize ? { 'full-mint': 'mi26', 'full-black': 'bl50', 'full-orange': 'or17', 'full-camel': 'cm24' } : {}) }, breakInHandle: serviceHandle, timeoutMs
  };
  const variants = {
    mi26: ['gid://variant/mi26-right', prices.mi26 || '295.00'], bl50: ['gid://variant/bl50-right', prices.bl50 || '295.00'], or17: ['gid://variant/or17-right', prices.or17 || '295.00'], cm24: ['gid://variant/cm24-right', prices.cm24 || '295.00'],
    'full-size-glove-break-in-service': [FULL_SIZE_SERVICE_VARIANT, '75.00'],
    br16: ['gid://variant/br16', prices.br16 || '155.00'], ob16: ['gid://variant/ob16', prices.ob16 || '155.00'],
    cl16: ['gid://variant/cl16', prices.cl16 || '155.00'], 'break-in': ['gid://variant/service', prices['break-in'] || '20.00']
  };
  const linePrice = handle => cartPrices[handle] || variants[handle][1];
  const finalUnitPrice = (handle, currentPrices = discountedPrices) => currentPrices[handle] || linePrice(handle);
  const storage = new MemoryStorage();
  const locks = recoveryLocks === undefined ? createLockManager() : recoveryLocks;
  const requests = [];
  // Every cart Shopify has saved, by its full ID: what the fixture really holds, whatever a response claims.
  const carts = new Map();
  const mainId = cartIdFor(1);
  let nextCartId = 2;
  let nextId = 1;
  let expiredCart = false;
  let userError = '';
  let apiError = false;
  let failMutationAt = 0;
  let failAfterMutationAt = 0;
  let userErrorAfterMutationAt = 0;
  let mutationCount = 0;
  let mutationObserver = null;
  let queryObserver = null;
  let rejectStatusAt = 0;
  let delayMutationAt = 0;
  let delayResponseAfterAt = 0;
  let releaseDelayed = null;
  let signalDelayed = null;
  // A response fault applied after Shopify saved the mutation: { at, status, body } or { at, kind: 'abort' | 'timeout' | 'lost' }.
  let savedFault = null;
  const response = data => ({ ok: true, status: 200, json: async () => ({ data }) });
  const linesOf = id => carts.get(id) || [];
  const typedApplication = application => ({ ...application,
    __typename: application.__typename || (application.code ? 'CartCodeDiscountApplication' : 'CartAutomaticDiscountApplication'),
    ...(!application.code && !application.title ? { title: 'Automatic discount' } : {}),
    value: application.value?.__typename === 'MoneyV2' && application.value.amount === undefined
      ? { ...application.value, amount: '30.00', currencyCode: 'USD' } : application.value });
  const typedAllocation = allocation => {
    const { sourceDiscountApplication, ...rest } = allocation;
    const code = allocation.code ?? sourceDiscountApplication?.code;
    return { ...rest, __typename: allocation.__typename || (code ? 'CartCodeDiscountAllocation' : 'CartAutomaticDiscountAllocation'),
      ...(code ? { code } : { title: allocation.title || 'Automatic discount' }) };
  };
  // One page of a saved cart. `after` is the previous page's endCursor (`cursor:<index>`).
  const snapshot = (id = mainId, after = null) => {
    const cartLines = linesOf(id);
    const state = discountScenario?.(discountCodes.map(item => item.code)) || {};
    const currentPrices = state.discountedPrices || discountedPrices;
    const currentAllocations = state.discountAllocations || discountAllocations;
    const start = after ? Number(String(after).slice('cursor:'.length)) : 0;
    const page = cartLines.slice(start, start + pageSize);
    const hasNextPage = start + pageSize < cartLines.length;
    return ({
    id, checkoutUrl: `https://${checkoutHost}/cart/c/${id.split('/').at(-1)}`, attributes: structuredClone(cartAttributes),
    discountCodes: structuredClone(state.discountCodes || discountCodes),
    discountApplications: structuredClone(state.discountApplications || discountApplications).map(typedApplication),
    cost: { subtotalAmount: { amount: String(state.subtotalOverride ?? subtotalOverride ?? cartLines.reduce((sum, line) =>
      sum + line.quantity * Number(finalUnitPrice(line.merchandise.product.handle, currentPrices)), 0)), currencyCode: 'USD' } },
    lines: { pageInfo: { hasNextPage, endCursor: page.length ? `cursor:${start + page.length}` : null }, nodes: structuredClone(page).map(line => ({ ...line,
      allDiscountAllocations: structuredClone(currentAllocations[line.merchandise.product.handle] || []).map(typedAllocation),
      cost: { amountPerQuantity: {
      amount: linePrice(line.merchandise.product.handle),
      currencyCode: currencies[line.merchandise.product.handle] || 'USD'
    }, subtotalAmount: {
      amount: String(line.quantity * Number(linePrice(line.merchandise.product.handle))),
      currencyCode: currencies[line.merchandise.product.handle] || 'USD'
    }, totalAmount: {
      amount: String(line.quantity * Number(finalUnitPrice(line.merchandise.product.handle, currentPrices))),
      currencyCode: currencies[line.merchandise.product.handle] || 'USD'
    } } })) }
  });
  };
  const makeLine = (handle, quantity, parent = null, attributes = [], merchandiseId = null) => ({
    id: `line-${nextId++}`, quantity,
    attributes: structuredClone(attributes),
    instructions: { canRemove: true, canUpdateQuantity: true },
    parentRelationship: parent ? { parent: { id: parent.id, merchandise: structuredClone(parent.merchandise) } } : null,
    merchandise: { id: merchandiseId || variants[handle][0], selectedOptions: ['mi26', 'bl50', 'or17'].includes(handle) ? [{ name: 'Throwing Hand', value: (merchandiseId || variants[handle][0]).endsWith('-left') ? 'Left' : 'Right' }] : [{ name: 'Title', value: 'Default Title' }], product: { handle } }
  });
  const attributeSignature = attributes => JSON.stringify([...attributes].sort((a, b) =>
    a.key.localeCompare(b.key) || a.value.localeCompare(b.value)));
  // Like Shopify, a glove line is held at the available quantity and the line gets a stock warning.
  const stock = { ...initialStock };
  let mutationWarnings = [];
  // Lets a test rewrite the next successful mutation payload (for example, a warning's target line).
  let responseTransform = null;
  const capQuantity = (line, requested, targetLines) => {
    const limit = line.parentRelationship ? undefined : stock[line.merchandise.product.handle];
    if (limit === undefined) return requested;
    const others = targetLines.filter(other => other !== line && !other.parentRelationship &&
      other.merchandise.product.handle === line.merchandise.product.handle).reduce((sum, other) => sum + other.quantity, 0);
    const allowed = Math.max(0, limit - others);
    if (requested <= allowed) return requested;
    mutationWarnings.push({ code: 'MERCHANDISE_NOT_ENOUGH_STOCK', message: `Only ${allowed} items were added to your cart due to availability.`, target: line.id });
    return allowed;
  };
  const add = (inputs, targetLines) => {
    for (const input of inputs) {
      if (input.parent) {
        const parent = targetLines.find(line => !line.parentRelationship &&
          (input.parent.lineId ? line.id === input.parent.lineId :
            line.merchandise.id === input.parent.merchandiseId &&
            line.attributes.some(attribute => attribute.key === '_anawin_service' && attribute.value === 'break-in')));
        if (!parent) throw new Error('Unknown parent cart line');
        const child = targetLines.find(line => line.parentRelationship?.parent.id === parent.id) ||
          makeLine(Object.keys(variants).find(key => variants[key][0] === input.merchandiseId), 0, parent, input.attributes || []);
        if (!targetLines.includes(child)) targetLines.push(child);
        child.quantity += input.quantity;
        continue;
      }
      const handle = Object.keys(variants).find(key => variants[key][0] === input.merchandiseId || variants[key][0].replace('-right', '-left') === input.merchandiseId);
      const existing = targetLines.find(line => line.merchandise.id === input.merchandiseId && !line.parentRelationship &&
        attributeSignature(line.attributes) === attributeSignature(input.attributes || []));
      const parent = existing || makeLine(handle, 0, null, input.attributes, input.merchandiseId);
      if (!existing) targetLines.push(parent);
      parent.quantity = capQuantity(parent, parent.quantity + input.quantity, targetLines);
      // Like Shopify, a line held at zero is not kept in the cart.
      if (!parent.quantity) targetLines.splice(targetLines.indexOf(parent), 1);
    }
  };
  const mergeEquivalentParents = targetLines => {
    for (const parent of [...targetLines.filter(line => !line.parentRelationship)]) {
      if (!targetLines.includes(parent)) continue;
      const equivalent = targetLines.find(line => line !== parent && !line.parentRelationship &&
        line.merchandise.id === parent.merchandise.id &&
        attributeSignature(line.attributes) === attributeSignature(parent.attributes));
      if (!equivalent) continue;
      const child = targetLines.find(line => line.parentRelationship?.parent.id === parent.id);
      const equivalentChild = targetLines.find(line => line.parentRelationship?.parent.id === equivalent.id);
      equivalent.quantity += parent.quantity;
      if (child) {
        if (equivalentChild) equivalentChild.quantity += child.quantity;
        else child.parentRelationship.parent.id = equivalent.id;
      }
      targetLines.splice(0, targetLines.length, ...targetLines.filter(line => line !== parent && (line !== child || !equivalentChild)));
    }
  };
  const rekeyLines = targetLines => {
    const parentIds = new Map();
    for (const line of targetLines.filter(line => !line.parentRelationship)) {
      const previousId = line.id;
      line.id = `line-${nextId++}`;
      parentIds.set(previousId, line.id);
    }
    for (const line of targetLines.filter(line => line.parentRelationship)) {
      line.id = `line-${nextId++}`;
      line.parentRelationship.parent.id = parentIds.get(line.parentRelationship.parent.id);
    }
  };
  // A fixed GraphQL "cart not found" answer for a mutation on a cart Shopify does not have.
  const missingCartReply = field => response({ [field]: { userErrors: [{ message: 'The specified cart does not exist.' }], cart: null } });
  const fetchImpl = async (url, options) => {
    assert.match(url, /\/api\/2026-07\/graphql\.json$/);
    const { query, variables } = JSON.parse(options.body);
    requests.push({ query, variables });
    if (query.includes('ProductByHandle')) {
      if (variables.handle === 'break-in' && serviceState === 'missing') return response({ product: null });
      if (variables.handle === 'break-in' && serviceState === 'failed') return { ok: false, status: 503 };
      const [id, amount] = variants[variables.handle];
      return response({ product: {
        id: variables.handle === 'full-size-glove-break-in-service' ? FULL_SIZE_SERVICE_PRODUCT : `gid://product/${variables.handle}`, title: variables.handle.toUpperCase(), handle: variables.handle,
        ...(Object.hasOwn(metafields, variables.handle) ? { preorderShipEstimate: metafields[variables.handle] === null ? null : { value: metafields[variables.handle] } } : {}),
        variants: { nodes: [{ id, selectedOptions: ['mi26', 'bl50', 'or17'].includes(variables.handle) ? [{ name: 'Throwing Hand', value: 'Right' }] : [{ name: 'Title', value: 'Default Title' }], availableForSale: variables.handle !== 'break-in' || serviceState !== 'sold-out', price: { amount: variables.handle === 'break-in' && serviceState === 'invalid-price' ? 'bad' : amount, currencyCode: currencies[variables.handle] || 'USD' } }, ...(['mi26', 'bl50', 'or17'].includes(variables.handle) ? [{ id: id.replace('-right', '-left'), availableForSale: true, selectedOptions: [{ name: 'Throwing Hand', value: 'Left' }], price: { amount, currencyCode: 'USD' } }] : [])] }
      } });
    }
    assert.match(query, /parentRelationship/);
    assert.match(query, /discountCodes \{ code applicable \}/);
    assert.match(query, /discountApplications \{/);
    assert.match(query, /subtotalAmount \{ amount currencyCode \} totalAmount \{ amount currencyCode \}/);
    assert.match(query, /discountAllocations\(lineLevelOnly: false\)/);
    assert.match(query, /attributes \{ key value \}/);
    assert.match(query, /canUpdateQuantity/);
    if (query.includes('query Cart(')) {
      queryObserver?.({ variables, lines: linesOf(variables.id), storage });
      // A query by an exact ID: only a saved cart under that exact ID exists.
      return response({ cart: carts.has(variables.id) ? snapshot(variables.id, variables.after ?? null) : null });
    }
    if (apiError) return { ok: false, status: 503 };
    const field = query.includes('CreateCart') ? 'cartCreate' : query.includes('AddLines') ? 'cartLinesAdd' :
      query.includes('UpdateLines') ? 'cartLinesUpdate' : query.includes('UpdateDiscountCodes') ? 'cartDiscountCodesUpdate' :
      query.includes('UpdateCartAttributes') ? 'cartAttributesUpdate' : query.includes('RemoveLines') ? 'cartLinesRemove' : null;
    // An unrecognized mutation is a fixture gap, never a silent removal.
    if (!field) throw new Error(`Fixture does not model this mutation: ${query.slice(0, 80)}`);
    mutationCount++;
    mutationWarnings = [];
    mutationObserver?.({ field, variables, storage });
    if (rejectStatusAt === mutationCount) return { ok: false, status: 422 };
    if (delayMutationAt === mutationCount) {
      signalDelayed?.();
      await new Promise(resolve => { releaseDelayed = resolve; });
    }
    const targetId = field === 'cartCreate' ? null : variables.cartId;
    if (targetId && !carts.has(targetId)) return missingCartReply(field);
    if (failMutationAt === mutationCount) return response({ [field]: { userErrors: [{ message: 'Partial mutation failed' }], cart: snapshot(targetId || mainId) } });
    if (userError) {
      const payload = { userErrors: [{ message: userError }], cart: snapshot(targetId || mainId) };
      if (responseTransform) { const transform = responseTransform; responseTransform = null; transform(payload, field); }
      return response({ [field]: payload });
    }
    let savedId = targetId;
    if (field === 'cartDiscountCodesUpdate') {
      discountCodes = variables.discountCodes.map(code => ({ code, applicable: true }));
    } else if (field === 'cartAttributesUpdate') {
      const incoming = structuredClone(variables.attributes);
      cartAttributes = cartAttributesMode === 'merge'
        ? [...cartAttributes.filter(attribute => !incoming.some(item => item.key === attribute.key)), ...incoming]
        : incoming;
    } else if (field === 'cartCreate') {
      // The first cart ever is cart 1; every later create (a recovery, or after expiry) gets a new ID.
      savedId = !carts.size && !expiredCart && nextCartId === 2 && !carts.has(mainId) ? mainId : cartIdFor(nextCartId++);
      expiredCart = false;
      carts.set(savedId, []);
      add(variables.input.lines, carts.get(savedId));
    } else if (field === 'cartLinesAdd') {
      add(variables.lines, carts.get(targetId));
      if (rekeyOnAdd && targetId === mainId) rekeyLines(carts.get(targetId));
    } else if (field === 'cartLinesUpdate') {
      const targetLines = carts.get(targetId);
      for (const update of variables.lines) {
        const line = targetLines.find(item => item.id === update.id);
        if (!line) throw new Error('Unknown cart line');
        if (update.quantity !== undefined) line.quantity = capQuantity(line, update.quantity, targetLines);
        if (update.attributes) {
          line.attributes = structuredClone(update.attributes);
          if (rekeyOnAttributeUpdate) {
            const oldId = line.id;
            line.id = `line-${nextId++}`;
            for (const child of targetLines) if (child.parentRelationship?.parent.id === oldId) child.parentRelationship.parent.id = line.id;
          }
          mergeEquivalentParents(targetLines);
        }
        if (autoSyncChild && update.quantity !== undefined && !line.parentRelationship) {
          const child = targetLines.find(item => item.parentRelationship?.parent.id === line.id);
          if (child) child.quantity = line.quantity;
        }
      }
      if (rekeyOnQuantityUpdate && variables.lines.some(line => line.quantity !== undefined)) rekeyLines(targetLines);
    } else {
      const targetLines = carts.get(targetId);
      targetLines.splice(0, targetLines.length, ...targetLines.filter(line => !variables.lineIds.includes(line.id) && !variables.lineIds.includes(line.parentRelationship?.parent.id)));
    }
    const replyId = savedId || mainId;
    if (failAfterMutationAt === mutationCount) return { ok: false, status: 503 };
    if (delayResponseAfterAt === mutationCount) {
      signalDelayed?.();
      await new Promise(resolve => { releaseDelayed = resolve; });
    }
    if (userErrorAfterMutationAt === mutationCount) return response({ [field]: { userErrors: [{ message: 'Partial Shopify error' }], cart: snapshot(replyId) } });
    const payload = { userErrors: [], warnings: field === 'cartDiscountCodesUpdate' ? discountWarnings : mutationWarnings, cart: snapshot(replyId) };
    if (responseTransform) { const transform = responseTransform; responseTransform = null; transform(payload, field); }
    if (savedFault?.at === mutationCount) {
      const fault = savedFault;
      savedFault = null;
      if (fault.kind === 'abort') throw new DOMException('The operation was aborted.', 'AbortError');
      if (fault.kind === 'lost') throw new TypeError('Failed to fetch');
      if (fault.kind === 'timeout') return new Promise(() => {});
      const body = { data: { [field]: payload } };
      return { ok: fault.status >= 200 && fault.status < 300, status: fault.status,
        json: fault.body ? async () => body : async () => { throw new SyntaxError('Unexpected end of JSON input'); } };
    }
    return response({ [field]: payload });
  };
  const shopify = createShopifyCommerce(config, storage, fetchImpl, locks);
  const commerce = {
    ...shopify,
    async listProducts() {
      const products = await shopify.listProducts();
      await shopify.getBreakInService();
      await shopify.getFullSizeBreakInService();
      return products;
    }
  };
  const loaded = tab => ({ ...tab, async listProducts() {
    const products = await tab.listProducts();
    await tab.getBreakInService();
    await tab.getFullSizeBreakInService();
    return products;
  } });
  const activeLines = () => {
    const active = storage.getItem('anawin-shopify-cart-id');
    if (carts.has(active)) return carts.get(active);
    // Reading before any cart exists must not create one.
    return carts.get(mainId) || [];
  };
  return { commerce, config, fetchImpl, storage, requests, locks, mainId, cartIdFor, restore: () => createShopifyCommerce(config, storage, fetchImpl, locks),
    // A writer the browser lock cannot coordinate (another device or profile, or a client that skips
    // the lock) but whose safety records this storage still sees: the journal's defence in depth.
    uncoordinated: () => loaded(createShopifyCommerce(config, storage, fetchImpl, createLockManager())),
    // A writer that shares the Shopify cart but neither this browser's lock nor its journal (an older
    // build, or a client that ignores the records). Only Shopify's answers can reveal its changes.
    detached: () => loaded(createShopifyCommerce(config, new MemoryStorage({ 'anawin-shopify-cart-id': storage.getItem('anawin-shopify-cart-id') }),
      fetchImpl, createLockManager())),
    // The active cart's saved lines (cart 1 when nothing is active), live for tests that edit Shopify's state.
    get lines() { return activeLines(); },
    // The lines Shopify holds for one cart ID, for servers whose own storage has no active cart.
    cartLines: (id = mainId) => structuredClone(linesOf(id)),
    // Every saved cart by ID, independent of what any response claimed.
    savedCarts: () => Object.fromEntries([...carts].map(([id, saved]) => [id, structuredClone(saved)])),
    get cartAttributes() { return structuredClone(cartAttributes); },
    get savedDiscountCodes() { return structuredClone(discountCodes); },
    setCartAttributes(value) { cartAttributes = structuredClone(value); },
    setUserError(value) { userError = value; }, setApiError(value) { apiError = value; },
    setStock(handle, quantity) { stock[handle] = quantity; },
    transformNextMutationResponse(transform) { responseTransform = transform; },
    failNextMutation(offset = 1) { failMutationAt = mutationCount + offset; },
    failAfterNextMutation(offset = 1) { failAfterMutationAt = mutationCount + offset; },
    // Shopify saves the mutation, then the response is replaced: an HTTP status with the original JSON body
    // (`body: true`) or with no usable body, an abort, a lost connection, or no answer at all.
    faultAfterSave({ offset = 1, status = 422, body = true, kind = null } = {}) { savedFault = { at: mutationCount + offset, status, body, kind }; },
    partialUserErrorNextMutation() { userErrorAfterMutationAt = mutationCount + 1; },
    rejectNextMutation() { rejectStatusAt = mutationCount + 1; },
    delayNextMutation() {
      delayMutationAt = mutationCount + 1;
      return new Promise(resolve => { signalDelayed = resolve; });
    },
    delayNextMutationResponse() {
      delayResponseAfterAt = mutationCount + 1;
      return new Promise(resolve => { signalDelayed = resolve; });
    },
    releaseDelayedMutation() { releaseDelayed?.(); },
    observeMutations(observer) { mutationObserver = observer; },
    observeQueries(observer) { queryObserver = observer; },
    expireCart() { carts.clear(); expiredCart = true; } };
}
