# Browser Lifecycle Command Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give browser applications the group-formation lifecycle the server already implements: a
room can be created with a lifecycle policy, every one of product decision 12's eight commands is
callable from the room facade, and an application can observe stage, layout, transport and condition
changes and wait for the layout a command produced.

**Architecture:** One room-bound handle, `rallar.rooms.formation(room)` (also `session.formation`),
owned by a new `packages/shared-web/browser/rooms/formation/` feature folder. Commands are HTTP
workflows that return the receipt snapshot and accept it into the state cache like every other room
mutation. Observation is a pure projection of the cached group snapshot plus the browser's existing
planned and accepted overlay slots; waits are cache-driven typed results built on one generic wait
engine extracted from the presence wait. `connect` names the exact planned layout it dials, sourced
from the planned slot with one read-through fallback.

**Tech Stack:** TypeScript under `packages/shared-web` (Vite/esbuild consumers, Vitest under
`packages/tests/shared-web`), shared HTTP contracts under `packages/shared/api` (also type-checked by
Deno for `apps/api-v1`), dprint formatting.

**Spec:** `playground/rtc-design/2026-08-22-group-activation-product-plan.md` (decisions 12, 16, 24,
25, 29, 30, 32, 40 and "The browser contract"), refined by the "Design" section below. The server
behaviour this consumes is `docs/rallar-group-formation-architecture.md`; the routes are
`apps/api-v1/src/group-state/register-group-lifecycle-routes.ts` and
`apps/api-v1/src/routes/group-formation-view-read.ts`.

Status: **implemented and under review as stacked PRs #506, #512 and #513 (formatting pass #511),
amended 2026-09-06 after code review; the nine review questions below were settled with the
maintainer on 2026-09-05, each taking the recommended answer, and "Deviations recorded during
delivery" amends the task bodies.** Written 2026-09-05 against `main` @ `c11c258b2`. The
implementation workstream it completes (`2026-08-22-group-activation-implementation-plan.md`) has all
fourteen server slices merged; this plan is the browser surface that workstream's slice 8 deliberately
left to "later work" beyond dial gating. Location note: the writing-plans skill defaults to
`docs/superpowers/plans/`; this document lives beside its product and implementation companions
because that is where readers of the group-activation track look.

## Global Constraints

- The code standard is `.agents/skills/rallar-code-writing/references/repo-code-style.md`; every
  touched file enters touched-file standards closure (see `AGENTS.md`).
- `room` is the browser term, `group-state` the server term; the only translation boundary is
  `packages/shared-web/browser/rooms/room-group-state-translation.ts`. `GroupRef` / `roomRef` stay
  fixed protocol identities.
- Required fields by default; an optional field only where absence has a distinct domain meaning.
- Canonical verbs: `toXxx` pure translation, `readXxx` crosses a boundary (HTTP or a repository),
  `resolveXxx` pure selection, `createXxx` construction. Banned: `handle`, `process`, `util`,
  `helper`, `data`, abbreviations.
- At most three positional parameters; `interface` for object contracts, `type` for unions; one
  canonical name per type, no rename aliases, no `I` prefix, kebab-case filenames matching the
  primary export.
- Comments only for a non-obvious invariant or deliberate tradeoff; none in tests beyond intent.
- Public shared-web surface changes update `packages/tests/shared-web/shared-web-public-api-snapshots.test.ts`,
  pass `shared-web-browser-bundle-boundaries.test.ts`, `shared-web-browser-entrypoints.test.ts`,
  `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles` and
  `packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts`.
