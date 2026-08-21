# Where the Activation Criterion Evaluator Runs (2026-08-18)

Status: **analysis for a decision**, requested during slice 3 planning. The question: for
`threshold`, `deadline`, and `threshold-or-deadline` activation modes, what component observes
readiness and commands the resulting transition? (`manual` mode already works: the activate command
shipped in slice 2b-ii.)

## The constraint that shapes everything

**Deadline expiry generates no evidence.** The topology work handler wakes on `group-revision` and
`rtt-refresh` work — both are consequences of something happening. A group sitting at 40% readiness
whose `deadlineMs` elapses produces no membership change, no RTT sample, no work entry. Any purely
evidence-driven evaluator silently never fires for `deadline` and never fires the deadline half of
`threshold-or-deadline`, which is the half that returns a below-floor group to FORMING.

Two repo facts bound the solutions:

- Queuebox `delayMs` is a **retry-release delay**, not scheduled visibility. There is no native
  "enqueue this work, visible at time T" primitive, so a one-shot deadline timer per group would
  either abuse retry semantics or add a new queue capability.
- The established timer idiom is `tryRunInIntervals` → an enqueued MAINTENANCE work item
  (`enqueuePresenceExpiryReconciliation`), inventoried in the mutation routing contract with its own
  transport row. It is interval-based, cluster-safe (any server's tick enqueues; AppInbox dedupes),
  and already runs in every deployment.

Conclusion before the option comparison: **no single-legged design is complete.** The real choice is
which leg carries the threshold half, and how small the timer leg can stay.

## Option A — evaluate in the RTC topology work handler

After `computeAcceptedRtcTopologyWork` computes or refreshes a topology for a group whose
`lifecycleState` is `establishing`, derive readiness from the just-computed authority (planned
overlay + `rttMeasurements` are already in scope) and, when the criterion is met, enqueue the
internal transition command.

**Pros**

- _Zero-lag threshold activation._ The handler runs exactly when evidence changes — a new RTT sample
  or membership change re-plans, and the same authority read feeds the readiness fraction. The mesh
  activates the moment it is observably ready, which is the UX the `match`/`managed` presets exist
  for.
- _No second reader._ The planning authority (group snapshot, config, measurements, now) is already
  assembled once per work item; readiness derivation reuses it. A separate evaluator would re-read
  the same three stores on its own schedule.
- _The doctrine absorbs staleness._ The handler only **enqueues** a transition; the AppInbox compute
  re-reads state, re-authorizes against the policy, and the transition table rejects anything no
  longer legal (`lifecycle-transition-invalid` if the group left ESTABLISHING meanwhile). Duplicate
  or stale evaluations are harmless by construction — the same property that made 2b-ii's commands
  safe.
- _Cluster-correct for free._ Work is competitively dequeued; whichever server evaluates, the
  command re-authorizes centrally. No leader election, no pinned evaluator.

**Cons**

- _Plane crossing._ The topology worker becomes a producer of **intent** commands. Until now the
  planes were strictly layered: intent (lifecycle) gates observation (planning); observation never
  wrote intent. The design document's own invariant — "the RTC activation projection observes
  connectivity and never decides this" — reads uncomfortably close to this, though what it forbids
  is the _projection_ deciding state directly; an enqueued command that re-authorizes is arguably
  the sanctioned way for observation to _petition_ intent. The distinction is real but subtle enough
  to deserve this paragraph in the code.
- _Handler density._ `create-rtc-topology-work-handler.ts` is 432 lines and already carries claim
  gating, fingerprint gating, publication, and replay. The evaluation itself must live in its own
  file with a one-call seam, or the handler tips into the review tier.
- _Internal-authority widening._ `validateTrustedAuthorityMode` currently restricts internal
  authority to `disconnectPresence`. It must widen to the activate and below-floor transitions —
  deliberate, auditable, and the riskiest reviewed line of 3b regardless of which option wins,
  since automation needs it in every design.
- _Deadline half still needs a timer_ (the constraint above). Option A alone is incomplete.

## Option B — dedicated maintenance loop

A reconciliation service on the `tryRunInIntervals` idiom scans ESTABLISHING groups each tick,
derives readiness, evaluates the criterion (threshold and deadline both), and enqueues transitions.

**Pros**

- _One place, both halves._ Threshold and deadline evaluate in the same sweep; no hybrid.
- _No plane crossing in the topology worker;_ the handler stays untouched.
- _Deadline precision is naturally bounded by the tick interval_ — acceptable, since a formation
  deadline is product-scale (tens of seconds), not real-time.

**Cons**

- _Threshold activation lags by up to a full tick._ The presets' deadlines are 20–30s; a tick
  interval meaningfully smaller than that (say 1–5s) turns the sweep into a polling hot loop over
  every establishing group — re-reading planned overlay, measurements, and group snapshot per group
  per tick, cluster-wide. The evidence-driven path gets all of this for free at the moment it
  matters.
- _A second derivation site._ The sweep re-assembles what the work handler already assembled,
  and the two can disagree transiently (different read moments), which makes test-writing and
  incident forensics harder.
- _An index problem option A does not have._ "Scan establishing groups" needs a way to enumerate
  them; nothing indexes groups by lifecycle state today. Either a new index/registry (new
  persistence surface) or a full scan (what the admin prune does — acceptable for maintenance,
  ugly per-tick).

## Option C — defer automation

Ship only derivation and read surface; applications poll and call `activate` manually.

Rejected as the slice outcome by the plan's own text (below-floor return under backoff is slice 3's
core), but its spirit survives in the PR split: 3a is exactly this, landing dark.

