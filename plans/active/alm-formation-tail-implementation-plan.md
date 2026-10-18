# ALM formation-tail admission plan

## Goal

Reduce the serial read cost on the current WS outbox delivery path without changing
its event protocol. This is one measured repair toward the parent V1c plan's ≤2 s
formation-tail target, not evidence that the whole target is already met.

## Global constraints

- Preserve every event, immutable audiences, causal revisions, per-sender commit
  ordering, single-member fallback, claim fencing, deadlines and retry outcomes.
- Use TDD, existing patterns and shared mechanisms. No duplicate scheduler, legacy
  path, lossy coalescing, protocol migration or new dependency.
- Review and remediate every changed human-authored file completely. Support files
  modified by that remediation enter closure recursively; independent untouched
  code remains outside closure.
- Performance and fault tolerance apply equally to Rallar production code and the
  shared-test harness. Keep failures and unresolved bottlenecks visible.
- Keep generated measurements under `tmp/perf/`. Distinguish controlled-port causal
  evidence from PostgreSQL service measurements and hosted formation acceptance.

## Evidence and design

Current `ALOutboundDispatchAdmission.readGroupDecisions` awaits each member before
starting the next. The existing dequeued front already uses bounded concurrency,
while `TurnBatchedReads` can combine same-turn storage requests. A current
production-admission probe over PGlite with eight messages and a controlled 20 ms
read delay measured one active read, correct ordered results and one commit in all
three runs. It establishes serialization at this owner, not its hosted share.

Use `BoundedConcurrencyAdmission` for at most two concurrent group-member reads,
matching the existing dequeued-read bound. Wait for all admitted reads to settle
before a group commit or sequential fallback. Keep result order independent of read
completion order. A read failure, settled member, moved sender version or failed
group fence retains the existing fresh single-member fallback.

## Task 1: Bound group decision reads and preserve failure isolation

**Owners:** `packages/shared/alm/outbound/al-outbound-dispatch-admission.ts`, the
existing bounded admission primitive, and mirrored ALM outbound tests. Reuse
current fixtures and real admission stores; inspect existing tests before adding
coverage. Affected support files enter the same standards closure.

1. Add a semantic RED test at the production admission boundary: a queued burst
   including a late message starts a second independent read while the first is
   held, never starts more than two, commits only after reads settle, and returns
   every committed message in input order with its original audience/payload.
2. Cover one rejected read while another remains held: no fallback or group write
   may run until all reads finish. Fresh single-member fallback must preserve
   each member's own result and allow subsequent work to progress. Reuse existing
   stale-version/moved-claim, expiry and ordered-track tests for distinct fences;
   add only missing coverage.
3. Implement with the existing `BoundedConcurrencyAdmission`. Preserve wire and
   persisted contracts, sender lock lifetime and commit/settlement order. Keep
   operation-count claims based on actual backend counters; overlapping read-phase
   deltas are not additive per-message SQL counts.
4. Close touched-file standards. In particular inspect the hand-written sender
   promise chain and compose the existing max-one admission primitive if it is
   duplicated scheduling. Preserve queued-origin diagnostics and idle map cleanup.
   Do not change a verified public compatibility contract silently.
5. Run focused tests plus shared/shared-server typechecks and the affected API
   Deno check. Repeat the retained production-path probe with identical parameters
   and report before/after, including throughput and failure limitations.
6. Commit the coherent change, report RED/GREEN evidence and touched-file closure,
   then obtain independent task review and address findings.

## Validation and delivery

The controller owns fresh before/after state-write comparison and the unchanged
PostgreSQL medium-scale correctness gate because read concurrency changes. Use
focused real PostgreSQL tests if specialized SQL or its transaction semantics
change. Run local 15 → 30 → 50 in order, then the hosted timing-off acceptance for
this classified distributed path. Preserve original deadlines and all 231 native
predicates. Diagnose a failure before any retry.

Publish and update one semantic PR. The next useful slice remains the parent's
remaining measured bottleneck/shared-mechanism audit; full V1c closure remains an
outcome. Report remaining formation delay honestly. Delete this narrow plan only
when its repair and selected validation are complete, within the same PR; retain
the unfinished parent plan. Run delivery status before broad final validation and
ready once at handoff. The user owns merge.
