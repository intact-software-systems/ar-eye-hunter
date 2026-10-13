# ALM V1c Scale Evidence Implementation Plan

## Goal and ownership

Deliver the original 15/30/50-agent match-payload acceptance and prove the selected fairness
benefit. Add six- and eleven-browser diagnostic checkpoints to isolate smaller-cohort failures;
they do not replace any original acceptance or benefit gate. Implement [the V1c design](../../playground/alm/alm-v1c-design-proposal.md) and D183 in
[the ALM improvement plan](../../playground/alm/alm-improvement-plan.md). V1d remains an outcome
until this work is accepted and the user manually merges its pull request.

Shared-test owns the composed workload, native evidence and group assertions. The black-box app
catalog owns participant and topology selection. Existing command runtimes, distributed operators,
receipt observers and safe exporters retain their respective execution and evidence boundaries.
Use the current repository owners, nearby tests and examples to recover each actual call path;
this plan is neither a substitute for source navigation nor a delivery ledger. No new dependencies,
runner, evaluator, generic diagnostic framework or duplicate policy engine are required.

The live draft pull request owns delivery state. Git history, immutable ignored evidence and the
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
  RTC-readiness allowances, 15-second barriers and 30-second workload/ACK window. The declared
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

- The original capture-off fifteen-agent run on the free GitHub runner failed in traffic after
  complete setup, RTC readiness and START. It sent 80 of 84 shots; a required director ACK reached
  its SDK callback 18.6 seconds after the native-submission observation. Its native message callback
  entry is uncaptured, and the same actor has long command scheduling delays. Separate local send
  refusals do not identify that ACK's cause. The later local callback-entry observation covers a
  different current control family; no CPU, memory, database, quota or queue-task cause is
  established for the hosted failure. Thirty and fifty remain gated.
- The valid 5.40% shared-throughput comparison remains failed against the unchanged 5% allowance.
  Conditional IndexedDB scheduling benefit does not establish native or universal performance.
- The approved guard observation remains inconclusive for a guard defect or causal repair. Partial
  capture cannot prove that an unobserved guard never ran. Do not repeat that diagnostic workstream.
- The sampler and exact lifecycle-audience repairs are implemented and locally verified with
  meaningful failing-first cases and healthy controls at their command/runtime/evaluator owners.
  They preserve every original acceptance requirement; native workload acceptance remains unproved.
- The six-browser full diagnostic passes with the same match workload. The assertion admission,
  result traversal and terminal aggregate decoding repairs are complete. This diagnostic is
  smaller than the original acceptance cohort and does not establish original scale acceptance.
- RTC quota denial is now separate from operation-failure accounting. The current ACK boundary
  tests prove quota-window recovery, preservation of real failure history, real-failure opening,
  circuit-open priority and half-open recovery with the existing limiter and breaker defaults.
  The latest local eleven-browser diagnostic passes all eleven recipes and all 231 native
  coordinator predicates. All sixty shots, exact leader ACKs, both complete lifecycle audiences,
  77 readings, 847 sampled budget checks and final zero admission/non-probe work storage pass.
  Its bounded private observation retains 29 START control handoff refusals as rate-limited;
  the required controls recover. The current END is healthy. Those current-run
  verdicts cannot identify the cause of the earlier failed END, and instrumented local success
  does not replace original uninstrumented scale acceptance, benefit or memory-leak evidence.
- The canonical engine now owns task rejections after cleanup, joins active work during stop and
  uses its injected clock consistently for scheduler and circuit-breaker decisions. Meaningful
  rejecting runnable, before-stop, during-stop and clock-boundary tests pass, with independent
  full-file specification and quality review. This repair does not establish the native ACK cause.
- The native callback probe's custody and source-currentness repairs pass meaningful failing-first
  cases, actual-SDK capability and independent specification/quality review. The latest local
  fifteen-agent diagnostic still fails: all setup stages and initial barriers pass, all 84 shots
  are sent, 83 ACK waits pass and player 12's sixth shot remains transport-accepted at its inherited
  deadline. All 105 samples and 1,155 sampled checks pass; END, final storage and all 231 native
  predicates remain unevaluated. Full producer/export payload reconciliation and cleanup pass.
  The eight exact player-2 native entries reach SDK ingress within 0–1 ms; this healthy current
  family cannot explain the earlier hosted delay or the current player-12 failure.
- The current required ACK reaches player 7 from the director. Two actual player-7-to-player-12
  forwarded controls repeatedly fail their individual fallback handoff; the retained evidence has
  no matching native settlement, receiver SDK ingress or typed rejection reason. A separate
  unvalidated rejected candidate was never committed and is not lost work. The next discriminator
  observes this actual enqueue/handoff refusal, with same-run shot origin and required director
  identity. The older director-origin selector excludes this shot ACK; its historical complete flag
  also lacks renderer/retained ordinal reconciliation. Captured historical refusals remain positive
  observations, without an exhaustive absence claim. Current receipts include WS fallback attempts,
  so the local diagnostic is not exclusive RTC proof. No memory, CPU, quota or database cause is
  established.
- The changed ALM/multicast source review identifies false unattempted-send evidence after an
  immediate native send throws, a misnamed inbound authorization boundary, a forwarding-only
  receipt diagnostic writer and two import-grouping defects. Resolve these earned findings with
  complete recursive closure; none identifies the fifteen-agent delay's cause.
