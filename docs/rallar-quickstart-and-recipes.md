# Rallar Quickstart And Recipes

This document gives short, copyable patterns for common Rallar usage.

## Browser Quickstart

```ts
import { rallar } from '@shared-web/browser/rallar.ts';

const setup = {
    apiBaseUrl: 'http://localhost:8080',
    applicationId: 'game',
    workspaceId: 'default',
    realtime: { laneId: 'realtime', openTimeoutMs: 1000 },
    rtc: { maxPeerConnections: 10 },
    messages: { maxPayloadBytes: 64 * 1024 },
    start: { refreshPeople: true }
} as const;

let started = await rallar.setup(setup);
if (!started.session) {
    await rallar.auth.login({ username: 'alice', password: 'secret' });
    started = await rallar.start(setup.start);
}

const room = await rallar.rooms.enter('lobby');
```

## Subscription Scope

```ts
const subscriptions = rallar.subscriptions();

subscriptions.add(
    rallar.rooms.onChange((state) => {
        renderRooms(state.rooms);
    })
);

subscriptions.add(
    rallar.people.onChange((state) => {
        renderPeople(state.people);
    })
);

subscriptions.add(
    rallar.ws.onLifecycle((event) => {
        renderWsStatus(event.status);
    })
);

// Component cleanup.
subscriptions.unsubscribe();
```

## Create And Switch To A Room

```ts
const created = await rallar.rooms.createAndSwitch({
    displayName: 'Lobby'
});

const room = rallar.rooms.session(created.group);

const current = rallar.rooms.current();
```

Use `rooms.create(...)` instead when the browser should remain a member of the
previous current room too.

## Invite-Only Room

```ts
const created = await rallar.rooms.createAndSwitch({
    displayName: 'Private Lobby',
    joinMode: 'invite-only',
    maxMembers: 8
});

await rallar.rooms.invite(created.group, 'bob', {
    invitationExpiresAtEpochMs: Date.now() + 10 * 60 * 1000
});
```

The invited browser should use the safe accept workflow instead of writing its
own membership record:

```ts
await rallar.rooms.acceptInvite('private-lobby');
```

## Code-Protected Room

Join-code rotation is currently a lower-level workflow helper. The returned
plaintext code is the value to share; the group snapshot stores only verifier
metadata.

```ts
import { rotateStateGroupJoinCode } from '@shared-web/browser/rooms/room-membership-group-state-workflows.ts';

const scope = { applicationId: 'game', workspaceId: 'default' };
const session = rallar.session();
if (!session) {
    throw new Error('Login required');
}

const created = await rallar.rooms.createAndSwitch({
    displayName: 'Code Lobby',
    joinMode: 'code',
    scope
});

const rotated = await rotateStateGroupJoinCode({
    groupId: created.group.groupId,
    request: { expiresAtEpochMs: Date.now() + 30 * 60 * 1000 },
    actorPrincipalId: session.clientId,
    sessionId: session.sessionId,
    scope
});

await rallar.rooms.join(created.group, { joinCode: rotated.joinCode });
```

Codes are reusable until expiry. Rotate again to invalidate the previous code.

## Room Switch Recovery

`rooms.join(...)` and `rooms.createAndSwitch(...)` first join or create the new
room, then best-effort leave the old room. If the leave step fails, the new room
is already current and the error is named
`RallarRoomSwitchPartialFailureError`.

```ts
import type { RallarRoomSwitchPartialFailureError } from '@shared-web/browser/rallar.ts';

try {
    await rallar.rooms.join('arena-2');
}
catch (error) {
    if (isRoomSwitchPartialFailure(error)) {
        await rallar.rooms.leave({ roomRef: error.previousRoomRef });
    }
    else {
        throw error;
    }
}

function isRoomSwitchPartialFailure(
    error: unknown
): error is RallarRoomSwitchPartialFailureError {
    return error instanceof Error &&
        error.name === 'RallarRoomSwitchPartialFailureError';
}
```

