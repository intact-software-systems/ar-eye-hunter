# Group Activation Product Plan (2026-08-22)

Status: **product plan — decisions 1–13 taken with the product owner on 2026-08-22.** This document
records what the Rallar product should support for application-controlled group activation. It
deliberately stops short of slicing and implementation; those follow in a companion implementation
plan once this surface is signed off. The current behaviour it departs from is the landed
`docs/rallar-group-formation-architecture.md`; the control-plane workstream it extends is
`2026-08-17-group-lifecycle-control-plane-implementation-plan.md` (complete); the story it is
steering toward is `plans/rallar-distributed-group-rtc-activation-design.md`, taken as direction,
not as a dictate.

## The product promise

An application controls a group's activation to the level of control that makes sense for it: when
the group discovers members, when members receive a connection layout, when they start connecting,
when the group counts as live, and when the layout may change. Rallar keeps the group safe in every
stage, tells the application what is actually connected, and makes no RTC connection attempt the
application's policy did not sanction. A simple application sets a preset and never issues a
command; a demanding one drives every stage by hand. Both use one model.

## Requirements

| #  | Requirement                                                                                                                                | What "supported" means                                                                                                                                      |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1 | A web SPA can control the stages of group activation completely, down to the level of control that makes sense for the 99th-percentile app | Every stage boundary is a named, remotely commandable transition with a receipt; presets bundle them so most apps never command anything                    |
| R2 | Stage transitions are initiated remotely                                                                                                   | Commands are HTTP/WS AppInbox mutations from an authorized principal or from policy-driven automation; the server never needs a co-located controller       |
| R3 | Overlay construction does not mean clients immediately start RTC connections                                                               | A stage exists in which the layout is planned and distributed while no client dials; bootstrap dialing is suppressed there and in discovery                 |
| R4 | The SPA separates "received the layout" from "connect using the layout"                                                                    | The browser runtime exposes both as distinct events/states and dials only when the group's stage permits                                                    |
| R5 | A group can remain in one stage for as long as the application desires, so large groups avoid redundant short-lived reconfigurations       | No stage advances on its own unless policy says so; topology evolution after a layout exists is policy: automatic, debounced, or commanded                  |
| R6 | Group state is easy to fetch over HTTP and is pushed over WS on change and on connect — for applications and for tests                     | Intent, layout, and observed connectivity status all ride the existing snapshot/delta/hydration channels and the formation view; recipes pin each behaviour |

## What holds today, and the gaps

The landed control plane already gives R2 and the safety baseline: intent (`forming / establishing
/ active / reconfiguring`) is persisted on the group, changed only by authorized commands, pushed
in every snapshot and delta, hydrated on connect, and policy decides who may command
(`establishment.initiator`) and whether activation is automatic (`activation.mode`). The gaps,
verified against the code on 2026-08-22:

- **There is no held-layout stage.** `establishing` plans, publishes, and browsers dial the moment
  the overlay arrives.
- **Discovery does not hold dialing.** `forming` holds server planning, but the browser falls back
  to the group's online members when no server overlay exists and `bounded-bootstrap` dials up to
  `maxPeerConnections` of them (`WebRtcGroupManager.targetPeerIdsForGroup` →
  `computeOutboundDialPlan`). A presence-connected lobby already makes bounded RTC attempts.
- **Topology evolution is not controllable.** Outside `forming`, every membership change re-plans,
  re-publishes, and re-dials.
- **Pacing is declared but not enforced.** `establishment.maxConcurrentEdgeSetups` is persisted
  and unread.
- **Observed connectivity has no living status.** The formation view derives a readiness fraction
  on read; nothing names the connectivity state, nothing remembers it, nothing pushes it.

## Decisions taken

