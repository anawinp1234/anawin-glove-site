import { GALLERY_DESKTOP_MEDIA } from './storefront-render.js';

// Releases the gallery photos the renderer held back on mobile (see pictureMarkup).
// They load once the first photo has finished, or immediately when the shopper
// reaches for the gallery, or when the desktop grid (which shows every photo) applies.
// Listened for on the gallery wrap so the pagination dots count too; scroll does not bubble.
const INTERACTIONS = ['pointerdown', 'touchstart', 'focusin', 'keydown'];

export function releaseDeferredGallery(gallery) {
  if (!gallery) return false;
  let released = false;
  gallery.querySelectorAll('source[data-gallery-deferred]').forEach(source => {
    source.removeAttribute('media');
    source.removeAttribute('data-gallery-deferred');
    released = true;
  });
  gallery.querySelectorAll('img[data-gallery-src]').forEach(image => {
    image.src = image.dataset.gallerySrc;
    image.removeAttribute('data-gallery-src');
    released = true;
  });
  gallery.querySelectorAll('picture[data-gallery-held]').forEach(picture => picture.removeAttribute('data-gallery-held'));
  return released;
}

export function installGalleryLoading({ gallery, matchMedia = globalThis.matchMedia?.bind(globalThis), onRelease = () => {} } = {}) {
  if (!gallery?.querySelector('[data-gallery-deferred], [data-gallery-src]')) {
    if (gallery) onRelease();
    return () => {};
  }
  const desktop = matchMedia?.(GALLERY_DESKTOP_MEDIA);
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

  // A complete first photo has either loaded or failed; either way stop holding the rest back.
  if (desktop?.matches || !first || first.complete) {
    release();
    return cleanup;
  }
  INTERACTIONS.forEach(type => wrap.addEventListener(type, release, { passive: true }));
  gallery.addEventListener('scroll', release, { passive: true });
  first.addEventListener('load', release);
  first.addEventListener('error', release);
  desktop?.addEventListener?.('change', onMediaChange);
  return cleanup;
}
