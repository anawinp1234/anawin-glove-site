# Full-size preorder: website behavior and launch checklist

Status (November 18, 2026): implemented behind configuration and **off**. All four full-size models (MI26, BL50, OR17, CM24) remain `comingSoon: true` with `preorder: { enabled: false, shipEstimate: null }`, so production renders exactly the existing Coming Soon pages. No Shopify data was changed.

## Shared copy (used by the order emails too)

| Where | Text |
| --- | --- |
| Status label and purchase button | `Preorder` |
| PDP shipping line, next to the button | `Estimated to ship: {estimate}` |
| Cart line note and cart disclosure items | `Preorder · Estimated to ship: {estimate}` |

`{estimate}` is free text approved by the owner (for example `first week of December 2026`). The site never shows "in stock", "ships now", countdowns, scarcity or urgency copy for a preorder. All preorder strings and Shopify contract names have one source, `src/catalog.js` (`PREORDER_LABEL`, `PREORDER_ESTIMATE_PREFIX`, `preorderShipLine`, `preorderCartNote`, `PREORDER_PAYMENT_NOTE`, `PREORDER_TAG`, `PREORDER_METAFIELD`, `PREORDER_ORDER_ATTRIBUTE`). `src/policy-content.js` re-exports them for the policy copy; it defines no copies.

## When a glove is sold as a preorder

`preorderState(product)` in `src/catalog.js` decides. A full-size glove is a preorder (**active**) only when all of these hold:

1. `comingSoon === false` in the catalog.
2. `preorder.enabled === true` in the catalog.
3. `preorder.shipEstimate` is non-empty text.
4. Shopify returns the product metafield `custom.preorder_ship_estimate` (exposed to the Storefront API) and it equals the catalog estimate exactly (surrounding spaces ignored, case-sensitive). **Required**: a missing metafield blocks the preorder.
5. `PREORDER_CHECKOUT.chargedInFullAtCheckout === true`. This store-level flag stays `false` until the owner confirms in Admin that payment capture is automatic and no selling plan or deferred payment applies; the Storefront API cannot read it.
6. Shopify reports at least one variant `availableForSale` (the chosen throw hand must also be available, as before).

It **fails closed** (`blocked`: never sold, no "Preorder" label, no estimate) when the preorder is enabled but any of 3–6 fails, and also when Shopify has an estimate but the catalog does not enable the preorder. While Shopify data is still loading, the page shows a disabled "Checking availability…" button and no Preorder copy. A Coming Soon glove stays Coming Soon whatever Shopify returns.

## What changes on the site when a model is active

- **Product page:** a bordered `PREORDER` text badge under the price; `Estimated to ship: …` and `Preorders are paid in full at checkout, the same as in-stock items.` directly above the button; the button reads `Preorder` and is `aria-describedby` the estimate, the payment note and the setup summary. The launch signup box and "Available to add when this glove launches" are hidden. Throw hand, wrist fit, full-size break-in options, validation and focus are unchanged. Full-size pages have no mobile sticky purchase bar, so none was added.
- **Blocked:** "Currently unavailable", a calm explanation ("{model} isn’t available to order right now. Sign up below to hear when it is."), a disabled `Unavailable` button, break-in checkbox disabled, launch signup kept.
- **Cards and related links:** "Preorder" replaces "Coming soon" only for an active preorder. The collection cue drops "· Coming soon" once any model is an active preorder.
- **Cart:** each preorder glove shows `Preorder · Estimated to ship: …` under its name. Trainers show nothing new. Above the checkout button, a static disclosure lists each preorder and its estimate, and when the cart also has other gloves says "Other items in your cart are not preorders." The checkout button is `aria-describedby` that disclosure. It is plain text, not another live region. The existing cart announcer now says, for example, "MI26 preorder added to cart."
- **Blocked glove already in a cart** (for example the Shopify estimate changed after it was added): the line says it is not available to order, the disclosure asks the shopper to remove it, and checkout stays disabled. `commerce.addProduct` also refuses a blocked preorder before any cart mutation.
- **Shipping Policy and FAQ:** a Preorders section (Shipping Policy, between Processing Times and Delivery Estimates) and a Preorders FAQ group, including the payment note, render only while at least one model is an active preorder and Shopify loaded without error. The FAQ drops "all coming soon" in that case. Prerendered pages never include them.
- **Order snapshot:** at checkout handoff, `commerce.checkout` writes one cart-level attribute, `Preorder estimated ship` (for example `BL50: …; MI26: …`), which Shopify copies onto the order. It sends the complete attribute list, keeps unrelated cart attributes, clears a stale value (retrying with a blank value if Shopify merges), and blocks checkout unless the written value matches. Carts with no preorder details make no extra request. A blocked preorder glove in the cart also blocks `commerce.checkout` itself, not only the button.
- **Cart data:** nothing new is written to cart lines. The note is derived at render time, so the glove line attributes and the `_anawin_configuration` fingerprint are unchanged (covered by a test).

## Structured data

