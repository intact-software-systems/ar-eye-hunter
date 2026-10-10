# ALM Release 7 V1c: scale evidence with match payloads

V1c implements D183's 15-, 30-, and 50-agent consumer proof after V1b-ii.
Reusable recipes and acceptance evidence belong to `packages/shared-test`;
the black-box app chooses manifest size, topology, and destination. ALM delivery
and retention policy, public delivery contracts, persisted formats and dependencies
remain unchanged. The queue scheduling prerequisite below changes how AppInbox
shares serial service between lanes, without changing reservation authority.

## Workload

Each isolated room has one appointed director (manifest role `sender`) and
14, 29, or 49 players (role `receiver`). Every page subscribes to the AR Eye
director topic and its intent/event type IDs. Existing ensure-group, membership,
RTC readiness, refreshed director status, and distributed barriers establish the
workload boundary before counters reset. Tree topology and the existing
45-second readiness allowance remain. The initial socket connection explicitly
receives this allowance in the Rallar configuration; the subsequent RTC readiness
phase separately owns a 45-second wait. The outer connect timer ends before that
readiness wait begins, so these are phase budgets, not a combined setup deadline.
Each phase fails when its allowance expires; the 30-second measured workload and
330-second terminal allowance remain unchanged.

The director sends a match-started event, each player sends six shot intents at
five-second intervals, and the director sends a match-ended event after the
workload completion barrier. A separate sampler runs on every page during this
30-second window, taking seven readings at five-second intervals.

The applied deadline encloses the complete workload: lifecycle sends and ACK reads,
player shot sends and leader receipts, the completion barrier, and exact arrival
checks must all complete strictly before 30,000 ms. A nested one-group `parallel`
command owns this deadline; its timeout interrupts overdue work and native group
assertions also reject a duration at or above the deadline. The sampler runs in
parallel after the shared traffic-ready barrier and must complete all seven
readings even when traffic finishes early. Existing
`parallel`, `loop`, `stats`, `messages.send`, `messages.observe`,
`messages.receipts`, and `messages.received` commands own execution.

Payloads use the current `RallarDirectorRelayEnvelope<RallarGameEnvelope<...>>`
wire shapes and AR Eye match/shot contracts. Session and envelope sender IDs
come from the connected page. Match lifecycle specimens share a coherent
match identity and carry representative baseline/results data; they are fixture
facts, not a simulation of game authority. Contract tests reference the app's
types without importing app implementation into the reusable package.

Effective delivery policy is volatile, at-least-once, 30-second TTL,
`rtc-with-ws-fallback`; shot intents request `group-leader` ACK and match events
request `all-logical-recipients` ACK. The harness currently infers purpose from
addressing, so explicit policy tests prove these effective settings, not the
app's command-purpose defaults. V1c replaces the old 20-Hz position-only stream
in manifests 19–21 with this declared reliable cadence; unrelated stream
manifests retain their existing workload.

## Acceptance and evidence

Every shot handle must become acknowledged with one confirmed leader and no
unconfirmed recipients. Each director lifecycle handle must become acknowledged
with exactly N−1 expected and confirmed recipients and no unconfirmed recipients.
Type-targeted received-message evidence must contain six shots per player at
the director and both lifecycle messages at every player. Counts alone do not
prove arrivals: the director derives its exact player-session audience from the
acknowledged start receipt, then requires distinct sequences 1–6 from each
session with matching envelope and shot identities. Every player matches the
exact started and ended specimens from the appointed director, including the
coherent match baseline/results and revision facts. Admission alone is
insufficient. Readiness and barriers fail the run if the complete audience is
not ready.

Every sampled reading and the final reading enforce the declared budgets:

| Metric                                        |     Budget |
| --------------------------------------------- | ---------: |
| Own admissions                                |      1,000 |
| Own bytes                                     |  4,194,304 |
| Counted oldest age                            | 300,000 ms |
| Own tracks (`usage.tracks`)                   |         64 |
| Browser ordering snapshots across both stores |        512 |
| Overloaded                                    |      false |
| Congestion dropped                            |          0 |

These are observed bounds, not continuously measured peaks. Inbound count and
bytes are recorded separately: outbound admission limits do not promise a hard
receiver cap. Declared runtime limits are also checked, preventing an accidentally
relaxed configuration from validating the workload. Counter reset after setup
separates the workload from membership/director writes. AL admission storage and
non-probe AL work storage remain zero; idle readiness probes are recorded
separately and excluded explicitly.

Native distributed group assertions address each role's unique sampler result,
final stats, storage reading, and delivery evidence. They require all frozen
participants, seven completed samples, zero sample failures, and no cancellation.
Transient over-budget or absent readings fail even when final usage is zero.
The existing evaluator emits exact `controller-NN` per-agent evidence plus
missing/violating agent IDs. The native all-match assertions also retain complete
workload and arrival
results, so incomplete nested commands fail even if final stats are healthy.
No controller-number role guessing or second assertion engine is added.
Observation-event tails may be trimmed and are
diagnostic context; command results and group assertions are the acceptance
surface.

## Manifest ownership