- **Bundle budgets are adjustable** (maintainer ruling, 2026-09-05: "code quality and
  functionality trumps this concern"). A slice that crosses a budget raises it to the smallest whole
  KiB strictly above the measured figure, records the measurement beside the budget, and reports it in
  the PR. Measured on `main` @ `c11c258b2`: `browser/rallar.ts` 172.7 KiB Brotli of a 176 KiB budget;
  the headless agent 216.917 KiB of a strict 217 KiB ceiling, and that bundle already contains every
  file under `browser/rooms/`, so the first task that adds a byte there crosses it.
- Tests live under `packages/tests/**` mirroring the production path, never beside the source.
  Vitest has two include roots; `npm run test:unit` is the suite.
- Every command is idempotent through a fresh request id per call
  (`toApiMutationWorkflowRequestId()`); a retry after a typed conflict must be a new call.
- Commits are plain imperative sentence-case subjects, no prefix, no trailers, on a
  `codex/browser-lifecycle-command-surface` branch; nothing lands on `main` without the
  `AGENTS.md` per-operation approval.
- No REST behaviour changes: no recipe changes are required, and the medium-scale gate is not a local
  requirement. CI auto-runs it for any PR touching `packages/shared/**`; do not weaken it.

---

## Design

### What exists and what is missing

| Already delivered (server and browser)                                                                                                                                                                                                                       | Missing (this plan)                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Eight routes `POST …/groups/{groupId}/lifecycle/{plan,connect,activate,reconfigure,pause,resume,reset,start}/requests/{requestId}` returning the receipt `GroupSnapshot`; `GET …/groups/{groupId}/formation` returning `GroupFormationView`                  | A browser caller for any of them; a browser reader of the formation view                                                                                      |
| The group aggregate pushes `lifecycleState`, `formationEpoch`, `formationAttemptCount`, `acceptedLayoutIdentity`, `transportState`, `memberPolicy`, `activationStatus` on every snapshot, delta and hydration                                                | A room-facing projection of those fields, and a change subscription that also covers the layout slots                                                         |
| The browser's two-slot overlay cache (`readablePlannedOverlayCache`, `readableAcceptedOverlayCache`, `onPlannedOverlayChange`, `onAcceptedOverlayChange`), the WS classifier `adoptOverlayTopology`, hydration `hydrateGroupTopologyOverlays`, the dial gate | `layoutPlanned` / `layoutAccepted` as application-facing events, and the explicit wait for a layout product decision 16 promises                              |
| `RallarRtcRoomTransportStatus.acceptedLayoutIdentity`, the `halted` transport state, per-peer repair arrays (product decision 40's member progress)                                                                                                          | Nothing; the plan reuses them unchanged                                                                                                                       |
| `CreateGroupRequest.lifecyclePolicy` on the wire; `CreateStateGroupBody` already carries it                                                                                                                                                                  | `RallarCreateRoomInput.lifecyclePolicy` (the browser cannot create a non-optimistic room today)                                                               |
| Typed `409` connect conflicts `group-connect-no-planned-layout` / `group-connect-planned-layout-superseded` and `403` policy denials, both decoded onto `ApiHttpError.mutationFailure`                                                                       | A cross-runtime home for the two connect codes (they live only in `packages/shared-server`) and a pure reader that classifies a thrown error for applications |

### Decisions taken at planning

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | **The surface is a room-bound handle, `rallar.rooms.formation(room?)` and `session.formation`.** It resolves the room exactly as `rooms.session(room?)` does (explicit, else default, else current) and binds a `roomRef`, so no command takes a room target. _Rejected:_ eight flat `rooms.plan(room)` methods (thirty-plus methods on one facade, a target on every call, and no home for layout events) and a top-level `rallar.formation` (formation belongs to a room).                                                                                                                                                                                                                                                                                                     |
| B2  | **Commands resolve on the receipt and return the `GroupSnapshot`**, exactly like every room mutation, and accept it into the state cache immediately. A receipt means the transition committed and nothing more (product decision 16); no command waits for planning, publication or RTC readiness.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| B3  | **Commands throw `ApiHttpError`, waits return typed statuses.** This is the facade's existing split: `rooms.join` throws a policy denial, `waitForPresence` and `rtc.waitForRoom` return a status. A pure `toRoomFormationDenial(error)` reader classifies a thrown error as a policy denial or a layout conflict so applications never string-match. _Rejected:_ `Either` results on the public command methods, which would make formation the one room capability whose failures look different from its siblings (recorded as open question Q2 because the code standard prefers values for expected failures).                                                                                                                                                              |
| B4  | **`connect()` names the current planned layout by default.** The identity comes from the planned overlay slot the WS classifier already fills; when the slot is empty the facade performs one room refresh (the existing point read plus topology read-through) and reads again; when still empty it throws a local `RallarValidationError` issue `no-planned-layout` without spending a request. `connect({ layout })` sends exactly that identity. The epoch fence is always the cached snapshot's `formationEpoch`, so a stale identity yields the typed `409`, not the untyped stale-epoch `400`.                                                                                                                                                                            |
| B5  | **Waits are cache-driven and perform no HTTP.** They observe the state cache and both overlay slots, resolve on the first satisfying observation, and settle as `timeout`, `aborted` or `not-found` otherwise. Anti-entropy stays where it is: `session.refresh()` / `rooms.refresh()`, on-connect hydration and reopen resync. _Rejected:_ a GET inside every wait, which would either swallow read failures or fail a wait for a transport hiccup.                                                                                                                                                                                                                                                                                                                             |
| B6  | **`waitForLayout` is fenced by a causal revision, optionally.** With `after` set to a receipt's `causalRevision`, only a layout whose `sourceGroupStateCausalRevision` is `equal` to or `dominates` it satisfies the wait; `incomparable` never satisfies it (product decision 29 requires that case be explicit). Without `after`, any active layout in the requested slot satisfies it. See "The wait semantics" for why the unfenced form is the right default after `plan` and the fenced form is the right one after `reconfigure`.                                                                                                                                                                                                                                         |
| B7  | **The status object is a pure projection with no stored state.** `toRallarRoomFormationStatus` maps a cached `GroupSnapshot` plus the two slot overlays to a room-facing status; the accepted layout is reported only when the slot overlay matches the snapshot's `acceptedLayoutIdentity` (the rule `resolveBrowserRoomTransportTarget` already applies), the planned layout whenever the planned slot holds an active server overlay for the room. Remediation is not in it: it is derived at read on the server and is only available through `readView()`.                                                                                                                                                                                                                  |
| B8  | **`onChange` de-duplicates by object identity, not structural comparison.** The caches replace objects on every change, so "same snapshot object and same slot overlay objects" is exactly "nothing observable changed". No `isSame…` comparator is written.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| B9  | **`onLayout` is the slot event stream, not a snapshot event.** `layoutPlanned` / `layoutAccepted` fire when a slot adopts an active overlay for the room; `layoutRemoved` fires when a slot is cleared or adopts a `removed` tombstone. The names are product decision 16's, carried as the event `kind`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| B10 | **The two connect conflict codes move to `packages/shared`** (`group-connect-rejection-codes.ts`) and the server registry spreads them; `GroupConnectRequest` and `GroupReconfigureRequest` become shared HTTP DTOs beside `CreateGroupRequest`, named after their OpenAPI schemas, and the server's connect inbox payload adopts the shared type. The browser never imports `packages/shared-server`.                                                                                                                                                                                                                                                                                                                                                                           |
| B11 | **`RallarCreateRoomInput.lifecyclePolicy?: GroupLifecyclePolicyInput`** rides the existing `Pick<CreateStateGroupBody, …>`. Absence is the `optimistic` preset (a distinct domain meaning), so the field is legitimately optional; there is no update surface because the policy is write-once.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| B12 | **One generic wait engine, `waitForRoomChange`, is extracted from `room-presence.ts`** and used by the presence wait and the three formation waits. _Rejected:_ a second copy of the subscribe/timeout/abort loop inside `rooms/formation/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| B13 | **The formation view is validated at the boundary by a pure shared validator** (`validateGroupFormationView`, returns every issue) and the browser reader throws a `TypeError` naming them, the way `hydrateGroupTopologyOverlays` decodes the topology view.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| B14 | **No new example app; the quickstart gains a recipe.** `examples/**` is pinned by `rallar-skill-app-examples-integrity.test.ts` and a new example would widen that test for no reader the quickstart does not already serve.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| B15 | **The aggregate facade owns the runtime; the narrow entry points carry only types.** `browser/rallar.ts` composes the handle exactly as it composes every other rooms capability, and `rallar-core.ts` and `rallar-realtime.ts` re-export the new types the way they re-export the room contracts today, staying runtime-free (0.3 and 0.4 KiB Brotli on `main`). No new narrow entry point is created: a formation-only entry would need the rooms, state-cache and session composition to do anything, which is the aggregate facade. The bytes therefore land in the `browser/rallar.ts` budget and, through the black-box control agent's composition, in the headless bundle. _Rejected:_ a `rallar-formation.ts` entry, which would be the full facade under another name. |

### The wait semantics

Product decision 16 makes the explicit wait the real design question: a receipt means acceptance,
planning and publication are asynchronous, and the layout arrives later over WS (or by hydration).
What "the layout this command produced" means differs per command, and the code settles it:

- **After `plan` from `forming`** the planned slot is empty (a failure discards the planned layout,
  `reset` tombstones both slots, activation moves planned to accepted), so "any active planned layout
  for this room" is the layout the plan produced. `waitForLayout()` unfenced is correct.
- **After `plan` from `planned`** (product decision 28's idempotent replan) the group row is rewritten
  and its `causalRevision` advances, but an unchanged replan publishes nothing new; the standing
  candidate is the one to dial. A wait fenced on that receipt would time out. Unfenced is correct.
- **After `reconfigure` from `active`** the planned slot may still hold an older candidate (a `hold`
  landing under automatic replanning, or the candidate the reconfigure supersedes, see implementation
  decision I35). The new publication's `sourceGroupStateCausalRevision` is read after the transition
  committed, so it `dominates` the receipt's `causalRevision`; the old candidate is `dominated`.
  `waitForLayout({ after: receipt.causalRevision })` is correct and the unfenced form is documented as
  possibly returning the superseded candidate, which `connect` then rejects with the typed conflict.
- **`connect` itself never waits.** It sends the identity the caller holds (or the current slot
  identity) with the cached epoch, and the server's fence answers `no-planned-layout` or
  `planned-layout-superseded` as a typed `409`. The application re-waits and calls again.
- **After `connect`, readiness is the accepted layout's.** `rtc.waitForRoom` / `realtime.room().wait()`
  already report `idle` until promotion; a manual-activation application waits for
  `waitForCondition('active')` (the pushed `activationStatus.condition` for the candidate being
  dialed, product decision 30) before calling `activate()`, then `waitForStage('active')`, then the
  RTC readiness waits it already uses.
- **Stage and condition waits** resolve from the cached snapshot alone; the receipt of the command
  that moved the stage is already in the cache when the command resolves, so `await plan()` followed
  by `await waitForStage('planned')` resolves immediately.

The fence assumption underlying the third bullet (the receipt's `causalRevision.groupRevision`
strictly precedes every publication the transition causes) is verified in Task 2.3 against the
transition compute and one PGlite-backed recipe read before the semantics are documented; open
question Q4 records the fallback if it does not hold.

### Ownership map

| Path                                                                                                                                                                                               | Responsibility                                                                                                                                                                                                                 | Slice |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| `packages/shared/api/state-types.ts`                                                                                                                                                               | `GroupConnectRequest` shared HTTP DTO (`GroupReconfigureRequest` was not needed; see the deviations)                                                                                                                           | 1     |
| `packages/shared/api/group-lifecycle/group-lifecycle-commands.ts`                                                                                                                                  | The eight lifecycle command names, one owner for the wire spelling                                                                                                                                                             | 1     |
| `packages/shared/api/group-lifecycle/group-connect-rejection-codes.ts`                                                                                                                             | The two connect conflict codes and their predicate                                                                                                                                                                             | 1     |
| `packages/shared/api/group-policy-types.ts`                                                                                                                                                        | `isGroupPolicyReasonCode` predicate                                                                                                                                                                                            | 1     |
| `packages/shared/repository/overlays-repository.ts`                                                                                                                                                | Exports `toOverlayLayoutIdentity` (already implemented privately)                                                                                                                                                              | 1     |
| `packages/shared-server/rallar-system/group-state/mutation/group-mutation-rejection-codes.ts`                                                                                                      | Registry spreads the shared connect codes                                                                                                                                                                                      | 1     |
| `packages/shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts`                                                                                                            | Connect inbox payload uses `GroupConnectRequest`                                                                                                                                                                               | 1     |
| `packages/shared-web/browser/rooms/rallar-room-contracts.ts`                                                                                                                                       | `lifecyclePolicy` on create input; `formation` on `RallarRoomSession`                                                                                                                                                          | 1     |
| `packages/shared-web/browser/rooms/room-group-state-translation.ts`                                                                                                                                | Create request carries the policy; `RoomFormationCommand`, `toRoomFormationGroupStateRequest` pairing each command with the body its OpenAPI schema declares (the projections moved out; see the deviations below)             | 1     |
| `packages/shared-web/browser/rooms/create-and-join-room.ts`                                                                                                                                        | `toCreateOptions` forwards the policy                                                                                                                                                                                          | 1     |
| `packages/shared-web/browser/rooms/formation/rallar-room-formation-contracts.ts`                                                                                                                   | Every public formation type                                                                                                                                                                                                    | 1, 2  |
| `packages/shared-web/browser/rooms/room-group-state-http-api.ts`, `state-read/state-snapshot-http-api.ts`                                                                                          | `commandLifecycle` (the eight command POSTs) and `readStateGroupFormationView` (the view GET); there is no separate formation port                                                                                             | 1, 2  |
| `packages/shared-web/browser/rooms/formation/room-layout-slots.ts`                                                                                                                                 | `RallarRoomLayoutSlotsPort` over the two overlay repositories                                                                                                                                                                  | 1     |
| `packages/shared-web/browser/rooms/formation/command-room-formation.ts`                                                                                                                            | The command workflow and `connect`'s identity resolution                                                                                                                                                                       | 1     |
| `packages/shared-web/browser/rooms/formation/create-room-formation.ts`                                                                                                                             | The handle factory (feature entry), status read, subscriptions                                                                                                                                                                 | 1, 2  |
| `packages/shared-web/browser/rooms/formation/room-formation-observation.ts`                                                                                                                        | `readRoomFormationStatus`, `subscribeRoomFormation`, `subscribeRoomFormationChanges`, `subscribeRoomLayoutEvents`, `toRallarRoomLayout`, `toRallarRoomFormationStatus`: the status projection, its read and both subscriptions | 1, 2  |
| `packages/shared-web/browser/state-cache/overlay-slot-subscriptions.ts`                                                                                                                            | Slot listeners kept across the overlay repositories being replaced on connect                                                                                                                                                  | 1     |
| `packages/shared-web/browser/rooms/is-room-layout-overlay.ts`                                                                                                                                      | The live-layout predicates the status projection and the transport target share                                                                                                                                                | 1     |
| `packages/shared-web/browser/rooms/formation/to-room-formation-denial.ts`                                                                                                                          | Pure classification of a thrown command error                                                                                                                                                                                  | 1     |
| `packages/shared-web/browser/connection/wait-for-settled-read.ts`                                                                                                                                  | The cache-driven wait engine, extracted from `room-presence.ts`; the WS open wait runs on it too                                                                                                                               | 2     |
| `packages/shared-web/browser/rooms/formation/wait-for-room-formation.ts`                                                                                                                           | `waitForRoomStage`, `waitForRoomCondition`, `waitForRoomLayout` over one generic wait                                                                                                                                          | 2     |
| `packages/shared-web/browser/rooms/formation/read-room-formation-view.ts`                                                                                                                          | Formation view read and boundary decode                                                                                                                                                                                        | 2     |
| `packages/shared/api/group-lifecycle/decode-group-formation-view.ts`                                                                                                                               | `decodeGroupFormationView` over the JSON the server sent, returning an `Either` of every issue                                                                                                                                 | 2     |
| `packages/shared-web/browser/rooms/browser-rallar-rooms.ts`, `room-session.ts`                                                                                                                     | `rooms.formation(room?)`, `session.formation`, port wiring                                                                                                                                                                     | 1     |
| `packages/shared-web/browser/composition/browser-runtime-composition.ts`, `browser-product-composition.ts`                                                                                         | `roomLayoutSlots` created once in the state composition and passed to rooms                                                                                                                                                    | 1     |
| `packages/shared-web/browser/rallar.ts`, `rallar-core.ts`, `rallar-facade-contract.ts`                                                                                                             | Public type and value exports                                                                                                                                                                                                  | 1, 2  |
| `packages/tests/shared-web/rooms/formation/**`, `packages/tests/shared/**`                                                                                                                         | Behaviour tests mirroring the paths above                                                                                                                                                                                      | 1, 2  |
| `docs/rallar-api-reference.md`, `docs/rallar-quickstart-and-recipes.md`, `docs/rallar-group-formation-architecture.md`, `packages/shared-web/browser/README.md`, `playground/rtc-design/README.md` | Documentation and navigation                                                                                                                                                                                                   | 1–3   |

### The public surface after slice 2

```ts
interface RallarRoomFormation {
    readonly roomRef: GroupRef;
    status(): RallarRoomFormationStatus | undefined;
    readView(options?: RallarScopedOperationOptions): Promise<GroupFormationView>;
    plan(options?: RallarRoomFormationCommandOptions): Promise<GroupSnapshot>;
    connect(options?: RallarRoomConnectOptions): Promise<GroupSnapshot>;
    activate(options?: RallarRoomFormationCommandOptions): Promise<GroupSnapshot>;
    reconfigure(options?: RallarRoomReconfigureOptions): Promise<GroupSnapshot>;
    pause(options?: RallarRoomFormationCommandOptions): Promise<GroupSnapshot>;
    resume(options?: RallarRoomFormationCommandOptions): Promise<GroupSnapshot>;
    reset(options?: RallarRoomFormationCommandOptions): Promise<GroupSnapshot>;
    start(options?: RallarRoomFormationCommandOptions): Promise<GroupSnapshot>;
    waitForLayout(options?: RallarRoomLayoutWaitOptions): Promise<RallarRoomLayoutWaitResult>;
    waitForStage(
        stage: GroupLifecycleState | readonly GroupLifecycleState[],
        options?: RallarScopedOperationOptions
    ): Promise<RallarRoomFormationWaitResult>;
    waitForCondition(
        condition: GroupActivationCondition | readonly GroupActivationCondition[],
        options?: RallarScopedOperationOptions
    ): Promise<RallarRoomFormationWaitResult>;
    onChange(
        listener: RallarStateListener<RallarRoomFormationStatus>,
        options?: RallarOnChangeOptions
    ): RallarUnsubscribe;
    onLayout(listener: RallarRoomLayoutListener): RallarUnsubscribe;
}
```

The product plan's sketch used `room.formation.layout()`; this plan names it `waitForLayout()` to sit
beside `waitForPresence` and `waitForRoom`, and returns a typed result rather than a bare identity so
`timeout` and `not-found` are values.

---

## Slice 1 — Creation policy and the eight commands

**Outcome:** an application creates a room with `lifecyclePolicy`, drives every stage and transport
command from the facade, reads the current formation status, and classifies a thrown denial.
Observation beyond `status()` still goes through `rooms.onChange` and `session.snapshot()`.

**Gates (all must pass on the slice's final tree):**

```bash
npx vitest run packages/tests/shared packages/tests/shared-web/rooms packages/tests/shared-web/shared-web-public-api-snapshots.test.ts packages/tests/shared-web/shared-web-browser-entrypoints.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts
npx tsc -p packages/shared/tsconfig.json --noEmit
npx tsc -p packages/shared-web/tsconfig.json --noEmit
npx tsc -p packages/shared-server/tsconfig.json --noEmit
cd apps/api-v1 && deno task check && cd ../..
npm run test:deno
npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles
npm run typecheck
npm run check:repo-style:changed -- origin/main HEAD
node scripts/check-test-structure-coupling.mjs --changed
npm run format:check
npm run test:unit
npm run build
```

Branch CI adds the Branch Release Gate; the medium-scale gate auto-triggers because
`packages/shared/**` changes. Report every command as passed, failed or skipped.

### Task 1.1: Shared lifecycle command contracts

**Files:**

- Modify: `packages/shared/api/state-types.ts` (beside `CreateGroupRequest`, around line 92–100)
- Create: `packages/shared/api/group-lifecycle/group-connect-rejection-codes.ts`
- Modify: `packages/shared/api/group-policy-types.ts` (after `GroupPolicyReasonCode`)
- Modify: `packages/shared/repository/overlays-repository.ts` (the private `toOverlayLayoutIdentity`)
- Modify: `packages/shared-server/rallar-system/group-state/mutation/group-mutation-rejection-codes.ts`
- Modify: `packages/shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts:50-59`
- Test: `packages/tests/shared/group-connect-rejection-codes.test.ts`

**Interfaces:**

- Produces `GroupConnectRequest`, `GroupReconfigureRequest` (state-types), `GROUP_CONNECT_REJECTION_CODES`,
  `GroupConnectRejectionCode`, `isGroupConnectRejectionCode(code: string)`,
  `isGroupPolicyReasonCode(code: string)`, exported `toOverlayLayoutIdentity(overlay: OverlayInfo): GroupLayoutIdentity`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/tests/shared/group-connect-rejection-codes.test.ts
import { describe, expect, it } from 'vitest';

import {
    GROUP_CONNECT_REJECTION_CODES,
    isGroupConnectRejectionCode
} from '@shared/api/group-lifecycle/group-connect-rejection-codes.ts';
import { isGroupPolicyReasonCode } from '@shared/api/group-policy-types.ts';
import { toOverlayLayoutIdentity } from '@shared/repository/overlays-repository.ts';

describe('group connect rejection codes', () => {
    it('names exactly the two connect conflicts product decision 32 defines', () => {
        expect([...GROUP_CONNECT_REJECTION_CODES]).toEqual([
            'group-connect-no-planned-layout',
            'group-connect-planned-layout-superseded'
        ]);
        expect(isGroupConnectRejectionCode('group-connect-no-planned-layout')).toBe(true);
        expect(isGroupConnectRejectionCode('lifecycle-transition-invalid')).toBe(false);
    });

    it('classifies policy reason codes without string matching', () => {
        expect(isGroupPolicyReasonCode('lifecycle-transition-invalid')).toBe(true);
        expect(isGroupPolicyReasonCode('group-connect-no-planned-layout')).toBe(false);
    });

    it('reads a layout identity off an overlay info', () => {
        expect(
            toOverlayLayoutIdentity({
                sourceGroupStateCausalRevision: { groupRevision: 4, presenceRevision: 2 },
                provenance: 'server',
                state: 'active',
                overlayId: 'app-1/workspace-1/room-1',
                groupRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' },
                topology: 'tree',
                name: 'room-1',
                createdByClientId: 'server',
                createdAtEpochMs: 1,
                nextHopSessionIds: [],
                degreeLimit: 2,
                overlayVersion: 7,
                updatedAtEpochMs: 1
            })
        ).toEqual({ groupRevision: 4, presenceRevision: 2, version: 7, state: 'active' });
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/tests/shared/group-connect-rejection-codes.test.ts`
Expected: FAIL, the codes module does not exist and `toOverlayLayoutIdentity` is not exported.

- [ ] **Step 3: Add the shared contracts**

```ts
// packages/shared/api/group-lifecycle/group-connect-rejection-codes.ts
/**
 * `connect` names the exact planned layout it dials (product decision 32).
 * These two conflicts travel as `ApiMutationFailure.code` with status 409 and
 * are the only lifecycle rejections a browser must tell apart from a policy
 * denial; the server registry spreads them so the wire spelling has one owner.
 */
export const GROUP_CONNECT_REJECTION_CODES = [
    'group-connect-no-planned-layout',
    'group-connect-planned-layout-superseded'
] as const;

export type GroupConnectRejectionCode = typeof GROUP_CONNECT_REJECTION_CODES[number];

export function isGroupConnectRejectionCode(code: string): code is GroupConnectRejectionCode {
    return GROUP_CONNECT_REJECTION_CODES.some((known) => known === code);
}
```

In `packages/shared/api/group-policy-types.ts`, after the `GroupPolicyReasonCode` type:

```ts
export function isGroupPolicyReasonCode(code: string): code is GroupPolicyReasonCode {
    return GROUP_POLICY_REASON_CODES.some((known) => known === code);
}
```

In `packages/shared/api/state-types.ts`, import the two types and add the DTOs after
`UpdateGroupRequest`:

```ts
import type { GroupLayoutIdentity } from './group-lifecycle/group-layout-identity.ts';
import type { GroupTopologyReconfigureLanding } from './group-lifecycle/group-lifecycle-policy.ts';

/** `connect` names the exact planned layout it dials (product decision 32). */
export type GroupConnectRequest =
    & MutationActorInput
    & Readonly<{
        expectedFormationEpoch: number;
        expectedLayout: GroupLayoutIdentity;
    }>;

/** An omitted or null `landing` uses the stored policy's `reconfigureLanding`. */
export type GroupReconfigureRequest =
    & MutationActorInput
    & Readonly<{
        landing?: GroupTopologyReconfigureLanding | null;
    }>;
```

In `packages/shared/repository/overlays-repository.ts` change `function toOverlayLayoutIdentity` to
`export function toOverlayLayoutIdentity` (no other change).

In `packages/shared-server/rallar-system/group-state/mutation/group-mutation-rejection-codes.ts`:

```ts
import {
    GROUP_CONNECT_REJECTION_CODES,
    type GroupConnectRejectionCode
} from '@shared/api/group-lifecycle/group-connect-rejection-codes.ts';

export const GROUP_MUTATION_REJECTION_CODES = [
    'group-already-exists',
    'group-mutation-rejected',
    'group-policy-denied',
    ...GROUP_CONNECT_REJECTION_CODES
] as const;
```

and type `GroupConnectDeniedError.code` and its constructor parameter as `GroupConnectRejectionCode`
instead of the `Extract<…, \`group-connect-${string}\`>` expression.

In `packages/shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts` replace the
inline `request` type of `GroupConnectAppInboxPayload` with `GroupConnectRequest` imported from
`@shared/api/state-types.ts`. Leave `GroupReconfigureAppInboxPayload` alone: its internal shape
carries the nullable epoch fence the public body must not.

- [ ] **Step 4: Run the test and the cross-runtime checks**

Run: `npx vitest run packages/tests/shared/group-connect-rejection-codes.test.ts packages/tests/shared-server/rallar-system/group-state`
Expected: PASS.
Run: `npx tsc -p packages/shared/tsconfig.json --noEmit && npx tsc -p packages/shared-server/tsconfig.json --noEmit && (cd apps/api-v1 && deno task check)`
Expected: exit 0. Then `npm run test:deno` — expected PASS (the Deno app tests, not `deno task check`,
cover `apps/*/test/**` after a shared type widens).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/api/state-types.ts packages/shared/api/group-lifecycle/group-connect-rejection-codes.ts packages/shared/api/group-policy-types.ts packages/shared/repository/overlays-repository.ts packages/shared-server/rallar-system/group-state/mutation/group-mutation-rejection-codes.ts packages/shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts packages/tests/shared/group-connect-rejection-codes.test.ts
git commit -m "Share the lifecycle connect contracts across runtimes"
```

### Task 1.2: A lifecycle policy on room creation

**Files:**

- Modify: `packages/shared-web/browser/rooms/rallar-room-contracts.ts:75-89`
- Modify: `packages/shared-web/browser/rooms/room-group-state-translation.ts` (`RoomCreateGroupStateFields`, `toCreateGroupStateRequest`)
- Modify: `packages/shared-web/browser/rooms/create-and-join-room.ts:119-136` (`toCreateOptions`)
- Test: `packages/tests/shared-web/rooms/room-group-state-request-translation.test.ts`,
  `packages/tests/shared-web/rooms/create-and-join-room.test.ts`
- Modify: `docs/rallar-api-reference.md` (the `rooms.create(input)` paragraph)

**Interfaces:**

- Produces `RallarCreateRoomInput.lifecyclePolicy?: GroupLifecyclePolicyInput` and the same field on
  `RoomCreateGroupStateFields`.

- [ ] **Step 1: Write the failing tests**

Add to `room-group-state-request-translation.test.ts` inside `describe('room request translation')`:

```ts
it('forwards a lifecycle policy verbatim and omits it when absent', () => {
    const withPolicy = toCreateGroupStateRequest({
        groupId: 'room-3',
        room: {
            displayName: 'Match',
            lifecyclePolicy: { preset: 'match', establishment: { maxConcurrentEdgeSetups: 2 } }
        },
        ...actor
    });
    expect(withPolicy.lifecyclePolicy).toEqual({
        preset: 'match',
        establishment: { maxConcurrentEdgeSetups: 2 }
    });
    expect(
        'lifecyclePolicy' in
            toCreateGroupStateRequest({
                groupId: 'room-4',
                room: { displayName: 'Lobby' },
                ...actor
            })
    ).toBe(false);
});
```

Add to `create-and-join-room.test.ts`, in the test `forwards only the supported room fields and command
options`, the field `lifecyclePolicy: { preset: 'managed' }` on the create input and
`lifecyclePolicy: { preset: 'managed' }` inside the expected `options` object of the
`createAndJoinStateGroup` call assertion.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run packages/tests/shared-web/rooms/room-group-state-request-translation.test.ts packages/tests/shared-web/rooms/create-and-join-room.test.ts`
Expected: FAIL with a type error on `lifecyclePolicy` (the field is not in the Pick).

- [ ] **Step 3: Widen the three Picks and the two spreads**

In `rallar-room-contracts.ts` add `| 'lifecyclePolicy'` to the `Pick<CreateStateGroupBody, …>` of
`RallarCreateRoomInput`. In `room-group-state-translation.ts` add `| 'lifecyclePolicy'` to
`RoomCreateGroupStateFields` and, in `toCreateGroupStateRequest`, add
`...(room.lifecyclePolicy === undefined ? {} : { lifecyclePolicy: room.lifecyclePolicy }),` after the
`purgeAfterEpochMs` spread. In `create-and-join-room.ts` `toCreateOptions` add
`...(input.lifecyclePolicy === undefined ? {} : { lifecyclePolicy: input.lifecyclePolicy })`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run packages/tests/shared-web/rooms`
Expected: PASS.

- [ ] **Step 5: Document the field**

In `docs/rallar-api-reference.md`, in the `rooms.create(input)` paragraph, extend the object-input
list with `lifecyclePolicy` and one sentence: "`lifecyclePolicy` is the sparse
`GroupLifecyclePolicyInput` described in `docs/rallar-group-formation-architecture.md`; omitting it
creates the group with the `optimistic` preset, exactly as before."

- [ ] **Step 6: Commit**

```bash
git add packages/shared-web/browser/rooms/rallar-room-contracts.ts packages/shared-web/browser/rooms/room-group-state-translation.ts packages/shared-web/browser/rooms/create-and-join-room.ts packages/tests/shared-web/rooms/room-group-state-request-translation.test.ts packages/tests/shared-web/rooms/create-and-join-room.test.ts docs/rallar-api-reference.md
git commit -m "Accept a lifecycle policy when creating a room"
```

### Task 1.3: Command request translation and the lifecycle HTTP API

**Files:**

- Modify: `packages/shared-web/browser/rooms/room-group-state-translation.ts`
- Create: `packages/shared-web/browser/rooms/formation/room-formation-http-api.ts`
- Test: `packages/tests/shared-web/rooms/room-group-state-request-translation.test.ts`,
  `packages/tests/shared-web/rooms/formation/room-formation-http-api.test.ts`

**Interfaces:**

- Produces (translation):

```ts
export type RoomFormationCommand =
    | Readonly<{ command: 'plan' | 'activate' | 'pause' | 'resume' | 'reset' | 'start'; }>
    | Readonly<
        { command: 'connect'; expectedFormationEpoch: number; expectedLayout: GroupLayoutIdentity; }
    >
    | Readonly<{ command: 'reconfigure'; landing: GroupTopologyReconfigureLanding | undefined; }>;
export type RoomFormationCommandName = RoomFormationCommand['command'];
export type RoomFormationGroupStateRequest =
    | MutationActorInput
    | GroupConnectRequest
    | GroupReconfigureRequest;
export interface ToRoomFormationGroupStateRequestInput extends RoomGroupStateMutationActorInput {
    readonly command: RoomFormationCommand;
    readonly reason: string | undefined;
}
export function toRoomFormationGroupStateRequest(
    input: ToRoomFormationGroupStateRequestInput
): RoomFormationGroupStateRequest;
```

- Produces (HTTP): `roomFormationHttpApi.command(input: CommandRoomFormationHttpInput): Promise<GroupSnapshot>`
  where `CommandRoomFormationHttpInput { groupId; command: RoomFormationCommandName; request: RoomFormationGroupStateRequest; options: ApiMutationRequestOptions; scope?: StateScope }`.

- [ ] **Step 1: Write the failing translation test**

```ts
it('translates each formation command into its lifecycle request body', () => {
    expect(
        toRoomFormationGroupStateRequest({
            command: { command: 'plan' },
            reason: undefined,
            ...actor
        })
    ).toEqual(actor);
    expect(
        toRoomFormationGroupStateRequest({
            command: { command: 'pause' },
            reason: 'half-time',
            ...actor
        })
    ).toEqual({ ...actor, reason: 'half-time' });
    expect(
        toRoomFormationGroupStateRequest({
            command: {
                command: 'connect',
                expectedFormationEpoch: 2,
                expectedLayout: {
                    groupRevision: 5,
                    presenceRevision: 3,
                    version: 9,
                    state: 'active'
                }
            },
            reason: undefined,
            ...actor
        })
    ).toEqual({
        ...actor,
        expectedFormationEpoch: 2,
        expectedLayout: { groupRevision: 5, presenceRevision: 3, version: 9, state: 'active' }
    });
    expect(
        toRoomFormationGroupStateRequest({
            command: { command: 'reconfigure', landing: 'hold' },
            reason: undefined,
            ...actor
        })
    ).toEqual({ ...actor, landing: 'hold' });
    expect(
        toRoomFormationGroupStateRequest({
            command: { command: 'reconfigure', landing: undefined },
            reason: undefined,
            ...actor
        })
    ).toEqual(actor);
});
```

- [ ] **Step 2: Write the failing HTTP test**

```ts
// packages/tests/shared-web/rooms/formation/room-formation-http-api.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import { roomFormationHttpApi } from '@shared-web/browser/rooms/formation/room-formation-http-api.ts';

import { createRoomSnapshot } from '../room-workflow-test-runtime.ts';

const scope = { applicationId: 'app-1', workspaceId: 'workspace-1' };

describe('room formation HTTP API', () => {
    beforeEach(() => configureApiClient({ apiBaseUrl: 'https://api.example.test' }));
    afterEach(() => vi.unstubAllGlobals());

    it('posts a lifecycle command under the request-id path and returns the receipt snapshot', async () => {
        const receipt = createRoomSnapshot('room-1', ['session-1']);
        const fetchMock = vi.fn(async () =>
            new Response(JSON.stringify(receipt), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            })
        );
        vi.stubGlobal('fetch', fetchMock);

        const snapshot = await roomFormationHttpApi.command({
            groupId: 'room-1',
            command: 'connect',
            request: {
                actorPrincipalId: 'principal-1',
                actorSessionId: 'session-1',
                expectedFormationEpoch: 1,
                expectedLayout: {
                    groupRevision: 2,
                    presenceRevision: 1,
                    version: 3,
                    state: 'active'
                }
            },
            options: { requestId: 'connect-1' },
            scope
        });

        expect(snapshot).toEqual(receipt);
        expect(fetchMock.mock.calls[0]?.[0]).toBe(
            'https://api.example.test/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/lifecycle/connect/requests/connect-1'
        );
        const init = fetchMock.mock.calls[0]?.[1];
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual({
            actorPrincipalId: 'principal-1',
            actorSessionId: 'session-1',
            expectedFormationEpoch: 1,
            expectedLayout: { groupRevision: 2, presenceRevision: 1, version: 3, state: 'active' }
        });
    });
});
```

- [ ] **Step 3: Run both to verify they fail**

Run: `npx vitest run packages/tests/shared-web/rooms/room-group-state-request-translation.test.ts packages/tests/shared-web/rooms/formation/room-formation-http-api.test.ts`
Expected: FAIL, missing exports and module.

- [ ] **Step 4: Add the translation**

In `room-group-state-translation.ts` add the imports
`import type { GroupTopologyReconfigureLanding } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';`
and `import type { GroupConnectRequest, GroupReconfigureRequest, MutationActorInput } from '@shared/api/state-types.ts';`,
the types from the Interfaces block above, and:

```ts
export function toRoomFormationGroupStateRequest(
    input: ToRoomFormationGroupStateRequestInput
): RoomFormationGroupStateRequest {
    const actor = {
        ...toActorRequest(input),
        ...(input.reason === undefined ? {} : { reason: input.reason })
    };
    switch (input.command.command) {
        case 'connect':
            return {
                ...actor,
                expectedFormationEpoch: input.command.expectedFormationEpoch,
                expectedLayout: input.command.expectedLayout
            };
        case 'reconfigure':
            return input.command.landing === undefined
                ? actor
                : { ...actor, landing: input.command.landing };
        case 'plan':
        case 'activate':
        case 'pause':
        case 'resume':
        case 'reset':
        case 'start':
            return actor;
    }
}
```

- [ ] **Step 5: Add the HTTP module**

```ts
// packages/shared-web/browser/rooms/formation/room-formation-http-api.ts
import { toApiMutationRequestPath } from '@shared/api/mutation/api-mutation-request.ts';

import { readApiBaseUrl } from '../../api-client-config.ts';
import { executeHttpRequest, type ApiMutationRequestOptions } from '../../api/http-request.ts';
import { defaultStateScope, toStateGroupHttpPath } from '../../api/state-http-path.ts';
import type {
    GroupSnapshot,
    RoomFormationCommandName,
    RoomFormationGroupStateRequest,
    StateScope
} from '../room-group-state-translation.ts';

export interface CommandRoomFormationHttpInput {
    readonly groupId: string;
    readonly command: RoomFormationCommandName;
    readonly request: RoomFormationGroupStateRequest;
    readonly options: ApiMutationRequestOptions;
    readonly scope?: StateScope;
}

async function commandStateGroupFormation(
    input: CommandRoomFormationHttpInput
): Promise<GroupSnapshot> {
    const scope = input.scope ?? defaultStateScope();
    return await executeHttpRequest<RoomFormationGroupStateRequest, GroupSnapshot>(
        readApiBaseUrl(),
        toApiMutationRequestPath(
            `${toStateGroupHttpPath(scope, input.groupId)}/lifecycle/${input.command}`,
            input.options.requestId
        ),
        'POST',
        input.request,
        input.options
    );
}

export const roomFormationHttpApi = Object.freeze({
    command: commandStateGroupFormation
});
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run packages/tests/shared-web/rooms`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/shared-web/browser/rooms/room-group-state-translation.ts packages/shared-web/browser/rooms/formation/room-formation-http-api.ts packages/tests/shared-web/rooms/room-group-state-request-translation.test.ts packages/tests/shared-web/rooms/formation/room-formation-http-api.test.ts
git commit -m "Translate and post the lifecycle commands from the browser"
```

### Task 1.4: Layout slots, status projection and the command workflow

**Files:**

- Create: `packages/shared-web/browser/rooms/formation/rallar-room-formation-contracts.ts`
- Create: `packages/shared-web/browser/rooms/formation/room-layout-slots.ts`
- Modify: `packages/shared-web/browser/rooms/room-group-state-translation.ts` (`toRallarRoomLayout`, `toRallarRoomFormationStatus`)
  — _delivered in `room-formation-observation.ts` instead; see "Deviations recorded during delivery"_
- Create: `packages/shared-web/browser/rooms/formation/command-room-formation.ts`
- Create: `packages/shared-web/browser/rooms/formation/room-formation-observation.ts`
- Create: `packages/shared-web/browser/rooms/formation/create-room-formation.ts`
- Create: `packages/tests/shared-web/rooms/formation/room-formation-test-fixtures.ts`
- Test: `packages/tests/shared-web/rooms/room-group-state-translation.test.ts`,
  `packages/tests/shared-web/rooms/formation/create-room-formation.test.ts`

**Interfaces:**

- Produces the public contracts:

```ts
export type RallarRoomLayoutRole = 'planned' | 'accepted';

export interface RallarRoomLayout {
    readonly role: RallarRoomLayoutRole;
    readonly identity: GroupLayoutIdentity;
    readonly overlay: OverlayInfo;
}

export interface RallarRoomFormationStatus {
    readonly roomRef: GroupRef;
    readonly stage: GroupLifecycleState;
    readonly formationEpoch: number;
    readonly formationAttemptCount: number;
    readonly lastFormationOutcome: GroupFormationOutcome | null;
    readonly transportState: GroupTransportState;
    readonly dialing: GroupDialLayoutRoles;
    readonly memberPolicy: GroupMemberPolicy;
    readonly accepted: RallarRoomLayout | undefined;
    readonly planned: RallarRoomLayout | undefined;
    readonly condition: GroupActivationCondition | undefined;
    readonly coverageRate: number | undefined;
    readonly snapshot: GroupSnapshot;
}

export interface RallarRoomFormationCommandOptions extends RallarScopedOperationOptions {
    readonly reason?: string;
}

export interface RallarRoomConnectOptions extends RallarRoomFormationCommandOptions {
    readonly layout?: GroupLayoutIdentity;
}

export interface RallarRoomReconfigureOptions extends RallarRoomFormationCommandOptions {
    readonly landing?: GroupTopologyReconfigureLanding;
}

export interface RallarRoomFormation {
    readonly roomRef: GroupRef;
    status(): RallarRoomFormationStatus | undefined;
    plan(options?: RallarRoomFormationCommandOptions): Promise<GroupSnapshot>;
    connect(options?: RallarRoomConnectOptions): Promise<GroupSnapshot>;
    activate(options?: RallarRoomFormationCommandOptions): Promise<GroupSnapshot>;
    reconfigure(options?: RallarRoomReconfigureOptions): Promise<GroupSnapshot>;
    pause(options?: RallarRoomFormationCommandOptions): Promise<GroupSnapshot>;
    resume(options?: RallarRoomFormationCommandOptions): Promise<GroupSnapshot>;
    reset(options?: RallarRoomFormationCommandOptions): Promise<GroupSnapshot>;
    start(options?: RallarRoomFormationCommandOptions): Promise<GroupSnapshot>;
}
```

The contracts file imports only from `@shared/api/**` and the facade contract modules, never from
the translation module, so the bundle-boundary edge test keeps its type-only guarantee trivially.

- Produces (slots):

```ts
export interface RallarRoomLayoutSlotsPort {
    readPlanned(roomRef: GroupRef): OverlayInfo | undefined;
    readAccepted(roomRef: GroupRef): OverlayInfo | undefined;
    onPlannedChange(listener: OverlayRepositoryChangeListener): RallarUnsubscribe;
    onAcceptedChange(listener: OverlayRepositoryChangeListener): RallarUnsubscribe;
}
export function createRoomLayoutSlots(): RallarRoomLayoutSlotsPort;
```

- _Delivered: the two projections below live in `room-formation-observation.ts`, not in the translation
  module; the signatures are as written._
- Produces (translation): `toRallarRoomLayout(role, overlay, roomRef): RallarRoomLayout | undefined`,
  `toRallarRoomFormationStatus(input: ToRallarRoomFormationStatusInput): RallarRoomFormationStatus`
  with `ToRallarRoomFormationStatusInput { snapshot: GroupSnapshot; planned: OverlayInfo | undefined; accepted: OverlayInfo | undefined }`.

- Produces (workflow): `RoomFormationCommandPorts`, `commandRoomFormation(input: CommandRoomFormationInput): Promise<GroupSnapshot>`,
  `connectRoomFormation(input: ConnectRoomFormationInput): Promise<GroupSnapshot>`.

- Produces (handle): `createRoomFormation(input: CreateRoomFormationInput): RallarRoomFormation`,
  `readRoomFormationStatus(input: ReadRoomFormationStatusInput): RallarRoomFormationStatus | undefined`
  in `room-formation-observation.ts`, the module both the handle and (in slice 2) the waits read through.

- [ ] **Step 1: Write the fixtures**

```ts
// packages/tests/shared-web/rooms/formation/room-formation-test-fixtures.ts
import type { OverlayInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupLifecycleState } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { GroupRef, GroupSnapshot, GroupStateCausalRevision } from '@shared/api/group-types.ts';

import { createRoomSnapshot } from '../room-workflow-test-runtime.ts';

export interface FormationSnapshotFixtureInput {
    readonly stage: GroupLifecycleState;
    readonly formationEpoch: number;
    readonly causalRevision: GroupStateCausalRevision;
    readonly sessionIds?: readonly string[];
}

export function createFormationSnapshot(input: FormationSnapshotFixtureInput): GroupSnapshot {
    const base = createRoomSnapshot('room-1', input.sessionIds ?? ['session-1']);
    return {
        ...base,
        causalRevision: input.causalRevision,
        group: { ...base.group, lifecycleState: input.stage, formationEpoch: input.formationEpoch }
    };
}

export interface LayoutOverlayFixtureInput {
    readonly roomRef: GroupRef;
    readonly causalRevision: GroupStateCausalRevision;
    readonly version: number;
    readonly state?: OverlayInfo['state'];
    readonly peerIds?: readonly string[];
}

export function createLayoutOverlay(input: LayoutOverlayFixtureInput): OverlayInfo {
    return {
        sourceGroupStateCausalRevision: input.causalRevision,
        provenance: 'server',
        state: input.state ?? 'active',
        overlayId: toScopedOverlayId(input.roomRef),
        groupRef: input.roomRef,
        topology: 'tree',
        name: input.roomRef.groupId,
        createdByClientId: 'server',
        createdAtEpochMs: 1,
        nextHopSessionIds: input.peerIds ?? ['peer-a'],
        degreeLimit: 2,
        overlayVersion: input.version,
        updatedAtEpochMs: 1
    };
}
```

- [ ] **Step 2: Write the failing projection test**

Add to `packages/tests/shared-web/rooms/room-group-state-translation.test.ts` (_delivered as
`packages/tests/shared-web/rooms/formation/room-formation-observation.test.ts`_):

```ts
it('projects a formation status from the snapshot and the two layout slots', () => {
    const snapshot = createFormationSnapshot({
        stage: 'reconnecting',
        formationEpoch: 4,
        causalRevision: { groupRevision: 6, presenceRevision: 2 }
    });
    const accepted = createLayoutOverlay({
        roomRef: snapshot.group,
        causalRevision: { groupRevision: 3, presenceRevision: 2 },
        version: 2
    });
    const planned = createLayoutOverlay({
        roomRef: snapshot.group,
        causalRevision: { groupRevision: 6, presenceRevision: 2 },
        version: 5
    });
    const withAcceptedIdentity = {
        ...snapshot,
        group: {
            ...snapshot.group,
            acceptedLayoutIdentity: {
                groupRevision: 3,
                presenceRevision: 2,
                version: 2,
                state: 'active' as const
            }
        }
    };

    const status = toRallarRoomFormationStatus({
        snapshot: withAcceptedIdentity,
        planned,
        accepted
    });

    expect(status.stage).toBe('reconnecting');
    expect(status.dialing).toBe('accepted-and-planned');
    expect(status.accepted?.identity).toEqual({
        groupRevision: 3,
        presenceRevision: 2,
        version: 2,
        state: 'active'
    });
    expect(status.planned?.identity).toEqual({
        groupRevision: 6,
        presenceRevision: 2,
        version: 5,
        state: 'active'
    });
    expect(status.condition).toBeUndefined();
});

it('reports no accepted layout when the slot does not match the snapshot identity, and no planned layout for a tombstone', () => {
    const snapshot = createFormationSnapshot({
        stage: 'active',
        formationEpoch: 2,
        causalRevision: { groupRevision: 3, presenceRevision: 1 }
    });
    const stale = createLayoutOverlay({
        roomRef: snapshot.group,
        causalRevision: { groupRevision: 1, presenceRevision: 1 },
        version: 1
    });
    const tombstone = createLayoutOverlay({
        roomRef: snapshot.group,
        causalRevision: { groupRevision: 3, presenceRevision: 1 },
        version: 4,
        state: 'removed'
    });

    const status = toRallarRoomFormationStatus({ snapshot, planned: tombstone, accepted: stale });

    expect(status.accepted).toBeUndefined();
    expect(status.planned).toBeUndefined();
});
```

(import `createFormationSnapshot`, `createLayoutOverlay` from `./formation/room-formation-test-fixtures.ts`
and `toRallarRoomFormationStatus` from the translation module — _delivered from
`./room-formation-observation.ts`_.)

- [ ] **Step 3: Write the failing handle test**

```ts
// packages/tests/shared-web/rooms/formation/create-room-formation.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { isRallarValidationError } from '@shared/api/rallar-validation.ts';
import {
    configureOverlayRepositories,
    setPlannedOverlayById
} from '@shared/repository/overlays-repository.ts';
import { toError } from '@shared/resilience/to-error.ts';

import {
    readRoomWorkflowMocks,
    resetRoomWorkflowTestRuntime,
    seedRoomSnapshots
} from '../room-workflow-test-runtime.ts';
import { createFormationSnapshot, createLayoutOverlay } from './room-formation-test-fixtures.ts';

const roomWorkflowMocks = readRoomWorkflowMocks();

function stubReceipt(receipt: unknown) {
    const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify(receipt), {
            status: 200,
            headers: { 'content-type': 'application/json' }
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

describe('room formation commands', () => {
    beforeEach(() => {
        resetRoomWorkflowTestRuntime();
        configureApiClient({ apiBaseUrl: 'https://api.example.test' });
        configureOverlayRepositories({
            plannedOverlays: { ttlMs: 60_000 },
            acceptedOverlays: { ttlMs: 60_000 }
        });
    });
    afterEach(() => vi.unstubAllGlobals());

    it('plans through the bound room and accepts the receipt into the cache', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const forming = createFormationSnapshot({
            stage: 'forming',
            formationEpoch: 0,
            causalRevision: { groupRevision: 1, presenceRevision: 1 }
        });
        const planned = createFormationSnapshot({
            stage: 'planned',
            formationEpoch: 1,
            causalRevision: { groupRevision: 2, presenceRevision: 1 }
        });
        seedRoomSnapshots([forming]);
        const fetchMock = stubReceipt(planned);

        const receipt = await createRallarFacade().rooms.formation('room-1').plan({
            reason: 'lobby ready'
        });

        expect(receipt).toEqual(planned);
        expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(
            /^https:\/\/api\.example\.test\/api\/state\/apps\/app-1\/workspaces\/workspace-1\/groups\/room-1\/lifecycle\/plan\/requests\/[0-9a-f-]{36}$/
        );
        expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
            actorPrincipalId: roomWorkflowMocks.session.clientId,
            actorSessionId: roomWorkflowMocks.session.sessionId,
            reason: 'lobby ready'
        });
        expect(roomWorkflowMocks.operationLog).toContain('hydrate:room-1');
        expect(createRallarFacade().rooms.formation('room-1').status()?.stage).toBe('planned');
    });

    it('connects the current planned layout with the cached epoch', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const planned = createFormationSnapshot({
            stage: 'planned',
            formationEpoch: 1,
            causalRevision: { groupRevision: 2, presenceRevision: 1 }
        });
        seedRoomSnapshots([planned]);
        setPlannedOverlayById(
            toScopedOverlayId(planned.group),
            createLayoutOverlay({
                roomRef: planned.group,
                causalRevision: { groupRevision: 2, presenceRevision: 1 },
                version: 3
            })
        );
        const fetchMock = stubReceipt(
            createFormationSnapshot({
                stage: 'connecting',
                formationEpoch: 2,
                causalRevision: { groupRevision: 3, presenceRevision: 1 }
            })
        );

        await createRallarFacade().rooms.formation(planned.group).connect();

        expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
            actorPrincipalId: roomWorkflowMocks.session.clientId,
            actorSessionId: roomWorkflowMocks.session.sessionId,
            expectedFormationEpoch: 1,
            expectedLayout: { groupRevision: 2, presenceRevision: 1, version: 3, state: 'active' }
        });
    });

    it('refuses to connect locally when no planned layout exists after a read-through', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const planned = createFormationSnapshot({
            stage: 'planned',
            formationEpoch: 1,
            causalRevision: { groupRevision: 2, presenceRevision: 1 }
        });
        seedRoomSnapshots([planned]);
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            if (String(input).endsWith('/topology')) {
                return new Response(
                    JSON.stringify({
                        groupRef: planned.group,
                        overlayId: toScopedOverlayId(planned.group),
                        snapshot: null,
                        acceptedSnapshot: null,
                        config: {
                            serverDefaults: {
                                topologyKind: 'auto',
                                degreeLimit: 5,
                                treeMinSize: 3,
                                meshMinSize: 8,
                                meshParamK: 2
                            },
                            durable: null,
                            temporary: null,
                            requestOptions: null,
                            effective: {
                                topologyKind: 'auto',
                                degreeLimit: 5,
                                treeMinSize: 3,
                                meshMinSize: 8,
                                meshParamK: 2
                            }
                        },
                        pending: null
                    }),
                    { status: 200, headers: { 'content-type': 'application/json' } }
                );
            }
            return new Response(JSON.stringify(planned), {
                status: 200,
                headers: {
                    'cache-control': 'no-store',
                    'content-type': 'application/json',
                    'rallar-state-source': 'durable',
                    'rallar-group-revision': '2',
                    'rallar-presence-revision': '1'
                }
            });
        });
        vi.stubGlobal('fetch', fetchMock);
        let thrown: Error | undefined;

        try {
            await createRallarFacade().rooms.formation(planned.group).connect();
        }
        catch (error) {
            thrown = toError(error);
        }

        expect(isRallarValidationError(thrown)).toBe(true);
        expect(thrown).toMatchObject({ issues: [{ path: '$.layout', code: 'no-planned-layout' }] });
        expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
            'https://api.example.test/api/state/apps/app-1/workspaces/workspace-1/groups/room-1',
            'https://api.example.test/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/topology'
        ]);
    });

    it('sends an explicit layout and a reconfigure landing verbatim', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const active = createFormationSnapshot({
            stage: 'active',
            formationEpoch: 3,
            causalRevision: { groupRevision: 5, presenceRevision: 2 }
        });
        seedRoomSnapshots([active]);
        const fetchMock = stubReceipt(active);
        const formation = createRallarFacade().rooms.formation(active.group);

        await formation.reconfigure({ landing: 'hold' });
        await formation.connect({
            layout: { groupRevision: 6, presenceRevision: 2, version: 8, state: 'active' }
        });

        expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
            landing: 'hold'
        });
        expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
            expectedFormationEpoch: 3,
            expectedLayout: { groupRevision: 6, presenceRevision: 2, version: 8, state: 'active' }
        });
    });
});
```

- [ ] **Step 4: Run them to verify they fail**

Run: `npx vitest run packages/tests/shared-web/rooms/room-group-state-translation.test.ts packages/tests/shared-web/rooms/formation/create-room-formation.test.ts`
Expected: FAIL, `rooms.formation` and the projections do not exist.
_(Delivered: the projection test is `packages/tests/shared-web/rooms/formation/room-formation-observation.test.ts`.)_

- [ ] **Step 5: Add the contracts file** with the types from the Interfaces block, importing
      `OverlayInfo` from `@shared/api/api-config.ts`, `GroupActivationCondition` from
      `@shared/api/group-lifecycle/activation-status/compute-group-activation-condition.ts`,
      `GroupLayoutIdentity` from `@shared/api/group-lifecycle/group-layout-identity.ts`,
      `GroupFormationOutcome`, `GroupLifecycleState`, `GroupMemberPolicy`, `GroupTopologyReconfigureLanding`,
      `GroupTransportState` from `@shared/api/group-lifecycle/group-lifecycle-policy.ts`,
      `GroupDialLayoutRoles` from `@shared/api/group-lifecycle/resolve-dial-layout-roles.ts`, `GroupRef`,
      `GroupSnapshot` from `@shared/api/group-types.ts`, and `RallarScopedOperationOptions` from
      `@shared-web/browser/rallar-connection-facade.ts`.

- [ ] **Step 6: Add the slots port**

```ts
// packages/shared-web/browser/rooms/formation/room-layout-slots.ts
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import type { OverlayInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { readConfiguredValue } from '@shared/cache/RepositoryManager.ts';
import {
    onAcceptedOverlayChange,
    onPlannedOverlayChange,
    readableAcceptedOverlayCache,
    readablePlannedOverlayCache,
    type OverlayRepositoryChangeListener
} from '@shared/repository/overlays-repository.ts';

export interface RallarRoomLayoutSlotsPort {
    readPlanned(roomRef: GroupRef): OverlayInfo | undefined;
    readAccepted(roomRef: GroupRef): OverlayInfo | undefined;
    onPlannedChange(listener: OverlayRepositoryChangeListener): RallarUnsubscribe;
    onAcceptedChange(listener: OverlayRepositoryChangeListener): RallarUnsubscribe;
}

/**
 * The overlay repositories exist only after connect configures them. A read
 * before that is an ordinary "no layout yet", and a subscription before that
 * observes nothing until the state cache change that follows connect re-reads
 * the slots through the same port.
 */
export function createRoomLayoutSlots(): RallarRoomLayoutSlotsPort {
    return {
        readPlanned: (roomRef) =>
            readConfiguredValue(() =>
                readablePlannedOverlayCache().read(toScopedOverlayId(roomRef))
            ),
        readAccepted: (roomRef) =>
            readConfiguredValue(() =>
                readableAcceptedOverlayCache().read(toScopedOverlayId(roomRef))
            ),
        onPlannedChange: (listener) =>
            readConfiguredValue(() => onPlannedOverlayChange(listener)) ?? (() => {}),
        onAcceptedChange: (listener) =>
            readConfiguredValue(() => onAcceptedOverlayChange(listener)) ?? (() => {})
    };
}
```

- [ ] **Step 7: Add the projections to the translation module** (_delivered in
      `room-formation-observation.ts`; see "Deviations recorded during delivery"_)

Imports to add: `import { isSameGroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';`
is not needed; use `isOverlayIdentity` and `toOverlayLayoutIdentity` from
`@shared/repository/overlays-repository.ts` and `resolveDialLayoutRoles` from
`@shared/api/group-lifecycle/resolve-dial-layout-roles.ts`, plus the public types from
`./formation/rallar-room-formation-contracts.ts` (type imports only).

```ts
export interface ToRallarRoomFormationStatusInput {
    readonly snapshot: GroupSnapshot;
    readonly planned: OverlayInfo | undefined;
    readonly accepted: OverlayInfo | undefined;
}

export function toRallarRoomLayout(
    role: RallarRoomLayoutRole,
    overlay: OverlayInfo | undefined,
    roomRef: GroupRef
): RallarRoomLayout | undefined {
    if (
        overlay === undefined ||
        overlay.provenance !== 'server' ||
        overlay.state !== 'active' ||
        !isSameGroupRef(overlay.groupRef, roomRef)
    ) {
        return undefined;
    }
    return { role, identity: toOverlayLayoutIdentity(overlay), overlay };
}

export function toRallarRoomFormationStatus(
    input: ToRallarRoomFormationStatusInput
): RallarRoomFormationStatus {
    const { group } = input.snapshot;
    const acceptedIdentity = group.acceptedLayoutIdentity;
    const acceptedMatchesSnapshot = acceptedIdentity !== null &&
        input.accepted !== undefined &&
        isOverlayIdentity(input.accepted, acceptedIdentity);
    return {
        roomRef: group,
        stage: group.lifecycleState,
        formationEpoch: group.formationEpoch,
        formationAttemptCount: group.formationAttemptCount,
        lastFormationOutcome: group.lastFormationOutcome,
        transportState: group.transportState,
        dialing: resolveDialLayoutRoles(group.lifecycleState),
        memberPolicy: group.memberPolicy,
        accepted: acceptedMatchesSnapshot
            ? toRallarRoomLayout('accepted', input.accepted, group)
            : undefined,
        planned: toRallarRoomLayout('planned', input.planned, group),
        condition: group.activationStatus?.condition,
        coverageRate: group.activationStatus?.coverageRate,
        snapshot: input.snapshot
    };
}
```

- [ ] **Step 8: Add the command workflow**

```ts
// packages/shared-web/browser/rooms/formation/command-room-formation.ts
import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import {
    toRallarCommandOptions,
    type RallarOperationOptions
} from '@shared-web/browser/rallar-operation-options.ts';
import { throwRallarValidationIssue } from '@shared-web/browser/rooms/rallar-room-validation.ts';
import type { RallarStateSnapshotAcceptanceInput } from '@shared-web/browser/state-cache/rallar-state-store.ts';
import { toApiMutationWorkflowRequestId } from '@shared-web/browser/state-read/state-workflow-support.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { toStateScope } from '@shared/api/api-type-utils.ts';
import type { GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import { Command } from '@shared/cache/Command.ts';

import {
    toRallarRoomLayout, // delivered from ./room-formation-observation.ts; see the deviations section
    toRoomFormationGroupStateRequest,
    type GroupRef,
    type GroupSnapshot,
    type RoomFormationCommand
} from '../room-group-state-translation.ts';
import type { RallarRoomStateStorePort } from '../room-state-store.ts';
import type {
    RallarRoomConnectOptions,
    RallarRoomFormationCommandOptions
} from './rallar-room-formation-contracts.ts';
import { roomFormationHttpApi } from './room-formation-http-api.ts';
import type { RallarRoomLayoutSlotsPort } from './room-layout-slots.ts';

export interface RoomFormationCommandPorts {
    readonly stateStore: RallarRoomStateStorePort;
    readonly slots: RallarRoomLayoutSlotsPort;
    readonly refreshRoom: (roomRef: GroupRef) => Promise<void>;
    readonly connect: (options?: RallarOperationOptions) => Promise<ApiMiddleware>;
    readonly requireSession: () => AuthSession;
    readonly resolveOperationOptions: <T extends RallarOperationOptions>(
        options: T
    ) => T & RallarOperationOptions;
    readonly runAuthAwareOperation: <T>(operation: () => Promise<T>) => Promise<T>;
    readonly acceptSnapshots: (input: RallarStateSnapshotAcceptanceInput) => Promise<void>;
}

export interface CommandRoomFormationInput {
    readonly roomRef: GroupRef;
    readonly command: RoomFormationCommand;
    readonly options: RallarRoomFormationCommandOptions;
    readonly ports: RoomFormationCommandPorts;
}

export interface ConnectRoomFormationInput {
    readonly roomRef: GroupRef;
    readonly options: RallarRoomConnectOptions;
    readonly ports: RoomFormationCommandPorts;
}

interface ConnectFence {
    readonly expectedFormationEpoch: number;
    readonly expectedLayout: GroupLayoutIdentity;
}

export async function commandRoomFormation(
    input: CommandRoomFormationInput
): Promise<GroupSnapshot> {
    const { ports } = input;
    return await ports.runAuthAwareOperation(async () => {
        const operationOptions = ports.resolveOperationOptions(input.options);
        const context = await ports.connect(operationOptions);
        const session = ports.requireSession();
        const scope = input.options.scope ?? toStateScope(input.roomRef);
        const request = toRoomFormationGroupStateRequest({
            command: input.command,
            reason: input.options.reason,
            actorPrincipalId: session.clientId,
            actorSessionId: session.sessionId
        });
        const requestId = toApiMutationWorkflowRequestId();

        const snapshot = await new Command<GroupSnapshot>(
            (signal) =>
                roomFormationHttpApi.command({
                    groupId: input.roomRef.groupId,
                    command: input.command.command,
                    request,
                    options: { requestId, signal },
                    scope
                }),
            toRallarCommandOptions(operationOptions)
        ).run();
        await ports.acceptSnapshots({ context, clients: [], groups: [snapshot], scope });
        return snapshot;
    });
}

export async function connectRoomFormation(
    input: ConnectRoomFormationInput
): Promise<GroupSnapshot> {
    const fence = await readConnectFence(input);
    return await commandRoomFormation({
        roomRef: input.roomRef,
        command: { command: 'connect', ...fence },
        options: input.options,
        ports: input.ports
    });
}

async function readConnectFence(input: ConnectRoomFormationInput): Promise<ConnectFence> {
    const cached = resolveConnectFence(input);
    if (cached) {
        return cached;
    }
    await input.ports.refreshRoom(input.roomRef);
    const refreshed = resolveConnectFence(input);
    if (refreshed) {
        return refreshed;
    }
    throwRallarValidationIssue(
        '$.layout',
        'no-planned-layout',
        'Cannot connect room formation: no planned layout is published for this room.'
    );
}

function resolveConnectFence(input: ConnectRoomFormationInput): ConnectFence | undefined {
    const snapshot = input.ports.stateStore.findGroupSnapshot(input.roomRef);
    const expectedLayout = input.options.layout ??
        toRallarRoomLayout('planned', input.ports.slots.readPlanned(input.roomRef), input.roomRef)
            ?.identity;
    if (!snapshot || !expectedLayout) {
        return undefined;
    }
    return { expectedFormationEpoch: snapshot.group.formationEpoch, expectedLayout };
}
```

- [ ] **Step 9: Add the handle factory**

```ts
// packages/shared-web/browser/rooms/formation/room-formation-observation.ts
import { toRallarRoomFormationStatus, type GroupRef } from '../room-group-state-translation.ts';
import type { RallarRoomStateStorePort } from '../room-state-store.ts';
import type { RallarRoomFormationStatus } from './rallar-room-formation-contracts.ts';
import type { RallarRoomLayoutSlotsPort } from './room-layout-slots.ts';

export interface ReadRoomFormationStatusInput {
    readonly roomRef: GroupRef;
    readonly stateStore: RallarRoomStateStorePort;
    readonly slots: RallarRoomLayoutSlotsPort;
}

export function readRoomFormationStatus(
    input: ReadRoomFormationStatusInput
): RallarRoomFormationStatus | undefined {
    const snapshot = input.stateStore.findGroupSnapshot(input.roomRef);
    if (!snapshot) {
        return undefined;
    }
    return toRallarRoomFormationStatus({
        snapshot,
        planned: input.slots.readPlanned(input.roomRef),
        accepted: input.slots.readAccepted(input.roomRef)
    });
}
```

```ts
// packages/shared-web/browser/rooms/formation/create-room-formation.ts
import type { GroupRef, RoomFormationCommand } from '../room-group-state-translation.ts';
import {
    commandRoomFormation,
    connectRoomFormation,
    type RoomFormationCommandPorts
} from './command-room-formation.ts';
import type {
    RallarRoomFormation,
    RallarRoomFormationCommandOptions
} from './rallar-room-formation-contracts.ts';
import { readRoomFormationStatus } from './room-formation-observation.ts';

export interface CreateRoomFormationInput extends RoomFormationCommandPorts {
    readonly roomRef: GroupRef;
}

export function createRoomFormation(input: CreateRoomFormationInput): RallarRoomFormation {
    const submit = async (
        command: RoomFormationCommand,
        options: RallarRoomFormationCommandOptions = {}
    ) => await commandRoomFormation({ roomRef: input.roomRef, command, options, ports: input });

    return {
        roomRef: input.roomRef,
        status: () => readRoomFormationStatus(input),
        plan: async (options) => await submit({ command: 'plan' }, options),
        connect: async (options = {}) =>
            await connectRoomFormation({ roomRef: input.roomRef, options, ports: input }),
        activate: async (options) => await submit({ command: 'activate' }, options),
        reconfigure: async (options = {}) =>
            await submit({ command: 'reconfigure', landing: options.landing }, options),
        pause: async (options) => await submit({ command: 'pause' }, options),
        resume: async (options) => await submit({ command: 'resume' }, options),
        reset: async (options) => await submit({ command: 'reset' }, options),
        start: async (options) => await submit({ command: 'start' }, options)
    };
}
```

- [ ] **Step 10: Wire the handle into the rooms facade, the session and the composition roots**

In `browser-rallar-rooms.ts`: add `readonly roomLayoutSlots: RallarRoomLayoutSlotsPort;` to
`CreateBrowserRallarRoomsInput`; add `formation(room?: string | GroupRef): RallarRoomFormation;` to
`BrowserRallarRooms`; add `readonly createFormation: (roomRef: GroupRef) => RallarRoomFormation;` to
`CreateRoomEntryOperationsInput`; in `createBrowserRallarRooms` build

```ts
const createFormation = (roomRef: GroupRef): RallarRoomFormation =>
    createRoomFormation({
        roomRef,
        stateStore: input.stateStore,
        slots: input.roomLayoutSlots,
        refreshRoom: async (target) => await refreshRoom(input, target),
        connect: input.connect,
        requireSession: input.requireSession,
        resolveOperationOptions: input.resolveOperationOptions,
        runAuthAwareOperation: input.runAuthAwareOperation,
        acceptSnapshots: input.acceptSnapshots
    });
```

before `createSession`, pass `createFormation` into `createRoomSession({...})` and into
`createRoomEntryOperations({...})`, and add `'formation'` to that function's `Pick` with
`formation: (room) => input.createFormation(resolveRoomSessionRef(input.rooms, room, input.resolveRoomRef))`.

In `room-session.ts`: add `readonly createFormation: (roomRef: GroupRef) => RallarRoomFormation;` to
`CreateRoomSessionInput` and `formation: input.createFormation(input.roomRef),` to the returned
session; in `rallar-room-contracts.ts` add `readonly formation: RallarRoomFormation;` to
`RallarRoomSession` (type import from `./formation/rallar-room-formation-contracts.ts`).

In `browser-runtime-composition.ts`: add `readonly roomLayoutSlots: RallarRoomLayoutSlotsPort;` to
`BrowserStateComposition`, create it with `createRoomLayoutSlots()` at the top of
`createBrowserStateComposition`, and return it. In `browser-product-composition.ts` pass
`roomLayoutSlots: input.state.roomLayoutSlots` into `createBrowserRallarRooms`.

Search the tests for other constructions of `createBrowserRallarRooms` and `createRoomSession`
(`rg -n "createBrowserRallarRooms\(|createRoomSession\(" packages/tests`) and add the two new
inputs there.

- [ ] **Step 11: Run the tests**

Run: `npx vitest run packages/tests/shared-web/rooms`
Expected: PASS, including the four new handle tests.

- [ ] **Step 12: Commit**

```bash
git add packages/shared-web/browser/rooms packages/shared-web/browser/composition packages/tests/shared-web/rooms
git commit -m "Add the room formation handle with the eight lifecycle commands"
```

### Task 1.5: The denial reader

**Files:**

- Create: `packages/shared-web/browser/rooms/formation/to-room-formation-denial.ts`
- Modify: `packages/shared-web/browser/rooms/formation/rallar-room-formation-contracts.ts`
- Test: `packages/tests/shared-web/rooms/formation/to-room-formation-denial.test.ts`

**Interfaces:**

```ts
export type RallarRoomFormationDenial =
    | Readonly<{ kind: 'policy'; code: GroupPolicyReasonCode; message: string; }>
    | Readonly<{ kind: 'layout'; code: GroupConnectRejectionCode; message: string; }>;
export function toRoomFormationDenial(error: unknown): RallarRoomFormationDenial | undefined;
```

- [ ] **Step 1: Write the failing test**

```ts
// packages/tests/shared-web/rooms/formation/to-room-formation-denial.test.ts
import { describe, expect, it } from 'vitest';

import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';
import { toRoomFormationDenial } from '@shared-web/browser/rooms/formation/to-room-formation-denial.ts';

function toFailureBody(code: string, status: number, denial: boolean): string {
    return JSON.stringify({
        type: 'api-mutation-failure',
        version: 'canonical.v2',
        code,
        status,
        message: `Rejected: ${code}`,
        issues: null,
        denial: denial ? { code, message: `Rejected: ${code}`, details: null } : null,
        retry: null
    });
}

describe('room formation denial reader', () => {
    it('classifies a policy denial', () => {
        const error = new ApiHttpError(
            'POST',
            '/lifecycle/plan',
            403,
            toFailureBody('lifecycle-transition-invalid', 403, true)
        );
        expect(toRoomFormationDenial(error)).toEqual({
            kind: 'policy',
            code: 'lifecycle-transition-invalid',
            message: 'Rejected: lifecycle-transition-invalid'
        });
    });

    it('classifies a connect layout conflict', () => {
        const error = new ApiHttpError(
            'POST',
            '/lifecycle/connect',
            409,
            toFailureBody('group-connect-planned-layout-superseded', 409, false)
        );
        expect(toRoomFormationDenial(error)).toEqual({
            kind: 'layout',
            code: 'group-connect-planned-layout-superseded',
            message: 'Rejected: group-connect-planned-layout-superseded'
        });
    });

    it('returns undefined for anything else', () => {
        expect(toRoomFormationDenial(new Error('network'))).toBeUndefined();
        expect(
            toRoomFormationDenial(
                new ApiHttpError(
                    'POST',
                    '/lifecycle/connect',
                    400,
                    toFailureBody('group-mutation-rejected', 400, false)
                )
            )
        ).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/tests/shared-web/rooms/formation/to-room-formation-denial.test.ts`
Expected: FAIL, module missing.

- [ ] **Step 3: Implement**

```ts
// packages/shared-web/browser/rooms/formation/to-room-formation-denial.ts
import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';
import { isGroupConnectRejectionCode } from '@shared/api/group-lifecycle/group-connect-rejection-codes.ts';
import { isGroupPolicyReasonCode } from '@shared/api/group-policy-types.ts';

import type { RallarRoomFormationDenial } from './rallar-room-formation-contracts.ts';

export function toRoomFormationDenial(error: unknown): RallarRoomFormationDenial | undefined {
    if (!(error instanceof ApiHttpError) || error.mutationFailure === undefined) {
        return undefined;
    }
    const { code, message } = error.mutationFailure;
    if (isGroupConnectRejectionCode(code)) {
        return { kind: 'layout', code, message };
    }
    if (isGroupPolicyReasonCode(code)) {
        return { kind: 'policy', code, message };
    }
    return undefined;
}
```

Add the `RallarRoomFormationDenial` union to the contracts file (imports `GroupPolicyReasonCode`
from `@shared/api/group-policy-types.ts` and `GroupConnectRejectionCode` from the shared codes module).

- [ ] **Step 4: Run the test**

Run: `npx vitest run packages/tests/shared-web/rooms/formation`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared-web/browser/rooms/formation packages/tests/shared-web/rooms/formation
git commit -m "Classify lifecycle command denials for browser applications"
```

### Task 1.6: Public exports, boundary tests, budgets and reference docs

**Files:**

- Modify: `packages/shared-web/browser/rallar-facade-contract.ts:25-44`
- Modify: `packages/shared-web/browser/rallar.ts`, `packages/shared-web/browser/rallar-core.ts`
- Modify: `packages/tests/shared-web/shared-web-public-api-snapshots.test.ts`
- Modify: `packages/tests/shared-web/shared-web-browser-entrypoints.test.ts:80-95`
- Modify: `packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts:39-45`,
  `packages/shared-web/scripts/measure-browser-bundles.mjs:32-35`,
  `packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts:54-62`
- Modify: `docs/rallar-api-reference.md` (Rooms section)

- [ ] **Step 1: Export the surface**

In `rallar-facade-contract.ts` add
`export type * from '@shared-web/browser/rooms/formation/rallar-room-formation-contracts.ts';` in
alphabetical position among the `export type *` lines. In `rallar.ts` add
`export { toRoomFormationDenial } from '@shared-web/browser/rooms/formation/to-room-formation-denial.ts';`
after the readiness value exports, and add these names to the sorted type list:
`RallarRoomConnectOptions`, `RallarRoomFormation`, `RallarRoomFormationCommandOptions`,
`RallarRoomFormationDenial`, `RallarRoomFormationStatus`, `RallarRoomLayout`, `RallarRoomLayoutRole`,
`RallarRoomReconfigureOptions`. Add the same eight names to the type list in `rallar-core.ts`.

- [ ] **Step 2: Run the surface tests to read the expected diff**

Run: `npx vitest run packages/tests/shared-web/shared-web-public-api-snapshots.test.ts packages/tests/shared-web/shared-web-browser-entrypoints.test.ts`
Expected: the snapshot test FAILS listing exactly the eight types (plus the value
`toRoomFormationDenial` on `rallar.ts`) as unexpected; the entrypoints test passes or names the
formation contracts module. Add the names to the `expected` lists for `rallar.ts` and
`rallar-core.ts` in sorted position and, when the entrypoints test enumerates public facade modules
for a type-only check (read its `PUBLIC_FACADE_MODULES` block before deciding), add
`packages/shared-web/browser/rooms/formation/rallar-room-formation-contracts.ts` there. Re-run until
both pass.

- [ ] **Step 3: Measure and set the budgets**

Run: `npm --workspace @ar-eye-hunter/shared-web run measure:browser-bundles` and

```bash
npx esbuild apps/rallar-black-box-headless/src/main.ts --bundle --minify --format=esm --platform=browser --target=es2023 --tsconfig=apps/rallar-black-box-headless/tsconfig.json --outfile="$TMPDIR/headless.js" --log-level=warning && node -e "const fs=require('fs'),z=require('zlib');console.log((z.brotliCompressSync(fs.readFileSync(process.env.TMPDIR+'/headless.js'),{params:{[z.constants.BROTLI_PARAM_QUALITY]:11}}).length/1024).toFixed(3),'KiB')"
```

Set `brotliBudgetKiB` for `browser/rallar.ts` in both `measure-browser-bundles.mjs` and
`shared-web-browser-bundle-boundaries.test.ts` to the smallest whole KiB strictly above the measured
figure when it exceeds 176, and raise the `toBeLessThan` limit in `headless-bundle-boundary.test.ts`
the same way, extending its comment with one sentence naming the formation surface and the measured
figure. Record both measurements in the PR body.

- [ ] **Step 4: Run the boundary gates**

Run: `npx vitest run packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts && npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`
Expected: PASS.

- [ ] **Step 5: Document the commands**

In `docs/rallar-api-reference.md`, after the `RallarRoomSession` paragraph in `### Rooms`, add:

```markdown
`rooms.formation(room?)` returns a `RallarRoomFormation` bound to an explicit room, the default
room, or the current room; `RallarRoomSession` exposes the same handle as `formation`. It carries
the eight application-facing formation commands of the group lifecycle
(`docs/rallar-group-formation-architecture.md`): `plan()`, `connect(options?)`, `activate()`,
`reconfigure({ landing? })`, `pause()`, `resume()`, `reset()` and `start()`. Each resolves to the
receipt `GroupSnapshot` once the transition committed; planning, publication and RTC readiness stay
asynchronous. `connect()` names the room's current planned layout and the cached formation epoch;
pass `layout` to name a specific `GroupLayoutIdentity`. When no planned layout is published the
call throws a `RallarValidationError` issue `no-planned-layout` before any request is sent.
`formation.status()` is the free, in-memory view: stage, epoch, attempt count, transport state,
which layout roles the browser dials, the accepted and planned layouts it holds, and the pushed
activation condition. Commands reject with `ApiHttpError`; `toRoomFormationDenial(error)`
classifies it as `{ kind: 'policy', code }` for a stage or initiator denial or
`{ kind: 'layout', code }` for `group-connect-no-planned-layout` and
`group-connect-planned-layout-superseded`, the two typed `409` conflicts of `connect`.
```

Do not write the backticked constant name of the policy reason-code registry inside this paragraph:
`rallar-group-documentation.test.ts` slices the document from that constant's first occurrence and
requires every kebab token inside the slice to be a policy code.

- [ ] **Step 6: Run the slice gates** listed under "Slice 1", then commit

```bash
git add packages/shared-web/browser packages/shared-web/scripts/measure-browser-bundles.mjs packages/tests docs/rallar-api-reference.md
git commit -m "Expose the room formation handle on the browser facade"
```

---

## Slice 2 — Observation and waits

**Outcome:** the explicit wait for a layout (product decision 16), stage and condition waits, change
and layout subscriptions, and the formation view read. After this slice the product plan's browser
sketch runs end to end against a real server.

**Gates:** the Slice 1 list. `npm run test:deno` and `deno task check` remain because the validator
lands in `packages/shared`.

### Task 2.1: Extract the cache-driven wait engine from the presence wait

**Files:**

- Create: `packages/shared-web/browser/rooms/wait-for-room-change.ts`
- Modify: `packages/shared-web/browser/rooms/room-presence.ts:113-151`
- Test: `packages/tests/shared-web/rooms/room-presence.test.ts` (unchanged; it pins the behaviour)

**Interfaces:**

```ts
export interface WaitForRoomChangeInput<T> {
    readonly readResult: () => T;
    readonly isSettled: (result: T) => boolean;
    readonly subscribe: (listener: () => void | Promise<void>) => RallarUnsubscribe;
    readonly signal: AbortSignal | undefined;
    readonly timeoutMs: number;
    readonly toTimedOut: () => T;
    readonly toAborted: () => T;
}
export async function waitForRoomChange<T>(input: WaitForRoomChangeInput<T>): Promise<T>;
```

- [ ] **Step 1: Run the presence tests to record the baseline**

Run: `npx vitest run packages/tests/shared-web/rooms/room-presence.test.ts`
Expected: PASS (this is the behaviour the extraction must keep).

- [ ] **Step 2: Write the engine**

```ts
// packages/shared-web/browser/rooms/wait-for-room-change.ts
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';

export interface WaitForRoomChangeInput<T> {
    readonly readResult: () => T;
    readonly isSettled: (result: T) => boolean;
    readonly subscribe: (listener: () => void | Promise<void>) => RallarUnsubscribe;
    readonly signal: AbortSignal | undefined;
    readonly timeoutMs: number;
    readonly toTimedOut: () => T;
    readonly toAborted: () => T;
}

/** Resolves on the first settled read, re-reading on every subscribed change. */
export async function waitForRoomChange<T>(input: WaitForRoomChangeInput<T>): Promise<T> {
    const current = input.readResult();
    if (input.isSettled(current)) {
        return current;
    }
    if (input.signal?.aborted) {
        return input.toAborted();
    }
    if (input.timeoutMs <= 0) {
        return input.toTimedOut();
    }
    return await new Promise<T>((resolve) => {
        let settled = false;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let unsubscribe: RallarUnsubscribe = () => {};
        const finish = (result: T): void => {
            if (settled) {
                return;
            }
            settled = true;
            if (timeout !== undefined) {
                clearTimeout(timeout);
            }
            input.signal?.removeEventListener('abort', onAbort);
            unsubscribe();
            resolve(result);
        };
        const onAbort = (): void => finish(input.toAborted());
        unsubscribe = input.subscribe(() => {
            const next = input.readResult();
            if (input.isSettled(next)) {
                finish(next);
            }
        });
        input.signal?.addEventListener('abort', onAbort, { once: true });
        const next = input.readResult();
        if (input.isSettled(next)) {
            finish(next);
            return;
        }
        if (input.signal?.aborted) {
            onAbort();
            return;
        }
        timeout = setTimeout(() => finish(input.toTimedOut()), input.timeoutMs);
    });
}
```

- [ ] **Step 3: Rewrite the presence wait on it**

Replace the body of `waitForRoomPresence` from `const current = readResult();` onward and delete
`waitForRoomPresenceChange` and `WaitForRoomPresenceChangeInput`:

```ts
return await waitForRoomChange({
    readResult: () => readResult(),
    isSettled: isTerminalReadinessWaitResult,
    subscribe: input.onCacheChange,
    signal: operationOptions.signal,
    timeoutMs: normalizeWaitTimeoutMs(options.timeoutMs),
    toTimedOut: () => readResult('timeout'),
    toAborted: () => ({ ...readResult(), status: 'aborted' })
});
```

- [ ] **Step 4: Run the presence tests**

Run: `npx vitest run packages/tests/shared-web/rooms/room-presence.test.ts`
Expected: PASS, unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/shared-web/browser/rooms/wait-for-room-change.ts packages/shared-web/browser/rooms/room-presence.ts
git commit -m "Extract the cache-driven room wait engine"
```

### Task 2.2: Stage and condition waits

**Files:**

- Create: `packages/shared-web/browser/rooms/formation/wait-for-room-formation.ts`
- Modify: `packages/shared-web/browser/rooms/formation/room-formation-observation.ts`
- Modify: `packages/shared-web/browser/rooms/formation/rallar-room-formation-contracts.ts`
- Modify: `packages/shared-web/browser/rooms/formation/create-room-formation.ts`
- Test: `packages/tests/shared-web/rooms/formation/wait-for-room-formation.test.ts`

**Interfaces:**

```ts
export type RallarRoomFormationWaitStatus = 'ready' | 'timeout' | 'aborted' | 'not-found';

export interface RallarRoomFormationWaitResult {
    readonly status: RallarRoomFormationWaitStatus;
    readonly roomRef: GroupRef;
    readonly formation: RallarRoomFormationStatus | undefined;
}

// on RallarRoomFormation:
waitForStage(stage: GroupLifecycleState | readonly GroupLifecycleState[], options?: RallarScopedOperationOptions): Promise<RallarRoomFormationWaitResult>;
waitForCondition(condition: GroupActivationCondition | readonly GroupActivationCondition[], options?: RallarScopedOperationOptions): Promise<RallarRoomFormationWaitResult>;
```

and, in the observation module (`subscribeRoomFormation`) and the wait module:

```ts
export interface WaitForRoomFormationInput {
    readonly roomRef: GroupRef;
    readonly stateStore: RallarRoomStateStorePort;
    readonly slots: RallarRoomLayoutSlotsPort;
    readonly resolveOperationOptions: <T extends RallarOperationOptions>(
        options: T
    ) => T & RallarOperationOptions;
}
export function subscribeRoomFormation(
    input: ReadRoomFormationStatusInput,
    listener: () => void | Promise<void>
): RallarUnsubscribe;
export async function waitForRoomStage(
    input: WaitForRoomFormationInput & {
        stages: readonly GroupLifecycleState[];
        options: RallarScopedOperationOptions;
    }
): Promise<RallarRoomFormationWaitResult>;
export async function waitForRoomCondition(
    input: WaitForRoomFormationInput & {
        conditions: readonly GroupActivationCondition[];
        options: RallarScopedOperationOptions;
    }
): Promise<RallarRoomFormationWaitResult>;
```

- [ ] **Step 1: Write the failing tests**

```ts
// packages/tests/shared-web/rooms/formation/wait-for-room-formation.test.ts
import { beforeEach, describe, expect, it } from 'vitest';

import { configureOverlayRepositories } from '@shared/repository/overlays-repository.ts';

import {
    publishRoomSnapshots,
    resetRoomWorkflowTestRuntime,
    seedRoomSnapshots
} from '../room-workflow-test-runtime.ts';
import { createFormationSnapshot } from './room-formation-test-fixtures.ts';

describe('room formation stage and condition waits', () => {
    beforeEach(() => {
        resetRoomWorkflowTestRuntime();
        configureOverlayRepositories({
            plannedOverlays: { ttlMs: 60_000 },
            acceptedOverlays: { ttlMs: 60_000 }
        });
    });

    it('resolves immediately when the cached stage already matches', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const planned = createFormationSnapshot({
            stage: 'planned',
            formationEpoch: 1,
            causalRevision: { groupRevision: 2, presenceRevision: 1 }
        });
        seedRoomSnapshots([planned]);

        const result = await createRallarFacade().rooms.formation(planned.group).waitForStage([
            'planned',
            'connecting'
        ], { timeoutMs: 10 });

        expect(result.status).toBe('ready');
        expect(result.formation?.stage).toBe('planned');
    });

    it('resolves on a later cache change and times out otherwise', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const planned = createFormationSnapshot({
            stage: 'planned',
            formationEpoch: 1,
            causalRevision: { groupRevision: 2, presenceRevision: 1 }
        });
        seedRoomSnapshots([planned]);
        const formation = createRallarFacade().rooms.formation(planned.group);
        const wait = formation.waitForStage('connecting', { timeoutMs: 1_000 });

        await publishRoomSnapshots([
            createFormationSnapshot({
                stage: 'connecting',
                formationEpoch: 2,
                causalRevision: { groupRevision: 3, presenceRevision: 1 }
            })
        ]);

        await expect(wait).resolves.toMatchObject({
            status: 'ready',
            formation: { stage: 'connecting', formationEpoch: 2 }
        });
        await expect(formation.waitForStage('active', { timeoutMs: 10 })).resolves.toMatchObject({
            status: 'timeout',
            formation: { stage: 'connecting' }
        });
    });

    it('reports not-found for a room that is not cached and aborted on an aborted signal', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const missing = createFormationSnapshot({
            stage: 'forming',
            formationEpoch: 0,
            causalRevision: { groupRevision: 1, presenceRevision: 1 }
        });
        const controller = new AbortController();
        controller.abort();

        await expect(
            createRallarFacade().rooms.formation(missing.group).waitForStage('active', {
                timeoutMs: 10
            })
        ).resolves.toMatchObject({ status: 'not-found', formation: undefined });
        seedRoomSnapshots([missing]);
        await expect(
            createRallarFacade().rooms.formation(missing.group).waitForStage('active', {
                signal: controller.signal
            })
        ).resolves.toMatchObject({ status: 'aborted' });
    });

    it('waits for the pushed activation condition', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const connecting = createFormationSnapshot({
            stage: 'connecting',
            formationEpoch: 2,
            causalRevision: { groupRevision: 3, presenceRevision: 1 }
        });
        seedRoomSnapshots([connecting]);
        const wait = createRallarFacade().rooms.formation(connecting.group).waitForCondition(
            'active',
            { timeoutMs: 1_000 }
        );
        const status = {
            condition: 'active' as const,
            coverageRate: 1,
            coverageBasisLayoutIdentity: {
                groupRevision: 3,
                presenceRevision: 1,
                version: 2,
                state: 'active' as const
            },
            formationEpoch: 2,
            evidenceWatermark: null,
            publishedAtEpochMs: 5
        };

        await publishRoomSnapshots([{
            ...connecting,
            group: { ...connecting.group, activationStatus: status }
        }]);

        await expect(wait).resolves.toMatchObject({
            status: 'ready',
            formation: { condition: 'active', coverageRate: 1 }
        });
    });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run packages/tests/shared-web/rooms/formation/wait-for-room-formation.test.ts`
Expected: FAIL, `waitForStage` is not a function.

- [ ] **Step 3: Implement the waits**

```ts
// packages/shared-web/browser/rooms/formation/room-formation-observation.ts (added to Task 1.4's module)
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';

