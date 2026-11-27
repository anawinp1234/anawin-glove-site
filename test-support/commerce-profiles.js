import {
  checkoutCartIsComplete as isComplete,
  createCheckoutVerifier as createVerifier,
  redirectToVerifiedCheckout as redirect,
  verifiedCheckoutUrl as verifiedUrl
} from '../src/checkout-safety.js';
import { cartCustomizationIsComplete as customizationIsComplete } from '../src/catalog.js';

// The fixture's synthetic API endpoint and simulated checkout origin are independent.
export const FULL_SIZE_SERVICE_PRODUCT = 'gid://shopify/Product/15498355474680';
export const FULL_SIZE_SERVICE_VARIANT = 'gid://shopify/ProductVariant/68062398808312';
export const fixtureProfile = Object.freeze({
  storeDomain: 'store.myshopify.com',
  checkoutHost: 'ignvv0-zh.myshopify.com',
  fullSizeService: Object.freeze({ productId: FULL_SIZE_SERVICE_PRODUCT, variantId: FULL_SIZE_SERVICE_VARIANT })
});

export const checkoutCartIsComplete = cart => isComplete(cart, fixtureProfile);
export const cartCustomizationIsComplete = lines => customizationIsComplete(lines, fixtureProfile.fullSizeService);
export const createCheckoutVerifier = options => createVerifier({ ...options, profile: fixtureProfile });
export const redirectToVerifiedCheckout = (url, navigate) => redirect(url, navigate, fixtureProfile.checkoutHost);
export const verifiedCheckoutUrl = url => verifiedUrl(url, fixtureProfile.checkoutHost);
export { isCartStorageKey } from '../src/checkout-safety.js';
