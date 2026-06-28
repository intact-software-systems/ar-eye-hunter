# Rallar Groups Implementation Progress

## Iteration 1: Policy Result Model And Error Plumbing

**Status:** implemented.

**Scope completed:**

- Added shared group policy result and reason-code types.
- Expanded `StateErrorResponse` with optional `code`, `message`, and `details`
  while preserving the required `error` field.
- Added a server-side `GroupPolicyDeniedError` helper for policy-denial
  serialization.
- Updated API-v1 group route error handling so only explicit group policy
  denials include stable `code` fields.
- Updated browser HTTP errors to parse optional policy error envelopes while
  preserving existing status/body behavior.

**Tests added or updated:**

- `packages/tests/shared/group-policy-types.test.ts`
- `apps/api-v1/test/routes/state-api-routes-hardening.test.ts`
- `packages/tests/shared-web/api-workflows.test.ts`

**Verification performed:**

- Red tests were observed before implementation:
  - shared policy type module missing,
  - API-v1 route policy error helper missing,
  - browser policy error parsing missing.
- Green focused tests were observed after implementation.

**Deferred by design:**

- No admission, lifecycle, capacity, governance, invite/code, read-visibility,
  room-switching, or room-message authorization behavior was implemented in
  this iteration.
- Policy reason codes are intentionally a small initial vocabulary and can be
  expanded by later iterations when concrete policies are implemented.

## Iteration 2: Pure Group Policy Helpers

**Status:** implemented.

**Scope completed:**

- Added pure helper inputs and functions for group admission, presence
  connection, snapshot reads, lifecycle changes, membership governance, and room
  message sends.
- Kept helper inputs data-only: snapshots, actor identity, target identifiers,
  optional current time, and operation-specific request values.
- Covered every initial `GroupPolicyReasonCode` from Iteration 1 with pure
  helper scenarios.
- Preserved existing runtime behavior by not wiring these helpers into services,
  routes, state-sync, or room authorization yet.

**Tests added or updated:**

- `packages/tests/shared-server/group-policy.test.ts`

**Verification performed:**

- Red test was observed before implementation:
  - pure policy helper exports were missing.
- Green focused test was observed after implementation.

**Deferred by design:**

- No API-v1 route, group state service, state-sync routing, browser workflow, or
  WS room authorization behavior was changed in this iteration.
- Later iterations will decide how these pure helpers are wired into runtime
  paths and whether any reason codes need operation-specific status codes.

## Iteration 3: Lifecycle Enforcement For Archived And Deleted Groups

**Status:** implemented.

**Scope completed:**

- Added a lifecycle-only `canMutateActiveGroup` policy helper so runtime guards
  can block archived/deleted mutations without prematurely enforcing admission
  or capacity policy.
- Policy-gated group member upsert, presence connect, presence heartbeat, and
  director appointment against archived/deleted groups.
- Policy-gated non-lifecycle `updateGroup` changes against archived/deleted
  groups while preserving status-only lifecycle transitions.
- Updated room WS authorization to use `canSendRoomMessage` and return a
  structured unauthorized denial for archived/deleted lifecycle failures while
  preserving the previous bare `false` result for non-lifecycle session denials.
- Added a route mutation inbox seam for tests and preserved the production
  default middleware inbox path.
- Updated app-inbox failed-result handling so `GroupPolicyDeniedError` is a
  terminal failure with serialized policy details instead of a retryable queue
  error.
- Updated API-v1 group mutation processing to reconstruct serialized app-inbox
  policy denials and return stable policy-coded REST errors.

**Tests added or updated:**

- `apps/api-v1/test/services/group-state-service.test.ts`
- `apps/api-v1/test/routes/state-api-routes-hardening.test.ts`
- `packages/tests/shared-server/group-policy.test.ts`
- `packages/tests/shared-server/ws-topic-room-authorizer.test.ts`
- `packages/tests/shared-server/app-inbox-service.test.ts`

**Verification performed:**

- Red tests were observed before implementation:
  - archived/deleted service mutations did not reject,
  - lifecycle-only policy helper export was missing,
  - WS authorizer returned a bare `false` for archived/deleted groups,
  - route dependency seam was missing,
  - app-inbox policy denials were retried and timed out.
- Green focused tests were observed after implementation.

**Deferred by design:**

- Admission policy, invite/code validation, member/session capacity enforcement,
  membership governance operations, and read-visibility alignment remain for
  later iterations.
- Disconnect/expiry cleanup paths still run for archived/deleted groups so
  stale presence can be cleaned up.
- WS nack reason remains the existing AL `unauthorized`; the policy code is
  included in the authorizer log message to avoid widening the AL control
  protocol in this lifecycle slice.

## Iteration 4: Expiry, Empty, And Purge Lifecycle

**Status:** implemented.

**Scope completed:**

- Made active-group mutation policy expiry-aware using existing
  `expiresAtEpochMs` and `group-not-active` reason code.
- Policy-gated join-like member activation, presence connect, heartbeat,
  director appointment, and non-lifecycle updates for expired active groups
  through the existing lifecycle mutation guard.
- Added deterministic `emptySinceEpochMs` handling:
  - last live session disconnect sets `emptySinceEpochMs`,
  - expired presence cleanup sets `emptySinceEpochMs` to the reconciliation
    timestamp,
  - reconnect/heartbeat reactivation clears `emptySinceEpochMs`.
- Added a pure `shouldPlanGroupPurge` helper for `purgeAfterEpochMs` planning.
- Characterized purge behavior as non-destructive in this iteration; presence
  expiry reconciliation does not enqueue purge work, and durable group state is
  not deleted by the expiry scan.

