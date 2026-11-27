// Strict, multi-cart Storefront API mock for the purchase regression suite.
//
// Unlike test-support/shopify-fixture.js (which the unit tests use and which models one cart plus one
// recovery cart), every cart here is its own record with its own lines, discount codes and attributes,
// and every cart ever created stays in a registry, so a cart the storefront lost track of is still
// visible to the suite. Nothing is inferred: an operation, cart or line the mock does not model is
// either a Shopify-style userError (for states real Shopify reports that way) or a thrown error that
// the server records as unmatched. Child (Break-In service) quantities never follow their parent:
// the storefront must keep them in step itself.
import { fullSizeProducts } from '../../src/catalog.js';
import { FULL_SIZE_SERVICE_PRODUCT, FULL_SIZE_SERVICE_VARIANT } from '../../test-support/commerce-profiles.js';

export const FULL_SIZE_SERVICE_HANDLE = 'full-size-glove-break-in-service';
const launchMetafields = Object.fromEntries(fullSizeProducts.map(product => [product.name.toLowerCase(), product.preorder.shipEstimate]));
const HANDED = ['mi26', 'bl50', 'or17'];
const PRICES = { mi26: '295.00', bl50: '295.00', or17: '295.00', cm24: '295.00', br16: '155.00', ob16: '155.00', cl16: '155.00',
  'break-in': '20.00', [FULL_SIZE_SERVICE_HANDLE]: '75.00' };
const VARIANTS = { mi26: 'gid://variant/mi26-right', bl50: 'gid://variant/bl50-right', or17: 'gid://variant/or17-right', cm24: 'gid://variant/cm24-right',
  br16: 'gid://variant/br16', ob16: 'gid://variant/ob16', cl16: 'gid://variant/cl16', 'break-in': 'gid://variant/service',
  [FULL_SIZE_SERVICE_HANDLE]: FULL_SIZE_SERVICE_VARIANT };
const handleOf = merchandiseId => Object.keys(VARIANTS).find(handle => VARIANTS[handle] === merchandiseId ||
  (HANDED.includes(handle) && VARIANTS[handle].replace('-right', '-left') === merchandiseId));
