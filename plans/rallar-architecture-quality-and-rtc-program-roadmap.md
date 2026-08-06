# Rallar Architecture Quality And RTC Program Roadmap

> **For agents:** This is the live cross-program coordination record. Use the
> concern-specific plan for implementation. Only the current roadmap coordinator
> edits this file. Track agents report evidence and update their own child plans.

**Started:** 2026-08-06

**Status:** Phase 0 evidence-reconciled; Phase 1 launch envelope awaiting human
approval

**Human owner:** Product/technical owner

**Current roadmap coordinator:** The active primary agent for this roadmap task

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

**Local reconciliation:** 2026-08-06 on
`codex/phase-0-architecture-rtc-roadmap`, based on current `origin/main`
`61e708708f94328f095f1f1fa5690747bb933476` (tree
`32fad7c720dcc1eb462f6b486ff64db4f687f67e`).

| Program                    | State                                                                                  | Current evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Next required action                                                                                                                                                |
| -------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Human traceability         | client state `verified` / `ledger-published`; auth child externally approved and ready | Ledger [PR #75](https://github.com/intact-software-systems/ar-eye-hunter/pull/75) merged feature `2858bf0c2a9b882a82ae4c33abf58d6e0408be8d` at frozen tree `104478f66bcabbbcf101ea97a80d2a2060cb10ec`; Branch Release Gate [run 31097790516](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/31097790516), attempt 2, succeeded. Resulting `main` `6b75cfc5ec61f81b465be9072b746d24ecdb5f22` has the same tree; Run Hetzner Supported Distributed Manifests [31100952224](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/31100952224), attempt 1, succeeded. PR #76's [external closure record](https://github.com/intact-software-systems/ar-eye-hunter/pull/76#issuecomment-5205571315) identifies approved auth-plan blob `123990bceac9732660e1113101addd5b194d8347` and releases PR A while PR B/C remain blocked. | Human-program owner reconciles its intentionally non-circular local plans. This coordinator holds Task 1/PR A until the cross-program Phase 1 envelope is approved. |
| Ontology                   | plan `verified`; implementation `not-started`                                          | Plan commit `254e8a05a962abb4f8df49da80d761ab3d922d56`, tree `f99eb14639261d200375761e8a8c7ba44d680ed3`, and unchanged plan blob `9267a16a3fa3c547ba7db9ce4fd55f858f7d9e37` are on `main`. Run Hetzner Supported Distributed Manifests [31103071755](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/31103071755), attempt 1, succeeded. No PR was discovered; publication does not itself authorize implementation.                                                                                                                                                                                                                                                                                                                                                                                                                          | Human approves or rejects Task 1 only against exact blob `9267a16a3fa3c547ba7db9ce4fd55f858f7d9e37`, then the coordinator activates its reservation.                |
| RTC performance            | plan `human-review`; execution `not-started`                                           | [RTC performance baseline plan](../docs/superpowers/plans/2026-08-06-rallar-rtc-performance-baseline-plan.md), proposed exact blob `50614b299cfc9b1d85aafb1e32537e56f512ff3d`, inventories production paths and harness limits and defines fixed workloads, environments, gates, reproducibility, artifacts, hypotheses, hotspot selection, and overlap rules. No benchmark was executed and no production path changed.                                                                                                                                                                                                                                                                                                                                                                                                                                            | Human accepts or revises `RTC-B01` through `RTC-B06` against that exact blob; `RTC-B07` remains a separate remote-run decision.                                     |
| Cross-program coordination | published draft; reconciliation `in-progress`                                          | The original design and roadmap were published directly on `main` at `92f3f4f3fb6ea0bbadbf006cd3483e618726f001`, tree `0e99e4bb796a03249bba4ea5c384c6fd3228ec2e`; Run Hetzner Supported Distributed Manifests [31106191379](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/31106191379), attempt 1, succeeded. No PR was discovered and human review is not evidenced.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Review this reconciliation and launch envelope; publish the Phase 0 update without predicting its own external evidence.                                            |

The auth child is already approved by its external closure record, but this
Phase 0 coordinator does not start or advance it. No ontology implementation
task is authorized merely because its plan is published.

## 5. Work Routing And Reservations

### Default path ownership

| Track                     | Independent write set                                                                                   | Must coordinate before touching                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Coordination              | This design and this roadmap                                                                            | Any concern-specific implementation plan                                                    |
| Human traceability        | Paths named by its one active approved child                                                            | Ontology sources/bindings, RTC benchmark scripts, or another human child                    |
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

| Reservation            | Owner                                                                | State                    | Release condition                                                                                                                                                                        |
| ---------------------- | -------------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Coordination documents | Roadmap coordinator                                                  | active                   | Phase 0 update is published or handed off                                                                                                                                                |
| Ontology Task 1 paths  | unassigned                                                           | pending                  | Human approves Task 1 against exact plan blob `9267a16a3fa3c547ba7db9ce4fd55f858f7d9e37`                                                                                                 |
| RTC Phase 1 baseline   | unassigned                                                           | pending                  | Human accepts exact plan blob `50614b299cfc9b1d85aafb1e32537e56f512ff3d` and the initial measurement reservation                                                                         |
| Next human child       | Human-program coordinator or assigned human-traceability track owner | ready, held for Phase 0D | External closure approved auth plan blob `123990bceac9732660e1113101addd5b194d8347`; cross-program launch approval records the reservation, and this coordinator does not edit its plans |

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
- [ ] Obtain human review of the roadmap content.
- [ ] Publish this Phase 0 reconciliation through the repository's plan-document
      process and record its external evidence outside the candidate itself.

**State:** `in-progress`.

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

**State:** `human-review`. The plan is drafted and no baseline, production
change, or optimization has started.

### Task 0D: Approve the Phase 1 launch envelope

The human reviews one concise launch record containing:

- exact ontology plan revision and approval scope for Task 1 only;
- accepted RTC baseline workloads and environment limitations;
- verified client-state ledger status and, if unblocked, the proposed next human
  child;
- the first three write reservations; and
- any known shared-path serialization.

**State:** `human-review`. Tasks 0B-0C are reconciled; Task 0A human review and
the decisions in the launch envelope remain open.

### Phase 1 launch envelope for human approval

Approval applies only to the exact items below. It starts no work by itself;
the coordinator records each approved cross-program reservation, while the
assigned concern-specific track owner activates and updates its own work.

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

**Exact proposed RTC plan blob:**
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
the acceptance. Postgres is conditional when the candidate call path uses
database-backed admission/topology/persistence. Remote `RTC-B07` is not accepted
by this envelope and needs a separate cost/fleet/artifact decision.

#### Client-state ledger and proposed human child

Client-state is `verified` here and `ledger-published` in the authoritative
human-program model, based on PR #75 and the exact successful gates in Section 4. The coordinator made no human-plan edit.

The proposed next child is
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
byte-identical on resulting `main`, releases PR A, and keeps PR B, PR C, and the
later ledger blocked.

The entire auth child plan at exact blob
`123990bceac9732660e1113101addd5b194d8347` is already externally approved.
Initial activation is Task 1 characterization only. After Task 1's required
human sample/warning approval and independent review, the first implementation
cohort is PR A mutation/login core. PR B and PR C remain inactive behind their
predecessor publication and human merge gates. The human-program coordinator or
assigned human-traceability track owner, not this roadmap coordinator, activates
and updates that child.

#### Initial write reservations after approval

| Reservation                  | Proposed owner                                                       | Exact initial write set                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Serialization rule                                                                                                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ontology Task 1              | Ontology track owner                                                 | The six Task 1 paths listed above                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | No package barrel, public snapshot, runtime, generated artifact, or root-script edit.                                                                                                                  |
| RTC instrumentation/baseline | RTC performance owner                                                | RTC plan/progress; `scripts/perf/README.md`; `scripts/perf/{rtc-baseline-envelope,rtc-data-channel-drain-bench,rtc-rtt-repository-filter-bench}.ts`; measurement-only `scripts/perf/rtc-data-channel-browser-soak.mjs`; the 16 accepted existing harnesses enumerated exactly in baseline-plan Section 10; `packages/tests/repo/rtc-performance-baseline-contract.test.ts`; measurement-only `tests/playwright/rallar-black-box/full-stack-live-rtc-three-browser-matrix.spec.ts`; its two named existing coverage/script-gate tests; and ignored `tmp/perf/rtc-baseline/**` | No production RTC path or root script. Serialize full-stack/remote runs with auth work.                                                                                                                |
| Human auth Task 1            | Human-program coordinator or assigned human-traceability track owner | `plans/rallar-auth-server-structure-plan.md`, ignored `tmp/repo-human-traceability/auth/task-1-report.md`, RED semantic tests under `packages/tests/shared-server/auth/**`, and navigation/ownership tests matching `packages/tests/repo/auth-server-*.test.ts`; Task 1 produces the exact later PR-cohort assignment                                                                                                                                                                                                                                                        | No production auth move in Task 1. PR A activates only after its sample/warning/review gate; PR B/C stay inactive. Synthetic RTC may run in parallel; service-backed RTC waits for a stable auth tree. |

#### Human-program owner handoff (read only)

The master human-refactoring plan's early status header still says client-state
ledger publication is pending, while its later authoritative progress records
correctly say `ledger-published`. Its auth records also remain
drafted/unapproved despite PR #76's external approved-blob closure. The
human-program owner must reconcile both internal contradictions and record the
verified PR #76 planning envelope under its own non-circular protocol. The
roadmap coordinator will not edit or advance either human master/execution plan
or the auth child.

#### Unresolved human decisions

1. Approve this reconciled roadmap content and Phase 0 exit, or request a named
   revision.
2. Approve ontology Task 1 only against blob
   `9267a16a3fa3c547ba7db9ce4fd55f858f7d9e37`, or leave it blocked.
3. Accept RTC workloads `RTC-B01` through `RTC-B06` and their initial
   measurement reservation against exact RTC plan blob
   `50614b299cfc9b1d85aafb1e32537e56f512ff3d`, or name exact changes.
4. Confirm the already approved auth child at blob
   `123990bceac9732660e1113101addd5b194d8347` as the selected human track for
   this cross-program launch, select a different child, or intentionally hold
   the track. If selected, Task 1 activates first; PR A follows its own
   sample/warning/review gate and PR B/C remain inactive.
5. Decide separately whether Phase 1 may use Postgres when conditionally
   required and/or run remote `RTC-B07` on Hetzner.
6. Decide whether the recorded Deploy Web + API and Deno Deploy failures need a
   separate operations owner before any affected release claim.

### Phase 0 exit gate

Phase 0 exits when:

- the coordination documents are reviewed and published;
- existing publication envelopes are truthfully recorded;
- the RTC baseline plan is approved;
- ontology Task 1 is approved against an exact revision;
- the next human child is either explicitly selected or intentionally left
  blocked; and
- the Phase 1 write sets have no unresolved overlap.

Phase 1 may start per track as soon as that track's Phase 0 prerequisites are
met; it need not wait for unrelated external evidence.

## 7. Phase 1 — Independent Foundations

### Track 1A: Ontology Task 1 foundation

Execute only Task 1 of the ontology plan on its named independent branch. Treat
the ontology as operationally inert metadata. Publish and verify Task 1 before
Tasks 2-5 branch from it.

**Entry:** exact plan approval, reservation, and applicable publication evidence.

**Exit:** Task 1 focused/full gates and exact branch/default publication evidence
are verified.

**Current state:** `human-review` in Phase 0D; no source work authorized.

### Track 1B: Human-traceability continuation

Once client-state is externally `ledger-published`, follow the existing human
program to evaluate and approve exactly one next child. The current master order
places auth before group topology, RTC/RTT, CRDT, and admin, but only the human
program's approval authorizes that child.

**Entry:** client-state `ledger-published` and human child approval.

**Exit:** the approved interval reaches the state required by its own child
plan; the roadmap records only cross-program consequences.

**Current state:** auth plan externally approved and `ready`, but held by this
Phase 0 task until the cross-program launch envelope is approved. No human plan
or source work is started here.

### Track 1C: RTC baseline execution

Run the approved baseline plan without production optimization. Capture exact
commit, runtime, environment, configuration, commands, workloads, samples,
noise, and limitations. Rank hotspots by measured user/system impact and
confidence, not file size or intuition.

**Entry:** approved RTC baseline plan and non-overlapping harness reservation.

**Exit:** reproducible baseline and one human-accepted candidate vertical slice.

**Current state:** plan drafted; `human-review` in Phase 0D. No instrumentation,
baseline capture, or optimization is authorized yet.

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

## 10. Live Phase 0 Progress

| Item                      | Owner                     | State          | Evidence/blocker                                                                                                                      | Next action                                      |
| ------------------------- | ------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 0A coordination design    | Roadmap coordinator       | `published`    | Original draft at `92f3f4f3...`; named default workflow `31106191379` succeeded; human review not evidenced                           | Human reviews the reconciled content             |
| 0A live roadmap           | Roadmap coordinator       | `in-progress`  | Reconciliation prepared on `codex/phase-0-architecture-rtc-roadmap`; candidate publication evidence must remain external/non-circular | Publish draft update and preserve exact evidence |
| 0B client ledger envelope | Roadmap coordinator       | `verified`     | PR #75, Branch Release Gate `31097790516` attempt 2, resulting main `6b75cfc5...`, default run `31100952224` success                  | None; preserve ancillary failures                |
| 0B ontology plan envelope | Roadmap coordinator       | `verified`     | Commit `254e8a05...`, plan blob `9267a16a...`, default run `31103071755` success; implementation remains unauthorized                 | Human decides exact Task 1 approval              |
| 0C RTC baseline plan      | RTC planning agent        | `human-review` | Fixed plan drafted; no benchmark or production change executed                                                                        | Human accepts or revises `RTC-B01`-`RTC-B06`     |
| 0D Phase 1 launch         | Human owner + coordinator | `human-review` | Exact ontology, RTC, ledger, auth-child, reservation, overlap, and unresolved-decision envelope is above                              | Human approves or revises the envelope           |

## 11. Immediate Next Actions

1. Publish the two-file Phase 0 candidate on its non-default branch and retain
   the exact Branch Release Gate/PR evidence outside the candidate.
2. Send the read-only human-plan discrepancy and PR #76 planning envelope to
   the human-program owner; do not edit its plans.
3. Have the human approve or revise the Phase 1 launch envelope above.
4. If approved, activate only the selected reservations and track owners.
5. Stop before any Phase 1 implementation, instrumentation, baseline capture,
   ontology work, human refactor, or RTC optimization.

Do not start ontology source implementation or production RTC optimization from
this roadmap alone.
