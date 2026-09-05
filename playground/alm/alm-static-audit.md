# ALM protocol static audit

Reviewed: 2026-09-05\
Source: `02d65ac4a458b98b92ebda22cf3ff84041027eb9`\
Original audit: 2026-08-29

This review supersedes the original audit's current-state claims. Finding IDs F1–F17 remain
stable so the [improvement roadmap](alm-improvement-plan.md) can connect each remaining gap
to implementation and validation. The [product description](alm-complete-product-description.md)
distinguishes current capabilities from the intended product.

## Executive summary

ALM has a versioned envelope, QoS normalization, ordering, deduplication, supersedence,
forwarding, ACK/NACK/repair, and atomic admission/effect persistence shared by RTC and WS.
Durable effects have claims, leases, retries, expiry, and restart replay.

The code has advanced since August 29. Browser live ingress now structurally decodes
AL envelopes. IndexedDB admission reads are readonly, prefix reads stop at the prefix
boundary, and expiry has an index. Runtime factories construct only canonical admission
stores. Ended-session QueueBox databases are deleted. RTC snapshot-floor checks and durable
replay fences exist, as do inbound disposal fences and regression tests.

The highest-priority remaining gaps are:

1. Reliable browser defaults still request no ACK. RTC also discards data-channel
   queue/drop/replacement outcomes and reports a prepared send as sent.
2. Control payloads lack a validated, authenticated admission boundary. RTC provenance and
   room authorization need explicit rules that preserve authorized relays.
3. RTC snapshot enforcement depends on a supplied `minSnapshotVersion`; unversioned room
   traffic can still reach the empty-membership fail-open policy.
4. Fallback constructs separate messages, and RTC/WS admission scopes do not establish one
   cross-carrier delivery/deduplication lifecycle.
5. Volatile ALM still uses persistent admission, durable dispatch has two work owners, and
   effect/queue selection remains proportional to stored work despite improved prefix reads.
6. Ordering gaps and protocol collections lack comprehensive bounds. Shared semantic keys
   are not fully protected by sender-specific admission guards.

These are code-derived findings. No current browser latency profile or ALM transaction-count
measurement was captured. The original numeric transaction baseline is withdrawn.

## Scope and evidence

Reviewed owners:

- [AL contracts, policy, and envelope/control decoding](../../packages/shared/al-contracts/).
- [Inbound admission and delivery](../../packages/shared/alm/inbound/) and
  [outbound admission and durable replay](../../packages/shared/alm/outbound/README.md).
- [RTC overlay manager](../../packages/shared/multicast/web-rtc-overlay-multicast-manager.ts),
  [overlay service](../../packages/shared/multicast/web-rtc-overlay-multicast-service.ts),
  [RTC receiver](../../packages/shared/services/web-rtc-rx-streamer-service.ts), and
  [data channel](../../packages/shared/webrtc/qrtc-data-channel.ts).
- [Browser WS](../../packages/shared/services/ws-queue-box-client-service.ts) and
  [server WS](../../packages/shared/services/ws-queue-box-server/ws-queue-box-server-service.ts).
- [Browser AL persistence](../../packages/shared-web/browser/al-runtime/),
  [browser QueueBox](../../packages/shared-web/browser/queuebox/),
  [IndexedDB QueueBox](../../packages/shared/queuebox/indexed-db-queue-box.ts),
  [typed browser messages](../../packages/shared-web/browser/messages/), and
  [PostgreSQL admission adapters](../../packages/shared-server/al-runtime/postgres/).

**Proven from code** means the cited implementation establishes the control flow, missing
validation, or algorithmic work; it does not establish measured runtime impact.
**Needs runtime measurement** means a performance or environment hypothesis remains unmeasured.
**Coverage inspected** means the named test and its assertions were read, not executed successfully.

The focused Vitest command could not start because the worktree had no
`node_modules/.bin/vitest` (exit 127). No runtime pass is inferred from inspected coverage.