| #  | Decision                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1  | **The held-layout phase is expressed as distinct lifecycle stages**, `planned` and `connecting`, replacing the single `establishing`. One enum every surface already reads; the browser's dial gate is a pure function of the stage.                                                                                                                                                                                            |
| 2  | **Topology evolution after a layout exists is a policy field**, `topology.evolution: 'auto' \| 'debounced' \| 'commanded'`, default `auto`. `auto` is today's replan-on-every-change, so the absent policy and every existing group behave exactly as now; `debounced` coalesces changes under server-clamped windows; `commanded` queues changes until the application reconfigures.                                           |
| 3  | **The observed connectivity status is a living, pushed field**: persisted on the group beside the intent fields as derived, non-authoritative state, written only by internal authority after hysteresis and a minimum dwell, so it rides snapshots, deltas, on-connect hydration, and events with no new transport. No policy or gate may ever read it.                                                                        |
| 4  | **Policy-driven automation stays beside app-commanded control.** Automatic groups advance through the same stages on policy triggers; commanded groups advance on application commands. One model, two drivers, identical receipts and events.                                                                                                                                                                                  |
| 5  | **`reconfigure` lands in `planned` by default**; the command accepts `landing: 'connecting'` for applications that want the new layout dialed immediately. Evolution-driven reconfigures use the preset's landing. A frozen match distributes its new layout without a re-dial storm; a between-rounds reshuffle can opt into immediate dialing per call.                                                                       |
| 6  | **Preset evolution modes**: `optimistic` = `auto`, `managed` = `debounced`, `match` = `commanded`, `drop-in-social` = `debounced`. The absent policy and `optimistic` keep today's behaviour; `managed` and `drop-in-social` groups created after the change coalesce churn by default (stored policies on existing groups are untouched); `match` freezes the mesh.                                                            |
| 7  | **`degraded` and `failed` are coverage bands from the policy's two rates, held for a dwell**: `degraded` = coverage `< successRate` and `>= minimumViableRate` for at least the dwell; `failed` = coverage `< minimumViableRate` for at least the dwell, or formation attempts exhausted. The dwell starts as a server default on the order of the evidence window and becomes a policy knob only when an application needs it. |
| 8  | **One trigger vocabulary drives both automatic boundaries**, `forming → planned` and `planned → connecting`: immediately, after a settle time, or when a member-presence threshold is met with a timer fallback. Immediate is the default, so automatic groups behave as today; the presence trigger lets a large automatic lobby wait for its members before either step.                                                      |
| 9  | **The observed status uses lower-case names**, `inactive \| initialising \| active \| reconfiguring \| degraded \| failed`, matching every enum on the wire. `active` and `reconfiguring` appear in both the stage and the status enums with related but distinct meanings, disambiguated by field name. The activation design's upper-case names remain prose references.                                                      |
| 10 | **A held layout is readable exactly like a dialed one**: `GET …/topology` and the overlay push keep today's topology-read authorization. The members who must hold the layout are the ones who must read it; withholding it would break R4.                                                                                                                                                                                     |
| 11 | **Layout staleness is a recorded comparison**: the group stores the roster version its current layout was planned from (`layoutRosterVersion`), and the snapshot derives `layoutStale` from it against `rosterVersion`. Cheap, exact, and visible in the formation view, so an application under `debounced` or `commanded` evolution knows when a reconfigure is worth issuing.                                                |
| 12 | **One initiator policy governs every stage command.** Whoever `establishment.initiator` allows may `plan`, `connect`, `activate`, and `reconfigure`; `server-auto` denies principals for all of them. One rule, one predicate.                                                                                                                                                                                                  |
| 13 | **Observed-status changes emit their own event**, `group-activation-status-changed`, with the status, the coverage it was computed from, and the layout version in its payload. The event list becomes the status history; the snapshot holds only the current value.                                                                                                                                                           |

## The stage model

Formation intent gains two stages and keeps its invariants: every transition is an authorized
AppInbox command (or a policy-driven internal one), advances the formation epoch, re-pins the
electorate, and emits an event; membership, presence, and WS connectivity work in every stage;
there is no terminal failure stage.

```text
forming ──plan──▶ planned ──connect──▶ connecting ──activate / criterion──▶ active
   ▲                  │                     │                                  │
   │                  └── fail-formation ◀──┘                    reconfigure ──┘
   └──────────────────────────────────────────── (→ planned by default, or connecting)
```

| Stage           | Server                                                                 | Browser                                                                                 | Application data (`blocked-until-active`) | Admission (`closed`) |
| --------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------- | -------------------- |
| `forming`       | No plan; membership and presence only                                  | No dials, bootstrap suppressed; WS room traffic per data policy                         | blocked                                   | open                 |
| `planned`       | Layout planned and published; evolution per policy                     | Holds the layout (`layoutReceived`); **no dials**, bootstrap suppressed                 | blocked                                   | closed               |
| `connecting`    | Layout published; criterion evaluates; evolution per policy            | Dials per layout under the pacing budget; reports RTT on reporting edges                | blocked                                   | closed               |
| `active`        | Layout published; evolution per policy; status observed                | Dials per layout; heals; reports RTT                                                    | allowed                                   | closed               |
| `reconfiguring` | New layout published (or queued); criterion evaluates on re-activation | Holds the new layout by default (decision 5); dials it when the landing is `connecting` | blocked                                   | closed               |

Stage commands and their sources (decision 12: one initiator policy for all of them):

