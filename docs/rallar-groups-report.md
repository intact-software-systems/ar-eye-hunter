# Rallar Groups Report

This report reviews current Rallar group and room behavior in the browser
facade, API-v1 routes, shared group service, and realtime routing policies. It
focuses on whether Rallar has comprehensive group communication support, not on
general realtime transport quality.

## Executive Summary

Rallar has a strong room communication foundation: scoped group identity,
presence snapshots, room sessions, WS and RTC room messages, room event replay,
state-sync routing, and RTC readiness helpers. The browser API is ergonomic for
game-like "create a room, enter it, exchange realtime messages" flows.

The group-management layer is less complete. The data model already contains
fields for join mode, roles, member statuses, invite expiry, capacity, group
lifecycle, and retention. However, several of those fields are stored but not
enforced consistently. Browser `rooms.*` APIs also expose room-session workflows
more than comprehensive group CRUD and membership governance.

The main product gap is not transport policy. Rallar already has many message
delivery controls through AL, WS, RTC, and room helpers. The missing pieces are
domain policies for group admission, membership authority, lifecycle state,
read visibility, and browser-safe group administration workflows.

## Scope Inspected

Primary browser files:

- `packages/shared-web/browser/rallar.ts`
- `packages/shared-web/browser/rooms/browser-rallar-rooms.ts`
- `packages/shared-web/browser/rooms/room-group-state-workflows.ts`
- `packages/shared-web/browser/rooms/room-group-state-mutation-workflows.ts`
- `packages/shared-web/browser/rooms/room-membership-group-state-workflows.ts`
- `packages/shared-web/browser/rooms/room-group-state-http-api.ts`
- `packages/shared-web/browser/rallar-operation-options.ts`

Primary shared/server files:

- `packages/shared/api/group-types.ts`
- `packages/shared/api/state-types.ts`
- `packages/shared/api/group-client-views.ts`
- `packages/shared-server/rallar-system/group-state/group-state-service.ts`
- `packages/shared-server/rallar-system/websocket/ws-topic-room-authorizer.ts`
- `packages/shared-server/rallar-system/state-sync/state-sync-routing.ts`
- `apps/api-v1/src/routes/group-state-routes.ts`
- `apps/api-v1/src/main.ts`

Relevant tests and docs:

- `packages/tests/shared-web/api-workflows.test.ts`
- `packages/tests/shared-web/rallar-operation-options.test.ts`
- `packages/tests/shared-web/rooms/room-group-state-workflows.test.ts`
- `packages/tests/shared-server/group-state-service-idempotency.test.ts`
- `apps/api-v1/test/services/group-state-service.test.ts`
- `apps/api-v1/test/routes/state-api-routes-hardening.test.ts`
- `docs/rallar-api-reference.md`

## Current Browser Group Model

The browser presents groups primarily as rooms. The public `rooms` facade
supports:

- `state`, `list`, `refresh`, `current`, and subscriptions.
- `create` and `createAndSwitch`.
- `join`, `enter`, `session`, and `leave`.
- `updateMetadata`.
- `waitForPresence`.
- `onEvent`, `listEvents`, `listEventPage`, and `replayEvents`.

`RallarRoomSession` then binds room-scoped communication helpers:

- `message(...)` for typed room messages with RTC/WS strategy support.
- `realtime(...)` for room-scoped RTC JSON lanes.

This is good for browser apps that need a current room and active peers. It is
not yet a complete group administration surface. The browser facade does not
currently expose first-class methods for full group update, archive, delete,
invite, accept invite, remove, ban, unban, promote, demote, or ownership
transfer.

## Current CRUD Behavior

### Create

Browser `rooms.create(input)` calls `createAndJoinStateGroup(...)`. It creates a
group, connects the caller's group presence session, makes the group current,
and hydrates local caches.

Browser create input is intentionally narrow:

- String input becomes `displayName`.
- Object input supports `displayName`, optional `groupId`, `scope`, and generic
  operation options.

The lower-level server contract supports more group fields:

- `slug`
- `description`
- `kind`
- `joinMode`
- `maxMembers`
- `maxSessionsPerMember`
- `metadata`
- expiry and purge timestamps

