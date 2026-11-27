# Cart concurrency and transaction integrity (Phase 6, Task 2H)

Browser-side coordination for Shopify Storefront cart writes, recovery and checkout, in `src/commerce.js`.
No Worker cart session, Shopify setting, API version (`2026-07`), domain or Cloudflare configuration is
involved. Task 2H replaces the overlapping settlement paths of Tasks 2B–2G with one mutation dispatcher, one
exact-value journal and one authoritative raw-cart reader.

## Scope and bounds

- **One browser profile.** Every participating tab takes the exclusive Web Lock `anawin-shopify-cart-recovery`.
  Public writes queue for at most 90 s (`lock-timeout`); checkout and recovery use `ifAvailable` and refuse
  rather than queue. Without Web Locks, or with unreadable storage, nothing is written (`lock-unavailable`,
  `storage-unavailable`).
- **Not covered:** another device, profile or storage partition; nonparticipants racing between two synchronous
  storage calls (localStorage has no compare-and-swap); total storage erasure; remote changes after the last
  verified read. Client-side recovery gives no remote rollback, no global Shopify snapshot and no exactly-once
  delivery. Shopify's documented contracts for these mutations give no rollback or exactly-once guarantee.

## Shopify contract (Storefront API 2026-07)

Checked against shopify.dev for 2026-07: `Cart.discountApplications` is `[BaseCartDiscountApplication!]!` with
the `CartCodeDiscountApplication` (`code`), `CartAutomaticDiscountApplication` and `CartCustomDiscountApplication`
(`title`) implementers; line allocations are the `CartDiscountAllocation` interface (`code` or `title` per
implementer); `lines` is a `BaseCartLineConnection` with `PageInfo { hasNextPage endCursor }`;
`CartLine.parentRelationship.parent` is a `CartLine`; `CartLine.instructions` has `canRemove` and
`canUpdateQuantity`; `PricingPercentageValue.percentage` is a `Float`; `MoneyV2.amount` is a Decimal string. The
`CurrencyCode` allowlist in `src/commerce.js` is that enum (deprecated values included) without `XXX`.

- A cart ID is opaque and used whole, including its secret `key` parameter (`trustedCartId`): the production
  type `gid://shopify/Cart/`, a nonempty token and a nonempty `key`; no raw whitespace, control characters,
  backslash or fragment. The token alphabet and length are not assumed. It is never parsed and reserialized.
- A clean `cart: null` with userErrors on a **mutation** is an application error whose remote outcome is
  unresolved. A clean `cart: null` on a **query by exact ID** establishes absence for that ID at read time.

## The mutation dispatcher (`dispatchCartStep`)

Every mutation — create, line add/update/remove, discount codes, cart attributes, recovery create and
attachment — is one numbered step of an explicit operation context, with its GraphQL field and expected target.

1. The body is serialized first. The whole safety snapshot is compared, the revision notice is persisted (the
   first step only), and the step is armed (`status: armed`, `step.state: dispatched-unknown`) with its pre-step
   identity and the operation's minimal recovery snapshot, then read back.
2. `fetch` is invoked with no intervening await, `redirect: 'manual'`, and no automatic retry. From then on a
   synchronous throw, abort, timeout, lost connection, unreadable body, any HTTP status (redirects, 400, 401,
   403, 404, 408, 422, 429, 5xx) or reload leaves a potentially dispatched step. There is no HTTP shortcut.
3. JSON is decoded (bounded by the request timeout) for every status. The expected field's own `cart.id`, if it
   is a trusted cart ID, is recorded **before** any message is formatted or any content validated: for a first
   create as the record's candidate; for an existing cart, an unexpected ID is kept as `conflictingIds` and never
   published. If the evidence cannot be persisted, the ID stays in memory for that owner and step, and nothing
   is published, attached or created until it is durable. A body that arrives after the timeout may add evidence
   to the same unresolved step only, under the lock and from the record's exact bytes.
4. Diagnostics are separate from settlement. Only a 2xx response with a plain envelope, absent or empty `errors`,
   the expected payload, an explicit non-null `cart` and an empty `userErrors` array is eligible for forward
   progress, and even then a **fresh authoritative read** of the cart decides. Messages use only nonempty
   primitive strings, with a fixed fallback; error objects are never coerced.
