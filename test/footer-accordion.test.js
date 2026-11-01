import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createStorefrontRenderer, installFooterAccordion } from '../src/storefront-render.js';

const markup = createStorefrontRenderer({ products: [] }).footer();
function fixture(mobile = true) {
  const documentRef = { activeElement: null };
  const changes = new Set();
  const media = { matches: mobile, addEventListener: (_, fn) => changes.add(fn), removeEventListener: (_, fn) => changes.delete(fn) };
  function node() {
    const attributes = new Map();
    const classes = new Set();
    const clicks = new Set();
    return { attributes, classes, clicks, inert: false,
      setAttribute: (key, value) => attributes.set(key, value), getAttribute: key => attributes.get(key), removeAttribute: key => attributes.delete(key),
      classList: { add: value => classes.add(value), toggle: (value, on) => on ? classes.add(value) : classes.delete(value) },
      addEventListener: (_, fn) => clicks.add(fn), removeEventListener: (_, fn) => clicks.delete(fn),
      click: () => { for (const fn of clicks) fn(); }, focus() { documentRef.activeElement = this; },
    };
  }
  const groups = Array.from({ length: 3 }, () => {
    const trigger = node(), panel = node(), link = node();
    panel.contains = element => element === link;
    panel.querySelector = () => link;
    return { trigger, panel, link, querySelector: selector => selector === '.footer-toggle' ? trigger : panel };
  });
  const footer = node();
  footer.querySelectorAll = () => groups;
  const destroy = installFooterAccordion(footer, { windowRef: { matchMedia: () => media }, documentRef });
  return { footer, groups, documentRef, destroy, changes, resize(mobile) { media.matches = mobile; for (const fn of changes) fn(); } };
}
const expanded = group => group.trigger.getAttribute('aria-expanded') === 'true';

