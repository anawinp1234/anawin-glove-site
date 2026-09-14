# Production Deployment Guide

Review date: 2026-09-13  
Reviewed commit: `19345c0` (`main`)  
Final verdict: **NOT READY**

Do not deploy this repository. The reviewed branch contains only a placeholder
`README.md`; the deployable e-commerce application is absent.

## 1. Current production-readiness status

Production readiness cannot be established because there is no application to
install, build, test, or inspect.

| Item | Finding |
| --- | --- |
| Framework | Not determinable; no application source or manifest |
| Node/runtime version | Not declared; the review machine has Node `v25.9.0`, which is not an application requirement |
| Package manager | Not determinable; no lockfile or `packageManager` field |
| Build system/scripts | Absent; no `package.json` |
| Hosting requirements | Not determinable; Vercel suitability cannot be verified |
| Database | No schema, migrations, client, or provider configuration |
| Authentication | No provider or implementation present |
| Payments | No provider, checkout code, or webhook handler present |
| Images/storage | No assets, upload code, or durable-storage configuration |
| Email | No provider or email implementation present |
| Third-party APIs | None discoverable |
| Environment variables | No code or example file from which to derive exact names |
| Production dependencies | Not determinable; no dependency manifest |

Repository checks found no `package.json`, lockfile, `.env` file,
`.env.example`, `vercel.json`, application code, API route, database migration,
CI configuration, robots file, or sitemap. `npm ci` and a production build
could not be run because `package.json` is absent. The repository also has no
Git remote, so Vercel cannot import it from a source host as reviewed.

The following therefore remain unverified: clean installation, runtime
compatibility, serverless compatibility, API/CORS behavior, redirects,
security headers, caching, rate limiting, logging, error pages, production
URLs, HTTPS behavior, cron jobs, webhook idempotency, and persistent-storage
assumptions.

## 2. Required accounts/services

No accounts can be selected from repository evidence. After the actual
application is restored, identify and record the owners and environments for:

- source hosting (for example, GitHub) and Vercel;
- the database and its backup/restore service;
- authentication, payment, transactional email, and durable object storage;
- error monitoring, analytics, and uptime monitoring;
- the domain registrar and authoritative DNS provider.

Do not create or pay for any service until the architecture and data-flow
review is complete. Vercel is only a candidate, not yet a validated choice.

## 3. Required environment variables

**Unknown until the application source is available.** No variable names should
be invented. Derive the definitive list by searching all server code, client
code, build configuration, ORM configuration, and CI workflows. Then commit a
`.env.example` containing variable names and safe placeholders only.

Create separate Local, Preview, and Production values. Preview must use test
payment credentials and isolated non-production data. Record for each variable
its consumers, required environments, validation rule, and rotation owner.

## 4. Secret environment variables

The exact names are unknown. Treat database credentials, authentication
secrets, payment secret keys and webhook signing secrets, email API keys,
storage credentials, monitoring auth tokens, and private third-party API keys
as secrets. Obtain each from the selected provider's dashboard or secret
generator and store it in Vercel environment settings, never in Git.

Only intentionally browser-safe configuration may use the framework's public
prefix (for example, `NEXT_PUBLIC_` in Next.js). A secret must never have a
public prefix. Public identifiers must still be documented and scoped.

## 5. Exact Vercel setup steps

These steps may be followed only after the application and its deployment
contract are present:

1. Push the reviewed repository to an owned source-control organization.
2. In Vercel, select **Add New > Project**, import that repository, and set
   `main` as the production branch.
3. Let Vercel detect the framework only if detection matches the manifest.
   Otherwise set the verified framework preset, root directory, install
   command, build command, output directory, and Node version explicitly.
4. Add every documented variable separately to Local/Development, Preview, or
   Production. Use test credentials and isolated data for Preview.
5. Keep automatic production deployment disabled or avoid merging to `main`
   until all checks in this guide pass. Generate a Preview deployment first.
6. Verify function runtime/region, duration, memory, body-size, and filesystem
   constraints against every API route and background operation.