The catalog imports `createAlmScaleManifestEntries` directly. That app owner
selects 15/30/50 frozen participants, the canonical group, tree topology with
`meshMinSize = N + 1`, live execution, synchronized start and extended status.
It consumes `createAlmScaleRecipes` from `packages/shared-test` for recipes,
native assertions and authoritative metadata, exposed unchanged as `almMetrics`.
The obsolete extended multicast/storage wrapper is removed; conformance
manifests 18/22 and ordinary multicast manifests retain their workloads.

The 330-second outer terminal allowance covers setup and explicit ACK waits;
it does not relax the strict complete-workload deadline or receipt TTL. The
manifest load estimate counts accepted logical messages: six leader-targeted
shots per player plus two lifecycle fanouts, yielding 112/232/392 logical
recipient deliveries at 15/30/50 participants. This is a match workload estimate;
`streamFrames` and the former 20 Hz/600-frame metadata are absent.

## Queue scheduling prerequisite

An authenticated join diagnostic exposed a retry selected 52.66 seconds overdue
after 72 serial NEW handlers. The prior AppInbox policy drained up to 1,000 entries
per lane before visiting the next lane. Larger reservations do not provide
parallelism: handlers execute serially and claims are released after the batch.
Bounded turns must provide retry service independently of pressure observations.
This scheduling defect does not establish that a repair resolves every observed
room-readiness failure; latest accepted topology remains a separate acceptance.

### Ownership and dataflow

`DequeueController` accepts an optional lane-budget callback that returns one
complete snapshot keyed by its existing `Reservator`. Each lane budget has
positive safe-integer `maxToReserve` and `maxNumToDequeue` fields. Numeric settings
retain their current per-lane meaning when no callback is supplied. Read the
snapshot once per invocation, before claiming entries, and reject malformed
budgets before claims. Each normal reservation is clamped to the remaining lane
quota. FINALIZATION keeps its existing first, separate recovery reservation;
normal service stays NEW → FAIRNESS → RETRY → TIMEOUT. The controller owns no
database pressure queries, cache, refresh timer, or additional rate limiter.

Charge the full successful reservation before preprocessing, computation, release
or completion callbacks. Filtering or a later exception cannot restore consumed
quota. The budget bounds claims, independently of successful results.

Finalization recovery returns the queue key, independently of the domain
computer's result type. Type the finalization computer as returning `K` and the
aggregate success value as `T | K`; normal completion/release callbacks remain
exactly `T`. Remove the factory's unchecked `key as V` claim. Runtime recovery
results remain keys, and verified repository consumers need no different runtime
behavior. This is a public type-contract correction: external callers that treated
every aggregate result as `T` may need narrowing. Do not retain an unsafe cast,
compatibility adapter or custom collection solely to preserve that false promise.

`InboxQueueReader` owns the pressure state for its lifetime. Its callback travels
through `QueueMessageReader`, `QueueBoxUtilities` and
`createDefaultResourceInboxDequeuer` to the controller. Only the exact singleton
APP_INBOX scope selects this policy; unrelated type sets and outbox consumers
retain their existing limits. Keep the callback contract with the controller and
the queue-specific policy with the reader. Add no compatibility aliases, retained
alternate scheduler, dependencies, migrations, or new shared count API.

### Initial policy and bounded observation

All reservations stay at one. The fallback service quotas are one per normal
lane. An observation containing at least two eligible due retries increases the
RETRY service quota to two; other quotas stay one. Two is the smallest unequal
positive service quantum and an initial hypothesis to measure, not a latency SLO.
FAIRNESS remains a distinct recovery turn over the overdue subset of RETRY;
observations never create ownership or change retry delays or attempt limits.

Use the existing RETRY work-page port with page size two. Follow its opaque cursor
after each successful refresh and restart at null after the end. A page is an
observation in backend order, not an exact queue count. Count only entries in the
requested APP_INBOX scope with RETRY status, shared expiry validation passing,
attempts below the unchanged retry policy, and an explicit `nextTs` due at the
captured observation time. Missing due timestamps conservatively underobserve;
do not change differing backend reservation behavior. Do not sum old pages or
double-count FAIRNESS as an independent population. Partial or empty observations
cannot establish absence and never remove a lane's service opportunity.

The provider uses the repository `RateLimiter`, initially a 1,000-ms window with
one admission. This is a measurement setting; quarter-window buckets mean it is
not an exact one-second refresh schedule. Use the existing injected clock when
provided. Keep one refresh in flight and return cached budgets promptly while
refreshing. Cold, stale, failed or stalled observations use bounded fallback
quotas. Successful observations are fresh for one configured window; invalidating
or aging a sample cannot restore the old 1,000-NEW drain. Refresh is demand-driven,
has caught/reported failures, and introduces no background timer. Retain no
result across queue/type ownership changes.

### Proof and decision boundary

Compare the same real queue and reader workload under four configurations:

| Configuration          |   NEW | FAIRNESS |  RETRY | TIMEOUT | Pressure reads |
| ---------------------- | ----: | -------: | -----: | ------: | -------------- |
| Current drain          | 1,000 |    1,000 |  1,000 |   1,000 | None           |
| Fixed fallback         |     1 |        1 |      1 |       1 | None           |
| Adaptive               |     1 |        1 | 1 or 2 |       1 | Rate limited   |
| Fixed catch-up control |     1 |        1 |      2 |       1 | None           |

