import './style.css';
import { breakInService as localBreakInService, localProducts, purchasePrice } from './catalog.js';
import { createCommerce } from './commerce.js';
import { renderCartRow } from './cart-row.js';
import { containTab } from './dialog.js';
import { communityItems } from './community.js';
import { warrantyParagraphs, careIntro, careInstructions, careSections, breakInIntro, breakInSections } from './policy-content.js';

const app = document.querySelector('#app');
let commerceError = '';
let commerce;
try {
  commerce = createCommerce();
} catch (error) {
  commerce = createCommerce({ env: { VITE_COMMERCE_MODE: 'local' } });
  commerceError = `Shopify configuration error: ${error.message}`;
}
let products = [...localProducts];
let breakInService = localBreakInService;
let cart = { id: null, lines: [], subtotal: 0, currencyCode: 'USD', checkoutUrl: null };
let commerceLoading = commerce.mode === 'shopify';
let cartBusy = false;
let cartError = '';
let cartIsOpen = false;
let cartReturnFocus = null;
let cartCloseTimer = null;
let lightboxOverlay = null;
let lightboxReturnFocus = null;

const money = (value, currency = 'USD') => new Intl.NumberFormat('en-US', {
  style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 2
}).format(value);
const escapeHtml = value => String(value).replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
const policyParagraphs = paragraphs => paragraphs.map(paragraph => `<p>${escapeHtml(paragraph)}</p>`).join('');
const policyList = items => `<ul>${items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
const careItem = item => {
  const separator = item.indexOf('. ');
  return separator > 0 ? `<li><strong>${escapeHtml(item.slice(0, separator + 1))}</strong>${escapeHtml(item.slice(separator + 1))}</li>` : `<li>${escapeHtml(item)}</li>`;
};
const carePageContent = () => careSections.map(section => `<section><h2>${escapeHtml(section.heading)}</h2>${section.intro ? `<p>${escapeHtml(section.intro)}</p>` : ''}${section.paragraphs ? policyParagraphs(section.paragraphs) : `<ul>${section.items.map(careItem).join('')}</ul>`}</section>`).join('');
const breakInPageContent = () => breakInSections.map(section => `<section><h2>${escapeHtml(section.heading)}</h2>${section.paragraphs ? section.paragraphs.map((paragraph, index) => `<p>${section.emphasis === index ? `<strong>${escapeHtml(paragraph)}</strong>` : escapeHtml(paragraph)}</p>`).join('') : ''}${section.items ? policyList(section.items) : ''}${section.after ? policyParagraphs(section.after) : ''}</section>`).join('');
const arrow = () => `<svg class="link-arrow" viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M2 10 10 2M4 2h6v6" /></svg>`;
const cardImageSizes = '(max-width: 760px) calc(100vw - 32px), calc((100vw - 80px) / 3)';
const galleryImageSizes = '(max-width: 760px) 90vw, 30vw';
const colorwaySwatches = product => product.id === 'brown'
  ? ['#6f6843', ...(product.swatches || [])]
  : (product.swatches || []);

function productImage(src, alt, sizes, loading) {
  const name = src.split('/').pop().replace(/\.PNG$/, '');
  const fullWidth = name === 'black1' ? 1045 : 1254;
  const fullHeight = name === 'black1' ? 1044 : 1254;
  const optimized = width => `/images/optimized/${name}-${width}.webp`;
  const srcset = [480, 960, fullWidth].map(width => `${optimized(width)} ${width}w`).join(', ');
  return `<picture><source type="image/webp" srcset="${srcset}" sizes="${sizes}"><img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" width="${fullWidth}" height="${fullHeight}" loading="${loading}" /></picture>`;
}

function responsivePhoto(src, name, widths, sizes, alt, width, height, loading, className = '') {
  const srcset = widths.map(candidate => `/images/optimized/${name}-${candidate}.webp ${candidate}w`).join(', ');
  return `<picture><source type="image/webp" srcset="${srcset}" sizes="${sizes}"><img class="${className}" src="${src}" alt="${escapeHtml(alt)}" width="${width}" height="${height}" loading="${loading}" /></picture>`;
}
const cartCount = () => cart.lines.filter(line => !line.isBreakIn).reduce((sum, line) => sum + line.quantity, 0);
const canCheckout = () => commerce.mode === 'shopify' && Boolean(cart.checkoutUrl) && !cart.incomplete && cart.lines.length > 0 && cart.lines.every(line => {
  if (!line.merchandiseId) return false;
  if (!line.isBreakIn) return true;
  const parent = cart.lines.find(candidate => candidate.remoteLineId === line.parentLineId && !candidate.isBreakIn);
  return parent?.productId === line.productId && parent.quantity === line.quantity;
});

