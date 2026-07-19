# RTC Outbound Scheduler Direction Diagnostics Design

## Status

The measurement design was approved on 2026-07-19 and is awaiting review in
this written form before implementation. It starts a second diagnostic series
on draft PR #40. The series may use at most ten additional remote runs,
numbered 11 through 20 overall. No second-series run has been consumed yet.

## Purpose

The first ten runs reduced aggregate RTC stream latency but did not satisfy the
unchanged per-stream p95 and p99 gates. Iteration 10 completed 1,918 of 1,950
attempted frames with no drops, at p50 536 ms, p95 4,026 ms, and p99 6,600 ms.
The remaining latency correlated with durable-effect drain activity, but the
current events cannot distinguish the original `enqueue` admission call from a
later `dequeue` delivery call because both phases reuse the same message ID.

The next run must identify which code boundary should change before another
performance correction is attempted. It will measure, without changing
runtime behavior:

1. which commit intent and dispatch phase performed finalization;
2. whether finalization awaited a drain or delegated to an existing background
   drain;
3. which durable-effect kinds and attempt classes occupied each drain; and
4. how late fresh and retry effects were when claimed.

The result is directional evidence for a later production design and
implementation plan. The draft PR is not presented as the final architecture.

## Evidence and rejected shortcuts

Iteration 10 exported 11,236 claims, 3,585 completions, and 7,628 reschedules.
Across 2,057 correlated completed stream messages, own sender-queue wait was
p95 1,161 ms, browser-lock time was p95 252 ms, and overlapping drain time was
p95 2,644 ms. Duration correlated 0.965 with overlapping drain time.

A read-only reconstruction using the latest pre-completion lock event found
that messages provisionally classified as using an existing drain had p95
3,101 ms, while those provisionally classified as starting a drain had p95
3,546 ms. The slowest messages occurred in both groups and were usually seen in
rescheduling drains. This refutes treating unconditional enqueue completion as
the complete answer. The reconstruction is not authoritative because later
outbox dequeue work emits lock events for the same message ID.

Three approaches were considered:

1. **Instrument intent, finalization, and drain composition (selected).** One
   unchanged run can discriminate between completion coupling, scheduler
   head-of-line blocking, and a lower storage/coordination boundary.
2. **Return every persisted enqueue immediately.** This is a plausible API
   correction, but the existing fast path already contains some of the slowest
   frames, so applying it alone could hide the remaining scheduler problem.
3. **Prioritize fresh effects immediately.** A previous fresh/retry quota
   regressed latency and first-drain delay. Another scheduler policy without
   effect-kind and attempt evidence would repeat that speculative change.

## Diagnostic contracts

### Outbound finalization event

Extend `ALOutboundRuntimeDiagnosticsEvent` with an
`outbound-finalization` variant. It contains mandatory fields:

- `message`: the existing message identity summary;
- `intent`: `enqueue`, `dequeue`, or `repair`;
- `phase`: `immediate` or `dequeue`;
- `resultStatus`: the computed outbound status;
- `mode`: `background-existing-drain`, `awaited-existing-drain`,
  `awaited-new-drain`, or `deferred`;
- `hadActiveDrain`: whether an effect-drain promise existed at the decision
  boundary; and
- `durationMs`: time spent in finalization after the durable commit.

The event is emitted only for a committed bundle. `deferred` represents the
existing internal callers that explicitly postpone effect draining. The event
does not alter the returned result or expose prepared payloads.

### Effect-drain composition

Extend the existing `effect-drain` event with mandatory aggregate fields:

- claimed, completed, and rescheduled counts by durable-effect kind;
- claimed first-attempt count (`attempts === 1` after claim);
- claimed retry-attempt count (`attempts > 1`); and
- fixed-bucket ready-lateness histograms for first attempts and retries.

Ready lateness is `max(0, claimStartedAtMs - retryAtMs)`. Histograms use
mutually exclusive upper-bound buckets so the runtime performs constant-time
accounting and does not emit an unbounded per-effect diagnostic array. Each
claim increments only the first matching bucket: at most 0, 10, 50, 100, 250,
500, 1,000, 2,500, or 5,000 ms, or greater than 5,000 ms.

All effect kinds remain explicit in the aggregate contract even when their
count is zero. This keeps the authoritative diagnostic shape complete and
allows artifact analysis without compatibility inference.

## Components and data flow

