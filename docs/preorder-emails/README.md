# Preorder emails and customer communication

Status: proposal. None of these templates is installed in Shopify yet. No Shopify setting,
notification template, or email was changed or sent while preparing them. Full-size
gloves remain Coming Soon and are not published to the Headless channel. No
estimate is approved for any model yet.

## Shared contract

These must match the storefront exactly.

| Item | Value |
| --- | --- |
| Product tag | `preorder` |
| Product metafield | `custom.preorder_ship_estimate`, single line text, e.g. a value like "first week of Month YYYY" |
| Label | `Preorder` |
| Estimate line | `Estimated to ship: {estimate}` |

A product counts as a preorder only when it has **both** the tag and a non-blank
estimate. If either is missing, the storefront and the emails show nothing about
preorders for it (fail silent). No file in this directory or in `src/policy-content.js`
contains a date. Every estimate comes from the metafield.

These constants are defined once in `src/catalog.js` and re-exported from
`src/policy-content.js` (`PREORDER_TAG`, `PREORDER_ESTIMATE_METAFIELD`, `PREORDER_LABEL`,
`PREORDER_ESTIMATE_PREFIX`, `preorderEstimateLine`, `preorderPaymentNote`).

**Order snapshot (preferred source).** At checkout handoff the storefront writes the cart
attribute `Preorder estimated ship` (for example `BL50: first week of …; MI26: first week of …`)
from the same approved estimates. Shopify copies cart attributes onto the order, and
notifications expose them as `attributes` ([email variables](https://help.shopify.com/en/manual/fulfillment/setup/notifications/email-variables)).
The order confirmation snippet uses this snapshot first, because it records what the customer
saw when they paid and does not depend on `line.product.tags`, which Shopify documents only in
a Shopify Collective example. The tag + metafield loop is the fallback for orders without it.

Discount codes do not appear in any template here. Shopify's default templates
already list any applied discount in the order summary.

## Current customer communication (inspected)

- **Transactional email.** Shopify sends all order emails from Admin > Settings >
  Notifications. The storefront and the Cloudflare Worker send no email. Checkout is
  Shopify-hosted (`src/checkout-safety.js` limits redirects to the verified Shopify
  origin).
- **Newsletter (marketing).** `src/newsletter.js`, `src/newsletter-form.js`,
  `src/newsletter-popup.js` and `worker/newsletter.js` post `{ email, consent: true }` to
  `/api/newsletter`. The Worker creates a new customer with
  `SUBSCRIBED`/`SINGLE_OPT_IN` only when the checkbox is checked. It never changes an
  existing customer's consent. It sends no email. **Nothing in this preorder work
  touches that flow.** Preorder messages are order updates only. They do not read or
  write `emailMarketingConsent` and do not opt anyone in.
- **Policy pages.** Shipping, Returns, FAQ and Warranty copy is rendered in
  `src/storefront-render.js` (`shippingPolicy`, `faqGroups`), with shared text in
  `src/policy-content.js`. Before this change, no preorder copy existed anywhere in the
  repo. Support contact: support@anawinofficial.com.

## Which notifications carry preorder details

| Notification | Sent by | Preorder change | Notes |
| --- | --- | --- | --- |
| Order confirmation | Shopify, automatic at order creation | **Add** `order-confirmation-preorder.liquid` | The acknowledgment block. Reads the tag and metafield when the email renders. |
| Separate preorder acknowledgment | Not needed | **None (recommended)** | The order confirmation block already covers it. A second email would duplicate it. Shopify has no separate preorder email for regular products without selling plans. |
| Shipping confirmation | Shopify, when a fulfillment is created with "Notify customer" | **Add** `shipping-confirmation-preorder-note.liquid` | "On its way" note when the shipment contains a preorder glove. "Ships separately" note when an in-stock item ships first. |
| Shipping update, Out for delivery, Delivered | Shopify | None | Tracking only. Nothing preorder-specific is needed. |
| Order canceled, Refund | Shopify | None | Use the defaults. |
| Delay notice | **Owner, by hand** | Draft only: `preorder-delay-notice.md` | Shopify does not send this. Update the metafield first, then send. |

## Proposed flow

1. **Owner approves an estimate** for a model, enters it in that product's
   `custom.preorder_ship_estimate`, and adds the `preorder` tag. The storefront then shows
   "Preorder" and "Estimated to ship: …" (Agent 1's work).
2. **Checkout.** Shopify charges the order at checkout. This is only true when payment
   capture is set to automatic, which is Shopify's default. Without selling plans there
   is no deferred or deposit payment.
3. **Order confirmation.** Shopify sends the standard email. The preorder block lists each
   preorder glove, grouped by estimate. It says "Estimated to ship: {estimate}", explains
   that it is an estimate, and notes when Break-In Service will be completed first. In a
   mixed cart it adds a line about other items shipping separately. The $75 service line
   never gets its own notice.
4. **Delay (if any).** The owner updates the metafield, then sends the delay notice by
   hand to the affected orders.
5. **Shipment.** Fulfilling with "Notify customer" sends Shipping confirmation. It
   includes tracking plus the "Your preorder is on its way" note.
6. **After launch stock arrives**, the owner removes the tag (and can clear the
   metafield). New orders then get the standard emails only.

## How the snippets decide

`order-confirmation-preorder.liquid` loops `line_items`. A line counts as a preorder glove
only when all of these hold:

- `line.quantity > 0`
- `line.requires_shipping` is true. The Break-In Service products are
  `requiresShipping: false`, so they are skipped.
- `line.product.tags contains 'preorder'`
- `line.product.metafields.custom.preorder_ship_estimate` (or its `.value`), stripped, is
  not blank.

The snippet groups estimates in a separator-delimited string and prints one paragraph
for each distinct estimate, listing the escaped `line.title` values with that estimate.
Break-In is detected from the glove's private property `_anawin_service = break-in`.
With the service-only layout, that is the only `_anawin_*` property on the glove parent
that identifies a service (see `docs/full-size-break-in-integration.md`). The readable
instructions stay on the service line, which this block never prints.

Shopify's notification variable reference does not document a nested-line
`parent_relationship` object. The snippets therefore do not depend on one. They rely on
the shipping flag and private property above. Shopify does document that nested lines
appear in order confirmation emails.

All customer-supplied and Admin-supplied text is printed with `| escape`.

## Install guide (owner or authorized operator only)

Prerequisite: the sender email is confirmed. Shopify requires this before template
bodies can be edited.

1. Shopify Admin > **Settings > Notifications > Customer notifications** > **Order
   confirmation**.
2. Click **Edit code**. **Before changing anything, copy the entire Email body (HTML)
   and the subject into a dated backup file** outside Shopify, e.g.
   `order-confirmation-original-YYYY-MM-DD.liquid`. "Revert to" can't bring back custom
   code you haven't saved elsewhere.
3. In the Email body, find the section that contains `Order summary`. Paste the full
   contents of `order-confirmation-preorder.liquid` immediately **before** the
   `<table class="row section">` that holds that heading. The block uses the same
   `row section` / `container` structure as Shopify's default template, so it inherits
   its styles. If the template has been customized and that table isn't present, paste
   the block right after the intro paragraph.
4. **Preview.** The preview data won't include a tagged product. To see the block, type
   a sample estimate in `anawin_preorder_preview_estimate = ''`, click **Preview**, then
   **clear it back to `''` before saving**. The test suite fails if a committed copy
   contains a preview value.
5. Click **Save**. Then click **Send test email**. It goes to the staff account you are
   logged in with. It is not a customer email.
6. Repeat for **Shipping confirmation** with `shipping-confirmation-preorder-note.liquid`.
   Paste it right after the intro paragraph, above the tracking button/section. Back up
   the original first.
7. Verify with a real order only through the separately approved nonproduction
   procedure in `docs/full-size-break-in-test-order.md`. A real test order is the only way
   to confirm that `line.product.tags`, the metafield and `line.properties` render as
   expected.

**Rollback:** open the template > **Edit code**, replace the body with the backup copy,
and click **Save**. Or click **Revert to** > **Previous** (most recent saved version) or
**Default**, then **Save**. Default removes all customizations, not just this block.

## What needs what

**Shopify template changes (owner/operator, not done):** paste the two snippets as
above. No other notification needs editing.

**Shopify data changes (owner, not done):** create the product metafield definition
`custom.preorder_ship_estimate` (single line text). Make it readable by the storefront if
Agent 1's storefront reads it through the Storefront API. Add the `preorder` tag and an
approved estimate per model. Confirm that the Break-In Service products are never tagged.

**Storefront changes:**
- Done here: preorder copy in `src/policy-content.js` (`preorderShippingSection`,
  `preorderFaqItems`, gated `preorderPaymentNote`).
- Done at integration: `preorderShippingSection` renders in `shippingPolicy()` and
  `preorderFaqItems` in `faqGroups()`, escaped, only while a Shopify-confirmed preorder is
  active. The payment note is gated by `PREORDER_CHECKOUT.chargedInFullAtCheckout`. The PDP/cart
  "Preorder" and "Estimated to ship" strings belong to Agent 1.

**Owner decisions required:**
1. Approve a per-model estimate. None is approved yet, and none is hard-coded.
2. Confirm that payment capture is **automatic at checkout**. Only then publish
   `preorderPaymentNote`. Manual capture is unsuitable for preorders: Shopify Payments
   card authorizations last about 7 days, and capturing late has fees and risk.
3. Mixed carts: ship in-stock items first (current copy says they "may ship
   separately"), or hold the whole order. If you hold it, remove that sentence from the
   policy copy and the snippet.
4. Whether the delay notice offers cancellation or a refund (bracketed paragraph in the
   draft).
5. Whether Break-In Service time is included in the published estimate. The copy only
   says the service is completed before shipping.
6. Whether to use the owner sentence "...we currently expect it to ship during the
   {estimate}". That reads correctly only when every estimate is phrased like "first week
   of …". The snippet uses "Estimated to ship: {estimate}", which works for any phrasing.

## Known gaps

- Not yet confirmed on a real order: `line.product.tags` in Order confirmation (Shopify's
  reference shows it only in a Shopify Collective example), metafield access with vs
  without `.value` (the snippet handles both), `line.properties` iteration, and nested-line
  ordering.
- The confirmation reads the metafield when the email is sent. Later estimate changes
  don't update emails already sent. That is why the delay notice exists.
- Shipping confirmation "ships separately" note: it uses the order's `fulfillment_status
  == 'partial'`. If one preorder glove shipped earlier and a later in-stock shipment leaves
  another preorder glove pending, the note is generic and doesn't name which glove.
- No SMS templates were drafted.

## Sources

- [Email notification variables](https://help.shopify.com/en/manual/fulfillment/setup/notifications/email-variables):
  `line_items`, `line.product.metafields.NAMESPACE.KEY`, `line.properties`,
  `line.requires_shipping`, `line.product.tags` (Collective example),
  `fulfillment.fulfillment_line_items`, `fulfillment_line.line_item`, `fulfillment_status`.
- [Customizing notification templates](https://help.shopify.com/en/manual/fulfillment/setup/notifications/customizing-notification-template):
  Edit code, Preview, Send test email (to the logged-in account), Revert to > Previous/Default,
  sender confirmation.
- [Bundles grouped view in templates](https://help.shopify.com/en/manual/products/bundles/bundles-grouped-view-email-template-updates):
  `subtotal_line_items`, `line.groups`, `line_item_groups`. These are bundle groups, not
  nested add-on lines.
- [Nested cart lines](https://shopify.dev/docs/apps/build/product-merchandising/nested-cart-lines):
  relationships render in order confirmation emails and Admin. One nesting level. No
  documented notification Liquid object.
- [Payment authorization](https://help.shopify.com/en/manual/payments/payment-authorization)
  and [Capturing payments](https://help.shopify.com/en/manual/fulfillment/managing-orders/payments/capturing-payments):
  automatic capture is the default. Shopify Payments card authorizations last about 7 days.
