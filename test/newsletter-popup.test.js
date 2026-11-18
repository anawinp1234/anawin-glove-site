import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createNewsletterSignup } from '../src/newsletter.js';
import { bindNewsletterForm } from '../src/newsletter-form.js';
import {
  createNewsletterPopupController, installNewsletterDialog,
  NEWSLETTER_POPUP_DELAY_MS, NEWSLETTER_POPUP_DISMISS_MS, NEWSLETTER_POPUP_STORAGE_KEY,
  NEWSLETTER_POPUP_SCROLL_DEPTH, NEWSLETTER_POPUP_SCROLL_MIN_MS
} from '../src/newsletter-popup.js';
import { newsletterFormMarkup, newsletterPopupMarkup } from '../src/storefront-render.js';

function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

function timers() {
  let callback;
  let delay;
  return { setTimer(fn, ms) { callback = fn; delay = ms; return 1; }, clearTimer() { callback = null; }, fire() { const fn = callback; callback = null; fn?.(); }, get delay() { return delay; }, get pending() { return Boolean(callback); } };
}

function element(documentRef = null) {
  const listeners = new Map();
  const attrs = new Map();
  const classes = new Set();
  return {
    isConnected: true,
    textContent: '',
    addEventListener(type, listener) { const group = listeners.get(type) || []; group.push(listener); listeners.set(type, group); },
    async fire(type, event = {}) { for (const listener of listeners.get(type) || []) await listener(event); },
    setAttribute: (key, value) => attrs.set(key, value),
    removeAttribute: key => attrs.delete(key),
    getAttribute: key => attrs.get(key),
    classList: { add: name => classes.add(name), contains: name => classes.has(name) },
    getClientRects() { return this.hidden ? [] : [1]; },
    closest() { return null; },
    focus() { if (documentRef) documentRef.activeElement = this; }
  };
}

function formFixture() {
  const email = element(); email.value = 'hello@example.com';
  const consent = element(); consent.checked = true;
  const button = element(); button.textContent = 'SIGN UP';
  const message = element();
  const fields = element(); fields.hidden = false;
  const success = element(); success.hidden = true;
  const heading = element(); heading.id = 'test-success-heading';
  const copy = element(); copy.id = 'test-success-copy';
  success.querySelector = selector => selector === 'h3' ? heading : copy;
  const container = element(); container.matches = () => false;
  const form = element();
  form.elements = { email, consent };
  form.querySelector = selector => ({ '.newsletter-message': message, '.newsletter-fields': fields, '.newsletter-success': success })[selector] || button;
  form.closest = () => container;
  form.reset = () => { email.value = ''; consent.checked = false; };
  form.submit = () => form.fire('submit', { preventDefault() {} });
  return { form, email, consent, button, message, fields, success, heading, container };
}

test('popup and inline markup use the same labeled, unchecked newsletter form with unique IDs', () => {
  const inline = newsletterFormMarkup('newsletter');
  const popup = newsletterPopupMarkup();
  assert.match(popup, /<dialog class="newsletter-dialog" aria-labelledby="newsletter-popup-heading" aria-describedby="newsletter-popup-copy">/);
  assert.match(popup, /aria-label="Close newsletter signup"/);
  assert.match(popup, /JOIN OUR<br>NEWSLETTER/);
  assert.match(popup, /Be the first to hear about new gloves, releases, and what’s next\./);
  assert.match(inline, /for="newsletter-email"/);
  assert.match(popup, /for="newsletter-popup-email"/);
  assert.match(popup, /id="newsletter-popup-success-heading"/);
  assert.match(inline, /id="newsletter-success-heading"/);
  for (const markup of [inline, popup]) {
    assert.match(markup, /data-newsletter-form/);
    assert.match(markup, /type="email"[^>]*required/);
    assert.match(markup, /type="checkbox"[^>]*required/);
    assert.doesNotMatch(markup, /type="checkbox"[^>]*checked/);
    assert.match(markup, /class="newsletter-success" hidden/);
    assert.match(markup, /THANK YOU FOR JOINING/);
    assert.match(markup, /Existing email preferences are preserved\./);
  }
});