5. The only settlement a response can support: an existing-cart application rejection whose fully valid same-ID
   cart and a fresh read both equal the pre-step state, when no earlier step of the operation committed
   (`definitiveRejection`). A stock warning likewise settles a step only when it names a requested line and both
   the validated reply cart and the fresh read equal the pre-step state.

`journaled()` is the one admission and lifecycle wrapper. It never reads an error code as proof of settlement:
an operation is retired when its own postcondition was verified (`completed`) or when every armed step was
observed unchanged; a never-armed prepared record is withdrawn; anything else stays `unresolved` and blocks
across reload. Response-based publication, `journalCreateCandidate`, `publishCreatedCart`, `classifyCartReply`,
`markUnsafe`/`clearUnsafe`, `withdrawUndispatched`, `retireUnsafeCart` and `settleRejectedRecovery` are gone.

## The journal (exact values and ownership)

Records keep the `anawin-shopify-unsafe-op:` namespace. Each public operation has one versioned root record
(`v: 2`, a unique `owner`, `cartId` scope — the cart, or `*` for a first cart — and its steps). Checkout freezes
are a distinct record (`type: 'freeze'`, `kind: 'checkout handoff'`) using the same primitives.

- `snapshotSafety` captures the active pointer and the raw bytes of every journal and legacy key;
  `assertSafetySnapshot` compares membership and exact bytes synchronously before every dispatch, consent
  decision, publication and retirement. Only the operation's own verified writes advance its snapshot.
- `writeOwnedRecord`/`removeOwnedRecord` compare the exact current bytes (absence for a create) immediately
  before acting and read back afterwards. A foreign value is never overwritten or rolled back over.
- **Admission:** a record gates a cart when it names it, is a first-cart (`*`) record, is unreadable, or is
  adopting that cart as its candidate. Terminal records never gate. A provably never-armed prepared record (and
  a 2G `dispatched: false` pending record without a candidate or historical evidence) is ignored for admission.
- **Supersession is logical.** A fresh recovery attempt names the exact bytes of the attempts it supersedes and
  leaves them intact. A failed successor setup changes nothing; an ambiguous successor stays blocked beside its
  predecessors. A changed predecessor no longer matches its link, so both stay current and resuming is refused.
- **Retirement** keeps any record that still names a cart nothing else references, as a non-gating terminal
  record (`resolution`: `adopted`, `observed unchanged`, `candidate absent`, `abandoned`, `superseded`,
  `recovered`, `kept`). A record that cannot be retired is left conservatively.

| Transition | Effect | Network |
| --- | --- | --- |
| Prepare | own record written (requires absence) and read back; proves only that no step was armed | none |
| Arm | snapshot, revision and prepared payload verified; step persisted `dispatched-unknown` | one fetch at most |
| Record evidence | candidate or conflicting ID added, prior evidence kept | none |
| Reconcile | fresh complete same-ID read verifies the step, or an allowed unchanged result | reads only |
| Finish or adopt | postcondition verified; `adopting` persisted (gating source and candidate), pointer written and read back | none |
| Explicitly resolve | terminal reason under the lock with fresh evidence and exact consent | none |
| Retire | terminal record removed only from its exact owned bytes, when nothing else needs its IDs | none |

## One raw-cart contract and one authoritative read

`readAuthoritativeCart(id)` reads every page by the exact ID (`after` cursors, at most 50 pages of 50 lines;
a terminal `hasNextPage: false`; a nonempty advancing cursor otherwise), compares cart-level metadata across
pages, and confirms a multi-page read by a second complete sweep with identical canonical content (the
checkout URL comes from the final sweep). `validateRawCart` returns a discriminated verdict:

- **valid** — every check passed. Only this can feed a write baseline, publication, mismatch consent or checkout.
- **limited** — every structural, identity, money, URL, discount and catalog check passed, but glove/service
  customization is incomplete. Usable only by an operation's own expected intermediate step, the glove-only
  recovery of unreadable service data, or the journal-bound historical partial-recovery proof.
- **missing** — an explicit `cart: null`. Observations keep the active ID.
- **invalid** — anything else. Reads reject with `cart-unverified`; invalid data is never returned as a cart.

