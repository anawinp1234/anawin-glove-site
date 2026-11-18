import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import { localProducts, breakInService } from '../src/catalog.js';
import { createStorefrontRenderer } from '../src/storefront-render.js';
import { zoomImageSources } from '../src/zoom-image.js';

// Phase 4 part 2: AVIF is offered only for the two lead photos (homepage hero, BR16 gallery photo 1).
const renderer = createStorefrontRenderer({ products: localProducts, breakInService });
const read = path => readFile(new URL(`../public${path}`, import.meta.url));
const heroWidths = [480, 640, 800, 960, 1200, 1350];
const br16Avif = [['black1-p3-480', 480, 480], ['black1-p3-960', 960, 960], ['black1-zoom-1045', 1045, 1044]];

// Minimal ISOBMFF walk: top-level boxes, then meta > iprp > ipco properties.
function boxes(buffer, start = 0, end = buffer.length) {
  const list = [];
  for (let offset = start; offset + 8 <= end;) {
    const size = buffer.readUInt32BE(offset);
    assert.ok(size >= 8 && offset + size <= end, 'valid box size');
    list.push({ type: buffer.toString('ascii', offset + 4, offset + 8), body: buffer.subarray(offset + 8, offset + size) });
    offset += size;
  }
  return list;
}
function avifProperties(buffer) {
  const top = boxes(buffer);
  const ftyp = top.find(box => box.type === 'ftyp');
  assert.equal(ftyp.body.toString('ascii', 0, 4), 'avif');
  const meta = top.find(box => box.type === 'meta').body;
  const iprp = boxes(meta, 4).find(box => box.type === 'iprp').body;
  const ipco = boxes(iprp).find(box => box.type === 'ipco').body;
  const props = boxes(ipco);
  const ispe = props.find(box => box.type === 'ispe').body;
  const av1C = props.find(box => box.type === 'av1C').body;
  const colr = props.filter(box => box.type === 'colr').map(box => ({ kind: box.body.toString('ascii', 0, 4), data: box.body.subarray(4) }));
  return {
    size: [ispe.readUInt32BE(4), ispe.readUInt32BE(8)],
    profile: av1C[1] >> 5,
    subsampling: [(av1C[2] >> 3) & 1, (av1C[2] >> 2) & 1],
    icc: colr.find(box => box.kind === 'prof')?.data,
    nclx: colr.find(box => box.kind === 'nclx')?.data
  };
}
async function sourceICC() {
  const png = await read('/images/black1.PNG');
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset), type = png.toString('ascii', offset + 4, offset + 8);
    if (type === 'iCCP') { const data = png.subarray(offset + 8, offset + 8 + length); return inflateSync(data.subarray(data.indexOf(0) + 2)); }
    offset += length + 12;
  }
  throw new Error('black1.PNG has no ICC profile');
}

test('homepage hero offers AVIF first with the same widths and sizes as its unchanged WebP set', () => {
  const hero = renderer.route('/').match(/<picture><source type="image\/avif"[^]*?<\/picture>/)[0];
  const avif = heroWidths.map(width => `/images/optimized/hero-background-${width}.avif ${width}w`).join(', ');
  const webp = heroWidths.map(width => `/images/optimized/hero-background-${width}.webp ${width}w`).join(', ');
  assert.ok(hero.startsWith(`<picture><source type="image/avif" srcset="${avif}" sizes="100vw"><source type="image/webp" srcset="${webp}" sizes="100vw"><img class="hero-background"`));
  assert.match(hero, /loading="eager" fetchpriority="high"/);
});

