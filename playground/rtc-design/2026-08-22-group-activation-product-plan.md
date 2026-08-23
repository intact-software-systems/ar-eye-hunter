# Group Activation Product Plan (2026-08-22)

Status: **product plan — decisions 1–23 taken with the product owner on 2026-08-22; revised the same
day after a first review (decisions 1, 5, 6, 11 amended; 14–23 added); revised again on 2026-08-23
after a code-verified second review (decisions 1, 2, 3, 5, 6, 9, 11, 12, 13, 15, 16, 18, 19, 20, 21
amended; 22 and 23 superseded; 24–34 added). All 34 decisions are taken and no product question is
open.** This document records what the Rallar product should support for application-controlled group
activation. It deliberately stops short of slicing and implementation; those live in the companion
implementation plan. The current behaviour it departs from is the landed
`docs/rallar-group-formation-architecture.md`; the control-plane workstream it extends is
`2026-08-17-group-lifecycle-control-plane-implementation-plan.md` (complete); the story it is
steering toward is `plans/rallar-distributed-group-rtc-activation-design.md`, taken as direction, not
as a dictate.

## The product promise

An application controls a group's activation to the level of control that makes sense for it: when
the group discovers members, when members receive a connection layout, when they start connecting,
how many connections each member sets up at once, when the group counts as live, when application
data is halted and resumed, and when the layout may change. Rallar keeps the group safe in every
stage, tells the application what is actually connected **and whose move it is**, and makes no RTC
connection attempt the application's policy did not sanction. A simple application sets a preset and
never issues a command; a demanding one drives every stage by hand. Both use one model.

## The three planes

Group activation is not one axis. Separating them is what makes the model small, and it is the
change the 2026-08-23 review made:

| Plane          | Owns                                           | Moves on                                     |
| -------------- | ---------------------------------------------- | -------------------------------------------- |
| **Routing**    | which layout is authoritative for live traffic | `plan`, `connect`, `activate`, `reconfigure` |
| **Transport**  | whether application data may cross an edge     | `pause`, `resume`, and the forward gate      |
| **Membership** | who may be in the group, and when              | admission policy and its windows             |

The lifecycle stage names a position on the **routing** plane only. Halting is a transport fact, not
a stage (decision 25). Admission is a membership fact, not a stage (decision 6 of the implementation
census, folded in here as the admission column).

## Requirements

| #  | Requirement                                                                                                                                 | What "supported" means                                                                                                                                                             |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1 | A web SPA can control the stages of group activation completely, down to the level of control that makes sense for the 99th-percentile app  | Every routing-plane boundary is a named, remotely commandable transition with a receipt; presets bundle them so most apps never command anything                                   |
| R2 | Stage transitions are initiated remotely                                                                                                    | Commands are HTTP/WS AppInbox mutations from an authorized principal or from policy-driven automation; the server never needs a co-located controller                              |
| R3 | Overlay construction does not mean clients immediately start RTC connections                                                                | A stage exists in which the layout is planned and distributed while no client dials; bootstrap dialing is suppressed there and in discovery                                        |
| R4 | The SPA separates "received the layout" from "connect using the layout"                                                                     | The browser holds a received layout as _planned_ and dials only the _accepted_ layout; accepting is a stage transition                                                             |
| R5 | A group can remain in one stage for as long as the application desires, so large groups avoid redundant short-lived reconfigurations        | No stage advances on its own unless policy says so; replanning after a layout exists is policy: automatic, debounced, or commanded                                                 |
| R6 | Group state is easy to fetch over HTTP and is pushed over WS on change and on connect — for applications and for tests                      | Intent, layout identity, transport state and observed connectivity ride the existing snapshot/delta/hydration channels and the formation view; tests pin each                      |
| R7 | Connection parallelism — how many RTC setups a member runs at once — is configurable as group policy, so recipes can search for good values | `establishment.maxConcurrentEdgeSetups` bounds in-flight setups per member for that group; it is normalized, clamped, exposed in reads, and enforced by the browser                |
| R8 | An active group can halt application data without tearing anything down, and resume it                                                      | `transportState` is a group field: the accepted layout and its connections stay, application data stops, `resume` restores flow; a reconfiguration begun while halted stays halted |
| R9 | An application can tell whether a connectivity problem is Rallar's to fix or its own                                                        | The observed status has a condition axis and a remediation axis; `awaiting-application` names the case where policy forbids Rallar from acting (decision 30)                       |

## What holds today, and the gaps

The landed control plane already gives R2 and the safety baseline: intent (`forming / establishing /
active / reconfiguring`) is persisted on the group, changed only by authorized commands, pushed in
every snapshot and delta, hydrated on connect, and policy decides who may command
(`establishment.initiator`) and whether activation is automatic (`activation.mode`). The gaps,
verified against the code on 2026-08-22 and re-verified on 2026-08-23:

- **There is no held-layout stage.** `establishing` plans, publishes, and browsers dial the moment
  the overlay arrives.
- **Discovery does not hold dialing.** `forming` holds server planning, but the browser falls back to
  the group's online members when no server overlay exists and dials a bounded subset of them. A
  presence-connected lobby already makes bounded RTC attempts.
- **The browser holds one layout per group.** A newly published overlay replaces the desired peer set
  immediately; yesterday's edges survive only as retained peers for a 15 s grace window under
  capacity eviction. Nothing keeps an older layout authoritative while a newer one is established.