## Current architecture

```text
typed caller
  -> carrier-specific ALMessage construction
  -> QoS / transport planning
  -> admission read -> computation -> versioned state/effect commit
  -> durable effect worker
       -> immediate RTC/WS submission, or
       -> QueueBox -> dequeue -> admission/send effect
  -> remote envelope decoder
       -> control admission, or
       -> normal admission -> local delivery / forwarding / receipt / repair
```

Browser WS, RTC reception, and RTC overlay sending have distinct runtime scopes. The browser
chooses IndexedDB when supported; volatile delivery does not select a different admission
backend. Server WS uses the shared runtimes with PostgreSQL adapters.

The [outbound navigation map](../../packages/shared/alm/outbound/README.md) now documents
construction, dispatch admission, repair admission, and the independently owned effect drain.
Former large runtime/store modules have been split. Current standards and owner-to-result
navigation govern cleanup, not the original file-size inventory.

RTC forwarding preserves the original `id.senderId`. The authenticated channel peer is the
immediate hop, which can be an authorized relay. Requiring equality for every message would
break legitimate overlay traffic. The selected trust model authorizes each hop and its
claimed origin against room authority; it does not cryptographically prove an origin against
a malicious authorized relay. Domain authority remains outside ALM.

## Ranked findings

### F1 — At-least-once has no dependable logical receipt

**Status:** Open. **Severity:** High. **Confidence:** Proven from code.

[BrowserRallarMessageSender](../../packages/shared-web/browser/messages/browser-rallar-message-sender.ts)
still defaults RTC and WS to `reliability: 'at-least-once'` with `ack: 'none'`.
`WebRtcOverlayMulticastManager.sendPreparedMessage` checks readiness, then calls
`peer.channel.send(msg)` and returns `sent`. [QRtcDataChannel](../../packages/shared/webrtc/qrtc-data-channel.ts)
exposes `sent/queued/dropped/replaced/closed`, but its older `send()` path discards those
outcomes except for the closed-channel exception. Default overflow is still `drop-new`.

**Impact:** transport submission does not establish logical receipt, and send work can
complete after a data-channel drop without an ACK-driven loss signal.

**Correction and proof:** connect structured transport outcomes to the lifecycle and require
an effective receipt for at-least-once. Cover every overflow outcome and WS disconnect, then
prove pending reliable work reaches a receipt or a truthful terminal result. Control traffic
must not create recursive ACK obligations.

### F2 — Structural decoding is present; the trust boundary is incomplete

**Status:** Partly resolved. **Severity:** High. **Confidence:** Proven from code.

[RTC live ingress](../../packages/shared/services/web-rtc-rx-streamer-service.ts) and
[browser WS ingress](../../packages/shared/services/ws-queue-box-client-service.ts) now call
`decodePersistedALMessageValue`; QueueBox read paths use `decodePersistedALMessage`. The old
RTC full-envelope log and sender-mismatch warning are gone. Server WS also decodes and
checks its resolved connection sender.

The [envelope decoder](../../packages/shared/al-contracts/al-message-persistence-validation.ts)
checks structure, known fields, version, and value shapes. It does not impose the full byte,
collection, payload-JSON, or authorization contract. [Control parsing](../../packages/shared/al-contracts/al-control.ts)
still uses unchecked JSON casts. [Inbound control handling](../../packages/shared/alm/inbound/al-inbound-message-runtime.ts)
bypasses ordinary planning and passes no authenticated transport identity into control admission.

**Correction and proof:** extend the canonical bounded boundary; validate direct/relay
provenance, control source/destination, and tracked audience before mutation. Fuzz malformed
JSON, unknown variants, oversized fields, forged controls, and valid forwarded messages
through actual RTC/WS ingress. Assert no unauthorized state changes, delivery, or payload logging.

### F3 — Unversioned RTC room messages bypass snapshot enforcement

**Status:** Partly resolved. **Severity:** High. **Confidence:** Proven from code.

