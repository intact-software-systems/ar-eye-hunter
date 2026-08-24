# Rallar Group Formation Architecture

This document describes how a Rallar group forms: the authoritative formation lifecycle a group
moves through, the policy document that drives it, how admission, the manager role, the activation
criterion, and pre-activation data gating enforce that policy server-side, what the read surface
exposes, and which black-box recipes pin each behaviour. It describes the code as it is on `main`
today; the design history lives in `playground/rtc-design/`.

The property that makes the whole layer safe to ship is this: **a group created without a
`lifecyclePolicy` is the `optimistic` preset, which is exactly the behaviour groups had before the
layer existed.** Formation collapses to zero length, the group is active at creation, admission
stays open, and application data flows. Every other preset is a departure from that default, and
every enforcement point below reads an absent policy as `optimistic`.

## Intent And Observation

A group answers three independent questions, owned by three independent layers:

| Layer                    | Question                                          | Where it lives                                                                          |
| ------------------------ | ------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Business lifecycle       | Does the group exist as a business object?        | `Group.status`: `active` / `archived` / `deleted`                                       |
| Formation intent         | What is the group supposed to be doing right now? | `Group.lifecycleState` plus the formation fields on the aggregate, driven by the policy |
| Connectivity observation | How connected is the group actually?              | The readiness fraction, computed at read time and never stored                          |

Intent is authoritative. Every change to it is an AppInbox mutation with authorization, idempotency,
and typed rejections, exactly like every other group mutation. Observation is pure: the readiness
derivation (`packages/shared/api/group-lifecycle/compute-group-formation-readiness.ts`) takes a
planned overlay, RTT evidence, and a clock, and returns a fraction. It feeds the activation
criterion and the formation view and decides nothing itself.

