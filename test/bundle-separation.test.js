import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkBundleSeparation } from '../scripts/check-bundle-separation.mjs';
import { testCommerceProfile } from '../scripts/test-store/commerce-profile.mjs';
import { releasedCommerceProfiles } from '../src/released-commerce-profiles.js';

const production = releasedCommerceProfiles[0];
const profileSource = profile => `export default [{
  storeDomain:${JSON.stringify(profile.storeDomain)},checkoutHost:${JSON.stringify(profile.checkoutHost)},
  fullSizeService:${JSON.stringify(profile.fullSizeService)}
}];`;

test('bundle separation scans lazy chunks, HTML and source maps for test identities and private credentials', async t => {
  const root = await mkdtemp(join(tmpdir(), 'a6-separation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'assets', 'entry.js'), profileSource(production));
  assert.deepEqual(await checkBundleSeparation(root, 'production'), { scanned: 1, profileEntries: 1 });
  for (const [filename, content, reason] of [
    ['assets/lazy.js', testCommerceProfile.storeDomain, /Forbidden commerce/],
    ['nested.html', testCommerceProfile.fullSizeService.productId, /Forbidden commerce/],
    ['assets/lazy.js.map', testCommerceProfile.fullSizeService.variantId.split('/').at(-1), /Forbidden commerce/],
    ['nested.html', 'shpat_synthetic_negative_control', /Private Shopify credential/],
    ['assets/lazy.js', '/__fixture', /Unexpected isolated tooling/],
    ['nested.html', 'synthetic-test-token', /Forbidden commerce/]
  ]) {
    const file = join(root, filename);
    await writeFile(file, content);
    await assert.rejects(checkBundleSeparation(root, 'production', { excludedToken: 'synthetic-test-token' }), reason);
    await rm(file);
  }
});

test('the authorized test bundle permits its test profile and rejects a production commerce profile', async t => {
  const root = await mkdtemp(join(tmpdir(), 'a6-test-separation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'entry.js'), profileSource(testCommerceProfile));
  await writeFile(join(root, '_headers'), `Content-Security-Policy-Report-Only: connect-src https://${production.storeDomain}`);
  assert.deepEqual(await checkBundleSeparation(root, 'test'), { scanned: 2, profileEntries: 1 });
  await assert.rejects(checkBundleSeparation(root, 'production'), /Forbidden commerce/);
  await writeFile(join(root, 'unexpected.js'), profileSource(production));
  await assert.rejects(checkBundleSeparation(root, 'test'), /Forbidden commerce/);
});
