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
| Hashed `/assets/*` cache | Deferred | Served `max-age=0, must-revalidate`. A long-lived `_headers` rule was rejected in `de62391` because Cloudflare's 404-page fallback would cache missing-asset HTML. It needs Worker-side handling (cache only on 200) |

## Changes in this phase

- `src/style.css`: "Coming soon" label and price text now uses `color-mix(in srgb, <accent> 85%, #000)`. Every colorway meets ≥4.5:1 on white, paper, and its tinted background (lowest is MI26 at 4.72:1). Accent borders, outlines, and backgrounds are unchanged. To revert, restore `var(--card-accent)` / `var(--pdp-accent)`.
- `test/phase4-accessibility.test.js`: checks those two rules for all seven colorways. It fails against the old CSS (e.g. BR16 on paper 4.17:1).
- `src/seo.js`: a comment records the deferred-data decision.

## Deferred improvements

1. **Offer availability.** Deliberately not emitted. `InStock` taken from `src/catalog.js` at build time would stay "in stock" after a sell-out until the next deploy. This needs reliable Shopify synchronization, for example a rebuild triggered by inventory webhooks, or edge-rendered JSON-LD from the Storefront API.
2. **Offer price freshness.** It has the same limit as availability: `price` is the local catalog value at build time. It matches Shopify today (155.00 USD), but a Shopify price change is not reflected until a rebuild. It needs the same synchronization as availability.
3. **Ratings.** Add them only once they are rendered server-side and kept in sync with Judge.me.
4. **BR16 hero weight** (4.8 s lab LCP). Re-encode `black1-p3-*` at lower quality or a smaller width, with visual colour sign-off.
5. **Home LCP** (3.5 s lab). Options are a lighter hero encode (it is shown at 50% brightness) or stopping the product-card images from competing with it. Measure both before choosing.
6. **CSP.** Add a reporting endpoint and collect field reports before enforcing. Judge.me review photos (none today) would need `img-src` additions.
7. **HSTS max-age** and **immutable asset caching**, as above.

## Remaining gaps

- No field (real-user) LCP. Retry PageSpeed Insights once the quota resets, or check Search Console's Core Web Vitals report.
- No real screen-reader session. No Safari, Firefox, or physical-device run in this phase.
- The checkout handoff and a real add-to-cart were not exercised against production Shopify, to avoid creating live carts.
