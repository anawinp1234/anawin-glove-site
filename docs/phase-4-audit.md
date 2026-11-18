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

**Before and after, identical conditions.** Both builds were served from local `dist/` copies by the same gzip static server. Settings: same Chrome, 412×823 at DPR 1.75, 4× CPU, 562.5 ms RTT, 1.47 Mbps, cache disabled, 7 runs per page. *Lead paint* is the first animation frame where the connected `fetchpriority="high"` image is complete. Locally, Chrome's own LCP entry for `/` stays on the H1 text both before and after (a hero entry is never emitted locally, although live emits one), so lead paint is the comparable metric. *Correction (part 2): the local server sent no `Content-Length`, and Chrome then left the hero out of LCP. With `Content-Length` the local hero is the LCP element, as on live.* On product pages, lead paint and LCP agree within 20 ms.

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

*Status after part 2 (see [Phase 4 part 2](#phase-4-part-2-completion)):*
- *Items 1–2: prepared as a Worker module, not enabled (D2).*
- *Item 4: `report-uri` endpoint done, with summary retention configured.*
- *Item 5: D1.*
- *Item 6: met in lab with AVIF.*
- *Item 7: AVIF added; DPR 3 still unmet (recorded, not waived).*
- *Item 8: human checklist.*
- *Item 9: fixed.*

1. **Offer availability.** Deliberately not emitted. `InStock` taken from `src/catalog.js` at build time would stay "in stock" after a sell-out until the next deploy. This needs reliable Shopify synchronization (a webhook-triggered rebuild, or edge-rendered JSON-LD from the Storefront API).
2. **Offer price freshness.** It has the same limit: the build-time catalog price matches Shopify today (155.00 USD), but it will not follow a Shopify change until a rebuild.
3. **Ratings.** Add them only once they are server-rendered and synced with Judge.me.
4. **CSP.** Add a reporting endpoint and collect field reports before enforcing. Judge.me review photos (none today) would need `img-src` additions.
5. **HSTS** `max-age=86400` (Cloudflare zone setting). Raise it to ≥1 year after review.
6. **BR16 high-resolution LCP is 2.51 s, slightly above the 2.5 s target** (lab, 390 px at DPR 3, q95 `black1-zoom-1045.webp` at 153 KB). Confirm on live first. If it holds, one option is a dedicated ~768–900 px P3 gallery size, so DPR 3 phones no longer fetch the 1045 px zoom file. That would leave q95 quality untouched.
7. **Homepage hero encode.** It is shown at 50% brightness, so a lighter encode is possible. It is not needed for the lab target, so wait for live data.
8. **Testing not done:** a real screen-reader session; Safari, Firefox, and physical devices; and a real production cart or checkout navigation.
9. **Smallest text** is 9 px (legal line and cart "remove"). Consider raising it.

# Phase 4 part 2: completion

Branch `phase-4-part-2`, from `origin/main` at `8806d9f`. Phase 4 was already merged and deployed: live hashed assets return `immutable`. Worked 2026-11-17, revised after review. Not committed, pushed or deployed. No Cloudflare zone or Shopify changes.

## Checklist

| # | Issue | Acceptance criterion | Evidence | Status |
|---|---|---|---|---|
| 1 | Homepage mobile LCP and its real breakdown | Identify the LCP element and phases. LCP ≤ 2.5 s (lab) at DPR 1.75 and DPR 3, keeping the full-quality hero and current script behaviour | LCP is the hero `<img>` (live and local). At DPR 3 the time is load duration. AVIF sources added at measured similarity ≥ the shipped WebP | **DPR 1.75 met: 2380 ms. DPR 3 UNMET: 3224 ms** (was 3656). See [Homepage at DPR 3](#homepage-at-dpr-3-unmet) |
| 2 | BR16 LCP at DPR 3 was 2.51–2.54 s | ≤ 2.5 s at both DPRs, approved q95 files preserved | 4:4:4 AVIF, same P3 ICC, offered before the unchanged q95 WebP. DPR 1.75: 2216 ms. DPR 3: 2320 ms | **Met in lab.** AVIF not yet approved on a colour-managed device (M1) |
| 2a | AVIF must never leave a blank image | A failed decode is replaced by a working WebP: gallery, hero, zoom, re-render, navigation | Forced decode failures in Chrome, on a static server and on the real Worker: [Image safety](#image-safety) | **Demonstrated** for decode errors. Not covered: wrong pixels with no error (M1) |
| 3 | 9 px text | No rendered text below 11 px in the reported components | Rendered-size scan, 9 pages × 2 widths + open cart: none below 10 px now | **Fixed.** 10 px label text remains (design scale) |
| 4 | Intermittent mobile zoom failure | Reproduce and fix, or narrow down for a device test | Not reproduced in Chromium. The old screenshot predates the current hero. A defensive guard was added | **Not reproduced** (M3) |
| 5 | Offer price/availability staleness | Reviewed, safe solution; no invented data, no credentials | `worker/product-offer.js` revised after review: [Offer sync](#offer-sync-prepared-disabled) | **Prepared, disabled** |
| 6 | CSP reporting | Reports reach a sanitized, abuse-limited, retained log | `report-uri` → `worker/csp-report.js`. Retention configured with invocation logs off: [CSP reports](#csp-reports) | **Done locally.** Retention verified after deploy |
| 7 | HSTS | Concrete setting prepared | [HSTS](#hsts-prepared-not-applied) | **Prepared, not applied** |

## 1–2. LCP: method and results

**Lab.** Installed Chrome over CDP, mobile UA, touch, 4× CPU, 562.5 ms RTT, 1.47 Mbps down, cache disabled. 7 runs per cell, median. Same gzip static server for both builds, run back to back. The server sends `Content-Length`; without it, Chrome leaves the hero out of LCP, which caused the earlier "H1 is LCP locally" result. Phases follow web.dev: TTFB, load delay, load duration, render delay. Raw output and scripts are in the session scratchpad (not committed).

| Page | Viewport | Build | LCP element | Bytes | TTFB | Load delay | Load duration | Render delay | **LCP** |
|---|---|---|---|---|---|---|---|---|---|
| `/` | 412×823 @1.75 | baseline | `hero-background-800.webp` | 148 KB | 563 | 29 | 1858 | 11 | **2472** |
| | | part 2 | `hero-background-800.avif` | 130 KB | 563 | 31 | 1760 | 8 | **2380** |
| `/` | 390×844 @3 | baseline | `hero-background-1200.webp` | 360 KB | 563 | 27 | 3040 | 14 | **3656** |
| | | part 2 | `hero-background-1200.avif` | 279 KB | 564 | 34 | 2598 | 6 | **3224** |
| `/product/br16` | 412×823 @1.75 | baseline | `black1-p3-960.webp` | 137 KB | 563 | 30 | 1800 | 8 | **2408** |
| | | part 2 | `black1-p3-960.avif` | 101 KB | 563 | 31 | 1596 | 11 | **2216** |
| `/product/br16` | 390×844 @3 | baseline | `black1-zoom-1045.webp` | 157 KB | 563 | 29 | 1931 | 6 | **2544** |
| | | part 2 | `black1-zoom-1045.avif` | 114 KB | 563 | 28 | 1702 | 5 | **2320** |

Run spread was small (for example, BR16 @3 part 2: 2291–2340 ms). Load delay is ~30 ms and render delay ≤ 14 ms, so load duration is the only meaningful phase. These are lab numbers, not field data.

### Homepage at DPR 3: unmet

**3224 ms against a 2.5 s target, recorded as unmet.** Keeping the full-quality hero and the current script behaviour, as decided, the cause is bandwidth:

- Before the hero finishes, ~93 KB of other critical bytes share the link: JS 63 KB, CSS 15 KB, wordmark 12 KB, `gallery-loading.js` 3 KB.
- With TTFB plus one RTT ≈ 1.13 s at 184 KB/s, the hero must be ≤ ~160 KB to land by 2.5 s.
- The best AVIF at full measured quality is 279 KB. With `object-fit: cover` on a tall box, the 1200 w file already gives only ~1.9× density at DPR 3, so a smaller file would soften it.
- Live serves Brotli, which is no smaller than gzip here (JS 66.2 vs 66.7 KB). One live run at DPR 3 measured 3984 ms with the WebP.

**Still open to investigate:**

1. **Live HTTP/2 prioritisation.** Cloudflare's prioritisation may favour the `fetchpriority="high"` image over the JS. The local lab server is HTTP/1.1, so this needs a post-deploy lab run on live.
2. **Smaller competing bytes without behaviour changes.** For example, a vector wordmark, if a source exists, would save ~12 KB, about 65 ms. That isn't enough alone.

Waiting for field data alone does not fix this.

### Image encoding (measured similarity, not approval)

For each width, the selected AVIF is the smallest whose **measured similarity** to the source is equal to or better than the shipped file on all four of: mean ΔE00, 95th-percentile ΔE00, SSIM (L) and PSNR. avifenc 1.3.0 (aom), speed 3.

**What these numbers are:** a numerical comparison of decoded pixel values, with CIEDE2000 computed as if the values were sRGB. They are **not** colour-managed rendering. For the P3-tagged BR16 files, both sides carry the same profile, so the comparison is consistent, but the absolute ΔE values are approximate. They say nothing about how a real P3 display or Safari will render the file. They are not, and do not replace, the owner's visual approval on a colour-managed device. The approved q95 WebP files are unchanged and remain the fallback.

| File | Shipped (unchanged) | AVIF added | Settings | Colour signalling |
|---|---|---|---|---|
| hero 480 / 640 / 800 / 960 / 1200 / 1350 | 84 / 141 / 148 / 265 / 360 / 496 KB WebP | 67 / 115 / 129 / 211 / 278 / 395 KB | 4:2:0, q54 / 54 / 46 / 52 / 52 / 58 | Untagged sRGB (nclx 1/13/6), like the WebP |
| BR16 `black1-p3-480`, `-960`, `black1-zoom-1045` | 45 / 137 / 156 KB q95 WebP | 36 / 100 / 114 KB | 4:4:4, q85 | Identical 536-byte Display P3 ICC |

**Why 4:4:4 for BR16.** At 4:2:0, no file that saved bytes measured as similar as the q95 WebP on the 95th-percentile ΔE (red stitching). At 1045 px: q95 WebP mean ΔE 0.39 / p95 1.67 / SSIM .9930 / PSNR 46.5, versus AVIF 0.34 / 1.50 / .9940 / 47.3.

**Decoder evidence and gaps.**

- Shown: macOS 26.4 ImageIO (`sips`) decoded all three 4:4:4 files with a max 1-level difference from libavif and recognised the P3 profile. Safari uses ImageIO.
- Not shown: iOS behaviour, and any Apple documentation of 4:4:4 (AV1 High profile) image support. No source found settles it. (An earlier chat note cited a WebKit bug that concerns VP9 video; it is not evidence either way for AVIF images.)
- Safari automation was unavailable (needs Safari › Settings › Developer › Allow remote automation), and Firefox is not installed here.

**Rendered colour, hero only.** Chrome screenshots (sRGB), WebP vs AVIF at DPR 1.75: mean channel shift R +0.18, G −0.17, B +0.23 levels, so there is no profile-handling shift. The DPR 3 capture stalled and was not completed. This is not a P3 assessment.

### Image safety

AVIF `<source>` elements appear only on the two lead pictures, before the unchanged WebP `<source>`. Browsers without AVIF support skip them by `type`.

**How a failed AVIF is replaced:**

- `public/gallery-loading.js` runs before the app bundle. A capture-phase `error` listener sees a failed AVIF `<img>` and removes the picture's AVIF `<source>`, so the browser re-selects from the WebP set. An install-time scan also repairs an image that failed before the script ran. The failure is recorded as `<html data-avif-failed>`.
- After that, `src/lead-image.js` strips AVIF sources from new markup *before* it is inserted. Re-renders keep the repaired lead node, and client-side navigation never requests AVIF again.
- The lightbox prefers the AVIF zoom file only when the gallery photo itself loaded as AVIF. A decode failure there falls back to WebP, then PNG (`src/zoom-image.js`).

**Forced decode failures.** CDP answered AVIF requests with corrupt bytes labelled `image/avif`. All scenarios passed on a static server and again on the real Worker (`wrangler dev`), with 0 runtime errors and each failing AVIF requested once:

| Scenario | Result |
|---|---|
| Control | Hero, BR16 photo and zoom all AVIF |
| Hero corrupt, before the scripts ran | `hero-background-1200.webp` shown, lead node kept |
| Hero corrupt, delivered 1.5 s later (after the scripts ran) | `hero-background-1200.webp` shown, lead node kept |
| All AVIF corrupt, then client navigation to BR16 | BR16 used WebP directly; **0 AVIF requests after the failure**; zoom WebP |
| BR16 gallery AVIF corrupt @3× | `black1-zoom-1045.webp` shown, lead node kept; zoom WebP |
| Only the zoom AVIF corrupt @1.75× | Gallery stayed AVIF; lightbox showed `black1-zoom-1045.webp` (1045 px, visible) |
| Desktop 1280, all AVIF corrupt | `hero-background-1350.webp`, `black1-p3-480.webp`, zoom WebP |
| AVIF disabled (`Emulation.setDisabledImageTypes`) | WebP everywhere, **0 AVIF requests** |

**Limit.** This handles decode *errors*. A decoder that draws wrong colours or garbage without raising an error cannot be detected in the page. So AVIF stays the default on the strength of the demonstrated fallback, and the exact files still need the real-iPhone check (M1) before release.

## 3–4. Accessibility and zoom

- **Rendered-size scan:** `/`, `/shop`, `/product/br16`, `/product/mi26`, `/about`, `/faq`, `/community`, `/shipping` and `/nope` at 375 @3 and 1280, plus the open cart. Before: 9 px on the cart "Remove" (mobile only; the 11 px override was desktop-only) and the model-switcher "Current". `.sold-out` was also 9 px but renders only when unavailable. After: nothing below 10 px. Guarded by `test/phase4-accessibility.test.js`.
- **Zoom:** after a synthesized pinch (scale 2.5), one-finger pans, including six at the visual-viewport edge, never changed the image on either build. Control: an unzoomed swipe steps. The `swipeStep` guard (no swipe while `visualViewport.scale > 1`) is defensive only. Not testable here: iOS double-tap (a tap on the lightbox image closes it by design) and Safari page zoom or text size.
- **Hero overflow:** none at effective widths 390, 320, 260, 430 or landscape 844×300. At 223 px (≈ 175% Safari page zoom on a 390 px phone) content is 260 px wide. That is below the WCAG 320 px reflow width.

## 5. Offer sync: prepared, disabled

It is off in `wrangler.jsonc` (a test enforces that). It runs only if `/product/*` is added to `run_worker_first` and `PRODUCT_OFFER_SYNC` is `on`. Review results:

| Concern | Behaviour | Test |
|---|---|---|
| Credentials | None: tokenless Storefront API read (product queries are allowed tokenless) | `no token of any kind` |
| Market and currency | Query pinned with `@inContext(country: US)`. Verified: the same product returns 155.0 USD for US and 250.0 CAD for CA. Cache key `…/2026-07/US/<handle>`. Non-USD results are rejected | `U.S. market`, `currency-mismatch` |
| Cache isolation | The result does not depend on the visitor (no buyer IP or token sent, fixed country), so one shared per-edge entry is correct | cache key test |
| Timeout | 1000 ms via `AbortSignal.timeout`. Worst case: one page view per edge location per minute waits ≤ 1 s | `abort signal` |
| API failures | HTTP error, invalid JSON, GraphQL `errors` (for example, throttled), timeout, cache failure: page served exactly as built. Failures are remembered for 60 s, so an outage is not retried on every view | `failures … remembered briefly` |
| Variants | Exactly one variant required (`first: 2`). More than one, none, zero or invalid price, or non-boolean availability: no offer | `anything ambiguous` |
| HTML/JSON-LD agreement | The Worker never changes the price. It adds `availability` only when Shopify's price equals the page's built JSON-LD price, which equals the visible `<p class="price">` (tested for all three trainers). Otherwise the page is served as built and `offer-price-mismatch` is logged once per fetch | `only availability is added`, `price change … rebuild signal` |
| Client re-render | `updateSeo()` keeps a `data-anawin-live-offer` block for the same URL, because Googlebot renders JavaScript | `client keeps` |
| Validators | `ETag`/`Last-Modified` removed, and conditional request headers dropped before fetching the asset | `drops stale validators` |

**Stale-price behaviour that remains.**

- *Today, with sync off:* JSON-LD and the static HTML carry the build-time price, with no availability, until the next deploy. After the app runs, the visible price comes from Shopify. So after a Shopify price change, the JS-rendered visible price differs from the JSON-LD until a rebuild.
- *With sync on:* the price behaves the same (the Worker never changes it). Availability follows Shopify within 5 minutes, and is omitted for up to 60 s after a failure. After a price change, availability is withheld and `offer-price-mismatch` is logged until a rebuild.

**Rule either way: rebuild and deploy after any Shopify price change.**

Verified in `workerd` after the revision, with a scratch config enabling it and live tokenless reads. BR16, OB16 and CL16 each got the live block: price `155.00` (equal to the visible `$155`) plus `InStock`. A repeat BR16 view was served from the edge cache. A direct read-only request confirmed the market pinning (US 155.0 USD, CA 250.0 CAD).

## 6. CSP reports

- **Header:** `report-uri /api/csp-report` only. In Chrome, `report-uri` alone delivered. With both directives, Chrome sent nothing: `report-to` takes precedence, and Reporting API delivery did not happen on plain-HTTP loopback within 75 s. Cloudflare already sends its own `Report-To` (NEL group `cf-nel`), so `_headers` must not add one.
- **Endpoint** (`worker/csp-report.js`):
  - Limits: POST only, three content types, 8 KB body, at most 10 distinct reports per request.
  - Validation: the directive must match `[a-z-]`; disposition must be `enforce` or `report`; line and status are bounded integers; the document must be a page on the request's own origin, otherwise the report is dropped.
  - Sanitization: no query strings, fragments, credentials, script samples or control characters. Blocked URLs are reduced to their origin, and third-party source files likewise.
  - Abuse: a per-IP rate limit (`CSP_REPORT_LIMITER`, 30 per 60 s, namespace `732613`; check that no other Worker in the account uses that id). A limiter error drops the report. Dropped reports still get 204.
- **Retention** (`wrangler.jsonc`): `observability.enabled: true`, `logs.enabled: true`, `logs.invocation_logs: false`, `logs.head_sampling_rate: 1`. The schema comes from installed Wrangler 4.157.0 (`config-schema.json`), and `wrangler deploy --dry-run` validated it with no warnings. The Worker's only routine `console.log` lines are these summaries (plus a rare `offer-price-mismatch` if offer sync is ever enabled). Each line is one log event: free plan 200,000 per day with 3-day retention; paid plan 20 M per month included. With 30 per minute per IP, a single source can produce at most ~43,000 events a day, while a distributed flood could still use the quota.
- **Verified in `wrangler dev`:**
  - 35 reports from one IP: all 204, exactly 30 logged.
  - A report claiming another site's page: 204, not logged.
  - A real Chrome violation: logged with the blocked URL reduced to its origin.
  - GET 405, `text/plain` 415, oversized 413.
- **After deploy:** confirm in Workers Logs that `csp-violation` lines persist and that no `cf-worker-event` invocation logs appear. Cloudflare's page does not state explicitly that `console.log` lines persist with invocation logs off.

## HSTS: prepared, not applied

Cloudflare › SSL/TLS › Edge Certificates › HTTP Strict Transport Security:

| Setting | Value |
|---|---|
| Enable HSTS | On |
| Max Age | 6 months |
| Apply HSTS policy to subdomains (`includeSubDomains`) | **Off**, pending verification of every hostname in the DNS list (only the apex and `www` were found) |
| Preload | **Off** |
| No-Sniff | On (already sent by `_headers`) |

Live today: `max-age=86400`. Risk: if HTTPS stops working while the policy is cached, browsers cannot reach the site until it expires.

## Owner decisions recorded

- HSTS: prepare six months, subdomains and preload off.
- Shopify refresh: keep disabled pending this review.
- CSP: keep it, retain sanitized summaries with invocation logs off.
- Homepage at 3×: keep the sharp image and current script behaviour; record the miss as unmet.

## Checks run (part 2 revision)

- `npm test` with a local-mode build: 627/627.
- `git diff --check`: clean. No `.webp` file modified.
- `wrangler deploy --dry-run`: config valid.
- `wrangler dev`: CSP endpoint, rate limit and real-browser report; the forced-AVIF-failure suite.
- Static server: forced-AVIF-failure suite and AVIF-disabled run.
- Rendered-size scan, pinch test and hero overflow.
- Fixture-mode commerce run (390 @3 and 1280): lead nodes kept, prices, lightbox by keyboard, cart, checkout enabled, no runtime errors.
- `scripts/browser/break-in-browser.mjs`: one failure when started immediately after the fixture servers came up (a cold start, probably Vite), then two consecutive passes at 1440 and 375 with the same code.
