import { cartEntryTotal } from './commerce.js';

export function renderCartRow({ product, line, service, mode, serviceProduct, busy, incomplete, money, escapeHtml }) {
  const shopify = mode === 'shopify';
  const quantityAttribute = shopify ? `data-qty-line="${escapeHtml(line.remoteLineId)}"` : `data-qty="${product.id}"`;
  const removeAttribute = shopify ? `data-remove-line="${escapeHtml(line.remoteLineId)}"` : `data-remove="${product.id}"`;
  const description = `${product.name}${service ? ' with Break-in service' : ''}`;
  const entryTotal = shopify
    ? cartEntryTotal(line, service)
    : { amount: product.price * line.quantity + serviceProduct.price * (service?.quantity || 0), currencyCode: product.currencyCode };
  const entryTotalLabel = entryTotal ? money(entryTotal.amount, entryTotal.currencyCode) : 'Price unavailable';
  const serviceControl = shopify
    ? service
      ? `<p class="cart-service">Break-in service · ${money(serviceProduct.price, serviceProduct.currencyCode)} <button class="cart-service-control" data-remove-service="${escapeHtml(line.remoteLineId)}" aria-label="${line.quantity > 1 ? 'Remove break-in from 1' : 'Remove break-in from'} ${escapeHtml(product.name)}" ${busy || incomplete || (line.quantity > 1 ? !line.instructions?.canUpdateQuantity : !service.instructions?.canRemove) ? 'disabled' : ''}>${line.quantity > 1 ? 'Remove break-in from 1' : 'Remove break-in'}</button></p>`
      : `<button class="cart-service-control" data-add-service="${escapeHtml(line.remoteLineId)}" ${busy || incomplete || serviceProduct.available === false || line.quantity > 1 && !line.instructions?.canUpdateQuantity ? 'disabled' : ''}>${line.quantity > 1 ? `Add break-in to 1 <span>+${money(serviceProduct.price, serviceProduct.currencyCode)}</span>` : `Add Break-in service +${money(serviceProduct.price, serviceProduct.currencyCode)}`}</button>`
    : service ? `<p class="cart-service">Break-in service · ${money(serviceProduct.price, serviceProduct.currencyCode)}</p>` : '';
  return `<article class="cart-item"><img src="${escapeHtml(product.images[0])}" alt=""><div class="cart-item-info"><h3>${escapeHtml(product.name)}</h3><p>${escapeHtml(product.tone)}</p>${serviceControl}<div class="quantity"><button ${quantityAttribute} data-delta="-1" aria-label="Decrease ${escapeHtml(description)} quantity" ${busy ? 'disabled' : ''}>−</button><span>${line.quantity}</span><button ${quantityAttribute} data-delta="1" aria-label="Increase ${escapeHtml(description)} quantity" ${busy ? 'disabled' : ''}>+</button></div></div><div class="cart-item-side"><strong class="cart-line-price">${entryTotalLabel}</strong><button class="remove" ${removeAttribute} aria-label="Remove ${escapeHtml(description)}" ${busy ? 'disabled' : ''}>Remove</button></div></article>`;
}