test('accepted popup request shows the shared success panel and updates dialog labeling', async () => {
  const popup = formFixture();
  popup.container.matches = selector => selector === '.newsletter-dialog';
  const signup = createNewsletterSignup({ fetchImpl: async () => ({ ok: true, json: async () => ({ status: 'accepted' }) }) });
  bindNewsletterForm(popup.form, signup);
  await popup.form.submit();
  assert.equal(popup.fields.hidden, true);
  assert.equal(popup.success.hidden, false);
  assert.equal(popup.container.getAttribute('aria-labelledby'), 'test-success-heading');
  assert.equal(popup.container.getAttribute('aria-describedby'), 'test-success-copy');
  assert.equal(popup.message.getAttribute('role'), 'status');
  assert.equal(popup.message.textContent, 'THANK YOU FOR JOINING\nExisting email preferences are preserved.');
});

test('popup waits twenty seconds and never opens immediately', () => {
  assert.equal(NEWSLETTER_POPUP_DELAY_MS, 20_000);
  const clock = timers();
  let opens = 0;
  const popup = createNewsletterPopupController({ storage: storage(), setTimer: clock.setTimer, clearTimer: clock.clearTimer, onOpen: () => { opens++; } });
  popup.schedule(); popup.schedule();
  assert.equal(opens, 0);
  assert.equal(clock.delay, NEWSLETTER_POPUP_DELAY_MS);
  clock.fire();
  assert.equal(opens, 1);
  popup.schedule();
  assert.equal(clock.pending, false);
});

test('dismissal persists for seven days and then expires', () => {
  const saved = storage();
  let time = 100_000;
  const makePopup = () => createNewsletterPopupController({ storage: saved, now: () => time });
  const popup = makePopup();
  popup.dismiss();
  assert.equal(JSON.parse(saved.getItem(NEWSLETTER_POPUP_STORAGE_KEY)).dismissedUntil, time + NEWSLETTER_POPUP_DISMISS_MS);
  assert.equal(makePopup().eligible(), false);
  time += NEWSLETTER_POPUP_DISMISS_MS - 1;
  assert.equal(makePopup().eligible(), false);
  time++;
  assert.equal(makePopup().eligible(), true);
});

test('confirmed subscription suppresses future popups; pending only defers them', () => {
  const subscribedStorage = storage();
  const subscribed = createNewsletterPopupController({ storage: subscribedStorage });
  subscribed.subscribe();
  assert.equal(createNewsletterPopupController({ storage: subscribedStorage }).eligible(), false);
  const pendingStorage = storage();
  const pending = createNewsletterPopupController({ storage: pendingStorage, now: () => 0 });
  pending.pending();
  assert.equal(createNewsletterPopupController({ storage: pendingStorage, now: () => 1 }).eligible(), false);
  assert.equal(createNewsletterPopupController({ storage: pendingStorage, now: () => NEWSLETTER_POPUP_DISMISS_MS }).eligible(), true);
});

test('close button and Escape dismiss modal, contain focus, and restore previous focus', async () => {
  const classes = new Set();
  const documentRef = { activeElement: null, body: { classList: { add: name => classes.add(name), remove: name => classes.delete(name) } } };
  const opener = element(documentRef); documentRef.activeElement = opener;
  const closeButton = element(documentRef);
  const email = element(documentRef);
  const submit = element(documentRef);
  const dialog = element(documentRef);
  dialog.open = false;
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; };
  dialog.querySelectorAll = () => [closeButton, email, submit];
  dialog.contains = target => [closeButton, email, submit].includes(target);
  let dismissals = 0;
  const ui = installNewsletterDialog({ dialog, closeButton, documentRef, canOpen: () => true, onDismiss: () => dismissals++, fallbackFocus: () => opener });
  assert.equal(ui.open(), true);
  assert.equal(dialog.open, true);
  assert.equal(classes.has('newsletter-open'), true);
  assert.equal(documentRef.activeElement, closeButton);
  submit.focus();
  let prevented = false;
  await dialog.fire('keydown', { key: 'Tab', shiftKey: false, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(documentRef.activeElement, closeButton);
  await closeButton.fire('click');
  assert.equal(dialog.open, false);
  assert.equal(dismissals, 1);
  assert.equal(documentRef.activeElement, opener);
  assert.equal(classes.has('newsletter-open'), false);
  ui.open();
  let canceled = false;
  await dialog.fire('cancel', { preventDefault() { canceled = true; } });
  assert.equal(canceled, true);
  assert.equal(dismissals, 2);
  assert.equal(documentRef.activeElement, opener);
});

test('accepted request leaves the acknowledgment visible until close', async () => {
  const documentRef = { activeElement: null, body: { classList: { add() {}, remove() {} } } };
  const opener = element(documentRef); documentRef.activeElement = opener;
  const closeButton = element(documentRef);
  const dialog = element(documentRef);
  dialog.open = false;
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; };
  dialog.querySelectorAll = () => [closeButton];
  let dismissals = 0;
  const ui = installNewsletterDialog({ dialog, closeButton, documentRef, canOpen: () => true, onDismiss: () => dismissals++, fallbackFocus: () => opener });
  ui.open(); ui.accept();
  assert.equal(dialog.open, true);
  await closeButton.fire('click');
  assert.equal(dismissals, 0);
});

