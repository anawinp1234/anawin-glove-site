const zoomImages = new Map([
  ['/images/black1.PNG', '/images/optimized/black1-zoom-1045.webp'],
  ['/images/black2.PNG', '/images/optimized/black2-1254.webp'],
  ['/images/black3.PNG', '/images/optimized/black3-1254.webp'],
  ['/images/black4.PNG', '/images/optimized/black4-1254.webp'],
  ['/images/blue1.PNG', '/images/optimized/blue1-1254.webp'],
  ['/images/blue2.PNG', '/images/optimized/blue2-1254.webp'],
  ['/images/blue3.PNG', '/images/optimized/blue3-1254.webp'],
  ['/images/blue4.PNG', '/images/optimized/blue4-1254.webp'],
  ['/images/brown1.PNG', '/images/optimized/brown1-1254.webp'],
  ['/images/brown2.PNG', '/images/optimized/brown2-1254.webp'],
  ['/images/brown3.PNG', '/images/optimized/brown3-1254.webp'],
  ['/images/brown4.PNG', '/images/optimized/brown4-1254.webp']
]);

// AVIF re-encode of the zoom photo with the same ICC profile (Phase 4 part 2). Numerically at least as
// similar to the source as the WebP; not yet approved on a colour-managed device.
const avifZoomImages = new Map([['/images/black1.PNG', '/images/optimized/black1-zoom-1045.avif']]);

export const zoomImageSource = original => zoomImages.get(original) || original;

// preferAvif is set only when the gallery photo itself loaded as AVIF, which proves support and
// reuses the AVIF file the gallery may already have fetched. Otherwise the order is unchanged.
export function zoomImageSources(original, { preferAvif = false } = {}) {
  const optimized = zoomImageSource(original);
  const sources = optimized === original ? [original] : [optimized, original];
  const avif = preferAvif && avifZoomImages.get(original);
  return avif ? [avif, ...sources] : sources;
}

export async function loadZoomImage(image, original, signal, options) {
  image.hidden = true;
  const sources = zoomImageSources(original, options);
  let cancel;
  const canceled = new Promise(resolve => { cancel = resolve; });
  const abort = () => {
    image.removeAttribute('src');
    cancel('aborted');
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for (const src of sources) {
      if (signal?.aborted) return 'aborted';
      image.src = src;
      try {
        const result = await Promise.race([image.decode().then(() => 'loaded'), canceled]);
        if (result === 'aborted' || signal?.aborted) return 'aborted';
        image.hidden = false;
        return 'loaded';
      } catch {
        if (signal?.aborted) return 'aborted';
      }
    }
    return 'error';
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}
