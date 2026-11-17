// Gallery photos are always rendered as normal pictures, so they stay visible when scripting
// is off or the app bundle never runs. Once this loader is running it holds back mobile
// photos 2+ (the desktop grid shows every photo, so desktop is never held) until the first
// photo finishes or fails, or the shopper reaches for the gallery.
//
// Served as-is from /public and loaded by index.html ahead of the stylesheet and app bundle,
// so it holds the prerendered photos before the first layout starts their lazy fetches. It
// releases them on its own, so a failed app bundle never leaves photos held. The app reaches
// it through globalThis.anawinGalleryLoading; if this file never loads, nothing is held.
export const GALLERY_DESKTOP_MEDIA = '(min-width: 761px)';
export const GALLERY_PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
// Listened for on the gallery wrap so the pagination dots count too; scroll does not bubble.
const INTERACTIONS = ['pointerdown', 'touchstart', 'focusin', 'keydown'];

const galleryImages = gallery => [...gallery.querySelectorAll('.gallery-image img')];
const loaded = image => image.complete && image.naturalWidth > 0;

// A first photo that has finished, successfully or not, leaves nothing to protect on re-render.
export function firstGalleryPhotoSettled(root) {
  const first = root?.querySelector('.pdp-gallery .gallery-image img');
  return !!first && first.complete && !!first.currentSrc;
}

// Must run in the same task that inserted the markup, before the browser starts those fetches.
export function holdGallery(gallery) {
  let held = 0;
  galleryImages(gallery).slice(1).forEach(image => {
    if (loaded(image) || image.hasAttribute('data-gallery-src')) return;
    const source = image.parentElement?.querySelector('source');
    if (source) { source.setAttribute('media', GALLERY_DESKTOP_MEDIA); source.setAttribute('data-gallery-deferred', ''); }
    image.setAttribute('data-gallery-src', image.getAttribute('src'));
    image.setAttribute('src', GALLERY_PLACEHOLDER);
    held++;
  });
  return held;
}

export function releaseDeferredGallery(gallery) {
  if (!gallery) return false;
  let released = false;
  gallery.querySelectorAll('source[data-gallery-deferred]').forEach(source => {
    source.removeAttribute('media');
    source.removeAttribute('data-gallery-deferred');
    released = true;
  });
  gallery.querySelectorAll('img[data-gallery-src]').forEach(image => {
    image.setAttribute('src', image.getAttribute('data-gallery-src'));
    image.removeAttribute('data-gallery-src');
    released = true;
  });
  return released;
}

export function installGalleryLoading({ gallery, hold = true, matchMedia = globalThis.matchMedia?.bind(globalThis), onRelease = () => {} } = {}) {
  if (!gallery) return () => {};
  const desktop = matchMedia?.(GALLERY_DESKTOP_MEDIA);
  if (!hold || desktop?.matches) { onRelease(); return () => {}; }
  try {
    if (!holdGallery(gallery)) { onRelease(); return () => {}; }
  } catch (error) {
    // Never leave photos held when holding itself failed.
    releaseDeferredGallery(gallery);
    onRelease();
    return () => {};
  }
  const first = gallery.querySelector('.gallery-image img');
  const wrap = gallery.closest?.('.pdp-gallery-wrap') || gallery;
  let done = false;
  const cleanup = () => {
    INTERACTIONS.forEach(type => wrap.removeEventListener(type, release));
    gallery.removeEventListener('scroll', release);
    first?.removeEventListener('load', release);
    first?.removeEventListener('error', release);
    desktop?.removeEventListener?.('change', onMediaChange);
  };
  function release() {
    if (done) return;
    done = true;
    cleanup();
    releaseDeferredGallery(gallery);
    onRelease();
  }
  function onMediaChange(event) { if (event.matches) release(); }
  INTERACTIONS.forEach(type => wrap.addEventListener(type, release, { passive: true }));
  gallery.addEventListener('scroll', release, { passive: true });
  first?.addEventListener('load', release);
  first?.addEventListener('error', release);
  desktop?.addEventListener?.('change', onMediaChange);
  // Freshly inserted images report completion asynchronously; a first photo that is
  // already settled (loaded or failed) releases now rather than waiting for an event.
  if (!first || (first.complete && first.currentSrc)) release();
  return cleanup;
}

