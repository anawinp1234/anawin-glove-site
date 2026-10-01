/**
 * Publish only customer reviews approved for storefront use.
 * A future provider can supply this normalized shape to the renderer.
 * @typedef {Object} CustomerReview
 * @property {string} id
 * @property {string} productHandle Lowercase model name, such as br16.
 * @property {number} rating Whole number from 1 to 5.
 * @property {string} customer Approved public display name.
 * @property {boolean} [verified] Confirmed by the review source.
 * @property {string} date ISO date (YYYY-MM-DD).
 * @property {string} [title]
 * @property {string} body
 * @property {{type: 'image'|'video', url: string, alt?: string, poster?: string}[]} [media]
 */

/** @type {CustomerReview[]} */
export const customerReviews = Object.freeze([]);

export function productReviewSummary(source, productHandle) {
  const reviews = source.filter(review => review.productHandle === productHandle
    && Number.isInteger(review.rating) && review.rating >= 1 && review.rating <= 5);
  const count = reviews.length;
  const distribution = Object.fromEntries([5, 4, 3, 2, 1].map(rating => [rating, reviews.filter(review => review.rating === rating).length]));
  const average = count ? reviews.reduce((sum, review) => sum + review.rating, 0) / count : null;
  return { reviews, count, average, distribution, verifiedCount: reviews.filter(review => review.verified === true).length };
}
