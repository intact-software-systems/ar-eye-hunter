# ALM persistence and performance QoS plan

Prepared: 2026-09-28\
Reviewed source: `bdb3ecd8b` (`main` after S3b) and `bf03c965b` (the S3c-i branch, PR #605); S3c-ii (this PR)
delivers the volatile bound its section 6 and hypothesis H4 name\
Decisions: D83 to D90, and D108 to D111 for P1, in the [roadmap's decision record](alm-improvement-plan.md#decision-record)

The [complete product description](alm-complete-product-description.md) owns the product contract
and the [delivery roadmap](alm-improvement-plan.md) owns sequencing and decisions. This plan is the
design behind both for ALM's persistence and performance QoS. It replaces the QueueBox persistence
QoS plan first proposed in PR #606 (D83). That plan's profiles, acceptance scenarios and measurement
criteria map into ALM's durability vocabulary and evidence structure (section 12), and its document
is deleted. Everything here is planned for Release 4 unless a statement names shipped behaviour.

## 1. Summary

ALM has two persistence tiers today. `volatile` is the default since S3a (D2) and performs no
IndexedDB work. The durable opt-in (`local-outbox`, `local-inbox`) commits every admission before
dispatch. This plan makes performance a first-class, configurable part of ALM's QoS:

- **One durability axis** (D84): `volatile` < `local-checkpoint` < `local-outbox` < `local-inbox`,
  chosen per channel or send exactly as today. `local-checkpoint` is the only new tier. Its sender
  dispatches from memory and checkpoints its recoverable state to IndexedDB. It trades a declared
  loss and replay window for zero storage work on the send path.
- **A budget per tier** (D87): each tier's storage cost, on the send path and in the background, is
  a recorded budget pinned by tests. Pins may only fall.
- **Release 4, performance and lifetime** (D88):
  - P1 makes the durable tiers cheaper without weakening any guarantee.
  - I2a makes storage lifetime deterministic and observable for every durable tier.
  - I2b adds `local-checkpoint` after I2a, regardless of the D89 reading: zero storage on the send
    path with crash-tolerant checkpoints and a bounded recovery lag serves a wide range of apps
    (D115).
- **One recovery rule** (D85): recovery never re-issues what the outside world has seen and never
  retracts a delivery.
- **The test plan is ALM's evidence structure** (section 9): semantic tests through real owners,
  named storage-budget pins, the conformance lane, a storage fault port, regime-classified lane
  figures, a plain-page latency harness, and a Relic Hunters Playwright proof.

## 2. Principles

- **One product, one vocabulary.**
  - Persistence is the existing `durability` aspect, and lifecycle is the S1 delivery handle.
  - Failures are the existing typed refusals and settlements, and diagnostics use the existing
    sinks.
  - No second profile vocabulary exists beside them.
- **No silent weakening** (D42 and the roadmap's product direction). When a store cannot honour a
  tier, the send is refused with a typed outcome or admitted with a note on the handle, as the
  channel declares.
- **Reuse the owners.**
  - QueueBox keeps queued execution, reservations, redelivery and scheduling.
  - The memory and IndexedDB admission backends keep their write paths.
  - Recovery reuses the lane bootstrap.
  - No second queue, persistence layer, scheduler or coordination primitive is written (D8).
- **No legacy, no migration code** (D3, D8). A persisted-shape change bumps
  `AL_ADMISSION_SCHEMA_ID`, and incompatible browser storage is deleted on mismatch and reported.
  Web and API deploy together.
- **Evidence before optimization.** Every performance claim here is labelled _measured_, _proven
  from code_ or _needs measurement_. No optimization lands without before-and-after pins and
  plain-page harness figures (D111).
- **Two concrete slices.** P1 and I2a become concrete once Release 3 is complete. I2b stays
  outcome-shaped until I2a is delivered.

## 3. The durability tiers

| Tier                     | Admission                  | Dispatch         | After a reload                                                                       | Send-path storage                                             | Receiver's store |
| ------------------------ | -------------------------- | ---------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------- | ---------------- |
| `volatile` (default)     | in memory                  | from memory      | lost                                                                                 | none                                                          | memory           |
| `local-checkpoint` (I2b) | in memory                  | from memory      | the last checkpoint; admissions after it may be lost, work finished after it repeats | none                                                          | memory           |
| `local-outbox`           | after the IndexedDB commit | after the commit | kept until its receipt or terminal outcome                                           | 10 `al-admission` and 15 `al-work` operations cold; P1 lowers | memory           |
| `local-inbox`            | after the IndexedDB commit | after the commit | as `local-outbox`; the receiver also commits before it acknowledges                  | as `local-outbox`, plus 8 per inbound admission               | IndexedDB        |

- **Acceptance after a durable commit.** A caller who needs it waits on a durable tier for the
  handle's admitted states (`AL_DELIVERY_ADMITTED_STATES`), which follow the commit.
  `evidence.admittedDurable` records the commit.
- **The retired plan's profiles.** Its "committed" profile is that usage. Its "staged" profile is
  `local-outbox` as it behaves today: the durable lane wakes its owner only after the commit
  (`packages/shared/alm/outbound/lane/al-outbound-store-lane.ts`).
- **Choosing a tier.** Use `durability` on the typed channel definition, or `qos.durability` per
  send, exactly as today. The purpose table's default stays `volatile`.
- **Receivers.** A receiver acknowledges from memory for every tier except `local-inbox`, as today.
  The ACK confirms protocol acceptance under the promised durability policy, and only `local-inbox`
  promises the receiver's storage.

### 3.1 Realtime QoS demands the tiers must serve

Realtime data puts three demands on every tier, and I2b's and A1's designs are judged against them
(D118).

| Demand                                | Mechanism today                                                                                                                                                                                                                                                 | Gap                                                                                                                                                                                                                                                                                                                                                  | Owner slice                                        |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| A strict low TTL                      | The per-send deadline (`deadlineMs` from the QoS defaults, shorter by option): past it the sender settles `expired`, a receiver drops the row, and the volatile lane sweeps at the deadline plus the receipt grace; `LatestRepository` takes a per-entry expiry | None.                                                                                                                                                                                                                                                                                                                                                | Covered; I2b keeps it across a restore (section 4) |
| Replace an unsent outgoing copy       | `latest-wins` supersedence on a `supersedenceKey` (`packages/shared/al-contracts/al-policy.ts:44,82`): the older unsent message settles `superseded`                                                                                                            | `local-checkpoint` refuses latest-wins (D85), though a superseded unsent copy was never seen outside the runtime                                                                                                                                                                                                                                     | I2b narrows D85 (section 4)                        |
| Keep only the last N copies of a type | None. The cache keeps one latest value per key; a memento value keeps undo and redo stacks of one value, bounded by `undoDepth` and `redoDepth` (`packages/shared/cache/MementoValue.ts`); a queue keeps every admitted message until its deadline              | Receiving side: a bounded history per key, as a `maxHistory` on the memento value or a generic bounded FIFO in `packages/shared/cache` shared with the memento history and the motion sample window (`packages/shared/rallar-motion/buffer.ts:306-309`). Sending side: supersedence generalised from one survivor to N, a per-key bound in the queue | I2b's plan decides the bounded FIFO                |

## 4. The `local-checkpoint` contract

- **Recovery unit.** One session's `local-checkpoint` lane: its admission rows (sent, pending-ACK,
  repair, message owner), its QueueBox work rows and its retained canonical envelopes. The unit is
  the admission-plus-work backend and never QueueBox alone, because admission facts and work commit
  together.
- **Capture and write.** The capture is taken synchronously at the memory backend's serialized write
  tail, so it is one state that existed. The write is one IndexedDB readwrite transaction that
  replaces the previous point, and its value is complete before the transaction opens. An
  interrupted write leaves the previous point intact.
- **Dispatch never waits.**
  - Admission, dispatch, receipts and cleanup run from memory.
  - At most one checkpoint is in flight, and changes made during it coalesce into the next one.
  - An older completion never marks newer state as saved.
- **Triggers.**
  - **Timer.** The first unsaved change arms one timer at the store's interval target. Later changes
    never postpone it, and nothing runs while the lane is clean.
  - **Page lifecycle.** The page also flushes on `visibilitychange` to hidden, on `pagehide` and on
    `freeze`. A hidden page's timers are throttled: Chrome runs chained timers once a minute after
    five minutes hidden unless WebRTC is in use. A frozen page runs nothing.
  - **Waiver.** The timer is a recorded waiver of the S3 rule "no new timer, queue or registry
    beyond what the outcome needs".
- **Restore.**
  - Before the lane's first work batch, the point loads into the lane's memory store
    (`InMemoryQueueBox` already accepts an initial map).
  - Reserved rows return as retryable under the existing lease rule.
  - Rows whose `expiresAtMs` passed during the downtime settle `expired` and never dispatch.
  - Restored messages have no handle, like a resumed durable message (D13, D64).
- **Restrictions.** A send with an ordering key or sequence (`seq`, `orderingKey`) or with
  latest-wins supersedence is refused with a typed `unsupported` on `local-checkpoint`. Such
  traffic uses `volatile` or `local-outbox` (D85). A superseded unsent copy was never seen outside
  the runtime, so I2b's design revisits the latest-wins refusal and narrows it to sequence and
  ordering keys (D118, section 3.1).
- **Wire.**
  - `local-checkpoint` joins `AL_DURABILITY_ALGOS`, so the persisted-QoS validator and the
    envelope's `qos.durability` accept it.
  - A peer on an older build refuses it as malformed, which makes this the D3 coordinated cutover.
  - Receivers route it to memory, as they do `local-outbox`.
- **One writer.** The per-session durable owner of I2a also owns the checkpoint. A second tab
  neither writes nor restores it.

## 5. The external-visibility rule

Recovery never re-issues an identity or position that anyone outside the runtime has seen for
different content, and never retracts a delivery (D85). For ALM that means four things:

- **Identities are unaffected.** `msgId` is a random UUID
  (`packages/shared/al-contracts/al-contract.ts`), and a restored message is re-sent with its own
  id.
- **Positions are refused.** ALM allocates no sequence numbers: `seq` and `orderingKey` come from
  the caller (D24), and browser ordering tracks are always epoch 0
  (`packages/shared/al-contracts/al-runtime.ts`).
  - An application counter restored from a checkpoint would reuse positions on the same track.
  - The receiver drops those messages as `ordering-rejected`, with neither ACK nor NACK
    (`packages/shared/al-contracts/al-policy.ts`).
  - `local-checkpoint` therefore refuses ordered and latest-wins sends.
- **Replays are duplicates.** For every tier, a receiver's dedup retention covers the message's
  deadline plus the receipt grace.
  - Today the default is a fixed 60 s window that ignores the deadline
    (`packages/shared/al-contracts/normalize-al-qos-policy.ts`).
  - The window stays as the floor: identity dedup (`msg-id`, `msg-id+sender`) holds max(window,
    deadline + grace), capped at the message-owner TTL, and `semantic-key` keeps its window. D85's
    "replacing the fixed 60 s default" reads this way (D125) (I2a design, 2026-10-01).
  - Inside the deadline, a replay meets its first admission and is re-acknowledged without a second
    delivery. After the deadline it is dropped `expired`.
  - This lands in I2a, because resumed `local-outbox` work needs it too.
- **Terminal statements may repeat.** A settlement stated before a rollback can be stated again
  after recovery. The handle does not survive a reload (D13), so the repeat reaches only
  diagnostics, which treat settlements as idempotent per `msgId`.

## 6. Settings

| Setting                    | Scope         | Values                                                                                                        | Default          |
| -------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------- | ---------------- |
| `durability`               | channel, send | `volatile`, `local-checkpoint`, `local-outbox`, `local-inbox`                                                 | `volatile` (D2)  |
| `onStorageUnavailable`     | channel       | `refuse`, ending with a typed `storage-unavailable`; `volatile`, admitted with a downgrade note on the handle | `refuse`         |
| Checkpoint interval target | session store | milliseconds                                                                                                  | set by H4 and H5 |
| Recovery-lag bound         | session store | milliseconds; beyond it the store reads `failing` and new admissions follow `onStorageUnavailable`            | set by H4 and H5 |
| Commit batch window        | session store | adopted only if P1 measures a gain                                                                            | none             |

The session-store settings belong to the browser composition root, next to the application's QoS
provider. One checkpoint and one commit path serve every channel of the session. Existing settings
keep their owners: the volatile bound (D74) (delivered by S3c-ii as `ALVolatileSessionLimits`, D92),
the deadline, and the dedup window, which the deadline now floors (section 5).

## 7. Performance model and budgets

### 7.1 Cost model

In the browser, a durable decision costs its IndexedDB operations times the main-thread latency of
each operation. It also waits in the queue behind the per-sender commit Web Lock
(`rallar:al-outbound-commit:<senderId>`).

| Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Evidence                                                                                             | Label                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ---------------------------- |
| A durable send spends 10 `al-admission` and 15 `al-work` operations on a cold runtime (the pin). A warm send spends 10 and 12, in 14 transactions (11 between `enqueueIfAbsent` and the carrier send) and 46 requests                                                                                                                                                                                                                                                                                                                                        | `packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts`; the P1 code survey's ledger probe | measured (survey 2026-09-30) |
| A durable inbound admission spends 8 `al-admission` operations, and a volatile one spends none. A warm admit-and-deliver adds 5 to 7 `al-work` in 11 to 13 transactions                                                                                                                                                                                                                                                                                                                                                                                      | the same test; the P1 code survey's ledger probe                                                     | measured (survey 2026-09-30) |
| After P1a a warm durable send spends 10 `al-admission` and 8 `al-work` operations in 11 transactions (8 between `enqueueIfAbsent` and the carrier send) and 42 requests, and a cold send 10 and 11. Its pinned window parses 9 Temporal timestamps up to the carrier and 13 up to the idle owner. The warm inbound admit-and-deliver is unchanged (11 or 13 transactions, 8 `al-admission`, 5 or 7 `al-work`) and parses 16                                                                                                                                  | `al-indexeddb-transaction-ledger.test.ts`; `al-indexeddb-operation-counts.test.ts`                   | measured (P1a, 6cfcf872c)    |
| Send-to-dispatch p50 / p95 on the plain-page harness (Apple M2 Max, HeadlessChrome 149; per invocation the median of three runs, ranged over three invocations) after P1a: idle 2.8-3.0 / 3.3-3.5 ms, 4x CPU 9.5-9.7 / 10.7-11.0 ms, 1x frame load 8.8-10.6 / 22.8-23.0 ms, 4x frame load 28.2-29.0 / 47.0-48.9 ms; before (f7902b5ac, same session): 3.3-3.4 / 3.8, 11.5-11.8 / 13.0-13.8, 10.0-12.5 / 23.4-23.6, 31.6-32.5 / 50.3-52.8 ms. The polyfill and JSBI fall from 36 % to 22-24 % of an idle page's busy CPU (0.78-0.80 to 0.37-0.39 ms per send) | `npm run perf:alm:durable-send`, three invocations per head; P1a's PR body                           | measured (P1a, 6cfcf872c)    |
| After P1b a warm durable send spends 10 `al-admission` and 5 `al-work` operations in 8 transactions (6 between `enqueueIfAbsent` and the carrier send) and 37 requests, and a cold send 10 and 9. Its pinned window parses 4 Temporal timestamps up to the carrier and 8 up to the idle owner. The warm inbound admit-and-deliver is unchanged                                                                                                                                                                                                               | `al-indexeddb-transaction-ledger.test.ts`; `al-indexeddb-operation-counts.test.ts`                   | measured (P1b, c1e7086ff)    |
| Send-to-dispatch p50 / p95 of the minimal plan on the plain-page harness after P1b (run level, nine runs per head, one session): idle 2.1-2.4 / 2.4-2.8 ms, 4x CPU 7.8-8.0 / 9.0-9.5 ms, 1x frame load 7.2-11.2 / 21.2-22.3 ms, 4x frame load 19.7-23.6 / 38.5-47.7 ms; before (9e8b9fc07): 2.6-3.0 / 2.9-3.5, 9.4-10.3 / 10.6-12.6, 7.8-13.1 / 21.8-23.5, 28.0-31.2 / 44.9-51.9 ms (both frame-load p95s within noise)                                                                                                                                      | `npm run perf:alm:durable-send`, three invocations per head; P1b's PR body                           | measured (P1b, c1e7086ff)    |
| A receipted command (durable, acknowledged by the server) after P1b: idle 2.8-2.9 / 3.3-3.7 ms, 4x CPU 9.2-9.7 / 10.5-11.7 ms, 1x frame load 7.2-10.6 / 21.5-23.1 ms, 4x frame load 23.7-28.5 / 40.4-46.7 ms (D115's reading; M2 Max, HeadlessChrome 149, not a phone); 0 of 3 240 sends over 500 ms, 179 before the ACK-timeout completion                                                                                                                                                                                                                  | the same harness, receipted plan                                                                     | measured (P1b, c1e7086ff)    |
| The hosted RTC cell passes below about 30 ms per operation and fails above 35 ms; slow runners measured 48 to 55 ms                                                                                                                                                                                                                                                                                                                                                                                                                                          | the roadmap's "Conformance lane" section                                                             | measured                     |
| The whole ALM runtime runs on the main thread, and no Rallar package starts a worker                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | code search at `bf03c965b`                                                                           | proven from code             |
| No IndexedDB transaction sets a durability hint, and `QuotaExceededError` is never handled                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | code search at `bf03c965b`                                                                           | proven from code             |
| The lane's per-operation figure overstates a plain page's, because of the Playwright bridge                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | H1                                                                                                   | needs measurement            |

### 7.2 Budgets per tier

| Tier                          | Send-path storage budget                                                  | Background budget                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `volatile`                    | zero `al-admission` and zero non-probe `al-work` operations (the D55 pin) | the durable owners' idle probes, reported                                                                         |
| `local-checkpoint`            | the same zero                                                             | at most one readwrite transaction per checkpoint and none while clean; bytes and duration reported per checkpoint |
| `local-outbox`, `local-inbox` | today's pins, which may only fall; P1's target is D109 (section 7.3)      | idle probes, reported                                                                                             |

- **Latency.** It is judged under the runner-regime rule: a red counts only against a same-regime
  green baseline. Every tier's scenario reports p50 and p95 per regime for admission to dispatch and
  admission to receipt. P1's send-to-dispatch figures come from the plain-page harness (section 9.1,
  D111); the lane gains no send-to-dispatch field.
- **Reporting.** Every ALM PR body reports the storage figures beside the bundle figures (D87).

### 7.3 P1: the durable path's cost

P1 weakens no guarantee. It ships as two serial PRs, P1a then P1b (D108), designed in the
[P1 design proposal](alm-p1-design-proposal.md). Its levers keep the spike's order (section 7.5,
D90), and each lands only with before-and-after pins and harness figures (D111):

1. **Take the Temporal polyfill off the storage hot path (P1a, D110).**
   - A warm durable send makes 233 public polyfill calls, 165 of them (71 %) in QueueBox's IndexedDB
     entry codec (`packages/shared/queuebox/indexed-db-queue-box-entry-codec.ts`); measured (survey
     2026-09-30). The spike puts the polyfill and its BigInt shim at about 32 % of a durable send's
     CPU.
   - The codec re-parses what it produced. Encode validates by parsing every string it just wrote,
     decode parses every field twice, a computed put is decoded again, and
     `isStoredQueueEntryExpired` parses the expiry although the row stores `expiryEpochMs`.
   - The fix is codec-local: parse once, validate and compare on the stored epoch-ms mirrors, never
     re-parse the codec's own output. `ResourceEntry`, the stored row, `AL_ADMISSION_SCHEMA_ID` and
     the server PostgreSQL codec are unchanged, and it works in every engine.
   - The polyfill stays in the browser bundle (section 7.6). A native alias stays a later option,
     taken only on evidence.
2. **Run fewer sequential transactions.** A warm durable send runs 14 IndexedDB transactions, and 11
   lie between `enqueueIfAbsent` and the carrier's send. Under a render loop each of those waits for
   a gap between frames, so in a game page this is the lever that matters. Two steps, each allowed
   by the per-row fence (D17):
   - **P1a, 11 to 8, no semantic change.** The decision read and the commit's observation read become
     one readonly session. The committed canonical message reaches dispatch in memory, with a read
     on a miss. Dispatch's three readonly sessions (canonical read, supersedence check,
     receipt-state read) become one.
   - **P1b, 8 to 6 on the chain and 11 to 8 in all, probes on the engine's cadence (D112, D113).**
     The finalize-exhausted sweep and the lease-timeout reserve guard one condition, a RESERVED row
     past its lease, and take the chain from 8 to 6. They run behind a lock-limiter pair per
     outbound store lane, the design QueueBox's ResourceInbox dequeuer already uses
     (`ResourceInboxResilience` on `RateLimiter`), at most once per `leaseMs` (10 s) on the lane's
     clock. The first batch after bootstrap sweeps. While a limiter is closed, the readiness scan
     treats the lease ends it would recover as not due, so no batch loops. A crashed lease or an
     exhausted row is recovered by lease end plus 19.1 s (today 6.6 s), in every outbound lane,
     api-v1's Postgres lane included; inbound sweeps every batch. The readiness probe after a batch
     is off the chain: a clean batch restores the memory its commit suspended through the engine's
     `wakeAt`, which takes the total from 9 to 8. A batch that writes a RETRY or `not-ready` row or
     retains a claim still probes, so a due retry gains 0 ms; another tab's row meets the idle
     bound, at most 6.6 s.
   - Reads are merged, never skipped. No code proof shows that a receipt cannot complete before the
     first attempt.
