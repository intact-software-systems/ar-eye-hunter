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
- Label reported metrics with units; use seconds (`s`) for human-facing durations,
  mutations/s for throughput, and explicit event counts and byte sizes. Preserve the
  canonical artifact schema's units and convert only at the reporting boundary.

## Evidence and design

Current `ALOutboundDispatchAdmission.readGroupDecisions` awaits each member before
starting the next. The existing dequeued front already uses bounded concurrency,
while `TurnBatchedReads` can combine same-turn storage requests. A current
production-admission probe over PGlite with eight messages and a controlled 0.020 s
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

## Task 2: Associate real logical enqueue identities without weakening validation

**Owners:** `apps/api-v1/scripts/perf/state-write/state-write-diagnostic-association.ts`
and `packages/tests/shared-server/performance/state-write/state-write-diagnostic-projection.test.ts`.
This repairs diagnostic evidence, not production mutation or retry behavior.

1. Use TDD and the real `AppInboxCommandClient` plus real queue-entry derivation to
   reproduce logical resource/context values longer than the queue key bounds.
   Cover both profile/instance commands and group-scoped commands with production
   timing enabled and phase timing disabled. Do not pass pre-hashed physical keys
   to the client merely to satisfy projection. Assert the derived persisted key
   differs, projection is complete, and command/operation/origin attribution is
   correct. Keep raw identities, principals, payloads and errors out of export.
2. Validate the identity representation owned by each event producer. Logical
   enqueue timings must match the complete logical identity and originating
   worker; physical handler/transaction/release details retain their existing
   physical validation. Reject wrong logical resource, context, type and worker,
   ambiguous identities and mixed logical/physical detail representations. Do not
   accept each field independently against either representation.
3. Reuse the current association index and projection. Preserve supported labels,
   command boundaries, timing status, privacy, explicit unassociated SQL, all
   resource limits and truthful rejection/truncation. Add no duplicate association
   engine, legacy branch or format migration.
4. Read and close the full changed-file coding/testing standards, including any
   support files modified by that work. Keep unrelated untouched code outside
   closure. Run focused diagnostic tests and the affected API Deno check; record
   the semantic RED and GREEN results and commit only this coherent task's files.
5. Obtain independent spec and quality review. The controller owns plan/PR edits,
   bounded-capture design and subsequent unchanged-workload measurements.

## Task 3: Restore complete bounded diagnostic capture

**Owners:** the existing state-write diagnostic projection, its tests, the current
`run-api-v1-state-write-measurement.mjs` validator and command-port workflow fixtures,
and `apps/api-v1/scripts/perf/README.md`. Use Task 2's reviewed association result.

The retained requested streams reach 101,185 and 100,663 timing-plus-release events;
byte compaction alone cannot satisfy the old 100,000-event ceiling. Removing two
exactly derived properties shrinks retained hot files by 21.7%. Estimates of absent
rows fit the existing byte ceiling but are estimates, not completeness evidence.

1. Write only the explicit `rallar.state-write.diagnostic.v2` representation. Keep
   readable named JSON records, every independent timing field, event order and
   multiplicity, all boundaries/releases, associations and privacy validation.
   Omit only timing-row `approximateStartedAtEpochMs` and `statusMeaning`:
   approximate start is `completedAtEpochMs - roundedDurationMs`; the
   `state-write-benchmark-phase` component's status means wrapper-finally, never
   commit, while other status values describe the timed operation. Document this
   derivation contract once instead of repeating it in every row. Preserve the
   machine schema's millisecond units; human reports use seconds.
2. Set the current diagnostic budget to 110,000 logical timing-plus-release events
   per phase, with unchanged 33,554,432-byte phase and 536,870,912-byte run ceilings.
   This is an explicit 10% resource-budget increase, providing 8,815 events of
   headroom above the observed maximum. It does not change correctness/performance
   acceptance, guarantee future captures fit, or bound the pre-existing raw timing
   array collection. Preserve footer/receipt reserves and exact UTF-8 accounting.
   No grouping, sampling, dropped SQL evidence, byte-limit increase or override.
