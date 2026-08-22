# Group Activation Product Plan (2026-08-22)

Status: **product plan — decisions 1–13 taken with the product owner on 2026-08-22, revised the
same day after review (decisions 1, 5, 6, 11 amended; 14–21 added).** This document records what
the Rallar product should support for application-controlled group activation. It deliberately
stops short of slicing and implementation; those follow in a companion implementation plan once
this surface is signed off. The current behaviour it departs from is the landed
`docs/rallar-group-formation-architecture.md`; the control-plane workstream it extends is
`2026-08-17-group-lifecycle-control-plane-implementation-plan.md` (complete); the story it is
steering toward is `plans/rallar-distributed-group-rtc-activation-design.md`, taken as direction,
not as a dictate.

## The product promise

An application controls a group's activation to the level of control that makes sense for it: when
the group discovers members, when members receive a connection layout, when they start connecting,
how many connections each member sets up at once, when the group counts as live, and when the
layout may change. Rallar keeps the group safe in every stage, tells the application what is
actually connected, and makes no RTC connection attempt the application's policy did not sanction.
A simple application sets a preset and never issues a command; a demanding one drives every stage
by hand. Both use one model.

## Requirements

| #  | Requirement                                                                                                                                 | What "supported" means                                                                                                                                              |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1 | A web SPA can control the stages of group activation completely, down to the level of control that makes sense for the 99th-percentile app  | Every stage boundary is a named, remotely commandable transition with a receipt; presets bundle them so most apps never command anything                            |
| R2 | Stage transitions are initiated remotely                                                                                                    | Commands are HTTP/WS AppInbox mutations from an authorized principal or from policy-driven automation; the server never needs a co-located controller               |
| R3 | Overlay construction does not mean clients immediately start RTC connections                                                                | A stage exists in which the layout is planned and distributed while no client dials; bootstrap dialing is suppressed there and in discovery                         |
| R4 | The SPA separates "received the layout" from "connect using the layout"                                                                     | The browser holds a received layout as _pending_ and dials only the _applied_ layout; applying is a stage transition                                                |
| R5 | A group can remain in one stage for as long as the application desires, so large groups avoid redundant short-lived reconfigurations        | No stage advances on its own unless policy says so; topology evolution after a layout exists is policy: automatic, debounced, or commanded                          |
| R6 | Group state is easy to fetch over HTTP and is pushed over WS on change and on connect — for applications and for tests                      | Intent, layout versions, and observed connectivity status ride the existing snapshot/delta/hydration channels and the formation view; tests pin each behaviour      |
| R7 | Connection parallelism — how many RTC setups a member runs at once — is configurable as group policy, so recipes can search for good values | `establishment.maxConcurrentEdgeSetups` bounds in-flight setups per member for that group; it is normalized, clamped, exposed in reads, and enforced by the browser |

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
- **The browser holds one layout per group.** A newly published overlay replaces the desired peer
  set immediately; yesterday's edges survive only as retained peers for a 15 s grace window
  (`DEFAULT_WEBRTC_OVERLAY_TRANSITION_GRACE_MS`) under capacity eviction. Nothing keeps an older
  layout applied while a newer one is held.
- **Topology evolution is not controllable.** Outside `forming`, every membership change re-plans,
  re-publishes, and re-dials.
- **Parallelism is declared but not enforced.** `establishment.maxConcurrentEdgeSetups` is
  persisted and unread; the browser's only bound is the retained-connection cap.
- **A lifecycle receipt says nothing about the layout.** The transition commits and returns;
  planning and publication are asynchronous outbox work.
- **Observed connectivity has no living status.** The formation view derives a readiness fraction
  on read; nothing names the connectivity state, nothing remembers it, nothing pushes it.
- **Internal commands are fenced by id only.** The criterion's petitions encode the formation
  epoch in their request id, which deduplicates but does not validate: a petition that finds the
  group back in a legal source state at a later epoch is applied.

## Decisions taken

