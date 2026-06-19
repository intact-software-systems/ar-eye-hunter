# Rallar Groups Implementation Plan

> For agentic workers: this is an implementation plan only. Do not implement all
> iterations at once. Take one iteration, add the listed tests first, implement
> the minimum behavior for that slice, then run the focused validation commands.

**Goal:** Turn the group and room policy gaps identified in
`docs/rallar-groups-report.md` into ordered, reviewable implementation slices.

**Architecture:** Add explicit server-side group-domain policy helpers and wire
them into the group state service, API-v1 routes, state-sync routing, and room
message authorization. Browser APIs should call policy-specific workflows and
avoid exposing raw membership mutation.

**Tech stack:** TypeScript shared packages, Deno/Hono API-v1 routes, Vitest
package tests, Deno service/route tests, existing Rallar app-inbox and state-sync
infrastructure.

---

## Current-State Summary

Rallar already has strong scoped room communication. Preserve these existing
behaviors:

- Scoped `GroupRef` identity for application/workspace-aware room operations.
- Group snapshots, presence sessions, room events, event replay, and state-sync
  publication.
- WS and RTC room messaging, including room session helpers, readiness helpers,
  fallback strategies, min snapshot version checks, and existing transport
  policy.
- Browser ergonomics for `rooms.create`, `rooms.createAndSwitch`, `rooms.join`,
  `rooms.enter`, `rooms.session`, `rooms.leave`, `rooms.updateMetadata`,
  `rooms.waitForPresence`, and room event helpers.
- App-inbox-owned group mutation execution and state-sync publication.
- Existing idempotent request IDs, operation options, retry/timeout handling,
  current-room cache hydration, and active-member room communication behavior.

Main gaps from `docs/rallar-groups-report.md`:

- Admission policy is stored as `joinMode` but not consistently enforced.
- Invite-only and code join semantics are incomplete.
- `maxMembers` and `maxSessionsPerMember` are not enforced in service-level
  member or presence mutations.
- Archived/deleted/expired lifecycle fields exist, but enforcement is uneven.
- Membership governance operations are missing from safe browser workflows.
- Read visibility differs between non-strict REST, strict REST, and state-sync.
- Browser group administration is too limited and otherwise requires lower-level
  calls.
- Room switching is best effort but not explicitly documented or surfaced.
- Room message and state-sync authorization assume group state is already
  policy-correct.
- Focused tests for the missing policy cases are incomplete.

## Design Principles

- Policy decisions live server-side. Browser code passes intent and displays
  policy results.
- Browser APIs expose safe workflows, not raw role/status mutation.
- Policies should be pure and testable where possible, with explicit snapshot,
  actor, target, time, and operation inputs.
- Stable reason codes should be surfaced to browser workflows while preserving
  the existing `{ error: string }` response shape.
- Backwards compatibility should be preserved where reasonable, except where
  existing behavior is a security or policy gap.
- Do not build a broad ACL framework. Prefer explicit group-domain helpers such
  as `canJoinGroup`, `canReadGroupSnapshot`, and
  `canConnectGroupPresenceSession`.
- Preserve scoped identity everywhere policy is evaluated. Browser string
  `roomId` ergonomics may remain only when the implementation resolves the
  operation to a scoped group reference before mutation or authorization.

## Iteration Plan

### Iteration 1: Policy Result Model And Error Plumbing

**Goal:** Create shared policy-result and error-code vocabulary without changing
group behavior.

**Gap addressed:** Stable browser-safe error reason codes; foundation for
server-side policy evaluation.

**Files likely to change:**

- `packages/shared/api/state-types.ts`
- `packages/shared/api/group-policy-types.ts` (new)
- `packages/shared-server/rallar-system/group-policy.ts` (new)
- `apps/api-v1/src/routes/group-state-routes.ts`
- `packages/shared-web/browser/api-integration.ts`

**New or changed types:**

- `GroupPolicyReasonCode`
- `GroupPolicyResult`
- `GroupPolicyDenied`
- Expanded `StateErrorResponse` with optional `code`, `message`, and `details`,
  while keeping required `error`.

**API/server changes:**

