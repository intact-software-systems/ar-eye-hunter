# Group dynamics damping

A room whose members keep joining and leaving is re-planned again and again, and each new layout
costs every browser more than the layout it replaces was worth. This plan damps that: the server
holds back the reshaping of a room's distribution graph while the room is restless, lets the
cheap, necessary changes through at once, and bounds how long anyone waits. In the maintainer's
words it is back pressure on the joiners, and its strength must follow what the room is doing.

Slices 1 and 2 are built (pull request #827): the server records each plan and names it an attach, a
repair or a reshape, and nothing acts on that yet. A leave is repaired in place instead of rebuilt (pull
request #837, on top of #827). The gates are not built. The maintainer decided the
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
- `npm run perf:api-v1:topology-reshapes` is the second command, over the same scenario and report
  (schema `rallar.topology-churn.report.v2`). It provokes the reshapes the first one does not: kind
  changes, leader re-roots and RTT refinements. See "The reshape measurement" below.

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
- The kind is stored once, as `change` on the record. The work's timing line prints it from the
  record (`planChange`, and `reshapeReason` for a reshape); nothing carries a second copy, and
  nothing branches on it.
- The churn report counts plans by kind (`plansByKind`, `promotedPlansByKind`,
  `reroutingPlansByKind`), reshapes by reason (`reshapesByReason`) and what a reshape rerouted
  (`reroutedSessionsPerReshape`).
- Pinned at the planner and the work, with a sweep of 205 real-planner plans over five rooms (a mesh of
  20, trees of 8, 12 and 30, a mesh of 30)
  (`packages/tests/shared-server/rallar-system/topology/planning/plan-record/resolve-topology-plan-change.test.ts`)
  that still finds no incremental plan rerouting a member the change did not involve.

### Leave repair — a leave no longer forces a rebuild

Built (pull request #837). The planner's validation and its rebuild fallback are unchanged: a layout that
fails `validateGroupTopology` is still thrown away and rebuilt.

A member that left cannot forward for the room, so a repair that keeps the leaver as a forwarding vertex
fails validation. A leave now runs shared-graph's own cheapest-links remove, which links the leaver's
neighbours and keeps no leaver, with three rules:

- a tree leave uses `REMOVE_MINIMUM_COST_EDGE`, which the planner names for every tree leave in place of
  try-replace (the tree update takes the algorithm from its caller, as the mesh update does);
- when the pair of the leaver's neighbours that the remove chooses is already linked, nothing is added and
  that neighbour counts as connected (one shared step for the four connect helpers);
- when the capacity rule refuses a mesh leave (`hasReconnectCapacity`, asked by the mesh service before the
  remove service) and the mesh stays connected without the leaver, the result is the mesh without the leaver.

The rules and the limits of what they guarantee are in `packages/shared-graph/architecture.md`, "Leaving a
tree or a mesh". `packages/shared-graph/tree/remove-dynamics-mddl.ts`, a second port of try-replace that
nothing imported any more, is deleted; `rvTRMDDLN` in `remove/remove-dynamics-mddl.ts` is the one port.

- **What the sweep found.** Single leaves rebuilt before this slice: 9 of 20 (mesh), 1 of 8, 3 of 12 and 7
  of 30 (trees) and 9 of 30 (mesh). Now 0 of 100. A repair adds at most 4 links (measured over every single leave of the five rooms before the slice) and
  reroutes nobody (pinned by the sweep). The sweep's rooms have no director: no led room and no leader's leave
  is covered.
- **A led tree.** In a led tree a repaired layout can exceed the leader's depth bound, so a `leader-rooting`
  reshape can follow a leave at the next quiet plan: a reviewer measured 2 of 7 non-leader leaves in a led tree
  of 8 and none in led trees of 12 and 30. The leader's own leave is not covered.
- **A thin member.** Of the 50 single mesh leaves, one leaves a member with one link: `peer-11` leaving the
  mesh of 20 leaves `peer-13` with one, because all four pairs the remove chose were already linked, so
  nothing was added. The capacity cases leave nobody under 2 links in these rooms.
- **k is measured, not restored.** Nothing in shared-graph restores a mesh member's k links after a leave.
  The churn report counts them, in the `link-sampled plans` and `members under k links` columns, with the
  room's own k, read once the room is created (`topologyConfig` of each room entry).
- **Complete graph (D659, D660).** The in-place repair, and the weighted mesh rebuild, plan over a complete room
  graph: a measured pair at its RTT, an unmeasured pair at the worst measured RTT plus the canonical pair
  spread. The weighted tree rebuild keeps the sparse measured graph. Two defects on `main` are fixed by it.
  With RTT measurements the global graph held only measured pairs, and the reconnect step looped without
  end when a neighbour had no edge to the connected set; the loop is synchronous, so on the server it would
  stall the whole server process, not only that room. Of the 20 single leaves of a measured mesh of 20, 13 did
  not return within 45 s before (the loop's only exit is at a counter no plan reaches) and all return now. And a measured mesh rebuild was planned empty (`createGroupMesh` fails on the capped
  graph, and the planner's `createNextHopMap` turns the failure into empty next hops); validation refused it
  as disconnected, so a measured mesh never took an RTT improvement and a measured tree could not grow into
  a mesh. Over a sweep of 1 620 measured plans, 714 were disconnected before, all meshes, and none after. A measured join
  into a mesh is repaired in place now, where it was rebuilt and refused.
- **The relaxed degree limit stays (D659).** The reconnect step raises the degree limit by one when no pair
  fits; the maintainer holds that relaxation intended, because the change to the layout would otherwise be
  larger. No validation is relaxed in this slice: the planner, the work, the store, the decoders, the replay
  and the browser's snapshot parser all refuse a member over its limit, and a repair that produced one is
  rebuilt. The churn report's reshapes by reason shows whether that happens. Accepting a stated excess would
  be its own slice across server and browser.
- **The mesh parameter must be below the link limit (D661).** A mesh whose `meshParamK` equals the limit
  cannot be planned, with or without RTT, so configuration refuses `meshParamK >= degreeLimit`, for the
  server configuration and for a room's topology-config write.
- **Several leavers in one plan (D662).** The in-place repair's graph holds the current members and those
  leaving in the same plan, so the repair of one leaver can read the limit of a neighbour that leaves after it;
  the rebuild's graph is unchanged. Two linked members leaving in one plan were always rebuilt before (the
  same on `main`): every linked pair of the meshes of 20 and 30 (37 and 57), and 7 of 7, 8 of 11 and 24 of 29
  in the trees of 8, 12 and 30. Now every pair of members of the five rooms, linked or not, is repaired in
  place and reroutes nobody, and every linked pair of the measured mesh of 20 is repaired in place.
- **The link limit is at least 2 (D662).** Configuration refuses a `degreeLimit` below 2 as a field rule with
  its own message (`degree-limit-below-two`), for the server configuration and a room's topology-config write.
- **Deploy.** A room's stored configuration is re-validated on every read, so a stored one with k at or
  above its limit would fail to load. The wipe was ruled for pull request 827; this work (#837) is stacked on
  #827 and may deploy later or separately, so it must deploy together with #827's wipe or be followed by a wipe
  of its own, or the topology-config records holding k at or above their limit must be removed. An environment that sets a degree limit
  of 2 or below without a mesh parameter below it fails at startup.

Two runs of `npm run perf:api-v1:topology-churn` measured the code of this slice, one before the
final fixes and one on the final code. In both, every room's churn phase had 30 plans, all
promoted and all inside the previous layout's overlap, and attach, repair, and reshape counted
15, 15, and 0: no reshape at all, where the earlier runs had rebuilt 3 to 5 of 15 tree leaves and
5 to 8 of 15 mesh leaves. No plan rerouted a member: rerouted sessions were 0 at the maximum in
every room, where earlier mesh rebuilds had rerouted up to 18. Both mesh rooms had all 30
accepted layouts sampled for links and no member under k links. The drift against a fresh
no-RTT plan was 0 hops in the star rooms in both runs. The tree rooms' accepted layout had a
longest path of 4 hops against 5 (auto) and 4 against 4 (debounced) in the first run, and 5
against 5 (auto) and 3 against 4 (debounced) in the final one. The rooms have no director, so a
leader's re-root was not exercised.

### The reshape measurement

`npm run perf:api-v1:topology-reshapes` drives the churn scenario with named phases that provoke each reason
for a reshape. It starts a managed API on Postgres (ports 18890-18892) and writes
`topology-reshape-report.json` and a Markdown table under
`tmp/api-v1-black-box/postgres-topology-reshapes/<run token>/`. It is run by hand and is not in CI. The churn
command is unchanged and keeps its six rooms; the reshape command is a second command, not a combined room
(maintainer rulings Q-1 and Q-2).

Each room shape runs under both re-planning modes, so there are ten rooms, with group ids
`churn-<index>-<replanning>-<memberCount>`. Each report row is a phase: `formation`, `churn`, `ramp-up`,
`ramp-down`, `flap`, `leader`, `leader-churn`, `rtt-uniform`, `rtt-skewed`, `rtt-shift` and `rtt-churn`.
The report adds `reshapes/min`, the reroutes per reshape reason, the count of appointments and of RTT
reports, and the room's effective configuration (`topologyConfig`: kind, tree from, mesh from, k, degree
limit). Thresholds are read from that configuration, never assumed.

| Room                    | Phases                                                                                                                             | What it provokes                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 4 members               | `ramp-up` to one past the mesh entry, `ramp-down` to one below the tree entry, `flap` (90 s of alternating joins and leaves)       | kind changes up and down; each flap step crosses a threshold    |
| 8 and 12 members, led   | `leader` (four appointments, 10 s apart), `leader-churn` (45 s of churn with a deepest-member appointment after every fourth slot) | leader re-roots                                                 |
| 8 members, RTT sockets  | `rtt-uniform`, `rtt-skewed`                                                                                                        | RTT refinement of a tree                                        |
| 20 members, RTT sockets | `rtt-shift` (a shifting matrix every 10 s for 120 s), `rtt-churn` (45 s of churn with RTT reports interleaved)                     | RTT refinement of a mesh; RTT reports racing membership changes |

**Mechanisms.**

- Appointments go through an admin role: the scenario appoints the creator first, then the deepest member of
  the accepted layout, which is the candidate most likely to need a re-root.
- RTT reports go over ticketed WebSockets that each present member opens after formation, with made-up values.
  The matrix shapes are `uniform` (50 ms for every pair), `skewed` (layout links 120 ms, every other pair
  10 ms) and `shifting` (a new matrix each round). The pairs are taken from the accepted layout.
- The server decides in the order claim, then age. A report claims the room's refinement slot first; a layout
  younger than 15 s then drops the plan. So a first send on a young layout spends its claim and is dropped, and
  the matrix is sent again 32 s later. There is one claim per room per 30 s, because only the primary runs queue
  workers.

**Expectations derived from the code** (these are what the tests pin, not run figures).

- Kind changes at 5 and 16 members going up and at 11 and 4 going down; in `flap` every step crosses one.
- Leader re-root: appointing the deepest member does not always re-root. The planner's fresh tree rooted at the
  candidate is built by nearest weight, not breadth-first, and can be as deep as the kept tree, in which case
  the leader rule keeps the tree. Over 200 rooms with random session ids, about 58 % of deepest appointments
  re-root a room of 8 and about 76 % a room of 12 (a random member: about 34 % in a room of 8). Most deepest
  appointments re-root.
- The uniform matrix is not a control. A tree formed without RTT is often 5 hops across, and a uniform 50 ms
  matrix lets a 3-hop rebuild pass both refinement thresholds (at least 10 ms and at least 25 %), so the
  uniform phase refines the formed tree in about half of rooms of 8. Once refined, a repeated uniform matrix
  keeps the tree. The skewed matrix rebuilds the tree in every room and keeps none of its links.
- Live timing, a derivation and not a run figure: a refinement lands at the repeat send, 32 s after the first,
  and no room refines more than once per 30 s.
- Mesh: consecutive shifting rounds make the planner rebuild the mesh with different links each time. The live
  rate is bounded by the 30 s claim gate and the 15 s young-layout drop, not by the matrix.
- RTT during churn refines only on the membership race, when a report claims between two membership plans.

**Known limits.**

- The RTT values are made up. They show that the server refines and at what rate; they say nothing about real
  RTT.
- The `rtt reports` column counts reports sent, accepted or not. The server may refuse some after a reshape
  (stored measurements live 60 s, and a pair may no longer be a reporting pair), and a member that left during
  churn may still report while the accepted layout holds it. The measurement picks pairs from the accepted
  layout while the server judges them against its stored layout. Refused reports are not seen.
- A joiner during churn has no socket, so it reports nothing.
- Drift is read once per room, at its end. It is measured for star, tree and mesh with the room's own k, and
  has no status of its own.
- Still needing browsers: edge setup time, real RTT, and the cost of a reshape to a browser.

### What the measurement found

Six rooms, 30 churn plans each (one join or leave every 3 s for 90 s), one formation plan each. Every
churn plan was promoted and landed inside the previous layout's 15 s overlap. Every figure is
from one run. Drift is extra hops of the accepted layout over the planner's own
fresh no-RTT plan after the 30 churn plans.

| Room               | Churn plans | Plans/min | Promoted | Inside overlap | Attach / repair / reshape | Rerouted an uninvolved member (join/leave plans) | Sessions rerouted per reshape, p50 / max | Longest hop path, max | Drift        |
| ------------------ | ----------- | --------- | -------- | -------------- | ------------------------- | ------------------------------------------------ | ---------------------------------------- | --------------------- | ------------ |
| star 3, auto       | 30          | 20.0      | 30       | 1.00           | 15 / 15 / 0               | 0.00                                             | none                                     | 1                     | 0            |
| star 3, debounced  | 30          | 20.0      | 30       | 1.00           | 15 / 15 / 0               | 0.00                                             | none                                     | 1                     | 0            |
| tree 8, auto       | 30          | 20.0      | 30       | 1.00           | 15 / 12 / 3               | 0.10                                             | 2 / 3                                    | 6                     | 1            |
| tree 8, debounced  | 30          | 20.0      | 30       | 1.00           | 15 / 11 / 4               | 0.13                                             | 5 / 6                                    | 5                     | 1            |
| mesh 20, auto      | 30          | 20.0      | 30       | 1.00           | 15 / 10 / 5               | 0.17                                             | 16 / 18                                  | 5                     | undetermined |
| mesh 20, debounced | 30          | 20.0      | 30       | 1.00           | 15 / 9 / 6                | 0.20                                             | 13 / 18                                  | 5                     | undetermined |

The table is run 3. Among the cells shown, run 2 differed in the tree's longest hop path (5 for
`auto`, 6 for `debounced`, where run 3 reads 6 and 5), in the tree's drift (0 extra hops, where run
3 reads 1: accepted 4, fresh plan 3) and in the share of join and leave plans that rerouted an
uninvolved member (tree 0.07 and 0.10, mesh 0.17 and 0.17).

Run 4, on the final code, read the kinds differently: attach / repair / reshape star 15 / 15 / 0 under
both policies, tree `auto` 15 / 10 / 5 and `debounced` 15 / 12 / 3, mesh 15 / 7 / 8 under both. Every
reshape was again `invariant-violation`. One reshape in each tree room rerouted nobody; no attach and
no repair rerouted an uninvolved member.

- Every reshape the measurement produced was a leave the planner could not repair incrementally
  (`invariant-violation`): across runs 3 and 4, 3 to 5 of the 15 leaves in the 8-member tree and 5 to
  8 of the 15 in the 20-member mesh. The count varies from run to run. The scenario seeds nothing:
  each leaver is the creator-excluded member present longest by the time its presence was recorded
  (`resolveTopologyChurnEvent`), and the formation members are admitted ten at a time, so their order
  follows request timing. That this is the cause of the variation is not established. The planner
  sweep finds the same from a formed layout: 9 of the 20 single leaves from a mesh and 1 of the 8
  from a tree. Only reshapes rerouted members they did not involve (in run 3 every reshape did, in
  run 4 all but one in each tree room); no attach and no repair did.
- These are the plans that follow a leave the planner cannot repair incrementally: they rebuild the
  layout and reroute members the leave did not involve. A gate that holds reshapes would hold them,
  which, where the leaver was a relay, is the failure named above (a departed relay's dependants stay
  cut off while the server waits). The measurement does not say which leavers were relays. The gate
  slices must first answer it: a rule for a rebuild a leave forces, or mesh and tree evolution that
  repairs those leaves. The leave-repair slice above answers both bullets about these leaves; runs 2 to 4
  stay as the record of the planner before it.
- What the scenario did not exercise: no change of kind, no leader re-root and no RTT refinement
  occurred, so the reshapes this plan was written to hold back were unmeasured in rate; the reshape
  measurement above now provokes them, and its results follow. `auto` and
  `debounced` do not differ at this cadence: events are 3 s apart and the debounce window is 500 ms.

Done when the report exists for `auto` and `debounced` rooms of three sizes, and per run counts the
plans as attaches, repairs and reshapes and the reshapes by reason: both are met by the runs above.

### Later, decided after slice 2

- Answered: what a leave that forces a rebuild does under the reshape gate. A leave is repaired at
  once, and no gate holds a plan a leave makes necessary.
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
  work started after #823 merged (decision 13).

## What the measuring slice established

These are the three facts the plan needed. Slice 1 answered what a server can answer; the rest needs
browsers.

1. **What the server can see of "absorbed".** Not measured. The server knows when a layout was
   accepted and replaced, but not when its edges came up: that needs a browser to report, per
   accepted layout, the instant its coverage first reached the success rate.
2. **How far a patched graph drifts.** The accepted layout against the planner's own fresh no-RTT
   plan after 30 attaches and repairs: a star 0 extra hops, a tree 0 or 1 (0 in one run, 1 in the
   other: accepted 4, fresh plan 3). A mesh's drift is computed with the room's own k, read from the room's
   effective configuration. RTT drift is measured only against made-up values: the reshape measurement sends
   RTT reports, but they are not real RTT.
3. **What an attach batch is worth.** Joiners per plan were 0 or 1 in churn (one event per 3 s) and
   3, 8 and 20 in the formation plan. What a batch costs the members that accept the new edges
   needs browsers (edge setup time).

## Answered by the maintainer (2026-11-16)

1. A leave always reconnects at once; no gate ever holds a plan a leave makes necessary. Whether a leaver
   left for good is perhaps never known; it may stay available for a while to forward as a non-member.
2. The store is wiped when pull request 827 deploys: one stored shape, no window of refused rows.
3. The plans read keeps answering 500 for a room with an undecodable stored publication.
4. The churn measurement stays a manual command, out of CI.
5. "Promoted" as sampled is enough: published plans checked against 250 ms samples of the accepted layout.
6. The mesh parameter gets a typed read with the next measurement, so mesh drift can be computed.
7. The record's delta is decided with the gates: it stays against the planned layout until a gate holds a plan.
8. The plan's kind has one home, the record's `change`; it is not copied onto the accepted work.
9. The seven-digest pin test stays deleted.

## Still open

- Restoring a mesh member's k links after a leave, if the measurement shows meshes thinning.
- A leave in a led room, which the sweeps do not cover: whether `leader-rooting` reshapes follow leaves more
  than the reviewer's measurement suggests, and the leader's own leave.
- Three or more leavers in one plan: the pair sweep covers two; the graph holds every leaver of the plan, but
  no sweep measured more.
- Accepting a stated degree excess, if repairs that the reconnect step's relaxation produces are rebuilt.
