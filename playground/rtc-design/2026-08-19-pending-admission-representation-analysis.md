# Pending Admission and the Slice 5 Gates — Analysis (2026-08-19)

Status: **analysis for a decision**, requested at slice 5 planning. The question, open since the
design document: when a join arrives under `admission.mode: 'manager-approval'`, what represents the
parked join — an extension of the existing invite/acceptance machinery (the recorded lower-coupling
default) or a dedicated pending-membership state? Settling it forces the neighboring decisions this
slice needs anyway: which lifecycle phase each admission mode binds in (correction 5), who may
grant, how pending admissions interact with formation epochs and timers, where the
`preActivationAppData` gate sits, the slice split, and the recipe plan.

One fact frames everything: **the managed preset has declared `admission: manager-approval` since
slice 1, unenforced.** Slice 5 is where the dimension turns on, so every managed-preset group
changes join behaviour the day the gate wires in — a behaviour change that recipes must pin, not
discover.

## What exists today

**The join gate** (`canJoinGroup`, `packages/shared-server/rallar-system/group-policy.ts:150-179`):
business-status guard, principal required, blocked-member denial, member cap
(`activeMemberCount >= maxMembers`), then a switch on `joinMode`
(`open` / `invite-only` / `code`). Lifecycle intent gates nothing on this path — joins, presence,
and messaging check only the business `status`. The gate fires once, inside `computeJoin`
(`mutation/membership/compute-group-membership-mutation.ts:48-64`), and the same compute writes
`status: 'active'` atomically — there is no two-step admit anywhere.

**An invite is not an entity — it is a member row.** `GroupMemberStatus` is
`'invited' | 'active' | 'left' | 'removed' | 'banned'` (`group-types.ts:16`), a discriminated union
with per-status audit stamps, one row per principal, one canonical transition function
(`transitionGroupMemberLifecycle`) and one status→event mapping (`groupMemberEventType`). Invite
create is governance (`canGovernGroupMember`, owner/admin) writing `status: 'invited'` with
`invitedByPrincipalId` and a 7-day default TTL; **acceptance is the same `computeJoin` path as an
ordinary join** (`GROUP_INVITE_ACCEPT` → `toJoinCommand`); revoke transitions to `'left'`; there is
no decline command and no background reaper — invite expiry is checked lazily. The
`GROUP_JOIN`/`GROUP_INVITE_*` inbox family is already internally named the **admission** descriptor
family, and its routes live in `register-group-admission-routes.ts` behind the `join-admission`
rate quota.

**Manager resolution is free at any enforcement point.** `resolveGroupLifecycleManagers` is pure
over (policy, recorded electorate, epoch, live roster) — slice 4b already pays for grant/decline
authorization; the only cost at a new call site is having the policy and roster in scope.

**The mutation read is deliberately narrow.** `lifecyclePolicy` and the active roster load only for
lifecycle-transition operations (`read-group-mutation.ts:110-115`), and
`validate-group-mutation-read.ts:106-131` *forbids* the roster read on every other operation. The
join path reads neither today — extending both, symmetrically with the validator, is part of this
slice's wiring.

**The WS relay choke point** is `RallarServerWsFacade.handle → authorizeDynamicTopic`
(`ws-topic-router.ts:423,691-722`) → `createGroupRoomWsAuthorizer` → `canSendRoomMessage`. The
authorizer already pays one durable snapshot read per room message, so `lifecycleState` is free
there; the policy document is not on the snapshot and nothing on the relay path reads it. The CRDT
live topics (`room.crdt`/`app.crdt`) flow through the **same** authorizer.

## The symmetry that decides the shape

Membership completion is two consents. An **invite** records the group's consent first
(governance), and acceptance is the principal's consent landing second — completing to `active`. A
**pending admission** is the exact mirror: the join records the principal's consent first, and a
grant is the group's consent landing second — completing to `active`. The machinery for
"a member row parked in a non-active status, completed by the missing consent, with typed exits"
already exists; `manager-approval` needs the mirrored arm of it, not a new subsystem.

Two corollaries fall straight out:

- **An invited member's join does not park.** The group's consent already exists — the invite.
  Acceptance stays today's path, byte-identical, under every admission mode.
- **Grant is not a new kind of thing.** It is the same shape as acceptance: the second consent
  transitions the row to `active` and emits `member-joined`.

## Option A — a sixth member status, `pending` (extend the machinery) — recommended

The `GroupMember` union gains a `pending` arm (`joined: null`, no new base fields), the transition
function and event mapping gain the arm, and `computeJoin` under a parking admission decision writes
`status: 'pending'` with one new event type (`member-admission-requested`) instead of `'active'`.
Grant transitions `pending → active` (`member-joined`); decline mirrors invite revoke,
`pending → 'left'` (`member-left`), so a declined principal may re-request (bounded by the existing
`join-admission` quota) while `banned` remains the tool for keeping someone out. Withdrawal is the
existing leave command.

