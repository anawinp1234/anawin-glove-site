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