- Add a narrow policy-error helper that maps policy denials to HTTP status and
  `{ error, code, details? }`.
- Keep existing string error handling for non-policy errors.

**Browser facade changes:**

- Preserve `ApiHttpError.status`, `bodyText`, and retry behavior.
- Add a helper to parse optional policy error fields from the response body.

**Tests to add or update:**

- Shared type test or compile-time fixture proving `StateErrorResponse.error`
  remains required and `code` is additive.
- API-v1 route test with a synthetic policy error returning both `error` and
  `code`.
- Browser API integration test proving policy code can be parsed from
  `ApiHttpError` without changing old status/body assertions.

**Migration/backwards compatibility notes:**

- Existing clients that only read `error` continue to work.
- No runtime policy behavior changes in this slice.

**Acceptance criteria:**

- All existing group, route, and browser workflow tests still pass.
- New tests prove stable code fields are available and backwards-compatible.

**Risks and unresolved questions:**

- Keep reason codes small and stable. Avoid encoding every diagnostic as a
  public code.

**Estimated complexity:** small.

### Iteration 2: Pure Group Policy Helpers

**Goal:** Implement pure group-domain policy helpers before wiring them into
services and routes.

**Gap addressed:** Server-side policy is currently implied across services,
routes, state-sync, and transport authorizers.

**Files likely to change:**

- `packages/shared-server/rallar-system/group-policy.ts`
- `packages/tests/shared-server/group-policy.test.ts` (new)

**New or changed types:**

- Actor input type with `principalId`, `sessionId`, and optional service actor.
- Operation-specific input types for read, join, leave, invite, govern,
  lifecycle, presence, and room-message send decisions.

**API/server changes:**

- No service or route behavior change yet.

**Browser facade changes:**

- None.

**Tests to add or update:**

- `canJoinGroup` for open, invite-only, code, left, removed, and banned
  members.
- `canConnectGroupPresenceSession` for active membership, inactive membership,
  archived/deleted group, and session cap inputs.
- `canReadGroupSnapshot` for active, invited, non-member, removed, banned, and
  deleted cases.
- `canChangeGroupLifecycle` for owner/admin/member actors.
- `canGovernGroupMember` for invite, remove, ban, unban, role change, transfer
  ownership, and last-owner protection.
- `canSendRoomMessage` for active live session, stale snapshot, inactive group,
  removed/banned member, and no live session.

**Migration/backwards compatibility notes:**

- Helper-only slice. No behavior changes outside tests.

**Acceptance criteria:**

- Pure policy tests cover every reason code introduced in Iteration 1.
- Helper inputs do not depend on repositories, global clocks, browser state, or
  live network state.

**Risks and unresolved questions:**

- Avoid over-generalizing into a full ACL framework.

**Estimated complexity:** medium.

### Iteration 3: Lifecycle Enforcement For Archived And Deleted Groups

**Goal:** Block unsafe mutations and room traffic for archived/deleted groups.

**Gap addressed:** Lifecycle state exists but the service does not consistently
block membership or presence mutations.

**Files likely to change:**

- `packages/shared-server/rallar-system/services/group-state-service.ts`
- `apps/api-v1/src/routes/group-state-routes.ts`
- `packages/shared-server/rallar-system/services/ws-topic-room-authorizer.ts`

**New or changed types:**

- Use reason codes such as `group-archived`, `group-deleted`, and
  `group-not-active`.

**API/server changes:**

- Policy-gate member upsert, presence connect, presence heartbeat, metadata
  update, and lifecycle actions.
- Keep dedicated lifecycle changes available only to authorized actors.
- Room WS authorization uses the explicit room-message policy result.

**Browser facade changes:**

- No new browser methods yet.
- Existing operations receive stable policy-coded errors.

**Tests to add or update:**

- Service tests: archived/deleted groups reject join-like member activation,
  presence connect, and heartbeat.
- Route tests: archived/deleted mutations return policy codes.
- WS authorizer tests: archived/deleted room messages are rejected while active
  group messages still pass.

**Migration/backwards compatibility notes:**

- Active group behavior should remain unchanged.
- Archived/deleted mutation rejection is an intentional policy tightening.

**Acceptance criteria:**