## Recommendation

**Hybrid, weighted to A: evidence-driven evaluation in the topology work handler, plus a minimal
deadline-only maintenance tick.**

- The handler leg owns everything evidence can trigger: threshold crossings, and — on any evaluation
  — the below-floor check once the deadline has passed. It reuses the authority read, fires with
  zero lag, and stays a pure enqueue (observation petitions; AppInbox decides).
- The timer leg exists **only** because deadlines expire silently. It rides the existing
  reconciliation idiom, and its work item does the minimum: for establishing groups whose deadline
  has elapsed, enqueue the same evaluation the handler would run — not a second evaluator, the same
  function invoked with the same contract. The "scan establishing groups" index problem shrinks to
  deadline-passed groups only, and its natural home is a small registry written on the
  start-establishment transition (one row per establishing group, removed on exit — the transition
  commands already write in the same AppInbox transaction).
- Both legs converge on one internal command path with fresh authorization, so double-firing (tick
  and evidence racing) is idempotent noise, not a bug.

What makes this honest rather than a committee answer: each leg exists for a reason the other
cannot serve — A cannot see time pass, B cannot match evidence latency without hot polling. The
evaluation _logic_ lives in exactly one function either way.

## Consequences for 3a (already approved, being built now)

- Aggregate gains the decision fields: `formationAttemptCount`, `lastFormationOutcome` (typed:
  outcome + reason code + observed rate at decision time + atEpochMs), and the deadline anchor
  `establishmentStartedAtEpochMs` (nullable; set by start-establishment, needed because `updated`
  is overwritten by any group write and `formationEpoch` is a counter, not a time).
- The readiness derivation is a pure function over (planned overlay, RTT measurements, liveness,
  now) with an explicit evidence-freshness window — server default constant initially, policy knob
  later if needed.
- The observed rate is derived on read, never stored; `lastFormationOutcome.observedRate` is the
  rate _at decision time_, which is a recorded decision, not live observation.

## Refinement adopted (owner discussion, 2026-08-18)

The scalability of the two legs differs in opposite directions, which is why the hybrid is not a
committee answer. A's cost rides **evidence volume**: evaluation piggybacks on work items the queue
is already carrying (the authority read is already paid for), it self-throttles at zero evidence,
and the existing coalescing and fingerprint gates dampen RTT storms. B's cost rides **standing
population × tick rate**: every tick pays O(establishing groups) reads even when nothing changed,
and the tick interval is one global latency-versus-load knob for all groups at once. Equivalently:
A is a reactive loop on incoming data, B is a tick loop — which is precisely why each is blind to
the other's trigger. A cannot see time pass; B cannot see the moment data lands.

The timer leg is therefore not an interval tick with a registry — **the reactive path schedules the
time path's work**. The establishment transition's own AppInbox write emits one deadline entry
("evaluate group X, epoch E, not before T") into a dedicated scheduled-work queue; a minimal
consumer dequeues due entries and invokes the same evaluation function the handler uses. This
removes the scan/index problem entirely, gives per-group deadline precision instead of a global
tick knob, stays cluster-safe by competitive dequeue, and makes below-floor backoff fall out of the
same primitive (the below-floor transition enqueues the next attempt's entry with the backoff
delay).

Caveats carried deliberately: queuebox `delayMs` is retry-release, so "not due yet → requeue with
remaining delay" is that queue's documented contract; and entries orphan when a group activates
early — each entry carries `formationEpoch`, and a stale epoch is a cheap drop.

## Decision taken

Hybrid for 3b: evidence-driven evaluation in the topology work handler; deadline and backoff work
scheduled by the transitions themselves into a dedicated queue with a minimal consumer. One
evaluation function, two producers — one via data, one via time.

## Implementation notes (2026-08-18, time-leg landing)

Two corrections to the caveats above, discovered while landing the time leg:

- The "not due yet → requeue with remaining delay" contract was not needed as the primary
  mechanism: `dequeueAudit.nextTs` is honored by every queue backend's reservation filter, so
  entries are inserted with their due time and stay invisible until then — native scheduling, no
  requeue loop. The consumer keeps a not-due throw purely as clock-skew defense (queue clock vs
  consumer clock); the retry release walks a skew-caught entry forward.
- Landing this exposed a pre-existing scheduling defect in the resource-inbox SQL: the naive
  `timestamp` columns hold UTC wall clocks, but `next_ts <= now()` (and the `expire_ts`
  comparisons) promoted the column through the _session_ time zone. Docker Postgres defaults to
  UTC so CI never saw it; PGlite inherits the host zone, so under `pglite-memory` every scheduled
  entry appeared hours in the past — released immediately, retry delays void, and the fairness
  lane's stale threshold trivially satisfied (a deadline timer burned all 20 retry attempts in
  seconds). Fixed by comparing against `(now() at time zone 'UTC')` throughout the resource-inbox
  SQL — behavior-identical on UTC sessions, correct on skewed ones — and pinned by
  `apps/api-v1/test/db/pglite-queue-schedule-timezone.test.ts`, which runs the reservation gate
  under deliberately skewed sessions in both directions.
