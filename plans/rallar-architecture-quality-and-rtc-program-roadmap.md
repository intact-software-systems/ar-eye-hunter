# Rallar Architecture Quality And RTC Program Roadmap

> **For agents:** This is the live cross-program coordination record. Use the
> concern-specific plan for implementation. Only the current roadmap coordinator
> edits this file. Track agents report evidence and update their own child plans.

**Started:** 2026-08-06

**Status:** Phase 0 `verified`; Phase 1 remains `in-progress`, with human auth
PR A externally `verified` and the ontology/RTC tracks held at a structural
plan-decision point after successful semantic prototypes. Phase 2 remains
`not-started`.

**Human owner:** Product/technical owner

**Current roadmap coordinator:** The active primary agent for this roadmap task

**Last reconciliation:** 2026-08-07 on
`codex/phase-1-architecture-rtc-roadmap`, after reconciling current
`origin/main` `a90042398448776b0972aaaaa0f5cca762163fde` (tree
`9a3084c2c78f90f004054924b99b97be67fe72bd`) while retaining Phase 0 closure
anchor `d68d5112797b2cf8332dfe0243cebbe545da89c9` as historical evidence.

**Stable design:**
[Rallar architecture quality and RTC program design](../docs/superpowers/specs/2026-08-06-rallar-architecture-quality-and-rtc-program-design.md)

## 1. Goal And Boundaries

Coordinate three independently executable programs:

1. [human-traceability refactoring](repo-human-traceability-refactoring-program-plan.md);
2. [ontology implementation](../docs/superpowers/plans/2026-08-05-rallar-ontologies-implementation-plan.md);
3. RTC performance measurement and optimization.

This roadmap owns order, cross-program gates, reservations, and handoffs. It
does not authorize source changes, replace a child plan, or duplicate task
details from the authoritative plans.

Global constraints:

- Human understandability governs design after correctness, safety, security,
  compatibility, and required performance.
- No ontology task may change runtime routing, validation, packets, authority,
  or payload size unless separate compatibility work is approved.
- No readability refactor may hide an optimization or semantic change.
- No RTC optimization begins without a reproducible baseline and focused
  correctness evidence.
- Existing public exports and import paths remain compatible unless an approved
  plan explicitly says otherwise.
- Generated profiles remain under `tmp/perf/` and are not committed unless the
  human explicitly requests it.
- Each track obeys the repository's local, publication, and remote completion
  gates on its own final unchanged tree.

## 2. Document And Agent Ownership

| Record                         | Writer                                                  | Update trigger                                                             |
| ------------------------------ | ------------------------------------------------------- | -------------------------------------------------------------------------- |
| This roadmap                   | Exactly one current primary/coordinating agent          | Phase, verified milestone, blocker, reservation, or human decision changes |
| Human master/execution plans   | Human-program coordinator under their existing protocol | An authorized child changes state or its external evidence is verified     |
| Human child plan               | Agent executing that approved child                     | The child plan requires progress/evidence publication                      |
| Ontology implementation plan   | Ontology track owner under its plan                     | A task milestone or pilot/governance decision must be recorded             |
| RTC baseline/optimization plan | RTC performance track owner                             | Workload, baseline, experiment, or accepted result changes                 |
| Git/CI/performance artifacts   | Producing system or track                               | Evidence is generated; agents reference it rather than re-create it here   |

### Coordinator handoff

A replacement coordinator must first:

- read this roadmap and the three authoritative program records;
- inspect `git status`, current branch, current `HEAD`, and recent history;
- verify any claimed remote or measurement evidence that is material to the
  next transition;
- list active write reservations; and
- update the coordinator and reconciliation date below before assigning work.

Track agents must not edit this roadmap merely to report that their local work
passed. Their completion handoff supplies exact evidence to the coordinator.

## 3. State Model

| State            | Meaning                                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| `not-started`    | No authorized work is active.                                                                                    |
| `ready`          | Prerequisites are verified and a concern-specific plan defines the work.                                         |
| `in-progress`    | Authorized work is executing.                                                                                    |
| `local-complete` | Scoped local work and required local checks passed, but publication evidence is incomplete.                      |
| `published`      | The change is on the intended branch/default branch; required remote evidence may still be pending.              |
| `verified`       | Exact required local and every applicable branch, merge or direct-main, and default-branch evidence is recorded. |
| `blocked`        | A named prerequisite, conflict, or human decision prevents progress.                                             |
| `deferred`       | The human explicitly removed the item from the current phase.                                                    |

Only `verified` satisfies a cross-program publication gate. A plan's own state
model remains authoritative when it is more specific, such as the human
program's `ledger-published` state.

## 4. Reconciled Starting Point