export function subscribeRoomFormation(
    input: ReadRoomFormationStatusInput,
    listener: () => void | Promise<void>
): RallarUnsubscribe {
    const overlayId = toScopedOverlayId(input.roomRef);
    const onSlotChange = (change: { readonly overlayId: string; }) => {
        if (change.overlayId === overlayId) {
            return listener();
        }
    };
    const unsubscribes = [
        input.stateStore.onCacheChange(listener),
        input.slots.onPlannedChange(onSlotChange),
        input.slots.onAcceptedChange(onSlotChange)
    ];
    return () => {
        for (const unsubscribe of unsubscribes) {
            unsubscribe();
        }
    };
}
```

```ts
// packages/shared-web/browser/rooms/formation/wait-for-room-formation.ts
import { normalizeWaitTimeoutMs } from '@shared-web/browser/connection/normalize-wait-timeout-ms.ts';
import type { RallarScopedOperationOptions } from '@shared-web/browser/rallar-connection-facade.ts';
import type { RallarOperationOptions } from '@shared-web/browser/rallar-operation-options.ts';
import type { GroupActivationCondition } from '@shared/api/group-lifecycle/activation-status/compute-group-activation-condition.ts';
import type { GroupLifecycleState } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';

import { waitForRoomChange } from '../wait-for-room-change.ts';
import type {
    RallarRoomFormationStatus,
    RallarRoomFormationWaitResult,
    RallarRoomFormationWaitStatus
} from './rallar-room-formation-contracts.ts';
import {
    readRoomFormationStatus,
    subscribeRoomFormation,
    type ReadRoomFormationStatusInput
} from './room-formation-observation.ts';

