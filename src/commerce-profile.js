const shopifyHostname = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/;
const productGid = /^gid:\/\/shopify\/Product\/[1-9][0-9]*$/;
const variantGid = /^gid:\/\/shopify\/ProductVariant\/[1-9][0-9]*$/;

export function isShopifyHostname(value) {
  return typeof value === 'string' && shopifyHostname.test(value);
}

function hasExactKeys(value, keys) {
  return value && Object.getPrototypeOf(value) === Object.prototype &&
    Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

export function isFullSizeServiceIdentity(service) {
  return hasExactKeys(service, ['productId', 'variantId']) && typeof service.productId === 'string' && productGid.test(service.productId) &&
    typeof service.variantId === 'string' && variantGid.test(service.variantId);
}

export function isCommerceProfile(profile) {
  return hasExactKeys(profile, ['storeDomain', 'checkoutHost', 'fullSizeService']) && isShopifyHostname(profile.storeDomain) && isShopifyHostname(profile.checkoutHost) &&
    isFullSizeServiceIdentity(profile.fullSizeService);
}

export function selectCommerceProfile(domain, profiles) {
  if (!isShopifyHostname(domain)) throw new Error('Invalid Shopify store domain.');
  if (!Array.isArray(profiles) || ![...profiles].every(isCommerceProfile)) throw new Error('Invalid Shopify commerce profile configuration.');
  const matches = profiles.filter(profile => profile.storeDomain === domain);
  if (matches.length !== 1) throw new Error('Shopify store domain must match exactly one commerce profile.');
  const { storeDomain, checkoutHost, fullSizeService: { productId, variantId } } = matches[0];
  return Object.freeze({ storeDomain, checkoutHost, fullSizeService: Object.freeze({ productId, variantId }) });
}
