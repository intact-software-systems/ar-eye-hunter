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
after 72 serial NEW handlers. The existing controller drains up to 1,000 entries
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
