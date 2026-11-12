import './style.css';
import { breakInService as localBreakInService, localProducts, FULL_SIZE_SHAPING_FIELDS, fullSizeBreakInService, normalizeFullSizeOptions, purchasePrice } from './catalog.js';
import { createStorefrontRenderer, installFooterAccordion, newsletterPopupMarkup, money, cartMoney, escapeHtml, arrow } from './storefront-render.js';
import { createCommerce, commerceErrorMessage } from './commerce.js';
import { bindCartImageFallbacks, renderCartRow } from './cart-row.js';
import { cartFeedbackMarkup } from './cart-feedback.js';
import { createCartActionGate } from './cart-action-gate.js';
import { createCartStateTracker, startStartupCartRestore } from './startup-cart.js';
import { checkoutCartIsComplete, createCheckoutVerifier, isCartStorageKey, redirectToVerifiedCheckout } from './checkout-safety.js';
import { nextHeaderHidden } from './header-scroll.js';
import { focusCommerceRetryStatus, focusCommerceRetryResult } from './retry-focus.js';
import { codeKey, renderCartDiscountSection } from './cart-discounts.js';
import { containTab } from './dialog.js';
import { loadZoomImage } from './zoom-image.js';
import { lightboxCounter, stepLightboxIndex } from './lightbox-nav.js';
import { updateSeo, productPath } from './seo.js';
import { createNewsletterSignup } from './newsletter.js';
import { bindNewsletterForm } from './newsletter-form.js';
import { createNewsletterPopupController, installNewsletterDialog } from './newsletter-popup.js';
import { createJudgeMeService, shopifyProductId } from './judgeme.js';
import { productReviewLinks } from './review-links.js';
import { createStickyPurchase } from './sticky-purchase.js';
import { restoreFocusWithVisibleFallback } from './cart-focus.js';
import { installScrollMemory, scrollToInstant } from './scroll-memory.js';

// Errors belong to the native controls so screen readers announce them on focus.
function clearFullSizeFieldErrors(root, name = null) {
  root.querySelectorAll('[data-full-size-field-error]').forEach(error => {
    const field = error.dataset.fullSizeFieldError;
    if (name && field !== name) return;
    error.hidden = true;
    error.textContent = '';
    root.querySelectorAll(`[name="${field}"]`).forEach(input => {
      input.removeAttribute('aria-invalid');
      const descriptions = (input.getAttribute('aria-describedby') || '').split(/\s+/).filter(id => id && id !== error.id);
      if (descriptions.length) input.setAttribute('aria-describedby', descriptions.join(' '));
      else input.removeAttribute('aria-describedby');
    });
  });
}