3. **Commit batching is not a P1 lever (D108).** `commitAll` batches one caller's
   `enqueueAllIfAbsent` group, and a work batch's first dispatches commit nothing, so batching across
   a work batch leaves a durable send's figures unchanged. Its admission-side analogue, a commit
   batch window for back-to-back single sends from one sender, stays D86's conditional setting
   (section 6).

**A recorded candidate: the fence-snapshot fold.** An admission opens a third readonly session, the
D17 fence snapshot, because the session reads drop each row's `(revision, writeToken)`. A read
session that carries them lets the snapshot merge into the decision read, one transaction less per
admission on both owners. It changes the backend contract shared with inbound, so it is decided
after P1's figures exist.

**The target (D109).** Pinned by `al-indexeddb-transaction-ledger.test.ts`, which records every
IndexedDB transaction and request of one warm durable send:

| Warm durable send | Transactions, enqueue to carrier send | Transactions in all | `al-admission` + `al-work` |
| ----------------- | ------------------------------------: | ------------------: | -------------------------- |
| Today (measured)  |                                    11 |                  14 | 10 + 12 = 22               |
| After P1a         |                             at most 8 |       11, from code | at most 10 + 8 = 18        |
| After P1b         |                             at most 6 |        8, from code | at most 10 + 5 = 15        |