[planRtcRoomSnapshotAdmission](../../packages/shared/multicast/rtc-room-snapshot-admission.ts)
checks a supplied floor against exact `GroupRef`, active status, expiry, and snapshot version.
Missing/stale snapshots disable delivery, forwarding, and ACK and produce `not-yet-in-sync`.
Durable consumption and relay replay recheck readiness.

However, `isRtcRoomSnapshotCurrent` returns true for room messages without
`minSnapshotVersion`; originating plans also bypass the inbound check.
[isLogicalRecipient](../../packages/shared/al-contracts/al-policy.ts) still permits multicast
local delivery with an empty membership set. Neither path enforces authoritative membership
epochs. Snapshot freshness alone is not origin/relay/recipient authorization.

**Correction and proof:** require room authority independently of caller-supplied floors.
Distinguish missing evidence and bounded catch-up from proved unauthorized traffic;
do not require a new server round trip when existing authority is sufficient.
Cover successful delayed-snapshot/bootstrap recovery as well as unversioned messages,
empty membership, wrong scope, removed/expired groups, disallowed relays, and replay after
membership changes. Preserve the inspected [snapshot admission](../../packages/tests/shared/multicast/rtc-room-snapshot-admission.test.ts),
[snapshot-floor](../../packages/tests/shared/rtc-snapshot-floor-admission.test.ts), and
[durable replay](../../packages/tests/shared/multicast/rtc-snapshot-durable-replay.test.ts) coverage;
replace assertions that intentionally permit the old bypass when behavior changes.

### F4 — RTC/WS fallback lacks one logical lifecycle

**Status:** Open. **Severity:** High. **Confidence:** Proven from code.

[Typed channels](../../packages/shared-web/browser/messages/browser-typed-message-channels.ts)
call separate RTC/WS send methods; each builds a new envelope. Their success helper includes
`enqueued`, `sent-immediate`, `duplicate`, `superseded`, and `skipped`, so admission status
can suppress fallback without delivery. [Browser runtime scopes](../../packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts)
also separate RTC and WS inbound admission: a shared outgoing ID alone would not establish
cross-carrier receiver deduplication.

**Correction and proof:** create one logical envelope/audience before carrier selection;
retain one deadline and terminal owner across attempts. Share receiver deduplication at
the logical session boundary. Exercise delayed first-carrier delivery, fallback, late ACKs,
duplicates, cancellation, expiry, and supersedence in both carrier orders.

### F5 — Volatile ALM still pays persistent admission cost

**Status:** Open. **Severity:** High for fast-path semantics.
**Confidence:** Proven from code; latency impact needs measurement.

[Browser store selection](../../packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts)
chooses IndexedDB by support, not per-message durability.
[Outbound computation](../../packages/shared/alm/outbound/compute-al-outbound-dispatch.ts)
creates ownership/sent state and durable send effects for immediate messages; inbound local
delivery likewise uses admitted effects. Volatile avoids a QueueBox selection, not all AL
persistence. The separate raw realtime lane must not be confused with this ALM path.

**Correction and proof:** use bounded memory for volatile best-effort ALM with the same
semantic policy. Measure actual browser ALM sends and prove zero AL-owned IndexedDB operations,
while preserving explicitly durable restart behavior.

### F6 — Admission uses separate snapshots and unbounded matching-effect selection

**Status:** Revised. **Severity:** Medium–High. **Confidence:** Proven from code;
performance ranking needs measurement.

[IndexedDbAdmissionBackend](../../packages/shared/alm/indexed-db-admission-backend.ts) now
uses [readonly snapshots](../../packages/shared/alm/read-indexed-db-admission-snapshot.ts),
with expired-row removal as a separate guarded write. Prefix reads start at a lower bound
and stop on prefix exit. Buffered writes commit under a database revision guard.

