import test from 'node:test';
import assert from 'node:assert/strict';
import { breakInService, fullSizeBreakInService, localProducts } from '../src/catalog.js';

const fullSizeService = { ...fullSizeBreakInService, available: false };
import { createStorefrontRenderer } from '../src/storefront-render.js';
import { replaceMarkupPreservingLead } from '../src/lead-image.js';
import { GALLERY_PLACEHOLDER, LEAD_HOLD_TIMEOUT_MS, holdBehindLead, installLeadFirstLoading, releaseBehindLead } from '../public/gallery-loading.js';

const leadMarkup = html => html.match(/<picture>(?:(?!<\/picture>)[^])*fetchpriority="high"(?:(?!<\/picture>)[^])*<\/picture>/)?.[0] ?? null;

test('prerendered and client-rendered pages produce identical lead photo markup, so the node can be kept', () => {
  const prerender = createStorefrontRenderer({ products: localProducts, breakInService, commerceLoading: true });
  const client = createStorefrontRenderer({ products: localProducts, breakInService, fullSizeService, commerceLoading: false, commerceError: null, commerceRetry: true, cartCount: () => 2, reviewData: {} });
  for (const path of ['/', '/community', '/product/br16', '/product/ob16', '/product/cl16', '/product/mi26', '/product/bl50', '/product/cm24', '/product/or17']) {
    const before = leadMarkup(prerender.route(path));
    assert.ok(before, `${path} has a lead photo`);
    assert.equal(leadMarkup(client.route(path)), before, path);
  }
});

// A root whose innerHTML setter builds one fake <picture> for the lead photo found in the markup.
function fakeRoot(initialHtml) {
  const root = {
    lead: null,
    set innerHTML(html) {
      const markup = leadMarkup(html);
      root.lead = markup && fakePicture(markup);
    },
    querySelector(selector) {
      assert.equal(selector, 'img[fetchpriority="high"]');
      return root.lead?.image ?? null;
    }
  };
  function fakePicture(outerHTML) {
    const picture = { tagName: 'PICTURE', outerHTML, replaceWith(node) { root.lead = node; } };
    picture.image = { parentElement: picture };
    return picture;
  }
  root.innerHTML = initialHtml;
  return root;
}

test('re-rendering keeps the existing lead picture node only when its markup is unchanged', () => {
  const page = src => `<main><picture><source srcset="${src}"><img src="${src}" loading="eager" fetchpriority="high"></picture><p>x</p></main>`;
  const root = fakeRoot(page('/hero.webp'));
  const original = root.lead;
  assert.equal(replaceMarkupPreservingLead(root, page('/hero.webp')), true);
  assert.equal(root.lead, original);
  assert.equal(replaceMarkupPreservingLead(root, page('/other.webp')), false);
  assert.notEqual(root.lead, original);
  assert.equal(replaceMarkupPreservingLead(root, '<main><p>no lead</p></main>'), false);
  assert.equal(root.lead, null);
});

// Minimal elements for the lead-first hold: attributes, events, closest() and <picture> sources.
class El {
  constructor(tagName, attrs = {}, { gallery = false } = {}) { this.tagName = tagName; this.attrs = { ...attrs }; this.listeners = new Map(); this.gallery = gallery; this.children = []; }
  getAttribute(name) { return this.attrs[name] ?? null; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  hasAttribute(name) { return name in this.attrs; }
  removeAttribute(name) { delete this.attrs[name]; }
  closest(selector) { return selector === '.pdp-gallery' && this.gallery ? {} : null; }
  querySelectorAll(selector) { return selector === 'source' ? this.children : []; }
  addEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || new Set()).add(fn)); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  emit(type) { [...(this.listeners.get(type) || [])].forEach(fn => fn()); }
  count() { return [...this.listeners.values()].reduce((n, set) => n + set.size, 0); }
}
function page({ leadComplete = false, cardLoaded = false } = {}) {
  const lead = Object.assign(new El('IMG', { loading: 'eager', fetchpriority: 'high', src: '/hero.jpg' }), { complete: leadComplete, currentSrc: leadComplete ? '/hero.webp' : '' });
  const lazy = (src, options, extra = {}) => {
    const picture = new El('PICTURE');
    const source = new El('SOURCE', { srcset: `${src}.webp 480w`, ...extra });
    picture.children.push(source);
    const image = Object.assign(new El('IMG', { loading: 'lazy', src }, options), { parentElement: picture, complete: false, naturalWidth: 0 });
    return { image, source };
  };
  const card = lazy('/card.png');
  const footer = lazy('/mark.png', {}, { media: '(min-width: 1px)' });
  const gallery = lazy('/gallery2.png', { gallery: true });
  if (cardLoaded) Object.assign(card.image, { complete: true, naturalWidth: 480 });
  const all = [card, footer, gallery];
  const root = {
    querySelector: selector => (selector === 'img[fetchpriority="high"]' ? lead : null),
    querySelectorAll: selector => {
      if (selector === 'img[loading="lazy"]') return all.map(x => x.image);
      if (selector === 'img[data-lead-src]') return all.map(x => x.image).filter(i => i.hasAttribute('data-lead-src'));
      if (selector === 'source[data-lead-media]') return all.map(x => x.source).filter(s => s.hasAttribute('data-lead-media'));
      return [];
    }
  };
  return { root, lead, card, footer, gallery };
}
const fakeWindow = () => new El('WINDOW');
const fakeTimers = () => { const t = { pending: null, cleared: false, set: (fn, ms) => { t.pending = { fn, ms }; return 1; }, clear: () => { t.cleared = true; } }; return t; };