**Tests added or updated:**

- `apps/api-v1/test/services/group-state-service.test.ts`
- `packages/tests/shared-server/group-policy.test.ts`
- `packages/tests/shared-server/presence-expiry-reconciliation-service.test.ts`

**Verification performed:**

- Red tests were observed before implementation:
  - expired groups still allowed member activation/presence connect,
  - `emptySinceEpochMs` was not set when the last live session left,
  - expiry-aware lifecycle policy returned allowed,
  - purge-planning helper export was missing.
- The purge/non-deletion service characterization also caught and corrected a
  test setup issue around repository TTLs before final verification.
- Green focused tests were observed after implementation.

**Deferred by design:**

- No destructive group, member, session, or event purge was implemented.
- Final retention windows, audit behavior, and durable purge mechanics remain a
  later product/cleanup decision.

## Iteration 5: Explicit Join Endpoint And Admission Policy

**Status:** implemented.

**Scope completed:**

- Added `JoinGroupRequest` with optional `inviteToken` and `joinCode`.
- Added `GROUP_JOIN` app-inbox handling and a group join payload.
- Added `GroupStateService.joinGroup` as the server-owned join intent path.
- Wired `POST /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/join`
  through API-v1 and the group app inbox.
- Enforced `canJoinGroup` for explicit joins and legacy self-active member
  upserts.
- Switched browser `joinStateGroup` to call the explicit join endpoint before
  connecting presence.
- Removed browser-side membership repair for group presence 403s so denied
  joins are surfaced instead of repaired through raw active upsert.
- Passed optional `inviteToken` and `joinCode` from `rooms.join`/`rooms.enter`
  into the safe browser join workflow.

**Tests added or updated:**

- `apps/api-v1/test/services/group-state-service.test.ts`
- `apps/api-v1/test/routes/state-api-routes-hardening.test.ts`
- `packages/tests/shared-server/app-inbox-service.test.ts`
- `packages/tests/shared-web/api-workflows.test.ts`
- `packages/tests/shared-web/rallar-workflow-options-compat.test.ts`

**Verification performed:**

- Red tests were observed before implementation:
  - `joinGroup`, `JoinGroupRequest`, and `GROUP_JOIN` were missing,
  - browser join still used member upsert,
  - browser presence repair still converted 403s into raw active membership
    upserts,
  - room join invite/code values were not passed into the workflow.
- Green focused and compatibility checks were observed after implementation:
  - `deno test --allow-env --allow-read test/services/group-state-service.test.ts test/routes/state-api-routes-hardening.test.ts`
  - `npx vitest run packages/tests/shared-server/app-inbox-service.test.ts packages/tests/shared-web/api-workflows.test.ts packages/tests/shared-web/rallar-workflow-options-compat.test.ts`
  - `npx vitest run packages/tests/shared-web/shared-web-public-api-snapshots.test.ts packages/tests/shared-web/shared-web-browser-entrypoints.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts`
  - `npx vitest run packages/tests/shared-server/group-policy.test.ts packages/tests/shared/group-policy-types.test.ts packages/tests/shared-server/ws-topic-room-authorizer.test.ts`
  - `npx tsc -p packages/shared/tsconfig.json --noEmit`
  - `npx tsc -p packages/shared-server/tsconfig.json --noEmit`
  - `npx tsc -p packages/shared-web/tsconfig.json --noEmit`
  - `npm --workspace @ar-eye-hunter/shared-server run build`
  - `npm --workspace @ar-eye-hunter/shared-web run build`
  - `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`
  - `deno task check` in `apps/api-v1`

**Deferred by design:**

- Invite token and join-code validation remain minimal until the invite/code
  workflow iteration adds durable issuance and validation semantics.
- Membership governance operations remain separate from browser self-join.
- Full capacity hardening for all mutation paths remains in the capacity
  iteration, though explicit joins now use the existing pure admission helper.

## Iteration 6: Capacity Enforcement

**Status:** implemented.

**Scope completed:**

- Added an explicit pure `canActivateGroupMember` policy helper for active-member
  capacity checks that does not apply admission-mode rules.
- Enforced `maxMembers` for active member upserts, including owner/admin-driven
  activation of another principal.
- Preserved self-active upsert admission policy from Iteration 5 while adding
  the same member-cap guard through the join policy path.
- Enforced `maxSessionsPerMember` during presence connect using the pure
  presence policy helper.
- Preserved existing missing/non-active member presence errors while adding the
  session-cap denial after membership is proven active.
- Confirmed idempotent accepted joins and presence connects do not consume
  capacity twice.
- Confirmed over-cap denials leave roster/presence versions unchanged.
- Added browser workflow coverage for stable `group-full` and
  `member-session-limit-reached` policy error codes.

**Tests added or updated:**

- `apps/api-v1/test/services/group-state-service.test.ts`
- `packages/tests/shared-server/group-policy.test.ts`
- `packages/tests/shared-web/api-workflows.test.ts`

**Verification performed:**

- Red tests were observed before implementation:
  - `maxMembers` over-cap active upsert did not reject,
  - `maxSessionsPerMember` over-cap presence connect did not reject.
