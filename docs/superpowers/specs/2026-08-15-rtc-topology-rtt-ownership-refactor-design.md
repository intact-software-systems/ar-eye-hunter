# RTC Topology And RTT Ownership Refactor Design

## Purpose

Make the authoritative RTC RTT server flow easy to locate, understand, test, and change without
altering its observable behavior. One incoming RTT measurement should have one direct owner-to-result
path from WebSocket receipt, through durable AppInbox authorization and mutation, to persisted state
and topology-recomputation intent.

This refactor follows the repository's human-traceability program after PR #213. PR #213 is accepted
as terminal under current PR-centered governance; this work creates no plan receipt, active-plan
record, shared progress file, or post-merge governance artifact.

## Current problem

The authoritative flow is split across unrelated-looking locations:

- the WebSocket entry is under `rallar-system/topology/rtt`;
- durable authorization and dispatch are under `rallar-system/rtc-topology/inbox`;
- mutation read, compute, validate, write, result, and acceptance policy live under
  `rallar-system/services`;
- the repository is a 1,244-line file under `rallar-system/repositories`;
- persistence validation and identifiers are root-level `rallar-system` files; and
- tests are distributed across broad shared-server suites and historical path-oriented modules.

The runtime path works, but following one operation requires several vocabulary and folder hops. The
largest owners also mix distinct responsibilities that can be separated without changing the
protocol, transaction, or persistence contract.

## Approaches considered

### 1. Feature-root consolidation in bounded slices — selected

Move one complete responsibility at a time into the existing canonical
`rallar-system/rtc-topology` feature root. Update repository-internal imports in the same slice and
retain a compatibility re-export only when a real public or external consumer requires it.

This approach gives reviewers behavior-complete slices, keeps the owner-to-result path visible, and
allows focused tests to prove every move.

### 2. Add a new facade while leaving implementations in place

This would reduce import churn initially, but it would add another semantic hop while preserving the
scattered ownership underneath. It conflicts with the goal of minimum cognitive indirection.

### 3. Move every RTC topology, RTT, graph, replay, and publication file at once

This would produce a superficially complete tree quickly, but it would mix RTT ingestion,
group-topology planning, durable replay, graph calculation, and compatibility decisions in one large
change. Review and regression isolation would be poor, and current repository guidance deliberately
keeps group-topology replay under `topology/replay`.

## Selected ownership model

`packages/shared-server/rallar-system/rtc-topology` becomes the canonical owner of authoritative RTT
measurement ingestion and persistence:

```text
rtc-topology/
  README.md
  topic/          WebSocket RTT entry and acceptance handoff
  inbox/          Durable command construction, authority, and AppInbox dispatch
  mutation/       Read, compute, validate, write, receipt, and result decisions
  policy/         RTT acceptance and expired-authority decisions
  persistence/    Repository contracts, storage, codecs, keys, validation, migration, and cleanup
```

The exact final filenames follow the responsibilities recovered from current code; the refactor does
not create empty folders or vocabulary-only wrappers.

The following ownership remains unchanged unless later evidence proves a concrete conflict:

- `rallar-system/topology` owns group-topology configuration, planning, publication, and durable
  replay;
- `packages/shared-graph` owns graph algorithms and Vivaldi calculations;
- AppInbox owns durable queue infrastructure, not RTC RTT decisions;
- API-v1 owns process composition and configuration; and
- browser/shared RTC code owns measurement production and transport behavior.

The broad `rallar-rtc-topology-service.ts` is not moved mechanically. After the first two slices,
its responsibilities are classified between RTC measurement policy, group-topology planning, graph
calculation, and composition. Only responsibilities with a truthful RTC-topology owner move; the
rest stay with or move to their actual owner in a separately reviewed later slice.

## Concrete execution horizon

### Slice 1: RTT ingress and mutation ownership

1. Characterize the current WebSocket-to-AppInbox-to-mutation behavior with semantic tests.
2. Move the RTT topic entry into the RTC-topology feature.
3. Consolidate mutation contracts and the read, compute, validate, write, receipt, result, and
   measurement-policy decisions beside the existing inbox handler.
4. Update internal consumers directly and retain no pass-through compatibility module unless an
   actual public or external consumer is proven.
5. Add a navigation README and mirror focused tests by behavior.

Acceptance for this slice is unchanged command decoding, authority verification, idempotent replay,
mutation outcomes, receipt identity, transaction timing, after-commit effects, and failure behavior.

### Slice 2: RTT persistence ownership

1. Characterize repository behavior and live concurrency boundaries before movement.
2. Move repository contracts, runtime namespaces, storage keys, codecs, exact reads, mutation
   writes, cleanup, migration, and persisted-shape validation into `rtc-topology/persistence`.
3. Split the current repository only at real read, write, migration, cleanup, or codec boundaries;
   do not create one-file folders or forwarding layers.
