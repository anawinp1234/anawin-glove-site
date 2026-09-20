import { breakInService, localProducts, productHandleMap } from './catalog.js';

const LOCAL_CART_KEY = 'anawin-cart';
const SHOPIFY_CART_KEY = 'anawin-shopify-cart-id';
const SERVICE_ATTRIBUTE = '_anawin_service';
const UNSAFE_CART_KEY = 'anawin-shopify-unsafe-cart-id';

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
  const accessToken = env.VITE_SHOPIFY_STOREFRONT_TOKEN || '';
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
    pageInfo { hasNextPage }
    nodes {
      id quantity attributes { key value }
      cost { amountPerQuantity { amount currencyCode } }
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

function normalizeShopifyCart(cart, handleToProductId, breakInHandle) {
  if (!cart) return emptyCart();
  const lines = cart.lines.nodes.map(line => {
    const handle = line.merchandise.product.handle;
    const parentId = line.parentRelationship?.parent.id;
    const parentHandle = line.parentRelationship?.parent.merchandise.product.handle;
    const unitMoney = line.cost?.amountPerQuantity;
    return {
      remoteLineId: line.id,
      merchandiseId: line.merchandise.id,
      parentLineId: parentId || null,
      productId: handle === breakInHandle ? handleToProductId[parentHandle] : handleToProductId[handle],
      quantity: line.quantity,
      unitPrice: {
        amount: unitMoney?.amount == null ? NaN : Number(unitMoney.amount),
        currencyCode: unitMoney?.currencyCode || null
      },
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
    incomplete: lines.length !== cart.lines.nodes.length || Boolean(cart.lines.pageInfo?.hasNextPage),
    lines
  };
  normalized.incomplete ||= !hasConsistentBreakInLines(normalized);
  normalized.incomplete ||= lines.some(parent => !parent.isBreakIn && !cartUnitPrice(parent,
    lines.find(child => child.isBreakIn && child.parentLineId === parent.remoteLineId)));
  return normalized;
}

function cartLineQuantity(cart, productId, isBreakIn) {
  return cart.lines.filter(line => line.productId === productId && line.isBreakIn === isBreakIn)
    .reduce((sum, line) => sum + line.quantity, 0);
}

function hasConsistentBreakInLines(cart) {
  return cart.lines.filter(line => line.isBreakIn).every(child => {
    const parent = cart.lines.find(line => !line.isBreakIn && line.remoteLineId === child.parentLineId);
    return parent?.productId === child.productId && parent.quantity === child.quantity;
  }) && cart.lines.filter(line => !line.isBreakIn).every(parent => {
    const attributes = parent.attributes.filter(attribute => attribute.key === SERVICE_ATTRIBUTE);
    const children = cart.lines.filter(line => line.isBreakIn && line.parentLineId === parent.remoteLineId);
    return attributes.length === 1 &&
      (attributes[0].value === 'none' && children.length === 0 ||
        attributes[0].value === 'break-in' && children.length === 1 && children[0].quantity === parent.quantity);
  });
}

function withServiceAttribute(attributes, value) {
  return [...attributes.filter(attribute => attribute.key !== SERVICE_ATTRIBUTE), { key: SERVICE_ATTRIBUTE, value }];
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

export function createShopifyCommerce(config, storage, fetchImpl = fetch) {
  let products = [];
  let breakInVariant = null;
  let remoteBreakInService = breakInService;
  const handleToProductId = Object.fromEntries(Object.entries(config.handles).map(([id, handle]) => [handle, id]));
  const request = (query, variables) => shopifyRequest(config, query, variables, fetchImpl);
  const markUnsafe = cartId => storage?.setItem(UNSAFE_CART_KEY, cartId);
  const applySafety = cart => {
    if (storage?.getItem(UNSAFE_CART_KEY) === cart.id) cart.incomplete = true;
    if (!cart.lines.length) storage?.removeItem(UNSAFE_CART_KEY);
    return cart;
  };

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
    return applySafety(normalizeShopifyCart(data.cart, handleToProductId, config.breakInHandle));
  }

  async function mutateCart(query, variables, field) {
    const data = await request(query, variables);
    const cart = assertCartPayload(data[field]);
    storage?.setItem(SHOPIFY_CART_KEY, cart.id);
    return applySafety(normalizeShopifyCart(cart, handleToProductId, config.breakInHandle));
  }

  const updateLines = (cartId, lines) => mutateCart(`mutation UpdateLines($cartId: ID!, $lines: [CartLineUpdateInput!]!) {
    cartLinesUpdate(cartId: $cartId, lines: $lines) { cart { ${CART_FIELDS} } userErrors { message } }
  }`, { cartId, lines }, 'cartLinesUpdate');

  const addLines = (cartId, lines) => mutateCart(`mutation AddLines($cartId: ID!, $lines: [CartLineInput!]!) {
    cartLinesAdd(cartId: $cartId, lines: $lines) { cart { ${CART_FIELDS} } userErrors { message } }
  }`, { cartId, lines }, 'cartLinesAdd');

  const removeLines = (cartId, lineIds) => mutateCart(`mutation RemoveLines($cartId: ID!, $lineIds: [ID!]!) {
    cartLinesRemove(cartId: $cartId, lineIds: $lineIds) { cart { ${CART_FIELDS} } userErrors { message } }
  }`, { cartId, lineIds }, 'cartLinesRemove');

  async function createCart(lines) {
    return mutateCart(`mutation CreateCart($input: CartInput!) {
      cartCreate(input: $input) { cart { ${CART_FIELDS} } userErrors { message } }
    }`, { input: { lines } }, 'cartCreate');
  }

  async function removeParentLine(cart, parent) {
    if (!parent.instructions?.canRemove) throw new Error('Shopify does not allow this glove to be removed.');
    const updated = await mutateCart(`mutation RemoveLines($cartId: ID!, $lineIds: [ID!]!) {
      cartLinesRemove(cartId: $cartId, lineIds: $lineIds) { cart { ${CART_FIELDS} } userErrors { message } }
    }`, { cartId: cart.id, lineIds: [parent.remoteLineId] }, 'cartLinesRemove');
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
    let updated = await update([{ id: parent.remoteLineId, quantity: next }]);
    const updatedParent = updated.lines.find(line => line.remoteLineId === parent.remoteLineId);
    if (updatedParent?.quantity !== next) throw new Error('Shopify did not update the glove quantity.');
    if (originalChild) {
      const child = updated.lines.find(line => line.isBreakIn && line.parentLineId === parent.remoteLineId);
      if (!child) throw new Error('Shopify did not preserve the nested Break-in service.');
      if (child.quantity !== next) {
        if (!child.instructions?.canUpdateQuantity) throw new Error('Shopify did not synchronize the Break-in service quantity.');
        updated = await update([{ id: child.remoteLineId, quantity: next }]);
        if (updated.lines.find(line => line.remoteLineId === child.remoteLineId)?.quantity !== next) throw new Error('Shopify did not update the Break-in service quantity.');
      }
    }
    return updated;
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
      const lines = [{ merchandiseId: product.merchandiseId, quantity: 1,
        attributes: [{ key: SERVICE_ATTRIBUTE, value: includeBreakIn ? 'break-in' : 'none' }] }];
      if (includeBreakIn) {
        if (!breakInVariant?.availableForSale) throw new Error('Break-in service is not currently available.');
        lines.push({ merchandiseId: breakInVariant.id, quantity: 1, parent: { merchandiseId: product.merchandiseId } });
      }
      const cartId = storage?.getItem(SHOPIFY_CART_KEY);
      const before = cartId ? await getCart() : emptyCart();
      if (before.incomplete) throw new Error('The Shopify cart is incomplete. Checkout is unavailable until the cart is corrected.');
      const updated = cartId ? await addLines(cartId, lines) : await createCart(lines);
      const configuration = includeBreakIn ? 'break-in' : 'none';
      const configurationQuantity = cart => cart.lines.filter(line => line.productId === productId && !line.isBreakIn &&
        line.serviceConfiguration === configuration).reduce((sum, line) => sum + line.quantity, 0);
      const checks = {
        cartComplete: !updated.incomplete,
        gloveQuantityIncreased: cartLineQuantity(updated, productId, false) === cartLineQuantity(before, productId, false) + 1,
        serviceQuantityExpected: cartLineQuantity(updated, productId, true) ===
          cartLineQuantity(before, productId, true) + Number(includeBreakIn),
        selectedConfigurationIncreased: configurationQuantity(updated) === configurationQuantity(before) + 1
      };
      if (Object.values(checks).some(passed => !passed)) {
        markUnsafe(updated.id);
        throw new Error('Shopify did not preserve the selected glove service configuration. Checkout is unavailable.');
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
      let started = false;
      try {
        await updateLines(cart.id, [{ id: parent.remoteLineId,
          attributes: withServiceAttribute(parent.attributes, 'break-in') }]);
        started = true;
        let current = await getCart();
        const selected = changedParent(cart, current, parent, 'break-in');
        const children = current.lines.filter(line => line.isBreakIn && line.parentLineId === selected.remoteLineId);
        if (children.length > 1 || children[0]?.quantity > selected.quantity) throw new Error('Shopify returned inconsistent Break-in service lines.');
        if (!children.length) {
          await addLines(cart.id, [{ merchandiseId: breakInVariant.id, quantity: selected.quantity,
            parent: { lineId: selected.remoteLineId } }]);
        } else if (children[0].quantity !== selected.quantity) {
          if (!children[0].instructions?.canUpdateQuantity) throw new Error('Shopify cannot synchronize Break-in service quantity.');
          await updateLines(cart.id, [{ id: children[0].remoteLineId, quantity: selected.quantity }]);
        }
        current = await getCart();
        if (current.incomplete || !hasConsistentBreakInLines(current) ||
          cartLineQuantity(current, parent.productId, false) !== cartLineQuantity(cart, parent.productId, false) ||
          cartLineQuantity(current, parent.productId, true) !== cartLineQuantity(cart, parent.productId, true) + parent.quantity) {
          throw new Error('Shopify did not attach the Break-in service to the selected glove.');
        }
        return current;
      } catch (error) {
        if (started) markUnsafe(cart.id);
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
      if (!child.instructions?.canRemove) throw new Error('Shopify does not allow Break-in service to be removed.');
      let started = false;
      try {
        await removeLines(cart.id, [child.remoteLineId]);
        started = true;
        const afterRemoval = await getCart();
        const selected = changedParent(cart, afterRemoval, parent, 'break-in', true);
        if (afterRemoval.lines.some(line => line.isBreakIn && line.parentLineId === selected.remoteLineId)) {
          throw new Error('Shopify did not remove the selected Break-in service.');
        }
        await updateLines(cart.id, [{ id: selected.remoteLineId,
          attributes: withServiceAttribute(selected.attributes, 'none') }]);
        const updated = await getCart();
        if (updated.incomplete || !hasConsistentBreakInLines(updated) ||
          cartLineQuantity(updated, parent.productId, false) !== cartLineQuantity(cart, parent.productId, false) ||
          cartLineQuantity(updated, parent.productId, true) !== cartLineQuantity(cart, parent.productId, true) - child.quantity) {
          throw new Error('Shopify did not remove only the Break-in service.');
        }
        return updated;
      } catch (error) {
        if (started) markUnsafe(cart.id);
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
