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

## Standing constraints for step 2 and the following slices

The maintainer set these on 2026-10-14 after merging step 1; they bind every remaining V1c slice
and V1d:

- Performance and scalability are the subject. Locate bottlenecks with the repository's
  `performance-analysis` skill (static audit → measurement plan → runtime validation → one change
  at a time) before selecting a repair. Problems exist in both Rallar production code and the
  black-box shared-test harness; both must be resolved, neither excuses the other.
- The queuebox engine (`packages/shared/queuebox`, the server AppInbox built on it and the browser
  IndexedDB engine) is the event-handling core. It must be quick, responsive, smooth and fault
  tolerant. Scale exposes intermittent faults, so fault tolerance (stale claims, lease expiry,
  duplicate delivery, retry exhaustion, breaker interaction, unbounded retention, wedged waits)
  is a first-class acceptance quality beside latency.
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

Step 1 is merged (#652). The opening navigation probe of step 2 was performed on 2026-10-14 from the
concrete group-state AppInbox registration with Go to Definition and Find Usages and reached all
five landmarks (entry `processGroupStateMutation`; authority decode and `validate`; the guarded
batch's conflict in `writeGroupMutation`; the completion written by `writeComputedMutation`; the
wake, the completion notification and `observeSnapshot`), with one resolvable type-only pivot at
`GroupStateMutationService.write` and no search escape. The static audit, the GitHub Free review and
decisions D194 to D204 live in
[alm-v1c-step2-design-proposal.md](../../playground/alm/alm-v1c-step2-design-proposal.md); this plan
binds the two slices that follow from them.

### Step 2a: the leader-ACK path and the harness amplification

Deliver D202, D199 and D200 as one reviewed increment on the current branch:

- Leader-ACK path (D202): a logical recipient of a `group-leader` or `receiver` send acknowledges
  itself immediately with status `accepted` beside the deferred subtree row; relays forward only
  ACKs whose logical recipient is in the frozen audience; `send-control` ranks first in an inbound
  batch; the in-memory QueueBox prunes COMPLETED rows on release; a server receipt that loses three
  commit conflicts is retained as pending-control work; the server ACK relay budgets per held
  aggregate and reports a failed NOTIFY as a typed failure. Routing, authority, frozen audiences,
  QoS, the 30 s TTL, the fallback trigger and D56's late-ACK rule are unchanged.
- Harness (D199, D200): one rollup per affecting control message with agent-indexed evidence; no
  array copy under unbounded retention; compact change-driven snapshot persistence; an oversize
  result frame recorded as a diagnostic with a gap record and bounded replay; the agent page's
  per-event work independent of history (event cursor, report projection only while shown,
  incremental wait matching); the headless app's paced render and `hmr: false` under the
  full-stack lifecycle.
- Docs: the runbook's complete local all-local command and the GitHub Free verdict.

Every change is RED first at its owned boundary (the proofs are listed in the proposal §4).
Measured before and after in the same regime (D204): the local all-local 15-agent run on this
machine, which fails today with 240 delivery-state timeouts after every page sets up. Publish the
slice through the draft PR, keep this plan, and wait for the user's manual merge.

### Step 2b: the engine, its fault tolerance and the handler cost, then 15 → 30 → 50

After step 2a is manually merged, on a fresh non-default branch: D194 to D198 (a handler-finalized
success skips the post-commit release; the registration runnable wakes the engine after a batch
that claimed work; typed retryable conflicts are not breaker failures, an open breaker reports no
work and wakes at its reopen time, one task's `isWork` failure does not abort the pass, a reserve
or release error backs off through `wakeAt`; the AppInbox TIMEOUT lane's 60 s lease;
`resource_inbox_results` eviction; the `prod-in-memory` completion-wait ceiling) and D201 (the
synchronous canonical SHA-256 with every caller renamed, provenance from the computed rows, one
projection per validation, the bounded audience re-read once its linearization point is ruled),
each RED first, with the state-write comparator and the unweakened Postgres medium-scale gate.
Step 2a's hosted 15-agent run from the branch fails at that burst (13 join requests and one
presence update refused 503 "App inbox entry did not complete within the wait budget"), so this is
the first hosted blocker. Step 2b also takes the 50-agent local blocker measured in the proposal
§1.6: topology planning places the appointed director at the root of the tree (or at the node of
minimum eccentricity) for a room whose traffic is leader-addressed, instead of a leaf at depth 7;
the per-hop ALM cost and the retry churn at hub relays are measured at their owners before a
change; the harness diagnostic volume (≈9,000 events per second at 50, 94 % ALM diagnostics,
13 lost results) is bounded by sampling or by a per-recipe opt-in that keeps the assertions'
evidence; the RTC limiter, breaker and data-channel queue get a diagnostic so they can be ruled
in or out. Then establish the original capture-off fifteen acceptance before thirty and thirty before fifty,
locally first and then through the hosted manifests, and run the four-arm lane-policy benefit gate
bound above. A failed run earns exact current evidence review and a meaningful change before
another workload; no unchanged acceptance retry is selected. Configurable AppInbox concurrency and
the cross-server AppInbox wake (F4, F5) need Postgres evidence and stay outcome-shaped.

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
