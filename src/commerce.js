import { breakInService, cartCustomizationIsComplete, DEFAULT_BREAK_IN, gloveServiceAttributes, localProducts, normalizeBreakInOptions, productHandleMap, serviceAttributes } from './catalog.js';
import { codeKey, discountCodeList } from './cart-discounts.js';

const LOCAL_CART_KEY = 'anawin-cart';
const SHOPIFY_CART_KEY = 'anawin-shopify-cart-id';
const CART_REVISION_KEY = 'anawin-shopify-cart-revision';
const SERVICE_ATTRIBUTE = '_anawin_service';
const UNSAFE_CART_KEY = 'anawin-shopify-unsafe-cart-id';
const PENDING_MUTATION_KEY = 'anawin-shopify-pending-mutation';
const LEGACY_PENDING_ADD_KEY = 'anawin-shopify-pending-addition';
const REQUEST_TIMEOUT_MS = 10000;

export class ShopifyRequestError extends Error {
  constructor(message, code, cause) {
    super(message, { cause });
    this.name = 'ShopifyRequestError';
    this.code = code;
  }
}

export function commerceErrorMessage(error, action = 'connect') {
  if (error?.code === 'uncertain') return 'We could not confirm your cart update. Check your cart before trying again.';
  if (error?.code === 'uncertain-create') return 'We could not confirm the new cart. Check your cart, then try adding again.';
  if (error?.code === 'timeout') return 'Shopify is taking too long to respond. Please try again.';
  if (error?.code === 'network') return 'Connection lost. Check your connection and try again.';
  if (error?.code === 'cart-changed') return 'Your cart changed in another tab. Check your cart before trying again.';
  if (error?.code === 'recovery-lock-unavailable') return 'Safe cart recovery is unavailable in this browser. Try again in a browser that supports Web Locks.';
  if (error?.code === 'recovery-ambiguous') return 'Your cart has changes we cannot safely copy. Check the original cart and try again.';
  if (action === 'add') return 'Couldn’t add to cart. Please try again.';
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
    const quantity = Math.max(0, Math.min(9, Number(value[product.id]) || 0));
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
    lines.push({ productId: product.id, quantity: item.quantity, merchandiseId: null });
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
    async addProduct(productId, includeBreakIn, options = DEFAULT_BREAK_IN) {
      const current = state.items[productId] || { quantity: 0, breakInQuantity: 0 };
      current.quantity = Math.min(9, current.quantity + 1);
      if (includeBreakIn) {
        current.breakInOptions = normalizeBreakInOptions(options);
        current.breakInQuantity = current.quantity;
      }
      state.items[productId] = current;
      save();
      return localCartFromState(state);
    },
    async setQuantity(productId, quantity) {
      const next = Math.max(0, Math.min(9, quantity));
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
  const handles = productHandleMap(env);
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
    variants(first: 1) { nodes { id availableForSale price { amount currencyCode } } }
  }
}`;

const CART_FIELDS = `
  id checkoutUrl
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
        parentRelationship { parent { id merchandise { ... on ProductVariant { id product { handle } } } } }
      }
      merchandise { ... on ProductVariant { id product { handle } } }
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
    return {
      remoteLineId: line.id,
      merchandiseId: line.merchandise.id,
      parentLineId: parentId || null,
      productId: handle === breakInHandle ? handleToProductId[parentHandle] : handleToProductId[handle],
      quantity: line.quantity,
      unitPrice: normalizeMoney(line.cost?.amountPerQuantity),
      lineSubtotal: normalizeMoney(line.cost?.subtotalAmount),
      lineTotal: normalizeMoney(line.cost?.totalAmount),
      allDiscountAllocations: normalizeAllocations(line.allDiscountAllocations),
      isBreakIn: handle === breakInHandle,
      attributes: line.attributes || [],
      serviceConfiguration: (line.attributes || []).find(attribute => attribute.key === SERVICE_ATTRIBUTE)?.value || null,
      instructions: line.instructions
    };
  }).filter(line => line.productId);
  const normalized = {
    id: cart.id,
    checkoutUrl: cart.checkoutUrl,
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

function withServiceAttribute(attributes, value) {
  const preserved = attributes.filter(attribute => ![SERVICE_ATTRIBUTE, '_anawin_break_in_level', '_anawin_wearing_style'].includes(attribute.key));
  const prior = {
    level: attributes.find(attribute => attribute.key === '_anawin_break_in_level')?.value,
    wearingStyle: attributes.find(attribute => attribute.key === '_anawin_wearing_style')?.value
  };
  const selected = prior.level && prior.wearingStyle ? prior : DEFAULT_BREAK_IN;
  return [...preserved, ...(value === 'break-in' ? gloveServiceAttributes(selected) : [{ key: SERVICE_ATTRIBUTE, value }])];
}

function matchingConfiguration(line, target, value) {
  return !line.isBreakIn && line.serviceConfiguration === value && line.merchandiseId === target.merchandiseId &&
    JSON.stringify([...line.attributes].sort((a, b) => a.key.localeCompare(b.key))) ===
    JSON.stringify(withServiceAttribute(target.attributes, value).sort((a, b) => a.key.localeCompare(b.key)));
}

function changedParent(before, after, target, value, excludeTarget = false) {
  const candidates = after.lines.filter(line => matchingConfiguration(line, target, value));
  const previousLines = before.lines.filter(line => matchingConfiguration(line, target, value) &&
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
  let remoteBreakInService = { ...breakInService, available: false };
  let lastVerifiedCart = null;
  let pendingMutation = null;
  try {
    const saved = JSON.parse(storage?.getItem(PENDING_MUTATION_KEY) || storage?.getItem(LEGACY_PENDING_ADD_KEY) || 'null');
    if (saved && typeof saved.cartId === 'string') pendingMutation = {
      cartId: saved.cartId, kind: typeof saved.kind === 'string' ? saved.kind : 'addition', status: 'unresolved',
      kinds: Array.isArray(saved.kinds) ? saved.kinds.filter(kind => typeof kind === 'string') : [],
      before: saved.before?.id === saved.cartId && Array.isArray(saved.before.lines) ? saved.before : null
    };
  } catch { /* Ignore malformed recovery metadata. */ }
  const clearPendingMutation = () => {
    pendingMutation = null;
    storage?.removeItem(PENDING_MUTATION_KEY);
    storage?.removeItem(LEGACY_PENDING_ADD_KEY);
  };
  const handleToProductId = Object.fromEntries(Object.entries(config.handles).map(([id, handle]) => [handle, id]));
  const request = (query, variables) => shopifyRequest(config, query, variables, fetchImpl);
  const announceCartChange = () => storage?.setItem(CART_REVISION_KEY, `${Date.now()}:${Math.random()}`);
  const markUnsafe = (cartId, kind = 'cart change', beforeOverride = null) => {
    if (!cartId || storage?.getItem(SHOPIFY_CART_KEY) !== cartId) return;
    let prior = null;
    try {
      if (storage?.getItem(UNSAFE_CART_KEY) === cartId) {
        const saved = JSON.parse(storage?.getItem(PENDING_MUTATION_KEY) || 'null');
        if (saved?.cartId === cartId) prior = saved;
      }
    } catch { /* Keep the cart blocked even if recovery metadata is malformed. */ }
    pendingMutation = { cartId, kind: prior?.kind || kind, status: 'unresolved',
      kinds: [...new Set([...(prior?.kinds || (prior?.kind ? [prior.kind] : [])), kind])],
      before: prior?.before || (beforeOverride?.id === cartId ? beforeOverride : null) ||
        (lastVerifiedCart?.id === cartId ? lastVerifiedCart : null) };
    storage?.setItem(UNSAFE_CART_KEY, cartId);
    storage?.setItem(PENDING_MUTATION_KEY, JSON.stringify(pendingMutation));
  };
  const clearUnsafe = cartId => {
    if (storage?.getItem(UNSAFE_CART_KEY) === cartId) {
      storage.removeItem(UNSAFE_CART_KEY);
      clearPendingMutation();
    }
  };
  const applySafety = cart => {
    try {
      const saved = JSON.parse(storage?.getItem(PENDING_MUTATION_KEY) || 'null');
      if (saved?.cartId === cart.id) pendingMutation = saved;
    } catch { /* A malformed note cannot make an unsafe cart safe. */ }
    if (cart.id && cart.incomplete && storage?.getItem(UNSAFE_CART_KEY) !== cart.id &&
      canRecoverWithoutService(cart)) markUnsafe(cart.id, 'service data unavailable');
    if (cart.id && !cart.incomplete && storage?.getItem(UNSAFE_CART_KEY) !== cart.id) {
      lastVerifiedCart = { id: cart.id, lines: cart.lines.map(line => ({
        remoteLineId: line.remoteLineId, parentLineId: line.parentLineId, merchandiseId: line.merchandiseId,
        productId: line.productId, isBreakIn: line.isBreakIn, quantity: line.quantity,
        attributes: line.attributes
      })), discountCodes: cart.discountCodes };
    }
    if (cart.id && storage?.getItem(UNSAFE_CART_KEY) === cart.id) {
      const serviceDataUnavailable = pendingMutation?.kinds?.includes('service data unavailable');
      cart.recoveryAvailable = !serviceDataUnavailable && !pendingMutation?.kinds?.some(kind => kind.endsWith('validation failed')) &&
        (!cart.incomplete || pendingMutation?.before?.id === cart.id &&
          snapshotMatchesUnaffectedLines(cart, pendingMutation.before,
            pendingMutation.kinds || [pendingMutation.kind]));
      cart.gloveOnlyRecoveryAvailable = serviceDataUnavailable && canRecoverWithoutService(cart);
      cart.recoveryHasBreakIn = cart.lines.some(line => line.isBreakIn) ||
        Boolean(pendingMutation?.before?.lines?.some(line => line.isBreakIn));
      cart.incomplete = true;
      cart.uncertainMutation = pendingMutation?.cartId === cart.id ? pendingMutation.kinds?.join(', ') || pendingMutation.kind : 'cart change';
    }
    if (!cart.id) { storage?.removeItem(UNSAFE_CART_KEY); clearPendingMutation(); }
    return cart;
  };

  async function loadProduct(handle) {
    const data = await request(PRODUCT_QUERY, { handle });
    if (!data.product?.variants.nodes[0]) throw new Error(`Shopify product “${handle}” was not found or has no variant.`);
    return data.product;
  }

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

  async function getCart() { return applySafety(await getRawCart()); }

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
      const unchanged = returned && !returned.incomplete && returned.id === expectedCartId &&
        lastVerifiedCart?.id === expectedCartId && cartStateStamp(returned) === cartStateStamp(lastVerifiedCart);
      if (expectedCartId && !unchanged) {
        markUnsafe(expectedCartId, kind);
        throw new ShopifyRequestError(`Shopify reported errors and did not confirm an unchanged cart: ${message}`, 'uncertain');
      }
      throw new Error(message);
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
    announceCartChange();
    return result;
  }

  const updateLines = (cartId, lines, kind = 'quantity update') => mutateCart(`mutation UpdateLines($cartId: ID!, $lines: [CartLineUpdateInput!]!) {
    cartLinesUpdate(cartId: $cartId, lines: $lines) { cart { ${CART_FIELDS} } userErrors { message } }
  }`, { cartId, lines }, 'cartLinesUpdate', kind);

  const addLines = (cartId, lines, kind = 'addition') => mutateCart(`mutation AddLines($cartId: ID!, $lines: [CartLineInput!]!) {
    cartLinesAdd(cartId: $cartId, lines: $lines) { cart { ${CART_FIELDS} } userErrors { message } }
  }`, { cartId, lines }, 'cartLinesAdd', kind);

  const removeLines = (cartId, lineIds, kind = 'removal') => mutateCart(`mutation RemoveLines($cartId: ID!, $lineIds: [ID!]!) {
    cartLinesRemove(cartId: $cartId, lineIds: $lineIds) { cart { ${CART_FIELDS} } userErrors { message } }
  }`, { cartId, lineIds }, 'cartLinesRemove', kind);

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
    const updated = await mutateCart(`mutation RemoveLines($cartId: ID!, $lineIds: [ID!]!) {
      cartLinesRemove(cartId: $cartId, lineIds: $lineIds) { cart { ${CART_FIELDS} } userErrors { message } }
    }`, { cartId: cart.id, lineIds: [parent.remoteLineId] }, 'cartLinesRemove', 'removal');
    if (updated.lines.some(line => line.parentLineId === parent.remoteLineId)) throw new Error('Shopify did not remove the nested Break-in service.');
    return updated;
  }

  async function setParentLineQuantity(cart, parent, quantity) {
    const next = Math.max(0, Math.min(9, quantity));
    if (next === parent.quantity) return cart;
    if (!next) return removeParentLine(cart, parent);
    if (!parent.instructions?.canUpdateQuantity) throw new Error('Shopify does not allow this glove quantity to change.');
    const update = lines => updateLines(cart.id, lines);
    const originalChild = cart.lines.find(line => line.isBreakIn && line.parentLineId === parent.remoteLineId);
    if (originalChild) markUnsafe(cart.id, 'quantity update');
    let firstMutationCompleted = false;
    try {
      let updated = await update([{ id: parent.remoteLineId, quantity: next }]);
      firstMutationCompleted = true;
      const updatedParent = updated.lines.find(line => line.remoteLineId === parent.remoteLineId);
      if (updatedParent?.quantity !== next) {
        if (originalChild) markUnsafe(cart.id, 'quantity validation failed');
        throw new Error('Shopify did not update the glove quantity.');
      }
      if (originalChild) {
        const child = updated.lines.find(line => line.isBreakIn && line.parentLineId === parent.remoteLineId);
        if (!child) {
          markUnsafe(cart.id, 'quantity validation failed');
          throw new Error('Shopify did not preserve the nested Break-in service.');
        }
        if (child.quantity !== next) {
          if (!child.instructions?.canUpdateQuantity) throw new Error('Shopify did not synchronize the Break-in service quantity.');
          updated = await update([{ id: child.remoteLineId, quantity: next }]);
          if (updated.lines.find(line => line.remoteLineId === child.remoteLineId)?.quantity !== next) {
            markUnsafe(cart.id, 'quantity validation failed');
            throw new Error('Shopify did not update the Break-in service quantity.');
          }
        }
        updated = await getRawCart();
        const finalParent = updated.lines.find(line => line.remoteLineId === parent.remoteLineId);
        const finalChild = updated.lines.find(line => line.isBreakIn && line.parentLineId === parent.remoteLineId);
        if (updated.incomplete || finalParent?.quantity !== next || finalChild?.quantity !== next) {
          markUnsafe(cart.id, 'quantity validation failed');
          throw new Error('Shopify did not preserve the glove and Break-in service quantities.');
        }
        clearUnsafe(cart.id);
        return applySafety(updated);
      }
      return updated;
    } catch (error) {
      if (originalChild && !firstMutationCompleted && error.code !== 'uncertain') clearUnsafe(cart.id);
      throw error;
    }
  }

  const configurationQuantity = (cart, source, value) => cart.lines
    .filter(line => matchingConfiguration(line, source, value))
    .reduce((sum, line) => sum + line.quantity, 0);

  function resolveAddedDestination(before, after, source, value) {
    const previous = before.lines.filter(line => matchingConfiguration(line, source, value));
    const candidates = after.lines.filter(line => matchingConfiguration(line, source, value));
    if (configurationQuantity(after, source, value) !== configurationQuantity(before, source, value) + 1) {
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

  function recoverySignature(cart) {
    const parents = new Map();
    for (const line of cart.lines.filter(line => !line.isBreakIn)) {
      const child = cart.lines.find(entry => entry.isBreakIn && entry.parentLineId === line.remoteLineId);
      const key = JSON.stringify([line.merchandiseId,
        [...line.attributes].sort((a, b) => a.key.localeCompare(b.key)), child?.merchandiseId || null]);
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
        normalizeBreakInOptions({
          level: line.attributes.find(attribute => attribute.key === '_anawin_break_in_level')?.value,
          wearingStyle: line.attributes.find(attribute => attribute.key === '_anawin_wearing_style')?.value
        });
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
        !Number.isInteger(changed[0].quantity) || changed[0].quantity < 1 || changed[0].quantity > 9) return false;
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
        ![SERVICE_ATTRIBUTE, '_anawin_break_in_level', '_anawin_wearing_style'].includes(attribute.key))
        .sort((a, b) => a.key.localeCompare(b.key)));
      if (otherAttributes(live) !== otherAttributes(oldLine)) return false;
      const serviceAttribute = line => line.attributes.filter(attribute => attribute.key === SERVICE_ATTRIBUTE);
      const oldService = serviceAttribute(oldLine);
      const liveService = serviceAttribute(live);
      if (oldService.length !== 1 || liveService.length !== 1 ||
        !['none', 'break-in'].includes(liveService[0].value)) return false;
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
        oldLine.merchandiseId === live.merchandiseId && oldLine.quantity === live.quantity) continue;
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
    const unsafeId = storage?.getItem(UNSAFE_CART_KEY);
    if (!unsafeId || storage?.getItem(SHOPIFY_CART_KEY) !== unsafeId) return getCart();
    const source = await getRawCart();
    if (source.id !== unsafeId) throw new Error('Shopify has not returned the original cart for recovery.');
    try {
      const saved = JSON.parse(storage?.getItem(PENDING_MUTATION_KEY) || 'null');
      if (saved?.cartId === unsafeId) pendingMutation = saved;
    } catch { /* Recovery can still use a structurally complete Shopify cart. */ }
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
    clearUnsafe(unsafeId);
    return applySafety(newCart);
  }

  async function recoverCart(options) {
    if (!recoveryLocks?.request) {
      throw new ShopifyRequestError('Exclusive cart recovery is unavailable in this browser.', 'recovery-lock-unavailable');
    }
    return recoveryLocks.request('anawin-shopify-cart-recovery', () => recoverCartUnchecked(options));
  }

  function verifySplit(before, after, source, destinationValue, serviceDelta) {
    if (after.id !== before.id || after.incomplete || !hasConsistentBreakInLines(after)) {
      throw new Error('Shopify returned an incomplete split cart.');
    }
    const oldQuantities = configurationSnapshot(before);
    const newQuantities = configurationSnapshot(after);
    const sourceKey = JSON.stringify([source.productId, source.merchandiseId,
      [...source.attributes].sort((a, b) => a.key.localeCompare(b.key))]);
    const destinationKey = JSON.stringify([source.productId, source.merchandiseId,
      withServiceAttribute(source.attributes, destinationValue).sort((a, b) => a.key.localeCompare(b.key))]);
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

  async function splitBreakIn(cart, parent, addService) {
    if (!parent.instructions?.canUpdateQuantity) throw new Error('Shopify does not allow this glove quantity to change.');
    markUnsafe(cart.id, addService ? 'Break-In addition' : 'Break-In removal');
    let firstMutationCompleted = false;
    try {
      let current;
      if (addService) {
        await addLines(cart.id, [{ merchandiseId: parent.merchandiseId, quantity: 1,
          attributes: withServiceAttribute(parent.attributes, 'break-in') }]);
        firstMutationCompleted = true;
        current = await getRawCart();
        let destination = resolveAddedDestination(cart, current, parent, 'break-in');
        const children = current.lines.filter(line => line.isBreakIn && line.parentLineId === destination.remoteLineId);
        if (children.length > 1 || children[0]?.quantity > destination.quantity) {
          throw new Error('Shopify returned inconsistent Break-in service children.');
        }
        if (!children.length) {
          await addLines(current.id, [{ merchandiseId: breakInVariant.id, quantity: destination.quantity,
            attributes: serviceAttributes(), parent: { lineId: destination.remoteLineId } }]);
        } else if (children[0].quantity !== destination.quantity) {
          if (!children[0].instructions?.canUpdateQuantity) throw new Error('Shopify cannot synchronize the Break-in service quantity.');
          await updateLines(current.id, [{ id: children[0].remoteLineId, quantity: destination.quantity }]);
        }
        current = await getRawCart();
        destination = resolveCurrentLine(current, destination);
        if (!current.lines.some(line => line.isBreakIn && line.parentLineId === destination.remoteLineId &&
          line.quantity === destination.quantity)) throw new Error('Shopify did not attach the Break-in service to the selected glove.');
        const source = resolveCurrentLine(current, parent);
        current = await decrementSplitSource(current, source, false);
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
      verifySplit(cart, current, parent, addService ? 'break-in' : 'none', addService ? 1 : -1);
      clearUnsafe(cart.id);
      return applySafety(current);
    } catch (error) {
      if (!firstMutationCompleted && error.code !== 'uncertain') clearUnsafe(cart.id);
      throw error;
    }
  }

  return {
    mode: 'shopify',
    async listProducts() {
      const entries = await Promise.all(Object.entries(config.handles).map(async ([id, handle]) => [id, await loadProduct(handle)]));
      products = localProducts.map(local => {
        const remote = entries.find(([id]) => id === local.id)[1];
        const variant = remote.variants.nodes[0];
        return { ...local, handle: remote.handle, shopifyProductGid: remote.id, merchandiseId: variant.id, price: Number(variant.price.amount), currencyCode: variant.price.currencyCode, available: variant.availableForSale };
      });
      return products;
    },
    async getBreakInService() {
      breakInVariant = null;
      remoteBreakInService = { ...breakInService, available: false };
      if (!config.breakInHandle) return remoteBreakInService;
      try {
        const service = await loadProduct(config.breakInHandle);
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
    getCart,
    readCartSafety() {
      let pendingCartId = null;
      try { pendingCartId = JSON.parse(storage?.getItem(PENDING_MUTATION_KEY) || 'null')?.cartId || null; }
      catch { pendingCartId = storage?.getItem(UNSAFE_CART_KEY) || null; }
      return { id: storage?.getItem(SHOPIFY_CART_KEY) || null,
        unsafeId: storage?.getItem(UNSAFE_CART_KEY) || null, pendingCartId,
        revision: storage?.getItem(CART_REVISION_KEY) || null };
    },
    async refreshCart() {
      return applySafety(await getRawCart());
    },
    recoverCart,
    async applyDiscountCode(input) {
      const code = input.trim();
      if (!code) throw new Error('Enter a discount code.');
      const current = await getCart();
      if (!current.id || current.incomplete) throw new Error('The Shopify cart is unavailable. Please reload it before applying a code.');
      const codes = discountCodeList(current);
      if (codes.some(existing => codeKey(existing) === codeKey(code))) return current;
      return updateDiscountCodes(current.id, [...codes, code]);
    },
    async removeDiscountCode(code) {
      const current = await getCart();
      if (!current.id || current.incomplete) throw new Error('The Shopify cart is unavailable. Please reload it before removing a code.');
      const codes = discountCodeList(current);
      if (!codes.some(existing => codeKey(existing) === codeKey(code))) return current;
      return updateDiscountCodes(current.id, codes.filter(existing => codeKey(existing) !== codeKey(code)));
    },
    async addProduct(productId, includeBreakIn, options = DEFAULT_BREAK_IN) {
      const product = products.find(item => item.id === productId);
      if (!product?.merchandiseId || !product.available) throw new Error('This glove is not currently available from Shopify.');
      const selected = includeBreakIn ? normalizeBreakInOptions(options) : null;
      const lines = [{ merchandiseId: product.merchandiseId, quantity: 1,
        attributes: includeBreakIn ? gloveServiceAttributes(selected) : [{ key: SERVICE_ATTRIBUTE, value: 'none' }] }];
      if (includeBreakIn) {
        if (!breakInVariant?.availableForSale) throw new Error('Break-in service is not currently available.');
        lines.push({ merchandiseId: breakInVariant.id, quantity: 1,
          attributes: serviceAttributes(selected), parent: { merchandiseId: product.merchandiseId } });
      }
      const cartId = storage?.getItem(SHOPIFY_CART_KEY);
      const before = cartId ? await getCart() : emptyCart();
      const verifiedCartId = before.id;
      if (before.incomplete) throw new Error('The Shopify cart is incomplete. Checkout is unavailable until the cart is corrected.');
      const conflictingParent = includeBreakIn && before.lines.some(line => !line.isBreakIn &&
        line.merchandiseId === product.merchandiseId && line.serviceConfiguration === 'break-in' &&
        JSON.stringify([...line.attributes].sort((a, b) => a.key.localeCompare(b.key))) !==
        JSON.stringify([...lines[0].attributes].sort((a, b) => a.key.localeCompare(b.key))));
      let updated;
      if (conflictingParent) {
        markUnsafe(verifiedCartId, 'addition');
        let parentAdded = false;
        try {
          const sameAttributes = line => JSON.stringify([...line.attributes].sort((a, b) => a.key.localeCompare(b.key))) ===
            JSON.stringify([...lines[0].attributes].sort((a, b) => a.key.localeCompare(b.key)));
          const previous = before.lines.filter(line => !line.isBreakIn && line.merchandiseId === product.merchandiseId && sameAttributes(line));
          const previousQuantity = previous.reduce((sum, line) => sum + line.quantity, 0);
          const first = await addLines(verifiedCartId, [lines[0]]);
          parentAdded = true;
          const matching = first.lines.filter(line => !line.isBreakIn && line.merchandiseId === product.merchandiseId &&
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
          if (parentAdded) markUnsafe(verifiedCartId, 'addition');
          else if (error.code !== 'uncertain') clearUnsafe(verifiedCartId);
          throw error;
        }
      } else updated = verifiedCartId ? await addLines(verifiedCartId, lines) : await createCart(lines);
      const configuration = includeBreakIn ? 'break-in' : 'none';
      const configurationQuantity = cart => cart.lines.filter(line => line.productId === productId && !line.isBreakIn &&
        line.serviceConfiguration === configuration && (!includeBreakIn ||
          JSON.stringify([...line.attributes].sort((a, b) => a.key.localeCompare(b.key))) ===
          JSON.stringify([...lines[0].attributes].sort((a, b) => a.key.localeCompare(b.key))))).reduce((sum, line) => sum + line.quantity, 0);
      const checks = {
        cartComplete: !updated.incomplete,
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
        markUnsafe(updated.id, 'addition validation failed', before);
        throw new Error('Shopify did not preserve the selected glove service configuration. Checkout is unavailable.');
      }
      if (conflictingParent) {
        clearUnsafe(verifiedCartId);
        updated = applySafety(updated);
      }
      return updated;
    },
    async setLineQuantity(lineId, quantity) {
      const cart = await getCart();
      const parent = cart.lines.find(line => line.remoteLineId === lineId && !line.isBreakIn);
      if (!parent) throw new Error('This glove line is no longer in the Shopify cart.');
      return setParentLineQuantity(cart, parent, quantity);
    },
    async removeLine(lineId) {
      const cart = await getCart();
      const parent = cart.lines.find(line => line.remoteLineId === lineId && !line.isBreakIn);
      if (!parent) throw new Error('This glove line is no longer in the Shopify cart.');
      return removeParentLine(cart, parent);
    },
    async addBreakIn(lineId) {
      const cart = await getCart();
      if (cart.incomplete) throw new Error('The Shopify cart is incomplete. Please reload it before changing Break-in service.');
      const parent = cart.lines.find(line => line.remoteLineId === lineId && !line.isBreakIn);
      if (!parent) throw new Error('This glove line is no longer in the Shopify cart.');
      if (cart.lines.some(line => line.isBreakIn && line.parentLineId === lineId)) return cart;
      if (!breakInVariant?.availableForSale) throw new Error('Break-in service is not currently available.');
      if (parent.quantity > 1) return splitBreakIn(cart, parent, true);
      let started = false;
      try {
        await updateLines(cart.id, [{ id: parent.remoteLineId,
          attributes: withServiceAttribute(parent.attributes, 'break-in') }], 'Break-In addition');
        started = true;
        let current = await getCart();
        const selected = changedParent(cart, current, parent, 'break-in');
        const children = current.lines.filter(line => line.isBreakIn && line.parentLineId === selected.remoteLineId);
        if (children.length > 1 || children[0]?.quantity > selected.quantity) throw new Error('Shopify returned inconsistent Break-in service lines.');
        if (!children.length) {
          await addLines(cart.id, [{ merchandiseId: breakInVariant.id, quantity: selected.quantity,
            attributes: serviceAttributes(), parent: { lineId: selected.remoteLineId } }], 'Break-In addition');
        } else if (children[0].quantity !== selected.quantity) {
          if (!children[0].instructions?.canUpdateQuantity) throw new Error('Shopify cannot synchronize Break-in service quantity.');
          await updateLines(cart.id, [{ id: children[0].remoteLineId, quantity: selected.quantity }], 'Break-In addition');
        }
        current = await getCart();
        if (current.incomplete || !hasConsistentBreakInLines(current) ||
          cartLineQuantity(current, parent.productId, false) !== cartLineQuantity(cart, parent.productId, false) ||
          cartLineQuantity(current, parent.productId, true) !== cartLineQuantity(cart, parent.productId, true) + parent.quantity) {
          throw new Error('Shopify did not attach the Break-in service to the selected glove.');
        }
        return current;
      } catch (error) {
        if (started) markUnsafe(cart.id, 'Break-In addition');
        throw error;
      }
    },
    async removeBreakIn(lineId) {
      const cart = await getCart();
      if (cart.incomplete) throw new Error('The Shopify cart is incomplete. Please reload it before changing Break-in service.');
      const parent = cart.lines.find(line => line.remoteLineId === lineId && !line.isBreakIn);
      if (!parent) throw new Error('This glove line is no longer in the Shopify cart.');
      const child = cart.lines.find(line => line.isBreakIn && line.parentLineId === lineId);
      if (!child) return cart;
      if (parent.quantity > 1) return splitBreakIn(cart, parent, false);
      if (!child.instructions?.canRemove) throw new Error('Shopify does not allow Break-in service to be removed.');
      let started = false;
      try {
        await removeLines(cart.id, [child.remoteLineId], 'Break-In removal');
        started = true;
        const afterRemoval = await getCart();
        const selected = changedParent(cart, afterRemoval, parent, 'break-in', true);
        if (afterRemoval.lines.some(line => line.isBreakIn && line.parentLineId === selected.remoteLineId)) {
          throw new Error('Shopify did not remove the selected Break-in service.');
        }
        await updateLines(cart.id, [{ id: selected.remoteLineId,
          attributes: withServiceAttribute(selected.attributes, 'none') }], 'Break-In removal');
        const updated = await getCart();
        if (updated.incomplete || !hasConsistentBreakInLines(updated) ||
          cartLineQuantity(updated, parent.productId, false) !== cartLineQuantity(cart, parent.productId, false) ||
          cartLineQuantity(updated, parent.productId, true) !== cartLineQuantity(cart, parent.productId, true) - child.quantity) {
          throw new Error('Shopify did not remove only the Break-in service.');
        }
        return updated;
      } catch (error) {
        if (started) markUnsafe(cart.id, 'Break-In removal');
        throw error;
      }
    },
    async setQuantity(productId, quantity) {
      const cart = await getCart();
      const parents = cart.lines.filter(line => line.productId === productId && !line.isBreakIn);
      if (!parents.length) return cart;
      if (parents.length !== 1) throw new Error('Choose a specific glove cart entry to change its quantity.');
      return setParentLineQuantity(cart, parents[0], quantity);
    },
    async removeProduct(productId) {
      const cart = await getCart();
      const parents = cart.lines.filter(line => line.productId === productId && !line.isBreakIn);
      if (!parents.length) return cart;
      if (parents.length !== 1) throw new Error('Choose a specific glove cart entry to remove.');
      return removeParentLine(cart, parents[0]);
    }
  };
}

export function createCommerce({ env = import.meta.env || {}, storage = globalThis.localStorage, fetchImpl = globalThis.fetch } = {}) {
  const config = validateShopifyConfig(env);
  return config ? createShopifyCommerce(config, storage, fetchImpl) : createLocalCommerce(storage);
}