7. Require pull-request review plus clean install, lint, typecheck, tests, and
   production-build checks before merging to `main`.

Do not add a guessed `vercel.json`; incorrect routing or runtime settings can
hide architecture problems. Add it only for requirements not represented in
the framework or Vercel project settings.

## 6. Database production setup

The provider and exact commands are unknown. Once identified:

1. Provision logically separate development, preview, and production data.
2. Use a TLS connection and a serverless-compatible pooled endpoint where
   required; keep any direct migration URL server-only.
3. Review generated migration SQL. Take and verify a restorable backup before
   the production migration, then run migrations as an explicit release step.
4. Use backward-compatible expand/migrate/contract changes so a rollback can
   run against the migrated schema.
5. Enable provider-managed encrypted backups or point-in-time recovery, define
   retention and owners, and complete a restore drill before launch.

Never run preview migrations against production. A code rollback does not undo
a database migration.

## 7. Payment provider setup

No payment provider is present. If the restored application uses Stripe, obtain
test and live publishable/secret keys from the Stripe Dashboard, keep modes and
accounts separated, and enable only the payment methods and currencies the
application handles. Never place a secret key in client code. Validate amounts,
currency, inventory, and authenticated customer/order identity on the server;
do not trust browser-supplied totals.

No purchase—test or live—is authorized by this review.

## 8. Webhook setup

The webhook route and event list are unknown. After code inspection:

1. Create separate provider endpoints for Preview/test and Production/live.
2. Use the exact implemented HTTPS URL and subscribe only to handled events.
3. Obtain each endpoint's signing secret from its provider dashboard and store
   it as a server-only environment variable using the exact name expected by
   the code.
4. Verify the signature over the raw request body, reject invalid requests,
   return quickly, and move slow work to a durable queue if necessary.
5. Make handling idempotent using the provider event ID; protect against
   retries, reordering, and duplicate order/inventory/email effects.
6. Exercise signed test events and monitor failed/retried deliveries.

## 9. Domain/DNS setup

DNS changes are explicitly out of scope until human approval. After a domain is
chosen, decide whether apex or `www` is canonical, add both to the Vercel
project, and copy the exact records Vercel displays into the authoritative DNS
provider. Do not use guessed record targets. Redirect the non-canonical name to
the canonical HTTPS origin and update the application's base URL, canonical
metadata, authentication callbacks, CORS allowlist, and webhook URLs.

Wait for Vercel's certificate validation, then verify TLS renewal, HTTP-to-HTTPS
and hostname redirects, no mixed content, and any email-provider SPF/DKIM/DMARC
records. DNS must be changed only by an authorized human.

## 10. Pre-deployment checklist

- [ ] Restore the complete application source and history to the intended branch.
- [ ] Configure an owned Git remote and branch protection.
- [ ] Identify framework, package manager, supported runtime, providers, and owners.
- [ ] Commit one authoritative lockfile and a runtime/package-manager declaration.
- [ ] Pass a frozen clean install, lint, typecheck, tests, and production build.
- [ ] Document exact variables in `.env.example` without values or secrets.
- [ ] Confirm no secret exists in Git history, client bundles, logs, or error payloads.
- [ ] Validate Vercel/serverless runtime, timeout, filesystem, and connection limits.
- [ ] Verify database migrations, pooling, backups, retention, and a restore drill.
- [ ] Verify webhook signatures, idempotency, retry behavior, and alerting.
- [ ] Add rate limits to authentication, checkout, contact, upload, and other abuse-sensitive routes.
- [ ] Validate strict production CORS, secure cookies, CSRF protections, and authorization.
- [ ] Configure security headers, caching rules, redirects, and custom 404/500 handling.
- [ ] Verify `robots.txt`, sitemap, canonical URLs, metadata, and social previews.
- [ ] Ensure uploads use durable object storage, not a serverless local filesystem.
- [ ] Ensure cron/background work is durable, authenticated, observable, and safe to retry.
- [ ] Configure privacy-appropriate analytics, error monitoring, logs, and uptime alerts.
- [ ] Pass a Vercel Preview review using test services and non-production data.
- [ ] Rehearse deployment rollback and the separate database recovery process.
- [ ] Obtain explicit human approval for production deployment.

