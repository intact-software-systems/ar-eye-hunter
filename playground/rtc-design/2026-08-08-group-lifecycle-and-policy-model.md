# Group Lifecycle And Policy Model (2026-08-08)

Status: proposed control-plane design; decisions recorded below are
product-owner decisions from the 2026-08-08 design session. Implementation
not started.

## Purpose

Rallar's group machinery lacks management intelligence: there is no
explicit notion of _what a group is supposed to be doing right now_, no
ordered phases, no policies governing who may drive them, and no admission
rules beyond static caps. Every application gets one implicit behavior —
everything at once — and the storm scenarios
(`2026-08-08-group-formation-storm-scenarios.md`) are partly a consequence
of that missing layer.

This document defines the missing layer: a **group lifecycle** (explicit
formation phases) plus a **policy vocabulary** (who may do what, when, and
under which admission rules), enforced server-side. It is the control plane
above the mechanism catalog
(`2026-08-08-group-formation-mechanism-catalog.md`, M1–M14) and the phased
implementation plan
(`2026-08-08-group-formation-implementation-plan.md`): mechanisms are the
data plane; policies select over them.

The two motivating application archetypes:

- **Managed/phased**: a group forms as a pure discovery phase (membership
  and presence only, no peer connections); one or more managers are chosen
  (creator, assigned, by rank, or deterministically at random); a manager
  starts the communication-establishment phase (WebRTC and/or WebSocket);
  when the group is sufficiently connected (success-rate threshold,
  deadline, or both) the application activates it and starts sending data;
  post-activation joining follows an explicit admission policy.
- **Optimistic/immediate**: the application does not care about phases —
  everything starts at once, whoever manages to connect participates. This
  is today's behavior, made an explicit, named, bounded preset instead of
  an accident.

These are **not two systems**. They are two policy presets over one
lifecycle. That is the central design move: phases become explicit states,
and differences between applications become declarative policy data, not
divergent code paths.

## Recorded decisions

1. **Server-authoritative enforcement.** Policies live on the group as
   data; every phase transition and admission decision is an authorized
   AppInbox mutation validated in group policy. Applications and managers
   drive transitions; they cannot bypass them. (Only this posture makes
   admission policies enforceable.)
2. **Activation posture: observed convergence by default.** The activation
   criterion ("sufficiently connected: threshold, time, or success-rate")
   is the observed-convergence readiness threshold. This settles the
   direction of the decision parked in
   `plans/rallar-distributed-group-rtc-activation-design.md` (Phase 5 of
   the implementation plan): threshold-based observed convergence is the
   default activation criterion; the activation design's per-edge
   confirm-or-fail batch machinery remains the establishment-phase
   implementation and the strict-policy option for applications that
   require a hard per-edge audit trail. The activation design document
   records this at its Phase 5 decision point.
3. **Pre-activation application data is a policy knob, default allowed.**
   WS-relayed application data flows in every phase by default (the
   permissive/optimistic doctrine); applications wanting a quiet lobby set
   the policy to gate data until `active`. RTC-transported data naturally
   begins with establishment.

## The three layers

| Layer                                                                                                                               | What it answers                                                              | Status                       |
| ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------- |
| Business lifecycle (`Group.status`: `active / archived / deleted`)                                                                  | Does this group exist as a business object?                                  | Exists                       |
| **Formation intent (this document)**                                                                                                | What is the group supposed to be doing right now, and under whose authority? | New                          |
| Connectivity observation (RTC activation status projection: `INACTIVE / INITIALISING / ACTIVE / RECONFIGURING / DEGRADED / FAILED`) | How connected is the group actually?                                         | Designed (activation design) |

Intent is authoritative and policy-driven; observation is derived and never
authoritative; business lifecycle is orthogonal to both. Nothing in this
model changes `Group.status` semantics.

## Lifecycle state machine (formation intent)