Checks: exact ID on every page; an approved checkout URL (`verifiedCheckoutUrl`); unique nonempty line IDs;
positive safe-integer quantities; no filtered lines; merchandise in the configured catalog product and handle
(trainer and full-size), the configured trainer service variant or pinned full-size service variant; parent links
to an actual glove with the same merchandise, handle and options (no orphans, self links, nested gloves or second
services); unique, nonempty option and attribute keys with string values; the hand derived from the catalog
variant, with returned options and any glove or service Throwing Hand / Glove Model attribute agreeing (the
right-only CM24 fallback only when the catalog variant has no hand option); every amount a Decimal string
matching `^[0-9]+(?:\.[0-9]+)?$` (no numbers, whitespace, exponents, hex, signs, nonfinite values or nonzero
underflow) in one allowed currency; explicit discount arrays with nonblank codes unique case-insensitively,
boolean applicability, documented `__typename` branches, code applications and allocations naming returned codes,
and percentages in [0, 100]. Comparisons use canonical decimals and the canonical stamp (identities, merchandise,
hand, quantities, parents, attributes, prices, currency, discounts; not the checkout URL).

Reads (`getCart`, `peekCart`, `refreshCart`/Check cart, startup, storage events, checkout's fresh read) write
nothing: no journal record, pointer, revision, recovery snapshot or baseline. The catalog is loaded read-only on
demand. The write baseline is captured inside the locked operation.

## Named transitions without a Shopify write

- **Missing active cart.** A read keeps the pointer. A locked add may detach it only when nothing but an exact
  checkout freeze gates it (the freeze record stays). The shopper's **Start a new cart** may detach a verified
  missing pointer and keeps every record. A live or unverified pointer is never forgotten.
- **First-cart candidate** (`reconcileUnconfirmedCart`). A valid exact intent match or a valid empty cart is
  adopted; a valid different cart becomes active under a mismatch record; a candidate positively read missing is
  resolved absent for its exact ID; invalid or limited data changes nothing.
- **Mismatch consent** (Keep the items shown / Start a new cart) binds the active pointer, the mismatch records'
  exact bytes (`reviewBinding`), the complete review stamp and a fresh valid read. Discard keeps the cart's ID in
  a terminal abandonment.
- **ID-less unknown.** An armed first create without a usable ID blocks every create across reload. The drawer
  says Shopify may already have saved a cart; only `startNewCart({ abandonUnknown: true })` (the drawer button
  beside that disclosure) records a terminal abandonment, and it sends nothing. With a known candidate the check
  comes first; abandonment is accepted only when a fresh read shows the candidate is not a valid cart.

## Recovery

Stages: `create`, `created` (parents verified), `children` (attachment armed) and `adopting`, all through the
dispatcher. The source pointer stays unchanged throughout. Before the first mutation the source is validated and
its canonical stamp and the exact bytes of its safety records are journaled. A glove-only choice journals the
`service data unavailable` safety record first, keeps each verified glove and wrist fit, and removes the service
and its metadata. Unrelated cart attributes are copied; preorder details are recomputed at checkout.

On any ambiguous create, recovery stops; an explicit check reads the durable candidate. Only a freshly verified
parent-only candidate whose attachment was provably never armed may send the attachment. An armed attachment is
resumed by reads only: an exact final pairing is adopted; missing, partial or mismatched services stay blocked
with zero replay. Before publication: the source is read again, then a fresh complete candidate read, then the
whole snapshot is compared synchronously; any new source, candidate, wildcard or malformed record, or any
authorized value replaced or deleted under its key, stops it. Only the exact participants authorized before the
reads are resolved. An adoption interrupted after its pointer moved is completed by reads only under the same gate.
A fresh attempt (**Try recovery again**, **Start over with/without Break-In Service**) requires the attempt binding
the drawer showed (`recoveryBinding`) and keeps the selected service mode.

## Checkout

Under the exclusive lock through navigation: a clean snapshot and a fresh valid read come first. A displayed cart
whose stamp differs (or `requireReview`) gets a verified review and another click. Preorder details are written
through the journal, verified exactly (attribute value, unchanged purchase state), with the blank-value fallback
only after a clean verified first result; an ambiguous attribute write blocks this and later checkouts across
reload. The final read may differ from the reviewed cart only in that attribute. The approved URL from that read
is used; the freeze is persisted and read back, the revision published, safety rechecked synchronously, and
navigation invoked once. A failure provably before navigation removes only the exact owned freeze; once the
callback was invoked the freeze stays (exception, dropped handoff, cancelled leave, bfcache return). The handoff
watcher and drawer feedback are unchanged.

## Migration

Existing active IDs, legacy keys (`anawin-shopify-unsafe-cart-id`, `anawin-shopify-pending-mutation`,
`anawin-shopify-pending-addition`) and 2G operation, freeze, mismatch and recovery records are read without any
startup rewrite. Unreadable or ambiguous records block (recovery refuses them; repair of arbitrary malformed
journals is deferred). A non-production cart pointer (for example `gid://cart/1`) is unverified and blocks.
Legacy records are reconciled only from their exact current bytes and fresh authoritative reads; a 2G recovery
record naming source records by key has their exact current bytes authorized before any read. Embedded 2G
`supersededRecords` are kept: a record carrying them stays as a terminal record. Nothing synthesizes a missing
intent, hand, dispatch fact or ownership. `anawin-shopify-pending-addition` is included in cross-tab storage
invalidation.

## Limitations and risks

- Mixed deploys: tabs still running an older build take the same lock but interpret records with older rules.
- A long multi-request operation makes other tabs' cart buttons wait (up to 90 s).
- A shopper can be blocked until an explicit choice: an unknown create, a missing cart with records, an unverifiable
  candidate, or an unreadable record (the last needs site data cleared; repair is deferred).
- A returned first-cart ID that storage refuses to journal lives only in that tab's memory; after a reload only
  the armed record (which still blocks) remains. The browser cannot reconstruct a lost ID.
- Terminal records accumulate (they never gate); explicit abandonment and recovery can leave unused carts in
  Shopify, and the drawer says so.

## Tests (Task 2H)

`test/cart-acceptance-2h.test.js` is the fixed acceptance matrix (134 tests), each row with positive and negative
controls from independent storage and fixture carts, asserting mutation counts by field, saved fixture carts by
ID, the pointer, raw record bytes, terminal or blocking state and navigations, in the original instance and a new
one sharing only storage. It ports every scenario of the independent 2G probe script to the corrected outcome.
`test-support/shopify-fixture.js` now issues production-shaped IDs (`cartGid`, or `cartIdFor` for long opaque
IDs), keeps saved carts by ID (`savedCarts`, `cartLines`), answers `cart: null` for unknown IDs, paginates by
cursor (`pageSize`), types discount applications and allocations, defaults to the approved checkout host, drops
zero-quantity lines, keeps catalog and cart variant options consistent, and offers `faultAfterSave` (an HTTP
status with or without the original body, an abort, a lost connection or a timeout after Shopify saved the
mutation). `recoveryBindingOf(fixture)` gives the attempt binding the drawer would show. The recovery browser
suite adds post-refusal Check cart, the refused fallback abandonment of a valid candidate, and a 375 px keyboard
checkout whose navigation is captured and aborted locally (its key is redacted in the evidence file).

### Changed expectations (each keeps its scenario and fixture)

- **No HTTP finality** (rows 1, 9): tests that read HTTP 422 or another 4xx as “nothing happened”
  (`http-rejected`) now expect an unresolved write (`uncertain`), no replay, and recovery from fresh reads.
  Retryable editor and edit rejections use Shopify's verified-unchanged user error instead.
- **No null-payload finality** (row 2): `cart: null` with userErrors on a create stays armed until affirmative
  abandonment (`startNewCart({ abandonUnknown: true })`).
- **No response publication or settlement** (rows 1–3): a reply's cart contents (ID-only carts, blank or missing
  codes, a split service, missing fields, unrecognized lines) are never authority; the fresh read decides.
