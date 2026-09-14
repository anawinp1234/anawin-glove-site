import { breakInService, localProducts, productHandleMap } from './catalog.js';

const LOCAL_CART_KEY = 'anawin-cart';
const SHOPIFY_CART_KEY = 'anawin-shopify-cart-id';

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
      lines.push({ productId: product.id, quantity: item.breakInQuantity, merchandiseId: null, isBreakIn: true });
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
    async addProduct(productId, includeBreakIn) {
      const current = state.items[productId] || { quantity: 0, breakInQuantity: 0 };
      current.quantity = Math.min(9, current.quantity + 1);
      if (includeBreakIn) current.breakInQuantity = current.quantity;
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
  const accessToken = env.VITE_SHOPIFY_STOREFRONT_ACCESS_TOKEN || '';
  const apiVersion = env.VITE_SHOPIFY_API_VERSION || '2026-07';
  const handles = productHandleMap(env);
  const breakInHandle = env.VITE_SHOPIFY_BREAK_IN_HANDLE || '';
  const missingHandles = Object.entries(handles).filter(([, value]) => !value).map(([key]) => key);

  if (!domain.endsWith('.myshopify.com')) throw new Error('Shopify store domain must end in .myshopify.com.');
  if (!accessToken) throw new Error('Shopify public Storefront API token is missing.');
  if (!/^\d{4}-\d{2}$/.test(apiVersion)) throw new Error('Shopify API version must use YYYY-MM format.');
  if (missingHandles.length) throw new Error(`Shopify product handles are missing for: ${missingHandles.join(', ')}.`);
  if (!breakInHandle) throw new Error('Shopify break-in service handle is missing.');
  return { domain, accessToken, apiVersion, handles, breakInHandle };
}

