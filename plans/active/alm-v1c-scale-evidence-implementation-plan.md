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

The current pull request delivers V1c step 1: bounded lane execution, independently evidenced
runtime repairs and the consumer-proof workload. V1c step 2 completes original scale acceptance
and comparative benefit after the user manually merges step 1. Preparing step 1 for main does not
make the full V1c outcome complete or waive either failed gate.

The live pull request owns delivery state. Git history, immutable ignored evidence and the
pull request retain prior outcomes and review chronology; do not copy that history into this plan.

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
- Preserve the existing 5,000 ms HTTP allowance, separate 45-second initial socket and 45-second
  RTC-readiness allowances, 15-second coordinator start barrier and 45-second recipe setup
  barriers. The existing 65-second shots-complete declaration is clipped by its enclosing
  30-second absolute workload/ACK window. The declared
  330-second outer terminal allowance and existing 120-second hosted registration allowance are
  lifecycle bounds, not extensions of those inner deadlines. Preserve parent clipping, cancellation
  and truthful incomplete results. Late diagnostics cannot resurrect a failed window or end event.
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
  300,000 ms; own tracks 64; ordering snapshots 512; overloaded is false; congestion dropped is
  zero. Preserve the runtime-limit checks as well as those literal limits, role-scoped sources and
  exact controller attribution through nested command evidence. Absent metrics or duplicate sources
  cannot form a healthy result.
- After explicit setup/barrier/storage reset, AL admission storage and non-probe AL work storage
  remain zero. Explicitly exclude idle probes while still recording them. Require final traffic
  storage readback; sampled bounds or setup reset alone do not prove this requirement.
- Preserve canonical source manifests, isolated effective identities, original uninstrumented
  acceptance settings, complete native evidence retention and owned cleanup. Recorder counts, EOF,
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
absence from incomplete zero or missing nextTs. Keep the existing 1,000 ms/one-admission RateLimiter
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
balanced 36-sample comparison remains failed at a 5.40% shared-throughput regression against the
unchanged 5% allowance. No sample removal, threshold waiver or blind comparative retry is selected.
Preserve the current source-owned canonical bundle budgets, compression settings, dependency
boundaries and strict comparisons. Accepted bundle growth is not a runtime benefit.

## Current evidence and open facts

- Original capture-off fifteen-agent acceptance fails after setup, RTC readiness and START.
  It sends 83 of 84 shots: 66 ACK observations pass, fifteen time out and two remain unfinished.
  Only 104 of 105 samples exist; all 1,144 retained sampled bounds pass, but none of the 231
  native predicates is judged. Thirty and fifty remain gated by an actual passing fifteen.
- Instrumented six- and eleven-browser diagnostics pass. A local instrumented fifteen also
  passes all 84 exact shot ACKs, both lifecycle observations, 105 samples, 1,155 sampled bounds
  and all 231 native predicates. Its positive chains use RTC and do not exercise the failed
  hosted WS receipt family. These supplemental results do not replace capture-off acceptance.
- The hosted WS diagnostic fails. Four failed shots have complete server ACK counts and new
  complete receipts whose send-work reservations begin at least 1,041–1,055 ms after conservative
  inherited deadline bounds. Admission, dequeue and send have distinct identities; neutral holds
  can change eligibility. Continuous queue wait and incorrect selection are not established.
- The narrow hosted phase diagnostic fails. Three complete sixteen-claim pages take 510, 421
  and 186 ms; serial callbacks occupy 72–89% of those intervals. Canonical lookup accounts for
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
  observed 1,098 and 851 ms later. Adding the requested delay to the recorded retry epoch places
  nominal poll horizons 1,095 and 847 ms after those commits; actual timer start and expiry are
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

### V1c step 1: prepare the current branch for main

Deliver the existing implementation as a coherent reviewed increment:

- Keep complete per-invocation lane budgets, bounded reservation clamping and claim accounting.
  Retain the existing AppInbox reader's RateLimiter, advisory pressure, cache and fixed fallback.
  Include the approved scalar validation: positive safe-integer service limits and valid actual
  storage requests. Preserve nonpositive reservation sentinels, safe ordinary-lane clamping,
  valid independent finalization batch sizes and existing failure/backoff behavior.
- Preserve the meaningful failing-first runtime repairs: expected admission and quota denials
  do not count as operational breaker failures; whole-batch quota refusal uses the existing
  NotReady boundary and nonspending forecast, without charging processing attempts. Actual
  replay rechecks quota. Partial-batch fallback and twenty genuine failure attempts remain.
  The controlled full-owner case submits and receives its same-origin receipt on claim two at
  1,251 ms, versus claim eight at 3,031 ms. This proves that bounded policy repair, not native
  causality or the comparative benefit gate.
- Preserve owned engine rejection/cleanup, awaitable disposal, immediate native-send failure
  settlement and original detail, exact sampler/lifecycle assertions, and the direct receipt
  diagnostic boundary. Mandatory ACK processing precedes optional guarded observation.
- Preserve approved public contracts: finalization result types, awaitable disposal, WS
  `authorizeInboundMessage`, explicit precise queue creation clocks and explicit RTC quota clock.
  Default factories retain UTC nanoseconds; quota, AL deadlines and creation clocks stay distinct.
  Direct callers supply the required dependencies. No legacy adapters or migration code are selected.