test('popup and inline bindings share one Shopify signup controller and show neutral acknowledgment and failure states', async () => {
  const requests = [];
  const states = ['ACCEPTED', 'ACCEPTED', 'FAIL'];
  const signup = createNewsletterSignup({ fetchImpl: async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    const state = states.shift();
    return state === 'FAIL' ? { ok: false, status: 503, json: async () => ({ error: 'shopify_unavailable' }) }
      : { ok: true, json: async () => ({ status: 'accepted' }) };
  } });
  const inline = formFixture();
  const popup = formFixture();
  const results = [];
  bindNewsletterForm(inline.form, signup, result => results.push(result.status));
  bindNewsletterForm(popup.form, signup, result => results.push(result.status));
  await inline.form.submit();
  assert.equal(inline.fields.hidden, true);
  assert.equal(inline.success.hidden, false);
  assert.equal(inline.container.getAttribute('aria-labelledby'), 'test-success-heading');
  assert.equal(inline.form.classList.contains('is-success'), true);
  await popup.form.submit();
  assert.equal(popup.message.textContent, 'THANK YOU FOR JOINING\nExisting email preferences are preserved.');
  assert.equal(popup.fields.hidden, true);
  assert.equal(popup.success.hidden, false);
  popup.email.value = 'hello@example.com'; popup.consent.checked = true;
  await popup.form.submit();
  assert.deepEqual(results, ['accepted', 'accepted']);
  assert.equal(inline.message.textContent, 'THANK YOU FOR JOINING\nExisting email preferences are preserved.');
  assert.equal(inline.message.getAttribute('role'), 'status');
  assert.equal(inline.message.classList.contains('visually-hidden'), true);
  assert.equal(popup.message.getAttribute('role'), 'alert');
  assert.match(popup.message.textContent, /try again later/);
  assert.equal(requests.length, 3);
  assert.ok(requests.every(request => request.url === '/api/newsletter' && request.body.consent === true));
});

test('halfway scroll opens the popup once, but only after the minimum dwell', () => {
  const clock = timers();
  let time = 0;
  let opens = 0;
  const popup = createNewsletterPopupController({ storage: storage(), now: () => time, setTimer: clock.setTimer, clearTimer: clock.clearTimer, onOpen: () => { opens++; } });
  popup.scrolled(1);
  assert.equal(opens, 0, 'scroll before scheduling is ignored');
  popup.schedule();
  popup.scrolled(NEWSLETTER_POPUP_SCROLL_DEPTH - 0.01);
  assert.equal(clock.delay, NEWSLETTER_POPUP_DELAY_MS, 'a shallow scroll keeps the 20-second timer');
  time = NEWSLETTER_POPUP_SCROLL_MIN_MS;
  popup.scrolled(NEWSLETTER_POPUP_SCROLL_DEPTH - 0.01);
  assert.equal(opens, 0);
  popup.scrolled(NEWSLETTER_POPUP_SCROLL_DEPTH);
  assert.equal(opens, 1);
  assert.equal(clock.pending, false, 'the timer is cancelled once the popup opens');
  popup.scrolled(1);
  clock.fire();
  assert.equal(opens, 1);
});

