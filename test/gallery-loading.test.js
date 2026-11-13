import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { localProducts, breakInService } from '../src/catalog.js';
import { createStorefrontRenderer } from '../src/storefront-render.js';
import { GALLERY_DESKTOP_MEDIA, GALLERY_PLACEHOLDER, firstGalleryPhotoSettled, holdGallery, installGalleryLoading, releaseDeferredGallery } from '../public/gallery-loading.js';

const galleryOf = html => [...html.matchAll(/<button class="gallery-image"[^]*?<\/button>/g)].map(m => m[0]);

test('rendered galleries are plain pictures that work without the app bundle', async () => {
  const renderer = createStorefrontRenderer({ products: localProducts, breakInService });
  for (const model of ['br16', 'ob16', 'cl16', 'mi26', 'bl50', 'cm24', 'or17']) {
    const images = galleryOf(renderer.route(`/product/${model}`));
    assert.equal(images.length, 4, model);
    assert.ok(images[0].includes('loading="eager" fetchpriority="high"'), model);
    for (const html of images.slice(1)) {
      assert.ok(html.includes('loading="lazy"') && !html.includes('fetchpriority'), model);
      assert.ok(!html.includes('media=') && !html.includes('data-gallery') && !html.includes(GALLERY_PLACEHOLDER) && !html.includes('<noscript>'), model);
    }
  }
  const index = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.ok(!index.includes('<noscript>') && !index.includes('data-gallery'), 'no script-dependent markup in the page template');
  // The loader is a same-origin static module placed before the app bundle (and its stylesheet).
  assert.ok(index.indexOf('<script type="module" src="/gallery-loading.js"></script>') < index.indexOf('/src/main.js'));
});

// Minimal DOM stand-ins: attributes, events, and the image/source pairing of a <picture>.
class FakeElement {
  constructor(attrs = {}) { this.attrs = { ...attrs }; this.listeners = new Map(); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  hasAttribute(name) { return name in this.attrs; }
  removeAttribute(name) { delete this.attrs[name]; }
  addEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || new Set()).add(fn)); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  emit(type, event = {}) { [...(this.listeners.get(type) || [])].forEach(fn => fn(event)); }
  count() { return [...this.listeners.values()].reduce((n, set) => n + set.size, 0); }
}
function fakeGallery({ firstState = 'pending', loadedIndexes = [] } = {}) {
  const images = [1, 2, 3, 4].map(n => {
    const image = new FakeElement({ src: `/images/blue${n}.PNG` });
    const source = new FakeElement({ srcset: `/images/optimized/blue${n}-480.webp 480w` });
    image.parentElement = { querySelector: () => source };
    image.source = source;
    image.complete = loadedIndexes.includes(n - 1);
    image.naturalWidth = image.complete ? 400 : 0;
    image.currentSrc = image.complete ? 'x' : '';
    return image;
  });
  const first = images[0];
  if (firstState === 'loaded') Object.assign(first, { complete: true, naturalWidth: 400, currentSrc: '/images/optimized/blue1-1254.webp' });
  if (firstState === 'broken') Object.assign(first, { complete: true, naturalWidth: 0, currentSrc: '/images/optimized/blue1-1254.webp' });
  const wrap = new FakeElement();
  const gallery = new FakeElement();
  gallery.closest = () => wrap;
  gallery.querySelector = selector => selector === '.gallery-image img' ? first : null;
  gallery.querySelectorAll = selector => selector === '.gallery-image img' ? images
    : selector === 'source[data-gallery-deferred]' ? images.map(i => i.source).filter(s => s.hasAttribute('data-gallery-deferred'))
    : selector === 'img[data-gallery-src]' ? images.filter(i => i.hasAttribute('data-gallery-src')) : [];
  return { gallery, wrap, first, images };
}
const media = (matches = false) => { const m = new FakeElement(); m.matches = matches; return () => m; };
const heldIndexes = ({ images }) => images.map((img, i) => img.getAttribute('src') === GALLERY_PLACEHOLDER ? i : -1).filter(i => i >= 0);
const isReleased = ({ images }) => images.every((img, i) => img.getAttribute('src') === `/images/blue${i + 1}.PNG` && !img.source.hasAttribute('media') && !img.hasAttribute('data-gallery-src'));