- The cold pin (10 plus 15) stays beside it and falls when it can.
- Inbound gains a warm pin at today's 11 to 13 transactions and 5 to 7 `al-work` per
  admit-and-deliver, which may only fall. P1 changes no inbound-only path.

The transaction durability hint is not a lever (D90):

- Chromium's default commit already behaves as `relaxed`, and `strict` only adds cost.
- The durable owners keep the browser default, so on Chromium "committed" means the changes reached
  the operating system.

### 7.4 Measurement spike

The spike ran on 2026-09-28 on a throwaway branch that is never merged. Section 7.5 records its
findings, and the settings they fix are decided before P1's plan.

| Hypothesis                                                                         | Measurement                                                                          | Refuted when                                               |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| H1: the lane's per-operation cost overstates a plain page's                        | per-operation latency in a plain page without the Playwright bridge, same runner     | the plain page and the lane agree within the regime band   |
| H2: at least half of the 25 durable operations are avoidable reads or probes       | per-kind counts from the operation observer over one durable send                    | fewer than half are reads or probes that no decision needs |
| H3: `relaxed` commits are cheaper than `strict` or the default on Chromium         | commit latency per hint over the durable-send workload                               | no hint differs beyond run-to-run variance                 |
| H4: a checkpoint at D74's bound (1,000 admissions, 4 MiB) fits inside one interval | structured clone plus readwrite time on the main thread                              | it exceeds the proposed interval target                    |
| H5: a flush started on hide completes before a phone freezes the page              | completion rate over repeated hide-then-kill cycles on Android Chrome and iOS Safari | the rate is too low to state even as best effort           |

