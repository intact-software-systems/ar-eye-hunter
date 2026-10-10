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

The next owned correction composes existing bounded parallel branches for six
shot offsets, each with its send and exact-handle ACK observation. After their
join, the canonical six-iteration receipt-verification loop has no additional
interval. The player's enclosing command count and all assertion declarations
remain identical; receipt, identity, arrival, sample, storage and deadline guards
remain mandatory. Relative branch-registration jitter is possible. The existing
30-second window still rejects late ACKs, slow admission or incomplete lifecycle
work. No generic scheduler contract changes. Canonical manifests may acquire this
new command topology while previous captured bytes remain immutable. TDD must
prove actual starts with delayed ACK ingress and full canonical 15-participant
acceptance, including failure/cancellation cases, before a fresh default-off
GitHub observation. That run and the remaining ordinary scale proof stay separate
from deterministic cadence and queue-operation comparisons.

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
