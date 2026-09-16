# ANAWIN — Next Steps

Use this file as context when continuing work on the ANAWIN storefront.

## Current state

The `fullstack-review` storefront work was merged into `main` at commit `2e52f2e`. The two branches still exist, but their tracked files currently match. Continue new work from `main`.

The site is a Vite-powered, dependency-light storefront implemented in `src/main.js` and `src/style.css`. It has:

- Homepage, Shop, About, product-detail, cart, and 404 views.
- Three products with four images each.
- Responsive desktop and mobile layouts.
- A local-storage cart with quantity and removal controls.
- An optional $20 break-in service that appears in the cart and subtotal.
- Checkout remains disabled in local mode. A Shopify Storefront API adapter is prepared for product, cart, and hosted-checkout operations, but has not been connected to a store.

Run locally with `npm run dev`. Verify with `npm test` and `npm run build`.

## Brand and design decisions

- Brand: ANAWIN.
- Direction: premium, minimal, neutral, image-led, with a subtle streetwear influence.
- Avoid corny slogans and unnecessary marketing language.
- Homepage hero heading: `COMMUNITY BUILT` with no period.
- Homepage product heading: `MINI GLOVES`.
- Shop heading: `MINI GLOVES`; the eyebrow says only `Shop`.
- Navigation background is pure white. The rest of the site uses cream, black, and neutral gray.
- Official ANAWIN wordmark and emblem are in `public/images/`.
- No licensed DIN font files are present. The CSS uses legal condensed system fallbacks.
- Homepage hero uses `public/images/hero-background.jpg`.
- About hero uses the landscape `public/images/cherry_pink.png` in a full-width 16:9 crop.

## Confirmed product data

All gloves cost $150 and currently support right-hand throw only.

| Model | Colors |
| --- | --- |
| BR16 | Black / Red / Gray |
| OB16 | Sky Blue / Royal / Navy |
| CL16 | Tan / Brown |

Shared specifications:

- Size: 10.25 inches.
- Leather: US steerhide leather.
- Features: double finger pad.
- Thumb: sheepskin thumb sleeve.
- Product information: “Designed for baseball and softball players. Built for faster hands, cleaner transfers, and more consistent defensive work.”

Break-in service:

- Price: $20 per glove.
- Supporting copy: “Optional glove break-in” and “Get your glove ready for practice right away.”

## Confirmed company information

- Contact: `ray@anawinofficial.com`.
- Instagram: `@anawinofficial`.
- TikTok: `@anawinofficial`.
- The About page contains supplied copy under `HOW IT STARTED` and `OUR STORY`.
- The founders section now shows Ray Lopez and Anawin Pikulthong with biographies and portraits. Confirm final approval of that content before launch.

## Shopify commerce direction

Shopify is the selected commerce backend. The storefront runs in safe local mode until a Shopify account is connected through the Headless sales channel. In Shopify mode, Shopify supplies variant IDs, availability, prices, authoritative cart totals, and the hosted checkout URL. Never put Admin API or private Storefront credentials in this client application.

The $20 break-in service must be created as its own Shopify product with one purchasable variant. The storefront associates one service line with each serviced glove so Shopify—not browser arithmetic—controls the charge and any future capacity limit.

## Recommended next work

1. Confirm the final founder content, product details, prices, inventory quantities, and break-in-service capacity with ANAWIN.
2. Create BR16, OB16, CL16, and the separate $20 break-in-service product in Shopify, each with one purchasable variant.
3. Install Shopify's Headless channel, create a storefront, and enter its public Storefront API token, store domain, and exact product handles using `.env.example`. Keep private and Admin API credentials out of the browser.
4. Test product availability, cart restoration, quantity changes, service-line synchronization, and Shopify-hosted checkout with non-production settings.
5. Finalize shipping and return policies in Shopify and replace the storefront's current placeholder policy text.
6. Run mobile, keyboard, accessibility, and cross-browser checks; fix issues found and rerun `npm test` and `npm run build`.
7. Choose hosting and add the verified deployment configuration, environment-variable validation, monitoring, and recovery plan before launch.

`FULLSTACK_REVIEW.md` and `DEPLOYMENT_GUIDE.md` describe an earlier `19345c0` snapshot that lacked the application. They are historical reports, not current launch checklists.

## Suggested prompt for the next Codex session

> Continue building the ANAWIN storefront from `main`. Read `next_steps.md` and `README.md`, inspect the current code, and preserve confirmed copy, product names, colors, specifications, prices, imagery, and the minimal visual direction. Start with: [describe the next desired change]. Do not invent company or product information. Keep checkout disabled in local mode, and test the Shopify integration before enabling it in production.
