export function focusCommerceRetryStatus(root) {
  const status = root.querySelector('.commerce-notice[role="status"]');
  if (!status) return false;
  status.tabIndex = -1;
  status.focus();
  return true;
}

export function focusCommerceRetryResult(root) {
  for (const selector of ['[data-retry-commerce]', '[data-add]:not(:disabled)', '.cart-trigger']) {
    const control = root.querySelector(selector);
    if (!control?.isConnected || control.hidden || control.disabled || control.closest('[hidden], [inert]')) continue;
    control.focus();
    return true;
  }
  return false;
}