Admission still assembles state through separate reads. Both
[outbound claims](../../packages/shared/alm/outbound/al-outbound-admission-effect-store.ts)
and [inbound claims](../../packages/shared/alm/inbound/al-inbound-durable-effect-store.ts)
list/sort matching effects before limiting claims; peeking also reads matching work. A bounded
result count does not bound selection work. Shared database revision contention across
unrelated writers is a hypothesis requiring measurement.

**Correction and proof:** coherent admission snapshots and bounded due-time selection.
Measure transactions, conflicts, visited/decoded rows, and bytes. The former 12-transaction,
three-whole-store-scan outbound count and analogous inbound count are withdrawn: they do
not describe this implementation and were never a measured baseline.

### F7 — Durable RTC traverses admission effects and QueueBox

**Status:** Open. **Severity:** Medium–High. **Confidence:** Proven from code;
latency impact needs measurement.

[RTC composition](../../packages/shared-web/browser/rtc/initialise-browser-rtc-runtime.ts),
[dispatch computation](../../packages/shared/alm/outbound/compute-al-outbound-dispatch.ts), and
[outbound runtime](../../packages/shared/alm/outbound/al-outbound-message-runtime.ts) retain
admission-effect-to-QueueBox-to-dequeue-to-send-effect dispatch. Enqueue wakeups reduce
avoidable delay but do not remove the second durable work owner.

**Correction and proof:** consolidate durable ALM work into the existing QueueBox/ResourceInbox
owner. Keep ALM admission policy and validation as value computations; do not replace QueueBox
with another queue, lease manager, or retry engine. Trace atomic admission/work recording,
reservation, receipt, and retirement, including crashes between transitions. Extend canonical
QueueBox behavior where needed; independent untouched consumers remain outside the change.

### F8 — Prefix and expiry scans improved; bounded telemetry remains missing

**Status:** Original whole-store-scan mechanism resolved; residual work remains.
**Severity:** Medium. **Confidence:** Proven from code.

[Admission snapshots](../../packages/shared/alm/read-indexed-db-admission-snapshot.ts) use
prefix-bounded cursors. [Database creation](../../packages/shared/alm/open-indexed-db-admission-database.ts)
defines an expiry index, used by [browser cleanup](../../packages/shared-web/browser/al-runtime/browser-al-runtime-cleanup.ts)
for general expiry; session cleanup uses prefixes. The original unrelated-whole-store-scan
claim is no longer correct.

Matching-prefix and expired selections still materialize results without a page limit.
Cleanup's `scanned` value reports selected, filtered rows rather than complete cursor/byte telemetry.

**Correction and proof:** bounded cleanup/claim pages and separate visited, matched, deleted,
and byte counters. Seed unrelated namespaces and many eligible rows; prove namespace isolation
and hard work bounds, not merely small returned batches.

### F9 — QueueBox uses per-queue databases with explicit session deletion

**Status:** Original upgrade/never-cleaned-store claim superseded.
**Severity:** Medium. **Confidence:** Proven from code; abandoned-session cost needs measurement.

[Browser QueueBox persistence](../../packages/shared-web/browser/queuebox/browser-queuebox-persistence.ts)
creates a database per session queue. [Session termination](../../packages/shared-web/browser/session/session-auth-lifecycle.ts)
calls `deleteBrowserQueueBoxDatabasesForSession` for its four queue databases.
[Database opening](../../packages/shared/persistence/open-indexed-db.ts) creates the initial
schema and rejects incompatible existing schemas; it no longer adds session stores through
upgrades. Periodic cleanup enumerates remaining queue databases.

**Correction and proof:** bound database count and cleanup cost, including abandoned sessions
and blocked deletion. Reuse the inspected [session-deletion tests](../../packages/tests/shared-web/queuebox/browser-queuebox-persistence.test.ts).
The future fixed schema uses a coordinated explicit reset. Do not add silent schema rewrites
or assume normal sign-out proves crash cleanup.

### F10 — Wakeups exist, but polling and whole-queue reads remain

