// Previous/next wrap around so every product view is reachable from any other.
export function stepLightboxIndex(current, step, count) {
  if (!Number.isInteger(count) || count < 1) return 0;
  return (((current + step) % count) + count) % count;
}

export const lightboxCounter = (index, count) => `${index + 1} of ${count}`;
