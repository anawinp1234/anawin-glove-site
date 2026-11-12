# Isolated Shopify test-order procedure — not executed

This is a proposed procedure. It is not authorization to create a cart, submit an order, charge a card, change Admin settings, send notifications, adjust inventory, cancel/refund an order or fulfill anything. None of those actions was executed during this review. Obtain approval for the exact environment, order contents and cleanup before proceeding.

## 1. Environment and availability gates

**Use a dedicated, already prepared nonproduction Shopify store.** A localhost storefront connected to ANAWIN's production shop still creates production carts and orders. The current `scripts/browser/break-in-server.mjs` uses mocked Shopify responses; it cannot verify Shopify checkout or order creation.

Have the owner identify the nonproduction shop domain, its Headless public token, its existing test payment provider, a test shipping destination and the people responsible for notifications, inventory and fulfillment. Read those settings before testing. If a prepared store is unavailable, stop: provisioning products, changing publishing/payment settings or disabling automations needs separate approval. Do not change ANAWIN production settings to make the test possible.

Prepare a throwaway copy of the reviewed source outside the deployment checkout, for example `/private/tmp/anawin-order-rehearsal`. Record the reviewed source revision and the exact local adaptations:

- Use only the nonproduction domain/token, API `2026-07`, and that store's trainer/full-size handles. Confirm the actual returned API version on a read-only request.
- Record a mapping from every production reference to its nonproduction equivalent: MI26 Left-Hand Throw, BR16, the $75 full-size service and the $20 trainer service. IDs do not transfer between stores. Query each variant's product, price, currency, hand, `availableForSale` and shipping requirement before any mutation.
- In **that throwaway copy only**, adapt the pinned full-size service product/variant constants and the exact approved checkout host to the test store. Keep the allowlist restricted to that single test host; do not permit arbitrary hosts. The production pin is product `15498355474680`, variant `68062398808312`; it must not be used against a cloned catalog. Review the isolated adaptation diff before execution.
- Enable purchase rendering only in that throwaway copy. All four `comingSoon: true` flags in the production checkout remain unchanged. Do not deploy the rehearsal.
- Require the test products to be already active, available in Headless and purchasable for the test destination. Check tracked glove stock at the intended test location. Services must already be configured as nonphysical and, as intended, inventory-untracked. If those conditions are not met, stop rather than modifying inventory, channels, categories, taxes, markets or discounts.
- Disable real analytics/newsletter transmission in the isolated copy; do not submit signup forms. Use a new browser profile, empty test-store cart storage and no customer session. No existing customer cart may be reused. Keep cart IDs/checkout keys out of shared screenshots and logs.

A production connected rehearsal is a **different plan**, requiring explicit approval for a real production order and its financial/operational effects. Do not silently fall back to it. The current CM24 $290 live versus $285 intended discrepancy must be resolved separately before CM24 is included in any purchase test.

## 2. Payment, notifications and fulfillment gates

Use the nonproduction store's **already enabled Shopify Payments test mode**, or its already configured Shopify Test/Bogus Gateway. Record which one is present. Do not toggle production payment mode, use a real card in the nonproduction plan, or substitute a manual payment method to simulate a gateway transaction. Shopify advises against enabling test mode on a production store. [Shopify Payments testing](https://help.shopify.com/en/manual/payments/shopify-payments/testing-shopify-payments).

For Shopify Payments test mode, the purchaser can enter Visa `4242424242424242`, a two-word test name, a future expiry and a three-digit security code. Use that number only after confirming the test-mode environment. If the prepared store uses the Test/Bogus Gateway instead, follow that gateway's documented test inputs rather than reusing these card details. The purchaser completes the payment themselves. Verify the resulting order/transaction is marked as a test and no real charge was captured. [Successful Shopify Payments test transactions](https://help.shopify.com/en/manual/payments/shopify-payments/testing-shopify-payments#simulate-successful-transactions).