- **Nothing distinguishes an accepted layout from a planned one**, even though
  `plans/rallar-distributed-group-rtc-activation-design.md` already commits to the distinction as a
  hard non-goal: _"Do not overwrite the last accepted active topology with an unconfirmed plan."_ The
  activation criterion already measures the just-`planned` overlay; there is simply no accepted
  layout beside it to keep serving.
- **Replanning is not controllable, and `auto` and `debounced` are the same thing today.** Every
  membership and session change flows through one server-wide coalesced work row with one window, for
  every group, with no policy at all. The window is server configuration, not per-group policy, and
  it is an _extending_ window with no maximum wait — sustained sub-window churn defers a replan
  indefinitely.
- **Parallelism is declared but not enforced.** `establishment.maxConcurrentEdgeSetups` is persisted
  and unread; the browser's only bound is the retained-connection cap.
- **A lifecycle receipt says nothing about the layout.** The transition commits and returns; planning
  and publication are asynchronous outbox work that can never write the group row in the same
  transaction.
- **Application data cannot be halted without re-establishing.** The only way out of `active` is
  `reopen-establishment`, which re-plans; data stops there only as a side effect of
  `blocked-until-active` testing `lifecycleState !== 'active'`.
- **Observed connectivity has no living status, and no remediation story at all.** The formation view
  derives a readiness fraction on read; nothing names the connectivity state, nothing remembers it,
  nothing pushes it. Worse, none of Rallar's seven automatic repair mechanisms is triggered by
  observed connectivity while a group is `active` — the activation criterion refuses to run outside
  establishment — so the repairs that matter during a match are browser-local and invisible to the
  server.
- **The browser already names transport and Rallar never connects it to the group.**
  `RallarRoomTransportState` (`off | idle | connecting | partial | open | degraded | failed`) is
  computed locally and has no relationship to the group's stage or policy.
- **Internal commands are fenced by id only.** The criterion's petitions encode the formation epoch in
  their request id, which deduplicates but does not validate.
- **A read field that already describes the missing concept is inert.**
  `GroupTopologyManagementView.pending` (`{reconfigureQueued, dueAtEpochMs}`) is published in
  OpenAPI, hardcoded `null`, written by nothing and read by nothing.

## Decisions taken

Amendments are marked with the review pass that made them. A superseded decision keeps its number so
the record of why the code looks as it does stays readable.

