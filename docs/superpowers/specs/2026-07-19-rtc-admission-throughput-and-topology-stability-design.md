# RTC Admission Throughput and Topology Stability Design

**Status:** Proposed production direction based on PR #40 diagnostics. This is
not implemented by the directional PR.

## Purpose

Restore bounded RTC multicast send admission under concurrent stream load and
make scaled topology readiness stable and explainable without weakening
at-least-once durability, optimistic concurrency, or public compatibility.

The work is deliberately split into two tracks:

1. local outbound admission throughput; and
2. distributed topology convergence and readiness.

The tracks share acceptance runs but not behavior commits. A local admission
change must not be used to mask topology churn, and a topology change must not
be credited with reducing IndexedDB queue time.

## Evidence

Iteration 15, a 10-agent tree at 10 Hz, produced 112 accepted stream sends with
complete outbound-runtime coverage:

- sender-queue wait p50/p95: 32,964/37,115 ms;
- browser-lock wait p50/p95: 20/1,501 ms;
- browser-lock hold p50/p95: 0/1,569 ms;
- finalization p50/p95: 833/1,610 ms;
- full send p50/p95: 20,766/32,692 ms;
- 115 claimed `enqueue-outbox` effects, all first attempt;
- zero `send-prepared` claims and zero retry claims; and
- first-attempt effect lateness at most 1,000 ms.

The local hot path is therefore the sender-wide serialized admission and its
storage transactions, not retry fairness.

The same run emitted 118 peer creations and 96 peer deletions. The passing
two-agent smoke emitted three creations and one deletion. The 15-agent current
and pre-diagnostic canary runs both emitted more than 180 creations and more
than 150 deletions. Because deletion cause and topology revision are absent
from lifecycle diagnostics, this evidence establishes churn but does not yet
attribute it to timeout, connection closure, explicit reconciliation, or stale
peer replacement.

## Goals

- Resolve a durable RTC enqueue after atomic admission ownership transfers to
  the effect worker, rather than after unrelated global drain work.
- Reduce hot-path IndexedDB transactions and prefix scans without relaxing
  compare-and-set validation.
- Preserve existing message status values while making admission versus
  delivery completion explicit.
- Expose backlog-based backpressure instead of relying on a long pending send
  promise as implicit flow control.
- Attribute every peer deletion and desired-peer change to a causal reason and
  topology tuple.
- Prevent a topology replacement from tearing down the old usable route before
  the replacement route is ready or a bounded grace period expires.
- Gate performance streams on stable topology readiness, not a momentary
  `minReadyPeers` observation.

## Non-goals

- Reducing recipe rate, increasing latency thresholds, or increasing
  `maxInFlight` to make the existing implementation pass.
- Removing durable persistence for `at-least-once` messages.
- Treating an outbox enqueue as proof of peer delivery.
- Replacing the existing optimistic commit rules with database, row, or
  advisory locks.
- Combining storage, admission-contract, and topology behavior changes in one
  remote canary.

## Admission contract

### Completion phases

Keep `ALOutboundEnqueueStatus` and `RallarMessageSendStatus` for compatibility.
Add a mandatory completion phase to results:

- `rejected`: no ownership transfer occurred;
- `admitted`: state and durable effects committed atomically, and a background
  worker owns progress;
- `transported`: an immediate volatile transport send completed before return;
  or
- `existing`: the message was already admitted or superseded.

For `admitted`, return a mandatory receipt containing the message ID, durable
effect IDs, and commit timestamp. Other phases do not fabricate a durable
receipt. The absence of a receipt is meaningful domain absence and must be
covered by consumer tests.

Existing callers may continue reading `status`. New code uses the completion
phase to distinguish admission from transport delivery. A separate
message-specific settlement API may wait for a receipt's effects when a caller
truly requires effect completion; it must not wait on the runtime's global
drain promise.

### Ownership and liveness

After an `admitted` commit, `enqueueIfAbsent(...)` requests a background drain
and returns. Pending effects remain persisted with retry time, attempt count,
lease owner, and lease expiry. Runtime startup claims ready or expired-lease
effects. A failed or interrupted worker releases ownership through lease expiry
and replay.

Session-scoped messages are replayable only in the same valid session scope.
On a new authenticated session, stale prior-session effects are expired and
observed, not transmitted with an invalid sender identity.

### Explicit backpressure

Add pending-effect and oldest-ready-age observations scoped to the outbound
runtime. Configure high and low watermarks. Admission above the high watermark
returns an explicit `backpressured` status and retry hint; it resumes only below
the low watermark. The policy is based on durable backlog, not the number of
JavaScript promises held by the black-box stream.

The existing rate limiter remains a separate requests-per-window safeguard.

## IndexedDB transaction design

### Batched admission reads