export async function shopifyRequest(config, query, variables = {}, fetchImpl = fetch) {
  const response = await fetchImpl(`https://${config.domain}/api/${config.apiVersion}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Storefront-Access-Token': config.accessToken
    },
    body: JSON.stringify({ query, variables })
  });
  if (!response.ok) throw new Error(`Shopify request failed (${response.status}).`);
  const payload = await response.json();
  if (payload.errors?.length) throw new Error(payload.errors.map(error => error.message).join(' '));
  return payload.data;
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
  lines(first: 50) {
    nodes {
      id quantity attributes { key value }
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

function normalizeShopifyCart(cart, handleToProductId, breakInHandle) {
  if (!cart) return emptyCart();
  return {
    id: cart.id,
    checkoutUrl: cart.checkoutUrl,
    subtotal: Number(cart.cost.subtotalAmount.amount),
    currencyCode: cart.cost.subtotalAmount.currencyCode,
    lines: cart.lines.nodes.map(line => {
      const handle = line.merchandise.product.handle;
      const parent = line.attributes.find(attribute => attribute.key === '_anawin_parent')?.value;
      return {
        remoteLineId: line.id,
        merchandiseId: line.merchandise.id,
        productId: handle === breakInHandle ? parent : handleToProductId[handle],
        quantity: line.quantity,
        isBreakIn: handle === breakInHandle
      };
    }).filter(line => line.productId)
  };
}

export function createShopifyCommerce(config, storage, fetchImpl = fetch) {
  let products = [];
  let breakInVariant = null;
  let remoteBreakInService = breakInService;
  const handleToProductId = Object.fromEntries(Object.entries(config.handles).map(([id, handle]) => [handle, id]));
  const request = (query, variables) => shopifyRequest(config, query, variables, fetchImpl);

  async function loadProduct(handle) {
    const data = await request(PRODUCT_QUERY, { handle });
    if (!data.product?.variants.nodes[0]) throw new Error(`Shopify product “${handle}” was not found or has no variant.`);
    return data.product;
  }

  async function getCart() {
    const id = storage?.getItem(SHOPIFY_CART_KEY);
    if (!id) return emptyCart();
    const data = await request(`query Cart($id: ID!) { cart(id: $id) { ${CART_FIELDS} } }`, { id });
    if (!data.cart) {
      storage?.removeItem(SHOPIFY_CART_KEY);
      return emptyCart();
    }
    return normalizeShopifyCart(data.cart, handleToProductId, config.breakInHandle);
  }

  async function mutateCart(query, variables, field) {
    const data = await request(query, variables);
    const cart = assertCartPayload(data[field]);
    storage?.setItem(SHOPIFY_CART_KEY, cart.id);
    return normalizeShopifyCart(cart, handleToProductId, config.breakInHandle);
  }

  async function createCart(lines) {
    return mutateCart(`mutation CreateCart($input: CartInput!) {
      cartCreate(input: $input) { cart { ${CART_FIELDS} } userErrors { message } }
    }`, { input: { lines } }, 'cartCreate');
  }

  return {
    mode: 'shopify',
    async listProducts() {
      const entries = await Promise.all(Object.entries(config.handles).map(async ([id, handle]) => [id, await loadProduct(handle)]));
      const service = await loadProduct(config.breakInHandle);
      breakInVariant = service.variants.nodes[0];
      remoteBreakInService = {
        ...breakInService,
        name: service.title,
        merchandiseId: breakInVariant.id,
        price: Number(breakInVariant.price.amount),
        currencyCode: breakInVariant.price.currencyCode,
        available: breakInVariant.availableForSale
      };
      products = localProducts.map(local => {
        const remote = entries.find(([id]) => id === local.id)[1];
        const variant = remote.variants.nodes[0];
        return { ...local, handle: remote.handle, merchandiseId: variant.id, price: Number(variant.price.amount), currencyCode: variant.price.currencyCode, available: variant.availableForSale };
      });
      return products;
    },
    async getBreakInService() { return remoteBreakInService; },
    getCart,
    async addProduct(productId, includeBreakIn) {
      const product = products.find(item => item.id === productId);
      if (!product?.merchandiseId || !product.available) throw new Error('This glove is not currently available from Shopify.');
      const lines = [{ merchandiseId: product.merchandiseId, quantity: 1 }];
      if (includeBreakIn) {
        if (!breakInVariant?.availableForSale) throw new Error('Break-in service is not currently available.');
        lines.push({ merchandiseId: breakInVariant.id, quantity: 1, attributes: [{ key: '_anawin_parent', value: productId }] });
      }
      const cartId = storage?.getItem(SHOPIFY_CART_KEY);
      if (!cartId) return createCart(lines);
      return mutateCart(`mutation AddLines($cartId: ID!, $lines: [CartLineInput!]!) {
        cartLinesAdd(cartId: $cartId, lines: $lines) { cart { ${CART_FIELDS} } userErrors { message } }
      }`, { cartId, lines }, 'cartLinesAdd');
    },
    async setQuantity(productId, quantity) {
      const cart = await getCart();
      const related = cart.lines.filter(line => line.productId === productId);
      if (!cart.id || !related.length) return cart;
      const next = Math.max(0, Math.min(9, quantity));
      if (!next) return this.removeProduct(productId);
      const lines = related.map(line => ({ id: line.remoteLineId, quantity: next }));
      return mutateCart(`mutation UpdateLines($cartId: ID!, $lines: [CartLineUpdateInput!]!) {
        cartLinesUpdate(cartId: $cartId, lines: $lines) { cart { ${CART_FIELDS} } userErrors { message } }
      }`, { cartId: cart.id, lines }, 'cartLinesUpdate');
    },
    async removeProduct(productId) {
      const cart = await getCart();
      const lineIds = cart.lines.filter(line => line.productId === productId).map(line => line.remoteLineId);
      if (!cart.id || !lineIds.length) return cart;
      return mutateCart(`mutation RemoveLines($cartId: ID!, $lineIds: [ID!]!) {
        cartLinesRemove(cartId: $cartId, lineIds: $lineIds) { cart { ${CART_FIELDS} } userErrors { message } }
      }`, { cartId: cart.id, lineIds }, 'cartLinesRemove');
    }
  };
}

export function createCommerce({ env = import.meta.env || {}, storage = globalThis.localStorage, fetchImpl = globalThis.fetch } = {}) {
  const config = validateShopifyConfig(env);
  return config ? createShopifyCommerce(config, storage, fetchImpl) : createLocalCommerce(storage);
}