export interface WaitForRoomFormationInput extends ReadRoomFormationStatusInput {
    readonly resolveOperationOptions: <T extends RallarOperationOptions>(
        options: T
    ) => T & RallarOperationOptions;
}

export interface WaitForRoomStageInput extends WaitForRoomFormationInput {
    readonly stages: readonly GroupLifecycleState[];
    readonly options: RallarScopedOperationOptions;
}

export interface WaitForRoomConditionInput extends WaitForRoomFormationInput {
    readonly conditions: readonly GroupActivationCondition[];
    readonly options: RallarScopedOperationOptions;
}

interface WaitForRoomFormationStatusInput extends WaitForRoomFormationInput {
    readonly options: RallarScopedOperationOptions;
    readonly isReached: (formation: RallarRoomFormationStatus) => boolean;
}

export async function waitForRoomStage(
    input: WaitForRoomStageInput
): Promise<RallarRoomFormationWaitResult> {
    return await waitForRoomFormationStatus({
        ...input,
        isReached: (formation) => input.stages.includes(formation.stage)
    });
}

export async function waitForRoomCondition(
    input: WaitForRoomConditionInput
): Promise<RallarRoomFormationWaitResult> {
    return await waitForRoomFormationStatus({
        ...input,
        isReached: (formation) =>
            formation.condition !== undefined && input.conditions.includes(formation.condition)
    });
}