test('lazy photos outside the gallery wait for the lead photo and are restored exactly', () => {
  const { root, card, footer, gallery } = page();
  assert.equal(holdBehindLead(root), 2);
  assert.equal(card.image.getAttribute('src'), GALLERY_PLACEHOLDER);
  assert.equal(card.source.getAttribute('media'), 'not all');
  assert.equal(footer.source.getAttribute('media'), 'not all');
  assert.equal(gallery.image.getAttribute('src'), '/gallery2.png', 'gallery photos follow the gallery rules');
  assert.equal(releaseBehindLead(root), true);
  assert.equal(card.image.getAttribute('src'), '/card.png');
  assert.equal(card.source.hasAttribute('media'), false);
  assert.equal(footer.source.getAttribute('media'), '(min-width: 1px)');
  assert.ok(!card.image.hasAttribute('data-lead-src') && !card.source.hasAttribute('data-lead-media'));
  assert.equal(releaseBehindLead(root), false);
});

for (const [name, trigger] of [
  ['the lead photo loads', ({ lead }) => lead.emit('load')],
  ['the lead photo fails', ({ lead }) => lead.emit('error')],
  ['the shopper scrolls', ({ win }) => win.emit('scroll')],
  ['the shopper touches the page', ({ win }) => win.emit('touchstart')],
  ['a key is pressed', ({ win }) => win.emit('keydown')],
  ['the safety timeout passes', ({ timers }) => timers.pending.fn()]
]) {
  test(`held photos are released once when ${name}, and every listener is removed`, () => {
    const p = page(); const win = fakeWindow(); const timers = fakeTimers();
    installLeadFirstLoading({ root: p.root, win, setTimer: timers.set, clearTimer: timers.clear });
    assert.equal(p.card.image.getAttribute('src'), GALLERY_PLACEHOLDER);
    assert.equal(timers.pending.ms, LEAD_HOLD_TIMEOUT_MS);
    trigger({ ...p, win, timers });
    assert.equal(p.card.image.getAttribute('src'), '/card.png');
    assert.equal(p.lead.count() + win.count(), 0);
    assert.equal(timers.cleared, true);
  });
}

test('nothing is held when the lead photo already finished or there is no lead photo', () => {
  const settled = page({ leadComplete: true });
  installLeadFirstLoading({ root: settled.root, win: fakeWindow(), setTimer: fakeTimers().set });
  assert.equal(settled.card.image.getAttribute('src'), '/card.png');
  const none = page();
  none.root.querySelector = () => null;
  installLeadFirstLoading({ root: none.root, win: fakeWindow(), setTimer: fakeTimers().set });
  assert.equal(none.card.image.getAttribute('src'), '/card.png');
});

test('already loaded photos are never swapped for the placeholder', () => {
  const p = page({ cardLoaded: true });
  assert.equal(holdBehindLead(p.root), 1);
  assert.equal(p.card.image.getAttribute('src'), '/card.png');
});

test('teardown before a re-render stops listening without starting fetches for discarded markup', () => {
  const p = page(); const win = fakeWindow(); const timers = fakeTimers();
  const teardown = installLeadFirstLoading({ root: p.root, win, setTimer: timers.set, clearTimer: timers.clear });
  teardown();
  assert.equal(p.card.image.getAttribute('src'), GALLERY_PLACEHOLDER);
  assert.equal(p.lead.count() + win.count(), 0);
  assert.equal(timers.cleared, true);
});

test('a failure while holding releases anything already held', () => {
  const p = page();
  const original = p.root.querySelectorAll;
  let calls = 0;
  p.root.querySelectorAll = selector => {
    if (selector === 'img[loading="lazy"]') {
      const images = original(selector);
      return { forEach: fn => images.forEach(image => { if (++calls === 2) throw new Error('boom'); fn(image); }) };
    }
    return original(selector);
  };
  installLeadFirstLoading({ root: p.root, win: fakeWindow(), setTimer: fakeTimers().set });
  assert.equal(p.card.image.getAttribute('src'), '/card.png');
  assert.ok(!p.card.image.hasAttribute('data-lead-src'));
});