| Command          | From                          | To                                                           | Who                                                 |
| ---------------- | ----------------------------- | ------------------------------------------------------------ | --------------------------------------------------- |
| `plan`           | `forming`                     | `planned`                                                    | initiator per policy, or the plan trigger           |
| `connect`        | `planned`                     | `connecting`                                                 | initiator per policy, or the connect trigger        |
| `activate`       | `connecting`, `reconfiguring` | `active`                                                     | initiator per policy (manual mode) or the criterion |
| `reconfigure`    | `active`                      | `reconfiguring`, landing `planned` (default) or `connecting` | initiator per policy, or the evolution policy       |
| `fail-formation` | `connecting`, `reconfiguring` | `forming`                                                    | the criterion only                                  |

## Topology evolution

Once a layout exists, membership changes no longer imply a new layout:

| `topology.evolution` | Behaviour after a membership change                                                                                                                                           | Presets (decision 6)            |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `auto`               | Re-plan, re-publish, browsers reconcile — today's behaviour, unchanged                                                                                                        | `optimistic`, the absent policy |
| `debounced`          | Changes coalesce under server-clamped windows (a per-group debounce and a minimum layout age, the activation design's `activationDebounceMs` / `minimumBatchAgeMs` as policy) | `managed`, `drop-in-social`     |
| `commanded`          | Changes queue; the layout moves only on `reconfigure`                                                                                                                         | `match`                         |

In every mode a queued or coalesced change is visible (decision 11): the group records the roster
version its layout was planned from, and the snapshot and formation view derive `layoutStale` from
it, so an application can decide to reconfigure. Leaving, disconnecting, and expiry still heal live
connections immediately through the existing browser mechanisms; evolution governs the _layout_,
not liveness.

## The browser contract

- **The dial gate reads intent.** The reconciler dials only in `connecting`, `active`, and a
  `reconfiguring` that landed in `connecting`. In `forming` and `planned` it neither dials the
  layout nor falls back to bootstrap peers. The stage comes from the group snapshot the browser
  already holds, receives on change, and hydrates on connect — no new transport.
- **Two explicit states for applications.** `layoutReceived` (the overlay for this group and its
  version are held) and `connectRequested` (the stage permits dialing). `rallar.realtime.room`
  readiness means "connected per the current layout".
- **Pacing is enforced.** `establishment.maxConcurrentEdgeSetups` bounds new dials per reconcile
  pass per session; `maxPeerConnections` remains the retained-connection cap.
- **Late join and reconnect.** Hydration delivers the current layout and stage; the dial gate then
  decides. A member joining a `planned` group holds the layout like everyone else (decision 10).
- **Healing stays browser-owned** in the dialing stages exactly as today.

## The observed connectivity status

The status answers "how connected is the group actually", as a named state rather than a fraction,
for the group's whole life. Coverage is the readiness fraction of the current layout; the rates are
the policy's `successRate` and `minimumViableRate`; the dwell is a server default (decision 7).

| Status          | Meaning                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| `inactive`      | No layout to be connected to (`forming`, or `planned` before anyone may dial)                          |
| `initialising`  | Dialing has begun and coverage is below `successRate`, never yet active                                |
| `active`        | Coverage of the current layout is at or above `successRate`                                            |
| `reconfiguring` | The layout version moved and coverage of the new version is still pending, with an older usable layout |
| `degraded`      | Was active; coverage `< successRate` and `>= minimumViableRate` for at least the dwell                 |
| `failed`        | Coverage `< minimumViableRate` for at least the dwell, or formation attempts exhausted                 |

Properties the product commits to:

- It is **derived from evidence and never authoritative**: no admission, transition, or data gate
  reads it.
- It is **persisted and pushed** (decision 3): a status _change_ is written by internal authority
  after hysteresis and the dwell, and therefore appears in the group snapshot, the WS delta,
  on-connect hydration, the `group-activation-status-changed` event (decision 13), and the
  formation view. Evidence arrivals do not write.
- It is **truthful about its lag**: evidence ages out after a bounded window, so a status carries
  the time it was last confirmed, the coverage it was computed from, and the layout version it
  refers to.

## Automation

Automatic groups advance through the same stages without an application command. One trigger
vocabulary (decision 8) serves both automatic boundaries:

| Trigger     | Fires                                                                                  |
| ----------- | -------------------------------------------------------------------------------------- |
| `immediate` | as soon as the previous stage is entered (the default; today's behaviour)              |
| `after`     | a settle time after the previous stage is entered                                      |
| `presence`  | when at least N members hold live presence, or at a timer fallback, whichever is first |

| Boundary                 | Automatic driver                                                                  |
| ------------------------ | --------------------------------------------------------------------------------- |
| `forming → planned`      | the plan trigger; `formation: 'immediate'` is the `immediate` trigger at creation |
| `planned → connecting`   | the connect trigger                                                               |
| `connecting → active`    | the activation criterion (unchanged)                                              |
| `active → reconfiguring` | the evolution policy                                                              |

Commanded groups use the same transitions from the application. A preset chooses the driver per
boundary, so "absent policy behaves exactly as today" remains true: the optimistic preset is
`immediate` formation, `immediate` plan and connect triggers, `auto` evolution, manual activation.
Costing, for the implementation plan: the `immediate` and `after` triggers reuse the epoch-keyed
timer entries the transitions already write; the `presence` trigger needs the presence-summary
worker to petition the transition the way the criterion does, on the hot presence path.

## Application-facing surface (product level)

HTTP commands, each an idempotent AppInbox mutation with a receipt: `plan`, `connect`, `activate`,
`reconfigure`. Reads: the group snapshot (stage, epoch, status, layout version, `layoutStale`), the
formation view (readiness, managers, status basis), and the overlay. Pushed: group deltas on every
stage or status change, `group-activation-status-changed` events, overlay publications, and
on-connect hydration of all three.

Browser facade (sketch, names to be settled in the implementation plan):

```ts
const room = await rallar.rooms.createAndSwitch({
    lifecyclePolicy: { preset: 'match' } // commanded evolution, held reconfigure landing
});
room.formation.on('change', (view) => ui.render(view.lifecycleState, view.activationStatus));
room.formation.on('layoutReceived', (overlay) => ui.showGraph(overlay));

await room.formation.plan(); // layout distributed, nobody dials
await room.formation.connect(); // dial per layout; criterion activates when covered
// mid-match joins queue under `commanded` evolution; view.layoutStale turns true
await room.formation.reconfigure({ landing: 'connecting' }); // between rounds: re-dial now
```

## Large groups

Holding stages is the scale story: a thousand-session group may sit in `forming` for an hour, hold
a `planned` layout until the application says go, and under `commanded` evolution never re-plan
because someone joined. Dial pacing bounds the establishment burst per session; the criterion's
deadline and the existing RTT damping are unchanged. The product does not promise groups beyond
what the scale tiers measure; the plan's tiers grow with the stages.

## Testability

Every stage, transition, status change, and layout version is observable by HTTP (`GET` group,
`GET …/formation`, `GET …/topology`, the events) and by WS (group delta on change, hydration on
connect, overlay publication). Named acceptance scenarios, each an api-v1 black-box recipe:

| Scenario                | Pins                                                                                                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `held-layout`           | `plan` publishes a layout; no RTC signaling observed; `connect` starts dialing; status `inactive → initialising`                                                           |
| `discovery-holds-dials` | a presence-connected `forming` lobby makes zero bootstrap dials                                                                                                            |
| `commanded-evolution`   | joins during `active` change the roster, set `layoutStale`, and leave the layout version until `reconfigure`                                                               |
| `debounced-evolution`   | a join burst yields one re-plan after the window                                                                                                                           |
| `reconfigure-landing`   | `reconfigure` lands in `planned` and nobody dials the new layout until `connect`; `landing: 'connecting'` dials                                                            |
| `status-lifecycle`      | status walks `inactive → initialising → active`, drops to `degraded` after the dwell when edges stop, recovers; each change is one `group-activation-status-changed` event |
| `status-on-connect`     | a reconnecting member receives the current stage, status, and layout before any other message                                                                              |
| `automatic-progression` | an automatic preset reaches `active` with zero commands, under each trigger                                                                                                |
| `absent-policy-parity`  | a group with no policy behaves exactly as today                                                                                                                            |

## Compatibility

- An absent policy, the `optimistic` preset, and every existing group behave exactly as today:
  `immediate` formation with `immediate` plan and connect triggers and `auto` evolution collapses
  the new stages to zero length.
- The lifecycle enum gains `planned` and `connecting` and loses `establishing`; consumers that
  switch on the enum are updated in the same change. `reconfiguring` keeps its meaning.
- The observed status, `layoutRosterVersion`, and `layoutStale` are new required fields, added
  alongside; their absence on old snapshots is not a compatibility mechanism.
- Existing groups keep their stored policy; decision 6's preset changes apply to groups created
  after the change.

## Not in this plan

- Per-edge confirm-or-fail establishment (`strictConfirmation`), `group_batch`,
  `ASYNC_REMOTE_QUEUE`, commanded-edge retention, and command-origin validation. The held
  `planned` stage gives "planned is not yet active topology" without withholding the plan from the
  accepted store, which is what made those necessary.
- Slicing, gates, and file-level implementation — the companion implementation plan.

## Defaults to settle in the implementation plan

Numeric defaults and clamps, not product questions: the status dwell; the `debounced` window and
minimum layout age; the `after` settle time and the `presence` fallback timer; the per-preset
`maxConcurrentEdgeSetups` now that it is enforced; and the hysteresis width between `active` and
`degraded`.