| #  | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1  | **Held and dialing phases are distinct lifecycle stages, and dialing is a pure function of the stage.** Six stages: `forming → planned → connecting → active`, with reconfiguration split the same way into `reconfiguring` (new layout held) and `reconnecting` (new layout dialed). `establishing` is renamed `connecting`. _Amended 2026-08-23: `paused` is no longer a stage — halting is a transport fact (decision 25) — so the enum is six values, not seven._                                                                                                                                                                                                                  |
| 2  | **Replanning after a layout exists is a policy field**, `topology.replanning: 'auto' \| 'debounced' \| 'commanded'`, default `auto`. _Amended 2026-08-23: renamed from `topology.evolution`, which collided with `evolvePlannedTopology`'s existing meaning (incremental graph update). Also corrected: `auto` is **not** today's replan-on-every-change — every group already coalesces through one server-wide window, so `auto` and `debounced` are indistinguishable on main until decision 31 lands._                                                                                                                                                                             |
| 3  | **The observed connectivity status is living and pushed**: persisted on the group beside the intent fields as derived, non-authoritative state, so it rides snapshots, deltas, on-connect hydration and events with no new transport. No policy or gate may ever read it. _Amended 2026-08-23: it is two axes, not one (decision 30)._                                                                                                                                                                                                                                                                                                                                                 |
| 4  | **Policy-driven automation stays beside app-commanded control.** Automatic groups advance through the same stages on policy triggers; commanded groups advance on application commands. One model, two drivers, identical receipts and events.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 5  | **`reconfigure` lands in `reconfiguring` (held) by default**; `landing: 'apply'` skips the hold. _Amended 2026-08-23: `apply` does **not** mean a stage dance. It means the accepted layout follows the planned one with no lifecycle transition at all (decision 27). The earlier reading would have broken decision 17 outright._                                                                                                                                                                                                                                                                                                                                                    |
| 6  | **Preset replanning and landing**: `optimistic` = `auto` / `apply`, `managed` = `debounced` / `apply`, `match` = `commanded` / `hold`, `drop-in-social` = `debounced` / `apply`. `apply` for `managed` is deliberate: the manager curates who is in and when the group starts, not the wiring. A stored policy may override the preset value per group. _Amended 2026-08-23: `commanded` suppresses the replan, so `match` cannot observe its landing value; the only cell where `hold` is observable is `(auto\|debounced) × hold`, reachable by per-group override._                                                                                                                 |
| 7  | **`degraded` and `failed` are coverage bands from the policy's two rates, held for a dwell**: `degraded` = coverage `< successRate` and `>= minimumViableRate` for at least the dwell; `failed` = coverage `< minimumViableRate` for at least the dwell, or formation attempts exhausted. The dwell starts as a server default and becomes a policy knob only when an application needs it.                                                                                                                                                                                                                                                                                            |
| 8  | **One trigger vocabulary drives the automatic boundaries of `phased` groups**, `forming → planned` and `planned → connecting`: immediately, after a settle time, or when a member-presence threshold is met with a timer fallback.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 9  | **Status names are lower-case**, matching every enum on the wire and disambiguated from the stage enum by field name. _Amended 2026-08-23: the single list is replaced by two axes (decision 30). `reconfiguring` leaves the status vocabulary entirely — it was an activity sitting among conditions, and its precedence erased coverage while any planned layout existed._                                                                                                                                                                                                                                                                                                           |
| 10 | **A planned layout is readable exactly like an accepted one**: topology reads and the overlay push keep today's authorization. The members who must hold the layout are the ones who must read it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 11 | **Layout staleness is the topology-input fingerprint comparison, on the formation view.** _Amended 2026-08-23: staleness was two signals under one name. `layoutStale` now means only the latched obligation — the accepted layout no longer matches the planning authority. The transient case ("a replan is queued, due at T") moves to `pending`, the read field that already declares exactly that shape. Two stored fingerprints are required, one per layout; the row that exists today is the planned layout's._                                                                                                                                                                |
| 12 | **One initiator policy governs every group-authority command.** Whoever the initiator policy allows may `plan`, `connect`, `activate`, `reconfigure`, `pause` and `resume`; `server-auto` denies principals for all of them. _Amended 2026-08-23: the field moves out of `establishment` to the group-authority tier (decision 26) — it governs every command, not establishment._                                                                                                                                                                                                                                                                                                     |
| 13 | **Observed-status changes emit their own event**, `group-activation-status-changed`, carrying both axes, the coverage the condition was computed from, and the accepted layout identity. _Amended 2026-08-23: identity, not a bare version (decision 29)._                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 14 | **No migration and no compatibility adapters.** Nothing deployed needs migrating; the repository may change as it pleases. The finalisation rule is consistency: when the workstream closes, code, tests, recipes, OpenAPI, examples and docs agree, with no reader defaults for "old" rows, no renamed-enum shims and no optional-for-compatibility fields.                                                                                                                                                                                                                                                                                                                           |
| 15 | ~~**Applied and pending layouts are owned explicitly.**~~ _Superseded 2026-08-23 by decision 24. The words `applied` and `pending` were the problem: `applied` reads as a property of one layout rather than a relationship between two, which is what hid the fact that a failed reconfiguration had nothing to return to; and `pending` already means something else on the published topology view._                                                                                                                                                                                                                                                                                |
| 16 | **A stage receipt means the transition was accepted, nothing more.** Planning and publication stay asynchronous; the layout arrives as `layoutPlanned` and is visible on the topology read. The facade offers an explicit wait for a layout. _Amended 2026-08-23: the `connect` precondition is no longer bare existence — see decision 32._                                                                                                                                                                                                                                                                                                                                           |
| 17 | **`formation: 'immediate'` keeps creating the group `active`** with no held layout, exactly as today; the trigger vocabulary applies to `phased` groups only. This is what keeps the absent policy and the `optimistic` preset behaving as they do now — a product property, not a migration concern.                                                                                                                                                                                                                                                                                                                                                                                  |
| 18 | **Parallelism is an in-flight bound, and it is member policy.** `establishment.maxConcurrentEdgeSetups` is the maximum number of RTC setups a member may have in flight at once for that group; a setup ends on success, failure or timeout, and each ending wakes the next reconcile. _Amended 2026-08-23: because the budget belongs to the member (decision 26), no group may claim a share of another group's. A peer shared by two groups is one connection, charged to each group's in-flight count, under the member's own session-wide cap. No cross-group arbitration is promised, and none is needed._                                                                       |
| 19 | **The status function is total and precedence-ordered, its clocks are durable, and internal commands are causally fenced.** Dwell and evidence expiry are durable timer entries keyed by epoch and layout identity; every internal command carries `expectedFormationEpoch` and `expectedLayout` and `compute` validates them — including the existing criterion petitions. _Amended 2026-08-23: identity, not version (decision 29); and the fence alone does not order status writes (decision 33)._                                                                                                                                                                                 |
| 20 | **Validation names its test kinds, not only recipes**: pure matrices for the stage, transport, status and pacing functions; shared browser tests for the dial gate, accepted/planned cache and in-flight pacing; api-v1 recipes for HTTP/WS/persistence/multi-server; full-stack live-RTC for end-to-end dial suppression; headless/distributed tiers for parallelism sweeps; the medium-scale and state-write gates for every mutation-path change.                                                                                                                                                                                                                                   |
| 21 | **The implementation plan starts with contract closure, then the held-layout foundation**, and selects replanning modes and the living status only after accepted/planned ownership has proven itself in tests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 22 | ~~**`paused` is a stage.**~~ _Superseded 2026-08-23 by decision 25. Modelling a halt as a stage forced a recorded return stage onto the aggregate, made `pause` advance the formation epoch and re-pin the electorate — orphaning every armed timer and re-electing the manager, twice per round — and split the data gate into a two-case rule with an origin memo._                                                                                                                                                                                                                                                                                                                  |
| 23 | ~~**A reconfiguration started from `paused` returns to `paused`.**~~ _Superseded 2026-08-23 by decision 25: with halting on the transport plane there is nothing to record and nothing to restore. A reconfiguration can only begin from `active`, and the valve is untouched by it._                                                                                                                                                                                                                                                                                                                                                                                                  |
| 24 | **The two layouts are the `accepted` one and the `planned` one, and the accepted one is never displaced by an unconfirmed plan.** The accepted layout is what the browser dials, heals and routes application data over; it changes at exactly one moment, a successful `activate`. The planned layout is what has been published and what the activation criterion measures; it is discarded on failure and promoted on activation. These are the repository's existing words and this is the activation design's own recorded non-goal.                                                                                                                                              |
| 25 | **Halting is a transport fact, not a stage.** The group carries `transportState: 'flowing' \| 'halted'`, set by `pause` and cleared by `resume`, both governed by the initiator policy and never automatic. In `halted` the accepted layout stays accepted and connected, admission and presence behave as in `flowing`, and application data stops under every data policy. A reconfiguration begun while halted stays halted through `reconfiguring` and `reconnecting` and is still halted when it re-activates, because the valve was never touched. CRDT topics stay exempt.                                                                                                      |
| 26 | **Policy fields are tiered by who owns the decision**, and the tier decides where a new field belongs. **Group policy, by authority**: `formation`, `manager`, `activation`, `admission`, and the initiator. **Member policy**: `maxConcurrentEdgeSetups`, `transports` — declared at group scope, executed and bounded per member. **Transport policy**: `preActivationAppData` and the halt. The initiator field moves to the group-authority tier; no other field moves in this workstream.                                                                                                                                                                                         |
| 27 | **`topology.reconfigureLanding: 'apply'` means the accepted layout follows the planned one with no lifecycle transition.** `hold` means the accepted layout changes only on an explicit `activate`. An `apply` group therefore never enters `reconfiguring` or `reconnecting` — which is exactly today's behaviour, and is what makes decision 17's parity structural rather than something a recipe must police. The alternative reading was verified to break it: `optimistic` is `activation.mode: 'manual'`, and the criterion returns `wait` unconditionally for manual, so an optimistic group pushed out of `active` by its first join could never return.                      |
| 28 | **Failure discards the planned layout; it never destroys the accepted one.** `fail-formation` from `reconnecting` returns to `active` with the accepted layout intact. `fail-formation` from `connecting` still lands in `forming`, because no accepted layout exists yet. Planning exhaustion is transient — a terminally failed coalesced work row is revived by the next group revision — so the only terminal failure is formation-attempt exhaustion, which is the condition `failed`. `plan` is idempotently legal from `planned`, so an application always has a first-party repair path and never has to reach for an operator surface.                                        |
| 29 | **A layout is named by identity, not by a number.** The group records the accepted layout as `{groupRevision, presenceRevision, version, state}`; version alone is not an identity, because a removed tombstone reuses the previous version and causal revisions can be incomparable. The browser classifies each publication from the group snapshot it already holds, which keeps the fenced readiness barrier anchored. Classification must handle `incomparable` explicitly.                                                                                                                                                                                                       |
| 30 | **The observed status is two axes, and each side reports only work it performs.** **Condition** — `inactive \| initialising \| active \| degraded \| failed` — is coverage of the accepted layout and nothing else. **Remediation** — `none \| replan-queued \| awaiting-application` — is what the server is doing about a gap. `awaiting-application` is the one the product needs most: under `commanded` replanning Rallar is deliberately not acting, and today there is no way to say so. The browser separately reports its own repair work by aggregating the per-peer reconnect state it already computes; that is where the repairs that matter during a match actually run. |
| 31 | **Replanning windows are per-group policy and are bounded.** The debounce window and a maximum wait are both policy, server-clamped. The extending window keeps its coalescing benefit but can no longer defer a replan indefinitely under sustained churn. This is what finally makes `debounced` behave differently from `auto`.                                                                                                                                                                                                                                                                                                                                                     |
| 32 | **`connect` names the layout it means to accept.** The command carries the expected planned layout identity, and `compute` validates it against the current planning authority's fingerprint. Two typed denials: `no-planned-layout` and `planned-layout-superseded`. It never degrades to a silent no-op — a caller that raced a newer publication must be told, not quietly given the other layout.                                                                                                                                                                                                                                                                                  |
| 33 | **Status writes carry an evidence watermark.** Within one `(formationEpoch, accepted layout)` the epoch/identity fence is constant and cannot order status writes against each other, so a status write must strictly advance its evidence watermark; an equal-or-older watermark is a typed drop that writes nothing and emits no event.                                                                                                                                                                                                                                                                                                                                              |
| 34 | **`start-establishment` and `reopen-establishment` are removed, not retained.** `plan` + `connect` replace the first, `reconfigure` replaces the second, and the automatic retry leg is re-expressed in the new vocabulary. Decision 14 forbids keeping them; leaving them alive would also leave a second way into a dialing stage that ignores every precondition this plan adds.                                                                                                                                                                                                                                                                                                    |

