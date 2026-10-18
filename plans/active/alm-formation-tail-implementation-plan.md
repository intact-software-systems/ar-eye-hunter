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

## Implemented behavior and evidence

Group admission now uses the existing `BoundedConcurrencyAdmission` with at most
two active reads. `Promise.allSettled` joins every scheduled read before ordered
commit or fresh sequential fallback. The same primitive with concurrency one
replaces the per-sender promise chain, preserving FIFO, queued-origin diagnostics
and idle cleanup. No event, audience, fence, deadline or retry contract changes.
Semantic TDD covers overlap, the concurrency bound, a rejected read beside a held
read, ordered results and subsequent progress. Independent source review found no
remaining changed-code defect.

A controlled production-owner probe with eight messages and an injected 0.020 s
read delay measured median admission of 0.21790 s before and 0.11683 s after
(three runs each). This proves the selected mechanism's benefit under controlled
waiting; it does not establish its share of hosted formation delay. Local and
hosted timing-off 15 → 30 → 50 workloads passed unchanged native acceptance.
The full ≤2 s promotion-to-browser formation-tail target remains open.

The failed state-write investigation exposed two diagnostic defects, now repaired
with TDD at their existing owners:

- Logical enqueue identity is validated as emitted by `AppInboxCommandClient`,
  including complete resource/context/topic/type/request and originating worker.
  Physical handler, transaction and release identity validation stays separate.
  Real-client tests with long identities reject malformed or ambiguous events
  and preserve privacy; no alternate association engine was added.
- Current diagnostic v2 omits only derived start and status-meaning properties.
  Start remains derivable from completion minus rounded duration; benchmark-phase
  status means wrapper-finally, never transaction commit. The private validator
  consumes fresh output from its own pinned candidate, with no historical-input
  API or v1 adapter. Original artifacts remain intact.
- The explicit event ceiling is 110,000 timing-plus-release events per phase:
  the prior observed maximum of 101,185 cannot fit 100,000 even after byte
  compaction. Phase/run byte ceilings remain 33,554,432/536,870,912 bytes, with
  unchanged footer/receipt reserves. Order, multiplicity, boundary/release
  priority and truthful overflow remain tested. These bounds govern persisted
  output, not the pre-existing raw timing arrays collected during a phase.

The unchanged real diagnostic now retains all twelve phases: 8,400 accepted
commands, including 6,300 measured commands, and 9,600 unique enqueue completions.
There are zero rejected or truncated events; phase bytes total 212,825,733.
Canonical correctness, postflight and owned cleanup pass. The earlier incomplete
capture remains evidence of the repaired defects, not a discarded run.
Instrumented timings are attribution evidence, not performance acceptance.

## Unresolved comparative acceptance

Both the local comparison and the prescribed hosted A-B-B-A comparison failed
unchanged thresholds. Hosted uncontended p99 was 0.20621 → 0.23773 s (+15.29%),
hot throughput 39.94 → 37.87 mutations/s (-5.20%), and median per-run transaction
wall-duration sum 100.015 → 106.105 s (+6.09%). Overlapping transaction sums are
neither one transaction nor database CPU time. Keep the PR draft and retain both
failed comparisons; no regression waiver or blind comparative retry is selected.

Executable dependency tracing and a full-workload call-counter diagnostic show
that this benchmark never invokes the changed outbound admission methods. It
drains AppInbox and persists outbox intents without dispatching them. The
heterogeneous four-position deterioration needs attribution on that actual path.

Complete capture locates two distinct costs. One uncontended 0.330461 s command
has a 0.012 s final-transaction-to-enqueue gap followed by 0.190538 s before caller
return. One hot 8.270573 s command has eight optimistic conflicts, nine attempts
and 7.127 s of prescribed retry delays; its final transaction takes 0.00407 s.
These selected examples do not explain the distribution-wide regression or prove
ownership of concurrent process SQL. Approximate wall-clock timestamps and
rounded durations must not be treated as exact additive CPU accounting.

## Next two useful slices

1. **Remaining formation-tail delivery.** Recover the current promotion commit →
   delta write → outbox claim/send → browser acceptance timeline. Attribute serial
   after-admission publication, captured-policy reads and direct-send time using
   actual backend counters. Select a positively located defect, reproduce it with
   a queued burst and late promotion, and repair it with existing mechanisms.
   Preserve every immutable event/audience, causal fence and fault outcome. Run
   affected correctness checks and local 15 → 30 → 50 before hosted timing-off
   acceptance, with unchanged predicates and deadlines.
2. **State-write completion and retry attribution.** At `runAppInboxMutation`,
   correlate successful transaction, enqueue completion, pending dequeue and
   caller return. A held-dequeue test should distinguish command completion from
   required drain/cleanup joins before choosing a lifecycle repair. Attribute
   process SQL to its actual dequeue owner; temporal overlap cannot establish
   ownership. Separately measure optimistic-conflict incidence and retry-delay
   amplification. Change no retry policy or comparison threshold to manufacture
   a pass. Measure raw timing-array allocation/retention before claiming bounded
   capture memory or selecting a streaming repair.

The parent plan retains large-result certification, the post-terminal headless
shutdown race, test-harness scheduling sensitivity, the shared-mechanism audit
and all original V1c benefit gates. Native acceptance and complete diagnostics
close none of those independent outcomes.

## Validation and delivery

Admission, identity and bounded-capture changes have separate semantic RED/GREEN
coverage and independent spec/quality reviews. Focused checks, affected native
checks, test typing and the repository style command pass; advisory style output
is not a waiver of changed-file closure. Final source review has no requested
fixes. The unchanged PostgreSQL medium-scale correctness gate passes.

The local aggregate test run failed eleven tests while another checkout's large
suite shared the machine: nine timeouts, one polling deadline and one missing
drain observation. All 243 tests in those eleven files passed with one worker
after the competing run ended. Keep both results; contention is not proven to
explain every failure, and assertions/deadlines were not weakened. The parent
plan records deterministic observation-order and resource-isolation follow-ups.

Publish one readable PR with main-versus-candidate comparisons, metric units,
limitations and unresolved follow-ups. Keep only the next two slices concrete;
Git history and ignored artifacts retain detailed implementation chronology.
Delete this narrow plan only after its selected acceptance is actually complete;
the failed comparison and full formation-tail target currently keep it open.
Run delivery status before broad final validation and ready once at handoff.
The user owns merge; a readiness action does not waive the failed performance gate.