| #  | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1  | **Held and dialing phases are distinct lifecycle stages, and dialing is a pure function of the stage.** `forming → planned → connecting → active`, with reconfiguration split the same way into `reconfiguring` (new layout held) and `reconnecting` (new layout dialed). `establishing` is renamed `connecting`. _Amended after review: the reconfiguration substate is explicit._                                                                               |
| 2  | **Topology evolution after a layout exists is a policy field**, `topology.evolution: 'auto' \| 'debounced' \| 'commanded'`, default `auto`. `auto` is today's replan-on-every-change; `debounced` coalesces changes under server-clamped windows; `commanded` queues changes until the application reconfigures.                                                                                                                                                  |
| 3  | **The observed connectivity status is a living, pushed field**: persisted on the group beside the intent fields as derived, non-authoritative state, written only by internal authority after hysteresis and a minimum dwell, so it rides snapshots, deltas, on-connect hydration, and events with no new transport. No policy or gate may ever read it.                                                                                                          |
| 4  | **Policy-driven automation stays beside app-commanded control.** Automatic groups advance through the same stages on policy triggers; commanded groups advance on application commands. One model, two drivers, identical receipts and events.                                                                                                                                                                                                                    |
| 5  | **`reconfigure` lands in `reconfiguring` (held) by default**; `landing: 'reconnecting'` dials the new layout immediately. Evolution-driven reconfigures land per the preset's `topology.reconfigureLanding`. _Amended after review: the landing is a stage, not a hidden argument._                                                                                                                                                                               |
| 6  | **Preset evolution and landing**: `optimistic` = `auto` / `apply`, `managed` = `debounced` / `apply`, `match` = `commanded` / `hold`, `drop-in-social` = `debounced` / `apply`. _Amended after review: the landing column is new; the evolution column is unchanged._                                                                                                                                                                                             |
| 7  | **`degraded` and `failed` are coverage bands from the policy's two rates, held for a dwell**: `degraded` = coverage `< successRate` and `>= minimumViableRate` for at least the dwell; `failed` = coverage `< minimumViableRate` for at least the dwell, or formation attempts exhausted. The dwell starts as a server default and becomes a policy knob only when an application needs it.                                                                       |
| 8  | **One trigger vocabulary drives the automatic boundaries of `phased` groups**, `forming → planned` and `planned → connecting`: immediately, after a settle time, or when a member-presence threshold is met with a timer fallback.                                                                                                                                                                                                                                |
| 9  | **The observed status uses lower-case names**, `inactive \| initialising \| active \| reconfiguring \| degraded \| failed`, matching every enum on the wire, disambiguated from the stage enum by field name.                                                                                                                                                                                                                                                     |
| 10 | **A held layout is readable exactly like an applied one**: topology reads and the overlay push keep today's authorization. The members who must hold the layout are the ones who must read it.                                                                                                                                                                                                                                                                    |
| 11 | **Layout staleness is the topology-input fingerprint comparison, on the formation view.** The layout's `sourceGroupStateCausalRevision` is exposed for traceability; `layoutStale` is true when the stored fingerprint of the applied layout differs from the fingerprint of the current planning authority (active session ids and effective config). _Amended after review: `rosterVersion` never moves on session replacement, so it was the wrong authority._ |
| 12 | **One initiator policy governs every stage command.** Whoever `establishment.initiator` allows may `plan`, `connect`, `activate`, and `reconfigure`; `server-auto` denies principals for all of them.                                                                                                                                                                                                                                                             |
| 13 | **Observed-status changes emit their own event**, `group-activation-status-changed`, with the status, the coverage it was computed from, and the applied layout version in its payload.                                                                                                                                                                                                                                                                           |
| 14 | **No migration and no compatibility adapters.** Nothing deployed needs migrating; the repository may change as it pleases. The finalisation rule is consistency: when the workstream closes, code, tests, recipes, OpenAPI, examples, and docs agree, with no reader defaults for "old" rows, no renamed-enum shims, and no optional-for-compatibility fields.                                                                                                    |
| 15 | **Applied and pending layouts are owned explicitly.** The group records `appliedLayoutVersion`, written only by the transitions that apply a layout (`connect`, `reconnect`, and evolution landings of `apply`). A published layout with a higher version is _pending_. The browser holds the applied layout's content and at most one pending layout's content; it dials and heals the applied one and never the pending one.                                    |
| 16 | **A stage receipt means the transition was accepted, nothing more.** Planning and publication stay asynchronous; the layout arrives as `layoutReceived` and is visible on the topology read. `connect` from `planned` and `reconnect` from `reconfiguring` are legal only once a pending layout exists (a typed denial otherwise), so nobody enters a dialing stage with nothing to dial. The facade offers an explicit wait for a layout.                        |
| 17 | **`formation: 'immediate'` keeps creating the group `active`** with no applied-layout hold, exactly as today; the trigger vocabulary applies to `phased` groups only. This is what keeps the absent policy and the `optimistic` preset behaving as they do now — a product property, not a migration concern.                                                                                                                                                     |
| 18 | **Parallelism is an in-flight bound, configured per group.** `establishment.maxConcurrentEdgeSetups` is the maximum number of RTC setups a member may have in flight at once for that group; a setup ends on success, failure, or timeout, and each ending wakes the next reconcile so deferred peers are never stranded. A member in several groups applies each group's bound to that group's edges under the session-wide `maxPeerConnections` cap.            |
| 19 | **The status function is total and precedence-ordered, its clocks are durable, and internal commands are causally fenced.** Status rules evaluate in a fixed order; dwell and evidence expiry are durable timer entries keyed by epoch and layout version; every internal command carries `expectedFormationEpoch` and `expectedLayoutVersion` and `compute` validates them — including the existing criterion petitions.                                         |
| 20 | **Validation names its test kinds, not only recipes**: pure matrices for the stage, status, and pacing functions; shared browser tests for the dial gate, applied/pending cache, and in-flight pacing; api-v1 recipes for HTTP/WS/persistence/multi-server; full-stack live-RTC for end-to-end dial suppression; headless/distributed tiers for parallelism sweeps; the medium-scale and state-write gates for every mutation-path change.                        |
| 21 | **The implementation plan starts with contract closure, then the held-layout foundation**, and selects evolution modes and the living status only after the applied/pending ownership has proven itself in tests.                                                                                                                                                                                                                                                 |

