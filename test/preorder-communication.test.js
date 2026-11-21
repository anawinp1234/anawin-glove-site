import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PREORDER_TAG, PREORDER_ESTIMATE_METAFIELD, PREORDER_LABEL, PREORDER_ESTIMATE_PREFIX,
  preorderEstimateLine, preorderShippingSection, preorderFaqItems, preorderPaymentNote
} from '../src/policy-content.js';

const docs = new URL('../docs/preorder-emails/', import.meta.url);
const read = name => readFileSync(new URL(name, docs), 'utf8');
const orderConfirmation = read('order-confirmation-preorder.liquid');
const shippingConfirmation = read('shipping-confirmation-preorder-note.liquid');
const delayNotice = read('preorder-delay-notice.md');
const readme = read('README.md');

const policyCopy = [
  preorderShippingSection.heading, ...preorderShippingSection.paragraphs,
  ...preorderFaqItems.flatMap(item => [item.question, ...item.paragraphs]), preorderPaymentNote
].join('\n');
const delayMessage = delayNotice.slice(delayNotice.indexOf('## Subject'), delayNotice.indexOf('## Wording rules'));

const MONTH = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/;
const YEAR = /\b20\d\d\b/;
const URGENCY = /guarantee|hurry|act now|limited time|only \d+ left|don['’]t miss|selling fast/i;
const strip = source => source.replace(/\{%-?\s*comment\s*-?%\}[^]*?\{%-?\s*endcomment\s*-?%\}/g, '');

test('contract constants match the cross-agent preorder contract', () => {
  assert.equal(PREORDER_TAG, 'preorder');
  assert.deepEqual({ ...PREORDER_ESTIMATE_METAFIELD }, { namespace: 'custom', key: 'preorder_ship_estimate' });
  assert.equal(PREORDER_LABEL, 'Preorder');
  assert.equal(PREORDER_ESTIMATE_PREFIX, 'Estimated to ship:');
  assert.equal(preorderEstimateLine('  sample window '), 'Estimated to ship: sample window');
  for (const blank of ['', '   ', null, undefined, 42]) assert.equal(preorderEstimateLine(blank), '');
});

test('policy copy uses site terminology without dates, codes or urgency', () => {
  assert.equal(preorderShippingSection.heading, 'Preorders');
  assert.match(policyCopy, /\bPreorder\b/);
  assert.match(policyCopy, /“Estimated to ship”/);
  assert.doesNotMatch(policyCopy, /pre-order|pre order/i);
  assert.doesNotMatch(policyCopy, MONTH);
  assert.doesNotMatch(policyCopy, YEAR);
  assert.doesNotMatch(policyCopy, /WRECKER100|PREORDER30|discount code/i);
  assert.doesNotMatch(policyCopy, URGENCY);
  assert.match(policyCopy, /not a fixed ship or delivery date/);
  assert.match(policyCopy, /Break-In Service[^.]*completed before the glove ships/);
});

test('preorder updates are described as transactional and never as marketing opt-in', () => {
  assert.match(policyCopy, /do not sign you up for marketing emails or change your email preferences/);
  for (const source of [orderConfirmation, shippingConfirmation, delayMessage]) {
    assert.doesNotMatch(source, /accepts_marketing|email_marketing|marketing_state|subscribe/i);
  }
});

test('policy content is immutable', () => {
  assert.ok(Object.isFrozen(preorderShippingSection) && Object.isFrozen(preorderShippingSection.paragraphs));
  assert.ok(Object.isFrozen(preorderFaqItems) && preorderFaqItems.every(item => Object.isFrozen(item) && Object.isFrozen(item.paragraphs)));
});

for (const [name, source] of [['order confirmation', orderConfirmation], ['shipping confirmation', shippingConfirmation]]) {
  test(`${name} snippet reads the exact tag and metafield and guards on a blank estimate`, () => {
    const code = strip(source);
    assert.match(code, /line\.product\.tags contains 'preorder'/);
    assert.match(code, /line\.product\.metafields\.custom\.preorder_ship_estimate/);
    assert.match(code, /anawin_mf\.value \| default: anawin_mf \| default: '' \| strip/);
    assert.match(code, /contains 'preorder' and anawin_estimate != blank/);
    assert.match(code, /line\.requires_shipping/);
    assert.doesNotMatch(code, /metafields\.(?!custom\.preorder_ship_estimate)/);
  });

  test(`${name} snippet has no hard-coded dates, discount codes or urgency`, () => {
    const code = strip(source);
    assert.doesNotMatch(code, MONTH);
    assert.doesNotMatch(code, YEAR);
    assert.doesNotMatch(source, /WRECKER100|PREORDER30/i);
    assert.doesNotMatch(code, URGENCY);
  });

  test(`${name} snippet has balanced Liquid blocks`, () => {
    const code = strip(source);
    for (const tag of ['if', 'for', 'unless']) {
      const open = code.match(new RegExp(`\\{%-?\\s*${tag}\\b`, 'g'))?.length ?? 0;
      const close = code.match(new RegExp(`\\{%-?\\s*end${tag}\\b`, 'g'))?.length ?? 0;
      assert.equal(open, close, `${tag}/end${tag}`);
    }
    assert.equal((source.match(/\{%-?\s*comment/g) || []).length, (source.match(/\{%-?\s*endcomment/g) || []).length);
  });

  test(`${name} snippet escapes every printed product value`, () => {
    const outputs = [...strip(source).matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)].map(match => match[1]);
    for (const output of outputs.filter(value => /title|estimate/.test(value))) assert.match(output, /\| escape$/, output);
  });
}

test('order confirmation block uses contract strings and handles service, mixed and grouped lines', () => {
  const code = strip(orderConfirmation);
  assert.match(code, /<h3>Preorder<\/h3>/);
  assert.match(code, /Estimated to ship: \{\{ anawin_group_estimate \| escape \}\}/);
  assert.match(code, /Thank you for your ANAWIN preorder\./);
  assert.match(code, /We’ll email you tracking information once your order ships\./);
  assert.match(code, /anawin_property\.first == '_anawin_service' and anawin_property\.last == 'break-in'/);
  assert.match(code, /anawin_has_standard_items/);
  assert.match(code, /split: anawin_sep/);
  assert.match(code, /\{%- if anawin_preorder_count > 0 -%\}/);
});

test('committed order confirmation snippet keeps the preview override empty', () => {
  assert.match(orderConfirmation, /\{%- assign anawin_preorder_preview_estimate = '' -%\}/);
  assert.equal((orderConfirmation.match(/anawin_preorder_preview_estimate =/g) || []).length, 1);
});

test('shipping confirmation note uses fulfillment line items and does not restate an estimate', () => {
  const code = strip(shippingConfirmation);
  assert.match(code, /for anawin_fulfillment_line in fulfillment\.fulfillment_line_items/);
  assert.match(code, /anawin_fulfillment_line\.line_item/);
  assert.match(code, /fulfillment_status == 'partial'/);
  assert.doesNotMatch(code, /Estimated to ship/);
});

test('delay notice draft reads estimates from the metafield and avoids dates, codes and urgency', () => {
  assert.match(delayNotice, /custom\.preorder_ship_estimate/);
  assert.match(delayMessage, /Estimated to ship: \{\{ new_estimate \}\}/);
  assert.match(delayMessage, /\{\{ previous_estimate \}\}/);
  assert.match(delayNotice, /DRAFT, not sent/);
  assert.doesNotMatch(delayNotice, MONTH);
  assert.doesNotMatch(delayNotice, YEAR);
  assert.doesNotMatch(delayNotice, /WRECKER100|PREORDER30/i);
  assert.doesNotMatch(delayMessage, URGENCY);
});

test('preorder docs never hard-code an estimate or mention the private code', () => {
  assert.doesNotMatch(readme, /WRECKER100/i);
  assert.doesNotMatch(readme, /December 20\d\d/i);
  assert.match(readme, /Revert to/);
  assert.match(readme, /Send test email/);
});
