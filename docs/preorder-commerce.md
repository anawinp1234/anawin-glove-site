# Preorder commerce: pricing, discounts and checkout integrity

Prepared on November 18, 2026, on branch `agent/preorder-commerce` (based on `fullstack-review@754ce38`). I made no Shopify Admin changes and no production cart, checkout, discount or customer mutations. The only production access was read-only Storefront API GraphQL queries. This document contains no tokens or credentials.

## 1. Verified production state (read-only Storefront API)

Store `ignvv0-zh.myshopify.com`, Storefront API `2026-07`, public Headless token, checked November 18, 2026.

| Item | Query | Result |
| --- | --- | --- |
| MI26, BL50, OR17, CM24 | `product(handle:)` for `mi26`, `bl50`, `or17`, `cm24` | `null` for all four |
| Full-size glove variants 68055435968760, 68055436001528, 68055446323448, 68055446356216, 68055559340280, 68055559373048, 68055715184888 | `nodes(ids:)` | `null` for all seven (Right and Left) |
| Product search | `products(query: "title:MI26 OR …")` | no results |
| All products visible to Headless | `products(first: 50)`, `hasNextPage: false` | exactly `br16`, `ob16`, `cl16`, `break-in-service`, `full-size-glove-break-in-service` |
| BR16 / OB16 / CL16 | by handle | $155.00 USD, `availableForSale: true`, `currentlyNotInStock: false`, `requiresShipping: true`, no tags, no selling plans |
| Trainer Break-In Service | `break-in-service`, variant 50525848633592 | $20.00 USD, available, `requiresShipping: false`, no tags |
| Full-size glove break-in service | `full-size-glove-break-in-service`, product 15498355474680, variant 68062398808312 | $75.00 USD, available, `requiresShipping: false`, no tags, no selling plans; it also resolves by node ID |
| `custom.preorder_ship_estimate` on the service product | `metafield(namespace:"custom", key:"preorder_ship_estimate")` | `null`. It is either not set or not exposed to the Storefront API. The gloves could not be checked because they are hidden. |
| Inventory quantity | `quantityAvailable` | `ACCESS_DENIED`: the token lacks `unauthenticated_read_product_inventory` |
| Shop payments | `shop.paymentSettings` | base currency USD, country US. Presentment currencies are AUD, CAD, JPY, KRW, PHP and USD. Wallets are Shop Pay, Apple Pay and Google Pay. |
| Ship-to / localization | `shipsToCountries`, `localization.availableCountries` | AU, CA, JP, KR, MX, PH and US. MX uses USD; each other country uses its own currency. |

**Interpretation.** The four full-size products are not published to the Headless channel, or are otherwise unavailable to this token. On November 11 all seven variants returned $285.00; today they return nothing. Their current Admin price cannot be read from the Storefront API.

**What the Storefront API cannot show, so it remains unverified until someone checks Admin:**
- the current Admin price of the full-size variants (hidden today)
- inventory tracking, quantities and the "Continue selling when out of stock" policy
- sales-channel publishing, including whether the gloves are on the Online Store channel
- whether PREORDER30 or WRECKER100 exist, and their settings
- tax settings, including whether the service variants are taxable
- markets configuration and per-market price rounding
- customer records, including whether the WRECKER100 customer exists
- shipping rates, payment capture mode, and Storefront access for metafield definitions

## 2. Safest $285 → $295 change process

Facts from the code:
- Once products load, the cart and PDP use Shopify's variant price (`variant.price.amount`, `src/commerce.js` product load). The prerendered HTML and initial copy come from `price: 285` in `src/catalog.js` (owned by Agent 1).
- Full-size JSON-LD is omitted while Coming Soon is active.
- Product load takes one variant's price as the product price, so Right and Left must always match.

Order of operations. The goal is that no customer can ever buy at a price different from the one advertised.

