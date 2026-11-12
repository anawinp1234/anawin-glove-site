# Review of the uncommitted full-size break-in integration

## Current revision: full-size instructions on the service only

New full-size additions now serialize all readable customization, model and hand attributes only on the linked $75 service. The glove retains private service/type markers and a versioned SHA-256 fingerprint. Actual merchandise option data supplies the glove’s hand; service model/hand and instructions are validated against that variant and fingerprint. The fingerprint also preserves distinct same-variant pairs without duplicating readable instructions. It is not a substitute for Shopify’s actual parent relationship or server-side purchase enforcement.

Dependency review covered parent identity/configuration snapshots, refreshed line-ID resolution, quantity synchronization, service-only splitting/removal, post-mutation checks and safe recovery. Recovery signatures now include complete child attributes, and unaffected-child comparisons reject instruction changes. Legacy saved duplicated-layout carts and pending snapshots remain readable/recoverable without automatic rewrites. Trainer behavior is preserved.

Fresh checks: **388 tests passed**, separate local build and git diff --check passed. SHA-256 is checked against Node’s platform implementation across UTF-8 and padding/length boundaries. Regressions cover service-only serialization, every supported choice, all thumb/pinky combinations, same-variant distinct notes/placement, equivalent-choice merging, variant-hand conflicts, missing/duplicate/tampered attributes/fingerprints, quantity/removal/rekeying and recovery. Mocked desktop/mobile checks passed with native keyboard behavior, field alerts/focus, labels, named accessible instruction groups and separate saved pairs.

One new, unsubmitted anawin-test cart verified the new layout through the real application. The previous cart was no longer returned, and order **#1001 was not accessed or changed**. Fresh live API evidence shows MI26 Left $290 and full-size service $75, each quantity 1, exact parent ID linkage, private-only parent attributes and complete readable service instructions. Hosted checkout at desktop/mobile widths showed the glove’s normal MI26/Left information and all choices/placement/notes only on the service; both None and Recommend for me remained literal. Contact remained blank and payment requests were blocked. Inventory quantity access was denied by the public token, so live quantities stayed at one pair; multi-pair/quantity/removal/recovery checks are local/mocked.

The revised order/fulfillment presentation remains **UNVERIFIED** pending a future authorized order. No Admin change, payment, order, fulfillment, cancellation, commit, push, PR, merge or deployment was performed. Production full-size remains Coming Soon. Earlier reports below are historical, including their duplicated parent/child attribute descriptions. Current evidence is preserved at /private/tmp/anawin-service-only-1794453687770/ with credentials/cart keys omitted from reports.

## Isolated cart diagnosis and checkout restoration — November 11, 2026

The owner-authorized replacement cart was independently re-read from `anawin-test.myshopify.com`, API `2026-07`. It retains the same dedicated cart identity, with MI26 Left variant `54382403551595` at $290 and nested service `54382402699627` at $75, each quantity 1. Shopify's subtotal is $365 USD. Every saved attribute matches the owner-confirmed submission, and the service's actual parent ID matches the glove. No cart mutation was performed during this diagnosis.

The affected browser was on `http://127.0.0.1:5209` and had the correct cart ID, but retained an unresolved `removal` safety record whose before-state described the earlier six-line, $905 cart. The browser that submitted the approved replacement had no such safety flags. Replaying the affected browser's captured storage reproduced both the initial warning and the failed Check cart result. The same Shopify response passes the normal application checkout verifier without that obsolete record. Check cart is read-only and deliberately does not clear unresolved operations; the preview server's mutation restriction was not blocking the reads. Captured diagnostic queries returned HTTP 200/API `2026-07` without GraphQL errors. There was no verified pricing, nesting, catalog-mapping or checkout-validator defect.

The isolated repair archives the exact browser failure state, proves its pending removal snapshot matches the superseded six-line cart, verifies the successful explicitly authorized same-cart replacement, and re-reads the current cart. It checks exact attributes, quantities, prices, parent relationship, coverage and test host, and runs the normal application checkout verifier before allowing only that captured stale record to be reconciled. Changed or unrelated safety records fail closed. It does not offer a generic flag reset, create a replacement cart, remove service or change the production safety logic. The owner confirmed reconciliation succeeded and checkout became enabled in the affected browser. All Shopify mutations are now blocked in the rehearsal server.