`ALOutboundAdmissionStore.readOutgoingMessage(...)` currently performs many
separately completed backend reads for version, sent state, pending ack,
repair state, control state, and supersedence state. Add a backend snapshot or
`getMany` operation so one readonly transaction reads all required keys.

The returned sender/conflict revisions remain expected values for the later
atomic commit. Every retry re-runs the planner, re-reads the complete snapshot,
and revalidates policy and invariants.

### Range-bounded scans

IndexedDB `list(prefix)` must open a key range for the prefix rather than walk
the shared object store and filter in JavaScript. Hot-path reads use readonly
transactions. Expired records encountered by a readonly query are ignored;
the existing periodic expiry sweep owns physical deletion.

Effect claim and peek operations use the runtime namespace/effect prefix range.
If profiles still show scan cost after the bounded range, add an IndexedDB
index for effect status and ready time in a schema-versioned migration.

### Conflict domains

First ship batched reads and range scans while preserving the sender-wide
version and cross-context lock. Measure again.

Only if the sender queue remains above the acceptance target, replace the
single sender version with explicit conflict domains:

- message ownership/version for duplicate admission;
- supersedence-key version when supersedence is enabled;
- ordering/ack message version for control and repair state; and
- effect ID conditional insertion for durable work.

A commit carries the expected revisions for every touched domain. Backends
validate the full set atomically. Cross-context lock acquisition, where still
required by a provider backend, uses sorted domain keys to avoid deadlock.
Independent messages then cease conflicting solely because they share a
sender.

### Fast terminal decisions

Planner work may run before sender coordination only for stateless terminal
outcomes such as malformed/missing scope, expiry, or a best-effort send with no
current route. Any path that writes durable state, uses supersedence, or claims
at-least-once ownership recomputes the plan inside every optimistic attempt.

At-least-once multicast with a temporarily absent route must be admitted for
later outbox processing or rejected with an explicit terminal policy reason;
it must not be reported as a successful skipped send.

## Topology convergence

### Causal diagnostics first

Extend peer deletion callbacks with a reason:

- `explicit-disconnect`;
- `topology-reconcile`;
- `connection-closed`;
- `establishment-timeout`;
- `lane-open-failure`;
- `stale-peer-replacement`; or
- `runtime-dispose`.

Lifecycle events include the peer ID, lane states, owning group refs, desired
peer status, and the active topology causal tuple
`sourceGroupStateRevision + overlayVersion`. Reconciliation emits the previous
and next desired sets and their set difference.

`overlays-repository.setOverlayById(...)` returns whether a snapshot was
accepted, unchanged, stale, or conflicting. Browser cache handling requests a
reconciliation only after an accepted causal change.

### Make-before-break replacement

When an accepted topology snapshot changes next hops, retain old usable peers
as transition peers. Start replacement connections first. Disconnect an old
peer only when all required replacement lanes are open or when a bounded
transition grace period expires. A newer topology tuple supersedes the pending
transition and is recomputed from current live state.

The transition budget remains subject to `maxPeerConnections`. When both old
and new sets cannot fit, evict deterministically and emit the capacity reason.
No transition loop may reconnect a peer whose attempt budget is cooling down.

### Stable readiness

Extend RTC readiness with:

- lane ID;
- topology causal tuple;
- expected or minimum ready peers;
- `stableForMs`; and
- no desired-set change, deletion, or lane close during that interval.

The black-box controller starts `rtc.stream` only after every participating
agent satisfies the same stable topology generation. A failed agent aborts the
performance sample; it is reported as topology evidence rather than folded
into scheduler latency.

## Observability

Keep PR #40 diagnostics and add bounded aggregates for:

- admission snapshot read, commit, queue, and receipt-return duration;
- IndexedDB transaction count and keys read per admission;
- prefix scan rows visited versus rows matched;
- pending effect count and oldest-ready age;
- topology generation changes and desired-peer diffs;
- peer deletion reasons; and
- transition start, ready, superseded, timeout, and capacity eviction.

Artifact analysis must continue rejecting zero, missing, or ambiguous accepted
send samples. Skipped/no-route outcomes remain separate from completions.

## Rollout and acceptance

Each stage is a separate commit and canary:

1. diagnostic attribution and stable-gate support;
2. batched IndexedDB reads and range scans;
3. admitted-return semantics plus explicit backlog backpressure;
4. make-before-break topology replacement; and
5. finer conflict domains only if stage 2-3 evidence still requires them.

Focused correctness and recovery tests run before performance measurements.
The distributed ladder is two-agent smoke, 10-agent tree, then 15-agent tree.
Both scaled manifests must satisfy their existing success-ratio, drop, p95,
and p99 thresholds with zero analyzer evidence errors. Performance samples are
invalid unless every agent first satisfies stable readiness.

Generated benchmarks and profiles remain under `tmp/perf/` and are not
committed.
