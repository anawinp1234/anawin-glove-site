# Teaser readiness review

Branch/worktree confirmed: `claude-full-size`, HEAD `481664e`, `/Users/anawinp/Projects/anawin-agents/full-size-launch`. The worktree was already dirty. All 95 captured existing file hashes and 12 existing trainer-source deletions were preserved, including the uncommitted orange ICC script, regression tests and image outputs. This review adds only local-review artifacts.

| Check | Result |
| --- | --- |
| Real anawin-test signup | UNVERIFIED — skipped before any real submission |
| Real Shopify marketing consent | UNVERIFIED — no live record created or inspected |
| Teaser build readiness | UNVERIFIED overall — technical build/UI checks PASS; live signup/consent gate remains blocked |

## Live-test blockers

The checked-in Worker configuration targets `ignvv0-zh.myshopify.com`, not a verified anawin-test runtime. The current worktree and main checkout contain only `.env.example`, with no local `.env`/`.dev.vars` test configuration. The session exposes no Shopify/newsletter/test-email environment variables. There is no authorized real test email in this conversation. Consequently neither a live test-store target nor mock mode OFF could be confirmed. No real submission or Shopify request was made; production Shopify was never used. Test-store Admin credentials/runtime configuration and an explicitly authorized test address are needed to complete the real test.

The QA server deliberately used mock mode ON and a closed simulated upstream named `anawin-test.myshopify.com`. That domain string is a fixture, not proof of a live store. Every outgoing request was intercepted, and any unexpected host/operation was rejected. All duplicate/error/existing-consent tests remained simulated.

## Request trace

`src/storefront-render.js` renders the same labelled newsletter form on each teaser. `src/main.js` binds `.pdp-notify` forms through `bindNewsletterForm`. `src/newsletter.js` validates email and affirmative consent and POSTs `{email, consent:true}` to the same-origin `/api/newsletter`. `worker/index.js` routes that request to `worker/newsletter.js`, which checks origin, JSON/body limits, address, consent, environment/authentication configuration, and both rate limiters.

The Worker obtains an Admin token through client credentials or a configured static Admin token, queries customers by exact email, and creates a new customer only when absent. New customers receive `marketingState: SUBSCRIBED`, `marketingOptInLevel: SINGLE_OPT_IN`, and a consent timestamp. Existing customers keep every consent state, including UNSUBSCRIBED. The public response is only `{status: accepted}`. The UI displays THANK YOU FOR JOINING and Existing email preferences are preserved. Therefore success alone does not prove the customer is subscribed; a separate Shopify read is essential for the real test. No automatic launch-email delivery is exercised by this handler.

## Technical results — PASS

- `VITE_COMMERCE_MODE=local npm test`: **346 passed, 0 failed**. Includes Worker consent/authentication/rate-limit/error/duplicate/existing-consent regressions and the orange ICC checks.
- `VITE_COMMERCE_MODE=local npm run build`: PASS, Vite build plus **16 prerendered routes and 404.html**. This uses production-mode bundling with local commerce; no live production commerce environment was loaded or tested.
- `git diff --check`: PASS.
- Sitemap: all four `/full-size/{mint,black,camel,orange}` routes present among 16 entries. All four built documents contain teaser/signup content, with no Add to Cart, break-in, sticky-purchase controls or Product/Offer markup.
- All local-review paths, scripts and comparison files, including the orange comparison page, are excluded from dist filenames and HTML/JS/CSS/JSON/XML references. Corrected orange public assets and dist copies are byte-identical.
- Four teaser pages and three trainers at **375 and 1440 CSS px**, DPR 2: **14 product/viewport cases passed**, measured CLS 0, no horizontal page overflow, all gallery images decoded, keyboard/lightbox navigation, mobile pagination and focus return worked. Each trainer adds to the local cart.
- **8 simulated teaser signup cases** traversed browser -> actual built client -> actual Worker entry/handler -> simulated Admin GraphQL. Validation stopped invalid/missing-consent requests; service errors and 429 were announced; duplicate submit attempts produced one request and one simulated creation; success focused the H3 and used a polite live status. New simulated records had SUBSCRIBED/SINGLE_OPT_IN/timestamp. Existing unsubscribed cases made zero simulated mutations and retained UNSUBSCRIBED. These results are not real Shopify consent verification.
- **24 visible-focus checks** passed across email, submit and consent controls on all four forms at mobile and desktop widths, after client rendering/scrolling settled. Tab/Shift-Tab, Enter and Space worked. Controls had visible 2px solid focus outlines within the viewport. Email/consent labels, aria-describedby, aria-invalid, alert validation messages, and live success messages were checked. Screenshots and evidence are under ignored evidence/.

## Remaining launch issue

The orange palm source is **422 × 355**, retained without upscaling. Its output is a padded 422 × 422 canvas and the gallery/zoom reference stays capped at 422. Replace it with an approved higher-resolution original before the sales launch.

No production code/configuration was changed by this review. No commits, pushes, PRs, merge, deployment or real Shopify writes occurred.
