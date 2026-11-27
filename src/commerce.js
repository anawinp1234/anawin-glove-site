import { fullSizeProducts, fullSizeBreakInService, preorderState, preorderOrderAttributeValue, PREORDER_ORDER_ATTRIBUTE, FULL_SIZE_SERVICE_HANDLE, FULL_SIZE_SERVICE_VARIANT, FULL_SIZE_SERVICE_PRODUCT, FULL_SIZE_CONFIGURATION_KEY, SERVICE_ATTRIBUTE_KEYS, optionsFromAttributes, breakInService, cartCustomizationIsComplete, savedBreakInOptions, DEFAULT_BREAK_IN, gloveServiceAttributes, localProducts, normalizeBreakInOptions, productHandleMap, serviceAttributes, WRIST_FIT_KEY, normalizeWristFit, withWristFit, wristFitOf } from './catalog.js';
import { codeKey, discountCodeList } from './cart-discounts.js';
import { checkoutCartIsComplete, verifiedCheckoutUrl } from './checkout-safety.js';

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
// One exclusive Web Lock serializes every cart write across this browser profile's tabs. It cannot
// coordinate other devices, profiles, storage partitions or clients that do not take it.
const CART_LOCK = 'anawin-shopify-cart-recovery';
// A paired Break-In split is the longest operation: several requests, each with its own timeout.
const LOCK_WAIT_MS = 90000;
const CREATE_PENDING = '*';
const RECOVERY_KIND = 'recovery';
// A first cart whose Shopify contents differ from what was added; only the shopper's explicit choice resolves it.
const CREATE_MISMATCH = 'first cart mismatch';
// The journal format written by this build. Records without `v` are read as earlier (2G) records.
const JOURNAL_VERSION = 2;
// The target of a recovery create: a new cart whose ID is not yet known and must differ from the source.
const RECOVERY_TARGET = '+recovery';

function requestedQuantity(value) {
  const quantity = Number(value);
  if (!Number.isSafeInteger(quantity) || quantity < 0) throw new Error('Quantity must be a non-negative whole number.');
  return quantity;
}

