# Rallar Quickstart And Recipes

This document gives short, copyable patterns for common Rallar usage.

## Browser Quickstart

```ts
import { rallar } from '@shared-web/browser/rallar.ts';

rallar.configure({ apiBaseUrl: 'http://localhost:8080' });
rallar.setDefaults({
    applicationId: 'game',
    workspaceId: 'default',
    room: { roomId: 'lobby' },
    realtime: { laneId: 'realtime', openTimeoutMs: 1000 },
});

await rallar.auth.login({ username: 'alice', password: 'secret' });

await rallar.start({
    restoreSession: true,
    connect: true,
    refreshRooms: true,
    refreshPeople: true,
});
```

## Subscription Scope

```ts
const subscriptions = rallar.subscriptions();

subscriptions.add(
    rallar.rooms.onChange((state) => {
        renderRooms(state.rooms);
    }),
);

subscriptions.add(
    rallar.people.onChange((state) => {
        renderPeople(state.people);
    }),
);

subscriptions.add(
    rallar.ws.onLifecycle((event) => {
        renderWsStatus(event.status);
    }),
);

// Component cleanup.
subscriptions.unsubscribe();
```

## Create And Join A Room

```ts
const room = await rallar.rooms.create({
    displayName: 'Lobby',
});

await rallar.rooms.join(room.group.groupId);

const current = rallar.rooms.current();
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
            'session-disconnected',
        ],
        limit: 100,
        maxPages: 3,
    },
    (event) => {
        applyRoomEvent(event);
    },
);

console.log(result.replayedCount, result.duplicateCount);
```

## WS Chat

```ts
type ChatMessage = {
    text: string;
    sentAt: number;
};

const chat = rallar.messages.channel<ChatMessage>({
    topicId: 'chat',
    typeId: 'message',
});

const unsubscribe = chat.onWs((payload, message) => {
    appendChatMessage(message.senderId, payload.text);
});

await chat.sendWs(
    { text: 'hello', sentAt: Date.now() },
    { scope: 'room', roomId: 'lobby' },
);
```

## Realtime Player Updates

```ts
type PlayerUpdate = {
    x: number;
    y: number;
    heading: number;
};

const playerUpdates = rallar.realtime.json<PlayerUpdate>({
    laneId: 'realtime',
    roomId: 'lobby',
    openTimeoutMs: 1000,
});

playerUpdates.on((message) => {
    updateRemotePlayer(message.peerId, message.data);
});

const readiness = await rallar.rtc.waitForRoomLane('lobby', 'realtime', {
    connect: true,
    timeoutMs: 1000,
});

if (readiness.status === 'open' || readiness.status === 'partial') {
    await playerUpdates.send({ x: 10, y: 20, heading: 90 });
} else {
    await rallar.messages.ws.send({
        topicId: 'player',
        typeId: 'update',
        payload: { x: 10, y: 20, heading: 90 },
        scope: 'room',
        roomId: 'lobby',
    });
}
```

## Rallar Motion Smoothing

Use a dedicated RTC lane for high-rate pose traffic, and configure it before
`connect()` or `start()`.