async function waitForRoomFormationStatus(
    input: WaitForRoomFormationStatusInput
): Promise<RallarRoomFormationWaitResult> {
    const operationOptions = input.resolveOperationOptions(input.options);
    const readResult = (
        override?: RallarRoomFormationWaitStatus
    ): RallarRoomFormationWaitResult => {
        const formation = readRoomFormationStatus(input);
        const status = formation === undefined
            ? 'not-found'
            : input.isReached(formation)
            ? 'ready'
            : 'timeout';
        return { status: override ?? status, roomRef: input.roomRef, formation };
    };
    return await waitForRoomChange({
        readResult: () => readResult(),
        isSettled: (result) => result.status === 'ready' || result.status === 'not-found',
        subscribe: (listener) => subscribeRoomFormation(input, listener),
        signal: operationOptions.signal,
        timeoutMs: normalizeWaitTimeoutMs(input.options.timeoutMs),
        toTimedOut: () => readResult('timeout'),
        toAborted: () => readResult('aborted')
    });
}
```

Add the two result types to the contracts file and the two methods to `RallarRoomFormation`; in
`createRoomFormation` add

```ts
waitForStage: async (stage, options = {}) =>
    await waitForRoomStage({ ...input, stages: toList(stage), options }),
waitForCondition: async (condition, options = {}) =>
    await waitForRoomCondition({ ...input, conditions: toList(condition), options }),
