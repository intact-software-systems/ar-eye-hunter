# ALM V1c Step 1 and Step 2 Implementation Plan

## Goal and ownership

Deliver the original 15/30/50-agent match-payload acceptance and prove the selected fairness
benefit. Add six- and eleven-browser diagnostic checkpoints to isolate smaller-cohort failures;
they do not replace any original acceptance or benefit gate. Implement [the V1c design](../../playground/alm/alm-v1c-design-proposal.md) and D183 in
[the ALM improvement plan](../../playground/alm/alm-improvement-plan.md). V1d remains an outcome
until both V1c steps are accepted and the user manually merges their pull requests.

Shared-test owns the composed workload, native evidence and group assertions. The black-box app
catalog owns participant and topology selection. Existing command runtimes, distributed operators,
receipt observers and safe exporters retain their respective execution and evidence boundaries.
Use the current repository owners, nearby tests and examples to recover each actual call path;
this plan is neither a substitute for source navigation nor a delivery ledger. No new dependencies,
runner, evaluator, generic diagnostic framework or duplicate policy engine are required.

The artifact-flush consolidation is merged as #674. The next increment prioritizes the
formation-tail delivery delay, with current-path measurement and a test-first repair at its owner.
The remaining shared-mechanism audit, full V1c acceptance and comparative evidence remain open.
Delivery of one consolidation does not make the full V1c outcome complete or waive its remaining gates.

The live pull request owns delivery state. Git history, immutable ignored evidence and the
pull request retain prior outcomes and review chronology; do not copy that history into this plan.

## Standing constraints for step 2 and the following slices

The maintainer set these on 2026-10-14 after merging step 1; they bind every remaining V1c slice
and V1d:

- Performance and scalability are the subject. Locate bottlenecks with the repository's
  `performance-analysis` skill (static audit → measurement plan → runtime validation → one change
  at a time) before selecting a repair. Problems exist in both Rallar production code and the
  black-box shared-test harness; both must be resolved, neither excuses the other.
  This is a standing requirement for the current and following slices: identify, measure,
  propose and validate repairs wherever the measured path crosses production or harness code.
  Label metrics with units; report durations in seconds (`s`), throughput in mutations/s,
  and sizes/counts explicitly. Preserve canonical artifact units and convert at the reporting
  boundary. Record unresolved findings and their next measurement; a passing workload does not erase a
  demonstrated performance problem.
- The queuebox engine (`packages/shared/queuebox`, the server AppInbox built on it and the browser
  IndexedDB engine) is the event-handling core. It must be quick, responsive, smooth and fault
  tolerant. Scale exposes intermittent faults, so fault tolerance (stale claims, lease expiry,
  duplicate delivery, retry exhaustion, breaker interaction, unbounded retention, wedged waits)
  is a first-class acceptance quality beside latency.
  Increasing scale must exercise recovery from intermittent failures as well as healthy
  throughput: prove bounded work, continued progress and correct eventual outcomes under
  faults, without losing events, weakening authority or hiding exhausted retries.
- The 15/30/50 recipes run locally first. The GitHub workflow `Run GitHub Free Distributed
  Recipe` is used only after a local pass; where it cannot carry a cohort, the plan states what
  is needed instead of adapting the workload.
- Static analysis names the slow parts with `path:line` evidence and a confidence label
  (proven, strong suspicion, needs measurement); a repair is selected only from a positively
  located defect with RED → GREEN coverage at its owned boundary.
- No legacy, no duplication, no migration code. Keep the repository consistent, use the repo
  skills and governance, and prefer an existing pattern (`Either`, `LatestRepository`, lane
  budgets, `RateLimiter`, the AppInbox doctrine) over a new one.