## Wait For Room Presence

```ts
const presence = await rallar.rooms.waitForPresence('lobby', {
    expect: { min: 2, max: 8 },
    timeoutMs: 2000
});

if (presence.status === 'ready') {
    renderReadyPlayers(presence.activeSessionIds);
}
else {
    renderWaitingState(presence.status, presence.missingSessionIds);
}
```

## Room Event Replay

Use replay when the browser may have missed state-sync events while offline or disconnected.

```ts
const result = await rallar.rooms.replayEvents(
    {
        roomId: 'lobby',
        eventTypes: [
            'member-joined',
            'session-connected',
            'session-disconnected'
        ],
        limit: 100,
        maxPages: 3
    },
    (event) => {
        applyRoomEvent(event);
    }
);

console.log(result.replayedCount, result.duplicateCount);
```

## WS Chat

```ts
type ChatMessage = {
    text: string;
    sentAt: number;
};

const room = await rallar.rooms.enter('lobby');
const chat = room.message<ChatMessage>('chat');

const unsubscribe = chat.onWs((payload, message) => {
    appendChatMessage(message.senderId, payload.text);
});

await chat.sendWs({ text: 'hello', sentAt: Date.now() });
```

## Realtime Player Updates

```ts
type PlayerUpdate = {
    x: number;
    y: number;
    heading: number;
};

const room = await rallar.rooms.enter('lobby');
const playerUpdates = room.realtime<PlayerUpdate>({
    laneId: 'player',
    waitTimeoutMs: 1000
});

playerUpdates.on((message) => {
    updateRemotePlayer(message.peerId, message.data);
});

const result = await playerUpdates.send({ x: 10, y: 20, heading: 90 });

if (result.status === 'not-ready' || result.status === 'no-targets') {
    await room
        .message<PlayerUpdate>('player')
        .sendWs({ x: 10, y: 20, heading: 90 });
}
```

Use `rallar.rtc.waitForRoomLane(...)` and `rallar.realtime.sendJson(...)`
directly only when you need custom peer selection or low-level readiness
diagnostics.

```ts
const readiness = await rallar.rtc.waitForRoomLane('lobby', 'realtime', {
    connect: true,
    timeoutMs: 1000,
    expect: { min: 1, max: 10 }
});

if (readiness.readyPeerIds.length > 0) {
    await rallar.realtime.sendJson({
        laneId: 'realtime',
        peerIds: readiness.readyPeerIds,
        data: { x: 10, y: 20, heading: 90 }
    });
}
```

## Rallar Motion Smoothing

This is a standalone initial setup for Motion. Run it instead of the browser
quickstart above, not after another recipe has connected. The shared start
options configure the dedicated lane before the first possible connection and
are reused by post-login `start(...)`.

```ts
import { DEFAULT_REALTIME_DATA_CHANNEL_LANE } from '@shared-web/browser/rallar-realtime.ts';
import { rallar, type RallarStartOptions } from '@shared-web/browser/rallar.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { createRallarMotionBuffer } from '@shared/rallar-motion/mod.ts';
import type { RtcDataChannelLaneConfig } from '@shared/services/WebRtcConnectionService.ts';

type PoseUpdate = {
    roomRef: GroupRef;
    position: readonly [number, number, number];
    velocity?: readonly [number, number, number];
    seq: number;
};

const motionLaneConfig = {
    id: 'motion',
    label: 'rtc-motion',
    init: { ordered: false, maxRetransmits: 0 },
    flowControl: {
        overflow: 'replace-by-key',
        maxQueueItems: 8
    }
} satisfies RtcDataChannelLaneConfig;

const motionStartOptions = {
    connect: true,
    refreshRooms: true,
    dataChannelLanes: [DEFAULT_REALTIME_DATA_CHANNEL_LANE, motionLaneConfig]
} satisfies RallarStartOptions;

const motionSetup = {
    apiBaseUrl: 'http://localhost:8080',
    applicationId: 'game',
    workspaceId: 'default',
    start: motionStartOptions
} as const;

let started = await rallar.setup(motionSetup);
if (!started.session) {
    await rallar.auth.login({ username: 'alice', password: 'secret' });
    started = await rallar.start(motionStartOptions);
}
if (!started.session) {
    throw new Error('Login required before entering a room');
}
const sessionId = started.session.sessionId;

const motion = createRallarMotionBuffer({
    interpolationDelayMs: 100,
    maxExtrapolationMs: 150
});

const room = await rallar.rooms.enter('lobby');
const motionUpdates = room.realtime<PoseUpdate>({
    laneId: 'motion',
    waitTimeoutMs: 1000,
    key: `pose:${sessionId}`
});

motionUpdates.on((message) => {
    if (!isSameGroupRef(message.data.roomRef, room.roomRef)) {
        return;
    }
    motion.push({
        entityId: message.peerId,
        observedAtEpochMs: message.receivedAtEpochMs,
        position: message.data.position,
        velocity: message.data.velocity,
        seq: message.data.seq,
        metadata: message.data
    });
});

const estimates = motion.sampleAll(Date.now());
for (const [peerId, estimate] of estimates) {
    renderRemotePeer(peerId, estimate.position);
}
```

