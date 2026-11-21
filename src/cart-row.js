import { FULL_SIZE_SHAPING_FIELDS, PREORDER_PAYMENT_NOTE, WRIST_FITS, preorderCartNote, preorderState, wristFitOf } from './catalog.js';
import { cartEntryTotal } from './commerce.js';
import { entryDisplayAmounts, lineDisplayAmounts } from './cart-discounts.js';
import { renderBreakInEditor } from './cart-break-in-editor.js';

const cartThumbnails = new Map([
  ['/images/black1.PNG', '/images/optimized/black1-480.webp'],
  ['/images/blue1.PNG', '/images/optimized/blue1-480.webp'],
  ['/images/brown1.PNG', '/images/optimized/brown1-480.webp']
]);

export function bindCartImageFallbacks(container) {
  container.querySelectorAll('img[data-cart-image-fallback]').forEach(image => {
    image.addEventListener('error', () => {
      const fallback = image.getAttribute('data-cart-image-fallback');
      image.removeAttribute('data-cart-image-fallback');
      image.src = fallback;
    }, { once: true });
  });
}

export function renderCartRow({ product, line, service, mode, serviceProduct, busy, incomplete, money, escapeHtml, editor = null, notice = '' }) {
  const originalImage = product.images[0]?.src || product.images[0];
  const thumbnail = cartThumbnails.get(originalImage);
  const image = `<img src="${escapeHtml(thumbnail || originalImage)}"${thumbnail ? ` data-cart-image-fallback="${escapeHtml(originalImage)}"` : ''} alt="${escapeHtml(`${product.name} glove in ${product.tone}`)}">`;
  const shopify = mode === 'shopify';
  const quantityAttribute = shopify ? `data-qty-line="${escapeHtml(line.remoteLineId)}"` : `data-qty="${product.id}"`;
  const removeAttribute = shopify ? `data-remove-line="${escapeHtml(line.remoteLineId)}"` : `data-remove="${product.id}"`;
  const description = `${product.name}${service ? ' with Break-in service' : ''}`;
  const entryTotal = shopify
    ? cartEntryTotal(line, service)
    : { amount: product.price * line.quantity + serviceProduct.price * (service?.quantity || 0), currencyCode: product.currencyCode };
  const display = shopify ? entryDisplayAmounts(line, service) : null;
  const displayedTotal = display?.discounted || entryTotal;
  const entryTotalLabel = displayedTotal ? money(displayedTotal.amount, displayedTotal.currencyCode) : 'Price unavailable';
  const originalPrice = display && display.original.amount > display.discounted.amount + 0.01
    ? `<s class="cart-line-original">${money(display.original.amount, display.original.currencyCode)}</s>` : '';
  const priceMarkup = originalPrice
    ? `<div class="cart-price-pair">${originalPrice}<strong class="cart-line-price">${entryTotalLabel}</strong></div>`
    : `<strong class="cart-line-price">${entryTotalLabel}</strong>`;
  const entryPriceMarkup = service
    ? `<div class="cart-entry-price">${priceMarkup}<small class="cart-entry-total-label">Glove + service total</small></div>`
    : priceMarkup;
  const serviceAmounts = shopify && service ? lineDisplayAmounts(service) : null;
  const serviceTotal = serviceAmounts?.discounted || service?.lineTotal;
  const servicePrice = serviceTotal && Number.isFinite(serviceTotal.amount)
    ? money(serviceTotal.amount, serviceTotal.currencyCode) : money(serviceProduct.price, serviceProduct.currencyCode);
  const serviceOriginal = serviceAmounts && serviceAmounts.original.amount > serviceAmounts.discounted.amount + 0.01
    ? `<s>${money(serviceAmounts.original.amount, serviceAmounts.original.currencyCode)}</s> ` : '';
  const servicePreference = key => service?.attributes?.find(attribute => attribute.key === key)?.value;
  const trainerPreferenceMarkup = service && servicePreference('Break-In Level') && servicePreference('Glove Wearing Style')
    ? `<div class="cart-service-preferences"><p>Break-In Level: ${escapeHtml(servicePreference('Break-In Level'))}</p><p>Glove Wearing Style: ${escapeHtml(servicePreference('Glove Wearing Style'))}</p></div>` : '';
  const fullSize = product.line === 'full-size';
  const editing = shopify && editor?.lineId === line.remoteLineId;
  // While its choices are being edited, the form shows them instead of the saved summary.
  const preferenceMarkup = editing ? '' : fullSize && service
    ? `<div class="cart-service-preferences" role="group" aria-label="${escapeHtml(product.name)} break-in instructions"><h4>Break-in instructions</h4>${['Glove Model', 'Throwing Hand', 'Glove Wearing Style', 'Finger Placement', 'Thumb Closure', ...FULL_SIZE_SHAPING_FIELDS.map(field => field.attribute), 'Firmness', 'Notes'].filter(key => servicePreference(key)).map(key => `<p>${escapeHtml(key === 'Finger Shape' ? 'Finger Form' : key)}: ${escapeHtml(servicePreference(key))}</p>`).join('')}</div>`
    : trainerPreferenceMarkup;
  const editorMarkup = editing ? renderBreakInEditor({ product, line, editor, serviceProduct, busy, incomplete, money, escapeHtml }) : '';
  const noticeMarkup = notice && service ? `<p class="cart-service-added" role="status" tabindex="-1" data-service-notice>${escapeHtml(notice)}</p>` : '';
  const wristFit = WRIST_FITS.find(option => option.value === wristFitOf(line));
  const nextFit = WRIST_FITS.find(option => option !== wristFit);
  const wristAction = nextFit.value === 'tightened' ? 'Tighten wrist' : 'Use regular wrist';
  const wristLabel = `${wristAction}${line.quantity > 1 ? ' for 1' : ''}`;
  const wristControl = `<p class="cart-wrist">Wrist fit: ${escapeHtml(wristFit.label)} (${escapeHtml(wristFit.range)})${shopify && !editing
    ? ` <button class="cart-service-control" data-wrist-fit="${escapeHtml(line.remoteLineId)}" data-fit="${nextFit.value}" aria-label="${escapeHtml(`${wristLabel} of ${product.name}, ${nextFit.range}, free`)}" ${busy || incomplete || line.quantity > 1 && !line.instructions?.canUpdateQuantity ? 'disabled' : ''}>${escapeHtml(wristLabel)}</button>` : ''}</p>`;
  // Derived from the product at render time; preorder status is never stored on the cart line.
  const preorder = preorderState(product);
  const preorderNote = preorder.status === 'active'
    ? `<p class="cart-preorder-note">${escapeHtml(preorderCartNote(preorder.estimate))}</p>`
    : preorder.status === 'blocked' ? '<p class="cart-preorder-note cart-preorder-blocked">Not available to order right now. Remove it to continue to checkout.</p>' : '';
  const hand = line.throwingHand || line.attributes?.find(attribute => attribute.key === 'Throwing Hand')?.value;
  const serviceControl = shopify
    ? service
      ? `<p class="cart-service">Break-in service${service.quantity > 1 ? ` (${service.quantity})` : ''} · ${serviceOriginal}${servicePrice} (included)${editing ? '' : `<span class="cart-service-actions"><button class="cart-service-control cart-service-button is-secondary" data-edit-service="${escapeHtml(line.remoteLineId)}" aria-label="${line.quantity > 1 ? 'Edit break-in for 1' : 'Edit break-in for'} ${escapeHtml(product.name)}" ${busy || incomplete || line.quantity > 1 && !line.instructions?.canUpdateQuantity ? 'disabled' : ''}>${line.quantity > 1 ? 'Edit break-in for 1' : 'Edit break-in'}</button><button class="cart-service-control cart-service-button is-secondary" data-remove-service="${escapeHtml(line.remoteLineId)}" aria-label="${line.quantity > 1 ? 'Remove break-in from 1' : 'Remove break-in from'} ${escapeHtml(product.name)}" ${busy || incomplete || (line.quantity > 1 ? !line.instructions?.canUpdateQuantity : !service.instructions?.canRemove) ? 'disabled' : ''}>${line.quantity > 1 ? 'Remove break-in from 1' : 'Remove break-in'}</button></span>`}</p>`
      : editing ? '' : serviceProduct.available !== true ? `<p class="cart-service">Break-in service is unavailable right now.</p>` : `<button class="cart-service-control cart-service-button is-primary" data-add-service="${escapeHtml(line.remoteLineId)}" aria-label="${line.quantity > 1 ? 'Add break-in to 1' : fullSize ? 'Add full-size break-in to' : 'Add Break-in service to'} ${escapeHtml(product.name)}, +${money(serviceProduct.price, serviceProduct.currencyCode)}" ${busy || incomplete || line.quantity > 1 && !line.instructions?.canUpdateQuantity ? 'disabled' : ''}>${line.quantity > 1 ? `Add break-in to 1 <span>+${money(serviceProduct.price, serviceProduct.currencyCode)}</span>` : `${fullSize ? 'Add full-size break-in' : 'Add Break-in service'} +${money(serviceProduct.price, serviceProduct.currencyCode)}`}</button>`
    : service ? `<p class="cart-service">Break-in service · ${money(serviceProduct.price, serviceProduct.currencyCode)}</p>` : '';
  return `<article class="cart-item" data-product="${escapeHtml(product.id)}">${image}<div class="cart-item-info"><h3>${escapeHtml(product.name)}</h3><p>${escapeHtml(product.tone)}</p>${preorderNote}${hand ? `<p>Throwing Hand: ${escapeHtml(hand)}</p>` : ''}${wristControl}${serviceControl}<div class="quantity"><button ${quantityAttribute} data-delta="-1" aria-label="Decrease ${escapeHtml(description)} quantity" ${busy || incomplete ? 'disabled' : ''}>−</button><span>${line.quantity}</span><button ${quantityAttribute} data-delta="1" aria-label="Increase ${escapeHtml(description)} quantity" ${busy || incomplete ? 'disabled' : ''}>+</button></div></div><div class="cart-item-side">${entryPriceMarkup}<button class="remove" ${removeAttribute} aria-label="Remove ${escapeHtml(description)}" ${busy ? 'disabled' : ''}>Remove</button></div>${editorMarkup}${noticeMarkup}${preferenceMarkup}</article>`;
}