## The stage model

The routing plane has six stages and keeps its invariants: every transition is an authorized AppInbox
command (or a policy-driven internal one), advances the formation epoch, re-pins the electorate, and
emits an event; membership, presence and WS connectivity work in every stage; there is no terminal
failure stage.

```text
forming ──plan──▶ planned ──connect──▶ connecting ──activate / criterion──▶ active
   ▲                                        │                                 │
   └────────────── fail-formation ──────────┘                                 │
                                                                              │
                    ┌──────────────── reconfigure ─────────────────────────────┘
                    ▼
             reconfiguring ──connect──▶ reconnecting ──activate / criterion──▶ active
                                             │                                  ▲
                                             └──── fail-formation ──────────────┘
                                                 (the planned layout is discarded;
                                                  the accepted layout is untouched)
```

| Stage           | Accepted layout        | Planned layout                    | Browser dials                                 | Forward gate under `blocked-until-active` |
| --------------- | ---------------------- | --------------------------------- | --------------------------------------------- | ----------------------------------------- |
| `forming`       | none                   | none (no plan exists)             | nothing; bootstrap suppressed                 | blocked                                   |
| `planned`       | none                   | the first layout, once published  | nothing; bootstrap suppressed                 | blocked                                   |
| `connecting`    | none                   | the first layout                  | the planned layout, under the in-flight bound | blocked                                   |
| `active`        | current                | none, or a newer one under `hold` | the accepted layout; heals                    | open                                      |
| `reconfiguring` | current (still dialed) | the new layout, held              | the accepted layout only                      | open                                      |
| `reconnecting`  | current (still dialed) | the new layout                    | the accepted layout **and** the planned one   | open                                      |

