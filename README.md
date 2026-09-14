# Glove Co deployment review

Review date: 2026-09-13

Status: **NO-GO — do not accept real customers yet.**

## Repository evidence

Commit `19345c0` contains one file, the root `README.md`, with the text
`inital commit`. The `main`, `deployment-review`, `fullstack-review`, and
`security-review` branches all point to that same commit. No Git remote is
configured.

The repository contains none of the artifacts required to identify or deploy
an application:

- no application source code or static site output;
- no `package.json`, lockfile, runtime declaration, or build/start scripts;
- no database schema, migration configuration, or provider configuration;
- no payment, email, storage, authentication, analytics, or error-monitoring integration;
- no environment-variable template;
- no CI workflow or hosting configuration;
- no domain, robots, sitemap, favicon, or metadata configuration.

Consequently, the framework, framework version, Node/runtime version, package
manager, build command, start command, database provider, payment provider,
email provider, storage provider, and production domain are all **not
determinable from this repository**. A clean install, test, build, or deployment
cannot be run because there is no application or package manifest.

## Intended production architecture (pending application inspection)

The default candidate for a conventional Next.js application is:

```text
feature branch -> GitHub -> Vercel preview deployment
                            |
                         review/test
                            |
main branch ----> GitHub -> Vercel production -> custom domain
                                      |
                 managed database / Stripe / email / durable storage
```

This is not yet an architecture decision. It must be confirmed after the real
application and its runtime requirements are present. No AWS, Kubernetes,
Docker, Terraform, load balancer, or microservice infrastructure is justified
by the available repository.

## Required environment separation

No variable names can be truthfully enumerated until the application is
available. Do not create guessed names because that would produce an inaccurate
deployment contract. Once identified, commit a `.env.example` containing names
and non-secret placeholders only, and configure actual values outside Git.

- Local: developer/test credentials and local URLs in an untracked `.env.local`.
- Preview: isolated test-mode Stripe credentials and webhook, non-production
  email behavior, and preferably an isolated preview database or branch. A
  preview must never run destructive migrations against production.
- Production: live production database, Stripe live-mode keys and webhook
  signing secret, verified email sender, durable storage, canonical public URL,
  and production-only monitoring credentials.

Public/browser variables must be explicitly distinguished from server-only
secrets. Stripe secret keys, webhook secrets, database credentials, email API
keys, authentication secrets, and monitoring auth tokens must never use a
client-exposed prefix.

## CI/CD policy to implement

Use protected `main` as the sole intentional production branch. Feature
branches should open pull requests and receive preview deployments. Required
checks should use the repository's actual package manager and run, where the
scripts exist: frozen/clean install, lint, typecheck, focused tests, and a
production build. Merge to `main` only after preview review and required checks
pass. Vercel should deploy previews from non-production branches and production
only from `main`.

Do not add a guessed CI workflow before the package manager and scripts are
known. Do not automatically run destructive or irreversible database migrations
from preview builds or every application deployment.

## Database operations and backups

After the provider is known:

1. Give local, preview, and production separate credentials and data boundaries.
2. Use pooled/serverless-compatible connections if the selected host requires them.
3. Review generated migration SQL, take/verify a backup, and run production
   migrations as an explicit release step.
4. Prefer backward-compatible expand/migrate/contract schema changes so old and
   new application versions can overlap safely.
5. Enable provider-managed point-in-time recovery or daily encrypted backups;
   document retention, ownership, and restoration steps.
6. Perform and record a restore drill before launch and periodically thereafter.

Back up orders, products, customers/fulfillment data, and any uploaded images
that are not already in versioned durable object storage. Provider backup claims
are not considered verified until the provider and plan are known.

## Stripe operations

Preview/local environments must use Stripe test-mode keys; production must use
live-mode keys. They must have separate endpoint signing secrets. After a domain
is selected, create a production webhook endpoint at the exact route implemented
by the application, for example `https://<canonical-domain>/<implemented-webhook-route>`.
Do not assume `/api/webhooks/stripe` until the code confirms it.