### Adaptive Delay

Use adaptive delay when packet spacing jitters. Keep the timestamps
receiver-local.

```ts
import {
    createRallarMotionAdaptiveDelay,
    createRallarMotionBuffer
} from '@shared/rallar-motion/mod.ts';

const delay = createRallarMotionAdaptiveDelay({
    minDelayMs: 60,
    maxDelayMs: 220
});

const motion = createRallarMotionBuffer({
    readInterpolationDelayMs: delay.currentDelayMs,
    maxExtrapolationMs: 150
});

rallar.realtime.onJson<PoseUpdate>('motion', (message) => {
    if (!isSameGroupRef(message.data.roomRef, room.roomRef)) {
        return;
    }
    delay.pushObservedAt(message.receivedAtEpochMs);
    motion.push({
        entityId: message.peerId,
        observedAtEpochMs: message.receivedAtEpochMs,
        position: message.data.position,
        velocity: message.data.velocity,
        seq: message.data.seq
    });
});
```

### Thresholded Pose Sending

Use the send gate when pose traffic should be capped by cadence and by
meaningful movement.

```ts
import { createRallarMotionSendGate } from '@shared/rallar-motion/mod.ts';

const poseGate = createRallarMotionSendGate({
    cadenceMs: 50,
    idleCadenceMs: 500,
    forceSendAfterMs: 2_000,
    minPositionDelta: 0.02,
    minRotationDelta: 0.01
});

const nextPose: PoseUpdate = {
    roomRef: room.roomRef,
    position: [1, 0, 0],
    velocity: [0.5, 0, 0],
    seq: 1
};

const decision = poseGate.check(nextPose, Date.now());
if (decision.shouldSend) {
    poseGate.recordSent(nextPose, Date.now());
    const motionSendResult = await motionUpdates.send(nextPose);
    if (motionSendResult.status !== 'sent') {
        console.warn(
            'Motion delivery degraded',
            motionSendResult.status,
            motionSendResult.reason
        );
    }
}
```

### Correction Blending

Use correction blending in a render loop when a remote estimate moves a small
distance away from the rendered object. Large jumps should snap.

```ts
import { createRallarMotionCorrectionBlender } from '@shared/rallar-motion/mod.ts';

const corrections = createRallarMotionCorrectionBlender({
    blendDurationMs: 100,
    snapPositionDelta: 4,
    rotationWrap: { period: Math.PI * 2 }
});

corrections.correct({
    current: renderedPose,
    target: estimate,
    nowEpochMs: performance.now()
});

const blended = corrections.sample(performance.now());
if (blended) {
    renderRemotePeer(peerId, blended.position, blended.rotation);
}
```

### Teleport-Safe Interpolation

Enable discontinuity handling for games with respawns, portals, dashes, or
anchor relocalization.