- **Invalid data is never a cart** (row 3): reads of malformed money, hands, currency, codes, pagination or
  services reject with `cart-unverified` instead of returning an `incomplete` cart.
- **No implicit cleanup** (row 4): a candidate read missing is a terminal resolution (no Start a new cart needed);
  discarded, superseded or abandoned cart IDs stay in terminal records, so “no records” became “no live records”;
  never-armed prepared remnants may remain.
- **Logical supersession** (row 8): faults on removing or restoring earlier attempts no longer apply (nothing is
  removed); earlier attempts stay journaled; a fresh attempt needs the displayed binding.
- **Freeze after navigation** (row 11): a navigation callback that throws keeps its freeze.
- **v2 lifecycle**: in-flight records are `prepared`/`armed` (not `pending`), there is one root record per
  operation, reads page with `after`, and recovery refuses malformed records instead of clearing them.

## Earlier test suites (Tasks 2B–2G)

These suites still run. Where Task 2H changed an expectation, the test says so in a `Task 2H` comment; see
“Changed expectations” above.

`test/cart-acceptance-2g.test.js` (Task 2G) holds permanent negative controls for:
- first creates answered with a complete empty cart plus userErrors, partial data beside a GraphQL errors array or
  a malformed errors object, full data beside errors, untrusted IDs (numeric, non-GID, blank), response loss, and
  storage that refuses the candidate (exactly one CreateCart across reload, and the remote fixture cart adopted);