```ts
import { createRallarMotionBuffer } from '@shared/rallar-motion/mod.ts';
import { DEFAULT_REALTIME_DATA_CHANNEL_LANE } from '@shared-web/browser/middleware.ts';
import type { RtcDataChannelLaneConfig } from '@shared/services/WebRtcConnectionService.ts';

type PoseUpdate = {
    position: readonly [number, number, number];
    velocity?: readonly [number, number, number];
    seq: number;
};

const motionLane = {
    id: 'motion',
    label: 'rtc-motion',
    init: { ordered: false, maxRetransmits: 0 },
    flowControl: {
        overflow: 'replace-by-key',
        maxQueueItems: 8,
    },
} satisfies RtcDataChannelLaneConfig;

await rallar.start({
    connect: true,
    refreshRooms: true,
    dataChannelLanes: [DEFAULT_REALTIME_DATA_CHANNEL_LANE, motionLane],
});

const motion = createRallarMotionBuffer({
    interpolationDelayMs: 100,
    maxExtrapolationMs: 150,
});

rallar.realtime.onJson<PoseUpdate>('motion', (message) => {
    motion.push({
        entityId: message.peerId,
        observedAtEpochMs: message.receivedAtEpochMs,
        position: message.data.position,
        velocity: message.data.velocity,
        seq: message.data.seq,
        metadata: message.data,
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
    createRallarMotionBuffer,
} from '@shared/rallar-motion/mod.ts';

const delay = createRallarMotionAdaptiveDelay({
    minDelayMs: 60,
    maxDelayMs: 220,
});

const motion = createRallarMotionBuffer({
    readInterpolationDelayMs: delay.currentDelayMs,
    maxExtrapolationMs: 150,
});

rallar.realtime.onJson<PoseUpdate>('motion', (message) => {
    delay.pushObservedAt(message.receivedAtEpochMs);
    motion.push({
        entityId: message.peerId,
        observedAtEpochMs: message.receivedAtEpochMs,
        position: message.data.position,
        velocity: message.data.velocity,
        seq: message.data.seq,
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
    minRotationDelta: 0.01,
});

const decision = poseGate.check(nextPose, Date.now());
if (decision.shouldSend) {
    poseGate.recordSent(nextPose, Date.now());
    await motionLane.send(nextPose, { key: `pose:${sessionId}` });
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
    rotationWrap: { period: Math.PI * 2 },
});

corrections.correct({
    current: renderedPose,
    target: estimate,
    nowEpochMs: performance.now(),
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
        maxSpeed: 40,
    },
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
    durability: 'write-through',
});

await settings.set('ui', {
    volume: 0.8,
    showHints: true,
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
    ttlMs: 7 * 24 * 60 * 60 * 1000,
});

await drafts.updateOrCreate('room:lobby', (current) => ({
    body: current?.body ?? '',
    updatedAt: Date.now(),
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
        roomRef: room.group,
    },
    transport: 'ws-then-rtc',
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
                done: false,
            },
        },
    ],
});

const health = doc.health();
console.log(health.pendingUpdateCount, health.lastServerAppendSequence);
```

## Media Calls

```ts
const stream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: true,
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
    createAppGroupInboxService: ({ inboxQueueReader, wsQBoxServerService }) =>
        new AppGroupInboxService(
            inboxQueueReader,
            resourceInboxRepository,
            resourceInboxResultsRepository,
            groupStateService,
            createWsStateSyncPublisher(wsQBoxServerService, { serverId }),
            serverId,
        ),
    createAppClientInboxService: ({ inboxQueueReader, wsQBoxServerService }) =>
        new AppClientInboxService(
            inboxQueueReader,
            resourceInboxRepository,
            resourceInboxResultsRepository,
            clientStateService,
            createWsStateSyncPublisher(wsQBoxServerService, { serverId }),
            serverId,
        ),
    resilience: { inbox: resilienceInbox, outbox: resilienceOutbox },
    clientsRepository,
    groupsRepository,
});

const server = createRallarServerApplication({
    runtime,
    routes: {
        ws: installWsRoutes,
        rest: [installAuthRoutes, installStateRoutes],
    },
});

server.system.useDefaultMiddlewareTopics().useWebSocketLifecycle();

server.ws.mount(app);
server.rest.mount(app);
server.start();
```

## Server Topic

```ts
server.ws.defineTopic<{ text: string }>({
    topicId: 'chat',
    typeId: 'message',
    scope: 'room',
    validate: (message) =>
        typeof message.payload === 'object' &&
        message.payload !== null &&
        typeof (message.payload as { text?: unknown }).text === 'string',
    fanout: 'outbox',
});
```
