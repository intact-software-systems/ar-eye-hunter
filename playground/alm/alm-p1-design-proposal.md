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
Sections 9 to 13 shape P1b from a survey of `main` at `90d358f7f` (P1a merged); its decisions,
settled on 2026-10-01, are D112 to D117.

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
- The harness's after-figures include the receipted reading, recorded as I2b evidence, not as a
  gate (section 5; revised 2026-10-01, D115).

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
   run locally before and after each lever, figures in the PR body; D89's reading is measured
   there instead of the lane's slow regime, as evidence only (revised 2026-10-01, D115); the lane
   stays the correctness authority with no send-to-dispatch field; (b) a send-to-dispatch field and
   reducer in the lane artifact; (c) both; (d) counts only, no latency claim. (a) because the lane's
   storage is incognito and measures its harness page (1.6). D111; amends D89.

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
- **The receipted reading** (revised 2026-10-01, D115). After P1b, the harness's send-to-dispatch
  p95 for a receipted `command`-shaped send at 4x CPU under the frame load is recorded as evidence
  for I2b's consumer send, not as a gate: I2b proceeds after I2a whatever it reads, and Relic's
  commands move to `local-outbox` with I2a. The spike's pre-P1 p95 on this machine is 93.7 ms, so
  the reading also states the machine and that it is not a phone.

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

## 9. P1b: the survey's corrections

