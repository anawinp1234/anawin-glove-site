import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { seoRoutes } from '../src/seo.js';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url));
const references = [
  '<link rel="icon" type="image/x-icon" sizes="16x16 32x32" href="/favicon.ico" />',
  '<link rel="icon" type="image/png" sizes="96x96" href="/favicon-96x96.png" />',
  '<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />'
];

test('all public documents retain root-relative favicon and touch-icon references', () => {
  const files = ['index.html', ...Object.keys(seoRoutes).map(path => path === '/' ? 'dist/index.html' : `dist${path}.html`), 'dist/404.html'];
  for (const file of files) {
    const html = read(file).toString();
    for (const reference of references) assert.equal(html.split(reference).length - 1, 1, file);
    assert.doesNotMatch(html, /rel="icon"[^>]*anawinlogo/i, file);
  }
});

for (const [file, size, budget] of [['favicon-96x96.png', 96, 4000], ['apple-touch-icon.png', 180, 12000]]) {
  test(`${file} is a compact square, opaque RGB PNG copied unchanged to the build`, () => {
    const data = read(`public/${file}`);
    assert.deepEqual(data.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.equal(data.toString('ascii', 12, 16), 'IHDR');
    assert.equal(data.readUInt32BE(16), size);
    assert.equal(data.readUInt32BE(20), size);
    assert.equal(data[24], 8);
    assert.equal(data[25], 2);
    assert.ok(data.length < budget);
    assert.deepEqual(read(`dist/${file}`), data);
  });
}

test('favicon.ico contains complete 16px and 32px opaque bitmap frames for compatibility', () => {
  const data = read('public/favicon.ico');
  assert.equal(data.readUInt16LE(0), 0);
  assert.equal(data.readUInt16LE(2), 1);
  assert.equal(data.readUInt16LE(4), 2);
  assert.ok(data.length < 6000);
  for (const [index, size] of [16, 32].entries()) {
    const entry = 6 + index * 16;
    assert.equal(data[entry], size);
    assert.equal(data[entry + 1], size);
    assert.equal(data.readUInt16LE(entry + 4), 1);
    assert.equal(data.readUInt16LE(entry + 6), 32);
    const length = data.readUInt32LE(entry + 8);
    const offset = data.readUInt32LE(entry + 12);
    const maskBytes = Math.ceil(size / 32) * 4 * size;
    assert.equal(length, 40 + size * size * 4 + maskBytes);
    assert.ok(offset >= 38 && offset + length <= data.length);
    assert.equal(data.readUInt32LE(offset), 40);
    assert.equal(data.readInt32LE(offset + 4), size);
    assert.equal(data.readInt32LE(offset + 8), size * 2);
    for (let pixel = 0; pixel < size * size; pixel++) assert.equal(data[offset + 40 + pixel * 4 + 3], 255);
    assert.ok(data.subarray(offset + length - maskBytes, offset + length).every(byte => byte === 0));
  }
  assert.deepEqual(read('dist/favicon.ico'), data);
});
