// Publishes the header stack's full height as --site-header-height so the pinned
// product gallery sits right below it and sizes itself to the space that is left.
// The hide-on-scroll slide is a translate, so it never changes this height and
// scrolling never triggers an update. Returns a function that stops tracking.
export function trackHeaderHeight(header, target = document.documentElement) {
  const publish = height => target.style.setProperty('--site-header-height', `${height}px`);
  if (!header) {
    target.style.removeProperty('--site-header-height');
    return () => {};
  }
  if (typeof ResizeObserver !== 'function') {
    publish(header.getBoundingClientRect().height);
    return () => {};
  }
  // The observer reports the starting size before the first paint, so no
  // synchronous measurement is needed here.
  const observer = new ResizeObserver(([entry]) => {
    publish(entry.borderBoxSize?.[0]?.blockSize ?? entry.target.getBoundingClientRect().height);
  });
  observer.observe(header, { box: 'border-box' });
  return () => observer.disconnect();
}
