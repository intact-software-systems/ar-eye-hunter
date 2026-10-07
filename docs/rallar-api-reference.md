# Rallar API Reference

This document describes the public facade APIs in:

- `packages/shared-web/browser/rallar.ts`
- `packages/shared-web/browser/rallar-data.ts`
- `packages/shared-server/rallar-system/middleware/create-rallar-middleware.ts`

It also references the server facade wrappers where they are the normal way to consume the middleware runtime.

## API-v1 Mutation Ownership

**AppInbox is mandatory for incoming database mutations.** Every HTTP and
WebSocket database mutation uses it, including client/group/topology,
authentication/session/ticket, CRDT append/admin, and mutating admin operations.
AppInbox owns the transaction and retry boundary; synchronous result waiting
never falls back to a direct mutation.

The `read` phase loads the repository decision surface outside the write
transaction. Only `compute` and `validate` are pure, and they produce computed
persistence data, not a plan. The service `write(transaction, computed)` applies
it: service write receives the transaction and never opens or retries one.
State, event, receipt, result, and final `APP_OUTBOX`/`WS_OUTBOX` rows commit
together; the final queue rows are written directly through
`PSqlResourceInboxRepository` in the same transaction. There is no intermediate
mutation outbox. Logical WebSocket audience resolution happens only after
commit; queue workers are then woken or poll.

Resource inbox permits 20 total processing attempts: 1, 2, 4, 8, and 16 ms for
attempts one through five, then increasing seconds capped at 30 seconds with
jitter. A separate best-effort fairness lane claims retries more than 30 seconds
overdue. Queue locks are coordination-only, not domain row/advisory/CRDT lock
precedent. Authoritative persisted and shared contracts use mandatory fields by
default.

## Browser Rallar

Import one shared facade instance, or create a separate facade with its own connection state, defaults, and current room. Facades in one page still share the API base URL set by `configure(...)` and the stored auth session:

```ts
import { createRallarFacade, rallar } from '@shared-web/browser/rallar.ts';

const isolated = createRallarFacade();
```

### Defaults And Configuration

`configure(config)` sets the browser API base URL. It must be called before the facade connects.

```ts
rallar.configure({ apiBaseUrl: 'http://localhost:8080' });
```

`setDefaults(defaults)` stores facade defaults for scope, room, realtime, RTC, message payload size, operation policies, and diagnostics ports.

```ts
rallar.setDefaults({
    applicationId: 'game',
    workspaceId: 'default',
    room: { roomId: 'lobby' },
    realtime: { laneId: 'realtime', openTimeoutMs: 1000 },
    rtc: {
        waitTimeoutMs: 1000,
        connectOnWait: true,
        maxPeerConnections: 10,
        rttReportingDegreeLimit: 5
    },
    messages: { maxPayloadBytes: 64 * 1024 },
    operations: { timeoutMs: 5000, maxAttempts: 3 }
});
```

`defaults()` returns a clone of the current defaults or `undefined`.

`setup(input)` is the browser golden path. It calls `configure`, stores
defaults, then calls `start`. Unless overridden through `input.start`, it uses
`restoreSession: true`, `connect: true`, `refreshRooms: true`, and
`refreshPeople: false`.

```ts
const started = await rallar.setup({
    apiBaseUrl: 'http://localhost:8080',
    applicationId: 'game',
    workspaceId: 'default',
    rtc: { maxPeerConnections: 10, rttReportingDegreeLimit: 5 }
});
```

Route IDs used for rooms, topics, types, lanes, overlays, and peers must be routable Rallar IDs: already-trimmed strings of 1-128 characters using letters, numbers, `.`, `_`, `:`, or `-`. Room IDs are stable route IDs; display names remain human-readable text.

Browser sends validate caller input before enqueueing. Invalid caller input throws `RallarValidationError` with structured `.issues`; delivery and readiness outcomes arrive as values instead. `messages.*.send(...)` resolves to a `RallarMessageHandle` whose `lifecycle()` reports the delivery `state` and per-attempt outcomes such as `not-ready`, `no-targets`, or `unroutable` (with reason `no-route`), while room realtime sends resolve to results with statuses such as `not-ready` and `no-targets`.

```ts
import { isRallarValidationError } from '@shared/api/rallar-validation.ts';

try {
    await rallar.messages.ws.send({
        scope: 'room',
        roomId: 'lobby',
        topicId: 'room.chat',
        typeId: 'chat.message.v1',
        payload: { text: 'hello' }
    });
}
catch (error) {
    if (isRallarValidationError(error)) {
        console.warn(error.issues);
    }
}
```

User WebSocket topics must start with `app.` or `room.`. RTC topics only need to be route-safe.

Active RTC topology keeps the server graph degree limit at `5` by default. Browser room transitions may retain old inactive RTC peer connections up to `rtc.maxPeerConnections`, default `10`, so changing rooms can be smooth without increasing active graph degree. RTT heartbeat measurement is separately capped by `rtc.rttReportingDegreeLimit`, defaulting to the published overlay degree limit or `5` before an overlay arrives. These are connect-time settings; reconnect to apply changes after middleware exists.

### Lifecycle

`connect(options?)` initializes browser middleware and opens the websocket transport.

`start(options?)` is the higher-level startup API. It can restore a session, connect, and refresh room/people state.

```ts
await rallar.auth.login({ username: 'alice', password: 'secret' });

const started = await rallar.start({
    restoreSession: true,
    connect: true,
    refreshRooms: true,
    refreshPeople: true
});
```

`disconnect()` closes active middleware resources.

`status()` returns `'idle'`, `'connecting'`, or `'connected'`.

`isConnected()` returns whether the facade is connected.

`session()` returns the current stored `AuthSession`, if present.

`subscriptions()` creates a scope for grouping unsubscribe callbacks:

```ts
const scope = rallar.subscriptions();
scope.add(rallar.rooms.onChange((state) => renderRooms(state)));
scope.add(rallar.ws.onLifecycle((event) => console.log(event.kind)));

scope.unsubscribe();
```

`flow(policies?)` creates a `CommandsOrchestrator` for caller-owned command orchestration.

`advanced.middleware()` returns the initialized browser middleware. Use this only when the facade does not expose the lower-level operation you need.

### Auth

`auth.login(request, options?)` logs in, disconnects any existing or initializing middleware, ends the previously stored session and closes its data scopes, writes the new session locally, and emits a `login` auth change.

`auth.register(request, options?)` registers a user. Pass `adminSession` if the API requires an admin session.

`auth.registerAndLogin(request, options?)` registers and then logs in.

`auth.logout(options?)` clears the local session, disconnects, calls the logout API when a session exists, closes authenticated data scopes, purges the ended session's browser ALM rows, emits state and a `logout` auth change, and then rethrows the first cleanup failure, if any. `auth.login` over a stored session, and a `connect` whose stored session changed, purge the replaced session's rows the same way after the disconnect. A purge that fails never keeps the session from ending: it states each of that session's stores `failing` on the `storage` diagnostics port.

`auth.restore()` reads the locally stored session.

`auth.isLoggedIn()` returns whether a stored session exists.

`auth.onChange(listener, options?)` subscribes to `RallarAuthState` changes; the reason is `current`, `login`, `logout`, `expired`, or `unauthorized`.

```ts
await rallar.auth.registerAndLogin({
    username: 'alice',
    password: 'secret',
    displayName: 'Alice'
});
```

### Rooms

`rooms.state()` returns the current derived room state.

`rooms.list()` returns room summaries.

`rooms.refresh(input?)` fetches complete current room and client snapshot
collections from the API and updates local caches. A room session's
`refresh()` performs one group point read for that exact `roomRef`, without a
revision-floor query, followed by that room's topology read-through, and
updates only that room; a `404` drops the unchanged cached room before the
error is rethrown.

`rooms.create(input)` creates a group/room, joins it, and makes it current.
`input` can be a display name string or an object. It does not leave the
previous current room, so use it when multi-room membership is intentional.
Object input can include `groupId`, `displayName`, `description`, `joinMode`,
`maxMembers`, `maxSessionsPerMember`, `metadata`, `expiresAtEpochMs`,
`purgeAfterEpochMs`, and `lifecyclePolicy`. `joinMode` is one of `open`,
`invite-only`, or `code`. `lifecyclePolicy` is the sparse `GroupLifecyclePolicyInput`
described in `docs/rallar-group-formation-architecture.md`; omitting it creates the
group with the `optimistic` preset, exactly as before.

`rooms.createAndSwitch(input)` creates a group/room, makes it current, and then
leaves the previous current room when it is different. It accepts the same input
shape as `rooms.create(...)` and is the preferred browser-app helper for "new
arena, leave the old arena" flows.

`rooms.join(roomIdOrRef, options?)` joins a room. By default it leaves the current room if different. `rooms.join({ roomId })` and `rooms.join({ roomRef })` are also supported; if both are present, `roomId` must match `roomRef.groupId`. Pass `joinCode` for code-protected groups. Invite-only membership uses `rooms.acceptInvite(...)`; the `inviteToken` option is reserved for token-verifier invite flows and is not accepted as standalone admission proof. Use `leaveCurrent: false` when the browser should stay in the previous room too.

`rooms.enter(roomIdOrRef, options?)` joins a room and returns a
`RallarRoomSession` bound to that room.

`rooms.session(room?)` returns a `RallarRoomSession` for an explicit room, the
default room, or the current room without joining.

`RallarRoomSession` exposes `roomId`, `roomRef`, `snapshot()`, `summary()`,
`leave()`, `refresh()`, `message(...)`, `realtime(...)`, and `formation`.

`rooms.formation(room?)` returns a `RallarRoomFormation` bound to an explicit room, the default
room, or the current room; `RallarRoomSession` exposes the same handle as `formation`. It carries
the eight application-facing formation commands of the group lifecycle
(`docs/rallar-group-formation-architecture.md`): `plan()`, `connect(options?)`, `activate()`,
`reconfigure({ landing? })`, `pause()`, `resume()`, `reset()` and `start()`. Each resolves to the
receipt `GroupSnapshot` once the transition committed; planning, publication and RTC readiness stay
asynchronous. `connect()` names the room's current planned layout and the cached formation epoch;
pass `layout` to name a specific `GroupLayoutIdentity`. When the planned slot is empty, or holds a
layout published past the cached snapshot, `connect()` refreshes the room once (the point read and
the topology read-through) before it posts. It throws a `RallarValidationError` without sending a
lifecycle request when that leaves nothing to name: issue `no-planned-layout` when the read-through
completed and nothing is published, `session-not-present` when the room does not count this session
as present (the read-through fills the slot only for present sessions, so pass `layout`), and
`planned-layout-read-failed` when the read-through did not complete.
`formation.status()` is the free, in-memory view: stage, epoch, attempt count, transport state,
which layout roles the browser dials, the accepted and planned layouts it holds, and the pushed
activation condition. Commands reject with `ApiHttpError`; `toRoomFormationDenial(error)`
returns `undefined` for any other error, maps the local `no-planned-layout` refusal to the
`group-connect-no-planned-layout` layout denial, and classifies a rejection as
`{ kind: 'policy', code, message }` for any policy reason code or
`{ kind: 'layout', code, message }` for `group-connect-stale-epoch`, `group-connect-no-planned-layout` and
`group-connect-planned-layout-superseded`, the three typed `409` conflicts of `connect`. Before it
rethrows one, `connect()` reads the room through on a stale epoch and forgets a refused layout, so
waiting for the layout the slot holds and connecting exactly that recovers from all three.

`formation.waitForLayout(options?)` is the explicit wait for a published layout: it observes the
browser's planned and accepted layout slots and resolves `ready` with the layout, or `timeout`,
`aborted` or `not-found`. `role` selects the slot (`planned` by default). `after` is a causal
revision fence, typically a receipt's `causalRevision`: only a layout published at or after it
satisfies the wait, and an incomparable one never does. After `plan` the unfenced form is right;
after `reconfigure` pass the receipt's revision, because the planned slot may still hold the
candidate the reconfigure superseded. `formation.waitForStage(stage | stages, options?)` and
`formation.waitForCondition(condition | conditions, options?)` resolve from the pushed group
snapshot. The waits take `timeoutMs` and `signal`, wake only on changes naming the bound room, and
report what they find at the deadline: a stage or layout that landed without a notification is
still `ready`. `not-found` means this browser has never held the room's snapshot; a snapshot that
expired from the cache keeps the wait going, and a room removed mid-wait ends as `timeout` with
`formation` undefined. `formation.onChange(listener, options?)` emits the status on every
observable change of the snapshot or either layout slot; a room leaving the cache emits nothing
here, because a status cannot represent absence, and is observed through `rooms.onChange`.
`formation.onLayout(listener)` emits `layoutPlanned`, `layoutAccepted` and `layoutRemoved` events
as the differences between consecutive statuses: a bootstrap or tombstoned slot is no layout, a
layout that appears and disappears before the browser observes it raises no event, and
`layoutAccepted` fires once the accepted slot and the snapshot name the same layout.
`formation.readView(options?)` fetches the server's `GroupFormationView` (readiness, managers,
`layoutStale`, `pending`, the attempt budget, both status axes and the coverage basis) and decodes
it against the bound room, rejecting a body that is malformed or names another group. Readiness
for application traffic stays `rtc.waitForRoom(...)` and `realtime.room().wait()`, which follow
the accepted layout only.