```

with a private `function toList<T>(value: T | readonly T[]): readonly T[] { return Array.isArray(value) ? value : [value as T]; }`
at the bottom of `create-room-formation.ts`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run packages/tests/shared-web/rooms/formation`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared-web/browser/rooms/formation packages/tests/shared-web/rooms/formation
git commit -m "Wait for a formation stage or activation condition from the room handle"
```

### Task 2.3: The fenced layout wait

**Files:**

- Modify: `packages/shared-web/browser/rooms/formation/wait-for-room-formation.ts`
- Modify: `packages/shared-web/browser/rooms/formation/rallar-room-formation-contracts.ts`
- Modify: `packages/shared-web/browser/rooms/formation/create-room-formation.ts`
- Test: `packages/tests/shared-web/rooms/formation/wait-for-room-formation.test.ts`

**Interfaces:**

```ts
export interface RallarRoomLayoutWaitOptions extends RallarScopedOperationOptions {
    readonly role?: RallarRoomLayoutRole;
    readonly after?: GroupStateCausalRevision;
}

export interface RallarRoomLayoutWaitResult {
    readonly status: RallarRoomFormationWaitStatus;
    readonly roomRef: GroupRef;
    readonly layout: RallarRoomLayout | undefined;
    readonly formation: RallarRoomFormationStatus | undefined;
}

// on RallarRoomFormation:
waitForLayout(options?: RallarRoomLayoutWaitOptions): Promise<RallarRoomLayoutWaitResult>;

// wait module:
export function isRoomLayoutAtOrAfter(layout: RallarRoomLayout, after: GroupStateCausalRevision | undefined): boolean;
export async function waitForRoomLayout(input: WaitForRoomFormationInput & { options: RallarRoomLayoutWaitOptions }): Promise<RallarRoomLayoutWaitResult>;
```

- [ ] **Step 1: Verify the fence assumption before writing tests**

Read `packages/shared-server/rallar-system/group-state/mutation/aggregate/compute-lifecycle-transition.ts`
(the transition bumps `snapshotVersion` and writes the row under compare-and-set, so the resulting
`causalRevision.groupRevision` advances) and the `managerPlans` and `managerPlansPublication` steps
of `packages/shared-test/black-box-runner/tests/api-v1/api-v1-group-lifecycle-transitions.json`.
The runner selects recipes by profile rather than by name, so make the probe inside the recipe: add
`"managerPlansRevision": "body.causalRevision.groupRevision"` to the `outputs` of `managerPlans`,
and extend `expect.body.snapshot` of `managerPlansPublication` with
`"sourceGroupStateCausalRevision": { "groupRevision": "{managerPlansRevision}" }` (captured outputs
substitute with their captured type; the `connect` bodies in `api-v1-match-preset.json` already send
`{managerPlansTheLobbyPlannedEpoch}` as an integer this way). Run the default memory profile, which
contains the recipe:

```bash
npm run test:api-v1:black-box:memory
```

Expected: the recipe passes, proving the first publication after `plan` carries the receipt's
`groupRevision`; a later publication can only carry a greater one. Revert the recipe edit afterwards:
it is a probe, not a pin. If the step fails with a smaller revision, stop and record the outcome under
open question Q4 before continuing.

- [ ] **Step 2: Write the failing tests**

```ts
describe('room formation layout waits', () => {
    beforeEach(() => {
        resetRoomWorkflowTestRuntime();
        configureOverlayRepositories({
            plannedOverlays: { ttlMs: 60_000 },
            acceptedOverlays: { ttlMs: 60_000 }
        });
    });

    it('resolves when a planned layout at or after the fence lands in the slot', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const receipt = createFormationSnapshot({
            stage: 'planned',
            formationEpoch: 1,
            causalRevision: { groupRevision: 2, presenceRevision: 1 }
        });
        seedRoomSnapshots([receipt]);
        const overlayId = toScopedOverlayId(receipt.group);
        setPlannedOverlayById(
            overlayId,
            createLayoutOverlay({
                roomRef: receipt.group,
                causalRevision: { groupRevision: 1, presenceRevision: 1 },
                version: 1
            })
        );
        const wait = createRallarFacade().rooms.formation(receipt.group).waitForLayout({
            after: receipt.causalRevision,
            timeoutMs: 1_000
        });

        setPlannedOverlayById(
            overlayId,
            createLayoutOverlay({
                roomRef: receipt.group,
                causalRevision: { groupRevision: 2, presenceRevision: 1 },
                version: 2
            })
        );

        await expect(wait).resolves.toMatchObject({
            status: 'ready',
            layout: {
                role: 'planned',
                identity: { groupRevision: 2, presenceRevision: 1, version: 2, state: 'active' }
            }
        });
    });

    it('does not accept a dominated or incomparable layout under a fence, but accepts any layout without one', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const receipt = createFormationSnapshot({
            stage: 'reconfiguring',
            formationEpoch: 3,
            causalRevision: { groupRevision: 5, presenceRevision: 3 }
        });
        seedRoomSnapshots([receipt]);
        const overlayId = toScopedOverlayId(receipt.group);
        const formation = createRallarFacade().rooms.formation(receipt.group);
        setPlannedOverlayById(
            overlayId,
            createLayoutOverlay({
                roomRef: receipt.group,
                causalRevision: { groupRevision: 4, presenceRevision: 3 },
                version: 4
            })
        );

        await expect(formation.waitForLayout({ after: receipt.causalRevision, timeoutMs: 10 }))
            .resolves.toMatchObject({ status: 'timeout', layout: undefined });
        await expect(
            formation.waitForLayout({
                after: { groupRevision: 6, presenceRevision: 1 },
                timeoutMs: 10
            })
        ).resolves.toMatchObject({ status: 'timeout' });
        await expect(formation.waitForLayout({ timeoutMs: 10 })).resolves.toMatchObject({
            status: 'ready',
            layout: { identity: { version: 4 } }
        });
    });

    it('waits for the accepted role against the snapshot identity', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const connecting = createFormationSnapshot({
            stage: 'connecting',
            formationEpoch: 2,
            causalRevision: { groupRevision: 3, presenceRevision: 1 }
        });
        seedRoomSnapshots([connecting]);
        const overlayId = toScopedOverlayId(connecting.group);
        const wait = createRallarFacade().rooms.formation(connecting.group).waitForLayout({
            role: 'accepted',
            timeoutMs: 1_000
        });
        const identity = {
            groupRevision: 3,
            presenceRevision: 1,
            version: 2,
            state: 'active' as const
        };

        setAcceptedOverlayById(
            overlayId,
            createLayoutOverlay({
                roomRef: connecting.group,
                causalRevision: { groupRevision: 3, presenceRevision: 1 },
                version: 2
            })
        );
        await publishRoomSnapshots([{
            ...connecting,
            group: {
                ...connecting.group,
                lifecycleState: 'active',
                formationEpoch: 3,
                acceptedLayoutIdentity: identity
            }
        }]);

        await expect(wait).resolves.toMatchObject({
            status: 'ready',
            layout: { role: 'accepted', identity }
        });
    });
});
```

(imports: `setAcceptedOverlayById`, `setPlannedOverlayById` from the overlays repository,
`toScopedOverlayId`, `createLayoutOverlay`, `publishRoomSnapshots`.)

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run packages/tests/shared-web/rooms/formation/wait-for-room-formation.test.ts`
Expected: FAIL, `waitForLayout` is not a function.

- [ ] **Step 4: Implement**

Add to `wait-for-room-formation.ts` (imports `compareGroupCausalRevision` from
`@shared/api/group-client-views.ts`, `GroupStateCausalRevision` from `@shared/api/group-types.ts`,
and the layout types):

```ts
export interface WaitForRoomLayoutInput extends WaitForRoomFormationInput {
    readonly options: RallarRoomLayoutWaitOptions;
}

/**
 * A fenced wait accepts only a layout published at or after the fence;
 * `incomparable` is refused rather than folded into either answer (product
 * decision 29).
 */
export function isRoomLayoutAtOrAfter(
    layout: RallarRoomLayout,
    after: GroupStateCausalRevision | undefined
): boolean {
    if (after === undefined) {
        return true;
    }
    const order = compareGroupCausalRevision(layout.overlay.sourceGroupStateCausalRevision, after);
    return order === 'equal' || order === 'dominates';
}

export async function waitForRoomLayout(
    input: WaitForRoomLayoutInput
): Promise<RallarRoomLayoutWaitResult> {
    const operationOptions = input.resolveOperationOptions(input.options);
    const role = input.options.role ?? 'planned';
    const readResult = (override?: RallarRoomFormationWaitStatus): RallarRoomLayoutWaitResult => {
        const formation = readRoomFormationStatus(input);
        const candidate = formation?.[role];
        const layout =
            candidate !== undefined && isRoomLayoutAtOrAfter(candidate, input.options.after)
                ? candidate
                : undefined;
        const status = formation === undefined
            ? 'not-found'
            : layout === undefined
            ? 'timeout'
            : 'ready';
        return { status: override ?? status, roomRef: input.roomRef, layout, formation };
    };
    return await waitForRoomChange({
        readResult: () => readResult(),
        isSettled: (result) => result.status === 'ready' || result.status === 'not-found',
        subscribe: (listener) => subscribeRoomFormation(input, listener),
        signal: operationOptions.signal,
        timeoutMs: normalizeWaitTimeoutMs(input.options.timeoutMs),
        toTimedOut: () => readResult('timeout'),
        toAborted: () => readResult('aborted')
    });
}
```

Add `RallarRoomLayoutWaitOptions`, `RallarRoomLayoutWaitResult` and the `waitForLayout` method to the
contracts, and `waitForLayout: async (options = {}) => await waitForRoomLayout({ ...input, options }),`
to the handle.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run packages/tests/shared-web/rooms/formation`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/shared-web/browser/rooms/formation packages/tests/shared-web/rooms/formation
git commit -m "Wait for a planned or accepted layout with a causal fence"
```

### Task 2.4: Change and layout subscriptions

**Files:**

- Modify: `packages/shared-web/browser/rooms/formation/create-room-formation.ts`
- Modify: `packages/shared-web/browser/rooms/formation/rallar-room-formation-contracts.ts`
- Test: `packages/tests/shared-web/rooms/formation/room-formation-subscriptions.test.ts`

**Interfaces:**

```ts
export type RallarRoomLayoutEvent =
    | Readonly<{ kind: 'layoutPlanned'; roomRef: GroupRef; layout: RallarRoomLayout; }>
    | Readonly<{ kind: 'layoutAccepted'; roomRef: GroupRef; layout: RallarRoomLayout; }>
    | Readonly<{ kind: 'layoutRemoved'; roomRef: GroupRef; role: RallarRoomLayoutRole; previous: RallarRoomLayout | undefined; }>;
export type RallarRoomLayoutListener = (event: RallarRoomLayoutEvent) => void | Promise<void>;

// on RallarRoomFormation:
onChange(listener: RallarStateListener<RallarRoomFormationStatus>, options?: RallarOnChangeOptions): RallarUnsubscribe;
onLayout(listener: RallarRoomLayoutListener): RallarUnsubscribe;
```

- [ ] **Step 1: Write the failing tests**

```ts
// packages/tests/shared-web/rooms/formation/room-formation-subscriptions.test.ts
import { beforeEach, describe, expect, it } from 'vitest';

import type {
    RallarRoomFormationStatus,
    RallarRoomLayoutEvent
} from '@shared-web/browser/rallar.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import {
    configureOverlayRepositories,
    removePlannedOverlayById,
    setPlannedOverlayById
} from '@shared/repository/overlays-repository.ts';

import {
    publishRoomSnapshots,
    resetRoomWorkflowTestRuntime,
    seedRoomSnapshots
} from '../room-workflow-test-runtime.ts';
import { createFormationSnapshot, createLayoutOverlay } from './room-formation-test-fixtures.ts';

describe('room formation subscriptions', () => {
    beforeEach(() => {
        resetRoomWorkflowTestRuntime();
        configureOverlayRepositories({
            plannedOverlays: { ttlMs: 60_000 },
            acceptedOverlays: { ttlMs: 60_000 }
        });
    });

    it('emits the current status once, then only observable changes', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const planned = createFormationSnapshot({
            stage: 'planned',
            formationEpoch: 1,
            causalRevision: { groupRevision: 2, presenceRevision: 1 }
        });
        seedRoomSnapshots([planned]);
        const seen: RallarRoomFormationStatus[] = [];
        const stop = createRallarFacade().rooms.formation(planned.group).onChange((status) => {
            seen.push(status);
        });

        await publishRoomSnapshots([planned]);
        setPlannedOverlayById(
            toScopedOverlayId(planned.group),
            createLayoutOverlay({
                roomRef: planned.group,
                causalRevision: { groupRevision: 2, presenceRevision: 1 },
                version: 2
            })
        );
        await publishRoomSnapshots([
            createFormationSnapshot({
                stage: 'connecting',
                formationEpoch: 2,
                causalRevision: { groupRevision: 3, presenceRevision: 1 }
            })
        ]);
        stop();
        await publishRoomSnapshots([
            createFormationSnapshot({
                stage: 'active',
                formationEpoch: 3,
                causalRevision: { groupRevision: 4, presenceRevision: 1 }
            })
        ]);

        expect(seen.map((status) => [status.stage, status.planned?.identity.version])).toEqual([
            ['planned', undefined],
            ['planned', 2],
            ['connecting', 2]
        ]);
    });

    it('reports planned, accepted and removed layouts for the bound room only', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const room = createFormationSnapshot({
            stage: 'planned',
            formationEpoch: 1,
            causalRevision: { groupRevision: 2, presenceRevision: 1 }
        });
        const other = { ...room.group, groupId: 'room-2' };
        seedRoomSnapshots([room]);
        const events: RallarRoomLayoutEvent[] = [];
        createRallarFacade().rooms.formation(room.group).onLayout((event) => {
            events.push(event);
        });

        setPlannedOverlayById(
            toScopedOverlayId(other),
            createLayoutOverlay({
                roomRef: other,
                causalRevision: { groupRevision: 9, presenceRevision: 9 },
                version: 9
            })
        );
        setPlannedOverlayById(
            toScopedOverlayId(room.group),
            createLayoutOverlay({
                roomRef: room.group,
                causalRevision: { groupRevision: 2, presenceRevision: 1 },
                version: 2
            })
        );
        removePlannedOverlayById(toScopedOverlayId(room.group));

        expect(events.map((event) => event.kind)).toEqual(['layoutPlanned', 'layoutRemoved']);
        expect(events[1]).toMatchObject({
            role: 'planned',
            previous: { identity: { version: 2 } }
        });
    });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run packages/tests/shared-web/rooms/formation/room-formation-subscriptions.test.ts`