function header() {
  return `<header class="site-header">
    <a class="wordmark" href="/" data-link aria-label="ANAWIN home"><img src="/images/anawin-wordmark.png" alt="ANAWIN" /></a>
    <nav class="desktop-nav" aria-label="Main navigation"><a href="/shop" data-link>Shop</a><a href="/about" data-link>About</a></nav>
    <button class="mobile-menu-toggle" type="button" aria-expanded="false" aria-controls="mobile-menu" aria-label="Open menu">Menu</button>
    <nav class="mobile-nav" id="mobile-menu" aria-label="Mobile navigation" hidden><a href="/shop" data-link>Shop</a><a href="/about" data-link>About</a><button type="button" data-cart>Cart</button></nav>
    <button class="cart-trigger" data-cart aria-label="Open cart with ${cartCount()} items">Cart <span class="cart-count">(${cartCount()})</span></button>
  </header>`;
}

function commerceNotice() {
  if (commerceLoading) return `<div class="commerce-notice" role="status">Connecting to product inventory…</div>`;
  if (commerceError) return `<div class="commerce-notice commerce-notice-error" role="alert">${escapeHtml(commerceError)}</div>`;
  return '';
}

function footer() {
  return `<footer><div class="footer-mark"><a href="/" data-link aria-label="ANAWIN home" style="display:block"><img src="/images/anawin-wordmark.png" alt="ANAWIN" /></a></div><div class="footer-grid">
    <div><p class="eyebrow">Navigation</p><a href="/shop" data-link>Shop</a><a href="/about" data-link>About</a></div>
    <div><p class="eyebrow">Connect</p><a href="mailto:support@anawinofficial.com">support@anawinofficial.com</a><a href="mailto:ray@anawinofficial.com">ray@anawinofficial.com</a><a href="mailto:anawin@anawinofficial.com">anawin@anawinofficial.com</a><a href="https://www.instagram.com/anawinofficial" target="_blank" rel="noreferrer">Instagram — @anawinofficial</a><a href="https://www.tiktok.com/@anawinofficial" target="_blank" rel="noreferrer">TikTok — @anawinofficial</a></div>
    <div><p class="eyebrow">Information</p><a href="/shipping" data-link>Shipping Policy</a><a href="/returns" data-link>Returns &amp; Refunds Policy</a><a href="/warranty" data-link>Warranty</a><a href="/care" data-link>Glove Care</a><a href="/break-in" data-link>Breaking In Your Glove</a></div>
  </div><div class="legal"><span>© ${new Date().getFullYear()} ANAWIN</span><span>Baseball gloves</span></div></footer>`;
}

function productCard(product, index, eagerFirst) {
  const availability = product.available ? '' : '<span class="sold-out">Sold out</span>';
  return `<article class="product-card reveal" style="--delay:${index * 80}ms;--card-accent:${escapeHtml(product.accentColor || '#111111')}">
    <a href="/product/${product.id}" data-link class="product-image">${productImage(product.images[0], `${product.tone} ANAWIN glove`, cardImageSizes, eagerFirst && index === 0 ? 'eager' : 'lazy')}<span class="view-product">View ${arrow()}</span></a>
    <div class="product-meta"><div><h3>${escapeHtml(product.name)}</h3><p>${escapeHtml(product.tone)}</p>${availability}</div><strong>${money(product.price, product.currencyCode)}</strong></div>
  </article>`;
}

const productGrid = (eagerFirst = false) => `<div class="product-grid">${products.map((product, index) => productCard(product, index, eagerFirst)).join('')}</div>`;