`rooms.leave(input?)` leaves a room. It can use explicit `roomId`, `roomRef`, the default room, or the current room.

`rooms.update(input)` updates owner/admin-controlled room fields, including
display metadata, `joinMode`, and capacity limits.

`rooms.updateMetadata(room, patch, options?)` merges `patch` into the room's
current metadata, owner/admin-only: a key whose patch value is `null` is
removed, and any other value replaces the key's value.

`rooms.archive(room, options?)` marks a room archived through the group update
policy. Archived groups reject joins, presence, room messaging, invites, and
member governance mutations.

`rooms.delete(room, options?)` marks a room deleted through the group update
policy. Deleted groups are treated as non-active by group policy.

`rooms.invite(room, principalId, options?)` creates an invited member record for
another principal. `rooms.acceptInvite(room, options?)` lets the invited
principal activate that membership.

`rooms.removeMember(room, principalId, options?)`,
`rooms.banMember(room, principalId, options?)`,
`rooms.unbanMember(room, principalId, options?)`,
`rooms.setMemberRole({ room, principalId, role, options? })`, and
`rooms.transferOwnership(room, principalId, options?)` are the browser-safe
membership governance workflows. They call server-side policy endpoints instead
of exposing raw membership mutation. The legacy self-upsert route remains
limited to self `active` or `left` transitions and ignores role changes.

`rooms.waitForPresence(room, options?)` waits for active room sessions to match
a readiness expectation. Expectations can be `{ min, max? }`, `{ exact }`, or
`{ sessionIds, allowExtras? }`; the default is `{ min: 1 }`. The result includes
the active session IDs, missing/extra IDs, observed/expected counts, and statuses
such as `ready`, `partial`, `empty`, `timeout`, `over-capacity`, `aborted`, and
`not-found`.

`rooms.current()` returns the current room snapshot.

`rooms.onChange(listener, options?)` subscribes to derived room state.

`rooms.onEvent(listener, options?)` subscribes to group state-sync events received over WS.

`rooms.listEvents(input)` lists persisted group events.

`rooms.listEventPage(input)` returns a paged event response with cursor metadata.

`rooms.replayEvents(input, listener?)` fetches pages of persisted room events, dedupes events already seen by the facade, and optionally feeds the events to a listener.

Room switching is best effort after a new room is successfully joined or
created. If joining/creating succeeds but leaving the previous room fails,
`rooms.join(...)` and `rooms.createAndSwitch(...)` reject with
`RallarRoomSwitchPartialFailureError`. The error includes `operation`,
`joinedRoom`, `previousRoomRef`, and `leaveError` so the app can recover while
knowing that the new room is now current.

```ts
interface RoomChatPayload {
    readonly text: string;
}

interface RoomMotionPayload {
    readonly x: number;
    readonly y: number;
}

const created = await rallar.rooms.createAndSwitch({
    displayName: 'Lobby',
    scope: { applicationId: 'game', workspaceId: 'default' }
});

const room = rallar.rooms.session(created.group);
const chat = room.message<RoomChatPayload>('chat');
const motion = room.realtime<RoomMotionPayload>('motion');

const presence = await rallar.rooms.waitForPresence(created.group, {
    expect: { min: 2, max: 8 },
    timeoutMs: 2000
});

rallar.rooms.onEvent((event) => {
    if (event.eventType === 'member-joined') {
        console.log('Room membership changed');
    }
});
```

### Group Policy And State Routes

Group admission, lifecycle, capacity, membership governance, read visibility,
and room-message authorization decisions live server-side. The pure policy layer
returns `GroupPolicyResult`, and denial responses surface stable
`GROUP_POLICY_REASON_CODES`.

Membership, capacity, and governance denials: `group-policy-denied`,
`group-invite-required`, `group-code-required`, `group-code-invalid`,
`group-invite-expired`, `group-archived`, `group-deleted`,
`group-not-active`, `group-full`, `member-session-limit-reached`,
`member-not-active`, `member-removed`, `member-banned`, `forbidden-role`,
and `last-owner`.