3. The hosted reader validates only a fresh capture from the same pinned candidate
   checkout; it has no historical-input API. Update this current validator and its
   generated fixtures together. Keep original v1 artifacts unchanged; add no v1
   adapter, new analyzer, generic codec or duplicate projection. Validate current
   schema/count consistency and reject unsupported schema or incomplete output.
4. Use semantic TDD. A representative SQL-heavy stream with a late command timing
   must retain every event under a byte budget where the redundant representation
   overflows. Assert independent timing facts, derived start/status interpretation,
   privacy, order, multiplicity, exact bytes and complete counts. Prove the observed
   101,185-event shape fails at the old logical-event ceiling and fits the revised
   policy when bytes permit; cover exactly 110,000 and 110,001 combined events and
   truthful overflow. Preserve separate byte/run limit and rejected-association
   tests; include mixed rejection/truncation arithmetic. Hosted fixture tests must
   verify revised count acceptance, overflow and schema rejection, not merely swap
   a version literal. Do not change benchmark workload or comparator thresholds.
5. Read and remediate every changed file completely; include support files modified
   by closure and leave independent untouched code outside scope. Use existing
   ownership and mechanisms. Run the focused diagnostic and affected workflow tests,
   appropriate native checks and API Deno check. Commit coherent task files only;
   controller owns plan/PR edits. Obtain independent spec and quality review.
6. Controller then runs the unchanged diagnostic workload and validates canonical
   correctness, full timing/release/boundary completeness, resource accounting and
   owned cleanup. A failed or truncated run remains failed; diagnose it before any
   retry. Instrumented timing is attribution evidence, never performance acceptance.

## Validation and delivery

The controller owns fresh before/after state-write comparison and the unchanged
PostgreSQL medium-scale correctness gate because read concurrency changes. Use
focused real PostgreSQL tests if specialized SQL or its transaction semantics
change. Run local 15 → 30 → 50 in order, then the hosted timing-off acceptance for
this classified distributed path. Preserve original deadlines and all 231 native
predicates. Diagnose a failure before any retry.

The first local comparison and the prescribed hosted A-B-B-A comparison both
failed the unchanged performance gate. Hosted pooling reports higher uncontended
p99, lower hot throughput and higher hot transaction duration. Before accepting
the repair, retain both failed comparisons and do not add a regression waiver.
Executable dependency traversal excludes the changed admission class; its graph
presence comes through type-only imports. A preload call-counter diagnostic using
the unchanged benchmark entry and full three-run workload observed zero calls to
all five admission methods. The benchmark drains AppInbox and persists outbox
intents without dispatching them. Its deterioration therefore needs attribution
on the actual AppInbox/SQL path, rather than a speculative admission repair.
The four hosted positions show heterogeneous changes, not a simple chronological
slowdown. Separate handler/completion waiting, transaction wall time, event-loop
and GC activity, and PostgreSQL contention on a common timeline before another
performance comparison. Instrumented diagnostic timings are not acceptance evidence.

Local 15, 30 and 50 passed all native predicates. Hosted timing-off 15, 30 and 50
subsequently passed in order with the original manifests. The first started hosted
15-agent attempt expired in agent readiness with
only six browsers connected while worker jobs were queued; the recipe never ran.
Remaining workers were stopped. Retry only after checking runner capacity, without
changing cohort size or deadlines. The successful rerun followed a cleared CI
queue. These cohorts establish native acceptance, not the complete formation-tail
target or a passing comparative performance gate.

The existing state-write diagnostic also failed closed: logical enqueue identity
was rejected against physical-key expectations, and hot timing phases exceeded
their byte budget. Database cleanup succeeded. The parent plan now selects
diagnostic association and bounded capture as the next repair before further
state-write attribution; preserve the failed receipt and original comparisons.

Publish and update one semantic PR. The next useful slice remains the parent's
remaining measured bottleneck/shared-mechanism audit; full V1c closure remains an
outcome. Report remaining formation delay honestly. Delete this narrow plan only
when its repair and selected validation are complete, within the same PR; retain
the unfinished parent plan. Run delivery status before broad final validation and
ready once at handoff. The user owns merge.
