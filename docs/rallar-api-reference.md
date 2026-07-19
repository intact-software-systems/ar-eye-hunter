# Rallar API Reference

This document describes the public facade APIs in:

- `packages/shared-web/browser/rallar.ts`
- `packages/shared-web/browser/rallar-data.ts`
- `packages/shared-server/rallar-system/middleware/RallarMiddleware.ts`

It also references the server facade wrappers where they are the normal way to consume the middleware runtime.

## Browser Rallar

Import one shared facade instance, or create an isolated facade:

```ts
import { rallar, createRallarFacade } from '@shared-web/browser/rallar.ts';

const isolated = createRallarFacade();
```

### Defaults And Configuration

`configure(config)` sets the browser API base URL. It must be called before the facade connects.

```ts
rallar.configure({ apiBaseUrl: 'http://localhost:8080' });
```

`setDefaults(defaults)` stores facade defaults for scope, room, RTC, realtime, and operation policies.

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
        rttReportingDegreeLimit: 5,
    },
    messages: { maxPayloadBytes: 64 * 1024 },
    operations: { timeoutMs: 5000, maxAttempts: 3 },
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
    rtc: { maxPeerConnections: 10, rttReportingDegreeLimit: 5 },
});
```

Route IDs used for rooms, topics, types, lanes, overlays, and peers must be routable Rallar IDs: already-trimmed strings of 1-128 characters using letters, numbers, `.`, `_`, `:`, or `-`. Room IDs are stable route IDs; display names remain human-readable text.

Browser sends validate caller input before enqueueing. Invalid caller input throws `RallarValidationError` with structured `.issues`; delivery/readiness outcomes still use send result statuses such as `no-route`, `not-ready`, and `no-targets`.

```ts
import { isRallarValidationError } from '@shared/api/rallar-validation.ts';

