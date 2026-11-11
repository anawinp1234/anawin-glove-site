import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { breakInService, fullSizeProducts, localProducts } from '../src/catalog.js';
import { createStorefrontRenderer } from '../src/storefront-render.js';
import { productJsonLd, productPath } from '../src/seo.js';

const renderer = createStorefrontRenderer({ products: localProducts, breakInService });
const publicFile = path => new URL(`../public${path}`, import.meta.url);

test('full-size gloves stay out of the purchasable catalog', () => {
  assert.deepEqual(fullSizeProducts.map(product => product.color), ['mint', 'black', 'camel', 'orange']);
  for (const product of fullSizeProducts) {
    assert.equal(product.comingSoon, true);
    assert.ok(!localProducts.some(local => local.id === product.id));
    assert.equal(productPath(product), `/product/${product.name.toLowerCase()}`);
  }
});

test('shared product routes choose the glove type rather than enabling full-size purchases', () => {
  for (const product of [...localProducts, ...fullSizeProducts]) {
    const path = productPath(product);
    assert.ok(path.startsWith('/product/'));
    const html = renderer.route(path);
    assert.match(html, new RegExp(`<h1>${product.name}</h1>`));
    if (product.line === 'full-size') {
      assert.match(html, /class="pdp full-size-pdp"/);
      assert.match(html, /<button type="button" class="add-button" disabled[^>]*>Add to cart — Coming soon<\/button>/);
      assert.doesNotMatch(html, /data-add=|data-break-in/);
      assert.equal(productJsonLd(path), null);
    } else {
      assert.match(html, new RegExp(`data-add="${product.id}"`));
      assert.match(html, /data-break-in/);
      assert.equal(productJsonLd(path)['@type'], 'Product');
    }
  }
  for (const path of ['/product/unknown', '/product/mi26/unknown', '/product/full-mint']) {
    assert.match(renderer.route(path), /class="not-found"/);
  }
});

test('every full-size photo and its WebP sizes exist', () => {
  for (const product of fullSizeProducts) {
    assert.equal(product.images.length, 4, product.name);
    for (const image of product.images) {
      assert.ok(existsSync(publicFile(image.src)), image.src);
      for (const width of [480, 960].filter(width => width < image.width).concat(image.width)) {
        assert.ok(existsSync(publicFile(`/images/full-size/${image.name}-${width}.webp`)), `${image.name}-${width}`);
      }
    }
  }
});