Formation-lifecycle denials, raised by the policy layer described in
`docs/rallar-group-formation-architecture.md`: `lifecycle-transition-invalid`
(the command is not legal from the group's current stage),
`lifecycle-manager-unavailable` (the policy names managers and the group
currently resolves none), `formation-attempts-exhausted` (the attempt budget
bounded this series, so `start` is denied until an explicit `reset`),
`group-admission-closed`, `group-admission-deadline-passed`,
`group-admission-capacity-reached` (the three admission windows), and
`group-data-blocked-until-active` (the pre-activation data gate, which denies
over WS only and reaches no HTTP response).

REST errors keep two shapes. Read routes answer `{ error }` and may also include
`code`, `message`, and `details`. Mutation routes, including every policy
workflow route below, answer the canonical `ApiMutationFailure` body
(`type`, `version`, `code`, `status`, `message`, `issues`, `denial`, `retry`),
which has no `error` field and carries policy details under `denial.details`.
Browser workflows preserve both on `ApiHttpError` (`mutationFailure`, and
`policyError` for the read shape), so apps can branch on stable policy reason
codes without string matching.

Client and group point reads support optional convergence floors:

- `readStateClientSnapshot(principalId, scope, { minStateRevision? })` returns
  `{ snapshot, source, stateRevision }`.
- `readStateGroupSnapshot(groupId, scope, { minCausalRevision? })` returns
  `{ snapshot, source, groupRevision, presenceRevision }`.
- `findStateGroup(...)` remains the body-only compatibility wrapper and returns
  `Promise<GroupSnapshot>`.

Floors are non-negative safe integers. Group callers provide both components
through `minCausalRevision`; the REST query sends both `minGroupRevision` and
`minPresenceRevision`. Malformed or partial floors return `400`. An authorized
durable snapshot that does not satisfy the requested floor returns `409` with
code `state-revision-floor-not-satisfied`; this is distinct from an
infrastructure `503`.

A point read without a floor observes durable state. An eligible floor-bearing
read may be served from a process cache. Successful responses include
`Cache-Control: no-store`, `rallar-state-source`, and the applicable
`rallar-state-revision` or `rallar-group-revision` plus
`rallar-presence-revision` headers. The browser readers validate the
authoritative body, requested identity, required headers, and header/body
revision agreement before returning.

`setBrowserStateReadDiagnosticsSink(...)` installs an optional browser sink for
bounded point, heartbeat, collection, topology read-through, reopen-resync, and
delta-apply outcomes. Events expose only the event name, feature, operation,
result, source when known, and duration. Do not add application,
workspace, principal, group, session, or request identifiers as metric labels.

The group state routes for the policy workflows are listed below. Each takes the
mutation request id only as the trailing `/requests/{requestId}` path segment
(20–128 characters of `[A-Za-z0-9_-]`); an `Idempotency-Key` header or a body
`requestId` is rejected with `400`.

- `POST /api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/join/requests/{requestId}`
- `POST /api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/invites/accept/requests/{requestId}`
- `POST /api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/join-code/rotate/requests/{requestId}`
- `POST /api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/invites/{principalId}/requests/{requestId}`
- `POST /api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/invites/{principalId}/revoke/requests/{requestId}`
- `POST /api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/admissions/{principalId}/grant/requests/{requestId}`
- `POST /api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/admissions/{principalId}/decline/requests/{requestId}`
- `POST /api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/members/{principalId}/remove/requests/{requestId}`
- `POST /api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/members/{principalId}/ban/requests/{requestId}`
- `POST /api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/members/{principalId}/unban/requests/{requestId}`
- `PUT /api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/members/{principalId}/role/requests/{requestId}`
- `POST /api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/owner/transfer/requests/{requestId}`

Join-code rotation is currently exposed through lower-level API integration and
workflow helpers. The plaintext code is returned only by the rotation response;
the group snapshot stores verifier metadata. Codes are reusable until expiry,
and rotation invalidates the previous code.

Set `RALLAR_STATE_STRICT_READ_AUTH` to `1` or `true` (`0` or `false` turns it off; any other value is a configuration error) on API-v1 to
align authenticated list/snapshot/event reads with full-state group read
policy. Without strict mode, client and group list, snapshot, and event reads
under `/api/state/*` accept unauthenticated requests; mutation routes and the
SPA statistics routes always require a bearer session. Strict mode requires an
authenticated session on those reads and adds the narrower server-side read
authorization before exposing full group state. The shipped `prod`,
`prod-hardened`, and `prod-in-memory` configuration profiles enable it
(`stateApi.strictReadAuthorization`), and production hardening rejects a
configuration without it.
Strict mode changes only API-v1 REST reads (client and group lists, point
snapshots, events, and graph topology reads). State-sync routing and WS
room-message authorization apply server-side group policy in every mode.

### SPA Statistics REST

API-v1 exposes actor-scoped, read-only SPA statistics under the state namespace:

- `GET /api/state/apps/:applicationId/workspaces/:workspaceId/stats/summary`
  returns workspace counts for the authenticated actor, including full-readable
  group count, joined group count, online member count across those readable
  groups, actor client-session count, actor group-presence count, bounded recent
  visible group activity count, and a limited safe `topGroups` list.
- `GET /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/stats`
  returns room/lobby counts after full group read policy passes: member count,
  online member count, active session count, group status/kind/join mode,
  snapshot/presence versions, actor role, actor active presence count, and a
  bounded recent group event count.
- `GET /api/state/apps/:applicationId/workspaces/:workspaceId/stats/me/realtime`
  returns self-only realtime readiness hints for the current auth session:
  process-local WebSocket openness, actor client-session state, and readable
  groups where that same session has active presence.

SPA statistics routes always require a route-local bearer auth session and
matching `x-client-id`; this is strict read auth independent behavior. They do
not depend on `RALLAR_STATE_STRICT_READ_AUTH` to protect actor, self-session, or
group-policy reads. Responses are actor-specific and return
`Cache-Control: no-store`.

The SPA statistics surface is separate from admin operations and does not expose admin operations DTOs, queue/runtime-state/app-data/auth-session internals,
CRDT storage pressure, raw event payloads, other users' session or connection
ids, or topology graphs. Workspace summary currently counts only groups the
actor can read fully; directory-visible open groups are intentionally omitted
until a limited directory DTO is designed. Activity counts are bounded recent
event counts rather than exact global counters.

### Director

`director.appoint(room?, options?)` appoints the current browser session as the
room director through the narrow state API endpoint
`POST .../groups/{groupId}/director/appoint/requests/{requestId}`. It does not call
`rooms.updateMetadata(...)`, and it does not grant the caller owner/admin
permissions.

Owners and admins can appoint while their own room session is active. For Rallar
Game's default browser-director policy, an active member may also appoint when no
owner/admin session is online and no existing director appointment has an active
session. `rooms.updateMetadata(...)` remains owner/admin-only for generic group
metadata changes.

`director.status(room?, options?)` reads the current appointment from local
state: `isDirector` says the appointment names the local session, and `isFresh`
says the appointed session is active with a fresh heartbeat; check both before
running authoritative work. `director.createRelay(...)` builds the
intent/output/snapshot relay around that appointment.

The relay addresses the director by role (D167): its `sendIntent(...)` and
`requestSync(...)` send on the room channel with `ack: 'group-leader'` over
`rtc-with-ws-fallback` and name no session, so the carrier that admits the send
resolves the director from the room snapshot (see Acknowledgement Modes) and
the director's ACK is the receipt. The result is `sent` once that ACK arrives,
within 30 s; a send the carrier refuses `no-leader` returns
`status: 'no-director'`. Before it sends, the relay itself returns
`no-director` when no director is appointed, `stale-director` when the
appointed director is not fresh, and `not-director` when the local session is
the director. The director's own outputs go to the whole room: with
`ack: 'all-logical-recipients'` when the output states it, best effort
otherwise.

`director.resign(room?, options?)` clears this session's appointment through
`rooms.updateMetadata(...)`, with a `null` patch value that removes the
appointment key, so it is subject to the same owner/admin policy;
`director.onStatus(listener)` subscribes to director status changes.

```ts
const room = rallar.rooms.session(created.group);

await rallar.director.appoint(room.roomRef, {
    heartbeatTtlMs: 4_000
});

const status = rallar.director.status(room.roomRef);
if (status.isDirector && status.isFresh) {
    startAuthoritativeLoop();
}
```

### Optional Match Support

Rallar match support is an optional layer for room-based browser activities. It
does not add a top-level `rallar.match` facade in V1. Import named helpers from
`@shared/rallar-match/mod.ts` and `@shared-web/game/mod.ts`.

Use `createRallarBrowserMatch` for browser-director matches where a live
room session holds the director lease and routes commands, snapshots, and
events. Its `participants(input)` function is the pure
`deriveRallarMatchParticipants(...)` helper: applications supply either a group
snapshot with members and active sessions or already-normalized browser member
rows. Configure `readStandingRows` to supply app-owned metrics and
`compareStandings` to define their ordering and tie semantics. Rallar does not
calculate points or choose the winning metric.

`finalizeResult(summary)` resolves the match `GroupRef`, reads the live
`rallar.director.status(...)`, and returns a `room-trusted` envelope only when
the current browser session holds a fresh director appointment. The envelope's
authority comes from that appointment. The shared
`createRallarMatchResult(...)` helper can construct only `local` or
`room-trusted` results; it cannot assign `server-validated` trust.

Use `createRallarAuthorityBrowserMatch` when the authoritative game or
activity loop lives behind Rallar Game Authority. Its authority must be
`kind: 'server'`; `submitCommand(...)` delegates app-owned commands through
Rallar Game Authority, while `standings()` uses the same app-provided
`readStandingRows` and optional `compareStandings` contract. Browser clients do
not mint `server-validated` results. Server-owned domain code creates those
envelopes with `createRallarServerValidatedMatchResult(...)` from `@shared-server/mod.ts` after validating
the match and server authority.

These helpers only derive values and construct or return envelopes. They do not
publish, transport, or persist participants, standings, or results. The
application must send or store the returned result through its own transport
and persistence path. Default result idempotency keys include the canonical
application/workspace/group scope and protocol as well as match, authority,
epoch, and finish-time components.

Rallar provides participant derivation, standings projection, result envelopes,
and diagnostics. The application still owns command legality, scoring rules,
win conditions, persistence, rewards, global leaderboards, and anti-cheat.

### Stats

`stats.summary(options?)` reads
`GET /api/state/apps/:applicationId/workspaces/:workspaceId/stats/summary`
for the current auth session and resolved scope.

`stats.group(roomIdOrRef, options?)` reads
`GET /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/stats`.
String room IDs use the provided or default scope; `GroupRef` input carries its
own application/workspace scope.

`stats.meRealtime(options?)` reads
`GET /api/state/apps/:applicationId/workspaces/:workspaceId/stats/me/realtime`
for the current auth session.

The lower-level browser API helpers are
`readStateWorkspaceStatsSummary(...)`, `readStateGroupStats(...)`, and
`readStateMyRealtimeStatus(...)`. All stats helpers forward the current
`AuthSession` unless an explicit API integration option overrides it.

### People

`people.state()` returns derived people/client state.

`people.list()` returns known people.

`people.refresh(input?)` fetches the complete client and group snapshot collections from the API and updates local caches.

`people.get(principalId)` returns one known person.

`people.onChange(listener, options?)` subscribes to derived people state.

`people.onEvent(listener, options?)` subscribes to client state-sync events received over WS.

`people.listEvents(principalId, options?)`, `people.listEventPage(...)`, and `people.replayEvents(...)` read persisted client events.

```ts
rallar.people.onChange((state) => {
    for (const person of state.people) {
        console.log(person.principalId, person.isOnline);
    }
});
```

### WS And RTC Messages

Rallar has two generic message lanes:

- `messages.ws` sends AL messages through websocket routing.
- `messages.rtc` sends AL messages through the WebRTC overlay.

Both lanes expose:

- `send(input)`
- `onMessage(selector, handler)`

`messages.rtc.send` and `messages.ws.send` (lane sends) are at-least-once and
volatile with a 30 s deadline: kept in the memory pair only, no IndexedDB. They
track no receipt unless the send states `ack` (or `qos.ack`); without one,
`transport-accepted` is terminal. Opt in to browser storage with
`qos: { durability: { algo: 'local-outbox' } }`, or to a checkpointed memory
send with `qos: { durability: { algo: 'local-checkpoint' } }`.

`messages.room<T>(definition)` creates a room channel directly;
`roomSession.message(...)` delegates to it. A typed channel exposes `send`,
`sendRtc`, `sendWs`, `onRtc` and `onWs`. A `RallarMessageHandle` exposes
`msgId`, `typeId`, `lifecycle()`, `onEvent(listener)`, `wait(options?)` and
`cancel()`.

Selectors can be a `typeId` string or `{ topicId, typeId }`.

```ts
rallar.messages.ws.onMessage('chat.message.v1', (message) => {
    console.log(message.payload);
});

await rallar.messages.ws.send({
    topicId: 'room.chat',
    typeId: 'chat.message.v1',
    payload: { text: 'hello' },
    scope: 'room',
    roomRef: room.roomRef
});
```

Typed channels reduce boilerplate when one payload type has one topic/type pair:

```ts
interface ChatMessage {
    readonly text: string;
}

const chat = rallar.messages.channel<ChatMessage>({
    topicId: 'room.chat',
    typeId: 'chat.message.v1',
    purpose: 'notification'
});

chat.onWs((payload) => console.log(payload.text));
await chat.sendWs({ text: 'hello' }, { scope: 'room', roomRef: room.roomRef });
```

`purpose` is required: `command` asks the addressed receiver, `notification`
the room's frozen audience; both are at-least-once, receipted, volatile and
30 s by default, and every send option overrides its default.
`durability: 'local-outbox'` or `'local-inbox'` opts the channel into browser
storage. When storage cannot hold a durable send, the handle reads `failed`
with `failure: { kind: 'storage-unavailable', cause }`; a channel defined with
`onStorageUnavailable: 'volatile'` sends the same message once without storage
instead, and its evidence names `durabilityDowngrade: { requested, cause }`
beside `admittedDurable: false`. A downgraded `local-inbox` send also loses the
receiver's inbox persistence, and a fallback carrier receives the downgraded
message. A lane send names no channel, so it always refuses. A `world` send
and a `best-effort` send ask for no receipt unless the send states `ack`; a
`world` send that states `receiver` or `all-logical-recipients` is refused
`unsupported`, since `world` names no logical audience (see Message Audiences
below). `recovery` names the channel's owner of
resynchronization (see Ordering, Repair And Resynchronization below).

`durability: 'local-checkpoint'` sits between `volatile` and `local-outbox`. The
send is admitted and dispatched from memory and spends no storage operation on
its way to the carrier; the tab that owns the session's work checkpoints what
changed into the browser database, in one IndexedDB transaction, at most once
per interval target (1 s) and when the page hides (`visibilitychange` to
hidden, `pagehide` or `freeze`), and writes nothing while nothing changed. The
next connect that owns the session's work, after a reload or in another tab,
restores the checkpoint before its first work batch: a message it reserved
retries under the lease rule, one whose deadline passed settles `expired`, and
a restored message has no handle. Receivers keep it in memory, as they keep
`local-outbox`. The limits are stated:

- **The loss window.** What was admitted after the last completed checkpoint is
  lost with the page: up to one interval target, and more when the page closes
  before its hide flush completes, since the flush is started and not awaited.
  An interrupted checkpoint leaves the previous one intact.
- **One tab checkpoints.** Only the tab that owns the session's work writes and
  restores the checkpoint. A waiting tab's `local-checkpoint` sends dispatch from
  that tab's memory, are lost with it, and read `admittedDurable: false`.
- **No positions.** A send that states a `seq` is refused `unsupported`, since a
  restored copy could reuse a position the receiver already saw; the ordering
  key alone and latest-wins sends are admitted.
- **Lag follows `onStorageUnavailable`.** A checkpoint store's `health` reads
  `delayed` once a checkpoint write failed or its oldest unsaved change is two
  interval targets old (a throttled timer); beyond the recovery-lag bound (10 s)
  it reads `failing` with cause `checkpoint-lag`. While a checkpoint store reads
  `failing`, for that lag or any other cause, new `local-checkpoint` sends
  follow the channel's `onStorageUnavailable` (`failed` with
  `storage-unavailable`, or one volatile send with a `durabilityDowngrade`)
  until a checkpoint completes. A browser without IndexedDB refuses them with
  cause `missing`, as it refuses durable sends.

The browser composition sets the interval target and the recovery-lag bound on
the store factory's input (`checkpointIntervalMs`, `checkpointLagBoundMs`),
1,000 ms and 10,000 ms by default
(`AL_CHECKPOINT_DEFAULT_SETTINGS`); no app-facing option exposes them yet.

Two tabs of one session share its durable stores, and one of them drains them:
where the browser has the Locks API, the tab holding the session's
durable-owner lock sends every tab's durable messages, and when it disconnects
or closes the next tab takes over and sends what it left; a message the closed
tab was still sending is retried once its lease ends, at most 19.1 s after.
The server keeps one WebSocket per session, so only one tab of a session stays
connected at a time; the hand-over is for close, reload and a tab that has no
socket. Over `BroadcastChannel` a waiting tab's durable send reaches the owner
at once, and its handle reads the settlements stated for it: the owner relays
its own, and any tab that admits the acknowledgement relays that. A handle's
`cancel()` and the RTC→WS fallback hand-over reach only the tab that issued
them: the owner's live RTC attempt is not aborted, and the receiver
deduplicates by msgId. Without `BroadcastChannel` the owner finds the waiting
tab's message on its idle cadence. Without the Locks API every tab sends its
own, as before.

A browser without IndexedDB has no durable storage and no memory stand-in:
each connect decides that once, and its durable sends follow the same rule
without reaching the carrier. Any other storage failure is tried again by the
next durable send. The first durable or `local-checkpoint` admission of a
connect asks for persistent storage: it reads `navigator.storage.persisted()` and, unless the
origin already persists, calls `navigator.storage.persist()`; the send awaits
neither, and the outcome arrives as a `persist` event on the storage
diagnostics port. A denial is asked again by the next connect.

The browser keeps one ALM database per scope, named
`rallar-al-runtime:<applicationId>:<workspaceId>` with each part URI-encoded;
the database of earlier releases is left for the browser to evict. The
`storage` diagnostics port (`setDefaults({ diagnosticsPorts: { storage } })`,
`RallarDiagnosticsPortsInput.storage`) replaces `onStorageReset` and receives
every `ALStorageEvent`:

- `reset`: the database was deleted and recreated because its schema no longer
  matched (`ALStorageResetEvent`); a reset the cleanup caused names the
  database instead of a store;
- `recovery`: what a durable store found when its lane started, once per store
  and connect (`ALStorageRecoveryOutcome`: `restored`, `expired-at-recovery`,
  `storage-created` or `storage-reset`). The session's inbound store is shared
  by the WS and RTC lanes and reports once per lane, as `<store id>/ws` and
  `<store id>/rtc`. A creation or reset of the database is reported by each
  store of the connect that found it; a later connect reads the database as it is;
- `health`: a store's `ALStorageHealthState` on each change of status
  (`ALStorageHealthStatus`) only, `failing` at the first storage failure and
  `healthy` at the first commit after it, with the failure as `lastFailure`; a
  database evicted under the document reads `failing` with cause `evicted`. A
  checkpoint store (`browser-ws-client-checkpoint:<sessionId>`,
  `browser-rtc-overlay-checkpoint:<sessionId>`) also reads `delayed` once a
  checkpoint write failed or its oldest unsaved change is two interval targets
  old, with that age as `oldestUnsavedAgeMs`, and `failing` with cause
  `checkpoint-lag` beyond the recovery-lag bound;
- `persist`: the outcome of the connect's one persistence request
  (`ALStoragePersistOutcome`);
