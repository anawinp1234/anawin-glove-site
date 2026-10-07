import './style.css';
import { breakInService as localBreakInService, localProducts, purchasePrice } from './catalog.js';
import { createStorefrontRenderer, newsletterPopupMarkup, money, escapeHtml, arrow } from './storefront-render.js';
import { createCommerce } from './commerce.js';
import { renderCartRow } from './cart-row.js';
import { codeKey, renderCartDiscountSection } from './cart-discounts.js';
import { containTab } from './dialog.js';
import { updateSeo, productPath } from './seo.js';
import { createNewsletterSignup } from './newsletter.js';
import { bindNewsletterForm } from './newsletter-form.js';
import { createNewsletterPopupController, installNewsletterDialog } from './newsletter-popup.js';
import { createJudgeMeService, shopifyProductId } from './judgeme.js';
import { productReviewLinks } from './review-links.js';

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
const mobileProductQuery = window.matchMedia('(max-width: 760px)');
const mobileProductOrder = ['blue', 'brown', 'black'];
let breakInService = localBreakInService;
let cart = { id: null, lines: [], subtotal: 0, currencyCode: 'USD', checkoutUrl: null };
let commerceLoading = commerce.mode === 'shopify';
let cartBusy = false;
let cartError = '';
let discountInput = '';
let discountBusy = false;
let discountMessage = '';
let discountError = false;
let cartIsOpen = false;
let cartReturnFocus = null;
let cartCloseTimer = null;
let lightboxOverlay = null;
let lightboxReturnFocus = null;
const newsletterSignup = createNewsletterSignup();
let newsletterPopup = null;
let newsletterDialog = null;
let newsletterPopupUi = null;
const judgeMePublicToken = import.meta.env.VITE_JUDGEME_PUBLIC_TOKEN || '';
let judgeMeReviewLinks = productReviewLinks(products);
const reviewService = createJudgeMeService({ publicToken: judgeMePublicToken });
const reviewData = Object.fromEntries(localProducts.map(product => {
  const handle = product.name.toLowerCase();
  return [handle, { status: judgeMePublicToken && commerce.mode === 'shopify' ? 'loading' : 'unavailable', writeReviewUrl: judgeMeReviewLinks[handle] }];
}));

