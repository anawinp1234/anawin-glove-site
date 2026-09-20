const focusableSelector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

export function containTab(event, dialog, activeElement) {
  if (event.key !== 'Tab') return;
  const controls = [...dialog.querySelectorAll(focusableSelector)].filter(element => element.getClientRects().length);
  if (!controls.length) {
    event.preventDefault();
    dialog.focus();
    return;
  }
  const first = controls[0];
  const last = controls.at(-1);
  if (!dialog.contains(activeElement) || (event.shiftKey && activeElement === first) || (!event.shiftKey && activeElement === last)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}