Two rows carry the whole reframing. In `reconnecting` the browser keeps serving and healing the
accepted layout while it establishes the planned one — the union of both edge sets, paced by the
in-flight bound and capped by the member's own session-wide limit. That is what the 15 s retained-peer
grace already approximates by timer today, made explicit and correct. And because the accepted layout
is never displaced until `activate`, a failed reconnection has something to return to.

Dialing is a pure function of the stage and the two layouts. In `forming` and `planned` there is
nothing to dial and no bootstrap fallback. `immediate` groups (decision 17) are created `active` with
`auto` replanning and keep today's behaviour, including the bootstrap fallback before the first
publication.

Stage commands and their sources (decision 12: one initiator policy for all of them):

| Command          | From                         | To                           | Who                                                 | Precondition                           |
| ---------------- | ---------------------------- | ---------------------------- | --------------------------------------------------- | -------------------------------------- |
| `plan`           | `forming`, `planned`         | `planned`                    | initiator per policy, or the plan trigger           | — (idempotent from `planned`)          |
| `connect`        | `planned`, `reconfiguring`   | `connecting`, `reconnecting` | initiator per policy, or the connect trigger        | names the expected planned layout (32) |
| `activate`       | `connecting`, `reconnecting` | `active`                     | initiator per policy (manual mode) or the criterion | —                                      |
| `reconfigure`    | `active`                     | `reconfiguring`              | initiator per policy, or the replanning policy      | —                                      |
| `fail-formation` | `connecting`, `reconnecting` | `forming`, `active`          | the criterion only                                  | —                                      |

`activate` is the only transition that changes the accepted layout: it promotes the planned layout
and drops the edges the two do not share. `fail-formation` targets `forming` from `connecting` and
`active` from `reconnecting`, which is the same rule stated once — return to whatever the accepted
layout was, and there was none the first time.

### Transport

`transportState` is a group field with two values (decision 25). `pause` sets `halted`, `resume` sets
`flowing`; neither is ever automatic, both are initiator-governed, and neither touches the routing
plane — so neither advances the formation epoch, re-pins the electorate, or disturbs an armed timer.

Application data is refused in exactly two cases, and they compose:

- **Forward gate** — under `blocked-until-active`, while no layout has been accepted in the current
  formation series (`forming`, `planned`, `connecting`). Derived from the stage; nothing is stored for
  it. A below-floor return to `forming` drops the accepted layout, so the gate closes again.
- **Halt** — while `transportState` is `halted`, under every data policy.

The WS relay enforces both. The browser runtime honours them on RTC by refusing `realtime.room` sends
while the snapshot says blocked or halted — cooperative, since the server does not carry RTC bytes.
Receiving is unaffected, so a straggling message from a peer that has not yet seen the pause is not
lost. CRDT topics remain exempt.

### Admission

Admission is a membership fact and is evaluated in every stage; the windows evaluate first. Naming it
per stage closes a gap the first draft left undefined:

| `admission.mode`      | `forming`     | `planned`     | `connecting`  | `active`      | `reconfiguring` / `reconnecting` |
| --------------------- | ------------- | ------------- | ------------- | ------------- | -------------------------------- |
| `open`                | admit         | admit         | admit         | admit         | admit                            |
| `closed`              | admit         | deny          | deny          | deny          | deny                             |
| `manager-approval`    | park          | park          | park          | park          | park                             |
| `untilMemberCount: N` | admit under N | admit under N | admit under N | admit under N | admit under N                    |

A join admitted mid-hold makes the **stage-current** layout stale: the planned one in `planned` and
`reconfiguring`, the accepted one in `active`. That is why `connect` names the layout it means to
accept — a caller that waited for layout A must not silently accept layout B. Under `commanded`
replanning a mid-hold join does not move any layout at all; it sets `layoutStale` and waits for the
application.

## Replanning

Once a layout exists, membership changes no longer imply a new layout:

| `topology.replanning` | Behaviour after a membership or session change                                                                            | Presets (decision 6)        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `auto`                | Re-plan and re-publish under the group's window; the landing decides whether the accepted layout follows                  | `optimistic`                |
| `debounced`           | Changes coalesce under a per-group window with a bounded maximum wait (decision 31)                                       | `managed`, `drop-in-social` |
| `commanded`           | Changes queue; the layout moves only on `reconfigure`, and the remediation axis says `awaiting-application` until it does | `match`                     |

`topology.reconfigureLanding: 'apply' | 'hold'` decides whether the accepted layout follows a
newly planned one (decision 27); the `reconfigure` command's `landing` overrides it per call.

Staleness (decision 11) is now two fields with one meaning each:

- **`layoutStale`** — the accepted layout's stored topology-input fingerprint differs from the current
  planning authority's. A latched obligation. Under `commanded` it means "this needs your
  `reconfigure`"; it does not clear on its own.
- **`pending`** — `{reconfigureQueued, dueAtEpochMs}`. A replan is queued and due at T. Transient,
  self-clearing, and already the declared meaning of a published read field that has never been
  populated.