// Which gloves in the cart are preorders (with their estimates) and which cannot be confirmed.
export function cartPreorderSummary(products) {
  const unique = [...new Map(products.filter(Boolean).map(product => [product.id, product])).values()];
  const states = unique.map(product => ({ product, state: preorderState(product) }));
  return {
    preorders: states.filter(({ state }) => state.status === 'active').map(({ product, state }) => ({ name: product.name, estimate: state.estimate })),
    blocked: states.filter(({ state }) => state.status === 'blocked').map(({ product }) => product.name),
    others: states.filter(({ state }) => state.status === 'inactive').length
  };
}

// Plain text before checkout, not a live region: the checkout button references it with aria-describedby.
export const CART_PREORDER_DISCLOSURE_ID = 'cart-preorder-disclosure';
export function renderCartPreorderDisclosure({ preorders, blocked, others }, escapeHtml) {
  if (blocked.length) {
    return `<p class="cart-preorder-disclosure cart-preorder-blocked" id="${CART_PREORDER_DISCLOSURE_ID}">${escapeHtml(blocked.join(', '))} ${blocked.length === 1 ? 'isn’t' : 'aren’t'} available to order right now. Remove ${blocked.length === 1 ? 'it' : 'them'} to continue to checkout.</p>`;
  }
  if (!preorders.length) return '';
  return `<div class="cart-preorder-disclosure" id="${CART_PREORDER_DISCLOSURE_ID}"><p><strong>Your cart includes ${preorders.length === 1 ? 'a preorder' : 'preorders'}.</strong></p><ul>${preorders.map(item => `<li>${escapeHtml(item.name)}: ${escapeHtml(preorderCartNote(item.estimate))}</li>`).join('')}</ul>${others ? '<p>Other items in your cart are not preorders.</p>' : ''}<p>${escapeHtml(PREORDER_PAYMENT_NOTE)}</p></div>`;
}