function communitySection() {
  const entries = communityItems.filter(item => item.approved === true && item.image && item.alt);
  if (!entries.length) return '';
  return `<section class="community" aria-labelledby="community-heading"><div class="community-heading"><p class="eyebrow">ANAWIN / Community</p><h2 id="community-heading">COMMUNITY</h2></div><div class="community-grid">${entries.map(item => {
    const image = `<img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.alt)}" loading="lazy" />`;
    const product = item.productId && products.find(product => product.id === item.productId);
    const photo = product ? `<a href="/product/${escapeHtml(product.id)}" data-link aria-label="View ${escapeHtml(product.name)}: ${escapeHtml(item.alt)}">${image}</a>` : image;
    const caption = item.quote || item.displayName ? `<figcaption>${item.quote ? `<p>${escapeHtml(item.quote)}</p>` : ''}${item.displayName ? `<span>${escapeHtml(item.displayName)}</span>` : ''}</figcaption>` : '';
    return `<figure class="community-item">${photo}${caption}</figure>`;
  }).join('')}</div></section>`;
}

function home() {
  return `<main><section class="hero">${responsivePhoto('/images/hero-background.jpg', 'hero-background', [640, 960, 1350], '(max-width: 760px) 150vw, 100vw', '', 1350, 1800, 'eager', 'hero-background')}<div class="hero-copy"><p class="eyebrow">ANAWIN / 2026</p><h1>COMMUNITY<br><em>BUILT</em></h1></div><a href="/shop" data-link class="hero-cta">View all gloves ${arrow()}</a></section>
    <section class="collection"><div class="section-heading"><p class="eyebrow">Collection</p><h2>MINI<br><em>GLOVES</em></h2></div>${productGrid()}</section>
    ${communitySection()}<section class="statement"><p class="eyebrow">ANAWIN / Baseball gloves</p><div class="statement-mark"><img src="/images/anawin-mark.png" alt="ANAWIN emblem" width="1200" height="800" loading="lazy" /></div><a href="/about" data-link>About ANAWIN ${arrow()}</a></section></main>`;
}

const shop = () => `<main><section class="page-intro"><p class="eyebrow">Shop</p><h1>MINI<br><em>GLOVES</em></h1></section><section class="shop-products">${productGrid(true)}</section></main>`;

function productPage(product) {
  if (!product) return notFound();
  const unavailable = commerceLoading || Boolean(commerceError) || !product.available;
  const buttonLabel = commerceLoading ? 'Checking availability…' : product.available ? 'Add to cart' : 'Sold out';
  const accentStyle = `${product.accentColor ? `--pdp-accent:${escapeHtml(product.accentColor)};` : ''}${product.accentBackground ? `--pdp-accent-background:${escapeHtml(product.accentBackground)};` : ''}`;
  const otherGloves = products.filter(other => other.id !== product.id);
  return `<main class="pdp" style="${accentStyle}"><div class="pdp-main"><div class="pdp-gallery-wrap"><section class="pdp-gallery" aria-label="Product images">${product.images.map((src, i) => `<button class="gallery-image" data-image="${src}" aria-label="View image ${i + 1}">${productImage(src, `${product.tone} glove view ${i + 1}`, galleryImageSizes, i < 2 ? 'eager' : 'lazy')}</button>`).join('')}</section>${product.images.length > 1 ? `<div class="gallery-pagination"><span class="gallery-status" aria-live="polite">Image 1 of ${product.images.length}</span><div class="gallery-dots" aria-label="Select product image">${product.images.map((_, i) => `<button type="button" class="gallery-dot" data-gallery-index="${i}" aria-label="Show image ${i + 1} of ${product.images.length}" ${i === 0 ? 'aria-current="true"' : ''}></button>`).join('')}</div></div>` : ''}</div>
    <aside class="pdp-info"><p class="eyebrow">MINI GLOVE</p><h1>${escapeHtml(product.name)}</h1><p class="product-descriptor">${escapeHtml(product.descriptor)}</p><p class="product-pitch">${escapeHtml(product.pitch)}</p><div class="pdp-colorway"><span class="pdp-colorway-label">Colorway</span><div class="pdp-colorway-detail"><span class="pdp-swatch-combined" aria-hidden="true">${colorwaySwatches(product).map(color => `<span style="--swatch-color:${escapeHtml(color)}"></span>`).join('')}</span><p class="tone">${escapeHtml(product.tone)}</p></div></div><p class="price">${money(product.price, product.currencyCode)}</p>
      <dl class="hand-orientation"><div><dt>Throwing hand</dt><dd>${escapeHtml(product.throwingHand)}-Hand Throw</dd></div><div><dt>Glove hand</dt><dd>${escapeHtml(product.wornOnHand)} Hand</dd></div></dl>
      <label class="service-option"><input type="checkbox" data-break-in aria-describedby="break-in-description break-in-timing" ${breakInService.available === false ? 'disabled' : ''}/><span class="service-content"><span class="service-heading"><strong>Break-in service</strong><b>+${money(breakInService.price, breakInService.currencyCode)}</b></span><small id="break-in-description">Have your glove loosened and shaped by hand so it arrives easier to close and ready for practice.</small><small class="service-timing" id="break-in-timing">Adds 2–5 business days.</small></span></label>
      <button class="add-button" data-add="${product.id}" ${unavailable ? 'disabled' : ''}>${buttonLabel} <span data-add-price>${money(purchasePrice(product, breakInService, false), product.currencyCode)}</span></button>
      <div class="purchase-trust" aria-label="Purchase information"><p>Processes in 1–3 business days <span aria-hidden="true">·</span> 30-day returns <span aria-hidden="true">·</span> 1-year limited warranty</p><p data-service-delay hidden>Break-In Service selected <span aria-hidden="true">·</span> adds 2–5 business days.</p></div>
      <section class="product-details" aria-labelledby="product-details-heading"><h2 id="product-details-heading">The details</h2><dl class="product-specs"><div><dt>Size</dt><dd>10.25 Inches</dd></div><div><dt>Leather</dt><dd>US Steerhide Leather</dd></div><div><dt>Features</dt><dd>Double Finger Pad</dd></div><div><dt>Thumb</dt><dd>Sheepskin Thumb Sleeve</dd></div></dl></section>
      <details><summary>Product information <span class="accordion-indicator" aria-hidden="true"></span></summary><p>A 10.25-inch training glove designed for focused glove-work practice. Its compact size gives players a smaller training platform than a standard game glove.</p></details>
      <details><summary>Break-in &amp; care <span class="accordion-indicator" aria-hidden="true"></span></summary><p>${escapeHtml(careIntro)}</p><div class="pdp-policy-links"><a href="/break-in" data-link>Break-In Guide</a><a href="/care" data-link>Glove Care</a></div></details>
      <details><summary>Shipping & returns <span class="accordion-indicator" aria-hidden="true"></span></summary><p>Standard orders process in 1–3 business days. Break-In Service adds 2–5 business days. U.S. shipping is calculated at checkout, with estimated delivery 3–7 business days after shipment. Eligible returns are accepted within 30 days of delivery, and ANAWIN provides a prepaid return label.</p><div class="pdp-policy-links"><a href="/shipping" data-link>Shipping Policy</a><a href="/returns" data-link>Returns &amp; Refunds Policy</a></div></details>
      <details><summary>Warranty <span class="accordion-indicator" aria-hidden="true"></span></summary><p>${escapeHtml(warrantyParagraphs[0])}</p><div class="pdp-policy-links"><a href="/warranty" data-link>Full Warranty</a></div></details>
    </aside></div>${otherGloves.length ? `<section class="other-gloves" aria-labelledby="other-gloves-heading"><h2 id="other-gloves-heading">OTHER GLOVES</h2><div class="other-gloves-grid">${otherGloves.map(other => `<a class="other-glove-card" href="/product/${escapeHtml(other.id)}" data-link>${productImage(other.images[0], '', '(max-width: 760px) 92px, 120px', 'lazy')}<span class="other-glove-meta"><strong>${escapeHtml(other.name)}</strong><small>${escapeHtml(other.tone)}</small></span>${arrow()}</a>`).join('')}</div></section>` : ''}</main>`;
}

function about() {
  return `<main><section class="about-hero"><h1>ABOUT<br><em>ANAWIN</em></h1><div class="about-image">${responsivePhoto('/images/cherry_pink.png', 'cherry_pink', [720, 1200, 1448], '100vw', 'Cherry-pink ANAWIN glove among flowers', 1448, 1086, 'eager')}</div></section>
    <section class="origin"><p class="eyebrow">Company</p><div><h2>HOW IT STARTED</h2><p>ANAWIN started with two best friends, over 10 years of friendship, and a shared love for baseball.</p><p>We created ANAWIN with a simple goal: bring more energy and attention back to the game we grew up loving. From the beginning, authenticity has been at the center of what we do. We shared the process, listened to feedback, and let the baseball community help shape what we were building.</p><p>ANAWIN was not just built for the baseball community. It was built with them.</p></div></section>
    <section class="founders founders-editorial" aria-labelledby="founders-heading">
      <div class="founders-heading"><p class="eyebrow">ANAWIN / Co-founders</p><h2 id="founders-heading"><em>FOUNDERS</em></h2></div>
      <div class="founders-layout">
        <article class="founder-profile" aria-labelledby="founder-ray">
          <div class="founder-portrait">${responsivePhoto('/images/ray_headshot.png', 'ray_headshot', [480, 960, 1778], '(max-width: 760px) calc(100vw - 32px), calc((100vw - 80px) / 2)', 'Ray Lopez, co-founder of ANAWIN', 1778, 1812, 'lazy')}</div>
          <div class="founder-details"><p class="founder-role">CO-FOUNDER</p><h3 id="founder-ray">RAY LOPEZ</h3><div class="founder-bio"><p>Growing up with a father who played professional baseball, Ray developed a love for the game that eventually led him to start ANAWIN.</p><ul><li>Finance and Sports Business student at Arizona State University</li><li>Former Finance Intern with the Arizona Diamondbacks</li><li>Building ANAWIN alongside the baseball community, with their ideas helping shape each product</li></ul></div></div>
        </article>
        <article class="founder-profile" aria-labelledby="founder-anawin">
          <div class="founder-portrait">${responsivePhoto('/images/anawin_headshot-gray.png', 'anawin_headshot-gray', [480, 960, 1254], '(max-width: 760px) calc(100vw - 32px), calc((100vw - 80px) / 2)', 'Anawin Pikulthong, co-founder of ANAWIN', 1254, 1254, 'lazy')}</div>
          <div class="founder-details"><p class="founder-role">CO-FOUNDER</p><h3 id="founder-anawin">ANAWIN PIKULTHONG</h3><div class="founder-bio"><p>With a background in competitive golf, Anawin brings a mix of athlete experience and a passion for equipment to building ANAWIN.</p><ul><li>Data Science student at Arizona State University</li><li>Former Marketing Analytics Intern at TaylorMade Golf</li><li>Former Division 1 Golfer at Arizona State University</li></ul></div></div>
        </article>
      </div>
    </section>
    <section class="philosophy"><p class="eyebrow">ANAWIN</p><h2>OUR STORY</h2><div class="story-copy"><p>We met in sixth grade and have been close ever since. Over the years, we have spent countless hours playing catch, throwing sliders into the dirt, talking baseball, and competing over just about everything.</p><p>Baseball has always been part of our friendship, so building ANAWIN felt natural. We wanted to create something that reflected the way we actually grew up around the game: competitive, creative, and authentic.</p><p>What started as an idea between two friends became a brand shaped by the same baseball community we have always been part of.</p></div></section></main>`;
}

function shippingPolicy() {
  return `<main class="policy-page"><h1>Shipping Policy</h1>
    <section><h2>Processing Times</h2><p>Orders without Break-In Service are processed within 1–3 business days.</p><p>Orders that include Break-In Service require an additional 2–5 business days of processing before shipment.</p><p>Business days exclude weekends and holidays.</p></section>
    <section><h2>Shipping Area</h2><p>ANAWIN currently ships within the United States only.</p></section>
    <section><h2>Shipping Rates</h2><p>Shipping costs are calculated at checkout based on the destination and available shipping method.</p></section>
    <section><h2>Delivery Estimates</h2><p>After an order ships, estimated delivery is typically 3–7 business days.</p><p>Delivery estimates begin once the carrier has received the package and may vary due to carrier delays, weather, holidays, or other circumstances outside ANAWIN's control.</p></section>
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

