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

- The latest original capture-off fifteen-agent run on the free GitHub runner fails in traffic
  after complete setup, RTC readiness and START. It sends 83 of 84 shots: 66 ACK observations pass,
  fifteen time out and two remain unfinished. One actor misses its final shot and sample. All
  1,144 retained sampled checks pass, but only 104 of 105 samples exist and none of the 231 native
  coordinator predicates is judged. One failed shot reaches its issued leader by WS; the generated
  ACK handoff completes on claim one before the deadline. Browser ACK transmission, the translated
  complete origin receipt and subsequent SDK receipt admission remain uncaptured. No quota refusal
  joins it. Complete producer/export retention does not establish completed work. No CPU, memory,
  database, quota, queue-task or transport cause is established. Thirty and fifty remain gated.
- The local fifteen-browser CDP diagnostic passes all 84 shot ACKs, both lifecycle observations,
  105 readings, 1,155 sampled bounds and all 231 native predicates. All fifteen captures finish
  complete with zero local counter loss, and complete producer/export reconciliation passes.
  Exact positive RTC chains cover every successful shot; six leader ACKs are direct and 78 relayed.
  All 212 recorded attempts use RTC. The canonical WS envelope matches the capture decoder,
  but the target WS ACK-to-new-receipt family is not exercised. Zero CDP control rows do not prove
  absence. Local hardware, runtimes and capture overhead qualify this supplemental result; the
  original hosted failure and capture-off acceptance remain open.
- The same-source hosted diagnostic with the existing WS observer fails with 81 of 84 shots,
  34 passing shot ACKs, 45 explicit timeouts and two unfinished observations. Only 103 of 105
  samples exist; all 1,133 retained sampled bounds pass, but none of the 231 predicates is judged.
  Complete native producer/export reconciliation and owned cleanup pass. Four failed shots have
  positive complete server ACK counts and newly generated complete receipts whose send-work
  reservations begin after the actual sender waits return failure. Their conservative minimum
  lateness is 1,041–1,055 ms. Admission, dequeue and send use distinct work identities, so the
  preceding interval is not one queue wait. Six other complete receipts enter an earlier batch;
  deferred publication timestamps do not establish individual send timing. The exact source trace
  places the four prepared-send commits before the later run and positively fills all sixteen
  slots of the preceding serial page. Neutral holds can move eligibility, so elapsed time does
  not prove continuous queue wait or incorrect selection. API observation is
  partial; missing rows cannot prove absence. The reason for late receipt work and the other
  failures remains unresolved. No CPU, memory, database, quota, queue or transport cause is selected.
- The narrow hosted phase diagnostic also fails. Three positively complete sixteen-claim pages
  take 510, 421 and 186 ms; serial callback execution occupies 72–89% of those page intervals.
  Canonical lookup is only 4–7% of their monotonic callback cost. Admission and dequeue callbacks
  carry most of the unpartitioned remainder; prepared-send callbacks are cheaper in these pages.
  The new deferred phase flush takes 0.47–0.50 ms, excluding its own write and existing observers;
  this is not total instrumentation overhead or an uninstrumented comparison. Exact same-run
  failed subjects join the retained claims, but API capture remains partial without a phase
  summary. Native recorder/export files match; all control-snapshot events occur in that export,
  with 577 additional runtime events. Complete producer-to-export parity is unproved. These
  positive costs narrow the next question without proving a production defect or repair.
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
- The current private handoff probe's source/context fencing, ordinal custody and cleanup pass
  meaningful failing-first tests, actual-SDK capability and independent specification/quality
  review. One local fifteen-agent diagnostic fails at END, but all 84 shot ACK observations
  and explicit director receipts now pass. All 105 samples and 1,155 sampled checks pass. All
  fourteen players complete END reads, final bounds and zero admission/non-probe work storage.
  The director END ACK wait fails after 893 ms at its inherited workload deadline; its final
  receipt/storage checks and all 231 native predicates remain unevaluated. Full producer/export
  payload reconciliation and completed-producer/zero-reaped cleanup pass. This instrumented local
  outcome does not establish original uninstrumented acceptance or repair causality.
- Exact END predecessor joins identify six earlier controls with 36 pre-deadline throwing handoffs
  at two intermediate relay hops. Those handoffs complete after the deadline,
  then produce nine late final ACK controls. All fourteen player END admissions and reads precede
  the director deadline; the final-hop owner generates its controls within 0–1 ms of predecessor
  SDK entry. Late final-hop throws alone cannot explain the earlier expiry. The typed reason at
  the six earlier handoffs remains uncaptured; that END reason is still an open evidence gap.
