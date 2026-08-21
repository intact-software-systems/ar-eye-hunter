# RTC Topology Service Ownership Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this
> plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate planning, graph calculation, process-local snapshot state, RTT scheduling, and
metrics behind the supported `RallarRtcTopologyService` facade while preserving every observable
topology result and public contract.

**Architecture:** Keep `rallar-system/services/rallar-rtc-topology-service.ts` as the real package
facade and lifecycle composition boundary. Extract deterministic planning owners under
`rallar-system/topology/planning` and process-local owners under
`rallar-system/topology/runtime`; add no alternate facade path, compatibility shim, nested barrel,
or duplicate algorithm.

**Tech Stack:** TypeScript 7 with `erasableSyntaxOnly`, Vitest, Deno, Node/npm workspaces,
Graphology, `packages/shared-graph`, the shared RTC benchmark package, Markdown.

**Design:**
`docs/superpowers/specs/2026-08-16-rtc-topology-service-ownership-refactor-design.md`

**Exact product execution base:** `956a057c9ab51c3060f30e60cae48ade24f5ec5c` (2026-08-16).
Artifact `20260816-956a057c9ab5-e1-local` is a preserved failed harness diagnostic, not the accepted
comparative base. After the separately explained runtime-observation harness fix, exact prerequisite
head `15ff8b402e9985802caa72ca5535abfb96b6b18b` produced accepted same-host pre-topology artifact
`20260816-15ff8b402e99-e1-local`. Newer `main` did not change the service, direct tests, or selected
ownership, so the architecture remains current.

## Final correction round

Final whole-branch review at `fa0288d772f540cd80f195d86dc9a81783d1db51` proved compatibility,
failure-boundary, graph-timing, test-authority, and allocation facts that were not protected by the
completed slices. This is one bounded final-fix round; it does not reopen the ownership model or
activate another feature slice.

The correction acceptance is:

- Preserve the baseline subclass dispatch chain exactly: update -> `planGroupTopology` ->
  `planGroupTopologyAt`; planning and room-graph work dispatch through the public
  `selectTopology` and `readRttReportingDegreeLimit`; committed observation dispatches through
  `observeTopologySnapshot`; flush dispatches through claim then update. Table-driven semantic
  subclass tests assert exact counts, order, and returned results. The committed-observation
  virtual call is an intentional observable compatibility boundary, not a direct-registry cleanup
  opportunity.
- Move topology, queue, and flush request-attempt increments to the lifecycle facade before their
  session/scope translation boundaries. Remove duplicate increments from planner/scheduler;
  planners and schedulers continue to own result and duration metrics. Generalized throwing
  session/scope/clock tests assert the exact error order and counters without flags or callbacks.
- Make room-graph construction return an explicit discriminated connected or sparse-fallback
  outcome. Record build duration and fallback count before a same-owner fallback materializer runs,
  so fallback materialization is excluded and a throwing second graph-scope construction observes
  build 1, fallback 1, and the already recorded boundary duration.
- Delete
  `packages/shared-rtc-bench/tests/architecture/rtc-benchmark-executable-ownership.test.ts`
  without replacement inventory. Existing executable capability suites, catalog tests, navigation,
  and package/import boundaries remain the semantic authority.