All four reserve one entry at a time. Exercise cold start, sustained due retries
with replenished NEW, recurring single-retry rounds, backlog disappearance,
backlog returning after a cached zero, and future/expired/exhausted rows hiding
due work in a partial page. Do not prewarm adaptive pressure with oracle knowledge.
Record durable completion order and attempt counts, lane service and engine
passes, empty/nonempty reservation operations, pressure reads and their maximum
concurrency, and total backend operations including observations. Memory counters
prove semantic ordering and operation counts, not PostgreSQL performance. Use
existing IndexedDB operation observers where applicable and retain backend
measurement artifacts outside tracked source.

Required semantic outcomes are due-retry completion before trailing NEW exhaustion,
positive NEW progress during retry catch-up, eventual engine re-entry over remaining
work, and unchanged authority, NotReady neutrality and delayed-retry readiness.
The adaptive observation must demonstrate an incremental benefit over the fixed
catch-up control at equal durable work, including its polling cost. Merely beating
the current drain or fixed quota one does not prove counts help. Report cold-start
and stale-sample penalties explicitly. If that benefit is absent, revise the
pressure hypothesis before publishing it as an improvement; do not silently
substitute a different final design or weaken acceptance.

### Observed local tradeoff

The actual IndexedDB queue observer records the following logical operations and
service passes. Every arm completes 12 NEW entries and 12 retries, with NEW attempt
one and retry attempt two. Sparse rounds include admission and seed operations;
backlog totals exclude initial seeding and include handler-driven replenishment.
Compare arms within each workload, not totals between workloads.

| Measurement                               | Current drain | Fixed one | Adaptive | Fixed RETRY two |
| ----------------------------------------- | ------------: | --------: | -------: | --------------: |
| 12 singleton-retry rounds: operations     |           152 |       128 |      129 |             140 |
| 12-retry backlog: operations              |            63 |        79 |       86 |              85 |
| Backlog: retry completion pass            |             1 |        12 |        7 |               6 |
| Backlog: NEW completed before first retry |            12 |         1 |        1 |               1 |

Adaptive avoids 12 empty retry probes at a cost of one pressure read across the
sparse rounds, saving 11 operations against fixed RETRY two. Fixed one remains
cheapest there. Adaptive catches backlog faster than fixed one in service passes,
while cold fallback costs one pass and one pressure read against fixed two. A
return after cached-zero pressure shows no adaptive advantage over fixed two.
This supports conditional service and probe benefits, not a universal improvement,
SQL savings, native IndexedDB request/transaction counts or elapsed-time latency.

### Observed hosted limit and next measurement

A subsequent diagnostic privately matched a failed JOIN to its first NEW
execution: queue age was 35.219 seconds, beyond its unchanged completion wait.
Sixteen preceding NEW handlers occupied 30.818 seconds of that interval;
seven WebSocket authorization handlers accounted for 25.944 seconds. Exact
admission records and queue-age estimates support already-ahead work, with no
observed newer admission overtaking this JOIN. Every captured processing attempt
was NEW/one. Lane turns therefore address retry starvation but cannot themselves
bound waiting behind expensive NEW handlers. Changing RETRY weights cannot
resolve this particular observation.

Canonical queue-key translation matched all seven WebSocket handlers to their
inner phases. Compute and complete-result validation occupied 20.517 seconds,
79.08% of their combined handler time; reads and writes occupied 10.35%.
These are elapsed asynchronous phases, not CPU measurements. The computation
prepares snapshot pages, outbox rows and immutable provenance; validation
independently recomputes the complete result. Their internal materialization,
canonical serialization, cryptography and scheduling costs remain unmeasured.
Measure those exact boundaries with real frozen inputs and real cryptography
before selecting a repair. Preserve complete validation, generation/authority
guards, exact receipt/outbox/provenance bytes and pretransaction hashing. Native
snapshot/session/page cardinalities are uncaptured and must not be invented.

The smallest existing frozen fixture has one live own session, one snapshot page
and three outbox rows. Thirty repeated real compute/assert pairs preserve complete
output bytes. Bootstrap and reconnect median pairs take 2.5722 and 2.3314 ms;
their six sequential digest completions occupy 6.84% and 9.84% of aggregate pair
time. Repetition, an unwrapped control and a V8 profile support this isolated
result. Digest completion does not dominate that fixture. The result remains
inconclusive for the deployed operation: actual cardinality, host load, GC and
continuation scheduling are not reproduced. No excess operation or performance
repair follows from the small result.

The subsequent native CPU/resource capture retains a valid process profile and
exactly correlated phases. A 48-second WebSocket envelope has 99.739% host busy,
33.545 seconds main-task runqueue wait and 88.886% CPU-pressure delta. Thirteen
matched handlers spend 86.42% of elapsed handler time in compute/validation.
PGlite occupies 82.171% of active profile samples, but 99.380% of its samples
lack a repository caller. The awaited database boundary can lose caller context;
presence in a phase window does not assign execution to that request. Profile
delta weights exceed measured CPU under contention and cannot be charged as CPU
time. Native cardinality, query ownership, primitive digest CPU and leaf CPU
quota/throttle remain unknown.

