// Route renders replace the whole page, so scroll position is managed here rather than by the browser.
// "instant" bypasses the stylesheet's smooth scrolling, which would otherwise animate across the new page.

export function savedScrollY(state) {
  const value = state?.scrollY;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function rememberScroll(historyRef, scrollY) {
  historyRef.replaceState({ ...(historyRef.state || {}), scrollY: Math.max(0, Math.round(scrollY)) }, '');
}

export function scrollToInstant(windowRef, top) {
  windowRef.scrollTo({ top, left: 0, behavior: 'instant' });
}
