import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { breakInService, localProducts } from '../src/catalog.js';
import { createStorefrontRenderer } from '../src/storefront-render.js';
import { renderSeoHead, seoRoutes } from '../src/seo.js';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const template = await readFile(join(dist, 'index.html'), 'utf8');
const views = createStorefrontRenderer({
  products: localProducts,
  breakInService,
  commerceLoading: true
});

function replaceOnce(source, needle, replacement) {
  const first = source.indexOf(needle);
  if (first < 0 || source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(`Expected exactly one ${needle} marker in built index.html.`);
  }
  return source.replace(needle, replacement);
}

function renderDocument(path) {
  const start = '<!-- anawin:seo:start -->';
  const end = '<!-- anawin:seo:end -->';
  const startAt = template.indexOf(start);
  const endAt = template.indexOf(end);
  if (startAt < 0 || endAt < startAt || template.indexOf(start, startAt + start.length) >= 0 || template.indexOf(end, endAt + end.length) >= 0) {
    throw new Error('Built index.html must contain exactly one SEO head marker pair.');
  }
  const head = template.slice(0, startAt) + renderSeoHead(path) + template.slice(endAt + end.length);
  const body = views.header() + (path === '/404' ? '' : views.commerceNotice()) + views.route(path) + views.footer();
  if ((body.match(/<h1\b/g) || []).length !== 1 || !body.includes('<main')) {
    throw new Error(`Prerendered ${path} must contain a main element and exactly one H1.`);
  }
  return replaceOnce(head, '<!-- anawin:app -->', body);
}

const routes = Object.keys(seoRoutes);
if (routes.length !== 12) throw new Error(`Expected 12 public routes, found ${routes.length}.`);
for (const path of routes) {
  const output = path === '/' ? join(dist, 'index.html') : join(dist, `${path.slice(1)}.html`);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, renderDocument(path));
}
await writeFile(join(dist, '404.html'), renderDocument('/404'));
console.log(`Prerendered ${routes.length} public routes and 404.html.`);