H4 and H5 set the interval target and the recovery-lag bound. If H4 is refuted, I2b writes only the
rows that changed.

### 7.5 Spike findings

**Setup.**

- **Environment.** Measured on `bdb3ecd8b` in headless Chromium 149, driven by Playwright 1.61, on
  an Apple M2 Max running macOS.
- **Harness.** A throwaway harness produced these figures, and it was deleted once they were
  recorded. The bullets below describe its method.
- **What runs.** It uses ALM's real durable outbound path, the lane's readiness probe, and raw
  IndexedDB transactions.
- **Samples.** Each configuration ran three times, with 90 durable sends after warm-up.
- **Latency measure.** "Send-to-dispatch" runs from `enqueueIfAbsent` to the carrier's send call.
  The owner's batch runs directly, so engine scheduling is excluded.
- **Not measured.** The hosted runner, a phone, and other browser engines.

| Hypothesis | Result                                                                                                                                                                                                                                                                                                                                                                                                                              | Verdict                                                                                                                           |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| H1         | A plain page's readiness probe takes 0.4 ms (p50) idle, 1.3 ms at 4× CPU, 2.1 ms at 8× CPU and 10 ms at most under a render-loop load. The lane's hosted slow band is 66–358 ms. IndexedDB contention and a per-operation Playwright relay add less than 1.5 ms. The lane's agents run in incognito contexts, whose IndexedDB behaved as memory: every hint measured alike, and a 4 MiB write took 1.1–3.3 s against 0.3 s on disk. | Confirmed on this machine. The lane's figures measure the load on its harness page, not ALM storage.                              |
| H2         | A steady-state durable send spends 22 logical operations (10 `al-admission`, 12 `al-work`; the pinned 15 include the cold runtime's first batch). Those are 14 IndexedDB transactions (11 readonly, 3 readwrite) and 46 requests. By call site: 3 are empty probes; 4 re-read the canonical envelope and identity already read; 6 read control history, receipt state and effects that are empty on a first dispatch.               | Confirmed. 7 of 22 are empty probes or repeats; 13 of 22 are avoidable on a first dispatch.                                       |
| H3         | On disk, Chromium's default commit behaves as `relaxed`: 0.1 and 0.2 ms (p50) per one-put commit. `strict` adds about 0.5 ms per commit, and 0.6 ms per durable send.                                                                                                                                                                                                                                                               | Refuted as a performance lever: `relaxed` gains nothing over the default. `strict` is cheap here but unmeasured on phone storage. |
| H4         | A full checkpoint at D74's bound (1,000 admissions, 4.1 MiB, 6,000 rows) spends 27 ms of main-thread time and commits in 0.28–0.30 s on disk. At 4× CPU the main-thread part is 114 ms, with long tasks of 117–153 ms. At 100 admissions (0.4 MiB) it spends 2.8 ms and commits in 26 ms.                                                                                                                                           | Refuted for slower devices: a full snapshot at the bound breaks the 100 ms budget at 4× CPU.                                      |
| H5         | Not measured; it needs phones.                                                                                                                                                                                                                                                                                                                                                                                                      | Open, and needed only if D89 lets I2b go ahead.                                                                                   |

Two measurements the hypotheses did not name:

- **In an idle page, CPU dominates, not storage.**
  - Send-to-dispatch is 4.1 ms (p50) both on disk and in memory. It is 17.4 ms at 4× CPU, and
    33.6 ms at 8× CPU (in memory).
  - A CPU profile over 300 sends puts 32 % of busy time in the Temporal polyfill (21 %) and its
    BigInt shim JSBI (11 %). IndexedDB's own `get`, `put`, `transaction` and `getAll` take about
    10 %.
  - 72 % of the polyfill time is the date conversions in QueueBox's IndexedDB entry codec
    (`packages/shared/queuebox/indexed-db-queue-box-entry-codec.ts`).
  - Chromium 149 ships native Temporal. Aliasing the polyfill to it cuts busy CPU per send by 29 %.
    Send-to-dispatch falls to 3.0 ms (−27 %), and to 13.9 ms at 4× CPU (−20 %).
- **Under a render loop, round trips dominate.**
  - With 10 ms of main-thread work in every 16 ms frame, send-to-dispatch rises to 16.8 ms (p50) and
    30.3 ms (p95).
  - At 4× CPU it rises to 78.8 and 93.7 ms, or 62.1 and 78.7 ms with native Temporal.
  - Each of the 14 sequential transactions waits for a gap between frames.

What the findings suggest, and where each stands:

1. **Re-rank P1's levers.** Decided as D90 and applied in section 7.3:
   - **Take the Temporal polyfill off the storage hot path.** Use native Temporal where it exists,
     or epoch-millisecond values in the QueueBox entry codec.
   - **Run fewer sequential transactions.** In a game page, this is the lever that matters:
     - merge an admission's two read sessions;
     - skip the empty probes;
     - hand the committed canonical message to dispatch in memory;
     - skip the first-dispatch control reads.
   - **Drop the transaction durability hint as a lever.** D86's condition, a measured gain, is not
     met.
   - **Corrected 2026-09-30 by the P1 code survey** (D108, D109): 11 of the 14 transactions lie on
     the enqueue-to-carrier chain; an admission has three readonly sessions, not two; dispatch runs
     three more; lever 3 does not touch a first send; and the empty control, receipt and effect reads
     are 7 by call site, not 6, so "13 of 22 avoidable" is an upper bound.
2. **Move D89's reading out of the lane.** Decided as D111; D115 later retired the gate, so the
   reading is evidence only. The plain-page harness of section 9.1 measures it with a persistent
   profile, at 4× CPU, under a 10-in-16 ms frame load. Its p95 is 93.7 ms today. The lane's slow
   regime measures its harness page.
3. **Take storage-cost evidence from a persistent profile.** Decided as D111 for latency. The lane's
   IndexedDB is in memory, so the lane stays the correctness authority but cannot measure storage
   cost.
4. **Checkpoint only changed rows in I2b.** H4 is refuted, so section 7.4 already provides this.

### 7.6 Later outcomes

These stay outcome-shaped until evidence earns them:

- a durable owner hosted in a worker;
- a per-message persistence barrier;
- the polyfill leaves the browser bundle: 27 modules of `rallar.ts` import it, and removal saves an
  estimated 39.7 KiB brotli (D110);
- the fence-snapshot fold (section 7.3).

## 8. Storage lifetime (I2a)

These apply to every durable tier:

- **One durable owner per session store.**
  - One tab holds a Web Lock claim on the session's durable store and drains it, and another tab
    takes over when the lock is released.
  - The claim is a second lock name on the shared BrowserLocks port, beside the unchanged
    per-sender commit lock, rather than a new primitive (D123) (I2a design, 2026-10-01).
  - A non-owner commits but runs no durable work task. A per-scope-and-session `BroadcastChannel`
    carries its commit into the owner's `work.committed(rows)`, and the owner relays settlements to
    the non-owner's handles over the same channel (D123) (I2a design, 2026-10-01).
  - `durable-takeover` needs two pages in one browser context, which is a new harness capability;
    it runs in the Playwright lane only (D124) (I2a design, 2026-10-01).
- **No silent fallback.**
  - Today a browser without IndexedDB quietly gets memory stores for its durable pairs
    (`packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts`).
  - I2a applies the channel's `onStorageUnavailable` instead.
  - The same typed `storage-unavailable` outcome covers quota exceeded, the reset's blocked delete
    (the open names no version, so no upgrade can block), detected eviction and, for
    `local-checkpoint`, recovery lag beyond the bound (I2a design, 2026-10-01).
- **Persistent storage.** The first durable admission in a session requests
  `navigator.storage.persist()`, and the grant is reported. Rallar never requests it today.
- **Typed recovery outcomes.**
  - `restored`, with counts.
  - `expired-at-recovery`.
  - `storage-created`. First use, eviction and deletion are indistinguishable in a browser. Safari
    deletes script-writable storage after seven days of Safari use without interaction with the
    site. This outcome is therefore reported, never presented as a successful restore. It holds for
    a document's first open; a creation on a reopen within one document reads `storage-reset` after
    another tab's reset, otherwise `storage-unavailable` with cause `evicted` (I2a design,
    2026-10-01).
  - `storage-reset`, for a schema mismatch (D3).
