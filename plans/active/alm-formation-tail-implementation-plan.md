# ALM formation-tail admission plan

## Goal

Reduce measured WS outbox formation-tail delay without changing its event protocol.
Bounded admission reads are the first implemented repair; the current focus is the
long committed-output-to-reservation gap. The parent V1c plan's full ≤2 s
formation-tail target remains open.

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

A subsequent real-runtime/PGlite/pubsub-bridge probe preserves production page
size, exact events and captured audiences. With no injected wait, median drain
for 1/10/50/200 rows is 0.013538/0.055546/0.224093/0.828825 s (three measured
repeats after warmup). Captured-policy reads account for roughly 4–10% of that
wall time; they do not dominate this local drain. A separately labelled 0.005 s
policy-port delay adds 0.058793 s to the ten-row drain, confirming serial
sensitivity only. Transport and final socket ports were capture adapters, so
the result cannot establish hosted network cost or browser acceptance. Recover
the actual full-stack timeline before selecting another publication optimization.

Optional capture now retains the existing safe promotion marker. Fresh diagnostic
local cohorts passed all 231 native predicates each, with verified recorder bytes
and counts and one scoped successful anchor joined to every expected browser:

| Agents | Marker to adoption p50 / p95 / maximum (s) | Estimated attempt start to adoption maximum (s) |
| ------ | ------------------------------------------ | ----------------------------------------------- |
| 15     | 0.036 / 0.039 / 0.039                      | 0.05182                                         |
| 30     | 0.350 / 0.358 / 0.359                      | 0.41101                                         |
| 50     | 0.358 / 0.386 / 0.386                      | 0.49316                                         |

These are single local memory-backend observations, not a main comparison or a
reproduction of the historical hosted PostgreSQL delay. All API streams remain
globally partial; complete selected pairs do not certify all server telemetry.
The marker follows transaction return and queue wake, and the estimated start
uses rounded duration without a measured timestamp-sampling bound. Preserve that
uncertainty rather than claiming a strict commit-to-adoption bound. The 50-agent
run also logged a post-terminal control-artifact canonical-node limit despite
complete selected pairs and matching native export bytes; retain that independent
artifact-durability follow-up. Current evidence does not select another local
publication optimization. Recover current hosted server delivery evidence next.

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

## Hosted formation evidence

### Latest stage-attributed diagnostic

The unchanged timing-enabled fifty-agent workload passes all seventeen shards,
150 commands and 231 group assertions in 76.772 s, with no reconnects or failed,
missing, stale or flaky agents. All seven successful promotion-owned output
chains have unique same-process claim/publication identities. The largest measured
gaps are committed-output observation to reservation return: 11.711 s for version
4 (12.058 s to local send, 28 recipients), 6.804 s for version 5 (7.044 s total,
48 recipients), and 3.644 s for version 2 (5.938 s total, two recipients). These
are earlier partial-cohort outputs; they must not be hidden by selecting only
the later layout accepted by all fifty browsers.

The first retained all-cohort layout is version 6. Its promotion-owned output
57/45 takes 2.559 s from committed-output observation to local send: 1.016 s
before reservation return and 1.426 s in the grouped admission-commit window.
A separate activation output 58/45 takes 1.610 s and shares the commit window;
its causal tuple matches all fifty retained browser states. This correspondence
does not prove which notification caused adoption. Both outputs send live to
50/50 recipients. Across 55 claim-stamp batch windows, commit-window median /
p95 / maximum are 0.212 / 1.224 / 1.427 s; per-member markers must not be counted
as independent transactions.

Prioritize the output-to-reservation gap. Trace existing wake, scheduling and
claim owners and reuse existing evidence before adding any missing observation.
Do not assign this unsplit interval to SQL, queue fairness or a lost wake without
evidence. Admission commit remains a secondary measured cost. This run is not a
matched comparison against main or the prior diagnostic, and instrumentation
overhead has not been isolated. Preserve all outputs, audiences, fences, deadlines
and retry outcomes when selecting the next focused TDD repair.

The occupied-owner middleware test now covers an external WS_OUTBOX write and
wake during a controlled 10 s hold. After capacity returns, the second row
completes within 0.010 simulated seconds on unchanged production, without a
second wake or manual pass. This refutes a lost post-capacity wake for that
fixture; the intentional occupied interval is not a runtime measurement.

An isolated real PostgreSQL probe reuses the existing grouped outbound owner.
Six warmed samples per occupancy give outer admission medians of 0.042929 s
for ten rows and 0.066707 s for sixteen; one admission transaction medians are
0.023485 s and 0.033455 s. Actual application statements outside / inside
transactions are 47 / 74 and 74 / 116. Cold pool initialization is retained
separately. These local synthetic-send results do not attribute the hosted
1.426 s window, establish a speedup, or split its pre-reservation wait.

The long-waiting version 4 and 5 targets appear in the eighth and seventh
claim batches after their output markers. Respectively 25 and five newer
committed group-state outputs were claimed first. The reservation contract
orders eligible rows by due time and sequence-assigned row ID, with locked rows
skipped. Sequence caching and transaction completion can separate row-ID order
from commit-marker order. Thus a strictly older-output-only backlog is refuted,
but no FIFO violation or hosted selection cause is established. Row IDs and lock
state were not captured. Reuse existing batch/readiness diagnostics to split
owner occupancy, readiness, selection and claim before changing queue policy.

Clipped unions of same-process API timestamps further localize these waits.
Prior reservation-to-settlement batch envelopes overlap 9.909 s of the version 4
gap (84.6%) and 6.211 s of version 5 (91.3%). Read, grouped-commit and ordered
dispatch-to-settlement envelopes account for 1.652 / 4.988 / 3.233 s and
0.838 / 3.210 / 2.134 s respectively. These categories partition observed batch
envelopes, not CPU or SQL work; version 4 also includes 0.001 s of its own batch
onset. Outside all envelopes remain 1.801 / 0.593 s. Settlement still precedes
durable release, and overlap does not establish target eligibility or continuous
owner occupancy. This evidence changes the next measurement priority: split
earlier batches' grouped commit and local-send cost, retaining existing batch
claim/release facts for the residual. A generic wake trace alone cannot explain
the majority already localized to previous batch stages.