function cartDrawer() {
  const productItems = commerce.mode === 'shopify'
    ? cart.lines.filter(line => !line.isBreakIn).map(line => ({
      line,
      product: products.find(product => product.id === line.productId),
      service: cart.lines.find(child => child.isBreakIn && child.parentLineId === line.remoteLineId)
    })).filter(entry => entry.product)
    : products.map(product => ({
      product,
      line: cart.lines.find(line => line.productId === product.id && !line.isBreakIn),
      service: cart.lines.find(line => line.productId === product.id && line.isBreakIn)
    })).filter(entry => entry.line);
  const checkout = canCheckout()
    ? `<button data-checkout ${cartBusy ? 'disabled' : ''}>Checkout securely</button>`
    : `<button disabled>Checkout coming soon</button><small>${commerce.mode === 'local' ? 'Connect Shopify to enable secure checkout.' : 'Checkout is unavailable until Shopify returns a verified cart.'}</small>`;
  return `<div class="cart-backdrop" data-close-cart aria-hidden="true"></div><aside class="cart-drawer" role="dialog" aria-modal="true" aria-labelledby="cart-heading"><div class="cart-head"><h2 id="cart-heading">Your cart</h2><button data-close-cart aria-label="Close cart">Close</button></div>
    <div class="cart-body">${productItems.length ? productItems.map(({ product, line, service }) => renderCartRow({
      product, line, service, mode: commerce.mode, serviceProduct: breakInService,
      busy: cartBusy, incomplete: cart.incomplete, money, escapeHtml
    })).join('') : `<div class="empty-cart"><p>Your cart is empty.</p><a href="/shop" data-link data-close-cart>Shop gloves ${arrow()}</a></div>`}</div>
    ${productItems.length ? `<div class="cart-foot"><div><span>Subtotal</span><strong>${money(cart.subtotal, cart.currencyCode)}</strong></div><p>Taxes and shipping calculated at checkout.</p>${cartError ? `<p class="cart-error" role="alert">${escapeHtml(cartError)}</p>` : ''}${checkout}</div>` : ''}</aside>`;
}