test('Home and Shop show a full-size section with every colorway', () => {
  for (const path of ['/', '/shop']) {
    const html = renderer.route(path);
    assert.match(html, /FULL-SIZE<br><em>GLOVES<\/em>|FULL-SIZE GLOVES/);
    assert.deepEqual([...html.matchAll(/<article class="product-card full-size-card[^>]*data-product="([^"]+)"/g)].map(match => match[1]),
      fullSizeProducts.map(product => product.id));
    assert.equal((html.match(/Coming soon<\/strong>/g) || []).length, fullSizeProducts.length);
  }
});

test('each full-size page shows four photos, all colorways, and a notify form instead of a cart button', () => {
  for (const product of fullSizeProducts) {
    const html = renderer.route(productPath(product));
    assert.equal((html.match(/class="gallery-image"/g) || []).length, 4, product.name);
    assert.match(html, new RegExp(`<h1>${product.name}</h1>`));
    assert.match(html, new RegExp(`aria-current="page" data-product="${product.id}"`));
    for (const other of fullSizeProducts.filter(other => other.id !== product.id)) {
      assert.match(html, new RegExp(`<a href="${productPath(other)}" data-link data-product="${other.id}">${other.name}</a>`));
    }
    assert.match(html, /class="pdp-notify"/);
    assert.match(html, new RegExp(`id="notify-${product.color}-email"`));
    assert.doesNotMatch(html, /data-add=|data-sticky-purchase|data-break-in/);
    assert.equal((html.match(/<h1\b/g) || []).length, 1);
  }
});

function jpegMetadata(buffer) {
  const profiles = [];
  let width, height;
  for (let offset = 2; offset < buffer.length;) {
    assert.equal(buffer[offset], 0xff);
    const marker = buffer[offset + 1];
    if (marker === 0xda || marker === 0xd9) break;
    const length = buffer.readUInt16BE(offset + 2);
    const payload = buffer.subarray(offset + 4, offset + 2 + length);
    if (marker === 0xe2 && payload.toString('ascii', 0, 12) === 'ICC_PROFILE\0') {
      profiles.push({ sequence: payload[12], bytes: payload.subarray(14) });
    }
    if (marker === 0xc0 || marker === 0xc2) {
      height = payload.readUInt16BE(1);
      width = payload.readUInt16BE(3);
    }
    offset += 2 + length;
  }
  return { profile: Buffer.concat(profiles.sort((a, b) => a.sequence - b.sequence).map(part => part.bytes)), width, height };
}

function webpChunks(buffer) {
  assert.equal(buffer.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buffer.toString('ascii', 8, 12), 'WEBP');
  const chunks = new Map();
  for (let offset = 12; offset < buffer.length;) {
    const length = buffer.readUInt32LE(offset + 4);
    chunks.set(buffer.toString('ascii', offset, offset + 4), buffer.subarray(offset + 8, offset + 8 + length));
    offset += 8 + length + (length % 2);
  }
  return chunks;
}

// Fingerprint of the 520-byte LS34H55xG RGB ICC embedded in the approved
// orange_back.png, orange_palm.png and orange_finger_side.png sources.
// The raw photos stay outside Git; CI checks against their captured profile.
const orangeSourceIccHash = '9520dfb2bad1d955a65ba8a3ffecef068e3715ae09486b41067dca1bbd234c29';
for (const [angle, side] of [['back', 456], ['palm', 408], ['finger-side', 522]]) {
  test(`orange ${angle} JPEG and responsive WebPs preserve the approved source ICC and dimensions`, () => {
    const jpeg = jpegMetadata(readFileSync(publicFile(`/images/full-size/orange-${angle}.jpg`)));
    assert.equal(jpeg.profile.length, 520);
    assert.equal(createHash('sha256').update(jpeg.profile).digest('hex'), orangeSourceIccHash);
    assert.equal(jpeg.profile.toString('ascii', 36, 40), 'acsp');
    assert.deepEqual([jpeg.width, jpeg.height], [side, side]);
    for (const width of [480, 960].filter(width => width < side).concat(side)) {
      const chunks = webpChunks(readFileSync(publicFile(`/images/full-size/orange-${angle}-${width}.webp`)));
      assert.deepEqual(chunks.get('ICCP'), jpeg.profile);
      const extended = chunks.get('VP8X');
      assert.ok(extended[0] & 0x20, 'WebP ICC flag must be set');
      assert.deepEqual([extended.readUIntLE(4, 3) + 1, extended.readUIntLE(7, 3) + 1], [width, width]);
    }
  });
}

test('the low-resolution orange palm offers only its native 408px canvas', () => {
  const image = fullSizeProducts.find(product => product.color === 'orange').images[1];
  assert.equal(image.width, 408);
  const html = renderer.route('/product/or17');
  assert.ok(html.includes('srcset="/images/full-size/orange-palm-408.webp 408w"'));
  assert.ok(html.includes('data-image="/images/full-size/orange-palm-408.webp"'));
  for (const width of [480, 960]) assert.equal(existsSync(publicFile(`/images/full-size/orange-palm-${width}.webp`)), false);
});

test('full-size pages offer the confirmed throw-hand options and stay in teaser mode', () => {
  const expected = {
    mint: ['Right-Hand Throw (worn on left hand)', 'Left-Hand Throw (worn on right hand)'],
    black: ['Right-Hand Throw (worn on left hand)', 'Left-Hand Throw (worn on right hand)'],
    orange: ['Right-Hand Throw (worn on left hand)', 'Left-Hand Throw (worn on right hand)'],
    camel: ['Right-Hand Throw (worn on left hand)']
  };
  for (const product of fullSizeProducts) {
    const html = renderer.route(productPath(product));
    const fieldset = html.match(/<fieldset class="full-size-throw-hand">[\s\S]*?<\/fieldset>/)[0];
    const options = [...fieldset.matchAll(/<input type="radio" name="full-size-throw-hand" value="([^"]+)"><span><strong>([^<]+)<\/strong>/g)];
    assert.deepEqual(options.map(match => match[1]), expected[product.color], product.color);
    assert.deepEqual(options.map(match => match[2]), expected[product.color], product.color);
    assert.doesNotMatch(fieldset, /checked/);
    assert.match(html, /Throw hand: Choose one · No break-in service\./);
    assert.match(html, /<button type="button" class="add-button" disabled[^>]*>Add to cart — Coming soon<\/button>/);
    assert.match(html, /class="pdp-notify"/);
    assert.doesNotMatch(html, /in stock|InStock|units? (left|available)|\b\d+ (RHT|LHT)\b/i);
    const spec = product.specs.find(([label]) => label === 'Throw hand')[1];
    assert.equal(spec, expected[product.color].join(' or '));
  }
  const orange = fullSizeProducts.find(product => product.color === 'orange');
  assert.doesNotMatch(orange.metaDescription, /Right-hand throw\.$/);
  assert.match(orange.metaDescription, /Choose right-hand or left-hand throw\./);
});