```text
    create(policy)
         |
         v
     FORMING            discovery: membership + presence only;
         |              no topology work, no commanded dials
         | start-establishment
         | (by EstablishmentPolicy.initiator, or immediately
         |  when FormationPolicy = immediate)
         v
   ESTABLISHING         communication establishment underway
         |              (RTC and/or WS per policy; batches,
         |              pacing, budgets from the data plane)
         | activation criterion met
         | (threshold / deadline / manual, per policy)
         v
      ACTIVE            application data phase; admission now
         |              governed by AdmissionPolicy
         | re-establishment (membership change, degradation,
         |   manager/app request) --> back to ESTABLISHING
         |   while remaining app-ACTIVE (matches the existing
         |   RECONFIGURING observation state)
         v
(business lifecycle end: archived / deleted)
```

Invariants:

- **The safety baseline is never phase-gated.** Membership mutations,
  presence, and WS connectivity work in every state. Phases gate
  _connection establishment work_ and the app-visible `active` signal —
  never the ability to be in the group. A stuck phase must degrade to
  "not yet established", never to an outage.
- **A group is safe with zero managers.** Manager absence blocks only the
  actions policy assigns to managers; succession or policy fallback
  restores them. No server process owns the group (the no-server-owner
  invariant from the activation design is unchanged).
- **Transitions are mutations.** Every transition is an AppInbox command
  with authorization, idempotency, and typed rejections, following the
  convergent-service doctrine unchanged.
- The `immediate` preset collapses FORMING to zero length: creation enters
  ESTABLISHING (or effectively ACTIVE with a trivially-satisfied
  criterion) in the same causal step. One lifecycle, degenerate timing.

## Policy vocabulary

All policies are one declarative document attached to the group
(create-time input, mutable afterward only via authorized mutations;
server-clamped bounds on every numeric knob).

### FormationPolicy

| Value       | Meaning                                                                     |
| ----------- | --------------------------------------------------------------------------- |
| `phased`    | FORMING is entered and held until an authorized start-establishment command |
| `immediate` | Establishment (and activation, per criterion) begin at creation             |

### ManagerPolicy

| Field        | Values                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------ |
| `selection`  | `none` \| `creator` \| `assigned(principalIds)` \| `elected-by-rank(rankSource)` \| `elected-random-deterministic` |
| `count`      | 1..k managers                                                                                                      |
| `succession` | `next-by-selection` \| `none (actions fall back to policy default)`                                                |

`elected-random-deterministic` uses rendezvous hashing over member
identities (deterministic, coordination-free; the repo already uses this
technique in `packages/shared/rtc/rtt-reporting-policy.ts`). The manager is
a **client role with different authorizations**, enforced server-side at
mutation boundaries — never a distributed-systems coordinator. Manager
crash or departure triggers succession through ordinary presence/membership
machinery.

### EstablishmentPolicy

