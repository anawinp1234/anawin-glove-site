import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { localProducts } from '../src/catalog.js';
import { loadZoomImage, zoomImageSource } from '../src/zoom-image.js';

function imageFixture(outcomes = []) {
  const requests = [];
  const image = {
    hidden: false,
    set src(value) { requests.push(value); },
    decode: () => outcomes.shift() || Promise.resolve(),
    removeAttribute(name) { assert.equal(name, 'src'); }
  };
  return { image, requests };
}

for (const [model, color] of [['BR16', 'black'], ['OB16', 'blue'], ['CL16', 'brown']]) {
  for (let view = 1; view <= 4; view++) {
    const original = `/images/${color}${view}.PNG`;
    const optimized = `/images/optimized/${color}${view}-${color === 'black' && view === 1 ? 'zoom-1045' : '1254'}.webp`;
    test(`${model} view ${view} maps to its full-resolution zoom asset and existing PNG`, async () => {
      assert.equal(localProducts.find(p => p.name === model).images[view - 1], original);
      assert.equal(zoomImageSource(original), optimized);
      await access(new URL(`../public${optimized}`, import.meta.url));
      await access(new URL(`../public${original}`, import.meta.url));
      const { image, requests } = imageFixture();
      assert.equal(await loadZoomImage(image, original), 'loaded');
      assert.deepEqual(requests, [optimized]);
      assert.equal(image.hidden, false);
    });
    test(`${model} view ${view} retries only its matching PNG on a load or decode failure`, async () => {
      const { image, requests } = imageFixture([Promise.reject(new Error('decode failed'))]);
      assert.equal(await loadZoomImage(image, original), 'loaded');
      assert.deepEqual(requests, [optimized, original]);
      assert.equal(image.hidden, false);
    });
  }
}

test('BR16 view 1 uses the corrected P3 asset, never the rejected or thumbnail variants', () => {
  assert.equal(zoomImageSource('/images/black1.PNG'), '/images/optimized/black1-zoom-1045.webp');
  assert.notEqual(zoomImageSource('/images/black1.PNG'), '/images/optimized/black1-1045.webp');
  assert.doesNotMatch(zoomImageSource('/images/black1.PNG'), /-(480|768|960)\.webp$/);
});

test('failed optimized and original images remain hidden without an error loop', async () => {
  const { image, requests } = imageFixture([Promise.reject(new Error('WebP unavailable')), Promise.reject(new Error('PNG unavailable'))]);
  assert.equal(await loadZoomImage(image, '/images/blue3.PNG'), 'error');
  assert.deepEqual(requests, ['/images/optimized/blue3-1254.webp', '/images/blue3.PNG']);
  assert.equal(image.hidden, true);
});

test('an unknown photo retains its original without guessing or repeating requests', async () => {
  const { image, requests } = imageFixture([Promise.reject(new Error('unavailable'))]);
  assert.equal(zoomImageSource('/images/future-photo.png'), '/images/future-photo.png');
  assert.equal(await loadZoomImage(image, '/images/future-photo.png'), 'error');
  assert.deepEqual(requests, ['/images/future-photo.png']);
});

test('the image stays hidden until decoding completes', async () => {
  let finish;
  const { image } = imageFixture([new Promise(resolve => { finish = resolve; })]);
  const loading = loadZoomImage(image, '/images/brown2.PNG');
  assert.equal(image.hidden, true);
  finish();
  assert.equal(await loading, 'loaded');
  assert.equal(image.hidden, false);
});

test('closing during decode cancels loading and never retries or reveals the image', async () => {
  let reject;
  const controller = new AbortController();
  const { image, requests } = imageFixture([new Promise((_, fail) => { reject = fail; })]);
  const loading = loadZoomImage(image, '/images/black4.PNG', controller.signal);
  controller.abort();
  assert.equal(await loading, 'aborted');
  reject(new Error('late decoder rejection'));
  await Promise.resolve();
  assert.deepEqual(requests, ['/images/optimized/black4-1254.webp']);
  assert.equal(image.hidden, true);
});

test('an already closed lightbox starts no image request', async () => {
  const controller = new AbortController();
  controller.abort();
  const { image, requests } = imageFixture();
  assert.equal(await loadZoomImage(image, '/images/blue2.PNG', controller.signal), 'aborted');
  assert.deepEqual(requests, []);
});
