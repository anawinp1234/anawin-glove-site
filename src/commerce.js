import { fullSizeProducts, fullSizeBreakInService, preorderState, preorderOrderAttributeValue, PREORDER_ORDER_ATTRIBUTE, FULL_SIZE_SERVICE_HANDLE, FULL_SIZE_SERVICE_VARIANT, FULL_SIZE_SERVICE_PRODUCT, FULL_SIZE_CONFIGURATION_KEY, SERVICE_ATTRIBUTE_KEYS, optionsFromAttributes, breakInService, cartCustomizationIsComplete, savedBreakInOptions, DEFAULT_BREAK_IN, gloveServiceAttributes, localProducts, normalizeBreakInOptions, productHandleMap, serviceAttributes, WRIST_FIT_KEY, normalizeWristFit, withWristFit, wristFitOf, gloveModelCode } from './catalog.js';
import { codeKey, discountCodeList } from './cart-discounts.js';
import { createCheckoutVerifier, verifiedCheckoutUrl } from './checkout-safety.js';

const LOCAL_CART_KEY = 'anawin-cart';
const SHOPIFY_CART_KEY = 'anawin-shopify-cart-id';
const CART_REVISION_KEY = 'anawin-shopify-cart-revision';
const SERVICE_ATTRIBUTE = '_anawin_service';
const SERVICE_CHANGE_KINDS = { add: 'Break-In addition', remove: 'Break-In removal', change: 'Break-In change' };
const WRIST_FIT_CHANGE = 'wrist fit change';
const UNSAFE_CART_KEY = 'anawin-shopify-unsafe-cart-id';
const PENDING_MUTATION_KEY = 'anawin-shopify-pending-mutation';
const LEGACY_PENDING_ADD_KEY = 'anawin-shopify-pending-addition';
// One key per unresolved operation. Each is written whole by its owner and removed only by its owner
// (or by recovery), so no tab can overwrite or lift another tab's record.
export const UNSAFE_RECORD_PREFIX = 'anawin-shopify-unsafe-op:';
const REQUEST_TIMEOUT_MS = 10000;

function requestedQuantity(value) {
  const quantity = Number(value);
  if (!Number.isSafeInteger(quantity) || quantity < 0) throw new Error('Quantity must be a non-negative whole number.');
  return quantity;
}

function migratedQuantity(value) {
  const quantity = Number(value);
  return Number.isFinite(quantity) ? Math.max(0, Math.trunc(quantity)) : 0;
}

// Shopify's CartWarning codes for a line held below the requested quantity.
const STOCK_WARNING_CODES = ['MERCHANDISE_NOT_ENOUGH_STOCK', 'MERCHANDISE_OUT_OF_STOCK'];

export class ShopifyRequestError extends Error {
  constructor(message, code, cause) {
    super(message, { cause });
    this.name = 'ShopifyRequestError';
    this.code = code;
  }
}

export function commerceErrorMessage(error, action = 'connect') {
  if (error?.code === 'stock-limit') return error.message;
  if (error?.code === 'uncertain') return 'We could not confirm your cart update. Check your cart before trying again.';
  if (error?.code === 'uncertain-create') return 'We could not confirm the new cart. Check your cart, then try adding again.';
  if (error?.code === 'timeout') return 'Shopify is taking too long to respond. Please try again.';
  if (error?.code === 'network') return 'Connection lost. Check your connection and try again.';
  if (error?.code === 'cart-changed') return 'Your cart changed in another tab. Check your cart before trying again.';
  if (error?.code === 'recovery-lock-unavailable') return 'Safe cart recovery is unavailable in this browser. Try again in a browser that supports Web Locks.';
  if (error?.code === 'recovery-ambiguous') return 'Your cart has changes we cannot safely copy. Check the original cart and try again.';
  if (action === 'add') return 'Couldn’t add to cart. Please try again.';
  if (action === 'break-in') return 'Couldn’t add break-in service. Please try again.';
  if (action === 'cart') return 'Couldn’t update your cart. Please try again.';
  return 'Couldn’t connect to Shopify. Please try again.';
}

function emptyCart() {
  return { id: null, lines: [], subtotal: 0, currencyCode: 'USD', checkoutUrl: null };
}

export function migrateLocalCart(value) {
  if (!value || typeof value !== 'object') return { version: 2, items: {} };
  if (value.version === 2 && value.items && typeof value.items === 'object') return value;

  const items = {};
  for (const product of localProducts) {
    const quantity = migratedQuantity(value[product.id]);
    if (!quantity) continue;
    items[product.id] = {
      quantity,
      breakInQuantity: value[`breakin-${product.id}`] ? quantity : 0
    };
  }
  return { version: 2, items };
}

function localCartFromState(state) {
  const lines = [];
  let subtotal = 0;
  for (const product of localProducts) {
    const item = state.items[product.id];
    if (!item?.quantity) continue;
    lines.push({ productId: product.id, quantity: item.quantity, merchandiseId: null, attributes: withWristFit([], item.wristFit || 'regular') });
    subtotal += product.price * item.quantity;
    if (item.breakInQuantity) {
      lines.push({ productId: product.id, quantity: item.breakInQuantity, merchandiseId: null,
        isBreakIn: true, attributes: serviceAttributes(item.breakInOptions || DEFAULT_BREAK_IN) });
      subtotal += breakInService.price * item.breakInQuantity;
    }
  }
  return { ...emptyCart(), lines, subtotal };
}

function readLocalState(storage) {
  try {
    return migrateLocalCart(JSON.parse(storage?.getItem(LOCAL_CART_KEY) || '{}'));
  } catch {
    return migrateLocalCart({});
  }
}

export function createLocalCommerce(storage) {
  let state = readLocalState(storage);
  const save = () => storage?.setItem(LOCAL_CART_KEY, JSON.stringify(state));

  return {
    mode: 'local',
    async listProducts() { return localProducts; },
    async getBreakInService() { return breakInService; },
    async getCart() { return localCartFromState(state); },
    async addProduct(productId, includeBreakIn, options = DEFAULT_BREAK_IN, merchandiseId = null, wristFit = 'regular') {
      const current = state.items[productId] || { quantity: 0, breakInQuantity: 0 };
      current.quantity += 1;
      // The local cart keeps one entry per glove, so the latest wrist choice applies to all of them.
      current.wristFit = normalizeWristFit(wristFit);
      if (includeBreakIn) {
        current.breakInOptions = normalizeBreakInOptions(options);
        current.breakInQuantity = current.quantity;
      }
      state.items[productId] = current;
      save();
      return localCartFromState(state);
    },
    async setQuantity(productId, quantity) {
      const next = requestedQuantity(quantity);
      const current = state.items[productId];
      if (!current || !next) delete state.items[productId];
      else {
        current.quantity = next;
        if (current.breakInQuantity) current.breakInQuantity = next;
      }
      save();
      return localCartFromState(state);
    },
    async removeProduct(productId) {
      delete state.items[productId];
      save();
      return localCartFromState(state);
    }
  };
}

export function validateShopifyConfig(env = {}) {
  if ((env.VITE_COMMERCE_MODE || 'local') !== 'shopify') return null;
  const domain = (env.VITE_SHOPIFY_STORE_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const accessToken = env.VITE_SHOPIFY_STOREFRONT_TOKEN || '';
  const apiVersion = env.VITE_SHOPIFY_API_VERSION || '2026-07';
  const handles = { ...productHandleMap(env), ...Object.fromEntries(fullSizeProducts.filter(product => env[`VITE_SHOPIFY_${gloveModelCode(product.name)}_HANDLE`]).map(product => [product.id, env[`VITE_SHOPIFY_${gloveModelCode(product.name)}_HANDLE`]])) };
  const breakInHandle = env.VITE_SHOPIFY_BREAK_IN_HANDLE || '';
  const missingHandles = Object.entries(handles).filter(([, value]) => !value).map(([key]) => key);

  if (!domain.endsWith('.myshopify.com')) throw new Error('Shopify store domain must end in .myshopify.com.');
  if (!accessToken) throw new Error('Shopify public Storefront API token is missing.');
  if (!/^\d{4}-\d{2}$/.test(apiVersion)) throw new Error('Shopify API version must use YYYY-MM format.');
  if (missingHandles.length) throw new Error(`Shopify product handles are missing for: ${missingHandles.join(', ')}.`);
  return { domain, accessToken, apiVersion, handles, breakInHandle };
}

export async function shopifyRequest(config, query, variables = {}, fetchImpl = fetch) {
  const controller = new AbortController();
  let timer;
  let timedOut = false;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetchImpl(`https://${config.domain}/api/${config.apiVersion}/graphql.json`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Storefront-Access-Token': config.accessToken
          },
          body: JSON.stringify({ query, variables }),
          signal: controller.signal
        });
        if (!response.ok) throw new ShopifyRequestError(`Shopify request failed (${response.status}).`,
          [400, 401, 403, 404, 422, 429].includes(response.status) ? 'http-rejected' : 'http');
        const payload = await response.json();
        if (payload.errors?.length) throw new ShopifyRequestError(payload.errors.map(error => error.message).join(' '), 'graphql');
        return payload.data;
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new ShopifyRequestError('Shopify request timed out.', 'timeout'));
      }, config.timeoutMs ?? REQUEST_TIMEOUT_MS); })
    ]);
  } catch (error) {
    if (error instanceof ShopifyRequestError) throw error;
    throw new ShopifyRequestError(timedOut ? 'Shopify request timed out.' : 'Shopify network request failed.', timedOut ? 'timeout' : 'network', error);
  } finally {
    clearTimeout(timer);
  }
}

const PRODUCT_QUERY = `query ProductByHandle($handle: String!) {
  product(handle: $handle) {
    id title handle
    preorderShipEstimate: metafield(namespace: "custom", key: "preorder_ship_estimate") { value }
    variants(first: 20) { nodes { id availableForSale selectedOptions { name value } price { amount currencyCode } } }
  }
}`;

const CART_FIELDS = `
  id checkoutUrl
  attributes { key value }
  cost { subtotalAmount { amount currencyCode } }
  discountCodes { code applicable }
  discountApplications {
    ... on CartCodeDiscountApplication {
      code targetType
      value { __typename ... on PricingPercentageValue { percentage } }
    }
  }
  lines(first: 50) {
    pageInfo { hasNextPage }
    nodes {
      id quantity attributes { key value }
      cost { amountPerQuantity { amount currencyCode } subtotalAmount { amount currencyCode } totalAmount { amount currencyCode } }
      allDiscountAllocations: discountAllocations(lineLevelOnly: false) {
        discountedAmount { amount currencyCode }
        targetType
        sourceDiscountApplication { ... on CartCodeDiscountApplication { code } }
      }
      ... on CartLine {
        instructions { canRemove canUpdateQuantity }
        parentRelationship { parent { id merchandise { ... on ProductVariant { id selectedOptions { name value } product { handle } } } } }
      }
      merchandise { ... on ProductVariant { id selectedOptions { name value } product { handle } } }
    }
  }
`;

function assertCartPayload(payload) {
  const errors = payload.userErrors || [];
  if (errors.length) throw new Error(errors.map(error => error.message).join(' '));
  if (!payload.cart) throw new Error('Shopify did not return a cart.');
  return payload.cart;
}

export function cartUnitPrice(parent, service = null) {
  const glovePrice = parent?.unitPrice;
  if (!Number.isFinite(glovePrice?.amount) || glovePrice.amount < 0 || !glovePrice.currencyCode) return null;
  if (!service) return glovePrice;
  const servicePrice = service.unitPrice;
  if (!Number.isFinite(servicePrice?.amount) || servicePrice.amount < 0 ||
    glovePrice.currencyCode !== servicePrice.currencyCode) return null;
  return { amount: glovePrice.amount + servicePrice.amount, currencyCode: glovePrice.currencyCode };
}