Before submission, the owner must confirm that the prepared environment routes customer/staff notifications, SMS, Shopify Flow, webhooks, email marketing and connected apps only to controlled test recipients/endpoints. Test payments do not establish that these side effects are contained. Use a dedicated controlled QA inbox if email delivery is part of the evidence; otherwise an `@example.com` test address avoids reliance on a real customer's account. Do not opt into marketing, add a real customer's phone, or manually send messages. [Shopify test-order considerations](https://help.shopify.com/en/manual/checkout-settings/test-orders/processing-test-order).

Require confirmation that no warehouse, 3PL, shipping-label, picking or break-in processing automation can act on these test orders. An order note saying “TEST” is not an isolation control. If this cannot be guaranteed with the existing test environment, stop; do not disable production integrations in this task. Do not buy a label, mark a line fulfilled or perform physical glove work. Shopify specifically cautions against fulfilling test orders and warns about automatic fulfillment and label costs. [Shopify Payments test-mode precautions](https://help.shopify.com/en/manual/payments/shopify-payments/testing-shopify-payments#test-mode).

## 3. Approved order contents and expected contract

Authorize one test order containing two identical MI26 Left-Hand Throw variants with distinct instructions, plus one BR16 trainer with its existing default service. This checks association and mixed service types in a single order. Verify all quoted prices before payment; do not force a price with a discount.

| Field | Full-size glove A | Full-size glove B | Trainer C |
| --- | --- | --- | --- |
| Model / hand | MI26 / Left | MI26 / Left, **same variant as A** | BR16 / catalog hand |
| Quantity | 1 | 1 | 1 |
| Service | $75 full-size | $75 full-size | $20 trainer |
| Wearing style | Traditional — index finger out | Other — describe your finger placement | Traditional |
| Other placement | Absent | `QA B custom placement` | Not applicable |
| Thumb closure | Ring finger | Recommend for me | Not applicable |
| Thumb shape | None | Recommend for me | Not applicable |
| Pinky shape | Recommend for me | None | Not applicable |
| Finger form | Recommend for me | Rolled | Not applicable |
| Firmness / level | Medium | Firm | Medium (65%) |
| Optional notes | `QA A — leave thumb unchanged` | `QA B — team chooses thumb and closure` | Existing trainer metadata |

At $290 per MI26 and $155 for BR16, the expected merchandise subtotal is **$905 USD**: two × ($290 + $75), plus ($155 + $20). Tax/shipping/duties are whatever the prepared test environment calculates; record them and stop if unexpected. Do not bypass market or tax rules. If the trainer price differs at preflight, revise the approved expectation before submission.

Expected finalized cart: three glove parents and three service children, each quantity 1. A and B must remain distinct despite sharing a merchandise ID. Every child must reference its exact parent's cart line ID via Shopify `parentRelationship`; visual ordering or matching merchandise ID is not sufficient. Shopify documents `parent.lineId` for existing lines and `parent.merchandiseId` when both lines are added in the same request. [Creating nested cart lines](https://shopify.dev/docs/apps/build/product-merchandising/nested-cart-lines/create-nested-cart-lines).

For each full-size pair, inspect the service line only for `Glove Model`, `Throwing Hand`, `Glove Wearing Style`, `Thumb Closure`, `Thumb Shape`, `Pinky Shape`, `Finger Shape` and `Firmness`; B also has `Finger Placement`, and each service has the correct `Notes`. The customer-facing label is Finger form; `Finger Shape` is the retained storage key. `None` and `Recommend for me` must appear literally, with no substituted shape/closure. The parent must have no readable customization/model/hand properties: retain only its internal service/type markers and configuration fingerprint. Verify the purchased variant’s actual throwing hand against the service metadata, and keep Shopify’s parent relationship intact. Trainer C must retain its trainer-only internal markers and readable child `Break-In Level` / `Glove Wearing Style` attributes.

## 4. Cart and checkout execution after authorization

1. Snapshot test-store availability and inventory by variant/location, payment mode, notification routing and fulfillment isolation. Record who approved placement and cleanup.
2. Add A, B and C from the isolated storefront. Inspect mutation `userErrors`, actual returned lines and a fresh cart read. Record sanitized parent/child IDs, variant IDs, quantities, prices, currency and attributes.
3. Before payment, repeat-add A, verify only A's serviced quantity becomes 2, then return A to 1. Remove B's service and verify A/C are unchanged; remove B's glove and deliberately re-add B with the approved instructions. Reload and verify the finalized three-parent/three-child contract above. These are dedicated test-cart mutations only.
4. Capture desktop and 375px evidence for the final cart. Confirm all instructions are visible as text and match the approved table.
5. Select checkout. Confirm the fresh Shopify URL uses the test store's exact approved host. Review checkout again: model/hand, distinct A/B properties, two $75 services, one $20 service, quantities, tax and shipping. Stop if anything differs. No accelerated checkout shortcut should bypass this review.
6. The authorized purchaser completes the single test payment. Record the test order ID, transaction status, test-mode indicator, totals and controlled notification evidence. Do not repeat payment or submission blindly after an ambiguous response; inspect the order list with the owner first.

## 5. Inventory, order inspection and fulfillment handling

Treat an order as capable of affecting inventory **in its connected store**, even when its payment is simulated. Record available, committed and on-hand quantities at the relevant locations before/after the order. Expect ordered quantities to follow that store's inventory policy: two MI26 left-hand gloves and one BR16. Confirm the untracked services do not consume stock. Record actual effects rather than assuming test mode prevents them. Do not change tracking, overselling policy or quantities to avoid this check.

Inspect the resulting Shopify Admin order and its fulfillment view with an authorized operator. Establish the order-level parent relationship using the version's actual relationship fields or visible Admin nesting with recorded line IDs; do not infer it solely from adjacent rows, duplicate variants or matching attribute strings. Compare each full-size service line's custom attributes to the table and confirm its parent has only the required private markers, including Other placement, literal None/recommendation values, hand, notes and service type. Check that a fulfillment operator can identify precisely which physical glove receives which instructions and charge. Do not mark the order fulfilled to test visibility.

Capture only the controlled test notification; verify its model/hand, service charge and customization presentation. If Shopify Admin or an integration omits a field, distinguish “present on cart,” “present on order” and “visible to fulfillment.” One does not prove the others. Record any downstream template/integration gap separately. POS behavior remains outside this test; Shopify's nested-line creation support does not extend to POS creation. [Nested-line limitations](https://shopify.dev/docs/apps/build/product-merchandising/nested-cart-lines#limitations).

Only after evidence is saved and cleanup is separately approved, have the operator cancel the test order using the agreed notification/restock options. Verify resulting inventory and any test payment reversal/void status. Do not assume inventory automatically returns to its original value or that every order can be deleted. Record the final order/inventory state and leave the audit trail. Production settings and Coming Soon flags must be unchanged before and after the rehearsal.

## Completion criteria and current status

A successful future run requires an actual test order ID, test payment proof, the six-line association/attribute evidence, notification results, observed inventory effects, fulfillment-view evidence and recorded cleanup. None exists yet. Local mocks and the read-only production reference query establish none of these order-level outcomes. **Order metadata and fulfillment remain UNVERIFIED.**