// Steppers send one-unit intents; a larger or fractional step is a caller error, not a quantity.
function stepDelta(value) {
  const delta = Number(value);
  if (delta !== 1 && delta !== -1) throw new Error('Quantity steps must be +1 or -1.');
  return delta;
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
  if (error?.code === 'checkout-url-invalid') return 'We couldn’t open secure checkout. Check your cart and try again.';
  if (error?.code === 'stock-limit') return error.message;
  if (error?.code === 'uncertain') return 'We could not confirm your cart update. Check your cart before trying again.';
  if (error?.code === 'uncertain-create' || error?.code === 'create-unresolved') {
    return 'We could not confirm whether Shopify saved your new cart, so your item may not have been added. Choose “Start a new cart” before adding it again.';
  }
  if (error?.code === 'create-reconcile-required') return 'Shopify may already hold your new cart. Choose “Check unconfirmed cart” before starting another one.';
  if (error?.code === 'hand-mismatch') return 'A glove in your cart no longer matches the throwing hand you chose. Check your cart before checkout.';
  if (error?.code === 'cart-unverified') return 'Shopify didn’t return your cart in a form we could check. Please try again.';
  if (error?.code === 'create-mismatch') return 'Shopify saved different items than you added. Keep the items Shopify saved, or start a new cart.';
  if (error?.code === 'recovery-mode-mismatch') return 'An earlier recovery attempt was started with a different Break-In Service choice. Choose “Try recovery again” or “Start over without Break-In Service”.';
  if (error?.code === 'cart-unresolved') return 'An earlier cart update has not been confirmed. Check your cart before trying again.';
  if (error?.code === 'recovery-unconfirmed') return 'We could not confirm the new cart from an earlier recovery attempt. Choose “Try recovery again” to start a fresh one.';
  if (error?.code === 'lock-unavailable') return 'Your cart can’t be changed safely in this browser. Try an up-to-date browser with site data turned on.';
  if (error?.code === 'lock-timeout') return 'Your cart is still being updated in another tab. Wait a moment, then try again.';
  if (error?.code === 'storage-unavailable') return 'Your browser is blocking site storage, so your cart can’t be changed safely. Allow site data for this site, then reload the page.';
  if (error?.code === 'discount-unconfirmed') return 'Shopify did not confirm the discount change. Check your cart before trying again.';
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
    // A relative step applies to the stored cart, which another tab may have changed.
    async adjustQuantity(productId, delta) {
      state = readLocalState(storage);
      return this.setQuantity(productId, Math.max(0, (state.items[productId]?.quantity || 0) + stepDelta(delta)));
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
  const handles = { ...productHandleMap(env), ...Object.fromEntries(fullSizeProducts.filter(product => env[`VITE_SHOPIFY_${product.name}_HANDLE`]).map(product => [product.id, env[`VITE_SHOPIFY_${product.name}_HANDLE`]])) };
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
        // Only a well-formed envelope is an answer: an object whose `errors` is absent or an empty
        // array, and whose `data` is an object. Anything else is ambiguous, never "no data".
        if (!payload || typeof payload !== 'object') throw new ShopifyRequestError('Shopify returned a malformed response.', 'graphql');
        // Partial data beside errors is not an answer, but it can still name a cart Shopify created, so it
        // travels with the error as evidence (`partialData`) for the caller to journal.
        const envelopeError = message => Object.assign(new ShopifyRequestError(message, 'graphql'),
          payload.data && typeof payload.data === 'object' ? { partialData: payload.data } : {});
        if (payload.errors !== undefined) {
          if (!Array.isArray(payload.errors)) throw envelopeError('Shopify returned malformed errors.');
          if (payload.errors.length) throw envelopeError(payload.errors.map(error => error?.message).join(' '));
        }
        if (!payload.data || typeof payload.data !== 'object') throw new ShopifyRequestError('Shopify returned no data.', 'graphql');
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


// The cart selection, checked against Storefront API 2026-07: `Cart.discountApplications` is
// `[BaseCartDiscountApplication!]!` (code, automatic and custom implementers), line allocations are the
// `CartDiscountAllocation` interface (code or title per implementer), `lines` is a `BaseCartLineConnection`
// with `PageInfo { hasNextPage endCursor }`, and `CartLine.parentRelationship.parent` is a `CartLine`.
const VARIANT_FIELDS = '... on ProductVariant { id selectedOptions { name value } product { handle } }';
const cartFields = lineArguments => `
  id checkoutUrl
  attributes { key value }
  cost { subtotalAmount { amount currencyCode } }
  discountCodes { code applicable }
  discountApplications {
    __typename targetType
    value { __typename ... on PricingPercentageValue { percentage } ... on MoneyV2 { amount currencyCode } }
    ... on CartCodeDiscountApplication { code }
    ... on CartAutomaticDiscountApplication { title }
    ... on CartCustomDiscountApplication { title }
  }
  lines(${lineArguments}) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id quantity attributes { key value }
      cost { amountPerQuantity { amount currencyCode } subtotalAmount { amount currencyCode } totalAmount { amount currencyCode } }
      allDiscountAllocations: discountAllocations(lineLevelOnly: false) {
        __typename discountedAmount { amount currencyCode } targetType
        ... on CartCodeDiscountAllocation { code }
        ... on CartAutomaticDiscountAllocation { title }
        ... on CartCustomDiscountAllocation { title }
      }
      ... on CartLine {
        instructions { canRemove canUpdateQuantity }
        parentRelationship { parent { id merchandise { ${VARIANT_FIELDS} } } }
      }
      merchandise { ${VARIANT_FIELDS} }
    }
  }
`;
// A mutation reply carries one page; it is never trusted for content beyond the narrow unchanged-rejection proof.
const CART_FIELDS = cartFields('first: 50');
const CART_PAGE_QUERY = `query Cart($id: ID!, $after: String) { cart(id: $id) { ${cartFields('first: 50, after: $after')} } }`;
// Local fail-closed bounds, not Shopify guarantees: at most 50 pages of 50 lines per read.
const MAX_CART_PAGES = 50;

// A Storefront cart ID is opaque and must be used whole, including its secret `key` parameter. Only the
// production type `gid://shopify/Cart/`, a nonempty token and a nonempty `key` are required; the token alphabet
// and length are not assumed. Raw whitespace, control characters, backslashes and fragments are refused.
const CART_GID_PREFIX = 'gid://shopify/Cart/';
export function trustedCartId(value) {
  if (typeof value !== 'string' || !value.startsWith(CART_GID_PREFIX) || /[\u0000- \u007f\\#]/.test(value)) return null;
  const rest = value.slice(CART_GID_PREFIX.length);
  const query = rest.indexOf('?');
  if (query <= 0 || rest.slice(0, query).includes('/')) return null;
  const parameters = rest.slice(query + 1).split('&');
  return parameters.some(parameter => parameter.startsWith('key=') && parameter.length > 'key='.length) ? value : null;
}

// Storefront API 2026-07 `CurrencyCode` values (including deprecated ones still returned), without XXX.
const STOREFRONT_CURRENCIES = new Set(('AED AFN ALL AMD AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD ' +
  'CAD CDF CHF CLP CNY COP CRC CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HRK HTG ' +
  'HUF IDR ILS INR IQD IRR ISK JEP JMD JOD JPY KES KGS KHR KID KMF KRW KWD KYD KZT LAK LBP LKR LRD LSL LTL LVL LYD MAD MDL MGA ' +
  'MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR ' +
  'SBD SCR SDG SEK SGD SHP SLL SOS SRD SSP STN SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD UYU UZS VED VES VND VUV ' +
  'WST XAF XCD XCG XOF XPF YER ZAR ZMW ANG BYR STD VEF').split(' '));
const TARGET_TYPES = new Set(['LINE_ITEM', 'SHIPPING_LINE']);
// MoneyV2.amount is a Decimal serialized as a string: unsigned digits with an optional fraction, nothing else.
const DECIMAL_PATTERN = /^[0-9]+(?:\.[0-9]+)?$/;
// The canonical form for comparison: insignificant zeroes trimmed, never a round trip through Number.
export function canonicalDecimal(value) {
  const [whole, fraction = ''] = value.split('.');
  const integer = whole.replace(/^0+(?=[0-9])/, '');
  const decimals = fraction.replace(/0+$/, '');
  return decimals ? `${integer}.${decimals}` : integer;
}
// A validated MoneyV2: { amount, currencyCode } for display plus its canonical string, or null.
function strictMoney(value) {
  if (!plainObject(value) || typeof value.amount !== 'string' || !DECIMAL_PATTERN.test(value.amount) ||
    typeof value.currencyCode !== 'string' || !STOREFRONT_CURRENCIES.has(value.currencyCode)) return null;
  const canonical = canonicalDecimal(value.amount);
  const amount = Number(value.amount);
  if (!Number.isFinite(amount) || amount === 0 && canonical !== '0') return null;
  return { amount, currencyCode: value.currencyCode, canonical };
}
function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
// A list of unique, nonempty keys with string values (cart and line attributes) or option names and values.
function validPairs(value, keyField, valueField) {
  if (!Array.isArray(value)) return null;
  const seen = new Set();
  for (const entry of value) {
    if (!plainObject(entry) || typeof entry[keyField] !== 'string' || !entry[keyField] || typeof entry[valueField] !== 'string' ||
      seen.has(entry[keyField])) return null;
    seen.add(entry[keyField]);
  }
  return value.map(entry => ({ [keyField]: entry[keyField], [valueField]: entry[valueField] }));
}
// Error text for the shopper: only nonempty primitive strings, never coerced objects.
const FALLBACK_MESSAGE = 'Shopify did not confirm the cart change.';
function replyMessage(...lists) {
  const messages = lists.flatMap(list => Array.isArray(list) ? list : [])
    .map(entry => plainObject(entry) && typeof entry.message === 'string' && entry.message.trim() ? entry.message.trim() : null).filter(Boolean);
  return messages.length ? messages.join(' ') : FALLBACK_MESSAGE;
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


function variantHand(selectedOptions, fallback) {
  const hands = [...new Set((Array.isArray(selectedOptions) ? selectedOptions : [])
    .filter(option => option?.name === 'Throwing Hand').map(option => option.value))];
  return hands.length === 1 ? hands[0] : hands.length ? null : fallback;
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

const sortedAttributes = attributes => [...(attributes || [])].sort((a, b) => a.key.localeCompare(b.key));

// What makes a cart glove that glove: its merchandise, every option attribute, and its attached
// service line. A quantity step names this so it never lands on a different configuration.
export function cartLineIdentity(lines, parent) {
  const child = lines.find(line => line.isBreakIn && line.parentLineId === parent.remoteLineId);
  return JSON.stringify([parent.productId, parent.merchandiseId, sortedAttributes(parent.attributes),
    child?.merchandiseId || null, child ? sortedAttributes(child.attributes) : null]);
}

export function createShopifyCommerce(config, storage, fetchImpl = fetch, recoveryLocks = globalThis.navigator?.locks) {
  let products = [];
  let breakInVariant = null;
  let fullSizeVariant = null;
  let fullSizeService = { ...fullSizeBreakInService, available: false };
  let remoteBreakInService = { ...breakInService, available: false };
  // The catalog evidence every cart read is validated against (Shopify's product data, read-only).
  let catalog = null;
  let catalogLoad = null;
  // Carts this tab must keep blocked because a record about them could not be persisted.
  const unpersistedUnsafe = new Set();
  // First-cart IDs Shopify returned that storage refused to journal, by owning record key and step.
  const unpersistedCandidates = new Map();
  const legacyRecordKeys = [PENDING_MUTATION_KEY, LEGACY_PENDING_ADD_KEY];
  const handleToProductId = Object.fromEntries(Object.entries(config.handles).map(([id, handle]) => [handle, id]));
  const endpoint = `https://${config.domain}/api/${config.apiVersion}/graphql.json`;

  // ---- Exact-value storage primitives ----
  // localStorage has no compare-and-swap against nonparticipants; Web Locks serialize participants. Every
  // transition therefore compares exact bytes immediately before acting and reads back after it.
  const storageFailure = (message, cause) => new ShopifyRequestError(message, 'storage-unavailable', cause);
  const conflict = message => new ShopifyRequestError(message, 'cart-changed');
  const readKey = key => {
    try { return storage.getItem(key); } catch (error) { throw storageFailure('Cart storage is unavailable.', error); }
  };
  const storageKeys = () => {
    try {
      if (!storage || !Number.isInteger(storage.length) || typeof storage.key !== 'function') throw new Error('Cart storage is unavailable.');
      const keys = [];
      for (let index = 0; index < storage.length; index++) keys.push(storage.key(index));
      return keys;
    } catch (error) { throw storageFailure('Cart storage is unavailable.', error); }
  };
  // The active pointer and the raw bytes of every journal record and legacy key (a superset of every relevant record).
  function snapshotSafety() {
    if (!storage) throw storageFailure('Cart storage is unavailable.');
    const entries = new Map();
    for (const key of storageKeys()) if (key?.startsWith(UNSAFE_RECORD_PREFIX)) entries.set(key, readKey(key));
    for (const key of [...legacyRecordKeys, UNSAFE_CART_KEY]) {
      const raw = readKey(key);
      if (raw !== null) entries.set(key, raw);
    }
    return { pointer: readKey(SHOPIFY_CART_KEY), entries };
  }
  // Membership and exact bytes must match; called synchronously right before every local effect.
  function assertSafetySnapshot(expected) {
    const current = snapshotSafety();
    if (current.pointer !== expected.pointer || current.entries.size !== expected.entries.size ||
      [...expected.entries].some(([key, raw]) => current.entries.get(key) !== raw)) {
      throw conflict('The cart’s safety records changed while it was being checked.');
    }
  }
  // Writes `value` only if the key still holds exactly `expected` (null: absent), then reads it back.
  function writeOwnedRecord(snapshot, key, value, expected) {
    const raw = typeof value === 'string' ? value : JSON.stringify(value);
    if (readKey(key) !== expected) throw conflict('A cart safety record changed before it could be updated.');
    try { storage.setItem(key, raw); } catch (error) { throw storageFailure('Cart safety storage is unavailable.', error); }
    if (readKey(key) !== raw) throw storageFailure('Cart safety record could not be saved.');
    snapshot?.entries.set(key, raw);
    return raw;
  }
  function removeOwnedRecord(snapshot, key, expected) {
    if (readKey(key) !== expected) throw conflict('A cart safety record changed before it could be removed.');
    try { storage.removeItem(key); } catch (error) { throw storageFailure('Cart safety storage is unavailable.', error); }
    if (readKey(key) !== null) throw storageFailure('Cart safety record could not be removed.');
    snapshot?.entries.delete(key);
  }
  function setPointer(snapshot, next, expected) {
    if (readKey(SHOPIFY_CART_KEY) !== expected) throw conflict('The active cart changed.');
    try { if (next === null) storage.removeItem(SHOPIFY_CART_KEY); else storage.setItem(SHOPIFY_CART_KEY, next); }
    catch (error) { throw storageFailure('The active cart could not be saved.', error); }
    if (readKey(SHOPIFY_CART_KEY) !== next) throw storageFailure('The active cart could not be saved.');
    if (snapshot) snapshot.pointer = next;
  }
  // Revision is a notification, never ownership. Before dispatch it must land (`strict`).
  const announceCartChange = (strict = false) => {
    const value = `${Date.now()}:${Math.random()}`;
    try {
      storage?.setItem(CART_REVISION_KEY, value);
      if (strict && storage?.getItem(CART_REVISION_KEY) !== value) throw new Error('Cart revision did not persist.');
    } catch (error) { if (strict) throw error; }
  };

  // ---- Records and admission ----
  const parseRecord = (key, raw) => {
    let record = null;
    try { record = JSON.parse(raw); } catch { /* malformed below */ }
    if (!plainObject(record) || typeof record.cartId !== 'string') return { key, raw, malformed: true, kinds: ['cart change'] };
    return { ...record, key, raw };
  };
  // Every cart ID a record keeps discoverable, including copies embedded by earlier (2G) supersession.
  function knownCartIds(raw, depth = 0) {
    const ids = new Set();
    let record = null;
    try { record = JSON.parse(raw); } catch { return ids; }
    if (!plainObject(record) || depth > 4) return ids;
    for (const id of [record.cartId, record.candidateCartId, ...(record.candidateCartIds || []), record.recovery?.candidateCartId,
      ...(record.conflictingIds || []), record.adopting?.candidate, record.absentCartId]) if (trustedCartId(id)) ids.add(id);
    for (const entry of [...(record.recovery?.supersededRecords || []), ...(record.recovery?.supersedes || [])]) {
      const embedded = typeof entry?.value === 'string' ? entry.value : typeof entry?.raw === 'string' ? entry.raw : null;
      if (embedded) for (const id of knownCartIds(embedded, depth + 1)) ids.add(id);
    }
    return ids;
  }
  // A record that proves its operation sent nothing: a new-format prepared record with no armed step and no
  // evidence, or a 2G `dispatched: false` pending record with no candidate or historical evidence.
  const provablyUndispatched = record => !record.malformed && record.dispatched === false && !record.step &&
    record.status === (record.v === JOURNAL_VERSION ? 'prepared' : 'pending') && !record.candidateCartId &&
    !record.candidateCartIds?.length && !record.createIntent && !record.recovery?.candidateCartId && !record.recovery?.supersededRecords?.length;
  const recordCandidates = record => [record.candidateCartId, ...(record.candidateCartIds || []), record.recovery?.candidateCartId,
    record.adopting?.candidate].filter(id => typeof id === 'string');
  // Whether a live record gates `cartId` (null: no active cart). Unreadable records gate everything; a first-cart
  // record (`*`) gates every cart; an adopting record gates its candidate as well as its source.
  const recordApplies = (record, cartId) => record.malformed || record.cartId === CREATE_PENDING || record.cartId === cartId ||
    Boolean(cartId) && (record.status === 'adopting' || record.recovery?.stage === 'adopting') && recordCandidates(record).includes(cartId);
  function liveRecords(snapshot, cartId, exclude = null) {
    const records = [];
    for (const [key, raw] of snapshot.entries) {
      if (key === exclude) continue;
      if (key === UNSAFE_CART_KEY) { if (raw === cartId) records.push({ key, raw, legacy: true, summary: true, kinds: ['cart change'] }); continue; }
      const record = parseRecord(key, raw);
      if (legacyRecordKeys.includes(key)) {
        if (record.malformed || record.cartId === cartId) records.push({ ...record, legacy: true });
        continue;
      }
      if (record.status === 'terminal' || provablyUndispatched(record)) continue;
      if (recordApplies(record, cartId)) records.push(record);
    }
    return records;
  }
  const safeSnapshot = () => { try { return snapshotSafety(); } catch { return null; } };
  // The combined unresolved state of a cart, or null when nothing gates it. Unreadable storage counts as unsafe.
  function pendingFor(cartId, { snapshot = safeSnapshot(), exclude = null } = {}) {
    if (!snapshot) return { cartId, kind: 'cart change', kinds: ['cart change'], before: null, records: [], status: 'unresolved', unreadable: true };
    const records = liveRecords(snapshot, cartId, exclude);
    if (!records.length && !unpersistedUnsafe.has(cartId) && !(cartId === null && unpersistedCandidates.size)) return null;
    const ordered = [...records].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const kinds = [...new Set(ordered.flatMap(record => Array.isArray(record.kinds) ? record.kinds : record.kind ? [record.kind] : []))];
    const before = ordered.find(record => record.before?.id === cartId && Array.isArray(record.before.lines))?.before || null;
    return { cartId, kind: ordered[0]?.kind || 'cart change', kinds: kinds.length ? kinds : ['cart change'], before, records, status: 'unresolved' };
  }
  const firstCartRecords = (snapshot, exclude = null) => liveRecords(snapshot, null, exclude).filter(record => !record.legacy);
  // Records that only freeze a cart for a checkout handoff.
  const onlyCheckoutFreeze = records => records.length > 0 && records.every(record => !record.malformed && !record.legacy &&
    Array.isArray(record.kinds) && record.kinds.length > 0 && record.kinds.every(kind => kind === 'checkout handoff'));
  const RECOVERY_STAGES = ['create', 'created', 'children', 'adopting'];
  // The attempts still in force. A dispatched attempt supersedes the exact earlier versions it names (2H), or
  // the keys it names (2G); a changed earlier record is no longer matched, so both stay current and ambiguous.
  const currentAttempts = attempts => attempts.filter(attempt => !attempts.some(other => other !== attempt && other.dispatched !== false &&
    (other.recovery?.supersedes || []).some(link => typeof link === 'string' ? link === attempt.key : link?.key === attempt.key && link.raw === attempt.raw)));
  const attemptBinding = attempts => JSON.stringify(attempts.map(attempt => [attempt.key, attempt.raw]).sort(([a], [b]) => a.localeCompare(b)));
  // Raw records bind the displayed candidate (or ID-less attempt) and its exact owner and dispatch step.
  const abandonmentBinding = (snapshot, records) => JSON.stringify([snapshot.pointer, attemptBinding(records)]);
  const mismatchFor = id => record => record.kinds?.includes(CREATE_MISMATCH) &&
    (record.cartId === id || record.cartId === CREATE_PENDING && record.candidateCartId === id);
  // A serviced cart whose service data is unreadable but whose gloves can be copied without it. Observing it never
  // writes: the cart is incomplete, so checkout and every write already refuse it.
  const serviceDataUnavailable = cart => Boolean(cart.id) && !cart.missing && cart.limited === true && canRecoverWithoutService(cart);

  // A pure reading of the journal for one observed cart: flags for the drawer, never a write.
  function applySafety(cart, { exclude = null, snapshot = safeSnapshot() } = {}) {
    if (!snapshot) { cart.storageUnavailable = true; if (cart.id) cart.incomplete = true; return cart; }
    if (!cart.id) {
      const unconfirmed = firstCartRecords(snapshot, exclude);
      if (unconfirmed.length || unpersistedCandidates.size) {
        cart.unconfirmedCreate = true;
        cart.abandonmentBinding = abandonmentBinding(snapshot, unconfirmed);
        if (unpersistedCandidates.size || unconfirmed.some(record => recordCandidates(record).length)) cart.unconfirmedCandidate = true;
        if (unconfirmed.some(record => record.malformed)) cart.storageUnavailable = true;
      }
      return cart;
    }
    const pending = pendingFor(cart.id, { snapshot, exclude });
    if (cart.missing) {
      if (pending && !onlyCheckoutFreeze(pending.records)) {
        cart.cartMissing = true;
        cart.incomplete = true;
        cart.abandonmentBinding = abandonmentBinding(snapshot, pending.records);
      }
      else cart.incomplete = false;
      return cart;
    }
    if (serviceDataUnavailable(cart) && !pending) {
      cart.recoveryAvailable = false;
      cart.gloveOnlyRecoveryAvailable = true;
      cart.recoveryHasBreakIn = true;
    }
    if (!pending) return cart;
    const serviceDataMissing = pending.kinds.includes('service data unavailable');
    const splitRecoveryBinding = rotatedSplitRecovery(cart, pending);
    if (splitRecoveryBinding) cart.splitRecoveryBinding = splitRecoveryBinding;
    cart.recoveryAvailable = !serviceDataMissing && !cart.integrityFailure &&
      (!pending.records.some(record => record.splitObservedStamp) || Boolean(splitRecoveryBinding)) &&
      !pending.kinds.some(kind => kind.endsWith('validation failed')) &&
      (!cart.incomplete || Boolean(splitRecoveryBinding) || pending.before?.id === cart.id && snapshotMatchesUnaffectedLines(cart, pending.before, pending.kinds));
    cart.gloveOnlyRecoveryAvailable = serviceDataMissing && canRecoverWithoutService(cart);
    cart.recoveryHasBreakIn = cart.lines.some(line => line.isBreakIn) || Boolean(pending.before?.lines?.some(line => line.isBreakIn));
    cart.incomplete = true;
    cart.uncertainMutation = pending.kinds.join(', ');
    const attempts = pending.records.filter(record => record.kind === RECOVERY_KIND && record.cartId === cart.id);
    const [attempt] = currentAttempts(attempts);
    if (attempt) {
      cart.recoveryUnconfirmed = true;
      cart.recoveryAttemptWithoutBreakIn = Boolean(attempt.recovery?.withoutBreakIn);
      // A fresh attempt is consent for exactly these attempt records, in their stored mode.
      cart.recoveryBinding = attemptBinding(attempts);
    }
    const mismatched = pending.records.filter(mismatchFor(cart.id));
    if (mismatched.length && !cart.limited && !cart.integrityFailure) {
      cart.createMismatch = true;
      cart.reviewStamp = cart.stamp;
      cart.reviewBinding = attemptBinding(mismatched);
      cart.attemptedItems = describeCreateIntent(mismatched[0].createIntent);
      cart.recoveryAvailable = false;
      cart.gloveOnlyRecoveryAvailable = false;
    }
    return cart;
  }


  // ---- Catalog (read-only Shopify product data) ----
  async function loadProduct(handle) {
    const data = await shopifyRequest(config, PRODUCT_QUERY, { handle }, fetchImpl);
    if (!data.product?.variants.nodes[0]) throw new Error(`Shopify product “${handle}” was not found or has no variant.`);
    return data.product;
  }
  // Service lookups start alongside the required glove lookups so they do not add a
  // network round trip. Each is consumed once; validation still runs after products load.
  const settled = promise => promise.then(value => ({ value }), error => ({ error }));
  const servicePrefetch = new Map();
  let trainerServiceLookup = null;
  const loadService = async handle => {
    const prefetched = servicePrefetch.get(handle);
    servicePrefetch.delete(handle);
    if (!prefetched) return loadProduct(handle);
    const result = await prefetched;
    if ('error' in result) throw result.error;
    return result.value;
  };
  async function loadCatalog() {
    servicePrefetch.clear();
    if (config.breakInHandle) servicePrefetch.set(config.breakInHandle, trainerServiceLookup = settled(loadProduct(config.breakInHandle)));
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
    const trainer = trainerServiceLookup ? await trainerServiceLookup : null;
    catalog = { products, trainerServiceVariantIds: new Set((trainer?.value?.variants?.nodes || []).map(variant => variant.id)) };
    return products;
  }
  // Reads may start before the storefront asks for products; they wait for (or start) the same read-only load.
  const ensureCatalog = async () => {
    if (catalog) return catalog;
    if (!catalogLoad) catalogLoad = loadCatalog();
    try { await catalogLoad; } catch { catalogLoad = null; }
    return catalog;
  };

  // ---- One raw cart contract and one authoritative read ----
  class InvalidCart extends Error {}
  const reject = reason => { throw new InvalidCart(reason); };
  const optionsKey = options => JSON.stringify([...options].sort((a, b) => a.name.localeCompare(b.name)));
  const stated = (line, key) => line.attributes.filter(attribute => attribute.key === key).map(attribute => attribute.value);
  function validMerchandise(value) {
    if (!plainObject(value) || typeof value.id !== 'string' || !value.id || !plainObject(value.product) ||
      typeof value.product.handle !== 'string' || !value.product.handle) return null;
    const options = validPairs(value.selectedOptions, 'name', 'value');
    return options ? { id: value.id, handle: value.product.handle, options } : null;
  }
  function pricingValue(value, money) {
    if (!plainObject(value)) return null;
    if (value.__typename === 'PricingPercentageValue') {
      return typeof value.percentage === 'number' && Number.isFinite(value.percentage) && value.percentage >= 0 && value.percentage <= 100
        ? { percentage: value.percentage } : null;
    }
    if (value.__typename === 'MoneyV2') { const amount = money(value); return { amount: amount.amount, canonical: amount.canonical }; }
    return null;
  }
  // Validates an assembled raw cart (every page) by its exact ID against the catalog, then normalizes it. Structure,
  // identity, money, URL, discounts and catalog membership must all pass; only then may glove/service customization
  // be incomplete, which yields `limited` evidence for an expected intermediate step or glove-only recovery.
  function validateRawCart(raw, expectedId) {
    try {
      if (!catalog) reject('catalog');
      if (!plainObject(raw) || raw.id !== expectedId || !trustedCartId(raw.id)) reject('id');
      const checkoutUrl = verifiedCheckoutUrl(raw.checkoutUrl);
      const attributes = validPairs(raw.attributes, 'key', 'value') || reject('cart attributes');
      if (!plainObject(raw.cost)) reject('cost');
      const subtotal = strictMoney(raw.cost.subtotalAmount) || reject('subtotal');
      const { currencyCode } = subtotal;
      const money = value => { const amount = strictMoney(value); if (!amount || amount.currencyCode !== currencyCode) reject('money'); return amount; };
      if (!Array.isArray(raw.discountCodes)) reject('codes');
      const codeKeys = new Set();
      const discountCodes = raw.discountCodes.map(discount => {
        if (!plainObject(discount) || typeof discount.code !== 'string' || !discount.code.trim() || typeof discount.applicable !== 'boolean') reject('code');
        const key = codeKey(discount.code);
        if (codeKeys.has(key)) reject('duplicate code');
        codeKeys.add(key);
        return { code: discount.code, applicable: discount.applicable };
      });
      if (!Array.isArray(raw.discountApplications)) reject('applications');
      const applications = raw.discountApplications.map(application => {
        if (!plainObject(application) || !TARGET_TYPES.has(application.targetType)) reject('application');
        const value = pricingValue(application.value, money) || reject('application value');
        if (application.__typename === 'CartCodeDiscountApplication') {
          if (typeof application.code !== 'string' || !codeKeys.has(codeKey(application.code))) reject('application code');
          return { code: application.code, title: null, targetType: application.targetType, ...value };
        }
        if (!['CartAutomaticDiscountApplication', 'CartCustomDiscountApplication'].includes(application.__typename) ||
          typeof application.title !== 'string' || !application.title.trim()) reject('application type');
        return { code: null, title: application.title, targetType: application.targetType, ...value };
      });
      if (!plainObject(raw.lines) || !Array.isArray(raw.lines.nodes)) reject('lines');
      const ids = new Set();
      const parsed = raw.lines.nodes.map(node => {
        if (!plainObject(node) || typeof node.id !== 'string' || !node.id || ids.has(node.id)) reject('line id');
        ids.add(node.id);
        if (!Number.isSafeInteger(node.quantity) || node.quantity < 1) reject('quantity');
        const lineAttributes = validPairs(node.attributes, 'key', 'value') || reject('line attributes');
        const merchandise = validMerchandise(node.merchandise) || reject('merchandise');
        if (!plainObject(node.cost)) reject('line cost');
        const prices = [node.cost.amountPerQuantity, node.cost.subtotalAmount, node.cost.totalAmount].map(money);
        if (!Array.isArray(node.allDiscountAllocations)) reject('allocations');
        const allocations = node.allDiscountAllocations.map(allocation => {
          if (!plainObject(allocation) || !TARGET_TYPES.has(allocation.targetType)) reject('allocation');
          const amount = money(allocation.discountedAmount);
          if (allocation.__typename === 'CartCodeDiscountAllocation') {
            if (typeof allocation.code !== 'string' || !codeKeys.has(codeKey(allocation.code))) reject('allocation code');
          } else if (!['CartAutomaticDiscountAllocation', 'CartCustomDiscountAllocation'].includes(allocation.__typename) ||
            typeof allocation.title !== 'string' || !allocation.title.trim()) reject('allocation type');
          return { amount, targetType: allocation.targetType, code: allocation.code ?? null };
        });
        if (!plainObject(node.instructions) || typeof node.instructions.canRemove !== 'boolean' || typeof node.instructions.canUpdateQuantity !== 'boolean') reject('instructions');
        if (!Object.hasOwn(node, 'parentRelationship') || node.parentRelationship !== null && !plainObject(node.parentRelationship)) reject('parent');
        let parent = null;
        if (node.parentRelationship) {
          const linked = node.parentRelationship.parent;
          if (!plainObject(linked) || typeof linked.id !== 'string' || !linked.id) reject('parent');
          parent = { id: linked.id, merchandise: validMerchandise(linked.merchandise) || reject('parent merchandise') };
        }
        return { node, attributes: lineAttributes, merchandise, prices, allocations, parent };
      });
      const byId = new Map(parsed.map(entry => [entry.node.id, entry]));
      const lines = parsed.map(entry => {
        const { node, merchandise, parent } = entry;
        const serviceType = merchandise.handle === FULL_SIZE_SERVICE_HANDLE ? 'full-size' : config.breakInHandle && merchandise.handle === config.breakInHandle ? 'trainer' : null;
        let productId; let throwingHand = null;
        if (serviceType) {
          const owner = parent && byId.get(parent.id);
          if (!owner || owner === entry || owner.parent) reject('service parent');
          if (owner.merchandise.id !== parent.merchandise.id || owner.merchandise.handle !== parent.merchandise.handle ||
            optionsKey(owner.merchandise.options) !== optionsKey(parent.merchandise.options)) reject('service parent identity');
          if (serviceType === 'full-size' ? merchandise.id !== FULL_SIZE_SERVICE_VARIANT : !catalog.trainerServiceVariantIds.has(merchandise.id)) reject('service variant');
          productId = handleToProductId[owner.merchandise.handle];
          if (!productId || (serviceType === 'full-size') !== productId.startsWith('full-')) reject('service type');
        } else {
          if (parent) reject('nested glove');
          productId = handleToProductId[merchandise.handle];
          if (!productId || config.handles[productId] !== merchandise.handle) reject('product');
          const product = catalog.products.find(item => item.id === productId) || reject('catalog product');
          const variant = product.variants?.find(item => item.id === merchandise.id) || reject('variant');
          const returnedHands = merchandise.options.filter(option => option.name === 'Throwing Hand').map(option => option.value);
          const catalogHands = (variant.selectedOptions || []).filter(option => option.name === 'Throwing Hand').map(option => option.value);
          if (catalogHands.length > 1 || returnedHands.length !== catalogHands.length || returnedHands.some(hand => hand !== catalogHands[0])) reject('hand');
          if (productId.startsWith('full-')) {
            // The catalog variant sets the hand; the right-only fallback applies only when the catalog itself has none.
            throwingHand = catalogHands[0] || (product.throwHands?.length === 1 && product.throwHands[0] === 'Right-Hand Throw' ? 'Right' : null);
            if (!['Right', 'Left'].includes(throwingHand)) reject('hand');
            if (stated(entry, 'Throwing Hand').some(hand => hand !== throwingHand) || stated(entry, 'Glove Model').some(model => model !== product.name)) reject('hand attribute');
          } else throwingHand = catalogHands[0] || null;
        }
        const [unitPrice, lineSubtotal, lineTotal] = entry.prices;
        return { remoteLineId: node.id, merchandiseId: merchandise.id, parentLineId: parent?.id || null, productId, quantity: node.quantity,
          throwingHand, unitPrice: { amount: unitPrice.amount, currencyCode }, lineSubtotal: { amount: lineSubtotal.amount, currencyCode },
          lineTotal: { amount: lineTotal.amount, currencyCode },
          allDiscountAllocations: entry.allocations.map(allocation => ({ amount: { amount: allocation.amount.amount, currencyCode }, targetType: allocation.targetType, code: allocation.code })),
          isBreakIn: Boolean(serviceType), serviceType, attributes: entry.attributes,
          serviceConfiguration: entry.attributes.find(attribute => attribute.key === SERVICE_ATTRIBUTE)?.value || null,
          instructions: { canRemove: node.instructions.canRemove, canUpdateQuantity: node.instructions.canUpdateQuantity },
          canonical: entry.prices.map(price => price.canonical), allocationCanonical: entry.allocations.map(allocation => allocation.amount.canonical) };
      });
      for (const child of lines.filter(line => line.isBreakIn)) {
        const owner = lines.find(line => line.remoteLineId === child.parentLineId);
        if (lines.filter(line => line.isBreakIn && line.parentLineId === owner.remoteLineId).length > 1) reject('duplicate service');
        if (owner.productId.startsWith('full-')) {
          const model = catalog.products.find(item => item.id === owner.productId)?.name;
          if (stated(child, 'Throwing Hand').some(hand => hand !== owner.throwingHand) || stated(child, 'Glove Model').some(name => name !== model)) reject('service hand');
        }
        if (!Number.isFinite(child.unitPrice.amount + owner.unitPrice.amount) || !Number.isFinite(child.lineTotal.amount + owner.lineTotal.amount)) reject('pair sum');
      }
      if (lines.some(line => line.serviceType === 'full-size' && line.merchandiseId !== FULL_SIZE_SERVICE_VARIANT)) reject('service variant');
      const limited = !cartCustomizationIsComplete(lines);
      if (!checkoutUrl) reject(limited ? 'checkout url and customization' : 'checkout url');
      const cart = { id: raw.id, checkoutUrl, attributes, subtotal: subtotal.amount, currencyCode, discountCodes, discountsIncomplete: false,
        discountApplications: applications.filter(application => application.code).map(application => ({ code: application.code,
          targetType: application.targetType, percentage: application.percentage ?? null })),
        allDiscountApplications: applications, lineCoverageComplete: true, incomplete: limited, limited, lines };
      cart.stamp = canonicalStamp(cart, subtotal.canonical, applications);
      for (const line of cart.lines) { Object.defineProperty(line, 'canonical', { enumerable: false }); Object.defineProperty(line, 'allocationCanonical', { enumerable: false }); }
      return { status: limited ? 'limited' : 'valid', cart };
    } catch (error) {
      if (error instanceof InvalidCart) return { status: 'invalid', reason: error.message };
      throw error;
    }
  }
  // Every purchasable fact, in canonical form: cart and line identities, merchandise, hand, quantities, parents,
  // attributes, prices, currency and discounts. The rotating checkout URL is excluded.
  function canonicalStamp(cart, subtotalCanonical, applications) {
    const byFirst = (a, b) => String(a[0]).localeCompare(String(b[0]));
    return JSON.stringify({ id: cart.id, currency: cart.currencyCode, subtotal: subtotalCanonical, attributes: sortedAttributes(cart.attributes),
      codes: cart.discountCodes.map(discount => [discount.code, discount.applicable]).sort(byFirst),
      applications: applications.map(application => [application.code, application.title, application.targetType, application.percentage ?? null, application.canonical ?? null])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      lines: cart.lines.map(line => [line.remoteLineId, line.parentLineId, line.merchandiseId, line.productId, line.serviceType || null, line.quantity,
        line.throwingHand || null, sortedAttributes(line.attributes), line.canonical, line.allocationCanonical,
        line.allDiscountAllocations.map(allocation => [allocation.targetType, allocation.code])]).sort(byFirst) });
  }
  // A stamp of the purchase itself: the cart without its preorder snapshot attribute.
  const purchaseStamp = cart => {
    const stamp = JSON.parse(cart.stamp);
    stamp.attributes = stamp.attributes.filter(attribute => attribute.key !== PREORDER_ORDER_ATTRIBUTE);
    return JSON.stringify(stamp);
  };
  const unverified = (message, cause) => new ShopifyRequestError(message, 'cart-unverified', cause);
  // One complete sweep of every page by the exact ID. Missing is only an explicit `cart: null` on the first page.
  async function sweepCart(id) {
    const pages = [];
    const cursors = new Set();
    let after = null;
    for (let page = 0; page < MAX_CART_PAGES; page++) {
      let data;
      try { data = await shopifyRequest(config, CART_PAGE_QUERY, { id, after }, fetchImpl); }
      catch (error) {
        if (['graphql', 'http', 'http-rejected'].includes(error.code)) throw unverified('Shopify did not return the cart.', error);
        throw error;
      }
      if (!plainObject(data) || !Object.hasOwn(data, 'cart')) throw unverified('Shopify did not return the cart.');
      if (data.cart === null) {
        if (page === 0) return null;
        throw unverified('The cart disappeared while it was being read.');
      }
      const cart = data.cart;
      if (!plainObject(cart) || cart.id !== id || !plainObject(cart.lines) || !Array.isArray(cart.lines.nodes) || !plainObject(cart.lines.pageInfo)) {
        throw unverified('Shopify returned a cart that could not be read.');
      }
      pages.push(cart);
      const { hasNextPage, endCursor } = cart.lines.pageInfo;
      if (hasNextPage === false) return pages;
      if (hasNextPage !== true || typeof endCursor !== 'string' || !endCursor || cursors.has(endCursor) || endCursor === after || !cart.lines.nodes.length) {
        throw unverified('Shopify returned malformed pagination.');
      }
      cursors.add(endCursor);
      after = endCursor;
    }
    throw unverified('The cart has more lines than this storefront reads.');
  }
  function assemblePages(pages) {
    const metadata = page => JSON.stringify([page.id, page.attributes, page.cost, page.discountCodes, page.discountApplications]);
    if (pages.some(page => metadata(page) !== metadata(pages[0]))) throw unverified('The cart changed between pages.');
    const last = pages.at(-1);
    return { ...pages[0], checkoutUrl: last.checkoutUrl, lines: { pageInfo: last.lines.pageInfo, nodes: pages.flatMap(page => page.lines.nodes) } };
  }
  // A discriminated verdict: valid, limited (customization incomplete only), missing, or invalid. A read that spans
  // pages is confirmed by a second complete sweep with the same canonical content; its URL is the one used.
  async function readAuthoritativeCart(id) {
    if (!trustedCartId(id)) return { status: 'invalid', reason: 'id' };
    await ensureCatalog();
    const pages = await sweepCart(id);
    if (!pages) return { status: 'missing', id };
    let verdict = validateRawCart(assemblePages(pages), id);
    if (pages.length > 1 && verdict.status === 'invalid' && verdict.reason === 'checkout url') return { status: 'invalid', reason: 'unverified multi-page checkout url' };
    if (pages.length > 1 && verdict.status !== 'invalid') {
      const again = await sweepCart(id);
      const second = again ? validateRawCart(assemblePages(again), id) : { status: 'invalid', reason: 'vanished' };
      verdict = second.status !== 'invalid' && second.cart.stamp === verdict.cart.stamp ? second : { status: 'invalid', reason: 'unstable' };
    }
    return verdict;
  }
  const missingCart = id => ({ ...emptyCart(), id, missing: true, incomplete: true, lineCoverageComplete: false, discountsIncomplete: false });
  // The active cart as Shopify reports it, with no side effect. Invalid data is never returned as a cart.
  async function observeCart(id, { explainCheckoutUrl = false } = {}) {
    const verdict = await readAuthoritativeCart(id);
    if (verdict.status === 'missing') return missingCart(id);
    if (explainCheckoutUrl && verdict.status === 'invalid' && verdict.reason === 'checkout url') {
      const snapshot = safeSnapshot();
      if (snapshot?.pointer === id && !pendingFor(id, { snapshot })) {
        throw new ShopifyRequestError('Invalid checkout destination.', 'checkout-url-invalid');
      }
    }
    if (verdict.status === 'invalid') throw unverified('Shopify returned a cart that could not be verified.');
    return verdict.cart;
  }
  async function getRawCart(options) {
    const id = readKey(SHOPIFY_CART_KEY);
    if (!id) return emptyCart();
    const cart = await observeCart(id, options);
    if (readKey(SHOPIFY_CART_KEY) !== id) throw new ShopifyRequestError('The active cart changed while Shopify was responding.', 'cart-changed');
    return cart;
  }
  async function getCart() {
    const cart = await getRawCart({ explainCheckoutUrl: true });
    return applySafety(cart);
  }


  // ---- Operations: one versioned root record per public operation ----
  // A record moves prepared → armed (step N dispatched, outcome unknown) → evidence recorded → reconciled by a
  // fresh read → terminal, and is retired only while it still holds its exact owned bytes. Nothing but this
  // operation's own verified writes advances its expected snapshot.
  const newOwner = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  function prepareOperation(snapshot, fields) {
    const owner = newOwner();
    const key = UNSAFE_RECORD_PREFIX + owner;
    const record = { v: JOURNAL_VERSION, owner, status: 'prepared', dispatched: false, createdAt: Date.now(), steps: [], ...fields };
    const op = { key, owner, snapshot, record, raw: null, steps: [], current: null, armed: false, verified: new Map(), flags: new Set(),
      selection: null, candidate: null, conflict: null, unpersisted: false };
    try { op.raw = writeOwnedRecord(snapshot, key, record, null); }
    catch (error) {
      // A prepared record that may have landed but could not be verified proves nothing was armed: scoped cleanup.
      const intended = JSON.stringify(record);
      try { if (storage.getItem(key) === intended) storage.removeItem(key); } catch { /* ignored for admission either way */ }
      snapshot.entries.delete(key);
      throw error;
    }
    return op;
  }
  // Takes over an existing record (a resumed recovery or adoption) at its exact current bytes.
  function resumeOperation(snapshot, record) {
    const { key, raw, ...fields } = record;
    return { key, owner: fields.owner || null, snapshot, record: fields, raw, steps: (fields.steps || []).map(step => ({ ...step })),
      current: null, armed: true, verified: new Map(), flags: new Set(), selection: null, candidate: null, conflict: null, unpersisted: false };
  }
  function rewriteOwn(op, changes) {
    const next = { ...op.record, ...changes };
    op.raw = writeOwnedRecord(op.snapshot, op.key, next, op.raw);
    op.record = next;
  }
  // Marks this operation's own record (the replacement for a second ownership mechanism): kinds that make it
  // unrecoverable, or the verified state before it for partial-operation proofs. Persisted when the operation ends.
  const flag = (op, kind, before = null) => { op.flags.add(kind); if (before?.id && !op.record.before) op.flagBefore = minimalSnapshot(before); };
  const minimalSnapshot = cart => ({ id: cart.id, lines: cart.lines.map(line => ({ remoteLineId: line.remoteLineId, parentLineId: line.parentLineId,
    merchandiseId: line.merchandiseId, productId: line.productId, isBreakIn: line.isBreakIn, serviceType: line.serviceType, quantity: line.quantity,
    attributes: line.attributes, throwingHand: line.throwingHand, serviceConfiguration: line.serviceConfiguration })), discountCodes: cart.discountCodes });
  function retireOperation(op, resolution) {
    try {
      rewriteOwn(op, { status: 'terminal', resolution, resolvedAt: Date.now() });
      // A terminal record still naming a cart nothing else references stays (it does not gate anything).
      const others = [...knownCartIds(op.raw)].filter(id => id !== readKey(SHOPIFY_CART_KEY) && id !== op.record.cartId);
      if (!others.length || resolution === 'completed' || resolution === 'observed unchanged') removeOwnedRecord(op.snapshot, op.key, op.raw);
    } catch { /* A record that cannot be retired is left conservatively: terminal ones do not gate, others still block. */ }
  }
  function leaveUnresolved(op) {
    const kinds = [...new Set([...(op.record.kinds || []), ...op.flags])];
    try { rewriteOwn(op, { status: 'unresolved', kinds, ...(op.flagBefore && !op.record.before ? { before: op.flagBefore } : {}) }); }
    catch { unpersistedUnsafe.add(op.record.cartId); }
  }

  // ---- The mutation dispatcher ----
  const TIMEOUT = Symbol('timeout');
  const headers = { 'Content-Type': 'application/json', 'X-Shopify-Storefront-Access-Token': config.accessToken };
  // Arms step N, then invokes fetch with no intervening await. From that point the step is potentially dispatched
  // whatever happens: a synchronous throw, abort, timeout, lost connection, unreadable body, any HTTP status, or reload.
  function dispatchCartStep(op, { query, variables, field, target, intent = {}, onEvidence }) {
    const body = JSON.stringify({ query, variables });
    const n = (op.record.step?.n ?? op.steps.length) + 1;
    const continuation = op.current?.continuation || op.recoveryAttachment;
    if ((op.current?.limited || continuation) && (!continuation || continuation.owner !== op.owner || continuation.raw !== op.raw ||
      continuation.step !== op.record.step?.n || continuation.target !== target || continuation.body !== JSON.stringify([field, variables]))) {
      throw unverified('Shopify did not verify the intermediate cart for this next step.');
    }
    const pre = continuation ? continuation.stamp :
      target === CREATE_PENDING || target === RECOVERY_TARGET ? null : op.verified.get(target)?.stamp || null;
    const baseline = target !== CREATE_PENDING && target !== RECOVERY_TARGET && op.verified.get(target);
    const steps = op.steps.map(step => ({ n: step.n, field: step.field, target: step.target, outcome: step.outcome || 'progressed' }));
    const previous = op.raw;
    const previousRecord = op.record;
    const next = { ...previousRecord, status: 'armed', dispatched: true, steps, step: { n, field, target, state: 'dispatched-unknown', pre },
      ...(!op.record.before && baseline ? { before: minimalSnapshot(baseline) } : {}), ...intent };
    const attempted = JSON.stringify(next);
    let attemptedWrite = false;
    try {
      assertSafetySnapshot(op.snapshot);
      // Other tabs must learn of a possible write before its first dispatch; a failed notice sends nothing.
      if (!op.announced) {
        announceCartChange(true);
        op.announced = true;
        assertSafetySnapshot(op.snapshot);
      }
      attemptedWrite = true;
      op.raw = writeOwnedRecord(op.snapshot, op.key, attempted, previous);
      op.record = next;
      assertSafetySnapshot(op.snapshot);
    } catch (error) {
      let restored = false;
      try {
        const now = readKey(op.key);
        if (now === previous) restored = true;
        else if (attemptedWrite && error.code !== 'cart-changed' && now === attempted && next.owner === op.owner) {
          writeOwnedRecord(op.snapshot, op.key, previous, attempted);
          restored = true;
        }
      } catch { /* A write or its readback may have taken effect. */ }
      if (restored) {
        op.raw = previous;
        op.record = previousRecord;
      }
      if (!restored || error.code === 'cart-changed') op.skipCleanup = true;
      if (!restored) unpersistedUnsafe.add(op.record.cartId);
      throw error.code === 'cart-changed' ? error : storageFailure('Cart safety storage is unavailable.', error);
    }
    op.armed = true;
    op.recoveryAttachment = null;
    const step = { n, field, target, outcome: null, pre };
    op.steps.push(step);
    op.current = step;
    const controller = new AbortController();
    let response;
    try {
      response = Promise.resolve(fetchImpl(endpoint, { method: 'POST', headers, body, signal: controller.signal, redirect: 'manual' }));
    } catch (error) { response = Promise.reject(error); }
    return finishDispatch(op, step, response, controller, field, onEvidence);
  }
  async function finishDispatch(op, step, response, controller, field, onEvidence) {
    let timer;
    const deadline = new Promise(resolve => { timer = setTimeout(() => resolve(TIMEOUT), config.timeoutMs ?? REQUEST_TIMEOUT_MS); });
    const decoded = response.then(async answer => {
      let envelope; let readable = true;
      try { envelope = await answer.json(); } catch { readable = false; }
      return { answer, envelope, readable };
    }, error => ({ transportError: error }));
    const outcome = await Promise.race([decoded, deadline]);
    clearTimeout(timer);
    if (outcome === TIMEOUT) {
      controller.abort();
      // A late body may add evidence to this same unresolved step only, under the lock, never anything more.
      decoded.then(late => recordLateEvidence(op, step, field, late, onEvidence)).catch(() => {});
      return { eligible: false, timedOut: true, message: 'Shopify is taking too long to respond.' };
    }
    const reply = diagnose(outcome, field);
    if (reply.cartId) onEvidence(reply.cartId);
    return reply;
  }
  // Transport diagnostics, separate from settlement. The expected field's own cart.id is extracted first.
  function diagnose({ answer, envelope, readable, transportError }, field) {
    if (transportError) return { eligible: false, message: 'Connection lost.', transportError };
    const data = plainObject(envelope) && plainObject(envelope.data) ? envelope.data : null;
    const payload = data && plainObject(data[field]) ? data[field] : null;
    const cart = payload && plainObject(payload.cart) ? payload.cart : null;
    const cartId = cart ? trustedCartId(cart.id) : null;
    const status = Number.isInteger(answer?.status) ? answer.status : answer?.ok === true ? 200 : 0;
    const success = answer?.ok === true && status >= 200 && status < 300 && readable;
    const errorsClean = plainObject(envelope) && (envelope.errors === undefined || Array.isArray(envelope.errors) && envelope.errors.length === 0);
    const userErrorsValid = Array.isArray(payload?.userErrors) && payload.userErrors.every(error => plainObject(error) &&
      typeof error.message === 'string' && error.message.trim());
    const warningsValid = payload?.warnings === undefined || Array.isArray(payload.warnings);
    const reported = replyMessage(userErrorsValid ? payload.userErrors : [], Array.isArray(envelope?.errors) ? envelope.errors : []);
    const message = reported === FALLBACK_MESSAGE && !(status >= 200 && status < 300) ? `Shopify request failed (${status || 'no status'}).` : reported;
    const wellFormed = success && errorsClean && Boolean(data) && Boolean(payload) && userErrorsValid && warningsValid && Boolean(cart);
    return { status, cartId, payload, message, eligible: wellFormed && payload.userErrors.length === 0,
      applicationRejection: wellFormed && payload.userErrors.length > 0 };
  }
  function recordLateEvidence(op, step, field, late, onEvidence) {
    const reply = late?.transportError ? null : diagnose(late, field);
    if (!reply?.cartId || !recoveryLocks?.request) return;
    withCartLock(() => {
      let stored = null;
      try { stored = readKey(op.key); } catch { return; }
      if (stored !== op.raw || op.record.status === 'terminal' || op.record.step?.n !== step.n) return;
      onEvidence(reply.cartId, { late: true });
    }).catch(() => {});
  }
  // Evidence for a first-cart create: the untouched ID joins the record's candidates. A conflict (an existing-cart
  // write naming another cart) is kept on the owning record and never published.
  const createEvidence = op => (id, { late = false } = {}) => {
    op.candidate ||= id;
    const candidateCartIds = [...new Set([...(op.record.candidateCartIds || []), id])];
    try {
      rewriteOwn(op, { candidateCartId: op.record.candidateCartId || id, candidateCartIds,
        step: { ...op.record.step, state: 'candidate-observed', evidence: id } });
      unpersistedCandidates.delete(op.key);
    } catch {
      if (!late) { op.unpersisted = true; unpersistedCandidates.set(op.key, { id, step: op.current?.n }); }
    }
  };
  const targetEvidence = (op, target) => id => {
    if (id === target) return;
    op.conflict = id;
    try { rewriteOwn(op, { conflictingIds: [...new Set([...(op.record.conflictingIds || []), id])] }); } catch { op.unpersisted = true; }
  };

  // One cart mutation step: dispatch, then — only for a clean answer — a fresh authoritative read of the target.
  // A response alone never settles or publishes a cart. The only settlement a response can support is an
  // existing-cart application rejection whose fully valid same-ID cart, and a fresh read, both equal the
  // pre-step state, when no earlier step of this operation committed.
  async function mutateCart(op, query, variables, field, kind = 'cart change', splitIntent = null) {
    const target = variables.cartId || CREATE_PENDING;
    if ((readKey(SHOPIFY_CART_KEY) || null) !== (variables.cartId || null)) {
      throw new ShopifyRequestError('The active cart changed before the mutation started.', 'cart-changed');
    }
    const creating = target === CREATE_PENDING;
    const intent = creating ? { cartId: CREATE_PENDING, createIntent: (variables.input?.lines || []).map(line => ({
      merchandiseId: line.merchandiseId, quantity: line.quantity, attributes: line.attributes || [],
      parentMerchandiseId: line.parent?.merchandiseId || null,
      ...(!line.parent ? { throwingHand: op.selection?.merchandiseId === line.merchandiseId ? op.selection.throwingHand : null } : {}) })) } : {};
    if (splitIntent) intent.splitIntent = splitIntent;
    if (!op.record.kinds?.includes(kind)) intent.kinds = [...new Set([...(op.record.kinds || []), kind])];
    const reply = await dispatchCartStep(op, { query, variables, field, target, intent,
      onEvidence: creating ? createEvidence(op) : targetEvidence(op, target) });
    const uncertain = message => Object.assign(new ShopifyRequestError(message, creating ? 'uncertain-create' : 'uncertain'), { shopifyMessage: reply.message });
    if (op.conflict) throw uncertain('Shopify answered for a different cart.');
    if (!reply.eligible) {
      const earlierCommitted = op.steps.some(step => step !== op.current && step.outcome !== 'unchanged');
      if (!creating && reply.applicationRejection && reply.cartId === target && !earlierCommitted && op.current.pre &&
        reply.payload.cart.lines?.pageInfo?.hasNextPage === false) {
        const answered = validateRawCart(reply.payload.cart, target);
        if (answered.status === 'valid' && answered.cart.stamp === op.current.pre) {
          const fresh = await readAuthoritativeCart(target);
          if (fresh.status === 'valid' && fresh.cart.stamp === op.current.pre) {
            op.current.outcome = 'unchanged';
            const rejection = new Error(reply.message);
            rejection.definitiveRejection = true;
            throw rejection;
          }
        }
      }
      throw uncertain(reply.timedOut ? 'Shopify cart mutation result is uncertain: Shopify request timed out.' : `Shopify cart mutation result is uncertain: ${reply.message}`);
    }
    if (!reply.cartId) throw uncertain('Shopify returned a cart without a usable ID.');
    if (op.unpersisted) throw uncertain('The new cart could not be recorded safely.');
    const fresh = await readAuthoritativeCart(reply.cartId);
    if (fresh.status === 'missing' || fresh.status === 'invalid') throw uncertain('Shopify did not return the changed cart in a form we could verify.');
    if ((readKey(SHOPIFY_CART_KEY) || null) !== (variables.cartId || null)) {
      throw new ShopifyRequestError('The active cart changed while the mutation was pending.', 'cart-changed');
    }
    const result = fresh.cart;
    recordStepRead(op, result);
    result.stockWarningTargets = (Array.isArray(reply.payload.warnings) ? reply.payload.warnings : [])
      .filter(warning => plainObject(warning) && STOCK_WARNING_CODES.includes(warning.code)).map(warning => warning.target).filter(target => typeof target === 'string');
    // The reply's own cart, validated, only for proofs that need both it and the fresh read (stock settlement).
    const answered = reply.payload.cart.lines?.pageInfo?.hasNextPage === false ? validateRawCart(reply.payload.cart, result.id) : null;
    if (answered?.cart) op.current.replyPairing = intermediateLineStamp(answered.cart.lines);
    op.current.replyStamp = answered?.cart?.stamp;
    result.replyStamp = answered?.status === 'valid' ? answered.cart.stamp : null;
    result.warningMessages = (Array.isArray(reply.payload.warnings) ? reply.payload.warnings : [])
      .map(warning => plainObject(warning) && typeof warning.message === 'string' && warning.message.trim() ? warning.message : null).filter(Boolean);
    return result;
  }
  // Limited evidence belongs to one armed step. Later reads cannot promote it into a general baseline.
  function recordStepRead(op, cart) {
    if (cart.limited && op.current?.target === cart.id) op.current.limited ||= cart.stamp;
    if (!cart.incomplete && !op.current?.limited) op.verified.set(cart.id, cart);
  }
  async function reread(op) {
    const cart = await getRawCart();
    if (cart.id && !cart.missing) recordStepRead(op, cart);
    return cart;
  }

  function intermediateLineState(line) {
    return [line.merchandiseId, line.productId, line.serviceType, line.throwingHand, line.quantity,
      sortedAttributes(line.attributes), line.instructions];
  }
  const intermediateLineStamp = lines => JSON.stringify(lines.map(line =>
    [line.remoteLineId, line.parentLineId, ...intermediateLineState(line)]).sort(([a], [b]) => a.localeCompare(b)));

  // Shopify can rotate every line ID during a quantity update. Accept that only when the clean mutation payload and
  // authoritative read agree and the entire expected parent/child graph has one exact, unambiguous correspondence.
  function matchesRotatedPairing(expected, actual) {
    if (expected.length !== actual.length || actual.some(line => expected.some(old => old.remoteLineId === line.remoteLineId))) return false;
    const group = (lines, parent) => JSON.stringify([intermediateLineState(parent),
      lines.filter(child => child.parentLineId === parent.remoteLineId).map(intermediateLineState)]);
    const groups = lines => lines.filter(line => !line.isBreakIn).map(parent => group(lines, parent)).sort();
    const prior = groups(expected);
    return new Set(prior).size === prior.length && JSON.stringify(prior) === JSON.stringify(groups(actual));
  }

  function authorizeContinuation(op, before, after, lines, field, variables, { rekeyed = false, rotate = false } = {}) {
    const step = op.current;
    if (!step?.limited) return;
    const corroborated = step.replyStamp === after.stamp && step.replyPairing === intermediateLineStamp(after.lines);
    const exact = intermediateLineStamp(lines) === intermediateLineStamp(after.lines);
    const discounts = cart => [...cart.discountCodes].sort((a, b) => a.code.localeCompare(b.code));
    if (before.incomplete || step.pre !== before.stamp || step.target !== after.id || step.limited !== after.stamp ||
      op.record.owner !== op.owner || op.record.step?.n !== step.n || !after.limited ||
      !sameAttributes(before.attributes, after.attributes) ||
      JSON.stringify(discounts(before)) !== JSON.stringify(discounts(after)) ||
      (rekeyed && !corroborated) || (!exact && !(rotate && corroborated && matchesRotatedPairing(lines, after.lines)))) {
      throw unverified('Shopify returned an unexpected intermediate glove and Break-In configuration.');
    }
    assertSafetySnapshot(op.snapshot);
    step.continuation = { owner: op.owner, raw: op.raw, step: step.n, target: after.id, stamp: after.stamp,
      body: JSON.stringify([field, variables]) };
  }

  function authorizeQuantitySync(op, before, after, parent, child, next) {
    if (!op.current?.limited) return;
    const lines = before.lines.map(line => line === parent ? { ...line, quantity: next } : line);
    authorizeContinuation(op, before, after, lines, 'cartLinesUpdate',
      { cartId: after.id, lines: [{ id: child.remoteLineId, quantity: next }] }, { rotate: true });
  }

  // A parent add can merge with one matching destination. Only that pair and an explicitly selected split source
  // can be matched to replacement IDs. Unrelated IDs and every untouched configuration must remain exact.
  function authorizeParentAdd(op, before, after, destination, input, field, variables, splitSource = null) {
    if (!op.current?.limited) return;
    const matches = before.lines.filter(line => !line.isBreakIn && line.merchandiseId === input.merchandiseId &&
      sameAttributes(line.attributes, input.attributes));
    if (matches.length > 1) throw unverified('Shopify did not identify the intermediate glove configuration.');
    const [prior] = matches;
    const related = new Map();
    if (prior) related.set(prior.remoteLineId, destination);
    if (splitSource) related.set(splitSource.remoteLineId, resolveCurrentLine(after, splitSource));
    const lines = before.lines.map(line => {
      if (line === prior) return { ...line, remoteLineId: destination.remoteLineId, quantity: line.quantity + input.quantity };
      if (!line.isBreakIn && related.has(line.remoteLineId)) return { ...line, remoteLineId: related.get(line.remoteLineId).remoteLineId };
      if (line.isBreakIn && related.has(line.parentLineId)) {
        const parentLineId = related.get(line.parentLineId).remoteLineId;
        const child = after.lines.find(item => item.isBreakIn && item.parentLineId === parentLineId);
        return { ...line, parentLineId, remoteLineId: parentLineId === line.parentLineId ? line.remoteLineId : child?.remoteLineId };
      }
      return line;
    });
    if (!prior) {
      const template = splitSource || before.lines.find(line => !line.isBreakIn && line.merchandiseId === input.merchandiseId);
      if (!template) throw unverified('Shopify did not identify the intermediate glove variant.');
      lines.push({ ...template, remoteLineId: destination.remoteLineId, quantity: input.quantity, attributes: input.attributes,
        instructions: destination.instructions });
    }
    const rekeyed = [...related].some(([id, line]) => id !== line.remoteLineId);
    authorizeContinuation(op, before, after, lines, field, variables, { rekeyed });
  }
  async function getMutationCart(op) { return applySafety(await reread(op), { exclude: op.key }); }
  // A first cart is published only after its operation-specific postcondition was verified on a fresh read.
  function publishCreated(op, cart) {
    if (!op.candidate || cart.id !== op.candidate || op.record.candidateCartId !== cart.id) throw new ShopifyRequestError('The new cart could not be recorded safely.', 'uncertain-create');
    assertSafetySnapshot(op.snapshot);
    rewriteOwn(op, { status: 'adopting', adopting: { source: null, candidate: cart.id } });
    try { setPointer(op.snapshot, cart.id, null); }
    catch (error) { throw new ShopifyRequestError('The new cart could not be saved as the active cart.', 'uncertain-create', error); }
    rewriteOwn(op, { status: 'armed', cartId: cart.id, adopting: undefined });
  }

  // A stock warning settles a step only when it names a line this request tried to grow, no earlier step of the
  // operation committed, and both Shopify's validated reply and the fresh authoritative read (the step's result)
  // equal the verified pre-step state.
  const sameLine = (a, b) => a === b;
  async function confirmStockRejection(op, before, result, attemptedLineIds) {
    if (!before.id || !result?.stockWarningTargets?.some(target => attemptedLineIds.some(lineId => sameLine(target, lineId)))) return null;
    if (op.steps.some(step => step !== op.current && step.outcome !== 'unchanged')) return null;
    if (result.id !== before.id || !before.stamp || result.stamp !== before.stamp || result.replyStamp !== before.stamp) return null;
    op.current.outcome = 'unchanged';
    return applySafety(result, { exclude: op.key });
  }
  const stockLimitError = (productId, quantity) => new ShopifyRequestError(
    `No more ${products.find(product => product.id === productId)?.name || 'of this glove'} available right now. Your cart still has ${quantity}.`, 'stock-limit');

  const updateLines = (op, cartId, lines, kind = 'quantity update') => mutateCart(op, `mutation UpdateLines($cartId: ID!, $lines: [CartLineUpdateInput!]!) {
    cartLinesUpdate(cartId: $cartId, lines: $lines) { cart { ${CART_FIELDS} } userErrors { message } warnings { code message target } }
  }`, { cartId, lines }, 'cartLinesUpdate', kind);

  const addLines = (op, cartId, lines, kind = 'addition', splitIntent = null) => mutateCart(op, `mutation AddLines($cartId: ID!, $lines: [CartLineInput!]!) {
    cartLinesAdd(cartId: $cartId, lines: $lines) { cart { ${CART_FIELDS} } userErrors { message } warnings { code message target } }
  }`, { cartId, lines }, 'cartLinesAdd', kind, splitIntent);

  const removeLines = (op, cartId, lineIds, kind = 'removal') => mutateCart(op, `mutation RemoveLines($cartId: ID!, $lineIds: [ID!]!) {
    cartLinesRemove(cartId: $cartId, lineIds: $lineIds) { cart { ${CART_FIELDS} } userErrors { message } }
  }`, { cartId, lineIds }, 'cartLinesRemove', kind);

  // Snapshot of the approved preorder estimates as one cart attribute, which Shopify copies onto the
  // order. Cart-level, so glove/service line attributes, configuration fingerprints, wrist fit and
  // parent links are untouched. cartAttributesUpdate is sent the complete attribute list (Shopify's
  // docs do not say whether it merges or replaces); a removal that leaves the key behind is retried
  // with a blank value, and the result must match exactly or checkout stays blocked.
  const preorderAttribute = cart => (cart.attributes || []).find(attribute => attribute.key === PREORDER_ORDER_ATTRIBUTE)?.value?.trim() || '';
  async function syncPreorderOrderAttribute(op, cart) {
    const value = preorderOrderAttributeValue(cart.lines, id => products.find(product => product.id === id));
    if (preorderAttribute(cart) === value) return cart;
    const others = (cart.attributes || []).filter(attribute => attribute.key !== PREORDER_ORDER_ATTRIBUTE);
    const write = attributes => mutateCart(op, `mutation UpdateCartAttributes($cartId: ID!, $attributes: [AttributeInput!]!) {
      cartAttributesUpdate(cartId: $cartId, attributes: $attributes) { cart { ${CART_FIELDS} } userErrors { message } warnings { code message target } }
    }`, { cartId: cart.id, attributes }, 'cartAttributesUpdate', 'preorder details');
    // Only the preorder attribute may change: merchandise, services, quantities and discounts must be untouched.
    const verified = result => {
      if (result.incomplete || purchaseStamp(result) !== purchaseStamp(cart)) {
        flag(op, 'preorder details validation failed');
        throw new Error('Shopify changed the cart while saving the preorder details.');
      }
      return result;
    };
    let updated = verified(await write(value ? [...others, { key: PREORDER_ORDER_ATTRIBUTE, value }] : others));
    // The blank-value fallback only after a clean, verified first result shows the key was retained.
    if (!value && preorderAttribute(updated)) updated = verified(await write([...others, { key: PREORDER_ORDER_ATTRIBUTE, value: '' }]));
    if (preorderAttribute(updated) !== value) throw new Error('Shopify did not save the preorder details.');
    return updated;
  }

  async function updateDiscountCodes(op, cartId, discountCodes) {
    const updated = await mutateCart(op, `mutation UpdateDiscountCodes($cartId: ID!, $discountCodes: [String!]!) {
      cartDiscountCodesUpdate(cartId: $cartId, discountCodes: $discountCodes) {
        cart { ${CART_FIELDS} }
        userErrors { message }
        warnings { code message }
      }
    }`, { cartId, discountCodes }, 'cartDiscountCodesUpdate', 'discount update');
    updated.discountWarnings = updated.warningMessages;
    return applySafety(updated, { exclude: op.key });
  }

  // A discount action is an intent, not a replacement list: under the cart lock the codes are
  // reread, unrelated codes kept, and only a Shopify result with exactly the intended set counts.
  async function changeDiscountCode(op, action, input) {
    const code = String(input ?? '').trim();
    if (!code) throw new Error('Enter a discount code.');
    const current = await getMutationCart(op);
    if (!current.id || current.incomplete) {
      throw new Error(`The Shopify cart is unavailable. Please reload it before ${action === 'apply' ? 'applying' : 'removing'} a code.`);
    }
    const codes = discountCodeList(current);
    const present = codes.some(existing => codeKey(existing) === codeKey(code));
    if (action === 'apply' ? present : !present) return current;
    const expected = action === 'apply' ? [...codes, code] : codes.filter(existing => codeKey(existing) !== codeKey(code));
    const updated = await updateDiscountCodes(op, current.id, expected);
    // Without complete discount data Shopify's resulting codes are unknown, so nothing is confirmed.
    if (updated.discountsIncomplete) throw new ShopifyRequestError('Shopify did not return the cart’s discount codes.', 'uncertain');
    const keys = list => JSON.stringify(list.map(codeKey).sort());
    if (keys(discountCodeList(updated)) !== keys(expected)) {
      // A fresh read equal to the verified state before the write shows nothing changed; anything else stays unresolved.
      if (updated.stamp === current.stamp && op.steps.length === 1) op.current.outcome = 'unchanged';
      throw new ShopifyRequestError('Shopify did not confirm the discount change.', 'discount-unconfirmed');
    }
    return updated;
  }

  async function createCart(op, lines) {
    return mutateCart(op, `mutation CreateCart($input: CartInput!) {
      cartCreate(input: $input) { cart { ${CART_FIELDS} } userErrors { message } }
    }`, { input: { lines } }, 'cartCreate');
  }

  async function removeParentLine(op, cart, parent) {
    if (cart.incomplete) throw new Error('The Shopify cart is incomplete. Resolve the cart update before removing a glove.');
    if (!parent.instructions?.canRemove) throw new Error('Shopify does not allow this glove to be removed.');
    await mutateCart(op, `mutation RemoveLines($cartId: ID!, $lineIds: [ID!]!) {
      cartLinesRemove(cartId: $cartId, lineIds: $lineIds) { cart { ${CART_FIELDS} } userErrors { message } }
    }`, { cartId: cart.id, lineIds: [parent.remoteLineId] }, 'cartLinesRemove', 'removal');
    try {
      const updated = await reread(op);
      if (!configurationChangeIsExpected(cart, updated, parent, 0)) {
        flag(op, 'removal validation failed', cart);
        throw new Error('Shopify did not remove the selected glove and preserve the other cart items.');
      }
      return applySafety(updated, { exclude: op.key });
    } catch (error) {
      flag(op, 'removal', cart);
      throw error;
    }
  }

  async function setParentLineQuantity(op, cart, parent, quantity) {
    if (cart.incomplete) throw new Error('The Shopify cart is incomplete. Resolve the cart update before changing quantities.');
    const next = requestedQuantity(quantity);
    if (next === parent.quantity) return cart;
    if (!next) return removeParentLine(op, cart, parent);
    if (!parent.instructions?.canUpdateQuantity) throw new Error('Shopify does not allow this glove quantity to change.');
    const update = lines => updateLines(op, cart.id, lines);
    const originalChild = cart.lines.find(line => line.isBreakIn && line.parentLineId === parent.remoteLineId);
        let firstMutationCompleted = false;
    try {
      let updated = await update([{ id: parent.remoteLineId, quantity: next }]);
      firstMutationCompleted = true;
      if (await confirmStockRejection(op, cart, updated, [parent.remoteLineId])) throw stockLimitError(parent.productId, parent.quantity);
      const updatedParent = resolveCurrentLine(updated, parent, next);
      if (updatedParent?.quantity !== next) {
        if (originalChild) flag(op, 'quantity validation failed');
        throw new Error('Shopify did not update the glove quantity.');
      }
      if (originalChild) {
        const child = updated.lines.find(line => line.isBreakIn && line.parentLineId === updatedParent.remoteLineId);
        if (!child) {
          flag(op, 'quantity validation failed');
          throw new Error('Shopify did not preserve the nested Break-in service.');
        }
        if (child.quantity !== next) {
          if (!child.instructions?.canUpdateQuantity) throw new Error('Shopify did not synchronize the Break-in service quantity.');
          authorizeQuantitySync(op, cart, updated, parent, child, next);
          updated = await update([{ id: child.remoteLineId, quantity: next }]);
          const synchronizedParent = resolveCurrentLine(updated, parent, next);
          if (updated.lines.find(line => line.isBreakIn && line.parentLineId === synchronizedParent.remoteLineId)?.quantity !== next) {
            flag(op, 'quantity validation failed');
            throw new Error('Shopify did not update the Break-in service quantity.');
          }
        }
        updated = await reread(op);
        const finalParent = resolveCurrentLine(updated, parent, next);
        const finalChild = updated.lines.find(line => line.isBreakIn && line.parentLineId === finalParent.remoteLineId);
        if (!configurationChangeIsExpected(cart, updated, parent, next) || finalParent?.quantity !== next || finalChild?.quantity !== next) {
          flag(op, 'quantity validation failed');
          throw new Error('Shopify did not preserve the glove and Break-in service quantities.');
        }
        return applySafety(updated, { exclude: op.key });
      }
      updated = await reread(op);
      if (!configurationChangeIsExpected(cart, updated, parent, next)) {
        flag(op, 'quantity validation failed', cart);
        throw new Error('Shopify did not preserve the selected glove quantity and other cart items.');
      }
      return applySafety(updated, { exclude: op.key });
    } catch (error) {
      if (error.code === 'stock-limit') throw error;
      if (firstMutationCompleted) flag(op, 'quantity update', cart);
      throw error;
    }
  }

  // Applies a +1/-1 intent to the glove as Shopify holds it now, not as a stale tab displayed it.
  // `expected` is what the stepper showed; a different glove, service or option set is refused.
  async function stepParentLine(op, cart, parent, delta, expected = null) {
    if (cart.incomplete) throw new Error('The Shopify cart is incomplete. Resolve the cart update before changing quantities.');
    if (expected?.identity && cartLineIdentity(cart.lines, parent) !== expected.identity) {
      throw new ShopifyRequestError('This glove changed in another tab.', 'cart-changed');
    }
    const children = cart.lines.filter(line => line.isBreakIn && line.parentLineId === parent.remoteLineId);
    if (children.length > 1 || children[0] && children[0].quantity !== parent.quantity) {
      throw new ShopifyRequestError('This glove and its Break-In service no longer match.', 'cart-changed');
    }
    const result = await setParentLineQuantity(op, cart, parent, parent.quantity + delta);
    // The step was applied to a quantity the shopper did not see; checkout asks for a review.
    if (Number.isInteger(expected?.quantity) && expected.quantity !== parent.quantity) result.rebased = true;
    return result;
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

  async function decrementSplitSource(op, cart, source, hasService) {
    if (!source.instructions?.canUpdateQuantity) throw new Error('Shopify does not allow this glove quantity to change.');
    const nextQuantity = source.quantity - 1;
    await updateLines(op, cart.id, [{ id: source.remoteLineId, quantity: nextQuantity }]);
    let current = await reread(op);
    const updatedParent = resolveCurrentLine(current, source, nextQuantity);
    if (hasService) {
      const children = current.lines.filter(line => line.isBreakIn && line.parentLineId === updatedParent.remoteLineId);
      if (children.length !== 1) throw new Error('Shopify did not preserve the selected Break-in service child.');
      if (children[0].quantity !== nextQuantity) {
        if (!children[0].instructions?.canUpdateQuantity) throw new Error('Shopify cannot synchronize the Break-in service quantity.');
        authorizeQuantitySync(op, cart, current, source, children[0], nextQuantity);
        await updateLines(op, current.id, [{ id: children[0].remoteLineId, quantity: nextQuantity }]);
        current = await reread(op);
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

  // This proof is consumed only by recovery admission. It never supplies a continuation token.
  function rotatedSplitRecovery(source, pending) {
    const [record] = pending?.records || [];
    if (pending?.records.length !== 1 || unpersistedUnsafe.has(source.id) || !source.limited || !source.lineCoverageComplete ||
      !record || record.v !== JOURNAL_VERSION || typeof record.owner !== 'string' || !record.owner ||
      record.key !== UNSAFE_RECORD_PREFIX + record.owner || record.status !== 'unresolved' || record.dispatched !== true ||
      record.kind !== 'editBreakIn' || record.cartId !== source.id || record.before?.id !== source.id || record.conflictingIds?.length ||
      !Array.isArray(record.steps) || record.steps.length || record.step?.n !== 1 || record.step.field !== 'cartLinesAdd' ||
      record.step.target !== source.id || record.step.state !== 'dispatched-unknown' || typeof record.step.pre !== 'string' ||
      record.splitObservedStamp !== source.stamp || !record.splitIntent) return null;

    const { parentId, options } = record.splitIntent;
    const before = record.before;
    if (!Array.isArray(before.lines) || source.lines.length !== before.lines.length + 1 ||
      !before.lines.every(line => plainObject(line) && typeof line.remoteLineId === 'string' &&
        Array.isArray(line.attributes) && line.attributes.every(attribute => plainObject(attribute) &&
          typeof attribute.key === 'string' && typeof attribute.value === 'string')) || !hasConsistentBreakInLines(before)) return null;
    const previousIds = new Set(before.lines.map(line => line.remoteLineId));
    if (previousIds.size !== before.lines.length || source.lines.some(line => previousIds.has(line.remoteLineId))) return null;
    const parent = before.lines.find(line => line.remoteLineId === parentId && !line.isBreakIn);
    if (!parent || parent.quantity < 2 || parent.serviceConfiguration !== 'break-in' ||
      typeof parent.productId !== 'string' || parent.productId.startsWith('full-')) return null;

    let prior, current, selected;
    try {
      prior = JSON.parse(record.step.pre);
      current = JSON.parse(source.stamp);
      if (!plainObject(options) || options.type === 'full-size') return null;
      selected = normalizeBreakInOptions(options);
      if (JSON.stringify(selected) !== JSON.stringify(options)) return null;
    } catch { return null; }
    if (prior?.id !== source.id || !Array.isArray(prior.lines) || prior.lines.length !== before.lines.length || !prior.lines.every(Array.isArray) ||
      prior.currency !== current.currency || JSON.stringify(prior.codes) !== JSON.stringify(current.codes) ||
      JSON.stringify(prior.attributes) !== JSON.stringify(current.attributes) ||
      JSON.stringify(prior.applications) !== JSON.stringify(current.applications)) return null;
    const oldDiscounts = before.discountCodes;
    if (!Array.isArray(oldDiscounts) || JSON.stringify(oldDiscounts.map(item => [item?.code, item?.applicable]).sort()) !==
      JSON.stringify([...current.codes].sort())) return null;
    const oldLines = new Map(prior.lines.map(line => [line[0], line]));
    if (!before.lines.every(line => {
      const saved = oldLines.get(line.remoteLineId);
      return saved && JSON.stringify(saved.slice(1, 8)) === JSON.stringify([line.parentLineId, line.merchandiseId,
        line.productId, line.serviceType || null, line.quantity, line.throwingHand || null, sortedAttributes(line.attributes)]);
    })) return null;
    const eligible = source.lines.filter(line => !line.parentLineId && line.quantity === 1 && line.productId === parent.productId &&
      line.throwingHand === parent.throwingHand && matchingConfiguration(line, parent, 'break-in', selected) &&
      !source.lines.some(child => child.parentLineId === line.remoteLineId));
    if (eligible.length !== 1 || sameAttributes(eligible[0].attributes, parent.attributes)) return null;

    // Canonical line data includes quantity, attributes, monetary amounts and allocations.
    // Compare complete parent/child groups independently of IDs, and reject duplicate group signatures.
    const groups = lines => lines.filter(line => line[1] === null).map(parentLine => JSON.stringify([
      parentLine.slice(2), lines.filter(line => line[1] === parentLine[0]).map(line => line.slice(2))
    ])).sort();
    const original = groups(prior.lines);
    const remaining = groups(current.lines.filter(line => line[0] !== eligible[0].remoteLineId));
    if (new Set(original).size !== original.length || JSON.stringify(original) !== JSON.stringify(remaining)) return null;
    return JSON.stringify([source.stamp, record.key, record.raw]);
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

  const sameAttributes = (a, b) => JSON.stringify(sortedAttributes(a)) === JSON.stringify(sortedAttributes(b));

  // A first cart's journaled create intent against what Shopify holds under the candidate ID: the
  // same gloves and attached services, with the same merchandise, options and quantities, and nothing else.
  // A glove's selected hand is part of what was added. An intent without one (older records) is unknown
  // for a full-size glove, so it never matches one.
  const isFullSizeMerchandise = merchandiseId => products.some(product => product.line === 'full-size' &&
    product.variants?.some(variant => variant.id === merchandiseId));
  const intendedHand = line => Object.hasOwn(line, 'throwingHand') ? line.throwingHand ?? null
    : isFullSizeMerchandise(line.merchandiseId) ? '?' : null;
  function matchesCreateIntent(cart, intent) {
    if (!Array.isArray(intent) || !intent.length || cart.incomplete) return false;
    const key = (merchandiseId, attributes, parentMerchandiseId, hand) =>
      JSON.stringify([merchandiseId, sortedAttributes(attributes), parentMerchandiseId || null, hand]);
    const tally = entries => {
      const counts = new Map();
      for (const [entry, quantity] of entries) counts.set(entry, (counts.get(entry) || 0) + quantity);
      return JSON.stringify([...counts].sort(([a], [b]) => a.localeCompare(b)));
    };
    return tally(intent.map(line => [key(line.merchandiseId, line.attributes, line.parentMerchandiseId,
      line.parentMerchandiseId ? null : intendedHand(line)), line.quantity])) ===
      tally(cart.lines.map(line => [key(line.merchandiseId, line.attributes, line.isBreakIn
        ? cart.lines.find(parent => parent.remoteLineId === line.parentLineId)?.merchandiseId || '?' : null,
      line.isBreakIn ? null : line.throwingHand ?? null), line.quantity]));
  }

  // What the shopper tried to add, for the drawer to describe next to what Shopify saved.
  function describeCreateIntent(intent) {
    return (Array.isArray(intent) ? intent : []).filter(line => !line.parentMerchandiseId).map(line => ({
      productId: products.find(product => product.merchandiseId === line.merchandiseId ||
        product.variants?.some(variant => variant.id === line.merchandiseId))?.id || null,
      quantity: line.quantity,
      breakIn: intent.some(child => child.parentMerchandiseId === line.merchandiseId),
      ...(line.throwingHand ? { throwingHand: line.throwingHand } : {})
    }));
  }

  const createMismatch = () => new ShopifyRequestError('Shopify saved different items than were added.', 'create-mismatch');
  const completeRead = cart => !cart.missing && cart.lineCoverageComplete === true && !cart.discountsIncomplete;

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
  async function splitBreakIn(op, cart, parent, mode, options = null) {
    if (!parent.instructions?.canUpdateQuantity) throw new Error('Shopify does not allow this glove quantity to change.');
    const addService = mode !== 'remove';
        let firstMutationCompleted = false;
    try {
      let current;
      if (addService) {
        const input = { merchandiseId: parent.merchandiseId, quantity: 1,
          attributes: withServiceAttribute(parent.attributes, 'break-in', options) };
        const splitIntent = mode === 'change' && !parent.productId.startsWith('full-') ? { parentId: parent.remoteLineId, options } : null;
        await addLines(op, cart.id, [input], 'addition', splitIntent);
        firstMutationCompleted = true;
        current = await reread(op);
        let destination = resolveAddedDestination(cart, current, parent, 'break-in', options);
        const children = current.lines.filter(line => line.isBreakIn && line.parentLineId === destination.remoteLineId);
        if (children.length > 1 || children[0]?.quantity > destination.quantity) {
          throw new Error('Shopify returned inconsistent Break-in service children.');
        }
        if (!children.length) {
          const lines = [serviceLine(parent, options || DEFAULT_BREAK_IN, destination.quantity, destination.remoteLineId)];
          try {
            authorizeParentAdd(op, cart, current, destination, input, 'cartLinesAdd', { cartId: current.id, lines }, parent);
          } catch (error) {
            const step = op.current;
            if (error.code === 'cart-unverified' && splitIntent && step?.n === 1 && step.limited === current.stamp &&
              step.replyStamp === current.stamp && step.replyPairing === intermediateLineStamp(current.lines)) {
              assertSafetySnapshot(op.snapshot);
              rewriteOwn(op, { splitObservedStamp: current.stamp });
            }
            throw error;
          }
          await addLines(op, current.id, lines);
        } else if (children[0].quantity !== destination.quantity) {
          if (!children[0].instructions?.canUpdateQuantity) throw new Error('Shopify cannot synchronize the Break-in service quantity.');
          const lines = [{ id: children[0].remoteLineId, quantity: destination.quantity }];
          authorizeParentAdd(op, cart, current, destination, input, 'cartLinesUpdate', { cartId: current.id, lines }, parent);
          await updateLines(op, current.id, lines);
        }
        current = await reread(op);
        destination = resolveCurrentLine(current, destination);
        if (!current.lines.some(line => line.isBreakIn && line.parentLineId === destination.remoteLineId &&
          line.quantity === destination.quantity)) throw new Error('Shopify did not attach the Break-in service to the selected glove.');
        const source = resolveCurrentLine(current, parent);
        current = await decrementSplitSource(op, current, source, mode === 'change');
      } else {
        await addLines(op, cart.id, [{ merchandiseId: parent.merchandiseId, quantity: 1,
          attributes: withServiceAttribute(parent.attributes, 'none') }]);
        firstMutationCompleted = true;
        current = await reread(op);
        resolveAddedDestination(cart, current, parent, 'none');
        const source = resolveCurrentLine(current, parent);
        current = await decrementSplitSource(op, current, source, true);
      }
      current = await reread(op);
      verifySplit(cart, current, parent, withServiceAttribute(parent.attributes, addService ? 'break-in' : 'none', options),
        { add: 1, remove: -1, change: 0 }[mode]);
      if (addService) verifyServiceChoices(cart, current);
      return applySafety(current, { exclude: op.key });
    } catch (error) {
      throw error;
    }
  }

  // Moves one glove of a multi-glove line to its own line with `attributes` (the new wrist fit),
  // taking a copy of its break-in service along; the source line keeps its own fit.
  async function splitWristFit(op, cart, parent, attributes) {
    if (!parent.instructions?.canUpdateQuantity) throw new Error('Shopify does not allow this glove quantity to change.');
    const child = cart.lines.find(line => line.isBreakIn && line.parentLineId === parent.remoteLineId);
    const template = { ...parent, attributes };
        let firstMutationCompleted = false;
    try {
      const input = { merchandiseId: parent.merchandiseId, quantity: 1, attributes };
      await addLines(op, cart.id, [input], WRIST_FIT_CHANGE);
      firstMutationCompleted = true;
      let current = await reread(op);
      let destination = resolveAddedDestination(cart, current, template, parent.serviceConfiguration);
      if (child) {
        const children = current.lines.filter(line => line.isBreakIn && line.parentLineId === destination.remoteLineId);
        if (children.length > 1 || children[0]?.quantity > destination.quantity) {
          throw new Error('Shopify returned inconsistent Break-in service children.');
        }
        if (!children.length) {
          const lines = [{ merchandiseId: child.merchandiseId, quantity: destination.quantity,
            attributes: child.attributes, parent: { lineId: destination.remoteLineId } }];
          authorizeParentAdd(op, cart, current, destination, input, 'cartLinesAdd', { cartId: current.id, lines }, parent);
          await addLines(op, current.id, lines, WRIST_FIT_CHANGE);
        } else if (children[0].quantity !== destination.quantity) {
          if (!children[0].instructions?.canUpdateQuantity) throw new Error('Shopify cannot synchronize the Break-in service quantity.');
          const lines = [{ id: children[0].remoteLineId, quantity: destination.quantity }];
          authorizeParentAdd(op, cart, current, destination, input, 'cartLinesUpdate', { cartId: current.id, lines }, parent);
          await updateLines(op, current.id, lines, WRIST_FIT_CHANGE);
        }
        current = await reread(op);
        destination = resolveCurrentLine(current, destination);
        if (!current.lines.some(line => line.isBreakIn && line.parentLineId === destination.remoteLineId &&
          line.quantity === destination.quantity)) throw new Error('Shopify did not attach the Break-in service to the selected glove.');
      }
      current = await decrementSplitSource(op, current, resolveCurrentLine(current, parent), Boolean(child));
      current = await reread(op);
      verifySplit(cart, current, parent, attributes, 0);
      verifyServiceChoices(cart, current);
      return applySafety(current, { exclude: op.key });
    } catch (error) {
      throw error;
    }
  }


  // ---- Named transitions without a Shopify write ----
  // During a shopper's add, an active cart Shopify reports gone may be detached only when nothing but an exact
  // checkout freeze is recorded against it. The freeze record stays.
  function forgetMissingActiveCart(op, cartId) {
    const pending = pendingFor(cartId, { snapshot: op.snapshot, exclude: op.key });
    if (pending && (pending.unreadable || unpersistedUnsafe.has(cartId) || !onlyCheckoutFreeze(pending.records))) {
      throw new ShopifyRequestError('Shopify no longer has this cart, and an earlier change to it is unresolved.', 'cart-unresolved');
    }
    assertSafetySnapshot(op.snapshot);
    setPointer(op.snapshot, null, cartId);
    return emptyCart();
  }
  // Rewrites a record (2H or legacy) only from its exact current bytes.
  const rewriteRecord = (snapshot, record, changes) => {
    const { key, raw, malformed: _malformed, legacy: _legacy, ...fields } = record;
    return writeOwnedRecord(snapshot, key, { ...fields, ...changes }, raw);
  };
  // A terminal resolution for an exact record; it is removed when nothing else needs the cart IDs it names.
  function resolveRecord(snapshot, record, resolution, keepIds = [], changes = {}) {
    const terminal = rewriteRecord(snapshot, record, { status: 'terminal', resolution, resolvedAt: Date.now(), ...changes });
    const others = [...knownCartIds(terminal)].filter(id => !keepIds.includes(id));
    if (!others.length) { try { removeOwnedRecord(snapshot, record.key, terminal); } catch { /* terminal records do not gate */ } }
  }
  function markCreateMismatch(snapshot, records, cart, changes = {}) {
    for (const record of records) {
      rewriteRecord(snapshot, record, { ...changes, status: 'unresolved',
        kinds: [...new Set([...(record.kinds || []), CREATE_MISMATCH])], mismatch: { observedStamp: cart.stamp } });
    }
  }

  // Follows a first cart whose ID was journaled but never published, with reads only. A valid exact intent match or
  // a valid empty cart is adopted; a valid different cart becomes active under a mismatch record for the shopper's
  // explicit choice; a cart positively read missing is resolved absent for its exact ID. Invalid data changes nothing.
  async function reconcileUnconfirmedCart() {
    const snapshot = snapshotSafety();
    const records = firstCartRecords(snapshot);
    if (records.some(record => record.malformed)) throw new ShopifyRequestError('A cart record could not be read.', 'recovery-ambiguous');
    const candidates = records.filter(record => recordCandidates(record).length);
    if (!candidates.length) return getCart();
    const ids = [...new Set(candidates.flatMap(recordCandidates))];
    if (ids.length !== 1 || snapshot.pointer && snapshot.pointer !== ids[0]) {
      throw new ShopifyRequestError('More than one unconfirmed cart was found.', 'recovery-ambiguous');
    }
    const [id] = ids;
    const verdict = await readAuthoritativeCart(id);
    if (verdict.status === 'invalid' || verdict.status === 'limited') throw unverified('Shopify did not return the whole cart.');
    assertSafetySnapshot(snapshot);
    if (verdict.status === 'missing') {
      if (snapshot.pointer === id) setPointer(snapshot, null, id);
      for (const record of candidates) resolveRecord(snapshot, record, 'candidate absent', [id], { absentCartId: id });
    } else {
      const cart = verdict.cart;
      if (candidates.length === 1 && matchesCreateIntent(cart, candidates[0].createIntent) || !cart.lines.length && !cart.discountCodes.length) {
        if (snapshot.pointer !== id) setPointer(snapshot, id, null);
        for (const record of candidates) resolveRecord(snapshot, record, 'adopted', [id]);
      } else {
        // The mismatch is journaled before the cart becomes active, so no interruption leaves it recoverable.
        markCreateMismatch(snapshot, candidates, cart);
        if (snapshot.pointer !== id) setPointer(snapshot, id, null);
        for (const record of firstCartRecords(snapshot).filter(mismatchFor(id))) rewriteRecord(snapshot, record, { cartId: id });
      }
    }
    announceCartChange();
    return getCart();
  }

  // A mismatch choice is consent for exactly the reviewed state: the active pointer, the mismatch records' exact
  // bytes (`reviewBinding`), the complete review stamp, and a fresh valid read under the lock.
  async function reviewedMismatch(displayed) {
    const stale = () => new ShopifyRequestError('The cart changed since it was shown. Review it again.', 'cart-changed');
    const snapshot = snapshotSafety();
    const id = snapshot.pointer;
    const records = id ? liveRecords(snapshot, id) : [];
    const mismatched = records.filter(mismatchFor(id));
    if (!id || !displayed?.createMismatch || displayed.id !== id || typeof displayed.reviewStamp !== 'string' || !mismatched.length ||
      displayed.reviewBinding !== attemptBinding(mismatched)) throw stale();
    if (records.some(record => !mismatched.includes(record)) || unpersistedUnsafe.has(id)) {
      throw new ShopifyRequestError('The Shopify cart is incomplete: an earlier cart update has not been confirmed.', 'cart-unresolved');
    }
    const verdict = await readAuthoritativeCart(id);
    if (verdict.status !== 'valid' || verdict.cart.stamp !== displayed.reviewStamp) throw stale();
    assertSafetySnapshot(snapshot);
    return { id, snapshot, mismatched, current: verdict.cart };
  }
  async function keepUnconfirmedCart(displayed = null) {
    const { id, snapshot, mismatched, current } = await reviewedMismatch(displayed);
    for (const record of mismatched) resolveRecord(snapshot, record, 'kept', [id]);
    announceCartChange();
    return applySafety(current);
  }
  // The shopper leaves the reviewed cart unused: the pointer is detached first, and the records stay as terminal
  // abandonments that keep its ID discoverable.
  async function discardUnconfirmedCart(displayed = null) {
    const { id, snapshot, mismatched } = await reviewedMismatch(displayed);
    setPointer(snapshot, null, id);
    for (const record of mismatched) rewriteRecord(snapshot, record, { status: 'terminal', resolution: 'abandoned', abandonedCartId: id, resolvedAt: Date.now() });
    announceCartChange();
    return getCart();
  }
  // With an active cart: only a fresh explicit `cart: null` lets the shopper detach it (its records stay). Without
  // one: a first cart whose ID is known is reconciled first; an ID-less unknown needs affirmative abandonment,
  // recorded as a terminal decision. None of this sends a Shopify mutation.
  async function startNewCart({ abandonUnknown = false, binding } = {}) {
    const snapshot = snapshotSafety();
    const active = snapshot.pointer;
    const records = active ? liveRecords(snapshot, active) : firstCartRecords(snapshot);
    if (abandonUnknown && binding !== abandonmentBinding(snapshot, records)) {
      throw conflict('The cart changed since it was shown. Review it again.');
    }
    if (active) {
      const verdict = await readAuthoritativeCart(active);
      assertSafetySnapshot(snapshot);
      if (verdict.status === 'invalid') throw unverified('Shopify did not return the cart.');
      if (verdict.status !== 'missing') return applySafety(verdict.cart);
      setPointer(snapshot, null, active);
      announceCartChange();
      return getCart();
    }
    if (records.some(record => record.malformed)) throw new ShopifyRequestError('A cart record could not be read.', 'cart-unresolved');
    if (!records.length && !unpersistedCandidates.size) return getCart();
    const reconcileFirst = () => new ShopifyRequestError('A created cart must be checked before another is started.', 'create-reconcile-required');
    if (unpersistedCandidates.size) throw reconcileFirst();
    const ids = [...new Set(records.flatMap(recordCandidates))];
    if (abandonUnknown !== true) throw ids.length ? reconcileFirst() : new ShopifyRequestError('An earlier new cart was not confirmed.', 'create-unresolved');
    // A known candidate may be abandoned only when a fresh read shows it is not a valid cart to reconcile (Shopify
    // saved something this storefront cannot verify); a valid or missing candidate goes through reconciliation.
    if (ids.length) {
      if (ids.length !== 1) throw new ShopifyRequestError('More than one unconfirmed cart was found.', 'recovery-ambiguous');
      const verdict = await readAuthoritativeCart(ids[0]);
      assertSafetySnapshot(snapshot);
      if (verdict.status === 'valid' || verdict.status === 'missing') throw reconcileFirst();
    }
    for (const record of records) {
      assertSafetySnapshot(snapshot);
      rewriteRecord(snapshot, record, { status: 'terminal', resolution: 'abandoned', resolvedAt: Date.now(),
        ...(ids.length ? { abandonedCartId: ids[0] } : {}) });
    }
    announceCartChange();
    return getCart();
  }

  // ---- Recovery ----
  const uncertainRecovery = (message, cause) => new ShopifyRequestError(`Shopify recovery result is uncertain: ${message}`, 'uncertain', cause);
  const recoveryUnconfirmed = () => new ShopifyRequestError('An earlier recovery cart was not confirmed.', 'recovery-unconfirmed');
  const sourceChanged = () => new ShopifyRequestError('The original cart changed or could not be read completely during recovery. Check it again before continuing.', 'recovery-ambiguous');
  async function verifiedSource(unsafeId, sourceStamp) {
    const source = await getRawCart();
    if (source.id !== unsafeId || source.missing || source.stamp !== sourceStamp || readKey(SHOPIFY_CART_KEY) !== unsafeId) throw sourceChanged();
    return source;
  }
  // The shopper chose glove-only recovery for a cart whose service data is unreadable: that choice is journaled as
  // the cart's safety record before anything is sent.
  function recordServiceDataUnavailable(snapshot, cartId, observed) {
    const owner = newOwner();
    writeOwnedRecord(snapshot, UNSAFE_RECORD_PREFIX + owner, { v: JOURNAL_VERSION, owner, cartId, kind: 'service data unavailable',
      kinds: ['service data unavailable'], status: 'unresolved', createdAt: Date.now(), observedStamp: observed.stamp }, null);
  }
  const advanceRecovery = (op, changes) => rewriteOwn(op, { recovery: { ...op.record.recovery, ...changes } });
  const recoveryEvidence = (op, unsafeId) => id => {
    if (id === unsafeId) { op.conflict = id; return; }
    op.candidate ||= id;
    try {
      rewriteOwn(op, { recovery: { ...op.record.recovery, candidateCartId: op.record.recovery.candidateCartId || id, createUnverified: true },
        candidateCartIds: [...new Set([...(op.record.candidateCartIds || []), id])], step: { ...op.record.step, state: 'candidate-observed', evidence: id } });
    } catch { op.unpersisted = true; }
  };
  // A parent-only candidate holds exactly the copied gloves (merchandise, hand, options, quantities) and no service.
  const parentsVerified = (candidate, recovery) => completeRead(candidate) && candidate.id !== recovery.sourceCartId &&
    sameAttributes(candidate.attributes.filter(attribute => attribute.key !== PREORDER_ORDER_ATTRIBUTE), recovery.intent?.attributes || []) &&
    recoverySignature(candidate) === recovery.createdSignature && !candidate.lines.some(line => line.isBreakIn);

  async function recoverCartUnchecked({ withoutBreakIn = false, abandonUnconfirmed = false, binding, splitBinding } = {}) {
    const snapshot = snapshotSafety();
    const unsafeId = snapshot.pointer;
    if (!unsafeId) return getCart();
    const all = [...snapshot.entries].filter(([key]) => key.startsWith(UNSAFE_RECORD_PREFIX)).map(([key, raw]) => parseRecord(key, raw));
    // An adoption interrupted after its pointer moved: completed under the same gate, by reads only.
    const interrupted = all.find(record => record.kind === RECOVERY_KIND && record.status !== 'terminal' &&
      (record.status === 'adopting' || record.recovery?.stage === 'adopting') && record.recovery?.candidateCartId === unsafeId && record.cartId !== unsafeId);
    if (interrupted) return completeInterruptedAdoption(snapshot, interrupted);
    let records = liveRecords(snapshot, unsafeId);
    if (!records.length && !unpersistedUnsafe.has(unsafeId)) {
      const observed = await getRawCart();
      assertSafetySnapshot(snapshot);
      if (!serviceDataUnavailable(observed)) return applySafety(observed);
      if (!withoutBreakIn) throw new ShopifyRequestError('Only glove-only recovery is available for this cart.', 'recovery-ambiguous');
      recordServiceDataUnavailable(snapshot, unsafeId, observed);
      records = liveRecords(snapshot, unsafeId);
    }
    if (records.some(mismatchFor(unsafeId))) throw createMismatch();
    if (records.some(record => record.malformed || record.cartId === CREATE_PENDING)) {
      throw new ShopifyRequestError('Another cart record must be resolved before recovery.', 'recovery-ambiguous');
    }
    const attempts = records.filter(record => record.kind === RECOVERY_KIND && record.cartId === unsafeId);
    if (attempts.length && !abandonUnconfirmed) return resumeRecovery(snapshot, unsafeId, attempts, withoutBreakIn);
    // A fresh attempt is the shopper's consent for exactly the attempts shown, which stay intact as its predecessors.
    if (attempts.length && binding !== attemptBinding(attempts)) {
      throw new ShopifyRequestError('The earlier recovery attempt changed since it was shown. Review it again.', 'cart-changed');
    }
    const source = await getRawCart();
    if (source.id !== unsafeId || source.missing) throw new Error('Shopify has not returned the original cart for recovery.');
    const pending = pendingFor(unsafeId, { snapshot });
    const kinds = pending?.kinds || [];
    const legacyRecovery = withoutBreakIn && kinds.includes('service data unavailable') && canRecoverWithoutService(source);
    if (kinds.includes('service data unavailable') && !legacyRecovery) {
      throw new ShopifyRequestError('Only glove-only recovery is available for this cart.', 'recovery-ambiguous');
    }
    if (kinds.some(kind => kind.endsWith('validation failed'))) {
      throw new ShopifyRequestError('Shopify did not preserve the requested cart configuration. This cart cannot be recovered automatically.', 'recovery-ambiguous');
    }
    const historical = pending?.before;
    const splitRecoveryBinding = rotatedSplitRecovery(source, pending);
    if ((splitBinding !== undefined || pending?.records.some(record => record.splitObservedStamp)) &&
      (!splitRecoveryBinding || splitBinding !== splitRecoveryBinding || withoutBreakIn)) {
      throw new ShopifyRequestError('Review the prior Break-In configuration before continuing with verified items.', 'recovery-ambiguous');
    }
    if (source.incomplete && !legacyRecovery && !splitRecoveryBinding && (!historical || !snapshotMatchesUnaffectedLines(source, historical, kinds))) {
      throw new ShopifyRequestError('The original cart differs from the last verified cart. Its full contents cannot be established safely.', 'recovery-ambiguous');
    }
    const observed = legacyRecovery ? source : source.incomplete ? historical : source;
    if (!observed || observed.id !== unsafeId || !legacyRecovery && !hasConsistentBreakInLines(observed)) {
      throw new Error('Shopify has not returned a complete cart for recovery.');
    }
    const creates = records.filter(record => Array.isArray(record.createIntent) && record.createIntent.length);
    if (observed === source && creates.length && !creates.every(record => matchesCreateIntent(source, record.createIntent))) {
      assertSafetySnapshot(snapshot);
      markCreateMismatch(snapshot, creates, source);
      throw createMismatch();
    }
    // Glove-only recovery keeps each verified glove and its wrist fit and removes the service and its metadata.
    const verified = withoutBreakIn ? { ...observed, lines: observed.lines.filter(line => !line.isBreakIn).map(line => ({
      ...line, attributes: withServiceAttribute(line.attributes, 'none'), serviceConfiguration: 'none'
    })) } : observed;
    const parents = verified.lines.filter(line => !line.isBreakIn);
    // A new intentional clone keeps the cart's other attributes; preorder details are recomputed at checkout.
    const cloneAttributes = (source.attributes || []).filter(attribute => attribute.key !== PREORDER_ORDER_ATTRIBUTE);
    const input = {
      lines: parents.map(line => ({ merchandiseId: line.merchandiseId, quantity: line.quantity, attributes: line.attributes })),
      discountCodes: discountCodeList(verified),
      ...(cloneAttributes.length ? { attributes: cloneAttributes } : {})
    };
    const children = verified.lines.filter(line => line.isBreakIn).map(child => {
      const parentIndex = parents.findIndex(line => line.remoteLineId === child.parentLineId);
      if (parentIndex < 0) throw new Error('Shopify could not identify a Break-In parent in the recovery cart.');
      return { merchandiseId: child.merchandiseId, quantity: child.quantity, attributes: child.attributes, parentIndex };
    });
    assertSafetySnapshot(snapshot);
    const op = prepareOperation(snapshot, { cartId: unsafeId, kind: RECOVERY_KIND, kinds: [RECOVERY_KIND],
      recovery: { stage: 'create', sourceCartId: unsafeId,
        // The exact records that must still hold the source at adoption (including any checkout freeze).
        sourceRecords: records.filter(record => record.kind !== RECOVERY_KIND).map(record => ({ key: record.key, raw: record.raw })),
        // The exact earlier attempts this one supersedes; they stay intact until a verified resolution.
        supersedes: attempts.map(record => ({ key: record.key, raw: record.raw })),
        withoutBreakIn: Boolean(withoutBreakIn), sourceStamp: source.stamp, intent: { ...input, children },
        createdSignature: recoverySignature({ ...verified, lines: parents }), signature: recoverySignature(verified) } });
    try {
      const reply = await dispatchCartStep(op, { query: `mutation CreateCart($input: CartInput!) {
        cartCreate(input: $input) { cart { ${CART_FIELDS} } userErrors { message } }
      }`, variables: { input }, field: 'cartCreate', target: RECOVERY_TARGET, onEvidence: recoveryEvidence(op, unsafeId) });
      if (op.conflict) throw uncertainRecovery('Shopify did not create a separate recovery cart.');
      // On any ambiguous create, stop: a later explicit check may read the durable candidate.
      if (!reply.eligible || !reply.cartId || op.unpersisted) throw uncertainRecovery(reply.message);
      const verdict = await readAuthoritativeCart(reply.cartId);
      if (verdict.status === 'missing' || verdict.status === 'invalid') throw uncertainRecovery('Shopify did not return the recovery cart in a form we could verify.');
      if (!parentsVerified(verdict.cart, op.record.recovery)) throw recoveryUnconfirmed();
      op.current.outcome = 'reconciled';
      advanceRecovery(op, { stage: 'created', createUnverified: false });
      return await finishRecovery(op, unsafeId, verdict.cart);
    } catch (error) {
      if (!op.armed && !op.skipCleanup) { try { removeOwnedRecord(snapshot, op.key, op.raw); } catch { /* ignored for admission */ } }
      throw error;
    }
  }

  // Continues the one current attempt by reads first; a stage is never resent. Only a freshly verified parent-only
  // candidate whose attachment was provably never armed may send the attachment.
  async function resumeRecovery(snapshot, unsafeId, attempts, withoutBreakIn) {
    const current = currentAttempts(attempts);
    if (current.length !== 1) throw recoveryUnconfirmed();
    const [record] = current;
    if (Boolean(record.recovery?.withoutBreakIn) !== Boolean(withoutBreakIn)) {
      throw new ShopifyRequestError('An earlier recovery attempt used a different Break-In Service choice.', 'recovery-mode-mismatch');
    }
    const { stage, candidateCartId, sourceStamp } = record.recovery || {};
    if (!RECOVERY_STAGES.includes(stage) || !trustedCartId(candidateCartId) || typeof sourceStamp !== 'string') throw recoveryUnconfirmed();
    const op = resumeOperation(snapshot, record);
    // A 2G record names its source records by key only: authorize their exact current bytes before any read.
    const sourceRecords = (op.record.recovery.sourceRecords || []).map(entry => typeof entry === 'string' ? { key: entry, raw: snapshot.entries.get(entry) } : entry);
    if (sourceRecords.some(entry => typeof entry.raw !== 'string')) throw sourceChanged();
    op.record = { ...op.record, recovery: { ...op.record.recovery, sourceRecords } };
    await verifiedSource(unsafeId, sourceStamp);
    const verdict = await readAuthoritativeCart(candidateCartId);
    if (verdict.status === 'missing' || verdict.status === 'invalid') throw recoveryUnconfirmed();
    if (stage === 'create') {
      if (!parentsVerified(verdict.cart, op.record.recovery)) throw recoveryUnconfirmed();
      assertSafetySnapshot(snapshot);
      advanceRecovery(op, { stage: 'created', createUnverified: false });
    }
    return finishRecovery(op, unsafeId, verdict.cart);
  }

  function candidateHoldsRecovery(candidate, recovery) {
    if (candidate.incomplete || !completeRead(candidate) || recoverySignature(candidate) !== recovery.signature) return false;
    const parents = candidate.lines.filter(line => !line.isBreakIn);
    const children = candidate.lines.filter(line => line.isBreakIn);
    if (children.some(child => {
      const parent = parents.find(line => line.remoteLineId === child.parentLineId);
      return !parent || child.quantity !== parent.quantity;
    })) return false;
    if (parents.some(parent => children.filter(child => child.parentLineId === parent.remoteLineId).length > 1)) return false;
    if (children.length !== (recovery.intent?.children || []).length) return false;
    return !recovery.withoutBreakIn || !children.length && parents.every(line => line.serviceConfiguration === 'none');
  }


  async function finishRecovery(op, unsafeId, candidate) {
    const recovery = op.record.recovery;
    // Every answer must describe the journaled candidate: never the original (frozen) cart or any other.
    if (candidate.id !== recovery.candidateCartId || candidate.id === unsafeId) throw uncertainRecovery('Shopify answered for a different cart.');
    if (recovery.stage === 'created') {
      if (!parentsVerified(candidate, recovery)) throw recoveryUnconfirmed();
      const children = recovery.intent.children.map(child => {
        const parent = recovery.intent.lines[child.parentIndex];
        const matches = candidate.lines.filter(line => !line.isBreakIn && line.merchandiseId === parent?.merchandiseId &&
          sameAttributes(line.attributes, parent.attributes) && line.quantity === parent.quantity);
        if (matches.length !== 1) throw new Error('Shopify could not identify a Break-In parent in the recovery cart.');
        return { merchandiseId: child.merchandiseId, quantity: child.quantity, attributes: child.attributes, parent: { lineId: matches[0].remoteLineId } };
      });
      if (children.length) {
        const variables = { cartId: candidate.id, lines: children };
        assertSafetySnapshot(op.snapshot);
        // The parent-only candidate is authorized solely by the exact persisted recovery plan and this fresh read.
        // It never enters the general verified map.
        op.recoveryAttachment = { owner: op.owner, raw: op.raw, step: op.record.step?.n, target: candidate.id,
          stamp: candidate.stamp, body: JSON.stringify(['cartLinesAdd', variables]) };
        const reply = await dispatchCartStep(op, { query: `mutation AddLines($cartId: ID!, $lines: [CartLineInput!]!) {
          cartLinesAdd(cartId: $cartId, lines: $lines) { cart { ${CART_FIELDS} } userErrors { message } }
        }`, variables, field: 'cartLinesAdd', target: candidate.id,
        intent: { recovery: { ...op.record.recovery, stage: 'children' } }, onEvidence: targetEvidence(op, candidate.id) });
        // A reply that is not a clean answer is never adopted in this attempt; a later explicit check reads Shopify.
        if (op.conflict || !reply.eligible || reply.cartId !== candidate.id) throw uncertainRecovery(reply.message);
      }
    }
    // Verify the source again, then a fresh complete candidate read, then the whole safety snapshot.
    await verifiedSource(unsafeId, op.record.recovery.sourceStamp);
    const verdict = await readAuthoritativeCart(op.record.recovery.candidateCartId);
    if (verdict.status !== 'valid' || verdict.cart.id === unsafeId || !candidateHoldsRecovery(verdict.cart, op.record.recovery)) throw recoveryUnconfirmed();
    return adoptRecovery(op, unsafeId, verdict.cart);
  }
  // The exact participants authorized before the reads: the source records and the superseded attempts.
  const authorizedParticipants = recovery => [...(recovery.sourceRecords || []), ...(recovery.supersedes || []).filter(link => plainObject(link))];
  function assertNoForeignGates(op, ids, authorized) {
    const allowed = new Set([op.key, ...authorized.map(entry => entry.key)]);
    for (const entry of authorized) if (op.snapshot.entries.get(entry.key) !== entry.raw) throw sourceChanged();
    for (const id of ids) {
      if (unpersistedUnsafe.has(id) || liveRecords(op.snapshot, id).some(record => !allowed.has(record.key))) throw sourceChanged();
    }
  }
  // Releases exactly the authorized participants: a record still naming another known cart becomes terminal
  // (keeping that ID discoverable); the rest are removed. A participant whose bytes changed is left alone.
  function resolveParticipants(op, authorized, keepIds) {
    for (const entry of authorized) {
      try {
        if (readKey(entry.key) !== entry.raw) continue;
        const record = parseRecord(entry.key, entry.raw);
        const others = [...knownCartIds(entry.raw)].filter(id => !keepIds.includes(id));
        if (record.legacy || record.summary || entry.key === UNSAFE_CART_KEY || legacyRecordKeys.includes(entry.key) || !others.length) {
          removeOwnedRecord(op.snapshot, entry.key, entry.raw);
        } else {
          rewriteRecord(op.snapshot, record, { status: 'terminal', resolution: record.kind === RECOVERY_KIND ? 'superseded' : 'recovered', resolvedBy: op.key, resolvedAt: Date.now() });
        }
      } catch { /* conservative: the record stays */ }
    }
  }
  function adoptRecovery(op, unsafeId, confirmed) {
    const authorized = authorizedParticipants(op.record.recovery);
    assertNoForeignGates(op, [unsafeId, confirmed.id], authorized);
    assertSafetySnapshot(op.snapshot);
    rewriteOwn(op, { status: 'adopting', recovery: { ...op.record.recovery, stage: 'adopting' },
      adopting: { source: unsafeId, candidate: confirmed.id, participants: authorized } });
    setPointer(op.snapshot, confirmed.id, unsafeId);
    resolveParticipants(op, authorized, [unsafeId, confirmed.id]);
    retireOperation(op, 'adopted');
    announceCartChange();
    // Prices, discount applicability and service parity come from the confirmed read, not a mutation reply.
    return applySafety(confirmed);
  }
  async function completeInterruptedAdoption(snapshot, record) {
    const op = resumeOperation(snapshot, record);
    const { recovery } = op.record;
    const candidateId = recovery.candidateCartId;
    const authorized = op.record.adopting?.participants ||
      (recovery.sourceRecords || []).map(entry => typeof entry === 'string' ? { key: entry, raw: snapshot.entries.get(entry) } : entry).filter(entry => typeof entry.raw === 'string');
    // The original is validated by its recorded ID: unchanged, or gone from Shopify.
    const source = await readAuthoritativeCart(recovery.sourceCartId);
    if (source.status === 'invalid' || source.status !== 'missing' && source.cart.stamp !== recovery.sourceStamp) throw sourceChanged();
    const verdict = await readAuthoritativeCart(candidateId);
    if (verdict.status !== 'valid' || !candidateHoldsRecovery(verdict.cart, recovery)) throw recoveryUnconfirmed();
    assertNoForeignGates(op, [recovery.sourceCartId, candidateId], authorized);
    assertSafetySnapshot(snapshot);
    resolveParticipants(op, authorized, [recovery.sourceCartId, candidateId]);
    retireOperation(op, 'adopted');
    announceCartChange();
    return applySafety(verdict.cart);
  }

  function withCartLock(run, { ifAvailable = false } = {}) {
    if (!recoveryLocks?.request) {
      return Promise.reject(new ShopifyRequestError('Coordinated cart updates are unavailable in this browser.', 'lock-unavailable'));
    }
    const options = { mode: 'exclusive' };
    if (ifAvailable) options.ifAvailable = true;
    else if (typeof AbortSignal?.timeout === 'function') options.signal = AbortSignal.timeout(config.lockWaitMs ?? LOCK_WAIT_MS);
    // Only a request that never ran is a lock failure; an error raised while holding the lock keeps its meaning.
    let entered = false;
    return Promise.resolve().then(() => recoveryLocks.request(CART_LOCK, options, lock => { entered = true; return run(lock); })).catch(error => {
      if (entered) throw error;
      if (['AbortError', 'TimeoutError'].includes(error?.name)) {
        throw new ShopifyRequestError('Another tab is still updating the cart.', 'lock-timeout', error);
      }
      throw new ShopifyRequestError('Coordinated cart updates are unavailable in this browser.', 'lock-unavailable', error);
    });
  }

  // The write operations. Each receives its operation context explicitly from journaled().
  const operations = {
    async addProduct(op, productId, includeBreakIn, options = DEFAULT_BREAK_IN, merchandiseId = null, wristFit = 'regular') {
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
      // The selected hand is journaled with a first-cart create, from this selection alone.
      const selectedHand = fullSize ? (variant.selectedOptions?.find(option => option.name === 'Throwing Hand')?.value ||
        (product.throwHands.length === 1 && product.throwHands[0] === 'Right-Hand Throw' ? 'Right' : null)) : null;
      op.selection = { merchandiseId: selectedVariant, throwingHand: selectedHand };
      const cartId = readKey(SHOPIFY_CART_KEY);
      let before = cartId ? await getMutationCart(op) : emptyCart();
      // A frozen cart Shopify still has is never written; one Shopify reports gone is replaced explicitly.
      if (cartId && before.missing) before = forgetMissingActiveCart(op, cartId);
      else if (cartId && pendingFor(cartId, { exclude: op.key })) {
        throw new ShopifyRequestError('The Shopify cart is incomplete: an earlier cart update has not been confirmed.', 'cart-unresolved');
      }
      const verifiedCartId = before.id;
      if (before.incomplete) throw new Error('The Shopify cart is incomplete. Checkout is unavailable until the cart is corrected.');
      // An earlier first cart may hold an item under an ID this browser never learned. Another
      // cart is created only after the shopper chooses to start one; it is never automatic.
      if (!verifiedCartId) {
        if (firstCartRecords(snapshotSafety(), op.key).length || unpersistedCandidates.size) {
          throw new ShopifyRequestError('An earlier new cart was not confirmed.', 'create-unresolved');
        }
      }
      const conflictingParent = includeBreakIn && before.lines.some(line => !line.isBreakIn &&
        line.merchandiseId === selectedVariant);
      let updated;
      // The existing lines of this variant are the only lines a stock warning may name for this add.
      const attemptedLineIds = before.lines.filter(line => !line.isBreakIn && line.merchandiseId === selectedVariant).map(line => line.remoteLineId);
      if (conflictingParent) {
        let parentAdded = false;
        try {
          const sameAttributes = line => JSON.stringify([...line.attributes].sort((a, b) => a.key.localeCompare(b.key))) ===
            JSON.stringify([...lines[0].attributes].sort((a, b) => a.key.localeCompare(b.key)));
          const previous = before.lines.filter(line => !line.isBreakIn && line.merchandiseId === selectedVariant && sameAttributes(line));
          const previousQuantity = previous.reduce((sum, line) => sum + line.quantity, 0);
          const first = await addLines(op, verifiedCartId, [lines[0]]);
          parentAdded = true;
          if (await confirmStockRejection(op, before, first, attemptedLineIds)) throw stockLimitError(productId, cartLineQuantity(before, productId, false));
          const matching = first.lines.filter(line => !line.isBreakIn && line.merchandiseId === selectedVariant &&
            sameAttributes(line));
          const attached = first.lines.filter(line => line.parentLineId === matching[0]?.remoteLineId);
          if (matching.length !== 1 || matching[0].quantity !== previousQuantity + 1 || attached.length > 1 ||
            attached.length > 0 && ![previousQuantity, previousQuantity + 1].includes(attached[0].quantity)) {
            flag(op, 'addition validation failed');
            throw new Error('Shopify could not identify the new glove configuration.');
          }
          if (attached[0]?.quantity === previousQuantity + 1) {
            if (!serviceAttributes(selected).every(attribute => attached[0].attributes.some(saved =>
              saved.key === attribute.key && saved.value === attribute.value))) {
              flag(op, 'addition validation failed');
              throw new Error('Shopify did not preserve the selected Break-In preferences.');
            }
            updated = first;
          } else {
            const attachment = [{ ...lines[1], parent: { lineId: matching[0].remoteLineId } }];
            authorizeParentAdd(op, before, first, matching[0], lines[0], 'cartLinesAdd', { cartId: verifiedCartId, lines: attachment });
            updated = await addLines(op, verifiedCartId, attachment);
          }
          updated = await reread(op);
        } catch (error) {
          if (error.code === 'stock-limit') throw error;
          if (parentAdded) flag(op, 'addition');
          throw error;
        }
      } else {
        updated = verifiedCartId ? await addLines(op, verifiedCartId, lines) : await createCart(op, lines);
        if (verifiedCartId && await confirmStockRejection(op, before, updated, attemptedLineIds)) throw stockLimitError(productId, cartLineQuantity(before, productId, false));
      }
      // A new cart is judged on the fresh read of its candidate; it becomes active only after these checks pass.
      if (verifiedCartId) {
        try { updated = await reread(op); }
        catch (error) { flag(op, 'addition', before); throw error; }
      }
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
        // Every glove of the selected variant must report the hand the shopper chose.
        selectedHandPreserved: !fullSize || updated.lines.filter(line => !line.isBreakIn && line.merchandiseId === selectedVariant)
          .every(line => line.throwingHand === selectedHand),
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
        // Unverifiable discount data says nothing about the glove configuration, so it is reported as
        // what it is; the add stays unresolved, never a validation failure.
        if (updated.discountsIncomplete) {
          flag(op, 'addition', recoveryBefore);
          throw new ShopifyRequestError('Shopify did not return the cart’s discount codes.', 'cart-unverified');
        }
        const recoverablePartial = snapshotMatchesUnaffectedLines(updated, recoveryBefore, ['addition']);
        flag(op, recoverablePartial ? 'addition' : 'addition validation failed', recoveryBefore);
        throw new Error('Shopify did not preserve the selected glove service configuration. Checkout is unavailable.');
      }
      if (!verifiedCartId) publishCreated(op, updated);
      return applySafety(updated, { exclude: op.key });
    },
    async setLineQuantity(op, lineId, quantity) {
      const cart = await getMutationCart(op);
      const parent = cart.lines.find(line => line.remoteLineId === lineId && !line.isBreakIn);
      if (!parent) throw new Error('This glove line is no longer in the Shopify cart.');
      return setParentLineQuantity(op, cart, parent, quantity);
    },
    // A stepper's +1/-1. The line is found by its Shopify ID in the cart read under the lock; a
    // line that is gone or re-keyed is refused rather than matched to some other glove.
    async adjustLineQuantity(op, lineId, delta, expected = null) {
      const step = stepDelta(delta);
      const cart = await getMutationCart(op);
      const parent = cart.lines.find(line => line.remoteLineId === lineId && !line.isBreakIn);
      if (!parent) throw new ShopifyRequestError('This glove line changed in another tab.', 'cart-changed');
      return stepParentLine(op, cart, parent, step, expected);
    },
    async adjustQuantity(op, productId, delta) {
      const step = stepDelta(delta);
      const cart = await getMutationCart(op);
      const parents = cart.lines.filter(line => line.productId === productId && !line.isBreakIn);
      if (!parents.length) throw new ShopifyRequestError('This glove is no longer in the cart.', 'cart-changed');
      if (parents.length !== 1) throw new Error('Choose a specific glove cart entry to change its quantity.');
      return stepParentLine(op, cart, parents[0], step);
    },
    async removeLine(op, lineId) {
      const cart = await getMutationCart(op);
      const parent = cart.lines.find(line => line.remoteLineId === lineId && !line.isBreakIn);
      if (!parent) throw new Error('This glove line is no longer in the Shopify cart.');
      return removeParentLine(op, cart, parent);
    },
    // Options are the trainer customization the shopper confirmed in the cart; the
    // default exists only for callers that predate the cart customization form.
    async addBreakIn(op, lineId, options = null) {
      const cart = await getMutationCart(op);
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
      if (parent.quantity > 1) return splitBreakIn(op, cart, parent, 'add', selectedOptions);
      let started = false;
      try {
        const attributes = withServiceAttribute(parent.attributes, 'break-in', selectedOptions);
        await updateLines(op, cart.id, [{ id: parent.remoteLineId, attributes }], 'Break-In addition');
        started = true;
        let current = await getMutationCart(op);
        const selected = changedParent(cart, current, parent, 'break-in', false, selectedOptions);
        const children = current.lines.filter(line => line.isBreakIn && line.parentLineId === selected.remoteLineId);
        if (children.length > 1 || children[0]?.quantity > selected.quantity) throw new Error('Shopify returned inconsistent Break-in service lines.');
        if (children[0]?.quantity !== selected.quantity) {
          const prior = cart.lines.filter(line => line !== parent && !line.isBreakIn && line.merchandiseId === parent.merchandiseId &&
            sameAttributes(line.attributes, attributes));
          if (prior.length > 1) throw unverified('Shopify returned an ambiguous intermediate glove.');
          const [destination] = prior;
          const replaced = destination || parent;
          const expected = cart.lines.filter(line => !destination || line !== parent).map(line => {
            if (line === replaced) return { ...line, remoteLineId: selected.remoteLineId, attributes,
              quantity: parent.quantity + (destination?.quantity || 0) };
            if (line.parentLineId === replaced.remoteLineId) return { ...line, parentLineId: selected.remoteLineId };
            return line;
          });
          const rekeyed = selected.remoteLineId !== replaced.remoteLineId;
          if (!children.length) {
            const lines = [serviceLine(parent, selectedOptions, selected.quantity, selected.remoteLineId)];
            authorizeContinuation(op, cart, current, expected, 'cartLinesAdd', { cartId: cart.id, lines }, { rekeyed });
            await addLines(op, cart.id, lines, 'Break-In addition');
          } else {
            if (!children[0].instructions?.canUpdateQuantity) throw new Error('Shopify cannot synchronize the Break-in service quantity.');
            const lines = [{ id: children[0].remoteLineId, quantity: selected.quantity }];
            authorizeContinuation(op, cart, current, expected, 'cartLinesUpdate', { cartId: cart.id, lines }, { rekeyed });
            await updateLines(op, cart.id, lines, 'Break-In addition');
          }
        }
        current = await getMutationCart(op);
        if (current.incomplete || !hasConsistentBreakInLines(current) ||
          cartLineQuantity(current, parent.productId, false) !== cartLineQuantity(cart, parent.productId, false) ||
          cartLineQuantity(current, parent.productId, true) !== cartLineQuantity(cart, parent.productId, true) + parent.quantity) {
          throw new Error('Shopify did not attach the Break-in service to the selected glove.');
        }
        verifyServiceChoices(cart, current);
        return current;
      } catch (error) {
        if (started) flag(op, 'Break-In addition');
        throw error;
      }
    },
    async removeBreakIn(op, lineId) {
      const cart = await getMutationCart(op);
      if (cart.incomplete) throw new Error('The Shopify cart is incomplete. Please reload it before changing Break-in service.');
      const parent = cart.lines.find(line => line.remoteLineId === lineId && !line.isBreakIn);
      if (!parent) throw new Error('This glove line is no longer in the Shopify cart.');
      const child = cart.lines.find(line => line.isBreakIn && line.parentLineId === lineId);
      if (!child) return cart;
      if (parent.quantity > 1) return splitBreakIn(op, cart, parent, 'remove');
      if (!child.instructions?.canRemove) throw new Error('Shopify does not allow Break-in service to be removed.');
      let started = false;
      try {
        await removeLines(op, cart.id, [child.remoteLineId], 'Break-In removal');
        started = true;
        const afterRemoval = await getMutationCart(op);
        const selected = changedParent(cart, afterRemoval, parent, 'break-in', true);
        if (afterRemoval.lines.some(line => line.isBreakIn && line.parentLineId === selected.remoteLineId)) {
          throw new Error('Shopify did not remove the selected Break-in service.');
        }
        const lines = [{ id: selected.remoteLineId, attributes: withServiceAttribute(selected.attributes, 'none') }];
        authorizeContinuation(op, cart, afterRemoval, cart.lines.filter(line => line !== child), 'cartLinesUpdate', { cartId: cart.id, lines });
        await updateLines(op, cart.id, lines, 'Break-In removal');
        const updated = await getMutationCart(op);
        if (updated.incomplete || !hasConsistentBreakInLines(updated) ||
          cartLineQuantity(updated, parent.productId, false) !== cartLineQuantity(cart, parent.productId, false) ||
          cartLineQuantity(updated, parent.productId, true) !== cartLineQuantity(cart, parent.productId, true) - child.quantity) {
          throw new Error('Shopify did not remove only the Break-in service.');
        }
        try { verifySplit(cart, updated, parent, withServiceAttribute(parent.attributes, 'none'), -1); }
        catch (error) { flag(op, 'Break-In removal validation failed', cart); throw error; }
        return updated;
      } catch (error) {
        if (started) flag(op, 'Break-In removal');
        throw error;
      }
    },
    // Replaces one glove's break-in choices. A line of several gloves changes one glove only.
    async editBreakIn(op, lineId, options) {
      const cart = await getMutationCart(op);
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
      if (parent.quantity > 1) return splitBreakIn(op, cart, parent, 'change', selectedOptions);
      const { attributes: childAttributes } = serviceLine(parent, selectedOptions, child.quantity, parent.remoteLineId);
      // One request updates both lines; the service line goes first so a merge into an
      // identical glove line keeps the new choices. mutateCart marks an unanswered request.
      await updateLines(op, cart.id, [{ id: child.remoteLineId, attributes: childAttributes },
        { id: parent.remoteLineId, attributes: withServiceAttribute(parent.attributes, 'break-in', selectedOptions) }], SERVICE_CHANGE_KINDS.change);
      try {
        const updated = await reread(op);
        verifySplit(cart, updated, parent, withServiceAttribute(parent.attributes, 'break-in', selectedOptions), 0);
        verifyServiceChoices(cart, updated);
        return applySafety(updated, { exclude: op.key });
      } catch (error) {
        flag(op, SERVICE_CHANGE_KINDS.change);
        throw error;
      }
    },
    // Sets one glove's wrist fit. A line of several gloves changes one glove only; break-in stays as it was.
    async setWristFit(op, lineId, fit) {
      const cart = await getMutationCart(op);
      if (cart.incomplete) throw new Error('The Shopify cart is incomplete. Please reload it before changing the wrist fit.');
      const parent = cart.lines.find(line => line.remoteLineId === lineId && !line.isBreakIn);
      if (!parent) throw new Error('This glove line is no longer in the Shopify cart.');
      if (wristFitOf(parent) === normalizeWristFit(fit)) return cart;
      const attributes = withWristFit(parent.attributes, fit);
      if (parent.quantity > 1) return splitWristFit(op, cart, parent, attributes);
      await updateLines(op, cart.id, [{ id: parent.remoteLineId, attributes }], WRIST_FIT_CHANGE);
      try {
        const updated = await reread(op);
        verifySplit(cart, updated, parent, attributes, 0);
        verifyServiceChoices(cart, updated);
        return applySafety(updated, { exclude: op.key });
      } catch (error) {
        flag(op, WRIST_FIT_CHANGE);
        throw error;
      }
    },
    async setQuantity(op, productId, quantity) {
      const cart = await getMutationCart(op);
      const parents = cart.lines.filter(line => line.productId === productId && !line.isBreakIn);
      if (!parents.length) return cart;
      if (parents.length !== 1) throw new Error('Choose a specific glove cart entry to change its quantity.');
      return setParentLineQuantity(op, cart, parents[0], quantity);
    },
    async removeProduct(op, productId) {
      const cart = await getMutationCart(op);
      const parents = cart.lines.filter(line => line.productId === productId && !line.isBreakIn);
      if (!parents.length) return cart;
      if (parents.length !== 1) throw new Error('Choose a specific glove cart entry to remove.');
      return removeParentLine(op, cart, parents[0]);
    }
  };


  async function recoverCart(options) {
    if (!recoveryLocks?.request) {
      throw new ShopifyRequestError('Exclusive cart recovery is unavailable in this browser.', 'recovery-lock-unavailable');
    }
    return withCartLock(lock => {
      if (!lock) throw new ShopifyRequestError('A cart mutation is still active. Try recovery after it finishes.', 'recovery-ambiguous');
      return recoverCartUnchecked(options);
    }, { ifAvailable: true });
  }

  // The one admission and lifecycle wrapper for a public write. Under the lock it checks the exact safety
  // snapshot, prepares one root record and the revision notice, runs the operation with that explicit context,
  // and settles only from the operation's own verified state: completed, or every armed step observed unchanged.
  // An error code never proves settlement; anything else stays unresolved and blocks across reload.
  async function journaled(name, kind, operation) {
    const snapshot = snapshotSafety();
    const target = snapshot.pointer || CREATE_PENDING;
    const gates = liveRecords(snapshot, snapshot.pointer);
    const blocked = gates.length || unpersistedUnsafe.has(target) || target === CREATE_PENDING && unpersistedCandidates.size;
    // An add may pass an exact checkout freeze only to learn from Shopify that the frozen cart is gone.
    if (blocked && !(name === 'addProduct' && target !== CREATE_PENDING && !unpersistedUnsafe.has(target) && onlyCheckoutFreeze(gates))) {
      if (target === CREATE_PENDING && (unpersistedCandidates.size || gates.some(record => record.cartId === CREATE_PENDING))) {
        throw new ShopifyRequestError('An earlier new cart was not confirmed.', 'create-unresolved');
      }
      throw new ShopifyRequestError('The Shopify cart is incomplete: an earlier cart update has not been confirmed.', 'cart-unresolved');
    }
    const op = prepareOperation(snapshot, { cartId: target, kind: name, kinds: [kind] });
    try {
      const result = await operation(op);
      if (op.current?.limited) throw unverified('Shopify did not preserve the expected cart configuration.');
      retireOperation(op, 'completed');
      if (op.armed) announceCartChange();
      return result;
    } catch (error) {
      if (op.skipCleanup) throw error;
      if (!op.armed) {
        try { removeOwnedRecord(op.snapshot, op.key, op.raw); } catch { /* prepared, never armed: ignored for admission */ }
      } else if (!op.flags.size && !op.unpersisted && !op.conflict && op.steps.every(step => step.outcome === 'unchanged')) {
        retireOperation(op, 'observed unchanged');
      } else leaveUnresolved(op);
      throw error;
    }
  }

  // ---- Checkout ----
  // Holds the exclusive lock through navigation. A fresh valid read and a clean safety snapshot come before any
  // preorder write; a displayed cart that differs gets a verified review. After the freeze is persisted and the
  // revision published, safety is rechecked synchronously and navigation is invoked once.
  async function checkoutUnchecked(displayedCart, { requireReview = false } = {}, navigate) {
    const blocked = (message, cart) => ({ status: 'blocked', message, ...(cart ? { cart } : {}) });
    const verifyFailed = cart => blocked('Shopify could not verify your cart. Check your cart before checkout.', cart);
    const changing = () => blocked('A cart change is still being checked. Check your cart before checkout.');
    let snapshot = snapshotSafety();
    const id = snapshot.pointer;
    if (!id) return blocked('Your cart is unavailable. Check your cart and try again.');
    if (pendingFor(id, { snapshot })) return changing();
    const unavailable = cart => cart.lines.some(line => !line.isBreakIn && preorderState(products.find(product => product.id === line.productId)).status === 'blocked');
    if (unavailable(displayedCart)) return blocked('A preorder glove in your cart isn’t available right now. Remove it to continue.');
    let verdict = await readAuthoritativeCart(id);
    if (verdict.status === 'limited') return verifyFailed(applySafety(verdict.cart, { snapshot }));
    assertSafetySnapshot(snapshot);
    if (verdict.status === 'invalid' && verdict.reason === 'checkout url') return blocked('We couldn’t open secure checkout. Check your cart and try again.');
    if (verdict.status !== 'valid') return verifyFailed();
    const reviewed = verdict.cart;
    if (!checkoutCartIsComplete(reviewed)) return verifyFailed(reviewed);
    if (unavailable(reviewed)) return blocked('A preorder glove in your cart isn’t available right now. Remove it to continue.');
    // A changed (or explicitly unreviewed) cart is shown for review first; integrity failures never reach here.
    if (requireReview || displayedCart?.stamp !== reviewed.stamp) {
      return { status: 'review', cart: applySafety(reviewed, { snapshot }), message: 'Your cart changed. Review the items, then choose Checkout again.' };
    }
    let final = reviewed;
    if (preorderAttribute(reviewed) !== preorderOrderAttributeValue(reviewed.lines, productId => products.find(product => product.id === productId))) {
      try { await journaled('checkout', 'preorder details', op => { op.verified.set(reviewed.id, reviewed); return syncPreorderOrderAttribute(op, reviewed); }); }
      catch { return blocked('Couldn’t save your preorder details with Shopify. Check your cart and try again.'); }
      snapshot = snapshotSafety();
      if (pendingFor(id, { snapshot })) return changing();
      verdict = await readAuthoritativeCart(id);
      assertSafetySnapshot(snapshot);
      if (verdict.status === 'invalid' && verdict.reason === 'checkout url') return blocked('We couldn’t open secure checkout. Check your cart and try again.');
      if (verdict.status !== 'valid' || !checkoutCartIsComplete(verdict.cart)) return verifyFailed();
      // Only the verified preorder snapshot may differ from what the shopper reviewed.
      if (purchaseStamp(verdict.cart) !== purchaseStamp(reviewed)) {
        return { status: 'review', cart: applySafety(verdict.cart, { snapshot }), message: 'Your cart changed. Review the items, then choose Checkout again.' };
      }
      final = verdict.cart;
    }
    // The approved URL from this exact read.
    const url = verifiedCheckoutUrl(final.checkoutUrl);
    if (!url) return blocked('We couldn’t open secure checkout. Check your cart and try again.');
    const owner = newOwner();
    const freezeKey = UNSAFE_RECORD_PREFIX + owner;
    let freezeRaw;
    try {
      freezeRaw = writeOwnedRecord(snapshot, freezeKey, { v: JOURNAL_VERSION, owner, type: 'freeze', cartId: final.id, kind: 'checkout handoff',
        kinds: ['checkout handoff'], status: 'frozen', createdAt: Date.now(), before: minimalSnapshot(final) }, null);
      // Other tabs' checks must learn of the freeze before this tab leaves for checkout.
      announceCartChange(true);
      assertSafetySnapshot(snapshot);
    } catch {
      try { if (freezeRaw) removeOwnedRecord(snapshot, freezeKey, freezeRaw); } catch { /* the freeze stays: conservative */ }
      return blocked('Couldn’t save checkout safety information. Please try again.');
    }
    // Once navigation is invoked, the freeze stays whatever happens: an exception, a dropped handoff, a cancelled
    // leave, or a back/forward-cache return. Only explicit recovery into a new cart lifts it.
    try { navigate(url); }
    catch { return blocked('Couldn’t open secure checkout. Check your cart and try again.'); }
    return { status: 'navigating', cart: final, checkoutUrl: url, revision: readKey(CART_REVISION_KEY) };
  }

  const api = {
    mode: 'shopify',
    async listProducts() {
      catalogLoad = loadCatalog();
      return catalogLoad;
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
        remoteBreakInService = { ...breakInService, name: service.title, merchandiseId: breakInVariant.id, price, currencyCode, available: breakInVariant.availableForSale };
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
    // Observations: getCart, peekCart and refreshCart (Check cart) never write a journal record, the pointer, the
    // revision or a baseline. peekCart gives null for a cart Shopify reports missing.
    getCart,
    async peekCart() {
      const cart = await getCart();
      return cart.missing ? null : cart;
    },
    refreshCart: () => getCart(),
    // Read fresh from shared storage every time, so another tab's unresolved operation always counts.
    readCartSafety() {
      const revision = safeRead(CART_REVISION_KEY);
      const id = safeRead(SHOPIFY_CART_KEY);
      const unresolved = id && pendingFor(id);
      const changed = revision !== safeRead(CART_REVISION_KEY);
      const unsafeId = id && (unresolved || changed) ? id : null;
      return { id, unsafeId, pendingCartId: unsafeId, revision };
    },
    recoverCart,
    async checkout(displayedCart, options, navigate) {
      if (!recoveryLocks?.request) return { status: 'blocked', message: 'Secure checkout is unavailable in this browser. Please try another browser.' };
      try {
        return await withCartLock(lock => lock ? checkoutUnchecked(displayedCart, options, navigate)
          : { status: 'blocked', message: 'A cart change is still being checked. Check your cart before checkout.' }, { ifAvailable: true });
      } catch (error) {
        return { status: 'blocked', message: error?.code === 'cart-changed' ? 'Your cart changed in another tab. Check your cart before checkout.'
          : 'Couldn’t open secure checkout. Check your cart and try again.' };
      }
    }
  };
  const safeRead = key => { try { return storage?.getItem(key) ?? null; } catch { return null; } };
  // Each public write holds the exclusive cart lock for the whole operation, including its validation reads and
  // paired service updates, and receives its operation context explicitly.
  const writeKinds = { addProduct: 'addition', setLineQuantity: 'quantity update', setQuantity: 'quantity update',
    adjustLineQuantity: 'quantity update', adjustQuantity: 'quantity update', removeLine: 'removal', removeProduct: 'removal',
    addBreakIn: SERVICE_CHANGE_KINDS.add, removeBreakIn: SERVICE_CHANGE_KINDS.remove, editBreakIn: SERVICE_CHANGE_KINDS.change,
    setWristFit: WRIST_FIT_CHANGE };
  for (const [name, kind] of Object.entries(writeKinds)) {
    api[name] = (...args) => withCartLock(() => journaled(name, kind, op => operations[name](op, ...args)));
  }
  api.applyDiscountCode = code => withCartLock(() => journaled('applyDiscountCode', 'discount update', op => changeDiscountCode(op, 'apply', code)));
  api.removeDiscountCode = code => withCartLock(() => journaled('removeDiscountCode', 'discount update', op => changeDiscountCode(op, 'remove', code)));
  api.startNewCart = options => withCartLock(() => startNewCart(options));
  api.reconcileUnconfirmedCart = () => withCartLock(() => reconcileUnconfirmedCart());
  api.keepUnconfirmedCart = displayed => withCartLock(() => keepUnconfirmedCart(displayed));
  api.discardUnconfirmedCart = displayed => withCartLock(() => discardUnconfirmedCart(displayed));
  return api;
}

export function createCommerce({ env = import.meta.env || {}, storage = globalThis.localStorage, fetchImpl = globalThis.fetch } = {}) {
  const config = validateShopifyConfig(env);
  return config ? createShopifyCommerce(config, storage, fetchImpl) : createLocalCommerce(storage);
}