- Green focused and compatibility checks were observed after implementation:
  - `deno test --allow-env --allow-read test/services/group-state-service.test.ts`
  - `deno test --allow-env --allow-read test/services/group-state-service.test.ts test/routes/state-api-routes-hardening.test.ts`
  - `npx vitest run packages/tests/shared-server/group-policy.test.ts packages/tests/shared-web/api-workflows.test.ts`
  - `npx vitest run packages/tests/shared-server/group-policy.test.ts packages/tests/shared/group-policy-types.test.ts packages/tests/shared-server/app-inbox-service.test.ts packages/tests/shared-server/ws-topic-room-authorizer.test.ts packages/tests/shared-web/api-workflows.test.ts packages/tests/shared-web/rallar-workflow-options-compat.test.ts`
  - `npx tsc -p packages/shared/tsconfig.json --noEmit`
  - `npx tsc -p packages/shared-server/tsconfig.json --noEmit`
  - `npx tsc -p packages/shared-web/tsconfig.json --noEmit`
  - `npm --workspace @ar-eye-hunter/shared-server run build`
  - `npm --workspace @ar-eye-hunter/shared-web run build`
  - `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`
  - `deno task check` in `apps/api-v1`

**Deferred by design:**

- Owner/admin capacity bypass remains intentionally unsupported.
- Durable invite/code workflows and governance-specific member operations remain
  later iterations.
- Session-cap checks apply to live presence connects; broader room-message and
  state-sync consistency work remains in later routing/authorization iterations.

## Iteration 7: Invite Workflow

**Status:** implemented.

**Scope completed:**

- Added shared request types for creating, revoking, and accepting group invites.
- Added group app-inbox operations for invite create, revoke, and accept.
- Added `GroupStateService` invite methods:
  - owners/admins can invite target principals,
  - regular members are rejected by governance policy,
  - removed/banned invite targets are policy-denied,
  - revoked invites become non-active and cannot be accepted,
  - accepting an invite delegates to the existing join/admission path.
- Applied the plan's recommended default invite expiry of seven days when no
  explicit expiry is provided.
- Added API-v1 invite endpoints:
  - `POST /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/invites/:principalId`
  - `POST /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/invites/:principalId/revoke`
  - `POST /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/invites/accept`
- Added low-level browser HTTP/workflow helpers for invite create, revoke, and
  accept.
- Added browser accept-invite workflow behavior that accepts the invite before
  connecting group presence.

**Tests added or updated:**

- `apps/api-v1/test/services/group-state-service.test.ts`
- `apps/api-v1/test/routes/state-api-routes-hardening.test.ts`
- `packages/tests/shared-server/app-inbox-service.test.ts`
- `packages/tests/shared-web/api-workflows.test.ts`

**Verification performed:**

- Red tests were observed before implementation:
  - invite app-inbox types and enum values were missing,
  - group state service invite methods were missing,
  - API-v1 invite routes were missing,
  - browser invite workflow helpers were missing.
- Green focused and compatibility checks were observed after implementation:
  - `deno test --allow-env --allow-read test/services/group-state-service.test.ts test/routes/state-api-routes-hardening.test.ts`
  - `npx vitest run packages/tests/shared-server/app-inbox-service.test.ts packages/tests/shared-web/api-workflows.test.ts`
  - `npx vitest run packages/tests/shared-server/group-policy.test.ts packages/tests/shared/group-policy-types.test.ts packages/tests/shared-server/ws-topic-room-authorizer.test.ts packages/tests/shared-web/rallar-workflow-options-compat.test.ts packages/tests/shared-web/shared-web-public-api-snapshots.test.ts packages/tests/shared-web/shared-web-browser-entrypoints.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts`
  - `npx tsc -p packages/shared/tsconfig.json --noEmit`
  - `npx tsc -p packages/shared-server/tsconfig.json --noEmit`
  - `npx tsc -p packages/shared-web/tsconfig.json --noEmit`
  - `npm --workspace @ar-eye-hunter/shared-server run build`
  - `npm --workspace @ar-eye-hunter/shared-web run build`
  - `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`
  - `deno task check` in `apps/api-v1`

**Deferred by design:**

- Invite token issuance/storage remains out of scope; existing invited-member
  state is the durable invite representation for this iteration.
- High-level browser administration facade methods remain deferred to the safe
  browser admin facade iteration.
- Dedicated invite-revoked event/status types were not added; revocation uses
  the existing non-active member transition and `member-left` event.

## Iteration 8: Join-Code Workflow

**Status:** implemented.

**Scope completed:**

- Added shared request/response types for rotating a group join code.
- Added a group app-inbox operation for join-code rotation.
- Added `GroupStateService.rotateGroupJoinCode` as the server-owned rotation
  path.
- Added API-v1 join-code rotation endpoint:
  - `POST /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/join-code/rotate`
- Stored only a verifier and expiry metadata in group-owned state; the
  plaintext join code is returned only by the rotation response.
- Validated code-group joins against the stored verifier and expiry.
- Preserved the recommended default that codes are reusable until expiry, with
  rotation invalidating the prior code.
- Preserved existing state route rate limiting for the new endpoint instead of
  adding a custom dependency.
- Added low-level browser HTTP/workflow helpers so browser flows can pass a
  join code through the existing safe join workflow.

**Tests added or updated:**

- `apps/api-v1/test/services/group-state-service.test.ts`
- `apps/api-v1/test/routes/state-api-routes-hardening.test.ts`
- `packages/tests/shared-server/app-inbox-service.test.ts`
- `packages/tests/shared-web/api-workflows.test.ts`

**Verification performed:**

- Red tests were observed before implementation:
  - join-code rotation request/response types were missing,
  - `GROUP_JOIN_CODE_ROTATE` app-inbox handling was missing,
  - `GroupStateService.rotateGroupJoinCode` was missing,
  - API-v1 join-code rotation route was missing,
  - browser join-code rotation workflow helper was missing.
