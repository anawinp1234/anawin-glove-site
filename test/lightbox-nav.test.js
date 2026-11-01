import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { lightboxCounter, stepLightboxIndex } from '../src/lightbox-nav.js';

test('lightbox navigation wraps in both directions across the product views', () => {
  assert.equal(stepLightboxIndex(0, 1, 4), 1);
  assert.equal(stepLightboxIndex(3, 1, 4), 0);
  assert.equal(stepLightboxIndex(0, -1, 4), 3);
  assert.equal(stepLightboxIndex(2, -1, 4), 1);
  assert.equal(stepLightboxIndex(0, 1, 1), 0);
});

test('an empty gallery never produces an out-of-range index', () => {
  assert.equal(stepLightboxIndex(0, 1, 0), 0);
  assert.equal(stepLightboxIndex(0, -1, Number.NaN), 0);
});

test('the counter reads as a one-based position', () => {
  assert.equal(lightboxCounter(0, 4), '1 of 4');
  assert.equal(lightboxCounter(3, 4), '4 of 4');
});

// Execute the application's actual open/step/close lifecycle. A minimal DOM
// fixture keeps this regression independent of an installed browser package.
const mainSource = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const lightboxSource = mainSource.slice(mainSource.indexOf('const lightboxChevron'), mainSource.indexOf('async function loadCommerce()'));

function lightboxFixture() {
  let overlay;
  const position = { page: 420, gallery: 352 };
  const app = { inert: false };
  const documentRef = {
    activeElement: null,
    body: { append(element) { overlay = element; }, classList: { add() {}, remove() {} } },
    querySelector() { return { textContent: 'BR16' }; },
    createElement(tag) {
      if (tag === 'img') return { remove() { overlay.image = null; } };
      const close = { focus() { documentRef.activeElement = close; } };
      const status = {};
      const counter = {};
      const nav = {};
      return {
        image: null,
        setAttribute() {},
        addEventListener() {},
        remove() {},
        querySelector(selector) {
          return ({ '.lightbox-close': close, '.lightbox-status': status, '.lightbox-count': counter, '.lightbox-nav': nav, img: this.image })[selector];
        },
        insertBefore(image) { this.image = image; }
      };
    }
  };
  const buttons = Array.from({ length: 4 }, (_, index) => ({
    isConnected: true, dataset: { image: `/images/black${index + 1}.PNG` }, focusCalls: [],
    querySelector() { return { alt: `View ${index + 1}` }; },
    focus(options) {
      this.focusCalls.push(options);
      documentRef.activeElement = this;
      if (!options?.preventScroll) { position.page = 0; position.gallery = index * 352; }
    }
  }));
  const context = {
    document: documentRef, app, AbortController, lightboxCounter, stepLightboxIndex,
    loadZoomImage: () => Promise.resolve('loaded')
  };
  runInNewContext(`let lightboxOverlay, lightboxReturnFocus, lightboxImageController;
    let lightboxGallery = [], lightboxIndex = 0; const cartIsOpen = false;
    ${lightboxSource}
    globalThis.viewer = { openLightbox, stepLightbox, closeLightbox };`, context);
  return { ...context.viewer, buttons, documentRef, position, app };
}

test('closing after image navigation focuses the original opener without scrolling the page or gallery', () => {
  const env = lightboxFixture();
  const opener = env.buttons[1];
  env.openLightbox(env.buttons, 1);
  env.stepLightbox(1);
  env.stepLightbox(1);
  env.stepLightbox(1); // Wrap to an image other than the opener.
  env.closeLightbox();
  assert.equal(env.documentRef.activeElement, opener);
  assert.equal(opener.focusCalls.length, 1);
  assert.equal(opener.focusCalls[0].preventScroll, true);
  assert.ok(env.buttons.filter(button => button !== opener).every(button => !button.focusCalls.length));
  assert.deepEqual(env.position, { page: 420, gallery: 352 });
  assert.equal(env.app.inert, false);
});

test('each new lightbox opening captures its own opener and tolerates a removed opener', () => {
  const env = lightboxFixture();
  env.openLightbox(env.buttons, 0);
  env.stepLightbox(1);
  env.closeLightbox();
  env.openLightbox(env.buttons, 2);
  env.stepLightbox(-1);
  env.closeLightbox();
  assert.equal(env.documentRef.activeElement, env.buttons[2]);
  assert.equal(env.buttons[0].focusCalls.length, 1);
  assert.equal(env.buttons[2].focusCalls.length, 1);
  env.buttons[3].isConnected = false;
  env.openLightbox(env.buttons, 3);
  assert.doesNotThrow(() => env.closeLightbox());
  assert.equal(env.buttons[3].focusCalls.length, 0);
});