The one place observation influences intent is deliberately narrow: the criterion evaluator may
_petition_ a transition by enqueueing a command. That command goes through AppInbox like any other:
the compute re-checks that the transition is legal from the group's current `lifecycleState`, and
the request id pins the decision to the epoch the petition observed, so a repeated decision is an
idempotent replay and a petition that lands after the group left the transition's source states is
a `lifecycle-transition-invalid` rejection. The compute does not compare the petition's epoch with
the stored one — the epoch only dedupes — so a petition that finds the group back in a legal source
state at a later epoch is applied as written (see
[One evaluator, two producers](#one-evaluator-two-producers)). The six-state RTC activation status
projection from the design documents (`INACTIVE … FAILED`) is not implemented; only the readiness
fraction exists.

## Lifecycle States And Transitions

Formation intent has four states and four transitions
(`packages/shared/api/group-lifecycle/group-lifecycle-transitions.ts`):

```text
create (formation: phased) --> forming
create (formation: immediate) --> active

forming        -- start-establishment -->  establishing
establishing   -- activate ------------->  active
active         -- reopen-establishment ->  reconfiguring
reconfiguring  -- activate ------------->  active
establishing   -- fail-formation ------->  forming
reconfiguring  -- fail-formation ------->  forming
```

| Transition             | From                            | To              |
| ---------------------- | ------------------------------- | --------------- |
| `start-establishment`  | `forming`                       | `establishing`  |
| `activate`             | `establishing`, `reconfiguring` | `active`        |
| `reopen-establishment` | `active`                        | `reconfiguring` |
| `fail-formation`       | `establishing`, `reconfiguring` | `forming`       |

`reconfiguring` is a distinct state, not `establishing` with a flag: the read surface tells a group
that was active and is repairing its overlay apart from one that has never been active. The data
gate does not read that difference — under `blocked-until-active` both block, because
`canSendGroupMessage` tests only `lifecycleState !== 'active'` (see
[Pre-Activation Data Gating](#pre-activation-data-gating)).

A transition from any other state is the typed denial `lifecycle-transition-invalid`
(`startFromActiveIsDenied` in `api-v1-group-lifecycle-transitions`). There is no terminal failure
state: a formation that fails returns to `forming`, and the group stays joinable and retryable.

### The aggregate fields

Every group carries these required fields (`packages/shared/api/group-types.ts`), in every group
response and in every WS delta envelope:

- `lifecycleState` — `phased` formation creates the group `forming`; `immediate` formation creates
  it `active` (`create-initial-group-mutation.ts`).
- `formationEpoch` — a monotonic counter starting at `0`, advanced by every accepted transition and
  by nothing else. Joins never advance it. Manager election and the formation timers key on it.
- `formationElectorate` — the active member principal ids pinned at the last epoch boundary.
  Creation pins `[creator]`; every accepted transition re-pins it to the active roster read in the
  same mutation.
- `establishmentStartedAtEpochMs` — set by `start-establishment` and `reopen-establishment`,
  cleared to `null` by `fail-formation`, left alone by `activate`. The deadline half of the
  criterion measures from it.
- `formationAttemptCount` — incremented by `fail-formation` only.
- `lastFormationOutcome` — `null` until the criterion first decides, then the recorded decision:
  `{ outcome: 'activated' | 'activated-degraded' | 'below-floor', observedRate, atEpochMs,
  formationEpoch }`. Operator activation records nothing; only criterion-commanded transitions do.

Every transition writes the aggregate under compare-and-set, bumps `snapshotVersion`, and emits a
`group-updated` event with an empty payload. There is no lifecycle-specific event type.

### Who may command a transition

`canCommandGroupLifecycleTransition` in `packages/shared-server/rallar-system/group-policy.ts`
decides in order: the actor must be an active member (`member-not-active`, or the blocked-member
denials), then the policy's `establishment.initiator` decides authority, then the transition must be
legal from the current state.

| `initiator`   | Who may command                                                                                                                                     |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `any-member`  | Any active member.                                                                                                                                  |
| `manager`     | A resolved lifecycle manager. No manager resolves → `lifecycle-manager-unavailable`; a non-manager → `forbidden-role`.                              |
| `server-auto` | No principal, ever (`forbidden-role`), owner included. Among the presets only `drop-in-social` uses it, and its `immediate` formation never phases. |

`validateGroupLifecyclePolicy` does not reject a custom `server-auto` policy with
`formation: 'phased'`. Such a group is created `forming` and nothing can start its establishment:
the automation's only `start-establishment` is the retry after a `fail-formation`, which never fires
from `forming`.

`fail-formation` has no HTTP route and is criterion-commanded only; the mutation compute rejects it
from any principal. The criterion's own commands run under the internal authority
`formation-criterion`, which `validateTrustedAuthorityMode` limits to `activateGroup`,
`failGroupFormation`, and `startGroupEstablishment`; the first two must carry an `observedRate`,
while the retry leg's `startGroupEstablishment` carries none.

### FORMING holds planning

Only `forming` holds topology planning. `isGroupTopologyPlannableAt`
(`topology/planning/select-group-topology-planning-snapshot.ts`) is the one gate at the planning
choke point: a forming group takes the same removed-topology branch as an archived one, so no
overlay is planned or published and the server commands no dials. The browser is another matter:
with no server overlay, `WebRtcGroupManager.targetPeerIdsForGroup` falls back to the group's online
members and `computeOutboundDialPlan` dials up to `maxPeerConnections` of them, so a
presence-connected forming lobby still makes bounded bootstrap RTC attempts. Holding those is not
built (see [Not In V1](#not-in-v1)). `establishing`, `active`, and `reconfiguring` all plan.
`api-v1-group-lifecycle-transitions` pins it: `GET …/topology` is `null` or `state: 'removed'`
while forming, the `overlay.topology` hydration a forming member receives announces `removed`, and
a plan exists after `start-establishment`. The admin `reconfigureGroupTopology` path bypasses the
gate as an operator escape hatch.

The safety baseline is never phase-gated: membership mutations, presence, and WS connectivity work
in every state, including a group that never leaves `forming` (membership and presence:
`packages/tests/shared-server/group-state/group-lifecycle-safety-baseline.test.ts`; WS connectivity
while forming: the `openAliceWs` and `formingTopologyHydrationArrives` steps of
`api-v1-group-lifecycle-transitions` and the `…SendReachesAliceWhileForming` relays of
`api-v1-group-data-policy`). Phases gate establishment work and the app-visible `active` signal,
never the ability to be in the group.

### Recipes

`api-v1-group-lifecycle-transitions` walks a `managed` group with `activation.mode: 'manual'`
through `forming` → `establishing` (epoch 1) → `active` (2) → `reconfiguring` (3) → `active` (4),
pins `formationElectorate: [creator]` at creation, the non-manager denial `forbidden-role`, and the
illegal-transition denial. Manual activation is pinned there because the managed preset's default
`threshold-or-deadline` would otherwise auto-activate underneath the deterministic walk.

## The Policy Document

`GroupLifecyclePolicy` (`packages/shared/api/group-lifecycle/group-lifecycle-policy.ts`) has six
sections. Every field is required once normalized.

| Section         | Fields                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| `formation`     | `'phased'` \| `'immediate'`                                                                            |
| `manager`       | `selection`, `assignedPrincipalIds`, `count`, `succession`                                             |
| `establishment` | `transports`, `initiator`, `maxConcurrentEdgeSetups`                                                   |
| `activation`    | `mode`, `successRate`, `minimumViableRate`, `deadlineMs`, `maxFormationAttempts`, `strictConfirmation` |
| `admission`     | `mode`, `untilEpochMs`, `untilMemberCount` (`null` means the window does not apply)                    |
| `data`          | `preActivationAppData`: `'allowed'` \| `'blocked-until-active'`                                        |

Two fields are carried but enforced by nothing in v1: `establishment.transports` and
`establishment.maxConcurrentEdgeSetups` are normalized, clamped, and persisted, and no server path
reads them. Establishment pacing is whatever the browser's existing dial budget provides.

### Presets

`group-lifecycle-policy-presets.ts` defines the four presets verbatim:

| Field                             | `optimistic` | `managed`               | `match`                        | `drop-in-social` |
| --------------------------------- | ------------ | ----------------------- | ------------------------------ | ---------------- |
| `formation`                       | `immediate`  | `phased`                | `phased`                       | `immediate`      |
| `manager.selection`               | `none`       | `creator`               | `elected-random-deterministic` | `none`           |
| `manager.count`                   | 1            | 1                       | 1                              | 1                |
| `manager.succession`              | `none`       | `next-by-selection`     | `next-by-selection`            | `none`           |
| `establishment.initiator`         | `any-member` | `manager`               | `manager`                      | `server-auto`    |
| `establishment.transports`        | `rtc-and-ws` | `rtc-and-ws`            | `rtc-preferred`                | `rtc-and-ws`     |
| `maxConcurrentEdgeSetups`         | 64           | 32                      | 16                             | 64               |
| `activation.mode`                 | `manual`     | `threshold-or-deadline` | `threshold-or-deadline`        | `threshold`      |
| `activation.successRate`          | 0            | 0.95                    | 1                              | 0.8              |
| `activation.minimumViableRate`    | 0            | 0.5                     | 1                              | 0.25             |
| `activation.deadlineMs`           | 0            | 30 000                  | 20 000                         | 0                |
| `activation.maxFormationAttempts` | 1            | 3                       | 2                              | 5                |
| `admission.mode`                  | `open`       | `manager-approval`      | `closed`                       | `open`           |
| `admission.untilMemberCount`      | `null`       | `null`                  | `null`                         | 50               |
| `data.preActivationAppData`       | `allowed`    | `allowed`               | `blocked-until-active`         | `allowed`        |

`strictConfirmation` is `false` in every preset. Two preset facts are easy to misread:

- `match` elects `elected-random-deterministic`, not the design table's `elected-by-rank`, because
  no rank source exists (see [The Manager Role](#the-manager-role)). Its floor equals its success
  rate, which is how a caller asks for all-or-nothing: a session that is not fully connected does
  not start rather than starting degraded.
- `drop-in-social`'s `activation.mode: 'threshold'` never evaluates. `immediate` formation creates
  the group `active`, `server-auto` denies every principal-commanded transition, and the criterion
  only runs in `establishing` or `reconfiguring`. What the preset actually buys is the open-until-50
  admission window, which binds from creation.

### Absent policy

`CreateGroupRequest.lifecyclePolicy` is optional. When it is omitted the create command carries no
policy, the group is created `active`, and nothing is written to the policy store. Every reader
then gets `status: 'absent'` and substitutes the `optimistic` preset —
`createDefaultGroupLifecyclePolicy()` in the mutation path, the criterion evaluator, and the
formation view, and that preset's `data.preActivationAppData` value `'allowed'` in the WS data gate.
The equivalence is pinned once, not per tier: `api-v1-group-lifecycle-policy`
creates one group with `preset: 'optimistic'` and one with no policy and asserts the same formation
view and the same instant join for both.

### Normalization and clamping

Sparse input becomes a complete policy in `toNormalizedGroupLifecyclePolicy`, at the HTTP
request-to-command boundary (`group-mutation-command.ts`): the named preset — or the optimistic
default — supplies every omitted field, section by section, and every numeric field is clamped.
Clamping is silent and total, so no input produces an out-of-range document:

| Field                              | Range                         |
| ---------------------------------- | ----------------------------- |
| `manager.count`                    | 1 … 16                        |
| `maxConcurrentEdgeSetups`          | 1 … 256                       |
| `successRate`, `minimumViableRate` | 0 … 1 (non-finite → 0)        |
| `deadlineMs`                       | 0 … 600 000                   |
| `maxFormationAttempts`             | 1 … 16                        |
| `admission.untilEpochMs`           | 0 … `Number.MAX_SAFE_INTEGER` |
| `admission.untilMemberCount`       | 1 … 100 000                   |

Integers are truncated; a non-finite integer becomes the minimum.

### Validity

Contradictions between fields are a separate concern from clamping. `validateGroupLifecyclePolicy`
returns every issue at once as an `Either` and never throws:

| Issue code                                  | Rejects                                                    |
| ------------------------------------------- | ---------------------------------------------------------- |
| `manager-initiator-without-manager`         | `initiator: manager` with `selection: none`                |
| `manager-approval-without-manager`          | `admission.mode: manager-approval` with `selection: none`  |
| `assigned-selection-requires-principals`    | `selection: assigned` with an empty assigned list          |
| `manager-count-exceeds-assigned-principals` | `selection: assigned` with `count` over its non-empty list |
| `viable-rate-above-success-rate`            | `minimumViableRate > successRate`                          |
| `threshold-mode-requires-positive-rate`     | a threshold mode with `successRate <= 0`                   |
| `deadline-mode-requires-positive-deadline`  | a deadline mode with `deadlineMs <= 0`                     |
| `strict-confirmation-unsupported`           | `strictConfirmation: true` (the ledger is not implemented) |

Transient zero-manager states are legal — an assigned manager who has not joined, or managers who
all left — because invite-and-accept recovers them; only permanently granterless or initiator-less
combinations are invalid.

On the wire the rejection is untyped by recorded decision: the create returns
`400 { type: 'api-mutation-failure', code: 'app-inbox-malformed-command' }` and nothing is
persisted (`strictConfirmationIsRejected`, `managerInitiatorWithoutManagerIsRejected`, and their
`404` read-backs in `api-v1-group-lifecycle-policy`). The issue codes exist only inside the mutation
compute and the policy repository. Typing this surface is an explicit deferred item.

### Storage

The policy is its own scoped document in the runtime-state namespace
`group-state:lifecycle-policies` (`group-state/persistence/group-lifecycle-policy-repository.ts`),
written in the group-create transaction beside the aggregate. The lifecycle enum and formation
fields — small, hot, read by every admission and activation decision — live on the aggregate so they
serialize with membership under compare-and-set; the policy is cold and near-static, so the residual
staleness of a separate read is tolerable.

There is no policy-update surface in v1. The document is written once at creation and every field is
effectively immutable.

A read has three outcomes: `absent`, `present`, or `corrupt` (identity mismatch, not an object, or no
longer coherent under `validateGroupLifecyclePolicy`). `absent` is the optimistic default.
`corrupt` fails closed at every consumer: a transition is rejected, a join or grant is rejected, the
data gate blocks, the criterion evaluator returns no command, and the formation view resolves no
managers. An unreadable stored policy never reads as permissive.

## Admission

Admission is a consent-and-timing overlay on the existing join gate. `joinMode` remains the
credential — how a principal proves entitlement (`open`, `invite-only`, `code`) — and
`canJoinGroup` in `group-policy.ts` still runs first with its business-status guard, blocked-member
denials, and `maxMembers` cap. Only a join that passes it reaches the admission decision.

### The decision

`computeGroupAdmissionDecision` (`packages/shared/api/group-lifecycle/compute-group-admission-decision.ts`)
is pure over the admission policy, the lifecycle state, the active member count, whether the
principal holds an unexpired invite, and the clock. It decides in a fixed order:

1. `untilEpochMs` reached → deny `group-admission-deadline-passed`.
2. `untilMemberCount` reached (`activeMemberCount >= untilMemberCount`) → deny
   `group-admission-capacity-reached`.
3. `mode: open` → admit.
4. `mode: closed` → admit while `forming`, otherwise deny `group-admission-closed`.
5. `mode: manager-approval` → admit if invited, otherwise park.

The windows are decided first because they degrade any mode to closed once they pass.

### Binding phases

Admission binds on entry to the phase it names, not on activation, which is what keeps a group that
never activates honest about its limits:

| Mode or window                     | Binds                                                                             |
| ---------------------------------- | --------------------------------------------------------------------------------- |
| `manager-approval`                 | every state, from creation                                                        |
| `untilEpochMs`, `untilMemberCount` | every state, from creation                                                        |
| `closed`                           | every state except `forming`: the roster freezes when establishment begins, and a |
|                                    | below-floor return to `forming` re-opens the lobby                                |

`api-v1-group-admission-windows` pins each row: `untilMemberCount: 1` on a `phased` group that never
activates denies the second join (`capacityWindowBindsWithoutActivation`); a leave under the window
re-opens it (`leaveReopensTheCapacityWindow`); an elapsed `untilEpochMs` denies
(`deadlineWindowClosesJoins`) and an open one admits; `closed` admits while forming
(`closedAdmitsWhileForming`), denies during establishment and after activation, and admits again
after a below-floor return (`belowFloorReopensTheLobby`). `api-v1-match-preset` pins the same
`closed` behaviour composed with the rest of the match preset.

### `pending`: the consent-mirror of `invited`

Membership completion is two consents. An `invited` row is the group's consent waiting for the
principal's; a `pending` row is the principal's consent waiting for the group's. `pending` is the
sixth `GroupMemberStatus` (`'invited' | 'pending' | 'active' | 'left' | 'removed' | 'banned'`),
with `joined: null`, never client-suppliable, computed only by the admission decision. Parking emits
`member-admission-requested`.

Because every existing `status === 'active'` filter excludes it, a pending member cannot connect
presence, send room messages, count toward `activeMemberCount` or the admission windows, enter the
formation electorate, or resolve as a manager. Their read visibility is the invite tier: a full
snapshot read is denied `group-policy-denied` with `details.visibility: 'invite'`
(`pendingReadVisibilityIsLimited`).

**Both join surfaces take the same decision.** The join route and self-upsert activation
(`PUT …/members/{self}` with `status: 'active'`) both resolve through `resolveAdmittedMemberStatus`
(`compute-group-admission-mutation.ts`), so parking cannot be bypassed by switching endpoints. A
parked joiner's response is `200` with a redacted snapshot (`toPendingMemberGroupSnapshot`): their
own row only and `activeSessions` emptied, at the join, invite-accept, and self-upsert responses.

**An invite bypasses parking only.** An unexpired invite is the group's consent, so acceptance
lands `active` under `manager-approval` — but the windows and `closed` still bind on accept:
`acceptGroupInvite` runs through `computeJoin`, whose `resolveAdmittedMemberStatus` derives `invited`
from the unexpired `invited` row, and `computeGroupAdmissionDecision` checks the windows and `closed`
before it consults the invite. (The explicit `invited: true` re-check,
`assertGroupAdmissionWindowsOpen`, runs on grant and on governance activation.) Inviting a pending
principal moves their row to `invited`, so their accept admits instead of re-parking.

**An already-active member never re-enters admission.** `computeJoin` returns a no-op for an active
row before the decision runs, and self re-upsert resolves admission only when the existing row is
not already active, so re-assertion can never demote an active member to `pending` or window-deny
them. Governance activation of another principal re-checks the windows explicitly under the same
not-already-active guard.

### Grant and decline

`POST …/admissions/{principalId}/grant/requests/{requestId}` and `…/decline/…` are manager-only:
`canDecideGroupAdmission` requires an active actor and resolves the lifecycle managers with the same
pure function the transitions use. Governance is not widened on the admission routes — an owner who
is not a manager gets `forbidden-role` (`nonManagerGrantIsForbidden`), a zero-manager group gets
`lifecycle-manager-unavailable` (`nobodyCanGrantWithZeroManagers`), and a pending member trying to
grant themselves is not active (`member-not-active`, `pendingMemberCannotGrantThemselves`).
Governance keeps its own surface instead: an active owner or admin upserting another principal's
membership to `active` (`PUT …/members/{principalId}`) moves a `pending` row to `active` under
`canGovernGroupMember`, with the cap and the windows re-checked — the same grant, expressed through
the existing governance route.

A grant is the group's consent landing second, in a fresh AppInbox attempt: the `maxMembers` cap
and the admission windows are re-checked at grant time rather than trusted from the parking-time
decision, and the row moves
`pending → active` with a `member-joined` event whose payload names the admitted principal
(`grantEmitsMemberJoined`). Granting a row that is not pending is rejected; granting an already
active row is a no-op. A decline mirrors invite revocation: the row lands `left` with
`member-left`, so the principal may request again (`declinedPrincipalMayRequestAgain`); `banned`
remains the keep-out tool. There is no pending TTL.

**Zero-manager recovery is governance's own consent channel.** A `managed`-preset group overridden
to `manager.selection: 'assigned'` whose assigned manager has not joined parks every join and can
grant none of them; the owner invites the parked
principal, the principal accepts, and the manager resolves (`joinParksWithZeroManagers` through
`recoveredManagerResolvesInTheView` in `api-v1-group-admission-approval`).

**A pending admission survives epoch advances by construction.** Transitions write the aggregate and
never touch member rows, and the pending row records no epoch because it is a consent, not a
formation fact. Grant authorization is evaluated at grant time against the current electorate and
epoch. The approval recipe parks a join in `forming`, drives `start-establishment` and an automatic
single-member activation (epoch 2), asserts the row is still `pending`, then grants it in the later
epoch (`pendingAdmissionSurvivedTwoEpochAdvances`, `grantLandsInTheLaterEpoch`). A join while
`active` parks too (`joinWhileActiveParksPending`).

## The Manager Role

A manager is a client role with different authorizations, enforced server-side at mutation
boundaries. It is never a distributed-systems coordinator, it holds no lease, and its liveness is
membership, not heartbeats. The session-scoped browser work delegate (`appointDirector`) is a
different thing and is unchanged.

### Resolution

`resolveGroupLifecycleManagers` (`packages/shared/api/group-lifecycle/resolve-group-lifecycle-managers.ts`)
is pure over the manager policy, the owner, the recorded `formationElectorate`, the
`formationEpoch`, the scoped group key, and the set of currently active principal ids. Every replica
answers identically without coordination. It ranks, then applies succession:

| `selection`                    | Ranking                                                                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `none`                         | empty                                                                                                                                                        |
| `creator`                      | the owner first, then the epoch-pinned election ranking of the electorate without the owner — so succession continues into it                                |
| `assigned`                     | `assignedPrincipalIds` in declared order; `count` takes from it                                                                                              |
| `elected-random-deterministic` | the electorate sorted by descending `rendezvousScore('epoch:<formationEpoch>', principalId, groupKey)` — highest score first, ties by ascending principal id |
| `elected-by-rank`              | empty — the rank source is `null` everywhere in v1, so it resolves zero managers rather than guessing                                                        |

Succession is operation order, not a mechanism: `next-by-selection` filters the ranking to active
members _before_ taking `count`, so successors fill; `none` takes `count` first and filters after,
so departures leave holes, never successors. A departed manager simply stops matching the active
filter — departure needs zero extra writes.

### The epoch-pinned electorate

Election ranks the recorded electorate, never live membership, because a deterministic hash over
live members would elect a different manager as people join — exactly while the manager is who must
trigger establishment. The electorate is re-pinned only by accepted transitions. One consequence is
deliberate: a `phased` group's epoch-0 electorate is `[creator]`, so elected selection collapses to
the creator for the first establishment (`electionResolvesTheCreator` in `api-v1-match-preset`);
genuine election begins at the first epoch advance, when the electorate is the members present.

### What manager absence blocks

Manager absence blocks only manager-assigned actions — `initiator: manager` transitions and
admission decisions (grant and decline) — never group safety. `api-v1-group-manager-succession`
pins the role under an `assigned` policy: the non-manager owner is denied (`forbidden-role`), the
assigned manager
establishes, removing the manager passes duty to the next assigned member who completes the phase,
a manager leaving mid-establishment passes duty the same way, a group whose sole manager left
mid-establishment shows `managerPrincipalIds: []` and denies `activate` with
`lifecycle-manager-unavailable` while joins still work, and joining the assigned member restores the
manager.

## Readiness And The Activation Criterion

### Readiness

`computeGroupFormationReadiness` returns `{ plannedEdgeCount, observedEdgeCount, observedRate }`.
Planned edges are the undirected edges of the stored overlay's `nextHopsBySessionId`, skipping
self-hops. An edge is observed when an RTT measurement between its endpoints — in either direction —
has `createdAtEpochMs` within the evidence freshness window, `DEFAULT_FORMATION_EVIDENCE_FRESHNESS_MS`
= 60 000 ms (a server default, not a policy knob). The rate is observed ÷ planned.

Zero planned edges is trivially ready (rate `1`): a single-member group, whose plan has no edges,
activates per its criterion without waiting on establishment (`singleMemberMeshAutoActivates`,
`singleMemberClosedGroupActivates`). A removed stored plan also has zero edges, which is why the
damped edge-trigger below refuses to petition from one. The formation view reports rate `1` when no
plan is stored at all.

Evidence is the RTT measurement set the planning authority reads for the group's active sessions:
`RtcRttRepository.listMeasurementsForSessionIds` over the runtime-state repository, whichever SQL
backend (PGlite in memory or Postgres) backs it; the process-global RTT repository is only the
fallback for a server composed without an `rttRepository`, which api-v1 never is. Only planned edges
count, so evidence accepted for another room the pair shares is
ignored unless that edge is also planned here. After activation, live `readiness` legitimately
decays toward `0` as evidence ages past the window; the durable truth is `lastFormationOutcome`.

### The criterion

`evaluateGroupActivationCriterion` (`evaluate-group-activation-criterion.ts`) is pure over the
activation section, the observed rate, `establishmentStartedAtEpochMs`, `formationAttemptCount`, and
the clock, and decides in this order:

1. `mode: manual` → `wait`. Activation is then an operator command.
2. A threshold mode (`threshold`, `threshold-or-deadline`) with `observedRate >= successRate` →
   `activate`.
3. No deadline mode (`deadline`, `threshold-or-deadline`), or no establishment anchor → `wait`.
4. Before the deadline (`establishmentStartedAtEpochMs + deadlineMs`) → `wait`.
5. At or after it: `observedRate >= successRate` → `activate`; `>= minimumViableRate` →
   `activate-degraded`; below the floor → `below-floor`.

Two rates rather than one: at or above `successRate` the group activates, at or above
`minimumViableRate` at the deadline it activates degraded, and below the floor it does not activate
at all. A single rate cannot distinguish a group that is usably connected from one that is not —
`activate-degraded` at 5% would declare a group active that cannot carry the application's data.
Setting the floor equal to the success rate asks for all-or-nothing.

Below the floor, `fail-formation` returns intent to `forming`, records
`lastFormationOutcome.outcome: 'below-floor'` with the observed rate, increments
`formationAttemptCount`, and — while `formationAttemptCount < maxFormationAttempts` — schedules the
next attempt under backoff: `computeFormationRetryBackoffMs(n) = min(5 000 × n, 60 000)`, where `n`
is the just-incremented `formationAttemptCount`, so the second attempt starts 5 s after the first
failure and the third 10 s after the second. When the attempts are exhausted the group rests in
`forming`. That rest is not terminal: the
transition table has no attempt check, so a manager may `start-establishment` again by hand; only
the automatic retry is bounded. `api-v1-match-preset` pins a lobby whose edges never confirm
exhausting both attempts and re-opening as a joinable lobby (`allOrNothingFloorReturnsToForming`,
`honestFailureReopensTheClosedLobby`).

### One evaluator, two producers

`computeFormationCriterionCommand`
(`packages/shared-server/rallar-system/topology/replay/compute-formation-criterion-command.ts`)
is the single evaluation function: it returns `null` unless the group is `establishing` or
`reconfiguring`, reads the policy (corrupt → `null`; absent → optimistic, whose `manual` mode waits),
derives readiness from the supplied plan and evidence, evaluates the criterion, and returns the
command it asks for — `activateGroup` with `observedRate` and a `degraded` flag, or
`failGroupFormation` with `observedRate` — or `null`. Two producers call it.

**The evidence leg** is the RTC topology work handler (`create-rtc-topology-work-handler.ts`).
After every planning pass that computes a plan — group-revision work and RTT-refresh work alike — it
petitions the criterion with the just-planned overlay and the authority's evidence, before the
unchanged-graph gate. It costs nothing while no work arrives and petitions with zero lag on every
pass that computes a plan; RTT-refresh items the refinement gate defers reach the criterion only
through the damped edge-trigger below.

**The threshold edge-trigger.** RTT-refresh work whose replan the refinement gate defers
(`RtcRttRefinementGate`: a replan only when accumulated Vivaldi movement crosses the delta threshold
and the per-group interval floor has elapsed — 5 ms and 30 s by default, overridable with
`RALLAR_RTC_TOPOLOGY_RTT_VIVALDI_DELTA_MS` and `RALLAR_RTC_TOPOLOGY_RTT_REFINEMENT_MIN_INTERVAL_MS`)
does not compute a plan, so it would not petition — and under a
burst of reports the measurement that carries the group across its threshold is exactly the one
deferred. `createDeferredCriterionPetitioner` closes that gap: a deferred item for an `establishing`
group with an active stored plan petitions at most once per
`DEFAULT_DEFERRED_CRITERION_PETITION_MIN_INTERVAL_MS` = 1 000 ms per group, process-locally; damped
requests arm one trailing timer per group, because the crossing measurement lives at the burst's
tail by construction. The trailing petition re-reads the stored plan and petitions only if it is
still active; it is best-effort and only warns on failure. Two bounds are deliberate: it petitions
for `establishing` only — a `reconfiguring` group under refinement-deferred work waits for the next
computed plan or the deadline — and a removed stored plan never petitions, since its empty edge set
would read as trivially complete.

**The time leg** exists because deadline expiry generates no evidence. The transitions arm it
themselves (`computeFormationTimerEntries` in `formation-timer-outbox-entry.ts`), in the same
AppInbox transaction: entering `establishing` or `reconfiguring` under a deadline mode writes one
`FORMATION_TIMER` app-outbox entry due at `now + deadlineMs`; a below-floor return with attempts
remaining writes one `retry` entry due after the backoff. Entries are inserted with
`dequeueAudit.nextTs` at their due time, so every queue backend holds them invisible until then —
native scheduling, no polling or requeue loop — and each carries the post-transition
`formationEpoch`. The consumer (`create-formation-timer-work-handler.ts`) throws if an entry is not
yet due (clock-skew defence; the retry release walks it forward), drops it if the group is gone or
its epoch moved on, and then: a `retry` entry for a `forming` group submits `startGroupEstablishment`
under `formation-criterion` authority; a `deadline` entry for an `establishing` or `reconfiguring`
group reads the planning authority and the stored plan and runs the same evaluation function. If no
plan is stored at deadline time the entry does nothing.

**Racing producers replay instead of double-transitioning.** Criterion command ids are
deterministic per decision and epoch —
`formation-criterion:v1:<activate|activate-degraded|fail-formation|retry-establish>:<groupRef+epoch>`
— and serve as the AppInbox request id, so the evidence leg and the time leg reaching the same
conclusion produce one transition: the later petition is an idempotent replay when it carries the
identical `observedRate` (the stored receipt is compared by the hash of the whole command, not only
its id) and otherwise a typed idempotency-conflict rejection, never a second transition. A petition
that lands after the group left the transition's source states is a `lifecycle-transition-invalid`
rejection the mutation compute absorbs. The compute does not compare the petition's epoch with the
stored one, so the one window left open is a petition that waits in the queue while the group cycles
back into a legal source state at a later epoch — `establishing` → `forming` → `establishing` under
the retry backoff, or `active` → `reconfiguring` by operator command — and is then applied with the
older evidence.

The deadline is the correctness backstop: whatever the evidence leg misses, the deadline evaluation
decides. Under bursty evidence the edge-trigger moves activation from "at the next deadline
evaluation" to "within about a second of crossing the threshold"; it does not replace the deadline.

### Recipes

`api-v1-group-formation-criterion` pins both legs: a single-member `threshold` group auto-activates
from the trivially ready zero-edge plan its own establishment planning pass produces, with no RTT
evidence involved (epoch 2, `outcome: 'activated'`, rate 1); a `deadline` group with
`minimumViableRate: 1` and two presence-connected members fails below the floor at its 3 s deadline
(`forming`, attempt count 1, `outcome: 'below-floor'`, rate 0); a `deadline` group with floor 0 and
two presence-connected members activates degraded at the deadline; and a `threshold-or-deadline`
group with two presence-connected members holds at `observedEdgeCount: 0` until a single RTT report
over WS on its planned edge activates it (`thresholdActivatesOnObservation`). The managed
burst tiers (below) pin threshold activation under an all-pairs RTT burst at 20 and 50 sessions.

## RTT Evidence And The Reporting Degree Limit

Readiness only counts evidence the server accepted. RTT acceptance (`rtc-rtt-measurement-policy.ts`)
rejects a report whose pair is not a reporting edge for every shared active group or whose
acceptance would put either endpoint over the reporting degree limit. Planning filters stored
measurements through the same reporting-edge policy before it uses them.

Both must agree on the limit, per group. Before the managed burst tiers existed, acceptance used the
server-wide default (`5`) while planning honoured a group's configured topology `degreeLimit`, so a
group configured above the default planned edges whose evidence was never stored and readiness
stalled. Today acceptance resolves the limit exactly as the read-side planning filter does. The
durable AppInbox RTT mutation composed in
`apps/api-v1/src/composition/create-api-v1-topology-services.ts` — the path api-v1 takes for every
report on every SQL backend, because its system-topic installer always declares the durable topology
repositories — resolves the group's effective topology configuration under the server reporting
option (`readRttReportingDegreeLimit`), so a configured `RALLAR_RTC_RTT_REPORTING_DEGREE_LIMIT` still
wins and otherwise the group's effective `degreeLimit` is the limit; the in-memory topic branch in
`init-rtc-rtt-topic.ts` resolves it the same way through the `readGroupRttReportingDegreeLimit` hook
in `init-rtc-rtt-topic.ts`, for compositions without durable topology repositories. A report whose
endpoints both hold live sessions in several groups is accepted under the largest of those groups'
limits. The managed burst recipes rely on this by raising the group's topology `degreeLimit` (24 at
N=20, 54 at N=50) before the burst. `docs/rallar-rtc-rtt-reporting.md` owns the wider reporting
flow.

## Pre-Activation Data Gating

`data.preActivationAppData: 'blocked-until-active'` gates WS-relayed, room-scoped application data
until the group's `lifecycleState` is `active`. It is one added denial at the existing per-message
predicate: `canSendGroupMessage` in `group-policy.ts` denies `group-data-blocked-until-active` when
the resolved value is `blocked-until-active` and the group is not `active` — so `forming`,
`establishing`, and `reconfiguring` all block, which is the meaning `reconfiguring` exists to carry.

The room authorizer (`rallar-system/websocket/ws-topic-room-authorizer.ts`, composed in
`apps/api-v1/src/services/ws-topic-room-authorizer.ts`) supplies the value lazily: it reads the
policy only when the group is not `active`, so steady-state room traffic pays no policy read. An
absent policy is `allowed` (main parity); a corrupt one is `blocked-until-active` (fail closed).

The CRDT live topics `room.crdt` and `app.crdt` are exempt by name at the authorizer. CRDT `update`
envelopes are never relayed by the topic — they enter the AppInbox append path and fan out from its
commit — while the peer sync envelopes (`sync-request`, `sync-response`, `catch-up-response`) are
relayed live, so the exemption lets CRDT sync traffic flow before activation; collaborative documents
are lobby-phase workspace, not the competitive pre-match traffic the gate exists to hold back. Out of
scope and unchanged: RTC data-channel traffic (`realtime.room` is peer-to-peer; the server only
signals), presence (an HTTP mutation, never a WS topic), and the reserved state-sync, signaling,
`overlay.topology`, and `rtt` system topics, whose feature installers register them before the
user-topic router and which activation needs.

On the wire the denial is the generic NACK: the room authorizer maps every policy denial to reason
`unauthorized`, and the `group-data-blocked-until-active` code never leaves the server — it appears
only in the authorizer's rejection log line. No HTTP route supplies `preActivationAppData` to
`canSendGroupMessage`, so no HTTP response carries it either; it exists only in the
`GroupPolicyReasonCode` vocabulary. `api-v1-group-data-policy` pins the gate end to end: a
`room.match` send before activation is NACKed `unauthorized` and never reaches the other member, a
`room.crdt` sync request flows while blocked, `allowed` groups and groups whose policy omits the
`data` section (normalized to `allowed`) relay during `forming`
(`allowedSendReachesAliceWhileForming`, `defaultDataSendReachesAliceWhileForming`), and a fresh
`room.match` send flows once the manager activates the blocked group (`activatedSendReachesAlice`).
The authorizer's absent-policy branch has no recipe pin: an absent policy creates the group
`active`, so the gate reads it only after a `reopen-establishment`. `api-v1-match-preset` pins the
lobby NACK and the post-activation flow composed with the rest of the preset;
`api-v1-drop-in-social-preset` pins data flowing from birth.

## Read Surface

### Group snapshot

Every group response — point reads, lists, mutation responses, and the WS `GroupStateDeltaEnvelope`
— carries the six formation fields listed under
[The aggregate fields](#the-aggregate-fields). They are required in the OpenAPI `Group` schema.
Browser code receives them in every group snapshot and delta envelope it already consumes — the
shared validators require all six — and exposes them as `GroupSnapshot.group`; nothing in
`shared-web` reads them beyond validation today, and there is no dedicated browser facade operation
for the lifecycle.

### The formation view

`GET /api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/formation`
(`apps/api-v1/src/routes/group-formation-view-read.ts`, registered beside the topology routes)
returns `GroupFormationView`: authoritative intent beside derived observation, enough for an
application to explain the group to a user.

| Field                                                                                                                | Source                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `groupRef`                                                                                                           | the route path's `{ applicationId, workspaceId, groupId }`, echoed so the view names the group it describes   |
| `lifecycleState`, `formationEpoch`, `formationAttemptCount`, `lastFormationOutcome`, `establishmentStartedAtEpochMs` | the aggregate                                                                                                 |
| `readiness`                                                                                                          | computed at read time from the stored plan and the authority's evidence; `{ 0, 0, 1 }` when no plan is stored |
| `managerPrincipalIds`                                                                                                | `resolveGroupLifecycleManagers` at read time over the active roster; `[]` when the policy is corrupt          |

Like the other group reads, the route applies full-visibility authorization — active members only,
so a pending member cannot read it — when `RALLAR_STATE_STRICT_READ_AUTH` is enabled, which the
black-box runner sets and the production hardening checklist requires; without the flag
`/api/state/*` is authenticated but not membership-filtered.

### Events

Lifecycle transitions emit `group-updated` with an empty payload. The admission-specific event is
`member-admission-requested`. Every `member-*` event names the member it is about in
`payload.principalId` — a manager's grant emits `member-joined` with the manager as `actor` and the
admitted member in the payload — and `ownership-transferred` carries `fromPrincipalId` and
`toPrincipalId`. The HTTP event routes and the `groupStateEvent` WS topic deliver them.

### Routes and their failures

| Route                                                              | Body                              | Success                                  |
| ------------------------------------------------------------------ | --------------------------------- | ---------------------------------------- |
| `POST …/groups/requests/{requestId}` with `lifecyclePolicy`        | `GroupLifecyclePolicyInput`       | `201` snapshot                           |
| `POST …/groups/{groupId}/lifecycle/establish/requests/{requestId}` | `GroupLifecycleTransitionRequest` | `200` snapshot, `forming → establishing` |
| `POST …/lifecycle/activate/requests/{requestId}`                   | same                              | `200` snapshot, `→ active`               |
| `POST …/lifecycle/reopen/requests/{requestId}`                     | same                              | `200` snapshot, `active → reconfiguring` |
| `POST …/admissions/{principalId}/grant/requests/{requestId}`       | `GrantGroupAdmissionRequest`      | `200` snapshot, member `active`          |
| `POST …/admissions/{principalId}/decline/requests/{requestId}`     | `DeclineGroupAdmissionRequest`    | `200` snapshot, member `left`            |
| `GET …/groups/{groupId}/formation`                                 | —                                 | `200 GroupFormationView`                 |

On the mutation routes, policy denials are typed `403 { type: 'api-mutation-failure', code, status }`
with the `GroupPolicyReasonCode` (`forbidden-role`, `lifecycle-manager-unavailable`,
`lifecycle-transition-invalid`, `group-admission-closed`, `group-admission-deadline-passed`,
`group-admission-capacity-reached`, `member-not-active`, …). The read routes use their route
family's plain `{ error, code, message, … }` error shape instead, with the same codes.
Policy-validity rejections at creation are the generic `400 app-inbox-malformed-command`. Over WS,
every policy denial is the generic NACK reason `unauthorized`.

## Verification Model

### Unit matrices

The pure core is pinned in `packages/tests/shared/`: `group-lifecycle-policy.test.ts`
(normalization, clamps, the validity matrix including the `none` + `manager` deadlock),
`group-lifecycle-transitions.test.ts`, `group-activation-criterion.test.ts`,
`group-formation-readiness.test.ts`, `group-admission-decision.test.ts`, and
`group-lifecycle-managers.test.ts`. The server side is pinned in `packages/tests/shared-server/`:
`group-policy.test.ts`, `group-create-lifecycle-policy.test.ts`,
`group-lifecycle-policy-repository.test.ts`, `group-state/group-lifecycle-command-policy.test.ts`,
`group-state/group-lifecycle-safety-baseline.test.ts`,
`group-state/mutation/group-lifecycle-mutation.test.ts`,
`group-state/mutation/group-admission-mutation.test.ts`, `rtc-topology-outbox-work.test.ts` (the
damped edge-trigger; the computed-plan petition and the formation-timer handler have no unit test
and are pinned by `api-v1-group-formation-criterion`), and
`rallar-system/topology/planning/group-topology-planning-service.test.ts` (the FORMING gate). The
data gate is pinned in `apps/api-v1/test/services/ws-topic-room-authorizer.test.ts`.

### Recipes and profiles

Every recipe exercising lifecycle behaviour names the policy it tests. The nine single-server
recipes live in `packages/shared-test/black-box-runner/tests/api-v1/` and sit in the
`api-v1-black-box` and `api-v1-black-box-recipes` profiles of `recipe-matrix.json`, so the memory
backend runs them in the fast loop and the Postgres CI job runs them in its base phase:

| Recipe                               | Pins                                                                                                                                                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api-v1-group-lifecycle-policy`      | a preset with overrides is accepted; absent ≡ explicit `optimistic`; the two validity `400`s                                                                                                                                    |
| `api-v1-group-lifecycle-transitions` | the three HTTP transition commands through four epoch advances (`fail-formation` is criterion-only and pinned by the criterion, windows, and match recipes), FORMING holds planning, non-manager and illegal-transition denials |
| `api-v1-group-formation-criterion`   | threshold, deadline, degraded, and evidence-driven activation                                                                                                                                                                   |
| `api-v1-group-manager-succession`    | assigned managers, succession on removal and on leave, the zero-manager fallback                                                                                                                                                |
| `api-v1-group-admission-approval`    | parking, grant, decline, re-request, zero-manager recovery, epoch survival, park while active                                                                                                                                   |
| `api-v1-group-admission-windows`     | the binding phases of capacity, deadline, and `closed`                                                                                                                                                                          |
| `api-v1-group-data-policy`           | the data gate, the CRDT exemption, `allowed` and absent flows, post-activation flow                                                                                                                                             |
| `api-v1-match-preset`                | the composed `match` preset, including all-or-nothing failure and lobby re-opening                                                                                                                                              |
| `api-v1-drop-in-social-preset`       | the composed `drop-in-social` preset                                                                                                                                                                                            |

A recipe sits in exactly one of the profiles a single Postgres CI job runs: the job runs the base
profile and then the cluster profile against the same servers under one run id, and a recipe in
both replays its request ids with fresh login sessions and self-conflicts on idempotency.

### Scale tiers

`api-v1-group-formation-managed-burst-medium` (N=20) and `-large` (N=50) are runner-process WS
clients, not browsers: 20 or 50 identities join a `preset: 'managed'` group with `admission.mode:
'open'`, the creator-manager establishes, readiness holds at zero observed edges, an all-pairs RTT
burst covers every planned mesh edge, and activation fires only at threshold (`outcome:
'activated'`). Their deadlines sit at the 600 s clamp while the activation poll is bounded to 60 s
(N=20) and 90 s (N=50) at a one-second cadence, which is what pins the edge-trigger structurally:
activation has to come from evidence, not from the deadline evaluation.

Both tiers are opt-in, in the `api-v1-black-box-formation-large` profile beside the optimistic
large tier, because a synthetic worst-case burst cannot share a server with recipes asserting a
clean evidence counter: on a shared Postgres runner the burst produced one contention-driven
terminal mutation failure, which broke the unrelated `api-v1-admin-operations` recipe asserting
the server-global `atomicCompletionFailures` counter is zero.

The optimistic baseline tiers (`api-v1-group-formation-burst-small|medium|large` at 6/20/50) and
`-churn-large` carry `preset: 'optimistic'` and are the formation-burst scenario; the
`api-v1-black-box` profile holds small and medium.

### The mutation-path gate

Every change to the join path, the transition commands, or the criterion machinery is a mutation-path
change and runs `npm run test:api-v1:black-box:postgres:medium-scale` unweakened, per the repository
rule in `docs/rallar-convergent-state-and-rtc-topology.md`.

### Observed limits

Recorded at the scale tiers and not fixed, because real heartbeat-cadence reporting hits neither:

- Planned mesh edges grow linearly, not quadratically: the planner builds the mesh by k-insert
  (`K_INSERT_MC`: in canonical member order each session after the first attaches to its
  `meshParamK` best-ranked already-inserted members under the degree limit; `meshParamK` defaults
  to `2`), so the plan carries 2N − 3 edges — 37 at 20 sessions and 97 at 50. The tiers still
  exercise planning, acceptance, and readiness bookkeeping at those session counts, and all-pairs
  _reporting_ remains the coverage guarantee.
- An all-pairs RTT burst can exhaust the 20-attempt optimistic retry schedule of one RTT mutation
  under 19-writer endpoint contention.
- Before the edge-trigger landed, threshold activation under bursty evidence waited for the
  deadline evaluation because the evidence-leg petition rode the refinement gate's debounce. The
  edge-trigger closes that for `establishing` groups; the deadline remains the backstop.

## Not In V1

Deliberately not built, each recorded in the control-plane plan's deferred list or found while
writing this document:

- **Typed policy-validity rejections over HTTP.** Every incoherent create is the generic
  `400 app-inbox-malformed-command`; the issue codes never reach the response.
- **Typed WS NACK reasons.** Every policy denial over WS is `unauthorized`; the admission codes are
  typed on HTTP only, and the data-gate code reaches no wire at all.
- **A validity rule for `server-auto` with `phased` formation.** The combination is accepted at
  creation and produces a group nothing can establish.
- **Per-edge confirm-or-fail establishment.** `strictConfirmation: true` is rejected at creation.
  The `match` preset therefore has no per-edge audit trail — a disputed session has "we were at
  94%" rather than "edge (A, B) never confirmed at T" — and no server-controlled establishment
  ordering.
- **The six-state RTC activation status projection.** Only the readiness fraction exists.
- **The `elected-by-rank` rank source.** The selection is in the vocabulary and resolves zero
  managers; `resolveGroupLifecycleManagers` already takes `rankByPrincipalId`, so the remaining work
  is a `GroupMember` rank field, its join plumbing, and switching the `match` preset back.
- **A policy-update surface.** The document is written once at creation; per-field mutability
  declarations land with the first update surface.
- **Enforcement of `establishment.transports` and `establishment.maxConcurrentEdgeSetups`.** Both
  are recorded and unread; establishment pacing is the browser dial budget.
- **A pending-admission TTL.** Parked rows persist until granted, declined, withdrawn, or governed.
- **Bootstrap suppression while `forming`.** The server plans nothing, but the browser's bounded
  bootstrap still dials online members whenever no server overlay exists, so discovery is not yet
  dial-free; the product plan in `playground/rtc-design/2026-08-22-group-activation-product-plan.md`
  records the held-layout stages that close this.
- **Distributed (Hetzner) lifecycle artifacts.** The recipes above are api-v1 black-box recipes
  against the real server; the distributed lane carries no lifecycle manifest.

## Source Map

- `packages/shared/api/group-lifecycle/`: the policy contract and issue codes
  (`group-lifecycle-policy.ts`), presets (`group-lifecycle-policy-presets.ts`), normalization and
  clamps (`to-normalized-group-lifecycle-policy.ts`), validity
  (`validate-group-lifecycle-policy.ts`), the transition table
  (`group-lifecycle-transitions.ts`), the admission decision
  (`compute-group-admission-decision.ts`), readiness (`compute-group-formation-readiness.ts`), the
  criterion and backoff (`evaluate-group-activation-criterion.ts`), manager resolution
  (`resolve-group-lifecycle-managers.ts`), and the view contract (`group-formation-view.ts`).
- `packages/shared/api/group-types.ts` and `group-policy-types.ts`: the aggregate fields, the
  `pending` member status, event types, and the `GroupPolicyReasonCode` vocabulary.
- `packages/shared-server/rallar-system/group-policy.ts`: the gates — `canJoinGroup`,
  `canCommandGroupLifecycleTransition`, `canDecideGroupAdmission`, `canSendGroupMessage`.
- `packages/shared-server/rallar-system/group-state/mutation/aggregate/compute-lifecycle-transition.ts`:
  the transition compute, electorate re-pin, outcome recording, and timer arming.
- `packages/shared-server/rallar-system/group-state/mutation/membership/compute-group-admission-mutation.ts`
  and `compute-group-membership-mutation.ts`: the landing status, grant, decline, and both join
  surfaces.
- `packages/shared-server/rallar-system/group-state/formation-timer-outbox-entry.ts` and
  `group-formation-mutation-command.ts`: the `FORMATION_TIMER` entries and the idempotent criterion
  commands.
- `packages/shared-server/rallar-system/group-state/persistence/group-lifecycle-policy-repository.ts`:
  policy storage and the absent/present/corrupt read.
- `packages/shared-server/rallar-system/topology/replay/compute-formation-criterion-command.ts`,
  `create-rtc-topology-work-handler.ts`, `create-formation-timer-work-handler.ts`: the evaluator, the
  evidence-leg petition and the damped edge-trigger, the planning work handler that calls them, and
  the time leg.
- `packages/shared-server/rallar-system/topology/planning/select-group-topology-planning-snapshot.ts`:
  the FORMING planning gate.
- `packages/shared-server/rallar-system/rtc-rtt/policy/rtc-rtt-measurement-policy.ts`,
  `apps/api-v1/src/composition/create-api-v1-topology-services.ts`,
  `packages/shared-server/rallar-system/rtc-rtt/topic/install-rtc-rtt-system-topic.ts`: RTT
  acceptance and the per-group reporting degree limit.
- `packages/shared-server/rallar-system/websocket/ws-topic-room-authorizer.ts` and
  `apps/api-v1/src/services/ws-topic-room-authorizer.ts`: the data gate and the CRDT exemption.
- `apps/api-v1/src/group-state/register-group-state-mutation-routes.ts`,
  `register-group-admission-routes.ts`, `apps/api-v1/src/routes/group-formation-view-read.ts`, and
  `apps/api-v1/resources/api-v1-openapi.yaml`: the HTTP surface.
- `packages/shared-test/black-box-runner/tests/api-v1/`: the recipes named above, with profile
  placement in `packages/shared-test/black-box-runner/recipe-matrix.json`.
- `playground/rtc-design/2026-08-17-group-lifecycle-control-plane-implementation-plan.md` and its
  companion analyses: the decision record behind this design.