export function cartEntryTotal(parent, service = null) {
  const gloveTotal = parent?.lineTotal;
  if (!Number.isFinite(gloveTotal?.amount) || gloveTotal.amount < 0 || !gloveTotal.currencyCode) return null;
  if (!service) return gloveTotal;
  const serviceTotal = service.lineTotal;
  if (!Number.isFinite(serviceTotal?.amount) || serviceTotal.amount < 0 ||
    gloveTotal.currencyCode !== serviceTotal.currencyCode) return null;
  return { amount: gloveTotal.amount + serviceTotal.amount, currencyCode: gloveTotal.currencyCode };
}

function normalizeMoney(value) {
  return {
    amount: value?.amount == null ? NaN : Number(value.amount),
    currencyCode: value?.currencyCode || null
  };
}

function normalizeAllocations(allocations) {
  return (allocations || []).map(allocation => ({
    amount: normalizeMoney(allocation.discountedAmount),
    targetType: allocation.targetType,
    code: allocation.sourceDiscountApplication?.code || null
  }));
}

function normalizeShopifyCart(cart, handleToProductId, breakInHandle) {
  if (!cart) return emptyCart();
  const lines = cart.lines.nodes.map(line => {
    const handle = line.merchandise.product.handle;
    const parentId = line.parentRelationship?.parent.id;
    const parentHandle = line.parentRelationship?.parent.merchandise.product.handle;
    const serviceType = handle === FULL_SIZE_SERVICE_HANDLE ? 'full-size' : handle === breakInHandle ? 'trainer' : null;
    return {
      remoteLineId: line.id,
      merchandiseId: line.merchandise.id,
      parentLineId: parentId || null,
      productId: serviceType ? handleToProductId[parentHandle] : handleToProductId[handle],
      quantity: line.quantity,
      throwingHand: line.merchandise.selectedOptions?.find(option => option.name === 'Throwing Hand')?.value ||
        (fullSizeProducts.find(product => product.id === handleToProductId[handle])?.throwHands.length === 1 ? 'Right' : null),
      unitPrice: normalizeMoney(line.cost?.amountPerQuantity),
      lineSubtotal: normalizeMoney(line.cost?.subtotalAmount),
      lineTotal: normalizeMoney(line.cost?.totalAmount),
      allDiscountAllocations: normalizeAllocations(line.allDiscountAllocations),
      isBreakIn: Boolean(serviceType),
      serviceType,
      attributes: line.attributes || [],
      serviceConfiguration: (line.attributes || []).find(attribute => attribute.key === SERVICE_ATTRIBUTE)?.value || null,
      instructions: line.instructions
    };
  }).filter(line => line.productId);
  const normalized = {
    id: cart.id,
    checkoutUrl: cart.checkoutUrl,
    attributes: (cart.attributes || []).map(({ key, value }) => ({ key, value })),
    subtotal: Number(cart.cost.subtotalAmount.amount),
    currencyCode: cart.cost.subtotalAmount.currencyCode,
    discountCodes: (cart.discountCodes || []).map(discount => ({ code: discount.code, applicable: discount.applicable === true })),
    discountApplications: (cart.discountApplications || []).filter(application => application.code).map(application => ({
      code: application.code,
      targetType: application.targetType,
      percentage: application.value?.__typename === 'PricingPercentageValue' ? application.value.percentage : null
    })),
    lineCoverageComplete: lines.length === cart.lines.nodes.length && !cart.lines.pageInfo?.hasNextPage,
    incomplete: lines.length !== cart.lines.nodes.length || Boolean(cart.lines.pageInfo?.hasNextPage),
    lines
  };
  normalized.incomplete ||= lines.some(line => line.serviceType === 'full-size' && line.merchandiseId !== FULL_SIZE_SERVICE_VARIANT);
  normalized.incomplete ||= !hasConsistentBreakInLines(normalized);
  normalized.incomplete ||= lines.some(parent => !parent.isBreakIn && !cartUnitPrice(parent,
    lines.find(child => child.isBreakIn && child.parentLineId === parent.remoteLineId)));
  normalized.incomplete ||= lines.some(parent => !parent.isBreakIn && !cartEntryTotal(parent,
    lines.find(child => child.isBreakIn && child.parentLineId === parent.remoteLineId)));
  return normalized;
}

function cartLineQuantity(cart, productId, isBreakIn) {
  return cart.lines.filter(line => line.productId === productId && line.isBreakIn === isBreakIn)
    .reduce((sum, line) => sum + line.quantity, 0);
}

function hasConsistentBreakInLines(cart) {
  return cartCustomizationIsComplete(cart.lines);
}

function canRecoverWithoutService(cart) {
  if (!cart.id || !cart.lineCoverageComplete || !cart.lines.some(line => line.isBreakIn)) return false;
  const parents = cart.lines.filter(line => !line.isBreakIn);
  const children = cart.lines.filter(line => line.isBreakIn);
  return parents.every(parent => {
    const service = parent.attributes.filter(attribute => attribute.key === SERVICE_ATTRIBUTE);
    const attached = children.filter(child => child.parentLineId === parent.remoteLineId);
    return service.length === 1 &&
      (service[0].value === 'none' && attached.length === 0 ||
        service[0].value === 'break-in' && attached.length === 1 &&
        attached[0].productId === parent.productId && attached[0].quantity === parent.quantity) &&
      cartUnitPrice(parent, attached[0]) && cartEntryTotal(parent, attached[0]);
  }) && children.every(child => parents.some(parent => parent.remoteLineId === child.parentLineId));
}

function withServiceAttribute(attributes, value, options = null) {
  const fullSize = attributes.some(attribute => attribute.key === '_anawin_service_type' && attribute.value === 'full-size');
  if (fullSize && value === 'break-in' && !options) return attributes;
  const preserved = attributes.filter(attribute => !SERVICE_ATTRIBUTE_KEYS.includes(attribute.key) &&
    !(fullSize && ['Glove Model', 'Throwing Hand'].includes(attribute.key)));
  if (value === 'none') return [...preserved, { key: SERVICE_ATTRIBUTE, value }];
  const prior = optionsFromAttributes(attributes);
  const selected = options || (prior.type === 'full-size' || prior.level && prior.wearingStyle ? prior : DEFAULT_BREAK_IN);
  return [...preserved, ...(value === 'break-in' ? gloveServiceAttributes(selected) : [{ key: SERVICE_ATTRIBUTE, value }])];
}

function matchingConfiguration(line, target, value, options = null) {
  return !line.isBreakIn && line.serviceConfiguration === value && line.merchandiseId === target.merchandiseId &&
    JSON.stringify([...line.attributes].sort((a, b) => a.key.localeCompare(b.key))) ===
    JSON.stringify(withServiceAttribute(target.attributes, value, options).sort((a, b) => a.key.localeCompare(b.key)));
}

function changedParent(before, after, target, value, excludeTarget = false, options = null) {
  const candidates = after.lines.filter(line => matchingConfiguration(line, target, value, options));
  const previousLines = before.lines.filter(line => matchingConfiguration(line, target, value, options) &&
    (!excludeTarget || line.remoteLineId !== target.remoteLineId));
  if (candidates.reduce((sum, line) => sum + line.quantity, 0) !==
    previousLines.reduce((sum, line) => sum + line.quantity, 0) + target.quantity) {
    throw new Error('Shopify changed the glove configuration quantity unexpectedly.');
  }
  const sameId = candidates.find(line => line.remoteLineId === target.remoteLineId);
  if (sameId) return sameId;
  if (candidates.length === 1) return candidates[0];
  const previous = new Map(previousLines.map(line => [line.remoteLineId, line.quantity]));
  const increased = candidates.filter(line => line.quantity - (previous.get(line.remoteLineId) || 0) === target.quantity);
  if (increased.length === 1) return increased[0];
  throw new Error('Shopify changed the glove lines ambiguously. Checkout is unavailable until the cart is corrected.');
}

