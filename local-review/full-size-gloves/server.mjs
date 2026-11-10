// Separate loopback-only review server. Nothing here is imported by Vite or src/.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createStorefrontRenderer, escapeHtml as esc } from '../../src/storefront-render.js';
import { localProducts, breakInService } from '../../src/catalog.js';

const root = new URL('../../', import.meta.url);
const here = new URL('./', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', here), 'utf8'));
const renderer = createStorefrontRenderer({ products: localProducts, breakInService });
const colors = ['mint', 'black', 'orange', 'camel'];
const mainSource = await readFile(new URL('src/main.js', root), 'utf8');
// Exercise the actual storefront gallery/lightbox implementation without loading
// its commerce boot, analytics, newsletter, or adding a launch route to the app.
const mobileHandlers = mainSource.slice(mainSource.indexOf('function bindMobileGallery()'), mainSource.indexOf('async function cartAction('));
const lightboxHandlers = mainSource.slice(mainSource.indexOf('const lightboxChevron ='), mainSource.indexOf('async function loadCommerce()'));
if (!mobileHandlers.startsWith('function bindMobileGallery()') || !lightboxHandlers.includes('function closeLightbox()')) throw new Error('Gallery implementation changed; review the extraction.');
const client = `import { loadZoomImage } from '/src/zoom-image.js';
import { containTab } from '/src/dialog.js';
import { stepLightboxIndex, lightboxCounter } from '/src/lightbox-nav.js';
const app = document.querySelector('#app');
const cartIsOpen = false;
let lightboxOverlay = null, lightboxReturnFocus = null, lightboxImageController = null, lightboxGallery = [], lightboxIndex = 0;
${mobileHandlers}\n${lightboxHandlers}
bindMobileGallery();
const buttons = [...document.querySelectorAll('[data-image]')];
buttons.forEach((button, index) => button.addEventListener('click', () => openLightbox(buttons, index)));
window.reviewReady = true;
document.addEventListener('keydown', event => {
  if (!lightboxOverlay) return;
  if (event.key === 'Escape') { event.preventDefault(); closeLightbox(); }
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); stepLightbox(event.key === 'ArrowLeft' ? -1 : 1); }
  else containTab(event, lightboxOverlay, document.activeElement);
});
// Only enable standard browser links in this isolated, gallery-only shell.
document.querySelectorAll('a[data-link]').forEach(a => { if (a.getAttribute('href').startsWith('/product/')) a.href = '/trainer/' + a.getAttribute('href').split('/').pop(); });
`;
const assetFiles = new Map(manifest.flatMap(e => e.outputs.map(o => ['/assets/' + o.file, new URL('assets/' + o.file, here)])));
const sourceFiles = new Map(manifest.map(e => ['/source/' + e.model + '-' + e.angle + '.png', new URL(e.source, root)]));
const allowedModules = new Set(['style.css', 'zoom-image.js', 'dialog.js', 'lightbox-nav.js']);

function page(color, trainer) {
  const entries = manifest.filter(e => e.model === color);
  const usable = entries.filter(e => e.usable);
  const image = (e, i) => {
    const largest = e.outputs.at(-1);
    return `<button type="button" class="gallery-image" data-image="/assets/${largest.file}" aria-label="Expand ${esc(e.alt)}"><picture><source type="image/webp" srcset="${e.outputs.map(o => `/assets/${o.file} ${o.width}w`).join(', ')}" sizes="(max-width: 760px) 90vw, 30vw"><img src="/assets/${largest.file}" width="${largest.width}" height="${largest.height}" alt="${esc(e.alt)}" loading="${i < 2 ? 'eager' : 'lazy'}"></picture></button>`;
  };
  const nav = `<nav class="review-nav" aria-label="Local review models">${colors.map(c => `<a href="/${c}"${c === color && !trainer ? ' aria-current="page"' : ''}>${c.toUpperCase()}</a>`).join('')}<a href="/trainer/br16">BR16 trainer</a><a href="/trainer/ob16">OB16 trainer</a><a href="/trainer/cl16">CL16 trainer</a></nav>`;
  const holds = entries.filter(e => !e.usable);
  const gallery = `<main id="main-content" tabindex="-1" class="pdp"><div class="pdp-main"><div class="pdp-gallery-wrap"><section class="pdp-gallery" aria-label="Product images">${usable.map(image).join('')}</section><div class="gallery-pagination"><span class="gallery-status" aria-live="polite">Image 1 of ${usable.length}</span><div class="gallery-dots" aria-label="Select product image">${usable.map((_, i) => `<button type="button" class="gallery-dot" data-gallery-index="${i}" aria-label="Show image ${i+1} of ${usable.length}" ${i === 0 ? 'aria-current="true"' : ''}></button>`).join('')}</div></div></div><aside class="pdp-info"><p class="eyebrow">LOCAL PHOTO REVIEW / JAPANESE KIP</p><h1>${color.toUpperCase()}</h1><p class="product-descriptor">Full-size glove · model name pending</p><p class="product-pitch">Recommended hero: <strong>${color}_back.png</strong>. Back, palm, thumb/web side, then finger side.</p><p>Entire source frame centered on a white square. No enlargement, color edits or retouching. Open a photo for the storefront’s expanded viewer; use ← / → and Escape.</p><p>Untagged mint, black and camel photos are assumed sRGB. Physical color and leather identity need owner confirmation.</p>${entries.some(e => e.note) ? `<ul>${[...new Set(entries.filter(e => e.note).map(e => e.note))].map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : '<p>All four supplied angles are usable for this local review. No obvious mismatch between views.</p>'}<p>Pricing, size, availability and purchase controls are omitted until product details are approved.</p></aside></div>${holds.length ? `<section class="review-holds"><h2>Held sources — excluded from gallery outputs</h2><p>Replacement palm and finger-side photos are needed to show the entire glove and laces.</p>${holds.map(e => `<figure><img src="/source/${e.model}-${e.angle}.png" alt="${esc(e.alt)} — source clipped at left edge" width="${e.sourceDimensions[0]}" height="${e.sourceDimensions[1]}" loading="lazy"><figcaption>${esc(e.source)}: ${esc(e.note)}</figcaption></figure>`).join('')}</section>` : ''}</main>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${trainer || color.toUpperCase()} — local glove review</title><link rel="stylesheet" href="/src/style.css"><style>.review-banner{padding:12px 16px;background:#111;color:#fff;margin:0}.review-nav{display:flex;flex-wrap:wrap;gap:20px;padding:16px;border-bottom:1px solid #aaa}.review-nav a{padding:8px;text-decoration:underline}.review-nav [aria-current]{font-weight:bold}.review-holds{padding:24px}.review-holds figure{display:inline-block;vertical-align:top;width:min(100%,350px);margin:12px}.review-holds img{display:block;width:100%;height:auto}.review-holds figcaption{overflow-wrap:anywhere}.pdp-info p,.pdp-info li{line-height:1.6}.gallery-image img{mix-blend-mode:normal;object-fit:contain}.gallery-image{background:#fff}a:focus-visible,button:focus-visible{outline:2px solid #145ac6;outline-offset:3px}</style></head><body><div id="app">${renderer.header()}<p class="review-banner">LOCAL ONLY · Photo review · No purchasing</p>${nav}${trainer ? renderer.route('/product/' + trainer) : gallery}${renderer.footer()}</div><script type="module" src="/review.js"></script></body></html>`;
}

http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  const send = (status, type, body) => { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' }); res.end(body); };
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'text/plain', 'Read-only preview');
    if (path === '/review.js') return send(200, 'text/javascript', client);
    if (assetFiles.has(path)) return send(200, 'image/webp', await readFile(assetFiles.get(path)));
    if (sourceFiles.has(path)) return send(200, 'image/png', await readFile(sourceFiles.get(path)));
    if (path.startsWith('/src/') && allowedModules.has(path.slice(5))) return send(200, path.endsWith('.css') ? 'text/css' : 'text/javascript', await readFile(new URL(path.slice(1), root)));
    // Exact public image paths used by the existing trainer renderer only.
    if (/^\/images\/(?:optimized\/)?[a-z0-9_-]+\.(?:webp|PNG|png)$/.test(path)) return send(200, path.endsWith('.webp') ? 'image/webp' : 'image/png', await readFile(new URL('public' + path, root)));
    const color = path === '/' ? 'mint' : path.slice(1);
    const trainer = /^\/trainer\/(br16|ob16|cl16)$/.exec(path)?.[1];
    if (colors.includes(color) || trainer) return send(200, 'text/html', page(trainer ? 'mint' : color, trainer));
    return send(404, 'text/plain', 'No local review page here');
  } catch { return send(404, 'text/plain', 'File unavailable'); }
}).listen(5196, '127.0.0.1', () => console.log('Local glove review: http://127.0.0.1:5196/'));