- Archived/deleted groups cannot be joined, entered, messaged, or
  non-lifecycle mutated.
- Existing active-room communication tests continue to pass.

**Risks and unresolved questions:**

- Archived read access is governed later by the read visibility iteration.

**Estimated complexity:** medium.

### Iteration 4: Expiry, Empty, And Purge Lifecycle

**Goal:** Make lifecycle timestamps operational in small service-level steps.

**Gap addressed:** `expiresAtEpochMs`, `emptySinceEpochMs`, and
`purgeAfterEpochMs` are modeled but not fully enforced.

**Files likely to change:**

- `packages/shared-server/rallar-system/services/group-state-service.ts`
- `packages/shared-server/rallar-system/services/presence-expiry-reconciliation-service.ts`
- `apps/api-v1/test/services/group-state-service.test.ts`
- `packages/tests/shared-server/presence-expiry-reconciliation-service.test.ts`

**New or changed types:**

- Reuse existing lifecycle fields and policy reason codes.

**API/server changes:**

- Treat expired groups as non-joinable and non-presence-connectable.
- Set `emptySinceEpochMs` when the last live session leaves or expires.
- Clear `emptySinceEpochMs` when a live session reconnects.
- Add a purge-planning hook or policy helper for `purgeAfterEpochMs`; defer
  destructive event/state deletion to a later explicit cleanup task.

**Browser facade changes:**

- None.

**Tests to add or update:**

- Expired group rejects join and presence connect.
- Last presence disconnect sets `emptySinceEpochMs`.
- New presence connect clears `emptySinceEpochMs`.
- Purge-after behavior is characterized as not deleting durable state in this
  iteration.

**Migration/backwards compatibility notes:**

- Existing groups without lifecycle timestamps behave as today.
- Actual durable purge remains deferred and explicit.

**Acceptance criteria:**

- Lifecycle timestamps have deterministic service behavior.
- No durable state or events are deleted in this iteration.

**Risks and unresolved questions:**

- Final purge implementation needs a product decision on retention windows and
  audit requirements.

**Estimated complexity:** medium.

### Iteration 5: Explicit Join Endpoint And Admission Policy

**Goal:** Replace browser self-upsert join behavior with explicit server join
intent.

**Gap addressed:** `joinMode` is not enforced; browser join currently means
self-upsert active plus presence connect.

**Files likely to change:**

- `packages/shared/api/state-types.ts`
- `packages/shared-server/rallar-system/services/AppInboxService.ts`
- `packages/shared-server/rallar-system/services/AppGroupInboxService.ts`
- `packages/shared-server/rallar-system/services/group-state-service.ts`
- `apps/api-v1/src/routes/group-state-routes.ts`
- `packages/shared-web/browser/api-integration.ts`
- `packages/shared-web/browser/api-workflows.ts`
- `packages/shared-web/browser/rallar.ts`

**New or changed types:**

- `JoinGroupRequest` with optional `inviteToken`, optional `joinCode`, and
  `requestId`.
- App-inbox payload for group join.

**API/server changes:**

- Add `POST /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/join`.
- Server resolves join policy using group snapshot, actor, existing member, join
  mode, invite/code inputs, lifecycle state, capacity inputs, and current time.
- Legacy self-service `active` upsert delegates to join policy instead of
  bypassing it.

**Browser facade changes:**

- `rooms.join` and `rooms.enter` send join intent.
- Presence repair no longer repairs policy denials into active membership.
- `RallarJoinRoomInput` accepts optional `inviteToken` and `joinCode`.

**Tests to add or update:**

- Open group join succeeds.
- Invite-only group rejects missing invite.
- Code group rejects missing code.
- `left` member can rejoin when policy allows.
- `removed` and `banned` members cannot self-rejoin.
- Browser `rooms.join` passes invite/code intent and does not leave the current
  room when join is denied.

**Migration/backwards compatibility notes:**

- Legacy self-active upsert remains available for old callers but becomes
  policy-gated.
- Existing open/invite creator flows should continue after create-specific
  tests are updated.

**Acceptance criteria:**

- Admission policy is enforced server-side.
- Browser join no longer depends on raw arbitrary self-upsert.