- `recovery-owner-invoked`: the `ALInboundResyncCursor` the browser handed a
  typed channel's recovery owner (below), once per ordering track per runtime,
  stated even when the owner throws. It names no store.

Room channels add room defaults and default `send(...)` to the existing
`rtc-with-ws-fallback` strategy. This scopes sends; `onWs(...)` and
`onRtc(...)` still subscribe by topic/type. Their callbacks receive the full
`RallarMessage<T>`, and room sends that use a `roomRef` carry the target
`GroupRef` in `message.raw.targets`. A message is dispatched only to the
handlers of the carrier it arrived on, so register the handler on both
carriers. Validate the target reference with `isSameGroupRef` before accepting
an inbound payload:

```ts
import type { RallarMessage } from '@shared-web/browser/rallar.ts';
import {
    AL_DELIVERY_ADMITTED_STATES,
    isALDeliveryAdmitted
} from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';

interface RoomChatMessage {
    readonly text: string;
}

const roomSession = await rallar.rooms.enter('lobby');
const roomChat = roomSession.message<RoomChatMessage>('chat');

const acceptRoomChat = (
    payload: RoomChatMessage,
    message: RallarMessage<RoomChatMessage>
): void => {
    const targets = message.raw.targets;
    const targetRoomRef = targets?.mode === 'multicast'
        ? targets.groupRef
        : targets?.mode === 'broadcast' && targets.scope === 'room'
        ? targets.groupRef
        : undefined;
    if (targetRoomRef && isSameGroupRef(targetRoomRef, roomSession.roomRef)) {
        console.info(payload.text);
    }
};

roomChat.onRtc(acceptRoomChat);
roomChat.onWs(acceptRoomChat);

const handle = await roomChat.send({ text: 'hello' });
const outcome = await handle.wait({ until: AL_DELIVERY_ADMITTED_STATES, timeoutMs: 5_000 });
if (!isALDeliveryAdmitted(outcome.lifecycle)) {
    console.warn(
        'Chat delivery degraded',
        outcome.lifecycle.state,
        outcome.lifecycle.evidence.reason
    );
}
```

`send(...)` returns a `RallarMessageHandle` immediately, with a stable
`msgId`, before admission resolves. `handle.wait(options?)` resolves once the
lifecycle reaches one of `options.until` or any terminal state (or times out
or aborts per `options.timeoutMs`/`options.signal`). `AL_DELIVERY_ADMITTED_STATES`
is every state past `submitted`, so a `wait(...)` using it resolves as soon as
the lifecycle leaves `submitted`. A `pending` verdict, and an unroutable or
refused first leg that the strategy hands to its fallback carrier, leave the
handle `submitted`; the wait resolves on the next settlement.
`isALDeliveryAdmitted(outcome.lifecycle)`
then reports whether the resolved state is `accepted`, `queued`,
`transport-accepted`, or `acknowledged`. Surface every other outcome to the
product as degraded or failed delivery.

### Message Audiences

A send addresses one audience. `room`, `principal` and a fixed list are room
audiences: each names its room (`roomId` or `roomRef`) and resolves to that
room's live sessions at the sender's room snapshot, minus `exceptPeerIds`, on
both carriers. `world` and `all` name no room (D156).

| Audience   | Who receives it                                                               | Send input                                                       | RTC                                                                 | WS                                                               | Receipts                                                                                                                              |
| ---------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| room       | The room's live sessions                                                      | the room; `scope: 'room'`, the default for a send that names one | multicast, its audience frozen at the origin                        | `broadcast/room`                                                 | `receiver` and `all-logical-recipients` over the frozen audience; `group-leader` from the room's director (see Acknowledgement Modes) |
| principal  | The principal's live sessions in the room                                     | the room and `principalId`, with `scope: 'principal'`            | multicast, its frozen audience narrowed to the principal's sessions | `broadcast/principal` naming the room's `groupRef`               | as `room`, over the narrowed audience                                                                                                 |
| fixed list | The listed sessions that are live in the room                                 | the room and `recipientPeerIds`, with room scope                 | multicast, its frozen audience narrowed to the list                 | `broadcast/room` with `recipientPeerIds`                         | as `room`, over the narrowed audience                                                                                                 |
| world      | Every authenticated live connection in the sender's application and workspace | `scope: 'world'`                                                 | refused `unsupported`                                               | `broadcast/world`, bound to the connection's authenticated scope | none                                                                                                                                  |
| all        | Every authenticated connection the server holds, across scopes                | none: the server's `toAll` and its own publications              | refused `unsupported`                                               | a client's `all` is refused `unauthorized`                       | none                                                                                                                                  |

`messages.rtc.send`, `messages.ws.send` and a room channel's options take
`principalId` and `recipientPeerIds`; a send's `scope` is `'room'`, `'world'` or
`'principal'`. A WS send that names a room, or resolves the default room, takes
room scope unless it states another, and one that names neither reaches the
sender's `world`. The input validator returns every issue at once:
`scope: 'principal'` needs the room and `principalId`, and a `principalId` needs
`scope: 'principal'`; `recipientPeerIds` needs room scope and holds 1 to 256
unique session ids; a send names `principalId` or `recipientPeerIds`, never
both; a send that states room or principal scope and resolves no room is refused
like a room send without one (`missing-room`), while a `recipientPeerIds` send
that names no room and has no default room resolves to `world` and is refused
`fixed-audience-requires-room-scope`; and a `world` send on a `room.` topic is
refused `world-on-room-topic` before either carrier admits it. A WS scope other
than the three is refused with "WS scope must be room, world, or principal.".

A principal or list audience is narrowed, never widened: a `principalId` with no
live session in the room, or a list of sessions outside it, leaves an empty
audience, which settles as an empty room audience does, and a listed session
that is not in the room is dropped silently. Both are room sends: they carry the
room's `minSnapshotVersion` and `rosterVersion` and are fenced as any room send
(see Membership Fencing below), the RTC origin freezes the narrowed audience at
its `snapshotVersion`, and the WS server admits the narrowed audience as the
room audience its receipt aggregate expects and its repair serves (D159).
Receivers enforce the audience on both carriers: an RTC peer delivers a narrowed
multicast only when the frozen audience names it, and the shared planner
delivers a room broadcast that carries `recipientPeerIds` only at a listed
session and relays it only to listed children. On RTC a principal or list
multicast still travels the room's overlay, so room peers that are not
recipients relay its bytes; only the audience delivers it. A WS client trusts
the server's resolution. Relic Hunters sends its AI suggestions to the asking
hunter's principal over WS, and its server publishes each hunter's recorded
action and refused-command text to that hunter's principal in the room (D168).

The strategy picks the carrier per audience (D157):

| Audience                    | `ws` | `rtc`                                              | `rtc-with-ws-fallback`                                   | `ws-then-rtc`                                 |
| --------------------------- | ---- | -------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------- |
| room, principal, fixed list | WS   | RTC                                                | RTC, then WS on a fallback trigger                       | WS, then RTC on an admission fallback trigger |
| world                       | WS   | admitted on RTC, refused `unsupported`, `rejected` | WS at once: no RTC leg and no `carrierFallback` evidence | WS at once, as on the left                    |

"Carrier-unsupported" is the existing refusal `unsupported` on the carrier that
cannot carry the audience: no new state or value. A `world` send on `rtc` is
admitted on RTC, refused there, and its handle ends `rejected` with refusal
`unsupported`. An RTC leg handed to WS keeps its audience (D80): once the RTC
origin has frozen it, WS carries the frozen multicast verbatim; handed over
before its freeze, it goes as the principal broadcast naming its room or the
listed room broadcast it was sent as.

The WS server binds what it resolves to the sender's scope (D100, D158): a
client's `world` broadcast reaches only connections authenticated in the
sender's application and workspace, on every instance, since the cluster notice
of a live `world` send carries that scope, and the topic's fanout alone
delivers it, once to each such connection, so a topic with fanout `none` relays
no client `world` broadcast; a client's `principal` broadcast must
name its room's `groupRef` in the sender's scope; and a client envelope whose
broadcast scope is `all` is refused `unauthorized` at ingress, before routing,
and reaches no one; a client's principal broadcast that names no room, and a
`world` broadcast on a `room.` topic, are refused `malformed`. No client room,
principal, list or `world` send returns to the session that sent it. `all` is not a browser send input; the
server router's `toAll` and its own publications keep it.

```ts
interface PartyNote {
    readonly text: string;
}

const notes = rallar.messages.room<PartyNote>({
    topicId: 'room.party.note',
    typeId: 'party.note.v1',
    purpose: 'notification'
});

await notes.send({ text: 'for my other devices' }, {
    scope: 'principal',
    principalId: myPrincipalId
});
await notes.send({ text: 'for two hunters' }, { recipientPeerIds: [aliceSessionId, bobSessionId] });
await rallar.messages.ws.send({
    topicId: 'app.news',
    typeId: 'news.v1',
    payload: { text: 'server maintenance at noon' },
    scope: 'world'
});
```

`ai.broadcastJson(...)` (see [RallarAI recipes](rallar-ai-recipes.md)) takes
`scope: 'room' | 'principal'`, `'room'` by default, and `principalId`, which
`scope: 'principal'` requires: the generated result then reaches the
principal's sessions in the room instead of the whole room.

### Acknowledgement Modes

A send's `ack` (or `qos.ack`) names who confirms it. A confirmation is the ALM
ACK a session sends when its ALM admits the message, never the application's
handling of it; an application's answer is a message of its own.

| Mode                     | Who confirms                                                                                             | Audiences                                                                | Default for                                          |
| ------------------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------- |
| `none`                   | nobody: `transport-accepted` is terminal                                                                 | every audience                                                           | a lane send, a `best-effort` send and a `world` send |
| `receiver`               | the addressee of a unicast; every session of the frozen audience of a room, principal or fixed-list send | a unicast (over WS one that names its room), room, principal, fixed list | a `command` channel                                  |
| `all-logical-recipients` | as `receiver`: one algorithm                                                                             | as `receiver`                                                            | a `notification` channel                             |
| `group-leader`           | the room's director session alone                                                                        | room, principal, fixed list                                              | nothing                                              |

`group-leader` addresses the room's leader: the session the room's group
metadata appoints as director (`director.appoint`, see Director above) when
that session is among the room's active sessions at admission (D164). The
carrier that admits the send resolves it from the room snapshot it holds -- the
RTC origin from its own room snapshot, the WS server from the snapshot its room
authorizer reads -- and freezes the send's audience to that one session at the
snapshot version it read; the send stays a room send and is fenced as one (see
Membership Fencing below). Only the director delivers it, and the director's
ordinary ACK is the one confirmation its receipt expects, so the handle reads
`acknowledged` when that ACK arrives; its `receiptAlgo` reads `leader`. Over RTC
the message still travels the room's overlay, so room peers that are not the
director may relay its bytes. A succession after admission does not move the
frozen leader: the receipt keeps expecting the session it froze and ends
unconfirmed if that session never answers, and a resend is admitted against the
current appointment; an RTC leg the fallback hands to WS after a succession is
refused `no-leader` by the server, since the session it froze is no longer the
director. No leader epoch rides the wire, and the carriers judge presence only:
the heartbeat freshness `director.status(...)` reports as `isFresh` stays the
application's check.

The send is refused `no-leader` when the room has no director at admission (no
appointment, or an appointed session that is not among the room's active
sessions), when the sender is the director, since a sender is never in its own
audience, and when the director is outside the audience the send names after
its exclusions: a fixed list, or a principal other than the director's, that
leaves the director's session out, or `exceptPeerIds` that name it (D165). The
RTC origin refuses it at its own admission, before any attempt; the WS server
refuses it at ingress with a `no-leader` NACK after the frame left. The handle
ends `rejected`: on RTC with `failure: { kind: 'refused', reason: 'no-leader' }`,
on WS with `failure: { kind: 'relay-rejected', rejection }` and
`evidence.relayRejection` reading `{ relay: 'trusted-server', reason: 'no-leader' }`.
`no-leader` is no fallback trigger: the other carrier reads the same
appointment, so `rtc-with-ws-fallback` and `ws-then-rtc` end `rejected` without
a second leg.

`group-leader` needs a room (D166): a carrier refuses it `unsupported` on a
unicast, a `world` send or the server's `all`, and the browser validator
refuses a `group-leader` send that names a `peerId` or `scope: 'world'` before
either carrier admits it.