The price rail intentionally totals the glove and its service. `src/cart-row.js` now labels it **Glove + service total** and marks the service price **(included)**. Shopify prices, totals and discounts are unchanged. `src/style.css` supports wrapping the label; a regression checks the $290 + $75 = $365 scenario and unserviced presentation.

Fresh checks after the source change:

- `VITE_COMMERCE_MODE=local npm test`: **382 passed**, zero failures; includes build and prerender.
- Separate `VITE_COMMERCE_MODE=local npm run build` and `git diff --check`: passed.
- Isolated reconciliation proof checks: **11 passed**, including rejection of changed cart identity, safety operation, history, attributes, relationship, price, query coverage and production checkout host.
- Chrome at 1440px and 375px: captured failure replay, strict reconciliation, normal checkout enabled, clear combined-price labels, and handoff through the application's regular checkout verifier. The outbound test-checkout document was intercepted before payment; no Shopify mutation was attempted by these checks.
- Separately guarded hosted-checkout inspection passed at both widths: MI26 $290, service $75, exact owner instructions, $365 subtotal, test gateway visible and contact blank. Payment POSTs were blocked. Shipping and tax remain unfinalized without an address.

Private failure captures, network responses, proof records and screenshots are retained under `/private/tmp/anawin-order-rehearsal/evidence/checkout-investigation-1794399007655/`. Reports omit cart keys, tokens and the storefront password. The normal validated cart handoff is `http://127.0.0.1:5209/__handoff`; it opens the current saved cart and retains checkout validation. The earlier $905 evidence and original ledger remain preserved.

Production full-size gloves remain Coming Soon. No Admin change, commit, push, PR, merge, deployment, fulfillment, cancellation or payment was performed. Order-level instructions and fulfillment visibility remain **UNVERIFIED** until the owner completes a test payment and supplies authenticated Admin evidence. The remaining sections record the earlier integration review.

Reviewed on `break-in-integration` against local base `fullstack-review`, both at `62ac38e209425ebd0e2a0f14f738ee1e1909a2ee` before any commit. The review includes the tracked working-tree diff and all integration files not yet tracked by Git, including the integration document, shared fixture and browser scripts. Existing integration changes were preserved. No commit, push, merge, PR or deployment was made.

## Findings by severity

The references below identify the current fixed implementation. Counterexamples were exercised with the local Shopify fixture; they are not claims that Shopify was observed returning those outcomes live.

| Severity | Finding and consequence | Resolution / reference |
| --- | --- | --- |
| P1 — fixed | Quantity changes on an already unsafe cart could perform another mutation and clear the pre-existing unresolved-mutation flag when the resulting cart happened to be structurally complete. An unrelated completed-but-unconfirmed addition could thereby become checkout-eligible without explicit recovery. This inherited path is also used by full-size gloves. | Reject quantity changes before any mutation when the cart is incomplete/unsafe; disable the quantity controls in that state. `src/commerce.js:582`, `src/cart-row.js:59`; regression in `test/full-size-commerce.test.js`. |
| P1 — fixed | The integration's partial-new-cart error branch saved the returned cart ID before checking whether another tab had selected a different active cart. A delayed `cartCreate` response with `userErrors` could replace the other tab's cart in shared storage. | Check active cart identity immediately after the response, before all payload/error handling. `src/commerce.js:473`. The delayed partial-create regression asserts the other cart ID is retained. |
| P2 — fixed | Glove removal only checked for children still referencing the old parent ID. An unchanged result or wrong removal could report success; removing only service checked aggregate quantities but could accept changes to another glove's instructions. | Re-read the cart and compare all parent configurations and expected service totals; single-service removal also verifies the complete before/after conversion. Unexpected results block checkout rather than retrying or repairing other items. `src/commerce.js:563`, `src/commerce.js:691`, `src/commerce.js:1219`. |
| P2 — fixed | Quantity synchronization assumed parent/child IDs remained unchanged after mutations. Refreshed IDs could leave a valid quantity update unusable, especially with two configurations sharing a variant and with separately synchronized child quantities. | Resolve refreshed lines using merchandise **and full instruction attributes**, then follow their current parent IDs. Verify the selected quantity and every unaffected configuration. `src/commerce.js:594`, `src/commerce.js:608`, `src/commerce.js:615`. Tests cover refreshed IDs with native and explicit child synchronization. |
| P2 — fixed | A new cart returned with partial errors and only unrecognized lines normalized to zero known lines. The integration could discard this known cart ID, leaving the result unavailable for review and allowing a new attempt without resolving it. | Decide whether the returned cart is nonempty using raw response lines; retain its ID and unsafe flag even when the app cannot recognize its lines. `src/commerce.js:487`. No automatic retry occurs. |
| P1 operational — corrected in documentation | The former short test-order procedure called a production-connected localhost preview “isolated,” without accounting for payment, notifications, inventory, fulfillment or the hardcoded production ID/checkout-host pins. Localhost does not isolate Shopify's backend. | Replace it with a gated nonproduction-backend procedure that records the necessary preview-only mappings and requires an existing safe payment/notification/fulfillment setup. `docs/full-size-break-in-test-order.md:5`. No setup or order was executed. |
| P3 test evidence — fixed | Browser navigation/reload waits could inspect the previous document. An early failure could also leave a stale passing evidence JSON from a prior run. | Wait for a new document explicitly; write running/passed/failed status and timestamp to evidence. `scripts/browser/break-in-browser.mjs`. The final rerun passed at both widths. |
| P1 launch blocker — unresolved, Admin changes out of scope | CM24 is advertised locally at its intended $285, while the read-only production query still returns $290. This discrepancy must be resolved before purchase access is launched. | Preserve $285 in the catalog and keep all full-size products Coming Soon. `src/catalog.js:205`. No Shopify prices were changed. |