test('only the BR16 gallery lead photo gains an AVIF source; held photos, cards and other models do not', () => {
  const photos = [...renderer.route('/product/br16').matchAll(/<button class="gallery-image"[^]*?<\/button>/g)].map(match => match[0]);
  const avif = 'srcset="/images/optimized/black1-p3-480.avif 480w, /images/optimized/black1-p3-960.avif 960w, /images/optimized/black1-zoom-1045.avif 1045w" sizes="(max-width: 760px) 90vw, 30vw"';
  assert.ok(photos[0].includes(`<picture><source type="image/avif" ${avif}><source type="image/webp" srcset="/images/optimized/black1-p3-480.webp 480w`));
  // gallery-loading.js holds photos 2+ through their first <source>; they must keep exactly one.
  for (const photo of photos.slice(1)) assert.equal(photo.match(/<source/g).length, 1);
  for (const path of ['/shop', '/product/ob16', '/product/cl16', '/product/mi26', '/about', '/community']) {
    assert.ok(!renderer.route(path).includes('image/avif'), `${path} has no AVIF source`);
  }
});

for (const width of heroWidths) {
  test(`hero ${width}px AVIF is untagged sRGB 4:2:0 baseline profile, like its WebP`, async () => {
    const avif = avifProperties(await read(`/images/optimized/hero-background-${width}.avif`));
    const webp = await read(`/images/optimized/hero-background-${width}.webp`);
    // Same canvas as the shipped lossy WebP (VP8 frame header: 14-bit width and height).
    assert.equal(webp.toString('ascii', 12, 16), 'VP8 ');
    assert.deepEqual(avif.size, [webp.readUInt16LE(26) & 0x3fff, webp.readUInt16LE(28) & 0x3fff]);
    assert.equal(avif.icc, undefined, 'no ICC: the shipped WebP is untagged, so a profile would shift its colour');
    // nclx: primaries 1 (BT.709/sRGB), transfer 13 (sRGB), matrix 6.
    assert.deepEqual([avif.nclx.readUInt16BE(0), avif.nclx.readUInt16BE(2), avif.nclx.readUInt16BE(4)], [1, 13, 6]);
    assert.equal(avif.profile, 0, 'AV1 Main profile for the broadest decoder support');
    assert.deepEqual(avif.subsampling, [1, 1]);
  });
}

for (const [name, width, height] of br16Avif) {
  test(`BR16 ${name} AVIF carries the exact source Display P3 ICC at unchanged dimensions`, async () => {
    const avif = avifProperties(await read(`/images/optimized/${name}.avif`));
    assert.deepEqual(avif.icc, await sourceICC());
    assert.deepEqual(avif.size, [width, height]);
    // 4:4:4 (AV1 High profile): at 4:2:0 no smaller file matched the q95 WebP's measured chroma similarity.
    assert.equal(avif.profile, 1);
    assert.deepEqual(avif.subsampling, [0, 0]);
  });
}

test('the lightbox prefers the AVIF zoom file only once the gallery photo itself loaded as AVIF', () => {
  assert.deepEqual(zoomImageSources('/images/black1.PNG'), ['/images/optimized/black1-zoom-1045.webp', '/images/black1.PNG']);
  assert.deepEqual(zoomImageSources('/images/black1.PNG', { preferAvif: true }),
    ['/images/optimized/black1-zoom-1045.avif', '/images/optimized/black1-zoom-1045.webp', '/images/black1.PNG']);
  assert.deepEqual(zoomImageSources('/images/black2.PNG', { preferAvif: true }), ['/images/optimized/black2-1254.webp', '/images/black2.PNG']);
  assert.deepEqual(zoomImageSources('/images/future.png', { preferAvif: true }), ['/images/future.png']);
});

// --- Decode-failure fallback (public/gallery-loading.js, src/lead-image.js) ---
import { AVIF_FAILED_ATTRIBUTE, fallBackFromAvif, installAvifFallback } from '../public/gallery-loading.js';
import { replaceMarkupPreservingLead, AVIF_FAILED_ATTRIBUTE as LEAD_AVIF_FAILED } from '../src/lead-image.js';

