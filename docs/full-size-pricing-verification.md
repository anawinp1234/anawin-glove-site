# Production price alignment — November 11, 2026

Read-only Storefront API verification against `ignvv0-zh.myshopify.com`, API `2026-07`, returned the following USD prices. Each product's variant connection reported `hasNextPage: false`; all applicable variants are covered. No GraphQL errors were returned. No Shopify Admin writes or production cart mutations were made.

| Product | Variant ID | Hand | Price |
| --- | --- | --- | --- |
| MI26 | 68055435968760 | Right | $285 |
| MI26 | 68055436001528 | Left | $285 |
| BL50 | 68055446323448 | Right | $285 |
| BL50 | 68055446356216 | Left | $285 |
| OR17 | 68055559340280 | Right | $285 |
| OR17 | 68055559373048 | Left | $285 |
| CM24 | 68055715184888 | Default Title; catalog permits Right only | $285 |
| Full-size break-in | 68062398808312 | Default Title | $75 |
| Trainer break-in | 50525848633592 | Default Title | $20 |
| BR16 | 50518256386296 | Default Title | $155 |
| OB16 | 50525824778488 | Default Title | $155 |
| CL16 | 50525846077688 | Default Title | $155 |

There are no current Shopify price discrepancies. The previously recorded CM24 $290/$285 mismatch is resolved. All full-size gloves plus service total $360 before shipping/tax. Historical test-store evidence at $290 + $75 = $365 remains valid for that separate store.

## Storefront changes

The shared catalog now advertises $285 for all four full-size models. The product setup summary displays the base total and updates to $360 when service is selected. Its calculation uses the rendered product price and service price, preserving Shopify's authority when a remote price differs. Full-size cards on Home/Shop and related-product links currently display model/colorway and Coming Soon without a numeric price; no stale numeric price exists in those cards. Their layout is preserved.

Full-size Product/Offer JSON-LD remains absent while Coming Soon is active. Trainer Product JSON-LD retains $155 offers. Prerendered full-size pages advertise $285, have a $285 initial setup total, and retain disabled Coming Soon buttons. No public purchase access was enabled.

The existing `images/mi26/mi26_back.png` was already the new source on this branch. Regenerating mint assets with the repository image pipeline changed only the back JPEG and its 480/960/1254 WebPs. Dimensions, image descriptions, responsive sizing and zoom paths remain unchanged.

Service serialization, exact parent/child relationships, customization validation and trainer behavior were preserved. Mock fixture defaults now match production, with an explicit $290 override regression demonstrating that live Shopify prices remain authoritative.

## Configuration and isolation

The deployed public JavaScript bundle points to `ignvv0-zh.myshopify.com`, Storefront API `2026-07`, and trainer service handle `break-in-service`. It contains no `anawin-test` host. The worker configuration also points to the real store.

The deployed bundle predates this branch's full-size integration: it has neither the full-size service references nor optional full-size commerce handles. Therefore the deployed site cannot yet be reported as containing the new $75 integration. This branch pins service handle `full-size-glove-break-in-service`, product `15498355474680`, and variant `68062398808312`, all matching the fresh production response. The service is $75 USD, available through Storefront, and nonphysical. Existing validation rejects incorrect service product/variant IDs, currency or price. No production configuration, credentials or cart was changed.

The isolated rehearsal under `/private/tmp/anawin-order-rehearsal` still points exclusively to `anawin-test.myshopify.com`, retains its test checkout restriction, MI26 $290 price, glove variant `54382403551595` and service variant `54382402699627`. Source/control hashes taken during this review remain unchanged. No test credentials, IDs, host restrictions or purchase overrides were copied into production source.

## Validation

Changed files:

- `src/catalog.js`, `src/main.js`, `src/storefront-render.js`
- `public/images/full-size/mint-back.jpg`, `mint-back-480.webp`, `mint-back-960.webp`, `mint-back-1254.webp` in the same directory
- `test-support/shopify-fixture.js`, `test/cart-row.test.js`, `test/full-size-commerce.test.js`, `test/prerender.test.js`
- `scripts/browser/break-in-browser.mjs`
- `docs/full-size-pricing-verification.md`, `docs/full-size-break-in-integration.md`, `docs/full-size-break-in-review.md`

- `VITE_COMMERCE_MODE=local npm test`: 391 passed, zero failures; includes build and prerender.
- Separate `VITE_COMMERCE_MODE=local npm run build`: passed; 16 public routes plus 404 prerendered.
- `git diff --check`: passed.
- Mocked Chrome checks at 1440px and 375px: passed. All four models show $285/$360/$285 as service is toggled, with Coming Soon preserved and no horizontal overflow. Keyboard behavior, labels, validation/focus, accessibility-tree alerts and service instruction groups, distinct configurations, reload and cart protections passed. All external browser requests were blocked; cart operations used only the loopback fixture.

Sanitized product-query evidence: `/private/tmp/anawin-prices-20261111.json`. Test/build logs: `/private/tmp/anawin-pricing-tests-20261111.log` and `/private/tmp/anawin-pricing-build-20261111.log`. Browser evidence: `/private/tmp/anawin-pricing-browser-20261111/`.

## Remaining release blockers

- Commit/push/merge/deployment and full-size launch approval remain pending by owner instruction. Production still serves its earlier release; it does not yet contain these price/image changes or this branch's full-size service integration.
- The revised service-only customization's actual order/notification/fulfillment presentation remains unverified without a separately authorized order. Earlier live test-store carts establish cart/checkout evidence, not fulfillment proof.
- Admin-only channel publishing, inventory tracking, tax settings and market restrictions remain unverified; this review did not access or change Admin.
- Live discount, currency/market eligibility, quantity/removal instruction and failure scenarios remain limited to prior evidence and mocks. Existing fail-closed limits for uncertain cart creation, carts beyond 50 lines and simultaneous writes remain as documented in the integration review.

Pricing is no longer a release blocker. Earlier integration/review documents retain historical production prices and test-store totals; this report supersedes their production pricing discrepancy findings only.