All 156 recorded transactions are NEW/one/ok. Six exact JOIN paths return HTTP503
before their later handler/transaction succeeds; no final durable result fetch
was retained. Two generic browser socket failures lack an exact server request
identity bridge. All 15 setup recipes fail and zero of 73 group assertions are
evaluated. This supports host contention and database execution presence while
leaving the owning repair inconclusive. It does not justify changing lane
weights, concurrency, complete validation or deadlines. Normal service settings
were restored and all exclusively created capture files removed. Profiling and
logging can perturb setup; ordinary acceptance remains required.

### GitHub runner comparison

The requested existing GitHub Free workflow placed all 15 browser agents on
GitHub while API/control remained on Hetzner. Seven agents failed the unchanged
five-second ensure-group request; eight remained incomplete and zero of 73
assertions were evaluated. Actual runner CPU/memory telemetry was not retained.
Moving browser agents alone therefore did not demonstrate setup or ALM benefit.

The full-stack measurement places API, control, SPA and 15 isolated browser contexts
together on one standard GitHub runner. Reuse the existing full-stack Playwright
lifecycle, standalone headless worker entry and generic manifest operator. The
local lifecycle must select the standalone headless SPA before startup; the
operator SPA does not serve its `/headless/` entry. Preserve the operator SPA's
existing default for other consumers. The manifest operator now exports direct
stream bytes and snapshots on failure as well as success, while explicitly
leaving stream completeness unverified. The caller owns fresh recorder storage
and unbounded runtime retention; bounded previews cannot prove this workload.
Before worker registration completes, retain available control/recorder evidence
and explicit missing distributed evidence, since no distributed run exists yet.
After operation completion or failure, await bounded owned-worker completion or
stop/reap before the canonical final export. Late arrivals must settle before
snapshot/stream completeness checks, while the original operation error remains
primary if lifecycle preparation or export also fails.
Keep the committed manifest, distinct principals, roles, tree configuration,
storage/delivery budgets and all fixture deadlines unchanged.
Canonical native terminal/rollup and complete 73-assertion evidence decide
acceptance, independently of worker exit or analysis readability.

The corrected local rehearsal registered all 15 distinct principals/clients,
then failed during member setup before evaluating group assertions. Complete
recorder bytes and native arrival/latest-result counts were verified offline.
This was a dirty-tree rehearsal before the final producer-lifecycle correction;
its source hashes remain explicit, and it is distinct from the subsequent
immutable-source GitHub result. The correction passed late-arrival/error-precedence TDD and fresh
scoped re-review without another domain run.

Capture actual CPU/memory/disk, runtime/browser versions, source/manifest identity
and safe effective configuration. Fresh ephemeral PGlite/local pubsub/local ICE,
loopback transport and browser/API co-location differ from the inherited host.
Thus the comparison tests an environment hypothesis without isolating CPU count
or proving the adaptive lane policy's elapsed-time effect. Preserve failed
native evidence and select a repair only from a demonstrated owning defect.

The actual all-local GitHub comparison at clean `d80ff3a` used four CPUs and
about 16 GiB RAM. All 15 identities were selected without blockers. The first
blocking player passed setup and reached traffic, then failed its 30-second
parallel window. Native terminal/rollup failed and zero group assertions were
evaluated. Worker completion preceded final export; recorder bytes and received
counts verify 74 results and 26,247 event records, with 46 latest command results.
The run demonstrates progress to traffic in this environment, with incomplete
acceptance. Analyse actual pending work, receipts, samples and canonical deadline
semantics before selecting a repair; the timeout label alone earns no relaxation.

The retained traffic analysis verifies successful setup prefixes for all 15
agents. One shot fails immediately with no attempts or recipients and a terminal
planner-drop for missing downstream forwarding candidates. Its exact routing
inputs were not captured. Ten other shots reach the director but their ACK
observations time out; arrival alone does not establish ACK return. Fourteen
samplers complete seven readings and stay within sampled budgets; the remaining
agent has six readings and no final output. Final storage and the native group
assertions remain unevaluated. Receipt waits and fixed delays consume the actual
shot-loop windows, so a timeout label earns no timer or fixture relaxation.

An independent public-leg regression establishes a route inconsistency for an
authorized originating leader send with an exact accepted tree and a missing
required RTC edge. Before the correction, the manager queues the retryable
send with no ready peers, while only an unrelated ready peer causes terminal planner-drop. The
earlier missing-immediate-peer assumption did not account for at-least-once
route waiting.

The explicit hand-over leg now observes canonical owned accepted children and
returns no-route when none is ready, after the existing authority, frozen
audience, QoS and leader checks. It returns the original envelope without a queue
entry, transport attempt or pending receipt. A ready required edge follows the
existing RTC path with the director alone in its receipt audience. Direct RTC
and hold legs retain their existing waiting behavior. Explicit authorization,
no-leader and QoS refusals, generic planner-drop terminal handling, frozen
identity/audience and original TTL remain unchanged. This corrects the existing
route-gap hand-over contract without another routing policy or fallback strategy.