```ts
interface MoveIntent {
    readonly dx: number;
}

const intents = rallar.messages.room<MoveIntent>({
    topicId: 'room.match.intent',
    typeId: 'match.intent.v1',
    purpose: 'command'
});

const handle = await intents.send({ dx: 1 }, { ack: 'group-leader' });
const outcome = await handle.wait({ until: ['acknowledged'], timeoutMs: 30_000 });
const failure = outcome.lifecycle.evidence.failure;
const noLeader = (failure?.kind === 'refused' && failure.reason === 'no-leader') ||
    (failure?.kind === 'relay-rejected' && failure.rejection.reason === 'no-leader');
if (noLeader) {
    console.warn('The room has no director to confirm the intent.');
}
```

### Ordering, Repair And Resynchronization

A browser send states its position with `orderingKey` and `seq` together, or
neither (`RallarRtcSendInput`, `RallarWsSendInput`): a browser's sequence is
client-assigned; a server publication's is minted by the server (below). The
receiver keeps one ordering track per ordering key, sender and epoch, delivers
its messages in sequence from the last contiguous one and buffers what arrives
early; a new epoch is a new track. No browser send sets the epoch: a browser
sender's track ends by its TTL or by the receiver's resynchronization. Three
limits bound the buffer (`AL_MESSAGE_RESOURCE_LIMITS`): a sequence more than
`repairWindow` (256) past the expected one, or a track already holding
`bufferedMessages` (256) or `bufferedBytes` (1 MiB), is refused
`resync-required`. It is not buffered, and the sender is NACKed.

An in-window gap is repaired by the sender. The hop that keeps a browser
sender's ordering track -- the receiver over RTC, the WS server over WS -- NACKs
the missing sequences as inclusive ranges (`ALSeqRange { from, to }`, at most
`repairRanges` = 128 per payload), and the sender retransmits them along the
hop that asked, `repairPageMessages` (32) sequences per round until the ranges
are served. A message is retransmitted at most `maxRepairs` times (1 by
default; `qos: { repair: { algo: 'retransmit', opts: { maxRepairs } } }` sets
it); a report of the same gap once that budget is spent settles the message
`skipped` with reason `repair-exhausted`, once, so its handle reads `failed`
with `failure: { kind: 'skipped', reason: 'repair-exhausted' }`. The
receiver's later sequences stay buffered behind the missing one until the
track expires or the sender's next epoch opens a new track.

A typed channel may declare the application's owner of resynchronization:

```ts
interface RoundState {
    readonly round: number;
}

const rounds = rallar.messages.channel<RoundState>({
    topicId: 'match.rounds',
    typeId: 'match.round.v1',
    purpose: 'notification',
    recovery: {
        onResyncRequired: (cursor) => {
            void refreshMatchSnapshot(cursor.orderingKey);
        }
    }
});
```

`RallarChannelRecovery.onResyncRequired(cursor)` is invoked once per ordering
track (ordering key, sender, epoch) for the life of the browser runtime, after
the receiver refused a message of that track `resync-required` -- at admission,
or at an ordered release it can no longer complete -- and after its NACK to the
sender committed. The cursor (`ALInboundResyncCursor`, exported with
`RallarChannelRecovery` from `rallar.ts`, `rallar-core.ts` and
`rallar-messages.ts`) is where the track stands: `orderingKey`, `senderId`,
`epoch`, `lastContiguousSeq` (`0` before any delivery), `expectedSeq`
(`lastContiguousSeq + 1`), `observedSeq` (the sequence that arrived) and
`carrier` (`ws` or `rtc`). What the owner does with it -- fetching a snapshot,
asking the sender for a new epoch -- is the application's: ALM resets no track
on its own, and the sender's new epoch re-arms the owner. A throwing owner is
logged and changes nothing. Every invocation is also stated as
`recovery-owner-invoked` on the `storage` diagnostics port. Without a
`recovery` owner the refused message is dropped as before, and the inbound
diagnostics state the refusal. The WS server declares no owner and keeps
NACKing `resync-required` to the sender. The once-mark lives in memory, so a
reload invokes the owner once more for the same track.

A server publication names its track and leaves the sequence to the server: the
server application builds the message with an `ordering` option that states
`orderingKey` and `epoch` and no `seq`, and publishes it with `ws.publish` at
`fanout: 'outbox'`. The WS server's outbound admission assigns the sequence, and
the publish result's message carries it. A keyed publication without `seq` at
`fanout: 'live-only'` or `'none'` is refused: only the outbox admission mints.
The track is the ordering key, the server peer id as sender, and the epoch (`0`
when absent); its first message gets `seq` 1 and each later one the next number,
assigned in the same commit that admits the message, so the sequence stays
contiguous whichever server instance publishes and continues after a server
restart. Publishing the same `msgId` again keeps the sequence it was first
given, and a server publication that states its own `seq` keeps it.

The server repairs its own publications from its sent copies. A WS client admits
every server frame as the trusted server's, orders a server track like any other
with the server peer id as its sender, and NACKs a gap in an at-least-once
publication to the server. The server serves a requester that is inside the
audience the message was admitted to and that the receipt of the message
revealing the gap still expects, so a sequenced server publication asks
`ack: 'receiver'`; one with `ack: 'none'` gets no ranged repair, and a session
that joined after a message was published is never sent it. The server
retransmits the missing sequences to that requester alone, `repairPageMessages`
(32) per round, until the message's deadline. The repair budget is per message
and shared by every requester: the first receiver to NACK a sequence spends
`maxRepairs` (1 by default), and another receiver missing the same sequence gets
it from the receipt's retries instead. A report of a gap once the budget is
spent settles the publication `skipped` with reason `repair-exhausted`, once.
Sequences follow commit order, so under contention a publication fenced out by
the server's sender version takes the next sequence when its replay commits and
two publications of one track can commit out of publish order; and since a
receiver's ordering-track TTL defaults to the repository TTL (60 minutes), the
lifetime of the server's head, a track silent for over an hour restarts at `seq`
1 on both sides. A `resync-required` NACK from a receiver settles the
publication `relay-rejected`
(`{ relay: 'peer', peerId, reason: 'resync-required' }`) and removes its whole
pending receipt, so no recipient is retried after it. The receiver invokes the
recovery owner of the typed channel whose topic and type the publication names;
the cursor's `senderId` is the server peer id. The epoch is the server
application's to choose: a new epoch is a new track at every receiver and
re-arms the owner.

Relic Hunters publishes its round transitions this way. Each `relic.event.v1` on
`room.relic.event` is a receipted room notification whose ordering key names the
game's incarnation (its id and creation time, since a reset keeps the id) and
whose epoch is the round the transition enters, the finish entering the round
past the last, so every round is a new track and no track spans a review:

```ts
const message = newALBroadcastMessage(
    rallarServer.ws.serverPeerId,
    newALRoute(RELIC_TOPICS.event, roomId, `${gameId}:${round}`),
    'room',
    RELIC_TYPES.event,
    event,
    {
        groupRef,
        reliability: 'at-least-once',
        ack: 'receiver',
        ttlMs: RELIC_EVENT_TTL_MS,
        ordering: {
            orderingKey: `${gameId}:${createdAtEpochMs}`,
            epoch: event.transition === 'finished' ? round + 1 : round
        }
    }
);
await rallarServer.ws.publish({ message, fanout: 'outbox' });
```

The browser reads the stream through `messages.room<T>(...)` on that topic and
type with purpose `notification` and a `recovery` owner that re-reads the game
over REST (`GET /api/relic/games/:gameId`). A browser that joins during a round
reads that round's state from the snapshot and its first ordered transition at
the next round.

### Membership Fencing

Every room send -- an RTC multicast, a WS room or principal broadcast that names
its room, and the broadcast a fallback send becomes -- carries two stamps read
from the sender's cached room snapshot: `targets.minSnapshotVersion`, the
snapshot version (or a higher floor the send states), and
`targets.rosterVersion`, the group's roster version. No caller sets the roster.
Both are absent when the sender holds no snapshot of the room, unless the send
states a floor, which then travels alone; a receiver applies only the floors a
send carries.

A receiver judges a room send against the room snapshot it holds:

- **Behind either stamp** it refuses the send `not-yet-in-sync` and the send
  catches up on the existing bounded path: an RTC receiver NACKs its hop,
  refreshes the room once and re-admits the message once, and the sender
  retries; the WS server retains the send as a pending admission, answers an
  advisory NACK the sender leaves unhandled, and re-authorizes it every 50 ms
  until its room meets the floor or the message's deadline passes. The sender
  retries nothing over WS. A send the server retains this way starts no receipt
  aggregate, so a `receiver` receipt never completes for it.
- **At or beyond the stamps, with the sender's member absent or not `active`,**
  it refuses the send `membership-fenced` and NACKs its hop. From the WS
  server, before the sender holds a receipt row, the handle settles `rejected`
  with `failure: { kind: 'relay-rejected', rejection }` and
  `evidence.relayRejection` reading `{ relay: 'trusted-server', reason:
  'membership-fenced' }`; an RTC peer's refusal reads `{ relay: 'peer', peerId,
  reason: 'membership-fenced' }` the same way only when that peer is the
  unicast addressee or a composition hop. An RTC room send names no hop, so its
  sender hears a peer's fence only through a tracked receipt: the receipt ends
  and the handle reads `failed` with `failure: { kind: 'receipt-exhausted',
  cause: 'hop-refused', hopPeerId, nackReason: 'membership-fenced' }`, as any
  receipted send does when a hop refuses it; a room send with `ack: 'none'`
  never hears it.
- On RTC a sender whose session is absent while its member is present waits as
  `not-yet-in-sync` at its own roster (presence is not the roster) and is fenced
  in a roster beyond its stamp; the WS server, whose presence is its own
  authority, fences a sender with no live session at once.
- The fence applies where a copy arrives from a hop: an origin keeps its own
  verdicts, so a removed sender's own sends wait at its origin until their
  deadline. A fenced NACK carries no ordering hints, asks for no repair and
  triggers no refresh.

The WS server judges WS room sends at admission and again at dispatch; the
receiving WS client trusts it, and a room publication the server originates
carries no fence. The envelope version is `AL_MESSAGE_ENVELOPE_VERSION` (3); an
envelope of any other version is refused `unsupported`.

### RTC Status And Readiness

`rtc.status(options?)` returns a snapshot of peer/lane readiness.

`rtc.onStatus(listener, options?)` subscribes to RTC status snapshots.

`rtc.onLifecycle(listener, options?)` subscribes to RTC lifecycle events such as `peer-created`, `peer-established`, `lane-open`, `lane-close`, `peer-timeout`, and `signaling-failed`. `peer-established` fires once per peer setup, when the connection or its first lane reports open; later lane opens on the same peer emit only `lane-open`. `signaling-failed` carries `signaling` with the peer id, the signal kind (`offer`, `answer` or `candidate`), the transport's admission verdict, and the reason — a handshake signal that never left this browser.

`rtc.waitForLane(peerId, laneId, options?)` waits for a specific peer/lane.

`rtc.waitForOpen(peerId, options?)` waits for the default or configured lane.

`rtc.waitForRoomLane(room, laneId, options?)` waits for room peers on one RTC
lane and returns separate `ready` and `notReady` lists. The same readiness
expectation shape used by `rooms.waitForPresence(...)` can be passed as
`options.expect`; the result also includes `readyPeerIds`, `notReadyPeerIds`,
`missingPeerIds`, `extraPeerIds`, `observedCount`, and `expectedCount`.

`rtc.roomStatus(room, options?)` returns a `RallarRoomTransportStatus`: WS
status plus the room's RTC state and its desired, known, active, ready and
failed peer IDs. `rtc.openRoom(room, options?)` and
`rtc.waitForRoom(room, options?)` resolve to the same status.

`rtc.diagnostics(options?)` resolves `RallarRtcDiagnostics`.
`rtc.restartIce(peerId)` and `rtc.reconnectPeer(peerId, options?)` resolve a
`RallarRtcRecoveryResult`.

`rtc.peer(peerId, options?)`, `knownPeerIds()`, `activePeerIds()`, `peerIdsWithNoReconnectableLanes()`, and `readyPeerIds(laneId?)` expose peer subsets.

```ts
const readiness = await rallar.rtc.waitForRoomLane('lobby', 'realtime', {
    connect: true,
    timeoutMs: 1000,
    expect: { min: 1, max: 10 }
});