**Risks and unresolved questions:**

- Exact invite token validation is minimal until the invite workflow iteration.

**Estimated complexity:** medium.

### Iteration 6: Capacity Enforcement

**Goal:** Enforce `maxMembers` and `maxSessionsPerMember`.

**Gap addressed:** Capacity fields are stored but ignored during member and
presence mutations.

**Files likely to change:**

- `packages/shared-server/rallar-system/group-policy.ts`
- `packages/shared-server/rallar-system/services/group-state-service.ts`
- `apps/api-v1/test/services/group-state-service.test.ts`
- `packages/tests/shared-web/api-workflows.test.ts`

**New or changed types:**

- Reason codes such as `group-full` and
  `member-session-limit-reached`.

**API/server changes:**

- Active-member cap is checked before activating a new member.
- Live-session cap is checked before connecting a group presence session.
- Idempotent retries of an already accepted mutation do not double-count.

**Browser facade changes:**

- Existing join/enter/session workflows surface policy-coded full-room and
  session-limit errors.

**Tests to add or update:**

- `maxMembers` blocks a new active member when the group is full.
- Invited-but-not-active members do not reserve slots by default.
- `maxSessionsPerMember` blocks additional live sessions.
- Existing idempotent request retry does not consume extra capacity.

**Migration/backwards compatibility notes:**

- Groups with no capacity fields behave as today.
- Over-cap rejection is an intentional policy tightening.

**Acceptance criteria:**

- Over-cap attempts do not mutate roster or presence versions.
- Browser workflows receive stable capacity reason codes.

**Risks and unresolved questions:**

- Owner/admin cap bypass defaults to no bypass unless product decides otherwise.

**Estimated complexity:** medium.

### Iteration 7: Invite Workflow

**Goal:** Add invite creation, revocation, and acceptance workflows.

**Gap addressed:** Invite fields exist, but invite workflows and expiry
validation are missing.

**Files likely to change:**

- `packages/shared/api/state-types.ts`
- `packages/shared-server/rallar-system/services/AppInboxService.ts`
- `packages/shared-server/rallar-system/services/AppGroupInboxService.ts`
- `packages/shared-server/rallar-system/services/group-state-service.ts`
- `apps/api-v1/src/routes/group-state-routes.ts`
- `packages/shared-web/browser/api-integration.ts`
- `packages/shared-web/browser/api-workflows.ts`

**New or changed types:**

- `CreateGroupInviteRequest`
- `RevokeGroupInviteRequest`
- `AcceptGroupInviteRequest`

**API/server changes:**

- Add narrow invite endpoints.
- Validate inviter role, target principal, target member status, lifecycle
  state, expiry, and banned status.
- Accepting a valid invite activates membership through the same join/admission
  policy path.

**Browser facade changes:**

- Add low-level workflow helpers first. High-level `rooms.invite` and
  `rooms.acceptInvite` are added in Iteration 10.

**Tests to add or update:**

- Owner/admin can invite.
- Regular member cannot invite.
- Invite expiry is enforced.
- Revoked invite cannot be accepted.
- Banned member cannot accept an invite.
- Accepting a valid invite joins and connects presence through browser workflow.

**Migration/backwards compatibility notes:**

- Existing invited members remain valid subject to expiry and lifecycle policy.

**Acceptance criteria:**

- Invite-only admission has a real server-side path.
- Invite actions emit appropriate member events.

**Risks and unresolved questions:**

- Default invite expiry is an open product decision; recommended default is
  seven days.

**Estimated complexity:** medium.

### Iteration 8: Join-Code Workflow

**Goal:** Add join-code creation/rotation/expiry and code-based joins.

**Gap addressed:** `joinMode: code` has no concrete semantics.

**Files likely to change:**

- `packages/shared/api/state-types.ts`
- `packages/shared-server/rallar-system/services/AppInboxService.ts`
- `packages/shared-server/rallar-system/services/AppGroupInboxService.ts`
- `packages/shared-server/rallar-system/services/group-state-service.ts`
- `apps/api-v1/src/routes/group-state-routes.ts`
- `packages/shared-web/browser/api-integration.ts`
- `packages/shared-web/browser/api-workflows.ts`
- `packages/shared-web/browser/rallar.ts`