test('a blocked open keeps the timer armed, and dismissed visitors ignore scroll', () => {
  const clock = timers();
  let time = 0;
  let allowed = false;
  let opens = 0;
  const popup = createNewsletterPopupController({ storage: storage(), now: () => time, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    onOpen: () => { if (!allowed) return false; opens++; return true; } });
  popup.schedule();
  time = NEWSLETTER_POPUP_SCROLL_MIN_MS;
  popup.scrolled(0.9);
  assert.equal(opens, 0);
  assert.equal(clock.pending, true);
  allowed = true;
  clock.fire();
  assert.equal(opens, 1);

  const saved = storage();
  createNewsletterPopupController({ storage: saved, now: () => 0 }).dismiss();
  let reopened = 0;
  const later = createNewsletterPopupController({ storage: saved, now: () => NEWSLETTER_POPUP_SCROLL_MIN_MS, onOpen: () => { reopened++; } });
  later.schedule();
  later.scrolled(1);
  assert.equal(reopened, 0);
});

test('popup does not open over menus, other dialogs, or while a visitor is typing', () => {
  const mainSource = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(mainSource, /#mobile-menu:not\(\[hidden\]\), \.header-info\[open\]/);
  assert.match(mainSource, /!document\.querySelector\('dialog\[open\]'\)/);
  assert.match(mainSource, /!cartIsOpen && !lightboxOverlay && !menuOpen && !typing/);
  assert.match(mainSource, /addEventListener\('scroll', onScroll, \{ passive: true \}\)/);
});

test('an early halfway scroll opens the popup at the end of the dwell without another scroll', () => {
  const clock = timers();
  let time = 0;
  let opens = 0;
  const popup = createNewsletterPopupController({ storage: storage(), now: () => time, setTimer: clock.setTimer, clearTimer: clock.clearTimer, onOpen: () => { opens++; } });
  popup.schedule();
  time = 3_000;
  popup.scrolled(0.6);
  assert.equal(opens, 0, 'never opens before the dwell, even after a restored or early scroll');
  assert.equal(clock.delay, NEWSLETTER_POPUP_SCROLL_MIN_MS - 3_000, 'the single timer moves up to the 5-second mark');
  time = NEWSLETTER_POPUP_SCROLL_MIN_MS;
  clock.fire();
  assert.equal(opens, 1);
  assert.equal(clock.pending, false);
  popup.scrolled(1);
  assert.equal(opens, 1, 'still once per visit');
});

test('a blocked dwell-end open falls back to the 20-second deadline', () => {
  const clock = timers();
  let time = 0;
  let allowed = false;
  let opens = 0;
  const popup = createNewsletterPopupController({ storage: storage(), now: () => time, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    onOpen: () => { if (!allowed) return false; opens++; return true; } });
  popup.schedule();
  time = 1_000;
  popup.scrolled(1);
  time = NEWSLETTER_POPUP_SCROLL_MIN_MS;
  clock.fire();
  assert.equal(opens, 0, 'blocked by the cart, a menu, a dialog, or typing');
  assert.equal(clock.pending, true);
  assert.equal(clock.delay, NEWSLETTER_POPUP_DELAY_MS - NEWSLETTER_POPUP_SCROLL_MIN_MS);
  allowed = true;
  time = NEWSLETTER_POPUP_DELAY_MS;
  clock.fire();
  assert.equal(opens, 1);

  const dismissed = storage();
  createNewsletterPopupController({ storage: dismissed, now: () => 0 }).dismiss();
  const quietClock = timers();
  const quiet = createNewsletterPopupController({ storage: dismissed, now: () => 1_000, setTimer: quietClock.setTimer, clearTimer: quietClock.clearTimer });
  quiet.schedule();
  quiet.scrolled(1);
  assert.equal(quietClock.pending, false, 'a dismissed visitor arms no timer');
});

test('closing never restores focus to a hidden or removed element and does not scroll', async () => {
  const documentRef = { activeElement: null, body: { classList: { add() {}, remove() {} } } };
  const opener = element(documentRef);
  const heading = element(documentRef);
  const closeButton = element(documentRef);
  const dialog = element(documentRef);
  dialog.open = false;
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; };
  dialog.querySelectorAll = () => [closeButton];
  let focusOptions = null;
  heading.focus = function (options) { focusOptions = options; documentRef.activeElement = this; };
  const ui = installNewsletterDialog({ dialog, closeButton, documentRef, canOpen: () => true, onDismiss() {}, fallbackFocus: () => heading });

  documentRef.activeElement = opener;
  ui.open();
  opener.hidden = true;
  await dialog.fire('cancel', { preventDefault() {} });
  assert.equal(documentRef.activeElement, heading, 'a hidden opener falls back to the main heading');
  assert.deepEqual(focusOptions, { preventScroll: true });

  opener.hidden = false;
  documentRef.activeElement = opener;
  ui.open();
  opener.isConnected = false;
  await dialog.fire('cancel', { preventDefault() {} });
  assert.equal(documentRef.activeElement, heading, 'a removed opener falls back too');

  const inMenu = element(documentRef);
  inMenu.closest = selector => selector === '[hidden], [inert]' ? {} : null;
  documentRef.activeElement = inMenu;
  ui.open();
  await closeButton.fire('click');
  assert.equal(documentRef.activeElement, heading, 'an element inside a now-hidden menu is skipped');

  const visible = element(documentRef);
  documentRef.activeElement = visible;
  ui.open();
  await closeButton.fire('click');
  assert.equal(documentRef.activeElement, visible, 'a visible opener gets focus back');
});

