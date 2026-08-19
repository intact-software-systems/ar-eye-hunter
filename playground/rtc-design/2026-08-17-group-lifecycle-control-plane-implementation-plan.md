# Group Lifecycle Control Plane — Implementation Plan (2026-08-17)

Status: **in execution — slices 1–3 delivered** (slice 2 as PRs #263/#264/#266/#268/#270/#272, slice 3 as #277/#282). Implements
`2026-08-08-group-lifecycle-and-policy-model.md` and, with it, Phase 5's formation window (M7) from
`2026-08-08-group-formation-implementation-plan.md`. These are one workstream, not two: Phase 5's
formation window is this document's FORMING state with a policy-driven trigger instead of a timer.
Building them separately means building the timer version and then replacing it.

## The property that makes this shippable

**An absent policy document is the `optimistic` preset, which is today's behaviour exactly.** FORMING
collapses to zero length, establishment and activation happen at creation, admission stays open, data
flows. Every existing group keeps its current behaviour with no migration, and every slice below can
land dark. If a slice cannot preserve this, the slice is wrong.

## Decisions taken (2026-08-17)

| # | Decision |
| --- | --- |
| 1 | **Placement is split.** The policy document is its own scoped document, mirroring `rallar-system/topology/config/persistence/` (codec, repository, storage keys, exact-mutation reader). The lifecycle enum and activation epoch — small, hot, and read by every admission and activation decision — live on the group aggregate so they serialize with membership under compare-and-set. |
| 2 | **`RECONFIGURING` is a distinct intent state**, not `ESTABLISHING` plus a flag. |
| 3 | **Formation can fail, but not terminally.** `ActivationCriterion` gains a `minimumViableRate` floor distinct from `successRate`. At or above the floor but below `successRate` the group activates degraded. **Below the floor the group does not activate**: a typed reason is recorded, an attempt counter increments, and intent returns to FORMING under policy backoff. No terminal `FAILED` intent state — the group stays joinable and retryable throughout. The two rates subsume the design's `onDeadline` field, which is dropped: a floor equal to the success rate is all-or-nothing, and anything below it already means do-not-activate. |
| 4 | **Full policy vocabulary in v1**, including Admission and Data policies. |
| 5 | **`strictConfirmation` is present in the schema, defaults `false`, and `true` returns a typed unsupported-in-this-release rejection** at validation. |

Decision 1 splits what the design document bundled. Policy is cold, near-static and largish; lifecycle
state is tiny and coupled to membership. Co-locating them forced a false choice between contention on
the hottest row and a cross-document staleness window. Split, each lands cleanly — the residual
staleness is on policy reads, which is tolerable precisely because policy is near-static.

Decision 5 keeps the vocabulary complete without pulling the entire unimplemented activation design
(five-lane work table, per-edge claim/expand, retry, abort sweep) into the first delivery. The `match`
preset therefore ships **without** per-edge confirmation, and that gap is explicit rather than
silently half-working.

## Corrections to the design document

Six things in `2026-08-08-group-lifecycle-and-policy-model.md` do not hold as written. All are folded
into the slices below.

1. **`ESTABLISHING` was ambiguous.** The document routes re-establishment "back to ESTABLISHING while
   remaining app-ACTIVE", so one state meant both never-been-active and was-active-now-repairing —
   which have opposite semantics under `blocked-until-active`. Resolved by decision 2.
2. **`fail-formation` had no destination, and the criterion had no floor.** The intent state machine
   has no terminal failure state, and adding one contradicts the invariant that a stuck phase "must
   degrade to *not yet established*, never to an outage". But formation genuinely can fail, and with
   a single `successRate` the design treats 94% and 5% connectivity identically — so
   `activate-degraded` at 5% would declare a group ACTIVE that cannot carry the application's data.
   Resolved by decision 3: a `minimumViableRate` floor separates degraded-but-usable from
   not-viable, and below the floor the group does not activate. This is a recoverable outcome, not
   a terminal state, which is what distinguishes it from the outage the invariant forbids.
3. **A deadlock was expressible.** `ManagerPolicy.selection: none` with
   `EstablishmentPolicy.initiator: manager` leaves nobody able to start establishment, and the
   document promises clamps only on *numeric* knobs. **Fix:** a cross-field validity predicate at
   policy normalization, returning all issues as a typed value.
4. **Deterministic election flaps during the phase that needs it.** `elected-random-deterministic`
   is deterministic over *member identities*, but membership changes throughout FORMING — so the
   manager changes as people join, exactly while the manager is who must trigger establishment.
   **Fix:** pin the election input to the member set at a **formation epoch** boundary; the epoch
   advances only on explicit transition, never on join.
5. **A never-activating group never enforced its admission policy.** `drop-in social` is `immediate`
   + `threshold` + `open-until-capacity(N)`; if the threshold is never met the group never reaches
   ACTIVE, so a *post-activation* policy never binds and joins stay unbounded but for `maxMembers`.
   **Fix:** admission binds on **entry to the phase it names**, not on activation.
6. **Policy mutability was unspecified per field.** **Fix:** each field declares one of `immutable`,
   `mutable-any-phase`, or `mutable-with-supersession`; the last re-evaluates the running phase.
   *Execution note (2026-08-18): v1 ships no policy-update surface at all — the document is written
   once at group creation, so every field is effectively immutable and this correction stays
   unbound. The per-field declarations land with the first policy-update surface, which no current
   slice owns.*

## Slices

Each slice is independently shippable and preserves the property above.

### Slice 1 — Policy contract, defaults and validation — **delivered**

The policy contract, presets, server defaults, per-field clamps, and the cross-field validity
predicate (correction 3). Sparse client input has its own contract, normalized at the boundary.
Nothing reads a policy, so no behaviour changes.

Tests: the validity matrix, including the `none` + `manager` deadlock, capacity/deadline bounds, and
that an absent document normalizes to `optimistic`.

Three departures from this plan as written, all deliberate:

- **Persistence and the `GROUP_CREATE` wiring moved to slice 2.** Persisting a document nothing reads
  would put an AppInbox mutation-path change — with its black-box recipes and medium-scale gate —
  into a slice that otherwise carries no risk. It lands with its first reader.
- **`onDeadline` is removed from the contract entirely.** It has nothing left to decide once the
  criterion carries two rates: between the floor and the success rate the outcome is degraded, below
  the floor the group does not activate. Setting `minimumViableRate` equal to `successRate` is how a
  caller asks for all-or-nothing, which is strictly more expressive than the two-valued enum it
  replaces and is exactly what the `match` preset now does.
- **The files live in `packages/shared/api/group-lifecycle/`.** The changed-style gate rejected them
  at the top level: `packages/shared/api` passed its directory-density threshold and added to an
  already-flagged `group` prefix cluster. Four files that are one coherent feature is the feature
  ownership the rule asks for.

Also found while implementing: `packages/shared/api/group-policy-types.ts` already holds the
enforcement *decision* vocabulary — `GroupPolicyReasonCode` and `GroupPolicyResult`. **Slice 5's
admission rules extend that vocabulary rather than paralleling it.**

Risk: none realized. No behaviour change by construction.

### Slice 2 — Lifecycle state, transitions, and the FORMING gate — **delivered**

The intent enum (`FORMING`/`ESTABLISHING`/`ACTIVE`/`RECONFIGURING`) and activation epoch on the group
aggregate. AppInbox transition commands — `start-establishment`, `activate`, `reopen-establishment` —
each with an authorization predicate over (principal, role, policy, current state) and typed
rejections, alongside the existing `GROUP_*` command set. FORMING holds topology planning and
commanded dials: **this is Phase 5's M7 formation window.**

**The safety-baseline invariant is the first test written, not the last.** Membership mutations,
presence and WS connectivity must work in every state, including a group deliberately stuck in
FORMING. Phases gate establishment work and the app-visible `active` signal — never the ability to be
in the group.

Risk: highest in the plan. This is where gating first touches live behaviour, and where the
`immediate`-collapses-to-zero path must be proven byte-identical to today.

#### Decisions taken during slice 2 execution (2026-08-18)

| # | Decision |
| --- | --- |
| 2.1 | **The aggregate epoch field is `formationEpoch`, a monotonic counter** advanced only by an accepted transition command, never by joins. One field serves both decision 1's "activation epoch" and correction 4's election pinning; a wall-clock activation timestamp would give slice 4's deterministic election nothing stable to pin to. |
| 2.2 | **Manager authority before slice 4 is derived where the policy allows and honestly unavailable where it does not.** `selection: 'creator'` resolves to `ownerPrincipalId`, `'assigned'` to `assignedPrincipalIds`; the elected variants return a typed `lifecycle-manager-unavailable` rejection until election lands. Authority is never widened to owner/admin as a stand-in. `initiator: 'server-auto'` denies principal-commanded transitions — it appears only in `drop-in-social`, whose `immediate` formation never phases. |
| 2.3 | **Slice 2 lands as two changes**: the pure core (field, transition table, authorization predicate — dark, no behaviour change), then the three AppInbox commands wiring it with recipes and the medium-scale gate. |

The lifecycle rejection vocabulary extends `GroupPolicyReasonCode`
(`lifecycle-transition-invalid`, `lifecycle-manager-unavailable`) rather than
paralleling it, per the slice 1 finding.

#### Decision taken during the FORMING gate (2026-08-18)

| # | Decision |
| --- | --- |
| 2.4 | **Only FORMING holds topology planning.** The gate is one predicate (`isGroupTopologyPlannableAt`) at the single planning choke point; a forming group takes the same removed-topology branch as an archived one. ESTABLISHING, ACTIVE, and RECONFIGURING all plan — RECONFIGURING exists precisely to redo establishment work, so holding planning there would defeat its purpose. Commanded dials follow the plan automatically: with no planned overlay there is nothing to materialize into `overlay.topology` broadcasts. The admin `reconfigureGroupTopology` path deliberately bypasses the gate as an operator escape hatch. |

### Slice 3 — Activation criterion and readiness — **delivered**

`threshold` / `deadline` / `manual` / `threshold-or-deadline`, evaluated against two rates:
`successRate` for full activation and `minimumViableRate` as the floor below which the group does not
activate at all. `activate-degraded` applies only between them. Below the floor, intent returns to
FORMING with a typed reason and an incremented attempt counter, under policy backoff.

Readiness derives from observed edge state — RTT and liveness evidence against the planned overlay —
as the fraction of planned edges observed connected.

The read surface must carry enough for an application to explain itself to a user: intent state,
observed rate, last formation outcome with its reason, and attempt count. A group that repeatedly
fails to reach its floor is a product event, not a silent retry.

Scope note: this builds **only the readiness derivation**, not the full six-state RTC activation
projection (`INACTIVE`…`FAILED`), which has no implementation today and remains a separate concern.
Intent is authoritative; this observation feeds the criterion and nothing else.

#### Decisions taken during slice 3 execution (2026-08-18)

| # | Decision |
| --- | --- |
| 3.1 | **Delivered as 3a (PR #277) and 3b (PR #282).** 3a: `formationAttemptCount`, `lastFormationOutcome`, `establishmentStartedAtEpochMs` on the aggregate, the pure readiness derivation, and the `GET .../formation` view. 3b: the pure criterion, the `fail-formation` transition, and both evaluation legs. |
| 3.2 | **One evaluation function, two producers** (recorded in `2026-08-18-activation-evaluator-placement-analysis.md`): the topology work handler petitions the criterion on evidence, and the transitions themselves schedule deadline/backoff entries into a dedicated `FORMATION_TIMER` outbox consumed by a minimal handler. Entries are epoch-keyed; criterion command ids are idempotent per (decision, epoch), so racing producers replay instead of double-transitioning. |
| 3.3 | **Criterion commands run under internal authority `formation-criterion`**, limited to activate / fail-formation / retry-establish; `failGroupFormation` is criterion-commanded only and principals are rejected. Operator activation carries no criterion fields — absence, like null, means operator activation, and it records no outcome. |
| 3.4 | **Native `next_ts` scheduling replaced the planned requeue contract.** Landing it exposed a pre-existing skew: naive timestamp columns hold UTC wall clocks but the queue SQL compared them with session-zone `now()`; fixed with `(now() at time zone 'UTC')` throughout the resource-inbox SQL, pinned under deliberately skewed PGlite sessions. The timer consumer keeps a not-due throw as clock-skew defense. |
| 3.5 | **The operator-driven transitions recipe pins `activation.mode: manual`** — the managed preset's default `threshold-or-deadline` would auto-activate underneath its deterministic state walk now that the evidence leg is live. |

### Slice 4 — Manager role

`ManagerPolicy` (`selection`, `count`, `succession`). Election uses the existing
`rendezvous-score.ts` primitive, pinned to the formation epoch (correction 4). Zero-manager fallback
is explicit: manager absence blocks only manager-assigned actions, never group safety.

#### Decision taken during slice 4 planning (2026-08-18)

| # | Decision |
| --- | --- |
| 4.2 | **The match preset elects `elected-random-deterministic` in v1.** `elected-by-rank` has no possible rank source yet — the `GroupMember` contract carries no application metadata — so it stays in the vocabulary and resolves zero managers (typed `lifecycle-manager-unavailable`) until a source lands. Deviation from the design table recorded; see the deferred item below so it is not forgotten. |
| 4.1 | **Aggregate-recorded election; authority stays pure** (option A of `2026-08-18-manager-role-basis-analysis.md`). Epoch-advancing transitions record the electorate on the aggregate beside `formationEpoch`; manager resolution is a pure function over (policy, recorded electorate, epoch, live member statuses) — rendezvous ranking keyed on the epoch, still-active filter, first `count`, with succession `next-by-selection` filtering before taking and `none` taking before filtering. Departure needs zero extra writes. The plan's original "build on `GROUP_DIRECTOR_APPOINT`" sentence is amended: the aggregate-state *pattern* is what survives; the session-scoped, heartbeat-leased, claim-based semantics deliberately do not, because manager liveness is membership, not heartbeats. The director remains the browser work delegate. |

*Correction (2026-08-18): an earlier revision of this note claimed every preset ships
`selection: 'none'` — wrong, from a faulty extraction. The presets have carried
`managed: creator` and `match: elected-by-rank` since slice 1; decision 2.2's interim predicate is
what makes the managed creator work today, and the elected variants are what this slice activates.*

### Slice 5 — Admission and data policies

`AdmissionPolicy` at the existing `group-policy.ts` gate, where `maxMembers`, `maxSessionsPerMember`
and invite checks already enforce — binding on phase entry (correction 5). `manager-approval` parks a
join as pending, extending the existing invite/acceptance flow rather than adding a subsystem.
`DataPolicy.preActivationAppData` gates WS-relayed application data.

Risk: touches the hot, well-covered join path. Every new rule is an added predicate at an existing
enforcement point, never a parallel path.

### Slice 6 — Read surface and scenario matrix

Lifecycle state joins the group snapshot and read APIs beside the readiness derivation, so
applications and tests read intent and observation side by side. *Largely delivered early: the
aggregate has carried the lifecycle fields in every group response since slice 2, and the
`GET .../formation` view landed with 3a. What remains here is the scenario matrix and the
`strict-confirmation` negative recipe.* The design document's ten named
scenarios land as black-box recipes at the 6/20/50 tiers where scale matters.

`strict-confirmation` becomes a negative test in v1: setting `strictConfirmation: true` returns the
typed unsupported rejection.

## Deferred, explicitly

- **Per-edge confirm-or-fail batch machinery** — the whole activation design. Gated behind
  `strictConfirmation: true`, which v1 rejects. The posture decision (observed convergence as
  default) is recorded product-owner decision 2 and is supported by the Phase 0–4 evidence in
  `2026-08-17-phase5-establishment-posture-decision.md`.
- **The six-state RTC activation status projection.** Slice 3 builds only the readiness fraction.
- **The `elected-by-rank` rank source** (decision 4.2). The selection ships in the vocabulary and
  resolves zero managers until the `GroupMember` contract gains an application-supplied rank (the
  plan's least-coupled default) or another source is chosen. Whoever picks this up: the resolution
  already takes `rankByPrincipalId` as input, so the work is the member-contract field, its join
  plumbing, and swapping the `match` preset back from `elected-random-deterministic`.
- **The `match` preset's per-edge audit trail and server-side pacing.** The preset ships and, with
  the `minimumViableRate` floor, it now also gets honest failure: below the floor a match does not
  activate, and with `closed` admission and `blocked-until-active` data, nothing starts. What v1
  does not give it is the per-edge ledger — a disputed session has "we were at 94%" rather than
  "edge (player3, player7) never confirmed at T, ICE failure" — and server-controlled establishment
  ordering. For a competitive product that is a real gap; it is narrower than a preset that simply
  does not work.

## Validation

Per-slice: focused unit tests, then black-box recipes for any REST surface change in the same change
per repo rule, then the api-v1 mutation-path gates for every slice that touches the mutation path —
in practice all of 2 through 5 (slice 3 already ran them).

Whole-workstream acceptance is the design document's scenario matrix, plus one property asserted at
every slice boundary: **a group with no policy document behaves exactly as it does on `main` today.**

## Open, to settle during execution

- Pending-admission representation for `manager-approval`: extend invites, or a dedicated
  pending-membership state. Decide when slice 5 is planned; extending invites is the lower-coupling
  default.
- Rank source for `elected-by-rank`. Application-supplied member metadata is the least-coupled
  default.
- Where the epoch-pinned electorate lives (correction 4). Nothing currently records the member set
  at an epoch boundary, so slice 4 must either persist the electorate (or the election result) on
  the aggregate at each epoch-advancing transition, or define the electorate derivably. Decide at
  slice 4 planning.