- Green focused and compatibility checks were observed after implementation:
  - `deno test --allow-env --allow-read test/services/group-state-service.test.ts test/routes/state-api-routes-hardening.test.ts`
  - `npx vitest run packages/tests/shared-server/app-inbox-service.test.ts packages/tests/shared-web/api-workflows.test.ts`
  - `npx vitest run packages/tests/shared-server/group-policy.test.ts packages/tests/shared/group-policy-types.test.ts packages/tests/shared-server/ws-topic-room-authorizer.test.ts packages/tests/shared-web/rallar-workflow-options-compat.test.ts packages/tests/shared-web/shared-web-public-api-snapshots.test.ts packages/tests/shared-web/shared-web-browser-entrypoints.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts`
  - `npx tsc -p packages/shared/tsconfig.json --noEmit`
  - `npx tsc -p packages/shared-server/tsconfig.json --noEmit`
  - `npx tsc -p packages/shared-web/tsconfig.json --noEmit`
  - `npm --workspace @ar-eye-hunter/shared-server run build`
  - `npm --workspace @ar-eye-hunter/shared-web run build`
  - `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`
  - `deno task check` in `apps/api-v1`

**Deferred by design:**

- One-use join codes were not implemented; reusable-until-expiry remains the
  default product behavior for this slice.
- High-level browser administration facade methods for rotating codes remain
  deferred to the browser facade expansion iteration.
- Additional custom brute-force throttling was not added because the endpoint
  uses existing authenticated state-route rate limiting.

## Iteration 9: Membership Governance

**Status:** implemented.

**Scope completed:**

- Added shared request types for removing, banning, unbanning, role changes,
  and ownership transfer.
- Added explicit group event types for unban, role change, and ownership
  transfer, and updated the API-v1 OpenAPI event enum.
- Added group app-inbox operations for remove, ban, unban, role set, and
  ownership transfer.
- Added `GroupStateService` governance methods:
  - owners can govern all member targets,
  - admins can govern regular members,
  - admins cannot target owners/admins,
  - ownership transfer is owner-only,
  - unban moves a banned member to `left` rather than `active`,
  - the role endpoint cannot mint owners; ownership transfer is the owner-role
    path.
- Added last-owner protection for raw leave, remove, ban, and demote paths.
- Added API-v1 governance endpoints:
  - `POST /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/members/:principalId/remove`
  - `POST /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/members/:principalId/ban`
  - `POST /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/members/:principalId/unban`
  - `PUT /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/members/:principalId/role`
  - `POST /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/owner/transfer`
- Preserved the generic member route as self-service-only for browser callers.
- Added low-level browser HTTP/workflow helpers for governance operations and
  recorded the intentional shared-web public export additions.
- Confirmed strict REST snapshot/event reads reject banned members under the
  current conservative read policy.

**Tests added or updated:**

- `apps/api-v1/test/services/group-state-service.test.ts`
- `apps/api-v1/test/routes/state-api-routes-hardening.test.ts`
- `packages/tests/shared-server/group-policy.test.ts`
- `packages/tests/shared-server/app-inbox-service.test.ts`
- `packages/tests/shared-web/api-workflows.test.ts`
- `packages/tests/shared-web/shared-web-public-api-snapshots.test.ts`

**Verification performed:**

- Red tests were observed before implementation:
  - governance request types and app-inbox enum values were missing,
  - group state service governance methods were missing,
  - API-v1 governance routes were missing,
  - browser governance workflow helpers were missing.
- Green focused and compatibility checks were observed after implementation:
  - `deno test --allow-env --allow-read test/services/group-state-service.test.ts test/routes/state-api-routes-hardening.test.ts`
  - `npx vitest run packages/tests/shared-server/group-policy.test.ts packages/tests/shared-server/app-inbox-service.test.ts packages/tests/shared-web/api-workflows.test.ts packages/tests/shared-web/shared-web-public-api-snapshots.test.ts`
  - `npx vitest run packages/tests/shared-server/group-policy.test.ts packages/tests/shared/group-policy-types.test.ts packages/tests/shared-server/ws-topic-room-authorizer.test.ts packages/tests/shared-web/rallar-workflow-options-compat.test.ts packages/tests/shared-web/shared-web-public-api-snapshots.test.ts packages/tests/shared-web/shared-web-browser-entrypoints.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts`
  - `npx tsc -p packages/shared/tsconfig.json --noEmit`
  - `npx tsc -p packages/shared-server/tsconfig.json --noEmit`
  - `npx tsc -p packages/shared-web/tsconfig.json --noEmit`
  - `npm --workspace @ar-eye-hunter/shared-server run build`
  - `npm --workspace @ar-eye-hunter/shared-web run build`
  - `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`
  - `deno task check` in `apps/api-v1`

**Deferred by design:**

- High-level `rooms.removeMember`, `rooms.banMember`, `rooms.unbanMember`,
  `rooms.setMemberRole`, and `rooms.transferOwnership` facade methods remain
  deferred to Iteration 10.
- Full REST/state-sync read visibility alignment remains deferred to Iteration
  11; this slice only preserves the current conservative banned-member REST
  behavior.
- Complete OpenAPI path modeling for the state mutation routes remains a
  hardening/docs task because the resource already lacks earlier invite and
  join-code route entries.

## Iteration 10: Safe Browser Create, Update, And Admin Facade

**Status:** implemented.

**Scope completed:**

- Expanded the safe room create input to accept optional group policy fields:
  `joinMode`, `maxMembers`, `maxSessionsPerMember`, `description`, `metadata`,
  `expiresAtEpochMs`, and `purgeAfterEpochMs`.
- Added low-level browser workflows for updating, archiving, and deleting state
  groups.
- Added high-level room facade methods for `update`, `archive`, `delete`,
  `invite`, `acceptInvite`, `removeMember`, `banMember`, `unbanMember`,
  `setMemberRole`, and `transferOwnership`.
