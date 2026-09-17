# ANAWIN Storefront

Premium, mobile-first storefront prototype for ANAWIN baseball gloves.

## Local development

```bash
npm install
npm run dev
```

Production check:

```bash
npm test
npm run build
```

## Commerce modes

The storefront defaults to local preview mode. Its confirmed product content lives in `src/catalog.js`, and the preview cart is stored in the browser. Checkout stays disabled in this mode.

Shopify preparation lives in `src/commerce.js`. To connect a store later:

1. Create BR16, OB16, CL16, and a separate $20 break-in-service product in Shopify. Each must expose one purchasable variant.
2. Install Shopify's Headless sales channel and create a storefront with product and cart permissions.
3. Copy `.env.example` to `.env`, enter the `*.myshopify.com` domain, **public** Storefront API token, and exact product handles.
4. Change `VITE_COMMERCE_MODE` to `shopify`, restart Vite, and test with non-production products and checkout settings.

`VITE_` values are included in the browser bundle. Only the public Storefront API token belongs there; never add an Admin API token or Shopify private token.

In Shopify mode, Shopify owns prices, availability, cart totals, and the hosted checkout URL. The UI never constructs a payable total or checkout URL from browser state.

## Catalog and content

Product names, specifications, and local imagery remain in the storefront so its confirmed presentation is preserved. Shopify replaces price, availability, merchandise identity, and cart totals after connection. Founder content, shipping terms, and return terms still need to be supplied by ANAWIN.

The repository does not contain the licensed DIN Nxt 79 Cn font. The design uses condensed system fallbacks and the `--display` CSS custom property is ready to point at licensed local font files later.

## Launch safety

Do not enable Shopify mode in production until all four handles resolve to the intended products, inventory behavior is confirmed, shipping and return policies are final, and a complete test checkout succeeds. Shopify Admin and private API credentials must never be committed or shipped to the browser.