- Deliver the measured completion-polling repair through one optional wait-execution boundary in
  the existing retry policy and an explicitly owned local completion hint, with meaningful
  test-first isolation and fresh integration coverage. A hint follows committed terminal writes or
  terminal queue release and only requests another durable read. Preserve the canonical retry
  algorithm, polling defaults, elapsed budget, result validation and cross-process fallback.
  Close read-to-wait races, duplicate notifications and timer/subscription cleanup without a
  raced background polling loop or timing-sink dependency. Use the approved canonical retry
  path, methods, named inputs, timing and exhaustion contracts, with explicit default and
  injected database factories; retain one engine and no predecessor adapters.
- Preserve incompatible existing admission databases through typed schema/identity refusal,
  with acquired-handle cleanup and original failure causes. Initialize genuine absence only;
  observed cross-context recreation remains an event, not a local delete/recreate migration.
  Owned browser cleanup stopping cancels normal periodic/retry waits and future admission;
  distinguish unsupported in-flight work and failed external cancellation from completed cleanup.

Review every changed human-authored file completely for behavior, necessity and current standards.
Every support file modified by remediation enters closure recursively; independent untouched code
stays outside. Complete production-legacy classification and owner-to-result navigation review.
The maintainer is away from the Mac and explicitly postpones the manual five-landmark IDE probe
to step 2 because local GUI access is unavailable. The probe has not been performed; automated
checks do not replace it.
Remove affected unneeded legacy and duplicate paths. Exact current source and meaningful existing
review evidence may be reused; heuristic inventories and hash-only bindings do not prove semantic
review. Keep the unrelated local scanner edit outside publication.

Run the exact changed-range style gate before publication and resolve any failure. A narrow
reviewed disposition must describe the actual cohesive owner and exact measured cap; it cannot waive
an actual standards violation or change global thresholds. Run focused affected checks before the
required current Branch Release Gate, formation and medium-scale correctness gates. Report skipped
checks explicitly. Passing release tests alone do not establish original consumer acceptance.

Keep the PR's Goal, Changes, Acceptance, Validation, Risk and rollback, and Follow-up current. State
that original capture-off fifteen and comparative benefit remain failed and belong to step 2.
After complete review and passing required current checks, run `npm run pr:delivery -- ready` once.
Keep auto-merge unarmed and wait for the user's manual merge. Retain this plan because V1c remains
unfinished. Do not add the private measurement checkpoint to step 1 merely because it exists.

### V1c step 2: complete consumer proof and measured lane policy

After step 1 is manually merged, work on a fresh non-default feature branch. Keep the original
workload and unchanged benefit gates above as the completion criteria; six/eleven diagnostics
remain supplemental, and V1d stays outcome-shaped.

Begin step 2 with the deferred manual 5/5 cold probe from the changed concrete AppInbox
registrations, using only Go to Definition and Find Usages. Reach the concrete operation entry,
domain or update policy, first conditional write guard, exact durable result and after-commit
effect. Record search escapes, ambiguous pivots and named deferred boundaries. Complete this
check before further step 2 production changes or scale acceptance; no passing result is claimed
until the probe is performed.

Then narrow the measured admission/dequeue callback remainder at its existing owners. Recover
outbound commit-phase and sender-queue diagnostics; keep the original metrics sink active. A private
reviewable checkpoint extends the existing bounded, guarded, deferred observer and safe codec.
Its native observer fixture extension and complete independent review remain pending. Finish those
checks before deciding on one changed diagnostic. Bind raw source and measurement overlay separately.
Do not duplicate admission logic, add a capture framework or infer absence from partial observation.
Keep API epoch, monotonic duration, stored reservation and browser clocks separate.

Select a production repair only from a positively located defect and meaningful RED → GREEN
coverage at its owned boundary. Preserve authority, frozen audiences, cadence, receipts, deadlines,
storage, metric limits, native predicates and owned cleanup. Then establish original capture-off
fifteen acceptance before thirty, and thirty before fifty. A failed run earns exact current evidence
review and a meaningful change before another workload; no unchanged acceptance retry is selected.

Keep the controller's complete lane-budget callback as the canonical policy extension point.
`maxToReserve` is batch size; `maxNumToDequeue` is claimed-entry service per ordinary lane per
invocation. Fixed lane order is count preference, not weighted round robin or a latency guarantee.
Finalization runs one bounded batch; unused lane quota is not redistributed. AppInbox currently
hardcodes service one, with eligible RETRY service one/two; deployment weighting is not exposed.

Assess typed deployment policy at application configuration/composition, consumed by the existing
reader. Keep reservation size separate from lane service, require positive safe integers and bounded
maxima, protect recovery service and retain the current cache/RateLimiter/fallback ownership. Do not
introduce deep environment reads, a second scheduler or exact-count queries. Any new public contract
requires a concrete compatibility proposal before implementation. No configuration is called optimal
until representative workload evidence proves its tradeoffs.

Preserve the four comparison arms and equal durable work. Compare durable completion, attempts,
NEW progress, retry latency, recovery progress, reservations, pressure reads/concurrency and total
backend operations across sustained, recurring, disappearing and partially hidden work. Satisfy the
unchanged PostgreSQL correctness and comparative thresholds; retain all valid failed samples and
cold/stale penalties. If adaptive service does not improve on fixed RETRY two, report that result
and use the selected fixed bounded fallback rather than substituting an easier benefit claim.

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
