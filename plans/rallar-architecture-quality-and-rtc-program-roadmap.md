# Rallar Architecture Quality And RTC Program Roadmap

> **For agents:** This is the live cross-program coordination record. Use the
> concern-specific plan for implementation. Only the current roadmap coordinator
> edits this file. Track agents report evidence and update their own child plans.

**Started:** 2026-08-06

**Status:** Phase 0 active; roadmap locally drafted and awaiting human review

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

| State            | Meaning                                                                                             |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| `not-started`    | No authorized work is active.                                                                       |
| `ready`          | Prerequisites are verified and a concern-specific plan defines the work.                            |
| `in-progress`    | Authorized work is executing.                                                                       |
| `local-complete` | Scoped local work and required local checks passed, but publication evidence is incomplete.         |
| `published`      | The change is on the intended branch/default branch; required remote evidence may still be pending. |
| `verified`       | Exact required local, branch, merge, and default-branch evidence is recorded.                       |
| `blocked`        | A named prerequisite, conflict, or human decision prevents progress.                                |
| `deferred`       | The human explicitly removed the item from the current phase.                                       |

Only `verified` satisfies a cross-program publication gate. A plan's own state
model remains authoritative when it is more specific, such as the human
program's `ledger-published` state.

## 4. Reconciled Starting Point

**Local reconciliation:** 2026-08-06 at `main`
`254e8a05a962abb4f8df49da80d761ab3d922d56`.

| Program                    | State                                             | Current evidence                                                                                                                                                                                                                                                                                   | Next required action                                                                                                                                                         |
| -------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Human traceability         | `published`, external ledger verification pending | Client-state PRs #72-#74 are recorded complete. Ledger PR #75 is visible as resulting local/remote `main` commit `6b75cfc5ec61f81b465be9072b746d24ecdb5f22`; the authoritative plans intentionally still say `publication pending` because they cannot predict the ledger's own external envelope. | Verify PR #75 Branch Release Gate and the exact resulting-main default workflow. Then record whether the child is `ledger-published` before selecting the next Wave 2 child. |
| Ontology                   | plan `published`; implementation `not-started`    | The implementation plan is tracked on `main` at commit `254e8a05a962abb4f8df49da80d761ab3d922d56`. Tasks 1-7 define the pilot; Tasks 8-9 require a later human go/no-go.                                                                                                                           | Verify the plan commit's applicable default-branch workflow, bind human implementation approval to the exact plan blob/revision, then reserve Task 1 paths.                  |
| RTC performance            | `not-started`                                     | Existing focused harnesses and `scripts/perf/README.md` provide measurement building blocks; no RTC performance program plan exists yet.                                                                                                                                                           | Draft and approve the RTC performance baseline plan. Do not optimize production code.                                                                                        |
| Cross-program coordination | `in-progress`                                     | This design and roadmap are present in the working tree.                                                                                                                                                                                                                                           | Validate, review, and publish the two coordination documents without claiming unobserved future gates.                                                                       |

No human-traceability child after client-state is authorized by this table. No
ontology implementation task is authorized merely because its plan is
published.

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

| Reservation            | Owner               | State                      | Release condition                                                                             |
| ---------------------- | ------------------- | -------------------------- | --------------------------------------------------------------------------------------------- |
| Coordination documents | Roadmap coordinator | active                     | Coordination docs are published or handed off                                                 |
| Ontology Task 1 paths  | unassigned          | pending                    | Exact plan approval and applicable plan-publication evidence are recorded                     |
| RTC baseline-plan file | unassigned          | ready after roadmap review | Baseline-plan draft is handed back for human review                                           |
| Next human child       | unassigned          | blocked                    | Client-state ledger reaches verified `ledger-published` and the human approves the next child |

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
- [ ] Obtain human review of the roadmap content.
- [ ] Publish through the repository's required plan-document process and record
      the exact external evidence after it exists.

**State:** `in-progress`.

### Task 0B: Reconcile existing publication envelopes

**Owner:** Roadmap coordinator or a read-only evidence agent assigned by the
coordinator.

**Steps:**

- [ ] Verify ledger PR #75's feature commit/tree, Branch Release Gate, resulting
      `main` commit, and default-branch workflow.
- [ ] If all required evidence is green, record client-state as
      `ledger-published` in the appropriate coordination/evidence record.
- [ ] Verify the applicable default-branch workflow for ontology-plan commit
      `254e8a05a962abb4f8df49da80d761ab3d922d56`.
