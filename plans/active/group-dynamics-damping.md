# Group dynamics damping

A room whose members keep joining and leaving is re-planned again and again, and each new layout
costs every browser more than the layout it replaces was worth. This plan damps that: the server
holds back the reshaping of a room's distribution graph while the room is restless, lets the
cheap, necessary changes through at once, and bounds how long anyone waits. In the maintainer's
words it is back pressure on the joiners, and its strength must follow what the room is doing.

Slices 1 and 2 are built (pull request #827): the server records each plan and names it an attach, a
repair or a reshape, and nothing acts on that yet. A leave is repaired in place instead of rebuilt (pull
request #837, on top of #827). The optional reshapes are measured (pull request #840). The reshape
gate is designed (see "The reshape gate") and neither gate is built. The maintainer decided the
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
accepted layouts sampled for links and no member under k = 2 links (k was assumed in those runs). The drift against a fresh
no-RTT plan was 0 hops in the star rooms in both runs. The tree rooms' accepted layout had a
longest path of 4 hops against 5 (auto) and 4 against 4 (debounced) in the first run, and 5
against 5 (auto) and 3 against 4 (debounced) in the final one. The rooms have no director, so a
leader's re-root was not exercised.

### The reshape measurement

`npm run perf:api-v1:topology-reshapes` drives the churn scenario with named phases that provoke each reason
for a reshape. It starts a managed API on Postgres (ports 18890-18892) and writes
`topology-reshape-report.json` and a Markdown table under
`tmp/api-v1-black-box/postgres-topology-reshapes/<run token>/`. It is run by hand and is not in CI. The churn
command is unchanged and keeps its six rooms. The maintainer ruled two things: the reshape measurement is a
second manual command, and there is no combined room that provokes everything at once.

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

**Expectations derived from the code and from sampling the planner** (not run figures).

- Kind changes at 5 and 16 members going up and at 11 and 4 going down; in `flap` every step crosses one.
- Leader re-root: appointing the deepest member does not always re-root. The planner's fresh tree rooted at the
  candidate is built by nearest weight, not breadth-first, and can be as deep as the kept tree, in which case
  the leader rule keeps the tree. Over 200 rooms with random session ids, about 58 % of deepest appointments
  re-root a room of 8 and about 76 % a room of 12 (a random member: about 34 % in a room of 8). Most deepest
  appointments re-root.
- The uniform matrix is not a control. A tree formed without RTT is often 5 hops across, and a uniform 50 ms
  matrix lets a 3-hop rebuild pass both refinement thresholds (at least 10 ms and at least 25 %), so the
  uniform phase refines the formed tree in about half of rooms of 8. Once refined, a repeated uniform matrix
  keeps the tree. The skewed matrix rebuilds the tree in every room. It keeps none of the formed tree's links,
  and about one of a tree the uniform matrix refined (1 of 7 in a room of 8). The uniform phase's measurements
  live 60 s and occupy endpoint degree, so while they live the server refuses some skewed reports as over-degree
  (about 5 % of the skewed reports over 200 sampled rooms, refused as over-degree).
- Live timing, a derivation and not a run figure: a refinement lands at the repeat send, 32 s after the first,
  and no room refines more than once per 30 s.
- Mesh: consecutive shifting rounds make the planner rebuild the mesh with different links each time. The live
  rate is bounded by the 30 s claim gate and the 15 s young-layout drop, not by the matrix.
- RTT during churn refines only on the membership race, when a report claims between two membership plans.

**Known limits.**

- The RTT values are made up. They show that the server refines and at what rate; they say nothing about real
  RTT.
- The `rtt reports` column counts reports sent, accepted or not. The server may refuse some after a reshape
  (stored measurements live 60 s, and a pair may no longer be a reporting pair). The measurement picks pairs
  from the accepted layout while the server judges them against its stored layout. Refused reports are not
  seen.
- A member that left during churn keeps its socket, because closing it would make the server clean up the
  session. While the accepted layout still holds that member, the measurement neither reports from it nor
  reports a pair that includes it, since the server would refuse such a pair (`no-shared-active-group`).
- A joiner during churn has no socket, so it reports nothing.
- Drift is read once per room, at its end. It is measured for star, tree and mesh with the room's own k, and
  has no status of its own. It is signed: the fresh no-RTT plan is the planner's reference layout, not the
  shortest one, so an evolved layout can be shorter and the difference negative.
- Still needing browsers: edge setup time, real RTT, and the cost of a reshape to a browser.

### What the reshape measurement found

Two runs of `npm run perf:api-v1:topology-reshapes` on the head `eb0340275`, 2026-11-18, local Postgres, a managed
three-process cluster. Run 1 is report `d8ebab469b7c4a4fbb11dc0e`, run 2 is `9901776c88174aa0bbb7978a`. Both
passed: ten rooms formed, ran their phases and converged, and no plan fell outside a phase in any room. In the same
session the medium-scale Postgres black-box passed (2842 operations, 0 failures) and the standard Postgres
black-box passed (api-v1 75, cluster 13). The churn command's six rooms (report `651158195fba4bb599c985bd`) read
15 attaches, 15 repairs and 0 reshapes in every room.

Each cell reads run 1 / run 2; one value means both runs agree. "Rerouted" is sessions rerouted per reshape, median
(max). "Inside" is promoted plans that landed inside the replaced layout's overlap window. Every row's reason is the
one named; there is no other reason in any phase.

| Room and phase                       | Mode      | Plans   | Reshapes | Per min   | Rerouted          | Appointments | RTT sent  | Inside  |
| ------------------------------------ | --------- | ------- | -------- | --------- | ----------------- | ------------ | --------- | ------- |
| 4 members, `ramp-up`                 | auto      | 13      | 2        | 3.1       | 3 (15) / 4 (15)   | 0            | 0         | 13      |
| 4 members, `ramp-up`                 | debounced | 13      | 2        | 3.1       | 4 (14) / 4 (15)   | 0            | 0         | 13      |
| 4 members, `ramp-down`               | auto      | 13      | 2        | 3.1       | 2 (10)            | 0            | 0         | 13      |
| 4 members, `ramp-down`               | debounced | 13      | 2        | 3.1       | 0 (10) / 2 (9)    | 0            | 0         | 13      |
| 4 members, `flap`                    | both      | 30      | 30       | 20.0      | 3 (4)             | 0            | 0         | 30      |
| 8 members, `leader`                  | auto      | 3       | 3        | 4.5       | 7 (7) / 5 (5)     | 4            | 0         | 2       |
| 8 members, `leader`                  | debounced | 0 / 1   | 0 / 1    | 0 / 1.5   | none / 7 (7)      | 4            | 0         | 0       |
| 12 members, `leader`                 | auto      | 4       | 4        | 6.0       | 9 (10) / 11 (11)  | 4            | 0         | 4       |
| 12 members, `leader`                 | debounced | 4       | 4        | 6.0       | 7 (12) / 11 (11)  | 4            | 0         | 4       |
| 8 members, `leader-churn`            | auto      | 19      | 4        | 5.3       | 7 (9) / 9 (9)     | 4            | 0         | 19      |
| 8 members, `leader-churn`            | debounced | 18      | 3        | 4.0       | 7 (7) / 6 (8)     | 4            | 0         | 17      |
| 12 members, `leader-churn`           | auto      | 17 / 19 | 2 / 4    | 2.7 / 5.3 | 13 (13) / 11 (12) | 4            | 0         | 17 / 19 |
| 12 members, `leader-churn`           | debounced | 18 / 19 | 3 / 4    | 4.0 / 5.3 | 10 (11) / 11 (12) | 4            | 0         | 18 / 19 |
| 8 members, RTT, `rtt-uniform`        | auto      | 1 / 0   | 1 / 0    | 1.6 / 0   | 7 (7) / none      | 0            | 38 / 38   | 0       |
| 8 members, RTT, `rtt-uniform`        | debounced | 0       | 0        | 0         | none              | 0            | 40 / 38   | 0       |
| 8 members, RTT, `rtt-skewed`         | auto      | 1       | 1        | 1.6       | 8 (8)             | 0            | 38 / 38   | 0       |
| 8 members, RTT, `rtt-skewed`         | debounced | 1       | 1        | 1.6       | 8 (8)             | 0            | 40 / 38   | 0       |
| 20 members, RTT, `rtt-shift` (120 s) | auto      | 3       | 3        | 1.5       | 8 (8) / 10 (11)   | 0            | 537 / 545 | 0       |
| 20 members, RTT, `rtt-shift` (120 s) | debounced | 3       | 3        | 1.5       | 7 (10) / 8 (14)   | 0            | 550 / 548 | 0       |
| 20 members, RTT, `rtt-churn` (45 s)  | auto      | 15      | 0        | 0         | none              | 0            | 156 / 152 | 14      |
| 20 members, RTT, `rtt-churn` (45 s)  | debounced | 15      | 0        | 0         | none              | 0            | 160 / 172 | 14      |

The reason is `kind-change` in the 4-member room, `leader-rooting` in the led rooms and `refinement` in the RTT
rooms. The other plans in `ramp-up`, `ramp-down`, `leader-churn` and `rtt-churn` are attaches and repairs: 11
attaches in `ramp-up`, 11 repairs in `ramp-down`, 8 attaches and 7 repairs in each churn phase.

**What met the expectation.**

- Kind changes: two in `ramp-up` and two in `ramp-down` in both modes and both runs, and all 30 `flap` plans were
  kind changes (20.0 a minute, each rerouting a median 3 and at most 4 sessions).
- Leader re-roots: `leader-rooting` appeared in `leader-churn` in every led room and in `leader` in every led room
  but the debounced room of 8 in run 1, 2 to 4 per room in `leader-churn` next to its 8 attaches and 7 repairs. In `leader`, of four appointments the auto room of 8
  re-rooted 3 and 3, the auto room of 12 4 and 4, and the debounced room of 12 4 and 4.
- RTT tree: `rtt-skewed` refined exactly once in all four room-runs, rerouting 8 of 8 sessions each time. No tree
  refinement landed inside the overlap window.
- RTT mesh: `rtt-shift` refined three times in 120 s (1.5 a minute) in all four room-runs, within the claim bound
  of at most four, rerouting a median 7 to 10 (at most 14). No mesh refinement landed inside the overlap window.
- Both runs agree on which phase produces which reason.
- Overlap: every kind change landed inside the replaced layout's overlap window. A leader plan landed outside it
  when the appointment followed a layout older than 15 s: in the auto room of 8 only 2 of 3 plans landed inside, in
  both runs, and in the debounced room of 8's run 2 the one plan landed outside. The other `leader` phases landed 4
  of 4 inside. Under churn one plan per room-run landed outside in the debounced room of 8's `leader-churn` (17 of
  18) and in each mesh room's `rtt-churn` (14 of 15).

**What missed, and why.**

- The debounced room of 8 re-rooted 0 of 4 appointments in run 1 and 1 of 4 in run 2. This is the nearest-weight
  case described above: a leader whose fresh tree is no shallower keeps the kept tree, and an unchanged plan
  publishes nothing. It is consistent with the sampled 58 % for a room of 8 and is not a fault.
- `rtt-uniform` refined once in four room-runs (the auto room, run 1). The expectation was about half of rooms of
  8, so one of four is a small sample and inside it. The other three did not refine.
- `rtt-churn` refined zero times in all four room-runs. Churn re-plans every 3 s, so every report met a layout
  younger than 15 s and was dropped; the membership race, a report claiming between two membership plans, did not
  occur. The expectation named that race as the only way to refine, so zero is within it.

**What the gate slices can start from.** Per minute: a `kind-change` reshape every 3 s under `flap` (20.0 a
minute), 3.1 a minute across a 39 s ramp, `leader-rooting` 4.0 to 6.0 a minute when four appointments or churn
drive it (0 to 1.5 in the debounced room of 8's `leader`, 2.7 in one room-run of `leader-churn`), and
`refinement` 1.5 a minute for a mesh of 20 under a shifting matrix and 1.6 in the 38 s the tree phases run. Sessions rerouted per reshape: a median 0 to 4 for a kind change (at most 15 on a
ramp, at most 4 on a flap), 5 to 13 for a leader re-root, 7 to 8 for a tree of 8 refined by RTT and 7 to 10 for a
mesh of 20. Run to run, the figures that varied were the rerouted counts, the led rooms' re-root counts and the
uniform phase's single refinement; the kind-change counts and the RTT mesh rates did not.

### What the measurement found

Six rooms, 30 churn plans each (one join or leave every 3 s for 90 s), one formation plan each. Every
churn plan was promoted and landed inside the previous layout's 15 s overlap. Every figure is
from one run. Drift is the accepted layout's longest path minus the longest path of the planner's
own fresh no-RTT plan, after the 30 churn plans. The fresh plan is the planner's reference layout,
not the shortest one, so the difference can be negative.

| Room               | Churn plans | Plans/min | Promoted | Inside overlap | Attach / repair / reshape | Rerouted an uninvolved member (join/leave plans) | Sessions rerouted per reshape, p50 / max | Longest hop path, max | Drift        |
| ------------------ | ----------- | --------- | -------- | -------------- | ------------------------- | ------------------------------------------------ | ---------------------------------------- | --------------------- | ------------ |
| star 3, auto       | 30          | 20.0      | 30       | 1.00           | 15 / 15 / 0               | 0.00                                             | none                                     | 1                     | 0            |
| star 3, debounced  | 30          | 20.0      | 30       | 1.00           | 15 / 15 / 0               | 0.00                                             | none                                     | 1                     | 0            |
| tree 8, auto       | 30          | 20.0      | 30       | 1.00           | 15 / 12 / 3               | 0.10                                             | 2 / 3                                    | 6                     | 1            |
| tree 8, debounced  | 30          | 20.0      | 30       | 1.00           | 15 / 11 / 4               | 0.13                                             | 5 / 6                                    | 5                     | 1            |
| mesh 20, auto      | 30          | 20.0      | 30       | 1.00           | 15 / 10 / 5               | 0.17                                             | 16 / 18                                  | 5                     | undetermined |
| mesh 20, debounced | 30          | 20.0      | 30       | 1.00           | 15 / 9 / 6                | 0.20                                             | 13 / 18                                  | 5                     | undetermined |

The table is run 3. Among the cells shown, run 2 differed in the tree's longest hop path (5 for
`auto`, 6 for `debounced`, where run 3 reads 6 and 5), in the tree's drift (0, where run
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
  occurred, so the reshapes this plan was written to hold back were unmeasured in rate. The reshape
  measurement above provokes them; its figures are recorded below once a run has been made. `auto` and
  `debounced` do not differ at this cadence: events are 3 s apart and the debounce window is 500 ms.

Done when the report exists for `auto` and `debounced` rooms of three sizes, and per run counts the
plans as attaches, repairs and reshapes and the reshapes by reason: both are met by the runs above.

### The reshape gate

Designed, not built. This is the next slice. It builds the reshape gate of "Mechanism" and nothing else:
the attach gate, the forced edge and the quality bound stay in "Later".

**What it is for.** The reshape measurement read a kind change every 3 s under a flapping room (20 a
minute) and a leader re-root on most of four appointments 10 s apart. Each rebuilds the room's graph
and reroutes members the change did not involve. After this slice an optional reshape is never closer
than 15 s to the room's previous reshape and never waits more than 60 s, while every join and every
leave is still planned at once.

**Ruled by the maintainer (2026-11-18).**

1. The wait follows held requests. A reshape that is asked for while the gate is closed doubles the
   wait that follows it (15, 30, 60 s). A reshape that finds the gate open with nothing held puts the
   wait back to 15 s. The browser's read of how a room absorbed a change joins later as a second input.
2. A leader re-root waits for the gate like any other optional reshape. The tree works with its old
   root meanwhile. A topology-config write is a command and is not gated.
3. The gate is an input to the planner (approach A below).
4. It runs on any server of the cluster and adds no machinery beside the existing one: no state in a
   process, no timer, no lock, no second queue and no new AppInbox command.

**Where it runs.** A room is re-planned by the topology work, the APP_OUTBOX row that a membership,
leader or configuration command queues in its AppInbox transaction and that one server reserves when
it is due (`replay/work/create-rtc-topology-work-handler.ts`). The work is
`read -> compute -> validate -> write`, and its write is one transaction guarded by the stored
layout's revision. The gate lives inside those four steps:

| Step     | What the gate adds                                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| read     | The room's stored gate state and the policy's two bounds, with the facts the work reads already.                                      |
| compute  | One pure rule says open or closed. The planner is told, plans accordingly and reports what it held. The rule computes the next state. |
| validate | The plan and the next state are recomputed from the same read and compared, as the plan record is today.                              |
| write    | The next state, with expected-revision compare-and-set, and the wake-up row when one is due, in the work's one transaction.           |

A work that loses a race is redelivered and starts from `read`, so it sees the winner's gate state.

**The stored state**, one record per room in the runtime state store under its own namespace (the
input fingerprint is the precedent, `rtc-topology-execution-repository.ts`):

- `lastReshapeAtEpochMs`: when the room's last reshape was published; null before the first.
- `intervalMs`: the wait in force after that reshape.
- `wanted`: null, or the instant a reshape was first held in this period and the reasons held.

The gate is closed while `now < lastReshapeAtEpochMs + intervalMs`. A room with no stored state has an
open gate and the lower bound as its interval. The record is removed with the room's layout.

**The rule**, one pure function in `topology/planning/`, from the previous state, the bounds, the
clock and what the plan did:

1. The plan publishes a reshape, for any reason and from any origin: `lastReshapeAtEpochMs` becomes
   now and `wanted` becomes null. The interval doubles, capped at the upper bound, when `wanted` was
   set; it returns to the lower bound when the gate was open and nothing was wanted; otherwise it is
   unchanged.
2. The gate is closed and the planner reports a held reshape: `wanted` is set, keeping its first
   instant and adding the reasons. The first hold of a period queues the wake-up.
3. The gate is open, `wanted` is set and the plan is no reshape: the want has gone, and `wanted`
   becomes null.
4. Anything else leaves the state as it is and writes nothing for the gate.

A first layout (`established`) is not a reshape and does not start a period: it replaces nothing.

**What a closed gate does to each reason.** The planner takes one new input, reshape `allowed` or
`held`. Commanded work is always `allowed`. With `held` and an active previous layout:

| Reason                | With the gate closed                                                                                                                                       | Counts as held |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `kind-change`         | The previous kind is kept and the room is evolved in place. A star is a complete graph, so it is kept only while every member stays within the link limit. | Yes            |
| `leader-rooting`      | The tree keeps its root. A leader that joins is attached like any joiner.                                                                                  | Yes            |
| `delta-too-large`     | The room is evolved in place whatever the size of the delta.                                                                                               | No             |
| `refinement`          | An RTT refresh is held as it is today for a young layout: the stored layout stays and nothing is written. A later RTT claim asks again.                    | No             |
| `update-failed`       | Not held. The in-place update failed, so the room is rebuilt at once, with the kind and the root a fresh plan selects.                                     | —              |
| `invariant-violation` | Not held, for the same reason.                                                                                                                             | —              |

Every automatic work that reaches the planner while the gate is closed plans as a membership delta,
whatever intent it carries today. A rebuild the planner cannot avoid takes the wanted kind and root
with it, which is why rule 1 clears `wanted`.

**The wake-up.** A held reshape in a room where nothing else happens would never run, so the first
hold of a period inserts one APP_OUTBOX row due at `lastReshapeAtEpochMs + intervalMs`. Its identity
is derived from the room and `lastReshapeAtEpochMs`, so there is one per period and the insert-only
rule holds. Membership changes do not merge into it and do not delay it: the room's coalesced re-plan
row keeps its own window. When it is due any server takes it and plans the room as a membership delta
with the gate's state as read. A row that is early by the local clock is retried, as the formation
timer does; a row whose period has ended completes without planning.

**A hold can be the whole outcome.** A leader appointed in a quiet room with the gate closed changes
no layout. Today that work ends with nothing to store. It now writes the gate state and the wake-up
row in one transaction of the same shape as a publication, without a publication.

**The policy.** The lifecycle policy's `topology` section gains `reshapeMinIntervalMs` and
`reshapeMaxIntervalMs`, 15 000 and 60 000 in all four presets. Sparse input takes the preset's values.
The lower bound in force is the larger of the policy's and the server's replaced-layout overlap
(`rtcReplacedLayoutOverlapMs`), and the upper bound is never below it. A policy whose upper bound is
below its lower is refused with its own issue code. The bounds apply to `auto` and `debounced` rooms;
a `commanded` room's automatic work is already held. This changes the contract: the OpenAPI schema,
the presets, the decoders and their tests.

**What an operator sees.**

- The plan record gains the reasons held while that plan was computed, empty when none.
- The topology-plans read returns the room's gate state beside the page of records: the last reshape,
  the interval, the instant the gate opens and what is wanted.
- The work's timing line prints the gate's decision.
- `npm run perf:api-v1:topology-reshapes` reports, per phase, the reshapes held and the longest
  interval, and waits for `wanted` to clear before it reads convergence.

**Approaches considered.**

- **A, the gate is an input to the planner (chosen).** One planning pass. The planner changes in the
  places where an optional reshape is decided today and reports what it held.
- **B, plan twice.** The work plans as today and plans again with kind and root pinned when the first
  result is an optional reshape and the gate is closed. The planner needs the same switches, and a
  restless room pays for two plans and two validations per held change.
- **C, hold the whole plan.** The plan is dropped and retried when the gate opens. A joiner or a
  leaver in that plan waits with it, which is two of this plan's own failure conditions.

**Calls this design makes.** These are not the maintainer's decisions and can be overturned.

- Only `kind-change` and `leader-rooting` are recorded as wanted. A too-large delta that is evolved in
  place owes the room nothing until the quality bound exists.
- A reshape that passes a closed gate because it is necessary or commanded starts a new period and
  does not lengthen the wait unless something was held.
- A want that has gone by the time the gate opens leaves no trace in the interval.
- A commanded reshape starts a period like any other, so the state is no longer cleared when the
  room's topology configuration changes, as this plan first said.
- A join whose in-place attach fails is rebuilt at once, as today, until the forced edge is built.
- The two bounds are required stored fields, so a stored policy or plan record written before this
  slice does not decode. The stores are wiped at deploy, as ruled for pull request 827.
- An RTT refinement waits for the gate and starts a period when it publishes. This goes one step past
  the non-goal "Damping RTT-only re-plans further": when the interval is above 15 s a refinement waits
  longer than it does today. Open with the maintainer.

**Left to the builder.** Names and file split; whether the wake-up is a new work kind or a
group-revision work under its own resource id; the exact shape of the gate state in the operator
read; how the measurement counts holds.

**Existing expectations that move.** A test, recipe or browser lane that expects two automatic
reshapes within 15 s of each other now sees the second one held. The builder lists each one found and
what it becomes; none is loosened without being named in the pull request.

**Done when.**

- The rule and the held planner are pinned by unit tests without a server, and the planner sweep
  shows that no plan made with reshape `held` reroutes a member the change did not involve.
- A cluster-profile recipe shows a reshape held on one server and released at its due time, with the
  two reshapes at least 15 s apart in the operator read.
- `npm run perf:api-v1:topology-reshapes` reads: no two reshapes of a room closer than the interval in
  force; at most 4 kind changes in the 90 s `flap` phase, where the measurement read 30; at most 2
  re-roots in a `leader` phase of four appointments; every membership plan of those phases still
  published as an attach or a repair. `npm run perf:api-v1:topology-churn` still reads 15 / 15 / 0.
- `test:api-v1:black-box:postgres:medium-scale` passes unweakened.

### Later, decided after slice 2

- Answered: what a leave that forces a rebuild does under the reshape gate. A leave is repaired at
  once, and no gate holds a plan a leave makes necessary.
- The attach gate of "Mechanism": the room's re-plan window made adaptive. It follows edge setup
  time, which only browsers can report, so it comes after that read exists.
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
- **How long the gate's state lives.** It is removed with the room's layout. There is no migration:
  the stores are wipeable. (This first said a topology configuration change clears it too; "The
  reshape gate" replaces that.)
- **Slice 1 does not need #823's counters** to count promotions and changed edges, but "landed
  inside the previous overlap" is only meaningful once the overlap exists, which is one reason the
  work started after #823 merged (decision 13).

## What the measuring slice established

These are the three facts the plan needed. Slice 1 answered what a server can answer; the rest needs
browsers.

1. **What the server can see of "absorbed".** Not measured. The server knows when a layout was
   accepted and replaced, but not when its edges came up: that needs a browser to report, per
   accepted layout, the instant its coverage first reached the success rate.
2. **How far a patched graph drifts.** The accepted layout's longest path minus that of the
   planner's own fresh no-RTT plan, after 30 attaches and repairs: a star 0, a tree 0 or 1 (0 in one
   run, 1 in the other: accepted 4, fresh plan 3). The difference is signed. The fresh plan is the
   planner's reference layout, not the shortest one, so an evolved layout can be shorter: a later
   live run read -1 in 3 of 6 rooms (the auto room of 8 and both rooms of 20). A mesh's drift is computed with the room's own k, read from the
   room's effective configuration. RTT drift stays unmeasured against real RTT: the reshape measurement sends
   RTT reports, but the values are made up, and the drift read compares with a no-RTT plan.
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