A reconnect that replaces a session moves the fingerprint; a heartbeat does not, and does not even
reach the coalescing path. Leaving, disconnecting and expiry still heal live connections immediately
through the existing browser mechanisms; replanning governs the _layout_, not liveness.

## The browser contract

- **Two layouts per group.** The overlay cache holds the accepted layout's content and at most one
  planned layout's content. A publication that the classifier resolves as newer than the accepted
  layout lands as planned and raises `layoutPlanned`; it becomes accepted when the group snapshot's
  accepted-layout identity reaches it, which raises `layoutAccepted`. A publication the classifier
  resolves as `superseded` or `incomparable` is dropped, never an error. Retained-peer grace goes back
  to being what it was for — a short bridge under capacity eviction — instead of the only thing
  keeping a match alive through a reconfiguration.
- **The dial gate reads the stage and both layouts.** Desired peers come from the accepted layout,
  plus the planned layout while `reconnecting`. In `forming` and `planned` there is no accepted layout
  and no bootstrap fallback for `phased` groups. The stage and the accepted layout identity come from
  the group snapshot the browser already holds, receives on change and hydrates on connect — no new
  transport. The gate binds every outbound path and inbound peer admission, not one of them.
- **Parallelism is an in-flight bound (decisions 18, 26, R7).** The reconciler tracks setups from
  attempt start to success, failure or timeout, keeps at most `maxConcurrentEdgeSetups` in flight per
  group, and re-runs when one ends. A peer two groups both want is one connection charged to both
  counts. The member's session-wide cap remains the hard ceiling.
- **Halt is honoured locally.** While the snapshot says halted or blocked, `realtime.room` and
  `messages.room` refuse application sends with a typed local result.
- **Readiness means the accepted layout.** `rallar.realtime.room` is ready when the accepted layout's
  lanes to the local session's next hops are open; a planned layout does not change it.
- **The browser reports its own repair work.** Room status aggregates the per-peer reconnect state the
  RTC layer already computes, so an application can distinguish "an edge dropped and Rallar is
  retrying, attempt 3" from "an edge dropped and nothing is happening" without any server round trip.
- **Late join and reconnect.** Hydration delivers the stage, the accepted layout identity,
  `transportState` and the current publications; the browser classifies each publication and the gate
  decides. Readiness after hydration is a causally fenced barrier — ready only after the group
  snapshot and the accepted layout it names have both arrived — not "before any other message", which
  WS delivery across topics cannot promise.

## The observed connectivity status

The status answers two questions that the first draft asked with one field: **how connected is the
group**, and **whose move is it**. Splitting them is decision 30.

**Condition** is coverage and nothing else. Coverage is the readiness fraction of the layout carrying
traffic — the accepted layout, or, while no layout has ever been accepted, the planned one being
dialed. The rates are the policy's `successRate` and `minimumViableRate`; the dwell is a server
default (decision 7). `halted` does not change it: a fully connected, halted group reads `active`,
because the condition is about connectivity and the halt is intent. The function is total and
evaluates in this order:

| Order | Condition      | When                                                                                                         |
| ----- | -------------- | ------------------------------------------------------------------------------------------------------------ |
| 1     | `failed`       | formation attempts are exhausted and the group is `forming`; or coverage `< minimumViableRate` for the dwell |
| 2     | `inactive`     | no layout is carrying traffic or being dialed (`forming` with attempts remaining, `planned`)                 |
| 3     | `degraded`     | coverage is `< successRate` and `>= minimumViableRate` for the dwell                                         |
| 4     | `active`       | coverage `>= successRate`                                                                                    |
| 5     | `initialising` | otherwise: dialing has begun and the threshold has not been reached                                          |

The activation criterion is a separate measurement and is unchanged: it measures the **planned**
layout to decide whether it is ready to take over. The condition measures what is carrying traffic
now. In `reconnecting` those are genuinely two different layouts, and reporting one as the other is
what made the first draft's status erase coverage whenever a planned layout existed.

**Remediation** is what the server is doing about a gap, and it only ever names work the server
actually performs:

| Remediation            | Means                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `none`                 | nothing is queued and nothing is owed                                                |
| `replan-queued`        | a replan is queued or in flight; `pending.dueAtEpochMs` says when                    |
| `awaiting-application` | the accepted layout is stale and the replanning policy forbids Rallar from fixing it |

Properties the product commits to:

- The condition is **derived from evidence and never authoritative**: no admission, transition or data
  gate reads it.
- Both axes are **persisted and pushed** (decision 3): a change is written by internal authority after
  hysteresis and the dwell, and appears in the group snapshot, the WS delta, on-connect hydration, the
  `group-activation-status-changed` event (decision 13) and the formation view. Evidence arrivals do
  not write.
- Status writes **converge** (decision 33): within one `(formationEpoch, accepted layout)` a write
  must strictly advance its evidence watermark, so an older observation can never overwrite a newer
  one, however the writers interleave.
- Its **clocks are durable** (decision 19): dwell completion and evidence expiry produce no evidence
  event, so they are timer entries in the same durable queue the formation deadline uses, keyed by
  formation epoch and accepted layout identity; a stale entry is a drop.
- It is **truthful about its lag**: a status carries the time it was last confirmed, the coverage it
  was computed from, and the accepted layout identity it refers to.
- **The browser reports its own repairs separately.** Rallar's repairs during a live match — the
  reconcile pass, retained-peer grace, per-peer ICE restart — are browser-local, and the server
  neither performs nor observes them. So the browser reports them, and the server does not claim
  them.