test('all mobile footer groups start collapsed, inert and hidden from assistive technology', () => {
  for (const group of fixture().groups) {
    assert.equal(expanded(group), false);
    assert.equal(group.panel.inert, true);
    assert.equal(group.panel.getAttribute('aria-hidden'), 'true');
  }
});
test('each footer heading opens its own links and toggles closed again', () => {
  const { groups } = fixture();
  for (const group of groups) {
    group.trigger.click();
    assert.equal(expanded(group), true);
    assert.equal(group.panel.inert, false);
    assert.equal(group.panel.getAttribute('aria-hidden'), undefined);
    assert.equal(group.panel.classes.has('is-expanded'), true);
    group.trigger.click();
    assert.equal(expanded(group), false);
    assert.equal(group.panel.inert, true);
  }
});
test('opening another footer group closes the previous group', () => {
  const { groups } = fixture();
  groups[0].trigger.click();
  groups[1].trigger.click();
  assert.deepEqual(groups.map(expanded), [false, true, false]);
  assert.equal(groups[0].panel.inert, true);
});
test('desktop footer links remain visible and controls cannot collapse them', () => {
  const { groups } = fixture(false);
  for (const group of groups) {
    group.trigger.click();
    assert.equal(expanded(group), true);
    assert.equal(group.panel.inert, false);
    assert.equal(group.panel.getAttribute('aria-hidden'), undefined);
  }
});
test('resizing to mobile moves focus out of collapsing links and resets every section', () => {
  const ui = fixture(false);
  const focusTrigger = ui.groups[1].trigger.focus.bind(ui.groups[1].trigger);
  ui.groups[1].trigger.focus = () => {
    assert.equal(ui.footer.classes.has('footer-mobile'), true, 'show the trigger before focusing it');
    focusTrigger();
  };
  ui.groups[1].link.focus();
  ui.resize(true);
  assert.equal(ui.documentRef.activeElement, ui.groups[1].trigger);
  assert.deepEqual(ui.groups.map(expanded), [false, false, false]);
});
test('resizing to desktop moves focus from the disappearing trigger to an accessible link', () => {
  const ui = fixture();
  const focusLink = ui.groups[2].link.focus.bind(ui.groups[2].link);
  ui.groups[2].link.focus = () => {
    assert.equal(ui.footer.classes.has('footer-mobile'), true, 'keep the trigger visible until focus transfers');
    focusLink();
  };
  ui.groups[2].trigger.focus();
  ui.resize(false);
  assert.equal(ui.documentRef.activeElement, ui.groups[2].link);
  assert.equal(ui.footer.classes.has('footer-mobile'), false);
  assert.ok(ui.groups.every(group => !group.panel.inert));
  ui.resize(true);
  assert.equal(ui.footer.classes.has('footer-mobile'), true);
  assert.equal(ui.documentRef.activeElement, ui.groups[2].trigger);
  assert.ok(ui.groups.every(group => !expanded(group)));
});
test('closing a panel never leaves focus inside its inert links', () => {
  const ui = fixture();
  ui.groups[0].trigger.click();
  ui.groups[0].link.focus();
  ui.groups[1].trigger.click();
  assert.equal(ui.documentRef.activeElement, ui.groups[0].trigger);
});
test('footer binding cleanup removes media and button listeners across route renders', () => {
  const ui = fixture();
  ui.destroy();
  assert.equal(ui.changes.size, 0);
  for (const group of ui.groups) assert.equal(group.trigger.clicks.size, 0);
  ui.groups[0].trigger.click();
  assert.equal(expanded(ui.groups[0]), false);
});
test('footer uses native keyboard buttons with matching unique panel IDs and accessible headings', () => {
  const ids = [...markup.matchAll(/aria-controls="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(ids, ['footer-navigation', 'footer-connect', 'footer-information']);
  for (const id of ids) {
    assert.ok(markup.includes(`id="${id}"`));
    assert.ok(markup.includes(`type="button" aria-expanded="false" aria-controls="${id}"`));
  }
  assert.equal((markup.match(/<h2 /g) || []).length, 3);
  assert.doesNotMatch(markup, /tabindex="-1"|aria-hidden="true"[^>]*><a/);
});
test('every existing footer destination, routing attribute and external-link protection is preserved', () => {
  const links = [...markup.matchAll(/<a href="([^"]+)"([^>]*)>/g)].map(([, href, attributes]) => ({ href, attributes }));
  const internal = ['/', '/shop', '/about', '/community', '/shipping', '/returns', '/warranty', '/care', '/break-in'];
  const external = ['https://discord.com/invite/acstj7uMt', 'https://www.instagram.com/anawinofficial', 'https://www.tiktok.com/@anawinofficial', 'https://checkout.shopify.com/84529185016/policies/46558740728.html?locale=en', 'https://checkout.shopify.com/84529185016/policies/47782691064.html?locale=en'];
  const mail = ['mailto:support@anawinofficial.com', 'mailto:ray@anawinofficial.com', 'mailto:anawin@anawinofficial.com'];
  assert.deepEqual(links.map(link => link.href).sort(), [...internal, ...external, ...mail].sort());
  for (const link of links) {
    if (internal.includes(link.href)) assert.match(link.attributes, /data-link/);
    if (external.includes(link.href)) assert.match(link.attributes, /target="_blank" rel="noreferrer"/);
  }
  assert.ok(markup.includes(`© ${new Date().getFullYear()} ANAWIN`));
  assert.ok(markup.includes('Baseball gloves'));
});
test('footer styling keeps reduced motion, mobile touch targets and visible keyboard focus', () => {
  const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.footer-toggle:focus-visible\{outline:2px solid #fff/);
  assert.match(css, /\.footer-links a\{[^}]*min-height:44px/);
  assert.match(css, /prefers-reduced-motion:reduce\)\{\s*\.footer-chevron,\.has-footer-accordion \.footer-panel\{transition:none\}/);
});