function route() {
  const path = location.pathname.replace(/\/$/, '') || '/';
  if (path === '/') return home();
  if (path === '/shop') return shop();
  if (path === '/about') return about();
  if (path === '/shipping') return shippingPolicy();
  if (path === '/returns') return returnsPolicy();
  if (path === '/warranty') return warrantyPolicy();
  if (path === '/care') return carePolicy();
  if (path === '/break-in') return breakInPolicy();
  if (path.startsWith('/product/')) return productPage(products.find(product => product.id === path.split('/')[2]));
  return notFound();
}

function fitHeroHeading() {
  const heading = document.querySelector('.hero h1');
  if (!heading) return;
  heading.style.fontSize = '';
  if (!window.matchMedia('(max-width: 760px) and (orientation: portrait)').matches) return;
  const firstLine = heading.firstChild;
  const range = document.createRange();
  range.selectNodeContents(firstLine);
  const available = heading.clientWidth - 20;
  const lineWidth = range.getBoundingClientRect().width;
  if (lineWidth > available) {
    const fontSize = parseFloat(getComputedStyle(heading).fontSize);
    heading.style.fontSize = `${Math.floor(fontSize * available / lineWidth)}px`;
  }
}

function render() { app.innerHTML = header() + commerceNotice() + route() + footer(); fitHeroHeading(); bind(); window.scrollTo(0, 0); }
function navigate(path) { history.pushState({}, '', path); render(); }
function openCart(opener = null) {
  if (!cartIsOpen) cartReturnFocus = opener || document.activeElement;
  cartIsOpen = true;
  clearTimeout(cartCloseTimer);
  document.querySelector('.cart-drawer')?.remove(); document.querySelector('.cart-backdrop')?.remove();
  document.body.insertAdjacentHTML('beforeend', cartDrawer());
  app.inert = true;
  requestAnimationFrame(() => { if (cartIsOpen) document.body.classList.add('cart-open'); });
  bindCart();
  document.querySelector('.cart-head [data-close-cart]')?.focus();
}
function closeCart() {
  if (!cartIsOpen) return;
  cartIsOpen = false;
  document.body.classList.remove('cart-open');
  app.inert = Boolean(lightboxOverlay);
  const opener = cartReturnFocus;
  cartReturnFocus = null;
  (opener?.isConnected && !opener.closest('[hidden]') ? opener : document.querySelector('.cart-trigger'))?.focus();
  clearTimeout(cartCloseTimer);
  cartCloseTimer = setTimeout(() => {
    if (cartIsOpen) return;
    document.querySelector('.cart-drawer')?.remove(); document.querySelector('.cart-backdrop')?.remove();
  }, 300);
}
function syncCartCount() {
  document.querySelectorAll('.cart-count').forEach(node => { node.textContent = `(${cartCount()})`; });
  document.querySelector('.cart-trigger')?.setAttribute('aria-label', `Open cart with ${cartCount()} items`);
}
function closeMobileMenu(returnFocus = false) {
  const toggle = document.querySelector('.mobile-menu-toggle');
  const menu = document.querySelector('#mobile-menu');
  if (!toggle || !menu || menu.hidden) return;
  menu.hidden = true;
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-label', 'Open menu');
  if (returnFocus) toggle.focus();
}