## Automation

Automatic `phased` groups advance through the same stages without an application command. One trigger
vocabulary (decision 8) serves both automatic boundaries:

| Trigger     | Fires                                                                                  |
| ----------- | -------------------------------------------------------------------------------------- |
| `immediate` | as soon as the previous stage is entered (the default)                                 |
| `after`     | a settle time after the previous stage is entered                                      |
| `presence`  | when at least N members hold live presence, or at a timer fallback, whichever is first |

| Boundary                                | Automatic driver                                                           |
| --------------------------------------- | -------------------------------------------------------------------------- |
| `forming → planned`                     | the plan trigger                                                           |
| `planned → connecting`                  | the connect trigger, naming the planned layout it waited for (decision 32) |
| `connecting → active`                   | the activation criterion (unchanged)                                       |
| `active → reconfiguring`                | the replanning policy, under a `hold` landing                              |
| the accepted layout follows the planned | the replanning policy, under an `apply` landing — no transition occurs     |
| `transportState`                        | never automatic — an application decision only                             |

Every internal command — triggers, the criterion's petitions, status writes — carries
`expectedFormationEpoch` and `expectedLayout`, and `compute` rejects a mismatch as a typed stale
outcome (decision 19). Encoding the epoch in the request id deduplicates; it does not fence.

## Policy tiers

Decision 26 gives every policy field a home rule, so the contract does not drift as fields are added:

| Tier                        | Fields                                                           | Who decides                        |
| --------------------------- | ---------------------------------------------------------------- | ---------------------------------- |
| **Group policy, authority** | `formation`, `manager`, `activation`, `admission`, the initiator | an initiator or manager, per group |
| **Member policy**           | `maxConcurrentEdgeSetups`, `transports`                          | each member, within its own budget |
| **Transport policy**        | `preActivationAppData`, the halt                                 | the application, per group         |

The member tier is why decision 18 needs no cross-group arbitration: a connection budget belongs to
the member, so no group can be promised a share of another group's.

## Application-facing surface (product level)

HTTP commands, each an idempotent AppInbox mutation returning a receipt for the _transition_
(decision 16): `plan`, `connect`, `activate`, `reconfigure`, `pause`, `resume`. Reads: the group
snapshot (stage, epoch, accepted layout identity, `transportState`, condition, remediation), the
formation view (readiness, managers, status basis, `layoutStale`, `pending`), and the overlay
(accepted and planned publications). Pushed: group deltas on every stage, accepted-layout, transport
or status change; `group-activation-status-changed` events; overlay publications; and on-connect
hydration of all three.

Browser facade (sketch, names to be settled in the implementation plan):

```ts
const room = await rallar.rooms.createAndSwitch({
    lifecyclePolicy: {
        preset: 'match', // commanded replanning, hold landing
        establishment: { maxConcurrentEdgeSetups: 2 } // two RTC setups in flight per member
    }
});
room.formation.on(
    'change',
    (view) => ui.render(view.lifecycleState, view.condition, view.remediation)
);
room.formation.on('layoutPlanned', (overlay) => ui.showPlanned(overlay));
room.formation.on('layoutAccepted', (overlay) => ui.showAccepted(overlay));

await room.formation.plan(); // transition accepted; planning is asynchronous
const layout = await room.formation.layout(); // resolves to a planned layout identity
await room.formation.connect(layout); // accepts exactly that layout; dialing starts under the bound
// ... the match runs ...
await room.formation.pause(); // halt: connections stay, application data stops
await room.formation.reconfigure(); // new layout published and held, still halted
await room.formation.connect(await room.formation.layout()); // dial the new layout beside the old
await room.formation.resume(); // next round
```

## Large groups

Holding stages is the scale story: a thousand-session group may sit in `forming` for an hour, hold a
`planned` layout until the application says go, halt between rounds without dropping a single
connection, and under `commanded` replanning never re-plan because someone joined. The per-group
in-flight bound paces the establishment burst per member, and because it is policy a recipe can sweep
it. The criterion's deadline and the existing RTT damping are unchanged. The one new cost is
`reconnecting`, where a member holds both layouts' edges until `activate` — bounded by the in-flight
pace and the member's own cap, and measured by the pacing sweep. The product does not promise groups
beyond what the scale tiers measure, and it explicitly does not promise cross-group connection
budgeting.

## Validation

Each behaviour is pinned by the kind of test that can actually observe it (decision 20):

| Kind                                        | Pins                                                                                                                                                                                                                                                                                         |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure matrices (`packages/tests/shared`)     | the stage transition table, the transport valve and the forward gate, admission × stage, the total condition function and its precedence, the remediation function, layout classification including `incomparable`, the in-flight dial plan, trigger evaluation, staleness from fingerprints |
| Shared browser tests (`WebRtcGroupManager`) | the dial gate per stage, bootstrap suppression for `phased` groups, accepted/planned cache behaviour, the `reconnecting` union, in-flight pacing across repeated reconciles, wake-on-completion, local refusal of sends while halted, per-peer repair reporting                              |
| api-v1 black-box recipes                    | stage commands and receipts, preconditions and typed denials, accepted layout identity, transport state and both status axes in snapshots/deltas, on-connect hydration, events, the WS relay halting and resuming data, multi-server convergence, durable timers surviving restart           |
| Full-stack live-RTC (Playwright)            | end-to-end dial suppression in `planned`, a held reconfiguration keeping a match alive on the accepted layout, a failed reconnection leaving the match untouched, halt keeping every lane open, readiness as a fenced barrier                                                                |
| Headless / distributed tiers                | parallelism sweeps over `maxConcurrentEdgeSetups` at 6/20/50 with real RTC, reporting time-to-threshold and attempt counts per value                                                                                                                                                         |
| Gates (repository rule)                     | medium-scale and state-write gates for every mutation-path change; shared-web public API snapshots and bundle-boundary checks; repo governance                                                                                                                                               |