**New or changed types:**

- `RotateGroupJoinCodeRequest`
- `GroupJoinCodeResponse`
- Optional join-code fields in `JoinGroupRequest`

**API/server changes:**

- Add a narrow endpoint for code creation/rotation.
- Store only a verifier/hash in group-owned state.
- Validate code, expiry, group lifecycle, member status, and join mode.
- Add attempt throttling using existing route or resilience primitives before
  considering new dependencies.

**Browser facade changes:**

- `rooms.join({ roomId, joinCode })` uses code join.
- High-level code rotation can be exposed in Iteration 10 if needed by browser
  admins.

**Tests to add or update:**

- Missing code is rejected for code groups.
- Invalid code is rejected with a stable code.
- Expired code is rejected.
- Rotating a code invalidates the old code.
- Valid code joins and connects presence.

**Migration/backwards compatibility notes:**

- No effect on open or invite-only groups.

**Acceptance criteria:**

- Code admission is enforced server-side.
- Browser workflows can pass a code without custom HTTP calls.

**Risks and unresolved questions:**

- One-use versus reusable codes remains open; recommended default is reusable
  until expiry, with rotation invalidating prior codes.

**Estimated complexity:** medium.

### Iteration 9: Membership Governance

**Goal:** Add safe governance operations for group administrators.

**Gap addressed:** Remove, ban, unban, role change, leave policy, and ownership
transfer are not exposed as safe policy-specific workflows.

**Files likely to change:**

- `packages/shared/api/state-types.ts`
- `packages/shared-server/rallar-system/services/AppInboxService.ts`
- `packages/shared-server/rallar-system/services/AppGroupInboxService.ts`
- `packages/shared-server/rallar-system/services/group-state-service.ts`
- `apps/api-v1/src/routes/group-state-routes.ts`
- `apps/api-v1/test/services/group-state-service.test.ts`
- `apps/api-v1/test/routes/state-api-routes-hardening.test.ts`

**New or changed types:**

- `RemoveGroupMemberRequest`
- `BanGroupMemberRequest`
- `UnbanGroupMemberRequest`
- `SetGroupMemberRoleRequest`
- `TransferGroupOwnershipRequest`

**API/server changes:**

- Add narrow endpoints for remove, ban, unban, role change, and ownership
  transfer.
- Constrain raw member mutation to safe self-service or server-internal paths.
- Apply last-owner protection to leave, remove, ban, demote, and transfer
  operations.

**Browser facade changes:**

- Low-level HTTP/workflow helpers first. High-level browser facade methods are
  added in Iteration 10.

**Tests to add or update:**

- Owner can govern all member targets.
- Admin can govern regular members by default.
- Admin cannot target owners/admins by default.
- Regular member cannot remove, ban, unban, promote, demote, or transfer.
- Last owner cannot leave, be removed, be banned, or be demoted.
- Banned member read/event access follows the read visibility policy.

**Migration/backwards compatibility notes:**

- Generic group update remains for active owner/admin metadata and lifecycle
  changes, but browser governance uses narrow endpoints.

**Acceptance criteria:**

- Governance operations are server-policy-gated and emit correct member events.
- Browser-safe workflows no longer require raw `upsertMember`.

**Risks and unresolved questions:**

- Admin hierarchy is an open decision; recommended default is owner can govern
  all, admin can govern members only.

**Estimated complexity:** medium.

### Iteration 10: Safe Browser Create, Update, And Admin Facade

**Goal:** Expose safe browser administration workflows after server policy
exists.

**Gap addressed:** Browser facade lacks full group update, archive, delete,
invite, accept invite, remove, ban, unban, role, and ownership transfer methods.

**Files likely to change:**

- `packages/shared-web/browser/rallar-rooms-facade.ts`
- `packages/shared-web/browser/rallar.ts`
- `packages/shared-web/browser/api-workflows.ts`
- `packages/shared-web/browser/api-integration.ts`
- `packages/tests/shared-web/rallar-rooms-facade.test.ts`
- `packages/tests/shared-web/rallar-workflow-options-compat.test.ts`
- `packages/tests/shared-web/shared-web-public-api-snapshots.test.ts`
- `packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts`

