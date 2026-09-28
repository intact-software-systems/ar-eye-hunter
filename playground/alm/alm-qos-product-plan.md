# ALM persistence and performance QoS plan

Prepared: 2026-09-28\
Reviewed source: `bdb3ecd8b` (`main` after S3b) and `bf03c965b` (the S3c-i branch, PR #605)\
Decisions: D79 to D85 in the [roadmap's decision record](alm-improvement-plan.md#decision-record)

The [complete product description](alm-complete-product-description.md) owns the product contract
and the [delivery roadmap](alm-improvement-plan.md) owns sequencing and decisions. This plan is the
design behind both for ALM's persistence and performance QoS. It replaces the QueueBox persistence
QoS plan first proposed in PR #606 (D79). That plan's profiles, acceptance scenarios and measurement
criteria map into ALM's durability vocabulary and evidence structure (section 12), and its document
is deleted. Everything here is planned for Release 4 unless a statement names shipped behaviour.

## 1. Summary

ALM has two persistence tiers today. `volatile` is the default since S3a (D2) and performs no
IndexedDB work. The durable opt-in (`local-outbox`, `local-inbox`) commits every admission before
dispatch. This plan makes performance a first-class, configurable part of ALM's QoS:

- **One durability axis** (D80): `volatile` < `local-checkpoint` < `local-outbox` < `local-inbox`,
  chosen per channel or send exactly as today. `local-checkpoint` is the only new tier. Its sender
  dispatches from memory and checkpoints its recoverable state to IndexedDB. It trades a declared
  loss and replay window for zero storage work on the send path.
- **A budget per tier** (D83): each tier's storage cost, on the send path and in the background, is
  a recorded budget pinned by tests. Pins may only fall.
- **Release 4, performance and lifetime** (D84):
  - P1 makes the durable tiers cheaper without weakening any guarantee.
  - I2a makes storage lifetime deterministic and observable for every durable tier.
  - I2b adds `local-checkpoint` only if P1 leaves a measured gap and a consumer needs it (D85).
- **One recovery rule** (D81): recovery never re-issues what the outside world has seen and never
  retracts a delivery.
- **The test plan is ALM's evidence structure** (section 9): semantic tests through real owners,
  named storage-budget pins, the conformance lane, a storage fault port, regime-classified lane
  figures, and a Relic Hunters Playwright proof.

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
  from code_ or _needs measurement_. No optimization lands without before-and-after pins and lane
  figures.
- **Two concrete slices.** P1 and I2a become concrete once Release 3 is complete. I2b stays
  outcome-shaped until its gate is decided.

## 3. The durability tiers

| Tier                     | Admission                  | Dispatch         | After a reload                                                                       | Send-path storage                                        | Receiver's store |
| ------------------------ | -------------------------- | ---------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------- | ---------------- |
| `volatile` (default)     | in memory                  | from memory      | lost                                                                                 | none                                                     | memory           |
| `local-checkpoint` (I2b) | in memory                  | from memory      | the last checkpoint; admissions after it may be lost, work finished after it repeats | none                                                     | memory           |
| `local-outbox`           | after the IndexedDB commit | after the commit | kept until its receipt or terminal outcome                                           | 10 `al-admission` and 15 `al-work` operations; P1 lowers | memory           |
| `local-inbox`            | after the IndexedDB commit | after the commit | as `local-outbox`; the receiver also commits before it acknowledges                  | as `local-outbox`, plus 8 per inbound admission          | IndexedDB        |

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
  traffic uses `volatile` or `local-outbox` (D81).
- **Wire.**
  - `local-checkpoint` joins `AL_DURABILITY_ALGOS`, so the persisted-QoS validator and the
    envelope's `qos.durability` accept it.
  - A peer on an older build refuses it as malformed, which makes this the D3 coordinated cutover.
  - Receivers route it to memory, as they do `local-outbox`.
- **One writer.** The per-session durable owner of I2a also owns the checkpoint. A second tab
  neither writes nor restores it.

## 5. The external-visibility rule

Recovery never re-issues an identity or position that anyone outside the runtime has seen for
different content, and never retracts a delivery (D81). For ALM that means four things:

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
keep their owners: the volatile bound (D74), the deadline, and the dedup window, which the
deadline now floors (section 5).

## 7. Performance model and budgets

### 7.1 Cost model

In the browser, a durable decision costs its IndexedDB operations times the main-thread latency of
each operation. It also waits in the queue behind the per-sender commit Web Lock
(`rallar:al-outbound-commit:<senderId>`).

| Fact                                                                                                                | Evidence                                                          | Label             |
| ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------- |
| A durable send spends 10 `al-admission` and 15 `al-work` operations                                                 | `packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts` | measured          |
| A durable inbound admission spends 8 operations, and a volatile one spends none                                     | the same test                                                     | measured          |
| The hosted RTC cell passes below about 30 ms per operation and fails above 35 ms; slow runners measured 48 to 55 ms | the roadmap's "Conformance lane" section                          | measured          |
| The whole ALM runtime runs on the main thread, and no Rallar package starts a worker                                | code search at `bf03c965b`                                        | proven from code  |
| No IndexedDB transaction sets a durability hint, and `QuotaExceededError` is never handled                          | code search at `bf03c965b`                                        | proven from code  |
| The lane's per-operation figure overstates a plain page's, because of the Playwright bridge                         | H1                                                                | needs measurement |

### 7.2 Budgets per tier

| Tier                          | Send-path storage budget                                                                  | Background budget                                                                                                 |
| ----------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `volatile`                    | zero `al-admission` and zero non-probe `al-work` operations (the D55 pin)                 | the durable owners' idle probes, reported                                                                         |
| `local-checkpoint`            | the same zero                                                                             | at most one readwrite transaction per checkpoint and none while clean; bytes and duration reported per checkpoint |
| `local-outbox`, `local-inbox` | today's pins, which may only fall; P1's target is recorded as a decision before P1's plan | idle probes, reported                                                                                             |

- **Latency.** It is judged under the runner-regime rule: a red counts only against a same-regime
  green baseline. Every tier's scenario reports p50 and p95 per regime for admission to dispatch and
  admission to receipt.
- **Reporting.** Every ALM PR body reports the storage figures beside the bundle figures (D83).

### 7.3 P1: the durable path's cost

P1 weakens no guarantee. Its levers come in the order the spike ranks them (section 7.5, D86), and
each lands only with before-and-after pins and figures:

1. **Take the Temporal polyfill off the storage hot path.**
   - The polyfill and its BigInt shim take about 32 % of a durable send's CPU. Most of that is in the
     date conversions of QueueBox's IndexedDB entry codec.
   - The fix is native Temporal where the browser has it, or epoch-millisecond values in the codec.
     P1's plan chooses between them.
2. **Run fewer sequential transactions.** A durable send runs 14 IndexedDB transactions today.
   Wherever the per-row fence (D17) allows it:
   - merge one admission's two read sessions;
   - skip the empty probes;
   - hand the committed canonical message to dispatch in memory;
   - skip the control reads that are empty on a first dispatch.

   Under a render loop each transaction waits for a gap between frames, so in a game page this is
   the lever that matters.
3. **Batch commits across a work batch.** Today `commitAll` batches one sender's dispatches; P1
   extends it to the whole batch.

The transaction durability hint is not a lever (D86):

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
| H5         | Not measured; it needs phones.                                                                                                                                                                                                                                                                                                                                                                                                      | Open, and needed only if D85 lets I2b go ahead.                                                                                   |

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

1. **Re-rank P1's levers.** Decided as D86 and applied in section 7.3:
   - **Take the Temporal polyfill off the storage hot path.** Use native Temporal where it exists,
     or epoch-millisecond values in the QueueBox entry codec.
   - **Run fewer sequential transactions.** In a game page, this is the lever that matters:
     - merge an admission's two read sessions;
     - skip the empty probes;
     - hand the committed canonical message to dispatch in memory;
     - skip the first-dispatch control reads.
   - **Drop the transaction durability hint as a lever.** D82's condition, a measured gain, is not
     met.
2. **Move D85's gate out of the lane.** Still open. Measure it in a plain page with a persistent
   profile, at 4× CPU, under a 10-in-16 ms frame load. Its p95 is 93.7 ms today. The lane's slow
   regime measures its harness page.
3. **Take storage-cost evidence from a persistent profile.** Still open. The lane's IndexedDB is in
   memory, so the lane stays the correctness authority but cannot measure storage cost.
4. **Checkpoint only changed rows if I2b goes ahead.** H4 is refuted, so section 7.4 already
   provides this.

### 7.6 Later outcomes

These stay outcome-shaped until evidence earns them:

- a durable owner hosted in a worker;
- a per-message persistence barrier.

## 8. Storage lifetime (I2a)

These apply to every durable tier:

- **One durable owner per session store.**
  - One tab holds a Web Lock claim on the session's durable store and drains it, and another tab
    takes over when the lock is released.
  - This extends the existing per-sender commit lock, as the roadmap's reuse inventory requires,
    rather than adding a primitive.
  - `durable-takeover` needs two pages in one browser context, which is a new harness capability.
- **No silent fallback.**
  - Today a browser without IndexedDB quietly gets memory stores for its durable pairs
    (`packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts`).
  - I2a applies the channel's `onStorageUnavailable` instead.
  - The same typed `storage-unavailable` outcome covers quota exceeded, a blocked upgrade, detected
    eviction and, for `local-checkpoint`, recovery lag beyond the bound.
- **Persistent storage.** The first durable admission in a session requests
  `navigator.storage.persist()`, and the grant is reported. Rallar never requests it today.
- **Typed recovery outcomes.**
  - `restored`, with counts.
  - `expired-at-recovery`.
  - `storage-created`. First use, eviction and deletion are indistinguishable in a browser. Safari
    deletes script-writable storage after seven days of Safari use without interaction with the
    site. This outcome is therefore reported, never presented as a successful restore.
  - `storage-reset`, for a schema mismatch (D3).
- **One health vocabulary** on the public diagnostics sink.
  - It reports `healthy`, `delayed` or `failing`, the age of the oldest unsaved change, the last
    saved recovery point and the last failure.
  - Today the storage-reset sink does nothing in production
    (`packages/shared-web/browser/connection/rallar-diagnostics-ports.ts`).
- **Scope and privacy.**
  - Rows are keyed by application scope and session. Today they are keyed by session only, in a
    database named `ar-eye-hunter-al-runtime`
    (`packages/shared-web/browser/al-runtime/browser-al-runtime-identity.ts`). The rename is a D3
    reset.
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
  `indexeddb-queuebox-operation-counts.test.ts`. Each count is the budget of section 7.2. A rise
  needs a recorded reason, and a fall lowers the pin.
- **The conformance lane** remains the acceptance authority. One scenario catalog runs over every
  carrier, and its figures are classified by runner regime.
- **A storage fault port** in the black-box browser runtime.
  - It delays, fails or quota-limits IndexedDB operations per owner (`al-admission`, `al-work`),
    extending the operation-observer seam.
  - It is a harness capability, never product behaviour, like D34's harness fields.
  - Today the lane can drop frames and hold readiness, but it cannot fault storage.
- **Performance evidence:**
  - the pins;
  - the lane observation's p50 and p95 per tier and regime;
  - the roadmap's standard storage-snapshot workload in every PR;
  - the Hetzner manifests at V1 scale.
- **A Relic Hunters Playwright spec** that operates the visible controls for the I2b consumer proof,
  as the UI behaviour rule requires.

### 9.2 Requirement to evidence

| Requirement                                                                                                  | Slice | Evidence                                                                                       |
| ------------------------------------------------------------------------------------------------------------ | ----- | ---------------------------------------------------------------------------------------------- |
| Durable send and inbound admission costs fall to P1's recorded target                                        | P1    | budget pins; `durable-opt-in` and `delivery-baseline` figures per regime                       |
| The Temporal polyfill leaves the storage hot path                                                            | P1    | before-and-after CPU profile and send-to-dispatch figures for the durable-send workload        |
| Sequential transactions per durable send fall from 14 to P1's recorded target                                | P1    | a pin on transactions per durable send, beside the budget pins                                 |
| One durable owner per session store, with takeover on release                                                | I2a   | unit: two owners on a lock fake; lane: `durable-takeover`                                      |
| Quota, a blocked upgrade or missing storage ends typed or degrades with a note, never silently               | I2a   | a unit test per cause; lane: `storage-unavailable` through the fault port                      |
| Recovery outcomes `restored`, `expired-at-recovery`, `storage-created` and `storage-reset`                   | I2a   | a unit test per outcome; lane: `delivery-reload` reads the outcome                             |
| Dedup retention covers the deadline plus the receipt grace                                                   | I2a   | unit: a replay after 60 s and inside the deadline is re-acknowledged without a second delivery |
| A purge reaches memory, storage and checkpoint, and nothing replays across sessions                          | I2a   | unit: a checkpoint after a purge writes nothing back; login over a session leaves no rows      |
| Storage health reaches the public sink                                                                       | I2a   | a unit test on the sink; the lane observation reads it                                         |
| A checkpoint is one coherent state, and an interrupted write keeps the prior point                           | I2b   | unit: abort the readwrite, then restore the prior point                                        |
| A mutation during a write reaches the next checkpoint, and an older completion never marks newer state saved | I2b   | a unit test with a held write                                                                  |
| No storage work on the `local-checkpoint` send path                                                          | I2b   | the D55 zero pin, extended to the tier                                                         |
| Checkpoint cost stays within budget, and nothing runs while clean                                            | I2b   | pin: one readwrite per checkpoint; an idle window reads zero                                   |
| The interval target holds under continuous change, and the page flushes on hide                              | I2b   | a unit test with a fake clock; lane: `flush-on-hide`                                           |
| Restore: reserved rows are retryable, expired rows settle `expired`, and there is no handle                  | I2b   | unit; lane: `checkpoint-recovery` on the reload pair                                           |
| Ordered and latest-wins sends are refused typed on `local-checkpoint`                                        | I2b   | a unit test at admission                                                                       |
| Lag beyond the bound follows `onStorageUnavailable`                                                          | I2b   | lane: `checkpoint-lag` through the fault port                                                  |
| A Relic command survives a reload mid-command                                                                | I2b   | the Relic Playwright spec; the server's dedup absorbs the replay                               |

### 9.3 Conformance scenarios

The slice that needs a scenario declares it, and each runs over every carrier:

- I2a: `durable-takeover` and `storage-unavailable`. `delivery-reload` also gains the recovery
  outcome read.
- I2b: `checkpoint-recovery`, `checkpoint-lag` and `flush-on-hide`.

The roadmap's recipe rules apply unchanged:

- distinct identities per recipe;
- per-issue command ids;
- pinned ports;
- readiness only after activation.

## 10. Delivery

### 10.1 Release 4

Release 4 follows Release 3 and precedes the arbitration, audience, scale and integration releases,
which the roadmap renumbers 5 to 8 (D84). Its slices are:

- **P1, durable-path cost:** section 7.3.
- **I2a, storage lifetime:** section 8.
- **I2b, checkpointed durability:** sections 4 and 5, behind the gate below.

The roadmap's "Releases 4 to 8" table states each slice's outcome and exit evidence.

### 10.2 The I2b gate

I2b goes ahead only if, after P1, the p95 from a `local-outbox` send to its first dispatch, in the
lane's slow regime, still exceeds 100 ms, the interactive response budget (D85).

- **Consumer.** Relic Hunters' server-addressed commands (S3c-i) are the consumer. A reload
  mid-command resumes the command, and the server's ALM dedup and AppInbox request-id idempotency
  absorb the repeat.
- **If P1 closes the gap.** Relic's commands move to `local-outbox`, and a recorded decision
  withdraws I2b and removes `local-checkpoint` from this plan.

### 10.3 Beside S3c, now

- **This plan**, with its roadmap and product-description changes, which are docs only.
- **The measurement spike** (section 7.4), on a throwaway branch.
- **No ALM code**, for three reasons:
  - S3c-ii rewrites the layer these slices change: the per-runtime memory and IndexedDB pairs and
    the per-session bound (D74).
  - The lane cannot attribute storage-cost changes to two concurrent slices.
  - The roadmap allows one active slice at a time from merged `main`.

### 10.4 Consumer proofs

- **I2a:** AR Eye Hunter's multi-tab claim of the match session, moved from I2's former row.
- **I2b:** Relic Hunters' commands (section 10.2).
- **P1:** no game changes. The lane figures are its proof.

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