| Program                    | State                                                                   | Current evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Next required action                                                                                                                                                           |
| -------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Human traceability         | client state `ledger-published`; auth PR A externally `verified`        | Approved auth-plan anchor `123990bceac9732660e1113101addd5b194d8347` remains supported by [PR #76's closure record](https://github.com/intact-software-systems/ar-eye-hunter/pull/76#issuecomment-5205571315). [PR #78](https://github.com/intact-software-systems/ar-eye-hunter/pull/78) published feature `5118891effa1b9c856154ecab051c2df1b094145`, tree `0082575cf0697a170c2125cf856ae07fedfe37e2`; [Branch Release Gate 31159741601](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/31159741601), attempt 1, job `92807133690`, succeeded. It merged as current `main` `a90042398448776b0972aaaaa0f5cca762163fde`, tree `9a3084c2c78f90f004054924b99b97be67fe72bd`; [Run Hetzner Supported Distributed Manifests 31163606362](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/31163606362), attempt 1, succeeded. The [read-only closure handoff](https://github.com/intact-software-systems/ar-eye-hunter/pull/78#issuecomment-5215094789) records all exact jobs. The merged auth-plan blob is now `42076f35734c8dade59947d3740c21a1e811c73b`, but its own Task 3/progress checkboxes still predict pending publication. | Human-program owner reconciles its authoritative plans with the verified PR A envelope. PR B/C remain inactive. The auth-tree prerequisite for later RTC-B06 is satisfied.     |
| Ontology                   | plan `verified`; Task 1 semantic prototype approved; decision hold      | Exact approved plan blob `9267a16a3fa3c547ba7db9ce4fd55f858f7d9e37` remains unchanged on current `main`. The exact six-path prototype on base `d68d511...` passed 47/47 focused tests, shared type-check, formatting, and independent semantic review. It has no commit or PR. Publication is blocked by exact changed-style findings for a 954-line registry, an 842-line test, the unapproved narrow `mod.ts` boundary, and the domain-contract filename/export mismatch. Current-main drift also requires rebase and renewed evidence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Human approves or rejects the exact 17-path responsibility/checker-boundary plan amendment below. Only then may the track publish a new exact plan blob, rebase, and continue. |
| RTC performance            | plan accepted; B01-B05 semantic prototype approved; decision hold       | Exact accepted plan blob `50614b299cfc9b1d85aafb1e32537e56f512ff3d` remains unchanged on current `main`. The 21-path B01-B05 prototype on base `d68d511...` reached independent semantic approval, then passed its final 23/23 contract tests, exact 19-file Deno check, browser syntax, formatting, and diff check after the last local cleanup. An earlier 33-file/475-test correctness cohort passed but was invalidated as completion evidence by those later edits and current-main drift. No baseline was captured and no commit/PR exists. Publication remains blocked by the approved broad Deno glob's 16 errors in three unreserved historical probes, a 1,425-checker-line envelope, an 879-line contract test, a 440-checker-line diagnostics harness, and new root density/prefix findings. [PR #40](https://github.com/intact-software-systems/ar-eye-hunter/pull/40) still owns only `scripts/perf/README.md` within the initial reservation.                                                                                                                                                                                                                  | Human approves or rejects the exact RTC plan/reservation amendment below. Keep README, B06 implementation, RTC-B07, capture, production changes, and optimization held.        |
| Cross-program coordination | Phase 0 `verified`; Phase 1 `in-progress` with two human decision holds | Phase 0 remains anchored by [PR #77](https://github.com/intact-software-systems/ar-eye-hunter/pull/77), `d68d511...`, and [run 31122914721 attempt 4](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/31122914721/attempts/4). Draft [PR #79](https://github.com/intact-software-systems/ar-eye-hunter/pull/79) published the Phase 1 activation at `ce621a8128bfad5a8a4dbec5d895ab5bf87076f9`, tree `ec15fe11953aaf987c46b9ea5f9c6ecf7bfebb8d`; [Branch Release Gate 31158965238](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/31158965238), job `92804701468`, succeeded, and the [activation record](https://github.com/intact-software-systems/ar-eye-hunter/pull/79#issuecomment-5214334597) is durable. Current `main` then advanced through verified auth PR A; the coordinator branch has reconciled that change without redefining the Phase 0 anchor.                                                                                                                                                                                                                                                                | Publish this verified blocker/decision reconciliation on PR #79, obtain the two exact plan-amendment decisions, and do not start Phase 2.                                      |

The roadmap records externally verified auth publication but does not edit or
advance its plans. Ontology and RTC authority remains limited to the named
reservations below; proposed amended reservations are explicitly inactive until
their new plan blobs are published and approved.

## 5. Work Routing And Reservations

### Default path ownership

| Track                     | Independent write set                                                                                   | Must coordinate before touching                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Coordination              | This design and this roadmap                                                                            | Any concern-specific implementation plan                                                    |
| Human traceability        | Paths named by its explicitly activated approved child                                                  | Ontology sources/bindings, RTC benchmark scripts, or another human child                    |
| Ontology foundation/pilot | `packages/shared/ontology/**`, named ontology tests, generated ontology docs/artifacts                  | Root scripts, barrels, public snapshots, or production files owned by active human/RTC work |
| RTC baseline              | The RTC baseline plan, `scripts/perf/**` additions approved by it, and uncommitted `tmp/perf/**` output | Production RTC/realtime sources or shared integration files                                 |

### Serialized integration paths

One agent at a time owns:

- `packages/shared/ontology/mod.ts`;
- ontology aggregate generators, artifacts, reports, and aggregate tests;
- package barrels/public export snapshots;
- root `package.json` and shared checker scripts; and
- any production RTC/realtime path that appears in both an active readability
  child and an RTC experiment.

The coordinator records a temporary reservation here before parallel work
starts:

| Reservation            | Owner                                                                 | State                               | Release condition / hold                                                                                                                                                                                                                                                                                |
| ---------------------- | --------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Coordination documents | Roadmap coordinator on `codex/phase-1-architecture-rtc-roadmap`       | active                              | Release after the Phase 1 exit envelope and external evidence are recorded.                                                                                                                                                                                                                             |
| Ontology Task 1 paths  | `/root/ontology_task1_owner` on `codex/rallar-ontology-foundation`    | held at structural decision         | The old six-path reservation against blob `9267a16...` is not widened. After envelope approval, only the ontology plan may be edited/published to create a new exact blob; source implementation/publication remains held until that blob and the proposed reservation receive separate human approval. |
| RTC Phase 1 baseline   | `/root/rtc_baseline_owner` on `codex/rallar-rtc-performance-baseline` | held at structural decision         | The old Section 10 reservation against blob `50614b2...` is not widened. After envelope approval, only the RTC plan may be edited/published to create a new exact blob; instrumentation/capture/publication remains held until exact-blob approval. README/PR #40, B06, B07, and production stay held.  |
| Human auth PR A        | Human-program owner through PR #78                                    | externally verified, read-only here | PR A merged and its exact resulting-main workflow succeeded. The human-program owner must reconcile its stale Task 3/progress record. PR B/C remain inactive.                                                                                                                                           |

No other path is active. A held path requires a later verified ownership or
conflict update before its track agent may write or execute it.

### Proposed Phase 1 structural decision envelope — inactive

The two proposals below preserve the already reviewed ontology semantics and
frozen RTC workloads. Listing them does not activate a path or amend a child
plan. Each concern owner must first publish its own revised plan, record the new
Git blob, and obtain human approval of that exact blob. Only the roadmap
coordinator may then activate the corresponding cross-program reservation.

#### Proposed Ontology Task 1 reservation

- `packages/shared/ontology/rallar-ontology-contracts.ts`
- `packages/shared/ontology/rallar-domain-ontology-term.ts`
- `packages/shared/ontology/rallar-realtime-ontology-contracts.ts`
- `packages/shared/ontology/rallar-ontology-registry-contracts.ts`
- `packages/shared/ontology/rallar-ontology-identity-validation.ts`
- `packages/shared/ontology/validate-rallar-ontology-vocabulary-module.ts`
- `packages/shared/ontology/validate-rallar-ontology-binding-module.ts`
- `packages/shared/ontology/validate-rallar-ontology-catalog.ts`
- `packages/shared/ontology/rallar-ontology-registry.ts`
- `packages/shared/ontology/mod.ts`
- `packages/tests/shared/rallar-ontology-test-fixtures.ts`
- `packages/tests/shared/rallar-ontology-registry.test.ts`
- `packages/tests/shared/rallar-ontology-vocabulary-validation.test.ts`
- `packages/tests/shared/rallar-ontology-binding-validation.test.ts`
- `packages/tests/shared/rallar-ontology-catalog-validation.test.ts`
- `scripts/repo-style-check/layout-rules.mjs`
- `packages/tests/repo/repo-style-layout-rules.test.ts`

The amendment must keep the public Task 1 API/behavior unchanged, keep every
new Task 1 source/test at or below 400 physical lines, and add only
`packages/shared/ontology/mod.ts` to the existing exact compatibility-boundary
allowlist with its semantic checker test. It may not change checker rule IDs,
thresholds, suppressions, another compatibility boundary, package barrels,
runtime imports, packets, payloads, authority, routing, validation, generated
artifacts, or Tasks 2-11.

#### Proposed RTC reservation and publication rule

For B01-B05, retain the baseline plan, the existing 16 named TypeScript
harnesses, `scripts/perf/rtc-data-channel-browser-soak.mjs`, and ignored
`tmp/perf/rtc-baseline/**`, while replacing the three new root TypeScript files
with:

- `scripts/perf/rtc-baseline/rtc-baseline-contracts.ts`
- `scripts/perf/rtc-baseline/rtc-baseline-validation.ts`
- `scripts/perf/rtc-baseline/rtc-baseline-envelope.ts`
- `scripts/perf/rtc-baseline/rtc-data-channel-drain-bench.ts`
- `scripts/perf/rtc-baseline/rtc-rtt-repository-filter-bench.ts`
- `scripts/perf/rtc-baseline/rtc-peer-connection-diagnostics-runtime.ts`
- `packages/tests/repo/rtc-performance-baseline-contract.test.ts`
- `packages/tests/repo/rtc-performance-baseline-harnesses.test.ts`

The amended focused Deno gate must name those six feature-folder files and the
16 accepted existing TypeScript harnesses exactly; it must not silently pull in
or repair the three unreserved historical probes. Publish one RTC branch/draft
PR as ordered foundation, B01, B02, B03, B04, and B05 commits. Its final
unchanged, fully gated head is the B01-B05 measurement anchor.

The revised plan must also retain the reviewed evidence contract: JSON-safe
round trips; live clean-Git, source, configuration, and redacted-command
reconciliation; baseline-ID path confinement and exclusive writes; retained
failure artifacts followed by nonzero exit; exact workload inputs and complete
sample-set accounting; and the reviewed B01-B04 correctness invariants.
Existing README commands remain supported as confined, non-overwriting
diagnostic runs that cannot emit accepted baseline evidence; accepted capture
requires the complete environment/sample/output envelope.

The later B06 reservation remains inactive and is limited to:

- `tests/playwright/rallar-black-box/live-rtc-performance-evidence.ts`
- `packages/tests/rallar-black-box/live-rtc-performance-evidence.test.ts`
- `tests/playwright/rallar-black-box/full-stack-live-rtc-three-browser-matrix.spec.ts`
- `packages/tests/rallar-black-box/live-rtc-three-browser-script-gates.test.ts`
- `docs/repo-code-style-exceptions.md`

Its proposed exception is one exact `structured test scenario` entry for the
existing matrix spec, owned by RTC baseline work and reviewed/removed before
the spec's next material post-Phase-1 change. It is not a threshold or
repository-wide waiver. B06 receives its own later clean measurement head and
fresh gates. Before selecting a candidate using both heads, rerun the relevant
B01-B05 workload on the B06 head. `scripts/perf/README.md` remains held for PR
#40; the existing B06 coverage test remains untouched absent a separately
approved coverage-semantic change.

## 6. Phase 0 — Establish Control And Measurement Design

**Objective:** Make the three programs independently executable and safely
interleavable before adding ontology code or optimizing RTC production paths.

### Task 0A: Publish the coordination design and roadmap

**Files:**

- `docs/superpowers/specs/2026-08-06-rallar-architecture-quality-and-rtc-program-design.md`
- `plans/rallar-architecture-quality-and-rtc-program-roadmap.md`

**Steps:**

- [x] Separate stable design from live progress state.
- [x] Define single-writer roadmap ownership and track-agent handoffs.
- [x] Define change routing, path reservations, states, and phase gates.
- [x] Reconcile local Git history through current `main`.
- [x] Run document formatting and diff checks.
- [x] Publish the original coordination draft on `main` at
      `92f3f4f3fb6ea0bbadbf006cd3483e618726f001` and verify its named
      default-branch workflow.
- [x] Obtain human review of the roadmap content.
- [x] Publish this Phase 0 reconciliation through the repository's plan-document
      process and record its external evidence outside the candidate itself.

**State:** `verified`. PR #77 merged as
`d68d5112797b2cf8332dfe0243cebbe545da89c9`; resulting-main run 31122914721,
attempt 4, succeeded. The durable closure record linked in Section 4 preserves
the exact jobs and artifacts.

### Task 0B: Reconcile existing publication envelopes

**Owner:** Roadmap coordinator or a read-only evidence agent assigned by the
coordinator.

**Steps:**

- [x] Verify ledger PR #75's feature commit/tree, Branch Release Gate, resulting
      `main` commit, and default-branch workflow.
- [x] Because all named evidence is green, record client-state as
      `ledger-published` in the appropriate coordination/evidence record.
- [x] Verify the applicable default-branch workflow for ontology-plan commit
      `254e8a05a962abb4f8df49da80d761ab3d922d56`.
- [x] Record failures as failures with exact run/job/step; do not diagnose or
      relabel them inside this task.

**Verified ancillary failures:**

- Client-state Branch Release Gate
  [run 31097790516, attempt 1](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/31097790516/attempts/1)
  failed in job `Release Gate / Release Gate`, step `Run root CI suite`, when
  unchanged test `packages/tests/shared/ws-outbox-owner-miss-retry.test.ts:196`
  observed `FAILED` instead of expected `RETRY`. Attempt 2 succeeded for the
  same exact feature tree without a content change.
- Client-state resulting-main Deploy Web + API
  [run 31100952064](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/31100952064),
  attempt 1, failed at job `92614114557`; job name
  `Enforce Cloudflare main-only branch controls`; failed step 4,
  `Disable feature-branch Workers and Pages builds`.
- Ontology-plan Deploy Web + API
  [run 31103071859](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/31103071859),
  attempt 1, failed at job `92621232924`, the same named job and step.
- The client-state commit also reported failed Deno Deploy contexts for
  [rallar-bb-server](https://console.deno.com/intact-software-systems/rallar-bb-server/builds/tfmf3m7yxd4e),
  [rallar-server](https://console.deno.com/intact-software-systems/rallar-server/builds/cme3jtjx2bgz),
  and
  [relic-hunters](https://console.deno.com/intact-software-systems/relic-hunters/builds/g4xhx17cxgsz).
- The ontology-plan commit also reported failed Deno Deploy contexts for
  [rallar-bb-server](https://console.deno.com/intact-software-systems/rallar-bb-server/builds/aeamg6v3sayp),
  [rallar-server](https://console.deno.com/intact-software-systems/rallar-server/builds/bm16tz9b0yh3),
  and
  [relic-hunters](https://console.deno.com/intact-software-systems/relic-hunters/builds/8g1vnjcxm4d0).

These failures are not relabelled and remain unresolved. They do not replace
the roadmap's explicitly named successful default-branch publication workflow.
They are a scoped release blocker: a separate operations owner must be assigned
before any release claim that depends on the affected Deploy Web + API or Deno
Deploy contexts. They do not block unrelated tracks or release claims that do
not depend on those contexts.

**State:** `verified` for the required Phase 0 publication envelopes; ancillary
deployment failures recorded.

### Task 0C: Draft the RTC performance baseline plan

**Target file:**
`docs/superpowers/plans/2026-08-06-rallar-rtc-performance-baseline-plan.md`

**Required contents:**

- [x] Inventory current RTC/realtime production paths and consumers before
      proposing changes.
- [x] Inventory relevant existing harnesses under `scripts/perf/**` and state
      what each can and cannot prove.
- [x] Define representative environments and fixed workloads for connection
      setup, signaling, data-channel queueing, topology/RTT, multicast, reconnect,
      and long-running retention/cleanup where applicable.
- [x] Define correctness checks, warmup, sample count, noise handling, captured
      runtime/commit/configuration, and before/after comparison rules.
- [x] Define hotspot selection criteria and stop conditions.
- [x] Separate instrumentation, baseline capture, structural refactoring, and
      optimization into independently reviewable tasks.
- [x] Keep generated profiles under `tmp/perf/` and define the small durable
      summary that may be reviewed or published.
- [x] Map candidate production paths against active and planned human-readability
      children so overlapping write sets are serialized.

**State:** planning task `verified` against exact blob
`50614b299cfc9b1d85aafb1e32537e56f512ff3d` and workloads `RTC-B01` through
`RTC-B06`. Section 5 records the later Phase 1 activation and its holds. No
baseline capture, production change, remote `RTC-B07` run, or optimization has
started.

### Task 0D: Approve the Phase 1 launch envelope

The human reviews one concise launch record containing:

- exact ontology plan revision and approval scope for Task 1 only;
- accepted RTC baseline workloads and environment limitations;
- verified client-state ledger status and the selected next human child;
- the first three write reservations; and
- any known shared-path serialization.

**State:** `verified`. PR #77 and resulting-main run 31122914721 attempt 4
provide the exact approval-record publication evidence. The later Phase 1
activation is recorded in Sections 4-5.

### Approved Phase 1 launch envelope — later activation recorded in Section 5

Approval applies only to the exact items below. It starts no work by itself;
the coordinator records each approved cross-program reservation, while the
assigned concern-specific track owner activates and updates its own work.

#### Approval record

On 2026-08-06, the human owner approved the envelope as proposed after reviewing
draft PR #77 candidate commit `693446cdf8ba5fc1c027f1e854c6b2d8825e4901`,
tree `5779939bc76d313377aa672d6cc2fe45d9339a6a`, and roadmap blob
`f17157c4fc9035573f2ba88bfa17860dab18424f`. This approval-record edit changes
the roadmap blob but does not revise that reviewed scope. The approval:

1. approves the reconciled roadmap content and Phase 0 decision exit;
2. approves ontology Task 1 only against exact plan blob
   `9267a16a3fa3c547ba7db9ce4fd55f858f7d9e37` and the six paths below;
3. accepts RTC workloads `RTC-B01` through `RTC-B06` and their initial
   measurement reservation against exact RTC plan blob
   `50614b299cfc9b1d85aafb1e32537e56f512ff3d`;
4. selects the already approved auth child at exact blob
   `123990bceac9732660e1113101addd5b194d8347`, with Task 1 first, PR A gated,
   and PR B/C inactive;
5. allows Postgres only when a measured candidate call path requires
   database-backed admission, topology, or persistence, while remote `RTC-B07`
   remains held; and
6. requires a separate operations owner before any release claim affected by
   the recorded Deploy Web + API or Deno Deploy failures, without blocking
   unrelated tracks.

This Phase 0 approval alone assigned no track owner, activated no reservation,
and authorized no source edit, instrumentation run, baseline capture, remote
fleet work, or optimization. Section 5 records the later, separate Phase 1
owner assignments and activation; each owner remains bound to the authoritative
child plan and its gates.

#### Ontology Task 1 approval revision

- Plan:
  `docs/superpowers/plans/2026-08-05-rallar-ontologies-implementation-plan.md`
- Exact plan blob: `9267a16a3fa3c547ba7db9ce4fd55f858f7d9e37`.
- Publication commit/tree:
  `254e8a05a962abb4f8df49da80d761ab3d922d56` /
  `f99eb14639261d200375761e8a8c7ba44d680ed3`.
- Approval scope: Task 1 only, creating
  `packages/shared/ontology/rallar-ontology-contracts.ts`,
  `rallar-domain-ontology-contracts.ts`,
  `rallar-realtime-ontology-contracts.ts`,
  `rallar-ontology-registry.ts`, `packages/shared/ontology/mod.ts`, and
  `packages/tests/shared/rallar-ontology-registry.test.ts`.
- Locked behavior: additive opt-in metadata contracts/registry only; no import
  into runtime paths, no packet/payload/authority/routing/validation change, and
  no shared package barrel change.

#### RTC baseline acceptance set

Accept `RTC-B01` through `RTC-B06` from
[the RTC baseline plan](../docs/superpowers/plans/2026-08-06-rallar-rtc-performance-baseline-plan.md):

**Exact accepted RTC plan blob:**
`50614b299cfc9b1d85aafb1e32537e56f512ff3d`.

1. deterministic signaling/ICE/listener counters;
2. data-channel replacement, drain, close, and error lifecycle;
3. star/tree/mesh topology, RTT shape/current repository filtering, and
   inactive-state characterization;
4. multicast serialization and group/cache/heartbeat coordination;
5. raw native Chromium connection/data-channel lifecycle; and
6. local three-browser memory, receiver-observed phase timings, reconnect, and
   bounded 100-cycle Rallar retention indicators.

The fixed inputs, sample counts, correctness gates, environment fingerprints,
noise rules, artifact contract, and stop conditions in that plan are part of
the acceptance. `E4-pg` is allowed—and required before selecting such a
hotspot—only when the measured candidate call path includes database-backed
admission, topology persistence, AppInbox, outbox, or cluster transport. It
does not replace required `E3-memory`. Remote `RTC-B07` remains held and needs
separate explicit cost, fleet, commit, and artifact authorization before
dispatch.

#### Client-state ledger and selected human child

Client-state is `verified` here and `ledger-published` in the authoritative
human-program model, based on PR #75 and the exact successful gates in Section 4. The coordinator made no human-plan edit.

The selected next child is
`plans/rallar-auth-server-structure-plan.md` at exact blob
`123990bceac9732660e1113101addd5b194d8347`. Its planning envelope is verified:

- [PR #76](https://github.com/intact-software-systems/ar-eye-hunter/pull/76)
  feature `38a961c4ee184856422b3acf6f0494d04d8d6e5b`, frozen tree
  `aa82a21c85d7a6504aaa1a203aaabfe439d90af5`;
- Branch Release Gate
  [run 31103489838](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/31103489838),
  attempt 2, success. Its
  [attempt-1 evidence record](https://github.com/intact-software-systems/ar-eye-hunter/pull/76#issuecomment-5205255673)
  records failure in job `Release Gate / Release Gate`, step
  `Run root CI suite`, when unchanged
  `packages/tests/shared/ws-outbox-owner-miss-retry.test.ts:196` observed
  `FAILED` instead of expected `RETRY`; no content changed before attempt 2; and
- resulting `main` `61e708708f94328f095f1f1fa5690747bb933476`, tree
  `32fad7c720dcc1eb462f6b486ff64db4f687f67e`, with Run Hetzner Supported
  Distributed Manifests
  [31106485616](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/31106485616),
  attempt 1, success.

The exact
[external closure record](https://github.com/intact-software-systems/ar-eye-hunter/pull/76#issuecomment-5205571315),
created by repository account `intact-software-systems` at
`2026-08-06T13:53:26Z`, identifies blob
`123990bceac9732660e1113101addd5b194d8347` as approved, states it remains
byte-identical on resulting `main`, removes the former plan-approval blocker for
PR A, and keeps PR B, PR C, and the later ledger blocked. That removal does not
bypass Task 1 or PR A's sample, warning, and independent-review gates.

The entire auth child plan at exact blob
`123990bceac9732660e1113101addd5b194d8347` is already externally approved. When
separately activated, the first work is Task 1 characterization only. After Task
1's required human sample/warning approval and independent review, the first
implementation cohort is PR A mutation/login core. PR B and PR C remain inactive
behind their predecessor publication and human merge gates. The human-program
coordinator or assigned human-traceability track owner, not this roadmap
coordinator, activates and updates that child.

#### Approved initial write reservations — inactive

| Reservation                  | Approved owner role                                                  | Exact initial write set                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Serialization rule                                                                                                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ontology Task 1              | Ontology track owner                                                 | The six Task 1 paths listed above                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | No package barrel, public snapshot, runtime, generated artifact, or root-script edit.                                                                                                                  |
| RTC instrumentation/baseline | RTC performance owner                                                | RTC plan/progress; `scripts/perf/README.md`; `scripts/perf/{rtc-baseline-envelope,rtc-data-channel-drain-bench,rtc-rtt-repository-filter-bench}.ts`; measurement-only `scripts/perf/rtc-data-channel-browser-soak.mjs`; the 16 accepted existing harnesses enumerated exactly in baseline-plan Section 10; `packages/tests/repo/rtc-performance-baseline-contract.test.ts`; measurement-only `tests/playwright/rallar-black-box/full-stack-live-rtc-three-browser-matrix.spec.ts`; its two named existing coverage/script-gate tests; and ignored `tmp/perf/rtc-baseline/**` | No production RTC path or root script. Serialize full-stack/remote runs with auth work.                                                                                                                |
| Human auth Task 1            | Human-program coordinator or assigned human-traceability track owner | `plans/rallar-auth-server-structure-plan.md`, ignored `tmp/repo-human-traceability/auth/task-1-report.md`, RED semantic tests under `packages/tests/shared-server/auth/**`, and navigation/ownership tests matching `packages/tests/repo/auth-server-*.test.ts`; Task 1 produces the exact later PR-cohort assignment                                                                                                                                                                                                                                                        | No production auth move in Task 1. PR A activates only after its sample/warning/review gate; PR B/C stay inactive. Synthetic RTC may run in parallel; service-backed RTC waits for a stable auth tree. |

#### Human-program owner handoff (read only)

The earlier planning/status contradictions and PR #76 evidence were delivered
in the read-only
[PR #76 handoff](https://github.com/intact-software-systems/ar-eye-hunter/pull/76#issuecomment-5206866857).
The human-program owner subsequently published PR A, but the auth child merged
with Task 3 and its live progress table still predicting pending branch/default
publication. The exact PR A feature, branch-gate, merge, resulting tree, and
default-workflow evidence were therefore delivered in the later
[PR #78 closure handoff](https://github.com/intact-software-systems/ar-eye-hunter/pull/78#issuecomment-5215094789).
The owner must reconcile that authoritative progress under its own non-circular
protocol. The roadmap coordinator did not edit or advance the human master,
execution, or auth child plans; PR B/C remain inactive here.

#### Recorded human decisions and remaining condition

1. Phase 0 content and the exit decision are approved as proposed; this does not
   itself provide approval-record publication evidence or start Phase 1.
2. Ontology Task 1 only is approved against exact blob
   `9267a16a3fa3c547ba7db9ce4fd55f858f7d9e37`.
3. `RTC-B01` through `RTC-B06` and their measurement-only reservation are
   accepted against exact blob `50614b299cfc9b1d85aafb1e32537e56f512ff3d`.
4. Auth blob `123990bceac9732660e1113101addd5b194d8347` is selected; at the
   Phase 0 decision Task 1 was first and PR A/PR B/PR C were gated. Section 4
   records PR A's later verified publication while PR B/C remain held.
5. Conditional Postgres is permitted only under the measured-path rule above;
   remote `RTC-B07` remains held.
6. A separate operations owner is required before affected release claims;
   unrelated tracks remain unblocked.

No Phase 0 human decision remains open. The operations owner is intentionally
unassigned: assignment becomes a blocking condition only before an affected
release claim.

### Phase 0 exit gate

The human-approved decision gate is satisfied:

- [x] the coordination documents are reviewed and published;
- [x] existing publication envelopes are truthfully recorded;
- [x] the RTC baseline plan is approved;
- [x] ontology Task 1 is approved against an exact revision;
- [x] the next human child is either explicitly selected or intentionally left
      blocked; and
- [x] the Phase 1 write sets have no unresolved overlap.

Human approval and the exact PR #77/resulting-main evidence satisfy the Phase 0
exit gate. Phase 0 is closed. Section 5 records the later named Phase 1 owners,
active reservations, and serialized holds.

## 7. Phase 1 — Independent Foundations

### Track 1A: Ontology Task 1 foundation

Execute only Task 1 of the ontology plan on its named independent branch. Treat
the ontology as operationally inert metadata. Publish and verify Task 1 before
Tasks 2-5 branch from it.

**Entry:** exact plan approval, applicable publication evidence, a named owner,
and an explicitly active reservation.

**Exit:** Task 1 focused/full gates and exact branch/default publication evidence
are verified.

**Current state:** `blocked` at a human structural decision. The six-path,
`d68d511...`-based semantic prototype passed 47/47 focused tests and independent
semantic review, but cannot satisfy the exact changed-style gate without the
inactive 17-path amendment in Section 5. It is uncommitted and has no PR.
Current `main` advanced afterward, so renewed work must also reconcile
`a900423...` and rerun every invalidated gate. No Tasks 2-11 work is authorized.

### Track 1B: Human-traceability continuation

When separately activated, follow the existing human program's selected auth
child. The current master order places auth before group topology, RTC/RTT,
CRDT, and admin, but only the human-program owner may activate and advance that
child.

**Entry:** client-state `ledger-published`, human child approval, a named owner,
and an explicitly active reservation.

**Exit:** the approved interval reaches the state required by its own child
plan; the roadmap records only cross-program consequences.

**Current state:** PR A is externally `verified`: PR #78's final exact-head
Branch Release Gate passed, it merged as `a900423...`, and resulting-main run
31163606362 attempt 1 passed. The stable auth-tree prerequisite for later
RTC-B06 is satisfied. The merged human child still predicts pending Task 3
publication; its owner received the exact read-only closure handoff and must
reconcile it. This coordinator keeps the human plans read-only; PR B/C remain
inactive.

### Track 1C: RTC baseline execution

Run the approved baseline plan without production optimization. Capture exact
commit, runtime, environment, configuration, commands, workloads, samples,
noise, and limitations. Rank hotspots by measured user/system impact and
confidence, not file size or intuition.

**Entry:** approved RTC baseline plan, a named owner, and an explicitly active,
non-overlapping harness reservation.

**Exit:** reproducible baseline and one human-accepted candidate vertical slice.

**Current state:** `blocked` at a human structural decision. The 21-path,
`d68d511...`-based B01-B05 prototype reached independent semantic approval and
then passed its final 23/23 contract tests plus exact reserved-file checks after
the last local cleanup. Its earlier 33-file/475-test cohort is informative but
not current completion evidence. It remains uncommitted and has no PR. The
approved broad Deno gate and changed-style gate cannot pass honestly without
the inactive amendment in Section 5, and current-main drift requires
reconciliation and renewed evidence. The auth serialization prerequisite is
now satisfied, but `scripts/perf/README.md`, B06 implementation/exception,
RTC-B07, capture, production change, and optimization remain held.

### Phase 1 exit gate

- Ontology Task 1 is verified and published.
- RTC baselines are reproducible and one candidate is accepted or the evidence
  explicitly says no optimization is justified yet.
- The active human child has no unresolved write conflict with the proposed RTC
  slice.
- The coordinator records the Phase 2 ordering decision.

## 8. Phase 2 — Ontology Pilot And One Measured RTC Slice

The default interleave is:

1. publish ontology Task 2 (domain pilot) after Task 1;
2. allow ontology Task 5 (code standards) in parallel when its write set is
   independent;
3. publish ontology Tasks 3-4 in their prerequisite order;
4. continue the approved human child on non-overlapping paths;
5. characterize one measured RTC slice semantically and structurally;
6. if needed, land ontology clarification first;
7. if needed, land behavior-neutral readability movement second;
8. land the measured optimization separately with before/after evidence;
9. assemble ontology Task 6 artifacts only after Tasks 1-5 publish; and
10. run Task 7 and the human pilot gate before any optional Tasks 8-9.

When the measured RTC slice overlaps the human program's later RTC/RTT or
WebRTC/multicast children, use one of these explicit choices:

- advance the human child first, then rebaseline and optimize;
- optimize the current structure first, then refactor with the performance gate
  retained; or
- create one coordinated child plan with separate commits and gates for
  semantics, structure, and optimization.

The human chooses among them from measured risk. Agents must not infer the
choice from the fact that all work concerns RTC.

## 9. Required Track Handoff

Every track agent sends the coordinator:

- outcome and authoritative task/plan section;
- exact files changed and behavior impact;
- branch, final commit, and Git tree;
- focused and full local commands with pass/fail/skipped status;
- PR, Branch Release Gate, resulting default commit, and default workflow when
  they exist;
- RTC workload/result/artifact identity when applicable;
- unresolved warnings, compatibility risks, and path reservations;
- human decisions made or still required; and
- the smallest safe next action.

The coordinator rejects a handoff that predicts future evidence, omits the
tested tree, or combines semantic, structural, and performance outcomes so they
cannot be reviewed independently.

## 10. Live Program Progress

| Item                         | Owner                        | State                         | Evidence/blocker                                                                                                                                                                                                                                                                                        | Next action                                                                                                                                    |
| ---------------------------- | ---------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 0 publication          | Roadmap coordinator          | `verified`                    | PR #77 merged as `d68d511...`; resulting-main run 31122914721 attempt 4 succeeded.                                                                                                                                                                                                                      | Preserve the historical closure record while reconciling later `main` commits separately.                                                      |
| Phase 1 activation record    | Roadmap coordinator          | `published`, not merged       | Draft PR #79 head `ce621a8...`, tree `ec15fe1...`; Branch Release Gate 31158965238/job 92804701468 succeeded. The branch is now locally reconciled with auth-merged `main`; this blocker/decision update needs its own published exact-head evidence.                                                   | Publish the reconciled roadmap-only head and keep PR #79 draft.                                                                                |
| 1A Ontology Task 1           | `/root/ontology_task1_owner` | `blocked` at human decision   | The old-base semantic prototype is independently approved; exact style/structure and current-base gates are not satisfiable under the six-path plan. No commit/PR exists.                                                                                                                               | Decide the exact 17-path amendment; if approved, publish/approve its new plan blob, rebase, split test-first, and rerun every gate.            |
| 1B Human auth PR A           | Human-program owner          | externally `verified`         | PR #78 feature/tree and Branch Release Gate succeeded; merge `a900423...`, tree `9a3084c...`, resulting-main run 31163606362 attempt 1 succeeded. The merged auth progress record still predicts pending publication.                                                                                   | Human-program owner records exact closure. PR B/C remain inactive.                                                                             |
| 1C RTC baseline              | `/root/rtc_baseline_owner`   | `blocked` at human decision   | The old-base B01-B05 semantic prototype is independently approved; exact broad Deno/style and current-base gates are not satisfiable under the initial plan. No capture, commit, or PR exists. PR #40 owns README. Auth no longer blocks later B06, but its structural exception decision remains open. | Decide the exact RTC amendment; if approved, publish/approve its new plan blob, rebase, split test-first, and rerun every gate before capture. |
| Conditional operations owner | unassigned                   | not blocking unrelated tracks | Existing Deploy Web + API and Deno Deploy failures remain recorded.                                                                                                                                                                                                                                     | Assign before an affected release claim.                                                                                                       |

## 11. Immediate Next Actions

1. Publish this coordinator-only blocker/decision reconciliation on draft PR
   #79 and record its exact-head Branch Release Gate.
2. Obtain the human decision on the exact Ontology Task 1 amendment in Section 5. If approved, the ontology owner revises only its plan first, publishes the
   new blob, and obtains approval of that exact blob before source work resumes.
3. Obtain the human decision on the exact RTC amendment, two-anchor/rerun rule,
   diagnostic compatibility, and narrow B06 matrix exception in Section 5. If
   approved, the RTC owner revises only its plan first, publishes the new blob,
   and obtains approval of that exact blob before instrumentation resumes.
4. Require both tracks to reconcile current `main` `a900423...`; old-base
   prototype evidence is design/review input, not current publication evidence.
5. Keep PR B/C, README/PR #40, B06 implementation, RTC-B07, capture, production
   RTC changes, optimization, raw-artifact publication, and Phase 2 inactive
   until their named later gates are satisfied.
6. Require independent track reviews and exact local/branch/default evidence
   before any baseline or milestone is marked complete, then stop for human
   acceptance of the Phase 1 exit envelope before Phase 2.
