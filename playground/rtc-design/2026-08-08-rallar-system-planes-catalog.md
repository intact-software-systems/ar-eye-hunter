# Rallar System Planes Catalog (2026-08-08)

Status: brainstorm capture from the 2026-08-08 design session; direction
input, not an approved plan.

The formation track answered "how does a group get connected?" This catalog
answers the next question: **what does a distributed group communication
system need beyond formation?** It sweeps the planes that are vital in
systems of Rallar's class, each with the standard mechanisms/algorithms/
protocols, the seeds Rallar already has, the sharpest gap, and the
black-box scenario families the plane implies.

ID convention across this folder: scenarios `S1–S7`
(`2026-08-08-group-formation-storm-scenarios.md`), formation mechanisms
`M1–M14` (`2026-08-08-group-formation-mechanism-catalog.md`), lifecycle
policies (`2026-08-08-group-lifecycle-and-policy-model.md`), and system
planes `P1–P14` (this document).

Two findings that held across the whole sweep:

1. **Rallar has more dormant seeds than gaps.** The AL contracts already
   declare ack/nack/repair control messages, ordering fields (`orderingKey`,
   `epoch`, `seq`), supersedence/dedup/durability QoS aspects, and a
   `traceId` — most unused. The evolve-don't-rewrite thesis keeps holding.
2. **The policy-preset testing model generalizes.** Every plane below
   decomposes into policy knobs plus named black-box scenarios, exactly like
   the lifecycle document's admission policies. This is the house style for
   all future planes: knobs as declarative data, scenarios as the coverage
   matrix.

---

## P1 — Time plane: shared clocks and ticks

**Why vital.** Anything synchronized — round starts, countdowns, turn
timers, deadline policies in the lifecycle model, replays, lag
compensation — needs a shared timeline, and browser wall clocks cannot
provide one.

