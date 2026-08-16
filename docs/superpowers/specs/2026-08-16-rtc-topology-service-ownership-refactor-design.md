# RTC Topology Service Ownership Refactor Design

## Purpose

Finish the next human-traceability program step by separating the remaining planning and runtime
responsibilities inside `RallarRtcTopologyService` without changing its supported public surface or
observable topology behavior. This design owns
[#236](https://github.com/intact-software-systems/ar-eye-hunter/issues/236).

The product execution base is exact commit `956a057c9ab51c3060f30e60cae48ade24f5ec5c`
on 2026-08-16. Its artifact `20260816-956a057c9ab5-e1-local` is a preserved failed harness
diagnostic: accepted samples lacked the initialized runtime observation, so finalization could not
accept it as comparative evidence. After the separately explained runtime-observation harness fix,
exact prerequisite head `15ff8b402e9985802caa72ca5535abfb96b6b18b` produced the accepted same-host
pre-topology artifact `20260816-15ff8b402e99-e1-local`. Newer `main` changed shared-graph selection
and independently landed the #240 implementation at `40b9c2b0a865aca46f3b9f2c0a4eb6df1d617e77`,
but did not change the service, direct tests, or selected ownership, so this architecture remains
current.
The earlier RTC RTT ownership work is already present. This document is architectural guidance, not a live progress ledger, ownership
reservation, completion receipt, or authorization to commit on `main`.

## Current problem

`packages/shared-server/rallar-system/services/rallar-rtc-topology-service.ts` is 1,493 physical
lines. The current style facts report:

- 1,419 effective lines after the data-literal discount, above the 1,200-line navigation backstop;
- cognitive load 201, in the required separation-review tier;
- six functions with more than three positional parameters;
- two plain-object type findings; and
- one pass-through helper finding.

Those metrics expose real structural pressure but do not choose the architecture. The code itself
shows five independent reasons to change:

1. topology-kind selection, full and incremental planning, and snapshot materialization;
2. weighted, sparse, complete-fallback, star, tree, and mesh graph calculation;
3. process-local accepted-snapshot observation and causal-conflict detection;
4. per-overlay RTT rebuild scheduling and debounce state; and
5. topology counters and duration metrics.

Canonical planning input, incremental evolution, and topology-kind hysteresis already live in
`rallar-system/topology/planning`. The remaining implementation therefore obscures an ownership
boundary that the repository has otherwise established.

## Approaches considered

### 1. Keep the supported service facade and extract canonical owners — selected

Keep `rallar-system/services/rallar-rtc-topology-service.ts` as the supported package facade and
runtime composition boundary. Move graph and planning decisions under `topology/planning`, and move
process-local state, scheduling, and metrics under `topology/runtime`.

This preserves every current import path and public method while reducing the facade to one real
job: construct the components, preserve the established API, and coordinate plan/observe/remove
lifecycle transitions. The retained hop is justified by the package facade and lifecycle boundary;
it is not a compatibility-only forwarding file.

### 2. Move the facade into `topology` and update every consumer

Current main has 31 source, app, benchmark, fixture, and test files importing the existing deep
path. Moving the facade now would place every changed consumer into touched-file standards closure,
including the broad API composition root tracked separately by
[#237](https://github.com/intact-software-systems/ar-eye-hunter/issues/237). It would mix ownership
work with a public-path migration and unrelated consumer remediation.

This approach is rejected for Step 1. Consumer migration can be designed later if the existing
supported path becomes an independently approved problem.

### 3. Move the facade and retain an old-path re-export

This would avoid consumer edits but create a compatibility-only hop and durable legacy obligation.
There is no verified need for a second path when the existing file can remain the real facade, so
the extra layer is rejected.

## Selected ownership model

The final production structure is:

```text
packages/shared-server/rallar-system/
  services/
    rallar-rtc-topology-service.ts
      Supported public facade, options, constructor, public methods, and component lifecycle
  topology/
    README.md
    planning/
      canonical-topology-planning-input.ts
      compute-no-rtt-topology-next-hops.ts
      create-rtc-room-graph.ts
      evolve-planned-topology.ts
      group-topology-planning-authority.ts
      group-topology-planning-service.ts
      materialize-rtc-overlay-topology-broadcast-message.ts
      plan-rallar-rtc-topology-snapshot.ts
      rtc-topology-planner.ts
      select-group-topology-planning-snapshot.ts
      topology-kind-hysteresis.ts
    runtime/
      rtc-topology-metrics.ts
      rtc-topology-rtt-rebuild-scheduler.ts
      rtc-topology-snapshot-registry.ts
```

No nested barrel is added. Internal modules import their owning files directly. The package root
continues to export the existing service module from `packages/shared-server/mod.ts` without a new
public symbol set.

### Responsibility dispositions

| Current responsibility                                              | Judgment | Final owner                                     | Reason                                                                            |
| ------------------------------------------------------------------- | -------- | ----------------------------------------------- | --------------------------------------------------------------------------------- |
| Public constructor, options, and methods                            | Keep     | `services/rallar-rtc-topology-service.ts`       | This is the supported package and lifecycle boundary.                             |
| Snapshot materialization and semantic change/version decision       | Move     | `planning/plan-rallar-rtc-topology-snapshot.ts` | Pure deterministic planning result with an existing public function.              |
| Kind selection, option resolution, incremental/full planning choice | Split    | `planning/rtc-topology-planner.ts`              | One planning capability that composes existing canonical planning owners.         |
| Weighted/sparse/fallback room graph construction                    | Split    | `planning/create-rtc-room-graph.ts`             | One graph-calculation family with explicit inputs and no process state.           |
| Star/tree/mesh no-RTT next hops                                     | Split    | `planning/compute-no-rtt-topology-next-hops.ts` | One deterministic fallback-algorithm family shared by the planner and room graph. |
| Accepted snapshot map and causal conflicts                          | Split    | `runtime/rtc-topology-snapshot-registry.ts`     | One process-local observation lifecycle.                                          |
| RTT due-time map and debounce decisions                             | Split    | `runtime/rtc-topology-rtt-rebuild-scheduler.ts` | One clock-driven scheduling lifecycle.                                            |
| Mutable counters and duration observations                          | Move     | `runtime/rtc-topology-metrics.ts`               | Metrics remain non-authoritative and independently resettable.                    |
| Existing input canonicalization, evolution, and hysteresis modules  | Keep     | Existing files under `topology/planning`        | They already have truthful owners; duplicating them is prohibited.                |
| Graphology and shared graph algorithms                              | Keep     | `packages/shared-graph`                         | Step 1 consumes them and does not fork or optimize them.                          |

A disposition reopens only if implementation evidence shows that the proposed owner cannot state a
coherent API without a pass-through layer, a runtime dependency cycle, or changed behavior.

## Component contracts

### Supported facade

`RallarRtcTopologyService` retains the exact constructor and public methods present at the baseline:

- planning and updates: `updateGroupTopology`, `planGroupTopology`, `planGroupTopologyAt`,
  `selectTopology`, and `createRoomGraph`;
- process observation: `observeTopologySnapshot`, `observeCommittedTopologySnapshot`,
  `readSnapshot`, and `removeGroupTopology`;
- RTT scheduling: `queueRttTopologyUpdate`, `flushDueRttTopologyUpdate`,
  `claimDueRttTopologyUpdate`, `readRttTopologyUpdateDelayMs`, and
  `readRttRebuildDebounceMs`;
- policy/clock reads: `readRttReportingDegreeLimit`, `readKindHysteresisWidths`, and
  `readNowEpochMs`; and
- metrics: `readMetrics`, `resetMetrics`, `recordTopologyPublishResult`, and
  `recordTopologyRebuildSkippedFingerprint`.

The facade constructs metrics first, then the snapshot registry, scheduler, and planner. Every
dependency exists before its consumer. No setter injection, forward-captured callback, global
registry, or alternate test-only construction path is introduced.

### `RtcTopologyPlanner`

The planner owns service-option defaults and the decision between star, incremental evolution,
no-RTT calculation, and weighted graph calculation. It receives the metrics owner and a monotonic
duration clock at construction. Pure leaf algorithms receive complete values and do not read
process state, wall time, environment variables, or repositories.

The existing public service-option and result type names remain canonical. The planner uses those
types directly; it does not introduce shorter aliases or duplicate result contracts.

### `RtcTopologySnapshotRegistry`

The registry owns only the map from scoped overlay ID to the latest observed snapshot. It preserves
the current causal ordering and exact failure classes:

- a dominating snapshot replaces the current snapshot;
- an equal causal tuple with different semantics throws the existing revision-conflict error;
- an incomparable causal tuple throws the existing causal-conflict error; and
- a stale or semantically equal observation does not replace current state.

The facade remains responsible for converting a `GroupSnapshot` to a scoped overlay ID and for
coordinating snapshot removal with pending RTT work removal.

### `RtcTopologyRttRebuildScheduler`

The scheduler owns the per-overlay due-time map, injected wall clock, configured debounce, and queue
metrics. It receives the already resolved overlay ID and whether a snapshot exists. It preserves
the current first-queue, coalescing, immediate, claim, delay, and removal decisions exactly.

### `RtcTopologyMetrics`

The metrics owner encapsulates mutable counters and exposes domain-named record operations. It does
not accept arbitrary string keys. `readMetrics` still includes live snapshot and pending-work
counts supplied by the facade, and `resetMetrics` resets counters without deleting either runtime
map.

## Construction and runtime dataflow

### Construction timeline

1. API-v1 or `initRallarSystemWsTopics` creates `RallarRtcTopologyService` with the existing options.
2. The facade creates `RtcTopologyMetrics`.
3. It creates `RtcTopologySnapshotRegistry`.
4. It creates `RtcTopologyRttRebuildScheduler` with the configured clock, debounce, and metrics.
5. It creates `RtcTopologyPlanner` with the service options, duration clock, and metrics.
6. Existing group-topology management, RTT topic, work handler, admin metrics, benchmark, and test
   consumers receive the completed facade exactly as before.

No callback becomes invocable before these dependencies exist.

### Planning invocation timeline

1. Existing local reconciliation or durable APP_OUTBOX work invokes `GroupTopologyPlanningService`.
2. That service reads group, config, RTT, prior snapshot, and clock authority as it does now.
3. It calls the supported facade's `planGroupTopologyAt` once.
4. The facade selects the explicit previous snapshot or current registry snapshot and calls
   `RtcTopologyPlanner` once.
5. The planner canonicalizes active sessions and RTT inputs, resolves kind and options, then chooses
   exactly one star, incremental, no-RTT, or weighted path.
6. Existing canonical evolution/hysteresis and shared-graph algorithms perform their current work.
7. `planRallarRtcTopologySnapshot` returns the same changed flag, version, timestamps, previous
   value, and canonical next-hop arrays.
8. `GroupTopologyPlanningService` performs the existing next-hop validation. Durable mutation,
   transaction, retry, publication, and replay owners remain unchanged.

The refactor does not move or alter AppInbox, APP_OUTBOX, transaction, retry, persistence, replay,
reconnect, or WS publication boundaries.

### Local update and RTT scheduling timeline

1. `updateGroupTopology` plans once, then observes the returned snapshot through the registry.
2. A committed observation clears pending RTT work for the same overlay, exactly as now.
3. `queueRttTopologyUpdate` asks the registry whether the overlay has a snapshot and schedules an
   immediate or debounced due time.
4. `flushDueRttTopologyUpdate` claims once. A failed claim returns `undefined`; a successful claim
   invokes the same update path once.
5. `removeGroupTopology` removes both the pending schedule and snapshot, then records the same
   removal or miss metric.

## Concrete execution horizon

### Slice 1: Canonical planning and graph ownership

1. Split the broad service tests into behavior-named planning, graph, no-RTT, runtime, facade, and
   public-compatibility suites while they still exercise the baseline implementation.
2. Refactor the existing metrics module into the planning instrumentation owner, then extract
   snapshot materialization, no-RTT algorithms, room-graph construction, and the planning owner
   under `topology/planning`. Keep the metrics file at its existing root path until the runtime
   slice can move a coherent runtime folder together.
3. Reduce the existing service file to the supported facade plus its still-local runtime state.
4. Run focused planning/determinism/evolution tests, shared-server typecheck, style, and structure
   review before starting runtime extraction.

This slice is complete only when no planning or graph algorithm remains duplicated in the facade.

### Slice 2: Process-runtime ownership and facade closure

1. Move the metrics owner and extract the snapshot registry and RTT rebuild scheduler together
   under `topology/runtime`.
2. Make the facade construct and coordinate those completed owners without hidden late binding.
3. Update current topology navigation and active product documentation.
4. Run runtime/facade/integration tests, package and API checks, B03 before/after evidence, and a
   complete code, structure, navigation, and legacy review.

This slice is complete only when the facade has one coherent package/lifecycle responsibility and
all five issue #236 responsibility judgments are visible in the final code.

## Behavior-preservation contract

The refactor preserves:

- every current constructor option, default, public method, return shape, and package export;
- current deep imports of `rallar-system/services/rallar-rtc-topology-service.ts`;
- exact star/tree/mesh thresholds, explicit kind overrides, hysteresis, and per-update option merge;
- full-rebuild versus membership-delta incremental evolution and every fallback reason;
- canonical session ordering, next-hop ordering, Unicode/lookalike identity, latest RTT pair version,
  deterministic fallback weight, sparse/complete graph, degree, connectivity, and version rules;
- no-RTT tree and mesh output, including their current tie-breaking and failure behavior;
- snapshot semantic equality, causal ordering, object reuse, version/timestamp changes, conflict
  errors, and removal behavior;
- RTT debounce deadline, coalescing, immediate, skip, claim, flush, and cleanup decisions;
- every metric name, count, duration timing boundary, dynamic map count, and reset result; and
- existing transaction, persistence, outbox, publication, replay, reconnect, and WebSocket behavior.

There is no intended protocol, API, persisted-format, topology-result, performance-threshold, or
distributed behavior change.

## Compatibility and affected legacy

The existing service path and `RallarRtcTopologyService` surface are supported product boundaries,
not deprecated legacy. They remain canonical in this step. No second service path, alias, adapter,
fallback, or re-export shim is introduced.

Affected implementation helpers and mutable type shapes inside the 1,493-line file are not public
compatibility requirements. They are removed or replaced by the selected owners, with one canonical
algorithm for each behavior. At completion, every affected legacy candidate is classified as
`removed`, `resolved`, or `minimized-boundary`; a `retained` item would require explicit authorized
maintainer approval and a durable registry entry.

## Bug protocol

If the refactor exposes an actual correctness, safety, lifecycle, or compatibility bug in an
affected path:

1. reproduce it with a failing semantic test against the supported entry;
2. classify it separately from the ownership move;
3. fix the smallest owning production path in the same implementation only when no new public,
   protocol, persistence, or migration decision is required;
4. run the affected regression and package checks; and
5. describe the behavior change separately in the handoff.

An obsolete test coupled only to private file topology is rewritten around supported behavior; the
production design is not made worse to preserve that coupling.

## Weakness and issue protocol

Every newly confirmed code or performance weakness is checked against open issues before delivery.
Reuse an accurate issue or create one with exact code location, impact, evidence/confidence, safe
next step, and acceptance criteria. Do not create speculative performance claims from static shape
alone.

Current boundaries are:

- [#235](https://github.com/intact-software-systems/ar-eye-hunter/issues/235) owns bounded Vivaldi
  all-pairs graph optimization and is not implemented here;
- [#237](https://github.com/intact-software-systems/ar-eye-hunter/issues/237) owns API-v1 composition
  density and SQL-boundary normalization and remains untouched;
- [#240](https://github.com/intact-software-systems/ar-eye-hunter/issues/240) owns RTT refinement
  decision-expiry cleanup. Its implementation is present independently on `main` at `40b9c2b0`,
  while GitHub issue metadata remains open; this branch does not implement it and tracker closure
  is external; and
- #236 is closed only by the completed, validated ownership refactor described here.

Touched-file standards problems are remediated in this work rather than deferred as issues.

## Performance design

This is a behavior-preserving structural change, not an optimization. Static complexity findings are
hypotheses unless code proves the growth shape. The accepted RTC-B03 workload already measures the
exact affected production symbols across star, tree, mesh, RTT room graph, and inactive churn at
30, 100, and 300 sessions.

Keep `20260816-956a057c9ab5-e1-local` as the failed diagnostic tied to the product execution base;
do not relabel it as accepted evidence. Use exact prerequisite head
`15ff8b402e9985802caa72ca5535abfb96b6b18b` and its accepted same-host pre-topology artifact
`20260816-15ff8b402e99-e1-local` as the comparative base for the clean candidate captured after both
slices. The prerequisite and candidate artifacts both run capture → finalize → validate on the same
host and environment and must pass semantic validation. Compare distributions without inventing a
new numeric SLO; repeat or profile a suspicious movement before calling it a regression. Generated
evidence stays under `tmp/perf/` and is not committed.

The implementation must not optimize or change graph output under #235. A verified regression
caused by the extraction is fixed before completion; an independent pre-existing weakness gets an
issue.

## Touched-file standards closure

Every changed human-authored file is reviewed and remediated in full. Every support file modified by
that remediation enters closure recursively until closure. Independent untouched code remains
outside closure.

For this design, closure includes the existing service file, the existing metrics file when moved,
the broad service and determinism tests when split, every newly created planning/runtime module and
test, and each current navigation document changed by the new ownership. It does not pull unrelated
API composition, RTC RTT persistence, shared-graph algorithms, replay, or historical plans into
scope.

## Validation design

The direct behavior proof is the focused topology suite covering public compatibility, planning,
room graphs, no-RTT algorithms, determinism, evolution, runtime observation, RTT scheduling, metrics,
APP_OUTBOX planning, RTT topic integration, and WS topology integration.

The concrete package proof is `npx tsc -p packages/shared-server/tsconfig.json --noEmit`. Because the
service is composed by API-v1 and measured by the shared RTC benchmark package, final validation also
includes the API-v1 Deno check, the shared RTC benchmark package check, and the fixed API-v1
PostgreSQL medium-scale topology gate. The topology replay gate is required only if implementation
evidence shows a stream, cursor, replay, reconnect, retention, or cutover path changed. The
state-write performance gate is not required because this design changes no mutation path or
concurrency domain.

Style and structure validation includes changed-file and full warning review, complete dispositions
for construction findings, repository structure checks, Prettier, `git diff --check`, and a cold
code-only owner-to-result navigation trace from the supported service export. The changed-style
evidence is expected to report the independently approved cohesive
`planning/compute-no-rtt-topology-next-hops.ts` file warning (cognitive-load score 80; worst function
score 12). Its reviewed structural disposition is to keep the complete deterministic no-RTT
algorithm family together; do not claim a zero-warning exit or split it mechanically.

## Local delivery boundary

This turn writes the design and implementation plan as uncommitted local `main` changes for human
review. It creates no branch, commit, push, or pull request. Future implementation must run on a
non-default branch or receive the exact immediate default-branch permission required by `AGENTS.md`.
Publication remains a separate maintainer decision.

## Acceptance criteria

- The 1,493-line mixed implementation is replaced by one supported facade and the selected planning
  and runtime owners.
- Planning, graph calculation, snapshot state, RTT scheduling, and metrics have explicit final
  owners with no duplicate algorithms.
- Existing service imports, package exports, constructor, options, methods, outputs, errors, and
  metrics remain compatible.
- Focused semantic tests exist before each ownership move and remain primary after it.
- Every changed file satisfies complete touched-file standards closure; every affected legacy item
  has a final disposition.
- The focused topology suite, shared-server typecheck, API-v1 check, benchmark package check,
  medium-scale gate, style/structure checks, and RTC-B03 base/candidate evidence pass or are reported
  with an exact classified blocker.
- Any actual bug is tested and fixed separately; every other confirmed weakness has a reused or new
  GitHub issue URL.
- Current navigation documentation names the supported facade and every canonical internal owner.
