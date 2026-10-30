import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { breakInService, localProducts } from '../src/catalog.js';
import { createStorefrontRenderer } from '../src/storefront-render.js';
import { canonicalOrigin, routeMetadata, seoRoutes } from '../src/seo.js';

const views = createStorefrontRenderer({ products: localProducts, breakInService });
const invite = 'https://discord.com/invite/acstj7uMt';
const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

test('homepage community invitation follows shopping and links to the community route', () => {
  const html = views.route('/');
  assert.match(html, /<section class="collection">[\s\S]*?<\/section>\s*<section class="community-spotlight"/);
  assert.match(html, /ANAWIN COMMUNITY<\/p><h2 id="discord-heading">BUILT<br>WITH YOU\.<\/h2>/);
  assert.ok(html.includes('Talk baseball. Share your setup. Help shape what comes next.'));
  assert.match(html, /href="\/community" data-link>Explore the community/);
});

test('community has its own route, heading hierarchy and three promised discussion sections', () => {
  const html = views.route('/community');
  assert.equal(html, views.route('/community/'));
  assert.match(html, /<main class="community-page">/);
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
  assert.match(html, /BUILT FOR<br>THE GAME\.<br>BUILT WITH YOU\./);
  assert.ok(html.includes('Built for the baseball community. Built with the baseball community.'));
  for (const [heading, copy] of [
    ['TALK BASEBALL', 'Discuss the game and gear.'],
    ['SHARE YOUR SETUP', 'Share your glove setup with the community.'],
    ['SHAPE WHAT’S NEXT', 'Share feedback and ideas with ANAWIN.']
  ]) {
    assert.ok(html.includes(`>${heading}</h2><p>${copy}</p>`));
  }
  assert.doesNotMatch(html, /01 \/|02 \/|03 \/|aria-hidden="true">0/);
  assert.equal((html.match(/class="community-button"/g) || []).length, 2);
  assert.match(views.route('/community/missing'), /class="not-found"/);
});

test('desktop, mobile and footer offer Community while preserving direct Discord above support', () => {
  const header = views.header();
  for (const nav of ['desktop-nav', 'mobile-nav']) {
    const markup = header.match(new RegExp(`<nav class="${nav}"[^]*?</nav>`))[0];
    assert.match(markup, /href="\/community" data-link>Community<\/a>/);
  }
  const footer = views.footer();
  assert.match(footer, /href="\/community" data-link>Community<\/a>/);
  assert.ok(footer.indexOf('Join our Discord') < footer.indexOf('support@'));
  assert.match(header, /FREE U\.S\. SHIPPING ON ALL ORDERS/);
  for (const html of [views.route('/'), views.route('/community'), footer]) {
    const links = [...html.matchAll(/<a\b[^>]*href="https:\/\/discord[^>]*>/g)];
    assert.ok(links.length);
    for (const [link] of links) {
      assert.ok(link.includes(`href="${invite}"`));
      assert.match(link, /target="_blank"/);
      assert.match(link, /rel="[^"]*noreferrer/);
      assert.doesNotMatch(link, /data-link/);
    }
  }
});

test('community photos use published responsive assets and prioritize only the page hero', () => {
  for (const [path, loading] of [['/', 'lazy'], ['/community', 'eager']]) {
    const html = views.route(path);
    const photo = html.match(/<div class="community-(?:spotlight|hero)-photo">([\s\S]*?)<\/div>/)[1];
    assert.match(photo, /<source type="image\/webp" srcset="/);
    assert.match(photo, /sizes="\(max-width: 760px\) 122vw,/);
    assert.match(photo, /width="1086" height="1448"/);
    assert.ok(photo.includes(`loading="${loading}"`));
    assert.equal(photo.includes('fetchpriority="high"'), loading === 'eager');
    for (const [, asset] of photo.matchAll(/(\/images\/[^\s",]+\.(?:webp|png))/g)) {
      assert.ok(existsSync(new URL(`../public${asset}`, import.meta.url)), asset);
    }
    assert.match(photo, /src="\/images\/optimized\/glovesonfield-1086.webp"/);
    assert.match(photo, /alt="Close-up of colorful ANAWIN baseball gloves/);
    assert.doesNotMatch(photo, /<a\b|hero-background|glovesonfield\.png/);
  }
});

test('community is prerendered with canonical and social metadata and no product offer', () => {
  const html = read('dist/community.html');
  assert.ok(html.includes(views.route('/community')));
  assert.ok(html.includes(`<link rel="canonical" href="${canonicalOrigin}/community"`));
  assert.ok(html.includes(`<meta property="og:url" content="${canonicalOrigin}/community"`));
  assert.ok(html.includes(routeMetadata('/community').title));
  assert.match(html, /property="og:image"/);
  assert.match(html, /name="twitter:card"/);
  assert.doesNotMatch(html, /data-anawin-product|name="robots" content="noindex"/);
  for (const path of Object.keys(seoRoutes)) {
    const page = read(path === '/' ? 'dist/index.html' : `dist${path}.html`);
    assert.match(page, /href="\/community" data-link>Community<\/a>/);
  }
  assert.match(read('dist/404.html'), /name="robots" content="noindex"/);
  assert.match(read('dist/404.html'), /class="not-found"/);
});


test('community social metadata uses a dedicated 1200×630 JPEG teaser', () => {
  const path = '/images/community-social.jpg';
  const html = read('dist/community.html');
  for (const tag of [
    `<meta property="og:image" content="${canonicalOrigin}${path}"`,
    `<meta name="twitter:image" content="${canonicalOrigin}${path}"`
  ]) assert.ok(html.includes(tag));
  assert.equal(routeMetadata('/community').image, path);
  const image = readFileSync(new URL(`../public${path}`, import.meta.url));
  assert.equal(image.readUInt16BE(0), 0xffd8);
  let dimensions;
  for (let offset = 2; offset + 8 < image.length;) {
    assert.equal(image[offset], 0xff);
    const marker = image[offset + 1];
    const length = image.readUInt16BE(offset + 2);
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      dimensions = [image.readUInt16BE(offset + 7), image.readUInt16BE(offset + 5)];
      break;
    }
    assert.ok(length >= 2);
    offset += length + 2;
  }
  assert.deepEqual(dimensions, [1200, 630]);
  assert.ok(image.length < 200_000, 'keep the social preview lightweight');
  assert.equal(existsSync(new URL('../public/images/glovesonfield.png', import.meta.url)), false);
});