- Routed the high-level browser methods through the policy-owned API workflows
  added in earlier iterations rather than exposing arbitrary raw membership
  mutation.
- Preserved `rooms.updateMetadata` as the compatibility convenience path.
- Propagated operation options through the new methods and hydrated browser
  caches from successful mutation responses.
- Reused scoped room reference validation so mismatched `roomId` and `roomRef`
  inputs are rejected before network calls.
- Updated shared-web public API snapshots for the intentional new exports.

**Tests added or updated:**

- `packages/tests/shared-web/rallar-rooms-facade.test.ts`
- `packages/tests/shared-web/rallar-workflow-options-compat.test.ts`
- `packages/tests/shared-web/api-workflows.test.ts`
- `packages/tests/shared-web/shared-web-public-api-snapshots.test.ts`

**Verification performed:**

- Red tests were observed before implementation:
  - safe create fields were not forwarded by the create-and-join workflow,
  - low-level update/archive/delete workflows were missing,
  - high-level room facade administration methods were missing,
  - facade factory delegation for the new methods was missing.
- Green focused checks were observed after implementation:
  - `npx vitest run packages/tests/shared-web/rallar-rooms-facade.test.ts packages/tests/shared-web/rallar-workflow-options-compat.test.ts packages/tests/shared-web/api-workflows.test.ts packages/tests/shared-web/shared-web-public-api-snapshots.test.ts`
  - `npx vitest run packages/tests/shared-web/shared-web-browser-entrypoints.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts`
  - `npx tsc -p packages/shared/tsconfig.json --noEmit`
  - `npx tsc -p packages/shared-web/tsconfig.json --noEmit`
  - `npm --workspace @ar-eye-hunter/shared-web run build`
  - `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`
  - `git diff --check`

**Deferred by design:**

- No API-v1/server policy behavior changed in this iteration; the browser
  facade now consumes endpoints and workflows from prior policy iterations.
- REST read visibility, state-sync routing, and room messaging authorization
  alignment remains deferred to Iteration 11.
- Full API reference documentation and OpenAPI path completion remain part of
  the final hardening/docs pass.

## Iteration 11: Read Visibility Alignment

**Status:** implemented.

**Scope completed:**

- Added an explicit `readGroupVisibility` group policy helper that classifies
  group reads as `full`, `invite`, `directory`, or `none`.
- Tightened `canReadGroupSnapshot` to mean full group-state snapshot access:
  active members can read full snapshots/events, invited members are classified
  as invite-visible but cannot read full state, directory-only callers are
  classified separately, and removed, banned, and deleted visibility remains
  conservative.
- Replaced API-v1's local strict group read condition with the shared policy
  helper so REST snapshot, event-list, event-page, and list filtering use the
  same full-state rule.
- Updated state-sync routing so full `groupStateSnapshot`, `groupStateEvent`,
  overlay topology-as-group-event, and `groupDirectorySnapshot` payloads route
  only to full-read members.
- Stopped routing full directory snapshots to directory-only/non-member
  sessions until a separate limited directory payload/view is modeled.
- Preserved non-strict REST behavior behind `RALLAR_STATE_STRICT_READ_AUTH`.

**Tests added or updated:**

- `packages/tests/shared-server/group-policy.test.ts`
- `packages/tests/shared-server/state-sync-routing.test.ts`
- `packages/tests/shared-server/rallar-middleware.test.ts`
- `packages/tests/shared-server/state-sync-publisher.test.ts` (covered in
  focused verification)
- `apps/api-v1/test/routes/state-api-routes-hardening.test.ts`

**Verification performed:**

- Red tests were observed before implementation:
  - `readGroupVisibility` was missing,
  - invited members were still allowed by `canReadGroupSnapshot`,
  - invited members and directory-only sessions still received full WS
    snapshots,
  - deleted groups were still readable by active members under strict REST.
- Green focused checks were observed after implementation:
  - `npx vitest run packages/tests/shared-server/group-policy.test.ts packages/tests/shared-server/state-sync-routing.test.ts packages/tests/shared-server/rallar-middleware.test.ts`
  - `deno test --allow-env --allow-read test/routes/state-api-routes-hardening.test.ts`
  - `npx vitest run packages/tests/shared-server/group-policy.test.ts packages/tests/shared-server/state-sync-routing.test.ts packages/tests/shared-server/state-sync-publisher.test.ts packages/tests/shared-server/rallar-middleware.test.ts`
  - `npx tsc -p packages/shared/tsconfig.json --noEmit`
  - `npx tsc -p packages/shared-server/tsconfig.json --noEmit`
  - `npm --workspace @ar-eye-hunter/shared-server run build`
  - `deno task check` in `apps/api-v1`
  - `git diff --check`

**Deferred by design:**

- A typed limited invite-visible/directory response payload is still deferred;
  this iteration prevents full snapshot leakage rather than introducing a new
  client view contract.
- Room messaging authorization alignment remains deferred to Iteration 12.
- Production documentation for strict read posture remains part of the final
  hardening/docs pass.

## Iteration 12: Room Messaging Authorization Alignment

**Status:** implemented.

**Scope completed:**

- Kept room message authorization delegated to `canSendRoomMessage` and surfaced
  structured denial decisions for all policy failures rather than only lifecycle
  failures.
- Added stable unauthorized denial details for missing live sessions, removed
  members, banned members, archived/deleted groups, and scoped target mismatch.
- Preserved existing `not-yet-in-sync` decisions for missing/stale snapshots
  when a message requires a newer `minSnapshotVersion`.
