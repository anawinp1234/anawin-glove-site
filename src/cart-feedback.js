export function cartFeedbackMarkup({ error = '', incomplete = false, recoveryAvailable = false,
  recoveryHasBreakIn = false, gloveOnlyRecoveryAvailable = false, busy = false, mode, guidance = '', announce = true }, escapeHtml) {
  if (!error && !incomplete) return guidance ? `<div class="cart-feedback"><p class="cart-guidance" role="status">${escapeHtml(guidance)}</p></div>` : '';
  const message = error || 'We could not verify your cart. Check your cart before continuing.';
  const check = mode === 'shopify' ? `<button type="button" data-refresh-cart ${busy ? 'disabled' : ''}>Check cart</button>` : '';
  const recover = mode === 'shopify' && recoveryAvailable
    ? `<button type="button" data-recover-cart ${busy ? 'disabled' : ''}>Continue with verified items in a new cart</button><small>Review your items before checkout. A pending change may be missing.</small>`
    : '';
  const gloveOnly = mode === 'shopify' && (recoveryAvailable && recoveryHasBreakIn || gloveOnlyRecoveryAvailable)
    ? `<button type="button" data-recover-without-service ${busy ? 'disabled' : ''}>Continue without Break-In Service</button>` : '';
  // A re-render shows the same message without re-announcing it.
  return `<div class="cart-feedback"><p class="cart-error"${announce ? ' role="alert"' : ''}>${escapeHtml(message)}</p>${check}${recover}${gloveOnly}</div>`;
}

// One sentence describing a confirmed cart change, from the carts before and after it.
// Callers pass only carts Shopify confirmed; unverified or failed updates are never announced.
export function cartUpdateAnnouncement(before, after, nameFor) {
  const count = (cart, productId, service) => (cart?.lines || [])
    .filter(line => line.productId === productId && Boolean(line.isBreakIn) === service)
    .reduce((sum, line) => sum + line.quantity, 0);
  const productIds = [...new Set([...(before?.lines || []), ...(after?.lines || [])].map(line => line.productId))];
  const parts = [];
  for (const productId of productIds) {
    const name = nameFor(productId);
    const gloves = [count(before, productId, false), count(after, productId, false)];
    const services = [count(before, productId, true), count(after, productId, true)];
    const gloveChange = gloves[1] - gloves[0];
    const serviceChange = services[1] - services[0];
    if (gloves[0] === 0 && gloves[1] > 0) parts.push(`${name}${services[1] ? ' with Break-in service' : ''} added to cart.`);
    else if (gloves[1] === 0 && gloves[0] > 0) parts.push(`${name} removed from cart.`);
    else if (gloveChange) parts.push(`${name} quantity ${gloves[1]}.`);
    // A service that moved in step with its glove is already covered by the glove sentence.
    if (gloves[0] && gloves[1] && serviceChange && serviceChange !== gloveChange) {
      parts.push(serviceChange < 0 ? `Break-in service removed from ${gloves[1] > 1 ? `${-serviceChange} ` : ''}${name}.`
        : `Break-in service added to ${gloves[1] > 1 ? `${serviceChange} ` : ''}${name}.`);
    }
  }
  if (parts.length && !(after?.lines || []).some(line => !line.isBreakIn)) parts.push('Your cart is empty.');
  return parts.join(' ');
}

// A single polite status element that survives drawer re-renders: each new drawer adopts it.
// Text is cleared and set on a short delay so a repeated sentence is still announced, and a
// newer announcement replaces a pending one instead of queuing behind it.
export function createCartAnnouncer({ documentRef = document, setTimer = setTimeout, clearTimer = clearTimeout, delay = 150 } = {}) {
  let region = null;
  let timer = null;
  function ensure() {
    if (region?.isConnected) return region;
    if (region) { documentRef.body.appendChild(region); return region; }
    region = documentRef.createElement('p');
    region.className = 'visually-hidden';
    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', 'polite');
    region.setAttribute('aria-atomic', 'true');
    region.setAttribute('data-cart-announcer', '');
    documentRef.body.appendChild(region);
    return region;
  }
  return {
    attach(container) {
      if (!container) return;
      const node = ensure();
      // Text already delivered would read as new when its region lands in a fresh drawer.
      if (timer === null && node.parentNode !== container) node.textContent = '';
      container.appendChild(node);
    },
    announce(text) {
      const node = ensure();
      if (timer !== null) clearTimer(timer);
      node.textContent = '';
      if (!text) { timer = null; return; }
      timer = setTimer(() => { timer = null; node.textContent = text; }, delay);
    }
  };
}