- The public finalization type correction and three awaitable runtime/multicast disposal methods
  still require the maintainer's separate compatibility decisions. Verified repository consumers
  and passing cleanup tests alone cannot supply those decisions. No legacy adapter is selected.
- Full source/support closure, whole-branch review, original scale and benefit, readiness and manual
  merge remain open. The pull request owns current source, CI, test and run outcomes; do not copy
  delivery history here.

## Next two useful slices

### 1. Establish original capture-off fifteen-agent acceptance

Use the complete current failure to observe the typed enqueue/handoff rejection on the ACK's
failing hop. Derive its origin player, required appointed director, exact subject/control family
and actual sender/receiver from the same run. Capture only bounded closed verdict/reason fields
and identity hashes at the existing owned rejection boundary. Distinguish returned rejection from
an awaited enqueue failure; absent boundary capture remains inconclusive. Do not copy the older
lifecycle-control director-origin selector into a player-shot observation.

Reuse existing Playwright/CDP lifecycle and capability patterns after meaningful same-run
selection, source/current-channel and cleanup tests. Reconcile renderer selections, retained
records and distinct invocation ordinals; a detached session or healthy capability alone cannot
certify complete workload capture. Independently review the exact private candidate before one
instrumented diagnostic with the original workload and complete native retention. This next
observation closes a specific missing reason; it is not an unchanged retry or a heap/CPU hypothesis.
The earlier native-entry observation has answered its selected healthy current family and need
not be repeated. Neither private diagnostic replaces original uninstrumented acceptance.

Earn a meaningful failing-first repair from the observed boundary before another original
acceptance execution. That execution retains its frozen audience, tree, six-shot cadence, lifecycle
events, exact receipts, seven samples per actor, storage and metric limits, deadlines, native
predicates, source provenance and cleanup. Preserve original capture-off settings. Thirty and fifty
remain gated by fifteen; comparative benefit and final whole-branch review remain open.

### 2. Preserve truthful ALM submission evidence and direct boundaries

Complete review and publication of the failing-first real QR/ALM native-send evidence repair.
An immediate native send throw must settle as attempted; a failure before native invocation stays
unattempted and preserves its original error. Queued native failure retains its existing typed
result. Use the existing prepared-send/settled-send contracts and QR settlement port; preserve the
logical message, deadline, ordinary retry owner, exactly one attempt settlement and direct QR
throw behavior. Keep the internal adapter's async result consistent with its verified consumer;
no new public result, callback, scheduler, compatibility wrapper or queue registry is selected.
Run the focused transport/observation tests, shared and test typechecks, full-file standards checks
and affected browser consumer/bundle validation before publication. Existing callback scheduling
may supply a demonstrated completion boundary; arbitrary settlement flushes cannot substitute for
owned work or queue completion in the tests.

Give the inbound authorization/read/observation operation a truthful owned name while preserving
its first-refusal precedence and lazy relay read. Keep the immutable receipt projection, remove
its forwarding-only writer and call the canonical guarded diagnostic writer at receipt admission.
Correct the two external/local import separators. Follow verified callers and support files into
full closure, without a compatibility alias, duplicate guard, old-path module or migration code.

Keep the original acceptance workload as the priority while this independently evidenced review
fix proceeds. A failed fifteen-agent result earns exact evidence review and a meaningful
failing-first repair before another run. Review every changed human-authored file in full; changed
support files enter closure recursively, and independent untouched code remains outside.

## Later outcomes and completion

Keep later work outcome-shaped. Finish unchanged thirty and fifty after fifteen, and satisfy the
original comparative benefit gate. Earn any intervening
repair from independent evidence and meaningful failing-first behavior; keep only the next two
useful slices concrete. The selected six/eleven checkpoints remain diagnostic. No extra benchmark, quota/capacity
exploration, unchanged hosted retry or relaxed acceptance is selected.

Use subagent-driven development for implementation with fresh implementer, specification and
quality review; the controller owns fixes and final whole-branch review. Preserve RED → GREEN →
refactor evidence, semantic tests at real owned boundaries and proportional affected checks. Review
all changed files completely and recursive support closure, while excluding independent untouched
code. Complete affected production-legacy and owner-to-result navigation review; a historical task
inventory, passing warning-only checker or local source hypothesis cannot replace those reviews.

Publish coherent reviewed increments to the existing feature branch and one draft pull request.
Keep its semantic Goal, Changes, Acceptance, Validation, Risk and rollback, and Follow-up current,
without task counters, identifiers, hashes, receipts, metadata fences or a progress catalog. Run
`npm run pr:delivery -- status` before broad final validation; repair a real conflict first. BEHIND
alone creates no work while GitHub reports mergeable. Require the selected current release and
distributed correctness gates, report exact passed/failed/skipped checks and keep measurement limits
visible. Do not relabel retained historical checks as fresh.

After actual acceptance and full review, delete this completed implementation plan in the pull
request and remove any current-work references to it before running `npm run pr:delivery -- ready`
once. Retain the durable design and Git history. Preserve the user's manual-merge intent and
unarmed auto-merge; readiness does not substitute for acceptance. Wait for the user's manual merge
before V1d. When GitHub reports merged, stop without a post-merge ledger, receipt, archive or cleanup
commit. Create a follow-up Issue only for independently evidenced work outside this outcome;
otherwise report Follow-up: None.
