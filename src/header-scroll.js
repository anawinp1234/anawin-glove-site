export function nextHeaderHidden({ scrollY, previousY, hidden, menuOpen = false }) {
  if (scrollY <= 140 || menuOpen) return false;
  const direction = scrollY - previousY;
  if (direction > 2) return true;
  if (direction < -1) return false;
  return hidden;
}