function showFullSizeFieldError(root, failure) {
  if (!failure.field) return false;
  const inputs = [...root.querySelectorAll(`[name="${failure.field}"]`)];
  const error = root.querySelector(`[data-full-size-field-error="${failure.field}"]`);
  if (!error || !inputs.length) return false;
  error.hidden = false;
  error.textContent = failure.message;
  inputs.forEach(input => {
    input.setAttribute('aria-invalid', 'true');
    const descriptions = new Set((input.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
    descriptions.add(error.id);
    input.setAttribute('aria-describedby', [...descriptions].join(' '));
  });
  inputs[0].focus();
  return true;
}

const app = document.querySelector('#app');
let destroyFooterAccordion = () => {};
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
let fullSizeService = { ...fullSizeBreakInService, available: false };
let cart = { id: null, lines: [], subtotal: 0, currencyCode: 'USD', checkoutUrl: null };
let commerceLoading = commerce.mode === 'shopify';
let cartBusy = false;
let checkoutBusy = false;
let checkoutNeedsReview = false;
let headerHidden = false;
let lastHeaderScrollY = window.scrollY;
const scrollMemory = installScrollMemory(window, top => { render(top); loadReviews(); });
const runCartAction = createCartActionGate();
const cartState = createCartStateTracker(() => commerce.readCartSafety?.());
const verifyCheckout = commerce.mode === 'shopify'
  ? createCheckoutVerifier({ getCart: () => commerce.getCart(), readSafety: () => commerce.readCartSafety() }) : null;
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
let lightboxImageController = null;
let lightboxGallery = [];
let lightboxIndex = 0;
const newsletterSignup = createNewsletterSignup();
let newsletterPopup = null;
let newsletterDialog = null;
let newsletterPopupUi = null;
let stickyPurchase = null;
const judgeMePublicToken = import.meta.env.VITE_JUDGEME_PUBLIC_TOKEN || '';
let judgeMeReviewLinks = productReviewLinks(products);
const reviewService = createJudgeMeService({ publicToken: judgeMePublicToken });
const reviewData = Object.fromEntries(localProducts.map(product => {
  const handle = product.name.toLowerCase();
  return [handle, { status: judgeMePublicToken && commerce.mode === 'shopify' ? 'loading' : 'unavailable', writeReviewUrl: judgeMeReviewLinks[handle] }];
}));

const cartCount = () => cart.lines.filter(line => !line.isBreakIn).reduce((sum, line) => sum + line.quantity, 0);
const canCheckout = () => commerce.mode === 'shopify' && checkoutCartIsComplete(cart);

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
    ? `<button data-checkout ${cartBusy || checkoutBusy ? 'disabled' : ''}>${checkoutBusy ? 'Checking cart…' : 'Checkout securely'}</button><p class="checkout-status" role="status" aria-live="polite">${checkoutBusy ? 'Checking your cart with Shopify…' : ''}</p>`
    : `<button disabled>${commerce.mode === 'local' ? 'Checkout coming soon' : 'Checkout unavailable'}</button><small>${commerce.mode === 'local' ? 'Connect Shopify to enable secure checkout.' : 'Checkout is unavailable until Shopify returns a verified cart.'}</small>`;
  const cartFeedback = cartFeedbackMarkup({ error: cartError, incomplete: cart.incomplete,
    recoveryAvailable: cart.recoveryAvailable, recoveryHasBreakIn: cart.recoveryHasBreakIn,
    gloveOnlyRecoveryAvailable: cart.gloveOnlyRecoveryAvailable,
    busy: cartBusy, mode: commerce.mode }, escapeHtml);
  return `<div class="cart-backdrop" data-close-cart aria-hidden="true"></div><aside class="cart-drawer" role="dialog" aria-modal="true" aria-labelledby="cart-heading"><div class="cart-head"><h2 id="cart-heading">Your cart</h2><button data-close-cart aria-label="Close cart">Close</button></div>
    ${cartFeedback}
    <div class="cart-body">${productItems.length ? productItems.map(({ product, line, service }) => renderCartRow({
      product, line, service, mode: commerce.mode, serviceProduct: product.line === 'full-size' ? fullSizeBreakInService : breakInService,
      busy: cartBusy, incomplete: cart.incomplete, money: cartMoney, escapeHtml
    })).join('') : `<div class="empty-cart"><p>Your cart is empty.</p><a href="/shop" data-link data-close-cart>Shop gloves ${arrow()}</a></div>`}</div>
    ${productItems.length ? `<div class="cart-foot">${renderCartDiscountSection(cart, commerce.mode, { busy: discountBusy, input: discountInput, message: discountMessage, error: discountError }, cartMoney, escapeHtml)}<p>Free U.S. standard shipping. Shipping options and rates are shown at checkout. Taxes are calculated at checkout.</p>${checkout}</div>` : ''}</aside>`;
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

// Navigation passes the scroll position to show; data refreshes keep the shopper where they are.
function render(scrollTop = window.scrollY) {
  stickyPurchase?.destroy();
  stickyPurchase = null;
  const views = createStorefrontRenderer({ products, breakInService, fullSizeService, commerceLoading, commerceError, commerceRetry: commerce.mode === 'shopify', cartCount, reviewData });
  updateSeo(document, location.pathname);
  destroyFooterAccordion();
  app.innerHTML = views.header() + views.commerceNotice() + views.route(location.pathname) + views.footer();
  destroyFooterAccordion = installFooterAccordion(app.querySelector('footer'));
  headerHidden = false;
  document.querySelector('.site-header-stack')?.classList.remove('is-hidden');
  syncProductDisplayOrder();
  fitHeroHeading(); bind(); scrollToInstant(window, scrollTop);
  stickyPurchase = createStickyPurchase({
    bar: document.querySelector('[data-sticky-purchase]'),
    original: document.querySelector('[data-add]'),
    purchaseArea: document.querySelector('.pdp-main'),
    nav: document.querySelector('#mobile-menu'),
    blocked: () => cartIsOpen || cartBusy,
    onActivate: (trigger, source) => addProductFromButton(source.dataset.add, trigger)
  });
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
  if (result.status === 'accepted') newsletterPopup?.pending();
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
      const inline = document.querySelector('.newsletter, .pdp-notify')?.getBoundingClientRect();
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
function navigate(path) {
  scrollMemory.navigate(path);
}
function openCart(opener = null) {
  if (!cartIsOpen) cartReturnFocus = opener || document.activeElement;
  cartIsOpen = true;
  stickyPurchase?.refresh();
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
  stickyPurchase?.refresh();
  const opener = cartReturnFocus;
  cartReturnFocus = null;
  const heading = document.querySelector('main h1');
  if (heading) heading.tabIndex = -1;
  const cartTrigger = document.querySelector('.cart-trigger');
  const menuToggle = document.querySelector('.mobile-menu-toggle');
  restoreFocusWithVisibleFallback([opener, stickyPurchase?.button, document.querySelector('[data-add]'), cartTrigger, menuToggle, heading],
    [cartTrigger, menuToggle, heading], () => {
      headerHidden = false;
      document.querySelector('.site-header-stack')?.classList.remove('is-hidden');
    });
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
async function cartAction(action, opener = null, kind = 'cart') {
  if (cartBusy || checkoutBusy) return;
  return runCartAction(async () => {
    cartState.localChange();
    cartBusy = true; cartError = ''; openCart(opener);
    try {
      cart = await action();
      if (cart.incomplete) cartError = 'We could not confirm your cart update. Check your cart before continuing.';
      else if (kind === 'recovery') {
        checkoutNeedsReview = true;
        cartError = 'Review the items in your new cart before checkout.';
      }
    }
    catch (error) {
      cartError = commerceErrorMessage(error, kind);
      try { cart = await commerce.getCart(); }
      catch { cart = { ...cart, checkoutUrl: null }; }
    }
    finally { cartBusy = false; syncCartCount(); if (cartIsOpen) openCart(); }
  });
}

function addProductFromButton(productId, trigger) {
  const product = products.find(product => product.id === productId);
  if (product?.line === 'full-size') {
    const selected = name => document.querySelector(`input[name="${name}"]:checked`)?.value;
    const includeBreakIn = Boolean(document.querySelector('[data-full-size-break-in]')?.checked);
    const hand = selected('full-size-throw-hand');
    const variant = product.variants?.find(variant => variant.selectedOptions?.some(option =>
      option.name === 'Throwing Hand' && hand?.startsWith(`${option.value}-Hand Throw`)) ||
      product.throwHands.length === 1 && hand && variant.selectedOptions?.some(option => option.name === 'Title' && option.value === 'Default Title'));
    const error = document.querySelector('[data-full-size-error]');
    clearFullSizeFieldErrors(document);
    let options;
    try {
      if (!variant?.availableForSale) throw Object.assign(new Error('Choose an available throw hand.'), { field: 'full-size-throw-hand' });
      if (includeBreakIn) options = normalizeFullSizeOptions({ type: 'full-size',
        wearingStyle: selected('full-size-wearing-style'), closure: selected('full-size-closure-point'),
        ...Object.fromEntries(FULL_SIZE_SHAPING_FIELDS.map(field => [field.key, selected(field.name)])),
        firmness: selected('full-size-firmness'), placement: document.querySelector('#full-size-finger-placement')?.value,
        notes: document.querySelector('#full-size-break-in-notes')?.value });
    } catch (failure) {
      if (!showFullSizeFieldError(document, failure) && error) { error.hidden = false; error.textContent = failure.message; error.focus(); }
      return;
    }
    if (error) { error.hidden = true; error.textContent = ''; }
    return cartAction(() => commerce.addProduct(productId, includeBreakIn, options, variant.id), trigger, 'add');
  }
  const includeBreakIn = document.querySelector('[data-break-in]')?.checked;
  const options = includeBreakIn ? {
    level: document.querySelector('input[name="break-in-level"]:checked')?.value,
    wearingStyle: document.querySelector('input[name="glove-wearing-style"]:checked')?.value
  } : undefined;
  return cartAction(() => commerce.addProduct(productId, includeBreakIn, options), trigger, 'add');
}

async function discountAction(action, code = '', removingCode = '') {
  if (cartBusy || discountBusy || checkoutBusy) return;
  cartState.localChange();
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
    discountMessage = commerceErrorMessage(error, 'cart');
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
  bindCartImageFallbacks(document.querySelector('.cart-drawer'));
  document.querySelector('[data-refresh-cart]')?.addEventListener('click', () => cartAction(() => commerce.refreshCart()));
  document.querySelector('[data-recover-cart]')?.addEventListener('click', () => cartAction(() => commerce.recoverCart(), null, 'recovery'));
  document.querySelector('[data-recover-without-service]')?.addEventListener('click', () =>
    cartAction(() => commerce.recoverCart({ withoutBreakIn: true }), null, 'recovery'));
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
  document.querySelector('[data-checkout]')?.addEventListener('click', async () => {
    if (checkoutBusy || cartBusy || !canCheckout()) return;
    cartState.localChange();
    checkoutBusy = true;
    const button = document.querySelector('[data-checkout]');
    button.disabled = true;
    button.textContent = 'Checking cart…';
    button.setAttribute('aria-busy', 'true');
    const status = document.querySelector('.checkout-status');
    if (status) status.textContent = 'Checking your cart with Shopify…';
    const result = await verifyCheckout(cart, { requireReview: checkoutNeedsReview });
    checkoutBusy = false;
    if (result.status === 'ready') {
      const safety = commerce.readCartSafety();
      if (safety.id === result.cart.id && safety.revision === result.revision &&
        safety.unsafeId !== safety.id && safety.pendingCartId !== safety.id) {
        try {
          if (!redirectToVerifiedCheckout(result.checkoutUrl, url => window.location.assign(url))) throw new Error();
          return;
        } catch { cartError = 'We couldn’t open secure checkout. Check your cart and try again.'; }
      } else cartError = 'Your cart changed in another tab. Check your cart before checkout.';
      cart = { ...cart, checkoutUrl: null };
    } else {
      if (result.cart) cart = result.cart;
      else cart = { ...cart, checkoutUrl: null };
      checkoutNeedsReview = result.status === 'review' ? false : checkoutNeedsReview;
      cartError = result.message || 'Couldn’t check your cart. Check your cart and try again.';
    }
    syncCartCount();
    openCart();
    const next = document.querySelector(result.status === 'review' ? '[data-checkout]' : '[data-refresh-cart]');
    if (next && !next.disabled) next.focus();
  });
}

function bind() {
  document.querySelector('[data-skip-link]')?.addEventListener('click', event => {
    event.preventDefault();
    document.querySelector('#main-content')?.focus();
  });
  app.querySelectorAll(':is(.newsletter, .pdp-notify) [data-newsletter-form]')
    .forEach(form => bindNewsletterForm(form, newsletterSignup, handleNewsletterResult));
  document.querySelectorAll('[data-link]').forEach(element => element.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const fromMobileMenu = Boolean(element.closest('.mobile-nav'));
    const fromFooter = Boolean(element.closest('footer'));
    const fromProductSwitcher = Boolean(element.closest('.model-switcher'));
    closeMobileMenu(); closeCart(); navigate(element.getAttribute('href'));
    if (fromMobileMenu || fromFooter || fromProductSwitcher) {
      const heading = document.querySelector('main h1');
      if (heading) { heading.tabIndex = -1; heading.focus(); }
    }
  }));
  document.querySelector('[data-retry-commerce]')?.addEventListener('click', async () => {
    const pending = loadCommerce();
    focusCommerceRetryStatus(document);
    await pending;
    focusCommerceRetryResult(document);
  });
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
  const fullSizeServiceCheckbox = document.querySelector('[data-full-size-break-in]');
  const updateFullSizeSetup = () => {
    if (!fullSizeServiceCheckbox) return;
    const error = document.querySelector('[data-full-size-error]');
    if (error) { error.hidden = true; error.textContent = ''; }
    const selected = name => document.querySelector(`input[name="${name}"]:checked`)?.value;
    const enabled = fullSizeServiceCheckbox.checked;
    if (!enabled) clearFullSizeFieldErrors(document);
    document.querySelectorAll('[data-full-size-customization] input[type="radio"]').forEach(input => { input.required = enabled; input.disabled = !enabled; });
    const notesInput = document.querySelector('#full-size-break-in-notes');
    if (notesInput) notesInput.disabled = !enabled;
    const otherSelected = selected('full-size-wearing-style')?.startsWith('Other —');
    const customization = document.querySelector('[data-full-size-customization]');
    if (customization) customization.hidden = !enabled;
    fullSizeServiceCheckbox.setAttribute('aria-expanded', String(enabled));
    const otherPlacement = document.querySelector('[data-full-size-other-placement]');
    if (otherPlacement) otherPlacement.hidden = !otherSelected;
    const description = document.querySelector('#full-size-finger-placement');
    if (description) {
      description.required = enabled && Boolean(otherSelected);
      description.disabled = !enabled || !otherSelected;
      description.setCustomValidity(description.required && !description.value.trim() ? 'Describe your finger placement.' : '');
    }
    const hand = selected('full-size-throw-hand');
    const selectedHand = document.querySelector('[data-full-size-selected-hand]');
    if (selectedHand) selectedHand.textContent = hand || 'Choose throw hand above';
    const summary = document.querySelector('[data-full-size-setup-summary]');
    if (!summary) return;
    const style = otherSelected ? (description?.value.trim() ? `Other: ${description.value.trim()}` : 'Describe your finger placement')
      : selected('full-size-wearing-style') || 'Choose finger placement';
    const closure = selected('full-size-closure-point');
    const shaping = FULL_SIZE_SHAPING_FIELDS.map(field => `${field.label}: ${selected(field.name) || 'Choose one'}`).join(' · ');
    const firmness = selected('full-size-firmness') || 'Choose firmness';
    const notes = document.querySelector('#full-size-break-in-notes')?.value.trim();
    summary.textContent = `Your setup: ${summary.dataset.model} · Throw hand: ${hand || 'Choose one'} · ${enabled
      ? `${style} · Thumb closure: ${closure || 'Choose one'} · ${shaping} · ${firmness}${notes ? ' · Shaping notes added' : ''} · +$75 · Adds 2–5 business days`
      : 'No break-in service'}. Total before shipping/tax: ${money(purchasePrice({ price: Number(summary.dataset.price) }, fullSizeService, enabled), summary.dataset.currency)}.`;
  };
  document.querySelectorAll('[data-full-size-break-in], input[name^="full-size-"], textarea[name^="full-size-"]').forEach(input => {
    const update = () => { clearFullSizeFieldErrors(document, input.name); updateFullSizeSetup(); };
    input.addEventListener('input', update);
    input.addEventListener('change', update);
  });
  updateFullSizeSetup();
  const serviceCheckbox = document.querySelector('[data-break-in]');
  serviceCheckbox?.addEventListener('change', () => {
    const customization = document.querySelector('[data-break-in-customization]');
    if (customization) customization.hidden = !serviceCheckbox.checked;
    if (!serviceCheckbox.checked) {
      const medium = document.querySelector('input[name="break-in-level"][value="Medium (65%)"]');
      const traditional = document.querySelector('input[name="glove-wearing-style"][value="Traditional"]');
      if (medium) medium.checked = true;
      if (traditional) traditional.checked = true;
    }
    const product = products.find(item => item.id === document.querySelector('[data-add]')?.dataset.add);
    const amount = document.querySelector('[data-add-price]');
    if (product && amount) amount.textContent = money(purchasePrice(product, breakInService, serviceCheckbox.checked), product.currencyCode);
    const serviceDelay = document.querySelector('[data-service-delay]');
    if (serviceDelay) serviceDelay.hidden = !serviceCheckbox.checked;
  });
  document.querySelectorAll('[data-add]').forEach(element => element.addEventListener('click', () =>
    addProductFromButton(element.dataset.add, element)));
  const galleryButtons = [...document.querySelectorAll('[data-image]')];
  galleryButtons.forEach((element, index) => element.addEventListener('click', () => openLightbox(galleryButtons, index)));
}

const lightboxChevron = direction => `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="${direction < 0 ? 'M10 3 5 8l5 5' : 'M6 3l5 5-5 5'}" /></svg>`;

function openLightbox(buttons, index) {
  lightboxGallery = buttons;
  lightboxReturnFocus = buttons[index];
  lightboxOverlay = document.createElement('div');
  lightboxOverlay.className = 'lightbox';
  lightboxOverlay.setAttribute('role', 'dialog');
  lightboxOverlay.setAttribute('aria-modal', 'true');
  lightboxOverlay.setAttribute('aria-label', 'Product image');
  const nav = buttons.length > 1
    ? `<div class="lightbox-nav"><button type="button" data-lightbox-step="-1" aria-label="Previous image">${lightboxChevron(-1)}</button><span class="lightbox-count" aria-live="polite"></span><button type="button" data-lightbox-step="1" aria-label="Next image">${lightboxChevron(1)}</button></div>`
    : '';
  lightboxOverlay.innerHTML = `<button type="button" class="lightbox-close" aria-label="Close image">Close</button><p class="lightbox-status" role="status"></p>${nav}`;
  // The backdrop and image close the viewer; the navigation bar never does.
  lightboxOverlay.addEventListener('click', event => {
    const step = event.target.closest('[data-lightbox-step]');
    if (step) stepLightbox(Number(step.dataset.lightboxStep));
    else if (!event.target.closest('.lightbox-nav')) closeLightbox();
  });
  // A deliberate horizontal swipe steps; a tap or vertical drag keeps the existing behavior.
  let touchStart = null;
  lightboxOverlay.addEventListener('touchstart', event => {
    touchStart = event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null;
  }, { passive: true });
  lightboxOverlay.addEventListener('touchend', event => {
    if (!touchStart || event.changedTouches.length !== 1) return;
    const dx = event.changedTouches[0].clientX - touchStart.x;
    const dy = event.changedTouches[0].clientY - touchStart.y;
    touchStart = null;
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    event.preventDefault();
    stepLightbox(dx < 0 ? 1 : -1);
  });
  document.body.append(lightboxOverlay);
  document.body.classList.add('lightbox-open');
  app.inert = true;
  showLightboxImage(index);
  lightboxOverlay.querySelector('.lightbox-close').focus();
}

function showLightboxImage(index) {
  const overlay = lightboxOverlay;
  const element = lightboxGallery[index];
  lightboxIndex = index;
  lightboxImageController?.abort();
  const controller = new AbortController();
  lightboxImageController = controller;
  overlay.querySelector('img')?.remove();
  overlay.setAttribute('aria-busy', 'true');
  const status = overlay.querySelector('.lightbox-status');
  status.textContent = 'Loading image…';
  const counter = overlay.querySelector('.lightbox-count');
  if (counter) counter.textContent = lightboxCounter(index, lightboxGallery.length);
  const image = document.createElement('img');
  image.alt = [document.querySelector('.pdp-info h1')?.textContent, element.querySelector('img')?.alt].filter(Boolean).join(' — ') || 'Expanded product view';
  const loaded = loadZoomImage(image, element.dataset.image, controller.signal);
  overlay.insertBefore(image, overlay.querySelector('.lightbox-nav'));
  loaded.then(result => {
    if (lightboxOverlay !== overlay || lightboxImageController !== controller || result === 'aborted') return;
    overlay.setAttribute('aria-busy', 'false');
    status.textContent = result === 'loaded' ? '' : 'Image unavailable. Close and try again.';
  });
}

function stepLightbox(step) {
  if (!lightboxOverlay || lightboxGallery.length < 2) return;
  showLightboxImage(stepLightboxIndex(lightboxIndex, step, lightboxGallery.length));
}

function closeLightbox() {
  if (!lightboxOverlay) return;
  lightboxImageController?.abort();
  lightboxImageController = null;
  lightboxOverlay.remove();
  lightboxOverlay = null;
  document.body.classList.remove('lightbox-open');
  app.inert = cartIsOpen;
  if (lightboxReturnFocus?.isConnected) lightboxReturnFocus.focus({ preventScroll: true });
  lightboxReturnFocus = null;
  lightboxGallery = [];
}

async function loadCommerce() {
  if (commerce.mode !== 'shopify') {
    if (!commerceError) {
      products = await commerce.listProducts();
      breakInService = await commerce.getBreakInService();
      fullSizeService = await commerce.getFullSizeBreakInService?.() || fullSizeService;
      cart = await commerce.getCart();
    }
    render();
    return;
  }
  commerceLoading = true;
  commerceError = '';
  breakInService = { ...localBreakInService, available: false };
  render();
  // The saved-cart read does not depend on product data; run it alongside the product
  // lookups. It is applied after products load only if no newer cart state appeared.
  const finishCartRestore = startStartupCartRestore({ getCart: () => commerce.getCart(), tracker: cartState,
    isBusy: () => cartBusy || checkoutBusy });
  try {
    products = await commerce.listProducts();
    judgeMeReviewLinks = productReviewLinks(products);
    for (const product of products) {
      const handle = product.name.toLowerCase();
      reviewData[handle] = { ...reviewData[handle], writeReviewUrl: judgeMeReviewLinks[handle] };
    }
    loadReviews();
    const serviceLoad = commerce.getBreakInService().then(async service => {
      fullSizeService = await commerce.getFullSizeBreakInService?.() || fullSizeService;
      breakInService = service;
      if (!commerceLoading && (service.available || fullSizeService.available)) { render(); if (cartIsOpen) openCart(); }
    });
    const cartResult = await finishCartRestore();
    if (cartResult.status === 'stale') {
      // Another tab kept changing the cart; never show an older answer. Keep checkout blocked
      // until the customer checks the cart (the storage handler has already said so).
      checkoutNeedsReview = true;
      cart = { ...cart, checkoutUrl: null };
      cartError ||= 'Your cart changed in another tab. Check your cart before checkout.';
    } else if (cartResult.status === 'current' && 'error' in cartResult) {
      cartError = commerceErrorMessage(cartResult.error, 'cart');
      cart = { ...cart, checkoutUrl: null };
    } else if (cartResult.status === 'current') cart = cartResult.value;
    // 'superseded': a same-tab cart action owns newer state and applies it itself.
    commerceLoading = false;
    render();
    if (cartIsOpen) openCart();
    await serviceLoad;
  }
  catch (error) {
    commerceError = commerceErrorMessage(error);
    for (const product of products) reviewData[product.name.toLowerCase()] = { status: 'unavailable' };
    commerceLoading = false;
    render();
    if (cartIsOpen) openCart();
  }
}

async function boot() {
  render(scrollMemory.initialY);
  setupNewsletterPopup();
  await loadCommerce();
}

document.addEventListener('keydown', event => {
  if (newsletterDialog?.open) return;
  if (lightboxOverlay) {
    if (event.key === 'Escape') { event.preventDefault(); closeLightbox(); }
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      stepLightbox(event.key === 'ArrowLeft' ? -1 : 1);
    }
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
window.addEventListener('resize', fitHeroHeading);
window.addEventListener('storage', event => {
  if (commerce.mode !== 'shopify' || !isCartStorageKey(event.key)) return;
  cartState.externalChange();
  checkoutNeedsReview = true;
  cart = { ...cart, checkoutUrl: null };
  cartError = 'Your cart changed in another tab. Check your cart before checkout.';
  if (cartIsOpen && !checkoutBusy) {
    openCart();
    document.querySelector('[data-refresh-cart]')?.focus();
  }
});
window.addEventListener('scroll', () => {
  const scrollY = Math.max(0, window.scrollY);
  headerHidden = nextHeaderHidden({ scrollY, previousY: lastHeaderScrollY, hidden: headerHidden,
    menuOpen: document.querySelector('.mobile-menu-toggle')?.getAttribute('aria-expanded') === 'true' ||
      Boolean(document.activeElement?.closest('.site-header-stack')) });
  document.querySelector('.site-header-stack')?.classList.toggle('is-hidden', headerHidden);
  lastHeaderScrollY = scrollY;
}, { passive: true });
document.addEventListener('focusin', event => {
  if (!event.target.closest?.('.site-header-stack')) return;
  headerHidden = false;
  document.querySelector('.site-header-stack')?.classList.remove('is-hidden');
});
boot();