- Remove the dead measured-graph `createRttWeightLookup` O(M) preprocessing and helpers. Open issue
  [#253](https://github.com/intact-software-systems/ar-eye-hunter/issues/253) records the proven
  weakness and safe acceptance; this branch fixes it but does not close the issue externally.

Execute behavior corrections with strict RED -> GREEN. Amend plan/design before production edits,
commit the amendment coherently, then commit production/tests and the obsolete inventory deletion
as coherent non-default-branch changes. Run the full focused topology and integration set,
shared-server typecheck, shared RTC benchmark check, governance, API Deno check, the unweakened
medium-scale PostgreSQL gate, style/changed-style/construction/structure/tests/Prettier/diff/legacy
review, current-main merge-tree compatibility, and terminal clean-head RTC-B03 capture. Inspect the
remote Release Gate through `npm run pr:delivery -- status`. A deterministic changed-style failure
invalidates any earlier `keep` assumption and requires a real ownership correction before
publication; do not add a static exception or a source-inventory test.

## Global Constraints

- Preserve the exact existing `RallarRtcTopologyService` deep import, package export, constructor,
  options, public methods, return values, errors, metrics, and timing boundaries.
- Preserve topology selection, hysteresis, incremental evolution, canonical ordering, graph output,
  snapshot versioning/causality, RTT debounce, and removal behavior.
- Keep one canonical implementation for every algorithm. Extraction never means copy-and-delegate.
- Keep existing input canonicalization, evolution, hysteresis, shared-graph, AppInbox, APP_OUTBOX,
  persistence, replay, reconnect, and WebSocket owners in place.
- Do not implement [#235](https://github.com/intact-software-systems/ar-eye-hunter/issues/235),
  [#237](https://github.com/intact-software-systems/ar-eye-hunter/issues/237), or
  [#240](https://github.com/intact-software-systems/ar-eye-hunter/issues/240) in this work.
  The #240 implementation is independently present on `main` at `40b9c2b0`; GitHub issue metadata
  remains open, and tracker closure is external to this branch.
- A real bug gets a failing semantic test and a separately explained minimal fix. A confirmed
  weakness outside touched-file standards closure reuses or creates a focused GitHub issue before
  delivery.
- Every changed human-authored file is reviewed and remediated in full.
- Every support file modified by remediation enters closure recursively until closure.
- Independent untouched code remains outside closure.
- Do not commit, amend, merge, rebase, or cherry-pick on `main`. Execute implementation in an
  isolated non-default worktree. This plan creates no push or pull-request obligation; publication
  requires a later maintainer decision.
- Keep generated benchmark evidence under `tmp/perf/`; never commit it.

## Working-plan slices

Only these two slices are concrete:

1. **Canonical planning and graph ownership:** characterize behavior, extract metrics needed by the
   planning instrumentation, then extract snapshot materialization, no-RTT algorithms, room-graph
   construction, and the planner.
2. **Process-runtime ownership and facade closure:** extract the snapshot registry and RTT rebuild
   scheduler, finish the facade, update navigation, and run complete validation and legacy review.

Do not activate a third slice. New evidence that changes behavior, ownership, compatibility, or
validation risk amends this working plan before more production work.

## Locked file structure

### Supported facade

- Modify: `packages/shared-server/rallar-system/services/rallar-rtc-topology-service.ts` — existing
  public surface, component construction, plan/observe/remove coordination.
- Keep unchanged unless an actual package-export defect is found:
  `packages/shared-server/mod.ts`.

### Canonical planning owners

- Create:
  `packages/shared-server/rallar-system/topology/planning/plan-rallar-rtc-topology-snapshot.ts` —
  semantic changed/version/timestamp snapshot materialization.
- Create:
  `packages/shared-server/rallar-system/topology/planning/compute-no-rtt-topology-next-hops.ts` —
  deterministic no-RTT dispatch, star/mesh calculation, and canonical output translation.
- Create:
  `packages/shared-server/rallar-system/topology/planning/compute-no-rtt-tree-next-hops.ts` —
  deterministic tree construction and distance state.
- Create:
  `packages/shared-server/rallar-system/topology/planning/update-no-rtt-tree-attachment-selection.ts`
  — decision-dense tree attachment selection over explicit state.
- Create:
  `packages/shared-server/rallar-system/topology/planning/create-rtc-room-graph.ts` — canonical
  weighted, sparse, complete, and fallback Graphology graph construction.
- Create:
  `packages/shared-server/rallar-system/topology/planning/rtc-topology-planner.ts` — option and kind
  resolution plus star/incremental/no-RTT/weighted planning selection.
- Keep and consume directly:
  `canonical-topology-planning-input.ts`, `evolve-planned-topology.ts`, and
  `topology-kind-hysteresis.ts`.

### Canonical process-runtime owners

- Refactor in Slice 1, then move in Slice 2:
  `packages/shared-server/rallar-system/topology/rallar-rtc-topology-metrics.ts` to
  `packages/shared-server/rallar-system/topology/runtime/rtc-topology-metrics.ts` — metric contract,
  mutable counters, domain-named record methods, read, and reset.
- Create:
  `packages/shared-server/rallar-system/topology/runtime/rtc-topology-snapshot-registry.ts` — latest
  process observation and causal-conflict decisions.
- Create:
  `packages/shared-server/rallar-system/topology/runtime/rtc-topology-rtt-rebuild-scheduler.ts` —
  per-overlay due times, debounce, coalescing, claim, delay, and removal.

### Mirrored semantic tests

- Create:
  `packages/tests/shared-server/rallar-system/topology/rallar-rtc-topology-public-compatibility.test.ts`.
- Create:
  `packages/tests/shared-server/rallar-system/topology/rallar-rtc-topology-service.test.ts`.
- Create:
  `packages/tests/shared-server/rallar-system/topology/planning/rtc-topology-planning.test.ts`.
- Create:
  `packages/tests/shared-server/rallar-system/topology/planning/rtc-topology-room-graph.test.ts`.
- Create:
  `packages/tests/shared-server/rallar-system/topology/planning/rtc-topology-no-rtt.test.ts`.
- Move:
  `packages/tests/shared-server/rtc-topology-plan-determinism.test.ts` to
  `packages/tests/shared-server/rallar-system/topology/planning/rtc-topology-plan-determinism.test.ts`.
- Create:
  `packages/tests/shared-server/rallar-system/topology/runtime/rtc-topology-metrics.test.ts`.
- Create:
  `packages/tests/shared-server/rallar-system/topology/runtime/rtc-topology-snapshot-registry.test.ts`.
- Create:
  `packages/tests/shared-server/rallar-system/topology/runtime/rtc-topology-rtt-rebuild-scheduler.test.ts`.
- Create:
  `packages/tests/shared-server/rallar-system/topology/runtime/rtc-topology-runtime-integration.test.ts`.
- Delete after every assertion is transferred:
  `packages/tests/shared-server/rallar-rtc-topology-service.test.ts`.

### Current navigation documents

- Modify: `packages/shared-server/rallar-system/topology/README.md`.
- Modify: `docs/rallar-convergent-state-and-rtc-topology.md`.
- Modify: `docs/rallar-rtc-rtt-reporting.md`.
- Do not update historical plans or old performance-plan inventories merely to restate new paths.

---

### Task 1: Authenticate the base, capture RTC-B03, and mirror baseline behavior

**Files:**

- Create:
  `packages/tests/shared-server/rallar-system/topology/rallar-rtc-topology-public-compatibility.test.ts`.
- Create:
  `packages/tests/shared-server/rallar-system/topology/rallar-rtc-topology-service.test.ts`.
- Create:
  `packages/tests/shared-server/rallar-system/topology/planning/rtc-topology-planning.test.ts`.
- Create:
  `packages/tests/shared-server/rallar-system/topology/planning/rtc-topology-room-graph.test.ts`.
- Create:
  `packages/tests/shared-server/rallar-system/topology/planning/rtc-topology-no-rtt.test.ts`.
- Move:
  `packages/tests/shared-server/rtc-topology-plan-determinism.test.ts` to
  `packages/tests/shared-server/rallar-system/topology/planning/rtc-topology-plan-determinism.test.ts`.
- Create:
  `packages/tests/shared-server/rallar-system/topology/runtime/rtc-topology-runtime-integration.test.ts`.
- Delete after transfer: `packages/tests/shared-server/rallar-rtc-topology-service.test.ts`.
- No production file changes in this task.

**Interfaces:**

- Consumes: current deep service module and `@shared-server/mod.ts` package entry.
- Produces: behavior-named semantic suites that still invoke the baseline service; no test-only
  production interface.

- [ ] **Step 1: Create an isolated implementation worktree**

Use `superpowers:using-git-worktrees`. Name the non-default branch
`codex/rtc-topology-service-ownership`. Do not work from or commit on `main`.

- [ ] **Step 2: Re-authenticate the exact planning base**

Run:

```bash
git fetch origin main
git rev-parse origin/main
git status --short --branch
```

Expected at plan start:

- the execution base is `956a057c9ab51c3060f30e60cae48ade24f5ec5c`;
- the implementation worktree is on `codex/rtc-topology-service-ownership`; and
- the worktree is clean.

If `origin/main` changed, inspect the service, issue #236, consumers, tests, benchmark catalog, and
repo guidance again. Amend the design and this plan before production edits when ownership,
compatibility, or validation assumptions changed. Do not rebase merely for an unrelated movement.

- [ ] **Step 3: Capture the clean base RTC-B03 evidence**

Current evidence correction: the commands below produced
`20260816-956a057c9ab5-e1-local`, which is preserved as a failed diagnostic because the then-current
harness omitted initialized runtime observations from accepted samples. After the separately
explained harness fix, exact prerequisite head `15ff8b402e9985802caa72ca5535abfb96b6b18b`
captured, finalized, and validated accepted same-host pre-topology artifact
`20260816-15ff8b402e99-e1-local`. Task 5 compares its candidate to that accepted artifact; it does
not reinterpret the diagnostic artifact.

Run from exact base commit `956a057c9ab51c3060f30e60cae48ade24f5ec5c`:

```bash
npm run perf:rtc-baseline -- initialize \
  --baseline-id=20260816-956a057c9ab5-e1-local \
  --workloads=RTC-B03 \
  --environment=E1-local

npm run perf:rtc-baseline -- capture \
  --baseline-id=20260816-956a057c9ab5-e1-local \
  --workload=RTC-B03

npm run perf:rtc-baseline -- finalize \
  --baseline-id=20260816-956a057c9ab5-e1-local

npm run perf:rtc-baseline -- validate \
  --baseline-id=20260816-956a057c9ab5-e1-local
```

Historical expectation: all commands exit zero and the finalized evidence validates star, tree,
mesh, sparse/complete RTT graph, and inactive-churn cases at 30, 100, and 300 sessions. Actual
result: capture succeeded, finalization exposed the runtime-observation harness defect, and the
artifact was preserved for diagnosis. The accepted prerequisite artifact above supplies the same
semantic workload after that independently tested harness repair.

- [ ] **Step 4: Split the broad test by behavior without changing assertions**

Transfer every case from `packages/tests/shared-server/rallar-rtc-topology-service.test.ts`:

| New test                                           | Baseline behaviors transferred                                                                                                                                                         |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `planning/rtc-topology-room-graph.test.ts`         | fallback weights, latest reverse-pair version, delimiter/Unicode identity, equal-weight ordering, complete/sparse materialization, linear edge bound, degree bound, weighted mesh path |
| `planning/rtc-topology-no-rtt.test.ts`             | star output, graph bypass, tree sizes/degrees, mesh graph bypass, degree-limited kinds                                                                                                 |
| `planning/rtc-topology-planning.test.ts`           | explicit kind overrides, per-update options, default thresholds, unchanged revision, RTT replan, supplied previous versioning                                                          |
| `runtime/rtc-topology-runtime-integration.test.ts` | fresh-worker observation, debounce, coalescing, metrics, snapshot/pending removal                                                                                                      |
| `rallar-rtc-topology-service.test.ts`              | one representative public update and one plan-without-observe path proving facade integration                                                                                          |

Move the determinism suite to the mirrored planning path without altering its shuffled-input,
unchanged-seed, or canonical-next-hop assertions.

Shared fixtures such as `createGroupSnapshot`, `createMemberIds`, and RTT builders stay in the test
file that owns their behavior unless two or more test modules need the same non-trivial fixture. If
sharing is necessary, create
`packages/tests/shared-server/rallar-system/topology/rtc-topology-test-fixtures.ts`; it may construct
inputs only and must not choose topology behavior.

- [ ] **Step 5: Add a supported public compatibility test**

Write a semantic identity and construction test:

```ts
import { expect, it } from 'vitest';

import {
    planRallarRtcTopologySnapshot as packagePlanSnapshot,
    RallarRtcTopologyService as PackageService
} from '@shared-server/mod.ts';
import {
    planRallarRtcTopologySnapshot as directPlanSnapshot,
    RallarRtcTopologyService as DirectService
} from '@shared-server/rallar-system/services/rallar-rtc-topology-service.ts';

it('keeps the supported RTC topology service package and deep imports identical', () => {
    expect(PackageService).toBe(DirectService);
    expect(packagePlanSnapshot).toBe(directPlanSnapshot);
    expect(new PackageService()).toBeInstanceOf(DirectService);
});
```

Also import `RallarRtcTopologyServiceOptions`, `RallarRtcTopologyUpdateOptions`,
`RallarRtcTopologyUpdateResult`, `RallarRtcTopologyRttQueueResult`, `RtcTopologyPlanningIntent`, and
`RtcTopologyKindHysteresisWidths` from the direct service module as types and use them in a small
compile-time fixture. Do not add source-text export assertions.

- [ ] **Step 6: Run the mirrored baseline suites before production moves**

Run:

```bash
npx vitest run \
  packages/tests/shared-server/rallar-system/topology/rallar-rtc-topology-public-compatibility.test.ts \
  packages/tests/shared-server/rallar-system/topology/rallar-rtc-topology-service.test.ts \
  packages/tests/shared-server/rallar-system/topology/planning/rtc-topology-planning.test.ts \
  packages/tests/shared-server/rallar-system/topology/planning/rtc-topology-room-graph.test.ts \
  packages/tests/shared-server/rallar-system/topology/planning/rtc-topology-no-rtt.test.ts \
  packages/tests/shared-server/rallar-system/topology/planning/rtc-topology-plan-determinism.test.ts \
  packages/tests/shared-server/rallar-system/topology/runtime/rtc-topology-runtime-integration.test.ts \
  packages/tests/shared-server/rallar-system/topology/planning/evolve-planned-topology.test.ts \
  packages/tests/shared-server/rallar-system/topology/planning/group-topology-planning-service.test.ts
```

Expected: all transferred semantic assertions pass against the unrefactored service. A failed
transfer is a test-move defect unless it exposes a reproducible baseline product bug.

- [ ] **Step 7: Close and format every changed test file**

Review each changed test completely for behavior names, imports, duplicated setup, generic helpers,
hidden decisions, and chronology names. Run:

```bash
npx prettier --check \
  packages/tests/shared-server/rallar-system/topology/rallar-rtc-topology-public-compatibility.test.ts \
  packages/tests/shared-server/rallar-system/topology/rallar-rtc-topology-service.test.ts \
  packages/tests/shared-server/rallar-system/topology/planning/rtc-topology-planning.test.ts \
  packages/tests/shared-server/rallar-system/topology/planning/rtc-topology-room-graph.test.ts \
  packages/tests/shared-server/rallar-system/topology/planning/rtc-topology-no-rtt.test.ts \
  packages/tests/shared-server/rallar-system/topology/planning/rtc-topology-plan-determinism.test.ts \
  packages/tests/shared-server/rallar-system/topology/runtime/rtc-topology-runtime-integration.test.ts
git diff --check
```

Expected: both commands pass.

- [ ] **Step 8: Commit the characterization on the non-default branch**

```bash
git add packages/tests/shared-server
git commit -m "test(rtc-topology): mirror service behavior by owner"
```

Never run this commit step on `main`.

---

### Task 2: Extract metrics and deterministic planning leaves

**Files:**

- Modify: `packages/shared-server/rallar-system/topology/rallar-rtc-topology-metrics.ts`
- Create:
  `packages/shared-server/rallar-system/topology/planning/plan-rallar-rtc-topology-snapshot.ts`
- Create:
  `packages/shared-server/rallar-system/topology/planning/compute-no-rtt-topology-next-hops.ts`
- Create:
  `packages/shared-server/rallar-system/topology/planning/compute-no-rtt-tree-next-hops.ts`
- Create:
  `packages/shared-server/rallar-system/topology/planning/update-no-rtt-tree-attachment-selection.ts`
- Modify: `packages/shared-server/rallar-system/services/rallar-rtc-topology-service.ts`
- Create/modify: `packages/tests/shared-server/rallar-system/topology/runtime/rtc-topology-metrics.test.ts`
- Modify: `packages/tests/shared-server/rallar-system/topology/planning/rtc-topology-planning.test.ts`
- Modify: `packages/tests/shared-server/rallar-system/topology/planning/rtc-topology-no-rtt.test.ts`

**Interfaces:**

```ts
export interface ComputeNoRttTopologyNextHopsInput {
    readonly topology: RallarRtcTopologyKind;
    readonly activeSessionIds: readonly string[];
    readonly degreeLimit: number;
    readonly meshParamK: number;
}

export function computeNoRttTopologyNextHops(
    input: ComputeNoRttTopologyNextHopsInput
): Record<string, readonly string[]>;

export class RtcTopologyMetrics {
    recordTopologyUpdate(rttMeasurementCount: number): void;
    recordTopologyResult(changed: boolean): void;
    recordStarPlan(durationMs: number): void;
    recordNoRttTreePlan(durationMs: number): void;
    recordNoRttMeshPlan(durationMs: number): void;
    recordWeightedPlan(durationMs: number): void;
    recordWeightedRoomGraph(durationMs: number, usedSparseFallback: boolean): void;
    recordIncrementalPlan(): void;
    recordIncrementalFallback(reason: EvolvePlannedTopologyFullRebuildReason): void;
    recordHysteresisHold(): void;
    recordRttQueue(result: 'new' | 'coalesced', immediate: boolean): void;
    recordRttFlush(executed: boolean): void;
    recordPublish(changed: boolean): void;
    recordFingerprintSkip(): void;
    recordRemoval(removed: boolean): void;
    read(snapshotCount: number, pendingRttUpdateCount: number): RallarRtcTopologyMetrics;
    reset(): void;
}
```

`planRallarRtcTopologySnapshot` keeps its existing exported function name, structural input, and
`RallarRtcTopologyUpdateResult` return type. Its new module contains the canonical-group-ref and
ordered-next-hop equality helpers; the facade re-exports the same function directly.

- [ ] **Step 1: Write direct failing tests for the new owners**

Add tests that import the new module paths and assert:

- `planRallarRtcTopologySnapshot` reuses the exact previous object for semantic equality, advances
  causal source revision without a topology version bump, bumps version/timestamp for an ordered
  next-hop change, and preserves canonical group scope;
- `computeNoRttTopologyNextHops` returns exact star adjacency and deterministic degree-limited mesh
  output, while `computeNoRttTreeNextHops` returns exact deterministic tree edge sets across
  shuffled input; and
- `RtcTopologyMetrics` records each category, returns supplied live map counts, and resets counters
  without changing supplied live counts.

- [ ] **Step 2: Run the new tests to verify the missing-owner failure**

Run:

```bash
npx vitest run \
  packages/tests/shared-server/rallar-system/topology/runtime/rtc-topology-metrics.test.ts \
  packages/tests/shared-server/rallar-system/topology/planning/rtc-topology-planning.test.ts \
  packages/tests/shared-server/rallar-system/topology/planning/rtc-topology-no-rtt.test.ts
```

Expected: FAIL because the two new planning modules and the new metrics owner do not exist yet. If
the failure is an assertion against current supported behavior rather than a missing symbol or
module, correct the test before implementation.

- [ ] **Step 3: Implement `RtcTopologyMetrics` without a generic counter API**

Keep `RallarRtcTopologyMetrics` in the existing metrics module as the one canonical contract and
convert it to an interface with readonly fields. Replace `MutableRallarRtcTopologyMetrics` and
`emptyTopologyMetrics` with private interface-backed state inside `RtcTopologyMetrics`. Each record
method changes only its named counters. Preserve nonnegative duration accumulation and the exact
dynamic `topologySnapshotCount` and `pendingRttUpdateCount` values supplied to `read`.

Update the facade to instantiate the metrics owner and replace direct field mutation with named
record calls. Do not expose `RtcTopologyMetrics` through `packages/shared-server/mod.ts`.

Because the service file is now touched in full, convert its concrete `Readonly<{ ... }>` public
object contracts to interfaces with the same canonical names, fields, readonly modifiers, and
optional semantics. Keep `RtcTopologyPlanningIntent` as the genuine string-literal union type.

- [ ] **Step 4: Extract snapshot materialization exactly once**

Move the body of `planRallarRtcTopologySnapshot`, `canonicalGroupRef`, `isSameNextHopMap`, and
`sameStringArray` to the new module. Re-export the existing function from the service module:

```ts
export { planRallarRtcTopologySnapshot } from '../topology/planning/plan-rallar-rtc-topology-snapshot.ts';
```

The service itself imports the function from the same owning module for execution. Do not keep a
wrapper body or second equality implementation.

- [ ] **Step 5: Extract the no-RTT owners without changing output**

Keep the supported dispatcher, star/mesh calculation, and canonical record translation in
`compute-no-rtt-topology-next-hops.ts`. Move mutable tree construction and distance state to
`compute-no-rtt-tree-next-hops.ts`. Move parent/nearest attachment selection to
`update-no-rtt-tree-attachment-selection.ts` with one explicit named input. Keep one canonical
implementation for every decision; do not add callbacks, wrappers, aliases, or duplicate output
normalization.

The no-RTT owners receive already canonical session order. They do not read clocks, mutate caller
values, record metrics, or call repositories; only the stable entry translates edge sets into
canonically ordered result arrays.

- [ ] **Step 6: Run focused leaf and public integration tests**

Run:

```bash
npx vitest run \
  packages/tests/shared-server/rallar-system/topology/runtime/rtc-topology-metrics.test.ts \
  packages/tests/shared-server/rallar-system/topology/planning/rtc-topology-planning.test.ts \
  packages/tests/shared-server/rallar-system/topology/planning/rtc-topology-no-rtt.test.ts \
  packages/tests/shared-server/rallar-system/topology/rallar-rtc-topology-service.test.ts \
  packages/tests/shared-server/rallar-system/topology/planning/rtc-topology-plan-determinism.test.ts
```

Expected: PASS with identical public results and exact direct leaf behavior.

- [ ] **Step 7: Review and close the complete touched files**

Run the focused style scan over the smallest directories, inspect every warning, and resolve it or
demonstrate a false positive with symbol-level reasoning:

```bash
npm run check:repo-style -- --root packages/shared-server/rallar-system/topology/planning
npm run check:repo-style:construction-details -- \
  --root packages/shared-server/rallar-system/services
npx prettier --check \
  packages/shared-server/rallar-system/services/rallar-rtc-topology-service.ts \
  packages/shared-server/rallar-system/topology/planning/plan-rallar-rtc-topology-snapshot.ts \
  packages/shared-server/rallar-system/topology/planning/compute-no-rtt-topology-next-hops.ts \
  packages/shared-server/rallar-system/topology/planning/compute-no-rtt-tree-next-hops.ts \
  packages/shared-server/rallar-system/topology/planning/update-no-rtt-tree-attachment-selection.ts \
  packages/shared-server/rallar-system/topology/rallar-rtc-topology-metrics.ts
git diff --check
```

Expected: no applicable warning remains in the changed files, every construction warning has a
recorded disposition, and formatting/diff checks pass.

- [ ] **Step 8: Commit the leaf owners on the non-default branch**

```bash
git add \
  packages/shared-server/rallar-system/services/rallar-rtc-topology-service.ts \
  packages/shared-server/rallar-system/topology \
  packages/tests/shared-server/rallar-system/topology
git commit -m "refactor(rtc-topology): separate planning leaf owners"
```

---

### Task 3: Extract room-graph construction and the planning owner

**Files:**

- Create:
  `packages/shared-server/rallar-system/topology/planning/create-rtc-room-graph.ts`
- Create:
  `packages/shared-server/rallar-system/topology/planning/rtc-topology-planner.ts`
- Modify: `packages/shared-server/rallar-system/services/rallar-rtc-topology-service.ts`
- Modify: `packages/tests/shared-server/rallar-system/topology/planning/rtc-topology-room-graph.test.ts`
- Modify: `packages/tests/shared-server/rallar-system/topology/planning/rtc-topology-planning.test.ts`
- Modify: `packages/tests/shared-server/rallar-system/topology/planning/rtc-topology-plan-determinism.test.ts`

**Interfaces:**

```ts
export interface CreateRtcRoomGraphInput {
    readonly group: GroupSnapshot;
    readonly activeSessionIds: readonly string[];
    readonly rttMeasurements: readonly RttMeasurementInfo[];
    readonly degreeLimit: number;
    readonly rttReportingDegreeLimit: number;
    readonly seedTopology: RallarRtcTopologyKind;
    readonly meshParamK: number;
}

export interface CreateRtcRoomGraphResult {
    readonly graph: WeightedGraph;
    readonly usedSparseFallback: boolean;
}

export function createRtcRoomGraph(input: CreateRtcRoomGraphInput): CreateRtcRoomGraphResult;

export namespace RtcTopologyPlanner {
    export interface Dependencies {
        readonly metrics: RtcTopologyMetrics;
        readonly durationNowMs: () => number;
    }

    export interface PlanInput {
        readonly group: GroupSnapshot;
        readonly rttMeasurements: readonly RttMeasurementInfo[];
        readonly previous: RallarOverlayTopologySnapshot | undefined;
        readonly updateOptions: RallarRtcTopologyUpdateOptions;
        readonly nowEpochMs: number;
    }
}

export class RtcTopologyPlanner {
    constructor(
        serviceOptions: RallarRtcTopologyServiceOptions,
        dependencies: RtcTopologyPlanner.Dependencies
    );
    plan(input: RtcTopologyPlanner.PlanInput): RallarRtcTopologyUpdateResult;
    createRoomGraph(
        group: GroupSnapshot,
        rttMeasurements: readonly RttMeasurementInfo[]
    ): WeightedGraph;
    selectTopology(
        group: GroupSnapshot,
        options: RallarRtcTopologyServiceOptions,
        previousKind?: RallarRtcTopologyKind
    ): RallarRtcTopologyKind;
    readRttReportingDegreeLimit(options: RallarRtcTopologyServiceOptions): number;
    readKindHysteresisWidths(): RtcTopologyKindHysteresisWidths;
}
```

The namespace is type-only and immediately precedes the class. The planner imports the existing
public option/result names without a rename alias. It does not own snapshots, due times, wall-clock
time, persistence, transaction, publication, or replay.

- [ ] **Step 1: Add direct room-graph and planner assertions**

Update the room-graph test to import `createRtcRoomGraph` and assert the exact graph plus
`usedSparseFallback` for:

- no measurements and complete deterministic fallback;
- duplicate reverse RTT pairs with latest version;
- sparse connected input;
- sparse disconnected input falling back to the deterministic graph; and
- delimiter/Unicode-lookalike identities and equal-weight ordering.

Update the planning test to instantiate `RtcTopologyPlanner` with a real `RtcTopologyMetrics` and
deterministic duration clock. Assert star, full tree/mesh, incremental planned, incremental ordinary
fallback, invariant fallback, no-RTT, weighted, per-update option, and hysteresis-hold paths.

- [ ] **Step 2: Run the tests to verify the missing-owner failure**

```bash
npx vitest run \
  packages/tests/shared-server/rallar-system/topology/planning/rtc-topology-room-graph.test.ts \
  packages/tests/shared-server/rallar-system/topology/planning/rtc-topology-planning.test.ts
```

Expected: FAIL because the new modules are absent.

- [ ] **Step 3: Move room-graph construction without changing graph semantics**

Move RTT filtering for graph edges, latest-pair selection, exact sort order, sparse edge insertion,
connectivity, complete fallback edges, graph attributes, RTT lookup, and fallback graph
materialization into `create-rtc-room-graph.ts`.

Use named input interfaces for the former four- and six-parameter helpers. Keep Graphology
construction and `packages/shared-graph` calls direct. Do not change pair keys, sort comparison,
edge caps, degree rules, fallback weights, or connectivity decisions.

- [ ] **Step 4: Implement `RtcTopologyPlanner` as the sole planning orchestrator**

Move into the planner:

- service option/default resolution;
- RTT filtering to active sessions;
- topology-kind selection and hysteresis metric decision;
- star versus incremental versus no-RTT versus weighted selection;
- room-graph timing and sparse-fallback recording;
- tree/mesh shared-graph invocation and next-hop extraction; and
- planning counters/durations and changed/unchanged recording.

Call `computeEvolvedTopologyNextHops`, `computeNoRttTopologyNextHops`, `createRtcRoomGraph`, and
`planRallarRtcTopologySnapshot` directly. Delete each moved implementation from the facade in the
same patch.

- [ ] **Step 5: Reduce the service to explicit planning delegation**

Construct `RtcTopologyPlanner` after `RtcTopologyMetrics`. Keep previous-snapshot selection visible
in `planGroupTopologyAt`:

```ts
const overlayId = toScopedOverlayId(group.group);
const previous = options.previous?.overlayId === overlayId
    ? options.previous
    : this.snapshotsByOverlayId.get(overlayId);
return this.planner.plan({
    group,
    rttMeasurements,
    previous,
    updateOptions: options,
    nowEpochMs
});
```

Task 4 replaces only the final map read with `this.snapshots.get(overlayId)`. The dataflow and
one-call ownership stay fixed. Public methods delegate to the planner without adding alternate
overloads.

- [ ] **Step 6: Run the complete Slice 1 semantic suite**

```bash
npx vitest run \
  packages/tests/shared-server/rallar-system/topology/rallar-rtc-topology-public-compatibility.test.ts \
  packages/tests/shared-server/rallar-system/topology/rallar-rtc-topology-service.test.ts \
  packages/tests/shared-server/rallar-system/topology/planning/rtc-topology-planning.test.ts \
  packages/tests/shared-server/rallar-system/topology/planning/rtc-topology-room-graph.test.ts \
  packages/tests/shared-server/rallar-system/topology/planning/rtc-topology-no-rtt.test.ts \
  packages/tests/shared-server/rallar-system/topology/planning/rtc-topology-plan-determinism.test.ts \
  packages/tests/shared-server/rallar-system/topology/planning/evolve-planned-topology.test.ts \
  packages/tests/shared-server/rallar-system/topology/planning/group-topology-planning-service.test.ts
npx tsc -p packages/shared-server/tsconfig.json --noEmit
```

Expected: all tests and the concrete package typecheck pass. These are the Slice 1 direct behavior
and package validations required by touched-file standards closure.

- [ ] **Step 7: Prove the original style findings are closed, not redistributed**

Run a focused programmatic scan or the canonical checker over the smallest relevant roots. Confirm:

- the facade is below the 1,200-line backstop and no longer in cognitive-load review tier;
- no extracted file enters a review/refactor tier without a coherent reason and approved exception;
- all six former input-contract findings are resolved with named values;
- `NoRttTreeState` and `NoRttNearestChoice` are interfaces;
- `noRttTreeWeight` no longer exists; and
- no new pass-through, rename alias, runtime namespace, construction, or ownership warning exists.

Run:

```bash
npm run check:repo-style -- --root packages/shared-server/rallar-system/topology/planning
npm run check:repo-style:construction-details -- \
  --root packages/shared-server/rallar-system/services
npm run check:repo-structure -- --base 956a057c9ab51c3060f30e60cae48ade24f5ec5c
npx prettier --check \
  packages/shared-server/rallar-system/services/rallar-rtc-topology-service.ts \
  packages/shared-server/rallar-system/topology/rallar-rtc-topology-metrics.ts \
  packages/shared-server/rallar-system/topology/planning/plan-rallar-rtc-topology-snapshot.ts \
  packages/shared-server/rallar-system/topology/planning/compute-no-rtt-topology-next-hops.ts \
  packages/shared-server/rallar-system/topology/planning/create-rtc-room-graph.ts \
  packages/shared-server/rallar-system/topology/planning/rtc-topology-planner.ts \
  packages/tests/shared-server/rallar-system/topology/rallar-rtc-topology-public-compatibility.test.ts \
  packages/tests/shared-server/rallar-system/topology/rallar-rtc-topology-service.test.ts \
  packages/tests/shared-server/rallar-system/topology/planning/rtc-topology-planning.test.ts \
  packages/tests/shared-server/rallar-system/topology/planning/rtc-topology-room-graph.test.ts \
  packages/tests/shared-server/rallar-system/topology/planning/rtc-topology-no-rtt.test.ts \
  packages/tests/shared-server/rallar-system/topology/planning/rtc-topology-plan-determinism.test.ts \
  packages/tests/shared-server/rallar-system/topology/runtime/rtc-topology-metrics.test.ts \
  packages/tests/shared-server/rallar-system/topology/runtime/rtc-topology-runtime-integration.test.ts
git diff --check
```

Expected: formatting/diff pass; structure/style output has no unresolved finding in changed files.

- [ ] **Step 8: Perform the Slice 1 code and legacy review**

Trace the supported export to each result without using this plan as the map. Verify one and only one
implementation of snapshot equality, no-RTT tree, no-RTT mesh, RTT edge sorting, sparse fallback,
kind selection, and full/incremental selection. Classify every affected predecessor helper as
`removed` or `resolved`. No retained legacy is expected.

- [ ] **Step 9: Commit Slice 1 on the non-default branch**

```bash
git add \
  packages/shared-server/rallar-system/services/rallar-rtc-topology-service.ts \
  packages/shared-server/rallar-system/topology/planning \
  packages/shared-server/rallar-system/topology/rallar-rtc-topology-metrics.ts \
  packages/tests/shared-server/rallar-system/topology
git commit -m "refactor(rtc-topology): extract topology planning ownership"
```

---

### Task 4: Extract process snapshot and RTT scheduling ownership

**Files:**

- Create:
  `packages/shared-server/rallar-system/topology/runtime/rtc-topology-snapshot-registry.ts`
- Create:
  `packages/shared-server/rallar-system/topology/runtime/rtc-topology-rtt-rebuild-scheduler.ts`
- Move: `packages/shared-server/rallar-system/topology/rallar-rtc-topology-metrics.ts` to
  `packages/shared-server/rallar-system/topology/runtime/rtc-topology-metrics.ts`.
- Modify: `packages/shared-server/rallar-system/services/rallar-rtc-topology-service.ts`
- Create/modify:
  `packages/tests/shared-server/rallar-system/topology/runtime/rtc-topology-snapshot-registry.test.ts`
- Create/modify:
  `packages/tests/shared-server/rallar-system/topology/runtime/rtc-topology-rtt-rebuild-scheduler.test.ts`
- Modify:
  `packages/tests/shared-server/rallar-system/topology/runtime/rtc-topology-runtime-integration.test.ts`
- Modify: `packages/tests/shared-server/rallar-system/topology/rallar-rtc-topology-service.test.ts`

**Interfaces:**

```ts
export class RtcTopologySnapshotRegistry {
    observe(snapshot: RallarOverlayTopologySnapshot): boolean;
    get(overlayId: string): RallarOverlayTopologySnapshot | undefined;
    has(overlayId: string): boolean;
    remove(overlayId: string): boolean;
    get size(): number;
}

export namespace RtcTopologyRttRebuildScheduler {
    export interface Dependencies {
        readonly nowEpochMs: () => number;
        readonly debounceMs: number;
        readonly metrics: RtcTopologyMetrics;
    }

    export interface QueueInput {
        readonly overlayId: string;
        readonly hasSnapshot: boolean;
    }
}

export class RtcTopologyRttRebuildScheduler {
    constructor(dependencies: RtcTopologyRttRebuildScheduler.Dependencies);
    queue(input: RtcTopologyRttRebuildScheduler.QueueInput): RallarRtcTopologyRttQueueResult;
    claimDue(overlayId: string): boolean;
    readDelayMs(overlayId: string): number | undefined;
    remove(overlayId: string): boolean;
    readDebounceMs(): number;
    get size(): number;
}
```

Both type-only namespaces immediately precede their class. Neither owner converts `GroupRef` or
`GroupSnapshot`; the facade owns scoped-overlay translation.

- [ ] **Step 1: Write registry semantic tests**

Assert:

- first and dominating observations are accepted;
- stale and semantically equal observations do not replace current state;
- equal-causal/different-semantic observation throws the exact revision-conflict error;
- incomparable causal observation throws the exact causal-conflict error;
- `get`, `has`, `remove`, and `size` reflect only registry state; and
- a newer observation survives a later stale observation.

- [ ] **Step 2: Write scheduler semantic tests**

With an injected mutable clock, assert:

- no-snapshot work is immediately due;
- snapshot-backed work uses the configured debounce;
- repeated queue calls retain the first deadline and report the remaining delay;
- early and absent claims skip, due claims execute once, and a second claim skips;
- `remove` clears pending work; and
- queue/claim metrics are identical to baseline behavior.

- [ ] **Step 3: Run the tests to verify the missing-owner failure**

```bash
npx vitest run \
  packages/tests/shared-server/rallar-system/topology/runtime/rtc-topology-snapshot-registry.test.ts \
  packages/tests/shared-server/rallar-system/topology/runtime/rtc-topology-rtt-rebuild-scheduler.test.ts
```

Expected: FAIL because the new modules are absent.

- [ ] **Step 4: Move metrics into the complete runtime owner folder**

Move the already tested `RtcTopologyMetrics` implementation to
`topology/runtime/rtc-topology-metrics.ts`, then update the facade and planner imports directly. Do
not leave a root-path re-export; no production consumer other than the changed facade/planner
requires the old private path.

- [ ] **Step 5: Implement the snapshot registry**

Move `snapshotsByOverlayId` and the exact `compareOverlayTopologyCausalTuple` decision from the
facade. Keep the error strings unchanged. The registry has no metrics dependency; live size is read
by the facade when metrics are requested.

- [ ] **Step 6: Implement the RTT rebuild scheduler**

Move `pendingRttUpdateDueAtByOverlayId`, deadline calculation, coalescing, claim, delay, and
debounce normalization into the scheduler. The scheduler records only queue/flush metrics. It does
not read snapshots directly; `QueueInput.hasSnapshot` makes the decision input visible.

- [ ] **Step 7: Finish the facade lifecycle coordination**

The final facade must visibly perform:

```ts
updateGroupTopology(...) {
  const result = this.planGroupTopology(...);
  this.observeCommittedTopologySnapshot(result.snapshot);
  return result;
}

observeCommittedTopologySnapshot(snapshot) {
  const changed = this.snapshots.observe(snapshot);
  this.rttRebuildScheduler.remove(snapshot.overlayId);
  return changed;
}

removeGroupTopology(group) {
  const overlayId = toScopedOverlayId(group.group);
  this.rttRebuildScheduler.remove(overlayId);
  const removed = this.snapshots.remove(overlayId);
  this.metrics.recordRemoval(removed);
  return removed;
}
```

`readMetrics` calls `metrics.read(snapshots.size, scheduler.size)`. `resetMetrics` never clears
either owner. Public queue/claim/delay methods translate identity once and delegate once.

- [ ] **Step 8: Run direct runtime and facade tests**

```bash
npx vitest run \
  packages/tests/shared-server/rallar-system/topology/runtime/rtc-topology-metrics.test.ts \
  packages/tests/shared-server/rallar-system/topology/runtime/rtc-topology-snapshot-registry.test.ts \
  packages/tests/shared-server/rallar-system/topology/runtime/rtc-topology-rtt-rebuild-scheduler.test.ts \
  packages/tests/shared-server/rallar-system/topology/runtime/rtc-topology-runtime-integration.test.ts \
  packages/tests/shared-server/rallar-system/topology/rallar-rtc-topology-service.test.ts \
  packages/tests/shared-server/rallar-system/topology/rallar-rtc-topology-public-compatibility.test.ts
npx tsc -p packages/shared-server/tsconfig.json --noEmit
```

Expected: all runtime/facade tests and the concrete package typecheck pass.

- [ ] **Step 9: Run existing integration consumers of the facade**

```bash
npx vitest run \
  packages/tests/shared-server/rallar-system/topology/planning/group-topology-planning-service.test.ts \
  packages/tests/shared-server/rtc-topology-outbox-work.test.ts \
  packages/tests/shared-server/rallar-system/rtc-topology/rtc-rtt-topic.test.ts \
  packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts \
  packages/tests/shared-server/topology-app-inbox-transaction.test.ts \
  packages/tests/shared-server/api-rtc-topology-admin-metrics.test.ts
```

Expected: unchanged planning, durable work, RTT scheduling, WS, AppInbox, and admin-metric behavior.

- [ ] **Step 10: Close Slice 2 production and test files**

Review every changed file completely. Resolve all applicable style, construction, type, naming,
responsibility, and legacy findings. Run:

```bash
npm run check:repo-style -- --root packages/shared-server/rallar-system/topology/runtime
npm run check:repo-style -- --root packages/shared-server/rallar-system/topology/planning
npm run check:repo-style:construction-details -- \
  --root packages/shared-server/rallar-system/services
npm run check:repo-structure -- --base 956a057c9ab51c3060f30e60cae48ade24f5ec5c
npm run test:repo-structure
npx prettier --check \
  packages/shared-server/rallar-system/services/rallar-rtc-topology-service.ts \
  packages/shared-server/rallar-system/topology/runtime \
  packages/shared-server/rallar-system/topology/planning/rtc-topology-planner.ts \
  packages/tests/shared-server/rallar-system/topology/rallar-rtc-topology-service.test.ts \
  packages/tests/shared-server/rallar-system/topology/runtime
git diff --check
```

Expected: tests/format/diff pass; no changed-file structure or style finding remains unresolved.

- [ ] **Step 11: Commit Slice 2 on the non-default branch**

```bash
git add \
  packages/shared-server/rallar-system/services/rallar-rtc-topology-service.ts \
  packages/shared-server/rallar-system/topology/runtime \
  packages/tests/shared-server/rallar-system/topology
git commit -m "refactor(rtc-topology): separate process runtime ownership"
```

---

### Task 5: Update navigation, validate the final candidate, and disposition follow-ups

**Files:**

- Modify: `packages/shared-server/rallar-system/topology/README.md`
- Modify: `docs/rallar-convergent-state-and-rtc-topology.md`
- Modify: `docs/rallar-rtc-rtt-reporting.md`
- Modify only for a verified new finding: GitHub issue state outside the repository.

**Interfaces:**

- Consumes: completed facade, planning owners, runtime owners, semantic tests, benchmark harness.
- Produces: truthful current navigation, final validation evidence, affected-legacy disposition,
  and issue URLs for every confirmed weakness.

- [ ] **Step 1: Update the durable topology navigation map**

In `topology/README.md`, keep `GroupTopologyManagementService` as the overall topology capability
entry. Add a current RTC topology service section naming:

- supported facade: `../services/rallar-rtc-topology-service.ts`;
- planning result: `planning/plan-rallar-rtc-topology-snapshot.ts`;
- planner: `planning/rtc-topology-planner.ts`;
- room graph: `planning/create-rtc-room-graph.ts`;
- no-RTT dispatch/star/mesh: `planning/compute-no-rtt-topology-next-hops.ts`;
- no-RTT tree construction: `planning/compute-no-rtt-tree-next-hops.ts`;
- no-RTT tree attachment selection: `planning/update-no-rtt-tree-attachment-selection.ts`;
- snapshot registry: `runtime/rtc-topology-snapshot-registry.ts`;
- RTT scheduler: `runtime/rtc-topology-rtt-rebuild-scheduler.ts`; and
- metrics: `runtime/rtc-topology-metrics.ts`.

Add the construction and the two runtime timelines from the design. Do not rewrite the existing
AppInbox, config, replay, or reconnect traces.

- [ ] **Step 2: Correct active product navigation**

Update `docs/rallar-convergent-state-and-rtc-topology.md` so the service is the supported facade,
planning/graph decisions point to their planning owners, and process state points to runtime owners.

Update `docs/rallar-rtc-rtt-reporting.md` so “How RTT Affects Topology” names the planner and room
graph owners while retaining `RallarRtcTopologyService` as the supported API used by composition,
benchmarks, and topic scheduling.

Review both documents in full for current paths touched by this change. Do not edit inert historical
plans to make them look current.

- [ ] **Step 3: Perform a cold code-only navigation review**

Without using this plan or design as the map, start at:

```text
packages/shared-server/mod.ts
  -> RallarRtcTopologyService
  -> planGroupTopologyAt
  -> RtcTopologyPlanner.plan
  -> selected leaf algorithm
  -> planRallarRtcTopologySnapshot
  -> caller-visible result
```

Then trace queue, claim, committed observation, conflict, removal, and metrics reset. Record any
wrong-file guess, ambiguous owner, duplicate decision, pass-through hop, hidden callback, or missing
failure boundary. Fix a recoverable navigation defect in the selected owners before validation. If
one coherent consolidation still cannot recover the path, stop for human direction.

- [ ] **Step 4: Run the complete focused topology test set**

```bash
npx vitest run \
  packages/tests/shared-server/rallar-system/topology/rallar-rtc-topology-public-compatibility.test.ts \
  packages/tests/shared-server/rallar-system/topology/rallar-rtc-topology-service.test.ts \
  packages/tests/shared-server/rallar-system/topology/planning/rtc-topology-planning.test.ts \
  packages/tests/shared-server/rallar-system/topology/planning/rtc-topology-room-graph.test.ts \
  packages/tests/shared-server/rallar-system/topology/planning/rtc-topology-no-rtt.test.ts \
  packages/tests/shared-server/rallar-system/topology/planning/rtc-topology-plan-determinism.test.ts \
  packages/tests/shared-server/rallar-system/topology/planning/canonical-topology-planning-input.test.ts \
  packages/tests/shared-server/rallar-system/topology/planning/evolve-planned-topology.test.ts \
  packages/tests/shared-server/rallar-system/topology/planning/topology-kind-hysteresis.test.ts \
  packages/tests/shared-server/rallar-system/topology/planning/group-topology-planning-service.test.ts \
  packages/tests/shared-server/rallar-system/topology/runtime/rtc-topology-metrics.test.ts \
  packages/tests/shared-server/rallar-system/topology/runtime/rtc-topology-snapshot-registry.test.ts \
  packages/tests/shared-server/rallar-system/topology/runtime/rtc-topology-rtt-rebuild-scheduler.test.ts \
  packages/tests/shared-server/rallar-system/topology/runtime/rtc-topology-runtime-integration.test.ts \
  packages/tests/shared-server/rtc-topology-outbox-work.test.ts \
  packages/tests/shared-server/rallar-system/rtc-topology/rtc-rtt-topic.test.ts \
  packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts \
  packages/tests/shared-server/topology-app-inbox-transaction.test.ts \
  packages/tests/shared-server/api-rtc-topology-admin-metrics.test.ts
```

Expected: PASS. Classify a failure as regression, infrastructure/flaky, obsolete coupled test, or
invalid assumption before editing production.

- [ ] **Step 5: Run package, app, benchmark-package, and API topology validation**

```bash
npx tsc -p packages/shared-server/tsconfig.json --noEmit
(cd apps/api-v1 && deno task check)
npm --workspace @ar-eye-hunter/shared-rtc-bench run check
npm run test:api-v1:black-box:postgres:medium-scale
```

Expected: all commands pass. Report Postgres/service unavailability as skipped with the exact
environment blocker; do not weaken the fixed 100-client/five-group/three-process gate.

Do not run `npm run perf:api-v1:state-write`: no mutation path or concurrency domain changed. Do not
run `test:api-v1:black-box:postgres:topology-replay` unless the diff or a failure proves that stream,
cursor, replay, reconnect, retention, or cutover behavior changed.

- [ ] **Step 6: Run complete style, structure, format, and diff validation**

```bash
npm run check:repo-style:changed -- 956a057c9ab51c3060f30e60cae48ade24f5ec5c
npm run check:repo-style
npm run check:repo-structure -- --base 956a057c9ab51c3060f30e60cae48ade24f5ec5c
npm run test:repo-structure
git diff --name-only --diff-filter=ACMR \
  956a057c9ab51c3060f30e60cae48ade24f5ec5c..HEAD -- '*.ts' '*.md' \
  | xargs npx prettier --check
git diff --check 956a057c9ab51c3060f30e60cae48ade24f5ec5c..HEAD
```

Expected: changed style, structure tests, Prettier, and diff checks pass. Full style remains
warning-only globally. Resolve every changed-file finding, and record every construction-detail
finding by path, rule, and symbol with its disposition.

- [ ] **Step 7: Commit current navigation on the non-default branch**

```bash
git add \
  packages/shared-server/rallar-system/topology/README.md \
  docs/rallar-convergent-state-and-rtc-topology.md \
  docs/rallar-rtc-rtt-reporting.md
git commit -m "docs(rtc-topology): update service ownership navigation"
```

The worktree must now be clean before accepted candidate performance capture.

- [ ] **Step 8: Capture and validate the clean candidate RTC-B03 evidence**

Run:

```bash
RTC_TOPOLOGY_CANDIDATE_SHA=$(git rev-parse --short=12 HEAD)
RTC_TOPOLOGY_CANDIDATE_ID="20260816-${RTC_TOPOLOGY_CANDIDATE_SHA}-e1-local"

npm run perf:rtc-baseline -- initialize \
  --baseline-id="${RTC_TOPOLOGY_CANDIDATE_ID}" \
  --workloads=RTC-B03 \
  --environment=E1-local

npm run perf:rtc-baseline -- capture \
  --baseline-id="${RTC_TOPOLOGY_CANDIDATE_ID}" \
  --workload=RTC-B03

npm run perf:rtc-baseline -- finalize \
  --baseline-id="${RTC_TOPOLOGY_CANDIDATE_ID}"

npm run perf:rtc-baseline -- validate \
  --baseline-id="${RTC_TOPOLOGY_CANDIDATE_ID}"
```

Expected: all commands exit zero and every B03 semantic case is accepted. Compare the candidate
summary case by case on the same host against accepted prerequisite artifact
`20260816-15ff8b402e99-e1-local`, not the preserved product-base diagnostic. Do not invent a numeric
SLO. If timing movement is suspicious, repeat both sides or profile before classifying a regression.
A deterministic output, operation-count, allocation-growth, or obvious algorithmic regression
blocks completion.

- [ ] **Step 9: Perform the complete code and legacy review**

Trace every changed production path from the supported export to result. Confirm:

- no public signature, export, import path, error, output, metric, or timing boundary changed;
- no algorithm exists in both facade and extracted owner;
- no second facade, nested barrel, alias, adapter, fallback, test-only construction, or moved-path
  shim exists;
- every predecessor helper is `removed` or `resolved`;
- the supported service facade is a real package/lifecycle boundary, not compatibility legacy; and
- independent untouched API composition, RTC RTT persistence, graph optimization, replay, and
  refinement-expiry code remained outside closure.

Any `retained` affected legacy item requires explicit authorized-maintainer approval and a durable
registry entry before completion.

- [ ] **Step 10: Disposition every bug and weakness**

For each finding made during implementation:

1. record its exact file/symbol and whether it is a bug, standards problem, proven weakness, strong
   suspicion, or needs runtime measurement;
2. fix bugs with failing semantic tests and a separate explanation;
3. close standards problems in the touched file;
4. search open issues for confirmed independent weaknesses;
5. reuse an accurate issue or create one with evidence, impact, safe next step, and acceptance; and
6. include every reused/created issue URL in the final handoff.

At minimum retain these dispositions: #235 open/out of scope; #237 open/out of scope; #240's
implementation is present independently on `main` at `40b9c2b0`, while GitHub issue metadata remains
open and tracker closure is external; and #236 is ready to close only when every acceptance
criterion passes.

- [ ] **Step 11: Prepare the local completion handoff**

Report:

- exact changed files and final ownership;
- why the facade path was retained;
- observable behavior preserved and any separately fixed bug;
- every command passed, failed, retried, skipped, or unavailable;
- base and candidate RTC-B03 artifact identifiers and interpretation;
- style/structure/construction and affected-legacy dispositions; and
- all follow-up issue URLs, or an explicit statement that no new weakness was confirmed.

Stop with clean local implementation commits on the non-default branch. Do not push or create a pull
request unless the maintainer asks after reviewing the local result.