- [ ] Record failures as failures with exact run/job/step; do not diagnose or
      relabel them inside this task.

**State:** `in-progress`; local publish facts are known, remote envelopes are
not yet recorded here.

### Task 0C: Draft the RTC performance baseline plan

**Target file:**
`docs/superpowers/plans/2026-08-06-rallar-rtc-performance-baseline-plan.md`

**Required contents:**

- [ ] Inventory current RTC/realtime production paths and consumers before
      proposing changes.
- [ ] Inventory relevant existing harnesses under `scripts/perf/**` and state
      what each can and cannot prove.
- [ ] Define representative environments and fixed workloads for connection
      setup, signaling, data-channel queueing, topology/RTT, multicast, reconnect,
      and long-running retention/cleanup where applicable.
- [ ] Define correctness checks, warmup, sample count, noise handling, captured
      runtime/commit/configuration, and before/after comparison rules.
- [ ] Define hotspot selection criteria and stop conditions.
- [ ] Separate instrumentation, baseline capture, structural refactoring, and
      optimization into independently reviewable tasks.
- [ ] Keep generated profiles under `tmp/perf/` and define the small durable
      summary that may be reviewed or published.
- [ ] Map candidate production paths against active and planned human-readability
      children so overlapping write sets are serialized.

**State:** `not-started`. This task may proceed while Task 0B waits on remote
evidence because it is plan-only and has a separate write set.

### Task 0D: Approve the Phase 1 launch envelope

The human reviews one concise launch record containing:

- exact ontology plan revision and approval scope for Task 1 only;
- accepted RTC baseline workloads and environment limitations;
- verified client-state ledger status and, if unblocked, the proposed next human
  child;
- the first three write reservations; and
- any known shared-path serialization.

**State:** `blocked` on Tasks 0A-0C and required human decisions.

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

**Current state:** `blocked` on Phase 0D.

### Track 1B: Human-traceability continuation

Once client-state is externally `ledger-published`, follow the existing human
program to evaluate and approve exactly one next child. The current master order
places auth before group topology, RTC/RTT, CRDT, and admin, but only the human
program's approval authorizes that child.

**Entry:** client-state `ledger-published` and human child approval.

**Exit:** the approved interval reaches the state required by its own child
plan; the roadmap records only cross-program consequences.

**Current state:** `blocked` on Task 0B and human selection.

### Track 1C: RTC baseline execution

Run the approved baseline plan without production optimization. Capture exact
commit, runtime, environment, configuration, commands, workloads, samples,
noise, and limitations. Rank hotspots by measured user/system impact and
confidence, not file size or intuition.

**Entry:** approved RTC baseline plan and non-overlapping harness reservation.

**Exit:** reproducible baseline and one human-accepted candidate vertical slice.

**Current state:** `blocked` on Task 0C approval.

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

| Item                      | Owner                     | State         | Evidence/blocker                                                                | Next action                                                    |
| ------------------------- | ------------------------- | ------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 0A coordination design    | Roadmap coordinator       | `in-progress` | Draft exists in working tree                                                    | Validate and present for human review                          |
| 0A live roadmap           | Roadmap coordinator       | `in-progress` | Draft exists in working tree                                                    | Validate and present for human review                          |
| 0B client ledger envelope | Roadmap coordinator       | `in-progress` | PR #75 merge commit visible; remote run evidence not recorded                   | Verify exact branch/default workflows                          |
| 0B ontology plan envelope | Roadmap coordinator       | `in-progress` | Plan commit visible at current `main`; applicable default workflow not recorded | Verify exact workflow and bind approval revision               |
| 0C RTC baseline plan      | Unassigned                | `not-started` | Existing harnesses available                                                    | Assign after roadmap review; use performance-analysis workflow |
| 0D Phase 1 launch         | Human owner + coordinator | `blocked`     | Needs validated Phase 0 records                                                 | Review the launch envelope                                     |

## 11. Immediate Next Actions

1. Validate these two coordination documents.
2. Have the human review their ownership, phases, and Phase 0 scope.
3. Assign one evidence reconciliation task and one independent RTC baseline-plan
   task; they may run in parallel.
4. Update this roadmap once with verified results.
5. Present the exact ontology Task 1 approval envelope and Phase 1 reservations
   to the human.

Do not start ontology source implementation or production RTC optimization from
this roadmap alone.
