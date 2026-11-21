import { createShopifyCommerce } from '../src/commerce.js';
import { FULL_SIZE_SERVICE_VARIANT, FULL_SIZE_SERVICE_PRODUCT, fullSizeProducts } from '../src/catalog.js';

// By default each full-size glove carries the catalog's approved estimate, as production must.
const launchMetafields = Object.fromEntries(fullSizeProducts.map(product => [product.name.toLowerCase(), product.preorder.shipEstimate]));
const assert = { match(value, pattern) { if (!pattern.test(value)) throw new Error(`Fixture query mismatch: ${pattern}`); } };
class MemoryStorage {
  constructor(initial = {}) { this.values = new Map(Object.entries(initial)); }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
}
export function shopifyFixture({ autoSyncChild = true, rekeyOnAttributeUpdate = false, rekeyOnAdd = false,
  rekeyOnQuantityUpdate = false, prices = {}, cartPrices = {}, discountedPrices = {}, currencies = {},
  subtotalOverride = null, discountCodes = [], discountApplications = [], discountAllocations = {},
  discountScenario = null, discountWarnings = [], serviceState = 'available', serviceHandle = 'break-in', timeoutMs,
  recoveryLocks = undefined, fullSize = false, stock: initialStock = {}, checkoutHost = 'store.myshopify.com',
  cartAttributesMode = 'replace', metafields = launchMetafields } = {}) {
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
  const locks = recoveryLocks === undefined ? { request(_name, options, callback) {
    const action = callback || options;
    if (options?.ifAvailable && (exclusiveHeld || sharedHolders || lockQueue.length)) {
      return Promise.resolve().then(() => action(null));
    }
    return new Promise((resolve, reject) => {
      lockQueue.push({ mode: options?.mode || 'exclusive', action, resolve, reject });
      drainLocks();
    });
  } } : recoveryLocks;
  const requests = [];
  let lines = [];
  let recoveryLines = null;
  let recoveryCartId = null;
  let nextCartId = 2;
  let nextId = 1;
  let cartExists = false;
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
  const response = data => ({ ok: true, json: async () => ({ data }) });
  const snapshot = (id = 'gid://cart/1') => {
    const cartLines = id === recoveryCartId ? recoveryLines : lines;
    const state = discountScenario?.(discountCodes.map(item => item.code)) || {};
    const currentPrices = state.discountedPrices || discountedPrices;
    const currentAllocations = state.discountAllocations || discountAllocations;
    return ({
    id, checkoutUrl: `https://${checkoutHost}/checkouts/${id.split('/').at(-1)}`, attributes: structuredClone(cartAttributes),
    discountCodes: structuredClone(state.discountCodes || discountCodes), discountApplications: structuredClone(state.discountApplications || discountApplications),
    cost: { subtotalAmount: { amount: String(state.subtotalOverride ?? subtotalOverride ?? cartLines.reduce((sum, line) =>
      sum + line.quantity * Number(finalUnitPrice(line.merchandise.product.handle, currentPrices)), 0)), currencyCode: 'USD' } },
    lines: { nodes: structuredClone(cartLines).map(line => ({ ...line,
      allDiscountAllocations: structuredClone(currentAllocations[line.merchandise.product.handle] || []),
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
  const add = (inputs, targetLines = lines) => {
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
    }
  };
  const mergeEquivalentParents = (targetLines = lines) => {
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
  const rekeyLines = (targetLines = lines) => {
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
        variants: { nodes: [{ id, selectedOptions: variables.handle === 'cm24' ? [{ name: 'Title', value: 'Default Title' }] : [{ name: 'Throwing Hand', value: 'Right' }], availableForSale: variables.handle !== 'break-in' || serviceState !== 'sold-out', price: { amount: variables.handle === 'break-in' && serviceState === 'invalid-price' ? 'bad' : amount, currencyCode: currencies[variables.handle] || 'USD' } }, ...(['mi26', 'bl50', 'or17'].includes(variables.handle) ? [{ id: id.replace('-right', '-left'), availableForSale: true, selectedOptions: [{ name: 'Throwing Hand', value: 'Left' }], price: { amount, currencyCode: 'USD' } }] : [])] }
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
      queryObserver?.({ variables, lines: variables.id === recoveryCartId ? recoveryLines : lines, storage });
      return response({ cart: cartExists ? snapshot(variables.id) : null });
    }
    if (apiError) return { ok: false, status: 503 };
    const field = query.includes('CreateCart') ? 'cartCreate' : query.includes('AddLines') ? 'cartLinesAdd' :
      query.includes('UpdateLines') ? 'cartLinesUpdate' : query.includes('UpdateDiscountCodes') ? 'cartDiscountCodesUpdate' :
      query.includes('UpdateCartAttributes') ? 'cartAttributesUpdate' : 'cartLinesRemove';
    mutationCount++;
    mutationWarnings = [];
    mutationObserver?.({ field, variables, storage });
    if (rejectStatusAt === mutationCount) return { ok: false, status: 422 };
    if (delayMutationAt === mutationCount) {
      signalDelayed?.();
      await new Promise(resolve => { releaseDelayed = resolve; });
    }
    if (failMutationAt === mutationCount) return response({ [field]: { userErrors: [{ message: 'Partial mutation failed' }], cart: snapshot() } });
    if (userError) return response({ [field]: { userErrors: [{ message: userError }], cart: snapshot() } });
    if (field === 'cartDiscountCodesUpdate') {
      discountCodes = variables.discountCodes.map(code => ({ code, applicable: true }));
    } else if (field === 'cartAttributesUpdate') {
      const incoming = structuredClone(variables.attributes);
      cartAttributes = cartAttributesMode === 'merge'
        ? [...cartAttributes.filter(attribute => !incoming.some(item => item.key === attribute.key)), ...incoming]
        : incoming;
    } else if (field === 'cartCreate' || field === 'cartLinesAdd') {
      if (field === 'cartCreate' && expiredCart) {
        recoveryCartId = `gid://cart/${nextCartId++}`;
        recoveryLines = [];
        add(variables.input.lines, recoveryLines);
        expiredCart = false;
      } else if (field === 'cartCreate' && cartExists) {
        recoveryCartId = `gid://cart/${nextCartId++}`;
        recoveryLines = [];
        add(variables.input.lines, recoveryLines);
      } else {
        add(field === 'cartCreate' ? variables.input.lines : variables.lines,
          variables.cartId === recoveryCartId ? recoveryLines : lines);
      }
      cartExists = true;
      if (rekeyOnAdd && variables.cartId !== recoveryCartId) rekeyLines();
    } else if (field === 'cartLinesUpdate') {
      const targetLines = variables.cartId === recoveryCartId ? recoveryLines : lines;
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
      const targetLines = variables.cartId === recoveryCartId ? recoveryLines : lines;
      targetLines.splice(0, targetLines.length, ...targetLines.filter(line => !variables.lineIds.includes(line.id) && !variables.lineIds.includes(line.parentRelationship?.parent.id)));
    }
    if (failAfterMutationAt === mutationCount) return { ok: false, status: 503 };
    if (delayResponseAfterAt === mutationCount) {
      signalDelayed?.();
      await new Promise(resolve => { releaseDelayed = resolve; });
    }
    if (userErrorAfterMutationAt === mutationCount) return response({ [field]: { userErrors: [{ message: 'Partial Shopify error' }],
      cart: snapshot(field === 'cartCreate' ? recoveryCartId || 'gid://cart/1' : variables.cartId || 'gid://cart/1') } });
    const payload = { userErrors: [], warnings: field === 'cartDiscountCodesUpdate' ? discountWarnings : mutationWarnings,
      cart: snapshot(field === 'cartCreate' ? recoveryCartId || 'gid://cart/1' : variables.cartId || 'gid://cart/1') };
    if (responseTransform) { const transform = responseTransform; responseTransform = null; transform(payload, field); }
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
  return { commerce, config, fetchImpl, storage, requests, restore: () => createShopifyCommerce(config, storage, fetchImpl, locks),
    get lines() { return storage.getItem('anawin-shopify-cart-id') === recoveryCartId ? recoveryLines : lines; },
    get cartAttributes() { return structuredClone(cartAttributes); },
    setCartAttributes(value) { cartAttributes = structuredClone(value); },
    setUserError(value) { userError = value; }, setApiError(value) { apiError = value; },
    setStock(handle, quantity) { stock[handle] = quantity; },
    transformNextMutationResponse(transform) { responseTransform = transform; },
    failNextMutation(offset = 1) { failMutationAt = mutationCount + offset; },
    failAfterNextMutation(offset = 1) { failAfterMutationAt = mutationCount + offset; },
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
    expireCart() { cartExists = false; lines = []; recoveryCartId = null; recoveryLines = null; expiredCart = true; } };
}