- The reviewed director-origin probe now covers all fifteen pages and intermediate relay hops.
  Its first native diagnostic fails before END: two players fail their sixth shot ACK observation
  and never arrive at the shots-complete barrier. All 84 sends pass; 82 shot ACK observations,
  72 explicit shot receipts, 105 samples and 1,155 sampled bounds pass. Both missing shots are
  admitted and return from director dispatch before the player deadlines. Two exact terminal
  controls are submitted before those deadlines but enter a shared relay's SDK callback afterward,
  with 3,048 ms and 3,063 ms observed gaps. Earliest native receive entry remains uncaptured.
  Seven complete, uncapped typed rejections join START,
  so they cannot identify either shot failure or the earlier END cause. Complete producer/export
  retention and reaped cleanup pass. Trace the same-run receipt and child-hop completion path
  before selecting a repair; neither timeout wrapper counts nor dispatch return prove terminal ACK.
- The private player-origin selector retains 787 rate-limited verdicts for successful shot ACKs,
  with two capped pages. Exact subject/identity joins and renderer/retained ordinal reconciliation
  preserve those positive records; total capture is incomplete. None joins END because its ACKs
  have director origin and player logical recipients. Neither those unrelated positive verdicts
  nor a healthy scoped zero supplies the failed END reason. Receipt histories include actual WS
  fallback, so this is not exclusive RTC proof. No memory, CPU, quota, database, engine or network
  cause is established for the END failure or earlier hosted delay.
- The native-send evidence repair now preserves the existing attempted failure settlement and
  original error detail after an immediate native send throws, with ordinary retry unchanged.
  Focused tests, full-file reviews and affected consumer checks pass. The approved inbound
  authorization naming is implemented, with affected checks passing. The receipt boundary now calls
  the canonical guarded diagnostic writer directly; its immutable projection and import grouping
  have complete independent specification and quality review and affected checks. None identifies
  the END handoff reason; remaining source closure and whole-branch review stay open.
- The reviewed first-distinct handoff diagnostic now joins five typed `unroutable / rate-limited`
  refusals to two failed sixth-shot ACKs. All five match exact current control/session identities
  and their first claim intervals. Another 135 records join 55 acknowledged healthy subjects,
  so quota refusal alone does not explain final failure. All fifteen page owners finish complete
  without errors or caps; full producer/export reconciliation and owned cleanup pass. Eighty-four
  sends, 82 shot ACK observations, 72 explicit shot receipts, 105 readings and 1,155 sampled bounds
  pass. Two players miss their inherited ACK deadline; END and final storage remain unexecuted,
  and no result for the 231 declared native predicates is published. One forwarded control
  completes 129 ms after that deadline; another has no subsequent outcome established. First-distinct
  capture cannot classify later retry exceptions. These observations do not establish wire latency,
  memory leaks, a transport cause or repair causality.
- Controlled full-owner baseline tests prove replay and same-origin receipt, but also show the
  quota refusal becoming ordinary retry after individual fallback. With centered jitter and actual
  persisted due times, claim seven at 1,031 ms still retries and claim eight submits/settles at
  3,031 ms; the unchanged real limiter already allows at 1,251 ms. Independent specification and
  quality review pass for that baseline. This is controlled durable retry policy, not browser
  scheduler latency or native failure causality.
- The earned readiness change now uses the existing limiter's nonspending eligibility forecast
  and existing validated NotReady boundary. A whole-batch quota refusal retains every control
  without individual fallback or charging a processing attempt; the inbound owner's own clock
  determines its next due time. Actual admission still rechecks the same limiter. The meaningful
  failing-first full-owner case now submits and receives its same-origin receipt on claim two at
  1,251 ms: six fewer claims and 1,780 ms less controlled policy delay. Ordinary partially admitted
  batch fallback, genuine twenty-attempt exhaustion, deadlines, independent clocks, NEW progress,
  absent forecasts and concurrent quota admission retain their semantic coverage. Complete review,
  affected checks and publication are complete; the subsequent original hosted workload still fails.
  This local improvement does not establish original scale acceptance or the unchanged comparative
  benefit.
- The maintainer approved the public finalization type correction, three awaitable disposal
  methods and exported WS first-refusal callback rename. The callback keeps its function type,
  default and authorization behavior; verified callers and affected support enter complete
  closure. No legacy adapter or migration path is selected. Source review and original acceptance
  remain independent requirements.
- Full source/support closure, whole-branch review, original scale and benefit, readiness and manual
  merge remain open. The pull request owns current source, CI, test and run outcomes; do not copy
  delivery history here.

## Next two useful slices

### 1. Establish original capture-off fifteen-agent acceptance

The readiness change and its controlled two-claim proof are reviewed, verified and published.
The original hosted workload has executed once and failed. Preserve its complete current evidence;
another unchanged acceptance retry is not selected. Retain the existing limiter and circuit defaults,
durable authority, deadlines, ACK semantics, twenty genuine processing attempts and ordinary
operational failure policy.

The reviewed local Playwright/Chromium diagnostic has executed once and passed native predicates,
but its positive RTC completion chains do not exercise the failed WS family. Preserve its exact
source, capture quality, producer/export custody and carrier joins; do not repeat it unchanged.

