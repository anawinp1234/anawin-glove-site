import { cartCustomizationIsComplete } from './catalog.js';

// Verified against ANAWIN's Shopify Admin primary domain and a Storefront API
// Cart.checkoutUrl. Review this policy before changing checkout domains.
const APPROVED_CHECKOUT_HOST = 'ignvv0-zh.myshopify.com';

export function verifiedCheckoutUrl(value) {
  if (typeof value !== 'string' || !/^https:\/\//i.test(value) ||
    /[\u0000-\u0020\u007f\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    // URL normalizes the default HTTPS port to an empty string.
    if (url.protocol !== 'https:' || url.hostname !== APPROVED_CHECKOUT_HOST ||
      url.port !== '' || url.username || url.password ||
      value.slice(8).split(/[/?#]/, 1)[0].includes('@')) return null;
    // Pass Shopify's path and query through unchanged.
    return value;
  } catch {
    return null;
  }
}

export function redirectToVerifiedCheckout(value, navigate) {
  const url = verifiedCheckoutUrl(value);
  if (!url) return false;
  navigate(url);
  return true;
}

function cartSignature(cart) {
  // Shopify can refresh checkoutUrl on a read; compare purchasable state instead.
  return JSON.stringify({
    id: cart.id,
    subtotal: cart.subtotal,
    currencyCode: cart.currencyCode,
    discountCodes: cart.discountCodes,
    discountApplications: cart.discountApplications,
    lines: cart.lines.map(line => ({
      remoteLineId: line.remoteLineId, parentLineId: line.parentLineId,
      merchandiseId: line.merchandiseId, productId: line.productId,
      isBreakIn: line.isBreakIn, quantity: line.quantity,
      attributes: [...(line.attributes || [])].sort((a, b) => a.key.localeCompare(b.key)),
      unitPrice: line.unitPrice, lineSubtotal: line.lineSubtotal,
      lineTotal: line.lineTotal, allDiscountAllocations: line.allDiscountAllocations
    })).sort((a, b) => String(a.remoteLineId).localeCompare(String(b.remoteLineId)))
  });
}

export function isCartStorageKey(key) {
  return key === null || ['anawin-shopify-cart-id', 'anawin-shopify-unsafe-cart-id',
    'anawin-shopify-pending-mutation', 'anawin-shopify-cart-revision'].includes(key);
}

export function checkoutCartIsComplete(cart) {
  if (!cart?.id || !cart.checkoutUrl || cart.incomplete || !cart.lines?.length) return false;
  if (!cartCustomizationIsComplete(cart.lines)) return false;
  return cart.lines.every(line => {
    if (!line.merchandiseId || !Number.isInteger(line.quantity) || line.quantity < 1) return false;
    if (!line.isBreakIn) return true;
    const parent = cart.lines.find(candidate => !candidate.isBreakIn && candidate.remoteLineId === line.parentLineId);
    return parent?.productId === line.productId && parent.quantity === line.quantity;
  });
}

export function createCheckoutVerifier({ getCart, readSafety }) {
  let pending = false;
  return async (displayedCart, { requireReview = false } = {}) => {
    if (pending) return { status: 'busy' };
    pending = true;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const before = readSafety();
        if (!before.id) return { status: 'blocked', message: 'Your cart is unavailable. Check your cart and try again.' };
        const current = await getCart();
        const after = readSafety();
        if (before.id !== after.id || before.revision !== after.revision || current.id !== after.id) continue;
        if (after.unsafeId === after.id || after.pendingCartId === after.id || current.incomplete) {
          return { status: 'blocked', cart: current,
            message: 'A cart change is still being checked. Check your cart before checkout.' };
        }
        if (!checkoutCartIsComplete(current)) {
          return { status: 'blocked', cart: current,
            message: 'Shopify could not verify your cart. Check your cart before checkout.' };
        }
        if (requireReview || cartSignature(current) !== cartSignature(displayedCart)) {
          return { status: 'review', cart: current,
            message: 'Your cart changed. Review the items, then choose Checkout again.' };
        }
        // Recheck shared state immediately before handing the fresh Shopify URL to the caller.
        const final = readSafety();
        if (final.id !== current.id || final.revision !== after.revision ||
          final.unsafeId === final.id || final.pendingCartId === final.id) continue;
        return { status: 'ready', cart: current, checkoutUrl: current.checkoutUrl, revision: final.revision };
      }
      return { status: 'blocked', message: 'Your cart changed in another tab. Check your cart before checkout.' };
    } catch (error) {
      return { status: 'blocked', message: error?.code === 'cart-changed'
        ? 'Your cart changed in another tab. Check your cart before checkout.'
        : 'Couldn’t check your cart with Shopify. Check your connection and try again.' };
    } finally {
      pending = false;
    }
  };
}