- Test-driven and sub-agent-driven development with distinct implementation and review seats.
- Added 2026-10-15 during step 2e: a generic mechanism (concurrency gate, rate limiter, backoff,
  timer seam, repeating sweep, trailing flush, serialized or single-flight chain, bounded buffer,
  coalescing claim) is written once as a `packages/shared` primitive with its own tests, and the
  business case composes it under its domain name; a purpose-named copy in a feature folder is
  duplication. The code standard now carries this rule (`repo-code-style.md`, "Reusable mechanisms
  over business-specific one-offs"). The V1c audit of such copies and its ranked candidates are
  listed under step 2e.

## Binding workload and acceptance

- Cohorts remain 15, 30 and 50, with one appointed director and N−1 players in the declared tree.
  Freeze the full participant, principal, session, role and receipt audience before traffic. A
  partially ready room cannot shrink that audience. Fifteen-agent acceptance must actually pass
  before thirty, and thirty before fifty.
- Each player sends six leader-ACK shot intents at five-second intervals, with nominal offsets
  0/5/10/15/20/25 seconds. ACK duration cannot add to the cadence. Join every scheduled branch and
  verify all six exact handles and sequences inside the original workload deadline. The director
  sends two all-recipient-ACK lifecycle events, with the end ordered after every player's workload
  completion. Preserve canonical AR Eye payloads, nested relay/game identities, match coherence
  and isolated room scope, including serialized arrival matches.
- Setup allowances grow with the cohort (maintainer ruling D280, from D218, D221 and D229): group requests and
  the ready-status read 8.75 / 12.5 / 17.5 s, the players' `rtc.connect` and connected barrier 54.75 / 64.5 /
  77.5 s and their RTC readiness 49.75 / 59.5 / 72.5 s at 15 / 30 / 50, with the 15-second coordinator start
  barrier, the 45-second recipe setup barriers and the 5 s allowance of every other HTTP request unchanged.
  The existing 65-second shots-complete declaration is
  clipped by its enclosing 30-second absolute workload/ACK window. The declared 330-second outer terminal
  allowance and existing 120-second hosted registration allowance are lifecycle bounds, not extensions of those
  inner deadlines. Preserve parent clipping, cancellation and truthful incomplete results. Late diagnostics cannot
  resurrect a failed window or end event.
- Delivery remains volatile, at-least-once, 30-second TTL and rtc-with-ws-fallback. Preserve routing,
  authority, generation/currentness, authentication, QoS, frozen audience, duplicate/count-once,
  receipt revision/CAS, retry, settlement and failure behavior. An intermediate subtree ACK is
  insufficient for a leader receipt; an ended RTC receipt need not resurrect after canonical
  carrier transfer, while the live owner must still meet its receipt contract.
- A shot receipt must be acknowledged with its exact appointed director as both expected and
  confirmed audience, zero unconfirmed recipients and coherent subject/session/control identity.
  Lifecycle receipts require the exact full player audience. Require type-targeted arrivals for
  every declared shot and both events at every player, plus all-participant workload completion.
  Data arrival, admission, a transport return, an outbox handoff or a generated receipt alone does
  not prove caller-visible acknowledgement.
- Sample for thirty seconds: seven readings per actor at five-second intervals. Every frozen actor
  must complete its sampler, with zero failures and cancellation false. Missing, duplicate,
  incomplete or cancelled evidence fails closed; a transient excess followed by zero still fails.
  Final stats do not replace samples. For fifteen, require all 15 recipe finals, 84 exact director
  shot arrivals, both lifecycle events, all 15 completion arrivals, 105 readings and the complete native
  coordinator predicate set evaluated and passed. Strengthened predicates must retain every original
  requirement; historical 73-predicate results remain bound to their original source. Larger cohorts retain all their declared assertions.
- At every sample, own admissions are at most 1,000; own bytes 4,194,304; counted oldest age
  300 s; own tracks 64; ordering snapshots 512; overloaded is false; congestion dropped is
  zero. Preserve the runtime-limit checks as well as those literal limits, role-scoped sources and
  exact controller attribution through nested command evidence. Absent metrics or duplicate sources
  cannot form a healthy result.
- After explicit setup/barrier/storage reset, AL admission storage and non-probe AL work storage
  remain zero. Explicitly exclude idle probes while still recording them. Require final traffic
  storage readback; sampled bounds or setup reset alone do not prove this requirement.
- Preserve canonical source manifests, isolated effective identities, original uninstrumented
  acceptance settings (on the hosted plane the server's timing logs and phase timing stay off, D279),
  complete native evidence retention and owned cleanup. Recorder counts, EOF,
  a zero worker exit or readable artifacts do not prove completed producers or accepted recipes.

## Fairness and unchanged benefit gates

The existing additive complete lane-budget callback remains the selected policy boundary. Generic
controller numeric defaults and unrelated queues/outboxes remain unchanged. The long-lived
`InboxQueueReader` owns the repository RateLimiter, pressure observation, cursor, cache, in-flight
refresh and fallback; do not move policy into a second scheduler or add an exact-count query.

Preserve one complete snapshot per dequeue invocation, finite safe-integer validation before claims
and reservation clamping to remaining quota. Preserve FINALIZATION → NEW → FAIRNESS → RETRY →
TIMEOUT, exact reservation/CAS, neutral NotReady, current delays and 20 processing attempts. The
APP_INBOX fallback reserves and services one per normal lane; two currently observed eligible
retries raise RETRY service to two only. Fixed bounded quotas remain the selected fallback if the
adaptive hypothesis fails its benefit gate.

Pressure remains a conservative advisory lower bound: one RETRY page of size two, rotating opaque
cursor, existing type/due/attempt/expiry checks, no aggregation of old pages and no inference of
absence from incomplete zero or missing nextTs. Keep the existing 1 s/one-admission RateLimiter
window, injected clock, at most one in-flight refresh and one-window cache age. Cold, stale, failed
or stalled reads return fallback promptly; dequeue cannot block on pressure or reset the limiter
per call. Preserve transaction/result authority, AppInbox outer redelivery and WS/AL ordering.

The four comparison arms remain original 1,000-per-lane, fixed one, adaptive RETRY one/two and fixed
RETRY two. Benefit requires an incremental improvement over fixed RETRY two at equal durable work,
not merely over fixed one. Retain cold/stale penalties and the original observations of durable
completion/order/attempts, NEW progress, reservations, pressure reads/concurrency and total backend
operations including polling across sustained, recurring, disappearing and partially hidden work.
Report a falsified adaptive hypothesis rather than substituting an easier outcome.

Mutation or concurrency changes retain the unweakened PostgreSQL medium-scale correctness gate and
governed state-write comparison: original workloads, dependencies, durable receipt/effect equality,
retry/exhaustion/atomicity checks, pinned fresh environments and comparison thresholds. The valid
earlier balanced 36-sample comparison remains a retained failure at a 5.40% shared-throughput regression against the
unchanged 5% allowance. No sample removal, threshold waiver or blind comparative retry is selected.
Preserve the current source-owned canonical bundle budgets, compression settings, dependency
boundaries and strict comparisons. Accepted bundle growth is not a runtime benefit.

## Step 1 baseline evidence and original open facts

These observations motivated the subsequent step 2 work. Later measured outcomes appear in the
delivered increments below; do not treat an earlier failed cohort as the current result. The
final evidence reconciliation must preserve workload provenance and the unwaived benefit gate.

- Original capture-off fifteen-agent acceptance fails after setup, RTC readiness and START.
  It sends 83 of 84 shots: 66 ACK observations pass, fifteen time out and two remain unfinished.
  Only 104 of 105 samples exist; all 1,144 retained sampled bounds pass, but none of the 231
  native predicates is judged. Thirty and fifty remain gated by an actual passing fifteen.
- Instrumented six- and eleven-browser diagnostics pass. A local instrumented fifteen also
  passes all 84 exact shot ACKs, both lifecycle observations, 105 samples, 1,155 sampled bounds
  and all 231 native predicates. Its positive chains use RTC and do not exercise the failed
  hosted WS receipt family. These supplemental results do not replace capture-off acceptance.
- The hosted WS diagnostic fails. Four failed shots have complete server ACK counts and new
  complete receipts whose send-work reservations begin at least 1.041–1.055 s after conservative
  inherited deadline bounds. Admission, dequeue and send have distinct identities; neutral holds
  can change eligibility. Continuous queue wait and incorrect selection are not established.
- The narrow hosted phase diagnostic fails. Three complete sixteen-claim pages take 0.510, 0.421
  and 0.186 s; serial callbacks occupy 72–89% of those intervals. Canonical lookup accounts for
  4–7% of monotonic callback cost. Admission/dequeue callback remainder is unpartitioned.
  API capture is partial without a phase summary. Native recorder/export bytes match, but the
  export contains 577 runtime events absent from the control snapshot; complete producer parity
  is unproved. Final storage and native predicates remain unevaluated. These positive costs
  justify a narrower measurement, not a production repair or instrumentation-overhead claim.
- The valid balanced 36-sample PostgreSQL comparison fails: shared throughput regresses 5.40%
  against the unchanged 5% allowance. Conditional IndexedDB operation savings do not establish
  PostgreSQL latency, native benefit or a universally optimal lane policy.
- An isolated native setup observation locates a completion-polling contribution. Two terminal
  transactions commit before the original client request rejects, but terminal status is first
  observed 1.098 and 0.851 s later. Adding the requested delay to the recorded retry epoch places
  nominal poll horizons 1.095 and 0.847 s after those commits; actual timer start and expiry are
  uncaptured. These positive chains justify testing a local committed-result wake;
  they do not identify the earlier queue delay, actual timer expiry, database cost or server
  response path. Rejected and malformed observations prohibit absence conclusions. The diagnostic
  preserves the original allowances and cohorts, but its observation overhead differs from the
  required release run; it does not establish native acceptance or a production repair.
- Source review identifies stopped browser cleanup renewing recurring timers and retaining
  old generation closures. Owned stopping must cancel normal pending timers and prevent
  re-arm; unsupported in-flight database work may finish. Its contribution to hosted heap
  growth or workload failures remains unmeasured. Preserve failed workload evidence and
  measurement limits; do not repeat an unchanged workload or revive the inconclusive guard probe.

## Next two useful slices

1. **Remaining formation-tail delivery:** bounded admission reads and native scale
   acceptance remain passing, but the full ≤2 s target is open. The occupied-owner
   wake fixture passes unchanged production, and the warmed local PostgreSQL owner
   probe does not reproduce hosted cost. Preserve the earlier 11.711 / 6.804 s
   pre-reservation observations and their limits in the focused formation plan.
   The latest fixed-source OFF–ON–ON–OFF native-fifty sequence passes all four
   workflows. Its timing-on captures place 4.341 / 5.962 s of the all-cohort
   promotion's 4.343 / 5.963 s pre-reservation waits inside active same-worker
   batch envelopes; own-output-to-local-send is 4.418 / 6.239 s. Retain all earlier
   promotions and distinct activation outputs; browser causal matches do not
   prove notification-to-adoption causality.
   Different stages dominate: a 1.134 s authority-read union in one preceding
   batch, and a 2.660 s release interval in another. Existing API samples expose
   a 1.650 s process-wide timer delay during that release. Profile the actual
   process with existing CPU/GC facilities before attributing this to sequential
   PostgreSQL release statements or selecting the focused TDD repair. One local
   actual-API/real-PostgreSQL/native-fifty profile passes all 50 recipes and 231
   assertions but does not reproduce the hosted stall: maximum lag/release are
   0.161 / 0.155 s. Its 39,315 samples are 79.80% idle; the measurable GC maximum
   is 0.02988 s, with two unresolved records and no precise cross-clock alignment.
   Next capture the actual hosted process with bounded clock calibration and
   verified restoration; do not infer a SQL bottleneck or repeat the local run. The generic
   local probe omits the WS authority callback and cannot rule out that wave.
   The first hosted profile attempt failed before API mutation or recipe startup;
   post-inspection matches the baseline and no workload profile exists. The repaired
   capability owner now passes a real Linux service-user profile/cleanup replay and
   retains bounded sanitized errors with accurate stages. The original host error
   is insufficient to confirm its exact cause. Independent review and fresh CI
   precede another hosted attempt. Keep this prerequisite within the formation
   outcome rather than claiming progress against latency from tooling alone.
   The next hosted attempt passed capability probing and retained a valid startup
   profile, but HTTP readiness, journal export and completed-client cleanup failed
   before the cohort began. Exact restoration is independently verified. Resolve
   these lifecycle gaps with focused tests before retrying; startup samples are
   not formation evidence and capture-bound increases do not explain export cost.
   Local repaired lifecycle checks pass, including native Linux delayed readiness,
   bounded failure and interrupted journal output. Keep host verification separate
   from these local results and preserve the failed originals.
   The next hosted cohort reached all browser shards, but signed profile-delta
   validation failed and restoration cleanup deleted native artifacts before
   remote copying. Resolve these measured lifecycle/interpretation gaps and
   recover retained results before considering another run; restoration itself
   is independently verified. Read-only recovery now reconciles 50 passed recipes,
   150 successful top-level commands and 231 passing canonical group assertions.
   The first fully corroborated promotion still waits 5.748 s before reservation,
   overlapping 5.746 s of same-worker batches; an earlier output waits 20.722 s.
   Formation lag peaks at 0.188 s, so long queue delay persists without reproducing
   the historical giant stall. The evidence lifecycle repair passes focused
   tests, typing, style and scoped review. The bounded ingress pilot is reviewed:
   repeated checks exist, but no safe material bypass is established. Existing row
   memoization suppresses about 82% of wrapper decoding; generated controls change
   representation. Its 0.046869–0.055648 s exclusive validation elapsed is local
   fixture evidence, not hosted CPU attribution. Complete retained snapshot inputs
   now prove avoidable advanced-write equality traversal. A narrow mandatory-tuple
   guard reduces median local synchronous observation from 0.338648 to 0.001576 s
   per 500 observations, with 218 affected tests passing. Same-tuple checks remain.
   Independent review and the committed-source style gate pass after a redundant
   event-version branch is removed with 54 covering tests. New-source CI passes
   21 checks with one skipped RTC lane. Fresh local timing-off 15 → 30 → 50
   cohorts pass all 231 assertions each, verified recorder bytes/counts and reaped
   cleanup. The earned hosted profile completes with native artifacts retained
   and exact source/settings restoration independently verified. Reviewed same-PID
   evidence now gives the first fully corroborated layout's own promotion a
   7.964 s preclaim wait, 7.961 s overlapping same-worker batches and 8.403 s to
   direct-send; its distinct activation takes 5.262/5.723 s. A preceding sixteen-entry
   batch includes a 3.759 s release await overlapping timer-lag maxima of
   1.185/0.775 s. Neither a hosted speedup nor SQL/GC causation is established.
   The next falsifier correlates the existing PostgreSQL release owner's
   synchronous preparation, transaction entry, conditional-write awaits and
   completion with same-PID evidence, starting with a controlled real-PostgreSQL
   boundary test. That test now fails then passes at the real queue boundary;
   the optional outbound-only probe passes 68 live-PostgreSQL tests, 147 focused
   tests and seven native API composition tests, including real COMMIT failure
   rollback and optional diagnostic faults. The owned database is removed.
   Independent source review approves the probe and combined full-main style
   validation passes. Fresh CI then rejected three private-helper absence
   assertions. Removing obsolete coupling preserves semantic durable/sink/wiring
   coverage: sixteen PostgreSQL and seven native composition tests pass, along
   with full-main coupling, reachability, workspace typing, three builds and four
   native checks. Scoped repair review and fresh release/formation/medium-scale CI
   pass. The earned hosted capture completes and exact source/settings restoration
   is independently verified. Reviewed analysis finds a maximum 0.326100 s
   release owner, so the earlier 3.759 s stall does not recur. The first fully
   corroborated layout's own promotion still takes 6.380 s to reservation return
   and 6.875 s to server send; one preceding 3.093 s page spends 3.027 s running
   claimed work and 0.047 s releasing it. Its sixteen uniquely joined attempts
   occupy 2.502 s of ordered publication, including summed cluster-publish awaits
   of 0.785 s and captured-policy regions of 1.562 s. Task 19 now separates the
   two existing reads and validation at the policy owner; source review and fresh
   selected CI pass. The new capture joins all 647 policy observations. Read and
   decoding regions comprise 97.89% of summed owner elapsed, but the long policy
   interval does not recur in the first layout's immediate predecessors. That
   layout's own output takes 0.881 s to reservation and 1.378 s to server send;
   its distinct activation waits 9.460 s, with 9.455 s inside worker batches.
   This proves occupancy, not earlier eligibility, a scheduling fault or a paired
   speedup. The maintainer now authorizes the two policy reads in parallel,
   reusing the existing delivery expiry guard without adding a reader check.
   Task 20 implements full sibling settlement, ordered error precedence and
   honest overlapping timing, with no additional policy expiry check. Its 88
   focused tests cover real delivery expiry and IndexedDB session closure. Paired
   local PostgreSQL owner medians fall from 0.000803479 to 0.000604209 s for a
   1,112-byte payload and from 0.000970354 to 0.000812626 s for 61,528 bytes:
   24.8% and 16.3% lower, respectively. Both balanced A–B–B–A blocks favor the
   candidate; each payload/version has 64 measured calls with timing disabled.
   This isolates the policy owner, not full dequeue/publication or hosted
   formation. Retain the full-path benefit gap and the previous failed state-write
   comparison; that command harness does not dispatch these outbound reads.
   The complete timing-off serial-versus-parallel A–B–B–A native-50 artifact
   block shows no full-path benefit: complete-setup player medians average
   38.6425 → 42.5500 s and connected-to-accepted medians 1.7315 → 1.9825 s.
   Both adjacent contrasts favor serial; two runs per source, correlated players
   and substantial RTC/barrier variation limit causal conclusions. All native
   correctness checks pass and all 18 original-controller restoration checks
   pass. GitHub subsequently confirms all four workflow conclusions as successful.
   Preserve the negative result; inspect existing RTC/barrier/appointment waits
   before selecting a bounded matched diagnostic or TDD fix. The absent server
   promotion marker leaves the physical commit-to-browser ≤2 s target open.
   The retained pre-rollback candidate state-write comparator passes unchanged
   thresholds: hot throughput 24.082769 → 24.661880 mutations/s (+2.405%).
   It was justified by executable QueueBox/harness changes since the earlier
   failed candidate. That older −5.103% result remains retained; neither result
   verifies outbound policy reads, which this harness does not exercise.
   Captured-policy reads are now serial again: stored admission is read and
   validated before canonical identity I/O. Existing delivery expiry guards are
   retained without a duplicate reader check. Three semantic tests failed first;
   the focused policy/PostgreSQL-factory/QueueBox bridge suite passes 58/58, and
   shared/server/test typing plus API native checking pass. The negative parallel
   measurements remain evidence; rollback is not a causal regression claim.
   Investigation of the four original captures finds the last-arriving player's
   composite connection governs the connected barrier: last-agent release waits
   are 0.236–0.338 s. In B3, controller-08 has one current accepted peer ready
   7.903 s before readiness completes despite requesting `minReadyPeers: 1`.
   The room/lane wait drops the minimum expectation and joins every desired peer.
   A public held-second-peer test reproduces this defect; the restored original
   RTC suite passes 30/30. It exists in both measured sources, so neither a causal
   A/B explanation nor a fixed speedup is claimed. The next TDD slice repairs
   minimum readiness while preserving authority, timeout/abort and owned-observer
   cleanup; only then measure formation and remaining connect/join costs. See the
   focused formation plan for the next two slices and retained limitations.
   The maintainer now authorizes a dedicated RTC implementation agent while the
   primary agent investigates larger waits and runs the matched timing-off
   native-50 comparison. Independent review covers authority and cleanup; unit
   readiness gains alone cannot close full-formation performance acceptance.
   The RTC fix now completes at the requested current-authority minimum, cleans
   up only caller-owned waits, preserves shared transports, and rechecks pinned
   authority/lane health after cleanup. Real channel cancellation and public
   threshold REDs preceded the fix; 229 focused regression tests and 32 public
   boundary tests pass. Adversarial timeout/abort, changing authority and native
   cleanup cases are covered. Full-formation performance remains pending.
   Delivery deadlines and serial sends remain enforced at their existing owner. No
   redundant read, safe cache or send reordering is established. Full details
   and constraints are Tasks 19–21 in the focused formation plan. Native 150-result/231-assertion reconciliation
   passes; complete recorder retention remains unproved under #682.
   Passing native predicates does not establish the remaining formation benefit. The live-PG pass includes expected fault-path diagnostic output.
   Label all awaited spans as elapsed; pool wait, SQL server time
   and off-CPU time need independent evidence. Preserve rollback and full-row
   release fences, and prove the missing boundary before another capture.
   This local result and capture success cannot establish the full target. Existing
   wake/page/ordered-dispatch coverage already protects the generic hold fixture.
   Do not rerun solely for a pass.
   Preserve bounded reads, ordered sends, immutable events/audiences, causal fences,
   retries, deadlines, full-row release fences, rollback and healthy-neighbor
   recovery. Do not detach owned cleanup or infer queue eligibility from overlap.
   Timing-off removes all API stage anchors, so compare common per-run native and
   browser measures with explicit missing counts, not server-stage or incremental
   instrumentation cost. Persistent state is preserved; host/store/network drift
   remains a limit. The canonical-node artifact append failure recurs with timing
   off and on; [#682](https://github.com/intact-software-systems/ar-eye-hunter/issues/682)
   retains its evidence. Passed recipes do not certify full recorder retention.
   Continue strict read-only preflight and exact-source timing-off/topology/public
   settings restoration for every hosted diagnostic.
2. **Validate corrected state-write command completion:** logical enqueue association, bounded
   capture and the demonstrated harness wait for dequeue/timer cleanup are repaired with TDD.
   The actual service-sequence endpoint is recorded while one command-owned pump remains joined
   before releasing its slot. Keep phase duration, SQL/CPU counters and cleanup open through all
   owned work. Reuse the existing failure-preserving join and canonical pump for measured and seed
   callers; no detached work or additional concurrency. Preserve every command, attempt, release,
   canonical effect and comparison threshold. A fresh comparison must use the same corrected
   harness overlay on both roles; the correction is not a production speedup or regression waiver.
   The earlier corrected-harness comparison remains a retained failure: hot throughput is
   24.675951 → 23.416662 mutations/s (-5.103%), concentrated in the third position.
   Two commands there spend 15.881/15.442 s in retry delays within 16.551/16.330 s
   latency. Other numeric gates pass; keep every position and all eighteen samples
   per workload per role. Diagnose current kind/command endpoints and the joined pump tail;
   identical exercised code does not explain the result or waive acceptance.
   The corrected-endpoint diagnostic reconciles all twelve phases. Measured hot
   external gaps total 0.007737–0.009891 s; retries finish several kinds, but the
   earlier 30–39 s phase tail does not recur. Clock-derived topology choices and
   random retry jitter remain repeatability limits. This candidate-only capture
   does not waive the failed comparison or establish pump/SQL ownership.
   Retained receipts recover effective mesh/tree inputs and all hot retry depths;
   tree share does not order the slowest runs. Actual retry due/release instants
   remain missing from that retained run. The new optional ordinary-RETRY
   observation now distinguishes preceding persisted backoff from signed
   database due-to-RETURNING elapsed, with sixteen live-PostgreSQL boundary tests
   passing and diagnostic corruption unable to suppress handling/release.
   Current v3 projection and hosted validation agree; the documented CLI keeps
   one common runner and an explicitly loaded candidate diagnostic composition.
   Exact candidate-perf-only overlay checks pass against main in comparison mode;
   unsupported main diagnostics fail before workload setup. Independent review
   found a byte-cap footer inconsistency; the correction now counts omitted retry
   records as unavailable while preserving fail-closed capture. Both byte-limit
   regressions, 77 covering checks, affected typing/native checks, committed style
   and scoped re-review pass. Fresh CI exposed stale exact transaction-owner
   classification after method extraction. The narrow analyzer inventory repair
   keeps adjacent/domain writes strict and passes 105 covering tests, full governance,
   affected typing and independent review without changing production SQL or runtime.
   A later full-main static failure is repaired by consolidating duplicated RETRY
   footer accounting, with 54 tests passing before/after and the review limit
   unchanged. Independent review and the combined full-main style gate pass.
   One reviewed pinned-candidate diagnostic now reconciles all 2,280 ordinary
   RETRY observations with the preceding persisted delays. All 1,654 measured
   reservations have due-to-RETURNING p99 / maximum of 0.035220 / 0.279353 s.
   Its measured hot last finishers have eight attempts and 2.563–3.468 s of
   preceding backoff; the prior over-30 s, ten-attempt B3 tail does not recur.
   Source/artifact integrity, twelve complete phases, 6,300 measured commands,
   native canonical validation and owned cleanup pass. Published identities
   support exact command/operation/stack/attempt joins; physical keys were
   validated by the pinned producer before redaction. This instrumented single
   candidate does not explain or waive the failed main comparison. No retry-policy
   change or blind rerun is selected. A reproduced scheduling residual would earn
   exact command-owned pump completion and bounded dequeue/timer spans; current
   exact command endpoints only derive kind envelopes. The largest phase leaves
   700,606 bytes and 7,185 events below unchanged caps, so deeper-tail retention
   is not guaranteed. Record the phase-local
   release-reference array with the raw timing-array memory and repeated evidence-scan
   follow-up in [#686](https://github.com/intact-software-systems/ar-eye-hunter/issues/686);
   serialized caps do not bound either collection. Runtime heap/GC cost and causal
   contribution to the failed throughput comparison remain unmeasured.
   Trace process SQL to its dequeue owner before attributing it to a command; temporal overlap
   alone is insufficient. Retry-depth distribution and prescribed backoff remain attribution
   outcomes before any queue-policy change.
   Current-source artifacts retain all 108 measured samples, complete native
   receipts/outbox effects and every unchanged comparator threshold passing.
   The unique ten-attempt tail now occurs on the baseline: 15.314 s latency,
   including 14.385 s prescribed backoff. Candidate hot-position wall sums
   differ by 18.616 s across nine runs alongside 60 versus 40 deep-retry
   commands. This identifies tail content but not the cause of role variation;
   no retry-policy fix or additional rerun is earned. GitHub subsequently confirms
   successful completion, matching the verified successful terminal artifacts.
   The remaining D278/D298 shared-mechanism audit, large-result certification,
   headless shutdown and serial publication findings remain explicit outcomes below; passing
   native acceptance closes none of them.

Full V1c closure still requires the original scale acceptance, D281's comparison against main
before step 1, the PostgreSQL four-arm comparison or removal of the falsified adaptive arm,
and reconciliation of this plan's evidence. Incremental delivery must not replace those outcomes.

## Delivered increments and design context

Step 1 is merged (#652). The opening navigation probe of step 2 was performed on 2026-10-14 from the
concrete group-state AppInbox registration with Go to Definition and Find Usages and reached all
five landmarks (entry `processGroupStateMutation`; authority decode and `validate`; the guarded
batch's conflict in `writeGroupMutation`; the completion written by `writeComputedMutation`; the
wake, the completion notification and `observeSnapshot`), with one resolvable type-only pivot at
`GroupStateMutationService.write` and no search escape. The static audit, the GitHub Free review and
decisions D194 to D204 live in
[alm-v1c-step2-design-proposal.md](../../playground/alm/alm-v1c-step2-design-proposal.md); this plan
records their original design context; step 2a and step 2b are merged.

Step 2a (the leader-ACK path and the harness amplification, D199, D200, D202) is merged as #662.

### Step 2b: the engine, the handler cost, the director-rooted tree and the diagnostic volume (merged, #664)

Delivered on `claude/alm-v1c-step-2b-engine-topology` (draft PR #664) as D194–D205, D207 and D208, with
D206 refuted and withdrawn (a probe showed a relay already forwards in the committing batch; the
per-hop cost at 50 is queueing behind serial 16-row batches at hubs). Measured locally on the same
machine and regime: 15 and 30 pass; 50 sets up, its 294 shots are all acknowledged through the
director-rooted 4-deep tree (18 shot timeouts before), and only the director's window fails because
the end-of-match all-recipient ACK starts with 0.39 s of the 30 s window left (25 s shot schedule,
≈2.7 s ACK tail at depth 3–4, ≈1.15 s barrier resolution at 50, ≈1.5 s for 49 confirmations). The
hosted plane got one user per agent (the shared operator principal fanned out 1+N snapshot pages per
connect) and an explicit sign-in step under the 45 s setup allowance (registrations serialize at
≈0.350 s each behind the password derivation). The window, the cadence, the allowances and every
assertion are unchanged. Hosted 15 from the branch passes through `Run GitHub Free Distributed Recipe` in
`hetzner-control` mode (15/15, 231/231, run 38662616218); the all-on-one-VM Hetzner run still fails at RTC
readiness because the co-located host stalls once the browsers start (recorded in the proposal §1.7).

### Step 2c: the acknowledgement tail at scale, the control plane at 50, then 15 → 30 → 50 hosted (merged, #666)

Step 2b is merged (#664 as `9f71ea2`). On branch `claude/alm-v1c-step-2c-ack-tail`, from the measured 50-agent evidence (proposal
§1.8): the shot-ACK tail grows with depth (p50 0.049 s at depth 1, 1.5 s at depth 3, 1.8 s at depth 4)
and completes in steps (≈1.25 s, then every 0.5 s), which is a retry or acknowledgement timer, not
queue draining; attempts per acknowledged shot equal the sender's degree, so every shot still floods
the tree; the per-session 20/s limiter refuses 4,793 hand-offs at 50 (1,228 at 30, 72 at 15) on every
agent, the director included, and its imposed wait is unmeasured. The survey located both: the stepped completion is the per-session 20/s hand-off
limiter whose 0.250 s buckets forecast refusals of up to 1.251 s (exactly 20 ACKs leave, then a gap),
and a leader-addressed send floods every overlay neighbour because the audience freeze narrows the
receipt but not the route. Decisions D209 and D210 (proposal §3) take control hand-offs off the limiter
(the breaker stays) and route frozen-audience sends along the accepted tree with a pure
subtree-contains-a-recipient filter at the origin, the relays and the repair. One change at a time with
RED → GREEN at the owner, judged by the local 50-agent run under the unchanged window. Harness (D211–D213): composite result events carry counts and no child results (the root
envelope stays nested; 88.5 MB of 159 MB at 50 were re-embedded children behind which the barrier
resolution waited); a redispatched command joins its in-flight execution instead of starting a second
run; the scale recipes wait for a stable accepted layout before `setup-complete`. Harness fault tolerance: on a control-socket outage the control server redispatches unfinished
commands and an agent whose run is in flight starts a second run of the same command id; the agent
must join the in-flight run (one run per command id) and the barriers must keep arrivals made during
the outage. Hosted: the single Hetzner VM stalls its API and control server once 15 co-located
browsers set up their RTC edges (signalling ≈11 s per hop, a 30 s control outage), so the hosted
cohorts run through `Run GitHub Free Distributed Recipe` in `hetzner-control` mode (browsers on
GitHub runners, the VM left to the servers), 15 before 30 before 50, and the four-arm lane-policy benefit gate bound above. Configurable
AppInbox concurrency and the cross-server AppInbox wake (F4, F5) still need Postgres evidence and stay
outcome-shaped. A failed run earns exact evidence review and a meaningful change before another
workload; no unchanged acceptance retry is selected.

**As applied (PR #666).** D209–D213 landed with two review-driven fix waves recorded as D214–D218
in the proposal (§3, §6): no command echoes in the result envelopes and a frame-limited result
that keeps its verdict; the rejection-log contract kept after the Deno gate pinned it; the
director prunes its own legs, a stale layout falls back to the flood for its subtree, and relays
arm no doomed repair hints; heartbeats out of the AL admission; a cohort-proportional group-request
allowance. Measured (proposal §1.9): the local 50-agent manifest passes for the first time
(50/50, 231/231, shot-ACK p50 0.033 s against 1.290 s on the step 2b head, the end event
acknowledged with ≈3 s of the window left), 15 and 30 pass locally, hosted 15 passes through
GitHub Free `hetzner-control` (231/231, shot-ACK p99 0.190 s against 1.326 s). Hosted 30 fails
after setup: the single-lane hosted API relays one offer→answer in 7.1 s p50 (4.3 s at 15; 0.17 to
0.93 s locally), RTC formation takes 52–59 s per agent, and the director-rooted rebuild after the
appointment re-forms the overlay behind the same queue while 5 s status reads time out. That bound
is the next slice.

### Step 2d: hosted formation throughput, then 30 → 50 hosted (merged, #667)

Static analysis of the hosted plane's serial path first (the `prod-in-memory` AppInbox lane, the
WS outbox worker's wake cadence, the signal relay and the audience reads: where a relay, a presence
update and a status read wait), then one change at a time at the owner (per-key or per-lane
concurrency for the in-memory profile, F4, or a relay path that does not queue behind mutations),
each RED first and judged by the hosted 30-agent run; then 50 and the four-arm lane-policy benefit
gate. The recipes need no further harness change for this: they pass locally at 50 and hosted at
15. Also carried: the three IndexedDB abort errors at page teardown (queue engine tasks still
running when the database closes) and the hosted worker's `session.expected_mismatch` diagnostic
(the agent id passed as the expected session id).

**Designed (PR for step 2d).** Two surveys (proposal §4) located the bound: the server builds its
WS inbound runtime without the volatile store pair, so every best-effort RTC signal is admitted
through the durable PGlite lane (≈20 statements on one mutex, FIFO behind every mutation and
list read), and formation-time rebuilds plus the appointment rebuild churn most edges. Decisions
D219–D224 (proposal §3): the server carries the volatile lane; additions-only deltas never rebuild;
a plan with an unchanged leader keeps its adjacency and the recipes appoint the director before
the players connect; the status refresh reads one room; the outbound breaker is verified under a
burst; ICE coalescing is held in reserve. Each RED first, judged by the hosted 30-agent run.

**As applied (PR #667).** D219–D224 landed with three review-driven fix waves and the hosted
50 evidence recorded as D225–D231 (proposal §3, §6): the server's volatile signalling lane on
single-instance profiles, typed retries off the outbox breaker, breadth-first joins from the
leader within the depth bound, the eccentricity rule for an unchanged leader, the director
appointed before the players connect, the players joining through the room connect, one-room
status refresh, cohort-proportional connect and status allowances, a refinement that keeps the
tree unless clearly faster, compact streamed artifact bundles, and a control server that survives
50 agents. Measured (proposal §1.10):
local 50 setup-complete 36.2 s against 41.8 s on main with one offer per edge and no peer churn;
hosted 30 passes (offer→answer 0.81 s against 7.1 s, formation 32.9 s against 52–59 s); hosted 50
failed four times, each one phase further, and passes on the control-server head (D232: the
control server had died ≈70 s into every 50-agent run; it now persists on a bounded cadence, scans
per agent and records under a cap). Next slice (2e): the hosted lane's per-player membership and presence cost (≈0.65 s per
player at 50, serial) measured with the AppInbox phase timing on a hosted run, the sign-in
derivation under 50 concurrent logins, ICE coalescing (D223) and the known-member join path (D228).

### Step 2e: the hosted lane's per-player cost (merged, #668)

Step 2d is merged (#667 as `e623aa7`). The phase-timing capture and the lane survey (proposal §4)
located the cost: six serial lane items per player, an authorization capture repeated inside every
group mutation, an O(N²) presence follow-on, no-op client heartbeats that still read the audience,
three PBKDF2 derivations per agent and per-measurement RTT submissions. Decisions D233–D238
(proposal §3), each RED first and judged by the local timing table and then the hosted 50-agent
`rtc.connect` and sign-in medians; D239 records that the four-arm lane-policy benefit gate needs an
arm selector, backend-operation counters and a retry-inducing workload before it can be evaluated,
and stays an open item of this plan; D240–D241 record the join contract and a typed second lane as
not taken. The first local rerun showed the handlers halved but the lane per-item fixed
statements dominating the setup window, so D242 (executor statement counters in the phase timing) and
D243 (one lane presence probe per pass, reservations only for non-empty lanes, a one-statement NEW claim)
follow in the same step, each RED first and judged by statements per lane item and the inter-item gap.

**As applied (PR #668).** D233–D238, D242–D249 and the shared primitives landed with four review-driven
fix waves (proposal §3, §6). Measured (proposal §1.11): local 50 join wait 6.5 → 3.9 s and a lane item at 3
statements in one transaction; hosted 30 connect p50 35.0 → 28.3 s; hosted 50 passes with sign-in 12.5 → 9.6 s,
connect 64.9 → 54.9 s, director-status 4.3 s and 15 timeouts → 0.002 s and none, setup-complete 8.9 s → 0.27 s,
traffic-ready 82 s against 113 s. Open after this step: the six medium consolidation candidates of the audit
(keyed rate limiter, trailing flush, serialized chain, queuebox sibling claim, JSON streaming, abort scope), the
four-arm lane-policy gate (D239, now with executor counters), the join still waiting ≈9 s behind the hosted lane
(the lane's remaining fixed cost and the per-player item count), and the RTT submission per round (D238).

### Step 2f: the hosted lane's gaps and the overlay acceptance (merged, #669)

Step 2e is merged (#668 as `4f6a6fa`). The step 2e hosted 50 journals (proposal §4 step 2f) split the players'
connect into 27.7 s behind the lane and 24.0 s waiting for the overlay acceptance, and the lane's 59 s window into
25 s of its own work and 41 s of gaps spent on route-side statements. Decisions D250–D259 (proposal §3), each RED
first and judged by the hosted 50 readiness wait, connect p50, join queue age, inter-item gap, zero heartbeat items
and zero superseded rejections in the setup window, and the four-arm gate's recorded verdict (D258 closes D239);
D260 records the deferred harness items. The six medium consolidation candidates other than the trailing flush
(D256) stay open for their own slice.

**As applied (PR #669).** D250–D254 and D257–D265 landed with two implementer takeovers after a model
usage limit and three review-driven fix waves (proposal §3, §6); D255 is deferred and D256 revised. Measured
(proposal §1.12): hosted 50 connect p50 54.9 → 37.0 s, readiness wait 24.0 → 10.0 s, traffic-ready 82 → 62 s,
no superseded promotion; hosted 30 connect 28.3 → 20.6 s; the four-arm gate falsifies the adaptive RETRY quota and
fixed RETRY two is the default (D239 closed); the cluster recipes that failed on the safety tick pass with the
completion relay. Open after this step: the ticket consume in the connect item (D255, socket registration after
the connect commit), the handler read phase's counter scope (D259), the route's second session read (D252), the
ThrottledFlush migrations of the AL checkpoint writer and the artifact recorder, the remaining audit primitives
(keyed rate limiter, serialized chain, sibling claim, JSON streaming, abort scope), the O(N) presence summary read
per connect, sign-in PBKDF2 under the cap, the test-only awaiting methods on the client inbox service
(`processAuthorisedWsClientConnect`, `processAuthorisedWsClientDisconnect`, `processExpiredSessions`), the double completion
publish for a retry-exhausted entry, and the Postgres medium-scale evidence for D261/D265 beyond CI.

The review wave added D244 (heartbeat renewals sync to the principal's own sessions), D245 (coalesced
delta slices and the browser's already-reached-revision disposition) and D246 (the bounded concurrency
admission as a shared resilience primitive). A sweep of every V1c commit for generic mechanisms under
purpose names found twelve; four small ones land in this step as shared primitives (a failure backoff
state over the existing exponential delay, a timer and clock seam, a repeating run, a keyed
single-flight), and the rest stay open items of this plan for a consolidation slice: a keyed rate
limiter for the ACK relay, a trailing flush with one in-flight write (snapshot persistence, the AL
checkpoint writer, the artifact recorder), a serialized promise chain, a queuebox-level sibling-row
claim shared by the presence summary and topology work, sliced JSON streaming, and a linked abort scope.

### Step 2g: the API thread's per-player cost and the lane's fault tolerance (merged, #670)

Step 2f is merged (#669 as `80749db`). Its hosted 50 journals (proposal §4 step 2g) show the lane 11 % busy in the
connect window and the per-player cost in request time the server does not record (17.2 s of untimed gaps per
player, 0.65 s × N), sign-in bound by 100 derivations, and formation held by an unbounded replan debounce. Decisions
D266–D277 (proposal §3): measure preflights and event-loop lag before choosing that repair; one enqueue per auth
intent; no second session read; the ticket consumed in the connect item with the socket registered after the
commit; a handler deadline; one completion publish; no test-only entry points; principal-scoped teardown; a bounded
replan wait; the recipes' quiet wait from the accepted layout; pre-registration in the hosted prepare job; typed
conflicts. Each RED first, judged by the hosted 50 connect, sign-in, formation tail and traffic-ready medians, with
15, 30 and 50 run locally first and then hosted in that order on one head. The D266 measurement on the hosted 50
(D286) found the API's single thread ≈ 89 % busy and ≈ 70 % of it in the embedded database, so the hosted lane moves to
Postgres by maintainer ruling and D287–D290 cut the statements, decodes and bytes per outbox row, per replan and per
group read; the connect and traffic-ready targets are judged after those, on the Postgres-backed hosted lane.

**As applied (PR #670).** D266–D305 landed with three review waves and two implementer follow-ups; D286, D279–D281,
D284 and D285 are maintainer rulings, D293 needed no change and D300 was reverted (proposal §3, §6). Measured
(proposal §1.13): on the hosted lane, now on Postgres, the players' connect p50 is 17.1 s (37.0 s on step 2f),
sign-in 4.1 s, traffic-ready 35.4 s from run creation (62.9 s) and one signalling hop 0.074 s; the uninstrumented
hosted 15, 30 and 50 pass in order on the final head. Open after this step: the end of formation (the promotion's
row waits behind the outbox backlog; a merged delta that carries every event replaces D300), the group-created gate
behind the slowest sign-in, the disconnect audience projection (D291), the unread rate adjuster (D298), the handler
read phase's counters, and the V1c closure below.

### Step 2h: the shared primitives and the V1c closure

D278 lists what moves here: the consolidation primitives the step 2g survey ranked, the incremental presence
summary, the handler read phase's counters and the cached snapshot body if the D266 measurement selects them.
The maintainer's rulings bind the closure: the hosted acceptance runs without server timing (D279), the
cohort-proportional setup allowances are binding (D280, written into the acceptance above), and one V1c-wide
state-write comparison judges step 2 against main before step 1 at the unchanged 5 % (D281). Then the Postgres
four-arm comparison or the adaptive arm's removal, the rewritten evidence section, and the plan's deletion.

#### Performance follow-ups from the step 2h investigation

1. **Formation-tail delivery — high priority, measured historical delay.** Reanalysis of the
   step 2g journal confirms a 0.073 s promotion followed by 8.95 s before its group-state notification
   was sent; 176 other outbox sends occurred in that interval, including 99 group-state events.
   This locates the dominant post-promotion delay in delivery, but does not isolate the cause of
   the step 2f-to-2g change across different database/runtime settings. Recover the current
   `GroupPresenceSummaryWorker` → state-sync entries → WS outbox → browser delta/event path,
   then measure promotion commit, delta write, outbox claim/send and browser acceptance separately
   on the same candidate and environment. Compare backlog age, drain throughput, statements and
   event-loop pressure; do not interpret coalesced work creation age as time waiting for its
   latest update. The replacement for D300 must preserve every event in causal order, each
   event's immutable audience, revision fences, duplicate handling and replay. A latest-only
   replacement is invalid: the current delta carries one event even when its state slice is
   coalesced. First prove those contracts with a queued burst and late promotion; only then
   choose event-preserving batching or a measured queue-service repair. Retain the ≤2 s
   formation-tail target and the unchanged scale/ACK acceptance; run local 15 → 30 → 50 before
   hosted acceptance with server timing off. Diagnostic timings do not replace that acceptance.
   Current-path investigation selects bounded group-admission reads as the first repair:
   `ALOutboundDispatchAdmission.readGroupDecisions` serializes independent members despite the
   existing backend's turn-batched reads. A controlled-delay production-owner probe confirms
   this serialization; it does not establish the hosted share of the delay. Preserve ordered
   commit and fresh per-member fallback, and settle all active reads before either begins.
   Serial after-admission publication and captured-policy reads remain a separate measurement
   follow-up: attribute publish, policy validation and direct-send time before changing their
   authority boundary. Use actual backend counters; overlapping per-message read-phase counter
   windows and shared commit durations are not additive SQL or transaction costs.
2. **Recorder burst latency — low priority, regression not established.** The first twenty-pair
   local probe showed total medians +0.2% for 1,000 small results and +2.1% for fifty larger
   results. An independent twenty-pair process measured effectively 0% and +0.9%; paired
   bootstrap intervals include zero in both populations. Append counts and output bytes match.
   Keep both populations and the confirmed stalled-write improvement in the PR evidence.
   Revisit when a representative receipt-bearing or sustained workload shows a repeatable cost:
   separate record/serialization, batch construction, append/sync and receipt work, then profile
   CPU/allocation before selecting a change. No speculative optimization or claimed burst
   speedup follows from the present results; peak memory and hosted impact remain unmeasured.
3. **Large-result certification — demonstrated harness scale limit.** The supported 50-agent
   director result exceeds the retention canonicalizer's 100,000-node budget when computing its
   full-result capture receipt. Artifact JSONL is appended and synced first, so the native
   predicates and byte/count completeness remain valid; durable release certification then fails
   closed for the run. This prevents safe browser result reclamation and is not a lost-result or
   transport-ACK failure. Preserve that safety boundary. Separate retention-plan limits from
   result-capture limits at the existing canonical encoder, grounding the latter in supported
   admitted-result bounds and preserving canonical bytes. Cover the complete capture → receipt →
   browser release path with an above-100,000-node result, including rejection beyond its own
   budget. A hashing-only change cannot fix the runtime's canonical equality checks. Do not
   inflate a shared limit, omit nested evidence or suppress the capture failure.
4. **Headless shutdown — observed queuebox lifecycle race.** After a passing 30-agent workload,
   two inbound readiness reads raced a closing IndexedDB connection. Trace the headless worker's
   context close and page disposal against the existing orderly browser disconnect, which joins
   queue-engine stop before closing storage. Add a deterministic held-read teardown test before
   changing ownership; prove no new work starts and owned work is joined before storage closes.
   Preserve the post-terminal timing and absence of observed workload loss; do not call this an
   admission-read regression or hide it by suppressing `InvalidStateError`.
5. **State-write comparison — unresolved acceptance failure.** Both the local comparison and
   hosted A-B-B-A comparison failed unchanged thresholds. Hosted deterioration was uncontended
   p99 (+15.29%), hot throughput (-5.20%) and hot transaction-duration totals (+6.09%). The last
   metric sums potentially overlapping transaction wall times per run; it is not one transaction
   or database CPU. Executable dependency traversal and a full-workload preload diagnostic
   exclude execution of the changed outbound admission methods. This harness drains AppInbox
   and writes outbox intents without dispatching them. Keep the failures visible and investigate
   the actual slow path: handler/completion waiting, SQL transaction wall time, event-loop/GC
   pressure and PostgreSQL contention on one timeline. Four-position variation is heterogeneous;
   do not dismiss it as noise or change retry/workload/comparator settings to obtain a pass.
   Retained slow config and topology commands spent 6.832 and 7.572 s in recorded retry delays
   within 7.283 and 8.179 s total latency, after eight optimistic conflicts each; final
   transactions took about 0.003 s. This locates retry-backoff amplification, not the cause of
   differing conflict incidence or the total transaction-time regression. Use the existing
   bounded diagnostic mode to distinguish failed attempts from process-wide SQL activity.
   The original diagnostic failed closed: every phase rejected 800 supported enqueue timings
   because association expected physical hashed keys where the command client emits logical
   resource/context identities. Real-client TDD with long logical identities reproduced this;
   the repair retains rejection of genuinely mismatched identity and privacy guarantees.
   All four hot phases additionally exceeded the 33,554,432-byte timing budget, dropping roughly
   11,000–17,000 timing rows per phase. Boundaries and release records are complete, but timing
   absence is not evidence. Full requested timing-plus-release counts also exceeded the
   100,000-event ceiling in two hot phases (101,185 and 100,663 events), so reducing serialized
   bytes alone could not restore completeness. Preserve originals and the incomplete receipt.
   Producer-owned identity validation and current diagnostic v2 now restore complete capture:
   v2 omits only two derived fields and explicitly permits 110,000 timing-plus-release events,
   retaining 33,554,432 bytes per phase and 536,870,912 bytes per run. No historical reader is
   needed by the private same-candidate validator; historical artifacts remain unchanged.
   The unchanged real workload retained all twelve phases, 8,400 accepted commands and 9,600
   unique enqueue completions, with zero rejected or truncated events. Database postflight and
   cleanup succeeded in both captures: the original secondary lifecycle label
   reflects the failed capture and is not evidence of another cleanup defect.
   Retained config windows also show hundreds of process-level SQL transactions while the last
   command waits for retry. The harness's per-command dequeue pump is therefore a concrete
   attribution target, distinct from production queue behavior. These unassociated records do
   not prove ownership or explain the full transaction-total regression. Complete capture now
   separates an uncontended 0.330461 s command into a 0.012 s final-transaction-to-enqueue gap
   and a further 0.190538 s enqueue-to-return gap. A hot 8.270573 s command has eight optimistic
   conflicts, nine attempts and 7.127 s of prescribed retry delays; its final transaction takes
   0.00407 s. These are selected diagnostic examples, not acceptance percentiles or additive
   CPU costs. Attribute the pump's pending dequeue and SQL ownership before repairing it.
   The diagnostic ceilings bound persisted projection, not the pre-existing raw timing arrays
   collected during a phase. Measure their allocation and retention on the same workload before
   claiming bounded capture memory or selecting a streaming/aggregation repair. Canonical totals
   and every required attribution fact must remain complete.
6. **Test-harness scheduling — observed validation sensitivity.** A local aggregate run had
   nine test timeouts, one polling deadline and one missing drain observation while another
   checkout's large suite shared the machine. All 243 tests in the eleven affected files passed
   with one worker after that competing run ended. Preserve both results; this does not prove
   contention caused every failure. The inbound diagnostics test waits for delivery and then
   immediately asserts the later drain record. Cover that observation-order boundary with a
   deterministic held release before changing test synchronization. Investigate resource
   isolation without increasing deadlines or weakening assertions.

## Completion and handoff

Use test-driven and subagent-driven development with distinct implementation, specification and
quality review. Keep only these two useful slices concrete. Run `npm run pr:delivery -- status`
before broad final validation, repair real conflicts first, and leave a mergeable branch unchanged
when it is merely BEHIND. Publish semantic PR explanations, not tracked delivery metadata.

Step 1 readiness is a main integration boundary, not full V1c completion. Stop its delivery work
when GitHub reports it merged; do not add a post-merge receipt, ledger or cleanup commit. Continue
step 2 as separately authorized implementation after that merge. Once step 2 actually satisfies
original acceptance, benefit and complete review, delete this completed plan in that pull request
before readiness. Preserve the durable design and Git history. Wait for the user's manual merge
before V1d. Create an Issue only for independently evidenced work outside this active outcome;
otherwise report that no Issues were created or reused.
