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
