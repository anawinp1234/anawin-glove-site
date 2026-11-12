import test from 'node:test';
import assert from 'node:assert/strict';
import { localProducts, breakInService } from '../src/catalog.js';
import { createStorefrontRenderer, GALLERY_DESKTOP_MEDIA, GALLERY_PLACEHOLDER } from '../src/storefront-render.js';
import { installGalleryLoading, releaseDeferredGallery } from '../src/gallery-loading.js';

const galleryOf = html => [...html.matchAll(/<button class="gallery-image"[^]*?<\/button>/g)].map(m => m[0]);

test('released gallery markup is the plain responsive picture with lazy loading', () => {
  const held = galleryOf(createStorefrontRenderer({ products: localProducts, breakInService }).route('/product/ob16'));
  const released = galleryOf(createStorefrontRenderer({ products: localProducts, breakInService, deferGallery: false }).route('/product/ob16'));
  assert.equal(held[0], released[0], 'first photo is identical either way');
  for (let i = 1; i < 4; i++) {
    assert.ok(!released[i].includes('media=') && !released[i].includes('data-gallery'));
    assert.ok(released[i].includes(`<img src="/images/blue${i + 1}.PNG"`) && released[i].includes('loading="lazy"'));
    // Releasing the held markup in place must produce exactly the released srcset.
    const srcset = html => html.match(/srcset="([^"]+)"/)[1];
    assert.equal(srcset(held[i]), srcset(released[i]));
  }
});

test('held photos carry a no-script copy identical to the released picture, hidden only without scripting', async () => {
  const { readFile } = await import('node:fs/promises');
  const held = galleryOf(createStorefrontRenderer({ products: localProducts, breakInService }).route('/product/br16'));
  const released = galleryOf(createStorefrontRenderer({ products: localProducts, breakInService, deferGallery: false }).route('/product/br16'));
  for (let i = 1; i < 4; i++) {
    const noscript = held[i].match(/<noscript>([^]*?)<\/noscript>/)[1];
    assert.equal(noscript, released[i].match(/<picture>[^]*?<\/picture>/)[0]);
    assert.ok(held[i].includes('<picture data-gallery-held>'));
  }
  assert.ok(!held[0].includes('<noscript>'));
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.ok(html.includes('<noscript><style>picture[data-gallery-held]{display:none!important}</style></noscript>'));
});

test('full-size galleries hold back later photos the same way and keep the first photo prioritized', () => {
  const renderer = createStorefrontRenderer({ products: localProducts, breakInService });
  for (const model of ['mi26', 'bl50', 'cm24', 'or17']) {
    const images = galleryOf(renderer.route(`/product/${model}`));
    assert.equal(images.length, 4, model);
    assert.ok(images[0].includes('loading="eager" fetchpriority="high"'), model);
    assert.ok(!images[0].includes('media='), model);
    for (const html of images.slice(1)) {
      assert.ok(html.includes(`media="${GALLERY_DESKTOP_MEDIA}"`) && html.includes(`src="${GALLERY_PLACEHOLDER}"`), model);
    }
  }
});