4. Mirror persistence tests and update internal consumers.
5. Re-run repository navigation and structure checks before selecting another slice.

Acceptance for this slice is byte-compatible persisted data, unchanged canonical keys, unchanged
transaction and optimistic-concurrency behavior, unchanged retention and cleanup, and unchanged
migration semantics.

Later work remains outcome-shaped until both slices are complete and reviewed. In particular, this
design does not pre-authorize moving durable topology replay, changing graph algorithms, or
rewriting the broad topology service.

## Behavior-preservation contract

The refactor must preserve:

- WebSocket topic and payload contracts;
- AppInbox type, durable authority, command hashes, and constant-time proof checks;
- issued-session authorization and expiry behavior;
- read/compute/validate/write ordering;
- idempotent receipt and replay behavior;
- transaction, retry, rollback, and optimistic-concurrency semantics;
- storage keys, runtime namespaces, codecs, persisted shapes, and migrations;
- outbox and topology-recomputation intent;
- optional metrics remaining non-authoritative and never-throw; and
- existing package and application behavior.

No protocol, API, database schema, topology algorithm, RTT acceptance policy, distributed recipe,
or performance threshold changes as part of an ownership move.

## Bug protocol

An actual bug is an independently observable correctness, safety, authorization, persistence,
concurrency, or lifecycle violation—not merely an awkward name or folder.

When a bug is found in the affected flow:

1. stop the structural move at that boundary;
2. add a semantic regression test that fails against the current behavior;
3. fix the bug at its current canonical owner before or as part of the ownership move;
4. verify the red/green cycle and all affected boundaries; and
5. record the behavior change separately in the local handoff and eventual PR.

If a safe fix requires a public compatibility, migration, product-policy, or security decision, stop
for that decision rather than disguising it as refactoring.

## Weakness and issue protocol

Every evidence-backed weakness found while reviewing a touched flow is handled visibly. This
includes excessive cognitive load, unclear failure ownership, obsolete compatibility, unbounded
work, unnecessary repeated reads, avoidable allocations or graph rebuilds, missing cancellation,
contention, weak observability, and other performance risks.

For each weakness that is real but not required to complete the behavior-preserving refactor:

1. search open and closed GitHub issues for an existing owner;
2. reuse and update the matching issue when one exists;
3. otherwise create one focused issue with the observed evidence, affected owner, impact, why it is
   outside the current slice, safe next step, and acceptance criteria; and
4. link every reused or created issue in the handoff.

Speculation alone does not justify an issue. Conversely, passing tests do not justify silently
ignoring an observed structural, correctness, operational, or performance weakness.

## Touched-file standards closure

- Every changed human-authored file is reviewed and remediated in full.
- Every support file modified by that remediation enters the same closure recursively until the
  closure is complete.
- Independent untouched code remains outside the closure.

Pre-existing standards weaknesses inside a touched file are corrected while preserving the selected
behavior. Scope growth from that recursive closure is reflected in the working plan rather than
silently deferred.

## Validation design

Before the first edit, establish a clean baseline with:

- direct semantic RTC RTT routing and mutation tests;
- persistence and repository behavior tests;
- the shared-server TypeScript typecheck; and
- current repository-structure checks.

After each slice, run the focused tests for every moved decision and consumer. The final local
validation includes:

- RTC RTT AppInbox routing, authorization, read/compute/validate/write, and result tests;
- runtime-state repository, migration, cleanup, and key-shape tests;
- PostgreSQL RTT concurrency tests when persistence ownership changes;
- affected topology scheduling and WebSocket routing tests;
- `@ar-eye-hunter/shared-server` typecheck;
- repository structure and changed-file style checks; and
- formatting and `git diff --check`.

No product build, distributed recipe, black-box topology replay, or performance benchmark is added
merely because files moved. A bug fix or unexpected behavior change selects additional validation
according to the affected boundary and current testing guidance.

## Delivery and review

Work stays on `codex/rtc-topology-rtt-structure` in the dedicated worktree. The design and eventual
implementation are kept local for review until publication is explicitly requested. If later
published, one normal PR owns the semantic goal, changes, acceptance, validation, risk, and linked
follow-up issues; no plan bookkeeping or closure receipt is created.

## Acceptance criteria

- A developer can start at the RTT topic entry and follow one feature-root path to the durable
  result and topology-recomputation side effect.
- The first two slices expose clear inbox, mutation, policy, and persistence owners without empty
  scaffolding or pass-through indirection.
- Existing observable behavior and persisted contracts remain unchanged except for separately
  tested real bug fixes.
- Every touched file reaches full standards closure, including recursively touched support files.
- Every verified weakness not fixed in scope has a reused or newly created GitHub issue.
- Focused semantic, persistence, concurrency, typecheck, structure, style, and formatting evidence
  is recorded exactly as passed, failed, or skipped.
- No PR or remote branch is created until requested.