**Status:** Partly resolved. **Severity:** Medium. **Confidence:** Proven from code;
idle cost needs measurement.

[InboxOutboxEngine](../../packages/shared/services/InboxOutboxEngine.ts) supports `wake()` and
idle backoff, and browser sends wake it after queueing.
[IndexedDbQueueBox.isAnyEntryToLock](../../packages/shared/queuebox/indexed-db-queue-box.ts)
reads one collection for its work checks through
[readAllStoredQueueEntries](../../packages/shared/queuebox/indexed-db-queue-box-store.ts), which
uses `getAll()`. The original several-independent-cursor-scans description is obsolete;
periodic queue-wide reads remain.

**Correction and proof:** extend existing wakes with readiness, due-time, and cross-context
notifications, retaining a recovery poll. Use bounded indexed work queries. Measure idle ALM
storage operations and wake-to-send latency, including background tabs and lost notifications.

### F11 — Admission and QueueBox amplify envelope storage

**Status:** Open. **Severity:** Medium. **Confidence:** Proven from code;
allocation/byte impact needs measurement.

[Outbound computation](../../packages/shared/alm/outbound/compute-al-outbound-dispatch.ts)
stores sent-message state and effects containing both `msg` and prepared transport values.
Queue effects also contain serialized entries. [Inbound preparation](../../packages/shared/alm/inbound/prepare-al-inbound-commit-bundle.ts)
and [QueueBoxUtilities](../../packages/shared/services/QueueBoxUtilities.ts) retain multiple
representations for delivery.

**Correction and proof:** one canonical durable envelope referenced by compact work/receipt
state, with reusable validated serialization. Measure bytes/allocations by payload and fanout,
and prove replay does not depend on a missing ephemeral object.

### F12 — Ordering gaps remain unbounded

**Status:** Open. **Severity:** High. **Confidence:** Proven from code.

[computeALOrderingObservation](../../packages/shared/alm/compute-al-ordering-observation.ts)
still creates `Array.from({ length: seq - 1 })` for an initial gap and enumerates intermediate
sequences for subsequent gaps. The envelope decoder accepts non-negative safe integers without
an admissible-gap window. Excessive CPU/memory work can occur before admission resolves.

**Correction and proof:** return `resync-required` for out-of-window gaps without enumeration,
cap buffered count/bytes/age and aggregate ownership, and use bounded range/page repair.
Matching duplicates and obsolete replaceable state are permitted no-ops. Test boundaries and
`Number.MAX_SAFE_INTEGER`, requiring typed resynchronization and bounded work.

### F13 — Protocol collections lack complete resource bounds

**Status:** Open with resolved logging and outbound-ACK subfindings.
**Severity:** Medium–High. **Confidence:** Proven from code.

[Structural field validation](../../packages/shared/al-contracts/al-message-persistence/persisted-al-value-validation.ts)
does not impose comprehensive count/byte budgets. [Inbound control admission](../../packages/shared/alm/inbound/al-inbound-admission-store.ts)
appends ACKs; [outbound control admission](../../packages/shared/alm/outbound/al-outbound-admission-control-store.ts)
already calls `appendUniqueALAck`. NACK/repair histories and other protocol collections still
need bounds. The old full-envelope RTC receive log is removed; the shared payload-safe
lifecycle diagnostic contract is still missing.

**Correction and proof:** limit allocation and persistence before work, bound retained histories,
and deduplicate by semantic identity. Test limits, one-over-limit inputs, repeated controls,
and payload-free diagnostics.

### F14 — Sender versions do not validate shared-key predecessors

**Status:** Open. **Severity:** Medium. **Confidence:** Proven from code.

[Inbound admission](../../packages/shared/alm/inbound/al-inbound-admission-store.ts) reads
shared dedup/supersedence state, but `writeCommitBundle` validates only the sender's version
before applying computed mutations. Global IDs and explicit semantic keys can cross senders.
The IndexedDB revision is captured when the backend write begins, not when the earlier
admission decision read its shared-key predecessor.

