import { containTab } from './dialog.js';

export const NEWSLETTER_POPUP_DELAY_MS = 20_000;
// Scrolling halfway down a page also shows interest, but only after a short dwell so a
// restored scroll position on reload never opens the popup immediately.
export const NEWSLETTER_POPUP_SCROLL_DEPTH = 0.5;
export const NEWSLETTER_POPUP_SCROLL_MIN_MS = 5_000;
export const NEWSLETTER_POPUP_DISMISS_MS = 7 * 24 * 60 * 60 * 1000;
export const NEWSLETTER_POPUP_STORAGE_KEY = 'anawin-newsletter-popup';

function browserStorage() {
  try { return globalThis.localStorage; }
  catch { return null; }
}

export function createNewsletterPopupController({
  storage = browserStorage(), now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  onOpen = () => {}
} = {}) {
  let timer = null;
  let scheduledAt = null;
  let deadline = null;
  let opened = false;
  let suppressed = false;

  function savedState() {
    try { return JSON.parse(storage?.getItem(NEWSLETTER_POPUP_STORAGE_KEY) || '{}') || {}; }
    catch { return {}; }
  }

  function persist(state) {
    try { storage?.setItem(NEWSLETTER_POPUP_STORAGE_KEY, JSON.stringify(state)); }
    catch { /* Browsers may block storage; suppression still applies for this visit. */ }
  }

  function eligible() {
    const state = savedState();
    return !suppressed && !opened && state.subscribed !== true && !(Number(state.dismissedUntil) > now());
  }

  function cancelTimer() {
    if (timer !== null) { clearTimer(timer); timer = null; }
  }

  function dismiss() {
    cancelTimer();
    opened = false;
    suppressed = true;
    persist({ dismissedUntil: now() + NEWSLETTER_POPUP_DISMISS_MS });
  }

  // A blocked attempt (cart open, typing) leaves the other trigger armed.
  function open() {
    if (!eligible() || onOpen() === false) return;
    opened = true;
    cancelTimer();
  }

  // One timer at a time. If an early (scroll) attempt is blocked, fall back to the deadline.
  function armAt(at) {
    cancelTimer();
    timer = setTimer(() => {
      timer = null;
      open();
      if (!opened && deadline > now()) armAt(deadline);
    }, Math.max(0, at - now()));
  }

  return {
    eligible,
    schedule() {
      if (timer !== null || !eligible()) return;
      scheduledAt ??= now();
      deadline = now() + NEWSLETTER_POPUP_DELAY_MS;
      armAt(deadline);
    },
    scrolled(depth) {
      if (scheduledAt === null || depth < NEWSLETTER_POPUP_SCROLL_DEPTH) return;
      const dwellEnds = scheduledAt + NEWSLETTER_POPUP_SCROLL_MIN_MS;
      if (now() >= dwellEnds) open();
      // An early halfway scroll moves the one timer up to the end of the dwell.
      else if (timer !== null && deadline > dwellEnds) armAt(dwellEnds);
    },
    dismiss,
    subscribe() {
      cancelTimer();
      opened = false;
      suppressed = true;
      persist({ subscribed: true });
    },
    pending: dismiss,
    stop: cancelTimer
  };
}

const focusable = element => Boolean(element?.isConnected && element.getClientRects().length &&
  !element.closest('[hidden], [inert]'));

export function installNewsletterDialog({ dialog, closeButton, documentRef, canOpen, onDismiss, fallbackFocus }) {
  let returnFocus = null;
  let resolved = false;
  let showing = false;

  // Runs once per opening, however the dialog closed. Chrome can close a modal on Escape
  // without a cancel event when the page had no recent user activation (as with a timed popup).
  function finish() {
    if (!showing) return;
    showing = false;
    if (!resolved) onDismiss();
    documentRef.body.classList.remove('newsletter-open');
    const target = returnFocus === documentRef.body ? null : returnFocus;
    returnFocus = null;
    // Never return focus to an element that is now hidden or removed, and do not scroll to it.
    [target, fallbackFocus()].find(focusable)?.focus({ preventScroll: true });
  }

  function close() {
    if (dialog.open) dialog.close();
    finish();
  }

  closeButton.addEventListener('click', close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('close', finish);
  dialog.addEventListener('keydown', event => containTab(event, dialog, documentRef.activeElement));

  return {
    open() {
      if (!canOpen()) return false;
      returnFocus = documentRef.activeElement;
      resolved = false;
      dialog.showModal();
      showing = true;
      documentRef.body.classList.add('newsletter-open');
      closeButton.focus();
      return true;
    },
    accept() { if (dialog.open) resolved = true; },
    close
  };
}
