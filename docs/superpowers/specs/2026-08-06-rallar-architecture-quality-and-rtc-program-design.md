# Rallar Architecture Quality And RTC Program Design

**Date:** 2026-08-06

**Status:** Draft for human review

**Decision owner:** Product/technical owner

**Coordination record:**
[Rallar architecture quality and RTC program roadmap](../../../plans/rallar-architecture-quality-and-rtc-program-roadmap.md)

## Purpose

Rallar has three necessary programs that must make progress without becoming one
large, coupled rewrite:

1. the existing human-traceability refactoring program;
2. the ontology implementation program; and
3. a measured RTC performance program that still needs its own implementation
   plan.

The programs solve different problems:

- human traceability makes ownership, dataflow, decisions, failures, and call
  paths easier to follow;
- ontology records stable product and protocol meaning in a machine-checkable
  form; and
- RTC performance work measures and improves runtime behavior under
  representative load.

This design coordinates their order and shared boundaries. It does not replace
any of their authoritative plans and does not authorize production changes.

## Design Decision

Keep the three programs independently executable. Add one lightweight roadmap
that owns only:

- current cross-program state;
- sequencing and phase gates;
- shared-path reservations;
- cross-program decisions and blockers; and
- links to verified evidence.

The roadmap must not duplicate child-plan task detail, become a fourth backlog,
or let one program silently change another program's success criteria.

## Sources Of Truth

| Concern                    | Authoritative document                                                                    | What it owns                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Cross-program coordination | `plans/rallar-architecture-quality-and-rtc-program-roadmap.md`                            | Phase, ordering, path conflicts, handoffs, decisions, and verified milestone links                   |
| Human readability          | `plans/repo-human-traceability-refactoring-program-plan.md` and its execution/child plans | Refactoring scope, human-navigation outcomes, compatibility constraints, and publication evidence    |
| Ontology                   | `docs/superpowers/plans/2026-08-05-rallar-ontologies-implementation-plan.md`              | Ontology model, competency questions, implementation tasks, pilot gate, and governance               |
| RTC performance            | The Phase 0 RTC baseline plan                                                             | Workload, measurements, profiling method, thresholds, optimization experiments, and regression gates |
| Architecture rationale     | This design                                                                               | Stable coordination model and responsibility boundaries                                              |
| Real completion evidence   | Git, CI, remote workflows, and accepted performance artifacts                             | Facts that a commit, gate, or measurement actually exists and passed                                 |

When documents disagree, the concern-specific plan wins for its own scope. The
roadmap may expose the disagreement and block a phase transition, but it may not
rewrite the concern-specific decision indirectly.

## Roles And Update Ownership

### Human product and technical owner

The human owner:

- approves or revises semantic scope and architecture decisions;
- approves phase transitions and optional ontology expansion;
- chooses business-priority overrides;
- approves compatibility, authority, wire-protocol, and behavior changes; and
- decides whether measured performance tradeoffs are acceptable.

### Roadmap coordinator

At any time, exactly one primary/coordinating agent is the roadmap writer. The
coordinator:

- reads the current roadmap, relevant child plans, Git state, and available
  external evidence before changing status;
- assigns or records path reservations;
- verifies worker handoffs;
- updates cross-program state only after a milestone or decision changes; and
- reports ambiguity instead of inventing missing evidence.

The active primary agent for the coordination task is the default coordinator.
A later primary agent may take over after reconciling the current repository and
recording the handoff in the roadmap. Subagents and track agents do not edit the
roadmap unless the human explicitly assigns one of them as coordinator.

### Track agents

Human-traceability, ontology, and RTC agents work from their own plans. They:

- update only their authoritative child plan or evidence record when that plan
  requires it;
- stay inside their reserved paths;
- hand off the exact branch, commit, tree, changed files, validations, remote
  gates, measurements, blockers, and human decisions; and
- request coordination before touching a path owned by another active track.

They do not mark roadmap milestones complete themselves.

## Update Protocol

The coordinator updates the roadmap only on one of these events:

1. a phase starts or exits;
2. a plan or child plan is approved;
3. a track reaches a published milestone with its required remote evidence;
4. an RTC baseline or before/after comparison is accepted;
5. a blocker or shared-path reservation changes; or
6. the human records a go/no-go or scope decision.

Routine commits, test reruns, agent commentary, and speculative future evidence
do not belong in the roadmap.