The same-source hosted WS diagnostic has executed once and failed, with complete native exports
and owned cleanup. Preserve its existing positive joins across exact server ACK count, distinct
new receipt identity and SDK receipt admission. Four complete receipts have proven late send-work
reservations; the other complete receipts and failed subjects retain separate unresolved boundaries.
The source trace now distinguishes admission, dequeue and send identities and positively fills the
preceding sixteen-claim serial page. The prepared-send commits precede the later run, but neutral
holds can move eligibility. Neither continuous queue wait nor wrong selection is established.
Preserve actual failed wait returns and conservative inherited-deadline bounds; outbox observations
are not immediate enqueue-return timestamps and deferred publication is not individual send timing.

The narrow private phase measurement has executed once. Preserve its positively complete pages,
exact claim identities and independent API epoch, monotonic duration and stored-reservation clocks.
Serial callbacks dominate those pages and canonical lookup contributes a small share. The costly
admission/dequeue callback remainder is still unpartitioned. Recover the existing outbound
commit-phase and sender-queue diagnostics before adding measurement: distinguish admission read
and decision, fenced commit, queue wait and other callback work using their actual source owners.
Keep the original metrics sink active. Reuse the existing bounded, guarded, deferred observer and
safe codec for the smallest missing measurement; do not create another capture framework or
duplicate admission algorithm. Direct semantic tests, affected compilation and complete independent
specification/quality review precede a changed diagnostic. Bind immutable source and measurement
overlay separately; another unchanged native workload is not selected.

Recorder close and collector EOF establish custody only; ordinary shutdown does not prove producer
completion. Native control-snapshot coverage and recorder/export equality remain distinct from
complete producer parity. Partial capture or missing observations cannot prove absence. SQL
selection/order, admission-context propagation, native/socket timing and shutdown rewrites remain
outside this measurement. No limiter increase, speculative heap hunt or production fix is selected.
Earn a failing-first repair only from a positively located defect.

Retain the frozen audience, tree, six-shot cadence, lifecycle events, exact receipts, seven samples
per actor, storage and metric limits, deadlines, all native predicates, source provenance and owned
cleanup. Private diagnostics cannot replace original uninstrumented acceptance. Preserve capture-off
settings and retain complete failed evidence. If fifteen fails, analyze the exact current failure and
require a meaningful failing-first repair before another workload. Thirty and fifty remain gated by
fifteen; unchanged comparative benefit and final whole-branch review remain open.

### 2. Preserve truthful ALM submission evidence and direct boundaries

Preserve the reviewed native-send evidence repair: immediate native throws retain attempted
failure facts and original detail; pre-native exceptions stay unattempted; queued failure keeps
its existing typed result. Ordinary same-message/deadline retry, exactly one settlement, direct QR
throw behavior and the verified async consumer remain unchanged. Its focused and affected checks
already pass; do not repeat them solely for a plan update. Owned completion boundaries remain
required in tests instead of arbitrary settlement flushes.

Preserve the implemented, approved WS callback and protocol authorization names, their function
types, omission default, original-message handling, first-refusal precedence and lazy relay read.
Their verified callers and affected support pass the selected semantic, type and browser-boundary
checks. Its review and publication are complete; preserve that evidence while whole-branch closure stays open.

Preserve the completed receipt cleanup: the immutable projection precedes external settlement,
mandatory ACK processing precedes optional guarded observation, and receipt admission calls the
canonical writer directly. Full-file specification and quality review, sensitivity cases, focused
semantics, consumer types, browser boundaries and bundle checks pass. No forwarding alias, duplicate
guard, old-path module or migration code remains.

Complete the implemented, approved queue-entry creation-clock closure at its real service owners.
Preserve enqueue-time UTC timestamps and submillisecond precision; message creation time and numeric
AL clocks are not replacements. Keep one deterministic converter with explicit owned instant input.
The maintainer approved the converter's required instant and required WS/RTC creation-clock inputs,
with the concrete internal AppInbox key/creation changes and no legacy adapter. Default factories
retain enqueue-time UTC precision; direct consumers supply the new inputs. Meaningful explicit
non-UTC nanosecond tests fail before the repair and pass afterward. Focused behavior, affected
consumer typechecks and native rollback checks pass; remaining complete caller review is open.
Complete verified WS, RTC and AppInbox caller/test closure, canonical materializer ownership,
full-file review and affected checks before publication. The changed RTC owner also has a separate
approved quota-clock contract: preserve the existing RateLimiter policy and keep quota, numeric AL
and precise creation clocks distinct. Apply the required quota clock at actual admission and
nonspending retry forecasting. Prove that advancing AL time alone does not restore quota, quota
time does restore it at the unchanged boundary, and successful queue creation retains precise UTC
nanoseconds. Quota refusal must not create a row; disposed and circuit gates retain precedence.
Include the nearby reader import repair and recursively
affected support. Do not reopen already approved controller types or awaitable disposal.

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
