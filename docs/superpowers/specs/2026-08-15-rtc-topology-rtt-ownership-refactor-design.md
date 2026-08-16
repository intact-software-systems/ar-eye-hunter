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

- the WebSocket entry and its process-local RTT refinement gate are under
  `rallar-system/topology/rtt`;
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
  topic/          WebSocket RTT entry, predicted-delta observation, refinement gate, and handoff
  inbox/          Durable command construction, authority, and AppInbox dispatch
  mutation/       Read, compute, validate, write, receipt, and result decisions
  policy/         RTT acceptance and expired-authority decisions
  persistence/    Repository contracts, storage, codecs, keys, validation, and cleanup
```

The exact final filenames follow the responsibilities recovered from current code; the refactor does
not create empty folders or vocabulary-only wrappers.

The following ownership remains unchanged unless later evidence proves a concrete conflict:

- `rallar-system/topology` owns group-topology configuration, planning, publication, and durable
  replay;
- `rallar-system/topology/planning` continues to own the canonical planning input, incremental
  evolution, and topology-kind hysteresis introduced by stable topology evolution;
- `packages/shared-graph` owns graph algorithms and Vivaldi calculations;
- AppInbox owns durable queue infrastructure, not RTC RTT decisions;
- API-v1 owns process composition and configuration; and
- browser/shared RTC code owns measurement production and transport behavior.

The broad `rallar-rtc-topology-service.ts` is not moved mechanically. Current main has grown it to
roughly 1,500 lines while also extracting canonical planning input, incremental evolution, and
topology-kind hysteresis into `topology/planning`. After the first two slices, its remaining
responsibilities are classified between RTC measurement policy, group-topology planning, graph
calculation, process-local snapshot state, and composition. Only responsibilities with a truthful
RTC-topology owner move; the rest stay with or move to their actual owner in a separately reviewed
later slice. If that structural weakness is not resolved by this refactor, it receives a focused
GitHub issue before delivery rather than being left implicit.

## Latest-main compatibility adaptation

Stable topology evolution added an RTT refinement threshold and interval gate after this design was
first written. That evidence changes the move inventory but not the behavior-preservation contract:

- `init-rtc-rtt-topic.ts` now measures the Vivaldi predicted-RTT delta after an accepted in-memory
  observation and uses a process-local `RtcRttRefinementGate` before enqueueing topology refresh;
- API-v1 passes that gate into a persistent RTC runtime, but the topic returns into durable AppInbox
  before observing Vivaldi or invoking the gate, so the configured threshold and interval are not
  active on the production persistent path;
- durable RTT mutation currently serializes its recompute intents as `group-revision` work, so the
  executor's `rtt-refresh` unchanged-result gate is bypassed as well;
- this is an actual production bug: durable RTT persistence remains atomic, but its configured
  refinement damping is ineffective and accepted reports can trigger unnecessary full replans;
- the fix keeps measurement, receipt, and outbox writes in one AppInbox transaction, identifies the
  durable work truthfully as an RTT refresh, and applies Vivaldi observation plus process-local
  refinement damping idempotently per durable work identity before planning;
- a repeated delivery on one process reuses the same observation and claim decision, while a
  restarted process retains the documented permission to refine once early; a below-threshold work
  item is completed without changing durable topology, and threshold-qualified work still passes
  through the existing unchanged-publication gate;
- the gate, its defaults, accumulated per-group state, first-observation behavior, zero-knob
  compatibility behavior, and API-v1 configuration wiring move with the RTC RTT feature owner;
- durable AppInbox RTT mutation remains authoritative and keeps measurement, receipt, and final
  topology AppOutbox writes atomic; the refinement gate is process-local scheduling policy, not
  persisted authority; and
- the new canonical planning, evolution, hysteresis, fingerprint, and unchanged-publication owners
  remain under `rallar-system/topology` and are updated only for import paths required by the move.

No open pull request currently overlaps this RTC RTT ownership refactor. The existing RTC signaling
diagnostics draft concerns a different boundary.

## Authorized legacy closure

The follow-up decision for this same pull request makes the RTC-specific cutover terminal. The
implementation no longer retains transitional code merely because an older writer or in-flight
row once required it. This supersedes the earlier compatibility assumptions only for the following
bounded RTC RTT surfaces:

- old topology work envelopes without the canonical RTT measurement and refinement observation
  identity are rejected instead of normalized;
- the `rtc-rtt:recompute-outbox` namespace, its offline upgrader, and the old RTT pair-key migration
  are removed;
- mutation computation carries canonical affected groups directly to the final AppOutbox writer
  instead of materializing the retired recompute-intent intermediate contract;
- deprecated topology-outbox call overloads that omit sender and resource identity are removed;
- unused package-level RTT mutation aliases are removed; canonical `RtcRtt` names remain exported;
  and
- compatibility-only production branches, tests, fixtures, registry entries, and test-governance
  pins are deleted with their owners.

This authorization does not classify unrelated, still-wired repository migration families as
unused. In particular, scalar-authority recompute draining and topology snapshot/publication
migrations stay outside this closure because current API composition or maintenance commands still
invoke them.

## Concrete execution horizon

### Slice 1: RTT ingress and mutation ownership

1. Characterize the current WebSocket-to-AppInbox-to-mutation behavior with semantic tests.
2. Move the RTT topic entry and process-local refinement gate into the RTC-topology feature.
3. Consolidate mutation contracts and the read, compute, validate, write, receipt, result, and
   measurement-policy decisions beside the existing inbox handler.
4. Update internal consumers directly and retain no pass-through compatibility module unless an
   actual public or external consumer is proven.
5. Add a navigation README and mirror focused tests by behavior.

Acceptance for this slice is unchanged command decoding, authority verification, idempotent replay,
mutation outcomes, receipt identity, transaction timing, after-commit effects, failure behavior,
plus corrected persistent-path predicted-delta observation, per-group refinement damping, durable
retry idempotence, and zero-knob compatibility behavior.

### Slice 2: RTT persistence ownership

1. Characterize repository behavior and live concurrency boundaries before movement.
2. Move repository contracts, runtime namespaces, storage keys, codecs, exact reads, mutation
   writes, cleanup, and persisted-shape validation into `rtc-topology/persistence`.
3. Fix the stale receipt-family cleanup assumption: current mutation code writes final AppOutbox
   entries directly and no longer writes the retired `rtc-rtt:recompute-outbox` intermediate rows,
   so receipt cleanup must guard and delete the expired receipt without requiring absent siblings.
4. Split the current repository only at real read, write, cleanup, or codec boundaries;
   do not create one-file folders or forwarding layers.
5. Mirror persistence tests and update internal consumers.
6. Re-run repository navigation and structure checks before selecting another slice.

Acceptance for this slice is byte-compatible persisted data, unchanged canonical keys, unchanged
transaction and optimistic-concurrency behavior, and unchanged retention and cleanup, except that
valid expired receipts no longer fail cleanup because obsolete intermediate siblings are absent.

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
- canonical storage keys, runtime namespaces, codecs, and persisted shapes;
- outbox and topology-recomputation intent;
- optional metrics remaining non-authoritative and never-throw;
- process-local RTT refinement thresholds, intervals, accumulation, and first-observation behavior;
- existing package and application behavior; and
- the intentional correction that makes those configured refinement controls effective for durable
  RTT work, plus the correction that lets valid expired receipts clean up after direct final-outbox
  delivery replaced the legacy intermediate outbox.

The authorized legacy closure intentionally removes the superseded RTT migration entrypoints,
legacy work decoder, deprecated overloads, and unused export aliases. Those removed surfaces are no
longer part of the preservation contract.

No protocol, API, database schema, topology algorithm, RTT acceptance policy, distributed recipe,
or performance threshold changes as part of an ownership move. The persistent-path refinement fix
changes only the broken bypass: it makes the already configured threshold and interval apply where
current production wiring ignores them. The receipt cleanup fix removes an obsolete sibling
requirement; it does not shorten retention or delete live rows.

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
- RTT refinement-gate, WebSocket scheduling, and API-v1 configuration tests;
- runtime-state repository, cleanup, and key-shape tests;
- PostgreSQL RTT concurrency tests when persistence ownership changes;
- affected topology scheduling and WebSocket routing tests;
- `@ar-eye-hunter/shared-server` typecheck;
- the API-v1 Deno check because composition imports and gate wiring move;
- repository structure and changed-file style checks; and
- formatting and `git diff --check`.

No product build, distributed recipe, black-box topology replay, or performance benchmark is added
merely because files moved. A bug fix or unexpected behavior change selects additional validation
according to the affected boundary and current testing guidance.

## Delivery and review

Work stays on `codex/rtc-topology-rtt-structure` in the dedicated worktree. Implementation remains
local until it is complete and affected validation has run. The finished branch is then pushed and
one normal pull request is created with the semantic goal, changes, acceptance, validation, risk,
rollback, and linked follow-up issues; no plan bookkeeping or closure receipt is created.

## Acceptance criteria

- A developer can start at the RTT topic entry and follow one feature-root path to the durable
  result and topology-recomputation side effect.
- The first two slices expose clear inbox, mutation, policy, and persistence owners without empty
  scaffolding or pass-through indirection.
- Existing observable behavior and persisted contracts remain unchanged except for separately
  tested real bug fixes.
- Every touched file reaches full standards closure, including recursively touched support files.
- Every verified weakness not fixed in scope has a reused or newly created GitHub issue.
- The unresolved all-pairs Vivaldi cost, broad topology-service ownership, API composition density,
  and refinement-decision expiry weaknesses are tracked by GitHub issues #235, #236, #237, and
  #240. This pull request resolves the mutation-decision and persistence-validation ownership
  weaknesses tracked by #238 and #239.
- Focused semantic, persistence, concurrency, typecheck, structure, style, and formatting evidence
  is recorded exactly as passed, failed, or skipped.
- The completed, validated implementation is published as one pull request.