P1b was surveyed on 2026-10-01 against `main` `90d358f7f` (P1a merged, #627), read-only, in two
passes: a code survey of the three probes, then a re-survey of the two sweeps against QueueBox's own
resilience design. Paths as above, plus `t/` for `packages/tests/shared/`. Each correction changes
what section 2.2, the QoS plan or a code comment says.

1. **The readiness probe after a batch is off the chain.** At P1a it is ledger transaction #30,
   after the release (`alm/work/al-work-handler.ts:300-316`). Chain 8 to 6 is the two sweeps alone
   (#23, #26). The readiness probe moves only the total, 11 to 8 with the sweeps. The QoS plan's
   bound sentence (section 7.3, lever 2) also dropped the RETRY row that section 2.2 names.
2. **The two sweeps guard one condition.** The finalize-exhausted sweep (#23) and the lease-timeout
   reserve (#26) read the same RESERVED page and act on a row past its lease: finalize at
   `attempts >= 20`, timeout below (`qb/indexed-db-queue-box.ts:379-381, 755-773`). The readiness
   scan reads that page too and answers each RESERVED row at its lease end
   (`alm/outbound/al-outbound-work-entry.ts:211-214`). Section 1.4's three cadences are one
   readiness cadence and one sweep cadence. The scan reads 16 RESERVED rows per type and the sweeps
   64 (`al-outbound-work-entry.ts:138`, `qb/indexed-db-queue-box.ts:98`), so 16 live leases can
   hide a timed-out 17th from the scan.
3. **QueueBox's ResourceInbox dequeuer already rate-limits both sweeps, and ALM's port bypassed
   it.** `createDefaultResourceInboxDequeuer` reserves timed-out rows behind
   `checkReserveTimeouts.lockEntryRateLimiter` and exhausted rows behind
   `checkFinalization.lockEntryRateLimiter`, 10 per 60 s each
   (`qb/resource-inbox/create-default-resource-inbox-dequeuer.ts:186-207, 253-278`;
   `qb/resource-inbox/resource-inbox-resilience.ts:37-43`). Its advertisement, `isAnyEntryToLock`,
   asks at most once per window through `isEntryRateLimiter`. ALM's `createALWorkQueuePort` calls
   `reserveTimeoutEntries` and `reserveRetryExhaustionFinalizations` on every batch
   (`alm/work/al-work-queue-port.ts:105-130`). Every outbound runtime already holds a
   `ResourceInboxResilience` (`alm/outbound/al-outbound-message-runtime.ts:347-351`) and uses only
   its circuit breaker; its three `StatusChecks` are unused.
4. **The `DequeueController` runs FAIRNESS before RETRY.** Its lanes run finalization, NEW,
   FAIRNESS, RETRY, TIMEOUT (`qb/dequeue/dequeue-controller.ts:201-210`). Finalization runs once.
   Every other lane loops reserve, compute and release until a reserve is empty or `maxNumDequeue`
   is reached, so each lane ends on an empty reserve and a limited lane spends one allowance per
   iteration.
5. **The dequeuer recovers on a 5-minute staleness, not on the row's lease.**
   `FINALIZATION_STALE_AFTER_MS` (300 000) is both the finalization staleness and the timeout
   reserve's `timeSinceStartTs` (dequeuer `:197-199`); the advertisement times a lease out after 5
   minutes (`qb/ResourceEntry.ts:132`). A crashed server lease is recovered at reservation start
   plus 5 minutes, at most 75 s of window and one engine pass. ALM's outbound lease is `leaseMs`, 10
   000 ms (`al-outbound-work-entry.ts:22`), so ALM takes the limiter design, not the dequeuer's
   constants. AppOutbox has no finalization lane (`packages/shared/services/outbox-queue-reader.ts:23`):
   its exhausted rows wait for expiry cleanup.
6. **"The idle-probe pins move" (section 2.2, QoS plan 9.1 and 9.2) is wrong.** The idle pin
   (`t/alm/al-indexeddb-operation-counts.test.ts:146-176`, 4 `work-page` per 10 idle seconds) runs
   no batch, so a batch-scoped cadence leaves it unchanged.
   `t/queuebox/indexeddb-queuebox-operation-counts.test.ts:59-86` pins QueueBox per-call kinds, not
   cadence. What moves: the probe-diagnostics cause list
   (`t/alm/outbound-readiness-probe-diagnostics.test.ts:64-111`), the ledger's idle wait
   (`t/alm/al-indexeddb-transaction-ledger.test.ts:206-232`), the harness's per-send end
   (`tests/playwright/alm/harness/durable-send-harness-contract.ts:27-30`) and the cold pin. A
   timer-driven sweep would make the idle pin rise, against D87.
7. **Two code comments say another tab announces its write with an external-write wake.**
   `al-work-handler.ts:181-186` and `packages/shared/services/InboxOutboxEngine.ts:126-130` say so.
   Only the server middleware calls `wakeAfterExternalWrite`
   (`packages/shared-server/rallar-system/middleware/create-rallar-middleware-infrastructure.ts:70,99`).
   In the browser, a row another tab or a reloaded page wrote is found by the age bound or by this
   owner's next batch end. The comment on `AL_WORK_READINESS_MEMORY_MS`
   (`al-work-handler.ts:118-123`) is the accurate one.
8. **`readinessInvalidation` is never reset, stated exactly.** It is written only while a memory
   stands (`al-work-handler.ts:279-283`) and never cleared by the probe that consumes it
   (`:252-258`). An invalidation that lands while a probe is in flight bumps `readinessGeneration`
   (`:285`), discards that probe's answer and leaves the older cause to label the next probe. It is
   diagnostic-only today. The readiness restore (section 10, decision 1) makes "which invalidations
   happened since the memory" a decision input, so it must be exact.
9. **The D89 reading is not on a `local-outbox` send, and 93.7 ms is the spike's instrument.** P1a's
   harness sends the ledger's minimal plan without a hop receipt (R-P1a-15). A Relic command is a
   receipted WS unicast (`ack: 'receiver'`,
   `packages/shared/al-contracts/resolve-al-channel-send-defaults.ts:21-27`), and its chain is
   unmeasured. The harness read a run-level p95 of 49.3 to 54.1 ms before P1a and 44.1 to 50.1 ms
   after (Apple M2 Max, HeadlessChrome 149). It never reproduced the spike's 93.7 ms, so on this
   instrument the 100 ms bar framed against 93.7 ms was met before P1 began.
10. **The harness cannot show a recovery bound, and the ledger window ends at idle.** Work a timer
    defers past the window escapes every pin (P1a final review, finding 8). Fake-clock unit tests
    prove the bounds, and an idle-window pin after a send closes the gap.
11. **Section 1.1's "concurrent with #1" holds only for back-to-back sends.** At P1a the ledger
    places the readiness probe after the release (#30).

## 10. P1b decisions (2026-10-01)

Settled with the maintainer on 2026-10-01 and recorded as D112 to D117. The decided answer is first,
then the other options from the two surveys, then the reason. Standing direction for all eight: P1b
builds on QueueBox's existing engine designs (`DequeueController`, `ResourceInboxResilience`,
`InboxOutboxEngine.wakeAt`), not on ALM-specific mechanisms.

1. **Readiness after a batch.** (a) A clean batch restores the readiness memory its commit
   suspended and hands it to the engine through the existing `wakeAt`. Clean means it claimed less
   than a page, rejected nothing, completed every claim, and saw no external wake or retained
   release since. A batch that writes a RETRY or `not-ready` row or retains a claim still probes, so
   a due retry gains 0 ms. A row another tab or a reload added is found within today's idle bound,
   3 s of memory plus one pass, at most 6.6 s. The never-reset `readinessInvalidation` is fixed as
   part of it. (b) `releaseAll` returns each RETRY and `not-ready` due time; RETRY rows of earlier
   batches due later stay unknown. (c) Keep the batch's answer to the age bound: a due RETRY up to
   6.6 s late, 22 % of a 30 s `command` deadline. (d) Probe every Nth batch: an N-dependent pin.
   For a foreign row, a shorter busy memory (more probes inside send windows) and a cross-tab wake
   (a new mechanism, I2a's territory) were also on the table. (a) because it adds no constant, no
   port contract change and no retry latency. D112.
2. **The two sweeps.** (a) Build on the existing QueueBox engine design: the ALM work port adopts
   the ResourceInbox dequeuer's design, its `ResourceInboxResilience` sliding-window limiters
   `checkReserveTimeouts` and `checkFinalization` or the `DequeueController` itself; decision 5
   fixes the fit. (b) One gate on the last scan's lease state plus the bootstrap batch, a full
   RESERVED page counting as due. (c) At most once per S in batches. (d) A separate cadence per
   sweep. The maintainer first answered (b), then replaced it with (a). (a) because QueueBox already
   rate-limits these two sweeps for its own dequeuer (section 9, correction 3), and (b) was a new
   ALM mechanism. D113.
3. **The hand-off cache.** (a) The library gains a count cap, `maxEntries` on `LatestRepository`
   and on `ObservableLatestRepository`: the oldest insertion is evicted on accept or set, and the
   observable one emits its delete event. It is P1b's first task, test first. The hand-off then
   moves onto `LatestRepository` with `maxEntries: 64` and the send's `expiresAtMs` as its per-entry
   deadline, with no wrapper in ALM. (b) A thin 64-entry wrapper in ALM around `LatestRepository`.
   (c) The migration as its own PR before P1b, or (d) after P1b. (e) No count cap, relying on
   deadlines, which bounds memory only by deadline times send rate. (a) because one cap in the
   library serves every keyed user, where a wrapper would be ALM-specific. D114.
4. **D89 and I2b (revised).** (a) `local-checkpoint` (I2b) is built regardless of the D89
   reading, and D89's gate is retired. P1b adds a receipted `command`-shaped send configuration to
   the harness, the send D89 names, and records its reading, the p95 at 4x CPU under the frame load
   with the machine stated, as evidence for I2b's consumer send, not as a gate. No document loses
   `local-checkpoint`. Relic's commands stay volatile until I2a moves them to `local-outbox` with
   the recovery outcome its UI proof needs; I2b's own consumer proof comes with I2b. (b) Read D89
   on the receipted send and, unless its p95 exceeds 100 ms, withdraw I2b in the documents:
   `local-checkpoint` out of the QoS plan's sections 1 to 7, 9, 10 and 12, D84 to D89 amended, the
   release map row, the "Releases 4 to 8" I2b row and matrix row Q3 changed, the product
   description's 7 lines removed. (c) Read D89 on the minimal plan, withdraw I2b and move Relic in
   P1b. (d) Defer the reading until a phone or a receipted figure exists. The first answer was (b),
   recorded in the design commit; the maintainer replaced it with (a) after reading the design.
   (a) because the tier's other QoS properties, zero storage on the send path with crash-tolerant
   checkpoints and a bounded recovery lag, serve a wide range of apps that want cheap sends and
   reload survival without per-message durability, whatever one send's latency reads; and a
   message resumed after a reload has no handle (D13), so Relic's proof needs I2a's recovery
   outcome. D115.
5. **The sweep window.** (a) One sweep per `leaseMs` (10 s) per store lane, on the lane's injected
   clock, through a limiter pair per lane built on `ResourceInboxResilience`'s status checks and
   `RateLimiter`'s public clock API (`initWithTs`, `allowAt`). Lease ends are clamped, treated as
   not due, while the lock limiter is closed, beside the circuit-open deferral, so no batch loops.
   The first batch after bootstrap sweeps on its fresh allowance, and the cold pin keeps both sweeps
   once. The worst recovery for a crashed lease or an exhausted row is lease end plus 19.1 s (today
   plus 6.6 s). ALM keeps its own claim (the re-survey's B(1)). Alternatives on the table:
   - window: (b) the server's constants, 10 per 60 s, which move no pin and save nothing below 10
     batches a minute; (c) 1 per 60 s, worst lease end plus 81.6 s;
   - first batch: only when the scan saw a RESERVED row;
   - the advertisement half: a separate 1-per-window `isEntryRateLimiter` on the probe, as on the
     server, or none, which runs a zero-delay loop (a past lease end re-arms the engine at delay 0)
     for up to 12.5 s;
   - limiter owner: `dequeue.resilience`'s `StatusChecks`, shared by the durable and volatile lanes
     and, on the server fallback, with AppInbox;
   - API: add `RateLimiter.isAllowedAt` and a clock-taking `createResourceInboxStatusChecks` export;
   - the claim, B(2): replace `ALWorkHandler`'s claim with a `DequeueController`, a large rewrite at
     at least 11 transactions in all, which misses the total and lacks observed reservation,
     retained claims, the single flush, readiness memory and the inbound rotation.

   (a) because it reaches the target deterministically on a lane clock and keeps recovery within
   one lease and two windows. D113.
6. **Scope.** (a) Outbound only, every outbound lane: the browser lanes and api-v1's Postgres ALM
   lane share the limiter design, proven by the api-v1 cluster black-box profile and the Postgres
   medium-scale gate. The inbound owner is configured to sweep every batch, so its pins (chain 9 or
   11, total 11 or 13) do not move. (b) Inbound takes the same limiters, chain 9 to 7. (c) (b) plus
   the zero-semantic split of inbound's observed list by status. (d) Every batch on server stores,
   the cadence in the browser composition only. (a) because D108 gives inbound pins only, and one
   outbound code path keeps one bound. D113.
7. **The PR count.** (a) One PR, tasks in order: A, the cache cap and the hand-off migration; B,
   the readiness restore and the invalidation fix; C, the sweeps behind the limiter pair and the
   clamp; D, the harness's receipted-command configuration and its recorded reading; E, the pins,
   the cluster and medium-scale proofs, the hosted manifests and the PR body. (b) Two PRs, the
   cache migration on its own. The maintainer's four notes bind the plan (section 12). (a) because
   each piece is small and the receipted reading must follow the cadence. D116.
8. **A generic ring buffer for the count cap.** (a) No: the cap uses the repository's own
   insertion-ordered map, and a backlog line records a generic bounded FIFO if a third keyless user
   appears beside the cache cap and the motion sample window
   (`packages/shared/rallar-motion/buffer.ts:304`). (b) A generic ring buffer in `packages/shared`
   now. (a) because a `Map` already yields its oldest insertion first, and a second structure would
   duplicate it. D114.

**The target (D117).** Decisions 1, 5 and 6 keep D109's P1b target, which the re-survey asked to
confirm: a warm durable send spends at most 6 transactions from `enqueueIfAbsent` to the carrier
send, 8 in all and 15 operations (10 `al-admission`, 5 `al-work`), pinned by the ledger on a
lane-controlled clock. The cold pin is set by measurement, and the inbound pins do not move. Under
the server's constants (decision 5's option (b)) no pin would move.

## 11. P1b shape

One PR, five task groups in order (D116). Pins only fall; a rise needs a stated reason (D87).

### 11.A The cache cap and the hand-off migration (D114)

- **The library.** `LatestRepository` (`packages/shared/cache/LatestRepository.ts`) and
  `ObservableLatestRepository` (`packages/shared/cache/ObservableLatestRepository.ts`) take
  `maxEntries`. An accept or set past the cap evicts the oldest insertion from the repository's
  own insertion-ordered map; the observable one emits its delete event for the evicted key. Without
  the cap both behave as today. A re-set key keeps its position (`getOrCreate`,
  `LatestRepository.ts:386-395`), so the cap evicts by first insertion.
- **Tests first.** The decision names `packages/tests/shared/cache`, which does not exist; the cache
  tests sit in `packages/tests/shared/` (`latest-repository-expiry.test.ts`,
  `observable-latest-repository.test.ts`). The plan names the file.
- **The hand-off.** `ALOutboundCanonicalHandoff`
  (`alm/outbound/lane/al-outbound-canonical-handoff.ts:20-62`) replaces its raw `Map` and trim loop
  with `LatestRepository` at `maxEntries: 64`. A commit calls `acceptAt` with the lane clock and the
  send's `payload.message.expiresAtMs` as `expireAtEpochMs`, deleting first as `setCommitted` does
  today so that a re-set key is the newest. A take is `readAt(key, now)` then `delete(key)`;
  `take(key)` returns an expired value (`cache/LatestValue.ts:116-120`). Dispose and storage reset
  call `clearAll()`. No `deleteExpiredIntervalMs`, which starts a `setInterval`. The store's deadline
  guard (`alm/outbound/admission/al-outbound-admission-effect-store.ts:191-206`) stays the
  authority.
- **Pins and evidence.** `t/alm/outbound/al-outbound-canonical-handoff.test.ts`: the two bound tests
  gain a clock, and a new case shows that an entry past its deadline is neither returned nor
  retained, on a fake clock. `LatestRepository` already ships in `rallar.ts`
  (`packages/shared/repository/rtt-repository.ts:24`), so the bundle delta is the cap, reported for
  `rallar.ts` and the headless agent.

### 11.B The readiness restore and the invalidation fix (D112)

- **Suspend, then restore.** `committed()` (`al-work-handler.ts:218-227`) moves the standing memory
  into a suspended slot instead of discarding it. A clean batch restores it with its original
  `observedAtMs`, so the age bound is unchanged, and passes
  `run.selection.nextReadyAtMs ?? restored.readyAtMs` to the existing `wakeAt` (`:354`). Both halves
  are needed: a bare `wakeAt` schedules the pass, but its `isWork` would find no memory and probe.
- **Guards.** A restored answer must be undefined or later than the batch start, since
  `executeOnce` drops past entries (`InboxOutboxEngine.ts:165-170`) and a due answer would loop
  empty batches. The suspended answer is discarded by `external-wake`, `retained-release`, a commit
  behind the batch (`commitPending`), a rejection, a retained claim, a full page or any release
  other than `completed`; the next pass then probes as today.
- **The invalidation label.** A probe reads and clears `readinessInvalidation` when it starts
  (`:252`), and reads `no-memory` when it is clear. `forgetReadiness` sets it only when it is clear,
  so the commit, not its batch, owns the probe (`:280-281`).
- **The comments.** The two false comments (section 9, correction 7) say what the browser does: no
  other tab wakes this owner.
- **Inbound** is unchanged by construction: its memory is 0, so a restored answer is aged at once
  (`:246-249`).
- **Pins and evidence.** New fake-clock cases in `t/alm/work/al-work-handler.test.ts`: a restore
  after a clean batch; none after a RETRY or `not-ready` release, a retained claim, an external
  wake or a commit behind the batch; a foreign row found within 6.6 s. The handler's probe-count
  cases (`:741-852`) move. `t/alm/outbound-readiness-probe-diagnostics.test.ts` is rewritten: the
  `own-commit` cause goes, and `runProbedRound` (`:53-62`) would poll forever. The ledger's
  `sendUntilOwnerIdle` waits for the batch diagnostic and `liveCount() === 0`. The harness ends each
  send on the batch's effect drain instead of the `own-commit` probe.

### 11.C The sweeps on the ResourceInbox limiter design (D113)

- **The port input.** `createALWorkQueuePort` (`alm/work/al-work-queue-port.ts:90-141`) takes a
  lease-recovery input: every batch, or the lane's limiter pair. The port owns reservation
  (`al-work-handler.ts:158`), so the handler is unchanged. An allowance is spent only when the call
  would read (`maxToReserve > 0`), unlike the dequeuer.
- **The pair.** One lock limiter per sweep, in the role `StatusChecks.lockEntryRateLimiter` plays in
  the dequeuer: `RateLimiter.initWithTs(leaseMs, 1, clock.nowMs())`, spent with
  `allowAt(clock.nowMs())`, never `tryToExecuteOrDefault`, which reads `Date.now`. Each
  `ALOutboundStoreLane` builds its own pair (`createALOutboundLaneWorkPort`,
  `alm/outbound/lane/al-outbound-store-lane.ts:439-448`), so the volatile lane never spends the
  durable lane's allowance and a server lane never spends AppInbox's. `Resilience.ts` is unchanged.
  Whether the pair comes from a clock-taking export of `createResourceInboxStatusChecks`
  (`resource-inbox-resilience.ts:128`, module-private today) or from one lane function shared by
  every outbound lane is the plan's choice under section 12's second note.
- **The clamp.** While a sweep's limiter is closed, the readiness scan
  (`al-outbound-work-entry.ts:132-156, 211-214`) treats the lease ends that sweep would recover as
  not due. It reads the limiter without spending (`SlidingWindowCounter.sumInWindowWithNow`) and
  sits beside the circuit-open `ALOutboundDequeueDeferral` (`al-outbound-store-lane.ts:239-247`).
  It plays the dequeuer's `isEntryRateLimiter` role for ALM's own scan. Without it a denied sweep
  runs a zero-delay loop: a past lease end re-arms the engine at delay 0 until the window reopens.
- **The first batch.** A fresh limiter holds its allowance, so the bootstrap batch sweeps both, and
  the cold pin keeps both sweeps once.
- **The bound.** A crashed lease or an exhausted row is recovered by lease end plus 19.1 s at most:
  the window reopens at most 1.25 `leaseMs` (12.5 s) after the last sweep (measured; `RateLimiter`
  counts in quarter-window buckets), then 3 s of memory and one pass. Today: lease end plus 6.6 s.
  The bound assumes the readiness scan (16 rows per type) or a sweep (64 rows) sees the row: a
  crashed row hidden behind 16 live leases is recovered at the first batch that sweeps with its
  window open.
  After a reload (D98) the bootstrap sweep sees the live lease, and recovery lands at most 19.1 s
  after the bootstrap.
- **Every outbound lane.** The browser lanes and api-v1's Postgres ALM lane
  (`packages/shared/services/ws-queue-box-server/ws-queue-box-server-service.ts:272-281`) take the
  same pair. The durable lane's work types include AppInbox-written `WS_OUTBOX` rows, so D107's
  cluster lease recovery moves to the same bound. N API processes hold N pairs and sweep N times
  per window, as the dequeuer does today.
- **Inbound** sweeps every batch: its memory is 0 and its rotation drives readiness
  (`alm/inbound/lane/al-inbound-store-lane.ts:103-117, 450-458`), so it needs no clamp.
- **Pins and evidence.** Fake-clock cases: the bootstrap batch sweeps; sends inside the window skip;
  a crashed lease and an exhausted row are recovered within the later of lease end and reopen, plus
  6.6 s; no batch runs while the window is closed and a lease end waits, counted; a full RESERVED
  page (16 scan rows against 64 sweep rows). The handler's sweep cases
  (`al-work-handler.test.ts:136, 239, 530, 564`) hold, since the gate lives in the port. The test
  ports (`packages/shared-test/shared/create-test-al-outbound-work-port.ts`, its inbound twin) and
  the 14 test files that build a port or handler take the new input.

### 11.D The receipted reading as I2b evidence (D115)

- **The configuration.** The manual harness (`tests/playwright/alm/`, `npm run
  perf:alm:durable-send`, owned in `tests/manual-suites.json`) gains a receipted `command`-shaped
  send beside the minimal plan: a WS unicast with a hop receipt (`ack: 'receiver'`), the send D89
  names. Same page, 4x CPU, 10-in-16 ms frame load.
- **The reading.** Send-to-dispatch p50 and p95 on both configurations after tasks A to C, with the
  machine and browser stated and the note that it is not a phone. The minimal plan's p95 after P1a
  is 44.1 to 50.1 ms; the receipted chain is unmeasured.
- **Evidence, not a gate.** D115 retires D89's gate: the receipted p95 is recorded in the PR body
  as evidence for I2b's consumer send, and I2b proceeds after I2a whatever it reads. The PR
  withdraws nothing and removes no `local-checkpoint` text from any document.
- **Relic** keeps `volatile` (`apps/relic-hunters-v1/src/game/send-relic-ws-command.ts:27-34`)
  until I2a moves it to `local-outbox`.

### 11.E The pins, the proofs and the PR body (D117)

- **The ledger** (`t/alm/al-indexeddb-transaction-ledger.test.ts:50-85`): a warm durable send's
  chain 8 to 6, total 11 to 8, `al-work` 8 to 5, so 15 operations (10 plus 5). Requests 42 to 37
  and chain parses 9 to about 4 are derived and set by measurement. The fixture takes an injected
  `nowMs` (`t/alm/outbound-runtime-test-fixture.ts:141-168`), so the window runs on a
  lane-controlled clock, not `Date.now`.
- **The cold pin** (`t/alm/al-indexeddb-operation-counts.test.ts:215-238`, 10 plus 11) is set by
  measurement; 10 plus 8 is derived.
- **Inbound** is unchanged: chain 9 or 11, total 11 or 13, `al-work` 5 or 7, `al-admission` 8.
- **Idle.** The idle pin holds at 4 `work-page` per 10 idle seconds. A new idle-window pin after a
  send counts the work a timer defers past the ledger window.
- **The proofs.** The ALM conformance lane on every carrier; the api-v1 cluster black-box profile
  and `npm run test:api-v1:black-box:postgres:medium-scale` for the server lane's lease recovery;
  Hetzner manifests 18 (with `delivery-reload`) and 22 green from the PR branch.
- **The PR body.** The ledger and cold figures before and after, the harness figures for both
  configurations with the receipted reading as I2b evidence, the recovery bounds with the tests
  that pin them, and the bundle figures for `rallar.ts` and the headless agent with any raised
  budget.

## 12. P1b constraints

The maintainer's notes for the plan, verbatim: "no migration code, avoid duplications, reuse
existing repo patterns, use repo guidance". They bind P1b beside section 3's constraints.

1. **"no migration code".** No compatibility path, no data migration and no second cadence: the
   every-batch outbound sweeps are removed in the same PR, and the stored row and schema id stay as
   they are (D3, D8).
2. **"avoid duplications".** One limiter design serves every outbound lane, browser and server, and
   one count-cap implementation lives in the cache library; ALM adds no wrapper, no second limiter
   and no ring buffer.
3. **"reuse existing repo patterns".** The sweeps take `ResourceInboxResilience`'s lock-limiter
   role on `RateLimiter`, the restore uses `InboxOutboxEngine.wakeAt`, and the hand-off uses
   `LatestRepository`, each through its public API.
4. **"use repo guidance".** The code follows `rallar-code-writing` and its `repo-code-style.md`, and
   each new mechanism first passes D8's reuse inspection against `packages/shared/cache` and
   `packages/shared/resilience`.

## 13. What P1b does not do

- **Adopt the `DequeueController`.** ALM keeps its own claim (decision 5).
- **Give inbound a cadence.** The inbound owner sweeps every batch, and its pins hold (decision 6).
- **Split inbound's observed list by status.** A zero-semantic cut of one transaction per inbound
  batch, left as a candidate.
- **Move Relic to `local-outbox`.** That moves with I2a (decision 4).
- **Withdraw I2b or read D89 as a gate.** D115 retires the gate; the receipted reading is evidence
  for I2b's consumer send, and `local-checkpoint` stays in every document (decision 4).
- **Add a generic ring buffer.** A backlog line waits for a third keyless user (decision 8).
- **Add cross-tab wakes.** Another tab's row meets the idle bound; a cross-tab wake is I2a's
  territory.
