# ALM P1 design proposal: the codec and the send chain

Prepared 2026-09-30 against merged `main` `c85d99cdd` (#566). Release 4's first slice, P1
"durable-path cost", from the [QoS plan](alm-qos-product-plan.md) sections 7.3 to 7.5 and the
[roadmap](alm-improvement-plan.md) decisions D17, D55, D86 to D90. Section 4's questions were settled
with the maintainer on 2026-09-30 and are recorded as D108 to D111. The code survey behind sections 1
and 2 cites `main` at that commit. Its figures come from a scratch Vitest ledger probe outside the
repository: it wrapped `IDBDatabase.prototype.transaction`, every object-store and index request
method, `IDBCursor.continue`, the repo's `IndexedDbOperationObserver` and every public member of the
`@js-temporal/polyfill` classes, and drove the fixture shape of the operation-count pin
(`al-indexeddb-operation-counts.test.ts:217-234`, `createIndexedDbOutboundCountStores` at `:358-383`)
under fake-indexeddb. It measured counts, never time. Paths below: `alm/` is `packages/shared/alm/`,
`qb/` is `packages/shared/queuebox/`.

## 1. The problem

P1's roadmap outcome names three levers ranked by the storage spike (D90): take the Temporal
polyfill off the storage hot path, cut the 14 sequential transactions of a durable send, and batch
commits per work batch. Grounding them against this checkout produced six findings. The first two
set the slice's shape; the fourth removes a lever; the sixth decides where latency is proven.

### 1.1 A warm durable send spends 14 transactions, 11 of them before the carrier sends

Thirty sequential sends on one runtime: send 1 is cold, sends 2 to 30 are identical, with no growth
from retained COMPLETED rows. A warm send spends **14 transactions (11 readonly, 3 readwrite), 46
requests and 22 operations (10 `al-admission`, 12 `al-work`)**. This reproduces the spike's H2
exactly. The storage path is unchanged since `bdb3ecd8b`; S3c-ii and #566 changed nothing on it.

| #  | Mode | Requests                                                                                | Call site                                                                                 | On a first dispatch of a fresh message              |
| -- | ---- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 1  | ro   | 9 gets: version, sent, pending-ack, repair-attempt, 3 control rows, canonical, identity | `readOutgoingMessage` (`alm/outbound/admission/al-outbound-admission-reads.ts:115-134`)   | 8 of 9 empty; 5 control rows empty                  |
| 2  | ro   | 3 `getAll`                                                                              | readiness probe of the previous batch (`alm/work/al-work-handler.ts:229-280`)             | empty probe, concurrent with #1, off the chain      |
| 3  | ro   | effect slot, canonical, identity                                                        | commit observation read (`al-outbound-admission-store.ts:488-497`)                        | effect slot empty; canonical and identity repeat #1 |
| 4  | ro   | 6 gets                                                                                  | D17 fence snapshot (`alm/indexed-db-admission-backend.ts:218-234`)                        | a third read of #1 and #3, except `msg-owner`       |
| 5  | rw   | 6 guard and fence gets, 6 puts                                                          | `writeIndexedDbAdmissionMutations` (`alm/write-indexed-db-admission-mutations.ts:48-110`) | required                                            |
| 6  | ro   | 1 `getAll`                                                                              | `finalizeExhausted` (`qb/indexed-db-queue-box.ts:469-482`)                                | empty probe                                         |
| 7  | ro   | 2 `getAll`                                                                              | `reserveEntries` candidates (`qb/indexed-db-queue-box.ts:387-402`)                        | required                                            |
| 8  | rw   | get, put                                                                                | claim CAS (`qb/indexed-db-queue-box.ts:424,609-617`)                                      | required                                            |
| 9  | ro   | 1 `getAll`                                                                              | `reserveTimeoutEntries` (`qb/indexed-db-queue-box.ts:353-366`)                            | empty probe                                         |
| 10 | ro   | canonical, identity                                                                     | `readWorkCanonicalMessage` (`al-outbound-admission-effect-store.ts:188-216`)              | repeat of what #1, #3, #4 read and #5 wrote         |
| 11 | ro   | `sent:<msgId>`                                                                          | `isMessageSuperseded` (`al-outbound-admission-reads.ts:211-234`)                          | repeat of the admission row                         |
| 12 | ro   | `pending-ack`                                                                           | `readReceiptState` (`al-outbound-admission-store.ts:447-449`)                             | empty                                               |
| -  | -    | carrier `sendPreparedMessage`                                                           | `al-outbound-message-effects.ts:230`                                                      |                                                     |
| 13 | ro   | effect row                                                                              | `releaseEntries` read (`qb/indexed-db-queue-box.ts:306-316`)                              | required, after the send                            |
| 14 | rw   | get, put                                                                                | release CAS (`qb/indexed-db-queue-box.ts:320-329`)                                        | required, after the send                            |

- **The chain.** Enqueue to carrier send is **11 sequential transactions**: #1, #3, #4, #5, then #6
  to #12. #2 belongs to the previous batch and overlaps the admission; #13 and #14 follow the send.
  Four of the eleven (#1, #3, #4, #5) run inside the per-sender Web Lock.
- **Cold.** The pin's shape is 21 transactions (17 readonly, 4 readwrite including `versionchange`),
  52 requests and 25 operations (10 plus 15). The extra transactions are the database open and
  schema validation, the schema-id read and the `ready()` bootstrap batch's three `work-probe`s
  (`al-work-handler.ts:197-204`). The pinned 15 `al-work` are the warm 12 plus those three. The warm
  figure is pinned nowhere, and no pin counts transactions.

### 1.2 The inbound path shares the codec and has no whole-path pin

A warm inbound admit-and-deliver spends **11 transactions (8 readonly, 3 readwrite), 34 requests and
13 operations**, or 13 transactions, 36 requests and 15 operations when D95's alternation adds a
rotation read inside the message's window. `al-admission` is always 8, which is what D87's "8 per
inbound admission" pins (`al-indexeddb-operation-counts.test.ts:408-413`). The 5 to 7 `al-work`
operations and the transactions of the whole admit-and-deliver are pinned nowhere. The admission
itself reads its five decision rows three times (surface read, fence snapshot, fence re-read in the
readwrite), the same shape as outbound #1, #4, #5.

### 1.3 Temporal: the codec re-parses what it produced

Public polyfill calls from callers outside the polyfill:

| Path                          | Total | Parses (Instant / PlainTime / PlainDateTime / Duration) | Other constructions | `toString` | Getters, compare, equals | In the IndexedDB codec |
| ----------------------------- | ----: | ------------------------------------------------------: | ------------------: | ---------: | -----------------------: | ---------------------: |
| One warm durable send         |   233 |                                  119 (58 / 30 / 30 / 1) |                  23 |         19 |                       72 |             165 (71 %) |
| One inbound admit-and-deliver |   201 |                                                     107 |                  20 |         13 |                       61 |             148 (74 %) |

- **Encode** (`qb/indexed-db-queue-box-entry-codec.ts:55-87`) converts with `Temporal.*.from`, calls
  `toString`, then `validateStoredResourceEntry` (`:187-207`) re-parses every string it just produced.
- **Decode** (`:89-112`) validates by parsing every field, then parses each field again to build the
  entry (`:114-185`).
- **Puts are decoded again.** `computeIndexedDbQueuePut` encodes (`qb/indexed-db-queue-box-entry.ts:51-63`),
  and `validateComputedIndexedDbQueueMutations` decodes the encoded value (`:88-124`).
- **Expiry parses although the mirror exists.** `isStoredQueueEntryExpired` parses `expiryTs`
  (`:158-163`); the row already stores `expiryEpochMs`, `endEpochMs` and `fairnessDueEpochMs`.
- **The contract reaches the server.** `ResourceEntry` (`qb/ResourceEntry.ts:42-53`) types its
  audit fields as Temporal values and is public through `packages/shared/mod.ts:36-43`. The server
  PostgreSQL QueueBox has its own row codec
  (`packages/shared-server/queuebox/postgres/resource-inbox-row-codec.ts:95-280`). Changing
  `ResourceEntry` reaches 23 shared-server and 11 api-v1 files; a codec-only change reaches neither.
- **The bundle keeps the polyfill regardless.** Every use is a per-module import; 27 modules of the
  `rallar.ts` bundle import it, including `InboxOutboxEngine.ts`, the circuit breaker, the WS ticket
  API and the presence and topology contracts. Polyfill plus JSBI are 158.2 of 1069.5 KiB minified
  (15 %). Without them the entry would be 188.6 KiB brotli instead of 228.2 (-39.7), against a 229
  KiB budget (0.8 KiB headroom). The headless agent is about 291.6 of 292 KiB. Both figures bind
  any P1 growth.
- **Native aliasing is all or nothing per bundle.** The codec's `instanceof` checks
  (`indexed-db-queue-box-entry-codec.ts:226,233,240`) reject values from the other implementation.
  Chromium 149 and Deno 2.9.5 ship native Temporal; Node 24 is not verified; Safari, Firefox and
  Android WebView are not verifiable from the repository.

### 1.4 The per-row fence permits merges, not skips

The D17 fence (`alm/indexed-db-admission-fence.ts:3-37`) records the first observation of every key
the write callback reads or writes and re-reads exactly those keys in the readwrite
(`alm/read-indexed-db-admission-write-fence.ts:49-125`). Keys read only in the decision read are
covered through the sender version row, which every admission of that sender bumps
(`al-outbound-admission-store.ts:576,610-613`). What that allows:

- **Merge #1 and #3.** #3's observations are re-validated inside the write
  (`validateObservedWork`, `al-outbound-admission-effect-store.ts:154-175`), the effect id is
  computable before compute, and #1 already holds the canonical pair. The group path
  (`commitBundles`, `al-outbound-admission-store.ts:473-506`) reads N decision sessions and keeps its
  own observation read.
- **Hand the canonical message to dispatch in memory (#10).** Canonical and identity rows are
  immutable once committed (`al-outbound-canonical-storage.ts:161-189`), dispatch reads are not
  fenced, and `committed()` runs the batch in the same tab (`al-work-handler.ts:218-227`). A miss
  (another tab, a reload, a replay) falls back to the read. I2a's per-session claim changes who
  claims, so the hand-off must never be required.
- **Merge #10, #11 and #12 into one session.** Skipping #11 is safe only when supersedence tracking
  is off; skipping #12 needs a proof that no receipt can complete before the first attempt, and a
  hand-over or fallback receipt (D56, S3b) prevents that proof from code alone. Merging carries no
  semantic change.
- **Fold #4 into the decision read.** Separate today only because session reads decode the value and
  drop `(revision, writeToken)` (`alm/indexed-db-admission-read-session.ts:73-85`). Folding it is a
  backend contract change shared with inbound: one transaction less per admission on both owners.
- **Probes on a cadence (#2, #6, #9)** are work-handler policy, not a fence question. Readiness
  memory is forgotten after every batch (`al-work-handler.ts:299-304`); finalize and timeout run
  every batch (`al-work-handler.ts:338-340`; `alm/work/al-work-queue-port.ts:105-121`). A cadence
  keeps every guarantee and lengthens the recovery paths, so each needs a stated bound.

None of these crosses a D54 pair: the hand-off caches an immutable row of the durable lane's own
backend.

### 1.5 Commit batching across a work batch does not touch a first send

`commitAll` batches the members of one `enqueueAllIfAbsent` call in one lane
(`al-outbound-message-runtime.ts:519-547`; `al-outbound-dispatch-admission.ts:146-173`); typed single
sends are groups of one. A work batch's first dispatch of a fresh message commits nothing: it reads,
sends and releases, and releases already flush once per batch (F2c,
`al-work-handler.ts:450-456`). Commits inside a batch come from replays and retransmissions. Batching
them across a batch would defer attempt results, take several Web Locks in a canonical order and
inherit `commitGroupOnce`'s all-or-fallback semantics. The lever helps replay and retransmission
storms only. Its admission-side analogue, a commit batch window for back-to-back single sends from
one sender, is D86's conditional setting.

### 1.6 No producer exists for a send-to-dispatch figure

- No field spans `enqueueIfAbsent` to `sendPreparedMessage`; the lane artifact's `perOperation` is
  the admission read chain only (`packages/shared-test/rallar-bb-test/docs/alm-observation-artifact.md:69`)
  and never sees #6 to #12.
- The lane's browser contexts come from `browser.newContext()`
  (`packages/shared-test/black-box-runner/browser/rallar-browser-session.ts:82`), whose IndexedDB the
  spike found to behave as memory. The QoS plan's "the lane figures are its proof" (section 10.4)
  contradicts its own finding that the lane cannot measure storage cost (section 7.5).
- The spike's harness was deleted (`865b9e399`). No file in the repository uses
  `launchPersistentContext`. The nearest building block is
  `packages/shared-test/black-box-runner/browser/rallar-browser-spike.mts`.
- `durable-opt-in` asserts only `al-admission > 0` on both pages
  (`packages/shared-test/rallar-bb-test/conformance/alm/scenarios/durable-opt-in.ts:75-83`).

## 2. The slice as two PRs

The findings order themselves: the codec fix and the merges change no semantics and are provable by
pins; the probe cadence changes recovery timing and is judged on the first PR's measured figures.

### 2.1 P1a: the codec and the send chain

- **The codec fix (D110).** Encode parses each Temporal field once and validates the values it
  holds, never its own output. Decode parses each field once. A computed put is validated without a
  second decode. `isStoredQueueEntryExpired` compares `expiryEpochMs`. Comparisons use the stored
  epoch-ms mirrors. `ResourceEntry`, the stored row shape, `AL_ADMISSION_SCHEMA_ID` and the server
  PostgreSQL codec are unchanged, so no reset and no server change follow. Inbound gets the fix
  through the shared codec.
- **Merge the decision read and the commit observation read** for a single send (#1 and #3). The
  effect slot joins the decision read; the group path keeps its own observation read.
- **Hand the committed canonical message to dispatch in memory** (#10), keyed by effect id, bounded,
  dropped on dispose and on `ALStorageResetEvent`, with the read as the fallback on a miss.
- **Merge dispatch's three readonly sessions** (canonical read, supersedence check, receipt-state
  read) into one. On a hit the session reads `sent` and `pending-ack` only.
- **The pins.**
  - New `packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts`: the survey's probe
    method in the repository. It records every IndexedDB transaction and request of one warm durable
    send and pins the chain count, the total and the per-owner operations. It lands first at
    today's 11, 14 and 10 plus 12, then falls to at most 8 chain transactions and 18 operations
    (10 `al-admission`, 8 `al-work`).
  - The same test pins a warm inbound admit-and-deliver at today's figures, at most 13 transactions
    and 7 `al-work` (D95's alternation gives 11 or 13 and 5 or 7), with 8 `al-admission`. They may
    only fall; P1 changes no inbound-only path.
  - The cold pin (`al-indexeddb-operation-counts.test.ts:217-234`, 10 plus 15) stays beside it and
    falls with the warm figure: 10 plus 11 derived from code, needs measurement.
  - `COMMITTING_ADMISSION_TRANSACTIONS` (`outbound/al-outbound-admission-transactions.test.ts:83`,
    `:194-205`) moves for the single-send commit; the decision-surface pin (`:159-172`) holds.
- **The harness (D111).** The spike's plain page rebuilt as a Playwright manual suite: persistent
  browser profile (`launchPersistentContext`), 4x CPU throttle, a 10-in-16 ms frame load, the real
  durable outbound path. It reports send-to-dispatch p50 and p95 and the CPU-profile share of the
  polyfill and of the codec. It is owned in `tests/manual-suites.json` (paths, owner, command,
  reason) and run locally before and after each lever; its figures go in the PR body. Its path and
  npm script are the plan's to name.

### 2.2 P1b: probes on a cadence

- The readiness probe after a batch (#2), the finalize-exhausted sweep (#6) and the lease-timeout
  reserve (#9) run on a cadence instead of every batch.
- Each states a bound: how late a RETRY row due after a batch, an exhausted row or a crashed owner's
  lease is noticed. The bound values are the P1b plan's, decided on P1a's measured figures; they
  need measurement.
- Pins: the ledger falls to at most 6 chain transactions and 15 operations (10 `al-admission`, 5
  `al-work`). The idle-probe pins move with a recorded reason
  (`al-indexeddb-operation-counts.test.ts:148-178`, `outbound-readiness-probe-diagnostics.test.ts`,
  `indexeddb-queuebox-operation-counts.test.ts:59-86`). A fake-clock unit test per probe proves the
  bound.
- The harness's after-figures are D89's reading (section 5).

## 3. Recommendation

**P1a, then P1b, serial.** P1a first because it changes no semantics, reaches inbound through the
codec and gives P1b the figures its cadence is judged on. P1b second because it lengthens recovery
paths and must state by how much.

Constraints that bind both:

- **No guarantee changes.** Every existing semantic test holds unchanged: supersedence, settlement,
  expiry, canonical storage restart and cleanup.
- **No schema bump, no migration** (D3, D17). The stored row and the schema id are unchanged.
- **No new dependency, no worker** (D8; section 7.6 of the QoS plan keeps the worker a later
  outcome).
- **Bundle ceilings.** `rallar.ts` is 228.2 of 229 KiB brotli and the headless agent about 291.6 of
  292. A crossed budget is raised to the next whole KiB and reported (standing ruling).
- **Pins only fall.** A rise in any pin needs a stated reason in the PR body (D87).

## 4. Maintainer decisions (2026-09-30)

Settled with the maintainer on 2026-09-30 and recorded as D108 to D111. The recommended answer is
first in each case, and each took it.

1. **Lever 3, commit batching across a work batch.** (a) Drop it from P1 and restate it as D86's
   conditional commit batch window for back-to-back single sends from one sender, adopted only if a
   measurement shows a gain; (b) keep it as written; (c) defer it until after I2a changes the claim
   model. (a) because it does not touch a first dispatch (1.5). D108; amends D90.
2. **The fence-snapshot fold.** (a) Not in P1: a recorded later candidate, worth one transaction per
   admission on both owners, decided after P1's figures exist; (b) in P1 behind the same pins; (c)
   never, since the separate snapshot is the D17 design. (a) because it changes the backend contract
   shared with inbound (1.4). D108.
3. **The Temporal fix.** (a) Codec-local: parse once, validate and compare on the stored epoch-ms
   mirrors, no re-parse of the codec's own output, no double parse on decode; the row, the schema
   id, `ResourceEntry` and the server codec unchanged; every engine; (b) an epoch-ms stored row with
   a schema bump and reset; (c) native Temporal by a bundler alias with a polyfill fallback; (d)
   `ResourceEntry` in epoch-ms across server and client. (a) removes most of the 165 codec calls
   per send without a reset or a server change. Native aliasing stays a later, evidence-based
   option. D110.
4. **The polyfill in the bundle.** (a) Only the hot path in P1; bundle removal (27 modules, -39.7 KiB
   brotli) is its own later slice, recorded in the QoS plan's later outcomes and the roadmap but not
   in the release map; (b) the whole bundle in P1; (c) the hot path plus a boundary pin that no new
   ALM module imports the polyfill. (a) because removal touches the engine, the circuit breaker,
   auth and the presence and topology contracts. D110.
5. **Inbound.** (a) The codec fix reaches it automatically; P1 adds a warm ledger pin for inbound
   (transactions and `al-work` per admit-and-deliver, at today's 11 to 13 and 5 to 7, may only fall)
   and changes no inbound-only path; (b) fully in scope, the fence fold and probe cadence on both;
   (c) out of scope. D108.
6. **The PR split.** (a) Two serial PRs: P1a the codec fix, the three zero-semantics merges, the
   pins and the harness; P1b the probe cadence with stated bounds, decided on P1a's figures; (b) one
   PR; (c) four PRs, one per sub-lever, each moving the same pins. (a) because the two carry
   different risks and P1b changes recovery timing. D108.
7. **P1's target (D87).** (a) A warm durable send spends at most 8 transactions on the
   enqueue-to-carrier chain and at most 18 operations after P1a, at most 6 and 15 after P1b, pinned
   by a new ledger test; the cold 10 plus 15 pin stays beside it and falls when it can; (b)
   operations only; (c) transactions only; (d) a warm 10 plus 12 pin beside the cold one, no chain
   count. (a) because the chain count is what the render-loop finding prices and the operations keep
   the existing pins honest. D109.
8. **The latency proof.** (a) Rebuild the spike's plain-page harness as a Playwright manual suite,
   run locally before and after each lever, figures in the PR body; D89's gate is measured there
   instead of the lane's slow regime; the lane stays the correctness authority with no
   send-to-dispatch field; (b) a send-to-dispatch field and reducer in the lane artifact; (c) both;
   (d) counts only, no latency claim. (a) because the lane's storage is incognito and measures its
   harness page (1.6). D111; amends D89.

## 5. Acceptance evidence

- **Pins.** `al-indexeddb-transaction-ledger.test.ts`: warm send 11 to at most 8 chain transactions
  and 22 to at most 18 operations (P1a), then at most 6 and 15 (P1b); warm inbound at most 13
  transactions and 7 `al-work`, 8 `al-admission`. The cold pin beside it, lowered by the measured
  amount. `COMMITTING_ADMISSION_TRANSACTIONS` re-baselined in P1a; the idle-probe pins in P1b.
- **Harness figures**, before and after each lever, in the PR body: send-to-dispatch p50 and p95
  at 4x CPU under the frame load, and the CPU-profile share of the polyfill and of the codec. The
  before run on `main` must first reproduce the spike's baseline (render loop at 4x CPU: 78.8 ms p50,
  93.7 ms p95; in an idle page, polyfill and JSBI 32 % of busy CPU and 72 % of the polyfill in the codec) within this
  machine's run-to-run noise, since main-against-main comparisons here already drift.
- **Bundle figures** for `rallar.ts` and the headless agent, with any budget raise reported.
- **Unchanged behaviour.** The ALM conformance lane green on every carrier, `durable-opt-in` and
  `delivery-baseline` included; Hetzner manifests 18 and 22 green from the PR branch.
- **The D89 reading.** After P1b, the harness's send-to-dispatch p95 for a `local-outbox` send at
  4x CPU under the frame load is D89's figure. Above 100 ms, I2b goes ahead; otherwise Relic's
  commands move to `local-outbox` and a recorded decision withdraws I2b. The spike's pre-P1 p95 on
  this machine is 93.7 ms, so the reading also states the machine and that it is not a phone.

## 6. Rough task decomposition (for sizing only)

- **P1a** (8 tasks): the ledger pin at today's figures, outbound and inbound; the manual harness,
  its `tests/manual-suites.json` entry and the before-figures on `main`; the codec's encode path
  (one parse, no re-parse of its output, no second decode of a put); the codec's decode path and the
  epoch-ms expiry check; the merged decision and observation read with the group path kept; the
  in-memory canonical hand-off with its bound, reset and fallback; dispatch's merged read session;
  pins lowered, bundle and harness after-figures, QoS plan section 7.1 figures.
- **P1b** (4 tasks): readiness memory after a batch with its bound; the finalize-exhausted sweep on
  a cadence with its bound; the lease-timeout reserve on a cadence with its bound; pins, harness
  figures and the D89 reading.

## 7. Corrections to the roadmap and the QoS plan

From the survey, each applied with the decisions:

1. "Cut the 14 sequential transactions": 14 is the warm total, 11 lie on the enqueue-to-carrier
   chain, cold is 21 (1.1). Applied in QoS plan sections 7.3 and 7.5, D109, the roadmap's "Releases
   4 to 8" row and the product description's P1 bullet.
2. "Merge one admission's two read sessions": an admission has three readonly sessions before its
   readwrite; the merge is #1 with #3, and the fence snapshot is a separate lever (1.4). Applied in
   QoS plan sections 7.3 and 7.5, D108.
3. Dispatch spends three readonly sessions, and merging them is a zero-semantics lever the plan did
   not list; skipping the receipt-state read cannot be proven safe (1.4). Applied in QoS plan
   section 7.3, D108.
4. "Batch commits across a work batch" does not touch a first send (1.5). Applied in QoS plan
   section 7.3, D108, D90 amended, the roadmap's release rows.
5. The Temporal lever omitted its cheapest option, stop re-parsing, and an ALM-only change leaves the
   polyfill in the bundle (1.3). Applied in QoS plan sections 7.3 and 7.6, D110.
6. The spike's "6 empty control, receipt and effect reads" are 7 by call site; "13 of 22 avoidable"
   is an upper bound (1.1). Applied in QoS plan section 7.5.
7. "10 `al-admission` and 15 `al-work` per send" is the cold pin; a warm send is 10 plus 12 and is
   pinned nowhere; no pin counts transactions (1.1). Applied in QoS plan sections 3 and 7.1, D109,
   the roadmap's matrix row Q1 and the product description.
8. "8 per inbound admission" counts `al-admission` only; the 5 to 7 `al-work` and the whole-path
   transactions are unpinned (1.2). Applied in QoS plan sections 7.1 and 9.2, D109.
9. "The lane figures are its proof" contradicts the finding that the lane cannot measure storage
   cost, and the exit evidence "send-to-dispatch figures" has no producer (1.6). Applied in QoS plan
   sections 9.1 and 10.4, D111.
10. The lane's `perOperation` figure covers the admission read chain only and never the dispatch
    side (1.6). Applied in QoS plan section 9.1.
11. The bundle side binds: 0.8 KiB headroom on `rallar.ts` and about 0.4 on the headless agent
    (1.3). Applied in section 3 above and D110.

## 8. Carries: what P1 does not do

- **The fence-snapshot fold** (1.4): a recorded candidate, one transaction per admission on both
  owners, decided after P1's figures exist (QoS plan section 7.3).
- **Removing the polyfill from the bundle** (27 modules, -39.7 KiB brotli): its own later slice (QoS
  plan section 7.6).
- **A native Temporal alias**: a later option, taken only on measured evidence across engines.
- **Commit batching across a work batch**: dropped; the commit batch window stays D86's conditional
  setting.
- **Any `ResourceEntry` or stored-row change**: none, so no schema bump and no server change.
- **Inbound levers**: none; inbound gets the codec fix and the warm pin.
- **Skipping reads**: the receipt-state read and the supersedence read are merged, never skipped.
- **A lane send-to-dispatch field**: none (D111).
- **The transaction durability hint and a worker**: unchanged (D90, QoS plan section 7.6).