## The stage model

Formation intent has six stages and keeps its invariants: every transition is an authorized
AppInbox command (or a policy-driven internal one), advances the formation epoch, re-pins the
electorate, and emits an event; membership, presence, and WS connectivity work in every stage;
there is no terminal failure stage.

```text
forming ──plan──▶ planned ──connect──▶ connecting ──activate / criterion──▶ active
   ▲                  │                     │                                  │
   │                  └── fail-formation ◀──┘                      reconfigure ┤
   │                                                                           ▼
   │              reconfiguring (held) ──connect──▶ reconnecting ──activate / criterion──▶ active
   │                                                    │
   └─────────────────────────────── fail-formation ◀────┘
```

| Stage           | Applied layout          | Pending layout                    | Browser dials                                 | Data (`blocked-until-active`) | Admission (`closed`) |
| --------------- | ----------------------- | --------------------------------- | --------------------------------------------- | ----------------------------- | -------------------- |
| `forming`       | none                    | none (no plan exists)             | nothing; bootstrap suppressed                 | blocked                       | open                 |
| `planned`       | none                    | the first layout, once published  | nothing; bootstrap suppressed                 | blocked                       | closed               |
| `connecting`    | the first layout        | none                              | the applied layout, under the in-flight bound | blocked                       | closed               |
| `active`        | current                 | none, or a newer one under `hold` | the applied layout; heals                     | allowed                       | closed               |
| `reconfiguring` | previous (still dialed) | the new layout, held              | the applied layout only                       | see open question             | closed               |
| `reconnecting`  | the new layout          | none                              | the applied layout, under the in-flight bound | see open question             | closed               |

