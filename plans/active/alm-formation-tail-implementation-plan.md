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
from actual scheduling at the existing telemetry owner. These associations do
not establish causation or waive the failed gate.

## Next two useful slices

1. **Remaining formation-tail delivery.** The existing promotion marker and all
   local browser endpoints are now measured. Establish the current hosted
   promotion-to-send interval using existing same-server journals where possible.
   The store-preserving rollout prerequisite is implemented and reviewed, with
   actual lifecycle and PostgreSQL retention tests. Establish read-only remote
   preflight and exact settings restoration before dispatch; keep cross-host
   browser clock bounds explicit. The local policy probe does not justify an optimization. Add
   intermediate delta/claim/publish spans only if the observed delivery interval
   warrants them, then repair a positively located defect with TDD. Preserve
   every immutable event/audience, causal fence and fault outcome. Diagnostic
   local 15 → 30 → 50 uses the unchanged memory/headless workload; hosted
   timing-off acceptance remains separate.
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
now approve the prerequisite. Live preflight remains pending. The two published CI
failures have local fixes, but require verification on the next published head.
No hosted diagnostic or restoration has run through this path yet.

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
