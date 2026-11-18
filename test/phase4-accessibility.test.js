import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fullSizeProducts, localProducts } from '../src/catalog.js';

const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');

const channels = hex => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
const luminance = rgb => {
  const [r, g, b] = rgb.map(value => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
};

// color-mix(in srgb, accent P%, #000) scales each sRGB channel by P.
function accentTextShare(selector, variable) {
  const rule = css.match(new RegExp(`${selector.replace(/[.]/g, '\\.')}\\{([^}]*)\\}`));
  assert.ok(rule, `missing ${selector} rule`);
  const mix = rule[1].match(new RegExp(`color:color-mix\\(in srgb,var\\(${variable}\\) (\\d+)%,#000\\)`));
  assert.ok(mix, `${selector} must darken ${variable} for text`);
  return Number(mix[1]) / 100;
}

test('coming-soon accent text meets WCAG AA 4.5:1 for every colorway on white and tinted backgrounds', () => {
  const rules = [['.coming-soon-label', '--card-accent'], ['.full-size-pdp .coming-soon-price', '--pdp-accent']];
  for (const [selector, variable] of rules) {
    const share = accentTextShare(selector, variable);
    for (const product of [...localProducts, ...fullSizeProducts]) {
      const text = channels(product.accentColor).map(value => value * share);
      for (const background of ['#ffffff', '#f5f5f3', product.accentBackground]) {
        const ratio = contrast(text, channels(background));
        assert.ok(ratio >= 4.5, `${selector} ${product.name} on ${background}: ${ratio.toFixed(2)}:1`);
      }
    }
  }
});

// Phase 4 part 2: the browser scan found 9px text on the mobile cart "Remove" button and the model
// switcher's "Current" label; "Sold out" used 9px too (rendered only when a glove is unavailable).
const sizesFor = selector => [...css.matchAll(new RegExp(`(?:^|[}\\s,])${selector.replace(/[.]/g, '\\.')}\\{([^}]*)\\}`, 'gm'))]
  .map(match => match[1].match(/font-size:([\d.]+)px/)?.[1]).filter(Boolean).map(Number);

test('small UI text renders at 11px or larger: cart remove, current model label, sold-out label, legal line', () => {
  for (const selector of ['.remove', '.model-switcher-current small', '.sold-out', '.legal']) {
    const sizes = sizesFor(selector);
    assert.ok(sizes.length, `${selector} has a font-size`);
    assert.ok(sizes.at(-1) >= 11, `${selector} ends at ${sizes.at(-1)}px`);
  }
  // .remove must not depend on a desktop-only override any more.
  assert.ok(sizesFor('.remove').every(size => size >= 11));
});

test('no stylesheet text size is below 10px except the overridden legacy .legal base rule', () => {
  const tiny = [...css.matchAll(/([^{}]+)\{[^}]*font-size:([\d.]+)px/g)].filter(match => Number(match[2]) < 10).map(match => match[1].trim());
  assert.deepEqual(tiny, ['.legal']);
});
