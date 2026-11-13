# Deployment Guide

How the ANAWIN storefront reaches production on Cloudflare Workers.

Last verified: 2026-11-13 (UTC), against the production deployment of `main`
commit `1797bbe`. Sources: the Cloudflare dashboard (viewed only), read-only
Wrangler commands, the repository, and Cloudflare's documentation. Items marked
**Unverified** could not be confirmed and must be checked before relying on them.

## 1. At a glance

| Item | Value |
| --- | --- |
| Cloudflare Worker | `anawin-glove-site` (single Worker serving `dist/` assets and `worker/index.js`) |
| Production domain | Route `anawinofficial.com/*` in zone `anawinofficial.com` |
| Other URLs | `anawin-glove-site.<account-subdomain>.workers.dev` (production) and preview URLs `*-anawin-glove-site.<account-subdomain>.workers.dev`; both are public |
| Git repository | `anawinp1234/anawin-glove-site`, connected through Workers Builds |
| Production branch | `main`. Every push or merge to `main` builds **and deploys to production automatically** |
| Non-production branches | Builds enabled; they upload a version but do not deploy it |
| Production Shopify store | `ignvv0-zh.myshopify.com` (also the only checkout host allowed by `src/checkout-safety.js`) |

`main` has no branch protection, and Workers Builds does not wait for GitHub
Actions. **A merge to `main` is a production release**, even if CI fails. Merge
only after CI passes and the change has been reviewed.

## 2. Triggers and what each produces

| Event | Workers Builds runs | Result |
| --- | --- | --- |
| Push/merge to `main` | `npm run build`, then `npx wrangler deploy` | New version, immediately deployed at 100% of production traffic |
| Push to any other branch (for example `fullstack-review`) | `npm run build`, then `npx wrangler versions upload` | New **version only**, reachable on its preview URL; production is unchanged |
| PR to `main`, push to `main` or `fullstack-review` | GitHub Actions `CI` (`.github/workflows/ci.yml`) | `npm ci`, `npm test`, `npm run build`, `git diff --check` in `local` mode. Validation only; it never deploys |

Cloudflare's per-branch "Worker Previews" environments are **not** set up. Build
watch paths include all files.

## 3. Build configuration (Workers Builds)

| Setting | Configured value |
| --- | --- |
| Root directory | `/` |
| Install | `npm clean-install` (run by Workers Builds; lockfile required) |
| Build command | `npm run build` → `check-build-config.mjs`, `check-source-imports.mjs`, `vite build`, `prerender.mjs` |
| Output directory | `dist/` (from `assets.directory` in `wrangler.jsonc`) |
| Deploy command (`main`) | `npx wrangler deploy` |
| Version command (other branches) | `npx wrangler versions upload` |
| Node | Detected by Workers Builds (Node 24.18.0 on the 2026-11-13 build). The repository does not pin a version; CI uses Node 24 |

`npm run build` fails unless `VITE_COMMERCE_MODE` is `local` or `shopify`. In
`shopify` mode it also requires the store domain, Storefront token, product
handles and `VITE_SHOPIFY_BREAK_IN_HANDLE`. `check-source-imports.mjs` fails if
`src/` imports an untracked file.

## 4. Where configuration lives

Values are never stored in Git. Names only:

**Build variables** (Worker → Settings → Builds → Variables and secrets). Vite
compiles the `VITE_` values into the public JavaScript bundle; they are
browser-visible by design and are not available to the Worker at runtime.

- `VITE_COMMERCE_MODE`, `VITE_SHOPIFY_STORE_DOMAIN`, `VITE_SHOPIFY_STOREFRONT_TOKEN`
  (public Storefront token), `VITE_SHOPIFY_API_VERSION`
- `VITE_SHOPIFY_BR16_HANDLE`, `VITE_SHOPIFY_OB16_HANDLE`, `VITE_SHOPIFY_CL16_HANDLE`,
  `VITE_SHOPIFY_BREAK_IN_HANDLE`
- `VITE_JUDGEME_PUBLIC_TOKEN`
- Also present but not read by the build: `SHOPIFY_STORE_DOMAIN`,
  `SHOPIFY_ADMIN_API_VERSION`, `NEWSLETTER_OPT_IN_MODE`, `SHOPIFY_CLIENT_ID`,
  `SHOPIFY_CLIENT_SECRET`. Their presence in the build environment is
  unnecessary; whether to remove them is an owner decision.
- Full-size handles (`VITE_SHOPIFY_MI26_HANDLE` and others) are not set in
  production, so full-size products are not mapped to Shopify there.

**Runtime configuration** (Worker → Settings → Variables and secrets, used by
`worker/index.js` for `/api/newsletter`):

- Variables, with `wrangler.jsonc` as the source of truth: `SHOPIFY_STORE_DOMAIN`,
  `SHOPIFY_ADMIN_API_VERSION`, `NEWSLETTER_OPT_IN_MODE`. `keep_vars: true`
  preserves other dashboard variables on deploy.
- Secrets: `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`. The Worker alternatively
  accepts `SHOPIFY_ADMIN_ACCESS_TOKEN`; configure only one path.
- Bindings: rate limiters `NEWSLETTER_IP_LIMITER` and `NEWSLETTER_EMAIL_LIMITER`.
- `wrangler secret put` publishes a new version; coordinate it like a deploy.

**Unverified:** whether the "Previews Base" runtime settings differ from
production.

