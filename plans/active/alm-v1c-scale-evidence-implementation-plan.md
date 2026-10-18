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
  Record unresolved findings and their next measurement; a passing workload does not erase a
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
  barrier, the 45-second recipe setup barriers and the 5,000 ms allowance of every other HTTP request unchanged.
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
  300,000 ms; own tracks 64; ordering snapshots 512; overloaded is false; congestion dropped is
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

1. **Formation-tail delivery:** measure the current promotion-to-browser path, then use TDD
   to repair the positively located queue-service bottleneck. Reuse existing queuebox and ALM
   mechanisms; preserve every event, frozen audiences, causal fences and failure recovery.
   Compare the same queued burst with a late promotion before and after the repair, including
   stale claims and transient failures at the affected boundary. Validate affected packages
   and the unchanged local 15 → 30 → 50 workload before hosted timing-off acceptance. Keep the
   ≤2 s formation-tail target explicit; report any remaining delay without weakening acceptance.
2. **Remaining shared-mechanism audit and next measured repair:** recover current consumers of
   the D278 candidates and D298's unread rate adjustment, prioritizing the measured formation-tail
   delivery delay below when selecting the next owned repair. Include the demonstrated large-result
   certification limit and headless shutdown race below; passing native acceptance does not close
   either finding. The AL checkpoint writer,
   serialized chains, keyed limiter, abort scope, UTF-8 length and repeating-run copies remain
   outcomes until that audit selects a concrete task.

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
≈350 ms each behind the password derivation). The window, the cadence, the allowances and every
assertion are unchanged. Hosted 15 from the branch passes through `Run GitHub Free Distributed Recipe` in
`hetzner-control` mode (15/15, 231/231, run 38662616218); the all-on-one-VM Hetzner run still fails at RTC
readiness because the co-located host stalls once the browsers start (recorded in the proposal §1.7).

### Step 2c: the acknowledgement tail at scale, the control plane at 50, then 15 → 30 → 50 hosted (merged, #666)

Step 2b is merged (#664 as `9f71ea2`). On branch `claude/alm-v1c-step-2c-ack-tail`, from the measured 50-agent evidence (proposal
§1.8): the shot-ACK tail grows with depth (p50 49 ms at depth 1, 1.5 s at depth 3, 1.8 s at depth 4)
and completes in steps (≈1.25 s, then every 0.5 s), which is a retry or acknowledgement timer, not
queue draining; attempts per acknowledged shot equal the sender's degree, so every shot still floods
the tree; the per-session 20/s limiter refuses 4,793 hand-offs at 50 (1,228 at 30, 72 at 15) on every
agent, the director included, and its imposed wait is unmeasured. The survey located both: the stepped completion is the per-session 20/s hand-off
limiter whose 250 ms buckets forecast refusals of up to 1,251 ms (exactly 20 ACKs leave, then a gap),
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
(50/50, 231/231, shot-ACK p50 33 ms against 1,290 ms on the step 2b head, the end event
acknowledged with ≈3 s of the window left), 15 and 30 pass locally, hosted 15 passes through
GitHub Free `hetzner-control` (231/231, shot-ACK p99 190 ms against 1,326 ms). Hosted 30 fails
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
connect 64.9 → 54.9 s, director-status 4.3 s and 15 timeouts → 2 ms and none, setup-complete 8.9 s → 0.27 s,
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
sign-in 4.1 s, traffic-ready 35.4 s from run creation (62.9 s) and one signalling hop 74 ms; the uninstrumented
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
   step 2g journal confirms a 73 ms promotion followed by 8.95 s before its group-state notification
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