- recovery creates with partial data and errors (ID kept, no attachment, resumed without replay);
- existing-cart and discount writes with partial data and errors;
- glove-line Throwing Hand contradictions in both directions, a service naming another model, and thirteen money
  faults (missing, null, non-numeric, NaN, negative, infinite or wrong-currency amounts, and malformed currency
  codes). Each runs at least four checkout clicks and a reload with zero navigations, alongside valid price-change,
  trainer and full-size controls;
- refused Keep and Start a new cart (null, malformed and omitted reads), followed by Check cart, getCart, peekCart
  and reload, with every stored byte compared; missing carts with and without records; a serviced cart missing its
  service attributes (zero writes, every write refused, glove-only recovery still works);
- a checkout freeze on a live cart and on a completed one;
- a two-record retry whose new create meets HTTP 422, `cart: null` with userErrors, a lost reply or partial data; a
  restore that fails after dispatch; and a foreign record that stays byte-identical.

Earlier tests replaced by Task 2G's policy (each keeps its safety intent):
- `HIGH-3: an explicit null active cart is forgotten as before` (recovery-integrity) and the startup test for an
  expired cart now assert that the read keeps the ID and the next add replaces it.
- `failed first cart creation keeps the cart empty…` and `a failed create after an expired-cart read…` (commerce)
  now assert that a complete empty cart beside userErrors is journaled and blocks a second create. Reconciliation
  then clears it (Shopify has no such cart) before the deliberate retry.
