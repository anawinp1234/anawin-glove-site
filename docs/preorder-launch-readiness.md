# Full-size preorder: launch readiness (integration review)

> **Launch update, November 20, 2026 (branch `pre-order-launch`).** The owner approved the launch. All four models are now `comingSoon: false` with preorder enabled and the estimate `December 4-10, 2026` (gloves arrive December 3). The price is $295 ($370 with the $75 service). `PREORDER_CHECKOUT.chargedInFullAtCheckout` is `true`: the owner confirmed automatic capture and no preorder or deposit app. The announcement bar promotes PREORDER30 ($30 off each full-size glove; never the break-in service). The Shopify Admin tasks at the end of this document still apply, and the metafield value must match the estimate exactly, ASCII hyphen included.

Status: November 18, 2026. Combined, uncommitted work from the website, commerce and email branches plus the integration corrections below. Every full-size model stays Coming Soon. No Shopify setting, price, product, discount, template or customer record was changed, and no email was sent.

## What "verified" means here

| Label | Meaning |
| --- | --- |
| Code + mocked tests | Implemented and covered by `npm test` against `test-support/shopify-fixture.js`. Not Shopify. |
| Production read-only | Public Storefront API queries or schema introspection against `ignvv0-zh.myshopify.com`, API 2026-07. No mutations. |
| Docs | Official Shopify documentation, cited. Not observed behavior. |
| **Unverified** | Needs Shopify Admin, the test store, or an authorized test order. None was available. |

## 1. Single source for preorder wording

`src/catalog.js` defines every preorder string and contract name. `src/policy-content.js` re-exports them and defines none of its own. The email snippets are checked by tests against the same values.

## 2. Policy and FAQ copy

The Shipping Policy gets a Preorders section and the FAQ gets a Preorders group. Both render only while a Shopify-confirmed preorder is active and products loaded without error. Prerendered pages never include them (tested against `dist/`).

## 3. "Paid in full at checkout" disclosure

- **Shown on:** the product page (next to the estimate, read by screen readers with the button), the cart preorder disclosure, the Shipping Policy and the FAQ.
- **Unverified: payment capture mode.** The Storefront API doesn't expose it (production introspection of `Shop`/`PaymentSettings` returned nothing). Opening a hosted checkout would require creating a production cart, which this review didn't do.
- **How it's enforced:** `PREORDER_CHECKOUT.chargedInFullAtCheckout` in `src/catalog.js` is `false`. While it's `false`, no preorder can be added, checked out, labelled, or given an offer in structured data (`payment-unverified`). The owner sets it to `true` only after confirming the settings below.
  - Settings > Payments > Payment capture method = **Automatically at checkout**.
  - No selling plan, deposit or "pay later" preorder app on the four gloves. Production Storefront showed no selling plan groups on visible products, but the gloves themselves are currently hidden from the Headless channel.
- **Why manual capture doesn't work:** Shopify Payments card authorizations expire after about 7 days ([payment authorization](https://help.shopify.com/en/manual/payments/payment-authorization)). Manual capture would make the disclosure false and preorders unsafe.

## 4. Preserving the estimate with the order

- **Implemented:** the estimate is written as a cart-level attribute, `Preorder estimated ship`, during `commerce.checkout()`, inside the existing checkout lock and before the existing verification.
- **Why cart-level:**
  - Line attributes are left alone, so `_anawin_configuration` fingerprints, wrist fit, break-in instructions, parent/child service links and the line-identity matching in checkout validation can't change.
  - `checkout-safety.js` doesn't include cart attributes in its signature, so the write doesn't trigger a "your cart changed" review.
  - Shopify copies cart attributes onto the order. Notifications read them as `attributes` (Docs).
- **API shape:** `cartAttributesUpdate(cartId, attributes: [AttributeInput!]!)` returning `cart`, `userErrors`, `warnings` (production read-only introspection).
- **Replace or merge:** Shopify doesn't document which one `cartAttributesUpdate` does. The code always sends the full list (other attributes kept). If a removal leaves the key behind, it retries once with a blank value. Checkout stays blocked unless the saved value matches exactly. Both behaviors are tested against the fixture.
- **Failure handling:** an uncertain write freezes the cart and goes through the existing recovery path (tested). Trainer-only carts with no preorder history make no extra request (tested).
- **Unverified:** that the attribute appears in Admin > Orders > Additional details and in the Order confirmation `attributes` object on a real order.

## 5. Inventory and the preorder cap

