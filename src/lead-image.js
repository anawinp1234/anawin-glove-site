// The lead photo (the homepage hero or a product's first gallery photo) is the page's LCP element.
// Replacing the app markup used to recreate it, so its paint restarted after the app bundle ran
// and again after commerce data arrived. When the new markup for it is identical, the existing
// <picture> (with its in-flight or finished request) is moved into the new markup instead.
export const LEAD_IMAGE_SELECTOR = 'img[fetchpriority="high"]';

export function leadPicture(root) {
  const image = root?.querySelector(LEAD_IMAGE_SELECTOR);
  const picture = image?.parentElement;
  return picture && picture.tagName === 'PICTURE' ? picture : null;
}

export function replaceMarkupPreservingLead(root, html) {
  const previous = leadPicture(root);
  const previousMarkup = previous?.outerHTML;
  root.innerHTML = html;
  const next = leadPicture(root);
  if (!previous || !next || next.outerHTML !== previousMarkup) return false;
  next.replaceWith(previous);
  return true;
}
