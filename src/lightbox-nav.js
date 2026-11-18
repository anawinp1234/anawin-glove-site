// Previous/next wrap around so every product view is reachable from any other.
export function stepLightboxIndex(current, step, count) {
  if (!Number.isInteger(count) || count < 1) return 0;
  return (((current + step) % count) + count) % count;
}

export const lightboxCounter = (index, count) => `${index + 1} of ${count}`;

// A deliberate horizontal swipe steps (1 = next, -1 = previous); anything else returns 0.
// While the shopper has pinch-zoomed the page (visual viewport scale > 1), a one-finger drag pans
// the zoomed photo, so it must never change the image.
export function swipeStep({ dx, dy, scale = 1 }) {
  if (!(scale <= 1.01)) return 0;
  if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return 0;
  return dx < 0 ? 1 : -1;
}