Expected: FAIL, `onChange` is not a function.

- [ ] **Step 3: Implement**

In `create-room-formation.ts` (imports: `notifyListener` from
`@shared-web/browser/messages/rallar-listener-delivery.ts`, `toScopedOverlayId`, `toRallarRoomLayout`,
`subscribeRoomFormation` from
`./room-formation-observation.ts`, `RallarRoomLayoutRole`, the listener and event types, `OverlayRepositoryChange` from the overlays
repository):

```ts
function subscribeToFormationChanges(
    input: CreateRoomFormationInput,
    listener: RallarStateListener<RallarRoomFormationStatus>,
    options: RallarOnChangeOptions
): RallarUnsubscribe {
    let last = readRoomFormationStatus(input);
    if ((options.emitCurrent ?? true) && last !== undefined) {
        notifyListener(listener, last);
    }
    return subscribeRoomFormation(input, () => {
        const next = readRoomFormationStatus(input);
        if (next === undefined || isSameFormationObservation(last, next)) {
            return;
        }
        last = next;
        notifyListener(listener, next);
    });
}

/** The caches replace objects on every change, so identity is the observable-change test. */
function isSameFormationObservation(
    left: RallarRoomFormationStatus | undefined,
    right: RallarRoomFormationStatus
): boolean {
    return left !== undefined &&
        left.snapshot === right.snapshot &&
        left.planned?.overlay === right.planned?.overlay &&
        left.accepted?.overlay === right.accepted?.overlay;
}

function subscribeToLayoutEvents(
    input: CreateRoomFormationInput,
    listener: RallarRoomLayoutListener
): RallarUnsubscribe {
    const overlayId = toScopedOverlayId(input.roomRef);
    const forward = (role: RallarRoomLayoutRole) => (change: OverlayRepositoryChange) => {
        if (change.overlayId !== overlayId) {
            return;
        }
        return notifyListener(listener, toRoomLayoutEvent(role, change, input.roomRef));
    };
    const unsubscribes = [
        input.slots.onPlannedChange(forward('planned')),
        input.slots.onAcceptedChange(forward('accepted'))
    ];
    return () => {
        for (const unsubscribe of unsubscribes) {
            unsubscribe();
        }
    };
}

function toRoomLayoutEvent(
    role: RallarRoomLayoutRole,
    change: OverlayRepositoryChange,
    roomRef: GroupRef
): RallarRoomLayoutEvent {
    const layout = toRallarRoomLayout(role, change.overlay, roomRef);
    if (layout === undefined) {
        return {
            kind: 'layoutRemoved',
            roomRef,
            role,
            previous: toRallarRoomLayout(role, change.previous, roomRef)
        };
    }
    return role === 'planned'
        ? { kind: 'layoutPlanned', roomRef, layout }
        : { kind: 'layoutAccepted', roomRef, layout };
}
```

and on the handle `onChange: (listener, options = {}) => subscribeToFormationChanges(input, listener, options),`
and `onLayout: (listener) => subscribeToLayoutEvents(input, listener),`. Check `notifyListener`'s
signature in `rallar-listener-delivery.ts` before use; it delivers a value to a listener and reports
listener errors without throwing.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run packages/tests/shared-web/rooms/formation`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared-web/browser/rooms/formation packages/tests/shared-web/rooms/formation
git commit -m "Subscribe to formation status and layout events on the room handle"
```

### Task 2.5: The formation view read

**Files:**

- Create: `packages/shared/api/group-lifecycle/validate-group-formation-view.ts`
- Create: `packages/shared-web/browser/rooms/formation/read-room-formation-view.ts`
- Modify: `packages/shared-web/browser/rooms/formation/room-formation-http-api.ts`
- Modify: `packages/shared-web/browser/rooms/formation/create-room-formation.ts`, contracts
- Test: `packages/tests/shared/group-formation-view-validation.test.ts`,
  `packages/tests/shared-web/rooms/formation/read-room-formation-view.test.ts`

**Interfaces:**

```ts
// shared
export interface GroupFormationViewIssue {
    readonly path: string;
    readonly code: 'missing-field' | 'invalid-value';
    readonly message: string;
}
export const GROUP_ACTIVATION_REMEDIATIONS: readonly GroupActivationRemediation[];
export function validateGroupFormationView(
    value: unknown,
    expectedGroupRef: GroupRef
): readonly GroupFormationViewIssue[];

// browser
export interface ReadRoomFormationViewInput {
    readonly roomRef: GroupRef;
    readonly options: RallarScopedOperationOptions;
    readonly ports: Pick<
        RoomFormationCommandPorts,
        'connect' | 'requireSession' | 'resolveOperationOptions' | 'runAuthAwareOperation'
    >;
}
export async function readRoomFormationView(
    input: ReadRoomFormationViewInput
): Promise<GroupFormationView>;
// roomFormationHttpApi gains readView(groupId, scope, options?): Promise<GroupFormationView>
// RallarRoomFormation gains readView(options?): Promise<GroupFormationView>
```

- [ ] **Step 1: Write the failing validator test**

```ts
// packages/tests/shared/group-formation-view-validation.test.ts
import { describe, expect, it } from 'vitest';

import type { GroupFormationView } from '@shared/api/group-lifecycle/group-formation-view.ts';
import { validateGroupFormationView } from '@shared/api/group-lifecycle/validate-group-formation-view.ts';

const groupRef = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' };

function createView(): GroupFormationView {
    return {
        groupRef,
        lifecycleState: 'planned',
        formationEpoch: 1,
        formationAttemptCount: 0,
        lastFormationOutcome: null,
        establishmentStartedAtEpochMs: null,
        readiness: { plannedEdgeCount: 1, observedEdgeCount: 0, observedRate: 0 },
        managerPrincipalIds: ['alice'],
        layoutStale: false,
        pending: null,
        maxFormationAttempts: 2,
        condition: 'inactive',
        remediation: 'none',
        coverageBasisLayoutIdentity: null
    };
}

describe('group formation view validation', () => {
    it('accepts a complete view for the requested group', () => {
        expect(validateGroupFormationView(createView(), groupRef)).toEqual([]);
    });

    it('reports every issue at once', () => {
        const broken = {
            ...createView(),
            lifecycleState: 'establishing',
            condition: 'green',
            groupRef: { ...groupRef, groupId: 'other' }
        };
        expect(validateGroupFormationView(broken, groupRef).map((issue) => issue.path).sort())
            .toEqual([
                'condition',
                'groupRef',
                'lifecycleState'
            ]);
    });
});
```

- [ ] **Step 2: Write the failing read test**

```ts
// packages/tests/shared-web/rooms/formation/read-room-formation-view.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApiClient } from '@shared-web/browser/api-client-config.ts';

import { resetRoomWorkflowTestRuntime, seedRoomSnapshots } from '../room-workflow-test-runtime.ts';
import { createFormationSnapshot } from './room-formation-test-fixtures.ts';

describe('room formation view read', () => {
    beforeEach(() => {
        resetRoomWorkflowTestRuntime();
        configureApiClient({ apiBaseUrl: 'https://api.example.test' });
    });
    afterEach(() => vi.unstubAllGlobals());

    it('reads and validates the formation view for the bound room', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const planned = createFormationSnapshot({
            stage: 'planned',
            formationEpoch: 1,
            causalRevision: { groupRevision: 2, presenceRevision: 1 }
        });
        seedRoomSnapshots([planned]);
        const view = {
            groupRef: planned.group,
            lifecycleState: 'planned',
            formationEpoch: 1,
            formationAttemptCount: 0,
            lastFormationOutcome: null,
            establishmentStartedAtEpochMs: null,
            readiness: { plannedEdgeCount: 1, observedEdgeCount: 0, observedRate: 0 },
            managerPrincipalIds: ['principal-1'],
            layoutStale: false,
            pending: null,
            maxFormationAttempts: 2,
            condition: 'inactive',
            remediation: 'none',
            coverageBasisLayoutIdentity: null
        };
        const fetchMock = vi.fn(async () =>
            new Response(JSON.stringify(view), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            })
        );
        vi.stubGlobal('fetch', fetchMock);

        await expect(createRallarFacade().rooms.formation(planned.group).readView()).resolves
            .toEqual(view);
        expect(fetchMock.mock.calls[0]?.[0]).toBe(
            'https://api.example.test/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/formation'
        );
    });

    it('rejects a view that names another group', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const planned = createFormationSnapshot({
            stage: 'planned',
            formationEpoch: 1,
            causalRevision: { groupRevision: 2, presenceRevision: 1 }
        });
        seedRoomSnapshots([planned]);
        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                new Response(JSON.stringify({ groupRef: { ...planned.group, groupId: 'other' } }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' }
                })
            )
        );

        await expect(createRallarFacade().rooms.formation(planned.group).readView()).rejects
            .toThrow(TypeError);
    });
});
```

- [ ] **Step 3: Run both to verify they fail**

Run: `npx vitest run packages/tests/shared/group-formation-view-validation.test.ts packages/tests/shared-web/rooms/formation/read-room-formation-view.test.ts`
Expected: FAIL, modules missing.

- [ ] **Step 4: Write the validator**

```ts
// packages/shared/api/group-lifecycle/validate-group-formation-view.ts
import { isSameGroupRef } from '../api-type-utils.ts';
import type { GroupRef } from '../group-types.ts';
import {
    GROUP_ACTIVATION_CONDITIONS,
    type GroupActivationRemediation
} from './activation-status/compute-group-activation-condition.ts';
import {
    GROUP_LAYOUT_IDENTITY_KEYS,
    GROUP_LAYOUT_IDENTITY_STATES
} from './group-layout-identity.ts';
import { GROUP_LIFECYCLE_STATES } from './group-lifecycle-policy.ts';

export interface GroupFormationViewIssue {
    readonly path: string;
    readonly code: 'missing-field' | 'invalid-value';
    readonly message: string;
}

export const GROUP_ACTIVATION_REMEDIATIONS = [
    'none',
    'replan-queued',
    'awaiting-application'
] as const satisfies readonly GroupActivationRemediation[];

const REQUIRED_KEYS = [
    'groupRef',
    'lifecycleState',
    'formationEpoch',
    'formationAttemptCount',
    'lastFormationOutcome',
    'establishmentStartedAtEpochMs',
    'readiness',
    'managerPrincipalIds',
    'layoutStale',
    'pending',
    'maxFormationAttempts',
    'condition',
    'remediation',
    'coverageBasisLayoutIdentity'
] as const;

export function validateGroupFormationView(
    value: unknown,
    expectedGroupRef: GroupRef
): readonly GroupFormationViewIssue[] {
    if (!isRecord(value)) {
        return [{ path: '$', code: 'invalid-value', message: 'Formation view must be an object' }];
    }
    const issues: GroupFormationViewIssue[] = REQUIRED_KEYS
        .filter((key) => !(key in value))
        .map((key) => ({
            path: key,
            code: 'missing-field',
            message: `Formation view is missing ${key}`
        }));
    if (
        !isRecord(value.groupRef) || !isGroupRefValue(value.groupRef) ||
        !isSameGroupRef(value.groupRef, expectedGroupRef)
    ) {
        issues.push({
            path: 'groupRef',
            code: 'invalid-value',
            message: 'Formation view names a different group'
        });
    }
    if (!isOneOf(value.lifecycleState, GROUP_LIFECYCLE_STATES)) {
        issues.push({
            path: 'lifecycleState',
            code: 'invalid-value',
            message: 'Unknown lifecycle state'
        });
    }
    if (!isOneOf(value.condition, GROUP_ACTIVATION_CONDITIONS)) {
        issues.push({
            path: 'condition',
            code: 'invalid-value',
            message: 'Unknown activation condition'
        });
    }
    if (!isOneOf(value.remediation, GROUP_ACTIVATION_REMEDIATIONS)) {
        issues.push({ path: 'remediation', code: 'invalid-value', message: 'Unknown remediation' });
    }
    if (
        !isNonNegativeInteger(value.formationEpoch) ||
        !isNonNegativeInteger(value.formationAttemptCount)
    ) {
        issues.push({
            path: 'formationEpoch',
            code: 'invalid-value',
            message: 'Epoch and attempt count must be non-negative integers'
        });
    }
    if (!isReadiness(value.readiness)) {
        issues.push({
            path: 'readiness',
            code: 'invalid-value',
            message: 'Readiness must carry the three counts'
        });
    }
    if (
        !Array.isArray(value.managerPrincipalIds) ||
        !value.managerPrincipalIds.every((id) => typeof id === 'string')
    ) {
        issues.push({
            path: 'managerPrincipalIds',
            code: 'invalid-value',
            message: 'Manager ids must be strings'
        });
    }
    if (typeof value.layoutStale !== 'boolean') {
        issues.push({
            path: 'layoutStale',
            code: 'invalid-value',
            message: 'layoutStale must be a boolean'
        });
    }
    if (value.maxFormationAttempts !== null && !isNonNegativeInteger(value.maxFormationAttempts)) {
        issues.push({
            path: 'maxFormationAttempts',
            code: 'invalid-value',
            message: 'Attempt budget must be null or an integer'
        });
    }
    if (
        value.coverageBasisLayoutIdentity !== null &&
        !isLayoutIdentity(value.coverageBasisLayoutIdentity)
    ) {
        issues.push({
            path: 'coverageBasisLayoutIdentity',
            code: 'invalid-value',
            message: 'Coverage basis must be null or a layout identity'
        });
    }
    return issues;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isGroupRefValue(
    value: Record<string, unknown>
): value is Record<string, unknown> & GroupRef {
    return typeof value.applicationId === 'string' && typeof value.groupId === 'string' &&
        (value.workspaceId === undefined || typeof value.workspaceId === 'string');
}

function isOneOf<T extends string>(value: unknown, registry: readonly T[]): value is T {
    return typeof value === 'string' && registry.some((known) => known === value);
}

function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isReadiness(value: unknown): boolean {
    return isRecord(value) &&
        isNonNegativeInteger(value.plannedEdgeCount) &&
        isNonNegativeInteger(value.observedEdgeCount) &&
        typeof value.observedRate === 'number';
}

function isLayoutIdentity(value: unknown): boolean {
    return isRecord(value) &&
        GROUP_LAYOUT_IDENTITY_KEYS.every((key) => key in value) &&
        isNonNegativeInteger(value.groupRevision) &&
        isNonNegativeInteger(value.presenceRevision) &&
        isNonNegativeInteger(value.version) &&
        isOneOf(value.state, GROUP_LAYOUT_IDENTITY_STATES);
}
```

Check `GroupFormationReadiness` in `compute-group-formation-reading.ts` before finalising
`isReadiness`; use its exact field names.

- [ ] **Step 5: Write the browser read**

Add to `room-formation-http-api.ts`:

```ts
async function readStateGroupFormationView(
    groupId: string,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions
): Promise<GroupFormationView> {
    return await executeHttpRequest<void, GroupFormationView>(
        readApiBaseUrl(),
        `${toStateGroupHttpPath(scope, groupId)}/formation`,
        'GET',
        undefined,
        options
    );
}
```

and `readView: readStateGroupFormationView` on the frozen object (import `ApiRequestOptions` and
`GroupFormationView`). Then:

```ts
// packages/shared-web/browser/rooms/formation/read-room-formation-view.ts
import type { RallarScopedOperationOptions } from '@shared-web/browser/rallar-connection-facade.ts';
import { toRallarCommandOptions } from '@shared-web/browser/rallar-operation-options.ts';
import { toStateScope } from '@shared/api/api-type-utils.ts';
import type { GroupFormationView } from '@shared/api/group-lifecycle/group-formation-view.ts';
import { validateGroupFormationView } from '@shared/api/group-lifecycle/validate-group-formation-view.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { Command } from '@shared/cache/Command.ts';

import type { RoomFormationCommandPorts } from './command-room-formation.ts';
import { roomFormationHttpApi } from './room-formation-http-api.ts';

export interface ReadRoomFormationViewInput {
    readonly roomRef: GroupRef;
    readonly options: RallarScopedOperationOptions;
    readonly ports: Pick<
        RoomFormationCommandPorts,
        'connect' | 'requireSession' | 'resolveOperationOptions' | 'runAuthAwareOperation'
    >;
}

export async function readRoomFormationView(
    input: ReadRoomFormationViewInput
): Promise<GroupFormationView> {
    const { ports } = input;
    return await ports.runAuthAwareOperation(async () => {
        const operationOptions = ports.resolveOperationOptions(input.options);
        await ports.connect(operationOptions);
        const scope = input.options.scope ?? toStateScope(input.roomRef);
        const view = await new Command<GroupFormationView>(
            (signal) =>
                roomFormationHttpApi.readView(input.roomRef.groupId, scope, {
                    signal,
                    authSession: ports.requireSession()
                }),
            toRallarCommandOptions(operationOptions)
        ).run();
        const issues = validateGroupFormationView(view, input.roomRef);
        if (issues.length > 0) {
            throw new TypeError(
                issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')
            );
        }
        return view;
    });
}
```

Add `readView(options?: RallarScopedOperationOptions): Promise<GroupFormationView>;` to the contract
and `readView: async (options = {}) => await readRoomFormationView({ roomRef: input.roomRef, options, ports: input }),`
to the handle.

- [ ] **Step 6: Run the tests and cross-runtime checks**