// Minimal DOM stand-ins: enough for attribute changes and event wiring.
class FakeElement {
  constructor(attrs = {}) { this.attrs = { ...attrs }; this.listeners = new Map(); this.dataset = {}; }
  getAttribute(name) { return this.attrs[name] ?? null; }
  removeAttribute(name) { delete this.attrs[name]; if (name === 'data-gallery-src') delete this.dataset.gallerySrc; }
  addEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || new Set()).add(fn)); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  emit(type, event = {}) { [...(this.listeners.get(type) || [])].forEach(fn => fn(event)); }
  count() { return [...this.listeners.values()].reduce((n, set) => n + set.size, 0); }
}
function fakeGallery({ firstComplete = false } = {}) {
  const first = Object.assign(new FakeElement(), { complete: firstComplete, naturalWidth: firstComplete ? 400 : 0 });
  const sources = [1, 2, 3].map(() => new FakeElement({ media: GALLERY_DESKTOP_MEDIA, 'data-gallery-deferred': '' }));
  const images = [2, 3, 4].map(n => { const img = new FakeElement({ 'data-gallery-src': `/images/blue${n}.PNG` }); img.dataset.gallerySrc = `/images/blue${n}.PNG`; img.src = 'placeholder'; return img; });
  const wrap = new FakeElement();
  const gallery = new FakeElement();
  gallery.closest = () => wrap;
  gallery.querySelector = selector => selector === '.gallery-image img' ? first : (sources.some(s => 'data-gallery-deferred' in s.attrs) || images.some(i => i.dataset.gallerySrc) ? sources[0] : null);
  const pictures = [1, 2, 3].map(() => new FakeElement({ 'data-gallery-held': '' }));
  gallery.querySelectorAll = selector => selector.startsWith('source') ? sources.filter(s => 'data-gallery-deferred' in s.attrs)
    : selector.startsWith('picture') ? pictures.filter(p => 'data-gallery-held' in p.attrs)
    : images.filter(i => i.dataset.gallerySrc);
  return { gallery, wrap, first, sources, images, pictures };
}
const media = (matches = false) => { const m = new FakeElement(); m.matches = matches; return () => m; };
const isReleased = ({ sources, images, pictures }) => sources.every(s => !('media' in s.attrs)) && images.every((img, i) => img.src === `/images/blue${i + 2}.PNG`) && pictures.every(p => !('data-gallery-held' in p.attrs));

test('mobile holds later photos until the first photo loads, then releases them once', () => {
  const g = fakeGallery();
  let releases = 0;
  installGalleryLoading({ gallery: g.gallery, matchMedia: media(false), onRelease: () => { releases++; } });
  assert.ok(!isReleased(g));
  g.first.emit('load');
  assert.ok(isReleased(g));
  g.first.emit('load'); g.wrap.emit('pointerdown');
  assert.equal(releases, 1);
  assert.equal(g.wrap.count() + g.gallery.count() + g.first.count(), 0, 'listeners removed after release');
});

test('a failed first photo, touch, focus, keyboard, or gallery scroll each release immediately', () => {
  for (const [target, type] of [['first', 'error'], ['wrap', 'touchstart'], ['wrap', 'pointerdown'], ['wrap', 'focusin'], ['wrap', 'keydown'], ['gallery', 'scroll']]) {
    const g = fakeGallery();
    installGalleryLoading({ gallery: g.gallery, matchMedia: media(false) });
    g[target].emit(type);
    assert.ok(isReleased(g), `${target} ${type}`);
  }
});

test('desktop grid, an already-complete first photo, or switching to desktop release without waiting', () => {
  const desktop = fakeGallery();
  installGalleryLoading({ gallery: desktop.gallery, matchMedia: media(true) });
  assert.ok(isReleased(desktop));
  const cached = fakeGallery({ firstComplete: true });
  installGalleryLoading({ gallery: cached.gallery, matchMedia: media(false) });
  assert.ok(isReleased(cached));
  const rotating = fakeGallery();
  const mq = new FakeElement(); mq.matches = false;
  installGalleryLoading({ gallery: rotating.gallery, matchMedia: () => mq });
  mq.emit('change', { matches: true });
  assert.ok(isReleased(rotating));
});

test('cleanup before release stops waiting, and released galleries report release for re-renders', () => {
  const g = fakeGallery();
  const stop = installGalleryLoading({ gallery: g.gallery, matchMedia: media(false) });
  stop();
  g.first.emit('load');
  assert.ok(!isReleased(g));
  let released = false;
  const plain = new FakeElement(); plain.querySelector = () => null;
  installGalleryLoading({ gallery: plain, onRelease: () => { released = true; } });
  assert.ok(released, 'nothing held back still counts as released');
  assert.equal(releaseDeferredGallery(null), false);
});
