# ALM improvement roadmap

Prepared: 2026-09-05\
Revised: 2026-09-08 (re-baselined after the first release)\
Reviewed source: `a28e61b61` (`main` after [PR #521](https://github.com/intact-software-systems/ar-eye-hunter/pull/521))

## Summary and agreed decisions

This roadmap accompanies the [static audit](alm-static-audit.md), the
[complete product description](alm-complete-product-description.md), the
[PR #521 code assessment](pr-521-code-assessment.md), and the
[roadmap assessment](alm-roadmap-assessment.md). The roadmap is the durable design document for
ALM; the open pull request is the live delivery status. Only the next two implementation slices
are concrete here. Later releases stay outcome-shaped until they enter that horizon.

The goal is ALM usable for production as the complete general product: one semantic message
protocol with two first-class carriers, RTC between browsers and WS through the server, delivered
release by release and proven slice by slice through the black-box conformance lane.

### Decision record

Decided with the maintainer on 2026-09-08. Each later section applies these; none is restated as
a question.

| #  | Decision                                                                                                                                                                                                                                                                   |
| -- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1 | Target is the full general product, conformance-driven: every capability in the product description, with acceptance defined by the conformance suite over both carriers.                                                                                                  |
| D2 | A typed send with no options is reliable, receipted, and volatile: at-least-once, the receipt chosen by the channel's purpose, retried within the deadline, kept in memory only. Durability is an explicit per-channel opt-in.                                             |
| D3 | There are no real users yet. Incompatible ALM browser storage is deleted on schema mismatch; no data migration, no compatibility window.                                                                                                                                   |
| D4 | Both existing reliable paths become real ALM consumers: the game authority client awaits receipts, and the Relic server's snapshot publish moves to the durable outbox. The two games may be changed in any way that helps prove ALM.                                      |
| D5 | Every declared capability is implemented, including principal, world, all, and fixed audiences, group-leader ACK, membership fencing on group-state authority, exclusive ownership, and reply correlation with trace propagation.                                          |
| D6 | PRs are medium by default; a large coordinated PR is allowed where a cutover genuinely couples contracts, consumers, and harness. Each PR is reviewed and merged by the maintainer.                                                                                        |
| D7 | Sequencing is foundation first: the conformance lane and the storage consolidation land before new capabilities.                                                                                                                                                           |
| D8 | No legacy is retained anywhere in this series; unused code is deleted in the same PR. Search `packages/**` for an existing library before writing one; ask the maintainer before adding an internal library; never add a third-party dependency beyond those already used. |

### Standing direction

- Authenticate RTC hops and authorize room relays. Cryptographic proof of the original sender is
  outside this roadmap. Origin identity and immediate-hop identity are distinct.
- A receiver ACK confirms protocol acceptance under the promised durability policy; application
  completion requires a separate reply.
- Normal room operation is optimistic and permissive: use sufficient existing authority, make
  progress with available routes, recover from delayed observations. Missing evidence is a bounded
  waiting or recovery condition; proved lack of authority is a rejection.
- Reuse QueueBox for queued work, reservations, redelivery, and scheduling. ALM owns message
  handling, policy, validation, receipts, and recovery decisions; it does not implement another queue.
- Durable messages are self-contained: immutable facts, independently retryable derived state,
  small atomic decisions, recovery through ordinary redelivery that skips proven completed work.

## Product direction and policy

The product acceptance criterion is useful progress under ordinary uncertainty: a valid action can
proceed despite one slow browser, a delayed room snapshot, or a changing connection, and the caller
can see what remains unconfirmed. Preserve the existing
[optimistic room policy](../../packages/shared/api/group-lifecycle/group-lifecycle-policy-presets.ts)
and [permissive convergence rules](../../.agents/skills/rallar-code-writing/references/convergent-service-writing.md).
ALM consumes group and application authority; it does not create another authority or formation
layer.

### Purpose at the channel

A typed channel definition declares its purpose; the purpose fixes the defaults; a send may
override them per call.

| Purpose        | Default policy                                                                                                                           | Completion and recovery                                                                                                                           |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `realtime`     | Best-effort, volatile, freshness-first, no logical receipt. Stays on the existing direct `rallar.realtime.room` lane.                    | Replace obsolete queued values by semantic key; drop expired values.                                                                              |
| `command`      | At-least-once, volatile, 30 s deadline, receipt from the addressed receiver, 2 s ACK timeout, three receipt retries.                     | Retry within the deadline; a separate application reply establishes completion of the action.                                                     |
| `notification` | At-least-once, volatile, 30 s deadline, receipt from the complete intended audience frozen at admission, no room-wide readiness barrier. | Track every required recipient; retry only missing recipients; expose partial confirmation. One silent browser does not block delivery to others. |

Durability (`local-outbox`, `local-inbox`) is an explicit per-channel choice. Reliable volatile
delivery survives a dropped connection while its runtime lives; crash survival requires the durable
choice. Ordering, durability, reliability, audience, and transport preference remain independent. A
preferred transport may change; a required guarantee is never silently weakened: a guarantee the
selected carrier cannot provide is a typed rejection.

### Deadline

Every queued logical message has one finite deadline of its own, resolved once when the message is
constructed and carried as `constraints.expiresAtMs`. Retry, deferral, restart, and carrier fallback
preserve it; receiving a message never restarts it. The deadline is rechecked at the actual send or
delivery boundary after asynchronous readiness or authority work. Expiry stops new attempts and
cannot undo an application action that already began. The deadline is distinct from QueueBox's
next-attempt timestamp and from storage retention: retained completion, ordering, and deduplication
facts may live longer under their bounded retention policy, and their presence never extends the
message's permission to execute.

### Admission outcomes

Admission distinguishes accepted work, permitted no-ops, bounded deferral, and typed rejection.
Matching duplicates do not redeliver; their receipt is repeated when needed without growing history.
Older replaceable state is a no-op. Temporarily missing authority or a route triggers bounded refresh,
waiting, or authorized WS routing. Unverified messages never reach application delivery, forwarding,
or success receipts. Malformed, forged, wrong-scope, revoked, corrupt, and unsupported-required input
is rejected. Queue capacity and deadline exhaustion have distinct outcomes.

No receipt means **unconfirmed**, not proof of non-delivery. Results retain confirmed and
unconfirmed recipients and whether transport submission occurred. Cancellation stops remaining owned
attempts and cannot retract remote work. Expiry, supersedence, cancellation, and exhausted retries
never erase confirmed progress.

## Implementation shape and existing foundations

Follow the [repository code standard](../../.agents/skills/rallar-code-writing/references/repo-code-style.md)
and its [service-writing rules](../../.agents/skills/rallar-code-writing/references/convergent-service-writing.md).
Use this visible flow for each message-handling attempt:

```text
bounded decode -> read -> compute -> validate (Either) -> write or send -> observed result
```

- **Read:** one named read method owns the bounded repository reads for the operation and returns a
  coherent value snapshot including observed revisions. It never loads entire queues. Authority,
  policy, transport observations, and time are resolved in the owned shell and passed as values.
- **Compute:** a pure function of that snapshot and the immutable message values. No callbacks,
  repositories, clocks, randomness, asynchronous work, or mutable captured state. It produces complete
  persistence or send candidates and typed decisions as data.
- **Validate:** a separate pure function that checks the computed candidate against the read facts
  and invariants and returns `Either`, with typed issues on the left and the validated candidate on
  the right.
- **Write or send:** executes the validated value without mutating it or the snapshot. Conditional
  writes compare the exact observed predecessors. A stale observation returns a conflict as a value.
- **Owned effects:** QueueBox and AppInbox retain the transaction and redelivery rules. One delivery
  makes one attempt; a conflict returns to QueueBox, which repeats read, compute, and validate with
  fresh facts. QueueBox processing retries and ALM receipt retries are different budgets.

Expected failure is a value end to end, including control admission and effect validation. A
conflict is `'conflict'`, never an exception escaping to a transport callback. `assertXxx` is
reserved for programmer invariants. Persisted contracts have required fields. Readiness deferral uses
QueueBox's `RETRY` with a future `nextTs` and consumes no processing attempt; the release computation
inside QueueBox accounts for it, with cross-backend tests.

### Reuse inventory

| Need                                  | Existing owner                                                                                                                                                                                                                                                               | Rule                                                                                                       |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Typed validation result               | [Either](../../packages/shared/resilience/Either.ts)                                                                                                                                                                                                                         | Use directly; no parallel result abstraction.                                                              |
| Volatile and durable queued work      | [InMemoryQueueBox](../../packages/shared/queuebox/in-memory-queue-box.ts), [IndexedDbQueueBox](../../packages/shared/queuebox/indexed-db-queue-box.ts), [PostgreSQL ResourceInbox](../../packages/shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts) | Bind ALM policy and results to the existing reservation, release, expiry, and idempotency semantics.       |
| Scheduling and redelivery             | [InboxOutboxEngine](../../packages/shared/services/InboxOutboxEngine.ts), [ResourceInboxRetryPolicy](../../packages/shared/queuebox/ResourceInboxRetryPolicy.ts), [readiness](../../packages/shared/queuebox/resource-inbox/not-ready-exception.ts)                          | One QueueBox port owner for both ALM work handlers; no ALM scheduler, lease manager, or nested retry loop. |
| RTC backpressure and settlement       | [RtcDataChannelSendQueue](../../packages/shared/webrtc/rtc-data-channel-send-queue.ts), [QRtcDataChannel.SendDisposition](../../packages/shared/webrtc/qrtc-data-channel.ts)                                                                                                 | Preserve the queue owner; connect every settlement to the delivery lifecycle.                              |
| Rate and work budgets                 | [SlidingWindowCounter and RateLimiter](../../packages/shared/resilience/Resilience.ts)                                                                                                                                                                                       | Shell-level counters; pass observations as values to pure policy.                                          |
| Sequence ordering and retained state  | [computeALOrderingObservation](../../packages/shared/alm/compute-al-ordering-observation.ts), [resource limits](../../packages/shared/al-contracts/al-message-resource-limits.ts)                                                                                            | Extend the existing ordering owner; a bounded map is sufficient until measured need.                       |
| Cross-tab coordination                | Web Locks in [dispatch admission](../../packages/shared/alm/outbound/al-outbound-dispatch-admission.ts)                                                                                                                                                                      | Extend the per-sender lock with a per-session durable-work claim; no new coordination primitive.           |
| Group authority for audiences, fences | [group-state contracts](../../packages/shared/api/group-types.ts) (`snapshotVersion`, `rosterVersion`, `GroupStateCausalRevision`), [director appointment](../../packages/shared-web/browser/director/appoint-room-director.ts)                                              | ALM consumes these; it never mints its own epoch or leader.                                                |
| Exclusive claims                      | ResourceInbox reservation with lease, expiry, and redelivery                                                                                                                                                                                                                 | Surface through ALM with typed outcomes; no second claim system.                                           |
| Browser storage                       | [IndexedDB admission database](../../packages/shared/alm/open-indexed-db-admission-database.ts), [open-indexed-db](../../packages/shared/persistence/open-indexed-db.ts)                                                                                                     | Fixed two-store schema with a schema identity and delete-on-mismatch.                                      |

Decision D8 governs every gap: search first, reuse, ask before a new internal library, no new
external dependency. The [Motion buffer](../../packages/shared/rallar-motion/buffer.ts) is not a
message repair window and stays uncoupled.

## Release 1 delivered: PR #521

The first release ended with the bounded admission and QueueBox storage/retry cutover. Its
assessment lives in [pr-521-code-assessment.md](pr-521-code-assessment.md). What it settled and
what it left:

| Commitment                                     | State on `a28e61b61`                                                                                                                                     |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bounded envelope and control validation        | Delivered: one decoder, resource ceilings with UTF-8 accounting, control codec, advisory NACK as `Either`.                                               |
| Finite original deadline                       | Delivered at every write boundary in memory, IndexedDB, PostgreSQL, and the cluster bridge.                                                              |
| Retained pending admission and fresh replay    | Delivered in both directions.                                                                                                                            |
| Readiness-neutral retry accounting             | Delivered inside QueueBox.                                                                                                                               |
| Bounded ordering window with `resync-required` | Delivered; range and page repair remain.                                                                                                                 |
| Canonical outgoing message, one durable owner  | Delivered for outbound. Inbound effects still copy envelopes. The server still has two dequeue owners on one work queue. Seven whole-store reads remain. |
| Coordinated consumers and obsolete API removal | Delivered.                                                                                                                                               |
| Explicit reset of incompatible browser storage | Not delivered; the database name is unchanged and no reset mechanism exists.                                                                             |
| Truthful send outcomes                         | Transport settlement is truthful; the public send result is still an admission snapshot, and `ack: 'receiver'` still normalizes to `hop`.                |

Residual structural debt carried into release 2: two admission stores of 1,176 and 1,120 lines
pinned by checker dispositions, control-admission conflicts thrown rather than returned, the
typed-send default persisting to IndexedDB, and the base Prisma migration edited in place.

## Release 2 delivered: PRs #550 and #559

Release 2 ended with F2 merged on `f8db93762`. What it settled and what it left:

| Commitment                                      | State on `f8db93762`                                                                                                                                                                                                         |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conformance lane and messaging entry point (F1) | Delivered: the `alm-conformance` family over three carriers, `rallar-messages.ts`, the black-box delivery ledger and fault ports. The lane runs as the Release Gate's non-blocking observation job (see "Conformance lane"). |
| One work owner per side                         | Delivered: `packages/shared/alm/work/` port and generic handler; the legacy `dequeue()` path and the raw `workQueue` exposure removed.                                                                                       |
| Control admission as values                     | Delivered: `inbound/control/` and `outbound/control/`; every fence aborts with a typed value, pinned over memory, IndexedDB and PGlite.                                                                                      |
| Split admission stores without pins             | Delivered: `outbound/admission/` split; zero cognitive-load findings at or above the warn tier under `packages/shared/alm`; no new disposition.                                                                              |
| Indexed reads and key-range cleanup             | Delivered: `by-expiry` and `by-status-end` indexes, owner-keyed rows, a re-arming cleanup budget, one readiness scan per probe.                                                                                              |
| Schema identity and reset                       | Delivered: `rallar-alm-2026-09-f2`, delete-on-mismatch at open, `alm.storage.reset`.                                                                                                                                         |
| Outbound owner on slow storage                  | Delivered (F2 Task 13): one readonly session per decision surface, remembered readiness, external-writer wakes; the ws send median on the hosted runner fell from 7.4 s to 1.6 s.                                            |
| Runner regime in every artifact                 | Delivered (F2 Task 14): `alm-observation/<carrier>-<scope>.json` with `regime: normal / slow / unclassified` beside every cell.                                                                                              |
| Inbound owner on slow storage                   | Not delivered: the receiver's drain runs 5–14 s per batch in the slow regime; F2b.                                                                                                                                           |
| Truthful send outcomes                          | Unchanged: the public result is still an admission snapshot; S1.                                                                                                                                                             |

Findings carried forward: the RTC `not-yet-in-sync` delivery loss (S2); delivery-level fallback (S3);
a handler batch that can outlive `dispose()`; the eviction interval's stop handle is not consumed by
session teardown; two `'expired'` returns in the outbound commit still commit in one narrow case; the
terminal sweep's read cost over retained topics (a topic-aware index with the next schema-id move);
the `boundary.unknown` waivers around `admitIncomingMessage(value: unknown)`; the `pending-admission`
stall segment is uninstrumented on the server side.

## Release map

Thirteen PRs in six releases. Releases 2 and 3 are serial. Releases 4 to 7 depend on release 3 and
not on each other. Release 2 is delivered. F2b is file-level concrete
(`plans/alm-f2b-inbound-owner-implementation-plan.md`); S1's design proposal
([alm-s1-design-proposal.md](alm-s1-design-proposal.md)) waits on the maintainer's answers to its
section 4 before its plan is written; S2 and S3 are named by outcome; later releases are
outcome-shaped with exit evidence.

| Release       | PR                                                    | Size   | Completion criteria served |
| ------------- | ----------------------------------------------------- | ------ | -------------------------- |
| 2 Foundation  | F1 Conformance lane and messaging entry point         | medium | 1 (lane), 5 (migration)    |
| 2 Foundation  | F2 One work owner and split stores                    | large  | 5, 8, 10 (reset)           |
| 3 Slice 2     | F2b The inbound owner on slow storage                 | small  | 1 (lane), 5                |
| 3 Slice 2     | S1 Delivery lifecycle and handle                      | large  | 3, 9                       |
| 3 Slice 2     | S2 One identity and receipted audiences               | large  | 1, 3, 6, 9                 |
| 3 Slice 2     | S3 Defaults, fallback, volatile path, consumer proofs | medium | 3, 4                       |
| 4 Arbitration | R1 Shared-key proof and range repair                  | medium | 8                          |
| 4 Arbitration | R2 Membership fencing                                 | medium | 6                          |
| 5 Audiences   | A1 Principal, world, all, and fixed audiences         | medium | 7                          |
| 5 Audiences   | A2 Leader ACK and exclusive ownership                 | medium | 7                          |
| 6 Scale       | V1 Aggregate budgets and long-run fairness            | medium | 8                          |
| 7 Integration | I1 Reply correlation and trace propagation            | medium | 9                          |
| 7 Integration | I2 Deterministic lifetime                             | medium | 10                         |

### Release 2, F1: conformance lane and messaging entry point

**Outcome:** every later slice can be proven through the black-box runtime over both carriers, the
browser facade stops being the growth constraint, and the database index change reaches every
database.

**Owners:** [rallar-bb-test](../../packages/shared-test/rallar-bb-test/) (browser and control-agent
runtime, recipe schema), [black-box-runner](../../packages/shared-test/black-box-runner/) (API
recipes and the JSON runner), the black-box SPA, control server, and headless app, the Playwright
full-stack specs under `tests/playwright/rallar-black-box/`, the Hetzner manifest catalog in
`apps/rallar-black-box/src/hetzner-distributed-manifests.ts`,
`packages/shared-web/scripts/measure-browser-bundles.mjs`, and `apps/api-v1/prisma/migrations/`.

**Changes:**

1. Browser operations: `messages.send` with the full policy (transport, reliability, ack, ordering
   key, supersede key, ttl, durability, target mode) returning message id and handle id;
   `messages.observe` waiting for a handle state with timeout and returning submitted, confirmed,
   and unconfirmed evidence; `messages.cancel`; `messages.received` as a receiver-side wait with
   count and absence windows on the owned clock; `messages.receipts` for per-recipient confirmation.
   Until S1 lands the handle, `messages.observe` reports the admission snapshot; the operation
   contract is designed for the handle from the start.
2. Fault injection through narrow test-only ports in the transport adapters: drop an ACK, delay,
   close a lane, partition a peer. These ports exist only in the black-box composition.
3. `agent.reload`: the control agent reloads its page, keeps its IndexedDB, and re-registers under
   the same agent id.
4. `storage.alCounters`: an injected observer in the IndexedDB admission backend counts AL-owned
   operations per scenario.
5. The `alm-conformance` recipe family, parameterized by carrier (`rtc`, `ws`,
   `rtc-with-ws-fallback`) through the existing variable expansion, with a baseline set encoding
   today's behavior: bounded rejection, deadline expiry, duplicate no-op, ordering resync.
6. Lanes: a `smoke` subset in the Playwright memory lane run by `test:ci`; the full family over both
   carriers in the Release Gate's Postgres lane; ALM manifests at 15, 30, and 50 agents in the
   Hetzner supported set with ALM metrics (receipt latency percentiles, AL-owned IndexedDB
   operations, retained rows and bytes, retries, repairs, terminal counts). Per-PR lanes use at most
   three agents.
7. `browser/rallar-messages.ts` as a narrow entry point with its own Brotli budget.
8. Restore `20260216141946_repository/migration.sql` and add a new migration for the composite
   `resource_inbox_ix` index, with the in-memory schema mirror updated.

**Acceptance:** the baseline family passes over both carriers in the memory lane and the Postgres
lane; a deliberately broken assertion fails the lane; `agent.reload` preserves IndexedDB state;
the counter reports zero for a `realtime.room` send and a positive count for today's typed send;
`check:browser-bundles` reports the new entry; `migrate deploy` on a database at the previous
migration adds the index; `npm run test:repo-governance` passes because the harness contracts
changed.

### Release 2, F2: one work owner and split stores

**Outcome:** durable work has one owner per side, the admission stores are readable without pins,
and every later incompatible cutover has a reset mechanism.

**Owners:** [alm/inbound](../../packages/shared/alm/inbound/), [alm/outbound](../../packages/shared/alm/outbound/),
[queuebox](../../packages/shared/queuebox/), [ws-queue-box-server](../../packages/shared/services/ws-queue-box-server/),
[browser al-runtime](../../packages/shared-web/browser/al-runtime/), `scripts/repo-style-check/reviewed-dispositions.mjs`.

**Changes:**

1. Remove the legacy `dequeue()` path and its `onDequeuedDo` policy callback from the outbound
   runtime; `ALOutboundWorkHandler` is the only consumer of the outbound work queue.
2. One inbound canonical payload owner; inbound effects reference it instead of copying envelopes.
3. Replace every `getAll()` read in the IndexedDB queue box with the indexed page reader; browser
   session cleanup becomes a key-range delete.
4. One named QueueBox port owner for both work handlers, with one retry decision; delete the raw
   `workQueue` exposure and the forwarding methods on the inbound store.
5. Lift control admission out of both persistence owners into the same attempt and pending shape as
   data admission; a control conflict is `'conflict'`, never thrown.
6. Split each admission store along the control and data boundary; retire the cognitive-load pins;
   deduplicate the persisted key schema; receive the prepared-message decoder once at construction.
7. Schema identity for the ALM browser database and delete-on-mismatch at open, with the
   `alm.storage.reset` diagnostic. Unrelated storage is never touched.
8. Touched-file standards closure across the ALM folders: banned verbs, `room` in the shared
   contract, optional persisted fields, optional factory inputs.

**Acceptance:** the conformance baseline family still passes; a crash between the progress commit
and effect completion converges on redelivery; a reopened database with a stale schema id is reset
and the diagnostic is emitted; the full checker reports no cognitive-load finding at or above the
warn tier under `packages/shared/alm`; `check-changed-repo-style` passes with no new disposition;
storage snapshot for the standard workload is recorded.

### Release 3, F2b: the inbound owner on slow storage

**Outcome:** a receiver on slow storage delivers inside the conformance window, and the inbound
diagnostics say where a batch's seconds went.

**Owners:** [alm/inbound](../../packages/shared/alm/inbound/), [alm/work](../../packages/shared/alm/work/),
the inbound diagnostics contract in
[runtime-diagnostic-contract.md](../../packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md).

**Changes:**

1. Every inbound decision surface (`readIncomingMessage`, `readBufferedRelease`,
   `readStoredPlanningState`, `readOrderedDelivery`, `readControlAdmission`) reads inside one
   `readWithin` session; today each `backend.read`/`list` opens its own IndexedDB transaction, 5 to
   10+ per surface. The commit is already one fence snapshot plus one readwrite and is not where the
   cost sits.
2. The pending-admission replay carries the immutable half of the first attempt (decoded message,
   resolved deadline, validated source, effect facts) and re-reads only the authority-bearing
   surface; a retained conflict reaches its replay in the same batch when the owner is idle. The
   persisted pending contract changes, so the ALM schema id moves (D3).
3. The readiness read and the dispatch of a `dispatch-local` effect share one observation, and
   readiness is read only for the rows a batch can claim. The undispatched ws message of the
   slow-regime runs was a committed `dispatch-local` effect that only a later rotation round would
   have dispatched.
4. `effect-drain` splits into selection, claim, run, release and queue-wait durations; one
   `claim-settled` event per claim; `readiness-probe` relayed with its cause; `rotation-alive`
   reports its longest round.
5. The rotation keeps `AL_WORK_PROBE_EVERY_ROUND`: it advances one status per probe, so the
   outbound's remembered readiness does not apply; the inbound README records why.

**Acceptance:** transaction pins per surface at `['readonly']` over IndexedDB and green over memory
and PGlite; a retained conflict replayed in the same batch when idle; in a `slow` regime the
receiver's inbound drain median at or below the outbound owner's for the same cell (baseline 5.1–14.1 s
against 1.4–1.8 s) and the ws cell delivering; no harness budget changed; no new cognitive-load pin;
the regime rule decides what a red means. The lane's return to `test:ci` is the maintainer's
decision on this evidence, not part of the slice.

What the measurements corrected in the earlier F2b sentence: the two-phase cost is the pending
replay plus the readiness/dispatch pair, not the write phase; the RTC answer is emitted by the
outbound owner (treated in F2 Task 13), so the inbound fix is necessary but not the emitting side;
the 63–65 % pending share is the RTC cells (47 % on ws); probe-every-round is deliberate.

### Release 3, Slice 2: outcomes

- **S1 Delivery lifecycle and handle.** An internal per-message lifecycle fed by every RTC and WS
  settlement; a public handle with states `rejected`, `pending-authority`, `accepted`, `queued`,
  `transport-accepted`, `acknowledged`, `expired`, `superseded`, `failed`, `cancelled`, an event
  subscription, a terminal promise with evidence, and `cancel()`. The current send result and its
  status union are removed with examples, apps, and black-box contracts updated together. Late
  events never reopen a terminal state.
- **S2 One identity and receipted audiences.** Session-logical inbound namespace for dedup,
  ordering, supersedence, and message-owner keys; carrier-tagged control and ACK histories only.
  The logical audience is frozen at admission from the channel's addressed sessions and the
  identified room snapshot. ACKs carry origin and logical recipient; relays forward far ACKs toward
  the origin; the WS server aggregates broadcast ACKs and routes them to the origin connection.
  `receiver` is a logical ACK algorithm distinct from `hop`. Retry targets only missing recipients.
  Incompatible browser schema; reset via F2. API recipe for the server path. **Carried in from F2 (PR #559, maintainer-approved 2026-09-11):** an RTC message a receiver admits as `pending` (`not-yet-in-sync`) is retained until its snapshot refresh lands or the message expires, instead of being discarded, and the sender's `not-yet-in-sync` retry fires on the NACK — on the hosted runner the receiver rejected a message whose sender sat at the same snapshot version, dropped it, and the retry never ran (diagnoses `alm-observation-04f0f70a1` and `-902fa30a7` in the F2 session record; the inbound `admission-outcome` event now names the denial).
- **S3 Defaults, fallback, volatile path, consumer proofs.** Purpose at the channel with the D2
  default; carrier-aware capabilities installed in the browser composition; one memory and one
  IndexedDB backend per carrier runtime with each channel routed to one; fallback on a declared
  retryable outcome or receipt timeout within the deadline; aggregate memory, track, and intake
  budgets; zero AL-owned IndexedDB operations proven per volatile scenario. The authority client
  awaits receipts and consumes the handle; Relic snapshots move to the durable outbox with
  receipts. **Carried in from F2:** delivery-level fallback for `rtc-with-ws-fallback` — today the carrier falls back only when the RTC admission itself is refused (`no-route`, `circuit-open`); an admitted RTC send that is later dropped, rejected `not-yet-in-sync`, or never receipted is never retried over WS. The rule above (a declared retryable outcome or a receipt timeout within the deadline) needs S1's handle first.

### Releases 4 to 7: outcomes and exit evidence

| Release | Outcome                                                                                                                                                                                                                                                                                                                                              | Exit evidence                                                                                                                                                                                                    |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4 R1    | Cross-backend shared-key arbitration proved; range and page repair replace individual sequence lists; resynchronization invokes the topic's declared recovery owner with bounded cursor information.                                                                                                                                                 | A/B stale-read then sequential-commit schedule has one winner on memory, IndexedDB, and PostgreSQL; a gap beyond the window yields `resync-required` and the owner is invoked once; exhausted repair terminates. |
| 4 R2    | Membership fencing consumes group-state authority: the sender's snapshot supplies `rosterVersion` beside `minSnapshotVersion`; a receiver delivers only at or beyond that roster with the sender still a member; a receiver merely behind gets bounded catch-up; the envelope field is renamed to what it fences on and the version bumps.           | Fenced delivery, fenced rejection with typed reason, catch-up then delivery, both carriers; old envelope versions rejected explicitly.                                                                           |
| 5 A1    | Unicast, room multicast, broadcast over room, world, all, and principal, and fixed recipient lists, with RTC and WS parity; WS uses the existing server resolver; RTC resolves room and principal from the snapshot session set; world and all take the WS route automatically when fallback is allowed and are typed carrier-unsupported otherwise. | The same audience scenario over both carriers with equivalent logical outcomes; carrier-unsupported results named in the handle.                                                                                 |
| 5 A2    | `group-leader` ACK from the appointed director session, `no-leader` typed rejection without one; `ownership: 'exclusive'` as a ResourceInbox-backed claim with `claimed`, `held-by-other`, `expired`.                                                                                                                                                | Leader ACK over both carriers; two claimants, one winner, lease expiry, redelivery.                                                                                                                              |
| 6 V1    | Per-session aggregate count, byte, age, and active-track budgets; fairness under many tracks, churn, and backpressure; long-run retention.                                                                                                                                                                                                           | Hetzner manifests at 15, 30, and 50 agents with ALM metrics within declared budgets; a 60-minute diagnostic run without growth.                                                                                  |
| 7 I1    | `corrId` and `replyToMsgId` on the handle with `awaitReply({ timeoutMs })`; AppInbox trace id bridged into the envelope and preserved across retries and fallback; payload-free diagnostics.                                                                                                                                                         | Duplicate and late replies, wrong responders, timeout as `unconfirmed`, trace continuity across a fallback.                                                                                                      |
| 7 I2    | Per-session durable-work claim across tabs on Web Locks; quota, eviction, blocked upgrade, and restart as typed outcomes; a channel whose policy allows it degrades to volatile with a handle note.                                                                                                                                                  | Two tabs, one drains, takeover on release; quota exhaustion outcome; blocked upgrade outcome; reload during pending work.                                                                                        |

## Conformance lane

One scenario catalog, run over both carriers, is the acceptance authority for every release. A
scenario is proven only when its assertion establishes the guarantee. Operations and recipe schema
live in `rallar-bb-test`; scenario recipes live in the `alm-conformance` family beside the API
recipes; server-only paths use API recipes in the api-v1 Postgres profile.

Rules baked in from past runs: distinct identities per recipe because `runId` is shared per profile;
per-issue command ids because the control server replays a reissued id as success; pinned ports per
session; readiness only after activation and plans only after presence settles; scenario artifacts
named in the PR body as evidence.

Each PR adds its family: F1 baseline; S1 lifecycle matrix over every settlement and state; S2
identity and receipts with three peers, relay changes, join and leave, lost ACK, duplicate arrival
across carriers, both fallback orders; S3 volatile counters, fallback within the deadline, budgets;
R1 and R2 arbitration and fencing; A1 and A2 audiences, leader, claims; V1 scale; I1 and I2
correlation and lifetime.

**Observation status (2026-09-11, maintainer decision).** The lane runs as the Release Gate's non-blocking observation job with its budgets unchanged (`CONNECT_READINESS_TIMEOUT_MS` 30 s, the receiver window from the 18 s scenario deadline, a 10 s non-expiring send). The hosted runner's IndexedDB speed varies by about two between runs, and the rtc cell passes below roughly 30 ms per operation and fails above 35, so every artifact carries a runner-regime summary (F2 Task 14) and a red counts as a regression only against a green baseline of the same regime. **Follow-up slice, F2b — the inbound owner on slow storage:** in the slow regime the receiver's inbound drain runs 5–14 s per batch (0.3–1.1 s otherwise), the pending share of inbound admissions rises to 63–65 % on the RTC cells, and a ws message admitted as pending is committed but not dispatched before its window closes; the section "Release 3, F2b" carries the treatment, and the lane returns to `test:ci` only on its evidence. On merged `main` (`f8db93762`) every cell ran in the slow regime and all three failed with that signature.

## Storage, cutover, reset, and rollback

- **Browser.** One ALM-owned database per origin with a schema identity. A schema mismatch at open
  deletes and recreates the ALM database and emits `alm.storage.reset`. Two stores, admission and
  work, with bounded indexes. Durability is a channel property; each channel is routed to exactly one
  backend. Cross-tab commit locking stays on Web Locks; I2 adds the per-session work claim. Quota,
  eviction, and blocked upgrades are typed `storage-unavailable` outcomes.
- **Server.** PostgreSQL ResourceInbox is the only durable work owner. Schema changes are additive
  Prisma migrations; an applied migration is never edited. Per-recipient delivery facts for durable
  notifications live in the existing results tables under AppInbox until the message deadline.
  Broadcast ACKs route to the origin connection; for durable channels they are retained as receipt
  facts until the deadline when the origin is offline.
- **Cutover.** F2, S1, S2, and R2 are incompatible. Each lands contracts, consumers, examples,
  harness, and recipes together, deletes the old path, and lists in the PR body what pending ALM
  work is discarded. Web and API deploy together from `main`.
- **Rollback.** Revert the merge commit. Browsers reset on the old schema id; server migrations are
  additive; a mismatched envelope version is a typed rejection visible in diagnostics.
- **Measurement.** Every cutover PR records the storage snapshot per message state for the standard
  workload (eight updates, three recipients, 128 B, 4 KiB, and 64 KiB payloads) from the lane's
  counters and compares it with the previous PR. A regression needs a stated reason.

## Governance and delivery rules

- **Legacy.** Every affected item ends `removed` or `resolved`. No compatibility fallback, no
  browser data migration, no envelope version window.
- **Libraries.** Decision D8.
- **Bundle.** `rallar-messages.ts` has its own budget. The aggregate facade keeps the maintainer
  ruling: a crossed budget is raised to the next whole KiB with the measured figure recorded. Both
  figures appear in every PR body.
- **Checker.** After F2 no new `file.cognitive-load` pin on an ALM file. A `boundary.unknown` waiver
  only for a genuine `decodeXxx(value: unknown): Either` boundary. Every disposition entry carries
  its own comment. The exception registry is used only for its three real cases.
- **Red-head prevention.** Every commit keeps `test:unit`, the three Deno checks, and `dprint check`
  green; tests change in the same commit as the production change; the PR body names the commit each
  figure was measured on; the Branch Release Gate is green before review is requested;
  `pr:delivery status` decides the next action; `ready` and auto-merge are not used.
- **PR shape.** Goal, Changes, Acceptance, Validation, Risk and rollback, Follow-up. Acceptance names
  the conformance scenarios and API recipes; Validation names their artifacts. One active slice at a
  time from merged `main`.
- **Tests.** Semantic tests through real owners with narrow clock and transport fakes. An obsolete
  coupled test is rewritten in the same PR. `deno task check` for api-v1 runs whenever a shared type
  changes.
- **Navigation maps.** The inbound and outbound READMEs are updated in every PR that changes their
  owners and never claim behavior the code does not have.

## Consumer proofs in the games

Gameplay realtime traffic stays on `realtime.room`. Each release changes at least one game so the
new capability runs in a real UI with its own conformance recipe.

| Release  | AR Eye Hunter (browser-director)                                                                                                           | Relic Hunters (server-authoritative)                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| 3 S1     | The match capability's WS send shows pending, confirmed, and failed states from the handle.                                                | Commands move from the REST `POST` to a `command` channel over WS addressed to the server; the UI shows the outcome. |
| 3 S2     | Match lifecycle notifications (start, end, score) become a `notification` channel over RTC with WS fallback with frozen-audience receipts. | Server events become a room notification with per-session confirmation visible in server diagnostics.                |
| 3 S3     | Match commands become a `command` channel with a real director receipt, volatile, zero IndexedDB proven.                                   | Snapshots move from live-only to the durable WS outbox with receipts.                                                |
| 4 R1, R2 | Round-start notifications fenced on the current roster.                                                                                    | Round transitions use an ordering key per round with range repair.                                                   |
| 5 A1, A2 | The director is the group leader: leader ACK on match-critical notifications; pickup-style actions use exclusive ownership.                | AI suggestions addressed to a principal audience; per-player private events.                                         |
| 6 V1     | Manifests at 15, 30, and 50 agents using the match payload shapes.                                                                         | Long-run manifest with snapshot fan-out.                                                                             |
| 7 I1, I2 | Multi-tab claim of the match session.                                                                                                      | AI planning request and reply on `awaitReply` with correlation and trace.                                            |

## Requirement-to-evidence matrix

Finding identifiers are the audit's; PC numbers are the product description's completion criteria.
"Release" names where the remaining behavior lands; "State" is on `a28e61b61`.

| Requirement                            | State                                                                                        | Release           |
| -------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------- |
| F1 reliable receipts                   | Open: public result is an admission snapshot; `receiver` normalizes to `hop`.                | S1, S2, S3        |
| F2 bounded trusted ingress             | Resolved.                                                                                    | done              |
| F3 room authority                      | Partial: floors and no-floor server authorization exist; frozen audience and fencing remain. | S2, R2            |
| F4 one fallback lifecycle              | Open: same envelope, carrier-scoped inbound stores.                                          | S2, S3            |
| F5 volatile path                       | Open: every typed send persists by default.                                                  | S3, V1            |
| F6 admission work                      | Partial: exact observation CAS exists; two dequeue owners and whole-store reads remain.      | F2, R1            |
| F7 durable ownership                   | Partial: outbound canonical; inbound copies; two server consumers.                           | F2                |
| F8 indexed bounded cleanup             | Partial: indexed page reader exists; seven `getAll()` sites and a full-range cleanup scan.   | F2                |
| F9 database lifetime                   | Partial: fixed schema; no reset mechanism; multi-tab and quota untested.                     | F2, I2            |
| F10 scheduling                         | Resolved for wakes and readiness; polling bounds measured in V1.                             | V1                |
| F11 stored envelope copies             | Partial: outbound one copy; inbound copies.                                                  | F2                |
| F12 ordering gaps                      | Resolved for bounds; range repair remains.                                                   | R1                |
| F13 resource histories                 | Resolved for ceilings; aggregate budgets remain.                                             | S3, V1            |
| F14 shared-key races                   | Mechanism present; cross-backend proof remains.                                              | R1                |
| F15 affected legacy                    | Resolved for #521's scope; D8 governs the series.                                            | every PR          |
| F16 incomplete semantics               | Open: audiences, leader, fencing, correlation, ownership.                                    | R2, A1, A2, I1    |
| F17 lifecycle truth                    | Partial: settlement truthful; handle and disposal outcomes remain.                           | S1, I2            |
| PC1 carrier conformance                | Lane missing.                                                                                | F1, then every PR |
| PC2 all boundaries validated           | Resolved.                                                                                    | done              |
| PC3 honest reliability                 | Open.                                                                                        | S1, S2, S3        |
| PC4 zero-IndexedDB volatile            | Open.                                                                                        | S3                |
| PC5 bounded durable owner              | Partial.                                                                                     | F2                |
| PC6 authorized rooms                   | Partial.                                                                                     | S2, R2            |
| PC7 supported target and ACK semantics | Open.                                                                                        | A1, A2            |
| PC8 bounded protocol work              | Partial.                                                                                     | F2, R1, V1        |
| PC9 one observable identity            | Open.                                                                                        | S1, S2, I1        |
| PC10 deterministic lifetime            | Open.                                                                                        | F2, I2            |

## Validation and performance

Required layers, per PR: focused semantic tests through real owners; storage parity across memory,
IndexedDB, and real PostgreSQL where affected; the conformance family over both carriers; the
affected browser workflow; package validation (typechecks, public API snapshots, bundle boundaries,
`deno task check` for api-v1, repo style); and the reuse inspection required by D8.

```sh
npx vitest run packages/tests/shared/alm packages/tests/shared-web/al-runtime packages/tests/shared-server/al-runtime
npx tsc -p packages/shared/tsconfig.json --noEmit
npm --workspace @ar-eye-hunter/shared-web run typecheck
npm --workspace @ar-eye-hunter/shared-server run typecheck
cd apps/api-v1 && deno task check
npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles
npm run check:repo-style:changed -- origin/main HEAD
npm run test:full-stack:memory
npm run test:api-v1:black-box:postgres
npm run test:api-v1:black-box:postgres:medium-scale
```

The medium-scale and state-write gates apply to every PR that changes an authoritative mutation
path or concurrency domain, with unchanged workloads and thresholds. ALM measurements extend the
existing `messages.rtc` workload with AL-owned transactions, visited and decoded rows, bytes, work
age, retries, repairs, terminal counts, and receipt latency, recorded as p50, p95, and p99 with
environment, configuration, sample count, and failures. Serialized readback bytes are layout
evidence, not physical allocation or latency. Artifacts live under `tmp/perf/` locally and as CI
artifacts in the lanes.

## Continuing from a fresh session

Read this roadmap, then the open pull request's Goal, Acceptance, Validation, and Follow-up
sections, then run `npm run pr:delivery -- status`. The current delivery is the open F2b pull
request from branch `claude/alm-f2b-inbound-owner`; its implementation plan is
`plans/alm-f2b-inbound-owner-implementation-plan.md`, beside the ticked F1 and F2 plans. Start the
next slice from merged `main` on a new branch. Recover the current owner, entry,
dataflow, failure boundary, and tests from the repository before editing; this roadmap is not a
navigation map. When a release completes, move the next two slices into the concrete horizon here
and leave the rest outcome-shaped. Do not add pull request status prose to this document.

## Revision history

- 2026-09-05: planning deliverable against `02d65ac4a`.
- 2026-09-07: first-release merge boundary and fresh-session guidance for PR #521.
- 2026-09-08: re-baselined on `a28e61b61`; decision record D1 to D8; release map, conformance lane,
  storage and cutover, governance, consumer proofs, and refreshed matrix.
- 2026-09-11: F2 (PR #559) findings carried into S2 (pending-frame retention and the sender's `not-yet-in-sync` retry), S3 (delivery-level fallback), a follow-up slice F2b (the inbound owner on slow storage), and the lane's observation status with the runner-regime rule (F2 Task 14).
- 2026-09-11: Release 2 delivered (F2 merged as `f8db93762`); F2b moved into the concrete horizon with
  its plan under `plans/` and the measurement corrections folded in; the S1 design proposal recorded
  beside this roadmap.
