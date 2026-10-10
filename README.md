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

`npm run build` runs Vite and then `scripts/prerender.mjs`. It writes static HTML
for the 11 public routes plus `dist/404.html`; `npm test` builds first so its
HTML checks work from a clean checkout. The generated product markup uses the
approved $155 USD catalog price. Shopify continues to supply runtime prices,
availability, cart state, and checkout links. Cloudflare serves slashless URLs
from the generated `.html` files and returns the 404 page for unknown routes.

`public/_headers` adds a Content-Security-Policy-Report-Only header to static
responses, including prerendered pages and the HTML 404. It does not enforce
restrictions or configure a reporting endpoint; use browser console reports
on a production-like preview before considering enforcement. The `/*` rule
also sends the header on static assets, where it does not govern the page.
Worker-generated `/api/*` responses do not inherit `_headers`.

GitHub Actions CI runs on pull requests to `main` and pushes to `main` or
`fullstack-review`. It installs from the lockfile, tests, rebuilds, and checks
whitespace without deployment credentials. CI sets `VITE_COMMERCE_MODE=local`
for a secret-free preview build. Every build now requires an explicit commerce
mode; Shopify builds also require the public Storefront API settings and all
four product handles. The deployment build must supply those values separately
and verify real product, checkout, and Judge.me behavior. CI cannot verify the
live Shopify/Cloudflare configuration or Judge.me data without that environment.

## Commerce modes

The storefront defaults to local preview mode. Its confirmed product content lives in `src/catalog.js`, and the preview cart is stored in the browser. Checkout stays disabled in this mode.

Shopify preparation lives in `src/commerce.js`. To connect a store later:

1. Create BR16, OB16, CL16, and a separate $20 break-in-service product in Shopify. Each must expose one purchasable variant.
2. Install Shopify's Headless sales channel and create a storefront with product and cart permissions.
3. Copy `.env.example` to `.env`, enter the `*.myshopify.com` domain, **public** Storefront API token, and exact product handles.
4. Change `VITE_COMMERCE_MODE` to `shopify`, restart Vite, and test with non-production products and checkout settings.

`VITE_` values are included in the browser bundle. Only the public Storefront API token belongs there; never add an Admin API token or Shopify private token.

In Shopify mode, Shopify owns prices, availability, cart totals, and the hosted checkout URL. The UI never constructs a payable total or checkout URL from browser state.

Checkout redirects are limited to the verified Shopify origin `https://ignvv0-zh.myshopify.com`. If Shopify's checkout domain changes, verify the new `Cart.checkoutUrl` origin against Shopify Admin and a Storefront API test cart, then review `src/checkout-safety.js` before deploying. A rejected link requires the customer to check the cart again, which fetches fresh Shopify state.

## Catalog and content

Product names, specifications, and local imagery remain in the storefront so its confirmed presentation is preserved. Shopify replaces price, availability, merchandise identity, and cart totals after connection. Founder content, shipping terms, and return terms remain in storefront content.

The repository does not contain the licensed DIN Nxt 79 Cn font. The design uses condensed system fallbacks and the `--display` CSS custom property is ready to point at licensed local font files later.

## Newsletter API

The homepage form posts only `{ email, consent: true }` to the same-origin
`POST /api/newsletter`. This route runs in `worker/index.js` ahead of static
assets. All other storefront routes retain the existing prerendered HTML,
slashless URL, and custom 404 behavior. The Vite dev server does not run the
Worker; use a local Wrangler preview to exercise the API after configuring
development-only credentials.

The Worker uses Shopify Admin GraphQL `2026-07` to find a customer by exact
email, create one with email marketing consent if absent, or update consent
for an existing unsubscribed customer. Already subscribed and pending customers
retain their Shopify state. The browser only receives `SUBSCRIBED` or `PENDING`
when Shopify reports that state. Shopify Admin errors and credentials never
appear in the response. A checked checkbox records `SINGLE_OPT_IN`. The
production Wrangler config explicitly selects `single` opt-in; if ANAWIN needs
double opt-in, change this configuration before deployment. Admin API mutations
do not themselves provide a complete confirmation-email workflow. That needs a
separate verified confirmation flow before this endpoint can be used for those
customers.

Before a live test:

1. In Shopify, configure an Admin API app for this store with only
   `read_customers` and `write_customers`. Request access to protected customer
   data and the **Email** field as required for this app type and store plan.
   Install the app, then obtain its client ID and secret privately from the
   Dev Dashboard.
2. Confirm the non-secret production values in `wrangler.jsonc` match the
   Cloudflare Dashboard: `SHOPIFY_STORE_DOMAIN=ignvv0-zh.myshopify.com`,
   `SHOPIFY_ADMIN_API_VERSION=2026-07`, and `NEWSLETTER_OPT_IN_MODE=single`.
   Wrangler is the source of truth for these values. `keep_vars: true` also
   preserves any other Dashboard variables during deploy; it is not needed to
   retain the two Shopify secrets.
3. For a new Dev Dashboard app owned by the same Shopify organization as the
   store, add `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` as **Cloudflare
   Worker secrets**. The Worker exchanges them server-side for a 24-hour Admin
   access token and refreshes it when needed. If an eligible legacy custom app
   already has a non-expiring Admin token, use the alternative secret
   `SHOPIFY_ADMIN_ACCESS_TOKEN` instead. Configure exactly one of those two
   authentication paths. Never put credentials in a Vite variable, a Wrangler
   `vars` field, source, or `.env.example`. For local Wrangler testing, use an
   ignored `.dev.vars` file; never commit it.
4. Verify the two `ratelimits` namespace IDs are unused in the Cloudflare
   account. The Worker limits submissions to 30/minute per IP and 3/minute per
   normalized email, per Cloudflare location. Configure an additional
   Cloudflare WAF rule if traffic warrants it.
5. Test new, existing, subscribed, and pending customer states against the
   store before releasing. If the Shopify app lacks the protected fields,
   Shopify can redact them and the Worker will fail closed.

The static `dist/` bundle contains no Admin token or Worker code. New Dev
Dashboard apps do not display a permanent token in Shopify Admin. The client
credentials grant only works when the app and store belong to the same Shopify
organization; another distribution setup needs a different server-side OAuth
flow. Setting a secret with Wrangler can publish a new Worker version, so
coordinate secret setup with the deployment plan rather than using
`wrangler secret put` during review.

## Launch safety

Do not enable Shopify mode in production until all four handles resolve to the intended products, inventory behavior is confirmed, shipping and return policies are final, and a complete test checkout succeeds. Shopify Admin and private API credentials must never be committed or shipped to the browser.