Each realized milestone needs non-circular evidence. A feature change cannot
claim its own future merge or default-branch workflow. The coordinator records
those facts only after the external result exists, preferably in a separate
coordination-only update.

## Change Routing

| Proposed change                                                                                     | Owning program              | Coordination rule                                                                                                                                                |
| --------------------------------------------------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Move/split/rename code for clearer ownership and call paths                                         | Human traceability          | Preserve behavior; update ontology contractual bindings in the same publishable unit or an immediately preceding binding unit when paths are already contractual |
| Add or change product/protocol meaning, authority, or vocabulary                                    | Ontology                    | Land the semantic decision before dependent code or performance work                                                                                             |
| Add measurement harnesses or capture baselines                                                      | RTC performance             | Keep generated profiles under `tmp/perf/`; do not change production behavior                                                                                     |
| Optimize a measured RTC hotspot                                                                     | RTC performance             | Use a separate change from readability movement and prove correctness plus before/after results                                                                  |
| Change payload, validation timing, sender meaning, correlation, fallback, routing, or wire behavior | Separate compatibility work | Stop for explicit human approval; ontology and performance plans do not authorize it                                                                             |
| Fix ontology implementation/example drift                                                           | Ontology maintenance        | Keep narrow; do not refactor the implementation opportunistically                                                                                                |

## Concurrency Model

Work may proceed concurrently when all of the following are true:

- the tasks have independent acceptance criteria;
- their write sets do not overlap;
- neither task depends on an unpublished semantic or compatibility decision from
  the other; and
- each task can be tested and rolled back independently.

Serialize work on shared integration points, including:

- `packages/shared/ontology/mod.ts`;
- generated ontology artifacts and their aggregate tests;
- package barrels and public export snapshots;
- root scripts or dependency metadata; and
- any production RTC source currently owned by an active readability child.

Do not solve merge pressure with a permanent combined branch. Rebase a narrow
track after its prerequisite publishes, then rerun its required gates.

## Program Phases

### Phase 0: Establish control and measurements

- publish this design and the live roadmap;
- reconcile the current human-program evidence ledger;
- record the published ontology plan and its external validation state;
- write the RTC performance baseline plan from existing harnesses; and
- reserve the first independent write sets.

Phase 0 changes coordination, plans, and measurement design. It does not
optimize production RTC code or implement ontology runtime behavior.

### Phase 1: Build foundations independently

- implement ontology Task 1 as a bounded foundation track;
- continue the next approved human-traceability child after the preceding ledger
  is externally verified;
- run approved RTC baselines and capture reproducible evidence; and
- keep all three tracks behavior-neutral.

### Phase 2: Pilot and improve one measured slice

- run ontology pilot Tasks 2-7 in their prerequisite order;
- continue human-traceability children that do not overlap the active RTC slice;
- select one measured RTC hotspot; and
- perform semantic clarification, structural refactoring, and optimization as
  separate reviewable units when all three are needed.

### Later phases

Ontology Tasks 8-9 require their explicit human pilot go/no-go. Broader RTC
optimization requires evidence from the baseline plan. The human-traceability
program continues by its existing wave order. The roadmap selects compatible
windows; it does not collapse those rules.

## Phase Gates

A phase may advance only when:

- each prerequisite source of truth is published and current;
- required local and remote evidence exists for exact commits;
- open shared-path conflicts have an owner and resolution;
- the human has made every required semantic or compatibility decision; and
- no track relies on generated or measured evidence from an older tree.

An agent may continue safe work in another independent track while one gate is
pending. A pending remote workflow is a status, not permission to predict its
result.

## Failure And Recovery

- If a track changes behavior outside its authorization, stop and revert or
  isolate that track; do not broaden the roadmap retroactively.
- If a baseline is noisy or irreproducible, fix the measurement protocol before
  optimizing.
- If an ontology term conflicts with actual authority, resolve the product
  meaning with the human before binding more code.
- If a readability refactor reveals a hotspot, record it as an RTC candidate;
  do not optimize it inside the refactor.
- If active agents collide on a path, the roadmap coordinator suspends one
  write set and preserves the smaller independently publishable change.

## Success Criteria

This coordination design succeeds when agents can answer, without reconstructing
history from chat:

- what each program is doing now;
- which plan authorizes it;
- who owns the next update;
- which paths are reserved;
- which evidence proves the current state;
- what blocks the next phase; and
- which human decision is needed next.