- Confirmed read-through authorization refreshes stale warm snapshots when a
  message requires a newer version, then rejects the refreshed policy-denied
  state.
- Preserved existing active member room communication behavior.

**Tests added or updated:**

- `packages/tests/shared-server/ws-topic-room-authorizer.test.ts`

**Verification performed:**

- Red tests were observed before implementation:
  - missing live session, removed member, banned member, refreshed banned
    snapshot, and scoped mismatch denials returned bare `false`.
- Green focused checks were observed after implementation:
  - `npx vitest run packages/tests/shared-server/ws-topic-room-authorizer.test.ts`
  - `npx vitest run packages/tests/shared-server/ws-topic-room-authorizer.test.ts packages/tests/shared-server/group-policy.test.ts`
  - `npx vitest run packages/tests/shared-web/rallar-room-realtime-channel.test.ts packages/tests/shared-web/rallar-messages-facade.test.ts packages/tests/shared-web/rallar-message-channel-compat.test.ts`
  - `npx tsc -p packages/shared/tsconfig.json --noEmit`
  - `npx tsc -p packages/shared-server/tsconfig.json --noEmit`
  - `npm --workspace @ar-eye-hunter/shared-server run build`
  - `deno task check` in `apps/api-v1`
  - `git diff --check`

**Deferred by design:**

- No browser facade changes were needed for this iteration.
- Broader room switching consistency work remains deferred to Iteration 13.

## Iteration 13: Room Switching Consistency

**Status:** implemented.

**Scope completed:**

- Preserved default best-effort switching behavior for `rooms.join(...)` and
  `rooms.createAndSwitch(...)`.
- Confirmed create/join failures before the new room is joined do not leave the
  previous current room.
- Added a typed `RallarRoomSwitchPartialFailureError` shape for the case where
  joining or creating the new room succeeds but leaving the previous room fails.
- Included `operation`, `joinedRoom`, `previousRoomRef`, and `leaveError` on
  partial-failure errors so apps can recover without guessing which room is now
  current.
- Updated join switching so the successful joined room is set as current and
  hydrated before the best-effort leave-old step.
- Updated shared-web public API snapshots for the intentional type export.

**Tests added or updated:**

- `packages/tests/shared-web/rallar-workflow-options-compat.test.ts`
- `packages/tests/shared-web/shared-web-public-api-snapshots.test.ts`

**Verification performed:**

- Red tests were observed before implementation:
  - leave-old failure after create-and-switch rejected with the raw leave error,
  - leave-old failure after join rejected with the raw leave error,
  - the thrown error did not expose the successful joined room or previous room
    reference.
- Green focused checks were observed after implementation:
  - `npx vitest run packages/tests/shared-web/rallar-workflow-options-compat.test.ts`
  - `npx vitest run packages/tests/shared-web/rallar-workflow-options-compat.test.ts packages/tests/shared-web/shared-web-public-api-snapshots.test.ts`
  - `npx tsc -p packages/shared-web/tsconfig.json --noEmit`
  - `npx vitest run packages/tests/shared-web/rallar-workflow-options-compat.test.ts packages/tests/shared-web/rallar-rooms-facade.test.ts packages/tests/shared-web/rallar-readiness.test.ts packages/tests/shared-web/shared-web-public-api-snapshots.test.ts`
  - `npx vitest run packages/tests/shared-web/shared-web-browser-entrypoints.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts`
  - `npm --workspace @ar-eye-hunter/shared-web run build`
  - `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`
  - `npx tsc -p packages/shared/tsconfig.json --noEmit`
  - `git diff --check`

**Deferred by design:**

- Server-enforced single-room membership remains a future feature.
- Documentation and broader compatibility hardening remain deferred to
  Iteration 14.

## Iteration 14: Documentation, Snapshots, And Compatibility Pass

**Status:** implemented.

**Scope completed:**

- Added a docs compatibility test that locks the API reference, quickstart,
  environment variable docs, and OpenAPI spec to the implemented group policy
  workflows.
- Documented browser-safe room administration workflows:
  `rooms.update`, `rooms.archive`, `rooms.delete`, `rooms.invite`,
  `rooms.acceptInvite`, `rooms.removeMember`, `rooms.banMember`,
  `rooms.unbanMember`, `rooms.setMemberRole`, and `rooms.transferOwnership`.
- Documented admission inputs and room-switch recovery semantics, including
  `joinMode`, `inviteToken`, `joinCode`, and
  `RallarRoomSwitchPartialFailureError`.
- Documented server-side policy reason codes, strict REST read rollout through
  `RALLAR_STATE_STRICT_READ_AUTH`, and the alignment expectations for REST
  reads, state-sync routing, and room messaging authorization.
- Added quickstart recipes for invite-only rooms, code-protected rooms, and
  partial room-switch recovery.
- Expanded the API-v1 OpenAPI spec with the group join, invite, join-code,
  governance, ownership-transfer routes, request/response schemas, the optional
  error `code` shape, and `GroupPolicyReasonCode`.

**Tests added or updated:**

- `packages/tests/shared-web/rallar-group-docs-compat.test.ts`
- `docs/rallar-api-reference.md`
- `docs/rallar-quickstart-and-recipes.md`
- `docs/environment-variables.md`
- `apps/api-v1/resources/api-v1-openapi.yaml`

**Verification performed:**

- Red tests were observed before documentation/spec updates:
  - `npx vitest run packages/tests/shared-web/rallar-group-docs-compat.test.ts`
    failed because the new room admin workflows, policy reasons,
    `RALLAR_STATE_STRICT_READ_AUTH`, and OpenAPI routes/schemas were not yet
    documented.