**New or changed types:**

- Expand `RallarCreateRoomInput` with safe create fields such as `joinMode`,
  `maxMembers`, `maxSessionsPerMember`, `description`, and `metadata`.
- Add browser input types for `rooms.update`, `rooms.archive`,
  `rooms.delete`, `rooms.invite`, `rooms.acceptInvite`,
  `rooms.removeMember`, `rooms.banMember`, `rooms.unbanMember`,
  `rooms.setMemberRole`, and `rooms.transferOwnership`.

**API/server changes:**

- None beyond prior policy-specific endpoints.

**Browser facade changes:**

- Add the high-level methods listed above.
- Keep `rooms.updateMetadata` as a compatibility convenience wrapper.
- Use operation defaults, scoped ref validation, cache hydration, and policy
  error parsing consistently.

**Tests to add or update:**

- Facade factory delegates all new room methods.
- Workflow options propagate signal, timeout, retry, and scope.
- Mismatched `roomId` and `roomRef` are rejected before network calls.
- Cache is hydrated from successful mutation responses.
- Public API snapshots include the new methods without removing old methods.
- Browser bundle boundary checks remain green.

**Migration/backwards compatibility notes:**

- Existing string create/join/leave/updateMetadata calls remain valid.
- New create fields are optional.

**Acceptance criteria:**

- Common group administration can be done through safe browser workflows.
- Browser facade does not expose raw arbitrary role/status mutation.

**Risks and unresolved questions:**

- `rallar.ts` is large. Keep new helper code factored internally where
  possible while preserving public imports.

**Estimated complexity:** medium.

### Iteration 11: Read Visibility Alignment

**Goal:** Make REST reads, state-sync routing, and event reads use the same
visibility policy.

**Gap addressed:** Strict REST active-member reads differ from state-sync
active-or-invited routing, and non-strict REST is broader for compatibility.

**Files likely to change:**

- `packages/shared-server/rallar-system/group-policy.ts`
- `packages/shared/api/group-client-views.ts`
- `apps/api-v1/src/routes/group-state-routes.ts`
- `packages/shared-server/rallar-system/state-sync-routing.ts`
- `packages/shared-server/rallar-system/state-sync-publisher.ts`
- `apps/api-v1/test/routes/state-api-routes-hardening.test.ts`
- `packages/tests/shared-server/state-sync-publisher.test.ts`
- `packages/tests/shared-server/state-sync-routing.test.ts` (new)

**New or changed types:**

- Limited invite-visible or directory-safe group view type if full
  `GroupSnapshot` is too broad for invited/non-member readers.

**API/server changes:**

- Active members can read full snapshots and events.
- Invited users can read limited invite-visible metadata.
- Non-members can read only explicit public/open directory fields.
- Removed, banned, and deleted visibility is conservative.
- Keep `RALLAR_STATE_STRICT_READ_AUTH` as the rollout gate initially.

**Browser facade changes:**

- Existing active-member room state continues to use full snapshots.
- Limited directory/invite views are typed separately from full snapshots.

**Tests to add or update:**

- Active member REST snapshot, REST events, state-sync snapshot, and state-sync
  event routing agree.
- Invited user REST and state-sync visibility agree.
- Non-member public directory behavior is explicit.
- Removed and banned members do not receive full state or events.
- Deleted group visibility follows the lifecycle decision.

**Migration/backwards compatibility notes:**

- Non-strict REST behavior remains behind the existing environment gate for the
  initial rollout.
- Production docs should recommend strict reads enabled.

**Acceptance criteria:**

- REST, state-sync, and event visibility use one explicit policy helper.
- Invited users no longer receive more detail over WS than REST allows.

**Risks and unresolved questions:**

- Exact invite-visible metadata needs product confirmation.

**Estimated complexity:** medium.

### Iteration 12: Room Messaging Authorization Alignment

**Goal:** Ensure room message authorization consumes explicit group policy.

**Gap addressed:** Room routing authorization assumes the group service has
already produced policy-correct state.

**Files likely to change:**