`ALOutboundMessageRuntime.commitDispatchPlanWithRetry(...)` owns the
finalization decision. Immediately after a successful commit it records the
existing-drain state, executes the existing branch unchanged, and emits the
finalization event after that branch settles. The diagnostic duration excludes
sender-queue and browser-lock time, which already have separate events.

`runDurableEffectDrainLoop(...)` owns effect composition. When it receives each
claimed effect, it updates kind, attempt-class, and lateness aggregates. After
settlement it attributes the final completed or rescheduled outcome to the
effect kind. Its existing `effect-drain` event publishes the aggregates once
at drain completion.

The existing optional diagnostics sink, Rallar operation options, and
black-box browser adapter already forward the discriminated event unchanged to
`rallar.browser.al.outbound_runtime`. No new transport topic or artifact
contract is required.

The offline analyzer joins `outbound-finalization` events to
`rallar.browser.messages.rtc.send_completed` by agent and message ID. It selects
only nested `status: enqueued` transport outcomes, excluding skipped sends, and
the earliest committed `intent: enqueue`, `phase: immediate` event for that
message no later than the completion event; later `dequeue` and retry events are
analyzed separately. A missing or ambiguous enqueue match is reported as an
evidence-coverage error. Drain composition is summarized per agent and for the
fleet.

## Runtime safety and failure handling

- Diagnostics remain optional. Aggregate allocation and accounting occur only
  when a diagnostics sink is installed.
- Diagnostic sink exceptions continue to be caught by `emitDiagnostics(...)`
  and cannot change dispatch behavior.
- No claim ordering, retry delay, drain lifecycle, delivery guarantee,
  persistence policy, or recipe threshold changes in the measurement commit.
- Diagnostic aggregates contain counts and histograms only; prepared messages
  and resource payloads are not exported.
- A remote result with malformed diagnostic rows, missing mandatory fields, or
  insufficient finalization coverage is rejected as an evidence-quality
  failure and is not used to select a performance correction.

## Testing

Add focused runtime tests that first fail against the current implementation
and then prove:

1. a persisted enqueue with no active drain emits `awaited-new-drain`;
2. a persisted enqueue during an active drain emits
   `background-existing-drain` and returns before that drain settles;
3. an immediate prepared send preserves synchronous completion and emits its
   awaited mode;
4. a deferred internal commit emits `deferred` without starting a drain; and
5. effect-drain diagnostics correctly distinguish effect kinds, first
   attempts, retries, outcomes, and lateness buckets.

Run the focused outbound runtime and IndexedDB tests, RTC overlay and multicast
regressions, browser option/adapter tests, and the shared/shared-web/
shared-server/shared-test type checks before publishing iteration 11.

## Iteration 11 decision rules

Use the unchanged 15-agent GitHub-Free manifest, 5 Hz rate, 150 frames per
stream, topology, delivery semantics, and latency thresholds.

Select the next code direction as follows:

- **Completion boundary:** persisted `enqueue` finalization duration explains
  the slow tail while its committed effects are already durable. Plan an API
  contract in which persistent admission returns after commit and background
  progress has an explicit ownership/liveness guarantee.
- **Scheduler boundary:** retry `send-prepared` effects dominate claims while
  first-attempt `enqueue-outbox` effects accumulate lateness. Plan separate
  scheduling lanes or explicit effect-class service guarantees instead of
  restoring the rejected attempts-only quota.
- **Storage/coordination boundary:** enqueue finalization is small and fresh
  effects are claimed promptly, but sender/lock or drain execution remains
  slow. Add one narrower measurement around IndexedDB admission commits,
  outbox writes, or cross-context coordination before changing behavior.

Only one behavior correction is permitted per subsequent remote iteration.
Every run records its commit, workflow run, artifact directory, recipe result,
stream metrics, effect metrics, interpretation, and keep/revert decision. Stop
before ten additional runs if the responsible boundaries and long-term
implementation directions are already supported by repeated evidence.

## Long-term handoff

After the diagnostic series identifies the responsible code boundaries, write
a separate implementation plan for the production answer. That plan must
define API semantics, effect-worker ownership and liveness, fairness and
backpressure guarantees, recovery after process/browser interruption,
IndexedDB transaction boundaries, observability, migration compatibility, and
focused plus distributed acceptance tests. Diagnostic commits on PR #40 remain
directional evidence and are not automatically the final implementation.
