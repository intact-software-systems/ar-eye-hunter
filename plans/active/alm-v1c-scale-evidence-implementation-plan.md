# ALM V1c Scale Evidence Implementation Plan

## Goal and ownership

Deliver the original 15/30/50-agent match-payload acceptance and prove the selected fairness
benefit. Implement [the V1c design](../../playground/alm/alm-v1c-design-proposal.md) and D183 in
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
  shot arrivals, both lifecycle events, all 15 completion arrivals, 105 readings and all 73 native
  coordinator predicates evaluated and passed. Larger cohorts retain all their declared assertions.
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

- Original capture-off fifteen-agent acceptance remains FAILED: 82/84 shots, 28 director arrivals,
  two complete player leader receipts and all 73 coordinator predicates unevaluated. Thirty and
  fifty remain gated. The failed original execution is not repaired by local interoperability or
  observation tests.
- Current source release, API medium-scale and formation CI pass. Earlier native setup timeout
  operations and causes remain unknown; current CI does not establish that those causes were fixed
  or that original scale acceptance passed.
- The reviewed recorder-on observation remains FAILED: 80/84 shots, 54 diagnostic director arrivals,
  twelve exact leader receipts, 98/105 samples and all 73 coordinator predicates unevaluated.
  Source/manifest provenance, timing=true/phase=false, safe retained rows and owned reaping are
  verified. Partial capture and unverified durability constrain absence claims. Recorder and I/O
  costs prevent using this run as original capture-off acceptance or a matched performance arm.
- The exact observed director WS ACK returns unauthorized despite matching director peer/control
  identities and authorized socket scope. The completed owner survey narrows the remaining paths
  to connection-currentness versus aggregate first/repeated validation. It earns no defect, cause
  or relationship to the observer timeout. Root review and the minimum design remain prerequisites
  for the next source slice.
- The valid 5.40% comparison is still failed and unwaived. Original scale acceptance, comparative
  benefit, full changed-source closure, final whole-branch review, readiness and manual merge remain
  open. There is no selected extra benchmark, quota/capacity diagnostic, unchanged hosted retry,
  speculative repair or deadline/cohort relaxation.

## Next two useful slices

### 1. Discriminate the closed ACK rejection guard

Subject to root's reviewed minimum design, use the existing optional receipt observer and safe
exporter to retain which actual guard rejected the matching ACK: connection-currentness versus
aggregate first/repeated validation. Preserve the actual validation pass and all coexisting closed
reasons. Reuse already-owned decoded identity, read facts, validation results and return disposition. Do not rerun authorization/validation, add a read, clock or durable
write, reconstruct missing state, or infer a guard from prose. Keep unknown facts explicitly unknown.
The exact contract and minimum source/test/support owners come from that reviewed design; this
plan does not invent new APIs.

A fresh implementer first exercises the existing real ingress/aggregate owners and actual
producer-to-recorder path. Independently prove unchanged security/refusal behavior and mandatory
effects before establishing meaningful missing-observation RED. Then implement the smallest closed
projection and safe retention, GREEN and refactor. Absent, throwing or mutating observers preserve
results, original failures, effects and configured deadlines; disabled capture avoids diagnostic allocation,
copies and clocks. Keep immutable facts and publication at the existing owned effect boundary.
Retain only closed safe facts under the current observer/exporter contract, excluding credentials,
application payloads, raw headers, environment values and arbitrary error prose. Preserve the current
line bound, exclusive 0600 files, unsafe/oversized/trailing-record refusal, loss/EOF accounting and
original child exit/reap ownership.
No public delivery, wire or persisted-format change is selected.

Review and remediate every changed human-authored file in full; every support file changed by that
remediation enters closure recursively until closed. Independent untouched code remains outside
closure. Remove affected obsolete or duplicate paths; any independently required public migration
or retained legacy boundary needs explicit maintainer approval and its focused registry entry.
Run direct real-owner/retention tests and affected package/API/type checks, then proportional exact
changed-range style, coupling, formatting and navigation checks. Classify failures before edits;
checker tolerance never waives a touched-file violation. Obtain fresh specification and quality
review before coherent publication. The controller owns source review, scope decisions and dispatch;
implementers do not dispatch subagents or hosted runs.

### 2. Observe the changed capability once on frozen fifteen

Only after the first slice's independent approval and publication, select one bounded hosted
observation through the existing all-local lifecycle on the frozen original fifteen-agent workload.
Keep Chromium, registration-before-login, setup capture off, RTC capture off and the existing
WS-observation selection, with truthful timing=true/phase=false. Verify exact published source,
unchanged manifest, effective flags, draft/manual-merge state and absence of an active conflicting
run immediately before dispatch. Preserve every participant, traffic, receipt, storage, deadline
and acceptance requirement; there is no unchanged-source retry.

Acquire originals once, preserve immutable custody and use existing canonical analysis on the new
bytes. A bounded analyst and independent evidence reviewer verify retained guard discrimination,
exact ACK/subject/origin/director joins, refusals, sampling/receipt/storage/native acceptance facts
and cleanup. Separate producer/observer clocks, partial/lost capture, failed from unevaluated
predicates, diagnostic arrivals from canonical workload proof and reaping from durable completeness.
No causal timeout or speedup claim follows merely from record order or one observation.

An actual supported defect then earns its independent semantic RED and the smallest corresponding
repair through current owners, followed by affected validation, specification/quality review and
publication. Otherwise report the precise remaining gap promptly; do not turn uncertainty into
another diagnostic workstream. Recorder-on findings do not replace original acceptance or benefit.

## Later outcomes and completion

Keep later work outcome-shaped. Finish the original capture-off fifteen-agent acceptance, then
unchanged thirty and fifty, and satisfy the original comparative benefit gate. Earn any intervening
repair from independent evidence and meaningful failing-first behavior; keep only the next two
useful slices concrete. No extra benchmark, quota/capacity exploration, unchanged hosted retry or
relaxed acceptance is selected.

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