1. **Prepare on the branch, without deploying.** Agent 1 changes `src/catalog.js` from 285 to 295. Update the tests and fixture defaults that pin $285 or $360 (`test/full-size-commerce.test.js`, `test/prerender.test.js`, `test/cart-row.test.js`, `test-support/shopify-fixture.js`) to $295 and $370. Update any $285 copy and the full-size JSON-LD offer (when it is enabled) so they come from the same source. Run tests and build.
2. **Change Shopify while the gloves are hidden and Coming Soon.** In Admin → Products, bulk-edit all seven full-size variants (MI26 R/L, BL50 R/L, OR17 R/L, CM24) to $295.00 and leave Compare-at blank. Nothing can be purchased through Headless at this point, so no customer sees a mismatch. Confirm the products are not purchasable on any other channel: Online Store, Shop app, or `/cart/<variant>:1` permalinks on the myshopify domain.
3. **Publish to Headless only, and keep the site in Coming Soon.** The deployed site still renders disabled buttons. Re-run the read-only verification in section 1 and confirm every variant returns $295.00 USD with `hasNextPage: false`.
4. **Deploy the $295 site copy** while purchase is still disabled. Check the prerendered pages, PDP totals ($295, and $370 with service) and JSON-LD.
5. **Enable preorder purchase** (Agent 1's change) only after steps 3 and 4 match. Do one approved test checkout. Then activate PREORDER30 (section 3).
6. **Rollback.** Disable purchase first, then revert the price. Never change the Shopify price while purchase is enabled and the deployed copy shows another number. If that is unavoidable, the PDP re-renders Shopify's price after load, but prerendered HTML and any marketing copy would still be wrong.

Risk to note: if the gloves are already published on another channel, step 2 exposes $295 there immediately. That is acceptable only because those channels already showed $285.

## 3. Discount configurations (proposed; to be created in Admin by the owner)

Shopify references:
- [Amount off products discounts](https://help.shopify.com/en/manual/discounts/discount-types/percentage-fixed-amount)
- [Combining discounts](https://help.shopify.com/en/manual/discounts/discount-combinations)
- [Buy X get Y](https://help.shopify.com/en/manual/discounts/discount-types/buy-x-get-y)
- [Markets: discounts](https://help.shopify.com/en/manual/markets/discounts-and-gift-cards)
- [`cartDiscountCodesUpdate`](https://shopify.dev/docs/api/storefront/latest/mutations/cartDiscountCodesUpdate)

### PREORDER30: $30 off each full-size glove

Admin → Discounts → Create discount → **Amount off products** → Method: **Discount code**.

| Setting | Value |
| --- | --- |
| Code | `PREORDER30` (codes are case-insensitive) |
| Discount value | **Fixed amount**, `30.00` |
| Applies to | **Specific products**: MI26, BL50, OR17, CM24. Selecting whole products includes all variants. Do **not** add the trainers, the Trainer Break-In Service, or the Full-size glove break-in service. |
| "Only apply discount once per order" | **Unchecked.** Unchecked, Shopify takes the fixed amount off each eligible item; checked, it is taken once per order. |
| Minimum purchase requirements | None |
| Customer eligibility | All customers (or Markets: United States only, if the owner wants USD-only preorders; see the currency risk below) |
| Maximum discount uses | Total uses: owner decision. This limit counts **orders**, not gloves, so it is not a glove cap. Limit to one per customer: owner decision; recommend off. |
| Combinations | **Product discounts: ON** (required for WRECKER100). Order discounts: OFF unless the owner wants stacking. Shipping discounts: ON if a free-shipping code may be used. |
| Active dates | Start at preorder launch and end at preorder close, in the store's Admin time zone |

Expected behavior:
- 1 glove: $295 → $265 (−$30).
- 2 gloves (one line, quantity 2): −$60, so $530.
- Glove plus service: the service stays $75. For example, 2 gloves + 2 services = $590 − $60 = $530 + $150 = $680.
- Shopify applies the discount to the subtotal before tax.

### WRECKER100: one free full-size break-in service for one customer

Recommended form: **Amount off products, fixed $75.00, once per order**. Do not use 100%: a percentage has no "once per order" option, so 100% would make every service line in the order free. Do not use Buy X get Y: on non-Plus plans, products in a Buy X get Y discount become ineligible for further product discounts, so the glove would lose PREORDER30.

| Setting | Value |
| --- | --- |
| Type / method | Amount off products / Discount code |
| Code | `WRECKER100` (not published anywhere) |
| Discount value | **Fixed amount**, `75.00`. It must equal the service price; update it if the price changes. |
| Applies to | **Specific products**: Full-size glove break-in service (product 15498355474680) **only** |
| "Only apply discount once per order" | **Checked**. Exactly $75 comes off per order whatever the service quantity, so 2 services → 1 free. |
| Minimum purchase requirements | None (the service is always attached to a glove by the storefront) |
| Customer eligibility | **Specific customers** → that one customer. Their customer record must already exist in Admin with the email they will use. |
| Maximum discount uses | **Limit number of times this discount can be used in total = 1** and **Limit to one per customer = on**. Shopify tracks the per-customer limit by email or phone. |
| Combinations | **Product discounts: ON**. Order discounts and Shipping discounts: OFF unless approved. |
| Active dates | Start now; end on a date the owner chooses (recommended) |

Customer identification:
- Shopify identifies customers at checkout by a logged-in account or the email or phone used there.
- I could not confirm, from official documentation, whether a Storefront cart without `buyerIdentity` reports the code as `applicable: false`. Community reports say eligibility is evaluated at checkout once the buyer is identified. **Test-store verification is required.**
- The storefront does not set `buyerIdentity`. The cart may therefore show "WRECKER100 not applicable" and the message "Discount code isn’t valid for this cart."
- The code stays on the cart and is forwarded to checkout (covered by tests). Even so, tell the customer to enter WRECKER100 at Shopify checkout after entering their email or logging in.

Other caveats:
- Usage counts are per order. A cancelled or refunded order may still consume the single use (unverified); recreate the code if that happens.
- **Currency risk.** Fixed amounts are converted from USD at the current exchange rate. If the customer checks out in CAD, AUD and so on, and market price rounding is on, the converted $75 may not equal the rounded service price, leaving a small balance. Confirm the customer checks out in USD, or restrict WRECKER100 to the US market.

### Combination rule (both codes in one order)

- Shopify combines discounts only when **each** discount's settings allow it. Both codes must have **Combines with → Product discounts** checked.
- Product discounts on *different* line items (glove lines and service lines) combine on all plans. On non-Plus plans, two product discounts on the *same* item do not stack; the best one applies.
- If either code lacks the setting, Shopify keeps only the better discount and checkout shows "Discount couldn't be used with your existing discounts."
- An order can carry at most 5 product or order codes, plus 1 shipping code.

Expected for 2 gloves + 2 services with both codes: gloves $590 − $60, services $150 − $75, so **$605** before shipping and tax.

## 4. Storefront code review (this branch)

- **Several codes at once are already supported.** `applyDiscountCode` sends the existing list plus the new code, de-duplicated case-insensitively; `removeDiscountCode` sends the remaining list. Shopify's `cartDiscountCodesUpdate` replaces the whole list, so this is correct. No source change was needed. Non-applicable codes stay in the list, so a customer-specific code survives later edits.
- **Per-line display.** `cartDiscountSummary` and `entryDisplayAmounts` sum `discountAllocations(lineLevelOnly: false)` per line and per code. Glove and service allocations are shown as separate code rows. Inconsistent data (allocation larger than the line, or in another currency) is shown without savings rather than guessed.
- **Checkout integrity.** `checkoutCartIsComplete` checks line structure, not prices or codes. Applying or removing codes never changes the parent/child links, quantities or service attributes. If Shopify ever returned a split service line, the cart fails closed and checkout is blocked.
- **New regression tests** (`test/preorder-discounts.test.js`, 10 tests, using the existing mocked fixture's `discountScenario` with no fixture changes):
  - The full list is sent on the second apply and on removal.
  - PREORDER30 takes $30 per glove and $0 off the service.
  - With both codes on 2+2 items, $60 and $75 discount rows appear and no "Other discounts" row is duplicated.
  - Line IDs, parents, quantities and attributes are identical before and after.
  - Removing either code keeps the other and keeps the pairing.
  - PREORDER30 does not apply to trainers; a mixed cart discounts only the full-size glove.
  - An unidentified WRECKER100 stays on the cart as not applicable.
  - Quantity changes 2→3→1 keep the pairing; still one free service.
  - Checkout navigates with both codes; a split service line blocks checkout.
  - Over-allocated or foreign-currency allocations are rejected for display.

## 5. Tax, shipping, inventory and payment

- **Tax.** Discounts reduce the pre-tax subtotal. Whether the services are taxable is unverified: the Storefront API does not expose it, so check Admin. Tax on a service sold to the same address can differ by state.
- **Shipping.** Both services have `requiresShipping: false` (verified), so only gloves add weight or shipping. If shipping rates are price-based (for example, free shipping over $X), discounts lower the qualifying subtotal. Rates are unverified.
- **Inventory and oversell.** The recommended way to cap preorders: **track inventory**, set available = the preorder allotment, and leave **"Continue selling when out of stock" OFF**. `availableForSale` then turns false when the allotment runs out, and the storefront already respects that.
  - "Continue selling" ON allows unlimited oversell (negative inventory).
  - Untracked inventory also means no cap.
  - The service product should stay untracked (it is not a physical item).
  - None of these settings are verifiable without Admin.
- **Payment.** Without a preorder app using selling plans, Shopify has no native deferred, deposit or partial-payment preorder. Customers are **charged in full at checkout**, or authorized and captured according to the store's capture setting; the authorization window is limited, so check Admin → Settings → Payments.
  - Shopify's preorder feature requires an app and Shopify Payments or PayPal Express.
  - **Disclosure requirement:** the PDP, cart and confirmation email must say the customer pays in full now and give the estimated ship date (`custom.preorder_ship_estimate`; Agents 1 and 3).
  - Refund and cancellation terms for preorders should be in the policy.
- **Metafield.** For Agent 1 to read `custom.preorder_ship_estimate` through the Storefront API, its definition needs Storefront access turned on. It currently returns `null` on the service product; the gloves are unverified because they are hidden.

## 6. Test-store test plan: BLOCKED

`.env.development.local` for `anawin-test.myshopify.com` is not on this machine, so none of the following has been run. Each needs test-store credentials and an owner-approved test checkout.

1. Create PREORDER30 and WRECKER100 in the test store with the settings in section 3. Create a test customer for WRECKER100.
2. 1 glove plus service, PREORDER30: cart and checkout show −$30 on the glove and $0 on the service.
3. 2 gloves plus 2 services, PREORDER30: −$60. Confirm the service is not discounted.
4. Add WRECKER100 as a guest, without email: record the cart `applicable` value, then enter the customer's email or log in at checkout and confirm $75 comes off once.
5. Both codes with 2+2: total $605 before shipping and tax. Confirm no combination error.
6. Turn off "Product discounts" on one code: confirm Shopify keeps one discount and shows the combination error.
7. Use WRECKER100 again with the same customer, and with another customer: both are rejected.
8. Trainer-only cart with PREORDER30: not applicable.
9. Checkout in CAD or AUD: check the converted $30 and $75 and whether a balance remains on the service.
10. Inventory: allotment 1, continue selling OFF; a second order is blocked and `availableForSale` turns false.
11. The order, notification and fulfillment show the discount per line and keep the service customization attributes.

## 7. Required approvals

- Owner approval to create PREORDER30 and WRECKER100 in production Admin with the settings above. That includes active dates, the total-use limit for PREORDER30, the market restriction, and the WRECKER100 customer identity and end date.
- Owner approval of the $295 price change and the sequence in section 2, coordinated with Agent 1's catalog and copy change and the deploy.
- Admin confirmation of inventory policy, channel publishing, tax on services, markets and rounding, payment capture, and metafield Storefront access.
- Test-store credentials and an authorized test checkout for section 6.
- Approval of the preorder payment disclosure copy (Agents 1 and 3).