Run: `npx vitest run packages/tests/shared/group-formation-view-validation.test.ts packages/tests/shared-web/rooms/formation && npx tsc -p packages/shared/tsconfig.json --noEmit && (cd apps/api-v1 && deno task check)`
Expected: PASS and exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/api/group-lifecycle/validate-group-formation-view.ts packages/shared-web/browser/rooms/formation packages/tests/shared/group-formation-view-validation.test.ts packages/tests/shared-web/rooms/formation
git commit -m "Read and validate the formation view from the room handle"
```

### Task 2.6: Exports, budgets and reference docs for the observation surface

**Files:** the same files as Task 1.6.

- [ ] **Step 1: Export** `RallarRoomFormationWaitResult`, `RallarRoomFormationWaitStatus`,
      `RallarRoomLayoutEvent`, `RallarRoomLayoutListener`, `RallarRoomLayoutWaitOptions`,
      `RallarRoomLayoutWaitResult` from `rallar.ts` and `rallar-core.ts` (type lists) and add them to the
      snapshot test's expected lists in sorted order.

- [ ] **Step 2: Re-measure both bundles** exactly as in Task 1.6 Step 3 and raise the budgets again
      when crossed, recording the figures.

- [ ] **Step 3: Document** in `docs/rallar-api-reference.md`, after the paragraph added in Task 1.6:

```markdown
`formation.waitForLayout(options?)` is the explicit wait for a published layout: it observes the
browser's planned and accepted layout slots and resolves `ready` with the layout, or `timeout`,
`aborted` or `not-found`. `role` selects the slot (`planned` by default). `after` is a causal
revision fence, typically a receipt's `causalRevision`: only a layout published at or after it
satisfies the wait, and an incomparable one never does. After `plan` the unfenced form is right;
after `reconfigure` pass the receipt's revision, because the planned slot may still hold the
candidate the reconfigure superseded. `formation.waitForStage(stage | stages, options?)` and
`formation.waitForCondition(condition | conditions, options?)` resolve from the pushed group
snapshot. `formation.onChange(listener, options?)` emits the status on every observable change of
the snapshot or either layout slot; `formation.onLayout(listener)` emits `layoutPlanned`,
`layoutAccepted` and `layoutRemoved` events for the bound room. `formation.readView(options?)`
fetches the server's `GroupFormationView` (readiness, managers, `layoutStale`, `pending`, the
attempt budget, both status axes and the coverage basis) and validates it against the bound room.
Readiness for application traffic stays `rtc.waitForRoom(...)` and `realtime.room().wait()`, which
follow the accepted layout only.
```

- [ ] **Step 4: Run the Slice 2 gates, then commit**

```bash
git add packages/shared-web/browser packages/shared-web/scripts/measure-browser-bundles.mjs packages/tests docs/rallar-api-reference.md
git commit -m "Expose formation waits and subscriptions on the browser facade"
```

---

## Slice 3 — Documentation closure and navigation

**Outcome:** every reader path names the new surface: the quickstart shows a held-layout match room
end to end, the architecture doc's read-surface paragraph names the facade, the browser navigation
map lists the formation feature owners, and the design track README indexes this plan.

**Gates:**

```bash
npx vitest run packages/tests/repo/rallar-group-documentation.test.ts packages/tests/repo/rallar-skill-app-examples-integrity.test.ts
npm run test:repo-governance
npm run format:check
```

### Task 3.1: The quickstart recipe

**Files:**

- Modify: `docs/rallar-quickstart-and-recipes.md` (a new `## Held-Layout Match Room` section after
  `## Wait For Room Presence`)

- [ ] **Step 1: Write the recipe** (_the delivered recipe in `docs/rallar-quickstart-and-recipes.md`
      differs from the draft below: players are admitted before the plan, the manager is re-read per
      command, the preset activates itself, and every wait result is checked; see the deviations_)

````markdown
## Held-Layout Match Room

A `match` preset holds the layout until the application says go and blocks application data until
the layout is accepted. The creator is the manager at formation epoch 0, so it can drive every
command.

```ts
const created = await rallar.rooms.createAndSwitch({
    displayName: 'Ranked match',
    lifecyclePolicy: { preset: 'match', establishment: { maxConcurrentEdgeSetups: 2 } }
});
const room = rallar.rooms.session(created.group);
const formation = room.formation;

formation.onChange((status) => ui.render(status.stage, status.condition, status.transportState));

const planned = await formation.plan();
const layout = await formation.waitForLayout({ timeoutMs: 10_000 });
if (layout.status !== 'ready') {
    throw new Error(`No layout was published: ${layout.status}`);
}

try {
    await formation.connect({ layout: layout.layout.identity });
}
catch (error) {
    const denial = toRoomFormationDenial(error);
    if (denial?.kind === 'layout') {
        // The plan moved while we waited; wait again and connect the current candidate.
        const current = await formation.waitForLayout({
            after: planned.causalRevision,
            timeoutMs: 10_000
        });
        await formation.connect({ layout: current.layout?.identity });
    }
    else {
        throw error;
    }
}

await formation.waitForCondition('active', { timeoutMs: 30_000 });
await formation.activate();
await formation.waitForStage('active');
const ready = await rallar.rtc.waitForRoom(created.group);
```

`pause()` and `resume()` halt and restore application data without dropping a connection;
`reconfigure({ landing: 'hold' })` publishes a new layout beside the live one, and
`waitForLayout({ after: receipt.causalRevision })` followed by `connect()` and `activate()` promotes
it. `reset()` returns the room to `dormant` and `start()` begins a new series.
````

- [ ] **Step 2: Run the documentation tests**

Run: `npx vitest run packages/tests/repo/rallar-group-documentation.test.ts`
Expected: PASS (every backticked file citation in the four group documents must resolve; this
recipe cites none).

- [ ] **Step 3: Commit**

```bash
git add docs/rallar-quickstart-and-recipes.md
git commit -m "Show a held-layout match room in the quickstart"
```

### Task 3.2: Architecture doc, navigation map and design-track index

**Files:**

- Modify: `docs/rallar-group-formation-architecture.md` ("### Group snapshot" under "## Read Surface")
- Modify: `packages/shared-web/browser/README.md` ("## Feature-owned HTTP and workflow paths")
- Modify: `playground/rtc-design/README.md` (table row; already added when this plan was written)

- [ ] **Step 1: Name the facade in the architecture doc**

Replace "Browser room operations expose all eight commands; browser dial/data enforcement uses the
authoritative group and layout state." with:

```markdown
Browser room operations expose all eight commands through `rallar.rooms.formation(room)` and
`RallarRoomSession.formation` (`packages/shared-web/browser/rooms/formation/create-room-formation.ts`),
with the explicit layout wait of product decision 16 and the status projection documented in
`docs/rallar-api-reference.md`; browser dial/data enforcement uses the authoritative group and layout
state.
```

- [ ] **Step 2: Extend the navigation map**

Add to the bulleted list under "## Feature-owned HTTP and workflow paths" in
`packages/shared-web/browser/README.md`:

```markdown
- [createRoomFormation](./rooms/formation/create-room-formation.ts) owns the room-bound formation
  handle: [commandRoomFormation](./rooms/formation/command-room-formation.ts) posts the lifecycle
  commands through [room-formation-http-api.ts](./rooms/formation/room-formation-http-api.ts) and
  accepts each receipt into the state cache;
  [waitForRoomLayout](./rooms/formation/wait-for-room-formation.ts) and its stage and condition
  siblings observe the cache and the two overlay slots through
  [createRoomLayoutSlots](./rooms/formation/room-layout-slots.ts) on the shared
  [waitForRoomChange](./rooms/wait-for-room-change.ts) engine;
  [readRoomFormationView](./rooms/formation/read-room-formation-view.ts) fetches and validates the
  formation view.
```

- [ ] **Step 3: Run the gates and commit**

Run: `npx vitest run packages/tests/repo/rallar-group-documentation.test.ts && npm run test:repo-governance && npm run format:check`
Expected: PASS.

```bash
git add docs/rallar-group-formation-architecture.md packages/shared-web/browser/README.md
git commit -m "Document the browser formation surface in the architecture and navigation docs"
```

---

## Follow-up plan (not in scope here): browser-driven acceptance pins

The architecture doc records four acceptance scenarios that only browser-side infrastructure can pin:
`status-on-connect` (the member's readiness barrier), `discovery-holds-dials` end to end,
`reset-tears-down` and `reset-no-stale-hydration`, plus the `member-progress` fraction. This surface
makes a facade-driven scenario expressible, but pinning it means extending the black-box SPA's direct
operations (`apps/rallar-black-box/src/direct-rallar-operations.ts`), the control protocol in
`packages/shared-test/rallar-bb-test/` and the Playwright matrix
`tests/playwright/rallar-black-box/full-stack-live-rtc-three-browser-matrix.spec.ts`, gated by
`npm run test:rallar:full-stack:memory:live-rtc-3` and the Hetzner distributed manifests. That is a
test-infrastructure subsystem with its own owners and is written as its own plan once slices 1 and 2
have landed; it does not block them. Its first scenario is the quickstart recipe above run by three
browsers: `plan` on one, `waitForLayout` on all three, `connect`, `activate`, `rtc.waitForRoom`.

---

**Typed stale-epoch rejection (settled question Q3).** A `connect` whose `expectedFormationEpoch` no
longer matched the group reached the wire as the generic `group-mutation-rejected` `400`
(`packages/shared-server/rallar-system/group-state/mutation/aggregate/compute-lifecycle-fence-rejection.ts`,
`packages/shared-server/rallar-system/app-inbox/app-inbox-error-classification.ts`). PR #533
(opened 2026-09-06, the separate mutation-path PR this answer called for) adds
`group-connect-stale-epoch` to `GROUP_CONNECT_REJECTION_CODES`, maps it to `409` beside the two layout
conflicts, reads it through `toRoomFormationDenial` as the `layout` kind, makes `connect()` read the
room through before it rethrows that refusal (a stale epoch leaves the planned layout current, so
forgetting it would strand the caller), drives the refusal from `api-v1-group-connect-fence` (#535) and ran
the medium-scale gate. The PR leaves the criterion petitions on the shared rejection, since no HTTP
route sends a fenced non-connect command; the surface table, B4 and Task 1.6 above describe the two
conflicts the slices shipped with.

## Questions settled in review (2026-09-05)

All nine were reviewed with the maintainer on 2026-09-05 and each took the recommended answer; none
remains open. The table keeps each question beside the alternatives it was decided against, because that
record is the only durable explanation of why the code looks as it does.

| #  | Question                                                                                                                                                                                                                                                                                                                                  | Decision                                                                                                                                                              |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1 | Where the surface lives: `rooms.formation(room?)` plus `session.formation` (B1), flat `rooms.plan(room)` methods, or a top-level `rallar.formation`.                                                                                                                                                                                      | B1. The bound handle is the only shape that gives layout events a home and keeps `BrowserRallarRooms` under the split-review threshold.                               |
| Q2 | Failure style on the eight commands: throw `ApiHttpError` like every room mutation (B3), or return typed `Either` values as the code standard prefers for expected failures.                                                                                                                                                              | B3, with `toRoomFormationDenial`. Consistency with `rooms.join` beats a lone value-returning capability; revisit only if the whole rooms facade moves to values.      |
| Q3 | The epoch mismatch on `connect` reaches the wire as the generic `group-mutation-rejected` `400`, so a browser cannot distinguish "someone else moved the group" from a malformed request without string matching. Should the server add a typed `group-connect-stale-epoch` `409`?                                                        | Yes, as a separate mutation-path PR carrying the medium-scale gate; PR #533 (opened 2026-09-06) is it.                                                                |
| Q4 | The layout fence assumes a receipt's `causalRevision` strictly precedes every publication the transition causes (B6, verified by reading the transition compute and one recipe in Task 2.3 Step 1). If a live check shows a publication with an older `groupRevision`, the fence cannot be expressed with the fields the overlay carries. | Verify in Task 2.3. If it fails, ship `waitForLayout` without `after`, document the reconfiguring caveat, and open a server issue to stamp the epoch on publications. |
| Q5 | Should waits perform one read-through when the slot is empty at wait start (against a lost publication), or stay pure cache observers (B5)?                                                                                                                                                                                               | B5. Reconnect hydration and `session.refresh()` already own anti-entropy; a wait that does HTTP must decide what a failed GET means, and neither answer is clean.     |
| Q6 | Bundle budgets: the maintainer has ruled they are adjustable. The plan raises each crossed budget to the smallest whole KiB above the measurement in the same task (Tasks 1.6 and 2.6). Confirm that convention, or name a fixed headroom.                                                                                                | Smallest whole KiB above the measurement, measurement recorded beside the budget and in the PR body, as the headless test already does.                               |
| Q7 | Shared DTO naming: `GroupConnectRequest` / `GroupReconfigureRequest` follow the OpenAPI schema names; the older TypeScript family uses `JoinGroupRequest`-style verb-first names.                                                                                                                                                         | Follow OpenAPI. One name on the wire and in code beats family symmetry, and the older family is not renamed.                                                          |
| Q8 | Whether the browser-driven acceptance pins (follow-up plan) belong to this workstream or to the distributed-validation lane.                                                                                                                                                                                                              | A separate plan after slice 2, owned by whoever owns the three-browser matrix; slices 1–3 do not wait for it.                                                         |
| Q9 | Whether `RallarRoomFormationStatus` should also carry `remediation`, which the server derives at read (implementation decision I40) and never pushes.                                                                                                                                                                                     | No. Only pushed facts belong in the free status; `readView()` is the one place remediation is truthful.                                                               |

## Deviations recorded during delivery (2026-09-05, amended 2026-09-06 after code review)

- The status projections `toRallarRoomLayout` and `toRallarRoomFormationStatus` live in
  `packages/shared-web/browser/rooms/formation/room-formation-observation.ts`, not in
  `room-group-state-translation.ts` as Task 1.4 wrote: adding them there crossed the translation
  file's cognitive-load warn tier in the changed-style gate. Their consumers are the command
  workflow (the connect fence), the waits, both subscriptions and the handle; the translation file
  keeps the request translation only. Task 1.4's body carries a pointer note at each site.
- Lifecycle bodies are typed as the OpenAPI schemas (`TransitionStateGroupLifecycleBody`,
  `ConnectStateGroupLifecycleBody`, `ReconfigureStateGroupLifecycleBody` in
  `packages/shared-web/browser/api/state-mutation-http-contracts.ts`) and carry no actor fields: the
  routes take the actor from authentication and declare `additionalProperties: false`.
  `GroupReconfigureRequest` was not added to `packages/shared` (Task 1.1): the server never consumed
  it and the browser body derives from the schema. The eight command names have one owner,
  `packages/shared/api/group-lifecycle/group-lifecycle-commands.ts`, from which the browser union
  derives; `apps/api-v1/src/group-state/register-group-lifecycle-routes.ts` keeps its literal
  registrations for the route analyzer.
- There is no separate formation HTTP port (Task 1.3): the lifecycle POST is
  `roomGroupStateHttpApi.commandLifecycle` in `packages/shared-web/browser/rooms/room-group-state-http-api.ts`,
  the view GET is `readStateGroupFormationView` in
  `packages/shared-web/browser/state-read/state-snapshot-http-api.ts`, and the command runs through
  the existing `runRoomTargetMutation` envelope. The dependency bundle is
  `RoomFormationServiceDependencies`, built once by the rooms facade.
- `connect()` pairs the planned identity with the cached epoch only when the snapshot is at or past
  the layout's causal revision and reads the room through otherwise, forgets a fence the server
  refused, and distinguishes three local refusals where B4 named one: `no-planned-layout`,
  `session-not-present` and `planned-layout-read-failed`. `toRoomFormationDenial` classifies the
  local `no-planned-layout` as the `group-connect-no-planned-layout` layout denial and is exported
  from `rallar-core.ts`. Slot subscriptions survive the overlay repositories being replaced on
  connect (`packages/shared-web/browser/state-cache/overlay-slot-subscriptions.ts`), and `status()`
  reports the activation condition only while the stored status describes the current series.
- The wait engine is `packages/shared-web/browser/connection/wait-for-settled-read.ts`, not a
  rooms-local module (Task 2.1): the WS open wait runs on it too. It prefers a settled read at a
  deadline or abort, the formation waits wake only on changes naming the bound room, and `not-found`
  settles only for a room this browser never held (an expired snapshot keeps the wait going). Wait
  options are `RallarOperationOptions`; the fence is the shared `isGroupCausalRevisionAtOrAfter`.
- `onLayout` derives its events from the differences between consecutive status projections rather
  than from raw slot writes (Task 2.4): a bootstrap or tombstoned slot raises nothing,
  `layoutAccepted` fires once the snapshot names the accepted layout, and a layout that appears and
  disappears before the browser observes it raises no event. `onChange` emits nothing for a room
  leaving the cache; `rooms.onChange` reports that.
- `decodeGroupFormationView(value: unknown, expectedGroupRef)` in
  `packages/shared/api/group-lifecycle/decode-group-formation-view.ts` returns an `Either` of every
  issue over the JSON the server sent (Task 2.5 named a validator over the typed DTO, whose guards
  were dead). The registries `GROUP_ACTIVATION_REMEDIATIONS` and `GROUP_FORMATION_OUTCOME_KINDS`
  sit beside their unions, and the layout identity guard beside its key registry.
- The subscription tests drain the overlay repositories' observer queue with
  `waitForPlannedOverlayChangesIdle()` before asserting, because slot changes are delivered through
  that promise queue rather than synchronously; the room test runtime delegates those drains to the
  real repository, so a facade imported after the runtime drains the same queue.
- Q4 outcome: verified. `api-v1-group-lifecycle-transitions` on the memory profile, with a temporary
  expectation that the first publication after `plan` carries the receipt's
  `causalRevision.groupRevision`, passed 37/37 (receipt revision 4, published layout revision 4), so
  `waitForLayout({ after })` shipped with the fence.
- The quickstart recipe (Task 3.1) admits the players before `plan()` (closed admission admits only
  while forming), re-reads the manager from `readView()` before each manager command (the election is
  per epoch), never calls `activate()` (the preset activates itself at full coverage), re-waits
  unfenced after a server-driven supersede, and checks every wait result.
- Budgets: the browser facade measures 178.888671875 KiB Brotli (budget 179 in
  `packages/shared-web/scripts/measure-browser-bundles.mjs` and
  `packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts`) and the headless agent
  223.23828125 KiB (ceiling 224 in `packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts`,
  recorded beside the assertion), each raised to the next whole KiB per the settled convention.

## Validation summary

| Gate                                                                                                               | Slice 1 | Slice 2 | Slice 3 |
| ------------------------------------------------------------------------------------------------------------------ | ------- | ------- | ------- |
| Focused Vitest (`packages/tests/shared`, `packages/tests/shared-web/rooms`, surface, boundary and headless tests)  | yes     | yes     | —       |
| `npx tsc` for `packages/shared`, `packages/shared-web`, `packages/shared-server`                                   | yes     | yes     | —       |
| `cd apps/api-v1 && deno task check`, `npm run test:deno`                                                           | yes     | yes     | —       |
| `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`                                              | yes     | yes     | —       |
| `npm run typecheck` (includes `typecheck:tests`)                                                                   | yes     | yes     | —       |
| `npm run check:repo-style:changed -- origin/main HEAD`, `node scripts/check-test-structure-coupling.mjs --changed` | yes     | yes     | yes     |
| `npm run format:check`                                                                                             | yes     | yes     | yes     |
| `npm run test:unit`, `npm run build`                                                                               | yes     | yes     | —       |
| `npm run test:repo-governance`, group documentation tests                                                          | —       | —       | yes     |
| Branch Release Gate (CI), medium-scale auto-trigger on `packages/shared/**`                                        | yes     | yes     | yes     |
| `npm run pr:delivery -- status` before broad validation, `-- ready` once at handoff                                | yes     | yes     | yes     |

Not required by this plan: local medium-scale, state-write, topology-replay, formation-large and
the live three-browser matrix. No mutation path, recipe, OpenAPI block or server behaviour changes;
the only server edits are two type adoptions in Task 1.1.

## Black-box framework notes

The framework investigation this plan's author requested — identifier uniqueness, recipe
re-runnability, lifecycle tracing APIs and the runner's own gaps — belongs with the black-box
workstream and lives in `2026-09-05-black-box-coverage-plan.md` under **Framework prerequisites**.

Two of its findings bear on this plan and are worth knowing before slice 3's browser-driven pins:
`poll-until` is HTTP-only, so a browser recipe waiting on convergence still sleeps; and a rejected
`ws.open` is an unconditional step failure, so a browser test cannot yet assert a refused upgrade.
