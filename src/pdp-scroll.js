// Desktop PDP columns scroll together; whichever column runs out first holds its
// bottom edge in view while the taller one keeps going (and the reverse going up).
export const PDP_SCROLL_MEDIA = '(min-width: 761px)';

// A column that fits under the header sticks at the header; a taller one sticks
// once its bottom reaches the bottom of the viewport.
export function pdpColumnStickyTop({ viewportHeight, columnHeight, headerOffset, bottomGap = 16 }) {
  return Math.min(headerOffset, viewportHeight - columnHeight - bottomGap);
}

export function installPdpScroll({ main, win = window } = {}) {
  if (!main || typeof win.ResizeObserver !== 'function') return () => {};
  const columns = [...main.children].filter(el => el.matches('.pdp-gallery-wrap, .pdp-info'));
  if (!columns.length) return () => {};
  const media = win.matchMedia(PDP_SCROLL_MEDIA);
  let frame = 0;
  const update = () => {
    frame = 0;
    for (const column of columns) {
      if (!media.matches) { column.style.removeProperty('--pdp-column-top'); continue; }
      const headerOffset = parseFloat(win.getComputedStyle(column).getPropertyValue('--pdp-gallery-top')) || 0;
      const top = pdpColumnStickyTop({ viewportHeight: win.innerHeight, columnHeight: column.offsetHeight, headerOffset });
      column.style.setProperty('--pdp-column-top', `${Math.round(top)}px`);
    }
  };
  const schedule = () => { if (!frame) frame = win.requestAnimationFrame(update); };
  const observer = new win.ResizeObserver(schedule);
  columns.forEach(column => observer.observe(column));
  win.addEventListener('resize', schedule);
  media.addEventListener?.('change', schedule);
  update();
  return () => {
    if (frame) win.cancelAnimationFrame(frame);
    observer.disconnect();
    win.removeEventListener('resize', schedule);
    media.removeEventListener?.('change', schedule);
    columns.forEach(column => column.style.removeProperty('--pdp-column-top'));
  };
}