if (readiness.status === 'open' || readiness.status === 'partial') {
    console.log(
        'Ready peers',
        readiness.readyPeerIds
    );
}
```

Browser RTC enables a bounded initial-establishment budget by default: six
attempts, 180 seconds total, and a 30 second cooldown after exhaustion. The
shared service exposes `WebRtcConnectionService.PeerLaneOpenStatus: 'exhausted'` and
`WebRtcConnectionService.PeerConnectionLeft.kind: 'connect-exhausted'`; the browser facade keeps
`RallarWaitForOpenStatus` compatible by returning `status: 'failed'` with reason
`rtc-connect-attempt-budget-exhausted`.

### WebSocket Status And Readiness

`ws.status()` returns websocket status.

`ws.onStatus(listener, options?)` subscribes to status snapshots.

`ws.onLifecycle(listener, options?)` subscribes to events such as `open`, `close`, `error`, `connected`, and `disconnected`.

`ws.waitForOpen(options?)` waits until the websocket is open or returns a non-open status.

```ts
const result = await rallar.ws.waitForOpen({ timeoutMs: 1000 });
if (result.status !== 'open') {
    throw new Error(`WS not ready: ${result.status}`);
}
```

### Realtime Data Channels

The `realtime` facade sends directly over RTC data channels. It is for
low-latency peer traffic after room membership and RTC readiness exist. For
room-scoped app/game traffic, prefer `realtime.room<T>(defaults)`: it checks
room transport status, waits for readiness by default, sends only to ready room
peers, and returns diagnostics. Its `on(...)` callback still delegates to the
global lane listener, and `RallarRealtimeMessage<T>` has no room identity. Put
the full `roomRef` in the typed payload and validate it, or use a room-unique
lane. Use lower-level `sendJson`/`json` when the caller intentionally owns peer
selection and readiness handling.

`realtime.sendJson(input)` sends JSON to selected peer IDs, a room, or the default/current room.

`realtime.sendBinary(input)` sends binary data.

`realtime.onJson(laneId, handler)` subscribes to JSON messages on a lane.

`realtime.onBinary(laneId, handler)` subscribes to binary messages.

`realtime.json(defaults?)` creates a typed JSON lane.

`realtime.room(defaults?)` creates a typed room JSON channel with `send`, `on`,
`status`, and `wait`.

`realtime.health(options?)` returns RTC data channel health records.

RTC data-channel lanes are fixed when the facade connects. Without
configuration every peer has the `reliable` lane and the `realtime` lane
(`DEFAULT_REALTIME_DATA_CHANNEL_LANE`). Declare any other `laneId` in
`rtc.dataChannelLanes` (defaults or `setup`) or in `dataChannelLanes`
(`start`/`connect` options) before connecting. On an undeclared lane a room
send reports `not-ready` and `on(...)`/`onJson(...)` never fires. Declaring
lanes replaces the default list, so include `DEFAULT_REALTIME_DATA_CHANNEL_LANE`
to keep `realtime`:

```ts
import { DEFAULT_REALTIME_DATA_CHANNEL_LANE, rallar } from '@shared-web/browser/rallar.ts';

await rallar.setup({
    apiBaseUrl: 'http://localhost:8080',
    applicationId: 'game',
    workspaceId: 'default',
    rtc: {
        dataChannelLanes: [
            DEFAULT_REALTIME_DATA_CHANNEL_LANE,
            { id: 'motion', label: 'rtc-motion', init: { ordered: false, maxRetransmits: 0 } }
        ]
    }
});
```

The samples below use that `motion` lane.

```ts
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

interface MotionUpdate {
    readonly roomRef: GroupRef;
    readonly x: number;
    readonly y: number;
}

const room = await rallar.rooms.enter('lobby');
const lane = room.realtime<MotionUpdate>({
    laneId: 'motion',
    waitTimeoutMs: 1000
});

lane.on((message) => {
    if (isSameGroupRef(message.data.roomRef, room.roomRef)) {
        console.info('remote motion', message.peerId, message.data);
    }
});

const sendResult = await lane.send({ roomRef: room.roomRef, x: 10, y: 5 });
if (sendResult.status !== 'sent') {
    console.warn(
        'Realtime delivery degraded',
        sendResult.status,
        sendResult.reason,
        sendResult.transportStatus
    );
}
```

Room realtime send statuses are `sent`, `partial`, `halted`, `not-ready`,
`no-targets`, and `failed`. `halted` means the room's RTC transport is halted.
`sent` means every desired peer's lane accepted the payload (data-channel
result `sent`, `queued` or `replaced`); it is not a delivery receipt. Surface
every other status as degraded.

### Rallar Motion

Rallar Motion is an engine-agnostic toolkit for smoothing remote entity motion
carried over `rallar.realtime`. Import named helpers from
`@shared/rallar-motion/mod.ts` or `@shared/mod.ts`, or use the additive
`RallarMotion` facade for discoverability.

`createRallarMotionBuffer(options?)` stores receiver-observed pose samples per
entity. Sampling uses `nowEpochMs - interpolationDelayMs`, interpolates between
bracketing samples, briefly dead reckons from optional velocity, then holds the
latest observed pose after `maxExtrapolationMs`. `readInterpolationDelayMs` can
provide a dynamic jitter-buffer delay without recreating the buffer. Set
`interpolationMode: 'hermite'` to use velocity-aware Hermite interpolation, or
leave it unset for linear interpolation.

Samples use `observedAtEpochMs` as the local receiver clock. Sender
`sentAtEpochMs` values can be stored in metadata for diagnostics, but they
should not drive interpolation unless the app has explicit clock sync.

Metadata is copied from the newest contributing sample. Rallar Motion does not
merge, validate, or synthesize metadata. Rotation support is tuple-based Euler
interpolation/integration in caller-defined units; there is no quaternion
interpolation. Angle wrapping is opt-in through
`rotationWrap: { period }`, for example `Math.PI * 2` for radians or `360` for
degrees.

Every estimate includes `confidence`: interpolated poses are `1`,
extrapolated poses decay linearly to `0` across `maxExtrapolationMs`, expired
held poses are `0`, and pre-first-sample holds are `1`. Optional discontinuity
handling detects teleports/snaps from distance, rotation, or speed thresholds
and holds the source pose until the target timestamp instead of interpolating
through space.

The toolkit also exports pure helpers for adaptive interpolation delay,
correction blending, kinematics estimation, sender-side cadence/threshold
gating, sequence diagnostics, vector rounding, and quantization. Quantization
ranges are always caller-owned (`min` and `max` are required). Precision
defaults to 65,535 steps when neither `bits` nor `steps` is stated, and
`roundRallarMotionVec3` defaults to three decimals. Rallar Motion does not
assume a world scale.

```ts
import { createRallarMotionAdaptiveDelay, RallarMotion } from '@shared/rallar-motion/mod.ts';

interface MotionSample {
    readonly position: [number, number, number];
    readonly seq: number;
}

const adaptiveDelay = createRallarMotionAdaptiveDelay();

const motion = RallarMotion.createBuffer({
    readInterpolationDelayMs: adaptiveDelay.currentDelayMs,
    maxExtrapolationMs: 150,
    interpolationMode: 'hermite',
    discontinuity: { enabled: true, maxPositionDelta: 8 }
});

rallar.realtime.onJson<MotionSample>(
    'motion',
    (message) => {
        motion.push({
            entityId: message.peerId,
            observedAtEpochMs: message.receivedAtEpochMs,
            position: message.data.position,
            seq: message.data.seq
        });
        adaptiveDelay.pushObservedAt(message.receivedAtEpochMs);
    }
);

const estimate = motion.sample('peer-1', Date.now());
```

### Media

`media.setLocalStream(stream)` attaches local media to RTC peer connections.

`media.setAudioEnabled(enabled)` toggles audio tracks.

`media.setVideoEnabled(enabled)` toggles video tracks.

`media.stopLocal(kind)` stops `audio`, `video`, or `all` local tracks.

`media.setPolicy(policy)` updates the RTC media policy.

`media.onRemoteStream(handler)` subscribes to remote streams.

`media.microphone`, `media.camera` and `media.screen` are source controllers
with `start(options?)`, `status()` and `stop()`. `start` resolves a
`RallarMediaSourceHandle` with `stream`, `status()`, `attach()`,
`setEnabled(enabled)` and `stop()`.

```ts
const stream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: true
});

await rallar.media.setLocalStream(stream);
rallar.media.onRemoteStream(({ peerId, stream }) => attachVideo(peerId, stream));
```

## Rallar CRDT

`rallar.crdt` opens explicit collaborative CRDT documents. It does not change
`rallar.data` latest-value semantics.

```ts
import { toCanonicalGroupRef } from '@shared/api/group-types.ts';

const roomSession = await rallar.rooms.enter('lobby');
const roomRef = toCanonicalGroupRef(roomSession.roomRef);

const doc = await rallar.crdt.open('room-checklist', {
    documentType: 'checklist',
    documentId: roomRef.groupId,
    scope: { kind: 'room', roomRef },
    transport: 'ws'
});