- Green focused checks were observed after updates:
  - `npx vitest run packages/tests/shared-web/rallar-group-docs-compat.test.ts`
  - `npx vitest run packages/tests/shared-web/rallar-group-docs-compat.test.ts packages/tests/shared-web/shared-web-public-api-snapshots.test.ts packages/tests/shared-web/shared-web-browser-entrypoints.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts`
  - `npx vitest run packages/tests/shared-web/api-workflows.test.ts packages/tests/shared-web/rallar-rooms-facade.test.ts packages/tests/shared-web/rallar-workflow-options-compat.test.ts packages/tests/shared-web/rallar-room-realtime-channel.test.ts packages/tests/shared-web/rallar-messages-facade.test.ts packages/tests/shared-web/rallar-message-channel-compat.test.ts`
  - `npx vitest run packages/tests/shared-server/group-policy.test.ts packages/tests/shared-server/ws-topic-room-authorizer.test.ts packages/tests/shared-server/state-sync-routing.test.ts packages/tests/shared-server/rallar-middleware.test.ts`
  - `deno test --allow-env --allow-read test/services/group-state-service.test.ts test/routes/state-api-routes-hardening.test.ts`
  - `ruby -e "require 'yaml'; YAML.load_file('apps/api-v1/resources/api-v1-openapi.yaml'); puts 'openapi yaml parsed'"`
  - `npx tsc -p packages/shared/tsconfig.json --noEmit`
  - `npx tsc -p packages/shared-web/tsconfig.json --noEmit`
  - `npx tsc -p packages/shared-server/tsconfig.json --noEmit`
  - `deno task check` in `apps/api-v1`
  - `npm --workspace @ar-eye-hunter/shared-web run build`
  - `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`
  - `npm --workspace @ar-eye-hunter/shared-server run build`
  - `git diff --check`

**Deferred by design:**

- A high-level `rooms.rotateJoinCode(...)` facade method was not added in this
  documentation pass. The docs describe the currently implemented lower-level
  `rotateStateGroupJoinCode(...)` workflow helper instead.
- Broader full-stack/browser app runs remain outside this docs-focused
  iteration and should be handled in final integration hardening if needed.

## Finish-Line Verification: Group Policy Safety Gate

**Status:** completed.

**Completion audit:**

- Iterations 3 through 14 are represented in the local diff with matching
  service, route, shared policy, state-sync, room authorization, browser facade,
  public API, documentation, and regression-test changes.
- The original report gaps are covered or explicitly deferred:
  - admission policy, invite/code join semantics, capacity enforcement,
    lifecycle enforcement, membership governance, read visibility,
    browser-safe administration, room switching consistency, policy-safe
    authorization, and stable policy errors are implemented with focused tests.
  - durable purge deletion, limited invite/directory client views,
    one-use join codes, custom brute-force throttling, server-enforced
    single-room membership, and high-level `rooms.rotateJoinCode(...)` remain
    documented deferred work.
- The root report path used for this audit was `docs/rallar-groups-report.md`;
  the prompt's root-level `rallar-groups-report.md` path was stale.

**Full diff review findings:**

- Blocker found and fixed: invite-only groups accepted any non-empty
  `inviteToken` because `canUseInvite(...)` allowed tokens when no expected
  server token was supplied. The fix requires an expected invite token before a
  token can satisfy admission; ordinary invite-only admission now relies on an
  active invited-member record.
- High findings: none remaining after the invite-token fix.
- Follow-up hardening completed: direct
  `GroupStateService.rotateGroupJoinCode(...)` now stores and replays an
  idempotent service-level result for repeated request ids, preserving the
  originally returned plaintext code and expiry.
- Medium/low residual risk: room-message authorization still depends on callers
  using scoped refs and/or `minSnapshotVersion` when freshness matters; the
  read-through tests cover stale-cache refresh for min-version sends.

**Tests added or updated during finish-line verification:**

- `apps/api-v1/test/services/group-state-service.test.ts`
  - added a regression proving an uninvited principal cannot join an
    invite-only group with an arbitrary `inviteToken`.
  - added a direct service regression proving join-code rotation retries replay
    the original request-id result instead of rotating to a second code.
- `packages/tests/shared-web/rallar-facade-compat.test.ts`
  - updated the compatibility facade shape for the intentional `rooms.*`
    administration methods.
- `tests/playwright/rallar-black-box/full-stack-quick-test-ws.spec.ts`
  - updated full-stack setup so Alice invites Bob before Bob joins Alice's
    default invite-only Quick Test room.
- `docs/rallar-api-reference.md` and
  `apps/api-v1/resources/api-v1-openapi.yaml`
  - clarified that `inviteToken` is reserved for token-verifier invite flows and
    is not standalone admission proof.

**Exploratory regression matrix:**

| Case | Coverage | Priority | Result / Follow-up |
| --- | --- | --- | --- |
| Open group join | Service + full-stack memory | High | Covered and passing. |
| Invite-only missing invite | Service + browser policy errors | Blocker | Covered and passing. |
| Arbitrary invite token | Service regression | Blocker | Added and fixed. |
| Code group missing/invalid/expired code | Service + browser workflow | High | Covered and passing. |
| Expired invite | Service | High | Covered and passing. |
| Banned/removed member rejoin | Policy + service + WS auth | High | Covered and passing. |
| Left member rejoin | Service | Medium | Covered and passing for open groups. |
| Owner/admin governance hierarchy | Policy + service + route | High | Covered and passing. |
| Full group `maxMembers` | Policy + service + browser workflow | High | Covered and passing. |
| `maxSessionsPerMember` | Policy + service + browser workflow | High | Covered and passing. |
| Archived/deleted join/presence/message | Service + route + WS auth | High | Covered and passing. |
| Deleted group visibility | Strict REST read tests | High | Covered and passing. |
| Last owner leave/remove/ban/demote | Policy + service | High | Covered and passing. |
| REST read visibility | Route tests | High | Covered and passing. |
| State-sync visibility | Routing tests | High | Covered and passing. |
| Browser `rooms.join` | Workflow tests + full-stack memory | High | Covered and passing. |
| Browser admin workflows | Facade/workflow tests + docs | Medium | Covered and passing. |
| Room switching `leaveCurrent` | Workflow compatibility tests | Medium | Covered and passing. |
| Join succeeds but leave-current fails | Workflow compatibility tests | Medium | Covered and passing with typed partial-failure error. |
| Direct join-code rotation idempotency | Service regression | Medium | Follow-up completed and passing. |

