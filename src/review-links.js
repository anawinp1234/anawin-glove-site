// Public product-specific links copied from Judge.me Admin > Settings > Request reviews > Links, QR codes and point of sale review collection.
export const JUDGEME_PRODUCT_REVIEW_LINKS = Object.freeze({
  br16: 'https://judge.me/product_reviews/5e5871f8-7401-458b-8b6d-4dc9ff3e37f4/new?id=10332428697848&source=shareable-link',
  ob16: 'https://judge.me/product_reviews/5e5871f8-7401-458b-8b6d-4dc9ff3e37f4/new?id=10334704271608&source=shareable-link',
  cl16: 'https://judge.me/product_reviews/5e5871f8-7401-458b-8b6d-4dc9ff3e37f4/new?id=10334720360696&source=shareable-link'
});

// Judge.me generates these product-specific shareable links in its admin.
// A Shopify product ID cannot be substituted for the UUID in this URL.
export function validProductReviewLink(value, productId = null) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.hostname !== 'judge.me' || url.port
      || !/^\/product_reviews\/[^/]+\/new$/.test(url.pathname)
      || url.searchParams.get('source') !== 'shareable-link'
      || !/^[1-9]\d*$/.test(url.searchParams.get('id') || '')
      || (productId && url.searchParams.get('id') !== productId)) return null;
    return url.toString();
  } catch { return null; }
}

export function productReviewLinks(products = [], configuredLinks = JUDGEME_PRODUCT_REVIEW_LINKS) {
  return Object.fromEntries(['br16', 'ob16', 'cl16'].map(model => {
    const product = products.find(item => item.name.toLowerCase() === model);
    const productId = shopifyProductId(product?.shopifyProductGid);
    return [model, productId ? validProductReviewLink(configuredLinks[model], productId) : null];
  }));
}
import { shopifyProductId } from './judgeme.js';