Named acceptance scenarios:

| Scenario                   | Pins                                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `held-layout`              | `plan` publishes a planned layout; no RTC signaling observed; `connect` accepts it and dialing starts; condition `inactive → initialising`                         |
| `discovery-holds-dials`    | a presence-connected `forming` lobby of a `phased` group makes zero bootstrap dials                                                                                |
| `connect-names-its-layout` | `connect` before any publication is `no-planned-layout`; naming a superseded layout is `planned-layout-superseded`; naming the current one succeeds                |
| `held-reconfiguration`     | `reconfigure` publishes a planned layout while the match keeps running on the accepted one; `connect` dials both; `activate` promotes                              |
| `reconfiguration-fails`    | a reconnection that misses the floor returns the group to `active` with the accepted layout still connected and the match uninterrupted                            |
| `pause-resume`             | `pause` halts room data on the WS relay for an `allowed` group while presence and membership keep working; `resume` lets it flow                                   |
| `reconfigure-while-halted` | a halted group reconfigures, stays halted through `reconfiguring` and `reconnecting`, and is still halted when it re-activates                                     |
| `commanded-replanning`     | a session reconnect inside a closed `match` group sets `layoutStale`, leaves the accepted layout, and reads remediation `awaiting-application` until `reconfigure` |
| `debounced-replanning`     | a join burst yields one re-plan after the window; sustained churn still re-plans at the bounded maximum wait                                                       |
| `pacing-sweep`             | the same group at `maxConcurrentEdgeSetups` 1, 2, 5: in-flight never exceeds the bound, deferred peers all connect, timings recorded                               |
| `status-lifecycle`         | the condition walks `inactive → initialising → active`, drops to `degraded` after the dwell when edges stop, recovers; one event per change                        |
| `status-convergence`       | two interleaved status writers converge on the newest evidence; a stale-evidence write is a typed drop that writes nothing and emits nothing                       |
| `status-on-connect`        | a reconnecting member is ready only after the snapshot and the accepted layout it names have both arrived                                                          |
| `stale-petition-fenced`    | an internal command carrying an old epoch or layout identity is a typed stale outcome, never applied                                                               |
| `automatic-progression`    | an automatic `phased` preset reaches `active` with zero commands, under each trigger                                                                               |
| `absent-policy-parity`     | a group with no policy behaves exactly as today                                                                                                                    |

## Consistency at finalisation

There is nothing to migrate and no compatibility to keep (decision 14). The workstream is finished
when the repository agrees with itself: the lifecycle enum is `forming | planned | connecting |
active | reconfiguring | reconnecting` everywhere and `establishing` does not survive in code, tests,
recipes, OpenAPI or docs; `start-establishment` and `reopen-establishment` are gone with their routes,
types, OpenAPI blocks and recipe call sites (decision 34); the accepted layout identity,
`transportState`, both status axes and the new policy fields are required wherever the contracts are
authoritative; `pending` on the topology view is populated or removed rather than left inert; every
recipe, example and fixture is updated in the same workstream;
`docs/rallar-group-formation-architecture.md` is rewritten to describe the result; and the absent
policy and the `optimistic` preset still behave exactly as they do today (decision 17) — a product
property the parity recipe pins, not a migration constraint.

## Not in this plan

- Per-edge confirm-or-fail establishment (`strictConfirmation`), `group_batch`, `ASYNC_REMOTE_QUEUE`,
  commanded-edge retention, and command-origin validation. Accepted and planned layouts give "planned
  is not yet active topology" without withholding the plan from the accepted store, which is what made
  those necessary.
- Enforcement of `establishment.transports`. Transport kind stays a declared, unread field; the
  transport plane in this plan carries only the halt.
- Cross-group connection budgeting. Explicitly not promised (decision 18).
- Slicing, gates and file-level implementation — the companion implementation plan.

## Implementation plan starting point

1. **Contract closure.** The six-stage transition table, accepted/planned ownership and layout
   identity, the transport valve and the forward gate, admission × stage, receipt semantics and the
   `connect` precondition, the total condition function and the remediation function, fingerprint
   staleness in its two forms, the in-flight dial plan, and the expected-epoch/identity fences — all as
   pure functions with their matrices, landing dark.
2. **One vertical held-layout capability.** Durable accepted/planned ownership, `connect` accepting an
   exactly named layout, the browser cache and every outbound and inbound dial gate, hydration and
   readiness fencing, and the live-RTC proof — delivered together, with the stage commands unreachable
   over HTTP until the whole path passes.

Replanning modes, triggers and the living status follow once that foundation's ownership boundaries
have proven themselves.

## Defaults to settle in the implementation plan

Numeric defaults and clamps, not product questions: the status dwell; the per-group debounce window,
its clamped maximum wait, and the minimum layout age; the `after` settle time and the `presence`
fallback timer; the per-preset `maxConcurrentEdgeSetups` now that it is an in-flight bound; the RTC
setup timeout that ends an in-flight attempt; and the hysteresis width between `active` and
`degraded`.