**Validation performed:**

- Red/green blocker verification:
  - `deno test --allow-env --allow-read test/services/group-state-service.test.ts`
    failed before the invite-token fix with "Missing expected rejection", then
    passed after the fix with 30/30 tests.
- Red/green follow-up verification:
  - `deno test --allow-env --allow-read test/services/group-state-service.test.ts`
    failed before the direct join-code idempotency fix because the retry
    returned `second-code`, then passed after the fix with 31/31 tests.
- Focused validation:
  - `deno test --allow-env --allow-read test/services/group-state-service.test.ts test/routes/state-api-routes-hardening.test.ts`
    passed, 43/43 tests.
  - `npx vitest run packages/tests/shared-server/group-policy.test.ts packages/tests/shared/group-policy-types.test.ts packages/tests/shared-server/app-inbox-service.test.ts packages/tests/shared-server/ws-topic-room-authorizer.test.ts packages/tests/shared-server/state-sync-routing.test.ts packages/tests/shared-server/rallar-middleware.test.ts packages/tests/shared-server/presence-expiry-reconciliation-service.test.ts packages/tests/shared-web/api-workflows.test.ts packages/tests/shared-web/rallar-rooms-facade.test.ts packages/tests/shared-web/rallar-workflow-options-compat.test.ts packages/tests/shared-web/rallar-room-realtime-channel.test.ts packages/tests/shared-web/rallar-messages-facade.test.ts packages/tests/shared-web/rallar-message-channel-compat.test.ts packages/tests/shared-web/shared-web-public-api-snapshots.test.ts packages/tests/shared-web/shared-web-browser-entrypoints.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts packages/tests/shared-web/rallar-group-docs-compat.test.ts`
    passed, 17/17 files and 146/146 tests.
  - `npx vitest run packages/tests/shared-web/rallar-facade-compat.test.ts`
    passed after updating the intentional facade shape, 2/2 tests.
- Typecheck, lint, build, and docs/spec validation:
  - `npx tsc -p packages/shared/tsconfig.json --noEmit` passed.
  - `npx tsc -p packages/shared-server/tsconfig.json --noEmit` passed.
  - `npx tsc -p packages/shared-web/tsconfig.json --noEmit` passed.
  - `deno task check` in `apps/api-v1` passed.
  - `deno task lint` in `apps/api-v1` passed, 60 files checked.
  - `npm --workspace @ar-eye-hunter/shared-server run lint` passed.
  - `npm --workspace @ar-eye-hunter/shared-web run lint` passed.
  - `npm --workspace @ar-eye-hunter/shared-server run build` passed.
  - `npm --workspace @ar-eye-hunter/shared-web run build` passed.
  - `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`
    passed with all browser bundle budgets OK.
  - `ruby -e "require 'yaml'; YAML.load_file('apps/api-v1/resources/api-v1-openapi.yaml'); puts 'openapi yaml parsed'"`
    passed.
  - `git diff --check` passed.
- Broader validation:
  - `npm run test:unit` passed after updating the intentional rooms facade
    compatibility list, 255/255 files passed and 1 skipped; 1728/1728 tests
    passed and 1 skipped.
  - `npm run test:deno` passed, including API-v1 117/117, control server 37/37,
    Relic server `deno task check`, and shared-test Deno RTC provider tests
    146/146.
  - `npm run test:rallar:full-stack:memory` initially exposed the full-stack
    Quick Test setup gap, then passed after inviting Bob before join, 7/7
    Playwright tests.

**Checks not run:**

- Postgres-backed integration and live RTC/postgres exhaustive suites were not
  run locally. The memory full-stack path, focused service/route tests, and
  broad Deno/Vitest suites passed; remaining Postgres/live RTC coverage is
  optional merge hardening rather than a blocker for this local diff.

**Product-owner acceptance:**

- Accepted with caveats. The implementation satisfies the planned group-policy
  scope and keeps browser room workflows ergonomic while routing admin flows
  through policy-specific endpoints.
- Caveats are the documented deferred product decisions around durable purge,
  limited invite/directory views, one-use codes, custom throttling, and
  server-enforced single-room membership.

**Policy-bypass challenge conclusion:**

- Invite-only arbitrary-token bypass was found and fixed.
- No remaining blocker/high bypasses were found in REST routes, app-inbox
  processing, group service policy, state-sync routing, WS room authorization,
  or browser workflows.

**Documentation/API consistency conclusion:**

- Public docs and OpenAPI now document group policy reason codes, join modes,
  invite/code workflows, browser room administration methods, strict read
  rollout, capacity/lifecycle behavior, and room-switch partial failure.
- `inviteToken` docs now match the implemented safety behavior.

**Final merge-readiness recommendation:**

- Safe to merge: yes.
- Suggested commit message: `Harden Rallar group policy workflows`.