- **One health vocabulary** on the public diagnostics sink.
  - The sink is one `storage` port of four kinds, `reset`, `recovery`, `health` and `persist`,
    widening today's `onStorageReset` (D121) (I2a design, 2026-10-01).
  - It reports `healthy`, `delayed` or `failing`, the age of the oldest unsaved change, the last
    saved recovery point and the last failure.
  - Today the storage-reset sink does nothing in production
    (`packages/shared-web/browser/connection/rallar-diagnostics-ports.ts`).
- **Scope and privacy.**
  - Rows are keyed by application scope and session. Today they are keyed by session only, in a
    database named `ar-eye-hunter-al-runtime`
    (`packages/shared-web/browser/al-runtime/browser-al-runtime-identity.ts`). Each scope gets its
    own database, `rallar-al-runtime:${applicationId}:${workspaceId}`, with the keys inside
    unchanged; no row shape changes, so the schema id stays, and the legacy database is left to the
    browser's eviction, with no delete code (D120) (I2a design, 2026-10-01).
  - Logout, and login over an existing session, purge memory, storage and checkpoint in one step,
    so a later checkpoint cannot bring the rows back. Today, login over an existing session leaves
    the old rows until they expire.
  - Recovered records pass the existing bounded persisted-record decoder, and dispatch re-checks
    authority and the deadline at the send boundary.