function bindMobileGallery() {
  const gallery = document.querySelector('.pdp-gallery');
  const status = document.querySelector('.gallery-status');
  const dots = [...document.querySelectorAll('.gallery-dot')];
  if (!gallery || !status || !dots.length) return;
  const images = [...gallery.querySelectorAll('.gallery-image')];
  const update = () => {
    const first = images[0].offsetLeft;
    const active = images.reduce((closest, image, index) =>
      Math.abs(image.offsetLeft - first - gallery.scrollLeft) < Math.abs(images[closest].offsetLeft - first - gallery.scrollLeft) ? index : closest, 0);
    status.textContent = `Image ${active + 1} of ${images.length}`;
    dots.forEach((dot, index) => {
      if (index === active) dot.setAttribute('aria-current', 'true');
      else dot.removeAttribute('aria-current');
    });
  };
  gallery.addEventListener('scroll', update, { passive: true });
  dots.forEach((dot, index) => dot.addEventListener('click', () => {
    gallery.scrollTo({ left: images[index].offsetLeft - images[0].offsetLeft, behavior: 'auto' });
    update();
  }));
}
async function cartAction(action, opener = null) {
  if (cartBusy) return;
  cartBusy = true; cartError = ''; openCart(opener);
  try { cart = await action(); }
  catch (error) {
    cartError = error.message || 'Cart update failed. Please try again.';
    try { cart = await commerce.getCart(); }
    catch { cart = { ...cart, checkoutUrl: null }; }
  }
  finally { cartBusy = false; syncCartCount(); if (cartIsOpen) openCart(); }
}