Dialing is a pure function of the stage and the applied layout: a pending layout is never dialed,
and in `forming` and `planned` there is nothing to dial and no bootstrap fallback. `immediate`
groups (decision 17) are created `active` with `auto` evolution and keep today's behaviour,
including the bootstrap fallback before the first publication.

Stage commands and their sources (decision 12: one initiator policy for all of them):

| Command          | From                         | To                                          | Who                                                 | Precondition                          |
| ---------------- | ---------------------------- | ------------------------------------------- | --------------------------------------------------- | ------------------------------------- |
| `plan`           | `forming`                    | `planned`                                   | initiator per policy, or the plan trigger           | —                                     |
| `connect`        | `planned`, `reconfiguring`   | `connecting`, `reconnecting`                | initiator per policy, or the connect trigger        | a pending layout exists (decision 16) |
| `activate`       | `connecting`, `reconnecting` | `active`                                    | initiator per policy (manual mode) or the criterion | —                                     |
| `reconfigure`    | `active`                     | `reconfiguring` (default) or `reconnecting` | initiator per policy, or the evolution policy       | —                                     |
| `fail-formation` | `connecting`, `reconnecting` | `forming`                                   | the criterion only                                  | —                                     |

`connect` and `reconnect` are the transitions that apply a layout: they set
`appliedLayoutVersion` to the pending version in the same write. An evolution-driven reconfigure
with landing `apply` publishes and applies in one step, which is exactly today's `auto` behaviour.

## Topology evolution

Once a layout exists, membership changes no longer imply a new layout:

