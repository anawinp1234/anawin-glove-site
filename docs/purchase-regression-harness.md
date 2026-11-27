# Purchase regression harness (Phase 6)

A deterministic, mock-only browser suite for the cart and checkout paths that Phase 6 will change:
mobile cart layout, Break-In pairing, discounts, checkout handoff, cart concurrency and failures, and
drawer accessibility. It is the acceptance gate for Task 2. It runs inside a least-privilege
bubblewrap sandbox, drives Chrome over raw CDP, and adds no dependencies.

| File | Role |
| --- | --- |
| `scripts/browser/run-isolated.mjs` | Builds the sandbox, runs a preflight probe inside it, then runs the suite. Exits 3 if anything cannot be set up or verified. |
| `scripts/browser/isolation.mjs` | The in-sandbox proof (`verifyIsolation`) and the seccomp program. The suite and the mock server both refuse to run without the proof. |
| `scripts/browser/purchase-regression-server.mjs` | The loopback Vite storefront. Shopify's `fetch` is replaced by `/__fixture`; `/__control` (token-protected) scripts the mock. Started by the suite, never by hand. |
| `scripts/browser/purchase-regression-fixture.mjs` | A strict multi-cart Storefront API mock. The unit tests keep using `test-support/shopify-fixture.js`. |
| `scripts/browser/purchase-regression-browser.mjs` | The scenarios, the acceptance gates, the gate self-tests and the runner. |
| `package.json` → `test:browser:purchase` | `node scripts/browser/run-isolated.mjs scripts/browser/purchase-regression-browser.mjs` |

## Prerequisites

- **Linux on x86-64 with unprivileged user namespaces.** WSL 2, a Linux machine or a Linux CI runner. To check, run `unshare --user --map-root-user --net true`; it should exit 0. macOS and Windows hosts cannot run the suite. It refuses (exit 3) rather than run unisolated.
- **bubblewrap, root-owned, at `/usr/bin/bwrap` or `/bin/bwrap`.** Install it with `sudo apt install bubblewrap`. The launcher never looks bubblewrap up on `PATH`; it refuses a binary the user could replace. Verified with 0.11.1. On Ubuntu 24.04 and later, AppArmor may restrict unprivileged user namespaces, which makes `bwrap` fail. The launcher reports this and exits 3. To fix it, allow `bwrap` in an AppArmor profile, or use a runner that permits user namespaces.
- **python3, root-owned, at `/usr/bin/python3` or `/bin/python3`.** It runs only the sandbox preflight probe. A pyenv or virtualenv shim is ignored.
- **Node 22 or later** (for the global `WebSocket` and `fetch`). Verified with v22.22.3. Then run `npm ci`. The launcher binds Node's install folder read-only and runs it by real path.
- **A Linux Chrome binary in `ANAWIN_CHROME`.** Verified with Chrome for Testing 150.0.7871.24. The path is resolved through symlinks and must be a regular executable file. A path that resolves to a Windows program (`*.exe`, or anything under `/mnt/`) is refused, because it would run outside the sandbox. If Chrome lacks `libasound.so.2`, extract it (`apt download libasound2t64 && dpkg-deb -x …`) and put the extracted library folder in `LD_LIBRARY_PATH`; those folders are bound read-only.
- **Real Arial in `FONTCONFIG_FILE`.** Linux maps the storefront's `"Helvetica Neue", Arial` to DejaVu Sans, which is much wider and changes the 320px layout. Point `FONTCONFIG_FILE` at a fontconfig file that adds real Arial, and confirm that `fc-match Arial` reports `arial.ttf`. The file's folder and every `<dir>` it names are bound read-only. The risk:1 and risk:5 measurements assume real Arial.

## Running it

```sh
export ANAWIN_CHROME=~/.cache/selenium/chrome/linux64/150.0.7871.24/chrome
export LD_LIBRARY_PATH=<dir containing libasound.so.2>        # only if Chrome lacks it
export FONTCONFIG_FILE=<fonts.conf that adds Arial>
npm ci
npm run test:browser:purchase
```

Optional variables:
- `ANAWIN_PURCHASE_EVIDENCE_DIR`: base folder for evidence; each run writes `run-<timestamp>/results.json` and its screenshots there. Defaults to `$TMPDIR/anawin-purchase-regression-evidence` on the host. The folder is bound writable.
- `ANAWIN_PURCHASE_ONLY=<substring>`: runs only the scenarios whose names contain it. A filter that matches nothing is an error (exit 2), not a pass.

The older suites run through the same launcher:
- `node scripts/browser/run-isolated.mjs scripts/browser/cart-break-in-browser.mjs` (starts its own fixture server).
- `break-in-browser.mjs` needs `break-in-server.mjs` (ports 5199 and 5200) running in the same sandbox. Use a small wrapper script that starts the server and then the browser script, and pass the wrapper to `run-isolated.mjs`. Their evidence goes to `ANAWIN_BREAK_IN_EVIDENCE_DIR` and `ANAWIN_CART_EVIDENCE_DIR`; these default to host temporary folders and are bound writable.

A full run takes about 90 seconds. About 20 seconds of that is two real 10-second Storefront request timeouts; most of the rest is the bounded 2-second windows in the race scenarios.

### Exit status

| Code | Meaning |
| --- | --- |
| 0 | Every check passed. |
| 1 | Only application checks failed (`baseline`, `risk:<n>` or `finding`). The harness was sound. |
| 2 | Harness or infrastructure fault. One of: a `harness` check failed (including a gate self-test); a scenario could not complete; the mock or Chrome would not start or failed its handshake; a process did not exit at teardown; evidence could not be written; or the filter matched nothing. |
| 3 | The sandbox could not be created or verified. Nothing ran. |

While the known defects below remain, the expected result is **exit 1, with zero `harness` and zero `baseline` failures**.

## Execution boundary: what is guaranteed, and what is not

### What the sandbox is

`run-isolated.mjs` runs the suite, the mock server and Chrome under bubblewrap with:

