import { containTab } from './dialog.js';

export const NEWSLETTER_POPUP_DELAY_MS = 10_000;
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

  return {
    eligible,
    schedule() {
      if (timer !== null || !eligible()) return;
      timer = setTimer(() => {
        timer = null;
        if (eligible()) opened = onOpen() !== false;
      }, NEWSLETTER_POPUP_DELAY_MS);
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

export function installNewsletterDialog({ dialog, closeButton, documentRef, canOpen, onDismiss, fallbackFocus }) {
  let returnFocus = null;
  let resolved = false;

  function close() {
    if (!dialog.open) return;
    if (!resolved) onDismiss();
    dialog.close();
    documentRef.body.classList.remove('newsletter-open');
    const target = returnFocus;
    returnFocus = null;
    (target?.isConnected ? target : fallbackFocus())?.focus();
  }

  closeButton.addEventListener('click', close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('keydown', event => containTab(event, dialog, documentRef.activeElement));

  return {
    open() {
      if (!canOpen()) return false;
      returnFocus = documentRef.activeElement;
      resolved = false;
      dialog.showModal();
      documentRef.body.classList.add('newsletter-open');
      closeButton.focus();
      return true;
    },
    accept() { if (dialog.open) resolved = true; },
    close
  };
}