## 11. Exact deployment procedure

The application-specific commands cannot be specified until its manifest and
lockfile exist. Once all preceding blockers are closed:

1. Freeze the release commit and record its SHA.
2. Run the documented frozen install, lint, typecheck, test, and build commands
   from a clean checkout using the declared production Node/runtime version.
3. Review dependency/security findings and database migration SQL.
4. Back up production and verify backup status; run the approved migration step
   if the release requires one.
5. Deploy that exact SHA to Vercel Preview and complete the smoke tests below
   with test-mode integrations.
6. After explicit human approval, promote that immutable deployment or merge
   the approved SHA to the configured production branch.
7. Run production smoke tests that do not create a real purchase. Monitor
   application, provider, and webhook logs during the release window.

This guide is preparation only and does not authorize step 6.

## 12. Post-deployment smoke tests

- Canonical HTTPS URL loads and alternate HTTP/hostnames redirect correctly.
- Home, catalog, product, cart, account, and legal pages render on mobile and desktop.
- Static assets and responsive images load without mixed content or 404s.
- Custom 404 and safe 500 responses render without leaking stack traces.
- Authentication sign-up/sign-in/sign-out/reset/callback flows work as applicable.
- Test-mode checkout initiation uses the server-calculated price; cancel/return paths work.
- A signed provider test webhook is processed once and duplicate delivery has no duplicate effect.
- Database reads/writes use production safely; connections do not spike or exhaust.
- Transactional email test reaches an owned mailbox without exposing secrets or customer data in logs.
- Security headers, cookies, CORS, caching, robots, sitemap, and canonical metadata are correct.
- Rate limits return the intended response and do not lock out normal traffic.
- Error-monitoring and uptime test alerts reach the designated owner.

Do not make a real purchase during these smoke tests.

## 13. Monitoring/logging recommendations

Use Vercel build/function logs plus one application error tracker and one
external HTTPS uptime monitor. Alert on elevated 5xx/latency, authentication
failures, database saturation, webhook delivery failures, payment/order state
mismatches, email failures, and cron failures. Add structured request/correlation
IDs and release SHAs. Never log credentials, authorization headers, cookies,
payment details, webhook bodies containing customer data, or unnecessary PII.
Define retention, access control, alert owners, and a tested escalation path.

Analytics must honor the applicable consent/privacy requirements and exclude
checkout, account, and sensitive form data by default.

## 14. Rollback procedure

1. Stop further production promotion and identify the last known-good Vercel deployment.
2. If schemas remain compatible, use Vercel to promote/redeploy that immutable deployment.
3. Repeat the production smoke tests and watch logs, webhooks, orders, and error rates.
4. Communicate impact and preserve evidence for incident review.

Do not blindly reverse migrations. Use a reviewed forward fix for compatible
schema faults. If restoration is unavoidable, follow the database provider's
tested restore runbook and reconcile data created since the restore point—most
critically orders, inventory, customers, and fulfillment state.

## 15. Known blockers

1. The deployable application source is absent from `main`.
2. No dependency manifest, lockfile, scripts, or runtime contract exists.
3. No clean install, build, test, or serverless-compatibility check can run.
4. No exact environment-variable or secret contract can be derived.
5. Database, authentication, payment, webhook, email, storage, and API behavior are unknown.
6. Security headers, caching, rate limiting, CORS, errors, SEO files, and production URLs are absent/unverifiable.
7. There is no Git remote/source-delivery path.
8. Vercel suitability and configuration cannot be validated.

## 16. Final verdict

**NOT READY**

The repository must not be deployed. Restore or provide the actual application
on the intended branch, then repeat the full production-readiness review. A
human must explicitly approve the final production deployment after every
blocker and checklist item is resolved.