Uncaptured original native inputs remain unknown. The regression and unchanged
generic fallback tests establish leg classification and strategy contracts,
without proving a new real-manager-to-WS receipt integration or the original
native cause. The unchanged candidate observation failed during group/member
setup before traffic. Three players timed out ensuring the group; eleven accepted
group-conflict responses and then timed out ensuring membership. The director
completed initial connection but lacks room-join completion and final output.
All 73 group assertions remain unevaluated. Authentication and fetch own separate
timeout scopes, so total command duration does not itself prove a late request
timer. Complete recorder evidence cannot supply uncaptured server phases or a
native route-benefit comparison.

The next measurement exposes existing HTTP/AppInbox timing through the same
local lifecycle. An optional all-local timing capture is disabled by default.
It enables the existing timing switches and observes API stdout through a small
owned stdio boundary, while the original API entry and Playwright readiness and
teardown remain canonical. Retain only validated timing events through a fixed
field/detail allowlist for actor/client/request and lane/attempt/phase/result
correlation. Raw stdout, authorization values, command payloads, arbitrary error
prose and complete environments are excluded. Safe counts and source/flag/exit
bindings distinguish missing or partial recording from observed stream completion;
neither proves every durable request settled. Capture failure remains visible
without masking the API exit or abandoning its owned process.

One reviewed diagnostic seeks actual setup ingress, queue/handler/transaction and
durable-result linkage before an owning repair. No logger/event producer, generic
process framework, duplicate evaluator, new public contract or dependency is
needed. Full-file closure makes API-server defaults visible at the app composition
boundary and passes required normalized inputs to the existing constructor. Its
full-stack and exhaustive config consumers retain the same default behavior.
The mode vocabulary remains internal; its exported type and verified behavior
remain canonical. Exact style dispositions record reviewed composition/JSON
boundaries and bounded capture cohesion through the existing registry. They
do not authorize a standards violation or waive later touched-owner review.
Preserve all normal consumers, fixture inputs, policy and deadlines during this
diagnostic.
Observation overhead and co-location remain confounders; async elapsed phases do
not establish per-request CPU or an isolated lane-policy improvement. Ordinary
uninstrumented acceptance remains required.

The captured GitHub diagnostic completed all 15 setups and linked all 90 setup
request families through qualified server timing. Capture remains partial and
durable completion unverified. Traffic queued 42 player shots plus the start
event; every sampler completed, but all traffic windows failed and all 73 group
assertions remain unevaluated. The retained five-second inter-iteration tails
start after child completion. The generic loop intentionally has that tested
contract; acknowledgement observation inside the fixture's serial loop therefore
adds its duration to the declared shot interval. Native ACK return latency remains
an independent measurement gap, and these failed runs do not establish speedup.

The reviewed correction composes existing bounded parallel branches for six
shot offsets, each with its send and exact-handle ACK observation. After their
join, the canonical six-iteration receipt-verification loop has no additional
interval. The player's enclosing command count and all assertion declarations
remain identical; receipt, identity, arrival, sample, storage and deadline guards
remain mandatory. Relative branch-registration jitter is possible. The existing
30-second window still rejects late ACKs, slow admission or incomplete lifecycle
work. The generic scheduler contract remains unchanged. Only canonical manifests
19/20/21 acquire the new workload topology; previous captured bytes remain immutable.

Meaningful RED observed 0/7/14/21/28-second starts under two-second ACKs. The
corrected public-boundary case observes 0/5/10/15/20/25. A controlled cohort executes
actual generated traffic/final commands through fifteen native page runtimes:
all fifteen recipes complete, 84 shots and two lifecycle events arrive, all fifteen
completion arrivals precede end, and all 73 canonical assertions resolve and pass.
Late/missing ACK, slow admission, incorrect audiences and cancellation remain
failures and late ACKs cannot resurrect end. Physical setup and RTC are outside
this test; admission/ACK routing and healthy metrics are controlled inputs.
This establishes cadence and evidence composition, not native cost or speedup.

Full authored/recursive closure and fresh independent spec/quality review passed.
The app manifest consumer now requires six concrete unique handles and coherent
sequences under unchanged policy/assertion sources. The workflow test independently
pins candidate digest `43db26dfab5a32b28f12b9d34db3be32b071a08139eee57f450807109072ecd3`;
current-byte copy/hash behavior and source-read classification remain unchanged.
The next default-off GitHub observation and remaining ordinary scale proof stay
separate from deterministic cadence and queue-operation comparisons.

The first default-off observation of this candidate failed before worker creation:
the native Playwright observer still pinned the predecessor manifest digest.
Actual reviewed bytes match the retained source/provenance; the independent
expected digest in that consumer is stale. No distributed run or traffic evidence
was created. The reviewed narrow correction refreshes this native fixture-version pin
while retaining current-byte hashing/equality, input restrictions and lifecycle
ownership. The actual failed guard is behavioral RED. After source review, one
new default-off invocation must execute past that exact guard for its GREEN;
subsequent setup/traffic/final outcome remains separately qualified. Existing
provenance and command-string tests alone cannot prove the inline native guard.
No additional equality abstraction or test mirror is required for this direct
version-pin correction. Fresh evidence review approved the complete finding and
qualified acceptance limits before dependent implementation. The native spec now
independently pins the canonical `43db26df…` bytes; complete source review preserved every
input/lifecycle/evidence guard. The subsequent default-off invocation executed
beyond that guard into registration, setup and traffic. Fresh independent evidence
review verified guard GREEN separately from the failed workload.