- `packages/shared-server/rallar-system/services/ws-topic-room-authorizer.ts`
- `packages/shared-server/rallar-system/services/group-state-snapshot-read-through-cache.ts`
- `packages/tests/shared-server/ws-topic-room-authorizer.test.ts`
- `packages/tests/shared-web/rallar-room-realtime-channel.test.ts`
- `packages/tests/shared-web/rallar-messages-facade.test.ts`

**New or changed types:**

- Reuse room-message policy result codes.

**API/server changes:**

- Use `canSendRoomMessage` in WS room authorization.
- Reject inactive group, missing live session, stale snapshot, removed member,
  banned member, and cross-scope mismatch with stable reasons where the router
  supports structured denial.

**Browser facade changes:**

- None.

**Tests to add or update:**

- Archived/deleted groups cannot send room messages.
- Removed/banned members cannot send room messages.
- Active members with live sessions and fresh scoped snapshots still can send.
- Existing min snapshot version behavior still returns stale-cache denial when
  appropriate.
- Room realtime and message facade regressions still pass.

**Migration/backwards compatibility notes:**

- Active member communication behavior is preserved.

**Acceptance criteria:**

- Room message authorization is explicit and policy-aligned.
- Existing active room realtime tests still pass.

**Risks and unresolved questions:**

- Avoid false allows from warm stale caches after a ban/remove. Prefer
  read-through or min-version checks where freshness matters.

**Estimated complexity:** small.

### Iteration 13: Room Switching Consistency

**Goal:** Make create/join-and-switch behavior explicit and recoverable.

**Gap addressed:** Joining or creating a new room can succeed before leaving
the old current room fails.

**Files likely to change:**

- `packages/shared-web/browser/rallar.ts`
- `packages/shared-web/browser/api-workflows.ts`
- `packages/tests/shared-web/rallar-workflow-options-compat.test.ts`

**New or changed types:**

- Optional `RallarRoomSwitchResult` only if current `GroupSnapshot` returns
  cannot safely express partial failure.

**API/server changes:**

- None. Server-enforced single-room membership is deferred.

**Browser facade changes:**

- Preserve default `rooms.join(..., { leaveCurrent: true })`.
- Keep successful new-room join if leave-old fails.
- Surface leave-old failure in a typed or documented way so apps can recover.

**Tests to add or update:**

- Join failure does not leave the current room.
- Create failure does not leave the current room.
- Leave-old failure after successful join is observable.
- Cache/current-room state remains coherent after partial failure.

**Migration/backwards compatibility notes:**

- Existing best-effort client-side switching remains the default.

**Acceptance criteria:**

- Switching semantics are covered by tests and no longer implied.

**Risks and unresolved questions:**

- Server-side single-room membership remains an open future feature.

**Estimated complexity:** small.

### Iteration 14: Documentation, Snapshots, And Compatibility Pass

**Goal:** Harden docs, public API snapshots, bundle boundaries, and broad
regressions.

**Gap addressed:** Public surfaces and workflows need documentation once policy
behavior changes.

**Files likely to change:**

- `docs/rallar-api-reference.md`
- `docs/rallar-quickstart-and-recipes.md`
- `packages/tests/shared-web/shared-web-public-api-snapshots.test.ts`
- `packages/tests/shared-web/shared-web-browser-entrypoints.test.ts`
- `packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts`

**New or changed types:**

- Snapshot updates only.

**API/server changes:**

- Document new endpoints, policy reason codes, and rollout flags.

**Browser facade changes:**

- Document new `rooms.*` workflows, policy errors, and room-switch semantics.

**Tests to add or update:**

- Public API snapshot tests.
- Browser entrypoint tests.
- Browser bundle boundary checks.
- Regression tests for room realtime/message behavior.
- API-v1 Deno check.

**Migration/backwards compatibility notes:**

- Document legacy self-upsert behavior as policy-gated.
- Document strict read rollout and recommended production posture.

**Acceptance criteria:**

- Documentation matches implemented behavior.
- Focused package, API, browser, and room communication regression checks pass.

**Risks and unresolved questions:**

- Broader full-stack checks may need memory-mode server setup and should be run
  when this plan reaches integration hardening.

**Estimated complexity:** small.

## Test Strategy

