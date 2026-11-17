// PDP product-information sections open and close independently. Collapsed panels are
// inert, so their content leaves the tab order and the accessibility tree.
// `open` holds expanded panel ids; pass the same set back after a same-route re-render.
export function installPdpAccordions(root, { open = new Set(), documentRef = document } = {}) {
  const triggers = [...(root?.querySelectorAll('[data-pdp-accordion]') || [])];
  const panelFor = trigger => documentRef.getElementById(trigger.getAttribute('aria-controls'));
  function setExpanded(trigger, expanded) {
    const panel = panelFor(trigger);
    if (!panel) return;
    if (!expanded && panel.contains(documentRef.activeElement)) trigger.focus({ preventScroll: true });
    trigger.setAttribute('aria-expanded', String(expanded));
    panel.inert = !expanded;
    panel.classList.toggle('is-expanded', expanded);
    if (expanded) open.add(panel.id);
    else open.delete(panel.id);
  }
  // Restored sections appear already open; only a shopper's click animates.
  for (const trigger of triggers) {
    const panel = panelFor(trigger);
    if (!panel || !open.has(panel.id)) continue;
    panel.style.transition = 'none';
    setExpanded(trigger, true);
    void panel.offsetHeight;
    panel.style.removeProperty('transition');
  }
  const handlers = triggers.map(trigger => {
    const toggle = () => setExpanded(trigger, trigger.getAttribute('aria-expanded') !== 'true');
    trigger.addEventListener('click', toggle);
    return toggle;
  });
  return () => triggers.forEach((trigger, index) => trigger.removeEventListener('click', handlers[index]));
}
