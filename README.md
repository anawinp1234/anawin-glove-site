# ANAWIN Storefront

Premium, mobile-first storefront prototype for ANAWIN baseball gloves.

## Local development

```bash
npm install
npm run dev
```

Production check:

```bash
npm run build
```

## Catalog and content

The catalog lives in `src/main.js`. Product names and color labels are explicitly temporary; confirmed specifications, inventory, founder content, shipping terms, and return terms still need to be supplied by ANAWIN.

The repository does not contain the licensed DIN Nxt 79 Cn font. The design uses condensed system fallbacks and the `--display` CSS custom property is ready to point at licensed local font files later.

## Commerce safety

The cart is a storefront preview persisted in local storage. Checkout is intentionally disabled. Before accepting payments, connect a server-side commerce system that owns prices and inventory, atomically reserves stock, creates durable orders, and handles signed/idempotent payment webhooks. Never trust browser cart state for price, inventory, or fulfillment.