- The fixture's userError branch now honors `transformNextMutationResponse`. Before this, `HIGH-2: a well-formed
  create rejection (cart: null…)` (2E) never actually sent `cart: null`.

No concurrency or simultaneous-write test was removed or weakened. The recovery browser suite now also presses Check
cart after the refused consent (null, repeated null, malformed) and compares localStorage byte for byte.

`test/cart-acceptance-2f.test.js` (Task 2F) holds permanent negative controls for:
- ID-only and unreadable create replies with valid userErrors (candidate journaled, no second
  CreateCart, reload, adoption);
- persistent wrong-hand data across repeated checkout clicks and reload (both hand directions,
  serviced and unserviced, contradictory service attribute, honest and trainer controls);
- refused consent followed by the drawer's side-effect-free redraw;
- retry rollback that cannot restore, or cannot withdraw;
- recovery CreateCart and AddLines replies without userErrors, with wrongly typed userErrors, with an
  ID-only cart, or with malformed GraphQL errors.

The recovery browser suite adds a refused-consent scenario: `cart: null` (repeated) and malformed
consent reads, through the real drawer error path, with localStorage compared byte for byte.

`test/cart-acceptance-2e.test.js` (Task 2E) holds permanent negative controls for:
- hand contradictions on the ordinary first add (right to left, left to right, serviced and
  unserviced), with zero checkout navigation, and a hand changed after display;
- handless legacy records (full-size never matches; trainer still does);
- `cartCreate` and update replies with an omitted `cart` or malformed `userErrors`, including
  request-sequence and saved-cart checks and recovery's create;
- side-effect-free consent reads (explicit null, omitted cart, malformed envelope, changed cart,
  altered review stamp);
- two-record retry interruption at every persistence and removal boundary;
- the returned recovery cart coming from the confirmed read;
- a saved service whose quantity differs from its glove.

`test/cart-consent-integrity.test.js` (Task 2D) holds permanent negative controls for:
- stale Keep and Start a new cart consent across two tabs (A to B);
- attachment responses that claim an unsaved service, and re-reads with missing, duplicate,
  wrongly parented or changed children;
- missing, null or malformed pagination on source and candidate reads;
- the journaled selected hand (right/left, contradictory hand under the same merchandise ID,
  serviced and unserviced);
- malformed GraphQL envelopes on reads and mutations;
- every pre-dispatch boundary of a fresh recovery attempt;
- `children`-stage read-back failures;
- Break-In mode preservation.

`test/cart-recovery-integrity.test.js` (Task 2C) reproduces each review finding:
- recovery-response identity under a real checkout freeze;
- mismatched first carts (blue requested vs black saved, serviced vs unserviced);
- omitted vs explicit-null carts on candidate and active reads;
- glove-only vs serviced attempts;
- blank and whitespace codes on reads, responses, apply/remove, checkout and recovery;
- final source verification;
- Try recovery again ordering;
- journal read-backs that throw.

It also restores foreign-record ownership coverage (completion, rejection, timeout and ambiguity
retire only their own record while a foreign pending record and the checkout block stay). It adds
coordinated queued serviced stock steps, and a coordinated tab queued behind a write that ends
unresolved.

`npm run test:browser:recovery` (`scripts/browser/cart-recovery-browser.mjs`, loopback server
`cart-recovery-server.mjs` on port 5201 with a loopback-only fault-injection endpoint) drives two
same-origin tabs of one profile through **Start a new cart**, **Check unconfirmed cart** (adopt
and mismatch), **Check the new cart**, **Try recovery again**, stale Keep and Start a new cart (two
tabs, A to B), and a serviced recovery followed by an explicit glove-only restart whose default retry
stays glove-only. Saved Shopify fixture state is checked by cart ID. It checks labels, keyboard
activation, focus, alert and polite-status announcements, busy states, server-side create counts,
cart quantities and checkout refusal. It uses the same `ANAWIN_CHROME`/`LD_LIBRARY_PATH`/`FONTCONFIG_FILE`
setup as `npm run test:browser:cart`.

`test/cart-safety.test.js` covers the Task 2B corrections: active-ID publication that throws or is
dropped, reload between candidate and publication, candidate gone or ambiguous, late create
responses; abandoned pending records blocking every write (before and after reload) and checkout's
preorder write; lost recovery-create and lost Break-In-attachment responses, partial recovery,
interrupted stages and unjournalable recovery; malformed discount data on reads, on mutation
responses and in recovery; revision and journal write failures before dispatch; rejected lock
requests. `fixture.detached()` is a writer outside both the lock and the journal.

`test/cart-concurrency.test.js` covers simultaneous first adds, create timeout and reload, two +1
intents (2 then 3), paired Break-In parity, changed-line refusal, stock and removal, overlapping
discount apply/remove, quantity plus discount, missing Web Locks, lock timeout, storage failures,
Shopify userErrors and ambiguous writes, checkout exclusion and freeze, and recovery without
duplicate merchandise. `test-support/shopify-fixture.js` exposes `createLockManager()`,
`fixture.locks` and `fixture.uncoordinated()`, a writer outside the lock. Older tests that
overlapped two same-browser writes now use that writer, because coordinated tabs can no longer
overlap.


## Testing against the Task 1G purchase-regression harness

The harness in `phase6/purchase-regressions` is not yet an accepted release gate, and this
branch does not copy or change it. After both branches pass integration review:

1. Merge both into one integration branch (not this worktree) and run `npm test` and
   `npm run test:browser:cart` there.
2. Run the harness's multi-tab scenarios unfiltered. Expected changes from this branch: a second
   first-add lands in the same cart; two +1 taps from stale tabs give 3; discount actions from two
   tabs are both kept; a tab whose glove changed shows `cart-changed` feedback and writes nothing.
3. Any harness assertion that expects two same-browser tabs to write at the same time, or that
   treats an absolute quantity from a stale tab as the outcome, needs review against this design
   before it is changed. Do not weaken production code to satisfy it.
4. Record the exact failing assertion identities before and after, as the harness requires.