Use tests-first inside each iteration. For each slice, add the listed failing
tests, implement the minimum behavior for that slice, then run focused checks
before broader validation.

Focused commands by area:

- Pure policy and routing:
  `npx vitest run packages/tests/shared-server/group-policy.test.ts packages/tests/shared-server/ws-topic-room-authorizer.test.ts`
- API-v1 service and routes:
  `cd apps/api-v1 && deno test --allow-env --allow-read test/services/group-state-service.test.ts test/routes/state-api-routes-hardening.test.ts`
- Browser workflows and facade:
  `npx vitest run packages/tests/shared-web/api-workflows.test.ts packages/tests/shared-web/rallar-rooms-facade.test.ts packages/tests/shared-web/rallar-workflow-options-compat.test.ts`
- Room communication regression:
  `npx vitest run packages/tests/shared-web/rallar-room-realtime-channel.test.ts packages/tests/shared-web/rallar-messages-facade.test.ts`
- Public surface and type checks:
  `npx tsc -p packages/shared/tsconfig.json --noEmit`
  `npx tsc -p packages/shared-web/tsconfig.json --noEmit`
  `npx tsc -p packages/shared-server/tsconfig.json --noEmit`
  `cd apps/api-v1 && deno task check`
- Browser public API and bundle compatibility:
  `npx vitest run packages/tests/shared-web/shared-web-public-api-snapshots.test.ts packages/tests/shared-web/shared-web-browser-entrypoints.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts`

## Recommended First Implementation Iteration

Start with **Iteration 1: Policy Result Model And Error Plumbing**.

It is the smallest useful slice because it creates the shared language every
later policy denial uses, adds stable browser-safe error codes, and keeps
current group behavior unchanged.

Exact first tests to add:

- `StateErrorResponse` keeps required `error` while allowing optional `code`.
- API-v1 route error mapper returns `{ error, code }` for a synthetic policy
  denial.
- Browser `ApiHttpError` preserves status and body text while exposing a parsed
  policy code helper.

## Risks And Open Decisions

- Archived reads: recommended default is active members can read; archived
  groups reject join, presence, messages, invite, and metadata changes except
  authorized restore/delete.
- Deleted reads: recommended default is owner/admin audit summary only until
  purge.
- Invite-visible metadata: recommended default is display name, kind, join mode,
  member count, and an explicit metadata allowlist.
- Event access for invited users: recommended default is no event history until
  active.
- Event access for banned users: recommended default is no event history.
- Capacity counting: recommended default is active members count, owners/admins
  count, invited members do not reserve slots.
- Governance hierarchy: recommended default is owners govern all, admins govern
  regular members only.
- Last owner: recommended default is no action can leave an active group
  ownerless.
- Invite expiry: recommended default is seven days when not specified.
- Join codes: recommended default is reusable until expiry, rotation invalidates
  previous codes.
- Attempt throttling: recommended default is reuse existing route/resilience
  primitives before introducing dependencies.
- Strict read default: recommended default is preserve
  `RALLAR_STATE_STRICT_READ_AUTH` as the first rollout gate, document production
  `true`, and consider flipping the default after compatibility validation.
- Room switching: recommended default is client-side best effort with observable
  partial failure; defer server-enforced single-room membership.
- Purge behavior: recommended default is plan and test purge eligibility before
  deleting durable group state or events.

## Report Gap Coverage

- Admission policy: Iterations 2 and 5.
- Invite/code join semantics: Iterations 5, 7, and 8.
- Capacity enforcement: Iteration 6.
- Lifecycle enforcement: Iterations 3 and 4.
- Membership governance: Iteration 9.
- Read visibility policy: Iteration 11.
- Browser-safe group administration workflows: Iteration 10.
- Consistency policy for room switching: Iteration 13.
- Policy-safe server-side authorization: Iterations 2, 11, and 12.
- Focused tests for missing policy cases: each iteration lists targeted tests;
  Iteration 14 adds compatibility and public-surface regression coverage.
- Browser create/update breadth: Iteration 10.
- Stable browser-safe policy error codes: Iteration 1.
- Scoped identity preservation: Design Principles, Iterations 5, 11, and 12.
