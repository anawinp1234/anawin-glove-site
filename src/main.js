import './style.css';
import { breakInService as localBreakInService, localProducts } from './catalog.js';
import { createCommerce } from './commerce.js';

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

const money = (value, currency = 'USD') => new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value);
const escapeHtml = value => String(value).replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
const arrow = () => `<svg class="link-arrow" viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M2 10 10 2M4 2h6v6" /></svg>`;
const productLine = productId => cart.lines.find(line => line.productId === productId && !line.isBreakIn);
const serviceLine = productId => cart.lines.find(line => line.productId === productId && line.isBreakIn);
const cartCount = () => cart.lines.filter(line => !line.isBreakIn).reduce((sum, line) => sum + line.quantity, 0);
const canCheckout = () => commerce.mode === 'shopify' && Boolean(cart.checkoutUrl) && cart.lines.length > 0 && cart.lines.every(line => line.merchandiseId);

function header() {
  return `<header class="site-header">
    <a class="wordmark" href="/" data-link aria-label="ANAWIN home"><img src="/images/anawin-wordmark.png" alt="ANAWIN" /></a>
    <nav aria-label="Main navigation"><a href="/shop" data-link>Shop</a><a href="/about" data-link>About</a></nav>
    <button class="cart-trigger" data-cart aria-label="Open cart with ${cartCount()} items">Cart <span class="cart-count">(${String(cartCount()).padStart(2, '0')})</span></button>
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
    <div><p class="eyebrow">Connect</p><a href="mailto:ray@anawinofficial.com">ray@anawinofficial.com</a><a href="https://www.instagram.com/anawinofficial" target="_blank" rel="noreferrer">Instagram — @anawinofficial</a><a href="https://www.tiktok.com/@anawinofficial" target="_blank" rel="noreferrer">TikTok — @anawinofficial</a></div>
    <div><p class="eyebrow">Information</p><span>Shipping — Coming soon</span><span>Returns — Coming soon</span></div>
  </div><div class="legal"><span>© ${new Date().getFullYear()} ANAWIN</span><span>Baseball gloves</span></div></footer>`;
}

function productCard(product, index) {
  const availability = product.available ? '' : '<span class="sold-out">Sold out</span>';
  return `<article class="product-card reveal" style="--delay:${index * 80}ms">
    <a href="/product/${product.id}" data-link class="product-image"><span class="product-index">0${index + 1}</span><img src="${product.images[0]}" alt="${product.tone} ANAWIN glove" loading="${index ? 'lazy' : 'eager'}" /><span class="view-product">View ${arrow()}</span></a>
    <div class="product-meta"><div><h3>${escapeHtml(product.name)}</h3><p>${escapeHtml(product.tone)}</p>${availability}</div><strong>${money(product.price, product.currencyCode)}</strong></div>
  </article>`;
}

const productGrid = () => `<div class="product-grid">${products.map(productCard).join('')}</div>`;

function home() {
  return `<main><section class="hero"><img class="hero-background" src="/images/hero-background.jpg" alt="" /><div class="hero-copy"><p class="eyebrow">ANAWIN / 2026</p><h1>COMMUNITY<br><em>BUILT</em></h1></div><a href="/shop" data-link class="hero-cta">View all gloves ${arrow()}</a></section>
    <section class="collection"><div class="section-heading"><p class="eyebrow">Collection</p><h2>MINI<br><em>GLOVES</em></h2></div>${productGrid()}</section>
    <section class="statement"><p class="eyebrow">ANAWIN / Baseball gloves</p><div class="statement-mark"><img src="/images/anawin-mark.png" alt="ANAWIN emblem" /></div><a href="/about" data-link>About ANAWIN ${arrow()}</a></section></main>`;
}

const shop = () => `<main><section class="page-intro"><p class="eyebrow">Shop</p><h1>MINI<br><em>GLOVES</em></h1></section><section class="shop-products">${productGrid()}</section></main>`;

function productPage(product) {
  if (!product) return notFound();
  const unavailable = commerceLoading || Boolean(commerceError) || !product.available;
  const buttonLabel = commerceLoading ? 'Checking availability…' : product.available ? 'Add to cart' : 'Sold out';
  return `<main class="pdp"><section class="pdp-gallery">${product.images.map((src, i) => `<button class="gallery-image" data-image="${src}" aria-label="View image ${i + 1}"><img src="${src}" alt="${product.tone} glove view ${i + 1}" /></button>`).join('')}</section>
    <aside class="pdp-info"><p class="eyebrow">ANAWIN / ${escapeHtml(product.name)}</p><h1>${escapeHtml(product.name)}</h1><p class="tone">${escapeHtml(product.tone)}</p><p class="price">${money(product.price, product.currencyCode)}</p>
      <dl class="product-specs"><div><dt>Size</dt><dd>10.25 inches</dd></div><div><dt>Throwing hand</dt><dd>Right-hand throw only</dd></div><div><dt>Leather</dt><dd>US steerhide leather</dd></div><div><dt>Features</dt><dd>Double finger pad</dd></div><div><dt>Thumb</dt><dd>Sheepskin thumb sleeve</dd></div></dl>
      <label class="service-option"><input type="checkbox" data-break-in ${breakInService.available === false ? 'disabled' : ''}/><span><strong>Break-in service</strong><small>Optional glove break-in<br>${breakInService.copy}</small></span><b>+${money(breakInService.price, breakInService.currencyCode)}</b></label>
      <button class="add-button" data-add="${product.id}" ${unavailable ? 'disabled' : ''}>${buttonLabel} <span>${money(product.price, product.currencyCode)}</span></button>
      <details><summary>Product information <span>+</span></summary><p>Designed for baseball and softball players. Built for faster hands, cleaner transfers, and more consistent defensive work.</p></details>
      <details><summary>Shipping & returns <span>+</span></summary><p>Shipping and return policies will be published before checkout launches.</p></details>
    </aside></main>`;
}