function fakePicture(currentSrc, { complete = false, naturalWidth = 0 } = {}) {
  const sources = [{ type: 'image/avif' }, { type: 'image/webp' }];
  const picture = {
    tagName: 'PICTURE', sources,
    querySelector: selector => (selector === 'source[type="image/avif"]' ? sources.find(s => s.type === 'image/avif') : null) ?? null,
    querySelectorAll: () => sources.filter(s => s.type === 'image/avif')
  };
  for (const source of sources) source.remove = () => sources.splice(sources.indexOf(source), 1);
  const image = { tagName: 'IMG', currentSrc, complete, naturalWidth, parentElement: picture };
  return { picture, image, sources };
}
function fakeDocument(images = []) {
  const attrs = new Set(); const listeners = [];
  return {
    attrs, listeners,
    documentElement: { setAttribute: name => attrs.add(name), hasAttribute: name => attrs.has(name) },
    addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture }),
    removeEventListener: () => {},
    querySelectorAll: () => images
  };
}

test('a failed AVIF lead photo drops its AVIF source so the browser selects the WebP set', () => {
  const doc = fakeDocument();
  const { image, sources } = fakePicture('https://anawinofficial.com/images/optimized/black1-zoom-1045.avif');
  assert.equal(fallBackFromAvif(image, doc), true);
  assert.deepEqual(sources.map(s => s.type), ['image/webp']);
  assert.ok(doc.attrs.has(AVIF_FAILED_ATTRIBUTE));
  assert.equal(AVIF_FAILED_ATTRIBUTE, LEAD_AVIF_FAILED);
  // A failed WebP (or any non-AVIF) image is left to its existing error handling.
  const webp = fakePicture('https://anawinofficial.com/images/optimized/black1-p3-960.webp');
  assert.equal(fallBackFromAvif(webp.image, fakeDocument()), false);
  assert.equal(webp.sources.length, 2);
  assert.equal(fallBackFromAvif({ tagName: 'IMG', currentSrc: '/x.avif', parentElement: { tagName: 'DIV' } }, fakeDocument()), false);
});

test('the fallback listens in the capture phase and also repairs a failure that happened before it ran', () => {
  const early = fakePicture('/images/optimized/hero-background-1200.avif', { complete: true, naturalWidth: 0 });
  const fine = fakePicture('/images/optimized/hero-background-1200.avif', { complete: true, naturalWidth: 1200 });
  const doc = fakeDocument([early.image, fine.image]);
  installAvifFallback(doc);
  assert.deepEqual(early.sources.map(s => s.type), ['image/webp']);
  assert.equal(fine.sources.length, 2, 'a decoded AVIF is kept');
  const [listener] = doc.listeners;
  assert.equal(listener.type, 'error');
  assert.equal(listener.capture, true);
  const late = fakePicture('/images/optimized/black1-p3-960.avif');
  listener.fn({ target: late.image });
  assert.deepEqual(late.sources.map(s => s.type), ['image/webp']);
});

test('after an AVIF failure, re-renders omit AVIF and keep the already-repaired lead picture', () => {
  const page = avif => `<main><picture>${avif ? '<source type="image/avif" srcset="/h.avif 1200w" sizes="100vw">' : ''}<source type="image/webp" srcset="/h.webp 1200w" sizes="100vw"><img src="/h.jpg" loading="eager" fetchpriority="high"></picture></main>`;
  const failed = new Set([AVIF_FAILED_ATTRIBUTE]);
  let current = null;
  const pictureFor = html => { const outerHTML = html.match(/<picture>[^]*?<\/picture>/)?.[0]; if (!outerHTML) return null; const p = { tagName: 'PICTURE', outerHTML, replaceWith: node => { current = node; } }; p.image = { parentElement: p }; return p; };
  const root = {
    inserted: [],
    ownerDocument: { documentElement: { hasAttribute: name => failed.has(name) } },
    set innerHTML(html) { this.inserted.push(html); current = pictureFor(html); },
    querySelector: () => current?.image ?? null
  };
  root.innerHTML = page(false); // the live picture after the fallback removed its AVIF source
  const repaired = current;
  assert.equal(replaceMarkupPreservingLead(root, page(true)), true);
  assert.equal(current, repaired);
  assert.ok(!root.inserted.at(-1).includes('image/avif'), 'no AVIF source is ever inserted again');
  failed.clear();
  assert.equal(replaceMarkupPreservingLead(root, page(true)), false, 'without a failure, AVIF markup is used as rendered');
});