Thirteen players now issue all six shot starts near the declared five-second
offsets. The incomplete player has four starts, three samples and no final result
or cleanup event. The run admits 82 shots and retains 43 identity-consistent
director intents, but only 27 successful leader observations. Fourteen samplers
complete all seven readings; all 73 final predicates remain unevaluated. These
facts support cadence composition and preserve failed native acceptance. They
do not isolate adaptive lane-policy, CPU, wire-loss or final-storage benefit.

One exact timed-out handle has director arrival and a committed receipt control
10,251 ms before its observer timeout. Committed receipt admission records a
pending-row update; a partial confirmed audience can still leave the handle
pending. The native receipt audience, pending before/after and emitted settlement
completeness are absent. Measure those actual facts at the existing admission
owner before selecting a repair; later registry/epoch observation stays conditional
on the result. Preserve policy, deadlines, audiences and every acceptance guard.

The source candidate adds a separate typed receipt-confirmation diagnostic through
the existing guarded sink. The existing control-admission record and its phase-last
serialized bytes stay intact. The receipt attempt owner already holds decoded
receipt audiences/revision, pending state/sender version, computed candidate,
commit disposition and the logical settlement. Retain those closed facts without
another backend read, callback, collector or confirmation policy. Copy retained
data rather than referring to mutable owner state, and verify that the native
recording consumer preserves it. Candidate state is not an independent persisted
readback; settlement emission is not proof of a live handle transition. Real
client-service and recording-boundary tests establish the evidence capability
before one further observation selects a demonstrated defect or missing boundary.
The existing native diagnostic bridge already forwards whole events. Its current
runtime test processes receipts through the same real service fixture as the
receipt-tracking tests and asserts the published facts. They share only that coherent
test setup and its message builders, removing the old duplicate definitions;
production forwarding does not need another adapter.

Controlled real-service and recording tests observed six missing-fact failures
before implementation, then 45 passing checks. Fresh review reproduced a
callback-order defect: a diagnostic lifecycle read before settlement emission
could expire a committed acknowledgement. The corrected path captures immutable
facts before mutable settlement consumers, then publishes them after the existing
settlement. The independent lifecycle regression first failed, then all 47
covering and 335 affected checks passed. Both service and recording tests retain
original facts during settlement-time array mutation. Fresh scoped review
addressed the ordering and documented attempt-coverage limits with no new
breakage, including full authored and recursive support closure.

Current affected types, package checks and app build passed. The pre-fix broad
suite passed 15,162 tests/12 skipped; its source binding remains explicit rather
than becoming a current-fix claim. Storage exceptions stay with the existing
storage-failure owner without an invented commit-return observation. The capture
capability is now present in a reviewed native run; its overhead remains
unisolated. These controlled proofs do not diagnose the earlier native
acknowledgement failure or establish elapsed performance gain.

The current default-off native observation retains 35 actual confirmations:
28 committed partial inputs, six complete inputs before successful observers,
and one complete input after its observer timed out but within the message TTL.
No retained complete confirmation precedes that timed-out observer's bound;
read/commit failures can leave no confirmation record, so absence is not proof
of non-arrival. Native acceptance remains failed: 81 shots, 56 identity-consistent
director intents, ten successful observers and 71 timeouts; thirteen final
recipes/samplers/cleanup actors, missing two; no end or final storage and all
73 predicates unevaluated. One director start receipt confirms the actual
fourteen-player audience. Fresh evidence and scoped wording review preserve
these limits without earning a downstream repair or performance benefit.

The next observation belongs upstream: actual authenticated logical-recipient
ACK admission, frozen aggregate count/deadline/result, and complete receipt
publication/return. Logical ACKs use AL control admission or verified relay;
they are distinct from AppInbox domain mutation handling. Existing admin
snapshots are bounded, process-local outbound projections and can omit this
client-originated subject. Current timing records omit exact ACK/count facts
and support only scalar details; flags alone cannot recover the missing span.

Use the existing opt-in API-child stdout, safe JSONL/summary and workflow
artifact lifecycle for a narrowly typed private owner observation. Retain
actual identities, frozen sets, clocks/revisions, typed count outcome and
existing enqueue result without another authorization/query/write or policy
engine. Preserve immutable capture and guarded publication after existing
effects, default-off behavior, error/exit/line/signal/reap limits and closed
safe fields. The socket authority carries its existing peer/scope disposition
to the final service observation, rather than resolving authorization again.
The relay owner retains its actual publication result; the existing subscriber
carries the notice publisher identity through the current service call.
A private receipt observation type and API adapter preserve exact arrays without
broadening generic scalar timing contracts. Default API composition constructs
the optional observer only when existing timing logs are enabled, so the disabled
path avoids diagnostic copying and clocks. Real-owner tests must cover this gate,
relay provenance and failed publication, and actual producer-to-recorder survival.
The receipt feature needs its durable entry-to-result navigation map as its
module count grows. Any reviewed checker disposition remains exact to its
JSON boundary or capped coherent owner, with no standards or threshold waiver.
No wire/persisted/admin API or dependency change is required.
Logger and collector loss remain possible; partial capture and absent rows
remain unknown rather than proving absent ACKs.