## 5. Keeping production and test-store targets separate

- Cloudflare holds only production values. **Preview versions are built with
  the same build variables, so a preview URL talks to the production Shopify
  store.** Do not create carts, checkouts or newsletter signups on preview URLs.
- The development store is `anawin-test.myshopify.com`. It has no Cloudflare
  configuration. Test-store work runs from an isolated local copy outside the
  repository. That copy changes `APPROVED_CHECKOUT_HOST` to the test host, adds a
  domain guard refusing any other store, and loads test values from that
  copy's own `.env.local`. These adaptations must never be committed.
- `src/checkout-safety.js` only redirects to `https://ignvv0-zh.myshopify.com`,
  so a production build cannot send shoppers to another store's checkout.
- Never point `VITE_SHOPIFY_STORE_DOMAIN` in Cloudflare at the test store, and
  never put test credentials in Cloudflare.

## 6. Build passed, version uploaded, or deployed?

These are different states. Check each one explicitly:

| State | How to confirm |
| --- | --- |
| CI passed | GitHub `validate` check on the commit. Local-mode only; says nothing about production config |
| Build passed | GitHub check `Workers Builds: anawin-glove-site` succeeded, or the build page in Cloudflare (Worker → Deployments → build) shows all steps green |
| Version uploaded (preview) | `npx wrangler versions list --name anawin-glove-site` shows a new `version_upload` that is **not** in the deployment list |
| Active production deployment | `npx wrangler deployments status --name anawin-glove-site` shows the version at 100% |

Workers Builds versions carry no tag or message. To map a deployment to a commit:

1. Open the build from the commit's `Workers Builds` check link, or from Worker →
   Deployments. The build page shows branch, commit SHA and message.
2. Match that build's deploy time with the `Created` time of the active version
   in `npx wrangler deployments status`.

## 7. Live checks after a deploy

Read-only; never create production carts or orders.

```bash
npx wrangler deployments status --name anawin-glove-site
curl -sSI https://anawinofficial.com/ | head -1
curl -sS https://anawinofficial.com/shop | grep -oE '/assets/index-[A-Za-z0-9_-]+\.(js|css)'
# Then fetch the listed bundle and grep for a string unique to the change.
```

Then, in a browser, load home, `/shop` and a product page on desktop and a
mobile width. Confirm prices and service availability come from Shopify, and
check that the console shows no errors. Production sends `X-Frame-Options: DENY`,
so mobile checks need device emulation or a real phone, not an iframe. Behaviour
that needs a cart, such as the cart break-in form, must be verified on the test
store before merging.

## 8. Rollback

The procedure follows Cloudflare's documentation. **It has not been rehearsed on
this Worker.**

1. Find the last known-good version: Worker → Deployments, or
   `npx wrangler versions list --name anawin-glove-site`. Map it to a commit
   as described in section 6.
2. Roll back with either:
   - Dashboard: Worker → Deployments → the version's ⋯ menu → **Rollback**.
   - CLI: `npx wrangler rollback <VERSION_ID> --name anawin-glove-site --message "<reason>"`.
     Without a version ID it targets the version uploaded before the latest one.
     **Because non-`main` branches upload versions, that can be an undeployed
     preview build. Always pass an explicit ID.**
3. Confirm with `npx wrangler deployments status` and the live checks above.
4. **Make it stick on `main`.** The next push to `main` deploys again and replaces
   the rollback. Revert the faulty change on `main` through a reviewed PR.

Limitations:

- Only the 100 most recent versions are eligible.
- Each version carries its own static assets and compiled `VITE_` configuration,
  so a rollback restores that version's files and public Shopify settings.
- During propagation, pages loaded before the rollback may request assets from
  the newer version (version skew), and a missing asset may 404.
- Connected resources are not rolled back. **Unverified:** whether runtime
  variables and secrets revert with the version; check Settings after a rollback.
- Shopify data (products, carts, orders, customers) is never rolled back.

## 9. Local preview and its limits

```bash
VITE_COMMERCE_MODE=local npm run dev            # Vite dev server, local catalog
VITE_COMMERCE_MODE=local npm test               # builds, then runs node --test
VITE_COMMERCE_MODE=local npm run build && npm run preview   # serves dist/
```

- Local mode uses the bundled catalog and a browser-only cart. Checkout is
  disabled, and the cart break-in form, Shopify pricing and line pairing,
  checkout and recovery paths are not exercised.
- Shopify behaviour is covered by mocked tests (`test-support/shopify-fixture.js`)
  and must be verified against `anawin-test.myshopify.com` from an isolated copy
  (section 5) before merging.
- Neither the Vite dev server nor `vite preview` runs the Worker or applies
  `public/_headers`. To exercise `/api/newsletter`, use `npx wrangler dev` with
  development-only credentials in an ignored `.dev.vars` file. Never use
  production secrets locally.
- Do not create a local `.env` that targets the production store for testing.

## 10. Release checklist

- [ ] PR to `main` reviewed; GitHub `validate` passed.
- [ ] Shopify-dependent changes verified on `anawin-test.myshopify.com` (no payment).
- [ ] Merge, then confirm the `main` Workers Build succeeded and
      `deployments status` shows the new version at 100%.
- [ ] Map the version to the merge commit (section 6) and run the live checks (section 7).
- [ ] Note the previous version ID as the rollback target.
