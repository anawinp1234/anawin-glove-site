import { purchasePrice } from './catalog.js';
import { announcement as defaultAnnouncement } from './announcement.js';
import { communityItems } from './community.js';
import { customerReviews, productReviewSummary } from './reviews.js';
import { shopifyProductId } from './judgeme.js';
import { validProductReviewLink } from './review-links.js';
import { warrantyParagraphs, careIntro, careSections, breakInIntro, breakInSections } from './policy-content.js';
import { normalizePath, productPath, routeMetadata } from './seo.js';

export const money = (value, currency = 'USD') => new Intl.NumberFormat('en-US', {
  style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 2
}).format(value);
export const escapeHtml = value => String(value).replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
const policyParagraphs = paragraphs => paragraphs.map(paragraph => `<p>${escapeHtml(paragraph)}</p>`).join('');
const policyList = items => `<ul>${items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
const careItem = item => {
  const separator = item.indexOf('. ');
  return separator > 0 ? `<li><strong>${escapeHtml(item.slice(0, separator + 1))}</strong>${escapeHtml(item.slice(separator + 1))}</li>` : `<li>${escapeHtml(item)}</li>`;
};
const carePageContent = () => careSections.map(section => `<section><h2>${escapeHtml(section.heading)}</h2>${section.intro ? `<p>${escapeHtml(section.intro)}</p>` : ''}${section.paragraphs ? policyParagraphs(section.paragraphs) : `<ul>${section.items.map(careItem).join('')}</ul>`}</section>`).join('');
const breakInPageContent = () => breakInSections.map(section => `<section><h2>${escapeHtml(section.heading)}</h2>${section.paragraphs ? section.paragraphs.map((paragraph, index) => `<p>${section.emphasis === index ? `<strong>${escapeHtml(paragraph)}</strong>` : escapeHtml(paragraph)}</p>`).join('') : ''}${section.items ? policyList(section.items) : ''}${section.after ? policyParagraphs(section.after) : ''}</section>`).join('');
export const arrow = () => `<svg class="link-arrow" viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M2 10 10 2M4 2h6v6" /></svg>`;
export function newsletterFormMarkup(prefix) {
  return `<form class="newsletter-form" data-newsletter-form novalidate><div class="newsletter-fields"><label class="visually-hidden" for="${prefix}-email">Email address</label><div class="newsletter-controls"><input id="${prefix}-email" name="email" type="email" inputmode="email" autocomplete="email" placeholder="Email address" required aria-describedby="${prefix}-message"><button type="submit">SIGN UP</button></div>
    <label class="newsletter-consent"><input id="${prefix}-consent" name="consent" type="checkbox" required aria-describedby="${prefix}-message"><span>I agree to receive marketing emails from ANAWIN. I can unsubscribe at any time.</span></label></div><div class="newsletter-success" hidden><h3 id="${prefix}-success-heading" tabindex="-1">THANK YOU FOR JOINING OUR COMMUNITY</h3><p id="${prefix}-success-copy">You’re signed up. Keep an eye on your inbox.</p></div><p id="${prefix}-message" class="newsletter-message" aria-live="polite"></p></form>`;
}
export function newsletterPopupMarkup() {
  return `<dialog class="newsletter-dialog" aria-labelledby="newsletter-popup-heading" aria-describedby="newsletter-popup-copy"><div class="newsletter-dialog-inner"><div class="newsletter-dialog-top"><p class="eyebrow">ANAWIN / Email</p><button type="button" class="newsletter-dialog-close" data-newsletter-close aria-label="Close newsletter signup">CLOSE</button></div><h2 id="newsletter-popup-heading">JOIN OUR<br>COMMUNITY</h2><p id="newsletter-popup-copy" class="newsletter-dialog-copy">Be the first to hear about new gloves, releases, and what’s next.</p>${newsletterFormMarkup('newsletter-popup')}</div></dialog>`;
}
const cardImageSizes = '(max-width: 760px) calc(100vw - 32px), calc((100vw - 80px) / 3)';
const galleryImageSizes = '(max-width: 760px) 90vw, 30vw';
const colorwaySwatches = product => product.id === 'brown'
  ? ['#6f6843', ...(product.swatches || [])]
  : (product.swatches || []);