// Fields the storefront's cart selection must request; a missing one means the mock would answer a
// query the real API would answer differently.
const CART_SHAPE = [/parentRelationship/, /discountCodes \{ code applicable \}/, /discountApplications \{/,
  /subtotalAmount \{ amount currencyCode \} totalAmount \{ amount currencyCode \}/, /discountAllocations\(lineLevelOnly: false\)/,
  /attributes \{ key value \}/, /canUpdateQuantity/];
const OPERATIONS = new Set(['ProductByHandle', 'Cart', 'CreateCart', 'AddLines', 'UpdateLines', 'RemoveLines', 'UpdateDiscountCodes', 'UpdateCartAttributes']);
export const operationOf = query => /^\s*(query|mutation)\s+(\w+)/.exec(query || '')?.[2] || 'unknown';
export const isMutation = query => /^\s*mutation\b/.test(query || '');

export class UnmodelledRequest extends Error {}

const productIdFor = handle => handle === FULL_SIZE_SERVICE_HANDLE ? FULL_SIZE_SERVICE_PRODUCT : `gid://product/${handle}`;

export function createStorefrontMock({ checkoutHost, acceptedCodes = ['SYNTH10', 'SYNTH5'], metafields = launchMetafields,
  fullSizeServiceAvailable = true, rekeyOnAdd = false, rekeyOnQuantityUpdate = false, rekeyOnAttributeUpdate = false, codeCase = 'as-sent' } = {}) {
  const carts = new Map();
  // Every cartCreate, in commit order, with the lines it was created with.
  const created = [];
  let nextCart = 1;
  let nextLine = 1;
  const meta = { ...metafields };
  const accepted = code => acceptedCodes.includes(String(code).toUpperCase());
  // The committed effect of the last executed mutation (1L): every line whose existence or quantity
  // changed, with its identity before and after (rekeys included), and the cart's lines afterwards.
  let effects = null;
  let renamed = new Map();

  const makeLine = (merchandiseId, quantity, attributes = [], parent = null) => {
    const handle = handleOf(merchandiseId);
    if (!handle) throw new UnmodelledRequest(`Unknown merchandise ${merchandiseId}`);
    return { id: `gid://shopify/CartLine/${nextLine++}`, quantity, attributes: structuredClone(attributes || []),
      instructions: { canRemove: true, canUpdateQuantity: true },
      parentRelationship: parent ? { parent: { id: parent.id, merchandise: structuredClone(parent.merchandise) } } : null,
      merchandise: { id: merchandiseId, product: { handle, id: productIdFor(handle) },
        selectedOptions: HANDED.includes(handle) ? [{ name: 'Throwing Hand', value: merchandiseId.endsWith('-left') ? 'Left' : 'Right' }] : [{ name: 'Title', value: 'Default Title' }] } };
  };
  const signature = attributes => JSON.stringify([...attributes].sort((a, b) => a.key.localeCompare(b.key) || a.value.localeCompare(b.value)));
  const childrenOf = (cart, parent) => cart.lines.filter(line => line.parentRelationship?.parent.id === parent.id);
  const userError = (cart, message) => ({ userErrors: [{ message }], cart: cart ? snapshot(cart) : null, warnings: [] });

  // Shopify merges a top-level line into an identical one (same variant and attributes).
  function addInputs(cart, inputs) {
    if (!Array.isArray(inputs) || !inputs.length) throw new UnmodelledRequest('lines must be a non-empty list');
    for (const input of inputs) {
      if (typeof input?.merchandiseId !== 'string') throw new UnmodelledRequest('every line needs a merchandiseId');
      if (!Number.isInteger(input.quantity) || input.quantity < 1) throw new UnmodelledRequest(`Invalid add quantity ${input.quantity}`);
      if (input.parent) {
        const parent = cart.lines.find(line => !line.parentRelationship && (input.parent.lineId ? line.id === input.parent.lineId
          : line.merchandise.id === input.parent.merchandiseId && line.attributes.some(item => item.key === '_anawin_service' && item.value === 'break-in')));
        if (!parent) return 'The parent line for the nested line was not found.';
        const existing = childrenOf(cart, parent).find(line => line.merchandise.id === input.merchandiseId);
        if (existing) existing.quantity += input.quantity;
        else cart.lines.push(makeLine(input.merchandiseId, input.quantity, input.attributes, parent));
        continue;
      }
      const existing = cart.lines.find(line => !line.parentRelationship && line.merchandise.id === input.merchandiseId &&
        signature(line.attributes) === signature(input.attributes || []));
      if (existing) existing.quantity += input.quantity;
      else cart.lines.push(makeLine(input.merchandiseId, input.quantity, input.attributes));
    }
    return null;
  }
  const rename = (from, to) => { const origin = [...renamed].find(([, current]) => current === from)?.[0] ?? from; renamed.set(origin, to); };
  function rekey(cart) {
    const ids = new Map();
    for (const line of cart.lines.filter(line => !line.parentRelationship)) { ids.set(line.id, `gid://shopify/CartLine/${nextLine++}`); rename(line.id, ids.get(line.id)); line.id = ids.get(line.id); }
    for (const line of cart.lines.filter(line => line.parentRelationship)) {
      const next = `gid://shopify/CartLine/${nextLine++}`;
      rename(line.id, next); line.id = next;
      line.parentRelationship.parent.id = ids.get(line.parentRelationship.parent.id);
    }
  }
  function mergeEquivalentParents(cart) {
    for (const parent of cart.lines.filter(line => !line.parentRelationship)) {
      if (!cart.lines.includes(parent)) continue;
      const twin = cart.lines.find(line => line !== parent && !line.parentRelationship && line.merchandise.id === parent.merchandise.id &&
        signature(line.attributes) === signature(parent.attributes));
      if (!twin) continue;
      twin.quantity += parent.quantity;
      for (const child of childrenOf(cart, parent)) {
        const twinChild = childrenOf(cart, twin).find(line => line.merchandise.id === child.merchandise.id);
        if (twinChild) { twinChild.quantity += child.quantity; cart.lines.splice(cart.lines.indexOf(child), 1); }
        else child.parentRelationship.parent.id = twin.id;
      }
      cart.lines.splice(cart.lines.indexOf(parent), 1);
    }
  }
  const removeWithChildren = (cart, ids) => {
    cart.lines = cart.lines.filter(line => !ids.includes(line.id) && !ids.includes(line.parentRelationship?.parent.id));
  };

  function snapshot(cart) {
    const applied = cart.discountCodes.filter(accepted);
    const factor = 0.9 ** applied.length;
    const unit = line => PRICES[line.merchandise.product.handle];
    const total = line => (line.quantity * Number(unit(line)) * factor).toFixed(2);
    return { id: cart.id, checkoutUrl: `https://${checkoutHost}/checkouts/${cart.number}`, attributes: structuredClone(cart.attributes),
      discountCodes: cart.discountCodes.map(code => ({ code, applicable: accepted(code) })),
      discountApplications: applied.map(code => ({ __typename: 'CartCodeDiscountApplication', code, targetType: 'LINE_ITEM', value: { __typename: 'PricingPercentageValue', percentage: 10 } })),
      cost: { subtotalAmount: { amount: cart.lines.reduce((sum, line) => sum + Number(total(line)), 0).toFixed(2), currencyCode: 'USD' } },
      lines: { pageInfo: { hasNextPage: false }, nodes: structuredClone(cart.lines).map(line => ({ ...line, allDiscountAllocations: [],
        cost: { amountPerQuantity: { amount: unit(line), currencyCode: 'USD' },
          subtotalAmount: { amount: (line.quantity * Number(unit(line))).toFixed(2), currencyCode: 'USD' },
          totalAmount: { amount: total(line), currencyCode: 'USD' } } })) } };
  }

  function product(handle) {
    if (!VARIANTS[handle]) return null;
    if (handle === FULL_SIZE_SERVICE_HANDLE && !fullSizeServiceAvailable) return null;
    const amount = PRICES[handle];
    const variants = [{ id: VARIANTS[handle], availableForSale: true, price: { amount, currencyCode: 'USD' },
      selectedOptions: HANDED.includes(handle) ? [{ name: 'Throwing Hand', value: 'Right' }] : [{ name: 'Title', value: 'Default Title' }] }];
    if (HANDED.includes(handle)) variants.push({ id: VARIANTS[handle].replace('-right', '-left'), availableForSale: true,
      price: { amount, currencyCode: 'USD' }, selectedOptions: [{ name: 'Throwing Hand', value: 'Left' }] });
    return { id: productIdFor(handle), title: handle.toUpperCase(), handle,
      ...(Object.hasOwn(meta, handle) ? { preorderShipEstimate: meta[handle] === null ? null : { value: meta[handle] } } : {}),
      variants: { nodes: variants } };
  }

  function createCart({ lines = [], discountCodes = [], attributes = [] } = {}) {
    const number = nextCart++;
    const cart = { id: `gid://shopify/Cart/${number}?key=k${number}`, number, lines: [], discountCodes: [...discountCodes], attributes: structuredClone(attributes) };
    const error = addInputs(cart, lines);
    if (error) { nextCart--; return { error }; }
    carts.set(cart.id, cart);
    created.push({ cartId: cart.id, lines: summarize(cart).lines });
    return { cart };
  }

  // Executes one GraphQL request. Returns the response `data`; throws UnmodelledRequest otherwise.
  // `dryRun` returns the response a mutation would give but leaves every cart exactly as it was (1M:
  // the server forges a response from it without anything being committed).
  function execute(query, variables = {}, { dryRun = false } = {}) {
    // Effects describe only the request being executed; a query or CreateCart never inherits the last ones.
    effects = null; renamed = new Map();
    const operation = operationOf(query);
    if (!OPERATIONS.has(operation)) throw new UnmodelledRequest(`Unmodelled operation ${operation}`);
    if (operation === 'ProductByHandle') return { product: product(variables.handle) };
    for (const pattern of CART_SHAPE) if (!pattern.test(query)) throw new UnmodelledRequest(`Cart selection is missing ${pattern}`);
    if (operation === 'Cart') { const cart = carts.get(variables.id); return { cart: cart ? snapshot(cart) : null }; }
    if (operation === 'CreateCart') {
      if (!variables.input || typeof variables.input !== 'object') throw new UnmodelledRequest('CreateCart needs an input');
      if (variables.input.discountCodes !== undefined && !Array.isArray(variables.input.discountCodes)) throw new UnmodelledRequest('CreateCart discountCodes must be a list');
      const result = createCart(variables.input);
      return { cartCreate: result.error ? userError(null, result.error) : { userErrors: [], warnings: [], cart: snapshot(result.cart) } };
    }
    const field = { AddLines: 'cartLinesAdd', UpdateLines: 'cartLinesUpdate', RemoveLines: 'cartLinesRemove',
      UpdateDiscountCodes: 'cartDiscountCodesUpdate', UpdateCartAttributes: 'cartAttributesUpdate' }[operation];
    const cart = carts.get(variables.cartId);
    if (typeof variables.cartId !== 'string') throw new UnmodelledRequest(`${operation} needs a cartId`);
    if (!cart) return { [field]: userError(null, 'The specified cart does not exist.') };
    // All or nothing: a mutation that fails part-way leaves the cart exactly as it was. Partial commits
    // exist only where a scenario asks for them explicitly (failNext phase 'after', holds).
    const saved = structuredClone({ lines: cart.lines, discountCodes: cart.discountCodes, attributes: cart.attributes, nextLine });
    try {
      const data = mutate(operation, field, cart, variables);
      if (dryRun) { Object.assign(cart, { lines: saved.lines, discountCodes: saved.discountCodes, attributes: saved.attributes }); nextLine = saved.nextLine; return data; }
      if (!data[field]?.userErrors?.length) effects = effectsOf(saved.lines, cart.lines);
      return data;
    }
    catch (error) { Object.assign(cart, { lines: saved.lines, discountCodes: saved.discountCodes, attributes: saved.attributes }); nextLine = saved.nextLine; throw error; }
  }

  function mutate(operation, field, cart, variables) {
    if (operation === 'AddLines') {
      const before = structuredClone(cart.lines);
      const error = addInputs(cart, variables.lines);
      if (error) { cart.lines = before; return { [field]: userError(cart, error) }; }
      if (rekeyOnAdd) rekey(cart);
    } else if (operation === 'UpdateLines') {
      const updates = variables.lines;
      if (!Array.isArray(updates) || !updates.length || updates.some(update => typeof update?.id !== 'string')) throw new UnmodelledRequest('UpdateLines needs a non-empty list of line updates');
      const missing = updates.find(update => !cart.lines.some(line => line.id === update.id));
      if (missing) return { [field]: userError(cart, `The merchandise line ${missing.id} was not found.`) };
      for (const update of updates) {
        const line = cart.lines.find(item => item.id === update.id);
        if (update.quantity !== undefined) {
          if (!Number.isInteger(update.quantity) || update.quantity < 0) throw new UnmodelledRequest(`Invalid quantity ${update.quantity}`);
          if (update.quantity === 0) { removeWithChildren(cart, [line.id]); continue; }
          line.quantity = update.quantity;
        }
        if (update.attributes) {
          line.attributes = structuredClone(update.attributes);
          if (rekeyOnAttributeUpdate) {
            const old = line.id;
            line.id = `gid://shopify/CartLine/${nextLine++}`;
            rename(old, line.id);
            for (const child of cart.lines) if (child.parentRelationship?.parent.id === old) child.parentRelationship.parent.id = line.id;
          }
          mergeEquivalentParents(cart);
        }
      }
      if (rekeyOnQuantityUpdate && updates.some(update => update.quantity !== undefined)) rekey(cart);
    } else if (operation === 'RemoveLines') {
      if (!Array.isArray(variables.lineIds) || !variables.lineIds.length) throw new UnmodelledRequest('RemoveLines needs a non-empty lineIds list');
      const missing = variables.lineIds.find(id => !cart.lines.some(line => line.id === id));
      if (missing) return { [field]: userError(cart, `The merchandise line ${missing} was not found.`) };
      removeWithChildren(cart, variables.lineIds);
    } else if (operation === 'UpdateDiscountCodes') {
      if (!Array.isArray(variables.discountCodes)) throw new UnmodelledRequest('discountCodes must be a list');
      // codeCase 'upper' stands in for Shopify returning its own spelling of a code the shopper typed.
      cart.discountCodes = variables.discountCodes.map(code => codeCase === 'upper' ? String(code).toUpperCase() : code);
    } else if (operation === 'UpdateCartAttributes') {
      if (!Array.isArray(variables.attributes)) throw new UnmodelledRequest('attributes must be a list');
      cart.attributes = structuredClone(variables.attributes);
    }
    return { [field]: { userErrors: [], warnings: [], cart: snapshot(cart) } };
  }

  // What a committed mutation actually did, from the cart before and after it executed (1L, 1M). Each
  // line is viewed by identity, merchandise, parent, quantity and attributes, so an attribute-only change
  // (a Break-In choice, a wear preference) is a committed effect like a quantity change. Each effect names
  // the change ('added', 'removed', 'changed', 'rekeyed'), the line's ID before and after, and its full
  // view before and after; the cart's full lines before and after are returned beside them.
  function effectsOf(beforeLines, afterLines) {
    const view = line => ({ id: line.id, merchandiseId: line.merchandise.id, parentId: line.parentRelationship?.parent.id || null, quantity: line.quantity,
      attributes: structuredClone(line.attributes || []).sort((a, b) => a.key.localeCompare(b.key) || String(a.value).localeCompare(String(b.value))) });
    const before = beforeLines.map(view), after = afterLines.map(view);
    const current = id => renamed.get(id) ?? id;
    const changed = [];
    for (const old of before) {
      const id = current(old.id);
      const now = after.find(line => line.id === id);
      if (!now) { changed.push({ change: 'removed', id: old.id, previousId: old.id, before: old, after: null }); continue; }
      const moved = { ...old, id, parentId: old.parentId && current(old.parentId) };
      if (id !== old.id) changed.push({ change: 'rekeyed', id, previousId: old.id, before: old, after: now });
      else if (JSON.stringify(moved) !== JSON.stringify(now)) changed.push({ change: 'changed', id, previousId: old.id, before: old, after: now });
    }
    const known = new Set(before.map(line => current(line.id)));
    for (const line of after.filter(item => !known.has(item.id))) changed.push({ change: 'added', id: line.id, previousId: null, before: null, after: line });
    return { cartBefore: before, lines: changed, cartAfter: after };
  }

  // A compact, comparable view of one cart for assertions.
  function summarize(cart) {
    return { id: cart.id, discountCodes: [...cart.discountCodes], discountApplicability: cart.discountCodes.map(code => ({ code, applicable: accepted(code) })), attributes: structuredClone(cart.attributes),
      lines: cart.lines.map(line => ({ id: line.id, handle: line.merchandise.product.handle, merchandiseId: line.merchandise.id,
        quantity: line.quantity, parentId: line.parentRelationship?.parent.id || null, attributes: structuredClone(line.attributes) })) };
  }

  return {
    execute,
    lastEffects: () => structuredClone(effects),
    cart: id => { const cart = carts.get(id); return cart ? summarize(cart) : null; },
    carts: () => [...carts.values()].map(summarize),
    created: () => structuredClone(created),
    expire: id => carts.delete(id),
    setMetafield: (handle, value) => { meta[handle] = value; },
    // A cart left by an earlier storefront version: a serviced glove whose saved choices are gone from both lines.
    legacyServiceCart() {
      const { cart } = createCart({ lines: [{ merchandiseId: VARIANTS.br16, quantity: 1, attributes: [{ key: '_anawin_service', value: 'break-in' }] }] });
      const parent = cart.lines[0];
      cart.lines.push(makeLine(VARIANTS['break-in'], 1, [], parent));
      Object.assign(created.at(-1), { seeded: true, lines: summarize(cart).lines });
      return cart.id;
    }
  };
}
