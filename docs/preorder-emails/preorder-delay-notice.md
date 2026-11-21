# Preorder delay notice — DRAFT, not sent

Status: draft for owner review. Shopify does not send this automatically. Nothing in
this repository sends it. Send only after the owner approves the new estimate and the
wording, and only to customers whose orders contain the affected preorder product.

This is a transactional order update. Send it only about an existing order, from the
support mailbox. Do not add recipients to a marketing list, do not use Shopify Email
marketing campaigns, and do not include promotions or discount codes.

## Before sending

1. Update the product metafield `custom.preorder_ship_estimate` to the new approved
   estimate first. The product page, cart, and any later Shopify notifications read
   that same value, so the site and this message stay consistent.
2. Copy `{{ previous_estimate }}` from the order confirmation the customer received, or
   from your own record of the old metafield value. Shopify does not keep a history of
   metafield values in notifications.
3. Copy `{{ new_estimate }}` exactly from the updated metafield. Do not type a
   different phrasing in the email.
4. Find the affected orders in Shopify Admin > Orders. Filter or search by the
   product, and exclude orders that are cancelled, refunded, or already fulfilled.
5. Send one message per order (or per customer), so no customer sees another
   customer's address. Do not put customers in To or CC together.

## Subject

Update on your ANAWIN preorder {{ order_name }}

## Body

Hi {{ customer_first_name }},

Thank you for your ANAWIN preorder ({{ order_name }}). We're writing with an update on
your {{ product_title }}.

Your glove is still reserved. Our earlier estimate was {{ previous_estimate }}. We now
expect it to ship {{ new_estimate }}.

Estimated to ship: {{ new_estimate }}

[Optional, include only if the reason is approved for sharing: {{ short_reason }}.]

[Include only if the order has Break-In Service: Your Break-In Service will be
completed before your glove ships.]

[Include only if the order had in-stock items that already shipped: The other items
in your order have already shipped. This update applies only to your preorder glove.]

[Owner decision required before including: If you would prefer not to wait, reply to
this email and we'll help with your options for this order.]

We'll email you tracking information once your glove ships. If you have any
questions, reply to this email or contact support@anawinofficial.com.

Thank you for your patience,
The ANAWIN team

## Wording rules

- Use the estimate exactly as it appears in `custom.preorder_ship_estimate`.
- Use "Preorder" and "Estimated to ship: {estimate}", matching the site.
- Do not promise a delivery date. Do not use "guaranteed" or language that pushes the
  customer to act quickly.
- Do not mention discount codes.
- If the estimate changes again, send a new notice. Do not edit a notice after
  sending it.

# Optional "shipped from preorder" note

The shipping confirmation snippet (`shipping-confirmation-preorder-note.liquid`) adds
this note automatically. Use the text below only to answer a customer by hand, for
example when they ask about a shipment.

> Your ANAWIN preorder ({{ order_name }}) is on its way. Thank you for your patience
> while we prepared your glove. Your tracking information is in your shipping
> confirmation email.