function productImage(src, alt, sizes, loading, card = false) {
  const name = src.split('/').pop().replace(/\.PNG$/, '');
  const fullWidth = name === 'black1' ? 1045 : 1254;
  const fullHeight = name === 'black1' ? 1044 : 1254;
  const optimized = width => `/images/optimized/${name}-${width}.webp`;
  const srcset = [480, ...(card ? [768] : []), 960, fullWidth].map(width => `${optimized(width)} ${width}w`).join(', ');
  return `<picture><source type="image/webp" srcset="${srcset}" sizes="${sizes}"><img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" width="${fullWidth}" height="${fullHeight}" loading="${loading}" /></picture>`;
}

function responsivePhoto(src, name, widths, sizes, alt, width, height, loading, className = '', fetchPriority = '') {
  const srcset = widths.map(candidate => `/images/optimized/${name}-${candidate}.webp ${candidate}w`).join(', ');
  return `<picture><source type="image/webp" srcset="${srcset}" sizes="${sizes}"><img class="${className}" src="${src}" alt="${escapeHtml(alt)}" width="${width}" height="${height}" loading="${loading}"${fetchPriority ? ` fetchpriority="${fetchPriority}"` : ''} /></picture>`;
}

function wordmark(sizes, loading = 'eager') {
  const widths = [160, 320, 480, 720, 960, 1193];
  const srcset = widths.map(width => `/images/optimized/anawin-wordmark-${width}.webp ${width}w`).join(', ');
  return `<picture><source type="image/webp" srcset="${srcset}" sizes="${sizes}"><img src="/images/anawin-wordmark.png" alt="ANAWIN" width="1193" height="141" loading="${loading}" /></picture>`;
}
export function createStorefrontRenderer({ products, breakInService, commerceLoading = false, commerceError = '', cartCount = () => 0, announcement = defaultAnnouncement, reviews = customerReviews, reviewData = null }) {
const reviewSummary = product => reviewData?.[product.name.toLowerCase()] || productReviewSummary(reviews, product.name.toLowerCase());
function headerInfoMenus() {
  return `<details class="header-info"><summary>Help</summary><div class="header-info-links"><a href="/shipping" data-link>Shipping</a><a href="/returns" data-link>Returns &amp; Refunds</a><a href="/warranty" data-link>Warranty</a></div></details>
    <details class="header-info"><summary>Care</summary><div class="header-info-links"><a href="/care" data-link>Glove Care</a><a href="/break-in" data-link>Break-in Guide</a></div></details>`;
}

function header() {
  const announcementBar = announcement.enabled === true
    ? `<aside class="announcement-bar" aria-label="Store announcement"><p>${escapeHtml(announcement.message)}</p></aside>`
    : '';
  return `${announcementBar}<header class="site-header">
    <a class="wordmark" href="/" data-link aria-label="ANAWIN home">${wordmark('(max-width: 760px) 112px, 132px')}</a>
    <nav class="desktop-nav" aria-label="Main navigation"><a href="/shop" data-link>Shop</a><a href="/about" data-link>About</a>${headerInfoMenus()}</nav>
    <button class="mobile-menu-toggle" type="button" aria-expanded="false" aria-controls="mobile-menu" aria-label="Open menu">Menu</button>
    <nav class="mobile-nav" id="mobile-menu" aria-label="Mobile navigation" hidden><a href="/shop" data-link>Shop</a><a href="/about" data-link>About</a>${headerInfoMenus()}<button type="button" data-cart>Cart</button></nav>
    <button class="cart-trigger" data-cart aria-label="Open cart with ${cartCount()} items">Cart <span class="cart-count">(${cartCount()})</span></button>
  </header>`;
}

function commerceNotice() {
  if (commerceLoading) return `<div class="commerce-notice" role="status">Connecting to product inventory…</div>`;
  if (commerceError) return `<div class="commerce-notice commerce-notice-error" role="alert">${escapeHtml(commerceError)}</div>`;
  return '';
}

function footer() {
  return `<footer><div class="footer-mark"><a href="/" data-link aria-label="ANAWIN home" style="display:block">${wordmark('calc(100vw - 56px)', 'lazy')}</a></div><div class="footer-grid">
    <div><p class="eyebrow">Navigation</p><a href="/shop" data-link>Shop</a><a href="/about" data-link>About</a></div>
    <div><p class="eyebrow">Connect</p><a href="mailto:support@anawinofficial.com">support@anawinofficial.com</a><a href="mailto:ray@anawinofficial.com">ray@anawinofficial.com</a><a href="mailto:anawin@anawinofficial.com">anawin@anawinofficial.com</a><a href="https://www.instagram.com/anawinofficial" target="_blank" rel="noreferrer">Instagram — @anawinofficial</a><a href="https://www.tiktok.com/@anawinofficial" target="_blank" rel="noreferrer">TikTok — @anawinofficial</a></div>
    <div><p class="eyebrow">Information</p><a href="/shipping" data-link>Shipping Policy</a><a href="/returns" data-link>Returns &amp; Refunds Policy</a><a href="/warranty" data-link>Warranty</a><a href="/care" data-link>Glove Care</a><a href="/break-in" data-link>Breaking In Your Glove</a><a href="https://checkout.shopify.com/84529185016/policies/46558740728.html?locale=en" target="_blank" rel="noreferrer">Privacy Policy</a><a href="https://checkout.shopify.com/84529185016/policies/47782691064.html?locale=en" target="_blank" rel="noreferrer">Terms of Service</a></div>
  </div><div class="legal"><span>© ${new Date().getFullYear()} ANAWIN</span><span>Baseball gloves</span></div></footer>`;
}

function productCard(product, index, eagerFirst) {
  const availability = product.available ? '' : '<span class="sold-out">Sold out</span>';
  return `<article class="product-card reveal" data-product="${escapeHtml(product.id)}" style="--delay:${index * 80}ms;--card-accent:${escapeHtml(product.accentColor || '#111111')}">
    <a href="${productPath(product)}" data-link class="product-image" aria-label="View ${escapeHtml(product.name)}: ${escapeHtml(product.tone)} glove">${productImage(product.images[0], `${product.tone} ANAWIN glove`, cardImageSizes, eagerFirst && index === 0 ? 'eager' : 'lazy', true)}<span class="view-product">View ${arrow()}</span></a>
    <div class="product-meta"><div><h3><a href="${productPath(product)}" data-link>${escapeHtml(product.name)}</a></h3><p>${escapeHtml(product.tone)}</p><div data-review-slot="${escapeHtml(product.name.toLowerCase())}"${reviewSummary(product).status === 'loading' ? ' class="review-slot-loading"' : ''}>${productCardRatingMarkup(product)}</div>${availability}</div><strong>${money(product.price, product.currencyCode)}</strong></div>
  </article>`;
}

const productGrid = (eagerFirst = false) => `<div class="product-grid">${products.map((product, index) => productCard(product, index, eagerFirst)).join('')}</div>`;

function ratingStars(rating) {
  const filled = Math.round(rating);
  return `<span class="rating-stars" role="img" aria-label="${rating.toFixed(1)} out of 5 stars"><span aria-hidden="true">${'★'.repeat(filled)}</span><span class="rating-stars-empty" aria-hidden="true">${'★'.repeat(5 - filled)}</span></span>`;
}

function productCardRatingMarkup(product) {
  const summary = reviewSummary(product);
  if (!summary.count || !Number.isFinite(summary.average)) return '';
  return `<p class="product-card-rating" aria-label="${summary.average.toFixed(1)} out of 5 stars, based on ${summary.count} ${summary.count === 1 ? 'review' : 'reviews'}">${ratingStars(summary.average)} <span>${summary.average.toFixed(1)} (${summary.count})</span></p>`;
}

function reviewMedia(media = []) {
  const safeUrl = url => typeof url === 'string' && (/^https:\/\//.test(url) || /^\/(?!\/)/.test(url));
  const items = media.filter(item => safeUrl(item.url)).map(item => item.type === 'image'
    ? `<img src="${escapeHtml(item.url)}" alt="${escapeHtml(item.alt || 'Customer review photo')}" loading="lazy">`
    : item.type === 'video' ? `<video controls preload="none" aria-label="${escapeHtml(item.alt || 'Customer review video')}"${safeUrl(item.poster) ? ` poster="${escapeHtml(item.poster)}"` : ''}><source src="${escapeHtml(item.url)}"></video>` : '').filter(Boolean);
  return items.length ? `<div class="customer-review-media">${items.join('')}</div>` : '';
}

function reviewEntry(review, product) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(review.date) && !Number.isNaN(Date.parse(`${review.date}T00:00:00Z`))
    ? `<time datetime="${review.date}">${new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${review.date}T00:00:00Z`))}</time>` : '';
  return `<li class="customer-review"><article>${ratingStars(review.rating)}<div class="customer-review-meta">${review.customer ? `<strong>${escapeHtml(review.customer)}</strong>` : ''}${review.verified === true ? '<span>Verified purchase</span>' : ''}${date}</div>${review.title ? `<h3>${escapeHtml(review.title)}</h3>` : ''}<p class="customer-review-body">${escapeHtml(review.body || '')}</p><p class="customer-review-product">${escapeHtml(product.name)}</p>${reviewMedia(review.media)}</article></li>`;
}

function productReviewsSection(product) {
  const summary = reviewSummary(product);
  const start = `<section class="pdp-reviews" data-review-product="${escapeHtml(product.name.toLowerCase())}" aria-labelledby="customer-reviews-heading"><p class="eyebrow">ANAWIN / ${escapeHtml(product.name)}</p><h2 id="customer-reviews-heading">CUSTOMER REVIEWS</h2>`;
  const writeUrl = validProductReviewLink(summary.writeReviewUrl, shopifyProductId(product.shopifyProductGid));
  const action = writeUrl ? `<a class="review-write-link" href="${escapeHtml(writeUrl)}" target="_blank" rel="noopener noreferrer">WRITE A REVIEW</a>` : '';
  if (summary.status === 'loading') return `${start}<div class="pdp-reviews-empty"><p>Loading customer reviews…</p>${action}</div></section>`;
  if (summary.status === 'unavailable') return `${start}<div class="pdp-reviews-empty"><p>Reviews are temporarily unavailable.</p>${action}</div></section>`;
  if (!summary.count) return `${start}<div class="pdp-reviews-empty"><p>No reviews yet.</p><p>Be the first to review this glove.</p>${action}</div></section>`;
  if (summary.detailUnavailable) return `${start}<div class="pdp-reviews-empty"><p>Review details are temporarily unavailable.</p>${action}</div></section>`;
  const breakdown = summary.distribution && [5, 4, 3, 2, 1].map(rating => {
    const count = summary.distribution[rating];
    const percent = Math.round(count / summary.count * 100);
    return `<li><span>${rating} stars</span><progress value="${count}" max="${summary.count}" aria-label="${rating} stars: ${count} ${count === 1 ? 'review' : 'reviews'} (${percent}%)"></progress><span>${count}</span></li>`;
  }).join('');
  return `${start}${action}<div class="pdp-review-summary"><div class="pdp-review-average"><strong>${summary.average.toFixed(1)} <span>out of 5</span></strong>${ratingStars(summary.average)}<p>Based on ${summary.count} ${summary.count === 1 ? 'review' : 'reviews'}</p></div>${breakdown ? `<div class="pdp-review-breakdown"><h3>Rating breakdown</h3><ul>${breakdown}</ul></div>` : ''}</div>${summary.reviews?.length ? `<ol class="customer-review-list">${summary.reviews.map(review => reviewEntry(review, product)).join('')}</ol>` : ''}${summary.moreAvailable ? '<p class="review-list-note">Showing recent reviews.</p>' : ''}</section>`;
}

function communitySection() {
  const entries = communityItems.filter(item => item.approved === true && item.image && item.alt);
  if (!entries.length) return '';
  return `<section class="community" aria-labelledby="community-heading"><div class="community-heading"><p class="eyebrow">ANAWIN / Community</p><h2 id="community-heading">COMMUNITY</h2></div><div class="community-grid">${entries.map(item => {
    const image = `<img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.alt)}" loading="lazy" />`;
    const product = item.productId && products.find(product => product.id === item.productId);
    const photo = product ? `<a href="${productPath(product)}" data-link aria-label="View ${escapeHtml(product.name)}: ${escapeHtml(item.alt)}">${image}</a>` : image;
    const caption = item.quote || item.displayName ? `<figcaption>${item.quote ? `<p>${escapeHtml(item.quote)}</p>` : ''}${item.displayName ? `<span>${escapeHtml(item.displayName)}</span>` : ''}</figcaption>` : '';
    return `<figure class="community-item">${photo}${caption}</figure>`;
  }).join('')}</div></section>`;
}

function home() {
  return `<main><section class="hero">${responsivePhoto('/images/hero-background.jpg', 'hero-background', [480, 640, 800, 960, 1200, 1350], '100vw', '', 1350, 1800, 'eager', 'hero-background', 'high')}<div class="hero-copy"><p class="eyebrow">ANAWIN / 2026</p><h1>COMMUNITY<br><em>BUILT</em></h1></div><a href="/shop" data-link class="hero-cta">View all gloves ${arrow()}</a></section>
    <section class="collection"><div class="section-heading"><div><p class="eyebrow">Collection</p><p class="collection-cue">3 trainer gloves</p></div><h2>MINI<br><em>GLOVES</em></h2></div>${productGrid()}</section>
    ${communitySection()}<section class="statement"><p class="eyebrow">ANAWIN / Baseball gloves</p><div class="statement-mark"><picture><source type="image/webp" srcset="/images/optimized/anawin-mark-240.webp 240w, /images/optimized/anawin-mark-480.webp 480w, /images/optimized/anawin-mark-860.webp 860w" sizes="(max-width: 760px) 55vw, min(38vw, 430px)"><img src="/images/anawin-mark.png" alt="ANAWIN emblem" width="1200" height="800" loading="lazy" /></picture></div><a href="/about" data-link>About ANAWIN ${arrow()}</a></section>
    <section class="newsletter" aria-labelledby="newsletter-heading"><div class="newsletter-copy"><p class="eyebrow">ANAWIN / Email</p><h2 id="newsletter-heading">JOIN OUR<br>COMMUNITY</h2><p>Be the first to hear about new gloves, releases, and what’s next.</p></div>${newsletterFormMarkup('newsletter')}</section></main>`;
}

const shop = () => `<main><section class="page-intro"><p class="eyebrow">Shop</p><h1>MINI<br><em>GLOVES</em></h1></section><section class="shop-products" aria-labelledby="shop-products-heading"><h2 id="shop-products-heading" class="visually-hidden">Shop ANAWIN gloves</h2><p class="collection-cue">3 trainer gloves</p>${productGrid(true)}</section></main>`;

function productPage(product) {
  if (!product) return notFound();
  const unavailable = commerceLoading || Boolean(commerceError) || !product.available;
  const serviceDisabled = unavailable || breakInService.available === false;
  const buttonLabel = commerceLoading ? 'Checking availability…' : commerceError ? 'Unavailable' : product.available ? 'Add to cart' : 'Sold out';
  const purchaseStatus = commerceLoading ? 'Checking glove and Break-In Service availability…' : commerceError ? 'Unable to confirm availability. Add to Cart is disabled.' : breakInService.available === false ? 'Break-In Service is unavailable.' : '';
  const accentStyle = `${product.accentColor ? `--pdp-accent:${escapeHtml(product.accentColor)};` : ''}${product.accentBackground ? `--pdp-accent-background:${escapeHtml(product.accentBackground)};` : ''}`;
  const otherGloves = products.filter(other => other.id !== product.id);
  const modelSwitcher = `<nav class="model-switcher" aria-label="Glove models"><span class="model-switcher-label">Models</span><div class="model-switcher-options">${products.map(model => model.id === product.id
    ? `<span class="model-switcher-current" aria-current="page">${escapeHtml(model.name)}<small>Current</small></span>`
    : `<a href="${productPath(model)}" data-link>${escapeHtml(model.name)}</a>`).join('')}</div></nav>`;
  return `<main class="pdp" style="${accentStyle}"><div class="pdp-main"><div class="pdp-gallery-wrap"><section class="pdp-gallery" aria-label="Product images">${product.images.map((src, i) => `<button class="gallery-image" data-image="${src}" aria-label="View image ${i + 1}">${productImage(src, `${product.tone} glove view ${i + 1}`, galleryImageSizes, i < 2 ? 'eager' : 'lazy')}</button>`).join('')}</section>${product.images.length > 1 ? `<div class="gallery-pagination"><span class="gallery-status" aria-live="polite">Image 1 of ${product.images.length}</span><div class="gallery-dots" aria-label="Select product image">${product.images.map((_, i) => `<button type="button" class="gallery-dot" data-gallery-index="${i}" aria-label="Show image ${i + 1} of ${product.images.length}" ${i === 0 ? 'aria-current="true"' : ''}></button>`).join('')}</div></div>` : ''}</div>
    <aside class="pdp-info"><p class="eyebrow">MINI GLOVE</p><h1>${escapeHtml(product.name)}</h1><p class="product-descriptor">${escapeHtml(product.descriptor)}</p><p class="price">${money(product.price, product.currencyCode)}</p><p class="product-pitch">${escapeHtml(product.pitch)}</p>${modelSwitcher}<div class="pdp-colorway"><span class="pdp-colorway-label">Colorway</span><div class="pdp-colorway-detail"><span class="pdp-swatch-combined" aria-hidden="true">${colorwaySwatches(product).map(color => `<span style="--swatch-color:${escapeHtml(color)}"></span>`).join('')}</span><p class="tone">${escapeHtml(product.tone)}</p></div></div>
      <dl class="hand-orientation"><div><dt>Throwing hand</dt><dd>${escapeHtml(product.throwingHand)}-Hand Throw</dd></div><div><dt>Glove hand</dt><dd>${escapeHtml(product.wornOnHand)} Hand</dd></div></dl>
      <label class="service-option"><input type="checkbox" data-break-in aria-describedby="break-in-description break-in-timing" ${serviceDisabled ? 'disabled' : ''}/><span class="service-content"><span class="service-heading"><strong>Break-in service</strong><b>+${money(breakInService.price, breakInService.currencyCode)}</b></span><small id="break-in-description">Have your glove loosened and shaped by hand so it arrives easier to close and ready for practice.</small><small class="service-timing" id="break-in-timing">Adds 2–5 business days.</small></span></label>
      ${purchaseStatus ? `<p class="purchase-status${commerceError ? ' purchase-status-error' : ''}">${purchaseStatus}</p>` : ''}
      <button class="add-button" data-add="${product.id}" ${unavailable ? 'disabled' : ''}>${buttonLabel} <span data-add-price>${money(purchasePrice(product, breakInService, false), product.currencyCode)}</span></button>
      <div class="purchase-trust" aria-label="Purchase information"><p><a href="/shipping" data-link>Processes in 1–3 business days</a> <span aria-hidden="true">·</span> <a href="/returns" data-link>30-day returns</a> <span aria-hidden="true">·</span> <a href="/warranty" data-link>1-year limited warranty</a> <span aria-hidden="true">·</span> <a href="/care" data-link>Care</a></p><p data-service-delay hidden>Break-In Service selected <span aria-hidden="true">·</span> adds 2–5 business days.</p></div>
      <section class="product-details" aria-labelledby="product-details-heading"><h2 id="product-details-heading">The details</h2><dl class="product-specs"><div><dt>Size</dt><dd>10.25 Inches</dd></div><div><dt>Leather</dt><dd>US Steerhide Leather</dd></div><div><dt>Features</dt><dd>Double Finger Pad</dd></div><div><dt>Thumb</dt><dd>Sheepskin Thumb Sleeve</dd></div></dl></section>
      <details><summary>Product information <span class="accordion-indicator" aria-hidden="true"></span></summary><p>A 10.25-inch training glove designed for focused glove-work practice. Its compact size gives players a smaller training platform than a standard game glove.</p></details>
      <details><summary>Break-in &amp; care <span class="accordion-indicator" aria-hidden="true"></span></summary><p>${escapeHtml(careIntro)}</p><div class="pdp-policy-links"><a href="/break-in" data-link>Break-In Guide</a><a href="/care" data-link>Glove Care</a></div></details>
      <details><summary>Shipping & returns <span class="accordion-indicator" aria-hidden="true"></span></summary><p>Free U.S. standard shipping. International shipping is available to Canada, Australia, Japan, and South Korea. International rates are calculated at checkout. Orders process in 1–3 business days; Break-In Service adds 2–5 business days. U.S. standard delivery is typically 3–7 business days after shipment. Eligible returns are accepted within 30 days of delivery. Prepaid return labels are provided for eligible U.S. returns.</p><div class="pdp-policy-links"><a href="/shipping" data-link>Shipping Policy</a><a href="/returns" data-link>Returns &amp; Refunds Policy</a></div></details>
      <details><summary>Warranty <span class="accordion-indicator" aria-hidden="true"></span></summary><p>${escapeHtml(warrantyParagraphs[0])}</p><div class="pdp-policy-links"><a href="/warranty" data-link>Full Warranty</a></div></details>
    </aside></div>${productReviewsSection(product)}${otherGloves.length ? `<section class="other-gloves" aria-labelledby="other-gloves-heading"><h2 id="other-gloves-heading">OTHER GLOVES</h2><div class="other-gloves-grid">${otherGloves.map(other => `<a class="other-glove-card" href="${productPath(other)}" data-link>${productImage(other.images[0], '', '(max-width: 760px) 92px, 120px', 'lazy')}<span class="other-glove-meta"><strong>${escapeHtml(other.name)}</strong><small>${escapeHtml(other.tone)}</small></span>${arrow()}</a>`).join('')}</div></section>` : ''}</main>`;
}

function about() {
  return `<main><section class="about-hero"><h1>ABOUT<br><em>ANAWIN</em></h1><div class="about-image">${responsivePhoto('/images/cherry_pink.png', 'cherry_pink', [720, 1200, 1448], '100vw', 'Cherry-pink ANAWIN glove among flowers', 1448, 1086, 'eager')}</div></section>
    <section class="origin"><p class="eyebrow">Company</p><div><h2>HOW IT STARTED</h2><p>ANAWIN started with two best friends, over 10 years of friendship, and a shared love for baseball.</p><p>We created ANAWIN with a simple goal: bring more energy and attention back to the game we grew up loving. From the beginning, authenticity has been at the center of what we do. We shared the process, listened to feedback, and let the baseball community help shape what we were building.</p><p>ANAWIN was not just built for the baseball community. It was built with them.</p></div></section>
    <section class="founders founders-editorial" aria-labelledby="founders-heading">
      <div class="founders-heading"><p class="eyebrow">ANAWIN / Co-founders</p><h2 id="founders-heading"><em>FOUNDERS</em></h2></div>
      <div class="founders-layout">
        <article class="founder-profile" aria-labelledby="founder-ray">
          <div class="founder-portrait">${responsivePhoto('/images/ray_headshot.png', 'ray_headshot', [480, 960, 1778], '(max-width: 760px) min(300px, calc(100vw - 32px)), min(420px, calc((100vw - 80px) / 2))', 'Ray Lopez, co-founder of ANAWIN', 1778, 1812, 'lazy')}</div>
          <div class="founder-details"><p class="founder-role">CO-FOUNDER</p><h3 id="founder-ray">RAY LOPEZ</h3><div class="founder-bio"><p>Growing up with a father who played professional baseball, Ray developed a love for the game that eventually led him to start ANAWIN.</p><ul><li>Finance and Sports Business student at Arizona State University</li><li>Former Finance Intern with the Arizona Diamondbacks</li><li>Building ANAWIN alongside the baseball community, with their ideas helping shape each product</li></ul></div></div>
        </article>
        <article class="founder-profile" aria-labelledby="founder-anawin">
          <div class="founder-portrait">${responsivePhoto('/images/anawin_headshot-gray.png', 'anawin_headshot-gray', [480, 960, 1254], '(max-width: 760px) min(300px, calc(100vw - 32px)), min(420px, calc((100vw - 80px) / 2))', 'Anawin Pikulthong, co-founder of ANAWIN', 1254, 1254, 'lazy')}</div>
          <div class="founder-details"><p class="founder-role">CO-FOUNDER</p><h3 id="founder-anawin">ANAWIN PIKULTHONG</h3><div class="founder-bio"><p>With a background in competitive golf, Anawin brings a mix of athlete experience and a passion for equipment to building ANAWIN.</p><ul><li>Data Science student at Arizona State University</li><li>Former Marketing Analytics Intern at TaylorMade Golf</li><li>Former Division 1 Golfer at Arizona State University</li></ul></div></div>
        </article>
      </div>
    </section>
    <section class="philosophy"><p class="eyebrow">ANAWIN</p><h2>OUR STORY</h2><div class="story-copy"><p>We met in sixth grade and have been close ever since. Over the years, we have spent countless hours playing catch, throwing sliders into the dirt, talking baseball, and competing over just about everything.</p><p>Baseball has always been part of our friendship, so building ANAWIN felt natural. We wanted to create something that reflected the way we actually grew up around the game: competitive, creative, and authentic.</p><p>What started as an idea between two friends became a brand shaped by the same baseball community we have always been part of.</p></div></section></main>`;
}

function shippingPolicy() {
  return `<main class="policy-page shipping-policy"><h1>Shipping Policy</h1>
    <p>We currently ship to the United States, Canada, Australia, Japan, and South Korea.</p>
    <section><h2>United States</h2><p>Standard Shipping — FREE</p></section>
    <section><h2>Canada, Australia, Japan &amp; South Korea</h2><p>International shipping rates and available services are calculated at checkout based on destination and shipping method.</p></section>
    <section><h2>Processing Times</h2><p>Orders without Break-In Service are processed within 1–3 business days.</p><p>Orders that include Break-In Service require an additional 2–5 business days of processing before shipment.</p><p>Business days exclude weekends and holidays.</p></section>
    <section><h2>Delivery Estimates</h2><p>U.S. standard shipping is typically delivered in 3–7 business days after shipment.</p><p>International delivery times vary by destination and shipping service. Available transit estimates are shown at checkout.</p><p>Delivery estimates begin once the carrier has received the package and may vary due to carrier delays, weather, holidays, or other circumstances outside ANAWIN's control.</p></section>
    <section><h2>International Orders</h2><p>Applicable duties, taxes, and import charges are shown at checkout when available.</p></section>
    <section><h2>Tracking</h2><p>When available, tracking information will be provided after the order ships.</p></section>
    <section><h2>Incorrect or Damaged Orders</h2><p>If an order arrives damaged, defective, or incorrect, email <a href="mailto:support@anawinofficial.com">support@anawinofficial.com</a> as soon as possible so the issue can be reviewed and resolved.</p></section>
  </main>`;
}

function returnsPolicy() {
  return `<main class="policy-page"><h1>Returns &amp; Refunds Policy</h1>
    <section><h2>30-Day Returns</h2><p>Eligible items may be returned within 30 days of delivery.</p><p>To qualify for a return, the glove must be:</p><ul><li>unused or only lightly tried on</li><li>free from game or practice use</li><li>free from alterations or customer-caused damage</li></ul><p>Original packaging should be included when reasonably possible.</p></section>
    <section><h2>Start a Return</h2><p>To request a return, email <a href="mailto:support@anawinofficial.com">support@anawinofficial.com</a> with your order number and the reason for the return.</p></section>
    <section><h2>Break-In Service</h2><p>Gloves that receive ANAWIN Break-In Service remain eligible for return, provided they otherwise meet the return requirements above.</p></section>
    <section><h2>Return Shipping</h2><p>For eligible U.S. returns, ANAWIN will provide a prepaid return shipping label.</p></section>
    <section><h2>Original Shipping Charges</h2><p>Original shipping charges are non-refundable, except when the order was defective, damaged, or incorrect.</p></section>
    <section><h2>Non-Returnable Items</h2><p>There are currently no product categories designated as non-returnable.</p></section>
    <section><h2>Refunds</h2><p>After a returned item is received and inspected, approved refunds will be issued within 3–5 business days.</p><p>The time it takes for the refund to appear in the customer's account after issuance may depend on the bank or payment provider.</p></section>
  </main>`;
}

function warrantyPolicy() {
  return `<main class="policy-page"><h1>Warranty</h1><section><h2>1-Year Limited Warranty</h2>${policyParagraphs(warrantyParagraphs)}</section><section><h2>Make a Warranty Claim</h2><p>Email <a href="mailto:support@anawinofficial.com">support@anawinofficial.com</a> with your order number, a description of the issue, and clear photos of the glove.</p></section></main>`;
}

function carePolicy() {
  return `<main class="policy-page"><h1>Care</h1><section><h2>Glove Care</h2><p>${escapeHtml(careIntro)}</p></section>${carePageContent()}</main>`;
}

function breakInPolicy() {
  return `<main class="policy-page"><h1>Breaking In Your Glove</h1><section><p>${escapeHtml(breakInIntro)}</p></section>${breakInPageContent()}</main>`;
}

const notFound = () => `<main class="not-found"><p class="eyebrow">Error / 404</p><h1>PAGE NOT<br><em>FOUND.</em></h1><a href="/" data-link>Return home ${arrow()}</a></main>`;

function route(pathname) {
  const path = normalizePath(pathname);
  if (!routeMetadata(path)) return notFound();
  if (path === '/') return home();
  if (path === '/shop') return shop();
  if (path === '/about') return about();
  if (path === '/shipping') return shippingPolicy();
  if (path === '/returns') return returnsPolicy();
  if (path === '/warranty') return warrantyPolicy();
  if (path === '/care') return carePolicy();
  if (path === '/break-in') return breakInPolicy();
  const product = products.find(item => productPath(item) === path);
  if (product) return productPage(product);
  return notFound();
}

  return { header, commerceNotice, footer, route, notFound, productCardRatingMarkup, productReviewsSection };
}