- **Dedup retention.** It covers the deadline plus the receipt grace (section 5).

## 9. Test and evidence plan

This plan adds no separate test plan: each requirement lands in the ALM evidence layer that can
prove it. The roadmap's sections point to the table in section 9.2:

- "Conformance lane";
- "Requirement-to-evidence matrix", rows Q1 to Q3;
- "Validation and performance".

The product description's completion criteria 4, 5 and 10 carry the contract.

### 9.1 Layers

- **Semantic tests through the real memory and IndexedDB owners**, in `packages/tests/shared/alm/**`
  and `packages/tests/shared-web/**`. Modules are named by behaviour. Assertions sit at owned
  boundaries: returned values, stored rows read back, and settlements. Expectations are derived
  independently of production helpers, as `rallar-testing` requires.
- **Storage-budget pins.** The existing operation-count tests are named interaction assertions:
  `al-indexeddb-operation-counts.test.ts`, `al-storage-snapshot.test.ts` and
  `indexeddb-queuebox-operation-counts.test.ts`. P1 adds `al-indexeddb-transaction-ledger.test.ts`,
  which also pins a warm send's transactions (D109). Each count is the budget of section 7.2. A rise
  needs a recorded reason, and a fall lowers the pin.
- **The conformance lane** remains the acceptance authority. One scenario catalog runs over every
  carrier, and its figures are classified by runner regime.