await doc.applyLocal({
    kind: 'batch',
    operations: [
        {
            kind: 'map.set',
            path: [],
            key: 'title',
            value: 'North entrance'
        }
    ]
});
```

`scope.roomRef` is copied into every update envelope unchanged, and the server
accepts only the three `GroupRef` fields. Pass a canonical ref, never a
snapshot's `group`.

### Document API

- `read()` returns the merged value.
- `subscribe(listener)` receives merged snapshots.
- `applyLocal(batch)` applies and persists a local operation batch.
- `pendingUpdates()` returns locally produced updates not yet durably accepted.
- `failedPendingUpdates()` returns recorded failures, each with
  `failedAtEpochMs`, `retryable` and `reason`: a local persist or send failure
  in `applyLocal` (recorded `retryable: true`) or a rejected durable append.
- `dependencyBlockedUpdates()` returns updates waiting for missing parents or
  observed IDs.
- `sequenceInsert(input, options?)`, `sequenceMove(input, options?)`, and
  `sequenceDelete(input, options?)` mutate ordered-list paths with stable
  element and position IDs.
- `counterAdd(input, options?)`, `counterIncrement(path, options?)`, and
  `counterDecrement(path, options?)` mutate CRDT counter paths.
- `numberMin(input, options?)` and `numberMax(input, options?)` merge finite
  numeric values with deterministic min/max semantics.
- `operationGroupUpdateIds(operationGroupId)` returns the IDs of the updates
  this replica has applied, local or remote, that carry that
  `operationGroupId`.
- `undoOperationGroup(input)` and `redoOperationGroup(input)` apply the
  caller-supplied compensating `operations` as a new batch carrying undo/redo
  metadata; they throw when the target group is unknown to this replica. The
  browser does not check that the caller authored the target group.
- `snapshot()` exports a compact snapshot envelope.
- `flush()` persists the current snapshot.
- `sync(options?)` retries pending live sends and requests catch-up.
- `health()` reports pending counts, live transport counters, last server append
  sequence, last durable ACK time, and corrupt local artifact count.
- `ref` is the document's `RallarCrdtDocumentRef`.
- `close()` flushes, stops tab and live sync, and releases the document.
- `destroy()` removes the document's local persistence and releases it.

### Hardening Options

`open(..., { policies, metrics, encryption, validation })` can attach CRDT production
controls:

- `policies`: `RallarCrdtDocumentTypePolicy[]` rollout and feature policies.
  The browser consults them before a WS send, an RTC send and a durable
  catch-up request; a `disabled` rollout or a `readOnly`, `networkSend`, `ws`,
  `rtc`, `durableAppend` or scope flag denies the send, with
  `killSwitchReason` as the reason. `applyLocal` is not gated by policy in the
  browser. Durable append and peer catch-up decisions are made by the server.
- `metrics`: a `RallarCrdtMetricsSink`. The browser document records
  `crdt.local.apply.ms`, `crdt.merge.replay.ms`, `crdt.pending.age.ms`,
  `crdt.pending.failed.count`, `crdt.dependency.blocked.count` and
  `crdt.sync.bytes`; it emits no append or rejection metric.
- `encryption`: a `RallarCrdtEncryptionKeyring`. When present, browser
  persistence, live transport, and durable append carry AES-GCM encrypted update
  payloads and snapshot bodies; authorized clients decrypt before merge.
- `validation`: optional CRDT validation options, including strict path
  ownership schemas for production documents. Strict path kinds include
  `register`, `map`, `orset`, `sequence`, `counter`, and `number`.

### Transport

Room documents support `local-only`, `ws`, `rtc`, `ws-then-rtc`, and
`rtc-with-ws-fallback`. App and principal documents use the `app.crdt` WS topic;
RTC remains room-scoped. Custom-scoped documents have no live transport: live
sends, peer sync and WS catch-up are deferred.

`open()` defaults to `transport: 'local-only'`, which sends nothing and
requests no catch-up; state a strategy to sync. WS is the safest choice. RTC can
accelerate active peers but does not replace the durable server append log. An
update leaves `pendingUpdates()` only when a durable append response names it:
`accepted` or `duplicate` clears it; `rejected` moves it to
`failedPendingUpdates()` with the server's `reason` and `retryable` flag. `sync()` requests durable WS catch-up
when the selected strategy includes WS, then keeps peer catch-up as a
development/live-repair fallback. The shared `rallar` facade configures no HTTP
catch-up. Pass `durableCatchUp` per document, or build a facade with
`createRallarCrdtFacade({ ..., readDurableCatchUp })`, using
`crdtCatchUpHttpApi.catchUpDocument(request, options?)` from
`@shared-web/browser/crdt/crdt-catch-up-http-api.ts`.

### Server

API-v1 installs the `room.crdt` and `app.crdt` topics through the Rallar server
user-topic router, with app and principal documents enabled. The server validates envelopes, authorizes room messages, appends
accepted updates to `crdt_updates`, sends append responses, and fans out
accepted updates.

Principal documents fan out live to the principal's live sessions. The AppInbox
append writes the fan-out as a `WS_OUTBOX` unicast to the principal ID, and the
WS target resolver expands it through the middleware option
`findClientSnapshotByRef`; without that option the fan-out reaches no session.
The durable append log remains the source of truth.

Authenticated durable catch-up is available over HTTP:

- `POST /api/crdt/catch-up`

The request returns an optional compact snapshot plus an append-log page.

The PostgreSQL log repository (`PSqlCrdtLogRepository`) is read-only: update
pages, snapshots, document metadata, document listing, debug and backup bundle
export, and integrity verification. Projection rebuild, compaction, lifecycle
changes (archive, destroy, quarantine) and erase are AppInbox CRDT mutation
commands, reached through the admin routes below. Backup restore exists only on
the in-memory `RallarCrdtAdminLogRepository`.

Shared hardening helpers include
`evaluateRallarCrdtDestructiveCompactionSafety(...)` for explicit
destructive-GC gates and encryption keyring helpers for descriptor, rotate, and
revoke workflows. These helpers do not make RTC a durability boundary and do
not replace deployment-specific key custody.

API-v1 admin routes:

- `POST /api/crdt/admin/documents/list`
- `POST /api/crdt/admin/documents/integrity`
- `POST /api/crdt/admin/documents/debug-export`
- `POST /api/crdt/admin/documents/backup-export`
- `POST /api/crdt/admin/documents/rebuild-projection/requests/{requestId}`
- `POST /api/crdt/admin/documents/compact/requests/{requestId}`
- `POST /api/crdt/admin/documents/lifecycle/requests/{requestId}`
- `POST /api/crdt/admin/documents/erase/requests/{requestId}`

See [Rallar CRDT Guide](./rallar-crdt-guide.md) for the full product boundary.

## Rallar Data

Rallar Data is a browser IndexedDB-backed key-value facade with observable in-memory repositories.

Import through `rallar.data`, or directly:

```ts
import { createRallarDataFacade, defineRallarDataStore } from '@shared-web/browser/rallar-data.ts';
```

`createRallarDataFacade(input)` takes `{ manager, resolveScopeKey }`.

### Facade API

`define(name, options?)` returns a store definition.

`open(input, options?)` opens or creates a store. If `hydrate` is `eager`, it hydrates before returning.

`lookup(input, options?)` returns an already-open store, or `undefined`.

`close(input, options?)` flushes and disposes an open store.

`closeScope(scope)` closes active stores in a scope.

`clearScope(scope)` clears active stores in a scope without closing them.

`destroy(input, options?)` clears persisted data and closes/disposes the store.

`destroyScope(scope)` clears and closes active stores in a scope.

`estimateUsage()` returns browser storage usage/quota when available.

```ts
interface Settings {
    readonly volume: number;
}

const settingsDef = rallar.data.define<Settings>('settings', {
    scope: 'principal',
    durability: 'write-through'
});

const settings = await rallar.data.open(settingsDef);
await settings.set('audio', { volume: 0.8 });
```

### Store Options

- `scope`: logical grouping, defaults to `'app'`. `'principal'` and `'session'`
  resolve against the current auth session and throw without one.
- `dbName`: IndexedDB database name, defaults to `rallar-custom-data`.
- `storeName`: IndexedDB object store name, defaults to `entries`.
- `keyPrefix`: key namespace; normally leave unset.
- `ttlMs`: time-to-live for entries.
- `durability`: `'write-through'` (default) persists on mutation; `'write-behind'` persists asynchronously.
- `hydrate`: `'eager'` (default) or `'lazy'`.
- `sync`: enables `BroadcastChannel` cross-tab sync when available, defaults to `true`.
- `isValid`: rejects invalid values during repository operations.
- `equals`: custom equality function.
- `expireAtFor`: per-value expiry timestamp.
- `onPersistenceError`: write-behind persistence error handler.

Persisted entries use one envelope (`kind: 'rallar.custom-data'`). There is no
schema version or migration hook; a persisted row that does not match the
envelope fails to decode.

### Store API

Read methods:

- `read(key)` reads memory only.
- `get(key)` reads persistence when needed.
- `readEntries()`, `readAllValues()`, `keys()` read memory.
- `getEntries()`, `getAll()`, `listKeys()`, `exportData()` include persistence.

Write methods:

- `set(key, value)`
- `update(key, updater)`
- `updateOrCreate(key, updater)`
- `setIfAbsent(key, creator)`
- `compareAndSet(key, expect, update)`
- `getAndSet(key, update)`
- `delete(key)`
- `deleteExpired()`
- `clear()` / `clearAll()`

Lifecycle methods:

- `hydrate()`
- `whenHydrated()`
- `isHydrated()`
- `whenIdle()`
- `flush()`
- `close()`
- `destroy()`
- `estimateUsage()`
- `onChange(listener)`

```ts
interface Draft {
    readonly body: string;
}

const drafts = await rallar.data.open<Draft>('drafts', {
    scope: 'session',
    durability: 'write-behind',
    hydrate: 'lazy',
    ttlMs: 24 * 60 * 60 * 1000
});

drafts.onChange((event) => {
    console.log(event.key, event.value);
});

await drafts.updateOrCreate('room:lobby', (current) => ({
    body: current?.body ?? ''
}));

