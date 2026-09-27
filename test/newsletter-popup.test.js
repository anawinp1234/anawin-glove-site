import test from 'node:test';
import assert from 'node:assert/strict';
import { createNewsletterSignup } from '../src/newsletter.js';
import { bindNewsletterForm } from '../src/newsletter-form.js';
import {
  createNewsletterPopupController, installNewsletterDialog,
  NEWSLETTER_POPUP_DELAY_MS, NEWSLETTER_POPUP_DISMISS_MS, NEWSLETTER_POPUP_STORAGE_KEY
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
  return {
    isConnected: true,
    textContent: '',
    addEventListener(type, listener) { const group = listeners.get(type) || []; group.push(listener); listeners.set(type, group); },
    async fire(type, event = {}) { for (const listener of listeners.get(type) || []) await listener(event); },
    setAttribute: (key, value) => attrs.set(key, value),
    removeAttribute: key => attrs.delete(key),
    getAttribute: key => attrs.get(key),
    getClientRects: () => [1],
    focus() { if (documentRef) documentRef.activeElement = this; }
  };
}

function formFixture() {
  const email = element(); email.value = 'hello@example.com';
  const consent = element(); consent.checked = true;
  const button = element(); button.textContent = 'SIGN UP';
  const message = element();
  const form = element();
  form.elements = { email, consent };
  form.querySelector = selector => selector === '.newsletter-message' ? message : button;
  form.reset = () => { email.value = ''; consent.checked = false; };
  form.submit = () => form.fire('submit', { preventDefault() {} });
  return { form, email, consent, button, message };
}

test('popup and inline markup use the same labeled, unchecked newsletter form with unique IDs', () => {
  const inline = newsletterFormMarkup('newsletter');
  const popup = newsletterPopupMarkup();
  assert.match(popup, /<dialog class="newsletter-dialog" aria-labelledby="newsletter-popup-heading" aria-describedby="newsletter-popup-copy">/);
  assert.match(popup, /aria-label="Close newsletter signup"/);
  assert.match(popup, /JOIN OUR<br>COMMUNITY/);
  assert.match(popup, /Be the first to hear about new gloves, releases, and what’s next\./);
  assert.match(inline, /for="newsletter-email"/);
  assert.match(popup, /for="newsletter-popup-email"/);
  for (const markup of [inline, popup]) {
    assert.match(markup, /data-newsletter-form/);
    assert.match(markup, /type="email"[^>]*required/);
    assert.match(markup, /type="checkbox"[^>]*required/);
    assert.doesNotMatch(markup, /type="checkbox"[^>]*checked/);
  }
});

test('popup waits ten seconds and never opens immediately', () => {
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

test('accepted signup leaves the success or pending message visible until close', async () => {
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

test('popup and inline bindings share one Shopify signup controller and preserve pending and failure states', async () => {
  const requests = [];
  const states = ['SUBSCRIBED', 'PENDING', 'FAIL'];
  const signup = createNewsletterSignup({ fetchImpl: async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    const state = states.shift();
    return state === 'FAIL' ? { ok: false, status: 503, json: async () => ({ error: 'shopify_unavailable' }) }
      : { ok: true, json: async () => ({ marketingState: state }) };
  } });
  const inline = formFixture();
  const popup = formFixture();
  const results = [];
  bindNewsletterForm(inline.form, signup, result => results.push(result.status));
  bindNewsletterForm(popup.form, signup, result => results.push(result.status));
  await inline.form.submit();
  await popup.form.submit();
  assert.equal(popup.message.textContent, 'Check your email to confirm your signup.');
  popup.email.value = 'hello@example.com'; popup.consent.checked = true;
  await popup.form.submit();
  assert.deepEqual(results, ['success', 'pending']);
  assert.equal(inline.message.textContent, 'YOU’RE IN. WELCOME TO THE COMMUNITY.');
  assert.equal(popup.message.getAttribute('role'), 'alert');
  assert.match(popup.message.textContent, /try again later/);
  assert.equal(requests.length, 3);
  assert.ok(requests.every(request => request.url === '/api/newsletter' && request.body.consent === true));
});