The browser create workflow always creates a `room` with `joinMode:
invite-only` and empty metadata. It does not let callers configure the broader
group contract.

### Read

Browser reads are available through:

- `rooms.refresh(...)`
- `rooms.state()`
- `rooms.current()`
- `rooms.list()`
- `rooms.session(...).snapshot()`
- event list/page/replay helpers

API-v1 mounts `/api/state/*` behind authentication in `main.ts`. Group route
membership filtering is stricter only when `RALLAR_STATE_STRICT_READ_AUTH` is
enabled. With strict reads enabled, group snapshot and event reads require the
caller to be an active member. With strict reads disabled, authenticated state
reads preserve the broader legacy behavior.

State-sync routing is more selective than non-strict REST reads: group snapshots
and events route only to active or invited members in the same scope, with live
session checks.

### Update

Browser `rooms.updateMetadata(room, patch, options?)` is metadata-only. It first
reads the current group, merges the patch with existing metadata, and submits an
`UpdateGroupRequest`.

API-v1 requires the authenticated caller to be an active owner or admin before
updating a group through the generic update route. The server group service can
update display name, description, kind, status, join mode, capacity fields,
metadata, and lifecycle timestamps.

The browser facade does not expose a typed full update operation for those
fields. Consumers can only patch metadata through the high-level room API unless
they call lower-level HTTP helpers or advanced middleware paths.

### Delete And Archive

The group data model has `status: active | archived | deleted`, and
`updateGroup` emits `group-archived` or `group-deleted` events when status
changes. There is no dedicated browser `rooms.archive(...)` or
`rooms.delete(...)` helper.

Realtime room message authorization checks that the group is active before
authorizing room messages. The group state service itself does not consistently
block membership or presence mutations against archived/deleted groups.

### Membership

The model supports member roles and statuses:

- Roles: `owner`, `admin`, `member`.
- Statuses: `invited`, `active`, `left`, `removed`, `banned`.

The browser `join` workflow self-upserts the authenticated principal to
`active`, then connects presence. The browser `leave` workflow disconnects
presence, then self-upserts membership to `left`.

The API-v1 self-service membership route only allows the authenticated caller to
change their own membership and only supports `active` or `left`. That protects
against direct browser self-promotion, direct self-ban, or modifying another
principal. However, it also means invite, remove, ban, role changes, and
ownership transfer are not available as high-level browser group workflows.

The shared group service preserves roles across leave and rejoin. This is good
for owner/admin continuity, but it also means rejoin behavior needs explicit
policy checks for removed and banned members.

### Presence

Presence connect requires an active group member. Missing, left, removed, and
banned members are rejected by the group service. Presence heartbeat refreshes
TTL without publishing unchanged snapshots. Expired presence sessions can be
disconnected by reconciliation.

Current enforcement is membership-status based. It does not appear to enforce
`maxSessionsPerMember`, group status, join mode, or group capacity.

## Available Policies

### Browser Operation Policies

`RallarOperationOptions` provides generic command controls:

- `signal`
- `timeoutMs`
- `maxAttempts`
- `shouldRetry`
- `dataChannelLanes`
- `maxPeerConnections`

Runtime defaults can provide operation policies through `rallar.setDefaults({
operations: ... })`. These flow into command workflows for refresh, create,
join, leave, metadata update, event listing, and heartbeat paths.

### Browser Workflow Policies

The browser workflows use `CommandsOrchestratorPolicies` under the hood. This
supports command retry, timeout, cancellation, fallback, circuit breaker, rate
limiter, hooks, and null handling at the command layer.

The public room facade exposes only a small subset of that through
`RallarOperationOptions`. That is appropriate for most app code, but it means
group-domain policies are not currently configurable from the high-level room
API.

### Transport And Message Policies

The message layer is comparatively complete. Rallar supports:

- WS, RTC, realtime, WS-then-RTC, and RTC-with-WS-fallback strategies.
- TTL hops and TTL milliseconds.
- Best-effort and at-least-once reliability.
- Ack mode.
- Shared or exclusive ownership.
- RTC fanout limit.
- Min snapshot version for room routing freshness.
- Scoped `GroupRef` targets for room communication.
- AL QoS normalization for delivery, forwarding, repair, ack, expiry, retry,
  dedup, supersedence, fanout, congestion, durability, and ownership.

This is the strongest current policy area.

### Server Routing And Authorization Policies

Room WS authorization uses scoped group snapshots when available and rejects
inactive groups or senders without a live group session. State-sync routing
targets group state to active or invited group members in the same
application/workspace and filters live sessions.

This protects room traffic better than generic REST group management. The
remaining weakness is that routing authorization assumes the group service has
already produced policy-correct state.

## Missing Group Policies

### Admission Policy

`joinMode` exists, but join behavior does not appear to enforce it:

- `open`
- `code`
- `invite-only`

Needed policies:

- Open join allowed.
- Invite-only join requires a valid active invite for the authenticated
  principal.
- Code join requires a join code or token with expiry and attempt throttling.
- Rejoin policy distinguishes previous `left` from `removed` and `banned`.
- Owner/admin bypass rules are explicit.

### Capacity Policy

`maxMembers` and `maxSessionsPerMember` exist on `Group`, but no service-level
enforcement was found in member upsert or presence connect.

Needed policies:

- Maximum active member count.
- Maximum live sessions per member.
- Whether owners/admins count toward caps.
- Whether invited-but-not-active members reserve slots.
- Full-room error shape suitable for browser workflows.

### Membership Governance Policy

The route layer prevents self-service role escalation, but it does not expose
admin workflows for group governance.

Needed policies:

- Who can invite.
- Who can accept invites.
- Who can remove members.
- Who can ban and unban members.
- Who can promote/demote admins.
- Who can transfer ownership.
- Whether the last owner can leave, be removed, or demoted.
- Whether banned members can still read historical events.

### Lifecycle Policy

The model supports archived, deleted, expires-at, empty-since, and purge-after
fields, but enforcement is uneven.

Needed policies:

- Archived group: readable? joinable? messageable? metadata editable?
- Deleted group: visible to whom, and for how long?
- Expired group: automatic archive/delete/leave behavior.
- Empty room: when `emptySinceEpochMs` is set and how cleanup runs.
- Purge: when durable state and events can be deleted.

### Read Visibility Policy

Strict read auth is currently environment-controlled. State-sync sends invited
members some group state, while strict REST reads require active membership.

Needed policies:

- Public directory visibility.
- Invite-visible group metadata.
- Member-only snapshots.
- Role-based event access.
- Whether invited members can read event history.
- Default production posture for strict reads.

### Invite And Code Policy

The model has `invitedByPrincipalId` and `invitationExpiresAtEpochMs`, but the
browser does not expose invite workflows and the join workflow does not require
an invite.

Needed policies:

- Invite creation and revocation.
- Invite expiry validation.
- Join code creation, rotation, expiry, and attempt limits.
- One-use vs reusable invites.
- Invite metadata redaction for non-members.

### Consistency Policy For Room Switching

`rooms.createAndSwitch(...)` and default `rooms.join(..., { leaveCurrent: true
})` model "one current room" flows, while `rooms.create(...)` preserves old
membership.

Needed policies:

- Atomicity expectations for join-then-leave-current and create-then-leave-old.
- Recovery behavior when leave-current fails after join succeeds.
- Whether apps can require single-room membership at the server layer.

### Admin API And Browser Facade Policy

The browser lacks a policy-safe group administration facade. Lower-level
contracts are present, but high-level use requires custom calls.

Needed browser surface:

- `rooms.update(room, request, options?)`
- `rooms.archive(room, options?)`
- `rooms.delete(room, options?)`
- `rooms.invite(room, principalId, options?)`
- `rooms.acceptInvite(room, options?)`
- `rooms.removeMember(room, principalId, options?)`
- `rooms.banMember(room, principalId, options?)`
- `rooms.unbanMember(room, principalId, options?)`
- `rooms.setMemberRole(room, principalId, role, options?)`
- `rooms.transferOwnership(room, principalId, options?)`