| `topology.evolution` | Behaviour after a membership or session change                                                                                                                                | Presets (decision 6)        |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `auto`               | Re-plan and re-publish; the landing policy decides whether the new layout is applied at once or held — today's behaviour is `auto` + `apply`                                  | `optimistic`                |
| `debounced`          | Changes coalesce under server-clamped windows (a per-group debounce and a minimum layout age, the activation design's `activationDebounceMs` / `minimumBatchAgeMs` as policy) | `managed`, `drop-in-social` |
| `commanded`          | Changes queue; the layout moves only on `reconfigure`                                                                                                                         | `match`                     |

`topology.reconfigureLanding: 'apply' | 'hold'` decides where an evolution-driven reconfigure lands
(`reconnecting` or `reconfiguring`); the `reconfigure` command's `landing` overrides it per call.

Staleness (decision 11): the formation view reports `layoutStale` when the stored topology-input
fingerprint of the applied layout differs from the fingerprint of the current planning authority,
and exposes the applied layout's `sourceGroupStateCausalRevision`. A reconnect that replaces a
session is therefore stale, and a heartbeat is not. Leaving, disconnecting, and expiry still heal
live connections immediately through the existing browser mechanisms; evolution governs the
_layout_, not liveness.

## The browser contract

- **Two layouts per group.** The overlay cache holds the applied layout's content and at most one
  pending layout's content. A publication whose version exceeds `appliedLayoutVersion` lands as
  pending and raises `layoutReceived`; it becomes applied when the group snapshot's
  `appliedLayoutVersion` reaches it (the `connect`/`reconnect` delta), which raises
  `layoutApplied`. Retained-peer grace stays the bridge _between_ applied layouts; it is no longer
  the only thing keeping a match alive through a reconfiguration.
- **The dial gate reads the stage and the applied layout.** Desired peers come from the applied
  layout only. In `forming` and `planned` there is no applied layout and no bootstrap fallback for
  `phased` groups. The stage and the applied version come from the group snapshot the browser
  already holds, receives on change, and hydrates on connect — no new transport.
- **Parallelism is an in-flight bound (decision 18, R7).** The reconciler tracks setups from
  attempt start to success, failure, or timeout, keeps at most `maxConcurrentEdgeSetups` in flight
  per group, and re-runs when one ends. `maxPeerConnections` remains the session-wide
  retained-connection cap.
- **Readiness means the applied layout.** `rallar.realtime.room` is ready when the applied
  layout's lanes to the local session's next hops are open; a pending layout does not change it.
- **Late join and reconnect.** Hydration delivers the stage, `appliedLayoutVersion`, and the
  current publications; the browser classifies each as applied or pending and the gate decides.
  Readiness after hydration is a causally fenced barrier — the browser reports ready only after the
  group snapshot and the applied layout it names have both arrived — not "before any other
  message", which WS delivery across topics cannot promise.

## The observed connectivity status

The status answers "how connected is the group actually", as a named state rather than a fraction,
for the group's whole life. Coverage is the readiness fraction of the **applied** layout; the rates
are the policy's `successRate` and `minimumViableRate`; the dwell is a server default (decision 7).
The function is total and evaluates in this order (decision 19):

| Order | Status          | When                                                                                                                                  |
| ----- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `failed`        | formation attempts are exhausted and the group is `forming`; or, with an applied layout, coverage `< minimumViableRate` for the dwell |
| 2     | `inactive`      | no applied layout (`forming` with attempts remaining, `planned`)                                                                      |
| 3     | `reconfiguring` | a pending layout exists (`reconfiguring`, `reconnecting`, or `active` under `hold`) and the applied layout is still usable            |
| 4     | `degraded`      | the group has been `active` on this applied layout and coverage is `< successRate` and `>= minimumViableRate` for the dwell           |
| 5     | `active`        | coverage `>= successRate`                                                                                                             |
| 6     | `initialising`  | otherwise: dialing has begun on an applied layout that has not yet reached the threshold                                              |

Properties the product commits to:

- It is **derived from evidence and never authoritative**: no admission, transition, or data gate
  reads it.
- It is **persisted and pushed** (decision 3): a status _change_ is written by internal authority
  after hysteresis and the dwell, and therefore appears in the group snapshot, the WS delta,
  on-connect hydration, the `group-activation-status-changed` event (decision 13), and the
  formation view. Evidence arrivals do not write.
- Its **clocks are durable** (decision 19): dwell completion and evidence expiry produce no
  evidence event, so they are timer entries in the same durable queue the formation deadline uses,
  keyed by formation epoch and applied layout version; a stale entry is a drop.
- It is **truthful about its lag**: a status carries the time it was last confirmed, the coverage
  it was computed from, and the applied layout version it refers to.

## Automation

Automatic `phased` groups advance through the same stages without an application command. One
trigger vocabulary (decision 8) serves both automatic boundaries:

| Trigger     | Fires                                                                                  |
| ----------- | -------------------------------------------------------------------------------------- |
| `immediate` | as soon as the previous stage is entered (the default)                                 |
| `after`     | a settle time after the previous stage is entered                                      |
| `presence`  | when at least N members hold live presence, or at a timer fallback, whichever is first |

| Boundary                                  | Automatic driver                                                      |
| ----------------------------------------- | --------------------------------------------------------------------- |
| `forming → planned`                       | the plan trigger                                                      |
| `planned → connecting`                    | the connect trigger, gated on a pending layout existing (decision 16) |
| `connecting → active`                     | the activation criterion (unchanged)                                  |
| `active → reconfiguring` / `reconnecting` | the evolution policy with the landing policy                          |

`immediate` formation is not a trigger configuration: it creates the group `active` (decision 17).
Costing, for the implementation plan: the `immediate` and `after` triggers reuse the epoch-keyed
timer entries the transitions already write; the `presence` trigger needs the presence-summary
worker to petition the transition the way the criterion does, on the hot presence path.

Every internal command — triggers, the criterion's petitions, status writes — carries
`expectedFormationEpoch` and `expectedLayoutVersion`, and `compute` rejects a mismatch as a typed
stale outcome (decision 19). Encoding the epoch in the request id deduplicates; it does not fence.

## Application-facing surface (product level)

HTTP commands, each an idempotent AppInbox mutation returning a receipt for the _transition_
(decision 16): `plan`, `connect`, `activate`, `reconfigure`. Reads: the group snapshot (stage,
epoch, `appliedLayoutVersion`, status), the formation view (readiness, managers, status basis,
`layoutStale`, the applied layout's source revision), and the overlay (applied and pending
publications). Pushed: group deltas on every stage, applied-version, or status change;
`group-activation-status-changed` events; overlay publications; and on-connect hydration of all
three.

Browser facade (sketch, names to be settled in the implementation plan):

```ts
const room = await rallar.rooms.createAndSwitch({
    lifecyclePolicy: {
        preset: 'match', // commanded evolution, hold landing
        establishment: { maxConcurrentEdgeSetups: 2 } // two RTC setups in flight per member
    }
});
room.formation.on('change', (view) => ui.render(view.lifecycleState, view.activationStatus));
room.formation.on('layoutReceived', (overlay) => ui.showPending(overlay));
room.formation.on('layoutApplied', (overlay) => ui.showApplied(overlay));

await room.formation.plan(); // transition accepted; planning is asynchronous
await room.formation.layout(); // resolves when the first layout is pending
await room.formation.connect(); // applies it; dialing starts under the bound
// mid-match joins queue under `commanded` evolution; view.layoutStale turns true
await room.formation.reconfigure(); // new layout published and held (reconfiguring)
await room.formation.layout(); // the new pending layout
await room.formation.connect(); // between rounds: apply and re-dial
```

## Large groups

Holding stages is the scale story: a thousand-session group may sit in `forming` for an hour, hold
a `planned` layout until the application says go, and under `commanded` evolution never re-plan
because someone joined. The per-group in-flight bound paces the establishment burst per member, and
because it is policy, a recipe can sweep it — a member with five next hops and a bound of one sets
up its edges one at a time; with a bound of five, all at once — and record time-to-threshold,
attempt counts, and failures per value. The criterion's deadline and the existing RTT damping are
unchanged. The product does not promise groups beyond what the scale tiers measure; the tiers grow
with the stages.

## Validation

Each behaviour is pinned by the kind of test that can actually observe it (decision 20):

| Kind                                        | Pins                                                                                                                                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure matrices (`packages/tests/shared`)     | the stage transition table, the total status function and its precedence, the in-flight dial plan, trigger evaluation, staleness from fingerprints                                                            |
| Shared browser tests (`WebRtcGroupManager`) | the dial gate per stage, bootstrap suppression for `phased` groups, applied/pending cache behaviour, in-flight pacing across repeated reconciles, wake-on-completion                                          |
| api-v1 black-box recipes                    | stage commands and receipts, preconditions and typed denials, `appliedLayoutVersion` and status in snapshots/deltas, on-connect hydration, events, multi-server convergence, durable timers surviving restart |
| Full-stack live-RTC (Playwright)            | end-to-end dial suppression in `planned`, a held reconfiguration keeping a match alive on the applied layout, readiness as a fenced barrier                                                                   |
| Headless / distributed tiers                | parallelism sweeps over `maxConcurrentEdgeSetups` at 6/20/50 with real RTC, reporting time-to-threshold and attempt counts per value                                                                          |
| Gates (repository rule)                     | medium-scale and state-write gates for every mutation-path change; shared-web public API snapshots and bundle-boundary checks; repo governance                                                                |

Named acceptance scenarios:

| Scenario                | Pins                                                                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `held-layout`           | `plan` publishes a pending layout; no RTC signaling observed; `connect` applies it and dialing starts; status `inactive → initialising` |
| `discovery-holds-dials` | a presence-connected `forming` lobby of a `phased` group makes zero bootstrap dials                                                     |
| `connect-needs-layout`  | `connect` before any publication is a typed denial; after `layoutReceived` it succeeds                                                  |
| `held-reconfiguration`  | `reconfigure` publishes a pending layout while the match keeps running on the applied one; `connect` applies it                         |
| `commanded-evolution`   | joins during `active` set `layoutStale` and leave `appliedLayoutVersion` until `reconfigure`; a session reconnect is stale too          |
| `debounced-evolution`   | a join burst yields one re-plan after the window                                                                                        |
| `pacing-sweep`          | the same group at `maxConcurrentEdgeSetups` 1, 2, 5: in-flight never exceeds the bound, deferred peers all connect, timings recorded    |
| `status-lifecycle`      | status walks `inactive → initialising → active`, drops to `degraded` after the dwell when edges stop, recovers; one event per change    |
| `status-on-connect`     | a reconnecting member is ready only after the snapshot and its applied layout have both arrived                                         |
| `stale-petition-fenced` | an internal command carrying an old epoch or layout version is a typed stale outcome, never applied                                     |
| `automatic-progression` | an automatic `phased` preset reaches `active` with zero commands, under each trigger                                                    |
| `absent-policy-parity`  | a group with no policy behaves exactly as today                                                                                         |

## Consistency at finalisation

There is nothing to migrate and no compatibility to keep (decision 14). The workstream is finished
when the repository agrees with itself: the lifecycle enum is `forming | planned | connecting |
active | reconfiguring | reconnecting` everywhere (`establishing` does not survive in code, tests,
recipes, OpenAPI, or docs); `appliedLayoutVersion`, the observed status, and the new policy fields
are required wherever the contracts are authoritative; every recipe, example, and fixture is
updated in the same workstream; `docs/rallar-group-formation-architecture.md` is rewritten to
describe the result; and the absent policy and the `optimistic` preset still behave exactly as they
do today (decision 17) — a product property the parity recipe pins, not a migration constraint.

## Not in this plan

- Per-edge confirm-or-fail establishment (`strictConfirmation`), `group_batch`,
  `ASYNC_REMOTE_QUEUE`, commanded-edge retention, and command-origin validation. Applied and
  pending layouts in the browser give "planned is not yet active topology" without withholding the
  plan from the accepted store, which is what made those necessary.
- Slicing, gates, and file-level implementation — the companion implementation plan, which starts
  with the two slices below (decision 21).

## Implementation plan starting point

1. **Contract closure.** The stage table with six stages, applied/pending ownership, receipt
   semantics and the `connect` precondition, the total status function, fingerprint staleness,
   the in-flight dial plan, expected-epoch/version fences on internal commands — all as pure
   functions with their matrices, landing dark.
2. **Held-layout foundation.** The stage and dial gate, applied/pending layouts on the server and in
   the browser, `connect` applying a layout, bootstrap suppression, in-flight pacing — with shared
   browser tests, the live-RTC suite, and one focused recipe.

Evolution modes, triggers, and the living status follow once the foundation's ownership boundaries
have proven themselves.

## Open product questions

- **Application data during held and re-dialing reconfiguration.** Today `blocked-until-active`
  blocks in `reconfiguring` because the gate tests `lifecycleState !== 'active'`. With a held
  reconfiguration the match keeps running on the applied layout, so blocking data there would
  interrupt it. Proposed: the data gate blocks only while there is no applied layout that has been
  active (`forming`, `planned`, `connecting`); `reconfiguring` and `reconnecting` keep data flowing.
  This changes recorded behaviour and is not taken here.
- **Preset landings** in decision 6 (`apply` for `managed` and `drop-in-social`) are proposed
  values; a managed lobby that should hold new layouts until its manager says so would flip to
  `hold`.

## Defaults to settle in the implementation plan

Numeric defaults and clamps, not product questions: the status dwell; the `debounced` window and
minimum layout age; the `after` settle time and the `presence` fallback timer; the per-preset
`maxConcurrentEdgeSetups` now that it is an in-flight bound; the RTC setup timeout that ends an
in-flight attempt; and the hysteresis width between `active` and `degraded`.
