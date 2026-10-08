export function cartFeedbackMarkup({ error = '', incomplete = false, recoveryAvailable = false,
  recoveryHasBreakIn = false, busy = false, mode }, escapeHtml) {
  if (!error && !incomplete) return '';
  const message = error || 'We could not verify your cart. Check your cart before continuing.';
  const check = mode === 'shopify' ? `<button type="button" data-refresh-cart ${busy ? 'disabled' : ''}>Check cart</button>` : '';
  const recover = mode === 'shopify' && recoveryAvailable
    ? `<button type="button" data-recover-cart ${busy ? 'disabled' : ''}>Continue with verified items in a new cart</button><small>Review your items before checkout. A pending change may be missing.</small>`
    : '';
  const gloveOnly = mode === 'shopify' && recoveryAvailable && recoveryHasBreakIn
    ? `<button type="button" data-recover-without-service ${busy ? 'disabled' : ''}>Continue without Break-In Service</button>` : '';
  return `<div class="cart-feedback"><p class="cart-error" role="alert">${escapeHtml(message)}</p>${check}${recover}${gloveOnly}</div>`;
}