const cartCount = () => cart.lines.filter(line => !line.isBreakIn).reduce((sum, line) => sum + line.quantity, 0);
const canCheckout = () => commerce.mode === 'shopify' && Boolean(cart.checkoutUrl) && !cart.incomplete && cart.lines.length > 0 && cart.lines.every(line => {
  if (!line.merchandiseId) return false;
  if (!line.isBreakIn) return true;
  const parent = cart.lines.find(candidate => candidate.remoteLineId === line.parentLineId && !candidate.isBreakIn);
  return parent?.productId === line.productId && parent.quantity === line.quantity;
});

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
    ${productItems.length ? `<div class="cart-foot">${renderCartDiscountSection(cart, commerce.mode, { busy: discountBusy, input: discountInput, message: discountMessage, error: discountError }, money, escapeHtml)}<p>Free U.S. standard shipping. Shipping options and rates are shown at checkout. Taxes are calculated at checkout.</p>${cartError ? `<p class="cart-error" role="alert">${escapeHtml(cartError)}</p>` : ''}${checkout}</div>` : ''}</aside>`;
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

function syncProductDisplayOrder() {
  const order = mobileProductQuery.matches ? mobileProductOrder : products.map(product => product.id);
  document.querySelectorAll('.product-grid, .model-switcher-options, .other-gloves-grid').forEach(container => {
    const nodes = [...container.children];
    const sorted = [...nodes].sort((first, second) => order.indexOf(first.dataset.product) - order.indexOf(second.dataset.product));
    if (sorted.some((node, index) => node !== nodes[index])) {
      const focused = container.contains(document.activeElement) ? document.activeElement : null;
      container.append(...sorted);
      focused?.focus({ preventScroll: true });
    }
    if (container.classList.contains('product-grid')) {
      sorted.forEach((card, index) => {
        card.style.setProperty('--delay', `${index * 80}ms`);
        if (container.closest('.shop-products')) card.querySelector('img').loading = index === 0 ? 'eager' : 'lazy';
      });
    }
  });
}

function render() {
  const views = createStorefrontRenderer({ products, breakInService, commerceLoading, commerceError, cartCount, reviewData });
  updateSeo(document, location.pathname);
  app.innerHTML = views.header() + views.commerceNotice() + views.route(location.pathname) + views.footer();
  syncProductDisplayOrder();
  fitHeroHeading(); bind(); window.scrollTo(0, 0);
}
function refreshReviewMarkup() {
  const views = createStorefrontRenderer({ products, breakInService, reviewData });
  for (const slot of document.querySelectorAll('[data-review-slot]')) {
    const product = products.find(item => item.name.toLowerCase() === slot.dataset.reviewSlot);
    if (!product) continue;
    slot.innerHTML = views.productCardRatingMarkup(product);
    slot.classList.toggle('review-slot-loading', reviewData[slot.dataset.reviewSlot]?.status === 'loading');
  }
  const section = document.querySelector('[data-review-product]');
  if (section) {
    const product = products.find(item => item.name.toLowerCase() === section.dataset.reviewProduct);
    if (product) section.outerHTML = views.productReviewsSection(product);
  }
}
function loadReviews() {
  if (commerce.mode !== 'shopify' || !judgeMePublicToken) return;
  const currentProduct = products.find(product => productPath(product) === location.pathname);
  const widgetId = currentProduct && shopifyProductId(currentProduct.shopifyProductGid);
  if (!products.some(product => shopifyProductId(product.shopifyProductGid))) return;
  void reviewService.load(products, widgetId).then(result => {
    for (const product of products) {
      const handle = product.name.toLowerCase();
      const next = result.products[handle] || { status: 'unavailable' };
      if (reviewData[handle]?.status === 'ready' && next.status === 'unavailable') continue;
      if (reviewData[handle]?.hasWidget && !next.hasWidget && next.status === 'ready') continue;
      reviewData[handle] = { ...next, writeReviewUrl: judgeMeReviewLinks[handle] || next.writeReviewUrl };
    }
    refreshReviewMarkup();
  }).catch(() => {
    for (const product of products) {
      const handle = product.name.toLowerCase();
      reviewData[handle] = { status: 'unavailable', writeReviewUrl: judgeMeReviewLinks[handle] };
    }
    refreshReviewMarkup();
  });
}
function handleNewsletterResult(result) {
  newsletterPopupUi?.accept();
  if (result.status === 'success') newsletterPopup?.subscribe();
  if (result.status === 'pending') newsletterPopup?.pending();
}

function setupNewsletterPopup() {
  document.body.insertAdjacentHTML('beforeend', newsletterPopupMarkup());
  newsletterDialog = document.querySelector('.newsletter-dialog');
  newsletterPopup = createNewsletterPopupController({ onOpen: () => newsletterPopupUi.open() });
  newsletterPopupUi = installNewsletterDialog({
    dialog: newsletterDialog,
    closeButton: newsletterDialog.querySelector('[data-newsletter-close]'),
    documentRef: document,
    canOpen: () => {
      const inline = document.querySelector('.newsletter')?.getBoundingClientRect();
      const inlineVisible = inline && inline.top < window.innerHeight && inline.bottom > 0;
      return !document.hidden && !cartIsOpen && !lightboxOverlay && !inlineVisible && !document.activeElement?.closest('[data-newsletter-form]');
    },
    onDismiss: () => newsletterPopup.dismiss(),
    fallbackFocus: () => document.querySelector('.cart-trigger')
  });
  bindNewsletterForm(newsletterDialog.querySelector('[data-newsletter-form]'), newsletterSignup, handleNewsletterResult);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) newsletterPopup.schedule(); });
  newsletterPopup.schedule();
}
function navigate(path) { history.pushState({}, '', path); render(); loadReviews(); }
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
  closeInfoMenus();
  menu.hidden = true;
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-label', 'Open menu');
  if (returnFocus) toggle.focus();
}

function closeInfoMenus(returnFocus = false) {
  const menus = [...document.querySelectorAll('.header-info[open]')];
  menus.forEach(menu => { menu.open = false; });
  if (returnFocus) menus.at(-1)?.querySelector('summary')?.focus();
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

async function discountAction(action, code = '', removingCode = '') {
  if (cartBusy || discountBusy) return;
  cartBusy = true;
  discountBusy = true;
  discountMessage = '';
  discountError = false;
  openCart();
  try {
    cart = await action();
    if (code) {
      const applied = cart.discountCodes?.find(item => codeKey(item.code) === codeKey(code))?.applicable === true;
      if (applied) {
        discountInput = '';
        discountMessage = `${code} applied.`;
      }
      else {
        discountMessage = 'Discount code isn’t valid for this cart.';
        discountError = true;
      }
    }
    if (removingCode) {
      if (cart.discountCodes?.some(item => codeKey(item.code) === codeKey(removingCode))) {
        discountMessage = 'The discount code could not be removed. Please try again.';
        discountError = true;
      } else discountMessage = 'Discount code removed.';
    }
    if (!discountError && cart.discountWarnings?.length) discountMessage = [discountMessage, ...cart.discountWarnings].filter(Boolean).join(' ');
  } catch (error) {
    discountMessage = error.message || 'Discount update failed. Please try again.';
    discountError = true;
    try { cart = await commerce.getCart(); }
    catch { cart = { ...cart, checkoutUrl: null }; }
  } finally {
    discountBusy = false;
    cartBusy = false;
    syncCartCount();
    if (cartIsOpen) {
      openCart();
      document.querySelector('#cart-discount-input')?.focus();
    }
  }
}

function bindCart() {
  const discountForm = document.querySelector('[data-discount-form]');
  discountForm?.querySelector('input')?.addEventListener('input', event => {
    discountInput = event.target.value;
    const message = document.querySelector('#cart-discount-message');
    if (message) message.textContent = '';
    discountMessage = '';
    discountError = false;
  });
  discountForm?.addEventListener('submit', event => {
    event.preventDefault();
    const code = discountInput.trim();
    if (!code) {
      discountMessage = 'Enter a discount code.';
      discountError = true;
      openCart();
      document.querySelector('#cart-discount-input')?.focus();
      return;
    }
    discountAction(() => commerce.applyDiscountCode(code), code);
  });
  document.querySelectorAll('[data-remove-discount]').forEach(button => button.addEventListener('click', () =>
    discountAction(() => commerce.removeDiscountCode(button.dataset.removeDiscount), '', button.dataset.removeDiscount)));
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
  const newsletterForm = app.querySelector('.newsletter [data-newsletter-form]');
  if (newsletterForm) bindNewsletterForm(newsletterForm, newsletterSignup, handleNewsletterResult);
  document.querySelectorAll('[data-link]').forEach(element => element.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
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
  setupNewsletterPopup();
  try {
    products = await commerce.listProducts();
    judgeMeReviewLinks = productReviewLinks(products);
    for (const product of products) {
      const handle = product.name.toLowerCase();
      reviewData[handle] = { ...reviewData[handle], writeReviewUrl: judgeMeReviewLinks[handle] };
    }
    loadReviews();
    [breakInService, cart] = await Promise.all([commerce.getBreakInService(), commerce.getCart()]);
  }
  catch (error) {
    commerceError = error.message || 'Unable to connect to Shopify.';
    for (const product of products) reviewData[product.name.toLowerCase()] = { status: 'unavailable' };
  }
  finally { commerceLoading = false; render(); if (cartIsOpen) openCart(); }
}

document.addEventListener('keydown', event => {
  if (newsletterDialog?.open) return;
  if (lightboxOverlay) {
    if (event.key === 'Escape') { event.preventDefault(); closeLightbox(); }
    else containTab(event, lightboxOverlay, document.activeElement);
  } else if (cartIsOpen) {
    if (event.key === 'Escape') { event.preventDefault(); closeCart(); }
    else containTab(event, document.querySelector('.cart-drawer'), document.activeElement);
  } else if (event.key === 'Escape') {
    if (document.querySelector('.header-info[open]')) closeInfoMenus(true);
    else closeMobileMenu(true);
  }
});
document.addEventListener('click', event => {
  document.querySelectorAll('.header-info[open]').forEach(menu => {
    if (!menu.contains(event.target)) menu.open = false;
  });
});
window.matchMedia('(min-width: 761px)').addEventListener('change', event => {
  if (event.matches) closeMobileMenu();
});
mobileProductQuery.addEventListener('change', syncProductDisplayOrder);
window.addEventListener('popstate', () => { render(); loadReviews(); });
window.addEventListener('resize', fitHeroHeading);
boot();