The unsafe schedule does not require overlapping final transactions: A and B both read an
absent shared key; A commits; B begins its backend write afterward with a current backend
revision and unchanged B sender-version, then commits its stale shared-key decision.

**Correction and proof:** compare-and-set the actual shared arbitration predecessor with
explicit identity scope. Test that schedule and overlapping writers through memory, IndexedDB,
and affected PostgreSQL boundaries. Cover global, sender-scoped, and semantic keys; lock
ordering is not the acceptance criterion.

### F15 — Unused factory hydration is removed; legacy exports remain

**Status:** Partly resolved. **Severity:** Medium maintenance risk.
**Confidence:** Proven from code.

[Shared/browser factories](../../packages/shared/alm/al-runtime-stores.ts) and
[PostgreSQL factories](../../packages/shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts)
now construct admission stores only. Unused supersedence/runtime-state hydration is no longer
part of those composition paths.

[The public barrel](../../packages/shared/mod.ts) still exports older control,
ordering/dedup/supersedence, and runtime-state surfaces. Export presence alone does not prove
that every contract or implementation is unused.

**Correction and proof:** trace verified consumers, retain canonical contracts where needed,
and remove affected obsolete implementations in the approved coordinated cutover. Validate
public surfaces and consumers; do not plan already-completed construction removal again.

### F16 — Several capabilities remain incomplete or carrier-specific

**Status:** Open with snapshot-floor progress. **Severity:** Medium product completeness.
**Confidence:** Proven from code.

[Envelope/builders](../../packages/shared/al-contracts/al-contract.ts) retain correlation and
trace fields without a general request/reply or trace lifecycle. Builders do not populate AL
session/trace identity. `membershipEpoch` is copied into ordering epoch but not checked against
authoritative membership. RTC snapshot floors are enforced as described in F3.

[Shared policy](../../packages/shared/al-contracts/al-policy.ts) still maps leader and
all-recipient ACK requests to subtree behavior; generic broadcast recipient checks do not
resolve principal/world/fixed audience semantics. WS supplies specialized audience handling.
Browser RTC composition supplies no live QoS provider. The complete envelope decoder is not
exported through the broad shared barrel.

**Correction and proof:** give every promised capability a runtime owner and safe public
surface, or report it unsupported. Share topic/audience/effective-policy semantics across
carriers and verify them through conformance scenarios. Never equate ordering, formation,
and membership epochs.

### F17 — Disposal is fenced; send-result stages remain misleading

**Status:** Partly resolved. **Severity:** Medium. **Confidence:** Proven from code.

[Inbound runtime](../../packages/shared/alm/inbound/al-inbound-message-runtime.ts),
[effect worker](../../packages/shared/alm/inbound/al-inbound-durable-effect-worker.ts), and
[admitted delivery](../../packages/shared/alm/inbound/al-inbound-admitted-delivery.ts) now fence
disposal. Inspected tests cover disposal during admission/storage waits and cancellation of
pending retries. The old claim that dispose only clears one timer is false.

[Outbound computation](../../packages/shared/alm/outbound/compute-al-outbound-dispatch.ts)
still chooses `sent-immediate` before its send effect establishes transport acceptance.
Rescheduled effect failures can therefore coexist with that admission result.

**Correction and proof:** preserve disposal fixes and expose truthful staged outcomes and
terminal reasons. Extend [worker lifecycle coverage](../../packages/tests/shared/alm/al-inbound-effect-worker-lifecycle.test.ts)
with end-to-end receipt, cancellation, and restart lifecycle tests.

## Existing strengths and coverage