The source capability is now implemented and independently reviewed. Actual
owner-to-recorder RED/GREEN covers socket/count/relay/outbox facts, whole-path
callback order, immutable sets, real disabled composition and safe retention.
Final direct checks passed 38 tests, API composition seven, and maintained
types 1,511 files. The affected 506-test suite and app build preceded the last
private decoder refactor; direct/parser checks and black-box types cover that
change. Full source/support review approved the capability; a misleading
subscriber comment was corrected and passed scoped re-review with runtime
bytes unchanged. No source behavior repair or native fairness gain follows.
Captured run [38026356058](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/38026356058)
at clean exact `bb3647ae12796fad98d6a2e9494bea26ae186be0` failed native
acceptance after 54,317 ms. Full fresh evidence review verified 23 originals and
14 safe projections. Thirty retained intermediate command links were recovered
by exact same-actor joins and passed scoped re-review. All 73 declarations remain
exact and unevaluated. The run queues 81 shots plus start, retains 39 authenticated
director intents, 25 successful shot observers and 56 timeouts, with thirteen
failed finals and missing controller-03/13 cleanup. End, full completion and final
storage remain unproved.

Actual API capture retains 32 authenticated socket decisions, 32 aggregate count
decisions and 52 outbox results. Nine complete committed sender confirmations
join successful same-actor observers. Director start counts all fourteen player
ACKs before its server deadline and returns a pending complete-receipt handoff;
no complete sender confirmation is retained for that exact generated control.
Pending does not establish refusal, delivery or sender success; an admitted
result's durable=true field is not independently verified restart durability.
The next missing span is pending admission/work/dequeue/delivery/return through
trusted sender ingress/read/decision/commit. Separate clocks, partial capture,
logger/collector omissions and absent relay observations constrain interpretation.
All native predicates stay fixed and capture cost is unisolated. These facts earn
measurement, not a return-path repair or native fairness/CPU/SQL speedup.

The automatic API black-box gate at source `bb3647ae12796fad98d6a2e9494bea26ae186be0`
separately timed out on forming removed-topology hydration. Retained server records show an early topology
publication with zero recipients before WebSocket open, but omit the stored
row, audience, planner change decision and hydration result. Before correction, the planner
could grow a removed snapshot's audience while reporting it unchanged; automatic
coalesced work could then skip that update and hydration consult the old
audience. This is a baseline condition, with actual CI causality unproven.
The corrected planner now treats growth of that canonical cleanup audience as
a change. Actual planner RED preceded its first source edit. The full-path
fixture initially had expired leases; after live-session correction and an
authoritative-read guard, restoring the original planner failed real persisted
audience and hydration assertions. Restoring the correction passed all 60
focused tests and shared-server types. This later original-source RED/GREEN pair
is recorded with its actual chronology. Fresh full source review and two scoped
import-group corrections are closed; the import move passed 17 work-handler
tests and the final separator changes no non-whitespace bytes. Formation policy,
historical cleanup recipients, authority, publication/hydration lifecycle,
formats, transactions, retries and the ten-second recipe predicate remain fixed.
Current-source automatic CI is a separate gate; historical causality and native
ACK behavior remain unverified.

The bounded return-contract survey and fresh evidence review are closed with
no findings. Actual pending replay, foreign dequeue, local native socket return,
registered publisher/direct outcome and cluster-wrapper retry disposition are
separate owned facts; current capture omits their exact receipt work/return
records. Existing sender confirmation retains candidate/CAS results but can be
absent after earlier exceptions. Static paths and absent records cannot establish
historical execution or a delivery repair.

Published baseline `73e4908fb27b2fe5f0b3f71f0e73749eb6069e97` passes all 22 automatic
checks: 21 success and one optional RTC skip. The existing lifecycle recipe passes
36/36, including forming hydration at 52 ms under its unchanged 10,000 ms limit.
Historical CI causality and native scale acceptance remain separate and unproved.

Reviewed source `a66cf88d3e12c8986106bc6b12a4336546d3565d` retains actual server
pending/dequeue work, native invocation/return and publisher/direct outcomes
through existing private timing/capture. The real producer-to-child-recorder RED
preceded implementation; actual competing CAS and held/released claims prove
pending handoff and later real transport. Additional native-boundary and real
release-clock REDs protect truthful outcomes and mandatory lifecycle ordering.
The corrected injected-clock fixture still fails against the original handler.
The affected suite passed 505 tests before the final narrow native argument-order
correction; final covering tests passed 65, final capture 15 and registry checks
51. Maintained types enforce 1,512 test files with zero debt/errors. Fresh full source/support
review approved the capability and all six exact bounded standards dispositions
with no findings, completing the source task at round 0/5.

Existing client confirmation stays intact; pre-exception ingress is unknown.
Observation snapshots are immutable and published after mandatory batch effects;
closed safe fields exclude arbitrary payload, key contents, credentials and error
prose. After fresh approval and coherent publication, one new-source captured
15-agent hosted observation joins actual returns to existing sender records.
Every native predicate/resource/budget remains fixed; fresh evidence review earns
any further capability or repair before ordinary uninstrumented 15/30/50 proof.