- **A storage fault port** in the black-box browser runtime.
  - It delays, fails or quota-limits IndexedDB operations per owner (`al-admission`, `al-work`),
    extending the operation-observer seam.
  - It is a harness capability, never product behaviour, like D34's harness fields.
  - Today the lane can drop frames and hold readiness, but it cannot fault storage.
- **A plain-page latency harness** (D111).
  - The spike's plain page rebuilt as a Playwright manual suite: a persistent browser profile, 4x
    CPU throttle, a 10-in-16 ms frame load and the real durable outbound path.
  - It reports send-to-dispatch p50 and p95 and the CPU-profile share of the polyfill and of the
    codec. It runs locally before and after each P1 lever, and its figures go in the PR body.
  - It is owned in `tests/manual-suites.json`. It is not CI and not the lane: the lane stays the
    correctness authority, its storage is incognito, and its `perOperation` figure covers the
    admission read chain only.
- **Performance evidence:**
  - the pins;
  - the plain-page harness figures;
  - the lane observation's p50 and p95 per tier and regime;
  - the roadmap's standard storage-snapshot workload in every PR;
  - the Hetzner manifests at V1 scale.
- **A Relic Hunters Playwright spec** that operates the visible controls for the I2b consumer proof,
  as the UI behaviour rule requires.

### 9.2 Requirement to evidence

| Requirement                                                                                                  | Slice    | Evidence                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A warm durable send's operations fall from 22 to at most 18 (P1a) and 15 (P1b); inbound costs never rise     | P1a, P1b | `al-indexeddb-transaction-ledger.test.ts` (warm send and warm inbound admit-and-deliver); the cold pin in `al-indexeddb-operation-counts.test.ts` beside it |
| Transactions from `enqueueIfAbsent` to the carrier send fall from 11 to at most 8 (P1a) and 6 (P1b)          | P1a, P1b | the ledger pin; `durable-opt-in` and `delivery-baseline` unchanged in the lane                                                                              |
| The Temporal polyfill leaves the storage hot path                                                            | P1a      | the harness's CPU-profile share of the polyfill and the codec, and send-to-dispatch p50 and p95, before and after                                           |
| A probe on a cadence notices a due row, an exhausted row or a crashed lease within its stated bound          | P1b      | a fake-clock unit test per probe; the harness figures                                                                                                       |
| One durable owner per session store, with takeover on release                                                | I2a      | unit: two owners on a lock fake; lane: `durable-takeover` in the Playwright lane only (D124) (I2a design, 2026-10-01)                                       |
| Quota, the reset's blocked delete or missing storage ends typed or degrades with a note, never silently      | I2a      | a unit test per cause; lane: `storage-unavailable` through the fault port, every carrier (I2a design, 2026-10-01)                                           |
| Recovery outcomes `restored`, `expired-at-recovery`, `storage-created` and `storage-reset`                   | I2a      | a unit test per outcome; lane: `delivery-reload` reads the outcome                                                                                          |
| Dedup retention covers the deadline plus the receipt grace                                                   | I2a      | unit: a replay after 60 s and inside the deadline is re-acknowledged without a second delivery                                                              |
| A purge reaches memory, storage and checkpoint, and nothing replays across sessions                          | I2a      | unit: a checkpoint after a purge writes nothing back; login over a session leaves no rows                                                                   |
| Storage health reaches the public sink                                                                       | I2a      | a unit test on the sink; the lane observation reads it                                                                                                      |
| A checkpoint is one coherent state, and an interrupted write keeps the prior point                           | I2b      | unit: abort the readwrite, then restore the prior point                                                                                                     |
| A mutation during a write reaches the next checkpoint, and an older completion never marks newer state saved | I2b      | a unit test with a held write                                                                                                                               |
| No storage work on the `local-checkpoint` send path                                                          | I2b      | the D55 zero pin, extended to the tier                                                                                                                      |
| Checkpoint cost stays within budget, and nothing runs while clean                                            | I2b      | pin: one readwrite per checkpoint; an idle window reads zero                                                                                                |
| The interval target holds under continuous change, and the page flushes on hide                              | I2b      | a unit test with a fake clock; lane: `flush-on-hide`                                                                                                        |
| Restore: reserved rows are retryable, expired rows settle `expired`, and there is no handle                  | I2b      | unit; lane: `checkpoint-recovery` on the reload pair                                                                                                        |
| Ordered and latest-wins sends are refused typed on `local-checkpoint`                                        | I2b      | a unit test at admission                                                                                                                                    |
| Lag beyond the bound follows `onStorageUnavailable`                                                          | I2b      | lane: `checkpoint-lag` through the fault port                                                                                                               |
| A Relic command survives a reload mid-command                                                                | I2b      | the Relic Playwright spec; the server's dedup absorbs the replay                                                                                            |