Retain pure policy/observation computation, atomic admission/work recording, persisted decoding,
reservation recovery and restart replay, and named outbound ownership boundaries. Preserve these
behaviors through existing QueueBox ownership rather than retaining a redundant ALM effect queue.
Use one bounded read method, value-only pure compute, pure validation returning `Either`, and
write/send that does not mutate the computed value. Existing coverage
includes normalization, ordering, ACK races, repair, Web Locks, IndexedDB replay, QueueBox
reservation, snapshot catch-up, and disposal.

Additional inspected suites include [persisted envelope decoding](../../packages/tests/shared/al-message-persistence-decoding.test.ts),
[admission backend validation](../../packages/tests/shared/alm/al-admission-backend.test.ts),
[outbound IndexedDB replay](../../packages/tests/shared/alm/al-outbound-indexeddb-replay.test.ts),
[data-channel flow control](../../packages/tests/shared/qrtc-data-channel.test.ts), and
[browser cleanup validation](../../packages/tests/shared-web/al-runtime/browser-al-runtime-cleanup-validation.test.ts).
These tests do not collectively prove the missing cross-transport product guarantees.

Dense policy/admission owners need normal touched-file standards review when changed. Do
not reproduce obsolete owner sizes, enforce historical line-count targets, or split cohesive
behavior solely to satisfy a metric.

## Measurement and validation plan

Follow [performance harness guidance](../../scripts/perf/README.md) and the
[RTC benchmark catalog](../../packages/shared-rtc-bench/README.md). The current B06
[three-browser suite](../../tests/playwright/rallar-black-box/full-stack-live-rtc-three-browser-matrix.spec.ts)
executes both raw realtime and `messages.rtc`, including delivery/reconnect/retention scenarios.
Extend it with ALM storage and lifecycle measurements. Native data-channel-only workloads
cannot isolate ALM admission costs; current B06 coverage is not an ALM transaction budget.

| Hypothesis                                     | Measurement and falsifier                                                                                                                                                     |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Volatile ALM performs persistent work.         | Count AL-owned IndexedDB operations for an actual volatile send; zero operations falsify the path claim for that measured composition.                                        |
| Durable cost grows with matching backlog.      | Hold one due message constant and increase future/done effects; bounded visited/decoded rows and bytes falsify the growth claim.                                              |
| Session history adds browser work.             | Separate sign-out from abandoned sessions; measure database count, cleanup work, blocked deletion, and idle operations. Bounded results falsify unbounded-history hypotheses. |
| Duplicate envelope representations are costly. | Measure allocations/bytes for 128 B, 4 KiB, and 64 KiB payloads with 1/4/16 peers; insignificant amplification lowers this priority.                                          |
| Shared revision fencing causes contention.     | Measure conflicts/throughput for independent namespaces and same-key writers; no unrelated conflicts falsify the contention hypothesis.                                       |

Separate cold-browser and warm-runtime cohorts. Include background tabs, two tabs sharing a
session, RTC backpressure, comparable WS envelopes, ordering gaps, quota/abort/eviction, and
restart around durable transitions. Record p50/p95/p99 transport/receipt latency, main-thread
work, storage transactions/rows/bytes, work age, retries/repairs, terminal outcomes, and exact
workload/environment. Artifacts belong under `tmp/perf/`. Do not estimate database operation
counts from this source review.

## Product priorities

1. Close bounded-input/control-trust gaps and require room authority while preserving bounded
   evidence recovery, duplicate no-ops, and optimistic room progress.
2. Establish truthful purpose-specific receipts, one fallback lifecycle, and the zero-IDB volatile path.
3. Correct shared-key arbitration and finish bounded recovery/membership fencing.
4. Harden volatile scale and consolidate durable work into existing QueueBox, with bounded storage.
5. Complete consumer-backed audiences, QoS, correlation, ownership, and diagnostics; return
   unproven general-purpose capabilities to the user for a scope decision.

The [roadmap evidence matrix](alm-improvement-plan.md#requirement-to-evidence-matrix) maps
every finding and product completion criterion to current coverage, missing proof, and a
milestone. Tests accompany each behavior change; coverage is not a final cleanup phase.
