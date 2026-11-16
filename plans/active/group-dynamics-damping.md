# Group dynamics damping

A room whose members keep joining and leaving is re-planned again and again, and each new layout
costs every browser more than the layout it replaces was worth. This plan damps that: the server
holds back the reshaping of a room's distribution graph while the room is restless, lets the
cheap, necessary changes through at once, and bounds how long anyone waits. In the maintainer's
words it is back pressure on the joiners, and its strength must follow what the room is doing.

Slices 1 and 2 are built (pull request #827): the server records each plan and names it an attach, a
repair or a reshape, and nothing acts on that yet. The gates are not built. The maintainer decided the
plan's shape on 2026-11-14 (see "Decisions"). What the measurement answered and what it left open
is listed at the end.

## Why

**What a new layout costs.** A promotion is not free on the browser side:

- every browser dials the edges the new layout adds;
- for the replaced-layout overlap (15 s, served in `/api/config`) each browser admits frames over
  the edges of the layout it replaced, and for the first half of it sends over both;
- a relay that changes its children re-plans its forwards, and an origin's receipts wait on hops
  that no longer carry its frames.

The overlap and the early dial are in pull request #823 (make-before-break), which is merged.

**What the server does today** (on `main`):

| Mechanism             | What it bounds                                                                                                                                                                                                                                                                                                                                                                    | Where                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Re-plan window        | A membership, presence or leader change re-plans after 500 ms of quiet, but never later than the max wait                                                                                                                                                                                                                                                                         | `computeTopologyReplanDueAt`, `topology/replay/work/rtc-topology-coalesced-group-revision-work.ts`  |
| Max wait              | 4 500 ms server default (`topology.recompute.formationMaxWaitMs`); 5 000 ms in the default lifecycle policy                                                                                                                                                                                                                                                                       | `defaults-config.json`, `group-lifecycle-policy-presets.ts`                                         |
| Expected members      | Once the room holds the members it expects, the re-plan is due at once (D288)                                                                                                                                                                                                                                                                                                     | the same function; `resolveTopologyExpectedMemberCount`                                             |
| Layout-age floor      | A plan is not replaced before it is 1 000 ms old                                                                                                                                                                                                                                                                                                                                  | `GROUP_MINIMUM_LAYOUT_AGE_MS`                                                                       |
| Stage gate            | A `connecting` or `reconnecting` room keeps its active layout                                                                                                                                                                                                                                                                                                                     | `resolveTopologyPlanAction`                                                                         |
| Replanning policy     | `auto` and `debounced` plan; `commanded` holds automatic work until the application asks                                                                                                                                                                                                                                                                                          | the same function; the lifecycle policy's `topology.replanning`                                     |
| RTT-only re-plans     | Held until the layout is 15 s old; refinement at most every 30 s; a tree is kept unless 25 % and 10 ms better                                                                                                                                                                                                                                                                     | `rttReplanMinimumLayoutAgeMs`, `rttRefinement.minIntervalMs`, `resolve-rtt-refinement-next-hops.ts` |
| Promotion             | An active room's plan is promoted at once; there is no cooldown                                                                                                                                                                                                                                                                                                                   | `topology-promotion-request.ts`                                                                     |
| Incremental evolution | A membership change evolves the accepted graph: an unchanged member keeps its edges, so browsers change O(delta) connections. The whole graph is rebuilt only when a tree's leader must be re-rooted, when more than max(2, a quarter of the room) changed at once (joins alone never count on a tree), when the incremental update fails, or when the result breaks an invariant | `computeEvolvedTopologyNextHops`, `topology/planning/evolve-planned-topology.ts`                    |
| Topology kind         | Under `auto` a room is a star (the complete graph) below 5 members, a tree from 5 and a mesh from 16, with exit widths against flapping                                                                                                                                                                                                                                           | `topology.planning` in `defaults-config.json`                                                       |

**A burst is not only the first fill.** The expected-members rule covers one burst: the first,
up to the room's capacity or its admission limit. The same burst of arrivals can come at any
point of a room's life, and then nothing but the window and the max wait stands between it and
a re-plan per few seconds.

**Join admission is limited already, by fixed numbers.** A room admits at most 600 join requests
a minute across all principals and 60 per principal
(`RALLAR_GROUP_JOIN_ADMISSION_GROUP_RATE_LIMIT`, `..._PRINCIPAL_RATE_LIMIT`), answering `429`
with `Retry-After: 60` past them. Those limits protect the server; they do not follow the room.

**The gap.** Every bound on timing above is a clock. None of them looks at how restless the room
is, and none tells a small evolved change from a rebuild of the whole graph: both are due in the
same window and both are promoted at once. Under steady coming and going the max wait forces a
re-plan and a promotion about every 4.5 to 5 s, so each promotion lands inside the previous
layout's 15 s overlap. Most of those are small. The expensive ones are the rebuilds, and a burst
is exactly what causes one: more than a quarter of the room changing at once, a leader that must
be re-rooted, a room crossing the size at which its kind changes. Evidence from #823: two promotions about
a second apart are reachable on the ordinary path (two joins in a row), and a second promotion
inside one overlap was lossy until that pull request's fix. The fix makes it safe; it does not
make it cheap.

## The balance

Two costs pull against each other.

- **Noise.** Each reshaping costs dials, an overlap window of double sending, and re-planned
  forwards on every browser of the room, including the ones that did not join or leave.
- **Wait.** While reshaping is held back, the room runs on a graph that no longer fits it: a
  joiner is served less well than it could be, and paths stay longer than they need to be.

Neither is free, so the rule is not "wait until calm". It is: **hold back only what can wait, for
no longer than a stated bound, and decide from what the room is doing.**

## The idea

**Three kinds of topology work, treated differently.**

| Kind    | What it is                                                                                      | Under damping                                      |
| ------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Attach  | A joiner gets edges to members that already have a place. Nobody else's edges change.           | At once                                            |
| Repair  | A member that others depend on left; its dependants get a new upstream. Only they change.       | At once                                            |
| Reshape | The planner recomputes the room's graph: kind, degree, parents. Many members' edges may change. | Held back while the room is restless, with a bound |

The planner already makes this distinction when it plans: attach and repair are its incremental
evolution, reshape is its rebuild. What is missing is that nothing after the planner reads it.
The window, the promotion and the cost to browsers are decided the same way for both.

**When a joiner cannot be attached cheaply.** Sometimes evolution cannot place a joiner and only
a rebuild would. While the reshape gate is closed the joiner is in the room over WS either way,
and what it gets on RTC is decided by whether an edge would live longer than it takes to set up.
If the gate opens within about the time an RTC edge needs to come up, the joiner waits: a forced
edge would be replaced as soon as it was ready. If the gate is further away, it gets one forced
edge now, to a member that has room. The setup time is the one the room already measures for the
gate.

**The signal is the room's own behaviour, not a clock.** A layout pays for itself when it lives
longer than it costs. The room is _restless_ when it asks for a reshape sooner than the last one
could pay for itself, and _calm_ when a layout has survived its ceiling without such a request.
Restless holds reshaping back; calm releases it. "Mechanism" below says how this is counted.

**The wait has bounds, and inside them it follows the room.** A room that never calms, a lobby
for example, must not run on a stale graph for ever. A reshape is never closer to the one before
it than one overlap (15 s), so it never lands inside that overlap, and never further than 60 s
while one is wanted. Between those bounds the gap lengthens when the room absorbed its last
change badly and shortens when it absorbed it cleanly.

**The pressure falls on the joiner's RTC attach, not on the door.** Everyone who arrives is
admitted and is in the room over WS at once. The room takes joiners onto RTC in batches it can
afford, so in a burst the tenth joiner gets its edges a little after the first. That is the back
pressure. The door's fixed limits stay what they are: protection for the server.

**A patched graph is reshaped when a fresh plan would be clearly better.** A room that only
attaches and repairs never asks for a reshape, and its graph drifts. The server compares the
current graph with what a fresh plan would give, on measures it already has, and asks for a
reshape only when the gain passes a bound, as tree refinement does today (25 % and 10 ms). The
request then goes through the same gate as any other. This replaces "at least
every max wait" for reshaping only; attach and repair never wait.

**Circuit breaker is the wrong name.** A breaker refuses work after failures. This holds work back
because it would not pay for itself, and resumes on evidence that it will. The closer relatives
are back-off and route-flap damping.

## Mechanism

**One gate shape, used twice.** The gate is a token bucket that holds a single token. Spending the
token lets one piece of work through; work that finds no token is held until the refill, and held
requests merge into one, as re-plans coalesce today. The bucket holds exactly one token: a second
would allow two changes back to back, which is the case this plan exists to remove.

| Gate    | What spends the token                            | Refill interval                                                          |
| ------- | ------------------------------------------------ | ------------------------------------------------------------------------ |
| Attach  | One batch of joiners taken onto RTC, and repairs | Adapts; never longer than the max wait, which is the promise to a joiner |
| Reshape | One reshape of the room's graph                  | Adapts between one overlap (15 s) and 60 s                               |

**The interval follows how the room absorbed the last change.** After a batch or a reshape the
server looks at what happened: did the edges it asked for come up, how long did they take, did
the layout survive until the next request. A clean result shortens the next interval towards its
lower bound; a slow or broken one, or a request that had to be held, lengthens it towards its
upper bound. There is no arrival-rate threshold to tune: a room that copes with fast arrivals is
not slowed, and a room that struggles with slow ones is.

**A sliding window is the meter, not the gate.** The measuring slice counts joins, leaves,
re-plans and promotions over a sliding window to report how restless rooms are and what each
change cost. It decides nothing.

**Not a leaky bucket.** A leaky bucket that queues work and lets it out at a steady rate would
reshape a restless room at that rate for ever, and would queue reshapes of which only the last
matters. The work here is coalesced, never queued.

**Stored, not held in memory.** Any server of the cluster may run a room's planning work, so the
gate cannot be an object in one process. Its state is stored beside the room's coalesced re-plan
work, where `replanNotBeforeEpochMs` already carries the layout-age floor: per gate, the instant
before which nothing is due and the interval in force. One pure function computes the next state
from the previous state, the request, the last result and the clock, in the style of
`computeTopologyReplanDueAt`.

**Shared primitives.** `packages/shared/resilience` already owns a token bucket
(`rate-limiter.ts`), a sliding-window counter (`sliding-window-counter.ts`) and a back-off
(`failure-backoff.ts`). The rule reuses their arithmetic where it fits a stored-state shape and
adds no purpose-named copy; if the stored-state form needs a pure variant of one of them, that
variant goes into `packages/shared/resilience`, not into the topology folder.

## Goals

- A room under steady churn is reshaped no more often than its layouts can pay for.
- A joiner can send and receive over RTC without waiting for a reshape.
- A member whose upstream left is repaired without waiting for a reshape.
- The wait is bounded, stated, and visible: the server records why a reshape was held and when it
  is due.
- One pure rule decides, in `packages/shared-server/rallar-system/topology/planning/`, tested
  without a server. No per-application special case.

## Non-goals

- Changing what the browser does with a promotion (#823 owns that).
- A new topology kind, or a change to how a full plan is computed.
- Damping RTT-only re-plans further; they are held 15 s already.
- Replacing the lifecycle policy's `commanded` mode, which already hands the decision to the
  application.

## What would make this a failure even if it works

- A joiner waits for a calm room before it has an RTC path.
- A departed relay's dependants stay cut off while the server waits.
- The rule needs tuning per room size or per application to behave.
- A second clock is added beside the three that exist, and the room is still reshaped on a timer.

## Slices

The plan keeps two slices in view; later ones are decided by what these find.

### Slice 1 — measure before deciding

Built. Nothing here changes behaviour.

- Every published RTC topology plan carries a record, `RtcTopologyPlanRecord`
  (`packages/shared/api/topology-plan/rtc-topology-plan-record.ts`): when it was planned, the layout
  it replaced and that layout's age, the causes of the re-plan (`TOPOLOGY_REPLAN_CAUSES`: join,
  leave, leader-change, config, rtt), the layout delta's counts, the longest hop path, and the
  plan's change (Slice 2). `computeRtcTopologyPlanRecord`
  (`packages/shared-server/rallar-system/topology/planning/plan-record/`) computes it inside the
  topology work, so `validateRtcTopologyWork` recomputes and compares it. It is stored as `plan` on
  the immutable `RtcTopologyPublication` row (retained 24 h, null exactly when the layout is
  removed); no browser receives it (D653).
- The operator reads the records with
  `GET /api/admin/operations/rooms/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/topology-plans`
  (`apps/api-v1/src/admin-operations/register-admin-room-routes.ts`), paged by a cursor over
  `listGroupPublicationEntriesPage`. OpenAPI and a step of `api-v1-admin-operations.json` cover it.
- `npm run perf:api-v1:topology-churn`
  (`packages/shared-test/black-box-runner/topology-churn/`) is the measurement. It starts a managed
  API on Postgres and drives six rooms (3, 8 and 20 members, as star, tree and mesh, each under the
  `auto` and the `debounced` replanning policy) through formation, 90 s of one join or leave every
  3 s, and convergence. It reads the records through the operator read and writes
  `topology-churn-report.json` and a Markdown table. It is run by hand; it is not in CI.

### Slice 2 — the kind of each plan is a fact the timing reads

Built. No timing, promotion or delivery behaviour changed.

- The planner returns a `derivation` with each plan (`RtcTopologyPlanDerivation`): `established` (a
  first layout), `incremental` (evolved from the previous layout) or `rebuilt` with a reason. The
  reasons have one owner, `TOPOLOGY_RESHAPE_REASONS`
  (`packages/shared/api/topology-plan/topology-plan-change.ts`): `leader-rooting`,
  `delta-too-large`, `update-failed`, `invariant-violation`, `kind-change` and `refinement`.
- `resolveTopologyPlanChange` is the one rule (D654): a plan that changes no member and no edge has
  no kind; a rebuilt plan is a reshape with its reason; an established plan is an attach; an
  incremental plan whose delta has a leave is a repair, any other an attach.
- The kind is stored as `change` on the record and carried as `planChange` on the accepted work and
  on the work's timing line. Nothing branches on it.
- The churn report counts plans by kind (`plansByKind`, `promotedPlansByKind`,
  `reroutingPlansByKind`), reshapes by reason (`reshapesByReason`) and what a reshape rerouted
  (`reroutedSessionsPerReshape`).
- Pinned at the planner and the work, with a sweep of 58 real-planner plans
  (`packages/tests/shared-server/rallar-system/topology/planning/plan-record/resolve-topology-plan-change.test.ts`)
  that finds no incremental plan rerouting a member the change did not involve.

### What the measurement found

Six rooms, 30 churn plans each (one join or leave every 3 s for 90 s), one formation plan each. Every
churn plan was promoted and landed inside the previous layout's 15 s overlap. Run 3 supplies the
kinds, the reshape figures and the drift; run 2 supplies the rerouted share and the hop paths; the
other columns are the same in both. Drift is extra hops of the accepted layout over the planner's own
fresh no-RTT plan after the 30 churn plans.

| Room               | Churn plans | Plans/min | Promoted | Inside overlap | Attach / repair / reshape | Rerouted an uninvolved member (join/leave plans) | Sessions rerouted per reshape, p50 / max | Longest hop path, max | Drift        |
| ------------------ | ----------- | --------- | -------- | -------------- | ------------------------- | ------------------------------------------------ | ---------------------------------------- | --------------------- | ------------ |
| star 3, auto       | 30          | 20.0      | 30       | 1.00           | 15 / 15 / 0               | 0.00                                             | none                                     | 1                     | 0            |
| star 3, debounced  | 30          | 20.0      | 30       | 1.00           | 15 / 15 / 0               | 0.00                                             | none                                     | 1                     | 0            |
| tree 8, auto       | 30          | 20.0      | 30       | 1.00           | 15 / 12 / 3               | 0.07                                             | 2 / 3                                    | 5-6                   | 0-1          |
| tree 8, debounced  | 30          | 20.0      | 30       | 1.00           | 15 / 11 / 4               | 0.10                                             | 5 / 6                                    | 5-6                   | 0-1          |
| mesh 20, auto      | 30          | 20.0      | 30       | 1.00           | 15 / 10 / 5               | 0.17                                             | 16 / 18                                  | 5                     | undetermined |
| mesh 20, debounced | 30          | 20.0      | 30       | 1.00           | 15 / 9 / 6                | 0.17                                             | 13 / 18                                  | 5                     | undetermined |

Kinds, reshape figures and drift are from run 3; the rerouted share and the hop paths are from run 2.
The tree's drift read 1 extra hop in run 3 (accepted 4, fresh plan 3) and 0 in run 2.

- Every reshape the measurement produced was a leave the planner could not repair incrementally
  (`invariant-violation`): 3 or 4 of the 15 leaves in the 8-member tree, 5 or 6 of the 15 in the
  20-member mesh. The planner sweep finds the same from a formed layout: 9 of the 20 single leaves
  from a mesh and 1 of the 8 from a tree. Only those plans rerouted members they did not involve;
  no attach and no repair did.
- A gate that holds reshapes would therefore hold exactly the plans that reconnect a departed
  relay's dependants, which is the failure named above. The gate slices must first answer it: a
  rule for a rebuild a leave forces, or mesh and tree evolution that repairs those leaves.
- What the scenario did not exercise: no change of kind, no leader re-root and no RTT refinement
  occurred, so the reshapes this plan was written to hold back are unmeasured in rate. `auto` and
  `debounced` do not differ at this cadence: events are 3 s apart and the debounce window is 500 ms.

Done when the report exists for `auto` and `debounced` rooms of three sizes, and per run counts the
plans as attaches, repairs and reshapes and the reshapes by reason: both are met by the runs above.

### Later, decided after slice 2

- Before either gate: what a leave that forces a rebuild does under the reshape gate. The
  measurement shows every reshape at the scenario's cadence was such a leave (see "What the
  measurement found").
- The two gates of "Mechanism": one pure function over stored state, with the lifecycle policy's
  `topology` section carrying the reshape gate's two bounds.
- The forced edge for a joiner that cannot be attached cheaply while the reshape gate is far from
  opening.
- The quality bound that asks for a reshape of a patched graph.
- Folding in the two server paths that re-plan without the tree-keeping gate (leader rooting
  after a failed update, the mesh rebuild), which #823 leaves for a follow-up.

## Validation

- Planner and rule: unit tests under `packages/tests/shared-server/rallar-system/topology/`.
- Mutation paths changed in slices 1 and 2 (a plan is written differently): AppInbox doctrine
  applies, and `test:api-v1:black-box:postgres:medium-scale` runs unweakened.
- `npm run perf:api-v1:topology-churn` is the before-and-after measure for every later slice.
- A hosted run is guidance, not a gate, and needs the maintainer's go-ahead each time.

## Decisions

Decided by the maintainer on 2026-11-14.

| #  | Question                                                               | Decision                                                                                                                                                                                              |
| -- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1  | Which restlessness first                                               | Steady coming and going in a long-lived room. The filling burst already has the expected-members rule.                                                                                                |
| 2  | What a joiner experiences while reshaping is held                      | It is attached at once, with a correct but possibly long path. WS carries its traffic until its first edge is open.                                                                                   |
| 3  | How long a restless room may run without a reshape                     | Never less than 15 s between two reshapes and never more than 60 s while one is wanted. First decided as a doubling from 15 s to 60 s; decision 10 made the gap between those bounds follow the room. |
| 4  | Who decides                                                            | One server rule for every room. The room's lifecycle policy carries the two bounds in its `topology` section; presets set them.                                                                       |
| 5  | The max wait (product decision 31)                                     | It changes meaning: an attach or a repair is promised within the max wait; a reshape is promised within the ceiling.                                                                                  |
| 6  | Measure first                                                          | Yes. Slice 1 changes no behaviour and is the before-and-after measure for every later slice.                                                                                                          |
| 7  | The first fill against later bursts                                    | One phenomenon. The first fill is a challenge, and the same burst can come sporadically at any point of a room's life; one rule covers both.                                                          |
| 8  | What the damping is                                                    | Back pressure on the joiners. Its strength is dynamic: it follows the room, it is not a fixed pair of numbers.                                                                                        |
| 9  | Where a joiner feels the pressure                                      | On its RTC attach. Everyone is admitted and in the room over WS at once; the room takes joiners onto RTC in batches it can afford. The door does not slow.                                            |
| 10 | What the dynamic strength follows                                      | How the room absorbed the last change: how long the new edges took to come up, and whether the layout survived. Not the arrival rate.                                                                 |
| 11 | What reshapes a patched graph                                          | A quality bound: the server asks for a reshape only when a fresh plan would be better by more than a bound, as tree refinement does today.                                                            |
| 12 | The gate's shape                                                       | A token bucket of one, with an interval that adapts. Not a sliding-window limit, not a leaky bucket.                                                                                                  |
| 13 | Order against the other work                                           | After make-before-break (#823) merges. This plan absorbs that pull request's follow-up for the two re-plan paths without the tree-keeping gate.                                                       |
| 14 | A joiner that cannot be attached incrementally while a reshape is held | Decided by edge lifetime: it waits on WS when the gate opens within about an edge's setup time, and gets one forced edge when the gate is further away.                                               |

## Calls the plan makes

An independent reader asked what a builder would still have to guess. These are the plan's own
answers; they are not the maintainer's decisions and can be overturned.

- **A batch is the re-plan window.** The attach gate is the existing coalescing window of the
  room's re-plan work, made adaptive. No joiner is held out of a layout individually; whoever has
  arrived when the token is spent is in that plan.
- **Which policy fields.** `maxReplanWaitMs` keeps its place and becomes the attach gate's upper
  bound (decision 5). The reshape gate's two bounds are new fields in the policy's `topology`
  section. That is a contract change: the OpenAPI schema, the presets, the decoders and their
  tests.
- **Which rooms.** Rooms whose policy says `auto` or `debounced`. A `commanded` room is
  unchanged: its automatic work is already held, and a reshape the application commands is not
  gated.
- **How long the gate's state lives.** It is cleared when the room's layout is removed or its
  topology configuration changes. There is no migration: the stores are wipeable.
- **Slice 1 does not need #823's counters** to count promotions and changed edges, but "landed
  inside the previous overlap" is only meaningful once the overlap exists, which is one reason the
  work starts after #823 merges (decision 13).

## What the measuring slice established

These are the three facts the plan needed. Slice 1 answered what a server can answer; the rest needs
browsers.

1. **What the server can see of "absorbed".** Not measured. The server knows when a layout was
   accepted and replaced, but not when its edges came up: that needs a browser to report, per
   accepted layout, the instant its coverage first reached the success rate.
2. **How far a patched graph drifts.** The accepted layout against the planner's own fresh no-RTT
   plan after 30 attaches and repairs: a star 0 extra hops, a tree 0 or 1 (0 in one run, 1 in the
   other: accepted 4, fresh plan 3). A mesh is undetermined, because no typed read serves the mesh
   parameter the fresh plan needs. RTT drift is unmeasured: the scenario sends no RTT reports.
3. **What an attach batch is worth.** Joiners per plan were 0 or 1 in churn (one event per 3 s) and
   3, 8 and 20 in the formation plan. What a batch costs the members that accept the new edges
   needs browsers (edge setup time).

## Open for the maintainer

- Whether the churn measurement belongs in CI; today it is run by hand.
- Whether "promotion" in this plan means the published plan (what the record counts) or the
  accepted-slot write.
- Whether a deployed store is wiped or pruned at deploy: the record has one stored shape (D653), and
  a store that is not refuses the previous build's publication rows until they expire, up to 24 h.
- A typed read for the mesh parameter, which mesh drift needs.
- What the reshape gate does with a leave the planner cannot repair incrementally, which is every
  reshape the measurement produced.