The optional owner observations now retain one completed batch record, one
actual grouped decision/bundle record and one captured-policy-read endpoint per
publication. Claim duration ends before per-row logging. Batch source timestamps
are time facts, not unique IDs; joins also require actual owner identity and
ordered source boundaries. Summed claim-work duration is not elapsed batch
occupancy. The group bundle interval is not a transaction receipt, and sender
queue/lock wait before the group operation remains outside that window. These
boundaries preserve all existing scheduling, admission and send outcomes.
Controlled held-boundary tests establish semantics, not hosted cost. The final
source adds 241 Brotli bytes to each browser/headless bundle versus the preceding
source, within unchanged 266 / 355 KiB budgets. Matched timing-off comparison
must use common browser/native measures because timing-off removes the optional
server promotion anchor too; it cannot supply a paired server-stage measurement.

The API journal retains 19,623 lines below its 50,000-line cap, with no malformed
timing rows or suppression notices. All 569 observed attempts have complete
stage chains, but the control journal again reports a 100,000-node artifact
append/certification failure, tracked independently in [#682](https://github.com/intact-software-systems/ar-eye-hunter/issues/682). Matching exported counts and passing native
assertions do not certify full durable export or queue release. Timing-off
restoration and fresh inspection pass on the exact source: settings fingerprint,
topology, database identities, migrations and healthy idle state match; auth
count remains fifty and the new scope adds one group.

### Matched timing-mode owner findings

The unchanged native-fifty workload now has a predeclared OFF–ON–ON–OFF sequence
on one reviewed source, each in a fresh group without resetting persistent state.
Each run passes fifty recipes, 231 group assertions and 150 matching successful
command IDs. Whole-run durations in declared order are 72.858 / 74.364 / 75.354 /
75.681 s. ON1 minus OFF1 is +1.506 s, whereas ON2 minus OFF2 is -0.327 s; this
small sequence does not establish timing overhead amid run-order and persistent
state drift. Browser planned-to-accepted denominators are 46 / 35 / 17 / 29 of
fifty, so missing starts must remain missing rather than be pooled or imputed.
The two timing-on captures locate the
first fully accepted layout's own promotion output at 4.343 / 5.963 s before
reservation and 4.418 / 6.239 s before local send. Same-worker completed batch
envelopes overlap 4.341 / 5.962 s of those pre-reservation gaps. Earlier partial
layouts still have longer waits; retain every promotion and the distinct activation
outputs rather than substituting a shorter later chain. Browser causal matches
remain observations, not notification-delivery causality.

Different stages dominate the two captures. One preceding sixteen-claim batch has
a 1.134 s union of authority reads; another has a 2.660 s release-call interval.
Existing same-process event-loop samples cover that release interval and include
a 1.650 s late tick, with only one tick observed in its 1.700 s sampler window.
An inbound three-claim pass overlaps too. This proves a process-wide timer delay
was observed, not that release SQL, inbound work, CPU, garbage collection or any
particular owner caused it. The authority-read wave has smaller recorded maximum
lags of 0.016 / 0.193 s. Do not optimize one SQL loop from a wall-time envelope.

Source inspection finds serial per-row compare-and-replace updates inside the
existing PostgreSQL release transaction, plus conditional finalization reads and
lost-reservation retries. Those are concrete costs to characterize only after
checking the shared-process stall. The generic local owner probe omits the WS
authority callback, so its fast admission result cannot rule out that production
wave. Prefer existing CPU/GC profiling and real-owner fixtures over another
production observation framework; retain claim fences, exact dispositions,
atomic rollback, healthy-neighbor recovery, bounded reads and ordered sends.

Timing off removes all optional API timing, including promotion anchors. The mode
comparison therefore uses per-run native/browser measures and their denominators,
not paired server-stage costs or an isolated incremental cost for the latest
instrumentation. The controller artifact append limit recurs in both modes;
[#682](https://github.com/intact-software-systems/ar-eye-hunter/issues/682) retains
that evidence. Neither passed recipes nor retained accepted events certify full
recorder retention or satisfy the full formation-tail target.

### Earlier diagnostic motivating stage attribution

The corrected timing-enabled fifty-agent workload passes registration in all
seventeen shards and all 150 commands across fifty agents, with no reconnects,
failed, missing, stale or flaky agents. The run takes 78.708 s. Its fifty warning
diagnostics are the existing session-identity mismatch notices. Timing-off
restoration and fresh inspection pass: public settings, exact timing/topology,
database/role/table identities and all migrations match the baseline; services
are healthy and idle. Existing users can sign in through the preserved store.

The retained same-server evidence now locates a slow promotion: marker to publish
5.424 s, publish to positive send to all fifty recipients 0.004 s, total 5.428 s.
A later promotion takes 0.134 s. Correlation uses the actual shared queue-key
translation, full scope and browser-observed accepted causal tuples; it does not
assume emitted queue keys contain the command text or equate planned layout with
accepted event revision. Both observed layouts have all fifty browser adoption
identities. Browser-host clocks are not subtracted from the server clock.

For the slow case, a uniquely scoped, single-work summary-write marker appears
0.164 s after promotion, leaving 5.260 s before publication. This marker records
routine return and does not explicitly encode committed outcome; preserve that
limitation. Attribute this interval to actual queue claim, admission and dispatch
stages using existing evidence before selecting a repair. Add only the minimum
missing timing at the current owner if those stages cannot be distinguished.
The passing workload does not establish the complete ≤2 s target.

The implemented diagnostic uses optional timing at the existing summary, claim,
admission and publication owners. Each committed summary output has its own
post-transaction-return observation and physical key. Claimed attempts retain
their own key and attempt identity; ordered dispatch also retains the actual
publication key. Terminal outcomes distinguish cancellation, expiry, decoding
failure and admission refusal. Attempt settlement precedes durable release and
must not be presented as a release certificate. Production timing-off configuration
omits these optional sinks before constructing their details. Held-work and
failure tests validate the boundaries; only a hosted capture can attribute the
remaining delay. No queue scheduling, concurrency or retry policy changes are
selected by this instrumentation alone.

The timing slice also reaches the shared browser dependency graph. Publication
validation measured headless Brotli output at 354.092 KiB against a 354 KiB budget
and the browser entry at 265.353 KiB against 265 KiB. A controlled pre-instrumentation
source overlay measured 353.446 KiB and 264.829 KiB respectively; this attributes
the added cost but is not a comparison against main. Moving event translation to
the server owner leaves one optional source-facts port in shared code and measures
354.084 KiB headless / 265.338 KiB browser. Keep that direct ownership boundary;
a compact callback/tuple experiment made both size and comprehension worse.
Explicitly adjust the two affected budgets to 355 KiB / 266 KiB, retaining the
measured cost and all other bundle constraints. This limited diagnostic cost
acceptance does not waive runtime throughput or formation-tail gates. Preserve
the phase-timing contract while extending its tests for the new committed-output
observation. Browser/headless bundle checks and independent review are required
before hosted measurement.

The control journal again reports the post-terminal 100,000-node certification
limit, distinct from native workload success. It also records 47 snapshot flushes,
with a maximum 2.76621 s wall duration (0.305 s serialization, 2.461 s writing).
This is a measured control-harness cost, not proof of ALM causation. Retain the
large-result certification and snapshot allocation/I/O follow-ups.

## Unresolved comparative acceptance

The fresh corrected-harness comparison is valid but still fails hot throughput:
24.675951 → 23.416662 mutations/s (-5.103%). Both roles use the same corrected
harness; every A-B-B-A position and all eighteen samples per role are retained.
Uncontended p99 is 0.170083 → 0.169386 s; shared throughput is 89.9957 →
89.9159 mutations/s. Neither fails its gate. Hot p99 is 3.917735 → 3.922594 s;
median per-run transaction wall-duration sum is 168.573 → 168.266 s. The earlier
and corrected-harness results below are separate datasets and must not be pooled.

Most of the new hot loss is in candidate position three: 22.139 mutations/s,
compared with 24.851 in candidate position two and 25.014/24.347 in the two main
positions. Two commands in that third position reach ten attempts, with 15.881
and 15.442 s of recorded retry delay inside 16.551 and 16.330 s command latency.
Total conflict counts, process SQL and CPU do not establish why retries were
deeper there. The unchanged exercised production path constrains causal theories;
it does not explain the observation or waive the failed gate. Inspect current
command/kind completion and pump cleanup on a common timeline before selecting
additional instrumentation or a retry-policy change. Keep all samples.

The earlier local comparison and prescribed hosted A-B-B-A comparison failed
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

The corrected-endpoint diagnostic reconciles all twelve phases, 9,600 operations
and 11,986 attempts. Its measured hot phase walls are 23.722–26.233 s, with only
0.007737–0.009891 s of total startup, between-kind and final external gaps. Retry
chains are on several kinds' completion paths. It does not reproduce the failed
comparison's 30–39 s third-position phases or ten-attempt commands, so it cannot
explain or waive that failure. Exact pump/SQL ownership remains uncaptured. The
workload's topology choice uses wall-clock parity and retry jitter is random;
identical command counts do not prove identical sampled inputs. Retain those
repeatability limits and select further instrumentation only for a concrete
unresolved attribution, rather than rerunning for a favorable result.

Retained hot samples recover all 25,200 command retry depths and 3,600 applied
topology configurations. Tree counts per position are 446 / 429 / 463 / 447;
the third position alone has two ten-attempt commands, but its 55 commands at
depth nine or above are close to the fourth position’s 54. Tree share does not
order the slowest samples. Effective input mix therefore needs no new capture.
Exact submitted-input selection clocks and absolute retry due/release instants
remain uncaptured; a future targeted capture should separate prescribed backoff
from actual scheduling at the existing telemetry owner. Current retry due-age
telemetry cannot supply that distinction: normal PostgreSQL reservation clears
the due timestamp before the handler computes it, so the handler can fall back to
the new claim time. Do not interpret that value as actual retry scheduling lateness.
These associations do not establish causation or waive the failed gate.

The follow-up design review locates the loss at the reservation result boundary;
existing downstream observers cannot reconstruct it. Any later opt-in capture
must preserve the actual old due time and incremented attempt without changing
claim order, retry policy or existing diagnostic meanings. A nested transaction
return is not proof of outer commit, and optional diagnostic association failures
must never strand successfully reserved work. Require explicit root-transaction
ownership, signed same-database timing with documented precision/timezone, and
honest unavailable values for backends without that observation before selecting
this repair. Keep this a bounded attribution follow-up while formation-tail
measurement remains first.

## Next two useful slices

1. **Remaining formation-tail delivery.** Same-source captures show nearly all
   of the 4.343 / 5.963 s pre-reservation waits overlapping active owner batches.
   The slow stages vary: authority reads in one capture, release processing with
   a 1.650 s process-wide timer delay in the other. Use existing CPU/GC profiling
   and real-owner fixtures to distinguish shared-process stalls from repeated
   database work before selecting the focused TDD repair. Preserve immutable
   events/audiences, causal fences, retries, deadlines, release recovery and
   ordered sends. Keep timing overhead, physical commit, queue eligibility and
   browser-causality limits explicit; every hosted diagnostic retains fresh
   preflight and exact timing-off restoration with settings verification.
2. **State-write command completion.** The demonstrated harness wait is repaired
   and independently reviewed; the fresh governed comparison uses that corrected
   harness on both roles. Retain every owned drain, failure and phase cost, and
   keep its failed hot-throughput result visible. Investigate the third position’s
   deeper retries, actual command/kind endpoints and joined pump tail before
   claiming comparative acceptance. Retry-depth causation and raw timing-array
   allocation remain unresolved outcomes, not speculative policy changes.

### Task 4: Separate command completion from owned pump cleanup

The requested outcome remains accurate command latency and a trustworthy
main-versus-candidate comparison. The actual helper waits for its current dequeue
and timer after the service result is available. Profile-instance also waits for
that cleanup between its two service calls. The complete diagnostic exposes these
gaps; it does not prove their share of the failed comparison.

- At the existing workload owner, retain one pump per measured command across its
  complete service sequence. Await each actual service result directly; profile
  success must precede instance submission. Record the command endpoint when that
  sequence settles, then join its pump before releasing its concurrency slot.
  Keep phase timing and SQL/CPU accounting open through all owned cleanup.
- Reuse the existing `settleAll` failure-preserving join after verifying identical
  availability on the comparison base. Keep one canonical pump implementation and
  migrate all seed consumers; do not retain a legacy setup adapter. Recheck settled
  state after dequeue before scheduling another timer. Join any timer already
  started. Do not detach work, race away from it, increase concurrency, or introduce
  a background scheduler or new production cancellation policy.
- Distinguish a failed service sequence from a later pump failure. A successful
  command boundary remains factual if its pump later fails, but the workload and
  phase must fail. Preserve sole errors by identity and multiple errors in observed
  order; join started siblings before outward failure. Existing service wait
  horizons and external hosted termination remain the bounds for stopped progress.
  Uncancellable hung SQL has no new in-process deadline or guaranteed cleanup.
- Use held-dequeue RED tests for an early command boundary with pending cleanup,
  profile-to-instance progress, slot/kind admission only after cleanup, no extra
  pump work after completion, and service/pump failures in both orders. Verify
  seed joining, delayed release evidence retention and the existing host interrupt
  contract. Do not weaken deadlines or assert incidental private call topology.
- Expected owners are the workload, its seed consumers, focused workload tests
  and perf README. Review and remediate every changed human-authored file in full;
  support files changed by that remediation enter closure recursively; independent
  untouched code remains outside closure. Inspect existing patterns before edits.
- Direct validation: focused workload completion/failure tests plus `settleAll`
  and affected diagnostic suites. Application validation: native Deno check of
  the API-v1 state-write benchmark and affected style/type checks. Independent
  spec/quality review precedes publication. The controller owns broader validation
  and any fresh governed comparison.
- Preserve canonical v6 and diagnostic v2 layout and documented metric meaning.
  Document command completion versus slot/phase cleanup. A fresh comparison must
  apply the same candidate perf-directory overlay to both roles and native-check
  both; never mix historical and corrected-harness samples. This is a harness
  repair, not a production speedup or waiver of the existing failed comparison.

### Task 5: Observe promotion-to-browser delivery without changing runtime behavior

The existing post-commit `group-topology-publication/promote` marker is filtered
out of optional local API timing capture. Existing native browser layout events
already expose adoption. Retain the missing safe anchor before adding new runtime
instrumentation or changing publication semantics.

- Extend the existing optional timing projection with a closed promotion shape.
  Require exact component/operation, nonnegative finite timing fields, complete
  valid group scope, a known outcome and valid expected/planned layout identities.
  Reuse canonical layout identity validation/types; decode the producer's exact
  label grammar at this log translation boundary. Treat `none` explicitly and
  require an actual planned identity for successful promotion.
- Match `promoted-newer` to the actual planned identity. Do not broaden the generic
  identity grammar for canonical JSON request IDs. This fixed unique-group run can
  omit requestId and require uniqueness of scoped planned identity in analysis.
  Strip arbitrary payloads, headers, errors and unknown detail fields. Preserve
  current record/file limits, rejection accounting and truthful partial summaries.
- Write RED/GREEN tests using actual production-shaped promotion records, including
  promoted-newer and a long JSON requestId. Exercise the spawned capture process;
  verify exact safe fields, retained counts, malformed/missing identity and unknown
  outcome rejection, sensitive-field exclusion and no weakening of existing capture
  failure/cleanup tests. Keep existing commit-before-event owner tests as evidence.
- Expected changed owners are `to-safe-api-timing-record.ts` and the focused
  full-stack timing capture tests. A colocated decoder is appropriate only if it
  improves direct ownership; no new telemetry subsystem or generic parser.
  Review and remediate every changed human-authored file in full, include every
  support file changed by remediation recursively, and leave independent untouched
  code outside closure. Direct validation is the spawned-capture semantic suite;
  application validation is the affected black-box script/app typecheck and style
  checks. An independent review precedes measurement/publication.
- The controller runs diagnostic local 15/30/50 with WS observations enabled in
  fresh directories, unchanged manifests, memory backend, native retention,
  predicates and deadlines. For the final cohort identity require exactly one
  successful scoped marker and first acceptance plus matching causal state for
  every independently enumerated assigned agent. Missing or ambiguous joins fail
  analysis; early promotions need not have the final cohort audience.
- Report marker-to-adoption and estimated attempt-start-to-adoption intervals in
  seconds with clock/rounding uncertainty. Call the latter a conservative upper
  bound only with justified total uncertainty, including the synchronous gap
  between duration and epoch sampling; near-threshold unresolved bounds require
  a better anchor, not an invented allowance. The marker follows transaction return
  and queue wake; it is not the physical commit instant. Same-host placement and
  millisecond timestamps do not establish remote clock synchronization. Preserve
  partial API-stream status, and distinguish complete selected endpoint coverage
  from complete server telemetry. Browser adoption may follow a delta or refresh;
  do not claim exact wire receipt or every intermediate span.
- Later RTC link establishment and recipe readiness are separate intervals. In
  the retained 50-agent cohort acceptance-to-ready is 6.936–7.082 s, while the
  readiness command itself is only 0.021–0.094 s. Investigate actual link/native
  scheduling before blaming its polling interval. The original ≤2 s delivery
  target and hosted acceptance are not waived by this diagnostic repair.

### Task 6: Preserve the store during hosted diagnostic preparation

The requested outcome remains a measured current hosted formation-delivery
interval. Before this repair, workflow timing changes invoked a normal controller
rollout that dropped and recreated PostgreSQL. The preserving repair and its
review fixes are implemented and tested at the existing owner; do not run a destructive diagnostic or add another workflow, timing lease,
topology bypass or duplicate deployment path.

- Replace ordinary rollout's reset with validated existing-store migration using
  the existing migration command. Preserve database identity, role, credentials,
  auth/operator secrets, memberships and unrelated durable rows. Validate the
  effective configuration before rewriting it, including secret-file precedence.
  Missing or malformed existing-store configuration must fail before replacement
  or destructive effects. Initial absent-store provisioning is a separate existing
  entry case; retain it only where a verified caller requires it, without erasing
  an existing store. Remove the affected automatic reset path and migrate its
  verified consumers rather than retaining a legacy adapter.
- Keep services stopped during migration, the existing failure sentinel and API
  start fence, exact source/topology/timing application, health checks and readiness
  publication. A failed migration must not restart the API or claim readiness.
  Do not replace established operations with a second lifecycle mechanism.
- Use RED/GREEN shell-boundary tests for preservation, configuration rejection,
  migration failure and service ordering. Run an isolated real PostgreSQL test
  with preexisting auth/group/sentinel data through repeated preserve-store
  operations and verify exact durable readback. Command-string absence alone is
  insufficient. Use existing test fixtures and clean up only owned test resources.
- Expected owners are the controller profile, ordinary rollout/deploy callers,
  focused Hetzner tests and operational documentation. Review/remediate every
  changed human-authored file in full; modified support files enter closure
  recursively; independent untouched code remains outside closure. Direct
  validation is the populated-store retention/failure test; affected application
  validation is controller shell syntax and focused deployment/workflow tests,
  plus test typing and required style/governance checks for changed guidance.
- Independently review before publication or remote use. The controller then
  verifies the actual deployed source/schema, migration history, current timing
  and topology, auth continuity, idle services and runner capacity. Run one
  unchanged native50 hosted diagnostic in a fresh explicit group with timing on,
  retain journals and match promotion to its exact notification on the same
  server clock. Preserve partial/capped-journal limits and do not subtract remote
  browser clocks without bounds. Restore prior timing/topology through the same
  reviewed non-reset path even after failure, and verify health/data continuity.
  Any pending destructive migration or failed preservation proof blocks dispatch.

The parent plan retains large-result certification, the post-terminal headless
shutdown race, test-harness scheduling sensitivity, the shared-mechanism audit
and all original V1c benefit gates. Native acceptance and complete diagnostics
close none of those independent outcomes.

### Task 7: Use the existing operator workflow for read-only preflight and restoration

The preserving rollout alone does not make the diagnostic executable from the
available GitHub operator channel. Existing status actions change remote files,
and deploy inputs cannot restore topology. Unless an existing supported SSH
channel supplies these operations, complete the narrow workflow prerequisite.

- Extend the existing deploy workflow with an explicit read-only inspect action;
  retain rollout as its default. Stream a reviewed, sanitized probe through its
  existing SSH connection. Inspect must not copy remote scripts, sync secrets,
  write environment files, mutate services or run rollout. Reuse the effective
  configuration reader and existing status owner. A dependency-free shared reader
  may be sourced by normal scripts and streamed before the inspect entry, so the
  probe does not trust an older remote helper. No duplicate parser, deployment
  lifecycle, timing lease or snapshot subsystem.
- Retain only allowlisted nonsecret evidence: actual source/schema/migration
  identity, presence and values of both timing and four topology keys, failure
  fence, service/job/activity state, health and database/table/role continuity
  markers with aggregate auth/group counts. Never print credentials, environment
  contents, raw identities, user data, command arguments or unrelated logs.
  Query failures or missing required evidence must remain failures. Extend that
  explicit projection to the persisted public operator inputs needed for restore:
  SPA/control/API URLs, API/control CORS, default room, agent prefix/count and
  application/workspace. Read only named values through the shared reader, validate
  their public shape and report presence/origin; never dump their environment file.
  Verify agreement between representations of the same effective setting. Restore
  from actual live values rather than an unverified historical dispatch. Caddy and
  browser-install flags are transient execution choices; use the existing safe
  restoration choices and verify prior service health rather than inventing a
  historical-input requirement for them.
- Add explicit timing and optional topology inputs to the existing rollout path.
  Ordinary callers preserve topology by default. Explicit restoration distinguishes
  an absent key from a positive integer. Pass values to the established writer;
  no second configuration owner. Use the same reviewed full source revision for
  diagnostic and restoration, and retain other nondefault operational settings.
- First require the observed prior timing pair to be exactly present 0/false,
  which the existing boolean writer can restore. A mixed or absent pair blocks
  dispatch until its actual restoration requirement is addressed; do not silently
  normalize it. Compare actual deployed migration history to proposed source
  before any rollout and resolve pending/destructive migrations separately.
- Use TDD with executed shell/workflow boundaries for inspect non-mutation,
  secret exclusion, effective precedence/error handling, default topology
  preservation and explicit absent/set round trips. Inspect all changed files in
  full, include recursively modified support files, and leave independent untouched
  code outside closure. Validate shell/workflow syntax, focused operator tests and
  affected test typing; independently review before publication or remote use.
- Run inspect before and after the one unchanged hosted diagnostic and restoration.
  Preserve its output, journal limits and source identity. Check for other operator
  activity immediately before dispatch; a past workflow list is not a service
  lock. Restoration is required even if recipe or artifact acquisition fails.

The operator prerequisite is implemented locally: the existing deploy workflow
streams a read-only inspect probe and accepts explicit restoration inputs. Ten
validated public settings supplement timing/topology and continuity evidence.
Focused validation passes 92 tests and eleven actual lifecycle scenarios;
independent review found and verified fixes for two restoration gaps: an omitted
operator-token lifetime was reset, and matching CORS lists without the SPA origin
were normalized. Both have semantic RED/GREEN coverage; 37 affected tests and
eleven lifecycle scenarios pass after the fixes. Local spec and quality review
approve the prerequisite. The subsequent published CI passed all required checks,
including the two repaired static/tooling failures.
The first read-only live inspect failed at database projection: PostgreSQL emits
OID values as JSON strings, while the strict output contract requires numbers.
Explicit SQL casts now produce numeric OIDs, with real PostgreSQL RED/GREEN
coverage and unchanged strict validation. Integration review also proved that
the preceding optional TURN-secret sync replaced unrelated effective settings
before rollout validation. Its existing writer now preserves those settings, with
actual sync through preflight and rollout coverage; 45 focused tests and twelve
lifecycle scenarios pass. The newly touched manual prompt also has a corrected
output-channel defect and eight passing focused tests. Independent integration
review approves the corrected source. The failed inspect skipped every mutating
step; no hosted diagnostic or restoration
has run through this path yet.

The corrected live inspect passes. Deployed source is clean; proposed schema and
all 25 source/applied migrations match, with no failed migration. Services are
healthy and idle, timing is exactly present 0/false, and only mesh-min51 is set
among topology overrides. Database, role and table identities and aggregate
counts are retained for continuity. GitHub masks portions of two public settings
in the log; preserve those actual values at the existing controller writer rather
than guessing or bypassing masking to reconstruct restoration inputs. Complete
that existing-owner route before the diagnostic and recheck live activity.

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

### Preserve live public settings during diagnostic rollout

Add an opt-in mode at the existing rollout owner that reads and validates the ten
persisted public settings before defaults or mutation, then uses those values
through the existing writers. Share the current inspect validator rather than
duplicating it. Existing deploy and diagnostic prepare callers explicitly forward
the mode; ordinary callers retain their current behavior. GitHub Free already
uses all 25 manual inputs, so its existing rollout choice gains an explicit
preserve-public-settings option while retaining true/false values and the true
default. Deploy and reusable callers retain their preservation boolean. Tests
must check the platform input limit and evaluate the actual boolean bindings. Timing and topology
remain explicit. Test actual preservation under conflicting defaults and rejection
of missing or inconsistent settings before checkout or service changes. This keeps
restoration independent of GitHub log masking, without reconstructing masked values
or introducing a settings snapshot or another deployment lifecycle. Preflight
refusal must also prevent later workflow cleanup from stopping pre-existing
workers; cleanup remains required after this operation begins its worker lifecycle.
The existing
inspect output also retains an opaque fingerprint of the validated canonical
public-settings projection, so pre/post equality can be verified even when GitHub
masks values. No unmasked values or reversible encoding are exposed.

The preservation mode and fingerprint pass 306 affected tests, including twenty
actual controller lifecycle scenarios. Full workflow review found a later cleanup
step that could stop pre-existing workers after preflight refusal. A semantic RED
reproduced that failure; cleanup now requires operation-owned worker lifecycle
evidence and still runs after later start/recipe failures. Eleven focused cases,
205 affected workflow/disposition checks, canonical test typing and changed-range
style pass. Independent scoped review approves the correction. The live fingerprint roundtrip subsequently passed; current hosted formation
measurement remains pending.

The initial GitHub Free publication exceeded the platform’s 25-input limit and
was rejected before jobs started. The existing rollout choice now carries the
preserving mode, with every original input retained. Executed expression/planner
tests cover all three choices, actual boolean forwarding and unchanged false
topology refusal. Forty-nine affected workflow tests, 127 registry tests, typing,
changed-range style and syntax pass; scoped review approves the correction. The
failed publication remains recorded. GitHub accepted the corrected workflow;
preserving preparation succeeded, but all seventeen agent shards rejected HTTP
409 registration responses before workers started. Readiness ended with zero of
fifty agents connected and no recipe started; operation artifacts and journals
are retained. This invalidates the assumption that the registration consumer
already supports persisted users. A real AppInbox duplicate registration, serialized
by the existing API route, reproduces the rejected canonical response. The consumer
now uses the shared strict decoder and narrowly recognized duplicate-user semantics,
while rejecting unrelated conflicts and malformed responses. Registration stays
on and the database is preserved. Producer-backed shell tests, 49 affected tests,
test typing and independent review pass. The deleted live response body from the
failed attempt remains unverified.
Mandatory timing-off restoration succeeded after the failed attempt. Fresh
inspection matches the prior public-settings fingerprint, exact timing/topology,
database/role/table identities, all migrations and aggregate row counts; services
are healthy and idle on the reviewed source. These aggregate checks alone do not
prove individual login continuity. The subsequent corrected hosted diagnostic
also succeeds through all seventeen registration shards and fifty existing-user
logins, and passes native formation correctness. Its restoration and inspection
also pass; the current formation measurement above remains the next repair target.

### Task 9: Attribute the measured hosted outbox publication delay

The requested outcome remains a faster, scalable and fault-tolerant formation
path. The current hosted run establishes one 5.428 s promotion-to-send interval:
5.424 s before publication and 0.004 s after it. A single-work summary-write return
marker at +0.164 s leaves 5.260 s that the existing telemetry cannot split. The
exact target key appears only at publish/send. Do not select new concurrency,
batching, retry or queue policy from this unsplit interval.

Use the performance-analysis, code-writing, realtime/platform and testing skills
at the existing owners. First recover the actual committed summary output,
outbox claim return, admission boundaries, ordered dispatch and bridge publish
call. Add the smallest optional identity-only timing needed to correlate those
boundaries for this same outbox entry. Reuse the current timing/observation
mechanism, canonical queue-key translation and process identity; do not introduce
a second observer, scheduler, retained timeline or copied key parser. Preserve
all outputs of coalesced work and their own causal identities; never attribute a
primary work item's marker to an unobserved sibling.

- A committed-output marker must follow a successful transaction return and
  identify each actual output; summary-changed, rollback and failed writes must
  not claim commitment. If an existing outcome marker can be extended truthfully,
  prefer it. Keep physical commit time distinct from post-return observation.
- Queue markers must state the actual boundary they observe: reservation return,
  admission start/end, ordered dispatch start, and publish start/end only where
  existing evidence does not already provide the endpoint. Retries, duplicate
  attempts, cancellation, rejection and zero-recipient results remain distinguishable.
  Establish the minimal sufficient set from the current call path before editing.
- Keep timing opt-in and bounded by the existing capture/export limits. Record
  only already-permitted scope/key/process identity, stage, outcome and clocks;
  no event payload, auth material, invented IDs or new public/persisted contract.
  Disabled timing must not add storage reads, waits or retained collections.
- TDD must execute the real affected owner boundaries: held work proves marker
  ordering, failure/summary-changed proves no false commitment, coalesced work
  preserves each output identity, and disabled timing leaves effects unchanged.
  Use existing fixtures and ports; do not create a parallel miniature engine or
  tests that merely assert log source strings.
- Review and remediate every changed human-authored file in full. Every support
  file modified by that remediation enters closure recursively; independent
  untouched code remains outside closure. Remove affected unneeded legacy.
- Direct validation is the focused owner tests proving these temporal and failure
  semantics. Affected validation is the shared package/API typecheck and canonical
  test typing selected by rallar-testing. Run focused tests before broader checks,
  then independent spec/quality review. Do not rerun unchanged broad suites or a
  performance comparison merely to obtain a favorable result.

After publication and appropriate CI, the parent performs one unchanged native
fifty-agent timing-enabled diagnostic with preserved settings and fresh group,
exports its evidence, restores timing off on that exact source and verifies the
baseline. Report the new stage intervals in seconds and choose a TDD repair only
for the measured dominant interval. The failed hot-throughput comparison and
full ≤2 s formation target remain open.

### Task 10: Reproduce outbound progress and split grouped admission cost

The outcome remains a quicker, responsive and fault-tolerant formation path.
The latest stage capture exposes committed-output-to-reservation gaps up to
11.711 s and a separate 1.426 s grouped admission window. The current observations
cannot assign the first gap to wake, owner occupancy, readiness, claim storage,
or diagnostic overhead. Preserve this uncertainty rather than changing queue
policy from a symptom.

Use the existing real middleware queue-wake fixture and AL work-handler external
wake coverage first. Recover their actual behavior and reuse or extend the
smallest missing scenario. Put a matching externally committed WS_OUTBOX row
behind a controlled in-flight batch. Waiting while the configured single owner
is occupied is intended. Verify that after the batch settles, the remembered
wake invalidates readiness and permits the due row to progress without stale
idle backoff. Test cancellation/failure only where those boundaries are affected.
Do not create duplicate coverage or assert immediate claim while capacity is full.
A passing test refutes that failure hypothesis; it does not justify a scheduler
change. If a failure reproduces, retain RED, repair the existing owner with the
smallest behavior-preserving change, and prove GREEN and failure recovery.

Then reuse the existing grouped outbound production owner and commit-phase
observations against an isolated local real PostgreSQL database. Read the shared
performance-harness guidance before creating any probe. The existing statement
fixture uses PGlite and proves 47 autocommit / 74 transactional statements for ten
rows; those counts are not a real-PostgreSQL latency baseline. Prefer existing
fixtures, SQL/activity samplers and diagnostic ports over a new retained harness.
Measure representative page occupancy, actual statement counts, decision reads,
transaction wall time and claim/batch timing where already available. Use repeated
runs and explicitly label injected waits and unmeasured pool/lock/CPU costs.
Generated evidence belongs under tmp/perf; do not use or reset the hosted store.

The first measurement question is whether a post-capacity wake is lost or late;
the second is which existing admission phase accounts for the observed local
cost. Keep admission cost secondary to the long pre-reservation gap. Local
results do not assign a hosted cause or establish the full formation target.
If neither path reproduces a repairable problem, report the falsified hypotheses
and specify the minimum existing owner observation needed for a next capture;
do not implement speculative concurrency, page-size, retry, deadline, SQL or
pool changes. Any subsequently selected optimization needs direct correctness
validation and a repeated before/after measurement at its actual owner.

Review and remediate every changed human-authored file in full. Any support file
modified by remediation enters closure recursively; independent untouched code
remains outside closure. Reuse existing patterns and remove affected unneeded
legacy without creating compatibility adapters. Direct validation is the focused
wake/progress or admission-owner tests; affected validation is the changed
shared/shared-server/API typecheck as selected by rallar-testing. Run the exact
main-to-head changed-style gate before publication, plus meaningful full-file
human review. Keep all existing protocol, immutable audience, causal-fence,
ordering, claim, retry, deadline and fault-tolerance contracts intact.

### Task 11: Attribute prior outbound batch execution cost

The requested outcome remains faster formation delivery with scalable, responsive,
fault-tolerant queue handling. The retained same-process interval unions localize
84.6% and 91.3% of the two long pre-reservation gaps to earlier batch processing
envelopes. Grouped commit accounts for 4.988 / 3.210 s, and ordered dispatch through
settlement for 3.233 / 2.134 s. These are observed envelopes, not continuous CPU,
SQL or causal queue-blocking proof. The occupied-owner wake test passes unchanged
production. A further generic wake trace alone would not explain the majority.

Use one coherent opt-in observation slice at existing outbound owners. Reuse
existing diagnostics, source-facts ports, timing sinks and tests. Do not introduce
a generic observer, scheduler, public batch identifier, retained per-row collection,
SQL tracing framework, queue policy change or new dependency.

- Retain one completed-work-batch observation from the existing work-handler
  diagnostic through the optional server timing path. Preserve measured selection,
  claim, execution, release and queue-wait durations, actual counts and existing
  owner identity. Recover exact semantics before naming fields. Snapshot claim
  duration immediately after the claim returns, before optional per-row logging;
  logging must not masquerade as storage claim duration. A failed claim must not
  emit a successful completed batch; empty claims must remain truthful. Join
  batches to existing attempt observations unambiguously using existing owner and
  source-time facts, with a focused concurrent-owner fixture if required. Do not
  subtract database claim stamps from API-process clocks. Do not add row-ID or
  lock instrumentation: selection fairness is not the selected hypothesis.
- Split the already-observed grouped admission window at its actual owner into
  decision-read work and bundle commit work, using existing commit-phase/store
  diagnostics. Observe each actual grouped operation once; never sum repeated
  per-member group durations or overlapping global read counters. If the existing
  store boundary can distinguish bundle observations from its transaction without
  another callback framework, retain that distinction. Otherwise name the bundle
  window honestly and keep transaction/pool/lock cost explicitly uncaptured.
  Preserve fallback, sender ordering and all joined reads. Use existing keys or
  owner context to associate the group with the claimed batch; no synthetic
  post-call evidence may be called a transaction receipt.
- At the existing server publication bridge, separate captured-publication-policy
  read from synchronous local send/deferred-target bookkeeping within the already
  measured publish-return-to-direct-send interval. Prefer one bounded additional
  source observation or existing diagnostic per actual publication. Reuse the
  actual physical/publication identity and captured audience. A policy refusal,
  expiry or failure must remain its real outcome; timing cannot turn it into
  success. Do not change send order, audience, retry, deadline or cancellation.

This scope deliberately covers the already measured major stages in one slice;
repeating the hosted workload merely to reconfirm that prior batch execution
consumes time would not answer the remaining attribution question. Existing
readiness and generic wake observations remain deferred unless the uncovered
remainder becomes the dominant measured cost. No performance optimization is
selected until these owner observations support it.

Use TDD at existing fixtures: independently held claim and run boundaries;
held group decision read and bundle transaction with multi-member one-group
accounting and fallback; held captured-policy read versus local send; empty,
failed and cancelled paths relevant to each changed boundary. Prove disabled
actual API composition omits new sinks/detail construction/read work, and throwing
enabled diagnostics cannot change a batch result, strand a claim or skip cleanup.
Retain the passing occupied-owner regression rather than duplicating it. No
per-member log multiplication or eager allocation is acceptable when timing is off.

Before source edits, recover nearby code/tests/examples and load code-standard,
platform, realtime, testing and performance skills plus required references.
Review and remediate each changed human-authored file completely. Any support
file modified by remediation enters closure recursively; independent untouched
code remains outside closure. Keep direct ownership and remove affected unneeded
legacy. Focused diagnostic/owner behavior tests are the direct validation;
affected shared/shared-server/API typechecks are the integration validation.
Run formatting, the exact main-to-head changed-style gate, and browser/headless
bundle checks without silently raising the existing 266 / 355 KiB budgets.
Report estimated event cardinality from real fixture observations, actual bundle
delta, RED/GREEN evidence and every uncaptured metric. Generated artifacts stay
under tmp/perf; source implementation performs no hosted operation.

After source review and selected CI, the parent runs the unchanged native workload
with fresh read-only baseline and exact timing-off/settings restoration. Retain a
matched timing-disabled workload before attributing diagnostic-stage cost to
production or claiming improvement. Preserve all failed comparisons and their
original gates; no favorable rerun, workload reduction or threshold waiver.

### Task 12: Profile the actual API formation workload

The intended outcome remains a measured, test-first formation-tail repair. The
new same-process evidence records a 1.650 s timer delay inside the 2.660 s release
window; it does not isolate release SQL. First use existing runtime profilers to
locate CPU/GC-heavy work in a real API workload, without adding a production
observer or changing scheduling, concurrency, retry, audience or release policy.

Run one bounded local actual-API + isolated real-PostgreSQL + native-fifty capture,
using the unchanged canonical fifty-agent, thirty-second manifest and mesh minimum
fifty-one. Preserve all fifty independently registered browser agents, one director
and forty-nine players, all 231 native assertions, existing deadlines and complete
terminal/export handling. Reuse the existing PostgreSQL API launch semantics,
control server, headless worker, no-spawn distributed runner and artifact analyzer.
The existing native-fifty Playwright fixture requires memory mode and its timing
wrapper discards raw stderr; do not relabel it as a PostgreSQL profiling run.
Use a task-owned generated launch composition under tmp/perf, not a new checked-in
framework. Do not touch shared/hosted stores or run remote operations for this task.

Before the real workload, verify the local Deno version/flags, profile directory,
raw stdout/stderr retention and the chosen termination's ability to flush a
parseable nonempty CPU profile. Use native CPU profiling and bounded GC tracing
where supported, retaining actual process identity, command/config shape, time
bounds, source, manifests, resource environment and cleanup results without
printing credentials or environment-file contents. A failed flush is a failed
capture, not successful performance evidence. Preserve original artifacts and
failed attempts. Use an existing supported capture alternative only if the native
exit contract cannot be made reliable, explaining its overhead and limits.

The direct validation is the unchanged native workload, result-ID/correctness
reconciliation and profile-integrity check. The affected application validation
is the real API's PostgreSQL startup/health and actual browser/control integration;
if reusable source or test support must change, use focused TDD plus its concrete
package typecheck before accepting that change. This measurement task need not
invent a RED test or make an empty commit when no behavior changes. Any generated
human-authored support file follows the code standard: review and remediate every
changed file completely, recursively include support files changed by remediation,
and keep independent untouched code outside closure.

Report dominant sampled stacks, measured GC pauses, event-loop observations and
where their clocks can or cannot be aligned. Separate startup from workload when
actual boundaries permit it. Sampling counts are not wall-time proof, a CPU profile
can miss off-CPU contention, and local OS/runtime/browser colocation/store state
are not the hosted environment. If the first valid profile has a concrete hotspot,
repeat once with a fresh group only when needed to test its stability. If no pause
reproduces, report that honestly and select a concrete remaining measurement;
do not optimize a static SQL loop or continue blind reruns. Do not claim hosted
attribution, a speedup, full event retention or the formation target from a local
profile. Leave the failed state-write comparison unchanged.

Retain generated profiles, logs and raw artifacts under tmp/perf and remove only
task-owned processes/containers/volumes after evidence export. Produce a concise
finding with code locations, measured versus suspected claims, falsifying signals,
exact commands, passed/failed/skipped checks, and the next focused TDD repair or
measurement. No production source change or hosted profiling is selected here.