**Mechanisms.** NTP-style offset estimation over the existing WS/RTC paths;
**hybrid logical clocks (HLC)** to combine causal order with approximate
wall time; a server-authoritative **room tick** primitive ("tick N begins
at T").

**Rallar seeds.** Causal revisions server-side; RTT machinery already
measures the paths an offset estimator needs; `createdAtEpochMs` stamped on
durable work.

**Sharpest gap.** No group time service, no tick primitive; lifecycle
deadline policies implicitly assume this plane.

**Scenario families.** Clock-skewed clients agree on a round start within a
bound; tick delivery under churn; deadline fairness across skewed members.

## P2 — Ordering and sequencing plane: the room log

**Why vital.** The single highest-leverage missing primitive. A
**server-sequenced room log** — append room-critical events through the
server (already the trusted relay baseline), monotonic per-room sequence,
gap detection, replay from a cursor — provides total-order broadcast
without any consensus protocol, because the server is the sequencer.

**What it unlocks.** Late-join catch-up, reconnect resume ("everything
after seq N" instead of world re-snapshot), spectators, replay, and audit —
one primitive, five product features. Composes directly with delta
dissemination (M2).

**Rallar seeds.** AL `ordering { orderingKey, epoch, seq }` declared and
unused; `group_state_events` is already an append-only causal log for group
state (the room log generalizes the idea to app events); WS relay as the
sequencing point.

**Sharpest gap.** No app-facing sequenced log, no cursors, no resume
protocol — reconnect today means re-snapshot.

**Scenario families.** Late joiner replays to head; reconnect resumes from
cursor with zero loss/duplication; gap injection → repair; spectator joins
read-only at seq N.

## P3 — Reliability and repair plane

**Why vital.** RTC datachannels can run unreliable/unordered, tabs
background, radios flap. Reliability must be a protocol, not a hope.

**Mechanisms.** **Receiver-driven NACK repair** (PGM-style: receiver
detects a sequence gap, requests repair from a peer or the server; senders
stay dumb — the scalable direction); bounded **store-and-forward windows**
for briefly-absent members; optional FEC for loss-heavy paths later.

**Rallar seeds.** `al-control` already defines `ack.v1`, `nack.v1`, and
`repair.v1` envelopes with reason codes — dormant; AL QoS declares
`reliability`, `retry`, `repair` aspects; the room log (P2) supplies the
sequence numbers repair needs.

**Sharpest gap.** Nothing consumes the repair contracts; transient absence
costs a full resync.

**Scenario families.** Drop k% of datachannel frames → convergence via
repair; background a tab 30 s → catch-up within window; window overflow →
clean resync (not silent loss).

## P4 — Failure detection plane

**Why vital.** Presence TTL is 24 h and heartbeats 20 s — membership-grade,
not routing-grade. Topology repair (M8), manager succession (lifecycle),
and health-driven re-establishment all starve without timely detection.

**Mechanisms.** **Phi-accrual failure detection** (adaptive, per-peer, no
magic timeouts) over existing heartbeat streams; optionally **SWIM-style
indirect probing** among mesh peers (they already hold the edges to probe
over); explicit `alive / suspect / dead` states consumed by topology and
lifecycle machinery.

**Rallar seeds.** RTT heartbeats every 5 s and presence heartbeats every
20 s already generate the signal; session generation fencing gives clean
identity for detector state.

**Sharpest gap.** Signals exist, detector doesn't — nothing turns heartbeat
streams into timely, tunable suspicion.

**Scenario families.** Kill a member → suspicion within policy bound →
topology repair triggered; flapping member → suspicion oscillation damped;
manager killed mid-ESTABLISHING → succession within bound.

## P5 — Flow control and congestion plane

**Why vital.** Trees make relays; interior nodes have finite upstream. A
relay without backpressure fails silently and takes its subtree with it.

**Mechanisms.** **Credit-based per-lane flow control** (receiver grants
credits); **priority classes** (game state > chat > telemetry) with chosen
— not accidental — drop policies; latest-value **supersedence** for state
streams; congestion signals feeding topology (a saturated relay →
re-root), which is the distinctively Rallar move no off-the-shelf library
offers.

**Rallar seeds.** `RtcDataChannelSendQueue` (queue depth is the signal);
AL QoS `supersedence`, `congestion`, `fanout` aspects declared;
`ttlHops`/`expiresAtMs` constraints in the envelope.

**Sharpest gap.** No credits, no priority classes, no policy-owned drop
behavior; send queues absorb until they don't.

**Scenario families.** Saturate a relay → low-priority drops first,
high-priority sustained; slow receiver → sender paced, not OOM; supersedence
stream under burst delivers latest value.

## P6 — Agreement-lite plane: fairness without consensus

**Why vital.** Groups rarely need Paxos — the server arbitrates — but games
need small fairness protocols that prevent last-mover cheating and detect
divergence.

**Mechanisms.** **Commit–reveal** for shared randomness and simultaneous
decisions (hash commit, then reveal); turn-token passing as a room
primitive; and the sleeper hit for P2P game modes: **periodic state-hash
comparison** — peers exchange a hash of simulation state every N ticks,
divergence triggers authoritative resync. Converts "weird bug reports" into
a measurable desync signal.

**Rallar seeds.** Server-as-arbiter baseline; canonical-hash helpers exist
server-side; the tick (P1) and room log (P2) provide the alignment points.

**Scenario families.** Commit-reveal round with a withholding client →
typed timeout outcome; induced desync → detected within N ticks → resync;
turn token survives holder disconnect.

## P7 — Interest management plane

**Why vital.** Broadcast-to-all stops scaling before the topology does. At
50+ members, most members don't need most messages.

**Mechanisms.** **Area-of-interest (AOI) filtering**: spatial grids or
zones as subscription topics, relevance scoring, per-member subscription
sets; the difference between "a 50-member group" and "a 50-member group
where everyone receives everything."

**Rallar seeds.** AL multicast targeting with `groupRef` and audience
fields; room-scoped channels (`rallar.realtime.room`); topic-based routing
throughout.

**Sharpest gap.** Subscription granularity is the room, not a region or
interest set.

**Scenario families.** Zone-partitioned group → per-member delivery counts
match subscriptions; member crosses zones → subscription handoff without
loss; global events still reach all.

## P8 — Identity and trust plane

**Why vital.** Managers granting admission (lifecycle) need unforgeable
authority; some markets will require end-to-end encryption; moderation
needs enforcement that P2P paths cannot dodge.

**Mechanisms.** **Capability tokens** — a manager grant as a signed,
scoped, expiring capability (the WS-ticket pattern generalized); moderation
sub-plane (mute/kick/ban enforced at the server relay, revocation
propagated to P2P paths); and **MLS (RFC 9420)** as the E2EE end-state —
notable because MLS's model (epoch-based group membership over a tree)
rhymes almost perfectly with Rallar's generations, epochs, and topology
trees. Not a v1 build; a shape constraint: keep membership changes
epoch-shaped and key-agreement-friendly so MLS remains addable.

**Rallar seeds.** One-shot WS tickets bound to sessions; member role/ban
mutations; session generation fencing; per-message sender binding.

**Scenario families.** Revoked capability → typed rejection everywhere
including RTC paths; banned member's messages dropped at relay; kick during
ESTABLISHING aborts their edges.

## P9 — Evolution and versioning plane

**Why vital.** Mixed-version fleets are guaranteed — browsers update on
their own schedule. The plane you skip that hurts the longest.

**Mechanisms.** **Capability/version negotiation** at session and room
level (min-common-version per room; feature availability surfaced through
the lifecycle policy document); graceful degradation rules; payload-version
discipline in every durable contract (exists) extended to negotiated
_behavioral_ capability (doesn't).

**Rallar seeds.** `v: 2` envelope, `.v1` type-id convention, versioned
durable payloads throughout; the policy document is a natural carrier for
per-room feature levels.

**Scenario families.** Mixed-version room negotiates the common feature
set; old client joining a new-feature room → policy-defined outcome
(degrade or reject); rolling server upgrade under live traffic.

## P10 — Platform governance plane: Rallar as a product

**Why vital.** Invisible until the second serious tenant; then the only
plane anyone discusses. The shared `resource_inbox` and TURN bandwidth are
the two places one tenant can hurt every other.

**Mechanisms.** Per-application/workspace **quotas** (groups, members,
message rates, and above all **TURN relay bandwidth** — the real cost sink
in WebRTC products); **fair scheduling** across tenants in the queue lanes;
per-tenant rate/priority classes; cost observability per tenant.

**Rallar seeds.** Rate-limiter patterns (auth, ICE, tickets); scope
identifiers on everything (`applicationId`/`workspaceId`); admin operations
endpoints for exposure.

**Sharpest gap.** Nothing prevents one noisy application from starving the
shared queue lanes or draining the TURN budget.

**Scenario families.** Noisy tenant at quota → throttled, quiet tenant
unaffected (the isolation assertion); TURN budget exhaustion → policy
outcome, not silent cost.

## P11 — Operational truth plane: determinism, chaos, causality

**Why vital.** Every other plane is only as real as its tests. This plane
multiplies the value of the whole catalog.

**Mechanisms.** **Fault injection as first-class black-box steps**
(drop/delay/duplicate/partition a connection or kill a server mid-recipe) —
the runner plus the in-memory backend is genuinely close to
FoundationDB-style deterministic simulation, a capability few products
have; **causality tracing** (reconstruct a room timeline from the `traceId`
already carried in every envelope); the storm-metrics families from Phase 0
as permanent operational surfaces.

**Rallar seeds.** Black-box runner + pglite-memory determinism; distributed
run artifacts and analysis; `traceId` in the envelope; the activation
design's kill-before/after-commit test patterns.

**Scenario families.** Every plane above gains its chaos variant; a
partition heals → convergence proven; a room incident reconstructed from
trace alone.

---

## Additional planes (beyond the session sweep)

### P12 — State transfer and catch-up plane

Distinct from the room log: app-level **world-state snapshot + delta
handoff** for late joiners in stateful apps (games): who serves the
snapshot (**state-provider election** — a peer with the state vs. the
server), verification of peer-served snapshots (hash against authority),
and **compaction/checkpointing** policies so logs and CRDT histories stay
bounded. Seeds: Rallar CRDT sync and compaction admin operations, Rallar
Data latest-value semantics, the room log's cursors. Scenarios: late join
into a long-running game within a time bound; provider disconnects
mid-transfer → failover; checkpoint + truncated log replays identically.

### P13 — Data lifecycle and compliance plane

Retention policies per data class (room log, CRDT, presence history,
metrics); **erasure** (GDPR-class delete — the CRDT erase admin operation
is the seed) with propagation to caches and peers; **audit** of authority
actions (manager grants/kicks, policy changes) as durable, queryable
records — the lifecycle model's manager actions make this newly necessary.
Scenarios: erase request → verified gone from every durable surface within
SLA; audit trail reconstructs an admission dispute.

### P14 — Locality and multi-region plane

Single-Postgres is the stated posture; the plane still exists as _trigger
conditions_: geography-aware **TURN selection**, region-aware topology
planning (Vivaldi coordinates already embed latency geometry), and
eventually regional relays/SFU-lite for very large groups. Document the
triggers (cross-region RTT distributions, TURN cost concentration) rather
than building ahead of them. Scenarios: two-region group plans
region-aware trees; TURN selection matches client geography.

---

## Priority view

| Priority       | Plane                                                          | Why now                                                           | Cheapest seed                                                     |
| -------------- | -------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------- |
| 1              | P2 room log + resume cursors                                   | Unlocks catch-up, reconnect, spectators, replay; composes with M2 | Server-as-sequencer; AL `seq`/`epoch` fields                      |
| 2              | P4 failure detection                                           | Lifecycle succession + topology repair starve without it          | Phi-accrual over existing RTT heartbeats                          |
| 3              | P5 flow control / priority                                     | Relays without backpressure fail silently                         | AL supersedence + send-queue depth                                |
| 4              | P1 time plane                                                  | Small build, large downstream (ticks, deadlines, netcode)         | Offset estimation over existing pings                             |
| 5              | P11 fault injection + tracing                                  | Multiplies test value of everything else                          | Black-box runner step extension; envelope `traceId`               |
| 6              | P10 tenant quotas/fairness                                     | Product-vital before the second serious tenant                    | Existing rate-limiter patterns                                    |
| demand-driven  | P3 repair, P6 agreement-lite, P7 AOI, P12 state transfer       | Pull in when an app needs them                                    | Dormant AL contracts; tick+log substrate                          |
| shape-only now | P8 MLS-readiness, P9 negotiation, P13 compliance, P14 locality | Constrain design shape today, build later                         | Epoch-shaped membership; version conventions; triggers documented |

## Relationship to the rest of the folder

- The lifecycle/policy model is the control plane for formation; every
  plane here adds its own policy knobs to the same document style
  (delivery guarantees per topic, detector timeliness, priority classes,
  retention classes) — one policy vocabulary, growing by plane.
- P2/P3 extend M2 (delta dissemination) into a full messaging substrate;
  P4 feeds M8 (health-driven repair) and lifecycle succession; P11 extends
  the Phase 0 measurement plan from metrics to chaos.
- Nothing here changes the formation sequencing: Phases 0–2 remain the
  entry point. The priority-1 planes (P2, P4) are the natural candidates
  for the workstream after the formation phases stabilize.