function about() {
  return `<main><section class="about-hero"><p class="eyebrow">Company / ANAWIN</p><h1>ABOUT<br><em>ANAWIN.</em></h1><div class="about-image"><img src="/images/cherry_pink.png" alt="Cherry-pink ANAWIN glove among flowers" /></div></section>
    <section class="origin"><p class="eyebrow">Company</p><div><h2>HOW IT STARTED</h2><p>ANAWIN started with two best friends, over 10 years of friendship, and a shared love for baseball.</p><p>We created ANAWIN with a simple goal: bring more energy and attention back to the game we grew up loving. From the beginning, authenticity has been at the center of what we do. We shared the process, listened to feedback, and let the baseball community help shape what we were building.</p><p>ANAWIN was not just built for the baseball community. It was built with them.</p></div></section>
    <section class="founders founders-editorial" aria-labelledby="founders-heading">
      <div class="founders-heading"><p class="eyebrow">ANAWIN / Co-founders</p><h2 id="founders-heading"><em>FOUNDERS</em></h2></div>
      <div class="founders-layout">
        <article class="founder-profile" aria-labelledby="founder-ray">
          <div class="founder-portrait"><img src="/images/ray_headshot.png" alt="Ray Lopez, co-founder of ANAWIN" loading="lazy" /></div>
          <div class="founder-details"><p class="founder-role">CO-FOUNDER</p><h3 id="founder-ray">RAY LOPEZ</h3><div class="founder-bio"><p>Growing up with a father who played professional baseball, Ray developed a love for the game that eventually led him to start ANAWIN.</p><ul><li>Finance and Sports Business student at Arizona State University</li><li>Former Finance Intern with the Arizona Diamondbacks</li><li>Building ANAWIN alongside the baseball community, with their ideas helping shape each product</li></ul></div></div>
        </article>
        <article class="founder-profile" aria-labelledby="founder-anawin">
          <div class="founder-portrait"><img src="/images/anawin_headshot-gray.png" alt="Anawin Pikulthong, co-founder of ANAWIN" loading="lazy" /></div>
          <div class="founder-details"><p class="founder-role">CO-FOUNDER</p><h3 id="founder-anawin">ANAWIN PIKULTHONG</h3><div class="founder-bio"><p>With a background in competitive golf, Anawin brings a mix of athlete experience and a passion for equipment to building ANAWIN.</p><ul><li>Data Science student at Arizona State University</li><li>Former Marketing Analytics Intern at TaylorMade Golf</li><li>Former Division 1 Golfer at Arizona State University</li></ul></div></div>
        </article>
      </div>
    </section>
    <section class="philosophy"><p class="eyebrow">ANAWIN</p><h2>OUR STORY</h2><div class="story-copy"><p>We met in sixth grade and have been close ever since. Over the years, we have spent countless hours playing catch, throwing sliders into the dirt, talking baseball, and competing over just about everything.</p><p>Baseball has always been part of our friendship, so building ANAWIN felt natural. We wanted to create something that reflected the way we actually grew up around the game: competitive, creative, and authentic.</p><p>What started as an idea between two friends became a brand shaped by the same baseball community we have always been part of.</p></div></section></main>`;
}

const notFound = () => `<main class="not-found"><p class="eyebrow">Error / 404</p><h1>PAGE NOT<br><em>FOUND.</em></h1><a href="/" data-link>Return home ${arrow()}</a></main>`;

