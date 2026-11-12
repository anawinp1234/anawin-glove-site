# Full-size break-in integration

Implemented on `break-in-integration`, based on `fullstack-review` at `62ac38e`. The original worktree was clean. The remote is `anawinp1234/anawin-glove-site`; the other worktree is the main checkout. No applicable `AGENTS.md` files were found. No commit, push, PR, merge or deployment was performed.

## Verified cause and behavior

The full-size form previously only updated the setup summary. Full-size products were excluded from commerce configuration; product lookup selected only the first variant; cart service validation understood only trainer preferences; and the full-size button was permanently disabled. All four models remain `comingSoon: true` in production.

The integration adds optional full-size product handles and loads throw-hand variants. The purchase handler requires a deliberate throw hand and, only with service selected, wearing style, thumb closure, thumb shape, pinky shape, finger form and firmness. Other requires nonblank placement. Placement and notes are trimmed and limited to 2,000 characters. Trainer defaults and $20 choices remain unchanged.

Full-size additions use the verified $75 service variant. New full-size additions keep readable model, throw hand and customization attributes only on the nested service. The parent retains private service/type markers and a SHA-256 configuration fingerprint. Shopify merchandise options supply the glove’s actual throw hand. Different instructions produce distinct parent configurations; identical repeated additions can share a configuration with synchronized quantities. When a variant already exists in the cart, the parent is resolved using its attributes and quantity change, then the child is attached by cart line ID. Merchandise ID alone is not used to resolve ambiguous existing parents.

Cart rendering displays the service charge, hand and instructions as escaped text. The existing quantity, remove-glove, remove-one-service, reload and recovery paths support full-size lines. Adding full-size service from the cart using trainer defaults is blocked; customers choose instructions on the glove page when adding a glove. Serviced multi-quantity entries retain the existing “remove break-in from 1” behavior.

Checkout checks service type and the full-size service variant, actual parent relationship, matching quantities and matching required instructions. Additions inspect mutation errors, re-read the resulting cart and compare pre-existing configurations before reporting success. Known partially created carts remain available for review. Ambiguous mutations block checkout and use the existing explicit recovery path, preserving the original cart; they do not retry or delete pre-existing items. Checkout re-fetches Shopify state and uses the current verified checkout URL.

These browser checks are UX safeguards. They are not server-side purchase enforcement. Order metadata and fulfillment remain **UNVERIFIED** until an explicitly authorized order is inspected in Shopify.

## Live read-only Shopify verification — November 11, 2026

The public Storefront API confirmed the following. The response header was `x-shopify-api-version: 2026-07`.

| Service | Product ID | Variant ID | Handle | Price | Requires shipping |
| --- | --- | --- | --- | --- | --- |
| Trainer | 10334722392312 | 50525848633592 | break-in-service | $20 USD | false |
| Full-size, current | 15498355474680 | 68062398808312 | full-size-glove-break-in-service | $75 USD | false |

The originally supplied full-size product `15496314847480` and variant `68055644274936` returned `null` through Headless. This does not prove deletion; they may no longer be visible to that channel. The user confirmed that the replacement listing is intentional and authorized using the new IDs. The full-size service loader checks the current product ID, variant ID, USD currency and $75 price and disables service if they differ.

| Model | Verified handle | Shopify variant IDs | Live USD price | Intended/local USD price |
| --- | --- | --- | --- | --- |
| MI26 | mi26 | Right 68055435968760; Left 68055436001528 | $290 each | $290 |
| BL50 | bl50 | Right 68055446323448; Left 68055446356216 | $290 each | $290 |
| OR17 | or17 | Right 68055559340280; Left 68055559373048 | $290 each | $290 |
| CM24 | cm24 | Default Title 68055715184888; right hand only in catalog | **$290** | **$285** |

MI26, BL50 and OR17 use Shopify option `Throwing Hand` with values `Right` and `Left`. CM24 has one `Default Title` variant, which is mapped to its catalog's only permitted hand, Right. No Shopify prices were changed. The three $290 display prices were corrected individually; CM24 remains $285 locally, and its live discrepancy is a launch blocker.

Inventory tracking cannot be established using this token: an initial inventory quantity query was denied for missing `unauthenticated_read_product_inventory`. Nonphysical status was verified with `requiresShipping: false`; untracked inventory remains reported, not independently verified. No live cart was created or changed and no checkout or order was submitted.