test('with nothing to return to, the popup prefers an on-screen control, then a visible heading, then main', () => {
  const mainSource = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(mainSource, /\.filter\(element => isVisibleFocusTarget\(element\)\);/);
  assert.match(mainSource, /return isVisibleFocusTarget\(heading\) \? heading : main;/);
});

function dialogFixture() {
  const classes = new Set();
  const documentRef = { activeElement: null, body: null };
  documentRef.body = { ...element(documentRef), classList: { add: name => classes.add(name), remove: name => classes.delete(name) } };
  const closeButton = element(documentRef);
  const heading = element(documentRef);
  const dialog = element(documentRef);
  dialog.open = false;
  // Like a browser: showModal moves nothing by itself; close() fires 'close' afterwards.
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { if (!dialog.open) return; dialog.open = false; queueMicrotask(() => dialog.fire('close')); };
  dialog.querySelectorAll = () => [closeButton];
  dialog.contains = target => target === closeButton;
  let dismissals = 0;
  const ui = installNewsletterDialog({ dialog, closeButton, documentRef, canOpen: () => true, onDismiss: () => dismissals++, fallbackFocus: () => heading });
  return { classes, documentRef, closeButton, heading, dialog, ui, dismissals: () => dismissals };
}

test('Escape that closes the dialog natively (no cancel event) still dismisses and moves focus off Close', async () => {
  const f = dialogFixture();
  const opener = element(f.documentRef);
  f.documentRef.activeElement = opener;
  f.ui.open();
  assert.equal(f.documentRef.activeElement, f.closeButton);
  // Chrome without recent user activation: the dialog closes and only 'close' fires.
  f.dialog.open = false;
  await f.dialog.fire('close');
  assert.equal(f.dismissals(), 1, 'dismissal is persisted');
  assert.equal(f.classes.has('newsletter-open'), false);
  assert.equal(f.documentRef.activeElement, opener);
});

test('a timer-opened popup with nothing focused returns focus to the main heading, not body or Close', async () => {
  const f = dialogFixture();
  f.documentRef.activeElement = f.documentRef.body;
  f.ui.open();
  await f.dialog.fire('cancel', { preventDefault() {} });
  assert.equal(f.documentRef.activeElement, f.heading);
  assert.notEqual(f.documentRef.activeElement, f.closeButton);
});

test('the Close button path and the trailing close event dismiss exactly once', async () => {
  const f = dialogFixture();
  const opener = element(f.documentRef);
  f.documentRef.activeElement = opener;
  f.ui.open();
  await f.closeButton.fire('click');
  await new Promise(resolve => setTimeout(resolve));
  assert.equal(f.dismissals(), 1);
  assert.equal(f.documentRef.activeElement, opener);
  f.ui.open();
  await f.dialog.fire('cancel', { preventDefault() {} });
  await new Promise(resolve => setTimeout(resolve));
  assert.equal(f.dismissals(), 2);
});

test('the on-screen fallback prefers a fully visible control over a partly visible one', () => {
  const mainSource = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(mainSource, /return rect\.top >= 0 && rect\.bottom <= window\.innerHeight;/);
  assert.match(mainSource, /if \(fullyVisible \|\| onScreen\[0\]\) return fullyVisible \|\| onScreen\[0\];/);
});