try {
    await rallar.messages.ws.send({
        scope: 'room',
        roomId: 'lobby',
        topicId: 'room.chat',
        typeId: 'chat.message.v1',
        payload: { text: 'hello' },
    });
} catch (error) {
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
    refreshPeople: true,
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

`auth.login(request, options?)` logs in, writes the session locally, and disconnects any existing middleware if the API base/session changes.

`auth.register(request, options?)` registers a user. Pass `adminSession` if the API requires an admin session.

`auth.registerAndLogin(request, options?)` registers and then logs in.

`auth.logout(options?)` disconnects, calls the logout API when a session exists, closes authenticated data scopes, clears the local session, and emits state.

`auth.restore()` reads the locally stored session.

`auth.isLoggedIn()` returns whether a stored session exists.

```ts
await rallar.auth.registerAndLogin({
    username: 'alice',
    password: 'secret',
    displayName: 'Alice',
});
```

### Rooms

`rooms.state()` returns the current derived room state.

`rooms.list()` returns room summaries.

`rooms.refresh(input?)` fetches current room and client snapshots from the API and updates local caches.

`rooms.create(input)` creates a group/room, joins it, and makes it current.
`input` can be a display name string or an object. It does not leave the
previous current room, so use it when multi-room membership is intentional.
Object input can include `groupId`, `displayName`, `description`, `joinMode`,
`maxMembers`, `maxSessionsPerMember`, `metadata`, `expiresAtEpochMs`, and
`purgeAfterEpochMs`. `joinMode` is one of `open`, `invite-only`, or `code`.

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
`leave()`, `refresh()`, `message(...)`, and `realtime(...)`.

`rooms.leave(input?)` leaves a room. It can use explicit `roomId`, `roomRef`, the default room, or the current room.

`rooms.update(input)` updates owner/admin-controlled room fields, including
display metadata, `joinMode`, and capacity limits.

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
`rooms.setMemberRole(room, principalId, role, options?)`, and
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
const created = await rallar.rooms.createAndSwitch({
    displayName: 'Lobby',
    scope: { applicationId: 'game', workspaceId: 'default' },
});

const room = rallar.rooms.session(created.group);
const chat = room.message<{ text: string }>('chat');
const motion = room.realtime<{ x: number; y: number }>('motion');

const presence = await rallar.rooms.waitForPresence(created.group, {
    expect: { min: 2, max: 8 },
    timeoutMs: 2000,
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
`GROUP_POLICY_REASON_CODES`: `group-policy-denied`, `group-invite-required`,
`group-code-required`, `group-code-invalid`, `group-invite-expired`,
`group-archived`, `group-deleted`, `group-not-active`, `group-full`,
`member-session-limit-reached`, `member-not-active`, `member-removed`,
`member-banned`, `forbidden-role`, and `last-owner`.

REST errors keep the existing `{ error }` shape and may also include `code`,
`message`, and `details`. Browser workflows preserve the parsed response on
`ApiHttpError`, so apps can branch on stable policy reason codes without string
matching `error`.

The group state routes for the policy workflows are:

- `POST /api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/join`
- `POST /api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/invites/accept`
- `POST /api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/join-code/rotate`
- `POST /api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/invites/{principalId}`
- `POST /api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/invites/{principalId}/revoke`
- `POST /api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/members/{principalId}/remove`
- `POST /api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/members/{principalId}/ban`
- `POST /api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/members/{principalId}/unban`
- `PUT /api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/members/{principalId}/role`
- `POST /api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/owner/transfer`

Join-code rotation is currently exposed through lower-level API integration and
workflow helpers. The plaintext code is returned only by the rotation response;
the group snapshot stores verifier metadata. Codes are reusable until expiry,
and rotation invalidates the previous code.

Set `RALLAR_STATE_STRICT_READ_AUTH` to `1`, `true`, `yes`, or `on` on API-v1 to
align authenticated list/snapshot/event reads with full-state group read
policy. `/api/state/*` routes already require authentication; strict mode adds
the narrower server-side read authorization before exposing full group state.
In strict mode, REST reads, state-sync routing, and room messaging authorization
all use server-side group policy before exposing full group state or allowing
room traffic.

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

`director.appoint(room, options?)` appoints the current browser session as the
room director through the narrow state API endpoint. It does not call
`rooms.updateMetadata(...)`, and it does not grant the caller owner/admin
permissions.

Owners and admins can appoint while their own room session is active. For Rallar
Game's default browser-director policy, an active member may also appoint when no
owner/admin session is online and no existing director appointment has an active
session. `rooms.updateMetadata(...)` remains owner/admin-only for generic group
metadata changes.

`director.status(room?)` reads the current appointment and returns whether the
local session is the fresh director. `director.createRelay(...)` builds the
intent/output/snapshot relay around that appointment.

```ts
const room = rallar.rooms.session(created.group);

await rallar.director.appoint(room.roomRef, {
    heartbeatTtlMs: 4_000,
});

const status = rallar.director.status(room.roomRef);
if (status.isDirector) {
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
envelopes with `createRallarServerValidatedMatchResult(...)` after validating
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

`people.refresh(input?)` fetches client snapshots from the API and updates local caches.

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

Selectors can be a `typeId` string or `{ topicId, typeId }`.

```ts
rallar.messages.ws.onMessage('chat.message', (message) => {
    console.log(message.payload);
});

await rallar.messages.ws.send({
    topicId: 'room.chat',
    typeId: 'chat.message.v1',
    payload: { text: 'hello' },
    scope: 'room',
    roomRef: room.group,
});
```

Typed channels reduce boilerplate when one payload type has one topic/type pair:

```ts
type ChatMessage = { text: string };

const chat = rallar.messages.channel<ChatMessage>({
    topicId: 'room.chat',
    typeId: 'chat.message.v1',
});

chat.onWs((payload) => console.log(payload.text));
await chat.sendWs({ text: 'hello' }, { scope: 'room', roomRef: room.group });
```

Room channels add room defaults and default `send(...)` to the existing
`rtc-with-ws-fallback` strategy. This scopes sends; `onWs(...)` and
`onRtc(...)` still subscribe by topic/type. Their callbacks receive the full
`RallarMessage<T>`, and room sends that use a `roomRef` carry the target
`GroupRef` in `message.raw.targets`. Validate that reference with
`isSameGroupRef` before accepting an inbound payload:

```ts
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { RallarMessageSendStatus } from '@shared-web/browser/rallar.ts';

type RoomChatMessage = { text: string };

const acceptedMessageStatuses: ReadonlySet<RallarMessageSendStatus> = new Set([
    'enqueued',
    'sent-immediate',
    'duplicate',
    'superseded',
    'skipped',
]);

const roomSession = await rallar.rooms.enter('lobby');
const roomChat = roomSession.message<RoomChatMessage>('chat');

roomChat.onWs((payload, message) => {
    const targets = message.raw.targets;
    const targetRoomRef = targets?.mode === 'multicast'
        ? targets.groupRef
        : targets?.mode === 'broadcast' && targets.scope === 'room'
        ? targets.groupRef
        : undefined;
    if (targetRoomRef && isSameGroupRef(targetRoomRef, roomSession.roomRef)) {
        console.info(payload.text);
    }
});

const sendResult = await roomChat.send({ text: 'hello' });
if (!acceptedMessageStatuses.has(sendResult.status)) {
    console.warn('Chat delivery degraded', sendResult.status, sendResult.reason);
}
```

The accepted message send statuses are `enqueued`, `sent-immediate`,
`duplicate`, `superseded`, and `skipped`. Surface every other status to the
product as degraded or failed delivery.

### RTC Status And Readiness

`rtc.status(options?)` returns a snapshot of peer/lane readiness.

`rtc.onStatus(listener, options?)` subscribes to RTC status snapshots.

`rtc.onLifecycle(listener, options?)` subscribes to RTC lifecycle events such as `peer-created`, `lane-open`, `lane-close`, and `peer-timeout`.

`rtc.waitForLane(peerId, laneId, options?)` waits for a specific peer/lane.

`rtc.waitForOpen(peerId, options?)` waits for the default or configured lane.

`rtc.waitForRoomLane(room, laneId, options?)` waits for room peers on one RTC
lane and returns separate `ready` and `notReady` lists. The same readiness
expectation shape used by `rooms.waitForPresence(...)` can be passed as
`options.expect`; the result also includes `readyPeerIds`, `notReadyPeerIds`,
`missingPeerIds`, `extraPeerIds`, `observedCount`, and `expectedCount`.

`rtc.peer(peerId, options?)`, `knownPeerIds()`, `activePeerIds()`, `peerIdsWithNoReconnectableLanes()`, and `readyPeerIds(laneId?)` expose peer subsets.

```ts
const readiness = await rallar.rtc.waitForRoomLane('lobby', 'realtime', {
    connect: true,
    timeoutMs: 1000,
    expect: { min: 1, max: 10 },
});

if (readiness.status === 'open' || readiness.status === 'partial') {
    console.log(
        'Ready peers',
        readiness.readyPeerIds,
    );
}
```

Browser RTC enables a bounded initial-establishment budget by default: six
attempts, 180 seconds total, and a 30 second cooldown after exhaustion. The
shared service exposes `WebRtcPeerLaneOpenStatus: 'exhausted'` and
`WebRtcPeerConnectionLeft.kind: 'connect-exhausted'`; the browser facade keeps
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

```ts
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

type MotionUpdate = Readonly<{ roomRef: GroupRef; x: number; y: number }>;

const room = await rallar.rooms.enter('lobby');
const lane = room.realtime<MotionUpdate>({
    laneId: 'motion',
    waitTimeoutMs: 1000,
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
        sendResult.transportStatus,
    );
}
```

Room realtime send statuses are `sent`, `partial`, `not-ready`, `no-targets`,
and `failed`. Only `sent` is fully delivered; surface every other status as
degraded.

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
leave it unset for the V1 linear behavior.

Samples use `observedAtEpochMs` as the local receiver clock. Sender
`sentAtEpochMs` values can be stored in metadata for diagnostics, but they
should not drive interpolation unless the app has explicit clock sync.

Metadata is copied from the newest contributing sample. Rallar Motion does not
merge, validate, or synthesize metadata. Rotation support is tuple-based Euler
interpolation/integration in caller-defined units; quaternion interpolation is
not part of V2. Angle wrapping is opt-in through
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
ranges and precision are always caller-owned; Rallar Motion does not assume a
world scale.

```ts
import {
    RallarMotion,
    createRallarMotionAdaptiveDelay,
} from '@shared/rallar-motion/mod.ts';

const adaptiveDelay = createRallarMotionAdaptiveDelay();

const motion = RallarMotion.createBuffer({
    readInterpolationDelayMs: adaptiveDelay.currentDelayMs,
    maxExtrapolationMs: 150,
    interpolationMode: 'hermite',
    discontinuity: { enabled: true, maxPositionDelta: 8 },
});

rallar.realtime.onJson<{ position: [number, number, number]; seq: number }>(
    'motion',
    (message) => {
        motion.push({
            entityId: message.peerId,
            observedAtEpochMs: message.receivedAtEpochMs,
            position: message.data.position,
            seq: message.data.seq,
        });
        adaptiveDelay.pushObservedAt(message.receivedAtEpochMs);
    },
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

```ts
const stream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: true,
});

await rallar.media.setLocalStream(stream);
rallar.media.onRemoteStream(({ peerId, stream }) =>
    attachVideo(peerId, stream),
);
```

## Rallar CRDT

`rallar.crdt` opens explicit collaborative CRDT documents. It does not change
`rallar.data` latest-value semantics.

```ts
const doc = await rallar.crdt.open('room-checklist', {
    documentType: 'checklist',
    documentId: room.group.groupId,
    scope: {
        kind: 'room',
        roomRef: room.group,
    },
    transport: 'ws',
});

await doc.applyLocal({
    kind: 'batch',
    operations: [
        {
            kind: 'map.set',
            path: [],
            key: 'title',
            value: 'North entrance',
        },
    ],
});
```

### Document API

- `read()` returns the merged value.
- `subscribe(listener)` receives merged snapshots.
- `applyLocal(batch)` applies and persists a local operation batch.
- `pendingUpdates()` returns locally produced updates not yet durably accepted.
- `failedPendingUpdates()` returns permanent or exhausted pending failures.
- `dependencyBlockedUpdates()` returns updates waiting for missing parents or
  observed IDs.
- `sequenceInsert(input, options?)`, `sequenceMove(input, options?)`, and
  `sequenceDelete(input, options?)` mutate ordered-list paths with stable
  element and position IDs.
- `counterAdd(input, options?)`, `counterIncrement(path, options?)`, and
  `counterDecrement(path, options?)` mutate CRDT counter paths.
- `numberMin(input, options?)` and `numberMax(input, options?)` merge finite
  numeric values with deterministic min/max semantics.
- `operationGroupUpdateIds(operationGroupId)` returns locally known updates for
  an actor-owned operation group.
- `undoOperationGroup(input)` and `redoOperationGroup(input)` add compensating
  CRDT operations for the caller's operation group. V1 supports "undo my
  change", not document-wide collaborative undo.
- `snapshot()` exports a compact snapshot envelope.
- `flush()` persists the current snapshot.
- `sync(options?)` retries pending live sends and requests catch-up.
- `health()` reports pending counts, live transport counters, last server append
  sequence, last durable ACK time, and corrupt local artifact count.

### Hardening Options

`open(..., { policies, metrics, encryption, validation })` can attach CRDT production
controls:

- `policies`: shared rollout/feature policies for local apply, WS, RTC,
  durable append, peer catch-up, read-only mode, and kill switches.
- `metrics`: a `RallarCrdtMetricsSink` for local apply, replay, sync,
  pending, dependency, append, and rejection metrics.
- `encryption`: a `RallarCrdtEncryptionKeyring`. When present, browser
  persistence, live transport, and durable append carry AES-GCM encrypted update
  payloads and snapshot bodies; authorized clients decrypt before merge.
- `validation`: optional CRDT validation options, including strict path
  ownership schemas for production documents. Strict path kinds include
  `register`, `map`, `orset`, `sequence`, `counter`, and `number`.

### Transport

Room documents support `local-only`, `ws`, `rtc`, `ws-then-rtc`, and
`rtc-with-ws-fallback`. App and principal documents use the `app.crdt` WS topic;
RTC remains room-scoped.

WS is the safest default. RTC can accelerate active peers but does not replace
the durable server append log. Pending updates clear only after a durable append
response accepts or dedupes the update. `sync()` requests durable WS catch-up
when the selected strategy includes WS, then keeps peer catch-up as a
development/live-repair fallback. Deployments can also wire
`readDurableCatchUp` or per-document `durableCatchUp` to use the HTTP helper
`catchUpRallarCrdtDocument(...)`.

### Server

API-v1 installs `room.crdt` topics through the Rallar server dynamic WS topic
router. The server validates envelopes, authorizes room messages, appends
accepted updates to `crdt_updates`, sends append responses, and fans out
accepted updates.

Principal documents can fan out live only when the server CRDT bridge is
configured with a durable log and principal session resolver. The durable append
log remains the source of truth.

Authenticated durable catch-up is available over HTTP:

- `POST /api/crdt/catch-up`

The request returns an optional compact snapshot plus an append-log page.

CRDT log repositories expose admin/hardening methods for listing documents,
debug bundle export, backup bundle export/restore, integrity verification,
projection rebuild, non-destructive compaction, archive, destroy, and
quarantine lifecycle.

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
- `POST /api/crdt/admin/documents/rebuild-projection`
- `POST /api/crdt/admin/documents/compact`
- `POST /api/crdt/admin/documents/lifecycle`
- `POST /api/crdt/admin/documents/erase`

See [Rallar CRDT Guide](./rallar-crdt-guide.md) for the full product boundary.

## Rallar Data

Rallar Data is a browser IndexedDB-backed key-value facade with observable in-memory repositories.

Import through `rallar.data`, or directly:

```ts
import {
    createRallarDataFacade,
    defineRallarDataStore,
} from '@shared-web/browser/rallar-data.ts';
```

### Facade API

`define(name, options?)` returns a store definition.

`open(input, options?)` opens or creates a store. If `hydrate` is `eager`, it hydrates before returning.

`lookup(input, options?)` returns an already-open store, or `undefined`.

`close(input, options?)` flushes and disposes an open store.

`closeScope(scope)` closes active stores in a scope.

`clearScope(scope)` clears active stores in a scope without closing them.

`destroy(input, options?)` clears persisted data and closes/disposes the store.

`destroyStore(...)` aliases `destroy(...)`.

`destroyScope(scope)` clears and closes active stores in a scope.

`estimateUsage()` returns browser storage usage/quota when available.

```ts
type Settings = { volume: number };

const settingsDef = rallar.data.define<Settings>('settings', {
    scope: 'principal',
    durability: 'write-through',
});

const settings = await rallar.data.open(settingsDef);
await settings.set('audio', { volume: 0.8 });
```

### Store Options

- `scope`: logical grouping, defaults to `'app'`.
- `dbName`: IndexedDB database name, defaults to `rallar-custom-data`.
- `storeName`: IndexedDB object store name, defaults to `entries`.
- `keyPrefix`: key namespace; normally leave unset.
- `ttlMs`: time-to-live for entries.
- `durability`: `'write-through'` persists on mutation; `'write-behind'` persists asynchronously.
- `hydrate`: `'eager'` or `'lazy'`.
- `schemaVersion`: persisted envelope schema version, defaults to `1`.
- `migrate`: converts old values to the current schema.
- `sync`: enables `BroadcastChannel` cross-tab sync when available.
- `isValid`: rejects invalid values during repository operations.
- `equals`: custom equality function.
- `expireAtFor`: per-value expiry timestamp.
- `onPersistenceError`: write-behind persistence error handler.

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
const drafts = await rallar.data.open<{ body: string }>('drafts', {
    scope: 'session',
    durability: 'write-behind',
    hydrate: 'lazy',
    ttlMs: 24 * 60 * 60 * 1000,
});

drafts.onChange((event) => {
    console.log(event.key, event.value);
});

await drafts.updateOrCreate('room:lobby', (current) => ({
    body: current?.body ?? '',
}));

await drafts.whenIdle();
```

## Rallar Middleware

`createRallarMiddleware(options)` builds the server-side runtime used by the Rallar server facade.

### Runtime

The returned `RallarMiddlewareRuntime` contains:

- `qboxEngine`: `InboxOutboxEngine` with WS and app-inbox tasks installed.
- `wsQBoxServerService`: websocket queuebox service.
- `inboxQueueReader`: app-inbox queue reader.
- `outboxQueueReader`: app-outbox queue reader.
- `appInboxResilience`: app-inbox resilience settings.
- `appOutboxResilience`: independent app-outbox resilience settings.
- `appGroupInboxService`: durable group mutation inbox.
- `appClientInboxService`: durable client mutation inbox.
- `clientsRepository`: client snapshot repository.
- `groupsRepository`: group snapshot repository.

### Options

Required:

- `inbox`: queuebox repository for inbound app/WS work.
- `createAppGroupInboxService(input)`: factory for the group app inbox service.
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
- `findGroupSnapshotByRef`, `findGroupSnapshotById`, `resolveGroupRef`: used by the default target resolver.
- `inboundStores`, `outboundStores`: AL runtime stores.
- `resilience.outbox`: defaults to `resilience.inbox`.
- `resilience.appInbox`: defaults to `resilience.inbox`.

### Middleware Example

```ts
const runtime = createRallarMiddleware({
    inbox: queueBox,
    outbox: queueBox,
    webSocketServer,
    wsRuntimeName: 'api-v1',
    findGroupSnapshotByRef: (ref) => groupSnapshotCache.findByRef(ref),
    inboundStores,
    outboundStores,
    createAppGroupInboxService: ({
        inboxQueueReader,
        outboxQueueReader,
        wsQBoxServerService,
        wakeQueueEngine,
    }) => {
        const topologyOutbox = createRtcTopologyOutboxPublisher({
            outboxQueueReader,
            senderId: serverId,
            wake: wakeQueueEngine,
        });
        return new AppGroupInboxService(
            inboxQueueReader,
            resourceInboxRepository,
            resourceInboxResultsRepository,
            groupStateService,
            createWsStateSyncPublisher(wsQBoxServerService, { serverId }),
            serverId,
            undefined,
            undefined,
            topologyOutbox.publisher,
        );
    },
    createAppClientInboxService: ({ inboxQueueReader, wsQBoxServerService }) =>
        new AppClientInboxService(
            inboxQueueReader,
            resourceInboxRepository,
            resourceInboxResultsRepository,
            clientStateService,
            createWsStateSyncPublisher(wsQBoxServerService, { serverId }),
            serverId,
        ),
    resilience: {
        inbox: resilienceInbox,
        outbox: resilienceOutbox,
        appOutbox: resilienceAppOutbox,
    },
    clientsRepository,
    groupsRepository,
});

runtime.qboxEngine.start();
```

### Queue Engine Helpers

`includeWsQueueBoxEngineTasks(engine, wsQBoxServerService, resilienceInbox, resilienceOutbox)` installs WS inbox/outbox dequeue tasks.

`includeInboxQueueReaderEngineTasks(engine, inboxQueueReader, resilience)` installs app-inbox dequeue tasks.

`includeOutboxQueueReaderEngineTasks(engine, outboxQueueReader, resilience)` installs app-outbox dequeue tasks.

Use these only if you are composing your own engine instead of calling `createRallarMiddleware`.

### Built-In System Topics

`initRallarSystemWsTopics(wsQBoxServerService, options?)` installs the built-in
state-sync, graph, RTT, overlay topology, chat, and RTC signaling topics.

`options.rtcTopologyAppOutbox` routes inbound group snapshots and RTT-triggered
overlay recomputes through the durable app outbox with one coalesced work row per
scoped overlay. Local group mutations enqueue the same work beside state-sync
publication through `AppGroupInboxService`. Provide `outboxQueueReader` and
optionally `wake`, `topicId`,
`senderId`, and `findGroupSnapshotByRef`. In production,
`findGroupSnapshotByRef` should read through `GroupStateSnapshotReadThroughCache`
or another durable group snapshot source. When this option is omitted,
group-snapshot topology publication remains immediate and RTT-triggered topology
recomputes use the local in-process debounce timer.

`options.rtcTopologyRuntimeState` can provide a runtime-state repository for
multi-worker topology continuity. Rallar stores published topology snapshots in
`rtc-topology:snapshots` and latest accepted RTT measurements in
`rtc-rtt:latest`. When combined with `rtcTopologyAppOutbox`, a worker can
continue overlay versioning from the previous durable snapshot and compute with
durable RTT inputs even if another worker accepted the triggering RTT message.
`rttTtlMs` can override the durable RTT retention window.

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
- `GET|PUT|DELETE /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/topology/config`
  manages durable group topology config. Mutations commit with optimistic CAS,
  persist a first-writer idempotency record when `requestId` is supplied, and
  always persist the queued `rtc-topology-recompute` intent for an effectful
  write in the same transaction. A retained per-target generation record keeps
  accepted versions monotonic across DELETE, recreation, and override TTL
  expiry. A separate retained group invariant generation serializes config and
  override decisions, forcing cross-target conflicts through a full reread and
  revalidation. Generation floors are optimistically backfilled before first
  access and before periodic expiry cleanup, including already-expired override
  rows. Topology config, override, mutation, generation, and invariant records
  use the canonical optional-workspace group-state key codec, so an absent
  workspace remains distinct from a literal `_` workspace and encoded
  delimiter/lookalike values. Deployments with the older ambiguous topology
  source keys must stop old writers and run
  `migrateLegacyGroupTopologyConfigKeys` as an explicit offline/operator step.
  Normal startup and first-access readiness never move those keys: they fail
  closed, and startup does not enable expiry eviction until the migration has
  completed. Effective reads bracket durable config and override with the
  invariant generation so they cannot combine states that never coexisted.
  Every response includes a compact receipt whose mandatory nullable replay
  timestamps let the service reconstruct a PUT replay without storing the full
  accepted config in the idempotency ledger. The route returns without waiting
  for recompute or publish. Browser DELETE callers can supply `requestId`; REST
  callers send the same stable value as `Idempotency-Key`.
- `GET|PUT|DELETE /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/topology/override`
  manages temporary topology overrides with the same convergent receipt/outbox
  transaction and asynchronous return contract.
- `POST /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/topology/reconfigure`
  is the only topology configuration route that waits synchronously for an
  immediate recompute and optional publication.

Topology config resolves as server defaults, durable config, temporary override,
then request-time reconfigure options. Writes require an authenticated group
owner/admin or a platform admin client ID from `AUTH_ADMIN_CLIENT_IDS`. Strict
read auth (`RALLAR_STATE_STRICT_READ_AUTH`) also protects group graph and
topology reads.

### Admin Operations REST

API-v1 exposes platform-admin operational statistics and bounded maintenance
operations under `/api/admin/operations/*`. Every route requires a normal bearer
auth session, a matching `x-client-id` header, and a client id listed in
`AUTH_ADMIN_CLIENT_IDS`.

Read routes:

- `GET /api/admin/operations/overview` returns a compact dashboard summary for
  server health, websocket counts, queue pressure, state, CRDT metadata, and
  storage pressure.
- `GET /api/admin/operations/queues` returns QueueBox and app-inbox result row
  counts by type/status plus expiry pressure.
- `GET /api/admin/operations/realtime` returns process-local WebSocket status
  and RTC topology metrics. Responses include a warning because these metrics
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

- `POST /api/admin/operations/metrics/reset` resets resettable in-memory metric
  categories, currently RTC topology metrics.
- `POST /api/admin/operations/topology/recompute` delegates to the same scoped
  topology recompute path used by group topology management.
- `POST /api/admin/operations/maintenance/prune-expired` defaults to dry-run.
  Real execution deletes only expired rows for supported categories. App-data
  pruning requires an explicit namespace and optional store name.
- `POST /api/admin/operations/crdt/integrity`,
  `/api/admin/operations/crdt/debug-export`,
  `/api/admin/operations/crdt/compact`,
  `/api/admin/operations/crdt/lifecycle`, and
  `/api/admin/operations/crdt/erase` delegate to existing CRDT admin repository
  workflows. Debug exports keep payloads redacted by default unless an admin
  explicitly disables redaction.

Admin operation responses include `generatedAtEpochMs`, `serverId` when known,
and `warnings` for partial or process-local sources. They do not expose bearer
tokens, websocket tickets, passwords, raw queue payloads, or CRDT
update/snapshot payloads outside the explicit debug-export workflow.
Write operations also emit `rallar.timing` events through the existing timing
sink. These events include operation name, status, duration, admin client id,
session id, request id, reason, and bounded target metadata; they do not include
bearer tokens or raw operation payloads. `RALLAR_TIMING_LOGS` controls the
default console sink.

### Admin Support REST

API-v1 exposes targeted platform-admin diagnostics under
`/api/admin/support/explain/*`. Every route requires a normal bearer auth
session, a matching `x-client-id` header, and a client id listed in
`AUTH_ADMIN_CLIENT_IDS`.

Explain routes:

- `POST /api/admin/support/explain/client` accepts `scope`, `principalId`,
  optional `clientInstanceId`, optional `sessionId`, and optional
  `limitRecentEvents`. It returns a diagnostic narrative with client snapshot
  facts, presence facts, bounded recent client events, and a process-local
  WebSocket connection match when the current API worker can see one.
- `POST /api/admin/support/explain/group` accepts `groupRef`, optional
  `principalId`, optional `sessionId`, and optional `limitRecentEvents`. It
  returns group snapshot facts, bounded recent group events, focused session or
  member facts, and a summarized `GroupTopologyManagementService.readTopologyView`
  result.
- `POST /api/admin/support/explain/request` accepts `requestId`,
  `idempotencyKey`, `queueKey`, and optional `target`. Phase 1 supports explicit
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
server-side cap. Live WebSocket facts are labeled process-local because
`rallarApplication.ws.status()` only reflects the current API worker.

Support explanation generation emits `rallar.timing` events with component
`admin-support`; timing details include bounded target metadata and exclude
bearer tokens and raw payloads.

### Target Resolver

`createWsServerTargetResolver(webSocketServer, options?)` creates the default target resolver.

It supports:

- Direct peer routing by open websocket connection ID.
- Group routing through scoped group snapshots and active group presence sessions.
- Broadcast routing to room, state-sync recipients, or all open sockets depending on AL message scope.

Prefer `groupRef`-aware messages where possible. If only `groupId` is available, the resolver can fall back to `findGroupSnapshotById`, but scoped `GroupRef` avoids cross-workspace ambiguity.

## Server Facade Wrappers

Most applications should use `createRallarServerApplication(...)` or `createRallarServerFacade(...)` around the middleware runtime.

```ts
const rallarServer = createRallarServerApplication({
    runtime,
    routes: {
        ws: (app) => installWsRoutes(app),
        rest: [installAuthRoutes, installStateRoutes],
    },
});

rallarServer.system.useDefaultMiddlewareTopics().useWebSocketLifecycle();

rallarServer.ws.mount(app);
rallarServer.rest.mount(app);
rallarServer.start();
```

The server facade exposes:

- `system.useDefaultMiddlewareTopics()`
- `system.useWebSocketLifecycle()`
- `ws.install()`
- `ws.defineTopic(definition)`
- `ws.removeTopic(selector)`
- `ws.on(selector, handler)`
- `ws.proxy(rule)`
- `ws.publish(message, fanout?)`
- `ws.status()`
- `data.define/open/lookupStore/closeStore(...)`
- repository manager operations under `data`