test('holding gates photos 2+ to the desktop grid and restores them exactly on release', () => {
  const g = fakeGallery();
  assert.equal(holdGallery(g.gallery), 3);
  assert.deepEqual(heldIndexes(g), [1, 2, 3]);
  for (const image of g.images.slice(1)) {
    assert.equal(image.source.getAttribute('media'), GALLERY_DESKTOP_MEDIA);
    assert.ok(image.source.getAttribute('srcset').startsWith('/images/optimized/'), 'srcset untouched');
  }
  assert.equal(holdGallery(g.gallery), 0, 'holding twice is a no-op');
  assert.equal(releaseDeferredGallery(g.gallery), true);
  assert.ok(isReleased(g));
  assert.equal(releaseDeferredGallery(null), false);
});

test('photos that already loaded are never held back', () => {
  const g = fakeGallery({ loadedIndexes: [2] });
  holdGallery(g.gallery);
  assert.deepEqual(heldIndexes(g), [1, 3]);
});

test('mobile holds until the first photo loads, then releases once and removes listeners', () => {
  const g = fakeGallery();
  let releases = 0;
  installGalleryLoading({ gallery: g.gallery, matchMedia: media(false), onRelease: () => { releases++; } });
  assert.deepEqual(heldIndexes(g), [1, 2, 3]);
  g.first.emit('load');
  assert.ok(isReleased(g));
  g.first.emit('load'); g.wrap.emit('pointerdown');
  assert.equal(releases, 1);
  assert.equal(g.wrap.count() + g.gallery.count() + g.first.count(), 0);
});

test('a failed first photo, touch, focus, keyboard, or gallery scroll each release immediately', () => {
  for (const [target, type] of [['first', 'error'], ['wrap', 'touchstart'], ['wrap', 'pointerdown'], ['wrap', 'focusin'], ['wrap', 'keydown'], ['gallery', 'scroll']]) {
    const g = fakeGallery();
    installGalleryLoading({ gallery: g.gallery, matchMedia: media(false) });
    g[target].emit(type);
    assert.ok(isReleased(g), `${target} ${type}`);
  }
});

test('desktop, released routes, and already-settled first photos never stay held', () => {
  for (const [label, opts, firstState] of [['desktop', { matchMedia: media(true) }, 'pending'], ['released route', { hold: false, matchMedia: media(false) }, 'pending'], ['first loaded', { matchMedia: media(false) }, 'loaded'], ['first broken', { matchMedia: media(false) }, 'broken']]) {
    const g = fakeGallery({ firstState });
    let released = false;
    installGalleryLoading({ gallery: g.gallery, ...opts, onRelease: () => { released = true; } });
    assert.ok(isReleased(g), label);
    assert.ok(released, `${label} reports release`);
  }
  const rotating = fakeGallery();
  const mq = new FakeElement(); mq.matches = false;
  installGalleryLoading({ gallery: rotating.gallery, matchMedia: () => mq });
  mq.emit('change', { matches: true });
  assert.ok(isReleased(rotating), 'switching to desktop releases');
});

test('a failure while holding releases everything instead of leaving placeholders', () => {
  const g = fakeGallery();
  g.images[3].setAttribute = function (name, value) { if (name === 'src' && value === GALLERY_PLACEHOLDER) throw new Error('boom'); FakeElement.prototype.setAttribute.call(this, name, value); };
  let released = false;
  installGalleryLoading({ gallery: g.gallery, matchMedia: media(false), onRelease: () => { released = true; } });
  assert.ok(released);
  assert.deepEqual(heldIndexes(g), []);
  assert.ok(g.images.every(i => !i.source.hasAttribute('media')));
});

test('cleanup before release stops waiting; missing galleries are ignored', () => {
  const g = fakeGallery();
  const stop = installGalleryLoading({ gallery: g.gallery, matchMedia: media(false) });
  stop();
  g.first.emit('load');
  assert.deepEqual(heldIndexes(g), [1, 2, 3]);
  assert.equal(typeof installGalleryLoading({ gallery: null }), 'function');
  assert.equal(firstGalleryPhotoSettled(null), false);
  assert.equal(firstGalleryPhotoSettled({ querySelector: () => ({ complete: true, naturalWidth: 10, currentSrc: 'a.webp' }) }), true, 'loaded');
  assert.equal(firstGalleryPhotoSettled({ querySelector: () => ({ complete: true, naturalWidth: 0, currentSrc: 'a.webp' }) }), true, 'failed');
  assert.equal(firstGalleryPhotoSettled({ querySelector: () => ({ complete: false, naturalWidth: 0, currentSrc: '' }) }), false, 'pending');
});