function bindCart() {
  document.querySelectorAll('[data-close-cart]').forEach(element => element.addEventListener('click', closeCart));
  document.querySelectorAll('[data-remove]').forEach(element => element.addEventListener('click', () => cartAction(() => commerce.removeProduct(element.dataset.remove))));
  document.querySelectorAll('[data-remove-line]').forEach(element => element.addEventListener('click', () => cartAction(() => commerce.removeLine(element.dataset.removeLine))));
  document.querySelectorAll('[data-add-service]').forEach(element => element.addEventListener('click', () => cartAction(() => commerce.addBreakIn(element.dataset.addService))));
  document.querySelectorAll('[data-remove-service]').forEach(element => element.addEventListener('click', () => cartAction(() => commerce.removeBreakIn(element.dataset.removeService))));
  document.querySelectorAll('[data-qty]').forEach(element => element.addEventListener('click', () => {
    const line = cart.lines.find(line => line.productId === element.dataset.qty && !line.isBreakIn);
    return cartAction(() => commerce.setQuantity(element.dataset.qty, (line?.quantity || 0) + Number(element.dataset.delta)));
  }));
  document.querySelectorAll('[data-qty-line]').forEach(element => element.addEventListener('click', () => {
    const line = cart.lines.find(line => line.remoteLineId === element.dataset.qtyLine && !line.isBreakIn);
    if (!line) return;
    return cartAction(() => commerce.setLineQuantity(line.remoteLineId, line.quantity + Number(element.dataset.delta)));
  }));
  document.querySelector('[data-checkout]')?.addEventListener('click', () => {
    if (!canCheckout()) return;
    try {
      const checkoutUrl = new URL(cart.checkoutUrl);
      if (checkoutUrl.protocol !== 'https:') throw new Error();
      window.location.assign(checkoutUrl.href);
    } catch {
      cartError = 'Shopify returned an invalid checkout link.'; openCart();
    }
  });
}

