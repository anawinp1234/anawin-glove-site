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

// popstate runs after history.state changes to the destination. Keep the outgoing
// entry's identity separately so its final position never replaces the destination's.
export function installScrollMemory(windowRef, onRestore, {
  // LAN previews use HTTP, where randomUUID is unavailable. These keys only
  // identify history entries; they do not need cryptographic randomness.
  createKey = () => windowRef.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
} = {}) {
  const historyRef = windowRef.history;
  const positions = new Map();
  let timer;
  const entryKey = () => {
    if (!historyRef.state?.anawinScrollEntry) {
      historyRef.replaceState({ ...historyRef.state, anawinScrollEntry: createKey() }, '');
    }
    return historyRef.state.anawinScrollEntry;
  };
  let activeKey = entryKey();
  const cache = (key, top) => {
    const value = Math.max(0, Math.round(top));
    positions.set(key, value);
    // Preserve a just-departed entry even if the destination is reloaded.
    try { windowRef.sessionStorage?.setItem(`anawin-scroll:${key}`, String(value)); } catch { /* Storage may be unavailable. */ }
    return value;
  };
  const read = key => {
    if (positions.has(key)) return positions.get(key);
    try {
      const stored = windowRef.sessionStorage?.getItem(`anawin-scroll:${key}`);
      if (stored != null && Number.isFinite(Number(stored)) && Number(stored) >= 0) return Number(stored);
    } catch { /* Fall back to the history snapshot. */ }
    return savedScrollY(historyRef.state);
  };
  const save = () => {
    const top = cache(activeKey, windowRef.scrollY);
    if (historyRef.state?.anawinScrollEntry === activeKey) rememberScroll(historyRef, top);
  };
  if ('scrollRestoration' in historyRef) historyRef.scrollRestoration = 'manual';
  windowRef.addEventListener('scroll', () => {
    windowRef.clearTimeout(timer);
    timer = windowRef.setTimeout(save, 200);
  }, { passive: true });
  windowRef.addEventListener('popstate', () => {
    windowRef.clearTimeout(timer);
    cache(activeKey, windowRef.scrollY);
    activeKey = entryKey();
    onRestore(read(activeKey));
  });
  windowRef.addEventListener('pagehide', () => {
    windowRef.clearTimeout(timer);
    save();
  });
  return {
    initialY: read(activeKey),
    navigate(path) {
      windowRef.clearTimeout(timer);
      save();
      historyRef.pushState({ anawinScrollEntry: createKey(), scrollY: 0 }, '', path);
      activeKey = entryKey();
      onRestore(0);
    }
  };
}