The source safety and line-ID gaps above include inherited base-branch behavior exposed by the full-size integration; the partial-new-cart retention/race branches and test-order document were introduced by this uncommitted integration. No remaining code defect was identified in the reviewed paths after these fixes, within the mocked verification limits below.

## Why the $75 variant changed

The original task supplied product `15496314847480` / variant `68055644274936`. Earlier read-only verification found the handle resolving to product `15498355474680` / variant `68062398808312`, and the user explicitly confirmed: “yea i did the new id use that one.” This is an authorized replacement listing, not a guessed variant substitution.

The review repeated the read-only Storefront query. It returned no GraphQL errors and response version `2026-07`:

| Reference | Current result |
| --- | --- |
| Trainer `break-in-service` | Product `10334722392312`, variant `50525848633592`, $20 USD, `requiresShipping: false` |
| Full-size `full-size-glove-break-in-service` | Product `15498355474680`, variant `68062398808312`, $75 USD, `requiresShipping: false` |
| Original full-size product and variant nodes | Both `null` through this Headless token; this does **not** establish deletion |
| MI26 / BL50 / OR17 | Each Right and Left variant is $290 USD and available for sale in the query context |
| CM24 | Single Default Title variant, $290 USD, available for sale in the query context |

The current pins are in `src/catalog.js:13`; the loader checks product ID, variant ID, $75 and USD in `src/commerce.js:999`, and disables full-size service if they differ. It does not silently fall back to the old variant or trainer service. The trainer path still uses its configured handle and existing defaults; the read-only query confirms that handle currently resolves to the expected $20 variant.

Raw review evidence is local at `/private/tmp/integration-review-live.json` and `/private/tmp/integration-review-live-headers.txt`. It contains catalog references, not cart or order evidence. No live cart was created, mutated or checked out. Admin publishing, inventory tracking, taxes and markets were not queried or changed.

## Parent association and serialization audit

Shopify's documented Storefront relationship is `parent.lineId` for existing cart lines or `parent.merchandiseId` when adding parent and child together. Custom attributes are not a replacement for this relationship. [Official nested-line creation semantics](https://shopify.dev/docs/apps/build/product-merchandising/nested-cart-lines/create-nested-cart-lines).

The initial unique-variant addition uses the same-request parent relationship. If that variant already exists, the integration first adds/resolves the exact parent configuration using variant, attributes and quantity delta, then attaches the service with `parent.lineId`. Ambiguous resolution fails closed. Recovery also matches full attributes before assigning new parent IDs. Quantity updates now follow refreshed IDs using the same configuration identity. Removing a glove relies on Shopify's native cascade but verifies the resulting cart; removing one service from quantity greater than one splits exactly one glove into an unserviced configuration and verifies all configurations.

The full-size lines contain:

- Readable model and throw hand on both glove and service.
- Wearing style, conditional Other placement, thumb closure, thumb shape, pinky shape, finger form storage key `Finger Shape`, firmness and optional notes on both lines.
- Literal `None` and `Recommend for me` values. No normalizer substitutes a specific shape or closure.
- Parent service/type markers that prevent serviced and unserviced entries from merging.