The new-source captured hosted run `38036892199` at published c32 fails native
acceptance. All 84 shots reach the director; 65 observers succeed and 19 time out.
All 15 recipe finals fail, with complete seven-reading sampler and cleanup
cohorts. Only four completion arrivals occur; no end send or final storage
executes, and all 73 predicates remain unevaluated. The exact director complete
receipt joins retrying dequeue, actual native return, sender commit and public
acknowledgement/readback. All 39 complete sender confirmations join successful
observers. Failed shots have director arrivals but no retained complete server
receipt; neither absence nor two domain-unauthorized returns selects a cause.
Partial capture, callback/release and physical-session/clock limits remain. All
23 originals are hash-bound; fresh evidence review approves the substantive
measurement with two recorded Minor concerns and no blocking finding. A successful
return chain and different observed counts cannot establish isolated fairness,
CPU/SQL gain or replace complete acceptance.

Current c32 CI separately fails two strict bundle budgets and two WS assertions
coupled to exact internal spy arity. Matched baseline/current measurement proves
846/742 additional whole Brotli bytes; the diagnostic projection survives both
browser artifacts. The selected correction installs concrete optional receipt
evidence through the existing WS-server construction boundary so browser lanes
do not value-import it. One canonical contract and the mandatory post-release
boundary remain; exact shape and safe savings need direct tests and fresh source
review. Independent native bytes and persisted completion replace obsolete
call-shape coupling. The existing limits, capability semantics, lifecycle
ordering and native predicates remain fixed.

The reviewed correction passes 20 direct native/store/lifecycle
controls and all six unchanged bundle tests. Its optional receipt projection and
batch-publication resource are absent from both emitted browser input sets.
The headless artifact is 319,173 Brotli bytes against the strict 319,488-byte
bound; the facade is 250,851 bytes against 250,880, leaving 29 bytes of headroom.
The resource owns guarded creation and inert diagnostic discard, while the
handler owns allocation timing, absence/failure interpretation and post-release
publication. Constructor failure loses optional diagnostics while mandatory
native/store/release behavior continues. A healthy resource still publishes
native observations after release when per-claim evidence construction fails.
The base correction passed 524 tests across 55 files, three package type checks
and API Deno. These results retain their base-source binding. The final import
and erasable fixture-contract repair rechecks all 20 direct controls, maintained
test types and strict bundle gates; actual artifacts are byte-identical. Fresh
full review supports behavior/artifacts, and independent scoped review closes
both required standards findings with no new breakage. Task25 completes at round
1/5. Required good-test guidance was read late in the full review; that history
remains disclosed and strict preflight ordering is not claimed. These local
results do not replace current c32 CI or prove native acceptance.

Fresh frozen return-path review proves all 19 timed-out shots have exact
director-generated ACK admission at controller-12. All 27 successes without a
complete WS receipt have same-ID RTC ingress and committed sender peer ACKs.
The first missing association is received ACK to regenerated upward control,
logical recipient and actual commit result; it does not prove failed generation
or loss. Only three failed cases retain unlinked same-subject upward claims.
Among the 27 successful controls, 26 have the relay's inbound committed/outbound
rejected combination; controller-12 shot1 is the terminal sender and has
outbound committed/inbound not-handled. The reviewed survey retains these two
Minor wording corrections for final triage. Neither common relay participation
nor asynchronous timing establishes AppInbox lane pressure, starvation or a
weighted-fairness benefit. The next bounded source slice will retain the exact
incoming-to-regenerated-control association at existing commit and handoff owners
through guarded diagnostics, after the current source gate closes. It will read
already-owned facts and distinguish candidates, commit returns, conflicts,
terminal sender bypass and actual handoff without extra database or policy work.
It is a diagnostic prerequisite; no behavior repair or native rerun is selected
yet.

The unchanged order-balanced PostgreSQL state-write comparison passed, including
its existing resource and correctness gates. Its mutation mix omits authorized
WebSocket connect, so that result does not establish this operation's cost or
replace the required ordinary hosted setup and ALM acceptance.

Focused queue/reader/engine and authenticated group-join redelivery regressions
precede shared/API type checks and memory API validation. Scheduling changes also
require unchanged PostgreSQL medium-scale coverage and the governed state-write
baseline/candidate comparison. Final ordinary, uninstrumented 15/30/50-agent
manifests must prove the complete cohort, accepted layout, delivery and sampled
budgets; deterministic scheduling proof does not replace these outcomes.

## Validation and next boundary

TDD executes the generated sampler against the existing runtime with controlled
page readings, including transient excess, missing readings, and healthy traffic.
Independent tests validate payload contracts, receipt policy, cadence, the frozen
15/30/50 audience, and missing/violating controller evidence. Focused runtime and
manifest suites precede shared-test type checking, the black-box build, generated
manifest checks, repository checks, and current-candidate hosted scale runs.

V1d follows after this pull request is manually merged: a 60-minute run that
tests retention and memory growth, including delivered-marker history. It stays
outcome-shaped until current V1c evidence determines its workload and budgets.