Select only events handled by the application, verify webhook signatures, and
monitor failed deliveries in Stripe. The endpoint must be tested on the deployed
HTTPS URL first in test mode. No real purchase is authorized during this review.

## Email and DNS

After the email provider and domain are known, verify the sender domain, set a
production `From` address on that domain, configure provider-required SPF and
DKIM records, publish DMARC initially with an appropriate monitoring policy,
and test bounce/delivery-failure handling. Exact records must come from the
chosen email provider; they cannot be safely invented.

## Custom domain procedure

1. Decide whether the apex or `www` name is canonical.
2. Add both names to the chosen hosting project.
3. Copy the exact DNS records displayed by the host into the authoritative DNS provider.
4. Configure the non-canonical name to issue a permanent redirect to the canonical HTTPS URL.
5. Wait for DNS and TLS validation, then verify both hostnames, redirect behavior,
   certificate renewal, and absence of mixed content.
6. Set the application's public/base URL and canonical metadata to the canonical origin.

The actual record types/targets and hostname remain pending because neither the
host nor domain is represented in the repository. Do not invent an apex A record
or `www` CNAME target; use the values supplied by the selected host.

## Monitoring and recovery

Use one lightweight error tracker (retain an existing one if discovered;
otherwise Sentry is a reasonable candidate), hosting function/build logs,
Stripe webhook delivery alerts, and one basic HTTPS uptime check for the
canonical homepage plus a meaningful health endpoint if implemented. Alerts
must reach an owned, monitored channel and avoid customer/payment secrets.

Application rollback should promote/redeploy the last known-good immutable
hosting deployment, then smoke-test the canonical domain and review logs. A code
rollback does not reverse a database migration. For a bad schema release, use a
pre-reviewed forward fix or the documented provider restore procedure; restoring
production can discard newer orders, so assess and preserve post-backup data first.

## Launch checklist

- [ ] Real application source and complete Git history are available.
- [ ] GitHub remote is configured and `main` protection/review rules are enabled.
- [ ] Framework, runtime, package manager, providers, and commands are identified.
- [ ] Clean frozen install, lint, typecheck, tests, and production build pass.
- [ ] `.env.example` documents all names using placeholders only.
- [ ] Local, preview, and production secrets/data are isolated.
- [ ] Preview deploy succeeds; only `main` maps to production.
- [ ] Database migrations, pooling, backups, retention, and restore drill are verified.
- [ ] Stripe test/live keys and webhook endpoints are separated.
- [ ] Production webhook receives a signed Stripe test event and creates one order exactly once.
- [ ] Sender domain, production sender, SPF, DKIM, DMARC, and delivery failures are verified.
- [ ] Durable image/object storage and its recovery/versioning policy are verified.
- [ ] Error tracking, logs, webhook alerts, and uptime alerts reach an owner.
- [ ] Homepage, shop, product pages, images, cart, and checkout start work.
- [ ] Stripe test transaction succeeds; webhook, order, inventory, email, and admin view agree.
- [ ] Mobile layout and the 404 page work.
- [ ] Custom domain, HTTPS, canonical redirect, and no mixed-content warnings are verified.
- [ ] `robots.txt`, sitemap, favicon, metadata, canonical URL, and social preview are verified.
- [ ] No obvious server errors appear in browser, application, or hosting logs.
- [ ] Last known-good deployment rollback is rehearsed.
- [ ] Immediately before launch, the owner completes one controlled real production
  purchase with their own payment method and refunds it, verifying the real payment,
  exact amount, order, inventory adjustment, email, shipping details, Stripe record,
  admin visibility, and refund workflow.

## Launch blockers

1. The deployable application is absent.
2. No remote/source-delivery path exists.
3. No build/runtime contract or environment-variable contract exists.
4. Hosting, database, Stripe, email, storage, monitoring, domain, DNS, backup, and
   rollback configuration cannot be verified.
5. No production or launch test can be performed.