await drafts.whenIdle();
```

## Rallar Middleware

`createRallarMiddleware(options)` builds the complete server-side runtime used by
the Rallar server application. Import it from
`@shared-server/rallar-system/middleware/create-rallar-middleware.ts`.

### Runtime

The returned `RallarMiddlewareRuntime` contains:

- `qboxEngine`: `InboxOutboxEngine` with WS, app-inbox, and app-outbox tasks installed.
- `wsQBoxServerService`: websocket queuebox service.
- `inboxQueueReader`: app-inbox queue reader.
- `outboxQueueReader`: app-outbox queue reader.
- `appInboxResilience`: app-inbox resilience settings.
- `appOutboxResilience`: independent app-outbox resilience settings.
- `groupStateInboxService`: durable group mutation inbox.
- `topologyInboxService`: durable topology mutation inbox.
- `rtcRttInboxService`: durable RTC-RTT mutation inbox.
- `appClientInboxService`: durable client mutation inbox.
- Optional configured auth, admin, and CRDT inbox services.
- `clientsRepository`: client snapshot repository.
- `groupsRepository`: group snapshot repository.
- `clientStateService`, `groupStateService`: state services owned by the
  client and group inbox services.
- Optional `rtcTopologyPublicationRepository`,
  `rtcTopologyExecutionRepository`, `rtcTopologyDelivery`, and
  `rtcTopologyReplay`, passed through from options.
- `readiness`: resolves when `options.readiness` and the queue pub/sub bridge
  subscription are ready. Await it before starting queue workers.
- Optional `healthFailure`: passed through from options.

### Options

Required:

- `inbox`: queuebox repository for inbound app/WS work.
- `createGroupStateInboxService(input)`: factory for the group-state inbox service.
- `createTopologyInboxService(input)`: factory for the topology inbox service.
- `createRtcRttInboxService(input)`: factory for the RTC-RTT inbox service.
- `createAppClientInboxService(input)`: factory for the client app inbox service.
- `resilience.inbox`: resilience policy for inbox work.
- `resilience.appOutbox`: independent resilience policy for app-outbox work.
- `clientsRepository`: client snapshot repository.
- `groupsRepository`: group snapshot repository.

Optional:

- `outbox`: queuebox repository for outbound work; defaults to `inbox`.
- `webSocketServer`: defaults to a new `JsonWebSocketServer`.
- `wsRuntimeName`: defaults to `default-qbox-server`.
- `targetResolver`: custom WS target resolver.
- `findGroupSnapshotByRef`, `findClientSnapshotByRef`, `now`: used by the default target resolver.
- `inboundStores`, `outboundStores`: AL runtime stores.
- `resilience.outbox`: defaults to `resilience.inbox`.
- `resilience.appInbox`: defaults to `resilience.inbox`.
- `createAppAuthInboxService`, `createAppAdminInboxService`, and
  `createAppCrdtInboxService`: configured feature inbox factories.
- `appInboxDequeueOptions`.
- `wsDeliveryDiagnostics`, `wsOutboundDiagnostics`, `wsInboundDiagnostics`.
- `rtcTopologyPublicationRepository`, `rtcTopologyExecutionRepository`,
  `rtcTopologyDelivery`, `rtcTopologyReplay`.
- `queuePubSubBridge`, `readiness`, `healthFailure`.

### Construction And Queue Ownership

Construction is synchronous and ordered:

1. `create-rallar-middleware-infrastructure.ts` receives the queue engine and
   creates the QueueBox/WebSocket infrastructure. The WebSocket QueueBox
   service registers its own WS inbox, WS outbox, and receipt tasks on the
   engine. The phase returns only a queue wake capability.
2. `create-rallar-middleware-inbox-services.ts` constructs and validates every
   required and configured inbox service.
3. `rallar-middleware-queue-registration.ts` registers the exact application
   inbox and application outbox task definitions. Callers cannot supply task
   identities or definitions.
4. `assemble-rallar-middleware-runtime.ts` consumes the owner-bound,
   single-use registration handle and is the only phase that returns the queue
   engine to the caller.

Applications start only the final `runtime.qboxEngine`. The package entry point
exports no include-inbox/include-outbox helpers, and partial construction
products expose neither `start` nor `stop`.

### Feature Topic Installation

There is no aggregate system-topic initializer. The application composition
installs the durable topology AppOutbox owner, then signalling, RTC-RTT, CRDT,
and the router explicitly before worker start. API-v1 owns that sequence
in `apps/api-v1/src/composition/create-api-v1-system-installers.ts`; there is no
state-sync or topology WebSocket topic installer.

Client and group cache observation occurs only in the typed post-commit result
paths owned by `ClientStateInboxHandler` and `GroupStateInboxService`. Their
mutations commit final `WS_OUTBOX` rows with the authoritative state. QueueBox
workers and queue pub/sub deliver those rows through the current WebSocket
target resolver. Durable topology publication materializes fixed
`recipientPeerIds`; live worker delivery and `RtcTopologyReplayEntryHandlerService`
both resolve those recorded peers to current sessions before calling
`WsQueueBoxServerService.sendToTargetsWithResult`.

Accepted RTC RTT measurements are capped by the topology service
`rttReportingDegreeLimit`, which falls back to the effective topology
`degreeLimit`. API-v1 reads this from
`RALLAR_RTC_RTT_REPORTING_DEGREE_LIMIT`.

### Scoped Graph And Topology REST

API-v1 exposes graph diagnostics and RTC topology management under the same
state scope used by clients and groups:

- `GET /api/state/apps/:applicationId/workspaces/:workspaceId/graphs/global`
  reads app/workspace-scoped global graph diagnostics.
- `GET /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/graphs/latest`
  reads the latest diagnostic graph for one scoped group.
- `GET /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/topology`
  reads the effective topology view, including the current overlay snapshot
  when one exists.
- `GET /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/topology/config`
  reads durable group topology config.
  `PUT|DELETE .../topology/config/requests/:requestId` writes or deletes it.
  Mutations commit with optimistic CAS, persist a first-writer idempotency
  record keyed by the path `requestId`, and always persist the queued `rtc-topology-recompute` intent for an effectful
  write in the same transaction. A retained per-target generation record keeps
  accepted versions monotonic across DELETE, recreation, and override TTL
  expiry. A separate retained group invariant generation serializes config and
  override decisions, forcing cross-target conflicts through a full reread and
  revalidation. Topology config, override, mutation, generation, and invariant
  records use the canonical group-state key codec, whose URI-encoded parts keep
  encoded delimiter and lookalike values distinct; `workspaceId` is mandatory.
  The repository treats physical expiry as part of the stored
  contract: durable config and retained mutation/generation rows must be
  non-expiring, while an override row must expire exactly at its stored
  `expiresAtEpochMs`. It validates JSON, scope, child identity, and this expiry
  metadata before lazy expiry can delete a row. Effective reads take durable
  config, override, and the invariant generation in one batch read. If that
  batch observes a concurrent change, the read falls back to separate config
  and override reads.
  Every response includes a compact receipt. Its accepted config, version, and
  mandatory nullable replay timestamps let the service reconstruct a PUT replay
  from the idempotency ledger alone. Its mandatory nullable
  `acceptedCausalRevision` is non-null exactly for an applied write. It carries
  the group causal revision and the four scalar snapshot versions; the causal
  revision derives the fixed `rtc-topology-recompute` outbox identity. Replays
  recompute that identity and reject a receipt whose `outboxIds` entry was
  altered. Before any topology or
  idempotency row is written, the transaction also advances an expected-revision
  authority fence on the exact raw group row observed with the authorization
  snapshot. The fence changes only the group row's storage revision: it
  preserves the raw domain JSON, and with it the causal revision, and the
  physical expiry byte-for-byte.
  A conflict rolls the whole transaction back and restarts snapshot reading,
  lifecycle/actor authorization, policy, and invariant checks. Effectful
  outboxes carry the causal group revision read with the fence; no-op receipts
  carry `acceptedCausalRevision: null` and do not enqueue an effect. A
  request-id-bearing no-op still fences before claiming its ledger row. Since
  that touch changes no group domain field, an existing cache remains valid.
  PUT receipts are always
  `applied`; only DELETE may record either an applied deletion or a legitimate
  no-op. The route returns without waiting for recompute or publish. The
  mutation identity is the `:requestId` path segment only: 20 to 128 letters,
  digits, underscores, or hyphens. A request that also sends an
  `Idempotency-Key` header or a `requestId` body field is rejected with HTTP 400
  `api-mutation-request-invalid`. Browser callers pass `options.requestId`.
- `GET /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/topology/override`
  reads the temporary override.
  `PUT|DELETE .../topology/override/requests/:requestId` manages temporary topology overrides with the same convergent receipt/outbox
  transaction and asynchronous return contract.
- `POST /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/topology/reconfigure/requests/:requestId`
  commits a topology recompute request through AppInbox and returns the
  mandatory queued receipt (`status`, `groupRef`, `requestId`, and `outboxId`).
  Resource-inbox outbox work performs recompute and optional publication
  asynchronously; callers observe completion through the normal topology read
  path.

Topology config resolves as server defaults, durable config, temporary override,
then request-time reconfigure options. Writes require an active, unexpired group
and an authenticated group owner/admin or a platform admin client ID from the
profile's `authentication.adminClientIds`, which `AUTH_ADMIN_CLIENT_IDS`
overrides; platform administration bypasses membership/role, not
group lifecycle. On a CAS retry, lifecycle policy receives a fresh attempt time,
while stored write timestamps and relative override TTL stay anchored to the
first non-replay attempt. If that stable override expiry has elapsed before a
retry, the request fails with `override-expiry-not-in-future` rather than
extending or committing the expired override. Strict read auth
(`RALLAR_STATE_STRICT_READ_AUTH`) also protects group graph and topology reads.

### Admin Operations REST

API-v1 exposes platform-admin operational statistics and bounded maintenance
operations under `/api/admin/operations/*`. Every route requires a normal bearer
auth session, a matching `x-client-id` header, and a client id in the profile's
`authentication.adminClientIds`, which `AUTH_ADMIN_CLIENT_IDS` overrides.

Read routes:

- `GET /api/admin/operations/overview` returns a compact dashboard summary for
  server health, websocket counts, queue pressure, state, CRDT metadata, and
  storage pressure.
- `GET /api/admin/operations/queues` returns QueueBox and app-inbox result row
  counts by type/status plus expiry pressure.
- `GET /api/admin/operations/realtime` returns process-local WebSocket status,
  RTC topology metrics, and group-formation metrics. Responses include a warning because these metrics
  are process-local in multi-server deployments.
- `GET /api/admin/operations/state` and
  `GET /api/admin/operations/state/apps/:applicationId/workspaces/:workspaceId`
  return client, group, and state-event aggregates.
- `GET /api/admin/operations/crdt` and
  `GET /api/admin/operations/crdt/apps/:applicationId/workspaces/:workspaceId`
  return CRDT document metadata and storage counters only.
- `GET /api/admin/operations/system` returns runtime-state, app-data,
  state-event, and safe SQL/pubsub mode summaries.

Write routes are intentionally narrow:

- `POST /api/admin/operations/metrics/reset` resets the resettable in-memory
  metric categories `rtc-topology` and `group-formation`, both when
  `categories` is omitted.
- `POST /api/admin/operations/topology/recompute/requests/:requestId` delegates to the same scoped
  topology recompute path used by group topology management.
- `POST /api/admin/operations/maintenance/prune-expired/requests/:requestId`
  requires a caller request ID and defaults to dry-run.
  Real execution deletes only expired rows for supported categories. App-data
  pruning requires an explicit namespace and optional store name.
- `POST /api/admin/operations/crdt/integrity` and
  `/api/admin/operations/crdt/debug-export` read through the CRDT admin
  repository. `POST /api/admin/operations/crdt/compact/requests/:requestId`,
  `/api/admin/operations/crdt/lifecycle/requests/:requestId`, and
  `/api/admin/operations/crdt/erase/requests/:requestId` commit through
  AppInbox. Debug exports keep payloads redacted by default unless an admin
  explicitly disables redaction.

Read routes, `metrics/reset`, and `maintenance/prune-expired` responses include
`generatedAtEpochMs`, `serverId` when known, and `warnings` for partial or
process-local sources. `topology/recompute` returns the queued topology receipt
(`status`, `groupRef`, `requestId`, `outboxId`). The CRDT routes return the
integrity report, debug bundle, compaction result, document metadata, or erase
result directly. Admin operation responses do not expose bearer
tokens, websocket tickets, passwords, raw queue payloads, or CRDT
update/snapshot payloads outside the explicit debug-export workflow.
`metrics/reset`, `crdt/integrity`, and `crdt/debug-export` emit `rallar.timing`
events with component `admin-operations`: operation name, status, duration,
admin client id, session id, and bounded target metadata. `metrics/reset` and
`crdt/debug-export` also record `reason`. The AppInbox-backed mutation routes
emit the generic `app-inbox*` events, and prune adds `admin-prune-inbox` phase
events. No timing event includes bearer tokens or raw operation payloads. `RALLAR_TIMING_LOGS` controls the
default console sink.

### Admin prune queue work

Prune pages are persisted application queue work. Their canonical AL target is
`{ mode: "broadcast", scope: "all" }`, with topic
`rallar.admin.prune-expired` and a normalized job ID as the route context.
`APP_OUTBOX` reservation and the `ADMIN_PRUNE_EXPIRED` callback dispatch them to
one page worker; these targets do not publish the page to browser sockets or RTC
peers. The worker still checks the current admin session, expiry, page bounds,
aggregate identity, and reservation before committing deletion.

The prune page codec has no compatibility reader for the earlier
`{ mode: "all", scope: "global" }` target. A database that still holds prune
pages written in that shape has to be cleared before this build reads it.

### Admin Support REST

API-v1 exposes targeted platform-admin diagnostics under
`/api/admin/support/explain/*`. Every route requires a normal bearer auth
session, a matching `x-client-id` header, and a client id in the profile's
`authentication.adminClientIds`, which `AUTH_ADMIN_CLIENT_IDS` overrides.

Explain routes:

- `POST /api/admin/support/explain/client` accepts `scope`, `principalId`,
  optional `clientInstanceId`, optional `sessionId`, and optional
  `limitRecentEvents`. It returns a diagnostic narrative with client snapshot
  facts, presence facts, bounded recent client events, and a process-local
  WebSocket connection match when the current API worker can see one.
- `POST /api/admin/support/explain/group` accepts `groupRef`, optional
  `principalId`, optional `sessionId`, and optional `limitRecentEvents`. It
  returns group snapshot facts, bounded recent group events, focused session or
  member facts, and a summarized
  `GroupTopologyConfigQueryService.readTopologyView` result.
- `POST /api/admin/support/explain/request` accepts optional `requestId`,
  `idempotencyKey`, `queueKey`, and `target`. Phase 1 supports explicit
  QueueBox-key delegation. Request-id-only global search is intentionally not
  indexed and returns a warning instead of scanning tables.
- `POST /api/admin/support/explain/crdt-document` accepts `document` plus
  optional `includeIntegrity` and `includeRedactedDebugBundle`. Debug bundle
  summaries are always requested with payload redaction; this support route does
  not expose a raw-payload opt-out.
- `POST /api/admin/support/explain/queue-item` accepts `queueKey` and optional
  `includeExpired`. It reads `resource_inbox` and `resource_inbox_results` by
  explicit QueueBox key and returns status, attempts, retry/expiry timeline, and
  redacted payload metadata such as byte length and JSON shape.

Support responses use a diagnostic narrative DTO:
`target`, `generatedAtEpochMs`, `serverId`, `facts`, `timeline`, `warnings`,
`likelyCauses`, `suggestedActions`, and `rawRefs`. Queue and CRDT payload bodies
are not returned. Recent state events are bounded by `limitRecentEvents` with a
server-side cap. Live WebSocket facts are labeled process-local because the
WebSocket status reader only reflects the current API worker.

Support explanation generation emits `rallar.timing` events with component
`admin-support`; timing details include bounded target metadata and exclude
bearer tokens and raw payloads.

### Target Resolver

`createWsServerTargetResolver(webSocketServer, options?)` creates the default target resolver.

It supports:

- Direct peer routing by open websocket connection ID.
- Group routing through scoped group snapshots and active group presence sessions.
- Broadcast routing to the room, narrowed to the principal's sessions for a principal broadcast that names its room and to the listed sessions for a room broadcast with `recipientPeerIds`; to state-sync recipients; or to all open sockets, from which a client's `world` broadcast reaches only the sender's authenticated scope.
- CRDT principal routing through the principal's live client sessions.
- Overlay topology broadcasts to the open sockets of their recorded `recipientPeerIds`.

Group and room-scoped messages must carry `groupRef` in their targets. The
default resolver returns no recipients for a group target without a
`groupRef`; there is no `groupId`-only fallback.

## Server Application

Applications use `createRallarServerApplication(...)` around the middleware runtime.

```ts
const rallarServer = createRallarServerApplication({
    runtime,
    repositories,
    appDataRepository,
    nowEpochMs: Date.now,
    ws: {},
    systemInstallers,
    routeInstallers: {
        webSocket: (app) => installWsRoutes(app),
        rest: [installAuthRoutes, installStateRoutes]
    }
});

rallarServer.installSystemTopics();
rallarServer.installWebSocketLifecycle();
rallarServer.mountWebSocket(app);
rallarServer.mountRest(app);
await runtime.readiness;
rallarServer.start();
```

The server application exposes:

- `installSystemTopics()`
- `installWebSocketLifecycle()`
- the real WebSocket router as `ws`
- the real app-data owner as `appData`
- `ws.install()`
- `ws.defineTopic(definition)`
- `ws.removeTopic(selector)`
- `ws.on(selector, handler)`
- `ws.proxy(rule)`
- `ws.publish({ message, scope?, fanout? })`; `scope` is only for a unicast that names no group, and a message that names a group takes its scope from `targets.groupRef`; a message whose `ordering` states `orderingKey` (and `epoch`) without `seq` is sequenced by the server at `outbox` admission and refused at `live-only` and `none` (see "Ordering, Repair And Resynchronization"); an `outbox` publish result's message is the admitted one and carries the minted `seq`, while a `live-only` or `none` publish returns the caller's message
- `ws.status()`
- `appData.define/open/lookup/close(...)`
- the repository manager as `repositories`
- `runtime`, `mountWebSocket(app)`, `mountRest(app)`, and `start()`