- Coming Soon: no full-size Product/Offer JSON-LD (unchanged).
- Catalog-configured preorder: the built page gets Product/Offer JSON-LD with the catalog price and **no** `availability` or delivery time. The standard 1–3 day handling time is deliberately left out because it does not apply to preorders. `scripts/prerender.mjs` now fails the build if any built page claims `InStock` or `PreOrder`.
- Live availability comes only from `worker/product-offer.js`. For a catalog-configured preorder page it reads all variants and the metafield, and publishes `https://schema.org/PreOrder` (any variant for sale) or `OutOfStock`, never `InStock`. Variants must share one USD price that equals the built price, and the metafield must be present and match the catalog estimate. Otherwise the page is served as built. The cache key includes the estimate.
- The Worker sync is still **disabled** in production (`PRODUCT_OFFER_SYNC` unset and `/product/*` not in `run_worker_first`; see `docs/phase-4-audit.md`). Until it is enabled, preorder pages ship without availability, which is acceptable and never wrong.

## Shopify configuration (owner/Admin; not done by this change)

| Item | Why | Verified today? |
| --- | --- | --- |
| Republish MI26/BL50/OR17/CM24 to the Headless channel | They return `null` by handle and by variant ID today (Nov 18). Without this nothing can be added to a cart. | No: currently not visible |
| Inventory: track quantity with "Continue selling when out of stock", or turn tracking off | Otherwise `availableForSale` goes false at 0 stock and the page fails closed to Unavailable | Unknown: the token cannot read inventory |
| Product tag `preorder` | For Admin filtering and order emails (Agents 2/3). The website does not read it. | No |
| Product metafield `custom.preorder_ship_estimate` (single-line text), **Storefront access enabled** | Optional second check. If it is not exposed, the Storefront API returns `null` and the site relies on the catalog estimate. Emails read the same value, so it must match the catalog text exactly. | No |
| Price change to $295 | Shopify's price is authoritative on the PDP and in the cart. The catalog stays at $285; see "Price" below. | No: $285 on Nov 11, not readable now |
| Shopify selling plans or "native" preorder apps | Not used. Nothing here creates deferred-payment plans; payment is taken at checkout as for any order. | None exist |

## Frontend configuration (repository)

- `src/catalog.js`, per model: `comingSoon` and `preorder: { enabled, shipEstimate }`.
- Build environment: `VITE_SHOPIFY_MI26_HANDLE` / `BL50` / `OR17` / `CM24` (`mi26`, `bl50`, `or17`, `cm24`). **Do not set these until the products are republished to Headless.** A configured handle that returns `null` makes `listProducts` throw, which fails commerce loading for the whole storefront, trainers included. This behavior predates the preorder work and was left unchanged.
- Catalog `price` for the model, so the built page and build-time JSON-LD match Shopify (see "Price").

## How the owner switches one model to preorder

1. Approve the model and its estimate text (for example `first week of December 2026`).
2. Shopify Admin: publish the product to Headless; set inventory to continue selling (or untracked); add tag `preorder`; set `custom.preorder_ship_estimate` to the **identical** text; confirm the metafield definition has Storefront API access; set the intended price.
3. Read-only check: query the product by handle through the Storefront API and confirm it returns variants with `availableForSale: true`, the expected price and the metafield value.
4. Repository: in `src/catalog.js` set that model to `comingSoon: false, preorder: { enabled: true, shipEstimate: '<identical text>' }` and set `price` to the Shopify price; set its `VITE_SHOPIFY_<MODEL>_HANDLE` in the build environment.
5. Run `VITE_COMMERCE_MODE=local npm test` (update the production-catalog assertions in `test/preorder.test.js`, `test/full-size.test.js` and `test/full-size-commerce.test.js`, which deliberately pin Coming Soon), build and deploy.
6. To pause or roll back quickly without a deploy, clear or change the Shopify metafield. A mismatch makes the site fail closed to Unavailable. To end the preorder, set `preorder.enabled: false` (normal sale) or `comingSoon: true`.

## Price

The catalog price is the prerendered and pre-load display price; once Shopify loads, the PDP, setup total and cart use Shopify's price (covered by a test with $295). The build-time JSON-LD uses the catalog price, and the Worker adds availability only when Shopify's price equals it. If Shopify is $295 while the catalog says $285, the PDP briefly shows $285 before loading, and the Worker would log `offer-price-mismatch` and omit availability. Update the catalog price in the same release that enables the preorder.

## Owner decisions still open

- The approved estimate per model (none is approved yet; nothing is hard-coded).
- Whether a mixed cart ships together or the trainer ships first. The site makes no claim either way.
- Preorder cancellation and refund terms, and whether the shipping and returns policies need a preorder section (Agent 3 owns policy text).
- Whether to enable the Worker offer sync for live `PreOrder` availability.

## Verification

- Unit and render tests: `test/preorder.test.js` (gating, every fail-closed reason, PDP, blocked, loading, cards, trainers, cart rows, disclosure, wiring, CSS), `test/preorder-commerce.test.js` (metafield query, matching, mismatch, no mutation, unchanged attributes) and `test/preorder-seo.test.js` (JSON-LD absent while Coming Soon, built HTML, Worker `PreOrder`, mismatch and cache key).
- Mocked Chrome at 1440px and 375px (loopback fixture, all external requests blocked, catalog changed only in the dev-server transform): production Coming Soon on all four models; MI26 active preorder; BL50 mismatched metafield fails closed; throw-hand validation and focus; add to cart; mixed cart with BR16; accessible descriptions on the Preorder and checkout buttons; no horizontal overflow.
