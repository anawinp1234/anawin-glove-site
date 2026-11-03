import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import { localProducts, breakInService } from '../src/catalog.js';
import { createStorefrontRenderer } from '../src/storefront-render.js';
import { zoomImageSource } from '../src/zoom-image.js';

const renderer = createStorefrontRenderer({ products: localProducts, breakInService });
const gallery = model => [...renderer.route(`/product/${model}`).matchAll(/<button class="gallery-image"[^]*?<\/button>/g)].map(m => m[0]);

// Read container metadata without adding an image-processing runtime dependency.
function chunks(buffer, kind) {
  const result = new Map();
  for (let offset = kind === 'png' ? 8 : 12; offset < buffer.length;) {
    const length = kind === 'png' ? buffer.readUInt32BE(offset) : buffer.readUInt32LE(offset + 4);
    const type = buffer.toString('ascii', offset + (kind === 'png' ? 4 : 0), offset + (kind === 'png' ? 8 : 4));
    result.set(type, buffer.subarray(offset + 8, offset + 8 + length));
    offset += kind === 'png' ? length + 12 : length + 8 + (length % 2);
  }
  return result;
}

test('BR16 gallery selects only color-correct variants with unchanged responsive descriptors', () => {
  const first = gallery('br16')[0];
  assert.match(first, /srcset="\/images\/optimized\/black1-p3-480.webp 480w, \/images\/optimized\/black1-p3-960.webp 960w, \/images\/optimized\/black1-zoom-1045.webp 1045w"/);
  assert.match(first, /sizes="\(max-width: 760px\) 90vw, 30vw"/);
  assert.match(first, /data-image="\/images\/black1.PNG" aria-label="View image 1"/);
  assert.match(first, /<img src="\/images\/black1.PNG" alt="Black \/ Red \/ Gray glove view 1" width="1045" height="1044" loading="eager"/);
});

test('all other gallery photographs keep their sources, order, labels and loading behavior', () => {
  for (const [model, color] of [['br16', 'black'], ['ob16', 'blue'], ['cl16', 'brown']]) {
    const images = gallery(model);
    assert.equal(images.length, 4);
    for (let index = 0; index < 4; index++) {
      const name = `${color}${index + 1}`, html = images[index];
      assert.ok(html.includes(`data-image="/images/${name}.PNG" aria-label="View image ${index + 1}"`));
      assert.ok(html.includes(`loading="${index < 2 ? 'eager' : 'lazy'}"`));
      if (name === 'black1') continue;
      assert.ok(html.includes(`srcset="/images/optimized/${name}-480.webp 480w, /images/optimized/${name}-960.webp 960w, /images/optimized/${name}-1254.webp 1254w"`));
    }
  }
});

test('BR16 cards and recommendations retain their sources and zoom keeps its full-resolution source', () => {
  const shop = renderer.route('/shop');
  assert.ok(shop.includes('/images/optimized/black1-480.webp 480w, /images/optimized/black1-768.webp 768w, /images/optimized/black1-960.webp 960w, /images/optimized/black1-1045.webp 1045w'));
  assert.ok(!shop.includes('black1-p3-'));
  for (const model of ['ob16', 'cl16']) {
    const page = renderer.route(`/product/${model}`);
    assert.ok(!page.includes('black1-p3-'));
    assert.ok(page.includes('/images/optimized/black1-480.webp 480w, /images/optimized/black1-960.webp 960w, /images/optimized/black1-1045.webp 1045w'));
  }
  assert.equal(zoomImageSource('/images/black1.PNG'), '/images/optimized/black1-zoom-1045.webp');
});

for (const width of [480, 960]) {
  test(`BR16 ${width}px WebP contains the original valid Display P3 ICC and correct decoded dimensions`, async () => {
    const png = chunks(await readFile(new URL('../public/images/black1.PNG', import.meta.url)), 'png');
    const iccp = png.get('iCCP');
    const sourceICC = inflateSync(iccp.subarray(iccp.indexOf(0) + 2));
    const buffer = await readFile(new URL(`../public/images/optimized/black1-p3-${width}.webp`, import.meta.url));
    assert.equal(buffer.toString('ascii', 0, 4), 'RIFF');
    assert.equal(buffer.toString('ascii', 8, 12), 'WEBP');
    const webp = chunks(buffer, 'webp'), profile = webp.get('ICCP');
    assert.deepEqual(profile, sourceICC);
    assert.equal(profile.readUInt32BE(0), profile.length);
    assert.equal(profile.toString('ascii', 36, 40), 'acsp');
    assert.equal(profile.toString('ascii', 16, 20), 'RGB ');
    assert.ok(webp.get('VP8X')[0] & 0x20, 'ICC flag must be set');
    const lossless = webp.get('VP8L');
    assert.equal(lossless[0], 0x2f);
    const dimensions = lossless.readUInt32LE(1);
    assert.equal((dimensions & 0x3fff) + 1, width);
    assert.equal(((dimensions >>> 14) & 0x3fff) + 1, width);
    const zoom = chunks(await readFile(new URL('../public/images/optimized/black1-zoom-1045.webp', import.meta.url)), 'webp');
    assert.deepEqual(profile, zoom.get('ICCP'));
  });
}
