import { wristFitOf } from './catalog.js';
export function cartFeedbackMarkup({ error = '', incomplete = false, recoveryAvailable = false,
  recoveryHasBreakIn = false, gloveOnlyRecoveryAvailable = false, busy = false, mode, guidance = '', announce = true,
  checkoutStarted = false, unconfirmedCreate = false, unconfirmedCandidate = false, recoveryUnconfirmed = false,
  storageUnavailable = false, createMismatch = false, attemptedNames = [], recoveryAttemptWithoutBreakIn = false, cartMissing = false }, escapeHtml) {
  // Re-reads the cart; also where focus goes when another tab changes it.
  const check = mode === 'shopify' ? `<button type="button" data-refresh-cart ${busy ? 'disabled' : ''}>Check cart</button>` : '';
  // Without readable storage no cart action can be made safe, so none is offered.
  if (mode === 'shopify' && storageUnavailable) {
    return `<div class="cart-feedback"><p class="cart-error"${announce ? ' role="alert"' : ''}>${escapeHtml(error ||
      'Your browser is blocking site storage, so your cart can’t be changed safely. Allow site data for this site, then reload the page.')}</p></div>`;
  }
  // Shopify reports the active cart gone while an earlier change to it is unresolved. Reads never forget it; only
  // the shopper's Start a new cart does, after Shopify confirms it gone again, and that keeps every saved record.
  if (mode === 'shopify' && cartMissing) {
    return `<div class="cart-feedback"><p class="cart-error"${announce ? ' role="alert"' : ''}>${escapeHtml(error ||
      'Shopify no longer has this cart, and an earlier change to it was not confirmed.')}</p>${check}<button type="button" data-start-new-cart ${busy ? 'disabled' : ''}>Start a new cart</button><small>Then add your glove again. This browser keeps its record of the earlier cart.</small></div>`;
  }
  // An unconfirmed first cart. When its ID was received it is checked (and adopted or reviewed);
  // otherwise there is nothing to check, and the shopper decides whether to start another cart.
  if (mode === 'shopify' && unconfirmedCreate) {
    const action = unconfirmedCandidate
      ? `<button type="button" data-reconcile-cart ${busy ? 'disabled' : ''}>Check unconfirmed cart</button><small>We’ll check what Shopify saved before you add anything else.</small><button type="button" data-start-new-cart ${busy ? 'disabled' : ''}>Start a new cart</button><small>Only if the check can’t show the saved cart. That cart may still exist in Shopify and would stay unused.</small>`
      : `<button type="button" data-start-new-cart ${busy ? 'disabled' : ''}>Start a new cart</button><small>Shopify may already have saved a cart with your item, but this browser couldn’t record it. Starting a new cart leaves that cart unused. Then add your glove again.</small>`;
    return `<div class="cart-feedback"><p class="cart-error"${announce ? ' role="alert"' : ''}>${escapeHtml(error ||
      'We could not confirm whether Shopify saved your new cart, so your item may not have been added.')}</p>${check}${action}</div>`;
  }
  // Shopify saved a first cart that differs from what was added. It is never recovered into a new cart:
  // the shopper keeps exactly what is shown, or starts an empty cart and leaves that one unused.
  if (mode === 'shopify' && createMismatch) {
    const attempted = attemptedNames.length ? ` You added ${attemptedNames.join(', ')}.` : '';
    return `<div class="cart-feedback"><p class="cart-error"${announce ? ' role="alert"' : ''}>${escapeHtml(error ||
      `Shopify saved different items than you added.${attempted} Your cart below shows what Shopify saved.`)}</p>${check}<button type="button" data-keep-unconfirmed-cart ${busy ? 'disabled' : ''}>Keep the items shown</button><button type="button" data-discard-unconfirmed-cart ${busy ? 'disabled' : ''}>Start a new cart</button><small>Starting a new cart leaves the saved cart unused in Shopify. Then add your glove again.</small></div>`;
  }
  if (!error && !incomplete) return guidance ? `<div class="cart-feedback"><p class="cart-guidance" role="status">${escapeHtml(guidance)}</p></div>` : '';
  // A cart handed to Shopify checkout stays frozen; it is never edited here again.
  const message = error || (checkoutStarted
    ? 'Secure checkout was started for this cart, so it can’t be changed here. If checkout didn’t open, continue with your items in a new cart.'
    : 'We could not verify your cart. Check your cart before continuing.');
  const gloveOnlyPossible = recoveryAvailable && recoveryHasBreakIn || gloveOnlyRecoveryAvailable;
  // An earlier recovery attempt is checked first, in its own Break-In mode. Trying again keeps that mode;
  // switching it is a separate, explicitly labelled choice, so paid service is never added by default.
  // Starting over may leave that attempt's cart unused.
  if (mode === 'shopify' && recoveryUnconfirmed) {
    const button = (data, label) => `<button type="button" ${data} ${busy ? 'disabled' : ''}>${label}</button>`;
    const retry = recoveryAttemptWithoutBreakIn
      ? (gloveOnlyPossible || recoveryAvailable ? button('data-recover-retry', 'Try recovery again without Break-In Service') : '')
      : recoveryAvailable ? button('data-recover-retry', recoveryHasBreakIn ? 'Try recovery again with Break-In Service' : 'Try recovery again') : '';
    const retryGloveOnly = recoveryAttemptWithoutBreakIn
      ? (recoveryAvailable && recoveryHasBreakIn ? button('data-recover-retry-with-service', 'Start over with Break-In Service') : '')
      : gloveOnlyPossible ? button('data-recover-retry-without-service', 'Start over without Break-In Service') : '';
    return `<div class="cart-feedback"><p class="cart-error"${announce ? ' role="alert"' : ''}>${escapeHtml(error ||
      'An earlier attempt to move your items into a new cart was not confirmed.')}</p>${check}<button type="button" data-recover-cart ${busy ? 'disabled' : ''}>Check the new cart</button>${retry}${retryGloveOnly}<small>Starting over creates a fresh cart. An unused recovery cart may remain in Shopify; review your items before checkout.</small></div>`;
  }
  const recover = mode === 'shopify' && recoveryAvailable
    ? `<button type="button" data-recover-cart ${busy ? 'disabled' : ''}>Continue with verified items in a new cart</button><small>Review your items before checkout. A pending change may be missing.</small>`
    : '';
  const gloveOnly = mode === 'shopify' && gloveOnlyPossible
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
    const tightened = [before, after].map(cart => (cart?.lines || []).filter(line => line.productId === productId && !line.isBreakIn &&
      wristFitOf(line) === 'tightened').reduce((sum, line) => sum + line.quantity, 0));
    const serviceChange = services[1] - services[0];
    if (gloves[0] === 0 && gloves[1] > 0) parts.push(`${name}${services[1] ? ' with Break-in service' : ''} added to cart.`);
    else if (gloves[1] === 0 && gloves[0] > 0) parts.push(`${name} removed from cart.`);
    else if (gloveChange) parts.push(`${name} quantity ${gloves[1]}.`);
    if (gloves[0] && gloves[0] === gloves[1] && tightened[0] !== tightened[1]) parts.push(`${name} wrist fit updated.`);
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