function bind() {
  document.querySelectorAll('[data-link]').forEach(element => element.addEventListener('click', event => {
    event.preventDefault();
    const fromMobileMenu = Boolean(element.closest('.mobile-nav'));
    const fromFooter = Boolean(element.closest('footer'));
    closeMobileMenu(); closeCart(); navigate(element.getAttribute('href'));
    if (fromMobileMenu || fromFooter) {
      const heading = document.querySelector('main h1');
      if (heading) { heading.tabIndex = -1; heading.focus(); }
    }
  }));
  const menuToggle = document.querySelector('.mobile-menu-toggle');
  menuToggle?.addEventListener('click', () => {
    const menu = document.querySelector('#mobile-menu');
    if (!menu.hidden) { closeMobileMenu(true); return; }
    menu.hidden = false;
    menuToggle.setAttribute('aria-expanded', 'true');
    menuToggle.setAttribute('aria-label', 'Close menu');
  });
  document.querySelectorAll('[data-cart]').forEach(element => element.addEventListener('click', () => {
    closeMobileMenu();
    openCart(element.closest('.mobile-nav') ? menuToggle : element);
  }));
  bindMobileGallery();
  const serviceCheckbox = document.querySelector('[data-break-in]');
  serviceCheckbox?.addEventListener('change', () => {
    const product = products.find(item => item.id === document.querySelector('[data-add]')?.dataset.add);
    const amount = document.querySelector('[data-add-price]');
    if (product && amount) amount.textContent = money(purchasePrice(product, breakInService, serviceCheckbox.checked), product.currencyCode);
    const serviceDelay = document.querySelector('[data-service-delay]');
    if (serviceDelay) serviceDelay.hidden = !serviceCheckbox.checked;
  });
  document.querySelectorAll('[data-add]').forEach(element => element.addEventListener('click', async () => {
    const includeBreakIn = document.querySelector('[data-break-in]')?.checked;
    await cartAction(() => commerce.addProduct(element.dataset.add, includeBreakIn), element);
  }));
  document.querySelectorAll('[data-image]').forEach(element => element.addEventListener('click', () => {
    lightboxReturnFocus = element;
    lightboxOverlay = document.createElement('div');
    lightboxOverlay.className = 'lightbox';
    lightboxOverlay.setAttribute('role', 'dialog');
    lightboxOverlay.setAttribute('aria-modal', 'true');
    lightboxOverlay.setAttribute('aria-label', 'Product image');
    lightboxOverlay.innerHTML = `<button aria-label="Close image">Close</button><img src="${element.dataset.image}" alt="Expanded product view">`;
    document.body.append(lightboxOverlay);
    document.body.classList.add('lightbox-open');
    app.inert = true;
    lightboxOverlay.addEventListener('click', closeLightbox);
    lightboxOverlay.querySelector('button').focus();
  }));
}

function closeLightbox() {
  if (!lightboxOverlay) return;
  lightboxOverlay.remove();
  lightboxOverlay = null;
  document.body.classList.remove('lightbox-open');
  app.inert = cartIsOpen;
  if (lightboxReturnFocus?.isConnected) lightboxReturnFocus.focus();
  lightboxReturnFocus = null;
}

async function boot() {
  render();
  try {
    products = await commerce.listProducts();
    [breakInService, cart] = await Promise.all([commerce.getBreakInService(), commerce.getCart()]);
  }
  catch (error) { commerceError = error.message || 'Unable to connect to Shopify.'; }
  finally { commerceLoading = false; render(); if (cartIsOpen) openCart(); }
}

document.addEventListener('keydown', event => {
  if (lightboxOverlay) {
    if (event.key === 'Escape') { event.preventDefault(); closeLightbox(); }
    else containTab(event, lightboxOverlay, document.activeElement);
  } else if (cartIsOpen) {
    if (event.key === 'Escape') { event.preventDefault(); closeCart(); }
    else containTab(event, document.querySelector('.cart-drawer'), document.activeElement);
  } else if (event.key === 'Escape') closeMobileMenu(true);
});
window.matchMedia('(min-width: 761px)').addEventListener('change', event => {
  if (event.matches) closeMobileMenu();
});
window.addEventListener('popstate', render);
window.addEventListener('resize', fitHeroHeading);
boot();
