# Phase 4 audit: structured data, performance, accessibility, security

Branch `1115-audit-phase-4`, audited 2026-11-17 against `https://anawinofficial.com`. Before any edits, the live HTML for `/`, all seven product pages, and the 404 page was identical to a local `VITE_COMMERCE_MODE=local` build of this branch, apart from the hashed bundle name. Live findings therefore describe this source.

## Structured data and the seven product pages

| Check | Result | Evidence |
|---|---|---|
| Trainer `Offer.price` matches Shopify | Pass | Storefront API: `br16`, `ob16`, and `cl16` are 155.0 USD and for sale. JSON-LD: `"price":"155.00","priceCurrency":"USD"` |
| Trainer `availability` | Deferred | Not emitted. See [Deferred](#deferred-improvements) |
| SKU | Pass (omitted) | No variant in Shopify has a SKU |
| `aggregateRating` / `review` | Pass (omitted) | Judge.me shows CL16 at 1 review (5.0), and BR16 and OB16 at 0. Reviews render client-side, so a build-time rating would go stale |
| Full-size pages have no `Product` markup | Pass | Coming Soon. Production sets no full-size Shopify handles. Breadcrumbs only |
| `BreadcrumbList` on all 7 | Pass | Home › Shop › model |
| Title, canonical, OG/Twitter image, single H1 | Pass | Unique titles. Each canonical points to the page itself. Social images return 200 |
| Legacy redirects (11 rules), `http://`, `www` | Pass | All 301 to the canonical HTTPS URL |
| Trailing slash | Pass (minor) | `/product/br16/` → 307 (Cloudflare `drop-trailing-slash`). The canonical tag is correct |
| Unknown routes | Pass | `/nope`, `/product/nope`, and `/product/BR16` return 404 with `noindex` |
| Sitemap / robots | Pass | All 7 product URLs are listed, and robots allows all |

## Homepage and product-page performance (mobile LCP)

**Method.** PageSpeed Insights returned *"Quota exceeded … Queries per day"*, and running a downloaded Lighthouse via `npx` was not permitted. These are therefore **lab** numbers from the installed Chrome, driven over the DevTools Protocol like `scripts/browser/break-in-browser.mjs`. Settings: 412×823 at DPR 1.75, mobile UA, 4× CPU slowdown, DevTools network throttling (562.5 ms RTT, 1.47 Mbps down), cache disabled, 3 runs per page, median reported. DevTools throttling is not Lighthouse's simulated throttling, so expect some difference from a PSI score. **No real-user (CrUX) data was obtained.**

| Page | Median LCP | LCP element | LCP bytes | CLS |
|---|---|---|---|---|
| `/` | **3.48 s** | `hero-background-800.webp` | 145 KB | 0 |
| `/product/br16` | **4.77 s** | `black1-p3-960.webp` | 426 KB | 0 |
| `/product/ob16` | 2.54 s | `blue1-960.webp` | 95 KB | 0 |
| `/product/cl16` | 2.00 s | `brown1-960.webp` | 54 KB | 0 |
| `/product/mi26` | 2.25 s | `mint-back-960.webp` | 77 KB | 0 |
| `/product/bl50` | 2.32 s | `black-back-960.webp` | 89 KB | 0 |
| `/product/cm24` | 2.08 s | `camel-back-960.webp` | 61 KB | 0 |
| `/product/or17` | 2.32 s | `orange-back-960.webp` | 97 KB | 0 |

Existing image loading is correct, so it was not rebuilt. Each hero is a `<picture>` with a WebP `srcset` and explicit dimensions. It loads `loading="eager"` with `fetchpriority="high"`, and starts at the first network slot (~600 ms, right after TTFB). Images below the fold are lazy.

- **Home (3.5 s):** the hero request starts first but shares bandwidth with the 67 KB JS bundle and four lazy product-card images (~190 KB). Chrome's lazy-load distance threshold pulls those cards in on a slow connection.
- **BR16 (4.8 s):** the Display P3 hero (`black1-p3-960.webp`, 426 KB) is 5× the size of its siblings. It comes from `f3b002d fix: preserve BR16 gallery color accuracy`, so re-encoding it needs a visual colour sign-off. It was not changed here.

### Loading fixes (second pass)

**Confirmed bottlenecks.**
1. *Re-render.* `render()` in `src/main.js` replaced `app.innerHTML` at startup and again when commerce data arrived. That recreated the prerendered hero `<img>` before it had loaded (traced with a MutationObserver: on live, 2 replacements on load and 2 more when Shopify responded at ~3.3 s). The paint then waited for the app bundle. The same happened to every product page's first gallery photo.
2. *Bandwidth contention.* Blocking only the lazy card images on live cut the median homepage LCP from 3.44 s to 3.00 s (5 runs each).

**Fixes.**
- `src/lead-image.js`: `render()` now keeps the existing lead `<picture>` (the `fetchpriority="high"` photo) when the new markup for it is byte-identical. Its in-flight or finished request survives the re-render. A test asserts the prerendered and client-rendered lead markup is identical for `/`, `/community`, and all seven product pages.
- `public/gallery-loading.js` (`installLeadFirstLoading`): while the lead photo is loading, other `loading="lazy"` photos outside the product gallery (cards, footer mark, community photo) are held on a placeholder. They are released when the lead finishes or fails, on any scroll, pointer, touch, or key event, or after 6 s. Holding uses the existing gallery technique and plain markup, so nothing is held if the script never runs. A failed hold releases immediately.

**Before and after, identical conditions.** Both builds were served from local `dist/` copies by the same gzip static server. Settings: same Chrome, 412×823 at DPR 1.75, 4× CPU, 562.5 ms RTT, 1.47 Mbps, cache disabled, 7 runs per page. *Lead paint* is the first animation frame where the connected `fetchpriority="high"` image is complete. Locally, Chrome's own LCP entry for `/` stays on the H1 text both before and after (a hero entry is never emitted locally, although live emits one), so lead paint is the comparable metric. On product pages, lead paint and LCP agree within 20 ms.

| Page | Lead paint before (median) | After (median) | Bytes fetched before LCP |
|---|---|---|---|
| `/` | 3409 ms | **2425 ms** (−29%) | 418 → 231 KB |
| `/product/br16` | 4527 ms | 3966 ms | 494 → 495 KB |
| `/product/ob16` | 2616 ms | 2161 ms | 439 → 445 KB |
| `/product/mi26` | 2117 ms | 2064 ms | 441 → 471 KB |

These are local lab numbers. They do not include Cloudflare's HTTP/2 prioritisation or real-user conditions, and the live site has not been re-measured because this branch is not deployed.

**Regression checks on the new build.**
- At mobile slow-4G and desktop unthrottled, on `/`, `/product/br16`, `/product/mi26`, `/shop`, `/community`, and `/about`: no image is left held or on the placeholder after load, and the hero node is the original prerendered node. After scrolling the whole page, every visible image is loaded.
- The full accessibility run is unchanged from before: 22/22 Phase 2 keyboard checks, no reflow overflow, no CSP violations, and no new contrast findings.

### BR16 image: q95 applied

The owner approved **q95** for all three BR16 files. (q90 was applied briefly from an earlier selection, then replaced.) The files are replaced in place under the existing names, so `src/storefront-render.js`'s gallery and zoom mapping is unchanged. Command: `cwebp -m 6 -q 95 -sharp_yuv -metadata icc`, from `public/images/black1.PNG` resized with Lanczos. The ICC bytes are identical to the source PNG's Display P3 profile.

| File | Original (lossless) | q95 | Profile and dimensions |
|---|---|---|---|
| `black1-p3-480.webp` | 128 KB | 43 KB | Display P3, 480×480 (unchanged) |
| `black1-p3-960.webp` | 426 KB | 134 KB | Display P3, 960×960 (unchanged) |
| `black1-zoom-1045.webp` | 579 KB | 153 KB | Display P3, 1045×1044 (unchanged) |

**BR16 mobile measurements.** Three builds that differ only in these files were served side by side. Same server, Chrome, 4× CPU, 562.5 ms RTT, 1.47 Mbps, cache off, 7 runs, median. *Requested image* is the LCP resource Chrome fetched. *LCP* is Chrome's `largest-contentful-paint` entry. *Image appearance* is the first frame where the connected lead image is complete.

| Viewport | Encoding | Requested image | Transfer | LCP | Image appearance |
|---|---|---|---|---|---|
| 412×823 @ DPR 1.75 | lossless | `black1-p3-960.webp` | 426 KB | 3972 ms | 3962 ms |
| | q90 | `black1-p3-960.webp` | 92 KB | 2160 ms | 2140 ms |
| | **q95** | `black1-p3-960.webp` | 134 KB | **2376 ms** | **2366 ms** |
| 390×844 @ DPR 3 | lossless | `black1-zoom-1045.webp` | 579 KB | 4816 ms | 4807 ms |
| | q90 | `black1-zoom-1045.webp` | 105 KB | 2248 ms | 2230 ms |
| | **q95** | `black1-zoom-1045.webp` | 153 KB | **2508 ms** | **2498 ms** |

At DPR 3 (iPhone class), the gallery's `srcset` selects the 1045 px zoom file for the first photo. The q95 LCP there is **2.51 s, slightly above the 2.5 s target** in this lab profile. That is 2.3 s faster than lossless and ~0.26 s slower than q90.

**Quality.** At 3× zoom in the P3-tagged comparison page, q95 was visually indistinguishable from lossless (mean ΔE00 0.56, 95th percentile 2.38 at 960 px). q90 had shown slight softening of the perforations and of the palm emboss in the desktop zoom view. Final colour judgement was made by the owner on a P3 display. Headless screenshots are sRGB and were used only for detail.

### BR16 image candidates (comparison)

The shipped `black1-p3-480/960.webp` and `black1-zoom-1045.webp` are **lossless** WebP with an embedded Display P3 profile. The candidates were encoded from `public/images/black1.PNG` (Display P3) with `cwebp -m 6 -sharp_yuv -metadata icc`, so the profile is kept. Fidelity is CIEDE2000 against the shipped files, computed through each file's ICC profile.

| 960 px | Size | Mean ΔE00 | 95th pct | SSIM (L) |
|---|---|---|---|---|
| shipped lossless | 426 KB | n/a | n/a | n/a |
| q95 | 133 KB | 0.56 | 2.38 | 0.991 |
| q90 | 91 KB | 0.66 | 2.85 | 0.987 |
| q85 | 67 KB | 0.77 | 3.19 | 0.982 |
| near-lossless 60 | 379 KB | 0.32 | 1.71 | 0.997 |

At 480 px the q95 candidate is 43 KB vs 128 KB shipped. At 1045 px (zoom) it is 152 KB vs 578 KB. At 3× zoom, q95 is visually indistinguishable from the shipped file, q90 slightly softens the perforations, and q85 loses palm leather grain. A side-by-side page with real P3-tagged files was used for the owner's review, which approved q95.

## Accessibility

**Automated, not assistive-technology testing.** All checks ran in headless Chrome over the DevTools Protocol against the live site, then against the local build after the fix. **No screen reader (VoiceOver, NVDA, TalkBack) was used.** Accessible names were checked through Chrome's accessibility tree, which is not the same as hearing announcements.

Pages: `/`, `/shop`, `/product/br16`, `/product/cl16`, `/product/mi26`, `/product/or17`, `/about`, `/faq`, `/community`, `/shipping`, `/nope`. Each ran at 1280 px, a 200% zoom equivalent (640 CSS px at DPR 2), and 320 CSS px.

| Check | Result | Notes |
|---|---|---|
| Phase 2 keyboard behaviors (22 checks) | Pass | Skip link is first and visible, and moves focus to `main`. Cart dialog: opens with Enter, focus moves inside, Tab and Shift+Tab are trapped, background is inert, Escape closes it and returns focus. PDP accordion works with Enter/Space. Lightbox: `role=dialog` and `aria-modal`, arrow keys step through images, Escape returns focus. Mobile menu: Escape closes it and returns focus. Footer accordion toggles |
| Visible focus | Pass | Every Tab stop (45 per page at desktop and mobile) has an outline or box-shadow |
| Focus not obscured | Pass | Once scrolling settles, no focused element is off-screen or ≥50% covered by the sticky header or buy bar (1024, 1280, and 1440 px desktop; 375 px mobile) |
| Contrast | **Fail → fixed** | "Coming soon" text used the raw colorway accent: MI26 mint `#16946d` measured 3.82:1 and OR17 orange `#c85a17` 4.26:1 on white. The other flagged rows were measurement artefacts (white text on dark or image backgrounds), confirmed by an ancestor-background walk and screenshots |
| 200% zoom / 320 px reflow | Pass | No horizontal page scroll on any page. At 200%, the header plus the sticky buy bar take ~42% of the viewport. The header hides on scroll, so this is usability, not a failure |
| Target size (WCAG 2.2 2.5.8, 24 px) | Pass | Undersized targets (FAQ `summary` 15 px and footer policy links 16 px high) all meet the spacing exception |
| Names, labels, alt, ids, lang, landmarks, headings | Pass | No nameless controls or unlabeled inputs. No `img` without `alt`. No duplicate ids. `lang="en"`. One H1 and no skipped heading levels |
| Reduced motion | Pass | With `prefers-reduced-motion: reduce`, `html` scroll-behavior is `auto`, transitions on the header and accordion are 0 s, and no animations are running. JS scrolling uses `instant` or the default |
| Smallest text | Note | 9 px (legal line and cart "remove"). WCAG sets no minimum size, but consider raising it |

## Security headers and Worker responses

| Check | Result | Evidence |
|---|---|---|
| Static responses | Pass | `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, and a report-only CSP, all from `public/_headers` |
| HSTS | Note | Live `strict-transport-security: max-age=86400` comes from the Cloudflare zone, not `_headers`. Raising it to ≥1 year with `includeSubDomains` is a zone change, which was out of scope |
| CSP compatibility | Pass (report-only) | 0 `securitypolicyviolation` events across 33 page loads. Origins contacted: self (including `/cdn-cgi/rum`), `static.cloudflareinsights.com`, `ignvv0-zh.myshopify.com`, `cdn.judge.me`. Checkout leaves via `location.assign`, which CSP does not restrict |
| CSP reporting | Gap | The policy has no `report-to`/`report-uri`, so real-user violations are never collected |
| `/api/newsletter` | Pass | GET and OPTIONS → 405 with `Allow: POST`. Cross-origin POST → 403. Malformed → 400. Invalid email → 400. `text/plain` → 415. All JSON, `no-store`, `nosniff`. No valid signup was submitted |
| `/api/*` unknown | Pass | 404 JSON, `no-store`, `nosniff` |
| Worker responses and `_headers` | Note | `_headers` applies only to static assets, so API responses carry only the Worker's own headers. That is acceptable for JSON |
| Hashed `/assets/*` cache | Fixed locally, not deployed | Live serves `max-age=0, must-revalidate`. `de62391` only added a test forbidding a `_headers` cache rule, because Cloudflare's 404-page fallback would give missing-asset HTML the same long cache. Now `/assets/*` is in `run_worker_first`, and `worker/asset-cache.js` sets `public, max-age=31536000, immutable` only on a 200 or 304 for a Vite-hashed `.js`/`.css` name. See [Completed local work](#completed-local-work) for the `wrangler dev` evidence |
| Asset routing trade-offs | Note | Every JS/CSS request now invokes the Worker (counted against Workers request limits; static-only requests are not). That is about 2 invocations per first page view, offset by browsers not re-requesting immutable files. A deploy still removes the previous build's hashed files (unchanged platform behavior). A page whose HTML was fetched before a deploy can get a 404 for its old bundle until it reloads. HTML is `must-revalidate`, so that window is short |

## Completed local work

Phase 4 uncommitted work on `1115-audit-phase-4`, on top of commit `7f2de1a`. All of it was verified locally: unit tests, local-mode build, headless Chrome lab runs, and `wrangler dev`.

**Already committed in `7f2de1a`:**
- `src/style.css`: "Coming soon" text uses `color-mix(in srgb, <accent> 85%, #000)`. Every colorway is ≥4.5:1 (lowest is MI26 at 4.72:1). `test/phase4-accessibility.test.js` guards it.
- `src/seo.js`: comment recording why availability, SKU, and ratings are omitted.

**Uncommitted:**

| Change | Files | Local evidence |
|---|---|---|
| Lead photo kept across `render()` | `src/lead-image.js` (new), `src/main.js` | Homepage lead paint 3409 → 2425 ms. The hero node stays the prerendered node through startup and commerce re-renders (also in Shopify fixture mode). Prerendered and client lead markup are identical for 9 routes |
| Lead-first loading of other lazy photos | `public/gallery-loading.js` | Bytes competing with the homepage hero fell from 418 to 231 KB. Nothing is left held after load or scroll on 6 pages at 2 viewports. Release on load, error, scroll, pointer, touch, key, and 6 s is unit-tested |
| BR16 q95 images | `public/images/optimized/black1-p3-480.webp`, `black1-p3-960.webp`, `black1-zoom-1045.webp` | See [BR16 image](#br16-image-q95-applied). Display P3 ICC bytes are identical to the source. Dimensions and paths are unchanged |
| BR16 image test | `test/gallery-image.test.js` | Still requires the exact source P3 ICC and the ICC flag. Dimensions now come from VP8X, so lossy is accepted. It also checks the zoom file. Confirmed to fail on a profile-less WebP |
| Immutable caching for found hashed JS/CSS | `worker/asset-cache.js` (new), `worker/index.js`, `wrangler.jsonc` | Real Worker in `wrangler dev`: starts with 0 errors. Hashed JS/CSS → `immutable` on 200, HEAD, and 304, with the body byte-identical. Missing hash → 404 `max-age=0`. HTML and images unchanged. API `no-store`. `_headers` security headers present. The entry module exports only `default` (a named export had made workerd refuse to start, now guarded by a test) |
| Post-deploy checks | `DEPLOYMENT_GUIDE.md` §7 | `curl` checks for the cache headers |
| Tests | `test/lead-first-loading.test.js` (13), `test/asset-cache.test.js` (5) | Full suite: 588/588 |

Regression checks on the new build: 22/22 Phase 2 keyboard checks, no reflow overflow, no CSP-RO violations, no new contrast findings. In Shopify fixture mode, prices render, add-to-cart works, checkout is enabled, and there are no runtime errors.

## Checks required after deployment

1. Run the `DEPLOYMENT_GUIDE.md` §7 checks:
   - a hashed bundle returns `public, max-age=31536000, immutable`;
   - `/` returns `max-age=0, must-revalidate`;
   - `/assets/index-MISSING1.js` returns 404 with `max-age=0`.
   Also confirm that `nosniff`, XFO, and CSP-RO are still on JS/CSS.
2. Confirm the Worker deployed and serves `/api/newsletter` (GET → 405), so the entry module loaded.
3. Re-run mobile lab LCP on live for `/` and `/product/br16`, at DPR 1.75 and DPR 3. Expect the BR16 request to be `black1-zoom-1045.webp` (~153 KB) at DPR 3. Retry PageSpeed Insights for field data when quota allows, and check Search Console Core Web Vitals over the following weeks.
4. View BR16 on a real P3 phone and desktop (gallery and zoom) to confirm colour and detail.
5. Load home, `/shop`, and a product page on mobile and desktop (§7). Confirm Shopify prices load, cards and footer images appear, and the console has no errors. Exercise add-to-cart and checkout on the **test store**, not production.

## Deferred follow-ups

1. **Offer availability.** Deliberately not emitted. `InStock` taken from `src/catalog.js` at build time would stay "in stock" after a sell-out until the next deploy. This needs reliable Shopify synchronization (a webhook-triggered rebuild, or edge-rendered JSON-LD from the Storefront API).
2. **Offer price freshness.** It has the same limit: the build-time catalog price matches Shopify today (155.00 USD), but it will not follow a Shopify change until a rebuild.
3. **Ratings.** Add them only once they are server-rendered and synced with Judge.me.
4. **CSP.** Add a reporting endpoint and collect field reports before enforcing. Judge.me review photos (none today) would need `img-src` additions.
5. **HSTS** `max-age=86400` (Cloudflare zone setting). Raise it to ≥1 year after review.
6. **BR16 high-resolution LCP is 2.51 s, slightly above the 2.5 s target** (lab, 390 px at DPR 3, q95 `black1-zoom-1045.webp` at 153 KB). Confirm on live first. If it holds, one option is a dedicated ~768–900 px P3 gallery size, so DPR 3 phones no longer fetch the 1045 px zoom file. That would leave q95 quality untouched.
7. **Homepage hero encode.** It is shown at 50% brightness, so a lighter encode is possible. It is not needed for the lab target, so wait for live data.
8. **Testing not done:** a real screen-reader session; Safari, Firefox, and physical devices; and a real production cart or checkout navigation.
9. **Smallest text** is 9 px (legal line and cart "remove"). Consider raising it.