The configured API semantics were reviewed against official Shopify [2026-07 cartLinesAdd](https://shopify.dev/docs/api/storefront/2026-07/mutations/cartLinesAdd) and [CartLineParentInput](https://shopify.dev/docs/api/storefront/2026-07/input-objects/CartLineParentInput) documentation. `parent` represents an actual nested line relationship; custom attributes alone do not establish one.

## Files

- `src/catalog.js`: service references, full-size instruction normalization/attributes, cart validation and individual display prices.
- `src/commerce.js`: optional full-size handles, variants, service loading, parent resolution, post-mutation validation and recovery metadata.
- `src/main.js`: conditional full-size validation, variant selection, submission and service availability.
- `src/storefront-render.js`: purchase-capable form rendering behind the unchanged catalog Coming Soon gate; trainer collection filtering.
- `src/cart-row.js`, `src/style.css`: readable hand/instructions, image support and text wrapping.
- `src/checkout-safety.js`: service type included in the checkout state signature.
- `.env.example`: optional MI26, BL50, OR17 and CM24 handles. Configuring handles alone does not launch products.
- `test-support/shopify-fixture.js`: extracted existing Shopify fixture, extended with full-size service and hand variants; also used by the browser fixture server.
- `test/commerce.test.js`: shared fixture import and expected extra explicit-parent request.
- `test/full-size-commerce.test.js`: full-size, mixed-cart, customization, failure, recovery and checkout coverage.
- `scripts/browser/break-in-server.mjs`, `scripts/browser/break-in-browser.mjs`: reproducible loopback-only browser rehearsal. The preview server transforms Coming Soon flags in served modules only and injects a mocked Shopify transport. Source flags and production configuration are unchanged. The browser blocks external HTTP requests.

## Verification

Run from the worktree:

```sh
VITE_COMMERCE_MODE=local npm test
VITE_COMMERCE_MODE=local npm run build
git diff --check
```

The local commerce environment is explicit because this checkout contains no production `.env` file. Build checks and prerendering run as part of `npm test` as well.

For browser reproduction, start `node scripts/browser/break-in-server.mjs`, then run `node scripts/browser/break-in-browser.mjs` in a second terminal. Chrome is expected at its standard macOS application path. Ports 5199, 5200 and 9417 must be available.

Browser evidence is written to `/private/tmp/anawin-break-in-evidence/`: `results.json`, `form-1440.png`, `form-375.png`, `cart-1440.png`, `cart-375.png`. Both 1440px and 375px checks exercise the real application handlers with mocked Shopify responses: required errors and focus, field labels, keyboard checkbox/radio navigation, Other text, selected hand, escaped notes, service price, exact one-item double-click protection, separate instructions, reload and page/drawer overflow. All four unmodified full-size pages are separately checked for disabled purchasing at both widths. Screenshots were visually inspected. No manual screen-reader session was performed; browser checks cover alert/focus semantics, labels and keyboard interaction.

Automated tests additionally cover all four models with/without service, trainers with/without service, mixed trainer/full-size carts, different/repeated customizations, child quantity synchronization, removing one service, glove removal, reload, missing options, Other without text, wrong service references/type/parent/quantity/instructions, failed API responses, partial mutations, new-cart partial errors, safe recovery, unavailable variants and fresh checkout URLs. Existing trainer checkout, metadata and cart recovery tests remain in the full test suite.

Final verification: `VITE_COMMERCE_MODE=local npm test` passed **374 tests**, with 0 failures, skips or cancellations. The separate `VITE_COMMERCE_MODE=local npm run build` and `git diff --check` passed. Chrome passed at both widths, including accessibility-tree checks for named radios and the error alert. These are mocked/local results, separate from the read-only live reference checks above.

## Remaining Shopify and launch work

- Resolve CM24's $290 live price versus the intended $285 through a separately authorized pricing decision. Do not launch with conflicting advertised and checkout prices.
- Confirm the **replacement** full-size service's publishing in Admin: Headless + Point of Sale intended; Online Store and Shop off. Headless visibility was verified, but POS reactivation and other channel states were not accessible through the public token.
- Verify inventory tracking on both services in Admin. Leave inventory unchanged in this work.
- Inspect the replacement service's tax settings and Managed Markets status. The reported trainer/full-size tax difference and restrictions for Australia, Canada, Japan, Mexico, Philippines and South Korea are not independently verified for the replacement listing. Their exact cause remains unknown. No taxes, categories or market restrictions were changed.
- Production full-size gloves remain Coming Soon. Optional full-size commerce configuration, a separately approved launch change and an authorized order inspection are still needed before launch.
- POS customization and fulfillment capture are a **separate follow-up**, not implemented here.

## Exact next step for an authorized test order

Follow the [isolated Shopify test-order procedure](full-size-break-in-test-order.md). It requires a prepared **nonproduction Shopify backend**, explicit authorization, test payment, controlled notifications, inventory snapshots and confirmed fulfillment isolation. A localhost frontend connected to production is not an isolated Shopify environment. The current mock server does not place real Shopify orders. No test order or Admin setting change has been performed. The procedure also explains why cloned stores require their own service IDs and exact checkout-host pins in a throwaway preview copy.

## Shaping extension

The full-size form includes three separate, unselected native radio groups after thumb closure and before firmness:

- Thumb shape: Straight / Flared / None / Recommend for me.
- Pinky shape: Straight / Flared / None / Recommend for me.
- Finger form: Rolled / Straight / Recommend for me.

Thumb closure also retains Middle finger / Ring finger / Pinky and now includes Recommend for me. Each group requires a deliberate selection only with full-size service checked. Thumb and pinky can have any independent combination. Helper text explains that None leaves that area’s existing shape unchanged and Recommend for me lets the ANAWIN team choose. Neither choice is converted to a specific shape or closure.

The summary and cart display these literal values. `Thumb Shape`, `Pinky Shape` and `Finger Shape` are serialized alongside `Thumb Closure` on the linked full-size service line, for order/fulfillment instructions. The glove carries a private configuration fingerprint instead of readable customization properties. The attributes participate in configuration identity, checkout validation, recovery and removal. Existing full-size carts missing the new required fields fail validation; no answers are invented. They need to be reconfigured deliberately before checkout. Previously complete duplicated-layout carts remain readable without automatic attribute changes; the service-only layout applies to newly configured additions.

Field-level alerts identify missing selections, connect errors through `aria-describedby` and `aria-invalid`, and focus the first control in the affected group. Selecting a field clears its error while preserving helper descriptions. Unchecking service disables the customization controls and removes required/error states. Existing native radio navigation and visible keyboard focus remain available. Customer notes still use text-only summary rendering and escaped cart rendering.

Regression coverage includes all 16 independent thumb/pinky combinations, missing/unsupported values, distinct None/recommendation serialization, recommended closure/finger shape, repeated identical variants with differing shaping instructions, reload, missing/duplicate attributes, and trainer defaults. Final verification passed **374 tests**, the separate local build, and `git diff --check`. Chrome passed at **1440px and 375px**, covering the real application handlers with mocked Shopify responses, summary and cart values, field errors/focus, native radio exclusivity, conditional validation and persisted distinct configurations. Desktop and mobile screenshots were inspected, including long labels and wrapped instructions. No manual screen-reader session was performed.

No live Shopify verification was performed for this extension. No Shopify Admin settings or real carts were changed. The prior read-only reference verification above remains separate from the local shaping checks. Order and fulfillment behavior remain **UNVERIFIED** pending an explicitly authorized test order and Admin inspection. All production full-size gloves remain Coming Soon. The latest user instruction is to leave all changes uncommitted; no commit, push, merge, PR or deployment was performed.

Customer-facing wording uses “Finger form” in the field, helper text, validation, summary and cart. The existing `Finger Shape` Shopify attribute key and internal field name are retained so saved cart instructions remain compatible.

## Integration review

See [findings and final checks](full-size-break-in-review.md) for the review against `fullstack-review`, fixes to cart safety/removal/line-ID handling, the renewed read-only reference check and remaining verification gaps. The earlier test counts above describe the shaping extension; the review report records the latest run. The optional notes helper now uses the requested text without appended examples.

## Current service-only attribute layout

Readable full-size instructions, optional Other placement/notes, Glove Model and Throwing Hand are serialized only on the $75 service line. A new serviced glove parent has exactly _anawin_service, _anawin_service_type and _anawin_configuration; the last value is a versioned SHA-256 fingerprint of the normalized selections. It is an identity/integrity check, not authentication. Identical normalized choices can merge quantities; distinct choices, placements or notes retain distinct parent identities even for the same variant. Shopify parentRelationship remains authoritative for linking the service.

Cart validation parses instructions from the service, recomputes the parent fingerprint and checks service metadata against the actual purchased variant’s returned Throwing Hand option and the glove model. Missing/duplicated instructions, modified service choices, wrong parent/hand, quantities or fingerprint block checkout. The cart displays actual product variant information separately from a named Break-in instructions group. Trainers retain their existing schema and defaults.

Quantity changes and removal continue to resolve parents by full identity, including the fingerprint. Removing service strips that fingerprint/type. Recovery preserves complete child attributes and the parent identity, checks unaffected child attributes rather than assuming duplicated parent text is sufficient, and retains compatibility with old saved layouts and recovery snapshots. Uncertain additions are not replayed.

Fresh verification: 388 tests passed, separate local build and git diff --check passed. Mocked Chrome checks passed at 1440px/375px with keyboard, labels, field alerts/focus, accessibility-tree instruction-group checks, distinct configurations and reload. One new unsubmitted anawin-test cart verified the service-only layout at $290 + $75 = $365, quantity 1 each, with exact API parent linkage. Desktop/mobile cart and hosted checkout showed all instructions on the service only, including literal None and Recommend for me, placement and notes. No payment was submitted.

The former checkout cart was no longer returned by Shopify; order #1001 was not accessed or changed. Inventory counts were unavailable to the public token, so live testing stayed at one glove/service pair. Distinct-pair, multi-quantity, removal and failure-recovery coverage is mocked/local. A future separately authorized order must verify the revised Shopify Admin/order/fulfillment presentation; cart/checkout evidence does not prove those views. Production full-size remains Coming Soon, with no commit, push, PR, merge or deployment.

Evidence: /private/tmp/anawin-service-only-1794453687770/ (raw cart/checkout keys remain private).