function cartDrawer() {
  const productItems = products.filter(product => productLine(product.id));
  const checkout = canCheckout()
    ? `<button data-checkout ${cartBusy ? 'disabled' : ''}>Checkout securely</button>`
    : `<button disabled>Checkout coming soon</button><small>${commerce.mode === 'local' ? 'Connect Shopify to enable secure checkout.' : 'Checkout is unavailable until Shopify returns a verified cart.'}</small>`;
  return `<div class="cart-backdrop" data-close-cart></div><aside class="cart-drawer" aria-label="Shopping cart"><div class="cart-head"><h2>Your cart</h2><button data-close-cart aria-label="Close cart">Close</button></div>
    <div class="cart-body">${productItems.length ? productItems.map(product => {
      const line = productLine(product.id); const service = serviceLine(product.id);
      return `<article class="cart-item"><img src="${product.images[0]}" alt=""><div><h3>${escapeHtml(product.name)}</h3><p>${escapeHtml(product.tone)}</p><p>${money(product.price, product.currencyCode)}</p>${service ? `<p class="cart-service">Break-in service · ${money(breakInService.price, breakInService.currencyCode)}</p>` : ''}<div class="quantity"><button data-qty="${product.id}" data-delta="-1" aria-label="Decrease quantity" ${cartBusy ? 'disabled' : ''}>−</button><span>${line.quantity}</span><button data-qty="${product.id}" data-delta="1" aria-label="Increase quantity" ${cartBusy ? 'disabled' : ''}>+</button></div></div><button class="remove" data-remove="${product.id}" ${cartBusy ? 'disabled' : ''}>Remove</button></article>`;
    }).join('') : `<div class="empty-cart"><p>Your cart is empty.</p><a href="/shop" data-link data-close-cart>Shop gloves ${arrow()}</a></div>`}</div>
    ${productItems.length ? `<div class="cart-foot"><div><span>Subtotal</span><strong>${money(cart.subtotal, cart.currencyCode)}</strong></div><p>Taxes and shipping calculated at checkout.</p>${cartError ? `<p class="cart-error" role="alert">${escapeHtml(cartError)}</p>` : ''}${checkout}</div>` : ''}</aside>`;
}

function route() {
  const path = location.pathname.replace(/\/$/, '') || '/';
  if (path === '/') return home();
  if (path === '/shop') return shop();
  if (path === '/about') return about();
  if (path.startsWith('/product/')) return productPage(products.find(product => product.id === path.split('/')[2]));
  return notFound();
}

function render() { app.innerHTML = header() + commerceNotice() + route() + footer(); bind(); window.scrollTo(0, 0); }
function navigate(path) { history.pushState({}, '', path); render(); }
function openCart() {
  document.querySelector('.cart-drawer')?.remove(); document.querySelector('.cart-backdrop')?.remove();
  document.body.insertAdjacentHTML('beforeend', cartDrawer()); requestAnimationFrame(() => document.body.classList.add('cart-open')); bindCart();
}
function closeCart() {
  document.body.classList.remove('cart-open');
  setTimeout(() => { document.querySelector('.cart-drawer')?.remove(); document.querySelector('.cart-backdrop')?.remove(); }, 300);
}
function syncCartCount() { document.querySelectorAll('.cart-count').forEach(node => { node.textContent = `(${String(cartCount()).padStart(2, '0')})`; }); }
async function cartAction(action) {
  if (cartBusy) return;
  cartBusy = true; cartError = ''; openCart();
  try { cart = await action(); }
  catch (error) { cartError = error.message || 'Cart update failed. Please try again.'; }
  finally { cartBusy = false; syncCartCount(); openCart(); }
}

function bindCart() {
  document.querySelectorAll('[data-close-cart]').forEach(element => element.addEventListener('click', closeCart));
  document.querySelectorAll('[data-remove]').forEach(element => element.addEventListener('click', () => cartAction(() => commerce.removeProduct(element.dataset.remove))));
  document.querySelectorAll('[data-qty]').forEach(element => element.addEventListener('click', () => {
    const line = productLine(element.dataset.qty);
    return cartAction(() => commerce.setQuantity(element.dataset.qty, (line?.quantity || 0) + Number(element.dataset.delta)));
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
  document.querySelectorAll('[data-link]').forEach(element => element.addEventListener('click', event => { event.preventDefault(); closeCart(); navigate(element.getAttribute('href')); }));
  document.querySelector('[data-cart]')?.addEventListener('click', openCart);
  document.querySelectorAll('[data-add]').forEach(element => element.addEventListener('click', async () => {
    const includeBreakIn = document.querySelector('[data-break-in]')?.checked;
    await cartAction(() => commerce.addProduct(element.dataset.add, includeBreakIn));
  }));
  document.querySelectorAll('[data-image]').forEach(element => element.addEventListener('click', () => {
    const overlay = document.createElement('div'); overlay.className = 'lightbox';
    overlay.innerHTML = `<button aria-label="Close image">Close</button><img src="${element.dataset.image}" alt="Expanded product view">`;
    document.body.append(overlay); overlay.addEventListener('click', () => overlay.remove());
  }));
}

async function boot() {
  render();
  try {
    products = await commerce.listProducts();
    [breakInService, cart] = await Promise.all([commerce.getBreakInService(), commerce.getCart()]);
  }
  catch (error) { commerceError = error.message || 'Unable to connect to Shopify.'; }
  finally { commerceLoading = false; render(); }
}

window.addEventListener('popstate', render);
boot();
