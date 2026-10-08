export function stickyPurchaseAccent(product) {
  return product.id === 'black' ? product.swatches[0] : product.accentColor;
}

export function stickyPurchaseVisible({ mobile, originalVisible, purchaseAreaVisible,
  cartOpen, navOpen, overlayOpen, keyboardOpen }) {
  return mobile && !originalVisible && purchaseAreaVisible &&
    !cartOpen && !navOpen && !overlayOpen && !keyboardOpen;
}

export function createStickyPurchase({ bar, original, purchaseArea, nav, windowRef = window,
  documentRef = document, blocked = () => false, onActivate }) {
  if (!bar || !original || !purchaseArea) return { refresh() {}, destroy() {} };
  const button = bar.querySelector('[data-sticky-add]');
  const price = bar.querySelector('[data-sticky-price]');
  const media = windowRef.matchMedia('(max-width: 760px)');
  const viewport = windowRef.visualViewport;
  let frame = 0;
  let destroyed = false;

  function refresh() {
    if (destroyed) return;
    const top = viewport?.offsetTop || 0;
    const bottom = top + (viewport?.height || windowRef.innerHeight);
    const action = original.getBoundingClientRect();
    const area = purchaseArea.getBoundingClientRect();
    const focused = documentRef.activeElement;
    const keyboardOpen = Boolean(focused?.matches?.('input:not([type="checkbox"]), textarea, select, [contenteditable="true"]')) ||
      Boolean(viewport && viewport.height < windowRef.innerHeight - 120);
    const visible = stickyPurchaseVisible({
      mobile: media.matches,
      originalVisible: action.bottom > top && action.top < bottom,
      purchaseAreaVisible: area.top < bottom && area.bottom > bottom,
      cartOpen: blocked(), navOpen: Boolean(nav && !nav.hidden),
      overlayOpen: Boolean(documentRef.querySelector('.lightbox, .newsletter-dialog[open]')),
      keyboardOpen
    });
    bar.hidden = !visible;
    button.disabled = original.disabled || blocked();
    button.textContent = original.firstChild?.textContent?.trim().toUpperCase() || 'ADD TO CART';
    if (!original.disabled || button.textContent === 'SOLD OUT') {
      price.textContent = original.querySelector('[data-add-price]')?.textContent || '';
    }
  }
  function schedule() {
    if (frame) return;
    frame = windowRef.requestAnimationFrame(() => { frame = 0; refresh(); });
  }
  function add() {
    if (button.disabled || original.disabled || blocked()) return;
    const missing = documentRef.querySelector('.pdp-info :required:invalid');
    if (missing) {
      missing.scrollIntoView({ block: 'center' });
      missing.focus();
      return;
    }
    button.disabled = true;
    onActivate(button, original);
    schedule();
  }
  button.addEventListener('click', add);
  windowRef.addEventListener('scroll', schedule, { passive: true });
  windowRef.addEventListener('resize', schedule);
  viewport?.addEventListener('resize', schedule);
  viewport?.addEventListener('scroll', schedule);
  documentRef.addEventListener('focusin', schedule);
  documentRef.addEventListener('focusout', schedule);
  documentRef.addEventListener('change', schedule);
  documentRef.addEventListener('click', schedule);
  refresh();
  return {
    button,
    refresh,
    destroy() {
      destroyed = true;
      if (frame) windowRef.cancelAnimationFrame(frame);
      button.removeEventListener('click', add);
      windowRef.removeEventListener('scroll', schedule);
      windowRef.removeEventListener('resize', schedule);
      viewport?.removeEventListener('resize', schedule);
      viewport?.removeEventListener('scroll', schedule);
      documentRef.removeEventListener('focusin', schedule);
      documentRef.removeEventListener('focusout', schedule);
      documentRef.removeEventListener('change', schedule);
      documentRef.removeEventListener('click', schedule);
    }
  };
}
