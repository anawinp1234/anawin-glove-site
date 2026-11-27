export function isVisibleFocusTarget(element, { documentRef = document, windowRef = window } = {}) {
  if (!element?.isConnected || element.disabled || element.closest?.('[hidden], [inert], [aria-hidden="true"]')) return false;
  const rect = element.getBoundingClientRect?.();
  if (!rect || rect.width <= 0 || rect.height <= 0) return false;
  const style = windowRef.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
  const viewport = windowRef.visualViewport;
  const top = viewport?.offsetTop || 0;
  const bottom = top + (viewport?.height || windowRef.innerHeight);
  return rect.bottom > top && rect.top < bottom && documentRef.documentElement.contains(element);
}

export function restoreFocusWithoutScroll(candidates, environment) {
  const target = candidates.find(element => isVisibleFocusTarget(element, environment));
  target?.focus({ preventScroll: true });
  return target || null;
}

export function restoreFocusWithVisibleFallback(candidates, fallbackCandidates, revealFallback, environment) {
  const target = restoreFocusWithoutScroll(candidates, environment);
  if (target) return target;
  revealFallback?.();
  return restoreFocusWithoutScroll(fallbackCandidates, environment);
}

// Cart controls that keep their identity across drawer re-renders. Line-based controls also
// carry a Shopify line ID, which can change when Break-In service splits or merges a line.
const cartControlKinds = [
  ['data-qty-line', 'quantity'], ['data-qty', 'quantity'], ['data-remove-line', 'remove'], ['data-remove', 'remove'],
  ['data-remove-service', 'remove-service'], ['data-add-service', 'add-service'], ['data-edit-service', 'edit-service'], ['data-wrist-fit', 'wrist-fit'], ['data-remove-discount', 'remove-discount'],
  ['data-discount-toggle', 'discount-toggle'], ['data-discount-apply', 'discount-apply'], ['data-checkout', 'checkout'], ['data-refresh-cart', 'refresh'],
  ['data-recover-cart', 'recover'], ['data-recover-without-service', 'recover-glove-only'], ['data-recover-retry', 'recover-retry'], ['data-recover-retry-without-service', 'recover-retry-glove-only'], ['data-recover-retry-with-service', 'recover-retry-with-service'],
  ['data-keep-unconfirmed-cart', 'keep-unconfirmed'], ['data-discard-unconfirmed-cart', 'discard-unconfirmed'], ['data-start-new-cart', 'start-new-cart'], ['data-reconcile-cart', 'reconcile'], ['data-close-cart', 'close']
];
const cartControlSelector = 'button, a[href], input';

function controlKind(element) {
  const match = cartControlKinds.find(([attribute]) => element.hasAttribute?.(attribute));
  if (match) {
    const delta = element.getAttribute('data-delta');
    return { kind: delta ? `${match[1]}:${delta}` : match[1], value: element.getAttribute(match[0]) };
  }
  return element.id ? { kind: `#${element.id}`, value: null } : null;
}

export function cartFocusKey(element, drawer) {
  if (!element || element === drawer || !drawer?.contains(element)) return null;
  const control = controlKind(element);
  if (!control) return null;
  const rows = [...drawer.querySelectorAll('.cart-item')];
  const row = element.closest('.cart-item');
  const productId = row?.getAttribute('data-product') || null;
  return { ...control, productId, rowIndex: row ? rows.indexOf(row) : -1,
    productIndex: row ? rows.filter(candidate => candidate.getAttribute('data-product') === productId).indexOf(row) : -1 };
}

// The same control if it survived, else the same control in the same glove's row (its line ID may
// have changed), else the nearest remaining row, else the empty-cart link. Disabled controls never qualify.
export function findCartFocusTarget(drawer, key) {
  if (!drawer || !key) return null;
  const usable = element => !element.disabled && !element.closest('[hidden]');
  const controls = root => [...root.querySelectorAll(cartControlSelector)].filter(usable);
  const sameKind = element => controlKind(element)?.kind === key.kind;
  const exact = controls(drawer).find(element => sameKind(element) && (key.value === null || controlKind(element).value === key.value));
  if (exact) return exact;
  if (key.rowIndex < 0) return null;
  const rows = [...drawer.querySelectorAll('.cart-item')];
  const productRows = rows.filter(row => row.getAttribute('data-product') === key.productId);
  for (const row of [productRows[Math.min(key.productIndex, productRows.length - 1)], rows[Math.min(key.rowIndex, rows.length - 1)]]) {
    if (!row) continue;
    const rowControls = controls(row);
    const target = rowControls.find(sameKind) || rowControls[0];
    if (target) return target;
  }
  return [...drawer.querySelectorAll('.empty-cart a[href]')][0] || null;
}