| Layer | Setting |
| --- | --- |
| Namespaces | New network, PID, IPC and UTS namespaces (`--unshare-net --unshare-pid --unshare-ipc --unshare-uts`), plus `--die-with-parent --new-session`. Every process belongs to the run and dies with it. |
| Filesystem | **Read-only root** (`--ro-bind / /`). A minimal `/dev` and a fresh `/proc`. Empty tmpfs over `/tmp`, `/run`, `/mnt`, `/home`, `/root` and `/media`. Bound back **read-only**: the repository, Node's install folder, Chrome's folder, the suite's folder, the `LD_LIBRARY_PATH` folders and the fontconfig folders. Bound **writable**: only the evidence folders and `node_modules/.vite` (Vite's dependency cache). |
| Home and environment | `HOME=/tmp/home`, a fresh empty folder. `--clearenv`, then an allowlist only: `PATH` (Node's folder, `/usr/bin`, `/bin`), `HOME`, `TMPDIR`, `LANG`, `TZ`, the resolved `ANAWIN_CHROME`, `LD_LIBRARY_PATH`, `FONTCONFIG_FILE`, the evidence folders, `ANAWIN_PURCHASE_ONLY`, and the launcher's own facts (parent namespace, source revision and status, sandbox profile). No tokens, credentials, proxies, `SSH_AUTH_SOCK`, `DBUS_*`, `WSL_INTEROP` or `XDG_RUNTIME_DIR`. |
| Descriptors | Standard input is `/dev/null`. Nothing beyond stdio is inherited; the preflight checks this. |
| seccomp | A filter refuses `socket(AF_VSOCK, …)` with `EAFNOSUPPORT` and `io_uring_setup` with `EPERM` (io_uring can open sockets without `socket(2)`), and refuses non-native (32-bit or x32) syscall ABIs. Everything else is allowed. Chrome's own sandbox stacks on top. |
| Executables | `bwrap` and `python3` must be root-owned and not group- or world-writable. Node, Chrome and the suite are run by real path. Nothing is looked up on `PATH` by the launcher. |

**Preflight.** Before the suite runs, `run-isolated.mjs` starts an identical sandbox running `python3 -I`. It requires that:
- an `AF_VSOCK` socket is refused with errno 97;
- a full filesystem walk (excluding `/proc`, `/sys` and `/dev`) finds no socket files;
- no descriptor beyond stdio exists.

**In-sandbox proof.** Both the suite and the mock server then call `verifyIsolation()` and exit 3 unless:
- the network namespace differs from the launching shell's;
- `/proc/net/dev` lists only `lo`;
- there are no IPv4 routes and no non-loopback IPv6 routes;
- a seccomp filter is active (`/proc/self/status`);
- WSL interop is unreachable;
- `/run` and `/mnt` are empty and `HOME` is `/tmp/home`;
- no socket descriptor above stdio was inherited;
- loopback works.

These checks are passive: they read `/proc` and the filesystem. No connection is ever attempted to anything except the run's own loopback listener. The preflight creates, but never connects, an AF_VSOCK socket to prove the filter refuses it.

### What is demonstrated

Each run demonstrates, from inside the sandbox, that:
- **There is no direct network path off the machine.** The only network interface is loopback, in a namespace private to the run, with no IPv4 or non-loopback IPv6 routes. TCP, UDP or other IP traffic from the suite, the mock server, Chrome or the storefront code has no route to Shopify, checkout, payment, newsletter, analytics or any other host.
- **These channels are explicitly denied:**
  - AF_VSOCK socket creation, refused by seccomp and proven by the preflight;
  - `io_uring_setup`, refused by seccomp;
  - WSL interop, because `/run/WSL` is hidden. Without that overlay, `cmd.exe` started inside the network namespace had full network access;
  - filesystem Unix sockets of the host, because none is visible (preflight walk);
  - abstract Unix sockets of the host, which are scoped to the network namespace;
  - the user's home folder, except the bound-back repo, Node and Chrome folders;
  - writes anywhere on the host, except the evidence folders and Vite's cache.

Other processes on the machine keep their normal network; nothing global is changed.

### What is not promised

This is **not** a promise that no external communication is possible under arbitrary code.

- **Shared kernel.** All processes share the host kernel; this is not a VM. A kernel, bubblewrap or Chrome vulnerability could cross the boundary. The seccomp filter is a narrow denylist for named host-mediated channels, not a general syscall sandbox.
- **Hypervisor and device channels.** These were not exhaustively audited. On WSL 2 the sandbox has its own minimal `/dev`, but `/sys` is the host's (read-only). Other hypervisor-backed channels the kernel provides without a socket may exist. `9p`/`drvfs` mounts are hidden under `/mnt`, but would reappear if bound back.
- **Read access is broad.** The host root (system files, `/etc`, `/usr`, `/var`, `/opt`), the repository and the bound folders are readable. The repository holds no production credentials (only `.env.example`). The demonstration covers direct network egress and the denied channels listed above, not the confidentiality of readable files.
- **Trusted inputs.** The launcher trusts the root-owned `bwrap` and `python3`, and the user-owned Node, Chrome and repository it is pointed at. Anything compromised among them runs inside the same sandbox with the same limits, but is not otherwise contained.

**Use it only on a trusted, dedicated runner:** a Linux host (WSL 2, VM or CI runner) holding no production secrets or deploy credentials, running nothing else of value, with a known-good kernel, bubblewrap, Node and Chrome. On such a runner, the suite's own network traffic is limited to loopback. The residual kernel and hypervisor-channel uncertainty above remains.

## Mock strictness

- The server accepts only these requests:
  - `Host: 127.0.0.1:<port>`;
  - `GET`/`HEAD` for storefront assets;
  - `POST /__fixture`;
  - `POST /__control` with the run token.

  Anything else is refused and recorded as a violation. The suite starts the server on a free port and trusts it only after a token-hash and PID handshake plus a challenge on `/__control hello`.
- The fixture models only `ProductByHandle`, `Cart`, `CreateCart`, `AddLines`, `UpdateLines`, `RemoveLines`, `UpdateDiscountCodes` and `UpdateCartAttributes`. Each of these throws and is recorded as unmatched:
  - an unknown operation;
  - a cart selection missing a required field;
  - `CreateCart` without `input`, or with an empty or missing `lines` list;
  - `AddLines` or `UpdateLines` without a non-empty line list;
  - `RemoveLines` without `lineIds`;
  - a line without `merchandiseId`;
  - a mutation without `cartId`.

  An unknown cart or a stale line ID gets a Shopify-style `userError`, never a silent removal.
- **Mutations are all-or-nothing.** A mutation that fails part-way (a thrown error or a `userError`) leaves the cart exactly as it was. Partial commits exist only where a scenario asks for one explicitly: `failNext` with `phase: 'after'` (logged as `committed-then-failed`), or a hold. A mutation answered with `userErrors` is logged as `user-errors`, never as `committed`. Each mutation's log entry records its status, its `userErrors` and the resulting line quantities. The unit-test fixture (`test-support/shopify-fixture.js`) also throws on an unrecognised mutation now, instead of treating it as a removal.
- **Write lifecycle and commit order.** Each request's log entry passes through up to four states. Correlated writes carry the state as `lifecycle`:
  - **received:** logged (`seq` is arrival order), but never executed. It failed before commit, was held, cancelled or went stale.
  - **attempted:** `attemptedAt` is set just before the mock executes it.
  - **rejected:** executed without changing state (`userErrors` or unmodelled).
  - **committed:** the mock changed state. It gets a `commitSeq`, taken synchronously at that point, from a counter that no reset clears.

  A held or slow request can arrive first and commit later, so ordering gates use `commitSeq`, never `seq`. Each browser request to `/__fixture` gets a per-tab tag (`X-Anawin-Request`, added at CDP interception) that the mock logs. The correlator matches a tagged request only to the entry with the same tag, and still checks the cart and lines. Each line is compared by its full identity: line ID, merchandise, quantity, and for a nested AddLines line, its parent by line ID or by merchandise. Gates that order writes also take the mock's own mutation log, collected independently of that correlation (see `plusOneGate`).
- **Commit evidence (1L, 1M).** Each committed mutation's log entry also records, as the mock saw it at execution time:
  - `cartBefore` and `cartAfter`: the cart's full lines before and after the commit. Each line is a *view*: ID, merchandise, parent, quantity and attributes (sorted).
  - `effects`: every line the commit added, removed, changed or re-keyed. A line counts as changed when its quantity, merchandise, parent **or attributes** differ, so an attribute-only change (a Break-In Level, a wear preference) is a committed effect like a quantity change. Each effect names the change, the line's ID before and after (`previousId`, `id`), and its full view before and after.

  Effects are reset at the start of every request, so a query or `CreateCart` never inherits the previous mutation's effects. Gates decide what a commit touched from this evidence, not from the request's shape: a nested AddLines that names its parent by merchandise changes the service without naming any tracked line ID. The evidence is never trusted on its own; `plusOneGate` checks it first (see below).
- **Forged responses (1M).** `forgeNext` with `operation` and `cart: 'unrelated' | 'blank' | 'absent'` answers the next matching mutation with HTTP 200 whose cart has another cart's ID, a blank ID, or no cart at all. The mock only dry-runs the mutation (`execute(..., { dryRun: true })`), so nothing is committed and no `commitSeq` or `committedAt` is taken. The entry is logged as `response-forged`. `returnedCartId` is recorded exactly as returned: a blank ID stays blank, a missing cart is `null`.
- **Committed forged responses (1N).** `forgeNext` also takes `cart: 'omitted'` (the cart is returned without an `id`) and `mode`. The default `mode: 'dry-run'` is the 1M behaviour above. `mode: 'commit-then-substitute'` executes the mutation for real first: it takes a `commitSeq`, `committedAt` and the commit's effects, and records the fixture's own saved cart (`committedState`) and the cart ID it would have returned (`committedReturnedCartId`). Only then is the returned cart replaced. The entry is logged as `committed-response-substituted`, with `forged` and `forgeMode`.
- **Discount outcomes are separate facts (1L).** `failNext` with `status: 200` answers HTTP 200 with only top-level GraphQL `errors`. The entry records them as `graphqlErrors`, apart from the HTTP status and from `userErrors`. Each cart summary reports both a code's membership and its `applicable` flag. The mock options `acceptedCodes` (which codes are applicable) and `codeCase: 'upper'` (Shopify returning its own spelling of a typed code) let scenarios reach the committed-but-inapplicable and mixed-case paths.
- **Cart registry:** every cart has its own lines, discount codes and attributes. Every created cart stays in a registry, so orphaned carts are enumerated.
- **No auto-sync:** child (service) quantities never follow their parent; the storefront must update them itself.
- **Scenario checks:** every request is logged with the scenario it arrived in. After each scenario the harness requires: no unmatched request, no violation, no request from another scenario, and no held request left unreleased.
- **Faults are never lost.** Every reset, including the ones scenarios make mid-way, hands back what the replaced mock recorded, and the runner keeps it as an infrastructure fault. The mock also keeps a cumulative fault log that no reset clears. At the end of the run, any interception error, route violation or unmatched request anywhere is a `harness` failure. The only exception is a fault deliberately injected by the fault-preservation self-test, which carries a per-run marker: it is reported under `expectedSelfTestFaults`, and the run fails if it is *missing* from the final record.

**CDP interception** is a second layer:
- Mock routes continue, checked by method and route; the page may not call `/__control`. `/__fixture` requests continue with their own headers plus the per-tab `X-Anawin-Request` tag.
- `GET` document navigations to `https://ignvv0-zh.myshopify.com` are answered locally (a stub page, or a 204 for a dropped handoff) and recorded as handoffs.
- Everything else is failed and recorded as external, which fails a `baseline` check.

All data is synthetic, and checkout keys in evidence are redacted.

## Acceptance gates

Concurrency, recovery, checkout-URL and busy-Apply checks are pure functions of what was observed. That lets the self-tests feed them known-good and known-bad outcomes (see "Self-tests").

**What counts as a refusal (`classifyRefusal`).** A refusal is always for a specific action: `add`, `increase`, `apply` or `remove`. All four must hold:
1. The alert is visible.
2. It is new since the action started. Alerts already shown just before it do not count.
3. It names the item, and says the item was not done **in that action's words**: not *added*; not *applied*; not *removed*; for an increase, it must be about the *quantity* and say it was not *updated*, *increased*, *changed* or *saved*. "BR16 was not removed" or "BR16 wasn't added" therefore never counts as refusing an increase.
4. The control needed to retry is still enabled.

Generic copy such as "Your cart changed in another tab" names nothing and never counts. When Task 2 adds refusal copy, it must satisfy this rule; otherwise the rule must be changed deliberately, in the same change.

**Not offered is not a refusal.** A race press that finds its control disabled is recorded as *not offered*. No refusal message is inferred from it: `refused` stays whatever `classifyRefusal` found. The gates decline both states (the action must not have been done), and each gate then checks the cart, codes or writes for anything the declined action committed.

**First add (`firstAddGate`).** Two tabs add BR16 and OB16 while the first `CreateCart` is held. Every cart Shopify created is enumerated, before and after any recovery.
- Each glove must be in the race cart (the cart that was active when the race finished) **exactly once, with exact merchandise, attributes, options and quantity 1**, or refused by name with nothing committed.
- No false "added" announcement, and nothing else in the cart.
- **Every other cart must be empty.** Merchandise committed to any other cart is an orphan, however many copies and whatever any tab said. Only a verified recovery's source cart is exempt.
- If recovery is offered, it is used. It must move the shopper to **exactly one new, distinct cart**, and that cart's configuration must equal the race cart's exactly: nothing dropped, duplicated or re-quantified.

**+1 (`plusOneGate`).** Two tabs each tap + on a serviced BR16 at quantity 1, while the first `UpdateLines` is held. Each tap is correlated with its tab's own submitted writes (from the CDP request body: cart ID, line ID, requested quantity), matched to the mock's entry for the same cart and lines (status, `userErrors`, resulting quantity). The gate requires:
- the same merchandise, choices and service identity, with the service paired at the glove quantity;
- each tap in one of three states:
  1. **not offered** (its stepper was disabled before activation);
  2. **refused** by a fresh, visible, quantity-specific message naming BR16;
  3. **accepted**.

  A disabled observation never stands in for a refusal message, and generic or stale warnings make a tap accepted, not refused;
- a final quantity of 1 plus every accepted tap;
- **every committed line mutation's evidence is checked before it is used (1M).** For each commit, in `commitSeq` order:
  - Both snapshots must be lists of well-formed lines: each has an ID, merchandise, a positive quantity and attributes; IDs are unique; every child sits under a top-level line of the same snapshot.
  - The harness derives the expected change set **from the two snapshots alone**, comparing each line's ID, merchandise, parent, quantity and attributes. A rekey is the one identity claim the snapshots cannot show, so each recorded rekey must take a line that existed before and is gone after onto a new ID that did not exist before, with the same merchandise.
  - The recorded effects must match that set **in both directions**: no missing effect, no spurious effect, no duplicate, and each effect's before and after views equal to the snapshot lines.
  - Each commit's `cartBefore` must equal the previous commit's `cartAfter`, and the first must hold the race's starting glove and service exactly. Otherwise an unlogged or misreported change sits between them.

  Absent, incomplete, inconsistent or ambiguous evidence is a **`harness`** failure. Such a commit's effects are never used; it still counts as touching the glove through its request's shape, so attribution and the declined verdict still see it. Identity tracking, commit ordering, quantities and configuration all use only validated effects;
- **what a commit touched comes from the mock's committed effects (1L), not from the request's shape.** The gate takes every committed UpdateLines, RemoveLines and AddLines for this cart from the mock's log since the race began, independently of browser correlation. It walks them in `commitSeq` order, starting from the glove and service IDs at the start of the race and following any re-key. A commit is relevant if one of its effects changes, removes or re-keys the glove or its service, or adds or changes a line under the glove. Both nested AddLines forms (parent by line ID, parent by merchandise) are caught this way. The request's shape is kept as a second, independent signal: a tracked line ID, a nested `parent.lineId`, a RemoveLines `lineIds` entry, or a `parent.merchandiseId` equal to the glove's;
- **every relevant commit belongs to exactly one tagged browser request of the same operation.** The scenario correlates UpdateLines, RemoveLines and AddLines requests from both tabs. These are all **`harness`** failures (exit 2), because the harness cannot attribute such a commit to a shopper action, so it never treats it as a missing action:
  - a committed line mutation with no recorded effects or `cartAfter`. It still counts as touching the glove;
  - effects that disagree with `cartAfter`, a malformed effect, an effect naming one line twice, or another line re-keyed onto a tracked ID (ambiguous identity);
  - an untagged commit, an orphaned or mismatched tag, two committed entries or two browser requests sharing a tag;
  - a tagged request of a different operation from the commit (unmatched operation), or whose `commitSeq` differs from the mock's;
  - any committed browser line request for this cart missing from the log, or present more than once;
  - any line mutation the mock logged for this cart during the race, **committed or not** (rejected, failed, held), that no browser request sent (1M: the complete log is checked, not only commits);
  - any line commit for this cart whose `commitSeq` is not a unique positive integer, even a single commit, or no log at all;
- **a declined tap (not offered or refused) committed nothing to this cart's BR16 or its service, at any commit, even one a later commit overwrote.** This is one explicit verdict per declined tab. It lists every relevant commit the mock attributes to that tab by tag, plus any committed write of its own that touches by shape. Committed includes commit-then-failed;
- **the service stays at the glove quantity in every committed state, not only the final one (1L).** In each relevant commit's `cartAfter`:
  - the glove keeps exactly its starting number of services;
  - no service exceeds the glove's quantity. The one exception is the glove's previous quantity right after a decrease.

  The service may *trail* the glove, because the storefront updates the glove and then the service in a second write (`src/commerce.js`, quantity update). In the serialized self-test the states really go 2/1, 2/2, 3/2, 3/3. A service raised ahead of its glove (B's nested AddLines leaves glove 1, service 2) or a service-only write above the glove fails, even if a later commit restores 2/2;
- **no committed mutation changed the configuration of BR16 or its service during the race, even temporarily** (1M, `risk:3`). A +1 changes quantities only, so no shopper action in the race authorizes any of these, from any tab, even if a later commit restores them:
  - a different merchandise;
  - different choices (attributes: Break-In Level, wear preference, throwing hand, configuration digest, wrist fit);
  - a different parent;
  - a new line under the glove.

  A quantity write is read only from a quantity change, so an attribute-only change is never mistaken for a repeat. Rewriting the same choices changes nothing and passes;
- **no committed mutation removed the tracked BR16 or its service during the race** (`risk:3`, an application failure). This is decided from `removed` effects (with the request's RemoveLines or quantity-0 lines as a fallback). Removing the glove also removes its service;
- **committed writes to BR16 or its service, from any tab, in commit order (`commitSeq`, taken from the mock's log), only ever raise each line's quantity.** The quantities come from the effects, plus any tracked line a request set to the quantity it already had (a repeat, which changes nothing and so has no effect). A later commit that lowers or repeats a quantity overwrote an increment, whichever request arrived first, including a commit that browser correlation missed. Contradictory writes from one tab and a late service-only overwrite fail;
- for every accepted tap, a **successful write to this cart's BR16 line**. The glove entry is found **by line ID anywhere in the batch**, so a write that lists the service line before the glove line counts. It must appear exactly once (duplicates and contradictory entries fail). The write may touch nothing but that glove and its own service, and any service entry must ask for the glove's quantity. It must come back status 200, committed, with no `userErrors` and a returned cart showing every requested quantity. Writes to another cart or line, service-only writes, failed writes and writes without a returned cart never count;
- the final glove and service keep their **line IDs**, merchandise and choices;
- the accepted taps requested **distinct, consecutive quantities** (2 and then 3). Two taps both asking for 2 is a lost update, whatever the final number.

**Discounts (`discountGate`).** A applies SYNTH5 while B removes SYNTH10. Shopify's codes must equal the start with every confirmed change applied, and each change must be either confirmed or refused by name, never both or neither.

**Invalid checkout URL (`invalidUrlGate`).** The gate takes the Cart reads that had finished when the refusal appeared. The *last* of them (the handoff's final read) must be for this cart, have status 200 and return the injected URL. The refusal must then be new and about opening secure checkout. A generic "being checked", "another tab" or connection message, or one already showing before the tap, does not count. Legitimate handoffs are covered by the held-read scenario and still pass.

**Busy Apply (`busyApplyGate`).** A real tap on Apply while a quantity update's response is held. Two behaviours are correct:
- **(A)** Apply is disabled and nothing is sent.
- **(B)** Apply stays enabled, and the submission is queued and sent **exactly once, after the held update finished** (by log sequence and time), to the active cart, with the submitted code (compared by `codeKey`). Then one of:
  - **success:** the write committed, Shopify holds the code **with `applicable: true`** and no other code, and the final discount message is a success claim, shown only after the commit. Every success claim that names a code must name the submitted one;
  - **committed but inapplicable (1L):** the write committed, and Shopify holds the code with `applicable: false`. No success claim may be shown. After the commit, the storefront's "Discount code isn’t valid for this cart." (or a discount-specific failure) must appear; or
  - **failure:** the write settled without committing, Shopify holds no code, no success claim is ever shown, and the final discount message reports the failure, shown after the write settled. A write the mock committed never takes this branch (1N); or
  - **rejected response (1N):** HTTP 200 with no GraphQL errors or `userErrors`, but the returned cart ID is missing, blank or another cart's. The storefront must refuse it whether or not Shopify committed it. The final discount message is the exact catch copy. Every catch copy in the discount field must be shown at or after the mock finished sending that response (`finishedAt`; 1O), never earlier, and `committedAt` is never used for this. `finishedAt` is set in the handler's `finally` block, after `response.end()` handed the response to the socket, so on the shared host clock it is the earliest moment the browser could have the response. A missing, non-numeric or non-finite `finishedAt`, or one before the write started or committed, is not settlement evidence, and the branch fails. No success claim appears in any field, and no claim names another code. The cart holds exactly what Shopify committed: the submitted code, and no other, if the mock committed the write; no code otherwise. Its applicability does not matter, because the storefront threw before reading it. The response is never credited as accepted.

  The finding verdict's detail records five separate facts (1N): `remotelyCommitted` (the mock's own `commitSeq`), `responseForRequestedCart`, `codePresent` and `applicable` (from the mock's cart), `successClaimed`, and `responseAcceptable` (committed and naming the requested cart). It also records which branch accepted the outcome (`path`) and the settlement time the rejected-response branch used (`responseSentAt`, 1O; `null` without valid evidence).

  **Completion, membership and applicability are separate facts (1L).** A write *settled* once the mock finished it. It *committed* only with HTTP 200, no top-level GraphQL errors and no `userErrors`, plus two independent facts (1M):
  - the mock committed it (a positive integer `commitSeq` in its own log);
  - the response names the requested cart: `returnedCartId` is a string equal to the requested, non-blank `cartId`. `src/commerce.js` `updateDiscountCodes` throws "Shopify returned a different cart." unless `updated.id === cartId`, and `assertCartPayload` throws "Shopify did not return a cart." without one. Both reach the catch copy.

  A missing, `null`, blank or unrelated returned ID, or a `response-forged` entry, is never a committed success, whatever the success text or final applicability says. A remote commit does not make the response acceptable either (1N): `remotelyCommitted` and `writeCommitted` are separate functions, and only `writeCommitted` (remote commit plus the requested cart ID) can support a success claim. HTTP 200 alone never proves success. The outcomes stay separate: HTTP, GraphQL and `userErrors` failures; committed with `applicable: true`; committed with `applicable: false`. Membership (the code is on the cart) and applicability (`applicable: true`) come from the mock's own cart. A success claim needs both. An unverified applicability, or applicability false, is never a success. HTTP 200 with GraphQL errors throws in `shopifyRequest` (code `graphql`), so only the generic catch copy is truthful for it, never the timeout or connection copy. A pending write makes any failure copy premature.

**The storefront's discount feedback contract (as of `d02b89b`).** Read from the source; production code is unchanged. The gate is built on this contract, not on open-ended keywords.

| Path in source | Shopper input and outcome | Exact copy | Field |
| --- | --- | --- | --- |
| `main.js` submit handler | Input is empty after `trim()` | "Enter a discount code." (error; nothing is sent) | discount message |
| `commerce.js` `applyDiscountCode` | Input is trimmed again. A code already on the cart (by `codeKey`) sends nothing and returns the cart | then the success or invalid copy below | discount message |
| `cart-discounts.js` `discountResultFeedback` | HTTP 200, no `userErrors`, and the code is on the cart with `applicable: true` | `` `${code} applied.` `` where `code` is the shopper's trimmed input with its case kept. It is announce-only (visually hidden, `role="status"`) | discount message |
| same | HTTP 200, no `userErrors`, but the code is missing or `applicable: false` | "Discount code isn’t valid for this cart." (error, `role="alert"`) | discount message |
| same, warnings | Success, and no code on the cart is non-applicable | `` `${code} applied.` `` followed by a space and each Shopify warning message, joined by spaces. Warnings are Shopify's free-form text | discount message |
| `commerce.js` `updateDiscountCodes` → `main.js` catch → `commerceErrorMessage(error, 'cart')` | HTTP 200 **with `userErrors`**: thrown as a plain `Error` with no code. Also any HTTP error, a GraphQL error, or "the Shopify cart is unavailable" | "Couldn’t update your cart. Please try again." | discount message |
| same | Timeout (`code: 'timeout'`) | "Shopify is taking too long to respond. Please try again." | discount message |
| same | Network failure (`code: 'network'`) | "Connection lost. Check your connection and try again." | discount message |
| same | The cart changed in another tab (`cart-changed`) | "Your cart changed in another tab. Check your cart before trying again." (a refusal, not a failure report) | discount message |
| remove | A code removed, or not removed | "Discount code removed." / "The discount code could not be removed. Please try again." | discount message |

The announcer (`[data-cart-announcer]`), cart feedback and checkout status are written by cart actions and checkout, never by the discount action. They are still inspected, because any success claim there must not name another code. Codes compare by the storefront's own `codeKey`: `trim()` and then `toLocaleLowerCase('en-US')`. The harness imports it rather than copying it.

**How feedback is classified.** Feedback is classified **statement by statement, in each recorded field separately** (discount message, announcer, cart feedback, checkout status).
- **Success claim.** It is checked in this order:
  1. **The storefront template, matched against the submitted code first.** A statement `<X> applied.` whose `codeKey(X)` equals the submitted code's is a truthful success claim for that code, whatever X looks like: SALE, GO, BR16, freeship, FreeShip. No exclusion list applies to the submitted code.
  2. Any other `<X> applied.` where X is **a single token** that is not a discount noun (discount, code, promo, promotion, coupon) is an explicit claim **for the code X**. In any field, X ≠ the submitted code is a foreign-code claim and fails, even if X is a product name ("BR16 applied." after SAVE20) or an ordinary word ("Changes applied."). Multi-word X ("Discount code applied.", "FREESHIP and SAVE20 applied.") goes to step 3.
  3. **Otherwise (copy that is not the storefront's, such as Task 2 copy or Shopify warnings):** a statement about a discount or a named code that says it was applied, accepted, activated, added, redeemed or saved, with no negation *before* that verb. It counts even beside pending or failure wording ("Discount code applied. Updating your cart…", "Discount code applied, but checkout failed."). These count as named codes:
     - a token mixing letters and digits;
     - a quoted token;
     - the word after *code*, *coupon* or *promo*;
     - an all-capitals word after *discount*;
     - any-case words directly before *applied*, *redeemed* or *activated*, and all-capitals words before *added*, *saved* or *accepted*, including lists;
     - the word after *with* or *using* following a success verb ("Saved 10% with SUMMER");
     - any whole-word occurrence of the submitted code.

     Only this step excludes product models (from the catalog), operation words and a short list of function and commerce words, so "BL50 added to cart.", "Break-in service added to BR16.", "Shaping notes added." and "10% off applied" are not code claims.

  A success claim naming any code other than the submitted one is false, in any field, even when the right code was committed. A generic claim ("Discount code applied.") is accepted only with the verified write and Shopify's final codes.
- **Discount failure.** The final discount message must be one of these. Anything else is an **unsupported shape and fails**:
  - **exact catch copy truthful for this write's outcome:**
    - "Couldn’t update your cart. Please try again." after any failed write: an HTTP error, a timeout, or HTTP 200 with `userErrors`;
    - "Shopify is taking too long to respond. Please try again." or "Connection lost. Check your connection and try again." only after a write that got no successful HTTP response.

    Matching ignores repeated spaces and straight versus curly apostrophes. The same copy after a write that committed successfully, with no write at all, or shown only before the write settled, fails;
  - **a discount-specific failure statement:** for every failure word (not, n't, unable, invalid, failed, unavailable, error, lost, timed out, taking too long, and so on; "try again" is advice, not a report), the gate reads:
    - the **object** of an active verb after it (up to the first preposition or conjunction);
    - the **subject** at the head of its own clause (since the last punctuation or conjunction, up to the first preposition).

    If either names another operation (checkout, shipping, delivery, payment, address, quantity, wrist, Break-In, glove, item, order), or the failure's own clause does, it is that operation's failure. The statement then fails, in either clause order. The statement is discount-specific only when a subject or object **head** is a discount noun or a named code, after trailing auxiliaries, adverbs and *service* are dropped. So "The discount service is unavailable right now.", "SYNTH10 isn’t valid.", "Discount code isn’t valid for this cart." and "We couldn’t apply your discount code." qualify. "Your discount’s image failed to load." and "Image service is unavailable for your discount." do not, because their head is *image*.

  So these fail after a 503: "Image service is unavailable.", "The image network timed out.", "The review network timed out.", "Checkout service is unavailable.", "Shipping network timed out.", "Quantity service unavailable.", "Order network timed out.", "Your discount code was checked and the image network timed out.", "The image network timed out after your discount code was checked.", "Your discount code was checked and shipping failed to load.", "Couldn’t reach Shopify. …", "Something went wrong.", "Service unavailable.", "Your cart is unavailable.".
- **Pending:** "Updating…", "Applying…" and the like. This is neither success nor failure, and never stands in for a result. A failure followed by a final "Updating your cart…" fails.

**Unsupported or ambiguous feedback shapes.** These are rejected (a possible false rejection) or not recognised (a possible false pass). Task 2 copy that needs one of them must change this classifier deliberately, in the same change.
- **Generic failure copy that is not the storefront's catch copy** ("Something went wrong.", "Oops.", "Service unavailable.", "Couldn’t reach Shopify."). It is rejected: truthful new copy should name the discount, or be added to `CATCH_TEMPLATES` together with the source change that emits it.
- **"There was a problem applying your discount."** The discount is neither the subject nor the object of the failure word (*problem*), so it is rejected.
- **Discount failures that also name another operation in the same clause** ("Checkout couldn’t verify your discount code.", "Because shipping failed, your discount couldn’t be applied.") are rejected.
- **`<word> applied.` in any field** is the storefront's code template, so non-discount copy of that shape ("Changes applied.", "Filters applied.") beside a different submitted code is read as a foreign-code claim, and rejected.
- **Shopify warnings appended after `<code> applied.`** are free-form. They are only checked by the heuristic step: a warning that names another code in an unrecognised position ("Enjoy summer savings") is not caught. No guarantee is made about warnings beyond the positions listed.
- **Codes in unrecognised positions:** a lower-case alphabetic code before *added*, *saved* or *accepted* ("freeship added"); a code of one or two letters outside the template ("Discount code GO applied." after SAVE20). These are not recognised.
- **Codes containing a sentence break** ("V2. applied."): statements are split at `.`, `!` and `?`, so the template does not see them.
- **The applicable-false path** is supported since 1L (the committed-but-inapplicable outcome above). It is exercised by synthetic controls and by the browser self-test `(B) queued, code committed but not applicable`, whose mock accepts only SYNTH5.

**Timing.** Every change to those fields is recorded with its time, and the mock records when each write committed (same host clock). **No success claim may come before the discount write committed**, in any wording or field. That includes one shown during the held update, even if the code is later written correctly.

Being enabled is not itself a defect. These are: dropping the tap silently; sending it early, twice or to another cart; claiming success prematurely; claiming success after a failed write; or leaving a pending message in place of a failure report.

**Interrupted split recovery (`splitRecoveryGate`).** After the second split write fails and the shopper recovers, the recovered cart must hold both BR16 gloves with their own services and instructions: **either exactly as they were before the edit, or exactly as edited**. It must also pass every pairing invariant.

**Races.** The first write is held before it commits, and the second tab acts. The harness waits until that action has visibly started (a request from that tab, a busy indicator, a queued marker or a new alert). It gives the action a bounded 2-second window to send its own write, then releases the first write *whether or not the second one arrived*. A storefront that serializes operations passes through the same path as one that sends both; only the final state decides. Each run records the interleaving in `diagnostics`.

## Self-tests

Every self-test check is a `harness` check, so a self-test failure is exit 2.

- **Synthetic gate self-test** (`harness self-test: gates reject false passes and accept correct outcomes`). This scenario feeds fixed observations to the gates, the refusal classifier, the tap-delivery decision, the pairing helper, the correlator and (since 1L) the real fixture: 377 checks in all. Counted by the check name's `accepts:`/`rejects:` prefix, 104 must be accepted, 219 must be rejected, and 54 are other harness checks (refusal and delivery decisions, correlator lifecycle, request capture, recorded mock effects, single-verdict mock checks).
  - **Task 1D:** 34 controls, each added *before* its gate was corrected. Run against the Task 1C gates, 19 failed; all pass now.
  - **Task 1E:** 21 controls, added the same way. Run against the Task 1D gates, 8 failed, including the batched service-first positive control and the premature-success negative control; all pass now.
  - **Task 1F:** 10 busy-Apply feedback controls. Run against the Task 1E gate, 7 failed: six false passes and one false rejection of other truthful success wording. All pass now.
  - **Task 1G:** 10 mixed-feedback controls and 8 tap-delivery controls, plus 4 browser tap checks (`harness self-test: tap requires observed delivery`). Run against Task 1F behaviour, 16 failed:
    - feedback counterexample (A) twice, (B) twice and (C);
    - three related feedback cases;
    - four delivery decisions;
    - all four browser checks.

    All pass now. The browser checks cover a normal enabled tap (delivered, control activated), a press swallowed before the harness can see it (harness error), and an implicit and an explicit press on a disabled control.
  - **Task 1H:** 33 synthetic controls (22 negative, 11 positive) and 2 browser tap checks, for four independently reproduced false passes. Run against the Task 1G gates, 18 failed: 16 synthetic and both browser checks. All pass now.
    - **Discount failure action** (4 negative, 3 positive). Rejected: "Checkout failed while checking your discount code." after a 503 and after `userErrors`; a shipping failure and a payment failure that mention the code. Accepted: "Discount code SYNTH10 couldn’t be applied.", "We couldn’t apply your discount code.", "The discount service is unavailable right now." Before: all 4 negatives passed.
    - **Discount code identity** (5 negative, 2 positive). Rejected: "Discount code SAVE20 applied." (and lower case `save20`) after SYNTH10 committed; "SAVE20 applied" in the announcer beside a correct message; "SYNTH10 and SAVE20 applied."; a generic claim with no code in Shopify. Accepted: `synth10` in lower case; "Discount applied to BR16." Before: 4 of the 5 negatives passed.
    - **Pointer delivery** (5 negative, 3 positive, plus 2 browser checks). Rejected: click with no observed pointerdown; click on target after pointerdown elsewhere; listeners not confirmed before dispatch; an explicit disabled press that activated the control; a control disabled by pointerdown time without an explicit press. Accepted: both events with confirmed listeners; an explicit press whose pointerdown reached the disabled control; an explicit press on a control disabled by pointerdown time. In the browser, a page that swallows only pointerdown is a harness error, and a normal tap reports `installedBeforeDispatch`. Before: 3 of the 5 negatives passed, one positive was falsely rejected, and both browser checks failed.
    - **Declined +1 and quantity intent** (8 negative, 3 positive). Rejected:
      - B recorded as disabled, but B committed quantity 3, which A's quantity 2 overwrote;
      - the same with a named refusal;
      - a disabled B that committed a service-only write;
      - B "refused" by a stale message, or by a generic warning;
      - B's contradictory writes (3, then 2);
      - A's late 2 overwriting B's 3;
      - broken service parity.

      Accepted: B not offered with nothing committed; B refused by a fresh named message with nothing committed; A 2, then B 3. Before: 4 of the 8 negatives passed.
  - **Task 1I:** 44 synthetic controls (27 negative, 17 positive) and 1 correlator lifecycle check, for three independently reproduced acceptance failures. 41 of them, the lifecycle check included, were added before any gate change. Run against the Task 1H gates, 26 failed. All pass now. The 4 others came from probing the first corrected classifier: "Checkout couldn’t verify your discount code." and "Order total couldn’t include your discount." were accepted as discount failures there (the Task 1H gate rejected them), so the subject and the object are now both checked.
    - **Failure operation** (11 negative, 8 positive). Rejected, after a 503 or `userErrors`:
      - "Couldn’t load shipping for your discount." (twice);
      - shipping, checkout, quantity and order failures that mention the discount or the code;
      - "Discount error: shipping is unavailable.";
      - "Shipping couldn’t be loaded. Try again.";
      - "Checkout couldn’t verify your discount code.".

      Accepted: "Discount service unavailable.", "Discounts are temporarily unavailable. Try again.", "Couldn’t apply your discount. Service unavailable.", "Unable to apply discount code SYNTH10 right now.", "Discount code isn’t valid for items in your cart.", an all-capitals failure, "Your discount couldn’t be applied to shipping." and "Promo code service unavailable.". Before: 8 of the 9 original negatives passed.
    - **Alphabetic codes** (10 negative, 5 positive). Rejected:
      - "Discount code FREESHIP applied." after SAVE20;
      - bare "FREESHIP applied" in the announcer beside a correct message;
      - "FreeShip" (mixed case) in the cart feedback;
      - "Code   freeship   applied" in the checkout status;
      - "FREESHIP applied." as a second statement;
      - a quoted “FREESHIP”;
      - "FREESHIP and SAVE20 applied.";
      - "FREESHIP applied." with no code in Shopify, after a 503, and before commit.

      Accepted:
      - the storefront's own "FREESHIP applied.";
      - the same with odd spacing;
      - lower-case "Discount code freeship applied.";
      - "Discount applied to BR16.";
      - BL50, ANAWIN, Break-In service and saved-selections copy beside the claim.

      Before: 6 of the 10 negatives passed, and 3 of the 5 positives were falsely rejected.
    - **Commit order** (6 negative, 4 positive, 1 lifecycle). Rejected, by the ordering verdict itself:
      - A's 2 arriving first but committing after B's 3, with B not offered, accepted, or refused by name;
      - two commits with no commit sequence;
      - A's late service-only 2 after B's 3;
      - the not-offered case again, through the real correlator.

      Accepted:
      - B's 3 arriving first but committing after A's 2 (synthetic and through the correlator);
      - B refused by name, its write received and rejected with `userErrors`;
      - B not offered with no write.

      The lifecycle check requires that the correlator labels committed, rejected, received-but-not-attempted and never-received writes. Before: all 6 negatives and the lifecycle check failed, and both opposite-order positives were falsely rejected.
  - **Task 1J:** 49 synthetic controls (30 negative, 19 positive) for three independently reproduced false-pass categories. 47 were added before any gate change; run against the Task 1I gates, 32 failed. The other 2 are positives added after probing the corrected classifier ("Changes applied.", "10% off applied" and "saved with your account" were read as codes). All pass now.
    - **Clause and action context** (13 negative, 8 positive). Rejected:
      - "Your discount code was checked and shipping failed to load." (after a 503 and after `userErrors`), and the same with checkout, quantity, order and image;
      - "Shipping failed to load after your discount code was checked.";
      - unrelated discount-field copy: "Your cart is unavailable.", "Image unavailable.", "Reviews are temporarily unavailable.";
      - "Something went wrong.", "Connection lost." and "taking too long" after `userErrors`.

      Accepted:
      - "Couldn’t update your cart." (the storefront's real 503 copy), "Something went wrong." and "Connection lost." after a 503;
      - "taking too long" and "Connection lost." after a timeout;
      - discount failures in either clause order;
      - "…because it expired.".

      Before: 9 negatives passed, and 3 positives (the real connection and timeout copy) were falsely rejected, because *lost* and *taking too long* were not failure words.
    - **Case-insensitive codes** (7 negative, 7 positive). Rejected, after SAVE20:
      - bare "freeship applied" in the announcer, and "FreeShip applied." in the cart feedback;
      - "freeship redeemed" in the checkout status;
      - "freeship applied." as a second statement;
      - "save20 and freeship applied.";
      - a Shopify warning "Saved 10% with SUMMER" appended to the confirmation;
      - "Saved 10% with summer" in the announcer.

      Accepted: the storefront's "freeship applied." for a lower-case entry, "FreeShip applied.", odd spacing, "SUMMER applied. Saved 10% with SUMMER", product, service and selection copy, ordinary words before a success verb, and "saved with your account". Before: all 7 negatives passed, and 4 of the first 5 positives were falsely rejected.
    - **Complete commit correlation** (10 negative, 4 positive). Rejected:
      - B's tagged commit of 3 present only in the mock log, then A's 2;
      - B's request tag differing from its mock entry;
      - an untagged commit;
      - two requests sharing a tag;
      - a request whose `commitSeq` differs from the mock's;
      - B "accepted" with its write seen as rejected while the mock committed it;
      - a single commit with no `commitSeq`, with 0, and a fractional one;
      - no mock log supplied.

      Accepted:
      - consistent tags with B not offered;
      - B arriving first but committing second;
      - B refused with a rejected (never committed) write;
      - unrelated commits to another cart or line.

      Before: 9 of the 10 negatives passed. The other, "accepted but seen as rejected", was rejected only incidentally, by the accepted-write checks. Each rejection now comes from the correlation verdict (a `harness` verdict) and, where applicable, the ordering verdict.
  - **Task 1K:** 41 synthetic controls (28 negative, 13 positive) for four independently verified blockers, all added before any gate change. Run against the Task 1J gates, 27 failed, each on its intended verdict. All pass now. Each rejection was checked to fail its intended verdict: the busy-Apply outcome for failure copy, plus the foreign-code verdict for wrong codes, and the named audit verdict for removals.
    - **A, real `userErrors` catch copy** (3 negative, 1 positive). Accepted: "Couldn’t update your cart. Please try again." after HTTP 200 with `userErrors` "Discount unavailable". Rejected: the same copy after a committed successful write, with no write, and shown only before the write settled. Before: the positive was falsely rejected.
    - **B, exact catch templates only** (14 negative, 3 positive). Rejected after a 503 or a timeout: image, review, checkout, shipping, quantity and order "service unavailable" and "network timed out" copy, in either clause order; "Your discount’s image failed to load."; "Image service is unavailable for your discount."; "Couldn’t reach Shopify. …"; "Service unavailable.". Accepted: the catch copy after a 503, the timeout copy after a timeout, and "The discount service is unavailable right now.". Before: 10 of the 14 negatives passed.
    - **C, exact code match first** (5 negative, 7 positive). Accepted: "SALE applied.", "Sale applied.", "BR16 applied.", "GO applied." and "go applied." for those submitted codes; "GO applied." followed by a Shopify warning; "SAVE20 applied." beside "BL50 added to cart.". Rejected after SAVE20: "SALE applied." (announcer), "BR16 applied." (checkout status), "go applied." (cart feedback), and "SAVE20 applied. GO applied."; "BL50 applied." after a code named BR16. Before: 6 positives were falsely rejected and 4 negatives passed.
    - **D, RemoveLines and AddLines audit** (6 negative, 2 positive). Rejected, each by its named verdict:
      - B's committed service removal present only in the mock log (correlation);
      - a not-offered B that committed a service removal (declined);
      - a committed glove removal (removal verdict);
      - a removal with no `commitSeq` (correlation);
      - an UpdateLines and a RemoveLines sharing a tag (correlation);
      - a not-offered B that nested another service under the glove (declined).

      Accepted: an unrelated, tagged removal of another line; 2/2 then 3/3 with everything audited. Before: all 6 negatives passed their named verdicts.
    - **Earlier controls changed deliberately to match the source contract:**
      - 1F's connection message is now the storefront's real "Connection lost. Check your connection and try again." ("Couldn’t reach Shopify…" is not source copy and is now a 1K negative);
      - 1J's "Something went wrong." after a 503 is now expected to be rejected (not source copy);
      - 1J's ordinary-words positive keeps "10% off applied". "Changes applied." beside another code is now a negative, because `<word> applied.` is the code template and CHANGES is a valid code value.
  - **Task 1L:** 48 synthetic and mock-level checks (18 must be accepted, 27 must be rejected, 3 others) for four independently reproduced blockers. The 40 synthetic controls were added before any gate change. Run against the Task 1K gates, 20 of them failed, each on its intended verdict. After blockers 1–3, 335 of 342 passed, and the 7 failures were exactly the blocker 4 controls. All pass now, including 8 mock-level checks added with the blocker 4 correction. Each nested AddLines rejection uses `expectOnly`: the run fails unless *every* failing verdict is one of the named audit verdicts, so an unrelated final-state assertion can never be the reason.
    - **1, committed but inapplicable discounts** (4 positive, 8 negative). Accepted: the not-valid copy after a committed write that left SAVE20 `applicable: false`; "SAVE20 applied." with `applicable: true`; the catch copy after `userErrors`, and after a malformed HTTP 200 with no cart. Rejected: "SAVE20 applied." with `applicable: false`, or with applicability unverified, or after a malformed response; the not-valid copy before the commit, or when the code is missing from the cart; the catch copy after an inapplicable commit; the not-valid copy or the catch copy while the write is still pending. Before: 5 failed (2 positives falsely rejected, 3 negatives passed).
    - **2, HTTP 200 with GraphQL errors** (2 positive, 4 negative). Accepted: the catch copy after the write settled, and after a 503. Rejected: the catch copy shown only before settling; "SAVE20 applied."; the connection-lost copy (Shopify did answer); the catch copy after a successful commit. Before: the settled positive was falsely rejected.
    - **3, code identity by `codeKey`** (7 positive, 4 negative). Accepted: typed `sAlE`, `gO`, `bR16`, `FreeShip`, `SaVe20` and `"  SaVe20 "` with Shopify's upper-case spelling, and discount-gate case variants. Rejected: a foreign "GO applied." in the announcer; Shopify holding SALES; the write sending SALE2; an unrelated code removed under an apply-only confirmation. Before: all 7 positives were falsely rejected.
    - **4, nested AddLines** (11 synthetic, 8 mock-level).
      - Reproduced: A's UpdateLines arrives first and is held. Disabled or refused B's tagged nested AddLines commits glove/service 1/2, and A later commits 2/2. With the parent given by line ID or by merchandise, the Task 1K gate passed every verdict (`failing: []`), because the CDP capture dropped `parent` and `merchandiseId` and the audit read only the request's shape.
      - Rejected (7): the four nested cases (two forms × not offered or refused), each by the declined-tab verdict and the per-state pairing verdict, with correlation passing; A's service-only 3 later restored to 2/2 (per-state pairing and overwrite); a commit whose tagged request is another operation (harness audit); a committed line mutation with no recorded effects (harness audit).
      - Accepted (3): the storefront's glove-then-service sync with effects; rebased 2/2 then 3/3; a refused B whose nested AddLines was rejected and never committed.
      - Capture (1): the CDP capture keeps `parent` and `merchandiseId`.
      - Before: the 4 nested negatives, the operation and effects negatives, and the capture check failed.
      - **Mock level (8, new).** Both nested forms run against the real fixture (`createStorefrontMock`). Each request is logged as the server logs it, captured by `requestLinesOf` and correlated by `correlateRequests`. Checked: the fixture records B's add as raising the service under the glove from 1 to 2 (and A's glove to 2/2); not-offered and refused B are rejected only by the audit verdicts; a serialized glove-then-service 2/2 then 3/3 is accepted, as is a refused B with nothing sent.
    - **Earlier controls given effects deliberately (1L).** The gate now requires committed effects. In 1L, pre-1L controls got theirs from a `replayEffects` helper, a second implementation of the effect calculation. **1M replaced it** (see below).
  - **Task 1M:** 28 synthetic and mock-level checks (6 accept, 19 reject, 3 others) and 2 real-storefront self-test scenarios, for three independently reproduced evidence gaps. All were added before any gate change. Run against the Task 1L gates, 19 synthetic checks and 1 browser check failed (359/378 and 28/29). All pass now, each on its intended verdict; the rejections use `expectOnly` or a single-verdict check.
    - **A, commit evidence** (1 positive, 9 evidence negatives, 1 complete-log negative, 2 rekey checks). They start from the real fixture's serialized race 2/1 → 2/2 → 3/2 → 3/3, which is accepted untampered. Each of these must fail the harness evidence verdict alone:
      - the service effect of a commit deleted, leaving `effects: []`;
      - an effect's before quantity set to 99;
      - an effect's merchandise ID changed;
      - the glove line listed twice in `cartAfter`;
      - a service parented to a line that does not exist;
      - a line without an ID;
      - a spurious effect for an unchanged line;
      - a missing `cartBefore`;
      - a `cartBefore` that is not the previous commit's `cartAfter`;
      - a rejected nested AddLines in the log that no browser request sent.

      A real rekeying fixture commit (`rekeyOnQuantityUpdate`) passes the evidence verdict; a rekey from a line ID that never existed fails it. Before: the four reported manipulations, the missing and inconsistent `cartBefore`, the false rekey and the orphaned entry all passed outright (`failing: []`). The bad parent and the spurious effect failed only incidentally, on application verdicts (per-state pairing and overwrite), not as evidence errors.
    - **B, attribute changes** (1 capture check, 3 negative, 1 positive), on the real fixture. Rejected by the configuration verdict:
      - A changes the service's Break-In Level, restores it, then +1 to 2/2;
      - A changes the glove's wearing style, restores it, then +1;
      - refused B changes and restores the service's level while A goes to 2/2 (also rejected by the declined verdict).

      Accepted: the choices rewritten unchanged, then +1. The fixture must record an attribute-only change as an effect. Before: the fixture recorded no effect (`effects: []`), and both A cases passed.
    - **C, discount response cart ID** (4 positive, 6 negative). Rejected, beside a truthful "SAVE20 applied." and an applicable code: a response with no cart ID, `null`, a blank ID, or an unrelated cart's ID; no commit in the mock log; and the not-valid copy with an unrelated cart ID. Accepted: an honest response naming the requested cart (also with typed `sAvE20` and Shopify's SAVE20); an unrelated cart or no cart, with nothing committed and the catch copy. Before: 5 negatives passed (all but `null`), and the honest unrelated-cart refusal was falsely rejected.
    - **Browser, real storefront:** `(B) queued, response for an unrelated cart` and `(B) queued, response with no cart` (via `forgeNext`). The storefront shows "Couldn’t update your cart. Please try again.", Shopify holds no code, and the gate accepts the failure. Before: the unrelated-cart run failed the gate (28/29), because a mismatched ID counted as committed. After: all 99 checks of the seven busy-Apply self-tests pass.
    - **Earlier controls changed deliberately (1M):**
      - `replayEffects` is gone. Pre-1M controls that describe a commit by its request only now get their evidence from `fixtureEvidence`, which replays those requests in commit order on the **real fixture**. The cart starts as BR16 `p1` with service `s1`, plus one unrelated OB16 line for each other line ID a case names. The fixture's own `cartBefore`, effects and `cartAfter` are attached, mapped back to the case's IDs. A case the fixture rejects is an error. The 1L controls' hand-written effects are replaced the same way, so no control carries a hand-computed effect set;
      - an entry marked `asWritten` keeps the evidence its case wrote. Only the 1L missing-effects control uses it;
      - the 1L mock check of B's nested add now reads the 1M view shape (quantity 1 → 2, nothing else changed);
      - synthetic discount writes carry the `commitSeq` and returned cart ID the real mock would give for their outcome.
  - **Task 1N:** one blocker, reproduced independently: Shopify commits `sAvE20` (applicable:true), but the HTTP 200 response names an unrelated cart. The storefront refuses it and shows "Couldn’t update your cart. Please try again.". The 1M gate falsely rejected that truthful outcome, because its failure branch required an empty discount list. The same happened with blank and omitted returned IDs. 40 synthetic checks and 10 real-storefront self-test scenarios were added before the gate change.
    - **Synthetic matrix, on the real fixture** (15 gate cases, each with a fixture check that the code was saved only if committed, with the right commit count). Committed with a matching ID: success accepted, catch copy rejected. Committed with an unrelated, blank or omitted ID: catch copy accepted, "sAvE20 applied." rejected. Not committed, unrelated ID: catch accepted, success rejected. Not committed, ordinary HTTP 503: catch accepted, success rejected. Shopify spelling SAVE20 with an unrelated ID: catch accepted, success rejected. Committed but applicable:false with an unrelated ID: catch accepted.
    - **Integrity negatives** (10, each on the finding verdict). All start from a committed write with an unrelated ID and the catch copy. Rejected when: the committed code is missing from the saved cart; another code is on the cart; the write was sent twice, or before the held update finished; the copy appeared only before the write settled; the announcer claimed success; the copy was the connection-lost copy, another operation's failure, or nothing at all; or the write is still pending.
    - **Browser, real storefront** (via `forgeNext` `commit-then-substitute`, `acceptedCodes: ['SAVE20']`, typed `sAvE20`). Accepted: committed with a matching response, and committed with an unrelated, blank or omitted response ID. Each forged run also checks the fixture's own record: one write, `commitSeq`, the saved `sAvE20`, the requested cart ID before substitution, and the cart still holding it. Not committed: an unrelated response ID, and an ordinary HTTP 503. Rejected, as checks that the gate rejects: the `CLAIM_SUCCESS_AFTER_CATCH` shim, which turns the catch copy into "sAvE20 applied.". It runs in four false-success scenarios: after each of the three committed wrong-ID responses (unrelated, blank, omitted), and after the uncommitted unrelated one.
    - **Before** (Task 1M gate, new controls only): synthetic 412/418. Five truthful committed wrong-ID cases were falsely rejected: unrelated, blank, omitted, Shopify spelling, and applicable:false. One integrity negative passed (a committed write whose code is missing from the cart was accepted by the failure branch). Busy-Apply browser: the committed unrelated, blank and omitted scenarios failed the finding verdict. **After:** synthetic 418/418; busy-Apply 247/247 across 17 scenarios.
    - **Gate change:** `remotelyCommitted` (the mock's commit) is split from `writeCommitted` (that commit plus the requested cart ID), which keeps its 1M meaning. The failure branch now excludes remote commits. A new rejected-response branch (see "Busy Apply") accepts only the catch copy, and only with the cart holding exactly what was committed. The finding verdict's detail records the five facts and the accepting branch. No other gate changed.
  - **Task 1O:** one false pass, found by the independent 1N review: the rejected-response branch timed its feedback from `committedAt ?? finishedAt`. A remote commit does not mean the storefront has the substituted response, so the catch copy shown at `committedAt`, while the response was still being sent (`finishedAt` = `committedAt` + 1), passed. The original browser runs never showed premature feedback. 39 synthetic checks were added before the gate change.
    - **Timing controls** (13, on the real fixture; commit at 1150, response sent at 1160). Rejected: the copy before the commit; at the commit; between the commit and the response; at the commit and again after the response; no `finishedAt`; a string, non-finite, before-commit or before-start `finishedAt`; "sAvE20 applied." after the response; the reported shape (committed at t, sent at t + 1, copy at t). Accepted: the copy exactly at `finishedAt`, and after it.
    - **Deterministic replay** (26) of the six saved 1N full-run observations of the committed unrelated, blank and omitted scenarios (runs `1be33a54` and `2351a0a0`), extracted from their `results.json`. Each is accepted as recorded and with the copy moved exactly to `finishedAt`. Each is rejected with the copy 1 ms before `finishedAt`, and with `finishedAt` missing. The two observations where `finishedAt` is 1 ms after `committedAt` are also rejected with the copy at `committedAt`.
    - **Before** (1N gate, new controls only): 438/457. Exactly the 19 rejection controls that depend on settlement passed when they should fail; every accept control passed. **After:** 457/457. Busy-Apply on the real storefront: 247/247, unchanged.
    - **Gate change:** in the rejected-response branch only, `responseSentAt` (a valid `finishedAt`, or none) replaces `committedAt ?? finishedAt`. Every catch-copy event in the discount field must come at or after it. The success, not-applicable and failure branches are unchanged.
  - **+1 controls run through the real correlator:** from a synthetic browser request and mock log to the gate.
  - **Accepted:**
    - both gloves once in one cart;
    - a named refusal with nothing committed;
    - recovery into one distinct verified cart;
    - +1 writes requesting 2 then 3;
    - batched +1 writes listing the service line first or the glove line first;
    - a queued Apply whose write failed or returned `userErrors`, followed by truthful failure feedback (including the storefront's own rejection copy and a connection-failure message);
    - other success wording shown only after commit;
    - one named quantity refusal;
    - consistent discount outcomes;
    - split recovery as it was, or as edited;
    - the final read returning the injected URL, followed by the URL refusal;
    - busy Apply (A) disabled, and (B) queued and sent once after the held update;
    - well-formed trainer and left-hand MI26 pairs.
  - **Rejected, first add:**
    - nine orphaned copies beside one correct active copy;
    - one orphaned duplicate;
    - a glove stranded behind generic warnings;
    - a named refusal after an orphan commit;
    - a false "added";
    - a duplicate;
    - the wrong configuration;
    - a refusal contradicted by the cart;
    - recovery that reuses the source, creates an extra cart, doubles a quantity, starts from the wrong cart, or drops or duplicates merchandise.
  - **Rejected, +1:**
    - a write to another cart;
    - a write with `userErrors`;
    - both taps requesting 2;
    - a "BR16 was not removed" warning;
    - a lost update;
    - the service left at 2;
    - changed choices;
    - a refused tap applied anyway;
    - an accepted tap with no successful write;
    - batched writes to another cart or another glove, the glove listed twice or with two quantities, service-only writes, `userErrors`, a failed write, no returned cart, a stale quantity 2, the service at a different quantity than the glove, an unrelated extra line, and a service line replaced by a new line.
  - **Rejected, refusal classifier:**
    - generic, stale, naming another item, or no retry;
    - "not removed" or "not added" offered as an increase refusal.
  - **Rejected, discounts:** a lost removal, a lost apply, confirmed-and-refused, and neither.
  - **Rejected, checkout URL:**
    - the injected URL from an earlier read;
    - the injected URL from another cart's read;
    - a failed final read;
    - a generic checkout alert;
    - a stale refusal.
  - **Rejected, busy Apply:**
    - a silently dropped tap;
    - a send before the held update finished;
    - two sends;
    - a false success;
    - "applied" announced during the held update or before the write committed, even when the code is later written correctly;
    - a failed write with no feedback;
    - a write to another cart;
    - a disabled Apply that still announced "applied";
    - "Discount code applied." during the hold, or in the announcer before commit;
    - "Applying SYNTH10…" left on screen after a 503, after `userErrors`, or after success;
    - "Discount code applied." after a 503 or after `userErrors`.
  - **Rejected, pairing:**
    - a standalone trainer service, even marked `none`;
    - a standalone full-size service;
    - a glove variant as the service child;
    - the full-size variant on a trainer;
    - lost or mismatched choices;
    - a service under CL16;
    - a missing parent;
    - quantity mismatch;
    - the wrong throw hand;
    - shaping that no longer matches the configuration digest;
    - a lost firmness;
    - duplicate line IDs.
  - **Rejected, split recovery:** a lost TIP service, and lost TIP instructions.
- **Fault preservation** (`harness self-test: faults survive mid-scenario resets`). The test sends the mock a deliberately unmodelled request carrying a per-run marker, then resets the mock mid-scenario. It requires that the fault is kept in the run's infrastructure record and in the mock's cumulative fault log, and the end of the run requires that it appears in the final results.
- **Browser positive self-tests** use test-only page shims that stand in for correct implementations. Production code is unchanged. Each must pass its whole gate.
  - **Discount, first add, and quantity-plus-discount** use `SERIALIZE_CART_LOCK`: cart operations take the storefront's lock exclusively. These must also really have serialized the writes.
  - **+1** uses `SERIALIZE_CART_LOCK` plus `QUEUE_AND_REBASE_STEPPER`: a tap that finds the lock taken waits, checks the cart, then replays on Shopify's current quantity. This must also really have serialized the writes.
  - **Busy Apply (A)** uses `DISABLE_APPLY_WHILE_BUSY`, and **busy Apply (B)** uses `QUEUE_APPLY_WHILE_BUSY` (the submission is queued while busy and replayed once the cart is idle).
  - **Busy Apply (B), 1L outcomes:** the same queued shim against the real storefront formatting for a code committed but not applicable (mock accepts only SYNTH5), mixed-case input ` sYnTh10 ` with Shopify's own spelling (`codeCase: 'upper'`), and HTTP 200 with GraphQL errors. Against the Task 1K gates, 4 of these three scenarios' 43 checks failed. In 1L, all 71 checks of the five busy-Apply self-tests passed.
  - **Busy Apply (B), 1M forged responses:** a response for an unrelated cart and a response with no cart (see Task 1M).

Negative controls are synthetic on purpose. A browser-level "known bad" control would depend on today's defects and would turn into a harness fault once Task 2 fixes them.

## Break-In pairing (`pairingIssues`)

The shared helper checks every invariant as a list of issues, and every Break-In scenario uses it:
- line IDs are unique;
- each service sits under an existing glove marked `_anawin_service: break-in`, and no service variant ever appears as a top-level line, whatever its attributes (a "standalone" service marked `none` included);
- a glove's child must be a service variant, never another glove;
- each service is the variant for its glove type: `gid://variant/service` for trainers, the full-size service variant for full-size gloves;
- service and glove quantities are equal;
- trainer services carry the same Break-In Level and Wearing Style as the glove's `_anawin_*` choices;
- full-size services name the glove model and the **variant's** throw hand, and the glove's `_anawin_configuration` equals the digest of the service's choices. The digest is recomputed with the storefront's own `fullSizeConfiguration`, so this proves glove and service agree, not that the digest algorithm is right;
- there is at most one service per glove;
- there is no service under an unmarked glove;
- there are no leftover choices on a glove marked `none`.

Recovery and reload checks also compare `configuration()`: merchandise, quantities, service lines and every attribute, without line IDs. Re-key scenarios first prove the mock actually changed the IDs, and the CL16 exclusion check first requires CL16 to be in the cart.

## Coverage

Viewports: 320×568, 320×640, 390×844, 768×1024, 1440×900.

| Area | Scenario(s) | What is asserted |
| --- | --- | --- |
| A. Viewport and layout | `viewport layout and hit targets` | **Cart:** BR16 and MI26 with service, OB16 ×2, a long note, SYNTH10. **Controls:** each viewport requires the expected count of every control before measuring. Close and the first row's steppers are visible before any scrolling. No overflow. Each control is 44×44, inside the drawer, hit-tests to itself at its centre and four edges, receives real pointer presses (observed and cancelled), and overlaps nothing. Steppers stay in their column. **Editor and collapsed panel:** the same checks in the service editor. Collapsed panel: checkout on screen, at least 120px of rows, and checkout reachable by scrolling and a real tap. **Keyboard:** Tab stops are on screen and visibly focused. |
| B. Products and Break-In | `PDP Break-In totals…`, `trainer Break-In…`, `split edit…`, `pairing survives…`, `Break-In partial failure…`, `Break-In failure between split-edit operations`, `legacy carts…` | **PDP:** $295; $295 + $75 = $370 with a valid service; an unavailable service is disabled and not priced in. **Exact identity** across edit, quantity (with the storefront's own service update), remove and add-back. **Split edit:** the original line keeps its ID and choices. **Full-size:** identical MI26 variants with different shaping; left-hand; reload. **Re-keying** is proven first. **Failures:** commit-then-fail and failure on the second split write require an error, blocked checkout, explicit Check cart and recovery controls, and a recovered cart with the right gloves and pairing. **Legacy:** recovery to exactly one BR16 without service. |
| C. Discounts | `discount apply…`, `discount updates overlapping…` (+ self-test) | **Single tab:** rejection, removal, one update for tap+tap+Enter, case-insensitive re-apply, totals, focus. **Two tabs:** `discountGate`. Checkout after the overlap hands off only the displayed cart. |
| D. Checkout handoff | `checkout handoff: held read…`, `checkout refuses invalid…`, `active mutation versus checkout…`, `cart change in another tab…`, `frozen cart…`, `preorder checkout handoff…`, `Web Locks unavailable…` | **Held read:** five presses, one navigation, the exact origin, path and query of the final read, and a fresh URL. **Invalid URLs:** five types, on first render and on the final read only. For the final-read case: checkout must be offered; the mock log must show the handoff's Cart read returning the injected URL; then a *new* visible checkout message must appear; then no navigation. After that, Check cart and a valid URL lead to one handoff. **Also covered:** active mutations in the same tab and across tabs; stale-tab review. **Frozen cart:** visible in a new tab; a tab that loaded the cart before the freeze cannot change it; no write targets it; recovery copies its exact configuration. **Preorder:** the estimate is written before navigating; an unconfirmed estimate is blocked with a visible row notice. **No Web Locks:** checkout is refused with a message. |
| E. Concurrency and failures | `simultaneous first add…`, `overlapping +1…`, `overlapping quantity and discount…` (each + self-test), `timeouts and connection failures`, `storage denial and expired cart` | The three gates above, and quantity and discount at once both persisting. Failure before commit, commit-then-timeout (one write, no retry, Check cart and recovery) and timeout before commit. Denied safety storage sends nothing. An expired cart is replaced. |
| F. Accessibility | `keyboard drawer navigation…` and area A | **Keyboard and semantics:** keyboard open focuses Close; labelled modal; inert background; Shift+Tab wraps; focus kept and restored; announcements; labels and `aria-*`; polite status; Escape; reduced motion; error alerts. **Busy controls:** controls are disabled while busy. A real tap on Apply during a held quantity update must either find Apply disabled (nothing sent, no code), or be queued and then applied exactly once with a truthful "SYNTH10 applied." Success may never be announced for a code Shopify lacks. |

## Reproduced application defects (as of `d02b89b`)

Measured with Chrome for Testing 150.0.7871.24, Node v22.22.3 and real Arial on Ubuntu 26.04 (WSL 2, kernel 6.6.114.1). Production code was not changed. These failures are expected until Phase 6 fixes them, and they are why the suite exits 1.

1. **risk:1, quantity stepper overlaps the price column at 320px.** On Break-In rows the 44×44 `+` extends 25px past `.cart-item-info`. Its right edge hit-tests to `div.cart-item-side` and misses real pointer presses. Cause: `src/style.css:287-290` with `src/cart-row.js:216`.
2. **risk:5, short screens squeeze the rows.** At 320×568 with the panel collapsed, the rows get 64px (84px at 320×640). Checkout starts below the fold. Cause: `max-height:72dvh`, `src/style.css:257`.
3. **risk:2, overlapping discount apply/remove loses an update.** Both tabs confirm their change, but Shopify ends with `[SYNTH10, SYNTH5]`, so the removal is lost. Only generic warnings appear. Cause: `applyDiscountCode`/`removeDiscountCode` send a full list computed from an earlier read, under a shared lock.
4. **risk:3, simultaneous first add strands a glove in an orphaned cart.** Shopify creates two carts. Usually the active one has OB16 and BR16 is committed to the orphan, and the storefront offers recovery. Neither tab names it. Cause: the second `cartCreate` is rejected locally as `cart-changed` after Shopify created it. Which glove loses depends on timing. In one 1L full run the roles were swapped: OB16 was stranded and no recovery was offered. Four focused repeats then stranded BR16 again. Either way it is the same failing check family.
5. **risk:3, two overlapping +1 taps lose one.** Tab A commits glove 2 and service 2. Tab B sends **no write at all** and shows only "Your cart changed in another tab"; its tap is silently dropped, and Shopify ends at 2. Cause: the tap becomes an absolute quantity from the displayed cart (`src/main.js`, `line.quantity + delta`), and the stale tab abandons it without a named refusal.
6. **finding, Apply tapped while another cart update is in flight is silently dropped.** Apply stays enabled, but the tap does nothing and shows nothing, and the code is never sent. (Being enabled is allowed if the tap is queued. It is the silent drop that fails.) Cause: `discountAction` returns early on `cartBusy` (`src/main.js`), and the inputs are disabled only during discount requests (`src/cart-discounts.js`).

Known risk 4 (Break-In pairing) did not reproduce under the strict pairing helper. The 1L per-state pairing verdict also passes on the unmodified storefront: tab A commits glove 2, then service 2, and tab B sends nothing.

## Verification evidence (Task 1O, base `d02b89b` plus uncommitted harness files)

Raw logs, results, commands and runner prerequisites: `/home/anawin/projects/anawin-agents/phase6-1o-verification` (see its `README.md`).

| Check | Result |
| --- | --- |
| Focused synthetic self-test (`ANAWIN_PURCHASE_ONLY='gates reject false passes'`) | Before the 1O fix: 438/457, exit 2 (the 19 failures are exactly 1O rejection controls). After: **457/457**, exit 0. |
| Busy-Apply self-tests (`ANAWIN_PURCHASE_ONLY='busy Apply [harness self-test'`, 17 scenarios, 4 of them false-success) | **247/247**, exit 0. |
| `VITE_COMMERCE_MODE=local npm test` | **712/712**, exit 0. |
| `VITE_COMMERCE_MODE=local npm run build` | Exit 0; 17 routes and 404 prerendered. |
| `git diff --check`, plus `git diff --no-index --check` on every untracked file | Clean. |
| Full isolated runs 1 and 2 | Exit 1 each: **1806/1829**; 0 baseline, 0 harness (1050 harness checks), 0 infrastructure; 22 known-risk, 1 finding. Wall clock and uptime agree (~118 s). 0 external requests, route violations or interception errors; 1 server fault each (the deliberate marker). |
| Run 1 vs run 2, by exact check identity (scenario, viewport, label, name, outcome) | **0 differences.** The 23 failing checks are identical to 1N full run 2. |
| Six known defect families | risk:1 (12), risk:5 (4), risk:2 (1), risk:3 first add (2), risk:3 +1 (3), finding busy Apply (1). |
| Legacy `cart-break-in-browser.mjs` (isolated) | Pass at 1440, 375 and 320px. |
| Legacy `break-in-browser.mjs` + `break-in-server.mjs` (isolated wrapper) | Pass at 1440 and 375px. |

## Verification evidence (Task 1N, base `d02b89b` plus uncommitted harness files)

Raw logs, results, commands and runner prerequisites: `/home/anawin/projects/anawin-agents/phase6-1n-verification` (see its `README.md`).

| Check | Result |
| --- | --- |
| Focused synthetic self-test (`ANAWIN_PURCHASE_ONLY='gates reject false passes'`) | Before the 1N fix: 412/418, exit 2 (the 6 failures are exactly 1N controls). After: **418/418**, exit 0. |
| Busy-Apply self-tests (`ANAWIN_PURCHASE_ONLY='busy Apply [harness self-test'`, 17 scenarios) | Before: 239/243, exit 2. 3 failures are the committed unrelated/blank/omitted scenarios; 1 is a load timeout during a host suspend. After: **247/247**, exit 0, in 22 s. |
| `VITE_COMMERCE_MODE=local npm test` | **712/712** (run 2). Run 1: 711/712. `newsletter-popup.test.js` "popup waits twenty seconds" saw a 19999 ms delay instead of 20000, a timing flake outside the harness; nothing under `src` or `test` changed. |
| `VITE_COMMERCE_MODE=local npm run build` | Exit 0; 17 routes and 404 prerendered. |
| `git diff --check`, plus `git diff --no-index --check` on every untracked file | Clean. |
| Full isolated run (first attempt) | **Not counted.** The host suspended the WSL VM during it: 10.5 h of wall clock against far less guest uptime. Its 3 harness faults are wall-clock wait timeouts inside scenarios that took hours. |
| Full isolated runs 2 and 3 | Exit 1 each: **1767/1790**; 0 baseline, 0 harness (1011 harness checks), 0 infrastructure; 22 known-risk, 1 finding. Wall clock and uptime agree (~100 s). |
| Run 2 vs run 3, by exact check identity (scenario, viewport, label, name, outcome) | **0 differences.** |
| Six known defect families (failing checks per run) | Unchanged from 1M: risk:1 viewport (12), risk:5 viewport (4), risk:2 discount overlap (1), risk:3 first add (2), risk:3 +1 (3), finding busy Apply (1: Apply enabled, tap dropped, no write). |
| Legacy `cart-break-in-browser.mjs` (isolated) | Pass at 1440, 375 and 320px. |
| Legacy `break-in-browser.mjs` + `break-in-server.mjs` (isolated wrapper) | Pass at 1440 and 375px. |

## Verification evidence (Task 1M, base `d02b89b` plus uncommitted harness files)

Same toolchain as above (Chrome for Testing 150.0.7871.24, Node v22.22.3, real Arial, WSL 2). Production `src/`, the Worker and CI were not changed.

| Check | Result |
| --- | --- |
| Focused synthetic self-test (`ANAWIN_PURCHASE_ONLY='gates reject'`) | Before the 1M fixes: 359/378 (the 19 failures are exactly 1M controls). After: **378/378**, exit 0. |
| Busy-Apply self-tests (`ANAWIN_PURCHASE_ONLY='busy Apply'`, 7 scenarios) | Before (new forged-response scenarios only): 28/29. After: **99/99**, exit 0. |
| `+1` scenarios (`ANAWIN_PURCHASE_ONLY='overlapping +1'`) | Exit 1: 53/56, the 3 known risk:3 +1 failures; 0 harness. The serialized self-test passes the evidence, chain and configuration verdicts on the server's real snapshots. |
| `VITE_COMMERCE_MODE=local npm test` | **712/712** pass (build included). |
| `VITE_COMMERCE_MODE=local npm run build` | Exit 0; 17 routes and 404 prerendered. |
| `git diff --check`, plus the same check on every untracked file | Clean. |
| Full isolated run 1 | Exit 1: **1579/1602**; 0 baseline, 0 harness (823 harness checks), 0 infrastructure; 22 known-risk, 1 finding; 87 s. |
| Full isolated run 2 | Exit 1: **1579/1602**, the same counts. One scenario (`frozen cart after a dropped handoff…`) took 274 s instead of 4 s (run 1), and the run took 6 minutes. That scenario passed, WSL did not restart, and every check matched run 1, so the run is kept; the stall is unexplained. |
| Run 1 vs run 2, by exact check identity (scenario, viewport, label, name, outcome) | **0 differences.** The same 23 failing checks. |
| External traffic, route violations, interception errors | 0 in both runs. The one server fault per run is the deliberate fault-preservation marker (`expectedSelfTestFaults`). |
| Six known defect families (failing checks per run) | risk:1 viewport (12), risk:5 viewport (4), risk:2 discount overlap (1), risk:3 first add (2, BR16 stranded), risk:3 +1 (3), finding busy Apply (1). |
| Legacy `cart-break-in-browser.mjs` (isolated) | Pass at 1440, 375 and 320px. |
| Legacy `break-in-browser.mjs` + `break-in-server.mjs` (isolated wrapper) | Pass at 1440 and 375px (its only viewports). |

## Older suites

`break-in-browser.mjs` checks the unmodified storefront (port 5200, local commerce mode). There, full-size gloves have no Shopify preorder estimate, so `preorderState` is `blocked`, and the full-size Break-In checkbox is disabled with "Available to add when this glove launches." The script used to click it and expect $370. It now asserts the disabled state, the notice, and that a click leaves it unchecked at $295. The valid $370 is still asserted against the 5199 fixture, and in the purchase suite. Storefront behaviour was not changed.

## Runner reliability

- **Deadlines:** every CDP call (15 s), control request (15 s), process start (Chrome 20 s, mock 45 s), scenario (10 s – 5 min) and held request (30 s safety limit, which counts as a violation).
- **Real taps prove delivery.** `tap()` aims and installs its delivery listeners in **one evaluation**, re-measuring until the control is the topmost element at its centre (another tab's change can re-render the page). The listeners carry a per-tap token. Just before dispatch, a second evaluation confirms that the token's listeners are in place and untouched, and that the aimed point still hits the control. If the control moved, nothing has been pressed yet, so the harness re-aims; missing listeners are a harness error. The listeners sit on `window` in the capture phase, so they see the press before any page or shim handler. They record whether `pointerdown` and `click` reached the intended control (noting a re-render, and whether the control was disabled at pointerdown). A press that reaches anything else is **blocked there, before that control can act**, and reported as a harness error. A press is never retried after dispatch. `tapDelivery` then decides:
  - **Listeners:** they must have been confirmed before dispatch and reported back under the same token; otherwise delivery is unproven.
  - **Enabled control:** must be seen receiving **both** `pointerdown` and `click`. Click-only, pointerdown-only, wrong-target or missing events are a harness error.
  - **Disabled control** (at aim, or by pointerdown time): may be pressed only explicitly (`allowDisabled`), and then nothing may activate it. A click on it is a harness error.

  The deliberately disabled presses are all explicit and checked: the unavailable PDP service, the second rapid Apply, checkout during a held read or an in-flight update, and the frozen cart's stepper, whose probe no longer discards errors.
- **Race presses.** A race's second press must be delivered to its enabled control. If it finds the control disabled, it is recorded as **not offered**. That is a separate state from a refusal (see "Not offered is not a refusal"): the action must not have been done, and the gates check that nothing it would have written was committed. Each race records the result (`diagnostics` → "second action dispatch").
- **Residual tap race.** A re-render that lands between the pre-dispatch check and Chrome's hit test can still move the control. The harness then blocks the press and reports a harness error rather than guess. In Task 1H this happened once, in the rebased +1 self-test, before the pre-dispatch hit-test re-check was added; it did not recur in 8 focused runs or 2 full runs after it.
- **Stalls.** In 1M one passing scenario took 274 s with no restart and no failure; its checks matched the other run. Compare run identities before relying on a run with such a duration.
- **Host suspend.** Deadlines are wall-clock. If the host sleeps (or WSL is suspended) mid-run, waits time out and the run reports `harness` failures with absurd scenario durations. In 1L one run spanned 10.5 hours of wall clock while WSL uptime was 2 hours; its checkout scenarios timed out on the product page. Such a run is not evidence. Check `startedAt`/`finishedAt` (a normal run takes about 90 seconds) and rerun.
- **Spawn and teardown:** spawn errors are reported with the error. Teardown runs in `finally`: it stops each process, waits for its exit and drained streams, and records a process that survives SIGKILL as an infrastructure fault. The mock server's output is drained for the whole run.
- **Timed-out scenarios:** a scenario that outlives its deadline keeps running in the background, but its mock control calls and tab openings carry its generation and are refused once it is stale. Its tabs are closed, so its CDP calls fail.
- **Results:** the per-run `results.json` (schema 4) records the run ID, source revision and uncommitted files (read by the launcher), Node, Chrome and OS versions, the isolation report and sandbox profile, totals per label, `appRegressions` and `infrastructure` separately, the mock's cumulative `serverFaults` and any `expectedSelfTestFaults`, per-scenario outcome and duration, every check with sanitized detail, and diagnostics such as race interleavings, correlated +1 writes and busy-Apply timing.

## CI recommendations

CI (`.github/workflows/ci.yml`) runs `npm test`, `npm run build` and `git diff --check`; this work did not change it or any release protection. To gate on this suite:
- Use a dedicated Linux runner with no deploy credentials in the job.
- Install `bubblewrap` and allow unprivileged user namespaces for it.
- Install a pinned Chrome for Testing and Arial.
- Treat exits 2 and 3 as infrastructure failures.
- Until the defects are fixed, compare `appRegressions` against the six known check families so that any *new* failure blocks.
- Upload the run folder as an artifact.

## Gaps and manual follow-up

- Real iOS Safari and Android Chrome: tap slop, dynamic viewport bars, the on-screen keyboard, VoiceOver and TalkBack.
- Real Shopify checkout: frozen-cart handling, discount stacking, real line-ID formats, nested-line quantity behaviour and order metadata. These need an explicitly authorized test-store order.
- A connection dropped mid-mutation is approximated by 503-before-commit and commit-then-503, because Chrome transparently retries a POST.
- Per-code discount allocation rows are covered by unit tests only.
- Preorder facts that change while a tab stays open (risk 6) are covered only across a reload.
- Browsers that have Web Locks but deny them are not modelled.
- The execution guarantee is conditional on a trusted dedicated runner (see above). There is no isolation backend for macOS or Windows hosts.
- **Evidence comes from the mock, not from Shopify (1L, 1M).** Effects are now checked against the mock's own before and after snapshots, so a fixture bug that drops or misreports an effect fails closed. A fixture bug that corrupts both snapshots consistently would not be caught. Real Shopify's nested-line behaviour (merging into an existing child versus a new child line, re-keying on add) is not verified.
- **Rekeys are trusted only within their snapshots.** A recorded rekey is accepted if the old ID disappears, the new ID appears and the merchandise is unchanged. A real remove-plus-add of an identical line, misreported as a rekey, cannot be told apart from the snapshots alone.
- **Configuration is any merchandise, attribute or parent change.** Every attribute of a tracked line counts, including ones a future storefront might legitimately rewrite during a quantity change (for example a recomputed digest with the same meaning). Such a change would fail the +1 race and must be reviewed deliberately.
- **The discount response ID rule covers the busy-Apply gate.** Other scenarios that read discount results judge final state and feedback directly. A discount write that commits and then returns a wrong cart ID (1N, `commit-then-substitute`) is modelled only for `UpdateDiscountCodes` in the busy-Apply scenarios. The synthetic 1N matrix reproduces the server's commit or dry run on the real fixture, but not the server's substitution code; the real-storefront controls exercise that code.
- **The per-state pairing rule allows a trailing service.** A service may sit below its glove at any committed state. Only the final state proves parity, and the overwrite verdict catches a service that is lowered. A storefront that ever synced the service before the glove on an increase (service ahead) would fail, by design.
- **The audit covers the +1 race only.** Other scenarios still judge outcomes by final state and their own checks, not by per-commit effects.
- **Pre-1M controls run through the real fixture.** `fixtureEvidence` maps each case's line IDs onto a real fixture cart. Their evidence is real, but their `finalLines` are still written by hand. Gates check final state against those, not against the replayed cart.
- **The first-add race has two possible losers** (see defect 4). A CI comparison of `appRegressions` should compare check families (as recommended), not the glove named in a check.

## Task 3C corrective-02 contracts

The trusted runner passes `baseline` or `combined` to the isolated browser suite. The baseline adapter uses the historical application, including its original expired-pointer assertion and the split fixture with re-key on add. The combined expired-cart check requires two authoritative absent reads, an empty and non-purchasable display, no mutations or handoffs, and byte-identical safety records. It allows retention of the expired pointer and requires a fresh verified cart containing only the next requested glove.

Combined pairing coverage uses re-key on quantity and attribute updates with re-key on add disabled. The separate unexpected whole-cart rotation scenario proves that the split stops after one parent add, blocks checkout, and offers explicit recovery of the verified pre-edit $505 cart. The recovery action conveys consent tied to the exact displayed evidence. The Storefront API 2026-07 documentation describes line IDs and parent relationships. It leaves whole-cart rotation on add unconfirmed. These scenarios establish local fixture behavior. [Storefront API cartLinesAdd](https://shopify.dev/docs/api/storefront/2026-07/mutations/cartLinesAdd)

After discount overlap the combined scenario always verifies the current cart and completes a checked handoff. The successful concurrent first-add scenario requires both gloves exactly once and exercises no recovery. The dedicated browser recovery scenario deliberately injects a pre-commit HTTP 503, proves the source is unchanged and blocked, then activates the two historical recovery predicates after explicit consent. The derived reconciliation records both identities against their dedicated browser scenario.

## Task 3C corrective-03 baseline race and checkout focus

The original baseline first-add race and raw assertions stay in the report. A separate verifier can reconcile the two merchandise-specific outcomes when each tagged CreateCart request committed exactly one requested, unserviced glove, both tabs agree on the active pointer, and the losing glove is accounted for in the other cart. The verifier compares the original historical records and their recorded orphan details. New runs also record the complete tagged requests, fixture commits and cart registries before and after any optional recovery. The historical records did not save browser request tags.

The dedicated baseline recovery scenario injects a pre-commit 503 on a quantity update to a verified two-glove cart. It proves the source is unchanged and checkout is disabled, then uses the visible recovery action and verifies the recovered cart after reload. Its actual browser results supply the two conditional coverage identities when the first-add race offered no recovery.

A dropped checkout preserves the disabled Checkout control's logical focus through the busy redraw. The frozen-cart render sends that focus to an available recovery or verification action. A deliberate keyboard move during the authoritative read takes precedence. Tests cover the original pointer scenario, desktop and mobile keyboard flows, and intentional keyboard movement during a held verification read.