These should call policy-specific API endpoints instead of exposing raw
`upsertMember` semantics directly to browsers.

## Recommended Implementation Direction

### 1. Add Server-Side Group Policy Evaluation

Introduce pure policy helpers near the group domain, then call them from
`group-state-service.ts` and route-specific admin workflows.

Candidate helpers:

- `canReadGroupSnapshot(...)`
- `canJoinGroup(...)`
- `canInviteGroupMember(...)`
- `canAcceptGroupInvite(...)`
- `canLeaveGroup(...)`
- `canRemoveGroupMember(...)`
- `canBanGroupMember(...)`
- `canUpdateGroupMetadata(...)`
- `canChangeGroupLifecycle(...)`
- `canConnectGroupPresenceSession(...)`

Inputs should include the snapshot, actor principal/session, target principal,
current time, and the requested operation. Results should be structured:

- `allowed: true`
- `allowed: false`
- stable reason code
- user-safe message
- optional diagnostic detail

### 2. Make Join Explicitly Policy-Aware

Do not let browser join mean "self-upsert active" for all groups. The server
should decide if the self-upsert is allowed based on join mode, invite state,
capacity, ban/removal status, and lifecycle state.

The browser can keep an ergonomic `rooms.join(...)`, but it should pass intent:

- join as current user
- optional invite token
- optional join code
- leave-current preference

### 3. Add Group Admin Endpoints

Prefer narrow routes over exposing raw `UpdateGroupRequest` and
`UpsertGroupMemberRequest` for every browser governance case.

Suggested endpoints:

- `POST /groups/:groupId/invites`
- `POST /groups/:groupId/invites/accept`
- `POST /groups/:groupId/members/:principalId/remove`
- `POST /groups/:groupId/members/:principalId/ban`
- `POST /groups/:groupId/members/:principalId/unban`
- `PUT /groups/:groupId/members/:principalId/role`
- `POST /groups/:groupId/owner/transfer`
- `POST /groups/:groupId/archive`
- `POST /groups/:groupId/delete`

Keep the generic update route for trusted admin/server-side use, but provide
policy-specific browser workflows.

### 4. Align Read Visibility

Choose a production default for strict group reads. If invited members receive
group state over state-sync, REST reads should have an explicit matching rule or
a documented reason for being stricter.

Recommended default:

- Active members can read full group snapshot and events.
- Invited members can read limited invite-visible metadata.
- Non-members can read only public directory fields for open/public groups.
- Deleted/banned visibility is explicit and conservative.

### 5. Preserve Scoped Identity Everywhere

Continue requiring `GroupRef` where application/workspace scope matters. The
browser can retain string `roomId` ergonomics for single-scope flows, but policy
evaluation and server mutations should resolve to a scoped ref before applying
state changes.

### 6. Add Focused Tests Before API Expansion

Add tests that prove current missing policy cases before implementing fixes:

- Invite-only group rejects join without invite.
- Code group rejects join without valid code.
- Banned and removed members cannot rejoin by self-upsert.
- `maxMembers` blocks new active members when full.
- `maxSessionsPerMember` blocks extra presence sessions.
- Archived/deleted groups reject join, presence connect, and messages.
- Strict REST read behavior matches state-sync visibility for invited members.
- Last owner cannot accidentally leave a group ownerless unless transfer policy
  allows it.
- Browser `rooms.join` sends the required invite/code intent and surfaces stable
  policy error codes.

## Product Assessment

Rallar is close to comprehensive support for room-based realtime communication.
It is not yet comprehensive for group governance.

The core split is:

- **Strong today:** scoped room identity, presence, room sessions, WS/RTC
  communication, transport policy, event replay, state-sync routing, director
  coordination, and browser operation retry/timeouts.
- **Missing or incomplete:** admission policy, invite/code semantics, capacity
  enforcement, lifecycle enforcement, membership governance, read visibility
  policy, and browser-safe group admin workflows.

For Rallar to claim comprehensive group communication support, group policy
must become an explicit domain layer rather than implied behavior spread across
browser workflows, route guards, service mutations, and transport authorizers.