### 9.3 Conformance scenarios

The slice that needs a scenario declares it, and each runs over every carrier:

- I2a: `durable-takeover` and `storage-unavailable`. `delivery-reload` also gains the recovery
  outcome read. `durable-takeover` runs in the Playwright lane only (D124) (I2a design,
  2026-10-01).
- I2b: `checkpoint-recovery`, `checkpoint-lag` and `flush-on-hide`.

The roadmap's recipe rules apply unchanged:

- distinct identities per recipe;
- per-issue command ids;
- pinned ports;
- readiness only after activation.

## 10. Delivery

### 10.1 Release 4

Release 4 follows Release 3 and precedes the arbitration, audience, scale and integration releases,
which the roadmap renumbers 5 to 8 (D88). Its slices are:

- **P1a, the codec and the send chain:** section 7.3, D108 to D111.
- **P1b, probes on the engine's cadence:** section 7.3, D112 to D117; the readiness restore, the two
  sweeps behind a lock-limiter pair per outbound lane, the hand-off on the cache library and the
  receipted reading recorded as I2b evidence.
- **I2a, storage lifetime:** section 8.
- **I2b, checkpointed durability:** sections 4 and 5, after I2a (D115).

The roadmap's "Releases 4 to 8" table states each slice's outcome and exit evidence.

### 10.2 The I2b reading

D89 made I2b conditional on the p95 from a `local-outbox` send to its first dispatch exceeding
100 ms, the interactive response budget, after P1. D115 retires that gate: I2b proceeds after I2a
whatever the reading, because zero storage on the send path with crash-tolerant checkpoints and a
bounded recovery lag serves a wide range of apps that want cheap sends and reload survival without
per-message durability. P1b still takes the reading, as evidence for I2b's consumer send: a
receipted `command`-shaped send configuration it adds to the plain-page harness (section 9.1), the
send D89 names, at 4x CPU under the 10-in-16 ms frame load, not in the lane's slow regime (D111).
P1a's harness sends a minimal plan without a hop receipt. The spike's figure of 93.7 ms came from
its own instrument; the harness read a p95 of 49.3 to 54.1 ms before P1a and 44.1 to 50.1 ms after
on the minimal plan. The reading states its machine and that it is not a phone.

- **Consumer.** Relic Hunters' server-addressed commands (S3c-i) are the consumer. A reload
  mid-command resumes the command, and the server's ALM dedup and AppInbox request-id idempotency
  absorb the repeat.
- **Relic before I2b.** Relic's commands move to `local-outbox` with I2a, whose recovery outcome
  the reload proof needs; I2b's own consumer proof comes with I2b (D115).

### 10.3 Beside S3c, now

- **This plan**, with its roadmap and product-description changes, which are docs only.
- **The measurement spike** (section 7.4), on a throwaway branch.
- **No ALM code**, for three reasons:
  - S3c-ii rewrote the layer these slices change, the per-runtime memory and IndexedDB pairs and
    the per-session bound (D74, D92); P1 and I2a start from `main` after it.
  - The lane cannot attribute storage-cost changes to two concurrent slices.
  - The roadmap allows one active slice at a time from merged `main`.

### 10.4 Consumer proofs

- **I2a:** no AR Eye Hunter proof. Its channels are volatile since S3c-ii, so there is no durable
  store to claim; `durable-takeover` and Relic's move to `local-outbox` prove I2a (D128) (I2a
  design, 2026-10-01).
- **I2b:** Relic Hunters' commands (section 10.2).
- **P1:** no game changes. The ledger pins and the harness figures are its proof.

## 11. Boundaries

- **The server is unchanged.** PostgreSQL ResourceInbox remains the only durable server owner, and
  AppInbox's rules are untouched.
- **Rallar Data and CRDT keep their own persistence.** Two follow-ups sit outside ALM:
  - Data's write-behind mode writes once per change and has no hide flush. It can reuse the
    page-lifecycle trigger.
  - CRDT could take a snapshot cadence.
- **Not promised:**
  - exactly-once effects;
  - a reload-surviving handle (D13);
  - a fixed maximum loss window;
  - persistence independent of browser storage availability.

## 12. What the retired QueueBox plan maps to

| Retired plan                                                    | This plan                                                                 |
| --------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Memory profile                                                  | `volatile` (section 3)                                                    |
| Memory with periodic checkpoints                                | `local-checkpoint` (sections 4 and 5)                                     |
| Staged profile                                                  | `local-outbox` as it behaves today (section 3)                            |
| Committed profile                                               | waiting for the admitted states on a durable tier (section 3)             |
| Interval, continued memory execution, capacity, recovery policy | section 6; capacity is D74's volatile bound; recovery is sections 4 and 8 |
| Failure and lifecycle behaviour                                 | sections 4 and 8                                                          |
| Acceptance scenarios                                            | section 9.2                                                               |
| Measurement and adoption criteria                               | sections 7.4 and 10.2                                                     |