```ts
const motion = createRallarMotionBuffer({
    interpolationDelayMs: 100,
    discontinuity: {
        enabled: true,
        maxPositionDelta: 8,
        maxSpeed: 40
    }
});
```

## Wait For WebSocket

```ts
const ws = await rallar.ws.waitForOpen({ timeoutMs: 1000 });

if (ws.status !== 'open') {
    showOfflineBanner(ws.status);
}
```

## Browser Local Settings

```ts
type Settings = {
    volume: number;
    showHints: boolean;
};

const settings = await rallar.data.open<Settings>('settings', {
    scope: 'principal',
    durability: 'write-through'
});

await settings.set('ui', {
    volume: 0.8,
    showHints: true
});

const current = await settings.get('ui');
```

## Browser Drafts With Write-Behind

```ts
type Draft = {
    body: string;
    updatedAt: number;
};

const drafts = await rallar.data.open<Draft>('drafts', {
    scope: 'principal',
    durability: 'write-behind',
    hydrate: 'lazy',
    sync: true,
    ttlMs: 7 * 24 * 60 * 60 * 1000
});

await drafts.updateOrCreate('room:lobby', (current) => ({
    body: current?.body ?? '',
    updatedAt: Date.now()
}));

await drafts.whenIdle();
```

## Room CRDT Document

```ts
const doc = await rallar.crdt.open('room-checklist', {
    documentType: 'checklist',
    documentId: room.group.groupId,
    scope: {
        kind: 'room',
        roomRef: room.group
    },
    transport: 'ws-then-rtc'
});

doc.subscribe((snapshot) => {
    renderChecklist(snapshot.value);
});

await doc.applyLocal({
    kind: 'batch',
    operations: [
        {
            kind: 'orset.add',
            path: ['items'],
            elementId: crypto.randomUUID(),
            value: {
                text: 'Inspect north entrance',
                done: false
            }
        }
    ]
});

const health = doc.health();
console.log(health.pendingUpdateCount, health.lastServerAppendSequence);
```

## Media Calls

```ts
const stream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: true
});

await rallar.media.setLocalStream(stream);

rallar.media.onRemoteStream(({ peerId, stream }) => {
    attachRemoteVideo(peerId, stream);
});

await rallar.media.setAudioEnabled(false);
await rallar.media.stopLocal('all');
```

## Server Quickstart

```ts
const runtime = createRallarMiddleware({
    inbox: queueBox,
    outbox: queueBox,
    webSocketServer,
    wsRuntimeName: 'api-v1',
    findGroupSnapshotByRef: (ref) => groupSnapshotCache.findByRef(ref),
    inboundStores,
    outboundStores,
    createGroupStateInboxService,
    createTopologyInboxService,
    createRtcRttInboxService,
    createAppClientInboxService,
    createAppAuthInboxService,
    createAppAdminInboxService,
    createAppCrdtInboxService,
    resilience: {
        inbox: resilienceInbox,
        outbox: resilienceOutbox,
        appInbox: resilienceAppInbox,
        appOutbox: resilienceAppOutbox
    },
    clientsRepository,
    groupsRepository
});

const server = createRallarServerApplication({
    runtime,
    repositories,
    appDataRepository,
    nowEpochMs: Date.now,
    ws: {},
    systemInstallers,
    routeInstallers: {
        webSocket: installWsRoutes,
        rest: [installAuthRoutes, installStateRoutes]
    }
});

server.installSystemTopics();
server.installWebSocketLifecycle();
server.mountWebSocket(app);
server.mountRest(app);
server.start();
```

## Server Topic

```ts
server.ws.defineTopic<{ text: string; }>({
    topicId: 'room.chat',
    typeId: 'chat.message.v1',
    scope: 'room',
    validate: (message) =>
        typeof message.payload === 'object' &&
        message.payload !== null &&
        typeof (message.payload as { text?: unknown; }).text === 'string',
    fanout: 'outbox'
});
```
