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

- Original capture-off fifteen-agent acceptance remains FAILED; thirty and fifty remain gated.
  Local source tests or recorder-on traces do not repair that failed execution.
- The valid 5.40% shared-throughput comparison remains failed against the unchanged 5% allowance.
  Conditional IndexedDB scheduling benefit does not establish native or universal performance.
- The approved guard observation remains inconclusive for a guard defect or causal repair. Partial
  capture cannot prove that an unobserved guard never ran. Do not repeat that diagnostic workstream.
- Independent source review identifies two acceptance defects: serial sampler reads accumulate
  latency beyond the nominal schedule, and lifecycle receipt predicates compare cardinality without
  proving every frozen player's identity. Meaningful failing-first cases and healthy controls expose
  both defects through current command/runtime/evaluator owners. Neither establishes the hosted
  delivery-timeout or performance cause.
- Six- and eleven-browser ALM match diagnostics have no hosted passing evidence. The user has
  selected them using the same match workload. Existing numbered RTC catalog entries are different
  workloads and do not prove these cohorts. The selected hosted workflow and native harness must
  admit the actual cohort and strengthened manifest before either checkpoint can execute.
- Full source/support closure, whole-branch review, original scale and benefit, readiness and manual
  merge remain open. The pull request owns current source, CI, test and run outcomes; do not copy
  delivery history here.

## Next two useful slices

### 1. Close the independently proved acceptance defects

Use TDD and the existing shared-test scale fixture, authored command runtime and native group
assertion evaluator. Preserve generic loop semantics. Schedule seven sampler slots at nominal
0/5/10/15/20/25/30-second offsets using current wait/parallel primitives; bind every budget check to
its own exact stats result so overlapping reads cannot overwrite evidence. Retain all 105 readings,
transient failures, missing/cancelled evidence refusal, every budget and actor attribution.
Distinguish a read's initiation from acquisition/completion, retain actual owned timestamps and do
not invent a timing tolerance or claim that start timestamps prove completion inside thirty seconds.

Use each frozen player's actual rtc.connect session result for the native identity comparison.
Require unique complete START and END expected/confirmed sets, zero unconfirmed and all existing
state/mode/arrival/completion guarantees. Reuse a single pure set comparison at the current local
assertion and native cross-role aggregate boundaries; missing, duplicate or ambiguous identity fails
closed without shrinking the cohort. Reordered identical sets remain valid. Extend current typed
contracts/schema at those owners only where existing literal predicates cannot express the required
comparison; keep old operators/defaults compatible and introduce no alternate evaluator, new live
read, migration, legacy adapter or dependency.

Prove each defect with independent runtime/evaluator RED and healthy controls before GREEN.
Review/remediate every changed human-authored file completely and recursive changed support closure;
independent untouched code stays outside. Use affected schema, command, recipe, cadence, catalog,
maintained type, build/boundary and exact changed-range checks, then independent specification and
quality review before coherent publication. Regenerated manifests are strengthened acceptance inputs
with their own identities, not byte-identical versions of old frozen executions. Preserve all
original participant, traffic, receipt, storage, deadline, policy and budget requirements.

### 2. Establish six- and eleven-browser diagnostic checkpoints

Reuse that same canonical recipe and manifest producer for six and eleven browsers under the
existing diagnostic catalog/path. Preserve one director and N-1 frozen players, tree selection
with meshMinSize N+1, six exact leader-ACK shots per player, two full-audience lifecycle events,
seven sampled readings per actor, original thirty-second workload/ACK/TTL, all setup/barrier/outer
allowances, receipt/security rules, metric/storage budgets and native fail-closed evidence.
The expected diagnostic work is 30/60 shots and 42/77 readings at six/eleven respectively; these
are their own full-cohort checks, not reduced evidence for fifteen.

Use TDD for cohort/catalog selection and generated requirements; keep original 15/30/50 acceptance
positions and identities distinct. Close the existing hosted workflow and native harness over the
selected canonical manifest, full cohort, tree setting and complete strengthened predicate set;
remove obsolete fifteen-only source/hash/count assumptions. Retain source freezing, exact
provenance, native acceptance, cleanup and every existing lifecycle ceiling. Prove admission and
provenance for six/eleven and refusal of mismatched or unrelated inputs before implementation.
Publish reviewed candidates before bounded runs through the existing hosted lifecycle. Verify exact source, declared/effective inputs, complete cohort and shared
concurrency immediately before dispatch. Preserve originals once and perform canonical analysis
with truthful completion, receipt, sampling, storage, loss and cleanup limits.

Run six first to establish whether the complete smaller match works, then eleven when that result
supports progression. A failure earns exact evidence review and an independently testable repair,
not an unchanged-source retry. Compare failure boundaries across cohorts without treating unequal
workloads as a speedup or capacity proof. Select observation flags deliberately and record their
cost/limits; diagnostic captures cannot replace original capture-off acceptance. Passing six and
eleven does not waive fifteen, thirty, fifty, the failed performance gate or final review.

## Later outcomes and completion

Keep later work outcome-shaped. Finish the original capture-off fifteen-agent acceptance, then
unchanged thirty and fifty, and satisfy the original comparative benefit gate. Earn any intervening
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