**What the code does (reviewed):**
- A glove can be sold only while Shopify reports a variant `availableForSale`. Adding to cart also requires the chosen throw-hand variant to be `availableForSale`.
- Quantity increases rely on Shopify's `MERCHANDISE_NOT_ENOUGH_STOCK` warnings, which the existing cart already handles.
- The storefront doesn't count or cap anything. The public token can't read inventory: `quantityAvailable` returns `ACCESS_DENIED` (production read-only). A browser-side cap wouldn't be enforcement anyway.

**What Shopify decides (Unverified for these products):**

| Setup | Preorder behavior | Cap |
| --- | --- | --- |
| Track quantity ON, "Continue selling when out of stock" OFF, available = preorder allotment per variant | Allocated inventory. Shopify refuses quantities above stock in the cart and at checkout. When it hits 0, `availableForSale` turns false and the site shows the model as unavailable. | **Enforced by Shopify, per variant** (Right and Left separately) |
| Track quantity ON, "Continue selling" ON | Oversells into negative stock | None |
| Track quantity OFF | Unlimited | None |

- **Recommendation:** allocated inventory (first row) if there's a cap. When real stock arrives, set the true count; available stock already shows the net remaining after preorder sales.
- **Without a cap:** use row 2 and accept that nothing limits volume.
- **Which one is live:** unknown. It's an Admin setting on products currently hidden from Headless.

## 6. Notification templates

- **Not verified in Shopify.** Admin and the test store weren't available, so nothing was previewed, test-sent or seen on a real order. Local Liquid rendering (`liquidjs`, scratchpad only) checks syntax and logic only. It covered the snapshot, the fallback, no-preorder and blank-snapshot cases.
- **Documented by Shopify:**
  - `attributes` (order attributes)
  - `line.product.metafields.NAMESPACE.KEY`
  - `line.properties`
- **Not documented:** `line.product.tags` appears only in a Shopify Collective example. That's why the snippet now prefers the order snapshot and uses the tag only as a fallback.
- **Verification still required (owner, in Admin):**
  1. Settings > Notifications > Order confirmation > Edit code: back up the template, paste the snippet, Preview with the preview override, clear the override, Save, Send test.
  2. On an authorized test-store order: confirm the snapshot block renders. Then remove the attribute on a duplicate test order to confirm the fallback renders, which proves tags and the metafield work in that template.
  3. Repeat for Shipping confirmation.

## 7. Coming Soon is preserved

All four models are still `comingSoon: true` with preorder disabled. Even after the catalog is flipped, a model can't sell as a preorder until all of these hold:
- Shopify returns the product.
- The metafield matches the catalog estimate.
- The payment flag is confirmed.
- A variant is available.

The build fails if any prerendered page claims `InStock` or `PreOrder`.

**Recommended order:**
1. Publish to Headless.
2. Set and verify the price.
3. Set up inventory.
4. Create the metafield and its values.
5. Create the discounts.
6. Install and verify the templates on the test store.
7. Confirm payment capture.
8. Only then flip the catalog and the payment flag in a reviewed release.

Don't set any `VITE_SHOPIFY_{MI26,BL50,OR17,CM24}_HANDLE` while those products return null from Headless: product loading would fail for the whole store, trainers included.

## 8. Tests added at integration

`test/preorder-integration.test.js` (10 tests) and 2 policy/FAQ tests in `test/preorder.test.js` cover:
- mixed trainer + preorder carts with distinct customizations and wrist fit
- quantity changes
- PREORDER30 + WRECKER100 together
- stale-snapshot removal under both replace and merge behavior
- unchanged trainer checkout (no extra requests)
- a preorder that stops matching
- an uncertain snapshot write followed by recovery
- reload/restore
- an unconfirmed payment setting

The Agent 1 tests were updated for the stricter gate: metafield required, payment flag.

## Remaining Shopify Admin tasks (all need owner approval)

1. Republish MI26, BL50, OR17 and CM24 to the Headless channel. They currently return null by handle and by variant ID.
2. Set prices ($285 → $295) on all 7 variants while the gloves are still Coming Soon, then re-verify read-only.
3. Set the inventory policy per section 5, per variant.
4. Create the metafield definition `custom.preorder_ship_estimate` (single line text, **Storefront API access on**). Set the approved estimate per model and the `preorder` tag. Never tag the break-in service products.
5. Confirm the payment capture method and that no selling plan applies (section 3).
6. Create PREORDER30 and WRECKER100 as specified in `docs/preorder-commerce.md`.
7. Install the two notification snippets (back up first) and verify per section 6.
8. Restore test-store credentials (`.env.development.local`, `anawin-test.myshopify.com`), mirror the configuration there, and run the test plan in `docs/preorder-commerce.md`. That includes one authorized test order to check order attributes, the email, Admin order view and fulfillment.