| Field        | Values                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------- |
| `transports` | `rtc-and-ws` \| `ws-only` \| `rtc-preferred`                                                       |
| `initiator`  | `manager` \| `any-member` \| `server-auto` (start when a presence threshold or timer fires)        |
| `pacing`     | capacity ceiling / batch parameters (delegates to the activation design's establishment machinery) |

This answers the activation design's open "who requests activation"
question: whoever `initiator` says.

### ActivationCriterion

| Field                | Values                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------- |
| `mode`               | `threshold` \| `deadline` \| `manual` \| `threshold-or-deadline`                             |
| `successRate`        | e.g. 0.95 of planned edges observed connected (observed convergence)                         |
| `deadlineMs`         | activation fires (or fails, per `onDeadline`) at T                                           |
| `onDeadline`         | `activate-degraded` \| `fail-formation`                                                      |
| `strictConfirmation` | `false` (default: observed convergence) \| `true` (per-edge confirm-or-fail batch semantics) |

### AdmissionPolicy (post-activation; pre-activation admission is open under ordinary group policy)

| Value                    | Meaning                                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------- |
| `open`                   | Members join freely after activation                                                                      |
| `manager-approval`       | Join requests park pending; a manager grants or declines (extends the existing invite/approval machinery) |
| `open-until-deadline(T)` | Free joins until T, then closed                                                                           |
| `open-until-capacity(N)` | Free joins until member count N, then closed (generalizes existing `maxMembers`)                          |
| `closed`                 | No joins after activation                                                                                 |

Composable where meaningful (e.g. `manager-approval` + capacity).

### DataPolicy

| Field                  | Values                                                    |
| ---------------------- | --------------------------------------------------------- |
| `preActivationAppData` | `allowed` (default; WS-relayed) \| `blocked-until-active` |

### Presets

| Preset                        | Formation | Manager                      | Initiator   | Criterion                                              | Admission           | Data                 |
| ----------------------------- | --------- | ---------------------------- | ----------- | ------------------------------------------------------ | ------------------- | -------------------- |
| `optimistic` (today, named)   | immediate | none                         | any-member  | manual/trivial                                         | open                | allowed              |
| `managed`                     | phased    | creator (succession by rank) | manager     | threshold-or-deadline                                  | manager-approval    | allowed              |
| `match` (competitive session) | phased    | elected-by-rank              | manager     | threshold, `strictConfirmation: true`, onDeadline fail | closed              | blocked-until-active |
| `drop-in social`              | immediate | none                         | server-auto | threshold                                              | open-until-capacity | allowed              |

Presets are convenience bundles; every field remains individually
settable.

## Enforcement points (server-authoritative)

- **Policy storage**: the policy document is group configuration —
  authoritative, versioned with the group's causal machinery, set at
  creation and mutated only through AppInbox commands (the same doctrine as
  every other group mutation). Sparse client input is normalized at the
  boundary; all fields have server defaults and clamps.
- **Transition commands**: `start-establishment`, `activate`,
  `reopen-establishment`, manager assignment/succession — each an AppInbox
  command whose `validate` phase checks the policy (right actor, right
  current state), returning typed rejections otherwise.
- **Admission**: extends the existing enforcement point
  (`packages/shared-server/rallar-system/group-policy.ts`, where
  `maxMembers` / `maxSessionsPerMember` / invite checks already live). A
  join arriving under `manager-approval` becomes a pending admission
  awaiting a manager grant — building on the existing invite/acceptance
  flow rather than a new subsystem.
- **Manager authority**: an authorization predicate over (principal, role,
  policy, current state) evaluated wherever group mutations are already
  authorized. No new trust machinery; the actor identity comes from the
  same authenticated session facts as every mutation.
- **Derived surfaces**: the lifecycle state joins the group snapshot /
  read APIs beside the RTC activation projection, so applications and
  tests read intent and observation side by side.

## Mapping to mechanisms and existing work

| Lifecycle element                         | Data-plane mechanisms                                                                                                                             | Exists today / designed                                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| FORMING (no connections during discovery) | M5 (overlay precedence — no bootstrap dialing for not-yet-establishing groups), M7 (formation window with an explicit trigger instead of a timer) | Formation plan Phases 1, 5                                                                                                               |
| Manager selection/succession              | rendezvous-deterministic election; presence machinery for liveness                                                                                | Director appointment ancestor exists (`RallarGroupDirectorAppointment`, `GROUP_DIRECTOR_APPOINT`); needs promotion to authoritative role |
| ESTABLISHING                              | The activation design's batch (plan, pace, establish); M10 dial budgets; M11 retention                                                            | `plans/rallar-distributed-group-rtc-activation-design.md` (PR #83)                                                                       |
| Activation criterion                      | Observed convergence: edge state from RTT/liveness reporting vs. the planned overlay; threshold + deadline evaluation                             | Architect-review posture, now recorded as default; strict mode = the batch's per-edge confirmations                                      |
| Admission policies                        | group-policy checks + invite/approval flow + caps                                                                                                 | `group-policy.ts` (caps exist), invites exist; deadline/approval-after-active are new rules at the existing gate                         |
| Optimistic preset                         | Everything at once — but still bounded by Phase 1+ budgets and damping                                                                            | Today's behavior, named                                                                                                                  |
| Lifecycle state surface                   | Snapshot/read API projection beside RTC activation status                                                                                         | Activation design's status projection pattern                                                                                            |

Effect on the phased implementation plan: **Phase 0 is unaffected**
(measurement is policy-agnostic). Phases 1–4 build exactly the machinery
the policies select over; this model adds the _selector_. The lifecycle
layer itself (policy document, transition commands, admission rules,
manager role) becomes its own workstream, naturally slotted after Phase 2
(damping) and before/with Phase 5 (formation epochs), and the Phase 5
decision point in the activation design is now pre-answered by recorded
decision 2 above.

## Test scenario matrix

Policies-as-data makes application diversity an enumerable matrix. Named
scenarios (each: api-v1 black-box recipe now, distributed recipe later; run
at the 6/20/50 tiers where scale matters):

| Scenario               | Core assertions                                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `optimistic-baseline`  | Today's behavior as an explicit preset; the formation-burst Phase 0 recipes are this scenario                                                                                  |
| `managed-phased`       | During FORMING: zero topology publications, zero RTC signaling observed; establishment begins only on the manager's command; non-manager start-establishment → typed rejection |
| `threshold-activation` | App-visible `active` appears only after ≥ successRate of planned edges observed; below threshold at deadline → `activate-degraded` or `fail-formation` per policy              |
| `strict-confirmation`  | `strictConfirmation: true` drives the per-edge batch path; batch outcome counts match the confirmation ledger                                                                  |
| `leader-gated-join`    | Join while ACTIVE parks pending; manager grant admits; manager decline rejects; grant by non-manager → typed rejection                                                         |
| `deadline-join`        | Join before T admitted; join after T → typed rejection with the policy reason                                                                                                  |
| `capacity-join`        | Joins admitted up to N; N+1 → typed rejection; leave under N reopens per policy                                                                                                |
| `closed-after-active`  | Any post-activation join → typed rejection; pre-activation joins unaffected                                                                                                    |
| `manager-succession`   | Manager departs mid-ESTABLISHING; successor (by policy) can complete the phase; zero-manager fallback keeps the group safe                                                     |
| `data-gating`          | `blocked-until-active`: app messages before ACTIVE are rejected/withheld per contract; `allowed`: WS app data flows during FORMING                                             |

Every scenario is a policy document plus assertions — which is precisely
what makes "the cases common to multi-party applications" coverable: the
matrix is finite, named, and grows by adding a preset row, not a new test
architecture.

## Open questions

1. Pending-admission representation for `manager-approval` (extend invites
   vs. a dedicated pending-membership state) — decide when the admission
   workstream is planned.
2. Rank source for `elected-by-rank` (application-supplied member metadata
   vs. join order vs. app callback) — application-supplied metadata is the
   least coupled default.
3. Policy mutability semantics mid-phase (e.g. changing AdmissionPolicy
   while ACTIVE is a plain mutation; changing FormationPolicy mid-
   ESTABLISHING should supersede the running establishment per the
   activation design's supersession rules) — specify per field when the
   lifecycle workstream is planned.
4. Whether the lifecycle state lives on the group aggregate or as a
   separate scoped document — aggregate-adjacent is the default posture
   (it is authoritative group intent), decided at implementation planning.

## Relationship to other documents

- Scenarios (`2026-08-08-group-formation-storm-scenarios.md`): the storms
  this control plane helps prevent from being every application's default.
- Mechanism catalog (`2026-08-08-group-formation-mechanism-catalog.md`):
  the data plane these policies select over.
- Implementation plan
  (`2026-08-08-group-formation-implementation-plan.md`): Phases 1–4
  unchanged; this model shapes Phase 5 and adds the lifecycle workstream.
- Activation design (`plans/rallar-distributed-group-rtc-activation-
design.md`): supplies ESTABLISHING; its Phase 5 decision point is
  resolved in direction by recorded decision 2 (observed-convergence
  default, strict per-edge as policy option) — to be reflected there when
  that document is next revised.
