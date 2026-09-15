# ANAWIN — Next Steps

Use this file as context when continuing work on the ANAWIN storefront.

## Current state

The site is a Vite-powered, dependency-light storefront implemented in `src/main.js` and `src/style.css`. It has:

- Homepage, Shop, About, product-detail, cart, and 404 views.
- Three products with four images each.
- Responsive desktop and mobile layouts.
- A local-storage cart with quantity and removal controls.
- An optional $20 break-in service that appears in the cart and subtotal.
- Checkout remains disabled in local mode. A Shopify Storefront API adapter is prepared for product, cart, and hosted-checkout operations.

Run locally with `npm run dev`. Verify production output with `npm run build`.

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
- The two founder names, biographies, and photos are still placeholders.

## Shopify commerce direction

Shopify is the selected commerce backend. The storefront runs in safe local mode until a Shopify account is connected through the Headless sales channel. In Shopify mode, Shopify supplies variant IDs, availability, prices, authoritative cart totals, and the hosted checkout URL. Never put Admin API or private Storefront credentials in this client application.

The $20 break-in service must be created as its own Shopify product with one purchasable variant. The storefront associates one service line with each serviced glove so Shopify—not browser arithmetic—controls the charge and any future capacity limit.

## Recommended next work

1. Add final founder names, portraits, and biographies when supplied.
2. Create the three glove products and separate break-in-service product in Shopify; confirm inventory quantities and service capacity.
3. Install Shopify's Headless channel, create the storefront, and supply its public Storefront API token and exact product handles through the documented environment variables.
4. Test product availability, cart restoration, quantity changes, service-line synchronization, and Shopify-hosted checkout in a non-production setup.
5. Add finalized shipping and return policies in both Shopify and the storefront.
6. Run full mobile, keyboard, accessibility, and browser testing.
7. Add deployment configuration, environment-variable validation, monitoring, and backups.

## Suggested prompt for the next Codex session

> Continue building the ANAWIN storefront in this repository. Read `next_steps.md`, inspect the current code and Git history, and preserve all confirmed copy, product names, colors, specifications, prices, imagery, and the minimal visual direction. Start by auditing the current state and then work on: [describe the next desired change]. Do not invent company or product information, and do not enable payments until price, inventory, order creation, and payment confirmation are enforced server-side.