export function createShopifyCommerce(config, storage, fetchImpl = fetch, recoveryLocks = globalThis.navigator?.locks) {
  let products = [];
  let breakInVariant = null;
  let fullSizeVariant = null;
  let fullSizeService = { ...fullSizeBreakInService, available: false };
  let remoteBreakInService = { ...breakInService, available: false };
  let lastVerifiedCart = null;
  // Unsafe marks this tab could not persist; they keep the cart blocked here even without storage.
  const unpersistedUnsafe = new Set();
  const ownPending = new Set();
  const activeOperations = new Set();
  const legacyRecordKeys = [PENDING_MUTATION_KEY, LEGACY_PENDING_ADD_KEY];
  const handleToProductId = Object.fromEntries(Object.entries(config.handles).map(([id, handle]) => [handle, id]));
  const request = (query, variables) => {
    if (/^mutation/.test(query)) for (const operation of activeOperations) {
      // An expired cart can be replaced within an add operation. Keep its pending
      // record relevant to the replacement before Shopify can create it.
      if (!operation.sent && lastVerifiedCart?.id === variables.cartId) {
        operation.record.before = lastVerifiedCart;
        storage.setItem(operation.key, JSON.stringify(operation.record));
      }
      if (query.includes('CreateCart')) {
        operation.record.cartId = '*';
        storage.setItem(operation.key, JSON.stringify(operation.record));
      }
      operation.sent++;
    }
    return shopifyRequest(config, query, variables, fetchImpl);
  };
  const announceCartChange = () => storage?.setItem(CART_REVISION_KEY, `${Date.now()}:${Math.random()}`);
  const storageKeys = () => {
    if (!storage || !Number.isInteger(storage.length) || typeof storage.key !== 'function') throw new Error('Cart storage is unavailable.');
    const keys = [];
    for (let index = 0; index < storage.length; index++) keys.push(storage.key(index));
    return keys;
  };
  // Every unresolved record that applies to a cart, read fresh from shared storage. Unreadable records
  // apply to whichever cart asks, and null (storage cannot be enumerated or read) means "assume unsafe".
  const unsafeRecords = (cartId, includeOwn = false) => {
    if (!storage) return null;
    try {
      const records = [];
      for (const key of storageKeys()) {
        if (!key?.startsWith(UNSAFE_RECORD_PREFIX) || !includeOwn && ownPending.has(key)) continue;
        let record = null;
        try { record = JSON.parse(storage.getItem(key)); } catch { /* treated as malformed below */ }
        if (!record || typeof record.cartId !== 'string') records.push({ key, malformed: true, kinds: ['cart change'] });
        else if (record.cartId === cartId || record.cartId === '*') records.push({ ...record, key });
      }
      for (const key of legacyRecordKeys) {
        const raw = storage.getItem(key);
        if (!raw) continue;
        let record = null;
        try { record = JSON.parse(raw); } catch { /* treated as malformed below */ }
        if (!record || typeof record.cartId !== 'string') records.push({ key, legacy: true, malformed: true, kinds: ['cart change'] });
        else if (record.cartId === cartId) records.push({ ...record, key, legacy: true });
      }
      return records;
    } catch { return null; }
  };
  const summaryMarks = cartId => { try { return storage?.getItem(UNSAFE_CART_KEY) === cartId; } catch { return true; } };
  // The combined unresolved state of a cart, or null when nothing is unresolved.
  const pendingFor = (cartId, includeOwn = false, ignorePending = false) => {
    if (!cartId) return null;
    let records = unsafeRecords(cartId, includeOwn);
    // Mutation validation may inspect an intermediate cart while operations are active.
    // Public reads and checkout safety always include those pending records.
    if (records && ignorePending) records = records.filter(record => record.status !== 'pending');
    if (records === null) return { cartId, kind: 'cart change', kinds: ['cart change'], before: null, status: 'unresolved' };
    if (!records.length && !summaryMarks(cartId) && !unpersistedUnsafe.has(cartId)) return null;
    const ordered = [...records].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const kinds = [...new Set(ordered.flatMap(record => Array.isArray(record.kinds) ? record.kinds : record.kind ? [record.kind] : []))];
    const before = ordered.find(record => record.before?.id === cartId && Array.isArray(record.before.lines))?.before || null;
    return { cartId, kind: ordered[0]?.kind || 'cart change', kinds, before, status: 'unresolved' };
  };
  const isUnsafe = cartId => Boolean(pendingFor(cartId));
  // Records the operation as unresolved and returns its token; only that token can lift this record.
  const markUnsafe = (cartId, kind = 'cart change', beforeOverride = null) => {
    if (!cartId || storage?.getItem(SHOPIFY_CART_KEY) !== cartId) return null;
    const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const record = { cartId, kind, kinds: [kind], status: 'unresolved', createdAt: Date.now(),
      before: beforeOverride?.id === cartId ? beforeOverride : lastVerifiedCart?.id === cartId ? lastVerifiedCart : null };
    try {
      storage.setItem(UNSAFE_RECORD_PREFIX + token, JSON.stringify(record));
    } catch {
      // Storage refused the write: keep the cart blocked in this tab rather than fail open.
      unpersistedUnsafe.add(cartId);
      return null;
    }
    return token;
  };
  const clearUnsafe = (cartId, token) => {
    if (!token || !storage) return;
    try {
      const key = UNSAFE_RECORD_PREFIX + token;
      const record = JSON.parse(storage.getItem(key) || 'null');
      if (record?.cartId !== cartId) return;
      storage.removeItem(key);
      // New operations use their own records exclusively. An existing shared summary
      // belongs to an older client or an unknown outcome; only recovery can retire it.
    } catch { /* Leave every mark in place. */ }
  };
  // Recovery moves the shopper to a new verified cart, which retires every record for the old cart.
  const retireUnsafeCart = cartId => {
    unpersistedUnsafe.delete(cartId);
    if (!storage) return;
    for (const record of unsafeRecords(cartId) || []) storage.removeItem(record.key);
    if (storage.getItem(UNSAFE_CART_KEY) === cartId) storage.removeItem(UNSAFE_CART_KEY);
  };
  const applySafety = (cart, mutation = true) => {
    if (cart.id && cart.incomplete && !pendingFor(cart.id, true) &&
      canRecoverWithoutService(cart)) markUnsafe(cart.id, 'service data unavailable');
    const pendingMutation = cart.id ? pendingFor(cart.id, !mutation, mutation) : null;
    if (cart.id && !cart.incomplete && !pendingMutation) {
      lastVerifiedCart = { id: cart.id, lines: cart.lines.map(line => ({
        remoteLineId: line.remoteLineId, parentLineId: line.parentLineId, merchandiseId: line.merchandiseId,
        productId: line.productId, isBreakIn: line.isBreakIn, serviceType: line.serviceType, quantity: line.quantity,
        attributes: line.attributes, throwingHand: line.throwingHand
      })), discountCodes: cart.discountCodes };
    }
    if (cart.id && pendingMutation) {
      const serviceDataUnavailable = pendingMutation?.kinds?.includes('service data unavailable');
      cart.recoveryAvailable = !serviceDataUnavailable && !pendingMutation?.kinds?.some(kind => kind.endsWith('validation failed')) &&
        (!cart.incomplete || pendingMutation?.before?.id === cart.id &&
          snapshotMatchesUnaffectedLines(cart, pendingMutation.before,
            pendingMutation.kinds || [pendingMutation.kind]));
      cart.gloveOnlyRecoveryAvailable = serviceDataUnavailable && canRecoverWithoutService(cart);
      cart.recoveryHasBreakIn = cart.lines.some(line => line.isBreakIn) ||
        Boolean(pendingMutation?.before?.lines?.some(line => line.isBreakIn));
      cart.incomplete = true;
      cart.uncertainMutation = pendingMutation.kinds?.join(', ') || pendingMutation.kind;
    }
    return cart;
  };

  async function loadProduct(handle) {
    const data = await request(PRODUCT_QUERY, { handle });
    if (!data.product?.variants.nodes[0]) throw new Error(`Shopify product “${handle}” was not found or has no variant.`);
    return data.product;
  }

  // Service lookups start alongside the required glove lookups so they do not add a
  // network round trip. Each is consumed once; validation still runs after products load.
  const settled = promise => promise.then(value => ({ value }), error => ({ error }));
  const servicePrefetch = new Map();
  const loadService = async handle => {
    const prefetched = servicePrefetch.get(handle);
    servicePrefetch.delete(handle);
    if (!prefetched) return loadProduct(handle);
    const result = await prefetched;
    if ('error' in result) throw result.error;
    return result.value;
  };

  async function getRawCart() {
    const id = storage?.getItem(SHOPIFY_CART_KEY);
    if (!id) return emptyCart();
    const data = await request(`query Cart($id: ID!) { cart(id: $id) { ${CART_FIELDS} } }`, { id });
    if (storage?.getItem(SHOPIFY_CART_KEY) !== id) {
      throw new ShopifyRequestError('The active cart changed while Shopify was responding.', 'cart-changed');
    }
    if (!data.cart) {
      storage?.removeItem(SHOPIFY_CART_KEY);
      return emptyCart();
    }
    return normalizeShopifyCart(data.cart, handleToProductId, config.breakInHandle);
  }

  async function getCart() { return applySafety(await getRawCart(), false); }
  async function getMutationCart() { return applySafety(await getRawCart(), true); }

  async function mutateCart(query, variables, field, kind = 'cart change') {
    const expectedCartId = variables.cartId || null;
    if ((storage?.getItem(SHOPIFY_CART_KEY) || null) !== expectedCartId) {
      throw new ShopifyRequestError('The active cart changed before the mutation started.', 'cart-changed');
    }
    let data;
    try { data = await request(query, variables); }
    catch (error) {
      if (['timeout', 'network', 'http', 'graphql'].includes(error.code)) {
        if (variables.cartId) markUnsafe(variables.cartId, kind);
        throw new ShopifyRequestError(`Shopify cart mutation result is uncertain: ${error.message}`, variables.cartId ? 'uncertain' : 'uncertain-create', error);
      }
      throw error;
    }
    if ((storage?.getItem(SHOPIFY_CART_KEY) || null) !== expectedCartId) {
      throw new ShopifyRequestError('The active cart changed while the mutation was pending.', 'cart-changed');
    }
    const payload = data[field];
    if (!payload?.cart && !payload?.userErrors?.length && expectedCartId) {
      markUnsafe(expectedCartId, kind);
      throw new ShopifyRequestError('Shopify did not confirm the cart mutation.', 'uncertain');
    }
    if (payload?.userErrors?.length) {
      const message = payload.userErrors.map(error => error.message).join(' ');
      let returned = null;
      try {
        if (payload.cart) returned = normalizeShopifyCart(payload.cart, handleToProductId, config.breakInHandle);
      } catch { /* An invalid response cannot establish a definitive rejection. */ }
      if (!expectedCartId && returned?.id && payload.cart?.lines?.nodes?.length) {
        storage?.setItem(SHOPIFY_CART_KEY, returned.id);
        markUnsafe(returned.id, kind, { ...emptyCart(), id: returned.id });
        announceCartChange();
        throw new ShopifyRequestError(`Shopify created a cart but reported errors: ${message}`, 'uncertain');
      }
      const unchanged = returned && !returned.incomplete && returned.id === expectedCartId &&
        lastVerifiedCart?.id === expectedCartId && cartStateStamp(returned) === cartStateStamp(lastVerifiedCart);
      if (expectedCartId && !unchanged) {
        markUnsafe(expectedCartId, kind);
        throw new ShopifyRequestError(`Shopify reported errors and did not confirm an unchanged cart: ${message}`, 'uncertain');
      }
      const rejection = new Error(message);
      rejection.definitiveRejection = true;
      throw rejection;
    }
    const cart = assertCartPayload(payload);
    if ((storage?.getItem(SHOPIFY_CART_KEY) || null) !== expectedCartId) {
      throw new ShopifyRequestError('The active cart changed while the mutation was pending.', 'cart-changed');
    }
    if (expectedCartId && cart.id !== expectedCartId) {
      markUnsafe(expectedCartId, kind);
      throw new ShopifyRequestError('Shopify returned a different cart for the mutation.', 'uncertain');
    }
    let normalized;
    try { normalized = normalizeShopifyCart(cart, handleToProductId, config.breakInHandle); }
    catch (error) {
      if (expectedCartId) markUnsafe(expectedCartId, kind);
      throw new ShopifyRequestError('Shopify returned a cart that could not be verified.', expectedCartId ? 'uncertain' : 'uncertain-create', error);
    }
    storage?.setItem(SHOPIFY_CART_KEY, cart.id);
    const result = applySafety(normalized);
    result.stockWarningTargets = (payload.warnings || []).filter(warning => STOCK_WARNING_CODES.includes(warning?.code))
      .map(warning => warning.target).filter(target => typeof target === 'string');
    announceCartChange();
    return result;
  }

  // A stock warning proves a rejection only when it names a line this request tried to grow, and both
  // Shopify's response and a fresh read show the cart exactly as it was before. Anything else stays
  // on the normal path, which blocks checkout. Only this operation's own pre-flight mark is lifted.
  const sameLine = (a, b) => String(a).split('?')[0] === String(b).split('?')[0];
  async function confirmStockRejection(before, result, attemptedLineIds, ownMark = null) {
    if (!before.id || !result?.stockWarningTargets?.some(target => attemptedLineIds.some(lineId => sameLine(target, lineId)))) return null;
    if (result.id !== before.id || cartStateStamp(result) !== cartStateStamp(before)) return null;
    const current = await getRawCart();
    if (current.id !== before.id || current.incomplete || cartStateStamp(current) !== cartStateStamp(before)) return null;
    clearUnsafe(before.id, ownMark);
    return applySafety(current);
  }
  const stockLimitError = (productId, quantity) => new ShopifyRequestError(
    `No more ${products.find(product => product.id === productId)?.name || 'of this glove'} available right now. Your cart still has ${quantity}.`, 'stock-limit');

  const updateLines = (cartId, lines, kind = 'quantity update') => mutateCart(`mutation UpdateLines($cartId: ID!, $lines: [CartLineUpdateInput!]!) {
    cartLinesUpdate(cartId: $cartId, lines: $lines) { cart { ${CART_FIELDS} } userErrors { message } warnings { code message target } }
  }`, { cartId, lines }, 'cartLinesUpdate', kind);

  const addLines = (cartId, lines, kind = 'addition') => mutateCart(`mutation AddLines($cartId: ID!, $lines: [CartLineInput!]!) {
    cartLinesAdd(cartId: $cartId, lines: $lines) { cart { ${CART_FIELDS} } userErrors { message } warnings { code message target } }
  }`, { cartId, lines }, 'cartLinesAdd', kind);

  const removeLines = (cartId, lineIds, kind = 'removal') => mutateCart(`mutation RemoveLines($cartId: ID!, $lineIds: [ID!]!) {
    cartLinesRemove(cartId: $cartId, lineIds: $lineIds) { cart { ${CART_FIELDS} } userErrors { message } }
  }`, { cartId, lineIds }, 'cartLinesRemove', kind);

  // Snapshot of the approved preorder estimates as one cart attribute, which Shopify copies onto the
  // order. Cart-level, so glove/service line attributes, configuration fingerprints, wrist fit and
  // parent links are untouched. cartAttributesUpdate is sent the complete attribute list (Shopify's
  // docs do not say whether it merges or replaces); a removal that leaves the key behind is retried
  // with a blank value, and the result must match exactly or checkout stays blocked.
  const preorderAttribute = cart => (cart.attributes || []).find(attribute => attribute.key === PREORDER_ORDER_ATTRIBUTE)?.value?.trim() || '';
  async function syncPreorderOrderAttribute(cart) {
    const value = preorderOrderAttributeValue(cart.lines, id => products.find(product => product.id === id));
    if (preorderAttribute(cart) === value) return cart;
    const others = (cart.attributes || []).filter(attribute => attribute.key !== PREORDER_ORDER_ATTRIBUTE);
    const write = attributes => mutateCart(`mutation UpdateCartAttributes($cartId: ID!, $attributes: [AttributeInput!]!) {
      cartAttributesUpdate(cartId: $cartId, attributes: $attributes) { cart { ${CART_FIELDS} } userErrors { message } warnings { code message target } }
    }`, { cartId: cart.id, attributes }, 'cartAttributesUpdate', 'preorder details');
    let updated = await write(value ? [...others, { key: PREORDER_ORDER_ATTRIBUTE, value }] : others);
    if (!value && preorderAttribute(updated)) updated = await write([...others, { key: PREORDER_ORDER_ATTRIBUTE, value: '' }]);
    if (preorderAttribute(updated) !== value) throw new Error('Shopify did not save the preorder details.');
    return updated;
  }

  async function updateDiscountCodes(cartId, discountCodes) {
    if (storage?.getItem(SHOPIFY_CART_KEY) !== cartId) {
      throw new ShopifyRequestError('The active cart changed before the discount update started.', 'cart-changed');
    }
    const data = await request(`mutation UpdateDiscountCodes($cartId: ID!, $discountCodes: [String!]!) {
      cartDiscountCodesUpdate(cartId: $cartId, discountCodes: $discountCodes) {
        cart { ${CART_FIELDS} }
        userErrors { message }
        warnings { code message }
      }
    }`, { cartId, discountCodes });
    const payload = data.cartDiscountCodesUpdate;
    if (storage?.getItem(SHOPIFY_CART_KEY) !== cartId) {
      throw new ShopifyRequestError('The active cart changed while the discount update was pending.', 'cart-changed');
    }
    if (!payload) throw new Error('Shopify did not return a discount update.');
    if (payload.userErrors?.length) {
      const returned = payload.cart && normalizeShopifyCart(payload.cart, handleToProductId, config.breakInHandle);
      const error = new Error(payload.userErrors.map(item => item.message).join(' '));
      error.definitiveRejection = returned && !returned.incomplete && returned.id === cartId &&
        lastVerifiedCart?.id === cartId && cartStateStamp(returned) === cartStateStamp(lastVerifiedCart);
      throw error;
    }
    const updated = assertCartPayload(payload);
    if (updated.id !== cartId) throw new Error('Shopify returned a different cart.');
    const normalized = applySafety(normalizeShopifyCart(updated, handleToProductId, config.breakInHandle));
    normalized.discountWarnings = (payload.warnings || []).map(warning => warning.message).filter(Boolean);
    announceCartChange();
    return normalized;
  }

  async function createCart(lines) {
    return mutateCart(`mutation CreateCart($input: CartInput!) {
      cartCreate(input: $input) { cart { ${CART_FIELDS} } userErrors { message } }
    }`, { input: { lines } }, 'cartCreate');
  }

  async function removeParentLine(cart, parent) {
    if (!parent.instructions?.canRemove) throw new Error('Shopify does not allow this glove to be removed.');
    await mutateCart(`mutation RemoveLines($cartId: ID!, $lineIds: [ID!]!) {
      cartLinesRemove(cartId: $cartId, lineIds: $lineIds) { cart { ${CART_FIELDS} } userErrors { message } }
    }`, { cartId: cart.id, lineIds: [parent.remoteLineId] }, 'cartLinesRemove', 'removal');
    try {
      const updated = await getRawCart();
      if (!configurationChangeIsExpected(cart, updated, parent, 0)) {
        markUnsafe(cart.id, 'removal validation failed', cart);
        throw new Error('Shopify did not remove the selected glove and preserve the other cart items.');
      }
      return applySafety(updated);
    } catch (error) {
      markUnsafe(cart.id, 'removal', cart);
      throw error;
    }
  }

  async function setParentLineQuantity(cart, parent, quantity) {
    if (cart.incomplete) throw new Error('The Shopify cart is incomplete. Resolve the cart update before changing quantities.');
    const next = requestedQuantity(quantity);
    if (next === parent.quantity) return cart;
    if (!next) return removeParentLine(cart, parent);
    if (!parent.instructions?.canUpdateQuantity) throw new Error('Shopify does not allow this glove quantity to change.');
    const update = lines => updateLines(cart.id, lines);
    const originalChild = cart.lines.find(line => line.isBreakIn && line.parentLineId === parent.remoteLineId);
    const ownMark = originalChild ? markUnsafe(cart.id, 'quantity update') : null;
    let firstMutationCompleted = false;
    try {
      let updated = await update([{ id: parent.remoteLineId, quantity: next }]);
      firstMutationCompleted = true;
      if (await confirmStockRejection(cart, updated, [parent.remoteLineId], ownMark)) throw stockLimitError(parent.productId, parent.quantity);
      const updatedParent = resolveCurrentLine(updated, parent, next);
      if (updatedParent?.quantity !== next) {
        if (originalChild) markUnsafe(cart.id, 'quantity validation failed');
        throw new Error('Shopify did not update the glove quantity.');
      }
      if (originalChild) {
        const child = updated.lines.find(line => line.isBreakIn && line.parentLineId === updatedParent.remoteLineId);
        if (!child) {
          markUnsafe(cart.id, 'quantity validation failed');
          throw new Error('Shopify did not preserve the nested Break-in service.');
        }
        if (child.quantity !== next) {
          if (!child.instructions?.canUpdateQuantity) throw new Error('Shopify did not synchronize the Break-in service quantity.');
          updated = await update([{ id: child.remoteLineId, quantity: next }]);
          const synchronizedParent = resolveCurrentLine(updated, parent, next);
          if (updated.lines.find(line => line.isBreakIn && line.parentLineId === synchronizedParent.remoteLineId)?.quantity !== next) {
            markUnsafe(cart.id, 'quantity validation failed');
            throw new Error('Shopify did not update the Break-in service quantity.');
          }
        }
        updated = await getRawCart();
        const finalParent = resolveCurrentLine(updated, parent, next);
        const finalChild = updated.lines.find(line => line.isBreakIn && line.parentLineId === finalParent.remoteLineId);
        if (!configurationChangeIsExpected(cart, updated, parent, next) || finalParent?.quantity !== next || finalChild?.quantity !== next) {
          markUnsafe(cart.id, 'quantity validation failed');
          throw new Error('Shopify did not preserve the glove and Break-in service quantities.');
        }
        clearUnsafe(cart.id, ownMark);
        return applySafety(updated);
      }
      updated = await getRawCart();
      if (!configurationChangeIsExpected(cart, updated, parent, next)) {
        markUnsafe(cart.id, 'quantity validation failed', cart);
        throw new Error('Shopify did not preserve the selected glove quantity and other cart items.');
      }
      return applySafety(updated);
    } catch (error) {
      if (error.code === 'stock-limit') throw error;
      if (firstMutationCompleted) markUnsafe(cart.id, 'quantity update', cart);
      if (originalChild && !firstMutationCompleted && error.code !== 'uncertain') clearUnsafe(cart.id, ownMark);
      throw error;
    }
  }

  const configurationQuantity = (cart, source, value, options = null) => cart.lines
    .filter(line => matchingConfiguration(line, source, value, options))
    .reduce((sum, line) => sum + line.quantity, 0);

  function resolveAddedDestination(before, after, source, value, options = null) {
    const previous = before.lines.filter(line => matchingConfiguration(line, source, value, options));
    const candidates = after.lines.filter(line => matchingConfiguration(line, source, value, options));
    if (configurationQuantity(after, source, value, options) !== configurationQuantity(before, source, value, options) + 1) {
      throw new Error('Shopify did not add exactly one glove to the selected service configuration.');
    }
    const oldQuantities = new Map(previous.map(line => [line.remoteLineId, line.quantity]));
    const increased = candidates.filter(line => line.quantity - (oldQuantities.get(line.remoteLineId) || 0) === 1);
    if (increased.length === 1) return increased[0];
    if (candidates.length === 1) return candidates[0];
    throw new Error('Shopify merged the destination glove line ambiguously.');
  }

  function resolveCurrentLine(cart, source, quantity = source.quantity) {
    const candidates = cart.lines.filter(line => matchingConfiguration(line, source, source.serviceConfiguration));
    const sameId = candidates.find(line => line.remoteLineId === source.remoteLineId && line.quantity === quantity);
    if (sameId) return sameId;
    const matchingQuantity = candidates.filter(line => line.quantity === quantity);
    if (matchingQuantity.length === 1) return matchingQuantity[0];
    throw new Error('Shopify changed the selected glove line ambiguously.');
  }

  async function decrementSplitSource(cart, source, hasService) {
    if (!source.instructions?.canUpdateQuantity) throw new Error('Shopify does not allow this glove quantity to change.');
    const nextQuantity = source.quantity - 1;
    await updateLines(cart.id, [{ id: source.remoteLineId, quantity: nextQuantity }]);
    let current = await getRawCart();
    const updatedParent = resolveCurrentLine(current, source, nextQuantity);
    if (hasService) {
      const children = current.lines.filter(line => line.isBreakIn && line.parentLineId === updatedParent.remoteLineId);
      if (children.length !== 1) throw new Error('Shopify did not preserve the selected Break-in service child.');
      if (children[0].quantity !== nextQuantity) {
        if (!children[0].instructions?.canUpdateQuantity) throw new Error('Shopify cannot synchronize the Break-in service quantity.');
        await updateLines(current.id, [{ id: children[0].remoteLineId, quantity: nextQuantity }]);
        current = await getRawCart();
      }
    }
    return current;
  }

  function configurationSnapshot(cart) {
    const quantities = new Map();
    for (const line of cart.lines.filter(line => !line.isBreakIn)) {
      const attributes = [...line.attributes].sort((a, b) => a.key.localeCompare(b.key));
      const key = JSON.stringify([line.productId, line.merchandiseId, attributes]);
      quantities.set(key, (quantities.get(key) || 0) + line.quantity);
    }
    return quantities;
  }

  function configurationChangeIsExpected(before, after, parent, nextQuantity) {
    if (after.id !== before.id || after.incomplete) return false;
    const expected = configurationSnapshot(before);
    const key = JSON.stringify([parent.productId, parent.merchandiseId,
      [...parent.attributes].sort((a, b) => a.key.localeCompare(b.key))]);
    const quantity = (expected.get(key) || 0) + nextQuantity - parent.quantity;
    if (quantity) expected.set(key, quantity);
    else expected.delete(key);
    const actual = configurationSnapshot(after);
    if (actual.size !== expected.size || [...expected].some(([key, count]) => actual.get(key) !== count)) return false;
    const hasService = before.lines.some(child => child.isBreakIn && child.parentLineId === parent.remoteLineId);
    return [...new Set([...before.lines, ...after.lines].map(line => line.productId))].every(productId =>
      cartLineQuantity(after, productId, true) === cartLineQuantity(before, productId, true) +
        (hasService && productId === parent.productId ? nextQuantity - parent.quantity : 0));
  }

  function recoverySignature(cart) {
    const parents = new Map();
    for (const line of cart.lines.filter(line => !line.isBreakIn)) {
      const child = cart.lines.find(entry => entry.isBreakIn && entry.parentLineId === line.remoteLineId);
      const key = JSON.stringify([line.merchandiseId,
        [...line.attributes].sort((a, b) => a.key.localeCompare(b.key)), child?.merchandiseId || null,
        [...(child?.attributes || [])].sort((a, b) => a.key.localeCompare(b.key)),
        line.throwingHand || line.attributes.find(attribute => attribute.key === 'Throwing Hand')?.value || null]);
      const count = parents.get(key) || { gloves: 0, services: 0 };
      count.gloves += line.quantity;
      count.services += child?.quantity || 0;
      parents.set(key, count);
    }
    return JSON.stringify([[...parents].sort(([a], [b]) => a.localeCompare(b)), discountCodeList(cart).sort()]);
  }

  function cartStateStamp(cart) {
    return JSON.stringify([cart.lines.map(line => [line.remoteLineId, line.parentLineId,
      line.merchandiseId, line.quantity, line.attributes]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    discountCodeList(cart).sort()]);
  }

  function snapshotMatchesUnaffectedLines(source, before, kinds = []) {
    const addingService = kinds.includes('Break-In addition');
    const removingService = kinds.includes('Break-In removal');
    if (!source.lineCoverageComplete) return false;
    if (kinds.includes('addition') && !addingService && !removingService) {
      const oldIds = new Set(before.lines.map(line => line.remoteLineId));
      const extra = source.lines.filter(line => !oldIds.has(line.remoteLineId));
      if (!extra.length && source.lines.length === before.lines.length) {
        const increased = source.lines.filter(line => {
          const old = before.lines.find(item => item.remoteLineId === line.remoteLineId);
          return old && line.quantity === old.quantity + 1;
        });
        if (increased.length !== 1 || increased[0].isBreakIn || increased[0].serviceConfiguration !== 'break-in') return false;
        const original = before.lines.find(line => line.remoteLineId === increased[0].remoteLineId);
        const child = source.lines.find(line => line.parentLineId === original.remoteLineId);
        if (!child || child.quantity !== original.quantity) return false;
        return cartStateStamp({ ...source, lines: source.lines.map(line => line === increased[0]
          ? { ...line, quantity: original.quantity } : line) }) === cartStateStamp(before);
      }
      if (extra.length !== 1 || source.lines.length !== before.lines.length + 1) return false;
      const line = extra[0];
      if (line.isBreakIn || line.parentLineId || line.quantity !== 1 || line.serviceConfiguration !== 'break-in' ||
        source.lines.some(child => child.parentLineId === line.remoteLineId)) return false;
      try {
        if (line.attributes.some(attribute => attribute.key === FULL_SIZE_CONFIGURATION_KEY)) {
          const identity = line.attributes.filter(attribute => attribute.key === FULL_SIZE_CONFIGURATION_KEY);
          if (identity.length !== 1 || !/^v1:[0-9a-f]{64}$/.test(identity[0].value) ||
            line.attributes.some(attribute => !['_anawin_service', '_anawin_service_type', FULL_SIZE_CONFIGURATION_KEY, WRIST_FIT_KEY].includes(attribute.key)) ||
            !['Right', 'Left'].includes(line.throwingHand)) return false;
        } else normalizeBreakInOptions(optionsFromAttributes(line.attributes));
      } catch { return false; }
      return cartStateStamp({ ...source, lines: source.lines.filter(item => item.remoteLineId !== line.remoteLineId) }) ===
        cartStateStamp(before);
    }
    if (kinds.includes('quantity update')) {
      if (source.lines.length !== before.lines.length) return false;
      const changed = source.lines.filter(line => {
        const old = before.lines.find(item => item.remoteLineId === line.remoteLineId);
        return old && line.quantity !== old.quantity;
      });
      if (changed.length !== 1 || changed[0].isBreakIn ||
        !Number.isInteger(changed[0].quantity) || changed[0].quantity < 1) return false;
      const old = before.lines.find(line => line.remoteLineId === changed[0].remoteLineId);
      if (!before.lines.some(line => line.isBreakIn && line.parentLineId === old.remoteLineId)) return false;
      return cartStateStamp({ ...source, lines: source.lines.map(line => line === changed[0]
        ? { ...line, quantity: old.quantity } : line) }) === cartStateStamp(before);
    }
    if (!addingService && !removingService) return false;
    if (JSON.stringify(discountCodeList(source).sort()) !== JSON.stringify(discountCodeList(before).sort())) return false;
    const parents = cart => new Map(cart.lines.filter(line => !line.isBreakIn).map(line => [line.remoteLineId, line]));
    const liveParents = parents(source);
    const oldParents = parents(before);
    if (liveParents.size !== oldParents.size) return false;
    const affected = new Set();
    for (const [id, oldLine] of oldParents) {
      const live = liveParents.get(id);
      if (!live || live.merchandiseId !== oldLine.merchandiseId || live.productId !== oldLine.productId ||
        live.quantity !== oldLine.quantity) return false;
      const otherAttributes = line => JSON.stringify(line.attributes.filter(attribute =>
        !SERVICE_ATTRIBUTE_KEYS.includes(attribute.key))
        .sort((a, b) => a.key.localeCompare(b.key)));
      if (otherAttributes(live) !== otherAttributes(oldLine)) return false;
      const serviceAttribute = line => line.attributes.filter(attribute => attribute.key === SERVICE_ATTRIBUTE);
      const oldService = serviceAttribute(oldLine);
      const liveService = serviceAttribute(live);
      if (oldService.length !== 1 || liveService.length !== 1 ||
        !['none', 'break-in'].includes(liveService[0].value)) return false;
      if (oldService[0].value === liveService[0].value &&
        JSON.stringify([...oldLine.attributes].sort((a, b) => a.key.localeCompare(b.key))) !==
          JSON.stringify([...live.attributes].sort((a, b) => a.key.localeCompare(b.key)))) return false;
      if (oldService[0].value !== liveService[0].value) {
        if (oldService[0].value === 'none' && liveService[0].value === 'break-in' && !addingService ||
          oldService[0].value === 'break-in' && liveService[0].value === 'none' && !removingService) return false;
        affected.add(id);
      }
    }
    const children = cart => new Map(cart.lines.filter(line => line.isBreakIn).map(line => [line.remoteLineId, line]));
    const oldChildren = children(before);
    const liveChildren = children(source);
    for (const id of new Set([...oldChildren.keys(), ...liveChildren.keys()])) {
      const oldLine = oldChildren.get(id);
      const live = liveChildren.get(id);
      if (oldLine && live && oldLine.parentLineId === live.parentLineId &&
        oldLine.merchandiseId === live.merchandiseId && oldLine.quantity === live.quantity) {
        if (JSON.stringify([...oldLine.attributes].sort((a, b) => a.key.localeCompare(b.key))) !==
          JSON.stringify([...live.attributes].sort((a, b) => a.key.localeCompare(b.key)))) return false;
        continue;
      }
      if (!oldLine || live || !removingService) return false;
      const parentId = live?.parentLineId || oldLine?.parentLineId;
      if (!oldParents.has(parentId) || !liveParents.has(parentId)) return false;
      affected.add(parentId);
    }
    if (affected.size !== 1) return false;
    const affectedId = [...affected][0];
    const liveChildLines = source.lines.filter(line => line.isBreakIn && line.parentLineId === affectedId);
    if (liveChildLines.length > 1 || liveChildLines.some(line => line.quantity > liveParents.get(affectedId).quantity)) return false;
    return true;
  }

  async function recoverCartUnchecked({ withoutBreakIn = false } = {}) {
    const unsafeId = storage?.getItem(SHOPIFY_CART_KEY);
    if (!unsafeId || !isUnsafe(unsafeId)) return getCart();
    // The exclusive Web Lock proves no participating tab still owns an active mutation.
    // Pending records left by reloads are safe to recover only while holding this lock.
    if (unsafeRecords(unsafeId, true) === null) throw new Error('Cart storage is unavailable.');
    const source = await getRawCart();
    if (source.id !== unsafeId) throw new Error('Shopify has not returned the original cart for recovery.');
    const pendingMutation = pendingFor(unsafeId);
    const legacyRecovery = withoutBreakIn && pendingMutation?.kinds?.includes('service data unavailable') &&
      canRecoverWithoutService(source);
    if (pendingMutation?.kinds?.includes('service data unavailable') && !legacyRecovery) {
      throw new ShopifyRequestError('Only glove-only recovery is available for this cart.', 'recovery-ambiguous');
    }
    if (pendingMutation?.kinds?.some(kind => kind.endsWith('validation failed'))) {
      throw new ShopifyRequestError('Shopify did not preserve the requested cart configuration. This cart cannot be recovered automatically.', 'recovery-ambiguous');
    }
    const historical = pendingMutation?.before;
    if (source.incomplete && !legacyRecovery && (!historical ||
      !snapshotMatchesUnaffectedLines(source, historical, pendingMutation?.kinds || [pendingMutation?.kind]))) {
      throw new ShopifyRequestError('The original cart differs from the last verified cart. Its full contents cannot be established safely.', 'recovery-ambiguous');
    }
    const observed = legacyRecovery ? source : source.incomplete ? historical : source;
    if (!observed || observed.id !== unsafeId || !legacyRecovery && !hasConsistentBreakInLines(observed)) {
      throw new Error('Shopify has not returned a complete cart for recovery.');
    }
    const verified = withoutBreakIn ? { ...observed, lines: observed.lines.filter(line => !line.isBreakIn).map(line => ({
      ...line, attributes: withServiceAttribute(line.attributes, 'none'), serviceConfiguration: 'none'
    })) } : observed;
    const sourceStamp = cartStateStamp(source);
    const parents = verified.lines.filter(line => !line.isBreakIn);
    const input = {
      lines: parents.map(line => ({ merchandiseId: line.merchandiseId, quantity: line.quantity, attributes: line.attributes })),
      discountCodes: discountCodeList(verified)
    };
    const created = await request(`mutation CreateCart($input: CartInput!) {
      cartCreate(input: $input) { cart { ${CART_FIELDS} } userErrors { message } }
    }`, { input });
    let newCart = normalizeShopifyCart(assertCartPayload(created.cartCreate), handleToProductId, config.breakInHandle);
    if (!newCart.id || newCart.id === unsafeId) throw new Error('Shopify did not create a separate recovery cart.');
    const children = verified.lines.filter(line => line.isBreakIn).map(child => {
      const oldParent = parents.find(line => line.remoteLineId === child.parentLineId);
      const matches = newCart.lines.filter(line => !line.isBreakIn && line.merchandiseId === oldParent?.merchandiseId &&
        JSON.stringify([...line.attributes].sort((a, b) => a.key.localeCompare(b.key))) ===
        JSON.stringify([...oldParent.attributes].sort((a, b) => a.key.localeCompare(b.key))));
      if (matches.length !== 1) throw new Error('Shopify could not identify a Break-In parent in the recovery cart.');
      return { merchandiseId: child.merchandiseId, quantity: child.quantity,
        attributes: child.attributes, parent: { lineId: matches[0].remoteLineId } };
    });
    if (children.length) {
      const added = await request(`mutation AddLines($cartId: ID!, $lines: [CartLineInput!]!) {
        cartLinesAdd(cartId: $cartId, lines: $lines) { cart { ${CART_FIELDS} } userErrors { message } }
      }`, { cartId: newCart.id, lines: children });
      newCart = normalizeShopifyCart(assertCartPayload(added.cartLinesAdd), handleToProductId, config.breakInHandle);
    }
    if (newCart.incomplete || recoverySignature(newCart) !== recoverySignature(verified)) {
      throw new Error('Shopify did not preserve every cart item during recovery.');
    }
    const latest = await getRawCart();
    if (latest.id !== unsafeId || cartStateStamp(latest) !== sourceStamp ||
      storage?.getItem(SHOPIFY_CART_KEY) !== unsafeId) {
      throw new Error('The original cart changed during recovery. Check it again before continuing.');
    }
    storage.setItem(SHOPIFY_CART_KEY, newCart.id);
    retireUnsafeCart(unsafeId);
    return applySafety(newCart);
  }

  async function recoverCart(options) {
    if (!recoveryLocks?.request) {
      throw new ShopifyRequestError('Exclusive cart recovery is unavailable in this browser.', 'recovery-lock-unavailable');
    }
    return recoveryLocks.request('anawin-shopify-cart-recovery', { ifAvailable: true }, lock => {
      if (!lock) throw new ShopifyRequestError('A cart mutation is still active. Try recovery after it finishes.', 'recovery-ambiguous');
      return recoverCartUnchecked(options);
    });
  }

  // `destination` is the attribute list of the glove that moved off `source`.
  function verifySplit(before, after, source, destination, serviceDelta) {
    if (after.id !== before.id || after.incomplete || !hasConsistentBreakInLines(after)) {
      throw new Error('Shopify returned an incomplete split cart.');
    }
    const oldQuantities = configurationSnapshot(before);
    const newQuantities = configurationSnapshot(after);
    const sourceKey = JSON.stringify([source.productId, source.merchandiseId,
      [...source.attributes].sort((a, b) => a.key.localeCompare(b.key))]);
    const destinationKey = JSON.stringify([source.productId, source.merchandiseId,
      [...destination].sort((a, b) => a.key.localeCompare(b.key))]);
    const keys = new Set([...oldQuantities.keys(), ...newQuantities.keys()]);
    for (const key of keys) {
      const expected = (oldQuantities.get(key) || 0) + (key === sourceKey ? -1 : key === destinationKey ? 1 : 0);
      if ((newQuantities.get(key) || 0) !== expected) throw new Error('Shopify changed the glove quantities unexpectedly during the split.');
    }
    const productIds = new Set([...before.lines, ...after.lines].map(line => line.productId));
    for (const productId of productIds) {
      const expected = cartLineQuantity(before, productId, true) + (productId === source.productId ? serviceDelta : 0);
      if (cartLineQuantity(after, productId, true) !== expected) {
        throw new Error('Shopify changed the Break-in service quantity unexpectedly during the split.');
      }
    }
  }

  // The service line for a glove: trainer or full-size variant, with the glove's model and
  // throw hand for full-size fulfillment.
  function serviceLine(parent, options, quantity, parentLineId) {
    const fullSize = options.type === 'full-size';
    const variant = fullSize ? fullSizeVariant : breakInVariant;
    if (!variant?.availableForSale) throw new Error('Break-in service is not currently available.');
    const attributes = serviceAttributes(options);
    if (fullSize) {
      const product = products.find(item => item.id === parent.productId);
      if (!product || !['Right', 'Left'].includes(parent.throwingHand)) throw new Error('Shopify did not identify this glove’s throw hand.');
      attributes.push({ key: 'Glove Model', value: product.name }, { key: 'Throwing Hand', value: parent.throwingHand });
    }
    return { merchandiseId: variant.id, quantity, attributes, parent: { lineId: parentLineId } };
  }

  // A service change must leave every glove's saved choices matching its service line.
  function verifyServiceChoices(before, after) {
    if (cartCustomizationIsComplete(before.lines) && !cartCustomizationIsComplete(after.lines)) {
      throw new Error('Shopify did not save the selected break-in choices on both cart lines.');
    }
  }

  // Moves one glove of a multi-glove line to its own line: 'add' and 'change' give it the chosen
  // break-in (the source line keeps its own), 'remove' gives it none.
  async function splitBreakIn(cart, parent, mode, options = null) {
    if (!parent.instructions?.canUpdateQuantity) throw new Error('Shopify does not allow this glove quantity to change.');
    const addService = mode !== 'remove';
    const ownMark = markUnsafe(cart.id, SERVICE_CHANGE_KINDS[mode]);
    let firstMutationCompleted = false;
    try {
      let current;
      if (addService) {
        await addLines(cart.id, [{ merchandiseId: parent.merchandiseId, quantity: 1,
          attributes: withServiceAttribute(parent.attributes, 'break-in', options) }]);
        firstMutationCompleted = true;
        current = await getRawCart();
        let destination = resolveAddedDestination(cart, current, parent, 'break-in', options);
        const children = current.lines.filter(line => line.isBreakIn && line.parentLineId === destination.remoteLineId);
        if (children.length > 1 || children[0]?.quantity > destination.quantity) {
          throw new Error('Shopify returned inconsistent Break-in service children.');
        }
        if (!children.length) {
          await addLines(current.id, [serviceLine(parent, options || DEFAULT_BREAK_IN, destination.quantity, destination.remoteLineId)]);
        } else if (children[0].quantity !== destination.quantity) {
          if (!children[0].instructions?.canUpdateQuantity) throw new Error('Shopify cannot synchronize the Break-in service quantity.');
          await updateLines(current.id, [{ id: children[0].remoteLineId, quantity: destination.quantity }]);
        }
        current = await getRawCart();
        destination = resolveCurrentLine(current, destination);
        if (!current.lines.some(line => line.isBreakIn && line.parentLineId === destination.remoteLineId &&
          line.quantity === destination.quantity)) throw new Error('Shopify did not attach the Break-in service to the selected glove.');
        const source = resolveCurrentLine(current, parent);
        current = await decrementSplitSource(current, source, mode === 'change');
      } else {
        await addLines(cart.id, [{ merchandiseId: parent.merchandiseId, quantity: 1,
          attributes: withServiceAttribute(parent.attributes, 'none') }]);
        firstMutationCompleted = true;
        current = await getRawCart();
        resolveAddedDestination(cart, current, parent, 'none');
        const source = resolveCurrentLine(current, parent);
        current = await decrementSplitSource(current, source, true);
      }
      current = await getRawCart();
      verifySplit(cart, current, parent, withServiceAttribute(parent.attributes, addService ? 'break-in' : 'none', options),
        { add: 1, remove: -1, change: 0 }[mode]);
      if (addService) verifyServiceChoices(cart, current);
      clearUnsafe(cart.id, ownMark);
      return applySafety(current);
    } catch (error) {
      if (!firstMutationCompleted && error.code !== 'uncertain') clearUnsafe(cart.id, ownMark);
      throw error;
    }
  }

  // Moves one glove of a multi-glove line to its own line with `attributes` (the new wrist fit),
  // taking a copy of its break-in service along; the source line keeps its own fit.
  async function splitWristFit(cart, parent, attributes) {
    if (!parent.instructions?.canUpdateQuantity) throw new Error('Shopify does not allow this glove quantity to change.');
    const child = cart.lines.find(line => line.isBreakIn && line.parentLineId === parent.remoteLineId);
    const template = { ...parent, attributes };
    const ownMark = markUnsafe(cart.id, WRIST_FIT_CHANGE);
    let firstMutationCompleted = false;
    try {
      await addLines(cart.id, [{ merchandiseId: parent.merchandiseId, quantity: 1, attributes }], WRIST_FIT_CHANGE);
      firstMutationCompleted = true;
      let current = await getRawCart();
      let destination = resolveAddedDestination(cart, current, template, parent.serviceConfiguration);
      if (child) {
        const children = current.lines.filter(line => line.isBreakIn && line.parentLineId === destination.remoteLineId);
        if (children.length > 1 || children[0]?.quantity > destination.quantity) {
          throw new Error('Shopify returned inconsistent Break-in service children.');
        }
        if (!children.length) {
          await addLines(current.id, [{ merchandiseId: child.merchandiseId, quantity: destination.quantity,
            attributes: child.attributes, parent: { lineId: destination.remoteLineId } }], WRIST_FIT_CHANGE);
        } else if (children[0].quantity !== destination.quantity) {
          if (!children[0].instructions?.canUpdateQuantity) throw new Error('Shopify cannot synchronize the Break-in service quantity.');
          await updateLines(current.id, [{ id: children[0].remoteLineId, quantity: destination.quantity }], WRIST_FIT_CHANGE);
        }
        current = await getRawCart();
        destination = resolveCurrentLine(current, destination);
        if (!current.lines.some(line => line.isBreakIn && line.parentLineId === destination.remoteLineId &&
          line.quantity === destination.quantity)) throw new Error('Shopify did not attach the Break-in service to the selected glove.');
      }
      current = await decrementSplitSource(current, resolveCurrentLine(current, parent), Boolean(child));
      current = await getRawCart();
      verifySplit(cart, current, parent, attributes, 0);
      verifyServiceChoices(cart, current);
      clearUnsafe(cart.id, ownMark);
      return applySafety(current);
    } catch (error) {
      if (!firstMutationCompleted && error.code !== 'uncertain') clearUnsafe(cart.id, ownMark);
      throw error;
    }
  }

  const api = {
    mode: 'shopify',
    async listProducts() {
      servicePrefetch.clear();
      if (config.breakInHandle) servicePrefetch.set(config.breakInHandle, settled(loadProduct(config.breakInHandle)));
      if (fullSizeProducts.some(product => config.handles[product.id])) {
        servicePrefetch.set(FULL_SIZE_SERVICE_HANDLE, settled(loadProduct(FULL_SIZE_SERVICE_HANDLE)));
      }
      const entries = await Promise.all(Object.entries(config.handles).map(async ([id, handle]) => [id, await loadProduct(handle)]));
      products = [...localProducts, ...fullSizeProducts.filter(product => config.handles[product.id])].map(local => {
        const remote = entries.find(([id]) => id === local.id)[1];
        const variant = remote.variants.nodes[0];
        return { ...local, handle: remote.handle, shopifyProductGid: remote.id, merchandiseId: variant.id, price: Number(variant.price.amount), currencyCode: variant.price.currencyCode, available: local.line === 'full-size' ? remote.variants.nodes.some(variant => variant.availableForSale) : variant.availableForSale, variants: remote.variants.nodes,
          // Optional Shopify-side estimate; null when the metafield is unset or not exposed to the Storefront API.
          ...(local.line === 'full-size' ? { shopifyPreorderShipEstimate: typeof remote.preorderShipEstimate?.value === 'string' ? remote.preorderShipEstimate.value : null } : {}) };
      });
      return products;
    },
    async getBreakInService() {
      breakInVariant = null;
      remoteBreakInService = { ...breakInService, available: false };
      if (!config.breakInHandle) return remoteBreakInService;
      try {
        const service = await loadService(config.breakInHandle);
        breakInVariant = service.variants.nodes[0];
        const price = Number(breakInVariant.price.amount);
        const currencyCode = breakInVariant.price.currencyCode;
        if (!Number.isFinite(price) || price < 0 || !products.every(product => product.currencyCode === currencyCode)) {
          throw new Error('Shopify returned an invalid Break-in service price.');
        }
        remoteBreakInService = {
          ...breakInService,
          name: service.title,
          merchandiseId: breakInVariant.id,
          price,
          currencyCode,
          available: breakInVariant.availableForSale
        };
      } catch {
        breakInVariant = null;
        /* The optional service must not prevent glove-only purchases. */
      }
      return remoteBreakInService;
    },
    async getFullSizeBreakInService() {
      fullSizeVariant = null;
      fullSizeService = { ...fullSizeBreakInService, available: false };
      if (!products.some(product => product.line === 'full-size')) return fullSizeService;
      try {
        const service = await loadService(FULL_SIZE_SERVICE_HANDLE);
        const variant = service.variants.nodes.find(variant => variant.id === FULL_SIZE_SERVICE_VARIANT);
        if (service.id !== FULL_SIZE_SERVICE_PRODUCT || !variant || Number(variant.price.amount) !== 75 || variant.price.currencyCode !== 'USD') throw new Error('Full-size service reference or price differs.');
        fullSizeVariant = variant;
        fullSizeService = { ...fullSizeService, merchandiseId: variant.id, available: variant.availableForSale };
      } catch { /* Full-size glove-only purchases remain available. */ }
      return fullSizeService;
    },
    getCart,
    // Read fresh from shared storage every time, so another tab's unresolved operation always counts.
    readCartSafety() {
      const revision = storage?.getItem(CART_REVISION_KEY) || null;
      const id = storage?.getItem(SHOPIFY_CART_KEY) || null;
      const unresolved = id && pendingFor(id, true);
      const changed = revision !== (storage?.getItem(CART_REVISION_KEY) || null);
      const unsafeId = id && (unresolved || changed) ? id : null;
      return { id, unsafeId, pendingCartId: unsafeId, revision };
    },
    async refreshCart() {
      return applySafety(await getRawCart(), false);
    },
    recoverCart,
    async checkout(displayedCart, options, navigate) {
      const blocked = message => ({ status: 'blocked', message });
      if (!recoveryLocks?.request) return blocked('Secure checkout is unavailable in this browser. Please try another browser.');
      try {
        return await recoveryLocks.request('anawin-shopify-cart-recovery', { ifAvailable: true }, async lock => {
          if (!lock) return blocked('A cart change is still being checked. Check your cart before checkout.');
          // A preorder glove that can no longer be confirmed is never handed to checkout.
          const unconfirmed = (cart => cart.lines.some(line => !line.isBreakIn &&
            preorderState(products.find(product => product.id === line.productId)).status === 'blocked'));
          if (unconfirmed(displayedCart)) return blocked('A preorder glove in your cart isn’t available right now. Remove it to continue.');
          // Only carts with preorder details (an active preorder glove, or a snapshot left from one) do
          // the extra read and attribute write; every other checkout path is unchanged.
          const hasPreorderDetails = cart => Boolean(preorderAttribute(cart) ||
            preorderOrderAttributeValue(cart.lines, id => products.find(product => product.id === id)));
          if (hasPreorderDetails(displayedCart)) {
            const detailsFailed = () => blocked('Couldn’t save your preorder details with Shopify. Check your cart and try again.');
            let current;
            try { current = await getMutationCart(); } catch { return detailsFailed(); }
            if (current.id && !current.incomplete && current.lines.length) {
              if (unconfirmed(current)) return blocked('A preorder glove in your cart isn’t available right now. Remove it to continue.');
              try { await syncPreorderOrderAttribute(current); } catch { return detailsFailed(); }
            }
          }
          const verify = createCheckoutVerifier({ getCart, readSafety: () => api.readCartSafety() });
          const result = await verify(displayedCart, options);
          if (result.status !== 'ready') return result;
          const url = verifiedCheckoutUrl(result.checkoutUrl);
          if (!url) return blocked('We couldn’t open secure checkout. Check your cart and try again.');
          // Keep the original cart frozen after navigation releases this lock. Other
          // tabs can recover into a separate editable cart, never mutate this checkout.
          const token = markUnsafe(result.cart.id, 'checkout handoff');
          if (!token) return blocked('Couldn’t save checkout safety information. Please try again.');
          const key = UNSAFE_RECORD_PREFIX + token;
          if (JSON.parse(storage.getItem(key) || 'null')?.cartId !== result.cart.id) {
            return blocked('Couldn’t save checkout safety information. Please try again.');
          }
          announceCartChange();
          try {
            navigate(url);
          } catch (error) {
            clearUnsafe(result.cart.id, token);
            throw error;
          }
          return { ...result, status: 'navigating' };
        });
      } catch {
        return blocked('Couldn’t open secure checkout. Check your cart and try again.');
      }
    },
    async applyDiscountCode(input) {
      const code = input.trim();
      if (!code) throw new Error('Enter a discount code.');
      const current = await getMutationCart();
      if (!current.id || current.incomplete) throw new Error('The Shopify cart is unavailable. Please reload it before applying a code.');
      const codes = discountCodeList(current);
      if (codes.some(existing => codeKey(existing) === codeKey(code))) return current;
      return updateDiscountCodes(current.id, [...codes, code]);
    },
    async removeDiscountCode(code) {
      const current = await getMutationCart();
      if (!current.id || current.incomplete) throw new Error('The Shopify cart is unavailable. Please reload it before removing a code.');
      const codes = discountCodeList(current);
      if (!codes.some(existing => codeKey(existing) === codeKey(code))) return current;
      return updateDiscountCodes(current.id, codes.filter(existing => codeKey(existing) !== codeKey(code)));
    },
    async addProduct(productId, includeBreakIn, options = DEFAULT_BREAK_IN, merchandiseId = null, wristFit = 'regular') {
      const product = products.find(item => item.id === productId);
      if (!product?.merchandiseId || !product.available) throw new Error('This glove is not currently available from Shopify.');
      // A preorder that cannot be confirmed (missing or mismatched estimate) is never sold.
      if (preorderState(product).status === 'blocked') throw new Error('This glove is not currently available for preorder.');
      const fullSize = product.line === 'full-size';
      const variant = fullSize ? product.variants.find(variant => variant.id === merchandiseId && variant.availableForSale) : null;
      if (fullSize && !variant) throw new Error('Choose an available throw hand.');
      if (fullSize && includeBreakIn && options?.type !== 'full-size' || !fullSize && options?.type === 'full-size') throw new Error('Choose instructions for this glove type.');
      const selectedVariant = fullSize ? variant.id : product.merchandiseId;
      const serviceVariant = fullSize ? fullSizeVariant : breakInVariant;
      const selected = includeBreakIn ? normalizeBreakInOptions(options) : null;
      const lines = [{ merchandiseId: selectedVariant, quantity: 1, attributes: withWristFit(includeBreakIn
        ? gloveServiceAttributes(selected) : [{ key: SERVICE_ATTRIBUTE, value: 'none' }], wristFit) }];
      if (includeBreakIn) {
        if (!serviceVariant?.availableForSale) throw new Error('Break-in service is not currently available.');
        lines.push({ merchandiseId: serviceVariant.id, quantity: 1,
          attributes: serviceAttributes(selected), parent: { merchandiseId: selectedVariant } });
      }
      if (fullSize) {
        const hand = variant.selectedOptions?.find(option => option.name === 'Throwing Hand')?.value ||
          (product.throwHands.length === 1 && product.throwHands[0] === 'Right-Hand Throw' ? 'Right' : null);
        if (!hand) throw new Error('Shopify did not identify this variant’s throw hand.');
        const fulfillment = [{ key: 'Glove Model', value: product.name }, { key: 'Throwing Hand', value: hand }];
        if (includeBreakIn) lines[1].attributes.push(...fulfillment);
      }
      const cartId = storage?.getItem(SHOPIFY_CART_KEY);
      const before = cartId ? await getMutationCart() : emptyCart();
      const verifiedCartId = before.id;
      if (before.incomplete) throw new Error('The Shopify cart is incomplete. Checkout is unavailable until the cart is corrected.');
      const conflictingParent = includeBreakIn && before.lines.some(line => !line.isBreakIn &&
        line.merchandiseId === selectedVariant);
      let updated;
      // The existing lines of this variant are the only lines a stock warning may name for this add.
      const attemptedLineIds = before.lines.filter(line => !line.isBreakIn && line.merchandiseId === selectedVariant).map(line => line.remoteLineId);
      let ownMark = null;
      if (conflictingParent) {
        ownMark = markUnsafe(verifiedCartId, 'addition');
        let parentAdded = false;
        try {
          const sameAttributes = line => JSON.stringify([...line.attributes].sort((a, b) => a.key.localeCompare(b.key))) ===
            JSON.stringify([...lines[0].attributes].sort((a, b) => a.key.localeCompare(b.key)));
          const previous = before.lines.filter(line => !line.isBreakIn && line.merchandiseId === selectedVariant && sameAttributes(line));
          const previousQuantity = previous.reduce((sum, line) => sum + line.quantity, 0);
          const first = await addLines(verifiedCartId, [lines[0]]);
          parentAdded = true;
          if (await confirmStockRejection(before, first, attemptedLineIds, ownMark)) throw stockLimitError(productId, cartLineQuantity(before, productId, false));
          const matching = first.lines.filter(line => !line.isBreakIn && line.merchandiseId === selectedVariant &&
            sameAttributes(line));
          const attached = first.lines.filter(line => line.parentLineId === matching[0]?.remoteLineId);
          if (matching.length !== 1 || matching[0].quantity !== previousQuantity + 1 || attached.length > 1 ||
            attached.length > 0 && ![previousQuantity, previousQuantity + 1].includes(attached[0].quantity)) {
            markUnsafe(verifiedCartId, 'addition validation failed');
            throw new Error('Shopify could not identify the new glove configuration.');
          }
          if (attached[0]?.quantity === previousQuantity + 1) {
            if (!serviceAttributes(selected).every(attribute => attached[0].attributes.some(saved =>
              saved.key === attribute.key && saved.value === attribute.value))) {
              markUnsafe(verifiedCartId, 'addition validation failed');
              throw new Error('Shopify did not preserve the selected Break-In preferences.');
            }
            updated = first;
          } else updated = await addLines(verifiedCartId, [{ ...lines[1], parent: { lineId: matching[0].remoteLineId } }]);
          updated = await getRawCart();
        } catch (error) {
          if (error.code === 'stock-limit') throw error;
          if (parentAdded) markUnsafe(verifiedCartId, 'addition');
          else if (error.code !== 'uncertain') clearUnsafe(verifiedCartId, ownMark);
          throw error;
        }
      } else {
        updated = verifiedCartId ? await addLines(verifiedCartId, lines) : await createCart(lines);
        if (verifiedCartId && await confirmStockRejection(before, updated, attemptedLineIds)) throw stockLimitError(productId, cartLineQuantity(before, productId, false));
      }
      try { updated = await getRawCart(); }
      catch (error) { markUnsafe(updated.id, 'addition', before); throw error; }
      const expectedConfigurations = configurationSnapshot(before);
      const addedConfiguration = JSON.stringify([productId, selectedVariant, [...lines[0].attributes].sort((a, b) => a.key.localeCompare(b.key))]);
      expectedConfigurations.set(addedConfiguration, (expectedConfigurations.get(addedConfiguration) || 0) + 1);
      const actualConfigurations = configurationSnapshot(updated);
      const configuration = includeBreakIn ? 'break-in' : 'none';
      const configurationQuantity = cart => cart.lines.filter(line => line.productId === productId && !line.isBreakIn &&
        line.serviceConfiguration === configuration && (!includeBreakIn ||
          JSON.stringify([...line.attributes].sort((a, b) => a.key.localeCompare(b.key))) ===
          JSON.stringify([...lines[0].attributes].sort((a, b) => a.key.localeCompare(b.key))))).reduce((sum, line) => sum + line.quantity, 0);
      const checks = {
        cartComplete: !updated.incomplete,
        priorConfigurationsPreserved: expectedConfigurations.size === actualConfigurations.size && [...expectedConfigurations].every(([key, quantity]) => actualConfigurations.get(key) === quantity),
        gloveQuantityIncreased: cartLineQuantity(updated, productId, false) === cartLineQuantity(before, productId, false) + 1,
        serviceQuantityExpected: cartLineQuantity(updated, productId, true) ===
          cartLineQuantity(before, productId, true) + Number(includeBreakIn),
        selectedConfigurationIncreased: configurationQuantity(updated) === configurationQuantity(before) + 1,
        serviceAttributesPreserved: !includeBreakIn || updated.lines.some(child => child.isBreakIn &&
          child.productId === productId && serviceAttributes(selected).every(attribute =>
            child.attributes.some(saved => saved.key === attribute.key && saved.value === attribute.value)) &&
          updated.lines.some(parent => !parent.isBreakIn && parent.remoteLineId === child.parentLineId &&
            JSON.stringify([...parent.attributes].sort((a, b) => a.key.localeCompare(b.key))) ===
            JSON.stringify([...lines[0].attributes].sort((a, b) => a.key.localeCompare(b.key))))
        )
      };
      if (Object.values(checks).some(passed => !passed)) {
        const recoveryBefore = before.id ? before : { ...before, id: updated.id };
        const recoverablePartial = snapshotMatchesUnaffectedLines(updated, recoveryBefore, ['addition']);
        markUnsafe(updated.id, recoverablePartial ? 'addition' : 'addition validation failed', recoveryBefore);
        throw new Error('Shopify did not preserve the selected glove service configuration. Checkout is unavailable.');
      }
      if (conflictingParent) {
        clearUnsafe(verifiedCartId, ownMark);
        updated = applySafety(updated);
      }
      return updated;
    },
    async setLineQuantity(lineId, quantity) {
      const cart = await getMutationCart();
      const parent = cart.lines.find(line => line.remoteLineId === lineId && !line.isBreakIn);
      if (!parent) throw new Error('This glove line is no longer in the Shopify cart.');
      return setParentLineQuantity(cart, parent, quantity);
    },
    async removeLine(lineId) {
      const cart = await getMutationCart();
      const parent = cart.lines.find(line => line.remoteLineId === lineId && !line.isBreakIn);
      if (!parent) throw new Error('This glove line is no longer in the Shopify cart.');
      return removeParentLine(cart, parent);
    },
    // Options are the trainer customization the shopper confirmed in the cart; the
    // default exists only for callers that predate the cart customization form.
    async addBreakIn(lineId, options = null) {
      const cart = await getMutationCart();
      if (cart.incomplete) throw new Error('The Shopify cart is incomplete. Please reload it before changing Break-in service.');
      const parent = cart.lines.find(line => line.remoteLineId === lineId && !line.isBreakIn);
      if (!parent) throw new Error('This glove line is no longer in the Shopify cart.');
      const existing = cart.lines.find(line => line.isBreakIn && line.parentLineId === lineId);
      if (existing) {
        // Another tab may have serviced this glove with different choices; never report
        // that as the customer's confirmed selection.
        const requested = options && options.type !== 'full-size' ? normalizeBreakInOptions(options) : null;
        const attribute = key => existing.attributes?.find(item => item.key === key)?.value;
        if (requested && (attribute('Break-In Level') !== requested.level || attribute('Glove Wearing Style') !== requested.wearingStyle)) {
          throw new ShopifyRequestError('This glove already has Break-in service with different choices.', 'cart-changed');
        }
        return cart;
      }
      const fullSize = parent.productId.startsWith('full-');
      if (fullSize && options?.type !== 'full-size') throw new Error('Choose full-size break-in instructions for this glove.');
      if (!(fullSize ? fullSizeVariant : breakInVariant)?.availableForSale) throw new Error('Break-in service is not currently available.');
      const selectedOptions = normalizeBreakInOptions(options || DEFAULT_BREAK_IN);
      if (!fullSize && selectedOptions.type === 'full-size') throw new Error('Choose trainer break-in choices for this glove.');
      if (parent.quantity > 1) return splitBreakIn(cart, parent, 'add', selectedOptions);
      let started = false;
      try {
        await updateLines(cart.id, [{ id: parent.remoteLineId,
          attributes: withServiceAttribute(parent.attributes, 'break-in', selectedOptions) }], 'Break-In addition');
        started = true;
        let current = await getMutationCart();
        const selected = changedParent(cart, current, parent, 'break-in', false, selectedOptions);
        const children = current.lines.filter(line => line.isBreakIn && line.parentLineId === selected.remoteLineId);
        if (children.length > 1 || children[0]?.quantity > selected.quantity) throw new Error('Shopify returned inconsistent Break-in service lines.');
        if (!children.length) {
          await addLines(cart.id, [serviceLine(parent, selectedOptions, selected.quantity, selected.remoteLineId)], 'Break-In addition');
        } else if (children[0].quantity !== selected.quantity) {
          if (!children[0].instructions?.canUpdateQuantity) throw new Error('Shopify cannot synchronize Break-in service quantity.');
          await updateLines(cart.id, [{ id: children[0].remoteLineId, quantity: selected.quantity }], 'Break-In addition');
        }
        current = await getMutationCart();
        if (current.incomplete || !hasConsistentBreakInLines(current) ||
          cartLineQuantity(current, parent.productId, false) !== cartLineQuantity(cart, parent.productId, false) ||
          cartLineQuantity(current, parent.productId, true) !== cartLineQuantity(cart, parent.productId, true) + parent.quantity) {
          throw new Error('Shopify did not attach the Break-in service to the selected glove.');
        }
        verifyServiceChoices(cart, current);
        return current;
      } catch (error) {
        if (started) markUnsafe(cart.id, 'Break-In addition');
        throw error;
      }
    },
    async removeBreakIn(lineId) {
      const cart = await getMutationCart();
      if (cart.incomplete) throw new Error('The Shopify cart is incomplete. Please reload it before changing Break-in service.');
      const parent = cart.lines.find(line => line.remoteLineId === lineId && !line.isBreakIn);
      if (!parent) throw new Error('This glove line is no longer in the Shopify cart.');
      const child = cart.lines.find(line => line.isBreakIn && line.parentLineId === lineId);
      if (!child) return cart;
      if (parent.quantity > 1) return splitBreakIn(cart, parent, 'remove');
      if (!child.instructions?.canRemove) throw new Error('Shopify does not allow Break-in service to be removed.');
      let started = false;
      try {
        await removeLines(cart.id, [child.remoteLineId], 'Break-In removal');
        started = true;
        const afterRemoval = await getMutationCart();
        const selected = changedParent(cart, afterRemoval, parent, 'break-in', true);
        if (afterRemoval.lines.some(line => line.isBreakIn && line.parentLineId === selected.remoteLineId)) {
          throw new Error('Shopify did not remove the selected Break-in service.');
        }
        await updateLines(cart.id, [{ id: selected.remoteLineId,
          attributes: withServiceAttribute(selected.attributes, 'none') }], 'Break-In removal');
        const updated = await getMutationCart();
        if (updated.incomplete || !hasConsistentBreakInLines(updated) ||
          cartLineQuantity(updated, parent.productId, false) !== cartLineQuantity(cart, parent.productId, false) ||
          cartLineQuantity(updated, parent.productId, true) !== cartLineQuantity(cart, parent.productId, true) - child.quantity) {
          throw new Error('Shopify did not remove only the Break-in service.');
        }
        try { verifySplit(cart, updated, parent, withServiceAttribute(parent.attributes, 'none'), -1); }
        catch (error) { markUnsafe(cart.id, 'Break-In removal validation failed', cart); throw error; }
        return updated;
      } catch (error) {
        if (started) markUnsafe(cart.id, 'Break-In removal');
        throw error;
      }
    },
    // Replaces one glove's break-in choices. A line of several gloves changes one glove only.
    async editBreakIn(lineId, options) {
      const cart = await getMutationCart();
      if (cart.incomplete) throw new Error('The Shopify cart is incomplete. Please reload it before changing Break-in service.');
      const parent = cart.lines.find(line => line.remoteLineId === lineId && !line.isBreakIn);
      if (!parent) throw new Error('This glove line is no longer in the Shopify cart.');
      const child = cart.lines.find(line => line.isBreakIn && line.parentLineId === lineId);
      const current = savedBreakInOptions(cart.lines, parent);
      if (!child || !current) throw new Error('This glove has no break-in choices to change.');
      const fullSize = parent.productId.startsWith('full-');
      if (fullSize !== (options?.type === 'full-size')) throw new Error('Choose break-in instructions for this glove type.');
      const selectedOptions = normalizeBreakInOptions(options);
      if (JSON.stringify(selectedOptions) === JSON.stringify(current)) return cart;
      if (parent.quantity > 1) return splitBreakIn(cart, parent, 'change', selectedOptions);
      const { attributes: childAttributes } = serviceLine(parent, selectedOptions, child.quantity, parent.remoteLineId);
      // One request updates both lines; the service line goes first so a merge into an
      // identical glove line keeps the new choices. mutateCart marks an unanswered request.
      await updateLines(cart.id, [{ id: child.remoteLineId, attributes: childAttributes },
        { id: parent.remoteLineId, attributes: withServiceAttribute(parent.attributes, 'break-in', selectedOptions) }], SERVICE_CHANGE_KINDS.change);
      try {
        const updated = await getRawCart();
        verifySplit(cart, updated, parent, withServiceAttribute(parent.attributes, 'break-in', selectedOptions), 0);
        verifyServiceChoices(cart, updated);
        return applySafety(updated);
      } catch (error) {
        markUnsafe(cart.id, SERVICE_CHANGE_KINDS.change);
        throw error;
      }
    },
    // Sets one glove's wrist fit. A line of several gloves changes one glove only; break-in stays as it was.
    async setWristFit(lineId, fit) {
      const cart = await getMutationCart();
      if (cart.incomplete) throw new Error('The Shopify cart is incomplete. Please reload it before changing the wrist fit.');
      const parent = cart.lines.find(line => line.remoteLineId === lineId && !line.isBreakIn);
      if (!parent) throw new Error('This glove line is no longer in the Shopify cart.');
      if (wristFitOf(parent) === normalizeWristFit(fit)) return cart;
      const attributes = withWristFit(parent.attributes, fit);
      if (parent.quantity > 1) return splitWristFit(cart, parent, attributes);
      await updateLines(cart.id, [{ id: parent.remoteLineId, attributes }], WRIST_FIT_CHANGE);
      try {
        const updated = await getRawCart();
        verifySplit(cart, updated, parent, attributes, 0);
        verifyServiceChoices(cart, updated);
        return applySafety(updated);
      } catch (error) {
        markUnsafe(cart.id, WRIST_FIT_CHANGE);
        throw error;
      }
    },
    async setQuantity(productId, quantity) {
      const cart = await getMutationCart();
      const parents = cart.lines.filter(line => line.productId === productId && !line.isBreakIn);
      if (!parents.length) return cart;
      if (parents.length !== 1) throw new Error('Choose a specific glove cart entry to change its quantity.');
      return setParentLineQuantity(cart, parents[0], quantity);
    },
    async removeProduct(productId) {
      const cart = await getMutationCart();
      const parents = cart.lines.filter(line => line.productId === productId && !line.isBreakIn);
      if (!parents.length) return cart;
      if (parents.length !== 1) throw new Error('Choose a specific glove cart entry to remove.');
      return removeParentLine(cart, parents[0]);
    }
  };
  // Span the entire public operation, including all validation reads and paired service updates.
  // Never send a mutation unless its shared pending record can be persisted and enumerated.
  for (const name of ['addProduct', 'setLineQuantity', 'removeLine', 'addBreakIn', 'removeBreakIn', 'editBreakIn', 'setWristFit',
    'setQuantity', 'removeProduct', 'applyDiscountCode', 'removeDiscountCode']) {
    const operation = api[name];
    api[name] = (...args) => {
      const run = async () => {
        storageKeys();
        const cartId = storage.getItem(SHOPIFY_CART_KEY) || '*';
        const key = UNSAFE_RECORD_PREFIX + (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`);
        const kind = ({ addProduct: 'addition', setLineQuantity: 'quantity update', setQuantity: 'quantity update',
          removeLine: 'removal', removeProduct: 'removal', addBreakIn: SERVICE_CHANGE_KINDS.add,
          removeBreakIn: SERVICE_CHANGE_KINDS.remove, editBreakIn: SERVICE_CHANGE_KINDS.change, setWristFit: WRIST_FIT_CHANGE })[name] || 'discount update';
        const record = { cartId, kind: name, kinds: [kind], status: 'pending', createdAt: Date.now() };
        try { storage.setItem(key, JSON.stringify(record)); }
        catch (error) { unpersistedUnsafe.add(cartId); throw new ShopifyRequestError('Cart safety storage is unavailable.', 'uncertain', error); }
        if (storage.getItem(key) !== JSON.stringify(record)) throw new Error('Cart safety record could not be saved.');
        // Invalidate checks already in progress as well as checks that see this pending record.
        announceCartChange();
        ownPending.add(key);
        const activity = { sent: 0, key, record };
        activeOperations.add(activity);
        try {
          const result = await operation(...args);
          storage.removeItem(key);
          announceCartChange();
          return result;
        } catch (error) {
          // No request, a verified stock rejection, or a definitive first-request rejection
          // can retire this record. Ambiguous or partially completed operations stay blocked.
          if (!activity.sent || error.code === 'stock-limit' || activity.sent === 1 && (error.definitiveRejection || error.code === 'http-rejected')) storage.removeItem(key);
          else storage.setItem(key, JSON.stringify({ ...record, status: 'unresolved' }));
          throw error;
        } finally {
          ownPending.delete(key);
          activeOperations.delete(activity);
        }
      };
      return recoveryLocks?.request
        ? recoveryLocks.request('anawin-shopify-cart-recovery', { mode: 'shared' }, run)
        : run();
    };
  }
  return api;
}

export function createCommerce({ env = import.meta.env || {}, storage = globalThis.localStorage, fetchImpl = globalThis.fetch } = {}) {
  const config = validateShopifyConfig(env);
  return config ? createShopifyCommerce(config, storage, fetchImpl) : createLocalCommerce(storage);
}