What the existing machinery answers for free, verified against the code:

- **Presence, messaging, electorate, managers**: every `status === 'active'` filter already
  excludes pending — a pending member cannot connect presence, send room messages, enter
  `activeMemberCount`, the formation electorate, or manager resolution.
- **Capacity**: pending members are invisible to the cap exactly as invited members are; the grant
  re-runs the cap and the admission window in a fresh AppInbox attempt (conflicts retry with fresh
  authorization by doctrine), so a park that outlives its window is denied honestly at grant time.
- **Visibility**: `readGroupVisibility` gives pending the existing `'invite'` tier — enough to see
  you are parked; managers see the queue in the full member list with no new read surface.
- **Idempotency**: a retried join with the same requestId replays the parked receipt; a new
  requestId re-parks as a no-op (same guard as the `active` no-op). Grant is a distinct command,
  which the permanent-receipt semantics require anyway.

The honest costs:

- The status-vocabulary census: every exhaustive switch over `GroupMemberStatus` grows an arm —
  union, transition function, event mapping, visibility, persistence validators, OpenAPI enums —
  plus one new event type through `GroupEventType` and the state-write evidence registries. This is
  the member-status analog of the 4a field census: mechanical, enumerable, and the kind of change
  the exhaustive switches were built to police.
- Two new mutation commands (grant/decline) through the ~10-registry command census and the
  routing-owner analyzer, with the dispatch-classifier fall-through only provable by executing a
  request — the recipe does exactly that.
- **Both join surfaces must take the same decision.** Self-upsert activation
  (`PUT .../members/{self}` with `status: 'active'`) re-runs `canJoinGroup` today; under
  `manager-approval` it must land `pending` exactly like the join route, or the park is bypassable
  by switching endpoints. Admin activation of another principal (`canActivateGroupMember`) stays
  governance — it *is* a grant, expressed through the existing surface.
- Invite-row precedence: an invite and a request occupy the same row. The rule is the symmetry
  rule: whichever consent lands second completes to `active`; a governance invite issued to a
  `pending` member is a grant.

## Option B — a dedicated pending-membership state

A pending-admissions collection beside the member list (aggregate field or scoped document), with
its own grant/decline paths. Rejected: it is precisely the "parallel path" the slice rule forbids —
a second membership-adjacent store needing its own persistence, snapshot/delta surface, visibility,
presence-coupling and capacity answers, all of which the member row already gives. Its one genuine
advantage — no growth of the member-status union — buys nothing, because every consumer of the
union would still need to learn the new collection to answer "is this principal in the group?".

## Also considered — reuse `'invited'` with a marker

Parking a join as a synthetic invite inverts the consent direction dishonestly: `invited` means the
group has consented and visibility/TTL semantics assume it. A marker field distinguishing the two
would make one status mean opposite things — worse than a sixth status on every axis.

## Recommendation

**Option A**, with the invited-bypass, decline-to-`left`, and both-surfaces rules above. It is the
design document's own sentence made concrete — "building on the existing invite/acceptance flow
rather than a new subsystem" — and it keeps the slice rule intact: every new behaviour is an added
predicate or an added arm at an existing enforcement point.

Two supporting rules ride along:

- **Grant/decline authorization is manager-only** (`resolveGroupLifecycleManagers` at the command,
  same zero-extra-cost resolution as 4b), *not* widened to owner/admin. Governance already has its
  own consent channel — the invite — so an owner in a zero-manager group recovers by inviting (the
  group's consent), never by impersonating a manager. This keeps "manager-approval" meaning what it
  says while preserving the slice 4 invariant that manager absence blocks only manager-assigned
  actions: membership recovery stays possible through governance. The manager-succession recipe's
  zero-manager safety leg survives as exactly this invite-recovery path.
- **A new cross-field validity issue, `manager-approval-without-manager`**: `admission.mode:
  'manager-approval'` with `manager.selection: 'none'` can never grant and is rejected at policy
  validation beside the `manager-initiator-without-manager` deadlock it rhymes with. Transient
  zero-manager states (assigned manager not yet joined, all managers departed) stay legal —
  recoverable via invite — only the *permanently* granterless combination is invalid.

## Admission binding phases (settling correction 5 per mode)

Correction 5 says admission binds on entry to the phase it names, not on activation. The shipped
vocabulary dropped the phase-suffixed names, so the binding phase must be fixed per mode:

| Mode / field | Binds | Rationale |
| --- | --- | --- |
| `open` | never gates | — |
| `manager-approval` | every state, from creation | The managed archetype is curated membership from the lobby onward; a mode with no phase in its name is a standing rule. |
| `untilEpochMs` / `untilMemberCount` | every state, from creation | Absolute windows; correction 5's own example (drop-in social never activating) demands they bind without activation. When the window closes the mode degrades to `closed`. |
| `closed` | **every state except FORMING** — *decision to confirm* | See below. |

`closed` is the one genuine choice. The design table said "no joins after activation"; binding at
ACTIVE entry (design-literal) leaves ESTABLISHING joinable — exactly when the match preset
(`successRate: 1`) is counting planned edges, so a join then re-plans the overlay and guarantees
the deadline fails. Binding on exit from FORMING freezes the roster when establishment begins,
which is what `closed` exists to protect, and a below-floor return to FORMING honestly re-opens the
lobby to replace the member who could not connect. Recommended: **binds outside FORMING**.
(Always-closed is expressible but useless — nobody could ever join, which `joinMode: invite-only`
with no invites already says better.)

`joinMode` and admission compose rather than overlap: `joinMode` is the credential — how a
principal proves entitlement (open / invite / code) — and admission is the consent-and-timing
overlay — whether joining is currently possible and whether it completes or parks.

## The formation-timer/epoch interaction

Stated explicitly, per dimension, because a pending admission can straddle epochs (parked during
ESTABLISHING, granted after a below-floor return to FORMING advanced the epoch and re-armed
timers):

1. **A pending admission survives epoch advances — by construction, not by rule.** An epoch
   advance writes the group row, an event, a receipt, and outbox entries; member rows are untouched
   (`compute-lifecycle-transition.ts:155`, `members: []`). Nothing epoch-keys membership state, so a
   join parked in epoch 3 is grantable in epoch 5 with no carried machinery. Formation-timer
   entries stale-drop by epoch; pending rows are not timer entries and are unaffected.
2. **Grant authorization is evaluated at grant time against the current epoch.** The pending row
   records no epoch (correctly — it is a consent, not a formation fact); the grant command resolves
   managers from the *current* electorate, epoch, and live roster, exactly like any manager-gated
   command. A manager elected after the park can grant it; a manager who departed since cannot.
3. **A grant in each lifecycle state means exactly what an ordinary join means there today:**
   - **FORMING**: the member becomes active; planning is held (decision 2.4), and they enter the
     electorate at the next `start-establishment` pin — full stability, no interaction.
   - **ESTABLISHING / RECONFIGURING**: the membership write bumps `snapshotVersion`, the
     group-revision work item re-plans the overlay including the new member, the readiness
     denominator grows, and the criterion re-evaluates on the new evidence — possibly deferring
     threshold or hitting the deadline into a below-floor return. That is the same consequence an
     open join has in that state on `main` today, and it is honest: activation claims the planned
     overlay is connected, and the roster is part of the plan.
   - **ACTIVE**: a plain join; the overlay re-plans under ACTIVE as it does for any join.
4. **Granting mid-ESTABLISHING takes effect now, not at the next epoch — deliberately.** Deferring
   grants to an epoch boundary would need an epoch-keyed grant queue: a parallel path, forbidden by
   the slice rule, solving a problem the model already solves twice over. Manager stability is
   already epoch-pinned (a granted member cannot enter the electorate mid-epoch; under
   `assigned`/`creator` they enter only the liveness filter, which is 4b's recorded
   joining-restores-the-manager semantics). And roster stability during establishment is what
   `closed` admission is *for* — an archetype that wants a frozen mesh declares it; under
   `manager-approval` the timing judgment belongs to the manager holding the grant.

In short: **it composes with no new machinery**, and each of the four statements above is pinned by
a recipe leg rather than left as prose.

## The `preActivationAppData` gate

One added denial at the existing per-message policy predicate, plus acquisition:

- **Predicate**: `canSendRoomMessage` gains the resolved data-policy value in its input and denies
  with a new reason code (`group-data-blocked-until-active`) when
  `preActivationAppData === 'blocked-until-active'` and `snapshot.group.lifecycleState !== 'active'`.
  `lifecycleState` is already on the snapshot the authorizer loads per message.
- **Acquisition with a lifecycle short-circuit**: the api-v1 authorizer reads the policy **only
  when the group is not ACTIVE** — steady-state room traffic (active groups) pays zero additional
  reads; the short pre-activation window pays one policy get on a path already doing a durable
  snapshot read. Absent policy → `allowed` (the workstream's no-policy invariant); corrupt policy →
  fail closed, matching the repository's own doctrine and the match preset's integrity posture.
- **CRDT topics are explicitly exempt.** `room.crdt`/`app.crdt` share the choke point; without an
  explicit classification the gate silently blocks pre-activation collaborative documents, which
  the terminology doctrine separates from match authority ("Rallar CRDT = collaborative authored
  documents, not competitive match authority"). The exemption is a visible topic-id classification
  at the authorizer, not an accident of ordering. *(Default taken unless objected: the gate covers
  plain WS-relayed app data only.)*
- Out of scope, unchanged: RTC data-channel traffic (`realtime.room` is peer-to-peer; the server
  only signals), presence/state-sync/signaling/RTT reserved topics (activation must remain
  reachable), and the pre-existing ungated `scope: 'all'` broadcast hole.

## Slice split

Mirroring 2/3/4 (dark core, then wiring), with the data gate split out because it lives on a
different runtime surface (WS relay, no AppInbox mutation):

- **5a — dark core.** The `pending` status arm through the full status census; the pure admission
  decision (`computeGroupAdmissionDecision(admission, lifecycleState, activeMemberCount, now) →
  admit | park | typed denial`) beside the policy contract in
  `packages/shared/api/group-lifecycle/`; new reason codes extending `GroupPolicyReasonCode`; the
  `manager-approval-without-manager` validity rule; unit matrices (binding-phase table, decision
  matrix, pending transitions including leave-from-pending and invite-on-pending precedence).
  Nothing constructs a `pending` row and no gate wires in: no behaviour change except the validity
  rejection of a combination no preset ships.
- **5b — admission wiring, commands, recipes.** The read-phase extension (policy + what the
  admission decision needs, for join/accept/upsert-activation, with the read-validator kept
  symmetric); `computeJoin` and upsert-activation take the decision; grant/decline commands through
  the command census, routes in the existing admission route file under the `join-admission` quota;
  OpenAPI; the recipes below; the mandatory medium-scale gate.
- **5c — data-policy gate and recipe.** The `canSendRoomMessage` predicate + authorizer policy read
  + CRDT classification + its recipe. Small, independent, separately revertible.

(A two-way split folding 5c into 5b is workable if three PRs feel heavy; the data gate's different
blast radius is the argument for three.)

## Recipe plan

New recipes (cluster profile, beside the lifecycle recipes; registered in `recipe-matrix.json`):

1. **`api-v1-group-admission-approval`** — the managed preset's behaviour change, pinned:
   uninvited join parks (`members[].status: 'pending'` in the 200 snapshot); non-manager grant
   denied `forbidden-role`; manager grants → active (roster + formation view); manager declines →
   `left`, re-request succeeds; invited member joins straight to active (bypass); the **epoch
   leg** — park during ESTABLISHING, drive fail-formation to FORMING (epoch advance), grant in the
   later epoch succeeds and the member enters the next electorate pin; the **zero-manager leg** —
   managed group with an unjoined assigned manager: join parks, nobody grants, owner invites →
   accept → active → manager restored (the succession safety property, now under real admission).
2. **`api-v1-group-admission-windows`** — capacity-on-phase-entry: `untilMemberCount: N` on a group
   that never activates — joins to N succeed, N+1 is denied with the typed code (correction 5
   pinned); an `untilEpochMs` leg with a short window and polling. A `closed` leg: joins denied
   outside FORMING, allowed again after a below-floor return to FORMING.
3. **`api-v1-group-data-policy`** (5c) — `blocked-until-active` policy with manual activation: WS
   room message pre-activation NACKed (typed code), CRDT envelope flows pre-activation (exemption
   pinned), activate, the same message flows.

Existing-recipe impact (from a full sweep — exactly four recipes carry a `lifecyclePolicy`):

- **`api-v1-group-manager-succession`** and **`api-v1-group-formation-criterion`** each have joins
  into managed groups that would newly park. Both recipes pin manager duty and criterion legs, not
  admission — so both get an explicit `admission: { mode: 'open' }` override at creation
  (the decision-3.5 pattern: pin the dimension you are not testing), and the admission behaviour
  itself is pinned in the dedicated recipe above.
- **`api-v1-group-lifecycle-transitions`** (no joins) is exposure-only; **`api-v1-group-lifecycle-policy`**
  already creates a `closed`-override group and gains one join-denial assertion so the stricter
  behaviour is pinned rather than silent.
- The formation burst/churn/join-admission recipes and all `examples/` create optimistic groups —
  unaffected.

Validation per the plan: focused unit tests → the new/updated recipes →
`test:api-v1:black-box:postgres:medium-scale` (hot join path; constants and assertions untouched),
plus the OpenAPI/pinned-literal updates the status enum ripples into.

## Defaults taken unless objected

Decline lands `'left'` (re-requestable; `banned` is the keep-out tool). No pending TTL in v1 (no
reaper exists; lazy expiry can follow the invite pattern later). Parked joins return HTTP 200 with
the snapshot showing `pending` (no new status code). Grant/decline ride the `join-admission` rate
quota. CRDT exemption from the data gate as above. Admin upsert-activation of another principal
remains governance (it is a grant through the existing surface).