// Lead-first loading. On slow connections, lazy photos within Chrome's lazy-load distance (product
// cards, the footer mark) start while the lead photo (fetchpriority="high": the homepage hero or a
// product's first gallery photo) is still downloading, and share its bandwidth. Hold them until the
// lead photo finishes or fails, the shopper scrolls or interacts, or a safety timeout passes. The
// product gallery is left to the rules above. Markup stays plain, so nothing is held without this file.
export const LEAD_IMAGE_SELECTOR = 'img[fetchpriority="high"]';
export const LEAD_HOLD_TIMEOUT_MS = 6000;
const LEAD_RELEASE_EVENTS = ['scroll', 'pointerdown', 'touchstart', 'keydown'];

export function holdBehindLead(root) {
  let held = 0;
  root.querySelectorAll('img[loading="lazy"]').forEach(image => {
    if (image.closest('.pdp-gallery') || loaded(image) || image.hasAttribute('data-lead-src')) return;
    const picture = image.parentElement?.tagName === 'PICTURE' ? image.parentElement : null;
    picture?.querySelectorAll('source').forEach(source => {
      source.setAttribute('data-lead-media', source.getAttribute('media') ?? '');
      source.setAttribute('media', 'not all');
    });
    image.setAttribute('data-lead-src', image.getAttribute('src'));
    image.setAttribute('src', GALLERY_PLACEHOLDER);
    held++;
  });
  return held;
}

export function releaseBehindLead(root) {
  let released = false;
  root.querySelectorAll('source[data-lead-media]').forEach(source => {
    const media = source.getAttribute('data-lead-media');
    if (media) source.setAttribute('media', media);
    else source.removeAttribute('media');
    source.removeAttribute('data-lead-media');
    released = true;
  });
  root.querySelectorAll('img[data-lead-src]').forEach(image => {
    image.setAttribute('src', image.getAttribute('data-lead-src'));
    image.removeAttribute('data-lead-src');
    released = true;
  });
  return released;
}

export function installLeadFirstLoading({ root = globalThis.document, win = globalThis, setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout } = {}) {
  const lead = root?.querySelector(LEAD_IMAGE_SELECTOR);
  if (!lead || (lead.complete && lead.currentSrc)) return () => {};
  try {
    if (!holdBehindLead(root)) return () => {};
  } catch (error) {
    // Never leave photos held when holding itself failed.
    releaseBehindLead(root);
    return () => {};
  }
  let done = false;
  let timer = null;
  const cleanup = () => {
    lead.removeEventListener('load', release);
    lead.removeEventListener('error', release);
    LEAD_RELEASE_EVENTS.forEach(type => win.removeEventListener?.(type, release));
    if (timer !== null) clearTimer?.(timer);
  };
  function release() {
    if (done) return;
    done = true;
    cleanup();
    releaseBehindLead(root);
  }
  lead.addEventListener('load', release);
  lead.addEventListener('error', release);
  LEAD_RELEASE_EVENTS.forEach(type => win.addEventListener?.(type, release, { passive: true }));
  timer = setTimer?.(release, LEAD_HOLD_TIMEOUT_MS) ?? null;
  // The lead may have settled while the holds were applied.
  if (lead.complete && lead.currentSrc) release();
  // Called before the app replaces this markup: stop listening without starting the discarded fetches.
  return () => { if (!done) { done = true; cleanup(); } };
}

const api = { installGalleryLoading, firstGalleryPhotoSettled, installLeadFirstLoading };
if (typeof document !== 'undefined') {
  globalThis.anawinGalleryLoading = api;
  installGalleryLoading({ gallery: document.querySelector('.pdp-gallery') });
  installLeadFirstLoading();
}