The regression suite checks every supported enum value through actual fixture mutations and reload, all 16 independent thumb/pinky combinations, duplicated/missing attributes, mixed trainer/full-size carts and identical variants whose only difference is one shaping instruction. Repeated equivalent instructions may merge quantities, but different instructions remain separate. Trainer children retain readable level/style metadata and the existing trainer defaults.

Checkout rejects incomplete coverage, unknown or unsupported lines, mismatched service type or full-size service variant, orphaned children, unequal quantities, missing/duplicate required instructions and mismatched parent/child attributes. It reads fresh Shopify state and uses the current approved checkout URL. These are client UX safeguards, not server-side purchase enforcement. Requests with mutation errors, omitted children, ambiguous responses or inconsistent cart results do not establish success and are not blindly replayed.

## Desktop/mobile and text safety

The real application handlers were exercised with local mocked Shopify responses at 1440px and 375px. The script verified all four production Coming Soon gates, native radio exclusivity and keyboard selection, named fieldsets/labels, field-level errors with `aria-invalid`/`aria-describedby`, focus on the affected control, conditional required/disabled state, literal None/recommendation summaries, cart instructions/charge, one-item double-click behavior, separate configurations and reload. Accessibility-tree checks cover the error alert and radio names. Screenshots were inspected for wrapping and overflow. This is not a manual screen-reader or Safari/VoiceOver audit.

Customer summaries use `textContent`; cart values and field/help copy are HTML-escaped. The browser enters an HTML-looking note and confirms no corresponding image element is created in cart instructions. Free text remains trimmed and limited to 2,000 characters. The optional notes helper now uses the latest requested copy without appended examples.

## Actual checks after fixes

Final results after all fixes:

- `VITE_COMMERCE_MODE=local npm test`: **381 tests passed**, 0 failed, skipped or cancelled. This includes the build and 16-route prerender, existing trainer/checkout/recovery regressions and the new review regressions.
- `VITE_COMMERCE_MODE=local npm run build`: passed separately; 16 public routes plus `404.html` prerendered.
- `git diff --check`: passed.
- `node scripts/browser/break-in-browser.mjs`: passed at **1440px and 375px**, with the loopback-only fixture server running. The latest evidence reports `status: passed`, start `2026-11-11T10:30:14.706Z`, zero runtime exceptions and no external requests. No manual screen-reader session was performed.

The local environment is explicit because there is no production `.env` in this worktree. No Shopify mutation or order was used to run these checks.

Browser evidence: `/private/tmp/anawin-break-in-evidence/results.json` records the latest run's status/timestamp, with `form-1440.png`, `form-375.png`, `cart-1440.png` and `cart-375.png`. All browser cart operations are mocked and all external requests are blocked. The browser harness does not complete a real checkout; fresh checkout URL handoff is covered by unit tests.

## Remaining verification gaps and next step

- Order metadata, actual Shopify merging/nesting behavior for these customizations, order notification presentation and fulfillment visibility remain **UNVERIFIED** without an explicitly authorized Shopify order. API documentation and local mocks do not establish those outcomes.
- Confirm the replacement service's Headless + POS publishing, Online Store/Shop off, inventory-untracked state, tax settings and market restrictions in Admin. Only Headless catalog visibility and nonphysical status were independently checked. The reason for reported Managed Markets restrictions remains unknown.
- Resolve the CM24 price discrepancy. Keep full-size production purchase access disabled until launch approval and the remaining checks are complete.
- Real `canRemove` / `canUpdateQuantity`, discounts, currency/market eligibility and failure behavior still need the prepared Shopify environment. Current code respects returned instructions and fails closed; mocks are not live proof.
- Initial `cartCreate` network failure with no returned ID cannot identify an unknown remote cart. The app reports an uncertain creation and never automatically retries or hands off checkout for it.
- Large carts beyond the queried 50 lines fail closed through coverage checks; pagination expansion is not part of this change. Simultaneous cross-tab writes to the same cart are not made transactional by the UI action gate; before/after checks and shared safety flags are safeguards, not a distributed transaction.
- No POS customization workflow or server-side enforcement was added. A cloned test catalog also needs explicit local service-ID and checkout-host adaptation because production pins are intentional.

Follow [the isolated Shopify test-order procedure](full-size-break-in-test-order.md) only after explicit approval. It specifies environment, product availability, test payment, notifications, inventory effects, fulfillment handling and cleanup. No test-order step was executed in this review.
